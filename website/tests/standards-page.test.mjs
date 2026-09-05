import assert from "node:assert/strict";
import test from "node:test";

async function render(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the bilingual standards narrative and primary navigation", async () => {
  const slug = "morphz_structured_context_specification_v1";
  const [zhResponse, enResponse, zhHomeResponse, enHomeResponse, zhDetailResponse, enDetailResponse] = await Promise.all([
    render("/standards"),
    render("/en/standards"),
    render("/"),
    render("/en"),
    render(`/standards/${slug}`),
    render(`/en/standards/${slug}`),
  ]);
  assert.equal(zhResponse.status, 200);
  assert.equal(enResponse.status, 200);
  assert.equal(zhHomeResponse.status, 200);
  assert.equal(enHomeResponse.status, 200);
  assert.equal(zhDetailResponse.status, 200);
  assert.equal(enDetailResponse.status, 200);

  const [zh, en, zhHome, enHome, zhDetail, enDetail] = await Promise.all([
    zhResponse.text(),
    enResponse.text(),
    zhHomeResponse.text(),
    enHomeResponse.text(),
    zhDetailResponse.text(),
    enDetailResponse.text(),
  ]);
  assert.match(zh, /为智能体运行，/);
  assert.match(zh, /建立共同语言。/);
  assert.match(zh, /Structured Context/);
  assert.match(zh, /Agent Trajectory/);
  assert.match(zh, /Cognitive Applications/);
  assert.match(zh, /Mind Frame Exchange/);
  assert.match(zh, /结构化上下文宪章/);
  assert.match(zh, /href="\/en\/standards"[^>]*class="language-switch"/);
  assert.match(en, /A common language/);
  assert.match(en, /for agent runtime\./);
  assert.match(en, /href="\/standards"[^>]*class="language-switch"/);

  for (const html of [zh, en]) {
    const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0] ?? "";
    assert.match(header, /standards/i);
    assert.match(html, /Draft/);
  }

  assert.match(zh, new RegExp(`href="/standards/${slug}"`));
  assert.match(en, new RegExp(`href="/en/standards/${slug}"`));
  assert.match(zhHome, /href="\/standards"[^>]*>探索 Morphz 开放规范/);
  assert.match(enHome, /href="\/en\/standards"[^>]*>Explore the Morphz open standards/);
  assert.match(zhDetail, /本规范定义 Morphz 结构化上下文的规范性数据模型/);
  assert.match(enDetail, /This specification defines the normative data model/);
  assert.match(zhDetail, new RegExp(`href="/en/standards/${slug}"[^>]*class="language-switch"`));
  assert.match(enDetail, new RegExp(`href="/standards/${slug}"[^>]*class="language-switch"`));
  assert.match(zhDetail, /github\.com\/morphz-ai\/morphz\/blob\/main\/docs\/standards\/zh-CN\/morphz_structured_context_specification_v1\.md/);
});

test("uses the Chinese charter title without changing Constitution routes or English naming", async () => {
  const slug = "structured_context_constitution_v1";
  for (const [prefix, title, sourceDirectory] of [
    ["", "结构化上下文宪章 v1", "zh-CN/"],
    ["/en", "Structured Context Constitution v1", ""],
  ]) {
    const response = await render(`${prefix}/standards/${slug}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(title));
    assert.doesNotMatch(html, /宪法/);
    assert.ok(html.includes(`github.com/morphz-ai/morphz/blob/main/docs/standards/${sourceDirectory}${slug}.md`));
    const otherPrefix = prefix ? "" : "/en";
    assert.match(html, new RegExp(`href="${otherPrefix}/standards/${slug}"[^>]*class="language-switch"`));
  }
});
