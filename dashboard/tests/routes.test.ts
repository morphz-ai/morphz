import assert from 'node:assert/strict'
import test from 'node:test'

import { dashboardPath, parseDashboardRoute, threadPath } from '../src/app/routes.ts'

test('dashboard routes preserve Context and Session identity', () => {
  const path = dashboardPath('dialogue', 'context/a', 'session b')
  assert.equal(path, '/contexts/context%2Fa/dialogue/session%20b')
  assert.deepEqual(parseDashboardRoute(path), {
    view: 'dialogue',
    contextId: 'context/a',
    sessionId: 'session b',
  })
})

test('dashboard routes expose every stable top-level surface', () => {
  assert.equal(dashboardPath('overview', 'ctx'), '/contexts/ctx/overview')
  assert.equal(dashboardPath('scheduler', 'ctx'), '/contexts/ctx/scheduler')
  assert.equal(dashboardPath('cognition', 'ctx', undefined, 'encoding'), '/contexts/ctx/cognition/encoding')
  assert.equal(dashboardPath('ledger', 'ctx'), '/contexts/ctx/ledger')
  assert.equal(dashboardPath('runtime'), '/runtime')
  assert.equal(threadPath('context/a', 'thread b'), '/contexts/context%2Fa/threads/thread%20b')
  assert.deepEqual(parseDashboardRoute('/contexts/context%2Fa/threads/thread%20b'), {
    view: 'scheduler',
    contextId: 'context/a',
    threadId: 'thread b',
  })
})

test('unknown paths and cognition tabs fall back to safe views', () => {
  assert.deepEqual(parseDashboardRoute('/unknown'), { view: 'overview' })
  assert.deepEqual(parseDashboardRoute('/contexts/ctx/cognition/unknown'), {
    view: 'cognition',
    contextId: 'ctx',
    cognitionView: 'mind',
  })
})
