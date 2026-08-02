import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { groupModelUsageByAlias, groupPhysicalEvaluations, type ModelUsageRecord } from '../src/app/providerEvaluations.ts'

const providersSource = readFileSync(
  new URL('../src/pages/ProvidersPage.tsx', import.meta.url),
  'utf8',
)

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

test('model usage is shown once per stable alias while retaining physical paths', () => {
  const legacy = attempt('legacy', '2026-07-31T00:00:00Z', 'legacy-route', 'r0')
  delete legacy.model_binding
  legacy.model = 'coding-primary'

  const groups = groupModelUsageByAlias([
    legacy,
    attempt('old', '2026-08-01T00:00:00Z', 'coding-primary', 'r1'),
    attempt('new', '2026-08-02T00:00:00Z', 'coding-fallback', 'r2'),
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].alias, 'coding-primary')
  assert.equal(groups[0].attempts, 3)
  assert.equal(groups[0].totalTokens, 45)
  assert.equal(groups[0].paths.length, 2)
})

test('provider setup keeps OAuth accounts separate from API gateways', () => {
  const oauthCatalog = providersSource.match(/const OAUTH_SETUP_PRESETS:[\s\S]*?\n\]/)?.[0] ?? ''
  const apiCatalog = providersSource.match(/const API_SETUP_PRESETS:[\s\S]*?\n\]/)?.[0] ?? ''

  assert.doesNotMatch(oauthCatalog, /openrouter/i, 'OpenRouter must not pretend to be a native OAuth subscription')
  assert.match(apiCatalog, /id: 'openrouter'/, 'OpenRouter must remain available as an API-key service')
})

test('provider setup only presents OAuth services whose complete Runtime bootstrap is published', () => {
  assert.match(
    providersSource,
    /api\.get<OAuthSetupServicesResponse>\('\/api\/runtime\/providers\/oauth\/services'\)/,
    'the Dashboard must query the authoritative one-click OAuth service catalog',
  )
  assert.match(
    providersSource,
    /setOAuthServicesError\(nextOAuthServices\.error\)/,
    'a missing or rejected service catalog must be visible instead of becoming an unexplained empty dialog',
  )
  assert.match(providersSource, /const registered = new Map\(snapshot\.auth_adapters/)
  assert.match(providersSource, /const services = new Map\(oauthSetupServices/)
})

test('ordinary OAuth setup starts login directly without exposing internal identifiers', () => {
  const advanced = providersSource.match(/<details className="provider-setup-advanced">[\s\S]*?<\/details>/)?.[0] ?? ''

  assert.match(advanced, /providers\.providerId/)
  assert.match(advanced, /providers\.accountId/)
  assert.match(providersSource, /onClick=\{\(\) => void startOAuthSetup\(preset\)\}/)
  assert.match(providersSource, /'\/api\/runtime\/providers\/oauth\/start'/)
  assert.match(providersSource, /\{ service: preset\.id \}/)
  assert.match(providersSource, /window\.open\('about:blank'/)
  assert.doesNotMatch(
    providersSource.match(/const startOAuthSetup = async[\s\S]*?\n {2}const mutateAccount/)?.[0] ?? '',
    /providerId|accountId|routeId|physicalModel/,
    'ordinary OAuth setup must not manufacture catalog identifiers in the browser',
  )
  assert.doesNotMatch(
    providersSource.match(/const OAUTH_SETUP_PRESETS:[\s\S]*?\n\]/)?.[0] ?? '',
    /providerId|accountId|routeId|physicalModel|baseUrl/,
    'the browser OAuth catalog must contain service identities only',
  )
  assert.match(providersSource, /provider-oauth-progress/)
  assert.match(providersSource, /provider-oauth-inline-error/)
})
