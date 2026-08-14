import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
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

test('laptop viewports keep both dashboard chrome bands on one row', () => {
  assert.match(
    appCss,
    /\.identity-chip small\s*\{[^}]*white-space:\s*nowrap/s,
    'compact identity labels such as 会话 must never wrap between Chinese characters',
  )
  assert.match(
    appCss,
    /@media \(max-width: 2200px\)[\s\S]*?\.runtime-header\s*\{[^}]*grid-template-rows:\s*auto;/s,
    'the identity header must remain one compact row on laptop viewports',
  )
  assert.match(
    appCss,
    /@media \(max-width: 2200px\)[\s\S]*?\.runtime-navigation\s*\{[^}]*overflow-x:\s*hidden/s,
    'navigation must distribute its destinations instead of retaining stale horizontal scroll',
  )
  assert.match(
    appCss,
    /@media \(max-width: 2200px\)[\s\S]*?\.navigation-page-toolbar\s*\{[^}]*width:\s*min\(46vw, 760px\);[^}]*flex:\s*0 1 760px/s,
    'the page-tool slot must reserve one stable width while its conversation controls shrink inside it',
  )
  assert.match(
    appSource,
    /<div className="navigation-page-toolbar">\s*\{view === 'dialogue' && selectedSessionId && \(/s,
    'every view must reserve the same page-tool slot so primary navigation positions do not move',
  )
  assert.match(
    appCss,
    /@media \(max-width: 1320px\)[\s\S]*?\.runtime-side \.reasoning-summary-toggle span,[\s\S]*?\.runtime-side \.global-attention span,[\s\S]*?display:\s*none/s,
    'lower-priority Runtime labels must collapse to named icon controls before the header wraps',
  )
  assert.match(
    appCss,
    /@media \(max-width: 1320px\)[\s\S]*?\.runtime-side \.language-toggle\s*\{[^}]*width:\s*48px/s,
    'the compact language control must retain enough width for its ZH/EN value',
  )
  assert.equal(
    appSource.match(/aria-label=\{t\('navigation\.[^']+'\)\}/g)?.length,
    9,
    'the navigation landmark and every icon-only mobile destination must retain accessible labels',
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

test('execution targets share the tool heading row instead of competing with command text', () => {
  assert.match(
    appSource,
    /<span className="execution-tool-heading">[\s\S]*?<strong>\{summary\.title\}<\/strong>[\s\S]*?className="execution-tool-target"[\s\S]*?<small>\s*<span>\{summary\.target/s,
    'the physical execution target must sit beside the tool title, above the command summary',
  )
  assert.match(
    appCss,
    /\.execution-tool-target\s*\{[^}]*max-width:\s*100%/s,
    'the target badge must be allowed to use the heading row rather than an arbitrary 48% cap',
  )
  assert.match(
    appCss,
    /\.execution-tool-target > span\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s,
    'a target that still exceeds the viewport must truncate predictably while its title exposes the full value',
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
