import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { chromium, expect, type Browser } from "@playwright/test";
import { createServer, transformWithOxc, type ViteDevServer } from "vite";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

test(
  "connection details keep the exact redacted failed read visible after a healthy recheck",
  { timeout: 60000 },
  async () => {
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "npm test must prepare a real browser; no skip fallback",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-connection-details-"));
    let server: ViteDevServer | undefined, browser: Browser | undefined;
    const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ConnectionDetails} from '/src/ConnectionDetails.tsx';
${currentAppCSSImports()}
const failure={operation:'activity-history',code:'TimeoutError',at:'2026-10-25T03:25:33.699Z',timeoutMs:8000,recoveredAt:'2026-10-25T03:26:00.000Z'};
const client={online:true,boot:{runtime:{configured:true,connected:true,error:'',deliveries:[],messages:[]}},
 async refresh(){},async checkConnection(){return {state:'connected',modelState:'configured',model:'TEST-model',message:'',checkedAt:new Date().toISOString(),configurable:false,lastReadFailure:failure};}};
createRoot(document.getElementById('root')).render(<div className="app" data-color-mode="light" data-accent="cyan" style={{display:'block',width:'100vw',height:'100vh'}}><div className="workspace" style={{display:'block',height:'100%'}}><main className="primary-panel" style={{height:'100%'}}><h1>TEST 连接诊断</h1><ConnectionDetails client={client} onClose={()=>{}}/></main></div></div>);
`;
    try {
      server = await createServer({
        configFile: false,
        root: resolve("apps/web"),
        cacheDir: cache,
        logLevel: "error",
        plugins: [
          {
            name: "connection-diagnostic-fixture",
            resolveId(id) {
              if (id === "/__diagnostic.tsx") return "\0" + id;
            },
            load(id) {
              if (id === "\0/__diagnostic.tsx")
                return transformWithOxc(fixture, id.slice(1));
            },
            configureServer(vite) {
              vite.middlewares.use(async (request, response, next) => {
                if (request.url !== "/__diagnostic") return next();
                response.setHeader("Content-Type", "text/html");
                response.end(
                  await vite.transformIndexHtml(
                    request.url,
                    '<!doctype html><html><head><base href="/"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__diagnostic.tsx"></script></body></html>',
                  ),
                );
              });
            },
          },
          react(),
        ],
        server: { host: "127.0.0.1", port: 0, hmr: false },
      });
      await server.listen();
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({
        headless: true,
        executablePath: executable,
      });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/__diagnostic`);
      const dialog = page.getByRole("dialog", {
        name: "连接详情",
        exact: true,
      });
      await expect(
        dialog.getByText("活动历史读取超时 · 已恢复", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("TimeoutError", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText("8 秒", { exact: true })).toBeVisible();
      await expect(dialog.getByText("已连接", { exact: true })).toBeVisible();
      await dialog
        .getByRole("button", { name: "检查连接", exact: true })
        .click();
      await expect(
        dialog.getByText("活动历史读取超时 · 已恢复", { exact: true }),
      ).toBeVisible();
      assert.match(await dialog.innerText(), /2026.*10.*25.*11:25:33/);
      await page.setViewportSize({ width: 390, height: 844 });
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server?.close();
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
