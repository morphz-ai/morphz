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
  const jobs = snapshot.threads.flatMap(thread => thread.activations.flatMap(activation => (
    activation.jobs.filter(job => (
      job.job.status === 'lost'
      || (thread.thread.lifecycle === 'open' && job.job.status === 'failed')
    ))
  )))
  jobs.push(...snapshot.orphan_jobs.filter(job => job.job.status === 'failed' || job.job.status === 'lost'))
  return jobs
}

export function schedulerSchedules(snapshot: SchedulerSnapshot | null): ScheduleRecord[] {
  if (!snapshot) return []
  return snapshot.threads.flatMap(thread => thread.schedules)
}

export function activeSchedulerThreads(snapshot: SchedulerSnapshot | null): SchedulerThreadSnapshot[] {
  if (!snapshot) return []
  return snapshot.threads.filter(thread => thread.thread.lifecycle === 'open')
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
