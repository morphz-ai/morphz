import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DASHBOARD_TOKEN_STORAGE_KEY,
  dashboardTokenFromLocation,
  resolveDashboardToken,
  type DashboardTokenStorage,
} from '../src/api/auth.ts'
import { resolveAppearanceMode } from '../src/app/themePreferences.ts'

const authGateSource = readFileSync(
  new URL('../src/DashboardAuthGate.tsx', import.meta.url),
  'utf8',
)
const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const chineseLocale = JSON.parse(
  readFileSync(new URL('../src/i18n/locales/zh.json', import.meta.url), 'utf8'),
) as { authentication: Record<string, string> }
const englishLocale = JSON.parse(
  readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8'),
) as { authentication: Record<string, string> }

class MemoryStorage implements DashboardTokenStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class RejectingStorage implements DashboardTokenStorage {
  getItem(): string | null {
    throw new Error('storage unavailable')
  }

  setItem(): void {
    throw new Error('storage unavailable')
  }
}

test('launch token survives Router path replacement and a recreated mobile page session', () => {
  const persistent = new MemoryStorage()
  const firstPageSession = new MemoryStorage()
  assert.equal(
    resolveDashboardToken(
      { search: '?token=launch-secret', hash: '' },
      { persistent, session: firstPageSession },
    ),
    'launch-secret',
  )
  assert.equal(persistent.getItem(DASHBOARD_TOKEN_STORAGE_KEY), 'launch-secret')

  const recreatedPageSession = new MemoryStorage()
  assert.equal(
    resolveDashboardToken(
      { search: '', hash: '' },
      { persistent, session: recreatedPageSession },
      'build-time-fallback',
    ),
    'launch-secret',
  )
})

test('first authenticated launch opens guided Provider setup when no model is configured', () => {
  assert.match(authGateSource, /setProviderSetupRequired\(!status\.provider && !status\.model\?\.trim\(\)\)/)
  assert.match(authGateSource, /<Navigate to="\/providers\/setup" replace \/>/)
})

test('authentication shell inherits the saved Dashboard theme before login', () => {
  assert.equal(resolveAppearanceMode('system', true), 'dark')
  assert.equal(resolveAppearanceMode('system', false), 'light')
  assert.equal(resolveAppearanceMode('dark', false), 'dark')
  assert.match(authGateSource, /className="page-shell dashboard-auth-shell"/)
  assert.match(authGateSource, /data-accent=\{accentTheme\}/)
  assert.match(authGateSource, /data-color-mode=\{resolvedAppearanceMode\}/)
  assert.match(appCss, /\.dashboard-auth-header\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)/s)
  assert.match(appCss, /\.dashboard-auth-card\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--surface\)/s)
  assert.doesNotMatch(appCss, /\.dashboard-auth-shell\s*\{[^}]*var\(--page\)/s)
})

test('authentication shell uses one complete locale and offers language switching', () => {
  assert.match(authGateSource, /t\('authentication\.eyebrow'\)/)
  assert.doesNotMatch(authGateSource, /MORPHZ · OPERATOR/)
  assert.doesNotMatch(authGateSource, /\{connectionError && <code>/)
  assert.match(authGateSource, /nextDashboardLanguage\(i18n\.language\)/)
  assert.match(authGateSource, /persistDashboardLanguage\(language\)/)
  assert.match(authGateSource, /i18n\.changeLanguage\(language\)/)

  for (const text of Object.values(chineseLocale.authentication)) {
    assert.doesNotMatch(text, /\b(?:Operator|Runtime|Dashboard|Token)\b/)
  }
  for (const text of Object.values(englishLocale.authentication)) {
    assert.doesNotMatch(text, /[\u3400-\u9fff]/)
  }
})

test('a new launch URL rotates the persistent browser credential', () => {
  const persistent = new MemoryStorage()
  persistent.setItem(DASHBOARD_TOKEN_STORAGE_KEY, 'old-secret')
  assert.equal(
    resolveDashboardToken(
      { search: '?token=new-secret', hash: '' },
      { persistent },
    ),
    'new-secret',
  )
  assert.equal(persistent.getItem(DASHBOARD_TOKEN_STORAGE_KEY), 'new-secret')
})

test('an existing session credential is promoted into persistent storage', () => {
  const persistent = new MemoryStorage()
  const session = new MemoryStorage()
  session.setItem(DASHBOARD_TOKEN_STORAGE_KEY, 'legacy-secret')

  assert.equal(
    resolveDashboardToken({ search: '', hash: '' }, { persistent, session }),
    'legacy-secret',
  )
  assert.equal(persistent.getItem(DASHBOARD_TOKEN_STORAGE_KEY), 'legacy-secret')
  assert.equal(session.getItem(DASHBOARD_TOKEN_STORAGE_KEY), null)
})

test('a restricted persistent store falls back to the current page session', () => {
  const session = new MemoryStorage()
  assert.equal(
    resolveDashboardToken(
      { search: '?token=session-secret', hash: '' },
      { persistent: new RejectingStorage(), session },
    ),
    'session-secret',
  )
  assert.equal(session.getItem(DASHBOARD_TOKEN_STORAGE_KEY), 'session-secret')
})

test('hash token parsing supports direct and routed fragments', () => {
  assert.equal(
    dashboardTokenFromLocation({ search: '', hash: '#token=direct-secret' }),
    'direct-secret',
  )
  assert.equal(
    dashboardTokenFromLocation({ search: '', hash: '#/contexts/c1?token=routed-secret' }),
    'routed-secret',
  )
})
