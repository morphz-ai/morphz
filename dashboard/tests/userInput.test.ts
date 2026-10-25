import assert from 'node:assert/strict'
import test from 'node:test'
import { currentQuestion, forgetQuestionForm, questionCommand, questionKey, readQuestionForms, saveQuestionForm,
  questionAnswerAccepted, legacyQuestionKey, readLegacyQuestionForms, saveLegacyQuestionForm } from '../src/app/userInput.ts'
import { invalidatedQueriesForTopic } from '../src/app/invalidation.ts'
import type { SchedulerDependencyRecord } from '../src/scheduler/types.ts'
import type { SchedulerThreadSnapshot } from '../src/scheduler/types.ts'
import type { PendingUserInputRequest } from '../../sdk/typescript/src/user-input.ts'

const request: PendingUserInputRequest = {
  request_id: 'question-native-1', thread_id: 'asking-child', thread_generation: 3,
  session_id: 'original-session', context_id: 'original-context', requested_at: '2026-10-25T01:00:00Z',
  questions: [{ id: 'preview', question: 'Enable synthetic preview?', options: [
    { id: 'yes', label: 'Enable preview' }, { id: 'no', label: 'Keep it off' },
  ] }],
}
const answers = [{ question_id: 'preview', selected_option_ids: ['yes'], text: '  Synthetic data only  ' }]
function storage() {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key(index: number) { return [...values.keys()][index] ?? null },
    getItem(key: string) { return values.get(key) ?? null }, setItem(key: string, value: string) { values.set(key, value) },
    removeItem(key: string) { values.delete(key) } }
}
test('question preview is bound to its current exact Thread, Context, Session and generation', () => {
  const snapshot = { user_input_request: request, thread: { id: request.thread_id, generation: 3,
    session_id: request.session_id, context_id: request.context_id, lifecycle: 'open' } } as SchedulerThreadSnapshot
  assert.equal(currentQuestion(snapshot), request)
  for (const patch of [{ generation: 4 }, { session_id: 'foreign' }, { context_id: 'foreign' }, { id: 'parent' }, { lifecycle: 'cancelled' }])
    assert.equal(currentQuestion({ ...snapshot, thread: { ...snapshot.thread, ...patch } } as SchedulerThreadSnapshot), undefined)
})
test('one explicit answer targets the asking child, with exact choices and no model/composer override', () => {
  const command = questionCommand(request, answers, 'one-command')!
  assert.equal(command.text, 'Enable preview\n  Synthetic data only')
  assert.deepEqual(command.input_destination, { kind: 'user_input', request_id: request.request_id,
    thread_id: 'asking-child', generation: 3, answers })
  assert.equal(command.dispatch_mode, 'parallel')
  assert.deepEqual(Object.keys(command).sort(), ['client_message_id', 'dispatch_mode', 'input_destination', 'text'])
  const mutable = structuredClone(answers)
  const frozen = questionCommand(request, mutable, 'frozen')!
  mutable[0].text = 'edited later'
  assert.equal(frozen.input_destination.answers[0].text, answers[0].text)
})
test('empty, forged, duplicate and oversized answers never become commands', () => {
  for (const value of [[], [{ ...answers[0], selected_option_ids: [], text: '' }],
    [{ ...answers[0], selected_option_ids: ['forged'] }], [{ ...answers[0], selected_option_ids: ['yes', 'yes'] }],
    [{ ...answers[0], text: 'a'.repeat(8001) }]]) assert.equal(questionCommand(request, value, 'bad'), undefined)
})
test('closed forms and unknown receipt commands survive refresh independently without retargeting the composer', () => {
  const saved = storage()
  const form = { request, title: 'TEST preview', answers, command: questionCommand(request, answers, 'stable-command')! }
  assert.equal(saveQuestionForm(saved, 'runtime:person', form), true)
  assert.deepEqual(readQuestionForms(saved, 'runtime:person'), [form])
  assert.deepEqual(readQuestionForms(saved, 'runtime:other-person'), [])
  assert.deepEqual(readQuestionForms(saved, 'other-runtime:person'), [])
  const next = { ...request, request_id: 'second-question', thread_id: 'other-child' }
  saveQuestionForm(saved, 'runtime:person', { request: next, title: 'TEST second', answers: [] })
  assert.notEqual(questionKey(next), questionKey(request))
  assert.equal(readQuestionForms(saved, 'runtime:person')[0].command?.client_message_id, 'stable-command')
  forgetQuestionForm(saved, 'runtime:person', request)
  assert.equal(saved.length, 1, 'confirming one reply must not delete another form')
})

test('question events invalidate both the waiting state and exact Thread detail immediately', () => {
  assert.deepEqual(invalidatedQueriesForTopic('runtime/user_input_requested'), ['session', 'overview', 'scheduler', 'thread'])
})
test('an accepted Human reply is resumption, not another unanswered question', () => {
  const edge = { owner_kind: 'objective', owner_id: 'goal', owner_generation: 2, dependency_kind: 'user_input', required: true,
    status: 'pending', dependency_id: request.request_id, metadata: { source: 'request_user_input', request_event_id: request.request_id, accepted_answer_event_id: 'answer' } } as SchedulerDependencyRecord
  assert.equal(questionAnswerAccepted('goal', 2, [edge]), true)
  for (const patch of [{ owner_generation: 3 }, { owner_id: 'foreign' }, { status: 'cancelled' }, { metadata: { source: 'legacy' } }])
    assert.equal(questionAnswerAccepted('goal', 2, [{ ...edge, ...patch } as SchedulerDependencyRecord]), false)
})
test('legacy forms preserve an exact wait without inventing a question body or choices', () => {
  const saved = storage()
  const form = { objectiveId: 'goal', generation: 2, requestId: 'legacy:goal:2:17', sessionId: 'session', contextId: 'context', title: 'TEST old work', body: ' My actual answer ',
    command: { client_message_id: 'stable-old', text: 'My actual answer', dispatch_mode: 'parallel' as const,
      input_destination: { kind: 'objective' as const, objective_id: 'goal', generation: 2, reply_to_request_id: 'legacy:goal:2:17' } } }
  saveLegacyQuestionForm(saved, 'runtime:person', form)
  assert.deepEqual(readLegacyQuestionForms(saved, 'runtime:person'), [form])
  assert.deepEqual(readQuestionForms(saved, 'runtime:person'), [])
  assert.notEqual(legacyQuestionKey(form), legacyQuestionKey({ ...form, requestId: 'different-question' }))
  assert.deepEqual(readLegacyQuestionForms(saved, 'other-person'), [])
})
test('one corrupt local form cannot hide valid independent drafts or become a new command', () => {
  const saved = storage()
  saveQuestionForm(saved, 'runtime:person', { request, title: 'corrupt', answers })
  saved.setItem(saved.key(0)!, '{invalid-json')
  const next = { ...request, request_id: 'valid-later', thread_id: 'later-thread' }
  saveQuestionForm(saved, 'runtime:person', { request: next, title: 'valid', answers })
  assert.equal(readQuestionForms(saved, 'runtime:person').length, 1)
  assert.equal(readQuestionForms(saved, 'runtime:person')[0].request.request_id, 'valid-later')
})
