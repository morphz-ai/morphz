import { memo, startTransition, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Archive,
  Bell,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Columns2,
  Copy,
  Database,
  Eye,
  GitBranch,
  Globe,
  Layers3,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Square,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'
import { nextDashboardLanguage } from './i18n/language'
import {
  createLiveModelState,
  findReasoningSummaryChainForPayload,
  isModelStreamEvent,
  liveReasoningSummaryText,
  modelStreamReducer,
  readReasoningSummaryPreference,
  reasoningSummaryStorageKey,
  selectDurableReasoningSummaries,
  selectReasoningContinuationSummaries,
  visibleLiveModelAttempts,
  type LiveModelAttempt,
  type ModelAttemptStateItem,
  type ModelStreamBatchItem,
} from './modelStream'
import {
  attentionDeliveryKey,
  attentionJobKey,
  actionableSchedulerJobs,
  pendingHumanApprovals,
  schedulerApprovalAnomalies,
  schedulerAttentionJobs,
  schedulerSchedules,
  threadCarriesExecution,
} from './scheduler/model'
import { findTurnSettlement } from './turnSettlement'
import type {
  ApprovalRecord,
  ScheduleRecord,
  SchedulerSnapshot,
  SchedulerThreadSnapshot,
  ThreadDetailResponse,
  ThreadActivationRecord,
  ThreadSignalRecord,
  ThreadRecord,
} from './scheduler/types'
import {
  dashboardPath,
  parseDashboardRoute,
  threadPath,
  type CognitionView,
  type DashboardView,
} from './app/routes'
import { LedgerPage } from './pages/LedgerPage'
import type { LedgerFilters } from './pages/LedgerPage'
import { OverviewPage } from './pages/OverviewPage'
import { RuntimePage } from './pages/RuntimePage'
import { ThreadCausalCard } from './pages/ThreadCausalCard'
import { DashboardApiClient } from './api/client'
import { resolveDashboardToken } from './api/auth'
import { invalidatedQueriesForTopic } from './app/invalidation'
import { copyTextToClipboard } from './utils/clipboard'
import {
  compactTokens,
  conversationEventKind,
  conversationEventLane,
  formatAgo,
  formatTime,
  shortId,
  statusLabel,
  summarizeToolCall,
  threadKindLabel,
} from './app/presentation'

function MessageThreadReference({
  snapshot,
  onOpen,
  t,
}: {
  snapshot: SchedulerThreadSnapshot
  onOpen: () => void
  t: TFunction
}) {
  const jobs = snapshot.activations
    .flatMap((activation, activationIndex) => activation.jobs.map((job, jobIndex) => ({
      snapshot: job,
      order: activationIndex * 10_000 + jobIndex,
    })))
    .sort((left, right) => left.snapshot.job.created_at.localeCompare(right.snapshot.job.created_at) || left.order - right.order)
  const displayState = snapshot.phase === 'idle' ? snapshot.thread.lifecycle : snapshot.phase
  const previewId = `thread-tool-chain-${snapshot.thread.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`

  return (
    <div className={`message-thread-reference phase-${snapshot.phase}`}>
      <button
        className="message-thread-capsule"
        type="button"
        onClick={onOpen}
        aria-describedby={previewId}
        aria-label={`${threadKindLabel(snapshot.thread.kind, t)} · ${statusLabel(displayState, t)} · ${t('conversation.threadJobs', { count: jobs.length })}`}
      >
        <span className="message-thread-mark" aria-hidden="true"><GitBranch size={13} /></span>
        <span className="message-thread-copy">
          <strong>{threadKindLabel(snapshot.thread.kind, t)}</strong>
          <small><i className={`thread-state-dot ${displayState}`} />{statusLabel(displayState, t)} · {t('conversation.threadJobs', { count: jobs.length })}</small>
        </span>
        <code>{shortId(snapshot.thread.id, 18)}</code>
        <ChevronRight className="message-thread-open" size={13} aria-hidden="true" />
      </button>

      <aside className="message-thread-toolchain" id={previewId} role="tooltip">
        <header>
          <span><GitBranch size={12} />{t('conversation.threadToolChain')}</span>
          <small>{t('conversation.threadJobs', { count: jobs.length })}</small>
        </header>
        {jobs.length > 0 ? (
          <ol>
            {jobs.map(({ snapshot: jobSnapshot }) => {
              const { job } = jobSnapshot
              const summary = summarizeToolCall(job.tool_name, JSON.stringify(job.request), t)
              const failed = job.status === 'failed' || job.status === 'lost'
              return (
                <li className={job.status} key={job.id}>
                  <span className="toolchain-step" aria-hidden="true">
                    {job.status === 'running'
                      ? <LoaderCircle size={11} />
                      : job.status === 'succeeded'
                        ? <Check size={11} />
                        : failed
                          ? <X size={11} />
                          : <CircleDot size={10} />}
                  </span>
                  <span className="toolchain-copy">
                    <strong>{summary.title}</strong>
                    <small>{summary.target || shortId(job.id, 16)}</small>
                  </span>
                  <em>{statusLabel(job.status, t)}</em>
                </li>
              )
            })}
          </ol>
        ) : (
          <p>{t('conversation.threadToolChainEmpty')}</p>
        )}
        <footer>{t('conversation.threadToolChainHint')}</footer>
      </aside>
    </div>
  )
}

const configuredHttpUrl = import.meta.env.VITE_MORPHZ_HTTP_URL as string | undefined
const configuredWsUrl = import.meta.env.VITE_MORPHZ_WS_URL as string | undefined
const CORE_HTTP_URL = (configuredHttpUrl ?? window.location.origin).replace(/\/$/, '')
const CORE_WS_URL = configuredWsUrl ?? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
let dashboardTokenStorage: Storage | undefined
try {
  dashboardTokenStorage = window.sessionStorage
} catch {
  // Sandboxed/privacy-restricted documents can deny sessionStorage entirely.
}
const CORE_TOKEN = resolveDashboardToken(
  window.location,
  dashboardTokenStorage,
  import.meta.env.VITE_MORPHZ_TOKEN as string | undefined,
)
const DASHBOARD_API = new DashboardApiClient({ baseUrl: CORE_HTTP_URL, token: CORE_TOKEN })

type AccentTheme = 'iris' | 'cyan' | 'coral' | 'mono'
type AppearanceMode = 'system' | 'dark' | 'light'
type ContextInspectTab = 'encoding' | 'attribution' | 'messages' | 'tools' | 'mind' | 'inbox' | 'metadata'

interface AppDialogBase {
  id: number
  title: string
  description?: string
  confirmLabel: string
  cancelLabel: string
  tone?: 'default' | 'danger'
  returnFocus: HTMLElement | null
}

interface AppConfirmDialog extends AppDialogBase {
  kind: 'confirm'
  resolve: (confirmed: boolean) => void
}

interface AppPromptDialog extends AppDialogBase {
  kind: 'prompt'
  defaultValue: string
  inputLabel: string
  allowEmpty?: boolean
  placeholder?: string
  resolve: (value: string | null) => void
}

type AppDialogRequest = AppConfirmDialog | AppPromptDialog

interface AttentionAcknowledgement {
  event_id: string
  context_id: string
  key: string
  source_kind: string
  source_id: string
  source_revision: number
  acknowledged_by: string
  rationale?: string
  acknowledged_at: string
}

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

function initialAppearanceMode(): AppearanceMode {
  try {
    const saved = window.localStorage.getItem('morphz.dashboard.appearance')
    if (saved === 'system' || saved === 'dark' || saved === 'light') return saved
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'system'
}

function initialSystemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

function initialShowReasoningSummary(): boolean {
  try {
    return readReasoningSummaryPreference(window.localStorage)
  } catch {
    return false
  }
}

function initialBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(key)
    if (saved === 'true') return true
    if (saved === 'false') return false
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return fallback
}

type ConversationLayout = 'merged' | 'split'
type ConversationMobileLane = 'dialogue' | 'execution'

function initialConversationLayout(): ConversationLayout {
  try {
    const saved = window.localStorage.getItem('morphz.dashboard.conversationLayout')
    if (saved === 'merged' || saved === 'split') return saved
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'merged'
}

function useStoredDisclosure(key: string, fallback: boolean) {
  const [open, setOpen] = useState(() => initialBooleanPreference(key, fallback))
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(open))
    } catch {
      // The disclosure remains usable for the current page lifetime.
    }
  }, [key, open])
  return [open, setOpen] as const
}

const MESSAGE_PAGE_SIZE = 100
const MODEL_STREAM_RENDER_INTERVAL_MS = 50
const WORK_HISTORY_THREAD_LIMIT = 60
const SCHEDULER_HISTORY_PAGE_SIZE = 60
const DIALOGUE_ACTIVITY_HISTORY_LIMIT = 12

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

function AppDialog({
  request,
  onResolve,
}: {
  request: AppDialogRequest
  onResolve: (value: boolean | string | null) => void
}) {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.defaultValue : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (request.kind === 'prompt') {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else if (request.tone === 'danger') {
      cancelRef.current?.focus()
    } else {
      confirmRef.current?.focus()
    }
  }, [request.kind, request.tone])

  const cancel = () => onResolve(request.kind === 'confirm' ? false : null)
  const confirm = () => {
    if (request.kind === 'prompt') {
      const normalized = value.trim()
      if (!normalized && !request.allowEmpty) return
      onResolve(normalized)
      return
    }
    onResolve(true)
  }

  return (
    <div
      className="app-dialog-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) cancel()
      }}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        } else if (event.key === 'Enter' && !(event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
          event.preventDefault()
          confirm()
        }
      }}
    >
      <section
        aria-describedby={request.description ? `app-dialog-description-${request.id}` : undefined}
        aria-labelledby={`app-dialog-title-${request.id}`}
        aria-modal="true"
        className={`app-dialog ${request.tone === 'danger' ? 'is-danger' : ''}`}
        role="dialog"
      >
        <header>
          <div>
            <small>MORPHZ</small>
            <h2 id={`app-dialog-title-${request.id}`}>{request.title}</h2>
          </div>
          <button type="button" aria-label={request.cancelLabel} onClick={cancel}><X size={16} /></button>
        </header>
        {request.description && <p id={`app-dialog-description-${request.id}`}>{request.description}</p>}
        {request.kind === 'prompt' && (
          <label>
            <span>{request.inputLabel}</span>
            <input
              ref={inputRef}
              autoComplete="off"
              value={value}
              placeholder={request.placeholder}
              onChange={event => setValue(event.target.value)}
            />
          </label>
        )}
        <footer>
          <button ref={cancelRef} type="button" onClick={cancel}>{request.cancelLabel}</button>
          <button
            ref={confirmRef}
            className={request.tone === 'danger' ? 'danger' : 'primary'}
            disabled={request.kind === 'prompt' && !request.allowEmpty && !value.trim()}
            type="button"
            onClick={confirm}
          >
            {request.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}

// Markdown rendering is the expensive part of a message row. Memoizing it by
// text keeps every historical message from re-parsing on each stream delta.
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
    >
      {text}
    </ReactMarkdown>
  )
})

const ReasoningSummaryBlock = memo(function ReasoningSummaryBlock({
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
      {open && (
        <div className="reasoning-summary-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
          >
            {summary}
          </ReactMarkdown>
        </div>
      )}
    </details>
  )
})

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
  attention_revision?: number
  attention_reason?: string
  attention_changed_at?: string
  mount_kind?: string
  created_at: string
  updated_at: string
  last_activity_at: string
}

type ReasoningEffortSetting = 'none' | 'low' | 'medium' | 'high' | 'max'

interface RuntimeStatus {
  generated_at: string
  started: boolean
  uptime_seconds: number
  recovery: {
    preserved_execution_jobs: number
    requeued_execution_jobs: number
    lost_execution_jobs: number
    recovered_background_outboxes: number
    completed_at?: string
  }
  version: string
  git_commit: string
  agent_id: string
  context_id: string
  principal_id: string
  model: string
  provider?: string
  reasoning_effort?: ReasoningEffortSetting | null
  tool_count: number
  storage: string
  storage_backend: string
  permission_mode: string
  sandbox_mode: string
  reviewer: string
}

interface ExecutionTargetSummary {
  id: string
  revision: number
  name: string
  kind: string
  status: string
  platform?: string
  workspace_root?: string
  provider_node_id?: string
  capabilities: string[]
}

interface ExecutionNodeSummary {
  id: string
  revision: number
  name: string
  status: string
  platform?: string
  protocol_version: number
  capabilities: string[]
  last_seen_at?: string
}

interface CapabilityLeaseSummary {
  id: string
  revision: number
  thread_id: string
  target_id: string
  capabilities: string[]
  status: string
  expires_at: string
}

interface ExecutionJobSummary {
  id: string
  revision: number
  thread_id: string
  target_id: string
  tool_name: string
  status: string
  claimed_by?: string
  progress_ref?: string
  created_at: string
}

interface MindProjectionAudit {
  context_id: string
  ledger_revision: number
  projection_revision?: number
  snapshot_revision?: number
  ledger_hash: string
  projection_hash?: string
  events_scanned: number
  incremental_transactions_scanned?: number
  incremental_matches?: boolean
  full_replay_micros: number
  incremental_replay_micros?: number
  projection_validation_micros: number
  matches: boolean
}

function inferredProviderReasoningEffort(model?: string): ReasoningEffortSetting | 'default' {
  const normalized = model?.trim().toLowerCase() ?? ''
  return normalized === 'glm-5.2' || normalized.endsWith('/glm-5.2') ? 'max' : 'default'
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

function contextInspectMetadata(payload: EventPayload): EventPayload {
  const metadata = { ...payload }
  delete metadata.text
  delete metadata.messages
  delete metadata.tools
  delete metadata.mind
  delete metadata.inbox
  return metadata
}

interface PendingTurnState {
  startedAt: number
  rootTurnId: string | null
}

interface QuoteItem {
  id: string
  text: string
  eventId: string
  eventActor: string
  eventTime: string
  comment: string
  badgeTop: number
  badgeLeft: number
}

interface SelectionPopup {
  x: number
  y: number
  text: string
  eventId: string
  eventActor: string
  eventTime: string
  relTop: number
  relLeft: number
}

interface ContextFrame {
  id: string
  body: string
  sources: string[]
  provenance: {
    formed_principal_id?: string
    formed_session_id?: string
    source_principal_ids: string[]
    source_session_ids: string[]
    state: 'unknown' | 'unattributed' | 'attributed'
  }
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

interface FrameRetirement {
  frame_id: string
  requested_at_tick: number
  eligible_at_tick: number
  reason: string
}

interface MindState {
  version: number
  frames: ContextFrame[]
  relations: ContextRelation[]
  retired: string[]
  retiring: Record<string, FrameRetirement>
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

interface ContextAttributionComponent {
  kind: string
  id: string
  label: string
  weight_units: number
  estimated_tokens: number
  share: number
}

interface ContextAttribution {
  estimated_total_tokens: number
  total_weight_units: number
  weight_algorithm: string
  components: ContextAttributionComponent[]
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

type ObjectiveMutationKind = 'pause' | 'resume' | 'delete' | ''

function ObjectiveCardActions({
  objective,
  expanded,
  busy,
  disabled,
  t,
  onPause,
  onResume,
  onDelete,
  onToggle,
}: {
  objective: ObjectiveRecord
  expanded: boolean
  busy: ObjectiveMutationKind
  disabled: boolean
  t: TFunction
  onPause: () => void
  onResume: () => void
  onDelete: () => void
  onToggle: () => void
}) {
  const mutationPending = disabled || Boolean(busy)
  return (
    <div className="objective-card-actions">
      {objective.status === 'active' && (
        <button
          className="objective-card-action"
          type="button"
          disabled={mutationPending}
          aria-label={busy === 'pause' ? t('work.objectives.pausing') : t('work.objectives.pause')}
          title={busy === 'pause' ? t('work.objectives.pausing') : t('work.objectives.pause')}
          onClick={onPause}
        >
          {busy === 'pause' ? <LoaderCircle className="is-spinning" size={13} /> : <Pause size={13} />}
        </button>
      )}
      {(objective.status === 'blocked' || objective.status === 'paused') && (
        <button
          className="objective-card-action"
          type="button"
          disabled={mutationPending}
          aria-label={busy === 'resume' ? t('work.objectives.resuming') : t('work.objectives.resume')}
          title={busy === 'resume' ? t('work.objectives.resuming') : t('work.objectives.resume')}
          onClick={onResume}
        >
          {busy === 'resume' ? <LoaderCircle className="is-spinning" size={13} /> : <Play size={13} />}
        </button>
      )}
      <button
        className="objective-card-action danger"
        type="button"
        disabled={mutationPending}
        aria-label={busy === 'delete' ? t('work.objectives.deleting') : t('work.objectives.delete')}
        title={busy === 'delete' ? t('work.objectives.deleting') : t('work.objectives.delete')}
        onClick={onDelete}
      >
        {busy === 'delete' ? <LoaderCircle className="is-spinning" size={13} /> : <Trash2 size={13} />}
      </button>
      <button
        className="objective-card-action disclosure"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? t('work.objectives.collapse') : t('work.objectives.expand')}
        title={expanded ? t('work.objectives.collapse') : t('work.objectives.expand')}
        onClick={onToggle}
      >
        <ChevronDown size={14} />
      </button>
    </div>
  )
}

interface ProjectedSession {
  session: SessionRecord
  projection: string
  principal_ids?: string[]
  active_activation_ids?: string[]
  active_objective_ids?: string[]
}

interface ContextOverviewResponse {
  context: ContextRecord
  agent?: AgentRecord
  generated_at: string
  active_session_id?: string
  sessions: ProjectedSession[]
  working_set?: SessionWorkingSet
  mind_revision: number
  active_frames: number
  retiring_frames: number
  retired_items: number
  pressure?: ContextPressure
  attribution?: ContextAttribution
  objectives: ObjectiveRecord[]
  scheduler: SchedulerSnapshot['summary']
}

interface LedgerQueryResponse {
  context_id: string
  generated_at: string
  events: MorphzEvent[]
  scanned_count: number
  scan_exhaustive: boolean
  next_after_sequence?: number
  next_before_sequence?: number
}

interface ModelUsagePage {
  records: Array<{
    event_id: string
    sequence?: number
    timestamp: string
    attempt_id: string
    model?: string
    usage: {
      input_tokens?: number
      uncached_input_tokens?: number
      cached_input_tokens?: number
      cache_write_input_tokens?: number
      output_tokens?: number
      reasoning_tokens?: number
      total_tokens?: number
    }
  }>
  totals: {
    attempts: number
    input_tokens: number
    uncached_input_tokens: number
    cached_input_tokens: number
    cache_write_input_tokens: number
    output_tokens: number
    reasoning_tokens: number
    total_tokens: number
  }
  cost_totals: Array<{
    amount: number
    currency: string
    pricing_version: string
    priced_attempts: number
  }>
  next_before_sequence?: number
}

interface ContextViewResponse {
  context_id: string
  active_session_id: string
  active_principal_id?: string
  sessions: ProjectedSession[]
  session_working_set: SessionWorkingSet
  active_activations: ThreadActivationRecord[]
  threads: ThreadRecord[]
  thread_signals: ThreadSignalRecord[]
  thread_phases: Record<string, 'idle' | 'runnable' | 'running' | 'waiting'>
  schedules: ScheduleRecord[]
  objectives: ObjectiveRecord[]
  cognitive_clock: { tick: number; last_signal_batch_id?: string; revision: number }
  state: MindState
  observations: ContextObservation[]
  pressure: ContextPressure
  attribution?: ContextAttribution
  sexpr?: string
}

interface ContextEncodingResponse {
  context_id: string
  session_id: string
  mind_revision: number
  encoding: string
}

interface RecallSearchHit {
  document_kind: 'event' | 'frame'
  document_id: string
  revision: number
  retired: boolean
  score: number
  preview: string
}

interface FrameRecallPage {
  root_frame_id: string
  mind_version: number
  nodes: Array<{ kind: 'frame' | 'event'; id: string; depth: number; lifecycle?: string; preview?: string }>
  edges: Array<{ subject: string; relation: string; object: string }>
  truncated: boolean
  next_cursor?: string
}

interface RecallIndexAudit {
  capability: { mode: string; indexed: boolean; unicode_normalization: string; detail: string }
  event_documents: number
  frame_documents: number
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

function DialogueActivityDock({
  open,
  objectives,
  threads,
  historyThreads,
  delegations,
  currentSessionId,
  expandedThreadId,
  threadDetail,
  liveModelAttempts,
  showReasoningSummary,
  expandedObjectiveIds,
  pausingObjectiveId,
  resumingObjectiveId,
  deletingObjectiveId,
  t,
  onOpenChange,
  onThreadToggle,
  onReasoningOpenChange,
  onInspectThread,
  onObjectiveToggle,
  onPauseObjective,
  onResumeObjective,
  onDeleteObjective,
}: {
  open: boolean
  objectives: ObjectiveRecord[]
  threads: SchedulerThreadSnapshot[]
  historyThreads: SchedulerThreadSnapshot[]
  delegations: DelegationRecord[]
  currentSessionId: string
  expandedThreadId: string
  threadDetail: ThreadDetailResponse | null
  liveModelAttempts: LiveModelAttempt[]
  showReasoningSummary: boolean
  expandedObjectiveIds: ReadonlySet<string>
  pausingObjectiveId: string
  resumingObjectiveId: string
  deletingObjectiveId: string
  t: TFunction
  onOpenChange: (open: boolean) => void
  onThreadToggle: (threadId: string) => void
  onReasoningOpenChange: (open: boolean) => void
  onInspectThread: (threadId: string) => void
  onObjectiveToggle: (objectiveId: string) => void
  onPauseObjective: (objective: ObjectiveRecord) => void
  onResumeObjective: (objective: ObjectiveRecord) => void
  onDeleteObjective: (objective: ObjectiveRecord) => void
}) {
  const [objectivesOpen, setObjectivesOpen] = useStoredDisclosure('morphz.dashboard.dialogueActivity.objectives', false)
  const [threadsOpen, setThreadsOpen] = useStoredDisclosure('morphz.dashboard.dialogueActivity.threads', true)
  const [backgroundOpen, setBackgroundOpen] = useStoredDisclosure('morphz.dashboard.dialogueActivity.background', true)
  const [delegationsOpen, setDelegationsOpen] = useStoredDisclosure('morphz.dashboard.dialogueActivity.delegations', true)
  const [historyOpen, setHistoryOpen] = useStoredDisclosure('morphz.dashboard.dialogueActivity.history', false)
  const backgroundProcesses = threads.flatMap(snapshot => (
    snapshot.activations.flatMap(activation => (
      activation.jobs
        .filter(item => item.job.tool_name === 'exec/background' && !['succeeded', 'failed', 'cancelled', 'lost'].includes(item.job.status))
        .map(item => ({ snapshot, item }))
    ))
  ))

  return (
    <aside className={`dialogue-activity-dock ${open ? 'is-open' : 'is-collapsed'}`} aria-label={t('conversation.activity.title')}>
      <button
        className="dialogue-activity-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span><Radio size={13} /><strong>{t('conversation.activity.title')}</strong></span>
        <small>{t('conversation.activity.summary', { objectives: objectives.length, threads: threads.length, delegations: delegations.length })}</small>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="dialogue-activity-content">
          <details
            className="dialogue-activity-section"
            open={objectivesOpen}
            onToggle={event => setObjectivesOpen(event.currentTarget.open)}
          >
            <summary>
              <span>{t('conversation.activity.objectives')}</span>
              <b>{objectives.length}</b>
              <ChevronDown size={12} />
            </summary>
            <div className="dialogue-objective-list">
              {objectives.map(objective => {
                const currentSession = objective.coordinator_session_id === currentSessionId
                  || objective.delivery_session_id === currentSessionId
                const expanded = expandedObjectiveIds.has(objective.id)
                const busy: ObjectiveMutationKind = pausingObjectiveId === objective.id
                  ? 'pause'
                  : resumingObjectiveId === objective.id
                    ? 'resume'
                    : deletingObjectiveId === objective.id
                      ? 'delete'
                      : ''
                return (
                  <article className={`dialogue-objective-card ${objective.status} ${expanded ? 'is-expanded' : ''}`} key={objective.id}>
                    <header className="objective-card-titlebar">
                      <span className={`activity-status ${objective.status}`}><i />{statusLabel(objective.status, t)}</span>
                      <time>{formatAgo(objective.updated_at, t)}</time>
                      <ObjectiveCardActions
                        objective={objective}
                        expanded={expanded}
                        busy={busy}
                        disabled={Boolean(pausingObjectiveId || resumingObjectiveId || deletingObjectiveId)}
                        t={t}
                        onPause={() => onPauseObjective(objective)}
                        onResume={() => onResumeObjective(objective)}
                        onDelete={() => onDeleteObjective(objective)}
                        onToggle={() => onObjectiveToggle(objective.id)}
                      />
                    </header>
                    <strong>{objective.stated_objective}</strong>
                    {expanded && (
                      <div className="objective-card-details">
                        {objective.status_reason && <p>{objective.status_reason}</p>}
                        {objective.wait_condition && <div className="dialogue-objective-wait">{t('work.objectives.waitCondition', { kind: objective.wait_condition.kind })}</div>}
                        <footer>
                          <code>r{objective.revision}</code>
                          <span>{currentSession ? t('conversation.activity.currentSession') : t('conversation.activity.otherSession', { id: shortId(objective.coordinator_session_id, 14) })}</span>
                        </footer>
                      </div>
                    )}
                  </article>
                )
              })}
              {objectives.length === 0 && <div className="dialogue-activity-empty">{t('conversation.activity.noObjectives')}</div>}
            </div>
          </details>

          <details
            className="dialogue-activity-section thread-section"
            open={threadsOpen}
            onToggle={event => setThreadsOpen(event.currentTarget.open)}
          >
            <summary>
              <span>{t('conversation.activity.threads')}</span>
              <b>{threads.length}</b>
              <ChevronDown size={12} />
            </summary>
            <div className="dialogue-thread-list">
              {threads.map(snapshot => {
                const expanded = expandedThreadId === snapshot.thread.id
                const effective = expanded && threadDetail?.snapshot.thread.id === snapshot.thread.id
                  ? threadDetail.snapshot
                  : snapshot
                const activationIds = new Set(effective.activations.map(item => item.activation.id))
                const attempts = liveModelAttempts.filter(attempt => activationIds.has(attempt.activationId))
                const jobs = effective.activations.flatMap(item => item.jobs)
                const activeJob = jobs.find(item => ['queued', 'waiting_approval', 'running'].includes(item.job.status))
                  ?? jobs.at(-1)
                const jobSummary = activeJob
                  ? summarizeToolCall(activeJob.job.tool_name, JSON.stringify(activeJob.job.request), t)
                  : null
                const currentSession = effective.thread.session_id === currentSessionId
                const displayState = effective.phase === 'idle' ? effective.thread.lifecycle : effective.phase
                return (
                  <article className={`dialogue-thread-card phase-${effective.phase} ${expanded ? 'is-expanded' : ''}`} key={effective.thread.id}>
                    <button
                      className="dialogue-thread-summary"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => onThreadToggle(effective.thread.id)}
                    >
                      <span className={`activity-status ${displayState}`}><i />{statusLabel(displayState, t)}</span>
                      <span className="dialogue-thread-identity">
                        <strong>{threadKindLabel(effective.thread.kind, t)}</strong>
                        <small>{jobSummary ? `${jobSummary.title}${jobSummary.target ? ` · ${jobSummary.target}` : ''}` : shortId(effective.thread.id, 20)}</small>
                      </span>
                      <span className="dialogue-thread-counts">{effective.activations.length}A · {jobs.length}J</span>
                      <ChevronDown size={13} />
                    </button>
                    <div className="dialogue-thread-origin">
                      <span>{currentSession ? t('conversation.activity.currentSession') : t('conversation.activity.otherSession', { id: shortId(effective.thread.session_id, 14) })}</span>
                      <time>{formatAgo(effective.thread.updated_at, t)}</time>
                    </div>

                    {expanded && (
                      <div className="dialogue-thread-runtime">
                        {attempts.map(attempt => (
                          <section className="dialogue-live-attempt" key={attempt.attemptId}>
                            <header><Brain size={12} /><strong>{t('conversation.activity.modelEvaluation')}</strong><span>{statusLabel(attempt.runtimeState, t)}</span></header>
                            <ReasoningSummaryBlock
                              summary={attempt.reasoningSummary}
                              live
                              open={showReasoningSummary}
                              onOpenChange={onReasoningOpenChange}
                              title={t('reasoningSummary.title')}
                              liveLabel={t('reasoningSummary.live')}
                              persistedLabel={t('reasoningSummary.persisted')}
                            />
                          </section>
                        ))}

                        {effective.pending_signals.map(signal => (
                          <div className="dialogue-thread-signal" key={signal.id}>
                            <Radio size={11} /><span>{signal.kind}</span><code>#{signal.sequence}</code>
                          </div>
                        ))}

                        {effective.activations.map(activation => (
                          <section className="dialogue-activation" key={activation.activation.id}>
                            <header>
                              <span className={`activity-status ${activation.activation.status}`}><i />{statusLabel(activation.activation.status, t)}</span>
                              <code>{shortId(activation.activation.id, 17)}</code>
                              <small>{activation.activation.trigger_kind}</small>
                            </header>
                            {activation.jobs.map(jobSnapshot => {
                              const summary = summarizeToolCall(jobSnapshot.job.tool_name, JSON.stringify(jobSnapshot.job.request), t)
                              return (
                                <details className={`dialogue-job ${jobSnapshot.job.status}`} key={jobSnapshot.job.id} open={['running', 'waiting_approval', 'failed', 'lost'].includes(jobSnapshot.job.status)}>
                                  <summary>
                                    <i>{jobSnapshot.job.status === 'running' ? <LoaderCircle size={11} /> : jobSnapshot.job.status === 'succeeded' ? <Check size={11} /> : <CircleDot size={10} />}</i>
                                    <span><strong>{summary.title}</strong><small>{summary.target || shortId(jobSnapshot.job.id, 15)}</small></span>
                                    <em>{statusLabel(jobSnapshot.job.status, t)}</em>
                                    <ChevronDown size={11} />
                                  </summary>
                                  <div>
                                    <pre>{JSON.stringify(jobSnapshot.job.request, null, 2)}</pre>
                                    {jobSnapshot.approval && <p>{t('conversation.activity.approval', { status: statusLabel(jobSnapshot.approval.status, t) })}</p>}
                                    {jobSnapshot.result?.error && <p className="error">{jobSnapshot.result.error}</p>}
                                  </div>
                                </details>
                              )
                            })}
                          </section>
                        ))}

                        {attempts.length === 0 && effective.activations.length === 0 && (
                          <div className="dialogue-activity-empty">{t('conversation.activity.waitingForExecution')}</div>
                        )}
                        <footer className="dialogue-thread-delivery">
                          <span>{t('conversation.activity.delivery')}</span>
                          <b>{statusLabel(effective.thread.delivery_status, t)}</b>
                        </footer>
                        <button className="dialogue-thread-inspect" type="button" onClick={() => onInspectThread(effective.thread.id)}>
                          <GitBranch size={12} /> {t('conversation.activity.openFullThread')}
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
              {threads.length === 0 && <div className="dialogue-activity-empty">{t('conversation.activity.noThreads')}</div>}
            </div>
          </details>

          <details
            className="dialogue-activity-section background-section"
            open={backgroundOpen}
            onToggle={event => setBackgroundOpen(event.currentTarget.open)}
          >
            <summary>
              <span>{t('conversation.activity.backgroundProcesses')}</span>
              <b>{backgroundProcesses.length}</b>
              <ChevronDown size={12} />
            </summary>
            <div className="dialogue-background-list">
              {backgroundProcesses.map(({ snapshot, item }) => {
                const request = item.job.request && typeof item.job.request === 'object'
                  ? item.job.request as Record<string, unknown>
                  : {}
                const command = typeof request.command === 'string' ? request.command : ''
                return (
                  <article className={`dialogue-background-card ${item.job.status}`} key={item.job.id}>
                    <header>
                      <span className={`activity-status ${item.job.status}`}><i />{statusLabel(item.job.status, t)}</span>
                      <time>{formatAgo(item.job.updated_at, t)}</time>
                    </header>
                    <strong>{command || t('conversation.activity.backgroundTask')}</strong>
                    <footer>
                      <code>{shortId(item.job.id, 18)}</code>
                      <button type="button" onClick={() => onInspectThread(snapshot.thread.id)}>{t('conversation.activity.openFullThread')}</button>
                    </footer>
                  </article>
                )
              })}
              {backgroundProcesses.length === 0 && <div className="dialogue-activity-empty">{t('conversation.activity.noBackgroundProcesses')}</div>}
            </div>
          </details>

          <details
            className="dialogue-activity-section delegation-section"
            open={delegationsOpen}
            onToggle={event => setDelegationsOpen(event.currentTarget.open)}
          >
            <summary>
              <span>{t('conversation.activity.delegations')}</span>
              <b>{delegations.length}</b>
              <ChevronDown size={12} />
            </summary>
            <div className="dialogue-delegation-list">
              {delegations.map(delegation => {
                const currentSession = delegation.parent_session_id === currentSessionId
                return (
                  <article className={`dialogue-delegation-card ${delegation.status}`} key={delegation.id}>
                    <header>
                      <span className={`activity-status ${delegation.status}`}><i />{statusLabel(delegation.status, t)}</span>
                      <time>{formatAgo(delegation.updated_at, t)}</time>
                    </header>
                    <strong>{delegation.task}</strong>
                    <footer>
                      <span><GitBranch size={10} /> {shortId(delegation.child_session_id, 18)}</span>
                      <span>{currentSession ? t('conversation.activity.currentSession') : t('conversation.activity.otherSession', { id: shortId(delegation.parent_session_id, 14) })}</span>
                    </footer>
                  </article>
                )
              })}
              {delegations.length === 0 && <div className="dialogue-activity-empty">{t('conversation.activity.noDelegations')}</div>}
            </div>
          </details>

          <details
            className="dialogue-activity-section history-section"
            open={historyOpen}
            onToggle={event => setHistoryOpen(event.currentTarget.open)}
          >
            <summary>
              <span>{t('conversation.activity.history')}</span>
              <b>{historyThreads.length}</b>
              <ChevronDown size={12} />
            </summary>
            <div className="dialogue-history-list">
              {historyThreads.map(snapshot => {
                const jobs = snapshot.activations.flatMap(item => item.jobs)
                const latestJob = jobs.at(-1)
                const summary = latestJob
                  ? summarizeToolCall(latestJob.job.tool_name, JSON.stringify(latestJob.job.request), t)
                  : null
                return (
                  <button className="dialogue-history-card" type="button" key={snapshot.thread.id} onClick={() => onInspectThread(snapshot.thread.id)}>
                    <span className={`activity-status ${snapshot.thread.lifecycle}`}><i />{statusLabel(snapshot.thread.lifecycle, t)}</span>
                    <span>
                      <strong>{threadKindLabel(snapshot.thread.kind, t)}</strong>
                      <small>{summary ? `${summary.title}${summary.target ? ` · ${summary.target}` : ''}` : shortId(snapshot.thread.id, 20)}</small>
                    </span>
                    <time>{formatAgo(snapshot.thread.updated_at, t)}</time>
                  </button>
                )
              })}
              {historyThreads.length === 0 && <div className="dialogue-activity-empty">{t('conversation.activity.noHistory')}</div>}
            </div>
          </details>
        </div>
      )}
    </aside>
  )
}

const terminalObjectiveStatuses = new Set(['completed', 'cancelled', 'failed'])
const terminalTaskStatuses = new Set(['completed', 'cancelled', 'failed', 'succeeded', 'killed'])

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
      threadKind: 'dialogue_turn',
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
      threadKind: 'execution',
      threadId: item.root_turn_id,
      threadDetail: `from dialogue ${shortId(item.session_id, 18)}`,
    }
  }
  return {
    title: t('activation.processRuntimeEvent', { kind: item.trigger_kind }),
    threadKind: 'execution',
    threadId: item.root_turn_id,
    threadDetail: `from dialogue ${shortId(item.session_id, 18)}`,
  }
}

function eventKind(event: MorphzEvent) {
  return conversationEventKind(event.topic, event.payload)
}

// Selection changes can fire many times while the pointer is moving. Keeping
// the transient popup state here prevents text selection from re-rendering the
// entire dashboard on every animation frame.
const SelectionQuotePopup = memo(function SelectionQuotePopup({
  label,
  onAdd,
}: {
  label: string
  onAdd: (popup: SelectionPopup) => void
}) {
  const [popup, setPopup] = useState<SelectionPopup | null>(null)

  useEffect(() => {
    let rafId: number | null = null
    const checkSelection = () => {
      rafId = null
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPopup(null)
        return
      }
      const selectedText = selection.toString().trim()
      if (!selectedText || selectedText.length < 2) {
        setPopup(null)
        return
      }
      let node: Node | null = selection.anchorNode
      let messageBody: Element | null = null
      while (node) {
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).classList?.contains('message-body')) {
          messageBody = node as Element
          break
        }
        node = node.parentNode
      }
      if (!messageBody) {
        setPopup(null)
        return
      }
      const article = messageBody.closest('article')
      if (!article) {
        setPopup(null)
        return
      }
      const range = selection.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const articleRect = article.getBoundingClientRect()
      setPopup({
        x: rect.left + rect.width / 2,
        y: rect.top,
        text: selectedText,
        eventId: article.getAttribute('data-event-id') || '',
        eventActor: article.getAttribute('data-event-actor') || '',
        eventTime: article.getAttribute('data-event-time') || '',
        relTop: rect.top - articleRect.top + rect.height / 2 - 9,
        relLeft: rect.right - articleRect.left + 6,
      })
    }
    const handleSelectionChange = () => {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(checkSelection)
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [])

  if (!popup) return null
  return (
    <button
      className="selection-popup"
      style={{ left: popup.x, top: popup.y }}
      type="button"
      onClick={() => {
        onAdd(popup)
        setPopup(null)
        window.getSelection()?.removeAllRanges()
      }}
    >
      <MessageSquare size={13} />
      <span>{label}</span>
    </button>
  )
})

// Keep draft input state below App. A keystroke should only reconcile the
// composer, not the full event history and every dashboard view.
const Composer = memo(function Composer({
  inputRef,
  selectedSessionId,
  sending,
  activeWorkCount,
  quotes,
  activeQuoteId,
  t,
  onActiveQuoteIdChange,
  onRemoveQuote,
  onUpdateQuoteComment,
  onSend,
  onCancel,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  selectedSessionId: string
  sending: boolean
  activeWorkCount: number
  quotes: QuoteItem[]
  activeQuoteId: string
  t: TFunction
  onActiveQuoteIdChange: (quoteId: string) => void
  onRemoveQuote: (quoteId: string) => void
  onUpdateQuoteComment: (quoteId: string, comment: string) => void
  onSend: (message: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [message, setMessage] = useState('')
  const composingInput = useRef(false)

  const submit = useCallback(async () => {
    if (await onSend(message)) setMessage('')
  }, [message, onSend])

  return (
    <div className="composer">
      <span className="composer-prompt">›</span>
      <div className="composer-input-area">
        {quotes.length > 0 && (
          <div className="quote-badges">
            {quotes.map((quote, index) => (
              <div className={`quote-badge ${activeQuoteId === quote.id ? 'active' : ''}`} key={quote.id}>
                <button
                  className="quote-badge-btn"
                  type="button"
                  onClick={() => onActiveQuoteIdChange(activeQuoteId === quote.id ? '' : quote.id)}
                >
                  <span className="quote-badge-num">{index + 1}</span>
                  {quote.comment.trim() && <span className="quote-badge-dot" />}
                </button>
                <button
                  className="quote-badge-x"
                  type="button"
                  title={t('conversation.removeQuote')}
                  onClick={() => {
                    onRemoveQuote(quote.id)
                    if (activeQuoteId === quote.id) onActiveQuoteIdChange('')
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {activeQuoteId && (() => {
          const activeQuote = quotes.find(quote => quote.id === activeQuoteId)
          if (!activeQuote) return null
          return (
            <div className="quote-comment-area">
              <div className="quote-comment-text">{activeQuote.text}</div>
              <textarea
                className="quote-comment-input"
                placeholder={t('conversation.commentPlaceholder')}
                rows={2}
                value={activeQuote.comment}
                onChange={event => onUpdateQuoteComment(activeQuote.id, event.target.value)}
              />
            </div>
          )
        })()}
        <textarea
          ref={inputRef}
          aria-label={t('composer.inputAriaLabel')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={sending}
          onChange={event => setMessage(event.target.value)}
          onCompositionStart={() => { composingInput.current = true }}
          onCompositionEnd={() => { composingInput.current = false }}
          onKeyDown={event => {
            if (composingInput.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={selectedSessionId ? t('composer.placeholder') : t('composer.noSessionPlaceholder')}
          rows={1}
          value={message}
        />
      </div>
      {activeWorkCount > 0 ? (
        <button className="cancel-button" type="button" title={t('composer.cancelTitle')} onClick={onCancel}><Square size={14} /></button>
      ) : null}
      <button
        className="send-button"
        disabled={(!message.trim() && quotes.length === 0) || sending}
        type="button"
        onClick={() => void submit()}
      >
        <Send size={15} /><span>{t('composer.send')}</span>
      </button>
    </div>
  )
})

export default function App() {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const route = useMemo(() => parseDashboardRoute(location.pathname), [location.pathname])
  const view = route.view
  const cognitionView = route.cognitionView ?? 'mind'
  const [accentTheme, setAccentTheme] = useState<AccentTheme>(initialAccentTheme)
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(initialAppearanceMode)
  const [systemPrefersDark, setSystemPrefersDark] = useState(initialSystemPrefersDark)
  const [showReasoningSummary, setShowReasoningSummary] = useState(initialShowReasoningSummary)
  const [conversationLayout, setConversationLayout] = useState<ConversationLayout>(initialConversationLayout)
  const [conversationMobileLane, setConversationMobileLane] = useState<ConversationMobileLane>('dialogue')
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [catalogReady, setCatalogReady] = useState(false)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [contexts, setContexts] = useState<ContextRecord[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [delegations, setDelegations] = useState<DelegationRecord[]>([])
  const [executionTargets, setExecutionTargets] = useState<ExecutionTargetSummary[]>([])
  const [executionNodes, setExecutionNodes] = useState<ExecutionNodeSummary[]>([])
  const [capabilityLeases, setCapabilityLeases] = useState<CapabilityLeaseSummary[]>([])
  const [executionJobs, setExecutionJobs] = useState<ExecutionJobSummary[]>([])
  const [schedulerSnapshot, setSchedulerSnapshot] = useState<SchedulerSnapshot | null>(null)
  const [attentionAcknowledgements, setAttentionAcknowledgements] = useState<AttentionAcknowledgement[]>([])
  const [acknowledgingAttentionKey, setAcknowledgingAttentionKey] = useState('')
  const [schedulerHistoryLimit, setSchedulerHistoryLimit] = useState(SCHEDULER_HISTORY_PAGE_SIZE)
  const [threadDetail, setThreadDetail] = useState<ThreadDetailResponse | null>(null)
  const [dialogueActivityOpen, setDialogueActivityOpen] = useStoredDisclosure('morphz.dashboard.dialogueActivity.open', true)
  const [expandedDialogueThreadId, setExpandedDialogueThreadId] = useState('')
  const [dialogueThreadDetail, setDialogueThreadDetail] = useState<ThreadDetailResponse | null>(null)
  const [projectionAudit, setProjectionAudit] = useState<MindProjectionAudit | null>(null)
  const [auditingProjection, setAuditingProjection] = useState(false)
  const [contextOverview, setContextOverview] = useState<ContextOverviewResponse | null>(null)
  const [modelUsagePage, setModelUsagePage] = useState<ModelUsagePage | null>(null)
  const [ledgerPage, setLedgerPage] = useState<LedgerQueryResponse | null>(null)
  const [mindTransactionPage, setMindTransactionPage] = useState<LedgerQueryResponse | null>(null)
  const [ledgerFilters, setLedgerFilters] = useState<LedgerFilters>({ sessionId: '', principalId: '', threadId: '', activationId: '', actor: '', topic: '', search: '', afterSequence: '', startTime: '', endTime: '' })
  const [ledgerBeforeSequence, setLedgerBeforeSequence] = useState('')
  const [ledgerCursorHistory, setLedgerCursorHistory] = useState<string[]>([])
  const [contextView, setContextView] = useState<ContextViewResponse | null>(null)
  const [contextEncoding, setContextEncoding] = useState<ContextEncodingResponse | null>(null)
  const [events, setEvents] = useState<MorphzEvent[]>([])
  const [eventsSessionId, setEventsSessionId] = useState('')
  const [latestContextInspect, setLatestContextInspect] = useState<MorphzEvent | null>(null)
  const [contextInspectTab, setContextInspectTab] = useState<ContextInspectTab>('encoding')
  const [contextInspectCopied, setContextInspectCopied] = useState(false)
  const [liveModelState, dispatchModelStream] = useReducer(modelStreamReducer, createLiveModelState())
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedContextId, setSelectedContextId] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [selectedFrameId, setSelectedFrameId] = useState('')
  const [recallQuery, setRecallQuery] = useState('')
  const [recallMatches, setRecallMatches] = useState<RecallSearchHit[]>([])
  const [frameLineage, setFrameLineage] = useState<FrameRecallPage | null>(null)
  const [recallIndex, setRecallIndex] = useState<RecallIndexAudit | null>(null)
  const [recallBusy, setRecallBusy] = useState(false)
  const [mutatingFrameId, setMutatingFrameId] = useState('')
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [creatingContext, setCreatingContext] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [catalogMutationKey, setCatalogMutationKey] = useState('')
  const [appDialog, setAppDialog] = useState<AppDialogRequest | null>(null)
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [sending, setSending] = useState(false)
  const [changingReasoning, setChangingReasoning] = useState(false)
  const [pausingObjectiveId, setPausingObjectiveId] = useState('')
  const [resumingObjectiveId, setResumingObjectiveId] = useState('')
  const [deletingObjectiveId, setDeletingObjectiveId] = useState('')
  const [expandedObjectiveIds, setExpandedObjectiveIds] = useState<Set<string>>(() => new Set())
  const [decidingApprovalId, setDecidingApprovalId] = useState('')
  const [mutatingScheduleId, setMutatingScheduleId] = useState('')
  const [copiedMessageId, setCopiedMessageId] = useState('')
  const [pendingTurn, setPendingTurn] = useState<PendingTurnState | null>(null)
  const [error, setError] = useState('')
  const [quotes, setQuotes] = useState<QuoteItem[]>([])
  const [activeQuoteId, setActiveQuoteId] = useState('')
  const [inlineCommentQuoteId, setInlineCommentQuoteId] = useState('')
  const conversationEnd = useRef<HTMLDivElement>(null)
  const conversationLaneRef = useRef<HTMLDivElement>(null)
  const conversationMessageListRef = useRef<HTMLDivElement>(null)
  const executionOutputEnd = useRef<HTMLDivElement>(null)
  const executionOutputLaneRef = useRef<HTMLDivElement>(null)
  const executionOutputListRef = useRef<HTMLDivElement>(null)
  const executionOutputPinnedToEnd = useRef(true)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const [messageWindow, setMessageWindow] = useState({ sessionId: '', count: MESSAGE_PAGE_SIZE })
  const loadingOlder = useRef(false)
  const pendingScrollRestore = useRef<number | null>(null)
  const wasSending = useRef(false)
  const conversationPinnedToEnd = useRef(true)
  const lastProgrammaticScroll = useRef(0)
  const lastExecutionProgrammaticScroll = useRef(0)
  const viewFrameRef = useRef<HTMLDivElement>(null)
  const sessionLoadInFlight = useRef(false)
  const sessionLoadQueued = useRef<{ sessionId: string, contextId: string } | null>(null)
  const loadSessionRef = useRef<(sessionId: string, contextId: string) => Promise<void>>(async () => {})
  const contextSelectorRef = useRef<HTMLDivElement>(null)
  const sessionSelectorRef = useRef<HTMLDivElement>(null)
  const themeSelectorRef = useRef<HTMLDivElement>(null)
  const appDialogRef = useRef<AppDialogRequest | null>(null)
  const appDialogSequence = useRef(0)
  const selectedScopeRef = useRef({ sessionId: '', contextId: '' })
  const activeViewRef = useRef(view)
  const schedulerHistoryLimitRef = useRef(schedulerHistoryLimit)

  useEffect(() => {
    try {
      window.localStorage.setItem('morphz.dashboard.conversationLayout', conversationLayout)
    } catch {
      // The layout preference remains active for the current page lifetime.
    }
  }, [conversationLayout])

  const requestConfirmation = useCallback((options: {
    title: string
    description?: string
    confirmLabel: string
    cancelLabel: string
    tone?: 'default' | 'danger'
  }) => new Promise<boolean>(resolve => {
    const previous = appDialogRef.current
    if (previous) {
      if (previous.kind === 'confirm') previous.resolve(false)
      else previous.resolve(null)
    }
    const request: AppConfirmDialog = {
      ...options,
      id: ++appDialogSequence.current,
      kind: 'confirm',
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      resolve,
    }
    appDialogRef.current = request
    setAppDialog(request)
  }), [])

  const requestText = useCallback((options: {
    title: string
    description?: string
    inputLabel: string
    defaultValue?: string
    allowEmpty?: boolean
    placeholder?: string
    confirmLabel: string
    cancelLabel: string
  }) => new Promise<string | null>(resolve => {
    const previous = appDialogRef.current
    if (previous) {
      if (previous.kind === 'confirm') previous.resolve(false)
      else previous.resolve(null)
    }
    const request: AppPromptDialog = {
      ...options,
      defaultValue: options.defaultValue ?? '',
      id: ++appDialogSequence.current,
      kind: 'prompt',
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      resolve,
    }
    appDialogRef.current = request
    setAppDialog(request)
  }), [])

  const resolveAppDialog = useCallback((value: boolean | string | null) => {
    const request = appDialogRef.current
    if (!request) return
    appDialogRef.current = null
    setAppDialog(null)
    if (request.kind === 'confirm') request.resolve(value === true)
    else request.resolve(typeof value === 'string' ? value : null)
    window.setTimeout(() => request.returnFocus?.focus(), 0)
  }, [])
  const authoritativeRefreshRef = useRef<(topic: string) => void>(() => {})

  useEffect(() => {
    activeViewRef.current = view
  }, [view])

  useEffect(() => {
    schedulerHistoryLimitRef.current = schedulerHistoryLimit
  }, [schedulerHistoryLimit])

  const setView = useCallback((next: DashboardView | ((current: DashboardView) => DashboardView)) => {
    const resolved = typeof next === 'function' ? next(view) : next
    // Navigation and an incoming Runtime event can occur in the same browser
    // turn. Publish the requested view before changing the route so an
    // immediate authoritative refresh cannot use the previous view's query
    // contract and later overwrite the new page with that response.
    activeViewRef.current = resolved
    navigate(dashboardPath(resolved, selectedContextId, selectedSessionId, cognitionView))
  }, [cognitionView, navigate, selectedContextId, selectedSessionId, view])

  const selectCognitionView = useCallback((next: CognitionView) => {
    navigate(dashboardPath('cognition', selectedContextId, selectedSessionId, next))
  }, [navigate, selectedContextId, selectedSessionId])

  const apiHeaders = useCallback((json = false) => {
    const headers: Record<string, string> = {}
    if (CORE_TOKEN) headers.Authorization = `Bearer ${CORE_TOKEN}`
    if (json) headers['Content-Type'] = 'application/json'
    return headers
  }, [])

  const loadCatalog = useCallback(async () => {
    try {
      const [nextStatus, agentsResult, contextsResult, sessionsResult, delegationsResult, targetsResult, nodesResult, leasesResult, jobsResult] = await Promise.all([
        DASHBOARD_API.get<RuntimeStatus>('/api/status'),
        DASHBOARD_API.tryGet<{ agents?: AgentRecord[] }>('/api/agents?include_archived=true'),
        DASHBOARD_API.tryGet<{ contexts?: ContextRecord[] }>('/api/contexts?include_archived=true'),
        DASHBOARD_API.tryGet<{ sessions?: SessionRecord[] }>('/api/sessions?include_archived=true'),
        DASHBOARD_API.tryGet<{ delegations?: DelegationRecord[] }>('/api/delegations'),
        DASHBOARD_API.tryGet<{ targets?: ExecutionTargetSummary[] }>('/api/execution-targets'),
        DASHBOARD_API.tryGet<{ nodes?: ExecutionNodeSummary[] }>('/api/edge/nodes'),
        DASHBOARD_API.tryGet<{ leases?: CapabilityLeaseSummary[] }>('/api/capability-leases?active_only=true'),
        DASHBOARD_API.tryGet<{ jobs?: ExecutionJobSummary[] }>('/api/execution-jobs?include_terminal=true&newest_first=true&limit=100'),
      ])
      const nextAgents = agentsResult?.agents ?? []
      const nextContexts = contextsResult?.contexts ?? []
      const nextSessions = sessionsResult?.sessions ?? []
      const nextDelegations = delegationsResult?.delegations ?? []
      setStatus(nextStatus)
      setAgents(nextAgents)
      setContexts(nextContexts)
      setSessions(nextSessions)
      setDelegations(nextDelegations)
      setExecutionTargets(targetsResult?.targets ?? [])
      setExecutionNodes(nodesResult?.nodes ?? [])
      setCapabilityLeases(leasesResult?.leases ?? [])
      setExecutionJobs(jobsResult?.jobs ?? [])
      setSelectedAgentId(current => current || nextStatus.agent_id || nextAgents[0]?.id || '')
      setSelectedContextId(current => {
        if (current && nextContexts.some(item => item.id === current && item.status === 'active')) return current
        if (nextContexts.some(item => item.id === nextStatus.context_id && item.status === 'active')) return nextStatus.context_id
        return nextContexts.find(item => item.status === 'active')?.id ?? ''
      })
      setSelectedSessionId(current => {
        if (current && nextSessions.some(item => item.id === current && item.status === 'active')) return current
        const contextId = nextStatus.context_id || nextContexts[0]?.id
        return nextSessions
          .filter(item => item.context_id === contextId && item.status === 'active')
          .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))[0]?.id ?? nextSessions[0]?.id ?? ''
      })
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCatalogReady(true)
    }
  }, [])

  const setExecutionTargetStatus = useCallback(async (targetId: string, revision: number, status: 'online' | 'disabled') => {
    try {
      await DASHBOARD_API.command(`/api/execution-targets/${encodeURIComponent(targetId)}`, 'PATCH', {
        expected_revision: revision,
        status,
      })
      await loadCatalog()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [loadCatalog])

  const revokeExecutionNode = useCallback(async (nodeId: string, revision: number) => {
    try {
      await DASHBOARD_API.command(`/api/edge/nodes/${encodeURIComponent(nodeId)}`, 'DELETE', {
        expected_revision: revision,
      })
      await loadCatalog()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [loadCatalog])

  const revokeCapabilityLease = useCallback(async (leaseId: string, revision: number) => {
    try {
      await DASHBOARD_API.command(`/api/capability-leases/${encodeURIComponent(leaseId)}`, 'DELETE', {
        expected_revision: revision,
        reason: 'Revoked from Dashboard',
      })
      await loadCatalog()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [loadCatalog])

  const cancelExecutionJob = useCallback(async (jobId: string, revision: number) => {
    try {
      await DASHBOARD_API.command(`/api/execution-jobs/${encodeURIComponent(jobId)}/cancel`, 'POST', {
        expected_revision: revision,
        reason: 'Cancelled from Dashboard',
      })
      await loadCatalog()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [loadCatalog])

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
      const isCurrentScope = () => {
        const selectedScope = selectedScopeRef.current
        return selectedScope.sessionId === sessionId && selectedScope.contextId === contextId
      }
      const currentView = activeViewRef.current
      const includeTerminal = currentView === 'scheduler' || currentView === 'dialogue'
      // Dialogue and Scheduler render two surfaces of the same authoritative
      // read model. Re-querying that model with a different history boundary
      // on navigation used to make derived attention facts appear or vanish.
      // Keep one window for both views; "load more" then remains stable when
      // the operator returns to Dialogue and opens Scheduler again.
      const schedulerLimit = includeTerminal ? schedulerHistoryLimitRef.current : 50
      const applySchedulerSnapshot = (snapshot: SchedulerSnapshot) => {
        if (!isCurrentScope()) return
        setSchedulerSnapshot(snapshot)
        const activeActivationIds = snapshot.threads
          .flatMap(thread => thread.activations)
          .map(activation => activation.activation)
          .filter(activation => activation.status === 'queued' || activation.status === 'running')
          .map(activation => activation.id)
        // Keep drafts that are still actively streaming. Snapshot rows can
        // lag behind the live stream, so filtering purely by the snapshot
        // kills bubbles mid-generation and breaks auto-scroll.
        dispatchModelStream({
          type: 'reconcile',
          sessionId,
          activeActivationIds,
          cutoffMs: Date.now() - 10_000,
        })
      }
      const overviewRequest = DASHBOARD_API.get<ContextOverviewResponse>(
        `/api/contexts/${encodeURIComponent(contextId)}/overview?session_id=${encodeURIComponent(sessionId)}`,
      ).then(async snapshot => {
        if (!isCurrentScope()) return
        setContextOverview(snapshot)
        if (includeTerminal) return
        const summary = snapshot.scheduler
        const needsSchedulerDetail = summary.open_threads > 0
          || summary.pending_signals > 0
          || summary.queued_activations > 0
          || summary.running_activations > 0
          || summary.active_jobs > 0
          || summary.pending_approvals > 0
          || summary.active_schedules > 0
        if (!needsSchedulerDetail) {
          setSchedulerSnapshot(null)
          return
        }
        const scheduler = await DASHBOARD_API.get<SchedulerSnapshot>(
          `/api/contexts/${encodeURIComponent(contextId)}/scheduler?include_terminal=false&limit=${schedulerLimit}`,
        )
        applySchedulerSnapshot(scheduler)
      })
      const requests = [
        DASHBOARD_API.tryGet<{ acknowledgements?: AttentionAcknowledgement[] }>(
          `/api/contexts/${encodeURIComponent(contextId)}/attention/acknowledgements`,
        ).then(result => {
          if (result && isCurrentScope()) {
            setAttentionAcknowledgements(result.acknowledgements ?? [])
          }
        }),
        DASHBOARD_API.tryGet<{ events?: MorphzEvent[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/events?limit=1000`)
          .then(eventsResult => {
            if (!eventsResult || !isCurrentScope()) return
            const nextEvents = eventsResult.events ?? []
            setEvents(nextEvents)
            setEventsSessionId(sessionId)
            for (const summary of selectDurableReasoningSummaries(nextEvents)) {
              dispatchModelStream({ type: 'persisted', sessionId, causalId: summary.attemptId })
            }
          }),
        DASHBOARD_API.tryGet<ModelUsagePage>(
          `/api/contexts/${encodeURIComponent(contextId)}/model-usage?session_id=${encodeURIComponent(sessionId)}&limit=100`,
        ).then(result => {
          if (result && isCurrentScope()) setModelUsagePage(result)
        }),
        overviewRequest,
        ...(includeTerminal
          ? [DASHBOARD_API.get<SchedulerSnapshot>(
              `/api/contexts/${encodeURIComponent(contextId)}/scheduler?include_terminal=true&limit=${schedulerLimit}`,
            ).then(applySchedulerSnapshot)]
          : []),
        DASHBOARD_API.tryGet<{ delegations?: DelegationRecord[] }>('/api/delegations')
          .then(delegationsResult => {
            if (delegationsResult && isCurrentScope()) {
              setDelegations(delegationsResult.delegations ?? [])
            }
          }),
      ]
      const results = await Promise.allSettled(requests)
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected' && isCurrentScope()) {
        setError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason))
      } else if (isCurrentScope()) {
        setError('')
      }
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
  }, [])

  const loadContextProjection = useCallback(async (sessionId: string, contextId: string) => {
    if (!sessionId || !contextId) return
    try {
      const projection = await DASHBOARD_API.get<ContextViewResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/context/projection`,
      )
      const selectedScope = selectedScopeRef.current
      if (selectedScope.sessionId !== sessionId || selectedScope.contextId !== contextId) return
      setContextView(projection)
      setSelectedFrameId(current => current && projection.state.frames.some(frame => frame.id === current)
        ? current
        : projection.state.frames[0]?.id ?? '')
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const loadContextEncoding = useCallback(async (sessionId: string, contextId: string) => {
    if (!sessionId || !contextId) return
    try {
      const encoding = await DASHBOARD_API.get<ContextEncodingResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/context/encoding`,
      )
      const selectedScope = selectedScopeRef.current
      if (selectedScope.sessionId !== sessionId || selectedScope.contextId !== contextId) return
      setContextEncoding(encoding)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const loadOverview = useCallback(async (contextId: string, sessionId: string) => {
    if (!contextId) return
    try {
      const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
      const snapshot = await DASHBOARD_API.get<ContextOverviewResponse>(
        `/api/contexts/${encodeURIComponent(contextId)}/overview${query}`,
      )
      if (selectedScopeRef.current.contextId !== contextId) return
      setContextOverview(snapshot)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const loadLedger = useCallback(async (contextId: string, filters: LedgerFilters, beforeSequence = '') => {
    if (!contextId) return
    try {
      const query = new URLSearchParams({ limit: '200' })
      if (filters.sessionId) query.set('session_id', filters.sessionId)
      if (filters.principalId) query.set('principal_id', filters.principalId)
      if (filters.threadId) query.set('thread_id', filters.threadId)
      if (filters.activationId) query.set('activation_id', filters.activationId)
      if (filters.actor) query.set('actor', filters.actor)
      if (filters.topic) query.set('topic', filters.topic)
      if (filters.search) query.set('query', filters.search)
      if (filters.afterSequence) query.set('after_sequence', filters.afterSequence)
      if (beforeSequence) query.set('before_sequence', beforeSequence)
      if (filters.startTime) query.set('start_time', new Date(filters.startTime).toISOString())
      if (filters.endTime) query.set('end_time', new Date(filters.endTime).toISOString())
      const page = await DASHBOARD_API.get<LedgerQueryResponse>(
        `/api/contexts/${encodeURIComponent(contextId)}/ledger?${query}`,
      )
      if (selectedScopeRef.current.contextId !== contextId) return
      setLedgerPage(page)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const loadThreadDetail = useCallback(async (contextId: string, threadId: string) => {
    if (!contextId || !threadId) return
    try {
      const detail = await DASHBOARD_API.get<ThreadDetailResponse>(
        `/api/contexts/${encodeURIComponent(contextId)}/threads/${encodeURIComponent(threadId)}`,
      )
      if (selectedScopeRef.current.contextId !== contextId) return
      setThreadDetail(detail)
      setError('')
    } catch (reason) {
      setThreadDetail(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const loadMindTransactions = useCallback(async (contextId: string) => {
    if (!contextId) return
    const query = new URLSearchParams({ topic: 'chat/context_tx_committed', limit: '50' })
    try {
      const page = await DASHBOARD_API.get<LedgerQueryResponse>(
        `/api/contexts/${encodeURIComponent(contextId)}/ledger?${query}`,
      )
      if (selectedScopeRef.current.contextId === contextId) setMindTransactionPage(page)
    } catch {
      // Mind projection remains usable when optional transaction history fails.
    }
  }, [])

  useEffect(() => {
    loadSessionRef.current = loadSession
  }, [loadSession])

  const searchRecall = useCallback(async () => {
    if (!selectedContextId || !recallQuery.trim()) return
    setRecallBusy(true)
    try {
      const response = await fetch(
        `${CORE_HTTP_URL}/api/contexts/${encodeURIComponent(selectedContextId)}/recall/search?query=${encodeURIComponent(recallQuery.trim())}&limit=30`,
        { headers: apiHeaders() },
      )
      if (!response.ok) throw new Error(t('errors.contextHttp', { status: response.status }))
      const page = await response.json() as { matches: RecallSearchHit[] }
      setRecallMatches(page.matches)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRecallBusy(false)
    }
  }, [apiHeaders, recallQuery, selectedContextId, t])

  const mutateFrameLifecycle = useCallback(async (frameId: string, action: 'restore' | 'protect' | 'unprotect') => {
    if (!selectedContextId || !selectedSessionId || !contextView) return
    setMutatingFrameId(frameId)
    try {
      const response = await fetch(
        `${CORE_HTTP_URL}/api/contexts/${encodeURIComponent(selectedContextId)}/frames/${encodeURIComponent(frameId)}/lifecycle`,
        {
          method: 'POST',
          headers: apiHeaders(true),
          body: JSON.stringify({
            session_id: selectedSessionId,
            expected_version: contextView.state.version,
            action,
          }),
        },
      )
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
      setContextEncoding(null)
      await Promise.all([
        loadContextProjection(selectedSessionId, selectedContextId),
        loadOverview(selectedContextId, selectedSessionId),
      ])
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMutatingFrameId('')
    }
  }, [apiHeaders, contextView, loadContextProjection, loadOverview, selectedContextId, selectedSessionId])

  useEffect(() => {
    if (view !== 'cognition' || !selectedContextId) return
    let cancelled = false
    void fetch(
      `${CORE_HTTP_URL}/api/contexts/${encodeURIComponent(selectedContextId)}/recall/index`,
      { headers: apiHeaders() },
    ).then(async response => {
      if (response.ok && !cancelled) setRecallIndex(await response.json() as RecallIndexAudit)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [apiHeaders, selectedContextId, view])

  useEffect(() => {
    if (view !== 'cognition' || !selectedContextId || !selectedFrameId) return
    let cancelled = false
    void fetch(
      `${CORE_HTTP_URL}/api/contexts/${encodeURIComponent(selectedContextId)}/frames/${encodeURIComponent(selectedFrameId)}/recall?depth=2&direction=both&include_bodies=false&max_nodes=64`,
      { headers: apiHeaders() },
    ).then(async response => {
      if (response.ok && !cancelled) setFrameLineage(await response.json() as FrameRecallPage)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [apiHeaders, selectedContextId, selectedFrameId, view])

  useEffect(() => {
    try {
      window.localStorage.setItem('morphz.dashboard.accent', accentTheme)
    } catch {
      // The visual preference remains valid for the current page lifetime.
    }
  }, [accentTheme])

  useEffect(() => {
    try {
      window.localStorage.setItem('morphz.dashboard.appearance', appearanceMode)
    } catch {
      // The visual preference remains valid for the current page lifetime.
    }
  }, [appearanceMode])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const update = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const resolvedAppearanceMode = appearanceMode === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : appearanceMode

  useEffect(() => {
    document.documentElement.dataset.colorMode = resolvedAppearanceMode
    document.documentElement.style.colorScheme = resolvedAppearanceMode
  }, [resolvedAppearanceMode])

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
    const timer = window.setTimeout(() => {
      if (route.contextId) setSelectedContextId(route.contextId)
      if (route.sessionId) setSelectedSessionId(route.sessionId)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [route.contextId, route.sessionId])

  useEffect(() => {
    if (!selectedContextId || sessions.length === 0) return
    const selectedBelongsToContext = sessions.some(session => (
      session.id === selectedSessionId
      && session.context_id === selectedContextId
      && session.status === 'active'
    ))
    if (selectedBelongsToContext) return
    const nextSession = sessions
      .filter(session => session.context_id === selectedContextId && session.status === 'active')
      .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))[0]
    const timer = window.setTimeout(() => {
      setSelectedSessionId(nextSession?.id ?? '')
      if (view === 'dialogue' && nextSession) {
        navigate(dashboardPath('dialogue', selectedContextId, nextSession.id), { replace: true })
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [navigate, selectedContextId, selectedSessionId, sessions, view])

  useEffect(() => {
    const context = contexts.find(item => item.id === selectedContextId)
    if (!context || context.agent_id === selectedAgentId) return
    const timer = window.setTimeout(() => setSelectedAgentId(context.agent_id), 0)
    return () => window.clearTimeout(timer)
  }, [contexts, selectedAgentId, selectedContextId])

  useEffect(() => {
    if (location.pathname !== '/' || !selectedContextId) return
    navigate(dashboardPath('overview', selectedContextId, selectedSessionId), { replace: true })
  }, [location.pathname, navigate, selectedContextId, selectedSessionId])

  useEffect(() => {
    selectedScopeRef.current = { sessionId: selectedSessionId, contextId: selectedContextId }
  }, [selectedContextId, selectedSessionId])

  useEffect(() => {
    const reset = window.setTimeout(() => {
      setLedgerPage(null)
      setLedgerBeforeSequence('')
      setLedgerCursorHistory([])
    }, 0)
    return () => window.clearTimeout(reset)
  }, [selectedContextId])

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      dispatchModelStream({ type: 'reset_session', sessionId: selectedSessionId })
      setEventsSessionId('')
      setLatestContextInspect(null)
      setContextView(null)
      setContextEncoding(null)
      setContextOverview(current => current?.active_session_id === selectedSessionId ? current : null)
      setContextInspectTab('encoding')
      setContextInspectCopied(false)
      setSchedulerHistoryLimit(SCHEDULER_HISTORY_PAGE_SIZE)
      setExpandedDialogueThreadId('')
      setDialogueThreadDetail(null)
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
  }, [loadSession, schedulerHistoryLimit, selectedContextId, selectedSessionId, view])

  useEffect(() => {
    if (!selectedContextId || selectedSessionId) return
    const initial = window.setTimeout(() => void loadOverview(selectedContextId, ''), 0)
    const interval = window.setInterval(() => void loadOverview(selectedContextId, ''), 15000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [loadOverview, selectedContextId, selectedSessionId])

  useEffect(() => {
    if (view !== 'cognition' || !selectedContextId || !selectedSessionId) return
    const initial = window.setTimeout(
      () => void loadContextProjection(selectedSessionId, selectedContextId),
      0,
    )
    const interval = window.setInterval(
      () => void loadContextProjection(selectedSessionId, selectedContextId),
      30000,
    )
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [loadContextProjection, selectedContextId, selectedSessionId, view])

  useEffect(() => {
    if (view !== 'cognition' || contextInspectTab !== 'encoding' || !selectedContextId || !selectedSessionId) return
    const inspectPayload = latestContextInspect?.payload
    const hasLiveEncoding = inspectPayload?.session_id === selectedSessionId && typeof inspectPayload.text === 'string'
    const hasCurrentEncoding = contextEncoding?.session_id === selectedSessionId
      && (!contextView || contextEncoding.mind_revision === contextView.state.version)
    if (hasLiveEncoding || hasCurrentEncoding) return
    const timer = window.setTimeout(
      () => void loadContextEncoding(selectedSessionId, selectedContextId),
      0,
    )
    return () => window.clearTimeout(timer)
  }, [
    contextEncoding,
    contextInspectTab,
    contextView,
    latestContextInspect,
    loadContextEncoding,
    selectedContextId,
    selectedSessionId,
    view,
  ])

  useEffect(() => {
    if (view !== 'ledger' || !selectedContextId) return
    const initial = window.setTimeout(() => void loadLedger(selectedContextId, ledgerFilters, ledgerBeforeSequence), 0)
    const interval = window.setInterval(() => void loadLedger(selectedContextId, ledgerFilters, ledgerBeforeSequence), 15000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [ledgerBeforeSequence, ledgerFilters, loadLedger, selectedContextId, view])

  useEffect(() => {
    if (view !== 'scheduler' || !selectedContextId || !route.threadId) {
      const reset = window.setTimeout(() => setThreadDetail(null), 0)
      return () => window.clearTimeout(reset)
    }
    const initial = window.setTimeout(
      () => void loadThreadDetail(selectedContextId, route.threadId ?? ''),
      0,
    )
    const interval = window.setInterval(
      () => void loadThreadDetail(selectedContextId, route.threadId ?? ''),
      5000,
    )
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [loadThreadDetail, route.threadId, selectedContextId, view])

  useEffect(() => {
    if (view !== 'dialogue' || !dialogueActivityOpen || !selectedContextId || !expandedDialogueThreadId) {
      const reset = window.setTimeout(() => setDialogueThreadDetail(null), 0)
      return () => window.clearTimeout(reset)
    }
    let cancelled = false
    const load = async () => {
      try {
        const detail = await DASHBOARD_API.get<ThreadDetailResponse>(
          `/api/contexts/${encodeURIComponent(selectedContextId)}/threads/${encodeURIComponent(expandedDialogueThreadId)}`,
        )
        if (!cancelled && selectedScopeRef.current.contextId === selectedContextId) {
          setDialogueThreadDetail(detail)
          setError('')
        }
      } catch (reason) {
        if (!cancelled) {
          setDialogueThreadDetail(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
    }
    const initial = window.setTimeout(() => void load(), 0)
    const interval = window.setInterval(() => void load(), 3000)
    return () => {
      cancelled = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [dialogueActivityOpen, expandedDialogueThreadId, selectedContextId, view])

  useEffect(() => {
    if (view !== 'cognition' || cognitionView !== 'mind' || !selectedContextId) return
    const initial = window.setTimeout(() => void loadMindTransactions(selectedContextId), 0)
    const interval = window.setInterval(() => void loadMindTransactions(selectedContextId), 15000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [cognitionView, loadMindTransactions, selectedContextId, view])

  useEffect(() => {
    authoritativeRefreshRef.current = (topic: string) => {
      const invalidated = invalidatedQueriesForTopic(topic)
      const refreshesSession = invalidated.includes('session')
      if (refreshesSession) void loadSession(selectedSessionId, selectedContextId)
      if (!refreshesSession && invalidated.includes('overview')) {
        void loadOverview(selectedContextId, selectedSessionId)
      }
      if (view === 'cognition' && invalidated.includes('session')) {
        setContextEncoding(null)
        void loadContextProjection(selectedSessionId, selectedContextId)
      }
      if (view === 'ledger' && invalidated.includes('ledger')) {
        void loadLedger(selectedContextId, ledgerFilters, ledgerBeforeSequence)
      }
      if (view === 'cognition' && cognitionView === 'mind' && invalidated.includes('mind-transactions')) {
        void loadMindTransactions(selectedContextId)
      }
      if (view === 'scheduler' && route.threadId && invalidated.includes('thread')) {
        void loadThreadDetail(selectedContextId, route.threadId)
      }
    }
  }, [
    cognitionView,
    ledgerBeforeSequence,
    ledgerFilters,
    loadLedger,
    loadMindTransactions,
    loadOverview,
    loadContextProjection,
    loadSession,
    loadThreadDetail,
    route.threadId,
    selectedContextId,
    selectedSessionId,
    view,
  ])

  useEffect(() => {
    if (!selectedSessionId) return
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let refreshTimer: number | undefined
    let streamTimer: number | undefined
    let pendingStreamEvents: ModelStreamBatchItem[] = []
    let disposed = false
    const scheduleAuthoritativeRefresh = (topic: string) => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(
        () => authoritativeRefreshRef.current(topic),
        750,
      )
    }
    const flushStreamEvents = () => {
      streamTimer = undefined
      const batch = pendingStreamEvents
      pendingStreamEvents = []
      if (batch.length === 0 || disposed) return
      startTransition(() => {
        dispatchModelStream({
          type: 'stream_batch',
          sessionId: selectedSessionId,
          items: batch,
          nowMs: Date.now(),
        })
      })
    }
    const queueStreamEvent = (item: (typeof pendingStreamEvents)[number]) => {
      pendingStreamEvents.push(item)
      if (streamTimer === undefined) {
        streamTimer = window.setTimeout(flushStreamEvents, MODEL_STREAM_RENDER_INTERVAL_MS)
      }
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
          if (event.topic === 'runtime/model_attempt_snapshot') {
            const items = Array.isArray(event.payload.attempts)
              ? event.payload.attempts.flatMap(value => {
                  if (!value || typeof value !== 'object') return []
                  const item = value as Record<string, unknown>
                  const attemptId = typeof item.attempt_id === 'string' ? item.attempt_id : ''
                  const activationId = typeof item.activation_id === 'string' ? item.activation_id : attemptId
                  if (!attemptId || !activationId) return []
                  return [{
                    attemptId,
                    activationId,
                    threadKind: typeof item.thread_kind === 'string' ? item.thread_kind : 'dialogue_turn',
                    state: typeof item.state === 'string' ? item.state : 'streaming',
                    terminal: false,
                    timestamp: typeof item.timestamp === 'string' ? item.timestamp : event.timestamp,
                    detail: typeof item.detail === 'string' ? item.detail : undefined,
                  } satisfies ModelAttemptStateItem]
                })
              : []
            dispatchModelStream({ type: 'snapshot', sessionId: selectedSessionId, items, nowMs: Date.now() })
            return
          }
          if (event.topic === 'runtime/model_attempt_state') {
            const attemptId = typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : ''
            const activationId = typeof event.payload.activation_id === 'string' ? event.payload.activation_id : attemptId
            if (attemptId && activationId) {
              const terminal = event.payload.terminal === true
              if (terminal) {
                const matchingStreamEvents = pendingStreamEvents.filter(item => (
                  item.attemptId === attemptId || item.activationId === activationId
                ))
                pendingStreamEvents = pendingStreamEvents.filter(item => (
                  item.attemptId !== attemptId && item.activationId !== activationId
                ))
                if (matchingStreamEvents.length > 0) {
                  dispatchModelStream({
                    type: 'stream_batch',
                    sessionId: selectedSessionId,
                    items: matchingStreamEvents,
                    nowMs: Date.now(),
                  })
                }
                if (pendingStreamEvents.length === 0 && streamTimer !== undefined) {
                  window.clearTimeout(streamTimer)
                  streamTimer = undefined
                }
              }
              dispatchModelStream({
                type: 'attempt_state',
                sessionId: selectedSessionId,
                nowMs: Date.now(),
                item: {
                  attemptId,
                  activationId,
                  threadKind: typeof event.payload.thread_kind === 'string' ? event.payload.thread_kind : 'dialogue_turn',
                  state: typeof event.payload.state === 'string' ? event.payload.state : 'streaming',
                  terminal,
                  timestamp: event.timestamp,
                  detail: typeof event.payload.detail === 'string' ? event.payload.detail : undefined,
                },
              })
            }
            scheduleAuthoritativeRefresh(event.topic)
            return
          }
          if (event.topic === 'runtime/model_stream') {
            const attemptId = typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : ''
            const activationId = typeof event.payload.activation_id === 'string' ? event.payload.activation_id : attemptId
            const threadKind = typeof event.payload.thread_kind === 'string' ? event.payload.thread_kind : 'dialogue_turn'
            const stream = event.payload.stream
            if (attemptId && isModelStreamEvent(stream)) {
              queueStreamEvent({ attemptId, activationId, threadKind, timestamp: event.timestamp, stream })
            }
            return
          }
          if (event.topic === 'chat/context_inspect') {
            // The full inspect is intentionally ephemeral: retain only the
            // selected Session's latest exact model input in browser memory.
            // Durable storage keeps hashes and sizes, not another Prompt copy.
            if (typeof event.payload.text === 'string') setLatestContextInspect(event)
            return
          }
          setEventsSessionId(selectedSessionId)
          setEvents(previous => {
            if (previous.some(item => item.id === event.id)) return previous
            return [...previous, event].slice(-1000)
          })
          const causalId = typeof event.payload.activation_id === 'string'
            ? event.payload.activation_id
            : typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : ''
          const resolvesLiveAttempt = event.topic === 'chat/reply'
            || event.topic === 'chat/no_reply'
            || event.topic === 'chat/cancelled'
            || event.topic === 'chat/runtime_error'
            || event.topic === 'chat/progress'
            || event.topic === 'runtime/thread_result'
            || event.topic === 'runtime/reasoning_continuation'
            || event.topic === 'runtime/response_protocol_error'
            || event.topic === 'runtime/response_protocol_fused'
            || event.topic === 'runtime/tool_calls_selected'
            || (event.topic === 'chat/assistant_call' && event.payload.terminal_outcome !== true)
          if (event.topic === 'runtime/model_reasoning_summary' && causalId) {
            const matchingStreamEvents = pendingStreamEvents.filter(item => (
              item.attemptId === causalId || item.activationId === causalId
            ))
            pendingStreamEvents = pendingStreamEvents.filter(item => (
              item.attemptId !== causalId && item.activationId !== causalId
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
              item.attemptId !== causalId && item.activationId !== causalId
            ))
            if (pendingStreamEvents.length === 0 && streamTimer !== undefined) {
              window.clearTimeout(streamTimer)
              streamTimer = undefined
            }
            dispatchModelStream({
              type: 'resolve',
              sessionId: selectedSessionId,
              causalId,
              nowMs: Date.now(),
            })
          }
          scheduleAuthoritativeRefresh(event.topic)
        } catch {
          setError(t('errors.websocketParse'))
        }
      }
      socket.onclose = () => {
        if (disposed) return
        setWsStatus('disconnected')
        pendingStreamEvents = []
        if (streamTimer !== undefined) window.clearTimeout(streamTimer)
        streamTimer = undefined
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
      if (streamTimer !== undefined) window.clearTimeout(streamTimer)
      pendingStreamEvents = []
      socket?.close()
    }
  }, [loadSession, selectedContextId, selectedSessionId, t])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        setView(current => current === 'scheduler' ? 'dialogue' : 'scheduler')
      } else if (event.ctrlKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        setView(current => current === 'cognition' ? 'dialogue' : 'cognition')
      } else if (event.key === 'Escape') {
        setView('dialogue')
        setContextMenuOpen(false)
        setSessionMenuOpen(false)
        setThemeMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [setView])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (contextMenuOpen && contextSelectorRef.current && !contextSelectorRef.current.contains(target)) {
        setContextMenuOpen(false)
      }
      if (sessionMenuOpen && sessionSelectorRef.current && !sessionSelectorRef.current.contains(target)) {
        setSessionMenuOpen(false)
      }
      if (themeMenuOpen && themeSelectorRef.current && !themeSelectorRef.current.contains(target)) {
        setThemeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [contextMenuOpen, sessionMenuOpen, themeMenuOpen])

  const selectedSession = sessions.find(item => item.id === selectedSessionId)
  const selectedContext = contexts.find(item => item.id === selectedContextId)
  const selectedAgent = agents.find(item => item.id === selectedAgentId)
  const visibleContexts = contexts
    .filter(item => item.agent_id === selectedAgentId && item.status === 'active')
    .sort((left, right) => left.title.localeCompare(right.title))
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
  const reasoningContinuationSummaries = useMemo(
    () => selectReasoningContinuationSummaries(sessionEvents),
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
  const visibleCount = messageWindow.sessionId === selectedSessionId
    ? messageWindow.count
    : MESSAGE_PAGE_SIZE
  // Windowing: only the newest MESSAGE_PAGE_SIZE messages are rendered;
  // scrolling to the top pages older ones in without remounting the list.
  const visibleEvents = useMemo(
    () => conversationEvents.slice(-visibleCount),
    [conversationEvents, visibleCount],
  )
  const visibleDialogueEvents = useMemo(
    () => conversationLayout === 'split'
      ? visibleEvents.filter(event => {
          return conversationEventLane(event.topic, event.payload) === 'dialogue'
        })
      : visibleEvents,
    [conversationLayout, visibleEvents],
  )
  const visibleExecutionOutputEvents = useMemo(
    () => conversationLayout === 'split'
      ? visibleEvents.filter(event => {
          return conversationEventLane(event.topic, event.payload) === 'execution_output'
        })
      : [],
    [conversationLayout, visibleEvents],
  )
  const hiddenEventCount = conversationEvents.length - visibleEvents.length
  const visibleReasoningSummaries = useMemo(() => {
    const byEventId = new Map<string, string>()
    for (const event of visibleEvents) {
      const kind = eventKind(event)
      if (kind !== 'agent' && kind !== 'background' && kind !== 'reasoning') continue
      const summary = findReasoningSummaryChainForPayload(
        durableReasoningSummaries,
        reasoningContinuationSummaries,
        event.payload,
      ).map(item => item.text).join('')
      if (summary) byEventId.set(event.id, summary)
    }
    return byEventId
  }, [durableReasoningSummaries, reasoningContinuationSummaries, visibleEvents])
  const streamingAttempts = useMemo(
    () => Object.values(liveModelAttempts)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    [liveModelAttempts],
  )
  const conversationStreamingAttempts = useMemo(
    // Dialogue, Objective and Delivery evaluations can all terminate in a
    // user-visible reply for the active Session. Work evaluations only
    // produce internal Thread results; rendering those here would expose an
    // intermediate draft as if it were the final answer.
    () => streamingAttempts.filter(attempt => ['dialogue_turn', 'objective', 'delivery'].includes(attempt.threadKind)),
    [streamingAttempts],
  )
  const dialogueStreamingAttempts = useMemo(
    () => conversationLayout === 'split'
      ? conversationStreamingAttempts.filter(attempt => attempt.threadKind === 'dialogue_turn')
      : conversationStreamingAttempts,
    [conversationLayout, conversationStreamingAttempts],
  )
  const executionOutputStreamingAttempts = useMemo(
    () => conversationLayout === 'split'
      ? streamingAttempts.filter(attempt => attempt.threadKind !== 'dialogue_turn')
      : [],
    [conversationLayout, streamingAttempts],
  )
  const turnSettlement = useMemo(
    () => findTurnSettlement(sessionEvents, pendingTurn?.rootTurnId ?? null),
    [pendingTurn?.rootTurnId, sessionEvents],
  )
  const turnPending = pendingTurn !== null && turnSettlement === undefined

  useEffect(() => {
    const settledRoot = pendingTurn?.rootTurnId
    if (!settledRoot || !turnSettlement) return
    const timer = window.setTimeout(() => {
      setPendingTurn(current => current?.rootTurnId === settledRoot ? null : current)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [pendingTurn?.rootTurnId, turnSettlement])

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
  const objectives = contextOverview?.objectives ?? contextView?.objectives ?? []
  const activeObjectives = objectives.filter(item => !terminalObjectiveStatuses.has(item.status))
  const runningObjectives = activeObjectives.filter(item => item.status === 'active')
  const blockedObjectives = activeObjectives.filter(item => item.status === 'blocked')
  const pausedObjectives = activeObjectives.filter(item => item.status === 'paused')
  const schedulerThreads = useMemo(
    () => schedulerSnapshot?.threads ?? [],
    [schedulerSnapshot],
  )
  const acknowledgedAttentionKeys = useMemo(
    () => new Set(
      attentionAcknowledgements
        .filter(item => item.context_id === selectedContextId)
        .map(item => item.key),
    ),
    [attentionAcknowledgements, selectedContextId],
  )
  const dialogueActivityObjectives = [...activeObjectives].sort((left, right) => {
    const leftCurrent = left.coordinator_session_id === selectedSessionId || left.delivery_session_id === selectedSessionId
    const rightCurrent = right.coordinator_session_id === selectedSessionId || right.delivery_session_id === selectedSessionId
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
    return right.updated_at.localeCompare(left.updated_at)
  })
  const { dialogueActivityThreads, dialogueActivityHistoryThreads } = useMemo(() => {
    const phaseRank: Record<SchedulerThreadSnapshot['phase'], number> = { running: 0, runnable: 1, waiting: 2, idle: 3 }
    const executionBearingThreads = schedulerThreads.filter(threadCarriesExecution)
    // Thread lifecycle and Scheduler phase are deliberately orthogonal. An
    // open+idle Thread may accept future Signals, but it is not executing now.
    const active = executionBearingThreads.filter(snapshot => snapshot.phase !== 'idle')
    const activeIds = new Set(active.map(snapshot => snapshot.thread.id))
    const history = executionBearingThreads
      .filter(snapshot => !activeIds.has(snapshot.thread.id))
      .sort((left, right) => right.thread.updated_at.localeCompare(left.thread.updated_at))
      .slice(0, DIALOGUE_ACTIVITY_HISTORY_LIMIT)
    const sortThreads = (items: SchedulerThreadSnapshot[]) => items.sort((left, right) => {
        const leftCurrent = left.thread.session_id === selectedSessionId
        const rightCurrent = right.thread.session_id === selectedSessionId
        if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
        if (phaseRank[left.phase] !== phaseRank[right.phase]) return phaseRank[left.phase] - phaseRank[right.phase]
        return right.thread.updated_at.localeCompare(left.thread.updated_at)
      })
    return {
      dialogueActivityThreads: sortThreads(active),
      dialogueActivityHistoryThreads: sortThreads(history),
    }
  }, [schedulerThreads, selectedSessionId])
  const showDialogueActivity = Boolean(selectedContextId && selectedSessionId)
  const visibleSchedulerThreads = useMemo(() => {
    const active = schedulerThreads.filter(snapshot => snapshot.phase !== 'idle')
    const activeIds = new Set(active.map(snapshot => snapshot.thread.id))
    const recentHistory = schedulerThreads
      .filter(snapshot => !activeIds.has(snapshot.thread.id))
      .sort((left, right) => right.thread.updated_at.localeCompare(left.thread.updated_at))
      .slice(0, WORK_HISTORY_THREAD_LIMIT)
    return [...active, ...recentHistory]
  }, [schedulerThreads])
  const hiddenSchedulerThreadCount = schedulerThreads.length - visibleSchedulerThreads.length
  const schedulerHistoryPageFull = view === 'scheduler'
    && schedulerThreads.length >= schedulerHistoryLimit
    && schedulerThreads.some(snapshot => snapshot.thread.lifecycle !== 'open')
  const schedulerThreadGroups = useMemo(() => {
    const groups: Record<'attention' | 'running' | 'runnable' | 'waiting' | 'recent', SchedulerThreadSnapshot[]> = {
      attention: [],
      running: [],
      runnable: [],
      waiting: [],
      recent: [],
    }
    for (const snapshot of visibleSchedulerThreads) {
      const jobs = snapshot.activations.flatMap(activation => activation.jobs)
      const needsAttention = jobs.some(job => (
        job.approval?.status === 'pending_human' || (
          (job.job.status === 'failed' || job.job.status === 'lost')
          && !acknowledgedAttentionKeys.has(attentionJobKey('execution_job', job))
        )
      )) || (
        snapshot.thread.lifecycle === 'completed'
        && !['none', 'delivered'].includes(snapshot.thread.delivery_status)
        && !acknowledgedAttentionKeys.has(attentionDeliveryKey(snapshot))
      )
      if (needsAttention) groups.attention.push(snapshot)
      else if (snapshot.phase === 'running') groups.running.push(snapshot)
      else if (snapshot.phase === 'runnable') groups.runnable.push(snapshot)
      else if (snapshot.phase === 'waiting') groups.waiting.push(snapshot)
      else groups.recent.push(snapshot)
    }
    return (Object.entries(groups) as Array<[keyof typeof groups, SchedulerThreadSnapshot[]]>)
      .filter(([, snapshots]) => snapshots.length > 0)
  }, [acknowledgedAttentionKeys, visibleSchedulerThreads])
  const derivedThreadsByRootTurn = useMemo(() => {
    const byRootTurn = new Map<string, SchedulerThreadSnapshot[]>()
    for (const snapshot of schedulerThreads) {
      if (snapshot.thread.kind === 'dialogue_turn') continue
      const existing = byRootTurn.get(snapshot.thread.root_turn_id) ?? []
      existing.push(snapshot)
      byRootTurn.set(snapshot.thread.root_turn_id, existing)
    }
    for (const snapshots of byRootTurn.values()) {
      snapshots.sort((left, right) => left.thread.created_at.localeCompare(right.thread.created_at))
    }
    return byRootTurn
  }, [schedulerThreads])
  const threadDetailLiveAttempts = useMemo(() => {
    if (!threadDetail) return []
    const activationIds = new Set(
      threadDetail.snapshot.activations.map(snapshot => snapshot.activation.id),
    )
    return streamingAttempts.filter(attempt => activationIds.has(attempt.activationId))
  }, [streamingAttempts, threadDetail])
  const activations = schedulerThreads.flatMap(thread => thread.activations.map(item => item.activation))
  const threadSignals = schedulerThreads.flatMap(thread => [
    ...thread.pending_signals,
    ...thread.activations.flatMap(activation => activation.signals),
  ])
  const schedules = schedulerSchedules(schedulerSnapshot)
  const actionableJobRows = actionableSchedulerJobs(schedulerSnapshot)
  const pendingApprovals = pendingHumanApprovals(schedulerSnapshot)
  const approvalAnomalies = schedulerApprovalAnomalies(schedulerSnapshot)
    .filter(snapshot => !acknowledgedAttentionKeys.has(attentionJobKey('approval_anomaly', snapshot)))
  const failedSchedulerJobs = schedulerAttentionJobs(schedulerSnapshot)
    .filter(snapshot => !acknowledgedAttentionKeys.has(attentionJobKey('execution_job', snapshot)))
  const failedDeliveries = schedulerThreads.filter(item => {
    if (item.thread.delivery_status === 'none' || item.thread.delivery_status === 'delivered') return false
    const failedActivation = item.activations.some(activation => activation.activation.status === 'failed')
    const unresolved = item.thread.lifecycle === 'completed'
      || (item.thread.lifecycle === 'open' && item.phase === 'idle' && failedActivation)
    return unresolved && !acknowledgedAttentionKeys.has(attentionDeliveryKey(item))
  })
  const attentionCount = pendingApprovals.length
    + approvalAnomalies.length
    + failedSchedulerJobs.length
    + failedDeliveries.length
  const runningActivations = activations.filter(item => item.status === 'queued' || item.status === 'running')
  const contextDelegations = delegations.filter(item => item.parent_context_id === selectedContextId)
  const liveDelegations = contextDelegations.filter(item => !terminalTaskStatuses.has(item.status))
  const runningDelegations = liveDelegations.filter(item => item.status === 'queued' || item.status === 'running')
  const dialogueActivityDelegations = [...liveDelegations].sort((left, right) => {
    const leftCurrent = left.parent_session_id === selectedSessionId
    const rightCurrent = right.parent_session_id === selectedSessionId
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
    return right.updated_at.localeCompare(left.updated_at)
  })
  const activeWorkCount = schedulerSnapshot
    ? schedulerSnapshot.summary.running_activations + schedulerSnapshot.summary.queued_activations
    : 0
  const durableEventQueueDepth = Number(schedulerSnapshot?.event_writer?.queue_depth ?? 0)
  const durableEventContentionRetries = Number(schedulerSnapshot?.event_writer?.contention_retries ?? 0)
  const waitingCount = schedulerSnapshot
    ? actionableJobRows.filter(item => item.job.status === 'waiting_approval').length
      + schedulerSnapshot.summary.active_schedules
    : runningObjectives.filter(item => Boolean(item.wait_condition)).length
  const selectedFrame = contextView?.state.frames.find(frame => frame.id === selectedFrameId)
  const activePrincipalId = contextView?.active_principal_id
    ?? contextOverview?.sessions.find(session => session.session.id === selectedSessionId)?.principal_ids?.[0]
    ?? contextView?.sessions.find(session => session.session.id === selectedSessionId)?.principal_ids?.[0]
    ?? status?.principal_id
  const selectedFrameLineage = frameLineage?.root_frame_id === selectedFrameId ? frameLineage : null
  const retired = new Set(contextView?.state.retired ?? [])
  const retiring = contextView?.state.retiring ?? {}
  const activeFrameCount = contextOverview?.active_frames
    ?? (contextView?.state.frames ?? []).filter(frame => !retired.has(frame.id)).length
  const retiringFrameCount = Object.keys(retiring).length
  const selectedRetirement = selectedFrame ? retiring[selectedFrame.id] : undefined
  const hasExactContextInspect = latestContextInspect !== null
    && latestContextInspect.payload.session_id === selectedSessionId
    && typeof latestContextInspect.payload.text === 'string'
  const contextInspectPayload = hasExactContextInspect ? latestContextInspect.payload : null
  const contextInspectContent = (() => {
    switch (contextInspectTab) {
      case 'encoding':
        return typeof contextInspectPayload?.text === 'string'
          ? contextInspectPayload.text
          : contextEncoding?.session_id === selectedSessionId
            ? contextEncoding.encoding
            : contextView?.sexpr ?? ''
      case 'attribution':
        return JSON.stringify(contextInspectPayload?.attribution ?? contextView?.attribution ?? {}, null, 2)
      case 'messages':
        return contextInspectPayload?.messages === undefined
          ? t('mindView.contextInspect.notRetained')
          : JSON.stringify(contextInspectPayload.messages, null, 2)
      case 'tools':
        return contextInspectPayload?.tools === undefined
          ? t('mindView.contextInspect.notRetained')
          : JSON.stringify(contextInspectPayload.tools, null, 2)
      case 'mind':
        return JSON.stringify(contextInspectPayload?.mind ?? contextView?.state ?? {}, null, 2)
      case 'inbox':
        return JSON.stringify(contextInspectPayload?.inbox ?? contextView?.observations ?? [], null, 2)
      case 'metadata':
        return JSON.stringify(
          contextInspectPayload
            ? contextInspectMetadata(contextInspectPayload)
            : {
                context_id: contextView?.context_id,
                session_id: contextView?.active_session_id,
                pressure: contextView?.pressure,
                source: 'current-context-encoding',
              },
          null,
          2,
        )
    }
  })()

  useEffect(() => {
    // Restore composer focus once a send finishes so the user can keep typing.
    if (wasSending.current && !sending) composerInputRef.current?.focus()
    wasSending.current = sending
  }, [sending])

  useEffect(() => {
    loadingOlder.current = false
    pendingScrollRestore.current = null
  }, [selectedSessionId])

  useEffect(() => {
    // Older messages were prepended; keep the viewport anchored to the same
    // message by shifting scrollTop down by the added height.
    if (pendingScrollRestore.current === null) return
    const container = conversationLayout === 'split' ? conversationLaneRef.current : viewFrameRef.current
    const previousHeight = pendingScrollRestore.current
    pendingScrollRestore.current = null
    if (container) container.scrollTop += container.scrollHeight - previousHeight
    loadingOlder.current = false
  }, [conversationLayout, visibleCount])

  useEffect(() => {
    if (view !== 'dialogue') {
      conversationPinnedToEnd.current = true
      return
    }
    if (!conversationPinnedToEnd.current) return
    const timer = window.setTimeout(() => {
      const container = conversationLayout === 'split' ? conversationLaneRef.current : viewFrameRef.current
      if (container) {
        lastProgrammaticScroll.current = Date.now()
        container.scrollTop = container.scrollHeight
      } else {
        conversationEnd.current?.scrollIntoView({ block: 'end' })
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [conversationEvents.length, conversationLayout, conversationStreamingAttempts, turnPending, view])

  useEffect(() => {
    if (view !== 'dialogue') return
    const container = conversationLayout === 'split' ? conversationLaneRef.current : viewFrameRef.current
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
  }, [conversationLayout, view])

  useEffect(() => {
    if (view !== 'dialogue' || conversationLayout !== 'split' || !executionOutputPinnedToEnd.current) return
    const timer = window.setTimeout(() => {
      const container = executionOutputLaneRef.current
      if (container) {
        lastExecutionProgrammaticScroll.current = Date.now()
        container.scrollTop = container.scrollHeight
      }
      else executionOutputEnd.current?.scrollIntoView({ block: 'end' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [conversationLayout, executionOutputStreamingAttempts, visibleExecutionOutputEvents.length, view])

  useEffect(() => {
    if (view !== 'dialogue') return

    // A newly selected Session or layout is a fresh presentation surface. Start
    // both tracks at their newest content; subsequent user scrolling can unpin
    // either lane independently.
    conversationPinnedToEnd.current = true
    executionOutputPinnedToEnd.current = true
    const frame = window.requestAnimationFrame(() => {
      const conversationContainer = conversationLayout === 'split'
        ? conversationLaneRef.current
        : viewFrameRef.current
      if (conversationContainer) {
        lastProgrammaticScroll.current = Date.now()
        conversationContainer.scrollTop = conversationContainer.scrollHeight
      }
      if (conversationLayout === 'split' && executionOutputLaneRef.current) {
        lastExecutionProgrammaticScroll.current = Date.now()
        executionOutputLaneRef.current.scrollTop = executionOutputLaneRef.current.scrollHeight
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [conversationLayout, selectedSessionId, view])

  useEffect(() => {
    if (view !== 'dialogue' || conversationLayout !== 'split' || typeof ResizeObserver === 'undefined') return

    // Streaming Markdown, reasoning blocks, tables, and images can grow without
    // changing the event count. Observe the actual lane contents so each track
    // remains pinned while the user is following the newest output.
    const conversationObserver = new ResizeObserver(() => {
      const container = conversationLaneRef.current
      if (!container || !conversationPinnedToEnd.current) return
      lastProgrammaticScroll.current = Date.now()
      container.scrollTop = container.scrollHeight
    })
    const executionObserver = new ResizeObserver(() => {
      const container = executionOutputLaneRef.current
      if (!container || !executionOutputPinnedToEnd.current) return
      lastExecutionProgrammaticScroll.current = Date.now()
      container.scrollTop = container.scrollHeight
    })
    if (conversationMessageListRef.current) conversationObserver.observe(conversationMessageListRef.current)
    if (executionOutputListRef.current) executionObserver.observe(executionOutputListRef.current)
    return () => {
      conversationObserver.disconnect()
      executionObserver.disconnect()
    }
  }, [conversationLayout, selectedSessionId, view])

  const handleConversationScroll = useCallback((container: HTMLDivElement) => {
    // Ignore the scroll events fired by our own programmatic scrolling;
    // content growth between the scroll and the event would otherwise look
    // like the user scrolled away from the bottom.
    if (Date.now() - lastProgrammaticScroll.current < 120) return
    conversationPinnedToEnd.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48
    if (container.scrollTop < 80 && !loadingOlder.current && hiddenEventCount > 0) {
      loadingOlder.current = true
      pendingScrollRestore.current = container.scrollHeight
      setMessageWindow(current => ({
        sessionId: selectedSessionId,
        count: Math.min(
          (current.sessionId === selectedSessionId ? current.count : MESSAGE_PAGE_SIZE) + MESSAGE_PAGE_SIZE,
          conversationEvents.length,
        ),
      }))
    }
  }, [conversationEvents.length, hiddenEventCount, selectedSessionId])

  const activateContext = useCallback((context: ContextRecord, destination?: DashboardView) => {
    const nextSession = sessions
      .filter(item => item.context_id === context.id && item.status === 'active')
      .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))[0]
    setPendingTurn(null)
    setSelectedAgentId(context.agent_id)
    setSelectedContextId(context.id)
    setSelectedSessionId(nextSession?.id ?? '')
    setContextView(null)
    setContextEncoding(null)
    setContextOverview(null)
    setSchedulerSnapshot(null)
    setEvents([])
    setEventsSessionId('')
    setFrameLineage(null)
    setSelectedFrameId('')
    setContextMenuOpen(false)
    setSessionMenuOpen(false)
    const nextView = destination ?? (nextSession ? 'dialogue' : 'overview')
    navigate(dashboardPath(nextView, context.id, nextSession?.id, nextView === 'cognition' ? 'mind' : undefined))
    window.setTimeout(() => composerInputRef.current?.focus(), 0)
  }, [navigate, sessions])

  const createContext = useCallback(async (): Promise<ContextRecord | null> => {
    if (creatingContext) return null
    const agentId = selectedAgentId || status?.agent_id || agents[0]?.id || ''
    if (!agentId) {
      setError(t('errors.noAgentForContext'))
      return null
    }
    setCreatingContext(true)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/contexts`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          agent_id: agentId,
          title: t('header.newContextTitle', { count: visibleContexts.length + 1 }),
        }),
      })
      if (!response.ok) throw new Error(t('errors.createContext', { status: response.status }))
      const context = await response.json() as ContextRecord
      setContexts(current => [...current.filter(item => item.id !== context.id), context])
      activateContext(context)
      setError('')
      return context
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return null
    } finally {
      setCreatingContext(false)
    }
  }, [activateContext, agents, apiHeaders, creatingContext, selectedAgentId, status?.agent_id, t, visibleContexts.length])

  const createSession = useCallback(async (targetContext?: ContextRecord): Promise<SessionRecord | null> => {
    if (creatingSession) return null
    const context = targetContext ?? selectedContext
    const contextId = context?.id ?? selectedContextId
    if (!contextId) {
      setError(t('errors.noContextForSession'))
      return null
    }
    const agentId = context?.agent_id || selectedAgentId || status?.agent_id || undefined
    const count = sessions.filter(item => item.context_id === contextId).length
    setCreatingSession(true)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/sessions`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          agent_id: agentId,
          title: t('header.newSessionTitle', { count: count + 1 }),
          mount: { type: 'existing_context', context_id: contextId },
        }),
      })
      if (!response.ok) throw new Error(t('errors.createSession', { status: response.status }))
      const session = await response.json() as SessionRecord
      setSessions(current => [...current.filter(item => item.id !== session.id), session])
      setPendingTurn(null)
      setSelectedAgentId(session.agent_id)
      setSelectedContextId(session.context_id)
      setSelectedSessionId(session.id)
      setContextMenuOpen(false)
      setSessionMenuOpen(false)
      navigate(dashboardPath('dialogue', session.context_id, session.id))
      setError('')
      window.setTimeout(() => composerInputRef.current?.focus(), 0)
      return session
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return null
    } finally {
      setCreatingSession(false)
    }
  }, [apiHeaders, creatingSession, navigate, selectedAgentId, selectedContext, selectedContextId, sessions, status?.agent_id, t])

  const chooseSession = (session: SessionRecord) => {
    if (session.id !== selectedSessionId) {
      setPendingTurn(null)
    }
    setSelectedAgentId(session.agent_id)
    setFrameLineage(null)
    setSelectedContextId(session.context_id)
    setSelectedSessionId(session.id)
    setSessionMenuOpen(false)
    navigate(dashboardPath('dialogue', session.context_id, session.id))
  }

  const renameContext = async (context: ContextRecord) => {
    const requested = await requestText({
      title: t('header.renameContext'),
      description: t('dialog.renameContext'),
      inputLabel: t('dialog.nameLabel'),
      defaultValue: context.title,
      confirmLabel: t('dialog.actions.save'),
      cancelLabel: t('dialog.actions.cancel'),
    })
    const title = requested?.trim()
    if (!title || title === context.title) return
    const mutationKey = `context:${context.id}:rename`
    setCatalogMutationKey(mutationKey)
    try {
      const updated = await DASHBOARD_API.command<ContextRecord>(
        `/api/contexts/${encodeURIComponent(context.id)}`,
        'PATCH',
        { title },
      )
      setContexts(current => current.map(item => item.id === updated.id ? updated : item))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCatalogMutationKey('')
    }
  }

  const archiveContext = async (context: ContextRecord) => {
    if (selectedAgent?.root_context_id === context.id) return
    const confirmed = await requestConfirmation({
      title: t('header.archiveContext'),
      description: t('dialog.archiveContext', { title: context.title }),
      confirmLabel: t('dialog.actions.archive'),
      cancelLabel: t('dialog.actions.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    const mutationKey = `context:${context.id}:archive`
    setCatalogMutationKey(mutationKey)
    try {
      const archived = await DASHBOARD_API.command<ContextRecord>(
        `/api/contexts/${encodeURIComponent(context.id)}`,
        'PATCH',
        { status: 'archived' },
      )
      setContexts(current => current.map(item => item.id === archived.id ? archived : item))
      setSessions(current => current.map(item => item.context_id === archived.id
        ? { ...item, status: 'archived' }
        : item))
      if (selectedContextId === archived.id) {
        const fallback = visibleContexts.find(item => item.id !== archived.id)
        if (fallback) activateContext(fallback)
        else {
          setSelectedContextId('')
          setSelectedSessionId('')
          setContextMenuOpen(false)
          setSessionMenuOpen(false)
          navigate(dashboardPath('overview'))
        }
      }
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCatalogMutationKey('')
    }
  }

  const renameSession = async (session: SessionRecord) => {
    const requested = await requestText({
      title: t('header.renameSession'),
      description: t('dialog.renameSession'),
      inputLabel: t('dialog.nameLabel'),
      defaultValue: session.title,
      confirmLabel: t('dialog.actions.save'),
      cancelLabel: t('dialog.actions.cancel'),
    })
    const title = requested?.trim()
    if (!title || title === session.title) return
    const mutationKey = `session:${session.id}:rename`
    setCatalogMutationKey(mutationKey)
    try {
      const updated = await DASHBOARD_API.command<SessionRecord>(
        `/api/sessions/${encodeURIComponent(session.id)}`,
        'PATCH',
        { title },
      )
      setSessions(current => current.map(item => item.id === updated.id ? updated : item))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCatalogMutationKey('')
    }
  }

  const archiveSession = async (session: SessionRecord) => {
    const confirmed = await requestConfirmation({
      title: t('header.archiveSession'),
      description: t('dialog.archiveSession', { title: session.title }),
      confirmLabel: t('dialog.actions.archive'),
      cancelLabel: t('dialog.actions.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    const mutationKey = `session:${session.id}:archive`
    setCatalogMutationKey(mutationKey)
    try {
      const archived = await DASHBOARD_API.command<SessionRecord>(
        `/api/sessions/${encodeURIComponent(session.id)}`,
        'PATCH',
        { status: 'archived' },
      )
      setSessions(current => current.map(item => item.id === archived.id ? archived : item))
      if (selectedSessionId === archived.id) {
        const fallback = visibleSessions.find(item => item.id !== archived.id)
        if (fallback) chooseSession(fallback)
        else {
          setSelectedSessionId('')
          setSessionMenuOpen(false)
          navigate(dashboardPath('overview', session.context_id))
        }
      }
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCatalogMutationKey('')
    }
  }

  const copyMessage = async (text: string, messageId: string) => {
    if (!text) return
    try {
      await copyTextToClipboard(text)
      setCopiedMessageId(messageId)
      window.setTimeout(() => setCopiedMessageId(''), 1200)
    } catch {
      setError(t('errors.copyFailed'))
    }
  }

  const addQuote = useCallback((popup: SelectionPopup) => {
    setQuotes(prev => [...prev, {
      id: `quote-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: popup.text,
      eventId: popup.eventId,
      eventActor: popup.eventActor,
      eventTime: popup.eventTime,
      comment: '',
      badgeTop: popup.relTop,
      badgeLeft: popup.relLeft,
    }])
    composerInputRef.current?.focus()
  }, [])

  const removeQuote = useCallback((quoteId: string) => {
    setQuotes(prev => prev.filter(q => q.id !== quoteId))
  }, [])

  const updateQuoteComment = useCallback((quoteId: string, comment: string) => {
    setQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, comment } : q))
  }, [])

  const sendMessage = useCallback(async (draftMessage: string): Promise<boolean> => {
    const hasQuotes = quotes.length > 0
    const text = draftMessage.trim()
    if (!text && !hasQuotes) return false
    if (sending) return false
    const composedText = hasQuotes
      ? quotes.map((q, i) => {
          const block = `> [${i + 1}] ${q.text.replace(/\n/g, '\n> ')}\n> — ${q.eventActor}, ${q.eventTime}, ${q.eventId}`
          return q.comment.trim() ? `${block}\n\n${q.comment.trim()}` : block
        }).join('\n\n') + (text ? `\n\n${text}` : '')
      : text
    setSending(true)
    conversationPinnedToEnd.current = true
    let startedAt: number | null = null
    try {
      let targetContext: ContextRecord | null | undefined = selectedContext
      if (!targetContext) {
        targetContext = await createContext()
        if (!targetContext) return false
      }
      let targetSession: SessionRecord | null | undefined = selectedSession
      if (!targetSession || targetSession.context_id !== targetContext.id) {
        targetSession = await createSession(targetContext)
        if (!targetSession) return false
      }
      startedAt = Date.now()
      setPendingTurn({ startedAt, rootTurnId: null })
      const response = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(targetSession.id)}/messages`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          text: composedText,
          client_message_id: `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        }),
      })
      if (!response.ok) throw new Error(t('errors.sendMessage', { status: response.status }))
      const receipt = await response.json() as { event_id?: string }
      setPendingTurn(current => current?.startedAt === startedAt
        ? { ...current, rootTurnId: receipt.event_id ?? null }
        : current)
      setQuotes([])
      setError('')
      window.setTimeout(() => void loadSession(targetSession.id, targetSession.context_id), 120)
      return true
    } catch (reason) {
      if (startedAt !== null) {
        setPendingTurn(current => current?.startedAt === startedAt ? null : current)
      }
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSending(false)
    }
  }, [apiHeaders, createContext, createSession, loadSession, quotes, selectedContext, selectedSession, sending, t])

  const cancelCurrentSession = useCallback(async () => {
    if (!selectedSessionId) return
    const response = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(selectedSessionId)}/cancel`, {
      method: 'POST',
      headers: apiHeaders(),
    })
    if (!response.ok) setError(t('errors.cancelSession', { status: response.status }))
  }, [apiHeaders, selectedSessionId, t])

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
      const inference = await response.json() as { reasoning_effort?: ReasoningEffortSetting | null }
      setStatus(current => current ? { ...current, reasoning_effort: inference.reasoning_effort } : current)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangingReasoning(false)
    }
  }

  const auditMindProjection = async () => {
    if (!selectedContextId || auditingProjection) return
    setAuditingProjection(true)
    try {
      const audit = await DASHBOARD_API.command<MindProjectionAudit>(
        `/api/contexts/${encodeURIComponent(selectedContextId)}/projection-audit`,
        'POST',
      )
      setProjectionAudit(audit)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAuditingProjection(false)
    }
  }

  const toggleObjectiveExpanded = useCallback((objectiveId: string) => {
    setExpandedObjectiveIds(current => {
      const next = new Set(current)
      if (next.has(objectiveId)) next.delete(objectiveId)
      else next.add(objectiveId)
      return next
    })
  }, [])

  const pauseObjective = async (objective: ObjectiveRecord) => {
    if (pausingObjectiveId || resumingObjectiveId || deletingObjectiveId) return
    setPausingObjectiveId(objective.id)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/objectives/${encodeURIComponent(objective.id)}/pause`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          expected_revision: objective.revision,
          reason: t('reason.pauseByUser'),
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? t('errors.pauseObjective', { status: response.status }))
      }
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPausingObjectiveId('')
    }
  }

  const resumeObjective = async (objective: ObjectiveRecord) => {
    if (pausingObjectiveId || resumingObjectiveId || deletingObjectiveId) return
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
    if (pausingObjectiveId || resumingObjectiveId || deletingObjectiveId) return
    const confirmed = await requestConfirmation({
      title: t('dialog.deleteObjectiveTitle'),
      description: t('dialog.deleteObjectiveBody', { objective: objective.stated_objective }),
      confirmLabel: t('dialog.actions.delete'),
      cancelLabel: t('dialog.actions.cancel'),
      tone: 'danger',
    })
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
      setExpandedObjectiveIds(current => {
        const next = new Set(current)
        next.delete(objective.id)
        return next
      })
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeletingObjectiveId('')
    }
  }

  const decideApproval = async (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => {
    if (decision === 'deny') {
      const confirmed = await requestConfirmation({
        title: t('dialog.denyApprovalTitle'),
        description: t('dialog.denyApproval'),
        confirmLabel: t('dialog.actions.deny'),
        cancelLabel: t('dialog.actions.cancel'),
        tone: 'danger',
      })
      if (!confirmed) return
    }
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

  const acknowledgeAttention = async (
    key: string,
    sourceKind: string,
    sourceId: string,
    sourceRevision: number,
  ) => {
    if (!selectedContextId || acknowledgingAttentionKey) return
    setAcknowledgingAttentionKey(key)
    try {
      const acknowledgement = await DASHBOARD_API.command<AttentionAcknowledgement>(
        `/api/contexts/${encodeURIComponent(selectedContextId)}/attention/acknowledgements`,
        'POST',
        {
          key,
          source_kind: sourceKind,
          source_id: sourceId,
          source_revision: sourceRevision,
          rationale: t('reason.attentionAcknowledged'),
        },
      )
      setAttentionAcknowledgements(current => [
        acknowledgement,
        ...current.filter(item => item.key !== acknowledgement.key),
      ])
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAcknowledgingAttentionKey('')
    }
  }

  const mutateSchedule = async (
    schedule: ScheduleRecord,
    action: 'pause' | 'resume' | 'reschedule' | 'cancel',
  ) => {
    if (action === 'cancel') {
      const confirmed = await requestConfirmation({
        title: t('dialog.cancelScheduleTitle'),
        description: t('dialog.cancelSchedule'),
        confirmLabel: t('dialog.actions.cancelSchedule'),
        cancelLabel: t('dialog.actions.keep'),
        tone: 'danger',
      })
      if (!confirmed) return
    }
    let notBefore: string | undefined
    let intervalSeconds: number | undefined
    if (action === 'reschedule') {
      const requested = await requestText({
        title: t('work.schedules.reschedule'),
        description: t('dialog.rescheduleAt'),
        inputLabel: t('dialog.rescheduleAt'),
        defaultValue: schedule.not_before ?? new Date().toISOString(),
        confirmLabel: t('dialog.actions.continue'),
        cancelLabel: t('dialog.actions.cancel'),
      })
      if (requested === null) return
      const parsed = new Date(requested)
      if (Number.isNaN(parsed.getTime())) {
        setError(t('errors.invalidScheduleDate'))
        return
      }
      notBefore = parsed.toISOString()
      const interval = await requestText({
        title: t('work.schedules.reschedule'),
        description: t('dialog.rescheduleInterval'),
        inputLabel: t('dialog.rescheduleInterval'),
        defaultValue: schedule.interval_seconds?.toString() ?? '',
        allowEmpty: true,
        placeholder: t('dialog.optional'),
        confirmLabel: t('dialog.actions.save'),
        cancelLabel: t('dialog.actions.cancel'),
      })
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

  const leadingActivation = runningActivations[0]
  const activationSummary = leadingActivation
    ? summarizeActivation(leadingActivation, sessionEvents, toolTimeline, t).title
    : ''
  const primaryJob = actionableJobRows.find(item => (
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
            label: primaryJob.job.status === 'waiting_approval'
              ? primaryJob.approval?.status === 'allowed'
                ? t('composer.status.approvalGranted')
                : primaryJob.approval?.status === 'pending_auto'
                  ? t('composer.status.approvalReviewing')
                  : t('composer.status.approvalStateInvalid')
              : t('composer.status.executing'),
            summary: primaryJobSummary ? `${primaryJobSummary.title} · ${primaryJobSummary.target}` : primaryJob.job.tool_name,
          }
        : durableEventQueueDepth > 0
            ? {
                state: 'waiting',
                label: t('composer.status.persistingEvents'),
                summary: t('composer.status.eventWriterQueue', {
                  count: durableEventQueueDepth,
                  retries: durableEventContentionRetries,
                }),
              }
          : schedulerSnapshot && schedulerSnapshot.admission.context_deferred > 0
            ? { state: 'waiting', label: t('composer.status.backpressure'), summary: t('composer.status.deferredCount', { count: schedulerSnapshot.admission.context_deferred }) }
          : runningDelegations[0]
        ? { state: 'running', label: t('composer.status.delegating'), summary: runningDelegations[0].task }
        : waitingCount > 0
          ? { state: 'waiting', label: t('composer.status.running'), summary: schedules[0]?.intent ?? runningObjectives.find(item => item.wait_condition)?.stated_objective ?? t('composer.status.waitingEvent') }
          : blockedObjectives[0]
            ? { state: 'blocked', label: t('composer.status.blocked'), summary: blockedObjectives[0].stated_objective }
            : pausedObjectives[0]
              ? { state: 'paused', label: t('composer.status.paused'), summary: pausedObjectives[0].stated_objective }
              : runningObjectives[0]
                ? { state: 'active', label: t('composer.status.active'), summary: runningObjectives[0].stated_objective }
                : leadingActivation
                  ? {
                      state: 'running',
                      label: leadingActivation.status === 'queued'
                        ? t('composer.status.waitingRuntimeAdmission')
                        : t('composer.status.modelResponding'),
                      summary: activationSummary,
                    }
                  : { state: 'idle', label: t('composer.status.idle'), summary: t('composer.status.noWork') }
  const latestTurnEvent = !turnPending || pendingTurn === null ? undefined : [...sessionEvents]
    .reverse()
    .find(event => pendingTurn.rootTurnId !== null
      ? event.payload.root_turn_id === pendingTurn.rootTurnId || event.id === pendingTurn.rootTurnId
      : new Date(event.timestamp).getTime() >= pendingTurn.startedAt - 1000)
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
    if (latestTurnEvent.topic === 'runtime/model_attempt_state') return t('turnStatus.modelEval')
    return t('turnStatus.waiting')
  }, [latestTurnEvent, t])

  const currentTheme = accentThemes.find(theme => theme.id === accentTheme)
  const currentLangCode = i18n.language?.startsWith('zh') ? 'ZH' : 'EN'
  const applyLedgerFilters = (filters: LedgerFilters) => {
    setLedgerPage(null)
    setLedgerBeforeSequence('')
    setLedgerCursorHistory([])
    setLedgerFilters(filters)
  }
  const loadOlderLedgerPage = () => {
    const next = ledgerPage?.next_before_sequence
    if (next === undefined) return
    setLedgerCursorHistory(current => [...current, ledgerBeforeSequence])
    setLedgerBeforeSequence(String(next))
  }
  const loadNewerLedgerPage = () => {
    const previous = ledgerCursorHistory.at(-1)
    if (previous === undefined) return
    setLedgerCursorHistory(current => current.slice(0, -1))
    setLedgerBeforeSequence(previous)
  }

  const renderDialogueActivityDock = () => (
    <DialogueActivityDock
      open={dialogueActivityOpen}
      objectives={dialogueActivityObjectives}
      threads={dialogueActivityThreads}
      historyThreads={dialogueActivityHistoryThreads}
      delegations={dialogueActivityDelegations}
      currentSessionId={selectedSessionId}
      expandedThreadId={expandedDialogueThreadId}
      threadDetail={dialogueThreadDetail}
      liveModelAttempts={streamingAttempts}
      showReasoningSummary={showReasoningSummary}
      expandedObjectiveIds={expandedObjectiveIds}
      pausingObjectiveId={pausingObjectiveId}
      resumingObjectiveId={resumingObjectiveId}
      deletingObjectiveId={deletingObjectiveId}
      t={t}
      onOpenChange={setDialogueActivityOpen}
      onThreadToggle={threadId => {
        setExpandedDialogueThreadId(current => current === threadId ? '' : threadId)
        setDialogueThreadDetail(null)
      }}
      onReasoningOpenChange={setShowReasoningSummary}
      onInspectThread={threadId => navigate(threadPath(selectedContextId, threadId))}
      onObjectiveToggle={toggleObjectiveExpanded}
      onPauseObjective={objective => void pauseObjective(objective)}
      onResumeObjective={objective => void resumeObjective(objective)}
      onDeleteObjective={objective => void deleteObjective(objective)}
    />
  )

  return (
    <main className="page-shell" data-accent={accentTheme} data-color-mode={resolvedAppearanceMode}>
      <section className="morphz-shell" data-accent={accentTheme} data-view={view}>
        <header className="runtime-header">
          <button className="brand" type="button" onClick={() => setView('overview')}>
            <span className="brand-mark">◆</span>
            <span><strong>Morphz</strong><small>{t('header.agentLabel', { title: selectedAgent?.title ?? (selectedAgentId || 'default') })}</small></span>
          </button>

          <div className="identity-trail">
            <div className="context-selector" ref={contextSelectorRef}>
              <button className={`identity-chip context-chip ${view === 'cognition' ? 'is-active' : ''} ${!selectedContext ? 'unset' : ''}`} type="button" onClick={() => setContextMenuOpen(open => !open)}>
                <small>{t('header.context').toUpperCase()}</small>
                <strong>{selectedContext?.title ?? (selectedContextId || t('header.noContext'))}</strong>
                <span>{t('common.shared')} · r{contextOverview?.mind_revision ?? contextView?.state.version ?? 0}</span>
                <ChevronDown size={13} />
              </button>
              {contextMenuOpen && (
                <div className="session-popover context-popover">
                  <header>
                    <strong>{t('header.contextCount', { count: visibleContexts.length })}</strong>
                    <button type="button" onClick={() => void createContext()} disabled={creatingContext}>
                      <Plus size={13} />{creatingContext ? t('header.creatingContext') : t('header.createContext')}
                    </button>
                  </header>
                  <div className="session-options">
                    {visibleContexts.map(context => {
                      const isRootContext = selectedAgent?.root_context_id === context.id
                      const isMutating = catalogMutationKey.startsWith(`context:${context.id}:`)
                      return <div className={`catalog-option ${context.id === selectedContextId ? 'is-current' : ''}`} key={context.id}>
                        <button className="catalog-option-main" disabled={isMutating} type="button" onClick={() => activateContext(context)}>
                          <i className={`presence ${context.status}`} />
                          <span><strong>{context.title}</strong><small>{shortId(context.id, 25)}</small></span>
                          <em>{context.id === selectedContextId ? t('header.active').toUpperCase() : ''}</em>
                        </button>
                        <div className="catalog-option-actions">
                          <button type="button" title={t('header.inspectContext')} aria-label={t('header.inspectNamedContext', { title: context.title })} onClick={() => activateContext(context, 'cognition')}><Eye size={13} /></button>
                          <button disabled={isMutating} type="button" title={t('header.renameContext')} aria-label={t('header.renameNamedContext', { title: context.title })} onClick={() => void renameContext(context)}><Pencil size={13} /></button>
                          <button disabled={isMutating || isRootContext} type="button" title={isRootContext ? t('header.rootContextCannotArchive') : t('header.archiveContext')} aria-label={t('header.archiveNamedContext', { title: context.title })} onClick={() => void archiveContext(context)}><Archive size={13} /></button>
                        </div>
                      </div>
                    })}
                    {visibleContexts.length === 0 && <div className="catalog-empty">{t('header.noVisibleContexts')}</div>}
                  </div>
                </div>
              )}
            </div>
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
                  <header>
                    <strong>{t('header.sessionCount', { count: visibleSessions.length })}</strong>
                    <button type="button" onClick={() => void createSession()} disabled={creatingSession || !selectedContextId}>
                      <Plus size={13} />{creatingSession ? t('header.creatingSession') : t('header.createSession')}
                    </button>
                  </header>
                  <div className="session-options">
                    {visibleSessions.map(session => {
                      const isMutating = catalogMutationKey.startsWith(`session:${session.id}:`)
                      return <div className={`catalog-option ${session.id === selectedSessionId ? 'is-current' : ''}`} key={session.id}>
                        <button className="catalog-option-main" disabled={isMutating} type="button" onClick={() => chooseSession(session)}>
                          <i className={`presence ${session.attention_state ?? 'active'}`} />
                          <span><strong>{session.title}</strong><small>{shortId(session.id, 25)} · {formatAgo(session.last_activity_at, t)}</small></span>
                          <em>{session.id === selectedSessionId ? t('header.active').toUpperCase() : statusLabel(session.attention_state ?? 'resident', t).toUpperCase()}</em>
                        </button>
                        <div className="catalog-option-actions">
                          <button disabled={isMutating} type="button" title={t('header.renameSession')} aria-label={t('header.renameNamedSession', { title: session.title })} onClick={() => void renameSession(session)}><Pencil size={13} /></button>
                          <button disabled={isMutating} type="button" title={t('header.archiveSession')} aria-label={t('header.archiveNamedSession', { title: session.title })} onClick={() => void archiveSession(session)}><Archive size={13} /></button>
                        </div>
                      </div>
                    })}
                    {visibleSessions.length === 0 && <div className="catalog-empty">{t('header.noVisibleSessions')}</div>}
                  </div>
                </div>
              )}
            </div>
            <span className="trail-separator">/</span>
            <div className={`identity-chip principal-chip ${activePrincipalId ? '' : 'unset'}`}>
              <small>{t('header.principal').toUpperCase()}</small>
              <strong>{activePrincipalId ? shortId(activePrincipalId, 26) : t('header.noPrincipal')}</strong>
              <span>{t('header.runtimeVerified')}</span>
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
                  <header><span>{t('theme.title').toUpperCase()}</span></header>
                  <div className="appearance-mode-selector" role="group" aria-label={t('theme.appearance.title')}>
                    <button className={appearanceMode === 'system' ? 'is-selected' : ''} type="button" onClick={() => setAppearanceMode('system')} title={t('theme.appearance.systemHint')}><Monitor size={13} /><span>{t('theme.appearance.system')}</span></button>
                    <button className={appearanceMode === 'dark' ? 'is-selected' : ''} type="button" onClick={() => setAppearanceMode('dark')}><Moon size={13} /><span>{t('theme.appearance.dark')}</span></button>
                    <button className={appearanceMode === 'light' ? 'is-selected' : ''} type="button" onClick={() => setAppearanceMode('light')}><Sun size={13} /><span>{t('theme.appearance.light')}</span></button>
                  </div>
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
                value={status?.reasoning_effort ?? inferredProviderReasoningEffort(status?.model)}
                onChange={event => void changeReasoningEffort(event.target.value)}
              >
                <option value="default">{t('reasoning.defaultUnknown')}</option>
                <option value="none">{t('reasoning.off')}</option>
                <option value="low">{t('reasoning.low')}</option>
                <option value="medium">{t('reasoning.medium')}</option>
                <option value="high">{t('reasoning.high')}</option>
                <option value="max">{status?.reasoning_effort == null && inferredProviderReasoningEffort(status?.model) === 'max' ? t('reasoning.maxDefault') : t('reasoning.max')}</option>
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
              className={`theme-button global-attention ${attentionCount > 0 ? 'has-attention' : ''}`}
              type="button"
              title={t('header.globalAttention')}
              onClick={() => setView('scheduler')}
            >
              <Bell size={15} />
              <span>{t('header.attention')}</span>
              {attentionCount > 0 && <em>{attentionCount}</em>}
            </button>
            <button
              className="theme-button"
              type="button"
              title={t('language.toggle')}
              onClick={() => { void i18n.changeLanguage(nextDashboardLanguage(i18n.language)) }}
            >
              <Globe size={15} />
              <span>{currentLangCode}</span>
            </button>
          </div>
        </header>

        <div className="runtime-navigation-row">
          <nav className="runtime-navigation" aria-label={t('navigation.label')}>
            <button className={view === 'overview' ? 'is-active' : ''} type="button" disabled={!selectedContextId} onClick={() => setView('overview')} aria-current={view === 'overview' ? 'page' : undefined}>
              <CircleDot size={14} /><span>{t('navigation.overview')}</span>
            </button>
            <button className={view === 'dialogue' ? 'is-active' : ''} type="button" disabled={!selectedSessionId} onClick={() => setView('dialogue')} aria-current={view === 'dialogue' ? 'page' : undefined}>
              <MessageSquare size={14} /><span>{t('navigation.dialogue')}</span>
            </button>
            <button className={view === 'scheduler' ? 'is-active' : ''} type="button" disabled={!selectedContextId} onClick={() => setView('scheduler')} aria-current={view === 'scheduler' ? 'page' : undefined}>
              <GitBranch size={14} /><span>{t('navigation.scheduler')}</span>{attentionCount > 0 && <em>{attentionCount}</em>}
            </button>
            <button className={view === 'cognition' ? 'is-active' : ''} type="button" disabled={!selectedContextId} onClick={() => setView('cognition')} aria-current={view === 'cognition' ? 'page' : undefined}>
              <Brain size={14} /><span>{t('navigation.cognition')}</span>
            </button>
            <button className={view === 'ledger' ? 'is-active' : ''} type="button" disabled={!selectedContextId} onClick={() => setView('ledger')} aria-current={view === 'ledger' ? 'page' : undefined}>
              <Database size={14} /><span>{t('navigation.ledger')}</span>
            </button>
            <button className={view === 'runtime' ? 'is-active' : ''} type="button" onClick={() => setView('runtime')} aria-current={view === 'runtime' ? 'page' : undefined}>
              <Radio size={14} /><span>{t('navigation.runtime')}</span>
            </button>
          </nav>
          {view === 'dialogue' && selectedSessionId && (
            <div className="conversation-toolbar">
              <span className="conversation-toolbar-title">
                {t('conversation.heading', { title: selectedSession?.title ?? shortId(selectedSessionId) })}
              </span>
              <div className="conversation-layout-switch" role="group" aria-label={t('conversation.layout.title')}>
                <button
                  className={conversationLayout === 'merged' ? 'is-active' : ''}
                  type="button"
                  title={t('conversation.layout.mergedHint')}
                  aria-pressed={conversationLayout === 'merged'}
                  onClick={() => setConversationLayout('merged')}
                >
                  <ListTree size={13} /> <span>{t('conversation.layout.merged')}</span>
                </button>
                <button
                  className={conversationLayout === 'split' ? 'is-active' : ''}
                  type="button"
                  title={t('conversation.layout.splitHint')}
                  aria-pressed={conversationLayout === 'split'}
                  onClick={() => setConversationLayout('split')}
                >
                  <Columns2 size={13} /> <span>{t('conversation.layout.split')}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          className="view-frame"
          ref={viewFrameRef}
          onScroll={event => {
            if (view === 'dialogue' && conversationLayout === 'merged') {
              handleConversationScroll(event.currentTarget)
            }
          }}
        >
          {!catalogReady && (
            <div className="runtime-initial-loading" role="status" aria-live="polite">
              <LoaderCircle size={18} />
              <span><strong>{t('runtime.loading')}</strong><small>{t('runtime.loadingHint')}</small></span>
            </div>
          )}
          {view === 'overview' && (
            <OverviewPage
              contextTitle={contextOverview?.context.title ?? selectedContext?.title}
              sessionTitle={selectedSession?.title}
              sessionCount={contextOverview?.sessions.length ?? visibleSessions.length}
              mindRevision={contextOverview?.mind_revision ?? contextView?.state.version ?? 0}
              frames={contextOverview ? {
                active: contextOverview.active_frames,
                retiring: contextOverview.retiring_frames,
                retired: contextOverview.retired_items,
              } : { active: activeFrameCount, retiring: retiringFrameCount, retired: retired.size }}
              scheduling={{
                openThreads: contextOverview?.scheduler.open_threads ?? schedulerSnapshot?.summary.open_threads ?? 0,
                pendingSignals: contextOverview?.scheduler.pending_signals ?? schedulerSnapshot?.summary.pending_signals ?? 0,
                activeSchedules: contextOverview?.scheduler.active_schedules ?? schedulerSnapshot?.summary.active_schedules ?? 0,
              }}
              execution={{
                activeJobs: contextOverview?.scheduler.active_jobs ?? schedulerSnapshot?.summary.active_jobs ?? 0,
                activeEvaluations: activeWorkCount,
                pendingApprovals: pendingApprovals.length,
              }}
              attention={{
                approvals: pendingApprovals.length,
                failedJobs: failedSchedulerJobs.length,
                failedDeliveries: failedDeliveries.length,
                inactiveObjectives: blockedObjectives.length + pausedObjectives.length,
              }}
              activities={schedulerThreads
                .filter(item => item.thread.lifecycle === 'open')
                .slice(0, 8)
                .map(snapshot => ({
                  id: snapshot.thread.id,
                  displayId: shortId(snapshot.thread.id, 28),
                  kind: threadKindLabel(snapshot.thread.kind, t),
                  phase: snapshot.phase,
                  phaseLabel: statusLabel(snapshot.phase, t),
                  executor: snapshot.thread.executor_kind,
                  updatedAgo: formatAgo(snapshot.thread.updated_at, t),
                }))}
              canRefresh={Boolean(selectedContextId)}
              onRefresh={() => void loadOverview(selectedContextId, selectedSessionId)}
              onNavigate={setView}
              onOpenMind={() => selectCognitionView('mind')}
            />
          )}

          <section
            className={`conversation-view ${showDialogueActivity ? 'has-activity' : ''} layout-${conversationLayout} mobile-lane-${conversationMobileLane}`}
            hidden={view !== 'dialogue'}
          >
              {showDialogueActivity && renderDialogueActivityDock()}
              {conversationLayout === 'split' && (
                <div className="conversation-mobile-lane-switch" role="tablist" aria-label={t('conversation.layout.mobileTitle')}>
                  <button
                    className={conversationMobileLane === 'dialogue' ? 'is-active' : ''}
                    type="button"
                    role="tab"
                    aria-selected={conversationMobileLane === 'dialogue'}
                    onClick={() => setConversationMobileLane('dialogue')}
                  >
                    <MessageSquare size={13} />{t('conversation.layout.dialogueLane')}
                  </button>
                  <button
                    className={conversationMobileLane === 'execution' ? 'is-active' : ''}
                    type="button"
                    role="tab"
                    aria-selected={conversationMobileLane === 'execution'}
                    onClick={() => setConversationMobileLane('execution')}
                  >
                    <GitBranch size={13} />{t('conversation.layout.executionLane')}
                    {(visibleExecutionOutputEvents.length + executionOutputStreamingAttempts.length) > 0 && (
                      <em>{visibleExecutionOutputEvents.length + executionOutputStreamingAttempts.length}</em>
                    )}
                  </button>
                </div>
              )}
              <div className="conversation-lanes">
                <div
                  className="conversation-dialogue-lane"
                  ref={conversationLaneRef}
                  onScroll={event => {
                    if (conversationLayout === 'split') handleConversationScroll(event.currentTarget)
                  }}
                >
              <div className="message-list" ref={conversationMessageListRef}>
                {visibleDialogueEvents.length === 0 && dialogueStreamingAttempts.length === 0 && (
                  <div className="empty-state conversation-empty">
                    <div className="empty-icon"><MessageSquare size={28} /></div>
                    <strong>{t('conversation.emptyTitle')}</strong>
                    <span dangerouslySetInnerHTML={{ __html: t('conversation.emptyDescription') }} />
                    <button className="empty-action" type="button" onClick={() => { const ta = document.querySelector('.composer textarea') as HTMLTextAreaElement | null; ta?.focus() }}>
                      <Send size={13} /> {t('conversation.startChat')}
                    </button>
                  </div>
                )}
                {hiddenEventCount > 0 && (
                  <div className="history-hint">{t('conversation.historyHint', { count: hiddenEventCount })}</div>
                )}
                {visibleDialogueEvents.map(event => {
                  const kind = eventKind(event) ?? 'system'
                  if (kind === 'progress') {
                    return <div className="progress-note" key={event.id}><i /> <span>{event.payload.text}</span><time>{formatTime(event.timestamp, i18n.language)}</time></div>
                  }
                  const persistedReasoningSummary = visibleReasoningSummaries.get(event.id) ?? ''
                  if (kind === 'reasoning') {
                    if (!persistedReasoningSummary) return null
                    return (
                      <article className="message-row agent persisted-reasoning" key={event.id}>
                        <ReasoningSummaryBlock
                          summary={persistedReasoningSummary}
                          live={false}
                          open={showReasoningSummary}
                          onOpenChange={setShowReasoningSummary}
                          title={t('reasoningSummary.title')}
                          liveLabel={t('reasoningSummary.live')}
                          persistedLabel={t('reasoningSummary.persisted')}
                        />
                      </article>
                    )
                  }
                  const role = kind === 'user'
                    ? t('conversation.roleYou')
                    : kind === 'agent'
                      ? t('conversation.roleAgent')
                      : kind === 'background'
                        ? t('conversation.roleDelivery')
                        : t('conversation.roleRuntime')
                  const showRole = kind === 'background' || kind === 'system'
                  const derivedThreads = derivedThreadsByRootTurn.get(event.id) ?? []
                  return (
                    <article className={`message-row ${kind}`} key={event.id} data-event-id={event.id} data-event-actor={event.actor} data-event-time={event.timestamp}>
                      {showRole && (
                        <div className="message-role">
                          <strong>{role}</strong>
                          <time>{formatTime(event.timestamp, i18n.language)}</time>
                          {kind === 'background' && <small>{shortId(String(event.payload.root_turn_id ?? ''), 18)}</small>}
                        </div>
                      )}
                      {persistedReasoningSummary && (
                        <ReasoningSummaryBlock
                          summary={persistedReasoningSummary}
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
                          ? <MarkdownBody text={event.payload.text} />
                          : t('conversation.noText')}
                      </div>
                      {derivedThreads.length > 0 && (
                        <div className="message-thread-capsules" aria-label={t('conversation.derivedThreads')}>
                          {derivedThreads.map(snapshot => (
                            <MessageThreadReference
                              key={snapshot.thread.id}
                              snapshot={snapshot}
                              onOpen={() => navigate(threadPath(selectedContextId, snapshot.thread.id))}
                              t={t}
                            />
                          ))}
                        </div>
                      )}
                      {quotes.map((q, qi) => q.eventId === event.id ? (
                            <span key={q.id} style={{ position: 'absolute', top: q.badgeTop, left: q.badgeLeft, zIndex: 10 }}>
                              <button
                                className={`message-quote-badge ${inlineCommentQuoteId === q.id ? 'active' : ''}`}
                                type="button"
                                title={q.comment.trim() ? q.comment.trim() : t('conversation.commentPlaceholder')}
                                onClick={() => setInlineCommentQuoteId(inlineCommentQuoteId === q.id ? '' : q.id)}
                              >
                                {qi + 1}
                              </button>
                              {inlineCommentQuoteId === q.id && (
                                <span className="inline-comment-box">
                                  <textarea
                                    className="inline-comment-input"
                                    placeholder={t('conversation.commentPlaceholder')}
                                    rows={2}
                                    value={q.comment}
                                    onChange={e => updateQuoteComment(q.id, e.target.value)}
                                    autoFocus
                                  />
                                </span>
                              )}
                            </span>
                      ) : null)}
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
                {dialogueStreamingAttempts.map(attempt => (
                  <article className="message-row agent streaming" key={`stream-${attempt.attemptId}`} aria-live="polite">
                    <ReasoningSummaryBlock
                      summary={liveReasoningSummaryText(reasoningContinuationSummaries, attempt)}
                      live
                      open={showReasoningSummary}
                      onOpenChange={setShowReasoningSummary}
                      title={t('reasoningSummary.title')}
                      liveLabel={t('reasoningSummary.live')}
                      persistedLabel={t('reasoningSummary.persisted')}
                    />
                    {attempt.text.trim() && (
                      <div className="message-body">
                        <MarkdownBody text={attempt.text} />
                        {attempt.status !== 'failed' && <span className="stream-caret" aria-hidden="true" />}
                      </div>
                    )}
                    {attempt.error && !attempt.text.trim() && <div className="message-body stream-error">{attempt.error}</div>}
                    <div className={`stream-status ${attempt.status === 'failed' ? 'is-failed' : ''}`}>
                      {attempt.status !== 'failed' && <span className="stream-typing" aria-hidden="true"><b /><b /><b /></span>}
                      <span>{attempt.status === 'failed'
                        ? t('conversation.streamFailed')
                        : attempt.runtimeState === 'waiting_final_output'
                          ? t('conversation.reasoningCompleted')
                          : attempt.runtimeState === 'queued'
                            ? t('conversation.waitingForModel')
                            : t('conversation.streaming')}</span>
                    </div>
                  </article>
                ))}
                {turnPending && dialogueStreamingAttempts.length === 0 && (
                  <article className="message-row agent streaming" role="status" aria-live="polite">
                    <div className="stream-status">
                      <span className="stream-typing" aria-hidden="true"><b /><b /><b /></span>
                      <span>{turnStatus}</span>
                    </div>
                  </article>
                )}
                <div ref={conversationEnd} />
              </div>
                </div>
                {conversationLayout === 'split' && (
                  <div
                    className="conversation-execution-lane"
                    ref={executionOutputLaneRef}
                    onWheel={event => {
                      if (event.deltaY < 0) executionOutputPinnedToEnd.current = false
                    }}
                    onScroll={event => {
                      const container = event.currentTarget
                      if (Date.now() - lastExecutionProgrammaticScroll.current < 120) return
                      executionOutputPinnedToEnd.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48
                    }}
                  >
                    <header className="conversation-lane-heading">
                      <span><GitBranch size={13} /> {t('conversation.layout.executionLane')}</span>
                      <small>{t('conversation.layout.executionLaneHint')}</small>
                    </header>
                    <div className="message-list execution-output-list" ref={executionOutputListRef}>
                      {visibleExecutionOutputEvents.length === 0 && executionOutputStreamingAttempts.length === 0 && (
                        <div className="conversation-lane-empty">
                          <GitBranch size={20} />
                          <span>{t('conversation.layout.executionEmpty')}</span>
                        </div>
                      )}
                      {visibleExecutionOutputEvents.map(event => {
                        const kind = eventKind(event) ?? 'background'
                        const persistedReasoningSummary = visibleReasoningSummaries.get(event.id) ?? ''
                        if (kind === 'progress') {
                          return <div className="progress-note" key={event.id}><i /> <span>{event.payload.text}</span><time>{formatTime(event.timestamp, i18n.language)}</time></div>
                        }
                        if (kind === 'reasoning') {
                          const summary = persistedReasoningSummary || String(event.payload.text ?? '')
                          if (!summary) return null
                          return (
                            <article className="message-row agent persisted-reasoning execution-output" key={event.id}>
                              <ReasoningSummaryBlock
                                summary={summary}
                                live={false}
                                open={showReasoningSummary}
                                onOpenChange={setShowReasoningSummary}
                                title={t('reasoningSummary.title')}
                                liveLabel={t('reasoningSummary.live')}
                                persistedLabel={t('reasoningSummary.persisted')}
                              />
                            </article>
                          )
                        }
                        const derivedThreads = derivedThreadsByRootTurn.get(event.id) ?? []
                        return (
                          <article className="message-row background execution-output" key={event.id} data-event-id={event.id} data-event-actor={event.actor} data-event-time={event.timestamp}>
                            <div className="message-role">
                              <strong>{t('conversation.roleDelivery')}</strong>
                              <time>{formatTime(event.timestamp, i18n.language)}</time>
                              <small>{shortId(String(event.payload.root_turn_id ?? ''), 18)}</small>
                            </div>
                            {persistedReasoningSummary && (
                              <ReasoningSummaryBlock
                                summary={persistedReasoningSummary}
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
                                ? <MarkdownBody text={event.payload.text} />
                                : t('conversation.noText')}
                            </div>
                            {derivedThreads.length > 0 && (
                              <div className="message-thread-capsules" aria-label={t('conversation.derivedThreads')}>
                                {derivedThreads.map(snapshot => (
                                  <MessageThreadReference
                                    key={snapshot.thread.id}
                                    snapshot={snapshot}
                                    onOpen={() => navigate(threadPath(selectedContextId, snapshot.thread.id))}
                                    t={t}
                                  />
                                ))}
                              </div>
                            )}
                            <div className="message-meta">
                              <button
                                className="message-copy"
                                type="button"
                                title={copiedMessageId === event.id ? t('conversation.copied') : t('conversation.copy')}
                                onClick={() => void copyMessage(event.payload.text ?? '', event.id)}
                              >
                                {copiedMessageId === event.id ? <Check size={14} /> : <Copy size={14} />}
                              </button>
                            </div>
                          </article>
                        )
                      })}
                      {executionOutputStreamingAttempts.map(attempt => (
                        <article className="message-row agent streaming execution-output" key={`execution-stream-${attempt.attemptId}`} aria-live="polite">
                          <ReasoningSummaryBlock
                            summary={liveReasoningSummaryText(reasoningContinuationSummaries, attempt)}
                            live
                            open={showReasoningSummary}
                            onOpenChange={setShowReasoningSummary}
                            title={t('reasoningSummary.title')}
                            liveLabel={t('reasoningSummary.live')}
                            persistedLabel={t('reasoningSummary.persisted')}
                          />
                          {attempt.text.trim() && (
                            <div className="message-body">
                              <MarkdownBody text={attempt.text} />
                              {attempt.status !== 'failed' && <span className="stream-caret" aria-hidden="true" />}
                            </div>
                          )}
                          {attempt.error && !attempt.text.trim() && <div className="message-body stream-error">{attempt.error}</div>}
                          <div className={`stream-status ${attempt.status === 'failed' ? 'is-failed' : ''}`}>
                            {attempt.status !== 'failed' && <span className="stream-typing" aria-hidden="true"><b /><b /><b /></span>}
                            <span>{attempt.status === 'failed'
                              ? t('conversation.streamFailed')
                              : attempt.runtimeState === 'waiting_final_output'
                                ? t('conversation.reasoningCompleted')
                                : attempt.runtimeState === 'queued'
                                  ? t('conversation.waitingForModel')
                                  : t('conversation.streaming')}</span>
                          </div>
                        </article>
                      ))}
                      <div ref={executionOutputEnd} />
                    </div>
                  </div>
                )}
              </div>
          </section>

          {view === 'scheduler' && (
            <section className="scheduler-view">
              <header className="workspace-heading">
                <div><span>{t('work.title').toUpperCase()}</span><h1>{t('work.heading')}</h1><p>{t('work.description')}</p></div>
                <div className="workspace-actions">
                  <button type="button" onClick={() => void loadSession(selectedSessionId, selectedContextId)}><RefreshCw size={14} /> {t('work.refresh')}</button>
                  <button type="button" onClick={() => setView('dialogue')}><ArrowLeft size={14} /> {t('work.backToChat')}</button>
                </div>
              </header>

              {route.threadId && (
                <section className="thread-detail-view">
                  <header>
                    <div>
                      <span>{t('work.causal.detail').toUpperCase()}</span>
                      <h2>{shortId(route.threadId, 64)}</h2>
                    </div>
                    <button type="button" onClick={() => navigate(dashboardPath('scheduler', selectedContextId))}>
                      <ArrowLeft size={14} /> {t('work.causal.backToBoard')}
                    </button>
                  </header>
                  {threadDetail?.snapshot.thread.id === route.threadId ? (
                    <ThreadCausalCard
                      snapshot={threadDetail.snapshot}
                      modelAttemptEvents={threadDetail.model_attempt_events}
                      liveModelAttempts={threadDetailLiveAttempts}
                      t={t}
                      locale={i18n.language}
                      decidingApprovalId={decidingApprovalId}
                      mutatingScheduleId={mutatingScheduleId}
                      onApproval={(approval, decision) => void decideApproval(approval, decision)}
                      onSchedule={(schedule, action) => void mutateSchedule(schedule, action)}
                    />
                  ) : <div className="small-empty">{t('work.causal.loadingDetail')}</div>}
                </section>
              )}

              {!route.threadId && (<>

              <div className="work-metrics">
                <div><CircleDot size={17} /><span><small>{t('work.metrics.active').toUpperCase()}</small><strong>{activeWorkCount}</strong></span></div>
                <div><Clock3 size={17} /><span><small>{t('work.metrics.waiting').toUpperCase()}</small><strong>{waitingCount}</strong></span></div>
                <div><Radio size={17} /><span><small>{t('work.metrics.pendingSignals').toUpperCase()}</small><strong>{threadSignals.length}</strong></span></div>
                <div><Layers3 size={17} /><span><small>{t('work.metrics.objectives').toUpperCase()}</small><strong>{activeObjectives.length}</strong></span></div>
              </div>

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
                    {approvalAnomalies.map(snapshot => {
                      const attentionKey = attentionJobKey('approval_anomaly', snapshot)
                      return <article className="attention-card failure" key={`approval-anomaly-${snapshot.job.id}`}>
                        <div><span className="status-pill failed">{t('work.attention.stateMismatch')}</span><time>{formatAgo(snapshot.job.updated_at, t)}</time></div>
                        <h2>{snapshot.job.tool_name}</h2>
                        <p>{snapshot.approval?.status === 'allowed'
                          ? t('work.attention.approvedWithoutOwner')
                          : snapshot.approval
                            ? t('work.attention.terminalApprovalMismatch', { status: statusLabel(snapshot.approval.status, t) })
                            : t('work.attention.missingApproval')}</p>
                        <div className="attention-actions">
                          <button type="button" onClick={() => navigate(threadPath(selectedContextId, snapshot.job.thread_id))}><GitBranch size={12} /> {t('work.attention.inspect')}</button>
                          <button disabled={Boolean(acknowledgingAttentionKey)} type="button" onClick={() => void acknowledgeAttention(attentionKey, 'approval_anomaly', snapshot.job.id, snapshot.job.revision)}><Check size={12} /> {acknowledgingAttentionKey === attentionKey ? t('work.attention.acknowledging') : t('work.attention.acknowledge')}</button>
                        </div>
                      </article>
                    })}
                    {failedSchedulerJobs.map(snapshot => {
                      const attentionKey = attentionJobKey('execution_job', snapshot)
                      return <article className="attention-card failure" key={snapshot.job.id}>
                        <div><span className="status-pill failed">{statusLabel(snapshot.job.status, t)}</span><time>{formatAgo(snapshot.job.updated_at, t)}</time></div>
                        <h2>{snapshot.job.tool_name}</h2>
                        <p>{snapshot.job.error ?? t('work.attention.jobFailed')}</p>
                        <div className="attention-actions">
                          <button type="button" onClick={() => navigate(threadPath(selectedContextId, snapshot.job.thread_id))}><GitBranch size={12} /> {t('work.attention.inspect')}</button>
                          <button disabled={Boolean(acknowledgingAttentionKey)} type="button" onClick={() => void acknowledgeAttention(attentionKey, 'execution_job', snapshot.job.id, snapshot.job.revision)}><Check size={12} /> {acknowledgingAttentionKey === attentionKey ? t('work.attention.acknowledging') : t('work.attention.acknowledge')}</button>
                        </div>
                      </article>
                    })}
                    {failedDeliveries.map(snapshot => {
                      const attentionKey = attentionDeliveryKey(snapshot)
                      return <article className="attention-card delivery" key={snapshot.thread.id}>
                        <div><span className="status-pill deferred">{statusLabel(snapshot.thread.delivery_status, t)}</span><time>{formatAgo(snapshot.thread.updated_at, t)}</time></div>
                        <h2>{t('work.attention.deliveryFailed')}</h2>
                        <p>{snapshot.thread.result_text ?? shortId(snapshot.thread.id, 30)}</p>
                        <div className="attention-actions">
                          <button type="button" onClick={() => navigate(threadPath(selectedContextId, snapshot.thread.id))}><GitBranch size={12} /> {t('work.attention.inspect')}</button>
                          <button disabled={Boolean(acknowledgingAttentionKey)} type="button" onClick={() => void acknowledgeAttention(attentionKey, 'delivery', snapshot.thread.id, snapshot.thread.revision)}><Check size={12} /> {acknowledgingAttentionKey === attentionKey ? t('work.attention.acknowledging') : t('work.attention.acknowledge')}</button>
                        </div>
                      </article>
                    })}
                  </div>
                </section>
              )}

              <section className="objective-board">
                <header><span>{t('work.objectives.title').toUpperCase()}</span><b>{activeObjectives.length}</b><small>{t('work.objectives.confirm')}</small></header>
                <div className="objective-grid">
                  {activeObjectives.map(objective => {
                    const expanded = expandedObjectiveIds.has(objective.id)
                    const busy: ObjectiveMutationKind = pausingObjectiveId === objective.id
                      ? 'pause'
                      : resumingObjectiveId === objective.id
                        ? 'resume'
                        : deletingObjectiveId === objective.id
                          ? 'delete'
                          : ''
                    return (
                      <article className={`work-card objective-work-card ${expanded ? 'is-expanded' : ''}`} key={objective.id}>
                        <header className="objective-card-titlebar">
                          <span className={`status-pill ${objective.status}`}>{statusLabel(objective.status, t)}</span>
                          <time>{formatAgo(objective.updated_at, t)}</time>
                          <ObjectiveCardActions
                            objective={objective}
                            expanded={expanded}
                            busy={busy}
                            disabled={Boolean(pausingObjectiveId || resumingObjectiveId || deletingObjectiveId)}
                            t={t}
                            onPause={() => void pauseObjective(objective)}
                            onResume={() => void resumeObjective(objective)}
                            onDelete={() => void deleteObjective(objective)}
                            onToggle={() => toggleObjectiveExpanded(objective.id)}
                          />
                        </header>
                        <h2 title={objective.stated_objective}><MarkdownInline>{objective.stated_objective}</MarkdownInline></h2>
                        {expanded && (
                          <div className="objective-work-details">
                            {objective.status_reason && <p title={objective.status_reason}><MarkdownInline>{objective.status_reason}</MarkdownInline></p>}
                            <footer><span>{t('work.objectives.revision', { revision: objective.revision })}</span><span>{t('work.objectives.tokens', { tokens: compactTokens(objective.tokens_used) })}</span><span>{t('work.objectives.seconds', { seconds: objective.time_used_seconds })}</span><span>{shortId(objective.coordinator_session_id)}</span></footer>
                            {objective.wait_condition && <div className="wait-condition">{t('work.objectives.waitCondition', { kind: objective.wait_condition.kind })}</div>}
                          </div>
                        )}
                      </article>
                    )
                  })}
                  {activeObjectives.length === 0 && <div className="small-empty">{t('work.objectives.empty')}</div>}
                </div>
              </section>

              <section className="schedule-board">
                <header><span>{t('work.schedules.title').toUpperCase()}</span><b>{schedules.length}</b><small>{t('work.schedules.subtitle')}</small></header>
                <div className="schedule-control-list">
                  {schedules.map(schedule => (
                    <article key={schedule.id}>
                      <Clock3 size={15} />
                      <span>
                        <strong>{schedule.intent}</strong>
                        <small>{shortId(schedule.id, 24)} · {t('work.schedules.thread')} {shortId(schedule.thread_id, 18)}</small>
                      </span>
                      <span className={`status-pill ${schedule.status}`}>{statusLabel(schedule.status, t)}</span>
                      <time>{schedule.not_before ? formatAgo(schedule.not_before, t) : t('work.schedules.noDeadline')}</time>
                      <div className="schedule-actions">
                        {schedule.status === 'queued' && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => void mutateSchedule(schedule, 'pause')}>{t('work.schedules.pause')}</button>}
                        {schedule.status === 'paused' && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => void mutateSchedule(schedule, 'resume')}>{t('work.schedules.resume')}</button>}
                        {!['completed', 'cancelled'].includes(schedule.status) && <button className="danger" disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => void mutateSchedule(schedule, 'cancel')}>{t('work.schedules.cancel')}</button>}
                      </div>
                    </article>
                  ))}
                  {schedules.length === 0 && <div className="small-empty">{t('work.schedules.empty')}</div>}
                </div>
              </section>

              {schedulerSnapshot && (
                <details className={`kernel-diagnostics ${schedulerSnapshot.admission.context_deferred > 0 ? 'pressured' : ''}`}>
                  <summary>{t('work.kernelDiagnostics')} · {schedulerSnapshot.admission.context_in_flight}/{schedulerSnapshot.admission.total_slots}</summary>
                  <div className="admission-board">
                    <header><span>{t('work.admission.title').toUpperCase()}</span><small>{t('work.admission.subtitle')}</small></header>
                    <div className="admission-line">
                      <span>{t('work.admission.inFlight', { count: schedulerSnapshot.admission.context_in_flight })}</span>
                      <span>{t('work.admission.loaded', { count: schedulerSnapshot.admission.context_loaded_queued })}</span>
                      <span>{t('work.admission.durable', { count: schedulerSnapshot.admission.context_durable_queued })}</span>
                      <span className={schedulerSnapshot.admission.context_deferred > 0 ? 'warning' : ''}>{t('work.admission.deferred', { count: schedulerSnapshot.admission.context_deferred })}</span>
                      <span>{t('work.admission.reserved', { count: schedulerSnapshot.admission.dialogue_delivery_slots })}</span>
                    </div>
                  </div>
                </details>
              )}

              <section className="causal-board">
                <header><span>{t('work.causal.title').toUpperCase()}</span><b>{schedulerThreads.length}</b><small>{t('work.causal.subtitle')}</small></header>
                <div className="causal-thread-list">
                  {hiddenSchedulerThreadCount > 0 && (
                    <div className="history-hint">{t('work.causal.historyLimited', { count: hiddenSchedulerThreadCount })}</div>
                  )}
                  {schedulerThreadGroups.map(([group, snapshots]) => (
                    <section className={`thread-phase-group ${group}`} key={group}>
                      <header><strong>{t(`work.threadGroups.${group}`)}</strong><span>{snapshots.length}</span></header>
                      {snapshots.map(snapshot => (
                        <ThreadCausalCard
                          key={snapshot.thread.id}
                          snapshot={snapshot}
                          t={t}
                          locale={i18n.language}
                          decidingApprovalId={decidingApprovalId}
                          mutatingScheduleId={mutatingScheduleId}
                          onApproval={(approval, decision) => void decideApproval(approval, decision)}
                          onSchedule={(schedule, action) => void mutateSchedule(schedule, action)}
                          onInspect={(threadId) => navigate(threadPath(selectedContextId, threadId))}
                        />
                      ))}
                    </section>
                  ))}
                  {visibleSchedulerThreads.length === 0 && <div className="small-empty">{t('work.causal.empty')}</div>}
                  {schedulerHistoryPageFull && (
                    <button
                      className="history-more"
                      type="button"
                      onClick={() => setSchedulerHistoryLimit(current => current + SCHEDULER_HISTORY_PAGE_SIZE)}
                    >
                      {t('work.causal.loadMore')}
                    </button>
                  )}
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

              </>)}

            </section>
          )}

          {view === 'ledger' && (
            <LedgerPage
              key={selectedContextId}
              contextTitle={selectedContext?.title ?? shortId(selectedContextId)}
              sessionTitle={ledgerFilters.sessionId
                ? sessions.find(session => session.id === ledgerFilters.sessionId)?.title ?? shortId(ledgerFilters.sessionId)
                : t('ledger.allSessions')}
              events={(ledgerPage?.events ?? []).map(event => ({
                id: event.id,
                sequence: event.sequence,
                timestamp: event.timestamp,
                timeLabel: formatTime(event.timestamp, i18n.language),
                actor: event.actor,
                type: event.type,
                topic: event.topic,
                payload: event.payload,
              }))}
              scannedCount={ledgerPage?.scanned_count ?? 0}
              scanExhaustive={ledgerPage?.scan_exhaustive ?? true}
              pageNumber={ledgerCursorHistory.length + 1}
              canLoadNewer={ledgerCursorHistory.length > 0}
              canLoadOlder={ledgerPage?.next_before_sequence !== undefined}
              sessions={sessions.filter(session => session.context_id === selectedContextId).map(session => ({ id: session.id, title: session.title }))}
              filters={ledgerFilters}
              canRefresh={Boolean(selectedContextId)}
              onRefresh={() => void loadLedger(selectedContextId, ledgerFilters, ledgerBeforeSequence)}
              onApplyFilters={applyLedgerFilters}
              onLoadNewer={loadNewerLedgerPage}
              onLoadOlder={loadOlderLedgerPage}
              onOpenThread={(threadId) => navigate(threadPath(selectedContextId, threadId))}
              onOpenSession={(sessionId) => { setSelectedSessionId(sessionId); navigate(dashboardPath('dialogue', selectedContextId, sessionId)) }}
              onOpenFrame={(frameId) => { setSelectedFrameId(frameId); navigate(dashboardPath('cognition', selectedContextId, undefined, 'mind')) }}
            />
          )}

          {view === 'runtime' && (
            <RuntimePage
              connection={t(`connection.${wsStatus}`)}
              endpoint={CORE_HTTP_URL}
              model={status?.model ?? t('model.unavailable')}
              provider={status?.provider ?? t('runtime.providerUnknown')}
              toolCount={status?.tool_count ?? 0}
              reasoning={String(status?.reasoning_effort ?? inferredProviderReasoningEffort(status?.model))}
              pressure={statusLabel(contextView?.pressure.level ?? contextOverview?.pressure?.level ?? 'normal', t)}
              estimatedTokens={compactTokens(contextView?.pressure.estimated_tokens ?? contextOverview?.pressure?.estimated_tokens)}
              softLimit={compactTokens(contextView?.pressure.soft_limit ?? contextOverview?.pressure?.soft_limit)}
              hardLimit={compactTokens(contextView?.pressure.hard_limit ?? contextOverview?.pressure?.hard_limit)}
              tokenSource={contextView?.pressure.token_source ?? contextOverview?.pressure?.token_source ?? '—'}
              schedulerGeneratedAgo={schedulerSnapshot?.generated_at ? formatAgo(schedulerSnapshot.generated_at, t) : '—'}
              totalSlots={schedulerSnapshot?.admission.total_slots ?? '—'}
              inFlight={schedulerSnapshot?.admission.context_in_flight ?? '—'}
              durableQueued={schedulerSnapshot?.admission.context_durable_queued ?? '—'}
              deferred={schedulerSnapshot?.admission.context_deferred ?? '—'}
              reservedSlots={schedulerSnapshot?.admission.dialogue_delivery_slots ?? '—'}
              version={`${status?.version ?? '—'} · ${status?.git_commit ?? '—'}`}
              uptimeSeconds={status?.uptime_seconds ?? 0}
              recovery={status?.recovery ?? { preserved_execution_jobs: 0, requeued_execution_jobs: 0, lost_execution_jobs: 0, recovered_background_outboxes: 0 }}
              projectionAudit={projectionAudit?.context_id === selectedContextId ? projectionAudit : null}
              auditingProjection={auditingProjection}
              storage={status?.storage ?? '—'}
              sandbox={`${status?.sandbox_mode ?? '—'} · ${status?.permission_mode ?? '—'}`}
              identity={status?.principal_id ?? '—'}
              eventWriter={schedulerSnapshot?.event_writer ?? {}}
              modelProvider={schedulerSnapshot?.model_provider ?? {}}
              contextCapacity={schedulerSnapshot?.context_capacity ?? {}}
              executionTargets={executionTargets}
              executionNodes={executionNodes}
              capabilityLeases={capabilityLeases}
              executionJobs={executionJobs}
              onRefresh={() => void loadCatalog()}
              onAuditProjection={() => void auditMindProjection()}
              onSetTargetStatus={(targetId, revision, nextStatus) => void setExecutionTargetStatus(targetId, revision, nextStatus)}
              onRevokeNode={(nodeId, revision) => void revokeExecutionNode(nodeId, revision)}
              onRevokeLease={(leaseId, revision) => void revokeCapabilityLease(leaseId, revision)}
              onCancelJob={(jobId, revision) => void cancelExecutionJob(jobId, revision)}
            />
          )}

          {view === 'cognition' && (
            <section className="cognition-view">
              <header className="workspace-heading">
                <div><span>{t('mindView.title').toUpperCase()}</span><h1>{t('mindView.heading')}</h1><p>{t('mindView.description')}</p></div>
                <button type="button" onClick={() => setView('dialogue')}><ArrowLeft size={14} /> {t('mindView.backToChat')}</button>
              </header>

              <nav className="cognition-navigation" aria-label={t('cognition.navigationLabel')}>
                {(['mind', 'attention', 'encoding', 'recall'] as CognitionView[]).map(item => (
                  <button className={cognitionView === item ? 'is-active' : ''} key={item} type="button" onClick={() => selectCognitionView(item)} aria-current={cognitionView === item ? 'page' : undefined}>
                    {t(`cognition.tabs.${item}`)}
                  </button>
                ))}
              </nav>

              <div className="mind-metrics">
                <div><Brain size={18} /><span><small>{t('mindView.metrics.frames').toUpperCase()}</small><strong className="frame-lifecycle-counts" aria-label={t('mindView.metrics.frameLifecycle.summary', { active: activeFrameCount, retiring: retiringFrameCount, retired: retired.size })}>
                  <span className="frame-lifecycle-value" tabIndex={0} title={t('mindView.metrics.frameLifecycle.active', { count: activeFrameCount })}>{activeFrameCount}</span>
                  <i aria-hidden="true">·</i>
                  <span className="frame-lifecycle-value" tabIndex={0} title={t('mindView.metrics.frameLifecycle.retiring', { count: retiringFrameCount })}>{retiringFrameCount}</span>
                  <i aria-hidden="true">·</i>
                  <span className="frame-lifecycle-value" tabIndex={0} title={t('mindView.metrics.frameLifecycle.retired', { count: retired.size })}>{retired.size}</span>
                </strong></span></div>
                <div><GitBranch size={18} /><span><small>{t('mindView.metrics.relations').toUpperCase()}</small><strong>{contextView?.state.relations.length ?? 0}</strong></span></div>
                <div><Database size={18} /><span><small>{t('mindView.metrics.observations').toUpperCase()}</small><strong>{contextView?.observations.length ?? 0}</strong></span></div>
                <div><Clock3 size={18} /><span><small>{t('mindView.metrics.cognitiveTick').toUpperCase()}</small><strong>{contextView?.cognitive_clock.tick ?? 0}</strong></span></div>
              </div>

              {cognitionView === 'encoding' && <details className="context-inspect-view" open>
                <summary>
                  <span className="context-inspect-title">
                    <Brain size={15} />
                    <span><small>{t('mindView.contextInspect.eyebrow').toUpperCase()}</small><strong>{t('mindView.contextInspect.title')}</strong></span>
                  </span>
                  <span className={`context-inspect-source ${hasExactContextInspect ? 'exact' : 'current'}`}>
                    {hasExactContextInspect ? t('mindView.contextInspect.exact') : t('mindView.contextInspect.current')}
                  </span>
                  <span className="context-inspect-summary">
                    {hasExactContextInspect && latestContextInspect
                      ? `${formatTime(latestContextInspect.timestamp, i18n.language)} · ${shortId(String(latestContextInspect.payload.attempt_id ?? latestContextInspect.id), 26)}`
                      : t('mindView.contextInspect.currentHint')}
                  </span>
                  <ChevronDown size={14} />
                </summary>
                <div className="context-inspect-body">
                  <header>
                    <nav aria-label={t('mindView.contextInspect.tabsLabel')}>
                      {(['encoding', 'attribution', 'messages', 'tools', 'mind', 'inbox', 'metadata'] as ContextInspectTab[]).map(tab => (
                        <button
                          className={contextInspectTab === tab ? 'is-active' : ''}
                          key={tab}
                          type="button"
                          onClick={() => { setContextInspectTab(tab); setContextInspectCopied(false) }}
                        >
                          {t(`mindView.contextInspect.tabs.${tab}`)}
                        </button>
                      ))}
                    </nav>
                    <button
                      className="context-inspect-copy"
                      type="button"
                      onClick={() => {
                        void copyTextToClipboard(contextInspectContent)
                          .then(() => {
                            setContextInspectCopied(true)
                            window.setTimeout(() => setContextInspectCopied(false), 1400)
                          })
                          .catch(() => setError(t('errors.copyFailed')))
                      }}
                    >
                      {contextInspectCopied ? <Check size={13} /> : <Copy size={13} />}
                      {contextInspectCopied ? t('mindView.contextInspect.copied') : t('mindView.contextInspect.copy')}
                    </button>
                  </header>
                  <pre>{contextInspectContent || t('mindView.contextInspect.empty')}</pre>
                  <footer>
                    {hasExactContextInspect
                      ? t('mindView.contextInspect.ephemeralNotice')
                      : t('mindView.contextInspect.reconstructedNotice')}
                  </footer>
                </div>
              </details>}

              {cognitionView === 'recall' && <>
                <form className="recall-search" onSubmit={event => { event.preventDefault(); void searchRecall() }}>
                  <input value={recallQuery} onChange={event => setRecallQuery(event.target.value)} placeholder={t('mindView.searchPlaceholder')} />
                  <button type="submit" disabled={recallBusy || !recallQuery.trim()}><Database size={14} /> {recallBusy ? t('mindView.searching') : t('mindView.search')}</button>
                  {recallIndex && <small className={recallIndex.capability.indexed ? 'indexed' : 'degraded'}>{recallIndex.capability.mode} · {recallIndex.event_documents + recallIndex.frame_documents}</small>}
                </form>
                {recallMatches.length > 0 && <div className="recall-results">{recallMatches.map(hit => (
                  <button key={`${hit.document_kind}-${hit.document_id}`} type="button" onClick={() => hit.document_kind === 'frame' && setSelectedFrameId(hit.document_id)}>
                    <span><b>{hit.document_kind}</b><strong>{hit.document_id}</strong>{hit.retired && <em>{t('mindView.retired')}</em>}</span>
                    <small>{hit.preview}</small>
                  </button>
                ))}</div>}
                {recallMatches.length === 0 && <div className="cognition-empty-panel"><Database size={20} /><strong>{t('cognition.recall.emptyTitle')}</strong><span>{t('cognition.recall.emptyDescription')}</span></div>}
              </>}

              {cognitionView === 'mind' && <>
              <div className="mind-grid">
                <div className="frame-library">
                  <header><span>{t('mindView.frameLibrary').toUpperCase()}</span><b>r{contextView?.state.version ?? 0}</b></header>
                  <div className="frame-list">
                    {(contextView?.state.frames ?? []).map(frame => (
                      <button className={frame.id === selectedFrameId ? 'is-selected' : ''} key={frame.id} type="button" onClick={() => setSelectedFrameId(frame.id)}>
                        <span><strong>{frame.id}</strong><small>r{frame.revision} · v{frame.updated_version} · {t('mindView.sourceCount', { count: frame.sources.length })}</small></span>
                        {retired.has(frame.id) ? <em>{t('mindView.retired').toUpperCase()}</em> : retiring[frame.id] ? <em className="retiring">{t('mindView.retiring').toUpperCase()}</em> : null}
                      </button>
                    ))}
                  </div>
                </div>

                <article className="frame-inspector">
                  {selectedFrame ? (
                    <>
                      <header><span><small>{t('mindView.frame').toUpperCase()}</small><strong>{selectedFrame.id}</strong></span><em>{t('mindView.revision', { revision: selectedFrame.revision })}</em></header>
                      <div className="frame-lifecycle">
                        <strong>{retired.has(selectedFrame.id) ? t('mindView.retired') : selectedRetirement ? t('mindView.retiring') : t('mindView.active')}</strong>
                        {selectedRetirement && <span>{t('mindView.remainingTicks', { count: Math.max(0, selectedRetirement.eligible_at_tick - (contextView?.cognitive_clock.tick ?? 0)) })} · {selectedRetirement.reason}</span>}
                        <div>
                          {(retired.has(selectedFrame.id) || selectedRetirement) && <button type="button" disabled={mutatingFrameId === selectedFrame.id} onClick={() => void mutateFrameLifecycle(selectedFrame.id, 'restore')}>{t('mindView.restore')}</button>}
                          <button type="button" disabled={mutatingFrameId === selectedFrame.id} onClick={() => void mutateFrameLifecycle(selectedFrame.id, contextView?.state.protected.includes(selectedFrame.id) ? 'unprotect' : 'protect')}>{contextView?.state.protected.includes(selectedFrame.id) ? t('mindView.unprotect') : t('mindView.protect')}</button>
                        </div>
                      </div>
                      <pre>{selectedFrame.body}</pre>
                      <div className="frame-meta">
                        <div><small>{t('mindView.created').toUpperCase()}</small><strong>v{selectedFrame.created_version}</strong></div>
                        <div><small>{t('mindView.updated').toUpperCase()}</small><strong>v{selectedFrame.updated_version}</strong></div>
                        <div><small>{t('mindView.sources').toUpperCase()}</small><strong>{selectedFrame.sources.length}</strong></div>
                        <div><small>{t('mindView.protected').toUpperCase()}</small><strong>{contextView?.state.protected.includes(selectedFrame.id) ? t('mindView.yes') : t('mindView.no')}</strong></div>
                        <div><small>{t('mindView.provenance.state').toUpperCase()}</small><strong>{t(`mindView.provenance.states.${selectedFrame.provenance.state}`)}</strong></div>
                        <div><small>{t('mindView.provenance.formedPrincipal').toUpperCase()}</small><strong>{selectedFrame.provenance.formed_principal_id ? shortId(selectedFrame.provenance.formed_principal_id, 24) : '—'}</strong></div>
                        <div><small>{t('mindView.provenance.formedSession').toUpperCase()}</small><strong>{selectedFrame.provenance.formed_session_id ? shortId(selectedFrame.provenance.formed_session_id, 24) : '—'}</strong></div>
                        <div><small>{t('mindView.provenance.evidence').toUpperCase()}</small><strong>{selectedFrame.provenance.source_principal_ids.length}P · {selectedFrame.provenance.source_session_ids.length}S</strong></div>
                      </div>
                      {selectedFrame.sources.length > 0 && <div className="source-list">{selectedFrame.sources.map(source => <span key={source}>{source}</span>)}</div>}
                      {(selectedFrame.provenance.source_principal_ids.length > 0 || selectedFrame.provenance.source_session_ids.length > 0) && (
                        <section className="frame-provenance">
                          <h3>{t('mindView.provenance.lineage').toUpperCase()}</h3>
                          <div>{selectedFrame.provenance.source_principal_ids.map(id => <span key={`principal-${id}`}>P · {id}</span>)}</div>
                          <div>{selectedFrame.provenance.source_session_ids.map(id => <span key={`session-${id}`}>S · {id}</span>)}</div>
                        </section>
                      )}
                      <section className="relations"><h3>{t('mindView.relationsTitle').toUpperCase()}</h3>{(contextView?.state.relations ?? []).filter(item => item.subject === selectedFrame.id || item.object === selectedFrame.id).map((item, index) => <div key={`${item.subject}-${item.relation}-${item.object}-${index}`}><span>{item.subject}</span><b>{item.relation}</b><span>{item.object}</span></div>)}</section>
                      <section className="relations lineage"><h3>{t('mindView.lineage').toUpperCase()}</h3>{(selectedFrameLineage?.edges ?? []).map((item, index) => <div key={`${item.subject}-${item.relation}-${item.object}-${index}`}><span>{item.subject}</span><b>{item.relation}</b><span>{item.object}</span></div>)}{selectedFrameLineage?.truncated && <small>{t('mindView.lineageTruncated')}</small>}</section>
                    </>
                  ) : <div className="small-empty">{t('mindView.emptyFrame')}</div>}
                </article>
              </div>
              <section className="mind-transaction-history">
                <header><span>{t('mindView.transactions.title').toUpperCase()}</span><small>{t('mindView.transactions.subtitle')}</small></header>
                <div>
                  {(mindTransactionPage?.events ?? []).slice().reverse().map(event => (
                    <details key={event.id}>
                      <summary><code>#{event.sequence ?? '—'}</code><strong>{String(event.payload.reason ?? t('mindView.transactions.updated'))}</strong><time>{formatTime(event.timestamp, i18n.language)}</time><ChevronDown size={13} /></summary>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </details>
                  ))}
                  {(mindTransactionPage?.events.length ?? 0) === 0 && <div className="small-empty">{t('mindView.transactions.empty')}</div>}
                </div>
              </section>
              </>}

              {cognitionView === 'attention' && <div className="attention-view">
                <section className="context-facts cognition-attention">
                  <div><small>{t('mindView.sessionWindow').toUpperCase()}</small><strong>{Math.round((contextView?.session_working_set.active_window_secs ?? 0) / 3600)}h</strong><span>{t('mindView.sessionWindowDetail', { count: contextView?.session_working_set.max_sessions ?? 0 })}</span></div>
                  <div><small>{t('mindView.pressure').toUpperCase()}</small><strong>{statusLabel(contextView?.pressure.level ?? 'normal', t)}</strong><span>{contextView?.pressure.token_accuracy ?? 'estimate'}</span></div>
                  <div><small>{t('mindView.checkpoints').toUpperCase()}</small><strong>{contextView?.state.checkpoints.length ?? 0}</strong><span>{t('mindView.checkpointsDetail')}</span></div>
                  <div><small>{t('mindView.recallIndex').toUpperCase()}</small><strong>{recallIndex?.capability.indexed ? t('mindView.indexed') : t('mindView.degraded')}</strong><span>{recallIndex?.capability.detail ?? t('mindView.indexUnknown')}</span></div>
                </section>
                <section className="working-set-board">
                  <header>
                    <div><span>{t('mindView.attention.workingSet').toUpperCase()}</span><strong>{contextView?.session_working_set.selection ?? '—'}</strong></div>
                    <small>{t('mindView.attention.population', {
                      full: contextView?.session_working_set.full_session_ids.length ?? 0,
                      metadata: contextView?.session_working_set.metadata_only_session_ids.length ?? 0,
                    })}</small>
                  </header>
                  <div className="working-set-exclusions">
                    {Object.entries(contextView?.session_working_set.excluded ?? {}).map(([reason, count]) => (
                      <span key={reason}>{t(`mindView.attention.exclusions.${reason}`)} <b>{count}</b></span>
                    ))}
                  </div>
                  <div className="working-set-sessions">
                    {(contextView?.sessions ?? []).map(projected => (
                      <article key={projected.session.id}>
                        <span className={`projection-state ${projected.projection}`}>{projected.projection}</span>
                        <div>
                          <strong>{projected.session.title}</strong>
                          <small>{shortId(projected.session.id, 32)} · {projected.principal_ids?.length ?? 0}P · {formatAgo(projected.session.last_activity_at, t)}</small>
                          {projected.session.attention_reason && <p>{projected.session.attention_reason}</p>}
                        </div>
                        <span className={`attention-state ${projected.session.attention_state ?? 'active'}`}>{projected.session.attention_state ?? 'active'}</span>
                      </article>
                    ))}
                    {(contextView?.sessions.length ?? 0) === 0 && <div className="small-empty">{t('mindView.attention.empty')}</div>}
                  </div>
                </section>
                <section className="observation-board">
                  <header><span>{t('mindView.attention.observations').toUpperCase()}</span><small>{t('mindView.attention.observationHint')}</small></header>
                  <div>
                    {(contextView?.observations ?? []).slice(-40).reverse().map(observation => (
                      <article key={observation.id}>
                        <code>{observation.reference}</code>
                        <span><strong>{observation.topic}</strong><small>{observation.actor} · {observation.session_id ? shortId(observation.session_id, 22) : t('mindView.attention.contextScope')}</small></span>
                        <p>{observation.preview}</p>
                        {observation.protected && <em>{t('mindView.attention.protected')}</em>}
                      </article>
                    ))}
                    {(contextView?.observations.length ?? 0) === 0 && <div className="small-empty">{t('mindView.attention.noObservations')}</div>}
                  </div>
                </section>
              </div>}
            </section>
          )}
        </div>

        <footer className="composer-area">
          <div className={`composer-status ${pendingApprovals.length > 0 ? 'has-approval' : ''}`}>
            <button className={`composer-task-status ${taskStrip.state}`} type="button" onClick={() => setView(current => current === 'scheduler' ? 'dialogue' : 'scheduler')} title={t('nav.toggleTasks')}>
              <i className={activeWorkCount || turnPending ? 'busy' : taskStrip.state} />
              <strong>{turnPending ? turnStatus : taskStrip.label}</strong>
              {!turnPending && <span>{taskStrip.summary}</span>}
              <em>{t('composer.status.summary', { executing: activeWorkCount, waiting: waitingCount })}</em>
            </button>
            {pendingApprovals[0] && (
              <div className="composer-approval-actions" aria-label={t('work.approvals.quickActions')}>
                <button
                  className="allow"
                  disabled={Boolean(decidingApprovalId)}
                  type="button"
                  onClick={() => void decideApproval(pendingApprovals[0], 'allow_once')}
                >
                  <Check size={12} /> {t('work.approvals.allowOnce')}
                </button>
                <button type="button" onClick={() => setView('scheduler')}>
                  {t('work.approvals.viewAll', { count: pendingApprovals.length })}
                </button>
                <button
                  className="deny"
                  disabled={Boolean(decidingApprovalId)}
                  type="button"
                  onClick={() => void decideApproval(pendingApprovals[0], 'deny')}
                >
                  <Square size={11} /> {t('work.approvals.deny')}
                </button>
              </div>
            )}
            <div className="composer-runtime-meta">
              <span
                className={`token-usage pressure-${contextView?.pressure.level ?? contextOverview?.pressure?.level ?? 'normal'}`}
                title={t('model.pressureTokens', { used: compactTokens(contextView?.pressure.estimated_tokens ?? contextOverview?.pressure?.estimated_tokens), limit: compactTokens(contextView?.pressure.hard_limit ?? contextOverview?.pressure?.hard_limit), source: contextView?.pressure.token_source ?? contextOverview?.pressure?.token_source ?? '—' })}
              >
                ≈ {compactTokens(contextView?.pressure.estimated_tokens ?? contextOverview?.pressure?.estimated_tokens)} / {compactTokens(contextView?.pressure.hard_limit ?? contextOverview?.pressure?.hard_limit)}
              </span>
              <span
                className="token-usage exact-usage"
                title={[
                  t('model.actualUsageTitle', {
                    attempts: modelUsagePage?.totals.attempts ?? 0,
                    input: compactTokens(modelUsagePage?.totals.input_tokens),
                    output: compactTokens(modelUsagePage?.totals.output_tokens),
                    cached: compactTokens(modelUsagePage?.totals.cached_input_tokens),
                  }),
                  modelUsagePage?.cost_totals?.[0]
                    ? t('model.actualCost', {
                        amount: modelUsagePage.cost_totals[0].amount.toFixed(6),
                        currency: modelUsagePage.cost_totals[0].currency,
                        version: modelUsagePage.cost_totals[0].pricing_version,
                      })
                    : t('model.costUnavailable'),
                ].join(' · ')}
              >Σ {compactTokens(modelUsagePage?.totals.total_tokens)}</span>
              <span className={`model-status ${status?.model ? 'ok' : ''}`}>{status?.model ?? t('model.unavailable')}</span>
              <span className="connection-status" title={t('nav.connection')}><i className={`status-dot ${wsStatus === 'connected' ? '' : wsStatus === 'connecting' ? 'connecting' : 'disconnected'}`} />{t(`connection.${wsStatus}`)}</span>
            </div>
          </div>
          <Composer
            inputRef={composerInputRef}
            selectedSessionId={selectedSessionId}
            sending={sending}
            activeWorkCount={activeWorkCount}
            quotes={quotes}
            activeQuoteId={activeQuoteId}
            t={t}
            onActiveQuoteIdChange={setActiveQuoteId}
            onRemoveQuote={removeQuote}
            onUpdateQuoteComment={updateQuoteComment}
            onSend={sendMessage}
            onCancel={cancelCurrentSession}
          />
          <div className="shortcut-row"><span>{t('composer.shortcuts.send')}</span><span>{t('composer.shortcuts.newline')}</span><span>{t('composer.shortcuts.tasks')}</span><span>{t('composer.shortcuts.mind')}</span><span>{t('composer.shortcuts.back')}</span></div>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button type="button" aria-label={t('errors.dismiss')} onClick={() => setError('')}><X size={12} /></button>
            </div>
          )}
        </footer>
        <SelectionQuotePopup label={t('conversation.addToChat')} onAdd={addQuote} />
      </section>
      {appDialog && <AppDialog key={appDialog.id} request={appDialog} onResolve={resolveAppDialog} />}
    </main>
  )
}
