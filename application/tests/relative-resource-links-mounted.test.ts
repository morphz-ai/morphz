import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, transformWithOxc } from "vite";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

test(
  "relative file labels stay clickable; click resolves the original authorized Session workspace without navigation, replay or remote-path confusion",
  { timeout: 60_000 },
  async (context) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "morphz-relative-links-"));
    const markdown =
      "[打开修复版预览二维码](artifacts/24frames-wechat-header-fix-20261025.jpg)\n\n[越界](../secret.jpg) [协议](javascript:alert%281%29)";
    const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {SafeMarkdown} from '/src/SafeMarkdown.tsx';import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
${currentAppCSSImports()}
const opened=[],reads=[];let mode='local';const scope={projectId:'TEST-original-project',conversationId:'TEST-original-conversation'};
window.morphzDesktop={application:{cancel(){},async invoke(envelope){
 if(envelope.method!=='session-permissions.read')throw Error('Unexpected write or read '+envelope.method);
 reads.push(structuredClone(envelope.params));
 if(mode==='forbidden')return {ok:false,error:{status:403,code:'forbidden',message:'TEST 无权读取原会话'}};
 return {ok:true,value:{scope:{...scope,kind:'conversation',...(mode==='wrong-scope'?{conversationId:'TEST-other'}:{})},runtimeSessionId:'TEST-session',permissionMode:'request_approval',sandboxMode:'workspace-write',reviewer:'user',source:'runtime',canUpdate:false,readOnlyReason:null,fingerprint:'a'.repeat(64),workspace:{targetId:mode==='remote'?'target-ssh':'target-default',targetName:'TEST node',workspaceRoot:'/tmp/TEST execution workspace',ready:true,reason:null}}};
}},async openLocalFile(path){opened.push(path);return {action:'opened'};}};
window.linkFixture={opened,reads,mode:value=>mode=value};
createRoot(document.getElementById('root')).render(<main className="app" style={{display:'block',padding:24}}><textarea aria-label="普通草稿" defaultValue="TEST 普通草稿不应改变"/><section className="reply-content" aria-label="原消息"><SafeMarkdown state={initialWorkspace()} onOpen={()=>{throw Error('not a content link')}} resourceScope={scope}>{${JSON.stringify(markdown)}}</SafeMarkdown></section><section aria-label="无执行来源"><SafeMarkdown state={initialWorkspace()} onOpen={()=>{}}>{'[未绑定文件](artifacts/test.jpg)'}</SafeMarkdown></section></main>);
`;
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      optimizeDeps: {
        entries: [resolve("apps/web/src/SafeMarkdown.tsx")],
        include: ["react", "react-dom/client", "react/jsx-runtime"],
      },
      plugins: [
        react(),
        {
          name: "relative-resource-fixture",
          resolveId(id) {
            if (id === "/__relative.tsx") return "\0" + id;
          },
          load(id) {
            if (id === "\0/__relative.tsx")
              return transformWithOxc(source, "relative.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url !== "/__relative") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__relative.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    context.after(async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || undefined,
    });
    context.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1000, height: 700 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/__relative`);
    const body = page.getByRole("region", { name: "原消息" });
    const link = body.getByRole("button", {
      name: "打开修复版预览二维码",
      exact: true,
    });
    await expect(link).toBeVisible();
    assert.equal(
      await link.evaluate((el) => getComputedStyle(el).textDecorationLine),
      "underline",
    );
    assert.deepEqual(
      await page.evaluate(() => Reflect.get(window, "linkFixture").reads),
      [],
    );
    assert.deepEqual(
      await page.evaluate(() => Reflect.get(window, "linkFixture").opened),
      [],
    );
    const originalURL = page.url();
    await link.click();
    await expect(link).toBeEnabled();
    assert.deepEqual(
      await page.evaluate(() => Reflect.get(window, "linkFixture").opened),
      [
        "/tmp/TEST execution workspace/artifacts/24frames-wechat-header-fix-20261025.jpg",
      ],
    );
    assert.deepEqual(
      await page.evaluate(() => Reflect.get(window, "linkFixture").reads),
      [
        {
          projectId: "TEST-original-project",
          conversationId: "TEST-original-conversation",
        },
      ],
    );
    for (const mode of ["remote", "wrong-scope", "forbidden"]) {
      await page.evaluate(
        (value) => Reflect.get(window, "linkFixture").mode(value),
        mode,
      );
      await link.click();
      await expect(body.getByRole("alert")).toBeVisible();
      assert.equal(
        (await page.evaluate(() => Reflect.get(window, "linkFixture").opened))
          .length,
        1,
      );
    }
    await page.getByRole("button", { name: "未绑定文件", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "无执行来源" }).getByRole("alert"),
    ).toContainText("缺少原会话");
    assert.equal(
      await body.getByRole("button", { name: "越界", exact: true }).count(),
      0,
    );
    assert.equal(
      await body.getByRole("link", { name: "协议", exact: true }).count(),
      0,
    );
    assert.equal(page.url(), originalURL);
    assert.equal(
      await page.getByLabel("普通草稿").inputValue(),
      "TEST 普通草稿不应改变",
    );
    assert.deepEqual(errors, []);
  },
);
