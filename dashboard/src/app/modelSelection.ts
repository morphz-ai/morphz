export interface SelectableModelOption {
  id: string
  label: string
  aliases?: string[]
}

export interface ModelAvailabilityStatus {
  model?: string | null
  models?: string[]
  model_options?: SelectableModelOption[]
  provider?: string | null
}

/**
 * Provider onboarding is complete when Runtime exposes any usable model.
 * Provider identity is deliberately not used: OAuth and catalog setup can
 * create a Provider before the operator enables a model, while a manually
 * configured model can be usable without a managed Provider ID.
 */
export function requiresInitialProviderSetup(status: ModelAvailabilityStatus | null): boolean {
  if (!status) return false
  return (status.model_options?.length ?? 0) === 0
    && !status.models?.some(model => model.trim())
    && !status.model?.trim()
}

/**
 * Resolve the Runtime's stable model selection without confusing a route ID
 * with another route's display alias. Exact control IDs always win; aliases
 * are a compatibility lookup only.
 */
export function resolveSelectedModelOption<T extends SelectableModelOption>(
  options: T[],
  selected?: string | null,
): T | undefined {
  const value = selected?.trim()
  if (!value) return undefined
  return options.find(option => option.id === value)
    ?? options.find(option => option.aliases?.includes(value))
}
