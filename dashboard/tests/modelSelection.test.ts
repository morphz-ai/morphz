import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSelectedModelOption } from '../src/app/modelSelection.ts'

test('model selection resolves stable route IDs before display aliases', () => {
  const options = [
    { id: 'route-a', label: 'Physical A', aliases: ['route-b'] },
    { id: 'route-b', label: 'Physical B', aliases: ['Friendly B'] },
  ]

  assert.equal(resolveSelectedModelOption(options, 'route-b')?.label, 'Physical B')
  assert.equal(resolveSelectedModelOption(options, 'Friendly B')?.id, 'route-b')
})

test('model selection never invents an option for an unknown or empty value', () => {
  const options = [{ id: 'route-a', label: 'Exact physical model' }]

  assert.equal(resolveSelectedModelOption(options, 'gpt-5.6'), undefined)
  assert.equal(resolveSelectedModelOption(options, ''), undefined)
  assert.equal(resolveSelectedModelOption([], 'route-a'), undefined)
})
