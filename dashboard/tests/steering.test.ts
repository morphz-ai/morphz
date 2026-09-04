import assert from 'node:assert/strict'
import test from 'node:test'
import { threadAssignment, threadDestination, objectiveReplyDestination } from '../src/app/steering.ts'
import type { SchedulerThreadSnapshot } from '../src/scheduler/types.ts'
import { shortId, conversationEventKind } from '../src/app/presentation.ts'
import { buildOptimisticMessageRequest } from '../src/app/optimisticMessages.ts'
import { readSessionDraft, writeSessionDraft } from '../src/app/sessionDraft.ts'
import { invalidatedQueriesForTopic } from '../src/app/invalidation.ts'

const snapshot = {
  intent: 'Implement the parser', schedules: [{ intent: 'Scheduled fallback' }],
  thread: { id: 'thread_0123456789abcdef0123456789abcdef', generation: 3, supervision: { supervisor_kind: 'root', generation: 1 } },
} as SchedulerThreadSnapshot

test('assignment uses original task, not current tool or the whole parent goal', () => {
  assert.equal(threadAssignment(snapshot, 'Build the entire application'), 'Implement the parser')
  assert.equal(threadAssignment({ ...snapshot, intent: null }), 'Scheduled fallback')
  assert.equal(threadAssignment({ ...snapshot, intent: null, schedules: [] }), undefined)
})

test('all Dashboard surfaces use the same short Thread ID regardless of width argument', () => {
  const expected = 'thread_…456789abcdef'
  for (const size of [12, 15, 18, 22, 30]) assert.equal(shortId(snapshot.thread.id, size), expected)
})

test('primary Objective and child Thread preserve distinct authority generations', () => {
  assert.deepEqual(threadDestination(snapshot), { kind: 'thread', thread_id: snapshot.thread.id, generation: 3 })
  const primary = { ...snapshot, thread: { ...snapshot.thread, supervision: { ...snapshot.thread.supervision, supervisor_kind: 'objective' as const, supervisor_id: 'objective-1', generation: 7 } } }
  assert.deepEqual(threadDestination(primary), { kind: 'objective', objective_id: 'objective-1', generation: 7 })
  assert.equal(threadDestination({ ...primary, thread: { ...primary.thread, supervision: { ...primary.thread.supervision, origin_evaluation_id: 'evaluation-child' } } }).kind, 'thread')
})

test('question reply carries exact durable request identity; supplement carries none', () => {
  const objective = { id: 'objective-1', generation: 7, revision: 12 }
  assert.deepEqual(objectiveReplyDestination(objective), { kind: 'objective', objective_id: 'objective-1', generation: 7 })
  assert.deepEqual(objectiveReplyDestination({ ...objective, wait_condition: { kind: 'user_input', request_id: 'question-4' } }), { kind: 'objective', objective_id: 'objective-1', generation: 7, reply_to_request_id: 'question-4' })
})

test('directed input remains typed metadata, not a Session reference or rewritten user text', () => {
  const inputDestination = threadDestination(snapshot)
  const message = { clientMessageId: 'steer-1', text: 'Use UTF-8', attachments: [], references: [], inputDestination }
  const request = buildOptimisticMessageRequest(message)
  assert.deepEqual(request.input_destination, inputDestination)
  assert.equal(request.text, message.text)
  assert.deepEqual(buildOptimisticMessageRequest(message), request)
  assert.equal(conversationEventKind('chat/steering', {}), 'user')
  assert.ok(invalidatedQueriesForTopic('chat/steering').includes('scheduler'))
})

test('refresh preserves directed draft, even before the user enters text', () => {
  const records = new Map<string, string>()
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value) }, removeItem: (key: string) => { records.delete(key) } }
  const draft = { version: 1 as const, principalId: 'p', sessionId: 's', clientMessageId: 'client', text: '', attachments: [], references: [], inputSelection: { destination: threadDestination(snapshot), label: 'Parser', sessionId: 's' }, updatedAt: 'now' }
  writeSessionDraft(storage, draft)
  assert.deepEqual(readSessionDraft(storage, 'p', 's'), draft)
  assert.equal(readSessionDraft(storage, 'other-principal', 's'), undefined)
})
