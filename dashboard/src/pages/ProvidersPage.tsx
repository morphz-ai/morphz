import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleOff,
  ClipboardPaste,
  Cloud,
  Copy,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  ShieldCheck,
  Smartphone,
  Save,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DashboardApiClient } from '../api/client'
import {
  groupModelUsageByAlias,
  type ModelAttemptBinding,
  type ModelUsageRecord,
} from '../app/providerEvaluations'
import {
  buildAccountModelOptions,
  buildEnabledModelSelections,
  buildProviderCatalogSetupPayload,
  filterAccountModelOptions,
  ProviderWorkflowValidationError,
  resolveAccountDiagnosticPresentation,
  type AccountModelOption,
  type ProviderModelProfile as ProviderModelConfig,
} from '../app/providerWorkflow'
import { copyTextToClipboard, readTextFromClipboard } from '../utils/clipboard'

interface ProviderInstanceConfig {
  adapter: string
  protocol: string
  base_url: string
  accounts: string[]
  models: Record<string, ProviderModelConfig>
  headers: Record<string, string>
  env_headers: Record<string, string>
}

interface AuthAccountConfig {
  auth_adapter: string
  credential_ref: string
  secret_backend?: string
  provider?: string
  label?: string
  enabled: boolean
}

interface ProviderAccountState {
  account_id: string
  revision: number
  status: string
  cooldown_until?: string
  last_error_kind?: string
  last_used_at?: string
  updated_at: string
}

interface OAuthAccountMetadata {
  account_id: string
  adapter_id: string
  adapter_version: string
  subject?: string
  provider_account_id?: string
  email?: string
  expires_at?: string
  scopes: string[]
}

interface ProviderAccountRecord {
  config: AuthAccountConfig
  state?: ProviderAccountState
  effective_enabled: boolean
  oauth: boolean
  authenticated: boolean
  oauth_metadata?: OAuthAccountMetadata
}

interface ModelRouteCandidate {
  provider: string
  model: string
  priority: number
  account?: string
  capabilities: string[]
}

interface ModelRouteConfig {
  display_alias?: string
  aliases: string[]
  candidates: ModelRouteCandidate[]
  affinity: string
  selection: string
  fallback: boolean
}

interface ProviderControlSnapshot {
  generated_at: string
  experimental_features?: string[]
  selected_model_alias: string
  allowed_evaluation_models: string[]
  permission_mode: string
  reviewer: string
  auto_review_model?: string
  auth_adapters: AuthAdapterDescriptor[]
  provider_instances: Record<string, ProviderInstanceConfig>
  auth_accounts: Record<string, ProviderAccountRecord>
  model_routes: Record<string, ModelRouteConfig>
  discovered_models: ProviderModelCatalogRecord[]
}

interface ProviderModelCatalogRecord {
  provider_instance_id: string
  auth_account_id: string
  physical_model: string
  adapter_id: string
  adapter_version: string
  protocol: string
  source: string
  observed_at: string
}

interface AuthAdapterDescriptor {
  id: string
  version: string
  flow: 'authorization_code_pkce' | 'device_code'
  callback_mode: 'none' | 'loopback' | 'runtime'
  stability: 'stable' | 'compatibility' | 'experimental'
  upstream_reference?: string
  last_verified_on?: string
}

interface ModelRouteDiagnostic {
  checked_at: string
  binding: ModelAttemptBinding
  elapsed_ms: number
  discovered_models: string[]
  discovered_model_profiles?: Record<string, ProviderModelConfig>
  catalog_error?: string
  health_verified: boolean
  health_error?: string
}

interface ProviderAccountDiagnostic {
  checked_at: string
  provider_instance_id: string
  auth_account_id: string
  protocol: string
  provider_adapter: string
  provider_adapter_version: string
  endpoint: string
  elapsed_ms: number
  discovered_models: string[]
  discovered_model_profiles?: Record<string, ProviderModelConfig>
  catalog_error?: string
  probed_model?: string
  health_verified: boolean
  health_error?: string
}

interface OAuthLoginChallenge {
  login_id: string
  account_id: string
  adapter_id: string
  flow: 'authorization_code_pkce' | 'device_code'
  callback_mode: 'none' | 'loopback' | 'runtime'
  callback_state?: string
  redirect_uri?: string
  authorization_url?: string
  verification_uri?: string
  verification_uri_complete?: string
  user_code?: string
  expires_at: string
  poll_interval_secs: number
}

interface OAuthCallbackSubmission {
  login_id: string
  progress: OAuthLoginProgress
}

interface OAuthSetupServiceDescriptor {
  id: string
  auth_adapter: string
}

interface OAuthSetupServicesResponse {
  services: OAuthSetupServiceDescriptor[]
}

type OAuthLoginProgress =
  | { status: 'pending'; retry_after_secs: number }
  | { status: 'complete'; account: OAuthAccountMetadata }

interface ProvidersPageProps {
  api: DashboardApiClient
  startInSetup?: boolean
  onModelCatalogChanged?: () => Promise<void> | void
}

type CatalogEditorKind = 'provider_instance' | 'auth_account' | 'model_route'

interface CatalogEditorState {
  kind: CatalogEditorKind
  id: string
  value: string
  creating: boolean
  displayName: string
}

interface CatalogMutationReceipt {
  kind: CatalogEditorKind | 'provider_catalog' | 'permission_settings'
  id: string
  managed_config_path: string
  restart_required: boolean
}

interface AccountModelEditorState {
  accountId: string
  providerId: string
  label: string
  options: AccountModelOption[]
  loading: boolean
  error: string
  errorKind: 'catalog' | 'validation' | 'save' | ''
}

type ProviderSetupMode = 'oauth' | 'api_key'

interface ProviderSetupState {
  mode: ProviderSetupMode
  preset: string
  name: string
  providerId: string
  accountId: string
  routeId: string
  alias: string
  physicalModel: string
  adapter: string
  authAdapter: string
  protocol: string
  baseUrl: string
  apiKey: string
}

interface OAuthSetupPreset {
  id: string
  authAdapter: string
}

interface OAuthPreparationState {
  kind: 'setup' | 'account'
  preset: OAuthSetupPreset
  adapterId: string
  accountId?: string
}

type OAuthConnectionRetry =
  | { kind: 'setup'; preset: OAuthSetupPreset }
  | { kind: 'account'; accountId: string; adapterId?: string }

interface OAuthConnectionState {
  label: string
  stage: 'connecting' | 'failed'
  retry: OAuthConnectionRetry
  error?: string
}

// The browser only identifies the requested service. Provider, account and
// route identities are allocated atomically by the Runtime bootstrap endpoint.
const OAUTH_SETUP_PRESETS: OAuthSetupPreset[] = [
  { id: 'codex', authAdapter: 'codex-oauth' },
  { id: 'kimi', authAdapter: 'kimi-oauth' },
  { id: 'anthropic', authAdapter: 'claude-oauth' },
  { id: 'antigravity', authAdapter: 'antigravity-oauth' },
  { id: 'xai', authAdapter: 'xai-oauth' },
]

const API_PROTOCOLS = [
  { id: 'openai-responses', adapter: 'openai-compatible' },
  { id: 'openai-chat', adapter: 'openai-compatible' },
  { id: 'anthropic-messages', adapter: 'protocol-compatible' },
  { id: 'gemini-content', adapter: 'protocol-compatible' },
] as const

const EMPTY_SNAPSHOT: ProviderControlSnapshot = {
  generated_at: '',
  selected_model_alias: '',
  allowed_evaluation_models: [],
  permission_mode: '',
  reviewer: '',
  auth_adapters: [],
  provider_instances: {},
  auth_accounts: {},
  model_routes: {},
  discovered_models: [],
}

function localDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function defaultSetup(): ProviderSetupState {
  return setupForProtocol(API_PROTOCOLS[0], 'oauth')
}

function setupForProtocol(
  protocol: (typeof API_PROTOCOLS)[number],
  mode: ProviderSetupMode,
): ProviderSetupState {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const providerId = `api-${suffix}`
  return {
    mode,
    preset: protocol.id,
    name: '',
    providerId,
    accountId: `${providerId}-account`,
    routeId: '',
    alias: '',
    physicalModel: '',
    adapter: protocol.adapter,
    authAdapter: 'credential',
    protocol: protocol.id,
    baseUrl: '',
    apiKey: '',
  }
}

function logicalAuthAdapter(adapter: string): string {
  return adapter === 'codex-device-oauth' ? 'codex-oauth' : adapter
}

function modelRouteDisplayLabel(route: ModelRouteConfig): string {
  return route.display_alias?.trim()
    || route.aliases[0]?.trim()
    || Array.from(new Set(route.candidates.map(candidate => candidate.model))).join(' / ')
}

function resolvedRouteId(
  routes: Record<string, ModelRouteConfig>,
  routeOrAlias?: string,
): string {
  if (!routeOrAlias) return ''
  return Object.entries(routes).find(([routeId, route]) => (
    routeId === routeOrAlias || route.aliases.includes(routeOrAlias)
  ))?.[0] ?? routeOrAlias
}

function presetForAccount(accountId: string, record: ProviderAccountRecord): OAuthSetupPreset | undefined {
  void accountId
  const adapter = logicalAuthAdapter(record.config.auth_adapter)
  return OAUTH_SETUP_PRESETS.find(preset => preset.authAdapter === adapter)
}

function loopbackPort(redirectUri?: string): string {
  if (!redirectUri) return ''
  try {
    const url = new URL(redirectUri)
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '::1') return ''
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
}

function stateSuffix(state?: string): string {
  return state ? `…${state.slice(-8)}` : ''
}

export function ProvidersPage({ api, startInSetup = false, onModelCatalogChanged }: ProvidersPageProps) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ProviderControlSnapshot>(EMPTY_SNAPSHOT)
  const [oauthSetupServices, setOAuthSetupServices] = useState<OAuthSetupServiceDescriptor[]>([])
  const [oauthServicesError, setOAuthServicesError] = useState('')
  const [attempts, setAttempts] = useState<ModelUsageRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyAccount, setBusyAccount] = useState('')
  const [error, setError] = useState('')
  const [challenge, setChallenge] = useState<OAuthLoginChallenge | null>(null)
  const [challengeLabelOverride, setChallengeLabelOverride] = useState('')
  const [challengeError, setChallengeError] = useState('')
  const [authorizationResponse, setAuthorizationResponse] = useState('')
  const [authorizationLinkCopied, setAuthorizationLinkCopied] = useState(false)
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false)
  const [oauthPreparation, setOAuthPreparation] = useState<OAuthPreparationState | null>(null)
  const [oauthConnection, setOAuthConnection] = useState<OAuthConnectionState | null>(null)
  const [catalogEditor, setCatalogEditor] = useState<CatalogEditorState | null>(null)
  const [accountPendingDeletion, setAccountPendingDeletion] = useState<{ id: string; label: string } | null>(null)
  const [catalogNotice, setCatalogNotice] = useState('')
  const [diagnostic, setDiagnostic] = useState<ModelRouteDiagnostic | null>(null)
  const [accountDiagnostic, setAccountDiagnostic] = useState<ProviderAccountDiagnostic | null>(null)
  const [diagnosing, setDiagnosing] = useState('')
  const [diagnosticAccountId, setDiagnosticAccountId] = useState('')
  const [diagnosticError, setDiagnosticError] = useState('')
  const [modelEditor, setModelEditor] = useState<AccountModelEditorState | null>(null)
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [savingModels, setSavingModels] = useState(false)
  const [setup, setSetup] = useState<ProviderSetupState | null>(() => (
    startInSetup ? defaultSetup() : null
  ))
  const [savingSetup, setSavingSetup] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const [modelDiscoveryError, setModelDiscoveryError] = useState('')
  const [reviewerModel, setReviewerModel] = useState('')
  const [savingReviewerModel, setSavingReviewerModel] = useState(false)
  const [primaryModel, setPrimaryModel] = useState('')
  const [allowedEvaluationModels, setAllowedEvaluationModels] = useState<string[]>([])
  const [savingEvaluationModelPolicy, setSavingEvaluationModelPolicy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const oauthServicesRequest = api.get<OAuthSetupServicesResponse>('/api/runtime/providers/oauth/services')
        .then(data => ({ data, error: '' }))
        .catch(reason => ({
          data: undefined,
          error: reason instanceof Error ? reason.message : String(reason),
        }))
      const [nextSnapshot, nextAttempts, nextOAuthServices] = await Promise.all([
        api.get<ProviderControlSnapshot>('/api/runtime/providers'),
        api.get<ModelUsageRecord[]>('/api/runtime/providers/attempts?limit=40'),
        oauthServicesRequest,
      ])
      setSnapshot(nextSnapshot)
      setReviewerModel(resolvedRouteId(nextSnapshot.model_routes, nextSnapshot.auto_review_model))
      const nextPrimary = resolvedRouteId(nextSnapshot.model_routes, nextSnapshot.selected_model_alias)
      setPrimaryModel(nextPrimary)
      setAllowedEvaluationModels(Array.from(new Set(
        nextSnapshot.allowed_evaluation_models
          .map(model => resolvedRouteId(nextSnapshot.model_routes, model))
          .filter(model => model && model !== nextPrimary),
      )).sort())
      setAttempts(nextAttempts)
      setOAuthSetupServices(nextOAuthServices.data?.services ?? [])
      setOAuthServicesError(nextOAuthServices.error)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  useEffect(() => {
    if (!challenge || busyAccount === challenge.account_id) return

    let cancelled = false
    const loginId = challenge.login_id
    const retryAfter = Math.max(1, challenge.poll_interval_secs || 5)
    const timer = window.setTimeout(async () => {
      try {
        const progress = await api.command<OAuthLoginProgress>(
          `/api/runtime/providers/oauth/${encodeURIComponent(loginId)}/continue`,
          'POST',
          { kind: 'poll' },
        )
        if (cancelled) return
        if (progress.status === 'complete') {
          setChallenge(current => current?.login_id === loginId ? null : current)
          setChallengeError('')
          setError('')
          await refresh()
          return
        }
        setChallenge(current => current?.login_id === loginId
          ? { ...current, poll_interval_secs: Math.max(1, progress.retry_after_secs) }
          : current)
      } catch (reason) {
        if (cancelled) return
        setChallengeError(reason instanceof Error ? reason.message : String(reason))
        // Keep a transient Dashboard/network failure from abandoning a login
        // that may still be progressing in the provider's authorization page.
        setChallenge(current => current?.login_id === loginId
          ? { ...current, poll_interval_secs: Math.min(30, retryAfter + 5) }
          : current)
      }
    }, retryAfter * 1000)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [api, busyAccount, challenge, refresh])

  const instances = useMemo(() => Object.entries(snapshot.provider_instances), [snapshot.provider_instances])
  // OAuth setup attempts are never accounts. Old runtimes may still return
  // unfinished rows during migration, so keep them out of the product UI.
  const accounts = useMemo(
    () => Object.entries(snapshot.auth_accounts).filter(([, record]) => !record.oauth || record.authenticated),
    [snapshot.auth_accounts],
  )
  const routes = useMemo(() => Object.entries(snapshot.model_routes), [snapshot.model_routes])
  const modelUsage = useMemo(() => groupModelUsageByAlias(attempts), [attempts])
  const oauthSetupOptions = useMemo(() => {
    const registered = new Map(snapshot.auth_adapters.map(adapter => [adapter.id, adapter]))
    const services = new Map(oauthSetupServices.map(service => [service.id, service]))
    return OAUTH_SETUP_PRESETS.flatMap(preset => {
      const service = services.get(preset.id)
      const descriptor = service ? registered.get(service.auth_adapter) : undefined
      return service && descriptor ? [{ preset, descriptor }] : []
    })
  }, [oauthSetupServices, snapshot.auth_adapters])
  const codexDeviceAvailable = snapshot.auth_adapters.some(
    adapter => adapter.id === 'codex-device-oauth' && adapter.flow === 'device_code',
  )

  const switchSetupMode = (mode: ProviderSetupMode) => {
    setSetup(setupForProtocol(API_PROTOCOLS[0], mode))
    setDiscoveredModels([])
    setModelDiscoveryError('')
  }

  const discoverModels = async () => {
    if (!setup || setup.mode !== 'api_key') return
    if (!setup.baseUrl.trim() || !setup.apiKey.trim()) {
      setModelDiscoveryError(t('providers.discoveryRequired'))
      return
    }
    setDiscoveringModels(true)
    setModelDiscoveryError('')
    setDiscoveredModels([])
    try {
      const response = await api.command<{ models: string[] }>(
        '/api/runtime/providers/discover-models',
        'POST',
        {
          protocol: setup.protocol,
          base_url: setup.baseUrl.trim(),
          api_key: setup.apiKey,
        },
      )
      if (response.models.length === 0) {
        setModelDiscoveryError(t('providers.noDiscoveredModels'))
        return
      }
      setDiscoveredModels(response.models)
      const physicalModel = response.models[0]
      setSetup(current => current ? {
        ...current,
        physicalModel,
        alias: '',
        routeId: physicalModel,
      } : current)
    } catch (reason) {
      setModelDiscoveryError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDiscoveringModels(false)
    }
  }

  const saveProviderSetup = async (requestedSetup: ProviderSetupState | null = setup) => {
    if (!requestedSetup) return
    const providerId = requestedSetup.providerId.trim()
    const accountId = requestedSetup.accountId.trim()
    const routeId = requestedSetup.routeId.trim()
    const physicalModel = requestedSetup.physicalModel.trim()
    if (!requestedSetup.name.trim() || !providerId || !accountId || !routeId || !physicalModel
      || !requestedSetup.baseUrl.trim() || !requestedSetup.apiKey.trim()) {
      setError(t('providers.setupRequired'))
      return
    }
    setSavingSetup(true)
    setError('')
    try {
      let credentialId: string | undefined
      let credential: Record<string, unknown> | undefined
      let credentialRef = ''
      let secretBackend: string | undefined
      let managedSecret: {
        name: string
        value: string
        scope_kind: 'runtime'
        value_backend: string
      } | undefined
      if (requestedSetup.mode === 'api_key' && requestedSetup.apiKey) {
        const envName = `MORPHZ_PROVIDER_${providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
        managedSecret = {
          name: envName,
          value: requestedSetup.apiKey,
          scope_kind: 'runtime',
          value_backend: 'morphz_env_file',
        }
        credentialId = `${providerId}-api-key`
        credentialRef = credentialId
        secretBackend = 'morphz_env_file'
        credential = { source: 'env', name: envName, service: null, command: [] }
      }
      const previousProvider = snapshot.provider_instances[providerId]
      const previousRoute = snapshot.model_routes[routeId]
      const payload = buildProviderCatalogSetupPayload(
        requestedSetup,
        requestedSetup.name.trim(),
        previousProvider,
        previousRoute,
        credentialId && credential && managedSecret
          ? { credentialId, credentialRef, secretBackend, credential, managedSecret }
          : undefined,
      )
      const receipt = await api.command<CatalogMutationReceipt>(
        '/api/runtime/providers/setup',
        'PUT',
        payload,
      )
      setCatalogNotice(t('providers.setupSaved', { path: receipt.managed_config_path }))
      setSetup(null)
      await Promise.all([refresh(), onModelCatalogChanged?.()])
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
    } finally {
      setSavingSetup(false)
    }
  }

  const startOAuthSetup = async (preset: OAuthSetupPreset) => {
    const label = t(`providers.presets.${preset.id}`, { defaultValue: preset.id })
    const descriptor = snapshot.auth_adapters.find(adapter => adapter.id === preset.authAdapter)
    const opensBrowser = descriptor?.flow !== 'device_code'
    const popup = opensBrowser
      ? window.open('about:blank', `morphz-oauth-${preset.id}`, 'popup,width=720,height=820')
      : null
    const service = preset.id === 'codex' && preset.authAdapter === 'codex-device-oauth'
      ? 'codex-device'
      : preset.id
    setSetup(null)
    setOAuthPreparation(null)
    setOAuthConnection({ label, stage: 'connecting', retry: { kind: 'setup', preset } })
    setSavingSetup(true)
    setError('')
    try {
      const next = await api.command<OAuthLoginChallenge>(
        '/api/runtime/providers/oauth/start',
        'POST',
        { service },
      )
      const authorizationUrl = next.authorization_url
        ?? next.verification_uri_complete
        ?? next.verification_uri
      if (authorizationUrl && opensBrowser) {
        if (popup && !popup.closed) popup.location.replace(authorizationUrl)
        else window.open(authorizationUrl, '_blank', 'noopener,noreferrer')
      } else if (popup && !popup.closed) {
        popup.close()
      }
      setChallenge(next)
      setChallengeLabelOverride(label)
      setChallengeError('')
      setAuthorizationResponse('')
      setAuthorizationLinkCopied(false)
      setDeviceCodeCopied(false)
      setOAuthConnection(null)
    } catch (reason) {
      if (popup && !popup.closed) popup.close()
      setOAuthConnection({
        label,
        stage: 'failed',
        retry: { kind: 'setup', preset },
        error: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      setSavingSetup(false)
    }
  }

  const mutateAccount = async (accountId: string, record: ProviderAccountRecord) => {
    setBusyAccount(accountId)
    setError('')
    try {
      await api.command(`/api/runtime/providers/accounts/${encodeURIComponent(accountId)}`, 'PATCH', {
        action: record.effective_enabled ? 'disable' : 'enable',
        expected_revision: record.state?.revision,
      })
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAccount('')
    }
  }

  const deleteAccount = async () => {
    if (!accountPendingDeletion) return
    const { id, label } = accountPendingDeletion
    setBusyAccount(id)
    setError('')
    try {
      await api.command<CatalogMutationReceipt>(
        `/api/runtime/providers/accounts/${encodeURIComponent(id)}`,
        'DELETE',
      )
      setAccountPendingDeletion(null)
      setCatalogNotice(t('providers.accountDeleted', { account: label }))
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await refresh()
    } finally {
      setBusyAccount('')
    }
  }

  const startLogin = async (accountId: string, adapterId?: string) => {
    const record = snapshot.auth_accounts[accountId]
    const preset = record ? presetForAccount(accountId, record) : undefined
    const label = record?.config.label
      || (preset ? t(`providers.presets.${preset.id}`, { defaultValue: preset.id }) : t('providers.oauthAccount'))
    const selectedAdapter = adapterId ?? record?.config.auth_adapter ?? ''
    const descriptor = snapshot.auth_adapters.find(adapter => adapter.id === selectedAdapter)
    const opensBrowser = descriptor?.flow !== 'device_code'
    const popup = opensBrowser
      ? window.open('about:blank', `morphz-oauth-${selectedAdapter || accountId}`, 'popup,width=720,height=820')
      : null
    setOAuthPreparation(null)
    setOAuthConnection({ label, stage: 'connecting', retry: { kind: 'account', accountId, adapterId } })
    setBusyAccount(accountId)
    setError('')
    try {
      const next = await api.command<OAuthLoginChallenge>(
        adapterId
          ? `/api/runtime/providers/accounts/${encodeURIComponent(accountId)}/oauth/start/${encodeURIComponent(adapterId)}`
          : `/api/runtime/providers/accounts/${encodeURIComponent(accountId)}/oauth/start`,
        'POST',
      )
      const authorizationUrl = next.authorization_url
        ?? next.verification_uri_complete
        ?? next.verification_uri
      if (authorizationUrl && opensBrowser) {
        if (popup && !popup.closed) popup.location.replace(authorizationUrl)
        else window.open(authorizationUrl, '_blank', 'noopener,noreferrer')
      } else if (popup && !popup.closed) {
        popup.close()
      }
      setChallenge(next)
      setChallengeLabelOverride(label)
      setChallengeError('')
      setAuthorizationResponse('')
      setAuthorizationLinkCopied(false)
      setDeviceCodeCopied(false)
      setOAuthConnection(null)
    } catch (reason) {
      if (popup && !popup.closed) popup.close()
      setOAuthConnection({
        label,
        stage: 'failed',
        retry: { kind: 'account', accountId, adapterId },
        error: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      setBusyAccount('')
    }
  }

  const prepareOAuthSetup = (preset: OAuthSetupPreset) => {
    const adapterId = preset.id === 'codex' && codexDeviceAvailable
      ? 'codex-device-oauth'
      : preset.authAdapter
    setSetup(null)
    setOAuthPreparation({ kind: 'setup', preset, adapterId })
  }

  const prepareAccountLogin = (accountId: string, record: ProviderAccountRecord) => {
    const preset = presetForAccount(accountId, record) ?? {
      id: record.config.provider || record.config.auth_adapter,
      authAdapter: record.config.auth_adapter,
    }
    const adapterId = preset.id === 'codex' && codexDeviceAvailable
      ? 'codex-device-oauth'
      : record.config.auth_adapter
    setOAuthPreparation({ kind: 'account', preset, adapterId, accountId })
  }

  const preparationMethods = oauthPreparation
    ? snapshot.auth_adapters.filter(adapter => oauthPreparation.preset.id === 'codex'
      ? adapter.id === 'codex-oauth' || adapter.id === 'codex-device-oauth'
      : adapter.id === oauthPreparation.preset.authAdapter)
      .sort((left, right) => Number(right.flow === 'device_code') - Number(left.flow === 'device_code'))
    : []
  const preparationDescriptor = oauthPreparation
    ? snapshot.auth_adapters.find(adapter => adapter.id === oauthPreparation.adapterId)
    : undefined
  const preparationRecord = oauthPreparation?.accountId
    ? snapshot.auth_accounts[oauthPreparation.accountId]
    : undefined
  const preparationIdentity = preparationRecord?.oauth_metadata?.email
    || preparationRecord?.oauth_metadata?.subject
    || preparationRecord?.oauth_metadata?.provider_account_id
  const preparationServiceLabel = oauthPreparation
    ? t(`providers.presets.${oauthPreparation.preset.id}`, { defaultValue: oauthPreparation.preset.id })
    : ''
  const beginPreparedLogin = () => {
    if (!oauthPreparation) return
    if (oauthPreparation.kind === 'setup') {
      void startOAuthSetup({
        ...oauthPreparation.preset,
        authAdapter: oauthPreparation.adapterId,
      })
      return
    }
    if (!oauthPreparation.accountId || !preparationRecord) return
    const adapterId = oauthPreparation.adapterId === preparationRecord.config.auth_adapter
      ? undefined
      : oauthPreparation.adapterId
    void startLogin(oauthPreparation.accountId, adapterId)
  }

  const continueLogin = async (submittedResponse?: string) => {
    if (!challenge) return
    const callbackResponse = submittedResponse?.trim() || authorizationResponse.trim()
    setBusyAccount(challenge.account_id)
    setChallengeError('')
    try {
      const manualCallback = challenge.flow === 'authorization_code_pkce'
        && challenge.callback_mode === 'loopback'
        && Boolean(callbackResponse)
      const progress = manualCallback
        ? (await api.command<OAuthCallbackSubmission>(
            '/api/runtime/providers/oauth/callback',
            'POST',
            { redirect_url: callbackResponse },
          )).progress
        : await api.command<OAuthLoginProgress>(
            `/api/runtime/providers/oauth/${encodeURIComponent(challenge.login_id)}/continue`,
            'POST',
            { kind: 'poll' },
          )
      if (progress.status === 'complete') {
        setChallenge(null)
        setChallengeError('')
        setAuthorizationResponse('')
        setAuthorizationLinkCopied(false)
        setDeviceCodeCopied(false)
        await refresh()
      }
    } catch (reason) {
      setChallengeError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAccount('')
    }
  }

  const challengeHint = challenge?.flow === 'device_code'
    ? t('providers.deviceHint')
    : challenge?.callback_mode === 'runtime'
      ? t('providers.runtimeCallbackHint')
      : t('providers.loopbackCallbackHint')
  const challengeLoopbackPort = loopbackPort(challenge?.redirect_uri)
  const sshTunnelCommand = challengeLoopbackPort
    ? `ssh -N -L ${challengeLoopbackPort}:127.0.0.1:${challengeLoopbackPort} <user>@<morphz-host>`
    : ''
  const expectedCallbackExample = challenge?.redirect_uri
    ? `${challenge.redirect_uri}?code=...&state=${challenge.callback_state ?? '...'}`
    : t('providers.authorizationResponsePlaceholder')
  const challengeAuthorizationUrl = challenge?.authorization_url
    ?? challenge?.verification_uri_complete
    ?? challenge?.verification_uri
  const copyAuthorizationUrl = async () => {
    if (!challengeAuthorizationUrl) return
    try {
      await copyTextToClipboard(challengeAuthorizationUrl)
      setAuthorizationLinkCopied(true)
      setChallengeError('')
    } catch {
      setChallengeError(t('providers.copyAuthorizationFailed'))
    }
  }

  const copyDeviceCode = async () => {
    if (!challenge?.user_code) return
    try {
      await copyTextToClipboard(challenge.user_code)
      setDeviceCodeCopied(true)
      setChallengeError('')
    } catch {
      setChallengeError(t('providers.copyDeviceCodeFailed'))
    }
  }

  const submitCallbackFromClipboard = async () => {
    try {
      const callbackUrl = (await readTextFromClipboard()).trim()
      if (!callbackUrl) throw new Error('empty clipboard')
      setAuthorizationResponse(callbackUrl)
      await continueLogin(callbackUrl)
    } catch {
      setChallengeError(t('providers.readCallbackClipboardFailed'))
    }
  }

  const cancelLoginChallenge = () => {
    const loginId = challenge?.login_id
    setChallenge(null)
    setChallengeError('')
    setAuthorizationResponse('')
    if (loginId) {
      void api.command(
        `/api/runtime/providers/oauth/${encodeURIComponent(loginId)}/continue`,
        'DELETE',
      ).catch(() => undefined)
    }
  }

  const retryOAuthConnection = () => {
    if (!oauthConnection) return
    const retry = oauthConnection.retry
    if (retry.kind === 'setup') {
      void startOAuthSetup(retry.preset)
    } else {
      void startLogin(retry.accountId, retry.adapterId)
    }
  }

  const logout = async (accountId: string) => {
    setBusyAccount(accountId)
    setError('')
    try {
      await api.command(`/api/runtime/providers/accounts/${encodeURIComponent(accountId)}/oauth/logout`, 'POST')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAccount('')
    }
  }

  const openCatalogEditor = (
    kind: CatalogEditorKind,
    id = '',
    value: ProviderInstanceConfig | AuthAccountConfig | ModelRouteConfig,
  ) => {
    setCatalogEditor({
      kind,
      id,
      value: JSON.stringify(value, null, 2),
      creating: !id,
      displayName: kind === 'auth_account' && 'label' in value ? value.label ?? '' : '',
    })
    setCatalogNotice('')
  }

  const saveCatalogObject = async () => {
    if (!catalogEditor) return
    const id = catalogEditor.id.trim()
    if (!id) {
      setError(t('providers.catalogIdRequired'))
      return
    }
    let body: unknown
    try {
      body = JSON.parse(catalogEditor.value)
    } catch (reason) {
      setError(t('providers.invalidJson', { error: reason instanceof Error ? reason.message : String(reason) }))
      return
    }
    if (catalogEditor.kind === 'auth_account') {
      const displayName = catalogEditor.displayName.trim()
      if (!displayName) {
        setError(t('providers.accountNameRequired'))
        return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        setError(t('providers.invalidAccountConfig'))
        return
      }
      body = { ...body, label: displayName }
    }
    const endpoint = catalogEditor.kind === 'provider_instance'
      ? `/api/runtime/providers/instances/${encodeURIComponent(id)}`
      : catalogEditor.kind === 'auth_account'
        ? `/api/runtime/providers/accounts/${encodeURIComponent(id)}/config`
        : `/api/runtime/providers/routes/${encodeURIComponent(id)}`
    setError('')
    try {
      const receipt = await api.command<CatalogMutationReceipt>(endpoint, 'PUT', body)
      setCatalogNotice(t('providers.catalogSaved', { path: receipt.managed_config_path }))
      setCatalogEditor(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const diagnoseRoute = async (routeId: string, accountId?: string) => {
    setDiagnosing(accountId ? `account:${accountId}` : `route:${routeId}`)
    setDiagnosticAccountId(accountId ?? '')
    setDiagnosticError('')
    setDiagnostic(null)
    setError('')
    try {
      const result = await api.command<ModelRouteDiagnostic>(
        `/api/runtime/providers/routes/${encodeURIComponent(routeId)}/test`,
        'POST',
        { account_id: accountId },
      )
      setDiagnostic(result)
      await refresh()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (accountId) setDiagnosticError(message)
      else setError(message)
    } finally {
      setDiagnosing('')
    }
  }

  const diagnoseAccount = async (accountId: string) => {
    setDiagnosing(`account:${accountId}`)
    setDiagnosticAccountId(accountId)
    setAccountDiagnostic(null)
    setDiagnosticError('')
    setError('')
    try {
      const result = await api.command<ProviderAccountDiagnostic>(
        `/api/runtime/providers/accounts/${encodeURIComponent(accountId)}/refresh-models`,
        'POST',
        {},
      )
      setAccountDiagnostic(result)
      await refresh()
    } catch (reason) {
      setDiagnosticError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDiagnosing('')
    }
  }

  const refreshRouteCatalog = async (routeId: string, accountId?: string) => {
    setDiagnosing(accountId ? `catalog-account:${accountId}` : `catalog-route:${routeId}`)
    setError('')
    try {
      const result = await api.command<ModelRouteDiagnostic>(
        `/api/runtime/providers/routes/${encodeURIComponent(routeId)}/refresh-models`,
        'POST',
        { account_id: accountId },
      )
      setDiagnostic(result)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDiagnosing('')
    }
  }

  const accountModelOptions = (
    accountId: string,
    providerId: string,
    additionallyDiscovered: string[] = [],
    discoveredProfiles: Record<string, ProviderModelConfig> = {},
  ): AccountModelOption[] => buildAccountModelOptions({
    accountId,
    providerId,
    routes: snapshot.model_routes,
    catalog: snapshot.discovered_models,
    configuredProfiles: snapshot.provider_instances[providerId]?.models ?? {},
    additionallyDiscovered,
    discoveredProfiles,
  })

  const openAccountModels = async (accountId: string, label: string) => {
    const record = snapshot.auth_accounts[accountId]
    const providerId = record?.config.provider
      ?? instances.find(([, provider]) => provider.accounts.includes(accountId))?.[0]
    if (!providerId) {
      setError(t('providers.modelProviderMissing'))
      return
    }
    setModelSearchQuery('')
    setModelEditor({
      accountId,
      providerId,
      label,
      options: accountModelOptions(accountId, providerId),
      loading: true,
      error: '',
      errorKind: '',
    })
    try {
      const result = await api.command<ProviderAccountDiagnostic>(
        `/api/runtime/providers/accounts/${encodeURIComponent(accountId)}/refresh-models`,
        'POST',
        {},
      )
      setModelEditor(current => current?.accountId === accountId
        ? {
            ...current,
            options: accountModelOptions(
              accountId,
              providerId,
              result.discovered_models,
              result.discovered_model_profiles ?? {},
            ),
            loading: false,
            error: result.catalog_error ?? '',
            errorKind: result.catalog_error ? 'catalog' : '',
          }
        : current)
      await refresh()
    } catch (reason) {
      setModelEditor(current => current?.accountId === accountId
        ? { ...current, loading: false, error: reason instanceof Error ? reason.message : String(reason), errorKind: 'catalog' }
        : current)
    }
  }

  const updateAccountModel = (id: string, update: Partial<AccountModelOption>) => {
    setModelEditor(current => current ? {
      ...current,
      options: current.options.map(option => option.id === id ? { ...option, ...update } : option),
      error: '',
      errorKind: '',
    } : current)
  }

  const visibleAccountModels = filterAccountModelOptions(
    modelEditor?.options ?? [],
    modelSearchQuery,
  )
  const structuredCacheExperimentAvailable = (snapshot.experimental_features ?? []).includes(
    'structured-context-delta-cache',
  )

  const saveAccountModels = async () => {
    if (!modelEditor || savingModels) return
    let selections: ReturnType<typeof buildEnabledModelSelections>
    try {
      selections = buildEnabledModelSelections(modelEditor.options)
    } catch (reason) {
      if (!(reason instanceof ProviderWorkflowValidationError)) throw reason
      const message = reason.code === 'select-at-least-one'
        ? t('providers.selectAtLeastOneModel')
        : t('providers.invalidModelCapacity')
      setModelEditor(current => current
        ? { ...current, error: message, errorKind: 'validation' }
        : current)
      return
    }
    setSavingModels(true)
    setModelEditor(current => current ? { ...current, error: '', errorKind: '' } : current)
    try {
      const receipt = await api.command<CatalogMutationReceipt>(
        `/api/runtime/providers/accounts/${encodeURIComponent(modelEditor.accountId)}/models`,
        'PUT',
        {
          models: selections,
        },
      )
      setCatalogNotice(t('providers.modelsSaved', { path: receipt.managed_config_path }))
      setModelEditor(null)
      await Promise.all([refresh(), onModelCatalogChanged?.()])
    } catch (reason) {
      setModelEditor(current => current ? {
        ...current,
        error: reason instanceof Error ? reason.message : String(reason),
        errorKind: 'save',
      } : current)
    } finally {
      setSavingModels(false)
    }
  }

  const challengeLabel = challenge
    ? (challengeLabelOverride || snapshot.auth_accounts[challenge.account_id]?.config.label || t('providers.oauthAccount'))
    : ''
  const selectedRoute = routes.find(([routeId, route]) => (
    routeId === snapshot.selected_model_alias || route.aliases.includes(snapshot.selected_model_alias)
  ))
  const selectedModelLabel = selectedRoute
    ? modelRouteDisplayLabel(selectedRoute[1])
    : snapshot.selected_model_alias
  const effectiveReviewerModel = resolvedRouteId(snapshot.model_routes, snapshot.auto_review_model)
  const effectivePrimaryModel = resolvedRouteId(snapshot.model_routes, snapshot.selected_model_alias)
  const effectiveAllowedEvaluationModels = Array.from(new Set(
    snapshot.allowed_evaluation_models
      .map(model => resolvedRouteId(snapshot.model_routes, model))
      .filter(model => model && model !== effectivePrimaryModel),
  )).sort()
  const evaluationModelPolicyChanged = primaryModel !== effectivePrimaryModel
    || allowedEvaluationModels.join('\u0000') !== effectiveAllowedEvaluationModels.join('\u0000')

  const selectPrimaryModel = (model: string) => {
    setPrimaryModel(model)
    setAllowedEvaluationModels(current => current.filter(candidate => candidate !== model))
  }

  const toggleAllowedEvaluationModel = (model: string) => {
    if (model === primaryModel) return
    setAllowedEvaluationModels(current => (
      current.includes(model)
        ? current.filter(candidate => candidate !== model)
        : [...current, model].sort()
    ))
  }

  const saveEvaluationModelPolicy = async () => {
    if (savingEvaluationModelPolicy || !primaryModel) return
    setSavingEvaluationModelPolicy(true)
    setError('')
    try {
      const receipt = await api.command<CatalogMutationReceipt>(
        '/api/runtime/evaluation-model-policy',
        'PUT',
        {
          primary_model: primaryModel,
          allowed_evaluation_models: allowedEvaluationModels,
        },
      )
      setCatalogNotice(t('providers.evaluationModelPolicySaved', { path: receipt.managed_config_path }))
      await Promise.all([refresh(), onModelCatalogChanged?.()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSavingEvaluationModelPolicy(false)
    }
  }

  const saveReviewerModel = async () => {
    if (savingReviewerModel) return
    setSavingReviewerModel(true)
    setError('')
    try {
      const receipt = await api.command<CatalogMutationReceipt>(
        '/api/runtime/permissions/auto-review-model',
        'PUT',
        { model: reviewerModel || null },
      )
      setCatalogNotice(t('providers.autoReviewModelSaved', { path: receipt.managed_config_path }))
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSavingReviewerModel(false)
    }
  }

  return (
    <section className="providers-view">
      <header className="workspace-heading">
        <div>
          <span>{t('providers.eyebrow').toUpperCase()}</span>
          <h1>{t('providers.heading')}</h1>
        </div>
        <nav className="provider-heading-actions">
          <button className="is-primary" type="button" onClick={() => setSetup(defaultSetup())}><Plus size={14} /> {t('providers.addService')}</button>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? 'is-spinning' : ''} size={14} /> {t('providers.refresh')}
          </button>
        </nav>
      </header>

      {error && <p className="provider-control-error">{error}</p>}
      {catalogNotice && <p className="provider-control-notice">{catalogNotice}</p>}

      <section className="provider-model-policy">
        <header>
          <Route size={17} />
          <span>
            <strong>{t('providers.evaluationModelPolicy')}</strong>
            <small>{t('providers.evaluationModelPolicyHint')}</small>
          </span>
          <code>{localDate(snapshot.generated_at)}</code>
        </header>
        <div className="provider-model-policy-primary">
          <label>
            <span><strong>{t('providers.primaryModel')}</strong><small>{t('providers.primaryModelHint')}</small></span>
            <select
              aria-label={t('providers.primaryModel')}
              disabled={savingEvaluationModelPolicy || routes.length === 0}
              value={primaryModel}
              onChange={event => selectPrimaryModel(event.target.value)}
            >
              {primaryModel && !snapshot.model_routes[primaryModel] && (
                <option value={primaryModel}>{selectedModelLabel || primaryModel}</option>
              )}
              {routes.map(([routeId, route]) => (
                <option value={routeId} key={routeId}>
                  {modelRouteDisplayLabel(route) || routeId} · {routeId}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="provider-model-policy-agent">
          <div>
            <strong>{t('providers.agentModels')}</strong>
            <small>{t('providers.agentModelsHint')}</small>
          </div>
          <div className="provider-model-policy-options">
            {routes.map(([routeId, route]) => {
              const isPrimary = routeId === primaryModel
              const selected = isPrimary || allowedEvaluationModels.includes(routeId)
              const physicalModels = Array.from(new Set(route.candidates.map(candidate => candidate.model)))
              return (
                <label className={isPrimary ? 'is-primary' : ''} key={routeId}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={savingEvaluationModelPolicy || isPrimary}
                    onChange={() => toggleAllowedEvaluationModel(routeId)}
                  />
                  <span>
                    <strong>{modelRouteDisplayLabel(route) || routeId}</strong>
                    <small>{routeId} · {physicalModels.join(' / ')}</small>
                  </span>
                  {isPrimary && <em>{t('providers.primaryAlwaysAllowed')}</em>}
                </label>
              )
            })}
          </div>
        </div>
        <footer>
          <small>{t('providers.agentModelsBoundary')}</small>
          <button
            type="button"
            disabled={savingEvaluationModelPolicy || !primaryModel || !evaluationModelPolicyChanged}
            onClick={() => void saveEvaluationModelPolicy()}
          >
            <Save size={13} /> {savingEvaluationModelPolicy ? t('providers.busy') : t('providers.saveEvaluationModelPolicy')}
          </button>
        </footer>
      </section>

      {snapshot.reviewer === 'auto_review' && (
        <section className="provider-auto-review-model">
          <ShieldCheck size={17} />
          <span>
            <strong>{t('providers.autoReviewModel')}</strong>
            <small>{t('providers.autoReviewModelHint')}</small>
          </span>
          <select
            aria-label={t('providers.autoReviewModel')}
            disabled={savingReviewerModel}
            value={reviewerModel}
            onChange={event => setReviewerModel(event.target.value)}
          >
            <option value="">{t('providers.autoReviewUseMainModel')}</option>
            {routes.map(([routeId, route]) => (
              <option value={routeId} key={routeId}>
                {modelRouteDisplayLabel(route) || routeId} · {routeId}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={savingReviewerModel || reviewerModel === effectiveReviewerModel}
            onClick={() => void saveReviewerModel()}
          >
            <Save size={13} /> {savingReviewerModel ? t('providers.busy') : t('providers.saveAutoReviewModel')}
          </button>
        </section>
      )}

      {diagnostic && !diagnosticAccountId && (
        <section className={`provider-diagnostic ${diagnostic.health_verified ? 'is-success' : 'is-failure'}`}>
          <header>
            <span><Activity size={15} /><strong>{t('providers.diagnosticTitle')}</strong></span>
            <time dateTime={diagnostic.checked_at}>{localDate(diagnostic.checked_at)}</time>
          </header>
          <div>
            <span><small>{t('providers.route')}</small><strong>{diagnostic.binding.requested_alias}</strong></span>
            <span><small>{t('providers.physicalModel')}</small><strong>{diagnostic.binding.provider_instance_id}/{diagnostic.binding.physical_model}</strong></span>
            <span><small>{t('providers.authAccount')}</small><strong>{diagnostic.binding.auth_account_id}</strong></span>
            <span><small>{t('providers.health')}</small><strong>{diagnostic.health_verified ? t('providers.healthPassed') : t('providers.healthFailed')}</strong></span>
          </div>
          <footer>
            <span>{t('providers.elapsed', { count: diagnostic.elapsed_ms })}</span>
            <span>{t('providers.discoveredCount', { count: diagnostic.discovered_models.length })}</span>
            {(diagnostic.health_error || diagnostic.catalog_error) && <code>{diagnostic.health_error ?? diagnostic.catalog_error}</code>}
          </footer>
        </section>
      )}

      <section className="provider-control-section">
        <header><span><Activity size={15} /> {t('providers.recentAttempts')}</span></header>
        <div className="provider-attempt-list">
          {modelUsage.map(group => {
            const attempt = group.latest
            return (
              <article key={group.alias}>
                <header>
                  <span><strong>{group.alias}</strong></span>
                  <time dateTime={attempt.timestamp}>{localDate(attempt.timestamp)}</time>
                </header>
                <div>
                  <span><small>{t('providers.evaluationCount')}</small><strong>{t('providers.attemptCount', { count: group.attempts })}</strong></span>
                  <span><small>{t('providers.inputAndCache')}</small><strong>{group.inputTokens.toLocaleString()} / {group.cachedInputTokens.toLocaleString()}</strong></span>
                  <span><small>{t('providers.outputTokens')}</small><strong>{group.outputTokens.toLocaleString()}</strong></span>
                  <span><small>{t('providers.physicalPaths')}</small><strong>{group.paths.length}</strong></span>
                </div>
                <footer>
                  <code>{t('providers.scopeCount', { contexts: group.contextIds.size, sessions: group.sessionIds.size })}</code>
                  <span>{t('providers.usageTokens', { count: group.totalTokens })}</span>
                  {group.cost && <span>{group.cost.amount.toFixed(6)} {group.cost.currency}</span>}
                </footer>
                <details className="provider-usage-paths">
                  <summary>{t('providers.viewPhysicalPaths', { count: group.paths.length })}</summary>
                  <div>
                    {group.paths.map(path => (
                      <section key={path.key}>
                        <span><strong>{path.physicalModel}</strong><small>{t('providers.attemptCount', { count: path.attempts })}</small></span>
                        <code>{path.providerInstanceId && path.authAccountId
                          ? `${path.providerInstanceId} / ${path.authAccountId}`
                          : t('providers.legacyAttempt')}</code>
                        <small>{path.routeIds.length > 0
                          ? `${path.routeIds.join(', ')}${path.routeRevisions.length > 0 ? ` · ${path.routeRevisions.join(', ')}` : ''}`
                          : '—'}</small>
                      </section>
                    ))}
                  </div>
                </details>
              </article>
            )
          })}
          {!loading && attempts.length === 0 && <p className="provider-empty">{t('providers.noAttempts')}</p>}
        </div>
      </section>

      <section className="provider-control-section">
        <header><span><KeyRound size={15} /> {t('providers.configuredAccounts')}</span></header>
        <div className="provider-account-list">
          {accounts.map(([accountId, record]) => {
            const isBusy = busyAccount === accountId
            const preset = presetForAccount(accountId, record)
            const serviceName = preset
              ? t(`providers.presets.${preset.id}`, { defaultValue: preset.id })
              : (record.config.provider || t('providers.apiCredential'))
            const identity = record.oauth_metadata?.email
              || record.oauth_metadata?.subject
              || record.oauth_metadata?.provider_account_id
            const accountLabel = identity || record.config.label || serviceName
            const diagnosticPresentation = resolveAccountDiagnosticPresentation({
              accountId,
              activeAccountId: diagnosticAccountId,
              diagnosing,
              diagnostic: accountDiagnostic,
              error: diagnosticError,
            })
            const isTesting = diagnosticPresentation.state === 'pending'
            const currentAccountDiagnostic = diagnosticPresentation.visible
              && 'diagnostic' in diagnosticPresentation
              ? diagnosticPresentation.diagnostic
              : null
            const currentDiagnosticError = diagnosticPresentation.visible
              && 'error' in diagnosticPresentation
              ? diagnosticPresentation.error
              : ''
            return (
              <article className={!record.effective_enabled ? 'is-disabled' : ''} key={accountId}>
                <span className={`provider-account-presence ${record.effective_enabled ? 'is-enabled' : ''}`}>
                  {(!record.oauth || record.authenticated) ? <CheckCircle2 size={15} /> : <CircleOff size={15} />}
                </span>
                <div className="provider-account-identity">
                  <strong>{accountLabel}</strong>
                  <small>{record.oauth
                    ? (identity ? serviceName : t('providers.authenticatedIdentityUnavailable', { service: serviceName }))
                    : serviceName}</small>
                  <code>{t('providers.accountIdDisplay', { id: accountId })}</code>
                </div>
                <div className="provider-account-facts">
                  <span>{record.effective_enabled ? t('providers.enabled') : t('providers.disabled')}</span>
                  <span>{record.oauth
                    ? (record.authenticated ? t('providers.authenticated') : t('providers.notAuthenticated'))
                    : (record.config.credential_ref ? t('providers.credentialConfigured') : t('providers.noAuthentication'))}</span>
                  {record.state && <span>{t('providers.status', { value: record.state.status })}</span>}
                  {record.state?.cooldown_until && <span>{t('providers.cooldown', { time: localDate(record.state.cooldown_until) })}</span>}
                  {record.state?.last_error_kind && <span>{t('providers.lastError', { value: record.state.last_error_kind })}</span>}
                  {record.oauth_metadata?.expires_at && <span>{t('providers.expires', { time: localDate(record.oauth_metadata.expires_at) })}</span>}
                </div>
                <nav>
                  {(!record.oauth || record.authenticated) && (
                    <button type="button" onClick={() => void openAccountModels(accountId, accountLabel)}>
                      <Settings2 size={13} /> {t('providers.manageModels')}
                    </button>
                  )}
                  {(!record.oauth || record.authenticated) && (
                    <button type="button" disabled={Boolean(diagnosing)} onClick={() => void diagnoseAccount(accountId)}>
                      {isTesting ? <RefreshCw className="is-spinning" size={13} /> : <Activity size={13} />}
                      {isTesting ? t('providers.testing') : t('providers.test')}
                    </button>
                  )}
                  <button type="button" disabled={isBusy} onClick={() => openCatalogEditor('auth_account', accountId, record.config)}>
                    <Pencil size={13} /> {t('providers.edit')}
                  </button>
                  {record.oauth && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => prepareAccountLogin(accountId, record)}
                    >
                      <LogIn size={13} /> {t('providers.relogin')}
                    </button>
                  )}
                  {record.oauth && record.authenticated && (
                    <button type="button" disabled={isBusy} onClick={() => void logout(accountId)}>
                      <LogOut size={13} /> {t('providers.logout')}
                    </button>
                  )}
                  <button type="button" disabled={isBusy} onClick={() => void mutateAccount(accountId, record)}>
                    {record.effective_enabled ? <CircleOff size={13} /> : <ShieldCheck size={13} />}
                    {record.effective_enabled ? t('providers.disable') : t('providers.enable')}
                  </button>
                  {!record.oauth && (
                    <button
                      className="is-danger"
                      type="button"
                      disabled={isBusy}
                      onClick={() => setAccountPendingDeletion({ id: accountId, label: accountLabel })}
                    >
                      <Trash2 size={13} /> {t('providers.delete')}
                    </button>
                  )}
                </nav>
                {diagnosticPresentation.visible && (
                  <section className={`provider-account-test-result is-${diagnosticPresentation.state}`} aria-live="polite">
                    {isTesting ? (
                      <><RefreshCw className="is-spinning" size={14} /><span><strong>{t('providers.testingAccount')}</strong><small>{t('providers.testingAccountHint')}</small></span></>
                    ) : currentAccountDiagnostic ? (
                      <>
                        {currentAccountDiagnostic.health_verified ? <CheckCircle2 size={14} /> : <CircleOff size={14} />}
                        <span>
                          <strong>{currentAccountDiagnostic.health_verified ? t('providers.testSucceeded') : t('providers.testFailed')}</strong>
                          <small>{t('providers.testSummary', {
                            count: currentAccountDiagnostic.discovered_models.length,
                            model: currentAccountDiagnostic.probed_model ?? '—',
                            elapsed: currentAccountDiagnostic.elapsed_ms,
                          })}</small>
                          {(currentAccountDiagnostic.health_error || currentAccountDiagnostic.catalog_error) && <code>{currentAccountDiagnostic.health_error ?? currentAccountDiagnostic.catalog_error}</code>}
                        </span>
                      </>
                    ) : (
                      <><CircleOff size={14} /><span><strong>{t('providers.testFailed')}</strong><code>{currentDiagnosticError}</code></span></>
                    )}
                  </section>
                )}
              </article>
            )
          })}
          {!loading && accounts.length === 0 && <p className="provider-empty">{t('providers.noAccounts')}</p>}
        </div>
      </section>

      <details className="provider-advanced-control">
        <summary><Settings2 size={15} /><span>{t('providers.advancedControl')}</span></summary>
        <div>
          <section className="provider-control-section">
            <header><span><Server size={15} /> {t('providers.instances')}</span></header>
            <div className="provider-instance-grid">
              {instances.map(([providerId, provider]) => (
                <article key={providerId}>
                  <header><Cloud size={16} /><span><strong>{providerId}</strong><code>{provider.adapter || provider.protocol}</code></span><button type="button" aria-label={t('providers.edit')} onClick={() => openCatalogEditor('provider_instance', providerId, provider)}><Pencil size={13} /></button></header>
                  <p title={provider.base_url}>{provider.base_url}</p>
                  <footer><span>{t('providers.accountPool', { count: provider.accounts.length })}</span><span>{t('providers.modelCount', { count: Object.keys(provider.models).length })}</span><code>{provider.protocol}</code></footer>
                </article>
              ))}
              {!loading && instances.length === 0 && <p className="provider-empty">{t('providers.noInstances')}</p>}
            </div>
          </section>

          <section className="provider-control-section">
            <header><span><Network size={15} /> {t('providers.routes')}</span></header>
            <div className="provider-route-list">
              {routes.map(([routeId, route]) => (
                <article className={routeId === snapshot.selected_model_alias || route.aliases.includes(snapshot.selected_model_alias) ? 'is-selected' : ''} key={routeId}>
                  <header>
                    <Route size={15} />
                    <span><strong>{modelRouteDisplayLabel(route) || '—'}</strong><small>{t('providers.routeIdentity', { value: routeId })}{route.aliases.length > 0 ? ` · ${t('providers.aliases', { value: route.aliases.join(', ') })}` : ''}</small></span>
                    <div><em>{t('providers.affinity', { value: route.affinity })}</em><em>{t('providers.selection', { value: route.selection })}</em>{route.fallback && <em>{t('providers.fallback')}</em>}</div>
                    <nav>
                      <button type="button" disabled={Boolean(diagnosing)} onClick={() => void diagnoseRoute(routeId)}><Activity size={13} /> {t('providers.test')}</button>
                      <button type="button" disabled={Boolean(diagnosing)} onClick={() => void refreshRouteCatalog(routeId)}><RefreshCw size={13} /> {t('providers.refreshCatalog')}</button>
                      <button type="button" aria-label={t('providers.edit')} onClick={() => openCatalogEditor('model_route', routeId, route)}><Pencil size={13} /></button>
                    </nav>
                  </header>
                  <div>{route.candidates.map((candidate, index) => (
                    <section key={`${candidate.provider}:${candidate.model}:${candidate.account ?? ''}:${index}`}>
                      <span>{t('providers.candidate', { index: index + 1 })}<small>{t('providers.priority', { priority: candidate.priority })}</small></span>
                      <strong>{candidate.provider}<i>/</i>{candidate.model}</strong>
                      <code>{candidate.account ? t('providers.pinnedAccount', { account: candidate.account }) : t('providers.anyAccount')}</code>
                      {candidate.capabilities.length > 0 && <small>{t('providers.capabilities', { value: candidate.capabilities.join(', ') })}</small>}
                    </section>
                  ))}</div>
                </article>
              ))}
              {!loading && routes.length === 0 && <p className="provider-empty">{t('providers.noRoutes')}</p>}
            </div>
          </section>

          <section className="provider-control-section">
            <header><span><Cloud size={15} /> {t('providers.remoteCatalog')}</span></header>
            <div className="provider-remote-catalog">
              {Object.entries(snapshot.discovered_models.reduce<Record<string, ProviderModelCatalogRecord[]>>((groups, model) => {
                const key = `${model.provider_instance_id} / ${model.auth_account_id}`
                ;(groups[key] ??= []).push(model)
                return groups
              }, {})).map(([key, models]) => (
                <article key={key}>
                  <header><strong>{key}</strong><small>{models[0].adapter_id}@{models[0].adapter_version} · {models[0].protocol}</small><time dateTime={models[0].observed_at}>{localDate(models[0].observed_at)}</time></header>
                  <div>{models.map(model => <code key={model.physical_model}>{model.physical_model}</code>)}</div>
                </article>
              ))}
              {!loading && snapshot.discovered_models.length === 0 && <p className="provider-empty">{t('providers.noRemoteCatalog')}</p>}
            </div>
          </section>
        </div>
      </details>

      {modelEditor && (
        <div className="provider-oauth-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target && !savingModels) setModelEditor(null)
        }}>
          <section className="provider-oauth-dialog provider-model-manager" role="dialog" aria-modal="true" aria-labelledby="provider-model-manager-title">
            <header>
              <span><Settings2 size={16} /><strong id="provider-model-manager-title">{t('providers.manageAccountModels', { account: modelEditor.label })}</strong></span>
              <button type="button" disabled={savingModels} onClick={() => setModelEditor(null)} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            <p>{t('providers.modelManagerHint')}</p>
            <div className="provider-model-manager-search">
              <Search aria-hidden="true" size={15} />
              <input
                type="search"
                autoFocus
                value={modelSearchQuery}
                onChange={event => setModelSearchQuery(event.target.value)}
                placeholder={t('providers.searchModelsPlaceholder')}
                aria-label={t('providers.searchModels')}
              />
              <small>{t('providers.modelSearchCount', {
                visible: visibleAccountModels.length,
                total: modelEditor.options.length,
              })}</small>
              {modelSearchQuery && (
                <button
                  type="button"
                  onClick={() => setModelSearchQuery('')}
                  aria-label={t('providers.clearModelSearch')}
                  title={t('providers.clearModelSearch')}
                ><X size={13} /></button>
              )}
            </div>
            {modelEditor.loading && (
              <div className="provider-model-manager-loading"><RefreshCw className="is-spinning" size={14} /> {t('providers.loadingAccountModels')}</div>
            )}
            {modelEditor.error && (
              <div className="provider-model-manager-error" role="alert">
                <CircleOff size={14} />
                <span>
                  <strong>{t(modelEditor.errorKind === 'validation'
                    ? 'providers.modelSettingsInvalid'
                    : modelEditor.errorKind === 'save'
                      ? 'providers.modelSettingsSaveFailed'
                      : 'providers.modelCatalogRefreshFailed')}</strong>
                  <small>{modelEditor.errorKind === 'validation'
                    ? modelEditor.error
                    : t(modelEditor.errorKind === 'save'
                        ? 'providers.modelSettingsSaveFailedHint'
                        : 'providers.modelCatalogRefreshFailedHint')}</small>
                  {modelEditor.errorKind !== 'validation' && <details><summary>{t('providers.errorDetails')}</summary><code>{modelEditor.error}</code></details>}
                </span>
              </div>
            )}
            <div className="provider-model-manager-list">
              {visibleAccountModels.map(option => (
                <article className={option.enabled ? 'is-enabled' : ''} key={option.id}>
                  <label>
                    <input type="checkbox" checked={option.enabled} onChange={event => updateAccountModel(option.id, { enabled: event.target.checked })} />
                    <span><strong>{option.id}</strong><small>{option.enabled ? t('providers.modelEnabled') : t('providers.modelNotEnabled')}</small></span>
                  </label>
                  {option.enabled && (
                    <>
                      <div className="provider-model-alias">
                        <label>
                          <span>{t('providers.modelAliasOptional')}</span>
                          <input placeholder={option.id} value={option.alias} onChange={event => updateAccountModel(option.id, { alias: event.target.value })} />
                        </label>
                        <small>{t('providers.modelAliasHint')}</small>
                      </div>
                      {structuredCacheExperimentAvailable && (
                        <div className="provider-model-alias">
                          <label>
                            <span>{t('providers.promptCacheTransport')}</span>
                            <select
                              value={option.promptCacheStrategy}
                              onChange={event => updateAccountModel(option.id, {
                                promptCacheStrategy: event.target.value as ProviderModelConfig['prompt_cache_strategy'],
                              })}
                            >
                              <option value="auto">{t('providers.promptCacheAutomatic')}</option>
                              <option value="experimental-structured-deltas">{t('providers.promptCacheStructuredDeltas')}</option>
                            </select>
                          </label>
                          <small>{t('providers.promptCacheStructuredDeltasHint')}</small>
                        </div>
                      )}
                      <details>
                        <summary>{t('providers.modelCapacityAdvanced')}</summary>
                        <p>{t('providers.modelCapacityHint')}</p>
                        <div>
                          <label><span>{t('providers.contextWindow')}</span><input inputMode="numeric" placeholder={t('providers.notProvided')} value={option.contextWindowTokens} onChange={event => updateAccountModel(option.id, { contextWindowTokens: event.target.value })} /></label>
                          <label><span>{t('providers.maxInput')}</span><input inputMode="numeric" placeholder={t('providers.notProvided')} value={option.maxInputTokens} onChange={event => updateAccountModel(option.id, { maxInputTokens: event.target.value })} /></label>
                          <label><span>{t('providers.maxOutput')}</span><input inputMode="numeric" placeholder={t('providers.notProvided')} value={option.maxOutputTokens} onChange={event => updateAccountModel(option.id, { maxOutputTokens: event.target.value })} /></label>
                        </div>
                      </details>
                    </>
                  )}
                </article>
              ))}
              {!modelEditor.loading && modelEditor.options.length === 0 && <p className="provider-empty">{t('providers.noAccountModels')}</p>}
              {!modelEditor.loading && modelEditor.options.length > 0 && visibleAccountModels.length === 0 && (
                <p className="provider-empty">{t('providers.noMatchingModels', { query: modelSearchQuery.trim() })}</p>
              )}
            </div>
            <footer>
              <button type="button" disabled={savingModels} onClick={() => setModelEditor(null)}>{t('providers.cancel')}</button>
              <button className="is-primary" type="button" disabled={savingModels || modelEditor.loading || modelEditor.options.length === 0} onClick={() => void saveAccountModels()}>
                <Save size={13} /> {savingModels ? t('providers.busy') : t('providers.saveEnabledModels')}
              </button>
            </footer>
          </section>
        </div>
      )}

      {setup && (
        <div className="provider-oauth-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target) setSetup(null)
        }}>
          <section className="provider-oauth-dialog provider-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-setup-title">
            <header>
              <span><Settings2 size={16} /><strong id="provider-setup-title">{t('providers.setupTitle')}</strong></span>
              <button type="button" onClick={() => setSetup(null)} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            <p>{t(setup.mode === 'oauth' ? 'providers.setupOAuthHint' : 'providers.setupApiHint')}</p>
            <nav className="provider-setup-modes">
              <button className={setup.mode === 'oauth' ? 'is-active' : ''} type="button" onClick={() => switchSetupMode('oauth')}><LogIn size={14} /> {t('providers.oauthSetup')}</button>
              <button className={setup.mode === 'api_key' ? 'is-active' : ''} type="button" onClick={() => switchSetupMode('api_key')}><KeyRound size={14} /> {t('providers.apiSetup')}</button>
            </nav>
            {setup.mode === 'oauth' && (
              <>
                {oauthServicesError && (
                  <div className="provider-oauth-services-error" role="alert">
                    <strong>{t('providers.oauthServicesUnavailable')}</strong>
                    <span>{t('providers.oauthServicesUnavailableHint')}</span>
                    <code>{oauthServicesError}</code>
                  </div>
                )}
                {!oauthServicesError && (
                  <div className="provider-setup-presets">
                    {oauthSetupOptions.map(({ preset }) => (
                        <button
                          type="button"
                          key={preset.id}
                          onClick={() => prepareOAuthSetup(preset)}
                        >
                          <span>{t(`providers.presets.${preset.id}`, { defaultValue: preset.id })}</span>
                          <small>{t('providers.reviewLoginSteps')}</small>
                        </button>
                    ))}
                    {!loading && oauthSetupOptions.length === 0 && (
                      <p className="provider-oauth-services-empty">{t('providers.noOAuthServices')}</p>
                    )}
                  </div>
                )}
              </>
            )}
            {setup.mode === 'api_key' && <>
              <div className="provider-protocol-picker" role="radiogroup" aria-label={t('providers.protocol')}>
                <span>{t('providers.protocol')}</span>
                <div>
                  {API_PROTOCOLS.map(option => (
                    <button
                      className={setup.protocol === option.id ? 'is-active' : ''}
                      type="button"
                      role="radio"
                      aria-checked={setup.protocol === option.id}
                      key={option.id}
                      onClick={() => {
                        setSetup(current => current ? {
                          ...current,
                          preset: option.id,
                          protocol: option.id,
                          adapter: option.adapter,
                          physicalModel: '',
                          alias: '',
                          routeId: '',
                        } : current)
                        setDiscoveredModels([])
                        setModelDiscoveryError('')
                      }}
                    >
                      <strong>{t(`providers.protocols.${option.id}.name`)}</strong>
                      <small>{t(`providers.protocols.${option.id}.hint`)}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="provider-setup-grid">
                <label className="is-wide"><span>{t('providers.accountName')}</span><input autoFocus placeholder={t('providers.accountNamePlaceholder')} value={setup.name} onChange={event => {
                  setSetup(current => current ? { ...current, name: event.target.value } : current)
                }} /></label>
                <label className="is-wide"><span>{t('providers.baseUrl')}</span><input value={setup.baseUrl} onChange={event => {
                  setSetup(current => current ? { ...current, baseUrl: event.target.value, physicalModel: '', alias: '', routeId: '' } : current)
                  setDiscoveredModels([])
                  setModelDiscoveryError('')
                }} /></label>
                <label className="is-wide"><span>{t('providers.apiKey')}</span><input autoComplete="new-password" type="password" value={setup.apiKey} onChange={event => {
                  setSetup(current => current ? { ...current, apiKey: event.target.value, physicalModel: '', alias: '', routeId: '' } : current)
                  setDiscoveredModels([])
                  setModelDiscoveryError('')
                }} /></label>
              </div>
              <button className="provider-discover-models" type="button" disabled={discoveringModels} onClick={() => void discoverModels()}>
                <RefreshCw className={discoveringModels ? 'is-spinning' : ''} size={14} />
                {discoveringModels ? t('providers.discoveringModels') : t('providers.discoverModels')}
              </button>
              {modelDiscoveryError && <p className="provider-oauth-inline-error" role="alert">{modelDiscoveryError}</p>}
              {discoveredModels.length > 0 && (
                <label className="provider-model-selection">
                  <span>{t('providers.selectModel')}</span>
                  <select value={setup.physicalModel} onChange={event => setSetup(current => current ? {
                    ...current,
                    physicalModel: event.target.value,
                    alias: '',
                    routeId: event.target.value,
                  } : current)}>
                    {discoveredModels.map(model => <option value={model} key={model}>{model}</option>)}
                  </select>
                  <small>{t('providers.modelsDiscovered', { count: discoveredModels.length })}</small>
                  <span>{t('providers.modelAliasOptional')}</span>
                  <input placeholder={setup.physicalModel} value={setup.alias} onChange={event => setSetup(current => current ? { ...current, alias: event.target.value } : current)} />
                  <small>{t('providers.modelAliasHint')}</small>
                </label>
              )}
            </>}
            <footer>
              <button type="button" onClick={() => setSetup(null)}>{t('providers.cancel')}</button>
              {setup.mode === 'api_key' && <button className="is-primary" type="button" disabled={savingSetup || !setup.name.trim() || !setup.physicalModel} onClick={() => void saveProviderSetup()}>
                <Save size={13} />
                {savingSetup ? t('providers.busy') : t('providers.addSelectedModel')}
              </button>}
            </footer>
          </section>
        </div>
      )}

      {oauthPreparation && (
        <div className="provider-oauth-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target) setOAuthPreparation(null)
        }}>
          <section className="provider-oauth-dialog provider-login-preparation" role="dialog" aria-modal="true" aria-labelledby="provider-login-preparation-title">
            <header>
              <span><LogIn size={16} /><strong id="provider-login-preparation-title">{t('providers.loginPreparationTitle', { service: preparationServiceLabel })}</strong></span>
              <button type="button" onClick={() => setOAuthPreparation(null)} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            <p>{t('providers.loginPreparationHint')}</p>
            <div className="provider-oauth-service-summary">
              <KeyRound size={18} />
              <span>
                <strong>{preparationIdentity || preparationServiceLabel}</strong>
                <small>{preparationRecord
                  ? (preparationIdentity
                      ? t('providers.identifiedAccount', { service: preparationServiceLabel })
                      : t('providers.unidentifiedAccount'))
                  : t('providers.newServiceLogin')}</small>
                {oauthPreparation.accountId && <code>{t('providers.accountIdDisplay', { id: oauthPreparation.accountId })}</code>}
              </span>
            </div>
            {preparationMethods.length > 1 && (
              <div className="provider-login-methods" role="radiogroup" aria-label={t('providers.loginMethod')}>
                {preparationMethods.map(method => (
                  <button
                    className={oauthPreparation.adapterId === method.id ? 'is-active' : ''}
                    type="button"
                    role="radio"
                    aria-checked={oauthPreparation.adapterId === method.id}
                    key={method.id}
                    onClick={() => setOAuthPreparation(current => current ? { ...current, adapterId: method.id } : current)}
                  >
                    {method.flow === 'device_code' ? <Smartphone size={15} /> : <ArrowUpRight size={15} />}
                    <span>
                      <strong>{method.flow === 'device_code' ? t('providers.deviceCodeLogin') : t('providers.browserLogin')}</strong>
                      <small>{method.flow === 'device_code' ? t('providers.deviceLoginMethodHint') : t('providers.browserLoginMethodHint')}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <section className="provider-login-steps">
              <strong>{preparationDescriptor?.flow === 'device_code'
                ? t('providers.beforeDeviceLogin')
                : t('providers.beforeBrowserLogin')}</strong>
              {preparationDescriptor?.flow === 'device_code' ? (
                <ol>
                  <li>{t('providers.deviceLoginStepOne')}</li>
                  <li>{t('providers.deviceLoginStepTwo')}</li>
                  <li>{t('providers.deviceLoginStepThree')}</li>
                </ol>
              ) : (
                <ol>
                  <li>{t('providers.browserLoginStepOne')}</li>
                  <li>{preparationDescriptor?.callback_mode === 'loopback'
                    ? t('providers.browserLoginLoopbackStep')
                    : t('providers.browserLoginReturnStep')}</li>
                  <li>{t('providers.browserLoginStepThree')}</li>
                </ol>
              )}
              {oauthPreparation.preset.id === 'codex' && preparationDescriptor?.flow === 'device_code' && (
                <a href="https://learn.chatgpt.com/docs/auth#login-on-headless-devices" target="_blank" rel="noreferrer">
                  {t('providers.deviceCodeEnableHelp')} <ArrowUpRight size={11} />
                </a>
              )}
              {preparationDescriptor?.callback_mode === 'loopback' && (
                <div className="provider-login-loopback-warning">
                  <strong>{t('providers.remoteBrowserWarning')}</strong>
                  <span>{t('providers.remoteBrowserWarningHint')}</span>
                  {oauthPreparation.preset.id === 'codex' && <code>ssh -N -L 1455:127.0.0.1:1455 &lt;user&gt;@&lt;morphz-host&gt;</code>}
                </div>
              )}
            </section>
            <footer>
              <button type="button" onClick={() => setOAuthPreparation(null)}>{t('providers.cancel')}</button>
              <button className="is-primary" type="button" disabled={!preparationDescriptor} onClick={beginPreparedLogin}>
                {preparationDescriptor?.flow === 'device_code' ? <Smartphone size={13} /> : <ArrowUpRight size={13} />}
                {preparationDescriptor?.flow === 'device_code'
                  ? t('providers.generateDeviceCode')
                  : t('providers.openAuthorizationAndLogin')}
              </button>
            </footer>
          </section>
        </div>
      )}

      {oauthConnection && (
        <div className="provider-oauth-backdrop" role="presentation">
          <section className="provider-oauth-dialog provider-oauth-progress" role="dialog" aria-modal="true" aria-labelledby="provider-oauth-progress-title">
            <header>
              <span>
                {oauthConnection.stage === 'connecting'
                  ? <RefreshCw className="is-spinning" size={16} />
                  : <CircleOff size={16} />}
                <strong id="provider-oauth-progress-title">
                  {oauthConnection.stage === 'connecting'
                    ? t('providers.oauthConnecting', { service: oauthConnection.label })
                    : t('providers.oauthStartFailed', { service: oauthConnection.label })}
                </strong>
              </span>
              <button type="button" onClick={() => setOAuthConnection(null)} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            {oauthConnection.stage === 'connecting'
              ? <p>{t('providers.oauthConnectingHint')}</p>
              : <p className="provider-oauth-inline-error">{oauthConnection.error || t('providers.oauthUnknownError')}</p>}
            <footer>
              <button type="button" onClick={() => setOAuthConnection(null)}>{t('providers.cancel')}</button>
              {oauthConnection.stage === 'failed' && (
                <button className="is-primary" type="button" onClick={retryOAuthConnection}>
                  <RefreshCw size={13} /> {t('providers.retryLogin')}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}

      {challenge && (
        <div className="provider-oauth-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target) {
            cancelLoginChallenge()
          }
        }}>
          <section className="provider-oauth-dialog provider-oauth-login-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-oauth-title">
            <header>
              <span><KeyRound size={16} /><strong id="provider-oauth-title">{t('providers.oauthTitle', { account: challengeLabel })}</strong></span>
              <button type="button" onClick={cancelLoginChallenge} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            <p>{challengeHint}</p>
            {challenge.flow === 'authorization_code_pkce' && challenge.callback_mode === 'loopback' && (
              <section className="provider-oauth-guide">
                <strong>{t('providers.remoteLoginTitle')}</strong>
                <small>{t('providers.runtimeBrowserOption')}</small>
                <ol>
                  <li>{t('providers.remoteLoginOpen')}</li>
                  <li>{t('providers.remoteLoginCopy')}</li>
                  <li>{t('providers.remoteLoginSubmit')}</li>
                </ol>
                {sshTunnelCommand && (
                  <div>
                    <small>{t('providers.sshTunnelOption')}</small>
                    <code>{sshTunnelCommand}</code>
                  </div>
                )}
                {challenge.callback_state && (
                  <small>{t('providers.currentLoginState', { state: stateSuffix(challenge.callback_state) })}</small>
                )}
              </section>
            )}
            {challenge.user_code && (
              <div className="provider-device-code">
                <span><small>{t('providers.userCode')}</small><strong>{challenge.user_code}</strong></span>
                <button type="button" onClick={() => void copyDeviceCode()}>
                  <Copy size={13} /> {deviceCodeCopied
                    ? t('providers.deviceCodeCopied')
                    : t('providers.copyDeviceCode')}
                </button>
              </div>
            )}
            {challengeAuthorizationUrl && (
              <div className="provider-oauth-link-actions">
                <a href={challengeAuthorizationUrl} target="_blank" rel="noreferrer">
                  <ArrowUpRight size={13} /> {t('providers.openAuthorization')}
                </a>
                <button type="button" onClick={() => void copyAuthorizationUrl()}>
                  <Copy size={13} /> {authorizationLinkCopied
                    ? t('providers.authorizationLinkCopied')
                    : t('providers.copyAuthorizationLink')}
                </button>
              </div>
            )}
            {challenge.flow === 'authorization_code_pkce' && challenge.callback_mode === 'loopback' && (
              <div className="provider-oauth-callback">
                <label>
                  <span>{t('providers.authorizationResponse')}</span>
                  <textarea
                    value={authorizationResponse}
                    onChange={event => setAuthorizationResponse(event.target.value)}
                    placeholder={expectedCallbackExample}
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  disabled={busyAccount === challenge.account_id}
                  onClick={() => void submitCallbackFromClipboard()}
                >
                  <ClipboardPaste size={13} /> {t('providers.readClipboardAndSubmit')}
                </button>
                <small>{t('providers.readClipboardAndSubmitHint')}</small>
              </div>
            )}
            {challengeError && <p className="provider-oauth-inline-error">{challengeError}</p>}
            <footer>
              <button type="button" onClick={cancelLoginChallenge}>{t('providers.cancel')}</button>
              <button className="is-primary" type="button" disabled={busyAccount === challenge.account_id} onClick={() => void continueLogin()}>
                <Link2 size={13} /> {challenge.flow === 'authorization_code_pkce' && authorizationResponse.trim()
                  ? t('providers.submitCallbackUrl')
                  : t('providers.pollLogin')}
              </button>
            </footer>
          </section>
        </div>
      )}

      {catalogEditor && (
        <div className="provider-oauth-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target) setCatalogEditor(null)
        }}>
          <section className="provider-oauth-dialog provider-catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-catalog-title">
            <header>
              <span><Network size={16} /><strong id="provider-catalog-title">{t('providers.catalogEditor')}</strong></span>
              <button type="button" onClick={() => setCatalogEditor(null)} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            <p>{t('providers.catalogEditorHint')}</p>
            <label className="provider-catalog-id"><span>{t('providers.catalogId')}</span><input value={catalogEditor.id} disabled={!catalogEditor.creating} onChange={event => setCatalogEditor(current => current ? { ...current, id: event.target.value } : current)} autoFocus /></label>
            {catalogEditor.kind === 'auth_account' && (
              <label className="provider-catalog-id"><span>{t('providers.accountName')}</span><input value={catalogEditor.displayName} onChange={event => setCatalogEditor(current => current ? { ...current, displayName: event.target.value } : current)} /></label>
            )}
            <label className="provider-catalog-json"><span>{t('providers.catalogJson')}</span><textarea spellCheck={false} value={catalogEditor.value} onChange={event => setCatalogEditor(current => current ? { ...current, value: event.target.value } : current)} /></label>
            <footer>
              <button type="button" onClick={() => setCatalogEditor(null)}>{t('providers.cancel')}</button>
              <button className="is-primary" type="button" onClick={() => void saveCatalogObject()}><Save size={13} /> {t('providers.saveRestart')}</button>
            </footer>
          </section>
        </div>
      )}

      {accountPendingDeletion && (
        <div className="app-dialog-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target && busyAccount !== accountPendingDeletion.id) {
            setAccountPendingDeletion(null)
          }
        }}>
          <section className="app-dialog is-danger" role="dialog" aria-modal="true" aria-labelledby="provider-delete-title">
            <header>
              <div><small>{t('providers.deleteAccountEyebrow')}</small><h2 id="provider-delete-title">{t('providers.deleteAccountTitle', { account: accountPendingDeletion.label })}</h2></div>
              <button type="button" disabled={busyAccount === accountPendingDeletion.id} onClick={() => setAccountPendingDeletion(null)} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            <p>{t('providers.deleteAccountHint')}</p>
            <footer>
              <button type="button" disabled={busyAccount === accountPendingDeletion.id} onClick={() => setAccountPendingDeletion(null)}>{t('providers.cancel')}</button>
              <button className="danger" type="button" disabled={busyAccount === accountPendingDeletion.id} onClick={() => void deleteAccount()}>
                <Trash2 size={13} /> {busyAccount === accountPendingDeletion.id ? t('providers.busy') : t('providers.confirmDelete')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}
