import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import i18next from 'i18next'
import {
  CHINESE_LANGUAGE,
  createLanguageResources,
  ENGLISH_LANGUAGE,
  nextDashboardLanguage,
  supportedDashboardLanguages,
} from '../src/i18n/language.ts'

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(strings)
  }
  return []
}

test('the Chinese catalog does not retain obsolete English product terminology', () => {
  const catalog = JSON.parse(readFileSync(
    new URL('../src/i18n/locales/zh.json', import.meta.url),
    'utf8',
  )) as unknown
  const text = strings(catalog).join('\n')

  for (const obsolete of [
    'Runtime',
    'Dashboard',
    'Objective',
    'Execution Job',
    'Schedule',
    'Context Encoding',
    'Scheduler Snapshot',
    'WebSocket',
  ]) {
    assert.equal(text.includes(obsolete), false, `Chinese catalog contains ${obsolete}`)
  }
})

test('the dashboard language toggle resolves both Chinese and English resources', async () => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: ENGLISH_LANGUAGE,
    fallbackLng: ENGLISH_LANGUAGE,
    supportedLngs: [...supportedDashboardLanguages],
    nonExplicitSupportedLngs: true,
    resources: createLanguageResources(
      { translation: { marker: 'English' } },
      { translation: { marker: '中文' } },
    ),
  })

  await instance.changeLanguage(nextDashboardLanguage(instance.language))
  assert.equal(instance.language, CHINESE_LANGUAGE)
  assert.equal(instance.resolvedLanguage, CHINESE_LANGUAGE)
  assert.equal(instance.t('marker'), '中文')

  await instance.changeLanguage(nextDashboardLanguage(instance.language))
  assert.equal(instance.resolvedLanguage, ENGLISH_LANGUAGE)
  assert.equal(instance.t('marker'), 'English')
})
