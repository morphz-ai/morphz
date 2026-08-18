import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolTimeline,
  executionTargetIds,
  executionTargetLabel,
} from '../src/app/executionTools.ts'

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
