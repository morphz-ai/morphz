import assert from 'node:assert/strict'
import test from 'node:test'

import type { TFunction } from 'i18next'
import {
  assignTintSlots,
  autoTintDimension,
  buildObjectiveLineageIndex,
  reconcileTintSlots,
  TINT_RECENT_SLOT_LIMIT,
  TINT_PALETTE_SIZE,
  tintToneDistance,
  tintIdForLineage,
  toneForSlot,
} from '../src/app/objectiveLineage.ts'
import { assistantToolCalls, compactTokens, conversationEventKind, conversationEventLane, delegatedContextIds, formatLocalRfc3339, newestConversationEventsForLane, objectiveDisplayStatus, objectiveWaitRepresentsExecution, shortId, statusLabel, summarizeToolCall } from '../src/app/presentation.ts'

test('Objective presentation distinguishes supervised execution from external waiting', () => {
  assert.equal(objectiveDisplayStatus({ status: 'active', wait_condition: { kind: 'thread_group' } }), 'running')
  assert.equal(objectiveDisplayStatus({ status: 'active', wait_condition: { kind: 'tool_task' } }), 'running')
  assert.equal(objectiveDisplayStatus({ status: 'active', wait_condition: { kind: 'delegation' } }), 'running')
  assert.equal(objectiveDisplayStatus({ status: 'active', wait_condition: { kind: 'timer' } }), 'waiting')
  assert.equal(objectiveDisplayStatus({ status: 'active', wait_condition: { kind: 'user_input' } }), 'waiting')
  assert.equal(objectiveDisplayStatus({ status: 'active' }), 'active')
  assert.equal(objectiveDisplayStatus({ status: 'blocked', wait_condition: { kind: 'timer' } }), 'blocked')
  assert.equal(objectiveWaitRepresentsExecution({ kind: 'thread_group' }), true)
  assert.equal(objectiveWaitRepresentsExecution({ kind: 'external_event' }), false)
})

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

test('Session Signals remain distinct internal coordination entries', () => {
  assert.equal(conversationEventKind('chat/session_signal', {
    source_session_id: 'session-source',
    session_id: 'session-target',
  }), 'coordination')
  assert.equal(conversationEventLane('chat/session_signal', {}), 'dialogue')
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

test('live causal routes are tintable before scheduler snapshots contain the Activation', () => {
  const index = buildObjectiveLineageIndex([], [])

  assert.deepEqual(index.forLiveRoute({
    activationId: 'activation-live',
    threadId: 'thread-live',
    rootTurnId: 'root-live',
    objectiveId: 'objective-live',
  }), {
    threadIds: ['thread-live'],
    objectiveIds: ['objective-live'],
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
  // The low-level allocator releases beta's slot; the UI reconciliation layer
  // adds a short reuse quarantine below.
  assert.equal(second.has('beta'), false)
  assert.ok([...second.values()].includes(first.get('beta') as number))
})

test('recently released tint slots are not immediately reassigned', () => {
  const first = reconcileTintSlots(['alpha', 'beta'], new Map())
  const betaSlot = first.slots.get('beta')
  const second = reconcileTintSlots(
    ['alpha', 'gamma'],
    first.slots,
    first.recentlyReleasedSlots,
  )
  assert.notEqual(second.slots.get('gamma'), betaSlot)
  assert.deepEqual(second.recentlyReleasedSlots, [betaSlot])

  let current = second
  for (let index = 0; index < TINT_RECENT_SLOT_LIMIT + 2; index += 1) {
    current = reconcileTintSlots(
      ['alpha', `replacement-${index}`],
      current.slots,
      current.recentlyReleasedSlots,
    )
  }
  assert.ok(current.recentlyReleasedSlots.length <= TINT_RECENT_SLOT_LIMIT)
})

test('entities beyond the curated palette remain tinted without repeating a slot', () => {
  const ids = Array.from({ length: TINT_PALETTE_SIZE + 3 }, (_, index) => `entity-${index}`)
  const slots = assignTintSlots(ids, new Map())
  assert.equal(slots.size, ids.length)
  assert.equal(new Set(slots.values()).size, ids.length)
  const colors = ids.map(id => toneForSlot(slots.get(id))?.color)
  assert.ok(colors.every(Boolean))
  assert.equal(new Set(colors).size, ids.length)
})

test('live threads choose distinguishable hues even after a large history window', () => {
  for (const historyCount of [0, 30, 60, 120]) {
    const history = Array.from({ length: historyCount }, (_, index) => `history-${index}`)
    const historicalSlots = assignTintSlots(history, new Map(), new Set(), [])
    const live = Array.from({ length: 6 }, (_, index) => `live-${index}`)
    // Deliberately put history first: caller ordering must not let it consume
    // all the contrasting tones before new live streams are allocated.
    const allocation = reconcileTintSlots([...history, ...live], historicalSlots, [], live)
    const tones = live.map(id => toneForSlot(allocation.slots.get(id))!)
    for (let left = 0; left < tones.length; left += 1) {
      for (let right = left + 1; right < tones.length; right += 1) {
        const distance = tintToneDistance(tones[left], tones[right])
        assert.ok(distance >= 0.14, `${historyCount} historical threads: distance ${distance}`)
      }
    }
    for (const id of history) assert.equal(allocation.slots.get(id), historicalSlots.get(id))
    const reordered = reconcileTintSlots(
      [...live, ...history].reverse(), allocation.slots, [], [...live].reverse(),
    )
    for (const [id, slot] of allocation.slots) assert.equal(reordered.slots.get(id), slot)
  }
})

test('live thread colours remain separated through completion and new arrivals', () => {
  const history = Array.from({ length: 40 }, (_, index) => `history-${index}`)
  let live = ['live-0', 'live-1', 'live-2', 'live-3']
  let allocation = reconcileTintSlots(history, new Map(), [], [])
  for (let index = 4; index < 20; index += 1) {
    const previous = allocation.slots
    allocation = reconcileTintSlots([...history, ...live], previous, allocation.recentlyReleasedSlots, live)
    for (const id of live) {
      if (previous.has(id)) assert.equal(allocation.slots.get(id), previous.get(id))
      for (const peer of live.filter(peer => peer !== id)) {
        assert.ok(tintToneDistance(
          toneForSlot(allocation.slots.get(id))!, toneForSlot(allocation.slots.get(peer))!,
        ) >= 0.14)
      }
    }
    history.push(live[0])
    live = [...live.slice(1), `live-${index}`]
  }
})

test('late Scheduler snapshots allocate live colours before freezing them', () => {
  const ids = Array.from({ length: 66 }, (_, index) => `thread-${index}`)
  const history = reconcileTintSlots(ids, new Map(), [], [], [])
  const live = ids.slice(60)
  const active = reconcileTintSlots(ids, history.slots, [], live, history.liveIds)
  const tones = live.map(id => toneForSlot(active.slots.get(id))!)
  for (let left = 0; left < tones.length; left += 1) {
    for (let right = left + 1; right < tones.length; right += 1) {
      assert.ok(tintToneDistance(tones[left], tones[right]) >= 0.14)
    }
  }
  const refreshed = reconcileTintSlots(ids.toReversed(), active.slots, [], live.toReversed(), active.liveIds)
  for (const id of ids) assert.equal(refreshed.slots.get(id), active.slots.get(id))
  for (const id of ids.slice(0, 60)) assert.equal(active.slots.get(id), history.slots.get(id))
})

test('visible tint tones maintain perceptual separation across palette overflow', () => {
  const tones = Array.from({ length: TINT_PALETTE_SIZE + 6 }, (_, slot) => toneForSlot(slot))
    .filter((tone): tone is NonNullable<typeof tone> => Boolean(tone))
  let minimumDistance = Number.POSITIVE_INFINITY
  for (let left = 0; left < tones.length; left += 1) {
    for (let right = left + 1; right < tones.length; right += 1) {
      minimumDistance = Math.min(minimumDistance, tintToneDistance(tones[left], tones[right]))
    }
  }
  assert.ok(minimumDistance >= 0.08, `minimum OKLab distance was ${minimumDistance}`)
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
