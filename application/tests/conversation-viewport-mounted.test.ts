import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import {
  viewportOriginalGit,
  viewportOriginalSha,
} from "./fixtures/conversation-viewport-mounted.js";

// Complete real Conversation DOM/StrictMode, not a hook wrapper. Presentation
// ports are local deferred Promises; no Host/Runtime/input/model requests.
// Geometry below is a deterministic reading viewport, not visual acceptance.
const fixtureSource = `
import React,{StrictMode,useCallback,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Conversation as CurrentConversation} from '/src/Conversation.tsx';
import {Conversation as HistoricalConversation} from '__VIEWPORT_HISTORY__';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
import {disconnectedRuntime} from '/@fs/${resolve("packages/core/src/conversation.ts")}';
import {viewportInput,viewportReply,viewportQuote,viewportMessages,viewportTime} from '/@fs/${resolve("tests/fixtures/conversation-viewport-mounted.ts")}';
const historical=new URL(location.href).searchParams.get('lane')==='historical';
const Component=historical?HistoricalConversation:CurrentConversation;
const root=createRoot(document.getElementById('root'));
const observers=[]; let serial=0,api,events=[],requests=[],positions,originalPositions,originalNode,originalMessage,controls,visible=true,focused=true;
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'});
Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>focused});
window.ResizeObserver=class { constructor(callback){this.callback=callback;this.active=true;observers.push(this);} observe(node){this.node=node;} disconnect(){this.active=false;} };
function deferred(kind,label,id){let accept,reject;const promise=new Promise((a,b)=>{accept=a;reject=b;});requests.push({kind,label,id,accept,reject,settled:false});events.push([kind,label,id]);return promise;}
function Fixture({initial}) {
 const [config,setConfig]=useState({scope:'conversation-A',focus:null,reveal:null,quote:null,earlier:false,composer:'focus',epoch:0,readEpoch:0,...initial});
 const [messages,setMessages]=useState(viewportMessages()),[mounted,setMounted]=useState(true),[toolbar,setToolbar]=useState(null),[tick,setTick]=useState(0);
 const state=initialWorkspace(viewportTime); state.inputs=[viewportInput('input-A'),viewportInput('input-B','object-B')];
 const runtime={...disconnectedRuntime,messages};
 const label=config.scope+':'+config.epoch;
 const client={boot:{workspace:state,runtime,outputs:[],scriptOutputs:[],localSavedInputIds:[],localInputSubmissions:{},actantId:'human'},online:true,contentCatalog:[],contentVersionTitle:()=>null,
  loadHistoryUntil:id=>deferred('until',label,id),cancelInput:()=>{throw Error('unexpected input control');}};
 const onRead=useCallback(receipts=>events.push(['read',receipts]),[config.readEpoch]);
 const onFocusComposer=()=>{events.push(['composer',label]);if(config.composer==='focus')document.getElementById('composer').focus({preventScroll:true});};
 api={config,messages,run(action,value){if(action==='config')setConfig(c=>({...c,...value}));else if(action==='append')setMessages(m=>[...m,{...viewportReply(value.id,value.text,value.inputId),createdAt:'2026-10-04T01:00:00.000Z'}]);else if(action==='prepend')setMessages(m=>[{...viewportReply(value.id,value.text,value.inputId),createdAt:'2026-10-03T23:00:00.000Z'},...m]);else if(action==='mount')setMounted(value);else if(action==='tick')setTick(t=>t+1);else throw Error('unknown fixture action '+action);}};
 return <article data-tick={tick}><header ref={setToolbar}/><input id="composer" aria-label="Fixture composer" defaultValue="Unsent draft"/><button id="outside" type="button">Outside control</button><dialog id="modal"><button type="button">Modal control</button></dialog>{mounted&&<Component inputs={state.inputs} state={state} runtime={runtime} messages={messages} streamConnected={false} seenReplies={{}} onRead={onRead} conversationId={config.scope} onRetry={()=>{throw Error('unexpected retry');}} client={client} onOpen={()=>{throw Error('unexpected object open');}} positions={positions} revealInputId={config.reveal} focusedArtifactId={config.focus??undefined} toolbarTarget={toolbar} onFocusComposer={config.composer==='absent'?undefined:onFocusComposer} quoteReveal={config.quote} onQuoteUnavailable={reason=>events.push(['unavailable',label,reason??null])} hasEarlierHistory={config.earlier} onLoadEarlierHistory={()=>deferred('earlier',label,null)}/>}</article>;
}
function reset(initial={}) {
 visible=true;focused=true;events=[];requests=[];positions=new Map(initial.seed??[]);originalPositions=positions;
 flushSync(()=>root.render(<StrictMode><Fixture key={++serial} initial={initial}/></StrictMode>));
 originalNode=document.querySelector('.conversation');originalMessage=document.querySelector('[data-message-id="reply-0"]');
}
function run(action,value){flushSync(()=>api.run(action,value));}
function report(){const el=document.querySelector('.conversation');return {top:el?.scrollTop??null,height:el?.scrollHeight??null,clientHeight:el?.clientHeight??null,positions:[...positions],sameMap:positions===originalPositions,sameNode:el===originalNode,sameMessage:document.querySelector('[data-message-id="reply-0"]')===originalMessage,events,requests:requests.map(({kind,label,id,settled})=>({kind,label,id,settled})),active:document.activeElement?.id||document.activeElement?.className||document.activeElement?.tagName,away:!!document.querySelector('.conversation-return'),older:document.querySelector('.conversation-load-older')?.textContent,olderDisabled:document.querySelector('.conversation-load-older')?.disabled??null,error:document.querySelector('.conversation-load-error')?.textContent??null,markers:[...document.querySelectorAll('[data-quote-revealed]')].map(n=>n.dataset.messageId),selected:window.getSelection()?.toString(),observerActive:observers.filter(o=>o.active).length,draft:document.getElementById('composer')?.value};}
Object.assign(window,{viewportFixture:{reset,run,report,clear(){events=[];},scroll(top){const el=document.querySelector('.conversation');el.scrollTop=top;el.dispatchEvent(new Event('scroll'));},fireResize(){for(const o of observers)if(o.active)o.callback([]);},height(value){document.querySelector('.conversation').style.height=value+'px';},readGate(kind,value){if(kind==='visible')visible=value;else focused=value;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));},quote(id,token,text,createdAt){const message=api.messages.find(m=>m.id===id);const quote=viewportQuote(id,text);if(message)quote.source={...quote.source,inputId:message.inputId,createdAt:message.createdAt};else if(createdAt)quote.source={...quote.source,createdAt};run('config',{quote:{quote,token}});},nonMessageQuote(){const quote={...viewportQuote('reply-2'),source:{kind:'artifact',artifactId:'object-A',revision:1,projectId:'first-project',title:'Artifact'}};run('config',{quote:{quote,token:'artifact-token'}});},settle(index,result,error){const r=requests[index];if(!r||r.settled)throw Error('invalid deferred request');r.settled=true;if(error==='nonerror')r.reject('fixture rejection');else if(error)r.reject(Error(error));else r.accept(result);},rect(id){const el=document.querySelector('.conversation'),message=[...document.querySelectorAll('[data-message-id]')].find(n=>n.dataset.messageId===id);return {top:message.getBoundingClientRect().top-el.getBoundingClientRect().top,scroll:el.scrollTop};}}});
reset();
`;

type Position = { top: number; following: boolean; revealed: string | null };
type Report = {
  top: number | null;
  height: number | null;
  clientHeight: number | null;
  positions: [string, Position][];
  sameMap: boolean;
  sameNode: boolean;
  sameMessage: boolean;
  events: unknown[][];
  requests: {
    kind: string;
    label: string;
    id: string | null;
    settled: boolean;
  }[];
  active: string;
  away: boolean;
  older: string | null;
  olderDisabled: boolean | null;
  error: string | null;
  markers: string[];
  selected: string;
  observerActive: number;
  draft: string;
};

const migration =
  process.env.MORPHZ_TEST_CONVERSATION_VIEWPORT_MIGRATION_EQUIVALENCE === "1";
function historicalSource() {
  if (!migration) return null;
  const directory = process.env.MORPHZ_TEST_CONVERSATION_VIEWPORT_BASELINE_DIR;
  assert(directory, "explicit viewport migration requires BASELINE_DIR");
  const manifest = JSON.parse(
    readFileSync(resolve(directory, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.originalGit, viewportOriginalGit);
  assert.equal(manifest.source, "application/apps/web/src/Conversation.tsx");
  assert.equal(manifest.file, "Conversation-29863c3f.tsx");
  assert.equal(manifest.sha256, viewportOriginalSha);
  const raw = readFileSync(resolve(directory, manifest.file), "utf8");
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    viewportOriginalSha,
  );
  return raw;
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  return page.evaluate(() =>
    Reflect.get(window, "viewportFixture").report(),
  ) as Promise<Report>;
}
async function call(page: Page, name: string, ...args: unknown[]) {
  await page.evaluate(
    ({ name, args }) => Reflect.get(window, "viewportFixture")[name](...args),
    { name, args },
  );
  return settle(page);
}
const position = (report: Report, key = "conversation-A:all") => {
  const value = report.positions.find(([name]) => name === key)?.[1];
  assert(value, "actual caller-owned position entry: " + key);
  return value;
};
const readCount = (report: Report) =>
  report.events.filter(([kind]) => kind === "read").length;
const unavailable = (report: Report) =>
  report.events.filter(([kind]) => kind === "unavailable");
const near = (actual: number, expected: number, message: string) =>
  assert(
    Math.abs(actual - expected) < 2,
    `${message}: ${actual} vs ${expected}`,
  );

test(
  "complete Conversation StrictMode reading viewport: current contract and explicit Git298 migration",
  { timeout: 60000 },
  async (context) => {
    const archived = historicalSource();
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      executable
        ? existsSync(executable)
        : existsSync(chromium.executablePath()),
      "mounted viewport requires the test-entry prepared browser",
    );
    const cache = await mkdtemp(resolve(tmpdir(), "morphz-viewport-vite-"));
    context.after(() => rm(cache, { recursive: true, force: true }));
    const historyId = resolve(
      "apps/web/src/__viewport_Git298_Conversation.tsx",
    );
    const source = fixtureSource.replace(
      "__VIEWPORT_HISTORY__",
      archived ? historyId : "/src/Conversation.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "complete-conversation-viewport-test-only",
          resolveId(id) {
            if (id === "/__viewport.tsx") return "\0" + id;
            if (id === historyId && archived) return id;
          },
          async load(id) {
            if (id === "\0/__viewport.tsx")
              return transformWithOxc(source, "viewport.tsx");
            if (id === historyId && archived) return archived;
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__viewport") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url!,
                  '<!doctype html><html><head><link rel="icon" href="data:,"/><style>body{margin:0;font:14px/20px sans-serif}article{width:620px}.conversation{height:240px;overflow:auto;scroll-behavior:auto;border:0;padding:0;position:relative}.conversation-message{padding:8px;margin:0;min-height:76px}.conversation-return{position:sticky;bottom:0;height:0;display:flex;justify-content:center;pointer-events:none}.new-exchange{position:absolute;bottom:0;pointer-events:auto}.conversation p{margin:0 0 8px}header{height:28px}dialog{margin:0;position:fixed;right:0;left:auto}</style></head><body><div id="root"></div><script type="module" src="/__viewport.tsx"></script></body></html>',
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
    assert(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const outputs = new Map<string, unknown[]>();
    for (const lane of archived ? ["current", "historical"] : ["current"]) {
      const browserContext = await browser.newContext({
        viewport: { width: 900, height: 600 },
      });
      const page = await browserContext.newPage();
      const errors: string[] = [],
        queries: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          ["fetch", "xhr"].includes(request.resourceType()) &&
          !request.url().includes("/@vite/")
        )
          queries.push(request.url());
      });
      context.after(() => browserContext.close());
      await page.goto(
        `http://127.0.0.1:${address.port}/__viewport?lane=${lane}`,
      );
      await page.waitForSelector(".conversation");
      const observations: unknown[] = [];
      const reset = (value: unknown = {}) => call(page, "reset", value);
      const run = (action: string, value: unknown) =>
        call(page, "run", action, value);
      let phase = "mount";
      context.after(() => {
        if (errors.length || queries.length)
          context.diagnostic(JSON.stringify({ lane, phase, errors, queries }));
      });

      await context.test(
        lane +
          ": caller Map restore, focused keys, remount and complete DOM identity",
        async () => {
          phase = "restore";
          let value = await reset({
            seed: [
              [
                "conversation-A:all",
                { top: 170, following: false, revealed: null },
              ],
              [
                "conversation-A:focus:object-A",
                { top: 72, following: false, revealed: null },
              ],
            ],
          });
          assert.equal(value.top, 170);
          assert.equal(value.away, true);
          assert.equal(value.sameMap, true);
          value = await run("tick", null);
          assert(value.sameNode && value.sameMessage && value.sameMap);
          value = await run("config", { focus: "object-A" });
          assert.equal(value.top, 72);
          assert.equal(
            position(value, "conversation-A:focus:object-A").following,
            false,
          );
          value = await run("config", { focus: null });
          assert.equal(value.top, 170);
          await run("mount", false);
          value = await run("mount", true);
          assert.equal(value.top, 170);
          assert(value.sameMap);
          assert.equal(value.sameNode, false);
          observations.push([
            "restore",
            value.top,
            value.positions,
            value.draft,
          ]);
        },
      );
      await context.test(
        lane +
          ": following, away, explicit reveal, resize and original 48px boundary",
        async () => {
          phase = "follow";
          let value = await reset();
          assert.equal(position(value).following, true);
          near(
            value.top!,
            value.height! - value.clientHeight!,
            "latest initial",
          );
          const firstHeight = value.height!;
          value = await run("append", {
            id: "growth",
            text: "Stream growth ".repeat(120),
          });
          assert(value.height! > firstHeight);
          near(
            value.top!,
            value.height! - value.clientHeight!,
            "content growth follows",
          );
          await page.locator("#outside").focus();
          value = await call(page, "height", 180);
          value = await call(page, "fireResize");
          near(
            value.top!,
            value.height! - value.clientHeight!,
            "resize follows",
          );
          assert.equal(value.active, "outside");
          value = await call(page, "scroll", 160);
          assert.equal(position(value).following, false);
          assert(value.away);
          const top = value.top;
          value = await run("append", {
            id: "away-growth",
            text: "Later reply ".repeat(80),
          });
          assert.equal(value.top, top);
          assert.equal(value.active, "outside");
          value = await call(page, "height", 210);
          value = await call(page, "fireResize");
          assert.equal(value.top, top);
          value = await run("config", { reveal: "input-A" });
          assert.equal(position(value).following, true);
          assert.equal(position(value).revealed, "input-A");
          near(
            value.top!,
            value.height! - value.clientHeight!,
            "explicit input follows",
          );
          value = await call(
            page,
            "scroll",
            value.height! - value.clientHeight! - 48,
          );
          assert.equal(position(value).following, true);
          value = await call(
            page,
            "scroll",
            value.height! - value.clientHeight! - 49,
          );
          assert.equal(position(value).following, false);
          observations.push([
            "follow",
            value.top,
            value.height,
            value.clientHeight,
            value.positions,
            value.active,
          ]);
        },
      );
      await context.test(
        lane +
          ": controlled DOM visibility/focus/modal read guards and listener cleanup",
        async () => {
          phase = "read guards";
          await reset();
          await call(page, "clear");
          let value = await call(page, "readGate", "visible", false);
          assert.equal(readCount(value), 0);
          await call(page, "readGate", "focused", false);
          value = await call(page, "readGate", "visible", true);
          assert.equal(readCount(value), 0);
          await page.evaluate(() =>
            (document.querySelector("#modal") as HTMLDialogElement).showModal(),
          );
          value = await call(page, "readGate", "focused", true);
          assert.equal(readCount(value), 0);
          await page.evaluate(() =>
            (document.querySelector("#modal") as HTMLDialogElement).close(),
          );
          await call(page, "clear");
          value = await call(page, "readGate", "visible", true);
          assert(readCount(value) >= 1);
          value = await call(page, "scroll", 80);
          await call(page, "clear");
          value = await call(page, "readGate", "visible", true);
          assert.equal(readCount(value), 0);
          await run("mount", false);
          await call(page, "clear");
          value = await call(page, "readGate", "visible", true);
          assert.equal(readCount(value), 0);
          assert.equal(value.observerActive, 0);
          observations.push([
            "read cleanup",
            value.events,
            value.observerActive,
          ]);
        },
      );
      await context.test(
        lane +
          ": returning button transfers focus before removal and fallback borrows same scroller",
        async () => {
          phase = "return focus";
          for (const composer of ["focus", "noop", "absent"]) {
            await reset({ composer });
            await call(page, "scroll", 100);
            await page.locator(".new-exchange").focus();
            await page.locator(".new-exchange").press("Enter");
            const value = await settle(page);
            assert.equal(value.away, false);
            assert.equal(
              value.active,
              composer === "focus" ? "composer" : "conversation",
            );
            assert(value.sameNode);
            assert.equal(value.draft, "Unsent draft");
            assert.equal(
              value.events.filter(([kind]) => kind === "composer").length,
              composer === "absent" ? 0 : 1,
            );
            observations.push([
              "return focus",
              composer,
              value.active,
              value.top,
              value.events.filter(([kind]) => kind === "composer"),
            ]);
          }
          await reset();
          await call(page, "scroll", 100);
          await page.locator("#outside").focus();
          await page.evaluate(() =>
            (
              document.querySelector(".new-exchange") as HTMLButtonElement
            ).click(),
          );
          const value = await settle(page);
          assert.equal(value.active, "outside");
          assert.equal(
            value.events.filter(([kind]) => kind === "composer").length,
            0,
          );
        },
      );
      await context.test(
        lane +
          ": deferred prepend preserves geometric anchor, rejects safely and retains captured scope",
        async () => {
          phase = "prepend";
          await reset({ earlier: true });
          await call(page, "scroll", 180);
          const before = await page.evaluate(() =>
            Reflect.get(window, "viewportFixture").rect("reply-4"),
          );
          // DOM activation avoids Playwright auto-scrolling this header control,
          // so the original handler really captures the reading anchor at 180px.
          await page.evaluate(() =>
            (
              document.querySelector(
                ".conversation-load-older",
              ) as HTMLButtonElement
            ).click(),
          );
          let value = await settle(page);
          assert(value.olderDisabled);
          assert.equal(value.requests.length, 1);
          await run("prepend", {
            id: "older",
            text: "Earlier body ".repeat(65),
          });
          value = await call(page, "settle", 0, undefined, null);
          assert.equal(value.olderDisabled, false);
          assert.equal(position(value).following, false);
          const after = await page.evaluate(() =>
            Reflect.get(window, "viewportFixture").rect("reply-4"),
          );
          near(after.top, before.top, "prepend retains original message BCR");
          assert(value.sameNode && value.sameMessage);
          observations.push([
            "prepend",
            before.top,
            after.top,
            value.positions,
          ]);
          await page
            .getByRole("button", { name: "查看更早消息", exact: true })
            .click();
          value = await call(page, "settle", 1, undefined, "history failure");
          assert.equal(value.error, "history failure");
          assert.equal(value.olderDisabled, false);
          await page
            .getByRole("button", { name: "查看更早消息", exact: true })
            .click();
          value = await settle(page);
          assert.equal(value.error, null);
          value = await call(page, "settle", 2, undefined, "nonerror");
          assert.equal(value.error, "旧消息暂时无法读取，请重试。");
          await reset({ earlier: true });
          await call(page, "scroll", 160);
          await page
            .getByRole("button", { name: "查看更早消息", exact: true })
            .click();
          await run("config", { focus: "object-A" });
          const captured = await settle(page);
          const focusedTop = captured.top;
          value = await call(page, "settle", 0, undefined, null);
          assert.equal(value.top, focusedTop);
          assert.equal(
            position(value, "conversation-A:focus:object-A").following,
            true,
          );
          assert.equal(value.requests[0]!.label, "conversation-A:0");
        },
      );
      await context.test(
        lane +
          ": precise message Range, token dedup, 2200ms marker and actual cleanup",
        async () => {
          phase = "quote Range";
          await reset();
          await call(
            page,
            "quote",
            "reply-4",
            "current-token",
            "Quote passage",
          );
          let value = await settle(page);
          assert.deepEqual(value.markers, ["reply-4"]);
          assert.equal(value.selected, "Quote passage");
          assert.equal(position(value).following, false);
          assert(value.away);
          const rect = await page.evaluate(() =>
            Reflect.get(window, "viewportFixture").rect("reply-4"),
          );
          near(
            rect.top,
            24,
            "explicit source is aligned at original 24px inset",
          );
          await run("tick", null);
          value = await call(
            page,
            "quote",
            "reply-4",
            "current-token",
            "Quote passage",
          );
          assert.deepEqual(value.markers, []); // prior effect cleanup, token must not reveal twice
          await call(page, "quote", "reply-5", "timer-token", "Quote passage");
          value = await settle(page);
          assert.deepEqual(value.markers, ["reply-5"]);
          await page.waitForFunction(
            () =>
              !document
                .querySelector('[data-message-id="reply-5"]')
                ?.hasAttribute("data-quote-revealed"),
            undefined,
            { timeout: 3500 },
          );
          value = await settle(page);
          assert.deepEqual(value.markers, []);
          assert.equal(value.selected, "Quote passage");
          await call(
            page,
            "quote",
            "reply-6",
            "unmount-token",
            "Quote passage",
          );
          await page.evaluate(() =>
            Reflect.set(
              window,
              "viewportRetainedQuote",
              document.querySelector('[data-message-id="reply-6"]'),
            ),
          );
          await run("mount", false);
          value = await settle(page);
          assert.deepEqual(value.markers, []);
          assert.equal(
            await page.evaluate(() =>
              Reflect.get(window, "viewportRetainedQuote").hasAttribute(
                "data-quote-revealed",
              ),
            ),
            false,
            "effect cleanup also removes the marker on the actual detached node",
          );
          assert.equal(value.observerActive, 0);
          observations.push([
            "quote",
            rect.top,
            value.markers,
            value.observerActive,
          ]);
        },
      );
      await context.test(
        lane +
          ": hidden known quotes, real backfill ports, missing/rejected outcomes and captured client",
        async () => {
          phase = "quote history";
          await reset({ focus: "object-A" });
          assert.equal(
            await page.locator('[data-message-id="reply-5"]').count(),
            0,
          );
          await call(page, "quote", "reply-5", "hidden-token", "Quote passage");
          let value = await settle(page);
          assert.deepEqual(value.markers, ["reply-5"]);
          assert.equal(value.requests.length, 0);
          assert(position(value).following === false);
          assert(value.sameNode);
          await reset({ earlier: true });
          await call(
            page,
            "quote",
            "backfill",
            "backfill-token",
            "Historical phrase",
            "2026-10-03T23:00:00.000Z",
          );
          value = await settle(page);
          assert.equal(value.requests.length, 1);
          assert.equal(value.requests[0]!.id, "backfill");
          await run("config", { epoch: 1 });
          await run("tick", null);
          value = await settle(page);
          assert.equal(value.requests.length, 1);
          assert.equal(value.requests[0]!.label, "conversation-A:0");
          await run("prepend", {
            id: "backfill",
            text: "Historical phrase from the exact older source",
          });
          value = await call(page, "settle", 0, true, null);
          assert.deepEqual(value.markers, ["backfill"]);
          assert.equal(value.selected, "Historical phrase");
          assert.deepEqual(unavailable(value), []);
          await reset();
          value = await call(page, "quote", "missing", "missing-token");
          assert.deepEqual(unavailable(value), [
            ["unavailable", "conversation-A:0", null],
          ]);
          assert.equal(value.requests.length, 0);
          await call(page, "quote", "missing", "missing-token");
          value = await settle(page);
          assert.equal(unavailable(value).length, 1);
          for (const rejection of [null, "quote read failed", "nonerror"]) {
            await reset({ earlier: true });
            await call(page, "quote", "not-loaded", "reject-token");
            value = await call(page, "settle", 0, false, rejection);
            assert.deepEqual(unavailable(value), [
              [
                "unavailable",
                "conversation-A:0",
                rejection && rejection !== "nonerror" ? rejection : null,
              ],
            ]);
            assert.equal(value.requests.length, 1);
          }
          await reset({ earlier: true });
          value = await call(page, "nonMessageQuote");
          assert.equal(value.requests.length, 0);
          assert.deepEqual(unavailable(value), []);
          assert.deepEqual(value.markers, []);
          await reset();
          await run("append", {
            id: 'quoted"[]:id',
            text: "Escaped identity phrase",
          });
          value = await call(
            page,
            "quote",
            'quoted"[]:id',
            "escaped-token",
            "Escaped identity",
          );
          assert.deepEqual(value.markers, ['quoted"[]:id']);
          assert.equal(value.selected, "Escaped identity");
          observations.push([
            "history",
            value.markers,
            value.selected,
            value.requests,
          ]);
        },
      );
      if (migration)
        await context.test(
          lane +
            ": migration-only old late callback characteristic is recorded, not permanent policy",
          async () => {
            phase = "migration late";
            await reset({ earlier: true });
            await call(page, "quote", "late", "late-token");
            await run("config", {
              scope: "conversation-B",
              epoch: 2,
              quote: null,
            });
            const value = await call(
              page,
              "settle",
              0,
              false,
              "late historical error",
            );
            assert.deepEqual(unavailable(value), [
              ["unavailable", "conversation-A:0", "late historical error"],
            ]);
            observations.push([
              "migration late",
              value.requests,
              unavailable(value),
            ]);
          },
        );
      assert.deepEqual(errors, [], lane + " browser errors");
      assert.deepEqual(queries, [], lane + " zero business requests");
      outputs.set(lane, observations);
      await browserContext.close();
    }
    if (archived)
      assert.deepEqual(
        outputs.get("current"),
        outputs.get("historical"),
        "strict actual Git298/current mounted observation parity",
      );
  },
);
