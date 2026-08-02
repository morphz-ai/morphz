import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const runtimeOverviewSource = readFileSync(
  new URL('../src/pages/RuntimeOverviewPage.tsx', import.meta.url),
  'utf8',
)

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

test('runtime overview follows the dashboard card typography hierarchy', () => {
  assert.match(
    appCss,
    /\.runtime-overview-context-toggle strong\s*\{[^}]*font-size:\s*12px/s,
    'Context titles must use the same scale as other dashboard card headings',
  )
  assert.match(
    appCss,
    /\.runtime-overview-session-title strong\s*\{[^}]*font-size:\s*11px/s,
    'Session titles must remain subordinate to Context headings',
  )
  assert.match(
    appCss,
    /\.runtime-overview-toolbar input\s*\{[^}]*font-size:\s*11px/s,
    'Overview search must use the dashboard control text scale',
  )
  assert.match(
    appCss,
    /\.runtime-overview-session-open > footer\s*\{[^}]*font-size:\s*8\.5px/s,
    'Session counters must use the compact dashboard metadata scale',
  )
  assert.doesNotMatch(
    appCss,
    /\.runtime-overview-session-open > footer\s*\{[^}]*font:\s*[^;}]*var\(--mono\)/s,
    'Chinese session metadata must not inherit a monospace font',
  )
})

test('runtime overview reveals regular Sessions and only collapses managed delegation Contexts', () => {
  assert.match(
    runtimeOverviewSource,
    /if \(item\.delegation\)\s*\{\s*next\.add\(item\.context\.id\)/s,
    'managed delegation Contexts should start collapsed',
  )
  assert.doesNotMatch(
    runtimeOverviewSource,
    /item\.attention_count === 0 && item\.running_activation_count === 0/,
    'idle regular Contexts must still reveal their Session cards on the overview',
  )
})
