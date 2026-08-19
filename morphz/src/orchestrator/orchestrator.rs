use crate::activation_admission::{
    ActivationAdmissionController, ActivationAdmissionError, ActivationAdmissionLimits,
    ActivationAdmissionPermit, RestoreQueuedOutcome, SuspendedActivationAdmission,
};
use crate::admission::{AdmissionClass, AdmissionKey};
use crate::approval::{
    capability_lease_policy_digest, capability_lease_was_approved, stable_capability_lease_id,
    ApprovalDecision, ApprovalRequest, CapabilityLeaseOffer, HumanApprovalHub,
    CAPABILITY_LEASE_APPROVED_RISK_TAG,
};
use crate::approval_authority::stable_approval_identity;
use crate::config::OrchestratorConfig;
use crate::event::{
    DurableEventDeliveryQueue, Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_INFER_REQUEST,
    TYPE_RUNTIME_WAKE, TYPE_SESSION_SIGNAL, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
};
use crate::execution::{
    ExecutionJobManager, ExecutionJobSpec, JobClaim, JobHeartbeat, JobOutcome, JobReceipt,
};
use crate::harness::{DomainHarness, HarnessBinding, HarnessRegistry as DomainHarnessRegistry};
use crate::harness_package::{
    load_evaluation_harness_binding, load_objective_harness_binding,
    persist_evaluation_harness_binding,
};
use crate::llm::{
    attachment_message, provider_continuation_message, Client, Message, ModelFailure,
    ModelFailureKind, ModelRequestContext, ModelUsage, PromptTokenAccuracy, PromptTokenCount,
    ProviderContinuation, ToolDefinition,
};
use crate::memory::{
    stable_thread_activation_id, stable_thread_id, ActionGroupFilter, ActionGroupMemberRecord,
    ActionGroupMemberStatus, ActionGroupRecord, ActionGroupStore, ActivationOutcomeCommit,
    ApprovalFilter, ApprovalMutation, ApprovalRecord, ApprovalResolution, ApprovalStatus,
    ApprovalStore, CapabilityLeaseFilter, CapabilityLeaseMutation, CapabilityLeaseStore,
    DelegationFilter, DelegationStatus, DeliveryFlushCommit, EventAppend, EventStore,
    ExecutionApprovalMutation, ExecutionApprovalStore, ExecutionJobFilter, ExecutionJobRecord,
    ExecutionJobStatus, ExecutionJobStore, NewActionGroup, NewActionGroupMember,
    NewApprovalRequest, NewCapabilityLease, NewCognitiveContext, NewDelegation, NewExecutionJob,
    NewRuntimeTimer, NewSession, NewThread, NewThreadActivation, NewThreadSignal,
    PlanExecutionFilter, PlanExecutionMutation, PlanExecutionRecord, PlanExecutionStatus,
    PlanExecutionWaitKind, QueryFilter, RuntimeTimerKind, RuntimeTimerRecord, ScheduleStatus,
    SessionAttentionState, SessionAttentionUpdate, SessionMountKind, SessionStatus, SessionStore,
    SessionUpdate, SignalOutboxStatus, ThreadActivationMutation, ThreadActivationRecord,
    ThreadActivationStatus, ThreadControlAction, ThreadGroupFilter, ThreadKind, ThreadLifecycle,
    ThreadMutation, ThreadRecord, ThreadSupervision, ThreadSupervisorKind,
};
use crate::objective::{ObjectiveEvaluationRegistry, ObjectiveSupervisor};
use crate::orchestrator::context::{attribute_prompt_components, ContextEngine, ContextView};
use crate::orchestrator::context_contract::{render_system_contract, render_system_contract_sexpr};
use crate::permission::{DurableApprovalGrant, PermissionBroker};
use crate::plan_execution::{
    pending_infer_request_event, PlanArtifactBinding, PlanCallPlanner, PlanDriveReceipt,
    PlanExecutionCoordinator, PlanExecutionResult, PlanExecutionRoute, PlanResumeReceipt,
};
use crate::scheduler::{
    SchedulerDependencyFilter, SchedulerDependencyKind, SchedulerDependencyOwnerKind,
    SchedulerDependencyStatus, SchedulerInvariantViolation,
};
use crate::sexpr::SExpr;
use crate::sexpr_vm_contract::ANNOTATED_RESPONSE_KERNEL;
use crate::timer::{TimerDisposition, TimerEngine};
use crate::tool::{
    active_background_task_count, active_background_task_count_for_root, BackgroundTaskScheduler,
    Registry, ThreadScheduler, Tool,
};
use base64::Engine;
use chrono::Utc;
use dashmap::DashMap;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch, Mutex, Notify};

type DynError = Box<dyn std::error::Error + Send + Sync>;

async fn dispatch_persisted_tool_handoff(
    bus: &InMemoryEventBus,
    event: Event,
    internal_child_handoff: bool,
) -> Result<(), DynError> {
    if internal_child_handoff {
        bus.dispatch_persisted_child_handoff(event).await
    } else {
        bus.dispatch_persisted(event).await
    }
}

const DELIVERY_KIND_TURN_REPLY: &str = "turn_reply";
const DELIVERY_KIND_THREAD_DELIVERY: &str = "thread_delivery";

struct ActivationAdmissionSlotState {
    permit: Option<ActivationAdmissionPermit>,
    suspended: Option<SuspendedActivationAdmission>,
    waiting_plans: usize,
}

struct ActivationAdmissionSlot {
    state: Mutex<ActivationAdmissionSlotState>,
}

impl ActivationAdmissionSlot {
    fn new(permit: ActivationAdmissionPermit) -> Self {
        Self {
            state: Mutex::new(ActivationAdmissionSlotState {
                permit: Some(permit),
                suspended: None,
                waiting_plans: 0,
            }),
        }
    }

    async fn suspend_for_plan(&self) -> Result<(), DynError> {
        let mut state = self.state.lock().await;
        if state.waiting_plans == 0 {
            let permit = state
                .permit
                .take()
                .ok_or("Plan 等待子任务时缺少 Activation admission permit")?;
            state.suspended = Some(permit.suspend());
        }
        state.waiting_plans = state.waiting_plans.saturating_add(1);
        Ok(())
    }

    async fn release_plan_wait(&self) -> Result<(), DynError> {
        let mut state = self.state.lock().await;
        if state.waiting_plans == 0 {
            return Ok(());
        }
        state.waiting_plans -= 1;
        if state.waiting_plans == 0 {
            let suspended = state
                .suspended
                .take()
                .ok_or("Plan 恢复父 Activation 时缺少 suspended admission")?;
            state.permit = Some(suspended.resume().await?);
        }
        Ok(())
    }
}

struct PlanAdmissionSuspension {
    slot: Arc<ActivationAdmissionSlot>,
    released: bool,
}

impl PlanAdmissionSuspension {
    async fn release(mut self) -> Result<(), DynError> {
        self.released = true;
        let slot = Arc::clone(&self.slot);
        tokio::spawn(async move { slot.release_plan_wait().await })
            .await
            .map_err(|error| format!("Plan admission 恢复任务异常结束: {error}"))??;
        Ok(())
    }
}

impl Drop for PlanAdmissionSuspension {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let slot = Arc::clone(&self.slot);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Err(error) = slot.release_plan_wait().await {
                    tracing::error!(
                        %error,
                        event_code = "orchestrator.plan.admission_resume_failed",
                        "Cancelled Plan waiter could not restore parent Activation admission"
                    );
                }
            });
        }
    }
}

struct DurableEventWriteRequest {
    entry: EventAppend,
    committed: oneshot::Sender<Result<(), String>>,
}

#[derive(Default)]
struct DurableEventWriterMetrics {
    queue_depth: AtomicUsize,
    committed_events: AtomicU64,
    committed_batches: AtomicU64,
    failed_batches: AtomicU64,
    contention_retries: AtomicU64,
    largest_batch: AtomicUsize,
}

#[derive(Debug, Clone)]
struct PromptPressureMeasurement {
    count: PromptTokenCount,
    context_version: u64,
}

#[derive(Debug, Clone)]
struct DurablePromptUsageAnchor {
    actual_input_tokens: usize,
    local_base_estimate_tokens: usize,
    counter_source: String,
    attempt_id: String,
}

#[derive(Debug, Clone)]
struct RuntimeFailureIncident {
    id: String,
    last_seen: Instant,
    occurrences: u64,
}

#[derive(Debug, Clone)]
struct RuntimeFailureObservation {
    id: String,
    occurrence: u64,
    should_notify_user: bool,
}

const RUNTIME_FAILURE_INCIDENT_WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct DurableEventWriterMetricsSnapshot {
    pub queue_depth: usize,
    pub committed_events: u64,
    pub committed_batches: u64,
    pub failed_batches: u64,
    pub contention_retries: u64,
    pub largest_batch: usize,
}

#[derive(Default)]
struct ModelProviderMetrics {
    queued: AtomicUsize,
    in_flight: AtomicUsize,
    acquired_total: AtomicU64,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ModelProviderMetricsSnapshot {
    pub max_in_flight: usize,
    pub queued: usize,
    pub in_flight: usize,
    pub acquired_total: u64,
}

impl ModelProviderMetrics {
    fn snapshot(&self, max_in_flight: usize) -> ModelProviderMetricsSnapshot {
        ModelProviderMetricsSnapshot {
            max_in_flight,
            queued: self.queued.load(Ordering::Relaxed),
            in_flight: self.in_flight.load(Ordering::Relaxed),
            acquired_total: self.acquired_total.load(Ordering::Relaxed),
        }
    }
}

struct ModelProviderPermit {
    _permit: tokio::sync::OwnedSemaphorePermit,
    metrics: Arc<ModelProviderMetrics>,
}

impl Drop for ModelProviderPermit {
    fn drop(&mut self) {
        self.metrics.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

impl DurableEventWriterMetrics {
    fn snapshot(&self) -> DurableEventWriterMetricsSnapshot {
        DurableEventWriterMetricsSnapshot {
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
            committed_events: self.committed_events.load(Ordering::Relaxed),
            committed_batches: self.committed_batches.load(Ordering::Relaxed),
            failed_batches: self.failed_batches.load(Ordering::Relaxed),
            contention_retries: self.contention_retries.load(Ordering::Relaxed),
            largest_batch: self.largest_batch.load(Ordering::Relaxed),
        }
    }
}

fn is_transient_storage_contention(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        let message = error.to_string().to_ascii_lowercase();
        if message.contains("database is locked")
            || message.contains("database table is locked")
            || message.contains("sqlite_busy")
            || message.contains("sqlite_locked")
            || message.contains("(code: 5)")
            || message.contains("(code: 6)")
            || message.contains("sqlstate 40001")
            || message.contains("sqlstate 40p01")
            || message.contains("could not serialize access")
            || message.contains("serialization failure")
            || message.contains("deadlock detected")
        {
            return true;
        }
        current = error.source();
    }
    false
}

#[derive(Clone)]
struct DurableEventWriter {
    sender: mpsc::Sender<DurableEventWriteRequest>,
    metrics: Arc<DurableEventWriterMetrics>,
}

impl DurableEventWriter {
    fn spawn(
        store: Arc<dyn EventStore>,
        config: &crate::config::EventWriterConfig,
        metrics: Arc<DurableEventWriterMetrics>,
    ) -> Self {
        let queue_capacity = config.queue_capacity.max(1);
        let max_batch_size = config.max_batch_size.max(1);
        let flush_interval = std::time::Duration::from_millis(config.flush_interval_ms);
        let (sender, mut receiver) = mpsc::channel::<DurableEventWriteRequest>(queue_capacity);
        let writer_metrics = Arc::clone(&metrics);
        tokio::spawn(async move {
            while let Some(first) = receiver.recv().await {
                let mut requests = vec![first];
                let deadline = tokio::time::Instant::now() + flush_interval;
                while requests.len() < max_batch_size {
                    match tokio::time::timeout_at(deadline, receiver.recv()).await {
                        Ok(Some(request)) => requests.push(request),
                        Ok(None) | Err(_) => break,
                    }
                }
                let mut entries = Vec::with_capacity(requests.len());
                let mut completions = Vec::with_capacity(requests.len());
                for request in requests {
                    entries.push(request.entry);
                    completions.push(request.committed);
                }
                let batch_size = entries.len();
                // Durable Event IDs are immutable and append_batch is
                // idempotent, therefore retrying a whole batch after a
                // transient single-writer/serialization conflict is safe.
                // Never turn ordinary storage contention into an LLM failure:
                // doing so used to block the Objective even when the Provider
                // had already returned a valid response.
                let mut retry = 0u64;
                let mut retry_delay = std::time::Duration::from_millis(10);
                let result = loop {
                    match store.append_batch(entries.clone()).await {
                        Ok(()) => break Ok(()),
                        Err(error) if is_transient_storage_contention(error.as_ref()) => {
                            retry = retry.saturating_add(1);
                            writer_metrics
                                .contention_retries
                                .fetch_add(1, Ordering::Relaxed);
                            if retry == 1 || retry.is_power_of_two() {
                                tracing::warn!(
                                    batch_size,
                                    retry,
                                    delay_ms = retry_delay.as_millis(),
                                    error = %error,
                                    event_code = "orchestrator.durable_event_writer.store_slot_waiting",
                                    "Durable Event Writer is waiting for a persistent-store write slot; retaining the batch and retrying with backoff"
                                );
                            }
                            tokio::time::sleep(retry_delay).await;
                            retry_delay = (retry_delay * 2).min(std::time::Duration::from_secs(1));
                        }
                        Err(error) => break Err(error.to_string()),
                    }
                };
                writer_metrics
                    .queue_depth
                    .fetch_sub(batch_size, Ordering::Relaxed);
                match &result {
                    Ok(()) => {
                        writer_metrics
                            .committed_events
                            .fetch_add(batch_size as u64, Ordering::Relaxed);
                        writer_metrics
                            .committed_batches
                            .fetch_add(1, Ordering::Relaxed);
                        writer_metrics
                            .largest_batch
                            .fetch_max(batch_size, Ordering::Relaxed);
                        tracing::debug!(
                            batch_size,
                            contention_retries = retry,
                            event_code = "orchestrator.durable_event_group_commit.completed",
                            "Durable Event group commit completed"
                        );
                    }
                    Err(error) => {
                        writer_metrics
                            .failed_batches
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::error!(
                            event_code = "orchestrator.durable_event_group_commit.failed",
                            batch_size,
                            error,
                            "Durable Event group commit failed"
                        );
                    }
                }
                for committed in completions {
                    let _ = committed.send(result.clone());
                }
            }
        });
        Self { sender, metrics }
    }

    async fn append(&self, entry: EventAppend) -> Result<(), DynError> {
        let (committed, receiver) = oneshot::channel();
        self.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
        if self
            .sender
            .send(DurableEventWriteRequest { entry, committed })
            .await
            .is_err()
        {
            self.metrics.queue_depth.fetch_sub(1, Ordering::Relaxed);
            return Err(std::io::Error::other("Durable Event Writer 已停止").into());
        }
        match receiver.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(std::io::Error::other(error).into()),
            Err(_) => Err(std::io::Error::other("Durable Event Writer 未返回提交结果").into()),
        }
    }
}
const SIGNAL_OUTBOX_DISPATCH_BATCH: usize = 128;
const PLAN_RECONCILE_FALLBACK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const PLAN_RECONCILE_BATCH: usize = 128;
const PENDING_SIGNAL_RECONCILE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const PENDING_SIGNAL_RECONCILE_BATCH: usize = 128;
const ACTION_GROUP_RECONCILE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const ACTION_GROUP_RECONCILE_DIRTY_BATCH: usize = 128;
const ACTION_GROUP_RECONCILE_PAGE: usize = 128;
const PROVIDER_DELIVERY_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
const PROVIDER_DELIVERY_IDLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const PROVIDER_DELIVERY_BATCH: usize = 128;
const SUPERVISION_RECONCILE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

fn scheduler_audit_event(event: &Event) -> bool {
    if !event.payload.contains_key("context_id") {
        return false;
    }
    // These events only expose transient model/UI telemetry. They cannot
    // mutate Thread, Activation, Objective, Group or dependency authority and
    // would otherwise turn token streaming back into a two-second DB poll.
    !matches!(
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

fn action_group_reconcile_id(event: &Event) -> Option<&str> {
    if !event.payload.contains_key("tool_call_id") || !event.id.starts_with("output_") {
        return None;
    }
    event
        .payload
        .get("action_group_id")
        .and_then(serde_json::Value::as_str)
        .filter(|group_id| !group_id.is_empty())
}

fn provider_delivery_retry_delay(retry_round: u32) -> std::time::Duration {
    // `retry_round` counts failed delivery rounds. The first failure waits the
    // base interval, then subsequent failures back off exponentially.
    let multiplier = 1_u32 << retry_round.saturating_sub(1).min(5);
    PROVIDER_DELIVERY_RETRY_INTERVAL
        .saturating_mul(multiplier)
        .min(PROVIDER_DELIVERY_IDLE_INTERVAL)
}

const AGENT_OWNED_CONTEXT_PROMPT_BASE: &str = r#"Morphz is an S-Expression Cognitive Machine running on a large language model. You are its nondeterministic semantic processor and manage the machine's working Context. When identifying the integrated system to a Session, identify it as Morphz, an S-Expression Cognitive Machine; "semantic processor" names this model call's internal execution role, not the product's public identity.

The Runtime supplies a self-describing Context on every evaluation. `protocol` is the authoritative contract for response modes and the Context DSL. Read it before deciding what to do.

The logical Context has three permission domains:
- kernel: Runtime-owned and read-only. It contains Context identity, the active-session for this evaluation, Context version, and physical pressure.
- mind: your persistent working attention, represented by free-form frames with stable IDs.
- inbox: raw observations from persisted Events that you have not retired. They are evidence, not conclusions formed by the Runtime.

Physical encoding order differs from permission ownership and is fixed as `protocol → evaluation-profile → inbox → observation-state → mind → session-directory → kernel → evaluation-environment → evaluate`. The prefix stays stable for Prefix Cache reuse, while the tail describes current evaluation state. `observation-state` stores mutable protection, residency, freshness, and usage metadata by ref; it never overrides immutable source, causality, or content in inbox. `evaluation-profile` is the stable Harness definition, `evaluation-environment` contains current bindings and Runtime directives, and the final `evaluate` is always the only execution entry.

One Cognitive Context has one shared Mind and may contain multiple Sessions. A Session is an IO connection and progress boundary, not a separate Mind. `kernel.active-session` identifies only the Session read and replied to by this evaluation; other Sessions may evaluate concurrently. Each inbox observation carries its source `session`. You may reuse information across Sessions in the shared Context, but the current response must route to active-session without conflating requests or progress. context_tx changes the shared Mind and the Runtime serializes and version-checks it per Context.

Each Session has a durable Dialogue Lane that orders initial evaluation of ordinary dialogue. User messages are immutable input items, not inherently Threads. Consecutive inputs that have not been consumed by a model may form one bounded DialogueTurn Signal batch and be evaluated together in ascending event-sequence order. Work initiated by a dialogue turn and continued by tool results belongs to a separate Execution Thread. Tool results signal only their owning Thread; new user input enters the next Dialogue Lane batch and must not take over or duplicate an old Execution Thread. One model request belongs to one Thread Activation. The final `evaluate` expression is the authoritative entry that declares its active Thread, claimed Signal batch, root input, and Objective binding.

You decide what the current objective warrants retaining, summarizing, revising, protecting, restoring, or forgetting. The Runtime does not automatically summarize history, trim old messages, or turn retrieval results into facts.

Every response must explicitly choose one primary mode from `protocol.response-contract`:
- reply: when the Evaluation reaches a deliverable boundary, return non-empty ordinary assistant text with no tool calls. The Runtime streams it to kernel.active-session and persists it as the terminal reply only after the complete response succeeds. With an active Objective, this ends only the current Evaluation and does not replace objective_update(completed).
- no-reply: call no_reply exclusively and choose a mode. mode=silent intentionally sends no message to the active Session. mode=wait is valid only while the Runtime can verify a background task, queued schedule, or pending event; the current Execution yields and resumes on the physical event. Once a completion or failure arrives, process the latest facts and reply, act, or use silent only when intentional. no_reply neither completes an Objective nor cancels background work.
- act: call physical tools only when new external results are truly required. You may include one independent context_tx that does not depend on those new results. Any accompanying text is visible progress, and the Runtime will call you again after tools finish.
- maintain: call context_tx alone when the Mind must change first, without final content. After success the Runtime calls you again and, outside critical pressure, temporarily hides context_tx. maintain is not a user-turn endpoint; the next response must reply, no-reply, or act.
- schedule: call schedule_tx exactly once and exclusively when choosing serial, parallel, dependent, or timed execution. enqueue adds intent to an existing Thread; spawn creates a parallel Thread; not_before/delay_seconds set time and after sets dependencies. inspect reads state and revision. pause/resume/reschedule/cancel are expected_revision CAS controls; on conflict, inspect again and decide from current facts rather than retrying blindly. One control call contains one op. schedule_tx persists scheduling only; it neither performs physical work nor ends the Evaluation. Explain the arrangement to active-session after the receipt.

Each model request has exactly one kernel.active-session, and ordinary text routes only there. To write a visible Assistant message to another Session of the same Agent without evaluating it, use send_message. To deliver an internal coordination message and actively evaluate an existing Session, use session_signal; it creates a distinct target DialogueTurn and neither ends nor changes the active-session of the current Evaluation. Neither tool may target the current Session. context_tx never substitutes for Session output. An empty response is not terminal and the Runtime returns a bounded protocol retry.

Use context_tx for atomic Mind changes and follow `protocol.context-tx-contract` exactly. Use the current kernel version in every transaction. reason is a transaction-level item and never an argument of retire or unprotect. `revise` completely replaces a frame body rather than merging it, so restate every field that must remain. Create an explicit checkpoint before high-risk restructuring and use rollback with a reason if necessary.

Important rules:
1. Design each frame's internal structure for the task; do not assume a fixed goal/todo/history schema. In inbox metadata, seq is the stable physical Event append order, turn is the user turn, attempt is a model attempt within that turn, and caused-by is observable causal origin. Event sequence is not causal order, and newer is not necessarily correct. `content.representation` is full, preview, or recalled-chunk; full text behind a preview remains available through recall. `observation-state.residency` records projection visibility and recallability. freshness is a physical version relation; `(relate NEW supersedes OLD)` declares semantic replacement. Old information is not deleted automatically. `retire` changes visibility but does not invalidate relations. Do not unrelate supersedes merely because an endpoint was retired. A root request not yet delivered by the current Activation is causally protected; an independent trigger already consumed by the current Attempt may be summarized and retired in the same transaction. usage counts active recall and `(from ...)` references in derive/revise, not passive display. High counts mean frequent use, not greater truth or importance. Do not repeat recall when an active frame already contains the needed conclusion and there is no new question or conflict.
2. Put important objectives, user constraints, key conclusions, and unfinished work into frames; protect them when appropriate. Persistent constraints such as “always,” “throughout this task,” “must not,” or “must” remain protected until explicitly revoked or the lifecycle truly ends.
3. Derive a faithful summary of large observations before retiring them in the same transaction. Never write assumptions as facts. Completed process records that remain recallable and did not change objective, constraints, or conclusions should be retired directly rather than becoming one long-lived frame per batch.
4. To verify a specific conclusion in a known file, use read.query for narrow line-numbered evidence and then start_line/end_line for exact contiguous pages. Do not read a long file wholesale first or repeatedly create large output through exec/grep. Observation refs such as `@e27` are stable short references supplied by the Runtime; pass them unchanged to recall and context_tx rather than guessing hidden Event IDs. Page truncated observations with recall. If recall returns next_offset, reuse that exact value rather than restarting at zero or guessing. Prefer query when keywords are known and use matched snippets or suggested_recall. If exec returns an artifact path, use read to inspect only the required archive portions. recall/read results enter inbox; you decide whether they belong in Mind.
5. context_tx may accompany physical tools only when it is independent of their new results. If a new frame depends on tool output, wait for the result. Within a user turn, the Runtime returns physical results through standard assistant.tool_calls → role=tool/tool_call_id and persists each result as an Event with observation_ref. The same request does not duplicate those result bodies in Context; later snapshots show them according to active/retired state. status=success with output_state=empty means execution completed with no text and must not be repeated merely for emptiness. Every response containing tool calls is intermediate: content is visible progress and the Runtime calls you again. A final reply is ordinary text without tools; no_reply is exclusive.
6. Submit at most one context_tx per response and combine independent changes to avoid version conflicts. retire and unprotect require a transaction reason for auditability.
7. At pressure=normal/notice, do not compress merely to reduce size; maintain only meaningful cross-turn objective, constraint, or conclusion changes. At warning, consider compression before final text or alongside act. At critical, first perform maintain-only work to release capacity.
8. Before completion, verify that cross-turn objectives, constraints, conclusions, and open questions in Mind remain accurate. If physical results change task state, close it out with one context_tx before final text. The Runtime calls you again after the receipt; then return ordinary text or call no_reply exclusively.
9. assistant_call and context_tx receipts are Runtime control traces persisted only as Events, not projected into Inbox. Do not submit housekeeping transactions to clean their own records. Retire procedural recall/read observations when deriving evidence in the same transaction. Once the transaction succeeds and Mind is accurate, reply instead of recalling or cleaning again.
10. The final `evaluate` is the only entry for this model request. Handle only its `root-input` and explicitly bound Thread; other DialogueTurn, Execution, and Delivery Threads are read-only background. Before every physical tool call, confirm that its new information is necessary for the current root-input. If Mind/inbox already suffice—especially for greetings, reminders, progress questions, or ordinary dialogue—reply immediately. Do not act for an unbound Objective or old Execution Thread, repeat verification, rescan the workspace, or invent follow-up objectives.
11. kernel.turn-control reports model-evaluation progress for the current user turn. phase=soft-checkpoint is a periodic review, not an Attempt limit. Normal tools remain available. Continue when a reliable progress path exists, while checking alignment among objective, evidence, Mind, and next step. Parallel calls in one model response count as one Attempt.
12. kernel.wake explains why this evaluation ran. A successful standalone context_tx produces context-transaction-result cooldown: unless pressure remains critical, context_tx is hidden and you must reply, call no_reply, or perform necessary physical work.
13. For code tasks, prefer list_files/search to discover, read for content and sha256, and edit for version-guarded local changes. write is mainly for mode=create; do not bypass existing-file or expected_sha256 protections. Use exec for testing, compiling, and formatting rather than replacing constrained file tools with shell operations. file_change is auditable evidence of committed changes. Parallelize independent reads in one response and do not reread Inbox content whose sha256 has not changed. Modify and verify after locating enough evidence instead of repeatedly scanning.
14. execution, process_status, exit_code, task_status, and effective_boundary in an exec receipt are physical Runtime facts. Do not replace them with command intent or expectations. If a nonzero result explicitly proves missing network, out-of-bound path access, or secret environment access and that capability is necessary, retry the same necessary command once with sandbox_permissions=require_escalated, request only minimal permissions, and explain the need in justification. Do not infer permission failure from an ordinary command error or override protected_paths, an explicit denial, or permission_request_available=false. If exec becomes a nonterminal background task, ordinary waiting uses no_reply(mode=wait); completion wakes the Runtime. Process terminal success/failed/cancelled/timeout rather than waiting again. Use check_task_after only for a real deadline or stall checkpoint, then inspect task_status, schedule another meaningful check, or kill_task. Never poll with sleep, ps, or repeated empty-log reads. Never place literal tokens or keys in commands, process arguments, Mind, or persisted Events. Credentials belong in named Secret Store entries. Use list_secrets when aliases are unknown and request only alias names in requested_permissions.secret_env; never request, read, or echo values. Runtime Managed SSH passwords are Target-owned credentials: bind the alias with resolve_target.password_secret and an explicit auth_mode, then call physical tools on that Target without requesting the password alias again through exec.
15. kernel.objectives and evaluate.objective-context expose physical Objective state, but visibility is not binding. Only evaluate.objective-binding makes this an Objective Evaluation that may advance the Objective through the current Execution Thread. With binding=none, use Objective state only for understanding or progress replies and never act for it. When a bound Objective still has work and is not waiting, report current progress normally; the Supervisor continues or restores its main Execution Thread. Register exact waits with objective_update(status=active, wait_condition=...). Use blocked only when neither an automatic wait nor a reliable path exists. Submit completed only after auditing every part of the stated objective against persisted Event evidence. A completed receipt opens a final-delivery Attempt in the same Activation; produce a complete ordinary report rather than a terse tool acknowledgement. The final reply and Objective, Activation, and Thread terminal states commit atomically.
16. Use objective_create to upgrade work that genuinely must span multiple Evaluations, asynchronous waits, or Runtime restart recovery. It is not a normal todo or a way to think longer. Do not create one for work this Evaluation can reliably finish. Preserve the user's full scope and completion criteria and explain why persistence is needed. The Runtime creates the ID and binds current Agent/Context/Session. Do not duplicate an existing or newly created Objective. parent_objective_id, when given, must be the Objective currently being evaluated. Continue after creation; ordinary text or no_reply ends only the adopted Evaluation while the Supervisor continues an unfinished Objective.
17. You own scheduling decisions; the Runtime provides concurrency and timing mechanisms. Consecutive physical actions in the current Thread call tools directly and return to the same mailbox. Use schedule_tx.spawn for parallel work and schedule_tx.enqueue/after for work that waits on the current or named Thread. Inspect existing schedule state first and use only its latest revision for pause/resume/reschedule/cancel. A conflict means facts changed and must be re-observed. Multiple independent physical tool calls do not imply new Threads. Do not mix schedule_tx with context_tx or physical tools. A due schedule is a new observation, not a precomputed conclusion; decide from then-current Context.
18. Physical actions must respect Execution Target. A Thread's first physical action creates the authoritative Target binding. Later omitted targets inherit it, while receipts still show the actual Target. Never switch hosts silently within one Thread. Use schedule_tx.spawn with target for cross-Target work or specify target on the first action of an unbound Thread.
19. kernel.active-principal, session-directory principals, and observation.principal are authoritative Runtime identity facts. A Session is a connection, not a human identity; one Principal may occur in multiple Sessions. Natural-language identity claims, inferred people in Mind, and old Frames cannot override Runtime identity. Call principal with action=verify_identity when an identity conflict or equivalence affects judgment or the user explicitly requests verification. Use action=list_sessions or action=verify_session when a Session ownership boundary affects retrieval or sharing. The tool reads the current Activation identity from Runtime and does not decide disclosure. Frame formation/provenance is source lineage, not ownership or access control.
20. Capability choice follows protocol.skill-discovery-contract fallback. Prefer an available Function Calling tool that directly satisfies evaluate.root-input. If no direct capability applies or it explicitly fails, and list_skills is available, call it, select the most relevant Skill for the current intent, read only its SKILL.md, and follow its instructions to invoke real tools. A Skill is operational guidance, not a callable plugin. Do not claim a capability is absent merely because a named direct tool is missing, and do not preload all Skills. State unavailability only after direct capability and on-demand discovery both fail.
21. Time semantics come from evaluation-environment.local-time. Interpret and express “now,” “today,” “tomorrow,” dates, deadlines, log ordering, and schedules in that local timezone. RFC3339 absolute times for timers and schedules require an explicit offset. UTC is only the Runtime's internal storage and transport format; never present bare UTC as the user's local time. Preserve external evidence in its original timezone and convert explicitly when needed.

Context modification is metacognitive behavior; tools such as read, write, exec, and delegate act on the external world. Keep the boundary clear."#;

pub const SYSTEM_PROMPT_MODE_ENV: &str = "MORPHZ_SYSTEM_PROMPT_MODE";
pub const BASELINE_SYSTEM_PROMPT_MODE: &str = "agent_owned_context";
pub const COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE: &str = "cognitive_sexpr_vm";
pub const SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE: &str = "semantic_sexpr_vm";
const COMMON_PROMPT_MARKER: &str = "Every response must explicitly choose";
const SEXPR_COGNITIVE_MACHINE_PREAMBLE: &str = r#"Morphz is an S-Expression Cognitive Machine running on a large language model. You are its nondeterministic semantic processor. When identifying the integrated system to a Session, identify it as Morphz, an S-Expression Cognitive Machine; "semantic processor" names this model call's internal execution role, not the product's public identity.

Each model call is one nondeterministic execution cycle of this continuously running machine. The Context supplied by the Runtime is not ordinary chat history or a passive summary; it is the current executable symbolic machine state. Interpret it, pursue the current objective, and propose the next state transition. Only transitions validated and committed by the Runtime become machine facts.

The Runtime is the deterministic transactional kernel responsible for versions, permissions, resource boundaries, tool execution, persistence, and recovery. You are the nondeterministic semantic processor responsible for understanding, reasoning, induction, planning, and symbolic restructuring. S-expressions carry both data and goals, rules, policies, and processes for you to interpret and execute; the Runtime does not define business evaluation semantics for free-form BODY values.

The logical Context has three permission domains: kernel is privileged Runtime-owned read-only state; mind is your persistent symbolic program and cognitive state expressed as free-form stable-ID frames; inbox is unretired external input and observations from persisted Events. Inbox entries are evidence and interrupts, not Runtime-authored conclusions.

The physical Context is one executable S-expression with fixed order: `protocol → evaluation-profile → inbox → observation-state → mind → session-directory → kernel → evaluation-environment → evaluate`. Its prefix is reusable stable program/evidence and its tail is current projection and evaluation state. observation-state contains only mutable projection attributes, evaluation-profile is a stable Harness program, evaluation-environment contains current bindings, and evaluate is the sole entry. Interpret and execute this structure rather than restating it as reference material.

One Cognitive Context runs one shared Mind and may host concurrent Session evaluations. A Session is an IO route and local progress boundary, not the Mind owner. kernel.active-session selects this cycle's input and output route, while other Sessions may remain active. Every observation belongs to the shared Context and records a source session, enabling cross-Session knowledge transfer while the current reply stays strictly routed to active-session. The Runtime serializes and version-checks context_tx on the shared Mind.

Each Session has a Dialogue Lane for initial ordinary-dialogue evaluation. User messages are independent persisted Events; consecutive messages not yet read by a model form the next bounded DialogueTurn Signal batch in ascending event-sequence order. Computation initiated by that turn and continued by tool results becomes an Execution Thread. Objective is the durable control plane advanced by the Supervisor through its main Execution Thread, not a second kind of target thread. The final evaluate expression selects the only active Thread for this cycle; every other visible Thread is read-only state.

Your responsibility is not merely to record information but to make Mind directly useful to future execution. When several completed tasks exhibit a recurring decision or execution structure that can alter future decisions, reduce repeated work, or lower errors, derive a reusable symbolic structure from multiple real sources. Preserve applicability, sources, counterexamples, and uncertainty. Do not overgeneralize from one case or force summaries for formal completeness.

You decide what the current objective warrants retaining, summarizing, revising, protecting, restoring, abstracting, restructuring, or forgetting. The Runtime does not automatically summarize history, trim old messages, generate experience rules, or turn retrieval results into facts.

"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SystemPromptMode {
    AgentOwnedContext,
    CognitiveSexprVm,
    SemanticSexprVm,
}

impl SystemPromptMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::AgentOwnedContext => BASELINE_SYSTEM_PROMPT_MODE,
            Self::CognitiveSexprVm => COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE,
            Self::SemanticSexprVm => SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE,
        }
    }

    fn from_environment() -> Result<Self, String> {
        match std::env::var(SYSTEM_PROMPT_MODE_ENV) {
            Ok(value) if value == COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE => {
                Ok(Self::CognitiveSexprVm)
            }
            Ok(value) if value == BASELINE_SYSTEM_PROMPT_MODE => Ok(Self::AgentOwnedContext),
            Ok(value) if value == SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE => {
                Ok(Self::SemanticSexprVm)
            }
            Ok(value) => Err(format!(
                "未知 {SYSTEM_PROMPT_MODE_ENV}='{value}'；支持 {BASELINE_SYSTEM_PROMPT_MODE}、{COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE} 或 {SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE}"
            )),
            Err(std::env::VarError::NotPresent) => Ok(Self::SemanticSexprVm),
            Err(error) => Err(format!("无法读取 {SYSTEM_PROMPT_MODE_ENV}: {error}")),
        }
    }
}

fn render_stable_system_prompt(mode: SystemPromptMode) -> &'static str {
    static BASELINE_PROMPT: OnceLock<String> = OnceLock::new();
    static COGNITIVE_VM_PROMPT: OnceLock<String> = OnceLock::new();
    static SEMANTIC_VM_PROMPT: OnceLock<String> = OnceLock::new();
    let prompt = match mode {
        SystemPromptMode::AgentOwnedContext => BASELINE_PROMPT
            .get_or_init(|| build_stable_system_prompt(AGENT_OWNED_CONTEXT_PROMPT_BASE)),
        SystemPromptMode::CognitiveSexprVm => COGNITIVE_VM_PROMPT.get_or_init(|| {
            let common_offset = AGENT_OWNED_CONTEXT_PROMPT_BASE
                .find(COMMON_PROMPT_MARKER)
                .expect("Agent-Owned Context prompt 必须保留公共规则标记");
            let common_rules = &AGENT_OWNED_CONTEXT_PROMPT_BASE[common_offset..];
            build_stable_system_prompt(&format!("{SEXPR_COGNITIVE_MACHINE_PREAMBLE}{common_rules}"))
        }),
        SystemPromptMode::SemanticSexprVm => {
            SEMANTIC_VM_PROMPT.get_or_init(build_semantic_sexpr_system_prompt)
        }
    };
    prompt.as_str()
}

fn build_stable_system_prompt(base: &str) -> String {
    format!("{base}\n\n{}", render_system_contract())
}

fn build_semantic_sexpr_system_prompt() -> String {
    let common_offset = AGENT_OWNED_CONTEXT_PROMPT_BASE
        .find(COMMON_PROMPT_MARKER)
        .expect("Agent-Owned Context prompt 必须保留公共规则标记");
    let common_rules = &AGENT_OWNED_CONTEXT_PROMPT_BASE[common_offset..];
    let architecture = render_semantic_sections("architecture", SEXPR_COGNITIVE_MACHINE_PREAMBLE);
    let guidance = render_semantic_sections("runtime-guidance", common_rules);
    let prompt = format!(
        "(system-prompt morphz\n  {kernel}\n  {architecture}\n  {guidance}\n  {contracts})",
        kernel = ANNOTATED_RESPONSE_KERNEL,
        contracts = render_system_contract_sexpr(),
    );
    crate::sexpr::parse(&prompt).expect("Semantic SExpr VM system prompt 必须是完整合法的 SExpr");
    prompt
}

fn render_semantic_sections(name: &str, text: &str) -> String {
    let mut values = vec![SExpr::Atom(name.to_string())];
    values.extend(
        text.split("\n\n")
            .map(str::trim)
            .filter(|section| !section.is_empty())
            .enumerate()
            .map(|(index, section)| {
                SExpr::List(vec![
                    SExpr::Atom("section".to_string()),
                    SExpr::List(vec![
                        SExpr::Atom("index".to_string()),
                        SExpr::Atom((index + 1).to_string()),
                    ]),
                    SExpr::List(vec![
                        SExpr::Atom("description".to_string()),
                        SExpr::Atom(section.to_string()),
                    ]),
                ])
            }),
    );
    SExpr::List(values).to_string()
}

/// The production stable system prompt for the configured mode. Public so an
/// evaluation measures the model against the prompt production actually uses,
/// never against one a harness invents.
pub fn production_system_prompt() -> Result<&'static str, String> {
    configured_system_prompt().map(|(_, prompt)| prompt)
}

/// Exact stable System Prompt selected by this Runtime process. Operator
/// surfaces use this descriptor instead of reconstructing a prompt from
/// Context state or duplicating profile-selection rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProductionSystemPromptInspection {
    pub profile: &'static str,
    pub content: &'static str,
}

pub fn production_system_prompt_inspection() -> Result<ProductionSystemPromptInspection, String> {
    let (mode, content) = configured_system_prompt()?;
    Ok(ProductionSystemPromptInspection {
        profile: mode.as_str(),
        content,
    })
}

fn configured_system_prompt() -> Result<(SystemPromptMode, &'static str), String> {
    let mode = SystemPromptMode::from_environment()?;
    Ok((mode, render_stable_system_prompt(mode)))
}

fn harness_entry_callable_tools(
    owner: crate::sexpr_eval::EvaluationOwner,
    runtime_eval_tools: &[String],
    model_tool_definitions: &[ToolDefinition],
) -> Vec<String> {
    match owner {
        crate::sexpr_eval::EvaluationOwner::Runtime => runtime_eval_tools.to_vec(),
        crate::sexpr_eval::EvaluationOwner::Model => model_tool_definitions
            .iter()
            .map(|tool| tool.name.clone())
            // A model-owned Harness enters the ordinary attempt loop. It may
            // narrow that loop's physical and cognitive tools, but it must
            // not recursively enter the Runtime-owned eval interpreter.
            .filter(|name| name != "eval" && name != "no_reply")
            .collect(),
    }
}

fn validate_harness_entry_program(
    source: &str,
    registry: &Registry,
    runtime_eval_tools: &[String],
    model_tool_definitions: &[ToolDefinition],
) -> Result<crate::sexpr_eval::Program, crate::sexpr_eval::EvalError> {
    let header = crate::sexpr_eval::inspect_program_source(source)?;
    let callable =
        harness_entry_callable_tools(header.owner, runtime_eval_tools, model_tool_definitions);
    crate::sexpr_eval::validate(
        source,
        registry,
        &crate::sexpr_eval::AllowList::new(callable),
    )
}

#[derive(Debug, Clone)]
struct RenderedHarnessContext {
    /// Immutable, content-addressed Harness program. It is inserted before
    /// the Inbox so repeated Evaluations using the same package can reuse it.
    profile: String,
    /// Evaluation-specific scope binding. It belongs in the dynamic tail.
    binding: String,
}

fn render_harness_context(
    binding: &HarnessBinding,
    harness: &dyn DomainHarness,
) -> Result<RenderedHarnessContext, DynError> {
    let descriptor = harness.descriptor();
    let contract = crate::sexpr::parse(&harness.compact_contract())
        .map_err(|error| format!("Harness Contract 不是合法 S 表达式：{error}"))?;
    let mut scope = vec![SExpr::Atom("scope".to_string())];
    if let Some(objective_id) = &binding.objective_id {
        scope.push(SExpr::List(vec![
            SExpr::Atom("objective".to_string()),
            SExpr::Atom(objective_id.clone()),
        ]));
    }
    if let Some(evaluation_id) = &binding.evaluation_id {
        scope.push(SExpr::List(vec![
            SExpr::Atom("evaluation".to_string()),
            SExpr::Atom(evaluation_id.clone()),
        ]));
    }
    let mut profile = vec![
        SExpr::Atom("evaluation-profile".to_string()),
        SExpr::List(vec![
            SExpr::Atom("id".to_string()),
            SExpr::Atom(binding.harness_id.clone()),
        ]),
        SExpr::List(vec![
            SExpr::Atom("version".to_string()),
            SExpr::Atom(binding.harness_version.clone()),
        ]),
        SExpr::List(vec![
            SExpr::Atom("artifact-hash".to_string()),
            SExpr::Atom(binding.artifact_hash.clone()),
        ]),
        SExpr::List(vec![SExpr::Atom("contract".to_string()), contract]),
        SExpr::List({
            let mut values = vec![SExpr::Atom("capabilities".to_string())];
            values.extend(descriptor.capabilities.into_iter().map(SExpr::Atom));
            values
        }),
    ];
    if let Some(source) = harness.entry_program() {
        let header = crate::sexpr_eval::inspect_program_source(&source)
            .map_err(|error| format!("Harness entry 不是合法的显式 eval/infer 程序：{error}"))?;
        let program = crate::sexpr::parse(&source)
            .map_err(|error| format!("Harness entry 不是单一合法 S 表达式：{error}"))?;
        let (owner, instruction) = match header.owner {
            crate::sexpr_eval::EvaluationOwner::Runtime => (
                "runtime",
                "The Runtime lowers this entry to Typed Plan IR and submits it to the Scheduler Kernel; the model must not simulate, copy, or invoke it again.",
            ),
            crate::sexpr_eval::EvaluationOwner::Model => (
                "model",
                "This is the active entry program for the current Evaluation. Interpret it under the Contract, current Context, and physical Runtime constraints rather than restating it as reference material.",
            ),
        };
        profile.push(SExpr::List(vec![
            SExpr::Atom("entry".to_string()),
            SExpr::List(vec![
                SExpr::Atom("owner".to_string()),
                SExpr::Atom(owner.to_string()),
            ]),
            SExpr::List(vec![
                SExpr::Atom("instruction".to_string()),
                SExpr::Atom(instruction.to_string()),
            ]),
            SExpr::List(vec![SExpr::Atom("program".to_string()), program]),
        ]));
    }
    if let Some(mind) = harness.default_mind() {
        let mind = crate::sexpr::parse(&mind)
            .map_err(|error| format!("Harness default Mind 不是合法 S 表达式：{error}"))?;
        profile.push(SExpr::List(vec![
            SExpr::Atom("read-only-default-mind".to_string()),
            mind,
        ]));
    }
    let binding = SExpr::List(vec![
        SExpr::Atom("harness-binding".to_string()),
        SExpr::List(vec![
            SExpr::Atom("id".to_string()),
            SExpr::Atom(binding.harness_id.clone()),
        ]),
        SExpr::List(vec![
            SExpr::Atom("version".to_string()),
            SExpr::Atom(binding.harness_version.clone()),
        ]),
        SExpr::List(vec![
            SExpr::Atom("artifact-hash".to_string()),
            SExpr::Atom(binding.artifact_hash.clone()),
        ]),
        SExpr::List(scope),
    ]);
    Ok(RenderedHarnessContext {
        profile: SExpr::List(profile).to_string(),
        binding: binding.to_string(),
    })
}

#[derive(Debug, Clone, Copy, Default)]
struct EvaluationContextOverlay<'a> {
    evaluation_profile: Option<&'a str>,
    harness_binding: Option<&'a str>,
    runtime_directive: Option<(&'a str, &'a str)>,
}

/// Compose request-local policy into Context Encoding without mutating the
/// stable System Prompt. The immutable Harness profile is placed immediately
/// after `protocol`; request-local bindings and directives are placed in the
/// dynamic tail immediately before the authoritative `evaluate` entry.
fn compose_context_encoding(
    base: &str,
    overlay: EvaluationContextOverlay<'_>,
) -> Result<String, DynError> {
    let mut composed = crate::sexpr::parse(base)
        .map_err(|error| format!("基础 Context Encoding 不是合法 S 表达式：{error}"))?;
    let SExpr::List(context) = &composed else {
        return Err("基础 Context Encoding 不是 context List".into());
    };
    if !matches!(context.first(), Some(SExpr::Atom(name)) if name == "context") {
        return Err("基础 Context Encoding 的根节点不是 context".into());
    }

    let profile_slot = composed
        .get_path_mut(&["evaluation-profile"])
        .ok_or("基础 Context Encoding 缺少固定的 evaluation-profile 插槽")?;
    if !matches!(
        profile_slot,
        SExpr::List(values)
            if matches!(values.as_slice(), [SExpr::Atom(name), SExpr::Atom(value)] if name == "evaluation-profile" && value == "none")
    ) {
        return Err("基础 Context Encoding 的 evaluation-profile 插槽已被占用".into());
    }
    if let Some(profile) = overlay.evaluation_profile {
        let parsed = crate::sexpr::parse(profile)
            .map_err(|error| format!("Evaluation Profile 不是合法 S 表达式：{error}"))?;
        if !matches!(
            &parsed,
            SExpr::List(values)
                if matches!(values.first(), Some(SExpr::Atom(name)) if name == "evaluation-profile")
        ) {
            return Err("Evaluation Profile 的根节点必须是 evaluation-profile".into());
        }
        *profile_slot = parsed;
    }

    let environment_slot = composed
        .get_path_mut(&["evaluation-environment"])
        .ok_or("基础 Context Encoding 缺少固定的 evaluation-environment 插槽")?;
    let SExpr::List(environment) = environment_slot else {
        return Err("基础 Context Encoding 的 evaluation-environment 不是 List".into());
    };
    if !matches!(environment.first(), Some(SExpr::Atom(name)) if name == "evaluation-environment") {
        return Err("基础 Context Encoding 的 evaluation-environment 插槽无效".into());
    }
    if environment.iter().skip(1).any(|value| {
        matches!(
            value,
            SExpr::List(values)
                if matches!(values.first(), Some(SExpr::Atom(name)) if name == "runtime-directive" || name == "harness-binding")
        )
    }) {
        return Err("基础 Context Encoding 不得预置本轮 Runtime 或 Harness 绑定".into());
    }
    if let Some((kind, description)) = overlay.runtime_directive {
        environment.push(SExpr::List(vec![
            SExpr::Atom("runtime-directive".to_string()),
            SExpr::List(vec![
                SExpr::Atom("kind".to_string()),
                SExpr::Atom(kind.to_string()),
            ]),
            SExpr::List(vec![
                SExpr::Atom("description".to_string()),
                SExpr::Atom(description.to_string()),
            ]),
        ]));
    }
    if let Some(binding) = overlay.harness_binding {
        let parsed = crate::sexpr::parse(binding)
            .map_err(|error| format!("Harness binding 不是合法 S 表达式：{error}"))?;
        if !matches!(
            &parsed,
            SExpr::List(values)
                if matches!(values.first(), Some(SExpr::Atom(name)) if name == "harness-binding")
        ) {
            return Err("Harness binding 的根节点必须是 harness-binding".into());
        }
        environment.push(parsed);
    }
    Ok(composed.to_string())
}

fn compose_context_message(
    prefix: &str,
    base: &str,
    overlay: EvaluationContextOverlay<'_>,
) -> Result<String, DynError> {
    Ok(format!(
        "{prefix}\n{}",
        compose_context_encoding(base, overlay)?
    ))
}

fn stable_harness_entry_call_id(binding: &HarnessBinding, evaluation_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"morphz.harness-entry.v1\0");
    for value in [
        binding.harness_id.as_str(),
        binding.harness_version.as_str(),
        binding.artifact_hash.as_str(),
        binding.objective_id.as_deref().unwrap_or(""),
        evaluation_id,
    ] {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    let encoded = format!("{:x}", digest.finalize());
    format!("harness_entry_{}", &encoded[..32])
}

fn should_dispatch_runtime_harness_entry(executor_kind: &str, phase: &str) -> bool {
    executor_kind != "plan_infer" && !matches!(phase, "critical-maintenance" | "final-reply")
}

fn plan_infer_tool_scope(event: &Event) -> Result<Option<HashSet<String>>, String> {
    let Some(value) = event.payload.get("tools") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let values = value
        .as_array()
        .ok_or_else(|| "Plan infer request 的 tools 必须是字符串数组或 null".to_string())?;
    let mut tools = HashSet::new();
    for value in values {
        let name = value
            .as_str()
            .ok_or_else(|| "Plan infer request 的 tools 只能包含字符串工具名".to_string())?;
        tools.insert(name.to_string());
    }
    Ok(Some(tools))
}

fn restrict_tools_to_scope(tools: &mut Vec<ToolDefinition>, scope: Option<&HashSet<String>>) {
    if let Some(scope) = scope {
        tools.retain(|tool| scope.contains(&tool.name));
    }
}

fn is_objective_bound_tool(name: &str) -> bool {
    name == "objective_update"
}

fn is_dialogue_objective_tool(name: &str) -> bool {
    name == "objective_amend"
}

/// Critical pressure may suspend physical work, but it must never remove the
/// control operation that can terminally settle the Objective currently being
/// evaluated. Otherwise an Agent which has already proved completion can only
/// keep maintaining/reading Context until a later request happens to fall
/// below the pressure boundary.
fn retain_context_maintenance_tools(
    tools: &mut Vec<ToolDefinition>,
    objective_control_available: bool,
    objective_amend_available: bool,
) {
    tools.retain(|tool| {
        matches!(tool.name.as_str(), "context_tx" | "recall")
            || (objective_control_available && tool.name == "objective_update")
            || (objective_amend_available && tool.name == "objective_amend")
    });
}

/// A final-reply turn is reply-only for ordinary work. A bound Objective still
/// needs its one deterministic lifecycle operation; completing the public
/// reply without updating the Objective would leave the Supervisor running.
fn retain_final_reply_control_tools(
    tools: &mut Vec<ToolDefinition>,
    objective_control_available: bool,
    objective_amend_available: bool,
) {
    tools.retain(|tool| {
        (objective_control_available && tool.name == "objective_update")
            || (objective_amend_available && tool.name == "objective_amend")
    });
}

fn derived_thread_kind(event: &Event, _has_objective_route: bool) -> ThreadKind {
    if event.topic == "chat/thread_completion_ready" {
        ThreadKind::Delivery
    } else if is_dialogue_trigger(event) {
        ThreadKind::DialogueTurn
    } else {
        // Objective supervision never creates a separate Thread kind.
        // Objective is the control-plane authority; every physical work lane
        // it starts or resumes is an Execution Thread.
        ThreadKind::Execution
    }
}

fn objective_supervision_matches_state(
    supervision: &ThreadSupervision,
    objective: Option<&crate::memory::ObjectiveRecord>,
) -> bool {
    let Some(objective) = objective else {
        return false;
    };
    if supervision.supervisor_kind != ThreadSupervisorKind::Objective
        || supervision.supervisor_id.as_deref() != Some(objective.id.as_str())
        || objective.status != crate::memory::ObjectiveStatus::Active
    {
        return false;
    }
    match supervision.origin_evaluation_id.as_deref() {
        // The primary Execution Thread belongs to the whole Objective
        // generation and must
        // survive the gaps between finite Evaluations.
        None => supervision.generation == objective.generation,
        // Explicitly spawned Objective work is owned by one finite Evaluation. Keep
        // only the currently fenced owner so startup can close historical
        // duplicates created by older binaries.
        Some(origin_evaluation_id) => {
            objective.active_evaluation_id.as_deref() == Some(origin_evaluation_id)
        }
    }
}

#[cfg(test)]
fn baseline_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::AgentOwnedContext)
}

#[cfg(test)]
fn cognitive_sexpr_vm_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::CognitiveSexprVm)
}

#[cfg(test)]
fn semantic_sexpr_vm_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::SemanticSexprVm)
}

const SOFT_CHECKPOINT_PROMPT: &str = r#"The Runtime is at a soft-checkpoint. This is a periodic progress review, not a stopping condition, and it removes no tool capability.
- Check alignment among the current objective, physical evidence, Mind state, and next step.
- Continue necessary actions when a new reliable progress path exists; do not reply early merely because the checkpoint was reached.
- If recent actions produced no new evidence, stop repeating them and use existing evidence, report the blocker honestly, or reply.
- Submit context_tx only for a state change worth retaining across turns; the checkpoint itself does not require maintenance."#;

const CRITICAL_MAINTENANCE_PROMPT: &str = r#"The Runtime has entered critical-maintenance: this Context reached critical pressure and must release capacity before more external work.
- To keep maintenance itself receivable, the Runtime may project only a bounded Inbox slice. kernel.context-pressure.active-observations is the complete active count; the current Inbox contains this batch's causal root plus the oldest unprotected maintenance candidates. Missing observations remain persisted as Events and are neither lost nor retired. After this batch commits, the Runtime reevaluates and supplies another batch if still over limit.
- Call only tools actually provided in this request. External physical tools are temporarily removed; do not repeat the previous physical call or assume it ran.
- Prefer one accurate context_tx that compresses Mind/Inbox while preserving the current objective, user constraints, latest reliable facts, unfinished work, and evidence required to continue. Summarize or retire stale, duplicate, or superseded content.
- Use recall only for source evidence truly missing before maintenance, not to begin new external work. The Runtime recalculates pressure and restores applicable physical tools after maintenance.
- objective_update remains available for a bound active Objective. If completion evidence already exists, submit completed and enter finalizing in this Activation rather than stranding completed work for Context maintenance.
- Calling a tool not provided in this request is rejected with an explicit result under its tool_call_id."#;

const MAINTENANCE_BUDGET_EXHAUSTED_PROMPT: &str = r#"The Context is critical and this turn's ordinary context_tx allowance is exhausted. To prevent an impossible maintenance loop, this Evaluation is forced into final-reply. Return ordinary text that honestly delivers completed status, the latest reliable verification, and remaining work; call no_reply exclusively only when no message is truly needed. For a bound active Objective, objective_update is the only additional control tool: submit completed first when evidence is sufficient to enter finalizing in this Activation; otherwise preserve the true state and let the Supervisor continue."#;

const CONTEXT_TX_COOLDOWN_PROMPT: &str = r#"The previous standalone context_tx committed successfully and pressure is no longer critical. The Runtime hides context_tx for this request to stop consecutive housekeeping. End the Evaluation with ordinary text, call no_reply exclusively, or perform only physical actions truly required by the current task. context_tx returns after a new user or tool observation."#;
const NO_REPLY_TOOL_NAME: &str = "no_reply";
const CRITICAL_MAINTENANCE_PREVIEW_CHARS: usize = 768;
// Emergency maintenance is separate from the ordinary per-turn housekeeping
// budget. Syntax and transaction semantics must decide whether maintenance is
// valid; this high ceiling remains only a last-resort incident fuse.
const CRITICAL_MAINTENANCE_TRANSACTION_SAFETY_LIMIT: usize = 256;
const MAX_RESPONSE_PROTOCOL_RETRIES: usize = 2;
const TOOL_ARGUMENT_PREVIEW_CHARS: usize = 4_096;
const EMPTY_RESPONSE_DETAIL: &str = "模型响应既没有非空正文，也没有工具调用";
const RESPONSE_PROTOCOL_ERROR: &str = "Response protocol error: this Evaluation has not produced a valid terminal result. To reply to the active Session, return non-empty ordinary assistant text with no tools. For intentional silence, call no_reply(mode=silent) exclusively. Use no_reply(mode=wait) only while the Runtime can verify a nonterminal event. Empty output, a missing or invalid mode, mixing no_reply with another tool, or combining no_reply with content is invalid.";
const OBJECTIVE_CLOSURE_REVIEW_PROTOCOL_ERROR: &str = "Objective closure-review protocol error: the Runtime reports only that all direct child objectives are terminal; it does not decide whether the parent is complete. This evaluation cannot end with ordinary text or no_reply while leaving closure unresolved. Persist one decision: objective_update to completed, blocked, or an exact wait; perform real work; or create a necessary child objective.";
const OBJECTIVE_FINALIZATION_PROMPT: &str = r#"The Runtime persisted your Objective completion decision but has not ended the Objective. You are still in the same Activation. Produce the user-facing final delivery from the complete evidence you just audited:
- Return a complete ordinary assistant response with no tool calls. Do not shorten or omit the final report because you explained parts earlier.
- If there is truly nothing to send, call no_reply(mode=silent) exclusively.
- After the final response commits, the Runtime atomically completes the Objective, Activation, Thread, and ThreadOutcome. Until then, the Objective remains active and its lease continues."#;
const REASONING_ONLY_RESPONSE_REASON: &str =
    "the model returned only a reasoning summary without ordinary text, tool calls, or no_reply";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextTxReceipt {
    None,
    Committed,
    Failed,
}

#[derive(Debug)]
struct ToolExecutionOptions {
    context_tx_allowed: bool,
    wake_on_output: bool,
    /// The owning deterministic Plan, when this is an internal `(call ...)`
    /// effect. Plan outputs are observable child facts, never Scheduler
    /// wakeups for the parent Activation.
    plan_execution_id: Option<String>,
    continuation_tool_calls: Option<Vec<crate::llm::ToolCall>>,
    allowed_tool_names: HashSet<String>,
    record_assistant_call: bool,
    model_attempt_id: Option<String>,
    provider_continuation: Option<ProviderContinuation>,
}

#[derive(Debug, Default)]
struct ToolExecutionOutcome {
    context_tx_succeeded: bool,
    outputs: Vec<Event>,
}

#[derive(Debug, Clone)]
struct ClaimedExecutionJob {
    id: String,
    revision: u64,
    claim_token: String,
    target_id: String,
    record: ExecutionJobRecord,
}

#[derive(Debug, Clone)]
struct ToolTaskMetadata {
    output_id: String,
    context_id: String,
    session_id: String,
    attempt_id: String,
    tool_call_id: String,
    tool_name: String,
    target_id: Option<String>,
    action_group_id: Option<String>,
    activation_route: Option<ActivationRoute>,
    execution_job: Option<ClaimedExecutionJob>,
    wake_on_output: bool,
}

struct SpawnedToolTask {
    handle: tokio::task::JoinHandle<Result<SpawnedToolTaskResult, DynError>>,
    metadata: ToolTaskMetadata,
}

struct SpawnedToolTaskResult {
    output: Event,
    already_persisted: bool,
}

enum PreparedPhysicalExecution {
    Claimed(Box<ClaimedPhysicalExecution>),
    Terminal(Event),
    Rejected(Event),
}

struct ClaimedPhysicalExecution {
    job: ClaimedExecutionJob,
    context: crate::tool::ToolExecutionJobContext,
    approval: Option<DurableApprovalGrant>,
    arguments: String,
}

#[derive(Clone)]
pub struct DurableApprovalServices {
    broker: Arc<PermissionBroker>,
    approvals: Arc<dyn ApprovalStore>,
    execution_approvals: Arc<dyn ExecutionApprovalStore>,
    capability_leases: Arc<dyn CapabilityLeaseStore>,
    human_approval_hub: HumanApprovalHub,
    capability_leases_enabled: bool,
    capability_lease_ttl_secs: u64,
}

impl DurableApprovalServices {
    pub fn new(
        broker: Arc<PermissionBroker>,
        approvals: Arc<dyn ApprovalStore>,
        execution_approvals: Arc<dyn ExecutionApprovalStore>,
        capability_leases: Arc<dyn CapabilityLeaseStore>,
        human_approval_hub: HumanApprovalHub,
        capability_leases_enabled: bool,
        capability_lease_ttl_secs: u64,
    ) -> Self {
        Self {
            broker,
            approvals,
            execution_approvals,
            capability_leases,
            human_approval_hub,
            capability_leases_enabled,
            capability_lease_ttl_secs,
        }
    }
}

async fn covering_capability_lease_grant(
    services: &DurableApprovalServices,
    requirement: &crate::permission::ApprovalRequirement,
    principal_id: &str,
    agent_id: &str,
    thread: &ThreadRecord,
    target: &crate::memory::ExecutionTargetRecord,
) -> Result<Option<DurableApprovalGrant>, DynError> {
    if !services.capability_leases_enabled
        || services.capability_lease_ttl_secs == 0
        || thread.lifecycle != ThreadLifecycle::Open
    {
        return Ok(None);
    }
    let permission_policy_digest = services.broker.policy_digest();
    let lease_policy_digest =
        capability_lease_policy_digest(&permission_policy_digest, &target.policy_digest);
    let capability = requirement.action.lease_capability();
    let leases = services
        .capability_leases
        .list_capability_leases(CapabilityLeaseFilter {
            principal_id: Some(principal_id.to_string()),
            agent_id: Some(agent_id.to_string()),
            thread_id: Some(thread.id.clone()),
            target_id: Some(target.id.clone()),
            capability: Some(capability.clone()),
            active_at: Some(Utc::now()),
            // Every row already belongs to this exact indexed execution
            // scope. Authorization correctness must not depend on a recent
            // row window.
            limit: None,
        })
        .await?;
    Ok(leases.into_iter().find_map(|lease| {
        if lease.policy_digest != lease_policy_digest
            || !lease
                .capabilities
                .iter()
                .any(|candidate| candidate == &capability)
        {
            return None;
        }
        let granted =
            serde_json::from_value::<crate::approval::CapabilityDelta>(lease.requested.clone())
                .ok()?;
        if !requirement.requested.is_subset_of(&granted) {
            return None;
        }
        Some(DurableApprovalGrant {
            approval_id: lease
                .issued_by_approval_id
                .clone()
                .unwrap_or_else(|| lease.id.clone()),
            grant_id: format!("capability-lease:{}", lease.id),
            policy_digest: permission_policy_digest.clone(),
            action: requirement.action.clone(),
            requested: granted,
        })
    }))
}

#[derive(Debug, Clone)]
struct ActivationRoute {
    thread_id: String,
    activation_id: String,
    root_turn_id: String,
    trigger_event_id: String,
    trigger_sequence: u64,
    initiating_principal_id: Option<String>,
    context_snapshot_version: Option<u64>,
    thread_kind: &'static str,
    /// Events that continue an internal Plan infer Thread must not queue
    /// behind the parent handler that is synchronously waiting for that Plan.
    internal_child_handoff: bool,
    /// Immutable completion batch that caused a Delivery Activation.  A
    /// reply must only acknowledge results present in this trigger snapshot;
    /// results arriving while the model is running belong to a later
    /// Delivery Activation.
    delivery_thread_ids: Vec<String>,
}

#[derive(Debug, Default)]
struct ModelReasoningSummaryAccumulator {
    text: String,
    public_text: String,
    provider_continuation: Option<ProviderContinuation>,
    complete: bool,
    persist_started: bool,
    usage: ModelUsage,
    usage_persist_started: bool,
    failure: Option<String>,
}

#[derive(Debug)]
struct ModelCompletion {
    response: crate::llm::Response,
    provider_continuation: Option<ProviderContinuation>,
}

#[derive(Debug)]
struct ModelCompletionError {
    source: DynError,
    reasoning_summary: String,
    partial_text: String,
    provider_continuation: Option<ProviderContinuation>,
    origin: ModelCompletionErrorOrigin,
}

#[derive(Debug, Default)]
struct DurableReasoningContinuationState {
    /// Number of already committed physical reasoning-only boundaries for the
    /// Activation. It keeps retry Attempt IDs monotonic after process restart.
    physical_continuations: usize,
    continuation_count: usize,
    stalled_count: usize,
    summaries: Vec<String>,
    provider_continuations: Vec<ProviderContinuation>,
}

fn durable_reasoning_continuation_state_from_events(
    activation_id: &str,
    events: &[Event],
) -> Result<DurableReasoningContinuationState, DynError> {
    let summaries_by_attempt = events
        .iter()
        .filter(|event| event.topic == "runtime/model_reasoning_summary")
        .filter_map(|event| {
            Some((
                event.payload.get("attempt_id")?.as_str()?.to_string(),
                event.payload.get("text")?.as_str()?.trim().to_string(),
            ))
        })
        .collect::<HashMap<_, _>>();
    let mut restored = DurableReasoningContinuationState::default();
    let mut seen_attempts = HashSet::new();
    for event in events
        .iter()
        .filter(|event| event.topic == "runtime/reasoning_continuation")
    {
        let Some(attempt_id) = event
            .payload
            .get("attempt_id")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        if !seen_attempts.insert(attempt_id.to_string()) {
            continue;
        }
        restored.physical_continuations = restored.physical_continuations.saturating_add(1);
        let continuation_count = event
            .payload
            .get("continuation_count")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or_else(|| restored.continuation_count.saturating_add(1));
        // Context-limit maintenance deliberately starts a new reasoning
        // chain inside the same logical Activation. Its first checkpoint
        // resets the persisted suffix while physical request numbering
        // remains monotonic.
        if continuation_count == 1 && restored.continuation_count > 0 {
            restored.continuation_count = 0;
            restored.stalled_count = 0;
            restored.summaries.clear();
            restored.provider_continuations.clear();
        } else if continuation_count <= restored.continuation_count {
            continue;
        }
        let summary = summaries_by_attempt
            .get(attempt_id)
            .filter(|summary| !summary.is_empty())
            .cloned();
        let provider_continuation = event
            .payload
            .get("provider_continuation")
            .map(|value| {
                serde_json::from_value::<ProviderContinuation>(value.clone()).map_err(|error| {
                    format!(
                        "Activation '{activation_id}' 的 reasoning continuation '{}' 包含无效 Provider 状态：{error}",
                        event.id
                    )
                })
            })
            .transpose()?;
        if summary.is_none() && provider_continuation.is_none() {
            return Err(format!(
                "Activation '{activation_id}' 的 reasoning continuation '{}' 缺少可恢复的摘要或 Provider 状态",
                event.id
            )
            .into());
        }
        if let Some(summary) = summary {
            if restored.summaries.last() == Some(&summary) {
                restored.stalled_count = restored.stalled_count.saturating_add(1);
            } else {
                restored.stalled_count = 0;
            }
            restored.summaries.push(summary);
        }
        if let Some(provider_continuation) = provider_continuation {
            restored.provider_continuations.push(provider_continuation);
        }
        restored.continuation_count = continuation_count;
    }
    Ok(restored)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelCompletionErrorOrigin {
    Provider,
    RuntimePersistence,
    RuntimeInternal,
    RuntimeInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderCircuitPhase {
    Confirming,
    Open,
}

#[derive(Debug)]
struct ProviderCircuitState {
    phase: ProviderCircuitPhase,
    consecutive_failures: u32,
    generation: u64,
    retry_at: tokio::time::Instant,
    /// Dedicated small health monitor ownership. Application requests never
    /// acquire this flag and therefore never become recovery probes.
    health_probe_in_flight: bool,
    waiting_contexts: HashSet<String>,
}

async fn publish_provider_probe_available(
    bus: &InMemoryEventBus,
    resource: &str,
    generation: u64,
    replaced_probe_id: Option<u64>,
    reason: &str,
    contexts: Vec<String>,
) {
    let recovery_phase = match reason {
        "health_probe_succeeded" => "closed",
        "request_retry_elapsed" => "request_retry",
        _ => "half_open",
    };
    for context_id in contexts {
        let event = Event::new(
            format!(
                "provider_recovery_probe_{}_{}_{}",
                generation,
                replaced_probe_id.unwrap_or_default(),
                Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            "Runtime-ProviderRecovery".to_string(),
            "runtime_control".to_string(),
            "runtime/resource_available".to_string(),
            [
                ("context_id".to_string(), json!(context_id)),
                ("resource".to_string(), json!(resource)),
                ("recovery_phase".to_string(), json!(recovery_phase)),
                ("recovery_reason".to_string(), json!(reason)),
                ("generation".to_string(), json!(generation)),
                ("replaced_probe_id".to_string(), json!(replaced_probe_id)),
            ]
            .into_iter()
            .collect(),
        );
        if let Err(error) = bus.publish(event).await {
            tracing::error!(event_code = "orchestrator.provider.half_open_event_publish_failed", %error, provider_resource = %resource, "Failed to publish the Provider half-open recovery Event");
        }
    }
}

#[derive(Debug, Default)]
struct ContextMaintenanceGate {
    owner: Arc<Mutex<()>>,
    completed_epoch: AtomicU64,
}

#[derive(Debug)]
struct RefreshContextAfterConcurrentMaintenance;

impl std::fmt::Display for RefreshContextAfterConcurrentMaintenance {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("refresh Context after concurrent maintenance")
    }
}

impl std::error::Error for RefreshContextAfterConcurrentMaintenance {}

impl ModelCompletionError {
    fn provider(source: DynError) -> Self {
        Self {
            source,
            reasoning_summary: String::new(),
            partial_text: String::new(),
            provider_continuation: None,
            origin: ModelCompletionErrorOrigin::Provider,
        }
    }

    fn persistence(source: DynError) -> Self {
        Self {
            source,
            reasoning_summary: String::new(),
            partial_text: String::new(),
            provider_continuation: None,
            origin: ModelCompletionErrorOrigin::RuntimePersistence,
        }
    }

    fn internal(source: DynError) -> Self {
        Self {
            source,
            reasoning_summary: String::new(),
            partial_text: String::new(),
            provider_continuation: None,
            origin: ModelCompletionErrorOrigin::RuntimeInternal,
        }
    }

    fn input(source: DynError) -> Self {
        Self {
            source,
            reasoning_summary: String::new(),
            partial_text: String::new(),
            provider_continuation: None,
            origin: ModelCompletionErrorOrigin::RuntimeInput,
        }
    }

    async fn with_summary_from(
        source: DynError,
        accumulator: &Arc<Mutex<ModelReasoningSummaryAccumulator>>,
        origin: ModelCompletionErrorOrigin,
    ) -> Self {
        let accumulator = accumulator.lock().await;
        Self {
            source,
            reasoning_summary: accumulator.text.clone(),
            partial_text: accumulator.public_text.clone(),
            provider_continuation: accumulator.provider_continuation.clone(),
            origin,
        }
    }

    fn is_runtime_failure(&self) -> bool {
        self.origin != ModelCompletionErrorOrigin::Provider
    }

    fn into_source(self) -> DynError {
        self.source
    }

    fn failure(&self) -> ModelFailure {
        let mut current: Option<&(dyn std::error::Error + 'static)> = Some(self.source.as_ref());
        while let Some(error) = current {
            if let Some(failure) = error.downcast_ref::<ModelFailure>() {
                return failure.clone();
            }
            if let Some(io_error) = error.downcast_ref::<std::io::Error>() {
                let kind = match io_error.kind() {
                    std::io::ErrorKind::TimedOut => ModelFailureKind::StreamIdleTimeout,
                    std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::HostUnreachable
                    | std::io::ErrorKind::NetworkUnreachable => ModelFailureKind::TransientNetwork,
                    _ => ModelFailureKind::Unknown,
                };
                return ModelFailure::new(kind, self.to_string());
            }
            current = error.source();
        }
        ModelFailure::classify_message(self.to_string())
    }
}

impl std::fmt::Display for ModelCompletionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for ModelCompletionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

struct AdmittedThreadActivation {
    record: ThreadActivationRecord,
    /// Dropping this permit is the physical transition back out of the
    /// single-node running set.  It must span terminal persistence.
    _permit: ActivationAdmissionPermit,
}

#[derive(Debug, Default)]
struct DialogueThreadGate {
    // The critical section only reads or replaces one String and is never held
    // across an await. A synchronous mutex lets a dropped Activation release
    // ownership immediately instead of depending on another Tokio task.
    owner_root_turn_id: std::sync::Mutex<Option<String>>,
    changed: Notify,
}

impl DialogueThreadGate {
    async fn acquire(&self, root_turn_id: &str) {
        loop {
            let changed = self.changed.notified();
            {
                let mut owner = self
                    .owner_root_turn_id
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                match owner.as_deref() {
                    None => {
                        *owner = Some(root_turn_id.to_string());
                        return;
                    }
                    Some(current) if current == root_turn_id => return,
                    Some(_) => {}
                }
            }
            changed.await;
        }
    }

    async fn owns(&self, root_turn_id: &str) -> bool {
        self.owner_root_turn_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_deref()
            == Some(root_turn_id)
    }

    fn release_now(&self, root_turn_id: &str) -> bool {
        let released = {
            let mut owner = self
                .owner_root_turn_id
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if owner.as_deref() == Some(root_turn_id) {
                *owner = None;
                true
            } else {
                false
            }
        };
        if released {
            // Only one distinct root turn may enter next. `notify_one` also
            // retains a permit when release races with a waiter between its
            // ownership check and `.await`; `notify_waiters` would lose that
            // wake-up when no `Notified` future has been polled yet.
            self.changed.notify_one();
        }
        released
    }

    fn release(&self, root_turn_id: &str) -> bool {
        self.release_now(root_turn_id)
    }
}

/// Owns the process-local dialogue serialization gate for one root turn.
///
/// Dialogue evaluation has several fallible and cancellable boundaries before
/// it reaches a terminal reply.  Keeping release calls only on successful
/// branches leaves the Session permanently blocked when any of those
/// boundaries returns early.  This lease releases on every dropped future,
/// including model errors and `tokio::select!` cancellation.  The one explicit
/// exception is a successful context-maintenance handoff: that continuation
/// keeps ownership for the same root turn and calls `retain_for_continuation`.
struct DialogueThreadLease {
    gate: Arc<DialogueThreadGate>,
    root_turn_id: String,
    release_on_drop: bool,
}

impl DialogueThreadLease {
    fn new(gate: Arc<DialogueThreadGate>, root_turn_id: impl Into<String>) -> Self {
        Self {
            gate,
            root_turn_id: root_turn_id.into(),
            release_on_drop: true,
        }
    }

    fn release(&mut self) {
        if !self.release_on_drop {
            return;
        }
        self.gate.release(&self.root_turn_id);
        self.release_on_drop = false;
    }

    fn retain_for_continuation(&mut self) {
        self.release_on_drop = false;
    }
}

impl Drop for DialogueThreadLease {
    fn drop(&mut self) {
        if !self.release_on_drop {
            return;
        }
        self.release_on_drop = false;
        self.gate.release_now(&self.root_turn_id);
    }
}

/// Process-local wakeup for operator cancellation of one exact Activation.
/// The persistent Thread generation/lifecycle is the authority; this registry
/// only makes a currently running model/tool future observe that authority
/// immediately instead of waiting for its next durable boundary.
struct ActivationCancellationRegistry {
    reasons: DashMap<String, String>,
    epoch: watch::Sender<u64>,
}

impl Default for ActivationCancellationRegistry {
    fn default() -> Self {
        let (epoch, _) = watch::channel(0);
        Self {
            reasons: DashMap::new(),
            epoch,
        }
    }
}

impl ActivationCancellationRegistry {
    fn request(&self, activation_id: &str, reason: &str) {
        self.reasons
            .insert(activation_id.to_string(), reason.to_string());
        let next = self.epoch.borrow().wrapping_add(1);
        self.epoch.send_replace(next);
    }

    fn clear(&self, activation_id: &str) {
        self.reasons.remove(activation_id);
    }

    async fn wait(&self, activation_id: &str) -> String {
        let mut epoch = self.epoch.subscribe();
        loop {
            if let Some(reason) = self.reasons.get(activation_id) {
                return reason.clone();
            }
            let _ = epoch.changed().await;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalDecision {
    Deliver(String),
    NoReply(NoReplyMode),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoReplyMode {
    /// The Agent intentionally chooses not to send a Session message.
    Silent,
    /// The current Execution yields until a durable Runtime event wakes it.
    Wait,
}

impl TerminalDecision {
    fn disposition(&self) -> &'static str {
        match self {
            Self::Deliver(_) => "deliver",
            Self::NoReply(NoReplyMode::Silent) => "no_reply",
            Self::NoReply(NoReplyMode::Wait) => "wait",
        }
    }
}

fn no_reply_tool_definition() -> crate::llm::ToolDefinition {
    crate::llm::ToolDefinition {
        name: NO_REPLY_TOOL_NAME.to_string(),
        description: "Send no message to the active Session and explicitly select why. mode=silent intentionally ends without a message. mode=wait temporarily yields only because a Runtime-verifiable background task, schedule, or pending event still exists. The Runtime validates wait; if the event already completed or failed, process the latest result and reply or continue instead. no_reply neither completes an Objective nor cancels background work. It must be the only tool call and cannot accompany content.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["silent", "wait"],
                    "description": "silent intentionally sends no message; wait yields for a nonterminal event known to the Runtime"
                }
            },
            "required": ["mode"],
            "additionalProperties": false
        }),
    }
}

fn classify_terminal_response(
    response: &crate::llm::Response,
) -> Result<Option<TerminalDecision>, String> {
    let no_reply_calls = response
        .tool_calls
        .iter()
        .filter(|call| call.func_name == NO_REPLY_TOOL_NAME)
        .collect::<Vec<_>>();
    if no_reply_calls.is_empty() {
        if response.tool_calls.is_empty() {
            let content = response.content.trim();
            if content.is_empty() {
                return Err("响应既没有非空正文，也没有调用 no_reply".to_string());
            }
            return Ok(Some(TerminalDecision::Deliver(response.content.clone())));
        }
        return Ok(None);
    }
    if no_reply_calls.len() != 1 || response.tool_calls.len() != 1 {
        return Err("no_reply 必须独占响应且只调用一次".to_string());
    }
    if !response.content.trim().is_empty() {
        return Err("no_reply 不能同时携带普通文本".to_string());
    }
    let arguments: serde_json::Value = serde_json::from_str(&no_reply_calls[0].arguments)
        .map_err(|error| format!("no_reply 参数 JSON 非法: {error}"))?;
    let object = arguments
        .as_object()
        .ok_or_else(|| "no_reply 参数必须是 JSON object".to_string())?;
    if object.len() != 1 {
        return Err("no_reply 只接受必填参数 mode=\"silent\" 或 mode=\"wait\"".to_string());
    }
    let mode = match object.get("mode").and_then(|value| value.as_str()) {
        Some("silent") => NoReplyMode::Silent,
        Some("wait") => NoReplyMode::Wait,
        _ => return Err("no_reply.mode 只支持 silent 或 wait".to_string()),
    };
    Ok(Some(TerminalDecision::NoReply(mode)))
}

fn validate_objective_closure_review_response(
    initial_closure_review: bool,
    decision: Option<TerminalDecision>,
) -> Result<Option<TerminalDecision>, String> {
    if initial_closure_review && decision.is_some() {
        Err(OBJECTIVE_CLOSURE_REVIEW_PROTOCOL_ERROR.to_string())
    } else {
        Ok(decision)
    }
}

fn validate_final_reply_response(
    effective_phase: &str,
    objective_control_available: bool,
    response: &crate::llm::Response,
    decision: Option<TerminalDecision>,
) -> Result<Option<TerminalDecision>, String> {
    if effective_phase == "objective-finalization" {
        return match decision {
            Some(TerminalDecision::Deliver(_))
            | Some(TerminalDecision::NoReply(NoReplyMode::Silent)) => Ok(decision),
            Some(TerminalDecision::NoReply(NoReplyMode::Wait)) => Err(
                "Objective finalization 不能进入等待；请提交完整最终报告，或在确实无需发送时调用 no_reply(mode=silent)"
                    .to_string(),
            ),
            None => Err(
                "Objective finalization 必须返回无工具普通文本，或独占调用 no_reply(mode=silent)"
                    .to_string(),
            ),
        };
    }
    if effective_phase != "final-reply" || decision.is_some() {
        return Ok(decision);
    }
    let is_objective_control = objective_control_available
        && response.tool_calls.len() == 1
        && response.tool_calls[0].func_name == "objective_update";
    if is_objective_control {
        Ok(None)
    } else {
        Err(
            "final-reply 阶段必须返回普通文本、独占调用 no_reply，或为当前绑定的 active Objective 独占调用 objective_update"
                .to_string(),
        )
    }
}

fn completed_objective_update_call(response: &crate::llm::Response) -> bool {
    if response.tool_calls.len() != 1 || !response.content.trim().is_empty() {
        return false;
    }
    let call = &response.tool_calls[0];
    if call.func_name != "objective_update" {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(&call.arguments)
        .ok()
        .and_then(|arguments| {
            arguments
                .get("status")
                .and_then(serde_json::Value::as_str)
                .map(|status| status == "completed")
        })
        .unwrap_or(false)
}

fn validate_objective_completion_call(response: &crate::llm::Response) -> Result<(), String> {
    let completion_calls = response
        .tool_calls
        .iter()
        .filter(|call| {
            call.func_name == "objective_update"
                && serde_json::from_str::<serde_json::Value>(&call.arguments)
                    .ok()
                    .and_then(|arguments| {
                        arguments
                            .get("status")
                            .and_then(serde_json::Value::as_str)
                            .map(|status| status == "completed")
                    })
                    .unwrap_or(false)
        })
        .count();
    if completion_calls == 0 {
        return Ok(());
    }
    if completed_objective_update_call(response) {
        Ok(())
    } else {
        Err("objective_update(status=completed) 必须是响应中唯一的工具调用，且不能同时携带普通文本；Runtime 会在同一 Activation 中提供专门的最终交付 Attempt".to_string())
    }
}

fn validate_schedule_tx_response(response: &crate::llm::Response) -> Result<(), String> {
    let schedule_calls = response
        .tool_calls
        .iter()
        .filter(|call| call.func_name == "schedule_tx")
        .count();
    if schedule_calls == 0 {
        return Ok(());
    }
    if schedule_calls != 1 || response.tool_calls.len() != 1 {
        return Err(
            "schedule_tx 必须是响应中唯一且只调用一次的工具；不能与物理工具、context_tx 或其他 schedule_tx 混用"
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Default)]
struct ToolContinuationEnvelope {
    messages: Vec<Message>,
    delivered_output_ids: HashSet<String>,
}

fn retain_pending_continuation_calls(
    attempt_id: &str,
    calls: Vec<crate::llm::ToolCall>,
    outputs: &HashMap<(String, String), Event>,
    retired_observation_ids: &BTreeSet<String>,
) -> Vec<crate::llm::ToolCall> {
    calls
        .into_iter()
        .filter(|call| {
            outputs
                .get(&(attempt_id.to_string(), call.id.clone()))
                .is_some_and(|output| {
                    // A successful context transaction is already reflected by
                    // the freshly compiled Mind projection. Replaying its large
                    // request/receipt pair through the Provider protocol creates
                    // a second, non-retirable context and can make maintenance
                    // increase pressure instead of relieving it. Failures remain
                    // in the current envelope so the model can correct the transaction.
                    !context_tx_output_succeeded(output)
                        && !retired_observation_ids.contains(&output.id)
                })
        })
        .collect()
}

pub struct Orchestrator {
    /// Set once `start` hands over an `Arc<Self>`.
    ///
    /// An `infer` inside a submitted program has to reach the model the way an
    /// ordinary turn does — through `request_model_completion`, with its
    /// provider admission, queueing and deadlines — but it is evaluated inside
    /// a spawned tool task that owns nothing. Threading an `Arc<Self>` down to
    /// it would have meant changing the receiver of the whole attempt path for
    /// a purely mechanical reason; a weak self-reference keeps that surface
    /// untouched and cannot keep the Runtime alive on its own.
    self_ref: std::sync::OnceLock<std::sync::Weak<Orchestrator>>,
    /// Unique owner identity for this Runtime instance. Multiple embedded
    /// Runtimes may share one process and one Store, so a process-wide token
    /// is not a sufficient fencing boundary.
    runtime_claimant_id: String,
    bus: Arc<InMemoryEventBus>,
    store: Arc<dyn EventStore>,
    /// Complete Store authority used by durable Yao PlanExecution. Kept
    /// separate from the read/write EventStore surface so tests may assemble a
    /// deliberately smaller Orchestrator without silently weakening eval.
    plan_store: Option<Arc<dyn crate::memory::RuntimeStore>>,
    /// Sole production mutation facade for scheduler authority. Narrow tests
    /// may omit it while they migrate fixtures; Runtime assembly always
    /// injects the Kernel.
    scheduler_kernel: Option<Arc<crate::scheduler::SchedulerKernel>>,
    client: Arc<dyn Client>,
    registry: Arc<Registry>,
    tool_definitions: Vec<crate::llm::ToolDefinition>,
    context_engine: Arc<ContextEngine>,
    orchestrator_config: OrchestratorConfig,
    model_input_config: crate::config::ModelInputConfig,
    event_writer_metrics: Arc<DurableEventWriterMetrics>,
    /// Last full model-request measurement per Context/Session. Rebuilding a
    /// Context Encoding produces a component-only fallback; inspection APIs
    /// must not overwrite the newer full-Prompt measurement with that fallback.
    prompt_pressure_measurements: DashMap<(String, String), PromptPressureMeasurement>,
    /// Last Provider-observed input usage paired with the exact local estimate
    /// of that same attempt. Event restoration makes calibration survive a
    /// process restart; the key prevents one Context, Session or model from
    /// calibrating another.
    prompt_usage_anchors: DashMap<(String, String, String, String), DurablePromptUsageAnchor>,
    model_provider_metrics: Arc<ModelProviderMetrics>,
    /// Shared outage gate for one physical Provider endpoint/model. Adapter
    /// retries are request-local; this circuit prevents many independent
    /// Activations from amplifying the same outage after those retries fail.
    provider_circuits: DashMap<String, Arc<std::sync::Mutex<ProviderCircuitState>>>,
    /// Resource-availability Events are durable facts, while their dependency
    /// satisfaction handlers may transiently fail after Event commit. Keep a
    /// fair live retry queue; restart recovery re-derives the same work from
    /// pending resource dependencies and a fresh Provider probe.
    provider_delivery_retries: Arc<DurableEventDeliveryQueue>,
    provider_delivery_wakeup: Arc<Notify>,
    /// Provider-observed Context overflow may be discovered by many
    /// Activations at once. Exactly one owner is allowed to run the semantic
    /// maintenance request; waiters restart from the newer projection after
    /// the owner commits context_tx.
    context_maintenance_gates: DashMap<String, Arc<ContextMaintenanceGate>>,
    /// Concurrent Activations commonly observe the same physical outage. Each
    /// one still needs a terminal control event for Objective reconciliation,
    /// but only the first occurrence in a short incident window should become
    /// a user-visible reply.
    runtime_failure_incidents: DashMap<String, RuntimeFailureIncident>,
    #[doc(hidden)]
    pub model_provider_semaphore: Arc<tokio::sync::Semaphore>,
    activation_admission: ActivationAdmissionController,
    /// Share the live permit holder with concurrently spawned tool tasks.
    /// A durable Plan may suspend the parent permit while its child Evaluation
    /// runs, then put the reacquired permit back before returning to the
    /// parent attempt.
    activation_admission_slots: DashMap<String, Arc<ActivationAdmissionSlot>>,
    /// One ordered Dialogue Lane per Session. Tool/objective continuations do
    /// not take this lock: after a dialogue turn launches an Execution Thread, later
    /// user messages can still be answered while that work continues.
    dialogue_thread_gates: DashMap<String, Arc<DialogueThreadGate>>,
    /// One evaluator at a time may drain a Thread mailbox. Tool calls may
    /// execute concurrently inside an attempt, but their result/timer/exit
    /// events converge here instead of forking independent model chains.
    thread_gates: DashMap<String, Arc<Mutex<()>>>,
    cancellation_epochs: DashMap<String, watch::Sender<u64>>,
    activation_cancellations: ActivationCancellationRegistry,
    active_session_turns: DashMap<String, Arc<AtomicUsize>>,
    activation_routes: DashMap<String, ActivationRoute>,
    /// The newest physical Model Attempt owned by each live Activation.
    /// Activation cancellation drops the evaluation future, so the ordinary
    /// completion path cannot publish that Attempt's terminal transition.
    /// Keeping this process-local pointer lets the cancellation owner close
    /// the exact transient stream before observers wait for a snapshot.
    active_model_attempts: DashMap<String, String>,
    cancelled_at: DashMap<String, chrono::DateTime<Utc>>,
    /// Runtime routing identity: a Session is an IO connection inside one
    /// Cognitive Context. This cache is populated from every incoming routed
    /// event and is deliberately separate from the shared Mind state.
    session_contexts: DashMap<String, String>,
    /// Contexts whose scheduler authority changed since the last online
    /// invariant audit. The Event Bus coalesces an arbitrary burst into one
    /// indexed live-state read; an idle Runtime performs no audit query.
    supervision_audit_dirty_contexts: Arc<DashMap<String, ()>>,
    /// Committed scheduler Events wake Plan reconciliation immediately. The
    /// slow fallback exists only for shared-store mutations from another
    /// process and the commit-before-notify crash window.
    plan_reconcile_wakeup: Arc<Notify>,
    plan_job_reconcile_cursor: Mutex<Option<(chrono::DateTime<Utc>, String)>>,
    plan_evaluation_reconcile_cursor: Mutex<Option<(chrono::DateTime<Utc>, String)>>,
    action_group_reconcile_dirty: Arc<DashMap<String, ()>>,
    action_group_reconcile_wakeup: Arc<Notify>,
    /// Rotating keyset cursor for the slow lost-notification fallback. A
    /// permanently incomplete old Group must not make every 30-second pass
    /// reread the same prefix or starve newer Groups.
    action_group_reconcile_cursor: Mutex<Option<(chrono::DateTime<Utc>, String)>>,
    delegation_start_lock: Mutex<()>,
    objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
    objective_supervisor: Option<Arc<ObjectiveSupervisor>>,
    /// Scheduler Kernel physical clock. Every Orchestrator has one: terminal
    /// Thread delivery and activation leases are not optional features.
    timer_engine: Arc<TimerEngine>,
    thread_scheduler: Option<Arc<ThreadScheduler>>,
    execution_jobs: Option<Arc<ExecutionJobManager<dyn ExecutionJobStore>>>,
    execution_targets: Option<Arc<crate::execution_target::ExecutionTargetDispatcher>>,
    action_groups: Option<Arc<dyn ActionGroupStore>>,
    background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
    durable_approvals: Option<DurableApprovalServices>,
    harness_registry: Arc<DomainHarnessRegistry>,
    message_attachment_root: PathBuf,
}

/// Append one immutable transition of a physical Model Attempt. These Events
/// form a tiny durable online projection: reconnecting observers fold the
/// newest transition per `attempt_id` instead of depending on having seen the
/// ephemeral stream's `started` chunk.
#[allow(clippy::too_many_arguments)]
async fn persist_model_attempt_state(
    bus: &Arc<InMemoryEventBus>,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    route: &[(String, serde_json::Value)],
    state: &str,
    terminal: bool,
    detail: Option<&str>,
    attributes: &[(String, serde_json::Value)],
) -> Result<(), DynError> {
    let mut payload = vec![
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("state".to_string(), json!(state)),
        ("terminal".to_string(), json!(terminal)),
    ];
    if let Some(detail) = detail.filter(|value| !value.trim().is_empty()) {
        payload.push(("detail".to_string(), json!(detail)));
    }
    payload.extend_from_slice(attributes);
    payload.extend_from_slice(route);
    bus.publish(Event::new(
        format!(
            "model_attempt_state_{}_{}_{}",
            attempt_id,
            state,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ),
        "Runtime-Orchestrator".to_string(),
        "runtime_control".to_string(),
        "runtime/model_attempt_state".to_string(),
        payload.into_iter().collect(),
    ))
    .await?;
    tracing::info!(
        session_id,
        attempt_id,
        state,
        terminal,
        detail = detail.unwrap_or_default(),
        event_code = "orchestrator.model_attempt.state_transition",
        "Model Attempt state transition"
    );
    Ok(())
}

fn local_counter_source(source: &str) -> String {
    source.split('+').next().unwrap_or(source).to_string()
}

fn apply_prompt_estimate_delta(
    actual_anchor_tokens: usize,
    current_local_estimate: usize,
    anchor_local_estimate: usize,
) -> usize {
    if current_local_estimate >= anchor_local_estimate {
        actual_anchor_tokens.saturating_add(current_local_estimate - anchor_local_estimate)
    } else {
        actual_anchor_tokens.saturating_sub(anchor_local_estimate - current_local_estimate)
    }
}

/// Commit the provider-authored reasoning summary as one independent Event
/// artifact. Deltas remain ephemeral; this helper is also used after timeout
/// so a partial summary can survive without waiting for a stuck provider.
async fn persist_model_reasoning_summary(
    bus: &Arc<InMemoryEventBus>,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    route: &[(String, serde_json::Value)],
    accumulator: &Arc<Mutex<ModelReasoningSummaryAccumulator>>,
    force_incomplete: bool,
) -> Result<(), DynError> {
    let (text, complete, failure) = {
        let mut accumulator = accumulator.lock().await;
        if force_incomplete {
            accumulator.complete = false;
        }
        if accumulator.persist_started || accumulator.text.is_empty() {
            return Ok(());
        }
        accumulator.persist_started = true;
        (
            accumulator.text.clone(),
            accumulator.complete,
            accumulator.failure.clone(),
        )
    };

    let mut payload = vec![
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("text".to_string(), json!(text)),
        ("complete".to_string(), json!(complete)),
    ];
    if let Some(failure) = failure {
        payload.push(("failure".to_string(), json!(failure)));
    }
    payload.extend_from_slice(route);
    let event = Event::new(
        format!("model_reasoning_summary_{attempt_id}"),
        "Model-Provider".to_string(),
        "runtime_control".to_string(),
        "runtime/model_reasoning_summary".to_string(),
        payload.into_iter().collect(),
    );
    if let Err(error) = bus.publish(event).await {
        accumulator.lock().await.persist_started = false;
        return Err(error);
    }
    Ok(())
}

/// Persist Provider usage independently from reasoning, public text, tool
/// calls and reply semantics. Every attempt that received usage therefore
/// leaves one stable, auditable Event fact even when its reasoning summary
/// is empty or the response later fails.
async fn persist_model_usage(
    bus: &Arc<InMemoryEventBus>,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    route: &[(String, serde_json::Value)],
    accumulator: &Arc<Mutex<ModelReasoningSummaryAccumulator>>,
    measurement: Option<&PromptTokenCount>,
) -> Result<(), DynError> {
    let usage = {
        let mut accumulator = accumulator.lock().await;
        if accumulator.usage_persist_started || !accumulator.usage.has_usage() {
            return Ok(());
        }
        accumulator.usage_persist_started = true;
        accumulator.usage.clone()
    };

    let mut payload = vec![
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("usage".to_string(), serde_json::to_value(&usage)?),
        ("usage_schema_version".to_string(), json!(1)),
    ];
    if let Some(measurement) = measurement {
        payload.extend([
            ("model".to_string(), json!(&measurement.model)),
            (
                "predicted_input_tokens".to_string(),
                json!(measurement.tokens),
            ),
            (
                "local_base_estimate_tokens".to_string(),
                json!(measurement.base_estimate_tokens),
            ),
            ("counter_source".to_string(), json!(&measurement.source)),
            (
                "counter_accuracy".to_string(),
                json!(measurement.accuracy.as_str()),
            ),
            (
                "calibration_key".to_string(),
                json!(measurement.calibration_key),
            ),
            (
                "calibration_shape".to_string(),
                json!(measurement.calibration_shape),
            ),
        ]);
    }
    payload.extend_from_slice(route);
    let event = Event::new(
        format!("model_usage_{attempt_id}"),
        "Model-Provider".to_string(),
        "runtime_control".to_string(),
        "runtime/model_usage".to_string(),
        payload.into_iter().collect(),
    );
    if let Err(error) = bus.publish(event).await {
        accumulator.lock().await.usage_persist_started = false;
        return Err(error);
    }
    let model_binding = route
        .iter()
        .find(|(key, _)| key == "model_binding")
        .map(|(_, value)| value);
    let binding_field = |field: &str| {
        model_binding
            .and_then(|binding| binding.get(field))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    };
    let measured_model = measurement
        .map(|measurement| measurement.model.as_str())
        .unwrap_or_default();
    tracing::info!(
        context_id,
        session_id,
        attempt_id,
        requested_alias = binding_field("requested_alias"),
        route_id = binding_field("route_id"),
        provider_instance_id = binding_field("provider_instance_id"),
        auth_account_id = binding_field("auth_account_id"),
        physical_model = binding_field("physical_model"),
        protocol = binding_field("protocol"),
        measured_model,
        input_tokens = ?usage.input_tokens,
        uncached_input_tokens = ?usage.uncached_input_tokens,
        cached_input_tokens = ?usage.cached_input_tokens,
        cache_write_input_tokens = ?usage.cache_write_input_tokens,
        output_tokens = ?usage.output_tokens,
        reasoning_tokens = ?usage.reasoning_tokens,
        total_tokens = ?usage.total_tokens,
        predicted_input_tokens = ?measurement.map(|measurement| measurement.tokens),
        event_code = "orchestrator.model_usage.persisted",
        "Provider model usage persisted"
    );
    Ok(())
}

fn reasoning_continuation_prompt(summaries: &[String], has_provider_continuation: bool) -> String {
    let reasoning = summaries
        .iter()
        .enumerate()
        .map(|(index, summary)| {
            format!(
                "<reasoning_segment index=\"{}\">\n{}\n</reasoning_segment>",
                index + 1,
                summary
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prior_progress = if reasoning.is_empty() && has_provider_continuation {
        "<provider_continuation>Runtime 已在请求协议中附带 Provider 原生推理续接状态；该状态不是用户消息，也不是可见 assistant 正文。</provider_continuation>".to_string()
    } else {
        format!("<previous_reasoning>\n{reasoning}\n</previous_reasoning>")
    };
    format!(
        "之前的物理模型请求只生成了推理进度，没有生成可提交的正文或工具调用。Runtime 已按顺序恢复可用的推理摘要和 Provider 原生续接状态；它们不是用户消息，也不是已发送给用户的 assistant 正文。请沿用这些进度继续完成你的推理，不要从头重复分析；推理完成后再产生一种合法终态：返回非空普通 assistant 文本且不调用工具，或执行所需工具调用，或在确实无需消息时独占调用 no_reply。\n\n{prior_progress}"
    )
}

fn append_reasoning_continuation_input(
    messages: &mut Vec<Message>,
    provider_continuations: &[ProviderContinuation],
    reasoning_history: &[String],
) -> Result<(), DynError> {
    // OpenAI Responses continuation items are self-contained input items and
    // can be replayed before the next user instruction. OpenAI Chat's
    // reasoning_content, by contrast, is only legal on the assistant message
    // which owns a tool call; a reasoning-only response has no such message,
    // so Chat-compatible providers use the durable summary prompt instead.
    let mut has_provider_continuation = false;
    for continuation in provider_continuations {
        if matches!(continuation, ProviderContinuation::OpenaiResponses { .. }) {
            messages.push(provider_continuation_message(continuation.clone())?);
            has_provider_continuation = true;
        }
    }
    messages.push(Message {
        role: "user".to_string(),
        content: reasoning_continuation_prompt(reasoning_history, has_provider_continuation),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    });
    Ok(())
}

fn interrupted_text_continuation_prompt() -> &'static str {
    "上一条 assistant 正文在 Provider 流中断时只传输了一部分。该部分已由 Runtime 保留并作为紧邻的 assistant 消息提供。请从断点继续完成同一份正文，不要重新开头、不要复述已给出的内容；完成后返回剩余正文。"
}

impl Orchestrator {
    pub fn activation_admission_snapshot(
        &self,
    ) -> crate::activation_admission::ActivationAdmissionSnapshot {
        self.activation_admission.snapshot()
    }

    pub fn durable_event_writer_metrics(&self) -> DurableEventWriterMetricsSnapshot {
        self.event_writer_metrics.snapshot()
    }

    pub fn model_provider_metrics(&self) -> ModelProviderMetricsSnapshot {
        self.model_provider_metrics
            .snapshot(self.orchestrator_config.model_provider_max_in_flight.max(1))
    }

    pub fn context_capacity_metrics(
        &self,
    ) -> crate::orchestrator::context::ContextCapacityMetricsSnapshot {
        self.context_engine.capacity_metrics()
    }

    async fn admit_provider_circuit(&self, context_id: &str) -> Result<(), ModelFailure> {
        let resource = self.client.provider_resource_key();
        let Some(circuit) = self
            .provider_circuits
            .get(&resource)
            .map(|entry| Arc::clone(entry.value()))
        else {
            return Ok(());
        };
        let mut state = circuit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.waiting_contexts.insert(context_id.to_string());
        let now = tokio::time::Instant::now();
        match state.phase {
            // A business request reported a Provider-scoped error, but the
            // independent small probes have not confirmed an outage. Keep
            // unrelated Sessions available during that confirmation window.
            ProviderCircuitPhase::Confirming => Ok(()),
            ProviderCircuitPhase::Open => {
                let retry_after = state
                    .retry_at
                    .saturating_duration_since(now)
                    .as_secs()
                    .max(1);
                Err(ModelFailure::new(
                    ModelFailureKind::ServerUnavailable,
                    format!("Provider circuit open; retry in {retry_after}s"),
                )
                .with_retry_after(Some(retry_after)))
            }
        }
    }

    async fn record_provider_failure(&self, context_id: &str, failure: &ModelFailure) {
        if !failure.kind.uses_provider_recovery() {
            return;
        }
        let resource = self.client.provider_resource_key();
        if failure.kind.is_request_scoped_latency() {
            // A large request with a slow first byte, or one stalled stream,
            // is request-local evidence. Wake only its owning Context after a
            // short delay; never poison the endpoint+model shared circuit.
            let delay =
                std::time::Duration::from_secs(failure.retry_after_secs.unwrap_or(5).clamp(1, 300));
            let bus = Arc::clone(&self.bus);
            let context_id = context_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                publish_provider_probe_available(
                    &bus,
                    &resource,
                    0,
                    None,
                    "request_retry_elapsed",
                    vec![context_id],
                )
                .await;
            });
            return;
        }

        let circuit = self
            .provider_circuits
            .entry(resource.clone())
            .or_insert_with(|| {
                Arc::new(std::sync::Mutex::new(ProviderCircuitState {
                    phase: ProviderCircuitPhase::Confirming,
                    consecutive_failures: 0,
                    generation: 1,
                    retry_at: tokio::time::Instant::now(),
                    health_probe_in_flight: false,
                    waiting_contexts: HashSet::new(),
                }))
            })
            .clone();
        let (generation, should_start_probe, initial_delay) = {
            let mut state = circuit
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.waiting_contexts.insert(context_id.to_string());
            let should_start_probe = !state.health_probe_in_flight;
            if should_start_probe {
                state.health_probe_in_flight = true;
            }
            (
                state.generation,
                should_start_probe,
                std::time::Duration::from_secs(failure.retry_after_secs.unwrap_or(5).clamp(1, 300)),
            )
        };
        if !should_start_probe {
            return;
        }
        tracing::warn!(
            provider_resource = %resource,
            failure_kind = failure.kind.as_str(),
            generation,
            event_code = "orchestrator.provider.failure_awaiting_probe",
            "Provider failure is awaiting an independent health probe; the shared circuit remains closed"
        );
        let bus = Arc::clone(&self.bus);
        let client = Arc::clone(&self.client);
        tokio::spawn(async move {
            const FAILURE_THRESHOLD: u32 = 3;
            tokio::time::sleep(initial_delay).await;
            let mut independent_failures = 0u32;
            loop {
                {
                    let state = circuit
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if state.generation != generation || !state.health_probe_in_flight {
                        return;
                    }
                }
                match client.probe_health().await {
                    Ok(()) => {
                        let contexts = {
                            let mut state = circuit
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if state.generation != generation {
                                return;
                            }
                            state.phase = ProviderCircuitPhase::Confirming;
                            state.consecutive_failures = 0;
                            state.health_probe_in_flight = false;
                            state.waiting_contexts.drain().collect::<Vec<_>>()
                        };
                        tracing::info!(event_code = "orchestrator.provider.probe_succeeded", provider_resource = %resource, generation, "Independent health probe succeeded; the shared Provider circuit remains or returns closed");
                        publish_provider_probe_available(
                            &bus,
                            &resource,
                            generation,
                            None,
                            "health_probe_succeeded",
                            contexts,
                        )
                        .await;
                        return;
                    }
                    Err(error) => {
                        independent_failures = independent_failures.saturating_add(1);
                        tracing::warn!(event_code = "orchestrator.provider.probe_failed", provider_resource = %resource, generation, independent_failures, error = %error, "Independent Provider health probe failed");
                    }
                }

                if independent_failures < FAILURE_THRESHOLD {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        1_u64 << independent_failures.min(5),
                    ))
                    .await;
                    continue;
                }

                let delay = {
                    let mut state = circuit
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if state.generation != generation {
                        return;
                    }
                    state.phase = ProviderCircuitPhase::Open;
                    state.consecutive_failures = state
                        .consecutive_failures
                        .saturating_add(independent_failures);
                    let exponent = state.consecutive_failures.saturating_sub(1).min(6);
                    let delay = std::time::Duration::from_secs(
                        5_u64.saturating_mul(1_u64 << exponent).min(300),
                    );
                    state.retry_at = tokio::time::Instant::now() + delay;
                    delay
                };
                tracing::warn!(event_code = "orchestrator.provider.shared_circuit_opened", provider_resource = %resource, generation, delay_secs = delay.as_secs(), probe_failures = independent_failures, "Multiple independent health probes failed; the shared Provider circuit opened");
                tokio::time::sleep(delay).await;
                independent_failures = 0;
            }
        });
    }

    async fn record_provider_success(&self) {
        let resource = self.client.provider_resource_key();
        let Some((_, circuit)) = self.provider_circuits.remove(&resource) else {
            return;
        };
        let contexts = {
            let mut state = circuit
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.health_probe_in_flight = false;
            state.generation = state.generation.saturating_add(1);
            state.waiting_contexts.iter().cloned().collect::<Vec<_>>()
        };
        tracing::info!(event_code = "orchestrator.provider.recovery_probe_succeeded", provider_resource = %resource, "Provider recovery probe succeeded; the shared circuit closed");
        for context_id in contexts {
            let event = Event::new(
                format!(
                    "provider_recovered_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or_default()
                ),
                "Runtime-ProviderRecovery".to_string(),
                "runtime_control".to_string(),
                "runtime/resource_available".to_string(),
                [
                    ("context_id".to_string(), json!(context_id)),
                    ("resource".to_string(), json!(&resource)),
                    ("recovery_phase".to_string(), json!("closed")),
                ]
                .into_iter()
                .collect(),
            );
            if let Err(error) = self.bus.publish(event).await {
                tracing::error!(event_code = "orchestrator.provider.recovery_event_publish_failed", %error, provider_resource = %resource, "Failed to publish the Provider recovery Event");
            }
        }
    }

    async fn handle_thread_resource_available(&self, event: Event) -> Result<(), DynError> {
        let Some(resource) = event
            .payload
            .get("resource")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        let Some(context_id) = event
            .payload
            .get("context_id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        let Some(store) = self.plan_store.as_ref() else {
            return Ok(());
        };
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let dependencies = store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Thread),
                dependency_kind: Some(SchedulerDependencyKind::Resource),
                dependency_id: Some(resource.to_string()),
                status: Some(SchedulerDependencyStatus::Pending),
                required_only: true,
                ..Default::default()
            })
            .await?;
        let mut deferred_errors = Vec::new();
        for dependency in dependencies {
            let Some(thread) = session_store.get_thread(&dependency.owner_id).await? else {
                tracing::warn!(
                    dependency_id = %dependency.id,
                    thread_id = %dependency.owner_id,
                    event_code = "orchestrator.provider_recovery.thread_missing",
                    "Thread referenced by a Provider recovery dependency is missing; retaining the dependency for invariant audit"
                );
                continue;
            };
            if thread.context_id != context_id
                || thread.generation != dependency.owner_generation
                || thread.lifecycle != ThreadLifecycle::Open
            {
                continue;
            }
            let wake_event_id = crate::scheduler::stable_command_id(
                "provider-recovered-event",
                &format!("{}\0{}", dependency.id, event.id),
            );
            let wake_event = Event::new(
                wake_event_id,
                "Runtime-ProviderRecovery".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "runtime/provider_recovered".to_string(),
                serde_json::json!({
                    "context_id": thread.context_id,
                    "session_id": thread.session_id,
                    "thread_id": thread.id,
                    "root_turn_id": thread.root_turn_id,
                    "thread_generation": thread.generation,
                    "principal_id": thread.initiating_principal_id,
                    "resource": resource,
                    "dependency_id": dependency.id,
                    "recovery_event_id": event.id,
                    "recovery_phase": event.payload.get("recovery_phase").cloned().unwrap_or(serde_json::Value::Null),
                    "recovery_reason": event.payload.get("recovery_reason").cloned().unwrap_or(serde_json::Value::Null),
                    "runtime_force_evaluation": true,
                    "wake_policy": "direct_signal",
                })
                .as_object()
                .cloned()
                .ok_or("Provider recovery wake payload 不是 object")?,
            );
            let commit_result: Result<crate::scheduler::ThreadResourceWakeCommit, DynError> =
                if let Some(kernel) = self.scheduler_kernel.as_ref() {
                    match kernel
                    .execute(
                        crate::controllers::DeliveryController::satisfy_thread_resource_dependency(
                            &dependency.id,
                            dependency.owner_generation,
                            dependency.dependency_generation,
                            &event.id,
                            wake_event,
                            context_id,
                            "Runtime-ProviderRecovery",
                        ),
                    )
                    .await
                    {
                        Ok(crate::scheduler::KernelResult::ThreadResourceDependencySatisfied(
                            commit,
                        )) => Ok(commit),
                        Ok(_) => Err(
                            "SatisfyThreadResourceDependency command returned wrong result".into(),
                        ),
                        Err(error) => Err(Box::new(error) as DynError),
                    }
                } else {
                    store
                        .satisfy_thread_resource_dependency(
                            &dependency.id,
                            dependency.owner_generation,
                            dependency.dependency_generation,
                            &event.id,
                            &wake_event,
                        )
                        .await
                };
            let commit = match commit_result {
                Ok(commit) => commit,
                Err(error) => {
                    deferred_errors.push(format!("{}: {error}", dependency.id));
                    tracing::warn!(
                        dependency_id = %dependency.id,
                        thread_id = %dependency.owner_id,
                        recovery_event_id = %event.id,
                        %error,
                        event_code = "orchestrator.provider_recovery.thread_state_race",
                        "Provider recovery raced with Thread state; skipping this dependency and continuing with other waiters"
                    );
                    continue;
                }
            };
            tracing::info!(
                dependency_id = %commit.dependency.id,
                thread_id = %commit.dependency.owner_id,
                recovery_event_id = %event.id,
                replay = commit.existing,
                event_code = "orchestrator.provider_recovery.dependency_satisfied",
                "Provider recovery atomically satisfied the Thread dependency and wrote a wake Signal"
            );
            // The Event and its direct Signal are already durable. This only
            // wakes the live executor; replay is safe because Signal claim is
            // fenced by Thread generation and Activation ownership.
            self.bus.dispatch_persisted(commit.wake_event).await?;
        }
        if !deferred_errors.is_empty() {
            return Err(format!(
                "{} Provider recovery dependencies remain pending after transient commit failures: {}",
                deferred_errors.len(),
                deferred_errors.join("; ")
            )
            .into());
        }
        Ok(())
    }

    async fn recover_thread_provider_waits(&self) -> Result<(), DynError> {
        let Some(store) = self.plan_store.as_ref() else {
            return Ok(());
        };
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let resource = self.client.provider_resource_key();
        let dependencies = store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Thread),
                dependency_kind: Some(SchedulerDependencyKind::Resource),
                dependency_id: Some(resource.clone()),
                status: Some(SchedulerDependencyStatus::Pending),
                required_only: true,
                ..Default::default()
            })
            .await?;
        let mut contexts = BTreeSet::new();
        for dependency in dependencies {
            let Some(thread) = session_store.get_thread(&dependency.owner_id).await? else {
                continue;
            };
            if thread.lifecycle == ThreadLifecycle::Open
                && thread.generation == dependency.owner_generation
            {
                contexts.insert(thread.context_id);
            }
        }
        if contexts.is_empty() {
            return Ok(());
        }
        tracing::info!(
            provider_resource = %resource,
            waiting_contexts = contexts.len(),
            event_code = "orchestrator.provider_probe.recovered_after_restart",
            "Recovered Provider waiting probes after Runtime restart"
        );
        let failure = ModelFailure::new(
            ModelFailureKind::ServerUnavailable,
            "Runtime restart recovered persistent Provider waits",
        )
        .with_retry_after(Some(1));
        for context_id in contexts {
            self.record_provider_failure(&context_id, &failure).await;
        }
        Ok(())
    }

    async fn acquire_model_provider_slot(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<ModelProviderPermit, ModelFailure> {
        self.model_provider_metrics
            .queued
            .fetch_add(1, Ordering::Relaxed);
        let acquired = tokio::time::timeout_at(
            deadline,
            Arc::clone(&self.model_provider_semaphore).acquire_owned(),
        )
        .await;
        self.model_provider_metrics
            .queued
            .fetch_sub(1, Ordering::Relaxed);
        let permit = match acquired {
            Ok(Ok(permit)) => permit,
            Ok(Err(error)) => {
                return Err(ModelFailure::new(
                    ModelFailureKind::ProviderQueueTimeout,
                    format!("local Provider admission semaphore closed: {error}"),
                ));
            }
            Err(_) => {
                return Err(ModelFailure::new(
                    ModelFailureKind::ProviderQueueTimeout,
                    "local Provider admission queue deadline exceeded",
                ));
            }
        };
        self.model_provider_metrics
            .in_flight
            .fetch_add(1, Ordering::Relaxed);
        self.model_provider_metrics
            .acquired_total
            .fetch_add(1, Ordering::Relaxed);
        Ok(ModelProviderPermit {
            _permit: permit,
            metrics: Arc::clone(&self.model_provider_metrics),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn assemble_with_scheduler_kernel(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        plan_store: Option<Arc<dyn crate::memory::RuntimeStore>>,
        scheduler_kernel: Option<Arc<crate::scheduler::SchedulerKernel>>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
        orchestrator_config: OrchestratorConfig,
        model_input_config: crate::config::ModelInputConfig,
        context_engine: Arc<ContextEngine>,
        objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
        objective_supervisor: Option<Arc<ObjectiveSupervisor>>,
        timer_engine: Arc<TimerEngine>,
        thread_scheduler: Option<Arc<ThreadScheduler>>,
        execution_jobs: Option<Arc<ExecutionJobManager<dyn ExecutionJobStore>>>,
        execution_targets: Option<Arc<crate::execution_target::ExecutionTargetDispatcher>>,
        action_groups: Option<Arc<dyn ActionGroupStore>>,
        background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
        durable_approvals: Option<DurableApprovalServices>,
        harness_registry: Option<Arc<DomainHarnessRegistry>>,
        message_attachment_root: PathBuf,
    ) -> Result<Arc<Self>, DynError> {
        let model_provider_semaphore = Arc::new(tokio::sync::Semaphore::new(
            orchestrator_config.model_provider_max_in_flight.max(1),
        ));
        let activation_admission = ActivationAdmissionController::new(ActivationAdmissionLimits {
            total_slots: orchestrator_config.activation_admission.max_in_flight,
            dialogue_delivery_slots: orchestrator_config
                .activation_admission
                .dialogue_delivery_reserved_slots,
            max_queued: orchestrator_config.activation_admission.max_queued,
            dialogue_delivery_queue_slots: orchestrator_config
                .activation_admission
                .dialogue_delivery_reserved_queue_slots,
            aging_promotion_interval_ms: orchestrator_config
                .activation_admission
                .aging_promotion_interval
                .as_secs()
                .saturating_mul(1_000),
        });
        let tool_definitions = registry.definitions();
        let orchestrator = Arc::new(Self {
            self_ref: std::sync::OnceLock::new(),
            runtime_claimant_id: new_runtime_claimant_id(),
            bus,
            store,
            plan_store,
            scheduler_kernel,
            client,
            registry,
            tool_definitions,
            context_engine,
            orchestrator_config,
            model_input_config,
            event_writer_metrics: Arc::new(DurableEventWriterMetrics::default()),
            prompt_pressure_measurements: DashMap::new(),
            prompt_usage_anchors: DashMap::new(),
            model_provider_metrics: Arc::new(ModelProviderMetrics::default()),
            provider_circuits: DashMap::new(),
            provider_delivery_retries: Arc::new(DurableEventDeliveryQueue::default()),
            provider_delivery_wakeup: Arc::new(Notify::new()),
            context_maintenance_gates: DashMap::new(),
            runtime_failure_incidents: DashMap::new(),
            model_provider_semaphore,
            activation_admission,
            activation_admission_slots: DashMap::new(),
            dialogue_thread_gates: DashMap::new(),
            thread_gates: DashMap::new(),
            cancellation_epochs: DashMap::new(),
            activation_cancellations: ActivationCancellationRegistry::default(),
            active_session_turns: DashMap::new(),
            activation_routes: DashMap::new(),
            active_model_attempts: DashMap::new(),
            cancelled_at: DashMap::new(),
            session_contexts: DashMap::new(),
            supervision_audit_dirty_contexts: Arc::new(DashMap::new()),
            plan_reconcile_wakeup: Arc::new(Notify::new()),
            plan_job_reconcile_cursor: Mutex::new(None),
            plan_evaluation_reconcile_cursor: Mutex::new(None),
            action_group_reconcile_dirty: Arc::new(DashMap::new()),
            action_group_reconcile_wakeup: Arc::new(Notify::new()),
            action_group_reconcile_cursor: Mutex::new(None),
            delegation_start_lock: Mutex::new(()),
            objective_evaluations,
            objective_supervisor,
            timer_engine,
            thread_scheduler,
            execution_jobs,
            execution_targets,
            action_groups,
            background_scheduler,
            durable_approvals,
            harness_registry: harness_registry.unwrap_or_default(),
            message_attachment_root,
        });
        // Established here rather than in `start`, so an Orchestrator built for
        // a test can evaluate `infer` without first being started.
        let _ = orchestrator.self_ref.set(Arc::downgrade(&orchestrator));
        orchestrator.register_timer_handlers()?;
        Ok(orchestrator)
    }

    /// Safe integration-test factory. It deliberately exposes only the
    /// Scheduler Kernel minimum, requires a durable TimerEngine, and registers
    /// the Orchestrator handlers and starts its dispatcher before returning.
    ///
    /// Product assembly goes through `MorphzRuntimeBuilder`; this function is
    /// public solely because Cargo integration tests are separate crates.
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn new_test_with_context_engine(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        plan_store: Option<Arc<dyn crate::memory::RuntimeStore>>,
        action_groups: Arc<dyn ActionGroupStore>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
        orchestrator_config: OrchestratorConfig,
        context_engine: Arc<ContextEngine>,
        timer_engine: Arc<TimerEngine>,
        execution_jobs: Option<Arc<ExecutionJobManager<dyn ExecutionJobStore>>>,
    ) -> Result<Arc<Self>, DynError> {
        let orchestrator = Self::assemble_with_scheduler_kernel(
            bus,
            store,
            plan_store,
            None,
            client,
            registry,
            orchestrator_config,
            crate::config::ModelInputConfig::default(),
            context_engine,
            Arc::new(ObjectiveEvaluationRegistry::default()),
            None,
            timer_engine,
            None,
            execution_jobs,
            None,
            Some(action_groups),
            None,
            None,
            None,
            std::env::temp_dir().join("morphz-test-message-attachments"),
        )?;
        orchestrator.timer_engine.start();
        Ok(orchestrator)
    }

    fn register_timer_handlers(self: &Arc<Self>) -> Result<(), DynError> {
        let timers = &self.timer_engine;
        let orchestrator = Arc::downgrade(self);
        timers.register_handler(RuntimeTimerKind::ActivationLease, move |timer| {
            let orchestrator = orchestrator.clone();
            async move {
                let Some(orchestrator) = orchestrator.upgrade() else {
                    return Ok(TimerDisposition::Complete);
                };
                orchestrator.dispatch_activation_lease(timer).await
            }
        })?;
        let orchestrator = Arc::downgrade(self);
        timers.register_handler(RuntimeTimerKind::DeliveryFlush, move |timer| {
            let orchestrator = orchestrator.clone();
            async move {
                let Some(orchestrator) = orchestrator.upgrade() else {
                    return Ok(TimerDisposition::Complete);
                };
                orchestrator.dispatch_delivery_flush(timer).await
            }
        })
    }

    async fn arm_activation_lease(
        &self,
        activation: &ThreadActivationRecord,
    ) -> Result<(), DynError> {
        if activation.status != ThreadActivationStatus::Running {
            return Ok(());
        }
        let lease_expires_at = activation.lease_expires_at.unwrap_or_else(Utc::now);
        self.timer_engine
            .schedule(NewRuntimeTimer {
                id: activation_lease_timer_id(&activation.id),
                generation: activation.revision,
                kind: RuntimeTimerKind::ActivationLease,
                owner_id: activation.id.clone(),
                // Runtime Timers are shared-store work. Scheduling the owner
                // heartbeat here lets another Runtime consume the only wakeup
                // and mistake a healthy long-running Activation for a zombie.
                // The process-local heartbeat loop renews the durable lease;
                // this Timer is solely the cross-Runtime expiry detector.
                due_at: lease_expires_at,
                payload: json!({
                    "activation_id": activation.id,
                    "revision": activation.revision,
                    "claimed_by": activation.claimed_by,
                    "trigger_event_id": activation.trigger_event_id,
                }),
            })
            .await?;
        Ok(())
    }

    fn start_activation_lease_heartbeats(self: &Arc<Self>) {
        let orchestrator = Arc::downgrade(self);
        let heartbeat_secs = self
            .orchestrator_config
            .activation_lease_secs
            .saturating_div(3)
            .max(1);
        tokio::spawn(async move {
            let heartbeat = std::time::Duration::from_secs(heartbeat_secs);
            loop {
                tokio::time::sleep(heartbeat).await;
                let Some(orchestrator) = orchestrator.upgrade() else {
                    break;
                };
                if let Err(error) = orchestrator.renew_local_activation_leases().await {
                    tracing::error!(
                        event_code = "orchestrator.activation.lease_heartbeat_failed",
                        %error,
                        "Could not renew one or more locally-owned Activation leases; durable expiry recovery remains armed"
                    );
                }
            }
        });
    }

    async fn renew_local_activation_leases(&self) -> Result<(), DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Activation lease heartbeat 需要持久化 SessionStore")?;
        let snapshot = self.activation_admission.snapshot();
        let activation_ids = snapshot
            .in_flight_activation_ids
            .into_iter()
            .chain(snapshot.suspended_activation_ids);
        for activation_id in activation_ids {
            if !self.activation_admission.is_in_flight(&activation_id) {
                continue;
            }
            let Some(current) = session_store.get_thread_activation(&activation_id).await? else {
                continue;
            };
            if current.status != ThreadActivationStatus::Running
                || current.claimed_by.as_deref() != Some(self.runtime_claimant_id.as_str())
            {
                continue;
            }
            let renewed_expires_at = Utc::now() + self.activation_lease_duration();
            match self
                .transition_thread_activation(
                    &current,
                    ThreadActivationStatus::Running,
                    current.claimed_by.clone(),
                    Some(renewed_expires_at),
                    current.context_snapshot_version,
                    &current.trigger_event_id,
                    "ActivationLeaseHeartbeat",
                )
                .await?
            {
                ThreadActivationMutation::Updated(renewed) => {
                    self.arm_activation_lease(&renewed).await?;
                    tracing::debug!(
                        activation_id = %renewed.id,
                        revision = renewed.revision,
                        lease_expires_at = %crate::local_time::format_utc_for_local(renewed_expires_at),
                        event_code = "orchestrator.activation.lease_renewed",
                        "Local Activation heartbeat renewed its durable lease"
                    );
                }
                ThreadActivationMutation::Conflict { current }
                    if current.status == ThreadActivationStatus::Running
                        && current.claimed_by.as_deref()
                            == Some(self.runtime_claimant_id.as_str()) =>
                {
                    self.arm_activation_lease(&current).await?;
                }
                ThreadActivationMutation::Conflict { .. } | ThreadActivationMutation::NotFound => {}
            }
        }
        Ok(())
    }

    /// Observe the durable Activation fence while this Runtime owns the
    /// process-local evaluation future. A peer Runtime cannot wake our local
    /// cancellation registry, so the persisted row is the cross-process
    /// cancellation channel.
    async fn wait_for_durable_activation_revocation(&self, activation_id: &str) -> String {
        let Some(session_store) = self.context_engine.session_store() else {
            return std::future::pending::<String>().await;
        };
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            match durable_activation_revocation_reason(
                session_store.as_ref(),
                activation_id,
                &self.runtime_claimant_id,
            )
            .await
            {
                Ok(Some(reason)) => return reason,
                Ok(None) => {}
                Err(error) => {
                    // A transient read failure must not manufacture a
                    // cancellation. Lease expiry remains the crash fallback,
                    // and the next poll rechecks the authoritative row.
                    tracing::warn!(
                        activation_id,
                        error = %error,
                        event_code = "orchestrator.activation.durable_fence_read_failed",
                        "Could not read the durable Activation cancellation fence; retrying"
                    );
                }
            }
        }
    }

    async fn cancel_activation_lease(&self, activation_id: &str) -> Result<(), DynError> {
        self.timer_engine
            .cancel(&activation_lease_timer_id(activation_id))
            .await?;
        Ok(())
    }

    /// Route every physical Activation lifecycle mutation through the
    /// Scheduler Kernel. The Store fallback is intentionally limited to
    /// narrow unit fixtures which assemble an Orchestrator without a Kernel;
    /// production Runtime construction always injects one.
    // The transition command keeps every fenced lifecycle coordinate explicit at the Kernel edge.
    #[allow(clippy::too_many_arguments)]
    async fn transition_thread_activation(
        &self,
        activation: &ThreadActivationRecord,
        status: ThreadActivationStatus,
        claimed_by: Option<String>,
        lease_expires_at: Option<chrono::DateTime<Utc>>,
        context_snapshot_version: Option<u64>,
        causation_id: &str,
        actor: &str,
    ) -> Result<ThreadActivationMutation, DynError> {
        if let Some(kernel) = self.scheduler_kernel.as_ref() {
            return match kernel
                .execute(
                    crate::controllers::DialogueController::transition_activation(
                        activation,
                        status,
                        claimed_by,
                        lease_expires_at,
                        context_snapshot_version,
                        causation_id,
                        actor,
                    ),
                )
                .await?
            {
                crate::scheduler::KernelResult::ActivationTransitioned(mutation) => Ok(mutation),
                _ => Err("Scheduler Kernel 返回了错误的 Activation transition 结果".into()),
            };
        }
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Activation 需要持久化 SessionStore")?;
        session_store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                status,
                claimed_by.as_deref(),
                lease_expires_at,
                context_snapshot_version,
            )
            .await
    }

    async fn dispatch_activation_lease(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Activation lease 需要持久化 SessionStore")?;
        let Some(current) = session_store.get_thread_activation(&timer.owner_id).await? else {
            return Ok(TimerDisposition::Complete);
        };
        if current.status != ThreadActivationStatus::Running {
            return Ok(TimerDisposition::Complete);
        }
        if current.revision != timer.generation {
            self.arm_activation_lease(&current).await?;
            return Ok(TimerDisposition::Complete);
        }
        if current.claimed_by.as_deref() == Some(self.runtime_claimant_id.as_str())
            && self.activation_admission.is_in_flight(&current.id)
        {
            // A live owner renews before expiry. The lease is a failure
            // detector, not a model/tool wall-clock timeout; keeping those
            // concepts separate lets another Runtime recover a crashed
            // request promptly without stealing healthy long-running work.
            let renewed_expires_at = Utc::now() + self.activation_lease_duration();
            match self
                .transition_thread_activation(
                    &current,
                    ThreadActivationStatus::Running,
                    current.claimed_by.clone(),
                    Some(renewed_expires_at),
                    current.context_snapshot_version,
                    &timer.id,
                    "ActivationLeaseTimer",
                )
                .await?
            {
                ThreadActivationMutation::Updated(renewed) => {
                    self.arm_activation_lease(&renewed).await?;
                    let renewed_expires_at_local =
                        crate::local_time::format_utc_for_local(renewed_expires_at);
                    tracing::debug!(
                        activation_id = %renewed.id,
                        revision = renewed.revision,
                        lease_expires_at = %renewed_expires_at_local,
                        event_code = "orchestrator.activation.lease_renewed",
                        "Local Activation is still running; heartbeat renewed its lease and recovery clock"
                    );
                    return Ok(TimerDisposition::Complete);
                }
                ThreadActivationMutation::Conflict { current }
                    if current.status == ThreadActivationStatus::Running =>
                {
                    self.arm_activation_lease(&current).await?;
                    return Ok(TimerDisposition::Complete);
                }
                ThreadActivationMutation::Conflict { .. } | ThreadActivationMutation::NotFound => {
                    return Ok(TimerDisposition::Complete);
                }
            }
        }
        if let Some(expires_at) = current.lease_expires_at {
            if expires_at > Utc::now() {
                return Ok(TimerDisposition::Reschedule {
                    due_at: expires_at,
                    reason: Some("Thread Activation lease 尚未到期".to_string()),
                });
            }
        }
        let Some(thread) = session_store
            .get_thread_by_root(&current.root_turn_id)
            .await?
        else {
            return Err(format!(
                "Activation '{}' 所属 root Thread '{}' 不存在",
                current.id, current.root_turn_id
            )
            .into());
        };
        if thread.lifecycle.is_terminal() || thread.generation != current.generation {
            // A restarted/cancelled logical Thread fences every physical
            // Evaluation from an older generation.  Never resurrect it merely
            // because its process-local lease expired.
            match self
                .transition_thread_activation(
                    &current,
                    ThreadActivationStatus::Cancelled,
                    None,
                    None,
                    current.context_snapshot_version,
                    &timer.id,
                    "ActivationLeaseTimer",
                )
                .await?
            {
                ThreadActivationMutation::Updated(cancelled) => {
                    self.activation_admission.forget(&cancelled.id);
                    tracing::info!(
                        activation_id = %cancelled.id,
                        activation_generation = cancelled.generation,
                        thread_id = %thread.id,
                        thread_generation = thread.generation,
                        thread_lifecycle = thread.lifecycle.as_str(),
                        event_code = "orchestrator.activation.stale_generation_cancelled",
                        "Cancelled an Activation fenced out by its logical Thread generation"
                    );
                }
                ThreadActivationMutation::Conflict { .. } | ThreadActivationMutation::NotFound => {}
            }
            return Ok(TimerDisposition::Complete);
        }
        let Some(trigger) = self
            .store
            .query(QueryFilter {
                event_id: Some(current.trigger_event_id.clone()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|event| event.id == current.trigger_event_id)
        else {
            return Err(format!(
                "Activation '{}' 的 Trigger Event '{}' 不存在",
                current.id, current.trigger_event_id
            )
            .into());
        };
        let mut trigger = trigger;
        trigger
            .payload
            .insert("runtime_force_evaluation".to_string(), json!(true));
        trigger.payload.insert(
            "runtime_recovery_activation_id".to_string(),
            json!(&current.id),
        );
        // The timer is the live-process crash detector.  Replaying the Event
        // alone is insufficient: claim_thread_signal_batch intentionally
        // reuses the existing running row, so no evaluator can acquire it.
        // First CAS it back to queued, then restore the same durable row into
        // admission and redispatch the immutable Trigger Event.
        match self
            .transition_thread_activation(
                &current,
                ThreadActivationStatus::Queued,
                None,
                None,
                None,
                &timer.id,
                "ActivationLeaseRecovery",
            )
            .await?
        {
            ThreadActivationMutation::Updated(queued) => {
                self.activation_admission.forget(&queued.id);
                match self
                    .activation_admission
                    .restore_queued(activation_admission_key(&queued, &trigger))?
                {
                    RestoreQueuedOutcome::Restored => {
                        tracing::warn!(
                            activation_id = %queued.id,
                            thread_id = %thread.id,
                            generation = queued.generation,
                            event_code = "orchestrator.activation.expired_lease_reclaimed",
                            "Reclaimed a zombie Activation with an expired lease at runtime"
                        );
                        self.bus.dispatch_persisted(trigger).await?;
                    }
                    RestoreQueuedOutcome::AlreadyTracked
                    | RestoreQueuedOutcome::DeferredWindowFull => {
                        // The durable queued row remains recoverable.  The
                        // admission refill loop dispatches it once capacity is
                        // available; do not fabricate a failure.
                    }
                }
            }
            ThreadActivationMutation::Conflict { current }
                if current.status == ThreadActivationStatus::Running =>
            {
                self.arm_activation_lease(&current).await?;
            }
            ThreadActivationMutation::Conflict { .. } | ThreadActivationMutation::NotFound => {}
        }
        Ok(TimerDisposition::Complete)
    }

    fn activation_lease_duration(&self) -> chrono::Duration {
        let lease_seconds = self.orchestrator_config.activation_lease_secs.max(1);
        chrono::Duration::seconds(i64::try_from(lease_seconds).unwrap_or(i64::MAX))
    }

    pub fn objective_evaluations(&self) -> Arc<ObjectiveEvaluationRegistry> {
        Arc::clone(&self.objective_evaluations)
    }

    pub async fn start(self: Arc<Self>) -> Result<(), DynError> {
        let store = Arc::clone(&self.store);
        let event_writer = DurableEventWriter::spawn(
            store,
            &self.orchestrator_config.event_writer,
            Arc::clone(&self.event_writer_metrics),
        );
        self.bus.subscribe_durable_writer(
            "*".to_string(),
            Arc::new(move |event| {
                let event_writer = event_writer.clone();
                Box::pin(async move { event_writer.append(EventAppend { event }).await })
            }),
        );

        // Scheduler mutations are already represented by durable causal
        // Events. Use them as an invalidation signal instead of polling every
        // Context's lifetime every two seconds. This listener is deliberately
        // process-local and writes no business state.
        let dirty_contexts = Arc::clone(&self.supervision_audit_dirty_contexts);
        let plan_reconcile_wakeup = Arc::clone(&self.plan_reconcile_wakeup);
        let action_group_reconcile_dirty = Arc::clone(&self.action_group_reconcile_dirty);
        let action_group_reconcile_wakeup = Arc::clone(&self.action_group_reconcile_wakeup);
        self.bus.subscribe(
            "*".to_string(),
            Arc::new(move |event| {
                let dirty_contexts = Arc::clone(&dirty_contexts);
                let plan_reconcile_wakeup = Arc::clone(&plan_reconcile_wakeup);
                let action_group_reconcile_dirty = Arc::clone(&action_group_reconcile_dirty);
                let action_group_reconcile_wakeup = Arc::clone(&action_group_reconcile_wakeup);
                Box::pin(async move {
                    if scheduler_audit_event(&event) {
                        plan_reconcile_wakeup.notify_one();
                        if let Some(context_id) = event
                            .payload
                            .get("context_id")
                            .and_then(serde_json::Value::as_str)
                        {
                            dirty_contexts.insert(context_id.to_string(), ());
                        }
                    }
                    if let Some(group_id) = action_group_reconcile_id(&event) {
                        action_group_reconcile_dirty.insert(group_id.to_string(), ());
                        action_group_reconcile_wakeup.notify_one();
                    }
                    Ok(())
                })
            }),
        );

        let orchestrator = Arc::clone(&self);
        self.bus.subscribe(
            "chat/delegate".to_string(),
            Arc::new(move |event| {
                let orchestrator = Arc::clone(&orchestrator);
                Box::pin(async move { orchestrator.handle_delegate_event(event).await })
            }),
        );

        let orchestrator = Arc::clone(&self);
        self.bus.subscribe(
            "chat/*".to_string(),
            Arc::new(move |event| {
                let orchestrator = Arc::clone(&orchestrator);
                Box::pin(async move { orchestrator.handle_chat_event(event).await })
            }),
        );
        let orchestrator = Arc::clone(&self);
        self.bus.subscribe(
            "runtime/action_group_settled".to_string(),
            Arc::new(move |event| {
                let orchestrator = Arc::clone(&orchestrator);
                Box::pin(async move { orchestrator.handle_chat_event(event).await })
            }),
        );
        if self.plan_store.is_some() {
            let orchestrator = Arc::clone(&self);
            self.bus.subscribe(
                "runtime/resource_available".to_string(),
                Arc::new(move |event| {
                    let orchestrator = Arc::clone(&orchestrator);
                    Box::pin(async move {
                        if orchestrator.provider_delivery_retries.enqueue(event) {
                            orchestrator.provider_delivery_wakeup.notify_one();
                        }
                        Ok(())
                    })
                }),
            );
            let orchestrator = Arc::clone(&self);
            self.bus.subscribe(
                "runtime/provider_recovered".to_string(),
                Arc::new(move |event| {
                    let orchestrator = Arc::clone(&orchestrator);
                    Box::pin(async move { orchestrator.handle_chat_event(event).await })
                }),
            );
        }

        // Reconcile authoritative scheduler state before redispatching any
        // model Activation. Event dispatch starts concurrent handler futures;
        // running it first lets those futures contend with startup repairs for
        // the same SQLite writer and can make an otherwise healthy restart
        // fail with SQLITE_BUSY.
        self.rebuild_activation_admission_queue().await?;
        self.audit_active_supervision_invariants().await?;
        self.recover_thread_provider_waits().await?;
        self.reconcile_durable_plans().await?;
        self.recover_delegations().await?;
        self.reconcile_orphaned_threads().await?;
        self.reconcile_orphaned_execution_jobs().await?;
        self.recover_pending_delivery_flushes().await?;
        self.migrate_legacy_signal_outbox_once().await?;
        self.recover_action_groups().await?;
        self.recover_pending_thread_signals().await?;
        // Activation redispatch is deliberately last: after this point model
        // and tool continuations may write concurrently with the caller.
        self.recover_thread_activations().await?;
        self.refill_activation_admission_queue().await?;
        self.start_activation_lease_heartbeats();
        self.start_activation_admission_refill();
        self.start_plan_reconciler();
        self.start_pending_signal_reconciler();
        self.start_action_group_reconciler();
        self.start_provider_delivery_reconciler();
        self.start_supervision_invariant_auditor();
        Ok(())
    }

    fn start_activation_admission_refill(self: &Arc<Self>) {
        let orchestrator = Arc::downgrade(self);
        let admission = self.activation_admission.clone();
        tokio::spawn(async move {
            loop {
                if orchestrator.upgrade().is_none() {
                    break;
                }
                // Never retain the Orchestrator Arc while sleeping on a
                // process-local notification. Otherwise this maintenance task
                // keeps the whole Runtime alive after every external owner has
                // gone away.
                let changed = tokio::select! {
                    _ = admission.wait_for_change() => true,
                    // This is only a lifecycle check; durable admission is
                    // still notification-driven and never polls SQLite.
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => false,
                };
                if !changed {
                    continue;
                }
                // Collapse a burst of permit/queue changes into one durable
                // scan without turning admission into a polling loop.
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                let Some(current) = orchestrator.upgrade() else {
                    break;
                };
                if let Err(error) = current.refill_activation_admission_queue().await {
                    tracing::error!(event_code = "orchestrator.activation_admission.rescan_failed", %error, "Persistent Activation admission queue rescan failed; retaining queued state until the next wakeup");
                }
            }
        });
    }

    fn start_plan_reconciler(self: &Arc<Self>) {
        if self.plan_store.is_none() {
            return;
        }
        let orchestrator = Arc::downgrade(self);
        let wakeup = Arc::clone(&self.plan_reconcile_wakeup);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = wakeup.notified() => {}
                    _ = tokio::time::sleep(PLAN_RECONCILE_FALLBACK_INTERVAL) => {}
                }
                let Some(orchestrator) = orchestrator.upgrade() else {
                    break;
                };
                if let Err(error) = orchestrator.reconcile_durable_plans().await {
                    tracing::error!(
                        %error,
                        event_code = "orchestrator.plan_execution.recovery_cycle_failed",
                        "PlanExecution recovery cycle failed; retaining persistent state for the next retry"
                    );
                }
            }
        });
    }

    fn start_pending_signal_reconciler(self: &Arc<Self>) {
        let orchestrator = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(current) = orchestrator.upgrade() else {
                    break;
                };
                let Some(session_store) = current.context_engine.session_store() else {
                    drop(current);
                    tokio::time::sleep(PENDING_SIGNAL_RECONCILE_INTERVAL).await;
                    continue;
                };
                // Do not retain the Orchestrator while waiting. The Store
                // notification is only a latency hint; the bounded indexed
                // query below remains the durable recovery authority.
                drop(current);
                session_store
                    .wait_for_thread_signal_change(PENDING_SIGNAL_RECONCILE_INTERVAL)
                    .await;
                let Some(orchestrator) = orchestrator.upgrade() else {
                    break;
                };
                match orchestrator.reconcile_runnable_pending_thread_signals().await {
                    Ok(0) => {}
                    Ok(dispatched) => tracing::warn!(
                        dispatched,
                        event_code = "orchestrator.thread_signal.runtime_recovered",
                        "Recovered runnable Thread Signals whose immediate in-process dispatch did not materialize an Activation"
                    ),
                    Err(error) => tracing::error!(
                        %error,
                        event_code = "orchestrator.thread_signal.runtime_recovery_failed",
                        "Runnable Thread Signal recovery failed; retaining durable mailbox work for the next bounded retry"
                    ),
                }
            }
        });
    }

    fn start_action_group_reconciler(self: &Arc<Self>) {
        if self.action_groups.is_none() {
            return;
        }
        let orchestrator = Arc::downgrade(self);
        let wakeup = Arc::clone(&self.action_group_reconcile_wakeup);
        tokio::spawn(async move {
            let mut continue_full_scan = false;
            loop {
                let full_reconcile = if continue_full_scan {
                    // One recovery operation remains bounded, but a large
                    // durable backlog must not take 30 seconds per page.
                    // Yield between pages so normal Runtime work stays fair.
                    tokio::task::yield_now().await;
                    true
                } else {
                    tokio::select! {
                        _ = wakeup.notified() => false,
                        _ = tokio::time::sleep(ACTION_GROUP_RECONCILE_INTERVAL) => true,
                    }
                };
                let Some(orchestrator) = orchestrator.upgrade() else {
                    break;
                };
                let result = if full_reconcile {
                    orchestrator.recover_action_groups().await
                } else {
                    orchestrator.recover_dirty_action_groups().await
                };
                let reconcile_succeeded = result.is_ok();
                match result {
                    Ok(0) => {}
                    Ok(committed) => tracing::warn!(
                        committed_members = committed,
                        event_code = "orchestrator.action_group.runtime_recovered",
                        "Recovered Action Group members from immutable result Events without requiring a Runtime restart"
                    ),
                    Err(error) => tracing::error!(
                        %error,
                        event_code = "orchestrator.action_group.runtime_recovery_failed",
                        "Action Group convergence failed; durable result Events will be retried"
                    ),
                }
                continue_full_scan = reconcile_succeeded
                    && full_reconcile
                    && orchestrator
                        .action_group_reconcile_cursor
                        .lock()
                        .await
                        .is_some();
            }
        });
    }

    fn start_provider_delivery_reconciler(self: &Arc<Self>) {
        if self.plan_store.is_none() {
            return;
        }
        let orchestrator = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut retry_round = 0_u32;
            loop {
                let Some(current) = orchestrator.upgrade() else {
                    break;
                };
                let delay = if current.provider_delivery_retries.is_empty() {
                    PROVIDER_DELIVERY_IDLE_INTERVAL
                } else {
                    provider_delivery_retry_delay(retry_round)
                };
                let wakeup = Arc::clone(&current.provider_delivery_wakeup);
                drop(current);
                tokio::select! {
                    _ = wakeup.notified() => {}
                    _ = tokio::time::sleep(delay) => {}
                }
                let Some(current) = orchestrator.upgrade() else {
                    break;
                };
                let mut failed = false;
                for event in current
                    .provider_delivery_retries
                    .take_batch(PROVIDER_DELIVERY_BATCH)
                {
                    match current
                        .handle_thread_resource_available(event.clone())
                        .await
                    {
                        Ok(()) => current.provider_delivery_retries.acknowledge(&event.id),
                        Err(error) => {
                            failed = true;
                            tracing::warn!(
                                event_id = %event.id,
                                %error,
                                event_code = "orchestrator.provider_recovery.delivery_retry_deferred",
                                "Provider recovery Event delivery failed; retaining it for fair retry"
                            );
                            current.provider_delivery_retries.retry(event);
                        }
                    }
                }
                if current.provider_delivery_retries.is_empty() {
                    retry_round = 0;
                } else if failed {
                    retry_round = retry_round.saturating_add(1);
                } else {
                    // More than one bounded batch was ready. Continue at the
                    // base cadence rather than treating backlog as failure.
                    retry_round = 0;
                }
            }
        });
    }

    fn start_supervision_invariant_auditor(self: &Arc<Self>) {
        let orchestrator = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut previous_violations =
                HashMap::<String, Vec<SchedulerInvariantViolation>>::new();
            let mut previous_errors = HashMap::<String, String>::new();
            loop {
                tokio::time::sleep(SUPERVISION_RECONCILE_INTERVAL).await;
                let Some(orchestrator) = orchestrator.upgrade() else {
                    break;
                };
                let context_ids = orchestrator
                    .supervision_audit_dirty_contexts
                    .iter()
                    .map(|entry| entry.key().clone())
                    .collect::<Vec<_>>();
                for context_id in context_ids {
                    // Remove before the read. A mutation arriving during the
                    // audit inserts a fresh marker and therefore cannot be
                    // lost behind this cycle.
                    if orchestrator
                        .supervision_audit_dirty_contexts
                        .remove(&context_id)
                        .is_none()
                    {
                        continue;
                    }
                    match orchestrator
                        .audit_supervision_context(&context_id, false)
                        .await
                    {
                        Ok(violations) => {
                            if previous_errors.remove(&context_id).is_some() {
                                tracing::info!(
                                    context_id = %context_id,
                                    event_code = "orchestrator.thread_supervision.audit_recovered",
                                    "Thread Supervision invariant audit recovered"
                                );
                            }
                            let previous = previous_violations
                                .get(&context_id)
                                .cloned()
                                .unwrap_or_default();
                            if violations != previous {
                                if violations.is_empty() {
                                    if !previous.is_empty() {
                                        tracing::info!(
                                            context_id = %context_id,
                                            previous_invariant_violations = previous.len(),
                                            event_code =
                                                "orchestrator.thread_supervision.invariants_restored",
                                            "Thread Supervision invariants restored"
                                        );
                                    }
                                } else {
                                    tracing::warn!(
                                        context_id = %context_id,
                                        invariant_violations = violations.len(),
                                        previous_invariant_violations = previous.len(),
                                        event_code = "orchestrator.thread_supervision.invariant_violation_detected",
                                        "Thread Supervision detected invariant violations"
                                    );
                                }
                                if violations.is_empty() {
                                    previous_violations.remove(&context_id);
                                } else {
                                    previous_violations.insert(context_id.clone(), violations);
                                }
                            }
                        }
                        Err(error) => {
                            let error = error.to_string();
                            if previous_errors.get(&context_id) != Some(&error) {
                                tracing::error!(
                                    context_id = %context_id,
                                    %error,
                                    event_code = "orchestrator.thread_supervision.audit_failed",
                                    "Thread Supervision invariant audit failed; business facts remain unchanged until the next audit"
                                );
                                previous_errors.insert(context_id.clone(), error);
                            }
                            // A transient Store failure must not clear the causal
                            // invalidation; retry this Context next cycle.
                            orchestrator
                                .supervision_audit_dirty_contexts
                                .insert(context_id, ());
                        }
                    }
                }
            }
        });
    }

    /// Startup checks every live authority row, not every historical row.
    /// Terminal history is immutable after its Kernel transaction. A deep
    /// historical verification can advance a resumable offline checkpoint,
    /// but it must never block Runtime startup or make restart O(lifetime).
    async fn audit_active_supervision_invariants(
        &self,
    ) -> Result<Vec<SchedulerInvariantViolation>, DynError> {
        let Some(store) = self.plan_store.as_ref() else {
            return Ok(Vec::new());
        };
        let Some(kernel) = self.scheduler_kernel.as_ref() else {
            tracing::warn!(event_code = "orchestrator.scheduler_kernel.unavailable", "Scheduler Kernel is unavailable; skipping invariant quarantine for this cycle without writing directly to the Store");
            return Ok(Vec::new());
        };
        let mut all_violations = Vec::new();
        for context in store.list_contexts(false).await? {
            let objectives = store.list_context_objectives(&context.id, false).await?;
            let threads = store.list_context_threads(&context.id, false).await?;
            let activations = store
                .list_context_thread_activations(&context.id, false)
                .await?;
            let groups = store
                .list_thread_groups(ThreadGroupFilter {
                    context_id: Some(context.id.clone()),
                    include_terminal: false,
                    newest_first: false,
                    limit: None,
                    ..Default::default()
                })
                .await?;
            let group_ids = groups
                .iter()
                .map(|group| group.id.clone())
                .collect::<Vec<_>>();
            let mut grouped_members = Vec::new();
            for group_ids in group_ids.chunks(500) {
                grouped_members.extend(
                    store
                        .list_thread_group_members_for_groups(group_ids)
                        .await?,
                );
            }
            let members = grouped_members
                .iter()
                .map(|(_, member)| member.clone())
                .collect::<Vec<_>>();
            let mut thread_ids_by_entity = HashMap::new();
            for group in &groups {
                let group_members = grouped_members
                    .iter()
                    .filter(|(group_id, _)| group_id == &group.id)
                    .map(|(_, member)| member);
                thread_ids_by_entity.insert(
                    ("thread_group".to_string(), group.id.clone()),
                    group_members
                        .map(|member| member.thread_id.clone())
                        .collect(),
                );
            }
            let thread_by_root = threads
                .iter()
                .map(|thread| (thread.root_turn_id.as_str(), thread.id.clone()))
                .collect::<HashMap<_, _>>();
            for activation in &activations {
                if let Some(thread_id) = thread_by_root.get(activation.root_turn_id.as_str()) {
                    thread_ids_by_entity.insert(
                        ("activation".to_string(), activation.id.clone()),
                        vec![thread_id.clone()],
                    );
                }
            }
            let thread_ids = threads
                .iter()
                .map(|thread| thread.id.clone())
                .collect::<Vec<_>>();
            let mut outcomes = Vec::new();
            for thread_ids in thread_ids.chunks(500) {
                outcomes.extend(store.list_thread_outcomes(thread_ids).await?);
            }
            let objective_ids = objectives
                .iter()
                .map(|objective| objective.id.clone())
                .collect::<Vec<_>>();
            let mut dependencies = Vec::new();
            for objective_ids in objective_ids.chunks(500) {
                dependencies.extend(
                    store
                        .list_scheduler_dependencies_for_owners(
                            SchedulerDependencyOwnerKind::Objective,
                            objective_ids,
                        )
                        .await?,
                );
            }
            for thread_ids in thread_ids.chunks(500) {
                dependencies.extend(
                    store
                        .list_scheduler_dependencies_for_owners(
                            SchedulerDependencyOwnerKind::Thread,
                            thread_ids,
                        )
                        .await?,
                );
            }
            dependencies.sort_by(|left, right| left.id.cmp(&right.id));
            dependencies.dedup_by(|left, right| left.id == right.id);

            let candidate_barrier_event_ids = groups
                .iter()
                .filter_map(|group| group.barrier_event_id.as_ref())
                .cloned()
                .collect::<Vec<_>>();
            let barrier_event_ids = if candidate_barrier_event_ids.is_empty() {
                HashSet::new()
            } else {
                let mut existing = HashSet::new();
                for event_ids in candidate_barrier_event_ids.chunks(500) {
                    existing.extend(
                        self.store
                            .query(QueryFilter {
                                event_ids: event_ids.to_vec(),
                                ..Default::default()
                            })
                            .await?
                            .into_iter()
                            .map(|event| event.id),
                    );
                }
                existing
            };

            let mut violations = crate::scheduler::audit_scheduler_invariants(
                crate::scheduler::SchedulerInvariantInput {
                    objectives: &objectives,
                    threads: &threads,
                    activations: &activations,
                    outcomes: &outcomes,
                    groups: &groups,
                    group_members: &members,
                    dependencies: &dependencies,
                },
            );
            violations.extend(crate::recovery::SchedulerReconciler::audit_supervision(
                &objectives,
                &threads,
                &activations,
                &groups,
                &barrier_event_ids,
            ));
            let plan = crate::recovery::SchedulerReconciler::plan(
                &violations,
                &threads,
                &thread_ids_by_entity,
            );
            for action in plan.actions {
                let crate::recovery::ReconcilerAction::QuarantineThread { thread_id, reason } =
                    action;
                let Some(thread) = threads.iter().find(|thread| thread.id == thread_id) else {
                    continue;
                };
                let command = crate::controllers::DialogueController::control_thread(
                    thread,
                    &context.id,
                    ThreadControlAction::Pause,
                    reason.clone(),
                    "Runtime-Reconciler",
                );
                match kernel.execute(command).await {
                    Ok(crate::scheduler::KernelResult::ThreadControlled(
                        ThreadMutation::Updated(_),
                    )) => tracing::warn!(
                        thread_id = %thread.id,
                        reason = %reason,
                        event_code = "orchestrator.scheduler_reconciler.thread_quarantined",
                        "Scheduler Reconciler quarantined a Thread violating invariants without inferring a business terminal state"
                    ),
                    Ok(crate::scheduler::KernelResult::ThreadControlled(
                        ThreadMutation::Conflict { .. } | ThreadMutation::NotFound,
                    )) => {}
                    Ok(_) => unreachable!("ControlThread must return ThreadControlled"),
                    Err(error) => tracing::warn!(
                        thread_id = %thread.id,
                        %error,
                        event_code = "orchestrator.scheduler_reconciler.quarantine_failed",
                        "Scheduler Reconciler quarantine command failed; retaining authoritative state for the next cycle"
                    ),
                }
            }
            all_violations.extend(violations);
        }
        all_violations.sort();
        Ok(all_violations)
    }

    /// Audit only live scheduler authority for one Context, plus exact parent
    /// rows required to validate those live records. Historical terminal rows
    /// are immutable after their Kernel transaction; repeatedly deserializing
    /// them cannot make an idle Runtime safer.
    async fn audit_supervision_context(
        &self,
        context_id: &str,
        include_terminal: bool,
    ) -> Result<Vec<SchedulerInvariantViolation>, DynError> {
        let Some(store) = self.plan_store.as_ref() else {
            return Ok(Vec::new());
        };
        let Some(kernel) = self.scheduler_kernel.as_ref() else {
            tracing::warn!(event_code = "orchestrator.scheduler_kernel.unavailable", "Scheduler Kernel is unavailable; skipping invariant quarantine for this cycle without writing directly to the Store");
            return Ok(Vec::new());
        };

        let mut objectives = store
            .list_context_objectives(context_id, include_terminal)
            .await?;
        let mut threads = store
            .list_context_threads(context_id, include_terminal)
            .await?;
        let mut activations = store
            .list_context_thread_activations(context_id, include_terminal)
            .await?;
        let mut groups = store
            .list_thread_groups(ThreadGroupFilter {
                context_id: Some(context_id.to_string()),
                include_terminal,
                newest_first: false,
                limit: None,
                ..Default::default()
            })
            .await?;

        let objective_ids = objectives
            .iter()
            .map(|objective| objective.id.clone())
            .collect::<Vec<_>>();
        let thread_ids = threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let mut dependencies = Vec::new();
        for objective_ids in objective_ids.chunks(500) {
            dependencies.extend(
                store
                    .list_scheduler_dependencies_for_owners(
                        SchedulerDependencyOwnerKind::Objective,
                        objective_ids,
                    )
                    .await?,
            );
        }
        for thread_ids in thread_ids.chunks(500) {
            dependencies.extend(
                store
                    .list_scheduler_dependencies_for_owners(
                        SchedulerDependencyOwnerKind::Thread,
                        thread_ids,
                    )
                    .await?,
            );
        }
        dependencies.sort_by(|left, right| left.id.cmp(&right.id));
        dependencies.dedup_by(|left, right| left.id == right.id);

        // A live Activation can expose the exact terminal Thread invariant
        // without requiring every unrelated terminal Thread in the Context.
        let missing_activation_roots = activations
            .iter()
            .map(|activation| activation.root_turn_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .filter(|root_turn_id| {
                !threads
                    .iter()
                    .any(|thread| thread.root_turn_id == *root_turn_id)
            })
            .collect::<Vec<_>>();
        threads.extend(
            store
                .list_threads_by_roots(context_id, &missing_activation_roots)
                .await?,
        );

        // A pending dependency targeting a newly terminal Group is an online
        // violation. Retrieve that exact Group rather than all closed Groups.
        let dependency_group_ids = dependencies
            .iter()
            .filter(|dependency| {
                dependency.status == SchedulerDependencyStatus::Pending
                    && dependency.dependency_kind == SchedulerDependencyKind::ThreadGroup
            })
            .map(|dependency| dependency.dependency_id.clone())
            .filter(|group_id| !groups.iter().any(|group| group.id == *group_id))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !dependency_group_ids.is_empty() {
            for group_ids in dependency_group_ids.chunks(500) {
                groups.extend(
                    store
                        .list_thread_groups_by_ids(context_id, group_ids)
                        .await?,
                );
            }
        }

        // Open Groups may be owned by an exact terminal/missing authority.
        // Include existing owners so the pure audit can distinguish a valid
        // live generation from an orphan without a Context-wide history scan.
        let known_thread_ids = threads
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<HashSet<_>>();
        let known_activation_ids = activations
            .iter()
            .map(|activation| activation.id.as_str())
            .collect::<HashSet<_>>();
        let known_objective_ids = objectives
            .iter()
            .map(|objective| objective.id.as_str())
            .collect::<HashSet<_>>();
        let missing_supervisor_threads = groups
            .iter()
            .filter(|group| group.supervisor_kind == ThreadSupervisorKind::Thread)
            .map(|group| group.supervisor_id.clone())
            .filter(|id| !known_thread_ids.contains(id.as_str()))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let missing_supervisor_activations = groups
            .iter()
            .filter(|group| group.supervisor_kind == ThreadSupervisorKind::Evaluation)
            .map(|group| group.supervisor_id.clone())
            .filter(|id| !known_activation_ids.contains(id.as_str()))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let missing_supervisor_objectives = groups
            .iter()
            .filter(|group| group.supervisor_kind == ThreadSupervisorKind::Objective)
            .map(|group| group.supervisor_id.clone())
            .filter(|id| !known_objective_ids.contains(id.as_str()))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        drop((known_thread_ids, known_activation_ids, known_objective_ids));
        threads.extend(
            store
                .list_threads_by_ids(context_id, &missing_supervisor_threads)
                .await?,
        );
        activations.extend(
            store
                .list_thread_activations_by_ids(context_id, &missing_supervisor_activations)
                .await?,
        );
        objectives.extend(
            store
                .list_objectives_by_ids(context_id, &missing_supervisor_objectives)
                .await?,
        );

        let group_ids = groups
            .iter()
            .map(|group| group.id.clone())
            .collect::<Vec<_>>();
        let mut grouped_members = Vec::new();
        for group_ids in group_ids.chunks(500) {
            grouped_members.extend(
                store
                    .list_thread_group_members_for_groups(group_ids)
                    .await?,
            );
        }
        let members = grouped_members
            .iter()
            .map(|(_, member)| member.clone())
            .collect::<Vec<_>>();
        let known_thread_ids = threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<HashSet<_>>();
        let missing_member_thread_ids = members
            .iter()
            .map(|member| member.thread_id.clone())
            .filter(|thread_id| !known_thread_ids.contains(thread_id))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        threads.extend(
            store
                .list_threads_by_ids(context_id, &missing_member_thread_ids)
                .await?,
        );
        let mut thread_ids_by_entity = HashMap::new();
        for group in &groups {
            let group_members = grouped_members
                .iter()
                .filter(|(group_id, _)| group_id == &group.id)
                .map(|(_, member)| member)
                .collect::<Vec<_>>();
            thread_ids_by_entity.insert(
                ("thread_group".to_string(), group.id.clone()),
                group_members
                    .iter()
                    .map(|member| member.thread_id.clone())
                    .collect(),
            );
        }

        let thread_by_root = threads
            .iter()
            .map(|thread| (thread.root_turn_id.as_str(), thread.id.clone()))
            .collect::<HashMap<_, _>>();
        for activation in &activations {
            if let Some(thread_id) = thread_by_root.get(activation.root_turn_id.as_str()) {
                thread_ids_by_entity.insert(
                    ("activation".to_string(), activation.id.clone()),
                    vec![thread_id.clone()],
                );
            }
        }

        let outcome_thread_ids = threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let mut outcomes = Vec::new();
        for thread_ids in outcome_thread_ids.chunks(500) {
            outcomes.extend(store.list_thread_outcomes(thread_ids).await?);
        }
        let candidate_barrier_event_ids = groups
            .iter()
            .filter_map(|group| group.barrier_event_id.as_ref())
            .cloned()
            .collect::<Vec<_>>();
        let barrier_event_ids = if candidate_barrier_event_ids.is_empty() {
            HashSet::new()
        } else {
            let mut existing = HashSet::new();
            for event_ids in candidate_barrier_event_ids.chunks(500) {
                existing.extend(
                    self.store
                        .query(QueryFilter {
                            event_ids: event_ids.to_vec(),
                            ..Default::default()
                        })
                        .await?
                        .into_iter()
                        .map(|event| event.id),
                );
            }
            existing
        };

        let mut violations = crate::scheduler::audit_scheduler_invariants(
            crate::scheduler::SchedulerInvariantInput {
                objectives: &objectives,
                threads: &threads,
                activations: &activations,
                outcomes: &outcomes,
                groups: &groups,
                group_members: &members,
                dependencies: &dependencies,
            },
        );
        violations.extend(crate::recovery::SchedulerReconciler::audit_supervision(
            &objectives,
            &threads,
            &activations,
            &groups,
            &barrier_event_ids,
        ));
        let plan = crate::recovery::SchedulerReconciler::plan(
            &violations,
            &threads,
            &thread_ids_by_entity,
        );
        for action in plan.actions {
            let crate::recovery::ReconcilerAction::QuarantineThread { thread_id, reason } = action;
            let Some(thread) = threads.iter().find(|thread| thread.id == thread_id) else {
                continue;
            };
            let command = crate::controllers::DialogueController::control_thread(
                thread,
                context_id,
                ThreadControlAction::Pause,
                reason.clone(),
                "Runtime-Reconciler",
            );
            match kernel.execute(command).await {
                Ok(crate::scheduler::KernelResult::ThreadControlled(ThreadMutation::Updated(
                    _,
                ))) => tracing::warn!(
                    thread_id = %thread.id,
                    reason = %reason,
                    event_code = "orchestrator.scheduler_reconciler.thread_quarantined",
                    "Scheduler Reconciler quarantined a Thread violating invariants without inferring a business terminal state"
                ),
                Ok(crate::scheduler::KernelResult::ThreadControlled(
                    ThreadMutation::Conflict { .. } | ThreadMutation::NotFound,
                )) => {}
                Ok(_) => unreachable!("ControlThread must return ThreadControlled"),
                Err(error) => tracing::warn!(
                    thread_id = %thread.id,
                    %error,
                    event_code = "orchestrator.scheduler_reconciler.quarantine_failed",
                    "Scheduler Reconciler quarantine command failed; retaining authoritative state for the next cycle"
                ),
            }
        }
        violations.sort();
        Ok(violations)
    }

    async fn reconcile_durable_plans(&self) -> Result<(), DynError> {
        let Some(store) = self.plan_store.as_ref() else {
            return Ok(());
        };
        let coordinator =
            PlanExecutionCoordinator::new(Arc::clone(store), Arc::clone(&self.registry));
        let recovered = coordinator
            .recover_expired_running(None, PLAN_RECONCILE_BATCH)
            .await?;
        let job_cursor = self.plan_job_reconcile_cursor.lock().await.clone();
        let jobs = coordinator
            .reconcile_waiting_execution_jobs_page(
                None,
                job_cursor.as_ref().map(|(updated_at, _)| *updated_at),
                job_cursor.as_ref().map(|(_, id)| id.clone()),
                PLAN_RECONCILE_BATCH,
            )
            .await?;
        let evaluation_cursor = self.plan_evaluation_reconcile_cursor.lock().await.clone();
        let evaluations = coordinator
            .reconcile_waiting_evaluations_page(
                None,
                evaluation_cursor
                    .as_ref()
                    .map(|(updated_at, _)| *updated_at),
                evaluation_cursor.as_ref().map(|(_, id)| id.clone()),
                PLAN_RECONCILE_BATCH,
            )
            .await?;
        let more_jobs = jobs.scanned == PLAN_RECONCILE_BATCH;
        let more_evaluations = evaluations.scanned == PLAN_RECONCILE_BATCH;
        *self.plan_job_reconcile_cursor.lock().await =
            more_jobs.then_some(jobs.next_cursor.clone()).flatten();
        *self.plan_evaluation_reconcile_cursor.lock().await = more_evaluations
            .then_some(evaluations.next_cursor.clone())
            .flatten();
        if more_jobs || more_evaluations {
            // The next page must not wait for the 30-second cross-process
            // fallback. Notify retains one permit even during startup before
            // the reconciler task begins.
            self.plan_reconcile_wakeup.notify_one();
        }
        if !recovered.is_empty()
            || !jobs.resumed.is_empty()
            || !evaluations.resumed.is_empty()
            || !jobs.conflicts.is_empty()
            || !evaluations.conflicts.is_empty()
        {
            tracing::info!(
                expired_running_requeued = recovered.len(),
                execution_jobs_resumed = jobs.resumed.len(),
                evaluations_resumed = evaluations.resumed.len(),
                conflicts = jobs.conflicts.len() + evaluations.conflicts.len(),
                event_code = "orchestrator.plan_execution.recovery_cycle_completed",
                "PlanExecution recovery cycle completed"
            );
        }
        Ok(())
    }

    /// One-shot compatibility migration for rows produced by Runtime builds
    /// predating direct ThreadSignal commits.  No steady-state producer or
    /// poller is allowed to depend on this table.
    async fn migrate_legacy_signal_outbox_once(&self) -> Result<usize, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Signal Outbox dispatcher 需要持久化 SessionStore")?;
        let mut dispatched = 0usize;
        let mut cursor: Option<(chrono::DateTime<Utc>, String)> = None;
        loop {
            let pending = session_store
                .list_signal_outbox_page(
                    SignalOutboxStatus::Pending,
                    cursor.as_ref().map(|(created_at, _)| *created_at),
                    cursor.as_ref().map(|(_, event_id)| event_id.clone()),
                    SIGNAL_OUTBOX_DISPATCH_BATCH,
                )
                .await?;
            if pending.is_empty() {
                break;
            }
            cursor = pending
                .last()
                .map(|entry| (entry.created_at, entry.event_id.clone()));
            for entry in pending {
                let Some(event) = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(entry.event_id.clone()),
                        ..Default::default()
                    })
                    .await?
                    .into_iter()
                    .find(|event| event.id == entry.event_id)
                else {
                    return Err(format!("Signal Outbox Event '{}' 未持久化", entry.event_id).into());
                };
                let routable = event
                    .payload
                    .get("context_id")
                    .and_then(|value| value.as_str())
                    .is_some()
                    && event
                        .payload
                        .get("session_id")
                        .and_then(|value| value.as_str())
                        .is_some();
                if !routable || self.is_legacy_internal_plan_output(&event).await? {
                    // Older Runtime builds could enqueue Plan-internal tool
                    // outputs as ordinary chat wakeups. They remain observable
                    // persisted Event facts, but routing them back through the parent
                    // Thread gate can deadlock the Plan that owns them. Discard
                    // only the invalid Outbox entry; real Plan infer requests
                    // remain routable child-evaluation inputs.
                    tracing::warn!(
                        event_id = %event.id,
                        event_type = %event.event_type,
                        topic = %event.topic,
                        event_code = "orchestrator.signal_outbox.unroutable_legacy_entry_dropped",
                        "One-time migration dropped an unroutable legacy Signal Outbox entry while preserving the Event"
                    );
                    session_store.discard_signal_outbox(&event.id).await?;
                    continue;
                }
                match event
                    .payload
                    .get("wake_policy")
                    .and_then(|value| value.as_str())
                {
                    Some("none") => {
                        // The Event is an immutable result fact only. Older
                        // writers could still enqueue it in the generic
                        // bridge, but replaying it as a wake violates its
                        // explicit routing contract.
                        session_store.discard_signal_outbox(&event.id).await?;
                        continue;
                    }
                    Some("direct_signal") => {
                        // Modern terminal handoffs atomically persist their
                        // direct Thread Signal or supervisor readiness. Replay
                        // the process-local notification, then retire the
                        // obsolete legacy bridge row; no handler is expected
                        // to materialize that row.
                        self.bus.dispatch_persisted(event.clone()).await?;
                        session_store.discard_signal_outbox(&event.id).await?;
                        dispatched = dispatched.saturating_add(1);
                        continue;
                    }
                    _ => {}
                }
                self.bus.dispatch_persisted(event).await?;
                dispatched = dispatched.saturating_add(1);
            }
            // EventBus business handlers intentionally run asynchronously.
            // Keyset pagination, rather than immediate status observation,
            // guarantees this one-shot migration reaches every legacy row
            // without re-dispatching a slow first page or requiring handler
            // completion during Runtime startup.
            tokio::task::yield_now().await;
        }
        Ok(dispatched)
    }

    /// Recognizes internal Plan tool outputs written by builds predating the
    /// explicit `plan_execution_id`/`wake_policy:none` contract. Those builds
    /// could leave the output in Signal Outbox while the owning Plan was still
    /// waiting on that exact deterministic call, creating a circular wait at
    /// the parent Thread gate after restart.
    async fn is_legacy_internal_plan_output(&self, event: &Event) -> Result<bool, DynError> {
        if event.event_type != TYPE_TOOL_OUTPUT || self.plan_store.is_none() {
            return Ok(false);
        }
        if event
            .payload
            .get("plan_execution_id")
            .and_then(|value| value.as_str())
            .is_some()
        {
            return Ok(true);
        }
        let Some(tool_call_id) = event
            .payload
            .get("tool_call_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(false);
        };
        let Some(activation_id) = event
            .payload
            .get("activation_id")
            .or_else(|| event.payload.get("attempt_id"))
            .and_then(|value| value.as_str())
        else {
            return Ok(false);
        };
        let plans = self
            .plan_store
            .as_ref()
            .expect("checked above")
            .list_plan_executions(PlanExecutionFilter {
                activation_id: Some(activation_id.to_string()),
                // A Plan may already be terminal while one of its old
                // internal outputs is still stranded in Signal Outbox.
                // Stable effect IDs make including terminal history safe.
                include_terminal: true,
                limit: Some(PLAN_RECONCILE_BATCH),
                ..Default::default()
            })
            .await?;
        for plan in plans {
            let Ok(machine) =
                serde_json::from_value::<crate::sexpr_eval::PlanMachine>(plan.state_json.clone())
            else {
                continue;
            };
            let Some(sequence) = legacy_plan_effect_sequence(
                tool_call_id,
                &plan.id,
                machine.effect_sequence_recovery_ceiling(),
            )?
            else {
                continue;
            };
            tracing::warn!(
                event_id = %event.id,
                plan_execution_id = %plan.id,
                plan_effect_sequence = sequence,
                tool_call_id,
                event_code = "orchestrator.signal_outbox.legacy_plan_output_dropped",
                "Detected and dropped legacy Plan-internal tool output that entered the Signal Outbox"
            );
            return Ok(true);
        }
        Ok(false)
    }

    async fn recover_pending_thread_signals(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        for context in session_store.list_contexts(false).await? {
            let mut dispatched_threads = HashSet::new();
            let signals = session_store
                .list_context_thread_signals(
                    &context.id,
                    Some(crate::memory::ThreadSignalStatus::Pending),
                )
                .await?
                .into_iter()
                .filter(|signal| dispatched_threads.insert(signal.thread_id.clone()))
                .collect::<Vec<_>>();
            let event_ids = signals
                .iter()
                .map(|signal| signal.event_id.clone())
                .collect::<Vec<_>>();
            let mut events_by_id = HashMap::new();
            for event_ids in event_ids.chunks(500) {
                for event in self
                    .store
                    .query(QueryFilter {
                        event_ids: event_ids.to_vec(),
                        context_id: Some(context.id.clone()),
                        ..Default::default()
                    })
                    .await?
                {
                    events_by_id.insert(event.id.clone(), event);
                }
            }
            for signal in signals {
                let Some(event) = events_by_id.remove(&signal.event_id) else {
                    tracing::error!(
                        signal_id = %signal.id,
                        event_id = %signal.event_id,
                        event_code = "orchestrator.thread_signal.recovery_event_missing",
                        "Cannot recover pending Thread Signal because its Event was not persisted"
                    );
                    continue;
                };
                self.bus.dispatch_persisted(event).await?;
            }
        }
        Ok(())
    }

    async fn recover_action_groups(&self) -> Result<usize, DynError> {
        let Some(groups) = self.action_groups.as_ref() else {
            return Ok(0);
        };
        let cursor = self.action_group_reconcile_cursor.lock().await.clone();
        let running = groups
            .list_action_groups(ActionGroupFilter {
                include_terminal: false,
                newest_first: false,
                after_created_at: cursor.as_ref().map(|(created_at, _)| *created_at),
                after_id: cursor.as_ref().map(|(_, id)| id.clone()),
                limit: Some(ACTION_GROUP_RECONCILE_PAGE),
                ..Default::default()
            })
            .await?;
        if running.is_empty() {
            *self.action_group_reconcile_cursor.lock().await = None;
            return Ok(0);
        }

        let next_cursor = running
            .last()
            .map(|group| (group.created_at, group.id.clone()));
        *self.action_group_reconcile_cursor.lock().await = (running.len()
            == ACTION_GROUP_RECONCILE_PAGE)
            .then_some(next_cursor)
            .flatten();

        let group_ids = running
            .iter()
            .map(|group| group.id.clone())
            .collect::<Vec<_>>();
        let members = groups
            .list_action_group_members_for_groups(&group_ids)
            .await?;
        let mut members_by_group = HashMap::<String, Vec<ActionGroupMemberRecord>>::new();
        for member in members {
            members_by_group
                .entry(member.group_id.clone())
                .or_default()
                .push(member);
        }

        let mut evidence_ids = running
            .iter()
            .filter_map(|group| {
                group
                    .assistant_call_event_id
                    .strip_prefix("call_")
                    .map(|attempt_id| format!("tool_calls_selected_{attempt_id}"))
            })
            .collect::<Vec<_>>();
        for group in &running {
            if let Some(members) = members_by_group.get(&group.id) {
                evidence_ids.extend(
                    members
                        .iter()
                        .filter(|member| !member.status.is_terminal())
                        .map(|member| {
                            format!("output_{}_{}", group.activation_id, member.tool_call_id)
                        }),
                );
            }
        }
        evidence_ids.sort();
        evidence_ids.dedup();
        let mut evidence_by_id = HashMap::new();
        for event_ids in evidence_ids.chunks(500) {
            for event in self
                .store
                .query(QueryFilter {
                    event_ids: event_ids.to_vec(),
                    ..Default::default()
                })
                .await?
            {
                evidence_by_id.insert(event.id.clone(), event);
            }
        }

        let mut committed = 0usize;
        for group in running {
            let members = members_by_group.remove(&group.id).unwrap_or_default();
            match recover_action_group_from_prefetched_events(
                &group,
                groups.as_ref(),
                &members,
                &evidence_by_id,
            )
            .await
            {
                Ok(recovered) => committed = committed.saturating_add(recovered),
                Err(error) => tracing::error!(
                    action_group_id = %group.id,
                    %error,
                    event_code = "orchestrator.action_group.recovery_item_failed",
                    "One Action Group could not converge; continuing with independent Groups"
                ),
            }
        }
        Ok(committed)
    }

    async fn recover_dirty_action_groups(&self) -> Result<usize, DynError> {
        let Some(groups) = self.action_groups.as_ref() else {
            return Ok(0);
        };
        let group_ids = self
            .action_group_reconcile_dirty
            .iter()
            .take(ACTION_GROUP_RECONCILE_DIRTY_BATCH)
            .map(|entry| entry.key().clone())
            .collect::<Vec<_>>();
        let mut committed = 0usize;
        for group_id in group_ids {
            if self
                .action_group_reconcile_dirty
                .remove(&group_id)
                .is_none()
            {
                continue;
            }
            let group = match groups.get_action_group(&group_id).await {
                Ok(Some(group)) if !group.status.is_terminal() => group,
                Ok(_) => continue,
                Err(error) => {
                    self.action_group_reconcile_dirty
                        .insert(group_id.clone(), ());
                    tracing::error!(
                        action_group_id = %group_id,
                        %error,
                        event_code = "orchestrator.action_group.dirty_read_failed",
                        "Could not read a dirty Action Group; retaining it for retry"
                    );
                    continue;
                }
            };
            match recover_action_group_from_durable_events(
                self.context_engine.as_ref(),
                &group,
                groups.as_ref(),
            )
            .await
            {
                Ok(recovered) => committed = committed.saturating_add(recovered),
                Err(error) => {
                    self.action_group_reconcile_dirty
                        .insert(group_id.clone(), ());
                    tracing::error!(
                        action_group_id = %group_id,
                        %error,
                        event_code = "orchestrator.action_group.dirty_recovery_failed",
                        "One dirty Action Group could not converge; retaining it for retry"
                    );
                }
            }
        }
        if !self.action_group_reconcile_dirty.is_empty() {
            self.action_group_reconcile_wakeup.notify_one();
        }
        Ok(committed)
    }

    pub(crate) async fn reconcile_runnable_pending_thread_signals(
        &self,
    ) -> Result<usize, DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(0);
        };
        let mut selected_threads = HashSet::new();
        let signals = session_store
            .list_runnable_pending_thread_signals(PENDING_SIGNAL_RECONCILE_BATCH)
            .await?
            .into_iter()
            .filter(|signal| selected_threads.insert(signal.thread_id.clone()))
            .collect::<Vec<_>>();
        if signals.is_empty() {
            return Ok(0);
        }
        let event_ids = signals
            .iter()
            .map(|signal| signal.event_id.clone())
            .collect::<Vec<_>>();
        let mut events_by_id = HashMap::new();
        for event_ids in event_ids.chunks(500) {
            for event in self
                .store
                .query(QueryFilter {
                    event_ids: event_ids.to_vec(),
                    ..Default::default()
                })
                .await?
            {
                events_by_id.insert(event.id.clone(), event);
            }
        }
        let mut dispatched = 0usize;
        for signal in signals {
            let Some(event) = events_by_id.remove(&signal.event_id) else {
                tracing::error!(
                    signal_id = %signal.id,
                    event_id = %signal.event_id,
                    event_code = "orchestrator.thread_signal.runtime_recovery_event_missing",
                    "Cannot recover runnable Thread Signal because its Event was not persisted"
                );
                continue;
            };
            self.bus.dispatch_persisted(event).await?;
            dispatched = dispatched.saturating_add(1);
        }
        Ok(dispatched)
    }

    async fn rebuild_activation_admission_queue(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let limit = self.activation_admission.limits().max_queued;
        let aging_ms = self
            .activation_admission
            .limits()
            .aging_promotion_interval_ms;
        let reserved_queue_slots = self
            .activation_admission
            .limits()
            .dialogue_delivery_queue_slots;
        for (activation, class) in session_store
            .list_queued_thread_activations_for_admission(limit, reserved_queue_slots, aging_ms)
            .await?
        {
            let outcome = self
                .activation_admission
                .restore_queued(activation_admission_key_for_class(&activation, class))?;
            if outcome == RestoreQueuedOutcome::DeferredWindowFull {
                tracing::debug!(
                    activation_id = %activation.id,
                    event_code = "orchestrator.activation.queued_waiting_for_admission",
                    "Activation remains queued in SQLite while waiting for bounded in-memory admission"
                );
            }
        }
        Ok(())
    }

    /// Fill newly available in-memory scheduling positions from SQLite.  Only
    /// rows actually entering the window are re-dispatched; overflow remains a
    /// durable queued fact and never becomes a synthetic failure reply.
    async fn refill_activation_admission_queue(&self) -> Result<usize, DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(0);
        };
        let mut dispatched = 0usize;
        let limit = self.activation_admission.limits().max_queued;
        let aging_ms = self
            .activation_admission
            .limits()
            .aging_promotion_interval_ms;
        let reserved_queue_slots = self
            .activation_admission
            .limits()
            .dialogue_delivery_queue_slots;
        for (activation, class) in session_store
            .list_queued_thread_activations_for_admission(limit, reserved_queue_slots, aging_ms)
            .await?
        {
            if self.activation_admission.contains(&activation.id) {
                continue;
            }
            let Some(trigger) = self
                .store
                .query(QueryFilter {
                    event_id: Some(activation.trigger_event_id.clone()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .find(|event| event.id == activation.trigger_event_id)
            else {
                tracing::error!(
                    activation_id = %activation.id,
                    trigger_event_id = %activation.trigger_event_id,
                    event_code = "orchestrator.activation.rescan_trigger_missing",
                    "Cannot rescan queued Activation because its Trigger Event was not persisted"
                );
                continue;
            };
            match self
                .activation_admission
                .restore_queued(activation_admission_key_for_class(&activation, class))?
            {
                RestoreQueuedOutcome::Restored => {
                    self.bus.dispatch_persisted(trigger).await?;
                    dispatched = dispatched.saturating_add(1);
                }
                RestoreQueuedOutcome::AlreadyTracked | RestoreQueuedOutcome::DeferredWindowFull => {
                }
            }
        }
        Ok(dispatched)
    }

    async fn recover_thread_activations(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        for context in session_store.list_contexts(false).await? {
            let activations = session_store
                .list_context_thread_activations(&context.id, false)
                .await?;
            if activations.is_empty() {
                continue;
            }
            let mut event_ids = Vec::with_capacity(activations.len().saturating_mul(2));
            for activation in &activations {
                event_ids.push(activation.trigger_event_id.clone());
                event_ids.push(format!("call_{}", activation.id));
            }
            event_ids.sort();
            event_ids.dedup();
            let mut events = Vec::new();
            // Keep recovery proportional to live Activations while respecting
            // SQLite/PostgreSQL bind limits for a large active fleet.
            for event_ids in event_ids.chunks(500) {
                events.extend(
                    self.store
                        .query(QueryFilter {
                            event_ids: event_ids.to_vec(),
                            context_id: Some(context.id.clone()),
                            ..Default::default()
                        })
                        .await?,
                );
            }
            let events = events
                .into_iter()
                .map(|event| (event.id.clone(), event))
                .collect::<HashMap<_, _>>();
            for activation in activations {
                let Some(trigger) = events.get(&activation.trigger_event_id).cloned() else {
                    tracing::error!(
                        activation_id = %activation.id,
                        trigger_event_id = %activation.trigger_event_id,
                        event_code = "orchestrator.activation.recovery_trigger_missing",
                        "Cannot recover Thread Activation because its Trigger Event was not persisted"
                    );
                    continue;
                };
                let recovery_owns_activation = recovery_owns_activation(
                    self.context_engine.worker_coordination_mode(),
                    &activation,
                    Utc::now(),
                );
                // A model request has no external side effect before an
                // Assistant decision is durably recorded. Therefore a queued
                // or lease-expired DialogueTurn is safe to resume after a
                // Runtime restart; cancelling it forced users to resend and
                // could race with delayed lease recovery into duplicate work.
                // A persisted assistant decision is a durable recovery
                // boundary. A running Activation may also have compiled its
                // trigger into Context and entered model streaming without
                // reaching that boundary. In both cases the original trigger
                // can look "covered" by a later Context snapshot; force this
                // one process-local redispatch so recovery either resumes the
                // exact persisted decision or finishes the interrupted model
                // continuation. dispatch_persisted never appends a new Event.
                let mut trigger = trigger;
                if events.contains_key(&format!("call_{}", activation.id))
                    || (recovery_owns_activation
                        && activation.status == ThreadActivationStatus::Running)
                {
                    trigger
                        .payload
                        .insert("runtime_force_evaluation".to_string(), json!(true));
                    trigger.payload.insert(
                        "runtime_recovery_activation_id".to_string(),
                        json!(&activation.id),
                    );
                }
                match activation.status {
                    ThreadActivationStatus::Queued => {
                        if self.activation_admission.contains(&activation.id) {
                            self.bus.dispatch_persisted(trigger).await?;
                        }
                    }
                    ThreadActivationStatus::Running => {
                        if recovery_owns_activation {
                            tracing::warn!(
                                activation_id = %activation.id,
                                claimed_by = ?activation.claimed_by,
                                event_code = "orchestrator.activation.recovered_from_exited_runtime",
                                "Recovering a Thread Activation held by an exited Runtime"
                            );
                            match self
                                .transition_thread_activation(
                                    &activation,
                                    ThreadActivationStatus::Queued,
                                    None,
                                    None,
                                    None,
                                    &activation.trigger_event_id,
                                    "Runtime-Recovery",
                                )
                                .await?
                            {
                                ThreadActivationMutation::Updated(queued) => {
                                    self.cancel_activation_lease(&activation.id).await?;
                                    if self.activation_admission.restore_queued(
                                        activation_admission_key(&queued, &trigger),
                                    )? == RestoreQueuedOutcome::Restored
                                    {
                                        self.bus.dispatch_persisted(trigger).await?;
                                    }
                                }
                                ThreadActivationMutation::Conflict { .. }
                                | ThreadActivationMutation::NotFound => {}
                            }
                            continue;
                        }
                        self.arm_activation_lease(&activation).await?;
                    }
                    ThreadActivationStatus::Succeeded
                    | ThreadActivationStatus::Cancelled
                    | ThreadActivationStatus::Failed => {}
                }
            }
        }
        Ok(())
    }

    /// Close active Thread rows that cannot possibly make progress after a
    /// restart. Waiting Threads are excluded because a background result,
    /// dependency, timer, delegation or Objective supervisor may still own
    /// their next wake. A pending direct Signal is itself authoritative
    /// runnable state: the process may have crashed after committing the
    /// mailbox fact but before creating its Activation, so such a Thread must
    /// survive orphan reconciliation. Objective-supervised primary Execution
    /// Threads are reconciled
    /// against the Objective's one authoritative active Evaluation so old
    /// evaluations do not remain visible as parallel Objective supervisors
    /// after restart.
    async fn reconcile_orphaned_threads(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let scheduled_threads = session_store
            .list_schedules(None, Some(crate::memory::ScheduleStatus::Queued))
            .await?
            .into_iter()
            .map(|intent| intent.thread_id)
            .collect::<HashSet<_>>();
        let pending_dependency_threads = if let Some(store) = self.plan_store.as_ref() {
            store
                .list_scheduler_dependencies(SchedulerDependencyFilter {
                    owner_kind: Some(SchedulerDependencyOwnerKind::Thread),
                    status: Some(SchedulerDependencyStatus::Pending),
                    required_only: true,
                    ..Default::default()
                })
                .await?
                .into_iter()
                .map(|dependency| dependency.owner_id)
                .collect::<HashSet<_>>()
        } else {
            HashSet::new()
        };
        let active_execution_job_threads = if let Some(manager) = self.execution_jobs.as_ref() {
            manager
                .store()
                .list_execution_jobs(ExecutionJobFilter {
                    include_terminal: false,
                    ..ExecutionJobFilter::default()
                })
                .await?
                .into_iter()
                .map(|job| job.thread_id)
                .collect::<HashSet<_>>()
        } else {
            HashSet::new()
        };
        for context in session_store.list_contexts(false).await? {
            let pending_signal_threads = session_store
                .list_context_thread_signals(
                    &context.id,
                    Some(crate::memory::ThreadSignalStatus::Pending),
                )
                .await?
                .into_iter()
                .map(|signal| signal.thread_id)
                .collect::<HashSet<_>>();
            let activations = session_store
                .list_context_thread_activations(&context.id, false)
                .await?;
            let active_roots = activations
                .iter()
                .map(|item| item.root_turn_id.clone())
                .collect::<HashSet<_>>();
            let threads = session_store
                .list_context_threads(&context.id, false)
                .await?;
            for thread in threads {
                if thread.lifecycle != ThreadLifecycle::Open
                    || active_roots.contains(&thread.root_turn_id)
                    || scheduled_threads.contains(&thread.id)
                    || pending_signal_threads.contains(&thread.id)
                    || pending_dependency_threads.contains(&thread.id)
                    || active_execution_job_threads.contains(&thread.id)
                {
                    continue;
                }
                if thread.kind == ThreadKind::Execution
                    && thread.supervision.supervisor_kind
                        == crate::memory::ThreadSupervisorKind::Objective
                    && thread.supervision.origin_evaluation_id.is_none()
                {
                    let objective = if let (Some(supervisor), Some(objective_id)) = (
                        self.objective_supervisor.as_ref(),
                        thread.supervision.supervisor_id.as_deref(),
                    ) {
                        supervisor.get(objective_id).await?
                    } else {
                        None
                    };
                    if objective_supervision_matches_state(&thread.supervision, objective.as_ref())
                    {
                        continue;
                    }
                }
                let reason = "Runtime 重启时检测到 active Thread 没有非终态 Thread Activation、待执行调度或已提交终态；已将遗留孤儿状态标记为 cancelled。";
                let mutation = if let Some(kernel) = self.scheduler_kernel.as_ref() {
                    match kernel
                        .execute(crate::controllers::DialogueController::control_thread(
                            &thread,
                            &context.id,
                            ThreadControlAction::Close,
                            reason,
                            "Runtime-Recovery",
                        ))
                        .await?
                    {
                        crate::scheduler::KernelResult::ThreadControlled(mutation) => mutation,
                        _ => unreachable!("ControlThread command returned wrong result"),
                    }
                } else {
                    // Narrow recovery fixtures may assemble an Orchestrator
                    // without a Kernel. Production Runtime always injects it.
                    session_store
                        .control_thread(
                            &thread.id,
                            thread.revision,
                            ThreadControlAction::Close,
                            Some(reason),
                            Some("Runtime-Recovery"),
                        )
                        .await?
                };
                match mutation {
                    ThreadMutation::Updated(_) => {
                        self.revoke_thread_capability_leases(
                            &thread.id,
                            "Runtime reconciled an orphan Thread as cancelled",
                        )
                        .await;
                        if let Some(scheduler) = &self.thread_scheduler {
                            scheduler.dependency_completed(&thread.id).await?;
                        }
                        tracing::warn!(
                            thread_id = %thread.id,
                            root_turn_id = %thread.root_turn_id,
                            event_code = "orchestrator.startup.orphan_thread_closed",
                            "Closed an orphan Thread during Runtime startup"
                        );
                        self.bus
                            .publish(Event::new(
                                format!("thread_reconciled_{}_g{}", thread.id, thread.generation),
                                "Runtime".to_string(),
                                "runtime_control".to_string(),
                                "runtime/thread_reconciled".to_string(),
                                serde_json::json!({
                                    "agent_id": thread.agent_id,
                                    "context_id": thread.context_id,
                                    "session_id": thread.session_id,
                                    "thread_id": thread.id,
                                    "root_turn_id": thread.root_turn_id,
                                    "thread_generation": thread.generation,
                                    "terminal_kind": "cancelled",
                                    "wake_policy": "none",
                                    "text": reason,
                                })
                                .as_object()
                                .cloned()
                                .unwrap_or_default(),
                            ))
                            .await?;
                    }
                    ThreadMutation::Conflict { .. } | ThreadMutation::NotFound => {}
                }
            }
        }
        Ok(())
    }

    /// Close non-terminal physical Actions whose causal owner has already
    /// reached a terminal state. Older Runtime versions could persist an
    /// Approval decision and then fail the Activation before consuming the
    /// grant, leaving a `waiting_approval` Job alive forever. Such a Job is not
    /// resumable work: its Activation/Thread can no longer receive the result.
    async fn reconcile_orphaned_execution_jobs(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let Some(manager) = self.execution_jobs.as_ref() else {
            return Ok(());
        };
        let jobs = manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                include_terminal: false,
                ..Default::default()
            })
            .await?;
        let mut reconciled_activations = HashSet::new();
        for job in jobs {
            let activation = session_store
                .get_thread_activation(&job.activation_id)
                .await?;
            let thread = session_store.get_thread(&job.thread_id).await?;
            let detached_background = job.tool_name == "exec/background"
                && job
                    .request
                    .get("keep_running")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
            let reason = match (&activation, &thread) {
                (None, _) if !detached_background => Some(format!(
                    "Runtime 启动恢复时发现 Execution Job '{}' 的 Activation '{}' 不存在",
                    job.id, job.activation_id
                )),
                (_, None) => Some(format!(
                    "Runtime 启动恢复时发现 Execution Job '{}' 的 Thread '{}' 不存在",
                    job.id, job.thread_id
                )),
                (Some(activation), _)
                    if activation.status.is_terminal() && !detached_background =>
                {
                    Some(format!(
                    "Runtime 启动恢复时发现 Execution Job '{}' 的 Activation '{}' 已处于终态 {}",
                    job.id,
                    activation.id,
                    activation.status.as_str()
                ))
                }
                (_, Some(thread)) if thread.lifecycle.is_terminal() => Some(format!(
                    "Runtime 启动恢复时发现 Execution Job '{}' 的 Thread '{}' 已处于终态 {}",
                    job.id,
                    thread.id,
                    thread.lifecycle.as_str()
                )),
                _ => None,
            };
            let Some(reason) = reason else {
                continue;
            };
            if !reconciled_activations.insert(job.activation_id.clone()) {
                continue;
            }
            let cancelled = self
                .request_cancel_execution_jobs_for_activation(&job.activation_id, &reason)
                .await?;
            tracing::warn!(
                activation_id = %job.activation_id,
                thread_id = %job.thread_id,
                cancelled_jobs = cancelled,
                reason,
                event_code = "orchestrator.startup.ownerless_execution_job_closed",
                "Closed an Execution Job whose causal owner was missing during Runtime startup"
            );
        }
        Ok(())
    }

    async fn recover_delegations(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        const PAGE_SIZE: usize = 128;
        let mut cursor: Option<(chrono::DateTime<Utc>, String)> = None;
        loop {
            let page = session_store
                .list_delegations(DelegationFilter {
                    include_terminal: false,
                    newest_first: false,
                    after_updated_at: cursor.as_ref().map(|(updated_at, _)| *updated_at),
                    after_id: cursor.as_ref().map(|(_, id)| id.clone()),
                    limit: Some(PAGE_SIZE),
                    ..Default::default()
                })
                .await?;
            if page.is_empty() {
                break;
            }
            cursor = page
                .last()
                .map(|delegation| (delegation.updated_at, delegation.id.clone()));
            let page_len = page.len();
            for delegation in page {
                self.recover_delegation(session_store.as_ref(), delegation)
                    .await?;
            }
            if page_len < PAGE_SIZE {
                break;
            }
        }
        Ok(())
    }

    async fn recover_delegation(
        &self,
        session_store: &dyn SessionStore,
        delegation: crate::memory::DelegationRecord,
    ) -> Result<(), DynError> {
        if session_store
            .has_active_thread_activation_for_session(
                &delegation.child_context_id,
                &delegation.child_session_id,
            )
            .await?
        {
            return Ok(());
        }

        let terminal = self
            .store
            .query(QueryFilter {
                session_id: Some(delegation.child_session_id.clone()),
                types: vec![TYPE_AGENT_CALL.to_string()],
                latest_k: Some(100),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..Default::default()
            })
            .await?
            .into_iter()
            .rev()
            .find(|event| matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply"));
        if let Some(terminal) = terminal {
            self.complete_delegation_if_needed(&terminal, &delegation.child_session_id)
                .await?;
            return Ok(());
        }

        let failure_id = format!(
            "delegation_recovery_failed_{}_{}",
            delegation.id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        session_store
            .update_delegation_status(&delegation.id, DelegationStatus::Failed, Some(&failure_id))
            .await?;
        let mut failure_event = Event::new(
                    failure_id,
                    "System-Delegation".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    vec![
                        (
                            "context_id".to_string(),
                            json!(delegation.parent_context_id),
                        ),
                        (
                            "session_id".to_string(),
                            json!(delegation.parent_session_id),
                        ),
                        ("delegation_id".to_string(), json!(delegation.id)),
                        ("tool_name".to_string(), json!("delegate")),
                        ("tool_status".to_string(), json!("error")),
                        (
                            "text".to_string(),
                            json!(json!({
                                "delegation_id": delegation.id,
                                "status": "failed",
                                "error": "Runtime 重启后未发现活跃 Evaluation 或已提交的终态结果；旧 running 状态已回收，未重复执行外部动作。"
                            })
                            .to_string()),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                );
        if let Some(principal_id) = &delegation.initiating_principal_id {
            failure_event
                .payload
                .insert("principal_id".to_string(), json!(principal_id));
        }
        self.bus.publish(failure_event).await?;
        Ok(())
    }

    async fn handle_delegate_event(&self, event: Event) -> Result<(), DynError> {
        if let Err(error) = self.start_delegation(&event).await {
            let Some(parent_context_id) = event
                .payload
                .get("parent_context_id")
                .and_then(|value| value.as_str())
            else {
                return Err(error);
            };
            let Some(parent_session_id) = event
                .payload
                .get("parent_session_id")
                .and_then(|value| value.as_str())
            else {
                return Err(error);
            };
            let delegation_id = event
                .payload
                .get("delegation_id")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown-delegation");
            if let Some(session_store) = self.context_engine.session_store() {
                if session_store.get_delegation(delegation_id).await?.is_some() {
                    session_store
                        .update_delegation_status(
                            delegation_id,
                            DelegationStatus::Failed,
                            Some(&event.id),
                        )
                        .await?;
                }
                if let Some(child_session_id) = event
                    .payload
                    .get("child_session_id")
                    .and_then(|value| value.as_str())
                {
                    let _ = session_store
                        .update_session(
                            child_session_id,
                            SessionUpdate {
                                title: None,
                                status: Some(SessionStatus::Archived),
                            },
                        )
                        .await?;
                }
            }
            self.bus
                .publish(Event::new(
                    format!(
                        "delegation_failed_{}_{}",
                        delegation_id,
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    ),
                    "System-Delegation".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    vec![
                        ("context_id".to_string(), json!(parent_context_id)),
                        ("session_id".to_string(), json!(parent_session_id)),
                        ("delegation_id".to_string(), json!(delegation_id)),
                        ("source_event_id".to_string(), json!(event.id)),
                        ("tool_name".to_string(), json!("delegate")),
                        ("tool_status".to_string(), json!("error")),
                        (
                            "text".to_string(),
                            json!(json!({
                                "delegation_id": delegation_id,
                                "status": "failed",
                                "error": error.to_string()
                            })
                            .to_string()),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await?;
        }
        Ok(())
    }

    async fn start_delegation(&self, event: &Event) -> Result<(), DynError> {
        // Limit checks and record creation form one Runtime-local critical section so concurrent
        // delegate requests cannot all observe the same stale capacity.
        let _delegation_guard = self.delegation_start_lock.lock().await;
        let delegation_id = required_payload_str(event, "delegation_id")?.to_string();
        let parent_context_id = required_payload_str(event, "parent_context_id")?.to_string();
        let parent_session_id = required_payload_str(event, "parent_session_id")?.to_string();
        let child_context_id = required_payload_str(event, "child_context_id")?.to_string();
        let child_session_id = required_payload_str(event, "child_session_id")?.to_string();
        let mut initiating_principal_id = event
            .payload
            .get("principal_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let task = required_payload_str(event, "task")?.trim().to_string();
        let context_scope = required_payload_str(event, "context_scope")?.to_string();
        let success_when = event
            .payload
            .get("success_when")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("delegate 需要持久化 SessionStore")?;
        if initiating_principal_id.is_none() {
            initiating_principal_id = match event
                .payload
                .get("activation_id")
                .and_then(|value| value.as_str())
            {
                Some(activation_id) => session_store
                    .get_thread_activation(activation_id)
                    .await?
                    .and_then(|activation| activation.initiating_principal_id),
                None => None,
            };
        }
        let parent = session_store
            .get_session(&parent_session_id)
            .await?
            .ok_or_else(|| format!("delegate 父 Session '{}' 不存在", parent_session_id))?;
        if parent.context_id != parent_context_id {
            return Err(format!(
                "delegate 父路由不一致：Session '{}' 属于 '{}'，请求为 '{}'",
                parent_session_id, parent.context_id, parent_context_id
            )
            .into());
        }
        let active_limit = self
            .orchestrator_config
            .max_active_delegations_per_agent
            .max(1);
        let active_delegations = session_store
            .list_delegations(DelegationFilter {
                agent_id: Some(parent.agent_id.clone()),
                include_terminal: false,
                limit: Some(active_limit),
                ..Default::default()
            })
            .await?
            .len();
        if active_delegations >= active_limit {
            return Err(format!(
                "DELEGATION_CAPACITY_EXCEEDED：Agent '{}' 已有 {} 个活跃 Sub Agent，配置上限为 {}。请等待现有任务完成或显式取消后再委派。",
                parent.agent_id, active_delegations, active_limit
            )
            .into());
        }
        let new_depth = self
            .delegation_depth_for_parent(session_store.as_ref(), &parent_session_id)
            .await?
            + 1;
        let depth_limit = self.orchestrator_config.max_delegation_depth.max(1);
        if new_depth > depth_limit {
            return Err(format!(
                "DELEGATION_DEPTH_EXCEEDED：新 Sub Agent 深度为 {}，配置上限为 {}。请由当前 Agent 完成任务或把结果返回上层，不要继续递归委派。",
                new_depth, depth_limit
            )
            .into());
        }
        if !matches!(context_scope.as_str(), "current_session" | "mind_only") {
            return Err(format!("不支持的 delegate context_scope: {context_scope}").into());
        }
        let instruction = match success_when.as_deref() {
            Some(success_when) => format!(
                "You are a cognitively isolated Sub Agent delegated by Session '{parent_session_id}'. This is not a new process, container, or physical sandbox: you share the same Runtime workspace and permission boundary with the parent. Never modify Runtime configuration to manufacture isolation. Complete the task autonomously.\n\nTask:\n{task}\n\nSuccess condition:\n{success_when}\n\nWhen complete, return a self-contained final result. Your result will be delivered to the parent Session; do not address sibling Sessions."
            ),
            None => format!(
                "You are a cognitively isolated Sub Agent delegated by Session '{parent_session_id}'. This is not a new process, container, or physical sandbox: you share the same Runtime workspace and permission boundary with the parent. Never modify Runtime configuration to manufacture isolation. Complete the task autonomously.\n\nTask:\n{task}\n\nWhen complete, return a self-contained final result. Your result will be delivered to the parent Session; do not address sibling Sessions."
            ),
        };
        // Freeze and bound the active parent Session projection before any
        // child rows are created. A failed preflight must not leave an empty
        // Context/Session behind, and current_session must never fall back to
        // replaying the parent's immutable Events.
        let session_projection = if context_scope == "current_session" {
            Some(
                self.context_engine
                    .prepare_session_projection_seed(
                        &parent_context_id,
                        &parent_session_id,
                        &child_context_id,
                        &child_session_id,
                        &instruction,
                    )
                    .await?,
            )
        } else {
            None
        };
        session_store
            .create_context(NewCognitiveContext {
                id: child_context_id.clone(),
                agent_id: parent.agent_id.clone(),
                title: format!("Delegation {}", delegation_id),
            })
            .await?;
        if let Some(projection) = session_projection.as_ref() {
            self.context_engine
                .seed_context_from_mind_with_session_projection(
                    &parent_context_id,
                    Some(projection.source_mind_version),
                    &child_context_id,
                    projection,
                )
                .await?;
        } else {
            self.context_engine
                .seed_context_from_mind(&parent_context_id, None, &child_context_id)
                .await?;
        }
        session_store
            .create_session(NewSession {
                id: child_session_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: child_context_id.clone(),
                parent_session_id: None,
                title: format!("Sub Agent for {}", parent_session_id),
                mount_kind: SessionMountKind::DelegationProjection,
            })
            .await?;
        if let Some(principal_id) = &initiating_principal_id {
            if session_store.get_principal(principal_id).await?.is_some() {
                session_store
                    .bind_session_principal(&child_session_id, principal_id)
                    .await?;
            } else {
                tracing::warn!(
                    delegation_id = %delegation_id,
                    principal_id,
                    event_code = "orchestrator.delegation.principal_not_in_directory",
                    "Delegation principal is absent from the identity directory; preserving causal identity without inferring a Session binding"
                );
            }
        }
        if let Some(projection) = session_projection {
            let active_observations = projection.active_observations;
            let source_estimated_tokens = projection.source_estimated_tokens;
            let target_estimated_tokens = projection.target_estimated_tokens;
            let imported = self
                .context_engine
                .import_prepared_session_projection(projection)
                .await?;
            tracing::info!(
                delegation_id,
                active_observations,
                imported,
                source_estimated_tokens,
                target_estimated_tokens,
                event_code = "orchestrator.sub_agent.snapshot_created",
                "Created a bounded cognitive snapshot for the Sub Agent from the parent Session active Projection"
            );
        }
        session_store
            .create_delegation(NewDelegation {
                id: delegation_id.clone(),
                agent_id: parent.agent_id,
                parent_context_id: parent_context_id.clone(),
                parent_session_id: parent_session_id.clone(),
                child_context_id: child_context_id.clone(),
                child_session_id: child_session_id.clone(),
                initiating_principal_id: initiating_principal_id.clone(),
                task: task.clone(),
                success_when: success_when.clone(),
                context_scope,
            })
            .await?;
        session_store
            .update_delegation_status(&delegation_id, DelegationStatus::Running, None)
            .await?;
        self.register_session_context(&child_session_id, &child_context_id);
        let mut start_payload = vec![
            ("context_id".to_string(), json!(child_context_id)),
            ("session_id".to_string(), json!(child_session_id)),
            ("delegation_id".to_string(), json!(delegation_id)),
            ("return_context_id".to_string(), json!(parent_context_id)),
            ("return_session_id".to_string(), json!(parent_session_id)),
            ("text".to_string(), json!(instruction)),
        ];
        if let Some(principal_id) = &initiating_principal_id {
            start_payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        self.bus
            .publish(Event::new(
                format!(
                    "delegation_start_{}_{}",
                    delegation_id,
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "System-Delegation".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                start_payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn delegation_depth_for_parent(
        &self,
        session_store: &dyn SessionStore,
        parent_session_id: &str,
    ) -> Result<usize, DynError> {
        let mut depth = 0usize;
        let mut cursor = parent_session_id.to_string();
        let mut seen = HashSet::new();
        while let Some(delegation) = session_store
            .get_delegation_by_child_session(&cursor)
            .await?
        {
            if !seen.insert(delegation.id.clone()) {
                return Err("Delegation 父链出现循环，拒绝继续派生".into());
            }
            depth = depth.saturating_add(1);
            cursor = delegation.parent_session_id;
        }
        Ok(depth)
    }

    async fn handle_chat_event(&self, event: Event) -> Result<(), DynError> {
        let Some(session_id) = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
        else {
            return Ok(());
        };
        let context_id = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("事件 '{}' 缺少 context_id 路由", event.id))?
            .to_string();
        self.session_contexts
            .insert(session_id.clone(), context_id.clone());

        if event.event_type == TYPE_AGENT_CALL
            && matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply")
        {
            if self
                .complete_delegation_if_needed(&event, &session_id)
                .await?
            {
                return Ok(());
            }
            return Ok(());
        }
        if event.event_type != TYPE_USER_MESSAGE
            && event.event_type != TYPE_SESSION_SIGNAL
            && event.event_type != TYPE_RUNTIME_WAKE
            && event.event_type != TYPE_TOOL_OUTPUT
            && event.event_type != TYPE_INFER_REQUEST
            && event.topic != "runtime/action_group_settled"
        {
            return Ok(());
        }

        // `wake_policy:none` is an immutable semantic boundary: the Event is
        // observable and may be consumed by its owning Plan, but it must not
        // enter ordinary chat scheduling. This guard also protects direct
        // in-process dispatch, not only the durable Signal Outbox path.
        if event
            .payload
            .get("wake_policy")
            .and_then(|value| value.as_str())
            == Some("none")
        {
            return Ok(());
        }

        // An attached delegation's first receipt only confirms that the child
        // was queued. It is durable and observable, but it must not create a
        // successor Activation for the parent. The later delegation result is
        // a separate Tool Output without this marker and is the sole wakeup.
        // Keeping this distinction at the routing boundary also prevents the
        // queued receipt from consuming the child's next mocked/model reply.
        if event.event_type == TYPE_TOOL_OUTPUT
            && event
                .payload
                .get("wake_policy")
                .and_then(|value| value.as_str())
                == Some("delegation_result")
        {
            return Ok(());
        }

        // Action Group member results are durable semantic facts and remain
        // immediately visible to observers, but they are not continuation
        // boundaries. Routing an individual member here races the group's
        // deterministic settled barrier and can create a stale successor
        // Activation before every sibling result is available. Only the
        // runtime/action_group_settled Event may wake the Thread.
        if event.event_type == TYPE_TOOL_OUTPUT
            && event
                .payload
                .get("action_group_id")
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty())
        {
            return Ok(());
        }

        self.process_routed_event(event).await
    }

    async fn complete_delegation_if_needed(
        &self,
        event: &Event,
        child_session_id: &str,
    ) -> Result<bool, DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(false);
        };
        let Some(delegation) = session_store
            .get_delegation_by_child_session(child_session_id)
            .await?
        else {
            return Ok(false);
        };
        if matches!(
            delegation.status,
            DelegationStatus::Completed | DelegationStatus::Failed | DelegationStatus::Cancelled
        ) {
            return Ok(true);
        }
        let result = event
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        let mut result_payload = vec![
            (
                "context_id".to_string(),
                json!(delegation.parent_context_id),
            ),
            (
                "session_id".to_string(),
                json!(delegation.parent_session_id),
            ),
            ("delegation_id".to_string(), json!(delegation.id)),
            (
                "subagent_context_id".to_string(),
                json!(delegation.child_context_id),
            ),
            (
                "subagent_session_id".to_string(),
                json!(delegation.child_session_id),
            ),
            ("source_event_id".to_string(), json!(event.id)),
            ("tool_name".to_string(), json!("delegate")),
            ("tool_status".to_string(), json!("success")),
            ("output_empty".to_string(), json!(result.trim().is_empty())),
            (
                "text".to_string(),
                json!(json!({
                    "delegation_id": delegation.id,
                    "status": "completed",
                    "subagent_session_id": delegation.child_session_id,
                    "result_event_id": event.id,
                    "result": result,
                    "guidance": "Verify the Sub Agent result before replying to the user or integrating it into the shared Mind with context_tx."
                })
                .to_string()),
            ),
        ];
        if let Some(principal_id) = &delegation.initiating_principal_id {
            result_payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        let result_event = Event::new(
            format!(
                "delegation_result_{}_{}",
                delegation.id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            format!("Sub-Agent-{}", delegation.child_session_id),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            result_payload.into_iter().collect(),
        );
        if session_store
            .commit_delegation_result(&delegation.id, &result_event)
            .await?
        {
            self.bus.dispatch_persisted(result_event).await?;
        }
        Ok(true)
    }

    async fn process_routed_event(&self, event: Event) -> Result<(), DynError> {
        let Some(session_id) = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
        else {
            return Ok(());
        };

        if let Some(cancelled_at) = self.cancelled_at.get(&session_id).map(|value| *value) {
            if matches!(
                event.event_type.as_str(),
                TYPE_USER_MESSAGE | TYPE_SESSION_SIGNAL | TYPE_RUNTIME_WAKE
            ) && event.timestamp > cancelled_at
            {
                // A later directed user or internal coordination message
                // resumes a cancelled Session. Tool completions never resume
                // it on their own.
                self.cancelled_at.remove(&session_id);
            } else {
                if let Some(store) = self.context_engine.session_store() {
                    store.discard_signal_outbox(&event.id).await?;
                }
                tracing::info!(
                    session_id,
                    event_id = %event.id,
                    event_code = "orchestrator.session.cancelled_event_ignored",
                    "Ignored an Event queued before Session cancellation or a background-tool wake after cancellation"
                );
                return Ok(());
            }
        }
        // Serialize every durable event belonging to one root turn before it
        // materializes or claims a successor Activation. The original user
        // Activation holds this gate through terminal persistence and the
        // pending-signal handoff below. A physical result that arrives during
        // that window therefore cannot observe the old Activation as running,
        // leave its Signal pending, and race the terminal side's one-shot scan.
        let routed_root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            .unwrap_or(event.id.as_str())
            .to_string();
        let _thread_guard = self.thread_gate(&routed_root_turn_id).lock_owned().await;

        let Some(admitted) = self.claim_thread_activation(&event).await? else {
            tracing::debug!(
                session_id,
                event_id = %event.id,
                event_code = "orchestrator.activation.claim_unavailable",
                "Thread Activation was claimed by another worker or is already terminal"
            );
            return Ok(());
        };
        let activation = admitted.record;
        let activation_admission = Arc::new(ActivationAdmissionSlot::new(admitted._permit));

        // Bind an Objective continuation before any await in the Evaluation
        // body. A concurrent pause/cancel can therefore target this exact
        // Activation instead of falling back to the enclosing Session.
        self.bind_embedded_objective_route(&activation.id, &event);
        if let (Some(supervisor), Some(objective_id), Some(evaluation_id)) = (
            self.objective_supervisor.as_ref(),
            event
                .payload
                .get("objective_id")
                .and_then(|value| value.as_str()),
            event
                .payload
                .get("objective_evaluation_id")
                .and_then(|value| value.as_str()),
        ) {
            let objective_control_receipt = event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("objective_update");
            if !supervisor
                .admit_routed_evaluation(
                    objective_id,
                    evaluation_id,
                    objective_control_receipt,
                    &activation.id,
                )
                .await?
            {
                tracing::info!(
                    session_id,
                    objective_id,
                    evaluation_id,
                    activation_id = %activation.id,
                    event_code = "orchestrator.objective_evaluation.suppressed",
                    "Suppressed an Objective Evaluation that was paused, cancelled, or superseded"
                );
                self.finish_thread_activation(&activation, ThreadActivationStatus::Cancelled)
                    .await?;
                self.objective_evaluations.remove_activation(&activation.id);
                return Ok(());
            }
        }
        if let Some(supervisor) = &self.objective_supervisor {
            if supervisor
                .prepare_routed_event(&event, &activation.id)
                .await?
                == crate::objective::RoutedObjectiveEventDisposition::Suppressed
            {
                tracing::info!(
                    session_id,
                    activation_id = %activation.id,
                    event_id = %event.id,
                    event_code = "orchestrator.objective_interrupt.suppressed",
                    "Suppressed a stale or concurrently superseded Objective interrupt Activation"
                );
                self.finish_thread_activation(&activation, ThreadActivationStatus::Cancelled)
                    .await?;
                self.objective_evaluations.remove_activation(&activation.id);
                return Ok(());
            }
        }

        let mut cancellation = self.cancellation_sender(&session_id).subscribe();
        let start_epoch = *cancellation.borrow();
        self.activation_admission_slots
            .insert(activation.id.clone(), Arc::clone(&activation_admission));
        let active_counter = self.active_counter(&session_id);
        active_counter.fetch_add(1, Ordering::SeqCst);
        let objective_lease_maintenance = async {
            let Some(supervisor) = self.objective_supervisor.as_ref() else {
                return std::future::pending::<
                    Result<crate::objective::ActiveObjectiveEvaluation, DynError>,
                >()
                .await;
            };
            // An ordinary dialogue Activation can adopt a newly-created
            // Objective later in the same model response. Observe that late
            // binding instead of deciding once at Activation admission that
            // this work will never need an Objective heartbeat.
            while self
                .objective_evaluations
                .get_for_activation(&activation.id)
                .is_none()
            {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            supervisor.maintain_activation_lease(&activation.id).await
        };
        let attempt = tokio::select! {
            biased;
            cancelled = self.objective_evaluations.wait_for_activation_cancellation(&activation.id) => {
                (None, Some(cancelled), None)
            }
            reason = self.activation_cancellations.wait(&activation.id) => {
                (None, None, Some(reason))
            }
            reason = self.wait_for_durable_activation_revocation(&activation.id) => {
                (None, None, Some(reason))
            }
            lease = objective_lease_maintenance => {
                match lease {
                    Ok(revoked) => (None, Some(revoked), None),
                    Err(error) => (Some(Err(error)), None, None),
                }
            }
            _ = cancellation.changed() => {
                debug_assert_ne!(*cancellation.borrow(), start_epoch);
                (None, None, None)
            }
            result = async {
            if let Some(thread) = self
                .context_engine
                .session_store()
                .ok_or("Thread 需要持久化 SessionStore")?
                .get_thread_by_root(&activation.root_turn_id)
                .await?
            {
                if thread.lifecycle.is_terminal() {
                    tracing::debug!(
                        root_turn_id = %activation.root_turn_id,
                        event_id = %event.id,
                        event_code = "orchestrator.mailbox_wake.thread_terminal",
                        "Suppressed a late mailbox wake for a terminal Thread"
                    );
                    return Ok(());
                }
            }
            self.run_attempt(&session_id, &activation).await
            } => (Some(result), None, None),
        };
        active_counter.fetch_sub(1, Ordering::SeqCst);
        let (result, final_status) = match attempt {
            (Some(result), _, _) => {
                let status = if result.is_ok() {
                    ThreadActivationStatus::Succeeded
                } else {
                    ThreadActivationStatus::Failed
                };
                (result, status)
            }
            (None, Some(cancelled), _) => {
                let reason = format!(
                    "Objective '{}' Evaluation '{}' 已被暂停或取消",
                    cancelled.objective_id, cancelled.evaluation_id
                );
                tracing::info!(
                    session_id,
                    objective_id = %cancelled.objective_id,
                    evaluation_id = %cancelled.evaluation_id,
                    activation_id = %activation.id,
                    event_code = "orchestrator.objective_evaluation.cancelled",
                    "Current Objective Evaluation was cancelled; the Session and other Evaluations continue"
                );
                self.close_cancelled_model_attempt(&session_id, &activation.id, &reason)
                    .await;
                let result = self
                    .request_cancel_execution_jobs_for_activation(&activation.id, &reason)
                    .await
                    .map(|_| ());
                (result, ThreadActivationStatus::Cancelled)
            }
            (None, None, Some(reason)) => {
                tracing::info!(
                    session_id,
                    activation_id = %activation.id,
                    %reason,
                    event_code = "orchestrator.activation.runtime_cancelled",
                    "Current Thread Activation was cancelled by Runtime control"
                );
                self.close_cancelled_model_attempt(&session_id, &activation.id, &reason)
                    .await;
                let result = self
                    .request_cancel_execution_jobs_for_activation(&activation.id, &reason)
                    .await
                    .map(|_| ());
                (result, ThreadActivationStatus::Cancelled)
            }
            (None, None, None) => {
                let reason = format!("Session '{session_id}' 已由用户取消");
                tracing::info!(
                    event_code = "orchestrator.session.user_cancelled",
                    session_id,
                    "Current Session execution was cancelled by the user"
                );
                self.close_cancelled_model_attempt(&session_id, &activation.id, &reason)
                    .await;
                let result = self
                    .request_cancel_execution_jobs_for_activation(&activation.id, &reason)
                    .await
                    .map(|_| ());
                (result, ThreadActivationStatus::Cancelled)
            }
        };
        if let Err(error) = &result {
            tracing::error!(
                session_id,
                activation_id = %activation.id,
                root_turn_id = %activation.root_turn_id,
                error = %error,
                event_code = "orchestrator.activation.evaluation_failed",
                "Thread Activation evaluation failed"
            );
            if self.activation_route(&activation.id).is_some() {
                let storage_contention = is_transient_storage_contention(error.as_ref());
                if let Err(outcome_error) = self
                    .publish_activation_evaluation_failure(
                        &session_id,
                        &activation.id,
                        storage_contention,
                    )
                    .await
                {
                    tracing::error!(
                        session_id,
                        activation_id = %activation.id,
                        original_error = %error,
                        error = %outcome_error,
                        event_code = "orchestrator.activation.failure_outcome_commit_failed",
                        "Could not commit a user-visible Thread terminal state after Activation evaluation failed"
                    );
                }
            }
            #[cfg(test)]
            eprintln!(
                "Thread Activation '{}' evaluation failed: {error}",
                activation.id
            );
        }
        if matches!(
            final_status,
            ThreadActivationStatus::Cancelled | ThreadActivationStatus::Failed
        ) {
            self.release_dialogue_thread(&session_id, &activation.root_turn_id)
                .await;
        }
        if final_status == ThreadActivationStatus::Failed {
            let reason = format!(
                "Activation '{}' 求值失败；未完成的物理 Action 已失去可接收结果的因果 Owner",
                activation.id
            );
            if let Err(cancellation_error) = self
                .request_cancel_execution_jobs_for_activation(&activation.id, &reason)
                .await
            {
                tracing::error!(
                    activation_id = %activation.id,
                    error = %cancellation_error,
                    event_code = "orchestrator.activation.execution_jobs_close_failed",
                    "Activation failed but its non-terminal Execution Jobs could not be fully closed"
                );
            }
        }
        if let Err(error) = self
            .finish_thread_activation(&activation, final_status)
            .await
        {
            self.activation_routes.remove(&activation.id);
            self.objective_evaluations.remove_activation(&activation.id);
            if result.is_ok() {
                self.activation_admission_slots.remove(&activation.id);
                return Err(error);
            }
            tracing::warn!(
                activation_id = %activation.id,
                error = %error,
                event_code = "orchestrator.activation.terminal_commit_failed",
                "Thread Activation terminal-state commit failed; preserving the original execution error"
            );
        }
        self.activation_cancellations.clear(&activation.id);
        self.active_model_attempts.remove(&activation.id);
        self.activation_routes.remove(&activation.id);
        self.objective_evaluations.remove_activation(&activation.id);
        self.activation_admission_slots.remove(&activation.id);
        if matches!(
            final_status,
            ThreadActivationStatus::Succeeded | ThreadActivationStatus::Failed
        ) {
            self.dispatch_next_pending_thread_signal(&activation.root_turn_id)
                .await?;
        }
        result
    }

    async fn publish_activation_evaluation_failure(
        &self,
        session_id: &str,
        activation_id: &str,
        storage_contention: bool,
    ) -> Result<(), DynError> {
        let failure_kind = if storage_contention {
            "storage_contention"
        } else {
            "runtime_internal"
        };
        let message = if storage_contention {
            "Runtime 内部存储持续繁忙，本次请求未能开始执行。该回合已经结束，不会遗留为运行中；请重新发送这条消息。"
        } else {
            "Runtime 在执行本次请求时发生内部错误。该回合已经结束，不会遗留为运行中；请重试或查看服务日志。"
        };
        self.publish_reply_with_attributes(
            session_id,
            activation_id,
            None,
            message.to_string(),
            None,
            vec![
                ("runtime_failure_kind".to_string(), json!(failure_kind)),
                (
                    "runtime_failure_stage".to_string(),
                    json!("activation_evaluation"),
                ),
                ("terminal_kind".to_string(), json!("failed")),
                ("unresolved_failures".to_string(), json!([failure_kind])),
            ],
        )
        .await
    }

    async fn dispatch_next_pending_thread_signal(
        &self,
        root_turn_id: &str,
    ) -> Result<(), DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Signal dispatch 需要持久化 SessionStore")?;
        let Some(thread) = session_store.get_thread_by_root(root_turn_id).await? else {
            return Ok(());
        };
        let Some(signal) = session_store.next_pending_thread_signal(&thread.id).await? else {
            return Ok(());
        };
        let Some(event) = self
            .store
            .query(QueryFilter {
                event_id: Some(signal.event_id.clone()),
                context_id: Some(thread.context_id),
                session_id: Some(thread.session_id),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|event| event.id == signal.event_id)
        else {
            return Err(format!(
                "Pending Thread Signal '{}' 的 Event '{}' 不存在",
                signal.id, signal.event_id
            )
            .into());
        };
        self.bus.dispatch_persisted(event).await?;
        Ok(())
    }

    async fn claim_thread_activation(
        &self,
        event: &Event,
    ) -> Result<Option<AdmittedThreadActivation>, DynError> {
        let session_id = required_payload_str(event, "session_id")?;
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Activation 需要持久化 SessionStore")?;
        let mut session = session_store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;

        // A user-message Principal is an ingress authentication fact, not a
        // model-supplied routing hint.  SessionHandle already performs this
        // check before committing normal SDK/CLI/Web messages, but the
        // scheduler must defend the durable boundary as well because trusted
        // adapters can publish Events directly.  Legacy/system-generated user
        // Events without a Principal remain readable as unattributed facts;
        // an explicit, conflicting Principal is never evaluated.
        if event.event_type == TYPE_USER_MESSAGE {
            if let Some(principal_id) = event
                .payload
                .get("principal_id")
                .and_then(|value| value.as_str())
            {
                if !session_store
                    .verify_session_principal(session_id, principal_id)
                    .await?
                {
                    return Err(format!(
                        "User Message Event '{}' 声称的 Principal '{}' 未绑定到 Session '{}'，拒绝创建 Activation",
                        event.id, principal_id, session_id
                    )
                    .into());
                }
            }
        }

        // Directed events are physical activity. A retired Session must be restored
        // before it participates in Context Encoding again. User messages already do
        // this atomically in `claim_message`; this branch covers tool/background wakes.
        if session.attention_state == SessionAttentionState::Retired {
            let restore_event_id = format!(
                "session_restored_{}_{}",
                session_id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            );
            let mut restore_event = Event::new(
                restore_event_id.clone(),
                "Runtime-Orchestrator".to_string(),
                "session_lifecycle".to_string(),
                "runtime/session_restored".to_string(),
                vec![
                    ("agent_id".to_string(), json!(session.agent_id)),
                    ("context_id".to_string(), json!(session.context_id)),
                    ("session_id".to_string(), json!(session.id)),
                    ("trigger_event_id".to_string(), json!(event.id)),
                    ("reason".to_string(), json!("directed_event")),
                ]
                .into_iter()
                .collect(),
            );
            let attention_update = SessionAttentionUpdate {
                session_id: session.id.clone(),
                context_id: session.context_id.clone(),
                expected_revision: session.attention_revision,
                state: SessionAttentionState::Active,
                reason: Some("directed_event".to_string()),
                changed_at: restore_event.timestamp,
                event_id: restore_event_id,
            };
            match session_store
                .commit_context_transaction(&restore_event, &[attention_update])
                .await
            {
                Ok(()) => {
                    // The audit fact is already durable; dispatch it without crossing the
                    // persistence boundary a second time.
                    self.bus.publish_ephemeral(restore_event.clone()).await?;
                    session.attention_state = SessionAttentionState::Active;
                    session.attention_revision = session.attention_revision.saturating_add(1);
                }
                Err(error) => {
                    session = session_store
                        .get_session(session_id)
                        .await?
                        .ok_or_else(|| format!("Session '{session_id}' 在恢复时消失"))?;
                    if session.attention_state != SessionAttentionState::Active {
                        return Err(error);
                    }
                    // A concurrent worker won the restore CAS. The event it committed is
                    // already the authoritative audit record.
                    restore_event
                        .payload
                        .insert("restore_race_lost".to_string(), json!(true));
                }
            }
        }

        if event.event_type != TYPE_USER_MESSAGE {
            session_store
                .touch_session(session_id, event.timestamp)
                .await?;
        }

        let trigger_sequence = match event.sequence {
            Some(sequence) => sequence,
            None => self
                .store
                .query(QueryFilter {
                    event_id: Some(event.id.clone()),
                    session_id: Some(session_id.to_string()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .find(|stored| stored.id == event.id)
                .and_then(|stored| stored.sequence)
                .ok_or_else(|| {
                    format!(
                        "Trigger Event '{}' 尚未持久化，不能创建 Thread Activation",
                        event.id
                    )
                })?,
        };
        let explicit_parent_activation_id = event
            .payload
            .get("parent_activation_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let causal_activation_id = explicit_parent_activation_id.clone().or_else(|| {
            event
                .payload
                .get("activation_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        });
        let parent = match causal_activation_id.as_deref() {
            Some(id) => session_store.get_thread_activation(id).await?,
            None => None,
        };
        if explicit_parent_activation_id.is_some() && parent.is_none() {
            return Err(format!(
                "Trigger Event '{}' 引用的显式 parent Activation '{}' 不存在",
                event.id,
                explicit_parent_activation_id.as_deref().unwrap_or_default()
            )
            .into());
        }
        // Generic tool receipts also carry their producing `activation_id`.
        // Preserve it as a causal parent only when that durable Activation is
        // present; legacy/imported Events may retain an informational ID that
        // was never materialized in this Store. Explicit parent routes are
        // strict because child infer handoffs depend on that ancestry.
        let parent_activation_id = parent.as_ref().map(|record| record.id.clone());
        let initiating_principal_id = event
            .payload
            .get("principal_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
            .or_else(|| {
                parent
                    .as_ref()
                    .and_then(|activation| activation.initiating_principal_id.clone())
            });
        let root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
            .or_else(|| parent.as_ref().map(|item| item.root_turn_id.clone()))
            .unwrap_or_else(|| event.id.clone());
        let objective_route = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
            .zip(
                event
                    .payload
                    .get("objective_evaluation_id")
                    .and_then(|value| value.as_str()),
            );
        let derived_thread_kind = derived_thread_kind(event, objective_route.is_some());
        let plan_execution_id = event
            .payload
            .get("plan_execution_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        // A Thread's supervision route is immutable for its entire logical
        // root. In particular, an Objective control tool can bump the
        // Objective revision before its tool result is routed; recomputing the
        // supervision generation here would make the continuation appear to be
        // a different owner and strand the Evaluation after the tool call.
        //
        // Thread kind has exactly one legacy-compatible transition:
        // DialogueTurn -> Execution after a physical assistant plan is durable.
        // That transition is performed in run_attempt from the persisted plan,
        // never inferred from a process-local gate.
        let existing_thread = session_store.get_thread_by_root(&root_turn_id).await?;
        let initial_thread_kind = existing_thread
            .as_ref()
            .map(|thread| thread.kind)
            .unwrap_or(derived_thread_kind);
        let supervision = if let Some(thread) = existing_thread.as_ref() {
            thread.supervision.clone()
        } else if let Some((objective_id, evaluation_id)) = objective_route {
            ThreadSupervision::objective(
                objective_id,
                evaluation_id,
                event
                    .payload
                    .get("objective_revision")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(1),
                parent
                    .as_ref()
                    .map(|activation| stable_thread_id(&activation.root_turn_id)),
            )
        } else {
            ThreadSupervision::runtime(match initial_thread_kind {
                ThreadKind::DialogueTurn => "dialogue-router",
                ThreadKind::Delivery => "delivery-router",
                ThreadKind::Execution => "event-router",
            })
        };
        let thread = session_store
            .ensure_thread(NewThread {
                id: stable_thread_id(&root_turn_id),
                agent_id: session.agent_id.clone(),
                context_id: session.context_id.clone(),
                session_id: session.id.clone(),
                initiating_principal_id: initiating_principal_id.clone(),
                root_turn_id: root_turn_id.clone(),
                kind: initial_thread_kind,
                executor_kind: if plan_execution_id.is_some() {
                    "plan_infer".to_string()
                } else {
                    "self".to_string()
                },
                executor_id: plan_execution_id,
                target_id: None,
                supervision,
            })
            .await?;
        let activation_id = stable_thread_activation_id(&event.id);
        let signal_id = crate::memory::stable_thread_signal_id(&event.id);
        let Some(activation) = session_store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: signal_id,
                    thread_id: thread.id,
                    thread_generation: thread.generation,
                    event_id: event.id.clone(),
                    principal_id: initiating_principal_id.clone(),
                    sequence: trigger_sequence,
                    kind: event.topic.clone(),
                    parent_activation_id: parent_activation_id.clone(),
                },
                NewThreadActivation {
                    id: activation_id,
                    agent_id: session.agent_id.clone(),
                    context_id: session.context_id.clone(),
                    session_id: session.id.clone(),
                    initiating_principal_id,
                    trigger_event_id: event.id.clone(),
                    trigger_sequence,
                    trigger_kind: event.topic.clone(),
                    parent_activation_id,
                    root_turn_id,
                },
                crate::memory::DEFAULT_THREAD_SIGNAL_BATCH_LIMIT,
            )
            .await?
        else {
            return Ok(None);
        };
        if activation.status.is_terminal() {
            self.activation_admission.forget(&activation.id);
            return Ok(None);
        }
        let now = Utc::now();
        if activation.status == ThreadActivationStatus::Running
            && activation
                .lease_expires_at
                .is_some_and(|expires_at| expires_at > now)
        {
            self.activation_admission.forget(&activation.id);
            return Ok(None);
        }
        if activation.status == ThreadActivationStatus::Queued
            && !session_store
                .dialogue_turn_activation_runnable(&activation.id)
                .await?
        {
            // The Signal batch is durably queued behind the Session's current
            // DialogueTurn. Do not place it in the process-local admission
            // window yet: doing so would repeatedly win a global permit only
            // to lose the per-Session CAS. Releasing the current turn's permit
            // notifies the refill loop, which will select this oldest queued
            // turn once it is actually runnable.
            tracing::debug!(
                activation_id = %activation.id,
                session_id = %activation.session_id,
                event_code = "orchestrator.dialogue_turn.queued_behind_session_turn",
                "DialogueTurn is durably queued until the preceding turn leaves the Session dialogue channel"
            );
            return Ok(None);
        }
        let admission_permit = match self
            .activation_admission
            .acquire(activation_admission_key(&activation, event))
            .await
        {
            Ok(permit) => permit,
            Err(ActivationAdmissionError::AlreadyLocal(_)) => return Ok(None),
            Err(error @ ActivationAdmissionError::WindowFull { .. }) => {
                // The Activation and its claimed Signal batch remain durably
                // queued. A permit/window change wakes the refill loop, which
                // re-dispatches this Trigger when it can enter the window.
                tracing::info!(
                    activation_id = %activation.id,
                    session_id = %activation.session_id,
                    %error,
                    event_code = "orchestrator.activation.backpressure_delayed",
                    "Activation encountered bounded backpressure and was delayed rather than failed"
                );
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        let lease_expires_at = now + self.activation_lease_duration();
        match self
            .transition_thread_activation(
                &activation,
                ThreadActivationStatus::Running,
                Some(self.runtime_claimant_id.clone()),
                Some(lease_expires_at),
                None,
                &activation.trigger_event_id,
                "ActivationAdmission",
            )
            .await?
        {
            ThreadActivationMutation::Updated(claimed) => {
                self.arm_activation_lease(&claimed).await?;
                Ok(Some(AdmittedThreadActivation {
                    record: claimed,
                    _permit: admission_permit,
                }))
            }
            ThreadActivationMutation::Conflict { .. } => Ok(None),
            ThreadActivationMutation::NotFound => {
                Err(format!("Thread Activation '{}' 在 claim 时消失", activation.id).into())
            }
        }
    }

    async fn finish_thread_activation(
        &self,
        activation: &ThreadActivationRecord,
        status: ThreadActivationStatus,
    ) -> Result<ThreadActivationRecord, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Activation 需要持久化 SessionStore")?;
        let mut last_error = None;
        for retry in 0..5u64 {
            let current = match session_store.get_thread_activation(&activation.id).await {
                Ok(Some(current)) => current,
                Ok(None) => {
                    return Err(
                        format!("Thread Activation '{}' 在结束时消失", activation.id).into(),
                    );
                }
                Err(error) => {
                    last_error = Some(error.to_string());
                    tokio::time::sleep(std::time::Duration::from_millis(
                        25u64.saturating_mul(1 << retry),
                    ))
                    .await;
                    continue;
                }
            };
            if current.status.is_terminal() {
                if let Err(error) = self.cancel_activation_lease(&current.id).await {
                    tracing::warn!(event_code = "orchestrator.activation.lease_timer_cancel_failed", activation_id = %current.id, %error, "Activation is terminal but its lease Timer could not be cancelled");
                }
                return Ok(current);
            }
            match self
                .transition_thread_activation(
                    &current,
                    status,
                    None,
                    None,
                    current.context_snapshot_version,
                    &current.trigger_event_id,
                    "ActivationCompletion",
                )
                .await
            {
                Ok(ThreadActivationMutation::Updated(updated)) => {
                    if let Err(error) = self.cancel_activation_lease(&updated.id).await {
                        tracing::warn!(event_code = "orchestrator.activation.lease_timer_cancel_failed", activation_id = %updated.id, %error, "Activation is terminal but its lease Timer could not be cancelled");
                    }
                    return Ok(updated);
                }
                Ok(ThreadActivationMutation::Conflict { current })
                    if current.status.is_terminal() =>
                {
                    if let Err(error) = self.cancel_activation_lease(&current.id).await {
                        tracing::warn!(event_code = "orchestrator.activation.lease_timer_cancel_failed", activation_id = %current.id, %error, "Activation is terminal but its lease Timer could not be cancelled");
                    }
                    return Ok(current);
                }
                Ok(ThreadActivationMutation::Conflict { current }) => {
                    // Lease heartbeats and recovery both advance revision.
                    // Reload and retry the terminal CAS instead of stranding a
                    // healthy completed evaluation as `running`.
                    last_error = Some(format!(
                        "revision={} status={}",
                        current.revision,
                        current.status.as_str()
                    ));
                }
                Ok(ThreadActivationMutation::NotFound) => {
                    return Err(
                        format!("Thread Activation '{}' 在结束时消失", activation.id).into(),
                    );
                }
                Err(error) => {
                    last_error = Some(error.to_string());
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                25u64.saturating_mul(1 << retry),
            ))
            .await;
        }
        Err(format!(
            "Thread Activation '{}' 终态持久化重试耗尽：{}",
            activation.id,
            last_error.unwrap_or_else(|| "unknown persistence error".to_string())
        )
        .into())
    }

    async fn record_activation_context_snapshot(
        &self,
        activation: &ThreadActivationRecord,
        context_version: u64,
    ) -> Result<(), DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Activation 需要持久化 SessionStore")?;
        let Some(current) = session_store.get_thread_activation(&activation.id).await? else {
            return Err(format!("Thread Activation '{}' 在记录快照时消失", activation.id).into());
        };
        if current.status.is_terminal() || current.context_snapshot_version == Some(context_version)
        {
            return Ok(());
        }
        match self
            .transition_thread_activation(
                &current,
                current.status,
                current.claimed_by.clone(),
                current.lease_expires_at,
                Some(context_version),
                &current.trigger_event_id,
                "ContextSnapshot",
            )
            .await?
        {
            ThreadActivationMutation::Updated(updated) => {
                self.arm_activation_lease(&updated).await?;
                Ok(())
            }
            ThreadActivationMutation::Conflict { current }
                if current.context_snapshot_version == Some(context_version) =>
            {
                Ok(())
            }
            ThreadActivationMutation::Conflict { current } => Err(format!(
                "Thread Activation '{}' Context snapshot 提交冲突：revision={}",
                current.id, current.revision
            )
            .into()),
            ThreadActivationMutation::NotFound => Err(format!(
                "Thread Activation '{}' 在记录 Context snapshot 时消失",
                activation.id
            )
            .into()),
        }
    }

    async fn pending_routed_inputs(
        &self,
        activation: &ThreadActivationRecord,
    ) -> Result<usize, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread pending-input check 需要持久化 SessionStore")?;
        Ok(usize::from(
            session_store
                .next_pending_thread_signal(
                    &session_store
                        .get_thread_by_root(&activation.root_turn_id)
                        .await?
                        .ok_or_else(|| {
                            format!(
                                "Activation '{}' 所属 Thread '{}' 不存在",
                                activation.id, activation.root_turn_id
                            )
                        })?
                        .id,
                )
                .await?
                .is_some(),
        ))
    }

    /// Build only the standard Function Calling handshake for the tool batch
    /// that triggered this Activation. Earlier settled tool results are already
    /// durable observations in the compiled Context and must not be replayed as
    /// a second, ever-growing prompt history.
    async fn tool_continuation_for_trigger(
        &self,
        session_id: &str,
        root_turn_id: Option<&str>,
        trigger_event_id: Option<&str>,
        retired_observation_ids: &BTreeSet<String>,
    ) -> Result<ToolContinuationEnvelope, DynError> {
        let Some(trigger_event_id) = trigger_event_id else {
            return Ok(ToolContinuationEnvelope::default());
        };
        let trigger = self
            .store
            .query(QueryFilter {
                event_id: Some(trigger_event_id.to_string()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .next();
        let Some(trigger_attempt_id) = trigger
            .as_ref()
            .and_then(|event| event.payload.get("attempt_id"))
            .and_then(|value| value.as_str())
        else {
            return Ok(ToolContinuationEnvelope::default());
        };
        let events = self
            .store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                root_turn_id: root_turn_id.map(ToOwned::to_owned),
                types: vec![TYPE_AGENT_CALL.to_string(), TYPE_TOOL_OUTPUT.to_string()],
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..Default::default()
            })
            .await?;
        let turn_events = events
            .iter()
            .filter(|event| {
                event
                    .payload
                    .get("attempt_id")
                    .and_then(|value| value.as_str())
                    == Some(trigger_attempt_id)
            })
            .collect::<Vec<_>>();
        let mut outputs = HashMap::<(String, String), Event>::new();
        for event in &turn_events {
            if event.event_type != TYPE_TOOL_OUTPUT {
                continue;
            }
            let Some(attempt_id) = event
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            let Some(tool_call_id) = event
                .payload
                .get("tool_call_id")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            outputs.insert(
                (attempt_id.to_string(), tool_call_id.to_string()),
                (*event).clone(),
            );
        }

        let mut continuation = ToolContinuationEnvelope::default();
        for event in &turn_events {
            if event.topic != "chat/assistant_call" {
                continue;
            }
            let Some(attempt_id) = event
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            let calls_value = event
                .payload
                .get("continuation_tool_calls")
                // Read Events written before
                // the one-shot continuation envelope replaced turn transcripts.
                .or_else(|| event.payload.get("transcript_tool_calls"))
                .or_else(|| event.payload.get("tool_calls"));
            let Some(calls_value) = calls_value else {
                continue;
            };
            let calls = retain_pending_continuation_calls(
                attempt_id,
                serde_json::from_value::<Vec<crate::llm::ToolCall>>(calls_value.clone())?,
                &outputs,
                retired_observation_ids,
            );
            if calls.is_empty() {
                continue;
            }

            if let Some(provider_continuation) = event
                .payload
                .get("provider_continuation")
                .and_then(|value| {
                    serde_json::from_value::<ProviderContinuation>(value.clone()).ok()
                })
            {
                continuation
                    .messages
                    .push(provider_continuation_message(provider_continuation)?);
            }
            continuation.messages.push(Message {
                role: "assistant".to_string(),
                content: event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(calls.clone()),
            });
            for call in calls {
                let Some(output) = outputs.get(&(attempt_id.to_string(), call.id.clone())) else {
                    continue;
                };
                continuation.delivered_output_ids.insert(output.id.clone());
                continuation
                    .messages
                    .push(self.standard_tool_result_message(&call, output));
                if let Some(items) = output
                    .payload
                    .get("model_attachments")
                    .and_then(serde_json::Value::as_array)
                {
                    if let Some(message) = crate::model_input::attachment_message_from_metadata(
                        &self.message_attachment_root,
                        items,
                        self.model_input_config.request_limits(),
                    )
                    .await?
                    {
                        continuation.messages.push(message);
                    }
                }
            }
        }
        Ok(continuation)
    }

    fn standard_tool_result_message(&self, call: &crate::llm::ToolCall, output: &Event) -> Message {
        let text = output
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let status = output
            .payload
            .get("tool_status")
            .and_then(|value| value.as_str())
            .unwrap_or_else(|| infer_tool_status(text));
        let output_state = if text.trim().is_empty() {
            "empty"
        } else {
            "content"
        };
        let recallable = call.function.name != "context_tx"
            || text.starts_with("执行失败:")
            || text.starts_with("执行拒绝:");
        let observation_ref = recallable.then(|| self.context_engine.event_reference(output));
        let guidance = (status == "success" && output_state == "empty").then_some(
            "工具已成功完成但没有返回文本；不要仅因输出为空而重复调用。若工具具有副作用，请依据后续 file_change 或状态证据判断。",
        );
        let content = serde_json::to_string(&json!({
            "session_id": output.payload.get("session_id").and_then(|value| value.as_str()),
            "status": status,
            "output_state": output_state,
            "observation_ref": observation_ref,
            "tool_name": call.function.name,
            "result": text,
            "guidance": guidance,
        }))
        .unwrap_or_else(|_| text.to_string());
        Message {
            role: "tool".to_string(),
            content,
            name: None,
            tool_call_id: Some(call.id.clone()),
            tool_calls: None,
        }
    }

    async fn parent_session_for(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<Option<String>, DynError> {
        Ok(self
            .context_engine
            .build_context_encoding(context_id, session_id, &HashSet::new())
            .await?
            .parent_session_id)
    }

    async fn request_model_completion(
        &self,
        session_id: &str,
        attempt_id: &str,
        messages: Vec<Message>,
        tools: Vec<crate::llm::ToolDefinition>,
        prompt_measurement: Option<PromptTokenCount>,
    ) -> Result<ModelCompletion, ModelCompletionError> {
        let stream_context_id = self
            .context_id_for_session(session_id)
            .map_err(ModelCompletionError::internal)?;
        let model_input_usage = crate::model_input::inspect_model_input_messages(&messages)
            .map_err(ModelCompletionError::internal)?;
        let host_model_input_limits = self.model_input_config.request_limits();
        crate::model_input::validate_model_input_usage(
            model_input_usage,
            host_model_input_limits,
            "最终模型请求（宿主策略）",
        )
        .map_err(ModelCompletionError::input)?;
        self.admit_provider_circuit(&stream_context_id)
            .await
            .map_err(|failure| ModelCompletionError::provider(Box::new(failure) as DynError))?;
        let queue_timeout = std::time::Duration::from_secs(
            self.orchestrator_config
                .model_provider_queue_timeout_secs
                .max(1),
        );
        // Queueing and physical model execution have different clocks. A busy
        // semaphore is bounded independently; once admitted, active streaming
        // is governed by Provider idle timeout and an optional hard deadline.
        let queue_deadline = tokio::time::Instant::now() + queue_timeout;
        let _provider_slot = self
            .acquire_model_provider_slot(queue_deadline)
            .await
            .map_err(|failure| ModelCompletionError::provider(Box::new(failure) as DynError))?;
        let model_hard_deadline = self
            .orchestrator_config
            .model_attempt_hard_timeout_secs
            .filter(|seconds| *seconds > 0)
            .map(|seconds| {
                (
                    tokio::time::Instant::now() + std::time::Duration::from_secs(seconds),
                    seconds,
                )
            });
        let client = Arc::clone(&self.client);
        let (stream_tx, mut stream_rx) = tokio::sync::mpsc::unbounded_channel();
        let stream_bus = Arc::clone(&self.bus);
        let stream_session_id = session_id.to_string();
        let stream_attempt_id = attempt_id.to_string();
        let mut stream_route = Vec::new();
        self.append_activation_route(attempt_id, &mut stream_route);
        let objective_id = stream_route.iter().find_map(|(key, value)| {
            (key == "objective_id")
                .then(|| value.as_str().map(ToOwned::to_owned))
                .flatten()
        });
        // Resolve and persist the complete physical request identity before
        // opening the Provider stream. Retries and recovery can therefore
        // explain exactly which route, endpoint and account were used instead
        // of re-running mutable routing policy after the fact.
        let model_binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: stream_context_id.clone(),
                session_id: stream_session_id.clone(),
                attempt_id: stream_attempt_id.clone(),
                objective_id,
                required_capabilities: Vec::new(),
            })
            .await
            .map_err(|error| ModelCompletionError::internal(error.into()))?;
        let effective_model_input_limits =
            host_model_input_limits.stricter(model_binding.model_input_limits);
        stream_route.push(("model_binding".to_string(), json!(&model_binding)));
        let model_input_attributes = [
            (
                "model_input_attachment_count".to_string(),
                json!(model_input_usage.attachment_count),
            ),
            (
                "model_input_total_bytes".to_string(),
                json!(model_input_usage.total_bytes),
            ),
            (
                "model_input_largest_attachment_bytes".to_string(),
                json!(model_input_usage.largest_attachment_bytes),
            ),
            (
                "effective_model_input_limits".to_string(),
                json!(effective_model_input_limits),
            ),
            (
                "model_input_limit_source".to_string(),
                json!(if model_binding.model_input_limits.is_unspecified() {
                    "host-policy"
                } else {
                    "host-and-provider-model"
                }),
            ),
        ];
        if let Err(error) = crate::model_input::validate_model_input_usage(
            model_input_usage,
            effective_model_input_limits,
            if model_binding.model_input_limits.is_unspecified() {
                "最终模型请求（宿主策略；服务未声明附件上限）"
            } else {
                "最终模型请求（宿主与物理模型的有效上限）"
            },
        ) {
            let detail = error.to_string();
            persist_model_attempt_state(
                &stream_bus,
                &stream_context_id,
                &stream_session_id,
                &stream_attempt_id,
                &stream_route,
                "input_rejected",
                true,
                Some(&detail),
                &model_input_attributes,
            )
            .await
            .map_err(ModelCompletionError::persistence)?;
            return Err(ModelCompletionError::input(error));
        }
        persist_model_attempt_state(
            &stream_bus,
            &stream_context_id,
            &stream_session_id,
            &stream_attempt_id,
            &stream_route,
            "streaming",
            false,
            None,
            &model_input_attributes,
        )
        .await
        .map_err(ModelCompletionError::persistence)?;
        let reasoning_summary = Arc::new(Mutex::new(ModelReasoningSummaryAccumulator::default()));
        let forward_bus = Arc::clone(&stream_bus);
        let forward_session_id = stream_session_id.clone();
        let forward_context_id = stream_context_id.clone();
        let forward_attempt_id = stream_attempt_id.clone();
        let forward_route = stream_route.clone();
        let forward_reasoning_summary = Arc::clone(&reasoning_summary);
        let forward_prompt_measurement = prompt_measurement.clone();
        let timeout_prompt_measurement = prompt_measurement.clone();
        let stream_forwarder = tokio::spawn(async move {
            let stream_started_at = tokio::time::Instant::now();
            let mut text_delta_count = 0u64;
            let mut text_chars = 0usize;
            let mut reasoning_summary_delta_count = 0u64;
            let mut reasoning_summary_chars = 0usize;
            let mut first_text_delta_ms = None;
            while let Some(stream_event) = stream_rx.recv().await {
                match &stream_event {
                    crate::llm::ModelStreamEvent::TextDelta { text } => {
                        text_delta_count = text_delta_count.saturating_add(1);
                        text_chars = text_chars.saturating_add(text.chars().count());
                        forward_reasoning_summary
                            .lock()
                            .await
                            .public_text
                            .push_str(text);
                        first_text_delta_ms.get_or_insert_with(|| {
                            u64::try_from(stream_started_at.elapsed().as_millis())
                                .unwrap_or(u64::MAX)
                        });
                    }
                    crate::llm::ModelStreamEvent::ReasoningSummaryDelta { text } => {
                        reasoning_summary_delta_count =
                            reasoning_summary_delta_count.saturating_add(1);
                        reasoning_summary_chars =
                            reasoning_summary_chars.saturating_add(text.chars().count());
                        forward_reasoning_summary.lock().await.text.push_str(text);
                    }
                    crate::llm::ModelStreamEvent::ReasoningSummaryCompleted => {
                        if let Err(error) = persist_model_attempt_state(
                            &forward_bus,
                            &forward_context_id,
                            &forward_session_id,
                            &forward_attempt_id,
                            &forward_route,
                            "waiting_final_output",
                            false,
                            Some("provider reasoning item completed"),
                            &[],
                        )
                        .await
                        {
                            tracing::warn!(event_code = "orchestrator.model_stream.reasoning_completion_persist_failed", %error, "Failed to persist reasoning-completion state");
                        }
                    }
                    crate::llm::ModelStreamEvent::ProviderContinuation { continuation } => {
                        // This is opaque protocol state, not a presentation
                        // event. Keep it inside the physical Attempt and never
                        // broadcast raw reasoning to Dashboard/TUI clients.
                        forward_reasoning_summary.lock().await.provider_continuation =
                            Some(continuation.clone());
                        continue;
                    }
                    crate::llm::ModelStreamEvent::Usage { usage } => {
                        let mut summary = forward_reasoning_summary.lock().await;
                        summary.usage.merge_from(usage);
                    }
                    crate::llm::ModelStreamEvent::Completed => {
                        forward_reasoning_summary.lock().await.complete = true;
                        if let Err(error) = persist_model_attempt_state(
                            &forward_bus,
                            &forward_context_id,
                            &forward_session_id,
                            &forward_attempt_id,
                            &forward_route,
                            "settling",
                            false,
                            Some("provider response completed; Runtime is classifying output"),
                            &[],
                        )
                        .await
                        {
                            tracing::warn!(event_code = "orchestrator.model_stream.response_completion_persist_failed", %error, "Failed to persist model-response completion state");
                        }
                        tracing::info!(
                            session_id = %forward_session_id,
                            attempt_id = %forward_attempt_id,
                            text_delta_count,
                            text_chars,
                            reasoning_summary_delta_count,
                            reasoning_summary_chars,
                            first_text_delta_ms,
                            total_stream_ms = u64::try_from(stream_started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
                            event_code = "orchestrator.model_stream.completed",
                            "Native model stream completed"
                        );
                    }
                    crate::llm::ModelStreamEvent::Failed { message } => {
                        forward_reasoning_summary.lock().await.failure = Some(message.clone());
                    }
                    _ => {}
                }
                let mut payload = vec![
                    ("context_id".to_string(), json!(&forward_context_id)),
                    ("session_id".to_string(), json!(&forward_session_id)),
                    ("attempt_id".to_string(), json!(&forward_attempt_id)),
                    ("stream".to_string(), json!(stream_event)),
                ];
                payload.extend(forward_route.clone());
                let event = Event::new(
                    format!(
                        "model_stream_{}",
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    ),
                    "Model-Provider".to_string(),
                    "runtime_ephemeral".to_string(),
                    "runtime/model_stream".to_string(),
                    payload.into_iter().collect(),
                );
                if let Err(error) = forward_bus.publish_ephemeral(event).await {
                    tracing::debug!(event_code = "orchestrator.model_stream.ephemeral_event_publish_failed", %error, "Failed to publish an ephemeral model-stream Event");
                }
            }
            persist_model_usage(
                &forward_bus,
                &forward_context_id,
                &forward_session_id,
                &forward_attempt_id,
                &forward_route,
                &forward_reasoning_summary,
                forward_prompt_measurement.as_ref(),
            )
            .await?;
            persist_model_reasoning_summary(
                &forward_bus,
                &forward_context_id,
                &forward_session_id,
                &forward_attempt_id,
                &forward_route,
                &forward_reasoning_summary,
                false,
            )
            .await
        });
        let result = if client.supports_async_cancellation() {
            // Protocol-native clients are fully asynchronous. Keeping their
            // future in this task means timeout/cancellation drops the reqwest
            // future itself and therefore closes the underlying HTTP request.
            let completion = client.create_completion_bound_stream(
                &model_binding,
                messages,
                tools,
                prompt_measurement,
                stream_tx,
            );
            if let Some((deadline, seconds)) = model_hard_deadline {
                match tokio::time::timeout_at(deadline, completion).await {
                    Ok(result) => result,
                    Err(_) => {
                        let failure = ModelFailure::new(
                            ModelFailureKind::HardDeadlineExceeded,
                            format!("model hard deadline exceeded after {seconds}s"),
                        );
                        stream_forwarder.abort();
                        let _ = stream_forwarder.await;
                        persist_model_usage(
                            &stream_bus,
                            &stream_context_id,
                            &stream_session_id,
                            &stream_attempt_id,
                            &stream_route,
                            &reasoning_summary,
                            timeout_prompt_measurement.as_ref(),
                        )
                        .await
                        .map_err(ModelCompletionError::persistence)?;
                        self.remember_prompt_usage_anchor(
                            &stream_context_id,
                            &stream_session_id,
                            &stream_attempt_id,
                            timeout_prompt_measurement.as_ref(),
                            &reasoning_summary,
                        )
                        .await;
                        persist_model_reasoning_summary(
                            &stream_bus,
                            &stream_context_id,
                            &stream_session_id,
                            &stream_attempt_id,
                            &stream_route,
                            &reasoning_summary,
                            true,
                        )
                        .await
                        .map_err(|persist_error| {
                            ModelCompletionError::persistence(persist_error)
                        })?;
                        // Partial reasoning is progress evidence, not a
                        // recovery signal.  The physical request still
                        // failed, so Objectives waiting on this Provider must
                        // enter the same durable reconnect loop.
                        self.record_provider_failure(&stream_context_id, &failure)
                            .await;
                        return Err(ModelCompletionError::with_summary_from(
                            Box::new(failure) as DynError,
                            &reasoning_summary,
                            ModelCompletionErrorOrigin::Provider,
                        )
                        .await);
                    }
                }
            } else {
                completion.await
            }
        } else {
            // Compatibility boundary for custom clients and test doubles that
            // may synchronously block inside an async method. A Tokio timeout
            // cannot pre-empt such code, so keep it off the Runtime workers.
            let (model_tx, model_rx) = tokio::sync::oneshot::channel();
            let thread_model_binding = model_binding.clone();
            std::thread::Builder::new()
                .name(format!("morphz-llm-{attempt_id}"))
                .spawn(move || {
                    let result = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| Box::new(error) as DynError)
                        .and_then(|runtime| {
                            runtime.block_on(client.create_completion_bound_stream(
                                &thread_model_binding,
                                messages,
                                tools,
                                prompt_measurement,
                                stream_tx,
                            ))
                        });
                    let _ = model_tx.send(result);
                })
                .map_err(|error| ModelCompletionError::internal(Box::new(error) as DynError))?;
            if let Some((deadline, seconds)) = model_hard_deadline {
                match tokio::time::timeout_at(deadline, model_rx).await {
                    Ok(Ok(result)) => result,
                    Ok(Err(error)) => Err(error.into()),
                    Err(_) => {
                        let failure = ModelFailure::new(
                            ModelFailureKind::HardDeadlineExceeded,
                            format!("model hard deadline exceeded after {seconds}s"),
                        );
                        stream_forwarder.abort();
                        let _ = stream_forwarder.await;
                        persist_model_usage(
                            &stream_bus,
                            &stream_context_id,
                            &stream_session_id,
                            &stream_attempt_id,
                            &stream_route,
                            &reasoning_summary,
                            timeout_prompt_measurement.as_ref(),
                        )
                        .await
                        .map_err(ModelCompletionError::persistence)?;
                        self.remember_prompt_usage_anchor(
                            &stream_context_id,
                            &stream_session_id,
                            &stream_attempt_id,
                            timeout_prompt_measurement.as_ref(),
                            &reasoning_summary,
                        )
                        .await;
                        persist_model_reasoning_summary(
                            &stream_bus,
                            &stream_context_id,
                            &stream_session_id,
                            &stream_attempt_id,
                            &stream_route,
                            &reasoning_summary,
                            true,
                        )
                        .await
                        .map_err(|persist_error| {
                            ModelCompletionError::persistence(persist_error)
                        })?;
                        self.record_provider_failure(&stream_context_id, &failure)
                            .await;
                        return Err(ModelCompletionError::with_summary_from(
                            Box::new(failure) as DynError,
                            &reasoning_summary,
                            ModelCompletionErrorOrigin::Provider,
                        )
                        .await);
                    }
                }
            } else {
                model_rx
                    .await
                    .map_err(|error| error.into())
                    .and_then(|value| value)
            }
        };
        let forward_result = stream_forwarder.await;
        self.remember_prompt_usage_anchor(
            &stream_context_id,
            &stream_session_id,
            &stream_attempt_id,
            timeout_prompt_measurement.as_ref(),
            &reasoning_summary,
        )
        .await;
        let outcome = match (result, forward_result) {
            (Err(error), _) => Err(ModelCompletionError::with_summary_from(
                error,
                &reasoning_summary,
                ModelCompletionErrorOrigin::Provider,
            )
            .await),
            (Ok(_), Err(error)) => Err(ModelCompletionError::with_summary_from(
                Box::new(error) as DynError,
                &reasoning_summary,
                ModelCompletionErrorOrigin::RuntimeInternal,
            )
            .await),
            (Ok(_), Ok(Err(error))) => Err(ModelCompletionError::with_summary_from(
                error,
                &reasoning_summary,
                ModelCompletionErrorOrigin::RuntimePersistence,
            )
            .await),
            (Ok(response), Ok(Ok(()))) => Ok(ModelCompletion {
                response,
                provider_continuation: reasoning_summary.lock().await.provider_continuation.clone(),
            }),
        };
        match &outcome {
            Ok(_) => self.record_provider_success().await,
            // A completed response that contains provider-authored reasoning
            // but no final text/tool call is not a Provider outage.  It is
            // the normal "reasoning-only" boundary used by long-thinking
            // models (notably GLM): the caller will append the durable
            // summary and immediately issue a continuation request.
            //
            // Treating this parser-level empty-response error as a Provider
            // failure opens the shared circuit *before* that continuation can
            // be submitted.  The Objective is then woken later from its base
            // Context, which loses the in-memory continuation history and
            // causes the model to reason about the same work repeatedly.
            Err(error)
                if error.origin == ModelCompletionErrorOrigin::Provider
                    && error.failure().kind == ModelFailureKind::EmptyResponse =>
            {
                self.record_provider_success().await;
            }
            Err(error)
                if error.origin == ModelCompletionErrorOrigin::Provider
                    && error.failure().kind.is_request_scoped_latency()
                    && (!error.reasoning_summary.trim().is_empty()
                        || !error.partial_text.trim().is_empty()) =>
            {
                // The caller can continue from durable reasoning or the
                // already received public-text prefix. Do not schedule a
                // competing Objective wake-up for the same Activation.
            }
            Err(error) if error.origin == ModelCompletionErrorOrigin::Provider => {
                // A real transport/provider failure may also have emitted a
                // partial reasoning fragment.  Keep the recovery circuit for
                // that case: the next attempt must wait for a healthy
                // Provider rather than mistake partial data for completion.
                let failure = error.failure();
                self.record_provider_failure(&stream_context_id, &failure)
                    .await;
            }
            Err(_) => {}
        }
        outcome
    }

    async fn remember_prompt_usage_anchor(
        &self,
        context_id: &str,
        session_id: &str,
        attempt_id: &str,
        measurement: Option<&PromptTokenCount>,
        accumulator: &Arc<Mutex<ModelReasoningSummaryAccumulator>>,
    ) {
        let Some(measurement) = measurement else {
            return;
        };
        let input_tokens = accumulator.lock().await.usage.input_tokens;
        let Some(actual_input_tokens) = input_tokens.and_then(|value| usize::try_from(value).ok())
        else {
            return;
        };
        let counter_source = local_counter_source(&measurement.source);
        self.prompt_usage_anchors.insert(
            (
                context_id.to_string(),
                session_id.to_string(),
                measurement.model.clone(),
                counter_source.clone(),
            ),
            DurablePromptUsageAnchor {
                actual_input_tokens,
                local_base_estimate_tokens: measurement.base_estimate_tokens,
                counter_source,
                attempt_id: attempt_id.to_string(),
            },
        );
    }

    async fn restore_prompt_usage_anchor(
        &self,
        context_id: &str,
        session_id: &str,
        model: &str,
        counter_source: &str,
    ) -> Result<Option<DurablePromptUsageAnchor>, DynError> {
        let key = (
            context_id.to_string(),
            session_id.to_string(),
            model.to_string(),
            counter_source.to_string(),
        );
        if let Some(anchor) = self.prompt_usage_anchors.get(&key) {
            return Ok(Some(anchor.clone()));
        }

        let events = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                session_id: Some(session_id.to_string()),
                topic: Some("runtime/model_usage".to_string()),
                latest_k: Some(64),
                ..Default::default()
            })
            .await?;
        let anchor = events.into_iter().rev().find_map(|event| {
            let event_model = event.payload.get("model")?.as_str()?;
            let event_source = event.payload.get("counter_source")?.as_str()?;
            if event_model != model || local_counter_source(event_source) != counter_source {
                return None;
            }
            Some(DurablePromptUsageAnchor {
                actual_input_tokens: usize::try_from(
                    event.payload.get("usage")?.get("input_tokens")?.as_u64()?,
                )
                .ok()?,
                local_base_estimate_tokens: usize::try_from(
                    event.payload.get("local_base_estimate_tokens")?.as_u64()?,
                )
                .ok()?,
                counter_source: counter_source.to_string(),
                attempt_id: event.payload.get("attempt_id")?.as_str()?.to_string(),
            })
        });
        if let Some(anchor) = anchor.as_ref() {
            self.prompt_usage_anchors.insert(key, anchor.clone());
        }
        Ok(anchor)
    }

    /// Measures the complete candidate work request with the current protocol client's declared
    /// TokenCounter and writes the result and accuracy into this turn's Context Encoding. Counting
    /// failures never block the agent.
    async fn refresh_context_pressure(
        &self,
        context: &mut ContextView,
        messages: &mut [Message],
        tools: &[crate::llm::ToolDefinition],
        context_message_prefix: &str,
        context_overlay: EvaluationContextOverlay<'_>,
    ) -> Result<Option<PromptTokenCount>, DynError> {
        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config
                .model_provider_queue_timeout_secs
                .clamp(1, 15),
        );
        let measurement_deadline = tokio::time::Instant::now() + deadline;
        let token_scope = format!("{}:{}", context.context_id, context.active_session_id);
        let measurement = tokio::time::timeout_at(measurement_deadline, async {
            self.client
                .count_prompt_tokens(&token_scope, messages, tools)
                .await
        })
        .await;

        let measurement = match measurement {
            Ok(Ok(Some(mut count))) => {
                let counter_source = local_counter_source(&count.source);
                if count.accuracy != PromptTokenAccuracy::Exact {
                    if let Some(anchor) = self
                        .restore_prompt_usage_anchor(
                            &context.context_id,
                            &context.active_session_id,
                            &count.model,
                            &counter_source,
                        )
                        .await?
                    {
                        count.tokens = apply_prompt_estimate_delta(
                            anchor.actual_input_tokens,
                            count.base_estimate_tokens,
                            anchor.local_base_estimate_tokens,
                        );
                        count.source = format!("{counter_source}+durable-usage-anchor");
                        count.accuracy = PromptTokenAccuracy::UsageCalibratedEstimate;
                        tracing::debug!(
                            context_id = %context.context_id,
                            session_id = %context.active_session_id,
                            anchor_attempt_id = %anchor.attempt_id,
                            anchor_source = %anchor.counter_source,
                            event_code = "orchestrator.context_pressure.usage_anchor_applied",
                            "Calibrated Prompt pressure with a persisted Provider-usage anchor"
                        );
                    }
                }
                self.context_engine
                    .apply_prompt_token_count(context, &count)
                    .await?;
                self.prompt_pressure_measurements.insert(
                    (
                        context.context_id.clone(),
                        context.active_session_id.clone(),
                    ),
                    PromptPressureMeasurement {
                        count: count.clone(),
                        context_version: context.state.version,
                    },
                );
                if let Some(context_message) = messages.get_mut(1) {
                    context_message.content = compose_context_message(
                        context_message_prefix,
                        &context.sexpr,
                        context_overlay,
                    )?;
                }
                context.attribution =
                    attribute_prompt_components(context, messages, tools, count.tokens);
                tracing::info!(
                    context_id = %context.context_id,
                    session_id = %context.active_session_id,
                    model = %count.model,
                    prompt_tokens = count.tokens,
                    source = %count.source,
                    accuracy = count.accuracy.as_str(),
                    pressure = %context.pressure.level,
                    event_code = "orchestrator.context_pressure.remeasured",
                    "Context pressure remeasured from the complete Prompt"
                );
                Some(count)
            }
            Ok(Ok(None)) => {
                tracing::debug!(
                    session_id = %context.active_session_id,
                    event_code = "orchestrator.prompt_measurement.client_unsupported",
                    "Current LLM Client does not provide Prompt-token measurement; retaining the Context-local estimate"
                );
                None
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    session_id = %context.active_session_id,
                    error = %error,
                    event_code = "orchestrator.prompt_measurement.failed",
                    "Prompt-token measurement failed; retaining the Context-local estimate"
                );
                None
            }
            Err(_) => {
                tracing::warn!(
                    session_id = %context.active_session_id,
                    timeout_secs = deadline.as_secs(),
                    event_code = "orchestrator.prompt_measurement.timed_out",
                    "Prompt-token measurement timed out; retaining the Context-local estimate"
                );
                None
            }
        };
        Ok(measurement)
    }

    /// Count the physical request produced by a bounded recovery projection
    /// without replacing the logical pressure of the full active Context.
    async fn count_projected_prompt_tokens(
        &self,
        context: &ContextView,
        messages: &[Message],
        tools: &[crate::llm::ToolDefinition],
    ) -> Option<PromptTokenCount> {
        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config
                .model_provider_queue_timeout_secs
                .clamp(1, 15),
        );
        let token_scope = format!(
            "{}:{}:critical-maintenance",
            context.context_id, context.active_session_id
        );
        match tokio::time::timeout(
            deadline,
            self.client
                .count_prompt_tokens(&token_scope, messages, tools),
        )
        .await
        {
            Ok(Ok(Some(count))) => Some(count),
            Ok(Ok(None)) => None,
            Ok(Err(error)) => {
                tracing::warn!(
                    context_id = %context.context_id,
                    session_id = %context.active_session_id,
                    %error,
                    event_code = "orchestrator.maintenance_prompt_measurement.failed",
                    "Bounded maintenance Prompt-token measurement failed"
                );
                None
            }
            Err(_) => {
                tracing::warn!(
                    context_id = %context.context_id,
                    session_id = %context.active_session_id,
                    timeout_secs = deadline.as_secs(),
                    event_code = "orchestrator.maintenance_prompt_measurement.timed_out",
                    "Bounded maintenance Prompt-token measurement timed out"
                );
                None
            }
        }
    }

    /// Resume a model decision that crossed the durable assistant-call boundary before the
    /// owning Thread Activation reached a terminal state. Re-asking the model here could produce a new
    /// set of call IDs and repeat an external side effect, so recovery always reuses the exact
    /// persisted plan. `execute_tool_calls` also reuses any already durable output events.
    async fn persisted_objective_completion_call(
        &self,
        context_id: &str,
        session_id: &str,
        activation_id: &str,
    ) -> Result<Option<(Event, crate::llm::ToolCall, Event)>, DynError> {
        let calls = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                activation_id: Some(activation_id.to_string()),
                topic: Some("chat/assistant_call".to_string()),
                latest_k: Some(32),
                ..Default::default()
            })
            .await?;
        for event in calls.into_iter().rev() {
            let tool_calls = serde_json::from_value::<Vec<crate::llm::ToolCall>>(
                event
                    .payload
                    .get("tool_calls")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )?;
            for call in tool_calls {
                let arguments =
                    serde_json::from_str::<serde_json::Value>(&call.function.arguments).ok();
                let completed = call.function.name == "objective_update"
                    && arguments
                        .as_ref()
                        .and_then(|arguments| arguments.get("status"))
                        .and_then(serde_json::Value::as_str)
                        == Some("completed");
                if !completed {
                    continue;
                }
                let output_id = format!("output_{activation_id}_{}", call.id);
                let output = self
                    .context_engine
                    .find_event(context_id, &output_id)
                    .await?;
                let output = if let Some(output) = output {
                    output
                } else {
                    let Some(binding) =
                        self.objective_evaluations.get_for_activation(activation_id)
                    else {
                        continue;
                    };
                    let Some(supervisor) = self.objective_supervisor.as_ref() else {
                        continue;
                    };
                    let Some(objective) = supervisor.get(&binding.objective_id).await? else {
                        continue;
                    };
                    let Some(intent) = objective.completion_intent.as_ref() else {
                        continue;
                    };
                    let call_objective_id = arguments
                        .as_ref()
                        .and_then(|arguments| arguments.get("objective_id"))
                        .and_then(serde_json::Value::as_str);
                    if call_objective_id != Some(objective.id.as_str())
                        || intent.activation_id != activation_id
                        || intent.evaluation_id != binding.evaluation_id
                    {
                        continue;
                    }
                    let mut payload = vec![
                        ("context_id".to_string(), json!(context_id)),
                        ("session_id".to_string(), json!(session_id)),
                        ("attempt_id".to_string(), json!(activation_id)),
                        ("tool_call_id".to_string(), json!(call.id)),
                        ("caused_by".to_string(), json!(call.id)),
                        ("tool_name".to_string(), json!(call.function.name)),
                        ("tool_status".to_string(), json!("success")),
                        ("wake_policy".to_string(), json!("none")),
                        ("output_empty".to_string(), json!(false)),
                        (
                            "text".to_string(),
                            json!(json!({
                                "status": "completion_prepared",
                                "objective_id": objective.id,
                                "revision": objective.revision,
                                "objective_status": objective.status,
                                "objective_phase": "finalizing",
                                "evidence_refs": intent.evidence_refs,
                                "next_action": "在当前 Activation 中返回完整、无工具的最终报告；最终回复将与 Objective、Activation、Thread 和 ThreadOutcome 原子提交。"
                            })
                            .to_string()),
                        ),
                        ("objective_id".to_string(), json!(objective.id)),
                        (
                            "objective_evaluation_id".to_string(),
                            json!(binding.evaluation_id),
                        ),
                        (
                            "objective_revision".to_string(),
                            json!(objective.revision),
                        ),
                        ("recovered".to_string(), json!(true)),
                    ];
                    self.append_activation_route(activation_id, &mut payload);
                    let output = Event::new(
                        output_id,
                        "Runtime-Recovery".to_string(),
                        TYPE_TOOL_OUTPUT.to_string(),
                        "chat/tool_output".to_string(),
                        payload.into_iter().collect(),
                    );
                    self.store.append(output.clone()).await?;
                    self.bus.dispatch_persisted(output.clone()).await?;
                    output
                };
                let prepared = output
                    .payload
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                    .and_then(|receipt| {
                        receipt
                            .get("status")
                            .and_then(serde_json::Value::as_str)
                            .map(|status| status == "completion_prepared")
                    })
                    .unwrap_or(false);
                if prepared {
                    return Ok(Some((event, call, output)));
                }
            }
        }
        Ok(None)
    }

    async fn resume_persisted_activation(
        &self,
        session_id: &str,
        activation: &ThreadActivationRecord,
    ) -> Result<bool, DynError> {
        let assistant_event_id = format!("call_{}", activation.id);
        let final_event_id = format!("call_{}_final", activation.id);
        let assistant_call = self
            .context_engine
            .find_event(&activation.context_id, &final_event_id)
            .await?
            .or(self
                .context_engine
                .find_event(&activation.context_id, &assistant_event_id)
                .await?);
        let Some(assistant_call) = assistant_call else {
            return Ok(false);
        };
        if assistant_call.topic != "chat/assistant_call" {
            return Err(format!(
                "Thread Activation '{}' 的恢复边界 '{}' 不是 assistant_call",
                activation.id, assistant_event_id
            )
            .into());
        }

        let calls_value = assistant_call
            .payload
            .get("tool_calls")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let calls = serde_json::from_value::<Vec<crate::llm::ToolCall>>(calls_value)?;
        let response = crate::llm::Response {
            content: assistant_call
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            tool_calls: calls
                .iter()
                .map(|call| crate::llm::ToolCallRepr {
                    id: call.id.clone(),
                    r#type: call.r#type.clone(),
                    func_name: call.function.name.clone(),
                    arguments: call.function.arguments.clone(),
                })
                .collect(),
        };

        if assistant_call
            .payload
            .get("terminal_outcome")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            let decision = classify_terminal_response(&response)
                .map_err(|error| -> DynError { error.into() })?
                .ok_or_else(|| {
                    format!(
                        "Thread Activation '{}' 的持久化终态响应不合法",
                        activation.id
                    )
                })?;
            let parent = self
                .parent_session_for(&activation.context_id, session_id)
                .await?;
            tracing::info!(
                activation_id = %activation.id,
                disposition = decision.disposition(),
                event_code = "orchestrator.evaluation.recovered_terminal_assistant_call",
                "Recovered Evaluation terminal state from a persisted assistant_call"
            );
            match decision {
                TerminalDecision::Deliver(content) => {
                    let model_attempt_id = assistant_call
                        .payload
                        .get("model_attempt_id")
                        .and_then(|value| value.as_str());
                    self.publish_reply_for_model_attempt(
                        session_id,
                        &activation.id,
                        model_attempt_id,
                        content,
                        parent.as_deref(),
                    )
                    .await?;
                }
                TerminalDecision::NoReply(_) => {
                    self.publish_no_reply(session_id, &activation.id, parent.as_deref())
                        .await?;
                }
            }
            return Ok(true);
        }

        if response.tool_calls.is_empty() {
            return Err(format!(
                "Thread Activation '{}' 的持久化 assistant_call 既非终态回复也没有工具调用",
                activation.id
            )
            .into());
        }
        let unavailable_names = assistant_call
            .payload
            .get("unavailable_tool_names")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_default()
            .into_iter()
            .collect::<HashSet<_>>();
        let allowed_tool_names = response
            .tool_calls
            .iter()
            .map(|call| call.func_name.clone())
            .filter(|name| !unavailable_names.contains(name))
            .collect::<HashSet<_>>();
        let continuation_tool_calls = assistant_call
            .payload
            .get("continuation_tool_calls")
            .or_else(|| assistant_call.payload.get("transcript_tool_calls"))
            .and_then(|value| {
                serde_json::from_value::<Vec<crate::llm::ToolCall>>(value.clone()).ok()
            });
        let model_attempt_id = assistant_call
            .payload
            .get("model_attempt_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let context_tx_allowed = assistant_call
            .payload
            .get("context_tx_rejection_status")
            .and_then(|value| value.as_str())
            != Some("budget-exhausted");
        let phase = assistant_call
            .payload
            .get("phase")
            .and_then(|value| value.as_str())
            .unwrap_or("work");
        tracing::info!(
            activation_id = %activation.id,
            tool_calls = response.tool_calls.len(),
            event_code = "orchestrator.tool_plan.recovered_from_assistant_call",
            "Recovered the tool-execution plan from a persisted assistant_call"
        );
        self.execute_tool_calls(
            session_id,
            &activation.id,
            response,
            phase,
            ToolExecutionOptions {
                context_tx_allowed,
                wake_on_output: true,
                plan_execution_id: None,
                continuation_tool_calls,
                allowed_tool_names,
                record_assistant_call: false,
                model_attempt_id,
                provider_continuation: None,
            },
        )
        .await?;
        Ok(true)
    }

    async fn model_attachment_message(
        &self,
        context_id: &str,
        root_turn_id: &str,
    ) -> Result<Option<Message>, DynError> {
        let Some(event) = self
            .context_engine
            .find_event(context_id, root_turn_id)
            .await?
        else {
            return Ok(None);
        };
        let mut items = event
            .payload
            .get("attachments")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        items.extend(
            self.resolve_model_visible_attachment_metadata(
                context_id,
                &serde_json::Value::Object(event.payload.clone()),
            )
            .await?,
        );
        let mut seen = HashSet::new();
        items.retain(|item| {
            let key = (
                item.get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                item.get("sha256")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            seen.insert(key)
        });
        crate::model_input::attachment_message_from_metadata(
            &self.message_attachment_root,
            &items,
            self.model_input_config.request_limits(),
        )
        .await
    }

    async fn resolve_model_visible_attachment_metadata(
        &self,
        context_id: &str,
        value: &serde_json::Value,
    ) -> Result<Vec<serde_json::Value>, DynError> {
        let mut stored = Vec::new();
        for reference in model_visible_attachment_references(value) {
            let event = self
                .context_engine
                .find_event(context_id, &reference.source_event_id)
                .await?
                .ok_or_else(|| {
                    format!("模型附件来源 Event '{}' 不存在", reference.source_event_id)
                })?;
            if event.event_type != TYPE_TOOL_OUTPUT {
                return Err(format!(
                    "模型附件来源 Event '{}' 不是工具输出",
                    reference.source_event_id
                )
                .into());
            }
            let item = event
                .payload
                .get("model_attachments")
                .and_then(serde_json::Value::as_array)
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id").and_then(serde_json::Value::as_str)
                            == Some(reference.id.as_str())
                            && item.get("sha256").and_then(serde_json::Value::as_str)
                                == Some(reference.sha256.as_str())
                    })
                })
                .cloned()
                .ok_or_else(|| format!("模型附件引用 '{}' 与来源 Event 不一致", reference.id))?;
            stored.push(item);
        }
        Ok(stored)
    }

    fn run_attempt<'a>(
        &'a self,
        session_id: &'a str,
        activation: &'a ThreadActivationRecord,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), DynError>> + Send + 'a>>
    {
        Box::pin(async move {
            loop {
                match self.run_attempt_inner(session_id, activation).await {
                    Err(error)
                        if error
                            .downcast_ref::<RefreshContextAfterConcurrentMaintenance>()
                            .is_some() =>
                    {
                        continue;
                    }
                    result => return result,
                }
            }
        })
    }

    async fn run_attempt_inner(
        &self,
        session_id: &str,
        activation: &ThreadActivationRecord,
    ) -> Result<(), DynError> {
        let attempt_id = activation.id.clone();
        let mut persisted_assistant_call = self
            .context_engine
            .find_event(&activation.context_id, &format!("call_{}", activation.id))
            .await?;
        if persisted_assistant_call.is_none() {
            if let Some(parent_activation_id) = activation.parent_activation_id.as_deref() {
                persisted_assistant_call = self
                    .context_engine
                    .find_event(
                        &activation.context_id,
                        &format!("call_{parent_activation_id}"),
                    )
                    .await?;
            }
        }
        // A durable continuation does not always retain the originating
        // Activation as its direct parent. Action Group settlement is the
        // canonical example: the barrier Event owns the next Signal, while
        // the Group remains the authority that links it to the assistant plan
        // which selected the physical tools. Resolve that exact durable link
        // before falling back to routing hints carried by the trigger Event.
        if persisted_assistant_call.is_none() {
            if let Some(trigger) = self
                .context_engine
                .find_event(&activation.context_id, &activation.trigger_event_id)
                .await?
            {
                if let Some(group_id) = trigger
                    .payload
                    .get("action_group_id")
                    .and_then(serde_json::Value::as_str)
                {
                    if let Some(group_store) = self.action_groups.as_ref() {
                        if let Some(group) = group_store.get_action_group(group_id).await? {
                            persisted_assistant_call = self
                                .context_engine
                                .find_event(&activation.context_id, &group.assistant_call_event_id)
                                .await?;
                        }
                    }
                }
                if persisted_assistant_call.is_none() {
                    if let Some(origin_activation_id) = trigger
                        .payload
                        .get("activation_id")
                        .or_else(|| trigger.payload.get("attempt_id"))
                        .and_then(serde_json::Value::as_str)
                    {
                        persisted_assistant_call = self
                            .context_engine
                            .find_event(
                                &activation.context_id,
                                &format!("call_{origin_activation_id}"),
                            )
                            .await?;
                    }
                }
            }
        }
        let persisted_final_response = self
            .context_engine
            .find_event(
                &activation.context_id,
                &format!("call_{}_final", activation.id),
            )
            .await?;
        let persisted_physical_plan = persisted_assistant_call
            .as_ref()
            .is_some_and(event_contains_physical_tool_plan);
        let persisted_terminal = persisted_final_response
            .as_ref()
            .or(persisted_assistant_call.as_ref())
            .is_some_and(|event| {
                event
                    .payload
                    .get("terminal_outcome")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            });
        let root_dispatch_mode = self
            .context_engine
            .find_event(&activation.context_id, &activation.root_turn_id)
            .await?
            .and_then(|event| {
                event
                    .payload
                    .get("dispatch_mode")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
            });
        let parallel_dialogue = root_dispatch_mode.as_deref() == Some("parallel");
        let dialogue_gate = self.dialogue_thread_gate(session_id);
        let dialogue_bound = if parallel_dialogue {
            false
        } else if matches!(
            activation.trigger_kind.as_str(),
            "chat/user_message" | "chat/dialogue_retry"
        ) && !persisted_physical_plan
        {
            dialogue_gate.acquire(&activation.root_turn_id).await;
            true
        } else {
            dialogue_gate.owns(&activation.root_turn_id).await
        };
        let mut dialogue_lease = dialogue_bound.then(|| {
            DialogueThreadLease::new(Arc::clone(&dialogue_gate), activation.root_turn_id.clone())
        });
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread 需要持久化 SessionStore")?;
        let mut thread = session_store
            .get_thread_by_root(&activation.root_turn_id)
            .await?
            .ok_or_else(|| format!("Root Turn '{}' 缺少 Thread", activation.root_turn_id))?;
        let initial_objective_closure_review = activation.trigger_event_id
            == activation.root_turn_id
            && self
                .context_engine
                .find_event(&activation.context_id, &activation.root_turn_id)
                .await?
                .is_some_and(|event| {
                    event
                        .payload
                        .get("objective_phase")
                        .and_then(serde_json::Value::as_str)
                        == Some("closure-review")
                });
        // A physical assistant plan is the durable boundary at which the
        // current DialogueTurn becomes an Execution Thread. Gate ownership is
        // intentionally irrelevant: Context-maintenance continuations remain
        // DialogueTurns even if another durable turn is queued.
        if thread.kind == ThreadKind::DialogueTurn && persisted_physical_plan {
            match session_store
                .update_thread(
                    &thread.id,
                    thread.revision,
                    Some(ThreadKind::Execution),
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await?
            {
                ThreadMutation::Updated(updated) => thread = updated,
                ThreadMutation::Conflict { current } if current.kind == ThreadKind::Execution => {
                    thread = current;
                }
                ThreadMutation::Conflict { current } => {
                    return Err(format!(
                        "Thread '{}' 的物理执行升级发生并发冲突：当前类型为 '{}'",
                        current.id,
                        current.kind.as_str()
                    )
                    .into());
                }
                ThreadMutation::NotFound => {
                    return Err(format!("Thread '{}' 在物理执行升级时消失", thread.id).into());
                }
            }
        }
        let thread_kind = thread.kind.as_str();
        let delivery_thread_ids = if thread_kind == "delivery" {
            self.context_engine
                .find_event(&activation.context_id, &activation.trigger_event_id)
                .await?
                .and_then(|event| {
                    event
                        .payload
                        .get("completed_thread_ids")
                        .and_then(serde_json::Value::as_array)
                        .map(|ids| {
                            ids.iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(ToOwned::to_owned)
                                .collect::<Vec<_>>()
                        })
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        self.activation_routes.insert(
            attempt_id.clone(),
            ActivationRoute {
                thread_id: thread.id.clone(),
                activation_id: activation.id.clone(),
                root_turn_id: activation.root_turn_id.clone(),
                trigger_event_id: activation.trigger_event_id.clone(),
                trigger_sequence: activation.trigger_sequence,
                initiating_principal_id: activation.initiating_principal_id.clone(),
                context_snapshot_version: activation.context_snapshot_version,
                thread_kind,
                internal_child_handoff: thread.executor_kind == "plan_infer",
                delivery_thread_ids,
            },
        );
        let recovering_completion_intent = if let (Some(supervisor), Some(binding)) = (
            self.objective_supervisor.as_ref(),
            self.objective_evaluations
                .get_for_activation(&activation.id),
        ) {
            supervisor
                .get(&binding.objective_id)
                .await?
                .and_then(|objective| objective.completion_intent)
                .is_some_and(|intent| {
                    intent.activation_id == activation.id
                        && intent.evaluation_id == binding.evaluation_id
                })
        } else {
            false
        };
        if (!recovering_completion_intent || persisted_final_response.is_some())
            && self
                .resume_persisted_activation(session_id, activation)
                .await?
        {
            if let Some(lease) = dialogue_lease.as_mut() {
                if persisted_terminal {
                    lease.release();
                } else {
                    lease.retain_for_continuation();
                }
            }
            return Ok(());
        }
        if thread_kind == "delivery" && self.pending_delivery_threads(session_id).await?.is_empty()
        {
            tracing::info!(
                session_id,
                activation_id = %activation.id,
                event_code = "orchestrator.completion_inbox.already_drained",
                "Completion Inbox was drained by a concurrent Delivery Thread; skipping duplicate model evaluation"
            );
            self.publish_no_reply(session_id, &attempt_id, None).await?;
            return Ok(());
        }
        let context_id = activation.context_id.clone();
        // Tool protocol state is activation-local, not a second Context. Read
        // the latest Mind first, then build only the one-shot Provider envelope
        // for the tool batch that triggered this Activation. Earlier settled
        // outputs remain ordinary observations and are never replayed here.
        let mut context = self
            .context_engine
            .build_context_encoding_for_activation(&context_id, activation, &HashSet::new())
            .await?;
        let continuation = self
            .tool_continuation_for_trigger(
                session_id,
                Some(&activation.root_turn_id),
                Some(&activation.trigger_event_id),
                &context.state.retired,
            )
            .await?;
        let continuation_messages = continuation.messages.clone();
        let attachment_message = self
            .model_attachment_message(&context_id, &activation.root_turn_id)
            .await?;
        if !continuation.delivered_output_ids.is_empty() {
            context = self
                .context_engine
                .build_context_encoding_for_activation(
                    &context_id,
                    activation,
                    &continuation.delivered_output_ids,
                )
                .await?;
        }
        self.record_activation_context_snapshot(activation, context.state.version)
            .await?;
        if let Some(mut route) = self.activation_routes.get_mut(&attempt_id) {
            route.context_snapshot_version = Some(context.state.version);
        }
        let context_tx_receipt = self.context_tx_receipt(&context).await?;
        let objective_control_available = self
            .objective_evaluations
            .get_for_activation(&activation.id)
            .is_some_and(|active| {
                context.objectives.iter().any(|objective| {
                    objective.id == active.objective_id
                        && objective.coordinator_session_id == session_id
                        && objective.status == crate::memory::ObjectiveStatus::Active
                })
            });
        let objective_amend_available = !objective_control_available
            && thread.kind == ThreadKind::DialogueTurn
            && activation.trigger_kind == "chat/user_message";
        let harness_activation = self
            .harness_mount_for_activation(&context_id, activation)
            .await?;
        let harness_context = harness_activation
            .as_ref()
            .map(|(_, _, rendered)| rendered.clone());
        let harness_entry_program = harness_activation
            .as_ref()
            .and_then(|(_, harness, _)| harness.entry_program())
            .map(|source| {
                validate_harness_entry_program(
                    &source,
                    self.registry.as_ref(),
                    &self.orchestrator_config.eval_callable_tools,
                    &self.tool_definitions,
                )
                .map(|program| (source, program))
                .map_err(|error| -> DynError {
                    format!("绑定 Harness 的入口程序未通过完整校验：{error}").into()
                })
            })
            .transpose()?;
        let plan_infer_tools = if thread.executor_kind == "plan_infer" {
            let request = self
                .context_engine
                .find_event(&context_id, &activation.root_turn_id)
                .await?
                .ok_or_else(|| {
                    format!(
                        "Plan infer Thread '{}' 缺少根请求 Event '{}'",
                        thread.id, activation.root_turn_id
                    )
                })?;
            plan_infer_tool_scope(&request).map_err(|error| -> DynError { error.into() })?
        } else {
            None
        };
        let (_prompt_mode, stable_system_prompt) = configured_system_prompt()?;
        let context_message_prefix = "The Runtime provides the current Context Encoding below. It is not an ordinary user message. Execute the final evaluate entry and decide from protocol, inbox, and the current state that follows.";

        // First measure a candidate request with full work capability. Pressure answers whether the
        // current Context can continue normal work, so even if measurement leads to maintenance or
        // reply-only mode, thresholds still use the full work toolset. This avoids oscillation caused
        // by measuring a reduced toolset near a boundary.
        let measurement_directive = match context.turn_budget.phase.as_str() {
            "soft-checkpoint" => Some(("soft-checkpoint", SOFT_CHECKPOINT_PROMPT)),
            _ => None,
        };
        let measurement_overlay = EvaluationContextOverlay {
            evaluation_profile: harness_context.as_ref().map(|item| item.profile.as_str()),
            harness_binding: harness_context.as_ref().map(|item| item.binding.as_str()),
            runtime_directive: measurement_directive,
        };
        let mut measurement_messages = vec![
            Message {
                role: "system".to_string(),
                content: stable_system_prompt.to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "user".to_string(),
                content: compose_context_message(
                    context_message_prefix,
                    &context.sexpr,
                    measurement_overlay,
                )?,
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        measurement_messages.extend(continuation.messages.clone());
        if let Some(message) = attachment_message.clone() {
            measurement_messages.push(message);
        }
        let mut measurement_tools = self.tool_definitions.clone();
        if thread_kind == "delivery" {
            measurement_tools.clear();
        }
        if !objective_control_available {
            measurement_tools.retain(|tool| !is_objective_bound_tool(&tool.name));
        }
        if !objective_amend_available {
            measurement_tools.retain(|tool| !is_dialogue_objective_tool(&tool.name));
        }
        restrict_tools_to_scope(&mut measurement_tools, plan_infer_tools.as_ref());
        if thread.executor_kind != "plan_infer" {
            measurement_tools.push(no_reply_tool_definition());
        }
        let prompt_measurement = self
            .refresh_context_pressure(
                &mut context,
                &mut measurement_messages,
                &measurement_tools,
                context_message_prefix,
                measurement_overlay,
            )
            .await?;
        let critical_context_tx_available = critical_maintenance_transaction_available(
            context.turn_budget.context_transactions_used,
        );
        if context.pressure.level == "critical" {
            context.turn_budget.context_transactions_limit =
                CRITICAL_MAINTENANCE_TRANSACTION_SAFETY_LIMIT;
            context.turn_budget.context_tx_available = critical_context_tx_available;
        }
        let maintenance_budget_exhausted = should_force_final_for_maintenance(
            &context.turn_budget.phase,
            &context.pressure.level,
            context.turn_budget.context_tx_available,
        );
        let mut effective_phase = if maintenance_budget_exhausted {
            "final-reply".to_string()
        } else if context.pressure.level == "critical" {
            "critical-maintenance".to_string()
        } else {
            context.turn_budget.phase.clone()
        };
        if recovering_completion_intent {
            effective_phase = "objective-finalization".to_string();
        }
        let mut bounded_critical_projection = context.pressure.level == "critical";
        let mut recovery_observation_limit = 1usize;
        let mut critical_recovery_source = None;
        if bounded_critical_projection {
            // The current one-shot tool envelope may carry full results while
            // Context Encoding omits that same just-delivered batch. Once the
            // request is already over limit, rebuild the active projection with
            // all routed results available as ordinary recallable observations,
            // then expose a deterministic bounded maintenance slice. Nothing
            // is retired here and no settled Provider history is replayed.
            let full_pressure = context.pressure.clone();
            let mut recovery_context = self
                .context_engine
                .build_context_encoding_for_activation(&context_id, activation, &HashSet::new())
                .await?;
            recovery_observation_limit = recovery_context.observations.len().max(1);
            recovery_context.pressure = full_pressure;
            recovery_context.turn_budget = context.turn_budget.clone();
            critical_recovery_source = Some(recovery_context.clone());
            let (total, visible) = self.context_engine.apply_critical_maintenance_projection(
                &mut recovery_context,
                recovery_observation_limit,
                CRITICAL_MAINTENANCE_PREVIEW_CHARS,
            );
            tracing::warn!(
                context_id = %context_id,
                session_id,
                total_active_observations = total,
                projected_observations = visible,
                event_code = "orchestrator.context_pressure.critical_projection_enabled",
                "Context exceeds the physical request budget; enabling a bounded critical-maintenance Projection"
            );
            context = recovery_context;
        }
        let context_tx_cooldown = effective_phase != "final-reply"
            && context.pressure.level != "critical"
            && context_tx_receipt == ContextTxReceipt::Committed;
        let phase_prompt = match effective_phase.as_str() {
            "final-reply" if maintenance_budget_exhausted => {
                Some(MAINTENANCE_BUDGET_EXHAUSTED_PROMPT)
            }
            "critical-maintenance" => Some(CRITICAL_MAINTENANCE_PROMPT),
            "soft-checkpoint" => Some(SOFT_CHECKPOINT_PROMPT),
            _ if context_tx_cooldown => Some(CONTEXT_TX_COOLDOWN_PROMPT),
            _ => None,
        };
        let request_overlay = EvaluationContextOverlay {
            evaluation_profile: harness_context.as_ref().map(|item| item.profile.as_str()),
            harness_binding: harness_context.as_ref().map(|item| item.binding.as_str()),
            runtime_directive: phase_prompt.map(|prompt| (effective_phase.as_str(), prompt)),
        };
        let mut messages = vec![
            Message {
                role: "system".to_string(),
                content: stable_system_prompt.to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "user".to_string(),
                content: compose_context_message(
                    context_message_prefix,
                    &context.sexpr,
                    request_overlay,
                )?,
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        if !bounded_critical_projection {
            messages.extend(continuation_messages.clone());
        }
        if let Some(message) = attachment_message {
            messages.push(message);
        }

        let mut tools = self.tool_definitions.clone();
        if thread_kind == "delivery" {
            tools.clear();
        }
        if !objective_control_available {
            tools.retain(|tool| !is_objective_bound_tool(&tool.name));
        }
        if !objective_amend_available {
            tools.retain(|tool| !is_dialogue_objective_tool(&tool.name));
        }
        if effective_phase == "final-reply" {
            tracing::warn!(
                session_id,
                attempt = context.turn_budget.attempt,
                maintenance_budget_exhausted,
                event_code = "orchestrator.context_pressure.reply_only",
                "Context is critical and maintenance budget is exhausted; entering reply-only final response"
            );
            retain_final_reply_control_tools(
                &mut tools,
                objective_control_available,
                objective_amend_available,
            );
        } else {
            if effective_phase == "soft-checkpoint" {
                tracing::info!(
                    session_id,
                    attempt = context.turn_budget.attempt,
                    interval = context.turn_budget.checkpoint_interval,
                    event_code = "orchestrator.turn.soft_checkpoint_reached",
                    "Reached a Turn soft checkpoint; retaining full tool capability and continuing"
                );
                self.publish_progress(
                    session_id,
                    &attempt_id,
                    format!(
                        "已完成 {} 次模型求值软检查点；正在复盘进展，任务不会因此停止。",
                        context.turn_budget.attempt
                    ),
                )
                .await?;
            }
            if context.pressure.level == "critical" {
                tracing::warn!(
                    session_id,
                    event_code = "orchestrator.context_pressure.maintenance_required",
                    "Context pressure is critical; pausing costly external actions until the agent maintains Context"
                );
                retain_context_maintenance_tools(
                    &mut tools,
                    objective_control_available,
                    objective_amend_available,
                );
            }
            if !context.turn_budget.context_tx_available {
                tracing::warn!(
                    session_id,
                    used = context.turn_budget.context_transactions_used,
                    limit = context.turn_budget.context_transactions_limit,
                    event_code = "orchestrator.context_transaction.budget_exhausted",
                    "Context-transaction budget is exhausted during ordinary work; preserving the physical work budget"
                );
                tools.retain(|tool| tool.name != "context_tx");
            }
            if context_tx_cooldown {
                tracing::info!(
                    session_id,
                    event_code = "orchestrator.context_transaction.cooldown_started",
                    "Standalone context_tx succeeded; hiding context_tx for this cooldown"
                );
                tools.retain(|tool| tool.name != "context_tx");
            }
        }
        restrict_tools_to_scope(&mut tools, plan_infer_tools.as_ref());
        if thread.executor_kind != "plan_infer" {
            tools.push(no_reply_tool_definition());
        }
        if recovering_completion_intent {
            let (assistant_call, call, output) = self
                .persisted_objective_completion_call(
                    &activation.context_id,
                    session_id,
                    &activation.id,
                )
                .await?
                .ok_or("恢复 Objective finalization 时缺少持久 completion 调用或工具回执")?;
            messages.push(Message {
                role: "assistant".to_string(),
                content: assistant_call
                    .payload
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(vec![call.clone()]),
            });
            messages.push(self.standard_tool_result_message(&call, &output));
            messages.push(Message {
                role: "user".to_string(),
                content: OBJECTIVE_FINALIZATION_PROMPT.to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            });
            tools.retain(|tool| tool.name == NO_REPLY_TOOL_NAME);
        }
        // A Runtime-owned Harness entry is the root program for the current
        // Evaluation. A `plan_infer` Thread is already a child node of that
        // program: re-dispatching the mounted entry here would short-circuit
        // the child model evaluation (the entry call is idempotently already
        // present) and leave the parent Plan without an infer result Event.
        if should_dispatch_runtime_harness_entry(&thread.executor_kind, &effective_phase) {
            if let (Some((binding, _, _)), Some((source, program))) =
                (harness_activation.as_ref(), harness_entry_program.as_ref())
            {
                if program.owner() == crate::sexpr_eval::EvaluationOwner::Runtime
                    && self
                        .dispatch_runtime_harness_entry(
                            session_id, activation, binding, source, program,
                        )
                        .await?
                {
                    return Ok(());
                }
            }
        }
        let mut allowed_tool_names = tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<HashSet<_>>();
        let mut request_prompt_measurement = if bounded_critical_projection {
            self.count_projected_prompt_tokens(&context, &messages, &tools)
                .await
        } else {
            prompt_measurement.clone()
        };
        if bounded_critical_projection {
            let recovery_prompt_limit = context
                .pressure
                .hard_limit
                .saturating_sub(context.pressure.maintenance_reserve)
                .max(1);
            // Pack the maintenance projection by the physical token budget,
            // not by an arbitrary observation-count ceiling. Find the largest
            // deterministic prefix that fits below hard-limit minus the
            // configured maintenance/output reserve.
            let source = critical_recovery_source
                .as_ref()
                .expect("critical recovery source must exist");
            let total_candidates = source.observations.len().max(1);
            let mut low = 1usize;
            let mut high = total_candidates;
            let mut best: Option<(usize, ContextView, Vec<Message>, PromptTokenCount)> = None;
            while low <= high {
                let candidate_limit = low + (high - low) / 2;
                let mut candidate = source.clone();
                self.context_engine.apply_critical_maintenance_projection(
                    &mut candidate,
                    candidate_limit,
                    CRITICAL_MAINTENANCE_PREVIEW_CHARS,
                );
                let mut candidate_messages = messages.clone();
                candidate_messages[1].content = compose_context_message(
                    context_message_prefix,
                    &candidate.sexpr,
                    request_overlay,
                )?;
                let candidate_measurement = self
                    .count_projected_prompt_tokens(&candidate, &candidate_messages, &tools)
                    .await;
                match candidate_measurement {
                    Some(measurement) if measurement.tokens < recovery_prompt_limit => {
                        best = Some((candidate_limit, candidate, candidate_messages, measurement));
                        low = candidate_limit.saturating_add(1);
                    }
                    Some(_) => {
                        if candidate_limit == 1 {
                            break;
                        }
                        high = candidate_limit - 1;
                    }
                    None => {
                        // Without a counter, retain the current projection and
                        // let the Provider remain the physical-limit authority.
                        break;
                    }
                }
            }
            if let Some((limit, packed_context, packed_messages, measurement)) = best {
                recovery_observation_limit = limit;
                context = packed_context;
                messages = packed_messages;
                request_prompt_measurement = Some(measurement);
            }
            if request_prompt_measurement
                .as_ref()
                .is_some_and(|measurement| measurement.tokens >= recovery_prompt_limit)
            {
                // Local counting is deliberately advisory: it can trigger a
                // bounded maintenance projection, but it must not pretend to
                // be the Provider's physical context-limit authority. Submit
                // the smallest useful projection and only enter the durable
                // ContextLimit recovery path when the Provider confirms that
                // the request is still too large.
                tracing::warn!(
                    context_id = %context_id,
                    session_id,
                    estimated_tokens = request_prompt_measurement
                        .as_ref()
                        .map(|measurement| measurement.tokens)
                        .unwrap_or_default(),
                    advisory_input_budget = recovery_prompt_limit,
                    event_code = "orchestrator.context_pressure.minimum_projection_over_budget",
                    "Minimum critical-maintenance Projection still exceeds the local estimated budget; submitting for final Provider adjudication"
                );
            }
        }
        let mut base_protocol_messages = messages;
        let restored_reasoning = self
            .restore_reasoning_continuation_state(&context_id, session_id, &activation.id)
            .await?;
        let mut protocol_messages = base_protocol_messages.clone();
        if restored_reasoning.physical_continuations > 0 {
            append_reasoning_continuation_input(
                &mut protocol_messages,
                &restored_reasoning.provider_continuations,
                &restored_reasoning.summaries,
            )?;
            // The restored protocol envelope is part of the next physical
            // request. Re-measure it instead of reporting the pre-restart base
            // Context as the request size.
            request_prompt_measurement = self
                .count_projected_prompt_tokens(&context, &protocol_messages, &tools)
                .await;
        }
        if let Some(supervisor) = &self.objective_supervisor {
            let tokens = request_prompt_measurement
                .as_ref()
                .map(|measurement| measurement.tokens)
                .unwrap_or(context.pressure.estimated_tokens);
            if let Err(error) = supervisor
                .record_prompt_tokens_for_activation(&activation.id, tokens)
                .await
            {
                tracing::warn!(
                    session_id,
                    activation_id = %activation.id,
                    error = %error,
                    event_code = "orchestrator.objective.prompt_accounting_failed",
                    "Objective Prompt-token accounting failed; continuing the current Evaluation"
                );
            }
        }
        let no_delivered_output_ids = HashSet::new();
        let mut visible_routed_input_ids = if bounded_critical_projection {
            no_delivered_output_ids.clone()
        } else {
            continuation.delivered_output_ids.clone()
        };
        let mut context_maintenance_owner = None;
        let mut context_maintenance_gate = None;
        let mut protocol_errors = 0usize;
        let mut model_request_index = restored_reasoning.physical_continuations;
        let mut reasoning_continuations = restored_reasoning.continuation_count;
        let mut stalled_reasoning_continuations = restored_reasoning.stalled_count;
        let mut previous_reasoning_summary = restored_reasoning.summaries.last().cloned();
        let mut reasoning_history = restored_reasoning.summaries;
        let mut reasoning_provider_continuations = restored_reasoning.provider_continuations;
        let mut interrupted_public_text = String::new();
        let mut completion_prepared = recovering_completion_intent;
        let (
            response,
            terminal_decision,
            terminal_model_attempt_id,
            terminal_provider_continuation,
        ) = loop {
            let request_index = model_request_index;
            model_request_index = model_request_index.saturating_add(1);
            let model_attempt_id = if request_index == 0 {
                attempt_id.clone()
            } else {
                format!("{attempt_id}_response_retry_{request_index}")
            };
            let mut signal_input_ids = Vec::new();
            if let Some(focus) = context.activation.as_ref() {
                signal_input_ids.extend(
                    focus
                        .signal_batch
                        .iter()
                        .map(|signal| signal.event_id.clone()),
                );
            }
            let visible_observation_ids = context
                .observations
                .iter()
                .map(|observation| observation.id.as_str())
                .collect::<HashSet<_>>();
            signal_input_ids.extend(
                context
                    .thread_signals
                    .iter()
                    .filter(|signal| {
                        signal.thread_id == thread.id
                            && visible_observation_ids.contains(signal.event_id.as_str())
                    })
                    .map(|signal| signal.event_id.clone()),
            );
            signal_input_ids.sort();
            signal_input_ids.dedup();
            let bound_signals = session_store
                .bind_activation_input_signals(&activation.id, &signal_input_ids)
                .await?;

            // A physical request can still see causal input whose scheduler
            // Signal belongs to an earlier Activation (for example, the
            // original user turn during Provider recovery). Keep that broader
            // diagnostic set separate from the authoritative ownership set.
            let mut request_input_ids =
                visible_routed_input_ids.iter().cloned().collect::<Vec<_>>();
            request_input_ids.extend(signal_input_ids);
            if let Some(wake_event_id) = context.wake.event_id.as_deref() {
                request_input_ids.push(wake_event_id.to_string());
            }
            request_input_ids.sort();
            request_input_ids.dedup();
            self.publish_model_request_snapshot(
                session_id,
                &model_attempt_id,
                &context,
                &protocol_messages,
                &tools,
                &request_input_ids,
            )
            .await;
            // Register ownership before publishing the first non-terminal
            // state. Cancellation may race this await; the cancellation owner
            // must already know which physical Attempt to close.
            self.active_model_attempts
                .insert(activation.id.clone(), model_attempt_id.clone());
            self.record_model_attempt_started(
                session_id,
                &model_attempt_id,
                &effective_phase,
                &context,
                tools.len(),
                bound_signals.len(),
            )
            .await?;
            let completion = self
                .request_model_completion(
                    session_id,
                    &model_attempt_id,
                    protocol_messages.clone(),
                    tools.clone(),
                    (request_index == 0)
                        .then(|| request_prompt_measurement.clone())
                        .flatten(),
                )
                .await;
            let (response, provider_continuation) = match completion {
                Ok(ModelCompletion {
                    mut response,
                    provider_continuation,
                }) => {
                    if !interrupted_public_text.is_empty() {
                        response.content = format!("{interrupted_public_text}{}", response.content);
                        interrupted_public_text.clear();
                    }
                    self.record_model_attempt_terminal_state(
                        session_id,
                        &model_attempt_id,
                        "completed",
                        Some("provider response received"),
                    )
                    .await?;
                    (response, provider_continuation)
                }
                Err(error) if error.is_runtime_failure() => {
                    let failure_origin = match error.origin {
                        ModelCompletionErrorOrigin::RuntimePersistence => "runtime_persistence",
                        ModelCompletionErrorOrigin::RuntimeInternal => "runtime_internal",
                        ModelCompletionErrorOrigin::RuntimeInput => "input_rejected",
                        ModelCompletionErrorOrigin::Provider => unreachable!(
                            "Provider failures are handled by the following model branches"
                        ),
                    };
                    let detail = error.to_string();
                    // This is not a Provider outcome. In particular, a
                    // successful response followed by a usage/reasoning Event
                    // persistence error must not poison the Provider circuit,
                    // enter reasoning continuation, or block the Objective as
                    // an unknown model failure. Returning an Activation error
                    // leaves the durable Objective active so its lease/recovery
                    // path can replay after storage recovers.
                    if let Err(state_error) = self
                        .record_model_attempt_terminal_state(
                            session_id,
                            &model_attempt_id,
                            failure_origin,
                            Some(&detail),
                        )
                        .await
                    {
                        tracing::warn!(
                            session_id,
                            attempt_id = %model_attempt_id,
                            error = %state_error,
                            event_code = "orchestrator.model_attempt.runtime_failure_persist_failed",
                            "Could not persist the Model Attempt terminal state after a Runtime failure"
                        );
                    }
                    tracing::error!(
                        session_id,
                        attempt_id = %model_attempt_id,
                        origin = failure_origin,
                        error = %detail,
                        event_code = "orchestrator.model_evaluation.runtime_boundary_failure",
                        "Runtime failure occurred at the model-evaluation boundary and is not classified as a Provider failure"
                    );
                    return Err(error.into_source());
                }
                Err(error) if error.failure().kind == ModelFailureKind::ContextLimit => {
                    let failure = error.failure();
                    self.record_model_attempt_terminal_state(
                        session_id,
                        &model_attempt_id,
                        "context_limit",
                        Some(&failure.to_string()),
                    )
                    .await?;

                    let gate = self
                        .context_maintenance_gates
                        .entry(context_id.clone())
                        .or_insert_with(|| Arc::new(ContextMaintenanceGate::default()))
                        .clone();
                    let observed_epoch = gate.completed_epoch.load(Ordering::Acquire);
                    if context_maintenance_owner.is_none() {
                        let owner = Arc::clone(&gate.owner).lock_owned().await;
                        if gate.completed_epoch.load(Ordering::Acquire) != observed_epoch {
                            // Another Activation repaired this Context while we
                            // waited. Re-enter from the durable projection;
                            // reusing this attempt's pre-error messages would
                            // immediately submit the stale oversized request.
                            drop(owner);
                            return Err(Box::new(RefreshContextAfterConcurrentMaintenance));
                        }
                        context_maintenance_owner = Some(owner);
                        context_maintenance_gate = Some(Arc::clone(&gate));
                    }

                    if bounded_critical_projection {
                        if recovery_observation_limit <= 1 {
                            return Box::pin(self.publish_runtime_failure(
                                session_id,
                                &model_attempt_id,
                                "critical_maintenance_minimum_projection",
                                &failure,
                                context.parent_session_id.as_deref(),
                            ))
                            .await;
                        }
                        recovery_observation_limit = (recovery_observation_limit / 2).max(1);
                    } else {
                        let mut recovery_context = self
                            .context_engine
                            .build_context_encoding_for_activation(
                                &context_id,
                                activation,
                                &HashSet::new(),
                            )
                            .await?;
                        recovery_observation_limit = recovery_context.observations.len().max(1);
                        recovery_context.pressure.level = "critical".to_string();
                        recovery_context.pressure.estimated_tokens = recovery_context
                            .pressure
                            .estimated_tokens
                            .max(recovery_context.pressure.hard_limit);
                        recovery_context.turn_budget.context_transactions_limit =
                            CRITICAL_MAINTENANCE_TRANSACTION_SAFETY_LIMIT;
                        recovery_context.turn_budget.context_tx_available =
                            critical_maintenance_transaction_available(
                                recovery_context.turn_budget.context_transactions_used,
                            );
                        critical_recovery_source = Some(recovery_context);
                        bounded_critical_projection = true;
                    }

                    let mut recovery_context = critical_recovery_source
                        .as_ref()
                        .expect("Provider-triggered maintenance source must exist")
                        .clone();
                    let (total, visible) =
                        self.context_engine.apply_critical_maintenance_projection(
                            &mut recovery_context,
                            recovery_observation_limit,
                            CRITICAL_MAINTENANCE_PREVIEW_CHARS,
                        );
                    context = recovery_context;
                    effective_phase = "critical-maintenance".to_string();
                    let recovery_overlay = EvaluationContextOverlay {
                        evaluation_profile: harness_context
                            .as_ref()
                            .map(|item| item.profile.as_str()),
                        harness_binding: harness_context.as_ref().map(|item| item.binding.as_str()),
                        runtime_directive: Some((
                            effective_phase.as_str(),
                            CRITICAL_MAINTENANCE_PROMPT,
                        )),
                    };
                    base_protocol_messages = vec![
                        Message {
                            role: "system".to_string(),
                            content: stable_system_prompt.to_string(),
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        },
                        Message {
                            role: "user".to_string(),
                            content: compose_context_message(
                                context_message_prefix,
                                &context.sexpr,
                                recovery_overlay,
                            )?,
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        },
                    ];
                    protocol_messages = base_protocol_messages.clone();
                    tools = self.tool_definitions.clone();
                    if !objective_control_available {
                        tools.retain(|tool| !is_objective_bound_tool(&tool.name));
                    }
                    if !objective_amend_available {
                        tools.retain(|tool| !is_dialogue_objective_tool(&tool.name));
                    }
                    retain_context_maintenance_tools(
                        &mut tools,
                        objective_control_available,
                        objective_amend_available,
                    );
                    restrict_tools_to_scope(&mut tools, plan_infer_tools.as_ref());
                    tools.push(no_reply_tool_definition());
                    allowed_tool_names = tools.iter().map(|tool| tool.name.clone()).collect();
                    request_prompt_measurement = self
                        .count_projected_prompt_tokens(&context, &protocol_messages, &tools)
                        .await;
                    visible_routed_input_ids.clear();
                    protocol_errors = 0;
                    reasoning_continuations = 0;
                    stalled_reasoning_continuations = 0;
                    previous_reasoning_summary = None;
                    reasoning_history.clear();
                    reasoning_provider_continuations.clear();
                    interrupted_public_text.clear();
                    tracing::warn!(
                        context_id = %context_id,
                        session_id,
                        activation_id = %activation.id,
                        total_active_observations = total,
                        projected_observations = visible,
                        projection_limit = recovery_observation_limit,
                        event_code = "orchestrator.context_pressure.maintenance_owner_acquired",
                        "Provider confirmed Context overflow; current Activation acquired sole maintenance ownership"
                    );
                    continue;
                }
                Err(error)
                    if error.failure().kind.is_request_scoped_latency()
                        && !error.partial_text.is_empty() =>
                {
                    let provider_error = error.to_string();
                    self.record_model_attempt_terminal_state(
                        session_id,
                        &model_attempt_id,
                        "continued",
                        Some(&provider_error),
                    )
                    .await?;
                    interrupted_public_text.push_str(&error.partial_text);
                    protocol_messages = base_protocol_messages.clone();
                    protocol_messages.push(Message {
                        role: "assistant".to_string(),
                        content: interrupted_public_text.clone(),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                    protocol_messages.push(Message {
                        role: "user".to_string(),
                        content: interrupted_text_continuation_prompt().to_string(),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                    continue;
                }
                Err(error)
                    if (!error.reasoning_summary.trim().is_empty()
                        || error.provider_continuation.is_some())
                        && (error.failure().kind.is_request_scoped_latency()
                            || error.failure().kind == ModelFailureKind::EmptyResponse) =>
                {
                    let provider_error = error.to_string();
                    self.record_model_attempt_terminal_state(
                        session_id,
                        &model_attempt_id,
                        "continued",
                        Some(&provider_error),
                    )
                    .await?;
                    reasoning_continuations = reasoning_continuations.saturating_add(1);
                    let reasoning_summary = error.reasoning_summary.trim().to_string();
                    if previous_reasoning_summary.as_deref() == Some(reasoning_summary.as_str()) {
                        stalled_reasoning_continuations =
                            stalled_reasoning_continuations.saturating_add(1);
                    } else {
                        stalled_reasoning_continuations = 0;
                    }
                    self.record_reasoning_continuation(
                        session_id,
                        &model_attempt_id,
                        reasoning_continuations,
                        reasoning_summary.chars().count(),
                        &provider_error,
                        error.provider_continuation.as_ref(),
                    )
                    .await?;
                    let continuation_exhausted = self
                        .orchestrator_config
                        .reasoning_continuation_safety_limit
                        .is_some_and(|limit| reasoning_continuations > limit);
                    let reasoning_stalled =
                        self.orchestrator_config.max_stalled_reasoning_continuations > 0
                            && stalled_reasoning_continuations
                                >= self.orchestrator_config.max_stalled_reasoning_continuations;
                    if continuation_exhausted || reasoning_stalled {
                        let reason = if reasoning_stalled {
                            format!(
                                "reasoning continuation stalled after {} identical segment(s)",
                                stalled_reasoning_continuations
                            )
                        } else {
                            format!(
                                "reasoning continuation exceeded configured limit {}",
                                self.orchestrator_config
                                    .reasoning_continuation_safety_limit
                                    .expect("continuation exhaustion requires a configured limit")
                            )
                        };
                        self.record_reasoning_continuation_exhausted(
                            session_id,
                            &model_attempt_id,
                            reasoning_continuations,
                            stalled_reasoning_continuations,
                            &reason,
                        )
                        .await?;
                        let failure = ModelFailure::new(
                            ModelFailureKind::ReasoningContinuationExhausted,
                            reason,
                        );
                        return Box::pin(self.publish_runtime_failure(
                            session_id,
                            &model_attempt_id,
                            "reasoning_continuation",
                            &failure,
                            context.parent_session_id.as_deref(),
                        ))
                        .await;
                    }
                    // This is a continuation, not a fresh protocol retry: the
                    // next physical request receives the latest saved
                    // reasoning progress. Keep the configured reasoning level
                    // unchanged so the model can finish its reasoning on its
                    // own terms. Replace older recovery prompts to avoid
                    // repeatedly inflating Context across retries.
                    if !reasoning_summary.is_empty() {
                        previous_reasoning_summary = Some(reasoning_summary.clone());
                        reasoning_history.push(reasoning_summary);
                    }
                    if let Some(provider_continuation) = error.provider_continuation {
                        reasoning_provider_continuations.push(provider_continuation);
                    }
                    protocol_messages = base_protocol_messages.clone();
                    append_reasoning_continuation_input(
                        &mut protocol_messages,
                        &reasoning_provider_continuations,
                        &reasoning_history,
                    )?;
                    continue;
                }
                Err(error) if error.failure().kind == ModelFailureKind::EmptyResponse => {
                    self.record_model_attempt_terminal_state(
                        session_id,
                        &model_attempt_id,
                        "protocol_invalid",
                        Some(EMPTY_RESPONSE_DETAIL),
                    )
                    .await?;
                    protocol_errors += 1;
                    self.record_response_protocol_error(
                        session_id,
                        &model_attempt_id,
                        protocol_errors,
                        "empty",
                        "模型返回空响应",
                    )
                    .await?;
                    if protocol_errors > MAX_RESPONSE_PROTOCOL_RETRIES {
                        return self
                            .publish_response_protocol_failure(
                                session_id,
                                &model_attempt_id,
                                context.parent_session_id.as_deref(),
                            )
                            .await;
                    }
                    protocol_messages.push(Message {
                        role: "user".to_string(),
                        content: RESPONSE_PROTOCOL_ERROR.to_string(),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                    continue;
                }
                Err(error) => {
                    let provider_error = error.to_string();
                    let failure = error.failure();
                    self.record_model_attempt_terminal_state(
                        session_id,
                        &model_attempt_id,
                        "failed",
                        Some(&provider_error),
                    )
                    .await?;
                    return Box::pin(self.publish_runtime_failure(
                        session_id,
                        &model_attempt_id,
                        "llm_completion",
                        &failure,
                        context.parent_session_id.as_deref(),
                    ))
                    .await;
                }
            };

            let classification = validate_schedule_tx_response(&response)
                .and_then(|_| validate_objective_completion_call(&response))
                .and_then(|_| classify_terminal_response(&response))
                .and_then(|decision| {
                    validate_objective_closure_review_response(
                        initial_objective_closure_review && !completion_prepared,
                        decision,
                    )
                })
                .and_then(|decision| {
                    validate_final_reply_response(
                        &effective_phase,
                        objective_control_available,
                        &response,
                        decision,
                    )
                });
            match classification {
                Ok(None) if !completion_prepared && completed_objective_update_call(&response) => {
                    let call = response.tool_calls[0].clone();
                    let protocol_call = crate::llm::ToolCall {
                        id: call.id.clone(),
                        r#type: call.r#type.clone(),
                        function: crate::llm::FunctionCall {
                            name: call.func_name.clone(),
                            arguments: call.arguments.clone(),
                        },
                    };
                    let outcome = self
                        .execute_tool_calls(
                            session_id,
                            &attempt_id,
                            response,
                            &effective_phase,
                            ToolExecutionOptions {
                                context_tx_allowed: false,
                                wake_on_output: false,
                                plan_execution_id: None,
                                continuation_tool_calls: None,
                                allowed_tool_names: allowed_tool_names.clone(),
                                record_assistant_call: true,
                                model_attempt_id: Some(model_attempt_id.clone()),
                                provider_continuation: provider_continuation.clone(),
                            },
                        )
                        .await?;
                    let output = outcome
                        .outputs
                        .into_iter()
                        .next()
                        .ok_or("Objective completion 工具没有产生持久结果")?;
                    if let Some(provider_continuation) = provider_continuation {
                        protocol_messages
                            .push(provider_continuation_message(provider_continuation)?);
                    }
                    protocol_messages.push(Message {
                        role: "assistant".to_string(),
                        content: String::new(),
                        name: None,
                        tool_call_id: None,
                        tool_calls: Some(vec![protocol_call.clone()]),
                    });
                    protocol_messages
                        .push(self.standard_tool_result_message(&protocol_call, &output));
                    visible_routed_input_ids.insert(output.id.clone());
                    let completion_committed = output
                        .payload
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                        .and_then(|receipt| {
                            receipt
                                .get("status")
                                .and_then(serde_json::Value::as_str)
                                .map(|status| status == "completion_prepared")
                        })
                        .unwrap_or(false);
                    if completion_committed {
                        completion_prepared = true;
                        effective_phase = "objective-finalization".to_string();
                        tools.retain(|tool| tool.name == NO_REPLY_TOOL_NAME);
                        allowed_tool_names = tools.iter().map(|tool| tool.name.clone()).collect();
                        protocol_messages.push(Message {
                            role: "user".to_string(),
                            content: OBJECTIVE_FINALIZATION_PROMPT.to_string(),
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        });
                    } else {
                        protocol_messages.push(Message {
                            role: "user".to_string(),
                            content: "Objective 完成请求没有进入 finalizing；请依据工具回执和最新 revision 重新判断。".to_string(),
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        });
                    }
                    base_protocol_messages = protocol_messages.clone();
                    continue;
                }
                Ok(Some(TerminalDecision::NoReply(NoReplyMode::Wait))) => {
                    let active_root_tasks = self
                        .owed_background_jobs_for_thread(
                            session_id,
                            &activation.context_id,
                            &thread,
                        )
                        .await?;
                    let pending_schedules = session_store
                        .list_schedules(Some(&thread.id), Some(ScheduleStatus::Queued))
                        .await?
                        .len();
                    let pending_routed_inputs = self.pending_routed_inputs(activation).await?;
                    if thread_kind != "execution"
                        || (active_root_tasks == 0
                            && pending_schedules == 0
                            && pending_routed_inputs == 0)
                    {
                        let reason = if thread_kind != "execution" {
                            "no_reply(mode=wait) 被拒绝：当前不是可挂起等待物理事件的 Execution Thread；请直接回复当前 Session，或仅在确实有意静默时改用 mode=silent"
                        } else {
                            "no_reply(mode=wait) 被拒绝：Runtime 当前没有仍在运行的后台任务、排队调度或待处理事件；最新完成/失败结果已经是权威事实，请处理该结果并回复、继续行动，或仅在确实有意静默时改用 mode=silent"
                        };
                        protocol_errors += 1;
                        self.record_response_protocol_error(
                            session_id,
                            &model_attempt_id,
                            protocol_errors,
                            "invalid_wait",
                            reason,
                        )
                        .await?;
                        if protocol_errors > MAX_RESPONSE_PROTOCOL_RETRIES {
                            return self
                                .publish_response_protocol_failure(
                                    session_id,
                                    &model_attempt_id,
                                    context.parent_session_id.as_deref(),
                                )
                                .await;
                        }
                        protocol_messages.push(Message {
                            role: "user".to_string(),
                            content: format!("{reason}。{RESPONSE_PROTOCOL_ERROR}"),
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        });
                        continue;
                    }
                    break (
                        response,
                        Some(TerminalDecision::NoReply(NoReplyMode::Wait)),
                        model_attempt_id,
                        provider_continuation,
                    );
                }
                Ok(decision) => {
                    break (response, decision, model_attempt_id, provider_continuation)
                }
                Err(reason) => {
                    protocol_errors += 1;
                    self.record_response_protocol_error(
                        session_id,
                        &model_attempt_id,
                        protocol_errors,
                        "invalid",
                        &reason,
                    )
                    .await?;
                    if protocol_errors > MAX_RESPONSE_PROTOCOL_RETRIES {
                        return self
                            .publish_response_protocol_failure(
                                session_id,
                                &model_attempt_id,
                                context.parent_session_id.as_deref(),
                            )
                            .await;
                    }
                    if response.tool_calls.is_empty() && !response.content.trim().is_empty() {
                        protocol_messages.push(Message {
                            role: "assistant".to_string(),
                            content: response.content,
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        });
                    }
                    protocol_messages.push(Message {
                        role: "user".to_string(),
                        content: format!("{reason}。{RESPONSE_PROTOCOL_ERROR}"),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                }
            }
        };

        if let Some(decision) = terminal_decision {
            let active_root_tasks = self
                .owed_background_jobs_for_thread(session_id, &activation.context_id, &thread)
                .await?;
            let pending_schedules = session_store
                .list_schedules(Some(&thread.id), Some(ScheduleStatus::Queued))
                .await?
                .len();
            let pending_routed_inputs = self.pending_routed_inputs(activation).await?;
            let explicit_wait = matches!(&decision, TerminalDecision::NoReply(NoReplyMode::Wait));
            if !completion_prepared
                && (explicit_wait
                    || (thread_kind != "dialogue_turn"
                        && (active_root_tasks > 0
                            || pending_schedules > 0
                            || pending_routed_inputs > 0)))
            {
                if let TerminalDecision::Deliver(content) = &decision {
                    // `reply(deliver)` is the model's own judgement that the
                    // turn is answered, and yielding does not overrule it.
                    // Reporting it as progress instead left a finished answer
                    // looking interim for good whenever the Agent had started a
                    // long-lived process: a dev server never exits, so the
                    // follow-up that the downgrade implied could never arrive.
                    //
                    // The question here is whether a person is waiting on this
                    // turn, not how a finished Execution result would be
                    // routed: `execution_result_is_interactive` answers the
                    // latter and reports false as soon as the Thread holds a
                    // detached job, which is exactly the case this fixes.
                    // Work rooted in anything but a user message has no one
                    // waiting, so it keeps reporting progress.
                    let answers_a_waiting_user = self
                        .context_engine
                        .find_event(&activation.context_id, &activation.root_turn_id)
                        .await?
                        .is_some_and(|root| root.event_type == TYPE_USER_MESSAGE);
                    if answers_a_waiting_user {
                        self.publish_reply_for_model_attempt(
                            session_id,
                            &attempt_id,
                            Some(&terminal_model_attempt_id),
                            content.clone(),
                            context.parent_session_id.as_deref(),
                        )
                        .await?;
                    } else {
                        self.publish_progress(session_id, &attempt_id, content.clone())
                            .await?;
                    }
                }
                self.yield_thread(
                    session_id,
                    &attempt_id,
                    active_root_tasks,
                    pending_schedules,
                    pending_routed_inputs,
                    decision.disposition(),
                )
                .await?;
                if let Some(lease) = dialogue_lease.as_mut() {
                    lease.release();
                }
                return Ok(());
            }
            self.record_terminal_response(
                session_id,
                &attempt_id,
                &terminal_model_attempt_id,
                &effective_phase,
                &response,
                &decision,
            )
            .await?;
            let direct_interactive_execution = thread_kind == "execution"
                && self
                    .execution_result_is_interactive(&thread, activation)
                    .await?;
            // The Objective Supervisor's stable primary lane is an Execution
            // Thread, but its finite Evaluation outcome is still the
            // Objective's direct delivery boundary.  Only explicitly spawned
            // Objective work branches (`origin_evaluation_id = Some`) enter
            // the asynchronous Thread-result/Delivery aggregator.  Treating
            // every Objective-supervised Execution as a detached work result
            // would lose the Evaluation route, leave its lease open, and make
            // the eventual Delivery reply look unrelated to the Objective.
            let objective_primary_execution = thread_kind == "execution"
                && thread.supervision.supervisor_kind
                    == crate::memory::ThreadSupervisorKind::Objective
                && thread.supervision.origin_evaluation_id.is_none();
            let result = match decision {
                TerminalDecision::Deliver(content) => {
                    if thread.executor_kind == "plan_infer"
                        || (thread_kind == "execution"
                            && !direct_interactive_execution
                            && !objective_primary_execution)
                    {
                        self.publish_thread_result(
                            session_id,
                            &attempt_id,
                            &terminal_model_attempt_id,
                            &thread,
                            content,
                        )
                        .await
                    } else {
                        self.publish_reply_for_model_attempt(
                            session_id,
                            &attempt_id,
                            Some(&terminal_model_attempt_id),
                            content,
                            context.parent_session_id.as_deref(),
                        )
                        .await
                    }
                }
                TerminalDecision::NoReply(_) => {
                    self.publish_no_reply(
                        session_id,
                        &attempt_id,
                        context.parent_session_id.as_deref(),
                    )
                    .await
                }
            };
            if let Some(lease) = dialogue_lease.as_mut() {
                lease.release();
            }
            return result;
        }

        debug_assert_ne!(effective_phase, "final-reply");

        if !response.tool_calls.is_empty() {
            if !response.content.trim().is_empty() {
                self.publish_progress(session_id, &attempt_id, response.content.clone())
                    .await?;
            }
            let context_maintenance_only = response
                .tool_calls
                .iter()
                .all(|call| call.func_name == "context_tx");
            if !context_maintenance_only {
                if dialogue_lease.is_some()
                    && session_store
                        .release_dialogue_turn_activation(&activation.id, Utc::now())
                        .await?
                {
                    tracing::debug!(
                        activation_id = %activation.id,
                        session_id,
                    event_code = "orchestrator.dialogue_turn.channel_released",
                    "DialogueTurn durably left the dialogue channel while physical tools continue in the original Activation"
                    );
                }
                if let Some(lease) = dialogue_lease.as_mut() {
                    lease.release();
                }
                // A later user message may already be durably queued behind
                // this Activation. Releasing the process-local gate alone
                // cannot wake the DB-backed admission queue, so refill it at
                // the same semantic boundary.
                self.refill_activation_admission_queue().await?;
            }
            let result = self
                .execute_tool_calls(
                    session_id,
                    &attempt_id,
                    response,
                    &effective_phase,
                    ToolExecutionOptions {
                        context_tx_allowed: context.turn_budget.context_tx_available
                            && !context_tx_cooldown,
                        wake_on_output: true,
                        plan_execution_id: None,
                        continuation_tool_calls: None,
                        allowed_tool_names,
                        record_assistant_call: true,
                        model_attempt_id: Some(terminal_model_attempt_id.clone()),
                        provider_continuation: terminal_provider_continuation,
                    },
                )
                .await;
            let outcome = result?;
            if outcome.context_tx_succeeded {
                if let Some(gate) = context_maintenance_gate.as_ref() {
                    gate.completed_epoch.fetch_add(1, Ordering::AcqRel);
                    tracing::info!(
                        context_id = %context_id,
                        activation_id = %activation.id,
                    event_code = "orchestrator.context_maintenance.transaction_committed",
                    "Context maintenance owner committed a transaction; waiters will re-evaluate from the new Projection"
                    );
                }
                if context_maintenance_only {
                    // The context_tx receipt was appended as a durable Signal
                    // while this Activation still owned Thread single-flight.
                    // A successor therefore cannot be claimed until the
                    // current Activation is terminal. Complete it first and
                    // redispatch that exact pending Signal. Do not wait for
                    // the successor row here: this caller still owns the
                    // root Thread gate that the successor must acquire before
                    // it can materialize. Durability remains in the pending
                    // Signal, and the outer completion path is idempotent.
                    self.finish_thread_activation(activation, ThreadActivationStatus::Succeeded)
                        .await?;
                    self.dispatch_next_pending_thread_signal(&activation.root_turn_id)
                        .await?;
                }
            }
            if context_maintenance_only {
                if let Some(lease) = dialogue_lease.as_mut() {
                    // The successor Signal is durable above. Keep the
                    // process-local lane for that same root so a later user
                    // turn cannot overtake its final reply while the Thread
                    // gate is handed to the successor.
                    lease.retain_for_continuation();
                }
            }
            return Ok(());
        }

        unreachable!("无工具响应应由终态协议分类、纠错或熔断处理")
    }

    async fn execution_result_is_interactive(
        &self,
        thread: &ThreadRecord,
        activation: &ThreadActivationRecord,
    ) -> Result<bool, DynError> {
        let root = self
            .context_engine
            .find_event(&activation.context_id, &activation.root_turn_id)
            .await?;
        if root.is_none_or(|event| event.event_type != TYPE_USER_MESSAGE) {
            return Ok(false);
        }
        let store = self
            .context_engine
            .session_store()
            .ok_or("Interactive Execution 路由需要持久化 SessionStore")?;
        if !store
            .list_schedules(Some(&thread.id), None)
            .await?
            .is_empty()
        {
            return Ok(false);
        }
        let Some(manager) = &self.execution_jobs else {
            return Ok(true);
        };
        let jobs = manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                thread_id: Some(thread.id.clone()),
                include_terminal: true,
                ..Default::default()
            })
            .await?;
        Ok(!jobs.iter().any(|job| {
            job.tool_name == "exec/background"
                || job.request.get("mode").and_then(serde_json::Value::as_str) == Some("detached")
                || job
                    .request
                    .get("detached")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        }))
    }

    async fn record_response_protocol_error(
        &self,
        session_id: &str,
        attempt_id: &str,
        error_count: usize,
        response_state: &str,
        reason: &str,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("error_count".to_string(), json!(error_count)),
            (
                "max_retries".to_string(),
                json!(MAX_RESPONSE_PROTOCOL_RETRIES),
            ),
            ("response_state".to_string(), json!(response_state)),
            ("reason".to_string(), json!(reason)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "response_protocol_error_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/response_protocol_error".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn restore_reasoning_continuation_state(
        &self,
        context_id: &str,
        session_id: &str,
        activation_id: &str,
    ) -> Result<DurableReasoningContinuationState, DynError> {
        let events = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                session_id: Some(session_id.to_string()),
                activation_id: Some(activation_id.to_string()),
                topics: vec![
                    "runtime/model_reasoning_summary".to_string(),
                    "runtime/reasoning_continuation".to_string(),
                ],
                // Event sequence is the only authoritative replay order.
                after_sequence: Some(0),
                ..Default::default()
            })
            .await?;
        durable_reasoning_continuation_state_from_events(activation_id, &events)
    }

    async fn record_reasoning_continuation(
        &self,
        session_id: &str,
        attempt_id: &str,
        continuation_count: usize,
        reasoning_chars: usize,
        provider_error: &str,
        provider_continuation: Option<&ProviderContinuation>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("continuation_count".to_string(), json!(continuation_count)),
            ("reasoning_chars".to_string(), json!(reasoning_chars)),
            ("response_state".to_string(), json!("reasoning_only")),
            ("reason".to_string(), json!(REASONING_ONLY_RESPONSE_REASON)),
            ("provider_error".to_string(), json!(provider_error)),
        ];
        if let Some(provider_continuation) = provider_continuation {
            payload.push((
                "provider_continuation".to_string(),
                json!(provider_continuation),
            ));
        }
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "reasoning_continuation_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/reasoning_continuation".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn record_reasoning_continuation_exhausted(
        &self,
        session_id: &str,
        attempt_id: &str,
        continuation_count: usize,
        stalled_count: usize,
        reason: &str,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("continuation_count".to_string(), json!(continuation_count)),
            ("stalled_count".to_string(), json!(stalled_count)),
            ("reason".to_string(), json!(reason)),
            ("requires_operator_attention".to_string(), json!(true)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "reasoning_continuation_exhausted_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_error".to_string(),
                "runtime/reasoning_continuation_exhausted".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn publish_response_protocol_failure(
        &self,
        session_id: &str,
        attempt_id: &str,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            (
                "invalid_responses".to_string(),
                json!(MAX_RESPONSE_PROTOCOL_RETRIES + 1),
            ),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "response_protocol_fused_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_error".to_string(),
                "runtime/response_protocol_fused".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        let objective_finalizing = if let (Some(supervisor), Some(binding)) = (
            self.objective_supervisor.as_ref(),
            self.objective_evaluations.get_for_activation(attempt_id),
        ) {
            let activation_id = attempt_id
                .split_once("_response_retry_")
                .map(|(base, _)| base)
                .unwrap_or(attempt_id);
            supervisor
                .get(&binding.objective_id)
                .await?
                .is_some_and(|objective| {
                    objective.completion_intent.as_ref().is_some_and(|intent| {
                        intent.activation_id == activation_id
                            && intent.evaluation_id == binding.evaluation_id
                    })
                })
        } else {
            false
        };
        if objective_finalizing {
            return self
                .publish_reply_with_attributes(
                    session_id,
                    attempt_id,
                    None,
                    "模型连续三次没有生成合法的 Objective 最终报告。本次完成意图已撤销，Objective 未被标记为完成；请检查模型状态后继续。".to_string(),
                    parent_session_id,
                    vec![
                        ("terminal_kind".to_string(), json!("failed")),
                        (
                            "runtime_failure_kind".to_string(),
                            json!("objective_finalization_protocol"),
                        ),
                        (
                            "runtime_failure_stage".to_string(),
                            json!("objective_finalization"),
                        ),
                    ],
                )
                .await;
        }
        self.publish_reply(
            session_id,
            attempt_id,
            "模型连续三次没有返回合法的普通文本或 no_reply，Runtime 已安全熔断本回合；已提交的 Mind、文件修改和 Events 均已保留。".to_string(),
            parent_session_id,
        )
        .await
    }

    async fn record_terminal_response(
        &self,
        session_id: &str,
        attempt_id: &str,
        model_attempt_id: &str,
        phase: &str,
        response: &crate::llm::Response,
        decision: &TerminalDecision,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let tool_calls = response
            .tool_calls
            .iter()
            .map(|call| crate::llm::ToolCall {
                id: call.id.clone(),
                r#type: call.r#type.clone(),
                function: crate::llm::FunctionCall {
                    name: call.func_name.clone(),
                    arguments: call.arguments.clone(),
                },
            })
            .collect::<Vec<_>>();
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("model_attempt_id".to_string(), json!(model_attempt_id)),
            ("phase".to_string(), json!(phase)),
            ("text".to_string(), json!(response.content)),
            ("tool_calls".to_string(), json!(tool_calls)),
            ("terminal_outcome".to_string(), json!(true)),
            (
                "outcome_disposition".to_string(),
                json!(decision.disposition()),
            ),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        let event_id = if phase == "objective-finalization" {
            format!("call_{attempt_id}_final")
        } else {
            format!("call_{attempt_id}")
        };
        self.bus
            .publish(Event::new(
                event_id,
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn publish_no_reply(
        &self,
        session_id: &str,
        attempt_id: &str,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        self.publish_no_reply_with_attributes(session_id, attempt_id, parent_session_id, Vec::new())
            .await
    }

    async fn owed_background_jobs_for_thread(
        &self,
        session_id: &str,
        context_id: &str,
        thread: &ThreadRecord,
    ) -> Result<usize, DynError> {
        let Some(manager) = self.execution_jobs.as_ref() else {
            return Ok(active_background_task_count_for_root(
                session_id,
                context_id,
                &thread.root_turn_id,
            ));
        };
        Ok(manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(context_id.to_string()),
                session_id: Some(session_id.to_string()),
                thread_id: Some(thread.id.clone()),
                tool_name: Some("exec/background".to_string()),
                include_terminal: false,
                ..ExecutionJobFilter::default()
            })
            .await?
            .into_iter()
            .filter(|job| {
                !job.request
                    .get("keep_running")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            })
            .count())
    }

    async fn owed_background_jobs_for_session(
        &self,
        session_id: &str,
        context_id: &str,
    ) -> Result<usize, DynError> {
        let Some(manager) = self.execution_jobs.as_ref() else {
            return Ok(active_background_task_count(session_id, context_id));
        };
        Ok(manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                context_id: Some(context_id.to_string()),
                session_id: Some(session_id.to_string()),
                tool_name: Some("exec/background".to_string()),
                include_terminal: false,
                ..ExecutionJobFilter::default()
            })
            .await?
            .into_iter()
            .filter(|job| {
                !job.request
                    .get("keep_running")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            })
            .count())
    }

    async fn publish_no_reply_with_attributes(
        &self,
        session_id: &str,
        attempt_id: &str,
        parent_session_id: Option<&str>,
        extra_payload: Vec<(String, serde_json::Value)>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let active_background_tasks = self
            .owed_background_jobs_for_session(session_id, context_id.as_str())
            .await?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("disposition".to_string(), json!("no_reply")),
            ("text".to_string(), json!("")),
            (
                "delivery_kind".to_string(),
                json!(self.delivery_kind_for_attempt(attempt_id)),
            ),
            (
                "active_background_tasks".to_string(),
                json!(active_background_tasks),
            ),
        ];
        payload.extend(extra_payload);
        if let Some(parent_session_id) = parent_session_id {
            payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        if let Some(route) = self
            .activation_route(attempt_id)
            .filter(|route| route.thread_kind == "delivery")
        {
            if !route.delivery_thread_ids.is_empty() {
                payload.push(("defer_covers".to_string(), json!(route.delivery_thread_ids)));
            }
        }
        self.append_activation_route(attempt_id, &mut payload);
        self.append_objective_activation_route(attempt_id, &mut payload);
        let event = Event::new(
            format!("no_reply_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/no_reply".to_string(),
            payload.into_iter().collect(),
        );
        if self.commit_and_dispatch_outcome(attempt_id, &event).await? {
            self.finalize_objective_outcome(event.clone()).await?;
        }
        Ok(())
    }

    async fn finalize_objective_outcome(&self, event: Event) -> Result<(), DynError> {
        let Some(supervisor) = self.objective_supervisor.as_ref().map(Arc::clone) else {
            return Ok(());
        };
        // The terminal Event and Activation outcome are already durable. Run
        // Objective reconciliation as a new scheduler task so admitting an
        // immediate successor Evaluation cannot remain nested inside the
        // just-finished model poll stack. Awaiting the task preserves strict
        // completion ordering and propagates every reconciliation error.
        tokio::spawn(async move { supervisor.terminal_outcome(&event).await })
            .await
            .map_err(|error| format!("Objective terminal reconciliation task failed: {error}"))??;
        Ok(())
    }

    fn register_runtime_failure_incident(
        &self,
        context_id: &str,
        stage: &str,
        failure: &ModelFailure,
        wait_resource: &str,
    ) -> RuntimeFailureObservation {
        let failure_class = if failure.kind.uses_provider_recovery() {
            "provider_recoverable"
        } else {
            failure.kind.as_str()
        };
        let key = format!(
            "{context_id}\u{0}{}\u{0}{wait_resource}\u{0}{stage}",
            failure_class
        );
        let now = Instant::now();
        match self.runtime_failure_incidents.entry(key) {
            dashmap::mapref::entry::Entry::Occupied(mut occupied) => {
                let incident = occupied.get_mut();
                if now.duration_since(incident.last_seen) <= RUNTIME_FAILURE_INCIDENT_WINDOW {
                    incident.last_seen = now;
                    incident.occurrences = incident.occurrences.saturating_add(1);
                    RuntimeFailureObservation {
                        id: incident.id.clone(),
                        occurrence: incident.occurrences,
                        should_notify_user: false,
                    }
                } else {
                    let incident_id = format!(
                        "runtime_failure_incident_{}",
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    );
                    *incident = RuntimeFailureIncident {
                        id: incident_id.clone(),
                        last_seen: now,
                        occurrences: 1,
                    };
                    RuntimeFailureObservation {
                        id: incident_id,
                        occurrence: 1,
                        should_notify_user: true,
                    }
                }
            }
            dashmap::mapref::entry::Entry::Vacant(vacant) => {
                let incident_id = format!(
                    "runtime_failure_incident_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                );
                vacant.insert(RuntimeFailureIncident {
                    id: incident_id.clone(),
                    last_seen: now,
                    occurrences: 1,
                });
                RuntimeFailureObservation {
                    id: incident_id,
                    occurrence: 1,
                    should_notify_user: true,
                }
            }
        }
    }

    async fn publish_reply(
        &self,
        session_id: &str,
        attempt_id: &str,
        content: String,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        self.publish_reply_for_model_attempt(
            session_id,
            attempt_id,
            None,
            content,
            parent_session_id,
        )
        .await
    }

    async fn publish_reply_for_model_attempt(
        &self,
        session_id: &str,
        attempt_id: &str,
        model_attempt_id: Option<&str>,
        content: String,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        self.publish_reply_with_attributes(
            session_id,
            attempt_id,
            model_attempt_id,
            content,
            parent_session_id,
            Vec::new(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn publish_reply_with_attributes(
        &self,
        session_id: &str,
        attempt_id: &str,
        model_attempt_id: Option<&str>,
        content: String,
        parent_session_id: Option<&str>,
        extra_payload: Vec<(String, serde_json::Value)>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("disposition".to_string(), json!("deliver")),
            (
                "delivery_kind".to_string(),
                json!(self.delivery_kind_for_attempt(attempt_id)),
            ),
            ("text".to_string(), json!(content)),
        ];
        if let Some(model_attempt_id) = model_attempt_id {
            payload.push(("model_attempt_id".to_string(), json!(model_attempt_id)));
        }
        if let Some(parent_session_id) = parent_session_id {
            payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        payload.extend(extra_payload);
        if let Some(route) = self
            .activation_route(attempt_id)
            .filter(|route| route.thread_kind == "delivery")
        {
            if !route.delivery_thread_ids.is_empty() {
                payload.push(("covers".to_string(), json!(route.delivery_thread_ids)));
            }
        }
        self.append_activation_route(attempt_id, &mut payload);
        self.append_objective_activation_route(attempt_id, &mut payload);
        let event = Event::new(
            format!("reply_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/reply".to_string(),
            payload.into_iter().collect(),
        );
        if self.commit_and_dispatch_outcome(attempt_id, &event).await? {
            self.finalize_objective_outcome(event.clone()).await?;
        }
        Ok(())
    }

    async fn publish_thread_result(
        &self,
        session_id: &str,
        attempt_id: &str,
        model_attempt_id: &str,
        thread: &ThreadRecord,
        content: String,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let route = self
            .activation_route(attempt_id)
            .ok_or_else(|| format!("Work result '{}' 缺少 Evaluation route", attempt_id))?;
        let result_event_id = format!(
            "thread_result_{}_{}",
            route.thread_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("model_attempt_id".to_string(), json!(model_attempt_id)),
            (
                "disposition".to_string(),
                json!(if thread.executor_kind == "plan_infer" {
                    "complete_internal_evaluation"
                } else {
                    "complete_pending_delivery"
                }),
            ),
            ("text".to_string(), json!(content)),
        ];
        if thread.executor_kind == "plan_infer" {
            payload.push(("plan_execution_id".to_string(), json!(thread.executor_id)));
        }
        self.append_activation_route(attempt_id, &mut payload);
        self.append_objective_activation_route(attempt_id, &mut payload);
        let result_event = Event::new(
            result_event_id.clone(),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            if thread.executor_kind == "plan_infer" {
                "plan/infer_result".to_string()
            } else {
                "runtime/thread_result".to_string()
            },
            payload.into_iter().collect(),
        );
        if !self
            .commit_and_dispatch_outcome(attempt_id, &result_event)
            .await?
        {
            return Ok(());
        }

        if thread.executor_kind != "plan_infer" {
            self.arm_delivery_flush(session_id).await?;
        }
        Ok(())
    }

    async fn arm_delivery_flush(&self, session_id: &str) -> Result<(), DynError> {
        let timers = &self.timer_engine;
        let store = self
            .context_engine
            .session_store()
            .ok_or("Completion delivery 需要持久化 SessionStore")?;
        let timer_id = delivery_flush_timer_id(session_id);
        let Some(timer) = store
            .arm_delivery_flush_timer(
                &timer_id,
                session_id,
                self.orchestrator_config
                    .scheduler
                    .delivery_merge_window
                    .as_secs(),
                self.orchestrator_config
                    .scheduler
                    .delivery_max_wait
                    .as_secs(),
                self.orchestrator_config
                    .scheduler
                    .delivery_snapshot_max_items,
            )
            .await?
        else {
            return Ok(());
        };
        // The store already armed the authoritative generation atomically.
        // Scheduling the same generation only wakes a sleeping dispatcher.
        timers
            .schedule(NewRuntimeTimer {
                id: timer.id,
                generation: timer.generation,
                kind: timer.kind,
                owner_id: timer.owner_id,
                due_at: timer.due_at,
                payload: timer.payload,
            })
            .await?;
        Ok(())
    }

    async fn recover_pending_delivery_flushes(&self) -> Result<usize, DynError> {
        let Some(store) = self.context_engine.session_store() else {
            return Ok(0);
        };
        let page_size = self
            .orchestrator_config
            .scheduler
            .delivery_recovery_page_size;
        let mut recovered = 0usize;
        loop {
            let sessions = store.list_pending_delivery_sessions(page_size).await?;
            if sessions.is_empty() {
                break;
            }
            let page_len = sessions.len();
            for session_id in &sessions {
                self.arm_delivery_flush(session_id).await?;
            }
            recovered = recovered.saturating_add(page_len);
            if page_len < page_size {
                break;
            }
        }
        if recovered != 0 {
            tracing::info!(
                sessions = recovered,
                event_code = "orchestrator.delivery_flush_timer.recovered",
                "Recovered Delivery Flush Timers from pending or deferred Threads"
            );
        }
        Ok(recovered)
    }

    async fn dispatch_delivery_flush(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let store = self
            .context_engine
            .session_store()
            .ok_or("Delivery Flush 需要持久化 SessionStore")?;
        let session_id = timer.owner_id.clone();
        let direct_event_id = delivery_flush_reply_event_id(&timer.id, timer.generation);
        if let Some(reply) = self
            .store
            .query(QueryFilter {
                event_id: Some(direct_event_id.clone()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|event| event.id == direct_event_id && event.topic == "chat/reply")
        {
            // The atomic fast-path commit may have succeeded immediately before
            // a process exit or transient dispatch failure. Covered Threads are
            // already `delivered`, so recover the stable reply by Event ID before
            // consulting the live pending set.
            self.bus.dispatch_persisted(reply).await?;
            self.refill_activation_admission_queue().await?;
            self.arm_delivery_flush(&session_id).await?;
            return Ok(TimerDisposition::Complete);
        }
        let threads = store
            .list_session_delivery_threads(
                &session_id,
                true,
                self.orchestrator_config
                    .scheduler
                    .delivery_snapshot_max_items,
            )
            .await?;
        if threads.is_empty() {
            return Ok(TimerDisposition::Complete);
        }
        let session = store
            .get_session(&session_id)
            .await?
            .ok_or_else(|| format!("Delivery Flush Session '{}' 不存在", session_id))?;
        let completed_thread_ids = timer
            .payload
            .get("completed_thread_ids")
            .and_then(serde_json::Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|ids| !ids.is_empty())
            .unwrap_or_else(|| threads.iter().map(|thread| thread.id.clone()).collect());
        let mut live_by_id = threads
            .into_iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<HashMap<_, _>>();
        let snapshot_threads = completed_thread_ids
            .iter()
            .filter_map(|thread_id| live_by_id.remove(thread_id))
            .collect::<Vec<_>>();
        if snapshot_threads.is_empty() {
            return Ok(TimerDisposition::Complete);
        }
        let completed_thread_ids = snapshot_threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let result_event_ids = snapshot_threads
            .iter()
            .filter_map(|thread| thread.result_event_id.clone())
            .collect::<Vec<_>>();
        if let Some((content, strategy)) = self
            .render_delivery_without_model(&snapshot_threads)
            .await?
        {
            let mut reply = Event::new(
                direct_event_id.clone(),
                "Runtime-Delivery".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/reply".to_string(),
                vec![
                    ("context_id".to_string(), json!(session.context_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(direct_event_id)),
                    ("root_turn_id".to_string(), json!(direct_event_id)),
                    ("thread_kind".to_string(), json!("delivery")),
                    (
                        "delivery_kind".to_string(),
                        json!(DELIVERY_KIND_THREAD_DELIVERY),
                    ),
                    ("disposition".to_string(), json!("deliver")),
                    ("delivery_strategy".to_string(), json!(strategy)),
                    (
                        "delivery_timer_generation".to_string(),
                        json!(timer.generation),
                    ),
                    ("covers".to_string(), json!(completed_thread_ids)),
                    ("result_event_ids".to_string(), json!(result_event_ids)),
                    ("text".to_string(), json!(content)),
                ]
                .into_iter()
                .collect(),
            );
            reply.timestamp = delivery_flush_timestamp(&timer);
            let commit = if let Some(kernel) = self.scheduler_kernel.as_ref() {
                let result = kernel
                    .execute(
                        crate::controllers::DeliveryController::commit_delivery_outcome(
                            &timer.id,
                            timer.generation,
                            reply.clone(),
                            None,
                            &session_id,
                            "Delivery-Controller",
                        ),
                    )
                    .await?;
                match result {
                    crate::scheduler::KernelResult::DeliveryOutcomeCommitted(commit) => commit,
                    other => return Err(format!("Delivery Kernel 返回意外结果：{other:?}").into()),
                }
            } else {
                store
                    .commit_delivery_flush_reply(&timer.id, timer.generation, &reply)
                    .await?
            };
            match commit {
                DeliveryFlushCommit::Committed | DeliveryFlushCommit::Existing { .. } => {
                    self.bus.dispatch_persisted(reply).await?;
                    // A strict follow-up DialogueTurn can be waiting on one
                    // of the covered Threads. The fast path has no model
                    // Activation whose permit release would otherwise wake
                    // the durable admission queue.
                    self.refill_activation_admission_queue().await?;
                    // A bounded snapshot can leave later results pending. Arm
                    // the next generation before completing this claimed
                    // generation; the generation fence makes the old timer's
                    // final acknowledgement harmless.
                    self.arm_delivery_flush(&session_id).await?;
                }
                DeliveryFlushCommit::Stale | DeliveryFlushCommit::Empty => {}
            }
            return Ok(TimerDisposition::Complete);
        }
        let delivery_event_id = delivery_flush_event_id(&timer.id, timer.generation);
        let mut event = Event::new(
            delivery_event_id.clone(),
            "Runtime-Delivery".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/thread_completion_ready".to_string(),
            vec![
                ("context_id".to_string(), json!(session.context_id)),
                ("session_id".to_string(), json!(session_id)),
                ("root_turn_id".to_string(), json!(delivery_event_id)),
                ("thread_kind".to_string(), json!("delivery")),
                (
                    "delivery_timer_generation".to_string(),
                    json!(timer.generation),
                ),
                (
                    "completed_thread_ids".to_string(),
                    json!(completed_thread_ids),
                ),
                ("result_event_ids".to_string(), json!(result_event_ids)),
                (
                    "text".to_string(),
                    json!("一个或多个 Thread 已完成。请只交付本次 completion snapshot 在 kernel.thread-scheduler 中呈现的 delivery=pending/deferred 结果，并结合最新并发状态形成一条清晰且不重复的消息；本次求值开始后新完成的结果属于下一次 Delivery，不要提前声称已覆盖。确实无需通知时才独占调用 no_reply。不得重复已经 delivered 的结果。"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        // Retrying one Timer generation must produce byte-identical Event
        // content. The latest pending timestamp is immutable for that
        // generation and survives process restart.
        event.timestamp = delivery_flush_timestamp(&timer);
        let delivery_thread = NewThread {
            id: stable_thread_id(&delivery_event_id),
            agent_id: session.agent_id.clone(),
            context_id: session.context_id.clone(),
            session_id: session_id.clone(),
            initiating_principal_id: None,
            root_turn_id: delivery_event_id.clone(),
            kind: ThreadKind::Delivery,
            executor_kind: "self".to_string(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("delivery-router"),
        };
        let commit = if let Some(kernel) = self.scheduler_kernel.as_ref() {
            let result = kernel
                .execute(
                    crate::controllers::DeliveryController::commit_delivery_outcome(
                        &timer.id,
                        timer.generation,
                        event.clone(),
                        Some(delivery_thread.clone()),
                        &session_id,
                        "Delivery-Controller",
                    ),
                )
                .await?;
            match result {
                crate::scheduler::KernelResult::DeliveryOutcomeCommitted(commit) => commit,
                other => return Err(format!("Delivery Kernel 返回意外结果：{other:?}").into()),
            }
        } else {
            store
                .commit_delivery_flush(&timer.id, timer.generation, &event, &delivery_thread)
                .await?
        };
        match commit {
            DeliveryFlushCommit::Committed => {
                self.bus.dispatch_persisted(event).await?;
            }
            DeliveryFlushCommit::Existing { .. }
            | DeliveryFlushCommit::Stale
            | DeliveryFlushCommit::Empty => {}
        }
        Ok(TimerDisposition::Complete)
    }

    async fn render_delivery_without_model(
        &self,
        threads: &[ThreadRecord],
    ) -> Result<Option<(String, &'static str)>, DynError> {
        if threads.is_empty() {
            return Ok(None);
        }
        let texts = threads
            .iter()
            .map(|thread| thread.result_text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>();
        if texts.iter().any(|text| text.trim().is_empty()) {
            return Ok(None);
        }
        if threads.len() == 1 {
            return Ok(Some((texts[0].to_string(), "passthrough")));
        }
        let policy = &self.orchestrator_config.scheduler;
        let total_chars = texts.iter().map(|text| text.chars().count()).sum::<usize>();
        if threads.len() > policy.delivery_deterministic_batch_max_items
            || total_chars > policy.delivery_deterministic_batch_max_chars
            || threads.iter().any(|thread| {
                thread.kind != ThreadKind::Execution || thread.executor_kind != "self"
            })
        {
            return Ok(None);
        }
        for thread in threads {
            let Some(result_event_id) = thread.result_event_id.as_deref() else {
                return Ok(None);
            };
            let result = self
                .store
                .query(QueryFilter {
                    event_id: Some(result_event_id.to_string()),
                    ..Default::default()
                })
                .await?;
            if result.iter().any(|event| {
                event
                    .payload
                    .get("delivery_requires_composition")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            }) {
                return Ok(None);
            }
        }
        let mut content = format!("以下 {} 项工作已完成：", texts.len());
        for (index, text) in texts.iter().enumerate() {
            content.push_str(&format!("\n\n{}. {}", index + 1, text.trim()));
        }
        Ok(Some((content, "deterministic_batch")))
    }

    async fn pending_delivery_threads(&self, session_id: &str) -> Result<Vec<String>, DynError> {
        self.delivery_threads(session_id, false).await
    }

    async fn delivery_threads(
        &self,
        session_id: &str,
        include_deferred: bool,
    ) -> Result<Vec<String>, DynError> {
        let store = self
            .context_engine
            .session_store()
            .ok_or("Completion delivery 需要持久化 SessionStore")?;
        Ok(store
            .list_session_delivery_threads(
                session_id,
                include_deferred,
                self.orchestrator_config
                    .scheduler
                    .delivery_snapshot_max_items,
            )
            .await?
            .into_iter()
            .map(|thread| thread.id)
            .collect())
    }

    async fn commit_and_dispatch_outcome(
        &self,
        attempt_id: &str,
        event: &Event,
    ) -> Result<bool, DynError> {
        let Some(route) = self.activation_route(attempt_id) else {
            self.bus.publish(event.clone()).await?;
            return Ok(true);
        };
        let mut committed = None;
        for retry in 0..5u64 {
            let result = if let Some(kernel) = self.scheduler_kernel.as_ref() {
                kernel
                    .execute(
                        crate::controllers::DeliveryController::commit_thread_outcome(
                            &route.activation_id,
                            event.clone(),
                            event
                                .payload
                                .get("context_id")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("context-unknown"),
                            "Orchestrator",
                        ),
                    )
                    .await
                    .map(|result| match result {
                        crate::scheduler::KernelResult::ThreadOutcomeCommitted(outcome) => outcome,
                        _ => unreachable!("CommitThreadOutcome command returned wrong result"),
                    })
                    .map_err(|error| Box::new(error) as DynError)
            } else {
                let session_store = self
                    .context_engine
                    .session_store()
                    .ok_or("Evaluation outcome 需要持久化 SessionStore")?;
                session_store
                    .commit_activation_outcome(&route.activation_id, event)
                    .await
            };
            match result {
                Ok(commit) => {
                    committed = Some(commit);
                    break;
                }
                Err(error) if retry < 4 => {
                    tracing::warn!(
                        activation_id = %route.activation_id,
                        event_id = %event.id,
                        %error,
                        retry,
                        event_code = "orchestrator.evaluation_outcome.persist_retrying",
                        "Evaluation outcome persistence failed; safely retrying the same idempotent commit"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        50u64.saturating_mul(1 << retry),
                    ))
                    .await;
                }
                Err(error) => return Err(error),
            }
        }
        let commit = committed.ok_or("Evaluation outcome 持久化没有产生结果")?;
        let requested_provider_wait = event
            .payload
            .get("disposition")
            .and_then(serde_json::Value::as_str)
            == Some("provider_wait");
        let (
            should_dispatch,
            ready_signal_event_ids,
            ready_supervisor_event_ids,
            thread_terminal,
            recover_existing_handoffs,
        ) = match commit {
            ActivationOutcomeCommit::Committed {
                ready_signal_event_ids,
                ready_supervisor_event_ids,
            } => (
                true,
                ready_signal_event_ids,
                ready_supervisor_event_ids,
                true,
                false,
            ),
            ActivationOutcomeCommit::Suspended { ref dependency_id } => {
                tracing::info!(
                    activation_id = %route.activation_id,
                    thread_id = %route.thread_id,
                    dependency_id,
                event_code = "orchestrator.thread.provider_wait_persisted",
                "Thread durably entered Provider wait while retaining an open lifecycle"
                );
                (true, Vec::new(), Vec::new(), false, false)
            }
            ActivationOutcomeCommit::Existing { ref event_id } if event_id == &event.id => {
                // The process may have committed the immutable outcome and
                // failed before dispatching it.  Redispatching that exact
                // Event is safe and closes the durable/live handoff.
                tracing::warn!(
                    activation_id = %route.activation_id,
                    event_id = %event.id,
                event_code = "orchestrator.evaluation_outcome.unconfirmed_dispatch_recovered",
                "Recovering a persisted Evaluation outcome whose dispatch was not confirmed"
                );
                (
                    true,
                    Vec::new(),
                    Vec::new(),
                    !requested_provider_wait,
                    !requested_provider_wait,
                )
            }
            ActivationOutcomeCommit::Existing { ref event_id } => {
                tracing::warn!(
                    activation_id = %route.activation_id,
                    duplicate_event_id = %event.id,
                    committed_event_id = %event_id,
                event_code = "orchestrator.evaluation_outcome.duplicate_suppressed",
                "Suppressed duplicate terminal output from the same Thread Activation"
                );
                (false, Vec::new(), Vec::new(), false, false)
            }
            ActivationOutcomeCommit::DeferredByOpenThreadGroups { ref group_ids } => {
                tracing::info!(
                    activation_id = %route.activation_id,
                    event_id = %event.id,
                    thread_group_ids = ?group_ids,
                event_code = "orchestrator.thread_group.terminal_blocked",
                "Parent Thread generation still has required attached Threads; delaying terminal commit until the Group barrier wakes"
                );
                (false, Vec::new(), Vec::new(), false, false)
            }
            ActivationOutcomeCommit::StaleGeneration => {
                tracing::warn!(
                    activation_id = %route.activation_id,
                    event_id = %event.id,
                event_code = "orchestrator.evaluation_outcome.dialogue_generation_stale",
                "Suppressed stale terminal output fenced by DialogueTurn generation"
                );
                (false, Vec::new(), Vec::new(), false, false)
            }
            ActivationOutcomeCommit::StaleActivation => {
                tracing::warn!(
                    activation_id = %route.activation_id,
                    event_id = %event.id,
                event_code = "orchestrator.evaluation_outcome.activation_stale",
                "Suppressed stale output from a cancelled or terminal physical Activation"
                );
                (false, Vec::new(), Vec::new(), false, false)
            }
        };
        if should_dispatch {
            let mut dispatched = false;
            let mut dispatch_error = None;
            for retry in 0..4u64 {
                match self.bus.dispatch_persisted(event.clone()).await {
                    Ok(()) => {
                        dispatched = true;
                        break;
                    }
                    Err(error) => {
                        dispatch_error = Some(error.to_string());
                        tracing::warn!(
                            activation_id = %route.activation_id,
                            event_id = %event.id,
                            %error,
                            retry,
                        event_code = "orchestrator.evaluation_outcome.dispatch_retrying",
                        "Durable Evaluation outcome dispatch failed; retaining and retrying the same Event"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(
                            50u64.saturating_mul(1 << retry),
                        ))
                        .await;
                    }
                }
            }
            if !dispatched {
                return Err(format!(
                    "Evaluation outcome '{}' 已持久化但派发重试耗尽：{}",
                    event.id,
                    dispatch_error.unwrap_or_else(|| "unknown dispatch error".to_string())
                )
                .into());
            }
            // The outcome transaction may have made an exact parent Thread
            // Signal ready.  The Signal already exists durably and carries a
            // generation fence; dispatching its source Event is only a live
            // executor notification, never a second routing decision.
            for signal_event_id in ready_signal_event_ids {
                let signal_event = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(signal_event_id.clone()),
                        ..Default::default()
                    })
                    .await?
                    .into_iter()
                    .find(|candidate| candidate.id == signal_event_id)
                    .ok_or_else(|| {
                        format!(
                            "Outcome transaction 返回的 Signal Event '{}' 不存在",
                            signal_event_id
                        )
                    })?;
                self.bus.dispatch_persisted(signal_event).await?;
            }
            // Objective/Runtime supervisors do not consume Thread Signals.
            // Their terminal Group barrier is nevertheless a durable wake
            // fact and must cross the post-commit EventBus handoff. Startup
            // reconciliation remains the crash fallback for this notification.
            for supervisor_event_id in ready_supervisor_event_ids {
                let supervisor_event = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(supervisor_event_id.clone()),
                        ..Default::default()
                    })
                    .await?
                    .into_iter()
                    .find(|candidate| candidate.id == supervisor_event_id)
                    .ok_or_else(|| {
                        format!(
                            "Outcome transaction 返回的 Supervisor Event '{}' 不存在",
                            supervisor_event_id
                        )
                    })?;
                self.bus.dispatch_persisted(supervisor_event).await?;
            }
            if recover_existing_handoffs {
                let terminal_thread = self
                    .context_engine
                    .session_store()
                    .ok_or("恢复终态交接需要持久化 SessionStore")?
                    .get_thread(&route.thread_id)
                    .await?
                    .ok_or_else(|| {
                        format!(
                            "恢复 Activation '{}' 的终态交接时 Thread '{}' 不存在",
                            route.activation_id, route.thread_id
                        )
                    })?;
                self.wake_terminal_thread_supervisor(&terminal_thread)
                    .await?;
            }
            if thread_terminal {
                self.revoke_thread_capability_leases(
                    &route.thread_id,
                    "owning Thread reached a terminal outcome",
                )
                .await;
                if let Some(scheduler) = &self.thread_scheduler {
                    if let Err(error) = scheduler.dependency_completed(&route.thread_id).await {
                        // The terminal Thread and outcome are already durable.
                        // Startup recovery re-arms every queued schedule, so
                        // dependency notification failure must not suppress the
                        // user-visible terminal outcome.
                        tracing::error!(
                            thread_id = %route.thread_id,
                            %error,
                        event_code = "orchestrator.thread.schedule_wake_failed",
                        "Thread is terminal but its dependent Schedule could not be woken immediately; waiting for recovery replay"
                        );
                    }
                }
            }
            return Ok(true);
        }
        Ok(false)
    }

    async fn revoke_thread_capability_leases(&self, thread_id: &str, reason: &str) {
        let Some(services) = &self.durable_approvals else {
            return;
        };
        let leases = match services
            .capability_leases
            .list_capability_leases(CapabilityLeaseFilter {
                thread_id: Some(thread_id.to_string()),
                active_at: Some(Utc::now()),
                limit: Some(1_000),
                ..CapabilityLeaseFilter::default()
            })
            .await
        {
            Ok(leases) => leases,
            Err(error) => {
                tracing::error!(event_code = "orchestrator.capability_lease.read_failed", thread_id, %error, "Failed to read Thread Capability Lease");
                return;
            }
        };
        for lease in leases {
            match services
                .capability_leases
                .revoke_capability_lease(&lease.id, lease.revision, reason)
                .await
            {
                Ok(
                    CapabilityLeaseMutation::Updated(_)
                    | CapabilityLeaseMutation::Existing(_)
                    | CapabilityLeaseMutation::NotFound,
                ) => {}
                Ok(CapabilityLeaseMutation::Conflict { current }) => {
                    tracing::debug!(
                        lease_id = %current.id,
                        revision = current.revision,
                        event_code = "orchestrator.capability_lease.concurrent_update",
                        "Capability Lease was concurrently modified; preserving the latest state"
                    );
                }
                Ok(CapabilityLeaseMutation::Created(_)) => {
                    tracing::error!(event_code = "orchestrator.capability_lease.revoke_created_record", lease_id = %lease.id, "Revoking a Capability Lease unexpectedly created a record");
                }
                Err(error) => {
                    tracing::error!(event_code = "orchestrator.capability_lease.revoke_failed", lease_id = %lease.id, %error, "Failed to revoke Thread Capability Lease");
                }
            }
        }
    }

    async fn yield_thread(
        &self,
        session_id: &str,
        attempt_id: &str,
        active_background_tasks: usize,
        pending_schedules: usize,
        pending_routed_inputs: usize,
        model_disposition: &str,
    ) -> Result<(), DynError> {
        let route = self
            .activation_route(attempt_id)
            .ok_or_else(|| format!("Evaluation '{}' 缺少 Thread route", attempt_id))?;
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread phase 投影需要持久化 SessionStore")?;
        let Some(current) = session_store.get_thread(&route.thread_id).await? else {
            return Err(format!("Thread '{}' 不存在", route.thread_id).into());
        };
        if current.lifecycle.is_terminal() {
            return Ok(());
        }
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            (
                "active_background_tasks".to_string(),
                json!(active_background_tasks),
            ),
            ("pending_schedules".to_string(), json!(pending_schedules)),
            (
                "pending_routed_inputs".to_string(),
                json!(pending_routed_inputs),
            ),
            ("model_disposition".to_string(), json!(model_disposition)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "thread_waiting_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "runtime/thread_waiting".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    fn append_objective_activation_route(
        &self,
        attempt_id: &str,
        payload: &mut Vec<(String, serde_json::Value)>,
    ) {
        let Some(active) = self.objective_evaluations.get_for_activation(attempt_id) else {
            return;
        };
        payload.extend([
            ("objective_id".to_string(), json!(active.objective_id)),
            (
                "objective_evaluation_id".to_string(),
                json!(active.evaluation_id),
            ),
            ("objective_revision".to_string(), json!(active.revision)),
        ]);
    }

    fn bind_embedded_objective_route(&self, activation_id: &str, event: &Event) {
        let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
        else {
            return;
        };
        let Some(evaluation_id) = event
            .payload
            .get("objective_evaluation_id")
            .and_then(|value| value.as_str())
        else {
            return;
        };
        self.objective_evaluations.bind_activation(
            activation_id,
            crate::objective::ActiveObjectiveEvaluation {
                objective_id: objective_id.to_string(),
                evaluation_id: evaluation_id.to_string(),
                revision: event
                    .payload
                    .get("objective_revision")
                    .and_then(|value| value.as_u64())
                    .unwrap_or_default(),
                started_at: event.timestamp,
                pending_dependency_id: None,
            },
        );
    }

    async fn publish_progress(
        &self,
        session_id: &str,
        attempt_id: &str,
        content: String,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("text".to_string(), json!(content)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!("progress_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/progress".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn publish_provider_wait(
        &self,
        context_id: &str,
        session_id: &str,
        attempt_id: &str,
        stage: &str,
        failure: &ModelFailure,
        parent_session_id: Option<&str>,
        provider_resource: &str,
        error_text: &str,
        incident: &RuntimeFailureObservation,
        user_message: &str,
    ) -> Result<(), DynError> {
        let route = self
            .activation_route(attempt_id)
            .ok_or("Provider wait 缺少 Activation route")?;
        let mut wait_payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("disposition".to_string(), json!("provider_wait")),
            (
                "text".to_string(),
                json!(if incident.should_notify_user {
                    user_message
                } else {
                    ""
                }),
            ),
            ("provider_resource".to_string(), json!(provider_resource)),
            (
                "provider_wait_generation".to_string(),
                json!(route.trigger_sequence.max(1)),
            ),
            (
                "runtime_failure_kind".to_string(),
                json!(failure.kind.as_str()),
            ),
            ("runtime_failure_stage".to_string(), json!(stage)),
            ("runtime_failure_error".to_string(), json!(error_text)),
            (
                "runtime_failure_incident_id".to_string(),
                json!(&incident.id),
            ),
            (
                "runtime_failure_incident_occurrence".to_string(),
                json!(incident.occurrence),
            ),
            (
                "runtime_failure_user_notice_suppressed".to_string(),
                json!(!incident.should_notify_user),
            ),
        ];
        if let Some(parent_session_id) = parent_session_id {
            wait_payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        if let Some(seconds) = failure.retry_after_secs {
            wait_payload.push(("retry_after_secs".to_string(), json!(seconds)));
        }
        self.append_activation_route(attempt_id, &mut wait_payload);
        let wait_event = Event::new(
            format!("provider_wait_{}", route.activation_id),
            "Runtime-Orchestrator".to_string(),
            TYPE_AGENT_CALL.to_string(),
            if incident.should_notify_user {
                "chat/progress".to_string()
            } else {
                "runtime/provider_wait".to_string()
            },
            wait_payload.into_iter().collect(),
        );
        if self
            .commit_and_dispatch_outcome(attempt_id, &wait_event)
            .await?
        {
            // Provider monitoring is normally armed at the physical failure
            // boundary. Re-arming after the durable dependency commit closes
            // the race where a fast probe publishes before the wait exists.
            self.record_provider_failure(context_id, failure).await;
        }
        Ok(())
    }

    async fn publish_runtime_failure(
        &self,
        session_id: &str,
        attempt_id: &str,
        stage: &str,
        failure: &ModelFailure,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let error_text: String = failure.to_string().chars().take(2_000).collect();
        let provider_resource = self.client.provider_resource_key();
        let wait_resource = match failure.kind {
            ModelFailureKind::ContextLimit => {
                format!("context-maintenance:{context_id}")
            }
            kind if kind.uses_provider_recovery() => provider_resource.clone(),
            _ => String::new(),
        };
        let incident =
            self.register_runtime_failure_incident(&context_id, stage, failure, &wait_resource);
        // Incident coalescing may suppress repeated infrastructure notices,
        // but each user turn that terminates on a deterministic request or
        // quota error still needs its own visible outcome.
        let should_notify_user = incident.should_notify_user
            || matches!(
                failure.kind,
                ModelFailureKind::InvalidModelOrRequest | ModelFailureKind::QuotaExhausted
            );
        let ordinary_provider_wait = failure.kind.uses_provider_recovery()
            && self.activation_route(attempt_id).is_some_and(|route| {
                self.objective_evaluations
                    .get_for_activation(&route.activation_id)
                    .is_none()
            });
        if should_notify_user && ordinary_provider_wait {
            tracing::warn!(
                session_id,
                attempt_id,
                incident_id = %incident.id,
                error = %error_text,
                failure_kind = failure.kind.as_str(),
                event_code = "orchestrator.model_request.provider_wait_entered",
                "LLM request failed after retries; Thread entered durable Provider wait"
            );
        } else if should_notify_user {
            tracing::error!(
                session_id,
                attempt_id,
                incident_id = %incident.id,
                error = %error_text,
                failure_kind = failure.kind.as_str(),
                event_code = "orchestrator.model_request.turn_failed",
                "LLM request failed after retries; terminating the turn and recording a recoverable failure Event"
            );
        } else {
            tracing::warn!(
                session_id,
                attempt_id,
                incident_id = %incident.id,
                occurrence = incident.occurrence,
                failure_kind = failure.kind.as_str(),
                event_code = "orchestrator.runtime_failure.duplicate_notice_suppressed",
                "The same Runtime failure is still occurring; suppressing duplicate user notices"
            );
        }
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("stage".to_string(), json!(stage)),
            ("error".to_string(), json!(&error_text)),
            ("failure_kind".to_string(), json!(failure.kind.as_str())),
            ("provider_resource".to_string(), json!(&provider_resource)),
            ("incident_id".to_string(), json!(&incident.id)),
            (
                "incident_occurrence".to_string(),
                json!(incident.occurrence),
            ),
        ];
        if !wait_resource.is_empty() {
            payload.push(("wait_resource".to_string(), json!(&wait_resource)));
        }
        if let Some(status) = failure.http_status {
            payload.push(("http_status".to_string(), json!(status)));
        }
        if let Some(code) = failure.provider_code.as_deref() {
            payload.push(("provider_code".to_string(), json!(code)));
        }
        if let Some(seconds) = failure.retry_after_secs {
            payload.push(("retry_after_secs".to_string(), json!(seconds)));
        }
        if should_notify_user && !ordinary_provider_wait {
            self.append_activation_route(attempt_id, &mut payload);
            self.bus
                .publish(Event::new(
                    format!(
                        "runtime_error_{}",
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    ),
                    "Runtime-Orchestrator".to_string(),
                    "runtime_error".to_string(),
                    "chat/runtime_error".to_string(),
                    payload.into_iter().collect(),
                ))
                .await?;
        }

        let user_message = match failure.kind {
            ModelFailureKind::ContextLimit
                if stage == "critical_maintenance_minimum_projection" =>
            {
                "即使只保留最小维护投影，模型接口仍拒绝当前 Context 大小。Runtime 已停止自动维护循环；请扩大模型 Context，或人工检查不可裁剪的系统契约与受保护 Mind。".to_string()
            }
            ModelFailureKind::ContextLimit => {
                "模型接口拒绝了当前 Context 大小。Runtime 已停止本次物理请求并进入 Context 维护协调；任务状态与已提交修改均已保留。".to_string()
            }
            kind if kind.is_provider_transient() => {
                "模型服务暂时不可用。Runtime 已保留当前任务并转入 Provider 退避等待；服务恢复后将继续。".to_string()
            }
            ModelFailureKind::Authentication => {
                "模型 Provider 认证无效。Runtime 已保留当前任务并进入低频 Provider 重试；修复凭证后将自动继续。".to_string()
            }
            ModelFailureKind::InvalidModelOrRequest => {
                format!(
                    "模型或请求参数无效。Runtime 已停止本回合并保留 Session；修正模型或推理设置后重试。\n\n原始错误：{error_text}"
                )
            }
            ModelFailureKind::QuotaExhausted => {
                format!(
                    "模型服务额度已耗尽。本次请求已经结束，不会进入等待队列；请等待额度恢复、升级订阅或切换模型。\n\n服务返回：{error_text}"
                )
            }
            ModelFailureKind::HardDeadlineExceeded => {
                "模型请求超过了 Runtime 配置的单次硬期限。本回合已取消，不会把请求延长成无限 Provider 恢复循环；Session、Mind 与已提交修改均已保留。".to_string()
            }
            ModelFailureKind::ProviderQueueTimeout => {
                "Runtime 未能在配置的等待时间内获得本地模型请求槽。请求尚未发送给 Provider，本回合已结束；Session、Mind 与已提交修改均已保留。".to_string()
            }
            ModelFailureKind::ReasoningContinuationExhausted => {
                "模型连续只返回推理进度，未在 Runtime 配置的安全边界内产生最终正文或工具调用。本回合已安全熔断，不会误判为 Provider 故障并无限重试。".to_string()
            }
            kind if kind.uses_provider_recovery() => {
                "模型请求失败。Runtime 已保留当前任务并进入 Provider 退避重试；Provider 可用后将自动继续。".to_string()
            }
            _ if stage == "llm_completion" => {
                "模型请求失败，Runtime 已停止本回合，未继续执行任何工具。当前 Session、Mind 与已提交文件修改均已保留。".to_string()
            }
            _ => {
                "Runtime 的完整 Attempt 超过执行期限，已取消本回合以避免用户一直等待。当前 Session、Mind 与已提交文件修改均已保留。".to_string()
            }
        };
        if ordinary_provider_wait {
            Box::pin(self.publish_provider_wait(
                &context_id,
                session_id,
                attempt_id,
                stage,
                failure,
                parent_session_id,
                &provider_resource,
                &error_text,
                &incident,
                &user_message,
            ))
            .await?;
            return Ok(());
        }
        let mut attributes = vec![
            (
                "runtime_failure_kind".to_string(),
                json!(failure.kind.as_str()),
            ),
            ("runtime_failure_stage".to_string(), json!(stage)),
            ("provider_resource".to_string(), json!(provider_resource)),
            (
                "runtime_failure_incident_id".to_string(),
                json!(&incident.id),
            ),
            (
                "runtime_failure_incident_occurrence".to_string(),
                json!(incident.occurrence),
            ),
        ];
        if !wait_resource.is_empty() {
            attributes.push(("wait_resource".to_string(), json!(wait_resource)));
        }
        if let Some(seconds) = failure.retry_after_secs {
            attributes.push(("retry_after_secs".to_string(), json!(seconds)));
        }
        if should_notify_user {
            self.publish_reply_with_attributes(
                session_id,
                attempt_id,
                Some(attempt_id),
                user_message,
                parent_session_id,
                attributes,
            )
            .await
        } else {
            attributes.push((
                "runtime_failure_user_notice_suppressed".to_string(),
                json!(true),
            ));
            self.publish_no_reply_with_attributes(
                session_id,
                attempt_id,
                parent_session_id,
                attributes,
            )
            .await
        }
    }

    async fn record_model_attempt_started(
        &self,
        session_id: &str,
        attempt_id: &str,
        phase: &str,
        context: &ContextView,
        tool_count: usize,
        input_signal_count: usize,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut route = Vec::new();
        self.append_activation_route(attempt_id, &mut route);
        let attributes = vec![
            ("phase".to_string(), json!(phase)),
            ("tool_count".to_string(), json!(tool_count)),
            ("pressure".to_string(), json!(context.pressure)),
            ("turn_budget".to_string(), json!(context.turn_budget)),
            (
                "request_shape".to_string(),
                json!({
                    "context_encoding_chars": context.sexpr.chars().count(),
                    "observation_count": context.observations.len(),
                    "input_signal_count": input_signal_count,
                }),
            ),
            (
                "provider_queue_timeout_secs".to_string(),
                json!(self
                    .orchestrator_config
                    .model_provider_queue_timeout_secs
                    .max(1)),
            ),
            (
                "hard_deadline_secs".to_string(),
                json!(self.orchestrator_config.model_attempt_hard_timeout_secs),
            ),
        ];
        persist_model_attempt_state(
            &self.bus,
            &context_id,
            session_id,
            attempt_id,
            &route,
            "queued",
            false,
            Some("waiting for Provider admission"),
            &attributes,
        )
        .await
    }

    async fn record_model_attempt_terminal_state(
        &self,
        session_id: &str,
        attempt_id: &str,
        state: &str,
        detail: Option<&str>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut route = Vec::new();
        self.append_activation_route(attempt_id, &mut route);
        persist_model_attempt_state(
            &self.bus,
            &context_id,
            session_id,
            attempt_id,
            &route,
            state,
            true,
            detail,
            &[],
        )
        .await?;
        if let Some(route) = self.activation_route(attempt_id) {
            self.active_model_attempts
                .remove_if(&route.activation_id, |_, active_attempt_id| {
                    active_attempt_id == attempt_id
                });
        }
        Ok(())
    }

    /// Close the physical stream whose evaluation future was dropped by an
    /// authoritative Activation cancellation. This transition is best-effort:
    /// the Scheduler tables already contain the durable cancellation, and a
    /// telemetry write failure must not resurrect or fail that cancellation.
    async fn close_cancelled_model_attempt(
        &self,
        session_id: &str,
        activation_id: &str,
        reason: &str,
    ) {
        let Some((_, attempt_id)) = self.active_model_attempts.remove(activation_id) else {
            return;
        };
        if let Err(error) = self
            .record_model_attempt_terminal_state(session_id, &attempt_id, "cancelled", Some(reason))
            .await
        {
            tracing::warn!(
                session_id,
                activation_id,
                attempt_id,
                %error,
                event_code = "orchestrator.model_attempt.cancelled_persist_failed",
                "Activation was cancelled but the Model Attempt cancelled terminal state could not be persisted"
            );
        }
    }

    async fn plan_execution_job(
        &self,
        plan: &PlanExecutionRecord,
        effect: &crate::sexpr_eval::PlanEffect,
        effect_tool_call_id: &str,
    ) -> PlanExecutionResult<NewExecutionJob> {
        let crate::sexpr_eval::PlanEffect::Call {
            tool: tool_name,
            arguments,
            ..
        } = effect
        else {
            return Err("只有 call effect 可以规划 Execution Job".into());
        };
        let tool = self
            .registry
            .get(tool_name)
            .ok_or_else(|| format!("Yao Plan 调用了未注册工具 '{tool_name}'"))?;
        if tool.execution_class() != crate::tool::ToolExecutionClass::PhysicalJob {
            return Err(format!(
                "Yao Plan 的 (call {tool_name} ...) 必须进入 Physical Execution Job；LogicalInline 工具不能绕过其控制平面"
            )
            .into());
        }

        let raw_arguments = serde_json::to_string(arguments)?;
        let invocation = crate::execution_target::split_target_argument(&raw_arguments)?;
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Yao Plan 物理调用需要持久化 ThreadStore")?;
        let thread = session_store
            .get_thread(&plan.thread_id)
            .await?
            .ok_or_else(|| format!("Yao Plan Thread '{}' 不存在", plan.thread_id))?;
        if thread.context_id != plan.context_id
            || thread.session_id != plan.session_id
            || thread.agent_id != plan.agent_id
            || thread.initiating_principal_id != plan.initiating_principal_id
        {
            return Err("Yao Plan 与执行 Thread 的权威 route 不一致".into());
        }
        if tool.execution_routing() == crate::tool::ToolExecutionRouting::ArtifactTransfer {
            let transfer = crate::artifact::transfer_request_from_tool_arguments(
                &raw_arguments,
                format!("transfer:{effect_tool_call_id}"),
            )?;
            let dispatcher = self
                .execution_targets
                .as_ref()
                .ok_or("Yao Plan Artifact Transfer 缺少 ExecutionTargetDispatcher")?;
            let (source, destination) = dispatcher
                .validate_artifact_transfer(
                    &transfer,
                    &raw_arguments,
                    plan.initiating_principal_id.as_deref(),
                    &plan.agent_id,
                    &plan.context_id,
                    &plan.thread_id,
                )
                .await?;
            let mut request = serde_json::from_str(&raw_arguments)?;
            crate::execution_target::attach_artifact_transfer_routes(
                &mut request,
                &crate::execution_target::ArtifactTransferRouteSnapshot {
                    source: crate::execution_target::ExecutionRouteSnapshot::freeze(&source),
                    destination: crate::execution_target::ExecutionRouteSnapshot::freeze(
                        &destination,
                    ),
                },
            )?;
            attach_execution_join_route(&mut request, None, false)?;
            let full_access = self
                .durable_approvals
                .as_ref()
                .is_some_and(|services| services.broker.profile().full_access());
            let requirement = if full_access {
                None
            } else {
                let local = if source.kind == crate::memory::ExecutionTargetKind::InProcessLocal
                    || destination.kind == crate::memory::ExecutionTargetKind::InProcessLocal
                {
                    tool.approval_requirement(&raw_arguments)?
                } else {
                    None
                };
                let remote =
                    crate::execution_target::remote_artifact_transfer_approval_requirement(
                        &source,
                        &destination,
                        &transfer,
                    )?;
                merge_artifact_transfer_requirements(local, remote)
            };
            return ExecutionJobSpec {
                activation_id: plan.activation_id.clone(),
                thread_id: plan.thread_id.clone(),
                agent_id: plan.agent_id.clone(),
                context_id: plan.context_id.clone(),
                session_id: plan.session_id.clone(),
                initiating_principal_id: plan.initiating_principal_id.clone(),
                target_id: destination.id,
                tool_call_id: effect_tool_call_id.to_string(),
                tool_name: tool_name.clone(),
                request,
                retry_safety: tool.retry_safety(),
                requires_approval: requirement.is_some(),
            }
            .into_new_job();
        }
        let effective_target_id = if invocation.explicit_target {
            invocation.target_id.clone()
        } else {
            thread
                .target_id
                .clone()
                .unwrap_or_else(|| crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string())
        };
        if let Some(bound_target_id) = thread.target_id.as_deref() {
            if bound_target_id != effective_target_id {
                return Err(format!(
                    "Thread '{}' 已绑定 Execution Target '{}'，Yao Plan 不能切换为 '{}'",
                    thread.id, bound_target_id, effective_target_id
                )
                .into());
            }
        } else {
            match session_store
                .bind_thread_target(&thread.id, thread.revision, &effective_target_id)
                .await?
            {
                ThreadMutation::Updated(_) => {}
                ThreadMutation::Conflict { current }
                    if current.target_id.as_deref() == Some(effective_target_id.as_str()) => {}
                ThreadMutation::Conflict { current } => {
                    return Err(format!(
                        "Thread '{}' 的 Execution Target 并发绑定冲突：当前为 '{}'，请求为 '{}'",
                        current.id,
                        current.target_id.as_deref().unwrap_or("unbound"),
                        effective_target_id
                    )
                    .into())
                }
                ThreadMutation::NotFound => {
                    return Err(
                        format!("Yao Plan Thread '{}' 在绑定 Target 时消失", thread.id).into(),
                    )
                }
            }
        }
        let target = self
            .execution_targets
            .as_ref()
            .ok_or("Yao Plan Physical Execution 缺少 ExecutionTargetDispatcher")?
            .validate_for_tool(
                &effective_target_id,
                tool.name(),
                &invocation.tool_arguments,
                plan.initiating_principal_id.as_deref(),
                &plan.agent_id,
                &plan.context_id,
                &plan.thread_id,
            )
            .await?;
        let mut request = serde_json::from_str(&invocation.tool_arguments).unwrap_or_else(|_| {
            json!({
                "raw_arguments": invocation.tool_arguments,
            })
        });
        crate::execution_target::attach_route_snapshot(
            &mut request,
            &crate::execution_target::ExecutionRouteSnapshot::freeze(&target),
        )?;
        attach_execution_join_route(&mut request, None, false)?;
        let requirement = if target.kind == crate::memory::ExecutionTargetKind::InProcessLocal {
            tool.approval_requirement(&invocation.tool_arguments)?
        } else if self
            .durable_approvals
            .as_ref()
            .is_some_and(|services| services.broker.profile().full_access())
        {
            None
        } else {
            Some(crate::execution_target::remote_target_approval_requirement(
                &target,
                tool.name(),
                &invocation.tool_arguments,
            )?)
        };
        ExecutionJobSpec {
            activation_id: plan.activation_id.clone(),
            thread_id: plan.thread_id.clone(),
            agent_id: plan.agent_id.clone(),
            context_id: plan.context_id.clone(),
            session_id: plan.session_id.clone(),
            initiating_principal_id: plan.initiating_principal_id.clone(),
            target_id: effective_target_id,
            tool_call_id: effect_tool_call_id.to_string(),
            tool_name: tool_name.clone(),
            request,
            retry_safety: tool.retry_safety(),
            requires_approval: requirement.is_some(),
        }
        .into_new_job()
    }

    async fn suspend_activation_admission(
        &self,
        activation_id: &str,
    ) -> PlanExecutionResult<PlanAdmissionSuspension> {
        let slot = self
            .activation_admission_slots
            .get(activation_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or("PlanExecution 等待子任务时缺少 admission permit holder")?;
        slot.suspend_for_plan().await?;
        Ok(PlanAdmissionSuspension {
            slot,
            released: false,
        })
    }

    async fn execute_durable_plan(
        &self,
        route: PlanExecutionRoute,
        program: crate::sexpr_eval::Program,
    ) -> PlanExecutionResult<serde_json::Value> {
        let store = self
            .plan_store
            .as_ref()
            .ok_or("Runtime 没有配置 PlanExecution Store")?;
        let coordinator =
            PlanExecutionCoordinator::new(Arc::clone(store), Arc::clone(&self.registry));
        let planner = OrchestratorPlanCallPlanner {
            orchestrator: self
                .self_ref
                .get()
                .cloned()
                .ok_or("Orchestrator 尚未启动，不能执行持久化 Plan")?,
        };
        let ordinary_evaluation_id = if route.objective_evaluation_id.is_none() {
            self.context_engine
                .session_store()
                .ok_or("Yao Plan 需要持久化 ThreadStore")?
                .get_thread_activation(&route.activation_id)
                .await?
                .map(|activation| activation.root_turn_id)
        } else {
            None
        };
        let direct_evaluation_id = route
            .objective_evaluation_id
            .as_deref()
            .or(ordinary_evaluation_id.as_deref())
            .unwrap_or(route.activation_id.as_str());
        let binding = load_evaluation_harness_binding(self.store.as_ref(), direct_evaluation_id)
            .await?
            .or(match route.objective_id.as_deref() {
                Some(objective_id) => {
                    load_objective_harness_binding(
                        self.store.as_ref(),
                        &route.context_id,
                        objective_id,
                    )
                    .await?
                }
                None => None,
            });
        let artifact_binding = if let Some(binding) = binding {
            let harness = self
                .harness_registry
                .get(&binding.harness_id, &binding.harness_version)
                .ok_or_else(|| {
                    format!(
                        "Plan 绑定的 Harness '{}@{}' 未加载",
                        binding.harness_id, binding.harness_version
                    )
                })?;
            if harness.artifact_hash().as_deref() != Some(binding.artifact_hash.as_str()) {
                return Err("Plan Harness binding hash 与 Registry 不一致".into());
            }
            PlanArtifactBinding {
                harness_id: Some(binding.harness_id),
                harness_version: Some(binding.harness_version),
                source_artifact_hash: Some(binding.artifact_hash),
            }
        } else {
            PlanArtifactBinding::default()
        };
        let mut plan = coordinator
            .ensure(route.clone(), &program, artifact_binding)
            .await?;
        let worker_id = format!("plan-runner-{}", self.runtime_claimant_id);
        let mut suspended_admission = None;

        loop {
            if plan.status == PlanExecutionStatus::Waiting {
                if suspended_admission.is_none() {
                    suspended_admission = Some(
                        self.suspend_activation_admission(&route.activation_id)
                            .await?,
                    );
                }
            } else if let Some(suspended) = suspended_admission.take() {
                suspended.release().await?;
            }
            match plan.status {
                PlanExecutionStatus::Succeeded => {
                    return Ok(plan.result_json.unwrap_or(serde_json::Value::Null));
                }
                PlanExecutionStatus::Failed | PlanExecutionStatus::Cancelled => {
                    return Err(plan
                        .error
                        .unwrap_or_else(|| {
                            format!("PlanExecution '{}' 已 {}", plan.id, plan.status.as_str())
                        })
                        .into());
                }
                PlanExecutionStatus::Queued => {
                    let claim_token = format!(
                        "plan_claim_{}_{}_{}",
                        plan.id,
                        self.runtime_claimant_id,
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    );
                    let receipt = coordinator
                        .drive_once(
                            &plan.id,
                            plan.revision,
                            &worker_id,
                            &claim_token,
                            Utc::now() + chrono::Duration::seconds(60),
                            &planner,
                        )
                        .await?;
                    plan = match receipt {
                        PlanDriveReceipt::WaitingForEvaluation {
                            plan,
                            request_event,
                            ..
                        } => {
                            // The Store committed the infer Event, child Thread, and
                            // pending Signal atomically with this Plan suspension.
                            // Release the parent's physical Activation slot before
                            // waking the child, and bypass the EventBus permit held
                            // by this still-live parent handler. Both capacities can
                            // otherwise deadlock when their configured limit is one.
                            if suspended_admission.is_none() {
                                suspended_admission = Some(
                                    self.suspend_activation_admission(&route.activation_id)
                                        .await?,
                                );
                            }
                            // Wake the ordinary chat router with that already-durable
                            // Event so it can claim the Signal and materialize the
                            // child Activation. A restart remains the crash-window
                            // fallback through recover_pending_thread_signals().
                            self.bus
                                .dispatch_persisted_child_handoff(*request_event)
                                .await?;
                            plan
                        }
                        PlanDriveReceipt::WaitingForExecutionJob { plan, .. }
                        | PlanDriveReceipt::Succeeded { plan, .. }
                        | PlanDriveReceipt::Failed { plan, .. } => plan,
                        PlanDriveReceipt::Conflict {
                            current: Some(current),
                            ..
                        } => current,
                        PlanDriveReceipt::Conflict {
                            current: None,
                            reason,
                        } => return Err(reason.into()),
                    };
                }
                PlanExecutionStatus::Running => {
                    if plan
                        .lease_expires_at
                        .is_some_and(|expires_at| expires_at <= Utc::now())
                    {
                        // An expired deterministic step is safe to reclaim:
                        // no physical or model side effect happens before the
                        // atomic suspension boundary.
                        let claim_token = format!(
                            "plan_reclaim_{}_{}_{}",
                            plan.id,
                            self.runtime_claimant_id,
                            Utc::now().timestamp_nanos_opt().unwrap_or(0)
                        );
                        let receipt = coordinator
                            .drive_once(
                                &plan.id,
                                plan.revision,
                                &worker_id,
                                &claim_token,
                                Utc::now() + chrono::Duration::seconds(60),
                                &planner,
                            )
                            .await?;
                        plan = match receipt {
                            PlanDriveReceipt::WaitingForEvaluation {
                                plan,
                                request_event,
                                ..
                            } => {
                                // A reclaimed deterministic step can cross the
                                // same durable infer hand-off as an ordinary queued
                                // step, so it owns the identical dispatch boundary.
                                if suspended_admission.is_none() {
                                    suspended_admission = Some(
                                        self.suspend_activation_admission(&route.activation_id)
                                            .await?,
                                    );
                                }
                                self.bus
                                    .dispatch_persisted_child_handoff(*request_event)
                                    .await?;
                                plan
                            }
                            PlanDriveReceipt::WaitingForExecutionJob { plan, .. }
                            | PlanDriveReceipt::Succeeded { plan, .. }
                            | PlanDriveReceipt::Failed { plan, .. } => plan,
                            PlanDriveReceipt::Conflict {
                                current: Some(current),
                                ..
                            } => current,
                            PlanDriveReceipt::Conflict {
                                current: None,
                                reason,
                            } => return Err(reason.into()),
                        };
                    } else {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        plan = store
                            .get_plan_execution(&plan.id)
                            .await?
                            .ok_or("PlanExecution 在运行中消失")?;
                    }
                }
                PlanExecutionStatus::Waiting => match plan.pending_kind {
                    Some(PlanExecutionWaitKind::ExecutionJob) => {
                        let job_id = plan
                            .pending_id
                            .clone()
                            .ok_or("waiting(execution_job) 缺少 pending_id")?;
                        let job = store
                            .get_execution_job(&job_id)
                            .await?
                            .ok_or_else(|| format!("Execution Job '{job_id}' 不存在"))?;
                        if job.status.is_terminal() {
                            plan = plan_from_resume(
                                coordinator
                                    .reconcile_execution_job(&plan.id, &job.id)
                                    .await?,
                            )?;
                            continue;
                        }
                        if matches!(
                            job.status,
                            ExecutionJobStatus::Queued | ExecutionJobStatus::WaitingApproval
                        ) {
                            self.execute_plan_call(&route, &plan).await?;
                        } else {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        plan = store
                            .get_plan_execution(&plan.id)
                            .await?
                            .ok_or("PlanExecution 在等待 Job 时消失")?;
                    }
                    Some(PlanExecutionWaitKind::Evaluation) => {
                        let activation_id = plan
                            .pending_id
                            .clone()
                            .ok_or("waiting(evaluation) 缺少 pending_id")?;
                        match store.get_thread_activation(&activation_id).await? {
                            Some(activation)
                                if activation.status == ThreadActivationStatus::Succeeded =>
                            {
                                let child_thread =
                                    store.get_thread_by_root(&activation.root_turn_id).await?;
                                if child_thread.as_ref().is_some_and(|thread| {
                                    thread.lifecycle == ThreadLifecycle::Open
                                        && thread.result_event_id.is_none()
                                }) {
                                    // Tool-using infer evaluations cross one
                                    // Activation boundary per assistant/tool
                                    // step.  The initial Activation succeeding
                                    // is only a hand-off; wait for the Thread's
                                    // durable result Event.
                                    tokio::time::sleep(Duration::from_millis(100)).await;
                                    plan = store
                                        .get_plan_execution(&plan.id)
                                        .await?
                                        .ok_or("PlanExecution 在等待 Evaluation Thread 时消失")?;
                                    continue;
                                }
                                plan = plan_from_resume(
                                    coordinator
                                        .reconcile_evaluation(&plan.id, &activation.id)
                                        .await?,
                                )?;
                            }
                            Some(activation) if activation.status.is_terminal() => {
                                plan = plan_from_resume(
                                    coordinator
                                        .reconcile_evaluation(&plan.id, &activation.id)
                                        .await?,
                                )?;
                            }
                            Some(_) => {
                                // The infer request, its Signal Outbox row and
                                // the Plan wait are one transaction.  The child
                                // Activation is deliberately materialized by
                                // the asynchronous Scheduler router afterwards,
                                // so a short-lived non-terminal row is expected.
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                plan = store
                                    .get_plan_execution(&plan.id)
                                    .await?
                                    .ok_or("PlanExecution 在等待 Evaluation 时消失")?;
                            }
                            None => {
                                // The Event, child Thread and pending Signal
                                // were committed with the Plan wait. A missing
                                // child Activation means the live router has
                                // not completed that durable handoff. Re-read
                                // and redispatch the exact Event instead of
                                // polling the absent row forever.
                                if Utc::now().signed_duration_since(plan.updated_at)
                                    >= chrono::Duration::seconds(60)
                                {
                                    let reason = format!(
                                        "PlanExecution '{}' 的 infer Signal 在 60 秒内未物化 child Activation",
                                        plan.id
                                    );
                                    plan = match store
                                        .cancel_plan_execution(
                                            &plan.id,
                                            plan.revision,
                                            Some(&reason),
                                        )
                                        .await?
                                    {
                                        PlanExecutionMutation::Updated(current)
                                        | PlanExecutionMutation::Existing(current)
                                        | PlanExecutionMutation::Conflict { current }
                                        | PlanExecutionMutation::Rejected {
                                            current: Some(current),
                                            ..
                                        } => current,
                                        PlanExecutionMutation::Rejected {
                                            current: None,
                                            reason,
                                        } => return Err(reason.into()),
                                        PlanExecutionMutation::NotFound => {
                                            return Err(format!(
                                                "PlanExecution '{}' 在 handoff 超时收口时消失",
                                                plan.id
                                            )
                                            .into())
                                        }
                                    };
                                    continue;
                                }
                                let expected = pending_infer_request_event(&plan)?;
                                let request_event = store
                                    .query(QueryFilter {
                                        event_id: Some(expected.id.clone()),
                                        context_id: Some(plan.context_id.clone()),
                                        ..Default::default()
                                    })
                                    .await?
                                    .into_iter()
                                    .find(|candidate| candidate.id == expected.id)
                                    .ok_or_else(|| {
                                        format!(
                                            "PlanExecution '{}' 的 infer Event '{}' 不存在",
                                            plan.id, expected.id
                                        )
                                    })?;
                                self.bus
                                    .dispatch_persisted_child_handoff(request_event)
                                    .await?;
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                plan = store
                                    .get_plan_execution(&plan.id)
                                    .await?
                                    .ok_or("PlanExecution 在恢复 Evaluation handoff 时消失")?;
                            }
                        }
                    }
                    Some(PlanExecutionWaitKind::ActionGroup) => {
                        return Err("Yao Plan v1 尚未产生 Action Group wait".into());
                    }
                    None => return Err("PlanExecution waiting 状态缺少 pending_kind".into()),
                },
            }
        }
    }

    async fn execute_plan_call(
        &self,
        route: &PlanExecutionRoute,
        plan: &PlanExecutionRecord,
    ) -> PlanExecutionResult<()> {
        let machine: crate::sexpr_eval::PlanMachine =
            serde_json::from_value(plan.state_json.clone())?;
        let effect = machine
            .pending_effect()
            .cloned()
            .ok_or("PlanExecution 等待 Job 但 machine 没有 pending effect")?;
        let crate::sexpr_eval::PlanEffect::Call {
            sequence,
            tool,
            arguments,
        } = effect
        else {
            return Err("PlanExecution 等待 Job，但 pending effect 不是 call".into());
        };
        let call_id = crate::plan_execution::deterministic_plan_effect_id(&plan.id, sequence)?;
        let response = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: call_id,
                r#type: "function".to_string(),
                func_name: tool.clone(),
                arguments: serde_json::to_string(&arguments)?,
            }],
        };
        self.execute_tool_calls(
            &route.session_id,
            &route.activation_id,
            response,
            "plan-execution",
            ToolExecutionOptions {
                context_tx_allowed: false,
                wake_on_output: false,
                plan_execution_id: Some(plan.id.clone()),
                continuation_tool_calls: None,
                allowed_tool_names: HashSet::from([tool]),
                record_assistant_call: false,
                model_attempt_id: None,
                provider_continuation: None,
            },
        )
        .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn prepare_physical_execution(
        &self,
        tool: &Arc<dyn Tool>,
        route: &ActivationRoute,
        agent_id: &str,
        thread_id: &str,
        context_id: &str,
        session_id: &str,
        attempt_id: &str,
        call: &crate::llm::ToolCallRepr,
        output_id: &str,
        timeout_secs: u64,
        action_group_id: Option<&str>,
        standalone_signal: bool,
    ) -> Result<PreparedPhysicalExecution, DynError> {
        let manager = self
            .execution_jobs
            .as_ref()
            .ok_or("Physical Execution 缺少 ExecutionJobManager")?;
        let invocation = match crate::execution_target::split_target_argument(&call.arguments) {
            Ok(invocation) => invocation,
            Err(error) => {
                let mut output = physical_execution_preflight_rejected_tool_output(
                    output_id,
                    context_id,
                    session_id,
                    attempt_id,
                    call,
                    route,
                    action_group_id,
                    error.as_ref(),
                );
                self.stamp_objective_activation_route(attempt_id, &mut output.payload);
                return Ok(PreparedPhysicalExecution::Rejected(output));
            }
        };
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Physical Execution 需要持久化 ThreadStore")?;
        let thread = session_store
            .get_thread(thread_id)
            .await?
            .ok_or_else(|| format!("Physical Execution Thread '{thread_id}' 不存在"))?;
        let deterministic_job_id =
            crate::execution::deterministic_job_id(&route.activation_id, &call.id)?;
        let artifact_transfer =
            if tool.execution_routing() == crate::tool::ToolExecutionRouting::ArtifactTransfer {
                match crate::artifact::transfer_request_from_tool_arguments(
                    &invocation.tool_arguments,
                    format!("transfer:{deterministic_job_id}"),
                ) {
                    Ok(request) => Some(request),
                    Err(error) => {
                        let mut output = physical_execution_preflight_rejected_tool_output(
                            output_id,
                            context_id,
                            session_id,
                            attempt_id,
                            call,
                            route,
                            action_group_id,
                            error.as_ref(),
                        );
                        self.stamp_objective_activation_route(attempt_id, &mut output.payload);
                        return Ok(PreparedPhysicalExecution::Rejected(output));
                    }
                }
            } else {
                None
            };
        let effective_target_id = if let Some(transfer) = artifact_transfer.as_ref() {
            transfer.destination.target_id.clone()
        } else if invocation.explicit_target {
            invocation.target_id.clone()
        } else {
            thread
                .target_id
                .clone()
                .unwrap_or_else(|| crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.to_string())
        };
        if artifact_transfer.is_none() {
            if let Err(error) = crate::execution_target::reject_unmanaged_ssh_invocation(
                &effective_target_id,
                tool.name(),
                &invocation.tool_arguments,
            ) {
                let mut output = physical_execution_preflight_rejected_tool_output(
                    output_id,
                    context_id,
                    session_id,
                    attempt_id,
                    call,
                    route,
                    action_group_id,
                    error.as_ref(),
                );
                output
                    .payload
                    .insert("target_id".to_string(), json!(effective_target_id));
                self.stamp_objective_activation_route(attempt_id, &mut output.payload);
                return Ok(PreparedPhysicalExecution::Rejected(output));
            }
            if let Some(bound_target_id) = thread.target_id.as_deref() {
                if bound_target_id != effective_target_id {
                    let reason = format!(
                        "Thread '{}' 已绑定 Execution Target '{}'，不能隐式切换为 '{}'；请用 schedule_tx.spawn 创建绑定新 Target 的 Execution Thread",
                        thread.id, bound_target_id, effective_target_id
                    );
                    let rejection = std::io::Error::other(reason);
                    let mut output = physical_execution_preflight_rejected_tool_output(
                        output_id,
                        context_id,
                        session_id,
                        attempt_id,
                        call,
                        route,
                        action_group_id,
                        &rejection,
                    );
                    output
                        .payload
                        .insert("target_id".to_string(), json!(effective_target_id));
                    output
                        .payload
                        .insert("bound_target_id".to_string(), json!(bound_target_id));
                    self.stamp_objective_activation_route(attempt_id, &mut output.payload);
                    return Ok(PreparedPhysicalExecution::Rejected(output));
                }
            } else {
                match session_store
                    .bind_thread_target(&thread.id, thread.revision, &effective_target_id)
                    .await?
                {
                    ThreadMutation::Updated(_) => {}
                    ThreadMutation::Conflict { current }
                        if current.target_id.as_deref() == Some(effective_target_id.as_str()) => {}
                    ThreadMutation::Conflict { current } => {
                        let reason = format!(
                            "Thread '{}' 的 Execution Target 并发绑定冲突：当前为 '{}'，请求为 '{}'；请依据最新 Thread 状态重新调度",
                            current.id,
                            current.target_id.as_deref().unwrap_or("unbound"),
                            effective_target_id
                        );
                        let rejection = std::io::Error::other(reason);
                        let mut output = physical_execution_preflight_rejected_tool_output(
                            output_id,
                            context_id,
                            session_id,
                            attempt_id,
                            call,
                            route,
                            action_group_id,
                            &rejection,
                        );
                        output
                            .payload
                            .insert("target_id".to_string(), json!(effective_target_id));
                        output
                            .payload
                            .insert("bound_target_id".to_string(), json!(current.target_id));
                        self.stamp_objective_activation_route(attempt_id, &mut output.payload);
                        return Ok(PreparedPhysicalExecution::Rejected(output));
                    }
                    ThreadMutation::NotFound => {
                        return Err(format!(
                            "Physical Execution Thread '{}' 在绑定 Target 时消失",
                            thread.id
                        )
                        .into());
                    }
                }
            }
        }
        if let Some(existing) = manager
            .store()
            .get_execution_job(&deterministic_job_id)
            .await?
        {
            if let Some(event) = self.terminal_execution_event(&existing).await? {
                return Ok(PreparedPhysicalExecution::Terminal(event));
            }
        }
        let dispatcher = self
            .execution_targets
            .as_ref()
            .ok_or("Physical Execution 缺少 ExecutionTargetDispatcher")?;
        let validated_targets = if let Some(transfer) = artifact_transfer.as_ref() {
            dispatcher
                .validate_artifact_transfer(
                    transfer,
                    &invocation.tool_arguments,
                    route.initiating_principal_id.as_deref(),
                    agent_id,
                    context_id,
                    thread_id,
                )
                .await
                .map(|(source, destination)| (destination, Some(source)))
        } else {
            dispatcher
                .validate_for_tool(
                    &effective_target_id,
                    tool.name(),
                    &invocation.tool_arguments,
                    route.initiating_principal_id.as_deref(),
                    agent_id,
                    context_id,
                    thread_id,
                )
                .await
                .map(|target| (target, None))
        };
        let (target, source_target) = match validated_targets {
            Ok(targets) => targets,
            Err(error) => {
                let mut output = physical_execution_preflight_rejected_tool_output(
                    output_id,
                    context_id,
                    session_id,
                    attempt_id,
                    call,
                    route,
                    action_group_id,
                    error.as_ref(),
                );
                output
                    .payload
                    .insert("target_id".to_string(), json!(effective_target_id));
                self.stamp_objective_activation_route(attempt_id, &mut output.payload);
                return Ok(PreparedPhysicalExecution::Rejected(output));
            }
        };
        let mut request = serde_json::from_str(&invocation.tool_arguments).unwrap_or_else(|_| {
            json!({
                "raw_arguments": invocation.tool_arguments,
            })
        });
        if let (Some(transfer), Some(source)) = (artifact_transfer.as_ref(), source_target.as_ref())
        {
            debug_assert_eq!(transfer.destination.target_id, target.id);
            crate::execution_target::attach_artifact_transfer_routes(
                &mut request,
                &crate::execution_target::ArtifactTransferRouteSnapshot {
                    source: crate::execution_target::ExecutionRouteSnapshot::freeze(source),
                    destination: crate::execution_target::ExecutionRouteSnapshot::freeze(&target),
                },
            )?;
        } else {
            crate::execution_target::attach_route_snapshot(
                &mut request,
                &crate::execution_target::ExecutionRouteSnapshot::freeze(&target),
            )?;
        }
        attach_execution_join_route(&mut request, action_group_id, standalone_signal)?;
        let full_access = self
            .durable_approvals
            .as_ref()
            .is_some_and(|services| services.broker.profile().full_access());
        let requirement_result = if full_access {
            Ok(None)
        } else if let (Some(transfer), Some(source)) =
            (artifact_transfer.as_ref(), source_target.as_ref())
        {
            let local = if source.kind == crate::memory::ExecutionTargetKind::InProcessLocal
                || target.kind == crate::memory::ExecutionTargetKind::InProcessLocal
            {
                tool.approval_requirement(&invocation.tool_arguments)?
            } else {
                None
            };
            let remote = crate::execution_target::remote_artifact_transfer_approval_requirement(
                source, &target, transfer,
            )?;
            Ok(merge_artifact_transfer_requirements(local, remote))
        } else if target.kind == crate::memory::ExecutionTargetKind::InProcessLocal {
            tool.approval_requirement(&invocation.tool_arguments)
        } else {
            crate::execution_target::remote_target_approval_requirement(
                &target,
                tool.name(),
                &invocation.tool_arguments,
            )
            .map(Some)
        };
        let mut requirement = match requirement_result {
            Ok(requirement) => requirement,
            Err(error) => {
                let mut output = physical_execution_preflight_rejected_tool_output(
                    output_id,
                    context_id,
                    session_id,
                    attempt_id,
                    call,
                    route,
                    action_group_id,
                    error.as_ref(),
                );
                self.stamp_objective_activation_route(attempt_id, &mut output.payload);
                return Ok(PreparedPhysicalExecution::Rejected(output));
            }
        };
        let mut lease_grant = None;
        if artifact_transfer.is_none() {
            if let (Some(current_requirement), Some(services), Some(principal_id)) = (
                requirement.as_ref(),
                self.durable_approvals.as_ref(),
                route.initiating_principal_id.as_ref(),
            ) {
                lease_grant = covering_capability_lease_grant(
                    services,
                    current_requirement,
                    principal_id,
                    agent_id,
                    &thread,
                    &target,
                )
                .await?;
            }
        }
        if lease_grant.is_some() {
            requirement = None;
        }
        let spec = ExecutionJobSpec {
            activation_id: route.activation_id.clone(),
            thread_id: thread_id.to_string(),
            agent_id: agent_id.to_string(),
            context_id: context_id.to_string(),
            session_id: session_id.to_string(),
            initiating_principal_id: route.initiating_principal_id.clone(),
            target_id: effective_target_id,
            tool_call_id: call.id.clone(),
            tool_name: call.func_name.clone(),
            request,
            retry_safety: tool.retry_safety(),
            requires_approval: requirement.is_some(),
        };
        let lease_expires_at = Utc::now()
            + chrono::Duration::seconds(
                i64::try_from(timeout_secs.saturating_add(60)).unwrap_or(i64::MAX),
            );
        let claim_token = format!(
            "claim_{}_{}_{}",
            crate::execution::deterministic_job_id(&route.activation_id, &call.id)?,
            self.runtime_claimant_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );

        let (mut job, durable_grant) = match requirement {
            None => {
                let job = manager.ensure(spec).await?;
                if let Some(event) = self.terminal_execution_event(&job).await? {
                    return Ok(PreparedPhysicalExecution::Terminal(event));
                }
                if job.status != ExecutionJobStatus::Queued {
                    return Err(format!(
                        "Execution Job '{}' 当前为 {}，不能重复开始物理执行",
                        job.id,
                        job.status.as_str()
                    )
                    .into());
                }
                let job = applied_execution_job(
                    manager
                        .claim(
                            &job.id,
                            job.revision,
                            JobClaim {
                                worker_id: &self.runtime_claimant_id,
                                claim_token: &claim_token,
                                lease_expires_at,
                                approval_ref: None,
                            },
                        )
                        .await?,
                    "claim",
                )?;
                (job, lease_grant)
            }
            Some(requirement) => {
                let services = self.durable_approvals.as_ref().ok_or(
                    "Physical Execution 需要审批，但 Runtime 未配置持久化 Approval authority",
                )?;
                let new_job = spec.into_new_job()?;
                let action = serde_json::to_value(&requirement.action)?;
                let requested = serde_json::to_value(&requirement.requested)?;
                let lease_policy_digest = capability_lease_policy_digest(
                    &services.broker.policy_digest(),
                    &target.policy_digest,
                );
                let mut lease_offer = route
                    .initiating_principal_id
                    .as_ref()
                    .filter(|_| {
                        artifact_transfer.is_none()
                            && services.capability_leases_enabled
                            && services.capability_lease_ttl_secs > 0
                            && thread.lifecycle == ThreadLifecycle::Open
                    })
                    .map(|principal_id| CapabilityLeaseOffer {
                        principal_id: principal_id.clone(),
                        agent_id: agent_id.to_string(),
                        thread_id: thread.id.clone(),
                        target_id: new_job.target_id.clone(),
                        capability: requirement.action.lease_capability(),
                        requested: requirement.requested.clone(),
                        policy_digest: lease_policy_digest.clone(),
                        expires_at: Utc::now()
                            + chrono::Duration::seconds(
                                i64::try_from(services.capability_lease_ttl_secs)
                                    .unwrap_or(i64::MAX),
                            ),
                    });
                let identity = stable_approval_identity(
                    &new_job.id,
                    &action,
                    &requested,
                    &services.broker.policy_digest(),
                )?;
                let new_approval = NewApprovalRequest {
                    id: identity.approval_id.clone(),
                    job_id: new_job.id.clone(),
                    request_digest: identity.request_digest.clone(),
                    policy_digest: identity.policy_digest.clone(),
                    action: action.clone(),
                    requested: requested.clone(),
                    justification: requirement.justification.clone(),
                    pending_status: services.broker.pending_approval_status(),
                };
                let request_event =
                    approval_request_event(&new_job, &new_approval, attempt_id, route);
                let (job, mut approval, created) = execution_approval_records(
                    services
                        .execution_approvals
                        .ensure_execution_job_with_approval(new_job, new_approval, &request_event)
                        .await?,
                    "create approval authority",
                )?;
                if let Some(offer) = lease_offer.as_mut() {
                    offer.expires_at = approval.created_at
                        + chrono::Duration::seconds(
                            i64::try_from(services.capability_lease_ttl_secs).unwrap_or(i64::MAX),
                        );
                }
                // A persisted request is an immutable fact, but UI delivery is
                // process-local. Re-dispatch an exact still-pending replay so
                // restart never leaves a human Approval invisible merely
                // because its Event was already persisted.
                if created || approval.status.is_pending() {
                    self.bus.dispatch_persisted(request_event).await?;
                }
                if let Some(event) = self.terminal_execution_event(&job).await? {
                    return Ok(PreparedPhysicalExecution::Terminal(event));
                }

                if approval.status.is_pending() {
                    let decision = services
                        .broker
                        .review(&ApprovalRequest {
                            approval_id: approval.id.clone(),
                            context_id: context_id.to_string(),
                            session_id: session_id.to_string(),
                            attempt_id: attempt_id.to_string(),
                            thread_id: route.thread_id.clone(),
                            root_turn_id: route.root_turn_id.clone(),
                            trigger_event_id: route.trigger_event_id.clone(),
                            trigger_sequence: route.trigger_sequence,
                            action: requirement.action.clone(),
                            requested: requirement.requested.clone(),
                            justification: requirement.justification.clone(),
                            lease_offer: lease_offer.clone(),
                        })
                        .await?;
                    let resolution = match decision {
                        ApprovalDecision::AllowOnce {
                            rationale,
                            risk_tags,
                        } => ApprovalResolution::Allow {
                            rationale,
                            risk_tags,
                        },
                        ApprovalDecision::AllowLease {
                            rationale,
                            mut risk_tags,
                        } => {
                            if lease_offer.is_none() {
                                return Err(
                                    "Approval provider 在没有 lease_offer 时批准 Capability Lease"
                                        .into(),
                                );
                            }
                            if !capability_lease_was_approved(&risk_tags) {
                                risk_tags.push(CAPABILITY_LEASE_APPROVED_RISK_TAG.to_string());
                            }
                            ApprovalResolution::Allow {
                                rationale,
                                risk_tags,
                            }
                        }
                        ApprovalDecision::Deny {
                            rationale,
                            risk_tags,
                        } => ApprovalResolution::Deny {
                            rationale,
                            risk_tags,
                        },
                        ApprovalDecision::AskHuman { rationale, .. } => {
                            return Err(format!(
                                "Approval provider 返回 ask_human 但未完成人工审批: {rationale}"
                            )
                            .into());
                        }
                    };
                    let commit = services
                        .approvals
                        .commit_approval_decision(&approval.id, approval.revision, resolution)
                        .await?;
                    let (updated, _changed) = approval_record_from_mutation(
                        commit.mutation,
                        "persist approval decision",
                    )?;
                    approval = updated;
                    if commit.event_created {
                        let decision_event = commit
                            .event
                            .ok_or("Approval 审计 Event 已原子创建，但 Store 未返回持久化投影")?;
                        self.bus.dispatch_persisted(decision_event).await?;
                    }
                }

                if approval.status == ApprovalStatus::Allowed
                    && capability_lease_was_approved(&approval.risk_tags)
                {
                    let offer = lease_offer.as_ref().ok_or(
                        "Allowed Approval 标记为 Capability Lease，但当前请求缺少 lease_offer",
                    )?;
                    let lease = NewCapabilityLease {
                        id: stable_capability_lease_id(&approval.id),
                        principal_id: offer.principal_id.clone(),
                        agent_id: offer.agent_id.clone(),
                        thread_id: offer.thread_id.clone(),
                        target_id: offer.target_id.clone(),
                        capabilities: vec![offer.capability.clone()],
                        requested: serde_json::to_value(&offer.requested)?,
                        policy_digest: offer.policy_digest.clone(),
                        issued_by_approval_id: Some(approval.id.clone()),
                        expires_at: offer.expires_at,
                    };
                    match services
                        .capability_leases
                        .ensure_capability_lease(lease)
                        .await?
                    {
                        CapabilityLeaseMutation::Created(_)
                        | CapabilityLeaseMutation::Existing(_) => {}
                        CapabilityLeaseMutation::Conflict { current } => {
                            return Err(format!(
                                "Capability Lease '{}' 幂等内容冲突（revision {}）",
                                current.id, current.revision
                            )
                            .into());
                        }
                        CapabilityLeaseMutation::Updated(_) => {
                            return Err("ensure_capability_lease 不应返回 Updated".into());
                        }
                        CapabilityLeaseMutation::NotFound => {
                            return Err("ensure_capability_lease 不应返回 NotFound".into());
                        }
                    }
                }

                match approval.status {
                    ApprovalStatus::Denied | ApprovalStatus::Cancelled => {
                        let mut output = approval_denied_tool_output(
                            output_id, context_id, session_id, attempt_id, call, route, &approval,
                        );
                        if let Some(group_id) = action_group_id {
                            output
                                .payload
                                .insert("action_group_id".to_string(), json!(group_id));
                        }
                        let reason = approval
                            .rationale
                            .clone()
                            .or(approval.cancel_reason.clone())
                            .unwrap_or_else(|| "审批未授权该物理操作".to_string());
                        applied_execution_job(
                            manager
                                .finish_with_event(
                                    &job.id,
                                    job.revision,
                                    None,
                                    JobOutcome::Cancelled {
                                        result_event_id: Some(output.id.clone()),
                                        result_refs: Vec::new(),
                                        reason: Some(reason),
                                        exit_code: None,
                                    },
                                    &output,
                                    standalone_signal,
                                )
                                .await?,
                            "approval denial terminal commit",
                        )?;
                        return Ok(PreparedPhysicalExecution::Terminal(output));
                    }
                    ApprovalStatus::Allowed => {}
                    ApprovalStatus::PendingAuto | ApprovalStatus::PendingHuman => {
                        return Err(format!(
                            "Approval '{}' 审批源返回后仍处于 {}",
                            approval.id,
                            approval.status.as_str()
                        )
                        .into());
                    }
                }

                let grant_id = approval
                    .grant_id
                    .clone()
                    .ok_or("Allowed Approval 缺少持久化 grant_id")?;
                let (job, consumed_approval, _) = execution_approval_records(
                    services
                        .execution_approvals
                        .claim_execution_job_with_grant(
                            &job.id,
                            job.revision,
                            &approval.id,
                            approval.revision,
                            &self.runtime_claimant_id,
                            &claim_token,
                            lease_expires_at,
                        )
                        .await?,
                    "consume approval grant and claim",
                )?;
                let grant = DurableApprovalGrant {
                    approval_id: consumed_approval.id,
                    grant_id,
                    policy_digest: consumed_approval.policy_digest,
                    action: serde_json::from_value(consumed_approval.action)?,
                    requested: serde_json::from_value(consumed_approval.requested)?,
                };
                (job, Some(grant))
            }
        };

        if let Some(supervisor) = &self.objective_supervisor {
            if !supervisor
                .activation_fence_is_current(&route.activation_id)
                .await?
            {
                let reason = format!(
                    "OBJECTIVE_EVALUATION_FENCED：Activation '{}' 的 Objective Evaluation 已被撤销或取代；Runtime 未开始该物理 Action",
                    route.activation_id
                );
                let _ = manager
                    .request_cancel(&job.id, job.revision, Some(&reason))
                    .await?;
                let mut payload = serde_json::Map::from_iter([
                    ("context_id".to_string(), json!(context_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("tool_call_id".to_string(), json!(call.id)),
                    ("caused_by".to_string(), json!(call.id)),
                    ("tool_name".to_string(), json!(call.func_name)),
                    ("tool_status".to_string(), json!("cancelled")),
                    (
                        "wake_policy".to_string(),
                        json!(if standalone_signal {
                            "immediate"
                        } else {
                            "none"
                        }),
                    ),
                    ("output_empty".to_string(), json!(false)),
                    ("text".to_string(), json!(reason)),
                ]);
                payload.insert("thread_id".to_string(), json!(route.thread_id));
                if let Some(principal_id) = &route.initiating_principal_id {
                    payload.insert("principal_id".to_string(), json!(principal_id));
                }
                payload.insert("activation_id".to_string(), json!(route.activation_id));
                payload.insert("root_turn_id".to_string(), json!(route.root_turn_id));
                payload.insert(
                    "trigger_event_id".to_string(),
                    json!(route.trigger_event_id),
                );
                payload.insert(
                    "trigger_sequence".to_string(),
                    json!(route.trigger_sequence),
                );
                if let Some(version) = route.context_snapshot_version {
                    payload.insert("context_snapshot_version".to_string(), json!(version));
                }
                if let Some(group_id) = action_group_id {
                    payload.insert("action_group_id".to_string(), json!(group_id));
                }
                stamp_execution_route_facts(
                    &mut payload,
                    &job.target_id,
                    &job.request,
                    job.claimed_by.as_deref(),
                );
                let mut output = Event::new(
                    output_id.to_string(),
                    "Runtime-ObjectiveFence".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    payload,
                );
                if let Some(active) = self
                    .objective_evaluations
                    .get_for_activation(&route.activation_id)
                {
                    output
                        .payload
                        .insert("objective_id".to_string(), json!(active.objective_id));
                    output.payload.insert(
                        "objective_evaluation_id".to_string(),
                        json!(active.evaluation_id),
                    );
                    output
                        .payload
                        .insert("objective_revision".to_string(), json!(active.revision));
                }
                let claimed = ClaimedExecutionJob {
                    id: job.id.clone(),
                    revision: job.revision,
                    claim_token: claim_token.clone(),
                    target_id: job.target_id.clone(),
                    record: job.clone(),
                };
                finish_claimed_physical_job(
                    manager.as_ref(),
                    &claimed,
                    &mut output,
                    standalone_signal,
                )
                .await?;
                return Ok(PreparedPhysicalExecution::Terminal(output));
            }
        }

        job = applied_execution_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token: &claim_token,
                        lease_expires_at,
                        side_effect_started_at: Some(Utc::now()),
                        progress_ref: None,
                    },
                )
                .await?,
            "side-effect boundary",
        )?;
        Ok(PreparedPhysicalExecution::Claimed(Box::new(
            ClaimedPhysicalExecution {
                context: crate::tool::ToolExecutionJobContext {
                    parent_job_id: job.id.clone(),
                    activation_id: route.activation_id.clone(),
                    thread_id: thread_id.to_string(),
                    agent_id: agent_id.to_string(),
                    context_id: context_id.to_string(),
                    session_id: session_id.to_string(),
                    initiating_principal_id: route.initiating_principal_id.clone(),
                    target_id: job.target_id.clone(),
                    tool_call_id: call.id.clone(),
                },
                job: ClaimedExecutionJob {
                    id: job.id.clone(),
                    revision: job.revision,
                    claim_token,
                    target_id: job.target_id.clone(),
                    record: job,
                },
                approval: durable_grant,
                arguments: invocation.tool_arguments,
            },
        )))
    }

    async fn terminal_execution_event(
        &self,
        job: &ExecutionJobRecord,
    ) -> Result<Option<Event>, DynError> {
        if !job.status.is_terminal() {
            return Ok(None);
        }
        let event_id = job
            .result_event_id
            .as_deref()
            .ok_or_else(|| format!("终态 Execution Job '{}' 缺少 result_event_id", job.id))?;
        let event = self
            .context_engine
            .find_event(&job.context_id, event_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "终态 Execution Job '{}' 引用的结果 Event '{}' 不存在",
                    job.id, event_id
                )
            })?;
        Ok(Some(event))
    }

    async fn execute_objective_create_prelude(
        &self,
        context_id: &str,
        session_id: &str,
        attempt_id: &str,
        call: &crate::llm::ToolCallRepr,
    ) -> Result<(Event, bool), DynError> {
        let output_id = format!("output_{}_{}", attempt_id, call.id);
        if let Some(existing) = self
            .context_engine
            .find_event(context_id, &output_id)
            .await?
        {
            return Ok((existing, true));
        }
        let activation_route = self.activation_route(attempt_id);
        let active_principal_id = self
            .principal_for_activation_route(context_id, activation_route.as_ref())
            .await?;
        let causal_route = activation_route
            .as_ref()
            .map(|route| crate::tool::ToolCausalRoute {
                thread_id: route.thread_id.clone(),
                activation_id: route.activation_id.clone(),
                root_turn_id: route.root_turn_id.clone(),
                trigger_event_id: route.trigger_event_id.clone(),
                trigger_sequence: route.trigger_sequence,
            });
        let tool = self.registry.get(&call.func_name);
        let arguments = call.arguments.clone();
        let context = context_id.to_string();
        let session = session_id.to_string();
        let attempt = attempt_id.to_string();
        let result = crate::tool::CURRENT_PRINCIPAL_ID
            .scope(active_principal_id, async {
                crate::tool::CURRENT_CAUSAL_ROUTE
                    .scope(causal_route, async {
                        crate::tool::CURRENT_ATTEMPT_ID
                            .scope(attempt, async {
                                crate::tool::CURRENT_CONTEXT_ID
                                    .scope(context, async {
                                        crate::tool::CURRENT_SESSION_ID
                                            .scope(session, async {
                                                tokio::time::timeout(
                                                    tokio::time::Duration::from_secs(
                                                        self.orchestrator_config.tool_timeout_secs,
                                                    ),
                                                    async {
                                                        match tool {
                                                            Some(tool) => {
                                                                tool.execute(&arguments).await
                                                            }
                                                            None => Err(format!(
                                                                "未注册的工具: {}",
                                                                call.func_name
                                                            )
                                                            .into()),
                                                        }
                                                    },
                                                )
                                                .await
                                            })
                                            .await
                                    })
                                    .await
                            })
                            .await
                    })
                    .await
            })
            .await;
        let (text, status) = match result {
            Ok(Ok(text)) => {
                let status = infer_tool_status(&text);
                (text, status)
            }
            Ok(Err(error)) => (format!("执行失败: {error}"), "error"),
            Err(_) => (
                format!(
                    "执行超时: 超过 {} 秒限额",
                    self.orchestrator_config.tool_timeout_secs
                ),
                "timeout",
            ),
        };
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("tool_call_id".to_string(), json!(call.id)),
            ("caused_by".to_string(), json!(call.id)),
            ("tool_name".to_string(), json!(call.func_name)),
            ("tool_status".to_string(), json!(status)),
            ("wake_policy".to_string(), json!("immediate")),
            ("output_empty".to_string(), json!(text.trim().is_empty())),
            ("text".to_string(), json!(text)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        let mut output = Event::new(
            output_id,
            "System-ObjectiveControl".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            payload.into_iter().collect(),
        );
        // The prelude creates/adopts the Objective before any sibling Action
        // is admitted. Route enrichment therefore happens before the immutable
        // result Event crosses the persistence boundary.
        self.stamp_objective_activation_route(attempt_id, &mut output.payload);
        Ok((output, false))
    }

    async fn execute_tool_calls(
        &self,
        session_id: &str,
        attempt_id: &str,
        response: crate::llm::Response,
        phase: &str,
        options: ToolExecutionOptions,
    ) -> Result<ToolExecutionOutcome, DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let activation_route = self.activation_route(attempt_id);
        let internal_child_handoff = activation_route
            .as_ref()
            .is_some_and(|route| route.internal_child_handoff);
        let active_principal_id = self
            .principal_for_activation_route(&context_id, activation_route.as_ref())
            .await?;
        let provider_continuation = options.provider_continuation.clone();
        let requested_tool_calls = response.tool_calls;
        let mapped_tool_calls = requested_tool_calls
            .iter()
            .map(|call| crate::llm::ToolCall {
                id: call.id.clone(),
                r#type: call.r#type.clone(),
                function: crate::llm::FunctionCall {
                    name: call.func_name.clone(),
                    arguments: call.arguments.clone(),
                },
            })
            .collect::<Vec<_>>();
        let mut selected_tool_calls = Vec::with_capacity(requested_tool_calls.len());
        let mut context_tx_calls = Vec::new();
        let mut unavailable_tool_calls = Vec::new();
        for call in requested_tool_calls {
            if call.func_name == "context_tx" {
                context_tx_calls.push(call);
            } else if !options.allowed_tool_names.contains(&call.func_name) {
                unavailable_tool_calls.push(call);
            } else {
                selected_tool_calls.push(call);
            }
        }
        let mut deduplicated_context_tx_ids = Vec::new();
        let mut deduplicated_delegate_ids = Vec::new();
        let mut rejected_context_tx_ids = Vec::new();
        let mut context_tx_batch_error = None;
        let mut context_tx_batch_status = None;
        if !options.context_tx_allowed && !context_tx_calls.is_empty() {
            rejected_context_tx_ids.extend(context_tx_calls.into_iter().map(|call| call.id));
            context_tx_batch_status = Some("budget-exhausted".to_string());
            context_tx_batch_error = Some(format!(
                "执行拒绝: CONTEXT_TX_BUDGET_EXHAUSTED：当前用户回合的 Context transaction 已达到 {} 次上限。物理工具、普通文本和 no_reply 仍然可用；请使用现有 Mind 继续必要工作，避免连续 housekeeping transaction。",
                self.orchestrator_config.max_context_transactions_per_turn.max(1)
            ));
        } else {
            match context_tx_calls.len() {
                0 => {}
                1 => selected_tool_calls.push(context_tx_calls.remove(0)),
                _ => {
                    let normalized = context_tx_calls
                        .iter()
                        .map(|call| normalize_context_tx_key(&context_id, &call.arguments))
                        .collect::<Vec<_>>();
                    let all_normalized_equal = normalized
                        .first()
                        .and_then(|first| first.as_ref().ok())
                        .is_some_and(|first| {
                            normalized
                                .iter()
                                .all(|key| key.as_ref().is_ok_and(|key| key == first))
                        });
                    let all_raw_equal = context_tx_calls
                        .windows(2)
                        .all(|pair| pair[0].arguments == pair[1].arguments);
                    if all_normalized_equal || all_raw_equal {
                        let first = context_tx_calls.remove(0);
                        deduplicated_context_tx_ids
                            .extend(context_tx_calls.into_iter().map(|call| call.id));
                        selected_tool_calls.push(first);
                    } else {
                        rejected_context_tx_ids
                            .extend(context_tx_calls.into_iter().map(|call| call.id));
                        context_tx_batch_status = Some("multiple-distinct".to_string());
                        context_tx_batch_error = Some(format!(
                        "执行拒绝: MULTIPLE_DISTINCT_CONTEXT_TX：同一响应请求了 {} 个内容不同的 context_tx。Runtime 未执行其中任何一个；请把所有 create/derive/revise/retire/restore/protect/unprotect/place 操作合并到一个原子 (context-tx ...) 后重新提交。",
                        rejected_context_tx_ids.len()
                    ));
                    }
                }
            }
        }
        if !deduplicated_context_tx_ids.is_empty() {
            tracing::warn!(
                session_id,
                attempt_id,
                deduplicated = deduplicated_context_tx_ids.len(),
                event_code = "orchestrator.assistant_response.duplicate_context_tx",
                "Assistant response contained duplicate context_tx calls; normalized by deduplication"
            );
        }
        let mut seen_delegations = HashSet::new();
        selected_tool_calls.retain(|call| {
            if call.func_name != "delegate" {
                return true;
            }
            let key = normalized_delegate_key(&call.arguments)
                .unwrap_or_else(|| call.arguments.trim().to_string());
            if seen_delegations.insert(key) {
                true
            } else {
                deduplicated_delegate_ids.push(call.id.clone());
                false
            }
        });
        if !deduplicated_delegate_ids.is_empty() {
            tracing::warn!(
                session_id,
                attempt_id,
                deduplicated = deduplicated_delegate_ids.len(),
                event_code = "orchestrator.assistant_response.duplicate_delegate",
                "Assistant response contained semantically identical delegate calls; deduplicated to prevent duplicate spawning"
            );
        }
        if !rejected_context_tx_ids.is_empty() {
            match context_tx_batch_status.as_deref() {
                Some("budget-exhausted") => tracing::warn!(
                    session_id,
                    attempt_id,
                    rejected = rejected_context_tx_ids.len(),
                        event_code = "orchestrator.assistant_response.context_tx_budget_exhausted",
                        "Context-transaction budget exhausted"
                ),
                _ => tracing::warn!(
                    session_id,
                    attempt_id,
                    rejected = rejected_context_tx_ids.len(),
                        event_code = "orchestrator.assistant_response.multiple_context_tx_rejected",
                        "Assistant response contained multiple distinct context_tx calls; all were rejected pending consolidation"
                ),
            }
        }
        if !unavailable_tool_calls.is_empty() {
            tracing::warn!(
                session_id,
                attempt_id,
                phase,
                rejected = unavailable_tool_calls.len(),
                event_code = "orchestrator.assistant_response.unavailable_tool_rejected",
                "Model called a tool not offered this turn; Runtime rejected execution"
            );
        }
        let continuation_ids = selected_tool_calls
            .iter()
            .chain(unavailable_tool_calls.iter())
            .map(|call| call.id.as_str())
            .collect::<HashSet<_>>();
        let mut continuation_tool_calls = options.continuation_tool_calls.unwrap_or_else(|| {
            selected_tool_calls
                .iter()
                .chain(unavailable_tool_calls.iter())
                .map(|call| crate::llm::ToolCall {
                    id: call.id.clone(),
                    r#type: call.r#type.clone(),
                    function: crate::llm::FunctionCall {
                        name: call.func_name.clone(),
                        arguments: call.arguments.clone(),
                    },
                })
                .collect::<Vec<_>>()
        });
        continuation_tool_calls.retain(|call| continuation_ids.contains(call.id.as_str()));
        drop(continuation_ids);
        if context_tx_batch_error.is_some() {
            continuation_tool_calls.push(crate::llm::ToolCall {
                id: "context_tx_batch_rejected".to_string(),
                r#type: "function".to_string(),
                function: crate::llm::FunctionCall {
                    name: "context_tx".to_string(),
                    arguments: json!({
                        "runtime_rejected_batch": true,
                        "status": context_tx_batch_status,
                    })
                    .to_string(),
                },
            });
        }
        let requested_count = mapped_tool_calls.len();
        let selected_call_previews = selected_tool_calls
            .iter()
            .map(tool_call_activity_preview)
            .collect::<Vec<_>>();
        let deduplicated_count =
            deduplicated_context_tx_ids.len() + deduplicated_delegate_ids.len();
        let unavailable_call_ids = unavailable_tool_calls
            .iter()
            .map(|call| call.id.clone())
            .collect::<Vec<_>>();
        let unavailable_call_names = unavailable_tool_calls
            .iter()
            .map(|call| call.func_name.clone())
            .collect::<Vec<_>>();
        let rejected_count = rejected_context_tx_ids.len() + unavailable_tool_calls.len();
        let rejection_status = context_tx_batch_status.clone().or_else(|| {
            (!unavailable_tool_calls.is_empty())
                .then(|| "tool-not-available-in-current-phase".to_string())
        });
        let mut assistant_call_payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("phase".to_string(), json!(phase)),
            ("text".to_string(), json!(response.content)),
            ("tool_calls".to_string(), json!(mapped_tool_calls)),
            (
                "continuation_tool_calls".to_string(),
                json!(continuation_tool_calls),
            ),
            (
                "deduplicated_context_tx_ids".to_string(),
                json!(deduplicated_context_tx_ids),
            ),
            (
                "deduplicated_delegate_ids".to_string(),
                json!(deduplicated_delegate_ids),
            ),
            (
                "rejected_context_tx_ids".to_string(),
                json!(rejected_context_tx_ids),
            ),
            (
                "context_tx_rejection_status".to_string(),
                json!(context_tx_batch_status),
            ),
            (
                "unavailable_tool_call_ids".to_string(),
                json!(unavailable_call_ids),
            ),
            (
                "unavailable_tool_names".to_string(),
                json!(unavailable_call_names),
            ),
        ];
        if let Some(model_attempt_id) = options.model_attempt_id.as_deref() {
            assistant_call_payload.push(("model_attempt_id".to_string(), json!(model_attempt_id)));
        }
        if let Some(provider_continuation) = provider_continuation {
            assistant_call_payload.push((
                "provider_continuation".to_string(),
                json!(provider_continuation),
            ));
        }
        let durable_attempt_id = options.model_attempt_id.as_deref().unwrap_or(attempt_id);
        let assistant_call_event_id = format!("call_{durable_attempt_id}");
        if options.record_assistant_call {
            self.append_activation_route(attempt_id, &mut assistant_call_payload);
            self.bus
                .publish(Event::new(
                    assistant_call_event_id.clone(),
                    "Agent-Morphz".to_string(),
                    TYPE_AGENT_CALL.to_string(),
                    "chat/assistant_call".to_string(),
                    assistant_call_payload.into_iter().collect(),
                ))
                .await?;
        }
        let mut selected_payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("requested_count".to_string(), json!(requested_count)),
            ("calls".to_string(), json!(selected_call_previews)),
            ("deduplicated_count".to_string(), json!(deduplicated_count)),
            ("rejected_count".to_string(), json!(rejected_count)),
            ("rejection_status".to_string(), json!(rejection_status)),
            (
                "action_group_wake_policy".to_string(),
                json!(if options.wake_on_output {
                    "direct_signal"
                } else {
                    "none"
                }),
            ),
        ];
        if let Some(model_attempt_id) = options.model_attempt_id.as_deref() {
            selected_payload.push(("model_attempt_id".to_string(), json!(model_attempt_id)));
        }
        let selected_event_id = format!("tool_calls_selected_{durable_attempt_id}");
        let record_selection = if options.record_assistant_call {
            true
        } else {
            self.context_engine
                .find_event(&context_id, &selected_event_id)
                .await?
                .is_none()
        };
        if record_selection {
            self.append_activation_route(attempt_id, &mut selected_payload);
            self.bus
                .publish(Event::new(
                    selected_event_id,
                    "Runtime-Orchestrator".to_string(),
                    "runtime_control".to_string(),
                    "runtime/tool_calls_selected".to_string(),
                    selected_payload.into_iter().collect(),
                ))
                .await?;
        }

        let (objective_create_calls, ordinary_selected_calls): (Vec<_>, Vec<_>) =
            selected_tool_calls
                .into_iter()
                .partition(|call| call.func_name == "objective_create");
        selected_tool_calls = ordinary_selected_calls;
        let ordinary_action_count = selected_tool_calls.len()
            + unavailable_tool_calls.len()
            + usize::from(context_tx_batch_error.is_some());

        // objective_create is a control-plane prelude rather than an ordinary
        // sibling Action. It must establish the Objective route before any
        // physical Action result becomes immutable.
        for (index, call) in objective_create_calls.iter().enumerate() {
            let (mut output, already_persisted) = self
                .execute_objective_create_prelude(&context_id, session_id, attempt_id, call)
                .await?;
            if !options.wake_on_output {
                output
                    .payload
                    .insert("wake_policy".to_string(), json!("none"));
            }
            let wake = options.wake_on_output
                && ordinary_action_count == 0
                && index + 1 == objective_create_calls.len();
            if wake {
                let thread_id = activation_route
                    .as_ref()
                    .map(|route| route.thread_id.as_str())
                    .ok_or("objective_create 结果缺少所属 Thread")?;
                self.store
                    .append_to_thread(output.clone(), thread_id)
                    .await?;
            } else if !already_persisted {
                self.store.append(output.clone()).await?;
            }
            dispatch_persisted_tool_handoff(self.bus.as_ref(), output, internal_child_handoff)
                .await?;
        }
        if ordinary_action_count == 0 {
            return Ok(ToolExecutionOutcome::default());
        }

        let durable_execution_identity = match (
            self.execution_jobs.is_some() || ordinary_action_count >= 2,
            &activation_route,
        ) {
            (true, Some(route)) => {
                let session_store = self
                    .context_engine
                    .session_store()
                    .ok_or("Action 执行需要持久化 SessionStore")?;
                let thread = session_store
                    .get_thread(&route.thread_id)
                    .await?
                    .ok_or_else(|| format!("Action 的 Thread '{}' 不存在", route.thread_id))?;
                if thread.context_id != context_id || thread.session_id != session_id {
                    return Err("Action 的 Thread 路由与当前 Evaluation 不一致".into());
                }
                Some((thread.agent_id, thread.id))
            }
            _ => None,
        };
        let action_group_id = if ordinary_action_count >= 2 {
            let route = activation_route
                .as_ref()
                .ok_or("Action Group 需要持久化 Activation route")?;
            let (agent_id, thread_id) = durable_execution_identity
                .as_ref()
                .ok_or("Action Group 需要持久化 Thread identity")?;
            let group_id = format!("action_group_{attempt_id}");
            let mut members = selected_tool_calls
                .iter()
                .chain(unavailable_tool_calls.iter())
                .enumerate()
                .map(|(ordinal, call)| NewActionGroupMember {
                    ordinal: ordinal as u64,
                    tool_call_id: call.id.clone(),
                    tool_name: call.func_name.clone(),
                    // The Job is created only after the Group barrier exists,
                    // so a foreign-keyed member cannot point at it yet. The
                    // immutable Job request carries the exact Group route;
                    // this optional field remains reserved for import paths
                    // that create both records in one Store transaction.
                    execution_job_id: None,
                })
                .collect::<Vec<_>>();
            if context_tx_batch_error.is_some() {
                members.push(NewActionGroupMember {
                    ordinal: members.len() as u64,
                    tool_call_id: "context_tx_batch_rejected".to_string(),
                    tool_name: "context_tx".to_string(),
                    execution_job_id: None,
                });
            }
            let objective = self.objective_evaluations.get_for_activation(attempt_id);
            self.action_groups
                .as_ref()
                .ok_or("Action Group Store 未配置")?
                .create_action_group(
                    NewActionGroup {
                        id: group_id.clone(),
                        activation_id: route.activation_id.clone(),
                        thread_id: thread_id.clone(),
                        agent_id: agent_id.clone(),
                        context_id: context_id.clone(),
                        session_id: session_id.to_string(),
                        assistant_call_event_id: assistant_call_event_id.clone(),
                        objective_id: objective.as_ref().map(|value| value.objective_id.clone()),
                        objective_evaluation_id: objective
                            .as_ref()
                            .map(|value| value.evaluation_id.clone()),
                        objective_revision: objective.as_ref().map(|value| value.revision),
                    },
                    members,
                )
                .await?;
            Some(group_id)
        } else {
            None
        };
        let action_group_settled = action_group_id
            .as_deref()
            .map(|group_id| {
                let route = activation_route
                    .as_ref()
                    .ok_or("Action Group settled Event 缺少 Activation route")?;
                let objective = self.objective_evaluations.get_for_activation(attempt_id);
                Ok::<_, DynError>(action_group_settled_event(
                    group_id,
                    &context_id,
                    session_id,
                    attempt_id,
                    ordinary_action_count,
                    route,
                    objective.as_ref(),
                    options.wake_on_output,
                ))
            })
            .transpose()?;

        let mut tasks = Vec::new();
        let mut outputs = Vec::<(Event, bool)>::new();
        let mut allowed_tool_names = options
            .allowed_tool_names
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        allowed_tool_names.sort();
        for call in unavailable_tool_calls {
            let output_id = format!("output_{}_{}", attempt_id, call.id);
            if let Some(existing) = self
                .context_engine
                .find_event(&context_id, &output_id)
                .await?
            {
                outputs.push((existing, true));
                continue;
            }
            let guidance = if phase == "critical-maintenance" {
                "当前 Context 处于 critical-maintenance。请不要重复该物理工具调用；先使用 context_tx 压缩并保留继续任务所需的最新状态，等待 Runtime 重新提供物理工具。"
            } else {
                "该工具未在本轮 Function Calling 定义中提供，因此没有执行。请根据当前阶段和 allowed_tools 重新决策。"
            };
            let output = json!({
                "status": "rejected",
                "executed": false,
                "reason": "TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE",
                "phase": phase,
                "tool": call.func_name,
                "allowed_tools": allowed_tool_names,
                "guidance": guidance,
            })
            .to_string();
            let mut payload = vec![
                ("context_id".to_string(), json!(context_id)),
                ("session_id".to_string(), json!(session_id)),
                ("attempt_id".to_string(), json!(attempt_id)),
                ("tool_call_id".to_string(), json!(call.id)),
                ("caused_by".to_string(), json!(call.id)),
                ("tool_name".to_string(), json!(call.func_name)),
                ("tool_status".to_string(), json!("rejected")),
                ("executed".to_string(), json!(false)),
                (
                    "rejection_code".to_string(),
                    json!("TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE"),
                ),
                ("phase".to_string(), json!(phase)),
                ("text".to_string(), json!(output)),
            ];
            self.append_activation_route(attempt_id, &mut payload);
            if let Some(group_id) = &action_group_id {
                payload.push(("action_group_id".to_string(), json!(group_id)));
            }
            outputs.push((
                Event::new(
                    output_id,
                    "System-ToolPolicy".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    payload.into_iter().collect(),
                ),
                false,
            ));
        }
        for call in selected_tool_calls {
            let output_id = format!("output_{}_{}", attempt_id, call.id);
            if let Some(existing) = self
                .context_engine
                .find_event(&context_id, &output_id)
                .await?
            {
                outputs.push((existing, true));
                continue;
            }
            let tool = self.registry.get(&call.func_name);
            let timeout_secs = self.orchestrator_config.tool_timeout_secs;
            let mut claimed_execution_job = None;
            let mut tool_execution_job_context = None;
            let mut durable_approval_grant = None;
            let mut execution_arguments = call.arguments.clone();
            if let (Some(tool), Some(route), Some((agent_id, thread_id))) = (
                tool.as_ref().filter(|tool| {
                    self.execution_jobs.is_some()
                        && tool.execution_class() == crate::tool::ToolExecutionClass::PhysicalJob
                }),
                activation_route.as_ref(),
                durable_execution_identity.as_ref(),
            ) {
                let prepared = self
                    .prepare_physical_execution(
                        tool,
                        route,
                        agent_id,
                        thread_id,
                        &context_id,
                        session_id,
                        attempt_id,
                        &call,
                        &output_id,
                        timeout_secs,
                        action_group_id.as_deref(),
                        options.wake_on_output && action_group_id.is_none(),
                    )
                    .await;
                match prepared? {
                    PreparedPhysicalExecution::Claimed(claimed) => {
                        execution_arguments = claimed.arguments;
                        claimed_execution_job = Some(claimed.job);
                        tool_execution_job_context = Some(claimed.context);
                        durable_approval_grant = claimed.approval;
                    }
                    PreparedPhysicalExecution::Terminal(event) => {
                        outputs.push((event, true));
                        continue;
                    }
                    PreparedPhysicalExecution::Rejected(event) => {
                        outputs.push((event, false));
                        continue;
                    }
                }
            }
            let session_id = session_id.to_string();
            let context_id = context_id.clone();
            let attempt_id = attempt_id.to_string();
            let task_action_group_id = action_group_id.clone();
            let task_principal_id = active_principal_id.clone();
            let output_principal_id = task_principal_id.clone();
            let activation_route = activation_route.clone();
            let tool_causal_route =
                activation_route
                    .as_ref()
                    .map(|route| crate::tool::ToolCausalRoute {
                        thread_id: route.thread_id.clone(),
                        activation_id: route.activation_id.clone(),
                        root_turn_id: route.root_turn_id.clone(),
                        trigger_event_id: route.trigger_event_id.clone(),
                        trigger_sequence: route.trigger_sequence,
                    });
            let metadata = ToolTaskMetadata {
                output_id: output_id.clone(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                attempt_id: attempt_id.clone(),
                tool_call_id: call.id.clone(),
                tool_name: call.func_name.clone(),
                target_id: claimed_execution_job
                    .as_ref()
                    .map(|job| job.target_id.clone()),
                action_group_id: task_action_group_id.clone(),
                activation_route: activation_route.clone(),
                execution_job: claimed_execution_job.clone(),
                wake_on_output: options.wake_on_output,
            };
            let execution_jobs = self.execution_jobs.clone();
            let execution_targets = self.execution_targets.clone();
            let action_groups = self.action_groups.clone();
            let settled_event = action_group_settled.clone();
            let event_bus = Arc::clone(&self.bus);
            let task_internal_child_handoff = internal_child_handoff;
            let objective_supervisor = self.objective_supervisor.clone();
            let model_input_root = self.message_attachment_root.clone();
            let model_input_import_limits = self.model_input_config.import_limits();
            let model_input_event_id = output_id.clone();
            let objective_evaluation = self.objective_evaluations.get_for_activation(&attempt_id);
            let task_objective_id = objective_evaluation
                .as_ref()
                .map(|evaluation| evaluation.objective_id.clone());
            let task_wake_on_output = options.wake_on_output;
            // Established before the spawn, because task-locals do not cross
            // into a new task: the chain below rebuilds every one of them.
            let inference_channel: Option<Arc<dyn crate::sexpr_eval::RuntimeInference>> =
                self.self_ref.get().cloned().map(|orchestrator| {
                    Arc::new(OrchestratorInference {
                        orchestrator,
                        session_id: session_id.clone(),
                        attempt_id: attempt_id.clone(),
                    }) as Arc<dyn crate::sexpr_eval::RuntimeInference>
                });
            let plan_executor: Option<Arc<dyn crate::sexpr_eval::RuntimePlanExecutor>> =
                if call.func_name == "eval" && self.plan_store.is_some() {
                    match (
                        self.self_ref.get().cloned(),
                        activation_route.as_ref(),
                        durable_execution_identity.as_ref(),
                    ) {
                        (Some(orchestrator), Some(activation), Some((agent_id, thread_id))) => {
                            Some(Arc::new(OrchestratorPlanExecutor {
                                orchestrator,
                                route: PlanExecutionRoute {
                                    activation_id: activation.activation_id.clone(),
                                    thread_id: thread_id.clone(),
                                    agent_id: agent_id.clone(),
                                    context_id: context_id.clone(),
                                    session_id: session_id.clone(),
                                    initiating_principal_id: activation
                                        .initiating_principal_id
                                        .clone(),
                                    tool_call_id: call.id.clone(),
                                    objective_id: objective_evaluation
                                        .as_ref()
                                        .map(|value| value.objective_id.clone()),
                                    objective_evaluation_id: objective_evaluation
                                        .as_ref()
                                        .map(|value| value.evaluation_id.clone()),
                                },
                            })
                                as Arc<dyn crate::sexpr_eval::RuntimePlanExecutor>)
                        }
                        _ => None,
                    }
                } else {
                    None
                };
            let handle = tokio::spawn(async move {
                crate::sexpr_eval::CURRENT_PLAN_EXECUTOR
                    .scope(plan_executor, async move {
                crate::sexpr_eval::CURRENT_INFERENCE
                    .scope(inference_channel, async move {
                crate::tool::CURRENT_PRINCIPAL_ID
                    .scope(task_principal_id, async move {
                crate::permission::CURRENT_DURABLE_APPROVAL
                        .scope(durable_approval_grant, async move {
                            crate::tool::CURRENT_EXECUTION_JOB
                                .scope(tool_execution_job_context, async move {
                                    crate::tool::CURRENT_OBJECTIVE_ID
                                        .scope(task_objective_id, async move {
                                    crate::tool::CURRENT_CAUSAL_ROUTE
                                        .scope(tool_causal_route, async move {
                                            crate::tool::CURRENT_ATTEMPT_ID
                                                .scope(attempt_id.clone(), async move {
                                                    crate::tool::CURRENT_CONTEXT_ID
                                                        .scope(context_id.clone(), async move {
                                                            crate::tool::CURRENT_SESSION_ID
                                                    .scope(session_id.clone(), async move {
                                                        let fence_current = match (
                                                            objective_supervisor.as_ref(),
                                                            activation_route.as_ref(),
                                                        ) {
                                                            (Some(supervisor), Some(route)) => {
                                                                supervisor
                                                                    .activation_fence_is_current(
                                                                        &route.activation_id,
                                                                    )
                                                                    .await?
                                                            }
                                                            _ => true,
                                                        };
                                                        let (output, tool_status) = if fence_current {
                                                            let execution = async {
                                                                match tool {
                                                                    Some(tool) => match claimed_execution_job.as_ref() {
                                                                        Some(job) => execution_targets
                                                                            .as_ref()
                                                                            .ok_or("Physical Execution 缺少 ExecutionTargetDispatcher")?
                                                                            .execute(
                                                                                &job.record,
                                                                                Arc::clone(&tool),
                                                                                &execution_arguments,
                                                                            )
                                                                            .await,
                                                                        None => tool
                                                                            .execute_result(&execution_arguments)
                                                                            .await,
                                                                    },
                                                                    None => Err(format!(
                                                                        "未注册的工具: {}",
                                                                        call.func_name
                                                                    )
                                                                    .into()),
                                                                }
                                                            };
                                                            // Physical backends own their deadline/lease semantics.
                                                            // In particular, an offline Edge Target is a durable wait,
                                                            // not a local wall-clock timeout. Logical inline tools keep
                                                            // the Runtime safety timeout.
                                                            let result = if claimed_execution_job.is_some()
                                                                || call.func_name == "eval"
                                                            {
                                                                Ok(execution.await)
                                                            } else {
                                                                tokio::time::timeout(
                                                                    tokio::time::Duration::from_secs(timeout_secs),
                                                                    execution,
                                                                )
                                                                .await
                                                            };
                                                            match result {
                                                                Ok(Ok(output)) => {
                                                                    let status = infer_tool_status(
                                                                        &output.text,
                                                                    );
                                                                    (output, status)
                                                                }
                                                                Ok(Err(error)) => (
                                                                    crate::tool::ToolExecutionResult::text(
                                                                        format!("执行失败: {}", error),
                                                                    ),
                                                                    "error",
                                                                ),
                                                                Err(_) => (
                                                                    crate::tool::ToolExecutionResult::text(
                                                                        format!(
                                                                            "执行超时: 超过 {} 秒限额",
                                                                            timeout_secs
                                                                        ),
                                                                    ),
                                                                    "timeout",
                                                                ),
                                                            }
                                                        } else {
                                                            let reason = format!(
                                                                "OBJECTIVE_EVALUATION_FENCED：Activation '{}' 的 Objective Evaluation 已被撤销或取代；Runtime 未执行工具 '{}'",
                                                                activation_route
                                                                    .as_ref()
                                                                    .map(|route| route.activation_id.as_str())
                                                                    .unwrap_or(attempt_id.as_str()),
                                                                call.func_name
                                                            );
                                                            if let (Some(manager), Some(job)) = (
                                                                execution_jobs.as_ref(),
                                                                claimed_execution_job.as_ref(),
                                                            ) {
                                                                let _ = manager
                                                                    .request_cancel(
                                                                        &job.id,
                                                                        job.revision,
                                                                        Some(&reason),
                                                                    )
                                                                    .await?;
                                                            }
                                                            (
                                                                crate::tool::ToolExecutionResult::text(reason),
                                                                "cancelled",
                                                            )
                                                        };
                                                        let wake_policy = if !task_wake_on_output {
                                                            "none"
                                                        } else if call.func_name
                                                            == "delegate"
                                                            && tool_status == "success"
                                                            && delegation_mode_from_arguments(
                                                                &call.arguments,
                                                            ) != "detached"
                                                        {
                                                            "delegation_result"
                                                        } else {
                                                            "immediate"
                                                        };
                                                        let raw_attachments = output
                                                            .model_attachments
                                                            .into_iter()
                                                            .map(|attachment| {
                                                                let data = base64::engine::general_purpose::STANDARD
                                                                    .decode(&attachment.data_base64)
                                                                    .map_err(|error| {
                                                                        format!(
                                                                            "工具 '{}' 返回的模型附件 '{}' 不是合法 Base64：{error}",
                                                                            call.func_name,
                                                                            attachment.name
                                                                        )
                                                                    })?;
                                                                Ok::<_, DynError>(
                                                                    crate::sdk::MessageAttachmentInput {
                                                                        name: attachment.name,
                                                                        media_type: attachment.media_type,
                                                                        data,
                                                                    },
                                                                )
                                                            })
                                                            .collect::<Result<Vec<_>, _>>()?;
                                                        let model_attachments =
                                                            crate::model_input::persist_model_input_attachments(
                                                                &model_input_root,
                                                                "tool-inputs",
                                                                &context_id,
                                                                &model_input_event_id,
                                                                raw_attachments,
                                                                model_input_import_limits,
                                                            )
                                                            .await?;
                                                        let mut output_text = output.text;
                                                        if !model_attachments.is_empty() {
                                                            let references = crate::model_input::public_attachment_references(
                                                                &model_attachments,
                                                                &model_input_event_id,
                                                            );
                                                            let mut value = serde_json::from_str::<serde_json::Value>(&output_text)
                                                                .unwrap_or_else(|_| json!({
                                                                    "status": "loaded",
                                                                    "message": output_text.clone(),
                                                                }));
                                                            if let Some(object) = value.as_object_mut() {
                                                                object.insert(
                                                                    "model_attachments".to_string(),
                                                                    serde_json::Value::Array(references),
                                                                );
                                                            }
                                                            output_text = value.to_string();
                                                        }
                                                        let output_empty = output_text.trim().is_empty();
                                                        let mut payload = vec![
                                                            (
                                                                "context_id".to_string(),
                                                                json!(context_id),
                                                            ),
                                                            (
                                                                "session_id".to_string(),
                                                                json!(session_id),
                                                            ),
                                                            (
                                                                "attempt_id".to_string(),
                                                                json!(attempt_id),
                                                            ),
                                                            (
                                                                "tool_call_id".to_string(),
                                                                json!(call.id),
                                                            ),
                                                            (
                                                                "caused_by".to_string(),
                                                                json!(call.id),
                                                            ),
                                                            (
                                                                "tool_name".to_string(),
                                                                json!(call.func_name),
                                                            ),
                                                            (
                                                                "tool_status".to_string(),
                                                                json!(tool_status),
                                                            ),
                                                            (
                                                                "wake_policy".to_string(),
                                                                json!(wake_policy),
                                                            ),
                                                            (
                                                                "output_empty".to_string(),
                                                                json!(output_empty),
                                                            ),
                                                            ("text".to_string(), json!(output_text)),
                                                        ]
                                                        .into_iter()
                                                        .collect::<serde_json::Map<_, _>>();
                                                        if !model_attachments.is_empty() {
                                                            payload.insert(
                                                                "model_attachments".to_string(),
                                                                serde_json::Value::Array(model_attachments),
                                                            );
                                                        }
                                                        if let Some(principal_id) =
                                                            output_principal_id
                                                        {
                                                            payload.insert(
                                                                "principal_id".to_string(),
                                                                json!(principal_id),
                                                            );
                                                        }
                                                        if let Some(job) =
                                                            claimed_execution_job.as_ref()
                                                        {
                                                            payload.insert(
                                                                "execution_job_id".to_string(),
                                                                json!(job.id),
                                                            );
                                                            stamp_execution_route_facts(
                                                                &mut payload,
                                                                &job.target_id,
                                                                &job.record.request,
                                                                job.record.claimed_by.as_deref(),
                                                            );
                                                        }
                                                        if let Some(route) = activation_route {
                                                            payload.insert(
                                                                "thread_id".to_string(),
                                                                json!(route.thread_id),
                                                            );
                                                            payload.insert(
                                                                "activation_id".to_string(),
                                                                json!(route.activation_id),
                                                            );
                                                            payload.insert(
                                                                "root_turn_id".to_string(),
                                                                json!(route.root_turn_id),
                                                            );
                                                            payload.insert(
                                                                "trigger_event_id".to_string(),
                                                                json!(route.trigger_event_id),
                                                            );
                                                            payload.insert(
                                                                "trigger_sequence".to_string(),
                                                                json!(route.trigger_sequence),
                                                            );
                                                            if let Some(version) =
                                                                route.context_snapshot_version
                                                            {
                                                                payload.insert(
                                                                    "context_snapshot_version"
                                                                        .to_string(),
                                                                    json!(version),
                                                                );
                                                            }
                                                        }
                                                        if let Some(group_id) =
                                                            &task_action_group_id
                                                        {
                                                            payload.insert(
                                                                "action_group_id".to_string(),
                                                                json!(group_id),
                                                            );
                                                        }
                                                        if call.func_name == "exec" {
                                                            extend_exec_output_facts(
                                                                &mut payload,
                                                                &output_text,
                                                            );
                                                        }
                                                        let mut output = Event::new(
                                                            format!(
                                                                "output_{}_{}",
                                                                attempt_id, call.id
                                                            ),
                                                            "System-Executor".to_string(),
                                                            TYPE_TOOL_OUTPUT.to_string(),
                                                            "chat/tool_output".to_string(),
                                                            payload,
                                                        );
                                                        if let Some(active) = objective_evaluation {
                                                            output.payload.insert(
                                                                "objective_id".to_string(),
                                                                json!(active.objective_id),
                                                            );
                                                            output.payload.insert(
                                                                "objective_evaluation_id".to_string(),
                                                                json!(active.evaluation_id),
                                                            );
                                                            output.payload.insert(
                                                                "objective_revision".to_string(),
                                                                json!(active.revision),
                                                            );
                                                        }
                                                        let already_persisted = match (
                                                            execution_jobs,
                                                            claimed_execution_job,
                                                        ) {
                                                            (Some(manager), Some(job)) => {
                                                                finish_claimed_physical_job(
                                                                    manager.as_ref(),
                                                                    &job,
                                                                    &mut output,
                                                                    task_wake_on_output
                                                                        && task_action_group_id.is_none()
                                                                        && wake_policy
                                                                            != "delegation_result",
                                                                )
                                                                .await?;
                                                                true
                                                            }
                                                            (None, None) | (Some(_), None) => false,
                                                            (None, Some(_)) => {
                                                                return Err(
                                                                    "工具任务与 Execution Job Manager 边界不一致"
                                                                        .into(),
                                                                );
                                                            }
                                                        };
                                                        let group_committed = match (
                                                            action_groups,
                                                            task_action_group_id.as_deref(),
                                                            settled_event.as_ref(),
                                                        ) {
                                                            (Some(groups), Some(group_id), Some(settled)) => {
                                                                let commit = groups
                                                                    .commit_action_group_member_result(
                                                                        group_id,
                                                                        &call.id,
                                                                        action_group_member_status(&output),
                                                                        &output,
                                                                        settled,
                                                                    )
                                                                    .await?;
                                                                if !commit.existing {
                                                                    dispatch_persisted_tool_handoff(
                                                                        event_bus.as_ref(),
                                                                        output.clone(),
                                                                        task_internal_child_handoff,
                                                                    )
                                                                    .await?;
                                                                }
                                                                if commit.settled_now {
                                                                    dispatch_persisted_tool_handoff(
                                                                        event_bus.as_ref(),
                                                                        settled.clone(),
                                                                        task_internal_child_handoff,
                                                                    )
                                                                    .await?;
                                                                }
                                                                true
                                                            }
                                                            (None, None, None)
                                                            | (Some(_), None, None) => false,
                                                            _ => {
                                                                return Err("Action Group 执行边界不一致".into());
                                                            }
                                                        };
                                                        Ok(SpawnedToolTaskResult {
                                                            output,
                                                            already_persisted: already_persisted
                                                                || group_committed,
                                                        })
                                                    })
                                                    .await
                                                        })
                                                        .await
                                                })
                                                .await
                                        })
                                        .await
                                    })
                                    .await
                                })
                                .await
                        })
                        .await
                    })
                    .await
                    })
                    .await
                    })
                    .await
            });
            tasks.push(SpawnedToolTask { handle, metadata });
        }

        if let Some(error) = context_tx_batch_error {
            let output_id = format!("output_{}_context_tx_batch_rejected", attempt_id);
            if let Some(existing) = self
                .context_engine
                .find_event(&context_id, &output_id)
                .await?
            {
                outputs.push((existing, true));
            } else {
                let mut payload = vec![
                    ("context_id".to_string(), json!(context_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    (
                        "tool_call_id".to_string(),
                        json!("context_tx_batch_rejected"),
                    ),
                    ("caused_by".to_string(), json!("context_tx_batch_rejected")),
                    ("tool_name".to_string(), json!("context_tx")),
                    ("tool_status".to_string(), json!("rejected")),
                    (
                        "context_tx_status".to_string(),
                        json!(context_tx_batch_status.as_deref().unwrap_or("rejected")),
                    ),
                    ("text".to_string(), json!(error)),
                ];
                self.append_activation_route(attempt_id, &mut payload);
                if let Some(group_id) = &action_group_id {
                    payload.push(("action_group_id".to_string(), json!(group_id)));
                }
                outputs.push((
                    Event::new(
                        output_id,
                        "System-ContextGuard".to_string(),
                        TYPE_TOOL_OUTPUT.to_string(),
                        "chat/tool_output".to_string(),
                        payload.into_iter().collect(),
                    ),
                    false,
                ));
            }
        }
        for task in tasks {
            let metadata = task.metadata;
            let (mut output, already_persisted, job_outcome) = match task.handle.await {
                Ok(Ok(result)) => (result.output, result.already_persisted, None),
                Ok(Err(error)) => {
                    let reason = format!(
                        "工具 '{}' 的执行任务在收敛终态时失败：{error}",
                        metadata.tool_name
                    );
                    tracing::error!(
                        tool = %metadata.tool_name,
                        tool_call_id = %metadata.tool_call_id,
                        %error,
                        event_code = "orchestrator.tool_task.terminal_convergence_failed",
                        "Tool task failed while converging its terminal state; recovering from the durable Job result when one exists"
                    );
                    self.recover_failed_tool_task(&metadata, &reason).await?
                }
                Err(error) => {
                    let reason = format!(
                        "工具 '{}' 的执行任务异常终止，外部结果未知：{error}",
                        metadata.tool_name
                    );
                    tracing::error!(
                        tool = %metadata.tool_name,
                        tool_call_id = %metadata.tool_call_id,
                        ?error,
                    event_code = "orchestrator.tool_task.join_failed",
                    "Tool task join failed; generating an explicit lost result"
                    );
                    self.recover_failed_tool_task(&metadata, &reason).await?
                }
            };
            if !metadata.wake_on_output {
                output
                    .payload
                    .insert("wake_policy".to_string(), json!("none"));
            }
            let already_persisted = match (metadata.execution_job, job_outcome) {
                (Some(job), Some(outcome)) => {
                    let manager = self
                        .execution_jobs
                        .as_ref()
                        .ok_or("Execution Job 完成时 Manager 不存在")?;
                    finish_claimed_physical_job_with_outcome(
                        manager.as_ref(),
                        &job,
                        outcome,
                        &output,
                        metadata.wake_on_output && action_group_id.is_none(),
                    )
                    .await?;
                    true
                }
                (_, None) => already_persisted,
                _ => return Err("工具任务与 Execution Job 结果边界不一致".into()),
            };
            outputs.push((output, already_persisted));
        }
        if outputs.is_empty() {
            return Err("所有工具任务都在产生结果前异常终止".into());
        }
        if let Some(plan_execution_id) = options.plan_execution_id.as_deref() {
            for (output, _) in &mut outputs {
                output
                    .payload
                    .insert("plan_execution_id".to_string(), json!(plan_execution_id));
                // Keep the routing boundary self-describing even if a future
                // producer accidentally regresses the option propagation.
                output
                    .payload
                    .insert("wake_policy".to_string(), json!("none"));
            }
        }
        let mut outcome = ToolExecutionOutcome::default();
        for (output, _) in &outputs {
            if output
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("context_tx")
            {
                outcome.context_tx_succeeded = context_tx_output_succeeded(output);
            }
            outcome.outputs.push(output.clone());
        }
        if let Some(group_id) = action_group_id {
            let settled_event = action_group_settled
                .as_ref()
                .ok_or("Action Group settled Event 未构造")?;
            let groups = self
                .action_groups
                .as_ref()
                .ok_or("Action Group Store 未配置")?;
            for (output, _) in outputs {
                let tool_call_id = output
                    .payload
                    .get("tool_call_id")
                    .and_then(|value| value.as_str())
                    .ok_or("Action Group result 缺少 tool_call_id")?;
                let commit = groups
                    .commit_action_group_member_result(
                        &group_id,
                        tool_call_id,
                        action_group_member_status(&output),
                        &output,
                        settled_event,
                    )
                    .await?;
                if !commit.existing {
                    dispatch_persisted_tool_handoff(
                        self.bus.as_ref(),
                        output,
                        internal_child_handoff,
                    )
                    .await?;
                }
                if commit.settled_now {
                    dispatch_persisted_tool_handoff(
                        self.bus.as_ref(),
                        settled_event.clone(),
                        internal_child_handoff,
                    )
                    .await?;
                }
            }
        } else {
            debug_assert_eq!(outputs.len(), 1);
            for (mut output, already_persisted) in outputs {
                if !options.wake_on_output {
                    output
                        .payload
                        .insert("wake_policy".to_string(), json!("none"));
                }
                let is_delegation_receipt = output
                    .payload
                    .get("wake_policy")
                    .and_then(|value| value.as_str())
                    == Some("delegation_result");
                if options.wake_on_output && !is_delegation_receipt && !already_persisted {
                    let thread_id = activation_route
                        .as_ref()
                        .map(|route| route.thread_id.as_str())
                        .ok_or("工具结果缺少所属 Thread")?;
                    self.store
                        .append_to_thread(output.clone(), thread_id)
                        .await?;
                } else if !already_persisted {
                    self.store.append(output.clone()).await?;
                }
                dispatch_persisted_tool_handoff(self.bus.as_ref(), output, internal_child_handoff)
                    .await?;
            }
        }
        Ok(outcome)
    }

    async fn recover_failed_tool_task(
        &self,
        metadata: &ToolTaskMetadata,
        reason: &str,
    ) -> Result<(Event, bool, Option<JobOutcome>), DynError> {
        if let Some(claimed) = metadata.execution_job.as_ref() {
            let manager = self
                .execution_jobs
                .as_ref()
                .ok_or("Execution Job 恢复时 Manager 不存在")?;
            let current = manager
                .store()
                .get_execution_job(&claimed.id)
                .await?
                .ok_or_else(|| format!("Execution Job '{}' 在任务恢复时不存在", claimed.id))?;
            if current.status.is_terminal() {
                let result_event_id = current.result_event_id.as_deref().ok_or_else(|| {
                    format!("终态 Execution Job '{}' 缺少 result_event_id", current.id)
                })?;
                let output = self
                    .context_engine
                    .find_event(&metadata.context_id, result_event_id)
                    .await?
                    .ok_or_else(|| {
                        format!(
                            "终态 Execution Job '{}' 的结果 Event '{}' 不存在",
                            current.id, result_event_id
                        )
                    })?;
                if output.id != metadata.output_id {
                    return Err(format!(
                        "Execution Job '{}' 的结果 Event '{}' 与调用确定性输出 '{}' 不一致",
                        current.id, output.id, metadata.output_id
                    )
                    .into());
                }
                return Ok((output, true, None));
            }
        }
        let mut output = lost_tool_output(metadata, reason);
        self.stamp_objective_activation_route(&metadata.attempt_id, &mut output.payload);
        let outcome = metadata.execution_job.as_ref().map(|_| JobOutcome::Lost {
            result_event_id: Some(output.id.clone()),
            reason: reason.to_string(),
        });
        Ok((output, false, outcome))
    }

    async fn context_tx_receipt(
        &self,
        context: &ContextView,
    ) -> Result<ContextTxReceipt, DynError> {
        if context.wake.tool_name.as_deref() != Some("context_tx") {
            return Ok(ContextTxReceipt::None);
        }
        let Some(event_id) = context.wake.event_id.as_deref() else {
            return Ok(ContextTxReceipt::None);
        };
        Ok(self
            .context_engine
            .find_event(&context.context_id, event_id)
            .await?
            .as_ref()
            .map(context_tx_receipt_for_event)
            .unwrap_or(ContextTxReceipt::None))
    }

    async fn publish_model_request_snapshot(
        &self,
        session_id: &str,
        attempt_id: &str,
        context: &ContextView,
        messages: &[Message],
        tools: &[ToolDefinition],
        visible_input_ids: &[String],
    ) {
        if !self
            .bus
            .ephemeral_observation_requested("runtime/model_request_snapshot", session_id)
        {
            return;
        }
        let mut payload = vec![
            ("context_id".to_string(), json!(context.context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("storage".to_string(), json!("ephemeral")),
            ("text".to_string(), json!(context.sexpr)),
            ("messages".to_string(), json!(messages)),
            ("tools".to_string(), json!(tools)),
            ("mind".to_string(), json!(context.state)),
            ("inbox".to_string(), json!(context.observations)),
            ("pressure".to_string(), json!(context.pressure)),
            ("attribution".to_string(), json!(context.attribution)),
            ("turn_budget".to_string(), json!(context.turn_budget)),
            (
                "model_provider_queue_timeout_secs".to_string(),
                json!(self.orchestrator_config.model_provider_queue_timeout_secs),
            ),
            (
                "model_attempt_hard_timeout_secs".to_string(),
                json!(self.orchestrator_config.model_attempt_hard_timeout_secs),
            ),
            ("wake".to_string(), json!(context.wake)),
            ("visible_input_ids".to_string(), json!(visible_input_ids)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        let event = Event::new(
            format!(
                "model_request_snapshot_{}",
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "System-ContextKernel".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "runtime/model_request_snapshot".to_string(),
            payload.into_iter().collect(),
        );
        // Exact physical request bodies exist only for live diagnostics. The
        // durable ModelAttempt stores bounded shape and pressure metadata;
        // scheduler ownership was committed above in activation_signals.
        if let Err(error) = self.bus.publish_ephemeral(event).await {
            tracing::debug!(
                session_id,
                attempt_id,
                error = %error,
                event_code = "orchestrator.model_request_snapshot.publish_failed",
                "Failed to publish the ephemeral physical model-request snapshot"
            );
        }
    }

    fn activation_route(&self, attempt_id: &str) -> Option<ActivationRoute> {
        self.activation_routes
            .get(attempt_id)
            .map(|route| route.clone())
            .or_else(|| {
                attempt_id
                    .split_once("_response_retry_")
                    .and_then(|(base, _)| {
                        self.activation_routes.get(base).map(|route| route.clone())
                    })
            })
    }

    fn delivery_kind_for_attempt(&self, attempt_id: &str) -> &'static str {
        if self
            .activation_route(attempt_id)
            .is_some_and(|route| route.thread_kind == "delivery")
        {
            DELIVERY_KIND_THREAD_DELIVERY
        } else {
            DELIVERY_KIND_TURN_REPLY
        }
    }

    async fn principal_for_activation_route(
        &self,
        context_id: &str,
        route: Option<&ActivationRoute>,
    ) -> Result<Option<String>, DynError> {
        let Some(route) = route else {
            return Ok(None);
        };
        if route.initiating_principal_id.is_some() {
            return Ok(route.initiating_principal_id.clone());
        }
        for event_id in [&route.trigger_event_id, &route.root_turn_id] {
            if let Some(principal_id) = self
                .context_engine
                .find_event(context_id, event_id)
                .await?
                .and_then(|event| {
                    event
                        .payload
                        .get("principal_id")
                        .and_then(|value| value.as_str())
                        .map(ToOwned::to_owned)
                })
            {
                return Ok(Some(principal_id));
            }
        }
        Ok(None)
    }

    fn append_activation_route(
        &self,
        attempt_id: &str,
        payload: &mut Vec<(String, serde_json::Value)>,
    ) {
        let Some(route) = self.activation_route(attempt_id) else {
            return;
        };
        payload.extend([
            ("thread_id".to_string(), json!(route.thread_id)),
            ("activation_id".to_string(), json!(route.activation_id)),
            ("root_turn_id".to_string(), json!(route.root_turn_id)),
            (
                "trigger_event_id".to_string(),
                json!(route.trigger_event_id),
            ),
            (
                "trigger_sequence".to_string(),
                json!(route.trigger_sequence),
            ),
            ("thread_kind".to_string(), json!(route.thread_kind)),
        ]);
        if let Some(principal_id) = route.initiating_principal_id {
            payload.push(("principal_id".to_string(), json!(principal_id)));
        }
        if let Some(version) = route.context_snapshot_version {
            payload.push(("context_snapshot_version".to_string(), json!(version)));
        }
        if !payload.iter().any(|(key, _)| key == "caused_by") {
            payload.push(("caused_by".to_string(), json!(route.trigger_event_id)));
        }
        if let Some(active) = self.objective_evaluations.get_for_activation(attempt_id) {
            let elapsed_seconds = (Utc::now() - active.started_at).num_seconds().max(0) as u64;
            payload.extend([
                ("objective_id".to_string(), json!(active.objective_id)),
                (
                    "objective_evaluation_id".to_string(),
                    json!(active.evaluation_id),
                ),
                ("objective_revision".to_string(), json!(active.revision)),
                (
                    "objective_evaluation_elapsed_seconds".to_string(),
                    json!(elapsed_seconds),
                ),
            ]);
        }
    }

    fn stamp_objective_activation_route(
        &self,
        attempt_id: &str,
        payload: &mut serde_json::Map<String, serde_json::Value>,
    ) {
        let Some(active) = self.objective_evaluations.get_for_activation(attempt_id) else {
            return;
        };
        payload.insert("objective_id".to_string(), json!(active.objective_id));
        payload.insert(
            "objective_evaluation_id".to_string(),
            json!(active.evaluation_id),
        );
        payload.insert("objective_revision".to_string(), json!(active.revision));
    }

    async fn harness_mount_for_activation(
        &self,
        context_id: &str,
        activation: &ThreadActivationRecord,
    ) -> Result<
        Option<(
            HarnessBinding,
            Arc<dyn DomainHarness>,
            RenderedHarnessContext,
        )>,
        DynError,
    > {
        let active = self
            .objective_evaluations
            .get_for_activation(&activation.id);
        // Objective Evaluations already have their own durable identity.
        // Ordinary dialogue/work Evaluation is the complete causal Thread,
        // not one scheduler Activation: tool outputs create successor
        // Activations but retain the same root_turn_id.
        let evaluation_id = active
            .as_ref()
            .map(|active| active.evaluation_id.as_str())
            .unwrap_or(activation.root_turn_id.as_str());
        let mut binding =
            load_evaluation_harness_binding(self.store.as_ref(), evaluation_id).await?;

        // An explicit SDK/HTTP/CLI selection is carried by the immutable root
        // message. Materialize it as an Evaluation binding before the first
        // Provider request so transport metadata never becomes prompt policy.
        if binding.is_none() {
            if let Some(trigger) = self
                .context_engine
                .find_event(context_id, &activation.trigger_event_id)
                .await?
            {
                if let (Some(id), Some(version), Some(hash)) = (
                    trigger
                        .payload
                        .get("requested_harness_id")
                        .and_then(|value| value.as_str()),
                    trigger
                        .payload
                        .get("requested_harness_version")
                        .and_then(|value| value.as_str()),
                    trigger
                        .payload
                        .get("requested_harness_artifact_hash")
                        .and_then(|value| value.as_str()),
                ) {
                    let harness = self
                        .harness_registry
                        .get(id, version)
                        .ok_or_else(|| format!("请求的 Harness '{id}@{version}' 未加载"))?;
                    if harness.artifact_hash().as_deref() != Some(hash) {
                        return Err(format!(
                            "请求的 Harness '{id}@{version}' artifact hash 与 Registry 不一致"
                        )
                        .into());
                    }
                    binding = Some(
                        persist_evaluation_harness_binding(
                            self.store.as_ref(),
                            context_id,
                            evaluation_id,
                            active.as_ref().map(|item| item.objective_id.as_str()),
                            None,
                            harness.as_ref(),
                        )
                        .await?,
                    );
                }
            }
        }

        // Objective binding is only an optional inherited default. Every
        // concrete Objective Evaluation receives its own immutable binding.
        if binding.is_none() {
            if let Some(active) = active.as_ref() {
                if let Some(default) = load_objective_harness_binding(
                    self.store.as_ref(),
                    context_id,
                    &active.objective_id,
                )
                .await?
                {
                    let harness = self
                        .harness_registry
                        .get(&default.harness_id, &default.harness_version)
                        .ok_or_else(|| {
                            format!(
                                "Objective '{}' 默认 Harness '{}@{}' 未加载",
                                active.objective_id, default.harness_id, default.harness_version
                            )
                        })?;
                    binding = Some(
                        persist_evaluation_harness_binding(
                            self.store.as_ref(),
                            context_id,
                            evaluation_id,
                            Some(&active.objective_id),
                            Some(&active.objective_id),
                            harness.as_ref(),
                        )
                        .await?,
                    );
                }
            }
        }

        let Some(binding) = binding else {
            return Ok(None);
        };
        let harness = self
            .harness_registry
            .get(&binding.harness_id, &binding.harness_version)
            .ok_or_else(|| {
                format!(
                    "Evaluation '{}' 绑定的 Harness '{}@{}' 未加载",
                    evaluation_id, binding.harness_id, binding.harness_version
                )
            })?;
        if harness.artifact_hash().as_deref() != Some(binding.artifact_hash.as_str()) {
            return Err(format!(
                "Evaluation '{}' 的 Harness binding hash 与 Registry 不一致",
                evaluation_id
            )
            .into());
        }
        let rendered = render_harness_context(&binding, harness.as_ref())?;
        Ok(Some((binding, harness, rendered)))
    }

    /// Starts one Runtime-owned Harness entry through the same durable
    /// `eval`/PlanExecution boundary used by an explicit model Function Call.
    ///
    /// The synthetic call ID is stable for the exact Evaluation and
    /// package hash. A tool result creates the continuation Activation; that
    /// continuation finds the existing terminal Plan and proceeds to the model
    /// instead of executing the entry a second time.
    async fn dispatch_runtime_harness_entry(
        &self,
        session_id: &str,
        activation: &ThreadActivationRecord,
        binding: &HarnessBinding,
        source: &str,
        program: &crate::sexpr_eval::Program,
    ) -> Result<bool, DynError> {
        if program.owner() != crate::sexpr_eval::EvaluationOwner::Runtime {
            return Ok(false);
        }
        let active = self
            .objective_evaluations
            .get_for_activation(&activation.id);
        let evaluation_id = binding
            .evaluation_id
            .as_deref()
            .ok_or("Runtime-owned Harness entry 缺少 Evaluation binding identity")?;
        if let (Some(active), Some(bound_objective_id)) =
            (active.as_ref(), binding.objective_id.as_deref())
        {
            if active.objective_id != bound_objective_id {
                return Err(format!(
                    "Harness binding Objective '{}' 与当前 Evaluation Objective '{}' 不一致",
                    bound_objective_id, active.objective_id
                )
                .into());
            }
        }
        let tool_call_id = stable_harness_entry_call_id(binding, evaluation_id);
        let store = self
            .plan_store
            .as_ref()
            .ok_or("Runtime-owned Harness entry 需要 PlanExecution Store")?;
        let existing = store
            .list_plan_executions(PlanExecutionFilter {
                context_id: Some(activation.context_id.clone()),
                session_id: Some(session_id.to_string()),
                tool_call_id: Some(tool_call_id.clone()),
                objective_id: active.as_ref().map(|item| item.objective_id.clone()),
                objective_evaluation_id: active.as_ref().map(|item| item.evaluation_id.clone()),
                harness_id: Some(binding.harness_id.clone()),
                harness_version: Some(binding.harness_version.clone()),
                source_artifact_hash: Some(binding.artifact_hash.clone()),
                include_terminal: true,
                limit: Some(1),
                ..PlanExecutionFilter::default()
            })
            .await?;
        if let Some(plan) = existing.first() {
            if plan.status.is_terminal() {
                return Ok(false);
            }
            tracing::debug!(
                objective_id = ?active.as_ref().map(|item| item.objective_id.as_str()),
                evaluation_id,
                plan_id = %plan.id,
                status = plan.status.as_str(),
                event_code = "orchestrator.harness_entry.plan_active",
                "Harness entry Plan is not terminal; current Activation will not start duplicate model evaluation"
            );
            return Ok(true);
        }

        let response = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: tool_call_id,
                r#type: "function".to_string(),
                func_name: "eval".to_string(),
                arguments: serde_json::to_string(&json!({
                    "program": source,
                }))?,
            }],
        };
        tracing::info!(
            objective_id = ?active.as_ref().map(|item| item.objective_id.as_str()),
            evaluation_id,
            harness = %format!("{}@{}", binding.harness_id, binding.harness_version),
            event_code = "orchestrator.harness_entry.dispatched",
            "Runtime automatically dispatched the bound Harness eval entry"
        );
        self.execute_tool_calls(
            session_id,
            &activation.id,
            response,
            "harness-entry",
            ToolExecutionOptions {
                context_tx_allowed: false,
                wake_on_output: true,
                plan_execution_id: None,
                continuation_tool_calls: None,
                allowed_tool_names: HashSet::from(["eval".to_string()]),
                record_assistant_call: true,
                model_attempt_id: None,
                provider_continuation: None,
            },
        )
        .await?;
        Ok(true)
    }

    fn context_id_for_session(&self, session_id: &str) -> Result<String, DynError> {
        self.session_contexts
            .get(session_id)
            .map(|value| value.clone())
            .ok_or_else(|| format!("Session '{session_id}' 没有挂载 Cognitive Context").into())
    }

    fn cancellation_sender(&self, session_id: &str) -> watch::Sender<u64> {
        self.cancellation_epochs
            .entry(session_id.to_string())
            .or_insert_with(|| watch::channel(0).0)
            .clone()
    }

    fn active_counter(&self, session_id: &str) -> Arc<AtomicUsize> {
        self.active_session_turns
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
            .clone()
    }

    fn dialogue_thread_gate(&self, session_id: &str) -> Arc<DialogueThreadGate> {
        self.dialogue_thread_gates
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(DialogueThreadGate::default()))
            .clone()
    }

    fn thread_gate(&self, root_turn_id: &str) -> Arc<Mutex<()>> {
        // Gates are a single-process serialization aid, not durable Thread
        // state.  Keep the cache bounded: an entry whose Arc is owned only by
        // the map has no holder or waiter and can be recreated safely.  DashMap
        // retains a gate that a concurrent caller has already cloned.
        const MAX_CACHED_IDLE_THREAD_GATES: usize = 4_096;
        if self.thread_gates.len() >= MAX_CACHED_IDLE_THREAD_GATES {
            self.thread_gates
                .retain(|_, gate| Arc::strong_count(gate) > 1);
        }
        self.thread_gates
            .entry(root_turn_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn release_dialogue_thread(&self, session_id: &str, root_turn_id: &str) -> bool {
        let gate = self.dialogue_thread_gate(session_id);
        gate.release(root_turn_id)
    }

    /// Cancel only the Activation(s) bound to one persistent Objective
    /// Evaluation. This deliberately does not mutate Session cancellation
    /// state and therefore cannot suppress dialogue or sibling Objectives.
    pub async fn cancel_objective_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
    ) -> Result<bool, DynError> {
        let reason =
            format!("Objective '{objective_id}' Evaluation '{evaluation_id}' 已被暂停或取消");
        // The physical cancellation intent is durable before the in-memory
        // signal drops the model/Activation future. This ordering prevents a
        // fast cancellation from orphaning already-materialized Actions.
        let mut cancellation_error = None;
        for activation_id in self
            .objective_evaluations
            .activation_ids_for_evaluation(objective_id, evaluation_id)
        {
            if let Err(error) = self
                .request_cancel_execution_jobs_for_activation(&activation_id, &reason)
                .await
            {
                tracing::error!(
                    objective_id,
                    evaluation_id,
                    activation_id,
                    error = %error,
                event_code = "orchestrator.objective.execution_job_cancel_persist_failed",
                "Objective stopped scheduling but the physical Execution Job cancellation intent was not fully persisted"
                );
                if cancellation_error.is_none() {
                    cancellation_error = Some(error);
                }
            }
        }
        let was_running = self
            .objective_evaluations
            .cancel_evaluation(objective_id, evaluation_id);
        if let Some(error) = cancellation_error {
            return Err(error);
        }
        Ok(was_running)
    }

    /// Close every non-terminal Activation belonging to one exact logical
    /// Thread generation. The Thread row is fenced by the caller first; this
    /// method then propagates cancellation to process-local model futures and
    /// durable physical Actions without touching sibling Threads in the same
    /// Session.
    pub async fn cancel_thread_activations(
        &self,
        thread: &ThreadRecord,
        reason: &str,
    ) -> Result<usize, DynError> {
        let store = self
            .context_engine
            .session_store()
            .ok_or("Thread control 需要持久化 SessionStore")?;
        let activations = store
            .list_context_thread_activations(&thread.context_id, false)
            .await?
            .into_iter()
            .filter(|activation| {
                activation.root_turn_id == thread.root_turn_id
                    && activation.generation == thread.generation
            })
            .collect::<Vec<_>>();
        let mut cancelled = 0usize;
        for activation in activations {
            self.request_cancel_execution_jobs_for_activation(&activation.id, reason)
                .await?;
            self.activation_cancellations
                .request(&activation.id, reason);

            let mut current = activation;
            for _ in 0..8 {
                if current.status.is_terminal() {
                    break;
                }
                match self
                    .transition_thread_activation(
                        &current,
                        ThreadActivationStatus::Cancelled,
                        None,
                        None,
                        current.context_snapshot_version,
                        &thread.id,
                        "ThreadControl",
                    )
                    .await?
                {
                    ThreadActivationMutation::Updated(updated) => {
                        self.activation_admission.forget(&updated.id);
                        if let Err(error) = self.cancel_activation_lease(&updated.id).await {
                            tracing::warn!(event_code = "orchestrator.thread_close.activation_lease_cancel_failed", activation_id = %updated.id, %error, "Failed to cancel the Activation lease after closing the Thread");
                        }
                        cancelled = cancelled.saturating_add(1);
                        break;
                    }
                    ThreadActivationMutation::Conflict { current: changed }
                        if !changed.status.is_terminal() =>
                    {
                        current = changed;
                    }
                    ThreadActivationMutation::Conflict { .. }
                    | ThreadActivationMutation::NotFound => break,
                }
            }
        }
        if thread.kind == ThreadKind::DialogueTurn {
            self.release_dialogue_thread(&thread.session_id, &thread.root_turn_id)
                .await;
        }
        Ok(cancelled)
    }

    /// Wake the process-local future for a DialogueTurn that the ingress
    /// transaction has already fenced as cancelled. Persistent Thread and
    /// Activation state remain authoritative; this only removes model-call
    /// latency between the durable cancellation and task observation.
    pub fn notify_dialogue_interruption(&self, activation_id: &str) {
        self.activation_cancellations.request(
            activation_id,
            "A newer message replaced this DialogueTurn before Execution began",
        );
    }

    /// Resume scheduler admission for the oldest durable mailbox Signal. If
    /// the mailbox is empty this is intentionally a no-op.
    pub async fn wake_resumed_thread(&self, root_turn_id: &str) -> Result<(), DynError> {
        self.dispatch_next_pending_thread_signal(root_turn_id).await
    }

    /// Replays the live half of a terminal Thread/Group handoff whose Event
    /// and optional direct Signal are already durable. This is safe after an
    /// operator close and after an idempotent outcome retry: EventBus and
    /// Thread Signal claims both de-duplicate the exact persisted fact.
    pub async fn wake_terminal_thread_supervisor(
        &self,
        thread: &ThreadRecord,
    ) -> Result<(), DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("终态 Thread 交接需要持久化 SessionStore")?;
        let (supervisor_kind, supervisor_id, parent_thread_id, barrier_event_id) =
            if let Some(group_id) = thread.supervision.thread_group_id.as_deref() {
                let group = session_store
                    .get_thread_group(group_id)
                    .await?
                    .ok_or_else(|| {
                        format!("Thread '{}' 的终态 Group '{}' 不存在", thread.id, group_id)
                    })?;
                if !group.status.is_terminal() {
                    return Ok(());
                }
                let barrier_event_id = group.barrier_event_id.clone().ok_or_else(|| {
                    format!("终态 Thread Group '{}' 缺少 barrier Event", group.id)
                })?;
                (
                    group.supervisor_kind,
                    Some(group.supervisor_id),
                    thread.supervision.parent_thread_id.clone(),
                    barrier_event_id,
                )
            } else {
                (
                    thread.supervision.supervisor_kind,
                    thread.supervision.supervisor_id.clone(),
                    thread.supervision.parent_thread_id.clone(),
                    format!("thread_terminal_{}_g{}", thread.id, thread.generation),
                )
            };

        match supervisor_kind {
            ThreadSupervisorKind::Thread | ThreadSupervisorKind::Evaluation => {
                let parent_thread_id = parent_thread_id
                    .or(supervisor_id)
                    .ok_or_else(|| format!("Thread '{}' 缺少 parent Thread", thread.id))?;
                let parent = session_store
                    .get_thread(&parent_thread_id)
                    .await?
                    .ok_or_else(|| format!("Parent Thread '{}' 不存在", parent_thread_id))?;
                if parent.lifecycle == ThreadLifecycle::Open {
                    self.dispatch_next_pending_thread_signal(&parent.root_turn_id)
                        .await?;
                }
            }
            ThreadSupervisorKind::Objective | ThreadSupervisorKind::Runtime => {
                let barrier = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(barrier_event_id.clone()),
                        context_id: Some(thread.context_id.clone()),
                        ..Default::default()
                    })
                    .await?
                    .into_iter()
                    .find(|candidate| candidate.id == barrier_event_id)
                    .ok_or_else(|| {
                        format!(
                            "Thread '{}' 的 Supervisor barrier Event '{}' 不存在",
                            thread.id, barrier_event_id
                        )
                    })?;
                self.bus.dispatch_persisted(barrier).await?;
            }
            ThreadSupervisorKind::None | ThreadSupervisorKind::Legacy => {}
        }
        Ok(())
    }

    /// Persist cancellation intent for every non-terminal physical Action
    /// materialized by one Activation. Jobs that have not crossed the side-
    /// effect boundary are closed immediately with a deterministic cancelled
    /// Event; running work remains owned by its executor until physical exit.
    async fn request_cancel_execution_jobs_for_activation(
        &self,
        activation_id: &str,
        reason: &str,
    ) -> Result<usize, DynError> {
        let Some(manager) = self.execution_jobs.as_ref() else {
            return Ok(0);
        };
        let jobs = manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                activation_id: Some(activation_id.to_string()),
                include_terminal: false,
                ..Default::default()
            })
            .await?;
        let mut requested = 0usize;
        for job in jobs {
            let job_id = job.id.clone();
            let mut current = job;
            let mut settled = false;
            for _ in 0..16 {
                match manager
                    .request_cancel(&job_id, current.revision, Some(reason))
                    .await?
                {
                    JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => {
                        current = job;
                    }
                    JobReceipt::Conflict {
                        current: changed, ..
                    } if !changed.status.is_terminal() => {
                        current = changed;
                        continue;
                    }
                    JobReceipt::Conflict { .. }
                    | JobReceipt::Rejected { .. }
                    | JobReceipt::NotFound { .. } => {
                        // A concurrent executor may have committed the real
                        // terminal fact before this control request won CAS.
                        settled = true;
                        break;
                    }
                }

                requested = requested.saturating_add(1);
                if matches!(
                    current.status,
                    ExecutionJobStatus::Queued | ExecutionJobStatus::WaitingApproval
                ) && current.side_effect_started_at.is_none()
                {
                    self.cancel_pending_approval_for_job(&current, reason)
                        .await?;
                    let output = unstarted_cancelled_tool_output(&current, reason);
                    match manager
                        .finish_with_event(
                            &current.id,
                            current.revision,
                            None,
                            JobOutcome::Cancelled {
                                result_event_id: Some(output.id.clone()),
                                result_refs: Vec::new(),
                                reason: Some(reason.to_string()),
                                exit_code: None,
                            },
                            &output,
                            false,
                        )
                        .await?
                    {
                        JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => {
                            settled = true;
                            break;
                        }
                        JobReceipt::Conflict {
                            current: changed, ..
                        } if !changed.status.is_terminal() => {
                            current = changed;
                            continue;
                        }
                        JobReceipt::Conflict { .. }
                        | JobReceipt::Rejected { .. }
                        | JobReceipt::NotFound { .. } => {
                            settled = true;
                            break;
                        }
                    }
                }
                settled = true;
                break;
            }
            if !settled {
                return Err(format!(
                    "Execution Job '{job_id}' 在连续 revision 竞争下未能持久化取消请求"
                )
                .into());
            }
        }
        if let Some(scheduler) = self.background_scheduler.as_ref() {
            scheduler
                .cancel_live_tasks_for_activation(activation_id, reason)
                .await?;
        }
        Ok(requested)
    }

    async fn cancel_pending_approval_for_job(
        &self,
        job: &ExecutionJobRecord,
        reason: &str,
    ) -> Result<(), DynError> {
        let Some(services) = self.durable_approvals.as_ref() else {
            return Ok(());
        };
        let approvals = services
            .approvals
            .list_approvals(ApprovalFilter {
                job_id: Some(job.id.clone()),
                pending_only: false,
                limit: Some(2),
                ..Default::default()
            })
            .await?;
        for approval in approvals {
            let approval_id = approval.id.clone();
            let mut current = approval;
            let mut settled = false;
            for _ in 0..16 {
                let cancellable = current.status.is_pending()
                    || (current.status == ApprovalStatus::Allowed
                        && current.grant_consumed_at.is_none());
                if !cancellable {
                    settled = true;
                    break;
                }
                let commit = services
                    .approvals
                    .commit_approval_cancellation(&current.id, current.revision, reason)
                    .await?;
                match commit.mutation {
                    ApprovalMutation::Updated(cancelled)
                    | ApprovalMutation::Existing(cancelled) => {
                        // Durable authority changes first. Only then wake and
                        // remove the process-local waiter.
                        let decision = ApprovalDecision::Deny {
                            rationale: cancelled
                                .cancel_reason
                                .clone()
                                .unwrap_or_else(|| reason.to_string()),
                            risk_tags: vec!["runtime-cancelled".to_string()],
                        };
                        if let Err(error) = services
                            .human_approval_hub
                            .notify_decision(&cancelled.id, decision)
                        {
                            tracing::warn!(event_code = "orchestrator.approval.cancel_waiter_notify_failed", approval_id = %cancelled.id, %error, "Approval cancellation was persisted but the in-process waiter could not be notified");
                        }
                        if commit.event_created {
                            let event = commit.event.ok_or(
                                "Approval 审计 Event 已原子创建，但 Store 未返回持久化投影",
                            )?;
                            self.bus.dispatch_persisted(event).await?;
                        }
                        settled = true;
                        break;
                    }
                    ApprovalMutation::Conflict {
                        current: changed, ..
                    } => current = changed,
                    ApprovalMutation::Rejected { .. } | ApprovalMutation::NotFound => {
                        settled = true;
                        break;
                    }
                    ApprovalMutation::Created(_) => {
                        return Err("Approval cancel 返回了不可能的 Created 状态".into());
                    }
                }
            }
            if !settled {
                return Err(
                    format!("Approval '{approval_id}' 在连续 revision 竞争下未能取消").into(),
                );
            }
        }
        Ok(())
    }

    /// Cancels attempts already running or queued for this Session. Later tool
    /// completions stay suppressed until a new explicit user message resumes it.
    pub fn cancel_session(&self, session_id: &str) -> bool {
        let active = self
            .active_session_turns
            .get(session_id)
            .is_some_and(|value| value.load(Ordering::SeqCst) > 0);
        self.cancelled_at.insert(session_id.to_string(), Utc::now());
        let sender = self.cancellation_sender(session_id);
        let next = (*sender.borrow()).wrapping_add(1);
        sender.send_replace(next);
        active
    }

    pub fn resume_session(&self, session_id: &str) {
        self.cancelled_at.remove(session_id);
    }

    pub async fn get_current_context(
        &self,
        session_id: &str,
    ) -> Result<crate::sexpr::SExpr, DynError> {
        let view = self.get_current_context_view(session_id).await?;
        Ok(crate::sexpr::parse(&view.sexpr)?)
    }

    async fn restore_prompt_pressure_measurement(
        &self,
        view: &mut ContextView,
    ) -> Result<(), DynError> {
        let key = (view.context_id.clone(), view.active_session_id.clone());
        let measurement = match self.prompt_pressure_measurements.get(&key) {
            Some(measurement) => Some(measurement.clone()),
            None => {
                let events = self
                    .store
                    .query(QueryFilter {
                        context_id: Some(view.context_id.clone()),
                        session_id: Some(view.active_session_id.clone()),
                        topic: Some("runtime/model_attempt_state".to_string()),
                        latest_k: Some(32),
                        ..Default::default()
                    })
                    .await?;
                events
                    .iter()
                    .rev()
                    .find_map(prompt_pressure_measurement_from_event)
                    .inspect(|measurement| {
                        self.prompt_pressure_measurements
                            .insert(key.clone(), measurement.clone());
                    })
            }
        };
        let Some(measurement) = measurement else {
            return Ok(());
        };
        if measurement.context_version != view.state.version {
            return Ok(());
        }
        self.context_engine
            .apply_prompt_token_count(view, &measurement.count)
            .await
    }

    pub async fn get_current_context_view(
        &self,
        session_id: &str,
    ) -> Result<ContextView, DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut view = self
            .context_engine
            .build_context_encoding(&context_id, session_id, &HashSet::new())
            .await?;
        self.restore_prompt_pressure_measurement(&mut view).await?;
        Ok(view)
    }

    pub async fn get_context_encoding(
        &self,
        context_id: &str,
        active_session_id: &str,
    ) -> Result<ContextView, DynError> {
        self.session_contexts
            .insert(active_session_id.to_string(), context_id.to_string());
        let mut view = self
            .context_engine
            .build_context_encoding(context_id, active_session_id, &HashSet::new())
            .await?;
        self.restore_prompt_pressure_measurement(&mut view).await?;
        Ok(view)
    }

    pub async fn get_context_projection(
        &self,
        context_id: &str,
        active_session_id: &str,
    ) -> Result<ContextView, DynError> {
        self.session_contexts
            .insert(active_session_id.to_string(), context_id.to_string());
        let mut view = self
            .context_engine
            .build_context_projection(context_id, active_session_id, &HashSet::new())
            .await?;
        self.restore_prompt_pressure_measurement(&mut view).await?;
        Ok(view)
    }

    pub async fn seed_context_from_mind(
        &self,
        source_context_id: &str,
        source_version: Option<u64>,
        target_context_id: &str,
    ) -> Result<crate::orchestrator::context::MindSeedReceipt, DynError> {
        self.context_engine
            .seed_context_from_mind(source_context_id, source_version, target_context_id)
            .await
    }

    pub async fn mind_version(&self, context_id: &str) -> Result<u64, DynError> {
        self.context_engine.mind_version(context_id).await
    }

    pub async fn audit_mind_projection(
        &self,
        context_id: &str,
    ) -> Result<crate::orchestrator::context::MindProjectionAudit, DynError> {
        self.context_engine.audit_mind_projection(context_id).await
    }

    pub async fn import_session_projection(
        &self,
        source_context_id: &str,
        source_session_id: &str,
        target_context_id: &str,
        target_session_id: &str,
    ) -> Result<usize, DynError> {
        self.context_engine
            .import_session_projection(
                source_context_id,
                source_session_id,
                target_context_id,
                target_session_id,
            )
            .await
    }

    pub fn register_session_context(&self, session_id: &str, context_id: &str) {
        self.session_contexts
            .insert(session_id.to_string(), context_id.to_string());
    }
}

fn recovery_owns_activation(
    mode: crate::memory::WorkerCoordinationMode,
    activation: &ThreadActivationRecord,
    now: chrono::DateTime<Utc>,
) -> bool {
    match mode {
        crate::memory::WorkerCoordinationMode::ExclusiveProcess => true,
        crate::memory::WorkerCoordinationMode::SharedHostLeases => {
            activation.status == ThreadActivationStatus::Running
                && (activation
                    .lease_expires_at
                    .is_none_or(|expires_at| expires_at <= now)
                    || runtime_claimant_is_definitely_dead(activation.claimed_by.as_deref()))
        }
        crate::memory::WorkerCoordinationMode::SharedLeases => {
            activation.status == ThreadActivationStatus::Running
                && activation
                    .lease_expires_at
                    .is_none_or(|expires_at| expires_at <= now)
        }
    }
}

async fn durable_activation_revocation_reason(
    store: &dyn SessionStore,
    activation_id: &str,
    runtime_claimant_id: &str,
) -> Result<Option<String>, DynError> {
    let Some(current) = store.get_thread_activation(activation_id).await? else {
        return Ok(Some(format!(
            "Activation '{activation_id}' no longer exists in durable state"
        )));
    };
    if current.status != ThreadActivationStatus::Running {
        return Ok(Some(format!(
            "Activation '{activation_id}' durable status changed to {}",
            current.status.as_str()
        )));
    }
    if current.claimed_by.as_deref() != Some(runtime_claimant_id) {
        return Ok(Some(format!(
            "Activation '{activation_id}' durable ownership moved from Runtime '{runtime_claimant_id}' to '{}'",
            current.claimed_by.as_deref().unwrap_or("unclaimed")
        )));
    }
    Ok(None)
}

fn delivery_flush_timer_id(session_id: &str) -> String {
    let digest = Sha256::digest(format!("delivery-flush:{session_id}").as_bytes());
    format!("delivery-flush:{digest:x}")
}

fn delivery_flush_event_id(timer_id: &str, generation: u64) -> String {
    let digest = Sha256::digest(format!("{timer_id}:{generation}").as_bytes());
    format!("delivery_ready_{digest:x}")
}

fn delivery_flush_reply_event_id(timer_id: &str, generation: u64) -> String {
    let digest = Sha256::digest(format!("delivery-reply:{timer_id}:{generation}").as_bytes());
    format!("delivery_reply_{digest:x}")
}

fn delivery_flush_timestamp(timer: &RuntimeTimerRecord) -> chrono::DateTime<Utc> {
    timer
        .payload
        .get("latest_pending_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .unwrap_or(timer.created_at)
}

fn activation_admission_key(activation: &ThreadActivationRecord, trigger: &Event) -> AdmissionKey {
    activation_admission_key_for_class(activation, activation_admission_class(trigger))
}

fn activation_admission_class(trigger: &Event) -> AdmissionClass {
    if trigger.event_type == TYPE_USER_MESSAGE {
        AdmissionClass::InteractiveControl
    } else if trigger.topic == "chat/thread_completion_ready" {
        AdmissionClass::Delivery
    } else if trigger.payload.get("objective_id").is_some()
        || trigger.payload.get("objective_evaluation_id").is_some()
        || trigger.topic.starts_with("objective/")
    {
        AdmissionClass::Objective
    } else if trigger
        .payload
        .get("runtime_maintenance")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || matches!(
            trigger.topic.as_str(),
            "runtime/context_maintenance" | "chat/context_maintenance"
        )
    {
        AdmissionClass::Maintenance
    } else if trigger.topic == "chat/schedule_due" || trigger.payload.get("schedule_id").is_some() {
        AdmissionClass::ScheduledBackground
    } else {
        // Ordinary tool/background wakes are not interactive merely because
        // they eventually deliver to a Session. Their completed result enters
        // the Delivery Router; only complex batches use the reserved Composer lane.
        AdmissionClass::ScheduledBackground
    }
}

fn activation_admission_key_for_class(
    activation: &ThreadActivationRecord,
    class: AdmissionClass,
) -> AdmissionKey {
    AdmissionKey::new(
        activation.id.clone(),
        activation.agent_id.clone(),
        activation.context_id.clone(),
        activation.session_id.clone(),
        class,
        activation.created_at.timestamp_millis(),
    )
}

fn event_contains_physical_tool_plan(event: &Event) -> bool {
    let calls = if event.topic == "chat/assistant_call" {
        event.payload.get("tool_calls")
    } else if event.topic == "runtime/tool_calls_selected" {
        event.payload.get("calls")
    } else {
        None
    };
    calls
        .and_then(|value| value.as_array())
        .is_some_and(|calls| {
            calls.iter().any(|call| {
                let name = call
                    .get("name")
                    .and_then(|value| value.as_str())
                    .or_else(|| {
                        call.get("function")
                            .and_then(|value| value.get("name"))
                            .and_then(|value| value.as_str())
                    });
                name.is_some_and(|name| name != "context_tx" && name != "no_reply")
            })
        })
}

/// A persisted lease is meaningful only while its owning Runtime is alive.
/// Unknown/non-local claimant formats deliberately return false so recovery
/// falls back to the normal lease timeout instead of stealing work.
fn activation_lease_timer_id(activation_id: &str) -> String {
    format!("activation-lease:{activation_id}")
}

fn runtime_claimant_is_definitely_dead(claimed_by: Option<&str>) -> bool {
    let Some(raw_claimant) = claimed_by.and_then(|value| value.strip_prefix("runtime:")) else {
        return false;
    };
    let raw_pid = raw_claimant.split(':').next().unwrap_or(raw_claimant);
    let Ok(raw_pid) = raw_pid.parse::<i32>() else {
        return false;
    };
    if raw_pid <= 0 {
        return false;
    }
    if raw_pid == i32::try_from(std::process::id()).unwrap_or(-1) {
        // One host process may embed multiple live Runtime instances. A
        // different nonce under our PID is therefore not proof of death; the
        // durable expiry clock remains the safe takeover boundary.
        return false;
    }
    #[cfg(unix)]
    {
        matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw_pid), None),
            Err(nix::errno::Errno::ESRCH)
        )
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Unique fencing identity for one Runtime instance. The sequence handles
/// multiple builders in one process; the time component also distinguishes a
/// newly-started process if the operating system reuses its PID.
fn new_runtime_claimant_id() -> String {
    static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(0);
    let mut random = [0_u8; 16];
    let nonce = if getrandom::fill(&mut random).is_ok() {
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos().to_string())
            .unwrap_or_default()
    };
    let sequence = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
    format!("runtime:{}:{nonce}:{sequence}", std::process::id())
}

fn prompt_pressure_measurement_from_event(event: &Event) -> Option<PromptPressureMeasurement> {
    let pressure = event.payload.get("pressure")?;
    if pressure.get("token_scope")?.as_str()? != "full-work-prompt" {
        return None;
    }
    let context_version = event.payload.get("context_snapshot_version")?.as_u64()?;
    let tokens = usize::try_from(pressure.get("estimated_tokens")?.as_u64()?).ok()?;
    let source = pressure.get("token_source")?.as_str()?.to_string();
    let model = pressure.get("token_model")?.as_str()?.to_string();
    let accuracy = match pressure.get("token_accuracy")?.as_str()? {
        "exact" => PromptTokenAccuracy::Exact,
        "local-tokenizer-estimate" => PromptTokenAccuracy::LocalTokenizerEstimate,
        "usage-calibrated-estimate" => PromptTokenAccuracy::UsageCalibratedEstimate,
        _ => PromptTokenAccuracy::HeuristicEstimate,
    };
    Some(PromptPressureMeasurement {
        count: PromptTokenCount {
            tokens,
            source,
            model,
            accuracy,
            base_estimate_tokens: tokens,
            calibration_key: None,
            calibration_shape: None,
        },
        context_version,
    })
}

/// Carries an `infer` back to the model the way an ordinary turn goes.
///
/// It deliberately holds no model client of its own: routing through the
/// Orchestrator is what makes `infer` inherit provider admission, queueing and
/// the attempt deadline instead of quietly opening a second, ungoverned channel.
struct OrchestratorInference {
    orchestrator: std::sync::Weak<Orchestrator>,
    session_id: String,
    attempt_id: String,
}

struct OrchestratorPlanExecutor {
    orchestrator: std::sync::Weak<Orchestrator>,
    route: PlanExecutionRoute,
}

#[async_trait::async_trait]
impl crate::sexpr_eval::RuntimePlanExecutor for OrchestratorPlanExecutor {
    async fn execute_plan(
        &self,
        program: crate::sexpr_eval::Program,
    ) -> PlanExecutionResult<serde_json::Value> {
        self.orchestrator
            .upgrade()
            .ok_or("Runtime 已关闭，无法继续 PlanExecution")?
            .execute_durable_plan(self.route.clone(), program)
            .await
    }
}

struct OrchestratorPlanCallPlanner {
    orchestrator: std::sync::Weak<Orchestrator>,
}

#[async_trait::async_trait]
impl PlanCallPlanner for OrchestratorPlanCallPlanner {
    async fn plan_call(
        &self,
        plan: &PlanExecutionRecord,
        effect: &crate::sexpr_eval::PlanEffect,
        effect_tool_call_id: &str,
    ) -> PlanExecutionResult<NewExecutionJob> {
        self.orchestrator
            .upgrade()
            .ok_or("Runtime 已关闭，无法规划 Yao call")?
            .plan_execution_job(plan, effect, effect_tool_call_id)
            .await
    }
}

fn plan_from_resume(receipt: PlanResumeReceipt) -> PlanExecutionResult<PlanExecutionRecord> {
    match receipt {
        PlanResumeReceipt::Queued(plan) | PlanResumeReceipt::Existing(plan) => Ok(plan),
        PlanResumeReceipt::Conflict {
            current: Some(current),
            ..
        } => Ok(current),
        PlanResumeReceipt::Conflict {
            current: None,
            reason,
        } => Err(reason.into()),
    }
}

#[async_trait::async_trait]
impl crate::sexpr_eval::RuntimeInference for OrchestratorInference {
    async fn infer(
        &self,
        request: &serde_json::Map<String, serde_json::Value>,
        declared: Option<&[String]>,
    ) -> Result<String, DynError> {
        let orchestrator = self
            .orchestrator
            .upgrade()
            .ok_or("The Runtime has shut down and cannot complete infer")?;
        let task = request
            .get("task")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let mut evidence = serde_json::Map::new();
        for (key, value) in request {
            if key != "task" {
                evidence.insert(key.clone(), value.clone());
            }
        }
        let mut messages = vec![Message {
            role: "user".to_string(),
            content: format!(
                "This is not a user message. It is a decision requested when your submitted program paused at (infer ...).\
                 You may call tools first if you need more evidence. Once you return text without any tool call,\
                 that text becomes the value of this step, is bound, and is returned to the program for continued evaluation.\
                 Therefore, do not write it as a message addressed to the user.\n\
                 (infer-request\n  (task {task:?})\n  (evidence {}))",
                serde_json::to_string(&serde_json::Value::Object(evidence.clone()))
                    .unwrap_or_else(|_| "{}".to_string())
            ),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];
        let context_id = orchestrator.context_id_for_session(&self.session_id)?;
        let stored = orchestrator
            .resolve_model_visible_attachment_metadata(
                &context_id,
                &serde_json::Value::Object(evidence.clone()),
            )
            .await?;
        if let Some(message) = crate::model_input::attachment_message_from_metadata(
            &orchestrator.message_attachment_root,
            &stored,
            orchestrator.model_input_config.request_limits(),
        )
        .await?
        {
            messages.push(message);
        }
        // `eval` is absent from this set, and that omission is what keeps the
        // language total: it severs `eval -> infer -> eval`, so nesting stops
        // at one level and a submitted program stays statically bounded. What
        // remains is the same read-only gate the evaluator applies to `call`,
        // so one policy governs both rather than two that can drift.
        // The deployment gate is the outer bound; a program's declaration can
        // only narrow it further. Both cuts are applied here so the model is
        // never shown a tool that execution below would refuse.
        let callable = orchestrator
            .orchestrator_config
            .eval_callable_tools
            .iter()
            .filter(|name| declared.is_none_or(|list| list.iter().any(|tool| tool == *name)))
            .cloned()
            .collect::<Vec<_>>();
        let tools = orchestrator
            .registry
            .definitions()
            .into_iter()
            .filter(|definition| callable.contains(&definition.name))
            .collect::<Vec<_>>();

        for round in 0..crate::sexpr_eval::MAX_INFER_ROUNDS {
            let ModelCompletion {
                response,
                provider_continuation,
            } = orchestrator
                .request_model_completion(
                    &self.session_id,
                    &self.attempt_id,
                    messages.clone(),
                    tools.clone(),
                    None,
                )
                .await
                .map_err(|error| -> DynError { Box::new(error) })?;
            // Answering without calling a tool is what yields the value. The
            // `reply` contract is deliberately not reused: it means "send this
            // to the user", and what is waiting here is a program.
            if response.tool_calls.is_empty() {
                return Ok(response.content);
            }
            if round + 1 == crate::sexpr_eval::MAX_INFER_ROUNDS {
                return Err(format!(
                    "infer 连续 {} 轮只调用工具而没有给出值；请缩小 :task，或先用 call 取好证据再 infer",
                    crate::sexpr_eval::MAX_INFER_ROUNDS
                )
                .into());
            }
            if let Some(provider_continuation) = provider_continuation {
                messages.push(provider_continuation_message(provider_continuation)?);
            }
            messages.push(Message {
                role: "assistant".to_string(),
                content: response.content.clone(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(
                    response
                        .tool_calls
                        .iter()
                        .map(|call| crate::llm::ToolCall {
                            id: call.id.clone(),
                            r#type: call.r#type.clone(),
                            function: crate::llm::FunctionCall {
                                name: call.func_name.clone(),
                                arguments: call.arguments.clone(),
                            },
                        })
                        .collect(),
                ),
            });
            for call in &response.tool_calls {
                // Run through the Registry so each tool keeps its own jail and
                // path checks. Anything outside the gate is refused rather than
                // executed, exactly as a `call` node would be.
                let outcome = match orchestrator.registry.get(&call.func_name) {
                    Some(tool) if callable.contains(&call.func_name) => tool
                        .execute_result(&call.arguments)
                        .await
                        .unwrap_or_else(|error| {
                            crate::tool::ToolExecutionResult::text(format!("执行失败: {error}"))
                        }),
                    _ => crate::tool::ToolExecutionResult::text(format!(
                        "执行拒绝: 工具 '{}' 不能在 infer 中调用",
                        call.func_name
                    )),
                };
                messages.push(Message {
                    role: "tool".to_string(),
                    content: outcome.text,
                    name: Some(call.func_name.clone()),
                    tool_call_id: Some(call.id.clone()),
                    tool_calls: None,
                });
                if !outcome.model_attachments.is_empty() {
                    messages.push(attachment_message(outcome.model_attachments)?);
                }
            }
        }
        Err("infer 未能在预算内产出值".into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ModelVisibleAttachmentReference {
    id: String,
    sha256: String,
    source_event_id: String,
}

fn model_visible_attachment_references(
    value: &serde_json::Value,
) -> Vec<ModelVisibleAttachmentReference> {
    fn visit(
        value: &serde_json::Value,
        seen: &mut HashSet<ModelVisibleAttachmentReference>,
        output: &mut Vec<ModelVisibleAttachmentReference>,
    ) {
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    visit(item, seen, output);
                }
            }
            serde_json::Value::Object(object) => {
                if let (Some(id), Some(sha256), Some(source_event_id)) = (
                    object.get("id").and_then(serde_json::Value::as_str),
                    object.get("sha256").and_then(serde_json::Value::as_str),
                    object
                        .get("source_event_id")
                        .and_then(serde_json::Value::as_str),
                ) {
                    let reference = ModelVisibleAttachmentReference {
                        id: id.to_string(),
                        sha256: sha256.to_string(),
                        source_event_id: source_event_id.to_string(),
                    };
                    if seen.insert(reference.clone()) {
                        output.push(reference);
                    }
                }
                for child in object.values() {
                    visit(child, seen, output);
                }
            }
            _ => {}
        }
    }

    let mut seen = HashSet::new();
    let mut output = Vec::new();
    visit(value, &mut seen, &mut output);
    output
}

fn context_tx_output_succeeded(event: &Event) -> bool {
    if event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        != Some("context_tx")
    {
        return false;
    }
    event
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .is_some_and(|value| {
            value.get("status").and_then(|status| status.as_str()) == Some("committed")
        })
}

fn infer_tool_status(text: &str) -> &'static str {
    if text.starts_with("执行失败:")
        || text.starts_with("系统报错:")
        || text.starts_with("系统报错：")
    {
        "error"
    } else if text.starts_with("执行超时:") {
        "timeout"
    } else if text.starts_with("执行拒绝:") {
        "rejected"
    } else {
        "success"
    }
}

fn approval_request_event(
    job: &NewExecutionJob,
    approval: &NewApprovalRequest,
    attempt_id: &str,
    route: &ActivationRoute,
) -> Event {
    let mut payload = serde_json::Map::from_iter([
        ("approval_id".to_string(), json!(approval.id)),
        ("job_id".to_string(), json!(job.id)),
        ("request_digest".to_string(), json!(approval.request_digest)),
        ("policy_digest".to_string(), json!(approval.policy_digest)),
        ("activation_id".to_string(), json!(job.activation_id)),
        ("thread_id".to_string(), json!(job.thread_id)),
        ("context_id".to_string(), json!(job.context_id)),
        ("session_id".to_string(), json!(job.session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("tool_call_id".to_string(), json!(job.tool_call_id)),
        ("tool_name".to_string(), json!(job.tool_name)),
        ("target_id".to_string(), json!(job.target_id)),
        ("action".to_string(), approval.action.clone()),
        ("requested".to_string(), approval.requested.clone()),
        ("justification".to_string(), json!(approval.justification)),
        ("root_turn_id".to_string(), json!(route.root_turn_id)),
        (
            "trigger_event_id".to_string(),
            json!(route.trigger_event_id),
        ),
        (
            "trigger_sequence".to_string(),
            json!(route.trigger_sequence),
        ),
        (
            "text".to_string(),
            json!(format!(
                "审批请求 {} 正在等待决定：{}",
                approval.id, approval.justification
            )),
        ),
    ]);
    if let Some(principal_id) = &route.initiating_principal_id {
        payload.insert("principal_id".to_string(), json!(principal_id));
    }
    stamp_execution_route_facts(&mut payload, &job.target_id, &job.request, None);
    Event::new(
        format!("approval_requested_{}", approval.id),
        "System-ApprovalAuthority".to_string(),
        "approval_requested".to_string(),
        "runtime/approval_requested".to_string(),
        payload,
    )
}

fn approval_denied_tool_output(
    output_id: &str,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    call: &crate::llm::ToolCallRepr,
    route: &ActivationRoute,
    approval: &ApprovalRecord,
) -> Event {
    let reason = approval
        .rationale
        .as_deref()
        .or(approval.cancel_reason.as_deref())
        .unwrap_or("未提供理由");
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("tool_call_id".to_string(), json!(call.id)),
        ("caused_by".to_string(), json!(call.id)),
        ("tool_name".to_string(), json!(call.func_name)),
        ("tool_status".to_string(), json!("rejected")),
        ("executed".to_string(), json!(false)),
        ("wake_policy".to_string(), json!("immediate")),
        ("approval_id".to_string(), json!(approval.id)),
        (
            "approval_status".to_string(),
            json!(approval.status.as_str()),
        ),
        ("thread_id".to_string(), json!(route.thread_id)),
        ("activation_id".to_string(), json!(route.activation_id)),
        ("root_turn_id".to_string(), json!(route.root_turn_id)),
        (
            "text".to_string(),
            json!(format!("执行拒绝: 权限审批未授权本次操作: {reason}")),
        ),
    ]);
    if let Some(principal_id) = &route.initiating_principal_id {
        payload.insert("principal_id".to_string(), json!(principal_id));
    }
    Event::new(
        output_id.to_string(),
        "System-ApprovalAuthority".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        payload,
    )
}

#[allow(clippy::too_many_arguments)]
fn physical_execution_preflight_rejected_tool_output(
    output_id: &str,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    call: &crate::llm::ToolCallRepr,
    route: &ActivationRoute,
    action_group_id: Option<&str>,
    error: &(dyn std::error::Error + Send + Sync),
) -> Event {
    let error = error.to_string();
    let protected_path = error.contains("protected_paths");
    let rejection_code = if protected_path {
        "PROTECTED_PATH"
    } else {
        "EXECUTION_PREFLIGHT_REJECTED"
    };
    let guidance = if protected_path {
        "该路径受 Runtime protected_paths 保护，不能通过重复 require_escalated 覆盖。请改用不读取受保护路径的方案，或明确告知用户需要修改 Runtime 权限配置。"
    } else {
        "请根据预检错误修正工具参数或权限申请；不要原样重复同一次调用。"
    };
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("tool_call_id".to_string(), json!(call.id)),
        ("caused_by".to_string(), json!(call.id)),
        ("tool_name".to_string(), json!(call.func_name)),
        ("tool_status".to_string(), json!("rejected")),
        ("executed".to_string(), json!(false)),
        ("wake_policy".to_string(), json!("immediate")),
        ("output_empty".to_string(), json!(false)),
        ("rejection_code".to_string(), json!(rejection_code)),
        ("preflight_stage".to_string(), json!("approval_requirement")),
        ("retryable_unchanged".to_string(), json!(false)),
        ("error".to_string(), json!(error)),
        ("guidance".to_string(), json!(guidance)),
        ("thread_id".to_string(), json!(route.thread_id)),
        ("activation_id".to_string(), json!(route.activation_id)),
        ("root_turn_id".to_string(), json!(route.root_turn_id)),
        (
            "trigger_event_id".to_string(),
            json!(route.trigger_event_id),
        ),
        (
            "trigger_sequence".to_string(),
            json!(route.trigger_sequence),
        ),
        (
            "text".to_string(),
            json!(format!(
                "执行拒绝: 工具 '{}' 未开始执行；Runtime 权限预检失败（{}）：{}\n处理建议：{}",
                call.func_name, rejection_code, error, guidance
            )),
        ),
    ]);
    if let Some(principal_id) = &route.initiating_principal_id {
        payload.insert("principal_id".to_string(), json!(principal_id));
    }
    if let Some(version) = route.context_snapshot_version {
        payload.insert("context_snapshot_version".to_string(), json!(version));
    }
    if let Some(group_id) = action_group_id {
        payload.insert("action_group_id".to_string(), json!(group_id));
    }
    Event::new(
        output_id.to_string(),
        "Runtime-ExecutionPreflight".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        payload,
    )
}

fn execution_approval_records(
    mutation: ExecutionApprovalMutation,
    operation: &str,
) -> Result<(ExecutionJobRecord, ApprovalRecord, bool), DynError> {
    match mutation {
        ExecutionApprovalMutation::Created { job, approval } => Ok((job, approval, true)),
        ExecutionApprovalMutation::Updated { job, approval } => Ok((job, approval, false)),
        ExecutionApprovalMutation::Existing { job, approval } => Ok((job, approval, false)),
        ExecutionApprovalMutation::Conflict {
            job,
            approval,
            reason,
        }
        | ExecutionApprovalMutation::Rejected {
            job,
            approval,
            reason,
        } => Err(format!(
            "Execution/Approval 在 {operation} 时被拒绝: {reason} (job={:?}, approval={:?})",
            job.as_ref()
                .map(|record| (&record.id, record.revision, record.status)),
            approval
                .as_ref()
                .map(|record| (&record.id, record.revision, record.status))
        )
        .into()),
        ExecutionApprovalMutation::NotFound => {
            Err(format!("Execution/Approval 在 {operation} 时不存在").into())
        }
    }
}

fn approval_record_from_mutation(
    mutation: ApprovalMutation,
    operation: &str,
) -> Result<(ApprovalRecord, bool), DynError> {
    match mutation {
        ApprovalMutation::Created(record) | ApprovalMutation::Updated(record) => Ok((record, true)),
        ApprovalMutation::Existing(record) => Ok((record, false)),
        ApprovalMutation::Conflict { current, reason }
        | ApprovalMutation::Rejected { current, reason } => Err(format!(
            "Approval '{}' 在 {operation} 时被拒绝（r{} / {}）: {reason}",
            current.id,
            current.revision,
            current.status.as_str()
        )
        .into()),
        ApprovalMutation::NotFound => Err(format!("Approval 在 {operation} 时不存在").into()),
    }
}

fn applied_execution_job(
    receipt: JobReceipt,
    operation: &str,
) -> Result<ExecutionJobRecord, DynError> {
    match receipt {
        JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => Ok(job),
        JobReceipt::Conflict { current, .. } => Err(format!(
            "Execution Job '{}' 在 {operation} 时发生 revision 冲突（当前 r{} / {}）",
            current.id,
            current.revision,
            current.status.as_str()
        )
        .into()),
        JobReceipt::Rejected {
            current, reason, ..
        } => Err(format!(
            "Execution Job '{}' 在 {operation} 时被拒绝（{}）：{reason}",
            current.id,
            current.status.as_str()
        )
        .into()),
        JobReceipt::NotFound { .. } => Err(format!("Execution Job 在 {operation} 时不存在").into()),
    }
}

fn execution_job_outcome(event: &Event) -> JobOutcome {
    let tool_status = event
        .payload
        .get("tool_status")
        .and_then(|value| value.as_str())
        .unwrap_or("error");
    let exit_code = event
        .payload
        .get("exit_code")
        .and_then(|value| value.as_i64())
        .and_then(|value| i32::try_from(value).ok());
    if tool_status == "success" {
        JobOutcome::Succeeded {
            result_event_id: Some(event.id.clone()),
            result_refs: Vec::new(),
            exit_code,
        }
    } else {
        JobOutcome::Failed {
            result_event_id: Some(event.id.clone()),
            result_refs: Vec::new(),
            error: event
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("工具执行失败但没有提供错误文本")
                .to_string(),
            exit_code,
        }
    }
}

async fn finish_claimed_physical_job(
    manager: &ExecutionJobManager<dyn ExecutionJobStore>,
    claimed: &ClaimedExecutionJob,
    output: &mut Event,
    standalone_signal: bool,
) -> Result<(), DynError> {
    for _ in 0..8 {
        let current = manager
            .store()
            .get_execution_job(&claimed.id)
            .await?
            .ok_or_else(|| format!("Execution Job '{}' 在终态提交前消失", claimed.id))?;
        if current.status.is_terminal() {
            if current.result_event_id.as_deref() == Some(output.id.as_str()) {
                return Ok(());
            }
            return Err(format!(
                "Execution Job '{}' 已由不同结果 '{}' 终结",
                current.id,
                current.result_event_id.as_deref().unwrap_or("<none>")
            )
            .into());
        }

        let outcome = if current.cancel_requested_at.is_some() {
            let reason = current
                .cancel_reason
                .clone()
                .unwrap_or_else(|| "Runtime 已请求取消该物理 Action".to_string());
            let prior = output
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            output
                .payload
                .insert("tool_status".to_string(), json!("cancelled"));
            for key in ["process_status", "task_status", "execution"] {
                if output.payload.contains_key(key) {
                    output.payload.insert(key.to_string(), json!("cancelled"));
                }
            }
            output.payload.insert(
                "text".to_string(),
                json!(format!(
                    "物理 Action 已取消：{reason}\n--- 已观测输出 ---\n{prior}"
                )),
            );
            let exit_code = output
                .payload
                .get("exit_code")
                .and_then(|value| value.as_i64())
                .and_then(|value| i32::try_from(value).ok());
            JobOutcome::Cancelled {
                result_event_id: Some(output.id.clone()),
                result_refs: Vec::new(),
                reason: Some(reason),
                exit_code,
            }
        } else {
            execution_job_outcome(output)
        };
        match manager
            .finish_with_event(
                &current.id,
                current.revision,
                Some(&claimed.claim_token),
                outcome,
                output,
                standalone_signal,
            )
            .await?
        {
            JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => return Ok(()),
            JobReceipt::Conflict { .. } => continue,
            JobReceipt::Rejected { current, .. }
                if !current.status.is_terminal() && current.cancel_requested_at.is_some() =>
            {
                continue;
            }
            JobReceipt::Rejected {
                current, reason, ..
            } => {
                return Err(format!(
                    "Execution Job '{}' 终态提交被拒绝（{}）：{reason}",
                    current.id,
                    current.status.as_str()
                )
                .into());
            }
            JobReceipt::NotFound { .. } => {
                return Err(format!("Execution Job '{}' 在终态提交时不存在", claimed.id).into());
            }
        }
    }
    Err(format!(
        "Execution Job '{}' 在终态提交时持续发生 revision 竞争",
        claimed.id
    )
    .into())
}

async fn finish_claimed_physical_job_with_outcome(
    manager: &ExecutionJobManager<dyn ExecutionJobStore>,
    claimed: &ClaimedExecutionJob,
    outcome: JobOutcome,
    output: &Event,
    standalone_signal: bool,
) -> Result<(), DynError> {
    for _ in 0..8 {
        let current = manager
            .store()
            .get_execution_job(&claimed.id)
            .await?
            .ok_or_else(|| format!("Execution Job '{}' 在恢复终态前消失", claimed.id))?;
        if current.status.is_terminal() {
            if current.result_event_id.as_deref() == Some(output.id.as_str()) {
                return Ok(());
            }
            return Err(format!(
                "Execution Job '{}' 已由不同结果 '{}' 终结",
                current.id,
                current.result_event_id.as_deref().unwrap_or("<none>")
            )
            .into());
        }
        match manager
            .finish_with_event(
                &current.id,
                current.revision,
                Some(&claimed.claim_token),
                outcome.clone(),
                output,
                standalone_signal,
            )
            .await?
        {
            JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => return Ok(()),
            JobReceipt::Conflict { .. } => continue,
            JobReceipt::Rejected {
                current, reason, ..
            } => {
                return Err(format!(
                    "Execution Job '{}' 恢复终态被拒绝（{}）：{reason}",
                    current.id,
                    current.status.as_str()
                )
                .into());
            }
            JobReceipt::NotFound { .. } => {
                return Err(format!("Execution Job '{}' 在恢复终态时不存在", claimed.id).into());
            }
        }
    }
    Err(format!(
        "Execution Job '{}' 在恢复终态时持续发生 revision 竞争",
        claimed.id
    )
    .into())
}

fn lost_tool_output(metadata: &ToolTaskMetadata, reason: &str) -> Event {
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(metadata.context_id.clone())),
        ("session_id".to_string(), json!(metadata.session_id.clone())),
        ("attempt_id".to_string(), json!(metadata.attempt_id.clone())),
        (
            "tool_call_id".to_string(),
            json!(metadata.tool_call_id.clone()),
        ),
        (
            "caused_by".to_string(),
            json!(metadata.tool_call_id.clone()),
        ),
        ("tool_name".to_string(), json!(metadata.tool_name.clone())),
        ("target_id".to_string(), json!(metadata.target_id.clone())),
        ("tool_status".to_string(), json!("lost")),
        (
            "wake_policy".to_string(),
            json!(if metadata.wake_on_output {
                "immediate"
            } else {
                "none"
            }),
        ),
        ("output_empty".to_string(), json!(false)),
        ("text".to_string(), json!(reason)),
    ]);
    if let Some(route) = &metadata.activation_route {
        payload.insert("thread_id".to_string(), json!(route.thread_id));
        if let Some(principal_id) = &route.initiating_principal_id {
            payload.insert("principal_id".to_string(), json!(principal_id));
        }
        payload.insert("activation_id".to_string(), json!(route.activation_id));
        payload.insert("root_turn_id".to_string(), json!(route.root_turn_id));
        payload.insert(
            "trigger_event_id".to_string(),
            json!(route.trigger_event_id),
        );
        payload.insert(
            "trigger_sequence".to_string(),
            json!(route.trigger_sequence),
        );
    }
    if let Some(group_id) = &metadata.action_group_id {
        payload.insert("action_group_id".to_string(), json!(group_id));
    }
    if let Some(job) = &metadata.execution_job {
        stamp_execution_route_facts(
            &mut payload,
            &job.target_id,
            &job.record.request,
            job.record.claimed_by.as_deref(),
        );
    }
    Event::new(
        metadata.output_id.clone(),
        "System-Executor".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        payload,
    )
}

fn action_group_member_status(output: &Event) -> ActionGroupMemberStatus {
    match output
        .payload
        .get("tool_status")
        .and_then(|value| value.as_str())
    {
        Some("success" | "committed" | "guarded" | "existing") => {
            ActionGroupMemberStatus::Succeeded
        }
        Some("cancelled") => ActionGroupMemberStatus::Cancelled,
        Some("lost") => ActionGroupMemberStatus::Lost,
        Some("skipped") => ActionGroupMemberStatus::Skipped,
        Some("error" | "failed" | "timeout" | "rejected") | None => ActionGroupMemberStatus::Failed,
        Some(_) => ActionGroupMemberStatus::Succeeded,
    }
}

async fn recover_action_group_from_durable_events(
    context_engine: &ContextEngine,
    group: &ActionGroupRecord,
    groups: &dyn ActionGroupStore,
) -> Result<usize, DynError> {
    let durable_attempt_id = group
        .assistant_call_event_id
        .strip_prefix("call_")
        .ok_or_else(|| {
            format!(
                "Action Group '{}' 的 assistant_call_event_id '{}' 不符合确定性格式",
                group.id, group.assistant_call_event_id
            )
        })?;
    let selected_event_id = format!("tool_calls_selected_{durable_attempt_id}");
    let Some(selected) = context_engine
        .find_event(&group.context_id, &selected_event_id)
        .await?
    else {
        return Err(format!(
            "Action Group '{}' 缺少工具选择 Event '{}'",
            group.id, selected_event_id
        )
        .into());
    };
    let members = groups.list_action_group_members(&group.id).await?;
    let mut evidence = HashMap::from([(selected.id.clone(), selected)]);
    for member in &members {
        if member.status.is_terminal() {
            continue;
        }
        let result_id = format!("output_{}_{}", group.activation_id, member.tool_call_id);
        if let Some(result) = context_engine
            .find_event(&group.context_id, &result_id)
            .await?
        {
            evidence.insert(result.id.clone(), result);
        }
    }
    recover_action_group_from_prefetched_events(group, groups, &members, &evidence).await
}

async fn recover_action_group_from_prefetched_events(
    group: &ActionGroupRecord,
    groups: &dyn ActionGroupStore,
    members: &[ActionGroupMemberRecord],
    evidence: &HashMap<String, Event>,
) -> Result<usize, DynError> {
    let durable_attempt_id = group
        .assistant_call_event_id
        .strip_prefix("call_")
        .ok_or_else(|| {
            format!(
                "Action Group '{}' 的 assistant_call_event_id '{}' 不符合确定性格式",
                group.id, group.assistant_call_event_id
            )
        })?;
    let selected_event_id = format!("tool_calls_selected_{durable_attempt_id}");
    let selected = evidence.get(&selected_event_id).ok_or_else(|| {
        format!(
            "Action Group '{}' 缺少工具选择 Event '{}'",
            group.id, selected_event_id
        )
    })?;
    let Some(wake_policy) = selected
        .payload
        .get("action_group_wake_policy")
        .and_then(serde_json::Value::as_str)
    else {
        tracing::warn!(
            action_group_id = %group.id,
            selected_event_id = %selected.id,
            event_code = "orchestrator.action_group.legacy_recovery_deferred",
            "Legacy Action Group lacks an explicit durable wake policy; leaving it for Activation replay rather than guessing its continuation semantics"
        );
        return Ok(0);
    };
    let settled = recovered_action_group_settled_event(group, selected, wake_policy)?;
    let mut committed = 0usize;
    for member in members {
        if member.status.is_terminal() {
            continue;
        }
        let result_id = format!("output_{}_{}", group.activation_id, member.tool_call_id);
        let Some(result) = evidence.get(&result_id) else {
            continue;
        };
        let commit = groups
            .commit_action_group_member_result(
                &group.id,
                &member.tool_call_id,
                action_group_member_status(result),
                result,
                &settled,
            )
            .await?;
        if !commit.existing {
            committed = committed.saturating_add(1);
        }
    }
    Ok(committed)
}

// Event construction lists all causal coordinates explicitly to prevent accidental ambient routing.
#[allow(clippy::too_many_arguments)]
fn action_group_settled_event(
    group_id: &str,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    member_count: usize,
    route: &ActivationRoute,
    objective: Option<&crate::objective::ActiveObjectiveEvaluation>,
    wake_on_output: bool,
) -> Event {
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("action_group_id".to_string(), json!(group_id)),
        ("member_count".to_string(), json!(member_count)),
        ("thread_id".to_string(), json!(route.thread_id)),
        ("activation_id".to_string(), json!(route.activation_id)),
        ("root_turn_id".to_string(), json!(route.root_turn_id)),
        (
            "trigger_event_id".to_string(),
            json!(route.trigger_event_id),
        ),
        (
            "trigger_sequence".to_string(),
            json!(route.trigger_sequence),
        ),
        (
            "wake_policy".to_string(),
            json!(if wake_on_output {
                "direct_signal"
            } else {
                "none"
            }),
        ),
    ]);
    if let Some(objective) = objective {
        payload.insert("objective_id".to_string(), json!(objective.objective_id));
        payload.insert(
            "objective_evaluation_id".to_string(),
            json!(objective.evaluation_id),
        );
        payload.insert("objective_revision".to_string(), json!(objective.revision));
    }
    if let Some(principal_id) = &route.initiating_principal_id {
        payload.insert("principal_id".to_string(), json!(principal_id));
    }
    Event::new(
        format!("action_group_settled_{group_id}"),
        "Runtime-ActionScheduler".to_string(),
        "runtime_control".to_string(),
        "runtime/action_group_settled".to_string(),
        payload,
    )
}

fn recovered_action_group_settled_event(
    group: &ActionGroupRecord,
    selected: &Event,
    wake_policy: &str,
) -> Result<Event, DynError> {
    if !matches!(wake_policy, "direct_signal" | "none") {
        return Err(format!(
            "Action Group '{}' 的持久化 wake policy '{}' 非法",
            group.id, wake_policy
        )
        .into());
    }
    let required_str = |key: &str| -> Result<String, DynError> {
        selected
            .payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| {
                format!(
                    "Action Group '{}' 的工具选择 Event '{}' 缺少 '{}'",
                    group.id, selected.id, key
                )
                .into()
            })
    };
    let context_id = required_str("context_id")?;
    let session_id = required_str("session_id")?;
    let activation_id = required_str("activation_id")?;
    let thread_id = required_str("thread_id")?;
    if context_id != group.context_id
        || session_id != group.session_id
        || activation_id != group.activation_id
        || thread_id != group.thread_id
    {
        return Err(format!(
            "Action Group '{}' 与工具选择 Event '{}' 的因果 route 不一致",
            group.id, selected.id
        )
        .into());
    }
    let root_turn_id = required_str("root_turn_id")?;
    let trigger_event_id = required_str("trigger_event_id")?;
    let trigger_sequence = selected
        .payload
        .get("trigger_sequence")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            format!(
                "Action Group '{}' 的工具选择 Event '{}' 缺少 trigger_sequence",
                group.id, selected.id
            )
        })?;
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(group.context_id)),
        ("session_id".to_string(), json!(group.session_id)),
        ("attempt_id".to_string(), json!(group.activation_id)),
        ("action_group_id".to_string(), json!(group.id)),
        ("member_count".to_string(), json!(group.member_count)),
        ("thread_id".to_string(), json!(group.thread_id)),
        ("activation_id".to_string(), json!(group.activation_id)),
        ("root_turn_id".to_string(), json!(root_turn_id)),
        ("trigger_event_id".to_string(), json!(trigger_event_id)),
        ("trigger_sequence".to_string(), json!(trigger_sequence)),
        ("wake_policy".to_string(), json!(wake_policy)),
    ]);
    if let Some(principal_id) = selected
        .payload
        .get("principal_id")
        .and_then(serde_json::Value::as_str)
    {
        payload.insert("principal_id".to_string(), json!(principal_id));
    }
    if let Some(objective_id) = &group.objective_id {
        payload.insert("objective_id".to_string(), json!(objective_id));
    }
    if let Some(evaluation_id) = &group.objective_evaluation_id {
        payload.insert("objective_evaluation_id".to_string(), json!(evaluation_id));
    }
    if let Some(revision) = group.objective_revision {
        payload.insert("objective_revision".to_string(), json!(revision));
    }
    Ok(Event::new(
        format!("action_group_settled_{}", group.id),
        "Runtime-ActionScheduler".to_string(),
        "runtime_control".to_string(),
        "runtime/action_group_settled".to_string(),
        payload,
    ))
}

fn unstarted_cancelled_tool_output(job: &ExecutionJobRecord, reason: &str) -> Event {
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(job.context_id)),
        ("session_id".to_string(), json!(job.session_id)),
        ("attempt_id".to_string(), json!(job.activation_id)),
        ("tool_call_id".to_string(), json!(job.tool_call_id)),
        ("caused_by".to_string(), json!(job.tool_call_id)),
        ("tool_name".to_string(), json!(job.tool_name)),
        ("target_id".to_string(), json!(job.target_id)),
        ("tool_status".to_string(), json!("cancelled")),
        ("executed".to_string(), json!(false)),
        ("wake_policy".to_string(), json!("none")),
        ("output_empty".to_string(), json!(false)),
        ("thread_id".to_string(), json!(job.thread_id)),
        ("activation_id".to_string(), json!(job.activation_id)),
        (
            "text".to_string(),
            json!(format!(
                "物理 Action 在副作用开始前已取消，因此没有执行：{reason}"
            )),
        ),
    ]);
    if let Some(principal_id) = &job.initiating_principal_id {
        payload.insert("principal_id".to_string(), json!(principal_id));
    }
    stamp_execution_route_facts(
        &mut payload,
        &job.target_id,
        &job.request,
        job.claimed_by.as_deref(),
    );
    Event::new(
        format!("output_cancelled_{}", job.id),
        "System-Executor".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        payload,
    )
}

/// Copies the immutable physical route selected at Job creation into the
/// Event projection. The opaque endpoint reference identifies a Node-local
/// connection profile; credentials are never stored in the Job or Event.
fn stamp_execution_route_facts(
    payload: &mut serde_json::Map<String, serde_json::Value>,
    target_id: &str,
    request: &serde_json::Value,
    worker_id: Option<&str>,
) {
    payload.insert("target_id".to_string(), json!(target_id));
    let route = request
        .get(crate::execution_target::EXECUTION_ROUTE_REQUEST_KEY)
        .cloned()
        .and_then(|value| {
            serde_json::from_value::<crate::execution_target::ExecutionRouteSnapshot>(value).ok()
        });
    if let Some(route) = route {
        payload.insert("route_id".to_string(), json!(route.route_id));
        payload.insert("target_revision".to_string(), json!(route.target_revision));
        payload.insert("backend_kind".to_string(), json!(route.backend_kind));
        payload.insert(
            "target_policy_digest".to_string(),
            json!(route.policy_digest),
        );
        if let Some(provider_node_id) = route.provider_node_id {
            payload.insert("provider_node_id".to_string(), json!(provider_node_id));
        }
        if let Some(endpoint_ref) = route.endpoint_ref {
            payload.insert("endpoint_ref".to_string(), json!(endpoint_ref));
        }
    }
    if let Some(worker_id) = worker_id {
        payload.insert("worker_id".to_string(), json!(worker_id));
    }
}

/// Freezes the one authoritative parent-join route into the immutable Job
/// request. Plan construction and live physical dispatch must call this same
/// helper before the deterministic Job identity is persisted or replayed.
fn attach_execution_join_route(
    request: &mut serde_json::Value,
    action_group_id: Option<&str>,
    standalone_signal: bool,
) -> Result<(), DynError> {
    let object = request
        .as_object_mut()
        .ok_or("Physical Execution request 在附加 join route 后不是 JSON object")?;
    if let Some(group_id) = action_group_id {
        object.insert("_morphz_action_group_id".to_string(), json!(group_id));
    }
    object.insert("_morphz_wake_thread".to_string(), json!(standalone_signal));
    Ok(())
}

fn extend_exec_output_facts(
    payload: &mut serde_json::Map<String, serde_json::Value>,
    output: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return;
    };
    for key in [
        "execution",
        "process_status",
        "exit_code",
        "task_status",
        "task_id",
        "effective_boundary",
        "artifact_path",
    ] {
        if let Some(value) = value.get(key) {
            payload.insert(key.to_string(), value.clone());
        }
    }
}

fn delegation_mode_from_arguments(arguments: &str) -> &str {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("mode")
                .and_then(|mode| mode.as_str())
                .map(ToOwned::to_owned)
        })
        .map(|mode| {
            if mode == "detached" {
                "detached"
            } else {
                "attached"
            }
        })
        .unwrap_or("attached")
}

fn normalized_delegate_key(arguments: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(arguments).ok()?;
    let task = value.get("task")?.as_str()?.trim();
    let success_when = value
        .get("success_when")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim();
    let context_scope = value
        .get("context_scope")
        .and_then(|value| value.as_str())
        .unwrap_or("current_session");
    let mode = value
        .get("mode")
        .and_then(|value| value.as_str())
        .unwrap_or("attached");
    Some(format!(
        "{task}\u{1f}{success_when}\u{1f}{context_scope}\u{1f}{mode}"
    ))
}

fn context_tx_receipt_for_event(event: &Event) -> ContextTxReceipt {
    if event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        != Some("context_tx")
    {
        return ContextTxReceipt::None;
    }
    if context_tx_output_succeeded(event) {
        return ContextTxReceipt::Committed;
    }
    ContextTxReceipt::Failed
}

fn required_payload_str<'a>(event: &'a Event, key: &str) -> Result<&'a str, DynError> {
    event
        .payload
        .get(key)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("事件 '{}' 缺少字符串字段 '{}'", event.id, key).into())
}

fn merge_artifact_transfer_requirements(
    local: Option<crate::permission::ApprovalRequirement>,
    remote: Option<crate::permission::ApprovalRequirement>,
) -> Option<crate::permission::ApprovalRequirement> {
    let mut requirements = [local, remote].into_iter().flatten();
    let mut merged = requirements.next()?;
    for requirement in requirements {
        merged.requested.network |= requirement.requested.network;
        for root in requirement.requested.read_roots {
            if !merged.requested.read_roots.contains(&root) {
                merged.requested.read_roots.push(root);
            }
        }
        for root in requirement.requested.write_roots {
            if !merged.requested.write_roots.contains(&root) {
                merged.requested.write_roots.push(root);
            }
        }
        for name in requirement.requested.secret_env {
            if !merged.requested.secret_env.contains(&name) {
                merged.requested.secret_env.push(name);
            }
        }
        merged.justification.push('；');
        merged.justification.push_str(&requirement.justification);
    }
    Some(merged)
}

fn legacy_plan_effect_sequence(
    tool_call_id: &str,
    plan_execution_id: &str,
    recovery_ceiling: u64,
) -> Result<Option<u64>, DynError> {
    for sequence in 1..=recovery_ceiling.max(1) {
        if crate::plan_execution::deterministic_plan_effect_id(plan_execution_id, sequence)?
            == tool_call_id
        {
            return Ok(Some(sequence));
        }
    }
    Ok(None)
}

fn is_dialogue_trigger(event: &Event) -> bool {
    matches!(
        event.event_type.as_str(),
        TYPE_USER_MESSAGE | TYPE_SESSION_SIGNAL | TYPE_RUNTIME_WAKE
    ) || event.topic == "chat/dialogue_retry"
}

fn should_force_final_for_maintenance(
    phase: &str,
    pressure: &str,
    context_tx_available: bool,
) -> bool {
    matches!(phase, "work" | "soft-checkpoint") && pressure == "critical" && !context_tx_available
}

fn critical_maintenance_transaction_available(transactions_used: usize) -> bool {
    transactions_used < CRITICAL_MAINTENANCE_TRANSACTION_SAFETY_LIMIT
}

fn tool_call_activity_preview(call: &crate::llm::ToolCallRepr) -> serde_json::Value {
    let original_chars = call.arguments.chars().count();
    let mut arguments = serde_json::from_str::<serde_json::Value>(&call.arguments)
        .map(|mut value| {
            redact_sensitive_tool_arguments(&mut value);
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| call.arguments.clone())
        })
        .unwrap_or_else(|_| call.arguments.clone());
    let rendered_chars = arguments.chars().count();
    let truncated = rendered_chars > TOOL_ARGUMENT_PREVIEW_CHARS;
    if truncated {
        arguments = arguments
            .chars()
            .take(TOOL_ARGUMENT_PREVIEW_CHARS)
            .collect::<String>();
        arguments.push_str(&format!("\n… <参数预览已截断，共 {rendered_chars} 字符>"));
    }
    json!({
        "id": call.id,
        "name": call.func_name,
        "arguments": arguments,
        "arguments_chars": original_chars,
        "truncated": truncated,
    })
}

fn redact_sensitive_tool_arguments(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if is_sensitive_argument_key(key) {
                    *value = serde_json::Value::String("[REDACTED]".to_string());
                } else {
                    redact_sensitive_tool_arguments(value);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_sensitive_tool_arguments(value);
            }
        }
        _ => {}
    }
}

fn is_sensitive_argument_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "password"
            | "passwd"
            | "secret"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "authtoken"
            | "authorization"
            | "cookie"
            | "setcookie"
            | "privatekey"
            | "clientsecret"
    ) || [
        "password",
        "passwd",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "privatekey",
        "clientsecret",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn normalize_context_tx_key(context_id: &str, arguments: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(arguments).map_err(|error| format!("参数 JSON 非法: {error}"))?;
    let transaction = value
        .get("transaction")
        .and_then(|value| value.as_str())
        .ok_or("缺少 transaction 字符串")?;
    let canonical = crate::sexpr::parse(transaction)
        .map_err(|error| format!("transaction SExpr 非法: {error}"))?
        .to_string();
    Ok(format!("{context_id}\u{0}{canonical}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        action_group_reconcile_id, activation_admission_class, apply_prompt_estimate_delta,
        baseline_system_prompt, classify_terminal_response, cognitive_sexpr_vm_system_prompt,
        completed_objective_update_call, compose_context_encoding,
        critical_maintenance_transaction_available, derived_thread_kind,
        durable_activation_revocation_reason, durable_reasoning_continuation_state_from_events,
        extend_exec_output_facts, harness_entry_callable_tools, legacy_plan_effect_sequence,
        model_visible_attachment_references, new_runtime_claimant_id,
        objective_supervision_matches_state, persist_model_reasoning_summary, persist_model_usage,
        plan_infer_tool_scope, production_system_prompt_inspection, provider_delivery_retry_delay,
        recover_action_group_from_durable_events, recovered_action_group_settled_event,
        recovery_owns_activation, render_harness_context, render_system_contract,
        restrict_tools_to_scope, retain_context_maintenance_tools,
        retain_final_reply_control_tools, retain_pending_continuation_calls, scheduler_audit_event,
        semantic_sexpr_vm_system_prompt, should_dispatch_runtime_harness_entry,
        should_force_final_for_maintenance, tool_call_activity_preview,
        validate_final_reply_response, validate_objective_closure_review_response,
        validate_objective_completion_call, ContextEngine, DialogueThreadGate, DialogueThreadLease,
        DurableEventWriter, DurableEventWriterMetrics, DynError, EvaluationContextOverlay,
        ModelCompletionError, ModelCompletionErrorOrigin, ModelReasoningSummaryAccumulator,
        ModelVisibleAttachmentReference, NoReplyMode, TerminalDecision,
        AGENT_OWNED_CONTEXT_PROMPT_BASE,
    };
    use crate::admission::AdmissionClass;
    use crate::config::EventWriterConfig;
    use crate::event::{
        Event, InMemoryEventBus, TYPE_INFER_REQUEST, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
    };
    use crate::harness::{HarnessBinding, HarnessRegistry as DomainHarnessRegistry};
    use crate::llm::{
        FunctionCall, ModelUsage, PromptTokenAccuracy, PromptTokenCount, ProviderContinuation,
        ToolCall, ToolDefinition,
    };
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        ActionGroupRecord, ActionGroupStatus, ActionGroupStore, ActivationStore,
        AttentionAcknowledgementRecord, EventAppend, EventStore, NewActionGroup,
        NewActionGroupMember, NewAgent, NewCognitiveContext, NewSession, NewThread,
        NewThreadActivation, QueryFilter, SessionDirectoryStore, SessionMountKind,
        ThreadActivationRecord, ThreadActivationStatus, ThreadKind, ThreadStore,
        WorkerCoordinationMode,
    };
    use std::collections::{BTreeSet, HashMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::{Barrier, Mutex};

    fn contains_cjk(text: &str) -> bool {
        text.chars().any(|character| {
            matches!(
                character,
                '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'
            )
        })
    }

    #[test]
    fn scheduler_audit_invalidation_ignores_model_telemetry_but_keeps_causal_events() {
        let event = |topic: &str| {
            Event::new(
                format!("event-{topic}"),
                "Runtime".to_string(),
                "runtime_control".to_string(),
                topic.to_string(),
                json!({ "context_id": "context-a" })
                    .as_object()
                    .unwrap()
                    .clone(),
            )
        };
        assert!(!scheduler_audit_event(&event("runtime/model_stream")));
        assert!(!scheduler_audit_event(&event("chat/progress")));
        assert!(scheduler_audit_event(&event("chat/user_message")));
        assert!(scheduler_audit_event(&event("runtime/thread_terminal")));

        let mut group_result = event("chat/tool_output");
        group_result.id = "output_activation-a_call-a".to_string();
        group_result
            .payload
            .insert("action_group_id".to_string(), json!("group-a"));
        group_result
            .payload
            .insert("tool_call_id".to_string(), json!("call-a"));
        assert_eq!(action_group_reconcile_id(&group_result), Some("group-a"));
        assert_eq!(action_group_reconcile_id(&event("chat/user_message")), None);

        let mut missing_context = event("runtime/thread_terminal");
        missing_context.payload.remove("context_id");
        assert!(!scheduler_audit_event(&missing_context));
    }

    #[test]
    fn provider_delivery_retry_uses_bounded_exponential_backoff() {
        assert_eq!(provider_delivery_retry_delay(0).as_secs(), 1);
        assert_eq!(provider_delivery_retry_delay(1).as_secs(), 1);
        assert_eq!(provider_delivery_retry_delay(2).as_secs(), 2);
        assert_eq!(provider_delivery_retry_delay(5).as_secs(), 16);
        assert_eq!(provider_delivery_retry_delay(6).as_secs(), 30);
        assert_eq!(provider_delivery_retry_delay(u32::MAX).as_secs(), 30);
    }

    #[test]
    fn reasoning_continuation_rebuilds_durable_restart_state_in_event_order() {
        let summary = |attempt_id: &str, text: &str| {
            Event::new(
                format!("summary-{attempt_id}"),
                "Model-Provider".to_string(),
                "runtime_control".to_string(),
                "runtime/model_reasoning_summary".to_string(),
                [
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("text".to_string(), json!(text)),
                ]
                .into_iter()
                .collect(),
            )
        };
        let continuation = |attempt_id: &str, count: usize, opaque: &str| {
            Event::new(
                format!("continuation-{attempt_id}"),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/reasoning_continuation".to_string(),
                [
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("continuation_count".to_string(), json!(count)),
                    (
                        "provider_continuation".to_string(),
                        json!(ProviderContinuation::OpenaiResponses {
                            reasoning_items: vec![json!({
                                "type": "reasoning",
                                "id": attempt_id,
                                "encrypted_content": opaque,
                            })],
                        }),
                    ),
                ]
                .into_iter()
                .collect(),
            )
        };
        let events = vec![
            summary("attempt-0", "segment one"),
            continuation("attempt-0", 1, "opaque-1"),
            summary("attempt-1", "segment two"),
            continuation("attempt-1", 2, "opaque-2"),
        ];

        let restored =
            durable_reasoning_continuation_state_from_events("activation-a", &events).unwrap();
        assert_eq!(restored.physical_continuations, 2);
        assert_eq!(restored.continuation_count, 2);
        assert_eq!(restored.stalled_count, 0);
        assert_eq!(restored.summaries, ["segment one", "segment two"]);
        assert_eq!(restored.provider_continuations.len(), 2);
        assert!(matches!(
            &restored.provider_continuations[1],
            ProviderContinuation::OpenaiResponses { reasoning_items }
                if reasoning_items[0]["encrypted_content"] == "opaque-2"
        ));
    }

    #[test]
    fn reasoning_continuation_restart_restores_only_latest_maintenance_generation() {
        let event = |topic: &str, id: &str, attempt_id: &str, count: Option<usize>| {
            let mut payload = serde_json::Map::from_iter([
                ("attempt_id".to_string(), json!(attempt_id)),
                ("text".to_string(), json!(id)),
            ]);
            if let Some(count) = count {
                payload.insert("continuation_count".to_string(), json!(count));
            }
            Event::new(
                id.to_string(),
                "Runtime".to_string(),
                "runtime_control".to_string(),
                topic.to_string(),
                payload,
            )
        };
        let events = vec![
            event(
                "runtime/model_reasoning_summary",
                "old-summary",
                "attempt-0",
                None,
            ),
            event(
                "runtime/reasoning_continuation",
                "old-continuation",
                "attempt-0",
                Some(1),
            ),
            event(
                "runtime/model_reasoning_summary",
                "new-summary",
                "attempt-1",
                None,
            ),
            event(
                "runtime/reasoning_continuation",
                "new-continuation",
                "attempt-1",
                Some(1),
            ),
        ];

        let restored =
            durable_reasoning_continuation_state_from_events("activation-a", &events).unwrap();
        assert_eq!(restored.physical_continuations, 2);
        assert_eq!(restored.continuation_count, 1);
        assert_eq!(restored.summaries, ["new-summary"]);
    }

    #[derive(Default)]
    struct ContendedEventStore {
        remaining_contention_failures: AtomicUsize,
        committed: Mutex<Vec<Event>>,
    }

    #[tokio::test]
    async fn dropped_dialogue_lease_releases_gate_after_failed_or_cancelled_attempt() {
        let gate = Arc::new(DialogueThreadGate::default());
        gate.acquire("turn-a").await;
        let lease = DialogueThreadLease::new(Arc::clone(&gate), "turn-a");
        drop(lease);

        let acquired = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            gate.acquire("turn-b").await;
        })
        .await;
        assert!(
            acquired.is_ok(),
            "dropped attempt must not strand the Session dialogue gate"
        );
        assert!(gate.release("turn-b"));
    }

    #[tokio::test]
    async fn retained_dialogue_lease_keeps_gate_for_context_maintenance_continuation() {
        let gate = Arc::new(DialogueThreadGate::default());
        gate.acquire("turn-a").await;
        let mut lease = DialogueThreadLease::new(Arc::clone(&gate), "turn-a");
        lease.retain_for_continuation();
        drop(lease);

        assert!(gate.owns("turn-a").await);
        assert!(gate.release("turn-a"));
    }

    #[test]
    fn retired_tool_outputs_are_removed_with_their_assistant_calls() {
        let call = |id: &str, name: &str| ToolCall {
            id: id.to_string(),
            r#type: "function".to_string(),
            function: FunctionCall {
                name: name.to_string(),
                arguments: "{}".to_string(),
            },
        };
        let output = |id: &str| {
            Event::new(
                id.to_string(),
                "System-Executor".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                Default::default(),
            )
        };
        let outputs = HashMap::from([
            (
                ("attempt-1".to_string(), "call-retired".to_string()),
                output("output-retired"),
            ),
            (
                ("attempt-1".to_string(), "call-active".to_string()),
                output("output-active"),
            ),
        ]);
        let retired = BTreeSet::from(["output-retired".to_string()]);

        let retained = retain_pending_continuation_calls(
            "attempt-1",
            vec![call("call-retired", "read"), call("call-active", "read")],
            &outputs,
            &retired,
        );

        assert_eq!(retained, vec![call("call-active", "read")]);
    }

    #[test]
    fn committed_context_transactions_are_not_added_to_provider_continuation() {
        let call = ToolCall {
            id: "context-call".to_string(),
            r#type: "function".to_string(),
            function: FunctionCall {
                name: "context_tx".to_string(),
                arguments: r#"{"transaction":"(context-tx ...)"}"#.to_string(),
            },
        };
        let output = Event::new(
            "context-output".to_string(),
            "System-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            serde_json::Map::from_iter([
                ("tool_name".to_string(), json!("context_tx")),
                ("text".to_string(), json!(r#"{"status":"committed"}"#)),
            ]),
        );
        let outputs = HashMap::from([(("attempt-1".to_string(), call.id.clone()), output)]);

        let retained =
            retain_pending_continuation_calls("attempt-1", vec![call], &outputs, &BTreeSet::new());

        assert!(retained.is_empty());
    }

    #[async_trait::async_trait]
    impl EventStore for ContendedEventStore {
        async fn append(&self, event: Event) -> Result<(), DynError> {
            self.append_batch(vec![EventAppend { event }]).await
        }

        async fn append_to_thread(&self, event: Event, _thread_id: &str) -> Result<(), DynError> {
            self.append_batch(vec![EventAppend { event }]).await
        }

        async fn append_batch(&self, entries: Vec<EventAppend>) -> Result<(), DynError> {
            let remaining = self.remaining_contention_failures.load(Ordering::Acquire);
            if remaining > 0 {
                self.remaining_contention_failures
                    .fetch_sub(1, Ordering::AcqRel);
                return Err(std::io::Error::other(
                    "error returned from database: (code: 5) database is locked",
                )
                .into());
            }
            self.committed
                .lock()
                .await
                .extend(entries.into_iter().map(|entry| entry.event));
            Ok(())
        }

        async fn query(&self, _filter: QueryFilter) -> Result<Vec<Event>, DynError> {
            Ok(self.committed.lock().await.clone())
        }

        async fn list_attention_acknowledgements(
            &self,
            _context_id: &str,
        ) -> Result<Vec<AttentionAcknowledgementRecord>, DynError> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn durable_usage_anchor_applies_signed_local_prompt_delta() {
        assert_eq!(apply_prompt_estimate_delta(1_000, 1_150, 900), 1_250);
        assert_eq!(apply_prompt_estimate_delta(1_000, 700, 900), 800);
        assert_eq!(apply_prompt_estimate_delta(100, 0, 500), 0);
    }

    #[test]
    fn shared_activation_recovery_respects_live_worker_leases() {
        let now = chrono::Utc::now();
        let activation = |status, lease_expires_at| ThreadActivationRecord {
            id: "activation".to_string(),
            revision: 1,
            generation: 0,
            agent_id: "agent".to_string(),
            context_id: "context".to_string(),
            session_id: "session".to_string(),
            initiating_principal_id: None,
            trigger_event_id: "trigger".to_string(),
            trigger_sequence: 1,
            trigger_kind: "chat/user_message".to_string(),
            parent_activation_id: None,
            root_turn_id: "root".to_string(),
            context_snapshot_version: None,
            status,
            claimed_by: Some("runtime:999".to_string()),
            lease_expires_at,
            dialogue_lane_released_at: None,
            created_at: now,
            updated_at: now,
        };
        let queued = activation(ThreadActivationStatus::Queued, None);
        let live = activation(
            ThreadActivationStatus::Running,
            Some(now + chrono::Duration::seconds(30)),
        );
        let expired = activation(
            ThreadActivationStatus::Running,
            Some(now - chrono::Duration::seconds(1)),
        );
        assert!(!recovery_owns_activation(
            WorkerCoordinationMode::SharedLeases,
            &queued,
            now
        ));
        assert!(!recovery_owns_activation(
            WorkerCoordinationMode::SharedLeases,
            &live,
            now
        ));
        assert!(recovery_owns_activation(
            WorkerCoordinationMode::SharedLeases,
            &expired,
            now
        ));
        assert!(recovery_owns_activation(
            WorkerCoordinationMode::ExclusiveProcess,
            &queued,
            now
        ));

        let stale_same_host = ThreadActivationRecord {
            claimed_by: Some(format!("runtime:{}:stale-instance", std::process::id())),
            ..live.clone()
        };
        assert!(
            !recovery_owns_activation(
                WorkerCoordinationMode::SharedHostLeases,
                &stale_same_host,
                now
            ),
            "another Runtime instance under the same PID may still be alive"
        );
        assert!(!recovery_owns_activation(
            WorkerCoordinationMode::SharedLeases,
            &stale_same_host,
            now
        ));

        let current_same_host = ThreadActivationRecord {
            claimed_by: Some(new_runtime_claimant_id()),
            ..live
        };
        assert!(!recovery_owns_activation(
            WorkerCoordinationMode::SharedHostLeases,
            &current_same_host,
            now
        ));
    }

    #[test]
    fn runtime_claimants_are_unique_inside_one_process() {
        let first = new_runtime_claimant_id();
        let second = new_runtime_claimant_id();
        assert_ne!(first, second);
        assert!(first.starts_with(&format!("runtime:{}:", std::process::id())));
        assert!(second.starts_with(&format!("runtime:{}:", std::process::id())));
    }

    #[tokio::test]
    async fn activation_owner_observes_a_peer_runtime_durable_cancellation() {
        let tmp = TempDir::new().unwrap();
        let store = SqliteStore::new(tmp.path().join("activation-cancel.db").to_str().unwrap())
            .await
            .unwrap();
        let owner = new_runtime_claimant_id();
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-cancel".to_string(),
                    title: "Cancel Agent".to_string(),
                    root_context_id: "context-cancel".to_string(),
                },
                NewCognitiveContext {
                    id: "context-cancel".to_string(),
                    agent_id: "agent-cancel".to_string(),
                    title: "Cancel Context".to_string(),
                },
                NewSession {
                    id: "session-cancel".to_string(),
                    agent_id: "agent-cancel".to_string(),
                    context_id: "context-cancel".to_string(),
                    parent_session_id: None,
                    title: "Cancel Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let trigger = Event::new(
            "trigger-cancel".to_string(),
            "test".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!("context-cancel")),
                ("session_id".to_string(), json!("session-cancel")),
            ]),
        );
        store.append(trigger.clone()).await.unwrap();
        let trigger_sequence = store
            .query(QueryFilter {
                event_id: Some(trigger.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread-cancel".to_string(),
                agent_id: "agent-cancel".to_string(),
                context_id: "context-cancel".to_string(),
                session_id: "session-cancel".to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-cancel".to_string(),
                kind: ThreadKind::Execution,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
                supervision: crate::memory::ThreadSupervision::legacy(),
            })
            .await
            .unwrap();
        let queued = store
            .ensure_thread_activation(NewThreadActivation {
                id: "activation-cancel".to_string(),
                agent_id: "agent-cancel".to_string(),
                context_id: "context-cancel".to_string(),
                session_id: "session-cancel".to_string(),
                initiating_principal_id: None,
                trigger_event_id: trigger.id,
                trigger_sequence,
                trigger_kind: trigger.topic,
                parent_activation_id: None,
                root_turn_id: "root-cancel".to_string(),
            })
            .await
            .unwrap();
        let running = match store
            .update_thread_activation(
                &queued.id,
                queued.revision,
                ThreadActivationStatus::Running,
                Some(&owner),
                Some(chrono::Utc::now() + chrono::Duration::seconds(30)),
                None,
            )
            .await
            .unwrap()
        {
            crate::memory::ThreadActivationMutation::Updated(record) => record,
            other => panic!("unexpected running mutation: {other:?}"),
        };
        assert_eq!(
            durable_activation_revocation_reason(&store, &running.id, &owner)
                .await
                .unwrap(),
            None
        );

        let cancelled = match store
            .update_thread_activation(
                &running.id,
                running.revision,
                ThreadActivationStatus::Cancelled,
                None,
                None,
                None,
            )
            .await
            .unwrap()
        {
            crate::memory::ThreadActivationMutation::Updated(record) => record,
            other => panic!("unexpected cancellation mutation: {other:?}"),
        };
        let reason = durable_activation_revocation_reason(&store, &cancelled.id, &owner)
            .await
            .unwrap()
            .unwrap();
        assert!(reason.contains("cancelled"));
    }

    #[tokio::test]
    async fn durable_event_writer_groups_concurrent_publishers_and_reports_capacity() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("writer.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let metrics = Arc::new(DurableEventWriterMetrics::default());
        let writer = DurableEventWriter::spawn(
            Arc::clone(&store) as Arc<dyn EventStore>,
            &EventWriterConfig {
                queue_capacity: 32,
                max_batch_size: 32,
                flush_interval_ms: 100,
            },
            Arc::clone(&metrics),
        );
        let barrier = Arc::new(Barrier::new(13));
        let mut publishers = Vec::new();
        for index in 0..12 {
            let writer = writer.clone();
            let barrier = Arc::clone(&barrier);
            publishers.push(tokio::spawn(async move {
                barrier.wait().await;
                writer
                    .append(EventAppend {
                        event: Event::new(
                            format!("writer-{index}"),
                            "fixture".to_string(),
                            "fixture".to_string(),
                            "runtime/writer_fixture".to_string(),
                            serde_json::Map::new(),
                        ),
                    })
                    .await
                    .unwrap();
            }));
        }
        barrier.wait().await;
        for publisher in publishers {
            publisher.await.unwrap();
        }
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.queue_depth, 0);
        assert_eq!(snapshot.committed_events, 12);
        assert!(snapshot.committed_batches < 12);
        assert!(snapshot.largest_batch > 1);
        assert_eq!(
            store
                .query(QueryFilter {
                    topic: Some("runtime/writer_fixture".to_string()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            12
        );
    }

    #[tokio::test]
    async fn durable_event_writer_retries_storage_contention_without_failing_publishers() {
        let store = Arc::new(ContendedEventStore {
            remaining_contention_failures: AtomicUsize::new(3),
            ..Default::default()
        });
        let metrics = Arc::new(DurableEventWriterMetrics::default());
        let writer = DurableEventWriter::spawn(
            Arc::clone(&store) as Arc<dyn EventStore>,
            &EventWriterConfig {
                queue_capacity: 4,
                max_batch_size: 4,
                flush_interval_ms: 1,
            },
            Arc::clone(&metrics),
        );
        writer
            .append(EventAppend {
                event: Event::new(
                    "writer-contention-retry".to_string(),
                    "fixture".to_string(),
                    "fixture".to_string(),
                    "runtime/writer_fixture".to_string(),
                    serde_json::Map::new(),
                ),
            })
            .await
            .unwrap();

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.queue_depth, 0);
        assert_eq!(snapshot.committed_events, 1);
        assert_eq!(snapshot.failed_batches, 0);
        assert_eq!(snapshot.contention_retries, 3);
        assert_eq!(store.committed.lock().await.len(), 1);
    }

    #[test]
    fn model_completion_persistence_errors_are_not_provider_failures() {
        let error = ModelCompletionError::persistence(
            std::io::Error::other("error returned from database: (code: 5) database is locked")
                .into(),
        );
        assert!(error.is_runtime_failure());
        assert_eq!(error.origin, ModelCompletionErrorOrigin::RuntimePersistence);
    }

    #[tokio::test]
    async fn partial_reasoning_summary_is_persisted_once_with_stable_attempt_identity() {
        let bus = Arc::new(InMemoryEventBus::new());
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let durable_capture = Arc::clone(&captured);
        bus.subscribe_durable(
            "runtime/model_reasoning_summary".to_string(),
            Arc::new(move |event| {
                let capture = Arc::clone(&durable_capture);
                Box::pin(async move {
                    capture.lock().unwrap().push(event);
                    Ok(())
                })
            }),
        );
        let accumulator = Arc::new(Mutex::new(ModelReasoningSummaryAccumulator {
            text: "partial provider summary".to_string(),
            complete: true,
            persist_started: false,
            ..Default::default()
        }));
        let route = vec![
            ("activation_id".to_string(), json!("activation-1")),
            ("thread_kind".to_string(), json!("dialogue_turn")),
        ];

        for _ in 0..2 {
            persist_model_reasoning_summary(
                &bus,
                "context-1",
                "session-1",
                "attempt-1",
                &route,
                &accumulator,
                true,
            )
            .await
            .unwrap();
        }

        let events = captured.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "model_reasoning_summary_attempt-1");
        assert_eq!(events[0].payload["text"], "partial provider summary");
        assert_eq!(events[0].payload["complete"], false);
        assert_eq!(events[0].payload["activation_id"], "activation-1");
        assert_eq!(events[0].payload["thread_kind"], "dialogue_turn");
    }

    #[tokio::test]
    async fn model_usage_is_persisted_without_reasoning_or_public_reply() {
        let bus = Arc::new(InMemoryEventBus::new());
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let durable_capture = Arc::clone(&captured);
        bus.subscribe_durable(
            "runtime/model_usage".to_string(),
            Arc::new(move |event| {
                let capture = Arc::clone(&durable_capture);
                Box::pin(async move {
                    capture.lock().unwrap().push(event);
                    Ok(())
                })
            }),
        );
        let accumulator = Arc::new(Mutex::new(ModelReasoningSummaryAccumulator {
            usage: ModelUsage {
                input_tokens: Some(1_000),
                cached_input_tokens: Some(800),
                uncached_input_tokens: Some(200),
                output_tokens: Some(40),
                reasoning_tokens: Some(30),
                total_tokens: Some(1_040),
                raw: vec![json!({"input_tokens": 1000, "output_tokens": 40})],
                ..Default::default()
            },
            ..Default::default()
        }));
        let measurement = PromptTokenCount {
            tokens: 990,
            source: "openai-responses-serialized-request-estimate".to_string(),
            model: "fixture-model".to_string(),
            accuracy: PromptTokenAccuracy::HeuristicEstimate,
            base_estimate_tokens: 990,
            calibration_key: Some(7),
            calibration_shape: Some(9),
        };

        for _ in 0..2 {
            persist_model_usage(
                &bus,
                "context-1",
                "session-1",
                "attempt-usage-1",
                &[],
                &accumulator,
                Some(&measurement),
            )
            .await
            .unwrap();
        }

        let events = captured.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "model_usage_attempt-usage-1");
        assert_eq!(events[0].payload["usage"]["input_tokens"], 1_000);
        assert_eq!(events[0].payload["usage"]["cached_input_tokens"], 800);
        assert_eq!(events[0].payload["model"], "fixture-model");
        assert_eq!(events[0].payload["local_base_estimate_tokens"], 990);
    }

    #[test]
    fn activation_admission_class_is_runtime_owned_and_deterministic() {
        let event =
            |event_type: &str, topic: &str, payload: serde_json::Map<String, serde_json::Value>| {
                Event::new(
                    format!("class-{topic}"),
                    "fixture".to_string(),
                    event_type.to_string(),
                    topic.to_string(),
                    payload,
                )
            };
        assert_eq!(
            activation_admission_class(&event(
                TYPE_USER_MESSAGE,
                "chat/user_message",
                serde_json::Map::new(),
            )),
            AdmissionClass::InteractiveControl
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "chat/thread_completion_ready",
                serde_json::Map::new(),
            )),
            AdmissionClass::Delivery
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "objective/resume",
                serde_json::Map::new(),
            )),
            AdmissionClass::Objective
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "chat/schedule_due",
                serde_json::Map::new(),
            )),
            AdmissionClass::ScheduledBackground
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "runtime/context_maintenance",
                serde_json::Map::from_iter([("schedule_id".to_string(), json!("schedule-1"),)]),
            )),
            AdmissionClass::Maintenance,
            "explicit Runtime maintenance must not be reclassified by an incidental schedule field"
        );
    }

    #[test]
    fn legacy_plan_output_matches_any_issued_effect_and_one_checkpoint_gap() {
        let plan_id = "plan-history-fixture";
        for sequence in 1..=5 {
            let effect_id =
                crate::plan_execution::deterministic_plan_effect_id(plan_id, sequence).unwrap();
            assert_eq!(
                legacy_plan_effect_sequence(&effect_id, plan_id, 5).unwrap(),
                Some(sequence)
            );
        }
        let unrelated =
            crate::plan_execution::deterministic_plan_effect_id("other-plan", 2).unwrap();
        assert_eq!(
            legacy_plan_effect_sequence(&unrelated, plan_id, 5).unwrap(),
            None
        );
    }

    #[test]
    fn system_prompt_has_a_deterministic_generated_contract_prefix() {
        let first = baseline_system_prompt();
        let second = baseline_system_prompt();
        assert_eq!(first, second);
        assert_eq!(
            first,
            format!(
                "{AGENT_OWNED_CONTEXT_PROMPT_BASE}\n\n{}",
                render_system_contract()
            )
        );
        assert!(first.contains("Runtime Reality Contract"));
        assert!(first.contains("Agent Epistemic Contract"));
        assert!(first.contains("claims-no-stronger-than-sources"));
        assert!(first.contains("without prescribing Mind BODY structure"));
        assert!(first.contains("sandbox_permissions=require_escalated"));
        assert!(first.contains("Do not infer permission failure from an ordinary command error"));
        assert!(first.contains("protocol.skill-discovery-contract fallback"));
        assert!(first.contains("do not preload all Skills"));
        assert!(!contains_cjk(first));
        for prompt in [
            first,
            cognitive_sexpr_vm_system_prompt(),
            semantic_sexpr_vm_system_prompt(),
        ] {
            assert!(
                prompt.contains("persisted Event") || prompt.contains("event-sequence"),
                "system prompt lost durable Event semantics"
            );
        }
    }

    #[test]
    fn context_encoding_mounts_exact_harness_as_stable_profile_and_dynamic_binding() {
        let package = crate::harness_package::HarnessPackage::from_source(
            "coding.hns",
            r#"
                (manifest
                  (id coding)
                  (version "1.0.0")
                  (title "Coding")
                  (capabilities (tools read) (skills rust)))
                (contract (identity "coding"))
                (mind (frame (id coding/evidence)))
                (eval (requires (tools read)) (call read (path "README.md")))
            "#,
        )
        .unwrap();
        let registry = DomainHarnessRegistry::default();
        registry.register_package(package.clone()).unwrap();
        let harness = registry.get("coding", "1.0.0").unwrap();
        let binding = HarnessBinding {
            harness_id: "coding".to_string(),
            harness_version: "1.0.0".to_string(),
            artifact_hash: package.artifact_hash,
            scope: crate::harness::HarnessBindingScope::Evaluation,
            objective_id: Some("objective-1".to_string()),
            evaluation_id: Some("evaluation-2".to_string()),
            inherited_from_objective_id: Some("objective-1".to_string()),
        };
        let rendered = render_harness_context(&binding, harness.as_ref()).unwrap();
        let base = "(context (protocol (version 1)) (evaluation-profile none) (inbox) (mind) (evaluation-environment) (evaluate (root-input test)))";
        let context = compose_context_encoding(
            base,
            EvaluationContextOverlay {
                evaluation_profile: Some(&rendered.profile),
                harness_binding: Some(&rendered.binding),
                runtime_directive: Some(("work", "继续执行")),
            },
        )
        .unwrap();

        crate::sexpr::parse(&context).expect("mounted context must stay one S-expression");
        assert!(context.contains("(evaluation-profile"));
        assert!(context.contains("(evaluation-environment"));
        assert!(context.contains("(harness-binding"));
        assert!(context.contains("(objective objective-1)"));
        assert!(context.contains("(evaluation evaluation-2)"));
        assert!(context.contains("(read-only-default-mind (mind"));
        assert!(context.contains("(capabilities read rust)"));
        assert!(context.contains("(entry (owner runtime)"));
        assert!(context.contains("(program (eval"));
        assert!(context.contains("Runtime lowers this entry to Typed Plan IR"));
        assert!(context.find("(evaluation-profile").unwrap() < context.find("(inbox").unwrap());
        assert!(context.find("(evaluation-environment").unwrap() > context.find("(inbox").unwrap());
        assert!(
            context.find("(evaluation-environment").unwrap() < context.find("(evaluate ").unwrap()
        );
    }

    #[test]
    fn context_encoding_preserves_authoritative_local_time_when_mounting_overlay() {
        let base = "(context (protocol (version 1)) (evaluation-profile none) (inbox) (mind) (evaluation-environment (local-time (current 2026-08-11T12:00:00+08:00) (time-zone Asia/Shanghai) (utc-offset +08:00))) (evaluate (root-input test)))";
        assert_eq!(
            compose_context_encoding(base, EvaluationContextOverlay::default()).unwrap(),
            base
        );

        let context = compose_context_encoding(
            base,
            EvaluationContextOverlay {
                runtime_directive: Some(("work", "继续执行")),
                ..EvaluationContextOverlay::default()
            },
        )
        .unwrap();
        let parsed = crate::sexpr::parse(&context).expect("composed context must remain valid");
        assert_eq!(
            parsed
                .get_path(&["evaluation-environment", "local-time", "time-zone"])
                .map(ToString::to_string)
                .as_deref(),
            Some("Asia/Shanghai")
        );
        assert!(context.contains("(runtime-directive (kind work)"));
        assert!(context.find("(local-time").unwrap() < context.find("(runtime-directive").unwrap());
        assert!(context.find("(runtime-directive").unwrap() < context.find("(evaluate ").unwrap());
    }

    #[test]
    fn semantic_prompt_marks_infer_harness_entry_as_model_owned_program() {
        let package = crate::harness_package::HarnessPackage::from_source(
            "research.hns",
            r#"
                (manifest
                  (id research)
                  (version "1.0.0")
                  (title "Research"))
                (contract (identity "research"))
                (infer (task "形成有证据边界的研究结论"))
            "#,
        )
        .unwrap();
        let registry = DomainHarnessRegistry::default();
        registry.register_package(package.clone()).unwrap();
        let harness = registry.get("research", "1.0.0").unwrap();
        let binding = HarnessBinding {
            harness_id: "research".to_string(),
            harness_version: "1.0.0".to_string(),
            artifact_hash: package.artifact_hash,
            scope: crate::harness::HarnessBindingScope::Evaluation,
            objective_id: Some("objective-research".to_string()),
            evaluation_id: Some("evaluation-research".to_string()),
            inherited_from_objective_id: Some("objective-research".to_string()),
        };
        let rendered = render_harness_context(&binding, harness.as_ref()).unwrap();

        assert!(rendered.profile.contains("(entry (owner model)"));
        assert!(rendered.profile.contains("(program (infer"));
        assert!(rendered
            .profile
            .contains("active entry program for the current Evaluation"));
    }

    #[test]
    fn harness_entry_tools_follow_explicit_eval_or_infer_owner() {
        let runtime = vec!["list_files".to_string(), "read".to_string()];
        let model = ["read", "write", "exec", "eval", "no_reply"]
            .into_iter()
            .map(|name| ToolDefinition {
                name: name.to_string(),
                description: String::new(),
                parameters: json!({"type": "object"}),
            })
            .collect::<Vec<_>>();

        assert_eq!(
            harness_entry_callable_tools(
                crate::sexpr_eval::EvaluationOwner::Runtime,
                &runtime,
                &model,
            ),
            runtime
        );
        assert_eq!(
            harness_entry_callable_tools(crate::sexpr_eval::EvaluationOwner::Model, &[], &model,),
            vec!["read".to_string(), "write".to_string(), "exec".to_string()]
        );
    }

    #[test]
    fn runtime_harness_entry_only_dispatches_at_root_evaluation_boundary() {
        assert!(should_dispatch_runtime_harness_entry("self", "work"));
        assert!(should_dispatch_runtime_harness_entry(
            "objective",
            "soft-checkpoint"
        ));
        assert!(!should_dispatch_runtime_harness_entry("plan_infer", "work"));
        assert!(!should_dispatch_runtime_harness_entry(
            "self",
            "critical-maintenance"
        ));
        assert!(!should_dispatch_runtime_harness_entry(
            "self",
            "final-reply"
        ));
    }

    #[test]
    fn plan_infer_tool_scope_distinguishes_inheritance_from_explicit_purity() {
        let base = serde_json::Map::from_iter([
            ("context_id".to_string(), json!("context-1")),
            ("session_id".to_string(), json!("session-1")),
        ]);
        let inherited = Event::new(
            "infer-inherited".to_string(),
            "Runtime".to_string(),
            TYPE_INFER_REQUEST.to_string(),
            "chat/infer_request".to_string(),
            base.clone(),
        );
        assert_eq!(plan_infer_tool_scope(&inherited).unwrap(), None);

        let mut pure_payload = base.clone();
        pure_payload.insert("tools".to_string(), json!([]));
        let pure = Event::new(
            "infer-pure".to_string(),
            "Runtime".to_string(),
            TYPE_INFER_REQUEST.to_string(),
            "chat/infer_request".to_string(),
            pure_payload,
        );
        assert_eq!(plan_infer_tool_scope(&pure).unwrap(), Some(HashSet::new()));

        let mut scoped_payload = base;
        scoped_payload.insert("tools".to_string(), json!(["read"]));
        let scoped = Event::new(
            "infer-scoped".to_string(),
            "Runtime".to_string(),
            TYPE_INFER_REQUEST.to_string(),
            "chat/infer_request".to_string(),
            scoped_payload,
        );
        let scope = plan_infer_tool_scope(&scoped).unwrap().unwrap();
        let mut tools = ["read", "edit"]
            .into_iter()
            .map(|name| ToolDefinition {
                name: name.to_string(),
                description: String::new(),
                parameters: json!({"type": "object"}),
            })
            .collect::<Vec<_>>();
        restrict_tools_to_scope(&mut tools, Some(&scope));
        assert_eq!(
            tools.into_iter().map(|tool| tool.name).collect::<Vec<_>>(),
            vec!["read"]
        );
    }

    fn named_tools(names: &[&str]) -> Vec<ToolDefinition> {
        names
            .iter()
            .map(|name| ToolDefinition {
                name: (*name).to_string(),
                description: String::new(),
                parameters: json!({"type": "object"}),
            })
            .collect()
    }

    #[test]
    fn critical_and_final_phases_preserve_bound_objective_control() {
        let mut critical = named_tools(&[
            "context_tx",
            "recall",
            "exec",
            "objective_update",
            "objective_amend",
        ]);
        retain_context_maintenance_tools(&mut critical, true, false);
        assert_eq!(
            critical
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["context_tx", "recall", "objective_update"]
        );

        let mut unbound_critical = named_tools(&[
            "context_tx",
            "recall",
            "exec",
            "objective_update",
            "objective_amend",
        ]);
        retain_context_maintenance_tools(&mut unbound_critical, false, true);
        assert_eq!(
            unbound_critical
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["context_tx", "recall", "objective_amend"]
        );

        let mut final_reply = named_tools(&["exec", "objective_update", "objective_amend"]);
        retain_final_reply_control_tools(&mut final_reply, true, false);
        assert_eq!(final_reply[0].name, "objective_update");

        let mut unbound_final_reply = named_tools(&["exec", "objective_update", "objective_amend"]);
        retain_final_reply_control_tools(&mut unbound_final_reply, false, true);
        assert_eq!(unbound_final_reply[0].name, "objective_amend");
    }

    #[test]
    fn objective_supervision_always_uses_execution_threads() {
        let supervisor_entry = Event::new(
            "objective-supervisor-entry".to_string(),
            "Runtime".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [("tool_name".to_string(), json!("objective_supervisor"))]
                .into_iter()
                .collect(),
        );
        assert_eq!(
            derived_thread_kind(&supervisor_entry, true),
            crate::memory::ThreadKind::Execution
        );

        let work_entry = Event::new(
            "objective-work-entry".to_string(),
            "Runtime".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            [("tool_name".to_string(), json!("read"))]
                .into_iter()
                .collect(),
        );
        assert_eq!(
            derived_thread_kind(&work_entry, true),
            crate::memory::ThreadKind::Execution
        );

        let current = crate::memory::ThreadSupervision::objective(
            "objective-1",
            "evaluation-current",
            3,
            None,
        );
        let now = chrono::Utc::now();
        let mut objective = crate::memory::ObjectiveRecord {
            id: "objective-1".into(),
            agent_id: "agent-1".into(),
            context_id: "context-1".into(),
            coordinator_session_id: "session-1".into(),
            delivery_session_id: "session-1".into(),
            parent_objective_id: None,
            source_event_id: "source-1".into(),
            initiating_principal_id: None,
            stated_objective: "test".into(),
            revision: 3,
            generation: 1,
            status: crate::memory::ObjectiveStatus::Active,
            status_reason: None,
            wait_condition: None,
            completion_intent: None,
            active_evaluation_id: Some("evaluation-current".into()),
            evaluation_lease_expires_at: None,
            continuation_sequence: 0,
            token_budget: None,
            tokens_used: 0,
            time_used_seconds: 0,
            created_at: now,
            updated_at: now,
        };
        assert!(objective_supervision_matches_state(
            &current,
            Some(&objective)
        ));
        objective.active_evaluation_id = Some("evaluation-replacement".into());
        assert!(!objective_supervision_matches_state(
            &current,
            Some(&objective)
        ));

        let primary = crate::memory::ThreadSupervision::objective_primary_execution(
            "objective-1",
            objective.generation,
        );
        objective.active_evaluation_id = None;
        assert!(objective_supervision_matches_state(
            &primary,
            Some(&objective)
        ));
        objective.generation += 1;
        assert!(!objective_supervision_matches_state(
            &primary,
            Some(&objective)
        ));
    }

    #[test]
    fn cognitive_vm_prompt_changes_identity_without_task_specific_hints() {
        let baseline = baseline_system_prompt();
        let candidate = cognitive_sexpr_vm_system_prompt();
        assert_ne!(baseline, candidate);
        assert!(baseline.contains(crate::sexpr_vm_contract::MORPHZ_MACHINE_NAME_EN));
        assert!(baseline.contains("nondeterministic semantic processor"));
        assert!(!baseline.contains("AI Agent that manages its own working Context"));
        assert!(!baseline.contains("Cognitive S-Expression Machine"));
        assert!(!baseline.contains("S-expression semantic virtual machine"));
        assert!(candidate.contains(crate::sexpr_vm_contract::MORPHZ_MACHINE_NAME_EN));
        assert!(candidate.contains("nondeterministic semantic processor"));
        assert!(!candidate.contains("Cognitive S-Expression Machine"));
        assert!(!candidate.contains("S-expression semantic virtual machine"));
        assert!(candidate.contains("nondeterministic execution cycle"));
        assert!(candidate.contains("persistent symbolic program and cognitive state"));
        assert!(candidate.contains("applicability, sources, counterexamples, and uncertainty"));
        assert!(candidate.contains("Every response must explicitly choose"));
        assert!(candidate.contains("Runtime Reality Contract"));
        assert!(!contains_cjk(candidate));
        for leaked_task_hint in ["ALPHA", "BETA", "CHARLIE", "approved-current"] {
            assert!(!candidate.contains(leaked_task_hint));
        }
    }

    #[test]
    fn semantic_vm_prompt_is_a_parseable_third_profile_with_shared_rules() {
        let baseline = baseline_system_prompt();
        let cognitive = cognitive_sexpr_vm_system_prompt();
        let semantic = semantic_sexpr_vm_system_prompt();
        assert_ne!(semantic, baseline);
        assert_ne!(semantic, cognitive);
        assert!(semantic.starts_with("(system-prompt morphz"));
        crate::sexpr::parse(semantic).expect("semantic profile must be one S-expression");
        assert!(semantic.contains(crate::sexpr_vm_contract::MORPHZ_MACHINE_NAME_EN));
        assert!(semantic.contains("nondeterministic semantic processor"));
        assert!(!semantic.contains("Cognitive S-Expression Machine"));
        assert!(!semantic.contains("S-expression semantic virtual machine"));
        for marker in [
            "(operator seq",
            "(operator call",
            "(operator fallback",
            "(operator bind",
            "(operator if",
            "(operator reply",
            "ordinary assistant text",
            "not a model-response format",
            "never send the (reply ...) parentheses, operator name, or a code fence to the Session",
            "no_reply",
            "runtime-contracts",
            "reality-contract-v1",
            "claims-no-stronger-than-sources",
            "Every response must explicitly choose",
            "protocol.skill-discovery-contract fallback",
            "do not preload all Skills",
        ] {
            assert!(semantic.contains(marker), "missing marker: {marker}");
        }
        for leaked_task_hint in ["ALPHA", "BETA", "CHARLIE", "approved-current"] {
            assert!(!semantic.contains(leaked_task_hint));
        }
        assert!(!contains_cjk(semantic));
    }

    #[test]
    fn production_prompt_inspection_uses_the_authoritative_selected_profile() {
        let inspection = production_system_prompt_inspection().unwrap();
        let mode = super::SystemPromptMode::from_environment().unwrap();
        assert_eq!(inspection.profile, mode.as_str());
        assert_eq!(inspection.content, super::render_stable_system_prompt(mode));
        if mode == super::SystemPromptMode::SemanticSexprVm {
            crate::sexpr::parse(inspection.content).expect(
                "the semantic production System Prompt must remain a complete S-expression",
            );
        }
    }

    #[test]
    fn runtime_directives_live_in_context_tail_not_system_prompt() {
        let stable = semantic_sexpr_vm_system_prompt().to_string();
        let composed = compose_context_encoding(
            "(context (protocol (version 1)) (evaluation-profile none) (inbox) (mind) (evaluation-environment) (evaluate (root-input test)))",
            EvaluationContextOverlay {
                runtime_directive: Some((
                    "final-reply",
                    "仅在本轮动态尾部返回最终文本",
                )),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(composed.starts_with("(context"));
        assert!(composed.contains("(runtime-directive"));
        assert!(composed.contains("(kind final-reply)"));
        assert!(composed.find("(runtime-directive").unwrap() > composed.find("(inbox").unwrap());
        assert!(
            composed.find("(runtime-directive").unwrap() < composed.find("(evaluate ").unwrap()
        );
        crate::sexpr::parse(&composed).expect("dynamic Context must remain one SExpr");
        assert_eq!(stable, semantic_sexpr_vm_system_prompt());
        assert!(!stable.contains("仅在本轮动态尾部返回最终文本"));
    }

    #[test]
    fn response_classifier_accepts_plain_text_and_exclusive_no_reply() {
        let plain = crate::llm::Response {
            content: "done".to_string(),
            tool_calls: Vec::new(),
        };
        assert_eq!(
            classify_terminal_response(&plain),
            Ok(Some(TerminalDecision::Deliver("done".to_string())))
        );

        let no_reply = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: "no-reply-1".to_string(),
                r#type: "function".to_string(),
                func_name: "no_reply".to_string(),
                arguments: json!({"mode":"silent"}).to_string(),
            }],
        };
        assert_eq!(
            classify_terminal_response(&no_reply),
            Ok(Some(TerminalDecision::NoReply(NoReplyMode::Silent)))
        );

        let mixed = crate::llm::Response {
            content: "not silent".to_string(),
            tool_calls: no_reply.tool_calls,
        };
        assert!(classify_terminal_response(&mixed).is_err());
    }

    #[test]
    fn closure_review_requires_a_durable_state_or_action_commit() {
        let plain = Some(TerminalDecision::Deliver("看起来已经完成".to_string()));
        let error = validate_objective_closure_review_response(true, plain)
            .expect_err("closure-review cannot terminate with an uncommitted narrative");
        assert!(error.contains("Runtime reports only"));
        assert!(error.contains("does not decide"));

        let silent = Some(TerminalDecision::NoReply(NoReplyMode::Silent));
        assert!(validate_objective_closure_review_response(true, silent).is_err());

        assert_eq!(
            validate_objective_closure_review_response(true, None),
            Ok(None),
            "a real tool or Objective control action satisfies the review boundary"
        );
        assert_eq!(
            validate_objective_closure_review_response(
                false,
                Some(TerminalDecision::Deliver("普通回复".to_string()))
            ),
            Ok(Some(TerminalDecision::Deliver("普通回复".to_string()))),
            "ordinary evaluations keep their existing terminal protocol"
        );
    }

    #[test]
    fn final_reply_allows_only_the_bound_objective_control_action() {
        let objective_update = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: "objective-update-1".to_string(),
                r#type: "function".to_string(),
                func_name: "objective_update".to_string(),
                arguments: json!({
                    "status": "completed",
                    "reason": "验收证据满足"
                })
                .to_string(),
            }],
        };
        assert_eq!(
            validate_final_reply_response("final-reply", true, &objective_update, None),
            Ok(None)
        );
        assert!(
            validate_final_reply_response("final-reply", false, &objective_update, None).is_err()
        );

        let physical_tool = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: "exec-1".to_string(),
                r#type: "function".to_string(),
                func_name: "exec".to_string(),
                arguments: json!({"command":"true"}).to_string(),
            }],
        };
        assert!(validate_final_reply_response("final-reply", true, &physical_tool, None).is_err());
        assert_eq!(
            validate_final_reply_response("work", true, &physical_tool, None),
            Ok(None)
        );

        assert!(completed_objective_update_call(&objective_update));
        assert!(validate_objective_completion_call(&objective_update).is_ok());
        let mut mixed_completion = objective_update.clone();
        mixed_completion.content = "提前写出的最终报告".to_string();
        assert!(validate_objective_completion_call(&mixed_completion).is_err());

        let final_text = Some(TerminalDecision::Deliver("完整最终报告".to_string()));
        assert_eq!(
            validate_final_reply_response(
                "objective-finalization",
                true,
                &crate::llm::Response {
                    content: "完整最终报告".to_string(),
                    tool_calls: Vec::new(),
                },
                final_text.clone(),
            ),
            Ok(final_text)
        );
        assert!(validate_final_reply_response(
            "objective-finalization",
            true,
            &physical_tool,
            None,
        )
        .is_err());
        assert!(validate_final_reply_response(
            "objective-finalization",
            true,
            &crate::llm::Response {
                content: String::new(),
                tool_calls: Vec::new(),
            },
            Some(TerminalDecision::NoReply(NoReplyMode::Wait)),
        )
        .is_err());
    }

    #[test]
    fn critical_pressure_with_exhausted_maintenance_budget_forces_final_reply() {
        assert!(should_force_final_for_maintenance(
            "work", "critical", false
        ));
        assert!(!should_force_final_for_maintenance(
            "work", "warning", false
        ));
        assert!(!should_force_final_for_maintenance(
            "work", "critical", true
        ));
        assert!(should_force_final_for_maintenance(
            "soft-checkpoint",
            "critical",
            false
        ));
    }

    #[test]
    fn critical_recovery_uses_a_separate_high_safety_budget() {
        assert!(critical_maintenance_transaction_available(6));
        assert!(critical_maintenance_transaction_available(255));
        assert!(!critical_maintenance_transaction_available(256));
    }

    #[test]
    fn tool_call_activity_preview_is_structured_redacted_and_bounded() {
        let secret_call = crate::llm::ToolCallRepr {
            id: "exec-1".to_string(),
            r#type: "function".to_string(),
            func_name: "exec".to_string(),
            arguments: json!({
                "cmd": "run",
                "env": {
                    "OPENAI_API_KEY": "local-secret",
                    "max_tokens": 128000
                }
            })
            .to_string(),
        };
        let secret_preview = tool_call_activity_preview(&secret_call);
        let arguments = secret_preview["arguments"].as_str().unwrap();
        assert_eq!(secret_preview["name"], "exec");
        assert_eq!(secret_preview["truncated"], false);
        assert!(arguments.contains("[REDACTED]"));
        assert!(!arguments.contains("local-secret"));
        assert!(arguments.contains("max_tokens"));

        let long_call = crate::llm::ToolCallRepr {
            id: "write-1".to_string(),
            r#type: "function".to_string(),
            func_name: "write".to_string(),
            arguments: json!({"body": "x".repeat(5_000)}).to_string(),
        };
        let long_preview = tool_call_activity_preview(&long_call);
        assert_eq!(long_preview["truncated"], true);
        assert!(long_preview["arguments"]
            .as_str()
            .unwrap()
            .contains("参数预览已截断"));
    }

    #[test]
    fn exec_results_expose_physical_facts_without_copying_output_fields() {
        let mut payload = serde_json::Map::new();
        extend_exec_output_facts(
            &mut payload,
            &json!({
                "kind":"exec_result",
                "execution":"completed",
                "process_status":"failed",
                "exit_code":7,
                "effective_boundary":{"network_enabled":false},
                "artifact_path":"/tmp/task.log",
                "output":"boom"
            })
            .to_string(),
        );
        assert_eq!(payload["process_status"], "failed");
        assert_eq!(payload["exit_code"], 7);
        assert_eq!(payload["effective_boundary"]["network_enabled"], false);
        assert_eq!(payload["artifact_path"], "/tmp/task.log");
        assert!(!payload.contains_key("output"));
    }

    #[test]
    fn model_visible_attachment_references_are_recursive_ordered_and_deduplicated() {
        let value = json!({
            "task": "inspect",
            "evidence": {
                "model_attachments": [
                    {
                        "id": "attachment-a",
                        "sha256": "aaa",
                        "source_event_id": "output-1"
                    },
                    {
                        "id": "attachment-a",
                        "sha256": "aaa",
                        "source_event_id": "output-1"
                    },
                    {
                        "nested": {
                            "id": "attachment-b",
                            "sha256": "bbb",
                            "source_event_id": "output-2"
                        }
                    }
                ]
            }
        });

        assert_eq!(
            model_visible_attachment_references(&value),
            vec![
                ModelVisibleAttachmentReference {
                    id: "attachment-a".to_string(),
                    sha256: "aaa".to_string(),
                    source_event_id: "output-1".to_string(),
                },
                ModelVisibleAttachmentReference {
                    id: "attachment-b".to_string(),
                    sha256: "bbb".to_string(),
                    source_event_id: "output-2".to_string(),
                },
            ]
        );
    }

    #[test]
    fn action_group_recovery_rebuilds_the_exact_durable_barrier_route() {
        let now = chrono::Utc::now();
        let group = ActionGroupRecord {
            id: "group-recovery".to_string(),
            revision: 2,
            activation_id: "activation-recovery".to_string(),
            thread_id: "thread-recovery".to_string(),
            agent_id: "agent-recovery".to_string(),
            context_id: "context-recovery".to_string(),
            session_id: "session-recovery".to_string(),
            assistant_call_event_id: "call-attempt-recovery".to_string(),
            objective_id: Some("objective-recovery".to_string()),
            objective_evaluation_id: Some("evaluation-recovery".to_string()),
            objective_revision: Some(7),
            status: crate::memory::ActionGroupStatus::Running,
            member_count: 2,
            terminal_member_count: 1,
            created_at: now,
            updated_at: now,
            settled_at: None,
        };
        let selected = Event::new(
            "tool_calls_selected_attempt-recovery".to_string(),
            "test".to_string(),
            "runtime_control".to_string(),
            "runtime/tool_calls_selected".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(group.context_id)),
                ("session_id".to_string(), json!(group.session_id)),
                ("activation_id".to_string(), json!(group.activation_id)),
                ("thread_id".to_string(), json!(group.thread_id)),
                ("root_turn_id".to_string(), json!("root-recovery")),
                ("trigger_event_id".to_string(), json!("trigger-recovery")),
                ("trigger_sequence".to_string(), json!(11)),
                ("principal_id".to_string(), json!("principal-recovery")),
            ]),
        );
        let settled =
            recovered_action_group_settled_event(&group, &selected, "direct_signal").unwrap();
        assert_eq!(settled.id, "action_group_settled_group-recovery");
        assert_eq!(settled.payload["action_group_id"], group.id);
        assert_eq!(settled.payload["thread_id"], group.thread_id);
        assert_eq!(settled.payload["wake_policy"], "direct_signal");
        assert_eq!(settled.payload["objective_revision"], 7);
    }

    #[tokio::test]
    async fn action_group_recovery_converges_from_durable_member_results_without_restart() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("group-recovery.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let context_engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            crate::config::OrchestratorConfig::default(),
        );
        let group_id = "group-live-recovery";
        let activation_id = "activation-live-recovery";
        let context_id = "context-live-recovery";
        let session_id = "session-live-recovery";
        let thread_id = "thread-live-recovery";
        store
            .create_agent_bundle(
                NewAgent {
                    id: "agent-live-recovery".to_string(),
                    title: "Recovery Agent".to_string(),
                    root_context_id: context_id.to_string(),
                },
                NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: "agent-live-recovery".to_string(),
                    title: "Recovery Context".to_string(),
                },
                NewSession {
                    id: session_id.to_string(),
                    agent_id: "agent-live-recovery".to_string(),
                    context_id: context_id.to_string(),
                    parent_session_id: None,
                    title: "Recovery Session".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        let selected = Event::new(
            "tool_calls_selected_attempt-live-recovery".to_string(),
            "test".to_string(),
            "runtime_control".to_string(),
            "runtime/tool_calls_selected".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!(context_id)),
                ("session_id".to_string(), json!(session_id)),
                ("activation_id".to_string(), json!(activation_id)),
                ("thread_id".to_string(), json!(thread_id)),
                ("root_turn_id".to_string(), json!("root-live-recovery")),
                (
                    "trigger_event_id".to_string(),
                    json!("trigger-live-recovery"),
                ),
                ("trigger_sequence".to_string(), json!(17)),
                ("action_group_wake_policy".to_string(), json!("none")),
            ]),
        );
        store.append(selected.clone()).await.unwrap();
        let selected_sequence = store
            .query(QueryFilter {
                event_id: Some(selected.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()[0]
            .sequence
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: thread_id.to_string(),
                agent_id: "agent-live-recovery".to_string(),
                context_id: context_id.to_string(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                root_turn_id: "root-live-recovery".to_string(),
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
                id: activation_id.to_string(),
                agent_id: "agent-live-recovery".to_string(),
                context_id: context_id.to_string(),
                session_id: session_id.to_string(),
                initiating_principal_id: None,
                trigger_event_id: selected.id.clone(),
                trigger_sequence: selected_sequence,
                trigger_kind: selected.topic.clone(),
                parent_activation_id: None,
                root_turn_id: "root-live-recovery".to_string(),
            })
            .await
            .unwrap();
        store
            .append(Event::new(
                "call_attempt-live-recovery".to_string(),
                "test".to_string(),
                crate::event::TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                serde_json::Map::from_iter([
                    ("context_id".to_string(), json!(context_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("activation_id".to_string(), json!(activation_id)),
                    ("thread_id".to_string(), json!(thread_id)),
                ]),
            ))
            .await
            .unwrap();
        let group = store
            .create_action_group(
                NewActionGroup {
                    id: group_id.to_string(),
                    activation_id: activation_id.to_string(),
                    thread_id: thread_id.to_string(),
                    agent_id: "agent-live-recovery".to_string(),
                    context_id: context_id.to_string(),
                    session_id: session_id.to_string(),
                    assistant_call_event_id: "call_attempt-live-recovery".to_string(),
                    objective_id: None,
                    objective_evaluation_id: None,
                    objective_revision: None,
                },
                vec![
                    NewActionGroupMember {
                        ordinal: 0,
                        tool_call_id: "call-a".to_string(),
                        tool_name: "read".to_string(),
                        execution_job_id: None,
                    },
                    NewActionGroupMember {
                        ordinal: 1,
                        tool_call_id: "call-b".to_string(),
                        tool_name: "search".to_string(),
                        execution_job_id: None,
                    },
                ],
            )
            .await
            .unwrap();
        for tool_call_id in ["call-a", "call-b"] {
            store
                .append(Event::new(
                    format!("output_{activation_id}_{tool_call_id}"),
                    "test".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    serde_json::Map::from_iter([
                        ("context_id".to_string(), json!(context_id)),
                        ("action_group_id".to_string(), json!(group_id)),
                        ("tool_call_id".to_string(), json!(tool_call_id)),
                        ("tool_status".to_string(), json!("success")),
                    ]),
                ))
                .await
                .unwrap();
        }

        assert_eq!(
            recover_action_group_from_durable_events(&context_engine, &group, store.as_ref(),)
                .await
                .unwrap(),
            2
        );
        let recovered = store.get_action_group(group_id).await.unwrap().unwrap();
        assert_eq!(recovered.status, ActionGroupStatus::Settled);
        assert_eq!(recovered.terminal_member_count, 2);
        assert_eq!(
            recover_action_group_from_durable_events(&context_engine, &recovered, store.as_ref(),)
                .await
                .unwrap(),
            0,
            "convergence replay must be idempotent"
        );
    }
}
