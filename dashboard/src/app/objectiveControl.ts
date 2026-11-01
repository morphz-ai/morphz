type Goal = {
  id: string
  revision: number
  status: string
  [key: string]: unknown
}
type Action = 'pause' | 'resume' | 'delete'

/** Project only the confirmed Native control result; this is not an
 * optimistic mutation or a replacement for Runtime's revision fence. */
export function objectiveControlReceipt<
  T extends { id: string; revision: number; status: string },
>(selected: T, action: Action, response: unknown): T {
  const reply = response as {
    deleted?: boolean
    objective_id?: string
    terminal_status?: string
    paused?: boolean
    resumed?: boolean
    objective?: Goal
  } | null
  if (action === 'delete') {
    if (
      reply?.deleted !== true ||
      reply.objective_id !== selected.id ||
      reply.terminal_status !== 'cancelled'
    )
      throw new Error('Unconfirmed Objective deletion receipt')
    return { ...selected, status: 'cancelled' }
  }
  const value = reply?.objective
  const source = selected as Record<string, unknown>
  if (
    !value ||
    value.id !== selected.id ||
    !Number.isSafeInteger(value.revision) ||
    value.revision <= selected.revision ||
    value.status !== (action === 'pause' ? 'paused' : 'active') ||
    [
      'context_id',
      'coordinator_session_id',
      'delivery_session_id',
      'stated_objective',
    ].some((key) => source[key] !== undefined && value[key] !== source[key]) ||
    (action === 'pause' ? reply?.paused !== true : reply?.resumed !== true)
  )
    throw new Error('Unconfirmed Objective control receipt')
  return { ...selected, ...value }
}
