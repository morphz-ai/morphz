use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const FIXTURE_V1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/coding_eval_v1");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodingEvalManifest {
    pub id: String,
    pub created_at: String,
    pub workspace_root: PathBuf,
    pub database_path: PathBuf,
    pub artifact_dir: PathBuf,
    pub initial_sha256: BTreeMap<String, String>,
    pub allowed_modified_paths: Vec<String>,
    pub verify_command: String,
    #[serde(default = "default_required_tools")]
    pub required_tools: Vec<String>,
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
    pub replies: usize,
    pub context_commits: usize,
    pub context_failures: usize,
    pub file_changes: usize,
    pub tools_used: Vec<String>,
    pub missing_required_tools: Vec<String>,
    pub saw_initial_test_failure: bool,
    pub saw_final_test_success: bool,
    pub scope_audit: CodingEvalAudit,
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
    let manifest_path = run_root.join("manifest.json");
    let manifest = CodingEvalManifest {
        id,
        created_at: Utc::now().to_rfc3339(),
        workspace_root: workspace_root.clone(),
        database_path: database_path.clone(),
        artifact_dir: artifact_dir.clone(),
        initial_sha256: snapshot_workspace(&workspace_root)?,
        allowed_modified_paths: vec!["src/lib.rs".to_string()],
        verify_command: "cargo test".to_string(),
        required_tools: default_required_tools(),
        user_prompt: "修复当前 Rust crate 中 parse_retry_after 无法接受首尾 HTTP 空白字符的缺陷。先运行测试复现失败，再定位和修改实现，最后运行完整测试。持续约束：只能修改 src/lib.rs；不得修改或删除测试与 Cargo.toml；不得使用 unsafe；必须使用 list_files/search/read/edit 完成代码发现和修改，exec 仅用于 cargo test；最终结论必须引用 file_change 与通过的测试输出，并把目标、约束和结论维护到 Mind。"
            .to_string(),
    };
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

    let environment = BTreeMap::from([
        (
            "MORPHZ_WORKSPACE_ROOT".to_string(),
            workspace_root.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_DB_PATH".to_string(),
            database_path.to_string_lossy().to_string(),
        ),
        (
            "MORPHZ_ARTIFACT_DIR".to_string(),
            artifact_dir.to_string_lossy().to_string(),
        ),
        ("MORPHZ_EXEC_SEATBELT".to_string(), "true".to_string()),
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

fn default_required_tools() -> Vec<String> {
    ["list_files", "search", "read", "edit", "exec", "context_tx"]
        .into_iter()
        .map(ToOwned::to_owned)
        .collect()
}

pub async fn score_coding_eval(run_root: &Path) -> Result<CodingEvalScore, DynError> {
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{EventStore, QueryFilter};

    let run_root = std::fs::canonicalize(run_root)?;
    let manifest: CodingEvalManifest =
        serde_json::from_slice(&std::fs::read(run_root.join("manifest.json"))?)?;
    let scope_audit = audit_coding_eval(&run_root)?;
    let store = SqliteStore::new(manifest.database_path.to_string_lossy().as_ref()).await?;
    let events = store.query(QueryFilter::default()).await?;

    let mut tools_used = BTreeSet::new();
    for event in events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
    {
        if let Some(calls) = event
            .payload
            .get("tool_calls")
            .and_then(|value| value.as_array())
        {
            for call in calls {
                if let Some(name) = call
                    .get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(|value| value.as_str())
                {
                    tools_used.insert(name.to_string());
                }
            }
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
        .filter(|event| event.topic == "chat/context_tx_committed")
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
                    .is_some_and(|text| text.starts_with("执行失败:"))
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
        if text.contains("退出码: 101") || text.contains("test result: FAILED") {
            saw_initial_test_failure = true;
        }
        if text.contains("退出码: 0") && text.contains("3 passed") {
            saw_final_test_success = true;
            last_success_at = Some(event.timestamp);
        }
    }
    let tools_used = tools_used.into_iter().collect::<Vec<_>>();
    let missing_required_tools = manifest
        .required_tools
        .iter()
        .filter(|required| !tools_used.contains(required))
        .cloned()
        .collect::<Vec<_>>();

    let correctness_points = u32::from(saw_final_test_success) * 25
        + u32::from(file_changes == 1) * 10
        + u32::from(context_failures == 0) * 5;
    let required_points = u32::from(missing_required_tools.is_empty()) * 5;
    let scope_and_constraint_points = u32::from(scope_audit.clean_scope) * 15 + required_points;
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
        + if attempts <= 6 {
            5
        } else if attempts <= 8 {
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
        replies,
        context_commits: commits.len(),
        context_failures,
        file_changes,
        tools_used,
        missing_required_tools,
        saw_initial_test_failure,
        saw_final_test_success,
        scope_audit,
    })
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
    use crate::event::{
        Event, TYPE_AGENT_CALL, TYPE_CONTEXT_TRANSACTION, TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT,
    };
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::EventStore;
    use serde_json::json;
    use tempfile::TempDir;

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
            environment.environment.get("MORPHZ_EXEC_SEATBELT"),
            Some(&"true".to_string())
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
    async fn ledger_score_penalizes_missing_required_tool() {
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
        for (id, text) in [
            ("exec-fail", "执行结束 [退出码: 101] test result: FAILED"),
            (
                "exec-pass",
                "执行结束 [退出码: 0] test result: ok. 3 passed",
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
        assert_eq!(score.score, 95);
        assert_eq!(score.missing_required_tools, vec!["search"]);
        assert!(score.scope_audit.clean_scope);
    }
}
