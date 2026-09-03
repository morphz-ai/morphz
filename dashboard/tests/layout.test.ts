import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const dashboardViewportSource = readFileSync(
  new URL('../src/app/dashboardViewport.ts', import.meta.url),
  'utf8',
)
const threadCausalCardSource = readFileSync(
  new URL('../src/pages/ThreadCausalCard.tsx', import.meta.url),
  'utf8',
)
const schedulerTypesSource = readFileSync(
  new URL('../src/scheduler/types.ts', import.meta.url),
  'utf8',
)
const zhCatalog = readFileSync(new URL('../src/i18n/locales/zh.json', import.meta.url), 'utf8')
const optimisticMessagesSource = readFileSync(
  new URL('../src/app/optimisticMessages.ts', import.meta.url),
  'utf8',
)
const runtimeOverviewSource = readFileSync(
  new URL('../src/pages/RuntimeOverviewPage.tsx', import.meta.url),
  'utf8',
)
const runtimeMonitorSource = readFileSync(
  new URL('../src/pages/RuntimeMonitor.tsx', import.meta.url),
  'utf8',
)
const runtimePageSource = readFileSync(
  new URL('../src/pages/RuntimePage.tsx', import.meta.url),
  'utf8',
)
const credentialsSource = readFileSync(
  new URL('../src/pages/CredentialsPage.tsx', import.meta.url),
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

test('Session WebSocket errors close the failed transport and enter the reconnect path', () => {
  assert.match(
    appSource,
    /nextSocket\.onerror\s*=\s*\(\)\s*=>\s*\{[\s\S]*?setWsStatus\('disconnected'\)[\s\S]*?nextSocket\.close\(\)/s,
    'a transient WebSocket error must not leave the Dashboard permanently stuck in a false disconnected state',
  )
  assert.match(
    appSource,
    /nextSocket\.onclose\s*=\s*\(\)\s*=>\s*\{[\s\S]*?socket = undefined[\s\S]*?reconnectTimer = window\.setTimeout\(connect, 2500\)/s,
    'the failed Session transport must be replaced through one deterministic reconnect path',
  )
})

test('human approval surfaces expose one-shot plus Thread, Objective, and Session scoped rules', () => {
  assert.match(
    schedulerTypesSource,
    /ApprovalDecision = 'allow_once' \| 'allow_thread' \| 'allow_objective' \| 'allow_session' \| 'deny'/,
    'the Dashboard transport must preserve every supported authority scope',
  )
  for (const source of [appSource, threadCausalCardSource]) {
    assert.match(source, /decideApproval|onApproval/)
    assert.match(source, /'allow_once'/)
    assert.match(source, /'allow_thread'/)
    assert.match(source, /'allow_objective'/)
    assert.match(source, /'allow_session'/)
    assert.match(source, /approval_scope[^\n]*!== 'once'/)
  }
  assert.match(zhCatalog, /仅允许这一次/)
  assert.match(zhCatalog, /本线程内始终允许/)
  assert.match(zhCatalog, /本目标内始终允许/)
  assert.match(zhCatalog, /本会话内始终允许/)
  assert.match(
    appSource,
    /decision === 'allow_objective' \|\| decision === 'allow_session'[\s\S]*?requestConfirmation/,
    'Objective- and Session-scoped capability rules must require a distinct confirmation',
  )
  assert.doesNotMatch(
    zhCatalog,
    /为本会话启用完全访问并批准当前能力申请/,
    'approving one rule must never be described as changing the Session Permission Profile',
  )
  assert.match(appSource, /restrictCapabilityLease/)
  assert.match(appSource, /\/api\/capability-leases\/\$\{encodeURIComponent\(leaseId\)\}[\s\S]*?'PATCH'/)
  assert.match(runtimePageSource, /'thread' \| 'objective' \| 'session'/)
  assert.match(runtimePageSource, /lease\.scope_id/)
  assert.match(runtimePageSource, /onRestrict\(/)
  assert.match(runtimePageSource, /requested: CapabilityDeltaSummary/)
  assert.match(runtimePageSource, /onRevoke\(lease\.id, lease\.revision\)/)
  assert.match(zhCatalog, /"capabilityLeases": "授权规则"/)
  assert.match(zhCatalog, /只能取消已有权限或缩短有效期/)
  assert.match(zhCatalog, /完全访问只能从输入框的权限预设启用/)
})

test('managed credentials preserve multiline secret values', () => {
  assert.match(
    credentialsSource,
    /className="credential-value-field"[\s\S]*?<textarea[\s\S]*?value=\{value\}[\s\S]*?onChange=\{event => setValue\(event\.target\.value\)\}/s,
    'credential values must use a textarea and pass its exact multiline value into state',
  )
  assert.doesNotMatch(
    credentialsSource,
    /className="credential-value-field"[\s\S]*?<input[^>]*type="password"/s,
    'a single-line password input strips newlines from pasted SSH private keys',
  )
  assert.match(
    appCss,
    /\.credential-editor-grid textarea\s*\{[^}]*white-space:\s*pre;/s,
    'credential editors must visibly preserve the line structure of multiline values',
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

test('message images use an authenticated top-layer hover preview', () => {
  assert.match(
    appSource,
    /className="message-attachment-preview"[\s\S]*?popover="manual"/s,
    'image previews must enter the browser top layer instead of being clipped by the conversation scroller',
  )
  assert.match(
    appSource,
    /DASHBOARD_API\.response\(path\)[\s\S]*?URL\.createObjectURL\(await response\.blob\(\)\)/s,
    'stored image bytes must be read through the authenticated Dashboard transport',
  )
  assert.match(
    appCss,
    /\.message-attachment-preview\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*auto;/s,
    'the preview must be positioned against the viewport while it is in the top layer',
  )
  assert.match(appCss, /\.message-attachment-preview:popover-open\.is-positioned/)
})

test('context budget control opens above the clipped composer status row', () => {
  assert.match(
    appSource,
    /className="context-budget-popover"[\s\S]*?popover="auto"/s,
    'the context budget editor must enter the browser top layer instead of being clipped by runtime metadata overflow',
  )
  assert.match(
    appSource,
    /contextTokenBudgetPopoverRef[\s\S]*?showPopover\(\)[\s\S]*?positionContextTokenBudgetPopover/s,
    'opening the context budget control must display and position its top-layer editor',
  )
  assert.match(
    appCss,
    /\.context-budget-popover\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*auto;[^}]*max-height:\s*calc\(var\(--morphz-visual-height,\s*100dvh\) - 24px\)/s,
    'the context budget editor must use measured visual-viewport coordinates and remain bounded on small displays',
  )
})

test('cognitive coordination separates global Mesh health from its Context routing mode', () => {
  assert.match(
    appSource,
    /\/api\/experimental\/cognitive-coordination\/status/,
    'peer health must come from the Runtime coordination status surface',
  )
  assert.match(
    appSource,
    /coordination-status-popover[\s\S]*?peer\.healthy[\s\S]*?peer\.latency_ms/s,
    'the status panel must distinguish live handshake health and latency',
  )
  assert.match(
    appSource,
    /coordination-assignment-section[\s\S]*?cognitiveCoordinationStatus\?\.assignments[\s\S]*?assignment\.status/s,
    'the Runtime-wide status panel must expose durable active and recent coordination assignments',
  )
  assert.match(
    appSource,
    /className="runtime-side"[\s\S]*?coordination-network-selector[\s\S]*?coordination-status-popover/s,
    'the process-scoped Mesh health entry must live in the global Runtime header',
  )
  assert.match(
    appSource,
    /className="runtime-side"[\s\S]*?cognitive-coordination-selector[\s\S]*?toggleCognitiveCoordination\(\)[\s\S]*?coordination-network-selector/s,
    'the Context-scoped coordinated-evaluation mode must live in the header immediately before process-scoped Mesh health',
  )
  assert.doesNotMatch(
    appSource,
    /coordination-health-button[^\n]*has-healthy-peers/,
    'healthy peers are status data and must not make the network-list button look enabled',
  )
  assert.doesNotMatch(
    appCss,
    /\.coordination-health-button\.has-healthy-peers/,
    'only the Context coordination toggle may use an enabled-state highlight',
  )
  assert.doesNotMatch(
    appSource,
    /className="composer-policy-controls"[\s\S]*?cognitive-coordination-selector/s,
    'the Context-scoped coordinated-evaluation mode must not be presented as a per-Session composer setting',
  )
  assert.match(
    appSource,
    /peer\.healthy[\s\S]*?cognitiveCoordination\.probeFailed/s,
    'failed handshakes must be labelled as failures instead of presenting elapsed failure time as healthy latency',
  )
  assert.match(
    appSource,
    /setCognitiveCoordinationStatusError\(reason instanceof Error \? reason\.message : String\(reason\)\)/,
    'the status surface must preserve the Runtime diagnostic instead of replacing it with a generic unconfigured state',
  )
  assert.match(
    appCss,
    /\.coordination-status-popover\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*auto/s,
    'the coordination status panel must use viewport coordinates outside the clipped composer row',
  )
})

test('narrow navigation remains a horizontally accessible function rail', () => {
  assert.match(
    appCss,
    /@media \(max-width: 1080px\)[\s\S]*?\.runtime-navigation-row\s*\{[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-x:\s*contain;/s,
    'the complete narrow chrome row must support native horizontal navigation',
  )
  assert.match(
    appCss,
    /@media \(max-width: 1080px\)[\s\S]*?\.runtime-navigation\s*\{[^}]*min-width:\s*max-content;[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*visible;/s,
    'primary navigation must keep its intrinsic width instead of being squeezed out by page controls',
  )
  assert.match(
    appCss,
    /@media \(max-width: 1080px\)[\s\S]*?\.immersive-controls\s*\{[^}]*position:\s*sticky;[^}]*right:\s*0;/s,
    'the trailing immersive action must remain reachable while the function rail scrolls',
  )
})

test('identity selectors reserve stable header widths while allowing responsive shrinkage', () => {
  assert.match(
    appSource,
    /<UserRound className="principal-directory-icon" size=\{14\} \/>/,
    'the Principal directory must use an identity icon rather than the language globe',
  )
  assert.doesNotMatch(appSource, /<Globe className="principal-directory-icon"/)
  assert.match(
    appCss,
    /\.identity-trail > \.context-selector\s*\{[^}]*max-width:\s*210px;[^}]*flex:\s*0 1 210px/s,
  )
  assert.match(
    appCss,
    /\.identity-trail > \.session-selector\s*\{[^}]*max-width:\s*250px;[^}]*flex:\s*0 1 250px/s,
  )
  assert.match(
    appCss,
    /\.identity-trail > \.principal-selector\s*\{[^}]*max-width:\s*300px;[^}]*flex:\s*0 1 300px/s,
    'a longer Principal identifier must truncate inside a stable slot rather than shifting the rest of the header',
  )
  assert.match(
    appCss,
    /\.identity-trail \.context-chip,[\s\S]*?\.identity-trail \.principal-chip\s*\{[^}]*width:\s*100%/s,
  )
  assert.match(
    appCss,
    /@media \(max-width: 520px\)[\s\S]*?\.identity-trail > \.principal-selector\s*\{[^}]*width:\s*34px;[^}]*max-width:\s*34px;[^}]*flex:\s*0 0 34px/s,
    'the stable desktop slots must yield to the compact mobile Principal directory button',
  )
})

test('composer paste sends clipboard files through the existing attachment importer', () => {
  assert.match(
    appSource,
    /onPaste=\{event => \{[\s\S]*?event\.clipboardData\.items[\s\S]*?item\.kind === 'file'[\s\S]*?event\.preventDefault\(\)[\s\S]*?void addFiles\(files\)/s,
    'pasted images must reuse the same validated importer as drag-and-drop',
  )
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

test('global attention uses the Runtime overview authority and opens its matching surface', () => {
  assert.match(
    appSource,
    /const globalAttentionCount = runtimeOverview\?\.summary\.attention_required \?\? attentionCount/,
    'the global header badge must share the Runtime overview attention count instead of recomputing one Context',
  )
  assert.match(
    appSource,
    /className=\{`theme-button global-attention[^`]+`\}[\s\S]*?onClick=\{\(\) => setView\('runtime'\)\}[\s\S]*?globalAttentionCount > 0 && <em>\{globalAttentionCount\}<\/em>/,
    'the global attention action must open the Runtime-wide surface represented by its badge',
  )
})

test('runtime monitor exposes revision-fenced work controls without conflating steering and replacement', () => {
  assert.match(
    runtimeMonitorSource,
    /onThreadControl:[\s\S]*?'pause' \| 'resume' \| 'cancel'/,
    'live Threads must expose their lifecycle controls through one typed control contract',
  )
  assert.match(
    runtimeMonitorSource,
    /onThreadSupersede:[\s\S]*?RuntimeOverviewThread/,
    'correcting a Thread must remain a distinct supersede operation rather than an enqueue alias',
  )
  assert.match(
    appSource,
    /threads\/\$\{encodeURIComponent\(thread\.id\)\}\/supersede[\s\S]*?expected_revision:\s*thread\.revision/,
    'Dashboard replacement must carry the observed Thread revision so stale operator actions cannot win',
  )
  assert.match(
    runtimeMonitorSource,
    /onObjectiveControl:[\s\S]*?'pause' \| 'resume' \| 'cancel'/,
    'Objective controls must be available beside their live state',
  )
  assert.match(
    runtimeMonitorSource,
    /onDelegationCancel:[\s\S]*?delegationId/,
    'Delegation tree cancellation must be available from the same work monitor',
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
  assert.match(
    appCss,
    /\.frame-library\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*flex-direction:\s*column/s,
    'the Mind Frame library must stretch with the inspector while constraining its list viewport',
  )
  assert.match(
    appCss,
    /\.frame-list\s*\{[^}]*min-height:\s*0;[^}]*max-height:\s*none;[^}]*overflow-y:\s*auto;[^}]*flex:\s*1 1 0/s,
    'the Mind Frame list must consume the full aligned card height before it scrolls',
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

test('the composer exposes all three one-shot message scheduling modes', () => {
  assert.match(
    appSource,
    /event\.altKey[\s\S]*?submit\('parallel'\)[\s\S]*?event\.ctrlKey \|\| event\.metaKey[\s\S]*?submit\('follow_up'\)/s,
    'Option/Alt+Enter must send concurrently and Ctrl/Command+Enter must queue a follow-up',
  )
  assert.match(
    appSource,
    /submit\('interrupt'\)[\s\S]*?submit\('parallel'\)[\s\S]*?submit\('follow_up'\)/s,
    'the send menu must expose interrupt, concurrent and follow-up choices',
  )
  assert.match(
    `${appSource}\n${optimisticMessagesSource}`,
    /\.\.\.\(dispatchMode \? \{ dispatch_mode: dispatchMode \} : \{\}\)/,
    'an explicit one-shot choice must cross the HTTP boundary without changing the default configuration',
  )
})

test('stopping a reply targets its exact DialogueTurn instead of cancelling a Session', () => {
  assert.doesNotMatch(
    appSource,
    /cancelCurrentSession|\/api\/sessions\/\$\{encodeURIComponent\(selectedSessionId\)\}\/cancel/,
    'the composer must not present broad Session Thread cancellation as a reply stop action',
  )
  assert.match(
    appSource,
    /const stopDialogueTurn = async \(thread: ThreadRecord\)[\s\S]*?thread\.kind !== 'dialogue_turn'[\s\S]*?action: 'cancel'[\s\S]*?expected_revision: thread\.revision/s,
    'reply stop must be revision-fenced and restricted to the exact live DialogueTurn',
  )
  assert.match(
    appSource,
    /dialogueStreamingAttempts\.map[\s\S]*?className="stream-control-line"[\s\S]*?className="turn-stop-button"[\s\S]*?stopDialogueTurn\(dialogueThread\)[\s\S]*?<ReasoningSummaryBlock/s,
    'each live reply must keep its stop control in the fixed metadata row before growing streamed content',
  )
  assert.match(
    appCss,
    /\.stream-control-line\s*\{[^}]*justify-content:\s*flex-start[^}]*\}[\s\S]*?\.stream-control-line \.turn-stop-button\s*\{[^}]*flex:\s*0 0 auto[^}]*padding:\s*3px 6px[^}]*font:\s*600 8px\/1 var\(--mono\)/s,
    'the streaming control row keeps a compact stop action reachable while the reply grows',
  )
  assert.match(
    appCss,
    /\.turn-stop-button:hover:not\(:disabled\)[^}]*var\(--red-soft\)/s,
    'the destructive affordance should remain quiet until the user points at it',
  )
})

test('composer runtime metadata reserves green for actual health', () => {
  assert.match(
    appCss,
    /\.composer-telemetry \.token-usage\s*\{[^}]*color:\s*var\(--text-soft\)/s,
  )
  assert.match(
    appCss,
    /\.composer-telemetry \.token-usage\.exact-usage\s*\{[^}]*color:\s*var\(--faint\)/s,
  )
  assert.match(
    appCss,
    /\.composer-model-control\.ok\s*\{[^}]*color:\s*var\(--text-soft\)/s,
  )
  assert.match(
    appCss,
    /\.connection-status \.status-dot\s*\{[^}]*background:\s*var\(--green\)/s,
    'green remains a health signal on the actual connection indicator',
  )
})

test('composer separates stable policy controls from read-only telemetry', () => {
  assert.match(
    appSource,
    /className="composer-policy-controls"[\s\S]*?composer-permission-control[\s\S]*?composer-model-control[\s\S]*?className="composer-reasoning-control"[\s\S]*?className="context-budget-selector"[\s\S]*?<Composer[\s\S]*?className="composer-footer-row"[\s\S]*?className="shortcut-row"[\s\S]*?className="composer-telemetry"[\s\S]*?token-usage[\s\S]*?connection-status/s,
    'permission policy leads the right-aligned control group before model, reasoning and context while shortcuts and telemetry share one footer row',
  )
  assert.match(
    appCss,
    /\.composer-model-control\s*\{[^}]*width:\s*clamp\(156px, 15vw, 205px\)[^}]*overflow:\s*hidden/s,
    'the model selector reserves a stable width and truncates long labels instead of shifting adjacent controls',
  )
  assert.match(
    appCss,
    /\.composer-footer-row\s*\{[^}]*justify-content:\s*space-between[^}]*\}[\s\S]*?\.composer-telemetry\s*\{[^}]*flex:\s*0 0 auto[^}]*justify-content:\s*flex-end[^}]*\}/s,
    'shortcuts stay left while read-only token and connection status share the right edge on the same row',
  )
  assert.match(
    appCss,
    /@media \(max-width:\s*820px\)[\s\S]*?\.composer-footer-row\s*\{\s*display:\s*none;\s*\}/s,
    'phone layouts remove the complete desktop footer row instead of hiding shortcuts while retaining an empty layout track',
  )
})

test('mobile shell follows the usable visual viewport without a scrollable root gap', () => {
  assert.match(indexHtml, /viewport-fit=cover/)
  assert.match(indexHtml, /interactive-widget=resizes-content/)
  assert.match(
    indexCss,
    /html,[\s\S]*?body,[\s\S]*?#root\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s,
  )
  assert.match(
    indexCss,
    /body\s*\{[^}]*position:\s*fixed[^}]*top:\s*var\(--morphz-visual-top[^}]*height:\s*var\(--morphz-visual-height[^}]*overscroll-behavior:\s*none/s,
  )
  assert.match(
    appCss,
    /\.morphz-shell\s*\{[\s\S]*?height:\s*100vh;\s*height:\s*100dvh;\s*height:\s*var\(--morphz-visual-height,\s*100dvh\)[\s\S]*?padding-top:\s*var\(--morphz-safe-top\)/s,
    'the shell must use the measured visual viewport and reserve the top device safe area',
  )
  assert.match(
    appCss,
    /@media \(hover:\s*none\) and \(pointer:\s*coarse\)\s*\{\s*\.composer-footer-row\s*\{\s*display:\s*none;/s,
    'touch phones using a desktop-sized CSS viewport must still hide the desktop telemetry row',
  )
  assert.match(appCss, /max\(5px,\s*var\(--morphz-safe-bottom\)\)/)
  assert.match(
    appCss,
    /\.dashboard-auth-shell\s*\{[^}]*height:\s*100%[^}]*padding:\s*var\(--morphz-safe-top\)[^}]*var\(--morphz-safe-bottom\)/s,
    'the authentication surface must use the same visual viewport and device safe areas',
  )
  assert.match(mainSource, /installDashboardViewportGuard\(\)/)
  assert.match(dashboardViewportSource, /visualViewport/)
  assert.match(dashboardViewportSource, /viewport\.offsetTop/)
  assert.match(dashboardViewportSource, /target\.scrollTo\(0, 0\)/)
  assert.match(dashboardViewportSource, /focusout/)
})

test('composer activity dots cannot collapse under long task text', () => {
  assert.match(
    appCss,
    /\.composer-task-status i\s*\{[^}]*flex:\s*0 0 7px[^}]*border-radius:\s*50%/s,
  )
})

test('provider model manager scrolls without collapsing catalog rows', () => {
  assert.match(
    appCss,
    /\.provider-model-manager-list\s*\{[^}]*display:\s*flex[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto[^}]*flex-direction:\s*column[^}]*\}/s,
    'the model catalog owns the remaining dialog height and scrolls as a vertical list',
  )
  assert.match(
    appCss,
    /\.provider-model-manager-list > article\s*\{[^}]*flex:\s*0 0 auto[^}]*overflow:\s*hidden[^}]*\}/s,
    'model cards must retain their content height instead of shrinking into border lines',
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

test('runtime overview exposes the Operator-owned Session history sharing policy honestly', () => {
  assert.match(
    runtimeOverviewSource,
    /item\.session\.context_sharing === 'isolated'/,
    'Session cards must render the authoritative persisted sharing policy',
  )
  assert.match(
    runtimeOverviewSource,
    /onChangeContextSharing\(isolated \? 'shared' : 'isolated'\)/,
    'the card control must explicitly toggle between shared and isolated history',
  )
  assert.match(
    appSource,
    /DASHBOARD_API\.command<SessionRecord>\(\s*`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}`,[\s\S]*?'PATCH',[\s\S]*?\{ context_sharing: contextSharing \}/,
    'the Dashboard must persist the policy through the Session control-plane endpoint',
  )
})
