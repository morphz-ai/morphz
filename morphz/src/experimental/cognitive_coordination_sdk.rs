use crate::event::Event;
use crate::identity::PrincipalAssertion;
use crate::memory::MessageDispatchMode;
use crate::sdk::{MorphzSdk, SendMessageCommand, SessionEventsQuery};
use async_trait::async_trait;
use morphz_cognitive_coordination::{
    stable_digest, verify_commit_certificate, AuthorityDomain, CognitiveEvaluationRequest,
    CognitiveEvaluationTransport, CommitCertificate, CoordinationError, CoordinationResult,
    EvaluationAssignment, ParticipantDescriptor, ProjectionSnapshot, ProposalDraft,
    UnionCommitIntent, UnionCommitReceipt, UnionCommitter,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

use super::{ExperimentalFeaturePermit, COGNITIVE_COORDINATION};

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const COORDINATE_TOOL_NAME: &str = super::COGNITIVE_COORDINATION_TOOL_NAME;
/// Actor reserved for Runtime-created participant Evaluations. A Context may
/// require coordination for ordinary user turns, but these child requests are
/// already inside that coordination boundary and must never recursively open
/// another network evaluation.
pub const COORDINATION_PARTICIPANT_ACTOR: &str = super::COGNITIVE_COORDINATION_PARTICIPANT_ACTOR;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatedEvaluationInput {
    pub operation: String,
    pub question: String,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub shared_input: Value,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub preferred_capabilities: Vec<String>,
    #[serde(default)]
    pub min_participants: Option<usize>,
    #[serde(default)]
    pub max_participants: Option<usize>,
    #[serde(default)]
    pub token_budget_per_participant: Option<u64>,
    /// Common logical model route requested from every participant. Omit to
    /// preserve each participant Runtime's advertised default.
    #[serde(default)]
    pub model_route: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub participant_models: Vec<CoordinatedParticipantModelInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatedParticipantModelInput {
    pub authority_id: String,
    #[serde(default)]
    pub model_route: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[async_trait]
pub trait CognitiveCoordinationBackend: Send + Sync {
    async fn evaluate(
        &self,
        input: CoordinatedEvaluationInput,
        invocation: CognitiveCoordinationInvocation,
    ) -> Result<Value, DynError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CognitiveCoordinationInvocation {
    pub context_id: String,
    pub session_id: String,
}

/// Fail-closed backend installed until an operator supplies a paired
/// Coordination Mesh and transport. Keeping this explicit prevents the
/// model-facing capability from silently simulating multiple participants in
/// the initiating Agent.
pub struct UnavailableCognitiveCoordinationBackend;

#[async_trait]
impl CognitiveCoordinationBackend for UnavailableCognitiveCoordinationBackend {
    async fn evaluate(
        &self,
        _input: CoordinatedEvaluationInput,
        _invocation: CognitiveCoordinationInvocation,
    ) -> Result<Value, DynError> {
        Err("coordinated cognitive evaluation is enabled for this Context, but this Runtime has no Coordination Mesh or coordination transport; configure --coordination-mesh or legacy explicit peers before invoking coordinate.evaluate".into())
    }
}

pub struct CoordinateTool {
    binding_store: Arc<dyn crate::memory::ContextCapabilityBindingStore>,
    backend: Arc<dyn CognitiveCoordinationBackend>,
}

impl CoordinateTool {
    pub fn new(
        permit: ExperimentalFeaturePermit,
        binding_store: Arc<dyn crate::memory::ContextCapabilityBindingStore>,
        backend: Arc<dyn CognitiveCoordinationBackend>,
    ) -> Self {
        assert!(
            permit.permits(COGNITIVE_COORDINATION),
            "coordinate requires the cognitive-coordination feature permit"
        );
        Self {
            binding_store,
            backend,
        }
    }
}

#[async_trait]
impl crate::tool::Tool for CoordinateTool {
    fn name(&self) -> &str {
        COORDINATE_TOOL_NAME
    }

    fn definition(&self) -> crate::llm::ToolDefinition {
        crate::llm::ToolDefinition {
            name: self.name().to_string(),
            description: "Invoke an explicitly bound Cognitive Coordination operation. When coordinated evaluation mode is enabled for the current Context, Runtime invokes this operation automatically before every ordinary user request; call it explicitly only for an additional independent sub-question. The initiator coordinates the request, Runtime-selected paired participants evaluate independently, and unresolved alternatives remain explicit. Never simulate missing participants.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["evaluate"],
                        "description": "The coordination operation. v0 exposes only coordinated cognitive evaluation."
                    },
                    "question": {
                        "type": "string",
                        "minLength": 1,
                        "description": "A self-contained question for independent participant evaluation."
                    },
                    "objective_id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Optional durable Objective identity when the request belongs to one."
                    },
                    "shared_input": {
                        "description": "Optional structured input shared identically with every selected participant."
                    },
                    "required_capabilities": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "uniqueItems": true
                    },
                    "preferred_capabilities": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "uniqueItems": true
                    },
                    "min_participants": { "type": "integer", "minimum": 1 },
                    "max_participants": { "type": "integer", "minimum": 1 },
                    "token_budget_per_participant": { "type": "integer", "minimum": 1 }
                    ,"model_route": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Optional common logical model route; omitted means each participant's local default."
                    },
                    "reasoning_effort": {
                        "type": "string",
                        "enum": ["none", "low", "medium", "high", "max"]
                    },
                    "participant_models": {
                        "type": "array",
                        "description": "Optional Authority-specific model overrides negotiated against handshake advertisements.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "authority_id": { "type": "string", "minLength": 1 },
                                "model_route": { "type": "string", "minLength": 1 },
                                "reasoning_effort": {
                                    "type": "string",
                                    "enum": ["none", "low", "medium", "high", "max"]
                                }
                            },
                            "required": ["authority_id"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["operation", "question"],
                "additionalProperties": false
            }),
        }
    }

    fn execution_class(&self) -> crate::tool::ToolExecutionClass {
        crate::tool::ToolExecutionClass::LogicalInline
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let input: CoordinatedEvaluationInput = serde_json::from_str(arguments)?;
        if input.operation != "evaluate" {
            return Err(format!(
                "unsupported coordinate operation '{}'; available operations: evaluate",
                input.operation
            )
            .into());
        }
        if input.question.trim().is_empty() {
            return Err("coordinate.question must not be empty".into());
        }
        if input
            .objective_id
            .as_deref()
            .is_some_and(|objective_id| objective_id.trim().is_empty())
        {
            return Err("coordinate.objective_id must not be empty when provided".into());
        }
        if input.min_participants == Some(0) {
            return Err("coordinate.min_participants must be greater than zero".into());
        }
        if input.max_participants == Some(0) {
            return Err("coordinate.max_participants must be greater than zero".into());
        }
        if input.token_budget_per_participant == Some(0) {
            return Err("coordinate.token_budget_per_participant must be greater than zero".into());
        }
        if input
            .min_participants
            .zip(input.max_participants)
            .is_some_and(|(minimum, maximum)| maximum < minimum)
        {
            return Err("coordinate.max_participants must be at least min_participants".into());
        }
        if input
            .required_capabilities
            .iter()
            .chain(&input.preferred_capabilities)
            .any(|capability| capability.trim().is_empty())
        {
            return Err("coordinate capabilities must not contain empty names".into());
        }
        if input
            .model_route
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
            || input
                .participant_models
                .iter()
                .any(|item| item.authority_id.trim().is_empty())
        {
            return Err("coordinate model routes and Authority ids must not be empty".into());
        }
        let mut model_authorities = std::collections::BTreeSet::new();
        if input
            .participant_models
            .iter()
            .any(|item| !model_authorities.insert(item.authority_id.clone()))
        {
            return Err(
                "coordinate participant model overrides require unique Authority ids".into(),
            );
        }
        let context_id = crate::tool::CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "coordinate is missing the current Context route")?;
        let session_id = crate::tool::CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "coordinate is missing the current Session route")?;
        let enabled = self
            .binding_store
            .get_context_capability_binding(&context_id, COGNITIVE_COORDINATION)
            .await?
            .is_some_and(|binding| binding.enabled);
        if !enabled {
            return Err(format!(
                "Cognitive Coordination is not enabled for Context '{context_id}'"
            )
            .into());
        }
        let output = self
            .backend
            .evaluate(
                input,
                CognitiveCoordinationInvocation {
                    context_id,
                    session_id,
                },
            )
            .await?;
        serde_json::to_string_pretty(&output).map_err(Into::into)
    }
}

/// In-process adapter which uses ordinary SDK ingress and Context projection
/// surfaces. It is not a network federation transport.
pub struct SdkEvaluationTransport {
    sdk: MorphzSdk,
    principal: PrincipalAssertion,
    timeout: Duration,
}

impl SdkEvaluationTransport {
    pub fn new(
        permit: ExperimentalFeaturePermit,
        sdk: MorphzSdk,
        principal: PrincipalAssertion,
        timeout: Duration,
    ) -> Self {
        assert!(
            permit.permits(COGNITIVE_COORDINATION),
            "cognitive coordination requires its own experimental feature permit"
        );
        Self {
            sdk,
            principal,
            timeout,
        }
    }

    async fn existing_reply(
        &self,
        session_id: &str,
        root_turn_id: &str,
    ) -> CoordinationResult<Option<Event>> {
        let events = self
            .sdk
            .session_events(
                &self.principal.principal_id,
                SessionEventsQuery {
                    session_id: session_id.to_string(),
                    after_sequence: None,
                    before_sequence: None,
                    conversation_only: true,
                    limit: 1_000,
                },
            )
            .await
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        Ok(events.into_iter().find(|event| {
            matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply")
                && event.payload.get("root_turn_id").and_then(Value::as_str) == Some(root_turn_id)
        }))
    }

    fn proposal_from_reply(event: Event) -> CoordinationResult<ProposalDraft> {
        if event.topic == "chat/no_reply" {
            return Err(CoordinationError::Transport(
                "participant completed without a cognitive proposal".to_string(),
            ));
        }
        let text = event
            .payload
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                CoordinationError::Transport("participant reply has no text".to_string())
            })?;
        let evidence_refs = event
            .payload
            .get("evidence_refs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let artifact_refs = event
            .payload
            .get("artifact_refs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let mut draft =
            serde_json::from_str::<ProposalDraft>(text).unwrap_or_else(|_| ProposalDraft {
                statement: Value::String(text.to_string()),
                evidence_refs: Vec::new(),
                artifact_refs: Vec::new(),
                claimed_relations: Vec::new(),
            });
        // Only Runtime-observed evidence and artifact references cross this
        // transport boundary as proposal provenance. Relationship evidence
        // remains an explicitly contributor-claimed assertion.
        draft.evidence_refs = evidence_refs;
        draft.artifact_refs = artifact_refs;
        Ok(draft)
    }

    fn proposal_for_assignment(
        event: Event,
        assignment: &EvaluationAssignment,
    ) -> CoordinationResult<ProposalDraft> {
        let actual_context_version = event
            .payload
            .get("context_snapshot_version")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                CoordinationError::Transport(format!(
                    "participant '{}' reply has no Runtime Context snapshot version",
                    assignment.participant.authority_id
                ))
            })?;
        if actual_context_version != assignment.projection.context_version {
            return Err(CoordinationError::Transport(format!(
                "participant '{}' evaluated Context version {}, but assignment was bound to {}",
                assignment.participant.authority_id,
                actual_context_version,
                assignment.projection.context_version
            )));
        }
        Self::proposal_from_reply(event)
    }
}

#[async_trait]
impl CognitiveEvaluationTransport for SdkEvaluationTransport {
    async fn project(
        &self,
        participant: &ParticipantDescriptor,
        _request: &CognitiveEvaluationRequest,
    ) -> CoordinationResult<ProjectionSnapshot> {
        let session = self
            .sdk
            .get_session(&self.principal.principal_id, &participant.session_id)
            .await
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        if session.agent_id != participant.agent_id || session.context_id != participant.context_id
        {
            return Err(CoordinationError::Transport(format!(
                "participant authority '{}' does not match the Runtime Agent/Context binding",
                participant.authority_id
            )));
        }
        let view = self
            .sdk
            .context_projection_as_operator(&participant.context_id, &participant.session_id)
            .await
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        let digest = stable_digest(&view)?;
        Ok(ProjectionSnapshot {
            context_id: participant.context_id.clone(),
            session_id: participant.session_id.clone(),
            context_version: view.state.version,
            digest,
        })
    }

    async fn evaluate(
        &self,
        assignment: &EvaluationAssignment,
    ) -> CoordinationResult<ProposalDraft> {
        let mut stream = self
            .sdk
            .subscribe_session(
                &self.principal.principal_id,
                &assignment.participant.session_id,
                64,
            )
            .await
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        let prompt = format!(
            "You are participating in an experimental coordinated cognitive evaluation. \
             Work independently from other participants and return one self-contained proposal. \
             Do not select a collective winner and do not claim to speak for the Union. \
             Return exactly one JSON object with this shape: \
             {{\"statement\": <JSON value>, \"claimed_relations\": \
             [{{\"target_authority_id\": <peer id>, \"relation\": \
             \"supports|conflicts_with|refines|verifies|derived_from\", \
             \"evidence_refs\": [<optional refs>]}}]}}. Use an empty relation list when no \
             relation can be responsibly claimed. Do not wrap the JSON in Markdown.\n\n\
             Request: {}\nObjective: {}\nInput projection digest: {}\n\
             Token budget: {}\nPeer authority ids: {}\nQuestion:\n{}\n\nShared input:\n{}",
            assignment.request_id,
            assignment.objective_id,
            assignment.projection.digest,
            assignment.token_budget,
            serde_json::to_string(&assignment.peer_authority_ids)?,
            assignment.question,
            serde_json::to_string_pretty(&assignment.shared_input)?,
        );
        let receipt = self
            .sdk
            .send_message(
                &self.principal,
                SendMessageCommand {
                    session_id: assignment.participant.session_id.clone(),
                    text: prompt,
                    actor: COORDINATION_PARTICIPANT_ACTOR.to_string(),
                    client_message_id: Some(assignment.assignment_id.clone()),
                    attachments: Vec::new(),
                    references: Vec::new(),
                    harness: None,
                    dispatch_mode: Some(MessageDispatchMode::Parallel),
                    model_alias: assignment.model.route.clone(),
                    reasoning_effort: assignment.model.reasoning_effort.clone(),
                    target_id: None,
                },
            )
            .await
            .map_err(|error| CoordinationError::Transport(error.to_string()))?;
        if let Some(reply) = self
            .existing_reply(&assignment.participant.session_id, &receipt.event_id)
            .await?
        {
            return Self::proposal_for_assignment(reply, assignment);
        }

        let reply = tokio::time::timeout(self.timeout, async {
            while let Some(event) = stream.recv().await {
                if matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply")
                    && event.payload.get("root_turn_id").and_then(Value::as_str)
                        == Some(receipt.event_id.as_str())
                {
                    return Some(event);
                }
            }
            None
        })
        .await
        .map_err(|_| {
            CoordinationError::Transport(format!(
                "participant '{}' did not finish within {:?}",
                assignment.participant.authority_id, self.timeout
            ))
        })?
        .ok_or_else(|| {
            CoordinationError::Transport("Runtime event stream closed before reply".to_string())
        })?;
        Self::proposal_for_assignment(reply, assignment)
    }
}

#[derive(Clone)]
pub struct SdkUnionCommitter {
    sdk: MorphzSdk,
}

impl SdkUnionCommitter {
    pub fn new(permit: ExperimentalFeaturePermit, sdk: MorphzSdk) -> Self {
        assert!(
            permit.permits(COGNITIVE_COORDINATION),
            "cognitive coordination requires its own experimental feature permit"
        );
        Self { sdk }
    }
}

#[async_trait]
impl UnionCommitter for SdkUnionCommitter {
    async fn commit(
        &self,
        authority: &AuthorityDomain,
        intent: &UnionCommitIntent,
        certificate: &CommitCertificate,
    ) -> CoordinationResult<UnionCommitReceipt> {
        verify_commit_certificate(intent, authority, certificate)?;
        let payload = serde_json::to_string(&json!({
            "commit_intent": intent,
            "commit_certificate": certificate,
        }))?;
        let transaction = format!(
            "(context-tx (base-version {}) \
             (reason \"quorum-certified experimental Union cognition commit\") \
             (create {} (experimental-union-cognition {})))",
            intent.base_union_version,
            intent.frame_id,
            sexpr_string(&payload)?,
        );
        let commit = self
            .sdk
            .apply_context_transaction_as_operator(
                &intent.union_context_id,
                &intent.union_session_id,
                &transaction,
                &certificate.certificate_id,
            )
            .await
            .map_err(|error| CoordinationError::Commit(error.to_string()))?;
        if commit.before_version != intent.base_union_version {
            return Err(CoordinationError::Commit(format!(
                "Runtime committed against version {}, expected {}",
                commit.before_version, intent.base_union_version
            )));
        }
        Ok(UnionCommitReceipt {
            request_id: intent.request_id.clone(),
            union_context_id: intent.union_context_id.clone(),
            transaction_id: commit.transaction_id,
            before_version: commit.before_version,
            after_version: commit.after_version,
            frame_id: intent.frame_id.clone(),
            certificate_digest: certificate.digest.clone(),
        })
    }
}

fn sexpr_string(value: &str) -> CoordinationResult<String> {
    serde_json::to_string(value).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::{
        CognitiveCoordinationBackend, CognitiveCoordinationInvocation, CoordinateTool,
        CoordinatedEvaluationInput, SdkEvaluationTransport,
    };
    use crate::event::Event;
    use crate::memory::{
        ContextCapabilityBindingMutation, ContextCapabilityBindingRecord,
        ContextCapabilityBindingStore,
    };
    use crate::tool::{Tool, CURRENT_CONTEXT_ID, CURRENT_SESSION_ID};
    use async_trait::async_trait;
    use chrono::Utc;
    use morphz_cognitive_coordination::ContributionRelationKind;
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct TestBindingStore {
        binding: Mutex<Option<ContextCapabilityBindingRecord>>,
    }

    impl TestBindingStore {
        fn with_enabled(context_id: &str, enabled: bool) -> Self {
            Self {
                binding: Mutex::new(Some(ContextCapabilityBindingRecord {
                    context_id: context_id.to_string(),
                    capability_id: crate::experimental::COGNITIVE_COORDINATION.to_string(),
                    enabled,
                    revision: 1,
                    updated_at: Utc::now(),
                })),
            }
        }
    }

    #[async_trait]
    impl ContextCapabilityBindingStore for TestBindingStore {
        async fn list_context_capability_bindings(
            &self,
            context_id: &str,
        ) -> Result<Vec<ContextCapabilityBindingRecord>, super::DynError> {
            Ok(self
                .binding
                .lock()
                .unwrap()
                .clone()
                .into_iter()
                .filter(|binding| binding.context_id == context_id)
                .collect())
        }

        async fn get_context_capability_binding(
            &self,
            context_id: &str,
            capability_id: &str,
        ) -> Result<Option<ContextCapabilityBindingRecord>, super::DynError> {
            Ok(self.binding.lock().unwrap().clone().filter(|binding| {
                binding.context_id == context_id && binding.capability_id == capability_id
            }))
        }

        async fn update_context_capability_binding(
            &self,
            context_id: &str,
            capability_id: &str,
            enabled: bool,
            expected_revision: u64,
        ) -> Result<ContextCapabilityBindingMutation, super::DynError> {
            let mut slot = self.binding.lock().unwrap();
            let current_revision = slot.as_ref().map_or(0, |binding| binding.revision);
            if current_revision != expected_revision {
                return Ok(slot
                    .clone()
                    .map(ContextCapabilityBindingMutation::Conflict)
                    .unwrap_or(ContextCapabilityBindingMutation::NotFound));
            }
            let binding = ContextCapabilityBindingRecord {
                context_id: context_id.to_string(),
                capability_id: capability_id.to_string(),
                enabled,
                revision: current_revision + 1,
                updated_at: Utc::now(),
            };
            *slot = Some(binding.clone());
            Ok(ContextCapabilityBindingMutation::Updated(binding))
        }
    }

    #[derive(Default)]
    struct RecordingBackend {
        calls: Mutex<Vec<(CoordinatedEvaluationInput, CognitiveCoordinationInvocation)>>,
    }

    #[async_trait]
    impl CognitiveCoordinationBackend for RecordingBackend {
        async fn evaluate(
            &self,
            input: CoordinatedEvaluationInput,
            invocation: CognitiveCoordinationInvocation,
        ) -> Result<serde_json::Value, super::DynError> {
            self.calls.lock().unwrap().push((input, invocation));
            Ok(json!({"outcome": "evaluated"}))
        }
    }

    fn permit() -> crate::experimental::ExperimentalFeaturePermit {
        crate::experimental::require_enabled(
            &BTreeSet::from([crate::experimental::COGNITIVE_COORDINATION.to_string()]),
            crate::experimental::COGNITIVE_COORDINATION,
        )
        .unwrap()
    }

    #[test]
    fn coordinate_is_one_extensible_tool_with_evaluate_as_an_operation() {
        let tool = CoordinateTool::new(
            permit(),
            Arc::new(TestBindingStore::default()),
            Arc::new(RecordingBackend::default()),
        );
        let definition = tool.definition();
        assert_eq!(definition.name, "coordinate");
        assert_eq!(
            definition.parameters["properties"]["operation"]["enum"],
            json!(["evaluate"])
        );
        assert_eq!(
            definition.parameters["required"],
            json!(["operation", "question"])
        );
    }

    #[tokio::test]
    async fn coordinate_rechecks_the_context_binding_before_dispatch() {
        let backend = Arc::new(RecordingBackend::default());
        let tool = CoordinateTool::new(
            permit(),
            Arc::new(TestBindingStore::with_enabled("context-a", false)),
            Arc::clone(&backend) as Arc<dyn CognitiveCoordinationBackend>,
        );
        let error = CURRENT_SESSION_ID
            .scope("session-a".to_string(), async {
                CURRENT_CONTEXT_ID
                    .scope(
                        "context-a".to_string(),
                        tool.execute(r#"{"operation":"evaluate","question":"compare"}"#),
                    )
                    .await
            })
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Cognitive Coordination is not enabled"));
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn coordinate_dispatches_an_enabled_evaluation_to_the_backend() {
        let backend = Arc::new(RecordingBackend::default());
        let tool = CoordinateTool::new(
            permit(),
            Arc::new(TestBindingStore::with_enabled("context-a", true)),
            Arc::clone(&backend) as Arc<dyn CognitiveCoordinationBackend>,
        );
        let output = CURRENT_SESSION_ID
            .scope("session-current".to_string(), async {
                CURRENT_CONTEXT_ID
                    .scope(
                        "context-a".to_string(),
                        tool.execute(
                            r#"{"operation":"evaluate","question":"compare","min_participants":2}"#,
                        ),
                    )
                    .await
            })
            .await
            .unwrap();
        let second = CURRENT_SESSION_ID
            .scope("session-another".to_string(), async {
                CURRENT_CONTEXT_ID
                    .scope(
                        "context-a".to_string(),
                        tool.execute(r#"{"operation":"evaluate","question":"compare again"}"#),
                    )
                    .await
            })
            .await
            .unwrap();
        assert!(output.contains("evaluated"));
        assert!(second.contains("evaluated"));
        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0.question, "compare");
        assert_eq!(calls[0].0.min_participants, Some(2));
        assert_eq!(calls[0].1.context_id, "context-a");
        assert_eq!(calls[0].1.session_id, "session-current");
        assert_eq!(calls[1].0.question, "compare again");
        assert_eq!(calls[1].1.session_id, "session-another");
    }

    #[test]
    fn structured_reply_preserves_claims_but_uses_runtime_provenance() {
        let reply = Event::new(
            "reply-1".to_string(),
            "Agent-Morphz".to_string(),
            "assistant_reply".to_string(),
            "chat/reply".to_string(),
            vec![
                (
                    "text".to_string(),
                    json!(
                        r#"{"statement":{"choice":"x"},"evidence_refs":["fabricated"],"claimed_relations":[{"target_authority_id":"authority-b","relation":"supports","evidence_refs":["claim-evidence"]}]}"#
                    ),
                ),
                ("evidence_refs".to_string(), json!(["runtime-evidence"])),
                ("artifact_refs".to_string(), json!(["runtime-artifact"])),
            ]
            .into_iter()
            .collect(),
        );

        let draft = SdkEvaluationTransport::proposal_from_reply(reply).unwrap();
        assert_eq!(draft.statement, json!({"choice": "x"}));
        assert_eq!(draft.evidence_refs, vec!["runtime-evidence"]);
        assert_eq!(draft.artifact_refs, vec!["runtime-artifact"]);
        assert_eq!(draft.claimed_relations.len(), 1);
        assert_eq!(
            draft.claimed_relations[0].relation,
            ContributionRelationKind::Supports
        );
        assert_eq!(
            draft.claimed_relations[0].evidence_refs,
            vec!["claim-evidence"]
        );
    }
}
