import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('Foreign Principal observation cannot retry or cancel that Principal Session', () => {
  const retryHandler = appSource.slice(
    appSource.indexOf('const retryDialogueTurn'),
    appSource.indexOf('const changeReasoningEffort'),
  )
  assert.equal((retryHandler.match(/if \(principalScopeRef\.current\)/g) ?? []).length, 2)
  assert.match(retryHandler, /setError\(t\('header\.principalScopeReadOnly'\)\)/)
  assert.match(appSource, /disabled=\{observingForeignPrincipal \|\| Boolean\(retryingTurnEventId\)\}/)
  assert.match(appSource, /readOnly=\{observingForeignPrincipal\}/)
  assert.match(appSource, /disabled=\{readOnly\} onClick=\{onCancel\}/)
})

test('Foreign Principal observation still allows Operator Session model policy control', () => {
  const modelControl = appSource.slice(
    appSource.indexOf('className={`composer-model-control'),
    appSource.indexOf('<span className="connection-status"'),
  )
  assert.match(modelControl, /disabled=\{changingModel \|\| !selectedSessionId\}/)
  assert.doesNotMatch(modelControl, /observingForeignPrincipal|readOnly/)
})
