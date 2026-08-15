import assert from 'node:assert/strict'
import test from 'node:test'

import { invalidatedQueriesForTopic } from '../src/app/invalidation.ts'

test('ephemeral model deltas never cause authoritative refetch storms', () => {
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_stream'), [])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_request_snapshot'), [])
})

test('durable events invalidate shared projections by semantic scope', () => {
  assert.deepEqual(invalidatedQueriesForTopic('chat/reply'), ['session', 'overview', 'scheduler', 'ledger'])
  assert.deepEqual(invalidatedQueriesForTopic('chat/context_tx_committed'), [
    'session', 'overview', 'scheduler', 'ledger', 'mind-transactions',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/execution_job_completed'), [
    'session', 'overview', 'scheduler', 'ledger', 'thread',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_attempt_state'), [
    'session', 'overview', 'scheduler', 'ledger', 'thread',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/model_reasoning_summary'), [
    'session', 'overview', 'scheduler', 'ledger', 'thread',
  ])
  assert.deepEqual(invalidatedQueriesForTopic('runtime/delegation_result'), [
    'session', 'overview', 'scheduler', 'ledger', 'catalog',
  ])
})
