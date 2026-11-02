import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";
import { automaticTestBrowser } from "../scripts/test-capabilities.mjs";

function fixture(dashboard: boolean) {
  const source = resolve("../dashboard/src");
  return `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
${dashboard ? `import {AppDialog} from '/@fs/${source}/App.tsx';import '/@fs/${source}/index.css';import '/@fs/${source}/App.css';import '/@fs/${source}/i18n/index.ts';` : `import {SubjectObjectiveDialog} from '/src/SubjectObjectiveDialog.tsx';import {SubjectObjectives} from '/src/SubjectObjectives.tsx';import {ExecutionSidebar} from '/src/ExecutionSidebar.tsx';${currentAppCSSImports()}`}
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
const lane=new URL(location.href).searchParams.get('lane');
const goal={id:'TEST-goal',projectId:'TEST-project',conversationId:'TEST-conversation',inputId:'TEST-input',rootId:'TEST-root',
 sessionId:'TEST-session',contextId:'TEST-context',title:'TEST 原目标全文。'.repeat(300),generation:1,revision:7,status:'active',controlAllowed:true,
 readiness:'waiting',statusReason:null,parentId:null,threadIds:[],updatedAt:'2026-11-01T00:00:00Z'};
let accept,resolveRefresh;const ack=new Promise(resolve=>accept=resolve),refresh=new Promise(resolve=>resolveRefresh=resolve);
const calls=[];let refreshes=0;
const thread={id:'TEST-thread',kind:'execution',projectId:goal.projectId,conversationId:goal.conversationId,inputId:goal.inputId,rootId:goal.rootId,sessionId:goal.sessionId,contextId:goal.contextId,title:'TEST 原执行标题',phase:'waiting',lifecycle:'open',controlState:'active',revision:7,generation:1,updatedAt:goal.updatedAt};
window.morphzDesktop={application:{cancel(){},onStream:()=>()=>{},subscribe:async()=>{},unsubscribe:()=>{},async invoke(envelope){calls.push(envelope);await ack;
 return new URL(location.href).searchParams.has('fail')?{ok:false,error:{code:'conflict',message:'TEST 控制被拒绝'}}:{ok:true,value:{objectiveId:goal.id,action:lane==='goal'?'pause':'delete'}};}}};
const client={online:true,workspaceChangeRevision:0,boot:{csrfToken:'TEST-generation',centerId:'TEST-center',principalId:'TEST-owner',workspace:initialWorkspace(goal.updatedAt),capabilities:{teamAuthentication:true},runtime:{configured:true,connected:true,deliveries:[],messages:[],attention:{available:true,approvals:[]},activity:{available:true,openWorkComplete:true,threads:[thread],objectives:[goal]}}},executionSnapshot:async()=>({jobs:[],approvals:[],limit:100}),executionResult:async()=>null,contentCatalog:[],controlExecution:async operation=>{calls.push(operation);await ack;if(new URL(location.href).searchParams.has('fail'))throw Error('TEST 控制被拒绝');return{accepted:true,status:'paused'};},async refreshView(){refreshes++;await refresh;return true;}};
window.controlFixture={accept:()=>accept(),releaseRefresh:()=>resolveRefresh(),report:()=>({calls:calls.length,refreshes})};
function Frame(){const [open,setOpen]=useState(true);return <div className="${dashboard ? "page-shell" : "app"}" data-color-mode="light" data-accent="cyan" style={{display:'block',height:'100vh'}}>
<textarea aria-label="原草稿" defaultValue="TEST 必须保留的草稿"/>
${dashboard ? `{open&&<AppDialog request={{id:'TEST-delete',kind:'confirm',title:'删除这个目标？',description:goal.title,confirmLabel:'删除目标',cancelLabel:'取消',tone:'danger'}} onResolve={value=>{window.controlFixture.resolved=value;setOpen(false);}}/>}` : `{lane==='goal'?<SubjectObjectives client={client} onSelect={()=>{}}/>:lane==='thread'?<ExecutionSidebar client={client} scope={{projectId:goal.projectId,conversationId:goal.conversationId,inputId:goal.inputId,threadId:thread.id,artifactId:null}} layout={{mode:'docked',width:340,maxWidth:520}} onResize={()=>{}} onClose={()=>{}} onSelect={()=>{}} onOpen={()=>{}}/>:open&&<SubjectObjectiveDialog goal={goal} threads={[]} client={client} fresh onClose={()=>setOpen(false)} onSelect={()=>{}}/>}`}
<output aria-label="弹层状态">{open?'open':'closed'}</output></div>}
createRoot(document.getElementById('root')).render(<Frame/>);
`;
}

test(
  "real control dialogs keep long-goal actions reachable and do not await unrelated view refresh",
  { timeout: 120000 },
  async (t) => {
    const env = await automaticTestBrowser();
    const executable = env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "installed test browser required; no skip fallback",
    );
    const captures = process.env.MORPHZ_CONTROL_SCREENSHOT_DIR;
    if (captures) mkdirSync(captures, { recursive: true, mode: 0o700 });
    const assets = new Map<string, Uint8Array>();
    // Prepare both real component graphs without running their effects. The
    // timed browser cases retain all existing 5s assertions and real CSS.
    for (const lane of ["dashboard", "desktop"] as const) {
      const started = performance.now();
      const bundle = await build({
        stdin: {
          contents: fixture(lane === "dashboard"),
          sourcefile: `control-${lane}.tsx`,
          loader: "tsx",
          resolveDir: resolve("."),
        },
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2023",
        jsx: "automatic",
        alias: {
          react: resolve("node_modules/react"),
          "react-dom": resolve("node_modules/react-dom"),
        },
        define: {
          "process.env.NODE_ENV": JSON.stringify("development"),
          "import.meta.env": JSON.stringify({
            BASE_URL: "/",
            DEV: true,
            MODE: "development",
            PROD: false,
            SSR: false,
          }),
        },
        write: false,
        outfile: resolve(`tests/.control-fixture/control-${lane}.js`),
        metafile: true,
        plugins: [
          {
            name: "actual-control-component-imports",
            setup(builder) {
              builder.onResolve({ filter: /\?url$/ }, async (args) => {
                const result = await builder.resolve(args.path.slice(0, -4), {
                  resolveDir: args.resolveDir,
                  kind: args.kind,
                });
                if (result.errors.length) return { errors: result.errors };
                return { path: result.path, namespace: "control-asset" };
              });
              builder.onLoad(
                { filter: /.*/, namespace: "control-asset" },
                async (args) => ({
                  contents: await readFile(args.path),
                  loader: "file",
                }),
              );
              builder.onResolve({ filter: /^\/(?:src|@fs)\// }, ({ path }) => ({
                path: path.startsWith("/src/")
                  ? resolve("apps/web", path.slice(1))
                  : path.slice("/@fs/".length),
              }));
            },
          },
        ],
      });
      const compiled = new Set(
        Object.keys(bundle.metafile.inputs).map((path) => resolve(path)),
      );
      for (const path of lane === "dashboard"
        ? [
            "../dashboard/src/App.tsx",
            "../dashboard/src/index.css",
            "../dashboard/src/App.css",
          ]
        : [
            "apps/web/src/SubjectObjectiveDialog.tsx",
            "apps/web/src/SubjectObjectives.tsx",
            "apps/web/src/ExecutionSidebar.tsx",
          ])
        assert.ok(
          compiled.has(resolve(path)),
          `Actual control source is required: ${path}`,
        );
      assert.ok(
        bundle.outputFiles.some((file) => file.path.endsWith(".js")) &&
          bundle.outputFiles.some((file) => file.path.endsWith(".css")),
      );
      for (const file of bundle.outputFiles)
        assets.set("/" + basename(file.path), file.contents);
      t.diagnostic(
        JSON.stringify({
          controlFixturePreparation: {
            lane,
            coldCache: true,
            compileMs: Math.round(performance.now() - started),
            bundleInputCount: compiled.size,
          },
        }),
      );
    }
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      const path = request.url?.split("?")[0] ?? "";
      if (path.startsWith("/__control/")) {
        const lane = path.includes("dashboard") ? "dashboard" : "desktop";
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(
          `<!doctype html><html data-color-mode="light"><head><base href="/"><link rel="icon" href="data:,"><link rel="stylesheet" href="/control-${lane}.css"></head><body><div id="root"></div><script type="module" src="/control-${lane}.js"></script></body></html>`,
        );
      } else if (assets.has(path)) {
        response.setHeader(
          "Content-Type",
          path.endsWith(".css")
            ? "text/css; charset=utf-8"
            : /\.(?:js|mjs)$/.test(path)
              ? "text/javascript; charset=utf-8"
              : "application/octet-stream",
        );
        response.end(assets.get(path));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let diagnose: (() => Promise<void>) | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({
        headless: true,
        executablePath: executable || undefined,
      });
      const page = await browser.newPage({ locale: "zh-CN" });
      const errors: string[] = [];
      const consoleErrors: string[] = [],
        failedRequests: string[] = [],
        scripts: string[] = [],
        styles: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (message) => {
        if (message.type() === "error")
          consoleErrors.push(message.text().slice(0, 500));
      });
      page.on("requestfailed", (request) =>
        failedRequests.push(new URL(request.url()).pathname),
      );
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== base) return;
        if (request.resourceType() === "script") scripts.push(url.pathname);
        if (url.pathname.endsWith(".css")) styles.push(url.pathname);
      });
      diagnose = async () => {
        t.diagnostic(
          JSON.stringify({
            controlFixtureFailure: {
              errors,
              consoleErrors: consoleErrors.slice(-10),
              failedRequests: failedRequests.slice(-20),
              page: await page
                .evaluate(() => ({
                  path: location.pathname,
                  readyState: document.readyState,
                  fixturePresent: !!Reflect.get(window, "controlFixture"),
                  dialogs: document.querySelectorAll('[role="dialog"]').length,
                  body: document.body.textContent?.slice(0, 500),
                  resources: performance
                    .getEntriesByType("resource")
                    .slice(-20)
                    .map((entry) => ({
                      path: new URL(entry.name).pathname,
                      duration: entry.duration,
                    })),
                }))
                .catch((error) => ({ unavailable: String(error) })),
            },
          }),
        );
      };
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
      for (const lane of ["goal", "thread"]) {
        for (const failed of [false, true]) {
          await page.goto(
            base +
              "/__control/desktop?lane=" +
              lane +
              (failed ? "&fail=1" : ""),
          );
          const control = page.getByRole("button", {
            name: lane === "goal" ? "暂停目标" : "暂停此执行",
            exact: true,
          });
          await expect(control).toBeEnabled();
          await control.click();
          await expect(control).toBeDisabled();
          assert.equal(
            await page.evaluate(
              () => Reflect.get(window, "controlFixture").report().calls,
            ),
            1,
          );
          await page.evaluate(() =>
            Reflect.get(window, "controlFixture").accept(),
          );
          await expect(control).toBeEnabled();
          assert.equal(
            await page.evaluate(
              () => Reflect.get(window, "controlFixture").report().refreshes,
            ),
            1,
            "the real row control must settle while its refresh is still held",
          );
          if (failed)
            await expect(
              page.getByText("TEST 控制被拒绝", { exact: true }).first(),
            ).toBeVisible();
          await expect(
            page.getByRole("textbox", { name: "原草稿" }),
          ).toHaveValue("TEST 必须保留的草稿");
          await page.evaluate(() =>
            Reflect.get(window, "controlFixture").releaseRefresh(),
          );
        }
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(
        scripts.filter(
          (path) =>
            path !== "/control-dashboard.js" && path !== "/control-desktop.js",
        ),
        [],
      );
      assert.equal(
        scripts.filter((path) => path === "/control-dashboard.js").length,
        3,
      );
      assert.equal(
        scripts.filter((path) => path === "/control-desktop.js").length,
        6,
      );
      assert.equal(
        styles.filter((path) => path === "/control-dashboard.css").length,
        3,
      );
      assert.equal(
        styles.filter((path) => path === "/control-desktop.css").length,
        6,
      );
    } catch (error) {
      await diagnose?.();
      throw error;
    } finally {
      try {
        await browser?.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);
