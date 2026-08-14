import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('Principal directory loads a bounded first page before the Operator types a query', () => {
  assert.match(appSource, /if \(!principalMenuOpen\) return\s+const query = principalSearchQuery\.trim\(\)/)
  assert.doesNotMatch(appSource, /const query = principalSearchQuery\.trim\(\)\s+if \(!query\) return/)
  assert.match(appSource, /void searchPrincipalDirectory\(query\)/)
  assert.match(appSource, /query \? 220 : 0/)
})

test('Principal directory ignores stale search responses and identifies their provider', () => {
  assert.match(appSource, /principalSearchRequestSequence/)
  assert.match(appSource, /requestSequence !== principalSearchRequestSequence\.current/)
  assert.match(appSource, /entry\.principal\.id} · {entry\.principal\.provider_id/)
})

test('Principal directory explains when the Runtime cannot receive external identities', () => {
  assert.match(appSource, /status\?\.identity_mode === 'default'/)
  assert.match(appSource, /header\.defaultIdentityModeHint/)
  assert.match(appSource, /header\.trustedGatewayIdentityModeHint/)
})
