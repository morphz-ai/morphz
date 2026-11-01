import assert from 'node:assert/strict'
import test from 'node:test'
import { objectiveControlReceipt } from '../src/app/objectiveControl.ts'

const selected = {
  id: 'TEST-goal',
  revision: 7,
  status: 'active',
  context_id: 'TEST-context',
  coordinator_session_id: 'TEST-coordinator',
  delivery_session_id: 'TEST-delivery',
  stated_objective: 'TEST original',
}

test('goal control publishes only the exact confirmed Native result without mutating its selected source', () => {
  const result = objectiveControlReceipt(selected, 'pause', {
    paused: true,
    objective: {
      ...selected,
      revision: 8,
      status: 'paused',
      status_reason: 'TEST pause',
    },
  })
  assert.equal(result.revision, 8)
  assert.equal(result.status, 'paused')
  assert.equal(selected.status, 'active')
  const resumed = objectiveControlReceipt(result, 'resume', {
    resumed: true,
    objective: { ...result, revision: 9, status: 'active' },
  })
  assert.equal(resumed.status, 'active')
})

test('unconfirmed, stale or retargeted goal receipts are never projected as success', () => {
  for (const patch of [
    { id: 'foreign' },
    { revision: 7 },
    { revision: 8.5 },
    { status: 'active' },
    { context_id: 'foreign' },
    { coordinator_session_id: 'foreign' },
    { delivery_session_id: 'foreign' },
    { stated_objective: 'changed' },
  ]) {
    assert.throws(
      () =>
        objectiveControlReceipt(selected, 'pause', {
          paused: true,
          objective: { ...selected, revision: 8, status: 'paused', ...patch },
        }),
      /Unconfirmed/,
    )
  }
  for (const response of [
    null,
    {},
    {
      paused: false,
      objective: { ...selected, revision: 8, status: 'paused' },
    },
  ])
    assert.throws(
      () => objectiveControlReceipt(selected, 'pause', response),
      /Unconfirmed/,
    )
})

test('deletion requires its exact cancellation receipt and retains original identifiers and text', () => {
  const result = objectiveControlReceipt(selected, 'delete', {
    deleted: true,
    objective_id: selected.id,
    terminal_status: 'cancelled',
  })
  assert.deepEqual(result, { ...selected, status: 'cancelled' })
  for (const response of [
    { deleted: true, objective_id: 'foreign', terminal_status: 'cancelled' },
    { deleted: false, objective_id: selected.id, terminal_status: 'cancelled' },
    { deleted: true, objective_id: selected.id, terminal_status: 'completed' },
  ])
    assert.throws(
      () => objectiveControlReceipt(selected, 'delete', response),
      /Unconfirmed/,
    )
})
