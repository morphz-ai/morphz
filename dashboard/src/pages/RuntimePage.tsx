import { useState } from 'react'
import { Brain, CheckCircle2, ChevronDown, Clock3, Database, GitBranch, KeyRound, Layers3, Pencil, Radio, RefreshCw, Save, Server, ShieldCheck, Terminal, Trash2, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { statusLabel } from '../app/presentation'
import { RuntimeMonitor } from './RuntimeMonitor'
import type { RuntimeOverview, RuntimeOverviewObjective, RuntimeOverviewThread } from './RuntimeOverviewPage'

export interface CapabilityDeltaSummary {
  network: boolean
  read_roots: string[]
  write_roots: string[]
  secret_env: string[]
}

export interface CapabilityLeaseSummary {
  id: string
  revision: number
  principal_id: string
  agent_id: string
  scope: 'thread' | 'session'
  session_id: string
  thread_id: string
  target_id: string
  capabilities: string[]
  requested: CapabilityDeltaSummary
  status: string
  issued_at: string
  expires_at: string
}

interface RuntimePageProps {
  overview: RuntimeOverview | null
  overviewLoading: boolean
  overviewError: string
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
    replayed_event_revision: number
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
  capabilityLeases: CapabilityLeaseSummary[]
  executionJobs: Array<{ id: string; revision: number; thread_id: string; target_id: string; tool_name: string; status: string; claimed_by?: string; progress_ref?: string; created_at: string }>
  onRefresh: () => void
  onRefreshOverview: () => void
  onOpenSession: (contextId: string, sessionId: string) => void
  onOpenThread: (contextId: string, threadId: string) => void
  onThreadControl: (contextId: string, thread: RuntimeOverviewThread, action: 'pause' | 'resume' | 'cancel') => void
  onThreadSupersede: (contextId: string, thread: RuntimeOverviewThread) => void
  onObjectiveControl: (objective: RuntimeOverviewObjective, action: 'pause' | 'resume' | 'cancel') => void
  onDelegationCancel: (delegationId: string, task: string) => void
  mutatingThreadId: string
  mutatingObjectiveId: string
  mutatingDelegationId: string
  onOpenCredentials: () => void
  onAuditProjection: () => void
  onSetTargetStatus: (targetId: string, revision: number, status: 'online' | 'disabled') => void
  onRevokeNode: (nodeId: string, revision: number) => void
  onRevokeLease: (leaseId: string, revision: number) => void
  onRestrictLease: (leaseId: string, revision: number, requested: CapabilityDeltaSummary, expiresAt: string) => Promise<boolean>
  onCancelJob: (jobId: string, revision: number) => void
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

function localDateTimeValue(iso: string) {
  const date = new Date(iso)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 19)
}

function AuthorizationRule({
  lease,
  onRestrict,
  onRevoke,
}: {
  lease: CapabilityLeaseSummary
  onRestrict: RuntimePageProps['onRestrictLease']
  onRevoke: RuntimePageProps['onRevokeLease']
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [network, setNetwork] = useState(lease.requested.network)
  const [readRoots, setReadRoots] = useState(() => new Set(lease.requested.read_roots))
  const [writeRoots, setWriteRoots] = useState(() => new Set(lease.requested.write_roots))
  const [secretEnv, setSecretEnv] = useState(() => new Set(lease.requested.secret_env))
  const [expiresAt, setExpiresAt] = useState(() => localDateTimeValue(lease.expires_at))
  const [minimumExpiry] = useState(() => localDateTimeValue(new Date(Date.now() + 60_000).toISOString()))
  const permissionCount = Number(network) + readRoots.size + writeRoots.size + secretEnv.size
  const permissions = [
    ...(lease.requested.network ? [t('runtime.authorizationNetwork')] : []),
    ...lease.requested.read_roots.map(path => t('runtime.authorizationRead', { path })),
    ...lease.requested.write_roots.map(path => t('runtime.authorizationWrite', { path })),
    ...lease.requested.secret_env.map(name => t('runtime.authorizationSecret', { name })),
  ]
  const toggleSet = (current: Set<string>, value: string, setter: (next: Set<string>) => void) => {
    const next = new Set(current)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }
  const save = async () => {
    if (permissionCount === 0 || saving) return
    setSaving(true)
    const saved = await onRestrict(
      lease.id,
      lease.revision,
      {
        network,
        read_roots: [...readRoots],
        write_roots: [...writeRoots],
        secret_env: [...secretEnv],
      },
      new Date(expiresAt).toISOString(),
    )
    setSaving(false)
    if (saved) setEditing(false)
  }
  return <article className="authorization-rule">
    <i data-status={lease.status} />
    <div className="authorization-rule-body">
      <header>
        <strong>{lease.capabilities.join(', ') || '—'}</strong>
        <span>{t(`runtime.authorizationScope.${lease.scope}`)}</span>
      </header>
      <small title={lease.id}>{lease.target_id} · {lease.scope === 'session' ? lease.session_id : lease.thread_id}</small>
      <div className="authorization-rule-permissions">
        {permissions.map(permission => <code key={permission}>{permission}</code>)}
      </div>
      <em><Clock3 size={11} /> {t('runtime.authorizationExpires', { value: new Date(lease.expires_at).toLocaleString() })}</em>
      {editing && <div className="authorization-rule-editor">
        <p>{t('runtime.authorizationAdjustHint')}</p>
        <div className="authorization-rule-checks">
          {lease.requested.network && <label><input type="checkbox" checked={network} onChange={event => setNetwork(event.target.checked)} /> {t('runtime.authorizationNetwork')}</label>}
          {lease.requested.read_roots.map(path => <label key={`read:${path}`}><input type="checkbox" checked={readRoots.has(path)} onChange={() => toggleSet(readRoots, path, setReadRoots)} /> {t('runtime.authorizationRead', { path })}</label>)}
          {lease.requested.write_roots.map(path => <label key={`write:${path}`}><input type="checkbox" checked={writeRoots.has(path)} onChange={() => toggleSet(writeRoots, path, setWriteRoots)} /> {t('runtime.authorizationWrite', { path })}</label>)}
          {lease.requested.secret_env.map(name => <label key={`secret:${name}`}><input type="checkbox" checked={secretEnv.has(name)} onChange={() => toggleSet(secretEnv, name, setSecretEnv)} /> {t('runtime.authorizationSecret', { name })}</label>)}
        </div>
        <label className="authorization-rule-expiry"><span>{t('runtime.authorizationExpiry')}</span><input type="datetime-local" step="1" min={minimumExpiry} max={localDateTimeValue(lease.expires_at)} value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label>
        {permissionCount === 0 && <strong className="authorization-rule-warning">{t('runtime.authorizationEmptyHint')}</strong>}
        <footer>
          <button type="button" disabled={saving || permissionCount === 0 || !expiresAt} onClick={() => void save()}><Save size={12} /> {saving ? t('runtime.saving') : t('runtime.saveRule')}</button>
          <button type="button" onClick={() => setEditing(false)}><X size={12} /> {t('runtime.cancel')}</button>
        </footer>
      </div>}
    </div>
    <div className="authorization-rule-actions">
      <button type="button" onClick={() => setEditing(current => !current)}><Pencil size={12} /> {t('runtime.adjustRule')}</button>
      <button type="button" className="danger" onClick={() => onRevoke(lease.id, lease.revision)}><Trash2 size={12} /> {t('runtime.deleteRule')}</button>
    </div>
  </article>
}

export function RuntimePage(props: RuntimePageProps) {
  const { t } = useTranslation()
  return (
    <section className="runtime-view">
      <header className="workspace-heading">
        <div><span>{t('runtime.eyebrow').toUpperCase()}</span><h1>{t('runtime.heading')}</h1><p>{t('runtime.description')}</p></div>
      </header>
      <RuntimeMonitor
        overview={props.overview}
        loading={props.overviewLoading}
        error={props.overviewError}
        onRefresh={props.onRefreshOverview}
        onOpenSession={props.onOpenSession}
        onOpenThread={props.onOpenThread}
        onThreadControl={props.onThreadControl}
        onThreadSupersede={props.onThreadSupersede}
        onObjectiveControl={props.onObjectiveControl}
        onDelegationCancel={props.onDelegationCancel}
        mutatingThreadId={props.mutatingThreadId}
        mutatingObjectiveId={props.mutatingObjectiveId}
        mutatingDelegationId={props.mutatingDelegationId}
      />
      <details className="runtime-infrastructure">
        <summary><Server size={14} /><span><strong>{t('runtime.infrastructure')}</strong><small>{t('runtime.infrastructureHint')}</small></span><ChevronDown size={14} /></summary>
        <div>
      <div className="runtime-infrastructure-toolbar">
        <button type="button" onClick={props.onRefresh}><RefreshCw size={13} /> {t('runtime.refresh')}</button>
      </div>
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
          <section className="authorization-rules-panel">
            <header><span><ShieldCheck size={13} /> {t('runtime.capabilityLeases')}</span><b>{props.capabilityLeases.length}</b></header>
            <p className="authorization-rules-hint">{t('runtime.authorizationRulesHint')}</p>
            <div className="execution-plane-list authorization-rules-list">
              {props.capabilityLeases.map(lease => <AuthorizationRule key={`${lease.id}:${lease.revision}`} lease={lease} onRestrict={props.onRestrictLease} onRevoke={props.onRevokeLease} />)}
              {props.capabilityLeases.length === 0 && <p>{t('runtime.noCapabilityLeases')}</p>}
            </div>
          </section>
        </div>
      </section>
      <section className="runtime-credential-entry">
        <header>
          <span><ShieldCheck size={16} /><strong>{t('runtime.secrets')}</strong></span>
          <small>{t('runtime.secretsHint')}</small>
        </header>
        <button type="button" onClick={props.onOpenCredentials}>
          <KeyRound size={14} /> {t('runtime.openCredentials')}
        </button>
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
            <dt>{t('runtime.auditRevisions')}</dt><dd>Event Replay r{props.projectionAudit.replayed_event_revision} · Projection r{props.projectionAudit.projection_revision ?? '—'} · Snapshot r{props.projectionAudit.snapshot_revision ?? '—'}</dd>
            <dt>{t('runtime.auditScanned')}</dt><dd>{props.projectionAudit.events_scanned} / {props.projectionAudit.incremental_transactions_scanned ?? '—'}</dd>
            <dt>{t('runtime.auditLatency')}</dt><dd>{props.projectionAudit.full_replay_micros} / {props.projectionAudit.incremental_replay_micros ?? '—'} / {props.projectionAudit.projection_validation_micros} μs</dd>
          </dl>
        ) : <p>{t('runtime.projectionAuditNotRun')}</p>}
      </section>
      <div className="runtime-boundary-note"><Database size={16} /><span><strong>{t('runtime.boundaryTitle')}</strong><small>{t('runtime.boundaryDescription')}</small></span></div>
        </div>
      </details>
    </section>
  )
}
