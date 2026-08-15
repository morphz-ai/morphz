export interface ProviderModelProfile {
  context_window_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  max_input_attachments?: number
  max_input_attachment_bytes?: number
  max_input_attachment_total_bytes?: number
}

export interface ProviderInstanceInput {
  adapter: string
  protocol: string
  base_url: string
  accounts: string[]
  models: Record<string, ProviderModelProfile>
  headers: Record<string, string>
  env_headers: Record<string, string>
}

export interface ModelRouteCandidateInput {
  provider: string
  model: string
  priority: number
  account?: string
  capabilities: string[]
}

export interface ModelRouteInput {
  display_alias?: string
  aliases: string[]
  candidates: ModelRouteCandidateInput[]
  affinity: string
  selection: string
  fallback: boolean
}

export interface ProviderSetupInput {
  providerId: string
  accountId: string
  routeId: string
  alias: string
  physicalModel: string
  adapter: string
  protocol: string
  baseUrl: string
}

export interface ProviderSetupCredentialInput {
  credentialId: string
  credentialRef: string
  secretBackend?: string
  credential: Record<string, unknown>
  managedSecret: {
    name: string
    value: string
    scope_kind: 'runtime'
    value_backend: string
  }
}

export interface ProviderCatalogSetupPayload {
  provider_id: string
  provider: ProviderInstanceInput
  account_id: string
  account: {
    auth_adapter: string
    credential_ref: string
    secret_backend?: string
    provider: string
    label: string
    enabled: boolean
  }
  credential_id?: string
  credential?: Record<string, unknown>
  managed_secret?: ProviderSetupCredentialInput['managedSecret']
  route_id: string
  route: ModelRouteInput
}

export interface DiscoveredModelRecord {
  provider_instance_id: string
  auth_account_id: string
  physical_model: string
}

export interface AccountModelOption {
  id: string
  enabled: boolean
  alias: string
  contextWindowTokens: string
  maxInputTokens: string
  maxOutputTokens: string
  maxInputAttachments?: number
  maxInputAttachmentBytes?: number
  maxInputAttachmentTotalBytes?: number
}

export interface EnabledModelSelection {
  id: string
  alias?: string
  context_window_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  max_input_attachments?: number
  max_input_attachment_bytes?: number
  max_input_attachment_total_bytes?: number
}

export interface AccountDiagnosticLike {
  health_verified: boolean
}

export type AccountDiagnosticPresentation<T extends AccountDiagnosticLike> =
  | { visible: false; state: 'hidden' }
  | { visible: true; state: 'pending' }
  | { visible: true; state: 'success' | 'failure'; diagnostic: T; error: '' }
  | { visible: true; state: 'failure'; diagnostic: null; error: string }

export type ModelSelectionValidationError =
  | 'select-at-least-one'
  | 'invalid-capacity'

export class ProviderWorkflowValidationError extends Error {
  readonly code: ModelSelectionValidationError

  constructor(code: ModelSelectionValidationError) {
    super(code)
    this.name = 'ProviderWorkflowValidationError'
    this.code = code
  }
}

export function resolveAccountDiagnosticPresentation<T extends AccountDiagnosticLike>(input: {
  accountId: string
  activeAccountId: string
  diagnosing: string
  diagnostic: T | null
  error: string
}): AccountDiagnosticPresentation<T> {
  if (input.activeAccountId !== input.accountId) {
    return { visible: false, state: 'hidden' }
  }
  if (input.diagnosing === `account:${input.accountId}`) {
    return { visible: true, state: 'pending' }
  }
  if (input.diagnostic) {
    return {
      visible: true,
      state: input.diagnostic.health_verified ? 'success' : 'failure',
      diagnostic: input.diagnostic,
      error: '',
    }
  }
  if (input.error) {
    return { visible: true, state: 'failure', diagnostic: null, error: input.error }
  }
  return { visible: false, state: 'hidden' }
}

export function buildProviderCatalogSetupPayload(
  setup: ProviderSetupInput,
  accountLabel: string,
  previousProvider?: ProviderInstanceInput,
  previousRoute?: ModelRouteInput,
  credential?: ProviderSetupCredentialInput,
): ProviderCatalogSetupPayload {
  const providerId = setup.providerId.trim()
  const accountId = setup.accountId.trim()
  const routeId = setup.routeId.trim()
  const physicalModel = setup.physicalModel.trim()
  const explicitAlias = setup.alias.trim()
  const candidates = previousRoute?.candidates
    .filter(candidate => candidate.account !== accountId) ?? []
  const nextPriority = candidates.reduce(
    (highest, candidate) => Math.max(highest, candidate.priority),
    -1,
  ) + 1
  const previousProfile = previousProvider?.models[physicalModel]
  const aliases = explicitAlias
    ? Array.from(new Set([
        ...(explicitAlias !== routeId ? [explicitAlias] : []),
        ...(previousRoute?.aliases ?? []),
      ]))
    : (previousRoute?.aliases ?? [])

  return {
    provider_id: providerId,
    provider: {
      adapter: setup.adapter.trim(),
      protocol: setup.protocol,
      base_url: setup.baseUrl.trim(),
      accounts: Array.from(new Set([...(previousProvider?.accounts ?? []), accountId])),
      models: {
        ...(previousProvider?.models ?? {}),
        [physicalModel]: previousProfile ?? {},
      },
      headers: previousProvider?.headers ?? {},
      env_headers: previousProvider?.env_headers ?? {},
    },
    account_id: accountId,
    account: {
      auth_adapter: credential ? 'credential' : 'none',
      credential_ref: credential?.credentialRef ?? '',
      secret_backend: credential?.secretBackend,
      provider: providerId,
      label: accountLabel,
      enabled: true,
    },
    credential_id: credential?.credentialId,
    credential: credential?.credential,
    managed_secret: credential?.managedSecret,
    route_id: routeId,
    route: {
      display_alias: explicitAlias || previousRoute?.display_alias,
      aliases,
      candidates: [
        ...candidates,
        {
          provider: providerId,
          model: physicalModel,
          priority: nextPriority,
          account: accountId,
          capabilities: [],
        },
      ],
      affinity: previousRoute?.affinity ?? 'context',
      selection: previousRoute?.selection ?? 'available-least-recently-used',
      fallback: previousRoute?.fallback ?? false,
    },
  }
}

export function buildAccountModelOptions(input: {
  accountId: string
  providerId: string
  routes: Record<string, ModelRouteInput>
  catalog: DiscoveredModelRecord[]
  configuredProfiles: Record<string, ProviderModelProfile>
  additionallyDiscovered?: string[]
  discoveredProfiles?: Record<string, ProviderModelProfile>
}): AccountModelOption[] {
  const enabled = new Set<string>()
  const aliases = new Map<string, string>()
  for (const route of Object.values(input.routes)) {
    for (const candidate of route.candidates) {
      if (candidate.provider === input.providerId && candidate.account === input.accountId) {
        enabled.add(candidate.model)
        const alias = route.display_alias?.trim() || route.aliases[0]?.trim() || ''
        if (alias && !aliases.has(candidate.model)) aliases.set(candidate.model, alias)
      }
    }
  }
  const additionallyDiscovered = input.additionallyDiscovered ?? []
  const authoritativeDiscovery = additionallyDiscovered.length > 0
  const discovered = new Set([
    ...input.catalog
      .filter(model => model.provider_instance_id === input.providerId
        && model.auth_account_id === input.accountId)
      .map(model => model.physical_model),
    ...additionallyDiscovered,
    ...(authoritativeDiscovery ? [] : enabled),
  ])
  const discoveredProfiles = input.discoveredProfiles ?? {}

  return Array.from(discovered).sort().map(id => {
    const configured = input.configuredProfiles[id]
    const provider = discoveredProfiles[id]
    const maxInputAttachments =
      configured?.max_input_attachments ?? provider?.max_input_attachments
    const maxInputAttachmentBytes =
      configured?.max_input_attachment_bytes ?? provider?.max_input_attachment_bytes
    const maxInputAttachmentTotalBytes = configured?.max_input_attachment_total_bytes
      ?? provider?.max_input_attachment_total_bytes
    return {
      id,
      enabled: enabled.has(id),
      alias: aliases.get(id) ?? '',
      contextWindowTokens:
        (configured?.context_window_tokens ?? provider?.context_window_tokens)?.toString() ?? '',
      maxInputTokens:
        (configured?.max_input_tokens ?? provider?.max_input_tokens)?.toString() ?? '',
      maxOutputTokens:
        (configured?.max_output_tokens ?? provider?.max_output_tokens)?.toString() ?? '',
      ...(maxInputAttachments === undefined ? {} : { maxInputAttachments }),
      ...(maxInputAttachmentBytes === undefined ? {} : { maxInputAttachmentBytes }),
      ...(maxInputAttachmentTotalBytes === undefined
        ? {}
        : { maxInputAttachmentTotalBytes }),
    }
  })
}

function optionalPositiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProviderWorkflowValidationError('invalid-capacity')
  }
  return parsed
}

export function buildEnabledModelSelections(options: AccountModelOption[]): EnabledModelSelection[] {
  const selected = options.filter(option => option.enabled)
  if (selected.length === 0) {
    throw new ProviderWorkflowValidationError('select-at-least-one')
  }
  return selected.map(option => {
    const contextWindow = optionalPositiveInteger(option.contextWindowTokens)
    const maxInput = optionalPositiveInteger(option.maxInputTokens)
    const maxOutput = optionalPositiveInteger(option.maxOutputTokens)
    if ((contextWindow !== undefined && maxOutput !== undefined && maxOutput >= contextWindow)
      || (contextWindow !== undefined && maxInput !== undefined && maxInput > contextWindow)
      || (contextWindow !== undefined && maxInput !== undefined && maxOutput !== undefined
        && maxInput + maxOutput > contextWindow)) {
      throw new ProviderWorkflowValidationError('invalid-capacity')
    }
    return {
      id: option.id,
      alias: option.alias.trim() || undefined,
      context_window_tokens: contextWindow,
      max_input_tokens: maxInput,
      max_output_tokens: maxOutput,
      ...(option.maxInputAttachments === undefined
        ? {}
        : { max_input_attachments: option.maxInputAttachments }),
      ...(option.maxInputAttachmentBytes === undefined
        ? {}
        : { max_input_attachment_bytes: option.maxInputAttachmentBytes }),
      ...(option.maxInputAttachmentTotalBytes === undefined
        ? {}
        : { max_input_attachment_total_bytes: option.maxInputAttachmentTotalBytes }),
    }
  })
}
