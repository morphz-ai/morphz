import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { groupModelUsageByAlias, groupPhysicalEvaluations, type ModelUsageRecord } from '../src/app/providerEvaluations.ts'

const providersSource = readFileSync(
  new URL('../src/pages/ProvidersPage.tsx', import.meta.url),
  'utf8',
)
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const zhCatalog = readFileSync(new URL('../src/i18n/locales/zh.json', import.meta.url), 'utf8')

function attempt(eventId: string, timestamp: string, routeId: string, routeRevision: string): ModelUsageRecord {
  return {
    event_id: eventId,
    timestamp,
    context_id: 'context-a',
    session_id: 'session-a',
    attempt_id: `attempt-${eventId}`,
    model: 'physical-model-alpha',
    model_binding: {
      requested_alias: 'coding-primary',
      route_id: routeId,
      route_revision: routeRevision,
      provider_instance_id: 'openai-subscription',
      auth_account_id: 'openai-personal',
      physical_model: 'physical-model-alpha',
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

test('API-key setup is protocol based and does not invent provider brands', () => {
  const oauthCatalog = providersSource.match(/const OAUTH_SETUP_PRESETS:[\s\S]*?\n\]/)?.[0] ?? ''
  const protocols = providersSource.match(/const API_PROTOCOLS = \[[\s\S]*?\n\]/)?.[0] ?? ''

  assert.doesNotMatch(oauthCatalog, /openrouter/i, 'OpenRouter must not pretend to be a native OAuth subscription')
  assert.doesNotMatch(providersSource, /API_SETUP_PRESETS|apiPresets|id: 'openrouter'/)
  assert.match(protocols, /openai-responses/)
  assert.match(protocols, /openai-chat/)
  assert.match(protocols, /anthropic-messages/)
  assert.match(protocols, /gemini-content/)
  assert.match(providersSource, /'\/api\/runtime\/providers\/discover-models'/)
  assert.match(providersSource, /response\.models\.map|discoveredModels\.map/)
  assert.match(providersSource, /display_alias: requestedSetup\.alias\.trim\(\) \|\| undefined/)
})

test('unfinished OAuth attempts are not rendered as accounts', () => {
  assert.match(providersSource, /!record\.oauth \|\| record\.authenticated/)
  assert.doesNotMatch(providersSource, /unfinishedLogin|groupProviderAccounts/)
})

test('account tests report progress and results beside the account that started them', () => {
  assert.match(providersSource, /diagnosticAccountId === accountId/)
  assert.match(providersSource, /providers\.testingAccount/)
  assert.match(providersSource, /providers\.testSucceeded/)
  assert.match(providersSource, /providers\.testFailed/)
  assert.match(providersSource, /currentAccountDiagnostic\.elapsed_ms/)
  assert.match(providersSource, /currentAccountDiagnostic\.discovered_models\.length/)
})

test('authenticated accounts discover and explicitly enable models outside the login form', () => {
  assert.match(providersSource, /openAccountModels/)
  assert.match(providersSource, /providers\.manageModels/)
  assert.match(providersSource, /\/api\/runtime\/providers\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/refresh-models/)
  assert.match(providersSource, /\/api\/runtime\/providers\/accounts\/\$\{encodeURIComponent\(modelEditor\.accountId\)\}\/models/)
  assert.match(providersSource, /providers\.modelCapacityAdvanced/)
  assert.match(providersSource, /providers\.modelAliasOptional/)
  assert.match(providersSource, /alias: option\.alias\.trim\(\) \|\| undefined/)
  assert.match(providersSource, /placeholder=\{t\('providers\.notProvided'\)\}/)
})

test('provider capacity is copied from catalog fields without speculative copy', () => {
  assert.match(providersSource, /discovered_model_profiles/)
  assert.match(providersSource, /result\.discovered_model_profiles \?\? \{\}/)
  assert.match(zhCatalog, /服务目录返回的容量会直接填入/)
  assert.match(zhCatalog, /服务未提供/)
  assert.doesNotMatch(zhCatalog, /服务目录往往不提供可靠的容量信息/)
})

test('conversation selector renders the catalog display label, never the route control id', () => {
  assert.match(appSource, /status\?\.model_options/)
  assert.match(appSource, /<option key=\{option\.id\} value=\{option\.id\}>\{option\.label\}<\/option>/)
  assert.match(appSource, /className=\{`model-status \$\{selectedModelOption \? 'ok' : ''\}`\}>\{selectedModelLabel\}/)
  assert.match(appSource, /contextBudgetModelLabel/)
  assert.doesNotMatch(appSource, /className=\{`model-status[^\n]*\}>\{status\?\.model/)
  assert.doesNotMatch(appSource, /\(status\?\.models \?\? \(status\?\.model/)
  assert.match(appSource, /model\.manageModels/)
  assert.match(appSource, /setView\('providers'\)/)
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

test('ordinary OAuth setup reviews instructions before starting without exposing internal identifiers', () => {
  assert.match(providersSource, /onClick=\{\(\) => prepareOAuthSetup\(preset\)\}/)
  assert.match(providersSource, /const beginPreparedLogin/)
  assert.match(providersSource, /providers\.loginPreparationHint/)
  assert.match(providersSource, /providers\.generateDeviceCode/)
  assert.match(providersSource, /'\/api\/runtime\/providers\/oauth\/start'/)
  assert.match(providersSource, /\{ service \}/)
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
  assert.doesNotMatch(
    providersSource.match(/const OAUTH_SETUP_PRESETS:[\s\S]*?\n\]/)?.[0] ?? '',
    /id: 'codex-device'/,
    'device code is a Codex login method, not another Codex service',
  )
})

test('remote loopback OAuth submits the browser URL by state and explains both handoff paths', () => {
  assert.match(providersSource, /'\/api\/runtime\/providers\/oauth\/callback'/)
  assert.match(providersSource, /\{ redirect_url: callbackResponse \}/)
  assert.match(providersSource, /providers\.remoteLoginCopy/)
  assert.match(providersSource, /providers\.runtimeBrowserOption/)
  assert.match(providersSource, /copyTextToClipboard\(challengeAuthorizationUrl\)/)
  assert.match(providersSource, /providers\.deviceLoginMethodHint/)
  assert.match(providersSource, /copyTextToClipboard\(challenge\.user_code\)/)
  assert.match(providersSource, /readTextFromClipboard\(\)/)
  assert.match(providersSource, /continueLogin\(callbackUrl\)/)
  assert.match(providersSource, /ssh -N -L/)
  assert.match(providersSource, /challenge\.callback_state/)
  assert.match(
    providersSource,
    /challenge\.callback_mode === 'loopback'/,
    'manual callback handoff must only be shown for desktop loopback clients',
  )
})
