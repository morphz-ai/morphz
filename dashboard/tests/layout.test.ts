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

test('live model output uses the same causal tint as its durable message', () => {
  assert.match(
    appCss,
    /\.message-row\.agent\.objective-tinted\s*\{[^}]*border-left:\s*2px solid var\(--objective-color\)/s,
    'streaming rows must not be excluded from the objective/thread tint selector',
  )
  assert.doesNotMatch(appCss, /\.message-row\.agent\.objective-tinted:not\(\.streaming\)/)
  assert.match(
    appCss,
    /\.message-row\.objective-tinted \.reasoning-summary\s*\{[^}]*border-left-color:\s*var\(--objective-color\)/s,
    'live reasoning must expose the same causal colour as the response stream',
  )
  assert.match(
    appSource,
    /objectiveLineage\.forLiveRoute\(\{[\s\S]*?threadId:\s*attempt\.threadId,[\s\S]*?objectiveId:\s*attempt\.objectiveId/s,
    'the first live event must use its direct causal route instead of waiting for a Scheduler refresh',
  )
})

test('execution Thread toolchain escapes scroll clipping and flips into available viewport space', () => {
  assert.match(
    appSource,
    /className="message-thread-toolchain"[\s\S]*?popover="auto"/s,
    'the hover detail must enter the browser top layer instead of remaining clipped by the conversation scroller',
  )
  assert.match(
    appSource,
    /availableBelow >= naturalHeight \|\| availableBelow > availableAbove \? 'below' : 'above'/,
    'the hover detail must choose the side with usable viewport space',
  )
  assert.match(
    appCss,
    /\.message-thread-toolchain\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*auto;/s,
    'the top-layer toolchain must use viewport coordinates',
  )
  assert.match(appCss, /\.message-thread-toolchain:popover-open\.is-positioned/)
})

test('laptop viewports keep both dashboard chrome bands on one row', () => {
  assert.match(
    appSource,
    /<span><strong>Morphz<\/strong><small>\{t\('header\.machineTagline'\)\}<\/small><\/span>/,
    'the Morphz brand must expose the canonical machine identity instead of presenting the selected Agent as the product type',
  )
  assert.match(
    appCss,
    /\.brand small\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s,
    'the canonical English tagline must truncate rather than wrap the responsive header',
  )
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
    /@media \(max-width: 2200px\)[\s\S]*?\.runtime-navigation button\s*\{[^}]*flex:\s*0 1 auto/s,
    'navigation destinations may shrink with the viewport but must remain content-sized instead of stretching',
  )
  assert.match(
    appCss,
    /@media \(max-width: 2200px\)[\s\S]*?\.runtime-navigation button span\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s,
    'a constrained destination must truncate its label rather than widening the navigation row',
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
    /\.execution-tool-target\s*\{[^}]*font:\s*600 8\.5px\/1 var\(--mono\)/s,
    'the execution target must remain visually subordinate to the tool title',
  )
  assert.match(
    appCss,
    /\.execution-tool-target > span\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s,
    'a target that still exceeds the viewport must truncate predictably while its title exposes the full value',
  )
  assert.match(
    appSource,
    /new Map\(executionTargets\.map\(target => \[target\.id, executionTargetLabel\(target\)\]/,
    'execution target badges must use the operator-facing target label instead of the persisted display name or id',
  )
  assert.doesNotMatch(
    appSource,
    /title=\{`\$\{t\('conversation\.toolCalls\.target'\)\}: \$\{targetLabel\} \(\$\{targetIds/,
    'execution target tooltips must not expose internal target ids',
  )
})

test('System Prompt and Mind Frames use the shared S-expression reader', () => {
  assert.match(
    appSource,
    /DASHBOARD_API\.get<SystemPromptInspection>\('\/api\/runtime\/system-prompt'\)/,
    'the Dashboard must read the exact active System Prompt from the Runtime instead of reconstructing it',
  )
  assert.match(
    appSource,
    /const SExpressionReader = memo[\s\S]*?prettyPrintSExpression\(request\.source\)/,
    'one reusable reader must own S-expression formatting and syntax highlighting',
  )
  assert.match(
    appSource,
    /source: systemPrompt\.content,[\s\S]*?title: t\('systemPrompt\.reader\.title'\)/,
    'the authoritative System Prompt must open in the shared reader',
  )
  assert.match(
    appSource,
    /source: selectedFrame\.body,[\s\S]*?eyebrow: t\('mindView\.frameReader\.eyebrow'\)/,
    'a complete Mind Frame body must open in the shared reader',
  )
  assert.match(
    appCss,
    /\.sexpr-reader\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/s,
    'the shared reader must reserve a scrollable body between stable metadata and actions',
  )
})

test('the initial generating state stays visible above the composer in both conversation layouts', () => {
  assert.match(
    appSource,
    /if \(view !== 'dialogue' \|\| typeof ResizeObserver === 'undefined'\) return[\s\S]*?const conversationObserver = new ResizeObserver[\s\S]*?const container = conversationLayout === 'split'[\s\S]*?conversationLaneRef\.current[\s\S]*?: viewFrameRef\.current/s,
    'content growth must be observed in both split and merged conversations',
  )
  assert.doesNotMatch(
    appSource,
    /if \(view !== 'dialogue' \|\| conversationLayout !== 'split' \|\| typeof ResizeObserver === 'undefined'\) return/,
    'merged layout must not be excluded from stream-height correction',
  )
  assert.match(
    appSource,
    /conversationObserver\.observe\(conversationMessageListRef\.current\)/,
    'the rendered message list must drive bottom correction when badges or stream content change its height',
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
