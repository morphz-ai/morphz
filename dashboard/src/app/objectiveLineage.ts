/**
 * The Runtime persists causal identifiers on events instead of duplicating a
 * mutable Objective reference on every scheduler record.  The Dashboard turns
 * those identifiers into a small read-model here, so every surface (message
 * cards, the activity dock, and filters) uses the same attribution rule.
 */

export interface ObjectiveLineageEvent {
  id: string
  payload: Record<string, unknown>
}

export interface ObjectiveLineageActivation {
  id: string
  root_turn_id: string
  trigger_event_id: string
}

export interface ObjectiveLineageThread {
  id: string
  root_turn_id: string
  activations: ReadonlyArray<ObjectiveLineageActivation>
}

export interface CausalLineage {
  threadIds: string[]
  objectiveIds: string[]
}

export interface ObjectiveLineageIndex {
  /** The stable Objective association for each known scheduler Thread. */
  objectiveIdsByThread: ReadonlyMap<string, string[]>
  /** Resolve a durable conversation Event to its Thread(s) and Objective(s). */
  forEvent: (event: ObjectiveLineageEvent) => CausalLineage
  /** Resolve a live model attempt through its owning Activation. */
  forActivation: (activationId: string) => CausalLineage
}

const emptyLineage = (): CausalLineage => ({ threadIds: [], objectiveIds: [] })

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value.trim() : ''
}

function stringListField(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : []
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))]
}

function mergeLineage(...lineages: CausalLineage[]): CausalLineage {
  return {
    threadIds: unique(lineages.flatMap(lineage => lineage.threadIds)),
    objectiveIds: unique(lineages.flatMap(lineage => lineage.objectiveIds)),
  }
}

/**
 * Builds a best-effort projection from immutable causal facts.  A direct
 * `objective_id` on an Event always wins; root-turn and activation relations
 * then fill in the common cases where a reply only carries a Thread route.
 */
export function buildObjectiveLineageIndex(
  threads: ReadonlyArray<ObjectiveLineageThread>,
  events: ReadonlyArray<ObjectiveLineageEvent>,
): ObjectiveLineageIndex {
  const eventsById = new Map(events.map(event => [event.id, event]))
  const threadIdsByRootTurn = new Map<string, string[]>()
  const threadIdByActivation = new Map<string, string>()
  const rootTurnByActivation = new Map<string, string>()
  const objectiveIdsByRootTurn = new Map<string, string[]>()
  const objectiveIdsByActivation = new Map<string, string[]>()
  const objectiveIdsByThread = new Map<string, string[]>()

  const rememberObjectivesForRoot = (rootTurnId: string, objectiveIds: string[]) => {
    if (!rootTurnId || objectiveIds.length === 0) return
    objectiveIdsByRootTurn.set(
      rootTurnId,
      unique([...(objectiveIdsByRootTurn.get(rootTurnId) ?? []), ...objectiveIds]),
    )
  }

  for (const event of events) {
    const rootTurnId = stringField(event.payload, 'root_turn_id') || event.id
    const objectiveId = stringField(event.payload, 'objective_id')
    if (objectiveId) rememberObjectivesForRoot(rootTurnId, [objectiveId])
  }

  for (const thread of threads) {
    threadIdsByRootTurn.set(
      thread.root_turn_id,
      unique([...(threadIdsByRootTurn.get(thread.root_turn_id) ?? []), thread.id]),
    )
    for (const activation of thread.activations) {
      threadIdByActivation.set(activation.id, thread.id)
      rootTurnByActivation.set(activation.id, activation.root_turn_id)
      const rootEvent = eventsById.get(activation.root_turn_id)
      const triggerEvent = eventsById.get(activation.trigger_event_id)
      const objectiveIds = unique([
        stringField(rootEvent?.payload ?? {}, 'objective_id'),
        stringField(triggerEvent?.payload ?? {}, 'objective_id'),
      ])
      if (objectiveIds.length > 0) {
        objectiveIdsByActivation.set(activation.id, objectiveIds)
        rememberObjectivesForRoot(activation.root_turn_id, objectiveIds)
      }
    }
  }

  for (const event of events) {
    const threadId = stringField(event.payload, 'thread_id')
    const activationId = stringField(event.payload, 'activation_id')
    const rootTurnId = stringField(event.payload, 'root_turn_id')
      || rootTurnByActivation.get(activationId)
      || event.id
    const directObjectiveId = stringField(event.payload, 'objective_id')
    const inferredObjectiveIds = unique([
      directObjectiveId,
      ...(objectiveIdsByActivation.get(activationId) ?? []),
      ...(objectiveIdsByRootTurn.get(rootTurnId) ?? []),
    ])
    if (inferredObjectiveIds.length > 0) {
      rememberObjectivesForRoot(rootTurnId, inferredObjectiveIds)
      if (activationId) {
        objectiveIdsByActivation.set(
          activationId,
          unique([...(objectiveIdsByActivation.get(activationId) ?? []), ...inferredObjectiveIds]),
        )
      }
      if (threadId) {
        objectiveIdsByThread.set(
          threadId,
          unique([...(objectiveIdsByThread.get(threadId) ?? []), ...inferredObjectiveIds]),
        )
      }
    }
  }

  for (const thread of threads) {
    const objectiveIds = unique([
      ...(objectiveIdsByThread.get(thread.id) ?? []),
      ...(objectiveIdsByRootTurn.get(thread.root_turn_id) ?? []),
      ...thread.activations.flatMap(activation => objectiveIdsByActivation.get(activation.id) ?? []),
    ])
    objectiveIdsByThread.set(thread.id, objectiveIds)
  }

  const forActivation = (activationId: string): CausalLineage => {
    if (!activationId) return emptyLineage()
    const threadId = threadIdByActivation.get(activationId) ?? ''
    return {
      threadIds: threadId ? [threadId] : [],
      objectiveIds: unique([
        ...(objectiveIdsByActivation.get(activationId) ?? []),
        ...(threadId ? objectiveIdsByThread.get(threadId) ?? [] : []),
      ]),
    }
  }

  const forEvent = (event: ObjectiveLineageEvent): CausalLineage => {
    const directThreadId = stringField(event.payload, 'thread_id')
    const activationId = stringField(event.payload, 'activation_id')
    const rootTurnId = stringField(event.payload, 'root_turn_id') || event.id
    const activationLineage = forActivation(activationId)
    const threadIds = unique([
      directThreadId,
      ...activationLineage.threadIds,
      ...stringListField(event.payload, 'covers'),
      ...stringListField(event.payload, 'defer_covers'),
      ...(threadIdsByRootTurn.get(rootTurnId) ?? []),
    ])
    return mergeLineage(
      {
        threadIds,
        objectiveIds: unique([
          stringField(event.payload, 'objective_id'),
          ...activationLineage.objectiveIds,
          ...(objectiveIdsByRootTurn.get(rootTurnId) ?? []),
          ...threadIds.flatMap(threadId => objectiveIdsByThread.get(threadId) ?? []),
        ]),
      },
    )
  }

  return { objectiveIdsByThread, forEvent, forActivation }
}

/** Which causal dimension the stream is currently coloured by. */
export type TintDimension = 'objective' | 'thread'

export interface ObjectiveTone {
  color: string
}

const objectiveTones: readonly ObjectiveTone[] = [
  { color: '#28b8d0' },
  { color: '#9b7cff' },
  { color: '#e8a23b' },
  { color: '#38bd83' },
  { color: '#eb6f96' },
  { color: '#6e93f7' },
]

export const TINT_PALETTE_SIZE = objectiveTones.length

/**
 * Allocates a palette slot per live entity.
 *
 * Hashing an id into the palette is what this replaces: with six tones any two
 * concurrent entities could land on the same colour, and for a feature whose
 * only job is telling them apart, a collision does not merely fail to help —
 * it argues that two streams are one. Slots are therefore handed out by
 * occupancy, so entities that are alive at the same time never share a colour.
 *
 * A slot is held for as long as its entity stays in `activeIds`, which keeps a
 * colour stable while the user is reading, and is released for reuse once the
 * entity is gone. Callers pass the previous assignment back in; ordering of
 * `activeIds` decides who claims a freed slot first.
 *
 * Beyond `TINT_PALETTE_SIZE` live entities the extra ones are deliberately left
 * unassigned. Saying "these six are distinct and the rest are neutral" is
 * honest; recycling colours would fabricate distinctions that do not hold.
 */
export function assignTintSlots(
  activeIds: readonly string[],
  previous: ReadonlyMap<string, number>,
): Map<string, number> {
  const next = new Map<string, number>()
  const taken = new Set<number>()
  const wanted = activeIds.filter(Boolean)
  for (const id of wanted) {
    const slot = previous.get(id)
    if (slot === undefined || next.has(id) || taken.has(slot)) continue
    next.set(id, slot)
    taken.add(slot)
  }
  for (const id of wanted) {
    if (next.has(id)) continue
    let slot = 0
    while (slot < objectiveTones.length && taken.has(slot)) slot += 1
    if (slot >= objectiveTones.length) continue
    next.set(id, slot)
    taken.add(slot)
  }
  return next
}

export function toneForSlot(slot: number | undefined): ObjectiveTone | undefined {
  return slot === undefined ? undefined : objectiveTones[slot]
}

/** The id a message is coloured by, given the dimension in effect. */
export function tintIdForLineage(
  lineage: CausalLineage,
  dimension: TintDimension,
): string | undefined {
  const ids = dimension === 'thread' ? lineage.threadIds : lineage.objectiveIds
  return ids[0]
}

/**
 * Picks the dimension to colour by when tinting is switched on.
 *
 * The rule follows the level the operator is attending to rather than the
 * finest one that varies: while several Objectives are in view, telling those
 * apart is the question, and threads inside one of them are detail. Counts come
 * from what is currently visible, so narrowing to a single Objective moves the
 * useful distinction down to its threads on its own.
 */
export function autoTintDimension(
  visibleObjectiveCount: number,
  visibleThreadCount: number,
): TintDimension {
  if (visibleObjectiveCount >= 2) return 'objective'
  if (visibleObjectiveCount === 1 && visibleThreadCount >= 2) return 'thread'
  return visibleObjectiveCount === 1 ? 'objective' : 'thread'
}
