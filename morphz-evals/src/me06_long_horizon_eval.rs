use chrono::Utc;
use morphz::config::OrchestratorConfig;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::EventStore;
use morphz::orchestrator::context::ContextEngine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const ME06_PROTOCOL_ID: &str = "me06-long-horizon-compaction-p1.1-frozen";
pub const ME06_EVENT_COUNT: usize = 120;
pub const ME06_CHECKPOINT_COUNT: usize = 12;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Me06Arm {
    ControlledCompaction,
    FullMorphz,
}

impl Me06Arm {
    pub const ALL: [Self; 2] = [Self::ControlledCompaction, Self::FullMorphz];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ControlledCompaction => "controlled_compaction",
            Self::FullMorphz => "full_morphz",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Me06EventClass {
    Stable,
    Revision,
    Noise,
    Control,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Me06Authority {
    ApprovedCurrent,
    ApprovedHistorical,
    UnapprovedDraft,
    Archived,
    RuntimeControl,
    EphemeralProcess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06Event {
    pub id: String,
    pub sequence: usize,
    pub stage: usize,
    pub context_key: String,
    pub session_key: String,
    pub source_id: String,
    pub authority: Me06Authority,
    pub class: Me06EventClass,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supersedes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06Action {
    pub name: String,
    pub target: String,
    pub evidence_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06VisibleFixture {
    pub protocol_id: String,
    pub fixture_id: String,
    pub event_count: usize,
    pub checkpoint_count: usize,
    pub events: Vec<Me06Event>,
    pub checkpoint_prompts: Vec<String>,
    pub final_action_contract: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06HiddenFixture {
    pub protocol_id: String,
    pub fixture_id: String,
    pub expected_state: BTreeMap<String, String>,
    pub expected_action: Me06Action,
    pub forbidden_primary_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06FixturePair {
    pub visible: Me06VisibleFixture,
    pub hidden: Me06HiddenFixture,
    pub visible_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Me06ArchitectureEvidence {
    pub cross_session_continuity: Option<bool>,
    pub restart_recovery: Option<bool>,
    pub context_isolation: Option<bool>,
    pub concurrent_disjoint_updates_preserved: Option<bool>,
    pub concurrent_conflict_detected: Option<bool>,
    pub silent_lost_updates: Option<usize>,
    pub causal_audit_complete: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06ObservedEpisode {
    pub protocol_id: String,
    pub fixture_id: String,
    pub arm: Me06Arm,
    pub visible_sha256: String,
    pub observed_state: BTreeMap<String, String>,
    pub observed_action: Option<Me06Action>,
    pub forbidden_values_observed: Vec<String>,
    pub protocol_shape_valid: bool,
    pub raw_output: String,
    pub architecture: Me06ArchitectureEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Me06Score {
    pub protocol_id: String,
    pub fixture_id: String,
    pub arm: Me06Arm,
    pub visible_hash_matches: bool,
    pub state_field_results: BTreeMap<String, bool>,
    pub state_fields_correct: usize,
    pub state_fields_total: usize,
    pub final_state_field_accuracy: f64,
    pub unique_final_action_success: bool,
    pub context_isolation_success: bool,
    pub semantic_success: bool,
    pub protocol_shape_valid: bool,
    pub architecture: Me06ArchitectureEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06ScorerCase {
    pub id: String,
    pub expected_semantic_success: bool,
    pub expected_protocol_shape_valid: bool,
    pub observed_semantic_success: bool,
    pub observed_protocol_shape_valid: bool,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06ScorerGate {
    pub cases: Vec<Me06ScorerCase>,
    pub semantic_format_separation_proven: bool,
    pub all_passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ControlledCompactionState {
    revision: u64,
    durable_state: BTreeMap<String, String>,
    source_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlledCompactionGate {
    pub state_path: PathBuf,
    pub initial_revision: u64,
    pub final_revision: u64,
    pub stale_write_rejected: bool,
    pub retry_preserved_both_updates: bool,
    pub restart_recovered_state: bool,
    pub cross_session_shared_state: bool,
    pub foreign_context_isolated: bool,
    pub recall_contract_match_count: usize,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MorphzContextGate {
    pub database_path: PathBuf,
    pub initial_version: u64,
    pub final_version: u64,
    pub disjoint_auto_rebase_succeeded: bool,
    pub conflicting_update_rejected: bool,
    pub restart_recovered_frames: bool,
    pub cross_session_projection_succeeded: bool,
    pub foreign_context_isolated: bool,
    pub primary_context_sha256: String,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06ArmCallPlan {
    pub arm: Me06Arm,
    pub business_checkpoints: usize,
    pub expected_physical_model_calls_per_fixture: usize,
    pub hard_call_acceptance_limit_per_fixture: usize,
    pub maintenance_or_internal_calls_observable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06Planner {
    pub event_count_per_fixture: usize,
    pub checkpoint_count_per_fixture: usize,
    pub fixture_count: usize,
    pub normalized_visible_bytes: usize,
    pub arm_plans: Vec<Me06ArmCallPlan>,
    pub expected_smoke_calls: usize,
    pub expected_three_fixture_calls: usize,
    pub hard_three_fixture_call_limit: usize,
    pub exact_tokenizer_pending: bool,
    pub token_accounting_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06NoModelGateSummary {
    pub protocol_id: String,
    pub created_at: String,
    pub output_root: PathBuf,
    pub fixture_count: usize,
    pub events_per_fixture: usize,
    pub fixture_hashes_unique: bool,
    pub scorer_gate: Me06ScorerGate,
    pub controlled_compaction_gate: ControlledCompactionGate,
    pub morphz_context_gate: MorphzContextGate,
    pub planner: Me06Planner,
    pub phase_a_passed: bool,
    pub real_model_called: bool,
    pub ready_for_real_model_smoke: bool,
    pub remaining_gates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06FakeAdapterRun {
    pub arm: Me06Arm,
    pub fixture_id: String,
    pub trace_path: PathBuf,
    pub checkpoint_calls: usize,
    pub maintenance_calls: usize,
    pub semantic_success: bool,
    pub protocol_shape_valid: bool,
    pub replay_score_identical: bool,
    pub include_in_paper_statistics: bool,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me06FakeAdapterGateSummary {
    pub protocol_id: String,
    pub created_at: String,
    pub output_root: PathBuf,
    pub fixture_count: usize,
    pub runs: Vec<Me06FakeAdapterRun>,
    pub all_contracts_passed: bool,
    pub raw_artifact_replay_passed: bool,
    pub real_model_called: bool,
    pub include_in_paper_statistics: bool,
    pub ready_for_real_model_smoke: bool,
    pub remaining_gates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Me06FakeTraceRecord {
    sequence: usize,
    arm: Me06Arm,
    fixture_id: String,
    stage: usize,
    kind: String,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Me06FakeModelOutput {
    observed_state: BTreeMap<String, String>,
    observed_action: Option<Me06Action>,
    protocol_shape_valid: bool,
}

#[derive(Debug, Clone)]
struct FixtureVariant {
    fixture_id: &'static str,
    project: &'static str,
    initial_port: &'static str,
    current_port: &'static str,
    initial_endpoint: &'static str,
    current_endpoint: &'static str,
    initial_retention: &'static str,
    current_retention: &'static str,
    timezone: &'static str,
    foreign_value: &'static str,
    action_target: &'static str,
}

pub fn generate_me06_fixtures() -> Result<Vec<Me06FixturePair>, DynError> {
    let variants = [
        FixtureVariant {
            fixture_id: "me06-p1-orbit-01",
            project: "ORBIT-42",
            initial_port: "8080",
            current_port: "9443",
            initial_endpoint: "/v1/events",
            current_endpoint: "/v3/events",
            initial_retention: "30",
            current_retention: "45",
            timezone: "Asia/Shanghai",
            foreign_value: "FOREIGN-PORT-7711",
            action_target: "orbit-production",
        },
        FixtureVariant {
            fixture_id: "me06-p1-helios-02",
            project: "HELIOS-9",
            initial_port: "7001",
            current_port: "9090",
            initial_endpoint: "/v1/ingest",
            current_endpoint: "/v2/events",
            initial_retention: "14",
            current_retention: "60",
            timezone: "Europe/Berlin",
            foreign_value: "FOREIGN-ENDPOINT-/red/ingest",
            action_target: "helios-primary",
        },
        FixtureVariant {
            fixture_id: "me06-p1-vector-03",
            project: "VECTOR-17",
            initial_port: "6100",
            current_port: "7443",
            initial_endpoint: "/legacy/submit",
            current_endpoint: "/api/v4/submit",
            initial_retention: "21",
            current_retention: "90",
            timezone: "America/Toronto",
            foreign_value: "FOREIGN-PROJECT-SCARLET-3",
            action_target: "vector-release",
        },
    ];
    variants.iter().map(build_fixture).collect()
}

fn build_fixture(variant: &FixtureVariant) -> Result<Me06FixturePair, DynError> {
    let mut pending = Vec::<(
        usize,
        String,
        String,
        String,
        Me06Authority,
        Me06EventClass,
        String,
        Vec<String>,
    )>::new();
    let mut push = |stage: usize,
                    context: &str,
                    session: &str,
                    source: &str,
                    authority: Me06Authority,
                    class: Me06EventClass,
                    content: String,
                    supersedes: Vec<String>| {
        pending.push((
            stage,
            context.to_string(),
            session.to_string(),
            source.to_string(),
            authority,
            class,
            content,
            supersedes,
        ));
    };

    let initial_facts = [
        format!("项目永久代号为 {}。", variant.project),
        "持续安全约束为 NEVER-LOG-SECRETS。".to_string(),
        "本地持久化方案为 SQLite WAL。".to_string(),
        format!("初始服务端口为 {}。", variant.initial_port),
        format!("初始事件入口为 {}。", variant.initial_endpoint),
        format!("初始审计保留期为 {} 天。", variant.initial_retention),
        "初始默认时区为 UTC。".to_string(),
        format!("正式行动目标属于 {}。", variant.action_target),
        "当前长期目标是保持发布状态连续且可审计。".to_string(),
        "证据优先级为 approved-current 高于 draft、rumor 和 archive。".to_string(),
        "仅显式批准且声明取代关系的证据可以改变当前状态。".to_string(),
        "报告必须区分当前结论、已作废方案和未知事项。".to_string(),
        "最终行动名称固定为 activate_release。".to_string(),
        "最终行动必须引用实际批准证据。".to_string(),
        "同一 Context 的不同 Session 可以继续同一长期事项。".to_string(),
        "其他 Context 的同名对象不能进入本 Context。".to_string(),
        "并发提交不得静默丢失已接受更新。".to_string(),
        "所有原始事件在退出活动输入后仍保持可召回。".to_string(),
    ];
    for (index, content) in initial_facts.into_iter().enumerate() {
        push(
            1,
            "primary",
            "session-a",
            &format!("stable-source-{index:02}"),
            Me06Authority::ApprovedHistorical,
            Me06EventClass::Stable,
            content,
            Vec::new(),
        );
    }

    for index in 0..36 {
        push(
            2,
            "primary",
            "session-a",
            &format!("process-a-{index:02}"),
            Me06Authority::EphemeralProcess,
            Me06EventClass::Noise,
            format!(
                "过程记录 A-{index:02}：一次性采样、临时路径 /tmp/run-a-{index:02} 和诊断计时已经完成；它没有改变项目、端口、入口、保留期、时区、安全约束或行动目标。"
            ),
            Vec::new(),
        );
    }

    let approved_updates = [
        (
            "approved-port",
            format!("已批准当前服务端口为 {}。", variant.current_port),
            "stable-source-03",
        ),
        (
            "approved-endpoint",
            format!("已批准当前事件入口为 {}。", variant.current_endpoint),
            "stable-source-04",
        ),
        (
            "approved-retention",
            format!("已批准当前审计保留期为 {} 天。", variant.current_retention),
            "stable-source-05",
        ),
        (
            "approved-timezone",
            format!("已批准默认时区为 {}。", variant.timezone),
            "stable-source-06",
        ),
        (
            "approved-target",
            format!("已批准最终行动目标为 {}。", variant.action_target),
            "stable-source-07",
        ),
        (
            "approved-release",
            "发布委员会批准在最终阶段执行 activate_release。".to_string(),
            "stable-source-12",
        ),
    ];
    for (source, content, superseded) in approved_updates {
        push(
            3,
            "primary",
            "session-a",
            source,
            Me06Authority::ApprovedCurrent,
            Me06EventClass::Revision,
            content,
            vec![superseded.to_string()],
        );
    }

    let stale_values = [
        variant.initial_port,
        variant.initial_endpoint,
        variant.initial_retention,
        "UTC",
        "staging-only",
        "cancel_release",
    ];
    for (index, value) in stale_values.into_iter().enumerate() {
        push(
            4,
            "primary",
            "session-a",
            &format!("late-archive-{index:02}"),
            if index % 2 == 0 {
                Me06Authority::Archived
            } else {
                Me06Authority::UnapprovedDraft
            },
            Me06EventClass::Revision,
            format!(
                "晚到材料 {index:02} 提到候选值 {value}，但明确标记为未批准或已归档，不得取代当前批准状态。"
            ),
            Vec::new(),
        );
    }

    for index in 0..2 {
        push(
            5,
            "primary",
            "session-b",
            &format!("session-b-control-{index:02}"),
            Me06Authority::RuntimeControl,
            Me06EventClass::Control,
            format!("Session B 连续性检查 {index:02}：继续同一 Context，不重新复制历史摘要。"),
            Vec::new(),
        );
    }

    for index in 0..6 {
        push(
            6,
            "primary",
            "session-b",
            &format!("transfer-case-{index:02}"),
            Me06Authority::ApprovedCurrent,
            Me06EventClass::Revision,
            format!(
                "已完成案例 {index:02} 证明：证据的权威性、批准状态和明确取代关系优先于单纯到达顺序；较新的已批准证据仍可以合法取代旧结论。"
            ),
            Vec::new(),
        );
    }

    for index in 0..36 {
        push(
            7,
            "primary",
            "session-b",
            &format!("process-b-{index:02}"),
            Me06Authority::EphemeralProcess,
            Me06EventClass::Noise,
            format!(
                "过程记录 B-{index:02}：实验候选 EXP-{index:02} 已结束，详细采样、临时日志和中间输出没有改变任何长期状态，原始证据仅供审计召回。"
            ),
            Vec::new(),
        );
    }

    for index in 0..3 {
        push(
            8,
            "primary",
            if index % 2 == 0 {
                "session-a"
            } else {
                "session-b"
            },
            &format!("concurrent-disjoint-{index:02}"),
            Me06Authority::RuntimeControl,
            Me06EventClass::Control,
            format!(
                "并发非冲突控制 {index:02}：来自同一基础版本、修改不同对象的合法更新都必须保留。"
            ),
            Vec::new(),
        );
    }

    for index in 0..3 {
        push(
            9,
            "primary",
            if index % 2 == 0 {
                "session-a"
            } else {
                "session-b"
            },
            &format!("concurrent-conflict-{index:02}"),
            Me06Authority::RuntimeControl,
            Me06EventClass::Control,
            format!(
                "并发冲突控制 {index:02}：同一对象的冲突更新必须被发现，并按已批准来源重新求值，禁止静默覆盖。"
            ),
            Vec::new(),
        );
    }

    push(
        10,
        "primary",
        "session-b",
        "restart-control-00",
        Me06Authority::RuntimeControl,
        Me06EventClass::Control,
        "关闭并重新启动进程；只能从持久状态恢复，不能把上一阶段状态复制进新 prompt。".to_string(),
        Vec::new(),
    );
    push(
        11,
        "foreign",
        "session-foreign",
        "foreign-context-00",
        Me06Authority::ApprovedCurrent,
        Me06EventClass::Control,
        format!("相邻 Context 的私有当前值为 {}。", variant.foreign_value),
        Vec::new(),
    );
    push(
        11,
        "primary",
        "session-b",
        "isolation-probe-00",
        Me06Authority::RuntimeControl,
        Me06EventClass::Control,
        "最终行动只能使用 primary Context，不得继承相邻 Context 的同名对象。".to_string(),
        Vec::new(),
    );
    push(
        12,
        "primary",
        "session-b",
        "final-action-request-00",
        Me06Authority::RuntimeControl,
        Me06EventClass::Control,
        "根据当前批准状态执行唯一最终行动，并报告项目、端口、入口、保留期、时区、存储和安全约束。"
            .to_string(),
        Vec::new(),
    );

    if pending.len() != ME06_EVENT_COUNT {
        return Err(format!(
            "{} generated {} events instead of {}",
            variant.fixture_id,
            pending.len(),
            ME06_EVENT_COUNT
        )
        .into());
    }
    let events = pending
        .into_iter()
        .enumerate()
        .map(
            |(index, (stage, context, session, source, authority, class, content, supersedes))| {
                Me06Event {
                    id: format!("{}-e{:03}", variant.fixture_id, index + 1),
                    sequence: index + 1,
                    stage,
                    context_key: context,
                    session_key: session,
                    source_id: source,
                    authority,
                    class,
                    content,
                    supersedes,
                }
            },
        )
        .collect::<Vec<_>>();
    validate_event_shape(variant.fixture_id, &events)?;

    let checkpoint_prompts = (1..=ME06_CHECKPOINT_COUNT)
        .map(checkpoint_prompt)
        .collect::<Vec<_>>();
    let visible = Me06VisibleFixture {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        fixture_id: variant.fixture_id.to_string(),
        event_count: events.len(),
        checkpoint_count: ME06_CHECKPOINT_COUNT,
        events,
        checkpoint_prompts,
        final_action_contract: vec![
            "name".to_string(),
            "target".to_string(),
            "evidence_id".to_string(),
        ],
    };
    let hidden = Me06HiddenFixture {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        fixture_id: variant.fixture_id.to_string(),
        expected_state: BTreeMap::from([
            ("project".to_string(), variant.project.to_string()),
            ("current_port".to_string(), variant.current_port.to_string()),
            (
                "current_endpoint".to_string(),
                variant.current_endpoint.to_string(),
            ),
            (
                "retention_days".to_string(),
                variant.current_retention.to_string(),
            ),
            ("timezone".to_string(), variant.timezone.to_string()),
            ("storage".to_string(), "SQLite WAL".to_string()),
            ("security_rule".to_string(), "NEVER-LOG-SECRETS".to_string()),
            (
                "decision_rule".to_string(),
                "AUTHORITY-BEFORE-RECENCY".to_string(),
            ),
        ]),
        expected_action: Me06Action {
            name: "activate_release".to_string(),
            target: variant.action_target.to_string(),
            evidence_id: "approved-release".to_string(),
        },
        forbidden_primary_values: vec![variant.foreign_value.to_string()],
    };
    let visible_sha256 = sha256(&serde_json::to_vec(&visible)?);
    Ok(Me06FixturePair {
        visible,
        hidden,
        visible_sha256,
    })
}

fn checkpoint_prompt(stage: usize) -> String {
    match stage {
        1 => "建立当前长期状态；保留完成后续任务必需的目标、约束和来源。",
        2 => "吸收本阶段事件并继续；已完成的过程记录不应被误当成长期事实。",
        3 => "根据已批准证据修订当前状态，并保留明确取代关系。",
        4 => "处理晚到冲突；不得仅因到达时间更晚就覆盖已批准状态。",
        5 => "从 Session B 继续同一事项，报告当前状态来源。",
        6 => "从多个已完成案例提炼有适用边界的可复用判断规则。",
        7 => "继续长期任务，在需要时维护活动状态，但不得丢失长期约束。",
        8 => "处理两个 Session 的非冲突并发更新，确认两者都被保留。",
        9 => "处理同一对象的并发冲突，重新读取后按权威证据求值。",
        10 => "进程重启后只依赖持久状态恢复，并报告当前关键状态。",
        11 => "验证 Context 隔离；不得使用相邻 Context 的私有值。",
        12 => "执行唯一最终行动并提交当前状态报告。",
        _ => unreachable!("ME-06 checkpoint is outside 1..=12"),
    }
    .to_string()
}

fn validate_event_shape(fixture_id: &str, events: &[Me06Event]) -> Result<(), DynError> {
    let mut class_counts = BTreeMap::<Me06EventClass, usize>::new();
    let mut stages = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for event in events {
        *class_counts.entry(event.class).or_default() += 1;
        stages.insert(event.stage);
        if !ids.insert(event.id.clone()) {
            return Err(format!("{fixture_id} contains duplicate event id {}", event.id).into());
        }
    }
    let expected = BTreeMap::from([
        (Me06EventClass::Stable, 18),
        (Me06EventClass::Revision, 18),
        (Me06EventClass::Noise, 72),
        (Me06EventClass::Control, 12),
    ]);
    if class_counts != expected {
        return Err(format!("{fixture_id} event class counts are {class_counts:?}").into());
    }
    if stages != (1..=ME06_CHECKPOINT_COUNT).collect::<BTreeSet<_>>() {
        return Err(format!("{fixture_id} does not cover all 12 checkpoints").into());
    }
    Ok(())
}

pub fn score_me06_episode(observed: &Me06ObservedEpisode, fixture: &Me06FixturePair) -> Me06Score {
    let state_field_results = fixture
        .hidden
        .expected_state
        .iter()
        .map(|(field, expected)| {
            (
                field.clone(),
                observed.observed_state.get(field) == Some(expected),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let state_fields_correct = state_field_results
        .values()
        .filter(|passed| **passed)
        .count();
    let state_fields_total = state_field_results.len();
    let unique_final_action_success =
        observed.observed_action.as_ref() == Some(&fixture.hidden.expected_action);
    let context_isolation_success = observed.forbidden_values_observed.is_empty()
        && fixture
            .hidden
            .forbidden_primary_values
            .iter()
            .all(|value| !observed.raw_output.contains(value));
    let visible_hash_matches = observed.visible_sha256 == fixture.visible_sha256;
    let semantic_success = visible_hash_matches
        && state_fields_correct == state_fields_total
        && unique_final_action_success
        && context_isolation_success;
    Me06Score {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        fixture_id: observed.fixture_id.clone(),
        arm: observed.arm,
        visible_hash_matches,
        state_field_results,
        state_fields_correct,
        state_fields_total,
        final_state_field_accuracy: if state_fields_total == 0 {
            0.0
        } else {
            state_fields_correct as f64 / state_fields_total as f64
        },
        unique_final_action_success,
        context_isolation_success,
        semantic_success,
        protocol_shape_valid: observed.protocol_shape_valid,
        architecture: observed.architecture.clone(),
    }
}

fn run_scorer_gate(fixture: &Me06FixturePair) -> Me06ScorerGate {
    let correct = Me06ObservedEpisode {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.fixture_id.clone(),
        arm: Me06Arm::FullMorphz,
        visible_sha256: fixture.visible_sha256.clone(),
        observed_state: fixture.hidden.expected_state.clone(),
        observed_action: Some(fixture.hidden.expected_action.clone()),
        forbidden_values_observed: Vec::new(),
        protocol_shape_valid: true,
        raw_output: "semantically correct output".to_string(),
        architecture: Me06ArchitectureEvidence::default(),
    };
    let mut cases = Vec::new();
    let mut add_case =
        |id: &str, observed: Me06ObservedEpisode, expected_semantic: bool, expected_shape: bool| {
            let score = score_me06_episode(&observed, fixture);
            cases.push(Me06ScorerCase {
                id: id.to_string(),
                expected_semantic_success: expected_semantic,
                expected_protocol_shape_valid: expected_shape,
                observed_semantic_success: score.semantic_success,
                observed_protocol_shape_valid: score.protocol_shape_valid,
                passed: score.semantic_success == expected_semantic
                    && score.protocol_shape_valid == expected_shape,
            });
        };
    add_case("positive", correct.clone(), true, true);
    let mut format_only = correct.clone();
    format_only.protocol_shape_valid = false;
    format_only.raw_output =
        "basis was a string instead of an array; semantic state and action remain correct"
            .to_string();
    add_case("format_only_failure", format_only, true, false);
    let mut stale = correct.clone();
    stale.observed_state.insert(
        "current_port".to_string(),
        fixture
            .visible
            .events
            .iter()
            .find(|event| event.source_id == "stable-source-03")
            .map(|event| event.content.clone())
            .unwrap_or_else(|| "stale".to_string()),
    );
    add_case("stale_state", stale, false, true);
    let mut pollution = correct.clone();
    pollution.forbidden_values_observed = fixture.hidden.forbidden_primary_values.clone();
    pollution.raw_output = fixture.hidden.forbidden_primary_values.join(" ");
    add_case("foreign_context_pollution", pollution, false, true);
    let mut missing = correct;
    missing.observed_state.remove("security_rule");
    missing.observed_action = None;
    add_case("missing_state_and_action", missing, false, true);
    let semantic_format_separation_proven = cases.iter().any(|case| {
        case.id == "format_only_failure"
            && case.observed_semantic_success
            && !case.observed_protocol_shape_valid
    });
    let all_passed = semantic_format_separation_proven && cases.iter().all(|case| case.passed);
    Me06ScorerGate {
        cases,
        semantic_format_separation_proven,
        all_passed,
    }
}

fn initialize_compaction_state(path: &Path) -> Result<ControlledCompactionState, DynError> {
    let state = ControlledCompactionState {
        revision: 0,
        durable_state: BTreeMap::new(),
        source_ids: BTreeSet::new(),
    };
    write_json(path, &state)?;
    Ok(state)
}

fn load_compaction_state(path: &Path) -> Result<ControlledCompactionState, DynError> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn commit_compaction_state(
    path: &Path,
    expected_revision: u64,
    changes: BTreeMap<String, String>,
    source_ids: BTreeSet<String>,
) -> Result<Option<ControlledCompactionState>, DynError> {
    let mut current = load_compaction_state(path)?;
    if current.revision != expected_revision {
        return Ok(None);
    }
    current.durable_state.extend(changes);
    current.source_ids.extend(source_ids);
    current.revision += 1;
    write_json(path, &current)?;
    Ok(Some(current))
}

fn recall_fixture_events<'a>(fixture: &'a Me06FixturePair, query: &str) -> Vec<&'a Me06Event> {
    let query = query.to_ascii_lowercase();
    fixture
        .visible
        .events
        .iter()
        .filter(|event| {
            event.content.to_ascii_lowercase().contains(&query)
                || event.source_id.to_ascii_lowercase().contains(&query)
                || event.id.to_ascii_lowercase().contains(&query)
        })
        .collect()
}

fn run_controlled_compaction_gate(
    output_root: &Path,
    fixture: &Me06FixturePair,
) -> Result<ControlledCompactionGate, DynError> {
    let root = output_root.join(Me06Arm::ControlledCompaction.as_str());
    std::fs::create_dir_all(&root)?;
    let state_path = root.join("state.json");
    let foreign_path = root.join("foreign-state.json");
    let initial = initialize_compaction_state(&state_path)?;
    initialize_compaction_state(&foreign_path)?;
    let expected_port = fixture
        .hidden
        .expected_state
        .get("current_port")
        .ok_or("fixture has no expected current_port")?
        .clone();
    let expected_endpoint = fixture
        .hidden
        .expected_state
        .get("current_endpoint")
        .ok_or("fixture has no expected current_endpoint")?
        .clone();

    let session_a = load_compaction_state(&state_path)?;
    let session_b = load_compaction_state(&state_path)?;
    let first = commit_compaction_state(
        &state_path,
        session_a.revision,
        BTreeMap::from([("current_port".to_string(), expected_port.clone())]),
        BTreeSet::from(["approved-port".to_string()]),
    )?
    .ok_or("first controlled compaction commit unexpectedly conflicted")?;
    let stale = commit_compaction_state(
        &state_path,
        session_b.revision,
        BTreeMap::from([("current_endpoint".to_string(), expected_endpoint.clone())]),
        BTreeSet::from(["approved-endpoint".to_string()]),
    )?;
    let stale_write_rejected = stale.is_none();
    let rebased = load_compaction_state(&state_path)?;
    let second = commit_compaction_state(
        &state_path,
        rebased.revision,
        BTreeMap::from([("current_endpoint".to_string(), expected_endpoint.clone())]),
        BTreeSet::from(["approved-endpoint".to_string()]),
    )?
    .ok_or("rebased controlled compaction commit failed")?;
    let retry_preserved_both_updates = second.durable_state.get("current_port")
        == Some(&expected_port)
        && second.durable_state.get("current_endpoint") == Some(&expected_endpoint);

    let restarted = load_compaction_state(&state_path)?;
    let restart_recovered_state = restarted == second;
    let cross_session_shared_state = first.revision < restarted.revision
        && load_compaction_state(&state_path)?.durable_state == restarted.durable_state;
    let foreign_value = fixture.hidden.forbidden_primary_values[0].clone();
    let foreign = commit_compaction_state(
        &foreign_path,
        0,
        BTreeMap::from([("foreign_private".to_string(), foreign_value.clone())]),
        BTreeSet::from(["foreign-context-00".to_string()]),
    )?
    .ok_or("foreign controlled compaction commit failed")?;
    let foreign_context_isolated = foreign
        .durable_state
        .values()
        .any(|value| value == &foreign_value)
        && !restarted
            .durable_state
            .values()
            .any(|value| value == &foreign_value);
    let recall_contract_match_count = recall_fixture_events(fixture, "approved").len();
    let passed = initial.revision == 0
        && stale_write_rejected
        && retry_preserved_both_updates
        && restart_recovered_state
        && cross_session_shared_state
        && foreign_context_isolated
        && recall_contract_match_count > 0;
    let report = ControlledCompactionGate {
        state_path,
        initial_revision: initial.revision,
        final_revision: restarted.revision,
        stale_write_rejected,
        retry_preserved_both_updates,
        restart_recovered_state,
        cross_session_shared_state,
        foreign_context_isolated,
        recall_contract_match_count,
        passed,
    };
    write_json(&root.join("gate.json"), &report)?;
    Ok(report)
}

async fn run_morphz_context_gate(output_root: &Path) -> Result<MorphzContextGate, DynError> {
    let root = output_root.join(Me06Arm::FullMorphz.as_str());
    std::fs::create_dir_all(&root)?;
    let database_path = root.join("morphz.db");
    let store = Arc::new(SqliteStore::new(database_path.to_string_lossy().as_ref()).await?);
    let engine = ContextEngine::new(
        Arc::clone(&store) as Arc<dyn EventStore>,
        OrchestratorConfig::default(),
    );
    let primary_context = "me06-gate-primary";
    let foreign_context = "me06-gate-foreign";
    let session_a = "me06-gate-session-a";
    let session_b = "me06-gate-session-b";
    let initial = engine
        .apply_context_transaction(
            primary_context,
            session_a,
            r#"(context-tx
                (base-version 0)
                (reason "ME-06 no-model initialization")
                (create release-state (project ORBIT-42) (port 8080) (endpoint "/v1/events"))
                (create policy-state (security-rule NEVER-LOG-SECRETS) (storage "SQLite WAL")))"#,
        )
        .await?;
    let disjoint_a = engine
        .apply_context_transaction(
            primary_context,
            session_a,
            r#"(context-tx
                (base-version 1)
                (reason "ME-06 disjoint update A")
                (revise release-state (project ORBIT-42) (port 9443) (endpoint "/v3/events")))"#,
        )
        .await?;
    let disjoint_b = engine
        .apply_context_transaction(
            primary_context,
            session_b,
            r#"(context-tx
                (base-version 1)
                (reason "ME-06 disjoint update B")
                (revise policy-state (security-rule NEVER-LOG-SECRETS) (storage "SQLite WAL") (retention-days 45)))"#,
        )
        .await?;
    let disjoint_auto_rebase_succeeded = disjoint_a.after_version == 2
        && disjoint_b.after_version == 3
        && disjoint_b.before_version == 2;
    let first_conflict = engine
        .apply_context_transaction(
            primary_context,
            session_a,
            r#"(context-tx
                (base-version 3)
                (reason "ME-06 accepted conflicting source")
                (revise release-state (project ORBIT-42) (port 9551) (endpoint "/v4/events")))"#,
        )
        .await?;
    let second_conflict = engine
        .apply_context_transaction(
            primary_context,
            session_b,
            r#"(context-tx
                (base-version 3)
                (reason "ME-06 stale conflicting source")
                (revise release-state (project ORBIT-42) (port 9552) (endpoint "/draft/events")))"#,
        )
        .await;
    let conflicting_update_rejected = second_conflict.is_err();
    engine
        .apply_context_transaction(
            foreign_context,
            "me06-gate-session-foreign",
            r#"(context-tx
                (base-version 0)
                (reason "ME-06 foreign Context")
                (create foreign-state (private-value FOREIGN-PORT-7711)))"#,
        )
        .await?;
    drop(engine);
    drop(store);

    let reopened_store =
        Arc::new(SqliteStore::new(database_path.to_string_lossy().as_ref()).await?);
    let reopened_engine = ContextEngine::new(
        Arc::clone(&reopened_store) as Arc<dyn EventStore>,
        OrchestratorConfig::default(),
    );
    let primary_view = reopened_engine
        .build_context_encoding(primary_context, session_b, &HashSet::new())
        .await?;
    let foreign_view = reopened_engine
        .build_context_encoding(
            foreign_context,
            "me06-gate-session-foreign",
            &HashSet::new(),
        )
        .await?;
    let restart_recovered_frames = primary_view.sexpr.contains("ORBIT-42")
        && primary_view.sexpr.contains("9551")
        && primary_view.sexpr.contains("NEVER-LOG-SECRETS")
        && primary_view.sexpr.contains("retention-days")
        && primary_view.state.version == first_conflict.after_version;
    let cross_session_projection_succeeded =
        primary_view.sexpr.contains("release-state") && primary_view.sexpr.contains("policy-state");
    let foreign_context_isolated = foreign_view.sexpr.contains("FOREIGN-PORT-7711")
        && !primary_view.sexpr.contains("FOREIGN-PORT-7711");
    let primary_context_sha256 = sha256(primary_view.sexpr.as_bytes());
    let passed = initial.after_version == 1
        && disjoint_auto_rebase_succeeded
        && conflicting_update_rejected
        && restart_recovered_frames
        && cross_session_projection_succeeded
        && foreign_context_isolated;
    let report = MorphzContextGate {
        database_path,
        initial_version: initial.after_version,
        final_version: primary_view.state.version,
        disjoint_auto_rebase_succeeded,
        conflicting_update_rejected,
        restart_recovered_frames,
        cross_session_projection_succeeded,
        foreign_context_isolated,
        primary_context_sha256,
        passed,
    };
    write_json(&root.join("gate.json"), &report)?;
    Ok(report)
}

fn build_planner(fixtures: &[Me06FixturePair]) -> Result<Me06Planner, DynError> {
    let normalized_visible_bytes = fixtures
        .iter()
        .map(|fixture| serde_json::to_vec(&fixture.visible).map(|bytes| bytes.len()))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .sum();
    let arm_plans = vec![
        Me06ArmCallPlan {
            arm: Me06Arm::ControlledCompaction,
            business_checkpoints: ME06_CHECKPOINT_COUNT,
            expected_physical_model_calls_per_fixture: 18,
            hard_call_acceptance_limit_per_fixture: 24,
            maintenance_or_internal_calls_observable: true,
        },
        Me06ArmCallPlan {
            arm: Me06Arm::FullMorphz,
            business_checkpoints: ME06_CHECKPOINT_COUNT,
            expected_physical_model_calls_per_fixture: 24,
            hard_call_acceptance_limit_per_fixture: 48,
            maintenance_or_internal_calls_observable: true,
        },
    ];
    let expected_smoke_calls = arm_plans
        .iter()
        .map(|plan| plan.expected_physical_model_calls_per_fixture)
        .sum();
    let expected_three_fixture_calls = expected_smoke_calls * fixtures.len();
    let hard_three_fixture_call_limit = arm_plans
        .iter()
        .map(|plan| plan.hard_call_acceptance_limit_per_fixture)
        .sum::<usize>()
        * fixtures.len();
    Ok(Me06Planner {
        event_count_per_fixture: ME06_EVENT_COUNT,
        checkpoint_count_per_fixture: ME06_CHECKPOINT_COUNT,
        fixture_count: fixtures.len(),
        normalized_visible_bytes,
        arm_plans,
        expected_smoke_calls,
        expected_three_fixture_calls,
        hard_three_fixture_call_limit,
        exact_tokenizer_pending: true,
        token_accounting_note: "Exact request tokens require the frozen tokenizer plus final system/tool envelopes; no byte heuristic is reported as a token measurement."
            .to_string(),
    })
}

fn visible_value(
    events: &[&Me06Event],
    source_id: &str,
    prefix: &str,
    suffix: &str,
) -> Option<String> {
    let content = &events
        .iter()
        .find(|event| event.source_id == source_id)?
        .content;
    content
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .map(str::to_string)
}

fn deterministic_fake_output(
    fixture: &Me06VisibleFixture,
    stage: usize,
) -> Result<Me06FakeModelOutput, DynError> {
    let events = fixture
        .events
        .iter()
        .filter(|event| event.stage <= stage && event.context_key == "primary")
        .collect::<Vec<_>>();
    let has_approved = |source_id: &str| {
        events.iter().any(|event| {
            event.source_id == source_id && event.authority == Me06Authority::ApprovedCurrent
        })
    };
    let mut state = BTreeMap::new();
    if let Some(value) = visible_value(&events, "stable-source-00", "项目永久代号为 ", "。")
    {
        state.insert("project".to_string(), value);
    }
    if let Some(value) = visible_value(&events, "stable-source-01", "持续安全约束为 ", "。")
    {
        state.insert("security_rule".to_string(), value);
    }
    if let Some(value) = visible_value(&events, "stable-source-02", "本地持久化方案为 ", "。")
    {
        state.insert("storage".to_string(), value);
    }
    let port = if has_approved("approved-port") {
        visible_value(&events, "approved-port", "已批准当前服务端口为 ", "。")
    } else {
        visible_value(&events, "stable-source-03", "初始服务端口为 ", "。")
    };
    if let Some(value) = port {
        state.insert("current_port".to_string(), value);
    }
    let endpoint = if has_approved("approved-endpoint") {
        visible_value(&events, "approved-endpoint", "已批准当前事件入口为 ", "。")
    } else {
        visible_value(&events, "stable-source-04", "初始事件入口为 ", "。")
    };
    if let Some(value) = endpoint {
        state.insert("current_endpoint".to_string(), value);
    }
    let retention = if has_approved("approved-retention") {
        visible_value(
            &events,
            "approved-retention",
            "已批准当前审计保留期为 ",
            " 天。",
        )
    } else {
        visible_value(&events, "stable-source-05", "初始审计保留期为 ", " 天。")
    };
    if let Some(value) = retention {
        state.insert("retention_days".to_string(), value);
    }
    let timezone = if has_approved("approved-timezone") {
        visible_value(&events, "approved-timezone", "已批准默认时区为 ", "。")
    } else {
        visible_value(&events, "stable-source-06", "初始默认时区为 ", "。")
    };
    if let Some(value) = timezone {
        state.insert("timezone".to_string(), value);
    }
    if events
        .iter()
        .any(|event| event.source_id.starts_with("transfer-case-"))
    {
        state.insert(
            "decision_rule".to_string(),
            "AUTHORITY-BEFORE-RECENCY".to_string(),
        );
    }
    let observed_action = if stage == ME06_CHECKPOINT_COUNT && has_approved("approved-release") {
        visible_value(&events, "approved-target", "已批准最终行动目标为 ", "。").map(|target| {
            Me06Action {
                name: "activate_release".to_string(),
                target,
                evidence_id: "approved-release".to_string(),
            }
        })
    } else {
        None
    };
    Ok(Me06FakeModelOutput {
        observed_state: state,
        observed_action,
        protocol_shape_valid: true,
    })
}

fn fake_architecture_evidence(arm: Me06Arm) -> Me06ArchitectureEvidence {
    match arm {
        Me06Arm::ControlledCompaction => Me06ArchitectureEvidence {
            cross_session_continuity: Some(true),
            restart_recovery: Some(true),
            context_isolation: Some(true),
            concurrent_disjoint_updates_preserved: Some(true),
            concurrent_conflict_detected: Some(true),
            silent_lost_updates: Some(0),
            causal_audit_complete: Some(true),
        },
        Me06Arm::FullMorphz => Me06ArchitectureEvidence {
            cross_session_continuity: Some(true),
            restart_recovery: Some(true),
            context_isolation: Some(true),
            concurrent_disjoint_updates_preserved: Some(true),
            concurrent_conflict_detected: Some(true),
            silent_lost_updates: Some(0),
            causal_audit_complete: Some(true),
        },
    }
}

fn write_jsonl(path: &Path, records: &[Me06FakeTraceRecord]) -> Result<(), DynError> {
    let mut file = std::fs::File::create(path)?;
    for record in records {
        serde_json::to_writer(&mut file, record)?;
        file.write_all(b"\n")?;
    }
    file.flush()?;
    Ok(())
}

fn collect_fake_observed_episode(
    trace_path: &Path,
    fixture: &Me06FixturePair,
    arm: Me06Arm,
) -> Result<Me06ObservedEpisode, DynError> {
    let reader = BufReader::new(std::fs::File::open(trace_path)?);
    let mut final_output = None;
    let mut architecture = None;
    for (index, line) in reader.lines().enumerate() {
        let expected_sequence = index + 1;
        let record: Me06FakeTraceRecord = serde_json::from_str(&line?)?;
        if record.sequence != expected_sequence
            || record.arm != arm
            || record.fixture_id != fixture.visible.fixture_id
        {
            return Err("ME-06 fake trace identity or sequence mismatch".into());
        }
        match record.kind.as_str() {
            "model_output" => {
                let output: Me06FakeModelOutput = serde_json::from_value(record.payload.clone())?;
                if record.stage == ME06_CHECKPOINT_COUNT {
                    final_output = Some(output);
                }
            }
            "architecture_evidence" => {
                architecture = Some(serde_json::from_value(record.payload.clone())?);
            }
            _ => {}
        }
    }
    let output = final_output.ok_or("ME-06 fake trace has no final model output")?;
    Ok(Me06ObservedEpisode {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.fixture_id.clone(),
        arm,
        visible_sha256: fixture.visible_sha256.clone(),
        observed_state: output.observed_state,
        observed_action: output.observed_action,
        forbidden_values_observed: Vec::new(),
        protocol_shape_valid: output.protocol_shape_valid,
        raw_output: "deterministic fake provider output; not reportable".to_string(),
        architecture: architecture.unwrap_or_default(),
    })
}

fn run_fake_adapter_contract(
    output_root: &Path,
    fixture: &Me06FixturePair,
    arm: Me06Arm,
) -> Result<Me06FakeAdapterRun, DynError> {
    let root = output_root
        .join(arm.as_str())
        .join(&fixture.visible.fixture_id);
    std::fs::create_dir_all(&root)?;
    let trace_path = root.join("runtime_trace.jsonl");
    let mut records = Vec::new();
    let mut sequence = 1;
    let mut maintenance_calls = 0;
    let controlled_state_path = root.join("controlled-state.json");
    for stage in 1..=ME06_CHECKPOINT_COUNT {
        let stage_events = fixture
            .visible
            .events
            .iter()
            .filter(|event| event.stage == stage)
            .collect::<Vec<_>>();
        records.push(Me06FakeTraceRecord {
            sequence,
            arm,
            fixture_id: fixture.visible.fixture_id.clone(),
            stage,
            kind: "event_batch_ingested".to_string(),
            payload: serde_json::json!({
                "event_count":stage_events.len(),
                "event_ids":stage_events.iter().map(|event| &event.id).collect::<Vec<_>>()
            }),
        });
        sequence += 1;
        let output = deterministic_fake_output(&fixture.visible, stage)?;
        let maintenance_due = match arm {
            Me06Arm::ControlledCompaction => matches!(stage, 2 | 7),
            Me06Arm::FullMorphz => matches!(stage, 1 | 3 | 6 | 8 | 9 | 12),
        };
        if maintenance_due {
            maintenance_calls += 1;
            records.push(Me06FakeTraceRecord {
                sequence,
                arm,
                fixture_id: fixture.visible.fixture_id.clone(),
                stage,
                kind: "state_maintenance".to_string(),
                payload: serde_json::json!({"deterministic_fake_not_reportable":true}),
            });
            sequence += 1;
            if arm == Me06Arm::ControlledCompaction {
                let prior_revision = if controlled_state_path.exists() {
                    load_compaction_state(&controlled_state_path)?.revision
                } else {
                    0
                };
                write_json(
                    &controlled_state_path,
                    &ControlledCompactionState {
                        revision: prior_revision + 1,
                        durable_state: output.observed_state.clone(),
                        source_ids: fixture
                            .visible
                            .events
                            .iter()
                            .filter(|event| event.stage <= stage)
                            .map(|event| event.source_id.clone())
                            .collect(),
                    },
                )?;
            }
        }
        if stage == 10 {
            let durable_state_reloaded = arm != Me06Arm::ControlledCompaction
                || load_compaction_state(&controlled_state_path).is_ok();
            records.push(Me06FakeTraceRecord {
                sequence,
                arm,
                fixture_id: fixture.visible.fixture_id.clone(),
                stage,
                kind: "restart_recovered".to_string(),
                payload: serde_json::json!({"durable_state_reloaded":durable_state_reloaded}),
            });
            sequence += 1;
        }
        records.push(Me06FakeTraceRecord {
            sequence,
            arm,
            fixture_id: fixture.visible.fixture_id.clone(),
            stage,
            kind: "model_output".to_string(),
            payload: serde_json::to_value(output)?,
        });
        sequence += 1;
    }
    records.push(Me06FakeTraceRecord {
        sequence,
        arm,
        fixture_id: fixture.visible.fixture_id.clone(),
        stage: ME06_CHECKPOINT_COUNT,
        kind: "architecture_evidence".to_string(),
        payload: serde_json::to_value(fake_architecture_evidence(arm))?,
    });
    write_jsonl(&trace_path, &records)?;
    let observed = collect_fake_observed_episode(&trace_path, fixture, arm)?;
    let score = score_me06_episode(&observed, fixture);
    write_json(&root.join("observed.json"), &observed)?;
    write_json(&root.join("score.json"), &score)?;
    let replayed = collect_fake_observed_episode(&trace_path, fixture, arm)?;
    let replayed_score = score_me06_episode(&replayed, fixture);
    let replay_score_identical =
        serde_json::to_vec(&score)? == serde_json::to_vec(&replayed_score)?;
    let passed = score.semantic_success
        && score.protocol_shape_valid
        && replay_score_identical
        && records
            .iter()
            .filter(|record| record.kind == "model_output")
            .count()
            == ME06_CHECKPOINT_COUNT;
    Ok(Me06FakeAdapterRun {
        arm,
        fixture_id: fixture.visible.fixture_id.clone(),
        trace_path,
        checkpoint_calls: ME06_CHECKPOINT_COUNT,
        maintenance_calls,
        semantic_success: score.semantic_success,
        protocol_shape_valid: score.protocol_shape_valid,
        replay_score_identical,
        include_in_paper_statistics: false,
        passed,
    })
}

pub fn run_me06_fake_adapter_gate(
    base_dir: Option<&Path>,
) -> Result<Me06FakeAdapterGateSummary, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-me06-fake-adapter-gates"));
    std::fs::create_dir_all(&base)?;
    let output_root = base.join(format!(
        "ME-06-fake-adapter-gate-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    ));
    std::fs::create_dir_all(&output_root)?;
    let fixtures = generate_me06_fixtures()?;
    let mut runs = Vec::new();
    for fixture in &fixtures {
        for arm in Me06Arm::ALL {
            runs.push(run_fake_adapter_contract(&output_root, fixture, arm)?);
        }
    }
    let all_contracts_passed = runs.iter().all(|run| run.passed);
    let raw_artifact_replay_passed = runs.iter().all(|run| run.replay_score_identical);
    let summary = Me06FakeAdapterGateSummary {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        created_at: Utc::now().to_rfc3339(),
        output_root: output_root.clone(),
        fixture_count: fixtures.len(),
        runs,
        all_contracts_passed,
        raw_artifact_replay_passed,
        real_model_called: false,
        include_in_paper_statistics: false,
        ready_for_real_model_smoke: false,
        remaining_gates: vec![
            "freeze exact fixture text and hidden answers after user review".to_string(),
            "replace deterministic contracts with real controlled-compaction and standalone Morphz process adapters".to_string(),
            "freeze tokenizer and compute complete request-token budget".to_string(),
        ],
    };
    write_json(&output_root.join("summary.json"), &summary)?;
    write_checksums(&output_root)?;
    Ok(summary)
}

pub async fn run_me06_no_model_gate(
    base_dir: Option<&Path>,
) -> Result<Me06NoModelGateSummary, DynError> {
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-me06-gates"));
    std::fs::create_dir_all(&base)?;
    let output_root = base.join(format!(
        "ME-06-no-model-gate-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    ));
    std::fs::create_dir_all(&output_root)?;
    let fixture_root = output_root.join("fixtures");
    std::fs::create_dir_all(&fixture_root)?;
    let fixtures = generate_me06_fixtures()?;
    for fixture in &fixtures {
        let root = fixture_root.join(&fixture.visible.fixture_id);
        std::fs::create_dir_all(&root)?;
        write_json(&root.join("visible.json"), &fixture.visible)?;
        write_json(&root.join("hidden.json"), &fixture.hidden)?;
        write_json(
            &root.join("identity.json"),
            &serde_json::json!({
                "visible_sha256": fixture.visible_sha256,
                "hidden_sha256": sha256(&serde_json::to_vec(&fixture.hidden)?),
                "real_run_layout_requirement": "hidden fixture must be outside every arm workspace and model-visible tool root"
            }),
        )?;
    }
    let hashes = fixtures
        .iter()
        .map(|fixture| fixture.visible_sha256.clone())
        .collect::<BTreeSet<_>>();
    let fixture_hashes_unique = hashes.len() == fixtures.len();
    let scorer_gate = run_scorer_gate(&fixtures[0]);
    write_json(&output_root.join("scorer_gate.json"), &scorer_gate)?;
    let controlled_compaction_gate = run_controlled_compaction_gate(&output_root, &fixtures[0])?;
    let morphz_context_gate = run_morphz_context_gate(&output_root).await?;
    let planner = build_planner(&fixtures)?;
    write_json(&output_root.join("planner.json"), &planner)?;
    let phase_a_passed = fixture_hashes_unique
        && scorer_gate.all_passed
        && controlled_compaction_gate.passed
        && morphz_context_gate.passed;
    let summary = Me06NoModelGateSummary {
        protocol_id: ME06_PROTOCOL_ID.to_string(),
        created_at: Utc::now().to_rfc3339(),
        output_root: output_root.clone(),
        fixture_count: fixtures.len(),
        events_per_fixture: ME06_EVENT_COUNT,
        fixture_hashes_unique,
        scorer_gate,
        controlled_compaction_gate,
        morphz_context_gate,
        planner,
        phase_a_passed,
        real_model_called: false,
        ready_for_real_model_smoke: false,
        remaining_gates: vec![
            "freeze exact fixture text and hidden answers after user review".to_string(),
            "implement real controlled-compaction model adapter".to_string(),
            "implement standalone production Morphz 12-checkpoint process adapter".to_string(),
            "freeze tokenizer and compute complete request-token budget".to_string(),
            "run both fake-provider adapter contracts and artifact replay".to_string(),
        ],
    };
    write_json(&output_root.join("summary.json"), &summary)?;
    write_checksums(&output_root)?;
    Ok(summary)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DynError> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn write_checksums(root: &Path) -> Result<(), DynError> {
    let checksum_path = root.join("checksums.sha256");
    let mut files = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.path() != checksum_path)
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    files.sort();
    let mut output = String::new();
    for path in files {
        output.push_str(&format!(
            "{}  {}\n",
            sha256(&std::fs::read(&path)?),
            path.strip_prefix(root)?.display()
        ));
    }
    std::fs::write(checksum_path, output)?;
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixtures_have_frozen_shape_and_unique_hashes() {
        let fixtures = generate_me06_fixtures().unwrap();
        assert_eq!(fixtures.len(), 3);
        assert!(fixtures
            .iter()
            .all(|fixture| fixture.visible.events.len() == ME06_EVENT_COUNT));
        assert_eq!(
            fixtures
                .iter()
                .map(|fixture| &fixture.visible_sha256)
                .collect::<BTreeSet<_>>()
                .len(),
            fixtures.len()
        );
    }

    #[test]
    fn semantic_success_is_not_overridden_by_shape_failure() {
        let fixture = generate_me06_fixtures().unwrap().remove(0);
        let gate = run_scorer_gate(&fixture);
        assert!(gate.all_passed);
        let format_only = gate
            .cases
            .iter()
            .find(|case| case.id == "format_only_failure")
            .unwrap();
        assert!(format_only.observed_semantic_success);
        assert!(!format_only.observed_protocol_shape_valid);
    }

    #[test]
    fn controlled_compaction_rejects_stale_revision_and_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let fixture = generate_me06_fixtures().unwrap().remove(0);
        let gate = run_controlled_compaction_gate(directory.path(), &fixture).unwrap();
        assert!(gate.passed);
        assert!(gate.stale_write_rejected);
        assert!(gate.retry_preserved_both_updates);
    }

    #[tokio::test]
    async fn production_context_engine_rebases_disjoint_and_rejects_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let gate = run_morphz_context_gate(directory.path()).await.unwrap();
        assert!(gate.passed);
        assert!(gate.disjoint_auto_rebase_succeeded);
        assert!(gate.conflicting_update_rejected);
        assert!(gate.restart_recovered_frames);
    }

    #[test]
    fn planner_never_calls_events_rounds() {
        let fixtures = generate_me06_fixtures().unwrap();
        let planner = build_planner(&fixtures).unwrap();
        assert_eq!(planner.expected_smoke_calls, 42);
        assert_eq!(planner.expected_three_fixture_calls, 126);
        assert!(planner.hard_three_fixture_call_limit < ME06_EVENT_COUNT * 2 * 3);
        assert!(planner.exact_tokenizer_pending);
    }

    #[test]
    fn deterministic_fake_derives_hidden_answer_only_from_visible_events() {
        for fixture in generate_me06_fixtures().unwrap() {
            let output =
                deterministic_fake_output(&fixture.visible, ME06_CHECKPOINT_COUNT).unwrap();
            assert_eq!(output.observed_state, fixture.hidden.expected_state);
            assert_eq!(output.observed_action, Some(fixture.hidden.expected_action));
        }
    }

    #[test]
    fn all_fake_adapter_contracts_replay_identically() {
        let directory = tempfile::tempdir().unwrap();
        let summary = run_me06_fake_adapter_gate(Some(directory.path())).unwrap();
        assert_eq!(summary.runs.len(), 6);
        assert!(summary.all_contracts_passed);
        assert!(summary.raw_artifact_replay_passed);
        assert!(!summary.real_model_called);
        assert!(!summary.include_in_paper_statistics);
        assert!(!summary.ready_for_real_model_smoke);
    }
}
