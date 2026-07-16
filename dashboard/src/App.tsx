import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  CircleDot,
  Clock3,
  Database,
  GitBranch,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Palette,
  Play,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react'
import './App.css'

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

const accentThemes: Array<{ id: AccentTheme; label: string; description: string }> = [
  { id: 'iris', label: '鸢尾紫', description: '克制、认知感' },
  { id: 'cyan', label: '电光青', description: '清晰、技术感' },
  { id: 'coral', label: '暖珊瑚', description: '温和、有生命力' },
  { id: 'mono', label: '纯单色', description: '中性、低干扰' },
]

function initialAccentTheme(): AccentTheme {
  try {
    const saved = window.localStorage.getItem('morphz.dashboard.accent')
    if (accentThemes.some(theme => theme.id === saved)) return saved as AccentTheme
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'iris'
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

interface EvaluationWorkItem {
  id: string
  revision: number
  context_id: string
  session_id: string
  trigger_event_id: string
  trigger_kind: string
  parent_work_item_id?: string
  root_turn_id: string
  status: string
  created_at: string
  updated_at: string
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
  active_work_item_ids?: string[]
  active_objective_ids?: string[]
}

interface ContextViewResponse {
  context_id: string
  active_session_id: string
  sessions: ProjectedSession[]
  session_working_set: SessionWorkingSet
  active_work_items: EvaluationWorkItem[]
  work_threads: WorkThreadRecord[]
  scheduled_intents: ScheduledIntentRecord[]
  objectives: ObjectiveRecord[]
  state: MindState
  observations: ContextObservation[]
  pressure: ContextPressure
}

interface WorkThreadRecord {
  id: string
  revision: number
  session_id: string
  root_turn_id: string
  kind: string
  status: string
  executor_kind: string
  executor_id?: string
  result_text?: string
  delivery_status: string
  created_at: string
  updated_at: string
}

interface ScheduledIntentRecord {
  id: string
  revision: number
  thread_id: string
  source_turn_id: string
  intent: string
  status: string
  not_before?: string
  interval_seconds?: number
  dependency_thread_ids: string[]
  created_at: string
  updated_at: string
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

interface BackgroundTask {
  task_id: string
  status: string
  command: string
  session_id: string
  context_id: string
  started_at: string
  ended_at?: string
  elapsed_secs: number
  last_output_at: string
  output_bytes: number
  output_tail: string
  exit_code?: number
  sandbox_backend: string
  sandbox_status: string
  effective_boundary?: {
    network_enabled: boolean
    sandbox_backend: string
    sandbox_status: string
  }
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

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatAgo(value?: string) {
  if (!value) return '未知'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h 前`
  return `${Math.floor(seconds / 86400)}d 前`
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

function summarizeToolCall(name: string, rawArguments: string): ToolCallSummary {
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
  const lines = typeof startLine === 'number'
    ? ` · ${startLine}${typeof endLine === 'number' ? `–${endLine}` : ''} 行`
    : ''

  switch (name) {
    case 'read':
      return { title: '读取文件', target: `${path || '未指定文件'}${lines}`, detail: name }
    case 'write':
      return { title: '写入文件', target: path || '未指定文件', detail: name }
    case 'edit':
    case 'apply_patch':
      return { title: '修改文件', target: path || stringField(argumentsValue, 'patch') || '代码补丁', detail: name }
    case 'exec':
    case 'exec_command':
      return { title: '执行命令', target: command || '未显示命令', detail: name }
    case 'search':
      return { title: '搜索工作区', target: query || path || '未显示查询', detail: name }
    case 'list_files':
      return { title: '浏览文件', target: path || stringField(argumentsValue, 'glob') || '工作区', detail: name }
    case 'recall':
      return { title: '召回证据', target: query || stringField(argumentsValue, 'ref') || 'Context Ledger', detail: name }
    case 'context_tx':
      return { title: '维护认知', target: '提交 Context Transaction', detail: name }
    case 'delegate':
      return { title: '委派工作', target: task || 'Sub Agent', detail: name }
    case 'wait_task':
      return { title: '等待后台任务', target: taskId || '后台任务', detail: name }
    case 'task_status':
      return { title: '查询任务状态', target: taskId || '后台任务', detail: name }
    case 'kill_task':
      return { title: '终止后台任务', target: taskId || '后台任务', detail: name }
    case 'send_message':
      return { title: '发送 Session 消息', target: `${session || '目标 Session'}${content ? ` · ${content}` : ''}`, detail: name }
    case 'no_reply':
      return { title: '静默结束', target: '不向当前 Session 发送文本', detail: name }
    default:
      return { title: name, target: path || query || command || task || taskId || content || '查看参数', detail: name }
  }
}

function summarizeEvaluation(
  item: EvaluationWorkItem,
  events: MorphzEvent[],
  toolTimeline: ToolTimelineItem[],
) {
  const trigger = events.find(event => event.id === item.trigger_event_id)
  const objectiveId = typeof trigger?.payload.objective_id === 'string' ? trigger.payload.objective_id : ''
  if (item.trigger_kind === 'chat/user_message') {
    const input = typeof trigger?.payload.text === 'string' ? trigger.payload.text.trim() : ''
    return {
      title: input ? `处理对话：${input}` : '处理当前用户消息',
      threadKind: 'dialogue',
      threadId: item.session_id,
      threadDetail: `turn ${shortId(item.root_turn_id, 22)}`,
    }
  }
  if (objectiveId || item.trigger_kind === 'runtime/objective_continue' || item.trigger_kind.startsWith('objective/')) {
    return {
      title: '继续持久 Objective',
      threadKind: 'objective',
      threadId: objectiveId || item.root_turn_id,
      threadDetail: `causal ${shortId(item.root_turn_id, 22)}`,
    }
  }
  if (item.trigger_kind === 'chat/tool_output') {
    const callId = typeof trigger?.payload.tool_call_id === 'string' ? trigger.payload.tool_call_id : ''
    const call = toolTimeline.find(value => value.id === callId)
    const name = call?.name ?? (typeof trigger?.payload.tool_name === 'string' ? trigger.payload.tool_name : '工具')
    const summary = summarizeToolCall(name, call?.arguments ?? '{}')
    return {
      title: `处理${summary.title}结果：${summary.target}`,
      threadKind: 'work',
      threadId: item.root_turn_id,
      threadDetail: `from dialogue ${shortId(item.session_id, 18)}`,
    }
  }
  return {
    title: `处理 Runtime 事件：${item.trigger_kind}`,
    threadKind: 'work',
    threadId: item.root_turn_id,
    threadDetail: `from dialogue ${shortId(item.session_id, 18)}`,
  }
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    active: '进行中',
    blocked: '受阻',
    paused: '暂停',
    completed: '完成',
    cancelled: '取消',
    failed: '失败',
    queued: '排队',
    running: '执行中',
    success: '完成',
    guarded: '已处理',
    timeout: '超时',
    rejected: '拒绝',
    waiting_tool: '等待工具',
    waiting_external: '等待事件',
    starting: '启动中',
    succeeded: '完成',
    kill_requested: '正在终止',
    killed: '已终止',
  }
  return labels[value] ?? value
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

export default function App() {
  const [view, setView] = useState<View>('conversation')
  const [accentTheme, setAccentTheme] = useState<AccentTheme>(initialAccentTheme)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [contexts, setContexts] = useState<ContextRecord[]>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [delegations, setDelegations] = useState<DelegationRecord[]>([])
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([])
  const [contextView, setContextView] = useState<ContextViewResponse | null>(null)
  const [events, setEvents] = useState<MorphzEvent[]>([])
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
  const [pendingTurnSince, setPendingTurnSince] = useState<number | null>(null)
  const [pendingRootTurnId, setPendingRootTurnId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const conversationEnd = useRef<HTMLDivElement>(null)
  const toolTimelineList = useRef<HTMLDivElement>(null)
  const toolTimelinePinnedToEnd = useRef(true)
  const composingInput = useRef(false)
  const sessionLoadInFlight = useRef(false)
  const sessionLoadQueued = useRef<{ sessionId: string, contextId: string } | null>(null)
  const loadSessionRef = useRef<(sessionId: string, contextId: string) => Promise<void>>(async () => {})

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
      if (!statusResponse.ok) throw new Error(`Runtime 状态 HTTP ${statusResponse.status}`)
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
  }, [apiHeaders])

  const loadSession = useCallback(async (sessionId: string, contextId: string) => {
    if (!sessionId || !contextId) return
    if (sessionLoadInFlight.current) {
      // Never lose the last WebSocket-driven refresh. Without this queue, a
      // terminal event arriving while a previous snapshot was loading could
      // leave a completed Evaluation rendered as running until the next poll.
      sessionLoadQueued.current = { sessionId, contextId }
      return
    }
    sessionLoadInFlight.current = true
    try {
      const [eventsResponse, contextResponse, tasksResponse, delegationsResponse] = await Promise.all([
        fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(sessionId)}/events?limit=1000`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(sessionId)}/context`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/contexts/${encodeURIComponent(contextId)}/background-tasks`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/delegations`, { headers: apiHeaders() }),
      ])
      if (!contextResponse.ok) throw new Error(`Context Encoding HTTP ${contextResponse.status}`)
      if (eventsResponse.ok) {
        const result = await eventsResponse.json() as { events?: MorphzEvent[] }
        setEvents(result.events ?? [])
      }
      const nextContext = await contextResponse.json() as ContextViewResponse
      setContextView(nextContext)
      if (tasksResponse.ok) {
        const result = await tasksResponse.json() as { tasks?: BackgroundTask[] }
        setBackgroundTasks((result.tasks ?? []).sort((left, right) => right.started_at.localeCompare(left.started_at)))
      }
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
  }, [apiHeaders])

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
    const timer = window.setTimeout(() => void loadCatalog(), 0)
    return () => window.clearTimeout(timer)
  }, [loadCatalog])

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
    let disposed = false
    const connect = () => {
      if (disposed) return
      setWsStatus('connecting')
      const params = new URLSearchParams({ session_id: selectedSessionId })
      if (CORE_TOKEN) params.set('token', CORE_TOKEN)
      socket = new WebSocket(`${CORE_WS_URL}?${params}`)
      socket.onopen = () => setWsStatus('connected')
      socket.onmessage = messageEvent => {
        try {
          const event = JSON.parse(messageEvent.data) as MorphzEvent
          setEvents(previous => {
            if (previous.some(item => item.id === event.id)) return previous
            return [...previous, event].slice(-1000)
          })
          if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
          refreshTimer = window.setTimeout(
            () => void loadSession(selectedSessionId, selectedContextId),
            750,
          )
        } catch {
          setError('WebSocket 返回了无法解析的事件')
        }
      }
      socket.onclose = () => {
        if (disposed) return
        setWsStatus('disconnected')
        reconnectTimer = window.setTimeout(connect, 2500)
      }
      socket.onerror = () => setWsStatus('disconnected')
    }
    connect()
    return () => {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      socket?.close()
    }
  }, [loadSession, selectedContextId, selectedSessionId])

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

  const selectedSession = sessions.find(item => item.id === selectedSessionId)
  const selectedContext = contexts.find(item => item.id === selectedContextId)
  const selectedAgent = agents.find(item => item.id === selectedAgentId)
  const visibleSessions = sessions
    .filter(item => item.context_id === selectedContextId && item.status === 'active')
    .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))
  const conversationEvents = useMemo(() => events.filter(event => eventKind(event) !== null), [events])
  const turnPending = pendingTurnSince !== null && !events.some(event => {
    if (!['chat/reply', 'chat/no_reply', 'chat/cancelled', 'runtime/response_protocol_fused'].includes(event.topic)) return false
    if (pendingRootTurnId !== null) {
      return event.payload.root_turn_id === pendingRootTurnId
    }
    const timestamp = new Date(event.timestamp).getTime()
    return Number.isFinite(timestamp) && timestamp >= pendingTurnSince - 1000
  })
  const toolTimeline = useMemo(() => {
    const calls = new Map<string, ToolTimelineItem>()
    for (const event of events) {
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
  }, [events])
  const objectives = contextView?.objectives ?? []
  const activeObjectives = objectives.filter(item => !terminalObjectiveStatuses.has(item.status))
  const runningObjectives = activeObjectives.filter(item => item.status === 'active')
  const blockedObjectives = activeObjectives.filter(item => item.status === 'blocked')
  const pausedObjectives = activeObjectives.filter(item => item.status === 'paused')
  const workItems = contextView?.active_work_items ?? []
  const workThreads = contextView?.work_threads ?? []
  const scheduledIntents = contextView?.scheduled_intents ?? []
  const liveWorkThreads = workThreads.filter(item => !terminalTaskStatuses.has(item.status))
  const runningWorkItems = workItems.filter(item => item.status === 'queued' || item.status === 'running')
  const liveBackgroundTasks = backgroundTasks.filter(item => !terminalTaskStatuses.has(item.status))
  const contextDelegations = delegations.filter(item => item.parent_context_id === selectedContextId)
  const liveDelegations = contextDelegations.filter(item => !terminalTaskStatuses.has(item.status))
  const runningDelegations = liveDelegations.filter(item => item.status === 'queued' || item.status === 'running')
  const activeWorkCount = liveWorkThreads.length
  const waitingCount = liveWorkThreads.filter(item => item.status === 'waiting').length
    + scheduledIntents.length
    + workItems.filter(item => item.status.startsWith('waiting')).length
    + runningObjectives.filter(item => Boolean(item.wait_condition)).length
  const selectedFrame = contextView?.state.frames.find(frame => frame.id === selectedFrameId)
  const retired = new Set(contextView?.state.retired ?? [])

  useEffect(() => {
    if (view === 'conversation') conversationEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [conversationEvents.length, turnPending, view])

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

  const sendMessage = async () => {
    const text = message.trim()
    if (!text || !selectedSessionId || sending) return
    setSending(true)
    setPendingTurnSince(Date.now())
    setPendingRootTurnId(null)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          text,
          client_message_id: `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        }),
      })
      if (!response.ok) throw new Error(`发送消息 HTTP ${response.status}`)
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
    if (!response.ok) setError(`取消 Session HTTP ${response.status}`)
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
      if (!response.ok) throw new Error(`调整推理深度 HTTP ${response.status}`)
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
          reason: '用户通过 Dashboard 显式恢复 Objective',
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `恢复 Objective HTTP ${response.status}`)
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
      `删除这个目标？\n\n${objective.stated_objective}\n\n删除会立即停止它的自动续跑；审计历史仍会保留。`,
    )
    if (!confirmed) return
    setDeletingObjectiveId(objective.id)
    try {
      const response = await fetch(`${CORE_HTTP_URL}/api/objectives/${encodeURIComponent(objective.id)}`, {
        method: 'DELETE',
        headers: apiHeaders(true),
        body: JSON.stringify({
          expected_revision: objective.revision,
          reason: '用户通过 Dashboard 删除 Objective',
        }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `删除 Objective HTTP ${response.status}`)
      }
      await loadSession(selectedSessionId, selectedContextId)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeletingObjectiveId('')
    }
  }

  const leadingEvaluation = runningWorkItems[0]
  const evaluationSummary = leadingEvaluation
    ? summarizeEvaluation(leadingEvaluation, events, toolTimeline).title
    : ''
  const taskStrip = liveBackgroundTasks[0]
    ? { state: 'running', label: '正在执行', summary: liveBackgroundTasks[0].command }
    : runningDelegations[0]
        ? { state: 'running', label: '正在委派', summary: runningDelegations[0].task }
        : waitingCount > 0
          ? { state: 'waiting', label: '等待事件', summary: scheduledIntents[0]?.intent ?? runningObjectives.find(item => item.wait_condition)?.stated_objective ?? '等待已登记的外部事件' }
          : blockedObjectives[0]
            ? { state: 'blocked', label: '目标受阻', summary: blockedObjectives[0].stated_objective }
            : pausedObjectives[0]
              ? { state: 'paused', label: '目标暂停', summary: pausedObjectives[0].stated_objective }
              : runningObjectives[0]
                ? { state: 'active', label: 'Objective 自动执行', summary: runningObjectives[0].stated_objective }
                : leadingEvaluation
                  ? {
                      state: 'running',
                      label: leadingEvaluation.status === 'queued' ? '等待模型' : '模型响应中',
                      summary: evaluationSummary,
                    }
                  : { state: 'idle', label: '空闲', summary: '当前没有进行中的工作' }
  const latestTurnEvent = !turnPending || pendingTurnSince === null ? undefined : [...events]
    .reverse()
    .find(event => pendingRootTurnId !== null
      ? event.payload.root_turn_id === pendingRootTurnId || event.id === pendingRootTurnId
      : new Date(event.timestamp).getTime() >= pendingTurnSince - 1000)
  const turnStatus = latestTurnEvent?.topic === 'runtime/tool_calls_selected'
    ? `正在执行 ${Array.isArray(latestTurnEvent.payload.calls) ? latestTurnEvent.payload.calls.length : ''} 个工具调用`
    : latestTurnEvent?.topic === 'chat/tool_output'
      ? `正在处理 ${String(latestTurnEvent.payload.tool_name ?? '工具')} 的结果`
      : latestTurnEvent?.topic === 'runtime/model_attempt_started'
        ? '模型正在求值'
        : '请求已接收，等待 Runtime 求值'

  return (
    <main className="page-shell" data-accent={accentTheme}>
      <section className="morphz-shell" data-accent={accentTheme} data-view={view}>
        <header className="runtime-header">
          <button className="brand" type="button" onClick={() => setView('conversation')}>
            <span className="brand-mark">◆</span>
            <span><strong>Morphz</strong><small>agent/{selectedAgent?.title ?? (selectedAgentId || 'default')}</small></span>
          </button>

          <div className="identity-trail">
            <button className="identity-chip" type="button" onClick={() => setView('mind')}>
              <small>CONTEXT</small>
              <strong>{selectedContext?.title ?? (selectedContextId || '—')}</strong>
              <span>shared · r{contextView?.state.version ?? 0}</span>
            </button>
            <span className="trail-separator">/</span>
            <div className="session-selector">
              <button className="identity-chip session-chip" type="button" onClick={() => setSessionMenuOpen(open => !open)}>
                <small>SESSION</small>
                <strong>{selectedSession?.title ?? (selectedSessionId || '—')}</strong>
                <span>{selectedSession?.attention_state ?? 'active'} · {shortId(selectedSessionId, 11)}</span>
                <ChevronDown size={13} />
              </button>
              {sessionMenuOpen && (
                <div className="session-popover">
                  <header><span>VISIBLE SESSIONS</span><strong>{visibleSessions.length} in this Context</strong></header>
                  <div className="session-options">
                    {visibleSessions.map(session => (
                      <button className={session.id === selectedSessionId ? 'is-current' : ''} key={session.id} type="button" onClick={() => chooseSession(session)}>
                        <i className={`presence ${session.attention_state ?? 'active'}`} />
                        <span><strong>{session.title}</strong><small>{shortId(session.id, 25)} · {formatAgo(session.last_activity_at)}</small></span>
                        <em>{session.id === selectedSessionId ? 'ACTIVE' : session.attention_state ?? 'RESIDENT'}</em>
                      </button>
                    ))}
                  </div>
                  <footer>Dashboard 只展示 Runtime API 当前允许读取的 Session</footer>
                </div>
              )}
            </div>
          </div>

          <div className="runtime-side">
            <div className="theme-selector">
              <button className="theme-button" type="button" aria-expanded={themeMenuOpen} onClick={() => setThemeMenuOpen(open => !open)}>
                <Palette size={15} />
                <span>{accentThemes.find(theme => theme.id === accentTheme)?.label}</span>
                <ChevronDown size={12} />
              </button>
              {themeMenuOpen && (
                <div className="theme-popover">
                  <header><span>ACCENT THEME</span><strong>仅影响当前浏览器</strong></header>
                  {accentThemes.map(theme => (
                    <button className={theme.id === accentTheme ? 'is-selected' : ''} key={theme.id} type="button" onClick={() => { setAccentTheme(theme.id); setThemeMenuOpen(false) }}>
                      <i className={`theme-swatch ${theme.id}`} />
                      <span><strong>{theme.label}</strong><small>{theme.description}</small></span>
                      <em>{theme.id === accentTheme ? 'ACTIVE' : ''}</em>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="mind-chip" type="button" onClick={() => setView(view === 'mind' ? 'conversation' : 'mind')}>
              <Brain size={15} />
              <span><small>MIND</small><strong>{contextView?.state.frames.length ?? 0} frames</strong></span>
              <i className={`pressure-${contextView?.pressure.level ?? 'normal'}`}>{contextView?.pressure.level ?? 'normal'}</i>
            </button>
            <label className="reasoning-control" title="只影响后续模型请求；默认表示由模型服务决定">
              <span>REASONING</span>
              <select
                aria-label="推理深度"
                disabled={changingReasoning}
                value={status?.reasoning_effort ?? 'default'}
                onChange={event => void changeReasoningEffort(event.target.value)}
              >
                <option value="default">默认</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
            <div className="model-meta">
              <span>{compactTokens(contextView?.pressure.estimated_tokens)} / {compactTokens(contextView?.pressure.hard_limit)}</span>
              <span>{status?.model ?? 'model unavailable'}</span>
            </div>
          </div>
        </header>

        <div className="view-frame">
          {view === 'conversation' && (
            <section className="conversation-view">
              <header className="section-heading"><span>SESSION · {selectedSession?.title ?? shortId(selectedSessionId)}</span><strong>对话与执行互不阻塞</strong></header>
              <div className="message-list">
                {conversationEvents.length === 0 && (
                  <div className="empty-state conversation-empty">
                    <MessageSquare size={28} />
                    <strong>这个 Session 还没有对话</strong>
                    <span>消息会进入共享认知 Context，但回复始终路由回当前 Session。</span>
                  </div>
                )}
                {conversationEvents.map(event => {
                  const kind = eventKind(event) ?? 'system'
                  if (kind === 'progress') {
                    return <div className="progress-note" key={event.id}><i /> <span>{event.payload.text}</span><time>{formatTime(event.timestamp)}</time></div>
                  }
                  const threadKind = typeof event.payload.thread_kind === 'string' ? event.payload.thread_kind : 'dialogue'
                  const role = kind === 'user'
                    ? 'You'
                    : kind === 'agent'
                      ? 'Morphz'
                      : kind === 'background'
                        ? threadKind === 'objective' ? 'Objective' : 'Work'
                        : 'Runtime'
                  return (
                    <article className={`message-row ${kind}`} key={event.id}>
                      <div className="message-role"><strong>{role}</strong><time>{formatTime(event.timestamp)}</time>{kind === 'background' && <small>{shortId(String(event.payload.root_turn_id ?? ''), 18)}</small>}</div>
                      <div className="message-body">{event.payload.text ?? '（无文本）'}</div>
                    </article>
                  )
                })}
                {turnPending && (
                  <div className="turn-pending" role="status" aria-live="polite">
                    <LoaderCircle size={14} />
                    <span><strong>{turnStatus}</strong><small>你可以继续发送消息，当前执行不会阻塞对话。</small></span>
                    <i><b /><b /><b /></i>
                  </div>
                )}
                <div ref={conversationEnd} />
              </div>
            </section>
          )}

          {view === 'work' && (
            <section className="work-view">
              <header className="workspace-heading">
                <div><span>RUNTIME TASKS</span><h1>任务与执行</h1><p>这里只展示 Runtime 可验证的 Objective、求值、后台进程和 Delegation；普通 Frame 不会被猜成任务。</p></div>
                <button type="button" onClick={() => void loadSession(selectedSessionId, selectedContextId)}><RefreshCw size={14} /> 刷新</button>
              </header>

              <div className="work-metrics">
                <div><CircleDot size={17} /><span><small>ACTIVE</small><strong>{activeWorkCount}</strong></span></div>
                <div><Clock3 size={17} /><span><small>WAITING</small><strong>{waitingCount}</strong></span></div>
                <div><Layers3 size={17} /><span><small>OBJECTIVES</small><strong>{activeObjectives.length}</strong></span></div>
                <div><GitBranch size={17} /><span><small>DELEGATIONS</small><strong>{liveDelegations.length}</strong></span></div>
              </div>

              <section className="objective-board">
                <header><span>OBJECTIVES</span><b>{activeObjectives.length}</b><small>先确认目标与状态，再查看执行轨迹</small></header>
                <div className="objective-grid">
                  {activeObjectives.map(objective => (
                    <article className="work-card" key={objective.id}>
                      <div className="card-line"><span className={`status-pill ${objective.status}`}>{statusLabel(objective.status)}</span><time>{formatAgo(objective.updated_at)}</time></div>
                      <h2>{objective.stated_objective}</h2>
                      {objective.status_reason && <p>{objective.status_reason}</p>}
                      <footer><span>r{objective.revision}</span><span>{compactTokens(objective.tokens_used)} tok</span><span>{objective.time_used_seconds}s</span><span>{shortId(objective.coordinator_session_id)}</span></footer>
                      {objective.wait_condition && <div className="wait-condition">等待 · {objective.wait_condition.kind}</div>}
                      <div className="objective-actions">
                        {(objective.status === 'blocked' || objective.status === 'paused') && (
                          <button
                            className="resume-objective"
                            disabled={Boolean(resumingObjectiveId || deletingObjectiveId)}
                            type="button"
                            onClick={() => void resumeObjective(objective)}
                          >
                            {resumingObjectiveId === objective.id ? <LoaderCircle size={13} /> : <Play size={13} />}
                            {resumingObjectiveId === objective.id ? '正在恢复' : '恢复并继续'}
                          </button>
                        )}
                        <button
                          className="delete-objective"
                          disabled={Boolean(resumingObjectiveId || deletingObjectiveId)}
                          type="button"
                          onClick={() => void deleteObjective(objective)}
                        >
                          {deletingObjectiveId === objective.id ? <LoaderCircle size={13} /> : <Trash2 size={13} />}
                          {deletingObjectiveId === objective.id ? '正在删除' : '删除目标'}
                        </button>
                      </div>
                    </article>
                  ))}
                  {activeObjectives.length === 0 && <div className="small-empty">没有非终态 Objective</div>}
                </div>
              </section>

              <section className="scheduler-board">
                <header><span>THREAD SCHEDULER</span><b>{liveWorkThreads.length}</b><small>{scheduledIntents.length} 条排队 / 定时意图 · Runtime 权威状态</small></header>
                <div className="scheduler-grid">
                  <div className="scheduler-lane">
                    <header>WORK THREADS</header>
                    {liveWorkThreads.map(thread => (
                      <article className="scheduler-row" key={thread.id}>
                        <span className={`status-pill ${thread.status}`}>{statusLabel(thread.status)}</span>
                        <div><strong>{thread.kind} thread</strong><small>{shortId(thread.id, 28)} · Session {shortId(thread.session_id, 18)}</small></div>
                        <em>r{thread.revision}</em>
                      </article>
                    ))}
                    {liveWorkThreads.length === 0 && <div className="small-empty">没有非终态 Work Thread</div>}
                  </div>
                  <div className="scheduler-lane">
                    <header>SCHEDULED INTENTS</header>
                    {scheduledIntents.map(intent => (
                      <article className="scheduler-row intent" key={intent.id}>
                        <Clock3 size={14} />
                        <div><strong>{intent.intent}</strong><small>{intent.not_before ? new Date(intent.not_before).toLocaleString() : '立即'}{intent.interval_seconds ? ` · 每 ${intent.interval_seconds}s` : ''}{intent.dependency_thread_ids.length ? ` · 等待 ${intent.dependency_thread_ids.length} 个 Thread` : ''}</small></div>
                        <em>{shortId(intent.thread_id, 16)}</em>
                      </article>
                    ))}
                    {scheduledIntents.length === 0 && <div className="small-empty">没有排队或定时意图</div>}
                  </div>
                </div>
              </section>

              <section className="tool-timeline">
                <header><span>TOOL CALL TIMELINE</span><b>{toolTimeline.length}</b><small>Runtime 真实执行事件 · 列表内滚动</small></header>
                <div
                  className="tool-timeline-list"
                  ref={toolTimelineList}
                  tabIndex={0}
                  aria-label="工具调用时间线，可在区域内滚动"
                  onScroll={event => {
                    const list = event.currentTarget
                    toolTimelinePinnedToEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
                  }}
                >
                  {toolTimeline.map(call => {
                    const failed = ['error', 'timeout', 'rejected', 'failed'].includes(call.status)
                    const summary = summarizeToolCall(call.name, call.arguments)
                    return (
                      <details className={`tool-step ${failed ? 'failed' : call.status === 'running' ? 'running' : 'completed'}`} key={call.id} open={call.status === 'running'}>
                        <summary>
                          <i>{call.status === 'running' ? <LoaderCircle size={13} /> : failed ? '!' : '✓'}</i>
                          <span className="tool-step-summary">
                            <strong>{summary.title}</strong>
                            <small>{summary.target}</small>
                            <code>{summary.detail} · {shortId(call.id, 20)}</code>
                          </span>
                          <em>{statusLabel(call.status)}</em>
                          <time>{formatTime(call.timestamp)}</time>
                          <ChevronDown size={13} />
                        </summary>
                        <div className="tool-step-detail">
                          <section><header>PARAMETERS {call.truncated ? `· 原始 ${call.arguments_chars ?? '?'} 字符` : ''}</header><pre>{call.arguments}</pre></section>
                          {call.result !== undefined && <section><header>RESULT · {call.status}</header><pre>{call.result.slice(0, 6000) || '（工具没有输出）'}</pre></section>}
                        </div>
                      </details>
                    )
                  })}
                  {toolTimeline.length === 0 && <div className="small-empty">当前 Session 还没有工具调用记录</div>}
                </div>
              </section>

              <div className="work-columns">
                <div className="work-column">
                  <header><span>EVALUATIONS</span><b>{workItems.length}</b></header>
                  {workItems.map(item => {
                    const summary = summarizeEvaluation(item, events, toolTimeline)
                    return (
                      <article className="work-card compact" key={item.id}>
                        <div className="card-line"><span className={`status-pill ${item.status}`}>{statusLabel(item.status)}</span><time>{formatAgo(item.updated_at)}</time></div>
                        <h2>{summary.title}</h2>
                        <div className={`thread-badge ${summary.threadKind}`}>
                          <GitBranch size={12} />
                          <strong>{summary.threadKind} thread</strong>
                          <span>{shortId(summary.threadId, 24)}</span>
                          <small>{summary.threadDetail}</small>
                        </div>
                        <footer><span>{item.trigger_kind}</span><span>r{item.revision}</span><span>{shortId(item.id)}</span></footer>
                      </article>
                    )
                  })}
                  {workItems.length === 0 && <div className="small-empty">没有活跃求值</div>}
                </div>

                <div className="work-column">
                  <header><span>BACKGROUND TASKS</span><b>{backgroundTasks.length}</b></header>
                  {backgroundTasks.slice(0, 20).map(task => (
                    <article className="work-card task-card" key={task.task_id}>
                      <div className="card-line"><span className={`status-pill ${task.status}`}>{statusLabel(task.status)}</span><time>{task.elapsed_secs}s</time></div>
                      <h2><Terminal size={14} /> {task.command}</h2>
                      {task.output_tail && <pre>{task.output_tail.slice(-700)}</pre>}
                      <footer><span>{shortId(task.session_id)}</span><span>{compactTokens(task.output_bytes)} bytes</span><span>{task.effective_boundary?.sandbox_backend ?? task.sandbox_backend}</span></footer>
                    </article>
                  ))}
                  {backgroundTasks.length === 0 && <div className="small-empty">没有后台进程记录</div>}

                  <header className="subsection"><span>DELEGATIONS</span><b>{contextDelegations.length}</b></header>
                  {contextDelegations.slice(0, 20).map(delegation => (
                    <article className="work-card compact" key={delegation.id}>
                      <div className="card-line"><span className={`status-pill ${delegation.status}`}>{statusLabel(delegation.status)}</span><time>{formatAgo(delegation.updated_at)}</time></div>
                      <h2>{delegation.task}</h2>
                      <footer><span>{shortId(delegation.parent_session_id)}</span><span>→</span><span>{shortId(delegation.child_session_id)}</span></footer>
                    </article>
                  ))}
                  {contextDelegations.length === 0 && <div className="small-empty">没有 Delegation</div>}
                </div>
              </div>
            </section>
          )}

          {view === 'mind' && (
            <section className="mind-view">
              <header className="workspace-heading">
                <div><span>COGNITIVE CONTEXT</span><h1>共享认知</h1><p>Frame 的业务结构由 Agent 自主形成；Runtime 只呈现身份、来源、版本、关系与生命周期。</p></div>
                <button type="button" onClick={() => setView('conversation')}><ArrowLeft size={14} /> 返回对话</button>
              </header>

              <div className="mind-metrics">
                <div><Brain size={18} /><span><small>FRAMES</small><strong>{contextView?.state.frames.length ?? 0}</strong></span></div>
                <div><GitBranch size={18} /><span><small>RELATIONS</small><strong>{contextView?.state.relations.length ?? 0}</strong></span></div>
                <div><Database size={18} /><span><small>OBSERVATIONS</small><strong>{contextView?.observations.length ?? 0}</strong></span></div>
                <div><Layers3 size={18} /><span><small>RESIDENT SESSIONS</small><strong>{contextView?.session_working_set.full_session_ids.length ?? 0}</strong></span></div>
              </div>

              <div className="mind-grid">
                <div className="frame-library">
                  <header><span>FRAME LIBRARY</span><b>r{contextView?.state.version ?? 0}</b></header>
                  <div className="frame-list">
                    {(contextView?.state.frames ?? []).map(frame => (
                      <button className={frame.id === selectedFrameId ? 'is-selected' : ''} key={frame.id} type="button" onClick={() => setSelectedFrameId(frame.id)}>
                        <span><strong>{frame.id}</strong><small>r{frame.revision} · v{frame.updated_version} · {frame.sources.length} sources</small></span>
                        {retired.has(frame.id) && <em>RETIRED</em>}
                      </button>
                    ))}
                  </div>
                </div>

                <article className="frame-inspector">
                  {selectedFrame ? (
                    <>
                      <header><span><small>FRAME</small><strong>{selectedFrame.id}</strong></span><em>revision {selectedFrame.revision}</em></header>
                      <pre>{selectedFrame.body}</pre>
                      <div className="frame-meta">
                        <div><small>CREATED</small><strong>v{selectedFrame.created_version}</strong></div>
                        <div><small>UPDATED</small><strong>v{selectedFrame.updated_version}</strong></div>
                        <div><small>SOURCES</small><strong>{selectedFrame.sources.length}</strong></div>
                        <div><small>PROTECTED</small><strong>{contextView?.state.protected.includes(selectedFrame.id) ? 'yes' : 'no'}</strong></div>
                      </div>
                      {selectedFrame.sources.length > 0 && <div className="source-list">{selectedFrame.sources.map(source => <span key={source}>{source}</span>)}</div>}
                      <section className="relations"><h3>RELATIONS</h3>{(contextView?.state.relations ?? []).filter(item => item.subject === selectedFrame.id || item.object === selectedFrame.id).map((item, index) => <div key={`${item.subject}-${item.relation}-${item.object}-${index}`}><span>{item.subject}</span><b>{item.relation}</b><span>{item.object}</span></div>)}</section>
                    </>
                  ) : <div className="small-empty">还没有可查看的 Frame</div>}
                </article>
              </div>

              <section className="context-facts">
                <div><small>SESSION WINDOW</small><strong>{Math.round((contextView?.session_working_set.active_window_secs ?? 0) / 3600)}h</strong><span>最多 {contextView?.session_working_set.max_sessions ?? 0} 个完整 Session</span></div>
                <div><small>PRESSURE</small><strong>{contextView?.pressure.level ?? '—'}</strong><span>{contextView?.pressure.token_accuracy ?? 'estimate'}</span></div>
                <div><small>CHECKPOINTS</small><strong>{contextView?.state.checkpoints.length ?? 0}</strong><span>Agent 显式维护</span></div>
                <div><small>RETIRED</small><strong>{contextView?.state.retired.length ?? 0}</strong><span>可恢复，未删除 Ledger</span></div>
              </section>
            </section>
          )}
        </div>

        <footer className="composer-area">
          <div className="composer-status">
            <button className={`composer-task-status ${taskStrip.state}`} type="button" onClick={() => setView('work')} title="打开任务视图 (Ctrl+T)">
              <i className={activeWorkCount || turnPending ? 'busy' : taskStrip.state} />
              <strong>{turnPending ? turnStatus : taskStrip.label}</strong>
              {!turnPending && <span>{taskStrip.summary}</span>}
              <em>{activeWorkCount} 执行 · {waitingCount} 等待</em>
            </button>
            <span>{wsStatus === 'connected' ? 'live' : wsStatus} · 当前 Session · {activeObjectives.length} 个 Objective</span>
          </div>
          <div className="composer">
            <span className="composer-prompt">›</span>
            <textarea
              aria-label="发送消息"
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
              placeholder={selectedSessionId ? '输入消息…' : '请选择 Session'}
              rows={1}
              value={message}
            />
            {activeWorkCount > 0 ? (
              <button className="cancel-button" type="button" title="取消当前 Session 执行" onClick={() => void cancelCurrentSession()}><Square size={14} /></button>
            ) : null}
            <button className="send-button" disabled={!message.trim() || sending || !selectedSessionId} type="button" onClick={() => void sendMessage()}><Send size={15} /><span>发送</span></button>
          </div>
          <div className="shortcut-row"><span>Enter 发送</span><span>Shift+Enter 换行</span><span>Ctrl+T 任务</span><span>Ctrl+M 认知</span><span>Esc 返回对话</span></div>
          {error && <div className="error-banner">{error}</div>}
        </footer>
      </section>
    </main>
  )
}
