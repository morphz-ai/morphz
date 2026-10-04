import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { StudioDialog } from "../apps/web/src/features/script/StudioDialog.js";
import { scriptStatusLabels } from "../packages/core/src/script-studio-presentation.js";

test("shared Script status meanings and exact native dialog SSR preserve original props and children", () => {
  assert.deepEqual(scriptStatusLabels, {
    draft: "草稿",
    "in-review": "待审",
    approved: "已批准",
    locked: "已锁稿",
  });
  for (const compact of [false, true]) {
    const markup = renderToStaticMarkup(
      React.createElement(StudioDialog, {
        title: "原剧本标题",
        compact,
        onClose() {},
        children: React.createElement(
          "form",
          { "data-original": "child" },
          React.createElement("textarea", { defaultValue: "原草稿" }),
        ),
      }),
    );
    assert.match(
      markup,
      /<dialog class="create-dialog script-dialog(?: script-dialog-compact)?" aria-label="原剧本标题">/,
    );
    assert.equal(markup.includes("script-dialog-compact"), compact);
    assert.match(
      markup,
      /<header><h2>原剧本标题<\/h2><button type="button" class="icon-button" aria-label="关闭">/,
    );
    assert.match(
      markup,
      /<\/header><form data-original="child"><textarea>原草稿<\/textarea><\/form><\/dialog>$/,
    );
  }
});

// Complete actual primitive + actual useModal and original CSS/motion. All seven
// original form bindings have finite source contracts; existing full Studio
// mounted coverage is retained, not replaced by these controlled children.
// This test does not claim all seven forms or OS/native-app execution.
test(
  "actual shared and compatibility bindings retain native cancel, children, focus, scroll and cleanup",
  { timeout: 30000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "npm test prepares an installed browser",
    );
    const cache = await mkdtemp(
      resolve(tmpdir(), "morphz-script-shared-vite-"),
    );
    context.after(() => rm(cache, { recursive: true, force: true }));
    const css = [
      ...readFileSync("apps/web/src/main.tsx", "utf8").matchAll(
        /import\s+["'](\.\/[^"']+\.css)["'];/g,
      ),
    ]
      .map((match) => `import ${JSON.stringify("/src/" + match[1]!.slice(2))};`)
      .join("\n");
    const entry = `${css}
import{initialWorkspace}from${JSON.stringify("/@fs" + resolve("packages/core/src/model.ts"))};
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{StudioDialog}from'/src/features/script/StudioDialog.tsx';
import{scriptStatusLabels}from${JSON.stringify("/@fs" + resolve("packages/core/src/script-studio-presentation.ts"))};
// Initialize the actual domain schema in the same order as the full Studio fixture.
void initialWorkspace;
const{StudioDialog:CompatibilityDialog,scriptStatusLabels:compatibilityLabels}=await import('/src/ScriptStudio.tsx');
const h=React.createElement,events=[],identities=new WeakMap();let count=0,change;
// Capture observes before React's target handler; record after native dispatch.
document.addEventListener('cancel',event=>setTimeout(()=>events.push(['cancel',event.defaultPrevented]),0),true);
function Frame(){const[facts,setFacts]=useState({open:false,compact:false,title:'原剧本标题',error:''});change=setFacts;
 const close=()=>{events.push(['close']);setFacts(old=>({...old,open:false}));};
 const open=()=>setFacts(old=>({...old,open:true}));
 return h('div',{className:'app'},h('input',{id:'origin','aria-label':'原输入',defaultValue:'保留原选择和草稿',onKeyDown:event=>{if(event.key==='Enter'){event.preventDefault();open();}}}),
 h('button',{id:'trigger',onClick:open},'打开原对话框'),h('main',{className:'workspace'},facts.open&&h(StudioDialog,{title:facts.title,compact:facts.compact,onClose:close},
 h('form',{onSubmit:event=>{event.preventDefault();events.push(['submit']);setFacts(old=>({...old,error:'受控错误保留原草稿。'.repeat(80)}));}},
 h('label',null,'原名称',h('input',{'aria-label':'原名称',defaultValue:'原剧本'})),
 h('label',null,'原正文',h('textarea',{'aria-label':'原正文',rows:20,defaultValue:'原正文。\\n'.repeat(40)})),
 h('p',{role:'alert'},facts.error),h('footer',null,h('button',{type:'button',onClick:close},'取消'),h('button',{type:'submit'},'确认'))))));}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(h(React.StrictMode,null,h(Frame))));
function inspect(){const dialog=document.querySelector('dialog'),form=dialog?.querySelector('form');if(dialog&&!identities.has(dialog))identities.set(dialog,++count);
 const r=dialog?.getBoundingClientRect();return{sameDialog:StudioDialog===CompatibilityDialog,sameLabels:scriptStatusLabels===compatibilityLabels,id:dialog?identities.get(dialog):null,
 events:[...events],active:document.activeElement?.id||document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent,
 observers:window.sharedObservers,rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height},
 form:form&&{scrollHeight:form.scrollHeight,clientHeight:form.clientHeight,scrollTop:form.scrollTop},modal:!!dialog?.matches(':modal')};}
window.scriptSharedFixture={inspect,update:value=>flushSync(()=>change(old=>({...old,...value}))),cleanup:()=>{flushSync(()=>root.unmount());return inspect();}};`;
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "script-shared-native-contract",
          resolveId(id) {
            if (id === "/__shared_entry.js") return "\0shared-entry";
          },
          load(id) {
            if (id === "\0shared-entry") return entry;
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__shared") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"><style>body{margin:0}.app{display:block}.workspace{position:relative;width:min(820px,calc(100vw - 80px));height:640px;margin:24px 40px}</style></head><body><div id="root"></div><script type="module" src="/__shared_entry.js"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        fs: { allow: [resolve(".")] },
      },
      logLevel: "error",
    });
    context.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1024, height: 768 },
    });
    page.setDefaultTimeout(4000);
    const errors: string[] = [],
      unexpectedRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        !request.url().startsWith(`http://127.0.0.1:${address.port}/`) &&
        !request.url().startsWith("data:")
      )
        unexpectedRequests.push(request.url());
    });
    // Browser-owned JS avoids importing the test compiler's class/name helpers
    // into addInitScript's isolated serialization context.
    await page.addInitScript(`(() => {
    let active = 0;
    const Observer = window.ResizeObserver, alive = new WeakSet();
    window.ResizeObserver = class extends Observer {
      constructor(callback) { super(callback); alive.add(this); active++; }
      disconnect() { if (alive.delete(this)) active--; super.disconnect(); }
    };
    Object.defineProperty(window, "sharedObservers", { get: () => active });
  })();`);
    const inspect = () =>
      page.evaluate(() =>
        Reflect.get(window, "scriptSharedFixture").inspect(),
      ) as Promise<{
        sameDialog: boolean;
        sameLabels: boolean;
        id: number | null;
        events: unknown[][];
        active: string;
        observers: number;
        modal: boolean;
        rect: { x: number; y: number; width: number; height: number } | null;
        form: {
          scrollHeight: number;
          clientHeight: number;
          scrollTop: number;
        } | null;
      }>;
    await page.goto(`http://127.0.0.1:${address.port}/__shared`);
    await page.waitForFunction(
      () => !!Reflect.get(window, "scriptSharedFixture"),
    );
    assert.equal((await inspect()).sameDialog, true);
    assert.equal((await inspect()).sameLabels, true);
    await page
      .getByRole("button", { name: "打开原对话框", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "原名称", exact: true }),
    ).toBeFocused();
    const initial = await inspect();
    assert.equal(initial.modal, true);
    assert.equal(
      initial.observers,
      1,
      "StrictMode cleanup leaves one active actual modal observer",
    );
    await page
      .getByRole("textbox", { name: "原正文", exact: true })
      .fill("未提交修改仍是原孩子");
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("受控错误保留原草稿");
    const error = await inspect();
    assert.equal(error.id, initial.id);
    assert.ok(
      error.form && error.form.scrollHeight > error.form.clientHeight,
      "actual long child error scrolls within the original form",
    );
    await page.evaluate(() => {
      const form = document.querySelector("dialog form")!;
      form.scrollTop = form.scrollHeight;
    });
    assert.ok((await inspect()).form!.scrollTop > 0);
    await page.evaluate(() =>
      Reflect.get(window, "scriptSharedFixture").update({
        compact: true,
        title: "原紧凑标题",
      }),
    );
    await expect(page.getByRole("dialog", { name: "原紧凑标题" })).toHaveClass(
      /script-dialog-compact/,
    );
    assert.equal(
      (await inspect()).id,
      initial.id,
      "prop updates keep the same native node",
    );
    await expect(
      page.getByRole("textbox", { name: "原正文", exact: true }),
    ).toHaveValue("未提交修改仍是原孩子");
    await page.getByRole("button", { name: "确认", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "关闭", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("button", { name: "确认", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(page.locator("#trigger")).toBeFocused();
    await page.waitForFunction(() =>
      Reflect.get(window, "scriptSharedFixture")
        .inspect()
        .events.some((event: string[]) => event[0] === "cancel"),
    );
    let report = await inspect();
    assert.equal(report.observers, 0);
    assert.equal(
      report.events.filter((event) => event[0] === "close").length,
      1,
    );
    assert.deepEqual(
      report.events.find((event) => event[0] === "cancel"),
      ["cancel", true],
    );
    await page.locator("#origin").focus();
    await page
      .locator("#origin")
      .evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 6));
    await page.keyboard.press("Enter");
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator("#origin")).toBeFocused();
    assert.deepEqual(
      await page
        .locator("#origin")
        .evaluate((input: HTMLInputElement) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      [2, 6],
    );
    report = await inspect();
    assert.equal(
      report.events.filter((event) => event[0] === "close").length,
      2,
    );
    await page.setViewportSize({ width: 760, height: 540 });
    await page
      .getByRole("button", { name: "打开原对话框", exact: true })
      .click();
    await page.evaluate(() =>
      Reflect.get(window, "scriptSharedFixture").update({ compact: true }),
    );
    const narrow = await inspect();
    assert.ok(
      narrow.rect &&
        narrow.rect.x >= 0 &&
        narrow.rect.y >= 0 &&
        narrow.rect.x + narrow.rect.width <= 760 &&
        narrow.rect.y + narrow.rect.height <= 540,
    );
    const closed = (await page.evaluate(() =>
      Reflect.get(window, "scriptSharedFixture").cleanup(),
    )) as { observers: number };
    assert.equal(closed.observers, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    context.diagnostic(
      JSON.stringify({
        sameBindings: true,
        nativeCancel: ["cancel", true],
        closes: report.events.filter((event) => event[0] === "close").length,
        sameNodeThroughUpdates: true,
        longErrorScroll: true,
        cleanupObservers: closed.observers,
        browserDOMFocusOnly: true,
      }),
    );
  },
);
