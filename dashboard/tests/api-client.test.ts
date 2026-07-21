import assert from 'node:assert/strict'
import test from 'node:test'

import { DashboardApiClient, DashboardApiError } from '../src/api/client.ts'

test('DashboardApiClient applies one bearer identity and JSON contract', async () => {
  let captured: { url: string, init?: RequestInit } | undefined
  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.test/',
    token: 'secret',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })

  const result = await client.command<{ ok: boolean }>('/api/check', 'POST', { value: 1 })
  assert.deepEqual(result, { ok: true })
  assert.equal(captured?.url, 'http://runtime.test/api/check')
  assert.equal((captured?.init?.headers as Record<string, string>).Authorization, 'Bearer secret')
  assert.equal((captured?.init?.headers as Record<string, string>)['Content-Type'], 'application/json')
})

test('DashboardApiClient preserves status and Runtime error detail', async () => {
  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.test',
    fetchImpl: (async () => new Response(JSON.stringify({ error: 'Context 不存在' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
  })

  await assert.rejects(
    client.get('/api/contexts/missing'),
    (error: unknown) => error instanceof DashboardApiError
      && error.status === 404
      && error.message === 'Context 不存在',
  )
})

test('DashboardApiClient invokes a host fetch without rebinding its receiver', async () => {
  const hostFetch = function (this: unknown) {
    assert.equal(this, undefined)
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  } as typeof fetch

  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.local',
    fetchImpl: hostFetch,
  })

  assert.deepEqual(await client.get('/api/status'), { ok: true })
})
