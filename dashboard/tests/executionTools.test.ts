import assert from 'node:assert/strict'
import test from 'node:test'

import { buildToolTimeline, executionTargetIds } from '../src/app/executionTools.ts'

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
