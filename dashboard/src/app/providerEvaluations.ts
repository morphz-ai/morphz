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
