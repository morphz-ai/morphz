import { assistantToolCalls, CONTEXT_TX_BATCH_REJECTED_ID, rejectedContextTxCallIds, type PresentedToolCall } from './presentation.ts'

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
  /** Durable physical task launched by an asynchronous tool invocation. */
  backgroundTaskId?: string
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

function rejectionRoute(payload: Record<string, unknown>): string | undefined {
  const context = nonEmptyString(payload.context_id)
  const session = nonEmptyString(payload.session_id)
  const attempt = nonEmptyString(payload.attempt_id) ?? nonEmptyString(payload.activation_id)
  return context && session && attempt ? JSON.stringify([context, session, attempt]) : undefined
}

/** Build the durable call/result projection used by execution-output cards. */
export function buildToolTimeline(events: ReadonlyArray<ToolTimelineEvent>): ToolTimelineItem[] {
  const calls = new Map<string, ToolTimelineItem>()
  const backgroundTaskOwners = new Map<string, string>()
  const inputs = events.map(event => ({
    event,
    selectedCalls: event.topic === 'chat/assistant_call'
      ? assistantToolCalls(event.payload)
      : event.topic === 'runtime/tool_calls_selected' && Array.isArray(event.payload.calls)
        ? assistantToolCalls({ tool_calls: event.payload.calls })
        : [],
  }))
  const rejectedByRoute = new Map<string, Set<string>>()
  const origins = new Map<string, Array<{ route?: string; call: PresentedToolCall; timestamp: string }>>()
  // Historical receipts lack original IDs, but their Assistant Call durably
  // records them. Index that explicit lineage before projecting outputs so
  // paginated/out-of-order history works without matching by name or time.
  for (const { event, selectedCalls } of inputs) {
    const route = rejectionRoute(event.payload)
    for (const call of selectedCalls) {
      const sources = origins.get(call.id) ?? []
      sources.push({ route, call, timestamp: event.timestamp })
      origins.set(call.id, sources)
    }
    if (!route || !['chat/assistant_call', 'runtime/tool_calls_selected'].includes(event.topic)) continue
    const ids = rejectedByRoute.get(route) ?? new Set<string>()
    for (const id of rejectedContextTxCallIds(event.payload)) ids.add(id)
    rejectedByRoute.set(route, ids)
  }
  for (const { event, selectedCalls } of inputs) {
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
    if (id === CONTEXT_TX_BATCH_REJECTED_ID
      && event.payload.tool_name === 'context_tx' && event.payload.tool_status === 'rejected') {
      const route = rejectionRoute(event.payload)
      const explicitIds = rejectedContextTxCallIds(event.payload)
      const rejectedIds = explicitIds.length > 0 ? explicitIds : [...(rejectedByRoute.get(route ?? '') ?? [])]
      // A receipt cannot relabel a call from another route, or a physical tool.
      // With no provable lineage, retain the standalone receipt below.
      if (route && rejectedIds.length > 0 && rejectedIds.every(originalId =>
        (origins.get(originalId) ?? []).every(origin => origin.route === route && origin.call.name === 'context_tx'))) {
        for (const originalId of rejectedIds) {
          const source = origins.get(originalId)?.reduce((best, origin) =>
            toolArgumentsQuality(origin.call) > toolArgumentsQuality(best.call) ? origin : best)
          const previous = calls.get(originalId)
          const original = previous ?? source?.call
          calls.set(originalId, {
            id: originalId,
            name: 'context_tx',
            arguments: original?.arguments ?? '{}',
            arguments_chars: original?.arguments_chars,
            truncated: original?.truncated,
            timestamp: previous?.timestamp ?? source?.timestamp ?? event.timestamp,
            status: 'rejected',
            result: typeof event.payload.text === 'string' ? event.payload.text : '',
          })
        }
        continue
      }
    }
    const taskId = nonEmptyString(event.payload.task_id)
    const taskStatus = nonEmptyString(event.payload.task_status)
    const isBackgroundLaunch = event.payload.execution === 'background'
    const isBackgroundCompletion = event.payload.tool_name === 'exec/background'
      || id.endsWith(':background')

    // `exec(background=true)` has two distinct lifecycles: the foreground
    // tool invocation completes once the process is launched, while the
    // durable Execution Job remains queued/running until its own terminal
    // output arrives. Keep the original Assistant Call as the visual owner and
    // project the physical Job state onto it instead of claiming that the
    // whole operation completed when only the launcher succeeded.
    if (taskId && isBackgroundCompletion) {
      const ownerCallId = backgroundTaskOwners.get(taskId)
      const owner = ownerCallId ? calls.get(ownerCallId) : undefined
      if (owner) {
        calls.set(owner.id, {
          ...owner,
          status: taskStatus ?? nonEmptyString(event.payload.tool_status) ?? owner.status,
          result: typeof event.payload.text === 'string' ? event.payload.text : owner.result,
          backgroundTaskId: taskId,
        })
        continue
      }
    }
    const previous = calls.get(id)
    const backgroundTaskId = taskId && (isBackgroundLaunch || isBackgroundCompletion)
      ? taskId
      : previous?.backgroundTaskId
    if (backgroundTaskId && isBackgroundLaunch) backgroundTaskOwners.set(backgroundTaskId, id)
    calls.set(id, {
      id,
      name: typeof event.payload.tool_name === 'string' ? event.payload.tool_name : previous?.name ?? 'tool',
      arguments: previous?.arguments ?? '{}',
      arguments_chars: previous?.arguments_chars,
      truncated: previous?.truncated,
      timestamp: previous?.timestamp ?? event.timestamp,
      status: backgroundTaskId && taskStatus
        ? taskStatus
        : typeof event.payload.tool_status === 'string' ? event.payload.tool_status : 'success',
      result: typeof event.payload.text === 'string' ? event.payload.text : '',
      backgroundTaskId,
    })
  }
  return [...calls.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}
