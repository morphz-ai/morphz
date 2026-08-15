import { memo, startTransition, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
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
  Bot,
  BookOpen,
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
  Filter,
  FileText,
  GitBranch,
  Gauge,
  Globe,
  KeyRound,
  Layers3,
  ListTree,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Radio,
  Router,
  RefreshCw,
  Search,
  Send,
  Server,
  Square,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'
import { nextDashboardLanguage, persistDashboardLanguage } from './i18n/language'
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
  currentSchedulerSchedules,
  pendingHumanApprovals,
  schedulerApprovalAnomalies,
  schedulerAttentionJobs,
  threadCarriesExecution,
  retryableDialogueThread,
} from './scheduler/model'
import { findTurnSettlement } from './turnSettlement'
import { resolveSelectedModelOption } from './app/modelSelection'
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
  observesExactModelRequests,
  parseDashboardRoute,
  threadPath,
  type CognitionView,
  type DashboardView,
} from './app/routes'
import { LedgerPage } from './pages/LedgerPage'
import type { LedgerFilters } from './pages/LedgerPage'
import { CredentialsPage } from './pages/CredentialsPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { OverviewPage } from './pages/OverviewPage'
import { RuntimeOverviewPage, type RuntimeOverview } from './pages/RuntimeOverviewPage'
import { RuntimePage } from './pages/RuntimePage'
import { ThreadCausalCard } from './pages/ThreadCausalCard'
import { DashboardApiClient } from './api/client'
import { resolveDashboardToken } from './api/auth'
import { invalidatedQueriesForTopic } from './app/invalidation'
import { copyTextToClipboard } from './utils/clipboard'
import {
  assignTintSlots,
  autoTintDimension,
  buildObjectiveLineageIndex,
  tintIdForLineage,
  toneForSlot,
  type CausalLineage,
  type ObjectiveLineageIndex,
  type TintDimension,
} from './app/objectiveLineage'
import {
  assistantToolCalls,
  compactTokens,
  conversationEventKind,
  conversationEventLane,
  delegatedContextIds,
  formatAgo,
  formatLocalRfc3339,
  formatTime,
  shortId,
  statusLabel,
  summarizeToolCall,
  threadKindLabel,
  newestConversationEventsForLane,
  type ConversationWindowLane,
} from './app/presentation'
import { buildToolTimeline, executionTargetIds, type ToolTimelineItem } from './app/executionTools'
import { prettyPrintSExpression } from './app/sexpr'

/**
 * Resolves the colour for one causal id. Slots are allocated per live entity
 * rather than hashed, so this is handed down instead of recomputed per call
 * site: every surface has to agree on what a colour means.
 */
type TintStyleResolver = (id: string | undefined) => CSSProperties | undefined

function CausalIdentifierBadges({
  lineage,
  t,
  tintStyleFor,
}: {
  lineage: CausalLineage
  t: TFunction
  tintStyleFor: TintStyleResolver
}) {
  if (lineage.threadIds.length === 0 && lineage.objectiveIds.length === 0) return null
  return (
    <div className="message-causal-identifiers" aria-label={t('conversation.lineage.title')}>
      {lineage.threadIds.map(threadId => (
        <span
          className="causal-identifier thread"
          key={`thread-${threadId}`}
          style={tintStyleFor(threadId)}
          title={threadId}
        >
          <GitBranch size={10} />
          <b>{t('conversation.lineage.thread')}</b>
          <code>{shortId(threadId, 18)}</code>
        </span>
      ))}
      {lineage.objectiveIds.map(objectiveId => (
        <span
          className="causal-identifier objective"
          key={`objective-${objectiveId}`}
          style={tintStyleFor(objectiveId)}
          title={objectiveId}
        >
          <i aria-hidden="true" />
          <b>{t('conversation.lineage.objective')}</b>
          <code>{shortId(objectiveId, 18)}</code>
        </span>
      ))}
    </div>
  )
}

function MessageThreadReference({
  snapshot,
  objectiveIds,
  tintStyleFor,
  onOpen,
  t,
}: {
  snapshot: SchedulerThreadSnapshot
  objectiveIds: string[]
  tintStyleFor: TintStyleResolver
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
  // Only ids of the dimension in effect hold a slot, so at most one of these
  // resolves and the card needs no knowledge of which dimension that is.
  const threadTint = tintStyleFor(snapshot.thread.id) ?? tintStyleFor(objectiveIds[0])

  return (
    <div
      className={`message-thread-reference phase-${snapshot.phase} ${threadTint ? 'objective-tinted' : ''}`}
      style={threadTint}
    >
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
          {objectiveIds.length > 0 && (
            <em className="message-thread-objective" title={objectiveIds.join(', ')}>
              {t('conversation.lineage.objective')} · {shortId(objectiveIds[0], 18)}{objectiveIds.length > 1 ? ` +${objectiveIds.length - 1}` : ''}
            </em>
          )}
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
let dashboardTokenPersistentStorage: Storage | undefined
try {
  dashboardTokenPersistentStorage = window.localStorage
} catch {
  // Sandboxed/privacy-restricted documents can deny localStorage entirely.
}
let dashboardTokenSessionStorage: Storage | undefined
try {
  dashboardTokenSessionStorage = window.sessionStorage
} catch {
  // Session storage remains an optional same-tab fallback.
}
const CORE_TOKEN = resolveDashboardToken(
  window.location,
  {
    persistent: dashboardTokenPersistentStorage,
    session: dashboardTokenSessionStorage,
  },
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
  multiline?: boolean
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

function initialObjectiveTintEnabled(): boolean {
  return initialBooleanPreference('morphz.dashboard.objectiveTint', false)
}

function initialTintDimension(): TintDimension {
  try {
    return window.localStorage.getItem('morphz.dashboard.tintDimension') === 'thread'
      ? 'thread'
      : 'objective'
  } catch {
    return 'objective'
  }
}

function initialTintDimensionChosen(): boolean {
  return initialBooleanPreference('morphz.dashboard.tintDimensionChosen', false)
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
interface MessageWindowState {
  sessionId: string
  merged: number
  dialogue: number
  execution_output: number
}

interface PendingScrollRestore {
  lane: ConversationWindowLane
  previousHeight: number
}

function freshMessageWindow(sessionId = ''): MessageWindowState {
  return {
    sessionId,
    merged: MESSAGE_PAGE_SIZE,
    dialogue: MESSAGE_PAGE_SIZE,
    execution_output: MESSAGE_PAGE_SIZE,
  }
}

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
const CONTEXT_READER_HIGHLIGHT_TOKEN_LIMIT = 16_000

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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (request.kind === 'prompt') {
      const field = request.multiline ? textareaRef.current : inputRef.current
      field?.focus()
      field?.select()
    } else if (request.tone === 'danger') {
      cancelRef.current?.focus()
    } else {
      confirmRef.current?.focus()
    }
  }, [request])

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
        } else if (
          event.key === 'Enter'
          && !(event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          && (request.kind !== 'prompt' || !request.multiline || event.metaKey || event.ctrlKey)
        ) {
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
            {request.multiline ? (
              <textarea
                ref={textareaRef}
                rows={8}
                value={value}
                placeholder={request.placeholder}
                onChange={event => setValue(event.target.value)}
              />
            ) : (
              <input
                ref={inputRef}
                autoComplete="off"
                value={value}
                placeholder={request.placeholder}
                onChange={event => setValue(event.target.value)}
              />
            )}
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

interface SExpressionReaderRequest {
  source: string
  eyebrow: string
  title: string
  description: string
  badge: string
  badgeTone: 'exact' | 'current'
  notice: string
  closeLabel: string
}

const SExpressionReader = memo(function SExpressionReader({
  request,
  onClose,
  t,
}: {
  request: SExpressionReaderRequest
  onClose: () => void
  t: TFunction
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState(false)
  const pretty = useMemo(() => prettyPrintSExpression(request.source), [request.source])
  const highlighted = pretty.tokens.length <= CONTEXT_READER_HIGHLIGHT_TOKEN_LIMIT

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const copy = () => {
    void copyTextToClipboard(pretty.text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => setCopied(false))
  }

  return (
    <div
      className="app-dialog-backdrop sexpr-reader-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <section
        aria-labelledby="sexpr-reader-title"
        aria-modal="true"
        className="sexpr-reader"
        role="dialog"
      >
        <header>
          <div>
            <small>{request.eyebrow}</small>
            <h2 id="sexpr-reader-title">{request.title}</h2>
            <p>{request.description}</p>
          </div>
          <div className="sexpr-reader-actions">
            <button type="button" onClick={copy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t('sexprReader.copied') : t('sexprReader.copy')}
            </button>
            <button
              ref={closeRef}
              className="sexpr-reader-close"
              type="button"
              aria-label={request.closeLabel}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="sexpr-reader-meta">
          <span className={request.badgeTone}>{request.badge}</span>
          <span>
            {pretty.valid
              ? highlighted
                ? t('sexprReader.highlighted')
                : t('sexprReader.formatOnly')
              : t('sexprReader.invalid')}
          </span>
        </div>
        <pre className={highlighted ? 'is-highlighted' : ''}>
          {highlighted
            ? pretty.tokens.map((token, index) => token.kind === 'whitespace'
              ? token.text
              : <span className={`sexpr-token ${token.kind}`} key={`${index}-${token.kind}`}>{token.text}</span>)
            : pretty.text}
        </pre>
        <footer>{request.notice}</footer>
      </section>
    </div>
  )
})

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

interface ContextTokenBudget {
  context_id: string
  requested_hard_token_limit?: number | null
  effective_hard_token_limit: number
  soft_token_limit: number
  maintenance_reserve_tokens: number
  critical_token_limit: number
  token_budget_revision: number
  provider?: string | null
  model: string
  physical_prompt_token_limit: number
  physical_context_window_tokens?: number | null
  max_output_tokens?: number | null
  capacity_source: string
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

interface PrincipalDirectoryEntry {
  principal: {
    id: string
    provider_id: string
    assurance: string
    display_name?: string
    created_at: string
    updated_at: string
  }
  session_count: number
  active_session_count: number
  context_count: number
  last_activity_at?: string
}

interface PrincipalDirectoryPage {
  entries: PrincipalDirectoryEntry[]
  next_cursor?: string
}

function scopedSessionReadPath(path: string, principalId?: string): string {
  if (!principalId) return path
  return `${path}${path.includes('?') ? '&' : '?'}principal_id=${encodeURIComponent(principalId)}`
}

type ReasoningEffortSetting = 'none' | 'low' | 'medium' | 'high' | 'max'

interface InferenceModelOption {
  id: string
  label: string
  physical_models: string[]
  aliases?: string[]
  supported_reasoning_efforts?: ReasoningEffortSetting[]
  source: 'configured' | 'manual'
}

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
  identity_mode?: 'default' | 'trusted-gateway'
  identity_provider_id?: string
  model: string
  models: string[]
  model_options: InferenceModelOption[]
  model_catalog_error?: string
  provider?: string
  reasoning_effort?: ReasoningEffortSetting | null
  tool_count: number
  storage: string
  storage_backend: string
  permission_mode: string
  sandbox_mode: string
  reviewer: string
  model_input: {
    max_artifacts_per_import: number
    max_artifact_bytes: number
    max_import_bytes: number
    max_artifacts_per_request: number
    max_request_bytes: number
  }
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

interface EventPayload {
  text?: string
  context_id?: string
  session_id?: string
  tool_name?: string
  status?: string
  attachments?: Array<{
    id?: string
    name?: string
    media_type?: string
    size_bytes?: number
    sha256?: string
  }>
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

interface ComposerAttachment {
  id: string
  name: string
  mediaType: string
  size: number
  dataBase64: string
  previewUrl?: string
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

type ObjectiveMutationKind = 'edit' | 'pause' | 'resume' | 'delete' | ''

function ObjectiveCardActions({
  objective,
  expanded,
  selected,
  busy,
  disabled,
  t,
  onFilter,
  onEdit,
  onPause,
  onResume,
  onDelete,
  onToggle,
}: {
  objective: ObjectiveRecord
  expanded: boolean
  selected: boolean
  busy: ObjectiveMutationKind
  disabled: boolean
  t: TFunction
  onFilter: () => void
  onEdit: () => void
  onPause: () => void
  onResume: () => void
  onDelete: () => void
  onToggle: () => void
}) {
  const mutationPending = disabled || Boolean(busy)
  return (
    <div className="objective-card-actions">
      <button
        className={`objective-card-action filter ${selected ? 'is-active' : ''}`}
        type="button"
        aria-pressed={selected}
        aria-label={selected ? t('conversation.activity.clearObjectiveFilter') : t('conversation.activity.filterObjective')}
        title={selected ? t('conversation.activity.clearObjectiveFilter') : t('conversation.activity.filterObjective')}
        onClick={onFilter}
      >
        <Filter size={13} />
      </button>
      <button
        className="objective-card-action"
        type="button"
        disabled={mutationPending}
        aria-label={busy === 'edit' ? t('work.objectives.editing') : t('work.objectives.edit')}
        title={busy === 'edit' ? t('work.objectives.editing') : t('work.objectives.edit')}
        onClick={onEdit}
      >
        {busy === 'edit' ? <LoaderCircle className="is-spinning" size={13} /> : <Pencil size={13} />}
      </button>
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

interface SystemPromptInspection {
  profile: string
  content: string
  sha256: string
  bytes: number
  chars: number
  stable: boolean
}

interface RecallSearchHit {
  document_kind: 'event' | 'frame'
  document_id: string
  revision: number
  retired: boolean
  score: number
  preview: string
}

interface DialogueHistorySearchHit {
  event_id: string
  sequence?: number
  session_id: string
  topic: 'chat/user_message' | 'chat/reply' | 'chat/outbound_message'
  timestamp: string
  actor: string
  kind: 'user' | 'agent' | 'execution_result'
  score: number
  retired: boolean
  preview: string
}

interface SessionEventsPage {
  events: MorphzEvent[]
  next_before_sequence?: number
}

function mergeSessionEvents(left: MorphzEvent[], right: MorphzEvent[]) {
  const byId = new Map(left.map(event => [event.id, event]))
  for (const event of right) byId.set(event.id, event)
  return Array.from(byId.values()).sort((a, b) => {
    if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
      return a.sequence - b.sequence
    }
    const timeOrder = a.timestamp.localeCompare(b.timestamp)
    return timeOrder !== 0 ? timeOrder : a.id.localeCompare(b.id)
  })
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
  agent_id: string
  parent_context_id: string
  parent_session_id: string
  child_context_id: string
  child_session_id: string
  task: string
  status: string
  created_at: string
  updated_at: string
}

function toolCallTone(status: string): 'running' | 'succeeded' | 'failed' {
  if (['success', 'succeeded', 'completed'].includes(status)) return 'succeeded'
  if (['running', 'queued', 'pending'].includes(status)) return 'running'
  return 'failed'
}

const ExecutionToolCalls = memo(function ExecutionToolCalls({
  calls,
  targetNames,
  locale,
  t,
}: {
  calls: ToolTimelineItem[]
  targetNames: ReadonlyMap<string, string>
  locale: string
  t: TFunction
}) {
  const [expandedCallId, setExpandedCallId] = useState('')
  if (calls.length === 0) return null
  return (
    <section className="execution-tool-calls">
      <header>
        <span><ListTree size={13} />{t('conversation.toolCalls.title')}</span>
        <small>{t('conversation.toolCalls.count', { count: calls.length })}</small>
      </header>
      <ol>
        {calls.map(call => {
          const summary = summarizeToolCall(call.name, call.arguments, t)
          const tone = toolCallTone(call.status)
          const expanded = expandedCallId === call.id
          const targetIds = executionTargetIds(call.arguments)
          const targetLabel = targetIds
            .map(targetId => targetNames.get(targetId) ?? shortId(targetId, 22))
            .join(' → ')
          return (
            <li className={tone} key={call.id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedCallId(current => current === call.id ? '' : call.id)}
              >
                <span className="execution-tool-state" aria-hidden="true">
                  {tone === 'running'
                    ? <LoaderCircle size={12} />
                    : tone === 'succeeded'
                      ? <Check size={12} />
                      : <X size={12} />}
                </span>
                <span className="execution-tool-copy">
                  <span className="execution-tool-heading">
                    <strong>{summary.title}</strong>
                    {targetLabel && (
                      <span
                        className="execution-tool-target"
                        title={`${t('conversation.toolCalls.target')}: ${targetLabel} (${targetIds.join(' → ')})`}
                      >
                        <Server size={10} />
                        <span>{targetLabel}</span>
                      </span>
                    )}
                  </span>
                  <small>
                    <span>{summary.target || shortId(call.id, 18)}</span>
                  </small>
                </span>
                <time
                  className="execution-tool-time"
                  dateTime={call.timestamp}
                  title={new Date(call.timestamp).toLocaleString(locale)}
                >
                  {formatTime(call.timestamp, locale)}
                </time>
                <em>{statusLabel(call.status, t)}</em>
                <ChevronDown className="execution-tool-expand" size={13} aria-hidden="true" />
              </button>
              {expanded && (
                <div className="execution-tool-detail">
                  <section>
                    <strong>{t('conversation.toolCalls.arguments')}</strong>
                    <pre>{call.arguments || '{}'}</pre>
                    {call.truncated && <small>{t('conversation.toolCalls.truncated')}</small>}
                  </section>
                  <section>
                    <strong>{t('conversation.toolCalls.output')}</strong>
                    <pre>{call.result || t('conversation.toolCalls.noOutput')}</pre>
                  </section>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
})

function DialogueActivityDock({
  open,
  visible,
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
  selectedObjectiveId,
  currentSessionOnly,
  objectiveTintEnabled,
  tintDimension,
  tintStyleFor,
  objectiveIdsByThread,
  pausingObjectiveId,
  resumingObjectiveId,
  editingObjectiveId,
  deletingObjectiveId,
  mutatingThreadId,
  t,
  onOpenChange,
  onVisibleChange,
  onThreadToggle,
  onReasoningOpenChange,
  onInspectThread,
  onObjectiveToggle,
  onObjectiveFilterChange,
  onCurrentSessionOnlyChange,
  onObjectiveTintChange,
  onTintDimensionChange,
  onPauseObjective,
  onResumeObjective,
  onEditObjective,
  onDeleteObjective,
  onThreadControl,
  onOpenDelegationContext,
}: {
  open: boolean
  visible: boolean
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
  selectedObjectiveId: string
  currentSessionOnly: boolean
  objectiveTintEnabled: boolean
  tintDimension: TintDimension
  tintStyleFor: TintStyleResolver
  objectiveIdsByThread: ReadonlyMap<string, string[]>
  pausingObjectiveId: string
  resumingObjectiveId: string
  editingObjectiveId: string
  deletingObjectiveId: string
  mutatingThreadId: string
  t: TFunction
  onOpenChange: (open: boolean) => void
  onVisibleChange: (visible: boolean) => void
  onThreadToggle: (threadId: string) => void
  onReasoningOpenChange: (open: boolean) => void
  onInspectThread: (threadId: string) => void
  onObjectiveToggle: (objectiveId: string) => void
  onObjectiveFilterChange: (objectiveId: string) => void
  onCurrentSessionOnlyChange: (enabled: boolean) => void
  onObjectiveTintChange: (enabled: boolean) => void
  onTintDimensionChange: (dimension: TintDimension) => void
  onPauseObjective: (objective: ObjectiveRecord) => void
  onResumeObjective: (objective: ObjectiveRecord) => void
  onEditObjective: (objective: ObjectiveRecord) => void
  onDeleteObjective: (objective: ObjectiveRecord) => void
  onThreadControl: (thread: ThreadRecord, action: 'pause' | 'resume' | 'close') => void
  onOpenDelegationContext: (delegation: DelegationRecord) => void
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
    <>
      <aside
        className={`dialogue-activity-dock ${open ? 'is-open' : 'is-collapsed'} ${visible ? '' : 'is-hidden'}`}
        aria-label={t('conversation.activity.title')}
        aria-hidden={!visible}
        inert={!visible}
      >
        <header className="dialogue-activity-header">
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
          <button
            className="dialogue-activity-hide"
            type="button"
            title={t('conversation.activity.hidePanel')}
            aria-label={t('conversation.activity.hidePanel')}
            onClick={() => onVisibleChange(false)}
          >
            <PanelRightClose size={15} />
          </button>
        </header>

        {open && (
        <>
          <div className="dialogue-activity-controls">
            <button
              className={`current-session-filter ${currentSessionOnly ? 'is-active' : ''}`}
              type="button"
              aria-pressed={currentSessionOnly}
              title={currentSessionOnly
                ? t('conversation.activity.showAllSessions')
                : t('conversation.activity.showCurrentSession')}
              onClick={() => onCurrentSessionOnlyChange(!currentSessionOnly)}
            >
              <MessageSquare size={12} />
              <span>{currentSessionOnly
                ? t('conversation.activity.currentSessionOnly')
                : t('conversation.activity.allSessions')}</span>
            </button>
            {objectiveTintEnabled && (
              <div className="tint-dimension-tabs" role="group" aria-label={t('conversation.activity.tintDimension')}>
                {(['objective', 'thread'] as const).map(dimension => {
                  // Objectives come and go, so the tab stays put and greys out
                  // instead of appearing under the pointer.
                  const unavailable = dimension === 'objective' && objectives.length === 0
                  return (
                    <button
                      key={dimension}
                      className={tintDimension === dimension ? 'is-active' : ''}
                      type="button"
                      disabled={unavailable}
                      aria-pressed={tintDimension === dimension}
                      title={unavailable ? t('conversation.activity.tintNoObjective') : undefined}
                      onClick={() => onTintDimensionChange(dimension)}
                    >
                      {dimension === 'objective'
                        ? t('conversation.activity.tintByObjective')
                        : t('conversation.activity.tintByThread')}
                    </button>
                  )
                })}
              </div>
            )}
            <button
              className={`objective-tint-toggle ${objectiveTintEnabled ? 'is-active' : ''}`}
              type="button"
              aria-pressed={objectiveTintEnabled}
              title={objectiveTintEnabled ? t('conversation.activity.disableObjectiveTint') : t('conversation.activity.enableObjectiveTint')}
              aria-label={objectiveTintEnabled ? t('conversation.activity.disableObjectiveTint') : t('conversation.activity.enableObjectiveTint')}
              onClick={() => onObjectiveTintChange(!objectiveTintEnabled)}
            >
              <Palette size={12} />
            </button>
          </div>
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
                    : editingObjectiveId === objective.id
                      ? 'edit'
                      : deletingObjectiveId === objective.id
                        ? 'delete'
                        : ''
                const selected = selectedObjectiveId === objective.id
                return (
                  <article
                    className={`dialogue-objective-card ${objective.status} ${expanded ? 'is-expanded' : ''} ${selected ? 'is-selected' : ''} ${tintStyleFor(objective.id) ? 'objective-tinted' : ''}`}
                    key={objective.id}
                    style={tintStyleFor(objective.id)}
                  >
                    <header className="objective-card-titlebar">
                      <span className={`activity-status ${objective.status}`}><i />{statusLabel(objective.status, t)}</span>
                      <time>{formatAgo(objective.updated_at, t)}</time>
                      <ObjectiveCardActions
                        objective={objective}
                        expanded={expanded}
                        selected={selected}
                        busy={busy}
                        disabled={Boolean(pausingObjectiveId || resumingObjectiveId || editingObjectiveId || deletingObjectiveId)}
                        t={t}
                        onFilter={() => onObjectiveFilterChange(selected ? '' : objective.id)}
                        onEdit={() => onEditObjective(objective)}
                        onPause={() => onPauseObjective(objective)}
                        onResume={() => onResumeObjective(objective)}
                        onDelete={() => onDeleteObjective(objective)}
                        onToggle={() => onObjectiveToggle(objective.id)}
                      />
                    </header>
                    <strong>{objective.stated_objective}</strong>
                    <code className="dialogue-objective-id" title={objective.id}>{shortId(objective.id, 22)}</code>
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
                const displayState = effective.thread.control_state === 'paused'
                  ? 'paused'
                  : effective.phase === 'idle' ? effective.thread.lifecycle : effective.phase
                const objectiveIds = objectiveIdsByThread.get(effective.thread.id) ?? []
                return (
                  <article
                    className={`dialogue-thread-card phase-${effective.phase} ${expanded ? 'is-expanded' : ''} ${(tintStyleFor(snapshot.thread.id) ?? tintStyleFor(objectiveIds[0])) ? 'objective-tinted' : ''}`}
                    key={effective.thread.id}
                    style={tintStyleFor(snapshot.thread.id) ?? tintStyleFor(objectiveIds[0])}
                  >
                    <header className="dialogue-thread-card-header">
                      <button
                        className="dialogue-thread-summary"
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => onThreadToggle(effective.thread.id)}
                      >
                        <span className={`activity-status ${displayState}`}><i />{statusLabel(displayState, t)}</span>
                        <span className="dialogue-thread-identity">
                          <strong>{threadKindLabel(effective.thread.kind, t)}</strong>
                          <small title={effective.thread.id}>
                            <code>{shortId(effective.thread.id, 18)}</code>
                            {jobSummary && (
                              <span>{jobSummary.title}{jobSummary.target ? ` · ${jobSummary.target}` : ''}</span>
                            )}
                          </small>
                        </span>
                        <span className="dialogue-thread-counts">{effective.activations.length}A · {jobs.length}J</span>
                      </button>
                      {effective.thread.lifecycle === 'open' && (
                        <div className="dialogue-thread-card-actions">
                          {effective.thread.control_state === 'paused' ? (
                            <button disabled={mutatingThreadId === effective.thread.id} type="button" title={t('work.causal.resumeThread')} aria-label={t('work.causal.resumeThread')} onClick={() => onThreadControl(effective.thread, 'resume')}><Play size={12} /></button>
                          ) : (
                            <button disabled={mutatingThreadId === effective.thread.id} type="button" title={t('work.causal.pauseThread')} aria-label={t('work.causal.pauseThread')} onClick={() => onThreadControl(effective.thread, 'pause')}><Pause size={12} /></button>
                          )}
                          <button disabled={mutatingThreadId === effective.thread.id} className="danger" type="button" title={t('work.causal.closeThread')} aria-label={t('work.causal.closeThread')} onClick={() => onThreadControl(effective.thread, 'close')}><X size={12} /></button>
                        </div>
                      )}
                      <button
                        className="dialogue-thread-disclosure"
                        type="button"
                        aria-expanded={expanded}
                        aria-label={expanded ? t('conversation.activity.collapseThread') : t('conversation.activity.expandThread')}
                        onClick={() => onThreadToggle(effective.thread.id)}
                      >
                        <ChevronDown size={13} />
                      </button>
                    </header>
                    <div className="dialogue-thread-origin">
                      <span>{currentSession ? t('conversation.activity.currentSession') : t('conversation.activity.otherSession', { id: shortId(effective.thread.session_id, 14) })}</span>
                      {objectiveIds.length > 0 && (
                        <code title={objectiveIds.join(', ')}>{t('conversation.lineage.objective')} · {shortId(objectiveIds[0], 14)}{objectiveIds.length > 1 ? ` +${objectiveIds.length - 1}` : ''}</code>
                      )}
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
                      <button type="button" onClick={() => onOpenDelegationContext(delegation)}>
                        {t('conversation.activity.openDelegationContext')}
                        <ChevronRight size={10} />
                      </button>
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
                const objectiveIds = objectiveIdsByThread.get(snapshot.thread.id) ?? []
                return (
                  <button
                    className={`dialogue-history-card ${(tintStyleFor(snapshot.thread.id) ?? tintStyleFor(objectiveIds[0])) ? 'objective-tinted' : ''}`}
                    style={tintStyleFor(snapshot.thread.id) ?? tintStyleFor(objectiveIds[0])}
                    type="button"
                    key={snapshot.thread.id}
                    onClick={() => onInspectThread(snapshot.thread.id)}
                  >
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
        </>
        )}
      </aside>
      <button
        className={`dialogue-activity-restore ${visible ? '' : 'is-visible'}`}
        type="button"
        title={t('conversation.activity.showPanel')}
        aria-label={t('conversation.activity.showPanel')}
        aria-hidden={visible}
        tabIndex={visible ? -1 : 0}
        onClick={() => onVisibleChange(true)}
      >
        <PanelRightOpen size={16} />
      </button>
    </>
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
      threadKind: 'execution',
      threadId: item.root_turn_id,
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

const MessageAttachments = memo(function MessageAttachments({
  attachments,
}: {
  attachments: EventPayload['attachments']
}) {
  if (!attachments?.length) return null
  return (
    <div className="message-attachments">
      {attachments.map((attachment, index) => (
        <span key={attachment.id ?? attachment.sha256 ?? `${attachment.name}-${index}`}>
          <Paperclip size={12} />
          <strong>{attachment.name ?? 'attachment'}</strong>
          {typeof attachment.size_bytes === 'number' && (
            <small>
              {(attachment.size_bytes < 1024 * 1024
                ? attachment.size_bytes / 1024
                : attachment.size_bytes / 1024 / 1024
              ).toFixed(attachment.size_bytes < 1024 * 1024 ? 0 : 1)}
              {' '}{attachment.size_bytes < 1024 * 1024 ? 'KB' : 'MB'}
            </small>
          )}
        </span>
      ))}
    </div>
  )
})

function formatFileSize(bytes: number): string {
  const mib = 1024 * 1024
  const kib = 1024
  if (bytes >= mib) return `${Number((bytes / mib).toFixed(1))} MiB`
  if (bytes >= kib) return `${Number((bytes / kib).toFixed(1))} KiB`
  return `${bytes} B`
}

// Keep draft input state below App. A keystroke should only reconcile the
// composer, not the full event history and every dashboard view.
const Composer = memo(function Composer({
  inputRef,
  selectedSessionId,
  sending,
  readOnly,
  activeWorkCount,
  quotes,
  activeQuoteId,
  t,
  onActiveQuoteIdChange,
  onRemoveQuote,
  onUpdateQuoteComment,
  onSend,
  onCancel,
  onError,
  modelInputPolicy,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  selectedSessionId: string
  sending: boolean
  readOnly: boolean
  activeWorkCount: number
  quotes: QuoteItem[]
  activeQuoteId: string
  t: TFunction
  onActiveQuoteIdChange: (quoteId: string) => void
  onRemoveQuote: (quoteId: string) => void
  onUpdateQuoteComment: (quoteId: string, comment: string) => void
  onSend: (message: string, attachments: ComposerAttachment[]) => Promise<boolean>
  onCancel: () => void
  onError: (message: string) => void
  modelInputPolicy?: RuntimeStatus['model_input']
}) {
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [draggingFiles, setDraggingFiles] = useState(false)
  const composingInput = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const submit = useCallback(async () => {
    if (readOnly) return
    if (await onSend(message, attachments)) {
      setMessage('')
      setAttachments(current => {
        current.forEach(attachment => attachment.previewUrl && URL.revokeObjectURL(attachment.previewUrl))
        return []
      })
    }
  }, [attachments, message, onSend, readOnly])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    if (readOnly) return
    const incoming = Array.from(files)
    if (!incoming.length) return
    if (modelInputPolicy
      && attachments.length + incoming.length > modelInputPolicy.max_artifacts_per_import) {
      onError(t('composer.attachments.tooMany', {
        count: modelInputPolicy.max_artifacts_per_import,
      }))
      return
    }
    if (modelInputPolicy
      && incoming.some(file => file.size > modelInputPolicy.max_artifact_bytes)) {
      onError(t('composer.attachments.fileTooLarge', {
        size: formatFileSize(modelInputPolicy.max_artifact_bytes),
      }))
      return
    }
    const totalBytes = attachments.reduce((total, item) => total + item.size, 0)
      + incoming.reduce((total, file) => total + file.size, 0)
    if (modelInputPolicy && totalBytes > modelInputPolicy.max_import_bytes) {
      onError(t('composer.attachments.totalTooLarge', {
        size: formatFileSize(modelInputPolicy.max_import_bytes),
      }))
      return
    }
    try {
      const added = await Promise.all(incoming.map(async file => {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
          reader.onload = () => resolve(String(reader.result ?? ''))
          reader.readAsDataURL(file)
        })
        return {
          id: `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          size: file.size,
          dataBase64: dataUrl.split(',', 2)[1] ?? '',
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        } satisfies ComposerAttachment
      }))
      setAttachments(current => [...current, ...added])
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [attachments, modelInputPolicy, onError, readOnly, t])

  return (
    <div
      className={`composer ${draggingFiles ? 'dragging-files' : ''} ${readOnly ? 'read-only' : ''}`}
      onDragEnter={event => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDraggingFiles(true)
        }
      }}
      onDragOver={event => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false)
      }}
      onDrop={event => {
        event.preventDefault()
        setDraggingFiles(false)
        void addFiles(event.dataTransfer.files)
      }}
    >
      <span className="composer-prompt">›</span>
      <div className="composer-input-area">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map(attachment => (
              <div className="composer-attachment" key={attachment.id}>
                {attachment.previewUrl
                  ? <img src={attachment.previewUrl} alt="" />
                  : <FileText size={15} />}
                <span>
                  <strong>{attachment.name}</strong>
                  <small>
                    {(attachment.size < 1024 * 1024 ? attachment.size / 1024 : attachment.size / 1024 / 1024)
                      .toFixed(attachment.size < 1024 * 1024 ? 0 : 1)}
                    {' '}{attachment.size < 1024 * 1024 ? 'KB' : 'MB'}
                  </small>
                </span>
                <button
                  type="button"
                  title={t('composer.attachments.remove')}
                  onClick={() => setAttachments(current => {
                    const removed = current.find(item => item.id === attachment.id)
                    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
                    return current.filter(item => item.id !== attachment.id)
                  })}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
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
          disabled={sending || readOnly}
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
          placeholder={readOnly
            ? t('composer.readOnlyPlaceholder')
            : selectedSessionId
              ? t('composer.placeholder')
              : t('composer.noSessionPlaceholder')}
          rows={1}
          value={message}
        />
      </div>
      <input
        ref={fileInputRef}
        className="composer-file-input"
        type="file"
        multiple
        disabled={sending || readOnly}
        onChange={event => {
          if (event.target.files) void addFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <button
        className="attachment-button"
        type="button"
        title={t('composer.attachments.add')}
        disabled={sending || readOnly}
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip size={15} />
      </button>
      {activeWorkCount > 0 ? (
        <button className="cancel-button" type="button" title={readOnly ? t('header.principalScopeReadOnly') : t('composer.cancelTitle')} disabled={readOnly} onClick={onCancel}><Square size={14} /></button>
      ) : null}
      <button
        className="send-button"
        aria-label={t('composer.send')}
        title={t('composer.send')}
        disabled={(!message.trim() && quotes.length === 0 && attachments.length === 0) || sending || readOnly}
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
  const [objectiveTintEnabled, setObjectiveTintEnabled] = useState(initialObjectiveTintEnabled)
  const [tintDimension, setTintDimension] = useState<TintDimension>(initialTintDimension)
  // Once the operator has picked a dimension, the automatic default steps
  // aside for good: it exists to open on a sensible view, not to keep
  // overriding a deliberate choice.
  const [tintDimensionChosen, setTintDimensionChosen] = useState(initialTintDimensionChosen)
  const [requestedObjectiveFilterId, setSelectedObjectiveFilterId] = useState('')
  const [requestedThreadGroupFilterId, setSelectedThreadGroupFilterId] = useState('')
  const [requestedSupervisorFilterId, setSelectedSupervisorFilterId] = useState('')
  const [dialogueCurrentSessionOnly, setDialogueCurrentSessionOnly] = useState(
    () => initialBooleanPreference('morphz.dashboard.dialogueActivity.currentSessionOnly', false),
  )
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
  const [dialogueActivityVisible, setDialogueActivityVisible] = useStoredDisclosure('morphz.dashboard.dialogueActivity.visible', true)
  const [agentContextsOpen, setAgentContextsOpen] = useStoredDisclosure('morphz.dashboard.contextMenu.agentContexts', false)
  const [immersiveMode, setImmersiveMode] = useStoredDisclosure('morphz.dashboard.immersiveMode', false)
  const [expandedDialogueThreadId, setExpandedDialogueThreadId] = useState('')
  const [dialogueThreadDetail, setDialogueThreadDetail] = useState<ThreadDetailResponse | null>(null)
  const [projectionAudit, setProjectionAudit] = useState<MindProjectionAudit | null>(null)
  const [auditingProjection, setAuditingProjection] = useState(false)
  const [contextOverview, setContextOverview] = useState<ContextOverviewResponse | null>(null)
  const [runtimeOverview, setRuntimeOverview] = useState<RuntimeOverview | null>(null)
  const [runtimeOverviewLoading, setRuntimeOverviewLoading] = useState(false)
  const [runtimeOverviewError, setRuntimeOverviewError] = useState('')
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
  const [sexprReader, setSexprReader] = useState<SExpressionReaderRequest | null>(null)
  const [systemPrompt, setSystemPrompt] = useState<SystemPromptInspection | null>(null)
  const [systemPromptLoading, setSystemPromptLoading] = useState(false)
  const [systemPromptCopied, setSystemPromptCopied] = useState(false)
  const [liveModelState, dispatchModelStream] = useReducer(modelStreamReducer, createLiveModelState())
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedContextId, setSelectedContextId] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [selectedFrameId, setSelectedFrameId] = useState('')
  const [activeFramesOnly, setActiveFramesOnly] = useState(true)
  const [recallQuery, setRecallQuery] = useState('')
  const [recallMatches, setRecallMatches] = useState<RecallSearchHit[]>([])
  const [dialogueSearchQuery, setDialogueSearchQuery] = useState('')
  const [dialogueSearchMatches, setDialogueSearchMatches] = useState<DialogueHistorySearchHit[]>([])
  const [dialogueSearchOpen, setDialogueSearchOpen] = useState(false)
  const [dialogueSearchSubmitted, setDialogueSearchSubmitted] = useState(false)
  const [dialogueSearchBusy, setDialogueSearchBusy] = useState(false)
  const [pendingDialogueSearchHit, setPendingDialogueSearchHit] = useState<DialogueHistorySearchHit | null>(null)
  const [frameLineage, setFrameLineage] = useState<FrameRecallPage | null>(null)
  const [recallIndex, setRecallIndex] = useState<RecallIndexAudit | null>(null)
  const [recallBusy, setRecallBusy] = useState(false)
  const [mutatingFrameId, setMutatingFrameId] = useState('')
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [conversationSessionMenuOpen, setConversationSessionMenuOpen] = useState(false)
  const [principalMenuOpen, setPrincipalMenuOpen] = useState(false)
  const [principalSearchQuery, setPrincipalSearchQuery] = useState('')
  const [principalSearchEntries, setPrincipalSearchEntries] = useState<PrincipalDirectoryEntry[]>([])
  const [principalSearchCursor, setPrincipalSearchCursor] = useState('')
  const [principalSearchBusy, setPrincipalSearchBusy] = useState(false)
  const [principalScope, setPrincipalScope] = useState<PrincipalDirectoryEntry | null>(null)
  const [creatingContext, setCreatingContext] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [catalogMutationKey, setCatalogMutationKey] = useState('')
  const [appDialog, setAppDialog] = useState<AppDialogRequest | null>(null)
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [sending, setSending] = useState(false)
  const [changingReasoning, setChangingReasoning] = useState(false)
  const [changingModel, setChangingModel] = useState(false)
  const [contextTokenBudget, setContextTokenBudget] = useState<ContextTokenBudget | null>(null)
  const [contextTokenBudgetDraft, setContextTokenBudgetDraft] = useState('')
  const [modelPromptTokenLimitDraft, setModelPromptTokenLimitDraft] = useState('')
  const [contextTokenBudgetOpen, setContextTokenBudgetOpen] = useState(false)
  const [changingContextTokenBudget, setChangingContextTokenBudget] = useState(false)
  const [changingModelPromptTokenLimit, setChangingModelPromptTokenLimit] = useState(false)
  const [pausingObjectiveId, setPausingObjectiveId] = useState('')
  const [resumingObjectiveId, setResumingObjectiveId] = useState('')
  const [editingObjectiveId, setEditingObjectiveId] = useState('')
  const [deletingObjectiveId, setDeletingObjectiveId] = useState('')
  const [mutatingThreadId, setMutatingThreadId] = useState('')
  const [expandedObjectiveIds, setExpandedObjectiveIds] = useState<Set<string>>(() => new Set())
  const [decidingApprovalId, setDecidingApprovalId] = useState('')
  const [mutatingScheduleId, setMutatingScheduleId] = useState('')
  const [copiedMessageId, setCopiedMessageId] = useState('')
  const [retryingTurnEventId, setRetryingTurnEventId] = useState('')
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
  const [messageWindow, setMessageWindow] = useState<MessageWindowState>(() => freshMessageWindow())
  const [eventHistoryCursor, setEventHistoryCursor] = useState<number | null>(null)
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false)
  const loadingOlder = useRef(false)
  const eventHistoryCursorRef = useRef<{ sessionId: string, nextBeforeSequence: number | null }>({
    sessionId: '',
    nextBeforeSequence: null,
  })
  const locatingDialogueSearchEvent = useRef('')
  const pendingScrollRestore = useRef<PendingScrollRestore | null>(null)
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
  const conversationSessionSelectorRef = useRef<HTMLDivElement>(null)
  const principalSelectorRef = useRef<HTMLDivElement>(null)
  const themeSelectorRef = useRef<HTMLDivElement>(null)
  const contextTokenBudgetRef = useRef<HTMLDivElement>(null)
  const appDialogRef = useRef<AppDialogRequest | null>(null)
  const appDialogSequence = useRef(0)
  const principalSearchRequestSequence = useRef(0)
  const selectedScopeRef = useRef({ sessionId: '', contextId: '' })
  const principalScopeRef = useRef<PrincipalDirectoryEntry | null>(null)
  const activeViewRef = useRef(view)
  const schedulerHistoryLimitRef = useRef(schedulerHistoryLimit)

  useEffect(() => {
    try {
      window.localStorage.setItem('morphz.dashboard.conversationLayout', conversationLayout)
    } catch {
      // The layout preference remains active for the current page lifetime.
    }
  }, [conversationLayout])

  useEffect(() => {
    try {
      window.localStorage.setItem('morphz.dashboard.objectiveTint', String(objectiveTintEnabled))
    } catch {
      // The visual preference remains active for the current page lifetime.
    }
  }, [objectiveTintEnabled])

  useEffect(() => {
    try {
      window.localStorage.setItem('morphz.dashboard.tintDimension', tintDimension)
      window.localStorage.setItem('morphz.dashboard.tintDimensionChosen', String(tintDimensionChosen))
    } catch {
      // The visual preference remains active for the current page lifetime.
    }
  }, [tintDimension, tintDimensionChosen])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        'morphz.dashboard.dialogueActivity.currentSessionOnly',
        String(dialogueCurrentSessionOnly),
      )
    } catch {
      // The filter remains active for the current page lifetime.
    }
  }, [dialogueCurrentSessionOnly])

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
    multiline?: boolean
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

  useEffect(() => {
    principalScopeRef.current = principalScope
  }, [principalScope])

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

  const loadCatalog = useCallback(async () => {
    try {
      const observedPrincipalId = principalScopeRef.current?.principal.id
      const sessionsPath = observedPrincipalId
        ? `/api/operator/principals/${encodeURIComponent(observedPrincipalId)}/sessions?include_archived=true`
        : '/api/sessions?include_archived=true'
      const [nextStatus, agentsResult, contextsResult, sessionsResult, delegationsResult, targetsResult, nodesResult, leasesResult, jobsResult] = await Promise.all([
        DASHBOARD_API.get<RuntimeStatus>('/api/status'),
        DASHBOARD_API.tryGet<{ agents?: AgentRecord[] }>('/api/agents?include_archived=true'),
        DASHBOARD_API.tryGet<{ contexts?: ContextRecord[] }>('/api/contexts?include_archived=true'),
        DASHBOARD_API.tryGet<{ sessions?: SessionRecord[] }>(sessionsPath),
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
      return {
        contexts: nextContexts,
        sessions: nextSessions,
        delegations: nextDelegations,
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    } finally {
      setCatalogReady(true)
    }
  }, [])

  const searchPrincipalDirectory = useCallback(async (
    query: string,
    cursor = '',
    append = false,
  ) => {
    const requestSequence = ++principalSearchRequestSequence.current
    setPrincipalSearchBusy(true)
    try {
      const params = new URLSearchParams({ query, limit: '20' })
      if (cursor) params.set('cursor', cursor)
      const page = await DASHBOARD_API.get<PrincipalDirectoryPage>(
        `/api/operator/principals?${params.toString()}`,
      )
      if (requestSequence !== principalSearchRequestSequence.current) return
      setPrincipalSearchEntries(current => append ? [...current, ...page.entries] : page.entries)
      setPrincipalSearchCursor(page.next_cursor ?? '')
      setError('')
    } catch (reason) {
      if (requestSequence !== principalSearchRequestSequence.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (requestSequence === principalSearchRequestSequence.current) {
        setPrincipalSearchBusy(false)
      }
    }
  }, [])

  const observePrincipal = useCallback(async (entry: PrincipalDirectoryEntry) => {
    const principalId = entry.principal.id
    if (principalId === status?.principal_id) {
      principalScopeRef.current = null
      setPrincipalScope(null)
    } else {
      principalScopeRef.current = entry
      setPrincipalScope(entry)
    }
    try {
      const sessionsPath = principalId === status?.principal_id
        ? '/api/sessions?include_archived=true'
        : `/api/operator/principals/${encodeURIComponent(principalId)}/sessions?include_archived=true`
      const response = await DASHBOARD_API.get<{ sessions?: SessionRecord[] }>(sessionsPath)
      const nextSessions = response.sessions ?? []
      const nextSession = nextSessions
        .filter(item => item.status === 'active')
        .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))[0]
      setSessions(nextSessions)
      setPendingTurn(null)
      setPrincipalMenuOpen(false)
      setSessionMenuOpen(false)
      setConversationSessionMenuOpen(false)
      if (nextSession) {
        setSelectedAgentId(nextSession.agent_id)
        setSelectedContextId(nextSession.context_id)
        setSelectedSessionId(nextSession.id)
        navigate(dashboardPath('dialogue', nextSession.context_id, nextSession.id))
      } else {
        setSelectedSessionId('')
        navigate(dashboardPath('overview', selectedContextId))
      }
      setError('')
    } catch (reason) {
      principalScopeRef.current = null
      setPrincipalScope(null)
      setSessions([])
      setSelectedSessionId('')
      setPendingTurn(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [navigate, selectedContextId, status])

  const clearPrincipalScope = useCallback(async () => {
    principalScopeRef.current = null
    setPrincipalScope(null)
    try {
      const response = await DASHBOARD_API.get<{ sessions?: SessionRecord[] }>(
        '/api/sessions?include_archived=true',
      )
      const nextSessions = response.sessions ?? []
      const nextSession = nextSessions
        .filter(item => item.status === 'active')
        .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))[0]
      setSessions(nextSessions)
      setPrincipalMenuOpen(false)
      setPendingTurn(null)
      if (nextSession) {
        setSelectedAgentId(nextSession.agent_id)
        setSelectedContextId(nextSession.context_id)
        setSelectedSessionId(nextSession.id)
        navigate(dashboardPath('dialogue', nextSession.context_id, nextSession.id))
      } else {
        setSelectedSessionId('')
        navigate(dashboardPath('overview', selectedContextId))
      }
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [navigate, selectedContextId])

  useEffect(() => {
    if (!principalMenuOpen) return
    const query = principalSearchQuery.trim()
    const timer = window.setTimeout(() => {
      void searchPrincipalDirectory(query)
    }, query ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [principalMenuOpen, principalSearchQuery, searchPrincipalDirectory])

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
      let resolvedSchedulerSummary: SchedulerSnapshot['summary'] | null = null
      const applySchedulerSnapshot = (snapshot: SchedulerSnapshot) => {
        if (!isCurrentScope()) return
        resolvedSchedulerSummary = snapshot.summary
        setSchedulerSnapshot(snapshot)
        setContextOverview(previous => previous
          ? { ...previous, scheduler: snapshot.summary }
          : previous)
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
        `/api/contexts/${encodeURIComponent(contextId)}/overview?session_id=${encodeURIComponent(sessionId)}&include_scheduler_summary=${includeTerminal ? 'false' : 'true'}`,
      ).then(async snapshot => {
        if (!isCurrentScope()) return
        // In Dialogue/Scheduler the full snapshot is fetched in parallel.
        // Never let the intentionally empty overview summary race afterward
        // and overwrite the authoritative summary that already arrived.
        setContextOverview(includeTerminal && resolvedSchedulerSummary
          ? { ...snapshot, scheduler: resolvedSchedulerSummary }
          : snapshot)
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
        DASHBOARD_API.tryGet<SessionEventsPage>(scopedSessionReadPath(
          `/api/sessions/${encodeURIComponent(sessionId)}/events?conversation_only=true&limit=1000`,
          principalScopeRef.current?.principal.id,
        ))
          .then(eventsResult => {
            if (!eventsResult || !isCurrentScope()) return
            const nextEvents = eventsResult.events ?? []
            const hasLoadedHistory = eventHistoryCursorRef.current.sessionId === sessionId
            setEvents(previous => hasLoadedHistory
              ? mergeSessionEvents(previous, nextEvents)
              : nextEvents)
            setEventsSessionId(sessionId)
            if (!hasLoadedHistory) {
              const nextCursor = eventsResult.next_before_sequence ?? null
              eventHistoryCursorRef.current = { sessionId, nextBeforeSequence: nextCursor }
              setEventHistoryCursor(nextCursor)
            }
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
              const nextDelegations = delegationsResult.delegations ?? []
              setDelegations(nextDelegations)
              const knownContextIds = new Set(contexts.map(context => context.id))
              if (nextDelegations.some(delegation => !knownContextIds.has(delegation.child_context_id))) {
                void loadCatalog()
              }
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
  }, [contexts, loadCatalog])

  const loadContextProjection = useCallback(async (sessionId: string, contextId: string) => {
    if (!sessionId || !contextId) return
    try {
      const projection = await DASHBOARD_API.get<ContextViewResponse>(scopedSessionReadPath(
        `/api/sessions/${encodeURIComponent(sessionId)}/context/projection`,
        principalScopeRef.current?.principal.id,
      ))
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
      const encoding = await DASHBOARD_API.get<ContextEncodingResponse>(scopedSessionReadPath(
        `/api/sessions/${encodeURIComponent(sessionId)}/context/encoding`,
        principalScopeRef.current?.principal.id,
      ))
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

  const loadRuntimeOverview = useCallback(async () => {
    setRuntimeOverviewLoading(true)
    try {
      const snapshot = await DASHBOARD_API.get<RuntimeOverview>(
        '/api/overview?context_limit=40&sessions_per_context=6',
      )
      setRuntimeOverview(snapshot)
      setRuntimeOverviewError('')
    } catch (reason) {
      setRuntimeOverviewError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRuntimeOverviewLoading(false)
    }
  }, [])

  const expandRuntimeOverviewSessions = useCallback(async (contextId: string) => {
    try {
      const params = new URLSearchParams({
        context_id: contextId,
        context_limit: '1',
        sessions_per_context: '200',
      })
      const expanded = await DASHBOARD_API.get<RuntimeOverview>(`/api/overview?${params.toString()}`)
      const expandedContext = expanded.contexts[0]
      if (!expandedContext) return
      setRuntimeOverview(current => current ? {
        ...current,
        generated_at: expanded.generated_at,
        contexts: current.contexts.map(item => (
          item.context.id === contextId ? expandedContext : item
        )),
      } : current)
      setRuntimeOverviewError('')
    } catch (reason) {
      setRuntimeOverviewError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const loadContextTokenBudget = useCallback(async (contextId: string) => {
    if (!contextId) {
      setContextTokenBudget(null)
      setContextTokenBudgetDraft('')
      setModelPromptTokenLimitDraft('')
      return
    }
    try {
      const budget = await DASHBOARD_API.get<ContextTokenBudget>(
        `/api/contexts/${encodeURIComponent(contextId)}/token-budget`,
      )
      if (selectedScopeRef.current.contextId !== contextId) return
      setContextTokenBudget(budget)
      setContextTokenBudgetDraft(
        budget.requested_hard_token_limit == null
          ? ''
          : String(budget.requested_hard_token_limit),
      )
      setModelPromptTokenLimitDraft(String(budget.physical_prompt_token_limit))
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

  const loadSystemPrompt = useCallback(async () => {
    setSystemPromptLoading(true)
    try {
      const inspection = await DASHBOARD_API.get<SystemPromptInspection>('/api/runtime/system-prompt')
      setSystemPrompt(inspection)
      setError('')
    } catch (reason) {
      setSystemPrompt(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSystemPromptLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSessionRef.current = loadSession
  }, [loadSession])

  const searchRecall = useCallback(async () => {
    if (!selectedContextId || !recallQuery.trim()) return
    setRecallBusy(true)
    try {
      const page = await DASHBOARD_API.get<{ matches: RecallSearchHit[] }>(
        `/api/contexts/${encodeURIComponent(selectedContextId)}/recall/search?query=${encodeURIComponent(recallQuery.trim())}&limit=30`,
      )
      setRecallMatches(page.matches)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRecallBusy(false)
    }
  }, [recallQuery, selectedContextId])

  const searchDialogueHistory = useCallback(async () => {
    const query = dialogueSearchQuery.trim()
    if (!selectedContextId || !query) return
    setDialogueSearchBusy(true)
    setDialogueSearchOpen(true)
    try {
      const page = await DASHBOARD_API.get<{ matches: DialogueHistorySearchHit[] }>(scopedSessionReadPath(
        `/api/contexts/${encodeURIComponent(selectedContextId)}/dialogue/search?query=${encodeURIComponent(query)}&limit=60`,
        principalScopeRef.current?.principal.id,
      ))
      setDialogueSearchMatches(page.matches)
      setDialogueSearchSubmitted(true)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDialogueSearchBusy(false)
    }
  }, [dialogueSearchQuery, selectedContextId])

  const openDialogueSearchHit = useCallback((hit: DialogueHistorySearchHit) => {
    const targetSession = sessions.find(session => session.id === hit.session_id)
    if (!targetSession) {
      setError(t('conversation.search.sessionUnavailable'))
      return
    }
    setSelectedObjectiveFilterId('')
    setPendingDialogueSearchHit(hit)
    setDialogueSearchOpen(false)
    if (targetSession.id !== selectedSessionId) {
      setPendingTurn(null)
      setSelectedAgentId(targetSession.agent_id)
      setFrameLineage(null)
      setSelectedContextId(targetSession.context_id)
      setSelectedSessionId(targetSession.id)
    }
    navigate(dashboardPath('dialogue', targetSession.context_id, targetSession.id))
  }, [navigate, selectedSessionId, sessions, t])

  const mutateFrameLifecycle = useCallback(async (frameId: string, action: 'restore' | 'protect' | 'unprotect') => {
    if (!selectedContextId || !selectedSessionId || !contextView) return
    setMutatingFrameId(frameId)
    try {
      await DASHBOARD_API.command(
        `/api/contexts/${encodeURIComponent(selectedContextId)}/frames/${encodeURIComponent(frameId)}/lifecycle`,
        'POST',
        {
          session_id: selectedSessionId,
          expected_version: contextView.state.version,
          action,
        },
      )
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
  }, [contextView, loadContextProjection, loadOverview, selectedContextId, selectedSessionId])

  const retired = useMemo(
    () => new Set(contextView?.state.retired ?? []),
    [contextView?.state.retired],
  )
  const visibleFrames = useMemo(
    () => (contextView?.state.frames ?? []).filter(frame => (
      !activeFramesOnly || !retired.has(frame.id)
    )),
    [activeFramesOnly, contextView?.state.frames, retired],
  )
  const effectiveSelectedFrameId = visibleFrames.some(frame => frame.id === selectedFrameId)
    ? selectedFrameId
    : visibleFrames[0]?.id ?? ''
  const protectedFrames = useMemo(
    () => new Set(contextView?.state.protected ?? []),
    [contextView?.state.protected],
  )

  useEffect(() => {
    if (view !== 'cognition' || !selectedContextId) return
    let cancelled = false
    void DASHBOARD_API.tryGet<RecallIndexAudit>(
      `/api/contexts/${encodeURIComponent(selectedContextId)}/recall/index`,
    ).then(result => {
      if (result && !cancelled) setRecallIndex(result)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selectedContextId, view])

  useEffect(() => {
    if (view !== 'cognition' || !selectedContextId || !effectiveSelectedFrameId) return
    let cancelled = false
    void DASHBOARD_API.tryGet<FrameRecallPage>(
      `/api/contexts/${encodeURIComponent(selectedContextId)}/frames/${encodeURIComponent(effectiveSelectedFrameId)}/recall?depth=2&direction=both&include_bodies=false&max_nodes=64`,
    ).then(result => {
      if (result && !cancelled) setFrameLineage(result)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [effectiveSelectedFrameId, selectedContextId, view])

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
    selectedScopeRef.current = { sessionId: selectedSessionId, contextId: selectedContextId }
  }, [selectedContextId, selectedSessionId])

  useEffect(() => {
    const reset = window.setTimeout(() => {
      setLedgerPage(null)
      setLedgerBeforeSequence('')
      setLedgerCursorHistory([])
      setDialogueSearchQuery('')
      setDialogueSearchMatches([])
      setDialogueSearchOpen(false)
      setDialogueSearchSubmitted(false)
    }, 0)
    return () => window.clearTimeout(reset)
  }, [selectedContextId])

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      dispatchModelStream({ type: 'reset_session', sessionId: selectedSessionId })
      eventHistoryCursorRef.current = { sessionId: '', nextBeforeSequence: null }
      locatingDialogueSearchEvent.current = ''
      setEventHistoryCursor(null)
      setLoadingOlderEvents(false)
      setMessageWindow(freshMessageWindow(selectedSessionId))
      setEventsSessionId('')
      setLatestContextInspect(null)
      setContextView(null)
      setContextEncoding(null)
      setContextOverview(current => current?.active_session_id === selectedSessionId ? current : null)
      setContextInspectTab('encoding')
      setContextInspectCopied(false)
      setSexprReader(null)
      setSchedulerHistoryLimit(SCHEDULER_HISTORY_PAGE_SIZE)
      setExpandedDialogueThreadId('')
      setDialogueThreadDetail(null)
    }, 0)
    return () => window.clearTimeout(resetTimer)
  }, [selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId || !selectedContextId) return
    if (view === 'overview' && !route.contextId) return
    const initial = window.setTimeout(() => void loadSession(selectedSessionId, selectedContextId), 0)
    const interval = window.setInterval(() => void loadSession(selectedSessionId, selectedContextId), 15000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [loadSession, route.contextId, schedulerHistoryLimit, selectedContextId, selectedSessionId, view])

  useEffect(() => {
    if (!selectedContextId || selectedSessionId) return
    if (view === 'overview' && !route.contextId) return
    const initial = window.setTimeout(() => void loadOverview(selectedContextId, ''), 0)
    const interval = window.setInterval(() => void loadOverview(selectedContextId, ''), 15000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [loadOverview, route.contextId, selectedContextId, selectedSessionId, view])

  useEffect(() => {
    if (view !== 'overview' || route.contextId) return
    const initial = window.setTimeout(() => void loadRuntimeOverview(), 0)
    const interval = window.setInterval(() => void loadRuntimeOverview(), 10_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [loadRuntimeOverview, route.contextId, view])

  useEffect(() => {
    if (view === 'overview' && !route.contextId) return
    const contextId = selectedContextId
    const timer = window.setTimeout(() => void loadContextTokenBudget(contextId), 0)
    return () => window.clearTimeout(timer)
  }, [loadContextTokenBudget, route.contextId, selectedContextId, status?.model, view])

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
    if (view !== 'cognition' || cognitionView !== 'prompt') return
    const timer = window.setTimeout(() => void loadSystemPrompt(), 0)
    return () => window.clearTimeout(timer)
  }, [cognitionView, loadSystemPrompt, view])

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
      if (invalidated.includes('catalog')) void loadCatalog()
      const refreshesSession = invalidated.includes('session')
      if (refreshesSession) void loadSession(selectedSessionId, selectedContextId)
      if (!refreshesSession && invalidated.includes('overview')) {
        void loadOverview(selectedContextId, selectedSessionId)
      }
      if (activeViewRef.current === 'overview' && !route.contextId && invalidated.includes('overview')) {
        void loadRuntimeOverview()
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
    loadCatalog,
    loadMindTransactions,
    loadOverview,
    loadRuntimeOverview,
    loadContextProjection,
    loadSession,
    loadThreadDetail,
    route.contextId,
    route.threadId,
    selectedContextId,
    selectedSessionId,
    view,
  ])

  useEffect(() => {
    if (!selectedSessionId) return
    if (view === 'overview' && !route.contextId) return
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
      if (observesExactModelRequests(view, cognitionView)) {
        params.set('observe_model_requests', 'true')
      }
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
                    threadId: typeof item.thread_id === 'string' ? item.thread_id : undefined,
                    rootTurnId: typeof item.root_turn_id === 'string' ? item.root_turn_id : undefined,
                    objectiveId: typeof item.objective_id === 'string' ? item.objective_id : undefined,
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
                  threadId: typeof event.payload.thread_id === 'string' ? event.payload.thread_id : undefined,
                  rootTurnId: typeof event.payload.root_turn_id === 'string' ? event.payload.root_turn_id : undefined,
                  objectiveId: typeof event.payload.objective_id === 'string' ? event.payload.objective_id : undefined,
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
              queueStreamEvent({
                attemptId,
                activationId,
                threadKind,
                threadId: typeof event.payload.thread_id === 'string' ? event.payload.thread_id : undefined,
                rootTurnId: typeof event.payload.root_turn_id === 'string' ? event.payload.root_turn_id : undefined,
                objectiveId: typeof event.payload.objective_id === 'string' ? event.payload.objective_id : undefined,
                timestamp: event.timestamp,
                stream,
              })
            }
            return
          }
          if (event.topic === 'runtime/model_request_snapshot') {
            // Exact physical input is process-local observability: retain only
            // the selected Session's latest request in browser memory. The
            // Ledger stores bounded ModelAttempt metadata, not another Prompt.
            if (typeof event.payload.text === 'string') setLatestContextInspect(event)
            return
          }
          setEventsSessionId(selectedSessionId)
          setEvents(previous => {
            if (previous.some(item => item.id === event.id)) return previous
            // Server-paged history is part of the current read model. Never
            // discard it when a live Event arrives; the Event Ledger cursor,
            // not an arbitrary browser cap, owns the history boundary.
            return mergeSessionEvents(previous, [event])
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
  }, [cognitionView, loadSession, route.contextId, selectedContextId, selectedSessionId, t, view])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        setView(current => current === 'scheduler' ? 'dialogue' : 'scheduler')
      } else if (event.ctrlKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        setView(current => current === 'cognition' ? 'dialogue' : 'cognition')
      } else if (event.key === 'Escape') {
        if (immersiveMode) {
          event.preventDefault()
          setImmersiveMode(false)
          return
        }
        setView('dialogue')
        setContextMenuOpen(false)
        setSessionMenuOpen(false)
        setConversationSessionMenuOpen(false)
        setPrincipalMenuOpen(false)
        setThemeMenuOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [immersiveMode, setImmersiveMode, setView])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (contextMenuOpen && contextSelectorRef.current && !contextSelectorRef.current.contains(target)) {
        setContextMenuOpen(false)
      }
      if (sessionMenuOpen && sessionSelectorRef.current && !sessionSelectorRef.current.contains(target)) {
        setSessionMenuOpen(false)
      }
      if (conversationSessionMenuOpen
        && conversationSessionSelectorRef.current
        && !conversationSessionSelectorRef.current.contains(target)) {
        setConversationSessionMenuOpen(false)
      }
      if (principalMenuOpen
        && principalSelectorRef.current
        && !principalSelectorRef.current.contains(target)) {
        setPrincipalMenuOpen(false)
      }
      if (themeMenuOpen && themeSelectorRef.current && !themeSelectorRef.current.contains(target)) {
        setThemeMenuOpen(false)
      }
      if (contextTokenBudgetOpen
        && contextTokenBudgetRef.current
        && !contextTokenBudgetRef.current.contains(target)) {
        setContextTokenBudgetOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [
    contextMenuOpen,
    contextTokenBudgetOpen,
    conversationSessionMenuOpen,
    principalMenuOpen,
    sessionMenuOpen,
    themeMenuOpen,
  ])

  const selectedSession = sessions.find(item => item.id === selectedSessionId)
  const selectedContext = contexts.find(item => item.id === selectedContextId)
  const selectedAgent = agents.find(item => item.id === selectedAgentId)
  const parsedContextTokenBudgetDraft = contextTokenBudgetDraft.trim() === ''
    ? null
    : Number(contextTokenBudgetDraft)
  const contextTokenBudgetDraftValid = parsedContextTokenBudgetDraft === null
    || (Number.isSafeInteger(parsedContextTokenBudgetDraft) && parsedContextTokenBudgetDraft > 0)
  const contextTokenBudgetChanged = contextTokenBudgetDraftValid
    && parsedContextTokenBudgetDraft !== (contextTokenBudget?.requested_hard_token_limit ?? null)
  const parsedModelPromptTokenLimitDraft = Number(modelPromptTokenLimitDraft)
  const modelPromptTokenLimitDraftValid = Number.isSafeInteger(parsedModelPromptTokenLimitDraft)
    && parsedModelPromptTokenLimitDraft > 0
  const modelPromptTokenLimitChanged = modelPromptTokenLimitDraftValid
    && parsedModelPromptTokenLimitDraft !== contextTokenBudget?.physical_prompt_token_limit
  const contextTokenBudgetSliderMax = Math.max(
    1_024,
    contextTokenBudget?.physical_prompt_token_limit ?? 1_024,
    contextTokenBudget?.requested_hard_token_limit ?? 0,
    parsedContextTokenBudgetDraft ?? 0,
  )
  const contextTokenBudgetSliderValue = Math.min(
    contextTokenBudgetSliderMax,
    parsedContextTokenBudgetDraft ?? contextTokenBudget?.effective_hard_token_limit ?? 1_024,
  )
  const contextTokenBudgetPresets = [64_000, 128_000, 256_000, 512_000, 1_000_000]
    .filter(value => value <= contextTokenBudgetSliderMax)
  const visibleContexts = contexts
    .filter(item => item.agent_id === selectedAgentId && item.status === 'active')
    .sort((left, right) => left.title.localeCompare(right.title))
  const visibleContextCount = visibleContexts.length
  const agentContextIds = delegatedContextIds(
    delegations,
    visibleContexts.map(context => context.id),
  )
  const userVisibleContexts = visibleContexts.filter(context => !agentContextIds.has(context.id))
  const agentVisibleContexts = visibleContexts.filter(context => agentContextIds.has(context.id))
  const visibleSessions = sessions
    .filter(item => item.context_id === selectedContextId && item.status === 'active')
    .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))
  const executionTargetNames = useMemo(
    () => new Map(executionTargets.map(target => [target.id, target.name] as const)),
    [executionTargets],
  )
  const sessionEvents = useMemo(
    () => eventsSessionId === selectedSessionId ? events : [],
    [events, eventsSessionId, selectedSessionId],
  )
  const liveModelAttempts = visibleLiveModelAttempts(liveModelState, selectedSessionId)
  const schedulerThreads = useMemo(
    () => schedulerSnapshot?.threads ?? [],
    [schedulerSnapshot],
  )
  const queuedUserInputEventIds = useMemo(() => {
    const eventIds = new Set<string>()
    const collectPending = (signals: ThreadSignalRecord[]) => {
      for (const signal of signals) {
        if (signal.kind === 'chat/user_message' && signal.status === 'pending') {
          eventIds.add(signal.event_id)
        }
      }
    }
    const collectActivation = (snapshot: SchedulerSnapshot['orphan_activations'][number]) => {
      if (snapshot.activation.status !== 'queued') return
      for (const signal of snapshot.signals) {
        if (signal.kind === 'chat/user_message') eventIds.add(signal.event_id)
      }
    }
    for (const snapshot of schedulerThreads) {
      collectPending(snapshot.pending_signals)
      for (const activation of snapshot.activations) collectActivation(activation)
    }
    for (const signal of schedulerSnapshot?.orphan_signals ?? []) {
      if (signal.kind === 'chat/user_message' && signal.status !== 'acknowledged') {
        eventIds.add(signal.event_id)
      }
    }
    for (const activation of schedulerSnapshot?.orphan_activations ?? []) {
      collectActivation(activation)
    }
    return eventIds
  }, [schedulerSnapshot?.orphan_activations, schedulerSnapshot?.orphan_signals, schedulerThreads])
  const objectives = useMemo(
    () => contextOverview?.objectives ?? contextView?.objectives ?? [],
    [contextOverview?.objectives, contextView?.objectives],
  )
  const selectedObjectiveFilterId = requestedObjectiveFilterId
    && objectives.some(objective => objective.id === requestedObjectiveFilterId)
    ? requestedObjectiveFilterId
    : ''
  const durableThreadGroups = useMemo(
    () => schedulerSnapshot?.thread_groups ?? [],
    [schedulerSnapshot?.thread_groups],
  )
  const selectedThreadGroupFilterId = requestedThreadGroupFilterId
    && durableThreadGroups.some(snapshot => snapshot.group.id === requestedThreadGroupFilterId)
    ? requestedThreadGroupFilterId
    : ''
  const selectedThreadGroupMemberIds = useMemo(
    () => new Set(
      durableThreadGroups
        .find(snapshot => snapshot.group.id === selectedThreadGroupFilterId)
        ?.members.map(member => member.thread_id) ?? [],
    ),
    [durableThreadGroups, selectedThreadGroupFilterId],
  )
  const selectedSupervisorFilterId = requestedSupervisorFilterId
    && schedulerThreads.some(snapshot => snapshot.thread.supervision.supervisor_id === requestedSupervisorFilterId)
    ? requestedSupervisorFilterId
    : ''
  const objectiveLineage = useMemo<ObjectiveLineageIndex>(
    () => buildObjectiveLineageIndex(
      schedulerThreads.map(snapshot => ({
        id: snapshot.thread.id,
        root_turn_id: snapshot.thread.root_turn_id,
        activations: snapshot.activations.map(item => item.activation),
      })),
      sessionEvents,
    ),
    [schedulerThreads, sessionEvents],
  )
  const lineageForLiveAttempt = useCallback((attempt: LiveModelAttempt) => (
    objectiveLineage.forLiveRoute({
      activationId: attempt.activationId,
      threadId: attempt.threadId,
      rootTurnId: attempt.rootTurnId,
      objectiveId: attempt.objectiveId,
    })
  ), [objectiveLineage])
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
  const messageWindowForSession = messageWindow.sessionId === selectedSessionId
    ? messageWindow
    : freshMessageWindow(selectedSessionId)
  const conversationEventsForObjective = useMemo(
    () => selectedObjectiveFilterId
      ? conversationEvents.filter(event => objectiveLineage.forEvent(event).objectiveIds.includes(selectedObjectiveFilterId))
      : conversationEvents,
    [conversationEvents, objectiveLineage, selectedObjectiveFilterId],
  )
  const dialogueEventsForObjective = useMemo(
    () => conversationEventsForObjective.filter(event => conversationEventLane(event.topic, event.payload) === 'dialogue'),
    [conversationEventsForObjective],
  )
  const executionEventsForObjective = useMemo(
    () => conversationEventsForObjective.filter(event => conversationEventLane(event.topic, event.payload) === 'execution_output'),
    [conversationEventsForObjective],
  )
  // Split lanes are independent presentation surfaces. Each receives a full
  // window so high-volume tool calls cannot evict dialogue (or vice versa).
  const visibleMergedEvents = useMemo(
    () => newestConversationEventsForLane(conversationEventsForObjective, 'merged', messageWindowForSession.merged),
    [conversationEventsForObjective, messageWindowForSession.merged],
  )
  const visibleDialogueEvents = useMemo(
    () => conversationLayout === 'split'
      ? newestConversationEventsForLane(conversationEventsForObjective, 'dialogue', messageWindowForSession.dialogue)
      : visibleMergedEvents,
    [conversationEventsForObjective, conversationLayout, messageWindowForSession.dialogue, visibleMergedEvents],
  )
  const visibleExecutionOutputEvents = useMemo(
    () => conversationLayout === 'split'
      ? newestConversationEventsForLane(conversationEventsForObjective, 'execution_output', messageWindowForSession.execution_output)
      : [],
    [conversationEventsForObjective, conversationLayout, messageWindowForSession.execution_output],
  )
  const visibleEventsForObjective = useMemo(
    () => conversationLayout === 'split'
      ? mergeSessionEvents(visibleDialogueEvents, visibleExecutionOutputEvents)
      : visibleMergedEvents,
    [conversationLayout, visibleDialogueEvents, visibleExecutionOutputEvents, visibleMergedEvents],
  )
  const hiddenEventCounts = useMemo<Record<ConversationWindowLane, number>>(() => ({
    merged: Math.max(0, conversationEventsForObjective.length - visibleMergedEvents.length),
    dialogue: Math.max(0, dialogueEventsForObjective.length - visibleDialogueEvents.length),
    execution_output: Math.max(0, executionEventsForObjective.length - visibleExecutionOutputEvents.length),
  }), [
    conversationEventsForObjective.length,
    dialogueEventsForObjective.length,
    executionEventsForObjective.length,
    visibleDialogueEvents.length,
    visibleExecutionOutputEvents.length,
    visibleMergedEvents.length,
  ])
  const dialogueHistoryLane: 'merged' | 'dialogue' = conversationLayout === 'split' ? 'dialogue' : 'merged'
  const dialogueHiddenEventCount = hiddenEventCounts[dialogueHistoryLane]
  const executionHiddenEventCount = hiddenEventCounts.execution_output

  useEffect(() => {
    const hit = pendingDialogueSearchHit
    if (!hit || hit.session_id !== selectedSessionId || eventsSessionId !== selectedSessionId) return

    const hitEvent = conversationEvents.find(event => event.id === hit.event_id)
    if (hitEvent) {
      const hitLane: ConversationWindowLane = conversationLayout === 'split'
        ? conversationEventLane(hitEvent.topic, hitEvent.payload) === 'execution_output'
          ? 'execution_output'
          : 'dialogue'
        : 'merged'
      const laneEvents = hitLane === 'execution_output'
        ? executionEventsForObjective
        : hitLane === 'dialogue'
          ? dialogueEventsForObjective
          : conversationEventsForObjective
      const eventIndex = laneEvents.findIndex(event => event.id === hit.event_id)
      const requiredCount = eventIndex >= 0 ? laneEvents.length - eventIndex : MESSAGE_PAGE_SIZE
      if (messageWindowForSession[hitLane] < requiredCount) {
        const revealFrame = window.requestAnimationFrame(() => {
          setMessageWindow(current => ({
            ...(current.sessionId === selectedSessionId ? current : freshMessageWindow(selectedSessionId)),
            [hitLane]: requiredCount,
          }))
        })
        return () => window.cancelAnimationFrame(revealFrame)
      }
      const firstFrame = window.requestAnimationFrame(() => {
        if (conversationLayout === 'split') {
          setConversationMobileLane(conversationEventLane(hitEvent.topic, hitEvent.payload) === 'execution_output'
            ? 'execution'
            : 'dialogue')
        }
        window.requestAnimationFrame(() => {
          const target = Array.from(document.querySelectorAll<HTMLElement>('[data-event-id]'))
            .find(node => node.dataset.eventId === hit.event_id)
          if (!target) return
          conversationPinnedToEnd.current = false
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setPendingDialogueSearchHit(null)
        })
      })
      return () => window.cancelAnimationFrame(firstFrame)
    }

    if (hit.sequence === undefined || locatingDialogueSearchEvent.current === hit.event_id) return
    locatingDialogueSearchEvent.current = hit.event_id
    let cancelled = false
    void DASHBOARD_API.get<SessionEventsPage>(scopedSessionReadPath(
      `/api/sessions/${encodeURIComponent(selectedSessionId)}/events?conversation_only=true&before_sequence=${hit.sequence + 1}&limit=100`,
      principalScopeRef.current?.principal.id,
    )).then(page => {
      if (cancelled || selectedScopeRef.current.sessionId !== selectedSessionId) return
      if (!page.events.some(event => event.id === hit.event_id)) {
        setPendingDialogueSearchHit(null)
        setError(t('conversation.search.messageUnavailable'))
        return
      }
      setEvents(previous => mergeSessionEvents(previous, page.events))
      setEventsSessionId(selectedSessionId)
      setError('')
    }).catch(reason => {
      if (!cancelled) {
        setPendingDialogueSearchHit(null)
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (locatingDialogueSearchEvent.current === hit.event_id) locatingDialogueSearchEvent.current = ''
    })
    return () => { cancelled = true }
  }, [
    conversationEvents,
    conversationEventsForObjective,
    conversationLayout,
    dialogueEventsForObjective,
    eventsSessionId,
    executionEventsForObjective,
    messageWindowForSession,
    pendingDialogueSearchHit,
    selectedSessionId,
    t,
  ])

  const visibleReasoningSummaries = useMemo(() => {
    const byEventId = new Map<string, string>()
    for (const event of visibleEventsForObjective) {
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
  }, [durableReasoningSummaries, reasoningContinuationSummaries, visibleEventsForObjective])
  const streamingAttempts = useMemo(
    () => Object.values(liveModelAttempts)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    [liveModelAttempts],
  )
  const visibleStreamingAttempts = useMemo(
    () => selectedObjectiveFilterId
      ? streamingAttempts.filter(attempt => lineageForLiveAttempt(attempt).objectiveIds.includes(selectedObjectiveFilterId))
      : streamingAttempts,
    [lineageForLiveAttempt, selectedObjectiveFilterId, streamingAttempts],
  )
  const conversationStreamingAttempts = useMemo(
    // Dialogue and Delivery evaluations terminate in a user-visible reply.
    // Execution evaluations, including Objective-supervised work, render in
    // the execution lane so control-plane ownership never invents a new kind.
    () => visibleStreamingAttempts.filter(attempt => ['dialogue_turn', 'delivery'].includes(attempt.threadKind)),
    [visibleStreamingAttempts],
  )
  const dialogueStreamingAttempts = useMemo(
    () => conversationLayout === 'split'
      ? conversationStreamingAttempts.filter(attempt => attempt.threadKind === 'dialogue_turn')
      : conversationStreamingAttempts,
    [conversationLayout, conversationStreamingAttempts],
  )
  const executionOutputStreamingAttempts = useMemo(
    () => conversationLayout === 'split'
      ? visibleStreamingAttempts.filter(attempt => attempt.threadKind !== 'dialogue_turn')
      : [],
    [conversationLayout, visibleStreamingAttempts],
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
    return buildToolTimeline(sessionEvents)
  }, [sessionEvents])
  const toolTimelineById = useMemo(
    () => new Map(toolTimeline.map(call => [call.id, call])),
    [toolTimeline],
  )
  const activeObjectives = objectives.filter(item => !terminalObjectiveStatuses.has(item.status))
  const runningObjectives = activeObjectives.filter(item => item.status === 'active')
  const blockedObjectives = activeObjectives.filter(item => item.status === 'blocked')
  const waitingUserObjectives = runningObjectives.filter(item => item.wait_condition?.kind === 'user_input')
  const acknowledgedAttentionKeys = useMemo(
    () => new Set(
      attentionAcknowledgements
        .filter(item => item.context_id === selectedContextId)
        .map(item => item.key),
    ),
    [attentionAcknowledgements, selectedContextId],
  )
  const dialogueActivityObjectives = activeObjectives
    .filter(objective => !dialogueCurrentSessionOnly
      || objective.coordinator_session_id === selectedSessionId
      || objective.delivery_session_id === selectedSessionId)
    .sort((left, right) => {
    const leftCurrent = left.coordinator_session_id === selectedSessionId || left.delivery_session_id === selectedSessionId
    const rightCurrent = right.coordinator_session_id === selectedSessionId || right.delivery_session_id === selectedSessionId
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
    return right.updated_at.localeCompare(left.updated_at)
  })
  const { dialogueActivityThreads, dialogueActivityHistoryThreads } = useMemo(() => {
    const phaseRank: Record<SchedulerThreadSnapshot['phase'], number> = { running: 0, runnable: 1, waiting: 2, idle: 3 }
    const executionBearingThreads = schedulerThreads.filter(snapshot => {
      if (!threadCarriesExecution(snapshot)) return false
      if (dialogueCurrentSessionOnly && snapshot.thread.session_id !== selectedSessionId) return false
      return !selectedObjectiveFilterId
        || (objectiveLineage.objectiveIdsByThread.get(snapshot.thread.id) ?? []).includes(selectedObjectiveFilterId)
    })
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
  }, [dialogueCurrentSessionOnly, objectiveLineage, schedulerThreads, selectedObjectiveFilterId, selectedSessionId])
  const showDialogueActivity = Boolean(selectedContextId && selectedSessionId)
  // A completed Objective/Thread can disappear from the live activity
  // projection while its durable messages remain on screen. Keep those causal
  // ids in the palette candidate set so historical results do not lose their
  // colour as soon as execution settles.
  const visibleTintLineages = visibleEventsForObjective.map(event => objectiveLineage.forEvent(event))
  const streamingTintLineages = visibleStreamingAttempts.map(lineageForLiveAttempt)
  const tintCandidateIds = [...new Set(tintDimension === 'thread'
    ? [
        ...dialogueActivityThreads.map(snapshot => snapshot.thread.id),
        ...visibleTintLineages.flatMap(lineage => lineage.threadIds),
        ...streamingTintLineages.flatMap(lineage => lineage.threadIds),
      ]
    : [
        ...dialogueActivityObjectives.map(objective => objective.id),
        ...visibleTintLineages.flatMap(lineage => lineage.objectiveIds),
        ...streamingTintLineages.flatMap(lineage => lineage.objectiveIds),
      ])]
  // Slot history has to survive re-renders for a colour to stay put, and the
  // key makes that history explicit rather than hiding it in a ref that is
  // read while rendering.
  const tintCandidateKey = tintCandidateIds.join('\u0000')
  const [tintSlotState, setTintSlotState] = useState<{
    key: string
    slots: ReadonlyMap<string, number>
  }>(() => ({ key: '', slots: new Map() }))
  const tintSlots = tintSlotState.key === tintCandidateKey
    ? tintSlotState.slots
    : assignTintSlots(tintCandidateIds, tintSlotState.slots)
  if (tintSlotState.key !== tintCandidateKey) {
    setTintSlotState({ key: tintCandidateKey, slots: tintSlots })
  }
  const tintStyleFor: TintStyleResolver = id => {
    if (!objectiveTintEnabled || !id) return undefined
    const tone = toneForSlot(tintSlots.get(id))
    return tone ? ({ '--objective-color': tone.color } as CSSProperties) : undefined
  }
  const tintStyleForLineage = (lineage: CausalLineage) =>
    tintStyleFor(tintIdForLineage(lineage, tintDimension))
  const handleObjectiveTintChange = (enabled: boolean) => {
    // The automatic pick runs only as tinting is switched on. Re-deciding
    // while the operator reads would remap every colour underneath them.
    if (enabled && !tintDimensionChosen) {
      setTintDimension(autoTintDimension(
        dialogueActivityObjectives.length,
        dialogueActivityThreads.length,
      ))
    }
    setObjectiveTintEnabled(enabled)
  }
  const handleTintDimensionChange = (dimension: TintDimension) => {
    setTintDimension(dimension)
    setTintDimensionChosen(true)
  }
  const handleDialogueCurrentSessionOnlyChange = (enabled: boolean) => {
    if (enabled && selectedObjectiveFilterId) {
      const selectedObjective = objectives.find(objective => objective.id === selectedObjectiveFilterId)
      const belongsToCurrentSession = selectedObjective
        && (selectedObjective.coordinator_session_id === selectedSessionId
          || selectedObjective.delivery_session_id === selectedSessionId)
      if (!belongsToCurrentSession) setSelectedObjectiveFilterId('')
    }
    setDialogueCurrentSessionOnly(enabled)
  }
  const visibleSchedulerThreads = useMemo(() => {
    const filtered = schedulerThreads.filter(snapshot => (
      (!selectedObjectiveFilterId
        || (objectiveLineage.objectiveIdsByThread.get(snapshot.thread.id) ?? []).includes(selectedObjectiveFilterId))
      && (!selectedThreadGroupFilterId || selectedThreadGroupMemberIds.has(snapshot.thread.id))
      && (!selectedSupervisorFilterId || snapshot.thread.supervision.supervisor_id === selectedSupervisorFilterId)
    ))
    const active = filtered.filter(snapshot => snapshot.phase !== 'idle')
    const activeIds = new Set(active.map(snapshot => snapshot.thread.id))
    const recentHistory = filtered
      .filter(snapshot => !activeIds.has(snapshot.thread.id))
      .sort((left, right) => right.thread.updated_at.localeCompare(left.thread.updated_at))
      .slice(0, WORK_HISTORY_THREAD_LIMIT)
    return [...active, ...recentHistory]
  }, [objectiveLineage, schedulerThreads, selectedObjectiveFilterId, selectedSupervisorFilterId, selectedThreadGroupFilterId, selectedThreadGroupMemberIds])
  const schedulerFilteredThreadCount = schedulerThreads.filter(snapshot => (
    (!selectedObjectiveFilterId
      || (objectiveLineage.objectiveIdsByThread.get(snapshot.thread.id) ?? []).includes(selectedObjectiveFilterId))
    && (!selectedThreadGroupFilterId || selectedThreadGroupMemberIds.has(snapshot.thread.id))
    && (!selectedSupervisorFilterId || snapshot.thread.supervision.supervisor_id === selectedSupervisorFilterId)
  )).length
  const hiddenSchedulerThreadCount = schedulerFilteredThreadCount - visibleSchedulerThreads.length
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
          job.job.status === 'lost'
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
      else if (snapshot.thread.control_state === 'paused' || snapshot.phase === 'waiting') groups.waiting.push(snapshot)
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
  // Terminal Schedule history remains available inside each causal Thread;
  // this board and the composer status describe only present control state.
  const schedules = currentSchedulerSchedules(schedulerSnapshot)
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
    + waitingUserObjectives.length
  const contextDelegations = delegations.filter(item => item.parent_context_id === selectedContextId)
  const liveDelegations = contextDelegations.filter(item => !terminalTaskStatuses.has(item.status))
  const runningDelegations = liveDelegations.filter(item => item.status === 'queued' || item.status === 'running')
  const dialogueActivityDelegations = liveDelegations
    .filter(item => !dialogueCurrentSessionOnly
      || item.parent_session_id === selectedSessionId
      || item.child_session_id === selectedSessionId)
    .sort((left, right) => {
    const leftCurrent = left.parent_session_id === selectedSessionId
    const rightCurrent = right.parent_session_id === selectedSessionId
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
    return right.updated_at.localeCompare(left.updated_at)
  })
  const activeWorkCount = schedulerSnapshot
    ? schedulerSnapshot.summary.running_activations + schedulerSnapshot.summary.queued_activations
    : 0
  const waitingCount = schedulerSnapshot
    ? schedulerThreads.filter(item => item.phase === 'waiting').length
    : runningObjectives.filter(item => Boolean(item.wait_condition)).length
  const composerThreads = schedulerThreads.filter(item => item.thread.session_id === selectedSessionId)
  const composerActivations = composerThreads
    .filter(item => item.phase !== 'idle' && item.thread.lifecycle === 'open')
    .flatMap(item => item.activations)
    .map(item => item.activation)
    .filter(activation => activation.status === 'queued' || activation.status === 'running')
  const composerJobs = actionableJobRows.filter(item => item.job.session_id === selectedSessionId)
  const composerPendingApprovals = composerJobs
    .flatMap(item => item.approval ? [item.approval] : [])
    .filter(approval => approval.status === 'pending_human')
  const composerDialogueCount = composerThreads.reduce((count, item) => {
    if (item.phase === 'idle' || item.thread.lifecycle !== 'open' || item.thread.kind !== 'dialogue_turn') return count
    return count + item.activations.filter(activation => (
      activation.activation.status === 'queued' || activation.activation.status === 'running'
    )).length
  }, 0)
  const composerExecutionCount = composerJobs.filter(item => (
    item.job.status === 'queued'
    || item.job.status === 'waiting_approval'
    || item.job.status === 'running'
  )).length
  const composerWaitingCount = composerThreads.filter(item => item.phase === 'waiting').length
  const composerObjectives = activeObjectives.filter(objective => (
    objective.coordinator_session_id === selectedSessionId
    || objective.delivery_session_id === selectedSessionId
  ))
  const composerRunningObjectives = composerObjectives.filter(item => item.status === 'active')
  const composerBlockedObjectives = composerObjectives.filter(item => item.status === 'blocked')
  const composerPausedObjectives = composerObjectives.filter(item => item.status === 'paused')
  const composerWaitingUserObjectives = composerRunningObjectives
    .filter(item => item.wait_condition?.kind === 'user_input')
  const composerSchedules = composerThreads
    .flatMap(item => item.schedules)
    .filter(schedule => schedule.status === 'queued' || schedule.status === 'paused')
  const activePrincipalId = principalScope?.principal.id
    ?? contextView?.active_principal_id
    ?? contextOverview?.sessions.find(session => session.session.id === selectedSessionId)?.principal_ids?.[0]
    ?? contextView?.sessions.find(session => session.session.id === selectedSessionId)?.principal_ids?.[0]
    ?? status?.principal_id
  const observingForeignPrincipal = Boolean(principalScope)
  const selectedFrameLineage = frameLineage?.root_frame_id === effectiveSelectedFrameId ? frameLineage : null
  const retiring = contextView?.state.retiring ?? {}
  const selectedFrame = visibleFrames.find(frame => frame.id === effectiveSelectedFrameId)
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
    const pending = pendingScrollRestore.current
    if (pending === null) return
    const container = pending.lane === 'execution_output'
      ? executionOutputLaneRef.current
      : pending.lane === 'dialogue'
        ? conversationLaneRef.current
        : viewFrameRef.current
    pendingScrollRestore.current = null
    if (container) container.scrollTop += container.scrollHeight - pending.previousHeight
    loadingOlder.current = false
    setLoadingOlderEvents(false)
  }, [
    conversationLayout,
    messageWindow.dialogue,
    messageWindow.execution_output,
    messageWindow.merged,
  ])

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
    if (view !== 'dialogue' || typeof ResizeObserver === 'undefined') return

    // Streaming Markdown, reasoning blocks, tables, and images can grow without
    // changing the event count. This includes the empty initial stream card:
    // causal badges can make it taller before its first text delta arrives.
    // Observe the actual content in both merged and split layouts so the latest
    // status remains above the composer while the user is following the end.
    const conversationObserver = new ResizeObserver(() => {
      const container = conversationLayout === 'split'
        ? conversationLaneRef.current
        : viewFrameRef.current
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
    if (conversationLayout === 'split' && executionOutputListRef.current) {
      executionObserver.observe(executionOutputListRef.current)
    }
    return () => {
      conversationObserver.disconnect()
      executionObserver.disconnect()
    }
  }, [conversationLayout, selectedSessionId, view])

  const loadOlderConversationEvents = useCallback(async (
    lane: ConversationWindowLane,
    container: HTMLDivElement,
  ) => {
    if (!selectedSessionId || loadingOlder.current) return

    loadingOlder.current = true
    setLoadingOlderEvents(true)
    pendingScrollRestore.current = { lane, previousHeight: container.scrollHeight }

    // First reveal lane-local items already resident in the browser. Once that
    // lane is exhausted, continue from the shared durable Ledger cursor.
    if (hiddenEventCounts[lane] > 0) {
      const availableCount = lane === 'merged'
        ? conversationEventsForObjective.length
        : lane === 'dialogue'
          ? dialogueEventsForObjective.length
          : executionEventsForObjective.length
      setMessageWindow(current => {
        const base = current.sessionId === selectedSessionId ? current : freshMessageWindow(selectedSessionId)
        return {
          ...base,
          [lane]: Math.min(base[lane] + MESSAGE_PAGE_SIZE, availableCount),
        }
      })
      return
    }

    const cursorState = eventHistoryCursorRef.current
    if (cursorState.sessionId !== selectedSessionId || cursorState.nextBeforeSequence === null) {
      pendingScrollRestore.current = null
      loadingOlder.current = false
      setLoadingOlderEvents(false)
      return
    }

    try {
      const page = await DASHBOARD_API.get<SessionEventsPage>(scopedSessionReadPath(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/events?conversation_only=true&before_sequence=${cursorState.nextBeforeSequence}&limit=1000`,
        principalScopeRef.current?.principal.id,
      ))
      if (selectedScopeRef.current.sessionId !== selectedSessionId) return

      const existingIds = new Set(sessionEvents.map(event => event.id))
      const newlyLoadedMessages = page.events.filter(event => {
        if (existingIds.has(event.id) || eventKind(event) === null) return false
        return lane === 'merged' || conversationEventLane(event.topic, event.payload) === lane
      }).length
      const nextCursor = page.next_before_sequence ?? null
      eventHistoryCursorRef.current = { sessionId: selectedSessionId, nextBeforeSequence: nextCursor }
      setEventHistoryCursor(nextCursor)
      setEvents(previous => mergeSessionEvents(previous, page.events))
      setEventsSessionId(selectedSessionId)

      if (newlyLoadedMessages > 0) {
        setMessageWindow(current => {
          const base = current.sessionId === selectedSessionId ? current : freshMessageWindow(selectedSessionId)
          return { ...base, [lane]: base[lane] + newlyLoadedMessages }
        })
      } else {
        pendingScrollRestore.current = null
        loadingOlder.current = false
        setLoadingOlderEvents(false)
      }
      setError('')
    } catch (reason) {
      pendingScrollRestore.current = null
      loadingOlder.current = false
      setLoadingOlderEvents(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [
    conversationEventsForObjective.length,
    dialogueEventsForObjective.length,
    executionEventsForObjective.length,
    hiddenEventCounts,
    selectedSessionId,
    sessionEvents,
  ])

  const handleConversationScroll = useCallback((
    lane: 'merged' | 'dialogue',
    container: HTMLDivElement,
  ) => {
    // Ignore the scroll events fired by our own programmatic scrolling;
    // content growth between the scroll and the event would otherwise look
    // like the user scrolled away from the bottom.
    if (Date.now() - lastProgrammaticScroll.current < 120) return
    conversationPinnedToEnd.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48
    if (container.scrollTop < 80) {
      void loadOlderConversationEvents(lane, container)
    }
  }, [loadOlderConversationEvents])

  const handleExecutionOutputScroll = useCallback((container: HTMLDivElement) => {
    if (Date.now() - lastExecutionProgrammaticScroll.current < 120) return
    executionOutputPinnedToEnd.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48
    if (container.scrollTop < 80) {
      void loadOlderConversationEvents('execution_output', container)
    }
  }, [loadOlderConversationEvents])

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
      const context = await DASHBOARD_API.command<ContextRecord>('/api/contexts', 'POST', {
        agent_id: agentId,
        title: t('header.newContextTitle', { count: visibleContextCount + 1 }),
      })
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
  }, [activateContext, agents, creatingContext, selectedAgentId, status?.agent_id, t, visibleContextCount])

  const createSession = useCallback(async (targetContext?: ContextRecord): Promise<SessionRecord | null> => {
    if (creatingSession) return null
    if (principalScopeRef.current) {
      setError(t('header.principalScopeReadOnly'))
      return null
    }
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
      const session = await DASHBOARD_API.command<SessionRecord>('/api/sessions', 'POST', {
          agent_id: agentId,
          title: t('header.newSessionTitle', { count: count + 1 }),
          mount: { type: 'existing_context', context_id: contextId },
      })
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
  }, [creatingSession, navigate, selectedAgentId, selectedContext, selectedContextId, sessions, status?.agent_id, t])

  const chooseSession = (session: SessionRecord) => {
    if (session.id !== selectedSessionId) {
      setPendingTurn(null)
    }
    setSelectedAgentId(session.agent_id)
    setFrameLineage(null)
    setSelectedContextId(session.context_id)
    setSelectedSessionId(session.id)
    setSessionMenuOpen(false)
    setConversationSessionMenuOpen(false)
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
    if (principalScopeRef.current) {
      setError(t('header.principalScopeReadOnly'))
      return
    }
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
    if (principalScopeRef.current) {
      setError(t('header.principalScopeReadOnly'))
      return
    }
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
    const quoteId = `quote-${Date.now()}-${Math.random().toString(16).slice(2)}`
    setQuotes(prev => [...prev, {
      id: quoteId,
      text: popup.text,
      eventId: popup.eventId,
      eventActor: popup.eventActor,
      eventTime: popup.eventTime,
      comment: '',
      badgeTop: popup.relTop,
      badgeLeft: popup.relLeft,
    }])
    // Open the box on the selection itself: writing the comment is the reason
    // the quote was made, so it should not cost a second click on the badge.
    // The composer keeps the caret only once the box is dismissed.
    setInlineCommentQuoteId(quoteId)
  }, [])

  const removeQuote = useCallback((quoteId: string) => {
    setQuotes(prev => prev.filter(q => q.id !== quoteId))
  }, [])

  const updateQuoteComment = useCallback((quoteId: string, comment: string) => {
    setQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, comment } : q))
  }, [])

  const sendMessage = useCallback(async (
    draftMessage: string,
    attachments: ComposerAttachment[],
  ): Promise<boolean> => {
    const hasQuotes = quotes.length > 0
    const text = draftMessage.trim()
    if (!text && !hasQuotes && attachments.length === 0) return false
    if (sending) return false
    if (principalScopeRef.current) {
      setError(t('header.principalScopeReadOnly'))
      return false
    }
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
      const receipt = await DASHBOARD_API.command<{ event_id?: string }>(
        `/api/sessions/${encodeURIComponent(targetSession.id)}/messages`,
        'POST',
        {
          text: composedText,
          client_message_id: `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          attachments: attachments.map(attachment => ({
            name: attachment.name,
            media_type: attachment.mediaType,
            data_base64: attachment.dataBase64,
          })),
        },
      )
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
  }, [createContext, createSession, loadSession, quotes, selectedContext, selectedSession, sending, t])

  const retryDialogueTurn = useCallback(async (
    failureEvent: MorphzEvent,
    snapshot: SchedulerThreadSnapshot,
  ) => {
    if (!selectedSessionId || retryingTurnEventId) return
    if (principalScopeRef.current) {
      setError(t('header.principalScopeReadOnly'))
      return
    }
    const thread = snapshot.thread
    setRetryingTurnEventId(failureEvent.id)
    conversationPinnedToEnd.current = true
    try {
      const receipt = await DASHBOARD_API.command<{
        event_id: string
        root_turn_id: string
        thread_id: string
        generation: number
        duplicate: boolean
      }>(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/dialogue-turns/${encodeURIComponent(thread.root_turn_id)}/retry`,
        'POST',
        {
          expected_thread_revision: thread.revision,
          expected_result_event_id: failureEvent.id,
          retry_request_id: `dashboard-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        },
      )
      setPendingTurn({ startedAt: Date.now(), rootTurnId: receipt.root_turn_id })
      setError('')
      window.setTimeout(() => {
        void loadSession(selectedSessionId, selectedContextId)
        void loadOverview(selectedContextId, selectedSessionId)
      }, 120)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRetryingTurnEventId('')
    }
  }, [loadOverview, loadSession, retryingTurnEventId, selectedContextId, selectedSessionId, t])

  const cancelCurrentSession = useCallback(async () => {
    if (!selectedSessionId) return
    if (principalScopeRef.current) {
      setError(t('header.principalScopeReadOnly'))
      return
    }
    try {
      await DASHBOARD_API.command(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/cancel`,
        'POST',
      )
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [selectedSessionId, t])

  const changeReasoningEffort = async (value: string) => {
    if (changingReasoning) return
    setChangingReasoning(true)
    try {
      const inference = await DASHBOARD_API.command<{ reasoning_effort?: ReasoningEffortSetting | null }>(
        '/api/runtime/inference',
        'PUT',
        {
          reasoning_effort: value,
        },
      )
      setStatus(current => current ? { ...current, reasoning_effort: inference.reasoning_effort } : current)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangingReasoning(false)
    }
  }

  const changeModel = async (model: string) => {
    if (changingModel || !model || model === status?.model) return
    setChangingModel(true)
    try {
      const inference = await DASHBOARD_API.command<{
        model: string
        models: string[]
        reasoning_effort?: ReasoningEffortSetting | null
      }>(
        '/api/runtime/inference',
        'PUT',
        {
          model,
          // Reasoning vocabularies belong to physical models. Do not carry a
          // level across a model switch when the new route may not accept it.
          reasoning_effort: 'default',
        },
      )
      setStatus(current => current
        ? {
            ...current,
            model: inference.model,
            models: inference.models,
            reasoning_effort: inference.reasoning_effort,
          }
        : current)
      if (selectedContextId) await loadContextTokenBudget(selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangingModel(false)
    }
  }

  const changeModelPromptTokenLimit = async () => {
    if (!selectedContextId
      || changingModelPromptTokenLimit
      || !modelPromptTokenLimitDraftValid
      || !modelPromptTokenLimitChanged) return
    setChangingModelPromptTokenLimit(true)
    try {
      await DASHBOARD_API.command('/api/runtime/inference', 'PUT', {
        prompt_token_limit: parsedModelPromptTokenLimitDraft,
      })
      await loadContextTokenBudget(selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangingModelPromptTokenLimit(false)
    }
  }

  const changeContextTokenBudget = async (requestedHardTokenLimit: number | null) => {
    if (!selectedContextId || !contextTokenBudget || changingContextTokenBudget) return
    if (requestedHardTokenLimit !== null
      && (!Number.isSafeInteger(requestedHardTokenLimit) || requestedHardTokenLimit <= 0)) {
      setError(t('contextBudget.invalid'))
      return
    }
    setChangingContextTokenBudget(true)
    try {
      const response = await DASHBOARD_API.command<{
        outcome: 'updated'
        budget: ContextTokenBudget
      }>(
        `/api/contexts/${encodeURIComponent(selectedContextId)}/token-budget`,
        'PATCH',
        {
          requested_hard_token_limit: requestedHardTokenLimit,
          expected_revision: contextTokenBudget.token_budget_revision,
        },
      )
      setContextTokenBudget(response.budget)
      setContextTokenBudgetDraft(
        response.budget.requested_hard_token_limit == null
          ? ''
          : String(response.budget.requested_hard_token_limit),
      )
      setError('')
    } catch (reason) {
      await loadContextTokenBudget(selectedContextId)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangingContextTokenBudget(false)
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

  const editObjective = async (objective: ObjectiveRecord) => {
    if (pausingObjectiveId || resumingObjectiveId || editingObjectiveId || deletingObjectiveId) return
    const requested = await requestText({
      title: t('work.objectives.edit'),
      description: t('dialog.editObjective'),
      inputLabel: t('dialog.objectiveLabel'),
      defaultValue: objective.stated_objective,
      multiline: true,
      confirmLabel: t('dialog.actions.save'),
      cancelLabel: t('dialog.actions.cancel'),
    })
    const statedObjective = requested?.trim()
    if (!statedObjective || statedObjective === objective.stated_objective) return
    setEditingObjectiveId(objective.id)
    try {
      await DASHBOARD_API.command(
        `/api/objectives/${encodeURIComponent(objective.id)}`,
        'PATCH',
        {
          expected_revision: objective.revision,
          stated_objective: statedObjective,
        },
      )
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      await loadSession(selectedSessionId, selectedContextId).catch(() => {})
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setEditingObjectiveId('')
    }
  }

  const pauseObjective = async (objective: ObjectiveRecord) => {
    if (pausingObjectiveId || resumingObjectiveId || editingObjectiveId || deletingObjectiveId) return
    setPausingObjectiveId(objective.id)
    try {
      await DASHBOARD_API.command(
        `/api/objectives/${encodeURIComponent(objective.id)}/pause`,
        'POST',
        {
          expected_revision: objective.revision,
          reason: t('reason.pauseByUser'),
        },
      )
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      // Runtime control mutations are revision fenced. Refresh after a
      // conflict so the next action does not resubmit stale control state.
      await loadSession(selectedSessionId, selectedContextId).catch(() => {})
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPausingObjectiveId('')
    }
  }

  const resumeObjective = async (objective: ObjectiveRecord) => {
    if (pausingObjectiveId || resumingObjectiveId || editingObjectiveId || deletingObjectiveId) return
    setResumingObjectiveId(objective.id)
    try {
      await DASHBOARD_API.command(
        `/api/objectives/${encodeURIComponent(objective.id)}/resume`,
        'POST',
        {
          expected_revision: objective.revision,
          reason: t('reason.resumeByUser'),
        },
      )
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setResumingObjectiveId('')
    }
  }

  const deleteObjective = async (objective: ObjectiveRecord) => {
    if (pausingObjectiveId || resumingObjectiveId || editingObjectiveId || deletingObjectiveId) return
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
      await DASHBOARD_API.command(
        `/api/objectives/${encodeURIComponent(objective.id)}`,
        'DELETE',
        {
          expected_revision: objective.revision,
          reason: t('reason.deleteByUser'),
        },
      )
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

  const controlThread = async (thread: ThreadRecord, action: 'pause' | 'resume' | 'close') => {
    if (!selectedContextId || mutatingThreadId) return
    if (action === 'close') {
      const confirmed = await requestConfirmation({
        title: t('dialog.closeThreadTitle'),
        description: t('dialog.closeThreadBody', { thread: threadKindLabel(thread.kind, t), id: shortId(thread.id, 28) }),
        confirmLabel: t('work.causal.closeThread'),
        cancelLabel: t('dialog.actions.cancel'),
        tone: 'danger',
      })
      if (!confirmed) return
    }
    setMutatingThreadId(thread.id)
    try {
      await DASHBOARD_API.command(
        `/api/contexts/${encodeURIComponent(selectedContextId)}/threads/${encodeURIComponent(thread.id)}`,
        'POST',
        {
          action,
          expected_revision: thread.revision,
          reason: t(`reason.${action}ThreadByUser`),
        },
      )
      await Promise.all([
        loadSession(selectedSessionId, selectedContextId),
        loadOverview(selectedContextId, selectedSessionId),
      ])
      if (threadDetail?.snapshot.thread.id === thread.id) {
        await loadThreadDetail(selectedContextId, thread.id)
      }
      setError('')
    } catch (reason) {
      await loadSession(selectedSessionId, selectedContextId).catch(() => {})
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMutatingThreadId('')
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
      await DASHBOARD_API.command(
        `/api/approvals/${encodeURIComponent(approval.id)}`,
        'POST',
        { decision, rationale: t(`reason.approval.${decision}`) },
      )
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
        defaultValue: formatLocalRfc3339(schedule.not_before ?? new Date()),
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
      await DASHBOARD_API.command(
        `/api/schedules/${encodeURIComponent(schedule.id)}`,
        'POST',
        {
          action,
          expected_revision: schedule.revision,
          not_before: notBefore,
          interval_seconds: intervalSeconds,
        },
      )
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      // Schedule mutations are revision fenced. Refresh after a conflict so
      // the next action carries the winning revision.
      await loadSession(selectedSessionId, selectedContextId).catch(() => {})
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMutatingScheduleId('')
    }
  }

  const leadingActivation = composerActivations[0]
  const activationSummary = leadingActivation
    ? summarizeActivation(leadingActivation, sessionEvents, toolTimeline, t).title
    : ''
  const primaryJob = composerJobs.find(item => (
    item.job.status === 'running'
    || item.job.status === 'queued'
    || item.job.status === 'waiting_approval'
  ))
  const primaryJobSummary = primaryJob
    ? summarizeToolCall(primaryJob.job.tool_name, JSON.stringify(primaryJob.job.request), t)
    : undefined
  const failedDelivery = composerThreads.find(item => (
    item.thread.lifecycle === 'completed'
    && item.thread.delivery_status !== 'none'
    && item.thread.delivery_status !== 'delivered'
  ))
  const composerRunningDelegations = runningDelegations.filter(item => (
    item.parent_session_id === selectedSessionId || item.child_session_id === selectedSessionId
  ))
  const taskStrip = composerPendingApprovals[0]
    ? { state: 'waiting', label: t('composer.status.approvalRequired'), summary: composerPendingApprovals[0].justification }
    : composerWaitingUserObjectives[0]
      ? { state: 'waiting', label: t('composer.status.userInputRequired'), summary: composerWaitingUserObjectives[0].stated_objective }
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
        : composerRunningDelegations[0]
        ? { state: 'running', label: t('composer.status.delegating'), summary: composerRunningDelegations[0].task }
        : composerWaitingCount > 0
          ? { state: 'waiting', label: t('composer.status.running'), summary: composerSchedules[0]?.intent ?? composerRunningObjectives.find(item => item.wait_condition)?.stated_objective ?? t('composer.status.waitingEvent') }
          : composerBlockedObjectives[0]
            ? { state: 'blocked', label: t('composer.status.blocked'), summary: composerBlockedObjectives[0].stated_objective }
            : composerPausedObjectives[0]
              ? { state: 'paused', label: t('composer.status.paused'), summary: composerPausedObjectives[0].stated_objective }
              : composerRunningObjectives[0]
                ? { state: 'active', label: t('composer.status.active'), summary: composerRunningObjectives[0].stated_objective }
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
      visible={dialogueActivityVisible}
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
      selectedObjectiveId={selectedObjectiveFilterId}
      currentSessionOnly={dialogueCurrentSessionOnly}
      objectiveTintEnabled={objectiveTintEnabled}
      tintDimension={tintDimension}
      tintStyleFor={tintStyleFor}
      objectiveIdsByThread={objectiveLineage.objectiveIdsByThread}
      pausingObjectiveId={pausingObjectiveId}
      resumingObjectiveId={resumingObjectiveId}
      editingObjectiveId={editingObjectiveId}
      deletingObjectiveId={deletingObjectiveId}
      mutatingThreadId={mutatingThreadId}
      t={t}
      onOpenChange={setDialogueActivityOpen}
      onVisibleChange={setDialogueActivityVisible}
      onThreadToggle={threadId => {
        setExpandedDialogueThreadId(current => current === threadId ? '' : threadId)
        setDialogueThreadDetail(null)
      }}
      onReasoningOpenChange={setShowReasoningSummary}
      onInspectThread={threadId => navigate(threadPath(selectedContextId, threadId))}
      onObjectiveToggle={toggleObjectiveExpanded}
      onObjectiveFilterChange={setSelectedObjectiveFilterId}
      onCurrentSessionOnlyChange={handleDialogueCurrentSessionOnlyChange}
      onObjectiveTintChange={handleObjectiveTintChange}
      onTintDimensionChange={handleTintDimensionChange}
      onPauseObjective={objective => void pauseObjective(objective)}
      onResumeObjective={objective => void resumeObjective(objective)}
      onEditObjective={objective => void editObjective(objective)}
      onDeleteObjective={objective => void deleteObjective(objective)}
      onThreadControl={(thread, action) => void controlThread(thread, action)}
      onOpenDelegationContext={delegation => {
        void (async () => {
          let childSession = sessions.find(session => session.id === delegation.child_session_id)
          let childContext = contexts.find(context => context.id === delegation.child_context_id)
          if (!childSession && !childContext) {
            const catalog = await loadCatalog()
            childSession = catalog?.sessions.find(session => session.id === delegation.child_session_id)
            childContext = catalog?.contexts.find(context => context.id === delegation.child_context_id)
          }
          if (childSession) {
            chooseSession(childSession)
            return
          }
          if (childContext) {
            activateContext(childContext)
            return
          }
          setError(t('errors.delegationContextUnavailable'))
        })()
      }}
    />
  )

  const renderContextCatalogOption = (context: ContextRecord) => {
    const isRootContext = selectedAgent?.root_context_id === context.id
    const isMutating = catalogMutationKey.startsWith(`context:${context.id}:`)
    return (
      <div className={`catalog-option ${context.id === selectedContextId ? 'is-current' : ''}`} key={context.id}>
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
    )
  }

  const modelOptions = status?.model_options ?? []
  const selectedModelOption = resolveSelectedModelOption(modelOptions, status?.model)
  const selectedModelLabel = selectedModelOption?.label ?? t('model.unavailable')
  const reasoningEffortOptions = selectedModelOption?.supported_reasoning_efforts
    ?? (['none', 'low', 'medium', 'high', 'max'] satisfies ReasoningEffortSetting[])
  const selectedReasoningEffort = status?.reasoning_effort
    && reasoningEffortOptions.includes(status.reasoning_effort)
    ? status.reasoning_effort
    : 'default'
  const contextBudgetModelLabel = resolveSelectedModelOption(
    modelOptions,
    contextTokenBudget?.model,
  )?.label ?? t('model.unavailable')

  return (
    <main className="page-shell" data-accent={accentTheme} data-color-mode={resolvedAppearanceMode}>
      <section className={`morphz-shell ${immersiveMode ? 'is-immersive' : ''}`} data-accent={accentTheme} data-view={view}>
        <header className="runtime-header">
          <button
            className="brand"
            type="button"
            title={`${t('header.machineTagline')} · ${t('header.agentLabel', { title: selectedAgent?.title ?? (selectedAgentId || 'default') })}`}
            onClick={() => navigate('/')}
          >
            <span className="brand-mark">◆</span>
            <span><strong>Morphz</strong><small>{t('header.machineTagline')}</small></span>
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
                    {userVisibleContexts.map(renderContextCatalogOption)}
                    {agentVisibleContexts.length > 0 && (
                      <details
                        className="catalog-context-group"
                        open={agentContextsOpen}
                        onToggle={event => setAgentContextsOpen(event.currentTarget.open)}
                      >
                        <summary>
                          <span><GitBranch size={12} />{t('header.agentContexts')}</span>
                          <b>{agentVisibleContexts.length}</b>
                          <ChevronDown size={12} />
                        </summary>
                        <div className="catalog-context-group-list">
                          {agentVisibleContexts.map(renderContextCatalogOption)}
                        </div>
                      </details>
                    )}
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
                    <button type="button" onClick={() => void createSession()} disabled={creatingSession || !selectedContextId || observingForeignPrincipal}>
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
                          <button disabled={isMutating || observingForeignPrincipal} type="button" title={t('header.renameSession')} aria-label={t('header.renameNamedSession', { title: session.title })} onClick={() => void renameSession(session)}><Pencil size={13} /></button>
                          <button disabled={isMutating || observingForeignPrincipal} type="button" title={t('header.archiveSession')} aria-label={t('header.archiveNamedSession', { title: session.title })} onClick={() => void archiveSession(session)}><Archive size={13} /></button>
                        </div>
                      </div>
                    })}
                    {visibleSessions.length === 0 && <div className="catalog-empty">{t('header.noVisibleSessions')}</div>}
                  </div>
                </div>
              )}
            </div>
            <span className="trail-separator">/</span>
            <div className="principal-selector" ref={principalSelectorRef}>
              <button
                className={`identity-chip principal-chip ${activePrincipalId ? '' : 'unset'} ${principalScope ? 'is-observing' : ''}`}
                type="button"
                aria-label={t('header.principalDirectory')}
                aria-expanded={principalMenuOpen}
                title={t('header.principalDirectory')}
                onClick={() => setPrincipalMenuOpen(open => !open)}
              >
                <Globe className="principal-directory-icon" size={14} />
                <small>{t('header.principal').toUpperCase()}</small>
                <strong>{activePrincipalId ? shortId(activePrincipalId, 26) : t('header.noPrincipal')}</strong>
                <span>{principalScope ? t('header.observingPrincipal') : t('header.runtimeVerified')}</span>
                <ChevronDown size={13} />
              </button>
              {principalMenuOpen && (
                <div className="session-popover principal-popover">
                  <header>
                    <strong>{t('header.principalDirectory')}</strong>
                    {principalScope && (
                      <button type="button" onClick={() => void clearPrincipalScope()}>
                        <ArrowLeft size={13} />{t('header.returnToOperator')}
                      </button>
                    )}
                  </header>
                  <div className="principal-search">
                    <Search size={14} />
                    <input
                      autoFocus
                      type="search"
                      value={principalSearchQuery}
                      placeholder={t('header.searchPrincipalPlaceholder')}
                      aria-label={t('header.searchPrincipals')}
                      onChange={event => setPrincipalSearchQuery(event.target.value)}
                    />
                    {principalSearchBusy && <LoaderCircle size={13} className="spin" />}
                  </div>
                  <div className="principal-results">
                    {!principalSearchBusy && principalSearchEntries.length === 0 && (
                      <p>{t(principalSearchQuery.trim()
                        ? 'header.noPrincipalMatches'
                        : 'header.noKnownPrincipals')}</p>
                    )}
                    {principalSearchEntries.map(entry => (
                      <button
                        className={entry.principal.id === activePrincipalId ? 'is-current' : ''}
                        type="button"
                        key={entry.principal.id}
                        onClick={() => void observePrincipal(entry)}
                      >
                        <i className="presence active" />
                        <span>
                          <strong>{entry.principal.display_name || entry.principal.id}</strong>
                          <small>{entry.principal.id} · {entry.principal.provider_id}</small>
                        </span>
                        <em>
                          {t('header.principalSessionSummary', {
                            sessions: entry.active_session_count,
                            contexts: entry.context_count,
                          })}
                        </em>
                      </button>
                    ))}
                    {principalSearchCursor && (
                      <button
                        className="principal-load-more"
                        type="button"
                        disabled={principalSearchBusy}
                        onClick={() => void searchPrincipalDirectory(
                          principalSearchQuery.trim(),
                          principalSearchCursor,
                          true,
                        )}
                      >
                        {t('header.loadMorePrincipals')}
                      </button>
                    )}
                  </div>
                  <footer>
                    {t(status?.identity_mode === 'default'
                      ? 'header.defaultIdentityModeHint'
                      : status?.identity_mode === 'trusted-gateway'
                        ? 'header.trustedGatewayIdentityModeHint'
                        : 'header.operatorReadOnlyHint')}
                  </footer>
                </div>
              )}
            </div>
          </div>

          <div className="runtime-side">
            <div className="theme-selector" ref={themeSelectorRef}>
              <button className="theme-button" type="button" aria-label={t('theme.title')} aria-expanded={themeMenuOpen} title={t('theme.title')} onClick={() => setThemeMenuOpen(open => !open)}>
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
            {modelOptions.length > 0 ? (
              <label className="model-control" title={t('model.selectorTitle')}>
                <Bot size={15} />
                <span>{t('model.selector').toUpperCase()}</span>
                <select
                  aria-label={t('model.selector')}
                  disabled={changingModel}
                  value={selectedModelOption?.id ?? ''}
                  onChange={event => void changeModel(event.target.value)}
                >
                  {!selectedModelOption && <option value="" disabled>{t('model.chooseAvailable')}</option>}
                  {modelOptions.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
            ) : (
              <button
                className="model-control model-control-empty"
                type="button"
                title={status?.model_catalog_error || t('model.manageModelsHint')}
                onClick={() => setView('providers')}
              >
                <Bot size={15} />
                <span>{t('model.manageModels').toUpperCase()}</span>
              </button>
            )}
            <div className="context-budget-selector" ref={contextTokenBudgetRef}>
              <button
                className={`theme-button context-budget-button ${contextTokenBudgetOpen ? 'is-active' : ''}`}
                type="button"
                aria-expanded={contextTokenBudgetOpen}
                disabled={!selectedContextId}
                title={t('contextBudget.title')}
                onClick={() => setContextTokenBudgetOpen(open => !open)}
              >
                <CircleDot size={15} />
                <span>{contextTokenBudget ? compactTokens(contextTokenBudget.effective_hard_token_limit) : '—'}</span>
              </button>
              {contextTokenBudgetOpen && contextTokenBudget && (
                <div className="context-budget-popover">
                  <header>
                    <span>
                      <small>{t('contextBudget.eyebrow').toUpperCase()}</small>
                      <strong>{t('contextBudget.title')}</strong>
                    </span>
                    <em>{shortId(contextTokenBudget.context_id, 22)}</em>
                  </header>
                  <p>{t('contextBudget.description')}</p>
                  <div className="context-budget-capacity">
                    <label>
                      <span>
                        <strong>{t('contextBudget.modelCapacity')}</strong>
                        <small>{t('contextBudget.modelCapacityHint', { model: contextTokenBudget.model })}</small>
                      </span>
                      <input
                        aria-label={t('contextBudget.modelCapacity')}
                        inputMode="numeric"
                        min="1"
                        type="number"
                        value={modelPromptTokenLimitDraft}
                        onChange={event => setModelPromptTokenLimitDraft(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!modelPromptTokenLimitChanged || changingModelPromptTokenLimit}
                      onClick={() => void changeModelPromptTokenLimit()}
                    >
                      {changingModelPromptTokenLimit
                        ? t('contextBudget.savingModelCapacity')
                        : t('contextBudget.saveModelCapacity')}
                    </button>
                  </div>
                  {!modelPromptTokenLimitDraftValid && (
                    <p className="context-budget-validation">{t('contextBudget.modelCapacityInvalid')}</p>
                  )}
                  <div className="context-budget-divider"><span>{t('contextBudget.contextPolicy')}</span></div>
                  <div className="context-budget-mode">
                    <button
                      className={contextTokenBudgetDraft.trim() === '' ? 'is-selected' : ''}
                      type="button"
                      onClick={() => setContextTokenBudgetDraft('')}
                    >
                      {t('contextBudget.auto')}
                    </button>
                    {contextTokenBudgetPresets.map(value => (
                      <button
                        className={parsedContextTokenBudgetDraft === value ? 'is-selected' : ''}
                        key={value}
                        type="button"
                        onClick={() => setContextTokenBudgetDraft(String(value))}
                      >
                        {compactTokens(value)}
                      </button>
                    ))}
                  </div>
                  <input
                    aria-label={t('contextBudget.slider')}
                    type="range"
                    min={Math.min(1_024, contextTokenBudgetSliderMax)}
                    max={contextTokenBudgetSliderMax}
                    step={1_024}
                    value={contextTokenBudgetSliderValue}
                    onChange={event => setContextTokenBudgetDraft(event.target.value)}
                  />
                  <label className="context-budget-exact">
                    <span>{t('contextBudget.requested')}</span>
                    <input
                      inputMode="numeric"
                      min="1"
                      placeholder={t('contextBudget.autoPlaceholder')}
                      type="number"
                      value={contextTokenBudgetDraft}
                      onChange={event => setContextTokenBudgetDraft(event.target.value)}
                    />
                  </label>
                  <div className="context-budget-metrics">
                    <span><small>{t('contextBudget.effective')}</small><strong>{compactTokens(contextTokenBudget.effective_hard_token_limit)}</strong></span>
                    <span><small>{t('contextBudget.physical')}</small><strong>{compactTokens(contextTokenBudget.physical_prompt_token_limit)}</strong></span>
                    <span><small>{t('contextBudget.soft')}</small><strong>{compactTokens(contextTokenBudget.soft_token_limit)}</strong></span>
                    <span><small>{t('contextBudget.reserve')}</small><strong>{compactTokens(contextTokenBudget.maintenance_reserve_tokens)}</strong></span>
                  </div>
                  <div className="context-budget-source">
                    <span>{contextTokenBudget.provider ?? t('runtime.providerUnknown')} · {contextBudgetModelLabel}</span>
                    <code>{contextTokenBudget.capacity_source}</code>
                  </div>
                  {!contextTokenBudgetDraftValid && (
                    <p className="context-budget-validation">{t('contextBudget.invalid')}</p>
                  )}
                  {parsedContextTokenBudgetDraft !== null
                    && parsedContextTokenBudgetDraft > contextTokenBudget.physical_prompt_token_limit && (
                    <p className="context-budget-warning">{t('contextBudget.clamped', {
                      physical: compactTokens(contextTokenBudget.physical_prompt_token_limit),
                    })}</p>
                  )}
                  <footer>
                    <small>{t('contextBudget.nextEvaluation')}</small>
                    <button
                      type="button"
                      disabled={!contextTokenBudgetChanged || changingContextTokenBudget}
                      onClick={() => void changeContextTokenBudget(parsedContextTokenBudgetDraft)}
                    >
                      {changingContextTokenBudget ? t('contextBudget.saving') : t('contextBudget.save')}
                    </button>
                  </footer>
                </div>
              )}
            </div>
            <label className="reasoning-control" title={t('reasoning.title')}>
              <Gauge size={15} />
              <span>{t('reasoning.label').toUpperCase()}</span>
              <select
                aria-label={t('reasoning.label')}
                disabled={changingReasoning}
                value={selectedReasoningEffort}
                onChange={event => void changeReasoningEffort(event.target.value)}
              >
                <option value="default">{t('reasoning.defaultUnknown')}</option>
                {reasoningEffortOptions.includes('none') && <option value="none">{t('reasoning.off')}</option>}
                {reasoningEffortOptions.includes('low') && <option value="low">{t('reasoning.low')}</option>}
                {reasoningEffortOptions.includes('medium') && <option value="medium">{t('reasoning.medium')}</option>}
                {reasoningEffortOptions.includes('high') && <option value="high">{t('reasoning.high')}</option>}
                {reasoningEffortOptions.includes('max') && <option value="max">{t('reasoning.max')}</option>}
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
              className="theme-button language-toggle"
              type="button"
              title={t('language.toggle')}
              onClick={() => {
                const language = nextDashboardLanguage(i18n.language)
                persistDashboardLanguage(language)
                void i18n.changeLanguage(language)
              }}
            >
              <Globe size={15} />
              <span>{currentLangCode}</span>
            </button>
          </div>
        </header>

        <div className="runtime-navigation-row">
          <nav className="runtime-navigation" aria-label={t('navigation.label')}>
            <button className={view === 'overview' && !route.contextId ? 'is-active' : ''} type="button" aria-label={t('navigation.overview')} title={t('navigation.overview')} onClick={() => navigate('/')} aria-current={view === 'overview' && !route.contextId ? 'page' : undefined}>
              <CircleDot size={14} /><span>{t('navigation.overview')}</span>
            </button>
            <button className={view === 'dialogue' ? 'is-active' : ''} type="button" aria-label={t('navigation.dialogue')} title={t('navigation.dialogue')} disabled={!selectedSessionId} onClick={() => setView('dialogue')} aria-current={view === 'dialogue' ? 'page' : undefined}>
              <MessageSquare size={14} /><span>{t('navigation.dialogue')}</span>
            </button>
            <button className={view === 'scheduler' ? 'is-active' : ''} type="button" aria-label={t('navigation.scheduler')} title={t('navigation.scheduler')} disabled={!selectedContextId} onClick={() => setView('scheduler')} aria-current={view === 'scheduler' ? 'page' : undefined}>
              <GitBranch size={14} /><span>{t('navigation.scheduler')}</span>{attentionCount > 0 && <em>{attentionCount}</em>}
            </button>
            <button className={view === 'cognition' ? 'is-active' : ''} type="button" aria-label={t('navigation.cognition')} title={t('navigation.cognition')} disabled={!selectedContextId} onClick={() => setView('cognition')} aria-current={view === 'cognition' ? 'page' : undefined}>
              <Brain size={14} /><span>{t('navigation.cognition')}</span>
            </button>
            <button className={view === 'ledger' ? 'is-active' : ''} type="button" aria-label={t('navigation.ledger')} title={t('navigation.ledger')} disabled={!selectedContextId} onClick={() => setView('ledger')} aria-current={view === 'ledger' ? 'page' : undefined}>
              <Database size={14} /><span>{t('navigation.ledger')}</span>
            </button>
            <button className={view === 'runtime' ? 'is-active' : ''} type="button" aria-label={t('navigation.runtime')} title={t('navigation.runtime')} onClick={() => setView('runtime')} aria-current={view === 'runtime' ? 'page' : undefined}>
              <Radio size={14} /><span>{t('navigation.runtime')}</span>
            </button>
            <button className={view === 'credentials' ? 'is-active' : ''} type="button" aria-label={t('navigation.credentials')} title={t('navigation.credentials')} onClick={() => setView('credentials')} aria-current={view === 'credentials' ? 'page' : undefined}>
              <KeyRound size={14} /><span>{t('navigation.credentials')}</span>
            </button>
            <button className={view === 'providers' ? 'is-active' : ''} type="button" aria-label={t('navigation.providers')} title={t('navigation.providers')} onClick={() => setView('providers')} aria-current={view === 'providers' ? 'page' : undefined}>
              <Router size={14} /><span>{t('navigation.providers')}</span>
            </button>
          </nav>
          <div className="navigation-page-toolbar">
            {view === 'dialogue' && selectedSessionId && (
              <div className="conversation-toolbar">
              <div className="conversation-toolbar-session" ref={conversationSessionSelectorRef}>
                <button
                  className="conversation-toolbar-title"
                  type="button"
                  aria-expanded={conversationSessionMenuOpen}
                  title={selectedSession?.title ?? selectedSessionId}
                  onClick={() => setConversationSessionMenuOpen(open => !open)}
                >
                  <MessageSquare size={12} />
                  <span>{t('conversation.heading', { title: selectedSession?.title ?? shortId(selectedSessionId) })}</span>
                  <ChevronDown size={11} />
                </button>
                {conversationSessionMenuOpen && (
                  <div className="session-popover conversation-session-popover">
                    <header>
                      <strong>{t('header.sessionCount', { count: visibleSessions.length })}</strong>
                      <button
                        type="button"
                        onClick={() => {
                          setConversationSessionMenuOpen(false)
                          void createSession()
                        }}
                        disabled={creatingSession || !selectedContextId}
                      >
                        <Plus size={13} />{creatingSession ? t('header.creatingSession') : t('header.createSession')}
                      </button>
                    </header>
                    <div className="session-options">
                      {visibleSessions.map(session => (
                        <div className={`catalog-option ${session.id === selectedSessionId ? 'is-current' : ''}`} key={session.id}>
                          <button className="catalog-option-main" type="button" onClick={() => chooseSession(session)}>
                            <i className={`presence ${session.attention_state ?? 'active'}`} />
                            <span>
                              <strong>{session.title}</strong>
                              <small>{shortId(session.id, 25)} · {formatAgo(session.last_activity_at, t)}</small>
                            </span>
                            <em>{session.id === selectedSessionId ? t('header.active').toUpperCase() : ''}</em>
                          </button>
                        </div>
                      ))}
                      {visibleSessions.length === 0 && <div className="catalog-empty">{t('header.noVisibleSessions')}</div>}
                    </div>
                  </div>
                )}
              </div>
              <div className="conversation-history-search">
                <form onSubmit={event => { event.preventDefault(); void searchDialogueHistory() }}>
                  <button type="submit" disabled={dialogueSearchBusy || !dialogueSearchQuery.trim()} title={t('conversation.search.action')} aria-label={t('conversation.search.action')}>
                    {dialogueSearchBusy ? <LoaderCircle className="spinning" size={13} /> : <Search size={13} />}
                  </button>
                  <input
                    type="search"
                    value={dialogueSearchQuery}
                    placeholder={t('conversation.search.placeholder')}
                    aria-label={t('conversation.search.placeholder')}
                    onFocus={() => { if (dialogueSearchSubmitted) setDialogueSearchOpen(true) }}
                    onChange={event => {
                      setDialogueSearchQuery(event.target.value)
                      setDialogueSearchSubmitted(false)
                      setDialogueSearchOpen(false)
                    }}
                  />
                  {dialogueSearchQuery && (
                    <button
                      type="button"
                      title={t('conversation.search.clear')}
                      aria-label={t('conversation.search.clear')}
                      onClick={() => {
                        setDialogueSearchQuery('')
                        setDialogueSearchMatches([])
                        setDialogueSearchSubmitted(false)
                        setDialogueSearchOpen(false)
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </form>
                {dialogueSearchOpen && dialogueSearchSubmitted && (
                  <div className="conversation-history-results" role="dialog" aria-label={t('conversation.search.results')}>
                    <header>
                      <span>
                        <strong>{t('conversation.search.results')}</strong>
                        <small>{t('conversation.search.scope')}</small>
                      </span>
                      <button type="button" title={t('conversation.search.close')} aria-label={t('conversation.search.close')} onClick={() => setDialogueSearchOpen(false)}><X size={13} /></button>
                    </header>
                    {dialogueSearchMatches.length === 0 ? (
                      <div className="conversation-history-empty"><Search size={17} /><span>{t('conversation.search.empty')}</span></div>
                    ) : (
                      <div className="conversation-history-result-list">
                        {dialogueSearchMatches.map(hit => (
                          <button key={hit.event_id} type="button" onClick={() => openDialogueSearchHit(hit)}>
                            <span>
                              <b>{t(`conversation.search.kind.${hit.kind}`)}</b>
                              <code>{sessions.find(session => session.id === hit.session_id)?.title ?? shortId(hit.session_id, 22)}</code>
                              <code>{formatTime(hit.timestamp, i18n.language)}</code>
                              {hit.retired && <em>{t('mindView.retired')}</em>}
                            </span>
                            <p>{hit.preview || t('conversation.noText')}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
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
          <div className="immersive-controls">
            <button
              className={`immersive-toggle ${immersiveMode ? 'is-active' : ''}`}
              type="button"
              aria-pressed={immersiveMode}
              title={immersiveMode ? t('header.exitImmersive') : t('header.enterImmersive')}
              aria-label={immersiveMode ? t('header.exitImmersive') : t('header.enterImmersive')}
              onClick={() => setImmersiveMode(value => !value)}
            >
              {immersiveMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>

        <div
          className="view-frame"
          ref={viewFrameRef}
          onScroll={event => {
            if (view === 'dialogue' && conversationLayout === 'merged') {
              handleConversationScroll('merged', event.currentTarget)
            }
          }}
          onWheel={event => {
            if (view === 'dialogue' && conversationLayout === 'merged' && event.deltaY < 0 && event.currentTarget.scrollTop < 80) {
              void loadOlderConversationEvents('merged', event.currentTarget)
            }
          }}
        >
          {!catalogReady && (
            <div className="runtime-initial-loading" role="status" aria-live="polite">
              <LoaderCircle size={18} />
              <span><strong>{t('runtime.loading')}</strong><small>{t('runtime.loadingHint')}</small></span>
            </div>
          )}
          {view === 'overview' && !route.contextId && (
            <RuntimeOverviewPage
              overview={runtimeOverview}
              loading={runtimeOverviewLoading}
              error={runtimeOverviewError}
              onRefresh={() => void loadRuntimeOverview()}
              onOpenContext={contextId => {
                setSelectedContextId(contextId)
                navigate(dashboardPath('overview', contextId))
              }}
              onOpenSession={(contextId, sessionId) => {
                const session = sessions.find(item => item.id === sessionId)
                if (session) setSelectedAgentId(session.agent_id)
                setSelectedContextId(contextId)
                setSelectedSessionId(sessionId)
                navigate(dashboardPath('dialogue', contextId, sessionId))
              }}
              onExpandSessions={expandRuntimeOverviewSessions}
            />
          )}
          {view === 'overview' && Boolean(route.contextId) && (
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
                activeActivations: activeWorkCount,
                pendingApprovals: pendingApprovals.length,
              }}
              attention={{
                approvals: pendingApprovals.length,
                failedJobs: failedSchedulerJobs.length,
                failedDeliveries: failedDeliveries.length,
                inactiveObjectives: blockedObjectives.length,
                waitingUser: waitingUserObjectives.length,
              }}
              activities={schedulerThreads
                .filter(item => item.phase !== 'idle' || (item.thread.lifecycle === 'open' && item.thread.control_state === 'paused'))
                .sort((left, right) => right.thread.updated_at.localeCompare(left.thread.updated_at))
                .slice(0, 8)
                .map(snapshot => ({
                  id: snapshot.thread.id,
                  displayId: shortId(snapshot.thread.id, 28),
                  kind: threadKindLabel(snapshot.thread.kind, t),
                  phase: snapshot.phase,
                  phaseLabel: statusLabel(snapshot.phase, t),
                  executor: snapshot.thread.executor_kind,
                  updatedAgo: formatAgo(snapshot.thread.updated_at, t),
                  thread: snapshot.thread,
                }))}
              canRefresh={Boolean(selectedContextId)}
              mutatingThreadId={mutatingThreadId}
              onRefresh={() => void loadOverview(selectedContextId, selectedSessionId)}
              onNavigate={setView}
              onOpenMind={() => selectCognitionView('mind')}
              onThreadControl={(thread, action) => void controlThread(thread, action)}
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
                    if (conversationLayout === 'split') handleConversationScroll('dialogue', event.currentTarget)
                  }}
                  onWheel={event => {
                    if (conversationLayout === 'split' && event.deltaY < 0 && event.currentTarget.scrollTop < 80) {
                      void loadOlderConversationEvents('dialogue', event.currentTarget)
                    }
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
                {(dialogueHiddenEventCount > 0 || eventHistoryCursor !== null) && (
                  <button
                    className="history-hint"
                    type="button"
                    disabled={loadingOlderEvents}
                    onClick={event => {
                      const container = conversationLayout === 'split'
                        ? conversationLaneRef.current
                        : viewFrameRef.current
                      if (container) void loadOlderConversationEvents(dialogueHistoryLane, container)
                      event.currentTarget.blur()
                    }}
                  >
                    {loadingOlderEvents
                      ? t('conversation.historyLoading')
                      : dialogueHiddenEventCount > 0
                        ? t('conversation.historyHint', { count: dialogueHiddenEventCount })
                        : t('conversation.historyMore')}
                  </button>
                )}
                {visibleDialogueEvents.map(event => {
                  const kind = eventKind(event) ?? 'system'
                  const lineage = objectiveLineage.forEvent(event)
                  const tintStyle = tintStyleForLineage(lineage)
                  const waitingForModelRead = kind === 'user' && queuedUserInputEventIds.has(event.id)
                  if (kind === 'progress') {
                    return <div className={`progress-note ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`} style={tintStyle} key={event.id}><i /> <div className="progress-note-body"><MarkdownBody text={typeof event.payload.text === 'string' ? event.payload.text : ''} /></div><time>{formatTime(event.timestamp, i18n.language)}</time></div>
                  }
                  const persistedReasoningSummary = visibleReasoningSummaries.get(event.id) ?? ''
                  if (kind === 'reasoning') {
                    const assistantText = typeof event.payload.text === 'string' ? event.payload.text.trim() : ''
                    const eventToolCalls = assistantToolCalls(event.payload).map(call => (
                      toolTimelineById.get(call.id) ?? {
                        ...call,
                        timestamp: event.timestamp,
                        status: 'running',
                      }
                    ))
                    // In merged mode the Assistant Call is the durable home of
                    // Execution output as well as reasoning. Do not discard a
                    // call merely because the provider emitted no reasoning
                    // summary: tool-only calls are common and still need to be
                    // visible alongside the dialogue that caused them.
                    if (!persistedReasoningSummary && !assistantText && eventToolCalls.length === 0) return null
                    return (
                      <article
                        className={`message-row agent persisted-reasoning merged-execution-output ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`}
                        style={tintStyle}
                        key={event.id}
                        data-event-id={event.id}
                        data-event-actor={event.actor}
                        data-event-time={event.timestamp}
                      >
                        <CausalIdentifierBadges lineage={lineage} t={t} tintStyleFor={tintStyleFor} />
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
                        {assistantText && (
                          <div className="message-body"><MarkdownBody text={assistantText} /></div>
                        )}
                        <ExecutionToolCalls calls={eventToolCalls} targetNames={executionTargetNames} locale={i18n.language} t={t} />
                        <div className="message-meta execution-output-meta">
                          <time className="message-time" title={new Date(event.timestamp).toLocaleString(i18n.language)}>
                            {formatTime(event.timestamp, i18n.language)}
                          </time>
                        </div>
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
                  const retryableTurn = retryableDialogueThread(schedulerThreads, event.id, event.payload)
                  return (
                    <article className={`message-row ${kind} ${waitingForModelRead ? 'awaiting-model-read' : ''} ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`} style={tintStyle} key={event.id} data-event-id={event.id} data-event-actor={event.actor} data-event-time={event.timestamp}>
                      {showRole && (
                        <div className="message-role">
                          <strong>{role}</strong>
                          <time>{formatTime(event.timestamp, i18n.language)}</time>
                          {kind === 'background' && <small>{shortId(String(event.payload.root_turn_id ?? ''), 18)}</small>}
                        </div>
                      )}
                      <CausalIdentifierBadges lineage={lineage} t={t} tintStyleFor={tintStyleFor} />
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
                          : event.payload.attachments?.length ? null : t('conversation.noText')}
                      </div>
                      <MessageAttachments attachments={event.payload.attachments} />
                      {waitingForModelRead && (
                        <div className="message-input-queue-state" role="status">
                          <Clock3 size={11} />
                          <span>{t('conversation.awaitingModelRead')}</span>
                        </div>
                      )}
                      {retryableTurn && (
                        <div className="message-retry-panel">
                          <span>
                            <strong>{t('conversation.retryTurn.title')}</strong>
                            <small>{t('conversation.retryTurn.description')}</small>
                          </span>
                          <button
                            type="button"
                            disabled={observingForeignPrincipal || Boolean(retryingTurnEventId)}
                            title={observingForeignPrincipal ? t('header.principalScopeReadOnly') : undefined}
                            onClick={() => void retryDialogueTurn(event, retryableTurn)}
                          >
                            <RefreshCw size={13} className={retryingTurnEventId === event.id ? 'is-spinning' : ''} />
                            {retryingTurnEventId === event.id
                              ? t('conversation.retryTurn.retrying')
                              : t('conversation.retryTurn.action')}
                          </button>
                        </div>
                      )}
                      {derivedThreads.length > 0 && (
                        <div className="message-thread-capsules" aria-label={t('conversation.derivedThreads')}>
                          {derivedThreads.map(snapshot => (
                            <MessageThreadReference
                              key={snapshot.thread.id}
                              snapshot={snapshot}
                              objectiveIds={objectiveLineage.objectiveIdsByThread.get(snapshot.thread.id) ?? []}
                              tintStyleFor={tintStyleFor}
                              onOpen={() => navigate(threadPath(selectedContextId, snapshot.thread.id))}
                              t={t}
                            />
                          ))}
                        </div>
                      )}
                      {quotes.map((q, qi) => q.eventId === event.id ? (
                            <span key={q.id}>
                              <button
                                className={`message-quote-badge ${inlineCommentQuoteId === q.id ? 'active' : ''}`}
                                type="button"
                                style={{ position: 'absolute', top: q.badgeTop, left: q.badgeLeft, zIndex: 10 }}
                                title={q.comment.trim() ? q.comment.trim() : t('conversation.commentPlaceholder')}
                                onClick={() => setInlineCommentQuoteId(inlineCommentQuoteId === q.id ? '' : q.id)}
                              >
                                {qi + 1}
                              </button>
                              {inlineCommentQuoteId === q.id && (
                                // Positioned against the message row rather than
                                // the badge, so the box cannot reach past the
                                // column on either side and be clipped.
                                <span className="inline-comment-box" style={{ top: q.badgeTop + 22 }}>
                                  <textarea
                                    className="inline-comment-input"
                                    placeholder={t('conversation.commentPlaceholder')}
                                    rows={2}
                                    value={q.comment}
                                    onChange={e => updateQuoteComment(q.id, e.target.value)}
                                    // Collapsing on blur keeps what was typed:
                                    // the text lives on the quote, and the
                                    // badge carries a dot once it is non-empty.
                                    onBlur={() => setInlineCommentQuoteId(current => (
                                      current === q.id ? '' : current
                                    ))}
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
                {dialogueStreamingAttempts.map(attempt => {
                  const lineage = lineageForLiveAttempt(attempt)
                  return (
                  <article className={`message-row agent streaming ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`} style={tintStyleForLineage(lineage)} key={`stream-${attempt.attemptId}`} aria-live="polite">
                    <CausalIdentifierBadges lineage={lineage} t={t} tintStyleFor={tintStyleFor} />
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
                  )
                })}
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
                      if (event.deltaY < 0) {
                        executionOutputPinnedToEnd.current = false
                        if (event.currentTarget.scrollTop < 80) {
                          void loadOlderConversationEvents('execution_output', event.currentTarget)
                        }
                      }
                    }}
                    onScroll={event => handleExecutionOutputScroll(event.currentTarget)}
                  >
                    <header className="conversation-lane-heading">
                      <span><GitBranch size={13} /> {t('conversation.layout.executionLane')}</span>
                      <small>{t('conversation.layout.executionLaneHint')}</small>
                    </header>
                    <div className="message-list execution-output-list" ref={executionOutputListRef}>
                      {(executionHiddenEventCount > 0 || eventHistoryCursor !== null) && (
                        <button
                          className="history-hint"
                          type="button"
                          disabled={loadingOlderEvents}
                          onClick={event => {
                            const container = executionOutputLaneRef.current
                            if (container) void loadOlderConversationEvents('execution_output', container)
                            event.currentTarget.blur()
                          }}
                        >
                          {loadingOlderEvents
                            ? t('conversation.historyLoading')
                            : executionHiddenEventCount > 0
                              ? t('conversation.historyHint', { count: executionHiddenEventCount })
                              : t('conversation.historyMore')}
                        </button>
                      )}
                      {visibleExecutionOutputEvents.length === 0 && executionOutputStreamingAttempts.length === 0 && (
                        <div className="conversation-lane-empty">
                          <GitBranch size={20} />
                          <span>{t('conversation.layout.executionEmpty')}</span>
                        </div>
                      )}
                      {visibleExecutionOutputEvents.map(event => {
                        const kind = eventKind(event) ?? 'background'
                        const lineage = objectiveLineage.forEvent(event)
                        const tintStyle = tintStyleForLineage(lineage)
                        const persistedReasoningSummary = visibleReasoningSummaries.get(event.id) ?? ''
                        if (kind === 'progress') {
                          return <div className={`progress-note ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`} style={tintStyle} key={event.id}><i /> <div className="progress-note-body"><MarkdownBody text={typeof event.payload.text === 'string' ? event.payload.text : ''} /></div><time>{formatTime(event.timestamp, i18n.language)}</time></div>
                        }
                        if (kind === 'reasoning') {
                          const assistantText = typeof event.payload.text === 'string' ? event.payload.text.trim() : ''
                          const eventToolCalls = assistantToolCalls(event.payload).map(call => (
                            toolTimelineById.get(call.id) ?? {
                              ...call,
                              timestamp: event.timestamp,
                              status: 'running',
                            }
                          ))
                          return (
                            <article
                              className={`message-row agent persisted-reasoning execution-output ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`}
                              style={tintStyle}
                              key={event.id}
                              data-event-id={event.id}
                              data-event-actor={event.actor}
                              data-event-time={event.timestamp}
                            >
                              <CausalIdentifierBadges lineage={lineage} t={t} tintStyleFor={tintStyleFor} />
                              <ReasoningSummaryBlock
                                summary={persistedReasoningSummary}
                                live={false}
                                open={showReasoningSummary}
                                onOpenChange={setShowReasoningSummary}
                                title={t('reasoningSummary.title')}
                                liveLabel={t('reasoningSummary.live')}
                                persistedLabel={t('reasoningSummary.persisted')}
                              />
                              {assistantText && (
                                <div className="message-body"><MarkdownBody text={assistantText} /></div>
                              )}
                              <ExecutionToolCalls calls={eventToolCalls} targetNames={executionTargetNames} locale={i18n.language} t={t} />
                              <div className="message-meta execution-output-meta">
                                <time className="message-time" title={new Date(event.timestamp).toLocaleString(i18n.language)}>
                                  {formatTime(event.timestamp, i18n.language)}
                                </time>
                              </div>
                              {!persistedReasoningSummary && !assistantText && eventToolCalls.length === 0 && (
                                <div className="message-body">{t('conversation.noText')}</div>
                              )}
                            </article>
                          )
                        }
                        const derivedThreads = derivedThreadsByRootTurn.get(event.id) ?? []
                        return (
                          <article className={`message-row background execution-output ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`} style={tintStyle} key={event.id} data-event-id={event.id} data-event-actor={event.actor} data-event-time={event.timestamp}>
                            <div className="message-role">
                              <strong>{t('conversation.roleDelivery')}</strong>
                              <time>{formatTime(event.timestamp, i18n.language)}</time>
                              <small>{shortId(String(event.payload.root_turn_id ?? ''), 18)}</small>
                            </div>
                            <CausalIdentifierBadges lineage={lineage} t={t} tintStyleFor={tintStyleFor} />
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
                                    objectiveIds={objectiveLineage.objectiveIdsByThread.get(snapshot.thread.id) ?? []}
                                    tintStyleFor={tintStyleFor}
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
                      {executionOutputStreamingAttempts.map(attempt => {
                        const lineage = lineageForLiveAttempt(attempt)
                        return (
                        <article className={`message-row agent streaming execution-output ${tintStyleForLineage(lineage) ? 'objective-tinted' : ''}`} style={tintStyleForLineage(lineage)} key={`execution-stream-${attempt.attemptId}`} aria-live="polite">
                          <CausalIdentifierBadges lineage={lineage} t={t} tintStyleFor={tintStyleFor} />
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
                        )
                      })}
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
                      mutatingThreadId={mutatingThreadId}
                      onApproval={(approval, decision) => void decideApproval(approval, decision)}
                      onSchedule={(schedule, action) => void mutateSchedule(schedule, action)}
                      onThreadControl={(thread, action) => void controlThread(thread, action)}
                      selectedSupervisorId={selectedSupervisorFilterId}
                      onSupervisorFilter={(supervisorId) => setSelectedSupervisorFilterId(current => current === supervisorId ? '' : supervisorId)}
                    />
                  ) : <div className="small-empty">{t('work.causal.loadingDetail')}</div>}
                </section>
              )}

              {!route.threadId && (<>

              <div className="work-metrics">
                <div><CircleDot size={17} /><span><small>{t('work.metrics.active').toUpperCase()}</small><strong>{activeWorkCount}</strong></span></div>
                <div><Clock3 size={17} /><span><small>{t('work.metrics.waiting').toUpperCase()}</small><strong>{waitingCount}</strong></span></div>
                <div><Radio size={17} /><span><small>{t('work.metrics.pendingSignals').toUpperCase()}</small><strong>{schedulerSnapshot?.summary.pending_signals ?? 0}</strong></span></div>
                <div><Layers3 size={17} /><span><small>{t('work.metrics.objectives').toUpperCase()}</small><strong>{activeObjectives.length}</strong></span></div>
              </div>

              {attentionCount > 0 && (
                <section className="attention-board">
                  <header><span>{t('work.attention.title').toUpperCase()}</span><b>{attentionCount}</b><small>{t('work.attention.subtitle')}</small></header>
                  <div className="attention-list">
                    {waitingUserObjectives.map(objective => {
                      const waitingSessionId = typeof objective.wait_condition?.session_id === 'string'
                        ? objective.wait_condition.session_id
                        : objective.coordinator_session_id
                      return <article className="attention-card user-input" key={`waiting-user-${objective.id}`}>
                        <div><span className="status-pill pending_human">{t('work.attention.waitingUser')}</span><time>{formatAgo(objective.updated_at, t)}</time></div>
                        <h2>{objective.stated_objective}</h2>
                        {objective.status_reason && <p>{objective.status_reason}</p>}
                        <div className="attention-actions">
                          <button type="button" onClick={() => {
                            if (waitingSessionId) setSelectedSessionId(waitingSessionId)
                            navigate(dashboardPath('dialogue', selectedContextId, waitingSessionId))
                          }}><MessageSquare size={12} /> {t('work.attention.answerNow')}</button>
                        </div>
                      </article>
                    })}
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
                        : editingObjectiveId === objective.id
                          ? 'edit'
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
                            selected={selectedObjectiveFilterId === objective.id}
                            busy={busy}
                            disabled={Boolean(pausingObjectiveId || resumingObjectiveId || editingObjectiveId || deletingObjectiveId)}
                            t={t}
                            onFilter={() => setSelectedObjectiveFilterId(current => current === objective.id ? '' : objective.id)}
                            onEdit={() => void editObjective(objective)}
                            onPause={() => void pauseObjective(objective)}
                            onResume={() => void resumeObjective(objective)}
                            onDelete={() => void deleteObjective(objective)}
                            onToggle={() => toggleObjectiveExpanded(objective.id)}
                          />
                        </header>
                        <h2 title={objective.stated_objective}><MarkdownInline>{objective.stated_objective}</MarkdownInline></h2>
                        {objective.wait_condition?.kind === 'user_input' && <div className="objective-wait-user"><MessageSquare size={12} /> {t('work.attention.waitingUser')}</div>}
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

              <section className="thread-group-board">
                <header>
                  <span>{t('work.causal.groups.title').toUpperCase()}</span>
                  <b>{durableThreadGroups.length}</b>
                  <small>{t('work.causal.groups.subtitle')}</small>
                </header>
                <div className="thread-group-grid">
                  {durableThreadGroups.map(snapshot => {
                    const selected = selectedThreadGroupFilterId === snapshot.group.id
                    const outcomesByThread = new Map(snapshot.outcomes.map(outcome => [outcome.thread_id, outcome] as const))
                    return (
                      <details className={`thread-group-card ${selected ? 'is-filtered' : ''}`} key={snapshot.group.id} open={snapshot.group.status === 'open'}>
                        <summary>
                          <span className={`status-pill ${snapshot.group.status}`}>{statusLabel(snapshot.group.status, t)}</span>
                          <span>
                            <strong>{shortId(snapshot.group.id, 36)}</strong>
                            <small>{t('work.causal.groups.supervision', {
                              kind: t(`work.causal.supervisorValues.${snapshot.group.supervisor_kind}`),
                              id: shortId(snapshot.group.supervisor_id, 22),
                            })}</small>
                          </span>
                          <code>{snapshot.group.policy.toUpperCase()} · g{snapshot.group.generation}</code>
                          <small>{t('work.causal.groups.progress', {
                            terminal: snapshot.group.terminal_count,
                            required: snapshot.group.required_count,
                            successful: snapshot.group.successful_count,
                          })}</small>
                          <ChevronDown size={13} />
                        </summary>
                        <div className="thread-group-card-body">
                          <header>
                            <span>{t('work.causal.groups.barrier')} · {snapshot.group.barrier_event_id ? shortId(snapshot.group.barrier_event_id, 24) : t('work.causal.none')}</span>
                            <button
                              type="button"
                              onClick={() => setSelectedThreadGroupFilterId(current => current === snapshot.group.id ? '' : snapshot.group.id)}
                            >
                              <Filter size={11} /> {selected ? t('work.causal.groups.clearFilter') : t('work.causal.groups.filter')}
                            </button>
                          </header>
                          {snapshot.members.map(member => {
                            const outcome = outcomesByThread.get(member.thread_id)
                            return (
                              <button
                                className="thread-group-member"
                                type="button"
                                key={member.thread_id}
                                onClick={() => navigate(threadPath(selectedContextId, member.thread_id))}
                              >
                                <span className={`status-pill ${member.status}`}>{statusLabel(member.status, t)}</span>
                                <span>
                                  <strong>{t('work.causal.groups.member')} · {shortId(member.thread_id, 32)}</strong>
                                  <small>{outcome?.summary ?? outcome?.disposition ?? t('work.causal.none')}</small>
                                </span>
                                <small>{member.required ? t('work.causal.groups.required') : t('work.causal.groups.optional')}</small>
                              </button>
                            )
                          })}
                        </div>
                      </details>
                    )
                  })}
                  {durableThreadGroups.length === 0 && <div className="small-empty">{t('work.causal.groups.empty')}</div>}
                </div>
              </section>

              <section className="causal-board">
                <header><span>{t('work.causal.title').toUpperCase()}</span><b>{visibleSchedulerThreads.length}</b><small>{t('work.causal.subtitle')}</small></header>
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
                          mutatingThreadId={mutatingThreadId}
                          onApproval={(approval, decision) => void decideApproval(approval, decision)}
                          onSchedule={(schedule, action) => void mutateSchedule(schedule, action)}
                          onThreadControl={(thread, action) => void controlThread(thread, action)}
                          selectedSupervisorId={selectedSupervisorFilterId}
                          onSupervisorFilter={(supervisorId) => setSelectedSupervisorFilterId(current => current === supervisorId ? '' : supervisorId)}
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
              reasoning={String(status?.reasoning_effort ?? 'default')}
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
              onOpenCredentials={() => setView('credentials')}
              onAuditProjection={() => void auditMindProjection()}
              onSetTargetStatus={(targetId, revision, nextStatus) => void setExecutionTargetStatus(targetId, revision, nextStatus)}
              onRevokeNode={(nodeId, revision) => void revokeExecutionNode(nodeId, revision)}
              onRevokeLease={(leaseId, revision) => void revokeCapabilityLease(leaseId, revision)}
              onCancelJob={(jobId, revision) => void cancelExecutionJob(jobId, revision)}
            />
          )}

          {view === 'credentials' && <CredentialsPage api={DASHBOARD_API} />}

          {view === 'providers' && (
            <ProvidersPage api={DASHBOARD_API} startInSetup={route.providerSetup} />
          )}

          {view === 'cognition' && (
            <section className="cognition-view">
              <header className="workspace-heading">
                <div><span>{t('mindView.title').toUpperCase()}</span><h1>{t('mindView.heading')}</h1><p>{t('mindView.description')}</p></div>
                <button type="button" onClick={() => setView('dialogue')}><ArrowLeft size={14} /> {t('mindView.backToChat')}</button>
              </header>

              <nav className="cognition-navigation" aria-label={t('cognition.navigationLabel')}>
                {(['mind', 'attention', 'encoding', 'prompt', 'recall'] as CognitionView[]).map(item => (
                  <button className={cognitionView === item ? 'is-active' : ''} key={item} type="button" onClick={() => selectCognitionView(item)} aria-current={cognitionView === item ? 'page' : undefined}>
                    {t(`cognition.tabs.${item}`)}
                  </button>
                ))}
              </nav>

              <div className="mind-metrics">
                <div><Brain size={18} /><span><small>{t('mindView.metrics.frames').toUpperCase()}</small><strong className="frame-lifecycle-counts" aria-label={t('mindView.metrics.frameLifecycle.summary', { active: activeFrameCount, retiring: retiringFrameCount, retired: retired.size })}>
                  <span className="frame-lifecycle-value" tabIndex={0} aria-label={t('mindView.metrics.frameLifecycle.active', { count: activeFrameCount })} data-hover={t('mindView.metrics.frameLifecycle.active', { count: activeFrameCount })}>{activeFrameCount}</span>
                  <i aria-hidden="true">·</i>
                  <span className="frame-lifecycle-value" tabIndex={0} aria-label={t('mindView.metrics.frameLifecycle.retiring', { count: retiringFrameCount })} data-hover={t('mindView.metrics.frameLifecycle.retiring', { count: retiringFrameCount })}>{retiringFrameCount}</span>
                  <i aria-hidden="true">·</i>
                  <span className="frame-lifecycle-value" tabIndex={0} aria-label={t('mindView.metrics.frameLifecycle.retired', { count: retired.size })} data-hover={t('mindView.metrics.frameLifecycle.retired', { count: retired.size })}>{retired.size}</span>
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
                    <div className="context-inspect-actions">
                      {contextInspectTab === 'encoding' && Boolean(contextInspectContent) && (
                        <button
                          className="context-inspect-reader"
                          type="button"
                          onClick={() => setSexprReader({
                            source: contextInspectContent,
                            eyebrow: t('mindView.contextInspect.reader.eyebrow'),
                            title: t('mindView.contextInspect.reader.title'),
                            description: t('mindView.contextInspect.reader.description'),
                            badge: hasExactContextInspect
                              ? t('mindView.contextInspect.exact')
                              : t('mindView.contextInspect.current'),
                            badgeTone: hasExactContextInspect ? 'exact' : 'current',
                            notice: t('mindView.contextInspect.reader.notice'),
                            closeLabel: t('mindView.contextInspect.reader.close'),
                          })}
                        >
                          <BookOpen size={13} />
                          {t('mindView.contextInspect.reader.open')}
                        </button>
                      )}
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
                    </div>
                  </header>
                  <pre>{contextInspectContent || t('mindView.contextInspect.empty')}</pre>
                  <footer>
                    {hasExactContextInspect
                      ? t('mindView.contextInspect.ephemeralNotice')
                      : t('mindView.contextInspect.reconstructedNotice')}
                  </footer>
                </div>
              </details>}

              {cognitionView === 'prompt' && (
                <section className="system-prompt-inspector">
                  <header>
                    <div>
                      <small>{t('systemPrompt.eyebrow').toUpperCase()}</small>
                      <h2>{t('systemPrompt.title')}</h2>
                      <p>{t('systemPrompt.description')}</p>
                    </div>
                    {systemPrompt && <span>{systemPrompt.profile}</span>}
                  </header>
                  {systemPromptLoading ? (
                    <div className="system-prompt-empty"><LoaderCircle className="spinning" size={18} />{t('systemPrompt.loading')}</div>
                  ) : systemPrompt ? (
                    <>
                      <div className="system-prompt-meta">
                        <div><small>{t('systemPrompt.profile').toUpperCase()}</small><strong>{systemPrompt.profile}</strong></div>
                        <div><small>SHA-256</small><strong title={systemPrompt.sha256}>{shortId(systemPrompt.sha256, 28)}</strong></div>
                        <div><small>{t('systemPrompt.characters').toUpperCase()}</small><strong>{systemPrompt.chars.toLocaleString()}</strong></div>
                        <div><small>{t('systemPrompt.bytes').toUpperCase()}</small><strong>{systemPrompt.bytes.toLocaleString()}</strong></div>
                      </div>
                      <nav>
                        <button
                          type="button"
                          onClick={() => setSexprReader({
                            source: systemPrompt.content,
                            eyebrow: t('systemPrompt.reader.eyebrow'),
                            title: t('systemPrompt.reader.title'),
                            description: t('systemPrompt.reader.description'),
                            badge: systemPrompt.profile,
                            badgeTone: 'exact',
                            notice: t('systemPrompt.reader.notice'),
                            closeLabel: t('systemPrompt.reader.close'),
                          })}
                        >
                          <BookOpen size={13} />{t('sexprReader.open')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void copyTextToClipboard(systemPrompt.content)
                              .then(() => {
                                setSystemPromptCopied(true)
                                window.setTimeout(() => setSystemPromptCopied(false), 1400)
                              })
                              .catch(() => setError(t('errors.copyFailed')))
                          }}
                        >
                          {systemPromptCopied ? <Check size={13} /> : <Copy size={13} />}
                          {systemPromptCopied ? t('sexprReader.copied') : t('sexprReader.copy')}
                        </button>
                        <button type="button" onClick={() => void loadSystemPrompt()}>
                          <RefreshCw size={13} />{t('systemPrompt.refresh')}
                        </button>
                      </nav>
                      <pre>{systemPrompt.content}</pre>
                      <footer>{t('systemPrompt.notice')}</footer>
                    </>
                  ) : (
                    <div className="system-prompt-empty">{t('systemPrompt.unavailable')}</div>
                  )}
                </section>
              )}

              {cognitionView === 'recall' && <>
                <form className="recall-search" onSubmit={event => { event.preventDefault(); void searchRecall() }}>
                  <input value={recallQuery} onChange={event => setRecallQuery(event.target.value)} placeholder={t('mindView.searchPlaceholder')} />
                  <button type="submit" disabled={recallBusy || !recallQuery.trim()}><Database size={14} /> {recallBusy ? t('mindView.searching') : t('mindView.search')}</button>
                  {recallIndex && <small className={recallIndex.capability.indexed ? 'indexed' : 'degraded'}>{recallIndex.capability.mode} · {recallIndex.event_documents + recallIndex.frame_documents}</small>}
                </form>
                {recallMatches.length > 0 && <div className="recall-results">{recallMatches.map(hit => (
                  <button
                    key={`${hit.document_kind}-${hit.document_id}`}
                    type="button"
                    onClick={() => {
                      if (hit.document_kind !== 'frame') return
                      setSelectedFrameId(hit.document_id)
                      selectCognitionView('mind')
                    }}
                  >
                    <span><b>{hit.document_kind}</b><strong>{hit.document_id}</strong>{hit.retired && <em>{t('mindView.retired')}</em>}</span>
                    <small>{hit.preview}</small>
                  </button>
                ))}</div>}
                {recallMatches.length === 0 && <div className="cognition-empty-panel"><Database size={20} /><strong>{t('cognition.recall.emptyTitle')}</strong><span>{t('cognition.recall.emptyDescription')}</span></div>}
              </>}

              {cognitionView === 'mind' && <>
              <div className="mind-grid">
                <div className="frame-library">
                  <header>
                    <span>{t('mindView.frameLibrary').toUpperCase()}</span>
                    <div>
                      <button
                        aria-pressed={activeFramesOnly}
                        className={activeFramesOnly ? 'is-active' : ''}
                        type="button"
                        onClick={() => setActiveFramesOnly(current => !current)}
                      >
                        <Filter size={11} />
                        {t('mindView.activeFramesOnly')}
                      </button>
                      <b>r{contextView?.state.version ?? 0}</b>
                    </div>
                  </header>
                  <div className="frame-list">
                    {visibleFrames.map(frame => (
                      <button className={frame.id === effectiveSelectedFrameId ? 'is-selected' : ''} key={frame.id} type="button" onClick={() => setSelectedFrameId(frame.id)}>
                        <span><strong>{frame.id}</strong><small>r{frame.revision} · v{frame.updated_version} · {t('mindView.sourceCount', { count: frame.sources.length })}</small></span>
                        <div className="frame-badges">
                          {protectedFrames.has(frame.id) && <em className="protected" title={t('mindView.protected')}><LockKeyhole size={9} /> {t('mindView.protected')}</em>}
                          {retired.has(frame.id) ? <em>{t('mindView.retired').toUpperCase()}</em> : retiring[frame.id] ? <em className="retiring">{t('mindView.retiring').toUpperCase()}</em> : null}
                        </div>
                      </button>
                    ))}
                    {visibleFrames.length === 0 && <div className="frame-list-empty">{activeFramesOnly ? t('mindView.emptyActiveFrames') : t('mindView.emptyFrame')}</div>}
                  </div>
                </div>

                <article className="frame-inspector">
                  {selectedFrame ? (
                    <>
                      <header>
                        <span><small>{t('mindView.frame').toUpperCase()}</small><strong>{selectedFrame.id}</strong></span>
                        <div className="frame-inspector-actions">
                          <em>{t('mindView.revision', { revision: selectedFrame.revision })}</em>
                          <button
                            type="button"
                            onClick={() => setSexprReader({
                              source: selectedFrame.body,
                              eyebrow: t('mindView.frameReader.eyebrow'),
                              title: selectedFrame.id,
                              description: t('mindView.frameReader.description'),
                              badge: t('mindView.revision', { revision: selectedFrame.revision }),
                              badgeTone: 'current',
                              notice: t('mindView.frameReader.notice'),
                              closeLabel: t('mindView.frameReader.close'),
                            })}
                          >
                            <BookOpen size={12} />{t('sexprReader.open')}
                          </button>
                        </div>
                      </header>
                      <div className="frame-lifecycle">
                        <strong>{retired.has(selectedFrame.id) ? t('mindView.retired') : selectedRetirement ? t('mindView.retiring') : t('mindView.active')}</strong>
                        {selectedRetirement && <span>{t('mindView.remainingTicks', { count: Math.max(0, selectedRetirement.eligible_at_tick - (contextView?.cognitive_clock.tick ?? 0)) })} · {selectedRetirement.reason}</span>}
                        <div>
                          {(retired.has(selectedFrame.id) || selectedRetirement) && <button type="button" disabled={mutatingFrameId === selectedFrame.id} onClick={() => void mutateFrameLifecycle(selectedFrame.id, 'restore')}>{t('mindView.restore')}</button>}
                          <button type="button" disabled={mutatingFrameId === selectedFrame.id} onClick={() => void mutateFrameLifecycle(selectedFrame.id, protectedFrames.has(selectedFrame.id) ? 'unprotect' : 'protect')}>{protectedFrames.has(selectedFrame.id) ? t('mindView.unprotect') : t('mindView.protect')}</button>
                        </div>
                      </div>
                      <pre>{selectedFrame.body}</pre>
                      <div className="frame-meta">
                        <div><small>{t('mindView.created').toUpperCase()}</small><strong>v{selectedFrame.created_version}</strong></div>
                        <div><small>{t('mindView.updated').toUpperCase()}</small><strong>v{selectedFrame.updated_version}</strong></div>
                        <div><small>{t('mindView.sources').toUpperCase()}</small><strong>{selectedFrame.sources.length}</strong></div>
                        <div><small>{t('mindView.protected').toUpperCase()}</small><strong>{protectedFrames.has(selectedFrame.id) ? t('mindView.yes') : t('mindView.no')}</strong></div>
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
          <div className={`composer-status ${composerPendingApprovals.length > 0 ? 'has-approval' : ''}`}>
            <button className={`composer-task-status ${taskStrip.state}`} type="button" onClick={() => setView(current => current === 'scheduler' ? 'dialogue' : 'scheduler')} title={t('nav.toggleTasks')}>
              <i className={composerActivations.length || turnPending ? 'busy' : taskStrip.state} />
              <strong>{turnPending ? turnStatus : taskStrip.label}</strong>
              {!turnPending && <span>{taskStrip.summary}</span>}
              <em>{t('composer.status.summary', {
                dialogue: composerDialogueCount,
                executing: composerExecutionCount,
                waiting: composerWaitingCount,
              })}</em>
            </button>
            {composerPendingApprovals[0] && (
              <div className="composer-approval-actions" aria-label={t('work.approvals.quickActions')}>
                <button
                  className="allow"
                  disabled={Boolean(decidingApprovalId)}
                  type="button"
                  onClick={() => void decideApproval(composerPendingApprovals[0], 'allow_once')}
                >
                  <Check size={12} /> {t('work.approvals.allowOnce')}
                </button>
                <button type="button" onClick={() => setView('scheduler')}>
                  {t('work.approvals.viewAll', { count: composerPendingApprovals.length })}
                </button>
                <button
                  className="deny"
                  disabled={Boolean(decidingApprovalId)}
                  type="button"
                  onClick={() => void decideApproval(composerPendingApprovals[0], 'deny')}
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
              <span className={`model-status ${selectedModelOption ? 'ok' : ''}`}>{selectedModelLabel}</span>
              <span className="connection-status" title={t('nav.connection')}><i className={`status-dot ${wsStatus === 'connected' ? '' : wsStatus === 'connecting' ? 'connecting' : 'disconnected'}`} />{t(`connection.${wsStatus}`)}</span>
            </div>
          </div>
          <Composer
            inputRef={composerInputRef}
            selectedSessionId={selectedSessionId}
            sending={sending}
            readOnly={observingForeignPrincipal}
            activeWorkCount={activeWorkCount}
            quotes={quotes}
            activeQuoteId={activeQuoteId}
            t={t}
            onActiveQuoteIdChange={setActiveQuoteId}
            onRemoveQuote={removeQuote}
            onUpdateQuoteComment={updateQuoteComment}
            onSend={sendMessage}
            onCancel={cancelCurrentSession}
            onError={setError}
            modelInputPolicy={status?.model_input}
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
      {sexprReader && (
        <SExpressionReader
          request={sexprReader}
          t={t}
          onClose={() => setSexprReader(null)}
        />
      )}
      {appDialog && <AppDialog key={appDialog.id} request={appDialog} onResolve={resolveAppDialog} />}
    </main>
  )
}
