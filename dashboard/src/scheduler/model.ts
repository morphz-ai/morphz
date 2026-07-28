import type {
  ApprovalRecord,
  ScheduleRecord,
  SchedulerJobSnapshot,
  SchedulerSnapshot,
  SchedulerThreadSnapshot,
} from './types'

export function schedulerJobs(snapshot: SchedulerSnapshot | null): SchedulerJobSnapshot[] {
  if (!snapshot) return []
  return [
    ...snapshot.threads.flatMap(thread => thread.activations.flatMap(activation => activation.jobs)),
    ...snapshot.orphan_activations.flatMap(activation => activation.jobs),
    ...snapshot.orphan_jobs,
  ]
}

export function schedulerApprovals(snapshot: SchedulerSnapshot | null): ApprovalRecord[] {
  if (!snapshot) return []
  return [
    ...schedulerJobs(snapshot).flatMap(job => job.approval ? [job.approval] : []),
    ...snapshot.orphan_approvals,
  ]
}

export function actionableSchedulerJobs(snapshot: SchedulerSnapshot | null): SchedulerJobSnapshot[] {
  if (!snapshot) return []
  return snapshot.threads
    .filter(thread => thread.thread.lifecycle === 'open')
    .flatMap(thread => thread.activations)
    .filter(activation => activation.activation.status === 'queued' || activation.activation.status === 'running')
    .flatMap(activation => activation.jobs)
}

export function pendingHumanApprovals(snapshot: SchedulerSnapshot | null): ApprovalRecord[] {
  return actionableSchedulerJobs(snapshot)
    .flatMap(job => job.approval ? [job.approval] : [])
    .filter(approval => approval.status === 'pending_human')
}

/// Non-terminal Jobs whose causal owner cannot receive a result, or whose
/// approval authority can no longer legally advance the Job. These are
/// repairable Runtime invariant violations, not actionable user approvals.
export function schedulerApprovalAnomalies(snapshot: SchedulerSnapshot | null): SchedulerJobSnapshot[] {
  if (!snapshot) return []
  const anomalies: SchedulerJobSnapshot[] = []
  for (const thread of snapshot.threads) {
    for (const activation of thread.activations) {
      for (const job of activation.jobs) {
        if (job.job.status !== 'waiting_approval') continue
        const ownerTerminal = thread.thread.lifecycle !== 'open'
          || !['queued', 'running'].includes(activation.activation.status)
        const authorityInvalid = !job.approval
          || job.approval.status === 'denied'
          || job.approval.status === 'cancelled'
        if (ownerTerminal || authorityInvalid) anomalies.push(job)
      }
    }
  }
  anomalies.push(...snapshot.orphan_jobs.filter(job => job.job.status === 'waiting_approval'))
  return anomalies
}

export function schedulerAttentionJobs(snapshot: SchedulerSnapshot | null): SchedulerJobSnapshot[] {
  if (!snapshot) return []
  // A failed tool call is part of the causal execution trace. The Agent can
  // normally correct its parameters, choose another capability, or retry it
  // without human help. Only a lost side-effect boundary is intrinsically
  // actionable because the external outcome is unknown and replay is unsafe.
  const jobs = snapshot.threads.flatMap(thread => thread.activations.flatMap(activation => (
    activation.jobs.filter(job => job.job.status === 'lost')
  )))
  jobs.push(...snapshot.orphan_jobs.filter(job => job.job.status === 'lost'))
  return jobs
}

export function schedulerSchedules(snapshot: SchedulerSnapshot | null): ScheduleRecord[] {
  if (!snapshot) return []
  return snapshot.threads.flatMap(thread => thread.schedules)
}

/**
 * The task board represents current control state. Terminal Schedule history
 * remains available inside the owning causal Thread instead of masquerading
 * as work that can still wake the Runtime.
 */
export function currentSchedulerSchedules(snapshot: SchedulerSnapshot | null): ScheduleRecord[] {
  return schedulerSchedules(snapshot)
    .filter(schedule => schedule.status === 'queued' || schedule.status === 'paused')
}

export function activeSchedulerThreads(snapshot: SchedulerSnapshot | null): SchedulerThreadSnapshot[] {
  if (!snapshot) return []
  return snapshot.threads.filter(thread => thread.phase !== 'idle')
}

/**
 * Activations shown as current work must belong to a Thread whose projected
 * phase is still active. Terminal history can retain an older `running`
 * Activation row for causal inspection; treating that row as present work
 * leaves the composer status stuck until a full page reload.
 */
export function activeSchedulerActivations(snapshot: SchedulerSnapshot | null) {
  return activeSchedulerThreads(snapshot)
    .filter(thread => thread.thread.lifecycle === 'open')
    .flatMap(thread => thread.activations)
    .map(item => item.activation)
    .filter(activation => activation.status === 'queued' || activation.status === 'running')
}

/**
 * Composer activity must not collapse model evaluation and physical work into
 * one ambiguous "running" number. Dialogue counts active DialogueTurn
 * Activations; execution counts authoritative non-terminal ExecutionJobs.
 */
export function schedulerActivityCounts(snapshot: SchedulerSnapshot | null): {
  dialogue: number
  execution: number
} {
  if (!snapshot) return { dialogue: 0, execution: 0 }
  const dialogue = activeSchedulerThreads(snapshot).reduce((count, thread) => {
    if (thread.thread.lifecycle !== 'open') return count
    if (thread.thread.kind !== 'dialogue_turn') return count
    return count + thread.activations.filter(item => (
      item.activation.status === 'queued' || item.activation.status === 'running'
    )).length
  }, 0)
  return { dialogue, execution: snapshot.summary.active_jobs }
}

export function attentionJobKey(
  kind: 'approval_anomaly' | 'execution_job',
  snapshot: SchedulerJobSnapshot,
): string {
  const approval = snapshot.approval
  return [
    kind,
    snapshot.job.id,
    `r${snapshot.job.revision}`,
    snapshot.job.status,
    approval ? `a${approval.revision}:${approval.status}` : 'approval:none',
  ].join(':')
}

export function attentionDeliveryKey(snapshot: SchedulerThreadSnapshot): string {
  return [
    'delivery',
    snapshot.thread.id,
    `r${snapshot.thread.revision}`,
    snapshot.thread.lifecycle,
    snapshot.thread.delivery_status,
  ].join(':')
}

/**
 * Pure dialogue is already visible in the message stream. Once a DialogueTurn
 * owns an ExecutionJob, however, hiding the Thread also hides the physical work
 * reported by the authoritative Scheduler summary.
 */
export function threadCarriesExecution(thread: SchedulerThreadSnapshot): boolean {
  return thread.thread.kind !== 'dialogue_turn'
    || thread.activations.some(activation => activation.jobs.length > 0)
}

/**
 * A failure reply is retryable only while it is still the authoritative
 * terminal result of the same logical DialogueTurn. This prevents an old
 * failure card from starting another generation after the Turn has already
 * been reopened, completed, or superseded by a newer result.
 */
export function retryableDialogueThread(
  threads: SchedulerThreadSnapshot[],
  eventId: string,
  payload: Record<string, unknown>,
): SchedulerThreadSnapshot | undefined {
  if (typeof payload.runtime_failure_kind !== 'string' || !payload.runtime_failure_kind.trim()) {
    return undefined
  }
  const threadId = typeof payload.thread_id === 'string' ? payload.thread_id : ''
  const rootTurnId = typeof payload.root_turn_id === 'string' ? payload.root_turn_id : ''
  return threads.find(snapshot => {
    const thread = snapshot.thread
    return thread.kind === 'dialogue_turn'
      && thread.lifecycle === 'failed'
      && thread.result_event_id === eventId
      && ((!threadId && !rootTurnId)
        || (threadId !== '' && thread.id === threadId)
        || (rootTurnId !== '' && thread.root_turn_id === rootTurnId))
  })
}

export function schedulerAttentionCount(snapshot: SchedulerSnapshot | null): number {
  if (!snapshot) return 0
  const failedDelivery = snapshot.threads.filter(item => (
    item.thread.lifecycle === 'completed'
    && item.thread.delivery_status !== 'delivered'
    && item.thread.delivery_status !== 'none'
  )).length
  return pendingHumanApprovals(snapshot).length
    + schedulerApprovalAnomalies(snapshot).length
    + schedulerAttentionJobs(snapshot).length
    + failedDelivery
}
