import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialWorkspace } from "../packages/core/src/model.js";
import {
  contentLink,
  localFileLink,
  literalResourceLink,
  resourceLinkError,
  relativeFileLink,
  resolveWorkspaceFileLink,
} from "../apps/web/src/resource-links.js";

const styles = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const { SafeMarkdown } = await import("../apps/web/src/SafeMarkdown.js");
styles.deregister();

const id = "content_5eefb5c3701eb07613d4a81c0cd3f903fa3a1bb6";
function render(children: string) {
  return renderToStaticMarkup(
    createElement(SafeMarkdown, {
      children,
      state: initialWorkspace(),
      onOpen: () => {},
    }),
  );
}

test("relative Markdown files retain link semantics and resolve only beneath an explicit execution workspace", () => {
  const source = "artifacts/24frames-wechat-header-fix-20261025.jpg";
  const html = render(`[打开修复版预览二维码](${source})`);
  assert.match(html, /markdown-file-link/);
  assert.match(html, /<button[^>]*>打开修复版预览二维码<\/button>/);
  assert.equal(relativeFileLink(source), source);
  assert.equal(
    resolveWorkspaceFileLink(source, "/tmp/TEST workspace"),
    "/tmp/TEST workspace/" + source,
  );
  assert.equal(
    resolveWorkspaceFileLink(
      "./artifacts/中文%20预览%2520.jpg",
      "/tmp/TEST workspace",
    ),
    "/tmp/TEST workspace/artifacts/中文 预览%20.jpg",
  );
  for (const value of [
    "../secret.jpg",
    "artifacts/../../secret.jpg",
    "artifacts/%2e%2e/secret.jpg",
    "//remote/a.jpg",
    "javascript:alert.jpg",
    "data:image/test.jpg",
    "artifacts/a.jpg?token=secret",
    "artifacts/a.jpg#x",
    "artifacts/%2fsecret.jpg",
    "artifacts/a\\b.jpg",
    "a\0.jpg",
    "artifacts/%00a.jpg",
    "artifacts/no-extension",
  ])
    assert.equal(relativeFileLink(value), null, value);
  assert.equal(resolveWorkspaceFileLink(source, "relative-root"), null);
});

test("native link errors retain the actionable cause without IPC implementation details", () => {
  assert.equal(
    resourceLinkError(
      new Error(
        "Error invoking remote method 'open-local-file': Error: 文件不存在或已移动，请核对路径后重试。",
      ),
    ),
    "文件不存在或已移动，请核对路径后重试。",
  );
  assert.equal(resourceLinkError(new Error("没有权限。")), "没有权限。");
  assert.equal(resourceLinkError(null), "链接未打开，请重试。");
});

test("old message content IDs become navigable without changing visible or stored words", () => {
  const source = `旧消息：${id}，以及 \`${id}\`。`;
  const html = render(source);
  assert.equal((html.match(/class="inline-object-link/g) ?? []).length, 2);
  assert.equal((html.match(new RegExp(id, "g")) ?? []).length, 2);
  assert.match(html, /<code>/);
  assert.equal(source, `旧消息：${id}，以及 \`${id}\`。`);
});

test("explicit content revisions and local file paths survive the Markdown URL policy", () => {
  const html = render(
    `[第二版](morphz://content/${id}?revision=2) [本机文件](</tmp/TEST 中文 文件.md>) [文件 URI](file:///tmp/TEST%20document.pdf)`,
  );
  assert.match(html, /inline-object-link[^>]*>第二版/);
  assert.equal((html.match(/markdown-file-link/g) ?? []).length, 2);
  assert.doesNotMatch(html, /href="file:/);
});

test("code blocks, URLs, longer identifiers and image destinations are not inferred as content navigation", () => {
  const html = render(
    `\`key=${id}\`\n\n~~~txt\n${id}\n~~~\n\nhttps://example.org/${id}\n\nx${id} ${id}abc\n\n![not local](file:///tmp/private.png)`,
  );
  assert.doesNotMatch(html, /inline-object-link|markdown-file-link|<img/);
  assert.match(html, /href="https:\/\/example.org\//);
});

test("inline resource code uses the parsed AST and never creates nested links", () => {
  const html = render(
    `[\`${id}\`](https://example.org) 和 \`/tmp/TEST 100% #1?.md\`。`,
  );
  assert.equal((html.match(/inline-object-link/g) ?? []).length, 1);
  assert.match(html, /<a[^>]+><code>content_/);
  assert.match(html, /markdown-file-link/);
  assert.doesNotMatch(render(`~~~\n${id}\n~~~`), /inline-object-link/);
});

test("resource URL validation rejects ambiguous protocols, shares, credentials and invalid versions", () => {
  assert.deepEqual(contentLink(`morphz://content/${id}?revision=2`), {
    id,
    revision: 2,
  });
  assert.deepEqual(contentLink(`artifact:${id}`), { id });
  for (const value of [
    `morphz://content/${id}?revision=0`,
    `morphz://content/${id}?revision=2&revision=3`,
    `morphz://content/${id}?revision=9007199254740992`,
    `morphz://content/${id}?other=2`,
    `morphz://x@content/${id}`,
    `morphz://content/${id}#other`,
    `morphz://content/${id}/extra`,
  ])
    assert.equal(contentLink(value), null, value);
  for (const value of [
    "//server/share",
    "file://server/share",
    "file:///tmp/a?query",
    "file:///tmp/a#fragment",
    "file:///tmp/a%00b",
    "file:///tmp/%2froot",
    "file:///tmp/%5cserver",
    "file:///tmp/%zz",
    "javascript:alert(1)",
    "data:text/html,test",
    "../relative.md",
    "/api/assets/a",
    "/artifacts/a",
  ])
    assert.equal(localFileLink(value), null, value);
  assert.equal(localFileLink("/tmp/TEST%20中文.md"), "/tmp/TEST 中文.md");
  assert.equal(localFileLink("file:///C:/TEST%20file.txt"), "C:/TEST file.txt");
  assert.equal(
    localFileLink(literalResourceLink("/tmp/100% #1?.md")!),
    "/tmp/100% #1?.md",
  );
  assert.equal(literalResourceLink(`key=${id}`), null);
});
