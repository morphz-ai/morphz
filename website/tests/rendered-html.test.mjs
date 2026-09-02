import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
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
  assert.match(zh, /让代理拥有/);
  assert.match(zh, /认知上下文持有认知/);
  assert.doesNotMatch(zh, /Context-owned cognition|让 Agent 拥有/);
  assert.match(en, /Durable cognition/);
  for (const html of [zh, en]) {
    assert.match(html, /Morphz/);
    assert.match(html, /github\.com\/yaowenai\/morphz/);
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
  }
});

test("renders documentation indexes and bilingual article routes", async () => {
  const routes = ["/docs", "/en/docs", "/docs/core-concepts", "/en/docs/core-concepts", "/docs/contexts-and-recall"];
  const responses = await Promise.all(routes.map(render));
  for (const response of responses) assert.equal(response.status, 200);
  const html = await Promise.all(responses.map((response) => response.text()));
  assert.match(html[0], /从真实任务开始理解 Morphz/);
  assert.match(html[1], /Learn Morphz through real tasks/);
  assert.match(html[2], /认知帧/);
  assert.match(html[3], /Cognitive frame/);
  assert.match(html[4], /认知上下文、认知帧与召回/);
  assert.doesNotMatch(html[4], /Context、认知帧与 Recall/);
  assert.match(html[2], /当前实现/);
  assert.match(html[3], /Current behavior/);
});

test("renders the bilingual journal and its first essay", async () => {
  const slug = "from-chat-completion-to-structured-context-evaluation";
  const routes = ["/blog", "/en/blog", `/blog/${slug}`, `/en/blog/${slug}`];
  const responses = await Promise.all(routes.map(render));
  for (const response of responses) assert.equal(response.status, 200);
  const html = await Promise.all(responses.map((response) => response.text()));
  assert.match(html[0], /代理认知与运行时的技术说明/);
  assert.match(html[1], /Technical notes on agent cognition and runtimes/);
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

  assert.match(html[0], /结构化上下文上的非确定性认知符号求值/);
  assert.match(html[0], /morphz_nondeterministic_cognitive_symbol_evaluation_preprint_zh\.pdf/);
  assert.match(html[1], /Nondeterministic Cognitive Symbol Evaluation over Structured Context/);
  assert.match(html[1], /morphz_nondeterministic_cognitive_symbol_evaluation_preprint_en\.pdf/);
  assert.match(html[2], /macOS/);
  assert.match(html[2], /Linux/);
  assert.match(html[2], /Windows/);
  assert.match(html[2], /Windows 版是原生程序/);
  assert.match(html[3], /The Windows build is native/);

  for (const filename of [
    "morphz_nondeterministic_cognitive_symbol_evaluation_preprint_zh.pdf",
    "morphz_nondeterministic_cognitive_symbol_evaluation_preprint_en.pdf",
  ]) {
    const paper = await stat(new URL(`../public/paper/${filename}`, import.meta.url));
    assert.ok(paper.size > 100_000, `${filename} is missing or unexpectedly small`);
  }
});

test("keeps the technical main site separate from the live persona product", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /chat\.morphz\.ai/);
  assert.match(html, /实时人格/);
  assert.match(html, /论文/);
  assert.match(html, /下载/);
  assert.doesNotMatch(html, /创建我的 Agent|私有 Agent|个人 Agent/);
});

test("returns not found for an unknown documentation slug", async () => {
  const response = await render("/docs/not-a-real-page");
  assert.equal(response.status, 404);
});

test("returns not found for an unknown journal slug", async () => {
  const response = await render("/blog/not-a-real-essay");
  assert.equal(response.status, 404);
});
