export interface ThreadSignalRecord {
  id: string
  thread_id: string
  event_id: string
  sequence: number
  kind: string
  parent_activation_id?: string
  status: 'pending' | 'claimed' | 'acknowledged'
  created_at: string
  claimed_at?: string
  acknowledged_at?: string
}

export interface ThreadActivationRecord {
  id: string
  revision: number
  generation?: number
  agent_id: string
  context_id: string
  session_id: string
  trigger_event_id: string
  trigger_sequence: number
  trigger_kind: string
  parent_activation_id?: string
  root_turn_id: string
  context_snapshot_version?: number
  status: 'queued' | 'running' | 'succeeded' | 'cancelled' | 'failed'
  claimed_by?: string
  lease_expires_at?: string
  created_at: string
  updated_at: string
}

export interface ThreadRecord {
  id: string
  revision: number
  generation: number
  agent_id: string
  context_id: string
  session_id: string
  initiating_principal_id?: string
  root_turn_id: string
  kind: 'dialogue_turn' | 'execution' | 'delivery'
  lifecycle: 'open' | 'completed' | 'failed' | 'cancelled'
  control_state: 'active' | 'paused'
  executor_kind: string
  executor_id?: string
  target_id?: string
  supervision: {
    lifetime: 'attached' | 'durable' | 'disposable'
    supervisor_kind: 'thread' | 'evaluation' | 'objective' | 'runtime' | 'none' | 'legacy'
    supervisor_id?: string
    generation: number
    origin_evaluation_id?: string
    parent_thread_id?: string
    thread_group_id?: string
    completion_contract: unknown
  }
  result_text?: string
  result_event_id?: string
  delivery_status: 'none' | 'pending' | 'deferred' | 'delivered'
  delivery_event_id?: string
  created_at: string
  updated_at: string
}

export interface ScheduleRecord {
  id: string
  revision: number
  thread_id: string
  source_turn_id: string
  intent: string
  status: 'queued' | 'paused' | 'dispatched' | 'completed' | 'cancelled'
  not_before?: string
  interval_seconds?: number
  dependency_thread_ids: string[]
  created_at: string
  updated_at: string
}

export interface ApprovalRecord {
  id: string
  revision: number
  job_id: string
  request_digest: string
  policy_digest: string
  action: unknown
  requested: unknown
  justification: string
  status: 'pending_auto' | 'pending_human' | 'allowed' | 'denied' | 'cancelled'
  rationale?: string
  risk_tags: string[]
  grant_id?: string
  grant_consumed_at?: string
  consumed_by_claim_token?: string
  cancel_reason?: string
  last_error?: string
  created_at: string
  updated_at: string
  decided_at?: string
  cancelled_at?: string
}

export type ApprovalDecision = 'allow_once' | 'allow_thread' | 'allow_objective' | 'allow_session' | 'deny'

export interface ExecutionJobRecord {
  id: string
  revision: number
  activation_id: string
  thread_id: string
  agent_id: string
  context_id: string
  session_id: string
  initiating_principal_id?: string
  target_id: string
  tool_call_id: string
  tool_name: string
  request: unknown
  status: 'queued' | 'waiting_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost'
  retry_safety: 'idempotent' | 'reconcile_required' | 'at_most_once'
  claimed_by?: string
  claim_token?: string
  lease_expires_at?: string
  heartbeat_at?: string
  approval_ref?: string
  side_effect_started_at?: string
  cancel_requested_at?: string
  cancel_reason?: string
  progress_ref?: string
  checkpoint_generation?: number
  checkpoint_due_at?: string
  result_event_id?: string
  result_refs: string[]
  error?: string
  exit_code?: number
  created_at: string
  started_at?: string
  updated_at: string
  finished_at?: string
}

export interface SchedulerResultSnapshot {
  event_id?: string
  status: ExecutionJobRecord['status']
  refs: string[]
  error?: string
  exit_code?: number
  finished_at?: string
}

export interface SchedulerJobSnapshot {
  job: ExecutionJobRecord
  approval?: ApprovalRecord
  result?: SchedulerResultSnapshot
}

export interface SchedulerActivationSnapshot {
  activation: ThreadActivationRecord
  signals: ThreadSignalRecord[]
  jobs: SchedulerJobSnapshot[]
}

export interface SchedulerThreadSnapshot {
  thread: ThreadRecord
  phase: 'idle' | 'runnable' | 'running' | 'waiting'
  outcome?: ThreadOutcomeRecord
  pending_signals: ThreadSignalRecord[]
  activations: SchedulerActivationSnapshot[]
  schedules: ScheduleRecord[]
}

export interface ThreadGroupRecord {
  id: string
  revision: number
  context_id: string
  session_id: string
  supervisor_kind: 'thread' | 'evaluation' | 'objective' | 'runtime' | 'none' | 'legacy'
  supervisor_id: string
  generation: number
  policy: 'all' | 'any'
  required_count: number
  terminal_count: number
  successful_count: number
  status: 'open' | 'satisfied' | 'failed' | 'cancelled'
  completion_contract: unknown
  terminal_summary: unknown
  barrier_event_id?: string
  created_at: string
  updated_at: string
  satisfied_at?: string
}

export interface ThreadGroupMemberRecord {
  group_id: string
  thread_id: string
  ordinal: number
  required: boolean
  status: 'pending' | 'completed' | 'failed' | 'cancelled'
  outcome_id?: string
  created_at: string
  updated_at: string
}

export interface ThreadOutcomeRecord {
  id: string
  thread_id: string
  thread_generation: number
  root_turn_id: string
  activation_id: string
  session_id: string
  terminal_kind: 'completed' | 'failed' | 'cancelled'
  disposition: string
  summary?: string
  result_event_id: string
  artifact_refs: string[]
  evidence_refs: string[]
  check_results: unknown
  unresolved_failures: string[]
  terminal_event_sequence?: number
  created_at: string
  delivered_at?: string
}

export interface SchedulerThreadGroupSnapshot {
  group: ThreadGroupRecord
  members: ThreadGroupMemberRecord[]
  outcomes: ThreadOutcomeRecord[]
}

export interface ThreadDetailResponse {
  context_id: string
  generated_at: string
  snapshot: SchedulerThreadSnapshot
  model_attempt_events: Array<{
    id: string
    sequence?: number
    timestamp: string
    actor: string
    type: string
    topic: string
    payload: Record<string, unknown>
  }>
}

export interface SchedulerSummary {
  open_threads: number
  pending_signals: number
  queued_activations: number
  running_activations: number
  active_jobs: number
  waiting_approval_jobs: number
  pending_approvals: number
  active_schedules: number
  deferred_activations: number
  runnable_objectives: number
  waiting_objectives: number
  invariant_violations: number
}

export interface SchedulerDetailBounds {
  limit: number
  has_more_sessions: boolean
  has_more_objectives: boolean
  has_more_threads: boolean
  has_more_activations: boolean
  has_more_signals: boolean
  has_more_jobs: boolean
  has_more_approvals: boolean
  has_more_thread_groups: boolean
}

export interface SchedulerContextRecord {
  id: string
  agent_id: string
  title: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  requested_hard_token_limit?: number
  token_budget_revision: number
}

export interface SchedulerSessionRecord {
  id: string
  agent_id: string
  context_id: string
  parent_session_id?: string
  title: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  last_activity_at: string
  attention_state: string
  attention_revision: number
}

export interface SchedulerDependencyRecord {
  id: string
  owner_kind: 'objective' | 'thread' | 'plan' | 'schedule' | 'delivery'
  owner_id: string
  owner_generation: number
  dependency_kind: 'thread' | 'thread_group' | 'tool_task' | 'delegation' | 'timer' | 'permission' | 'user_input' | 'external_event' | 'resource'
  dependency_id: string
  dependency_generation: number
  required: boolean
  status: 'pending' | 'satisfied' | 'cancelled'
  metadata: unknown
  satisfied_by_event_id?: string
  created_at: string
  updated_at: string
  satisfied_at?: string
}

export type SchedulerObjectiveReadiness =
  | { state: 'runnable' }
  | { state: 'waiting'; dependency_ids: string[] }
  | { state: 'leased'; evaluation_id: string }
  | { state: 'paused' | 'blocked' | 'terminal' }

export interface SchedulerObjectiveSnapshot {
  objective: Record<string, unknown> & { id: string; status: string; generation: number }
  readiness: SchedulerObjectiveReadiness
  dependencies: SchedulerDependencyRecord[]
  active_evaluation?: ThreadActivationRecord
}

export interface SchedulerDeliverySnapshot {
  thread_id: string
  session_id: string
  generation: number
  status: 'none' | 'pending' | 'deferred' | 'delivered'
  event_id?: string
  updated_at: string
}

export interface SchedulerExternalOutboxSnapshot {
  id: string
  kind: string
  state: string
  destination?: string
  detail: unknown
  updated_at: string
}

export interface SchedulerInvariantViolation {
  severity: 'warning' | 'error' | 'quarantine'
  code: string
  entity_kind: string
  entity_id: string
  detail: string
}

export interface SchedulerAdmissionSnapshot {
  total_slots: number
  dialogue_delivery_slots: number
  max_queued: number
  dialogue_delivery_queue_slots: number
  aging_promotion_interval_ms: number
  queued_activation_ids: string[]
  in_flight_activation_ids: string[]
  waiter_count: number
  queued_by_class: Record<string, number>
  in_flight_by_class: Record<string, number>
  context_durable_queued: number
  context_durable_running: number
  context_loaded_queued: number
  context_in_flight: number
  context_deferred: number
}

export interface SchedulerSnapshot {
  context_id: string
  generated_at: string
  summary: SchedulerSummary
  detail_bounds: SchedulerDetailBounds
  admission: SchedulerAdmissionSnapshot
  event_writer: Record<string, unknown>
  model_provider: Record<string, unknown>
  context_capacity: Record<string, unknown>
  contexts: SchedulerContextRecord[]
  sessions: SchedulerSessionRecord[]
  objectives: SchedulerObjectiveSnapshot[]
  threads: SchedulerThreadSnapshot[]
  thread_groups: SchedulerThreadGroupSnapshot[]
  deliveries: SchedulerDeliverySnapshot[]
  external_outboxes: SchedulerExternalOutboxSnapshot[]
  invariant_violations: SchedulerInvariantViolation[]
  orphan_activations: SchedulerActivationSnapshot[]
  orphan_signals: ThreadSignalRecord[]
  orphan_jobs: SchedulerJobSnapshot[]
  orphan_approvals: ApprovalRecord[]
}
