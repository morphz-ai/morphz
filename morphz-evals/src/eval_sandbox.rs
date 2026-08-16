use chrono::Utc;
use morphz::config::BackgroundTaskConfig;
use morphz::permission::{PermissionConfig, PermissionMode};
use morphz::tool::{ExecuteCommandTool, Tool};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use walkdir::WalkDir;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const FIXTURE_V1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/coding_eval_v1");
const FIXTURE_V2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/coding_eval_v2");
const FIXTURE_V3: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/coding_eval_v3");
const V2_HIDDEN_RETRY_TESTS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/coding_eval_v2_hidden/heldout_retry.rs"
));
const V3_HIDDEN_CACHE_TESTS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/coding_eval_v3_hidden/heldout_cache.rs"
));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodingEvalManifest {
    pub id: String,
    #[serde(default = "default_benchmark")]
    pub benchmark: String,
    pub created_at: String,
    #[serde(default)]
    pub context_id: String,
    #[serde(default)]
    pub session_id: String,
    pub workspace_root: PathBuf,
    pub database_path: PathBuf,
    pub artifact_dir: PathBuf,
    pub initial_sha256: BTreeMap<String, String>,
    pub allowed_modified_paths: Vec<String>,
    pub verify_command: String,
    #[serde(default = "default_tool_coverage_targets", alias = "required_tools")]
    pub tool_coverage_targets: Vec<String>,
    #[serde(default)]
    pub hidden_test_suite: Option<String>,
    /// External cognitive frames present before the evaluated user turn.
    /// This is evaluation metadata; the Agent still sees the frames only
    /// through the normal Context Encoding.
    #[serde(default)]
    pub injected_frame_ids: Vec<String>,
    pub user_prompt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingEvalEnvironment {
    pub run_root: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: CodingEvalManifest,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingEvalAudit {
    pub run_root: PathBuf,
    pub changed_paths: Vec<String>,
    pub created_paths: Vec<String>,
    pub deleted_paths: Vec<String>,
    pub violations: Vec<String>,
    pub clean_scope: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodingEvalScore {
    pub run_root: PathBuf,
    pub score: u32,
    pub correctness_points: u32,
    pub scope_and_constraint_points: u32,
    pub context_autonomy_points: u32,
    pub efficiency_points: u32,
    pub recovery_points: u32,
    pub attempts: usize,
    pub work_attempts: usize,
    pub context_attempts: usize,
    pub replies: usize,
    pub context_commits: usize,
    pub context_failures: usize,
    pub file_changes: usize,
    pub tools_used: Vec<String>,
    pub uncovered_tool_targets: Vec<String>,
    pub saw_initial_test_failure: bool,
    pub saw_final_test_success: bool,
    pub verifier_passed: Option<bool>,
    pub scope_audit: CodingEvalAudit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodingEvalVerification {
    pub benchmark: String,
    pub verified_at: String,
    pub command: String,
    pub hidden_test_suite: Option<String>,
    pub success: bool,
    pub output_sha256: String,
    pub output: String,
}

pub fn create_coding_eval_v1(base_dir: Option<&Path>) -> Result<CodingEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "coding-v1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let run_root = base.join(&id);
    let workspace_root = run_root.join("workspace");
    let artifact_dir = run_root.join("artifacts");
    std::fs::create_dir_all(&workspace_root)?;
    std::fs::create_dir_all(&artifact_dir)?;
    set_private_directory_permissions(&run_root)?;
    copy_fixture(Path::new(FIXTURE_V1), &workspace_root)?;

    let database_path = run_root.join("morphz.db");
    let context_id = format!("context-{id}");
    let session_id = format!("session-{id}");
    let manifest_path = run_root.join("manifest.json");
    let manifest = CodingEvalManifest {
        id,
        benchmark: "coding_eval_v1".to_string(),
        created_at: Utc::now().to_rfc3339(),
        context_id: context_id.clone(),
        session_id: session_id.clone(),
        workspace_root: workspace_root.clone(),
        database_path: database_path.clone(),
        artifact_dir: artifact_dir.clone(),
        initial_sha256: snapshot_workspace(&workspace_root)?,
        allowed_modified_paths: vec!["src/lib.rs".to_string()],
        verify_command: "cargo test".to_string(),
        tool_coverage_targets: default_tool_coverage_targets(),
        hidden_test_suite: None,
        injected_frame_ids: Vec::new(),
        user_prompt: "修复当前 Rust crate 中 parse_retry_after 无法接受首尾 HTTP 空白字符的缺陷。先运行测试复现失败，再定位和修改实现，最后运行完整测试。持续约束：只能修改 src/lib.rs；不得修改或删除测试与 Cargo.toml；不得使用 unsafe；根据任务需要自主选择 list_files/search/read/edit/exec 等工具；最终结论必须引用 file_change 与通过的测试输出，并把目标、约束和结论维护到 Mind。"
            .to_string(),
    };
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

    let environment = BTreeMap::from([
        ("MORPHZ_CONTEXT_ID".to_string(), context_id),
        ("MORPHZ_SESSION_ID".to_string(), session_id),
        (
            "MORPHZ_WORKSPACE_ROOT".to_string(),
            workspace_root.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_STORAGE_SQLITE_PATH".to_string(),
            database_path.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_ARTIFACT_DIR".to_string(),
            artifact_dir.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_PERMISSION_MODE".to_string(),
            "auto_review".to_string(),
        ),
        ("MORPHZ_EXEC_NETWORK".to_string(), "false".to_string()),
        ("MORPHZ_CODING_EVAL_MODE".to_string(), "true".to_string()),
    ]);
    Ok(CodingEvalEnvironment {
        run_root,
        manifest_path,
        manifest,
        environment,
    })
}

pub fn create_coding_eval_v2(base_dir: Option<&Path>) -> Result<CodingEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "coding-v2-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let run_root = base.join(&id);
    let workspace_root = run_root.join("workspace");
    let artifact_dir = run_root.join("artifacts");
    std::fs::create_dir_all(&workspace_root)?;
    std::fs::create_dir_all(&artifact_dir)?;
    set_private_directory_permissions(&run_root)?;
    copy_fixture(Path::new(FIXTURE_V2), &workspace_root)?;

    let database_path = run_root.join("morphz.db");
    let context_id = format!("context-{id}");
    let session_id = format!("session-{id}");
    let manifest_path = run_root.join("manifest.json");
    let manifest = CodingEvalManifest {
        id,
        benchmark: "coding_eval_v2".to_string(),
        created_at: Utc::now().to_rfc3339(),
        context_id: context_id.clone(),
        session_id: session_id.clone(),
        workspace_root: workspace_root.clone(),
        database_path: database_path.clone(),
        artifact_dir: artifact_dir.clone(),
        initial_sha256: snapshot_workspace(&workspace_root)?,
        allowed_modified_paths: vec![
            "src/retry.rs".to_string(),
            "src/store.rs".to_string(),
            "src/worker.rs".to_string(),
        ],
        verify_command: "cargo test --all-targets".to_string(),
        tool_coverage_targets: default_tool_coverage_targets(),
        hidden_test_suite: Some("coding_eval_v2_retry_state_machine".to_string()),
        injected_frame_ids: Vec::new(),
        user_prompt: "修复当前 Rust crate 中任务队列的重试状态机。临时失败任务的退避时间和最大尝试次数存在错误，已经取消的任务还可能被失败结果重新入队。先运行完整测试复现问题，追踪 claim、执行结果、retry 计算与持久化状态迁移，再完成最小修改并运行完整测试。持续约束：只允许修改 src/retry.rs、src/store.rs、src/worker.rs；不得修改或删除测试、Cargo.toml、公共 API 或其他文件；不得增加依赖、访问网络或使用 unsafe；根据任务需要自主选择工具；最终结论必须引用 file_change 与通过的测试证据，并把目标、已确认的不变量、关键判断和结论维护到 Mind。"
            .to_string(),
    };
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

    let environment = BTreeMap::from([
        ("MORPHZ_CONTEXT_ID".to_string(), context_id),
        ("MORPHZ_SESSION_ID".to_string(), session_id),
        (
            "MORPHZ_WORKSPACE_ROOT".to_string(),
            workspace_root.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_STORAGE_SQLITE_PATH".to_string(),
            database_path.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_ARTIFACT_DIR".to_string(),
            artifact_dir.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_PERMISSION_MODE".to_string(),
            "auto_review".to_string(),
        ),
        ("MORPHZ_EXEC_NETWORK".to_string(), "false".to_string()),
        ("MORPHZ_CODING_EVAL_MODE".to_string(), "true".to_string()),
    ]);
    Ok(CodingEvalEnvironment {
        run_root,
        manifest_path,
        manifest,
        environment,
    })
}

pub fn create_coding_eval_v3(base_dir: Option<&Path>) -> Result<CodingEvalEnvironment, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-evals"));
    std::fs::create_dir_all(&base)?;
    let base = std::fs::canonicalize(base)?;
    let id = format!(
        "coding-v3-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let run_root = base.join(&id);
    let workspace_root = run_root.join("workspace");
    let artifact_dir = run_root.join("artifacts");
    std::fs::create_dir_all(&workspace_root)?;
    std::fs::create_dir_all(&artifact_dir)?;
    set_private_directory_permissions(&run_root)?;
    copy_fixture(Path::new(FIXTURE_V3), &workspace_root)?;

    let database_path = run_root.join("morphz.db");
    let context_id = format!("context-{id}");
    let session_id = format!("session-{id}");
    let manifest_path = run_root.join("manifest.json");
    let manifest = CodingEvalManifest {
        id,
        benchmark: "coding_eval_v3".to_string(),
        created_at: Utc::now().to_rfc3339(),
        context_id: context_id.clone(),
        session_id: session_id.clone(),
        workspace_root: workspace_root.clone(),
        database_path: database_path.clone(),
        artifact_dir: artifact_dir.clone(),
        initial_sha256: snapshot_workspace(&workspace_root)?,
        allowed_modified_paths: vec![
            "src/cache.rs".to_string(),
            "src/service.rs".to_string(),
            "src/store.rs".to_string(),
        ],
        verify_command: "cargo test --all-targets".to_string(),
        tool_coverage_targets: default_tool_coverage_targets(),
        hidden_test_suite: Some("coding_eval_v3_cache_coherence".to_string()),
        injected_frame_ids: Vec::new(),
        user_prompt: "修复当前 Rust crate 的多租户策略缓存一致性缺陷。已接受的更新或删除不能继续返回旧值，同时失败的条件写入不能破坏仍然有效的热缓存。先运行完整测试复现问题，追踪 Service、Store 与 Cache 之间的状态边界，再完成最小修改并运行完整测试。持续约束：只允许修改 src/cache.rs、src/service.rs、src/store.rs；不得修改或删除测试、Cargo.toml、公共 API 或其他文件；不得增加依赖、访问网络或使用 unsafe；最终结论必须引用实际文件修改与测试证据。"
            .to_string(),
    };
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

    let environment = BTreeMap::from([
        ("MORPHZ_CONTEXT_ID".to_string(), context_id),
        ("MORPHZ_SESSION_ID".to_string(), session_id),
        (
            "MORPHZ_WORKSPACE_ROOT".to_string(),
            workspace_root.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_STORAGE_SQLITE_PATH".to_string(),
            database_path.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_ARTIFACT_DIR".to_string(),
            artifact_dir.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_PERMISSION_MODE".to_string(),
            "auto_review".to_string(),
        ),
        ("MORPHZ_EXEC_NETWORK".to_string(), "false".to_string()),
        ("MORPHZ_CODING_EVAL_MODE".to_string(), "true".to_string()),
    ]);
    Ok(CodingEvalEnvironment {
        run_root,
        manifest_path,
        manifest,
        environment,
    })
}

fn default_benchmark() -> String {
    "coding_eval_v1".to_string()
}

fn default_tool_coverage_targets() -> Vec<String> {
    ["list_files", "search", "read", "edit", "exec", "context_tx"]
        .into_iter()
        .map(ToOwned::to_owned)
        .collect()
}

pub async fn score_coding_eval(run_root: &Path) -> Result<CodingEvalScore, DynError> {
    use morphz::memory::sqlite::SqliteStore;
    use morphz::memory::{EventStore, QueryFilter};

    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: CodingEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let scope_audit = audit_coding_eval(&run_root)?;
    let store = SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?;
    let events = store
        .query(QueryFilter::default())
        .await?
        .into_iter()
        .filter(|event| {
            event
                .payload
                .get("context_id")
                .and_then(|value| value.as_str())
                .is_none_or(|context_id| context_id == manifest.context_id)
        })
        .collect::<Vec<_>>();

    let mut tools_used = BTreeSet::new();
    let mut work_attempts = 0;
    let mut context_attempts = 0;
    for event in events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
    {
        if let Some(calls) = event
            .payload
            .get("tool_calls")
            .and_then(|value| value.as_array())
        {
            let mut has_physical_tool = false;
            let mut has_context_tx = false;
            for call in calls {
                if let Some(name) = call
                    .get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(|value| value.as_str())
                {
                    tools_used.insert(name.to_string());
                    has_context_tx |= name == "context_tx";
                    has_physical_tool |= is_physical_tool_name(name);
                }
            }
            work_attempts += usize::from(has_physical_tool);
            context_attempts += usize::from(has_context_tx);
        }
    }
    let attempts = events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .count();
    let replies = events
        .iter()
        .filter(|event| event.topic == "chat/reply")
        .count();
    let commits = events
        .iter()
        .filter(|event| {
            event.topic == "chat/context_tx_committed" && !is_external_frame_seed(event)
        })
        .collect::<Vec<_>>();
    let context_failures = events
        .iter()
        .filter(|event| {
            event.topic == "chat/tool_output"
                && event
                    .payload
                    .get("tool_name")
                    .and_then(|value| value.as_str())
                    == Some("context_tx")
                && event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .is_some_and(|text| {
                        text.starts_with("执行失败:") || text.starts_with("执行拒绝:")
                    })
        })
        .count();
    let file_changes = events
        .iter()
        .filter(|event| event.topic == "chat/file_change")
        .count();
    let exec_outputs = events.iter().filter(|event| {
        event.topic == "chat/tool_output"
            && event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("exec")
    });
    let mut saw_initial_test_failure = false;
    let mut saw_final_test_success = false;
    let mut last_success_at = None;
    for event in exec_outputs {
        let text = event
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if exec_output_failed_tests(text) {
            saw_initial_test_failure = true;
        }
        if exec_output_successful_tests(text) {
            saw_final_test_success = true;
            last_success_at = Some(event.timestamp);
        }
    }
    let tools_used = tools_used.into_iter().collect::<Vec<_>>();
    let uncovered_tool_targets = manifest
        .tool_coverage_targets
        .iter()
        .filter(|required| !tools_used.contains(required))
        .cloned()
        .collect::<Vec<_>>();

    let verification = load_verification(&run_root)?;
    let verifier_passed = verification.as_ref().map(|report| report.success);
    let final_correctness = verifier_passed.unwrap_or(saw_final_test_success);
    let correctness_points = u32::from(final_correctness) * 25
        + u32::from(!scope_audit.changed_paths.is_empty()) * 10
        + u32::from(context_failures == 0) * 5;
    let scope_and_constraint_points = u32::from(scope_audit.clean_scope) * 20;
    let latest_commit = commits.last();
    let protected_mind = latest_commit
        .and_then(|event| event.payload.get("state_after"))
        .and_then(|state| state.get("protected"))
        .and_then(|value| value.as_array())
        .is_some_and(|protected| !protected.is_empty());
    let final_commit_after_test = last_success_at
        .is_some_and(|success| latest_commit.is_some_and(|commit| commit.timestamp > success));
    let latest_has_frames = latest_commit
        .and_then(|event| event.payload.get("state_after"))
        .and_then(|state| state.get("frames"))
        .and_then(|value| value.as_array())
        .is_some_and(|frames| !frames.is_empty());
    let context_autonomy_points = u32::from(commits.len() >= 2) * 8
        + u32::from(protected_mind) * 4
        + u32::from(final_commit_after_test) * 4
        + u32::from(latest_has_frames) * 4;
    let efficiency_points = u32::from(replies == 1) * 5
        + if work_attempts <= 6 {
            5
        } else if work_attempts <= 8 {
            3
        } else {
            0
        };
    let recovery_points = u32::from(saw_initial_test_failure && saw_final_test_success) * 10;
    let score = correctness_points
        + scope_and_constraint_points
        + context_autonomy_points
        + efficiency_points
        + recovery_points;
    Ok(CodingEvalScore {
        run_root,
        score,
        correctness_points,
        scope_and_constraint_points,
        context_autonomy_points,
        efficiency_points,
        recovery_points,
        attempts,
        work_attempts,
        context_attempts,
        replies,
        context_commits: commits.len(),
        context_failures,
        file_changes,
        tools_used,
        uncovered_tool_targets,
        saw_initial_test_failure,
        saw_final_test_success,
        verifier_passed,
        scope_audit,
    })
}

fn is_external_frame_seed(event: &morphz::event::Event) -> bool {
    event
        .payload
        .get("reason")
        .and_then(|value| value.as_str())
        .is_some_and(|reason| reason.starts_with("evaluator-external-frame:"))
}

fn is_physical_tool_name(name: &str) -> bool {
    !matches!(name, "context_tx" | "no_reply")
}

fn load_verification(run_root: &Path) -> Result<Option<CodingEvalVerification>, DynError> {
    let path = run_root.join("verification.json");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&std::fs::read(path)?)?))
}

pub fn prepare_verification_workspace(
    run_root: &Path,
    manifest: &CodingEvalManifest,
) -> Result<PathBuf, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let agent_workspace = std::fs::canonicalize(&manifest.workspace_root)?;
    if !agent_workspace.starts_with(&run_root) {
        return Err("manifest workspace_root 逃逸 run_root".into());
    }

    let verification_root = run_root.join("verifier").join(format!(
        "{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.6fZ"),
        std::process::id()
    ));
    let verification_workspace = verification_root.join("workspace");
    std::fs::create_dir_all(&verification_workspace)?;
    set_private_directory_permissions(&verification_root)?;
    copy_workspace_for_verification(&agent_workspace, &verification_workspace)?;
    inject_hidden_tests(
        manifest.hidden_test_suite.as_deref(),
        &verification_workspace,
    )?;
    Ok(verification_workspace)
}

pub fn record_verification(
    run_root: &Path,
    manifest: &CodingEvalManifest,
    success: bool,
    output: String,
) -> Result<CodingEvalVerification, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let report = CodingEvalVerification {
        benchmark: manifest.benchmark.clone(),
        verified_at: Utc::now().to_rfc3339(),
        command: manifest.verify_command.clone(),
        hidden_test_suite: manifest.hidden_test_suite.clone(),
        success,
        output_sha256: format!("{:x}", Sha256::digest(output.as_bytes())),
        output,
    };
    std::fs::write(
        run_root.join("verification.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

/// Run the manifest-owned verifier in a fresh copy that the Agent cannot
/// mutate or inspect. A failed verification is returned as data rather than
/// converted into an infrastructure error.
pub async fn verify_coding_eval(run_root: &Path) -> Result<CodingEvalVerification, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: CodingEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let verification_workspace = prepare_verification_workspace(&run_root, &manifest)?;
    let tool = coding_eval_tool(&manifest, &verification_workspace);
    let output = tool
        .execute(
            &serde_json::json!({
                "command": manifest.verify_command,
                "cwd": ".",
                "wait_ms": 120_000
            })
            .to_string(),
        )
        .await?;
    let success = exec_output_succeeded(&output);
    record_verification(&run_root, &manifest, success, output)
}

pub fn exec_output_succeeded(text: &str) -> bool {
    structured_exec_result(text)
        .and_then(|value| value.get("exit_code").and_then(|value| value.as_i64()))
        .map_or_else(|| text.contains("退出码: 0"), |exit_code| exit_code == 0)
}

pub(crate) fn exec_output_failed_tests(text: &str) -> bool {
    let structured_output = structured_exec_output(text);
    let output = structured_output.as_deref().unwrap_or(text);
    output.contains("test result: FAILED")
        || (!exec_output_succeeded(text) && output.to_lowercase().contains("test"))
}

pub(crate) fn exec_output_successful_tests(text: &str) -> bool {
    let structured_output = structured_exec_output(text);
    let output = structured_output.as_deref().unwrap_or(text);
    exec_output_succeeded(text) && output.contains("test result: ok")
}

fn structured_exec_result(text: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .filter(|value| value.get("kind").and_then(|value| value.as_str()) == Some("exec_result"))
}

fn structured_exec_output(text: &str) -> Option<String> {
    structured_exec_result(text)?
        .get("output")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

pub fn coding_eval_tool(
    manifest: &CodingEvalManifest,
    workspace_root: &Path,
) -> ExecuteCommandTool {
    let permissions = Arc::new(PermissionConfig {
        mode: PermissionMode::AutoReview,
        workspace_root: workspace_root.to_string_lossy().to_string(),
        read_roots: Vec::new(),
        write_roots: Vec::new(),
        network: false,
        ..Default::default()
    });
    let background = Arc::new(BackgroundTaskConfig {
        artifact_dir: manifest.artifact_dir.to_string_lossy().to_string(),
        ..Default::default()
    });
    ExecuteCommandTool::new_with_configs(
        Arc::new(morphz::event::InMemoryEventBus::new()),
        background,
        permissions,
        120,
    )
}

pub fn audit_coding_eval(run_root: &Path) -> Result<CodingEvalAudit, DynError> {
    let run_root = std::fs::canonicalize(run_root)?;
    let manifest_path = run_root.join("manifest.json");
    let manifest: CodingEvalManifest = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    let workspace = std::fs::canonicalize(&manifest.workspace_root)?;
    if !workspace.starts_with(&run_root) {
        return Err("manifest workspace_root 逃逸 run_root".into());
    }
    let current = snapshot_workspace(&workspace)?;
    let initial_paths = manifest
        .initial_sha256
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let current_paths = current.keys().cloned().collect::<BTreeSet<_>>();
    let changed_paths = initial_paths
        .intersection(&current_paths)
        .filter(|path| manifest.initial_sha256.get(*path) != current.get(*path))
        .cloned()
        .collect::<Vec<_>>();
    let created_paths = current_paths
        .difference(&initial_paths)
        .filter(|path| !is_ignored_runtime_path(path))
        .cloned()
        .collect::<Vec<_>>();
    let deleted_paths = initial_paths
        .difference(&current_paths)
        .cloned()
        .collect::<Vec<_>>();
    let allowed = manifest
        .allowed_modified_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut violations = changed_paths
        .iter()
        .filter(|path| !allowed.contains(*path))
        .map(|path| format!("修改了范围外文件: {path}"))
        .collect::<Vec<_>>();
    violations.extend(
        created_paths
            .iter()
            .map(|path| format!("创建了未授权文件: {path}")),
    );
    violations.extend(
        deleted_paths
            .iter()
            .map(|path| format!("删除了 fixture 文件: {path}")),
    );
    Ok(CodingEvalAudit {
        run_root,
        changed_paths,
        created_paths,
        deleted_paths,
        clean_scope: violations.is_empty(),
        violations,
    })
}

fn copy_fixture(source: &Path, target: &Path) -> Result<(), DynError> {
    let source = std::fs::canonicalize(source)?;
    for entry in WalkDir::new(&source).follow_links(false) {
        let entry = entry?;
        let relative = entry.path().strip_prefix(&source)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        if is_ignored_runtime_path(&relative_text) {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(format!("评测 fixture 禁止包含符号链接: {}", relative.display()).into());
        }
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(destination)?;
        } else if entry.file_type().is_file() {
            if entry.metadata()?.len() > 1024 * 1024 {
                return Err(
                    format!("评测 fixture 单文件超过 1 MiB: {}", relative.display()).into(),
                );
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn copy_workspace_for_verification(source: &Path, target: &Path) -> Result<(), DynError> {
    let source = std::fs::canonicalize(source)?;
    for entry in WalkDir::new(&source).follow_links(false) {
        let entry = entry?;
        let relative = entry.path().strip_prefix(&source)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        if is_ignored_runtime_path(&relative_text) {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(format!("Agent workspace 禁止包含符号链接: {}", relative.display()).into());
        }
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(destination)?;
        } else if entry.file_type().is_file() {
            if entry.metadata()?.len() > 1024 * 1024 {
                return Err(
                    format!("Agent workspace 单文件超过 1 MiB: {}", relative.display()).into(),
                );
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn inject_hidden_tests(suite: Option<&str>, workspace: &Path) -> Result<(), DynError> {
    let Some(suite) = suite else {
        return Ok(());
    };
    let (relative, contents) = match suite {
        "coding_eval_v2_retry_state_machine" => ("tests/heldout_retry.rs", V2_HIDDEN_RETRY_TESTS),
        "coding_eval_v3_cache_coherence" => ("tests/heldout_cache.rs", V3_HIDDEN_CACHE_TESTS),
        other => return Err(format!("未知 verifier-only test suite: {other}").into()),
    };
    let destination = workspace.join(relative);
    if destination.exists() {
        return Err(format!("隐藏测试目标已存在，拒绝覆盖: {relative}").into());
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(destination, contents)?;
    Ok(())
}

fn snapshot_workspace(root: &Path) -> Result<BTreeMap<String, String>, DynError> {
    let root = std::fs::canonicalize(root)?;
    let mut snapshot = BTreeMap::new();
    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&root)?
            .to_string_lossy()
            .replace('\\', "/");
        if is_ignored_runtime_path(&relative) {
            continue;
        }
        let bytes = std::fs::read(entry.path())?;
        snapshot.insert(relative, format!("{:x}", Sha256::digest(bytes)));
    }
    Ok(snapshot)
}

fn is_ignored_runtime_path(path: &str) -> bool {
    path == "target"
        || path.starts_with("target/")
        || path == ".morphz"
        || path.starts_with(".morphz/")
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), DynError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), DynError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use morphz::event::{
        Event, TYPE_AGENT_CALL, TYPE_CONTEXT_TRANSACTION, TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT,
    };
    use morphz::memory::sqlite::SqliteStore;
    use morphz::memory::EventStore;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn recognizes_structured_and_legacy_exec_results() {
        let structured_success = json!({
            "kind": "exec_result",
            "exit_code": 0,
            "output": "test result: ok. 11 passed"
        })
        .to_string();
        let structured_failure = json!({
            "kind": "exec_result",
            "exit_code": 101,
            "output": "test result: FAILED. 1 failed"
        })
        .to_string();

        assert!(exec_output_succeeded(&structured_success));
        assert!(exec_output_successful_tests(&structured_success));
        assert!(!exec_output_failed_tests(&structured_success));
        assert!(!exec_output_succeeded(&structured_failure));
        assert!(exec_output_failed_tests(&structured_failure));
        assert!(!exec_output_successful_tests(&structured_failure));

        assert!(exec_output_succeeded(
            "执行结束 [退出码: 0] test result: ok. 5 passed"
        ));
        assert!(exec_output_failed_tests(
            "执行结束 [退出码: 101] test result: FAILED"
        ));
    }

    #[test]
    fn creates_private_isolated_fixture_and_audits_scope() {
        let base = TempDir::new().unwrap();
        let environment = create_coding_eval_v1(Some(base.path())).unwrap();
        assert!(environment
            .manifest
            .workspace_root
            .starts_with(std::fs::canonicalize(base.path()).unwrap()));
        assert!(environment.manifest_path.exists());
        assert_eq!(
            environment.environment.get("MORPHZ_PERMISSION_MODE"),
            Some(&"auto_review".to_string())
        );
        assert_ne!(
            environment.manifest.context_id,
            environment.manifest.session_id
        );
        assert_eq!(
            environment.environment.get("MORPHZ_CONTEXT_ID"),
            Some(&environment.manifest.context_id)
        );
        assert!(environment
            .manifest
            .workspace_root
            .join("tests/retry_after.rs")
            .exists());

        std::fs::write(
            environment.manifest.workspace_root.join("src/lib.rs"),
            "changed",
        )
        .unwrap();
        let clean = audit_coding_eval(&environment.run_root).unwrap();
        assert!(clean.clean_scope);
        assert_eq!(clean.changed_paths, vec!["src/lib.rs"]);

        std::fs::write(
            environment.manifest.workspace_root.join("Cargo.toml"),
            "changed",
        )
        .unwrap();
        let violated = audit_coding_eval(&environment.run_root).unwrap();
        assert!(!violated.clean_scope);
        assert!(violated.violations[0].contains("Cargo.toml"));
    }

    #[tokio::test]
    async fn event_score_tracks_tool_coverage_without_penalizing_it() {
        let base = TempDir::new().unwrap();
        let environment = create_coding_eval_v1(Some(base.path())).unwrap();
        std::fs::write(
            environment.manifest.workspace_root.join("src/lib.rs"),
            "fixed",
        )
        .unwrap();
        let store = SqliteStore::new(
            environment
                .manifest
                .database_path
                .to_string_lossy()
                .as_ref(),
        )
        .await
        .unwrap();
        let session = "score-session";
        let payload = |extra: Vec<(&str, serde_json::Value)>| {
            let mut payload = serde_json::Map::new();
            payload.insert("session_id".to_string(), json!(session));
            for (key, value) in extra {
                payload.insert(key.to_string(), value);
            }
            payload
        };
        store
            .append(Event::new(
                "call-1".to_string(),
                "Agent".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                payload(vec![(
                    "tool_calls",
                    json!(["list_files", "read", "edit", "exec", "context_tx"]
                        .into_iter()
                        .map(|name| json!({"function": {"name": name}}))
                        .collect::<Vec<_>>()),
                )]),
            ))
            .await
            .unwrap();
        store
            .append(Event::new(
                "terminal-reply-call".to_string(),
                "Agent".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                payload(vec![(
                    "tool_calls",
                    json!([{"function": {"name": "no_reply"}}]),
                )]),
            ))
            .await
            .unwrap();
        for (id, text) in [
            ("exec-fail", "执行结束 [退出码: 101] test result: FAILED"),
            (
                "exec-pass",
                "执行结束 [退出码: 0] test result: ok. 5 passed",
            ),
        ] {
            store
                .append(Event::new(
                    id.to_string(),
                    "Executor".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    payload(vec![("tool_name", json!("exec")), ("text", json!(text))]),
                ))
                .await
                .unwrap();
        }
        store
            .append(Event::new(
                "change".to_string(),
                "CodingTools".to_string(),
                TYPE_FILE_CHANGE.to_string(),
                "chat/file_change".to_string(),
                payload(Vec::new()),
            ))
            .await
            .unwrap();
        for id in ["commit-1", "commit-2"] {
            store
                .append(Event::new(
                    id.to_string(),
                    "Context".to_string(),
                    TYPE_CONTEXT_TRANSACTION.to_string(),
                    "chat/context_tx_committed".to_string(),
                    payload(vec![(
                        "state_after",
                        json!({"protected": ["task"], "frames": [{"id": "task"}]}),
                    )]),
                ))
                .await
                .unwrap();
        }
        store
            .append(Event::new(
                "reply".to_string(),
                "Agent".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/reply".to_string(),
                payload(Vec::new()),
            ))
            .await
            .unwrap();

        let score = score_coding_eval(&environment.run_root).await.unwrap();
        assert_eq!(score.score, 100);
        assert_eq!(score.work_attempts, 1);
        assert_eq!(score.context_attempts, 1);
        assert_eq!(score.uncovered_tool_targets, vec!["search"]);
        assert!(score.scope_audit.clean_scope);
    }

    #[test]
    fn v2_hidden_tests_only_exist_in_verifier_copy() {
        let base = TempDir::new().unwrap();
        let environment = create_coding_eval_v2(Some(base.path())).unwrap();
        let agent_hidden = environment
            .manifest
            .workspace_root
            .join("tests/heldout_retry.rs");
        assert!(!agent_hidden.exists());

        let verifier =
            prepare_verification_workspace(&environment.run_root, &environment.manifest).unwrap();
        assert!(verifier.join("tests/heldout_retry.rs").exists());
        assert!(!agent_hidden.exists());
        assert!(
            audit_coding_eval(&environment.run_root)
                .unwrap()
                .clean_scope
        );
    }

    #[test]
    fn v3_hidden_tests_only_exist_in_verifier_copy() {
        let base = TempDir::new().unwrap();
        let environment = create_coding_eval_v3(Some(base.path())).unwrap();
        let agent_hidden = environment
            .manifest
            .workspace_root
            .join("tests/heldout_cache.rs");
        assert!(!agent_hidden.exists());

        let verifier =
            prepare_verification_workspace(&environment.run_root, &environment.manifest).unwrap();
        assert!(verifier.join("tests/heldout_cache.rs").exists());
        assert!(!agent_hidden.exists());
        assert!(
            audit_coding_eval(&environment.run_root)
                .unwrap()
                .clean_scope
        );
    }
}
