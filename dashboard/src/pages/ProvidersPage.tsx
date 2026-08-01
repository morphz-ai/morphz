import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleOff,
  Cloud,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Save,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DashboardApiClient } from '../api/client'

interface ProviderModelConfig {
  context_window_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
}

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
  aliases: string[]
  candidates: ModelRouteCandidate[]
  affinity: string
  selection: string
  fallback: boolean
}

interface ProviderControlSnapshot {
  generated_at: string
  selected_model_alias: string
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
  stability: 'stable' | 'compatibility' | 'experimental'
  upstream_reference?: string
  last_verified_on?: string
}

interface ModelAttemptBinding {
  requested_alias: string
  route_id: string
  route_revision: string
  provider_instance_id: string
  auth_account_id: string
  physical_model: string
  protocol: string
  provider_adapter: string
  provider_adapter_version: string
  endpoint: string
  capabilities: string[]
}

interface ModelUsageRecord {
  event_id: string
  timestamp: string
  context_id: string
  session_id: string
  attempt_id: string
  model?: string
  model_binding?: ModelAttemptBinding
  usage: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  cost?: {
    amount: number
    currency: string
    pricing_version: string
  }
}

interface ModelRouteDiagnostic {
  checked_at: string
  binding: ModelAttemptBinding
  elapsed_ms: number
  discovered_models: string[]
  catalog_error?: string
  health_verified: boolean
  health_error?: string
}

interface OAuthLoginChallenge {
  login_id: string
  account_id: string
  adapter_id: string
  flow: 'authorization_code_pkce' | 'device_code'
  authorization_url?: string
  verification_uri?: string
  verification_uri_complete?: string
  user_code?: string
  expires_at: string
  poll_interval_secs: number
}

type OAuthLoginProgress =
  | { status: 'pending'; retry_after_secs: number }
  | { status: 'complete'; account: OAuthAccountMetadata }

interface ProvidersPageProps {
  api: DashboardApiClient
}

type CatalogEditorKind = 'provider_instance' | 'auth_account' | 'model_route'

interface CatalogEditorState {
  kind: CatalogEditorKind
  id: string
  value: string
  creating: boolean
}

interface CatalogMutationReceipt {
  kind: CatalogEditorKind
  id: string
  managed_config_path: string
  restart_required: boolean
}

const EMPTY_SNAPSHOT: ProviderControlSnapshot = {
  generated_at: '',
  selected_model_alias: '',
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

export function ProvidersPage({ api }: ProvidersPageProps) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ProviderControlSnapshot>(EMPTY_SNAPSHOT)
  const [attempts, setAttempts] = useState<ModelUsageRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyAccount, setBusyAccount] = useState('')
  const [error, setError] = useState('')
  const [challenge, setChallenge] = useState<OAuthLoginChallenge | null>(null)
  const [authorizationCode, setAuthorizationCode] = useState('')
  const [authorizationState, setAuthorizationState] = useState('')
  const [catalogEditor, setCatalogEditor] = useState<CatalogEditorState | null>(null)
  const [catalogNotice, setCatalogNotice] = useState('')
  const [diagnostic, setDiagnostic] = useState<ModelRouteDiagnostic | null>(null)
  const [diagnosing, setDiagnosing] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [nextSnapshot, nextAttempts] = await Promise.all([
        api.get<ProviderControlSnapshot>('/api/runtime/providers'),
        api.get<ModelUsageRecord[]>('/api/runtime/providers/attempts?limit=40'),
      ])
      setSnapshot(nextSnapshot)
      setAttempts(nextAttempts)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const instances = useMemo(() => Object.entries(snapshot.provider_instances), [snapshot.provider_instances])
  const accounts = useMemo(() => Object.entries(snapshot.auth_accounts), [snapshot.auth_accounts])
  const routes = useMemo(() => Object.entries(snapshot.model_routes), [snapshot.model_routes])

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

  const startLogin = async (accountId: string) => {
    // Create the window during the user gesture. Safari otherwise treats the
    // post-fetch navigation as an unsolicited popup.
    const authorizationWindow = window.open('about:blank', '_blank')
    if (authorizationWindow) authorizationWindow.opener = null
    setBusyAccount(accountId)
    setError('')
    try {
      const next = await api.command<OAuthLoginChallenge>(
        `/api/runtime/providers/accounts/${encodeURIComponent(accountId)}/oauth/start`,
        'POST',
      )
      setChallenge(next)
      setAuthorizationCode('')
      setAuthorizationState('')
      const authorizationUrl = next.authorization_url
        ?? next.verification_uri_complete
        ?? next.verification_uri
      if (authorizationUrl && authorizationWindow) authorizationWindow.location.href = authorizationUrl
      else authorizationWindow?.close()
    } catch (reason) {
      authorizationWindow?.close()
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAccount('')
    }
  }

  const continueLogin = async () => {
    if (!challenge) return
    setBusyAccount(challenge.account_id)
    setError('')
    try {
      const body = challenge.flow === 'device_code'
        ? { kind: 'poll' }
        : { kind: 'authorization_code', code: authorizationCode.trim(), state: authorizationState.trim() }
      const progress = await api.command<OAuthLoginProgress>(
        `/api/runtime/providers/oauth/${encodeURIComponent(challenge.login_id)}/continue`,
        'POST',
        body,
      )
      if (progress.status === 'complete') {
        setChallenge(null)
        await refresh()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyAccount('')
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
    setCatalogEditor({ kind, id, value: JSON.stringify(value, null, 2), creating: !id })
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
      setError(reason instanceof Error ? reason.message : String(reason))
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

  const compatibleRouteForAccount = (accountId: string): string | undefined => routes.find(([, route]) => (
    route.candidates.some(candidate => candidate.account === accountId
      || snapshot.provider_instances[candidate.provider]?.accounts.includes(accountId))
  ))?.[0]

  return (
    <section className="providers-view">
      <header className="workspace-heading">
        <div>
          <span>{t('providers.eyebrow').toUpperCase()}</span>
          <h1>{t('providers.heading')}</h1>
          <p>{t('providers.description')}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={loading ? 'is-spinning' : ''} size={14} /> {t('providers.refresh')}
        </button>
      </header>

      {error && <p className="provider-control-error">{error}</p>}
      {catalogNotice && <p className="provider-control-notice">{catalogNotice}</p>}

      <section className="provider-selected-alias">
        <Route size={17} />
        <span><small>{t('providers.selectedAlias')}</small><strong>{snapshot.selected_model_alias || '—'}</strong></span>
        <code>{localDate(snapshot.generated_at)}</code>
      </section>

      {diagnostic && (
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
        <header><span><Activity size={15} /> {t('providers.recentAttempts')}</span><small>{t('providers.recentAttemptsHint')}</small></header>
        <div className="provider-attempt-list">
          {attempts.slice(0, 20).map(attempt => {
            const binding = attempt.model_binding
            return (
              <article key={attempt.event_id}>
                <header>
                  <span><strong>{binding?.requested_alias ?? attempt.model ?? '—'}</strong><code>{attempt.attempt_id}</code></span>
                  <time dateTime={attempt.timestamp}>{localDate(attempt.timestamp)}</time>
                </header>
                <div>
                  <span><small>{t('providers.physicalModel')}</small><strong>{binding?.physical_model ?? attempt.model ?? '—'}</strong></span>
                  <span><small>{t('providers.providerInstance')}</small><strong>{binding?.provider_instance_id ?? t('providers.legacyAttempt')}</strong></span>
                  <span><small>{t('providers.authAccount')}</small><strong>{binding?.auth_account_id ?? '—'}</strong></span>
                  <span><small>{t('providers.routeRevision')}</small><strong>{binding ? `${binding.route_id} · ${binding.route_revision}` : '—'}</strong></span>
                </div>
                <footer>
                  <code>{attempt.context_id} / {attempt.session_id}</code>
                  <span>{t('providers.usageTokens', { count: attempt.usage.total_tokens ?? 0 })}</span>
                  {attempt.cost && <span>{attempt.cost.amount.toFixed(6)} {attempt.cost.currency}</span>}
                </footer>
              </article>
            )
          })}
          {!loading && attempts.length === 0 && <p className="provider-empty">{t('providers.noAttempts')}</p>}
        </div>
      </section>

      <section className="provider-control-section">
        <header><span><Server size={15} /> {t('providers.instances')}</span><small>{t('providers.instancesHint')}</small><button type="button" onClick={() => openCatalogEditor('provider_instance', '', { adapter: 'protocol-compatible', protocol: 'openai-responses', base_url: '', accounts: [], models: {}, headers: {}, env_headers: {} })}><Plus size={13} /> {t('providers.add')}</button></header>
        <div className="provider-instance-grid">
          {instances.map(([providerId, provider]) => (
            <article key={providerId}>
              <header><Cloud size={16} /><span><strong>{providerId}</strong><code>{provider.adapter || provider.protocol}</code></span><button type="button" aria-label={t('providers.edit')} onClick={() => openCatalogEditor('provider_instance', providerId, provider)}><Pencil size={13} /></button></header>
              <p title={provider.base_url}>{provider.base_url}</p>
              <footer>
                <span>{t('providers.accountPool', { count: provider.accounts.length })}</span>
                <span>{t('providers.modelCount', { count: Object.keys(provider.models).length })}</span>
                <code>{provider.protocol}</code>
              </footer>
            </article>
          ))}
          {!loading && instances.length === 0 && <p className="provider-empty">{t('providers.noInstances')}</p>}
        </div>
      </section>

      <section className="provider-control-section">
        <header><span><ShieldCheck size={15} /> {t('providers.authAdapters')}</span><small>{t('providers.authAdaptersHint')}</small></header>
        <div className="provider-adapter-list">
          {snapshot.auth_adapters.map(adapter => (
            <article key={adapter.id}>
              <span><strong>{adapter.id}</strong><code>{adapter.version}</code></span>
              <div><em>{t(`providers.stability.${adapter.stability}`)}</em><em>{t(`providers.flow.${adapter.flow}`)}</em></div>
              <small>{adapter.upstream_reference ?? '—'}</small>
              <time>{adapter.last_verified_on ? t('providers.verifiedOn', { date: adapter.last_verified_on }) : t('providers.notVerified')}</time>
            </article>
          ))}
          {!loading && snapshot.auth_adapters.length === 0 && <p className="provider-empty">{t('providers.noAuthAdapters')}</p>}
        </div>
      </section>

      <section className="provider-control-section">
        <header><span><KeyRound size={15} /> {t('providers.accounts')}</span><small>{t('providers.accountsHint')}</small><button type="button" onClick={() => openCatalogEditor('auth_account', '', { auth_adapter: 'credential', credential_ref: '', enabled: true })}><Plus size={13} /> {t('providers.add')}</button></header>
        <div className="provider-account-list">
          {accounts.map(([accountId, record]) => {
            const isBusy = busyAccount === accountId
            return (
              <article className={!record.effective_enabled ? 'is-disabled' : ''} key={accountId}>
                <span className={`provider-account-presence ${record.effective_enabled ? 'is-enabled' : ''}`}>
                  {record.authenticated ? <CheckCircle2 size={15} /> : <CircleOff size={15} />}
                </span>
                <div className="provider-account-identity">
                  <strong>{record.config.label || accountId}</strong>
                  <code>{accountId} · {record.config.auth_adapter}</code>
                  <small>{record.config.provider ?? '—'} · {record.config.secret_backend ?? 'runtime-default'}</small>
                </div>
                <div className="provider-account-facts">
                  <span>{record.effective_enabled ? t('providers.enabled') : t('providers.disabled')}</span>
                  <span>{record.authenticated ? t('providers.authenticated') : t('providers.notAuthenticated')}</span>
                  {record.state && <span>{t('providers.status', { value: record.state.status })} · r{record.state.revision}</span>}
                  {record.state?.cooldown_until && <span>{t('providers.cooldown', { time: localDate(record.state.cooldown_until) })}</span>}
                  {record.state?.last_error_kind && <span>{t('providers.lastError', { value: record.state.last_error_kind })}</span>}
                  {record.oauth_metadata?.subject && <span>{t('providers.subject', { value: record.oauth_metadata.subject })}</span>}
                  {record.oauth_metadata?.expires_at && <span>{t('providers.expires', { time: localDate(record.oauth_metadata.expires_at) })}</span>}
                </div>
                <nav>
                  {compatibleRouteForAccount(accountId) && (
                    <button type="button" disabled={Boolean(diagnosing)} onClick={() => void diagnoseRoute(compatibleRouteForAccount(accountId)!, accountId)}>
                      <Activity size={13} /> {t('providers.test')}
                    </button>
                  )}
                  <button type="button" disabled={isBusy} onClick={() => openCatalogEditor('auth_account', accountId, record.config)}>
                    <Pencil size={13} /> {t('providers.edit')}
                  </button>
                  {record.oauth && (
                    <button type="button" disabled={isBusy} onClick={() => void startLogin(accountId)}>
                      <LogIn size={13} /> {record.authenticated ? t('providers.relogin') : t('providers.login')}
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
                </nav>
              </article>
            )
          })}
          {!loading && accounts.length === 0 && <p className="provider-empty">{t('providers.noAccounts')}</p>}
        </div>
      </section>

      <section className="provider-control-section">
        <header><span><Network size={15} /> {t('providers.routes')}</span><small>{t('providers.routesHint')}</small><button type="button" onClick={() => openCatalogEditor('model_route', '', { aliases: [], candidates: [], affinity: 'context', selection: 'available-least-recently-used', fallback: false })}><Plus size={13} /> {t('providers.add')}</button></header>
        <div className="provider-route-list">
          {routes.map(([routeId, route]) => (
            <article className={routeId === snapshot.selected_model_alias || route.aliases.includes(snapshot.selected_model_alias) ? 'is-selected' : ''} key={routeId}>
              <header>
                <Route size={15} />
                <span><strong>{routeId}</strong><small>{route.aliases.length > 0 ? t('providers.aliases', { value: route.aliases.join(', ') }) : '—'}</small></span>
                <div><em>{t('providers.affinity', { value: route.affinity })}</em><em>{t('providers.selection', { value: route.selection })}</em>{route.fallback && <em>{t('providers.fallback')}</em>}</div>
                <nav>
                  <button type="button" disabled={Boolean(diagnosing)} onClick={() => void diagnoseRoute(routeId)}><Activity size={13} /> {t('providers.test')}</button>
                  <button type="button" disabled={Boolean(diagnosing)} onClick={() => void refreshRouteCatalog(routeId)}><RefreshCw size={13} /> {t('providers.refreshCatalog')}</button>
                  <button type="button" aria-label={t('providers.edit')} onClick={() => openCatalogEditor('model_route', routeId, route)}><Pencil size={13} /></button>
                </nav>
              </header>
              <div>
                {route.candidates.map((candidate, index) => (
                  <section key={`${candidate.provider}:${candidate.model}:${candidate.account ?? ''}:${index}`}>
                    <span>{t('providers.candidate', { index: index + 1 })}<small>{t('providers.priority', { priority: candidate.priority })}</small></span>
                    <strong>{candidate.provider}<i>/</i>{candidate.model}</strong>
                    <code>{candidate.account ? t('providers.pinnedAccount', { account: candidate.account }) : t('providers.anyAccount')}</code>
                    {candidate.capabilities.length > 0 && <small>{t('providers.capabilities', { value: candidate.capabilities.join(', ') })}</small>}
                  </section>
                ))}
              </div>
            </article>
          ))}
          {!loading && routes.length === 0 && <p className="provider-empty">{t('providers.noRoutes')}</p>}
        </div>
      </section>

      <section className="provider-control-section">
        <header><span><Cloud size={15} /> {t('providers.remoteCatalog')}</span><small>{t('providers.remoteCatalogHint')}</small></header>
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

      {challenge && (
        <div className="provider-oauth-backdrop" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target) setChallenge(null)
        }}>
          <section className="provider-oauth-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-oauth-title">
            <header>
              <span><KeyRound size={16} /><strong id="provider-oauth-title">{t('providers.oauthTitle', { account: challenge.account_id })}</strong></span>
              <button type="button" onClick={() => setChallenge(null)} aria-label={t('providers.cancel')}><X size={15} /></button>
            </header>
            <p>{challenge.flow === 'device_code' ? t('providers.deviceHint') : t('providers.pkceHint')}</p>
            {challenge.user_code && <div className="provider-device-code"><small>{t('providers.userCode')}</small><strong>{challenge.user_code}</strong></div>}
            {(challenge.authorization_url || challenge.verification_uri_complete || challenge.verification_uri) && (
              <a href={challenge.authorization_url ?? challenge.verification_uri_complete ?? challenge.verification_uri} target="_blank" rel="noreferrer">
                <ArrowUpRight size={13} /> {t('providers.openAuthorization')}
              </a>
            )}
            {challenge.flow === 'authorization_code_pkce' && (
              <div className="provider-oauth-fields">
                <label><span>{t('providers.authorizationCode')}</span><input value={authorizationCode} onChange={event => setAuthorizationCode(event.target.value)} autoFocus /></label>
                <label><span>{t('providers.authorizationState')}</span><input value={authorizationState} onChange={event => setAuthorizationState(event.target.value)} /></label>
              </div>
            )}
            <footer>
              <button type="button" onClick={() => setChallenge(null)}>{t('providers.cancel')}</button>
              <button className="is-primary" type="button" disabled={busyAccount === challenge.account_id || (challenge.flow === 'authorization_code_pkce' && (!authorizationCode.trim() || !authorizationState.trim()))} onClick={() => void continueLogin()}>
                <Link2 size={13} /> {challenge.flow === 'device_code' ? t('providers.pollLogin') : t('providers.completeLogin')}
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
            <label className="provider-catalog-json"><span>{t('providers.catalogJson')}</span><textarea spellCheck={false} value={catalogEditor.value} onChange={event => setCatalogEditor(current => current ? { ...current, value: event.target.value } : current)} /></label>
            <footer>
              <button type="button" onClick={() => setCatalogEditor(null)}>{t('providers.cancel')}</button>
              <button className="is-primary" type="button" onClick={() => void saveCatalogObject()}><Save size={13} /> {t('providers.saveRestart')}</button>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}
