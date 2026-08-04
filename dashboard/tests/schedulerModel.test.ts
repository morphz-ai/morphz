import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attentionDeliveryKey,
  attentionJobKey,
  actionableSchedulerJobs,
  activeSchedulerActivations,
  activeSchedulerThreads,
  currentSchedulerSchedules,
  pendingHumanApprovals,
  schedulerApprovals,
  schedulerActivityCounts,
  schedulerApprovalAnomalies,
  schedulerAttentionJobs,
  schedulerAttentionCount,
  schedulerJobs,
  schedulerSchedules,
  threadCarriesExecution,
  retryableDialogueThread,
} from '../src/scheduler/model.ts'
import type { SchedulerSnapshot } from '../src/scheduler/types.ts'

function fixture(): SchedulerSnapshot {
  const now = '2026-07-17T00:00:00Z'
  return {
    context_id: 'context-test',
    generated_at: now,
    summary: {
      open_threads: 1,
      pending_signals: 0,
      queued_activations: 0,
      running_activations: 1,
      active_jobs: 1,
      waiting_approval_jobs: 1,
      pending_approvals: 1,
      active_schedules: 1,
      deferred_activations: 0,
    },
    admission: {
      total_slots: 4,
      dialogue_delivery_slots: 1,
      max_queued: 32,
      dialogue_delivery_queue_slots: 4,
      aging_promotion_interval_ms: 30_000,
      queued_activation_ids: [],
      in_flight_activation_ids: ['activation-1'],
      waiter_count: 0,
      queued_by_class: {},
      in_flight_by_class: { objective: 1 },
      context_durable_queued: 0,
      context_durable_running: 1,
      context_loaded_queued: 0,
      context_in_flight: 1,
      context_deferred: 0,
    },
    threads: [{
      thread: {
        id: 'thread-1',
        revision: 1,
        agent_id: 'agent-1',
        context_id: 'context-test',
        session_id: 'session-1',
        root_turn_id: 'turn-1',
        kind: 'execution',
        lifecycle: 'open',
        executor_kind: 'self',
        delivery_status: 'none',
        created_at: now,
        updated_at: now,
      },
      phase: 'waiting',
      pending_signals: [],
      activations: [{
        activation: {
          id: 'activation-1',
          revision: 1,
          agent_id: 'agent-1',
          context_id: 'context-test',
          session_id: 'session-1',
          trigger_event_id: 'event-1',
          trigger_sequence: 1,
          trigger_kind: 'chat/user_message',
          root_turn_id: 'turn-1',
          status: 'running',
          created_at: now,
          updated_at: now,
        },
        signals: [],
        jobs: [{
          job: {
            id: 'job-1',
            revision: 1,
            activation_id: 'activation-1',
            thread_id: 'thread-1',
            agent_id: 'agent-1',
            context_id: 'context-test',
            session_id: 'session-1',
            tool_call_id: 'call-1',
            tool_name: 'exec',
            request: { command: 'cargo test' },
            status: 'waiting_approval',
            retry_safety: 'at_most_once',
            result_refs: [],
            created_at: now,
            updated_at: now,
          },
          approval: {
            id: 'approval-1',
            revision: 1,
            job_id: 'job-1',
            request_digest: 'request-digest',
            policy_digest: 'policy-digest',
            action: { kind: 'shell' },
            requested: { network: true },
            justification: 'network is required',
            status: 'pending_human',
            risk_tags: [],
            created_at: now,
            updated_at: now,
          },
        }],
      }],
      schedules: [{
        id: 'schedule-1',
        revision: 2,
        thread_id: 'thread-1',
        source_turn_id: 'turn-1',
        intent: 'retry later',
        status: 'paused',
        dependency_thread_ids: [],
        created_at: now,
        updated_at: now,
      }],
    }],
    orphan_activations: [],
    orphan_signals: [],
    orphan_jobs: [{
      job: {
        id: 'job-orphan',
        revision: 1,
        activation_id: 'activation-missing',
        thread_id: 'thread-missing',
        agent_id: 'agent-1',
        context_id: 'context-test',
        session_id: 'session-1',
        tool_call_id: 'call-orphan',
        tool_name: 'read',
        request: { path: 'missing.txt' },
        status: 'failed',
        retry_safety: 'idempotent',
        result_refs: [],
        error: 'missing activation',
        created_at: now,
        updated_at: now,
        finished_at: now,
      },
      result: {
        status: 'failed',
        refs: [],
        error: 'missing activation',
        finished_at: now,
      },
    }],
    orphan_approvals: [],
  }
}

test('scheduler model flattens the authoritative causal projection exactly once', () => {
  const snapshot = fixture()
  assert.deepEqual(schedulerJobs(snapshot).map(item => item.job.id), ['job-1', 'job-orphan'])
  assert.deepEqual(actionableSchedulerJobs(snapshot).map(item => item.job.id), ['job-1'])
  assert.deepEqual(schedulerApprovals(snapshot).map(item => item.id), ['approval-1'])
  assert.deepEqual(pendingHumanApprovals(snapshot).map(item => item.id), ['approval-1'])
  assert.deepEqual(schedulerSchedules(snapshot).map(item => item.id), ['schedule-1'])
  assert.deepEqual(activeSchedulerThreads(snapshot).map(item => item.thread.id), ['thread-1'])
})

test('open lifecycle does not make an idle Thread physically active', () => {
  const snapshot = fixture()
  snapshot.threads[0].phase = 'idle'
  snapshot.threads[0].thread.lifecycle = 'open'

  assert.deepEqual(activeSchedulerThreads(snapshot), [])
  assert.deepEqual(activeSchedulerActivations(snapshot), [])
})

test('terminal Thread history cannot keep composer activity alive', () => {
  const snapshot = fixture()
  snapshot.threads[0].thread.lifecycle = 'completed'
  snapshot.threads[0].phase = 'idle'
  // A legacy or partially recovered causal row may still say running. It is
  // useful history, but it is not current work.
  snapshot.threads[0].activations[0].activation.status = 'running'
  snapshot.threads[0].thread.kind = 'dialogue_turn'
  snapshot.summary.active_jobs = 0

  assert.deepEqual(activeSchedulerActivations(snapshot), [])
  assert.deepEqual(schedulerActivityCounts(snapshot), { dialogue: 0, execution: 0 })
})

test('composer activity distinguishes dialogue evaluation from physical execution', () => {
  const snapshot = fixture()
  snapshot.threads[0].thread.kind = 'dialogue_turn'
  snapshot.summary.active_jobs = 0

  assert.deepEqual(schedulerActivityCounts(snapshot), { dialogue: 1, execution: 0 })
  assert.deepEqual(schedulerActivityCounts(null), { dialogue: 0, execution: 0 })
})

test('current Schedule projection excludes terminal causal history', () => {
  const snapshot = fixture()
  const completed = { ...snapshot.threads[0].schedules[0], id: 'schedule-completed', status: 'completed' as const }
  snapshot.threads[0].schedules.push(completed)

  assert.deepEqual(schedulerSchedules(snapshot).map(item => item.id), ['schedule-1', 'schedule-completed'])
  assert.deepEqual(currentSchedulerSchedules(snapshot).map(item => item.id), ['schedule-1'])
})

test('attention fingerprints reopen when their source revision changes', () => {
  const snapshot = fixture()
  const job = snapshot.threads[0].activations[0].jobs[0]
  const first = attentionJobKey('execution_job', job)
  job.job.revision += 1
  assert.notEqual(attentionJobKey('execution_job', job), first)

  const delivery = snapshot.threads[0]
  delivery.thread.delivery_status = 'deferred'
  const originalDelivery = attentionDeliveryKey(delivery)
  delivery.thread.revision += 1
  assert.notEqual(attentionDeliveryKey(delivery), originalDelivery)
})

test('attention counts pending approval, not recoverable tool failures', () => {
  assert.equal(schedulerAttentionCount(fixture()), 1)
  assert.equal(schedulerAttentionCount(null), 0)
})

test('terminal owners make waiting approvals invariant violations rather than user actions', () => {
  const snapshot = fixture()
  snapshot.threads[0].thread.lifecycle = 'cancelled'
  snapshot.threads[0].activations[0].activation.status = 'failed'
  snapshot.threads[0].activations[0].jobs[0].approval!.status = 'allowed'
  snapshot.summary.active_jobs = 0
  snapshot.summary.waiting_approval_jobs = 0
  snapshot.summary.pending_approvals = 0

  assert.deepEqual(actionableSchedulerJobs(snapshot), [])
  assert.deepEqual(pendingHumanApprovals(snapshot), [])
  assert.deepEqual(schedulerApprovalAnomalies(snapshot).map(item => item.job.id), ['job-1'])
  assert.deepEqual(schedulerAttentionJobs(snapshot).map(item => item.job.id), [])
  assert.equal(schedulerAttentionCount(snapshot), 1)
})

test('handled failures in terminal Thread history do not remain in needs-attention forever', () => {
  const snapshot = fixture()
  const owned = snapshot.threads[0].activations[0].jobs[0]
  owned.job.status = 'failed'
  owned.job.error = 'handled by a later model continuation'
  delete owned.approval
  snapshot.threads[0].thread.lifecycle = 'completed'
  snapshot.threads[0].activations[0].activation.status = 'succeeded'

  assert.deepEqual(schedulerAttentionJobs(snapshot).map(item => item.job.id), [])
})

test('dialogue Threads become visible task activity when they carry Execution Jobs', () => {
  const snapshot = fixture()
  const thread = snapshot.threads[0]
  thread.thread.kind = 'dialogue_turn'

  assert.equal(threadCarriesExecution(thread), true)
  thread.activations[0].jobs = []
  assert.equal(threadCarriesExecution(thread), false)
})

test('failure reply retries only the still-authoritative failed DialogueTurn generation', () => {
  const failed = fixture().threads[0]
  failed.thread.kind = 'dialogue_turn'
  failed.thread.lifecycle = 'failed'
  failed.thread.result_event_id = 'failure-reply-1'
  assert.equal(
    retryableDialogueThread([failed], 'failure-reply-1', {
      runtime_failure_kind: 'network',
      thread_id: failed.thread.id,
      root_turn_id: failed.thread.root_turn_id,
    })?.thread.id,
    failed.thread.id,
  )

  failed.thread.lifecycle = 'open'
  failed.thread.generation = 2
  assert.equal(retryableDialogueThread([failed], 'failure-reply-1', {
    runtime_failure_kind: 'network',
    thread_id: failed.thread.id,
  }), undefined)

  failed.thread.lifecycle = 'failed'
  failed.thread.result_event_id = 'newer-failure-reply'
  assert.equal(retryableDialogueThread([failed], 'failure-reply-1', {
    runtime_failure_kind: 'network',
    thread_id: failed.thread.id,
  }), undefined)
})

test('failure reply may retry only a Runtime-owned root Execution Thread', () => {
  const failed = fixture().threads[0]
  failed.thread.kind = 'execution'
  failed.thread.lifecycle = 'failed'
  failed.thread.result_event_id = 'execution-failure-1'
  failed.thread.supervision = {
    lifetime: 'durable',
    supervisor_kind: 'runtime',
    supervisor_id: 'dialogue-router',
    generation: failed.thread.generation,
    completion_contract: {},
  }

  assert.equal(
    retryableDialogueThread([failed], 'execution-failure-1', {
      runtime_failure_kind: 'server_unavailable',
      thread_id: failed.thread.id,
    })?.thread.id,
    failed.thread.id,
  )

  failed.thread.supervision.parent_thread_id = 'parent-thread'
  assert.equal(retryableDialogueThread([failed], 'execution-failure-1', {
    runtime_failure_kind: 'server_unavailable',
    thread_id: failed.thread.id,
  }), undefined)
})
