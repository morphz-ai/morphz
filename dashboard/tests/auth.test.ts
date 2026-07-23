import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DASHBOARD_TOKEN_STORAGE_KEY,
  dashboardTokenFromLocation,
  resolveDashboardToken,
  type DashboardTokenStorage,
} from '../src/api/auth.ts'

class MemoryStorage implements DashboardTokenStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

test('launch token survives Router path replacement and refresh', () => {
  const storage = new MemoryStorage()
  assert.equal(
    resolveDashboardToken({ search: '?token=launch-secret', hash: '' }, storage),
    'launch-secret',
  )
  assert.equal(storage.getItem(DASHBOARD_TOKEN_STORAGE_KEY), 'launch-secret')

  assert.equal(
    resolveDashboardToken(
      { search: '', hash: '' },
      storage,
      'build-time-fallback',
    ),
    'launch-secret',
  )
})

test('a new launch URL rotates the browser-session credential', () => {
  const storage = new MemoryStorage()
  storage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, 'old-secret')
  assert.equal(
    resolveDashboardToken({ search: '?token=new-secret', hash: '' }, storage),
    'new-secret',
  )
  assert.equal(storage.getItem(DASHBOARD_TOKEN_STORAGE_KEY), 'new-secret')
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
