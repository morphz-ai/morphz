import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

test("actual SafeMarkdown wraps literal blocks and copies only their text with stable in-place feedback", async (context) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "morphz-markdown-block-"));
  context.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const original =
    "请为中文长篇小说设计封面。".repeat(80) +
    "\n\n    保留缩进与空行。\n<script>window.untrustedRan=true</script>";
  const source = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {SafeMarkdown} from '/src/SafeMarkdown.tsx';import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
${currentAppCSSImports()}
const original=${JSON.stringify(original)},workspace=initialWorkspace(),copied=[];let mode='ok',setText,resolveCopy;
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied.push(['async',text]);if(mode==='failure'||mode==='fallback')throw Error('fixture denied');if(mode==='pending')await new Promise(resolve=>resolveCopy=resolve);}}});
document.execCommand=()=>{copied.push(['fallback',document.activeElement?.value]);return mode!=='failure';};
function App(){const[text,update]=useState(original);setText=update;const markdown=${JSON.stringify("正文\n\n~~~text\n")}+text+${JSON.stringify("\n~~~\n\n普通 `inline` 文本")};return <main className="app" data-appearance="light" style={{display:'block',padding:12}}><textarea id="origin" defaultValue="original draft"/><section className="reply-content" aria-label="可复制正文"><SafeMarkdown state={workspace} onOpen={()=>{}}>{markdown}</SafeMarkdown></section><section className="message-share-sheet" aria-label="分享图片内容"><SafeMarkdown copyable={false} state={workspace} onOpen={()=>{}}>{markdown}</SafeMarkdown></section></main>;}
createRoot(document.getElementById('root')).render(<App/>);Reflect.set(window,'blockFixture',{copied,setMode:value=>mode=value,setText:text=>setText(text),resolve:()=>resolveCopy?.()});
`;
  const server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    cacheDir,
    plugins: [
      react(),
      {
        name: "markdown-block-fixture",
        resolveId(id) {
          if (id === "/__block.tsx") return "\0" + id;
        },
        async load(id) {
          if (id === "\0/__block.tsx")
            return transformWithOxc(source, "block.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__block") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__block.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  });
  context.after(() => server.close());
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || undefined,
  });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__block`);
  const body = page.getByRole("region", { name: "可复制正文" });
  const block = body.locator(".markdown-code-block");
  await block.waitFor();
  for (const appearance of ["light", "dark"]) {
    await page
      .locator(".app")
      .evaluate(
        (node, appearance) => node.setAttribute("data-appearance", appearance),
        appearance,
      );
    const geometry = await block.locator("pre").evaluate((node) => ({
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      whiteSpace: getComputedStyle(node).whiteSpace,
      height: node.getBoundingClientRect().height,
      top: getComputedStyle(node).paddingTop,
      bottom: getComputedStyle(node).paddingBottom,
    }));
    assert.ok(
      geometry.scrollWidth <= geometry.width + 1,
      JSON.stringify(geometry),
    );
    assert.equal(geometry.whiteSpace, "pre-wrap");
    assert.equal(
      geometry.top,
      geometry.bottom,
      "copy button adds no extra header whitespace",
    );
    assert.equal(await block.locator("pre").textContent(), original + "\n");
  }
  assert.equal(
    await page
      .getByRole("region", { name: "分享图片内容" })
      .locator("button")
      .count(),
    0,
  );
  assert.equal(
    await body.locator(".markdown-code-copy").count(),
    1,
    "inline code is not a block",
  );
  const before = await block.boundingBox();
  await block.getByRole("button", { name: "复制文本" }).click();
  await block.getByRole("button", { name: "已复制" }).waitFor();
  assert.deepEqual(
    await block.boundingBox(),
    before,
    "copy feedback never adds a row or shifts the block",
  );
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "blockFixture").copied[0][1]),
    original + "\n",
  );
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "untrustedRan")),
    undefined,
  );
  await page.evaluate(() => {
    Reflect.get(window, "blockFixture").setMode("fallback");
    Reflect.get(window, "blockFixture").setText(
      "第二块\n    literal <b>text</b>",
    );
  });
  await block.getByRole("button", { name: "复制文本" }).waitFor();
  await block.getByRole("button", { name: "复制文本" }).click();
  await block.getByRole("button", { name: "已复制" }).waitFor();
  assert.deepEqual(
    await page.evaluate(() =>
      Reflect.get(window, "blockFixture").copied.at(-1),
    ),
    ["fallback", "第二块\n    literal <b>text</b>\n"],
  );
  assert.equal(
    await page.locator("textarea").count(),
    1,
    "temporary copy textarea is removed",
  );
  await page.evaluate(() => {
    Reflect.get(window, "blockFixture").setMode("failure");
    Reflect.get(window, "blockFixture").setText("失败后可重试");
  });
  await block.getByRole("button", { name: "复制文本" }).click();
  await block.getByRole("button", { name: "复制失败，点击重试" }).waitFor();
  await page.evaluate(() => Reflect.get(window, "blockFixture").setMode("ok"));
  await block.getByRole("button", { name: "复制失败，点击重试" }).click();
  await block.getByRole("button", { name: "已复制" }).waitFor();
  await page.evaluate(() => {
    Reflect.get(window, "blockFixture").setMode("pending");
    Reflect.get(window, "blockFixture").setText("旧内容的延迟复制");
  });
  await block.getByRole("button", { name: "复制文本" }).click();
  await page.evaluate(() =>
    Reflect.get(window, "blockFixture").setText("更新后的正文"),
  );
  await block.getByRole("button", { name: "复制文本" }).waitFor();
  await page.evaluate(() => Reflect.get(window, "blockFixture").resolve());
  assert.equal(
    await block.getByRole("button", { name: "已复制" }).count(),
    0,
    "late copy completion does not mark replaced text as copied",
  );
  assert.deepEqual(errors, []);
});
