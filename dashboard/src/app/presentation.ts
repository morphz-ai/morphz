import type { TFunction } from 'i18next'
import type { ThreadRecord } from '../scheduler/types'

export interface ToolCallSummary {
  title: string
  target: string
  detail: string
}

export interface PresentedToolCall {
  id: string
  name: string
  arguments: string
  arguments_chars?: number
  truncated?: boolean
}

export type ConversationEventKind = 'user' | 'agent' | 'background' | 'progress' | 'reasoning' | 'system'
export type ConversationLane = 'dialogue' | 'execution_output'
export type ConversationWindowLane = 'merged' | ConversationLane

export interface ConversationPresentationEvent {
  topic: string
  payload: Record<string, unknown>
}

export interface DelegatedContextReference {
  child_context_id?: string
}

const objectiveExecutionWaitKinds = new Set(['thread_group', 'tool_task', 'delegation'])

export function objectiveWaitRepresentsExecution(
  waitCondition?: { kind?: string } | null,
): boolean {
  return objectiveExecutionWaitKinds.has(waitCondition?.kind ?? '')
}

export function objectiveDisplayStatus(objective: {
  status: string
  wait_condition?: { kind?: string } | null
}): string {
  if (objective.status !== 'active' || !objective.wait_condition) return objective.status
  return objectiveWaitRepresentsExecution(objective.wait_condition) ? 'running' : 'waiting'
}

export function delegatedContextIds(
  delegations: ReadonlyArray<DelegatedContextReference>,
  candidateContextIds: ReadonlyArray<string> = [],
): ReadonlySet<string> {
  const ids = new Set(
    delegations
      .map(delegation => delegation.child_context_id?.trim() ?? '')
      .filter(Boolean),
  )
  // Delegation rows describe the live relationship, but old or interrupted
  // recovery paths can leave an active child Context after that row has gone.
  // Runtime-issued child Context ids retain their origin, so keep those
  // orphaned Contexts grouped with sub-agents without inventing Delegation
  // state that no longer exists.
  for (const contextId of candidateContextIds) {
    const normalized = contextId.trim()
    if (normalized.startsWith('delegate-context-')) ids.add(normalized)
  }
  return ids
}

export function conversationEventKind(
  topic: string,
  payload: Record<string, unknown>,
): ConversationEventKind | null {
  if (topic === 'chat/user_message') return 'user'
  if (topic === 'chat/reply') {
    // `thread_kind` is causal provenance, not presentation semantics. A
    // tool-assisted reply can originate from an Execution Thread while still
    // being the ordinary answer to the active user turn. Only an explicit
    // asynchronous Delivery gets a result card. The thread_kind fallback also
    // renders legacy persisted Delivery events correctly.
    const deliveryKind = typeof payload.delivery_kind === 'string' ? payload.delivery_kind : ''
    const threadKind = typeof payload.thread_kind === 'string' ? payload.thread_kind : 'dialogue_turn'
    return deliveryKind === 'thread_delivery' || (!deliveryKind && threadKind === 'delivery')
      ? 'background'
      : 'agent'
  }
  if (topic === 'chat/outbound_message') return 'agent'
  if (topic === 'chat/progress') return 'progress'
  if (topic === 'chat/assistant_call' && payload.terminal_outcome !== true) return 'reasoning'
  if (topic === 'chat/cancelled') return 'system'
  return null
}

export function conversationEventLane(
  topic: string,
  payload: Record<string, unknown>,
): ConversationLane | null {
  const kind = conversationEventKind(topic, payload)
  if (kind === null) return null
  return kind === 'background' || kind === 'progress' || kind === 'reasoning'
    ? 'execution_output'
    : 'dialogue'
}

export function newestConversationEventsForLane<T extends ConversationPresentationEvent>(
  events: ReadonlyArray<T>,
  lane: ConversationWindowLane,
  count: number,
): T[] {
  const laneEvents = lane === 'merged'
    ? events
    : events.filter(event => conversationEventLane(event.topic, event.payload) === lane)
  return laneEvents.slice(-Math.max(0, count))
}

export function formatTime(value: string | undefined, locale: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([locale], { hour: '2-digit', minute: '2-digit' })
}

/** Format an instant as RFC 3339 in the browser's local time zone. */
export function formatLocalRfc3339(value: Date | string = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
}

export function formatAgo(value: string | undefined, t: TFunction) {
  if (!value) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return t('time.ago.seconds', { count: seconds })
  if (seconds < 3600) return t('time.ago.minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('time.ago.hours', { count: Math.floor(seconds / 3600) })
  return t('time.ago.days', { count: Math.floor(seconds / 86400) })
}

export function compactTokens(value?: number) {
  if (value === undefined) return '—'
  if (value < 1000) return String(value)
  return `${Math.round(value / 100) / 10}k`
}

export function shortId(value?: string, size = 15) {
  if (!value) return '—'
  if (value.length <= size) return value
  return `…${value.slice(-(size - 1))}`
}

export function statusLabel(value: string, t: TFunction) {
  const key = `status.${value}`
  const translated = t(key)
  return translated === key ? value : translated
}

export function threadKindLabel(kind: ThreadRecord['kind'], t: TFunction) {
  return t(`work.threadKind.${kind}`)
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

/**
 * Assistant Call events use the provider-shaped `function` envelope while
 * Runtime selection events use a flattened call. Normalising both here keeps
 * the execution lane independent from provider wire formats.
 */
export function assistantToolCalls(payload: Record<string, unknown>): PresentedToolCall[] {
  // A normal Assistant Call uses `tool_calls`; a continued reasoning attempt
  // is persisted as `continuation_tool_calls`. Both describe the same durable
  // call lifecycle and must survive a Dashboard refresh.
  const rawCalls = [
    ...(Array.isArray(payload.tool_calls) ? payload.tool_calls : []),
    ...(Array.isArray(payload.continuation_tool_calls) ? payload.continuation_tool_calls : []),
  ]
  if (rawCalls.length === 0) return []
  const calls: PresentedToolCall[] = []
  const seen = new Set<string>()
  for (const value of rawCalls) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const call = value as Record<string, unknown>
    const functionValue = call.function && typeof call.function === 'object' && !Array.isArray(call.function)
      ? call.function as Record<string, unknown>
      : {}
    const id = typeof call.id === 'string' ? call.id.trim() : ''
    const nameValue = typeof call.name === 'string' ? call.name : functionValue.name
    const argumentsValue = typeof call.arguments === 'string' ? call.arguments : functionValue.arguments
    const name = typeof nameValue === 'string' ? nameValue.trim() : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    calls.push({
      id,
      name,
      arguments: typeof argumentsValue === 'string' ? argumentsValue : '{}',
      arguments_chars: typeof call.arguments_chars === 'number' ? call.arguments_chars : undefined,
      truncated: typeof call.truncated === 'boolean' ? call.truncated : undefined,
    })
  }
  return calls
}

function stringField(value: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const field = value[name]
    if (typeof field === 'string' && field.trim()) return field.trim()
  }
  return ''
}

export function summarizeToolCall(name: string, rawArguments: string, t: TFunction): ToolCallSummary {
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
    case 'check_task_after':
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
