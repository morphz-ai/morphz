import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zh from './locales/zh.json'
import {
  DASHBOARD_LANGUAGE_STORAGE_KEY,
  createLanguageResources,
  normalizeDashboardLanguage,
  resolveInitialDashboardLanguage,
  supportedDashboardLanguages,
} from './language'

export const resources = createLanguageResources(
  { translation: en },
  { translation: zh },
)

function readStoredLanguage(): string | null {
  try {
    return globalThis.localStorage?.getItem(DASHBOARD_LANGUAGE_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

const navigatorLocales = typeof navigator === 'undefined'
  ? []
  : [...(navigator.languages ?? []), navigator.language]
const htmlLocale = typeof document === 'undefined' ? null : document.documentElement.lang
const initialLanguage = resolveInitialDashboardLanguage(
  readStoredLanguage(),
  [...navigatorLocales, htmlLocale],
)

function applyDocumentLanguage(language: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = normalizeDashboardLanguage(language) ?? initialLanguage
}

applyDocumentLanguage(initialLanguage)
i18n.on('languageChanged', applyDocumentLanguage)

i18n
  .use(initReactI18next)
  .init({
    lng: initialLanguage,
    resources,
    fallbackLng: 'en',
    supportedLngs: [...supportedDashboardLanguages],
    nonExplicitSupportedLngs: true,
    interpolation: {
      escapeValue: false,
    },
  })

export default i18n
