import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { visibleReads, type VisibleReadScope } from '../src/app/visibleReads.ts'

const scope: VisibleReadScope = {
  view: 'dialogue', cognitionView: 'mind', globalOverview: false,
  hasSession: true, hasContext: true, eventHistoryBeforeSequence: '',
  dialogueActivityOpen: false, expandedDialogueThreadId: '',
}
const changed = ['catalog', 'session', 'overview', 'scheduler', 'events', 'thread', 'mind-transactions', 'execution-jobs'] as const
const enabled = (value: ReturnType<typeof visibleReads>) => Object.entries(value).filter(([, enabled]) => enabled).map(([key]) => key)

test('an unrelated hidden page never loads Session, history, jobs or cognition after a durable change', () => {
  for (const view of ['credentials', 'providers'])
    assert.deepEqual(enabled(visibleReads({...scope, view}, changed)), ['catalog'])
  assert.deepEqual(enabled(visibleReads({...scope, view: 'runtime'}, changed)), ['catalog', 'runtimeOverview', 'executionJobs'])
})

test('reading an older event page is not an invitation to re-read it on every new Event', () => {
  assert.deepEqual(enabled(visibleReads({...scope, view: 'events'}, ['events', 'scheduler'])), ['eventHistory'])
  assert.deepEqual(enabled(visibleReads({...scope, view: 'events', eventHistoryBeforeSequence: '123'}, changed)), ['catalog'])
})

test('only an opened Thread detail and the selected cognition pane consume their invalidations', () => {
  assert.equal(visibleReads(scope, ['thread']).dialogueThread, false)
  assert.equal(visibleReads({...scope, dialogueActivityOpen: true, expandedDialogueThreadId: 'opened'}, ['thread']).dialogueThread, true)
  assert.equal(visibleReads({...scope, view: 'scheduler', threadId: 'opened'}, ['thread']).thread, true)
  assert.equal(visibleReads({...scope, view: 'cognition', cognitionView: 'prompt'}, ['mind-transactions']).mindTransactions, false)
  assert.equal(visibleReads({...scope, view: 'cognition'}, ['mind-transactions']).mindTransactions, true)
})

test('no invalidation means no data reads; global overview works without a selected Session', () => {
  for (const view of ['dialogue', 'scheduler', 'overview', 'runtime', 'cognition', 'events', 'credentials', 'providers'])
    assert.deepEqual(enabled(visibleReads({...scope, view}, [])), [])
  assert.deepEqual(enabled(visibleReads({...scope, view: 'overview', globalOverview: true, hasSession: false}, ['scheduler'])), ['runtimeOverview'])
})

test('Dashboard page owner cannot reintroduce a periodic network reader', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /\bsetInterval\s*\(/)
  assert.match(app, /visibleReads\(/)
  assert.match(app, /reconnectTimer = window\.setTimeout\(connect,/)
})
