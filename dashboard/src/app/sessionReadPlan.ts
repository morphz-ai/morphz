import type { AuthoritativeQuery } from './invalidation'

/** A visible Session is not an owner for every collection in that Session.
 * First entry/reconnect closes all visible gaps; a committed change owns only
 * the projection it actually changes. */
export function sessionReadPlan(view: string, invalidated?: readonly AuthoritativeQuery[]) {
  const changed = new Set(invalidated)
  const first = invalidated === undefined
  const work = view === 'dialogue' || view === 'scheduler'
  return {
    messages: view === 'dialogue' && (first || changed.has('session')),
    work: work && (first || changed.has('scheduler') || changed.has('session')),
    attention: work && (first || changed.has('scheduler')),
    overview: (view === 'overview' || work) && (first || changed.has('overview') || changed.has('session')),
    usage: work && (first || changed.has('model-usage')),
    delegations: work && (first || changed.has('delegations')),
  }
}
