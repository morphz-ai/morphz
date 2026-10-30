import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Browser } from "@playwright/test";
import { createServer, transformWithOxc, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

test("actual memoized message footer skips unrelated streams but updates all actions and share inputs", async (context) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "morphz-message-actions-"));
  let server: ViteDevServer | undefined, browser: Browser | undefined;
  context.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    }
  });
  // Count the actual inner render, preserving React's real memo wrapper,
  // comparator, hooks and UI. No timing threshold or production probe.
  const source = `
import React,{StrictMode,useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{MessageActions}from'/src/Conversation.tsx';import{initialWorkspace}from'/@fs/${resolve("packages/core/src/model.ts")}';
${currentAppCSSImports()}
const original=MessageActions.type;let renders=0,update;const copied=[],clicks=[];
MessageActions.type=function CountedMessageActions(props){renders++;return original(props);};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied.push(text);}}});
const initial={createdAt:'2026-10-23T00:00:00Z',text:'TEST original',client:{},share:{text:'TEST original',author:'Morphz',createdAt:'2026-10-23T00:00:00Z',format:'markdown',partial:false,quotes:[{text:'TEST quote',comment:'TEST comment'}],attachments:['TEST attachment'],state:initialWorkspace(),catalog:[]}};
function App(){const[props,setProps]=useState(initial);update=patch=>setProps(old=>({...old,...patch}));return <main className="app" data-appearance="light" style={{display:'block',padding:16}}><section className="conversation"><article className="conversation-message agent-message"><p>TEST unchanged history</p><div className="message-meta"><MessageActions {...props}/></div></article></section></main>;}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><App/></StrictMode>));
Reflect.set(window,'actionsFixture',{snapshot:()=>({renders,copied:[...copied],clicks:[...clicks]}),refresh:()=>flushSync(()=>update({share:{...initial.share,quotes:initial.share.quotes.map(q=>({...q})),attachments:[...initial.share.attachments]}})),patch:field=>flushSync(()=>{
 if(field==='text')update({text:'TEST new copy'});
 else if(field==='createdAt')update({createdAt:'2026-10-24T00:00:00Z'});
 else if(field==='client')update({client:{}});
 else if(field==='control')update({control:<button onClick={()=>clicks.push('new control')}>TEST new stop</button>});
 else update({share:{...initial.share,...({shareText:{text:'TEST new share'},author:{author:'我'},shareTime:{createdAt:'2026-10-24T00:00:00Z'},format:{format:'plain'},partial:{partial:true},quotes:{quotes:[{text:'TEST new quote',comment:'TEST comment'}]},comments:{quotes:[{text:'TEST quote',comment:'TEST new comment'}]},attachments:{attachments:['TEST new attachment']},state:{state:initialWorkspace()},catalog:{catalog:[]}}[field])}});
}),reset:()=>flushSync(()=>update(initial))});
`;
  server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    cacheDir,
    optimizeDeps: {
      entries: [resolve("apps/web/src/Conversation.tsx")],
      include: ["react", "react-dom/client", "react-dom", "react/jsx-runtime"],
    },
    plugins: [
      react(),
      {
        name: "message-action-fixture",
        resolveId(id) {
          if (id === "/__actions.tsx") return "\0" + id;
        },
        async load(id) {
          if (id === "\0/__actions.tsx")
            return transformWithOxc(source, "actions.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__actions") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__actions.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__actions`);
  const copy = page.getByRole("button", { name: "复制消息", exact: true });
  await expect(copy).toBeVisible();
  const snapshot = () =>
    page.evaluate(() => Reflect.get(window, "actionsFixture").snapshot());
  const initial = await snapshot();
  await page.evaluate(() => {
    for (let index = 0; index < 12; index++)
      Reflect.get(window, "actionsFixture").refresh();
  });
  assert.equal((await snapshot()).renders, initial.renders);
  for (const field of [
    "text",
    "createdAt",
    "client",
    "control",
    "shareText",
    "author",
    "shareTime",
    "format",
    "partial",
    "quotes",
    "comments",
    "attachments",
    "state",
    "catalog",
  ]) {
    await page.evaluate(() => Reflect.get(window, "actionsFixture").reset());
    const before = await snapshot();
    await page.evaluate(
      (field) => Reflect.get(window, "actionsFixture").patch(field),
      field,
    );
    assert.ok((await snapshot()).renders > before.renders, field);
  }
  await page.evaluate(() => {
    Reflect.get(window, "actionsFixture").reset();
    Reflect.get(window, "actionsFixture").patch("text");
  });
  await page.locator(".conversation-message").hover();
  await copy.click();
  await expect(page.getByRole("button", { name: "已复制消息" })).toBeVisible();
  assert.deepEqual((await snapshot()).copied, ["TEST new copy"]);
  await page.evaluate(() =>
    Reflect.get(window, "actionsFixture").patch("control"),
  );
  await page.getByRole("button", { name: "TEST new stop" }).click();
  assert.deepEqual((await snapshot()).clicks, ["new control"]);
  assert.deepEqual(errors, []);
});
