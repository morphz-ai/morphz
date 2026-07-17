export type ModelStreamEvent =
  | { kind: 'started' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'reasoning_summary_delta'; text: string }
  | { kind: 'tool_call_started'; index: number; id: string; name: string }
  | { kind: 'tool_arguments_delta'; index: number; delta: string }
  | { kind: 'tool_call_completed'; index: number }
  | { kind: 'usage'; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string }

export interface LiveModelAttempt {
  attemptId: string
  activationId: string
  threadKind: string
  text: string
  reasoningSummary: string
  startedAt: string
  lastEventMs: number
  status: 'streaming' | 'settling' | 'failed'
  toolCallCount: number
  reasoningSummaryPersisted: boolean
  responseResolved: boolean
  error?: string
}

export interface LiveModelState {
  sessionId: string
  attempts: Record<string, LiveModelAttempt>
}

export interface ModelStreamBatchItem {
  attemptId: string
  activationId: string
  threadKind: string
  timestamp: string
  stream: ModelStreamEvent
}

export type ModelStreamAction =
  | { type: 'reset_session'; sessionId: string }
  | { type: 'stream_batch'; sessionId: string; items: ModelStreamBatchItem[]; nowMs: number }
  | { type: 'resolve'; sessionId: string; causalId: string; nowMs: number }
  | { type: 'persisted'; sessionId: string; causalId: string }
  | { type: 'reconcile'; sessionId: string; activeActivationIds: string[]; cutoffMs: number }

export interface DurableReasoningSummary {
  eventId: string
  attemptId: string
  activationId: string
  threadKind: string
  text: string
  complete: boolean
  timestamp: string
}

interface ReasoningSummaryEvent {
  id: string
  timestamp: string
  topic: string
  payload: Record<string, unknown>
}

interface PreferenceStorage {
  getItem(key: string): string | null
}

export const reasoningSummaryStorageKey = 'morphz.dashboard.showReasoningSummary'

export function readReasoningSummaryPreference(storage?: PreferenceStorage): boolean {
  if (!storage) return false
  try {
    return storage.getItem(reasoningSummaryStorageKey) === 'true'
  } catch {
    return false
  }
}

export function createLiveModelState(sessionId = ''): LiveModelState {
  return { sessionId, attempts: {} }
}

export function isModelStreamEvent(value: unknown): value is ModelStreamEvent {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && [
    'started',
    'text_delta',
    'reasoning_summary_delta',
    'tool_call_started',
    'tool_arguments_delta',
    'tool_call_completed',
    'usage',
    'completed',
    'failed',
  ].includes(kind)
}

function reduceAttempt(
  previous: Record<string, LiveModelAttempt>,
  item: ModelStreamBatchItem,
  nowMs: number,
): Record<string, LiveModelAttempt> {
  const { attemptId, activationId, threadKind, timestamp, stream } = item
  if (stream.kind === 'started') {
    return {
      ...previous,
      [attemptId]: {
        attemptId,
        activationId,
        threadKind,
        text: '',
        reasoningSummary: '',
        startedAt: timestamp,
        lastEventMs: nowMs,
        status: 'streaming',
        toolCallCount: 0,
        reasoningSummaryPersisted: false,
        responseResolved: false,
      },
    }
  }

  const current = previous[attemptId]
  // A browser reconnecting mid-response can receive a suffix without its
  // prefix. Only `started` establishes a trustworthy draft bucket.
  if (!current) return previous

  if (stream.kind === 'text_delta') {
    return {
      ...previous,
      [attemptId]: { ...current, text: current.text + stream.text, lastEventMs: nowMs, status: 'streaming' },
    }
  }
  if (stream.kind === 'reasoning_summary_delta') {
    return {
      ...previous,
      [attemptId]: {
        ...current,
        reasoningSummary: current.reasoningSummary + stream.text,
        lastEventMs: nowMs,
        status: 'streaming',
      },
    }
  }
  if (stream.kind === 'tool_call_started') {
    return {
      ...previous,
      [attemptId]: { ...current, toolCallCount: current.toolCallCount + 1, lastEventMs: nowMs, status: 'streaming' },
    }
  }
  if (stream.kind === 'completed') {
    return { ...previous, [attemptId]: { ...current, lastEventMs: nowMs, status: 'settling' } }
  }
  if (stream.kind === 'failed') {
    return { ...previous, [attemptId]: { ...current, lastEventMs: nowMs, status: 'failed', error: stream.message } }
  }
  return { ...previous, [attemptId]: { ...current, lastEventMs: nowMs } }
}

function matchesCausalId(attempt: LiveModelAttempt, causalId: string): boolean {
  return attempt.attemptId === causalId || attempt.activationId === causalId
}

function resolveAttempt(
  previous: Record<string, LiveModelAttempt>,
  causalId: string,
  nowMs: number,
): Record<string, LiveModelAttempt> {
  let changed = false
  const entries = Object.entries(previous).flatMap(([id, attempt]) => {
    if (!matchesCausalId(attempt, causalId)) return [[id, attempt] as const]
    changed = true
    // The public draft is now durable in chat/reply and must disappear. Keep
    // a summary-only shell until runtime/model_reasoning_summary arrives so a
    // terminal reply cannot make the summary flash away.
    if (attempt.reasoningSummary.trim()) {
      if (attempt.reasoningSummaryPersisted) return []
      return [[id, {
        ...attempt,
        text: '',
        status: 'settling' as const,
        lastEventMs: nowMs,
        responseResolved: true,
      }] as const]
    }
    return []
  })
  return changed ? Object.fromEntries(entries) : previous
}

function persistAttempt(
  previous: Record<string, LiveModelAttempt>,
  causalId: string,
): Record<string, LiveModelAttempt> {
  let changed = false
  const entries = Object.entries(previous).flatMap(([id, attempt]) => {
    if (!matchesCausalId(attempt, causalId)) return [[id, attempt] as const]
    changed = true
    if (attempt.responseResolved) return []
    return [[id, { ...attempt, reasoningSummaryPersisted: true }] as const]
  })
  return changed ? Object.fromEntries(entries) : previous
}

export function modelStreamReducer(state: LiveModelState, action: ModelStreamAction): LiveModelState {
  if (action.type === 'reset_session') return createLiveModelState(action.sessionId)
  if (action.sessionId !== state.sessionId) return state

  if (action.type === 'stream_batch') {
    const attempts = action.items.reduce(
      (next, item) => reduceAttempt(next, item, action.nowMs),
      state.attempts,
    )
    return attempts === state.attempts ? state : { ...state, attempts }
  }
  if (action.type === 'resolve') {
    const attempts = resolveAttempt(state.attempts, action.causalId, action.nowMs)
    return attempts === state.attempts ? state : { ...state, attempts }
  }
  if (action.type === 'persisted') {
    const attempts = persistAttempt(state.attempts, action.causalId)
    return attempts === state.attempts ? state : { ...state, attempts }
  }

  const activeActivationIds = new Set(action.activeActivationIds)
  const entries = Object.entries(state.attempts).filter(([, attempt]) => (
    activeActivationIds.has(attempt.activationId) || attempt.lastEventMs >= action.cutoffMs
  ))
  return entries.length === Object.keys(state.attempts).length
    ? state
    : { ...state, attempts: Object.fromEntries(entries) }
}

export function visibleLiveModelAttempts(
  state: LiveModelState,
  selectedSessionId: string,
): Record<string, LiveModelAttempt> {
  return state.sessionId === selectedSessionId ? state.attempts : {}
}

export function selectDurableReasoningSummaries(
  events: ReasoningSummaryEvent[],
): DurableReasoningSummary[] {
  const byAttempt = new Map<string, DurableReasoningSummary>()
  for (const event of events) {
    if (event.topic !== 'runtime/model_reasoning_summary') continue
    const attemptId = typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : ''
    const activationId = typeof event.payload.activation_id === 'string' ? event.payload.activation_id : attemptId
    const threadKind = typeof event.payload.thread_kind === 'string' ? event.payload.thread_kind : 'dialogue_turn'
    const text = typeof event.payload.text === 'string' ? event.payload.text : ''
    if (!attemptId || !text.trim()) continue
    byAttempt.set(attemptId, {
      eventId: event.id,
      attemptId,
      activationId,
      threadKind,
      text,
      complete: event.payload.complete !== false,
      timestamp: event.timestamp,
    })
  }
  return [...byAttempt.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}

/** Physical attempts which Runtime continued as one logical reasoning flow. */
export function selectReasoningContinuationSummaries(
  events: ReasoningSummaryEvent[],
): DurableReasoningSummary[] {
  const continuedAttempts = new Set<string>()
  for (const event of events) {
    if (event.topic !== 'runtime/response_protocol_error'
      && event.topic !== 'runtime/reasoning_continuation') continue
    const responseState = typeof event.payload.response_state === 'string'
      ? event.payload.response_state
      : ''
    const reason = typeof event.payload.reason === 'string' ? event.payload.reason : ''
    if (event.topic !== 'runtime/reasoning_continuation'
      && responseState !== 'reasoning_only'
      && reason !== '模型返回空响应') continue
    const attemptId = typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : ''
    if (attemptId) continuedAttempts.add(attemptId)
  }
  return selectDurableReasoningSummaries(events)
    .filter(summary => continuedAttempts.has(summary.attemptId))
}

export function findReasoningSummaryChainForPayload(
  summaries: DurableReasoningSummary[],
  continuations: DurableReasoningSummary[],
  payload: Record<string, unknown>,
): DurableReasoningSummary[] {
  let terminal = findReasoningSummaryForPayload(summaries, payload)
  const activationId = typeof payload.activation_id === 'string'
    ? payload.activation_id
    : terminal?.activationId ?? ''
  const chain = activationId
    ? continuations.filter(summary => summary.activationId === activationId)
    : []
  // Legacy tool-call events predate model_attempt_id and identify only the
  // logical Activation. When a continuation exists, its last physical
  // attempt is the summary that produced the tool call.
  if (activationId && typeof payload.model_attempt_id !== 'string' && chain.length > 0) {
    terminal = summaries
      .filter(summary => summary.activationId === activationId)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0]
  }
  if (terminal && !chain.some(summary => summary.attemptId === terminal.attemptId)) {
    chain.push(terminal)
  }
  return chain.sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}

export function liveReasoningSummaryText(
  continuations: DurableReasoningSummary[],
  attempt: LiveModelAttempt,
): string {
  const durablePrefix = continuations
    .filter(summary => (
      summary.activationId === attempt.activationId
      && summary.attemptId !== attempt.attemptId
    ))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map(summary => summary.text)
    .join('')
  return durablePrefix + attempt.reasoningSummary
}

export function groupReasoningSummariesByActivation(
  summaries: DurableReasoningSummary[],
): DurableReasoningSummary[] {
  const grouped = new Map<string, DurableReasoningSummary>()
  for (const summary of [...summaries].sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
    const previous = grouped.get(summary.activationId)
    grouped.set(summary.activationId, previous
      ? { ...summary, text: previous.text + summary.text }
      : summary)
  }
  return [...grouped.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}

export function findReasoningSummaryForPayload(
  summaries: DurableReasoningSummary[],
  payload: Record<string, unknown>,
): DurableReasoningSummary | undefined {
  const modelAttemptId = typeof payload.model_attempt_id === 'string' ? payload.model_attempt_id : ''
  const attemptId = typeof payload.attempt_id === 'string' ? payload.attempt_id : ''
  const activationId = typeof payload.activation_id === 'string' ? payload.activation_id : ''
  const newestFirst = [...summaries].reverse()
  if (modelAttemptId) {
    // New Runtime events identify the exact physical Model Attempt which
    // produced this outcome. If that attempt emitted no summary, showing a
    // failed protocol retry's older summary would be actively misleading.
    return newestFirst.find(summary => summary.attemptId === modelAttemptId)
  }
  const exactAttempt = attemptId
    ? newestFirst.find(summary => summary.attemptId === attemptId)
    : undefined
  if (exactAttempt) return exactAttempt
  return activationId
    ? newestFirst.find(summary => summary.activationId === activationId)
    : undefined
}
