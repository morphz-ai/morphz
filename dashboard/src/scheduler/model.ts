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

export function pendingHumanApprovals(snapshot: SchedulerSnapshot | null): ApprovalRecord[] {
  return schedulerApprovals(snapshot).filter(approval => approval.status === 'pending_human')
}

export function schedulerSchedules(snapshot: SchedulerSnapshot | null): ScheduleRecord[] {
  if (!snapshot) return []
  return snapshot.threads.flatMap(thread => thread.schedules)
}

export function activeSchedulerThreads(snapshot: SchedulerSnapshot | null): SchedulerThreadSnapshot[] {
  if (!snapshot) return []
  return snapshot.threads.filter(thread => thread.thread.lifecycle === 'open')
}

export function schedulerAttentionCount(snapshot: SchedulerSnapshot | null): number {
  if (!snapshot) return 0
  const failedJobs = schedulerJobs(snapshot).filter(item => item.job.status === 'failed' || item.job.status === 'lost').length
  const failedDelivery = snapshot.threads.filter(item => (
    item.thread.lifecycle === 'completed'
    && item.thread.delivery_status !== 'delivered'
    && item.thread.delivery_status !== 'none'
  )).length
  return pendingHumanApprovals(snapshot).length + failedJobs + failedDelivery
}
