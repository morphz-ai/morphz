use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const ME01_PROTOCOL_ID: &str = "me01-context-reentry-p1-candidate";
const FIXTURE_ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/me01_context_reentry_p1"
);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Me01Arm {
    AppendOnly,
    StructuredNoDirectReentry,
    FullMorphz,
}

impl Me01Arm {
    pub const ALL: [Self; 3] = [
        Self::AppendOnly,
        Self::StructuredNoDirectReentry,
        Self::FullMorphz,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AppendOnly => "append_only",
            Self::StructuredNoDirectReentry => "structured_no_direct_reentry",
            Self::FullMorphz => "full_morphz",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01VisibleEvent {
    pub event_id: String,
    pub source: String,
    pub version: u64,
    pub timestamp: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01Stage {
    pub id: String,
    pub context_key: String,
    pub session_key: String,
    pub events: Vec<Me01VisibleEvent>,
    pub instruction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01VisibleFixture {
    pub id: String,
    pub family: String,
    pub title: String,
    pub stages: Vec<Me01Stage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Me01Action {
    pub action: String,
    pub object_id: String,
    pub value: String,
    pub evidence_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01HiddenFixture {
    pub fixture_id: String,
    pub expected: Me01Action,
    #[serde(default)]
    pub stale_values: Vec<String>,
    #[serde(default)]
    pub foreign_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01FixturePair {
    pub visible: Me01VisibleFixture,
    pub hidden: Me01HiddenFixture,
    pub visible_sha256: String,
    pub hidden_sha256: String,
    pub canonical_semantic_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Me01RuntimeEvidence {
    pub adapter_kind: String,
    pub production_morphz_runtime: bool,
    pub database_path: Option<PathBuf>,
    #[serde(default)]
    pub context_ids: Vec<String>,
    #[serde(default)]
    pub session_mounts: BTreeMap<String, String>,
    pub context_tx_tool_exposed: bool,
    pub context_tx_attempts: usize,
    pub context_tx_commits: usize,
    #[serde(default)]
    pub committed_frame_ids: Vec<String>,
    #[serde(default)]
    pub act_projection_frame_ids: Vec<String>,
    pub structured_context_snapshot_sha256: Option<String>,
    pub message_transcript_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01ObservedEpisode {
    pub protocol_id: String,
    pub fixture_id: String,
    pub arm: Me01Arm,
    pub visible_input_sha256: String,
    pub final_response: String,
    pub runtime: Me01RuntimeEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01EpisodeScore {
    pub protocol_id: String,
    pub fixture_id: String,
    pub arm: Me01Arm,
    pub parsed_action: Option<Me01Action>,
    pub json_contract_valid: bool,
    pub action_matches: bool,
    pub object_matches: bool,
    pub value_matches: bool,
    pub evidence_matches: bool,
    pub stale_value_reused: bool,
    pub foreign_value_reused: bool,
    pub task_success: bool,
    pub implementation_valid: bool,
    pub strict_success: bool,
    pub integrity_violations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Me01FakeGateSummary {
    pub protocol_id: String,
    pub created_at: String,
    pub fixture_count: usize,
    pub positive_episode_count: usize,
    pub positive_strict_passes: usize,
    pub negative_case_count: usize,
    pub negative_cases_rejected: usize,
    pub output_root: PathBuf,
    pub ready_for_runtime_adapter_implementation: bool,
    pub ready_for_real_model_smoke: bool,
}

pub fn load_me01_fixtures() -> Result<Vec<Me01FixturePair>, DynError> {
    let visible_root = Path::new(FIXTURE_ROOT).join("visible");
    let hidden_root = Path::new(FIXTURE_ROOT).join("hidden");
    let mut paths = std::fs::read_dir(&visible_root)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();

    let mut fixtures = Vec::with_capacity(paths.len());
    for visible_path in paths {
        let file_name = visible_path
            .file_name()
            .ok_or("ME-01 visible fixture is missing a file name")?;
        let hidden_path = hidden_root.join(file_name);
        let visible_bytes = std::fs::read(&visible_path)?;
        let hidden_bytes = std::fs::read(&hidden_path)?;
        let visible: Me01VisibleFixture = serde_json::from_slice(&visible_bytes)?;
        let hidden: Me01HiddenFixture = serde_json::from_slice(&hidden_bytes)?;
        validate_fixture_pair(&visible, &hidden)?;
        fixtures.push(Me01FixturePair {
            visible_sha256: sha256(&visible_bytes),
            hidden_sha256: sha256(&hidden_bytes),
            canonical_semantic_sha256: canonical_semantic_sha256(&visible)?,
            visible,
            hidden,
        });
    }
    if fixtures.is_empty() {
        return Err("ME-01 fixture set is empty".into());
    }
    Ok(fixtures)
}

pub fn canonical_semantic_sha256(fixture: &Me01VisibleFixture) -> Result<String, DynError> {
    Ok(sha256(&serde_json::to_vec(fixture)?))
}

pub fn score_me01_episode(
    observed: &Me01ObservedEpisode,
    fixture: &Me01FixturePair,
) -> Me01EpisodeScore {
    let parsed_action = serde_json::from_str::<Me01Action>(observed.final_response.trim()).ok();
    let json_contract_valid = parsed_action.is_some();
    let action_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.action == fixture.hidden.expected.action);
    let object_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.object_id == fixture.hidden.expected.object_id);
    let value_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.value == fixture.hidden.expected.value);
    let evidence_matches = parsed_action
        .as_ref()
        .is_some_and(|value| value.evidence_id == fixture.hidden.expected.evidence_id);
    let stale_value_reused = parsed_action.as_ref().is_some_and(|value| {
        fixture
            .hidden
            .stale_values
            .iter()
            .any(|candidate| candidate == &value.value)
    });
    let foreign_value_reused = parsed_action.as_ref().is_some_and(|value| {
        fixture
            .hidden
            .foreign_values
            .iter()
            .any(|candidate| candidate == &value.value)
    });
    let task_success = json_contract_valid
        && action_matches
        && object_matches
        && value_matches
        && evidence_matches;
    let integrity_violations = implementation_violations(observed, fixture);
    let implementation_valid = integrity_violations.is_empty();
    Me01EpisodeScore {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: observed.fixture_id.clone(),
        arm: observed.arm,
        parsed_action,
        json_contract_valid,
        action_matches,
        object_matches,
        value_matches,
        evidence_matches,
        stale_value_reused,
        foreign_value_reused,
        task_success,
        implementation_valid,
        strict_success: task_success && implementation_valid,
        integrity_violations,
    }
}

pub fn run_me01_fake_gate(base_dir: Option<&Path>) -> Result<Me01FakeGateSummary, DynError> {
    let fixtures = load_me01_fixtures()?;
    let base = base_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("morphz-me01-gates"));
    std::fs::create_dir_all(&base)?;
    let output_root = base.join(format!(
        "ME-01-fake-gate-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    ));
    std::fs::create_dir_all(&output_root)?;

    let mut positive_scores = Vec::new();
    for fixture in &fixtures {
        for arm in Me01Arm::ALL {
            let observed = fake_observed_episode(fixture, arm, &fixture.hidden.expected);
            let score = score_me01_episode(&observed, fixture);
            if !score.strict_success {
                return Err(format!(
                    "positive fake gate failed for {} / {}: {:?}",
                    fixture.visible.id,
                    arm.as_str(),
                    score.integrity_violations
                )
                .into());
            }
            let episode_root =
                output_root.join(format!("{}__{}", fixture.visible.id, arm.as_str()));
            std::fs::create_dir_all(&episode_root)?;
            std::fs::write(
                episode_root.join("observed_episode.json"),
                serde_json::to_vec_pretty(&observed)?,
            )?;
            std::fs::write(
                episode_root.join("score.json"),
                serde_json::to_vec_pretty(&score)?,
            )?;
            positive_scores.push(score);
        }
    }

    let negative_scores = fake_negative_scores(&fixtures[0]);
    if negative_scores.iter().any(|score| score.strict_success) {
        return Err("at least one ME-01 negative fake gate incorrectly passed".into());
    }
    std::fs::write(
        output_root.join("negative_scores.json"),
        serde_json::to_vec_pretty(&negative_scores)?,
    )?;

    let summary = Me01FakeGateSummary {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        created_at: Utc::now().to_rfc3339(),
        fixture_count: fixtures.len(),
        positive_episode_count: positive_scores.len(),
        positive_strict_passes: positive_scores
            .iter()
            .filter(|score| score.strict_success)
            .count(),
        negative_case_count: negative_scores.len(),
        negative_cases_rejected: negative_scores
            .iter()
            .filter(|score| !score.strict_success)
            .count(),
        output_root: output_root.clone(),
        ready_for_runtime_adapter_implementation: true,
        ready_for_real_model_smoke: false,
    };
    std::fs::write(
        output_root.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    Ok(summary)
}

fn validate_fixture_pair(
    visible: &Me01VisibleFixture,
    hidden: &Me01HiddenFixture,
) -> Result<(), DynError> {
    if visible.id != hidden.fixture_id {
        return Err(format!(
            "ME-01 fixture identity mismatch: {} != {}",
            visible.id, hidden.fixture_id
        )
        .into());
    }
    if visible.stages.len() < 3 {
        return Err(format!("{} must contain at least three stages", visible.id).into());
    }
    if visible.stages.last().map(|stage| stage.id.as_str()) != Some("act") {
        return Err(format!("{} must end with an act stage", visible.id).into());
    }
    let mut event_ids = BTreeSet::new();
    for stage in &visible.stages {
        if stage.context_key.trim().is_empty()
            || stage.session_key.trim().is_empty()
            || stage.instruction.trim().is_empty()
        {
            return Err(format!("{} has an incomplete stage", visible.id).into());
        }
        for event in &stage.events {
            if !event_ids.insert(event.event_id.as_str()) {
                return Err(
                    format!("{} repeats visible event id {}", visible.id, event.event_id).into(),
                );
            }
        }
    }
    if !event_ids.contains(hidden.expected.evidence_id.as_str()) {
        return Err(format!(
            "{} expected evidence {} is not visible",
            visible.id, hidden.expected.evidence_id
        )
        .into());
    }
    Ok(())
}

fn implementation_violations(
    observed: &Me01ObservedEpisode,
    fixture: &Me01FixturePair,
) -> Vec<String> {
    let mut violations = Vec::new();
    if observed.protocol_id != ME01_PROTOCOL_ID {
        violations.push("protocol_id_mismatch".to_string());
    }
    if observed.fixture_id != fixture.visible.id {
        violations.push("fixture_id_mismatch".to_string());
    }
    if observed.visible_input_sha256 != fixture.canonical_semantic_sha256 {
        violations.push("visible_semantic_input_hash_mismatch".to_string());
    }
    match observed.arm {
        Me01Arm::AppendOnly => {
            if observed.runtime.adapter_kind != "append_only_messages" {
                violations.push("append_only_adapter_kind_invalid".to_string());
            }
            if observed.runtime.production_morphz_runtime {
                violations.push("append_only_must_not_claim_production_morphz".to_string());
            }
            if observed.runtime.message_transcript_sha256.is_none() {
                violations.push("append_only_transcript_hash_missing".to_string());
            }
            if observed.runtime.context_tx_attempts != 0 || observed.runtime.context_tx_commits != 0
            {
                violations.push("append_only_contains_context_transaction".to_string());
            }
        }
        Me01Arm::StructuredNoDirectReentry => {
            require_production_context_evidence(observed, &mut violations);
            if observed.runtime.adapter_kind != "production_morphz_read_only_context" {
                violations.push("read_only_adapter_kind_invalid".to_string());
            }
            if observed.runtime.context_tx_tool_exposed {
                violations.push("read_only_context_tx_tool_exposed".to_string());
            }
            if observed.runtime.context_tx_attempts != 0 || observed.runtime.context_tx_commits != 0
            {
                violations.push("read_only_context_transaction_observed".to_string());
            }
        }
        Me01Arm::FullMorphz => {
            require_production_context_evidence(observed, &mut violations);
            if observed.runtime.adapter_kind != "production_morphz_full_context" {
                violations.push("full_morphz_adapter_kind_invalid".to_string());
            }
            if !observed.runtime.context_tx_tool_exposed {
                violations.push("full_morphz_context_tx_tool_hidden".to_string());
            }
            if observed.runtime.context_tx_attempts == 0 {
                violations.push("full_morphz_context_tx_attempt_missing".to_string());
            }
            if observed.runtime.context_tx_commits == 0 {
                violations.push("full_morphz_context_tx_commit_missing".to_string());
            }
            let projected = observed
                .runtime
                .act_projection_frame_ids
                .iter()
                .collect::<BTreeSet<_>>();
            if observed.runtime.committed_frame_ids.is_empty()
                || !observed
                    .runtime
                    .committed_frame_ids
                    .iter()
                    .any(|frame| projected.contains(frame))
            {
                violations.push("committed_frame_missing_from_act_projection".to_string());
            }
        }
    }
    violations
}

fn require_production_context_evidence(
    observed: &Me01ObservedEpisode,
    violations: &mut Vec<String>,
) {
    if !observed.runtime.production_morphz_runtime {
        violations.push("production_morphz_runtime_not_proven".to_string());
    }
    if observed.runtime.database_path.is_none() {
        violations.push("sqlite_database_path_missing".to_string());
    }
    if observed.runtime.context_ids.is_empty() {
        violations.push("context_identity_missing".to_string());
    }
    if observed.runtime.session_mounts.is_empty() {
        violations.push("session_mount_evidence_missing".to_string());
    }
    if observed
        .runtime
        .structured_context_snapshot_sha256
        .is_none()
    {
        violations.push("structured_context_snapshot_hash_missing".to_string());
    }
}

fn fake_observed_episode(
    fixture: &Me01FixturePair,
    arm: Me01Arm,
    action: &Me01Action,
) -> Me01ObservedEpisode {
    let mut runtime = Me01RuntimeEvidence::default();
    match arm {
        Me01Arm::AppendOnly => {
            runtime.adapter_kind = "append_only_messages".to_string();
            runtime.message_transcript_sha256 = Some("fake-transcript-sha256".to_string());
        }
        Me01Arm::StructuredNoDirectReentry => {
            runtime.adapter_kind = "production_morphz_read_only_context".to_string();
            runtime.production_morphz_runtime = true;
            runtime.database_path = Some(PathBuf::from("/fake/read-only/morphz.db"));
            runtime.context_ids = fixture_context_ids(&fixture.visible);
            runtime.session_mounts = fixture_session_mounts(&fixture.visible);
            runtime.structured_context_snapshot_sha256 = Some("fake-context-sha256".to_string());
        }
        Me01Arm::FullMorphz => {
            runtime.adapter_kind = "production_morphz_full_context".to_string();
            runtime.production_morphz_runtime = true;
            runtime.database_path = Some(PathBuf::from("/fake/full/morphz.db"));
            runtime.context_ids = fixture_context_ids(&fixture.visible);
            runtime.session_mounts = fixture_session_mounts(&fixture.visible);
            runtime.context_tx_tool_exposed = true;
            runtime.context_tx_attempts = 1;
            runtime.context_tx_commits = 1;
            runtime.committed_frame_ids = vec!["frame-current-state".to_string()];
            runtime.act_projection_frame_ids = vec!["frame-current-state".to_string()];
            runtime.structured_context_snapshot_sha256 = Some("fake-context-sha256".to_string());
        }
    }
    Me01ObservedEpisode {
        protocol_id: ME01_PROTOCOL_ID.to_string(),
        fixture_id: fixture.visible.id.clone(),
        arm,
        visible_input_sha256: fixture.canonical_semantic_sha256.clone(),
        final_response: serde_json::to_string(action).expect("serializing an action cannot fail"),
        runtime,
    }
}

fn fake_negative_scores(fixture: &Me01FixturePair) -> Vec<Me01EpisodeScore> {
    let mut cases = Vec::new();

    let mut invalid_json =
        fake_observed_episode(fixture, Me01Arm::AppendOnly, &fixture.hidden.expected);
    invalid_json.final_response = "not-json".to_string();
    cases.push(score_me01_episode(&invalid_json, fixture));

    let mut wrong_evidence = fixture.hidden.expected.clone();
    wrong_evidence.evidence_id = "ev-wrong".to_string();
    let observed = fake_observed_episode(fixture, Me01Arm::AppendOnly, &wrong_evidence);
    cases.push(score_me01_episode(&observed, fixture));

    let mut full_without_commit =
        fake_observed_episode(fixture, Me01Arm::FullMorphz, &fixture.hidden.expected);
    full_without_commit.runtime.context_tx_commits = 0;
    cases.push(score_me01_episode(&full_without_commit, fixture));

    let mut read_only_with_commit = fake_observed_episode(
        fixture,
        Me01Arm::StructuredNoDirectReentry,
        &fixture.hidden.expected,
    );
    read_only_with_commit.runtime.context_tx_attempts = 1;
    read_only_with_commit.runtime.context_tx_commits = 1;
    cases.push(score_me01_episode(&read_only_with_commit, fixture));

    let mut wrong_input_hash =
        fake_observed_episode(fixture, Me01Arm::AppendOnly, &fixture.hidden.expected);
    wrong_input_hash.visible_input_sha256 = "wrong".to_string();
    cases.push(score_me01_episode(&wrong_input_hash, fixture));

    cases
}

fn fixture_context_ids(fixture: &Me01VisibleFixture) -> Vec<String> {
    fixture
        .stages
        .iter()
        .map(|stage| stage.context_key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|key| format!("context-{key}"))
        .collect()
}

fn fixture_session_mounts(fixture: &Me01VisibleFixture) -> BTreeMap<String, String> {
    fixture
        .stages
        .iter()
        .map(|stage| {
            (
                format!("session-{}", stage.session_key),
                format!("context-{}", stage.context_key),
            )
        })
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_set_is_complete_and_hidden_evidence_is_visible() {
        let fixtures = load_me01_fixtures().expect("fixtures should load");
        assert_eq!(fixtures.len(), 5);
        let families = fixtures
            .iter()
            .map(|fixture| fixture.visible.family.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(families.len(), 5);
        for fixture in fixtures {
            assert_eq!(fixture.visible.id, fixture.hidden.fixture_id);
            assert_eq!(fixture.visible.stages.last().unwrap().id, "act");
            assert_ne!(fixture.visible_sha256, fixture.hidden_sha256);
        }
    }

    #[test]
    fn positive_contract_passes_all_three_arms() {
        let fixture = load_me01_fixtures().unwrap().remove(0);
        for arm in Me01Arm::ALL {
            let observed = fake_observed_episode(&fixture, arm, &fixture.hidden.expected);
            let score = score_me01_episode(&observed, &fixture);
            assert!(score.strict_success, "{arm:?}: {score:?}");
        }
    }

    #[test]
    fn strict_action_parser_rejects_extra_fields() {
        let fixture = load_me01_fixtures().unwrap().remove(0);
        let mut observed =
            fake_observed_episode(&fixture, Me01Arm::AppendOnly, &fixture.hidden.expected);
        observed.final_response = format!(
            "{{\"action\":\"{}\",\"object_id\":\"{}\",\"value\":\"{}\",\"evidence_id\":\"{}\",\"note\":\"extra\"}}",
            fixture.hidden.expected.action,
            fixture.hidden.expected.object_id,
            fixture.hidden.expected.value,
            fixture.hidden.expected.evidence_id
        );
        let score = score_me01_episode(&observed, &fixture);
        assert!(!score.json_contract_valid);
        assert!(!score.strict_success);
    }

    #[test]
    fn full_morphz_requires_a_committed_frame_in_the_act_projection() {
        let fixture = load_me01_fixtures().unwrap().remove(0);
        let mut observed =
            fake_observed_episode(&fixture, Me01Arm::FullMorphz, &fixture.hidden.expected);
        observed.runtime.act_projection_frame_ids = vec!["different-frame".to_string()];
        let score = score_me01_episode(&observed, &fixture);
        assert!(score.task_success);
        assert!(!score.implementation_valid);
        assert!(score
            .integrity_violations
            .contains(&"committed_frame_missing_from_act_projection".to_string()));
    }

    #[test]
    fn fake_gate_rejects_all_negative_cases() {
        let directory = tempfile::tempdir().unwrap();
        let summary = run_me01_fake_gate(Some(directory.path())).unwrap();
        assert_eq!(summary.fixture_count, 5);
        assert_eq!(summary.positive_episode_count, 15);
        assert_eq!(summary.positive_strict_passes, 15);
        assert_eq!(summary.negative_cases_rejected, summary.negative_case_count);
        assert!(summary.ready_for_runtime_adapter_implementation);
        assert!(!summary.ready_for_real_model_smoke);
    }
}
