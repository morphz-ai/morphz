export interface ModelAttemptBinding {
  requested_alias: string
  route_id: string
  route_revision: string
  provider_instance_id: string
  auth_account_id: string
  physical_model: string
  protocol: string
  provider_adapter: string
  provider_adapter_version: string
  endpoint: string
  capabilities: string[]
}

export interface ModelUsageRecord {
  event_id: string
  timestamp: string
  context_id: string
  session_id: string
  attempt_id: string
  model?: string
  model_binding?: ModelAttemptBinding
  usage: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  cost?: {
    amount: number
    currency: string
    pricing_version: string
  }
}

export interface PhysicalEvaluationGroup {
  key: string
  latest: ModelUsageRecord
  attempts: number
  contextIds: Set<string>
  sessionIds: Set<string>
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  cost?: { amount: number; currency: string }
}

export interface ModelUsagePath {
  key: string
  providerInstanceId?: string
  authAccountId?: string
  physicalModel: string
  routeIds: string[]
  routeRevisions: string[]
  attempts: number
  latestTimestamp: string
}

export interface ModelUsageGroup {
  alias: string
  latest: ModelUsageRecord
  attempts: number
  contextIds: Set<string>
  sessionIds: Set<string>
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  paths: ModelUsagePath[]
  cost?: { amount: number; currency: string }
}

/**
 * Fold request history into stable physical service identities. Logical route
 * and route revision are deliberately not part of the identity: multiple
 * aliases, or editing one route, must not turn the same Provider/account/model
 * into a wall of duplicate Dashboard cards.
 */
export function groupPhysicalEvaluations(attempts: ModelUsageRecord[]): PhysicalEvaluationGroup[] {
  const groups = new Map<string, PhysicalEvaluationGroup>()
  attempts.forEach(attempt => {
    const binding = attempt.model_binding
    const key = binding
      ? [binding.provider_instance_id, binding.auth_account_id, binding.physical_model].join('\u0000')
      : `legacy\u0000${attempt.model ?? 'unknown'}`
    const current = groups.get(key) ?? {
      key,
      latest: attempt,
      attempts: 0,
      contextIds: new Set<string>(),
      sessionIds: new Set<string>(),
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    current.attempts += 1
    current.contextIds.add(attempt.context_id)
    current.sessionIds.add(attempt.session_id)
    current.inputTokens += attempt.usage.input_tokens ?? 0
    current.cachedInputTokens += attempt.usage.cached_input_tokens ?? 0
    current.outputTokens += attempt.usage.output_tokens ?? 0
    current.totalTokens += attempt.usage.total_tokens ?? 0
    if (new Date(attempt.timestamp).getTime() > new Date(current.latest.timestamp).getTime()) current.latest = attempt
    if (attempt.cost) {
      if (!current.cost || current.cost.currency === attempt.cost.currency) {
        current.cost = {
          amount: (current.cost?.amount ?? 0) + attempt.cost.amount,
          currency: attempt.cost.currency,
        }
      }
    }
    groups.set(key, current)
  })
  return Array.from(groups.values()).sort((left, right) => (
    new Date(right.latest.timestamp).getTime() - new Date(left.latest.timestamp).getTime()
  ))
}

/**
 * The Provider control plane is primarily about logical models. Fold recent
 * usage by the stable alias shown to the operator and retain physical routes
 * only as expandable diagnostics. Legacy records without a binding still join
 * a newer bound record when both name the same model.
 */
export function groupModelUsageByAlias(attempts: ModelUsageRecord[]): ModelUsageGroup[] {
  type MutableGroup = Omit<ModelUsageGroup, 'paths'> & {
    paths: Map<string, ModelUsagePath & { routes: Set<string>; revisions: Set<string> }>
  }
  const groups = new Map<string, MutableGroup>()

  attempts.forEach(attempt => {
    const binding = attempt.model_binding
    const alias = binding?.requested_alias?.trim() || attempt.model?.trim() || 'unknown'
    const current = groups.get(alias) ?? {
      alias,
      latest: attempt,
      attempts: 0,
      contextIds: new Set<string>(),
      sessionIds: new Set<string>(),
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      paths: new Map<string, ModelUsagePath & { routes: Set<string>; revisions: Set<string> }>(),
    }

    current.attempts += 1
    current.contextIds.add(attempt.context_id)
    current.sessionIds.add(attempt.session_id)
    current.inputTokens += attempt.usage.input_tokens ?? 0
    current.cachedInputTokens += attempt.usage.cached_input_tokens ?? 0
    current.outputTokens += attempt.usage.output_tokens ?? 0
    current.totalTokens += attempt.usage.total_tokens ?? 0
    if (new Date(attempt.timestamp).getTime() > new Date(current.latest.timestamp).getTime()) current.latest = attempt
    if (attempt.cost && (!current.cost || current.cost.currency === attempt.cost.currency)) {
      current.cost = {
        amount: (current.cost?.amount ?? 0) + attempt.cost.amount,
        currency: attempt.cost.currency,
      }
    }

    const pathKey = binding
      ? [binding.provider_instance_id, binding.auth_account_id, binding.physical_model].join('\u0000')
      : `legacy\u0000${attempt.model ?? alias}`
    const path = current.paths.get(pathKey) ?? {
      key: pathKey,
      providerInstanceId: binding?.provider_instance_id,
      authAccountId: binding?.auth_account_id,
      physicalModel: binding?.physical_model ?? attempt.model ?? alias,
      routeIds: [],
      routeRevisions: [],
      routes: new Set<string>(),
      revisions: new Set<string>(),
      attempts: 0,
      latestTimestamp: attempt.timestamp,
    }
    path.attempts += 1
    if (binding?.route_id) path.routes.add(binding.route_id)
    if (binding?.route_revision) path.revisions.add(binding.route_revision)
    if (new Date(attempt.timestamp).getTime() > new Date(path.latestTimestamp).getTime()) path.latestTimestamp = attempt.timestamp
    current.paths.set(pathKey, path)
    groups.set(alias, current)
  })

  return Array.from(groups.values())
    .map(group => ({
      ...group,
      paths: Array.from(group.paths.values())
        .map(({ routes, revisions, ...path }) => ({
          ...path,
          routeIds: Array.from(routes),
          routeRevisions: Array.from(revisions),
        }))
        .sort((left, right) => new Date(right.latestTimestamp).getTime() - new Date(left.latestTimestamp).getTime()),
    }))
    .sort((left, right) => new Date(right.latest.timestamp).getTime() - new Date(left.latest.timestamp).getTime())
}
