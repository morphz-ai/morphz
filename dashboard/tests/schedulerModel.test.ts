import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeSchedulerThreads,
  pendingHumanApprovals,
  schedulerApprovals,
  schedulerAttentionCount,
  schedulerJobs,
  schedulerSchedules,
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
        kind: 'work',
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
  assert.deepEqual(schedulerApprovals(snapshot).map(item => item.id), ['approval-1'])
  assert.deepEqual(pendingHumanApprovals(snapshot).map(item => item.id), ['approval-1'])
  assert.deepEqual(schedulerSchedules(snapshot).map(item => item.id), ['schedule-1'])
  assert.deepEqual(activeSchedulerThreads(snapshot).map(item => item.thread.id), ['thread-1'])
})

test('attention counts pending approval and durable failures, not ordinary work', () => {
  assert.equal(schedulerAttentionCount(fixture()), 2)
  assert.equal(schedulerAttentionCount(null), 0)
})
