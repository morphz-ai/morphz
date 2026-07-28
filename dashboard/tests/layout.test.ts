import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')

function zIndexFor(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = appCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  const value = block?.match(/z-index:\s*(-?\d+)/)?.[1]
  assert.ok(value, `${selector} must declare a numeric z-index`)
  return Number(value)
}

test('Context and Session catalog actions stay clickable above navigation', () => {
  assert.ok(
    zIndexFor('.runtime-header') > zIndexFor('.runtime-navigation-row'),
    'the header stacking context must remain above the navigation row that its popovers overlap',
  )
})
