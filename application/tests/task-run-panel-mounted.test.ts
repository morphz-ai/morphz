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
  panelRuntime,
  panelResponses,
  panelSnapshot,
  taskPanelOriginalGit,
  taskPanelOriginalSha,
} from "./fixtures/task-run-panel-mounted.js";

// Entire real TaskRunPanel, observed reads, popover and ExecutionDialog. The
// controlled Client ledger is not HTTP authorization, physical Runtime or OS
// focus evidence. Historical late-action quirks are migration-only assertions.
const migration =
  process.env.MORPHZ_TEST_TASK_PANEL_MIGRATION_EQUIVALENCE === "1";
function historicalSource() {
  if (!migration) return null;
  const directory = process.env.MORPHZ_TEST_TASK_PANEL_BASELINE_DIR;
  assert(directory, "explicit TaskRunPanel migration requires BASELINE_DIR");
  const manifest = JSON.parse(
    readFileSync(resolve(directory, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.originalGit, taskPanelOriginalGit);
  assert.equal(manifest.source, "application/apps/web/src/TaskRunPanel.tsx");
  assert.equal(manifest.file, "TaskRunPanel-d93326c0.tsx");
  assert.equal(manifest.sha256, taskPanelOriginalSha);
  const raw = readFileSync(resolve(directory, manifest.file), "utf8");
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    taskPanelOriginalSha,
  );
  return raw;
}

// Current CSS import graph only; do not run App main JS or guess its cascade.
const cssImports = [
  ...readFileSync("apps/web/src/main.tsx", "utf8").matchAll(
    /import\s+["'](\.\/[^"']+\.css)["'];/g,
  ),
]
  .map((match) => `import ${JSON.stringify("/src/" + match[1]!.slice(2))};`)
  .join("\n");
const browserFixture = `
import React,{StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {TaskRunPanel as CurrentPanel} from '/src/TaskRunPanel.tsx';
import {TaskRunPanel as HistoricalPanel} from '__TASK_PANEL_HISTORY__';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
import {panelTask,panelRuntime,panelResponses,panelSnapshot,panelTime} from '/@fs/${resolve("tests/fixtures/task-run-panel-mounted.ts")}';
${cssImports}
const Panel=new URL(location.href).searchParams.get('lane')==='historical'?HistoricalPanel:CurrentPanel;
const root=createRoot(document.getElementById('root')),ids=new WeakMap(),activeObservers=new Set(),resizeListeners=new Set();
let serial=0,nodeSerial=0,api,last,events=[],requests=[],initialNodes={},unmounted=false;
const nodeId=n=>{if(!n)return null;if(!ids.has(n))ids.set(n,++nodeSerial);return ids.get(n);};
const NativeResizeObserver=ResizeObserver; window.ResizeObserver=class extends NativeResizeObserver{constructor(cb){super(cb);activeObservers.add(this);}disconnect(){activeObservers.delete(this);return super.disconnect();}};
const add=window.addEventListener,remove=window.removeEventListener;
window.addEventListener=function(type,callback,...args){if(type==='resize')resizeListeners.add(callback);return add.call(this,type,callback,...args);};
window.removeEventListener=function(type,callback,...args){if(type==='resize')resizeListeners.delete(callback);return remove.call(this,type,callback,...args);};
function request(kind,args,signal,client,current){const index=requests.length;events.push(['request',kind,index,client]);return new Promise((accept,reject)=>{requests.push({index,kind,args,signal,client,current,accept,reject,settled:false});signal?.addEventListener('abort',()=>events.push(['abort',index]),{once:true});});}
const defaults={id:'task-A',artifactRevision:3,project:'first-project',human:false,nonTask:false,execution:'planned',runRequested:0,resultIds:[],online:true,capability:true,compact:false,observed:false,readError:undefined,view:undefined,center:'center-A',principal:'local-owner',csrf:'csrf-A',actant:'local-human',client:'A',revision:0,show:true,onOpen:true,attention:0,threadProject:'first-project',threadConversation:'conversation-A',holdOpen:false};
function Frame({initial}) {
 const [config,setConfig]=useState({...defaults,...initial});
 const artifact=panelTask({assigneeId:config.human?'local-human':'morphz-agent',execution:config.execution,runRequested:config.runRequested,resultIds:config.resultIds},{id:config.id,revision:config.artifactRevision,projectId:config.project,...(config.nonTask?{content:{kind:'document',markdown:'Non-task'}}:{})});
 const state=initialWorkspace(panelTime);state.artifacts=[artifact,panelTask({}, {id:'produced-A',projectId:config.threadProject??config.project,title:'TEST 原成果'})];
 const view=config.view;
 const threadId=view?.runs?.find(r=>r.run===config.runRequested)?.record?.thread_id;
 const runtime={activity:{threads:threadId?[{id:threadId,projectId:config.threadProject,conversationId:config.threadConversation}]:[]},attention:{approvals:Array.from({length:config.attention},(_,i)=>({scope:{threadId},approval:{request:{approval_id:'approval-'+i}}}))}};
 const label=config.client;
 const client={boot:{centerId:config.center,principalId:config.principal,csrfToken:config.csrf,actantId:config.actant,capabilities:{runtime:config.capability},workspace:state,taskRuns:view?{[artifact.id]:view}:{},runtime},online:config.online,workspaceChangeRevision:config.revision,contentCatalog:[],
  taskRuntime:(id,control,options)=>request(control?'runtime-control':'runtime-read',control?[id,control]:[id,control??null],options?.signal,label,options?.isCurrent),
  taskResponses:(...args)=>request('responses',args,undefined,label),execute:operation=>request('execute',[operation],undefined,label),refresh:()=>request('refresh',[],undefined,label),
  executionSnapshot:(scope,signal)=>request('snapshot',[scope],signal,label),executionResult:(scope,id)=>request('result',[scope,id],undefined,label),controlExecution:operation=>request('inspection-control',[operation],undefined,label),approvalSubmitted:()=>false};
 api={set:value=>setConfig(c=>({...c,...value}))};last={config,artifact};
 return <div className="app without-collaboration" data-appearance="light" data-accent="cyan"><div className="workspace"><div className="workspace-body"><div className="primary-panel"><main><div className={config.compact?'task-row':'task-paper'}>{config.show&&<Panel artifact={artifact} state={state} client={client} compact={config.compact} runtimeObserved={config.observed} runtimeReadError={config.readError} onRespond={()=>events.push(['respond',label,artifact.id,artifact.revision])} onOpen={config.onOpen?id=>{events.push(['open',label,id,!!document.querySelector('dialog:modal')]);return config.holdOpen?new Promise(()=>{}):undefined;}:undefined}/>}</div></main></div></div></div></div>;
}
async function macro(){await new Promise(done=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();done();};channel.port2.postMessage(null);});}
async function settle(){await Promise.resolve();await macro();await macro();await macro();}
function report(){const section=document.querySelector('.task-run-panel'),primary=section?.querySelector('.task-primary-action'),trigger=section?.querySelector('.composer-more'),detail=section?.querySelector('details.task-execution-note'),dialog=document.querySelector('dialog.execution-dialog'),menu=document.querySelector('[aria-label="事项操作"]'),active=document.activeElement;return {
 config:last.config,requests:requests.map(r=>({index:r.index,kind:r.kind,args:r.args,client:r.client,settled:r.settled,aborted:r.signal?.aborted??false,current:r.current?r.current():null})),events:[...events],
 present:!!section,compact:section?.classList.contains('task-run-compact')??false,status:section?.querySelector('.task-run-status')?.textContent?.trim()??null,reason:section?.querySelector('.task-status-reason')?.textContent??null,error:section?.querySelector('[role="alert"]')?.textContent??null,loading:!!section?.querySelector('p.muted[role="status"]'),responses:[...document.querySelectorAll('.task-run-panel blockquote')].map(n=>({id:nodeId(n),body:n.querySelector('p')?.textContent,author:n.querySelector('small')?.textContent})),
 primary:primary?{label:primary.textContent.trim(),disabled:primary.disabled,title:primary.title}:null,buttons:[...section?.querySelectorAll('.task-run-actions > button')??[]].map(n=>({label:n.textContent.trim(),disabled:n.disabled})),menu:[...menu?.querySelectorAll('button')??[]].map(n=>({label:n.textContent.trim(),disabled:n.disabled})),menuOpen:menu?.matches(':popover-open')??false,detailOpen:detail?.open??false,detailButtons:[...detail?.querySelectorAll('button')??[]].map(n=>({label:n.textContent.trim(),disabled:n.disabled})),dependencies:[...section?.querySelectorAll('.task-dependency-actions button')??[]].map(n=>n.textContent),
 sameSection:section===initialNodes.section,sameTrigger:trigger===initialNodes.trigger,sameSvg:section?.querySelector('svg')===initialNodes.svg,sameDetails:detail===initialNodes.detail,modal:dialog?.matches(':modal')??false,dialogId:nodeId(dialog),active:active?.textContent?.trim()||active?.id||active?.tagName,resizeListeners:resizeListeners.size,observers:activeObservers.size,unmounted};}
function reset(initial={}){const previous=requests;events=[];requests=[];unmounted=false;nodeSerial=0;flushSync(()=>root.render(<StrictMode><Frame key={++serial} initial={initial}/></StrictMode>));for(const r of previous)if(!r.settled){r.settled=true;r.accept(undefined);}const section=document.querySelector('.task-run-panel');initialNodes={section,trigger:section?.querySelector('.composer-more'),svg:section?.querySelector('svg'),detail:section?.querySelector('details.task-execution-note')};}
Object.assign(window,{taskPanelFixture:{report,settle,reset,async run(name,value){if(name==='set')flushSync(()=>api.set(value));else if(name==='unmount'){flushSync(()=>root.unmount());unmounted=true;}else if(name==='settle'){const r=requests[value.index];if(!r||r.settled)throw Error('invalid request '+value.index);r.settled=true;events.push(['settled',r.kind,r.index]);if(value.errorKind==='nonerror')r.reject(value.error??'fixture rejection');else if(value.errorKind==='error')r.reject(Error(value.error??''));else r.accept(value.value);}else if(name==='sameFrameClicks'){const el=document.querySelector(value.selector);el.dispatchEvent(new MouseEvent('click',{bubbles:true}));el.dispatchEvent(new MouseEvent('click',{bubbles:true}));}else throw Error('unknown operation '+name);await settle();return report();},async cleanup(){flushSync(()=>root.unmount());unmounted=true;for(const r of requests)if(!r.settled){r.settled=true;r.accept(undefined);}await settle();return report();}}});
reset();
`;

type Request = {
  index: number;
  kind: string;
  args: unknown[];
  client: string;
  settled: boolean;
  aborted: boolean;
  current: boolean | null;
};
type Report = {
  config: Record<string, unknown>;
  requests: Request[];
  events: unknown[][];
  present: boolean;
  compact: boolean;
  status: string | null;
  reason: string | null;
  error: string | null;
  loading: boolean;
  responses: { id: number; body: string; author: string }[];
  primary: { label: string; disabled: boolean; title: string } | null;
  buttons: { label: string; disabled: boolean }[];
  menu: { label: string; disabled: boolean }[];
  menuOpen: boolean;
  detailOpen: boolean;
  detailButtons: { label: string; disabled: boolean }[];
  dependencies: string[];
  sameSection: boolean;
  sameTrigger: boolean;
  sameSvg: boolean;
  sameDetails: boolean;
  modal: boolean;
  dialogId: number | null;
  active: string;
  resizeListeners: number;
  observers: number;
  unmounted: boolean;
};
const ofKind = (report: Report, kind: string) =>
  report.requests.filter((r) => r.kind === kind);
const latest = (report: Report, kind: string) => {
  const request = ofKind(report, kind).at(-1);
  assert(request, "actual request: " + kind);
  return request;
};

test(
  "complete TaskRunPanel StrictMode observation, actions, menu and inspection",
  { timeout: 60000 },
  async (context) => {
    const archived = historicalSource();
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "mounted TaskRunPanel requires the test-entry prepared browser",
    );
    const cache = await mkdtemp(resolve(tmpdir(), "morphz-task-panel-vite-"));
    context.after(() => rm(cache, { recursive: true, force: true }));
    const historyId = resolve("apps/web/src/__task_panel_Git_d93326c0.tsx");
    const source = browserFixture.replace(
      "__TASK_PANEL_HISTORY__",
      archived ? historyId : "/src/TaskRunPanel.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "complete-task-panel-test-only",
          resolveId(id) {
            if (id === "/__task_panel.tsx") return "\0" + id;
            if (id === historyId && archived) return id;
          },
          async load(id) {
            if (id === "\0/__task_panel.tsx")
              return transformWithOxc(source, "task_panel.tsx");
            if (id === historyId && archived) return archived;
          },
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url?.split("?")[0] !== "/__task_panel") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"><style>main{min-width:640px}.task-paper{max-width:900px}body{margin:0}</style></head><body><button id="outside">Outside</button><div id="root"></div><script type="module" src="/__task_panel.tsx"></script></body></html>',
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
    const pages: Page[] = [],
      errors: string[] = [],
      business: string[] = [];
    let phase = "setup";
    context.after(() =>
      context.diagnostic(
        JSON.stringify({ migration, phase, errors, business }),
      ),
    );
    for (const lane of migration ? ["historical", "current"] : ["current"]) {
      const session = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      context.after(() => session.close());
      const page = await session.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (req) => {
        if (
          ["fetch", "xhr"].includes(req.resourceType()) &&
          !req.url().includes("/@vite/")
        )
          business.push(req.url());
      });
      await page.clock.install({ time: new Date("2026-10-04T00:00:00Z") });
      await page.clock.pauseAt(new Date("2026-10-04T00:00:00Z"));
      await page.goto(
        `http://127.0.0.1:${address.port}/__task_panel?lane=${lane}`,
      );
      await page.waitForFunction(
        () => !!Reflect.get(window, "taskPanelFixture"),
      );
      pages.push(page);
    }
    async function read() {
      const reports = await Promise.all(
        pages.map(
          (page) =>
            page.evaluate(async () => {
              const f = Reflect.get(window, "taskPanelFixture");
              await f.settle();
              return f.report();
            }) as Promise<Report>,
        ),
      );
      if (migration)
        assert.deepEqual(
          reports[1],
          reports[0],
          "strict complete original/current observation: " + phase,
        );
      return reports[0]!;
    }
    async function run(name: string, value?: unknown) {
      for (const page of pages)
        await page.evaluate(
          ({ name, value }) =>
            Reflect.get(window, "taskPanelFixture").run(name, value),
          { name, value },
        );
      return read();
    }
    async function reset(initial: Record<string, unknown> = {}) {
      for (const page of pages)
        await page.evaluate(
          (initial) => Reflect.get(window, "taskPanelFixture").reset(initial),
          initial,
        );
      return read();
    }
    async function settle(
      request: Request,
      value?: unknown,
      errorKind?: string,
      error?: string,
    ) {
      return run("settle", { index: request.index, value, errorKind, error });
    }
    async function click(selector: string) {
      for (const page of pages) await page.locator(selector).click();
      // Advance the real menu/modal animations; do not disable their CSS.
      for (const page of pages) await page.clock.runFor(220);
      return read();
    }
    async function clickText(text: string) {
      for (const page of pages)
        await page.getByRole("button", { name: text, exact: true }).click();
      for (const page of pages) await page.clock.runFor(220);
      return read();
    }
    async function menu() {
      await click(".composer-more");
      const report = await read();
      assert.equal(report.menuOpen, true, "actual native popover opened");
      return report;
    }
    async function closeMenu() {
      for (const page of pages) await page.keyboard.press("Escape");
      for (const page of pages) await page.clock.runFor(220);
      return read();
    }
    async function clock(ms: number) {
      for (const page of pages) await page.clock.runFor(ms);
      return read();
    }
    async function finish(report: Report, value: unknown = true) {
      const action = latest(
        report,
        ofKind(report, "execute").length ? "execute" : "runtime-control",
      );
      const refreshing = await settle(action, value);
      assert.equal(latest(refreshing, "refresh").settled, false);
      const done = await settle(latest(refreshing, "refresh"), true);
      assert(!done.primary?.disabled || done.config.capability === false);
      return done;
    }

    await context.test(
      "two actual observation modes, Human qualification and non-task null",
      async () => {
        phase = "observations";
        let r = await reset({ runRequested: 1 });
        const initialReads = ofKind(r, "runtime-read").length;
        assert(initialReads > 0, "actual observer starts a read");
        // StrictMode can close the first observer before its microtask starts
        // reading: that signal is not necessarily aborted. Prove retirement
        // through its real non-publication, not a fabricated signal property.
        for (const retired of ofKind(r, "runtime-read").slice(0, -1)) {
          r = await settle(retired, panelRuntime());
          assert(
            !r.status?.includes("正在执行"),
            "retired initial read cannot publish",
          );
        }
        assert.equal(ofKind(r, "responses").length, 0);
        const req = latest(r, "runtime-read");
        assert.deepEqual(req.args, ["task-A", null]);
        assert.equal(req.current, true);
        r = await settle(req, panelRuntime());
        assert.match(r.status!, /正在执行/);
        await clock(16000);
        assert.equal(
          ofKind(await read(), "runtime-read").length,
          initialReads,
          "no healthy poll",
        );
        for (const facts of [
          {
            compact: true,
            observed: true,
            runRequested: 1,
            readError: "parent batch failure",
          },
          { online: false, runRequested: 1 },
          { runRequested: 0 },
          { nonTask: true },
        ]) {
          r = await reset(facts);
          assert.equal(ofKind(r, "runtime-read").length, 0);
          if (facts.nonTask) assert.equal(r.present, false);
          if (facts.readError) assert.equal(r.error, facts.readError);
        }
        r = await reset({ runRequested: 1, capability: false });
        assert.equal(
          ofKind(r, "runtime-read").length > 0,
          true,
          "capability does not disable reading",
        );
        await settle(latest(r, "runtime-read"), panelRuntime());
        r = await reset({ human: true });
        assert.equal(r.loading, true);
        assert.equal(ofKind(r, "runtime-read").length, 0);
        assert.deepEqual(
          latest(r, "responses").args,
          ["task-A"],
          "Human read has no signal/options argument",
        );
        r = await settle(latest(r, "responses"), panelResponses());
        assert.equal(r.loading, false);
        assert.deepEqual(
          r.responses.map(({ body, author }) => ({ body, author })),
          [{ body: "原事项的真实处理结果", author: "我 · 回应 v3" }],
        );
        r = await reset({ human: true, compact: true });
        assert.equal(ofKind(r, "responses").length, 0);
        assert.equal(r.loading, false);
        assert.deepEqual(r.responses, []);
      },
    );

    await context.test(
      "all six scope fields retire stale queries and retain Boot fallback",
      async () => {
        phase = "six-scopes";
        for (const changed of [
          { center: "center-B" },
          { principal: "principal-B" },
          { csrf: "csrf-B" },
          { id: "task-B" },
          { artifactRevision: 4 },
          { runRequested: 2 },
        ]) {
          let r = await reset({
            runRequested: 1,
            view: panelRuntime({ threadState: "completed" }),
          });
          const old = latest(r, "runtime-read");
          r = await run("set", changed);
          assert.equal(r.requests[old.index]!.aborted, true);
          const next = latest(r, "runtime-read");
          assert.notEqual(next.index, old.index);
          assert(!r.status?.includes("正在执行"));
          r =
            changed.center || changed.csrf || changed.artifactRevision
              ? await settle(old, undefined, "error", "old scope failure")
              : await settle(old, panelRuntime());
          assert(!r.status?.includes("正在执行"), "old scope must never paint");
          assert.equal(
            r.error,
            null,
            "old scope rejection cannot publish feedback",
          );
          r = await settle(
            next,
            panelRuntime({ run: Number(changed.runRequested ?? 1) }),
          );
          assert.match(r.status!, /正在执行/);
        }
        let r = await reset({ human: true });
        const old = latest(r, "responses");
        r = await run("set", { artifactRevision: 4 });
        const next = latest(r, "responses");
        r = await settle(old, panelResponses());
        assert.equal(r.responses.length, 0);
        r = await settle(next, panelResponses("task-A", 4));
        assert.match(r.responses[0]!.author, /v4/);
        r = await run("set", { compact: true });
        const responseReads = ofKind(r, "responses").length;
        r = await run("set", { revision: 1 });
        assert.equal(
          ofKind(r, "responses").length,
          responseReads,
          "compact Human has no per-card response observer",
        );
        r = await run("set", { compact: false });
        assert.equal(ofKind(r, "responses").length, responseReads + 1);
        await settle(latest(r, "responses"), panelResponses("task-A", 4));
        r = await reset({ runRequested: 1 });
        const initialReads = ofKind(r, "runtime-read").length;
        const pending = latest(r, "runtime-read");
        r = await run("set", { online: false });
        assert.equal(r.requests[pending.index]!.aborted, true);
        await settle(pending, panelRuntime());
        r = await run("set", {
          online: true,
          observed: true,
          readError: "external failure",
        });
        assert.equal(ofKind(r, "runtime-read").length, initialReads);
        assert.equal(r.error, "external failure");
        r = await run("set", { observed: false });
        assert.equal(ofKind(r, "runtime-read").length, initialReads + 1);
        await settle(latest(r, "runtime-read"), panelRuntime());
      },
    );

    await context.test(
      "latest Client reads, dirty tail, schema failure and bounded retry cleanup",
      async () => {
        phase = "latest-retry";
        let r = await reset({ runRequested: 1 });
        const initialReads = ofKind(r, "runtime-read").length;
        const first = latest(r, "runtime-read");
        r = await run("set", { client: "B" });
        assert.equal(ofKind(r, "runtime-read").length, initialReads);
        r = await run("set", { revision: 1 });
        assert.equal(r.requests[first.index]!.aborted, true);
        r = await settle(first, panelRuntime({ threadState: "completed" }));
        assert(!r.status?.includes("执行结束"), "dirty prefix not published");
        const tail = latest(r, "runtime-read");
        assert.equal(tail.client, "B");
        r = await settle(tail, panelRuntime());
        assert.match(r.status!, /正在执行/);
        r = await run("set", { revision: 2 });
        r = await settle(latest(r, "runtime-read"), {
          runs: [{ run: "invalid" }],
        });
        assert(r.error, "original outer schema rejects invalid payload");
        const beforeRetry = ofKind(r, "runtime-read").length;
        const retry = await clock(1000);
        assert.equal(ofKind(retry, "runtime-read").length, beforeRetry + 1);
        r = await settle(
          latest(retry, "runtime-read"),
          undefined,
          "nonerror",
          "bad transport",
        );
        assert.equal(r.error, "无法读取执行状态。");
        for (const delay of [2000, 4000, 8000, 8000]) {
          r = await clock(delay);
          r = await settle(
            latest(r, "runtime-read"),
            undefined,
            "error",
            "retry failure",
          );
          assert.equal(r.error, "retry failure");
        }
        r = await clock(8000);
        r = await settle(latest(r, "runtime-read"), panelRuntime());
        assert.equal(r.error, null);
        const count = ofKind(r, "runtime-read").length;
        r = await clock(16000);
        assert.equal(ofKind(r, "runtime-read").length, count);
        r = await run("set", { revision: 3 });
        const active = latest(r, "runtime-read");
        r = await run("set", { show: false });
        assert.equal(r.requests[active.index]!.aborted, true);
        await settle(active, panelRuntime());
        await clock(32000);
        assert.equal(ofKind(await read(), "runtime-read").length, count + 1);
        r = await reset({ human: true });
        r = await settle(
          latest(r, "responses"),
          undefined,
          "nonerror",
          "response transport",
        );
        assert.equal(r.error, "无法读取事项回应。");
        r = await clock(1000);
        r = await settle(latest(r, "responses"), panelResponses());
        assert.equal(r.error, null);
        const responseCount = ofKind(r, "responses").length;
        r = await run("set", { client: "B" });
        assert.equal(ofKind(r, "responses").length, responseCount);
        r = await run("set", { revision: 1 });
        const prefix = latest(r, "responses");
        assert.equal(prefix.client, "B");
        assert.deepEqual(
          prefix.args,
          ["task-A"],
          "latest Human API still receives no signal/options",
        );
        r = await run("set", { client: "C", revision: 2 });
        r = await settle(
          prefix,
          panelResponses().map((item) => ({
            ...item,
            body: "obsolete prefix",
          })),
        );
        assert.equal(
          r.responses[0]!.body,
          "原事项的真实处理结果",
          "dirty Human prefix never paints",
        );
        const responseTail = latest(r, "responses");
        assert.equal(responseTail.client, "C");
        r = await settle(
          responseTail,
          panelResponses().map((item) => ({
            ...item,
            body: "最新 Human 回应",
          })),
        );
        assert.equal(r.responses[0]!.body, "最新 Human 回应");
      },
    );

    await context.test(
      "Human response uses original callback, identity, version and offline qualification",
      async () => {
        phase = "Human-actions";
        let r = await reset({ human: true, online: false });
        assert.equal(r.loading, false);
        r = await clickText("提交结果并完成");
        assert.deepEqual(r.events.at(-1), ["respond", "A", "task-A", 3]);
        assert.equal(ofKind(r, "execute").length, 0);
        for (const facts of [
          { actant: "someone-else" },
          { execution: "completed" },
          { execution: "cancelled" },
        ]) {
          await reset({ human: true, online: false, ...facts });
          for (const page of pages)
            assert.equal(
              await page
                .getByRole("button", { name: "提交结果并完成", exact: true })
                .count(),
              0,
            );
        }
        r = await reset({ human: true });
        r = await settle(latest(r, "responses"), panelResponses());
        const responseId = r.responses[0]!.id;
        r = await run("set", { revision: 1 });
        assert.equal(
          r.responses[0]!.id,
          responseId,
          "same response key preserves actual blockquote",
        );
        r = await settle(latest(r, "responses"), panelResponses());
        assert.equal(r.responses[0]!.id, responseId);
      },
    );

    await context.test(
      "complete primary priority and secondary reference-deduplication recipe",
      async () => {
        phase = "menu-recipes";
        const closed = panelRuntime({
          threadState: "completed",
          record: {
            revision: 4,
            thread_id: "thread-A",
            status: "completed",
            interval_seconds: null,
          },
        });
        const failed = panelRuntime({
          threadState: "failed",
          record: {
            revision: 4,
            thread_id: "thread-A",
            status: "completed",
            interval_seconds: null,
          },
        });
        const blockers = [
          {
            taskId: "dependency-A",
            title: "前置甲",
            assigneeName: "我",
            reason: "response" as const,
          },
          {
            taskId: "dependency-B",
            title: "前置乙",
            assigneeName: "Morphz",
            reason: "running" as const,
          },
        ];
        const cases: [Record<string, unknown>, string | null, string[]][] = [
          [
            {
              runRequested: 1,
              view: panelRuntime({}, { approvalCount: 1, blockers }),
              attention: 2,
            },
            "处理确认 (2)",
            [],
          ],
          [
            { runRequested: 1, view: panelRuntime(null, { blockers }) },
            "查看前置事项",
            [],
          ],
          [
            { runRequested: 1, view: panelRuntime(), resultIds: ["result-A"] },
            "查看进度",
            ["查看结果"],
          ],
          [
            { runRequested: 1, view: panelRuntime(null), compact: true },
            "查看事项",
            [],
          ],
          [{ runRequested: 1, view: panelRuntime(null) }, null, []],
          [
            { runRequested: 1, view: failed, resultIds: ["result-A"] },
            "重试",
            ["执行记录", "查看结果", "取消事项"],
          ],
          [
            { runRequested: 1, view: closed, resultIds: ["result-A"] },
            "查看结果",
            ["重新执行", "执行记录", "取消事项"],
          ],
          [
            { runRequested: 1, view: closed },
            "执行记录",
            ["重新执行", "取消事项"],
          ],
          [
            { execution: "waiting", compact: true },
            "查看原因",
            ["开始", "取消事项"],
          ],
          [{ execution: "waiting" }, null, ["开始", "取消事项"]],
          [
            { execution: "waiting", resultIds: ["result-A"] },
            "查看结果",
            ["开始", "取消事项"],
          ],
          [{}, "开始", ["取消事项"]],
          [{ execution: "completed" }, null, ["重新执行"]],
          [{ execution: "cancelled" }, null, ["重新执行"]],
          [
            {
              runRequested: 1,
              view: closed,
              resultIds: ["result-A"],
              onOpen: false,
            },
            "执行记录",
            ["重新执行", "取消事项"],
          ],
        ];
        for (const [seed, label, options] of cases) {
          let r = await reset({ observed: true, ...seed });
          assert.equal(r.primary?.label ?? null, label, JSON.stringify(seed));
          if (options.length) {
            r = await menu();
            assert.deepEqual(
              r.menu.map((x) => x.label),
              options,
            );
            await closeMenu();
          } else
            for (const page of pages)
              assert.equal(await page.locator(".composer-more").count(), 0);
        }
        let r = await reset({
          observed: true,
          runRequested: 1,
          view: panelRuntime(null, { blockers }),
        });
        assert.deepEqual(r.dependencies, ["前置甲", "前置乙"]);
        r = await clickText("查看前置事项");
        assert.deepEqual(r.events.at(-1), ["open", "A", "dependency-A", false]);
        r = await clickText("前置乙");
        assert.deepEqual(r.events.at(-1), ["open", "A", "dependency-B", false]);
        for (const [results, id] of [
          [["result-A"], "result-A"],
          [["result-A", "result-B"], "task-A"],
        ] as const) {
          await reset({
            observed: true,
            runRequested: 1,
            view: closed,
            resultIds: results,
          });
          r = await clickText("查看结果");
          assert.deepEqual(r.events.at(-1), ["open", "A", id, false]);
        }
        r = await reset({
          observed: true,
          online: false,
          runRequested: 1,
          view: closed,
          resultIds: ["result-A"],
        });
        assert.equal(r.primary?.disabled, false);
        r = await menu();
        assert.deepEqual(
          r.menu.map((x) => [x.label, x.disabled]),
          [
            ["重新执行", true],
            ["执行记录", false],
            ["取消事项", true],
          ],
        );
        await closeMenu();
      },
    );

    await context.test(
      "start and cancel actual DOM operations, same-frame pending and refresh ordering",
      async () => {
        phase = "start-cancel";
        let r = await reset();
        r = await run("sameFrameClicks", { selector: ".task-primary-action" });
        assert.equal(
          ofKind(r, "execute").length,
          1,
          "synchronous ref blocks second DOM event before commit",
        );
        assert.deepEqual(latest(r, "execute").args, [
          { type: "request-task-run", taskId: "task-A", expectedRevision: 3 },
        ]);
        assert.equal(r.primary?.disabled, true);
        assert.equal(ofKind(r, "refresh").length, 0);
        r = await settle(latest(r, "execute"), { ok: true });
        assert.equal(r.primary?.disabled, true, "awaited refresh holds busy");
        assert.equal(r.status, "待开始", "success not optimistic execution");
        r = await settle(latest(r, "refresh"), false);
        assert.equal(r.primary?.disabled, false);
        assert.equal(r.error, null);
        await menu();
        r = await clickText("取消事项");
        assert.deepEqual(latest(r, "execute").args, [
          { type: "cancel-task", taskId: "task-A", expectedRevision: 3 },
        ]);
        r = await settle(latest(r, "execute"), { ok: true });
        r = await settle(latest(r, "refresh"), true);
        assert.equal(
          r.status,
          "待开始",
          "cancel receipt does not forge task completion",
        );
        assert.equal(r.primary?.disabled, false);
      },
    );

    await context.test(
      "stop versus absent-run withdrawal retain exact run/control revisions",
      async () => {
        phase = "stop-withdraw";
        let r = await reset({
          observed: true,
          runRequested: 1,
          view: panelRuntime(),
        });
        r = await clickText("停止");
        assert.deepEqual(latest(r, "runtime-control").args, [
          "task-A",
          { run: 1, revision: 7, action: "stop" },
        ]);
        await finish(r, panelRuntime());
        r = await reset({
          observed: true,
          runRequested: 2,
          view: panelRuntime(null),
        });
        r = await clickText("撤回安排");
        assert.deepEqual(latest(r, "runtime-control").args, [
          "task-A",
          { run: 2, revision: 1, action: "stop" },
        ]);
        assert.equal(ofKind(r, "execute").length, 0);
        await finish(r, panelRuntime(null));
        r = await reset({
          observed: true,
          runRequested: 1,
          view: panelRuntime({ stopRequested: true, threadState: "completed" }),
        });
        assert.match(r.status!, /停止待确认/);
        assert(r.buttons.some((b) => b.label === "停止待确认" && b.disabled));
        assert.equal(ofKind(r, "runtime-control").length, 0);
      },
    );

    await context.test(
      "real details pause/resume, source watch and eligibility differences",
      async () => {
        phase = "pause-resume";
        for (const paused of [false, true]) {
          let r = await reset({
            observed: true,
            runRequested: 1,
            view: panelRuntime({
              paused,
              record: {
                revision: 4,
                thread_id: "thread-A",
                status: paused ? "paused" : "queued",
                interval_seconds: null,
              },
            }),
          });
          await click(".task-execution-note summary");
          r = await clickText(paused ? "恢复后续触发" : "暂停后续触发");
          assert.deepEqual(latest(r, "runtime-control").args, [
            "task-A",
            { run: 1, revision: 7, action: paused ? "resume" : "pause" },
          ]);
          r = await finish(r, panelRuntime());
          assert.equal(r.detailOpen, true);
          assert.equal(r.sameDetails, true);
        }
        for (const [fields, expected] of [
          [{ hasSourceWatch: true }, true],
          [{ sourceStopped: true, hasSourceWatch: true }, false],
          [{ hasSourceWatch: false }, false],
          [{ hasSourceWatch: true, stopRequested: true }, true],
        ] as const) {
          const r = await reset({
            observed: true,
            runRequested: 1,
            view: panelRuntime(fields),
          });
          assert.equal(
            r.detailButtons.some((b) => b.label === "暂停后续触发"),
            expected,
          );
        }
        let r = await reset({
          observed: true,
          online: false,
          runRequested: 1,
          view: panelRuntime({ hasSourceWatch: true }),
        });
        assert.equal(r.detailButtons[0]!.disabled, true);
      },
    );

    await context.test(
      "action/refresh failures, empty Error, false refresh and captured Client",
      async () => {
        phase = "perform-errors-capture";
        for (const where of ["action", "refresh"]) {
          for (const [errorKind, message, expected] of [
            ["error", "failure", "failure"],
            ["nonerror", "failure", "操作尚未确认，请核对状态。"],
            ["error", "", null],
          ] as const) {
            let r = await reset();
            r = await clickText("开始");
            const action = latest(r, "execute");
            if (where === "action")
              r = await settle(action, undefined, errorKind, message);
            else {
              r = await settle(action, { ok: true });
              r = await settle(
                latest(r, "refresh"),
                undefined,
                errorKind,
                message,
              );
            }
            assert.equal(r.error, expected);
            assert.equal(r.primary?.disabled, false);
            assert.equal(
              ofKind(r, "refresh").length,
              where === "action" ? 0 : 1,
            );
            r = await clickText("开始");
            assert.equal(r.error, null, "next action clears old feedback");
            r = await settle(latest(r, "execute"), { ok: true });
            await settle(latest(r, "refresh"), false);
          }
        }
        let r = await reset();
        r = await clickText("开始");
        const captured = latest(r, "execute");
        r = await run("set", { client: "B" });
        r = await settle(captured, { ok: true });
        assert.equal(latest(r, "refresh").client, "A");
        assert.equal(r.primary?.disabled, true);
        r = await settle(latest(r, "refresh"), true);
        assert.equal(r.primary?.disabled, false);
        r = await run("set", { runRequested: 1 });
        assert.equal(latest(r, "runtime-read").client, "B");
        await settle(latest(r, "runtime-read"), panelRuntime());
        r = await reset({
          observed: true,
          runRequested: 1,
          view: panelRuntime(
            { threadState: "failed", error: "run error" },
            { error: "view error" },
          ),
          readError: "external error",
        });
        assert.equal(r.error, "external error");
        r = await clickText("重试");
        r = await settle(
          latest(r, "execute"),
          undefined,
          "error",
          "action error",
        );
        assert.equal(r.error, "action error");
        r = await run("set", { readError: "" });
        assert.equal(r.error, "action error");
        r = await clickText("重试");
        r = await settle(latest(r, "execute"), { ok: true });
        r = await settle(latest(r, "refresh"), true);
        assert.equal(r.error, "view error");
      },
    );

    await context.test(
      "actual native popover keyboard/focus and stable section/SVG/details nodes",
      async () => {
        phase = "popover-identity";
        const closed = panelRuntime({
          threadState: "completed",
          record: {
            revision: 4,
            thread_id: "thread-A",
            status: "completed",
            interval_seconds: null,
          },
        });
        let r = await reset({
          observed: true,
          runRequested: 1,
          view: closed,
          resultIds: ["result-A"],
        });
        await click(".task-execution-note summary");
        r = await menu();
        assert(r.resizeListeners > 0);
        assert(r.observers > 0);
        for (const page of pages) {
          await page.keyboard.press("End");
          await page.keyboard.press("Home");
          await page.keyboard.press("ArrowDown");
        }
        r = await read();
        assert.match(r.active, /执行记录/);
        r = await closeMenu();
        assert.equal(r.menuOpen, false);
        assert.match(r.active, /更多操作|BUTTON/);
        assert.equal(r.resizeListeners, 0);
        assert.equal(r.observers, 0);
        r = await run("set", { revision: 1 });
        assert.equal(r.sameSection, true);
        assert.equal(r.sameTrigger, true);
        assert.equal(r.sameSvg, true);
        assert.equal(r.sameDetails, true);
        assert.equal(r.detailOpen, true);
        await menu();
        r = await clickText("取消事项");
        assert.equal(r.menuOpen, false);
        assert.deepEqual(latest(r, "execute").args, [
          { type: "cancel-task", taskId: "task-A", expectedRevision: 3 },
        ]);
        assert.match(r.active, /更多操作|BUTTON/);
        r = await settle(latest(r, "execute"), { ok: true });
        await settle(latest(r, "refresh"), true);
      },
    );

    await context.test(
      "full ExecutionDialog scope, result read/open, native close and observer cleanup",
      async () => {
        phase = "inspection";
        let r = await reset({
          observed: true,
          runRequested: 1,
          view: panelRuntime(),
          project: "local-worktable",
          threadProject: "first-project",
          threadConversation: "named-A",
          holdOpen: true,
        });
        r = await clickText("查看进度");
        assert.equal(r.modal, true);
        const snapshot = latest(r, "snapshot");
        assert.deepEqual(snapshot.args, [
          {
            projectId: "first-project",
            artifactId: "task-A",
            conversationId: "named-A",
            threadId: "thread-A",
            taskRun: true,
          },
        ]);
        assert.equal(snapshot.client, "A");
        assert.equal(ofKind(r, "inspection-control").length, 0);
        r = await settle(snapshot, panelSnapshot());
        await clickText("查看结果");
        r = await read();
        assert.deepEqual(latest(r, "result").args, [snapshot.args[0], "job-A"]);
        r = await settle(latest(r, "result"), {
          text: JSON.stringify({ ok: true, artifactId: "produced-A" }),
          available: true,
          truncated: false,
        });
        r = await clickText("TEST 原成果");
        assert.equal(
          r.modal,
          false,
          "close state settles without awaiting held external callback",
        );
        assert.deepEqual(r.events.at(-1), ["open", "A", "produced-A", true]);
        assert.equal(r.resizeListeners, 0);
        assert.equal(r.observers, 0);
        r = await reset({
          observed: true,
          runRequested: 1,
          view: panelRuntime({}, { approvalCount: 1 }),
          attention: 1,
          threadProject: undefined,
          threadConversation: undefined,
        });
        r = await clickText("处理确认 (1)");
        assert.equal(
          (latest(r, "snapshot").args[0] as { projectId: string }).projectId,
          "first-project",
        );
        r = await clickText("关闭执行记录");
        assert.equal(r.modal, false);
        assert.equal(latest(r, "snapshot").aborted, true);
        await settle(latest(r, "snapshot"), panelSnapshot());
        assert.equal(ofKind(await read(), "inspection-control").length, 0);
      },
    );

    if (migration)
      await context.test(
        "explicit old/new late actions, scope changes and unmount preserve original capture",
        async () => {
          phase = "migration-late-actions";
          let r = await reset();
          r = await clickText("开始");
          const action = latest(r, "execute");
          r = await run("set", {
            id: "task-B",
            artifactRevision: 4,
            csrf: "csrf-B",
            client: "B",
          });
          assert.equal(
            r.primary?.disabled,
            true,
            "no new scope-retirement unlock",
          );
          r = await settle(action, undefined, "error", "late A error");
          assert.equal(r.error, "late A error");
          assert.equal(r.primary?.disabled, false);
          r = await reset();
          r = await clickText("开始");
          const held = latest(r, "execute");
          r = await run("set", { show: false });
          r = await settle(held, { ok: true });
          assert.equal(
            latest(r, "refresh").client,
            "A",
            "old unmounted action still refreshes captured client",
          );
          r = await settle(latest(r, "refresh"), true);
          assert.equal(r.present, false);
          r = await reset({
            observed: true,
            runRequested: 1,
            view: panelRuntime(),
          });
          r = await clickText("查看进度");
          const id = r.dialogId;
          r = await run("set", { artifactRevision: 4, csrf: "csrf-B" });
          assert.equal(r.modal, true);
          assert.equal(
            r.dialogId,
            id,
            "same old inspection node: no new key/reset",
          );
          await clickText("关闭执行记录");
        },
      );
    phase = "final-cleanup";
    for (const page of pages) {
      const r = (await page.evaluate(() =>
        Reflect.get(window, "taskPanelFixture").cleanup(),
      )) as Report;
      assert.equal(r.present, false);
      assert.equal(r.modal, false);
      assert.equal(r.resizeListeners, 0);
      assert.equal(r.observers, 0);
      const count = r.requests.length;
      await page.clock.runFor(32000);
      assert.equal(
        (
          (await page.evaluate(() =>
            Reflect.get(window, "taskPanelFixture").report(),
          )) as Report
        ).requests.length,
        count,
      );
    }
    assert.deepEqual(errors, [], "no unhandled page errors");
    assert.deepEqual(business, [], "zero Host/Runtime/model requests");
  },
);
