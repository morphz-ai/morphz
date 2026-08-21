//! Portable Agent Trajectory projection and validation.
//!
//! The Event Store remains authoritative. This module deterministically
//! projects immutable Runtime facts into the exchange model defined by the
//! Morphz Agent Trajectory Specification; importing a Bundle never writes
//! those facts back into Runtime state.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};

use crate::event::Event;
use crate::memory::QueryFilter;
use crate::runtime::MorphzRuntime;

pub const AGENT_TRAJECTORY_SPEC_VERSION: &str = "0.1";
pub const AGENT_TRAJECTORY_EXPORTER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryRights {
    pub retention: bool,
    pub local_evaluation: bool,
    pub hosted_evaluation: bool,
    pub training: bool,
    pub redistribution_original: bool,
    pub redistribution_transformed: bool,
}

impl Default for TrajectoryRights {
    fn default() -> Self {
        Self {
            retention: true,
            local_evaluation: true,
            hosted_evaluation: false,
            training: false,
            redistribution_original: false,
            redistribution_transformed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryExportRequest {
    pub context_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<DateTime<Utc>>,
    #[serde(default = "default_max_events")]
    pub max_events: usize,
    #[serde(default = "default_profiles")]
    pub profiles: Vec<String>,
    #[serde(default = "default_true")]
    pub include_payloads: bool,
    #[serde(default)]
    pub include_user_content: bool,
    #[serde(default)]
    pub rights: TrajectoryRights,
}

fn default_max_events() -> usize {
    10_000
}

fn default_profiles() -> Vec<String> {
    vec!["AT-Core".to_string()]
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentTrajectoryBundle {
    pub spec_version: String,
    pub profiles: Vec<String>,
    pub trajectory_id: String,
    pub source: TrajectorySource,
    pub scope: TrajectoryScope,
    pub completeness: TrajectoryCompleteness,
    pub bindings: BTreeMap<String, Vec<String>>,
    pub states: Vec<TrajectoryState>,
    pub nodes: Vec<TrajectoryNode>,
    pub edges: Vec<TrajectoryEdge>,
    pub outcomes: Vec<TrajectoryOutcome>,
    pub verifier_results: Vec<VerifierResult>,
    pub reward_records: Vec<RewardRecord>,
    pub transform: TrajectoryTransform,
    pub disclosure: TrajectoryDisclosure,
    pub rights: TrajectoryRights,
    pub integrity: TrajectoryIntegrity,
    pub extensions: BTreeMap<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectorySource {
    pub implementation: String,
    pub exporter_version: String,
    pub authority_domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryScope {
    pub context_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    pub selection: String,
    pub event_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryCompleteness {
    pub status: String,
    pub reason: String,
    pub material_omissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrajectoryState {
    pub state_id: String,
    pub context_id: String,
    pub context_revision: u64,
    pub availability: String,
    pub source_event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrajectoryNode {
    pub node_id: String,
    pub kind: String,
    pub source_event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    pub timestamp: DateTime<Utc>,
    pub actor: String,
    pub authority_class: String,
    pub topic: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_after: Option<String>,
    pub external_parents: Vec<ExternalParent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExternalParent {
    pub relation: String,
    pub source_id: String,
    pub availability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryEdge {
    pub edge_id: String,
    pub from: String,
    pub to: String,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrajectoryOutcome {
    pub outcome_id: String,
    pub scope: String,
    pub producer: String,
    pub authority_class: String,
    pub status: String,
    pub terminal: bool,
    pub evidence_refs: Vec<String>,
    pub asserted_at_node: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifierResult {
    pub verifier_result_id: String,
    pub verifier: String,
    pub verifier_version: String,
    pub checked_property: String,
    pub evidence_refs: Vec<String>,
    pub status: String,
    pub output: JsonValue,
    pub asserted_at_node: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommitVerifierResult {
    pub context_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective_id: Option<String>,
    pub verifier: String,
    pub verifier_version: String,
    pub checked_property: String,
    pub evidence_refs: Vec<String>,
    pub status: String,
    pub output: JsonValue,
    pub producer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RewardRecord {
    pub reward_id: String,
    pub policy: String,
    pub policy_version: String,
    pub sources: Vec<String>,
    pub scope: String,
    pub attribution_target: String,
    pub signal_type: String,
    pub value: JsonValue,
    pub aggregation: String,
    pub producer: String,
    pub created_at: DateTime<Utc>,
    pub timing: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommitRewardRecord {
    pub context_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective_id: Option<String>,
    pub policy: String,
    pub policy_version: String,
    pub sources: Vec<String>,
    pub scope: String,
    pub attribution_target: String,
    pub signal_type: String,
    pub value: JsonValue,
    pub aggregation: String,
    pub producer: String,
    pub timing: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrainingEpisode {
    pub episode_version: String,
    pub episode_id: String,
    pub source_trajectory_id: String,
    pub selection: String,
    pub termination: String,
    pub transitions: Vec<TrainingTransition>,
    pub reward_refs: Vec<String>,
    pub rights: TrajectoryRights,
    pub integrity: TrajectoryIntegrity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrainingTransition {
    pub transition_id: String,
    pub source_node_id: String,
    pub state_view: TrainingField,
    pub action_target: TrainingField,
    pub environment_outputs: Vec<TrainingField>,
    pub reward_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrainingField {
    pub role: String,
    pub loss: String,
    pub availability: String,
    pub value: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryTransform {
    pub exporter: String,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryDisclosure {
    pub private_reasoning: String,
    pub user_content: String,
    pub raw_event_payloads: String,
    pub redacted_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryIntegrity {
    pub status: String,
    pub algorithm: String,
    pub canonicalization: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrajectoryVerificationReport {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub node_count: usize,
    pub edge_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrainingEpisodeVerificationReport {
    pub valid: bool,
    pub errors: Vec<String>,
    pub transition_count: usize,
}

pub struct AgentTrajectoryExporter;

impl AgentTrajectoryExporter {
    pub async fn export(
        runtime: &MorphzRuntime,
        request: TrajectoryExportRequest,
    ) -> Result<AgentTrajectoryBundle, String> {
        validate_request(&request)?;
        let events = runtime
            .query_events(QueryFilter {
                context_id: Some(request.context_id.clone()),
                objective_id: request.objective_id.clone(),
                activation_id: request.activation_id.clone(),
                start_time: request.start_time,
                end_time: request.end_time,
                top_k: Some(request.max_events),
                ..QueryFilter::default()
            })
            .await
            .map_err(|error| error.to_string())?;
        Self::export_events(request, events)
    }

    pub fn export_events(
        request: TrajectoryExportRequest,
        mut events: Vec<Event>,
    ) -> Result<AgentTrajectoryBundle, String> {
        validate_request(&request)?;
        events.retain(|event| {
            event.payload.get("context_id").and_then(JsonValue::as_str)
                == Some(request.context_id.as_str())
        });
        events.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.timestamp.cmp(&right.timestamp))
                .then_with(|| left.id.cmp(&right.id))
        });
        if events.len() > request.max_events {
            events.truncate(request.max_events);
        }

        let event_ids = events
            .iter()
            .map(|event| event.id.as_str())
            .collect::<HashSet<_>>();
        let mut nodes = Vec::with_capacity(events.len());
        let mut edges = Vec::new();
        let mut states = BTreeMap::<u64, TrajectoryState>::new();
        let mut outcomes = Vec::new();
        let mut verifier_results = Vec::new();
        let mut reward_records = Vec::new();
        let mut bindings = BTreeMap::<String, BTreeSet<String>>::new();
        let mut redacted_fields = BTreeSet::new();
        let mut plan_sequences = HashMap::<String, Vec<(u64, String)>>::new();

        for event in &events {
            collect_bindings(event, &mut bindings);
            if let (Some(plan_id), Some(sequence)) = (
                event
                    .payload
                    .get("plan_execution_id")
                    .and_then(JsonValue::as_str),
                event
                    .payload
                    .get("effect_sequence")
                    .and_then(JsonValue::as_u64),
            ) {
                plan_sequences
                    .entry(plan_id.to_string())
                    .or_default()
                    .push((sequence, event.id.clone()));
            }

            let mut external_parents = Vec::new();
            for &(field, relation) in causal_fields() {
                let Some(parent_id) = event.payload.get(field).and_then(JsonValue::as_str) else {
                    continue;
                };
                if event_ids.contains(parent_id) {
                    edges.push(edge(parent_id, &event.id, relation));
                } else {
                    external_parents.push(ExternalParent {
                        relation: relation.to_string(),
                        source_id: parent_id.to_string(),
                        availability: "referenced_outside_scope".to_string(),
                    });
                }
            }

            let (state_before, state_after) = collect_context_states(event, &mut states);
            if let Some(outcome) = outcome_from_event(event) {
                outcomes.push(outcome);
            }
            if let Some(result) = verifier_result_from_event(event) {
                verifier_results.push(result);
            }
            if let Some(record) = reward_record_from_event(event) {
                reward_records.push(record);
            }
            let payload = request
                .include_payloads
                .then(|| redact_payload(event, request.include_user_content, &mut redacted_fields));
            nodes.push(TrajectoryNode {
                node_id: node_id(&event.id),
                kind: node_kind(event).to_string(),
                source_event_id: event.id.clone(),
                sequence: event.sequence,
                timestamp: event.timestamp,
                actor: event.actor.clone(),
                authority_class: authority_class(&event.actor).to_string(),
                topic: event.topic.clone(),
                status: event_status(event).to_string(),
                state_before,
                state_after,
                external_parents,
                payload,
            });
        }

        for events in plan_sequences.values_mut() {
            events.sort_by_key(|(sequence, _)| *sequence);
            for pair in events.windows(2) {
                if pair[0].0 < pair[1].0 {
                    edges.push(edge(&pair[0].1, &pair[1].1, "precedes_in_plan"));
                }
            }
        }
        edges.sort_by(|left, right| left.edge_id.cmp(&right.edge_id));
        edges.dedup_by(|left, right| left.edge_id == right.edge_id);

        let likely_truncated = events.len() == request.max_events;
        let terminal = request.objective_id.is_some()
            && events.iter().any(|event| {
                event
                    .payload
                    .get("objective_status")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|status| matches!(status, "completed" | "cancelled" | "failed"))
            });
        let (completeness_status, completeness_reason) = if likely_truncated {
            (
                "partial",
                "selection reached max_events; later in-scope facts may exist",
            )
        } else if terminal {
            (
                "complete",
                "selected Objective reached a Runtime terminal state",
            )
        } else {
            (
                "open",
                "selected scope has no represented terminal boundary",
            )
        };
        let first_sequence = events.first().and_then(|event| event.sequence);
        let last_sequence = events.last().and_then(|event| event.sequence);
        let trajectory_id = stable_trajectory_id(&request, &events)?;
        let mut operations = vec!["causal_projection".to_string()];
        if !request.include_user_content {
            operations.push("user_content_redaction".to_string());
        }
        if !request.include_payloads {
            operations.push("event_payload_omission".to_string());
        }
        let mut bundle = AgentTrajectoryBundle {
            spec_version: AGENT_TRAJECTORY_SPEC_VERSION.to_string(),
            profiles: request.profiles.clone(),
            trajectory_id,
            source: TrajectorySource {
                implementation: "Morphz Runtime".to_string(),
                exporter_version: AGENT_TRAJECTORY_EXPORTER_VERSION.to_string(),
                authority_domain: format!("context:{}", request.context_id),
                first_sequence,
                last_sequence,
            },
            scope: TrajectoryScope {
                context_id: request.context_id,
                objective_id: request.objective_id,
                activation_id: request.activation_id,
                selection: "indexed Event causal scope".to_string(),
                event_count: events.len(),
            },
            completeness: TrajectoryCompleteness {
                status: completeness_status.to_string(),
                reason: completeness_reason.to_string(),
                material_omissions: if request.include_payloads {
                    Vec::new()
                } else {
                    vec!["raw Event payloads".to_string()]
                },
            },
            bindings: bindings
                .into_iter()
                .map(|(kind, values)| (kind, values.into_iter().collect()))
                .collect(),
            states: states.into_values().collect(),
            nodes,
            edges,
            outcomes,
            verifier_results,
            reward_records,
            transform: TrajectoryTransform {
                exporter: format!("morphz-at-exporter@{}", AGENT_TRAJECTORY_EXPORTER_VERSION),
                operations,
            },
            disclosure: TrajectoryDisclosure {
                private_reasoning: "not_collected".to_string(),
                user_content: if request.include_user_content {
                    "included".to_string()
                } else {
                    "redacted".to_string()
                },
                raw_event_payloads: if request.include_payloads {
                    "included_with_secret_redaction".to_string()
                } else {
                    "omitted".to_string()
                },
                redacted_fields: redacted_fields.into_iter().collect(),
            },
            rights: request.rights,
            integrity: unsigned_integrity(),
            extensions: BTreeMap::new(),
        };
        bundle.seal_integrity()?;
        Ok(bundle)
    }
}

impl AgentTrajectoryBundle {
    pub fn seal_integrity(&mut self) -> Result<(), String> {
        self.integrity = unsigned_integrity();
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        self.integrity = TrajectoryIntegrity {
            status: "digest_provided".to_string(),
            algorithm: "sha256".to_string(),
            canonicalization: "morphz-at-json-struct-order-v1".to_string(),
            digest: Some(format!("sha256:{:x}", Sha256::digest(bytes))),
        };
        Ok(())
    }

    pub fn verify(&self) -> TrajectoryVerificationReport {
        verify_bundle(self)
    }
}

pub fn verify_bundle(bundle: &AgentTrajectoryBundle) -> TrajectoryVerificationReport {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if bundle.spec_version != AGENT_TRAJECTORY_SPEC_VERSION {
        errors.push(format!(
            "unsupported spec_version '{}'",
            bundle.spec_version
        ));
    }
    if bundle.profiles.is_empty() {
        errors.push("profiles must not be empty".to_string());
    }
    let mut profiles = HashSet::new();
    for profile in &bundle.profiles {
        if !matches!(
            profile.as_str(),
            "AT-Core" | "AT-Evaluation" | "AT-Training"
        ) {
            errors.push(format!("unsupported Agent Trajectory profile '{profile}'"));
        }
        if !profiles.insert(profile.as_str()) {
            errors.push(format!("duplicate Agent Trajectory profile '{profile}'"));
        }
    }
    if bundle.scope.context_id.trim().is_empty() {
        errors.push("scope.context_id must not be empty".to_string());
    }
    if !matches!(
        bundle.completeness.status.as_str(),
        "complete" | "partial" | "open"
    ) {
        errors.push(format!(
            "unsupported completeness status '{}'",
            bundle.completeness.status
        ));
    }
    let mut node_ids = HashSet::new();
    let mut source_event_ids = HashSet::new();
    for node in &bundle.nodes {
        if !node_ids.insert(node.node_id.as_str()) {
            errors.push(format!("duplicate node_id '{}'", node.node_id));
        }
        if !source_event_ids.insert(node.source_event_id.as_str()) {
            errors.push(format!(
                "duplicate source_event_id '{}'",
                node.source_event_id
            ));
        }
    }
    let mut state_ids = HashSet::new();
    for state in &bundle.states {
        if !state_ids.insert(state.state_id.as_str()) {
            errors.push(format!("duplicate state_id '{}'", state.state_id));
        }
        if state.context_id != bundle.scope.context_id {
            errors.push(format!(
                "state '{}' belongs to Context '{}' outside Bundle scope '{}'",
                state.state_id, state.context_id, bundle.scope.context_id
            ));
        }
        if !source_event_ids.contains(state.source_event_id.as_str()) {
            errors.push(format!(
                "state '{}' references unknown source Event '{}'",
                state.state_id, state.source_event_id
            ));
        }
    }
    for node in &bundle.nodes {
        for state_id in [node.state_before.as_deref(), node.state_after.as_deref()]
            .into_iter()
            .flatten()
        {
            if !state_ids.contains(state_id) {
                errors.push(format!(
                    "node '{}' references unknown State '{}'",
                    node.node_id, state_id
                ));
            }
        }
    }
    let mut adjacency = HashMap::<&str, Vec<&str>>::new();
    let mut edge_ids = HashSet::new();
    for edge in &bundle.edges {
        if !edge_ids.insert(edge.edge_id.as_str()) {
            errors.push(format!("duplicate edge_id '{}'", edge.edge_id));
        }
        if !node_ids.contains(edge.from.as_str()) || !node_ids.contains(edge.to.as_str()) {
            errors.push(format!(
                "edge '{}' references an unknown node",
                edge.edge_id
            ));
        } else {
            adjacency
                .entry(edge.from.as_str())
                .or_default()
                .push(edge.to.as_str());
        }
    }
    if causal_graph_has_cycle(&node_ids, &adjacency) {
        errors.push("causal graph contains a cycle".to_string());
    }
    let mut outcome_ids = HashSet::new();
    let mut source_fact_ids = HashSet::new();
    for outcome in &bundle.outcomes {
        if !outcome_ids.insert(outcome.outcome_id.as_str()) {
            errors.push(format!("duplicate outcome_id '{}'", outcome.outcome_id));
        }
        if !node_ids.contains(outcome.asserted_at_node.as_str()) {
            errors.push(format!(
                "Outcome '{}' references unknown assertion Node '{}'",
                outcome.outcome_id, outcome.asserted_at_node
            ));
        }
        source_fact_ids.insert(outcome.outcome_id.as_str());
        if let Some(source_event_id) = outcome.asserted_at_node.strip_prefix("event:") {
            source_fact_ids.insert(source_event_id);
        }
    }
    let mut verifier_ids = HashSet::new();
    for result in &bundle.verifier_results {
        if !verifier_ids.insert(result.verifier_result_id.as_str()) {
            errors.push(format!(
                "duplicate verifier_result_id '{}'",
                result.verifier_result_id
            ));
        }
        if !node_ids.contains(result.asserted_at_node.as_str()) {
            errors.push(format!(
                "Verifier Result '{}' references unknown assertion Node '{}'",
                result.verifier_result_id, result.asserted_at_node
            ));
        }
        source_fact_ids.insert(result.verifier_result_id.as_str());
    }
    let mut reward_ids = HashSet::new();
    for reward in &bundle.reward_records {
        if !reward_ids.insert(reward.reward_id.as_str()) {
            errors.push(format!("duplicate reward_id '{}'", reward.reward_id));
        }
        source_fact_ids.insert(reward.reward_id.as_str());
    }
    for reward in &bundle.reward_records {
        for source in &reward.sources {
            if !source_fact_ids.contains(source.as_str()) {
                errors.push(format!(
                    "Reward Record '{}' references unknown source fact '{}'",
                    reward.reward_id, source
                ));
            }
        }
    }
    let reward_nodes = reward_ids.iter().copied().collect::<HashSet<_>>();
    let reward_adjacency = bundle
        .reward_records
        .iter()
        .map(|reward| {
            (
                reward.reward_id.as_str(),
                reward
                    .sources
                    .iter()
                    .map(String::as_str)
                    .filter(|source| reward_nodes.contains(source))
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<HashMap<_, _>>();
    if causal_graph_has_cycle(&reward_nodes, &reward_adjacency) {
        errors.push("Reward Record dependency graph contains a cycle".to_string());
    }
    if bundle.completeness.status == "complete"
        && bundle
            .nodes
            .iter()
            .any(|node| !node.external_parents.is_empty())
    {
        warnings.push(
            "complete Bundle contains external parents; verify causal-closure qualification"
                .to_string(),
        );
    }
    if bundle.rights.training
        && !bundle
            .profiles
            .iter()
            .any(|profile| profile == "AT-Training")
    {
        warnings.push("training right is granted without an AT-Training profile".to_string());
    }
    match bundle.integrity.status.as_str() {
        "not_provided" => {
            if bundle.integrity.digest.is_some() {
                errors.push("integrity status is not_provided but digest is present".to_string());
            } else {
                warnings.push("Bundle does not provide an integrity digest".to_string());
            }
        }
        "digest_provided" => {
            if bundle.integrity.algorithm != "sha256"
                || bundle.integrity.canonicalization != "morphz-at-json-struct-order-v1"
            {
                errors.push("unsupported integrity algorithm or canonicalization".to_string());
            } else {
                match expected_digest(bundle) {
                    Ok(expected)
                        if bundle.integrity.digest.as_deref() != Some(expected.as_str()) =>
                    {
                        errors.push("integrity digest mismatch".to_string());
                    }
                    Err(error) => errors.push(error),
                    _ => {}
                }
            }
        }
        other => errors.push(format!("unsupported integrity status '{other}'")),
    }
    TrajectoryVerificationReport {
        valid: errors.is_empty(),
        errors,
        warnings,
        node_count: bundle.nodes.len(),
        edge_count: bundle.edges.len(),
    }
}

fn validate_request(request: &TrajectoryExportRequest) -> Result<(), String> {
    if request.context_id.trim().is_empty() {
        return Err("Trajectory export requires a non-empty context_id".to_string());
    }
    if request.max_events == 0 || request.max_events > 100_000 {
        return Err("Trajectory max_events must be between 1 and 100000".to_string());
    }
    if request.profiles.is_empty() {
        return Err("Trajectory export requires at least one conformance profile".to_string());
    }
    for profile in &request.profiles {
        if !matches!(
            profile.as_str(),
            "AT-Core" | "AT-Evaluation" | "AT-Training"
        ) {
            return Err(format!("unsupported Agent Trajectory profile '{profile}'"));
        }
    }
    Ok(())
}

fn node_id(event_id: &str) -> String {
    format!("event:{event_id}")
}

fn edge(from: &str, to: &str, relation: &str) -> TrajectoryEdge {
    TrajectoryEdge {
        edge_id: format!("edge:{relation}:{from}:{to}"),
        from: node_id(from),
        to: node_id(to),
        relation: relation.to_string(),
    }
}

fn causal_fields() -> &'static [(&'static str, &'static str)] {
    &[
        ("caused_by", "caused_by"),
        ("source_event_id", "caused_by"),
        ("trigger_event_id", "triggered_by"),
        ("parent_event_id", "caused_by"),
    ]
}

fn node_kind(event: &Event) -> &'static str {
    match (event.event_type.as_str(), event.topic.as_str()) {
        (_, "runtime/yao/evidence") => "evidence",
        (_, "runtime/yao/outcome") => "outcome",
        (_, "runtime/trajectory/verifier_result") => "verification",
        (_, "runtime/trajectory/reward") => "reward",
        (_, "chat/context_tx_committed") => "state_transaction",
        (_, topic) if topic.starts_with("objective/") => "objective_transition",
        ("agent_call", _) => "decision",
        ("tool_output", _) => "observation",
        ("infer_request", _) => "evaluation_request",
        ("proposal", _) => "effect_receipt",
        ("user_message", _) => "input",
        _ => "event",
    }
}

fn event_status(event: &Event) -> &str {
    event
        .payload
        .get("status")
        .or_else(|| event.payload.get("tool_status"))
        .and_then(JsonValue::as_str)
        .unwrap_or("committed")
}

fn authority_class(actor: &str) -> &'static str {
    let lowercase = actor.to_ascii_lowercase();
    if lowercase.contains("runtime") || lowercase.starts_with("system-") {
        "runtime"
    } else if lowercase.contains("agent") {
        "agent"
    } else if lowercase.contains("user") || lowercase.contains("principal") {
        "principal"
    } else {
        "external_or_unspecified"
    }
}

fn collect_context_states(
    event: &Event,
    states: &mut BTreeMap<u64, TrajectoryState>,
) -> (Option<String>, Option<String>) {
    let context_id = event
        .payload
        .get("context_id")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let before = event
        .payload
        .get("before_version")
        .or_else(|| event.payload.get("before_revision"))
        .and_then(JsonValue::as_u64);
    let after = event
        .payload
        .get("after_version")
        .or_else(|| event.payload.get("after_revision"))
        .and_then(JsonValue::as_u64);
    let visible = event
        .payload
        .get("context_snapshot_version")
        .and_then(JsonValue::as_u64);
    for revision in [before, after, visible].into_iter().flatten() {
        states.entry(revision).or_insert_with(|| TrajectoryState {
            state_id: format!("context:{context_id}@{revision}"),
            context_id: context_id.to_string(),
            context_revision: revision,
            availability: "referenced".to_string(),
            source_event_id: event.id.clone(),
            delta: (after == Some(revision))
                .then(|| event.payload.get("changes").cloned())
                .flatten(),
        });
    }
    (
        before.or(visible).map(|revision| {
            states
                .get(&revision)
                .expect("inserted state")
                .state_id
                .clone()
        }),
        after.map(|revision| {
            states
                .get(&revision)
                .expect("inserted state")
                .state_id
                .clone()
        }),
    )
}

fn outcome_from_event(event: &Event) -> Option<TrajectoryOutcome> {
    if event.topic != "runtime/yao/outcome" {
        return None;
    }
    let candidate = event
        .payload
        .get("arguments")?
        .as_object()?
        .get("candidate")?;
    let candidate = crate::yao::outcome_candidate_view(candidate)?;
    Some(TrajectoryOutcome {
        outcome_id: format!("outcome:{}", event.id),
        scope: event
            .payload
            .get("objective_id")
            .or_else(|| event.payload.get("plan_execution_id"))
            .and_then(JsonValue::as_str)
            .unwrap_or(&event.id)
            .to_string(),
        producer: event.actor.clone(),
        authority_class: "agent_claim_runtime_committed".to_string(),
        status: candidate.status.to_string(),
        terminal: candidate.status != "blocked",
        evidence_refs: candidate
            .evidence
            .iter()
            .filter_map(crate::yao::reference_view)
            .map(|(_, id)| id.to_string())
            .collect(),
        asserted_at_node: node_id(&event.id),
        value: Some(candidate.value.clone()),
    })
}

fn verifier_result_from_event(event: &Event) -> Option<VerifierResult> {
    if event.topic != "runtime/trajectory/verifier_result" {
        return None;
    }
    Some(VerifierResult {
        verifier_result_id: event.id.clone(),
        verifier: event.payload.get("verifier")?.as_str()?.to_string(),
        verifier_version: event.payload.get("verifier_version")?.as_str()?.to_string(),
        checked_property: event.payload.get("checked_property")?.as_str()?.to_string(),
        evidence_refs: event
            .payload
            .get("evidence_refs")?
            .as_array()?
            .iter()
            .filter_map(JsonValue::as_str)
            .map(str::to_string)
            .collect(),
        status: event.payload.get("status")?.as_str()?.to_string(),
        output: event
            .payload
            .get("output")
            .cloned()
            .unwrap_or(JsonValue::Null),
        asserted_at_node: node_id(&event.id),
    })
}

fn reward_record_from_event(event: &Event) -> Option<RewardRecord> {
    if event.topic != "runtime/trajectory/reward" {
        return None;
    }
    Some(RewardRecord {
        reward_id: event.id.clone(),
        policy: event.payload.get("policy")?.as_str()?.to_string(),
        policy_version: event.payload.get("policy_version")?.as_str()?.to_string(),
        sources: event
            .payload
            .get("sources")?
            .as_array()?
            .iter()
            .filter_map(JsonValue::as_str)
            .map(str::to_string)
            .collect(),
        scope: event.payload.get("scope")?.as_str()?.to_string(),
        attribution_target: event
            .payload
            .get("attribution_target")?
            .as_str()?
            .to_string(),
        signal_type: event.payload.get("signal_type")?.as_str()?.to_string(),
        value: event
            .payload
            .get("value")
            .cloned()
            .unwrap_or(JsonValue::Null),
        aggregation: event.payload.get("aggregation")?.as_str()?.to_string(),
        producer: event.actor.clone(),
        created_at: event.timestamp,
        timing: event.payload.get("timing")?.as_str()?.to_string(),
    })
}

pub(crate) fn verifier_result_event(input: &CommitVerifierResult) -> Result<Event, String> {
    for (name, value) in [
        ("context_id", input.context_id.as_str()),
        ("verifier", input.verifier.as_str()),
        ("verifier_version", input.verifier_version.as_str()),
        ("checked_property", input.checked_property.as_str()),
        ("producer", input.producer.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Verifier Result {name} must not be empty"));
        }
    }
    if !matches!(
        input.status.as_str(),
        "pass" | "fail" | "indeterminate" | "error" | "invalidated"
    ) {
        return Err(format!(
            "unsupported Verifier Result status '{}'",
            input.status
        ));
    }
    let id = stable_fact_id("verifier", input)?;
    let mut payload = JsonMap::from_iter([
        (
            "context_id".to_string(),
            JsonValue::String(input.context_id.clone()),
        ),
        (
            "verifier".to_string(),
            JsonValue::String(input.verifier.clone()),
        ),
        (
            "verifier_version".to_string(),
            JsonValue::String(input.verifier_version.clone()),
        ),
        (
            "checked_property".to_string(),
            JsonValue::String(input.checked_property.clone()),
        ),
        (
            "evidence_refs".to_string(),
            JsonValue::Array(
                input
                    .evidence_refs
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        ),
        (
            "status".to_string(),
            JsonValue::String(input.status.clone()),
        ),
        ("output".to_string(), input.output.clone()),
    ]);
    if let Some(session_id) = &input.session_id {
        payload.insert(
            "session_id".to_string(),
            JsonValue::String(session_id.clone()),
        );
    }
    if let Some(objective_id) = &input.objective_id {
        payload.insert(
            "objective_id".to_string(),
            JsonValue::String(objective_id.clone()),
        );
    }
    Ok(Event::new(
        id,
        input.producer.clone(),
        "verifier_result".to_string(),
        "runtime/trajectory/verifier_result".to_string(),
        payload,
    ))
}

pub(crate) fn reward_record_event(input: &CommitRewardRecord) -> Result<Event, String> {
    for (name, value) in [
        ("context_id", input.context_id.as_str()),
        ("policy", input.policy.as_str()),
        ("policy_version", input.policy_version.as_str()),
        ("scope", input.scope.as_str()),
        ("attribution_target", input.attribution_target.as_str()),
        ("signal_type", input.signal_type.as_str()),
        ("aggregation", input.aggregation.as_str()),
        ("producer", input.producer.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Reward Record {name} must not be empty"));
        }
    }
    if !matches!(input.timing.as_str(), "online" | "retrospective") {
        return Err("Reward Record timing must be online or retrospective".to_string());
    }
    if input.sources.is_empty() {
        return Err("Reward Record requires at least one source fact".to_string());
    }
    let id = stable_fact_id("reward", input)?;
    let mut payload = JsonMap::from_iter([
        (
            "context_id".to_string(),
            JsonValue::String(input.context_id.clone()),
        ),
        (
            "policy".to_string(),
            JsonValue::String(input.policy.clone()),
        ),
        (
            "policy_version".to_string(),
            JsonValue::String(input.policy_version.clone()),
        ),
        (
            "sources".to_string(),
            JsonValue::Array(
                input
                    .sources
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        ),
        ("scope".to_string(), JsonValue::String(input.scope.clone())),
        (
            "attribution_target".to_string(),
            JsonValue::String(input.attribution_target.clone()),
        ),
        (
            "signal_type".to_string(),
            JsonValue::String(input.signal_type.clone()),
        ),
        ("value".to_string(), input.value.clone()),
        (
            "aggregation".to_string(),
            JsonValue::String(input.aggregation.clone()),
        ),
        (
            "timing".to_string(),
            JsonValue::String(input.timing.clone()),
        ),
    ]);
    if let Some(session_id) = &input.session_id {
        payload.insert(
            "session_id".to_string(),
            JsonValue::String(session_id.clone()),
        );
    }
    if let Some(objective_id) = &input.objective_id {
        payload.insert(
            "objective_id".to_string(),
            JsonValue::String(objective_id.clone()),
        );
    }
    Ok(Event::new(
        id,
        input.producer.clone(),
        "reward_record".to_string(),
        "runtime/trajectory/reward".to_string(),
        payload,
    ))
}

fn stable_fact_id<T: Serialize>(namespace: &str, value: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    Ok(format!("at_{namespace}_{:x}", Sha256::digest(bytes)))
}

pub fn derive_training_episode(bundle: &AgentTrajectoryBundle) -> Result<TrainingEpisode, String> {
    if !bundle
        .profiles
        .iter()
        .any(|profile| profile == "AT-Training")
    {
        return Err("training Episode requires an AT-Training Bundle".to_string());
    }
    if !bundle.rights.training {
        return Err("Bundle rights do not permit training use".to_string());
    }
    let nodes = bundle
        .nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<&str, Vec<&TrajectoryNode>>::new();
    for edge in &bundle.edges {
        if let Some(child) = nodes.get(edge.to.as_str()) {
            children.entry(edge.from.as_str()).or_default().push(child);
        }
    }
    let mut transitions = Vec::new();
    for node in bundle
        .nodes
        .iter()
        .filter(|node| matches!(node.kind.as_str(), "decision" | "effect_receipt"))
    {
        let Some(state_before) = node.state_before.as_ref() else {
            continue;
        };
        let payload = node.payload.clone().ok_or_else(|| {
            format!(
                "training target node '{}' omitted its payload",
                node.node_id
            )
        })?;
        let environment_outputs = children
            .get(node.node_id.as_str())
            .into_iter()
            .flatten()
            .map(|child| TrainingField {
                role: "environment_output".to_string(),
                loss: "excluded".to_string(),
                availability: if child.payload.is_some() {
                    "included".to_string()
                } else {
                    "metadata_only".to_string()
                },
                value: child.payload.clone().unwrap_or_else(
                    || serde_json::json!({"source_node_id": child.node_id, "status": child.status}),
                ),
            })
            .collect::<Vec<_>>();
        let reward_refs = bundle
            .reward_records
            .iter()
            .filter(|reward| {
                reward.attribution_target == node.node_id
                    || reward.attribution_target == node.source_event_id
            })
            .map(|reward| reward.reward_id.clone())
            .collect();
        transitions.push(TrainingTransition {
            transition_id: format!("transition:{}", node.node_id),
            source_node_id: node.node_id.clone(),
            state_view: TrainingField {
                role: "model_input".to_string(),
                loss: "excluded".to_string(),
                availability: "referenced".to_string(),
                value: JsonValue::String(state_before.clone()),
            },
            action_target: TrainingField {
                role: "supervised_target".to_string(),
                loss: "included".to_string(),
                availability: "included".to_string(),
                value: payload,
            },
            environment_outputs,
            reward_refs,
        });
    }
    if transitions.is_empty() {
        return Err(
            "Bundle contains no decision/effect target with an exact State View reference"
                .to_string(),
        );
    }
    let episode_id = format!(
        "episode:{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                bundle.trajectory_id.as_str(),
                transitions
                    .iter()
                    .map(|transition| transition.source_node_id.as_str())
                    .collect::<Vec<_>>(),
            ))
            .map_err(|error| error.to_string())?
        )
    );
    let mut episode = TrainingEpisode {
        episode_version: "0.1".to_string(),
        episode_id,
        source_trajectory_id: bundle.trajectory_id.clone(),
        selection: "all decision/effect targets with exact State View references".to_string(),
        termination: bundle.completeness.status.clone(),
        transitions,
        reward_refs: bundle
            .reward_records
            .iter()
            .map(|reward| reward.reward_id.clone())
            .collect(),
        rights: bundle.rights.clone(),
        integrity: unsigned_integrity(),
    };
    seal_episode(&mut episode)?;
    Ok(episode)
}

impl TrainingEpisode {
    pub fn verify(&self) -> TrainingEpisodeVerificationReport {
        verify_training_episode(self)
    }
}

pub fn verify_training_episode(episode: &TrainingEpisode) -> TrainingEpisodeVerificationReport {
    let mut errors = Vec::new();
    if episode.episode_version != "0.1" {
        errors.push(format!(
            "unsupported episode_version '{}'",
            episode.episode_version
        ));
    }
    if !episode.rights.training {
        errors.push("Training Episode rights do not permit training use".to_string());
    }
    if episode.transitions.is_empty() {
        errors.push("Training Episode must contain at least one transition".to_string());
    }
    let reward_refs = episode
        .reward_refs
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut transition_ids = HashSet::new();
    let mut source_node_ids = HashSet::new();
    for transition in &episode.transitions {
        if !transition_ids.insert(transition.transition_id.as_str()) {
            errors.push(format!(
                "duplicate Training transition_id '{}'",
                transition.transition_id
            ));
        }
        if !source_node_ids.insert(transition.source_node_id.as_str()) {
            errors.push(format!(
                "duplicate Training source_node_id '{}'",
                transition.source_node_id
            ));
        }
        verify_training_field(
            &transition.transition_id,
            "state_view",
            &transition.state_view,
            "model_input",
            "excluded",
            &mut errors,
        );
        verify_training_field(
            &transition.transition_id,
            "action_target",
            &transition.action_target,
            "supervised_target",
            "included",
            &mut errors,
        );
        for output in &transition.environment_outputs {
            verify_training_field(
                &transition.transition_id,
                "environment_output",
                output,
                "environment_output",
                "excluded",
                &mut errors,
            );
        }
        for reward_ref in &transition.reward_refs {
            if !reward_refs.contains(reward_ref.as_str()) {
                errors.push(format!(
                    "Training transition '{}' references unknown Reward '{}'",
                    transition.transition_id, reward_ref
                ));
            }
        }
    }
    if episode.integrity.status != "digest_provided"
        || episode.integrity.algorithm != "sha256"
        || episode.integrity.canonicalization != "morphz-at-json-struct-order-v1"
    {
        errors.push("Training Episode requires the supported integrity digest profile".to_string());
    } else {
        match expected_episode_digest(episode) {
            Ok(expected) if episode.integrity.digest.as_deref() != Some(expected.as_str()) => {
                errors.push("Training Episode integrity digest mismatch".to_string());
            }
            Err(error) => errors.push(error),
            _ => {}
        }
    }
    TrainingEpisodeVerificationReport {
        valid: errors.is_empty(),
        errors,
        transition_count: episode.transitions.len(),
    }
}

fn verify_training_field(
    transition_id: &str,
    field_name: &str,
    field: &TrainingField,
    expected_role: &str,
    expected_loss: &str,
    errors: &mut Vec<String>,
) {
    if field.role != expected_role || field.loss != expected_loss {
        errors.push(format!(
            "Training transition '{transition_id}' {field_name} requires role '{expected_role}' and loss '{expected_loss}'"
        ));
    }
    if field.availability.trim().is_empty() {
        errors.push(format!(
            "Training transition '{transition_id}' {field_name} availability must not be empty"
        ));
    }
}

fn seal_episode(episode: &mut TrainingEpisode) -> Result<(), String> {
    episode.integrity = unsigned_integrity();
    let bytes = serde_json::to_vec(episode).map_err(|error| error.to_string())?;
    episode.integrity = TrajectoryIntegrity {
        status: "digest_provided".to_string(),
        algorithm: "sha256".to_string(),
        canonicalization: "morphz-at-json-struct-order-v1".to_string(),
        digest: Some(format!("sha256:{:x}", Sha256::digest(bytes))),
    };
    Ok(())
}

fn expected_episode_digest(episode: &TrainingEpisode) -> Result<String, String> {
    let mut unsigned = episode.clone();
    unsigned.integrity = unsigned_integrity();
    let bytes = serde_json::to_vec(&unsigned).map_err(|error| error.to_string())?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn collect_bindings(event: &Event, bindings: &mut BTreeMap<String, BTreeSet<String>>) {
    for (field, kind) in [
        ("agent_id", "agents"),
        ("context_id", "contexts"),
        ("session_id", "sessions"),
        ("objective_id", "objectives"),
        ("activation_id", "activations"),
        ("thread_id", "threads"),
        ("plan_execution_id", "program_executions"),
        ("harness_id", "harnesses"),
        ("model", "models"),
        ("target_id", "execution_targets"),
    ] {
        if let Some(value) = event.payload.get(field).and_then(JsonValue::as_str) {
            bindings
                .entry(kind.to_string())
                .or_default()
                .insert(value.to_string());
        }
    }
}

fn redact_payload(
    event: &Event,
    include_user_content: bool,
    redacted_fields: &mut BTreeSet<String>,
) -> JsonValue {
    let mut value = JsonValue::Object(event.payload.clone());
    redact_value(&mut value, "payload", redacted_fields);
    if !include_user_content && event.event_type == "user_message" {
        if let Some(object) = value.as_object_mut() {
            for field in ["text", "content", "message"] {
                if object.contains_key(field) {
                    object.insert(
                        field.to_string(),
                        JsonValue::String("[REDACTED]".to_string()),
                    );
                    redacted_fields.insert(format!("payload.{field}"));
                }
            }
        }
    }
    value
}

fn redact_value(value: &mut JsonValue, path: &str, redacted_fields: &mut BTreeSet<String>) {
    match value {
        JsonValue::Object(object) => {
            for (key, child) in object.iter_mut() {
                let child_path = format!("{path}.{key}");
                if sensitive_key(key) {
                    *child = JsonValue::String("[REDACTED]".to_string());
                    redacted_fields.insert(child_path);
                } else {
                    redact_value(child, &child_path, redacted_fields);
                }
            }
        }
        JsonValue::Array(items) => {
            for (index, child) in items.iter_mut().enumerate() {
                redact_value(child, &format!("{path}[{index}]"), redacted_fields);
            }
        }
        _ => {}
    }
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "authorization"
            | "api_key"
            | "apikey"
            | "access_token"
            | "refresh_token"
            | "password"
            | "cookie"
            | "private_key"
            | "client_secret"
            | "credential"
            | "credentials"
    )
}

fn stable_trajectory_id(
    request: &TrajectoryExportRequest,
    events: &[Event],
) -> Result<String, String> {
    let material = serde_json::to_vec(&(
        &request.context_id,
        &request.objective_id,
        &request.activation_id,
        request.start_time,
        request.end_time,
        events.iter().map(|event| &event.id).collect::<Vec<_>>(),
    ))
    .map_err(|error| error.to_string())?;
    Ok(format!("at:morphz:{:x}", Sha256::digest(material)))
}

fn unsigned_integrity() -> TrajectoryIntegrity {
    TrajectoryIntegrity {
        status: "not_provided".to_string(),
        algorithm: "sha256".to_string(),
        canonicalization: "morphz-at-json-struct-order-v1".to_string(),
        digest: None,
    }
}

fn expected_digest(bundle: &AgentTrajectoryBundle) -> Result<String, String> {
    let mut unsigned = bundle.clone();
    unsigned.integrity = unsigned_integrity();
    let bytes = serde_json::to_vec(&unsigned).map_err(|error| error.to_string())?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn causal_graph_has_cycle<'a>(
    nodes: &HashSet<&'a str>,
    adjacency: &HashMap<&'a str, Vec<&'a str>>,
) -> bool {
    fn visit<'a>(
        node: &'a str,
        adjacency: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> bool {
        if visited.contains(node) {
            return false;
        }
        if !visiting.insert(node) {
            return true;
        }
        if adjacency.get(node).is_some_and(|children| {
            children
                .iter()
                .any(|child| visit(child, adjacency, visiting, visited))
        }) {
            return true;
        }
        visiting.remove(node);
        visited.insert(node);
        false
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    nodes
        .iter()
        .copied()
        .any(|node| visit(node, adjacency, &mut visiting, &mut visited))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn event(
        id: &str,
        sequence: u64,
        event_type: &str,
        topic: &str,
        payload: JsonMap<String, JsonValue>,
    ) -> Event {
        Event {
            id: id.to_string(),
            sequence: Some(sequence),
            timestamp: Utc.timestamp_opt(sequence as i64, 0).unwrap(),
            actor: "Runtime-Test".to_string(),
            event_type: event_type.to_string(),
            topic: topic.to_string(),
            payload,
        }
    }

    #[test]
    fn exporter_preserves_causality_redacts_secrets_and_seals_integrity() {
        let first = event(
            "input-1",
            1,
            "user_message",
            "chat/user",
            serde_json::json!({
                "context_id": "context-a",
                "text": "private request",
                "api_key": "secret"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let second = event(
            "tx-1",
            2,
            "context_transaction",
            "chat/context_tx_committed",
            serde_json::json!({
                "context_id": "context-a",
                "source_event_id": "input-1",
                "before_version": 0,
                "after_version": 1,
                "changes": [{"kind": "create", "id": "fact-a"}]
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let bundle = AgentTrajectoryExporter::export_events(
            TrajectoryExportRequest {
                context_id: "context-a".to_string(),
                objective_id: None,
                activation_id: None,
                start_time: None,
                end_time: None,
                max_events: 100,
                profiles: vec!["AT-Core".to_string()],
                include_payloads: true,
                include_user_content: false,
                rights: TrajectoryRights::default(),
            },
            vec![second, first],
        )
        .unwrap();
        assert_eq!(bundle.nodes[0].source_event_id, "input-1");
        assert_eq!(bundle.edges.len(), 1);
        assert_eq!(bundle.edges[0].relation, "caused_by");
        assert_eq!(bundle.states.len(), 2);
        assert_eq!(
            bundle.nodes[0].payload.as_ref().unwrap()["text"],
            "[REDACTED]"
        );
        assert_eq!(
            bundle.nodes[0].payload.as_ref().unwrap()["api_key"],
            "[REDACTED]"
        );
        assert!(bundle.verify().valid);

        let mut unsigned = bundle;
        unsigned.integrity = unsigned_integrity();
        let report = unsigned.verify();
        assert!(report.valid);
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("does not provide")));
    }

    #[test]
    fn verifier_rejects_tampering_and_causal_cycles() {
        let mut bundle = AgentTrajectoryExporter::export_events(
            TrajectoryExportRequest {
                context_id: "context-a".to_string(),
                objective_id: None,
                activation_id: None,
                start_time: None,
                end_time: None,
                max_events: 100,
                profiles: vec!["AT-Core".to_string()],
                include_payloads: true,
                include_user_content: true,
                rights: TrajectoryRights::default(),
            },
            vec![
                event(
                    "a",
                    1,
                    "event",
                    "test/a",
                    serde_json::json!({"context_id": "context-a"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                event(
                    "b",
                    2,
                    "event",
                    "test/b",
                    serde_json::json!({"context_id": "context-a", "caused_by": "a"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            ],
        )
        .unwrap();
        bundle.edges.push(TrajectoryEdge {
            edge_id: "edge:cycle".to_string(),
            from: "event:b".to_string(),
            to: "event:a".to_string(),
            relation: "caused_by".to_string(),
        });
        let report = bundle.verify();
        assert!(!report.valid);
        assert!(report.errors.iter().any(|error| error.contains("cycle")));
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("digest mismatch")));
    }

    #[test]
    fn verifier_rejects_broken_state_and_interpretation_references() {
        let mut bundle = AgentTrajectoryExporter::export_events(
            TrajectoryExportRequest {
                context_id: "context-a".to_string(),
                objective_id: None,
                activation_id: None,
                start_time: None,
                end_time: None,
                max_events: 100,
                profiles: vec!["AT-Core".to_string()],
                include_payloads: true,
                include_user_content: true,
                rights: TrajectoryRights::default(),
            },
            vec![event(
                "fact-1",
                1,
                "event",
                "test/fact",
                serde_json::json!({"context_id": "context-a"})
                    .as_object()
                    .unwrap()
                    .clone(),
            )],
        )
        .unwrap();
        bundle.nodes[0].state_after = Some("context:context-a@99".to_string());
        bundle.outcomes.push(TrajectoryOutcome {
            outcome_id: "outcome:missing".to_string(),
            scope: "test".to_string(),
            producer: "test".to_string(),
            authority_class: "runtime".to_string(),
            status: "succeeded".to_string(),
            terminal: true,
            evidence_refs: Vec::new(),
            asserted_at_node: "event:missing".to_string(),
            value: None,
        });
        bundle.reward_records.push(RewardRecord {
            reward_id: "reward:broken".to_string(),
            policy: "test".to_string(),
            policy_version: "1".to_string(),
            sources: vec!["verifier:missing".to_string()],
            scope: "test".to_string(),
            attribution_target: "fact-1".to_string(),
            signal_type: "scalar".to_string(),
            value: serde_json::json!(0),
            aggregation: "identity".to_string(),
            producer: "test".to_string(),
            created_at: Utc.timestamp_opt(2, 0).unwrap(),
            timing: "retrospective".to_string(),
        });
        bundle.seal_integrity().unwrap();

        let report = bundle.verify();
        assert!(!report.valid);
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("unknown State")));
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("unknown assertion Node")));
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("unknown source fact")));
        assert!(!report
            .errors
            .iter()
            .any(|error| error.contains("digest mismatch")));
    }

    #[test]
    fn verifier_reward_and_training_episode_form_a_permissioned_loop() {
        let evidence = event(
            "evidence-1",
            1,
            "evidence",
            "runtime/yao/evidence",
            serde_json::json!({"context_id": "context-a"})
                .as_object()
                .unwrap()
                .clone(),
        );
        let mut decision = event(
            "decision-1",
            2,
            "agent_call",
            "chat/agent_call",
            serde_json::json!({
                "context_id": "context-a",
                "context_snapshot_version": 7,
                "text": "structured action"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        decision.actor = "Agent-Morphz".to_string();
        let observation = event(
            "observation-1",
            3,
            "tool_output",
            "chat/tool_output",
            serde_json::json!({
                "context_id": "context-a",
                "caused_by": "decision-1",
                "tool_status": "succeeded",
                "text": "done"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let mut verifier = verifier_result_event(&CommitVerifierResult {
            context_id: "context-a".to_string(),
            session_id: None,
            objective_id: None,
            verifier: "repo-tests".to_string(),
            verifier_version: "1".to_string(),
            checked_property: "tests pass".to_string(),
            evidence_refs: vec!["evidence-1".to_string()],
            status: "pass".to_string(),
            output: serde_json::json!({"passed": 42}),
            producer: "Verifier-Tests".to_string(),
        })
        .unwrap();
        verifier.sequence = Some(4);
        verifier.timestamp = Utc.timestamp_opt(4, 0).unwrap();
        let mut reward = reward_record_event(&CommitRewardRecord {
            context_id: "context-a".to_string(),
            session_id: None,
            objective_id: None,
            policy: "test-pass".to_string(),
            policy_version: "1".to_string(),
            sources: vec![verifier.id.clone()],
            scope: "decision-1".to_string(),
            attribution_target: "decision-1".to_string(),
            signal_type: "scalar".to_string(),
            value: serde_json::json!(1.0),
            aggregation: "identity".to_string(),
            producer: "RewardPolicy-Test".to_string(),
            timing: "retrospective".to_string(),
        })
        .unwrap();
        reward.sequence = Some(5);
        reward.timestamp = Utc.timestamp_opt(5, 0).unwrap();

        let bundle = AgentTrajectoryExporter::export_events(
            TrajectoryExportRequest {
                context_id: "context-a".to_string(),
                objective_id: None,
                activation_id: None,
                start_time: None,
                end_time: None,
                max_events: 100,
                profiles: vec!["AT-Core".to_string(), "AT-Training".to_string()],
                include_payloads: true,
                include_user_content: false,
                rights: TrajectoryRights {
                    training: true,
                    ..TrajectoryRights::default()
                },
            },
            vec![evidence, decision, observation, verifier, reward],
        )
        .unwrap();
        assert_eq!(bundle.verifier_results.len(), 1);
        assert_eq!(bundle.reward_records.len(), 1);
        let episode = derive_training_episode(&bundle).unwrap();
        assert_eq!(episode.transitions.len(), 1);
        assert_eq!(episode.transitions[0].state_view.role, "model_input");
        assert_eq!(episode.transitions[0].action_target.loss, "included");
        assert_eq!(episode.transitions[0].environment_outputs.len(), 1);
        assert_eq!(episode.transitions[0].reward_refs.len(), 1);
        assert!(episode.verify().valid);

        let mut tampered_episode = episode;
        tampered_episode.transitions[0].action_target.loss = "excluded".to_string();
        let report = tampered_episode.verify();
        assert!(!report.valid);
        assert!(report.errors.iter().any(|error| error.contains("loss")));
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("digest mismatch")));

        let mut prohibited = bundle;
        prohibited.rights.training = false;
        assert!(derive_training_episode(&prohibited)
            .unwrap_err()
            .contains("do not permit"));
    }
}
