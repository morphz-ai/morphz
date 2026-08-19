import {
  AlertCircle,
  ChevronDown,
  CircleDot,
  Clock3,
  GitBranch,
  Layers3,
  MessageSquare,
  RefreshCw,
  Search,
  Terminal,
  UserRound,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  runtimeMonitorCounts,
  runtimeMonitorSessions,
  type RuntimeMonitorFilter,
} from '../runtimeMonitor'
import type {
  RuntimeOverview,
  RuntimeOverviewExecutionJob,
  RuntimeOverviewObjective,
  RuntimeOverviewSessionState,
  RuntimeOverviewThread,
} from './RuntimeOverviewPage'

interface RuntimeMonitorProps {
  overview: RuntimeOverview | null
  loading: boolean
  error: string
  onRefresh: () => void
  onOpenSession: (contextId: string, sessionId: string) => void
  onOpenThread: (contextId: string, threadId: string) => void
}

function shortId(value: string, size = 12) {
  return value.length <= size ? value : `…${value.slice(-size)}`
}

function stateIcon(state: RuntimeOverviewSessionState) {
  if (state === 'needs_attention') return <AlertCircle size={12} />
  if (state === 'waiting_user') return <MessageSquare size={12} />
  if (state === 'waiting' || state === 'paused') return <Clock3 size={12} />
  return <CircleDot size={12} />
}

function formatClock(timestamp: string, language: string) {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

function WaitCondition({ objective }: { objective: RuntimeOverviewObjective }) {
  const { t, i18n } = useTranslation()
  const wait = objective.wait_condition
  if (!wait?.kind) return null
  const reference = Object.entries(wait).find(([key]) => key !== 'kind')
  const rawValue = reference?.[1]
  const value = wait.kind === 'timer' && typeof rawValue === 'string'
    ? new Intl.DateTimeFormat(i18n.language, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(rawValue))
    : typeof rawValue === 'string' ? shortId(rawValue, 18) : undefined
  return (
    <span className="runtime-monitor-wait" title={typeof rawValue === 'string' ? rawValue : undefined}>
      <Clock3 size={10} />
      {t(`runtimeMonitor.waitKinds.${wait.kind}`, { defaultValue: wait.kind })}
      {value && <code>{value}</code>}
    </span>
  )
}

function ExecutionJobRow({ job }: { job: RuntimeOverviewExecutionJob }) {
  const { t, i18n } = useTranslation()
  return (
    <div className="runtime-monitor-job">
      <i data-status={job.status} />
      <Terminal size={11} />
      <span>
        <strong>{job.tool_name}</strong>
        <code title={job.id}>{shortId(job.id, 16)}</code>
      </span>
      <em title={job.target_id}>{shortId(job.target_id, 18)}</em>
      <b>{t(`runtimeMonitor.jobStates.${job.status}`, { defaultValue: job.status })}</b>
      {(job.checkpoint_due_at || job.checkpoint_generation != null) && (
        <span className="runtime-monitor-wait" title={job.checkpoint_due_at}>
          <Clock3 size={10} />
          {job.checkpoint_generation != null && (
            <code>{t('runtimeMonitor.checkpointGeneration', { generation: job.checkpoint_generation })}</code>
          )}
          {job.checkpoint_due_at && (
            <time dateTime={job.checkpoint_due_at}>{formatClock(job.checkpoint_due_at, i18n.language)}</time>
          )}
        </span>
      )}
    </div>
  )
}

function ThreadRow({
  contextId,
  thread,
  onOpen,
}: {
  contextId: string
  thread: RuntimeOverviewThread
  onOpen: (contextId: string, threadId: string) => void
}) {
  const { t, i18n } = useTranslation()
  return (
    <details className={`runtime-monitor-thread state-${thread.state}`}>
      <summary>
        <span className={`runtime-monitor-state state-${thread.state}`}>
          {stateIcon(thread.state)}
          {t(`runtimeMonitor.states.${thread.state}`)}
        </span>
        <GitBranch size={12} />
        <strong>{t(`runtimeOverview.threadKinds.${thread.kind}`, { defaultValue: thread.kind })}</strong>
        <code title={thread.id}>{shortId(thread.id)}</code>
        {thread.target_id && <em title={thread.target_id}>{shortId(thread.target_id, 16)}</em>}
        <time dateTime={thread.updated_at}>{formatClock(thread.updated_at, i18n.language)}</time>
        <ChevronDown size={12} />
      </summary>
      <div className="runtime-monitor-thread-detail">
        {thread.activations.map(activation => (
          <div className="runtime-monitor-activation" key={activation.id}>
            <i data-status={activation.status} />
            <span>
              <small>{t('runtimeMonitor.activation')}</small>
              <code title={activation.id}>{shortId(activation.id, 16)}</code>
            </span>
            <em>{activation.trigger_kind}</em>
            <b>{t(`runtimeMonitor.activationStates.${activation.status}`, { defaultValue: activation.status })}</b>
          </div>
        ))}
        {thread.execution_jobs.map(job => <ExecutionJobRow key={job.id} job={job} />)}
        {thread.activations.length === 0 && thread.execution_jobs.length === 0 && (
          <p>{t('runtimeMonitor.threadWaiting')}</p>
        )}
        <button type="button" onClick={() => onOpen(contextId, thread.id)}>
          {t('runtimeMonitor.openThread')}
        </button>
      </div>
    </details>
  )
}

function ObjectiveBlock({
  contextId,
  objective,
  threads,
  onOpenThread,
}: {
  contextId: string
  objective: RuntimeOverviewObjective
  threads: RuntimeOverviewThread[]
  onOpenThread: (contextId: string, threadId: string) => void
}) {
  const { t, i18n } = useTranslation()
  return (
    <section className={`runtime-monitor-objective state-${objective.state}`}>
      <header>
        <span className={`runtime-monitor-state state-${objective.state}`}>
          {stateIcon(objective.state)}
          {t(`runtimeMonitor.states.${objective.state}`)}
        </span>
        <Layers3 size={12} />
        <strong>{objective.stated_objective}</strong>
        <code title={objective.id}>{shortId(objective.id)}</code>
        <time dateTime={objective.updated_at}>{formatClock(objective.updated_at, i18n.language)}</time>
      </header>
      <div className="runtime-monitor-objective-meta">
        <WaitCondition objective={objective} />
        {objective.status_reason && <span title={objective.status_reason}>{objective.status_reason}</span>}
      </div>
      <div className="runtime-monitor-thread-list">
        {threads.map(thread => (
          <ThreadRow key={thread.id} contextId={contextId} thread={thread} onOpen={onOpenThread} />
        ))}
        {threads.length === 0 && <p>{t('runtimeMonitor.objectiveWithoutThread')}</p>}
      </div>
    </section>
  )
}

export function RuntimeMonitor({
  overview,
  loading,
  error,
  onRefresh,
  onOpenSession,
  onOpenThread,
}: RuntimeMonitorProps) {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState<RuntimeMonitorFilter>('live')
  const [query, setQuery] = useState('')
  const counts = useMemo(() => runtimeMonitorCounts(overview), [overview])
  const visible = useMemo(
    () => runtimeMonitorSessions(overview, filter, query),
    [filter, overview, query],
  )

  return (
    <section className="runtime-monitor" aria-label={t('runtimeMonitor.title')}>
      <header className="runtime-monitor-heading">
        <div>
          <span>{t('runtimeMonitor.eyebrow')}</span>
          <h2>{t('runtimeMonitor.title')}</h2>
          <p>{t('runtimeMonitor.description')}</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? 'is-spinning' : ''} size={13} />
          {t('runtimeMonitor.refresh')}
        </button>
      </header>

      <div className="runtime-monitor-summary">
        {(['live', 'running', 'waiting', 'attention'] as RuntimeMonitorFilter[]).map(value => (
          <button
            className={`${filter === value ? 'is-active' : ''} ${value === 'attention' && counts.attention > 0 ? 'has-attention' : ''}`}
            key={value}
            type="button"
            onClick={() => setFilter(value)}
          >
            <small>{t(`runtimeMonitor.filters.${value}`)}</small>
            <strong>{counts[value]}</strong>
          </button>
        ))}
        <span>
          <small>{t('runtimeMonitor.physicalWork')}</small>
          <strong>{overview?.summary.running_activations ?? 0}</strong>
          <em>{t('runtimeMonitor.activations')}</em>
          <strong>{overview?.summary.active_execution_jobs ?? 0}</strong>
          <em>{t('runtimeMonitor.jobs')}</em>
        </span>
      </div>

      <div className="runtime-monitor-toolbar">
        <label>
          <Search size={14} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('runtimeMonitor.search')} />
        </label>
        {overview && <time dateTime={overview.generated_at}>{t('runtimeMonitor.snapshotAt', { time: formatClock(overview.generated_at, i18n.language) })}</time>}
      </div>

      {error && <div className="runtime-monitor-error"><AlertCircle size={14} />{error}</div>}
      {!overview && loading && <div className="runtime-monitor-loading"><RefreshCw className="is-spinning" size={15} />{t('runtimeMonitor.loading')}</div>}
      {overview && visible.length === 0 && (
        <div className="runtime-monitor-empty">
          <CircleDot size={18} />
          <strong>{t('runtimeMonitor.empty')}</strong>
          <span>{t('runtimeMonitor.emptyHint')}</span>
        </div>
      )}
      {visible.length > 0 && (
        <div className="runtime-monitor-list">
          {visible.map(({ context, session }) => {
            const ownedObjectives = session.objectives.filter(objective => objective.coordinator_session_id === session.session.id)
            const objectiveIds = new Set(ownedObjectives.map(objective => objective.id))
            const standaloneThreads = session.threads.filter(thread => !thread.objective_id || !objectiveIds.has(thread.objective_id))
            const threadedJobIds = new Set(session.threads.flatMap(thread => thread.execution_jobs.map(job => job.id)))
            const sessionJobs = (session.execution_jobs ?? []).filter(job => !threadedJobIds.has(job.id))
            return (
              <article className={`runtime-monitor-session state-${session.state}`} key={session.session.id}>
                <header>
                  <span className={`runtime-monitor-state state-${session.state}`}>
                    {stateIcon(session.state)}
                    {t(`runtimeMonitor.states.${session.state}`)}
                  </span>
                  <MessageSquare size={12} />
                  <button type="button" onClick={() => onOpenSession(context.context.id, session.session.id)}>
                    <strong>{session.session.title}</strong>
                    <small>{context.context.title}</small>
                  </button>
                  {session.principal_ids[0] && <em title={session.principal_ids.join(', ')}><UserRound size={10} />{session.principal_ids[0]}</em>}
                  <span className="runtime-monitor-session-counts">
                    {t('runtimeMonitor.sessionCounts', {
                      objectives: ownedObjectives.length,
                      threads: session.threads.length,
                      jobs: session.active_execution_job_count,
                    })}
                  </span>
                </header>
                <div className="runtime-monitor-session-body">
                  {sessionJobs.length > 0 && (
                    <section className="runtime-monitor-standalone runtime-monitor-session-jobs">
                      <header><Terminal size={12} /><strong>{t('runtimeMonitor.sessionJobs')}</strong></header>
                      <div className="runtime-monitor-thread-detail">
                        {sessionJobs.map(job => <ExecutionJobRow key={job.id} job={job} />)}
                      </div>
                    </section>
                  )}
                  {ownedObjectives.map(objective => (
                    <ObjectiveBlock
                      key={objective.id}
                      contextId={context.context.id}
                      objective={objective}
                      threads={session.threads.filter(thread => thread.objective_id === objective.id)}
                      onOpenThread={onOpenThread}
                    />
                  ))}
                  {standaloneThreads.length > 0 && (
                    <section className="runtime-monitor-standalone">
                      <header><GitBranch size={12} /><strong>{t('runtimeMonitor.standaloneThreads')}</strong></header>
                      {standaloneThreads.map(thread => (
                        <ThreadRow key={thread.id} contextId={context.context.id} thread={thread} onOpen={onOpenThread} />
                      ))}
                    </section>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
      {(overview?.has_more_contexts || overview?.contexts.some(context => context.hidden_session_count > 0)) && (
        <p className="runtime-monitor-bounded">{t('runtimeMonitor.bounded')}</p>
      )}
    </section>
  )
}
