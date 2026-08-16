import { assistantToolCalls, type PresentedToolCall } from './presentation.ts'

export interface ToolTimelineEvent {
  timestamp: string
  type?: string
  topic: string
  payload: Record<string, unknown>
}

export interface ToolTimelineItem extends PresentedToolCall {
  timestamp: string
  status: string
  result?: string
}

export interface ExecutionTargetLabelSource {
  id: string
  name: string
  kind: string
  metadata?: Record<string, unknown>
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function sshPort(value: unknown): number | undefined {
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

/** Operator-facing label for a physical execution target. */
export function executionTargetLabel(target: ExecutionTargetLabelSource): string {
  const name = target.name.trim()
  if (target.kind !== 'managed_ssh') return name || target.id

  const host = nonEmptyString(target.metadata?.host)
  const user = nonEmptyString(target.metadata?.user)
  const port = sshPort(target.metadata?.port)
  if (host) {
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    const destination = user ? `${user}@${formattedHost}` : formattedHost
    return port && port !== 22 ? `${destination}:${port}` : destination
  }

  const legacyName = name.replace(/^SSH\s+/i, '').replace(/:22$/, '')
  return legacyName || 'SSH'
}

function toolArgumentsQuality(call: PresentedToolCall): number {
  if (!call.arguments.trim() || call.arguments.trim() === '{}') return 0
  return call.truncated === true ? 1 : 2
}

/** Runtime-owned target identities carried by a physical tool invocation. */
export function executionTargetIds(argumentsText: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(argumentsText)
  } catch {
    return []
  }
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return []
  const object = value as Record<string, unknown>
  const ids = [object.target, object.target_id, object.execution_target_id]
  for (const endpoint of [object.source, object.destination]) {
    if (typeof endpoint === 'object' && endpoint != null && !Array.isArray(endpoint)) {
      ids.push((endpoint as Record<string, unknown>).target_id)
    }
  }
  return [...new Set(ids
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0 && item !== 'target-default'))]
}

/** Build the durable call/result projection used by execution-output cards. */
export function buildToolTimeline(events: ReadonlyArray<ToolTimelineEvent>): ToolTimelineItem[] {
  const calls = new Map<string, ToolTimelineItem>()
  for (const event of events) {
    const selectedCalls = event.topic === 'chat/assistant_call'
      ? assistantToolCalls(event.payload)
      : event.topic === 'runtime/tool_calls_selected' && Array.isArray(event.payload.calls)
        ? assistantToolCalls({ tool_calls: event.payload.calls })
        : []
    if (selectedCalls.length > 0) {
      for (const call of selectedCalls) {
        const previous = calls.get(call.id)
        // `chat/assistant_call` owns the complete invocation while
        // `runtime/tool_calls_selected` carries a bounded activity preview.
        // A large write usually puts `path` after several KiB of `content`, so
        // replacing the complete call with that later, invalid JSON preview
        // makes the summary claim that no file was specified. Keep the richer
        // argument source while still accepting a preview when it is all the
        // Dashboard has (for example during a narrowly paged live tail).
        const argumentsSource = previous && toolArgumentsQuality(previous) > toolArgumentsQuality(call)
          ? previous
          : call
        calls.set(call.id, {
          ...argumentsSource,
          timestamp: previous?.timestamp ?? event.timestamp,
          status: previous?.status ?? 'running',
          result: previous?.result,
        })
      }
      continue
    }
    // Runtime-owned physical capabilities may expose a domain-specific topic
    // (for example artifact_transfer_completed) while retaining the canonical
    // tool_output Event type. The type is the lifecycle contract; restricting
    // this projection to the legacy chat/tool_output topic strands the
    // matching call in a permanent running state.
    if (event.type !== 'tool_output' && event.topic !== 'chat/tool_output') continue
    const id = typeof event.payload.tool_call_id === 'string' ? event.payload.tool_call_id : ''
    if (!id) continue
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
  return [...calls.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}
