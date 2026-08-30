import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DASHBOARD_TOKEN_STORAGE_KEY,
  dashboardTokenFromLocation,
  resolveDashboardToken,
  type DashboardTokenStorage,
} from '../src/api/auth.ts'

const authGateSource = readFileSync(
  new URL('../src/DashboardAuthGate.tsx', import.meta.url),
  'utf8',
)

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
