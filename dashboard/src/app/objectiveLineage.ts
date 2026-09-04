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

export interface LiveCausalRoute {
  activationId: string
  threadId?: string
  rootTurnId?: string
  objectiveId?: string
}

export interface ObjectiveLineageIndex {
  /** The stable Objective association for each known scheduler Thread. */
  objectiveIdsByThread: ReadonlyMap<string, string[]>
  /** Resolve a durable conversation Event to its Thread(s) and Objective(s). */
  forEvent: (event: ObjectiveLineageEvent) => CausalLineage
  /** Resolve a live model attempt through its owning Activation. */
  forActivation: (activationId: string) => CausalLineage
  /** Resolve an in-flight route immediately, before Scheduler snapshots catch up. */
  forLiveRoute: (route: LiveCausalRoute) => CausalLineage
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

  const forLiveRoute = (route: LiveCausalRoute): CausalLineage => {
    const activationLineage = forActivation(route.activationId)
    const threadIds = unique([route.threadId ?? '', ...activationLineage.threadIds])
    return {
      threadIds,
      objectiveIds: unique([
        route.objectiveId ?? '',
        ...activationLineage.objectiveIds,
        ...(route.rootTurnId ? objectiveIdsByRootTurn.get(route.rootTurnId) ?? [] : []),
        ...threadIds.flatMap(threadId => objectiveIdsByThread.get(threadId) ?? []),
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

  return { objectiveIdsByThread, forEvent, forActivation, forLiveRoute }
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
  // A yellow-green occupies the sixth categorical region. The previous blue
  // was too close to the violet above on the Dashboard's dark surfaces.
  { color: '#b9cf52' },
]

export const TINT_PALETTE_SIZE = objectiveTones.length
export const TINT_RECENT_SLOT_LIMIT = TINT_PALETTE_SIZE * 2

export interface TintSlotAllocation {
  slots: Map<string, number>
  recentlyReleasedSlots: number[]
  liveIds: readonly string[]
}

/**
 * Keeps visible identities stable, choosing new live colours by their distance
 * from the other live colours. History retains its slots but does not dictate
 * the separation of streams that the operator is following now.
 *
 * A slot is held for as long as its entity stays in `activeIds`, which keeps a
 * colour stable while the user is reading. Callers can reserve recently
 * released slots so a new entity does not immediately inherit the colour the
 * operator still associates with its predecessor.
 *
 * The first slots use the hand-tuned palette. Further slots are still unique
 * and receive generated tones: turning tinting off merely because a message
 * window contains more than six historical entities makes the same Thread or
 * Objective appear and disappear as the operator refreshes or filters it.
 */
export function assignTintSlots(
  activeIds: readonly string[],
  previous: ReadonlyMap<string, number>,
  reservedSlots: ReadonlySet<number> = new Set(),
  liveIds: readonly string[] = activeIds,
): Map<string, number> {
  const next = new Map<string, number>()
  const taken = new Set<number>()
  const wanted = [...new Set(activeIds.filter(Boolean))]
  const wantedSet = new Set(wanted)
  const live = [...new Set(liveIds)].filter(id => wantedSet.has(id))
  for (const id of wanted) {
    const slot = previous.get(id)
    if (slot === undefined || next.has(id) || taken.has(slot)) continue
    next.set(id, slot)
    taken.add(slot)
  }
  for (const id of live) {
    if (next.has(id)) continue
    const peers = live.flatMap(peer => {
      const slot = next.get(peer)
      return slot === undefined ? [] : [slot]
    })
    const slot = distinctTintSlot(taken, reservedSlots, peers)
    next.set(id, slot)
    taken.add(slot)
  }
  for (const id of wanted) {
    if (next.has(id)) continue
    let slot = 0
    while (taken.has(slot) || reservedSlots.has(slot)) slot += 1
    next.set(id, slot)
    taken.add(slot)
  }
  return next
}

/**
 * Reconciles live assignments and quarantines recently released colours.
 *
 * The quarantine is activity-bounded rather than time-based: it survives
 * rapid streaming churn without timers, but old slots naturally become
 * reusable after enough other entities have left the page.
 */
export function reconcileTintSlots(
  activeIds: readonly string[],
  previous: ReadonlyMap<string, number>,
  previousRecentlyReleasedSlots: readonly number[] = [],
  liveIds: readonly string[] = activeIds,
  previousLiveIds: readonly string[] = liveIds,
): TintSlotAllocation {
  const wanted = [...new Set(activeIds.filter(Boolean))]
  const wantedSet = new Set(wanted)
  const stillActiveSlots = new Set(
    wanted.flatMap(id => {
      const slot = previous.get(id)
      return slot === undefined ? [] : [slot]
    }),
  )
  const recentlyReleasedSlots: number[] = []
  const rememberReleasedSlot = (slot: number) => {
    if (stillActiveSlots.has(slot) || recentlyReleasedSlots.includes(slot)) return
    recentlyReleasedSlots.push(slot)
  }
  for (const [id, slot] of previous) {
    if (!wantedSet.has(id)) rememberReleasedSlot(slot)
  }
  for (const slot of previousRecentlyReleasedSlots) rememberReleasedSlot(slot)
  recentlyReleasedSlots.splice(TINT_RECENT_SLOT_LIMIT)

  // Events can arrive before the Scheduler/stream identifies a live Thread.
  // Assign its active colour when that fact arrives, then hold it throughout
  // execution. Historical pagination must not decide concurrent colours.
  const previouslyLive = new Set(previousLiveIds)
  const stablePrevious = new Map(previous)
  for (const id of liveIds) {
    if (!previouslyLive.has(id)) stablePrevious.delete(id)
  }

  return {
    slots: assignTintSlots(wanted, stablePrevious, new Set(recentlyReleasedSlots), liveIds),
    recentlyReleasedSlots,
    liveIds,
  }
}

type Rgb = readonly [number, number, number]
type Oklab = readonly [number, number, number]

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const section = ((hue % 360) + 360) % 360 / 60
  const x = chroma * (1 - Math.abs(section % 2 - 1))
  const [red, green, blue]: Rgb = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
      : section < 3 ? [0, chroma, x]
        : section < 4 ? [0, x, chroma]
          : section < 5 ? [x, 0, chroma]
            : [chroma, 0, x]
  const match = l - chroma / 2
  return [red + match, green + match, blue + match]
}

function toneToRgb(tone: ObjectiveTone): Rgb {
  if (tone.color.startsWith('#')) {
    const value = Number.parseInt(tone.color.slice(1), 16)
    return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
  }
  const hsl = /^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/.exec(tone.color)
  if (!hsl) return [0, 0, 0]
  return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]))
}

function rgbToOklab([red, green, blue]: Rgb): Oklab {
  const linear = (value: number) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4
  const r = linear(red)
  const g = linear(green)
  const b = linear(blue)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const toneLabs = new Map<string, Oklab>()

function toneLab(tone: ObjectiveTone): Oklab {
  let lab = toneLabs.get(tone.color)
  if (!lab) {
    lab = rgbToOklab(toneToRgb(tone))
    toneLabs.set(tone.color, lab)
  }
  return lab
}

export function tintToneDistance(left: ObjectiveTone, right: ObjectiveTone): number {
  const [leftL, leftA, leftB] = toneLab(left)
  const [rightL, rightA, rightB] = toneLab(right)
  return Math.hypot(leftL - rightL, leftA - rightA, leftB - rightB)
}

const generatedToneCandidates: readonly ObjectiveTone[] = [52, 62, 72].flatMap(lightness => (
  [64, 78].flatMap(saturation => (
    Array.from({ length: 30 }, (_, index) => ({
      color: `hsl(${index * 12} ${saturation}% ${lightness}%)`,
    }))
  ))
))
const generatedTones: ObjectiveTone[] = []
const generatedCandidateDistances = generatedToneCandidates.map(candidate => (
  Math.min(...objectiveTones.map(tone => tintToneDistance(candidate, tone)))
))

function generatedToneForIndex(index: number): ObjectiveTone {
  while (generatedTones.length <= index) {
    let bestIndex = -1
    let bestDistance = -1
    for (const [candidateIndex, distance] of generatedCandidateDistances.entries()) {
      if (distance > bestDistance) {
        bestIndex = candidateIndex
        bestDistance = distance
      }
    }
    const best = generatedToneCandidates[bestIndex] ?? {
      color: `hsl(${(188 + generatedTones.length * 137.508) % 360} 70% 60%)`,
    }
    generatedTones.push(best)
    for (const [candidateIndex, candidate] of generatedToneCandidates.entries()) {
      generatedCandidateDistances[candidateIndex] = candidateIndex === bestIndex ? -1 : Math.min(
        generatedCandidateDistances[candidateIndex], tintToneDistance(candidate, best),
      )
    }
  }
  return generatedTones[index]
}

export function toneForSlot(slot: number | undefined): ObjectiveTone | undefined {
  if (slot === undefined || !Number.isSafeInteger(slot) || slot < 0) return undefined
  const curated = objectiveTones[slot]
  if (curated) return curated
  // Each overflow tone maximises its minimum OKLab distance from every tone
  // allocated before it. Slot uniqueness alone is insufficient: two distinct
  // RGB values that both read as violet still look like the same causal owner.
  return generatedToneForIndex(slot - objectiveTones.length)
}

function distinctTintSlot(
  taken: ReadonlySet<number>,
  reserved: ReadonlySet<number>,
  peers: readonly number[],
): number {
  let bestSlot = 0
  let bestDistance = -1
  let candidates = 0
  const peerLabs = peers.map(slot => toneLab(toneForSlot(slot)!))
  // A bounded look-ahead allows old history to keep its colours while new
  // streams choose across the spectrum instead of taking adjacent slots.
  for (let slot = 0; candidates < 48; slot += 1) {
    if (taken.has(slot) || reserved.has(slot)) continue
    if (peers.length === 0) return slot
    candidates += 1
    const [l, a, b] = toneLab(toneForSlot(slot)!)
    const distance = Math.min(...peerLabs.map(([pl, pa, pb]) => (
      // Thin borders and translucent fills need different hues, not merely
      // a lighter/darker version of the same hue.
      Math.hypot((l - pl) * 0.35, a - pa, b - pb)
    )))
    if (distance > bestDistance) {
      bestSlot = slot
      bestDistance = distance
    }
  }
  return bestSlot
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
