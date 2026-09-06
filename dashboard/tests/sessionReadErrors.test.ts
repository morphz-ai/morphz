import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DashboardApiClient, DashboardApiError } from '../src/api/client.ts'

test('conversation reads distinguish forbidden and failed requests from a successful empty page', async () => {
  for (const status of [403, 404, 500]) {
    const api = new DashboardApiClient({
      baseUrl: 'http://runtime.test',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Cannot read this Session' } }), { status }),
    })
    await assert.rejects(api.get('/api/sessions/child/events'), (error: unknown) =>
      error instanceof DashboardApiError && error.status === status && error.message === 'Cannot read this Session')
  }
  const api = new DashboardApiClient({
    baseUrl: 'http://runtime.test',
    fetchImpl: async () => new Response(JSON.stringify({ events: [] })),
  })
  assert.deepEqual(await api.get('/api/sessions/child/events'), { events: [] })
})

test('Dialogue retains a scoped read failure and only displays empty after a successful read', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /DASHBOARD_API\.get<SessionEventsPage>/)
  assert.doesNotMatch(source, /DASHBOARD_API\.tryGet<SessionEventsPage>/)
  assert.match(source, /setSessionEventsError\(\{ sessionId, message:/)
  assert.match(source, /sessionEventsError\?\.sessionId === selectedSessionId &&/)
  assert.match(source, /eventsSessionId === selectedSessionId && sessionEventsError\?\.sessionId !== selectedSessionId/)
  assert.match(source, /conversation\.retryLoading/)
})
