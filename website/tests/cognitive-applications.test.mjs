import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const slug = "cognitive-applications";
const figureSources = {
  zh: `/images/articles/${slug}-mechanism-zh-v3.png`,
  en: `/images/articles/${slug}-mechanism-en-v3.png`,
};

test("cognitive application articles share a downloadable package and localized reading links", async () => {
  const example = (await readFile(new URL("../public/examples/file-review.hns", import.meta.url), "utf8")).trimEnd();
  const commands = [];
  for (const locale of ["zh", "en"]) {
    const markdown = await readFile(new URL(`../content/blog/${locale}/${slug}.md`, import.meta.url), "utf8");
    assert.equal(markdown.match(/```lisp\n([\s\S]*?)\n```/)?.[1], example);
    assert.ok(markdown.includes("](/examples/file-review.hns)"));
    commands.push([...markdown.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]));
    const prefix = locale === "zh" ? "" : "/en";
    for (const related of ["/docs/cognitive-applications", "/blog/maintaining-context-without-compaction", "/blog/one-agent-multiple-threads"]) {
      assert.ok(markdown.includes(`](${prefix}${related})`));
    }
    if (locale === "zh") {
      assert.match(markdown, /GUI 是可选、按平台适配的部分/);
      assert.match(markdown, /Desktop 已实现相关界面功能，但尚未发布/);
      assert.match(markdown, /界面包引用已安装的 Harness/);
      assert.doesNotMatch(markdown, /临时|桌面端探索|桌面端的探索|UI 规范及对应支持尚未在 Morphz 底层实现/);
    } else {
      assert.match(markdown, /design calls for an optional, platform-specific GUI/);
      assert.match(markdown, /Desktop has implemented the related interface features, but they have not yet been released/);
      assert.match(markdown, /interface packages that reference installed Harnesses/);
      assert.doesNotMatch(markdown, /provisional|temporary|still being explored|an exploration in the desktop client|Morphz core has not yet implemented a UI specification/i);
    }
  }
  assert.equal(commands[0].length, 2);
  assert.deepEqual(commands[0], commands[1]);
});

test("application articles focus on usable HNS applications with a brief application-level COA note", async () => {
  for (const locale of ["zh", "en"]) {
    const markdown = await readFile(new URL(`../content/blog/${locale}/${slug}.md`, import.meta.url), "utf8");
    const prefix = locale === "zh" ? "" : "/en";
    assert.ok(markdown.includes(`](${prefix}/standards/hns_package_format_specification_v0_1)`));
    assert.equal((markdown.match(/\.coa\b/g) ?? []).length, 1, "COA gets one short application-packaging design mention");
    assert.ok(markdown.indexOf(".coa") > markdown.lastIndexOf("\n## "), "lead with working HNS capabilities, not roadmap taxonomy");
    assert.doesNotMatch(markdown, /^\|/m, "the article is not a capability status matrix");
    if (locale === "zh") {
      assert.match(markdown, /为应用级封装预留了 `\.coa`/);
      assert.match(markdown, /应用自身的身份与版本，组织执行方法、可选界面和资源/);
      assert.match(markdown, /执行部分可以包含或引用 Harness/);
      assert.match(markdown, /简单的认知应用仍可以直接以 `\.hns` 分发和运行/);
      assert.match(markdown, /同一个 `\.hns` 包也可以把重复步骤封装成函数/);
      assert.doesNotMatch(markdown, /同一个 `\.hns` 包可以组织多个工作流程/);
      assert.doesNotMatch(markdown, /多个 `\.hns` 程序可以组织成一个 `\.coa` 认知应用程序文件/);
      assert.match(markdown, /`\.hns` 是 Morphz 的最小认知应用形态/);
      assert.match(markdown, /每个 `\.hns` 包承载一个主 Harness/);
      assert.match(markdown, /每次求值绑定一个主 Harness/);
      assert.match(markdown, /完整的 `\.hns` 最小认知应用/);
      assert.match(markdown, /`\.hns` 目录包/);
      assert.doesNotMatch(markdown, /名称和后缀已预留|包格式尚未定义|加载器尚不支持|格式和加载支持尚未实现/);
      assert.doesNotMatch(markdown, /用 `\.hns` 包分发认知应用的执行部分/);
    } else {
      assert.match(markdown, /reserved `\.coa` for application-level packaging/);
      assert.match(markdown, /execution methods, optional interfaces, and resources around an application's own identity and version/);
      assert.match(markdown, /execution component can include or reference Harnesses/);
      assert.match(markdown, /Simple cognitive applications can still be distributed and run directly as `\.hns` packages/);
      assert.match(markdown, /A single `\.hns` package can also encapsulate repeated steps in functions/);
      assert.doesNotMatch(markdown, /A single `\.hns` package can organize multiple workflows/);
      assert.doesNotMatch(markdown, /multiple `\.hns` programs can be organized into a `\.coa` cognitive application program file/);
      assert.match(markdown, /`\.hns` is Morphz's minimal cognitive application form/);
      assert.match(markdown, /Each `\.hns` package carries one Primary Harness/);
      assert.match(markdown, /Each evaluation binds one Primary Harness/);
      assert.match(markdown, /complete `\.hns` minimal cognitive application/);
      assert.match(markdown, /`\.hns` directory package/);
      assert.doesNotMatch(markdown, /Name and suffix reserved|package format not yet defined|loading not supported|format and loading support have not been implemented/);
      assert.doesNotMatch(markdown, /distributes the execution component of cognitive applications as `\.hns` packages/);
    }
    for (const code of markdown.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)) {
      assert.doesNotMatch(code[1], /\.coa\b/, "examples must not imply an implemented COA format or command");
    }
  }
});

test("application articles use their selected figures with accessible localized captions", async () => {
  for (const locale of ["zh", "en"]) {
    const src = figureSources[locale];
    const png = await readFile(new URL(`../public${src}`, import.meta.url));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.toString("ascii", 12, 16), "IHDR");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(width >= 1500 && height >= 750, "full-size figures preserve detail");
    assert.ok(png.byteLength < 3_000_000, "article assets have a bounded file size");
    const markdown = await readFile(new URL(`../content/blog/${locale}/${slug}.md`, import.meta.url), "utf8");
    const figures = [...markdown.matchAll(/<figure class="article-figure">([\s\S]*?)<\/figure>/g)];
    assert.equal(figures.length, 1, "one main illustration per article");
    const figure = figures[0][1];
    assert.ok(figure.includes(`href="${src}"`));
    assert.ok(figure.includes(`src="${src}"`));
    assert.ok(figure.includes(`width="${width}" height="${height}"`), "reserve the actual image aspect ratio");
    assert.match(figure, /loading="lazy" decoding="async"/);
    assert.match(figure, /target="_blank" rel="noopener noreferrer" aria-label="[^"]+"/);
    const alt = figure.match(/\balt="([^"]+)"/)?.[1] ?? "";
    assert.ok(alt.length > 50);
    if (locale === "zh") {
      assert.match(alt, /认知应用机制图/);
      assert.match(alt, /上下文事务提交/);
      assert.match(alt, /已提交的认知/);
      assert.doesNotMatch(figure, /三格漫画|comic-v2/);
      assert.match(figure, /同一个 Agent/);
      assert.match(figure, /两种应用为机制示例/);
      assert.match(figure, /\.hns 最小认知应用/);
    } else {
      assert.doesNotMatch(alt, /[\u4e00-\u9fff]/);
      assert.match(alt, /cognitive application mechanism/);
      assert.match(alt, /committed through a context transaction/);
      assert.match(alt, /subsequent release-notes evaluation/);
      assert.doesNotMatch(figure, /Three comic panels|comic-v2/);
      assert.match(figure, /applications are illustrative examples/);
      assert.match(figure, /\.hns minimal cognitive applications/);
    }
    assert.match(figure, /<figcaption>[^<]+/);
    assert.doesNotMatch(figure, /motion-reveal|opacity|visibility|onload|onerror/);
  }
});

test("original application architecture SVGs remain available as reference assets", async () => {
  for (const locale of ["zh", "en"]) {
    const src = `/images/articles/${slug}-${locale}-v1.svg`;
    const svg = await readFile(new URL(`../public${src}`, import.meta.url), "utf8");
    assert.match(svg, /viewBox="0 0 600 470"/);
    assert.ok(svg.includes(`lang="${locale === "zh" ? "zh-CN" : "en"}"`));
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-labelledby="archify-diagram-title archify-diagram-description"/);
    assert.match(svg, /<title id="archify-diagram-title">[^<]+<\/title>/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|animate|set)\b|(?:href|src)=|@import|url\(["']?https?:/i);
    assert.ok(Buffer.byteLength(svg) < 60_000);
  }
});

test("application articles render in both languages with their actual figure and code sample", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  for (const [locale, prefix] of [["zh", ""], ["en", "/en"]]) {
    const response = await worker.fetch(
      new Request(`https://morphz.ai${prefix}/blog/${slug}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    const prose = html.match(/<div class="doc-prose blog-prose">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.ok(prose.includes(figureSources[locale]));
    assert.ok(!prose.includes(`/images/articles/${slug}-comic-v2.png`));
    assert.ok(!prose.includes(`/images/articles/${slug}-${locale}-v1.svg`));
    assert.ok(prose.includes("file-review.hns"));
    assert.doesNotMatch(prose, /<table>/);
    assert.match(prose, /<code>\.coa<\/code>/);
    assert.match(prose, /<code>\.hns<\/code>/);
    assert.match(prose, locale === "zh" ? /应用自身的身份与版本/ : /application(?:'|&#39;|&#x27;)s own identity and version/);
    assert.match(prose, /<h2 id=/);
  }
});
