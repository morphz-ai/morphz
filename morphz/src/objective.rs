use crate::event::{Event, InMemoryEventBus, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
use crate::harness::{ExactHarnessRef, HarnessRegistry};
use crate::harness_package::{load_objective_harness_binding, objective_harness_binding_event};
use crate::llm::ToolDefinition;
use crate::memory::{
    stable_thread_id, ActivationStore, DelegationStatus, DelegationStore, EventStore,
    ExecutionJobRecord, ExecutionJobStore, NewObjective, NewRuntimeTimer, NewThread,
    ObjectiveMutation, ObjectiveRecord, ObjectiveRecoveryCursor, ObjectiveStatus, ObjectiveStore,
    ObjectiveWaitCondition, QueryFilter, RuntimeTimerKind, RuntimeTimerRecord,
    ThreadActivationMutation, ThreadActivationStatus, ThreadGroupFilter, ThreadGroupStore,
    ThreadKind, ThreadStore, ThreadSupervision, ThreadSupervisorKind,
};
use crate::orchestrator::context::ContextEngine;
use crate::scheduler::{
    derive_objective_readiness, objective_wait_dependency_key, KernelResult, ObjectiveReadiness,
    SchedulerDependencyFilter, SchedulerDependencyMutation, SchedulerDependencyOwnerKind,
    SchedulerDependencyStatus, SchedulerDependencyStore, SchedulerKernel,
};
use crate::timer::{TimerDisposition, TimerEngine};
use crate::tool::{
    Tool, ToolExecutionClass, CURRENT_ATTEMPT_ID, CURRENT_CAUSAL_ROUTE, CURRENT_CONTEXT_ID,
    CURRENT_PRINCIPAL_ID, CURRENT_SESSION_ID,
};
use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value as JsonValue};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{watch, Mutex, Notify};

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const TYPE_OBJECTIVE_CONTROL: &str = "objective_control";
/// A durable operator-controlled recovery boundary for request/model settings
/// which can make a previously invalid physical model request valid. Unlike
/// Provider health resources, this resource is never produced by a timer or a
/// health probe: only a successfully applied configuration change may release
/// it.
pub const MODEL_CONFIGURATION_RESOURCE: &str = "model-configuration";
pub const TYPE_MODEL_CONFIGURATION_CHANGED: &str = "runtime/model_configuration_changed";
const OBJECTIVE_CONTINUATION_INSTRUCTION: &str = r#"Continue working autonomously toward the full stated Objective. Ending one Evaluation does not narrow, redefine, or complete the Objective.

Work from authoritative current state. Previous conversation and Mind may locate work, but files, tool results, persisted Runtime state, external state, and verified artifacts decide what is true now.

Before choosing the next action, classify the previous Objective Evaluation:
- progress: it changed authoritative state, completed real work, or produced evidence that changes the next action. An exploration that finds no confirming evidence still counts when it eliminates a live hypothesis or materially changes the search frontier;
- verified-wait: it is waiting on a specific process, Session, Job, tool handle, scheduler dependency, external event, permission, resource, or deadline whose nonterminal state is currently verified;
- no-progress: it only restated status or plans, reread unchanged evidence, repeated an equivalent action, or ended without changing state, evidence, the search frontier, or the next action.

After no-progress, revalidate the relevant state and take the next materially different safe action. Do not repeat an equivalent investigation merely because its wording differs. If no action is possible because the same genuine blocker remains, preserve that blocker across Evaluations. Mark blocked only after the same blocker has been confirmed in at least three consecutive Objective Evaluations and neither an exact Runtime wait nor another reliable progress path exists.

Use objective_update(status=active, wait_condition=...) for an exact verifiable wait. Do not use ordinary text, a plan, or intent as a substitute for a durable wait.

Before completion, derive every explicit requirement, named artifact, command, test, invariant, and deliverable from the original Objective. Inspect authoritative evidence for each item and treat missing, weak, indirect, or merely compatible evidence as incomplete. Do not redefine success around existing work, a smaller scope, or what is easiest to verify. When evidence proves every required item and no required work remains, call objective_update(status=completed) before the complete final report."#;
const OBJECTIVE_RECONCILE_BATCH: usize = 128;
const OBJECTIVE_RECONCILE_DIRTY_CONTEXT_BATCH: usize = 32;
const OBJECTIVE_RECONCILE_FALLBACK_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(30);
const OBJECTIVE_ORPHAN_SCHEDULE_GRACE: Duration = Duration::seconds(2);

fn objective_reconcile_event(event: &Event) -> bool {
    event.payload.contains_key("context_id")
        && !matches!(
            event.topic.as_str(),
            "chat/progress"
                | "chat/context_inspect"
                | "runtime/model_stream"
                | "runtime/model_request_snapshot"
                | "runtime/model_attempt_snapshot"
                | "runtime/model_attempt_state"
                | "runtime/model_usage"
        )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ObjectiveClosureReview {
    child_states: Vec<(String, ObjectiveStatus)>,
}

impl ObjectiveClosureReview {
    fn render(&self, parent: &ObjectiveRecord) -> String {
        let children = self
            .child_states
            .iter()
            .map(|(id, status)| {
                format!(
                    "(child (id {}) (status {}))",
                    serde_json::to_string(id).expect("Objective ID must serialize"),
                    status.as_str()
                )
            })
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            "(objective-state (phase closure-review) \
             (reason all-direct-children-terminal) \
             (terminal-children {children}) \
             (completion-contract {}) \
             (decision-authority agent) \
             (required-commit state-or-action))",
            serde_json::to_string(&parent.stated_objective)
                .expect("Objective completion contract must serialize")
        )
    }
}

/// A parent whose known child Objectives are all terminal is at a deterministic
/// closure boundary. This does not prove that the parent is complete, but it
/// does mean the next Evaluation must explicitly commit either an Objective
/// state transition or a concrete action. Runtime owns the boundary facts; the
/// Agent retains sole authority over whether the completion contract is met.
fn objective_closure_review(
    parent: &ObjectiveRecord,
    context_objectives: &[ObjectiveRecord],
) -> Option<ObjectiveClosureReview> {
    let mut children = context_objectives
        .iter()
        .filter(|objective| objective.parent_objective_id.as_deref() == Some(parent.id.as_str()))
        .collect::<Vec<_>>();
    if children.is_empty() || children.iter().any(|child| !child.status.is_terminal()) {
        return None;
    }
    children.sort_by(|left, right| left.id.cmp(&right.id));
    Some(ObjectiveClosureReview {
        child_states: children
            .into_iter()
            .map(|child| (child.id.clone(), child.status))
            .collect(),
    })
}

#[derive(Debug, Deserialize)]
struct ObjectiveCreateArgs {
    stated_objective: String,
    reason: String,
    #[serde(default)]
    source_refs: Vec<String>,
    #[serde(default)]
    parent_objective_id: Option<String>,
    #[serde(default)]
    token_budget: Option<u64>,
    /// Optional inherited default. Every concrete Objective Evaluation still
    /// receives its own immutable binding before Provider execution.
    #[serde(default)]
    harness: Option<ExactHarnessRef>,
}

/// Lets the model explicitly promote current work to a First-Class Objective. Context, Session,
/// Agent, Objective ID, and source Event are injected or generated by the runtime, so the model
/// cannot use this request to create control objects across routing boundaries.
pub struct ObjectiveCreateTool {
    supervisor: Arc<ObjectiveSupervisor>,
    context_engine: Arc<ContextEngine>,
    harness_registry: Arc<HarnessRegistry>,
    creation_locks: DashMap<String, Arc<Mutex<()>>>,
}

impl ObjectiveCreateTool {
    pub fn new(
        supervisor: Arc<ObjectiveSupervisor>,
        context_engine: Arc<ContextEngine>,
        harness_registry: Arc<HarnessRegistry>,
    ) -> Self {
        Self {
            supervisor,
            context_engine,
            harness_registry,
            creation_locks: DashMap::new(),
        }
    }
}

#[async_trait::async_trait]
impl Tool for ObjectiveCreateTool {
    fn name(&self) -> &str {
        "objective_create"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "objective_create".to_string(),
            description: "Create a durable first-class Objective for work in the current Session that genuinely must span multiple Evaluations, asynchronous waits, or Runtime restarts. Do not use it for ordinary questions, work that fits in one Evaluation, recording a todo, or merely extending execution time. The Runtime binds the current Agent, Context, and Session and generates the ID. Continue the current work after creation and do not duplicate the same Objective. A child Objective may be created explicitly, but parent_objective_id must be the Objective currently being evaluated.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "stated_objective": {
                        "type": "string",
                        "description": "A stable, complete, auditable long-term objective statement preserving the user's requirements, scope, and completion criteria rather than only the next action"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Why this work needs a first-class Objective instead of completion in the current ordinary Evaluation"
                    },
                    "source_refs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Current Context Event refs, such as @e27 for the user request or evidence forming the objective. The Runtime verifies existence; pass an empty array when no suitable ref exists"
                    },
                    "parent_objective_id": {
                        "type": "string",
                        "description": "Set only for a child Objective, and exactly to the Objective ID currently being evaluated; omit for an independent Objective"
                    },
                    "token_budget": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Optional Prompt Token budget; omission uses the Runtime policy with no explicit Objective budget"
                    },
                    "harness": {
                        "type": "object",
                        "description": "Optional default Objective Harness. Set it only when this long-term objective clearly requires an installed Harness; use harness_list to discover the exact version first. Every Evaluation materializes its own immutable binding.",
                        "properties": {
                            "id": { "type": "string", "minLength": 1 },
                            "version": { "type": "string", "minLength": 1 }
                        },
                        "required": ["id", "version"],
                        "additionalProperties": false
                    }
                },
                "required": ["stated_objective", "reason", "source_refs"]
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let args: ObjectiveCreateArgs = serde_json::from_str(arguments)?;
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_create is missing the current Session injected by Runtime")?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_create is missing the current Context injected by Runtime")?;
        let attempt_id = CURRENT_ATTEMPT_ID.try_with(Clone::clone).map_err(|_| {
            "objective_create is missing the current Evaluation injected by Runtime"
        })?;
        let initiating_principal_id = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
        let stated_objective = args.stated_objective.trim();
        if stated_objective.is_empty() {
            return Err("objective_create.stated_objective must not be empty".into());
        }
        let reason = args.reason.trim();
        if reason.is_empty() {
            return Err("objective_create.reason must not be empty".into());
        }
        if reason.chars().count() > 10_000 {
            return Err("objective_create.reason exceeds the 10,000-character limit".into());
        }
        if args.source_refs.len() > 64 {
            return Err("objective_create.source_refs allows at most 64 references".into());
        }
        if args.token_budget == Some(0) {
            return Err("objective_create.token_budget must be greater than 0".into());
        }
        let requested_harness = match args.harness.as_ref() {
            Some(reference) => {
                let id = reference.id.trim();
                let version = reference.version.trim();
                if id.is_empty() || version.is_empty() {
                    return Err("objective_create.harness.id and version must not be empty".into());
                }
                Some(self.harness_registry.get(id, version).ok_or_else(|| {
                    format!("Harness '{id}@{version}' is not installed; call harness_list first")
                })?)
            }
            None => None,
        };

        let session_store = self
            .context_engine
            .session_store()
            .ok_or("objective_create is missing Runtime SessionStore")?;
        let session = session_store
            .get_session(&session_id)
            .await?
            .ok_or_else(|| format!("current Session '{session_id}' does not exist"))?;
        if session.context_id != context_id {
            return Err("objective_create current Session/Context route is inconsistent".into());
        }

        let mut source_event_ids = Vec::with_capacity(args.source_refs.len());
        for source_ref in &args.source_refs {
            let event = self
                .context_engine
                .find_event(&context_id, source_ref)
                .await?
                .ok_or_else(|| {
                    format!("source_ref '{source_ref}' does not exist or does not belong to the current Context")
                })?;
            source_event_ids.push(event.id);
        }

        let parent_objective_id = args
            .parent_objective_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        if let Some(parent_id) = parent_objective_id.as_deref() {
            let active = self
                .supervisor
                .evaluations
                .get_for_activation(&attempt_id)
                .ok_or("only the currently evaluated Objective can be the parent of an autonomous creation")?;
            if active.objective_id != parent_id {
                return Err(format!(
                    "parent_objective_id must be the current Objective '{}'",
                    active.objective_id
                )
                .into());
            }
            let parent = self
                .supervisor
                .get(parent_id)
                .await?
                .ok_or_else(|| format!("parent Objective '{parent_id}' does not exist"))?;
            if parent.context_id != context_id
                || parent.coordinator_session_id != session_id
                || parent.status.is_terminal()
            {
                return Err(
                    "parent Objective must belong to the current Context/coordinator Session and remain non-terminal"
                        .into(),
                );
            }
        }

        let lock_key = format!("{context_id}\0{session_id}");
        let creation_lock = self
            .creation_locks
            .entry(lock_key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = creation_lock.lock().await;
        let normalized_statement = normalize_objective_statement(stated_objective);
        if let Some(existing) = self
            .supervisor
            .list(&context_id, false)
            .await?
            .into_iter()
            .find(|objective| {
                objective.coordinator_session_id == session_id
                    && objective.initiating_principal_id == initiating_principal_id
                    && objective.parent_objective_id == parent_objective_id
                    && normalize_objective_statement(&objective.stated_objective)
                        == normalized_statement
            })
        {
            if let Some(requested) = requested_harness.as_ref() {
                let descriptor = requested.descriptor();
                let existing_binding = load_objective_harness_binding(
                    self.supervisor.audit_store.as_ref(),
                    &context_id,
                    &existing.id,
                )
                .await?;
                match existing_binding {
                    Some(binding)
                        if binding.harness_id == descriptor.id
                            && binding.harness_version == descriptor.version => {}
                    Some(binding) => {
                        return Err(format!(
                            "the same Objective is already bound by default to '{}@{}' and cannot be rebound to '{}@{}'",
                            binding.harness_id,
                            binding.harness_version,
                            descriptor.id,
                            descriptor.version
                        )
                        .into());
                    }
                    None => {
                        return Err(format!(
                            "the same Objective already exists without a default Harness and cannot be retroactively bound to '{}@{}' through duplicate creation; create a different Objective or explicitly select the current Evaluation Harness",
                            descriptor.id, descriptor.version
                        )
                        .into());
                    }
                }
            }
            let adopted = if self
                .supervisor
                .evaluations
                .get_for_activation(&attempt_id)
                .is_none()
            {
                self.supervisor
                    .claim_routed_evaluation(&existing, &attempt_id, Some(&attempt_id), false, None)
                    .await?
            } else {
                None
            };
            if let Some(claimed) = &adopted {
                self.supervisor
                    .publish_state_event("evaluation_started", claimed, Some(&attempt_id))
                    .await?;
            } else {
                self.supervisor.reconcile(existing.clone()).await?;
            }
            let current = self.supervisor.get(&existing.id).await?.unwrap_or(existing);
            return Ok(serde_json::to_string_pretty(&json!({
                "status": "existing",
                "created": false,
                "objective_id": current.id,
                "objective_status": current.status,
                "revision": current.revision,
                "activation_adoption": if adopted.is_some() { "current-activation" } else { "already-routed-or-independent-continuation" },
                "guidance": "An equivalent nonterminal Objective already exists. Do not create a duplicate; continue it or update its state when authorized."
            }))?);
        }

        let nonce = Utc::now().timestamp_nanos_opt().unwrap_or(0);
        let objective_id = format!("objective-auto-{nonce}");
        let source_event_id = format!("objective_auto_request_{nonce}");
        let mut request_payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("requested_objective_id".to_string(), json!(objective_id)),
            ("stated_objective".to_string(), json!(stated_objective)),
            ("reason".to_string(), json!(reason)),
            ("source_refs".to_string(), json!(args.source_refs)),
            ("source_event_ids".to_string(), json!(source_event_ids)),
            (
                "parent_objective_id".to_string(),
                json!(parent_objective_id),
            ),
            ("token_budget".to_string(), json!(args.token_budget)),
        ];
        if let Some(principal_id) = &initiating_principal_id {
            request_payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        if let Some(harness) = requested_harness.as_ref() {
            let descriptor = harness.descriptor();
            request_payload.push(("harness_id".to_string(), json!(descriptor.id)));
            request_payload.push(("harness_version".to_string(), json!(descriptor.version)));
            request_payload.push((
                "harness_artifact_hash".to_string(),
                json!(harness.artifact_hash()),
            ));
        }
        let request_event = Event::new(
            source_event_id.clone(),
            "Agent-Morphz".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "objective/autonomous_requested".to_string(),
            request_payload.into_iter().collect(),
        );
        let mut initial_events = vec![request_event.clone()];
        let harness_binding = if let Some(harness) = requested_harness.as_ref() {
            let (binding, binding_event) =
                objective_harness_binding_event(&context_id, &objective_id, harness.as_ref())?;
            initial_events.push(binding_event);
            Some(binding)
        } else {
            None
        };

        let created = self
            .supervisor
            .store
            .create_objective_with_events(
                NewObjective {
                    id: objective_id,
                    agent_id: session.agent_id,
                    context_id: context_id.clone(),
                    coordinator_session_id: session_id.clone(),
                    delivery_session_id: session_id.clone(),
                    parent_objective_id,
                    source_event_id,
                    initiating_principal_id,
                    stated_objective: stated_objective.to_string(),
                    token_budget: args.token_budget,
                },
                initial_events,
            )
            .await?;
        self.supervisor.bus.publish(request_event).await?;

        let adopted = if self
            .supervisor
            .evaluations
            .get_for_activation(&attempt_id)
            .is_none()
        {
            self.supervisor
                .claim_routed_evaluation(&created, &attempt_id, Some(&attempt_id), false, None)
                .await?
        } else {
            None
        };
        self.supervisor
            .publish_state_event("created", &created, Some(reason))
            .await?;
        if let Some(claimed) = &adopted {
            self.supervisor
                .publish_state_event("evaluation_started", claimed, Some(&attempt_id))
                .await?;
        } else {
            let supervisor = Arc::clone(&self.supervisor);
            let created_for_reconcile = created.clone();
            // The tool itself executes inside an already deep model-attempt
            // future.  Initial Objective admission is a scheduler phase, so
            // start it at a task root while preserving await/error semantics.
            tokio::spawn(async move { supervisor.reconcile(created_for_reconcile).await })
                .await
                .map_err(|error| {
                    format!("Objective initial reconciliation task failed: {error}")
                })??;
        }
        let current = self.supervisor.get(&created.id).await?.unwrap_or(created);

        Ok(serde_json::to_string_pretty(&json!({
            "status": "created",
            "created": true,
            "objective_id": current.id,
            "objective_status": current.status,
            "revision": current.revision,
            "context_id": current.context_id,
            "coordinator_session_id": current.coordinator_session_id,
            "parent_objective_id": current.parent_objective_id,
            "harness_default": harness_binding,
            "activation_adoption": if adopted.is_some() { "current-activation" } else { "independent-continuation" },
            "guidance": "The Objective is durable. Do not create it again; continue the current work. Ordinary text or no_reply ends only the current Activation, and the Supervisor continues an unfinished Objective automatically."
        }))?)
    }
}

fn normalize_objective_statement(statement: &str) -> String {
    statement.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentObjectiveStatus {
    Active,
    Blocked,
    Completed,
}

#[derive(Debug, Deserialize)]
struct ObjectiveUpdateArgs {
    objective_id: String,
    base_revision: u64,
    status: AgentObjectiveStatus,
    reason: String,
    #[serde(default)]
    evidence_refs: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_objective_wait_condition")]
    wait_condition: Option<ObjectiveWaitConditionArgument>,
}

#[derive(Debug)]
struct ObjectiveWaitConditionArgument {
    condition: ObjectiveWaitCondition,
    decoded_from_string: bool,
}

fn deserialize_objective_wait_condition<'de, D>(
    deserializer: D,
) -> Result<Option<ObjectiveWaitConditionArgument>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<JsonValue>::deserialize(deserializer)?
        .map(parse_objective_wait_condition_argument)
        .transpose()
        .map_err(serde::de::Error::custom)
}

fn parse_objective_wait_condition_argument(
    value: JsonValue,
) -> Result<ObjectiveWaitConditionArgument, String> {
    let (value, decoded_from_string) = match value {
        JsonValue::String(encoded) => {
            let decoded = serde_json::from_str::<JsonValue>(&encoded).map_err(|error| {
                format!(
                    "objective_update.wait_condition must be a JSON object; compatibility string is not valid JSON: {error}"
                )
            })?;
            if !decoded.is_object() {
                return Err(
                    "objective_update.wait_condition accepts only a single-level JSON object string for compatibility and cannot decode recursively"
                        .to_string(),
                );
            }
            (decoded, true)
        }
        value => (value, false),
    };

    let object = value
        .as_object()
        .ok_or("objective_update.wait_condition must be a JSON object")?;
    let kind = object
        .get("kind")
        .and_then(JsonValue::as_str)
        .ok_or("objective_update.wait_condition.kind must be a string")?;
    let required_fields: &[&str] = match kind {
        "tool_task" => &["kind", "task_id"],
        "delegation" => &["kind", "delegation_id"],
        "thread_group" => &["kind", "group_id"],
        "timer" => &["kind", "deadline"],
        "permission" => &["kind", "request_id"],
        "user_input" => &["kind", "session_id"],
        "external_event" => &["kind", "topic", "correlation_id"],
        "resource_available" => &["kind", "resource"],
        other => {
            return Err(format!(
                "objective_update.wait_condition.kind '{other}' is not supported"
            ));
        }
    };
    for field in required_fields.iter().skip(1) {
        if !object
            .get(*field)
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(format!(
                "objective_update.wait_condition.{field} must be a non-empty string"
            ));
        }
    }
    if let Some(unexpected) = object
        .keys()
        .find(|field| !required_fields.contains(&field.as_str()))
    {
        return Err(format!(
            "objective_update.wait_condition.kind='{kind}' does not accept field '{unexpected}'"
        ));
    }

    let condition = serde_json::from_value(value)
        .map_err(|error| format!("invalid objective_update.wait_condition: {error}"))?;
    Ok(ObjectiveWaitConditionArgument {
        condition,
        decoded_from_string,
    })
}

fn objective_wait_condition_schema() -> JsonValue {
    json!({
        "type": "object",
        "description": "A deterministic wake condition used only with status=active. Pass this as a native JSON object, never as a JSON-encoded string. Select kind and provide exactly its matching field: tool_task/task_id, delegation/delegation_id, thread_group/group_id, timer/deadline, permission/request_id, user_input/session_id, external_event/topic+correlation_id, or resource_available/resource. The Runtime does not poll after submission and resumes automatically when the event is satisfied.",
        "properties": {
            "kind": {
                "type": "string",
                "enum": [
                    "tool_task",
                    "delegation",
                    "thread_group",
                    "timer",
                    "permission",
                    "user_input",
                    "external_event",
                    "resource_available"
                ]
            },
            "task_id": {
                "type": "string",
                "description": "For kind=tool_task, use only the exact task_id returned by exec with execution=background."
            },
            "delegation_id": { "type": "string" },
            "group_id": {
                "type": "string",
                "description": "For kind=thread_group, use a Thread Group ID supervised by the current Objective."
            },
            "deadline": {
                "type": "string",
                "format": "date-time",
                "description": "For kind=timer, use an absolute RFC 3339 time with an explicit offset."
            },
            "request_id": { "type": "string" },
            "session_id": { "type": "string" },
            "topic": { "type": "string" },
            "correlation_id": { "type": "string" },
            "resource": { "type": "string" }
        },
        "required": ["kind"],
        "additionalProperties": false
    })
}

pub struct ObjectiveUpdateTool {
    supervisor: Arc<ObjectiveSupervisor>,
    context_engine: Arc<ContextEngine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutedObjectiveEventDisposition {
    Unrelated,
    Admitted,
    Suppressed,
}

impl ObjectiveUpdateTool {
    pub fn new(supervisor: Arc<ObjectiveSupervisor>, context_engine: Arc<ContextEngine>) -> Self {
        Self {
            supervisor,
            context_engine,
        }
    }
}

#[async_trait::async_trait]
impl Tool for ObjectiveUpdateTool {
    fn name(&self) -> &str {
        "objective_update"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "objective_update".to_string(),
            description: "Explicitly submit Runtime control state for the current long-term Objective. completed first persists finalizing intent, then the Runtime asks you for a complete final reply in the same Activation; the Objective, Activation, and Thread complete atomically only when that reply is committed. completed requires a truthful reason and existing evidence refs. Keep status active with wait_condition when waiting for a definite event. Use blocked only after the same genuine blocker has been confirmed in at least three consecutive Objective Evaluations and the Runtime cannot wait automatically and no reliable progress path remains. The Agent cannot pause or cancel through this tool.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "objective_id": {
                        "type": "string",
                        "description": "The stable ID of the current Objective from kernel.objectives"
                    },
                    "base_revision": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "The Objective revision visible in this Context Encoding; reread current state after a conflict"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["active", "blocked", "completed"]
                    },
                    "reason": {
                        "type": "string",
                        "description": "Why this state matches current objective evidence; Context pressure, an almost exhausted budget, or a desire to end the response are not completion reasons"
                    },
                    "evidence_refs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Current Context Event refs such as @e27 supporting the decision. The Runtime verifies existence, not business sufficiency"
                    },
                    "wait_condition": objective_wait_condition_schema()
                },
                "required": ["objective_id", "base_revision", "status", "reason", "evidence_refs"]
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let mut args: ObjectiveUpdateArgs = serde_json::from_str(arguments)?;
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_update is missing the current Session injected by Runtime")?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_update is missing the current Context injected by Runtime")?;
        let attempt_id = CURRENT_ATTEMPT_ID.try_with(Clone::clone).map_err(|_| {
            "objective_update is missing the current Evaluation injected by Runtime"
        })?;
        let wait_condition = args.wait_condition.take().map(|argument| {
            if argument.decoded_from_string {
                tracing::warn!(
                    objective_id = %args.objective_id,
                    context_id = %context_id,
                    session_id = %session_id,
                    attempt_id = %attempt_id,
                    event_code = "objective.update.wait_condition_string_compat_decoded",
                    "Decoded a single-layer JSON-string wait condition from a Provider tool call; Providers should emit a native object"
                );
            }
            argument.condition
        });
        let reason = args.reason.trim();
        if reason.is_empty() {
            return Err("objective_update.reason must not be empty".into());
        }
        if reason.chars().count() > 10_000 {
            return Err("objective_update.reason exceeds the 10,000-character limit".into());
        }
        let objective = self
            .supervisor
            .get(&args.objective_id)
            .await?
            .ok_or_else(|| format!("Objective '{}' does not exist", args.objective_id))?;
        if objective.context_id != context_id || objective.coordinator_session_id != session_id {
            return Err(format!(
                "the current Session/Context may not modify Objective '{}'",
                args.objective_id
            )
            .into());
        }
        let active = self
            .supervisor
            .evaluations
            .get_for_activation(&attempt_id)
            .ok_or(
                "the current Evaluation does not belong to an Objective and cannot take over another Objective in the shared Context",
            )?;
        if active.objective_id != objective.id {
            return Err(format!(
                "the current Evaluation owns only Objective '{}' and cannot modify '{}'",
                active.objective_id, objective.id
            )
            .into());
        }
        for evidence_ref in &args.evidence_refs {
            if self
                .context_engine
                .find_event(&context_id, evidence_ref)
                .await?
                .is_none()
            {
                return Err(format!(
                    "evidence_ref '{}' does not exist or does not belong to the current Context",
                    evidence_ref
                )
                .into());
            }
        }
        let (status, wait_condition) = match args.status {
            AgentObjectiveStatus::Completed => {
                if wait_condition.is_some() {
                    return Err("a completed Objective cannot carry a wait_condition".into());
                }
                let mutation = self
                    .supervisor
                    .prepare_completion(
                        &args.objective_id,
                        args.base_revision,
                        &active.evaluation_id,
                        canonical_activation_id(&attempt_id),
                        reason,
                        args.evidence_refs.clone(),
                    )
                    .await?;
                return Ok(serde_json::to_string_pretty(
                    &crate::local_time::localized_runtime_json(match mutation {
                        ObjectiveMutation::Updated(updated) => json!({
                            "status": "completion_prepared",
                            "objective_id": updated.id,
                            "revision": updated.revision,
                            "objective_status": updated.status,
                            "objective_phase": "finalizing",
                            "evidence_refs": args.evidence_refs,
                            "next_action": "Return a complete final report with no tools in the current Activation. The final reply is committed atomically with the Objective, Activation, Thread, and ThreadOutcome."
                        }),
                        ObjectiveMutation::Conflict { current } => json!({
                            "status": "revision_conflict",
                            "objective_id": current.id,
                            "expected_revision": args.base_revision,
                            "current_revision": current.revision,
                            "current_stated_objective": current.stated_objective,
                            "current_status": current.status,
                            "current_status_reason": current.status_reason,
                            "wait_condition": current.wait_condition,
                            "completion_intent": current.completion_intent,
                            "guidance": "Re-evaluate from the latest Context Encoding; never overwrite with a stale revision."
                        }),
                        ObjectiveMutation::NotFound => json!({
                            "status": "not_found",
                            "objective_id": args.objective_id
                        }),
                    }),
                )?);
            }
            AgentObjectiveStatus::Blocked => {
                if wait_condition.is_some() {
                    return Err(
                        "an Objective with a deterministic wait_condition must remain active and cannot be marked blocked"
                            .into(),
                    );
                }
                (ObjectiveStatus::Blocked, None)
            }
            AgentObjectiveStatus::Active => {
                let wait_condition = wait_condition.ok_or(
                    "objective_update with status=active must carry a deterministic wait_condition; continue execution when no wait is needed instead of submitting an empty status update",
                )?;
                self.supervisor
                    .validate_wait_condition(&objective, &wait_condition)
                    .await?;
                (ObjectiveStatus::Active, Some(wait_condition))
            }
        };
        let mutation = self
            .supervisor
            .update_state(
                &args.objective_id,
                args.base_revision,
                status,
                wait_condition,
                Some(reason),
            )
            .await?;
        Ok(serde_json::to_string_pretty(
            &crate::local_time::localized_runtime_json(match mutation {
                ObjectiveMutation::Updated(updated) => json!({
                    "status": "committed",
                    "objective_id": updated.id,
                    "revision": updated.revision,
                    "objective_status": updated.status,
                    "wait_condition": updated.wait_condition,
                    "evidence_refs": args.evidence_refs,
                    "next_action": if updated.status == ObjectiveStatus::Blocked {
                        "Return ordinary text with no tools explaining the blocker. The Runtime stops automatic continuation until explicitly resumed."
                    } else if updated.wait_condition.is_some() {
                        "Return ordinary text explaining the wait, or call no_reply when no message is needed. The Runtime wakes the Objective when the condition is satisfied."
                    } else {
                        "Continue advancing the Objective."
                    }
                }),
                ObjectiveMutation::Conflict { current } => json!({
                    "status": "revision_conflict",
                    "objective_id": current.id,
                    "expected_revision": args.base_revision,
                    "current_revision": current.revision,
                    "current_stated_objective": current.stated_objective,
                    "current_status": current.status,
                    "current_status_reason": current.status_reason,
                    "wait_condition": current.wait_condition,
                    "guidance": "Re-evaluate from the latest Context Encoding; never overwrite with a stale revision."
                }),
                ObjectiveMutation::NotFound => json!({
                    "status": "not_found",
                    "objective_id": args.objective_id
                }),
            }),
        )?)
    }
}

#[derive(Debug, Deserialize)]
struct ObjectiveAmendArgs {
    objective_id: String,
    base_revision: u64,
    stated_objective: String,
    reason: String,
    #[serde(default)]
    evidence_refs: Vec<String>,
}

pub struct ObjectiveAmendTool {
    supervisor: Arc<ObjectiveSupervisor>,
    context_engine: Arc<ContextEngine>,
}

impl ObjectiveAmendTool {
    pub fn new(supervisor: Arc<ObjectiveSupervisor>, context_engine: Arc<ContextEngine>) -> Self {
        Self {
            supervisor,
            context_engine,
        }
    }
}

#[async_trait::async_trait]
impl Tool for ObjectiveAmendTool {
    fn name(&self) -> &str {
        "objective_amend"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Amend an existing Objective only when the current DialogueTurn was initiated by the Objective owner's user message. This changes the durable completion contract with revision CAS and queues the correction on the Objective's primary Thread. It preserves lifecycle status, waits, and already-running child work. Objective-bound Evaluations cannot call this tool; they may only use objective_update for lifecycle state.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "objective_id": {
                        "type": "string",
                        "description": "The exact Objective ID named by the user's correction"
                    },
                    "base_revision": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "The latest visible Objective revision"
                    },
                    "stated_objective": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The complete corrected objective, not a patch fragment"
                    },
                    "reason": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Why the current user message changes the Objective contract"
                    },
                    "evidence_refs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional current Context Event refs supporting the correction"
                    }
                },
                "required": ["objective_id", "base_revision", "stated_objective", "reason", "evidence_refs"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, DynError> {
        let args: ObjectiveAmendArgs = serde_json::from_str(arguments)?;
        let session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_amend is missing the current Session injected by Runtime")?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_amend is missing the current Context injected by Runtime")?;
        let attempt_id = CURRENT_ATTEMPT_ID
            .try_with(Clone::clone)
            .map_err(|_| "objective_amend is missing the current Evaluation injected by Runtime")?;
        let route = CURRENT_CAUSAL_ROUTE
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or(
                "objective_amend is missing the DialogueTurn causal route injected by Runtime",
            )?;
        let reason = args.reason.trim();
        if reason.is_empty() || reason.chars().count() > 10_000 {
            return Err("objective_amend.reason must contain 1 to 10,000 characters".into());
        }
        let stated_objective = args.stated_objective.trim();
        if stated_objective.is_empty() {
            return Err("objective_amend.stated_objective must not be empty".into());
        }
        let objective = self
            .supervisor
            .get(&args.objective_id)
            .await?
            .ok_or_else(|| format!("Objective '{}' does not exist", args.objective_id))?;
        if objective.context_id != context_id || objective.coordinator_session_id != session_id {
            return Err(format!(
                "the current Session/Context may not modify Objective '{}'",
                args.objective_id
            )
            .into());
        }
        if self
            .supervisor
            .evaluations
            .get_for_activation(&attempt_id)
            .is_some()
        {
            return Err(
                "an Objective-bound Evaluation may not modify its own completion contract; it may only update lifecycle state"
                    .into(),
            );
        }
        let session_store = self.context_engine.session_store().ok_or(
            "objective_amend requires Runtime SessionStore to verify DialogueTurn authority",
        )?;
        let thread = session_store
            .get_thread(&route.thread_id)
            .await?
            .ok_or_else(|| format!("DialogueTurn Thread '{}' does not exist", route.thread_id))?;
        let trigger = self
            .context_engine
            .find_event(&context_id, &route.trigger_event_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "DialogueTurn trigger Event '{}' does not exist",
                    route.trigger_event_id
                )
            })?;
        if thread.kind != ThreadKind::DialogueTurn
            || thread.context_id != context_id
            || thread.session_id != session_id
            || trigger.event_type != TYPE_USER_MESSAGE
        {
            return Err(
                "objective_amend may only be called by a DialogueTurn triggered by the current user message"
                    .into(),
            );
        }
        let owner_principal_id = objective.initiating_principal_id.as_deref().ok_or(
            "a legacy unowned Objective cannot be amended by the model; use the Dashboard Operator",
        )?;
        let active_principal_id = CURRENT_PRINCIPAL_ID
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("objective_amend is missing an authenticated Principal")?;
        if active_principal_id != owner_principal_id
            || !session_store
                .verify_session_principal(&session_id, &active_principal_id)
                .await?
        {
            return Err(format!(
                "the current Principal may not modify Objective '{}'",
                objective.id
            )
            .into());
        }
        for evidence_ref in &args.evidence_refs {
            if self
                .context_engine
                .find_event(&context_id, evidence_ref)
                .await?
                .is_none()
            {
                return Err(format!(
                    "evidence_ref '{}' does not exist or does not belong to the current Context",
                    evidence_ref
                )
                .into());
            }
        }
        let mutation = self
            .supervisor
            .amend_from_dialogue(
                &objective.id,
                args.base_revision,
                stated_objective,
                reason,
                &trigger,
                &active_principal_id,
            )
            .await?;
        Ok(serde_json::to_string_pretty(
            &crate::local_time::localized_runtime_json(match mutation {
                ObjectiveMutation::Updated(updated) => json!({
                    "status": "committed",
                    "objective_id": updated.id,
                    "revision": updated.revision,
                    "stated_objective": updated.stated_objective,
                    "objective_status": updated.status,
                    "wait_condition": updated.wait_condition,
                    "evidence_refs": args.evidence_refs,
                    "guidance": "The correction is committed and queued on the Objective primary Thread. Existing lifecycle state, waits, and child work were preserved."
                }),
                ObjectiveMutation::Conflict { current } => json!({
                    "status": "revision_conflict",
                    "objective_id": current.id,
                    "expected_revision": args.base_revision,
                    "current_revision": current.revision,
                    "current_stated_objective": current.stated_objective,
                    "current_status": current.status,
                    "wait_condition": current.wait_condition,
                    "guidance": "Reread the latest Objective and reapply the user's correction; never overwrite a newer revision."
                }),
                ObjectiveMutation::NotFound => json!({
                    "status": "not_found",
                    "objective_id": args.objective_id
                }),
            }),
        )?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveObjectiveEvaluation {
    pub objective_id: String,
    pub evaluation_id: String,
    pub revision: u64,
    pub started_at: DateTime<Utc>,
    pub pending_dependency_id: Option<String>,
}

/// Runtime-local routing metadata. The persistent lease in ObjectiveStore is
/// authoritative; this registry only lets Orchestrator stamp terminal IO with
/// the Objective Evaluation that caused it.
pub struct ObjectiveEvaluationRegistry {
    by_objective: DashMap<String, ActiveObjectiveEvaluation>,
    by_activation: DashMap<String, ActiveObjectiveEvaluation>,
    /// A cancellation tombstone is keyed by the persistent Evaluation ID, not
    /// by Session.  It therefore cannot cancel an unrelated dialogue or a
    /// sibling Objective that happens to share the same coordinator Session.
    cancelled_evaluations: DashMap<String, String>,
    cancellation_epoch: watch::Sender<u64>,
}

impl Default for ObjectiveEvaluationRegistry {
    fn default() -> Self {
        let (cancellation_epoch, _) = watch::channel(0);
        Self {
            by_objective: DashMap::new(),
            by_activation: DashMap::new(),
            cancelled_evaluations: DashMap::new(),
            cancellation_epoch,
        }
    }
}

impl ObjectiveEvaluationRegistry {
    pub fn get_for_objective(&self, objective_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.by_objective
            .get(objective_id)
            .map(|entry| entry.clone())
    }

    pub fn get_for_activation(&self, activation_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.by_activation
            .get(canonical_activation_id(activation_id))
            .map(|entry| entry.clone())
    }

    pub fn bind_activation(&self, activation_id: &str, evaluation: ActiveObjectiveEvaluation) {
        self.by_activation.insert(
            canonical_activation_id(activation_id).to_string(),
            evaluation.clone(),
        );
        // Another Activation for the same Evaluation can bind after its peer
        // was cancelled. Bump the epoch after that late bind so it observes
        // the existing tombstone too.
        if self.evaluation_is_cancelled(&evaluation) {
            self.bump_cancellation_epoch();
        }
    }

    pub fn remove_activation(&self, activation_id: &str) {
        if let Some((_, evaluation)) = self
            .by_activation
            .remove(canonical_activation_id(activation_id))
        {
            self.cleanup_cancellation_tombstone(&evaluation);
        }
    }

    pub fn cancel_evaluation(&self, objective_id: &str, evaluation_id: &str) -> bool {
        let active = self.by_activation.iter().any(|entry| {
            entry.objective_id == objective_id && entry.evaluation_id == evaluation_id
        });
        if !active {
            // A not-yet-claimed continuation is rejected against the durable
            // Objective state before model execution, so no process-local
            // tombstone is needed (and none can leak if that route never arrives).
            return false;
        }
        self.cancelled_evaluations
            .insert(evaluation_id.to_string(), objective_id.to_string());
        self.bump_cancellation_epoch();
        true
    }

    pub fn activation_ids_for_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
    ) -> Vec<String> {
        self.by_activation
            .iter()
            .filter(|entry| {
                entry.objective_id == objective_id && entry.evaluation_id == evaluation_id
            })
            .map(|entry| entry.key().clone())
            .collect()
    }

    pub fn clear_cancelled_evaluation(&self, objective_id: &str, evaluation_id: &str) {
        self.cancelled_evaluations
            .remove_if(evaluation_id, |_, cancelled_objective_id| {
                cancelled_objective_id == objective_id
            });
    }

    pub fn cancelled_activation(&self, activation_id: &str) -> Option<ActiveObjectiveEvaluation> {
        self.get_for_activation(activation_id)
            .filter(|evaluation| self.evaluation_is_cancelled(evaluation))
    }

    pub async fn wait_for_activation_cancellation(
        &self,
        activation_id: &str,
    ) -> ActiveObjectiveEvaluation {
        let mut cancellation = self.cancellation_epoch.subscribe();
        loop {
            if let Some(evaluation) = self.cancelled_activation(activation_id) {
                return evaluation;
            }
            // watch retains the latest epoch, so a cancellation between the
            // predicate above and this await cannot be lost.
            let _ = cancellation.changed().await;
        }
    }

    fn try_bind(
        &self,
        objective_id: &str,
        evaluation: ActiveObjectiveEvaluation,
    ) -> Result<(), ActiveObjectiveEvaluation> {
        debug_assert_eq!(objective_id, evaluation.objective_id);
        match self.by_objective.entry(objective_id.to_string()) {
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(evaluation);
                Ok(())
            }
            dashmap::mapref::entry::Entry::Occupied(entry) => Err(entry.get().clone()),
        }
    }

    fn unbind(&self, objective_id: &str, evaluation_id: &str) {
        self.by_objective.remove_if(objective_id, |_, active| {
            active.evaluation_id == evaluation_id
        });
        // Activation routing has a longer lifetime than the Objective scheduling
        // slot. A pause/cancel releases the slot first, then signals the exact
        // running Activation.  The Orchestrator removes this binding only after
        // that Activation reaches a durable terminal state.
    }

    fn evaluation_is_cancelled(&self, evaluation: &ActiveObjectiveEvaluation) -> bool {
        self.cancelled_evaluations
            .get(&evaluation.evaluation_id)
            .is_some_and(|objective_id| objective_id.as_str() == evaluation.objective_id)
    }

    fn cleanup_cancellation_tombstone(&self, evaluation: &ActiveObjectiveEvaluation) {
        let still_bound_to_objective = self.by_objective.iter().any(|entry| {
            entry.objective_id == evaluation.objective_id
                && entry.evaluation_id == evaluation.evaluation_id
        });
        let still_bound_to_work = self.by_activation.iter().any(|entry| {
            entry.objective_id == evaluation.objective_id
                && entry.evaluation_id == evaluation.evaluation_id
        });
        if !still_bound_to_objective && !still_bound_to_work {
            self.clear_cancelled_evaluation(&evaluation.objective_id, &evaluation.evaluation_id);
        }
    }

    fn bump_cancellation_epoch(&self) {
        let next = (*self.cancellation_epoch.borrow()).wrapping_add(1);
        self.cancellation_epoch.send_replace(next);
    }
}

fn canonical_activation_id(attempt_id: &str) -> &str {
    attempt_id
        .split_once("_response_retry_")
        .map(|(base, _)| base)
        .unwrap_or(attempt_id)
}

/// Built-in policy module for persistent Objective scheduling. It owns no task
/// semantics: it only drives active/no-wait Objectives through successive
/// single Evaluations and stops at lifecycle or wait boundaries.
pub struct ObjectiveSupervisor {
    store: Arc<dyn ObjectiveStore>,
    audit_store: Arc<dyn EventStore>,
    execution_jobs: Option<Arc<dyn ExecutionJobStore>>,
    delegations: Option<Arc<dyn DelegationStore>>,
    thread_store: Option<Arc<dyn ThreadStore>>,
    thread_groups: Option<Arc<dyn ThreadGroupStore>>,
    activation_store: Option<Arc<dyn ActivationStore>>,
    scheduler_dependencies: Option<Arc<dyn SchedulerDependencyStore>>,
    scheduler_kernel: Option<Arc<SchedulerKernel>>,
    bus: Arc<InMemoryEventBus>,
    evaluations: Arc<ObjectiveEvaluationRegistry>,
    timers: Arc<TimerEngine>,
    lease_duration: Duration,
    schedule_locks: DashMap<String, Arc<Mutex<()>>>,
    external_wait_subscriptions: DashMap<String, (u64, String, String)>,
    reconcile_dirty_contexts: Arc<DashMap<String, ()>>,
    reconcile_wakeup: Arc<Notify>,
    reconcile_cursor: std::sync::Mutex<Option<ObjectiveRecoveryCursor>>,
    reconcile_full_sweep_pending: AtomicBool,
    started: AtomicBool,
}

impl ObjectiveSupervisor {
    async fn current_scheduler_dependencies(
        &self,
        objective: &ObjectiveRecord,
    ) -> Result<Option<Vec<crate::scheduler::SchedulerDependencyRecord>>, DynError> {
        let Some(dependency_store) = self.scheduler_dependencies.as_ref() else {
            return Ok(None);
        };
        let dependencies = dependency_store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
                owner_id: Some(objective.id.clone()),
                required_only: true,
                ..SchedulerDependencyFilter::default()
            })
            .await?;
        Ok(Some(
            dependencies
                .into_iter()
                .filter(|dependency| dependency.owner_generation == objective.generation)
                .collect(),
        ))
    }

    /// Mark the exact current-generation dependency represented by the legacy
    /// wait projection as satisfied. The Event is the immutable physical fact;
    /// `wait_condition` is cleared only after this fenced transition succeeds.
    async fn satisfy_wait_dependency(
        &self,
        objective: &ObjectiveRecord,
        wait: &ObjectiveWaitCondition,
        event_id: &str,
    ) -> Result<bool, DynError> {
        let Some(store) = self.scheduler_dependencies.as_ref() else {
            return Ok(true);
        };
        let (kind, dependency_id) = objective_wait_dependency_key(wait);
        let dependencies = self
            .current_scheduler_dependencies(objective)
            .await?
            .unwrap_or_default();
        let Some(dependency) = dependencies.into_iter().find(|dependency| {
            dependency.required
                && dependency.status == SchedulerDependencyStatus::Pending
                && dependency.dependency_kind == kind
                && dependency.dependency_id == dependency_id
        }) else {
            // A terminal dependency means replay of the same wake fact. No
            // pending edge means the display projection is stale and may be
            // cleaned by reconciliation; neither case should create a second
            // dependency or reinterpret the Event.
            return Ok(false);
        };
        let mutation = if let Some(kernel) = self.scheduler_kernel.as_ref() {
            match kernel
                .execute(crate::controllers::ObjectiveController::satisfy_dependency(
                    objective,
                    &dependency.id,
                    dependency.dependency_generation,
                    event_id,
                    "ObjectiveSupervisor",
                ))
                .await?
            {
                KernelResult::DependencySatisfied(mutation) => mutation,
                _ => {
                    return Err(
                        "Scheduler Kernel returned an invalid dependency satisfy result".into(),
                    )
                }
            }
        } else {
            store
                .satisfy_scheduler_dependency(
                    &dependency.id,
                    objective.generation,
                    dependency.dependency_generation,
                    event_id,
                )
                .await?
        };
        match mutation {
            SchedulerDependencyMutation::Updated(_) | SchedulerDependencyMutation::Existing(_) => {
                Ok(true)
            }
            SchedulerDependencyMutation::Conflict { current, reason } => Err(format!(
                "failed to satisfy dependency '{}' for Objective '{}' (current={:?}): {}",
                dependency.id, objective.id, current.status, reason
            )
            .into()),
            SchedulerDependencyMutation::NotFound => Err(format!(
                "dependency '{}' for Objective '{}' disappeared while being satisfied",
                dependency.id, objective.id
            )
            .into()),
        }
    }

    pub fn new(
        store: Arc<dyn ObjectiveStore>,
        audit_store: Arc<dyn EventStore>,
        bus: Arc<InMemoryEventBus>,
        evaluations: Arc<ObjectiveEvaluationRegistry>,
        timers: Arc<TimerEngine>,
        lease_duration: std::time::Duration,
    ) -> Self {
        let lease_duration =
            Duration::from_std(lease_duration).unwrap_or_else(|_| Duration::minutes(10));
        Self {
            store,
            audit_store,
            execution_jobs: None,
            delegations: None,
            thread_store: None,
            thread_groups: None,
            activation_store: None,
            scheduler_dependencies: None,
            scheduler_kernel: None,
            bus,
            evaluations,
            timers,
            lease_duration,
            schedule_locks: DashMap::new(),
            external_wait_subscriptions: DashMap::new(),
            reconcile_dirty_contexts: Arc::new(DashMap::new()),
            reconcile_wakeup: Arc::new(Notify::new()),
            reconcile_cursor: std::sync::Mutex::new(None),
            reconcile_full_sweep_pending: AtomicBool::new(false),
            started: AtomicBool::new(false),
        }
    }

    /// Attach the authoritative physical execution projection.  Objective
    /// `tool_task` waits are control-plane dependencies, so an arbitrary model
    /// supplied string must never become a durable wait without resolving to a
    /// real Runtime-managed background ExecutionJob.
    pub fn with_execution_job_store(mut self, store: Arc<dyn ExecutionJobStore>) -> Self {
        self.execution_jobs = Some(store);
        self
    }

    /// Attach the authoritative Delegation projection. An Objective may only
    /// wait for one live, correctly routed child; terminal or missing
    /// Delegations are facts to consume, not conditions that can be awaited.
    pub fn with_delegation_store(mut self, store: Arc<dyn DelegationStore>) -> Self {
        self.delegations = Some(store);
        self
    }

    /// Attach the authoritative Thread projection. Startup recovery uses it
    /// to distinguish a globally unusable Store from one historical
    /// Objective whose immutable primary route can no longer accept work.
    pub fn with_thread_store(mut self, store: Arc<dyn ThreadStore>) -> Self {
        self.thread_store = Some(store);
        self
    }

    /// Attach the authoritative Thread Group projection. Objective waits bind
    /// to a real group in the same Context instead of accepting a model-made
    /// correlation string which could never be satisfied.
    pub fn with_thread_group_store(mut self, store: Arc<dyn ThreadGroupStore>) -> Self {
        self.thread_groups = Some(store);
        self
    }

    /// Attach the physical Activation authority. This lets an expired
    /// Objective Evaluation durably cancel every process-local Activation
    /// bound to its fencing token before a replacement Evaluation is claimed.
    pub fn with_activation_store(mut self, store: Arc<dyn ActivationStore>) -> Self {
        self.activation_store = Some(store);
        self
    }

    /// Attach the authoritative Scheduler v2 dependency projection. During
    /// migration, legacy wait_condition remains a display/compatibility
    /// bridge only when no matching structured dependency exists.
    pub fn with_scheduler_dependency_store(
        mut self,
        store: Arc<dyn SchedulerDependencyStore>,
    ) -> Self {
        self.scheduler_dependencies = Some(store);
        self
    }

    /// Attach the sole production mutation boundary for scheduler state.
    /// Tests that construct the policy module in isolation retain the narrow
    /// direct-store fallback until their fixtures are migrated.
    pub fn with_scheduler_kernel(mut self, kernel: Arc<SchedulerKernel>) -> Self {
        self.scheduler_kernel = Some(kernel);
        self
    }

    /// Execute one Objective lifecycle transition through the Scheduler
    /// Kernel. The direct Store branch exists only for narrow unit fixtures
    /// which construct this policy component without the production Runtime
    /// assembly; every assembled Runtime injects the Kernel.
    async fn transition_objective(
        &self,
        objective: &ObjectiveRecord,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
        causation_id: &str,
        actor: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        if let Some(kernel) = self.scheduler_kernel.as_ref() {
            return match kernel
                .execute(crate::controllers::ObjectiveController::control(
                    objective,
                    status,
                    wait_condition,
                    reason.map(str::to_string),
                    causation_id,
                    actor,
                ))
                .await?
            {
                KernelResult::ObjectiveControlled(mutation) => Ok(mutation),
                _ => Err("Scheduler Kernel returned an invalid Objective control result".into()),
            };
        }
        self.store
            .update_objective_state(
                &objective.id,
                objective.revision,
                status,
                wait_condition,
                reason,
            )
            .await
    }

    async fn claim_objective_evaluation(
        &self,
        objective: &ObjectiveRecord,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        continuation: Option<(Event, NewThread)>,
        causation_id: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        if let Some(kernel) = self.scheduler_kernel.as_ref() {
            return match kernel
                .execute(crate::controllers::ObjectiveController::claim_evaluation(
                    objective,
                    evaluation_id,
                    lease_expires_at,
                    continuation,
                    causation_id,
                    "ObjectiveSupervisor",
                ))
                .await?
            {
                KernelResult::ObjectiveEvaluationMutated(mutation) => Ok(mutation),
                _ => Err(
                    "Scheduler Kernel returned an invalid Objective evaluation claim result".into(),
                ),
            };
        }
        match continuation {
            Some((event, thread)) => {
                self.store
                    .claim_objective_evaluation_with_signal(
                        &objective.id,
                        objective.revision,
                        evaluation_id,
                        lease_expires_at,
                        &event,
                        &thread,
                    )
                    .await
            }
            None => {
                self.store
                    .claim_objective_evaluation(
                        &objective.id,
                        objective.revision,
                        evaluation_id,
                        lease_expires_at,
                    )
                    .await
            }
        }
    }

    async fn claim_objective_interrupt_evaluation(
        &self,
        objective: &ObjectiveRecord,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        pending_dependency_id: &str,
        causation_id: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        if let Some(kernel) = self.scheduler_kernel.as_ref() {
            return match kernel
                .execute(
                    crate::controllers::ObjectiveController::claim_interrupt_evaluation(
                        objective,
                        evaluation_id,
                        lease_expires_at,
                        pending_dependency_id,
                        causation_id,
                        "ObjectiveSupervisor",
                    ),
                )
                .await?
            {
                KernelResult::ObjectiveEvaluationMutated(mutation) => Ok(mutation),
                _ => Err(
                    "Scheduler Kernel returned an invalid Objective interrupt evaluation claim result"
                        .into(),
                ),
            };
        }
        self.store
            .claim_objective_interrupt_evaluation(
                &objective.id,
                objective.revision,
                evaluation_id,
                lease_expires_at,
                pending_dependency_id,
            )
            .await
    }

    async fn renew_objective_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
        lease_expires_at: DateTime<Utc>,
        pending_dependency_id: Option<&str>,
        causation_id: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        let Some(objective) = self.store.get_objective(objective_id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if let Some(kernel) = self.scheduler_kernel.as_ref() {
            return match kernel
                .execute(crate::controllers::ObjectiveController::renew_evaluation(
                    &objective,
                    evaluation_id,
                    lease_expires_at,
                    pending_dependency_id,
                    causation_id,
                    "ObjectiveSupervisor",
                ))
                .await?
            {
                KernelResult::ObjectiveEvaluationMutated(mutation) => Ok(mutation),
                _ => Err(
                    "Scheduler Kernel returned an invalid Objective evaluation renew result".into(),
                ),
            };
        }
        if let Some(pending_dependency_id) = pending_dependency_id {
            self.store
                .renew_objective_interrupt_evaluation(
                    objective_id,
                    evaluation_id,
                    lease_expires_at,
                    pending_dependency_id,
                )
                .await
        } else {
            self.store
                .renew_objective_evaluation(objective_id, evaluation_id, lease_expires_at)
                .await
        }
    }

    async fn prepare_objective_completion_transition(
        &self,
        objective: &ObjectiveRecord,
        evaluation_id: &str,
        activation_id: &str,
        reason: &str,
        evidence_refs: Vec<String>,
    ) -> Result<ObjectiveMutation, DynError> {
        if let Some(kernel) = self.scheduler_kernel.as_ref() {
            return match kernel
                .execute(crate::controllers::ObjectiveController::prepare_completion(
                    objective,
                    evaluation_id,
                    activation_id,
                    reason,
                    evidence_refs,
                    activation_id,
                    "ObjectiveSupervisor",
                ))
                .await?
            {
                KernelResult::ObjectiveEvaluationMutated(mutation) => Ok(mutation),
                _ => Err("Scheduler Kernel returned an invalid Objective completion result".into()),
            };
        }
        self.store
            .prepare_objective_completion(
                &objective.id,
                objective.revision,
                evaluation_id,
                activation_id,
                reason,
                &evidence_refs,
            )
            .await
    }

    async fn finish_objective_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
        tokens_used: u64,
        time_used_seconds: u64,
        causation_id: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        let Some(objective) = self.store.get_objective(objective_id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if let Some(kernel) = self.scheduler_kernel.as_ref() {
            return match kernel
                .execute(crate::controllers::ObjectiveController::finish_evaluation(
                    &objective,
                    evaluation_id,
                    tokens_used,
                    time_used_seconds,
                    causation_id,
                    "ObjectiveSupervisor",
                ))
                .await?
            {
                KernelResult::ObjectiveEvaluationMutated(mutation) => Ok(mutation),
                _ => Err(
                    "Scheduler Kernel returned an invalid Objective evaluation finish result"
                        .into(),
                ),
            };
        }
        self.store
            .finish_objective_evaluation(
                objective_id,
                evaluation_id,
                tokens_used,
                time_used_seconds,
            )
            .await
    }

    async fn resolve_tool_task_wait(
        &self,
        objective: &ObjectiveRecord,
        task_id: &str,
    ) -> Result<ExecutionJobRecord, DynError> {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Err("tool_task.task_id must not be empty".into());
        }
        let store = self
            .execution_jobs
            .as_ref()
            .ok_or("the current Runtime has no ExecutionJob Store and cannot establish a verifiable tool_task wait")?;
        let job = store
            .get_execution_job(task_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "tool_task '{}' does not exist. Use only a task_id explicitly returned by Runtime from an execution=background tool result; do not use artifact_path, a synchronous command ID, or a guessed ID",
                    task_id
                )
            })?;
        if job.context_id != objective.context_id
            || job.session_id != objective.coordinator_session_id
            || job.agent_id != objective.agent_id
        {
            return Err(format!(
                "tool_task '{}' does not belong to the current Objective's Agent/Context/Session; cross-route wait rejected",
                task_id
            )
            .into());
        }
        if objective.initiating_principal_id.is_some()
            && job.initiating_principal_id != objective.initiating_principal_id
        {
            return Err(format!(
                "tool_task '{}' does not belong to the current Objective's identity; cross-identity wait rejected",
                task_id
            )
            .into());
        }
        if job.tool_name != "exec/background" {
            return Err(format!(
                "ExecutionJob '{}' is '{}' rather than a waitable Runtime background task; only a task_id returned by execution=background may be used for tool_task",
                task_id, job.tool_name
            )
            .into());
        }
        Ok(job)
    }

    pub async fn validate_wait_condition(
        &self,
        objective: &ObjectiveRecord,
        wait: &ObjectiveWaitCondition,
    ) -> Result<(), DynError> {
        match wait {
            ObjectiveWaitCondition::ToolTask { task_id } => {
                let job = self.resolve_tool_task_wait(objective, task_id).await?;
                if job.status.is_terminal() {
                    return Err(format!(
                        "tool_task '{}' is already terminal (status={}{}); a wait cannot be registered. Continue the Objective using the existing result",
                        task_id,
                        job.status.as_str(),
                        job.result_event_id
                            .as_deref()
                            .map(|event_id| format!(", result_event_id={event_id}"))
                            .unwrap_or_default()
                    )
                    .into());
                }
            }
            ObjectiveWaitCondition::Delegation { delegation_id } => {
                let Some(store) = self.delegations.as_ref() else {
                    return Ok(());
                };
                let delegation = store
                    .get_delegation(delegation_id)
                    .await?
                    .ok_or_else(|| format!("delegation '{}' does not exist", delegation_id))?;
                if delegation.parent_context_id != objective.context_id
                    || delegation.parent_session_id != objective.coordinator_session_id
                    || delegation.agent_id != objective.agent_id
                {
                    return Err(format!(
                        "delegation '{}' does not belong to the current Objective's Agent/Context/Session; cross-route wait rejected",
                        delegation_id
                    )
                    .into());
                }
                if objective.initiating_principal_id.is_some()
                    && delegation.initiating_principal_id != objective.initiating_principal_id
                {
                    return Err(format!(
                        "delegation '{}' does not belong to the current Objective's identity; cross-identity wait rejected",
                        delegation_id
                    )
                    .into());
                }
                if matches!(
                    delegation.status,
                    DelegationStatus::Completed
                        | DelegationStatus::Failed
                        | DelegationStatus::Cancelled
                ) {
                    return Err(format!(
                        "delegation '{}' is already terminal (status={}{}); a wait cannot be registered. Continue the Objective using the existing result",
                        delegation_id,
                        delegation.status.as_str(),
                        delegation
                            .result_event_id
                            .as_deref()
                            .map(|event_id| format!(", result_event_id={event_id}"))
                            .unwrap_or_default()
                    )
                    .into());
                }
            }
            ObjectiveWaitCondition::ThreadGroup { group_id } => {
                let group_id = group_id.trim();
                if group_id.is_empty() {
                    return Err("thread_group.group_id must not be empty".into());
                }
                let store = self.thread_groups.as_ref().ok_or(
                    "the current Runtime has no ThreadGroup Store and cannot establish a verifiable thread_group wait",
                )?;
                let group = store
                    .get_thread_group(group_id)
                    .await?
                    .ok_or_else(|| format!("thread_group '{}' does not exist", group_id))?;
                if group.context_id != objective.context_id
                    || group.session_id != objective.coordinator_session_id
                    || group.supervisor_kind != ThreadSupervisorKind::Objective
                    || group.supervisor_id != objective.id
                {
                    return Err(format!(
                        "thread_group '{}' is not supervised by the current Objective/Context/Session; cross-route wait rejected",
                        group_id
                    )
                    .into());
                }
                if group.status.is_terminal() {
                    return Err(format!(
                        "thread_group '{}' is already terminal (status={}); a wait cannot be registered. Consume the existing Outcome and continue",
                        group_id,
                        group.status.as_str()
                    )
                    .into());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn register_timer_handlers(self: &Arc<Self>) -> Result<(), DynError> {
        let supervisor = Arc::downgrade(self);
        self.timers
            .register_handler(RuntimeTimerKind::ObjectiveWait, move |timer| {
                let supervisor = supervisor.clone();
                async move {
                    let Some(supervisor) = supervisor.upgrade() else {
                        return Ok(TimerDisposition::Complete);
                    };
                    supervisor.dispatch_wait_timer(timer).await
                }
            })?;

        let supervisor = Arc::downgrade(self);
        self.timers
            .register_handler(RuntimeTimerKind::ObjectiveLease, move |timer| {
                let supervisor = supervisor.clone();
                async move {
                    let Some(supervisor) = supervisor.upgrade() else {
                        return Ok(TimerDisposition::Complete);
                    };
                    supervisor.dispatch_lease_timer(timer).await
                }
            })
    }

    /// Return an operator-facing reason only when the persisted primary
    /// Thread makes this one Objective impossible to resume. A missing Thread
    /// is recoverable because the scheduling transaction may create it. A
    /// terminal or differently owned Thread at the stable ID is not
    /// recoverable without rewriting immutable history and must be isolated.
    async fn startup_primary_route_attention(
        &self,
        objective: &ObjectiveRecord,
    ) -> Result<Option<(String, String)>, DynError> {
        let Some(store) = self.thread_store.as_ref() else {
            return Ok(None);
        };
        let root_turn_id =
            crate::memory::objective_primary_execution_root_id(&objective.id, objective.generation);
        let thread_id = stable_thread_id(&root_turn_id);
        let Some(thread) = store.get_thread(&thread_id).await? else {
            return Ok(None);
        };
        if thread.lifecycle.is_terminal() {
            return Ok(Some((
                thread_id,
                format!(
                    "the Objective's fixed primary Thread is already terminal ('{}') and cannot receive a recovery Signal; this inconsistency is limited to one historical task and does not prevent other Runtime tasks from starting",
                    thread.lifecycle.as_str()
                ),
            )));
        }
        let expected_supervision =
            ThreadSupervision::objective_primary_execution(&objective.id, objective.generation);
        if thread.agent_id != objective.agent_id
            || thread.context_id != objective.context_id
            || thread.session_id != objective.coordinator_session_id
            || thread.initiating_principal_id != objective.initiating_principal_id
            || thread.root_turn_id != root_turn_id
            || thread.kind != ThreadKind::Execution
            || thread.executor_kind != "self"
            || thread.supervision != expected_supervision
        {
            return Ok(Some((
                thread_id,
                "the Objective's fixed primary Thread exists, but its Agent/Context/Session/Principal or supervision route is inconsistent with the current Objective; Runtime will not guess or rewrite historical routing"
                    .to_string(),
            )));
        }
        Ok(None)
    }

    /// Quarantine one record-local recovery failure. Store connectivity,
    /// schema and transaction failures still propagate and remain fatal to
    /// startup; only a semantically proven impossible Objective route reaches
    /// this method.
    async fn isolate_startup_objective(
        &self,
        objective: ObjectiveRecord,
        thread_id: &str,
        reason: &str,
    ) -> Result<(), DynError> {
        let mut current = objective;
        for _ in 0..3 {
            if current.status != ObjectiveStatus::Active {
                return Ok(());
            }
            if let Some(evaluation_id) = current.active_evaluation_id.clone() {
                match self
                    .finish_objective_evaluation(
                        &current.id,
                        &evaluation_id,
                        0,
                        0,
                        "startup-recovery-attention",
                    )
                    .await?
                {
                    ObjectiveMutation::Updated(updated)
                    | ObjectiveMutation::Conflict { current: updated } => {
                        current = updated;
                        continue;
                    }
                    ObjectiveMutation::NotFound => return Ok(()),
                }
            }
            match self
                .transition_objective(
                    &current,
                    ObjectiveStatus::Blocked,
                    None,
                    Some(reason),
                    thread_id,
                    "ObjectiveSupervisor-Recovery",
                )
                .await?
            {
                ObjectiveMutation::Updated(blocked) => {
                    tracing::warn!(
                        objective_id = %blocked.id,
                        context_id = %blocked.context_id,
                        thread_id,
                        reason,
                        event_code = "objective.startup_recovery.attention_required",
                        "Isolated an unrecoverable historical Objective route; Runtime startup will continue"
                    );
                    self.publish_recovery_attention(&blocked, thread_id, reason)
                        .await?;
                    return Ok(());
                }
                ObjectiveMutation::Conflict { current: changed } => current = changed,
                ObjectiveMutation::NotFound => return Ok(()),
            }
        }
        tracing::warn!(
            objective_id = %current.id,
            context_id = %current.context_id,
            thread_id,
            reason,
            event_code = "objective.startup_recovery.attention_deferred",
            "Could not quarantine one concurrently changing Objective; skipped it without blocking Runtime startup"
        );
        Ok(())
    }

    pub async fn start(self: Arc<Self>) -> Result<(), DynError> {
        if self.started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        let supervisor = Arc::clone(&self);
        self.bus.subscribe(
            "objective/*".to_string(),
            Arc::new(move |event| {
                let supervisor = Arc::clone(&supervisor);
                Box::pin(async move { supervisor.handle_objective_event(event).await })
            }),
        );
        for topic in [
            "runtime/approval_decision",
            "runtime/resource_available",
            "runtime/thread_group_terminal",
        ] {
            let supervisor = Arc::clone(&self);
            self.bus.subscribe(
                topic.to_string(),
                Arc::new(move |event| {
                    let supervisor = Arc::clone(&supervisor);
                    Box::pin(async move { supervisor.wake_non_routed_event(&event).await })
                }),
            );
        }
        let supervisor = Arc::clone(&self);
        self.bus.subscribe(
            "runtime/thread_terminal".to_string(),
            Arc::new(move |event| {
                let supervisor = Arc::clone(&supervisor);
                Box::pin(async move { supervisor.handle_objective_event(event).await })
            }),
        );
        // Event delivery is a latency hint, not the only way an Objective may
        // discover an already committed fact. Coalesce causal mutations by
        // Context so transient asynchronous-handler failures are repaired
        // online without polling idle Contexts or replaying all persisted Events.
        let dirty_contexts = Arc::clone(&self.reconcile_dirty_contexts);
        let reconcile_wakeup = Arc::clone(&self.reconcile_wakeup);
        self.bus.subscribe(
            "*".to_string(),
            Arc::new(move |event| {
                if objective_reconcile_event(&event) {
                    if let Some(context_id) = event
                        .payload
                        .get("context_id")
                        .and_then(serde_json::Value::as_str)
                    {
                        dirty_contexts.insert(context_id.to_string(), ());
                        reconcile_wakeup.notify_one();
                    }
                }
                Box::pin(async { Ok(()) })
            }),
        );
        for mut objective in self.store.list_recoverable_objectives().await? {
            self.publish_recovery_observation(&objective).await?;
            if let Some(intent) = objective.completion_intent.clone() {
                let matching_owner = objective.status == ObjectiveStatus::Active
                    && objective.active_evaluation_id.as_deref()
                        == Some(intent.evaluation_id.as_str());
                let activation = if matching_owner {
                    if let Some(store) = self.activation_store.as_ref() {
                        store.get_thread_activation(&intent.activation_id).await?
                    } else {
                        None
                    }
                } else {
                    None
                };
                let activation_recoverable = activation.as_ref().is_some_and(|activation| {
                    !matches!(
                        activation.status,
                        ThreadActivationStatus::Succeeded
                            | ThreadActivationStatus::Failed
                            | ThreadActivationStatus::Cancelled
                    )
                });
                if matching_owner && activation_recoverable {
                    if !objective
                        .evaluation_lease_expires_at
                        .is_some_and(|expires_at| expires_at > Utc::now())
                    {
                        if let ObjectiveMutation::Updated(renewed) = self
                            .renew_objective_evaluation(
                                &objective.id,
                                &intent.evaluation_id,
                                Utc::now() + self.lease_duration,
                                None,
                                "completion-recovery",
                            )
                            .await?
                        {
                            objective = renewed;
                        }
                    }
                    let binding = ActiveObjectiveEvaluation {
                        objective_id: objective.id.clone(),
                        evaluation_id: intent.evaluation_id.clone(),
                        revision: objective.revision,
                        started_at: intent.requested_at,
                        pending_dependency_id: None,
                    };
                    let _ = self.evaluations.try_bind(&objective.id, binding.clone());
                    self.evaluations
                        .bind_activation(&intent.activation_id, binding);
                    self.publish_state_event(
                        "completion_recovered",
                        &objective,
                        Some(&intent.activation_id),
                    )
                    .await?;
                } else if matching_owner {
                    if let ObjectiveMutation::Updated(released) = self
                        .finish_objective_evaluation(
                            &objective.id,
                            &intent.evaluation_id,
                            0,
                            0,
                            "completion-recovery-invalidated",
                        )
                        .await?
                    {
                        objective = released;
                        self.publish_state_event(
                            "completion_invalidated",
                            &objective,
                            Some(&intent.activation_id),
                        )
                        .await?;
                    }
                }
            }
            if objective.status != ObjectiveStatus::Active {
                if let Some(evaluation_id) = objective.active_evaluation_id.as_deref() {
                    if let ObjectiveMutation::Updated(recovered) = self
                        .finish_objective_evaluation(
                            &objective.id,
                            evaluation_id,
                            0,
                            0,
                            "runtime-recovery",
                        )
                        .await?
                    {
                        objective = recovered;
                        self.publish_state_event("recovered_evaluation_released", &objective, None)
                            .await?;
                    }
                }
            }
            if objective.status == ObjectiveStatus::Active
                && objective.wait_condition.as_ref().is_some_and(|wait| {
                    matches!(
                        wait,
                        ObjectiveWaitCondition::ResourceAvailable { resource }
                            if resource.starts_with("model-provider:")
                                || resource.starts_with("context-maintenance:")
                                || resource.starts_with("runtime-recovery:")
                    )
                })
            {
                // Provider circuits and Context maintenance owners are
                // process-local execution authority. After a restart no old
                // owner can still be running, so retaining their durable wait
                // forever would strand the Objective. Clear only Runtime-owned
                // resource namespaces; external ResourceAvailable waits still
                // require their real signal.
                if let ObjectiveMutation::Updated(recovered) = self
                    .transition_objective(
                        &objective,
                        ObjectiveStatus::Active,
                        None,
                        Some("release invalid internal recovery wait after Runtime restart and reevaluate"),
                        "runtime-recovery",
                        "ObjectiveSupervisor-Recovery",
                    )
                    .await?
                {
                    objective = recovered;
                    self.publish_state_event("runtime_recovery_wait_released", &objective, None)
                        .await?;
                }
            }
            if objective.status == ObjectiveStatus::Active {
                if let Some((thread_id, reason)) =
                    self.startup_primary_route_attention(&objective).await?
                {
                    self.isolate_startup_objective(objective, &thread_id, &reason)
                        .await?;
                    continue;
                }
            }
            if objective.status == ObjectiveStatus::Active {
                if let Some(event) = self.find_persisted_wait_event(&objective).await? {
                    tracing::info!(
                        objective_id = %objective.id,
                        event_id = %event.id,
                        event_topic = %event.topic,
                        event_code = "objective.startup_recovery.completion_event_found",
                        "Objective startup recovery found a persisted awaited completion Event"
                    );
                    self.wake_non_routed_event(&event).await?;
                    continue;
                }
            }
            self.reconcile(objective).await?;
        }
        self.start_continuous_reconciler();
        Ok(())
    }

    fn start_continuous_reconciler(self: &Arc<Self>) {
        let supervisor = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut next_fallback =
                tokio::time::Instant::now() + OBJECTIVE_RECONCILE_FALLBACK_INTERVAL;
            loop {
                let Some(current) = supervisor.upgrade() else {
                    break;
                };
                let wakeup = Arc::clone(&current.reconcile_wakeup);
                drop(current);
                let full_reconcile = tokio::select! {
                    _ = wakeup.notified() => supervisor.upgrade().is_some_and(|current| {
                        current
                            .reconcile_full_sweep_pending
                            .swap(false, Ordering::AcqRel)
                    }),
                    _ = tokio::time::sleep_until(next_fallback) => true,
                };
                if full_reconcile {
                    next_fallback =
                        tokio::time::Instant::now() + OBJECTIVE_RECONCILE_FALLBACK_INTERVAL;
                }
                let Some(current) = supervisor.upgrade() else {
                    break;
                };
                if let Err(error) = current.reconcile_continuous_batch(full_reconcile).await {
                    tracing::error!(
                        %error,
                        event_code = "objective.continuous_reconcile.failed",
                        "Continuous Objective convergence failed; durable state will be retried"
                    );
                }
            }
        });
    }

    async fn reconcile_continuous_batch(
        self: &Arc<Self>,
        full_reconcile: bool,
    ) -> Result<usize, DynError> {
        let dirty_context_ids = self
            .reconcile_dirty_contexts
            .iter()
            .take(OBJECTIVE_RECONCILE_DIRTY_CONTEXT_BATCH)
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        let mut reconciled = 0usize;
        for context_id in dirty_context_ids {
            if self.reconcile_dirty_contexts.remove(&context_id).is_none() {
                continue;
            }
            match self.store.list_context_objectives(&context_id, false).await {
                Ok(objectives) => {
                    for objective in objectives {
                        if let Err(error) = self
                            .reconcile_durable_objective(objective, full_reconcile)
                            .await
                        {
                            tracing::warn!(
                                context_id,
                                %error,
                                event_code = "objective.continuous_reconcile.context_failed",
                                "Objective convergence for a dirty Context failed; retaining the invalidation"
                            );
                            self.reconcile_dirty_contexts.insert(context_id.clone(), ());
                            break;
                        }
                        reconciled = reconciled.saturating_add(1);
                    }
                }
                Err(error) => {
                    self.reconcile_dirty_contexts.insert(context_id.clone(), ());
                    tracing::warn!(
                        context_id,
                        %error,
                        event_code = "objective.continuous_reconcile.context_read_failed",
                        "Could not read a dirty Objective Context; retaining it for retry"
                    );
                }
            }
        }

        if !full_reconcile {
            return Ok(reconciled);
        }

        let cursor = self
            .reconcile_cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let page = self
            .store
            .list_recoverable_objectives_page(cursor.as_ref(), OBJECTIVE_RECONCILE_BATCH)
            .await?;
        if page.is_empty() {
            *self
                .reconcile_cursor
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        } else {
            for objective in &page {
                if let Err(error) = self
                    .reconcile_durable_objective(objective.clone(), full_reconcile)
                    .await
                {
                    tracing::warn!(
                        objective_id = %objective.id,
                        context_id = %objective.context_id,
                        %error,
                        event_code = "objective.continuous_reconcile.objective_failed",
                        "One Objective failed continuous convergence; the round-robin cursor will revisit it"
                    );
                    self.reconcile_dirty_contexts
                        .insert(objective.context_id.clone(), ());
                } else {
                    reconciled = reconciled.saturating_add(1);
                }
            }
            if page.len() == OBJECTIVE_RECONCILE_BATCH {
                let last = page
                    .last()
                    .expect("a full Objective recovery page cannot be empty");
                *self
                    .reconcile_cursor
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some(ObjectiveRecoveryCursor {
                        created_at: last.created_at,
                        id: last.id.clone(),
                    });
            } else {
                *self
                    .reconcile_cursor
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            }
        }
        if page.len() == OBJECTIVE_RECONCILE_BATCH {
            self.reconcile_full_sweep_pending
                .store(true, Ordering::Release);
            self.reconcile_wakeup.notify_one();
        }
        Ok(reconciled)
    }

    async fn reconcile_durable_objective(
        self: &Arc<Self>,
        objective: ObjectiveRecord,
        full_reconcile: bool,
    ) -> Result<(), DynError> {
        // The page/Context snapshot is only a candidate set. Re-read the row
        // before any Timer or scheduling side effect so a concurrent cancel,
        // pause, wait transition, or Evaluation claim cannot be undone by a
        // stale continuous-recovery snapshot.
        let Some(objective) = self.store.get_objective(&objective.id).await? else {
            return Ok(());
        };
        if objective.status == ObjectiveStatus::Active {
            if let Some(event) = self.find_persisted_wait_event(&objective).await? {
                self.wake_non_routed_event(&event).await?;
                return Ok(());
            }
            // ToolTask, Delegation, Timer and legacy projection waits have a
            // normal routed owner in the live process. Let that path claim the
            // exact Event first; otherwise the repairer can clear the wait
            // while the same Event is still becoming a routed Activation.
            // The independent fallback deadline performs projection recovery
            // if that owner actually failed.
            if !full_reconcile {
                return Ok(());
            }
            let orphaned_without_evaluation = objective.active_evaluation_id.is_none()
                && Utc::now() - objective.updated_at >= OBJECTIVE_ORPHAN_SCHEDULE_GRACE;
            if objective.wait_condition.is_some()
                || orphaned_without_evaluation
                || objective
                    .evaluation_lease_expires_at
                    .is_some_and(|expires_at| expires_at <= Utc::now())
            {
                return self.reconcile(objective).await;
            }
            // A live leased Evaluation owns progress. A fresh active/no-wait
            // row may also be between a routed wait-clear commit and its
            // immediate Evaluation claim; scheduling it here would create a
            // second Evaluation. Only the fallback pass after a short grace
            // repairs a genuinely orphaned row.
            return Ok(());
        }
        if full_reconcile && objective.active_evaluation_id.is_some() {
            return self.reconcile(objective).await;
        }
        Ok(())
    }

    pub fn evaluations(&self) -> Arc<ObjectiveEvaluationRegistry> {
        Arc::clone(&self.evaluations)
    }

    pub fn store(&self) -> Arc<dyn ObjectiveStore> {
        Arc::clone(&self.store)
    }

    pub async fn create(
        self: &Arc<Self>,
        objective: NewObjective,
    ) -> Result<ObjectiveRecord, DynError> {
        let created = self.store.create_objective(objective).await?;
        self.activate_created_objective(created).await
    }

    /// Creates one Objective together with immutable initialization facts
    /// before the Supervisor is allowed to schedule its first Evaluation.
    pub async fn create_with_initial_events(
        self: &Arc<Self>,
        objective: NewObjective,
        events: Vec<Event>,
    ) -> Result<ObjectiveRecord, DynError> {
        let created = self
            .store
            .create_objective_with_events(objective, events)
            .await?;
        self.activate_created_objective(created).await
    }

    async fn activate_created_objective(
        self: &Arc<Self>,
        created: ObjectiveRecord,
    ) -> Result<ObjectiveRecord, DynError> {
        self.publish_state_event("created", &created, None).await?;
        let supervisor = Arc::clone(self);
        let created_for_reconcile = created.clone();
        // Objective creation may run inside a model tool prelude whose poll
        // stack already contains Context compilation and protocol handling.
        // First-Evaluation admission is a separate scheduler phase: execute
        // it as a task root, while still awaiting and propagating its result.
        tokio::spawn(async move { supervisor.reconcile(created_for_reconcile).await })
            .await
            .map_err(|error| format!("Objective initial reconciliation task failed: {error}"))??;
        Ok(created)
    }

    pub async fn get(&self, id: &str) -> Result<Option<ObjectiveRecord>, DynError> {
        self.store.get_objective(id).await
    }

    /// Admit an embedded Objective route against the durable lease before the
    /// Orchestrator starts model work. This rejects a continuation queued
    /// before pause/cancel and refreshes a live Evaluation near its renewal
    /// boundary, including across chains of short Activations.
    pub async fn admit_routed_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
        objective_control_receipt: bool,
        activation_id: &str,
    ) -> Result<bool, DynError> {
        let Some(objective) = self.store.get_objective(objective_id).await? else {
            return Ok(false);
        };
        if objective_control_receipt
            && matches!(
                objective.status,
                ObjectiveStatus::Blocked | ObjectiveStatus::Completed | ObjectiveStatus::Failed
            )
        {
            return Ok(true);
        }
        let now = Utc::now();
        let Some(current_lease_expires_at) = objective.evaluation_lease_expires_at else {
            return Ok(false);
        };
        if objective.status != ObjectiveStatus::Active
            || objective.active_evaluation_id.as_deref() != Some(evaluation_id)
            || current_lease_expires_at <= now
        {
            return Ok(false);
        }
        // The tool receipt that installed a durable wait must be allowed to
        // produce its final explanatory/no-reply response, but a waiting
        // Objective deliberately rejects lease renewal. It is already fenced
        // by the exact Evaluation route above and this receipt performs no new
        // Objective work.
        if objective_control_receipt {
            return Ok(true);
        }

        // An Objective Evaluation spans a chain of Activations. Tool outputs
        // and no-reply continuations can make every individual Activation
        // shorter than one heartbeat interval. Treat admission of each exact
        // routed Activation as durable liveness and renew before model work
        // begins when the remaining lease is below a safe margin; otherwise a
        // continuously advancing Evaluation can expire between periodic
        // heartbeats. The half-lease threshold bounds this to roughly one
        // durable write per half lease instead of one write per Activation.
        if current_lease_expires_at > now + self.lease_duration / 2 {
            return Ok(true);
        }
        let lease_expires_at = now + self.lease_duration;
        let pending_dependency_id = self
            .evaluations
            .get_for_activation(activation_id)
            .and_then(|binding| binding.pending_dependency_id);
        Ok(matches!(
            self.renew_objective_evaluation(
                objective_id,
                evaluation_id,
                lease_expires_at,
                pending_dependency_id.as_deref(),
                activation_id,
            )
            .await?,
            ObjectiveMutation::Updated(_)
        ))
    }

    /// Check the durable Objective fencing token owned by one Activation.
    /// Activations without an Objective route are not fenced here.
    pub async fn activation_fence_is_current(&self, activation_id: &str) -> Result<bool, DynError> {
        let Some(binding) = self.evaluations.get_for_activation(activation_id) else {
            return Ok(true);
        };
        if self.evaluations.evaluation_is_cancelled(&binding) {
            return Ok(false);
        }
        let Some(objective) = self.store.get_objective(&binding.objective_id).await? else {
            return Ok(false);
        };
        if objective.status != ObjectiveStatus::Active
            || objective.active_evaluation_id.as_deref() != Some(binding.evaluation_id.as_str())
            || !objective
                .evaluation_lease_expires_at
                .is_some_and(|expires_at| expires_at > Utc::now())
        {
            return Ok(false);
        }
        if let Some(dependencies) = self.current_scheduler_dependencies(&objective).await? {
            if let Some(pending_dependency_id) = binding.pending_dependency_id.as_deref() {
                let exact_pending = dependencies.iter().any(|dependency| {
                    dependency.id == pending_dependency_id
                        && dependency.required
                        && dependency.status == SchedulerDependencyStatus::Pending
                });
                let competing_pending = dependencies.iter().any(|dependency| {
                    dependency.id != pending_dependency_id
                        && dependency.required
                        && dependency.status == SchedulerDependencyStatus::Pending
                });
                return Ok(exact_pending && !competing_pending);
            }
            return Ok(!matches!(
                derive_objective_readiness(&objective, &dependencies, Utc::now()),
                ObjectiveReadiness::Waiting { .. }
            ));
        }
        // Isolated compatibility fixtures without Scheduler v2 still use the
        // legacy display field as their readiness authority.
        Ok(objective.wait_condition.is_none())
    }

    /// Keep one exact Evaluation lease alive while its Activation is running.
    /// A replacement Evaluation changes `active_evaluation_id`; the stale
    /// heartbeat then loses the fence and returns so Orchestrator can cancel
    /// the old Activation before it performs more work.
    pub async fn maintain_activation_lease(
        &self,
        activation_id: &str,
    ) -> Result<ActiveObjectiveEvaluation, DynError> {
        let binding = self
            .evaluations
            .get_for_activation(activation_id)
            .ok_or_else(|| {
                format!("Activation '{activation_id}' is missing an Objective Evaluation route")
            })?;
        let lease_duration = self
            .lease_duration
            .to_std()
            .unwrap_or_else(|_| std::time::Duration::from_secs(600));
        let heartbeat = (lease_duration / 3).max(std::time::Duration::from_millis(50));
        loop {
            tokio::time::sleep(heartbeat).await;
            if self.evaluations.evaluation_is_cancelled(&binding) {
                return Ok(binding);
            }
            let lease_expires_at = Utc::now() + self.lease_duration;
            match self
                .renew_objective_evaluation(
                    &binding.objective_id,
                    &binding.evaluation_id,
                    lease_expires_at,
                    binding.pending_dependency_id.as_deref(),
                    activation_id,
                )
                .await?
            {
                ObjectiveMutation::Updated(_) => {
                    let lease_expires_at_local =
                        crate::local_time::format_utc_for_local(lease_expires_at);
                    tracing::debug!(
                        objective_id = %binding.objective_id,
                        evaluation_id = %binding.evaluation_id,
                        activation_id,
                        lease_expires_at = %lease_expires_at_local,
                    event_code = "objective.evaluation.lease_renewed",
                    "Renewed the running Objective Evaluation lease"
                    );
                }
                ObjectiveMutation::Conflict { current } => {
                    tracing::warn!(
                        objective_id = %binding.objective_id,
                        evaluation_id = %binding.evaluation_id,
                        activation_id,
                        active_evaluation_id = ?current.active_evaluation_id,
                        current_status = ?current.status,
                    event_code = "objective.evaluation.fence_lost",
                    "Objective Evaluation fencing token is no longer valid"
                    );
                    self.evaluations
                        .cancel_evaluation(&binding.objective_id, &binding.evaluation_id);
                    return Ok(binding);
                }
                ObjectiveMutation::NotFound => {
                    self.evaluations
                        .cancel_evaluation(&binding.objective_id, &binding.evaluation_id);
                    return Ok(binding);
                }
            }
        }
    }

    pub async fn list(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<ObjectiveRecord>, DynError> {
        self.store
            .list_context_objectives(context_id, include_terminal)
            .await
    }

    /// Re-run scheduling policy for every non-terminal Objective in one
    /// Cognitive Context. Control paths call this only after the exact stopped
    /// Evaluation has received its cancellation signal, so the same Objective
    /// cannot claim a replacement before its old Activation is fenced.
    pub async fn reconcile_context(self: &Arc<Self>, context_id: &str) -> Result<(), DynError> {
        for objective in self
            .store
            .list_context_objectives(context_id, false)
            .await?
        {
            self.reconcile(objective).await?;
        }
        Ok(())
    }

    pub async fn edit(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        self.edit_with_reason(id, expected_revision, stated_objective, None)
            .await
    }

    pub async fn edit_with_reason(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, DynError> {
        let mutation = self
            .store
            .edit_objective(id, expected_revision, stated_objective)
            .await?;
        if let ObjectiveMutation::Updated(updated) = &mutation {
            self.publish_state_event("edited", updated, reason).await?;
        }
        Ok(mutation)
    }

    pub async fn amend_from_dialogue(
        &self,
        id: &str,
        expected_revision: u64,
        stated_objective: &str,
        reason: &str,
        source_event: &Event,
        principal_id: &str,
    ) -> Result<ObjectiveMutation, DynError> {
        let Some(objective) = self.store.get_objective(id).await? else {
            return Ok(ObjectiveMutation::NotFound);
        };
        if objective.revision != expected_revision {
            return Ok(ObjectiveMutation::Conflict { current: objective });
        }
        let root_turn_id =
            crate::memory::objective_primary_execution_root_id(&objective.id, objective.generation);
        let revision = expected_revision.saturating_add(1);
        let event = Event::new(
            format!(
                "objective_amend_{}_r{}_{}",
                objective.id, revision, source_event.id
            ),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "chat/objective_amended".to_string(),
            [
                ("context_id".to_string(), json!(objective.context_id)),
                (
                    "session_id".to_string(),
                    json!(objective.coordinator_session_id),
                ),
                ("root_turn_id".to_string(), json!(root_turn_id)),
                ("objective_id".to_string(), json!(objective.id)),
                ("objective_revision".to_string(), json!(revision)),
                (
                    "objective_generation".to_string(),
                    json!(objective.generation),
                ),
                ("objective_interrupt".to_string(), json!(true)),
                ("objective_phase".to_string(), json!("amendment")),
                ("wake_source".to_string(), json!("objective-amend")),
                ("source_event_id".to_string(), json!(source_event.id)),
                ("principal_id".to_string(), json!(principal_id)),
                ("reason".to_string(), json!(reason)),
                (
                    "text".to_string(),
                    json!("The user amended this Objective. Re-read the current objective contract and continue without cancelling already-running child work."),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let thread = NewThread {
            id: stable_thread_id(&root_turn_id),
            agent_id: objective.agent_id.clone(),
            context_id: objective.context_id.clone(),
            session_id: objective.coordinator_session_id.clone(),
            initiating_principal_id: objective.initiating_principal_id.clone(),
            root_turn_id,
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective_primary_execution(
                objective.id.clone(),
                objective.generation,
            ),
        };
        let mutation = self
            .store
            .amend_objective_with_signal(
                &objective.id,
                expected_revision,
                stated_objective,
                &event,
                &thread,
            )
            .await?;
        if matches!(mutation, ObjectiveMutation::Updated(_)) {
            if let Err(error) = self.bus.dispatch_persisted(event.clone()).await {
                tracing::warn!(
                    objective_id = %objective.id,
                    event_id = %event.id,
                    error = %error,
                    event_code = "objective.amendment.dispatch_deferred",
                    "The Objective amendment committed, but immediate dispatch failed; durable Signal recovery will retry it"
                );
            }
        }
        Ok(mutation)
    }

    pub async fn update_state(
        self: &Arc<Self>,
        id: &str,
        expected_revision: u64,
        status: ObjectiveStatus,
        wait_condition: Option<ObjectiveWaitCondition>,
        reason: Option<&str>,
    ) -> Result<ObjectiveMutation, DynError> {
        let current = self
            .store
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' does not exist"))?;
        if current.revision != expected_revision {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let mut mutation = self
            .transition_objective(
                &current,
                status,
                wait_condition,
                reason,
                id,
                "ObjectiveSupervisor",
            )
            .await?;
        if let ObjectiveMutation::Updated(updated) = &mutation {
            if matches!(
                updated.status,
                ObjectiveStatus::Paused | ObjectiveStatus::Cancelled | ObjectiveStatus::Failed
            ) {
                if let Some(evaluation_id) = updated.active_evaluation_id.as_deref() {
                    mutation = self
                        .finish_objective_evaluation(&updated.id, evaluation_id, 0, 0, &updated.id)
                        .await?;
                }
            }
        }
        if let ObjectiveMutation::Updated(updated) = &mutation {
            self.publish_state_event("updated", updated, reason).await?;
            self.reconcile(updated.clone()).await?;
            if updated.status == ObjectiveStatus::Failed {
                self.reconcile_context(&updated.context_id).await?;
            }
        }
        Ok(mutation)
    }

    pub async fn prepare_completion(
        self: &Arc<Self>,
        id: &str,
        expected_revision: u64,
        evaluation_id: &str,
        activation_id: &str,
        reason: &str,
        evidence_refs: Vec<String>,
    ) -> Result<ObjectiveMutation, DynError> {
        let current = self
            .store
            .get_objective(id)
            .await?
            .ok_or_else(|| format!("Objective '{id}' does not exist"))?;
        if current.revision != expected_revision {
            return Ok(ObjectiveMutation::Conflict { current });
        }
        let mutation = self
            .prepare_objective_completion_transition(
                &current,
                evaluation_id,
                activation_id,
                reason,
                evidence_refs,
            )
            .await?;
        if let ObjectiveMutation::Updated(updated) = &mutation {
            self.publish_state_event("completion_prepared", updated, Some(reason))
                .await?;
        }
        Ok(mutation)
    }

    async fn handle_objective_event(self: Arc<Self>, event: Event) -> Result<(), DynError> {
        let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        if let Some(objective) = self.store.get_objective(objective_id).await? {
            self.reconcile(objective).await?;
        }
        Ok(())
    }

    /// Lifecycle hook invoked by Orchestrator while holding the target Session
    /// lane and before it evaluates a newly routed user/tool event. Ordinary
    /// matching completion events satisfy their wait. A directed Objective
    /// interrupt instead preserves the exact current wait as a crash-recovery
    /// fallback while admitting one Objective-bound Evaluation for the new
    /// input; no duplicate synthetic continuation is emitted.
    pub async fn prepare_routed_event(
        self: &Arc<Self>,
        event: &Event,
        activation_id: &str,
    ) -> Result<RoutedObjectiveEventDisposition, DynError> {
        let Some(context_id) = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(RoutedObjectiveEventDisposition::Unrelated);
        };
        let route_session_id = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str());
        if event
            .payload
            .get("objective_interrupt")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            let objective_id = event
                .payload
                .get("objective_id")
                .and_then(serde_json::Value::as_str)
                .ok_or("Objective interrupt Event is missing objective_id")?;
            let objective_generation = event
                .payload
                .get("objective_generation")
                .and_then(serde_json::Value::as_u64)
                .ok_or("Objective interrupt Event is missing objective_generation")?;
            let Some(objective) = self.store.get_objective(objective_id).await? else {
                return Ok(RoutedObjectiveEventDisposition::Suppressed);
            };
            let expected_root = crate::memory::objective_primary_execution_root_id(
                &objective.id,
                objective.generation,
            );
            let routed_root = event
                .payload
                .get("root_turn_id")
                .and_then(serde_json::Value::as_str);
            if objective.context_id != context_id
                || route_session_id != Some(objective.coordinator_session_id.as_str())
                || objective.status != ObjectiveStatus::Active
                || objective.generation != objective_generation
                || routed_root != Some(expected_root.as_str())
            {
                tracing::info!(
                    objective_id,
                    objective_generation,
                    event_id = %event.id,
                    event_code = "objective.interrupt.stale_route_suppressed",
                    "Suppressed an Objective interrupt whose persisted route is no longer current"
                );
                return Ok(RoutedObjectiveEventDisposition::Suppressed);
            }
            let Some(wait) = objective.wait_condition.as_ref() else {
                // A Dialogue amendment queued behind the Objective's current
                // primary Activation reaches this branch only after that work
                // has settled. Claim the next ordinary Evaluation from the
                // amended contract; if a live Evaluation still owns the
                // Objective, the durable claim loses cleanly and the route is
                // suppressed instead of creating concurrent work.
                let claimed = self
                    .claim_routed_evaluation(&objective, &event.id, Some(activation_id), true, None)
                    .await?;
                return Ok(if claimed.is_some() {
                    RoutedObjectiveEventDisposition::Admitted
                } else {
                    RoutedObjectiveEventDisposition::Suppressed
                });
            };
            let (dependency_kind, dependency_key) = objective_wait_dependency_key(wait);
            let dependency = self
                .current_scheduler_dependencies(&objective)
                .await?
                .unwrap_or_default()
                .into_iter()
                .find(|dependency| {
                    dependency.required
                        && dependency.status == SchedulerDependencyStatus::Pending
                        && dependency.dependency_kind == dependency_kind
                        && dependency.dependency_id == dependency_key
                });
            let Some(dependency) = dependency else {
                tracing::warn!(
                    objective_id,
                    event_id = %event.id,
                    event_code = "objective.interrupt.wait_dependency_missing",
                    "Suppressed an Objective interrupt because its displayed wait has no exact pending Scheduler dependency"
                );
                return Ok(RoutedObjectiveEventDisposition::Suppressed);
            };
            let claimed = self
                .claim_routed_evaluation(
                    &objective,
                    &event.id,
                    Some(activation_id),
                    true,
                    Some(&dependency.id),
                )
                .await?;
            let Some(claimed) = claimed else {
                return Ok(RoutedObjectiveEventDisposition::Suppressed);
            };
            // Refresh both the preserved wait timer and the new Evaluation
            // lease timer to the claimed semantic revision.
            self.reconcile(claimed).await?;
            return Ok(RoutedObjectiveEventDisposition::Admitted);
        }

        let mut admitted = false;
        let objectives = self
            .store
            .list_context_objectives(context_id, false)
            .await?;
        for objective in objectives {
            let Some(wait) = objective.wait_condition.as_ref() else {
                continue;
            };
            if objective.status != ObjectiveStatus::Active || !wait_matches_event(wait, event) {
                continue;
            }
            self.satisfy_wait_dependency(&objective, wait, &event.id)
                .await?;
            let reason = format!("wait condition was satisfied by Event {}", event.id);
            let mutation = self
                .transition_objective(
                    &objective,
                    ObjectiveStatus::Active,
                    None,
                    Some(&reason),
                    &event.id,
                    "ObjectiveSupervisor",
                )
                .await?;
            let ObjectiveMutation::Updated(woken) = mutation else {
                continue;
            };
            self.publish_state_event("wait_satisfied", &woken, Some(&event.id))
                .await?;
            if route_session_id == Some(woken.coordinator_session_id.as_str()) {
                admitted |= self
                    .claim_routed_evaluation(&woken, &event.id, Some(activation_id), true, None)
                    .await?
                    .is_some();
            } else {
                self.reconcile(woken).await?;
            }
        }
        Ok(if admitted {
            RoutedObjectiveEventDisposition::Admitted
        } else {
            RoutedObjectiveEventDisposition::Unrelated
        })
    }

    async fn wake_non_routed_event(self: &Arc<Self>, event: &Event) -> Result<(), DynError> {
        let Some(context_id) = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let objectives = self
            .store
            .list_context_objectives(context_id, false)
            .await?;
        let targeted_objective_ids = event.payload.get("objective_ids").and_then(|value| {
            value.as_array().map(|ids| {
                ids.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<HashSet<_>>()
            })
        });
        for objective in objectives {
            if targeted_objective_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&objective.id))
            {
                continue;
            }
            if objective.status != ObjectiveStatus::Active {
                continue;
            }
            let targets_objective = event.topic == "runtime/thread_group_terminal"
                && event
                    .payload
                    .get("objective_id")
                    .and_then(|value| value.as_str())
                    == Some(objective.id.as_str());
            let Some(wait) = objective.wait_condition.as_ref() else {
                // Thread Group terminal commits atomically satisfy the
                // structured dependency and clear the legacy wait projection.
                // The barrier is therefore an idempotent scheduling hint even
                // when the display field is already NULL by dispatch time.
                if targets_objective {
                    self.reconcile(objective).await?;
                }
                continue;
            };
            if !wait_matches_event(wait, event) {
                continue;
            }
            self.satisfy_wait_dependency(&objective, wait, &event.id)
                .await?;
            let reason = format!("wait condition was satisfied by Event {}", event.id);
            let mutation = self
                .transition_objective(
                    &objective,
                    ObjectiveStatus::Active,
                    None,
                    Some(&reason),
                    &event.id,
                    "ObjectiveSupervisor",
                )
                .await?;
            if let ObjectiveMutation::Updated(woken) = mutation {
                self.publish_state_event("wait_satisfied", &woken, Some(&event.id))
                    .await?;
                self.reconcile(woken).await?;
            }
        }
        Ok(())
    }

    /// Close the crash window between committing a durable wake fact and
    /// dispatching it through the process-local EventBus. Only non-routed
    /// waits are eligible here; routed user/tool events are recovered by their
    /// own scheduler outboxes. The Objective update time is the lower bound so
    /// an event observed before the current wait was installed cannot wake it.
    async fn find_persisted_wait_event(
        &self,
        objective: &ObjectiveRecord,
    ) -> Result<Option<Event>, DynError> {
        let Some(wait) = objective.wait_condition.as_ref() else {
            return Ok(None);
        };
        let (topic, context_id) = match wait {
            ObjectiveWaitCondition::Permission { .. } => (
                "runtime/approval_decision".to_string(),
                Some(objective.context_id.clone()),
            ),
            ObjectiveWaitCondition::ExternalEvent { topic, .. } => {
                (topic.clone(), Some(objective.context_id.clone()))
            }
            ObjectiveWaitCondition::ResourceAvailable { resource }
                if resource == MODEL_CONFIGURATION_RESOURCE =>
            {
                (TYPE_MODEL_CONFIGURATION_CHANGED.to_string(), None)
            }
            ObjectiveWaitCondition::ResourceAvailable { .. } => (
                "runtime/resource_available".to_string(),
                Some(objective.context_id.clone()),
            ),
            ObjectiveWaitCondition::ThreadGroup { .. } => (
                "runtime/thread_group_terminal".to_string(),
                Some(objective.context_id.clone()),
            ),
            ObjectiveWaitCondition::ToolTask { .. }
            | ObjectiveWaitCondition::Delegation { .. }
            | ObjectiveWaitCondition::Timer { .. }
            | ObjectiveWaitCondition::UserInput { .. } => return Ok(None),
        };
        let events = self
            .audit_store
            .query(QueryFilter {
                context_id,
                start_time: Some(objective.updated_at),
                topic: Some(topic),
                ..QueryFilter::default()
            })
            .await?;
        Ok(events.into_iter().find_map(|mut event| {
            if !wait_matches_event(wait, &event) {
                return None;
            }
            // The configuration epoch is one global durable fact. During
            // crash recovery, project the waiting Objective's exact Context
            // onto that fact for the normal context-scoped wake path; do not
            // duplicate the Event once per Context merely for persistence.
            if event.topic == TYPE_MODEL_CONFIGURATION_CHANGED {
                event
                    .payload
                    .insert("context_id".to_string(), json!(&objective.context_id));
            }
            Some(event)
        }))
    }

    pub async fn terminal_outcome(self: &Arc<Self>, event: &Event) -> Result<(), DynError> {
        let Some(_session_id) = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let Some(evaluation_id) = event
            .payload
            .get("objective_evaluation_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let binding = event
            .payload
            .get("activation_id")
            .and_then(|value| value.as_str())
            .and_then(|activation_id| self.evaluations.get_for_activation(activation_id))
            .filter(|active| {
                active.objective_id == objective_id && active.evaluation_id == evaluation_id
            })
            .unwrap_or_else(|| ActiveObjectiveEvaluation {
                objective_id: objective_id.to_string(),
                evaluation_id: evaluation_id.to_string(),
                revision: event
                    .payload
                    .get("objective_revision")
                    .and_then(|value| value.as_u64())
                    .unwrap_or_default(),
                started_at: event.timestamp,
                pending_dependency_id: None,
            });

        let elapsed_seconds = (Utc::now() - binding.started_at).num_seconds().max(0) as u64;
        let mutation = self
            .finish_objective_evaluation(
                &binding.objective_id,
                &binding.evaluation_id,
                0,
                elapsed_seconds,
                &event.id,
            )
            .await?;
        self.cancel_lease_timer(&binding.objective_id).await?;
        self.evaluations
            .unbind(&binding.objective_id, &binding.evaluation_id);
        let mut context_to_reconcile = None;
        match mutation {
            ObjectiveMutation::Updated(updated) => {
                let updated = self.apply_runtime_failure_outcome(updated, event).await?;
                context_to_reconcile = Some(updated.context_id.clone());
                self.publish_state_event("evaluation_finished", &updated, Some(&event.id))
                    .await?;
                self.reconcile(updated).await?;
            }
            ObjectiveMutation::Conflict { current } if current.status.is_terminal() => {
                context_to_reconcile = Some(current.context_id);
                // objective_update may have committed a terminal state before
                // the terminal response. Its outcome still releases local routing.
            }
            ObjectiveMutation::Conflict { current } => {
                context_to_reconcile = Some(current.context_id.clone());
                tracing::warn!(
                    objective_id = %binding.objective_id,
                    evaluation_id = %binding.evaluation_id,
                    current_revision = current.revision,
                event_code = "objective.evaluation.terminal_receipt_lease_mismatch",
                "Objective Evaluation terminal receipt does not match the persisted lease"
                );
                self.reconcile(current).await?;
            }
            ObjectiveMutation::NotFound => {}
        }
        if let Some(context_id) = context_to_reconcile {
            for objective in self
                .store
                .list_context_objectives(&context_id, false)
                .await?
            {
                self.reconcile(objective).await?;
            }
        }
        Ok(())
    }

    /// A Provider failure is a control-plane outcome, not a successful
    /// Objective step.  Persist the corresponding wait/block before the
    /// normal reconciliation policy runs; otherwise an active/no-wait
    /// Objective immediately creates another Evaluation and amplifies an
    /// outage (or an oversized Context) into an unbounded retry storm.
    async fn apply_runtime_failure_outcome(
        &self,
        objective: ObjectiveRecord,
        event: &Event,
    ) -> Result<ObjectiveRecord, DynError> {
        let Some(failure_kind) = event
            .payload
            .get("runtime_failure_kind")
            .and_then(|value| value.as_str())
        else {
            return Ok(objective);
        };

        let wait_resource = event
            .payload
            .get("wait_resource")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty());
        let maintenance_exhausted = event
            .payload
            .get("runtime_failure_stage")
            .and_then(|value| value.as_str())
            == Some("critical_maintenance_minimum_projection");
        let invalid_request = failure_kind == "invalid_model_or_request";
        let provider_recoverable = provider_failure_is_recoverable(failure_kind);
        let recoverable = !maintenance_exhausted
            && (failure_kind == "context_limit" || provider_recoverable || invalid_request);
        let configuration_already_changed = invalid_request
            && self
                .model_configuration_changed_since_attempt(event)
                .await?;
        let (status, wait_condition, reason) = if configuration_already_changed {
            (
                ObjectiveStatus::Active,
                None,
                "the configuration used by this model request has been replaced; reevaluate immediately with the current configuration"
                    .to_string(),
            )
        } else if recoverable {
            let resource = wait_resource.map(ToOwned::to_owned).unwrap_or_else(|| {
                if invalid_request {
                    MODEL_CONFIGURATION_RESOURCE.to_string()
                } else {
                    format!("runtime-recovery:{failure_kind}")
                }
            });
            (
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ResourceAvailable {
                    resource: resource.clone(),
                }),
                format!("this attempt ended due to {failure_kind}; wait for Runtime to recover resource {resource} before continuing"),
            )
        } else {
            (
                ObjectiveStatus::Blocked,
                None,
                format!("this attempt is blocked by non-recoverable Provider error {failure_kind}"),
            )
        };

        match self
            .transition_objective(
                &objective,
                status,
                wait_condition,
                Some(&reason),
                &event.id,
                "ObjectiveSupervisor-ProviderRecovery",
            )
            .await?
        {
            ObjectiveMutation::Updated(updated) => {
                self.publish_state_event("runtime_failure", &updated, Some(&event.id))
                    .await?;
                // Close the remaining interleaving around the first epoch
                // check: the configuration Event may commit after that read
                // but before this wait/dependency transaction commits. A
                // second read after the wait is durable either observes the
                // epoch and clears the stale wait itself, or establishes that
                // any later publisher must observe the pending dependency.
                if invalid_request
                    && updated.wait_condition.as_ref().is_some_and(|wait| {
                        matches!(
                            wait,
                            ObjectiveWaitCondition::ResourceAvailable { resource }
                                if resource == MODEL_CONFIGURATION_RESOURCE
                        )
                    })
                    && self
                        .model_configuration_changed_since_attempt(event)
                        .await?
                {
                    let reason = "model configuration changed while the failure state was being committed; cancel the stale wait and continue with the current configuration";
                    match self
                        .transition_objective(
                            &updated,
                            ObjectiveStatus::Active,
                            None,
                            Some(reason),
                            &event.id,
                            "ObjectiveSupervisor-ModelConfigurationRace",
                        )
                        .await?
                    {
                        ObjectiveMutation::Updated(released) => {
                            self.publish_state_event(
                                "configuration_wait_released",
                                &released,
                                Some(&event.id),
                            )
                            .await?;
                            return Ok(released);
                        }
                        ObjectiveMutation::Conflict { current } => return Ok(current),
                        ObjectiveMutation::NotFound => return Ok(updated),
                    }
                }
                Ok(updated)
            }
            ObjectiveMutation::Conflict { current } => {
                tracing::debug!(
                    objective_id = %objective.id,
                    expected_revision = objective.revision,
                    current_revision = current.revision,
                    failure_kind,
                    event_code = "objective.provider_failure.concurrent_update",
                    "Provider-failure state commit encountered a concurrent update; preserving the latest Objective state"
                );
                Ok(current)
            }
            ObjectiveMutation::NotFound => Ok(objective),
        }
    }

    /// A model/configuration update may commit while an old immutable Model
    /// Attempt is still in flight. If that old request fails afterwards, the
    /// update Event necessarily predates the Objective wait transition and a
    /// normal wait lookup would miss it. Compare against the physical request
    /// start boundary before installing the wait so that interleaving yields
    /// one fresh attempt instead of a permanently stranded Objective.
    async fn model_configuration_changed_since_attempt(
        &self,
        event: &Event,
    ) -> Result<bool, DynError> {
        let Some(started_at) = event
            .payload
            .get("model_request_started_at")
            .cloned()
            .and_then(|value| serde_json::from_value::<DateTime<Utc>>(value).ok())
        else {
            return Ok(false);
        };
        Ok(!self
            .audit_store
            .query(QueryFilter {
                start_time: Some(started_at),
                topic: Some(TYPE_MODEL_CONFIGURATION_CHANGED.to_string()),
                latest_k: Some(1),
                ..QueryFilter::default()
            })
            .await?
            .is_empty())
    }

    pub async fn record_prompt_tokens_for_activation(
        &self,
        activation_id: &str,
        tokens: usize,
    ) -> Result<(), DynError> {
        let Some(binding) = self.evaluations.get_for_activation(activation_id) else {
            return Ok(());
        };
        let tokens = u64::try_from(tokens).unwrap_or(u64::MAX);
        match self
            .store
            .record_objective_evaluation_usage(
                &binding.objective_id,
                &binding.evaluation_id,
                tokens,
            )
            .await?
        {
            ObjectiveMutation::Updated(_) => {}
            ObjectiveMutation::Conflict { current } => {
                tracing::debug!(
                    objective_id = %binding.objective_id,
                    evaluation_id = %binding.evaluation_id,
                    current_status = ?current.status,
                    event_code = "objective.prompt_measurement.state_changed",
                    "Objective Prompt measurement was not recorded because the Evaluation state changed"
                );
            }
            ObjectiveMutation::NotFound => {
                tracing::warn!(
                    objective_id = %binding.objective_id,
                event_code = "objective.prompt_measurement.objective_missing",
                "Objective Prompt measurement was not recorded because the Objective is missing"
                );
            }
        }
        Ok(())
    }

    async fn reconcile(self: &Arc<Self>, objective: ObjectiveRecord) -> Result<(), DynError> {
        if !self.started.load(Ordering::Acquire) {
            return Ok(());
        }
        if objective.status != ObjectiveStatus::Active {
            self.cancel_objective_timers(&objective.id).await?;
            if !matches!(
                objective.status,
                ObjectiveStatus::Completed | ObjectiveStatus::Blocked
            ) {
                self.clear_local_binding(&objective);
            }
            self.remove_external_wait_subscription(&objective.id);
            return Ok(());
        }
        let mut dependencies_waiting = false;
        if let Some(current_dependencies) = self.current_scheduler_dependencies(&objective).await? {
            if !current_dependencies.is_empty() {
                match derive_objective_readiness(&objective, &current_dependencies, Utc::now()) {
                    ObjectiveReadiness::Waiting { dependency_ids } => {
                        self.cancel_lease_timer(&objective.id).await?;
                        self.cancel_wait_timer(&objective.id).await?;
                        self.remove_external_wait_subscription(&objective.id);
                        tracing::debug!(
                                        objective_id = %objective.id,
                                        objective_generation = objective.generation,
                                        dependencies = ?dependency_ids,
                        event_code = "objective.scheduler.waiting_on_dependencies",
                        "Objective remains waiting on structured Scheduler dependencies"
                                    );
                        dependencies_waiting = true;
                    }
                    ObjectiveReadiness::Leased { .. } => {
                        // Lease handling below owns timer renewal/recovery.
                    }
                    ObjectiveReadiness::Runnable => {
                        if objective.wait_condition.is_some() {
                            let mutation = self
                                .transition_objective(
                                    &objective,
                                    ObjectiveStatus::Active,
                                    None,
                                    Some(
                                        "structured Scheduler dependency is terminal; remove stale wait display projection",
                                    ),
                                    "dependency-terminal",
                                    "ObjectiveSupervisor",
                                )
                                .await?;
                            match mutation {
                                ObjectiveMutation::Updated(updated) => {
                                    Box::pin(self.reconcile(updated)).await?;
                                }
                                ObjectiveMutation::Conflict { current } => {
                                    Box::pin(self.reconcile(current)).await?;
                                }
                                ObjectiveMutation::NotFound => {}
                            }
                            return Ok(());
                        }
                    }
                    ObjectiveReadiness::Paused
                    | ObjectiveReadiness::Blocked
                    | ObjectiveReadiness::Terminal => return Ok(()),
                }
            }
        }
        if let Some(wait) = &objective.wait_condition {
            if let Some(expires_at) = objective.evaluation_lease_expires_at {
                if expires_at > Utc::now() {
                    self.schedule_lease_expiry(&objective, expires_at).await?;
                } else {
                    self.revoke_local_evaluation(&objective).await?;
                }
            } else {
                self.cancel_lease_timer(&objective.id).await?;
            }
            match wait {
                ObjectiveWaitCondition::ToolTask { task_id } => {
                    let task_id = task_id.clone();
                    self.cancel_wait_timer(&objective.id).await?;
                    self.remove_external_wait_subscription(&objective.id);
                    if self
                        .reconcile_tool_task_wait(objective.clone(), &task_id)
                        .await?
                    {
                        return Ok(());
                    }
                }
                ObjectiveWaitCondition::Delegation { delegation_id } => {
                    let delegation_id = delegation_id.clone();
                    self.cancel_wait_timer(&objective.id).await?;
                    self.remove_external_wait_subscription(&objective.id);
                    if self
                        .reconcile_delegation_wait(objective.clone(), &delegation_id)
                        .await?
                    {
                        return Ok(());
                    }
                }
                ObjectiveWaitCondition::ThreadGroup { group_id } => {
                    let group_id = group_id.clone();
                    self.cancel_wait_timer(&objective.id).await?;
                    self.remove_external_wait_subscription(&objective.id);
                    if self
                        .reconcile_thread_group_wait(objective.clone(), &group_id)
                        .await?
                    {
                        return Ok(());
                    }
                }
                ObjectiveWaitCondition::Timer { deadline } => {
                    self.remove_external_wait_subscription(&objective.id);
                    self.schedule_wait_timer(&objective, *deadline).await?;
                }
                ObjectiveWaitCondition::ExternalEvent { topic, .. } => {
                    self.cancel_wait_timer(&objective.id).await?;
                    self.register_external_wait_subscription(
                        &objective.id,
                        objective.revision,
                        topic,
                    );
                }
                _ => {
                    self.cancel_wait_timer(&objective.id).await?;
                    self.remove_external_wait_subscription(&objective.id);
                }
            }
            return Ok(());
        }
        if dependencies_waiting {
            // A dependency without a legacy display projection is still
            // authoritative. Its producer (Thread/Group/Signal) owns the
            // wake path, so no Evaluation may be admitted here.
            return Ok(());
        }
        self.cancel_wait_timer(&objective.id).await?;
        self.remove_external_wait_subscription(&objective.id);
        if let Some(expires_at) = objective.evaluation_lease_expires_at {
            if expires_at > Utc::now() {
                self.schedule_lease_expiry(&objective, expires_at).await?;
                return Ok(());
            }
            self.revoke_local_evaluation(&objective).await?;
        }
        self.schedule(objective.id).await
    }

    /// Reconcile a Thread Group wait against the durable Group Projection.
    /// The barrier Event is only a wake hint; the Projection remains
    /// authoritative across restart, missed EventBus delivery and duplicate
    /// terminal events.
    async fn reconcile_thread_group_wait(
        self: &Arc<Self>,
        objective: ObjectiveRecord,
        group_id: &str,
    ) -> Result<bool, DynError> {
        let Some(store) = self.thread_groups.as_ref() else {
            return Ok(false);
        };
        let group = store.get_thread_group(group_id).await?;
        let (event_kind, caused_by, reason) = match group {
            Some(group)
                if group.context_id == objective.context_id
                    && group.session_id == objective.coordinator_session_id
                    && group.supervisor_kind == ThreadSupervisorKind::Objective
                    && group.supervisor_id == objective.id
                    && !group.status.is_terminal() =>
            {
                return Ok(false);
            }
            Some(group)
                if group.context_id == objective.context_id
                    && group.session_id == objective.coordinator_session_id
                    && group.supervisor_kind == ThreadSupervisorKind::Objective
                    && group.supervisor_id == objective.id
                    && group.status.is_terminal() =>
            {
                (
                    "wait_satisfied",
                    group.barrier_event_id.clone(),
                    format!(
                        "thread group '{}' is terminal with status {} ({}/{} succeeded); Runtime released the wait and resumed evaluation",
                        group_id,
                        group.status.as_str(),
                        group.successful_count,
                        group.required_count
                    ),
                )
            }
            Some(group) => (
                "wait_invalidated",
                group.barrier_event_id.clone(),
                format!(
                    "thread_group '{}' is not supervised by the current Objective/Context/Session; Runtime cancelled the invalid wait",
                    group.id
                ),
            ),
            None => (
                "wait_invalidated",
                None,
                format!(
                    "thread_group '{}' does not exist; Runtime cancelled the legacy or invalid wait",
                    group_id
                ),
            ),
        };
        if event_kind == "wait_satisfied" {
            if let (Some(wait), Some(event_id)) =
                (objective.wait_condition.as_ref(), caused_by.as_deref())
            {
                self.satisfy_wait_dependency(&objective, wait, event_id)
                    .await?;
            }
        }
        let mutation = self
            .transition_objective(
                &objective,
                ObjectiveStatus::Active,
                None,
                Some(&reason),
                caused_by.as_deref().unwrap_or(group_id),
                "ObjectiveSupervisor-ThreadGroup",
            )
            .await?;
        match mutation {
            ObjectiveMutation::Updated(woken) => {
                self.publish_state_event(event_kind, &woken, caused_by.as_deref())
                    .await?;
                Box::pin(self.reconcile(woken)).await?;
            }
            ObjectiveMutation::Conflict { current } => {
                Box::pin(self.reconcile(current)).await?;
            }
            ObjectiveMutation::NotFound => {}
        }
        Ok(true)
    }

    /// Reconcile a Delegation wait against its durable parent/child projection.
    /// This makes completion authoritative even when the routed result was
    /// already covered by a newer Context view, or when a process restarted
    /// between committing the child result and clearing the Objective wait.
    async fn reconcile_delegation_wait(
        self: &Arc<Self>,
        objective: ObjectiveRecord,
        delegation_id: &str,
    ) -> Result<bool, DynError> {
        let Some(store) = self.delegations.as_ref() else {
            return Ok(false);
        };
        let delegation = store.get_delegation(delegation_id).await?;
        let (event_kind, caused_by, reason) = match delegation {
            Some(delegation)
                if delegation.parent_context_id == objective.context_id
                    && delegation.parent_session_id == objective.coordinator_session_id
                    && delegation.agent_id == objective.agent_id
                    && (objective.initiating_principal_id.is_none()
                        || delegation.initiating_principal_id
                            == objective.initiating_principal_id)
                    && matches!(
                        delegation.status,
                        DelegationStatus::Queued | DelegationStatus::Running
                    ) =>
            {
                return Ok(false);
            }
            Some(delegation)
                if delegation.parent_context_id == objective.context_id
                    && delegation.parent_session_id == objective.coordinator_session_id
                    && delegation.agent_id == objective.agent_id
                    && (objective.initiating_principal_id.is_none()
                        || delegation.initiating_principal_id
                            == objective.initiating_principal_id)
                    && matches!(
                        delegation.status,
                        DelegationStatus::Completed
                            | DelegationStatus::Failed
                            | DelegationStatus::Cancelled
                    ) =>
            {
                (
                    "wait_satisfied",
                    delegation.result_event_id.clone(),
                    format!(
                        "sub-agent delegation '{}' is terminal with status {}{}; Runtime released the wait and resumed evaluation",
                        delegation_id,
                        delegation.status.as_str(),
                        delegation
                            .result_event_id
                            .as_deref()
                            .map(|event_id| format!(", result Event {event_id}"))
                            .unwrap_or_default()
                    ),
                )
            }
            Some(delegation) => (
                "wait_invalidated",
                None,
                format!(
                    "delegation '{}' does not belong to the current Objective's Agent/Context/Session/Principal; Runtime cancelled the invalid wait",
                    delegation.id
                ),
            ),
            None => (
                "wait_invalidated",
                None,
                format!(
                    "delegation '{}' does not exist; Runtime cancelled the legacy or invalid wait",
                    delegation_id
                ),
            ),
        };
        if event_kind == "wait_satisfied" {
            if let (Some(wait), Some(event_id)) =
                (objective.wait_condition.as_ref(), caused_by.as_deref())
            {
                self.satisfy_wait_dependency(&objective, wait, event_id)
                    .await?;
            }
        }
        let mutation = self
            .transition_objective(
                &objective,
                ObjectiveStatus::Active,
                None,
                Some(&reason),
                caused_by.as_deref().unwrap_or(delegation_id),
                "ObjectiveSupervisor-Delegation",
            )
            .await?;
        match mutation {
            ObjectiveMutation::Updated(woken) => {
                tracing::warn!(
                    objective_id = %woken.id,
                    delegation_id,
                    event_kind,
                    reason,
                    event_code = "objective.delegation_wait.reconciled",
                    "Objective delegation wait was reconciled from authoritative Delegation state"
                );
                self.publish_state_event(event_kind, &woken, caused_by.as_deref())
                    .await?;
                Box::pin(self.reconcile(woken)).await?;
            }
            ObjectiveMutation::Conflict { current } => {
                Box::pin(self.reconcile(current)).await?;
            }
            ObjectiveMutation::NotFound => {}
        }
        Ok(true)
    }

    /// Reconcile the durable Objective wait against the authoritative
    /// ExecutionJob projection.  This closes both races around wait
    /// installation and the restart gap where a terminal result Event was
    /// committed before this process subscribed to the EventBus.
    ///
    /// Returns `true` when the wait was consumed (or a concurrent Objective
    /// revision was reconciled) and `false` when a live task still owns it.
    async fn reconcile_tool_task_wait(
        self: &Arc<Self>,
        objective: ObjectiveRecord,
        task_id: &str,
    ) -> Result<bool, DynError> {
        let Some(store) = self.execution_jobs.as_ref() else {
            // Tests and embedders which do not enable physical execution keep
            // their previous event-driven behavior.  The production Runtime
            // always attaches its ExecutionJob Store.
            return Ok(false);
        };
        let job = store.get_execution_job(task_id).await?;
        let (event_kind, caused_by, reason) = match job {
            Some(job)
                if job.context_id == objective.context_id
                    && job.session_id == objective.coordinator_session_id
                    && job.agent_id == objective.agent_id
                    && (objective.initiating_principal_id.is_none()
                        || job.initiating_principal_id == objective.initiating_principal_id)
                    && job.tool_name == "exec/background"
                    && !job.status.is_terminal() =>
            {
                return Ok(false);
            }
            Some(job)
                if job.context_id == objective.context_id
                    && job.session_id == objective.coordinator_session_id
                    && job.agent_id == objective.agent_id
                    && (objective.initiating_principal_id.is_none()
                        || job.initiating_principal_id == objective.initiating_principal_id)
                    && job.tool_name == "exec/background"
                    && job.status.is_terminal() =>
            {
                (
                    "wait_satisfied",
                    job.result_event_id.clone(),
                    format!(
                        "background tool task '{}' is terminal with status {}{}; Runtime released the wait and resumed evaluation",
                        task_id,
                        job.status.as_str(),
                        job.result_event_id
                            .as_deref()
                            .map(|event_id| format!(", result Event {event_id}"))
                            .unwrap_or_default()
                    ),
                )
            }
            Some(job) => (
                "wait_invalidated",
                None,
                format!(
                    "tool_task '{}' points to a waitable background task that does not belong to the current Objective (tool={}, status={}); Runtime cancelled the invalid wait",
                    task_id,
                    job.tool_name,
                    job.status.as_str()
                ),
            ),
            None => (
                "wait_invalidated",
                None,
                format!(
                    "tool_task '{}' does not exist; Runtime cancelled the legacy or invalid wait. Use only a task_id explicitly returned by execution=background",
                    task_id
                ),
            ),
        };
        if event_kind == "wait_satisfied" {
            if let (Some(wait), Some(event_id)) =
                (objective.wait_condition.as_ref(), caused_by.as_deref())
            {
                self.satisfy_wait_dependency(&objective, wait, event_id)
                    .await?;
            }
        }
        let mutation = self
            .transition_objective(
                &objective,
                ObjectiveStatus::Active,
                None,
                Some(&reason),
                caused_by.as_deref().unwrap_or(task_id),
                "ObjectiveSupervisor-ExecutionJob",
            )
            .await?;
        match mutation {
            ObjectiveMutation::Updated(woken) => {
                tracing::warn!(
                    objective_id = %woken.id,
                    task_id,
                    event_kind,
                    reason,
                    event_code = "objective.tool_task_wait.reconciled",
                    "Objective tool-task wait was reconciled from authoritative ExecutionJob state"
                );
                self.publish_state_event(event_kind, &woken, caused_by.as_deref())
                    .await?;
                Box::pin(self.reconcile(woken)).await?;
            }
            ObjectiveMutation::Conflict { current } => {
                Box::pin(self.reconcile(current)).await?;
            }
            ObjectiveMutation::NotFound => {}
        }
        Ok(true)
    }

    async fn claim_routed_evaluation(
        self: &Arc<Self>,
        objective: &ObjectiveRecord,
        source_event_id: &str,
        activation_id: Option<&str>,
        publish_started: bool,
        pending_dependency_id: Option<&str>,
    ) -> Result<Option<ObjectiveRecord>, DynError> {
        let evaluation_id = format!(
            "objective_eval_{}_{}_{}",
            objective.id,
            objective.continuation_sequence.saturating_add(1),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let local_binding = ActiveObjectiveEvaluation {
            objective_id: objective.id.clone(),
            evaluation_id: evaluation_id.clone(),
            revision: objective.revision,
            started_at: Utc::now(),
            pending_dependency_id: pending_dependency_id.map(ToOwned::to_owned),
        };
        if self
            .evaluations
            .try_bind(&objective.id, local_binding)
            .is_err()
        {
            return Ok(None);
        }
        let lease_expires_at = Utc::now() + self.lease_duration;
        let claimed = if let Some(pending_dependency_id) = pending_dependency_id {
            self.claim_objective_interrupt_evaluation(
                objective,
                &evaluation_id,
                lease_expires_at,
                pending_dependency_id,
                source_event_id,
            )
            .await?
        } else {
            self.claim_objective_evaluation(
                objective,
                &evaluation_id,
                lease_expires_at,
                None,
                source_event_id,
            )
            .await?
        };
        let ObjectiveMutation::Updated(claimed) = claimed else {
            self.evaluations.unbind(&objective.id, &evaluation_id);
            return Ok(None);
        };
        if let Some(mut active) = self.evaluations.by_objective.get_mut(&objective.id) {
            if active.evaluation_id == evaluation_id {
                active.revision = claimed.revision;
            }
        }
        if let Some(activation_id) = activation_id {
            self.evaluations.bind_activation(
                activation_id,
                ActiveObjectiveEvaluation {
                    objective_id: claimed.id.clone(),
                    evaluation_id: evaluation_id.clone(),
                    revision: claimed.revision,
                    started_at: Utc::now(),
                    pending_dependency_id: pending_dependency_id.map(ToOwned::to_owned),
                },
            );
        }
        self.schedule_lease_expiry(&claimed, lease_expires_at)
            .await?;
        if publish_started {
            self.publish_state_event("evaluation_started", &claimed, Some(source_event_id))
                .await?;
        }
        Ok(Some(claimed))
    }

    async fn schedule(self: &Arc<Self>, objective_id: String) -> Result<(), DynError> {
        let lock = self
            .schedule_locks
            .entry(objective_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;
        let Some(objective) = self.store.get_objective(&objective_id).await? else {
            return Ok(());
        };
        if objective.status != ObjectiveStatus::Active
            || (self.scheduler_dependencies.is_none() && objective.wait_condition.is_some())
        {
            return Ok(());
        }
        if objective
            .evaluation_lease_expires_at
            .is_some_and(|expires_at| expires_at > Utc::now())
        {
            return Ok(());
        }
        if let Some(dependencies) = self.current_scheduler_dependencies(&objective).await? {
            if matches!(
                derive_objective_readiness(&objective, &dependencies, Utc::now()),
                ObjectiveReadiness::Waiting { .. }
            ) {
                return Ok(());
            }
        }
        // Defensive recovery for schedules created by older builds, or for a
        // crash between handing durable work to an Objective and installing
        // its wait route. An Objective-supervised open Group is authoritative:
        // never start a duplicate Evaluation while that work is still live.
        if let Some(store) = self.thread_groups.as_ref() {
            let open_group = store
                .list_thread_groups(ThreadGroupFilter {
                    context_id: Some(objective.context_id.clone()),
                    session_id: Some(objective.coordinator_session_id.clone()),
                    supervisor_kind: Some(ThreadSupervisorKind::Objective),
                    supervisor_id: Some(objective.id.clone()),
                    include_terminal: false,
                    newest_first: false,
                    limit: Some(1),
                    ..ThreadGroupFilter::default()
                })
                .await?
                .into_iter()
                .next();
            if let Some(group) = open_group {
                let reason = format!(
                    "detected non-terminal supervised Thread Group '{}'; Runtime restored the Objective wait to avoid duplicate evaluation",
                    group.id
                );
                let mutation = self
                    .transition_objective(
                        &objective,
                        ObjectiveStatus::Active,
                        Some(ObjectiveWaitCondition::ThreadGroup {
                            group_id: group.id.clone(),
                        }),
                        Some(&reason),
                        &group.id,
                        "ObjectiveSupervisor-Recovery",
                    )
                    .await?;
                // `reconcile_thread_group_wait` may immediately schedule the
                // next Evaluation if the Group won a terminal-state race, so
                // release this Objective's scheduler lock first.
                drop(_guard);
                match mutation {
                    ObjectiveMutation::Updated(waiting) => {
                        self.publish_state_event("wait_recovered", &waiting, Some(&reason))
                            .await?;
                        self.reconcile_thread_group_wait(waiting, &group.id).await?;
                    }
                    ObjectiveMutation::Conflict { current } => {
                        Box::pin(self.reconcile(current)).await?;
                    }
                    ObjectiveMutation::NotFound => {}
                }
                return Ok(());
            }
        }
        let evaluation_id = format!(
            "objective_eval_{}_{}_{}",
            objective.id,
            objective.continuation_sequence.saturating_add(1),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let local_binding = ActiveObjectiveEvaluation {
            objective_id: objective.id.clone(),
            evaluation_id: evaluation_id.clone(),
            revision: objective.revision,
            started_at: Utc::now(),
            pending_dependency_id: None,
        };
        if self
            .evaluations
            .try_bind(&objective.id, local_binding)
            .is_err()
        {
            return Ok(());
        }
        let lease_expires_at = Utc::now() + self.lease_duration;
        let claimed_revision = objective.revision.saturating_add(1);
        let context_objectives = self
            .store
            .list_context_objectives(&objective.context_id, true)
            .await?;
        let closure_review = objective_closure_review(&objective, &context_objectives);
        let (wake_source, objective_phase, continuation) =
            if let Some(review) = closure_review.as_ref() {
                (
                    "closure-review",
                    "closure-review",
                    format!(
                        "(objective-continuation (id {}) (revision {}) (evaluation {}) \
                         (reason closure-review) {})",
                        serde_json::to_string(&objective.id)?,
                        claimed_revision,
                        serde_json::to_string(&evaluation_id)?,
                        review.render(&objective)
                    ),
                )
            } else {
                (
                    "active-no-wait",
                    "executing",
                    format!(
                        "(objective-continuation (id {}) (revision {}) (evaluation {}) \
                         (reason active-no-wait) (instruction {}))",
                        serde_json::to_string(&objective.id)?,
                        claimed_revision,
                        serde_json::to_string(&evaluation_id)?,
                        serde_json::to_string(OBJECTIVE_CONTINUATION_INSTRUCTION)?
                    ),
                )
            };
        let objective_execution_root_id =
            crate::memory::objective_primary_execution_root_id(&objective.id, objective.generation);
        let mut continuation_payload = vec![
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("objective_id".to_string(), json!(objective.id)),
            ("objective_revision".to_string(), json!(claimed_revision)),
            ("objective_evaluation_id".to_string(), json!(evaluation_id)),
            ("runtime_force_evaluation".to_string(), json!(true)),
            ("tool_name".to_string(), json!("objective_supervisor")),
            ("tool_status".to_string(), json!("success")),
            ("wake_source".to_string(), json!(wake_source)),
            ("objective_phase".to_string(), json!(objective_phase)),
            (
                "root_turn_id".to_string(),
                json!(objective_execution_root_id),
            ),
            ("text".to_string(), json!(continuation)),
        ];
        if let Some(principal_id) = &objective.initiating_principal_id {
            continuation_payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let continuation_event = Event::new(
            format!("objective_continue_{evaluation_id}"),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            continuation_payload.into_iter().collect(),
        );
        let continuation_thread = NewThread {
            id: stable_thread_id(&objective_execution_root_id),
            agent_id: objective.agent_id.clone(),
            context_id: objective.context_id.clone(),
            session_id: objective.coordinator_session_id.clone(),
            initiating_principal_id: objective.initiating_principal_id.clone(),
            root_turn_id: objective_execution_root_id,
            kind: ThreadKind::Execution,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective_primary_execution(
                objective.id.clone(),
                objective.generation,
            ),
        };
        let claimed = self
            .claim_objective_evaluation(
                &objective,
                &evaluation_id,
                lease_expires_at,
                Some((continuation_event.clone(), continuation_thread)),
                &continuation_event.id,
            )
            .await?;
        let ObjectiveMutation::Updated(claimed) = claimed else {
            self.evaluations.unbind(&objective.id, &evaluation_id);
            return Ok(());
        };
        if let Some(mut active) = self.evaluations.by_objective.get_mut(&objective.id) {
            if active.evaluation_id == evaluation_id {
                active.revision = claimed.revision;
            }
        }
        self.schedule_lease_expiry(&claimed, lease_expires_at)
            .await?;
        self.publish_state_event("evaluation_started", &claimed, None)
            .await?;
        // The durable claim above is the scheduling commit point. Model
        // evaluation may update or finish this Objective and therefore must
        // not run while this Objective's scheduler mutex is still held.
        // Keeping the guard across the synchronous EventBus dispatch would
        // turn the stable primary Execution Thread into a self-deadlock: the
        // Activation waits for an Objective mutation whose reconciliation is
        // waiting for this very guard.
        drop(_guard);
        self.bus.dispatch_persisted(continuation_event).await?;
        Ok(())
    }

    async fn schedule_lease_expiry(
        &self,
        objective: &ObjectiveRecord,
        expires_at: DateTime<Utc>,
    ) -> Result<(), DynError> {
        let Some(evaluation_id) = objective.active_evaluation_id.as_deref() else {
            self.cancel_lease_timer(&objective.id).await?;
            return Ok(());
        };
        self.timers
            .schedule(NewRuntimeTimer {
                id: objective_lease_timer_id(&objective.id),
                generation: objective.revision,
                kind: RuntimeTimerKind::ObjectiveLease,
                owner_id: objective.id.clone(),
                due_at: expires_at,
                payload: json!({
                    "objective_id": objective.id,
                    "evaluation_id": evaluation_id,
                    "lease_expires_at": expires_at,
                }),
            })
            .await?;
        Ok(())
    }

    async fn schedule_wait_timer(
        &self,
        objective: &ObjectiveRecord,
        deadline: DateTime<Utc>,
    ) -> Result<(), DynError> {
        self.timers
            .schedule(NewRuntimeTimer {
                id: objective_wait_timer_id(&objective.id),
                generation: objective.revision,
                kind: RuntimeTimerKind::ObjectiveWait,
                owner_id: objective.id.clone(),
                due_at: deadline,
                payload: json!({
                    "objective_id": objective.id,
                    "deadline": deadline,
                }),
            })
            .await?;
        Ok(())
    }

    async fn dispatch_wait_timer(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let Some(current) = self.store.get_objective(&timer.owner_id).await? else {
            return Ok(TimerDisposition::Complete);
        };
        let Some(ObjectiveWaitCondition::Timer { deadline }) = current.wait_condition.as_ref()
        else {
            return Ok(TimerDisposition::Complete);
        };
        if current.status != ObjectiveStatus::Active {
            return Ok(TimerDisposition::Complete);
        }
        if current.revision != timer.generation || *deadline != timer.due_at {
            self.schedule_wait_timer(&current, *deadline).await?;
            return Ok(TimerDisposition::Complete);
        }
        if *deadline > Utc::now() {
            return Ok(TimerDisposition::Reschedule {
                due_at: *deadline,
                reason: Some("Objective timer deadline has not been reached".to_string()),
            });
        }
        let satisfaction_event = Event {
            id: format!(
                "objective_wait_timer_satisfied_{}_r{}",
                current.id, timer.generation
            ),
            sequence: None,
            timestamp: timer.due_at,
            actor: "Runtime-ObjectiveSupervisor".to_string(),
            event_type: TYPE_OBJECTIVE_CONTROL.to_string(),
            topic: "runtime/objective_wait_timer_satisfied".to_string(),
            payload: [
                ("context_id".to_string(), json!(&current.context_id)),
                (
                    "session_id".to_string(),
                    json!(&current.coordinator_session_id),
                ),
                ("objective_id".to_string(), json!(&current.id)),
                ("deadline".to_string(), json!(deadline)),
                ("timer_id".to_string(), json!(timer.id)),
            ]
            .into_iter()
            .collect(),
        };
        self.audit_store.append(satisfaction_event.clone()).await?;
        self.satisfy_wait_dependency(
            &current,
            current.wait_condition.as_ref().expect("timer wait checked"),
            &satisfaction_event.id,
        )
        .await?;
        match self
            .transition_objective(
                &current,
                ObjectiveStatus::Active,
                None,
                Some("timer wait has expired"),
                &satisfaction_event.id,
                "ObjectiveSupervisor-Timer",
            )
            .await?
        {
            ObjectiveMutation::Updated(woken) => {
                self.publish_state_event("wait_satisfied", &woken, Some(&satisfaction_event.id))
                    .await?;
                self.schedule(woken.id).await?;
            }
            ObjectiveMutation::Conflict { current } => self.reconcile(current).await?,
            ObjectiveMutation::NotFound => {}
        }
        Ok(TimerDisposition::Complete)
    }

    async fn dispatch_lease_timer(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let Some(current) = self.store.get_objective(&timer.owner_id).await? else {
            return Ok(TimerDisposition::Complete);
        };
        let Some(expires_at) = current.evaluation_lease_expires_at else {
            return Ok(TimerDisposition::Complete);
        };
        let timer_evaluation_id = timer
            .payload
            .get("evaluation_id")
            .and_then(serde_json::Value::as_str);
        if current.status != ObjectiveStatus::Active
            || current.active_evaluation_id.as_deref() != timer_evaluation_id
        {
            return Ok(TimerDisposition::Complete);
        }
        if current.revision != timer.generation {
            self.schedule_lease_expiry(&current, expires_at).await?;
            return Ok(TimerDisposition::Complete);
        }
        if expires_at != timer.due_at {
            return Ok(TimerDisposition::Reschedule {
                due_at: expires_at,
                reason: Some(
                    "Objective Evaluation lease was renewed by a running Activation".to_string(),
                ),
            });
        }
        if expires_at > Utc::now() {
            return Ok(TimerDisposition::Reschedule {
                due_at: expires_at,
                reason: Some("Objective evaluation lease has not expired".to_string()),
            });
        }
        // Revoke the exact expired Evaluation before making the Objective
        // schedulable again. Its Activation observes the tombstone and stops;
        // a new claim receives a different evaluation_id fencing token.
        self.revoke_local_evaluation(&current).await?;
        self.reconcile(current).await?;
        Ok(TimerDisposition::Complete)
    }

    async fn cancel_wait_timer(&self, objective_id: &str) -> Result<(), DynError> {
        self.timers
            .cancel(&objective_wait_timer_id(objective_id))
            .await?;
        Ok(())
    }

    async fn cancel_lease_timer(&self, objective_id: &str) -> Result<(), DynError> {
        self.timers
            .cancel(&objective_lease_timer_id(objective_id))
            .await?;
        Ok(())
    }

    async fn cancel_objective_timers(&self, objective_id: &str) -> Result<(), DynError> {
        self.cancel_wait_timer(objective_id).await?;
        self.cancel_lease_timer(objective_id).await
    }

    fn register_external_wait_subscription(
        self: &Arc<Self>,
        objective_id: &str,
        revision: u64,
        topic: &str,
    ) {
        if self
            .external_wait_subscriptions
            .get(objective_id)
            .is_some_and(|existing| existing.0 == revision && existing.1 == topic)
        {
            return;
        }
        self.remove_external_wait_subscription(objective_id);
        let supervisor = Arc::clone(self);
        let subscription_id = self.bus.subscribe(
            topic.to_string(),
            Arc::new(move |event| {
                let supervisor = Arc::clone(&supervisor);
                Box::pin(async move { supervisor.wake_non_routed_event(&event).await })
            }),
        );
        self.external_wait_subscriptions.insert(
            objective_id.to_string(),
            (revision, topic.to_string(), subscription_id),
        );
    }

    fn remove_external_wait_subscription(&self, objective_id: &str) {
        if let Some((_, (_, _, subscription_id))) =
            self.external_wait_subscriptions.remove(objective_id)
        {
            self.bus.unsubscribe(&subscription_id);
        }
    }

    fn clear_local_binding(&self, objective: &ObjectiveRecord) {
        if let Some(active) = self.evaluations.get_for_objective(&objective.id) {
            self.evaluations
                .unbind(&objective.id, &active.evaluation_id);
        }
    }

    async fn revoke_local_evaluation(&self, objective: &ObjectiveRecord) -> Result<(), DynError> {
        if let Some(evaluation_id) = objective.active_evaluation_id.as_deref() {
            let mut activation_ids = self
                .evaluations
                .activation_ids_for_evaluation(&objective.id, evaluation_id)
                .into_iter()
                .collect::<std::collections::HashSet<_>>();
            self.evaluations
                .cancel_evaluation(&objective.id, evaluation_id);
            if let Some(store) = self.activation_store.as_ref() {
                // The registry is deliberately process-local, so it is empty
                // after a Runtime restart. Recover the same exact fencing
                // relation from each nonterminal Activation's immutable
                // Trigger Event before claiming a replacement Evaluation.
                // Event-id reads are indexed and this path runs only at an
                // expired Objective lease boundary, not in the hot scheduler
                // loop.
                for activation in store
                    .list_context_thread_activations(&objective.context_id, false)
                    .await?
                {
                    if activation_ids.contains(&activation.id) {
                        continue;
                    }
                    let routed = self
                        .audit_store
                        .query(QueryFilter {
                            event_id: Some(activation.trigger_event_id.clone()),
                            ..QueryFilter::default()
                        })
                        .await?
                        .into_iter()
                        .find(|event| event.id == activation.trigger_event_id)
                        .is_some_and(|event| {
                            event
                                .payload
                                .get("objective_id")
                                .and_then(|value| value.as_str())
                                == Some(objective.id.as_str())
                                && event
                                    .payload
                                    .get("objective_evaluation_id")
                                    .and_then(|value| value.as_str())
                                    == Some(evaluation_id)
                        });
                    if routed {
                        activation_ids.insert(activation.id);
                    }
                }
                for activation_id in activation_ids {
                    // The Orchestrator may observe the cancellation tombstone
                    // and finish concurrently. CAS conflicts are therefore
                    // reloaded; a terminal row is already the desired fence.
                    let mut fenced = false;
                    for _ in 0..5 {
                        let Some(current) = store.get_thread_activation(&activation_id).await?
                        else {
                            fenced = true;
                            break;
                        };
                        if current.status.is_terminal() {
                            fenced = true;
                            break;
                        }
                        match store
                            .update_thread_activation(
                                &current.id,
                                current.revision,
                                ThreadActivationStatus::Cancelled,
                                None,
                                None,
                                current.context_snapshot_version,
                            )
                            .await?
                        {
                            ThreadActivationMutation::Updated(_)
                            | ThreadActivationMutation::NotFound => {
                                fenced = true;
                                break;
                            }
                            ThreadActivationMutation::Conflict { current }
                                if current.status.is_terminal() =>
                            {
                                fenced = true;
                                break;
                            }
                            ThreadActivationMutation::Conflict { .. } => continue,
                        }
                    }
                    if !fenced {
                        return Err(format!(
                            "stale Activation '{}' for Evaluation '{}' of Objective '{}' remained non-terminal after 5 CAS attempts; replacement Evaluation rejected",
                            activation_id, evaluation_id, objective.id
                        )
                        .into());
                    }
                }
            }
        }
        self.clear_local_binding(objective);
        Ok(())
    }

    async fn publish_state_event(
        &self,
        action: &str,
        objective: &ObjectiveRecord,
        reason: Option<&str>,
    ) -> Result<(), DynError> {
        let mut payload = vec![
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("objective_id".to_string(), json!(objective.id)),
            ("objective_revision".to_string(), json!(objective.revision)),
            ("objective_status".to_string(), json!(objective.status)),
            (
                "wait_condition".to_string(),
                json!(objective.wait_condition),
            ),
            (
                "active_evaluation_id".to_string(),
                json!(objective.active_evaluation_id),
            ),
        ];
        if let Some(reason) = reason {
            payload.push(("reason".to_string(), json!(reason)));
        }
        if let Some(principal_id) = &objective.initiating_principal_id {
            payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let event = Event::new(
            format!(
                "objective_{}_{}_{}",
                action,
                objective.id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            format!("objective/{action}"),
            payload.into_iter().collect(),
        );
        self.audit_store.append(event.clone()).await?;
        self.bus.publish(event).await
    }

    async fn publish_recovery_attention(
        &self,
        objective: &ObjectiveRecord,
        thread_id: &str,
        reason: &str,
    ) -> Result<(), DynError> {
        let mut payload = vec![
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("objective_id".to_string(), json!(objective.id)),
            ("objective_revision".to_string(), json!(objective.revision)),
            ("objective_status".to_string(), json!(objective.status)),
            ("thread_id".to_string(), json!(thread_id)),
            ("requires_operator_attention".to_string(), json!(true)),
            (
                "recovery_error_class".to_string(),
                json!("record_local_unrecoverable"),
            ),
            ("reason".to_string(), json!(reason)),
        ];
        if let Some(principal_id) = &objective.initiating_principal_id {
            payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let event = Event::new(
            format!(
                "objective_recovery_attention_{}_g{}_r{}",
                objective.id, objective.generation, objective.revision
            ),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "objective/recovery_attention_required".to_string(),
            payload.into_iter().collect(),
        );
        self.audit_store.append(event.clone()).await?;
        self.bus.publish(event).await
    }

    async fn publish_recovery_observation(
        &self,
        objective: &ObjectiveRecord,
    ) -> Result<(), DynError> {
        let mut payload = vec![
            ("context_id".to_string(), json!(objective.context_id)),
            (
                "session_id".to_string(),
                json!(objective.coordinator_session_id),
            ),
            ("objective_id".to_string(), json!(objective.id)),
            ("objective_revision".to_string(), json!(objective.revision)),
            ("objective_status".to_string(), json!(objective.status)),
            (
                "had_evaluation_lease".to_string(),
                json!(objective.active_evaluation_id.is_some()),
            ),
            (
                "wait_condition".to_string(),
                json!(objective.wait_condition),
            ),
        ];
        if let Some(principal_id) = &objective.initiating_principal_id {
            payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let event = Event::new(
            format!(
                "objective_recovered_{}_{}",
                objective.id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Runtime-ObjectiveSupervisor".to_string(),
            TYPE_OBJECTIVE_CONTROL.to_string(),
            "objective/recovered".to_string(),
            payload.into_iter().collect(),
        );
        self.audit_store.append(event.clone()).await?;
        self.bus.publish(event).await
    }
}

fn provider_failure_is_recoverable(failure_kind: &str) -> bool {
    matches!(
        failure_kind,
        "rate_limited"
            | "transient_network"
            | "server_unavailable"
            | "authentication"
            | "first_byte_timeout"
            | "stream_stalled"
            | "hard_deadline_exceeded"
            | "stream_idle_timeout"
            | "unknown"
    )
}

fn objective_wait_timer_id(objective_id: &str) -> String {
    format!("objective-wait:{objective_id}")
}

fn objective_lease_timer_id(objective_id: &str) -> String {
    format!("objective-lease:{objective_id}")
}

fn wait_matches_event(wait: &ObjectiveWaitCondition, event: &Event) -> bool {
    let payload_str = |key: &str| event.payload.get(key).and_then(|value| value.as_str());
    match wait {
        ObjectiveWaitCondition::ToolTask { task_id } => {
            payload_str("task_id") == Some(task_id.as_str())
                && matches!(
                    payload_str("task_status"),
                    Some(
                        "success"
                            | "succeeded"
                            | "failed"
                            | "cancelled"
                            | "killed"
                            | "lost"
                            | "timeout"
                    )
                )
        }
        ObjectiveWaitCondition::Delegation { delegation_id } => {
            payload_str("delegation_id") == Some(delegation_id.as_str())
                && matches!(
                    payload_str("tool_status").or_else(|| payload_str("status")),
                    Some("success" | "completed" | "error" | "failed" | "cancelled")
                )
        }
        ObjectiveWaitCondition::ThreadGroup { group_id } => {
            event.topic == "runtime/thread_group_terminal"
                && payload_str("thread_group_id") == Some(group_id.as_str())
                && matches!(
                    payload_str("thread_group_status"),
                    Some("satisfied" | "failed" | "cancelled")
                )
        }
        ObjectiveWaitCondition::Timer { .. } => false,
        ObjectiveWaitCondition::Permission { request_id } => {
            payload_str("approval_id") == Some(request_id.as_str())
        }
        ObjectiveWaitCondition::UserInput { session_id } => {
            event.event_type == crate::event::TYPE_USER_MESSAGE
                && payload_str("session_id") == Some(session_id.as_str())
        }
        ObjectiveWaitCondition::ExternalEvent {
            topic,
            correlation_id,
        } => {
            event.topic == *topic && payload_str("correlation_id") == Some(correlation_id.as_str())
        }
        ObjectiveWaitCondition::ResourceAvailable { resource } => {
            matches!(
                event.topic.as_str(),
                "runtime/resource_available" | TYPE_MODEL_CONFIGURATION_CHANGED
            ) && payload_str("resource") == Some(resource.as_str())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OrchestratorConfig;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        ExecutionJobStatus, ExecutionJobTerminal, ExecutionRetrySafety, NewAgent,
        NewCognitiveContext, NewDelegation, NewExecutionJob, NewPrincipal, NewSession, NewThread,
        NewThreadActivation, NewThreadGroup, NewThreadGroupMember, NewThreadGroupPlan,
        ScheduleStore as _, SessionDirectoryStore as _, SessionMountKind, ThreadActivationStatus,
        ThreadGroupPolicy, ThreadKind, ThreadLifecycle, ThreadMutation, TimerStore,
    };
    use crate::scheduler::{
        stable_scheduler_dependency_id, NewSchedulerDependency, SchedulerDependencyKind,
    };
    use tempfile::NamedTempFile;

    fn objective_update_arguments(wait_condition: JsonValue) -> JsonValue {
        json!({
            "objective_id": "objective-wait",
            "base_revision": 7,
            "status": "active",
            "reason": "等待用户输入",
            "evidence_refs": [],
            "wait_condition": wait_condition
        })
    }

    #[test]
    fn objective_update_wait_schema_is_a_flat_native_object_contract() {
        let schema = objective_wait_condition_schema();
        assert_eq!(schema["type"], "object");
        assert!(schema.get("oneOf").is_none());
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["kind"]));
        assert!(schema["properties"]["kind"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("user_input")));
    }

    #[test]
    fn objective_update_wait_accepts_native_and_single_layer_string_objects() {
        let condition = json!({
            "kind": "user_input",
            "session_id": "session-objective-wait"
        });
        let native: ObjectiveUpdateArgs =
            serde_json::from_value(objective_update_arguments(condition.clone())).unwrap();
        let native = native.wait_condition.unwrap();
        assert!(!native.decoded_from_string);
        assert_eq!(
            native.condition,
            ObjectiveWaitCondition::UserInput {
                session_id: "session-objective-wait".to_string()
            }
        );

        let encoded = serde_json::to_string(&condition).unwrap();
        let compatible: ObjectiveUpdateArgs =
            serde_json::from_value(objective_update_arguments(json!(encoded))).unwrap();
        let compatible = compatible.wait_condition.unwrap();
        assert!(compatible.decoded_from_string);
        assert_eq!(compatible.condition, native.condition);
    }

    #[test]
    fn objective_update_wait_rejects_recursive_or_ambiguous_compatibility_values() {
        let condition = json!({
            "kind": "user_input",
            "session_id": "session-objective-wait"
        });
        let once = serde_json::to_string(&condition).unwrap();
        let twice = serde_json::to_string(&once).unwrap();
        let recursive =
            serde_json::from_value::<ObjectiveUpdateArgs>(objective_update_arguments(json!(twice)))
                .unwrap_err()
                .to_string();
        assert!(recursive.contains("cannot decode recursively"));

        let unexpected =
            serde_json::from_value::<ObjectiveUpdateArgs>(objective_update_arguments(json!({
                "kind": "user_input",
                "session_id": "session-objective-wait",
                "task_id": "task-not-valid-for-user-input"
            })))
            .unwrap_err()
            .to_string();
        assert!(unexpected.contains("does not accept field 'task_id'"));
    }

    #[test]
    fn request_scoped_stream_timeouts_keep_objectives_recoverable() {
        assert!(provider_failure_is_recoverable("first_byte_timeout"));
        assert!(provider_failure_is_recoverable("stream_stalled"));
        assert!(provider_failure_is_recoverable("hard_deadline_exceeded"));
    }

    async fn seed_objective_bundle(store: &SqliteStore, suffix: &str) -> ObjectiveRecord {
        let agent_id = format!("agent-{suffix}");
        let context_id = format!("context-{suffix}");
        let session_id = format!("session-{suffix}");
        store
            .create_agent_bundle(
                NewAgent {
                    id: agent_id.clone(),
                    title: "Objective Agent".to_string(),
                    root_context_id: context_id.clone(),
                },
                NewCognitiveContext {
                    id: context_id.clone(),
                    agent_id: agent_id.clone(),
                    title: "Objective Context".to_string(),
                },
                NewSession {
                    id: session_id.clone(),
                    agent_id: agent_id.clone(),
                    context_id: context_id.clone(),
                    parent_session_id: None,
                    title: "Objective Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let principal_id = format!("principal-{suffix}");
        store
            .ensure_principal(NewPrincipal {
                id: principal_id.clone(),
                provider_id: "objective-test".to_string(),
                assurance: "test".to_string(),
                display_name: None,
            })
            .await
            .unwrap();
        store
            .bind_session_principal(&session_id, &principal_id)
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: format!("objective-{suffix}"),
                agent_id,
                context_id,
                coordinator_session_id: session_id.clone(),
                delivery_session_id: session_id,
                parent_objective_id: None,
                source_event_id: format!("source-{suffix}"),
                initiating_principal_id: Some(principal_id),
                stated_objective: "验证后台任务等待".to_string(),
                token_budget: None,
            })
            .await
            .unwrap()
    }

    fn invalid_model_failure_event(
        objective: &ObjectiveRecord,
        evaluation_id: &str,
        event_id: &str,
        model_request_started_at: DateTime<Utc>,
    ) -> Event {
        Event::new(
            event_id.to_string(),
            "Runtime-Orchestrator".to_string(),
            "agent_call".to_string(),
            "chat/no_reply".to_string(),
            [
                ("context_id".to_string(), json!(&objective.context_id)),
                (
                    "session_id".to_string(),
                    json!(&objective.coordinator_session_id),
                ),
                ("objective_id".to_string(), json!(&objective.id)),
                ("objective_evaluation_id".to_string(), json!(evaluation_id)),
                ("objective_revision".to_string(), json!(objective.revision)),
                (
                    "runtime_failure_kind".to_string(),
                    json!("invalid_model_or_request"),
                ),
                ("runtime_failure_stage".to_string(), json!("llm_completion")),
                (
                    "model_request_started_at".to_string(),
                    json!(model_request_started_at),
                ),
            ]
            .into_iter()
            .collect(),
        )
    }

    #[tokio::test]
    async fn recoverable_objective_cursor_visits_each_live_row_once() {
        let database = NamedTempFile::new().unwrap();
        let store = SqliteStore::new(database.path().to_str().unwrap())
            .await
            .unwrap();
        for suffix in ["cursor-a", "cursor-b", "cursor-c"] {
            seed_objective_bundle(&store, suffix).await;
        }

        let mut cursor = None;
        let mut visited = Vec::new();
        loop {
            let page = store
                .list_recoverable_objectives_page(cursor.as_ref(), 1)
                .await
                .unwrap();
            let Some(objective) = page.into_iter().next() else {
                break;
            };
            if visited.is_empty() {
                let mutation = store
                    .update_objective_state(
                        &objective.id,
                        objective.revision,
                        ObjectiveStatus::Active,
                        Some(ObjectiveWaitCondition::Timer {
                            deadline: Utc::now() + Duration::hours(1),
                        }),
                        Some("move updated_at without moving the recovery cursor"),
                    )
                    .await
                    .unwrap();
                assert!(matches!(mutation, ObjectiveMutation::Updated(_)));
            }
            cursor = Some(ObjectiveRecoveryCursor {
                created_at: objective.created_at,
                id: objective.id.clone(),
            });
            visited.push(objective.id);
        }
        assert_eq!(visited.len(), 3);
        assert_eq!(
            visited
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn startup_isolates_objective_whose_primary_thread_is_terminal() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "terminal-primary-recovery").await;
        let root_turn_id =
            crate::memory::objective_primary_execution_root_id(&objective.id, objective.generation);
        let thread_id = stable_thread_id(&root_turn_id);
        let thread = store
            .ensure_thread(NewThread {
                id: thread_id.clone(),
                agent_id: objective.agent_id.clone(),
                context_id: objective.context_id.clone(),
                session_id: objective.coordinator_session_id.clone(),
                initiating_principal_id: objective.initiating_principal_id.clone(),
                root_turn_id,
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::objective_primary_execution(
                    &objective.id,
                    objective.generation,
                ),
            })
            .await
            .unwrap();
        assert!(matches!(
            store
                .update_thread(
                    &thread.id,
                    thread.revision,
                    None,
                    Some(ThreadLifecycle::Completed),
                    None,
                    None,
                    None,
                    None,
                )
                .await
                .unwrap(),
            ThreadMutation::Updated(_)
        ));
        let leased = match store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                "evaluation-terminal-primary-recovery",
                Utc::now() - Duration::seconds(1),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(leased) => leased,
            mutation => panic!("unexpected Objective lease mutation: {mutation:?}"),
        };

        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_thread_store(Arc::clone(&store) as Arc<dyn ThreadStore>),
        );
        supervisor.register_timer_handlers().unwrap();

        Arc::clone(&supervisor)
            .start()
            .await
            .expect("one unrecoverable historical Objective must not block Runtime startup");

        let isolated = store.get_objective(&leased.id).await.unwrap().unwrap();
        assert_eq!(isolated.status, ObjectiveStatus::Blocked);
        assert!(isolated.active_evaluation_id.is_none());
        assert!(isolated
            .status_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("fixed primary Thread is already terminal")));
        let attention = store
            .query(QueryFilter {
                context_id: Some(isolated.context_id.clone()),
                topic: Some("objective/recovery_attention_required".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(attention.len(), 1);
        assert_eq!(
            attention[0]
                .payload
                .get("requires_operator_attention")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            attention[0]
                .payload
                .get("thread_id")
                .and_then(serde_json::Value::as_str),
            Some(thread_id.as_str())
        );
    }

    #[tokio::test]
    async fn directed_primary_thread_event_claims_bound_interrupt_without_clearing_wait() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let created = seed_objective_bundle(&store, "directed-interrupt").await;
        let waiting = match store
            .update_objective_state(
                &created.id,
                created.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::Timer {
                    deadline: Utc::now() + Duration::hours(1),
                }),
                Some("等待下一次巡检"),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected wait mutation: {mutation:?}"),
        };
        let evaluations = Arc::new(ObjectiveEvaluationRegistry::default());
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::clone(&evaluations),
                Arc::clone(&timers),
                std::time::Duration::from_millis(120),
            )
            .with_scheduler_dependency_store(
                Arc::clone(&store) as Arc<dyn SchedulerDependencyStore>
            ),
        );
        supervisor.register_timer_handlers().unwrap();
        Arc::clone(&supervisor).start().await.unwrap();
        let root =
            crate::memory::objective_primary_execution_root_id(&waiting.id, waiting.generation);
        let interrupt = Event::new(
            "objective-directed-interrupt".to_string(),
            "Runtime-Scheduler".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/schedule_due".to_string(),
            [
                ("context_id".to_string(), json!(waiting.context_id)),
                (
                    "session_id".to_string(),
                    json!(waiting.coordinator_session_id),
                ),
                ("root_turn_id".to_string(), json!(root)),
                ("objective_interrupt".to_string(), json!(true)),
                ("objective_id".to_string(), json!(waiting.id)),
                (
                    "objective_generation".to_string(),
                    json!(waiting.generation),
                ),
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(
            supervisor
                .prepare_routed_event(&interrupt, "activation-directed-interrupt")
                .await
                .unwrap(),
            RoutedObjectiveEventDisposition::Admitted
        );
        let interrupted = store.get_objective(&waiting.id).await.unwrap().unwrap();
        assert_eq!(interrupted.wait_condition, waiting.wait_condition);
        assert!(interrupted.active_evaluation_id.is_some());
        assert_eq!(
            evaluations
                .get_for_activation("activation-directed-interrupt")
                .map(|binding| binding.objective_id),
            Some(waiting.id.clone())
        );
        let dependencies = store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
                owner_id: Some(waiting.id.clone()),
                required_only: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(dependencies.len(), 1);
        assert_eq!(dependencies[0].status, SchedulerDependencyStatus::Pending);

        let amend_tool = ObjectiveAmendTool::new(
            Arc::clone(&supervisor),
            Arc::new(
                ContextEngine::new(
                    Arc::clone(&store) as Arc<dyn EventStore>,
                    OrchestratorConfig::default(),
                )
                .with_session_store(Arc::clone(&store) as Arc<dyn crate::memory::SessionStore>),
            ),
        );
        let amend_arguments = json!({
            "objective_id": waiting.id,
            "base_revision": interrupted.revision,
            "stated_objective": "验证修订后的巡检目标",
            "reason": "用户在等待期间纠正了目标范围",
            "evidence_refs": []
        })
        .to_string();
        let amend_error = CURRENT_SESSION_ID
            .scope(
                waiting.coordinator_session_id.clone(),
                CURRENT_CONTEXT_ID.scope(
                    waiting.context_id.clone(),
                    CURRENT_ATTEMPT_ID.scope(
                        "activation-directed-interrupt".to_string(),
                        CURRENT_PRINCIPAL_ID.scope(
                            waiting.initiating_principal_id.clone(),
                            CURRENT_CAUSAL_ROUTE.scope(
                                Some(crate::tool::ToolCausalRoute {
                                    thread_id: "thread-unrelated-dialogue".to_string(),
                                    activation_id: "activation-directed-interrupt".to_string(),
                                    model_attempt_id: None,
                                    root_turn_id: "turn-unrelated-dialogue".to_string(),
                                    trigger_event_id: "event-unrelated-dialogue".to_string(),
                                    trigger_sequence: 1,
                                }),
                                amend_tool.execute(&amend_arguments),
                            ),
                        ),
                    ),
                ),
            )
            .await
            .unwrap_err();
        assert!(amend_error
            .to_string()
            .contains("Objective-bound Evaluation may not modify its own completion contract"));
        let unchanged = store.get_objective(&waiting.id).await.unwrap().unwrap();
        assert_eq!(unchanged.stated_objective, waiting.stated_objective);
        assert_eq!(unchanged.wait_condition, waiting.wait_condition);
        assert_eq!(
            store
                .get_scheduler_dependency(&dependencies[0].id)
                .await
                .unwrap()
                .unwrap()
                .status,
            SchedulerDependencyStatus::Pending
        );

        let stale = Event {
            id: "objective-directed-interrupt-stale".to_string(),
            ..interrupt
        };
        assert_eq!(
            supervisor
                .prepare_routed_event(&stale, "activation-directed-interrupt-stale")
                .await
                .unwrap(),
            RoutedObjectiveEventDisposition::Suppressed
        );
        assert!(evaluations
            .get_for_activation("activation-directed-interrupt-stale")
            .is_none());

        // The Evaluation lease itself is intentionally short (120 ms), while
        // this outer bound only protects the test harness. Leave enough wall
        // clock margin for a heavily loaded parallel test runner to schedule
        // the dispatcher after the durable timer becomes due.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                timers.dispatch_due_once().await.unwrap();
                if evaluations
                    .cancelled_activation("activation-directed-interrupt")
                    .is_some()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the supervisor dispatcher must expire the interrupt Evaluation");
        let expired = store.get_objective(&waiting.id).await.unwrap().unwrap();
        assert_eq!(
            expired.wait_condition, waiting.wait_condition,
            "an expired interrupt Evaluation must retain the original crash-recovery wait"
        );
    }

    #[tokio::test]
    async fn owner_dialogue_amendment_commits_contract_and_primary_signal_atomically() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "dialogue-amendment").await;
        let waiting = match store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::Timer {
                    deadline: Utc::now() + Duration::hours(1),
                }),
                Some("等待用户补充验收边界"),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected wait mutation: {mutation:?}"),
        };
        let source_event = Event::new(
            "user-objective-amendment".to_string(),
            waiting
                .initiating_principal_id
                .clone()
                .expect("seeded Objective must have an owner"),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            [
                ("context_id".to_string(), json!(waiting.context_id)),
                (
                    "session_id".to_string(),
                    json!(waiting.coordinator_session_id),
                ),
                (
                    "principal_id".to_string(),
                    json!(waiting.initiating_principal_id),
                ),
                ("text".to_string(), json!("把验收范围补充为包含回归测试")),
            ]
            .into_iter()
            .collect(),
        );
        store.append(source_event.clone()).await.unwrap();
        let dialogue_thread = store
            .ensure_thread(NewThread {
                id: stable_thread_id(&source_event.id),
                agent_id: waiting.agent_id.clone(),
                context_id: waiting.context_id.clone(),
                session_id: waiting.coordinator_session_id.clone(),
                initiating_principal_id: waiting.initiating_principal_id.clone(),
                root_turn_id: source_event.id.clone(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let evaluations = Arc::new(ObjectiveEvaluationRegistry::default());
        let bus = Arc::new(InMemoryEventBus::new());
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            bus,
            evaluations,
            timers,
            std::time::Duration::from_secs(60),
        ));
        let tool = ObjectiveAmendTool::new(
            supervisor,
            Arc::new(
                ContextEngine::new(
                    Arc::clone(&store) as Arc<dyn EventStore>,
                    OrchestratorConfig::default(),
                )
                .with_session_store(Arc::clone(&store) as Arc<dyn crate::memory::SessionStore>),
            ),
        );
        let arguments = json!({
            "objective_id": waiting.id,
            "base_revision": waiting.revision,
            "stated_objective": "完成实现，并以完整回归测试作为验收条件",
            "reason": "用户补充了明确的验收边界",
            "evidence_refs": [source_event.id]
        })
        .to_string();
        let result = CURRENT_SESSION_ID
            .scope(
                waiting.coordinator_session_id.clone(),
                CURRENT_CONTEXT_ID.scope(
                    waiting.context_id.clone(),
                    CURRENT_ATTEMPT_ID.scope(
                        "dialogue-amendment-activation".to_string(),
                        CURRENT_PRINCIPAL_ID.scope(
                            waiting.initiating_principal_id.clone(),
                            CURRENT_CAUSAL_ROUTE.scope(
                                Some(crate::tool::ToolCausalRoute {
                                    thread_id: dialogue_thread.id,
                                    activation_id: "dialogue-amendment-activation".to_string(),
                                    model_attempt_id: None,
                                    root_turn_id: source_event.id.clone(),
                                    trigger_event_id: source_event.id.clone(),
                                    trigger_sequence: 1,
                                }),
                                tool.execute(&arguments),
                            ),
                        ),
                    ),
                ),
            )
            .await
            .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["status"], "committed");
        let amended = store.get_objective(&waiting.id).await.unwrap().unwrap();
        assert_eq!(
            amended.stated_objective,
            "完成实现，并以完整回归测试作为验收条件"
        );
        assert_eq!(amended.wait_condition, waiting.wait_condition);
        assert!(amended.active_evaluation_id.is_none());
        let primary_thread_id = stable_thread_id(
            &crate::memory::objective_primary_execution_root_id(&amended.id, amended.generation),
        );
        let signals = store
            .list_context_thread_signals(&amended.context_id, None)
            .await
            .unwrap();
        assert!(signals.iter().any(|signal| {
            signal.thread_id == primary_thread_id && signal.event_id.starts_with("objective_amend_")
        }));
    }

    #[tokio::test]
    async fn active_objective_recovers_wait_for_legacy_open_supervised_group() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "legacy-open-group").await;
        let group_id = "group-legacy-open-objective";
        let mut supervision = crate::memory::ThreadSupervision::objective(
            objective.id.clone(),
            "legacy-source-evaluation".to_string(),
            objective.revision,
            None,
        );
        supervision.thread_group_id = Some(group_id.to_string());
        store
            .commit_schedule_transaction(
                &[],
                &[],
                &[NewThread {
                    id: "thread-legacy-open-objective".to_string(),
                    agent_id: objective.agent_id.clone(),
                    context_id: objective.context_id.clone(),
                    session_id: objective.coordinator_session_id.clone(),
                    initiating_principal_id: objective.initiating_principal_id.clone(),
                    root_turn_id: "root-legacy-open-objective".to_string(),
                    kind: ThreadKind::Execution,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                    supervision,
                }],
                &[],
                &[NewThreadGroupPlan {
                    group: NewThreadGroup {
                        id: group_id.to_string(),
                        context_id: objective.context_id.clone(),
                        session_id: objective.coordinator_session_id.clone(),
                        supervisor_kind: ThreadSupervisorKind::Objective,
                        supervisor_id: objective.id.clone(),
                        generation: objective.revision,
                        policy: ThreadGroupPolicy::All,
                        completion_contract: Default::default(),
                    },
                    members: vec![NewThreadGroupMember {
                        thread_id: "thread-legacy-open-objective".to_string(),
                        ordinal: 0,
                        required: true,
                    }],
                }],
            )
            .await
            .unwrap();

        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_thread_group_store(Arc::clone(&store) as Arc<dyn ThreadGroupStore>),
        );
        supervisor.started.store(true, Ordering::Release);
        supervisor.reconcile(objective.clone()).await.unwrap();

        let recovered = store
            .get_objective(&objective.id)
            .await
            .unwrap()
            .expect("objective");
        assert_eq!(
            recovered.wait_condition,
            Some(ObjectiveWaitCondition::ThreadGroup {
                group_id: group_id.to_string(),
            })
        );
        assert!(
            recovered.active_evaluation_id.is_none(),
            "an open supervised Group must block a duplicate Evaluation"
        );
        let recovered_events = store
            .query(QueryFilter {
                context_id: Some(objective.context_id),
                topic: Some("objective/wait_recovered".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(recovered_events.len(), 1);
    }

    #[tokio::test]
    async fn structured_dependency_blocks_every_objective_schedule_entrypoint() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "scheduler-dependency").await;
        let dependency_id = stable_scheduler_dependency_id(
            SchedulerDependencyOwnerKind::Objective,
            &objective.id,
            objective.generation,
            SchedulerDependencyKind::Resource,
            "provider:test",
            1,
        );
        store
            .register_scheduler_dependency(NewSchedulerDependency {
                id: dependency_id.clone(),
                owner_kind: SchedulerDependencyOwnerKind::Objective,
                owner_id: objective.id.clone(),
                owner_generation: objective.generation,
                dependency_kind: SchedulerDependencyKind::Resource,
                dependency_id: "provider:test".to_string(),
                dependency_generation: 1,
                required: true,
                metadata: serde_json::json!({"test": true}),
            })
            .await
            .unwrap();

        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_scheduler_dependency_store(
                Arc::clone(&store) as Arc<dyn SchedulerDependencyStore>
            ),
        );
        supervisor.started.store(true, Ordering::Release);

        // Direct scheduling is also a Kernel entrypoint. It must not bypass
        // the same dependency authority used by reconcile/recovery.
        supervisor.schedule(objective.id.clone()).await.unwrap();
        let waiting = store
            .get_objective(&objective.id)
            .await
            .unwrap()
            .expect("objective");
        assert!(waiting.active_evaluation_id.is_none());

        store
            .append(Event::new(
                "resource-available-test".to_string(),
                "Runtime-Test".to_string(),
                "runtime/resource_available".to_string(),
                "runtime/resource_available".to_string(),
                serde_json::json!({
                    "context_id": objective.context_id,
                    "session_id": objective.coordinator_session_id,
                    "resource": "provider:test",
                })
                .as_object()
                .expect("object")
                .clone(),
            ))
            .await
            .unwrap();
        let satisfied = store
            .satisfy_scheduler_dependency(
                &dependency_id,
                objective.generation,
                1,
                "resource-available-test",
            )
            .await
            .unwrap();
        assert!(matches!(
            satisfied,
            crate::scheduler::SchedulerDependencyMutation::Updated(_)
        ));
        supervisor.schedule(objective.id.clone()).await.unwrap();
        let runnable = store
            .get_objective(&objective.id)
            .await
            .unwrap()
            .expect("objective");
        assert!(runnable.active_evaluation_id.is_some());
    }

    #[tokio::test]
    async fn continuous_reconcile_consumes_a_persisted_resource_event_without_live_delivery() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "missed-resource-delivery").await;
        let resource = "model-provider:test";
        let waiting = match store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ResourceAvailable {
                    resource: resource.to_string(),
                }),
                Some("waiting for provider"),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(waiting) => waiting,
            mutation => panic!("unexpected wait mutation: {mutation:?}"),
        };
        let dependency_id = stable_scheduler_dependency_id(
            SchedulerDependencyOwnerKind::Objective,
            &waiting.id,
            waiting.generation,
            SchedulerDependencyKind::Resource,
            resource,
            1,
        );
        store
            .register_scheduler_dependency(NewSchedulerDependency {
                id: dependency_id.clone(),
                owner_kind: SchedulerDependencyOwnerKind::Objective,
                owner_id: waiting.id.clone(),
                owner_generation: waiting.generation,
                dependency_kind: SchedulerDependencyKind::Resource,
                dependency_id: resource.to_string(),
                dependency_generation: 1,
                required: true,
                metadata: json!({"fixture": true}),
            })
            .await
            .unwrap();
        let recovered = Event::new(
            "provider-recovered-without-live-handler".to_string(),
            "Runtime-Test".to_string(),
            "runtime_control".to_string(),
            "runtime/resource_available".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(waiting.context_id)),
                (
                    "session_id".to_string(),
                    json!(waiting.coordinator_session_id),
                ),
                ("resource".to_string(), json!(resource)),
            ]),
        );
        // Commit the physical fact without dispatching it through EventBus,
        // reproducing a process-local subscriber failure after persistence.
        store.append(recovered.clone()).await.unwrap();

        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                timers,
                std::time::Duration::from_secs(600),
            )
            .with_scheduler_dependency_store(
                Arc::clone(&store) as Arc<dyn SchedulerDependencyStore>
            ),
        );
        supervisor.started.store(true, Ordering::Release);

        assert!(supervisor.reconcile_continuous_batch(true).await.unwrap() > 0);
        let dependency = store
            .get_scheduler_dependency(&dependency_id)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(dependency.status, SchedulerDependencyStatus::Pending);
        let resumed = store.get_objective(&waiting.id).await.unwrap().unwrap();
        assert!(resumed.wait_condition.is_none());
        assert!(resumed.active_evaluation_id.is_some());
    }

    #[tokio::test]
    async fn terminal_group_barrier_reconciles_an_objective_whose_legacy_wait_was_precleared() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "precleared-group-wake").await;
        let group_id = "group-precleared-objective-wake";
        let waiting = match store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ThreadGroup {
                    group_id: group_id.to_string(),
                }),
                Some("waiting for terminal group"),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(waiting) => waiting,
            mutation => panic!("unexpected wait mutation: {mutation:?}"),
        };
        let dependency_id = stable_scheduler_dependency_id(
            SchedulerDependencyOwnerKind::Objective,
            &waiting.id,
            waiting.generation,
            SchedulerDependencyKind::ThreadGroup,
            group_id,
            1,
        );
        store
            .register_scheduler_dependency(NewSchedulerDependency {
                id: dependency_id.clone(),
                owner_kind: SchedulerDependencyOwnerKind::Objective,
                owner_id: waiting.id.clone(),
                owner_generation: waiting.generation,
                dependency_kind: SchedulerDependencyKind::ThreadGroup,
                dependency_id: group_id.to_string(),
                dependency_generation: 1,
                required: true,
                metadata: json!({"fixture": true}),
            })
            .await
            .unwrap();
        let barrier = Event::new(
            "thread_group_barrier_group-precleared-objective-wake_g1".to_string(),
            "Runtime".to_string(),
            "runtime_control".to_string(),
            "runtime/thread_group_terminal".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(waiting.context_id)),
                (
                    "session_id".to_string(),
                    json!(waiting.coordinator_session_id),
                ),
                ("objective_id".to_string(), json!(waiting.id)),
                ("thread_group_id".to_string(), json!(group_id)),
                ("thread_group_status".to_string(), json!("satisfied")),
            ]),
        );
        store.append(barrier.clone()).await.unwrap();
        store
            .satisfy_scheduler_dependency(&dependency_id, waiting.generation, 1, &barrier.id)
            .await
            .unwrap();
        let precleared = match store
            .update_objective_state(
                &waiting.id,
                waiting.revision,
                ObjectiveStatus::Active,
                None,
                None,
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(precleared) => precleared,
            mutation => panic!("unexpected preclear mutation: {mutation:?}"),
        };
        assert!(precleared.wait_condition.is_none());
        assert!(precleared.active_evaluation_id.is_none());

        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_scheduler_dependency_store(
                Arc::clone(&store) as Arc<dyn SchedulerDependencyStore>
            ),
        );
        supervisor.started.store(true, Ordering::Release);
        supervisor.wake_non_routed_event(&barrier).await.unwrap();

        let resumed = store
            .get_objective(&precleared.id)
            .await
            .unwrap()
            .expect("objective");
        assert!(resumed.active_evaluation_id.is_some());
        assert_eq!(resumed.continuation_sequence, 1);
        let continuations = store
            .query(QueryFilter {
                context_id: Some(resumed.context_id),
                topic: Some("chat/tool_output".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        let continuation = continuations
            .iter()
            .find(|event| {
                event
                    .payload
                    .get("objective_id")
                    .and_then(serde_json::Value::as_str)
                    == Some(resumed.id.as_str())
            })
            .expect("Objective wake must persist one continuation");
        assert_eq!(
            continuation
                .payload
                .get("wake_source")
                .and_then(serde_json::Value::as_str),
            Some("active-no-wait")
        );
        let text = continuation
            .payload
            .get("text")
            .and_then(serde_json::Value::as_str)
            .expect("Objective continuation must carry its semantic contract");
        assert!(text.contains("classify the previous Objective Evaluation"));
        assert!(text.contains("eliminates a live hypothesis"));
        assert!(text.contains("take the next materially different safe action"));
        assert!(text.contains("at least three consecutive Objective Evaluations"));
        assert!(text.contains("call objective_update(status=completed)"));
    }

    #[test]
    fn continuation_contract_distinguishes_exploration_from_repetition() {
        let contract = OBJECTIVE_CONTINUATION_INSTRUCTION;

        assert!(contract.contains("progress:"));
        assert!(contract.contains("verified-wait:"));
        assert!(contract.contains("no-progress:"));
        assert!(contract.contains("finds no confirming evidence still counts"));
        assert!(contract.contains("eliminates a live hypothesis"));
        assert!(contract.contains("repeated an equivalent action"));
        assert!(contract.contains("same blocker has been confirmed"));
        assert!(contract.contains("every explicit requirement"));
        assert!(contract.contains("missing, weak, indirect"));
        assert!(!contract.contains("token budget"));
    }

    #[tokio::test]
    async fn closure_review_requires_at_least_one_child_and_all_children_terminal() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let parent = seed_objective_bundle(&store, "closure-review").await;
        let child = store
            .create_objective(NewObjective {
                id: "objective-closure-review-child".to_string(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                coordinator_session_id: parent.coordinator_session_id.clone(),
                delivery_session_id: parent.delivery_session_id.clone(),
                parent_objective_id: Some(parent.id.clone()),
                source_event_id: "source-closure-review-child".to_string(),
                initiating_principal_id: None,
                stated_objective: "完成一个可验证切片".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();

        let with_active_child = store
            .list_context_objectives(&parent.context_id, true)
            .await
            .unwrap();
        assert!(objective_closure_review(&parent, &with_active_child).is_none());

        let updated = store
            .update_objective_state(
                &child.id,
                child.revision,
                ObjectiveStatus::Completed,
                None,
                Some("切片验证完成"),
            )
            .await
            .unwrap();
        assert!(matches!(updated, ObjectiveMutation::Updated(_)));

        let with_terminal_child = store
            .list_context_objectives(&parent.context_id, true)
            .await
            .unwrap();
        let review = objective_closure_review(&parent, &with_terminal_child)
            .expect("all terminal children must produce a closure-review boundary");
        assert_eq!(
            review.child_states,
            vec![(child.id, ObjectiveStatus::Completed)]
        );
        let rendered = review.render(&parent);
        assert!(rendered.contains("(phase closure-review)"));
        assert!(rendered.contains("(status completed)"));
        assert!(rendered.contains("(decision-authority agent)"));
        assert!(rendered.contains("(required-commit state-or-action)"));
        assert!(rendered.contains("(completion-contract"));

        let bus = Arc::new(InMemoryEventBus::new());
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            bus,
            Arc::new(ObjectiveEvaluationRegistry::default()),
            timers,
            std::time::Duration::from_secs(600),
        ));
        supervisor.schedule(parent.id.clone()).await.unwrap();

        let continuations = store
            .query(QueryFilter {
                context_id: Some(parent.context_id),
                topic: Some("chat/tool_output".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        let continuation = continuations
            .iter()
            .find(|event| {
                event
                    .payload
                    .get("objective_id")
                    .and_then(|value| value.as_str())
                    == Some(parent.id.as_str())
            })
            .expect("Objective scheduling must persist one continuation");
        assert_eq!(
            continuation
                .payload
                .get("wake_source")
                .and_then(serde_json::Value::as_str),
            Some("closure-review")
        );
        assert_eq!(
            continuation
                .payload
                .get("objective_phase")
                .and_then(serde_json::Value::as_str),
            Some("closure-review")
        );
        let text = continuation
            .payload
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        assert!(text.contains("(objective-state (phase closure-review)"));
        assert!(text.contains("(decision-authority agent)"));
        assert!(text.contains("(required-commit state-or-action)"));
        assert!(text.contains("(terminal-children"));
        assert!(!text.contains("Do not broadly reread"));
        assert!(!text.contains("Choose exactly one"));
    }

    async fn seed_background_execution_job(
        store: &SqliteStore,
        objective: &ObjectiveRecord,
        suffix: &str,
    ) -> ExecutionJobRecord {
        let thread_id = format!("thread-{suffix}");
        let activation_id = format!("activation-{suffix}");
        let root_turn_id = format!("root-{suffix}");
        store
            .ensure_thread(NewThread {
                id: thread_id.clone(),
                agent_id: objective.agent_id.clone(),
                context_id: objective.context_id.clone(),
                session_id: objective.coordinator_session_id.clone(),
                initiating_principal_id: objective.initiating_principal_id.clone(),
                root_turn_id: root_turn_id.clone(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.clone(),
                agent_id: objective.agent_id.clone(),
                context_id: objective.context_id.clone(),
                session_id: objective.coordinator_session_id.clone(),
                initiating_principal_id: objective.initiating_principal_id.clone(),
                trigger_event_id: format!("trigger-{suffix}"),
                trigger_sequence: 1,
                trigger_kind: "chat/tool_output".to_string(),
                parent_activation_id: None,
                root_turn_id,
            })
            .await
            .unwrap();
        store
            .create_execution_job(NewExecutionJob {
                id: format!("job-{suffix}"),
                activation_id,
                thread_id,
                agent_id: objective.agent_id.clone(),
                context_id: objective.context_id.clone(),
                session_id: objective.coordinator_session_id.clone(),
                initiating_principal_id: objective.initiating_principal_id.clone(),
                target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string(),
                tool_call_id: format!("call-{suffix}"),
                tool_name: "exec/background".to_string(),
                request: json!({"kind":"background_exec"}),
                retry_safety: ExecutionRetrySafety::ReconcileRequired,
                requires_approval: false,
            })
            .await
            .unwrap()
    }

    async fn seed_delegation(
        store: &SqliteStore,
        objective: &ObjectiveRecord,
        suffix: &str,
    ) -> crate::memory::DelegationRecord {
        let child_context_id = format!("child-context-{suffix}");
        let child_session_id = format!("child-session-{suffix}");
        store
            .create_test_context(NewCognitiveContext {
                id: child_context_id.clone(),
                agent_id: objective.agent_id.clone(),
                title: "Delegated Objective Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: child_session_id.clone(),
                agent_id: objective.agent_id.clone(),
                context_id: child_context_id.clone(),
                parent_session_id: None,
                title: "Delegated Objective Session".to_string(),
                mount_kind: SessionMountKind::DelegationProjection,
            })
            .await
            .unwrap();
        store
            .create_delegation(NewDelegation {
                id: format!("delegation-{suffix}"),
                agent_id: objective.agent_id.clone(),
                parent_context_id: objective.context_id.clone(),
                parent_session_id: objective.coordinator_session_id.clone(),
                child_context_id,
                child_session_id,
                initiating_principal_id: objective.initiating_principal_id.clone(),
                task: "核验父 Objective 的一个切片".to_string(),
                success_when: Some("返回可引用的核验结论".to_string()),
                context_scope: "current_session".to_string(),
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn provider_failure_waits_for_runtime_resource_and_restart_releases_process_gate() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "provider-resource-wait").await;
        let evaluation_id = "evaluation-provider-resource-wait";
        let claimed = match store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                evaluation_id,
                Utc::now() + Duration::minutes(10),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected claim: {mutation:?}"),
        };
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_secs(600),
        ));
        let terminal = Event::new(
            "provider-failure-terminal".to_string(),
            "Runtime-Orchestrator".to_string(),
            "agent_call".to_string(),
            "chat/no_reply".to_string(),
            [
                ("context_id".to_string(), json!(&claimed.context_id)),
                (
                    "session_id".to_string(),
                    json!(&claimed.coordinator_session_id),
                ),
                ("objective_id".to_string(), json!(&claimed.id)),
                ("objective_evaluation_id".to_string(), json!(evaluation_id)),
                ("objective_revision".to_string(), json!(claimed.revision)),
                (
                    "runtime_failure_kind".to_string(),
                    json!("transient_network"),
                ),
                ("runtime_failure_stage".to_string(), json!("llm_completion")),
                ("wait_resource".to_string(), json!("model-provider:test")),
            ]
            .into_iter()
            .collect(),
        );
        supervisor.terminal_outcome(&terminal).await.unwrap();

        let waiting = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert_eq!(waiting.status, ObjectiveStatus::Active);
        assert!(matches!(
            waiting.wait_condition,
            Some(ObjectiveWaitCondition::ResourceAvailable { ref resource })
                if resource == "model-provider:test"
        ));
        assert!(waiting.active_evaluation_id.is_none());

        // The Provider circuit/maintenance owner is process-local. After a
        // restart no old process can publish its recovery signal, so startup
        // must release only Runtime-owned resources and create a fresh probe.
        Arc::clone(&supervisor).start().await.unwrap();
        let recovered = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert_eq!(recovered.status, ObjectiveStatus::Active);
        assert!(recovered.wait_condition.is_none());
        assert!(recovered.active_evaluation_id.is_some());
    }

    #[tokio::test]
    async fn invalid_model_request_waits_for_an_explicit_configuration_change() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "invalid-model-wait").await;
        let evaluation_id = "evaluation-invalid-model-wait";
        let claimed = match store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                evaluation_id,
                Utc::now() + Duration::minutes(10),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected claim: {mutation:?}"),
        };
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_secs(600),
        ));
        let terminal = invalid_model_failure_event(
            &claimed,
            evaluation_id,
            "invalid-model-terminal",
            Utc::now() - Duration::seconds(1),
        );
        supervisor.terminal_outcome(&terminal).await.unwrap();

        let waiting = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert_eq!(waiting.status, ObjectiveStatus::Active);
        assert!(matches!(
            waiting.wait_condition,
            Some(ObjectiveWaitCondition::ResourceAvailable { ref resource })
                if resource == MODEL_CONFIGURATION_RESOURCE
        ));
        assert!(waiting.active_evaluation_id.is_none());

        // The configuration epoch is the crash-recovery authority. Even if
        // the live context-local resource Event was not dispatched before a
        // process stop, startup observes this durable fact and continues.
        store
            .append(Event::new(
                "model-configuration-changed-after-wait".to_string(),
                "Runtime-ModelConfiguration".to_string(),
                "runtime_control".to_string(),
                TYPE_MODEL_CONFIGURATION_CHANGED.to_string(),
                [("resource".to_string(), json!(MODEL_CONFIGURATION_RESOURCE))]
                    .into_iter()
                    .collect(),
            ))
            .await
            .unwrap();
        let persisted = supervisor
            .find_persisted_wait_event(&waiting)
            .await
            .unwrap();
        assert!(
            persisted.is_some(),
            "configuration epoch must satisfy the persisted wait"
        );
        Arc::clone(&supervisor).start().await.unwrap();
        let recovered = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert!(recovered.wait_condition.is_none());
        assert!(recovered.active_evaluation_id.is_some());

        // Replaying or publishing another configuration epoch after the wait
        // has been satisfied must not create a second physical Evaluation.
        let active_evaluation_id = recovered.active_evaluation_id.clone();
        let duplicate = Event::new(
            "model-configuration-changed-duplicate".to_string(),
            "Runtime-ModelConfiguration".to_string(),
            "runtime_control".to_string(),
            "runtime/resource_available".to_string(),
            [
                ("context_id".to_string(), json!(&recovered.context_id)),
                ("resource".to_string(), json!(MODEL_CONFIGURATION_RESOURCE)),
            ]
            .into_iter()
            .collect(),
        );
        supervisor.wake_non_routed_event(&duplicate).await.unwrap();
        let after_duplicate = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert_eq!(after_duplicate.active_evaluation_id, active_evaluation_id);
    }

    #[tokio::test]
    async fn invalid_old_request_does_not_miss_a_concurrent_configuration_change() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "invalid-model-concurrent-change").await;
        let evaluation_id = "evaluation-invalid-model-concurrent-change";
        let claimed = match store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                evaluation_id,
                Utc::now() + Duration::minutes(10),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected claim: {mutation:?}"),
        };
        let request_started_at = Utc::now() - Duration::seconds(1);
        store
            .append(Event::new(
                "model-configuration-changed-in-flight".to_string(),
                "Runtime-ModelConfiguration".to_string(),
                "runtime_control".to_string(),
                TYPE_MODEL_CONFIGURATION_CHANGED.to_string(),
                [("resource".to_string(), json!(MODEL_CONFIGURATION_RESOURCE))]
                    .into_iter()
                    .collect(),
            ))
            .await
            .unwrap();
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_secs(600),
        ));
        let terminal = invalid_model_failure_event(
            &claimed,
            evaluation_id,
            "invalid-model-terminal-after-change",
            request_started_at,
        );
        supervisor.terminal_outcome(&terminal).await.unwrap();

        let retried = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert_eq!(retried.status, ObjectiveStatus::Active);
        assert!(retried.wait_condition.is_none());
        supervisor.start().await.unwrap();
        let retried = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert!(retried.active_evaluation_id.is_some());
    }

    #[tokio::test]
    async fn provider_configuration_failure_never_terminally_blocks_objective() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "provider-auth-recovery").await;
        let evaluation_id = "evaluation-provider-auth-recovery";
        let claimed = match store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                evaluation_id,
                Utc::now() + Duration::minutes(10),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected claim: {mutation:?}"),
        };
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_secs(90),
        ));
        let terminal = Event::new(
            "provider-auth-failure-terminal".to_string(),
            "Runtime-Orchestrator".to_string(),
            "agent_call".to_string(),
            "chat/no_reply".to_string(),
            [
                ("context_id".to_string(), json!(&claimed.context_id)),
                (
                    "session_id".to_string(),
                    json!(&claimed.coordinator_session_id),
                ),
                ("objective_id".to_string(), json!(&claimed.id)),
                ("objective_evaluation_id".to_string(), json!(evaluation_id)),
                ("objective_revision".to_string(), json!(claimed.revision)),
                ("runtime_failure_kind".to_string(), json!("authentication")),
                ("runtime_failure_stage".to_string(), json!("llm_completion")),
                (
                    "wait_resource".to_string(),
                    json!("model-provider:test-auth"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        supervisor.terminal_outcome(&terminal).await.unwrap();

        let waiting = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert_eq!(waiting.status, ObjectiveStatus::Active);
        assert!(matches!(
            waiting.wait_condition,
            Some(ObjectiveWaitCondition::ResourceAvailable { ref resource })
                if resource == "model-provider:test-auth"
        ));
        assert!(waiting.active_evaluation_id.is_none());
        assert!(waiting
            .status_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("wait for Runtime to recover resource")));
    }

    #[tokio::test]
    async fn expired_objective_evaluation_cancels_old_activation_before_replacement() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "expired-evaluation-fence").await;
        let old_evaluation_id = "evaluation-expired-evaluation-fence";
        let claimed = match store
            .claim_objective_evaluation(
                &objective.id,
                objective.revision,
                old_evaluation_id,
                Utc::now() - Duration::seconds(1),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected claim: {mutation:?}"),
        };

        let root_turn_id = "root-expired-evaluation-fence";
        let activation_id = "activation-expired-evaluation-fence";
        let trigger_event_id = "trigger-expired-evaluation-fence";
        store
            .ensure_thread(NewThread {
                id: "thread-expired-evaluation-fence".to_string(),
                agent_id: claimed.agent_id.clone(),
                context_id: claimed.context_id.clone(),
                session_id: claimed.coordinator_session_id.clone(),
                initiating_principal_id: claimed.initiating_principal_id.clone(),
                root_turn_id: root_turn_id.to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        store
            .append(Event::new(
                trigger_event_id.to_string(),
                "Runtime-ObjectiveSupervisor".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                [
                    ("context_id".to_string(), json!(claimed.context_id)),
                    (
                        "session_id".to_string(),
                        json!(claimed.coordinator_session_id),
                    ),
                    ("objective_id".to_string(), json!(claimed.id)),
                    (
                        "objective_evaluation_id".to_string(),
                        json!(old_evaluation_id),
                    ),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        let activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: activation_id.to_string(),
                agent_id: claimed.agent_id.clone(),
                context_id: claimed.context_id.clone(),
                session_id: claimed.coordinator_session_id.clone(),
                initiating_principal_id: claimed.initiating_principal_id.clone(),
                trigger_event_id: trigger_event_id.to_string(),
                trigger_sequence: 1,
                trigger_kind: "chat/tool_output".to_string(),
                parent_activation_id: None,
                root_turn_id: root_turn_id.to_string(),
            })
            .await
            .unwrap();
        let activation = match store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Running,
                Some("worker-old"),
                Some(Utc::now() + Duration::minutes(10)),
                None,
            )
            .await
            .unwrap()
        {
            ThreadActivationMutation::Updated(activation) => activation,
            mutation => panic!("unexpected activation claim: {mutation:?}"),
        };

        // Simulate a process restart: the process-local routing registry is
        // empty, while the immutable Trigger Event still carries the exact
        // Objective/Evaluation fencing route.
        let evaluations = Arc::new(ObjectiveEvaluationRegistry::default());
        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                evaluations,
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_activation_store(Arc::clone(&store) as Arc<dyn ActivationStore>),
        );
        // Drive the same path used by the live lease timer without starting a
        // background dispatcher in the test process.
        supervisor.started.store(true, Ordering::Release);
        supervisor.reconcile(claimed.clone()).await.unwrap();

        let old_activation = store
            .get_thread_activation(&activation.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old_activation.status, ThreadActivationStatus::Cancelled);
        let stale_commit = store
            .commit_activation_outcome(
                &old_activation.id,
                &Event::new(
                    "stale-objective-outcome".to_string(),
                    "Agent-Test".to_string(),
                    "agent_call".to_string(),
                    "runtime/thread_result".to_string(),
                    [
                        (
                            "session_id".to_string(),
                            json!(claimed.coordinator_session_id),
                        ),
                        ("root_turn_id".to_string(), json!(root_turn_id)),
                        (
                            "thread_id".to_string(),
                            json!("thread-expired-evaluation-fence"),
                        ),
                        ("text".to_string(), json!("stale")),
                    ]
                    .into_iter()
                    .collect(),
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            stale_commit,
            crate::memory::ActivationOutcomeCommit::StaleActivation
        );
        let replacement = store.get_objective(&claimed.id).await.unwrap().unwrap();
        assert_eq!(replacement.status, ObjectiveStatus::Active);
        assert_ne!(
            replacement.active_evaluation_id.as_deref(),
            Some(old_evaluation_id)
        );
        assert!(replacement.active_evaluation_id.is_some());
    }

    #[tokio::test]
    async fn startup_recovers_a_persisted_external_wake_that_was_never_dispatched() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-recovery".to_string(),
                    title: "Recovery Agent".to_string(),
                    root_context_id: "context-recovery".to_string(),
                },
                NewCognitiveContext {
                    id: "context-recovery".to_string(),
                    agent_id: "agent-recovery".to_string(),
                    title: "Recovery Context".to_string(),
                },
                NewSession {
                    id: "session-recovery".to_string(),
                    agent_id: "agent-recovery".to_string(),
                    context_id: "context-recovery".to_string(),
                    parent_session_id: None,
                    title: "Recovery Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_objective(NewObjective {
                id: "objective-persisted-wake".to_string(),
                agent_id: "agent-recovery".to_string(),
                context_id: "context-recovery".to_string(),
                coordinator_session_id: "session-recovery".to_string(),
                delivery_session_id: "session-recovery".to_string(),
                parent_objective_id: None,
                source_event_id: "source-persisted-wake".to_string(),
                initiating_principal_id: Some("principal:recovery-user".to_string()),
                stated_objective: "外部事件到达后继续".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let waiting = store
            .update_objective_state(
                "objective-persisted-wake",
                1,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ExternalEvent {
                    topic: "build/released".to_string(),
                    correlation_id: "release-42".to_string(),
                }),
                Some("等待构建发布"),
            )
            .await
            .unwrap();
        assert!(matches!(waiting, ObjectiveMutation::Updated(_)));

        // This is the exact commit-before-dispatch crash window: the physical
        // fact is durable, but no EventBus instance has ever observed it.
        let wake_event = Event::new(
            "release-event-42".to_string(),
            "Build-System".to_string(),
            "external_event".to_string(),
            "build/released".to_string(),
            [
                ("context_id".to_string(), json!("context-recovery")),
                ("session_id".to_string(), json!("session-recovery")),
                ("correlation_id".to_string(), json!("release-42")),
            ]
            .into_iter()
            .collect(),
        );
        store.append(wake_event.clone()).await.unwrap();

        let bus = Arc::new(InMemoryEventBus::new());
        let timers = Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>));
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            bus,
            Arc::new(ObjectiveEvaluationRegistry::default()),
            timers,
            std::time::Duration::from_secs(600),
        ));
        supervisor.start().await.unwrap();

        let recovered = store
            .get_objective("objective-persisted-wake")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, ObjectiveStatus::Active);
        assert!(recovered.wait_condition.is_none());
        assert!(recovered.active_evaluation_id.is_some());
        assert_eq!(recovered.continuation_sequence, 1);
        assert_eq!(
            recovered.initiating_principal_id.as_deref(),
            Some("principal:recovery-user")
        );
        let wait_events = store
            .query(QueryFilter {
                context_id: Some("context-recovery".to_string()),
                topic: Some("objective/wait_satisfied".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(wait_events.len(), 1);
        assert_eq!(
            wait_events[0]
                .payload
                .get("principal_id")
                .and_then(serde_json::Value::as_str),
            Some("principal:recovery-user")
        );
        assert_eq!(
            wait_events[0]
                .payload
                .get("reason")
                .and_then(serde_json::Value::as_str),
            Some(wake_event.id.as_str())
        );
        let continuation_events = store
            .query(QueryFilter {
                context_id: Some("context-recovery".to_string()),
                topic: Some("chat/tool_output".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(continuation_events.len(), 1);
        assert_eq!(
            continuation_events[0]
                .payload
                .get("principal_id")
                .and_then(serde_json::Value::as_str),
            Some("principal:recovery-user")
        );
    }

    #[tokio::test]
    async fn tool_task_wait_accepts_only_live_runtime_background_jobs() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "tool-wait-validation").await;
        let job = seed_background_execution_job(&store, &objective, "tool-wait-live").await;
        let supervisor = ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_secs(600),
        )
        .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>);

        supervisor
            .validate_wait_condition(
                &objective,
                &ObjectiveWaitCondition::ToolTask {
                    task_id: job.id.clone(),
                },
            )
            .await
            .unwrap();

        let missing = supervisor
            .validate_wait_condition(
                &objective,
                &ObjectiveWaitCondition::ToolTask {
                    task_id: "job-from-artifact-name".to_string(),
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(missing.contains("does not exist"));
        assert!(missing.contains("execution=background"));

        let terminal = store
            .finish_execution_job(
                &job.id,
                job.revision,
                None,
                ExecutionJobTerminal {
                    status: ExecutionJobStatus::Cancelled,
                    result_event_id: Some("result-tool-wait-live".to_string()),
                    result_refs: Vec::new(),
                    error: Some("cancelled by test".to_string()),
                    exit_code: None,
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            terminal,
            crate::memory::ExecutionJobMutation::Updated(_)
        ));
        let ended = supervisor
            .validate_wait_condition(
                &objective,
                &ObjectiveWaitCondition::ToolTask { task_id: job.id },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(ended.contains("already terminal"));
        assert!(ended.contains("result-tool-wait-live"));
    }

    #[tokio::test]
    async fn delegation_wait_accepts_only_live_routed_delegations() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "delegation-wait-validation").await;
        let delegation = seed_delegation(&store, &objective, "delegation-wait-live").await;
        let supervisor = ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::new(ObjectiveEvaluationRegistry::default()),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_secs(600),
        )
        .with_delegation_store(Arc::clone(&store) as Arc<dyn DelegationStore>);

        supervisor
            .validate_wait_condition(
                &objective,
                &ObjectiveWaitCondition::Delegation {
                    delegation_id: delegation.id.clone(),
                },
            )
            .await
            .unwrap();

        let result = Event::new(
            "delegation-wait-result".to_string(),
            "Sub-Agent".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), json!(&objective.context_id)),
                (
                    "session_id".to_string(),
                    json!(&objective.coordinator_session_id),
                ),
                ("delegation_id".to_string(), json!(&delegation.id)),
                ("tool_status".to_string(), json!("success")),
            ]
            .into_iter()
            .collect(),
        );
        assert!(store
            .commit_delegation_result(&delegation.id, &result)
            .await
            .unwrap());
        let ended = supervisor
            .validate_wait_condition(
                &objective,
                &ObjectiveWaitCondition::Delegation {
                    delegation_id: delegation.id,
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(ended.contains("already terminal"));
        assert!(ended.contains("delegation-wait-result"));
    }

    #[tokio::test]
    async fn startup_consumes_a_terminal_delegation_wait_from_projection() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "terminal-delegation-wait").await;
        let delegation = seed_delegation(&store, &objective, "terminal-delegation-wait").await;
        let result = Event::new(
            "terminal-delegation-result".to_string(),
            "Sub-Agent".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [
                ("context_id".to_string(), json!(&objective.context_id)),
                (
                    "session_id".to_string(),
                    json!(&objective.coordinator_session_id),
                ),
                ("delegation_id".to_string(), json!(&delegation.id)),
                ("tool_status".to_string(), json!("success")),
            ]
            .into_iter()
            .collect(),
        );
        assert!(store
            .commit_delegation_result(&delegation.id, &result)
            .await
            .unwrap());
        store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::Delegation {
                    delegation_id: delegation.id,
                }),
                Some("模拟委派终态与等待登记竞态"),
            )
            .await
            .unwrap();

        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_delegation_store(Arc::clone(&store) as Arc<dyn DelegationStore>),
        );
        supervisor.start().await.unwrap();

        let recovered = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert!(recovered.wait_condition.is_none());
        assert!(recovered.active_evaluation_id.is_some());
        assert!(recovered
            .status_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("terminal-delegation-result")));
        let satisfied = store
            .query(QueryFilter {
                context_id: Some(objective.context_id),
                topic: Some("objective/wait_satisfied".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(satisfied.len(), 1);
        assert_eq!(
            satisfied[0]
                .payload
                .get("reason")
                .and_then(serde_json::Value::as_str),
            Some("terminal-delegation-result")
        );
    }

    #[tokio::test]
    async fn startup_invalidates_a_missing_tool_task_wait_and_resumes_objective() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "missing-tool-wait").await;
        let waiting = store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ToolTask {
                    task_id: "job-from-synchronous-artifact".to_string(),
                }),
                Some("旧版 Runtime 接受了未经验证的 task_id"),
            )
            .await
            .unwrap();
        assert!(matches!(waiting, ObjectiveMutation::Updated(_)));

        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>),
        );
        supervisor.start().await.unwrap();

        let recovered = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert!(recovered.wait_condition.is_none());
        assert!(recovered.active_evaluation_id.is_some());
        assert!(recovered
            .status_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("does not exist")));
        // Objective EventBus business handlers are intentionally asynchronous.
        // Under a busy test process the recovery handler can make the durable
        // state visible just before its audit Event is appended, so assert the
        // bounded eventual contract instead of racing the handler scheduler.
        let invalidated = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let events = store
                    .query(QueryFilter {
                        context_id: Some(objective.context_id.clone()),
                        topic: Some("objective/wait_invalidated".to_string()),
                        ..QueryFilter::default()
                    })
                    .await
                    .unwrap();
                if !events.is_empty() {
                    break events;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("wait invalidation audit event should converge");
        assert_eq!(invalidated.len(), 1);
    }

    #[tokio::test]
    async fn startup_consumes_a_terminal_tool_task_wait_from_execution_projection() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        let objective = seed_objective_bundle(&store, "terminal-tool-wait").await;
        let job = seed_background_execution_job(&store, &objective, "terminal-tool-wait").await;
        let terminal = store
            .finish_execution_job(
                &job.id,
                job.revision,
                None,
                ExecutionJobTerminal {
                    status: ExecutionJobStatus::Cancelled,
                    result_event_id: Some("terminal-tool-result".to_string()),
                    result_refs: Vec::new(),
                    error: Some("cancelled before wait registration".to_string()),
                    exit_code: None,
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            terminal,
            crate::memory::ExecutionJobMutation::Updated(_)
        ));
        store
            .update_objective_state(
                &objective.id,
                objective.revision,
                ObjectiveStatus::Active,
                Some(ObjectiveWaitCondition::ToolTask { task_id: job.id }),
                Some("模拟任务终态与等待登记竞态"),
            )
            .await
            .unwrap();

        let supervisor = Arc::new(
            ObjectiveSupervisor::new(
                Arc::clone(&store) as Arc<dyn ObjectiveStore>,
                Arc::clone(&store) as Arc<dyn EventStore>,
                Arc::new(InMemoryEventBus::new()),
                Arc::new(ObjectiveEvaluationRegistry::default()),
                Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
                std::time::Duration::from_secs(600),
            )
            .with_execution_job_store(Arc::clone(&store) as Arc<dyn ExecutionJobStore>),
        );
        supervisor.start().await.unwrap();

        let recovered = store.get_objective(&objective.id).await.unwrap().unwrap();
        assert!(recovered.wait_condition.is_none());
        assert!(recovered.active_evaluation_id.is_some());
        assert!(recovered
            .status_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("terminal-tool-result")));
        let satisfied = store
            .query(QueryFilter {
                context_id: Some(objective.context_id),
                topic: Some("objective/wait_satisfied".to_string()),
                ..QueryFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(satisfied.len(), 1);
        assert_eq!(
            satisfied[0]
                .payload
                .get("reason")
                .and_then(serde_json::Value::as_str),
            Some("terminal-tool-result")
        );
    }

    #[test]
    fn evaluation_registry_serializes_each_objective_but_not_its_session() {
        let registry = ObjectiveEvaluationRegistry::default();
        let first = ActiveObjectiveEvaluation {
            objective_id: "objective-a".to_string(),
            evaluation_id: "evaluation-a".to_string(),
            revision: 2,
            started_at: Utc::now(),
            pending_dependency_id: None,
        };
        assert!(registry.try_bind("objective-a", first.clone()).is_ok());
        registry.bind_activation("work-a", first.clone());
        assert_eq!(registry.get_for_activation("work-a"), Some(first.clone()));
        assert!(registry.get_for_activation("work-b").is_none());
        let competing = ActiveObjectiveEvaluation {
            objective_id: "objective-a".to_string(),
            evaluation_id: "evaluation-a-2".to_string(),
            revision: 3,
            started_at: Utc::now(),
            pending_dependency_id: None,
        };
        assert_eq!(
            registry.try_bind("objective-a", competing),
            Err(first.clone())
        );
        let sibling = ActiveObjectiveEvaluation {
            objective_id: "objective-b".to_string(),
            evaluation_id: "evaluation-b".to_string(),
            revision: 2,
            started_at: Utc::now(),
            pending_dependency_id: None,
        };
        assert!(registry.try_bind("objective-b", sibling.clone()).is_ok());
        registry.bind_activation("work-b", sibling.clone());
        registry.unbind("objective-a", "wrong-evaluation");
        assert_eq!(
            registry.get_for_objective("objective-a"),
            Some(first.clone())
        );
        assert_eq!(
            registry.get_for_objective("objective-b"),
            Some(sibling.clone())
        );
        registry.unbind("objective-a", "evaluation-a");
        assert!(registry.get_for_objective("objective-a").is_none());
        assert_eq!(
            registry.get_for_objective("objective-b"),
            Some(sibling.clone())
        );
        assert_eq!(registry.get_for_activation("work-a"), Some(first));
        registry.remove_activation("work-a");
        assert!(registry.get_for_activation("work-a").is_none());
        assert_eq!(registry.get_for_activation("work-b"), Some(sibling));
    }

    #[tokio::test]
    async fn evaluation_cancellation_targets_only_bound_work_and_cleans_its_tombstone() {
        let registry = Arc::new(ObjectiveEvaluationRegistry::default());
        let first = ActiveObjectiveEvaluation {
            objective_id: "objective-a".to_string(),
            evaluation_id: "evaluation-a".to_string(),
            revision: 2,
            started_at: Utc::now(),
            pending_dependency_id: None,
        };
        let second = ActiveObjectiveEvaluation {
            objective_id: "objective-b".to_string(),
            evaluation_id: "evaluation-b".to_string(),
            revision: 4,
            started_at: Utc::now(),
            pending_dependency_id: None,
        };
        registry.bind_activation("work-a", first.clone());
        registry.bind_activation("work-b", second.clone());

        let waiting = {
            let registry = Arc::clone(&registry);
            tokio::spawn(async move {
                registry
                    .wait_for_activation_cancellation("work-a_response_retry_1")
                    .await
            })
        };
        assert!(registry.cancel_evaluation("objective-a", "evaluation-a"));
        assert_eq!(waiting.await.unwrap(), first);
        assert!(registry.cancelled_activation("work-b").is_none());
        assert!(registry.cancelled_activation("unbound-dialogue").is_none());

        registry.remove_activation("work-a_response_retry_2");
        assert!(!registry.cancelled_evaluations.contains_key("evaluation-a"));
        assert_eq!(registry.get_for_activation("work-b"), Some(second));

        assert!(!registry.cancel_evaluation("objective-late", "evaluation-never-claimed"));
        assert!(!registry
            .cancelled_evaluations
            .contains_key("evaluation-never-claimed"));
    }

    #[tokio::test]
    async fn stale_evaluation_heartbeat_loses_fence_and_cancels_its_activation() {
        let database = NamedTempFile::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(&database.path().to_string_lossy())
                .await
                .unwrap(),
        );
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-fence".to_string(),
                    title: "Fence Agent".to_string(),
                    root_context_id: "context-fence".to_string(),
                },
                NewCognitiveContext {
                    id: "context-fence".to_string(),
                    agent_id: "agent-fence".to_string(),
                    title: "Fence Context".to_string(),
                },
                NewSession {
                    id: "session-fence".to_string(),
                    agent_id: "agent-fence".to_string(),
                    context_id: "context-fence".to_string(),
                    parent_session_id: None,
                    title: "Fence Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let created = store
            .create_objective(NewObjective {
                id: "objective-fence".to_string(),
                agent_id: "agent-fence".to_string(),
                context_id: "context-fence".to_string(),
                coordinator_session_id: "session-fence".to_string(),
                delivery_session_id: "session-fence".to_string(),
                parent_objective_id: None,
                source_event_id: "source-fence".to_string(),
                initiating_principal_id: None,
                stated_objective: "verify stale evaluation fencing".to_string(),
                token_budget: None,
            })
            .await
            .unwrap();
        let claimed = match store
            .claim_objective_evaluation(
                &created.id,
                created.revision,
                "evaluation-old",
                Utc::now() + Duration::milliseconds(150),
            )
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected claim: {mutation:?}"),
        };
        let registry = Arc::new(ObjectiveEvaluationRegistry::default());
        let binding = ActiveObjectiveEvaluation {
            objective_id: claimed.id.clone(),
            evaluation_id: "evaluation-old".to_string(),
            revision: claimed.revision,
            started_at: Utc::now(),
            pending_dependency_id: None,
        };
        registry
            .try_bind("objective-fence", binding.clone())
            .unwrap();
        registry.bind_activation("activation-old", binding.clone());
        let supervisor = Arc::new(ObjectiveSupervisor::new(
            Arc::clone(&store) as Arc<dyn ObjectiveStore>,
            Arc::clone(&store) as Arc<dyn EventStore>,
            Arc::new(InMemoryEventBus::new()),
            Arc::clone(&registry),
            Arc::new(TimerEngine::new(Arc::clone(&store) as Arc<dyn TimerStore>)),
            std::time::Duration::from_millis(150),
        ));
        let heartbeat = {
            let supervisor = Arc::clone(&supervisor);
            tokio::spawn(
                async move { supervisor.maintain_activation_lease("activation-old").await },
            )
        };

        let released = match store
            .finish_objective_evaluation(&claimed.id, "evaluation-old", 0, 0)
            .await
            .unwrap()
        {
            ObjectiveMutation::Updated(objective) => objective,
            mutation => panic!("unexpected finish: {mutation:?}"),
        };
        let replacement = store
            .claim_objective_evaluation(
                &released.id,
                released.revision,
                "evaluation-new",
                Utc::now() + Duration::seconds(1),
            )
            .await
            .unwrap();
        assert!(matches!(replacement, ObjectiveMutation::Updated(_)));

        let revoked = tokio::time::timeout(std::time::Duration::from_secs(1), heartbeat)
            .await
            .expect("stale heartbeat must stop")
            .unwrap()
            .unwrap();
        assert_eq!(revoked, binding);
        assert_eq!(
            registry.cancelled_activation("activation-old"),
            Some(binding)
        );
        assert!(!supervisor
            .activation_fence_is_current("activation-old")
            .await
            .unwrap());
    }

    #[test]
    fn wait_conditions_match_only_their_exact_physical_wake_event() {
        let event = |event_type: &str, topic: &str, payload: serde_json::Value| {
            Event::new(
                "event-1".to_string(),
                "test".to_string(),
                event_type.to_string(),
                topic.to_string(),
                payload.as_object().unwrap().clone(),
            )
        };
        let running = event(
            TYPE_TOOL_OUTPUT,
            "chat/tool_output",
            json!({"task_id":"task-1","task_status":"running"}),
        );
        let completed = event(
            TYPE_TOOL_OUTPUT,
            "chat/tool_output",
            json!({"task_id":"task-1","task_status":"succeeded"}),
        );
        let task_wait = ObjectiveWaitCondition::ToolTask {
            task_id: "task-1".to_string(),
        };
        assert!(!wait_matches_event(&task_wait, &running));
        assert!(wait_matches_event(&task_wait, &completed));
        assert!(wait_matches_event(
            &task_wait,
            &event(
                TYPE_TOOL_OUTPUT,
                "chat/tool_output",
                json!({"task_id":"task-1","task_status":"cancelled"}),
            )
        ));

        let user_wait = ObjectiveWaitCondition::UserInput {
            session_id: "session-b".to_string(),
        };
        assert!(wait_matches_event(
            &user_wait,
            &event(
                crate::event::TYPE_USER_MESSAGE,
                "chat/user_message",
                json!({"session_id":"session-b"}),
            )
        ));
        assert!(!wait_matches_event(
            &user_wait,
            &event(
                crate::event::TYPE_USER_MESSAGE,
                "chat/user_message",
                json!({"session_id":"session-a"}),
            )
        ));

        let external_wait = ObjectiveWaitCondition::ExternalEvent {
            topic: "build/released".to_string(),
            correlation_id: "release-42".to_string(),
        };
        assert!(wait_matches_event(
            &external_wait,
            &event(
                "external_event",
                "build/released",
                json!({"correlation_id":"release-42"}),
            )
        ));
        assert!(!wait_matches_event(
            &external_wait,
            &event(
                "external_event",
                "build/released",
                json!({"correlation_id":"release-41"}),
            )
        ));
    }
}
