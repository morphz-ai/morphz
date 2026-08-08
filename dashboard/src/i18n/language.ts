export const ENGLISH_LANGUAGE = 'en'
export const CHINESE_LANGUAGE = 'zh-CN'
export const CHINESE_BASE_LANGUAGE = 'zh'
export const DASHBOARD_LANGUAGE_STORAGE_KEY = 'morphz.dashboard.language'

export type DashboardLanguage = typeof ENGLISH_LANGUAGE | typeof CHINESE_LANGUAGE

export interface DashboardLanguageStorage {
  setItem(key: string, value: string): void
}

export const supportedDashboardLanguages = [
  ENGLISH_LANGUAGE,
  CHINESE_BASE_LANGUAGE,
  CHINESE_LANGUAGE,
] as const

export function createLanguageResources<T>(english: T, chinese: T) {
  return {
    [ENGLISH_LANGUAGE]: english,
    [CHINESE_BASE_LANGUAGE]: chinese,
    [CHINESE_LANGUAGE]: chinese,
  }
}

export function nextDashboardLanguage(current: string | undefined): string {
  return current?.startsWith('zh') ? ENGLISH_LANGUAGE : CHINESE_LANGUAGE
}

export function normalizeDashboardLanguage(value: string | null | undefined): DashboardLanguage | null {
  const normalized = value?.trim().replaceAll('_', '-').toLowerCase()
  if (!normalized) return null
  if (normalized === 'zh' || normalized.startsWith('zh-')) return CHINESE_LANGUAGE
  if (normalized === 'en' || normalized.startsWith('en-')) return ENGLISH_LANGUAGE
  return null
}

export function resolveInitialDashboardLanguage(
  storedLanguage: string | null | undefined,
  localeCandidates: readonly (string | null | undefined)[],
): DashboardLanguage {
  const explicitPreference = normalizeDashboardLanguage(storedLanguage)
  if (explicitPreference) return explicitPreference

  for (const candidate of localeCandidates) {
    const language = normalizeDashboardLanguage(candidate)
    if (language) return language
  }
  return ENGLISH_LANGUAGE
}

export function persistDashboardLanguage(
  language: string,
  storage?: DashboardLanguageStorage | null,
): void {
  const normalized = normalizeDashboardLanguage(language)
  if (!normalized) return
  try {
    const target = storage === undefined ? globalThis.localStorage : storage
    target?.setItem(DASHBOARD_LANGUAGE_STORAGE_KEY, normalized)
  } catch {
    // Restricted browser storage must not make language switching fail.
  }
}
