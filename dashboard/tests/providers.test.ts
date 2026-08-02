import assert from 'node:assert/strict'
import test from 'node:test'

import { groupPhysicalEvaluations, type ModelUsageRecord } from '../src/app/providerEvaluations.ts'

function attempt(eventId: string, timestamp: string, routeId: string, routeRevision: string): ModelUsageRecord {
  return {
    event_id: eventId,
    timestamp,
    context_id: 'context-a',
    session_id: 'session-a',
    attempt_id: `attempt-${eventId}`,
    model: 'gpt-5.6',
    model_binding: {
      requested_alias: 'coding-primary',
      route_id: routeId,
      route_revision: routeRevision,
      provider_instance_id: 'openai-subscription',
      auth_account_id: 'openai-personal',
      physical_model: 'gpt-5.6',
      protocol: 'openai-responses',
      provider_adapter: 'openai-codex',
      provider_adapter_version: '1',
      endpoint: 'https://example.invalid/v1',
      capabilities: [],
    },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }
}

test('physical evaluations stay grouped across logical routes and revisions', () => {
  const groups = groupPhysicalEvaluations([
    attempt('old', '2026-08-01T00:00:00Z', 'coding-primary', 'r1'),
    attempt('new', '2026-08-02T00:00:00Z', 'coding-fallback', 'r2'),
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].attempts, 2)
  assert.equal(groups[0].totalTokens, 30)
  assert.equal(groups[0].latest.event_id, 'new')
  assert.equal(groups[0].latest.model_binding?.route_revision, 'r2')
})
