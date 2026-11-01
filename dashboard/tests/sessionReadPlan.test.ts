import assert from 'node:assert/strict'
import test from 'node:test'
import {sessionReadPlan} from '../src/app/sessionReadPlan.ts'
import {invalidatedQueriesForTopic} from '../src/app/invalidation.ts'

test('a changed Thread does not reload messages, terminal delegations, Model Usage or Context directory', () => {
  const plan=sessionReadPlan('dialogue',invalidatedQueriesForTopic('runtime/thread_phase_changed'))
  assert.equal(plan.work,true)
  assert.equal(plan.attention,true)
  assert.equal(plan.messages,false)
  assert.equal(plan.overview,false)
  assert.equal(plan.usage,false)
  assert.equal(plan.delegations,false)
})
test('entry/reconnect reads only currently visible collections, and usage/delegation have explicit semantic owners',()=>{
  assert.equal(sessionReadPlan('scheduler').messages,false)
  assert.equal(sessionReadPlan('dialogue').messages,true)
  assert.ok(Object.values(sessionReadPlan('credentials')).every(value=>!value))
  const usage=sessionReadPlan('dialogue',invalidatedQueriesForTopic('runtime/model_usage'))
  assert.deepEqual(Object.entries(usage).filter(([,needed])=>needed).map(([name])=>name),['usage'])
  const delegation=sessionReadPlan('dialogue',invalidatedQueriesForTopic('chat/delegate'))
  assert.deepEqual(Object.entries(delegation).filter(([,needed])=>needed).map(([name])=>name),['delegations'])
  assert.ok(Object.values(sessionReadPlan('dialogue',[])).every(value=>!value))
})


test('an Event-history invalidation is not permission to fetch conversation bodies or every Session collection',()=>{
  const plan=sessionReadPlan('dialogue',['events','model-usage'])
  assert.equal(plan.messages,false);assert.equal(plan.usage,true);assert.equal(plan.work,false)
})
