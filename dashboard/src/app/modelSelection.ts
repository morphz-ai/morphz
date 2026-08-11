export interface SelectableModelOption {
  id: string
  label: string
  aliases?: string[]
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
