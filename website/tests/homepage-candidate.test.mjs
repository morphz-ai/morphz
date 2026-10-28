import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path) {
  const { default: worker } = await import("../dist/server/index.js");
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

// Check the server-rendered document, not bundled source or serialized RSC data.
function documentHtml(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

test("candidate A preserves the brand and exposes technical and personal entrances", async () => {
  const response = await render("/homepage-lab/a");
  assert.equal(response.status, 200);
  const html = documentHtml(await response.text());
  assert.match(html, /class="hp-lab hp-theme-a"/);
  assert.match(html, /morphz-mark-cyan\.svg/);
  assert.match(html, /class="brand__wings"/);
  assert.match(html, /切换明暗主题/);
  assert.match(html, /一个智能体。/);
  assert.match(html, /创建自己的智能体/);
  assert.match(html, /与官方 Morphz 对话/);
  assert.match(html, /href="#local-install"/);
  assert.match(html, /href="#in-action"/);
  assert.ok(html.indexOf('id="homepage-heading"') < html.indexOf('id="meet-morphz"'));
  assert.match(html, /不连接真实账户服务/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
});

test("candidate A keeps Chinese prose and excludes decorative English and design notes", async () => {
  const html = documentHtml(await (await render("/homepage-lab/a")).text());
  for (const term of ["认知上下文", "并发求值", "执行节点", "核心机制", "研究论文", "第一次运行"]) {
    assert.ok(html.includes(term), term);
  }
  assert.doesNotMatch(html, /OPEN.SOURCE COGNITIVE|INSIDE MORPHZ|MEET THE AGENT|MORPHZ IN ACTION|UNDER THE HOOD|RESEARCH &amp; EVIDENCE|START BUILDING|BUILT TO EXTEND/);
  const main = html.match(/<main>([\s\S]*?)<\/main>/)?.[1];
  assert.ok(main);
  assert.doesNotMatch(main, /这是已有的|从设计主张|可检查的证据|本地候选|原站|新版|方案 A|Agent Runtime|认知.*COGNITIVE FRAME/);
  // Actual operator names and project/model names remain unchanged.
  assert.match(main, /derive · revise · retire · restore/);
  assert.match(main, /SQLite \/ PostgreSQL/);
});

test("candidate A retains the real recording, contextualized results, and real docs", async () => {
  const html = documentHtml(await (await render("/homepage-lab/a")).text());
  assert.equal((html.match(/<video\b/g) ?? []).length, 1);
  assert.match(html, /<video[^>]*controls=""[^>]*preload="none"/);
  assert.doesNotMatch(html, /<video[^>]*autoplay/i);
  assert.match(html, /morphz-live-demo-en-v1\.mp4/);
  assert.match(html, /morphz-live-demo-en-v1\.vtt/);
  assert.match(html, /基于 STATE-Bench 的更新评测协议/);
  assert.match(html, /122/);
  assert.match(html, /Letta 93 \/ 150 · Mem0 96 \/ 150/);
  const paths = [...new Set([...html.matchAll(/<a\b[^>]*\bhref="(\/[^"#?]*)"/g)].map((match) => match[1]))];
  for (const path of paths.filter((path) => !path.startsWith("/video/"))) {
    const result = await render(path);
    assert.equal(result.status, 200, `Local resource must resolve: ${path}`);
    await result.text();
  }
});

test("the selected concept is the lab default and is not in the public sitemap", async () => {
  const html = documentHtml(await (await render("/homepage-lab")).text());
  assert.match(html, /class="hp-lab hp-theme-a"/);
  const sitemap = await readFile(new URL("../app/sitemap.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sitemap, /homepage-lab/);
});
