import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  GitBranch,
  Layers3,
  MessageSquare,
  Network,
  Bot,
  LockKeyhole,
  RefreshCw,
  Search,
  Share2,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { shortId } from '../app/presentation'
import { resolveSelectedModelOption } from '../app/modelSelection'

export type RuntimeOverviewSessionState =
  | 'needs_attention'
  | 'waiting_user'
  | 'running'
  | 'queued'
  | 'paused'
  | 'waiting'
  | 'idle'

export interface RuntimeOverviewThread {
  intent?: string | null
  id: string
  revision: number
  generation: number
  kind: string
  lifecycle: string
  phase: string
  state: RuntimeOverviewSessionState
  control_state: string
  supervision: {
    lifetime: string
    supervisor_kind: string
    supervisor_id?: string
    generation: number
    origin_evaluation_id?: string
    parent_thread_id?: string
    thread_group_id?: string
    completion_contract?: unknown
  }
  objective_id?: string
  target_id?: string
  activations: RuntimeOverviewActivation[]
  execution_jobs: RuntimeOverviewExecutionJob[]
  updated_at: string
}

export interface RuntimeOverviewActivation {
  id: string
  status: string
  trigger_kind: string
  parent_activation_id?: string
  updated_at: string
}

export interface RuntimeOverviewExecutionJob {
  id: string
  activation_id: string
  thread_id: string
  status: string
  tool_name: string
  target_id: string
  progress_ref?: string
  error?: string
  updated_at: string
  checkpoint_generation?: number
  checkpoint_due_at?: string
}

export interface RuntimeOverviewObjective {
  id: string
  coordinator_session_id: string
  delivery_session_id: string
  stated_objective: string
  status: string
  state: RuntimeOverviewSessionState
  status_reason?: string
  wait_condition?: { kind?: string; [key: string]: unknown }
  revision: number
  updated_at: string
}

export interface RuntimeOverviewSession {
  session: {
    id: string
    agent_id: string
    context_id: string
    title: string
    status: string
    model_alias?: string | null
    context_sharing?: 'shared' | 'isolated'
    last_activity_at: string
  }
  principal_ids: string[]
  state: RuntimeOverviewSessionState
  attention_required: boolean
  pending_dialogue_turns: number
  open_thread_count: number
  running_activation_count: number
  active_execution_job_count: number
  objectives: RuntimeOverviewObjective[]
  threads: RuntimeOverviewThread[]
  execution_jobs?: RuntimeOverviewExecutionJob[]
  current_thread?: RuntimeOverviewThread
  current_objective?: RuntimeOverviewObjective
}

export interface RuntimeOverviewContext {
  context: {
    id: string
    agent_id: string
    title: string
    status: string
  }
  mind_revision?: number
  delegation?: {
    id: string
    parent_context_id: string
    parent_session_id: string
    child_session_id: string
    task: string
    status: string
  }
  active_session_count: number
  total_session_count: number
  hidden_session_count: number
  objective_count: number
  open_thread_count: number
  running_activation_count: number
  active_execution_job_count: number
  attention_count: number
  last_activity_at: string
  sessions: RuntimeOverviewSession[]
}

export interface RuntimeOverview {
  generated_at: string
  summary: {
    contexts: number
    active_sessions: number
    total_sessions: number
    objectives: number
    open_threads: number
    running_activations: number
    active_execution_jobs: number
    waiting: number
    queued: number
    paused: number
    attention_required: number
  }
  contexts: RuntimeOverviewContext[]
  has_more_contexts: boolean
}

type RuntimeOverviewFilter = 'all' | 'attention' | 'active' | 'idle'

export interface RuntimeOverviewModelOption {
  id: string
  label: string
  aliases?: string[]
}

interface RuntimeOverviewPageProps {
  overview: RuntimeOverview | null
  loading: boolean
  error: string
  onRefresh: () => void
  onOpenContext: (contextId: string) => void
  onOpenSession: (contextId: string, sessionId: string) => void
  onExpandSessions: (contextId: string) => Promise<void>
  modelOptions: RuntimeOverviewModelOption[]
  runtimeDefaultModel: string
  onChangeSessionModel: (sessionId: string, model: string) => Promise<void>
  onChangeSessionContextSharing: (
    sessionId: string,
    sharing: 'shared' | 'isolated',
  ) => Promise<void>
}

function ago(timestamp: string, language: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime())
  const minutes = Math.floor(elapsed / 60_000)
  const isChinese = language.toLowerCase().startsWith('zh')
  if (minutes < 1) return isChinese ? '刚刚' : 'now'
  if (minutes < 60) return isChinese ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return isChinese ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  return isChinese ? `${days} 天前` : `${days}d ago`
}

function matchesQuery(context: RuntimeOverviewContext, query: string): boolean {
  if (!query) return true
  const values = [
    context.context.id,
    context.context.title,
    context.context.agent_id,
    context.delegation?.task,
    ...context.sessions.flatMap(session => [
      session.session.id,
      session.session.title,
      ...session.principal_ids,
      session.current_objective?.id,
      session.current_objective?.stated_objective,
      session.current_thread?.id,
      session.session.model_alias,
    ]),
  ]
  return values.some(value => value?.toLocaleLowerCase().includes(query))
}

function matchesFilter(context: RuntimeOverviewContext, filter: RuntimeOverviewFilter): boolean {
  if (filter === 'attention') return context.attention_count > 0
  if (filter === 'active') {
    return context.running_activation_count > 0
      || context.sessions.some(session => session.state === 'running' || session.state === 'queued')
  }
  if (filter === 'idle') {
    return context.attention_count === 0
      && context.running_activation_count === 0
      && context.sessions.every(session => session.state === 'idle')
  }
  return true
}

function stateIcon(state: RuntimeOverviewSessionState) {
  if (state === 'needs_attention') return <AlertCircle size={13} />
  if (state === 'waiting_user') return <MessageSquare size={13} />
  if (state === 'running' || state === 'queued') return <CircleDot size={13} />
  if (state === 'waiting' || state === 'paused') return <Clock3 size={13} />
  return <CircleDot size={12} />
}

function SessionCard({
  item,
  language,
  onOpen,
  modelOptions,
  runtimeDefaultModel,
  changingModel,
  modelError,
  onChangeModel,
  changingContextSharing,
  contextSharingError,
  onChangeContextSharing,
}: {
  item: RuntimeOverviewSession
  language: string
  onOpen: () => void
  modelOptions: RuntimeOverviewModelOption[]
  runtimeDefaultModel: string
  changingModel: boolean
  modelError: string
  onChangeModel: (model: string) => Promise<void>
  changingContextSharing: boolean
  contextSharingError: string
  onChangeContextSharing: (sharing: 'shared' | 'isolated') => Promise<void>
}) {
  const { t } = useTranslation()
  const principal = item.principal_ids[0]
  const explicitModel = item.session.model_alias?.trim() ?? ''
  const selectedModel = resolveSelectedModelOption(modelOptions, explicitModel || runtimeDefaultModel)
  const currentModelLabel = selectedModel?.label || explicitModel || runtimeDefaultModel || t('model.unavailable')
  const isolated = item.session.context_sharing === 'isolated'
  return (
    <article className={`runtime-overview-session state-${item.state}`}>
      <button className="runtime-overview-session-open" type="button" onClick={onOpen}>
        <header>
          <span className={`runtime-overview-state state-${item.state}`}>
            {stateIcon(item.state)}
            {t(`runtimeOverview.states.${item.state}`)}
          </span>
          <time dateTime={item.session.last_activity_at}>{ago(item.session.last_activity_at, language)}</time>
        </header>
        <div className="runtime-overview-session-title">
          <MessageSquare size={12} />
          <strong>{item.session.title}</strong>
          <ChevronRight size={11} />
        </div>
        {principal && (
          <p className="runtime-overview-principal" title={item.principal_ids.join(', ')}>
            <UserRound size={10} />
            <span>{principal}</span>
            {item.principal_ids.length > 1 && <em>+{item.principal_ids.length - 1}</em>}
          </p>
        )}
        {item.current_objective && (
          <p className="runtime-overview-current objective" title={item.current_objective.stated_objective}>
            <Layers3 size={10} />
            <span>{item.current_objective.stated_objective}</span>
          </p>
        )}
        {item.current_thread && (
          <p className="runtime-overview-current thread" title={item.current_thread.id}>
            <GitBranch size={10} />
            <span>{t(`runtimeOverview.threadKinds.${item.current_thread.kind}`, { defaultValue: item.current_thread.kind })}</span>
            <code>{shortId(item.current_thread.id)}</code>
          </p>
        )}
        <footer>
          <span>{t('runtimeOverview.sessionMetrics.threads', { count: item.open_thread_count })}</span>
          <span>{t('runtimeOverview.sessionMetrics.activations', { count: item.running_activation_count })}</span>
          {item.pending_dialogue_turns > 0 && (
            <span className="is-queued">{t('runtimeOverview.sessionMetrics.queuedMessages', { count: item.pending_dialogue_turns })}</span>
          )}
        </footer>
      </button>
      <div
        className={`runtime-overview-session-model ${explicitModel ? 'is-bound' : 'is-inherited'}`}
        title={t(explicitModel ? 'runtimeOverview.model.boundHint' : 'runtimeOverview.model.inheritedHint')}
        onClick={event => event.stopPropagation()}
      >
        <Bot size={11} />
        <span>
          <small>{t(explicitModel ? 'runtimeOverview.model.bound' : 'runtimeOverview.model.inherited')}</small>
          <strong>{currentModelLabel}</strong>
        </span>
        <select
          aria-label={t('runtimeOverview.model.selector', { session: item.session.title })}
          disabled={changingModel || modelOptions.length === 0}
          value={explicitModel || '__runtime__'}
          onChange={event => void onChangeModel(event.target.value)}
        >
          <option value="__runtime__">{t('model.runtimeDefault', { model: runtimeDefaultModel || '—' })}</option>
          {explicitModel && !resolveSelectedModelOption(modelOptions, explicitModel) && (
            <option value={explicitModel} disabled>{explicitModel} · {t('model.unavailable')}</option>
          )}
          {modelOptions.map(option => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        {changingModel && <RefreshCw className="is-spinning" size={11} />}
        {modelError && <em title={modelError}><AlertCircle size={11} />{t('runtimeOverview.model.saveFailed')}</em>}
      </div>
      <button
        className={`runtime-overview-session-sharing ${isolated ? 'is-isolated' : 'is-shared'}`}
        type="button"
        disabled={changingContextSharing}
        title={t(isolated
          ? 'runtimeOverview.contextSharing.isolatedHint'
          : 'runtimeOverview.contextSharing.sharedHint')}
        aria-label={t('runtimeOverview.contextSharing.selector', { session: item.session.title })}
        onClick={() => void onChangeContextSharing(isolated ? 'shared' : 'isolated')}
      >
        {isolated ? <LockKeyhole size={11} /> : <Share2 size={11} />}
        <span>{t(isolated
          ? 'runtimeOverview.contextSharing.isolated'
          : 'runtimeOverview.contextSharing.shared')}</span>
        <small>{t(isolated
          ? 'runtimeOverview.contextSharing.enableSharing'
          : 'runtimeOverview.contextSharing.makeIsolated')}</small>
        {changingContextSharing && <RefreshCw className="is-spinning" size={11} />}
        {contextSharingError && (
          <em title={contextSharingError}>
            <AlertCircle size={11} />{t('runtimeOverview.contextSharing.saveFailed')}
          </em>
        )}
      </button>
    </article>
  )
}

function ContextGroup({
  item,
  children,
  collapsed,
  language,
  onToggleContext,
  onOpenContext,
  onOpenSession,
  onExpandSessions,
  modelOptions,
  runtimeDefaultModel,
  changingModelSessionIds,
  modelErrors,
  onChangeSessionModel,
  changingContextSharingSessionIds,
  contextSharingErrors,
  onChangeSessionContextSharing,
  revealChildren = false,
}: {
  item: RuntimeOverviewContext
  children: RuntimeOverviewContext[]
  collapsed: Set<string>
  language: string
  onToggleContext: (contextId: string) => void
  onOpenContext: (contextId: string) => void
  onOpenSession: (contextId: string, sessionId: string) => void
  onExpandSessions: (contextId: string) => Promise<void>
  modelOptions: RuntimeOverviewModelOption[]
  runtimeDefaultModel: string
  changingModelSessionIds: Set<string>
  modelErrors: Record<string, string>
  onChangeSessionModel: (sessionId: string, model: string) => Promise<void>
  changingContextSharingSessionIds: Set<string>
  contextSharingErrors: Record<string, string>
  onChangeSessionContextSharing: (
    sessionId: string,
    sharing: 'shared' | 'isolated',
  ) => Promise<void>
  revealChildren?: boolean
}) {
  const { t } = useTranslation()
  const expanded = !collapsed.has(item.context.id)
  const [expandingSessions, setExpandingSessions] = useState(false)
  const [childrenExpanded, setChildrenExpanded] = useState(false)
  const showChildren = revealChildren || childrenExpanded
  return (
    <section className={`runtime-overview-context ${item.delegation ? 'is-delegation' : ''}`}>
      <header className="runtime-overview-context-header">
        <button className="runtime-overview-context-toggle" type="button" onClick={() => onToggleContext(item.context.id)} aria-expanded={expanded}>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span>
            <small>{item.delegation ? t('runtimeOverview.delegation') : t('runtimeOverview.context')}</small>
            <strong>{item.context.title}</strong>
          </span>
        </button>
        <div className="runtime-overview-context-meta">
          {item.attention_count > 0 && <span className="needs-attention"><AlertCircle size={12} />{item.attention_count}</span>}
          <span><MessageSquare size={12} />{item.active_session_count}/{item.total_session_count}</span>
          <span><GitBranch size={12} />{item.open_thread_count}</span>
          <span><Layers3 size={12} />{item.objective_count}</span>
          <span><Brain size={12} />r{item.mind_revision ?? 0}</span>
          <time>{ago(item.last_activity_at, language)}</time>
          <button type="button" onClick={() => onOpenContext(item.context.id)}>{t('runtimeOverview.openContext')}</button>
        </div>
      </header>
      {expanded && (
        <div className="runtime-overview-context-body">
          {item.delegation && (
            <p className="runtime-overview-delegation-task">
              <Network size={13} />
              <span>{item.delegation.task}</span>
            </p>
          )}
          <div className="runtime-overview-session-grid">
            {item.sessions.map(session => (
              <SessionCard
                key={session.session.id}
                item={session}
                language={language}
                onOpen={() => onOpenSession(item.context.id, session.session.id)}
                modelOptions={modelOptions}
                runtimeDefaultModel={runtimeDefaultModel}
                changingModel={changingModelSessionIds.has(session.session.id)}
                modelError={modelErrors[session.session.id] ?? ''}
                onChangeModel={model => onChangeSessionModel(session.session.id, model)}
                changingContextSharing={changingContextSharingSessionIds.has(session.session.id)}
                contextSharingError={contextSharingErrors[session.session.id] ?? ''}
                onChangeContextSharing={sharing => (
                  onChangeSessionContextSharing(session.session.id, sharing)
                )}
              />
            ))}
            {item.sessions.length === 0 && (
              <div className="runtime-overview-empty">{t('runtimeOverview.emptySessions')}</div>
            )}
          </div>
          {item.hidden_session_count > 0 && (
            <button
              className="runtime-overview-hidden"
              disabled={expandingSessions}
              type="button"
              onClick={() => {
                setExpandingSessions(true)
                void onExpandSessions(item.context.id).finally(() => setExpandingSessions(false))
              }}
            >
              {t('runtimeOverview.hiddenSessions', { count: item.hidden_session_count })}
              {expandingSessions ? <RefreshCw className="is-spinning" size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
          {children.length > 0 && (
            <div className="runtime-overview-delegations">
              <button
                className="runtime-overview-delegations-toggle"
                type="button"
                aria-expanded={showChildren}
                onClick={() => setChildrenExpanded(current => !current)}
              >
                <Network size={14} />
                <span>{t('runtimeOverview.delegations', { count: children.length })}</span>
                <small>{t(showChildren ? 'runtimeOverview.collapseDelegations' : 'runtimeOverview.expandDelegations')}</small>
                {showChildren ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              {showChildren && (
                <div className="runtime-overview-delegation-groups">
                  {children.map(child => (
                    <ContextGroup
                      key={child.context.id}
                      item={child}
                      children={[]}
                      collapsed={collapsed}
                      language={language}
                      onToggleContext={onToggleContext}
                      onOpenContext={onOpenContext}
                      onOpenSession={onOpenSession}
                      onExpandSessions={onExpandSessions}
                      modelOptions={modelOptions}
                      runtimeDefaultModel={runtimeDefaultModel}
                      changingModelSessionIds={changingModelSessionIds}
                      modelErrors={modelErrors}
                      onChangeSessionModel={onChangeSessionModel}
                      changingContextSharingSessionIds={changingContextSharingSessionIds}
                      contextSharingErrors={contextSharingErrors}
                      onChangeSessionContextSharing={onChangeSessionContextSharing}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function RuntimeOverviewPage({
  overview,
  loading,
  error,
  onRefresh,
  onOpenContext,
  onOpenSession,
  onExpandSessions,
  modelOptions,
  runtimeDefaultModel,
  onChangeSessionModel,
  onChangeSessionContextSharing,
}: RuntimeOverviewPageProps) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RuntimeOverviewFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [changingModelSessionIds, setChangingModelSessionIds] = useState<Set<string>>(() => new Set())
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({})
  const [changingContextSharingSessionIds, setChangingContextSharingSessionIds] = useState<Set<string>>(() => new Set())
  const [contextSharingErrors, setContextSharingErrors] = useState<Record<string, string>>({})
  const collapseInitialized = useRef(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const contextIds = useMemo(
    () => new Set(overview?.contexts.map(item => item.context.id) ?? []),
    [overview],
  )
  const childIds = useMemo(
    () => new Set(
      overview?.contexts
        .filter(item => item.delegation && contextIds.has(item.delegation.parent_context_id))
        .map(item => item.context.id) ?? [],
    ),
    [contextIds, overview],
  )
  const childByParent = useMemo(() => {
    const result = new Map<string, RuntimeOverviewContext[]>()
    for (const item of overview?.contexts ?? []) {
      const parentId = item.delegation?.parent_context_id
      if (!parentId || !contextIds.has(parentId)) continue
      const current = result.get(parentId) ?? []
      current.push(item)
      result.set(parentId, current)
    }
    return result
  }, [contextIds, overview])
  const isVisible = useCallback(
    (item: RuntimeOverviewContext) => (
      matchesFilter(item, filter) && matchesQuery(item, normalizedQuery)
    ),
    [filter, normalizedQuery],
  )
  const visibleContexts = useMemo(
    () => (overview?.contexts ?? []).filter(item => {
      if (childIds.has(item.context.id)) return false
      const children = childByParent.get(item.context.id) ?? []
      return isVisible(item) || children.some(isVisible)
    }),
    [childByParent, childIds, isVisible, overview],
  )

  useEffect(() => {
    if (!overview || collapseInitialized.current) return
    collapseInitialized.current = true
    const next = new Set<string>()
    for (const item of overview.contexts) {
      // The overview is a Session workspace, so regular Contexts must reveal
      // their Session cards immediately. Only managed delegation Contexts are
      // collapsed by default; otherwise an idle Runtime degenerates into a
      // list of Context headings and no longer functions as an overview.
      if (item.delegation) {
        next.add(item.context.id)
      }
    }
    setCollapsed(next)
  }, [overview])

  const toggleContext = (contextId: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(contextId)) next.delete(contextId)
      else next.add(contextId)
      return next
    })
  }

  const changeSessionModel = async (sessionId: string, model: string) => {
    setChangingModelSessionIds(current => new Set(current).add(sessionId))
    setModelErrors(current => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    try {
      await onChangeSessionModel(sessionId, model)
    } catch (reason) {
      setModelErrors(current => ({
        ...current,
        [sessionId]: reason instanceof Error ? reason.message : String(reason),
      }))
    } finally {
      setChangingModelSessionIds(current => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
    }
  }

  const changeSessionContextSharing = async (
    sessionId: string,
    sharing: 'shared' | 'isolated',
  ) => {
    setChangingContextSharingSessionIds(current => new Set(current).add(sessionId))
    setContextSharingErrors(current => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    try {
      await onChangeSessionContextSharing(sessionId, sharing)
    } catch (reason) {
      setContextSharingErrors(current => ({
        ...current,
        [sessionId]: reason instanceof Error ? reason.message : String(reason),
      }))
    } finally {
      setChangingContextSharingSessionIds(current => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
    }
  }

  return (
    <section className="runtime-overview-view">
      <header className="workspace-heading runtime-overview-heading">
        <div>
          <span>{t('runtimeOverview.eyebrow')}</span>
          <h1>{t('runtimeOverview.heading')}</h1>
          <p>{t('runtimeOverview.description')}</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? 'is-spinning' : ''} size={14} />
          {t('runtimeOverview.refresh')}
        </button>
      </header>

      {overview && (
        <div className="runtime-overview-summary">
          <div><Network size={17} /><span><small>{t('runtimeOverview.summary.contexts')}</small><strong>{overview.summary.contexts}</strong></span></div>
          <div><MessageSquare size={17} /><span><small>{t('runtimeOverview.summary.sessions')}</small><strong>{overview.summary.active_sessions}</strong><em>/ {overview.summary.total_sessions}</em></span></div>
          <div><Layers3 size={17} /><span><small>{t('runtimeOverview.summary.objectives')}</small><strong>{overview.summary.objectives}</strong></span></div>
          <div><GitBranch size={17} /><span><small>{t('runtimeOverview.summary.threads')}</small><strong>{overview.summary.open_threads}</strong><em>· {overview.summary.running_activations} {t('runtimeOverview.summary.running')}</em></span></div>
          <div className={overview.summary.attention_required > 0 ? 'has-attention' : ''}><AlertCircle size={17} /><span><small>{t('runtimeOverview.summary.attention')}</small><strong>{overview.summary.attention_required}</strong></span></div>
        </div>
      )}

      <div className="runtime-overview-toolbar">
        <label>
          <Search size={15} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('runtimeOverview.search')}
          />
        </label>
        <div role="group" aria-label={t('runtimeOverview.filterLabel')}>
          {(['all', 'attention', 'active', 'idle'] as RuntimeOverviewFilter[]).map(value => (
            <button
              className={filter === value ? 'is-active' : ''}
              key={value}
              type="button"
              onClick={() => setFilter(value)}
            >
              {t(`runtimeOverview.filters.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="runtime-overview-error"><AlertCircle size={14} />{error}</div>}
      {!overview && loading && <div className="runtime-overview-loading"><RefreshCw size={17} />{t('runtimeOverview.loading')}</div>}
      {overview && visibleContexts.length > 0 && (
        <div className="runtime-overview-contexts">
          {visibleContexts.map(item => (
            <ContextGroup
              key={item.context.id}
              item={item}
              children={(childByParent.get(item.context.id) ?? []).filter(isVisible)}
              collapsed={normalizedQuery ? new Set() : collapsed}
              language={i18n.language}
              onToggleContext={toggleContext}
              onOpenContext={onOpenContext}
              onOpenSession={onOpenSession}
              onExpandSessions={onExpandSessions}
              modelOptions={modelOptions}
              runtimeDefaultModel={runtimeDefaultModel}
              changingModelSessionIds={changingModelSessionIds}
              modelErrors={modelErrors}
              onChangeSessionModel={changeSessionModel}
              changingContextSharingSessionIds={changingContextSharingSessionIds}
              contextSharingErrors={contextSharingErrors}
              onChangeSessionContextSharing={changeSessionContextSharing}
              revealChildren={Boolean(normalizedQuery)}
            />
          ))}
        </div>
      )}
      {overview && visibleContexts.length === 0 && (
        <div className="runtime-overview-empty-page">
          <Search size={21} />
          <strong>{t('runtimeOverview.empty')}</strong>
          <span>{t('runtimeOverview.emptyHint')}</span>
        </div>
      )}
      {overview?.has_more_contexts && (
        <p className="runtime-overview-bounded">{t('runtimeOverview.bounded')}</p>
      )}
    </section>
  )
}
