export const ENGLISH_LANGUAGE = 'en'
export const CHINESE_LANGUAGE = 'zh-CN'
export const CHINESE_BASE_LANGUAGE = 'zh'

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
