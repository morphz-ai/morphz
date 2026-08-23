import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('Foreign Principal observation cannot retry or stop that Principal DialogueTurn', () => {
  const retryHandler = appSource.slice(
    appSource.indexOf('const retryDialogueTurn'),
    appSource.indexOf('const changeReasoningEffort'),
  )
  const stopHandler = appSource.slice(
    appSource.indexOf('const stopDialogueTurn'),
    appSource.indexOf('const controlRuntimeThread'),
  )
  assert.equal((retryHandler.match(/if \(principalScopeRef\.current\)/g) ?? []).length, 1)
  assert.equal((stopHandler.match(/if \(principalScopeRef\.current\)/g) ?? []).length, 1)
  assert.match(retryHandler, /setError\(t\('header\.principalScopeReadOnly'\)\)/)
  assert.match(stopHandler, /setError\(t\('header\.principalScopeReadOnly'\)\)/)
  assert.match(appSource, /disabled=\{observingForeignPrincipal \|\| Boolean\(retryingTurnEventId\)\}/)
  assert.match(appSource, /readOnly=\{observingForeignPrincipal\}/)
  assert.doesNotMatch(appSource, /cancelCurrentSession|onCancel=\{cancelCurrentSession\}/)
})

test('Foreign Principal observation still allows Operator Session model policy control', () => {
  const modelControlStart = appSource.indexOf('className={`composer-model-control')
  const modelControl = appSource.slice(
    modelControlStart,
    appSource.indexOf('<Composer', modelControlStart),
  )
  assert.match(modelControl, /disabled=\{changingModel \|\| !selectedSessionId\}/)
  assert.doesNotMatch(modelControl, /observingForeignPrincipal|readOnly/)
})
