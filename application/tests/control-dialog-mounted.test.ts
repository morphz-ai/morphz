import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, expect } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";
import { automaticTestBrowser } from "../scripts/test-capabilities.mjs";

function fixture(dashboard: boolean) {
  const source = resolve("../dashboard/src");
  return `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
${dashboard ? `import {AppDialog} from '/@fs/${source}/App.tsx';import '/@fs/${source}/index.css';import '/@fs/${source}/App.css';import '/@fs/${source}/i18n/index.ts';` : `import {SubjectObjectiveDialog} from '/src/SubjectObjectiveDialog.tsx';${currentAppCSSImports()}`}
const goal={id:'TEST-goal',projectId:'TEST-project',conversationId:'TEST-conversation',inputId:'TEST-input',rootId:'TEST-root',
 sessionId:'TEST-session',contextId:'TEST-context',title:'TEST 原目标全文。'.repeat(300),generation:1,revision:7,status:'active',controlAllowed:true,
 readiness:'waiting',statusReason:null,parentId:null,threadIds:[],updatedAt:'2026-11-01T00:00:00Z'};
let accept,resolveRefresh;const ack=new Promise(resolve=>accept=resolve),refresh=new Promise(resolve=>resolveRefresh=resolve);
const calls=[];let refreshes=0;
window.morphzDesktop={application:{cancel(){},async invoke(envelope){calls.push(envelope);await ack;
 return new URL(location.href).searchParams.has('fail')?{ok:false,error:{code:'conflict',message:'TEST 控制被拒绝'}}:{ok:true,value:{objectiveId:goal.id,action:'delete'}};}}};
const client={online:true,boot:{runtime:{connected:true,activity:{available:true,threads:[],objectives:[goal]}}},async refreshView(){refreshes++;await refresh;return true;}};
window.controlFixture={accept:()=>accept(),releaseRefresh:()=>resolveRefresh(),report:()=>({calls:calls.length,refreshes})};
function Frame(){const [open,setOpen]=useState(true);return <div className="${dashboard ? "page-shell" : "app"}" data-color-mode="light" data-accent="cyan" style={{display:'block',height:'100vh'}}>
<textarea aria-label="原草稿" defaultValue="TEST 必须保留的草稿"/>
${dashboard ? `{open&&<AppDialog request={{id:'TEST-delete',kind:'confirm',title:'删除这个目标？',description:goal.title,confirmLabel:'删除目标',cancelLabel:'取消',tone:'danger'}} onResolve={value=>{window.controlFixture.resolved=value;setOpen(false);}}/>}` : `{open&&<SubjectObjectiveDialog goal={goal} threads={[]} client={client} fresh onClose={()=>setOpen(false)} onSelect={()=>{}}/>}`}
<output aria-label="弹层状态">{open?'open':'closed'}</output></div>}
createRoot(document.getElementById('root')).render(<Frame/>);
`;
}

test(
  "real control dialogs keep long-goal actions reachable and do not await unrelated view refresh",
  { timeout: 120000 },
  async () => {
    const env = await automaticTestBrowser();
    const executable = env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "installed test browser required; no skip fallback",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-control-dialog-"));
    const captures = process.env.MORPHZ_CONTROL_SCREENSHOT_DIR;
    if (captures) mkdirSync(captures, { recursive: true, mode: 0o700 });
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      logLevel: "error",
      resolve: {
        dedupe: ["react", "react-dom"],
        alias: [
          {
            find: /^react$/,
            replacement: resolve("node_modules/react/index.js"),
          },
          {
            find: /^react\/jsx-runtime$/,
            replacement: resolve("node_modules/react/jsx-runtime.js"),
          },
          {
            find: /^react\/jsx-dev-runtime$/,
            replacement: resolve("node_modules/react/jsx-dev-runtime.js"),
          },
        ],
      },
      optimizeDeps: {
        include: ["react", "react-dom/client", "react/jsx-runtime"],
      },
      plugins: [
        {
          name: "control-dialog-fixture",
          resolveId(id) {
            if (id.startsWith("/__control-") && id.endsWith(".tsx"))
              return "\0" + id;
          },
          load(id) {
            if (id.startsWith("\0/__control-"))
              return transformWithOxc(
                fixture(id.includes("dashboard")),
                id.slice(1),
              );
          },
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (
                !req.url?.startsWith("/__control/") ||
                req.url.includes(".tsx")
              )
                return next();
              const lane = req.url.includes("dashboard")
                ? "dashboard"
                : "desktop";
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  '<!doctype html><html data-color-mode="light"><head><base href="/"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__control-' +
                    lane +
                    '.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
        react(),
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        fs: { allow: [resolve("..")] },
      },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({
        headless: true,
        executablePath: executable || undefined,
      });
      const page = await browser.newPage({ locale: "zh-CN" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 375, height: 600 },
        { width: 600, height: 350 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(base + "/__control/dashboard");
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.effect?.getTiming().iterations !== Infinity,
              )
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.colorMode = mode;
            document.querySelector<HTMLElement>(
              ".page-shell",
            )!.dataset.colorMode = mode;
          }, mode);
          const buttons = dialog.getByRole("button");
          await expect(
            dialog.getByRole("button", { name: "删除目标", exact: true }),
          ).toBeInViewport({ ratio: 1 });
          const description = dialog.locator("p");
          await description.focus();
          await description.press("End");
          await expect
            .poll(() => description.evaluate((el) => el.scrollTop))
            .toBeGreaterThan(0);
          await description.press("Enter");
          await expect(dialog).toBeVisible();
          const geometry = await dialog.evaluate((el) => {
            const rect = el.getBoundingClientRect(),
              body = el.querySelector("p")!,
              footer = el.querySelector("footer")!;
            const first = footer.getBoundingClientRect();
            body.scrollTop = body.scrollHeight;
            const last = footer.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              width: innerWidth,
              top: rect.top,
              bottom: rect.bottom,
              height: innerHeight,
              scrolls: body.scrollHeight > body.clientHeight,
              footerShift: Math.abs(first.top - last.top),
              buttons: [...el.querySelectorAll("footer button")].map((b) => {
                const r = b.getBoundingClientRect();
                return {
                  hit:
                    document
                      .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                      ?.closest("button") === b,
                };
              }),
            };
          });
          assert.ok(
            geometry.top >= 20 &&
              geometry.bottom <= geometry.height - 20 &&
              geometry.left >= 20 &&
              geometry.right <= geometry.width - 20,
            JSON.stringify({ viewport, mode, geometry }),
          );
          assert.equal(geometry.scrolls, true);
          assert.ok(geometry.footerShift < 0.5);
          assert.ok(geometry.buttons.every((b) => b.hit));
          assert.equal(await buttons.count(), 3);
          if (captures)
            await page.screenshot({
              path: join(
                captures,
                `dashboard-${viewport.width}x${viewport.height}-${mode}.png`,
              ),
            });
        }
        await dialog
          .getByRole("button", { name: "取消", exact: true })
          .last()
          .press("Enter");
        assert.equal(
          await page.evaluate(
            () => Reflect.get(window, "controlFixture").resolved,
          ),
          false,
        );
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      for (const failed of [false, true]) {
        await page.goto(
          base + "/__control/desktop" + (failed ? "?fail=1" : ""),
        );
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await page
          .getByRole("button", { name: "更多目标操作", exact: true })
          .click();
        await page
          .getByRole("button", { name: "删除目标", exact: true })
          .click();
        await dialog
          .getByRole("button", { name: "确认删除", exact: true })
          .click();
        await expect(
          dialog.getByRole("button", { name: "删除中…", exact: true }),
        ).toBeVisible();
        assert.equal(
          await page.evaluate(
            () => Reflect.get(window, "controlFixture").report().calls,
          ),
          1,
        );
        await page.evaluate(() =>
          Reflect.get(window, "controlFixture").accept(),
        );
        if (failed) {
          await expect(dialog.getByRole("alert")).toHaveText("TEST 控制被拒绝");
          await expect(
            page.getByRole("button", { name: "更多目标操作", exact: true }),
          ).toBeEnabled();
        } else {
          await expect(dialog).toHaveCount(0);
          await expect(page.getByLabel("弹层状态")).toHaveText("closed");
        }
        assert.equal(
          await page.evaluate(
            () => Reflect.get(window, "controlFixture").report().refreshes,
          ),
          1,
          "view refresh is held, but the receipt/error already completed the interaction",
        );
        await expect(page.getByRole("textbox", { name: "原草稿" })).toHaveValue(
          "TEST 必须保留的草稿",
        );
        await page.evaluate(() =>
          Reflect.get(window, "controlFixture").releaseRefresh(),
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
