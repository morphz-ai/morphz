import {eventHistoryInvalidatedByTopic} from '../src/app/invalidation.ts'
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
    'delegations', 'catalog',
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


test('visible Event history follows durable model facts, while observer-only snapshots stay silent',()=>{
  for(const topic of ['runtime/model_usage','runtime/model_reasoning_summary','runtime/model_attempt_state','chat/reply']) assert.equal(eventHistoryInvalidatedByTopic(topic),true)
  for(const topic of ['runtime/model_stream','runtime/model_attempt_snapshot','runtime/model_request_snapshot','runtime/terminal_changed']) assert.equal(eventHistoryInvalidatedByTopic(topic),false)
})

test('terminal output has no owner in Dashboard work or durable Event history',()=>{
 assert.deepEqual(invalidatedQueriesForTopic('runtime/terminal_changed'),[])
 assert.equal(eventHistoryInvalidatedByTopic('runtime/terminal_changed'),false)
})
