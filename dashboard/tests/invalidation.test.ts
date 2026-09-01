import assert from 'node:assert/strict'
import test from 'node:test'

import {
  invalidatedQueriesForTopic,
  invalidationsRequireSessionRefresh,
} from '../src/app/invalidation.ts'

test('ephemeral model deltas never cause authoritative refetch storms', () => {
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_stream'), [])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_request_snapshot'), [])
})

test('durable events invalidate shared projections by semantic scope', () => {
  assert.deepEqual(invalidatedQueriesForTopic('chat/reply'), ['session', 'overview', 'scheduler'])
  assert.deepEqual(invalidatedQueriesForTopic('chat/context_tx_committed'), [
    'session', 'overview', 'scheduler', 'mind-transactions',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/execution_job_completed'), [
    'scheduler', 'thread', 'execution-jobs',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('chat/tool_output'), [
    'scheduler', 'thread', 'execution-jobs',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_attempt_state'), [
    'scheduler', 'thread',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_reasoning_summary'), [
    'scheduler', 'thread',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/delegation_result'), [
    'catalog',
  ])
})

test('ordinary durable progress is already merged from the live socket', () => {
  assert.deepEqual(invalidatedQueriesForTopic('chat/user_message'), [])
  assert.deepEqual(invalidatedQueriesForTopic('chat/progress'), [])
})

test('scheduler invalidation refreshes the Session projection that carries approval cards', () => {
  assert.equal(invalidationsRequireSessionRefresh(['scheduler', 'thread']), true)
  assert.equal(invalidationsRequireSessionRefresh(['session']), true)
  assert.equal(invalidationsRequireSessionRefresh(['thread']), false)
})
