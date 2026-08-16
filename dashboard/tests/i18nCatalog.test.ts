import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import i18next from 'i18next'
import {
  CHINESE_LANGUAGE,
  createLanguageResources,
  DASHBOARD_LANGUAGE_STORAGE_KEY,
  ENGLISH_LANGUAGE,
  nextDashboardLanguage,
  persistDashboardLanguage,
  resolveInitialDashboardLanguage,
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

test('runtime overview uses Chinese product language consistently', () => {
  const catalog = JSON.parse(readFileSync(
    new URL('../src/i18n/locales/zh.json', import.meta.url),
    'utf8',
  )) as { runtimeOverview: unknown }
  const text = strings(catalog.runtimeOverview).join('\n')

  for (const untranslated of ['Context', 'Session', 'Thread']) {
    assert.equal(text.includes(untranslated), false, `runtime overview contains ${untranslated}`)
  }
})

test('Mind Frame uses the canonical product term in both languages', () => {
  const zh = JSON.parse(readFileSync(
    new URL('../src/i18n/locales/zh.json', import.meta.url),
    'utf8',
  )) as { eventHistory: { openFrame: string }, mindView: Record<string, unknown> }
  const en = JSON.parse(readFileSync(
    new URL('../src/i18n/locales/en.json', import.meta.url),
    'utf8',
  )) as { eventHistory: { openFrame: string }, mindView: Record<string, unknown> }
  const zhMindView = strings(zh.mindView).join('\n')
  const enMindView = strings(en.mindView).join('\n')

  assert.equal(zh.eventHistory.openFrame, '打开认知帧')
  assert.equal(zhMindView.includes('认知框架'), false)
  assert.equal(zhMindView.includes('认知帧'), true)
  assert.equal(en.eventHistory.openFrame, 'Open Mind Frame')
  assert.equal(enMindView.includes('Mind Frame'), true)
})

test('Event History uses the canonical event terminology', () => {
  const zh = readFileSync(new URL('../src/i18n/locales/zh.json', import.meta.url), 'utf8')
  const en = readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8')

  assert.equal(zh.includes('事件历史'), true)
  assert.equal(en.includes('Event History'), true)
  assert.equal(zh.includes('事件回放'), true)
  assert.equal(en.includes('Event Replay'), true)
})

test('Morphz uses one canonical machine identity in both dashboard languages', () => {
  const zh = JSON.parse(readFileSync(
    new URL('../src/i18n/locales/zh.json', import.meta.url),
    'utf8',
  )) as { header: { machineTagline: string } }
  const en = JSON.parse(readFileSync(
    new URL('../src/i18n/locales/en.json', import.meta.url),
    'utf8',
  )) as { header: { machineTagline: string } }

  assert.equal(zh.header.machineTagline, 'S 表达式认知机')
  assert.equal(en.header.machineTagline, 'S-Expression Cognitive Machine')
  assert.notEqual(en.header.machineTagline, 'Cognitive S-Expression Machine')
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

test('first-run Dashboard language follows browser locales until the user chooses explicitly', () => {
  assert.equal(
    resolveInitialDashboardLanguage(null, ['zh-Hans-CN', 'en-US']),
    CHINESE_LANGUAGE,
  )
  assert.equal(
    resolveInitialDashboardLanguage(null, ['fr-FR', 'zh_CN']),
    CHINESE_LANGUAGE,
  )
  assert.equal(
    resolveInitialDashboardLanguage(null, ['fr-FR', 'en-US']),
    ENGLISH_LANGUAGE,
  )
  assert.equal(
    resolveInitialDashboardLanguage(ENGLISH_LANGUAGE, ['zh-CN']),
    ENGLISH_LANGUAGE,
    'an explicit user preference must take precedence over automatic locale detection',
  )
})

test('only an explicit language choice is written to the Morphz preference key', () => {
  const writes: Array<[string, string]> = []
  persistDashboardLanguage('zh-Hans', {
    setItem(key, value) { writes.push([key, value]) },
  })
  assert.deepEqual(writes, [[DASHBOARD_LANGUAGE_STORAGE_KEY, CHINESE_LANGUAGE]])
})
