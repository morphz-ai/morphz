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
import { compactTokens, conversationEventKind, conversationEventLane, shortId, statusLabel, summarizeToolCall } from '../src/app/presentation.ts'

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

test('entities beyond the palette stay neutral instead of repeating a colour', () => {
  const ids = Array.from({ length: TINT_PALETTE_SIZE + 3 }, (_, index) => `entity-${index}`)
  const slots = assignTintSlots(ids, new Map())
  assert.equal(slots.size, TINT_PALETTE_SIZE)
  assert.equal(new Set(slots.values()).size, TINT_PALETTE_SIZE)
  for (const id of ids.slice(TINT_PALETTE_SIZE)) {
    assert.equal(toneForSlot(slots.get(id)), undefined)
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
