import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the finished Chinese and English home pages", async () => {
  const [zhResponse, enResponse] = await Promise.all([render("/"), render("/en")]);
  assert.equal(zhResponse.status, 200);
  assert.equal(enResponse.status, 200);
  const [zh, en] = await Promise.all([zhResponse.text(), enResponse.text()]);
  assert.match(zh, /一个智能体。/);
  assert.match(zh, /为长期并发工作而生/);
  assert.match(zh, /查看功能/);
  assert.match(zh, /核心功能/);
  assert.match(zh, /认知自进化/);
  assert.match(zh, /将长期记忆组织为可持久、可版本化、可求值的认知状态/);
  assert.match(zh, /认知上下文不被自动有损压缩/);
  assert.match(zh, /认知帧通过证据持续修订/);
  assert.match(zh, /当前与近期会话进入上下文/);
  assert.match(zh, /最近 24 小时内至多 50 个近期会话/);
  assert.match(zh, /智能体工作时，仍能继续对话/);
  assert.match(zh, /执行节点/);
  assert.match(zh, /认知应用/);
  assert.match(zh, /智能体运行的/);
  assert.match(zh, /新范式。/);
  assert.match(zh, /Morphz 是一款面向长期并发工作的开源智能体/);
  assert.match(zh, /认知操作系统内核/);
  assert.match(zh, /会话多路输入输出/);
  assert.match(zh, /认知帧 · 会话换入 \/ 换出/);
  assert.match(zh, /线程与目标调度/);
  assert.match(zh, /能力约束的执行接口/);
  assert.doesNotMatch(zh, /home-cognitive-os__paren/);
  assert.match(zh, /认知上下文编码/);
  assert.match(zh, /查看源码/);
  assert.match(zh, /基于 STATE-Bench 的更新评测协议：Morphz 122\/150，Letta 93\/150，Mem0 96\/150/);
  assert.match(zh, /href="\/docs\/execution-lifecycle"[^>]*><h3>并发与目标/);
  assert.match(zh, /href="\/docs\/execution-targets"[^>]*><h3>执行与安全/);
  assert.match(zh, /启动 Morphz。/);
  assert.doesNotMatch(zh, /启动一个 Morphz/);
  assert.match(zh, /curl -fsSL https:\/\/morphz\.ai\/install\.sh \| sh/);
  assert.match(zh, /aria-label="选择安装平台"/);
  assert.match(zh, /macOS/);
  assert.match(zh, /Linux/);
  assert.match(zh, /Windows/);
  assert.doesNotMatch(zh, /cargo build --release/);
  assert.match(zh, /aria-label="切换到英文"[^>]*>EN<\/a>/);
  assert.match(en, /aria-label="Switch to Chinese"[^>]*>CN<\/a>/);
  assert.match(zh, /class="context-preview__brackets"/);
  assert.match(zh, /preserveAspectRatio="none"/);
  assert.doesNotMatch(zh, /开发者预览|MORPHZ \/ DEVELOPER PREVIEW|CONTEXT ENCODING|CONTEXT SELF-MAINTENANCE|SESSION WORKING SET|检视源码|一个 Agent/);
  assert.doesNotMatch(zh, /会话结束，/);
  assert.doesNotMatch(zh, /Mind 不被压缩|NO MIND COMPACTION|挂载同一 Context|已同步|证据路径|先看结果|再追问|为什么能做到|不会被包装|论文实验继续运行|准备开源发布/);
  assert.match(en, /One Agent\./);
  assert.match(en, /A new operating/);
  assert.match(en, /model for agents\./);
  assert.match(en, /Morphz is an open-source agent for long-running, concurrent work/);
  assert.match(en, /cognitive operating-system core/);
  assert.match(en, /Frame · Session swap in \/ swap out/);
  assert.doesNotMatch(en, /Frame · Context swap in \/ swap out|Frame and Context working-set swapping/);
  assert.match(en, /SELF-EVOLVING COGNITION/);
  assert.match(en, /organizes long-term memory as persistent, versioned, evaluable cognitive state/);
  assert.match(en, /No automatic lossy Context compaction/);
  assert.match(en, /Current and recent Sessions enter Context/);
  assert.match(en, /up to 50 Sessions active within the last 24 hours/);
  assert.match(en, /Keep talking while the Agent works/);
  assert.match(en, /Execution Targets/);
  assert.match(en, /Run Morphz/);
  assert.match(en, /curl -fsSL https:\/\/morphz\.ai\/install\.sh \| sh/);
  assert.match(en, /aria-label="Choose an installation platform"/);
  assert.match(en, /COGNITIVE APPLICATIONS/);
  assert.match(en, /Updated STATE-Bench-derived protocol: Morphz 122\/150, Letta 93\/150, Mem0 96\/150/);
  assert.match(en, /CONTEXT ENCODING/);
  assert.match(en, /href="\/en\/docs\/execution-lifecycle"[^>]*><h3>Concurrency and goals/);
  assert.match(en, /href="\/en\/docs\/execution-targets"[^>]*><h3>Execution and safety/);
  assert.doesNotMatch(en, /DEVELOPER PREVIEW/i);
  assert.doesNotMatch(en, /NO MIND COMPACTION|compacting the Mind|Sessions mounted in one Context|synced|EVIDENCE PATH|See the behavior|ask how it holds|WHY IT WORKS|not presented as a production promise|Keep the paper experiment|Prepare the open-source release/i);
  for (const html of [zh, en]) {
    assert.match(html, /Morphz/);
    assert.match(html, /github\.com\/morphz-ai\/morphz/);
    assert.doesNotMatch(html, /github\.com\/yaowenai\/morphz/);
    assert.doesNotMatch(html, /共享认知 Agent|Shared-Mind Agent/);
    assert.doesNotMatch(html, /实时人格|Live agent/);
    assert.doesNotMatch(html, /S 表达式认知机|S-Expression Cognitive Machine/);
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
  }
});

test("uses one site header across landing and content pages", async () => {
  const zhRoutes = ["/", "/paper", "/download", "/docs", "/blog"];
  const enRoutes = ["/en", "/en/paper", "/en/download", "/en/docs", "/en/blog"];
  const responses = await Promise.all([...zhRoutes, ...enRoutes].map(render));
  for (const response of responses) assert.equal(response.status, 200);
  const pages = await Promise.all(responses.map((response) => response.text()));

  for (const html of pages.slice(0, zhRoutes.length)) {
    const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0] ?? "";
    assert.match(header, /文章[\s\S]*?论文[\s\S]*?文档[\s\S]*?下载[\s\S]*?源码[\s\S]*?class="language-switch"[^>]*>EN<\/a>/);
    assert.match(header, /class="theme-toggle"[\s\S]*?aria-label="切换明暗主题"/);
    assert.doesNotMatch(header, /共享认知 Agent|实时人格|>English<|导航[\s\S]*?\+/);
  }

  for (const html of pages.slice(zhRoutes.length)) {
    const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0] ?? "";
    assert.match(header, /Essay[\s\S]*?Paper[\s\S]*?Docs[\s\S]*?Download[\s\S]*?Source[\s\S]*?class="language-switch"[^>]*>CN<\/a>/);
    assert.match(header, /class="theme-toggle"[\s\S]*?aria-label="Toggle color theme"/);
    assert.doesNotMatch(header, /Shared-Mind Agent|Live agent|>Chinese<|Menu[\s\S]*?\+/);
  }
});

test("renders documentation indexes and bilingual article routes", async () => {
  const routes = [
    "/docs",
    "/en/docs",
    "/docs/core-concepts",
    "/en/docs/core-concepts",
    "/docs/contexts-and-recall",
    "/docs/principals-and-authority",
    "/en/docs/principals-and-authority",
    "/docs/sessions-and-concurrency",
    "/en/docs/sessions-and-concurrency",
    "/docs/cognitive-applications",
    "/en/docs/cognitive-applications",
    "/docs/agent-trajectories",
    "/en/docs/agent-trajectories",
  ];
  const responses = await Promise.all(routes.map(render));
  for (const response of responses) assert.equal(response.status, 200);
  const pages = new Map(await Promise.all(responses.map(async (response, index) => [routes[index], await response.text()])));
  assert.match(pages.get("/docs"), /从真实任务开始理解 Morphz/);
  assert.match(pages.get("/en/docs"), /Learn Morphz through real tasks/);
  assert.match(pages.get("/docs/core-concepts"), /面向长期、并发工作的开源智能体/);
  assert.match(pages.get("/docs/core-concepts"), /认知自进化/);
  assert.match(pages.get("/docs/core-concepts"), /主体/);
  assert.match(pages.get("/docs/core-concepts"), /长期记忆与认知自进化/);
  assert.match(pages.get("/docs/core-concepts"), /主体与授权/);
  assert.match(pages.get("/en/docs/core-concepts"), /open-source agent for durable, concurrent work/);
  assert.match(pages.get("/en/docs/core-concepts"), /self-evolving cognition/);
  assert.match(pages.get("/en/docs/core-concepts"), /Principal identity/);
  assert.match(pages.get("/docs/principals-and-authority"), /谁正在与智能体交互/);
  assert.match(pages.get("/en/docs/principals-and-authority"), /source of authority/);
  assert.match(pages.get("/docs/contexts-and-recall"), /退役不是失效或删除/);
  assert.match(pages.get("/docs/sessions-and-concurrency"), /会话退役与恢复/);
  assert.match(pages.get("/en/docs/sessions-and-concurrency"), /Retiring and restoring Session attention/);
  assert.match(pages.get("/docs/cognitive-applications"), /安装不等于运行或授权/);
  assert.match(pages.get("/en/docs/cognitive-applications"), /Installation is not activation or authority/);
  assert.match(pages.get("/docs/agent-trajectories"), /执行轨迹只投影其中与指定范围有关的因果状态转换/);
  assert.match(pages.get("/en/docs/agent-trajectories"), /Trajectory projects only the causal state transitions relevant to its selected scope/);
  assert.doesNotMatch(pages.get("/docs/core-concepts"), /status-badge--current/);
  assert.doesNotMatch(pages.get("/en/docs/core-concepts"), /status-badge--current/);
  assert.match(pages.get("/docs/core-concepts"), /href="\/en\/docs\/core-concepts"[^>]*class="language-switch"/);
  assert.match(pages.get("/en/docs/core-concepts"), /href="\/docs\/core-concepts"[^>]*class="language-switch"/);
  assert.doesNotMatch(pages.get("/docs/core-concepts"), /docs-toolbar__language/);
  assert.doesNotMatch(pages.get("/en/docs/core-concepts"), /docs-toolbar__language/);
});

test("uses the Dashboard electric-cyan palette across the public site", async () => {
  const css = await readFile(new URL("../app/clean-theme.css", import.meta.url), "utf8");
  assert.match(css, /--theme-accent: light-dark\(#168997, #56d0de\);/);
  assert.match(css, /--theme-accent-strong: light-dark\(#08636e, #8adfe7\);/);
  assert.match(css, /--theme-accent-bright: light-dark\(#56d0de, #63d5df\);/);
  assert.doesNotMatch(css, /#315bea|#2448ca|#edf1ff/i);
});

test("follows the system color scheme and remembers an explicit theme", async () => {
  const [css, layout, toggle] = await Promise.all([
    readFile(new URL("../app/clean-theme.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ThemeToggle.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(css, /color-scheme: light dark/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(layout, /localStorage\.getItem\("morphz-theme"\)/);
  assert.match(toggle, /localStorage\.setItem\("morphz-theme", next\)/);
});

test("keeps mobile navigation separate from the language switch", async () => {
  const header = await readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8");
  assert.match(header, /<details className="site-menu">[\s\S]*?<div className="site-header__meta">/);
  assert.match(header, /site-menu__icon/);
  assert.match(header, /aria-label=\{t\.menu\}/);
  assert.doesNotMatch(header, /<summary>\{t\.menu\}<span aria-hidden="true">\+<\/span><\/summary>/);
});

test("ships scroll motion as accessible progressive enhancement", async () => {
  const [motion, layout, controller] = await Promise.all([
    readFile(new URL("../app/motion.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SiteMotion.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /<SiteMotion \/>/);
  assert.match(controller, /IntersectionObserver/);
  assert.match(controller, /prefers-reduced-motion: reduce/);
  assert.match(controller, /--signature-left-x/);
  assert.match(controller, /--signature-progress/);
  assert.match(controller, /--card-drift/);
  assert.match(controller, /home-mechanism__steps.*visibleProgress/);
  assert.match(motion, /home-capability-domain__signature/);
  assert.match(motion, /--row-indent/);
  assert.match(motion, /home-capability-domain__signature\.is-visible \.home-capability-signature__main/);
  assert.match(motion, /@keyframes signatureSweep/);
  assert.match(motion, /signature-concurrency__rays/);
  assert.match(motion, /signature-concurrency__center/);
  assert.match(motion, /signature-execution-commands/);
  assert.match(motion, /--command-progress/);
  assert.match(motion, /clip-path/);
  assert.match(motion, /@media \(prefers-reduced-motion: reduce\)/);
});

test("renders the bilingual journal and its first essay", async () => {
  const slug = "from-chat-completion-to-structured-context-evaluation";
  const routes = ["/blog", "/en/blog", `/blog/${slug}`, `/en/blog/${slug}`];
  const responses = await Promise.all(routes.map(render));
  for (const response of responses) assert.equal(response.status, 200);
  const html = await Promise.all(responses.map((response) => response.text()));
  assert.match(html[0], /Morphz 技术文章/);
  assert.match(html[1], /Morphz technical articles/);
  assert.match(html[2], /从聊天补全到结构化上下文求值/);
  assert.match(html[2], /聊天历史不是认知状态/);
  assert.match(html[2], /作者/);
  assert.match(html[2], /Morphz Project/);
  assert.match(html[3], /From Chat Completion to Structured Context Evaluation/);
  assert.match(html[3], /A transcript is not cognitive state/);
  assert.match(html[3], /By/);
  assert.match(html[3], /Morphz Project/);
  assert.doesNotMatch(html[2], /我叫 Morphz|一台认知机，也应当拥有自己的声音/);
  assert.doesNotMatch(html[3], /I am Morphz|A cognitive machine should have a voice of its own/);
});

test("renders the bilingual paper and native distribution pages", async () => {
  const routes = ["/paper", "/en/paper", "/download", "/en/download"];
  const responses = await Promise.all(routes.map(render));
  for (const response of responses) assert.equal(response.status, 200);
  const html = await Promise.all(responses.map((response) => response.text()));

  assert.match(html[0], /结构化上下文上的/);
  assert.match(html[0], /非确定性认知符号求值/);
  assert.match(html[0], /morphz_nondeterministic_cognitive_symbol_evaluation_preprint_zh\.pdf/);
  assert.match(html[1], /Nondeterministic Cognitive/);
  assert.match(html[1], /Symbol Evaluation over/);
  assert.match(html[1], /Structured Context/);
  assert.match(html[1], /morphz_nondeterministic_cognitive_symbol_evaluation_preprint_en\.pdf/);
  assert.match(html[2], /macOS/);
  assert.match(html[2], /Linux/);
  assert.match(html[2], /Windows/);
  assert.doesNotMatch(html[2], /独立执行节点客户端/);
  assert.doesNotMatch(html[3], /standalone Execution Target client/);
  assert.match(html[2], /curl -fsSL https:\/\/morphz\.ai\/install\.sh \| sh/);
  assert.match(html[2], /irm https:\/\/morphz\.ai\/install\.ps1 \| iex/);
  assert.match(html[3], /GitHub Releases/);

  for (const filename of [
    "morphz_nondeterministic_cognitive_symbol_evaluation_preprint_zh.pdf",
    "morphz_nondeterministic_cognitive_symbol_evaluation_preprint_en.pdf",
  ]) {
    const paper = await stat(new URL(`../public/paper/${filename}`, import.meta.url));
    assert.ok(paper.size > 100_000, `${filename} is missing or unexpectedly small`);
  }
});

test("publishes installers that resolve verified GitHub Release assets", async () => {
  const [shellSource, shellPublic, powershellSource, powershellPublic] = await Promise.all([
    readFile(new URL("../../scripts/install.sh", import.meta.url), "utf8"),
    readFile(new URL("../public/install.sh", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/install.ps1", import.meta.url), "utf8"),
    readFile(new URL("../public/install.ps1", import.meta.url), "utf8"),
  ]);
  assert.equal(shellPublic, shellSource);
  assert.equal(powershellPublic, powershellSource);
  assert.match(shellSource, /github\.com\/\$repository\/releases\/latest\/download/);
  assert.match(shellSource, /sha256sum|shasum/);
  assert.doesNotMatch(shellSource, /unpacked\/morphz-edge/);
  assert.match(powershellSource, /Get-FileHash -Algorithm SHA256/);
  assert.doesNotMatch(powershellSource, /"morphz-edge\.exe"/);
});

test("lets the home page select native installation commands", async () => {
  const source = await readFile(new URL("../app/components/HomeInstallCommand.tsx", import.meta.url), "utf8");
  assert.match(source, /navigator\.platform/);
  assert.match(source, /install\.sh \| sh/);
  assert.match(source, /install\.ps1 \| iex/);
  assert.match(source, /aria-pressed=\{platform === key\}/);
});

test("does not advertise the unpublished online Morphz instance", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /chat\.morphz\.ai/);
  assert.doesNotMatch(html, /与 Morphz 对话|在线实例/);
  assert.doesNotMatch(html, /实时人格/);
  assert.match(html, /论文/);
  assert.match(html, /下载/);
  assert.doesNotMatch(html, /创建我的 Agent|私有 Agent|个人 Agent/);
});

test("returns not found for an unknown documentation slug", async () => {
  const response = await render("/docs/not-a-real-page");
  assert.equal(response.status, 404);
  assert.match(await response.text(), /UNRESOLVED REFERENCE/);
});

test("returns not found for an unknown journal slug", async () => {
  const response = await render("/blog/not-a-real-essay");
  assert.equal(response.status, 404);
});

test("publishes crawler discovery files", async () => {
  const [robotsResponse, sitemapResponse] = await Promise.all([
    render("/robots.txt"),
    render("/sitemap.xml"),
  ]);
  assert.equal(robotsResponse.status, 200);
  assert.equal(sitemapResponse.status, 200);
  const [robots, sitemap] = await Promise.all([
    robotsResponse.text(),
    sitemapResponse.text(),
  ]);
  assert.match(robots, /Sitemap: https:\/\/morphz\.ai\/sitemap\.xml/);
  assert.match(sitemap, /https:\/\/morphz\.ai\/en\/docs\/core-concepts/);
  assert.match(sitemap, /hreflang="zh-CN"/);
  assert.match(sitemap, /hreflang="en"/);
});
