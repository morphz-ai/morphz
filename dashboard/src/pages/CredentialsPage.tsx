import {
  CheckCircle2,
  FileKey2,
  HardDrive,
  KeyRound,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DashboardApiClient } from '../api/client'
import { formatAgo, shortId } from '../app/presentation'

type SecretScopeKind = 'runtime' | 'context' | 'session' | 'objective' | 'execution_target'

interface ManagedSecret {
  name: string
  secret_ref: string
  scope_kind: SecretScopeKind
  scope_id?: string
  value_backend: string
  created_at: string
  updated_at: string
}

interface SecretBackendStatus {
  id: string
  storage_kind: string
  available: boolean
  writable: boolean
  supports_import: boolean
  detail: string
}

interface SecretImportCandidate {
  name: string
  value_backend: string
}

interface SecretUseAuditRecord {
  name: string
  secret_ref: string
  value_backend: string
  context_id?: string
  session_id?: string
  objective_id?: string
  target_id?: string
  used_at: string
}

interface SecretCatalogResponse {
  secrets: ManagedSecret[]
  default_value_backend: string
  backends: SecretBackendStatus[]
  import_candidates: SecretImportCandidate[]
  recent_usage: SecretUseAuditRecord[]
}

interface SecretScopeOptions {
  contexts: Array<{ id: string; title: string; status: string }>
  sessions: Array<{ id: string; context_id: string; title: string; status: string }>
  objectives: Array<{ id: string; context_id: string; stated_objective: string; status: string }>
  execution_targets: Array<{ id: string; name: string; kind: string; status: string }>
}

interface CredentialsPageProps {
  api: DashboardApiClient
}

const EMPTY_CATALOG: SecretCatalogResponse = {
  secrets: [],
  default_value_backend: '',
  backends: [],
  import_candidates: [],
  recent_usage: [],
}

const EMPTY_SCOPES: SecretScopeOptions = {
  contexts: [],
  sessions: [],
  objectives: [],
  execution_targets: [],
}

export function CredentialsPage({ api }: CredentialsPageProps) {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<SecretCatalogResponse>(EMPTY_CATALOG)
  const [scopeOptions, setScopeOptions] = useState<SecretScopeOptions>(EMPTY_SCOPES)
  const [mode, setMode] = useState<'store' | 'import'>('store')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [backend, setBackend] = useState('')
  const [scopeKind, setScopeKind] = useState<SecretScopeKind>('runtime')
  const [scopeId, setScopeId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [nextCatalog, nextScopes] = await Promise.all([
        api.get<SecretCatalogResponse>('/api/runtime/secrets'),
        api.get<SecretScopeOptions>('/api/runtime/secrets/scope-options'),
      ])
      setCatalog(nextCatalog)
      setScopeOptions(nextScopes)
      setBackend(current => (
        nextCatalog.backends.some(item => item.id === current)
          ? current
          : nextCatalog.default_value_backend || nextCatalog.backends[0]?.id || ''
      ))
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

  const availableImportCandidates = useMemo(
    () => catalog.import_candidates.filter(candidate => !backend || candidate.value_backend === backend),
    [backend, catalog.import_candidates],
  )

  const selectedScopeOptions = useMemo(() => {
    switch (scopeKind) {
      case 'context':
        return scopeOptions.contexts.map(item => ({
          id: item.id,
          label: `${item.title} · ${shortId(item.id)} · ${t(`credentials.states.${item.status}`, { defaultValue: item.status })}`,
        }))
      case 'session':
        return scopeOptions.sessions.map(item => ({
          id: item.id,
          label: `${item.title} · ${shortId(item.id)} · ${shortId(item.context_id)}`,
        }))
      case 'objective':
        return scopeOptions.objectives.map(item => ({
          id: item.id,
          label: `${item.stated_objective} · ${shortId(item.id)}`,
        }))
      case 'execution_target':
        return scopeOptions.execution_targets.map(item => ({
          id: item.id,
          label: `${item.name} · ${item.kind} · ${shortId(item.id)}`,
        }))
      default:
        return []
    }
  }, [scopeKind, scopeOptions, t])

  useEffect(() => {
    if (scopeKind === 'runtime') {
      setScopeId('')
      return
    }
    if (!selectedScopeOptions.some(item => item.id === scopeId)) {
      setScopeId(selectedScopeOptions[0]?.id ?? '')
    }
  }, [scopeId, scopeKind, selectedScopeOptions])

  useEffect(() => {
    if (mode !== 'import') return
    const selected = availableImportCandidates.find(candidate => candidate.name === name)
      ?? availableImportCandidates[0]
    setName(selected?.name ?? '')
    if (selected) setBackend(selected.value_backend)
    setValue('')
  }, [availableImportCandidates, mode, name])

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const payload = {
        name: name.trim(),
        scope_kind: scopeKind,
        scope_id: scopeKind === 'runtime' ? undefined : scopeId,
        value_backend: backend,
      }
      if (mode === 'import') {
        await api.command('/api/runtime/secrets/import', 'POST', payload)
      } else {
        await api.command('/api/runtime/secrets', 'POST', { ...payload, value })
      }
      setName('')
      setValue('')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (secretName: string) => {
    setBusy(true)
    setError('')
    try {
      await api.command(`/api/runtime/secrets/${encodeURIComponent(secretName)}`, 'DELETE')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const rotate = (secret: ManagedSecret) => {
    setMode('store')
    setName(secret.name)
    setValue('')
    setBackend(secret.value_backend)
    setScopeKind(secret.scope_kind)
    setScopeId(secret.scope_id ?? '')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const backendLabel = (item: SecretBackendStatus) => t(
    `credentials.backends.${item.storage_kind}`,
    { defaultValue: item.id },
  )
  const selectedBackend = catalog.backends.find(item => item.id === backend)

  return (
    <section className="credentials-view">
      <header className="workspace-heading">
        <div>
          <span>{t('credentials.eyebrow').toUpperCase()}</span>
          <h1>{t('credentials.heading')}</h1>
          <p>{t('credentials.description')}</p>
        </div>
        <button type="button" onClick={() => void refresh()}>
          <RefreshCw size={14} /> {t('credentials.refresh')}
        </button>
      </header>

      <section className="credential-backends">
        <header>
          <span><HardDrive size={15} /> {t('credentials.valueBackends')}</span>
          <small>{t('credentials.backendChoiceHint')}</small>
        </header>
        <div>
          {catalog.backends.map(item => (
            <article
              className={item.id === backend ? 'is-selected' : ''}
              key={item.id}
              onClick={() => setBackend(item.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setBackend(item.id)
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span className={item.available ? 'is-available' : 'is-unavailable'}>
                {item.available ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
              </span>
              <div>
                <strong>{backendLabel(item)}</strong>
                <code>{item.id}</code>
                <p>{item.detail}</p>
              </div>
              <em>{item.available ? t('credentials.available') : t('credentials.unavailable')}</em>
            </article>
          ))}
        </div>
      </section>

      <section className="credential-editor">
        <header>
          <div>
            <span><KeyRound size={15} /> {t('credentials.editor')}</span>
            <small>{t('credentials.writeOnly')}</small>
          </div>
          <nav aria-label={t('credentials.mode')}>
            <button className={mode === 'store' ? 'is-active' : ''} type="button" onClick={() => setMode('store')}>
              {t('credentials.storeNew')}
            </button>
            <button className={mode === 'import' ? 'is-active' : ''} type="button" onClick={() => setMode('import')}>
              {t('credentials.importExisting')}
            </button>
          </nav>
        </header>
        <div className="credential-editor-grid">
          <label>
            <span>{t('credentials.valueBackend')}</span>
            <select value={backend} onChange={event => setBackend(event.target.value)}>
              {catalog.backends.map(item => (
                <option key={item.id} value={item.id}>
                  {backendLabel(item)}{item.available ? '' : ` · ${t('credentials.unavailable')}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('credentials.alias')}</span>
            {mode === 'import' ? (
              <select value={name} onChange={event => setName(event.target.value)}>
                {availableImportCandidates.map(candidate => (
                  <option key={`${candidate.value_backend}:${candidate.name}`} value={candidate.name}>{candidate.name}</option>
                ))}
              </select>
            ) : (
              <input autoComplete="off" placeholder="SERVICE_API_TOKEN" value={name} onChange={event => setName(event.target.value.toUpperCase())} />
            )}
          </label>
          {mode === 'store' && (
            <label>
              <span>{t('credentials.value')}</span>
              <input autoComplete="new-password" type="password" value={value} onChange={event => setValue(event.target.value)} />
            </label>
          )}
          <label>
            <span>{t('credentials.scope')}</span>
            <select value={scopeKind} onChange={event => setScopeKind(event.target.value as SecretScopeKind)}>
              {(['runtime', 'context', 'session', 'objective', 'execution_target'] as SecretScopeKind[]).map(scope => (
                <option key={scope} value={scope}>{t(`runtime.secretScopes.${scope}`)}</option>
              ))}
            </select>
          </label>
          {scopeKind !== 'runtime' && (
            <label className="credential-scope-entity">
              <span>{t('credentials.scopeEntity')}</span>
              <select title={selectedScopeOptions.find(item => item.id === scopeId)?.label} value={scopeId} onChange={event => setScopeId(event.target.value)}>
                {selectedScopeOptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              {scopeId && <code title={scopeId}>{scopeId}</code>}
            </label>
          )}
        </div>
        {mode === 'import' && availableImportCandidates.length === 0 && (
          <p className="credential-empty-note">{t('credentials.noImportCandidates')}</p>
        )}
        {backend === 'morphz_env_file' && (
          <p className="credential-plaintext-warning">
            <TriangleAlert size={14} /> {t('credentials.plaintextWarning')}
          </p>
        )}
        {error && <p className="managed-secret-error">{error}</p>}
        <footer>
          <button
            className="credential-primary-action"
            disabled={
              busy
              || !backend
              || !selectedBackend?.available
              || !selectedBackend.writable
              || !name.trim()
              || (mode === 'store' && !value)
              || (scopeKind !== 'runtime' && !scopeId)
            }
            type="button"
            onClick={() => void submit()}
          >
            <ShieldCheck size={14} />
            {busy ? t('runtime.saving') : mode === 'import' ? t('credentials.import') : t('runtime.saveSecret')}
          </button>
        </footer>
      </section>

      <section className="credential-catalog">
        <header>
          <span><FileKey2 size={15} /> {t('credentials.catalog')}</span>
          <b>{catalog.secrets.length}</b>
        </header>
        <div>
          {catalog.secrets.map(secret => (
            <article key={secret.name}>
              <div>
                <strong>{secret.name}</strong>
                <code>{secret.secret_ref}</code>
              </div>
              <span>
                {t(`runtime.secretScopes.${secret.scope_kind}`)}
                {secret.scope_id ? ` · ${shortId(secret.scope_id)}` : ''}
              </span>
              <small>{secret.value_backend} · {formatAgo(secret.updated_at, t)}</small>
              <nav>
                <button type="button" title={t('credentials.rotate')} onClick={() => rotate(secret)}><RotateCw size={13} /></button>
                <button type="button" title={t('runtime.revoke')} onClick={() => void revoke(secret.name)}><Trash2 size={13} /></button>
              </nav>
            </article>
          ))}
          {!loading && catalog.secrets.length === 0 && <p>{t('runtime.noSecrets')}</p>}
        </div>
      </section>

      <section className="credential-audit">
        <header>
          <span><ShieldCheck size={15} /> {t('credentials.recentUsage')}</span>
          <small>{t('credentials.auditHint')}</small>
        </header>
        <div>
          {catalog.recent_usage.map((record, index) => (
            <article key={`${record.used_at}:${record.name}:${index}`}>
              <strong>{record.name}</strong>
              <span>{record.context_id ? `${t('runtime.secretScopes.context')} ${shortId(record.context_id)}` : t('runtime.secretScopes.runtime')}</span>
              <span>{record.session_id ? `${t('runtime.secretScopes.session')} ${shortId(record.session_id)}` : '—'}</span>
              <small>{formatAgo(record.used_at, t)}</small>
            </article>
          ))}
          {!loading && catalog.recent_usage.length === 0 && <p>{t('credentials.noUsage')}</p>}
        </div>
      </section>
    </section>
  )
}
