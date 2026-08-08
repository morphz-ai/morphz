import assert from 'node:assert/strict'
import test from 'node:test'

import type { TFunction } from 'i18next'
import {
  assignTintSlots,
  autoTintDimension,
  buildObjectiveLineageIndex,
  TINT_PALETTE_SIZE,
  tintIdForLineage,
  toneForSlot,
} from '../src/app/objectiveLineage.ts'
import { assistantToolCalls, compactTokens, conversationEventKind, conversationEventLane, delegatedContextIds, formatLocalRfc3339, newestConversationEventsForLane, shortId, statusLabel, summarizeToolCall } from '../src/app/presentation.ts'

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

test('local RFC 3339 values preserve the instant and expose an explicit offset', () => {
  const instant = new Date('2026-08-08T00:15:00Z')
  const local = formatLocalRfc3339(instant)
  assert.match(local, /[+-]\d{2}:\d{2}$/)
  assert.equal(new Date(local).getTime(), instant.getTime())
})

test('delegated Contexts are classified from authoritative child Context ids', () => {
  assert.deepEqual(
    [...delegatedContextIds([
      { child_context_id: 'context-child-a' },
      { child_context_id: 'context-child-b' },
      { child_context_id: 'context-child-a' },
      { child_context_id: '' },
    ])],
    ['context-child-a', 'context-child-b'],
  )
})

test('orphaned Runtime delegation Contexts remain grouped without a Delegation row', () => {
  assert.deepEqual(
    [...delegatedContextIds(
      [{ child_context_id: 'context-child-a' }],
      [
        'context-default',
        'delegate-context-legacy-child',
        ' delegate-context-recovered-child ',
      ],
    )],
    [
      'context-child-a',
      'delegate-context-legacy-child',
      'delegate-context-recovered-child',
    ],
  )
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

test('Assistant Call tool payloads normalize provider and Runtime call shapes', () => {
  assert.deepEqual(assistantToolCalls({
    tool_calls: [{
      id: 'call-provider',
      type: 'function',
      function: { name: 'read', arguments: '{"path":"src/runtime.rs"}' },
    }, {
      id: 'call-runtime',
      name: 'exec',
      arguments: '{"command":"cargo test"}',
      arguments_chars: 24,
      truncated: false,
    }],
  }), [{
    id: 'call-provider',
    name: 'read',
    arguments: '{"path":"src/runtime.rs"}',
    arguments_chars: undefined,
    truncated: undefined,
  }, {
    id: 'call-runtime',
    name: 'exec',
    arguments: '{"command":"cargo test"}',
    arguments_chars: 24,
    truncated: false,
  }])
})

test('continued Assistant Calls expose their durable tool lifecycle after refresh', () => {
  assert.deepEqual(assistantToolCalls({
    continuation_tool_calls: [{
      id: 'call-list-skills',
      type: 'function',
      function: { name: 'list_skills', arguments: '{}' },
    }],
  }), [{
    id: 'call-list-skills',
    name: 'list_skills',
    arguments: '{}',
    arguments_chars: undefined,
    truncated: undefined,
  }])
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

test('dual-track presentation separates execution output without moving Runtime activity', () => {
  assert.equal(conversationEventLane('chat/user_message', {}), 'dialogue')
  assert.equal(conversationEventLane('chat/reply', {
    thread_kind: 'execution',
    delivery_kind: 'turn_reply',
  }), 'dialogue')
  assert.equal(conversationEventLane('chat/reply', {
    thread_kind: 'delivery',
    delivery_kind: 'thread_delivery',
  }), 'execution_output')
  assert.equal(conversationEventLane('chat/progress', {}), 'execution_output')
  assert.equal(conversationEventLane('chat/assistant_call', { terminal_outcome: false }), 'execution_output')
  assert.equal(conversationEventLane('runtime/tool_calls_selected', {}), null)
})

test('split lanes receive independent newest-event windows', () => {
  const events = [
    ...Array.from({ length: 150 }, (_, index) => ({
      id: `dialogue-${index}`,
      topic: 'chat/user_message',
      payload: {},
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `execution-${index}`,
      topic: 'chat/assistant_call',
      payload: { terminal_outcome: false, tool_calls: [{ id: `call-${index}` }] },
    })),
  ]
  const dialogue = newestConversationEventsForLane(events, 'dialogue', 100)
  const execution = newestConversationEventsForLane(events, 'execution_output', 100)

  assert.equal(dialogue.length, 100)
  assert.equal(dialogue[0]?.id, 'dialogue-50')
  assert.deepEqual(execution.map(event => event.id), [
    'execution-0',
    'execution-1',
    'execution-2',
    'execution-3',
    'execution-4',
  ])
})

test('objective lineage links durable outputs back to their Thread and Objective', () => {
  const index = buildObjectiveLineageIndex(
    [{
      id: 'thread-alpha',
      root_turn_id: 'objective-wake-alpha',
      activations: [{
        id: 'activation-alpha',
        root_turn_id: 'objective-wake-alpha',
        trigger_event_id: 'objective-wake-alpha',
      }],
    }],
    [{
      id: 'objective-wake-alpha',
      payload: {
        objective_id: 'objective-alpha',
        root_turn_id: 'objective-wake-alpha',
      },
    }, {
      id: 'tool-output-alpha',
      payload: {
        activation_id: 'activation-alpha',
        thread_id: 'thread-alpha',
        root_turn_id: 'objective-wake-alpha',
      },
    }],
  )

  assert.deepEqual(index.forActivation('activation-alpha'), {
    threadIds: ['thread-alpha'],
    objectiveIds: ['objective-alpha'],
  })
  assert.deepEqual(index.forEvent({
    id: 'tool-output-alpha',
    payload: {
      activation_id: 'activation-alpha',
      thread_id: 'thread-alpha',
      root_turn_id: 'objective-wake-alpha',
    },
  }), {
    threadIds: ['thread-alpha'],
    objectiveIds: ['objective-alpha'],
  })

  assert.deepEqual(index.forEvent({
    id: 'delivery-alpha',
    payload: {
      covers: ['thread-alpha'],
    },
  }), {
    threadIds: ['thread-alpha'],
    objectiveIds: ['objective-alpha'],
  })
})

test('concurrently live entities never share a tint slot', () => {
  const slots = assignTintSlots(['alpha', 'beta', 'gamma'], new Map())
  assert.equal(new Set(slots.values()).size, 3)
  assert.equal(slots.size, 3)
})

test('a live entity keeps its slot while its neighbours come and go', () => {
  const first = assignTintSlots(['alpha', 'beta'], new Map())
  const alphaSlot = first.get('alpha')
  // beta ends, gamma and delta start: alpha must not be recoloured underneath
  // an operator who is mid-read.
  const second = assignTintSlots(['alpha', 'gamma', 'delta'], first)
  assert.equal(second.get('alpha'), alphaSlot)
  assert.equal(new Set(second.values()).size, 3)
  // beta's slot is free again rather than being held forever.
  assert.equal(second.has('beta'), false)
  assert.ok([...second.values()].includes(first.get('beta') as number))
})

test('entities beyond the curated palette remain tinted without repeating a slot', () => {
  const ids = Array.from({ length: TINT_PALETTE_SIZE + 3 }, (_, index) => `entity-${index}`)
  const slots = assignTintSlots(ids, new Map())
  assert.equal(slots.size, ids.length)
  assert.equal(new Set(slots.values()).size, ids.length)
  for (const id of ids.slice(TINT_PALETTE_SIZE)) {
    assert.match(toneForSlot(slots.get(id))?.color ?? '', /^hsl\(/)
  }
})

test('tint dimension follows the level being attended to', () => {
  // Several Objectives in view: telling those apart is the question, and the
  // threads inside one of them are detail.
  assert.equal(autoTintDimension(3, 5), 'objective')
  // Narrowed to one Objective, so the useful distinction moves to its threads.
  assert.equal(autoTintDimension(1, 4), 'thread')
  assert.equal(autoTintDimension(1, 1), 'objective')
  // No Objective exists at all, which is the ordinary background-work case.
  assert.equal(autoTintDimension(0, 3), 'thread')
})

test('the coloured id follows the dimension in effect', () => {
  const lineage = { threadIds: ['thread-alpha'], objectiveIds: ['objective-alpha'] }
  assert.equal(tintIdForLineage(lineage, 'objective'), 'objective-alpha')
  assert.equal(tintIdForLineage(lineage, 'thread'), 'thread-alpha')
  assert.equal(tintIdForLineage({ threadIds: [], objectiveIds: [] }, 'thread'), undefined)
})
