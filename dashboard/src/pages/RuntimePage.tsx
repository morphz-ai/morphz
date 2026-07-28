import { Brain, CheckCircle2, Database, GitBranch, Layers3, Radio, RefreshCw, Server, ShieldCheck, Terminal, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { statusLabel } from '../app/presentation'

interface RuntimePageProps {
  connection: string
  endpoint: string
  model: string
  provider: string
  toolCount: number
  reasoning: string
  pressure: string
  estimatedTokens: string
  softLimit: string
  hardLimit: string
  tokenSource: string
  schedulerGeneratedAgo: string
  totalSlots: number | string
  inFlight: number | string
  durableQueued: number | string
  deferred: number | string
  reservedSlots: number | string
  version: string
  uptimeSeconds: number
  recovery: {
    preserved_execution_jobs: number
    requeued_execution_jobs: number
    lost_execution_jobs: number
    recovered_background_outboxes: number
    completed_at?: string
  }
  projectionAudit: {
    ledger_revision: number
    projection_revision?: number
    snapshot_revision?: number
    events_scanned: number
    incremental_transactions_scanned?: number
    incremental_matches?: boolean
    full_replay_micros: number
    incremental_replay_micros?: number
    projection_validation_micros: number
    matches: boolean
  } | null
  auditingProjection: boolean
  storage: string
  sandbox: string
  identity: string
  eventWriter: Record<string, unknown>
  modelProvider: Record<string, unknown>
  contextCapacity: Record<string, unknown>
  executionTargets: Array<{ id: string; revision: number; name: string; kind: string; status: string; platform?: string; workspace_root?: string; provider_node_id?: string; capabilities: string[] }>
  executionNodes: Array<{ id: string; revision: number; name: string; status: string; platform?: string; protocol_version: number; capabilities: string[]; last_seen_at?: string }>
  capabilityLeases: Array<{ id: string; revision: number; thread_id: string; target_id: string; capabilities: string[]; status: string; expires_at: string }>
  executionJobs: Array<{ id: string; revision: number; thread_id: string; target_id: string; tool_name: string; status: string; claimed_by?: string; progress_ref?: string; created_at: string }>
  managedSecrets: Array<{ name: string; secret_ref: string; scope_kind: string; scope_id?: string; value_backend: string; updated_at: string }>
  secretBackendId: string
  onRefresh: () => void
  onAuditProjection: () => void
  onSetTargetStatus: (targetId: string, revision: number, status: 'online' | 'disabled') => void
  onRevokeNode: (nodeId: string, revision: number) => void
  onRevokeLease: (leaseId: string, revision: number) => void
  onCancelJob: (jobId: string, revision: number) => void
  onPutSecret: (secret: { name: string; value: string; scope_kind: string; scope_id?: string }) => Promise<void>
  onDeleteSecret: (name: string) => Promise<void>
}

interface ArtifactProgress {
  kind: 'artifact_transfer'
  phase: string
  bytes_transferred: number
  total_bytes?: number
  current_entry?: string
  throughput_bytes_per_second?: number
}

function artifactProgress(value?: string): ArtifactProgress | null {
  if (!value?.startsWith('{')) return null
  try {
    const parsed = JSON.parse(value) as Partial<ArtifactProgress>
    return parsed.kind === 'artifact_transfer' && typeof parsed.bytes_transferred === 'number'
      ? parsed as ArtifactProgress
      : null
  } catch {
    return null
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}

export function RuntimePage(props: RuntimePageProps) {
  const { t } = useTranslation()
  const [secretName, setSecretName] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [scopeKind, setScopeKind] = useState('runtime')
  const [scopeId, setScopeId] = useState('')
  const [secretBusy, setSecretBusy] = useState(false)
  const [secretError, setSecretError] = useState('')
  const submitSecret = async () => {
    setSecretBusy(true)
    setSecretError('')
    try {
      await props.onPutSecret({
        name: secretName.trim(),
        value: secretValue,
        scope_kind: scopeKind,
        scope_id: scopeKind === 'runtime' ? undefined : scopeId.trim(),
      })
      setSecretValue('')
      setSecretName('')
    } catch (error) {
      setSecretError(error instanceof Error ? error.message : String(error))
    } finally {
      setSecretBusy(false)
    }
  }
  return (
    <section className="runtime-view">
      <header className="workspace-heading">
        <div><span>{t('runtime.eyebrow').toUpperCase()}</span><h1>{t('runtime.heading')}</h1><p>{t('runtime.description')}</p></div>
        <button type="button" onClick={props.onRefresh}><RefreshCw size={14} /> {t('runtime.refresh')}</button>
      </header>
      <div className="runtime-health-grid">
        <article><Radio size={18} /><span><small>{t('runtime.connection').toUpperCase()}</small><strong>{props.connection}</strong><em>{props.endpoint}</em></span></article>
        <article><Brain size={18} /><span><small>{t('runtime.model').toUpperCase()}</small><strong>{props.model}</strong><em>{props.provider}</em></span></article>
        <article><Layers3 size={18} /><span><small>{t('runtime.tools').toUpperCase()}</small><strong>{props.toolCount}</strong><em>{t('runtime.registeredTools')}</em></span></article>
        <article><GitBranch size={18} /><span><small>{t('runtime.reasoning').toUpperCase()}</small><strong>{props.reasoning}</strong><em>{t('runtime.reasoningHint')}</em></span></article>
      </div>
      <section className="execution-plane">
        <header className="execution-plane-heading">
          <span><Server size={16} /><strong>{t('runtime.executionPlane')}</strong></span>
          <small>{t('runtime.executionPlaneHint')}</small>
        </header>
        <div className="execution-plane-grid">
          <section>
            <header><span>{t('runtime.executionTargets')}</span><b>{props.executionTargets.length}</b></header>
            <div className="execution-plane-list">
              {props.executionTargets.map(target => (
                <article key={target.id}>
                  <i data-status={target.status} />
                  <span><strong>{target.name}</strong><small title={target.id}>{target.id} · {target.kind}</small></span>
                  <em title={target.capabilities.join(', ')}>{target.platform ?? '—'} · {target.capabilities.length}</em>
                  <button type="button" onClick={() => props.onSetTargetStatus(target.id, target.revision, target.status === 'disabled' ? 'online' : 'disabled')}>
                    {target.status === 'disabled' ? t('runtime.enable') : t('runtime.disable')}
                  </button>
                </article>
              ))}
              {props.executionTargets.length === 0 && <p>{t('runtime.noExecutionTargets')}</p>}
            </div>
          </section>
          <section>
            <header><span>{t('runtime.executionNodes')}</span><b>{props.executionNodes.length}</b></header>
            <div className="execution-plane-list">
              {props.executionNodes.map(node => (
                <article key={node.id}>
                  <i data-status={node.status} />
                  <span><strong>{node.name}</strong><small title={node.id}>{node.id} · protocol v{node.protocol_version}</small></span>
                  <em>{node.platform ?? '—'} · {node.capabilities.length}</em>
                  {node.status !== 'revoked' && <button type="button" onClick={() => props.onRevokeNode(node.id, node.revision)}>{t('runtime.revoke')}</button>}
                </article>
              ))}
              {props.executionNodes.length === 0 && <p>{t('runtime.noExecutionNodes')}</p>}
            </div>
          </section>
          <section>
            <header><span><Terminal size={13} /> {t('runtime.executionJobs')}</span><b>{props.executionJobs.length}</b></header>
            <div className="execution-plane-list">
              {props.executionJobs.map(job => {
                const progress = artifactProgress(job.progress_ref)
                const percent = progress?.total_bytes
                  ? Math.min(100, progress.bytes_transferred / progress.total_bytes * 100)
                  : undefined
                return <article key={job.id} className={progress ? 'artifact-transfer-job' : undefined}>
                  <i data-status={job.status} />
                  <span>
                    <strong>{job.tool_name}</strong>
                    <small title={job.id}>{job.target_id} · {job.thread_id}</small>
                    {progress && <span className="artifact-transfer-progress" title={progress.current_entry}>
                      <span><b>{t(`runtime.artifactPhase.${progress.phase}`, { defaultValue: progress.phase })}</b><em>{formatBytes(progress.bytes_transferred)}{progress.total_bytes ? ` / ${formatBytes(progress.total_bytes)}` : ''}{progress.throughput_bytes_per_second ? ` · ${formatBytes(progress.throughput_bytes_per_second)}/s` : ''}</em></span>
                      <i><b style={{ width: `${percent ?? 12}%` }} /></i>
                    </span>}
                  </span>
                  <em>{statusLabel(job.status, t)}</em>
                  {!['succeeded', 'failed', 'cancelled', 'lost'].includes(job.status) && <button type="button" onClick={() => props.onCancelJob(job.id, job.revision)}>{t('runtime.cancel')}</button>}
                </article>
              })}
              {props.executionJobs.length === 0 && <p>{t('runtime.noExecutionJobs')}</p>}
            </div>
          </section>
          <section>
            <header><span><ShieldCheck size={13} /> {t('runtime.capabilityLeases')}</span><b>{props.capabilityLeases.length}</b></header>
            <div className="execution-plane-list">
              {props.capabilityLeases.map(lease => (
                <article key={lease.id}>
                  <i data-status={lease.status} />
                  <span><strong>{lease.capabilities.join(', ') || '—'}</strong><small title={lease.id}>{lease.target_id} · {lease.thread_id}</small></span>
                  <em>{statusLabel(lease.status, t)}</em>
                  {lease.status === 'active' && <button type="button" onClick={() => props.onRevokeLease(lease.id, lease.revision)}>{t('runtime.revoke')}</button>}
                </article>
              ))}
              {props.capabilityLeases.length === 0 && <p>{t('runtime.noCapabilityLeases')}</p>}
            </div>
          </section>
        </div>
      </section>
      <section className="managed-secrets">
        <header>
          <span><ShieldCheck size={16} /><strong>{t('runtime.secrets')}</strong></span>
          <small>{t('runtime.secretsHint')} {props.secretBackendId && <code>{t('runtime.secretBackend')}: {props.secretBackendId}</code>}</small>
        </header>
        <form onSubmit={event => { event.preventDefault(); void submitSecret() }}>
          <input aria-label={t('runtime.secretName')} autoComplete="off" placeholder="SERVICE_API_TOKEN" value={secretName} onChange={event => setSecretName(event.target.value.toUpperCase())} />
          <input aria-label={t('runtime.secretValue')} autoComplete="new-password" placeholder={t('runtime.secretValue')} type="password" value={secretValue} onChange={event => setSecretValue(event.target.value)} />
          <select aria-label={t('runtime.secretScope')} value={scopeKind} onChange={event => setScopeKind(event.target.value)}>
            {['runtime', 'context', 'session', 'objective', 'execution_target'].map(scope => <option key={scope} value={scope}>{t(`runtime.secretScopes.${scope}`)}</option>)}
          </select>
          {scopeKind !== 'runtime' && <input aria-label={t('runtime.scopeId')} placeholder={t('runtime.scopeId')} value={scopeId} onChange={event => setScopeId(event.target.value)} />}
          <button disabled={secretBusy || !secretName.trim() || !secretValue} type="submit">{secretBusy ? t('runtime.saving') : t('runtime.saveSecret')}</button>
        </form>
        {secretError && <p className="managed-secret-error">{secretError}</p>}
        <div className="managed-secret-list">
          {props.managedSecrets.map(secret => <article key={secret.name}>
            <span><strong>{secret.name}</strong><code>{secret.secret_ref}</code></span>
            <small>{t(`runtime.secretScopes.${secret.scope_kind}`)}{secret.scope_id ? ` · ${secret.scope_id}` : ''} · {secret.value_backend}</small>
            <button type="button" onClick={() => void props.onDeleteSecret(secret.name)}>{t('runtime.revoke')}</button>
          </article>)}
          {props.managedSecrets.length === 0 && <p>{t('runtime.noSecrets')}</p>}
        </div>
      </section>
      <div className="runtime-panels">
        <section>
          <header><span>{t('runtime.contextCapacity').toUpperCase()}</span><small>{t('runtime.authoritativeProjection')}</small></header>
          <dl>
            <dt>{t('runtime.pressure')}</dt><dd>{props.pressure}</dd>
            <dt>{t('runtime.estimatedTokens')}</dt><dd>{props.estimatedTokens}</dd>
            <dt>{t('runtime.softLimit')}</dt><dd>{props.softLimit}</dd>
            <dt>{t('runtime.hardLimit')}</dt><dd>{props.hardLimit}</dd>
            <dt>{t('runtime.tokenSource')}</dt><dd>{props.tokenSource}</dd>
          </dl>
        </section>
        <section>
          <header><span>{t('runtime.schedulerCapacity').toUpperCase()}</span><small>{props.schedulerGeneratedAgo}</small></header>
          <dl>
            <dt>{t('runtime.totalSlots')}</dt><dd>{props.totalSlots}</dd>
            <dt>{t('runtime.inFlight')}</dt><dd>{props.inFlight}</dd>
            <dt>{t('runtime.durableQueued')}</dt><dd>{props.durableQueued}</dd>
            <dt>{t('runtime.deferred')}</dt><dd>{props.deferred}</dd>
            <dt>{t('runtime.reservedSlots')}</dt><dd>{props.reservedSlots}</dd>
          </dl>
        </section>
        <section>
          <header><span>{t('runtime.host').toUpperCase()}</span><small>{t('runtime.hostHint')}</small></header>
          <dl>
            <dt>{t('runtime.version')}</dt><dd>{props.version}</dd>
            <dt>{t('runtime.uptime')}</dt><dd>{t('runtime.uptimeSeconds', { count: props.uptimeSeconds })}</dd>
            <dt>{t('runtime.storage')}</dt><dd>{props.storage}</dd>
            <dt>{t('runtime.sandbox')}</dt><dd>{props.sandbox}</dd>
            <dt>{t('runtime.identity')}</dt><dd>{props.identity}</dd>
          </dl>
        </section>
        <section>
          <header><span>{t('runtime.recovery').toUpperCase()}</span><small>{props.recovery.completed_at ?? t('runtime.notStarted')}</small></header>
          <dl>
            <dt>{t('runtime.recoveryPreserved')}</dt><dd>{props.recovery.preserved_execution_jobs}</dd>
            <dt>{t('runtime.recoveryRequeued')}</dt><dd>{props.recovery.requeued_execution_jobs}</dd>
            <dt>{t('runtime.recoveryLost')}</dt><dd>{props.recovery.lost_execution_jobs}</dd>
            <dt>{t('runtime.recoveryOutboxes')}</dt><dd>{props.recovery.recovered_background_outboxes}</dd>
          </dl>
        </section>
      </div>
      <details className="runtime-diagnostics">
        <summary>{t('runtime.kernelDiagnostics')}</summary>
        <div>
          <section><header>{t('runtime.eventWriter')}</header><pre>{JSON.stringify(props.eventWriter, null, 2)}</pre></section>
          <section><header>{t('runtime.modelProviderMetrics')}</header><pre>{JSON.stringify(props.modelProvider, null, 2)}</pre></section>
          <section><header>{t('runtime.contextCapacityMetrics')}</header><pre>{JSON.stringify(props.contextCapacity, null, 2)}</pre></section>
        </div>
      </details>
      <section className={`projection-audit ${props.projectionAudit?.matches === false ? 'failed' : ''}`}>
        <header>
          <span>
            {props.projectionAudit?.matches === false ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}
            <strong>{t('runtime.projectionAudit')}</strong>
            <small>{t('runtime.projectionAuditHint')}</small>
          </span>
          <button type="button" disabled={props.auditingProjection} onClick={props.onAuditProjection}>
            <RefreshCw className={props.auditingProjection ? 'spin' : ''} size={13} />
            {props.auditingProjection ? t('runtime.auditingProjection') : t('runtime.runProjectionAudit')}
          </button>
        </header>
        {props.projectionAudit ? (
          <dl>
            <dt>{t('runtime.auditResult')}</dt><dd>{props.projectionAudit.matches ? t('runtime.auditMatches') : t('runtime.auditMismatch')}</dd>
            <dt>{t('runtime.auditRevisions')}</dt><dd>Ledger r{props.projectionAudit.ledger_revision} · Projection r{props.projectionAudit.projection_revision ?? '—'} · Snapshot r{props.projectionAudit.snapshot_revision ?? '—'}</dd>
            <dt>{t('runtime.auditScanned')}</dt><dd>{props.projectionAudit.events_scanned} / {props.projectionAudit.incremental_transactions_scanned ?? '—'}</dd>
            <dt>{t('runtime.auditLatency')}</dt><dd>{props.projectionAudit.full_replay_micros} / {props.projectionAudit.incremental_replay_micros ?? '—'} / {props.projectionAudit.projection_validation_micros} μs</dd>
          </dl>
        ) : <p>{t('runtime.projectionAuditNotRun')}</p>}
      </section>
      <div className="runtime-boundary-note"><Database size={16} /><span><strong>{t('runtime.boundaryTitle')}</strong><small>{t('runtime.boundaryDescription')}</small></span></div>
    </section>
  )
}
