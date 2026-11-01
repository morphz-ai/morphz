import { DashboardApiError, type DashboardApiClient } from '../api/client.ts'
import type { ThreadRecord } from '../scheduler/types.ts'

type Target = Pick<ThreadRecord, 'id' | 'revision' | 'generation'> & {
  kind: string
  lifecycle: string
  control_state: string
} & Partial<
    Pick<
      ThreadRecord,
      | 'context_id'
      | 'session_id'
      | 'root_turn_id'
      | 'agent_id'
      | 'initiating_principal_id'
    >
  >
type Action = 'pause' | 'resume' | 'cancel'

/** Refresh only the confirmed identity, never the full inventory. A revision
 * may advance during a confirmation; a new generation/source is a new decision.
 * Retry only one explicit CAS conflict, never an unknown delivery outcome. */
export async function submitThreadControl(
  api: Pick<DashboardApiClient, 'get' | 'command'>,
  contextId: string,
  selected: Target,
  action: Action,
  reason: string,
  conflictMessage: string,
): Promise<{ updated: true; thread: ThreadRecord }> {
  const path = `/api/contexts/${encodeURIComponent(contextId)}/threads/${encodeURIComponent(selected.id)}`
  const sameSource = (thread: ThreadRecord) =>
    thread?.id === selected.id &&
    thread.context_id === contextId &&
    thread.kind === selected.kind &&
    [
      'context_id',
      'session_id',
      'root_turn_id',
      'agent_id',
      'initiating_principal_id',
    ].every(
      (key) =>
        selected[key as keyof Target] === undefined ||
        thread[key as keyof ThreadRecord] === selected[key as keyof Target],
    )
  for (let attempt = 0; attempt < 2; attempt++) {
    // Read just the existing operator Thread/control record. Full Thread
    // detail also assembles execution history and must not gate a control.
    const current = (
      await api.get<{ thread?: ThreadRecord }>(`${path}/evaluation-policy`)
    )?.thread
    if (
      !current ||
      !sameSource(current) ||
      current.generation !== selected.generation ||
      current.control_state !== selected.control_state ||
      current.lifecycle !== 'open' ||
      !Number.isSafeInteger(current.revision) ||
      current.revision < selected.revision
    )
      throw new Error(conflictMessage)
    try {
      const receipt = await api.command<{
        updated: true
        thread: ThreadRecord
      }>(path, 'POST', {
        action,
        expected_revision: current.revision,
        reason,
      })
      const result = receipt?.thread
      if (
        receipt?.updated !== true ||
        !result ||
        !sameSource(result) ||
        !Number.isSafeInteger(result.revision) ||
        result.revision <= current.revision ||
        result.generation !==
          current.generation + (action === 'cancel' ? 1 : 0) ||
        result.lifecycle !== (action === 'cancel' ? 'cancelled' : 'open') ||
        result.control_state !==
          (action === 'pause'
            ? 'paused'
            : action === 'resume'
              ? 'active'
              : current.control_state)
      )
        throw new Error(conflictMessage)
      // The confirmed mutation already owns lifecycle/control state. Phase
      // reconciliation belongs to the caller's event-triggered background read.
      return receipt
    } catch (error) {
      if (!(error instanceof DashboardApiError) || error.status !== 409)
        throw error
      if (attempt === 1) throw new Error(conflictMessage, { cause: error })
    }
  }
  throw new Error(conflictMessage)
}
