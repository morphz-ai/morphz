import assert from 'node:assert/strict'
import test from 'node:test'

import type { TFunction } from 'i18next'
import { compactTokens, conversationEventKind, shortId, statusLabel, summarizeToolCall } from '../src/app/presentation.ts'

const translations: Record<string, string> = {
  'status.running': 'Running',
  'toolCall.read': 'Read file',
  'toolCall.exec': 'Run command',
  'toolCall.sendMessage': 'Send message',
  'toolCall.lines': 'lines {{range}}',
  'toolCall.unspecifiedFile': 'unspecified file',
  'toolCall.unspecifiedCommand': 'unspecified command',
  'toolCall.targetSession': 'target Session',
  'toolCall.viewArgs': 'view arguments',
}

const t = ((key: string, options?: Record<string, unknown>) => {
  let value = translations[key] ?? key
  for (const [name, replacement] of Object.entries(options ?? {})) {
    value = value.replace(`{{${name}}}`, String(replacement))
  }
  return value
}) as TFunction

test('presentation helpers keep identifiers and token counts compact', () => {
  assert.equal(compactTokens(999), '999')
  assert.equal(compactTokens(12_340), '12.3k')
  assert.equal(shortId('thread-1234567890', 10), '…234567890')
  assert.equal(statusLabel('running', t), 'Running')
  assert.equal(statusLabel('provider_specific', t), 'provider_specific')
})

test('tool summaries expose the physical target without rendering raw argument blobs', () => {
  assert.deepEqual(
    summarizeToolCall('read', JSON.stringify({ path: 'src/runtime.rs', start_line: 20, end_line: 40 }), t),
    { title: 'Read file', target: 'src/runtime.rs · lines 20–40', detail: 'read' },
  )
  assert.deepEqual(
    summarizeToolCall('exec', JSON.stringify({ command: 'cargo test -p morphz' }), t),
    { title: 'Run command', target: 'cargo test -p morphz', detail: 'exec' },
  )
  assert.deepEqual(
    summarizeToolCall('send_message', JSON.stringify({ target_session_id: 'session-b', message: 'done' }), t),
    { title: 'Send message', target: 'session-b · done', detail: 'send_message' },
  )
})

test('malformed tool arguments degrade to a stable summary', () => {
  assert.deepEqual(
    summarizeToolCall('custom_tool', '{not-json', t),
    { title: 'custom_tool', target: 'view arguments', detail: 'custom_tool' },
  )
})

test('reply presentation follows delivery semantics rather than causal thread provenance', () => {
  assert.equal(conversationEventKind('chat/reply', {
    thread_kind: 'execution',
    delivery_kind: 'turn_reply',
  }), 'agent')
  assert.equal(conversationEventKind('chat/reply', {
    thread_kind: 'delivery',
    delivery_kind: 'thread_delivery',
  }), 'background')
  assert.equal(conversationEventKind('chat/reply', {
    thread_kind: 'execution',
  }), 'agent')
  assert.equal(conversationEventKind('chat/reply', {
    thread_kind: 'delivery',
  }), 'background')
})
