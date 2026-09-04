import type { SchedulerThreadSnapshot } from '../scheduler/types.ts'

export type InputDestination =
  | { kind: 'thread'; thread_id: string; generation: number }
  | { kind: 'objective'; objective_id: string; generation: number; reply_to_request_id?: string }

export interface InputSelection {
  destination: InputDestination
  label: string
  sessionId: string
}

export function threadAssignment(snapshot: SchedulerThreadSnapshot, objective?: string): string | undefined {
  // Keep assignment distinct from live activity. Never label an arbitrary
  // child with the parent's entire goal if its own assignment is available.
  return snapshot.intent?.trim() || snapshot.schedules[0]?.intent?.trim() || objective?.trim() || undefined
}

export function threadDestination(snapshot: SchedulerThreadSnapshot): InputDestination {
  const owner = snapshot.thread.supervision
  return owner.supervisor_kind === 'objective' && owner.supervisor_id && !owner.origin_evaluation_id
    ? { kind: 'objective', objective_id: owner.supervisor_id, generation: owner.generation }
    : { kind: 'thread', thread_id: snapshot.thread.id, generation: snapshot.thread.generation }
}

export function canSteerThread(snapshot: SchedulerThreadSnapshot): boolean {
  const thread = snapshot.thread
  return thread.lifecycle === 'open' && thread.control_state === 'active'
    && thread.kind !== 'delivery' && thread.executor_kind === 'self'
}

export function objectiveReplyDestination(objective: {
  id: string; generation: number; revision: number; wait_condition?: { kind: string; [key: string]: unknown }
}): InputDestination {
  const wait = objective.wait_condition
  return {
    kind: 'objective', objective_id: objective.id, generation: objective.generation,
    ...(wait?.kind === 'user_input' ? {
      reply_to_request_id: typeof wait.request_id === 'string' ? wait.request_id : `legacy:${objective.id}:${objective.generation}:${objective.revision}`,
    } : {}),
  }
}
