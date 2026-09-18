import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolTimeline,
  executionTargetIds,
  executionTargetLabel,
  type ToolTimelineEvent,
} from '../src/app/executionTools.ts'
import { assistantToolCalls } from '../src/app/presentation.ts'

const rejectedBatchId = 'context_tx_batch_rejected'
function rejectedContextBatch(attempt: string, ids: string[], explicitReceiptIds = false): ToolTimelineEvent[] {
  const route = { context_id: 'context-test', session_id: 'session-test', attempt_id: attempt }
  return [{
    timestamp: '2026-09-18T15:46:32.724Z',
    topic: 'chat/assistant_call',
    payload: {
      ...route,
      tool_calls: ids.map(id => ({ id, type: 'function', function: {
        name: 'context_tx', arguments: JSON.stringify({ transaction: `(context-tx (base-version 577) (reason "${id}"))` }),
      } })),
      rejected_context_tx_ids: ids,
      continuation_tool_calls: [{ id: rejectedBatchId, type: 'function', function: {
        name: 'context_tx', arguments: '{"runtime_rejected_batch":true,"status":"budget-exhausted"}',
      } }],
    },
  }, {
    timestamp: '2026-09-18T15:46:32.733Z',
    topic: 'runtime/tool_calls_selected',
    payload: { ...route, calls: [], requested_count: ids.length, rejected_count: ids.length },
  }, {
    timestamp: '2026-09-18T15:46:32.739Z',
    type: 'tool_output',
    topic: 'chat/tool_output',
    payload: {
      ...route, tool_call_id: rejectedBatchId, tool_name: 'context_tx', tool_status: 'rejected',
      context_tx_status: 'budget-exhausted', text: `CONTEXT_TX_BUDGET_EXHAUSTED: ${attempt}`,
      ...(explicitReceiptIds ? { rejected_context_tx_ids: ids } : {}),
    },
  }]
}

test('historical Context budget rejection is one rejected request, not a running request plus a synthetic call', () => {
  const events = rejectedContextBatch('activation-a', ['call-original'])
  // The view uses assistantToolCalls for the card count, not the timeline size.
  assert.deepEqual(assistantToolCalls(events[0].payload).map(call => call.id), ['call-original'])
  const timeline = buildToolTimeline(events)
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0].id, 'call-original')
  assert.equal(timeline[0].status, 'rejected')
  assert.equal(timeline[0].result, 'CONTEXT_TX_BUDGET_EXHAUSTED: activation-a')
  assert.equal(timeline[0].timestamp, events[0].timestamp)
  assert.match(timeline[0].arguments, /base-version 577/)
})

test('two genuinely requested Context transactions remain two rejected calls', () => {
  const events = rejectedContextBatch('activation-a', ['call-one', 'call-two'], true)
  assert.equal(assistantToolCalls(events[0].payload).length, 2)
  const timeline = buildToolTimeline(events)
  assert.deepEqual(timeline.map(call => [call.id, call.status]), [
    ['call-one', 'rejected'], ['call-two', 'rejected'],
  ])
  assert.notEqual(timeline[0].arguments, timeline[1].arguments)
})

test('rejection receipts resolve only their exact attempt and leave independent work running', () => {
  const first = rejectedContextBatch('activation-a', ['call-one'])
  const second = rejectedContextBatch('activation-b', ['call-two'])
  // Interleaved requests, with only the second receipt available.
  const pending = buildToolTimeline([first[0], second[0], second[2]])
  assert.equal(pending.find(call => call.id === 'call-one')?.status, 'running')
  assert.equal(pending.find(call => call.id === 'call-two')?.status, 'rejected')
  const finished = buildToolTimeline([first[0], second[0], second[2], first[2]])
  assert.equal(finished.length, 2)
  assert.equal(finished.find(call => call.id === 'call-one')?.result, 'CONTEXT_TX_BUDGET_EXHAUSTED: activation-a')
  assert.equal(finished.find(call => call.id === 'call-two')?.result, 'CONTEXT_TX_BUDGET_EXHAUSTED: activation-b')
})

test('late history loading recovers original arguments without reverting a rejection', () => {
  const events = rejectedContextBatch('activation-a', ['call-original'])
  const timeline = buildToolTimeline([events[2], events[0]])
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0].status, 'rejected')
  assert.match(timeline[0].arguments, /base-version 577/)
})

test('new rejection receipts retain original identity when the request page is absent', () => {
  const events = rejectedContextBatch('activation-a', ['call-original'], true)
  const timeline = buildToolTimeline([events[2]])
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0].id, 'call-original')
  assert.equal(timeline[0].status, 'rejected')
})

test('missing rejection lineage is not guessed from the tool name or nearby timestamp', () => {
  const events = rejectedContextBatch('activation-a', ['call-original'])
  delete events[0].payload.rejected_context_tx_ids
  const timeline = buildToolTimeline(events)
  assert.equal(timeline.find(call => call.id === 'call-original')?.status, 'running')
  assert.equal(timeline.find(call => call.id === rejectedBatchId)?.status, 'rejected')
  assert.equal(assistantToolCalls(events[0].payload).length, 2)
})

test('rejection lineage never crosses Context or Session boundaries', () => {
  for (const field of ['context_id', 'session_id', 'attempt_id']) {
    const events = rejectedContextBatch('activation-a', ['call-original'], true)
    events[2].payload[field] = 'another-route'
    const timeline = buildToolTimeline(events)
    assert.equal(timeline.find(call => call.id === 'call-original')?.status, 'running')
  }
})

test('selection lineage and activation routes recover historical receipts without the Assistant page', () => {
  const events = rejectedContextBatch('activation-a', ['call-original'])
  events[1].payload.rejected_context_tx_ids = ['call-original']
  for (const event of events) {
    event.payload.activation_id = event.payload.attempt_id
    delete event.payload.attempt_id
  }
  assert.deepEqual(buildToolTimeline(events.slice(1)).map(call => [call.id, call.status]), [
    ['call-original', 'rejected'],
  ])
})

test('a lookalike continuation is not hidden without the Runtime batch marker', () => {
  const events = rejectedContextBatch('activation-a', ['call-original'])
  events[0].payload.continuation_tool_calls = [{
    id: rejectedBatchId, name: 'context_tx', arguments: '{"transaction":"(context-tx)"}',
  }]
  assert.equal(assistantToolCalls(events[0].payload).length, 2)
})

test('a batch receipt cannot relabel a physical tool even with claimed rejection IDs', () => {
  const events = rejectedContextBatch('activation-a', ['call-original'], true)
  events[0].payload.tool_calls = [{ id: 'call-original', name: 'read', arguments: '{"path":"evidence"}' }]
  const timeline = buildToolTimeline(events)
  assert.equal(timeline.find(call => call.id === 'call-original')?.status, 'running')
  assert.equal(timeline.find(call => call.id === rejectedBatchId)?.status, 'rejected')
})

test('Assistant Calls are joined to durable Tool Outputs by tool_call_id', () => {
  const timeline = buildToolTimeline([{
    timestamp: '2026-07-28T02:35:10Z',
    topic: 'chat/assistant_call',
    payload: {
      tool_calls: [{
        id: 'call-read',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"chapters/005.md"}' },
      }, {
        id: 'call-list',
        type: 'function',
        function: { name: 'list_files', arguments: '{"path":"chapters"}' },
      }],
    },
  }, {
    timestamp: '2026-07-28T02:35:11Z',
    topic: 'chat/tool_output',
    payload: {
      tool_call_id: 'call-read',
      tool_name: 'read',
      tool_status: 'success',
      text: 'chapter body',
    },
  }, {
    timestamp: '2026-07-28T02:35:12Z',
    topic: 'chat/tool_output',
    payload: {
      tool_call_id: 'call-list',
      tool_name: 'list_files',
      tool_status: 'error',
      text: 'directory unavailable',
    },
  }])

  assert.deepEqual(timeline.map(call => ({
    id: call.id,
    name: call.name,
    status: call.status,
    result: call.result,
  })), [{
    id: 'call-read',
    name: 'read',
    status: 'success',
    result: 'chapter body',
  }, {
    id: 'call-list',
    name: 'list_files',
    status: 'error',
    result: 'directory unavailable',
  }])
})

test('a selected call remains running until its Tool Output arrives', () => {
  assert.equal(buildToolTimeline([{
    timestamp: '2026-07-28T02:35:10Z',
    topic: 'runtime/tool_calls_selected',
    payload: {
      calls: [{ id: 'call-pending', name: 'exec', arguments: '{"command":"cargo test"}' }],
    },
  }])[0]?.status, 'running')
})

test('a successful background launch remains running until its durable Job terminates', () => {
  const launchEvents = [{
    timestamp: '2026-08-18T14:32:00Z',
    topic: 'chat/assistant_call',
    payload: {
      tool_calls: [{
        id: 'call-background',
        type: 'function',
        function: { name: 'exec', arguments: '{"command":"./morphz exec benchmark","background":true}' },
      }],
    },
  }, {
    timestamp: '2026-08-18T14:32:01Z',
    type: 'tool_output',
    topic: 'chat/tool_output',
    payload: {
      tool_call_id: 'call-background',
      tool_name: 'exec',
      tool_status: 'success',
      execution: 'background',
      task_id: 'job-background',
      task_status: 'running',
      text: 'background task started',
    },
  }]

  const running = buildToolTimeline(launchEvents)
  assert.equal(running.length, 1)
  assert.equal(running[0]?.status, 'running')
  assert.equal(running[0]?.backgroundTaskId, 'job-background')

  const completed = buildToolTimeline([...launchEvents, {
    timestamp: '2026-08-18T14:42:01Z',
    type: 'tool_output',
    topic: 'chat/tool_output',
    payload: {
      tool_call_id: 'call-background:background',
      tool_name: 'exec/background',
      tool_status: 'succeeded',
      task_id: 'job-background',
      task_status: 'succeeded',
      text: 'background task completed',
    },
  }])
  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.id, 'call-background')
  assert.equal(completed[0]?.status, 'succeeded')
  assert.equal(completed[0]?.result, 'background task completed')
})

test('a truncated Runtime preview never replaces complete Assistant Call arguments', () => {
  const completeArguments = JSON.stringify({
    content: 'x'.repeat(6_000),
    mode: 'create',
    path: 'chapters/012.md',
  })
  const timeline = buildToolTimeline([{
    timestamp: '2026-07-28T02:35:10Z',
    topic: 'chat/assistant_call',
    payload: {
      tool_calls: [{
        id: 'call-write',
        type: 'function',
        function: { name: 'write', arguments: completeArguments },
      }],
    },
  }, {
    timestamp: '2026-07-28T02:35:11Z',
    topic: 'runtime/tool_calls_selected',
    payload: {
      calls: [{
        id: 'call-write',
        name: 'write',
        arguments: '{\n  "content": "xxxxxxxx\n… <参数预览已截断，共 6049 字符>',
        arguments_chars: 6049,
        truncated: true,
      }],
    },
  }, {
    timestamp: '2026-07-28T02:35:12Z',
    type: 'tool_output',
    topic: 'chat/tool_output',
    payload: {
      tool_call_id: 'call-write',
      tool_name: 'write',
      tool_status: 'success',
      text: 'created chapters/012.md',
    },
  }])

  assert.equal(timeline[0]?.arguments, completeArguments)
  assert.equal(timeline[0]?.truncated, undefined)
  assert.equal(JSON.parse(timeline[0]?.arguments ?? '{}').path, 'chapters/012.md')
})

test('domain-specific Runtime Tool Outputs terminate the selected call', () => {
  const timeline = buildToolTimeline([{
    timestamp: '2026-07-28T02:35:10Z',
    type: 'assistant_call',
    topic: 'runtime/tool_calls_selected',
    payload: {
      calls: [{
        id: 'call-transfer',
        name: 'transfer',
        arguments: '{"source":{"path":"build.zip"},"destination":{"target_id":"target-server","path":"/tmp/build.zip"}}',
      }],
    },
  }, {
    timestamp: '2026-07-28T02:35:12Z',
    type: 'tool_output',
    topic: 'runtime/artifact_transfer_completed',
    payload: {
      tool_call_id: 'call-transfer',
      tool_name: 'transfer',
      tool_status: 'success',
      text: 'transfer completed',
    },
  }])

  assert.equal(timeline[0]?.status, 'success')
  assert.equal(timeline[0]?.result, 'transfer completed')
})

test('persisted continuation calls recover a completed list_skills result', () => {
  const timeline = buildToolTimeline([{
    timestamp: '2026-07-28T02:35:10Z',
    type: 'assistant_call',
    topic: 'chat/assistant_call',
    payload: {
      continuation_tool_calls: [{
        id: 'call-list-skills',
        type: 'function',
        function: { name: 'list_skills', arguments: '{}' },
      }],
    },
  }, {
    timestamp: '2026-07-28T02:35:11Z',
    type: 'tool_output',
    topic: 'chat/tool_output',
    payload: {
      tool_call_id: 'call-list-skills',
      tool_name: 'list_skills',
      tool_status: 'success',
      text: 'agent-reach\nsmart-search',
    },
  }])

  assert.deepEqual(timeline.map(call => ({
    name: call.name,
    status: call.status,
    result: call.result,
  })), [{
    name: 'list_skills',
    status: 'success',
    result: 'agent-reach\nsmart-search',
  }])
})

test('remote target identities are projected without labelling the local target', () => {
  assert.deepEqual(executionTargetIds('{"path":"src/lib.rs","target":"target-server"}'), ['target-server'])
  assert.deepEqual(executionTargetIds('{"path":"src/lib.rs","target":"target-default"}'), [])
  assert.deepEqual(executionTargetIds('{"path":"src/lib.rs"}'), [])
})

test('artifact transfer exposes both non-local endpoints', () => {
  assert.deepEqual(executionTargetIds(JSON.stringify({
    source: { target_id: 'target-default', path: 'dist/app' },
    destination: { target_id: 'target-server', path: '/srv/app' },
  })), ['target-server'])
})

test('managed SSH targets use their operator-facing SSH destination', () => {
  assert.equal(executionTargetLabel({
    id: 'target-ssh-internal',
    kind: 'managed_ssh',
    name: 'SSH featurize@workspace.featurize.cn:47557',
    metadata: {
      host: 'workspace.featurize.cn',
      user: 'featurize',
      port: 47_557,
    },
  }), 'featurize@workspace.featurize.cn:47557')
  assert.equal(executionTargetLabel({
    id: 'target-ssh-internal',
    kind: 'managed_ssh',
    name: 'SSH 39.102.208.61',
    metadata: {
      host: '39.102.208.61',
      user: 'shafreeck',
      port: 22,
    },
  }), 'shafreeck@39.102.208.61')
})

test('managed SSH target labels retain a readable legacy fallback', () => {
  assert.equal(executionTargetLabel({
    id: 'target-ssh-internal',
    kind: 'managed_ssh',
    name: 'SSH root@39.102.208.61:22',
  }), 'root@39.102.208.61')
})
