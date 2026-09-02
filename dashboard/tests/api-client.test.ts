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

test('DashboardApiClient reads the structured SDK error envelope', async () => {
  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.test',
    fetchImpl: (async () => new Response(JSON.stringify({
      error: { code: 'conflict', message: '根 Context 不能归档' },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
  })

  await assert.rejects(
    client.command('/api/contexts/context-default', 'PATCH', { status: 'archived' }),
    (error: unknown) => error instanceof DashboardApiError
      && error.status === 409
      && error.message === '根 Context 不能归档',
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

test('DashboardApiClient accepts an empty successful command response', async () => {
  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.test',
    fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
  })

  assert.equal(await client.command<void>('/api/cancel', 'POST'), undefined)
})

test('DashboardApiClient uploads raw bytes with an explicit resume offset', async () => {
  let captured: { url: string, init?: RequestInit } | undefined
  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.test',
    token: 'secret',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init }
      return Response.json({ stage_id: 'stage-1', offset: 3, status: 'ready' })
    }) as typeof fetch,
  })
  const bytes = new Uint8Array([1, 2, 3])

  const stage = await client.upload<{ stage_id: string, offset: number }>(
    '/api/sessions/session-1/attachment-stages/stage-1/content',
    bytes,
    0,
  )

  assert.equal(stage.offset, 3)
  assert.equal(captured?.init?.body, bytes)
  const headers = captured?.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer secret')
  assert.equal(headers['Content-Type'], 'application/octet-stream')
  assert.equal(headers['X-Morphz-Upload-Offset'], '0')
})

test('DashboardApiClient can replace its credential without rebuilding the client', async () => {
  const authorizations: Array<string | undefined> = []
  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.test',
    token: 'old-secret',
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push((init?.headers as Record<string, string> | undefined)?.Authorization)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch,
  })

  await client.get('/api/status')
  client.setToken('new-secret')
  await client.get('/api/status')

  assert.equal(client.currentToken(), 'new-secret')
  assert.deepEqual(authorizations, ['Bearer old-secret', 'Bearer new-secret'])
})

test('DashboardApiClient reports unauthorized responses to the login gate', async () => {
  let captured: DashboardApiError | undefined
  const client = new DashboardApiClient({
    baseUrl: 'http://runtime.test',
    fetchImpl: (async () => new Response(JSON.stringify({
      error: { code: 'unauthorized', message: 'Authentication is required' },
    }), { status: 401 })) as typeof fetch,
  })
  client.setUnauthorizedHandler(error => { captured = error })

  await assert.rejects(client.get('/api/status'), DashboardApiError)
  assert.equal(captured?.status, 401)
  assert.equal(captured?.message, 'Authentication is required')
})
