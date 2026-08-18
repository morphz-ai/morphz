import assert from 'node:assert/strict'
import test from 'node:test'

import type { RuntimeOverview, RuntimeOverviewSessionState } from '../src/pages/RuntimeOverviewPage.tsx'
import {
  runtimeMonitorCounts,
  runtimeMonitorSessions,
  runtimeStateMatchesFilter,
} from '../src/runtimeMonitor.ts'

function overviewWithStates(states: RuntimeOverviewSessionState[]): RuntimeOverview {
  const now = '2026-08-18T04:00:00Z'
  return {
    generated_at: now,
    summary: {
      contexts: 1,
      active_sessions: states.length,
      total_sessions: states.length,
      objectives: 1,
      open_threads: 1,
      running_activations: 1,
      active_execution_jobs: 1,
      waiting: 0,
      queued: 0,
      paused: 0,
      attention_required: 0,
    },
    contexts: [{
      context: { id: 'context-runtime', agent_id: 'agent-runtime', title: 'Runtime Context', status: 'active' },
      active_session_count: states.length,
      total_session_count: states.length,
      hidden_session_count: 0,
      objective_count: 1,
      open_thread_count: 1,
      running_activation_count: 1,
      active_execution_job_count: 1,
      attention_count: 0,
      last_activity_at: now,
      sessions: states.map((state, index) => ({
        session: {
          id: `session-${state}`,
          agent_id: 'agent-runtime',
          context_id: 'context-runtime',
          title: `Session ${state}`,
          status: 'active',
          last_activity_at: new Date(Date.parse(now) - index * 1000).toISOString(),
        },
        principal_ids: [`principal-${state}`],
        state,
        attention_required: state === 'needs_attention' || state === 'waiting_user',
        pending_dialogue_turns: 0,
        open_thread_count: state === 'idle' ? 0 : 1,
        running_activation_count: state === 'running' ? 1 : 0,
        active_execution_job_count: state === 'running' ? 1 : 0,
        execution_jobs: state === 'running' ? [{
          id: 'job-runtime',
          activation_id: 'activation-runtime',
          thread_id: 'thread-runtime',
          status: 'running',
          tool_name: 'exec',
          target_id: 'target-mini-m4',
          updated_at: now,
        }] : [],
        objectives: state === 'waiting' ? [{
          id: 'objective-research',
          coordinator_session_id: `session-${state}`,
          delivery_session_id: `session-${state}`,
          stated_objective: 'Research runtime monitor',
          status: 'active',
          state,
          wait_condition: { kind: 'timer', deadline: now },
          revision: 2,
          updated_at: now,
        }] : [],
        threads: state === 'running' ? [{
          id: 'thread-runtime',
          kind: 'execution',
          phase: 'running',
          state,
          control_state: 'active',
          target_id: 'target-mini-m4',
          activations: [{
            id: 'activation-runtime',
            status: 'running',
            trigger_kind: 'user_message',
            updated_at: now,
          }],
          execution_jobs: [{
            id: 'job-runtime',
            activation_id: 'activation-runtime',
            thread_id: 'thread-runtime',
            status: 'running',
            tool_name: 'exec',
            target_id: 'target-mini-m4',
            updated_at: now,
          }],
          updated_at: now,
        }] : [],
      })),
    }],
    has_more_contexts: false,
  }
}

test('runtime monitor groups effective states without showing idle Sessions as live work', () => {
  const overview = overviewWithStates([
    'running', 'queued', 'waiting', 'waiting_user', 'paused', 'needs_attention', 'idle',
  ])
  assert.deepEqual(runtimeMonitorCounts(overview), {
    live: 6,
    running: 2,
    waiting: 3,
    attention: 2,
  })
  assert.equal(runtimeMonitorSessions(overview, 'live', '').some(item => item.session.state === 'idle'), false)
})

test('runtime monitor search reaches objective, tool and target identities in one projection', () => {
  const overview = overviewWithStates(['running', 'waiting'])
  assert.equal(runtimeMonitorSessions(overview, 'live', 'target-mini-m4').length, 1)
  assert.equal(runtimeMonitorSessions(overview, 'live', 'Research runtime').length, 1)
  assert.equal(runtimeMonitorSessions(overview, 'live', 'missing').length, 0)
})

test('runtime monitor search reaches a live Job after its causal Thread left the live projection', () => {
  const overview = overviewWithStates(['running'])
  overview.contexts[0]!.sessions[0]!.threads = []
  assert.equal(runtimeMonitorSessions(overview, 'live', 'job-runtime').length, 1)
  assert.equal(runtimeMonitorSessions(overview, 'live', 'target-mini-m4').length, 1)
})

test('waiting for user is both a waiting state and an attention state', () => {
  assert.equal(runtimeStateMatchesFilter('waiting_user', 'waiting'), true)
  assert.equal(runtimeStateMatchesFilter('waiting_user', 'attention'), true)
  assert.equal(runtimeStateMatchesFilter('waiting', 'attention'), false)
})
