import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAccountModelOptions,
  buildEnabledModelSelections,
  buildProviderCatalogSetupPayload,
  filterAccountModelOptions,
  ProviderWorkflowValidationError,
  resolveAccountDiagnosticPresentation,
  type AccountModelOption,
} from '../src/app/providerWorkflow.ts'

const modelOptions: AccountModelOption[] = [
  {
    id: 'claude-sonnet-4-5',
    enabled: true,
    alias: 'Writing',
    contextWindowTokens: '',
    maxInputTokens: '',
    maxOutputTokens: '',
  },
  {
    id: 'gpt-5.6-sol',
    enabled: false,
    alias: 'Coding Primary',
    contextWindowTokens: '',
    maxInputTokens: '',
    maxOutputTokens: '',
  },
]

test('model catalog search matches physical model names and aliases without mutating options', () => {
  assert.deepEqual(filterAccountModelOptions(modelOptions, 'SONNET'), [modelOptions[0]])
  assert.deepEqual(filterAccountModelOptions(modelOptions, 'coding primary'), [modelOptions[1]])
  assert.deepEqual(filterAccountModelOptions(modelOptions, '  '), modelOptions)
  assert.deepEqual(filterAccountModelOptions(modelOptions, 'missing'), [])
  assert.equal(modelOptions[0].enabled, true)
  assert.equal(modelOptions[1].enabled, false)
})

test('API setup preserves exact physical names and existing capacity metadata', () => {
  const payload = buildProviderCatalogSetupPayload(
    {
      providerId: ' custom ',
      accountId: ' account-new ',
      routeId: 'coding-route',
      alias: 'Coding',
      physicalModel: 'gpt-5.6-sol',
      adapter: 'openai-compatible',
      protocol: 'openai-responses',
      baseUrl: ' http://localhost:8317/v1 ',
    },
    'Default account',
    {
      adapter: 'openai-compatible',
      protocol: 'openai-responses',
      base_url: 'http://localhost:8317/v1',
      accounts: ['account-old'],
      models: {
        'gpt-5.6-sol': {
          context_window_tokens: 262_144,
          max_input_tokens: 240_000,
          max_output_tokens: 22_144,
        },
      },
      headers: { 'X-Test': 'preserved' },
      env_headers: {},
    },
    undefined,
    {
      credentialId: 'custom-api-key',
      credentialRef: 'custom-api-key',
      secretBackend: 'morphz_env_file',
      credential: { source: 'env', name: 'MORPHZ_PROVIDER_CUSTOM_API_KEY' },
      managedSecret: {
        name: 'MORPHZ_PROVIDER_CUSTOM_API_KEY',
        value: 'setup-secret',
        scope_kind: 'runtime',
        value_backend: 'morphz_env_file',
      },
    },
  )

  assert.deepEqual(payload.provider.accounts, ['account-old', 'account-new'])
  assert.deepEqual(payload.provider.models, {
    'gpt-5.6-sol': {
      context_window_tokens: 262_144,
      max_input_tokens: 240_000,
      max_output_tokens: 22_144,
    },
  })
  assert.equal(payload.provider.base_url, 'http://localhost:8317/v1')
  assert.equal(payload.route.display_alias, 'Coding')
  assert.deepEqual(payload.route.aliases, ['Coding'])
  assert.equal(payload.route.candidates[0].model, 'gpt-5.6-sol')
  assert.equal(payload.provider.models['gpt-5.6'], undefined)
  assert.equal(payload.account.credential_ref, 'custom-api-key')
  assert.equal(payload.account.label, 'Default account')
  assert.deepEqual(payload.managed_secret, {
    name: 'MORPHZ_PROVIDER_CUSTOM_API_KEY',
    value: 'setup-secret',
    scope_kind: 'runtime',
    value_backend: 'morphz_env_file',
  })
})

test('route id stays a control value when the user did not set an alias', () => {
  const payload = buildProviderCatalogSetupPayload(
    {
      providerId: 'local',
      accountId: 'local-account',
      routeId: 'route-1786',
      alias: '',
      physicalModel: 'physical-model-alpha',
      adapter: 'openai-compatible',
      protocol: 'openai-chat',
      baseUrl: 'http://localhost:8081/v1',
    },
    'Local',
  )

  assert.equal(payload.route.display_alias, undefined)
  assert.deepEqual(payload.route.aliases, [])
  assert.equal(payload.route_id, 'route-1786')
  assert.equal(payload.route.candidates[0].model, 'physical-model-alpha')
})

test('adding an account preserves route candidates and allocates the next priority', () => {
  const payload = buildProviderCatalogSetupPayload(
    {
      providerId: 'provider-new',
      accountId: 'account-new',
      routeId: 'shared-route',
      alias: '',
      physicalModel: 'model-new',
      adapter: 'openai-compatible',
      protocol: 'openai-responses',
      baseUrl: 'http://localhost:8317/v1',
    },
    'New account',
    undefined,
    {
      display_alias: 'Existing route',
      aliases: ['existing-route'],
      candidates: [{
        provider: 'provider-existing',
        model: 'model-existing',
        priority: 7,
        account: 'account-existing',
        capabilities: [],
      }],
      affinity: 'session',
      selection: 'available-round-robin',
      fallback: true,
    },
  )

  assert.equal(payload.route.candidates[0].priority, 7)
  assert.equal(payload.route.candidates[1].priority, 8)
  assert.equal(payload.route.display_alias, 'Existing route')
  assert.deepEqual(payload.route.aliases, ['existing-route'])
  assert.equal(payload.route.affinity, 'session')
  assert.equal(payload.route.selection, 'available-round-robin')
  assert.equal(payload.route.fallback, true)
})

test('model editor copies explicit catalog capacities and preserves operator overrides', () => {
  const options = buildAccountModelOptions({
    accountId: 'account-a',
    providerId: 'provider-a',
    routes: {
      route: {
        display_alias: 'Fast',
        aliases: ['Fast'],
        candidates: [{
          provider: 'provider-a',
          model: 'model-a',
          account: 'account-a',
          priority: 0,
          capabilities: [],
        }],
        affinity: 'context',
        selection: 'available-least-recently-used',
        fallback: false,
      },
    },
    catalog: [],
    configuredProfiles: {
      'model-a': { max_input_tokens: 180_000 },
    },
    additionallyDiscovered: ['model-a', 'model-b'],
    discoveredProfiles: {
      'model-a': {
        context_window_tokens: 200_000,
        max_input_tokens: 190_000,
        max_output_tokens: 10_000,
        max_input_attachments: 64,
        max_input_attachment_bytes: 67_108_864,
        max_input_attachment_total_bytes: 201_326_592,
      },
      'model-b': {},
    },
  })

  assert.deepEqual(options, [
    {
      id: 'model-a',
      enabled: true,
      alias: 'Fast',
      promptCacheStrategy: 'auto',
      contextWindowTokens: '200000',
      maxInputTokens: '180000',
      maxOutputTokens: '10000',
      maxInputAttachments: 64,
      maxInputAttachmentBytes: 67_108_864,
      maxInputAttachmentTotalBytes: 201_326_592,
    },
    {
      id: 'model-b',
      enabled: false,
      alias: '',
      promptCacheStrategy: 'auto',
      contextWindowTokens: '',
      maxInputTokens: '',
      maxOutputTokens: '',
    },
  ])
})

test('enabled model payload validates physical capacity relationships before the request', () => {
  const valid: AccountModelOption = {
    id: 'model-a',
    enabled: true,
    alias: ' Fast ',
    contextWindowTokens: '200000',
    maxInputTokens: '190000',
    maxOutputTokens: '10000',
    maxInputAttachments: 64,
    maxInputAttachmentBytes: 67_108_864,
    maxInputAttachmentTotalBytes: 201_326_592,
  }
  assert.deepEqual(buildEnabledModelSelections([valid]), [{
      id: 'model-a',
      alias: 'Fast',
      prompt_cache_strategy: 'auto',
    context_window_tokens: 200_000,
    max_input_tokens: 190_000,
    max_output_tokens: 10_000,
    max_input_attachments: 64,
    max_input_attachment_bytes: 67_108_864,
    max_input_attachment_total_bytes: 201_326_592,
  }])

  assert.throws(
    () => buildEnabledModelSelections([{ ...valid, maxInputTokens: '190001' }]),
    (reason: unknown) => reason instanceof ProviderWorkflowValidationError
      && reason.code === 'invalid-capacity',
  )
  assert.throws(
    () => buildEnabledModelSelections([{ ...valid, contextWindowTokens: 'not-a-number' }]),
    (reason: unknown) => reason instanceof ProviderWorkflowValidationError
      && reason.code === 'invalid-capacity',
  )
})

test('saving an empty enabled-model set is rejected before the request', () => {
  assert.throws(
    () => buildEnabledModelSelections([{
      id: 'model-a',
      enabled: false,
      alias: '',
      contextWindowTokens: '',
      maxInputTokens: '',
      maxOutputTokens: '',
    }]),
    (reason: unknown) => reason instanceof ProviderWorkflowValidationError
      && reason.code === 'select-at-least-one',
  )
})

test('account diagnostics stay bound to the account that initiated the test', () => {
  const diagnostic = { health_verified: true, elapsed_ms: 42 }
  const shared = {
    activeAccountId: 'account-a',
    diagnosing: '',
    diagnostic,
    error: '',
  }

  assert.deepEqual(resolveAccountDiagnosticPresentation({ accountId: 'account-b', ...shared }), {
    visible: false,
    state: 'hidden',
  })
  assert.deepEqual(resolveAccountDiagnosticPresentation({ accountId: 'account-a', ...shared }), {
    visible: true,
    state: 'success',
    diagnostic,
    error: '',
  })
})

test('account diagnostics expose pending and failed states without stale results', () => {
  assert.deepEqual(resolveAccountDiagnosticPresentation({
    accountId: 'account-a',
    activeAccountId: 'account-a',
    diagnosing: 'account:account-a',
    diagnostic: { health_verified: true },
    error: 'stale error',
  }), { visible: true, state: 'pending' })

  assert.deepEqual(resolveAccountDiagnosticPresentation({
    accountId: 'account-a',
    activeAccountId: 'account-a',
    diagnosing: '',
    diagnostic: null,
    error: 'HTTP 426 Upgrade Required',
  }), {
    visible: true,
    state: 'failure',
    diagnostic: null,
    error: 'HTTP 426 Upgrade Required',
  })
})
