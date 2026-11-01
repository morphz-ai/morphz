import assert from 'node:assert/strict'
import test from 'node:test'
import { DashboardApiClient } from '../src/api/client.ts'
import { submitThreadControl } from '../src/app/threadControl.ts'

const original = {
  id: 'thread/confirmed',
  context_id: 'context-confirmed',
  session_id: 'session-confirmed',
  root_turn_id: 'root-confirmed',
  agent_id: 'agent',
  kind: 'execution',
  generation: 7,
  lifecycle: 'open',
  control_state: 'active',
  revision: 1,
}
function fixture(
  options: {
    conflicts?: number
    change?: string
    failure?: number
    postReadFailure?: boolean
  } = {},
) {
  let current: typeof original = { ...original, revision: 8 },
    writes = 0
  const reads: string[] = [],
    revisions: number[] = []
  const api = new DashboardApiClient({
    baseUrl: 'http://synthetic.invalid',
    fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname
      assert.equal(
        path,
        '/api/contexts/context-confirmed/threads/thread%2Fconfirmed' +
          (!init?.method ? '/evaluation-policy' : ''),
      )
      if (!init?.method) {
        reads.push(path)
        if (options.change && (options.conflicts ? writes > 0 : true))
          current = {
            ...current,
            [options.change]: options.change === 'generation' ? 8 : 'changed',
          }
        if (options.postReadFailure && writes)
          return new Response('{}', { status: 503 })
        return Response.json({ thread: { ...current } })
      }
      assert.equal(init.method, 'POST')
      writes++
      const body = JSON.parse(String(init.body))
      revisions.push(body.expected_revision)
      assert.equal(body.expected_revision, current.revision)
      if (options.failure)
        return Response.json(
          { error: 'synthetic unknown delivery' },
          { status: options.failure },
        )
      if (writes <= (options.conflicts ?? 0)) {
        current = { ...current, revision: current.revision + 1 }
        return Response.json(
          { error: 'Thread revision conflict' },
          { status: 409 },
        )
      }
      current = {
        ...current,
        revision: current.revision + 1,
        lifecycle: body.action === 'cancel' ? 'cancelled' : 'open',
        generation: current.generation + (body.action === 'cancel' ? 1 : 0),
        control_state:
          body.action === 'pause'
            ? 'paused'
            : body.action === 'resume'
              ? 'active'
              : current.control_state,
      }
      return Response.json({ updated: true, thread: { ...current } })
    }) as typeof fetch,
  })
  return { api, reads, revisions, writes: () => writes }
}

test('confirmation uses only the exact current Thread, retaining generation/source while revision advances', async () => {
  const f = fixture()
  const receipt = await submitThreadControl(
    f.api,
    original.context_id,
    original,
    'cancel',
    'TEST cancel',
    'changed target',
  )
  assert.equal(receipt.thread.lifecycle, 'cancelled')
  assert.equal(receipt.thread.generation, 8)
  assert.deepEqual(f.revisions, [8])
  assert.equal(f.reads.length, 1)
})

test('one explicit CAS conflict refreshes the same generation once, without resending unknown failures', async () => {
  const f = fixture({ conflicts: 1 })
  const receipt = await submitThreadControl(
    f.api,
    original.context_id,
    original,
    'pause',
    'TEST pause',
    'changed target',
  )
  assert.equal(receipt.thread.control_state, 'paused')
  assert.deepEqual(f.revisions, [8, 9])
  assert.equal(f.reads.length, 2)
  for (const status of [401, 403, 500, 503]) {
    const failed = fixture({ failure: status })
    await assert.rejects(
      submitThreadControl(
        failed.api,
        original.context_id,
        original,
        'cancel',
        'TEST',
        'changed target',
      ),
    )
    assert.equal(failed.writes(), 1)
  }
})

test('a new generation or changed source/control state never inherits a prior confirmation', async () => {
  for (const change of [
    'generation',
    'context_id',
    'session_id',
    'root_turn_id',
    'agent_id',
    'control_state',
    'kind',
    'lifecycle',
  ]) {
    for (const afterConflict of [false, true]) {
      const f = fixture({ change, conflicts: afterConflict ? 1 : undefined })
      await assert.rejects(
        submitThreadControl(
          f.api,
          original.context_id,
          original,
          'cancel',
          'TEST',
          'changed target',
        ),
        /changed target/,
      )
      assert.equal(f.writes(), afterConflict ? 1 : 0, change)
    }
  }
})

test('conflict repair is bounded, and success returns the receipt without a post-write read or replay', async () => {
  const racing = fixture({ conflicts: 5 })
  await assert.rejects(
    submitThreadControl(
      racing.api,
      original.context_id,
      original,
      'cancel',
      'TEST',
      'changed target',
    ),
    /changed target/,
  )
  assert.equal(racing.writes(), 2)
  const accepted = fixture({ postReadFailure: true })
  const receipt = await submitThreadControl(
    accepted.api,
    original.context_id,
    original,
    'cancel',
    'TEST',
    'changed target',
  )
  assert.equal(receipt.updated, true)
  assert.equal(accepted.writes(), 1)
  assert.equal(accepted.reads.length, 1)
})
