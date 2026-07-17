import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Copy,
  Database,
  GitBranch,
  Globe,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Palette,
  Play,
  Radio,
  RefreshCw,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import './App.css'
import {
  createLiveModelState,
  findReasoningSummaryForPayload,
  isModelStreamEvent,
  modelStreamReducer,
  readReasoningSummaryPreference,
  reasoningSummaryStorageKey,
  selectDurableReasoningSummaries,
  visibleLiveModelAttempts,
  type ModelStreamBatchItem,
} from './modelStream'
import {
  pendingHumanApprovals,
  schedulerAttentionCount,
  schedulerJobs,
  schedulerSchedules,
} from './scheduler/model'
import type {
  ApprovalRecord,
  ScheduledIntentRecord,
  SchedulerActivationSnapshot,
  SchedulerJobSnapshot,
  SchedulerSnapshot,
  SchedulerThreadSnapshot,
  ThreadActivationRecord,
  ThreadSignalRecord,
  WorkThreadRecord,
} from './scheduler/types'

const configuredHttpUrl = import.meta.env.VITE_MORPHZ_HTTP_URL as string | undefined
const configuredWsUrl = import.meta.env.VITE_MORPHZ_WS_URL as string | undefined
const CORE_HTTP_URL = (configuredHttpUrl ?? window.location.origin).replace(/\/$/, '')
const CORE_WS_URL = configuredWsUrl ?? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
const locationToken = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token')
  ?? new URLSearchParams(window.location.search).get('token')
  ?? undefined
const CORE_TOKEN = locationToken ?? (import.meta.env.VITE_MORPHZ_TOKEN as string | undefined)

type View = 'conversation' | 'work' | 'mind'
type AccentTheme = 'iris' | 'cyan' | 'coral' | 'mono'

const accentThemes: Array<{ id: AccentTheme; labelKey: string; descKey: string }> = [
  { id: 'cyan', labelKey: 'theme.cyan.label', descKey: 'theme.cyan.description' },
  { id: 'iris', labelKey: 'theme.iris.label', descKey: 'theme.iris.description' },
  { id: 'coral', labelKey: 'theme.coral.label', descKey: 'theme.coral.description' },
  { id: 'mono', labelKey: 'theme.mono.label', descKey: 'theme.mono.description' },
]

function initialAccentTheme(): AccentTheme {
  try {
    const saved = window.localStorage.getItem('morphz.dashboard.accent')
    if (accentThemes.some(theme => theme.id === saved)) return saved as AccentTheme
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'cyan'
}

function initialShowReasoningSummary(): boolean {
  try {
    return readReasoningSummaryPreference(window.localStorage)
  } catch {
    return false
  }
}

function MarkdownInline({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      allowedElements={['a', 'strong', 'em', 'del', 'code', 'br']}
      unwrapDisallowed
      components={{
        p: ({ children }) => <>{children}</>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

function ReasoningSummaryBlock({
  summary,
  live,
  open,
  onOpenChange,
  title,
  liveLabel,
  persistedLabel,
}: {
  summary: string
  live: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  liveLabel: string
  persistedLabel: string
}) {
  if (!summary.trim()) return null
  return (
    <details
      className="reasoning-summary"
      open={open}
      onToggle={event => {
        const nextOpen = event.currentTarget.open
        if (nextOpen !== open) onOpenChange(nextOpen)
      }}
    >
      <summary>
        <Brain size={13} />
        <span>{title}</span>
        <small>{live ? liveLabel : persistedLabel}</small>
      </summary>
      <div className="reasoning-summary-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
        >
          {summary}
        </ReactMarkdown>
      </div>
    </details>
  )
}

interface AgentRecord {
  id: string
  title: string
  status: string
  root_context_id: string
}

interface ContextRecord {
  id: string
  agent_id: string
  title: string
  status: string
}

interface SessionRecord {
  id: string
  agent_id: string
  context_id: string
  parent_session_id?: string
  title: string
  status: 'active' | 'archived'
  attention_state?: string
  mount_kind?: string
  created_at: string
  updated_at: string
  last_activity_at: string
}

interface RuntimeStatus {
  agent_id: string
  context_id: string
  model: string
  provider?: string
  reasoning_effort?: 'low' | 'medium' | 'high'
  tool_count: number
}

interface EventPayload {
  text?: string
  context_id?: string
  session_id?: string
  tool_name?: string
  status?: string
  [key: string]: unknown
}

interface MorphzEvent {
  id: string
  sequence?: number
  timestamp: string
  actor: string
  type: string
  topic: string
  payload: EventPayload
}

interface ContextFrame {
  id: string
  body: string
  sources: string[]
  revision: number
  created_version: number
  updated_version: number
}

interface ContextRelation {
  subject: string
  relation: string
  object: string
  created_version: number
}

interface MindState {
  version: number
  frames: ContextFrame[]
  relations: ContextRelation[]
  retired: string[]
  protected: string[]
  checkpoints: Array<{ id: string; created_version: number }>
}

interface ContextObservation {
  id: string
  reference: string
  session_id?: string
  sequence: number
  topic: string
  actor: string
  timestamp: string
  preview: string
  protected: boolean
  tool_name?: string
  tool_status?: string
}

interface ContextPressure {
  level: string
  estimated_tokens: number
  soft_limit: number
  hard_limit: number
  maintenance_reserve: number
  active_frames: number
  active_observations: number
  token_accuracy?: string
  token_source?: string
}

interface SessionWorkingSet {
  active_window_secs: number
  max_sessions: number
  current_session_ids: string[]
  full_session_ids: string[]
  metadata_only_session_ids: string[]
  excluded: Record<string, number>
  selection: string
}

interface ObjectiveRecord {
  id: string
  context_id: string
  coordinator_session_id: string
  delivery_session_id: string
  stated_objective: string
  revision: number
  status: string
  status_reason?: string
  wait_condition?: { kind: string; [key: string]: unknown }
  tokens_used: number
  token_budget?: number
  time_used_seconds: number
  created_at: string
  updated_at: string
}

interface ProjectedSession {
  session: SessionRecord
  projection: string
  active_activation_ids?: string[]
  active_objective_ids?: string[]
}

interface ContextViewResponse {
  context_id: string
  active_session_id: string
  sessions: ProjectedSession[]
  session_working_set: SessionWorkingSet
  active_activations: ThreadActivationRecord[]
  work_threads: WorkThreadRecord[]
  thread_signals: ThreadSignalRecord[]
  thread_phases: Record<string, 'idle' | 'runnable' | 'running' | 'waiting'>
  scheduled_intents: ScheduledIntentRecord[]
  objectives: ObjectiveRecord[]
  state: MindState
  observations: ContextObservation[]
  pressure: ContextPressure
}

interface DelegationRecord {
  id: string
  parent_context_id: string
  parent_session_id: string
  child_session_id: string
  task: string
  status: string
  created_at: string
  updated_at: string
}

interface ToolCallPreview {
  id: string
  name: string
  arguments: string
  arguments_chars?: number
  truncated?: boolean
}

interface ToolTimelineItem extends ToolCallPreview {
  timestamp: string
  status: string
  result?: string
}

interface ToolCallSummary {
  title: string
  target: string
  detail: string
}

const terminalObjectiveStatuses = new Set(['completed', 'cancelled', 'failed'])
const terminalTaskStatuses = new Set(['completed', 'cancelled', 'failed', 'succeeded', 'killed'])

function formatTime(value: string | undefined, locale: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([locale], { hour: '2-digit', minute: '2-digit' })
}

function formatAgo(value: string | undefined, t: TFunction) {
  if (!value) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return t('time.ago.seconds', { count: seconds })
  if (seconds < 3600) return t('time.ago.minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('time.ago.hours', { count: Math.floor(seconds / 3600) })
  return t('time.ago.days', { count: Math.floor(seconds / 86400) })
}

function compactTokens(value?: number) {
  if (value === undefined) return '—'
  if (value < 1000) return String(value)
  return `${Math.round(value / 100) / 10}k`
}

function shortId(value?: string, size = 15) {
  if (!value) return '—'
  if (value.length <= size) return value
  return `…${value.slice(-(size - 1))}`
}

function objectFromJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stringField(value: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const field = value[name]
    if (typeof field === 'string' && field.trim()) return field.trim()
  }
  return ''
}

function statusLabel(value: string, t: TFunction) {
  const key = `status.${value}`
  const translated = t(key)
  return translated === key ? value : translated
}

function summarizeToolCall(name: string, rawArguments: string, t: TFunction): ToolCallSummary {
  const argumentsValue = objectFromJson(rawArguments)
  const path = stringField(argumentsValue, 'path', 'file_path', 'file')
  const query = stringField(argumentsValue, 'query', 'pattern', 'search_query')
  const command = stringField(argumentsValue, 'command', 'cmd')
  const task = stringField(argumentsValue, 'task', 'prompt')
  const taskId = stringField(argumentsValue, 'task_id')
  const session = stringField(argumentsValue, 'session_id', 'target_session_id')
  const content = stringField(argumentsValue, 'content', 'message', 'text')
  const startLine = argumentsValue.start_line
  const endLine = argumentsValue.end_line
  const range = typeof startLine === 'number'
    ? `${startLine}${typeof endLine === 'number' ? `–${endLine}` : ''}`
    : ''
  const lines = range ? t('toolCall.lines', { range }) : ''

  switch (name) {
    case 'read':
      return { title: t('toolCall.read'), target: `${path || t('toolCall.unspecifiedFile')}${lines ? ` · ${lines}` : ''}`, detail: name }
    case 'write':
      return { title: t('toolCall.write'), target: path || t('toolCall.unspecifiedFile'), detail: name }
    case 'edit':
    case 'apply_patch':
      return { title: t('toolCall.edit'), target: path || stringField(argumentsValue, 'patch') || t('toolCall.viewArgs'), detail: name }
    case 'exec':
    case 'exec_command':
      return { title: t('toolCall.exec'), target: command || t('toolCall.unspecifiedCommand'), detail: name }
    case 'search':
      return { title: t('toolCall.search'), target: query || path || t('toolCall.unspecifiedQuery'), detail: name }
    case 'list_files':
      return { title: t('toolCall.listFiles'), target: path || stringField(argumentsValue, 'glob') || t('toolCall.workspace'), detail: name }
    case 'recall':
      return { title: t('toolCall.recall'), target: query || stringField(argumentsValue, 'ref') || t('toolCall.contextLedger'), detail: name }
    case 'context_tx':
      return { title: t('toolCall.contextTx'), target: 'Context Transaction', detail: name }
    case 'delegate':
      return { title: t('toolCall.delegate'), target: task || t('toolCall.subAgent'), detail: name }
    case 'wait_task':
      return { title: t('toolCall.waitTask'), target: taskId || t('toolCall.backgroundTask'), detail: name }
    case 'task_status':
      return { title: t('toolCall.taskStatus'), target: taskId || t('toolCall.backgroundTask'), detail: name }
    case 'kill_task':
      return { title: t('toolCall.killTask'), target: taskId || t('toolCall.backgroundTask'), detail: name }
    case 'send_message':
      return { title: t('toolCall.sendMessage'), target: `${session || t('toolCall.targetSession')}${content ? ` · ${content}` : ''}`, detail: name }
    case 'no_reply':
      return { title: t('toolCall.noReply'), target: t('toolCall.noMessage'), detail: name }
    default:
      return { title: name, target: path || query || command || task || taskId || content || t('toolCall.viewArgs'), detail: name }
  }
}

function summarizeActivation(
  item: ThreadActivationRecord,
  events: MorphzEvent[],
  toolTimeline: ToolTimelineItem[],
  t: TFunction,
) {
  const trigger = events.find(event => event.id === item.trigger_event_id)
  const objectiveId = typeof trigger?.payload.objective_id === 'string' ? trigger.payload.objective_id : ''
  if (item.trigger_kind === 'chat/user_message') {
    const input = typeof trigger?.payload.text === 'string' ? trigger.payload.text.trim() : ''
    return {
      title: input ? t('activation.processDialogue', { text: input }) : t('activation.processCurrentMessage'),
      threadKind: 'dialogue',
      threadId: item.session_id,
      threadDetail: `turn ${shortId(item.root_turn_id, 22)}`,
    }
  }
  if (objectiveId || item.trigger_kind === 'runtime/objective_continue' || item.trigger_kind.startsWith('objective/')) {
    return {
      title: t('activation.continueObjective'),
      threadKind: 'objective',
      threadId: objectiveId || item.root_turn_id,
      threadDetail: `causal ${shortId(item.root_turn_id, 22)}`,
    }
  }
  if (item.trigger_kind === 'chat/tool_output') {
    const callId = typeof trigger?.payload.tool_call_id === 'string' ? trigger.payload.tool_call_id : ''
    const call = toolTimeline.find(value => value.id === callId)
    const name = call?.name ?? (typeof trigger?.payload.tool_name === 'string' ? trigger.payload.tool_name : 'tool')
    const summary = summarizeToolCall(name, call?.arguments ?? '{}', t)
    return {
      title: t('activation.processToolResult', { tool: summary.title, target: summary.target }),
      threadKind: 'work',
      threadId: item.root_turn_id,
      threadDetail: `from dialogue ${shortId(item.session_id, 18)}`,
    }
  }
  return {
    title: t('activation.processRuntimeEvent', { kind: item.trigger_kind }),
    threadKind: 'work',
    threadId: item.root_turn_id,
    threadDetail: `from dialogue ${shortId(item.session_id, 18)}`,
  }
}

function eventKind(event: MorphzEvent) {
  if (event.topic === 'chat/user_message') return 'user'
  if (event.topic === 'chat/reply') {
    const threadKind = typeof event.payload.thread_kind === 'string' ? event.payload.thread_kind : 'dialogue'
    return threadKind === 'dialogue' ? 'agent' : 'background'
  }
  if (event.topic === 'chat/outbound_message') return 'agent'
  if (event.topic === 'chat/progress') return 'progress'
  if (event.topic === 'chat/cancelled') return 'system'
  return null
}

function ExecutionJobRow({
  snapshot,
  t,
  locale,
  decidingApprovalId,
  onApproval,
}: {
  snapshot: SchedulerJobSnapshot
  t: TFunction
  locale: string
  decidingApprovalId: string
  onApproval: (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => void
}) {
  const { job, approval, result } = snapshot
  const summary = summarizeToolCall(job.tool_name, JSON.stringify(job.request), t)
  const failed = job.status === 'failed' || job.status === 'lost'
  return (
    <details className={`causal-job ${failed ? 'failed' : job.status}`} open={job.status === 'running' || job.status === 'waiting_approval'}>
      <summary>
        <i>{job.status === 'running' ? <LoaderCircle size={13} /> : failed ? '!' : job.status === 'succeeded' ? '✓' : <CircleDot size={12} />}</i>
        <span><strong>{summary.title}</strong><small>{summary.target}</small></span>
        <code>{job.status} · {shortId(job.id, 18)}</code>
        <time>{formatTime(job.updated_at, locale)}</time>
        <ChevronDown size={13} />
      </summary>
      <div className="causal-job-detail">
        <section><header>{t('work.causal.request')}</header><pre>{JSON.stringify(job.request, null, 2)}</pre></section>
        <dl>
          <div><dt>{t('work.causal.retrySafety')}</dt><dd>{job.retry_safety}</dd></div>
          <div><dt>{t('work.causal.revision')}</dt><dd>r{job.revision}</dd></div>
          {job.claimed_by && <div><dt>{t('work.causal.worker')}</dt><dd>{job.claimed_by}</dd></div>}
        </dl>
        {approval && (
          <section className={`inline-approval ${approval.status}`}>
            <header><span>{t('work.approvals.title')}</span><b>{statusLabel(approval.status, t)}</b></header>
            <p>{approval.justification}</p>
            <details><summary>{t('work.approvals.capability')}</summary><pre>{JSON.stringify({ action: approval.action, requested: approval.requested }, null, 2)}</pre></details>
            {approval.risk_tags.length > 0 && <small>{approval.risk_tags.join(' · ')}</small>}
            {approval.status === 'pending_human' && (
              <div className="approval-actions">
                <button disabled={decidingApprovalId === approval.id} type="button" onClick={() => onApproval(approval, 'allow_once')}><Check size={13} /> {t('work.approvals.allowOnce')}</button>
                <button disabled={decidingApprovalId === approval.id} className="danger" type="button" onClick={() => onApproval(approval, 'deny')}><Square size={12} /> {t('work.approvals.deny')}</button>
              </div>
            )}
          </section>
        )}
        {result && (
          <section className={`job-result ${result.status}`}>
            <header>{t('work.causal.result')} · {statusLabel(result.status, t)}</header>
            {result.error && <p>{result.error}</p>}
            {result.exit_code !== undefined && <small>{t('work.causal.exitCode', { code: result.exit_code })}</small>}
            {result.refs.length > 0 && <ul>{result.refs.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul>}
            {result.event_id && <code>{shortId(result.event_id, 30)}</code>}
          </section>
        )}
      </div>
    </details>
  )
}

function ActivationGroup({
  snapshot,
  t,
  locale,
  decidingApprovalId,
  onApproval,
}: {
  snapshot: SchedulerActivationSnapshot
  t: TFunction
  locale: string
  decidingApprovalId: string
  onApproval: (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => void
}) {
  return (
    <section className="causal-activation">
      <header>
        <span className={`status-pill ${snapshot.activation.status}`}>{statusLabel(snapshot.activation.status, t)}</span>
        <strong>{t('work.causal.activation')}</strong>
        <code>{shortId(snapshot.activation.id, 22)}</code>
        <small>{snapshot.activation.trigger_kind}</small>
      </header>
      {snapshot.signals.map(signal => (
        <div className="causal-signal" key={signal.id}>
          <Radio size={12} /><span>{signal.kind}</span><code>#{signal.sequence} · {shortId(signal.event_id, 18)}</code>
        </div>
      ))}
      <div className="causal-jobs">
        {snapshot.jobs.map(job => (
          <ExecutionJobRow
            key={job.job.id}
            snapshot={job}
            t={t}
            locale={locale}
            decidingApprovalId={decidingApprovalId}
            onApproval={onApproval}
          />
        ))}
        {snapshot.jobs.length === 0 && <div className="small-empty">{t('work.causal.noJobs')}</div>}
      </div>
    </section>
  )
}

function ThreadCausalCard({
  snapshot,
  t,
  locale,
  decidingApprovalId,
  mutatingScheduleId,
  onApproval,
  onSchedule,
}: {
  snapshot: SchedulerThreadSnapshot
  t: TFunction
  locale: string
  decidingApprovalId: string
  mutatingScheduleId: string
  onApproval: (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => void
  onSchedule: (schedule: ScheduledIntentRecord, action: 'pause' | 'resume' | 'reschedule' | 'cancel') => void
}) {
  const { thread } = snapshot
  const active = snapshot.phase !== 'idle' || thread.lifecycle === 'open'
  return (
    <details className={`causal-thread ${snapshot.phase}`} open={active}>
      <summary>
        <span className={`status-pill ${snapshot.phase}`}>{statusLabel(snapshot.phase, t)}</span>
        <div><strong>{thread.kind} thread</strong><small>{shortId(thread.id, 30)} · {t('header.session')} {shortId(thread.session_id, 18)}</small></div>
        <span className="causal-counts">{snapshot.activations.length}A · {snapshot.activations.reduce((sum, item) => sum + item.jobs.length, 0)}J</span>
        <em>{thread.delivery_status}</em>
        <ChevronDown size={14} />
      </summary>
      <div className="causal-thread-body">
        {snapshot.pending_signals.map(signal => (
          <div className="causal-signal pending" key={signal.id}>
            <Radio size={12} /><span>{signal.kind}</span><code>#{signal.sequence} · {shortId(signal.event_id, 20)}</code>
          </div>
        ))}
        {snapshot.activations.map(activation => (
          <ActivationGroup
            key={activation.activation.id}
            snapshot={activation}
            t={t}
            locale={locale}
            decidingApprovalId={decidingApprovalId}
            onApproval={onApproval}
          />
        ))}
        {snapshot.schedules.map(schedule => (
          <article className="inline-schedule" key={schedule.id}>
            <Clock3 size={14} />
            <div><strong>{schedule.intent}</strong><small>{schedule.not_before ? new Date(schedule.not_before).toLocaleString(locale) : t('work.scheduler.immediate')} · r{schedule.revision}</small></div>
            <span className={`status-pill ${schedule.status}`}>{statusLabel(schedule.status, t)}</span>
            <div className="schedule-actions">
              {schedule.status === 'queued' && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => onSchedule(schedule, 'pause')}>{t('work.schedules.pause')}</button>}
              {schedule.status === 'paused' && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => onSchedule(schedule, 'resume')}>{t('work.schedules.resume')}</button>}
              {!['completed', 'cancelled', 'dispatched'].includes(schedule.status) && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => onSchedule(schedule, 'reschedule')}>{t('work.schedules.reschedule')}</button>}
              {!['completed', 'cancelled'].includes(schedule.status) && <button disabled={mutatingScheduleId === schedule.id} className="danger" type="button" onClick={() => onSchedule(schedule, 'cancel')}>{t('work.schedules.cancel')}</button>}
            </div>
          </article>
        ))}
        <footer className={`delivery-state ${thread.delivery_status}`}>
          <span>{t('work.causal.delivery')}</span><b>{statusLabel(thread.delivery_status, t)}</b>
          {thread.result_text && <p>{thread.result_text}</p>}
        </footer>
      </div>
    </details>
  )
}

export default function App() {
  const { t, i18n } = useTranslation()
  const [view, setView] = useState<View>('conversation')
  const [accentTheme, setAccentTheme] = useState<AccentTheme>(initialAccentTheme)
  const [showReasoningSummary, setShowReasoningSummary] = useState(initialShowReasoningSummary)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [contexts, setContexts] = useState<ContextRecord[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [delegations, setDelegations] = useState<DelegationRecord[]>([])
  const [schedulerSnapshot, setSchedulerSnapshot] = useState<SchedulerSnapshot | null>(null)
  const [contextView, setContextView] = useState<ContextViewResponse | null>(null)
  const [events, setEvents] = useState<MorphzEvent[]>([])
  const [eventsSessionId, setEventsSessionId] = useState('')
  const [liveModelState, dispatchModelStream] = useReducer(modelStreamReducer, createLiveModelState())
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedContextId, setSelectedContextId] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [selectedFrameId, setSelectedFrameId] = useState('')
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [changingReasoning, setChangingReasoning] = useState(false)
  const [resumingObjectiveId, setResumingObjectiveId] = useState('')
  const [deletingObjectiveId, setDeletingObjectiveId] = useState('')
  const [decidingApprovalId, setDecidingApprovalId] = useState('')
  const [mutatingScheduleId, setMutatingScheduleId] = useState('')
  const [copiedMessageId, setCopiedMessageId] = useState('')
  const [pendingTurnSince, setPendingTurnSince] = useState<number | null>(null)
  const [pendingRootTurnId, setPendingRootTurnId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const conversationEnd = useRef<HTMLDivElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const wasSending = useRef(false)
  const conversationPinnedToEnd = useRef(true)
  const lastProgrammaticScroll = useRef(0)
  const viewFrameRef = useRef<HTMLDivElement>(null)
  const toolTimelineList = useRef<HTMLDivElement>(null)
  const toolTimelinePinnedToEnd = useRef(true)
  const composingInput = useRef(false)
  const sessionLoadInFlight = useRef(false)
  const sessionLoadQueued = useRef<{ sessionId: string, contextId: string } | null>(null)
  const loadSessionRef = useRef<(sessionId: string, contextId: string) => Promise<void>>(async () => {})
  const sessionSelectorRef = useRef<HTMLDivElement>(null)
  const themeSelectorRef = useRef<HTMLDivElement>(null)
  const selectedScopeRef = useRef({ sessionId: '', contextId: '' })

  const apiHeaders = useCallback((json = false) => {
    const headers: Record<string, string> = {}
    if (CORE_TOKEN) headers.Authorization = `Bearer ${CORE_TOKEN}`
    if (json) headers['Content-Type'] = 'application/json'
    return headers
  }, [])

  const loadCatalog = useCallback(async () => {
    try {
      const [statusResponse, agentsResponse, contextsResponse, sessionsResponse, delegationsResponse] = await Promise.all([
        fetch(`${CORE_HTTP_URL}/api/status`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/agents?include_archived=true`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/contexts?include_archived=true`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/sessions?include_archived=true`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/delegations`, { headers: apiHeaders() }),
      ])
      if (!statusResponse.ok) throw new Error(t('errors.statusHttp', { status: statusResponse.status }))
      const nextStatus = await statusResponse.json() as RuntimeStatus
      const nextAgents = agentsResponse.ok ? ((await agentsResponse.json() as { agents?: AgentRecord[] }).agents ?? []) : []
      const nextContexts = contextsResponse.ok ? ((await contextsResponse.json() as { contexts?: ContextRecord[] }).contexts ?? []) : []
      const nextSessions = sessionsResponse.ok ? ((await sessionsResponse.json() as { sessions?: SessionRecord[] }).sessions ?? []) : []
      const nextDelegations = delegationsResponse.ok ? ((await delegationsResponse.json() as { delegations?: DelegationRecord[] }).delegations ?? []) : []
      setStatus(nextStatus)
      setAgents(nextAgents)
      setContexts(nextContexts)
      setSessions(nextSessions)
      setDelegations(nextDelegations)
      setSelectedAgentId(current => current || nextStatus.agent_id || nextAgents[0]?.id || '')
      setSelectedContextId(current => current || nextStatus.context_id || nextContexts[0]?.id || '')
      setSelectedSessionId(current => {
        if (current && nextSessions.some(item => item.id === current)) return current
        const contextId = nextStatus.context_id || nextContexts[0]?.id
        return nextSessions
          .filter(item => item.context_id === contextId && item.status === 'active')
          .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))[0]?.id ?? nextSessions[0]?.id ?? ''
      })
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [apiHeaders, t])

  const loadSession = useCallback(async (sessionId: string, contextId: string) => {
    if (!sessionId || !contextId) return
    if (sessionLoadInFlight.current) {
      // Never lose the last WebSocket-driven refresh. Without this queue, a
      // terminal event arriving while a previous snapshot was loading could
      // leave a completed Activation rendered as running until the next poll.
      sessionLoadQueued.current = { sessionId, contextId }
      return
    }
    sessionLoadInFlight.current = true
    try {
      const [eventsResponse, contextResponse, schedulerResponse, delegationsResponse] = await Promise.all([
        fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(sessionId)}/events?limit=1000`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(sessionId)}/context`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/contexts/${encodeURIComponent(contextId)}/scheduler?include_terminal=true&limit=300`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/delegations`, { headers: apiHeaders() }),
      ])
      const selectedScope = selectedScopeRef.current
      if (selectedScope.sessionId !== sessionId || selectedScope.contextId !== contextId) return
      if (!contextResponse.ok) throw new Error(t('errors.contextHttp', { status: contextResponse.status }))
      if (eventsResponse.ok) {
        const result = await eventsResponse.json() as { events?: MorphzEvent[] }
        const nextEvents = result.events ?? []
        setEvents(nextEvents)
        setEventsSessionId(sessionId)
        for (const summary of selectDurableReasoningSummaries(nextEvents)) {
          dispatchModelStream({ type: 'persisted', sessionId, causalId: summary.attemptId })
        }
      }
      const nextContext = await contextResponse.json() as ContextViewResponse
      setContextView(nextContext)
      if (!schedulerResponse.ok) throw new Error(t('errors.schedulerHttp', { status: schedulerResponse.status }))
      setSchedulerSnapshot(await schedulerResponse.json() as SchedulerSnapshot)
      const activeWorkItems = new Set(nextContext.active_activations.map(item => item.id))
      const reconcileCutoffMs = Date.now() - 10_000
      // Keep drafts that are still actively streaming. Snapshot rows can lag
      // behind the live stream, so filtering purely by the snapshot kills
      // bubbles mid-generation and breaks auto-scroll.
      dispatchModelStream({
        type: 'reconcile',
        sessionId,
        activeWorkItemIds: [...activeWorkItems],
        cutoffMs: reconcileCutoffMs,
      })
      if (delegationsResponse.ok) {
        const result = await delegationsResponse.json() as { delegations?: DelegationRecord[] }
        setDelegations(result.delegations ?? [])
      }
      setSelectedFrameId(current => current && nextContext.state.frames.some(frame => frame.id === current)
        ? current
        : nextContext.state.frames[0]?.id ?? '')
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      sessionLoadInFlight.current = false
      const queued = sessionLoadQueued.current
      sessionLoadQueued.current = null
      if (queued) {
        window.setTimeout(
          () => void loadSessionRef.current(queued.sessionId, queued.contextId),
          0,
        )
      }
    }
  }, [apiHeaders, t])

  useEffect(() => {
    loadSessionRef.current = loadSession
  }, [loadSession])

  useEffect(() => {
    try {
      window.localStorage.setItem('morphz.dashboard.accent', accentTheme)
    } catch {
      // The visual preference remains valid for the current page lifetime.
    }
  }, [accentTheme])

  useEffect(() => {
    try {
      window.localStorage.setItem(reasoningSummaryStorageKey, String(showReasoningSummary))
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [showReasoningSummary])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCatalog(), 0)
    return () => window.clearTimeout(timer)
  }, [loadCatalog])

  useEffect(() => {
    selectedScopeRef.current = { sessionId: selectedSessionId, contextId: selectedContextId }
  }, [selectedContextId, selectedSessionId])

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      dispatchModelStream({ type: 'reset_session', sessionId: selectedSessionId })
      setEventsSessionId('')
    }, 0)
    return () => window.clearTimeout(resetTimer)
  }, [selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId || !selectedContextId) return
    const initial = window.setTimeout(() => void loadSession(selectedSessionId, selectedContextId), 0)
    const interval = window.setInterval(() => void loadSession(selectedSessionId, selectedContextId), 15000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [loadSession, selectedContextId, selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId) return
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let refreshTimer: number | undefined
    let streamFrame: number | undefined
    let pendingStreamEvents: ModelStreamBatchItem[] = []
    let disposed = false
    const flushStreamEvents = () => {
      streamFrame = undefined
      const batch = pendingStreamEvents
      pendingStreamEvents = []
      if (batch.length === 0 || disposed) return
      dispatchModelStream({
        type: 'stream_batch',
        sessionId: selectedSessionId,
        items: batch,
        nowMs: Date.now(),
      })
    }
    const queueStreamEvent = (item: (typeof pendingStreamEvents)[number]) => {
      pendingStreamEvents.push(item)
      if (streamFrame === undefined) streamFrame = window.requestAnimationFrame(flushStreamEvents)
    }
    const connect = () => {
      if (disposed) return
      setWsStatus('connecting')
      const params = new URLSearchParams({ session_id: selectedSessionId })
      if (CORE_TOKEN) params.set('token', CORE_TOKEN)
      socket = new WebSocket(`${CORE_WS_URL}?${params}`)
      socket.onopen = () => {
        setWsStatus('connected')
        void loadSession(selectedSessionId, selectedContextId)
      }
      socket.onmessage = messageEvent => {
        if (disposed) return
        try {
          const event = JSON.parse(messageEvent.data) as MorphzEvent
          if (event.topic === 'runtime/model_stream') {
            const attemptId = typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : ''
            const workItemId = typeof event.payload.work_item_id === 'string' ? event.payload.work_item_id : attemptId
            const threadKind = typeof event.payload.thread_kind === 'string' ? event.payload.thread_kind : 'dialogue'
            const stream = event.payload.stream
            if (attemptId && isModelStreamEvent(stream)) {
              queueStreamEvent({ attemptId, workItemId, threadKind, timestamp: event.timestamp, stream })
            }
            return
          }
          setEventsSessionId(selectedSessionId)
          setEvents(previous => {
            if (previous.some(item => item.id === event.id)) return previous
            return [...previous, event].slice(-1000)
          })
          const causalId = typeof event.payload.work_item_id === 'string'
            ? event.payload.work_item_id
            : typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : ''
          const resolvesLiveAttempt = event.topic === 'chat/reply'
            || event.topic === 'chat/no_reply'
            || event.topic === 'chat/cancelled'
            || event.topic === 'chat/runtime_error'
            || event.topic === 'chat/progress'
            || event.topic === 'runtime/thread_result'
            || event.topic === 'runtime/response_protocol_error'
            || event.topic === 'runtime/response_protocol_fused'
            || event.topic === 'runtime/tool_calls_selected'
            || (event.topic === 'chat/assistant_call' && event.payload.terminal_outcome !== true)
          if (event.topic === 'runtime/model_reasoning_summary' && causalId) {
            const matchingStreamEvents = pendingStreamEvents.filter(item => (
              item.attemptId === causalId || item.workItemId === causalId
            ))
            pendingStreamEvents = pendingStreamEvents.filter(item => (
              item.attemptId !== causalId && item.workItemId !== causalId
            ))
            if (matchingStreamEvents.length > 0) {
              dispatchModelStream({
                type: 'stream_batch',
                sessionId: selectedSessionId,
                items: matchingStreamEvents,
                nowMs: Date.now(),
              })
            }
            dispatchModelStream({ type: 'persisted', sessionId: selectedSessionId, causalId })
          } else if (causalId && resolvesLiveAttempt) {
            pendingStreamEvents = pendingStreamEvents.filter(item => (
              item.attemptId !== causalId && item.workItemId !== causalId
            ))
            if (pendingStreamEvents.length === 0 && streamFrame !== undefined) {
              window.cancelAnimationFrame(streamFrame)
              streamFrame = undefined
            }
            dispatchModelStream({
              type: 'resolve',
              sessionId: selectedSessionId,
              causalId,
              nowMs: Date.now(),
            })
          }
          if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
          refreshTimer = window.setTimeout(
            () => void loadSession(selectedSessionId, selectedContextId),
            750,
          )
        } catch {
          setError(t('errors.websocketParse'))
        }
      }
      socket.onclose = () => {
        if (disposed) return
        setWsStatus('disconnected')
        pendingStreamEvents = []
        if (streamFrame !== undefined) window.cancelAnimationFrame(streamFrame)
        streamFrame = undefined
        dispatchModelStream({ type: 'reset_session', sessionId: selectedSessionId })
        reconnectTimer = window.setTimeout(connect, 2500)
      }
      socket.onerror = () => setWsStatus('disconnected')
    }
    connect()
    return () => {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      if (streamFrame !== undefined) window.cancelAnimationFrame(streamFrame)
      pendingStreamEvents = []
      socket?.close()
    }
  }, [loadSession, selectedContextId, selectedSessionId, t])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        setView(current => current === 'work' ? 'conversation' : 'work')
      } else if (event.ctrlKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        setView(current => current === 'mind' ? 'conversation' : 'mind')
      } else if (event.key === 'Escape') {
        setView('conversation')
        setSessionMenuOpen(false)
        setThemeMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (sessionMenuOpen && sessionSelectorRef.current && !sessionSelectorRef.current.contains(target)) {
        setSessionMenuOpen(false)
      }
      if (themeMenuOpen && themeSelectorRef.current && !themeSelectorRef.current.contains(target)) {
        setThemeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [sessionMenuOpen, themeMenuOpen])

  const selectedSession = sessions.find(item => item.id === selectedSessionId)
  const selectedContext = contexts.find(item => item.id === selectedContextId)
  const selectedAgent = agents.find(item => item.id === selectedAgentId)
  const visibleSessions = sessions
    .filter(item => item.context_id === selectedContextId && item.status === 'active')
    .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))
  const sessionEvents = useMemo(
    () => eventsSessionId === selectedSessionId ? events : [],
    [events, eventsSessionId, selectedSessionId],
  )
  const liveModelAttempts = visibleLiveModelAttempts(liveModelState, selectedSessionId)
  const durableReasoningSummaries = useMemo(
    () => selectDurableReasoningSummaries(sessionEvents),
    [sessionEvents],
  )
  const conversationEvents = useMemo(
    // runtime/model_stream is the transient draft; chat/progress is the
    // durable form of model text emitted before tool execution. The websocket
    // reducer clears the matching draft as soon as progress arrives, so the
    // durable row must remain visible instead of making the text disappear.
    () => sessionEvents.filter(event => eventKind(event) !== null),
    [sessionEvents],
  )
  const streamingAttempts = useMemo(
    () => Object.values(liveModelAttempts)
      .filter(attempt => attempt.text.trim() || attempt.reasoningSummary.trim() || attempt.status === 'failed')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    [liveModelAttempts],
  )
  const conversationStreamingAttempts = useMemo(
    // Dialogue, Objective and Delivery evaluations can all terminate in a
    // user-visible reply for the active Session. Work evaluations only
    // produce internal Thread results; rendering those here would expose an
    // intermediate draft as if it were the final answer.
    () => streamingAttempts.filter(attempt => ['dialogue', 'objective', 'delivery'].includes(attempt.threadKind)),
    [streamingAttempts],
  )
  const liveWorkStreamingAttempts = useMemo(
    () => Object.values(liveModelAttempts)
      .filter(attempt => attempt.threadKind === 'work' && attempt.status !== 'failed')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    [liveModelAttempts],
  )
  const durableWorkReasoningSummaries = useMemo(
    () => durableReasoningSummaries.filter(summary => summary.threadKind === 'work'),
    [durableReasoningSummaries],
  )
  const turnPending = pendingTurnSince !== null && !sessionEvents.some(event => {
    if (!['chat/reply', 'chat/no_reply', 'chat/cancelled', 'runtime/response_protocol_fused'].includes(event.topic)) return false
    if (pendingRootTurnId !== null) {
      return event.payload.root_turn_id === pendingRootTurnId
    }
    const timestamp = new Date(event.timestamp).getTime()
    return Number.isFinite(timestamp) && timestamp >= pendingTurnSince - 1000
  })
  const toolTimeline = useMemo(() => {
    const calls = new Map<string, ToolTimelineItem>()
    for (const event of sessionEvents) {
      if (event.topic === 'runtime/tool_calls_selected' && Array.isArray(event.payload.calls)) {
        for (const value of event.payload.calls as unknown[]) {
          if (!value || typeof value !== 'object') continue
          const call = value as Partial<ToolCallPreview>
          if (!call.id || !call.name) continue
          calls.set(call.id, {
            id: call.id,
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : '{}',
            arguments_chars: call.arguments_chars,
            truncated: call.truncated,
            timestamp: event.timestamp,
            status: 'running',
            ...calls.get(call.id),
          })
        }
      } else if (event.topic === 'chat/tool_output') {
        const id = typeof event.payload.tool_call_id === 'string' ? event.payload.tool_call_id : event.id
        const previous = calls.get(id)
        calls.set(id, {
          id,
          name: typeof event.payload.tool_name === 'string' ? event.payload.tool_name : previous?.name ?? 'tool',
          arguments: previous?.arguments ?? '{}',
          arguments_chars: previous?.arguments_chars,
          truncated: previous?.truncated,
          timestamp: previous?.timestamp ?? event.timestamp,
          status: typeof event.payload.tool_status === 'string' ? event.payload.tool_status : 'success',
          result: typeof event.payload.text === 'string' ? event.payload.text : '',
        })
      }
    }
    return [...calls.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  }, [sessionEvents])
  const objectives = contextView?.objectives ?? []
  const activeObjectives = objectives.filter(item => !terminalObjectiveStatuses.has(item.status))
  const runningObjectives = activeObjectives.filter(item => item.status === 'active')
  const blockedObjectives = activeObjectives.filter(item => item.status === 'blocked')
  const pausedObjectives = activeObjectives.filter(item => item.status === 'paused')
  const schedulerThreads = schedulerSnapshot?.threads ?? []
  const workItems = schedulerThreads.flatMap(thread => thread.activations.map(item => item.activation))
  const threadSignals = schedulerThreads.flatMap(thread => [
    ...thread.pending_signals,
    ...thread.activations.flatMap(activation => activation.signals),
  ])
  const scheduledIntents = schedulerSchedules(schedulerSnapshot)
  const schedulerJobRows = schedulerJobs(schedulerSnapshot)
  const pendingApprovals = pendingHumanApprovals(schedulerSnapshot)
  const attentionCount = schedulerAttentionCount(schedulerSnapshot)
  const failedSchedulerJobs = schedulerJobRows.filter(item => item.job.status === 'failed' || item.job.status === 'lost')
  const failedDeliveries = schedulerThreads.filter(item => (
    item.thread.lifecycle === 'completed'
    && item.thread.delivery_status !== 'none'
    && item.thread.delivery_status !== 'delivered'
  ))
  const runningWorkItems = workItems.filter(item => item.status === 'queued' || item.status === 'running')
  const contextDelegations = delegations.filter(item => item.parent_context_id === selectedContextId)
  const liveDelegations = contextDelegations.filter(item => !terminalTaskStatuses.has(item.status))
  const runningDelegations = liveDelegations.filter(item => item.status === 'queued' || item.status === 'running')
  const activeWorkCount = schedulerSnapshot
    ? schedulerSnapshot.summary.running_activations + schedulerSnapshot.summary.queued_activations
    : 0
  const waitingCount = schedulerSnapshot
    ? schedulerSnapshot.summary.waiting_approval_jobs + schedulerSnapshot.summary.active_schedules
    : runningObjectives.filter(item => Boolean(item.wait_condition)).length
  const selectedFrame = contextView?.state.frames.find(frame => frame.id === selectedFrameId)
  const retired = new Set(contextView?.state.retired ?? [])

  useEffect(() => {
    // Restore composer focus once a send finishes so the user can keep typing.
    if (wasSending.current && !sending) composerInputRef.current?.focus()
    wasSending.current = sending
  }, [sending])

  useEffect(() => {
    if (view !== 'conversation') {
      conversationPinnedToEnd.current = true
      return
    }
    if (!conversationPinnedToEnd.current) return
    const timer = window.setTimeout(() => {
      const container = viewFrameRef.current
      if (container) {
        lastProgrammaticScroll.current = Date.now()
        container.scrollTop = container.scrollHeight
      }
      conversationEnd.current?.scrollIntoView({ block: 'end' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [conversationEvents.length, conversationStreamingAttempts, turnPending, view])

  useEffect(() => {
    if (view !== 'conversation') return
    const container = viewFrameRef.current
    if (!container) return
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        conversationPinnedToEnd.current = false
      } else if (event.deltaY > 0) {
        const distance = container.scrollHeight - container.scrollTop - container.clientHeight
        if (distance < 48) conversationPinnedToEnd.current = true
      }
    }
    container.addEventListener('wheel', handleWheel, { passive: true })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [view])

  useEffect(() => {
    if (view !== 'work') {
      toolTimelinePinnedToEnd.current = true
      return
    }
    if (!toolTimelinePinnedToEnd.current) return
    const frame = window.requestAnimationFrame(() => {
      const list = toolTimelineList.current
      if (list) list.scrollTop = list.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [toolTimeline.length, view])

  const chooseSession = (session: SessionRecord) => {
    setSelectedAgentId(session.agent_id)
    setSelectedContextId(session.context_id)
    setSelectedSessionId(session.id)
    setSessionMenuOpen(false)
    setView('conversation')
  }

  const copyMessage = async (text: string, messageId: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedMessageId(messageId)
      window.setTimeout(() => setCopiedMessageId(''), 1200)
    } catch {
      setError(t('errors.copyFailed'))
    }
  }

  const sendMessage = async () => {
    const text = message.trim()
    if (!text || !selectedSessionId || sending) return
    setSending(true)
    setPendingTurnSince(Date.now())
    setPendingRootTurnId(null)
    conversationPinnedToEnd.current = true
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          text,
          client_message_id: `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        }),
      })
      if (!response.ok) throw new Error(t('errors.sendMessage', { status: response.status }))
      const receipt = await response.json() as { event_id?: string }
      setPendingRootTurnId(receipt.event_id ?? null)
      setMessage('')
      setError('')
      window.setTimeout(() => void loadSession(selectedSessionId, selectedContextId), 120)
    } catch (reason) {
      setPendingTurnSince(null)
      setPendingRootTurnId(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSending(false)
    }
  }

  const cancelCurrentSession = async () => {
    if (!selectedSessionId) return
    const response = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(selectedSessionId)}/cancel`, {
      method: 'POST',
      headers: apiHeaders(),
    })
    if (!response.ok) setError(t('errors.cancelSession', { status: response.status }))
  }

  const changeReasoningEffort = async (value: string) => {
    if (changingReasoning) return
    setChangingReasoning(true)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/runtime/inference`, {
        method: 'PUT',
        headers: apiHeaders(true),
        body: JSON.stringify({
          reasoning_effort: value === 'default' ? null : value,
        }),
      })
      if (!response.ok) throw new Error(t('errors.reasoning', { status: response.status }))
      const inference = await response.json() as { reasoning_effort?: 'low' | 'medium' | 'high' }
      setStatus(current => current ? { ...current, reasoning_effort: inference.reasoning_effort } : current)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangingReasoning(false)
    }
  }

  const resumeObjective = async (objective: ObjectiveRecord) => {
    if (resumingObjectiveId) return
    setResumingObjectiveId(objective.id)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/objectives/${encodeURIComponent(objective.id)}/resume`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          expected_revision: objective.revision,
          reason: t('reason.resumeByUser'),
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? t('errors.resumeObjective', { status: response.status }))
      }
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setResumingObjectiveId('')
    }
  }

  const deleteObjective = async (objective: ObjectiveRecord) => {
    if (deletingObjectiveId) return
    const confirmed = window.confirm(
      t('dialog.deleteObjectiveTitle') + '\n\n' + t('dialog.deleteObjectiveBody', { objective: objective.stated_objective }),
    )
    if (!confirmed) return
    setDeletingObjectiveId(objective.id)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/objectives/${encodeURIComponent(objective.id)}`, {
        method: 'DELETE',
        headers: apiHeaders(true),
        body: JSON.stringify({
          expected_revision: objective.revision,
          reason: t('reason.deleteByUser'),
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? t('errors.deleteObjective', { status: response.status }))
      }
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeletingObjectiveId('')
    }
  }

  const decideApproval = async (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => {
    if (decision === 'deny' && !window.confirm(t('dialog.denyApproval'))) return
    setDecidingApprovalId(approval.id)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({ decision, rationale: t(`reason.approval.${decision}`) }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        await loadSession(selectedSessionId, selectedContextId)
        throw new Error(detail.error ?? t('errors.approvalDecision', { status: response.status }))
      }
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDecidingApprovalId('')
    }
  }

  const mutateSchedule = async (
    schedule: ScheduledIntentRecord,
    action: 'pause' | 'resume' | 'reschedule' | 'cancel',
  ) => {
    if (action === 'cancel' && !window.confirm(t('dialog.cancelSchedule'))) return
    let notBefore: string | undefined
    let intervalSeconds: number | undefined
    if (action === 'reschedule') {
      const requested = window.prompt(
        t('dialog.rescheduleAt'),
        schedule.not_before ?? new Date().toISOString(),
      )
      if (requested === null) return
      const parsed = new Date(requested)
      if (Number.isNaN(parsed.getTime())) {
        setError(t('errors.invalidScheduleDate'))
        return
      }
      notBefore = parsed.toISOString()
      const interval = window.prompt(
        t('dialog.rescheduleInterval'),
        schedule.interval_seconds?.toString() ?? '',
      )
      if (interval === null) return
      if (interval.trim()) {
        intervalSeconds = Number(interval)
        if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
          setError(t('errors.invalidScheduleInterval'))
          return
        }
      }
    }
    setMutatingScheduleId(schedule.id)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/schedules/${encodeURIComponent(schedule.id)}`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          action,
          expected_revision: schedule.revision,
          not_before: notBefore,
          interval_seconds: intervalSeconds,
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        // Schedule mutations are revision fenced. Refresh the authoritative
        // projection even on conflict so the next user action carries the
        // winning revision instead of repeatedly submitting stale state.
        await loadSession(selectedSessionId, selectedContextId)
        throw new Error(detail.error ?? t('errors.scheduleMutation', { status: response.status }))
      }
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMutatingScheduleId('')
    }
  }

  const leadingActivation = runningWorkItems[0]
  const activationSummary = leadingActivation
    ? summarizeActivation(leadingActivation, sessionEvents, toolTimeline, t).title
    : ''
  const primaryJob = schedulerJobRows.find(item => (
    item.job.status === 'running'
    || item.job.status === 'queued'
    || item.job.status === 'waiting_approval'
  ))
  const primaryJobSummary = primaryJob
    ? summarizeToolCall(primaryJob.job.tool_name, JSON.stringify(primaryJob.job.request), t)
    : undefined
  const failedDelivery = schedulerThreads.find(item => (
    item.thread.lifecycle === 'completed'
    && item.thread.delivery_status !== 'none'
    && item.thread.delivery_status !== 'delivered'
  ))
  const taskStrip = pendingApprovals[0]
    ? { state: 'waiting', label: t('composer.status.approvalRequired'), summary: pendingApprovals[0].justification }
    : failedDelivery
      ? { state: 'blocked', label: t('composer.status.deliveryFailed'), summary: failedDelivery.thread.result_text ?? failedDelivery.thread.id }
      : primaryJob
        ? {
            state: primaryJob.job.status === 'waiting_approval' ? 'waiting' : 'running',
            label: primaryJob.job.status === 'waiting_approval' ? t('composer.status.approvalRequired') : t('composer.status.executing'),
            summary: primaryJobSummary ? `${primaryJobSummary.title} · ${primaryJobSummary.target}` : primaryJob.job.tool_name,
          }
        : schedulerSnapshot && schedulerSnapshot.admission.context_deferred > 0
          ? { state: 'waiting', label: t('composer.status.backpressure'), summary: t('composer.status.deferredCount', { count: schedulerSnapshot.admission.context_deferred }) }
          : runningDelegations[0]
        ? { state: 'running', label: t('composer.status.delegating'), summary: runningDelegations[0].task }
        : waitingCount > 0
          ? { state: 'waiting', label: t('composer.status.running'), summary: scheduledIntents[0]?.intent ?? runningObjectives.find(item => item.wait_condition)?.stated_objective ?? t('composer.status.waitingEvent') }
          : blockedObjectives[0]
            ? { state: 'blocked', label: t('composer.status.blocked'), summary: blockedObjectives[0].stated_objective }
            : pausedObjectives[0]
              ? { state: 'paused', label: t('composer.status.paused'), summary: pausedObjectives[0].stated_objective }
              : runningObjectives[0]
                ? { state: 'active', label: t('composer.status.active'), summary: runningObjectives[0].stated_objective }
                : leadingActivation
                  ? {
                      state: 'running',
                      label: leadingActivation.status === 'queued' ? t('composer.status.waitingModel') : t('composer.status.modelResponding'),
                      summary: activationSummary,
                    }
                  : { state: 'idle', label: t('composer.status.idle'), summary: t('composer.status.noWork') }
  const latestTurnEvent = !turnPending || pendingTurnSince === null ? undefined : [...sessionEvents]
    .reverse()
    .find(event => pendingRootTurnId !== null
      ? event.payload.root_turn_id === pendingRootTurnId || event.id === pendingRootTurnId
      : new Date(event.timestamp).getTime() >= pendingTurnSince - 1000)
  const turnStatus = useMemo(() => {
    if (!latestTurnEvent) return t('turnStatus.waiting')
    if (latestTurnEvent.topic === 'runtime/tool_calls_selected') {
      const calls = Array.isArray(latestTurnEvent.payload.calls) ? latestTurnEvent.payload.calls as Array<{ name?: string }> : []
      const names = calls.map(call => call.name).filter((name): name is string => Boolean(name))
      if (names.length === 0) return t('turnStatus.toolCalls', { count: calls.length })
      const shown = names.slice(0, 2).join(', ')
      const extra = names.length > 2 ? ` +${names.length - 2}` : ''
      return t('turnStatus.executingTools', { tools: `${shown}${extra}` })
    }
    if (latestTurnEvent.topic === 'chat/tool_output') {
      return t('turnStatus.toolResult', { tool: String(latestTurnEvent.payload.tool_name ?? t('toolCall.viewArgs')) })
    }
    if (latestTurnEvent.topic === 'runtime/model_attempt_started') return t('turnStatus.modelEval')
    return t('turnStatus.waiting')
  }, [latestTurnEvent, t])

  const currentTheme = accentThemes.find(theme => theme.id === accentTheme)
  const currentLangCode = i18n.language?.startsWith('zh') ? 'ZH' : 'EN'

  return (
    <main className="page-shell" data-accent={accentTheme}>
      <section className="morphz-shell" data-accent={accentTheme} data-view={view}>
        <header className="runtime-header">
          <button className="brand" type="button" onClick={() => setView('conversation')}>
            <span className="brand-mark">◆</span>
            <span><strong>Morphz</strong><small>{t('header.agentLabel', { title: selectedAgent?.title ?? (selectedAgentId || 'default') })}</small></span>
          </button>

          <div className="identity-trail">
            <button className={`identity-chip ${view === 'mind' ? 'is-active' : ''} ${!selectedContext ? 'unset' : ''}`} type="button" onClick={() => setView('mind')}>
              <small>{t('header.context').toUpperCase()}</small>
              <strong>{selectedContext?.title ?? (selectedContextId || t('header.noContext'))}</strong>
              <span>{t('common.shared')} · r{contextView?.state.version ?? 0}</span>
            </button>
            <span className="trail-separator">/</span>
            <button className={`identity-chip tasks-chip ${view === 'work' ? 'is-active' : ''}`} type="button" onClick={() => setView('work')}>
              <small>{t('work.title').toUpperCase()}</small>
              <strong>{activeWorkCount > 0 ? t('work.executingCount', { count: activeWorkCount }) : t('work.heading')}</strong>
              <span>{t('work.taskSummary', { waiting: waitingCount, objectives: activeObjectives.length })}</span>
            </button>
            <span className="trail-separator">/</span>
            <div className="session-selector" ref={sessionSelectorRef}>
              <button className={`identity-chip session-chip ${!selectedSession ? 'unset' : ''}`} type="button" onClick={() => setSessionMenuOpen(open => !open)}>
                <small>{t('header.session').toUpperCase()}</small>
                <strong>{selectedSession?.title ?? (selectedSessionId || t('header.noSession'))}</strong>
                <span>{statusLabel(selectedSession?.attention_state ?? 'active', t)} · {shortId(selectedSessionId, 11)}</span>
                <ChevronDown size={13} />
              </button>
              {sessionMenuOpen && (
                <div className="session-popover">
                  <header><span>{t('header.visibleSessions').toUpperCase()}</span><strong>{t('header.sessionsInContext', { count: visibleSessions.length })}</strong></header>
                  <div className="session-options">
                    {visibleSessions.map(session => (
                      <button className={session.id === selectedSessionId ? 'is-current' : ''} key={session.id} type="button" onClick={() => chooseSession(session)}>
                        <i className={`presence ${session.attention_state ?? 'active'}`} />
                        <span><strong>{session.title}</strong><small>{shortId(session.id, 25)} · {formatAgo(session.last_activity_at, t)}</small></span>
                        <em>{session.id === selectedSessionId ? t('header.active').toUpperCase() : statusLabel(session.attention_state ?? 'resident', t).toUpperCase()}</em>
                      </button>
                    ))}
                  </div>
                  <footer>{t('header.dashboardHint')}</footer>
                </div>
              )}
            </div>
          </div>

          <div className="runtime-side">
            <div className="theme-selector" ref={themeSelectorRef}>
              <button className="theme-button" type="button" aria-expanded={themeMenuOpen} onClick={() => setThemeMenuOpen(open => !open)}>
                <Palette size={15} />
                <span>{currentTheme ? t(currentTheme.labelKey) : ''}</span>
                <ChevronDown size={12} />
              </button>
              {themeMenuOpen && (
                <div className="theme-popover">
                  <header><span>{t('theme.title').toUpperCase()}</span><strong>{t('theme.hint')}</strong></header>
                  {accentThemes.map(theme => (
                    <button className={theme.id === accentTheme ? 'is-selected' : ''} key={theme.id} type="button" onClick={() => { setAccentTheme(theme.id); setThemeMenuOpen(false) }}>
                      <i className={`theme-swatch ${theme.id}`} />
                      <span><strong>{t(theme.labelKey)}</strong><small>{t(theme.descKey)}</small></span>
                      <em>{theme.id === accentTheme ? t('header.active').toUpperCase() : ''}</em>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <label className="reasoning-control" title={t('reasoning.title')}>
              <span>{t('reasoning.label').toUpperCase()}</span>
              <select
                aria-label={t('reasoning.label')}
                disabled={changingReasoning}
                value={status?.reasoning_effort ?? 'default'}
                onChange={event => void changeReasoningEffort(event.target.value)}
              >
                <option value="default">{t('reasoning.default')}</option>
                <option value="low">{t('reasoning.low')}</option>
                <option value="medium">{t('reasoning.medium')}</option>
                <option value="high">{t('reasoning.high')}</option>
              </select>
            </label>
            <button
              className={`theme-button reasoning-summary-toggle ${showReasoningSummary ? 'is-active' : ''}`}
              type="button"
              aria-pressed={showReasoningSummary}
              title={t('reasoningSummary.toggleTitle')}
              onClick={() => setShowReasoningSummary(current => !current)}
            >
              <Brain size={15} />
              <span>{t('reasoningSummary.toggle')}</span>
            </button>
            <button
              className="theme-button"
              type="button"
              title={t('language.toggle')}
              onClick={() => { void i18n.changeLanguage(i18n.language?.startsWith('zh') ? 'en' : 'zh') }}
            >
              <Globe size={15} />
              <span>{currentLangCode}</span>
            </button>
          </div>
        </header>

        <div
          className="view-frame"
          ref={viewFrameRef}
          onScroll={event => {
            if (view !== 'conversation') return
            // Ignore the scroll events fired by our own programmatic scrolling;
            // content growth between the scroll and the event would otherwise
            // look like the user scrolled away from the bottom.
            if (Date.now() - lastProgrammaticScroll.current < 120) return
            const container = event.currentTarget
            conversationPinnedToEnd.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48
          }}
        >
          {view === 'conversation' && (
            <section className="conversation-view">
              <header className="section-heading"><span>{t('conversation.heading', { title: selectedSession?.title ?? shortId(selectedSessionId) })}</span></header>
              <div className="message-list">
                {conversationEvents.length === 0 && conversationStreamingAttempts.length === 0 && (
                  <div className="empty-state conversation-empty">
                    <div className="empty-icon"><MessageSquare size={28} /></div>
                    <strong>{t('conversation.emptyTitle')}</strong>
                    <span dangerouslySetInnerHTML={{ __html: t('conversation.emptyDescription') }} />
                    <button className="empty-action" type="button" onClick={() => { const ta = document.querySelector('.composer textarea') as HTMLTextAreaElement | null; ta?.focus() }}>
                      <Send size={13} /> {t('conversation.startChat')}
                    </button>
                  </div>
                )}
                {conversationEvents.map(event => {
                  const kind = eventKind(event) ?? 'system'
                  if (kind === 'progress') {
                    return <div className="progress-note" key={event.id}><i /> <span>{event.payload.text}</span><time>{formatTime(event.timestamp, i18n.language)}</time></div>
                  }
                  const threadKind = typeof event.payload.thread_kind === 'string' ? event.payload.thread_kind : 'dialogue'
                  const persistedReasoningSummary = kind === 'agent' || kind === 'background'
                    ? findReasoningSummaryForPayload(durableReasoningSummaries, event.payload)
                    : undefined
                  const role = kind === 'user'
                    ? t('conversation.roleYou')
                    : kind === 'agent'
                      ? t('conversation.roleAgent')
                      : kind === 'background'
                        ? threadKind === 'objective' ? t('conversation.roleObjective') : t('conversation.roleWork')
                        : t('conversation.roleRuntime')
                  const showRole = kind === 'background' || kind === 'system'
                  return (
                    <article className={`message-row ${kind}`} key={event.id}>
                      {showRole && (
                        <div className="message-role">
                          <strong>{role}</strong>
                          <time>{formatTime(event.timestamp, i18n.language)}</time>
                          {kind === 'background' && <small>{shortId(String(event.payload.root_turn_id ?? ''), 18)}</small>}
                        </div>
                      )}
                      {persistedReasoningSummary && (
                        <ReasoningSummaryBlock
                          summary={persistedReasoningSummary.text}
                          live={false}
                          open={showReasoningSummary}
                          onOpenChange={setShowReasoningSummary}
                          title={t('reasoningSummary.title')}
                          liveLabel={t('reasoningSummary.live')}
                          persistedLabel={t('reasoningSummary.persisted')}
                        />
                      )}
                      <div className="message-body">
                        {typeof event.payload.text === 'string' && event.payload.text.trim()
                          ? <ReactMarkdown
                              remarkPlugins={[remarkGfm, remarkBreaks]}
                              components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
                            >
                              {event.payload.text}
                            </ReactMarkdown>
                          : t('conversation.noText')}
                      </div>
                      {!showRole && (
                        <div className="message-meta">
                          <time className="message-time">{formatTime(event.timestamp, i18n.language)}</time>
                          <button
                            className="message-copy"
                            type="button"
                            title={copiedMessageId === event.id ? t('conversation.copied') : t('conversation.copy')}
                            onClick={() => void copyMessage(event.payload.text ?? '', event.id)}
                          >
                            {copiedMessageId === event.id ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      )}
                    </article>
                  )
                })}
                {conversationStreamingAttempts.map(attempt => (
                  <article className="message-row agent streaming" key={`stream-${attempt.attemptId}`} aria-live="polite">
                    <ReasoningSummaryBlock
                      summary={attempt.reasoningSummary}
                      live
                      open={showReasoningSummary}
                      onOpenChange={setShowReasoningSummary}
                      title={t('reasoningSummary.title')}
                      liveLabel={t('reasoningSummary.live')}
                      persistedLabel={t('reasoningSummary.persisted')}
                    />
                    <div className="message-body">
                      {attempt.text.trim()
                        ? <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkBreaks]}
                            components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
                          >
                            {attempt.text}
                          </ReactMarkdown>
                        : attempt.error ?? t('conversation.streaming')}
                      {attempt.status !== 'failed' && <span className="stream-caret" aria-hidden="true" />}
                    </div>
                    <div className="message-meta stream-meta">
                      <span>{attempt.status === 'failed' ? t('conversation.streamFailed') : t('conversation.streaming')}</span>
                    </div>
                  </article>
                ))}
                {turnPending && conversationStreamingAttempts.length === 0 && (
                  <article className="message-row agent streaming" role="status" aria-live="polite">
                    <div className="message-body">
                      <span className="stream-typing" aria-hidden="true"><b /><b /><b /></span>
                    </div>
                    <div className="message-meta stream-meta">
                      <span>{turnStatus}</span>
                    </div>
                  </article>
                )}
                <div ref={conversationEnd} />
              </div>
            </section>
          )}

          {view === 'work' && (
            <section className="work-view">
              <header className="workspace-heading">
                <div><span>{t('work.title').toUpperCase()}</span><h1>{t('work.heading')}</h1><p>{t('work.description')}</p></div>
                <div className="workspace-actions">
                  <button type="button" onClick={() => void loadSession(selectedSessionId, selectedContextId)}><RefreshCw size={14} /> {t('work.refresh')}</button>
                  <button type="button" onClick={() => setView('conversation')}><ArrowLeft size={14} /> {t('work.backToChat')}</button>
                </div>
              </header>

              <div className="work-metrics">
                <div><CircleDot size={17} /><span><small>{t('work.metrics.active').toUpperCase()}</small><strong>{activeWorkCount}</strong></span></div>
                <div><Clock3 size={17} /><span><small>{t('work.metrics.waiting').toUpperCase()}</small><strong>{waitingCount}</strong></span></div>
                <div><Radio size={17} /><span><small>{t('work.metrics.pendingSignals').toUpperCase()}</small><strong>{threadSignals.length}</strong></span></div>
                <div><Layers3 size={17} /><span><small>{t('work.metrics.objectives').toUpperCase()}</small><strong>{activeObjectives.length}</strong></span></div>
              </div>

              {liveWorkStreamingAttempts.length > 0 && (
                <section className="model-evaluation-board live">
                  <header>
                    <span>{t('reasoningSummary.workLiveTitle').toUpperCase()}</span>
                    <b>{liveWorkStreamingAttempts.length}</b>
                    <small>{t('reasoningSummary.workLiveSubtitle')}</small>
                  </header>
                  <div className="model-evaluation-list">
                    {liveWorkStreamingAttempts.map(attempt => (
                      <article className="model-evaluation-row" key={`work-stream-${attempt.attemptId}`}>
                        <div className="model-evaluation-meta">
                          <span className="status-pill running">{t('reasoningSummary.streaming')}</span>
                          <strong>{shortId(attempt.workItemId, 28)}</strong>
                          <small>{t('reasoningSummary.toolCalls', { count: attempt.toolCallCount })}</small>
                        </div>
                        <ReasoningSummaryBlock
                          summary={attempt.reasoningSummary}
                          live
                          open={showReasoningSummary}
                          onOpenChange={setShowReasoningSummary}
                          title={t('reasoningSummary.title')}
                          liveLabel={t('reasoningSummary.live')}
                          persistedLabel={t('reasoningSummary.persisted')}
                        />
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {durableWorkReasoningSummaries.length > 0 && (
                <section className="model-evaluation-board persisted">
                  <header>
                    <span>{t('reasoningSummary.workHistoryTitle').toUpperCase()}</span>
                    <b>{durableWorkReasoningSummaries.length}</b>
                    <small>{t('reasoningSummary.workHistorySubtitle')}</small>
                  </header>
                  <div className="model-evaluation-list">
                    {durableWorkReasoningSummaries.slice(-12).reverse().map(summary => (
                      <article className="model-evaluation-row" key={summary.eventId}>
                        <div className="model-evaluation-meta">
                          <span className="status-pill completed">{t('reasoningSummary.persistedShort')}</span>
                          <strong>{shortId(summary.workItemId, 28)}</strong>
                          <time>{formatTime(summary.timestamp, i18n.language)}</time>
                        </div>
                        <ReasoningSummaryBlock
                          summary={summary.text}
                          live={false}
                          open={showReasoningSummary}
                          onOpenChange={setShowReasoningSummary}
                          title={t('reasoningSummary.title')}
                          liveLabel={t('reasoningSummary.live')}
                          persistedLabel={t('reasoningSummary.persisted')}
                        />
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {attentionCount > 0 && (
                <section className="attention-board">
                  <header><span>{t('work.attention.title').toUpperCase()}</span><b>{attentionCount}</b><small>{t('work.attention.subtitle')}</small></header>
                  <div className="attention-list">
                    {pendingApprovals.map(approval => (
                      <article className="attention-card approval" key={approval.id}>
                        <div><span className="status-pill pending_human">{t('work.approvals.needsYou')}</span><time>{formatAgo(approval.created_at, t)}</time></div>
                        <h2>{approval.justification}</h2>
                        {approval.risk_tags.length > 0 && <small>{approval.risk_tags.join(' · ')}</small>}
                        <div className="approval-actions">
                          <button disabled={decidingApprovalId === approval.id} type="button" onClick={() => void decideApproval(approval, 'allow_once')}><Check size={13} /> {t('work.approvals.allowOnce')}</button>
                          <button disabled={decidingApprovalId === approval.id} className="danger" type="button" onClick={() => void decideApproval(approval, 'deny')}><Square size={12} /> {t('work.approvals.deny')}</button>
                        </div>
                      </article>
                    ))}
                    {failedSchedulerJobs.map(snapshot => (
                      <article className="attention-card failure" key={snapshot.job.id}>
                        <div><span className="status-pill failed">{statusLabel(snapshot.job.status, t)}</span><time>{formatAgo(snapshot.job.updated_at, t)}</time></div>
                        <h2>{snapshot.job.tool_name}</h2>
                        <p>{snapshot.job.error ?? t('work.attention.jobFailed')}</p>
                      </article>
                    ))}
                    {failedDeliveries.map(snapshot => (
                      <article className="attention-card delivery" key={snapshot.thread.id}>
                        <div><span className="status-pill deferred">{statusLabel(snapshot.thread.delivery_status, t)}</span><time>{formatAgo(snapshot.thread.updated_at, t)}</time></div>
                        <h2>{t('work.attention.deliveryFailed')}</h2>
                        <p>{snapshot.thread.result_text ?? shortId(snapshot.thread.id, 30)}</p>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              <section className="objective-board">
                <header><span>{t('work.objectives.title').toUpperCase()}</span><b>{activeObjectives.length}</b><small>{t('work.objectives.confirm')}</small></header>
                <div className="objective-grid">
                  {activeObjectives.map(objective => (
                    <article className="work-card" key={objective.id}>
                      <div className="card-line"><span className={`status-pill ${objective.status}`}>{statusLabel(objective.status, t)}</span><time>{formatAgo(objective.updated_at, t)}</time></div>
                      <h2 title={objective.stated_objective}><MarkdownInline>{objective.stated_objective}</MarkdownInline></h2>
                      {objective.status_reason && <p title={objective.status_reason}><MarkdownInline>{objective.status_reason}</MarkdownInline></p>}
                      <footer><span>{t('work.objectives.revision', { revision: objective.revision })}</span><span>{t('work.objectives.tokens', { tokens: compactTokens(objective.tokens_used) })}</span><span>{t('work.objectives.seconds', { seconds: objective.time_used_seconds })}</span><span>{shortId(objective.coordinator_session_id)}</span></footer>
                      {objective.wait_condition && <div className="wait-condition">{t('work.objectives.waitCondition', { kind: objective.wait_condition.kind })}</div>}
                      <div className="objective-actions">
                        {(objective.status === 'blocked' || objective.status === 'paused') && (
                          <button
                            className="resume-objective"
                            disabled={Boolean(resumingObjectiveId || deletingObjectiveId)}
                            type="button"
                            onClick={() => void resumeObjective(objective)}
                          >
                            {resumingObjectiveId === objective.id ? <LoaderCircle size={13} /> : <Play size={13} />}
                            {resumingObjectiveId === objective.id ? t('work.objectives.resuming') : t('work.objectives.resume')}
                          </button>
                        )}
                        <button
                          className="delete-objective"
                          disabled={Boolean(resumingObjectiveId || deletingObjectiveId)}
                          type="button"
                          onClick={() => void deleteObjective(objective)}
                        >
                          {deletingObjectiveId === objective.id ? <LoaderCircle size={13} /> : <Trash2 size={13} />}
                          {deletingObjectiveId === objective.id ? t('work.objectives.deleting') : t('work.objectives.delete')}
                        </button>
                      </div>
                    </article>
                  ))}
                  {activeObjectives.length === 0 && <div className="small-empty">{t('work.objectives.empty')}</div>}
                </div>
              </section>

              {schedulerSnapshot && (
                <section className={`admission-board ${schedulerSnapshot.admission.context_deferred > 0 ? 'pressured' : ''}`}>
                  <header><span>{t('work.admission.title').toUpperCase()}</span><b>{schedulerSnapshot.admission.context_in_flight}/{schedulerSnapshot.admission.total_slots}</b><small>{t('work.admission.subtitle')}</small></header>
                  <div className="admission-line">
                    <span>{t('work.admission.inFlight', { count: schedulerSnapshot.admission.context_in_flight })}</span>
                    <span>{t('work.admission.loaded', { count: schedulerSnapshot.admission.context_loaded_queued })}</span>
                    <span>{t('work.admission.durable', { count: schedulerSnapshot.admission.context_durable_queued })}</span>
                    <span className={schedulerSnapshot.admission.context_deferred > 0 ? 'warning' : ''}>{t('work.admission.deferred', { count: schedulerSnapshot.admission.context_deferred })}</span>
                    <span>{t('work.admission.reserved', { count: schedulerSnapshot.admission.dialogue_delivery_slots })}</span>
                  </div>
                </section>
              )}

              <section className="causal-board">
                <header><span>{t('work.causal.title').toUpperCase()}</span><b>{schedulerThreads.length}</b><small>{t('work.causal.subtitle')}</small></header>
                <div className="causal-thread-list">
                  {schedulerThreads.map(snapshot => (
                    <ThreadCausalCard
                      key={snapshot.thread.id}
                      snapshot={snapshot}
                      t={t}
                      locale={i18n.language}
                      decidingApprovalId={decidingApprovalId}
                      mutatingScheduleId={mutatingScheduleId}
                      onApproval={(approval, decision) => void decideApproval(approval, decision)}
                      onSchedule={(schedule, action) => void mutateSchedule(schedule, action)}
                    />
                  ))}
                  {schedulerThreads.length === 0 && <div className="small-empty">{t('work.causal.empty')}</div>}
                </div>
                {schedulerSnapshot && (
                  schedulerSnapshot.orphan_activations.length > 0
                  || schedulerSnapshot.orphan_jobs.length > 0
                  || schedulerSnapshot.orphan_signals.length > 0
                  || schedulerSnapshot.orphan_approvals.length > 0
                ) && (
                  <details className="scheduler-diagnostics">
                    <summary>{t('work.causal.diagnostics')} · {schedulerSnapshot.orphan_activations.length + schedulerSnapshot.orphan_jobs.length + schedulerSnapshot.orphan_signals.length + schedulerSnapshot.orphan_approvals.length}</summary>
                    <pre>{JSON.stringify({
                      activations: schedulerSnapshot.orphan_activations,
                      jobs: schedulerSnapshot.orphan_jobs,
                      signals: schedulerSnapshot.orphan_signals,
                      approvals: schedulerSnapshot.orphan_approvals,
                    }, null, 2)}</pre>
                  </details>
                )}
              </section>

              <section className="delegation-board">
                <header><span>{t('work.delegations.title').toUpperCase()}</span><b>{contextDelegations.length}</b><small>{t('work.delegations.subtitle')}</small></header>
                <div className="delegation-list">
                  {contextDelegations.slice(0, 50).map(delegation => (
                    <article className="work-card compact" key={delegation.id}>
                      <div className="card-line"><span className={`status-pill ${delegation.status}`}>{statusLabel(delegation.status, t)}</span><time>{formatAgo(delegation.updated_at, t)}</time></div>
                      <h2 title={delegation.task}><MarkdownInline>{delegation.task}</MarkdownInline></h2>
                      <footer><span>{shortId(delegation.parent_session_id)}</span><span>→</span><span>{shortId(delegation.child_session_id)}</span></footer>
                    </article>
                  ))}
                  {contextDelegations.length === 0 && <div className="small-empty">{t('work.delegations.empty')}</div>}
                </div>
              </section>

              <section className="tool-timeline">
                <header><span>{t('work.toolTimeline.title').toUpperCase()}</span><b>{toolTimeline.length}</b><small>{t('work.toolTimeline.subtitle')}</small></header>
                <div
                  className="tool-timeline-list"
                  ref={toolTimelineList}
                  tabIndex={0}
                  aria-label={t('work.toolTimeline.ariaLabel')}
                  onScroll={event => {
                    const list = event.currentTarget
                    toolTimelinePinnedToEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
                  }}
                >
                  {toolTimeline.map(call => {
                    const failed = ['error', 'timeout', 'rejected', 'failed'].includes(call.status)
                    const summary = summarizeToolCall(call.name, call.arguments, t)
                    return (
                      <details className={`tool-step ${failed ? 'failed' : call.status === 'running' ? 'running' : 'completed'}`} key={call.id} open={call.status === 'running'}>
                        <summary>
                          <i>{call.status === 'running' ? <LoaderCircle size={13} /> : failed ? '!' : '✓'}</i>
                          <span className="tool-step-summary">
                            <strong>{summary.title}</strong>
                            <small>{summary.target}</small>
                            <code>{summary.detail} · {shortId(call.id, 20)}</code>
                          </span>
                          <em>{statusLabel(call.status, t)}</em>
                          <time>{formatTime(call.timestamp, i18n.language)}</time>
                          <ChevronDown size={13} />
                        </summary>
                        <div className="tool-step-detail">
                          <section><header>{t('work.toolTimeline.parameters')}{call.truncated ? t('work.toolTimeline.truncated', { chars: call.arguments_chars ?? '?' }) : ''}</header><pre>{call.arguments}</pre></section>
                          {call.result !== undefined && <section><header>{t('work.toolTimeline.result', { status: statusLabel(call.status, t) })}</header><pre>{call.result.slice(0, 6000) || t('work.toolTimeline.noOutput')}</pre></section>}
                        </div>
                      </details>
                    )
                  })}
                  {toolTimeline.length === 0 && <div className="small-empty">{t('work.toolTimeline.empty')}</div>}
                </div>
              </section>
            </section>
          )}

          {view === 'mind' && (
            <section className="mind-view">
              <header className="workspace-heading">
                <div><span>{t('mindView.title').toUpperCase()}</span><h1>{t('mindView.heading')}</h1><p>{t('mindView.description')}</p></div>
                <button type="button" onClick={() => setView('conversation')}><ArrowLeft size={14} /> {t('mindView.backToChat')}</button>
              </header>

              <div className="mind-metrics">
                <div><Brain size={18} /><span><small>{t('mindView.metrics.frames').toUpperCase()}</small><strong>{contextView?.state.frames.length ?? 0}</strong></span></div>
                <div><GitBranch size={18} /><span><small>{t('mindView.metrics.relations').toUpperCase()}</small><strong>{contextView?.state.relations.length ?? 0}</strong></span></div>
                <div><Database size={18} /><span><small>{t('mindView.metrics.observations').toUpperCase()}</small><strong>{contextView?.observations.length ?? 0}</strong></span></div>
                <div><Layers3 size={18} /><span><small>{t('mindView.metrics.residentSessions').toUpperCase()}</small><strong>{contextView?.session_working_set.full_session_ids.length ?? 0}</strong></span></div>
              </div>

              <div className="mind-grid">
                <div className="frame-library">
                  <header><span>{t('mindView.frameLibrary').toUpperCase()}</span><b>r{contextView?.state.version ?? 0}</b></header>
                  <div className="frame-list">
                    {(contextView?.state.frames ?? []).map(frame => (
                      <button className={frame.id === selectedFrameId ? 'is-selected' : ''} key={frame.id} type="button" onClick={() => setSelectedFrameId(frame.id)}>
                        <span><strong>{frame.id}</strong><small>r{frame.revision} · v{frame.updated_version} · {t('mindView.sourceCount', { count: frame.sources.length })}</small></span>
                        {retired.has(frame.id) && <em>{t('mindView.retired').toUpperCase()}</em>}
                      </button>
                    ))}
                  </div>
                </div>

                <article className="frame-inspector">
                  {selectedFrame ? (
                    <>
                      <header><span><small>{t('mindView.frame').toUpperCase()}</small><strong>{selectedFrame.id}</strong></span><em>{t('mindView.revision', { revision: selectedFrame.revision })}</em></header>
                      <pre>{selectedFrame.body}</pre>
                      <div className="frame-meta">
                        <div><small>{t('mindView.created').toUpperCase()}</small><strong>v{selectedFrame.created_version}</strong></div>
                        <div><small>{t('mindView.updated').toUpperCase()}</small><strong>v{selectedFrame.updated_version}</strong></div>
                        <div><small>{t('mindView.sources').toUpperCase()}</small><strong>{selectedFrame.sources.length}</strong></div>
                        <div><small>{t('mindView.protected').toUpperCase()}</small><strong>{contextView?.state.protected.includes(selectedFrame.id) ? t('mindView.yes') : t('mindView.no')}</strong></div>
                      </div>
                      {selectedFrame.sources.length > 0 && <div className="source-list">{selectedFrame.sources.map(source => <span key={source}>{source}</span>)}</div>}
                      <section className="relations"><h3>{t('mindView.relationsTitle').toUpperCase()}</h3>{(contextView?.state.relations ?? []).filter(item => item.subject === selectedFrame.id || item.object === selectedFrame.id).map((item, index) => <div key={`${item.subject}-${item.relation}-${item.object}-${index}`}><span>{item.subject}</span><b>{item.relation}</b><span>{item.object}</span></div>)}</section>
                    </>
                  ) : <div className="small-empty">{t('mindView.emptyFrame')}</div>}
                </article>
              </div>

              <section className="context-facts">
                <div><small>{t('mindView.sessionWindow').toUpperCase()}</small><strong>{Math.round((contextView?.session_working_set.active_window_secs ?? 0) / 3600)}h</strong><span>{t('mindView.sessionWindowDetail', { count: contextView?.session_working_set.max_sessions ?? 0 })}</span></div>
                <div><small>{t('mindView.pressure').toUpperCase()}</small><strong>{statusLabel(contextView?.pressure.level ?? 'normal', t)}</strong><span>{contextView?.pressure.token_accuracy ?? 'estimate'}</span></div>
                <div><small>{t('mindView.checkpoints').toUpperCase()}</small><strong>{contextView?.state.checkpoints.length ?? 0}</strong><span>{t('mindView.checkpointsDetail')}</span></div>
                <div><small>{t('mindView.retiredCount').toUpperCase()}</small><strong>{contextView?.state.retired.length ?? 0}</strong><span>{t('mindView.retiredDetail')}</span></div>
              </section>
            </section>
          )}
        </div>

        <footer className="composer-area">
          <div className="composer-status">
            <button className={`composer-task-status ${taskStrip.state}`} type="button" onClick={() => setView(current => current === 'work' ? 'conversation' : 'work')} title={t('nav.toggleTasks')}>
              <i className={activeWorkCount || turnPending ? 'busy' : taskStrip.state} />
              <strong>{turnPending ? turnStatus : taskStrip.label}</strong>
              {!turnPending && <span>{taskStrip.summary}</span>}
              <em>{t('composer.status.summary', { executing: activeWorkCount, waiting: waitingCount })}</em>
            </button>
            <div className="composer-runtime-meta">
              <span
                className={`token-usage pressure-${contextView?.pressure.level ?? 'normal'}`}
                title={t('model.tokens', { used: compactTokens(contextView?.pressure.estimated_tokens), limit: compactTokens(contextView?.pressure.hard_limit) })}
              >
                {compactTokens(contextView?.pressure.estimated_tokens)} / {compactTokens(contextView?.pressure.hard_limit)}
              </span>
              <span className={`model-status ${status?.model ? 'ok' : ''}`}>{status?.model ?? t('model.unavailable')}</span>
              <span className="connection-status" title={t('nav.connection')}><i className={`status-dot ${wsStatus === 'connected' ? '' : wsStatus === 'connecting' ? 'connecting' : 'disconnected'}`} />{t(`connection.${wsStatus}`)}</span>
            </div>
          </div>
          <div className="composer">
            <span className="composer-prompt">›</span>
            <textarea
              ref={composerInputRef}
              aria-label={t('composer.inputAriaLabel')}
              disabled={!selectedSessionId || sending}
              onChange={event => setMessage(event.target.value)}
              onCompositionStart={() => { composingInput.current = true }}
              onCompositionEnd={() => { composingInput.current = false }}
              onKeyDown={event => {
                if (composingInput.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              placeholder={selectedSessionId ? t('composer.placeholder') : t('composer.noSessionPlaceholder')}
              rows={1}
              value={message}
            />
            {activeWorkCount > 0 ? (
              <button className="cancel-button" type="button" title={t('composer.cancelTitle')} onClick={() => void cancelCurrentSession()}><Square size={14} /></button>
            ) : null}
            <button className="send-button" disabled={!message.trim() || sending || !selectedSessionId} type="button" onClick={() => void sendMessage()}><Send size={15} /><span>{t('composer.send')}</span></button>
          </div>
          <div className="shortcut-row"><span>{t('composer.shortcuts.send')}</span><span>{t('composer.shortcuts.newline')}</span><span>{t('composer.shortcuts.tasks')}</span><span>{t('composer.shortcuts.mind')}</span><span>{t('composer.shortcuts.back')}</span></div>
          {error && <div className="error-banner">{error}</div>}
        </footer>
      </section>
    </main>
  )
}
