import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import type { ExecutionSnapshot } from "../packages/core/src/execution.js";

// Real React/StrictMode, original observation and modal hooks; controlled Client
// promises only. No hook/import instrumentation, HTTP ACL, Runtime or OS proof.
const migration =
  process.env.MORPHZ_TEST_EXECUTION_INSPECTION_MIGRATION_EQUIVALENCE === "1";
const fixture = resolve(
  "tests/fixtures/execution-inspection-114960d1-behavior.tsx",
);
const source = `
import React,{StrictMode,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ExecutionDialog} from '/src/ExecutionDialog.tsx';import {useExecutionInspection} from '/src/features/execution/useExecutionInspection.ts';
import {FixedExecutionDialog,useFixedExecutionInspection} from '/@fs/${fixture}';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';import {jobSchema,executionSnapshotSchema} from '/@fs/${resolve("packages/core/src/execution.ts")}';
import '/src/styles.css';import '/src/ui.css';import '/src/ui/popup-surface.css';import '/src/workflow.css';import '/src/ui/dialog-surface.css';import '/src/visual-system.css';import '/src/execution-activity.css';import '/src/execution-thread-groups.css';
const params=new URL(location.href).searchParams,fixed=params.get('lane')==='fixed',surface=params.get('surface')??'controller',controlledClock=params.get('clock')==='1';
const hook=fixed?useFixedExecutionInspection:useExecutionInspection,Dialog=fixed?FixedExecutionDialog:ExecutionDialog;
const stamp='2026-10-04T00:00:00.000Z',events=[],requests=[],issued=[],captured={},renderTraces=[],ids=new WeakMap();let serial=0,api,last,controller=null,unmounted=false,observers=0;const resizeListeners=new Set();
const nodeId=node=>{if(!node)return null;if(!ids.has(node))ids.set(node,++serial);return ids.get(node);};
const originalShow=HTMLDialogElement.prototype.showModal,originalClose=HTMLDialogElement.prototype.close;
HTMLDialogElement.prototype.showModal=function(...args){events.push(['showModal',nodeId(this)]);return originalShow.apply(this,args);};
HTMLDialogElement.prototype.close=function(...args){events.push(['closeModal',nodeId(this)]);return originalClose.apply(this,args);};
const NativeResizeObserver=ResizeObserver;window.ResizeObserver=class extends NativeResizeObserver{constructor(callback){super(callback);observers++;events.push(['resize-observer-create']);}disconnect(){observers--;events.push(['resize-observer-disconnect']);return super.disconnect();}};
const originalAdd=window.addEventListener,originalRemove=window.removeEventListener;
window.addEventListener=function(type,callback,...args){if(type==='resize')resizeListeners.add(callback);return originalAdd.call(this,type,callback,...args);};
window.removeEventListener=function(type,callback,...args){if(type==='resize')resizeListeners.delete(callback);return originalRemove.call(this,type,callback,...args);};
function request(kind,args,signal,client){const index=requests.length;events.push([kind,index,client,...args]);return new Promise((resolve,reject)=>{requests.push({kind,index,args,signal,client,resolve,reject,settled:false});signal?.addEventListener('abort',()=>events.push(['abort',index]),{once:true});});}
const makeJob=value=>jobSchema.parse({id:'job-original',revision:2,session_id:'session-original',context_id:'context-original',thread_id:'thread-original',tool_name:'read',target_id:'local',request:{path:'original.md'},status:'running',result_event_id:'receipt-original',created_at:stamp,updated_at:stamp,...value});
const makeSnapshot=(jobs=[{}],extra={})=>executionSnapshotSchema.parse({jobs:jobs.map(makeJob),approvals:[],limit:100,...extra});
const publicView=value=>value?{snapshot:value.snapshot,error:value.error,busy:value.busy,notice:value.notice,result:value.result,producedId:value.producedId??null}:null;
function Probe({client,scope,embedded}){const dialog=useRef(null);const value=hook({client,scope,dialog,embedded});controller=value;renderTraces.push({scope:JSON.stringify([client.boot?.centerId,client.boot?.principalId,client.boot?.csrfToken,scope]),...publicView(value)});return <><output hidden id="controller-state">{JSON.stringify(publicView(value))}</output><dialog ref={dialog} className="create-dialog library-dialog execution-dialog" aria-label="受控执行controller"><button id="probe-close" onClick={()=>api.set({show:false})}>关闭</button></dialog></>;}
function Frame(){
 const[facts,setFacts]=useState({project:'original',conversation:'original',thread:'original',csrf:'csrf-original',principal:'human-original',client:0,online:true,revision:0,embedded:params.get('embedded')!=='0',show:true,presence:'boot',wrongProject:false});
 const scope={projectId:'project-'+facts.project,artifactId:null,conversationId:'conversation-'+facts.conversation,inputId:'input-original',threadId:'thread-'+facts.thread};
 const state=initialWorkspace(stamp),artifact={id:'artifact-original',projectId:facts.wrongProject?'wrong-project':scope.projectId,title:'原成果'};if(facts.presence==='boot')state.artifacts.push(artifact);
 const client={boot:{centerId:'center-original',principalId:facts.principal,csrfToken:facts.csrf,workspace:state},online:facts.online,workspaceChangeRevision:facts.revision,contentCatalog:facts.presence==='catalog'?[artifact]:[],executionSnapshot:(scope,signal)=>request('snapshot',[scope],signal,facts.client),executionResult:(scope,id)=>request('result',[scope,id],undefined,facts.client),controlExecution:operation=>request('control',[operation],undefined,facts.client),approvalSubmitted:()=>false};
 last={facts,scope,client};api={set:next=>setFacts(old=>({...old,...next}))};
 return <div className="app without-collaboration" data-appearance="light" data-accent="cyan"><aside className="sidebar" aria-hidden="true"/><div className="workspace"><header className="topbar"><button id="origin" onClick={()=>api.set({show:true,embedded:false})}>打开执行记录</button></header><div className="workspace-body"><div className="primary-panel"><main aria-label="主工作区">{facts.show&&(surface==='controller'?<Probe client={client} scope={scope} embedded={facts.embedded}/>:<Dialog client={client} scope={scope} embedded={facts.embedded} onClose={()=>{events.push(['onClose']);api.set({show:false});}} onOpen={id=>events.push(['onOpen',id])}/>)}</main></div></div></div></div>;
}
const origin=document.getElementById('external-origin');origin.focus();origin.setSelectionRange(3,8);
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Frame/></StrictMode>));
async function macro(){await new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);});}
async function settle(){await Promise.resolve();await macro();await macro();if(!controlledClock){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));}await macro();}
function snapshot(){const active=document.activeElement,dialog=document.querySelector('dialog');return{facts:last.facts,scope:last.scope,controller:publicView(controller),events:[...events],renderTraces:[...renderTraces],requests:requests.map(r=>({kind:r.kind,index:r.index,args:r.args,client:r.client,settled:r.settled,aborted:r.signal?.aborted??false})),issued:issued.map(({promise,...value})=>value),jobs:[...document.querySelectorAll('.execution-job')].map(node=>({id:nodeId(node),detailsId:nodeId(node.querySelector('details')),open:node.querySelector('details')?.open??false,html:node.outerHTML})),execution:document.querySelector('.execution-details,.execution-dialog')?.outerHTML??null,modal:dialog?.matches(':modal')??false,dialogId:nodeId(dialog),modalStyle:dialog?.getAttribute('style')??null,active:{id:active?.id??'',tag:active?.tagName??'',selection:active instanceof HTMLTextAreaElement?[active.selectionStart,active.selectionEnd]:null},resizeListeners:resizeListeners.size,observers,unmounted};}
function command(name,value={}){const method=value.captured?captured[name]:controller[name];const index=issued.length,entry={index,name,done:false};issued.push(entry);entry.promise=name==='control'?method(value.action,value.threadId):name==='readResult'?method(value.id):method();entry.promise.then(result=>{entry.done=true;entry.value=result===undefined?'void':result;events.push(['command-resolved',index,entry.value]);},error=>{entry.done=true;entry.error=String(error);});}
Reflect.set(window,'inspectionFixture',{snapshot,settle,makeSnapshot,async run(action,value){flushSync(()=>{if(action==='set')api.set(value);else if(action==='capture')captured[value]=controller[value];else if(['control','readResult','refresh'].includes(action))command(action,value);else if(action==='resolveSnapshots'){for(const r of requests.filter(r=>r.kind==='snapshot'&&!r.settled)){r.settled=true;r.resolve(value);}}else if(action==='settleRequest'){const r=requests[value.index];r.settled=true;events.push(['settle',r.index]);if(value.error)r.reject(value.nonError?value.error:new Error(value.error));else r.resolve(value.value);}else if(action==='unmount'){root.unmount();unmounted=true;controller=null;}});await settle();return snapshot();}});
`;

type Controller = {
  snapshot: ExecutionSnapshot | null;
  error: string;
  busy: string;
  notice: string;
  result: {
    id: string;
    text: string;
    available: boolean;
    truncated: boolean;
  } | null;
  producedId: string | null;
};
type Snapshot = {
  facts: {
    client: number;
    project: string;
    online: boolean;
    revision: number;
    show: boolean;
  };
  scope: Record<string, unknown>;
  controller: Controller | null;
  events: unknown[][];
  renderTraces: (Controller & { scope: string })[];
  requests: {
    kind: string;
    index: number;
    args: unknown[];
    client: number;
    settled: boolean;
    aborted: boolean;
  }[];
  issued: { index: number; name: string; done: boolean; value?: unknown }[];
  jobs: { id: number; detailsId: number; open: boolean; html: string }[];
  execution: string | null;
  modal: boolean;
  dialogId: number | null;
  modalStyle: string | null;
  active: { id: string; tag: string; selection: number[] | null };
  resizeListeners: number;
  observers: number;
  unmounted: boolean;
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
test(
  "actual execution inspection lifecycle and complete renderer preserve current contracts",
  {
    skip: existsSync(executable || chromium.executablePath())
      ? false
      : "set MORPHZ_TEST_BROWSER_EXECUTABLE or use the existing Playwright Chromium capability",
  },
  async (context) => {
    const cache = mkdtempSync(
      join(tmpdir(), "morphz-inspection-mounted-cache-"),
    );
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "isolated-execution-inspection",
          resolveId(id) {
            if (id === "/__inspection.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__inspection.tsx")
              return transformWithOxc(source, "inspection.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__inspection") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><textarea id="external-origin">original editable selection</textarea><div id="root"></div><script type="module" src="/__inspection.tsx"></script></body></html>',
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
    const url = `http://127.0.0.1:${address.port}/__inspection`,
      errors: string[] = [],
      businessReads: string[] = [];
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    let phase = "initial";
    context.after(() =>
      context.diagnostic(
        JSON.stringify({ migration, phase, errors, businessReads }),
      ),
    );
    async function pair(
      options: { surface?: string; clock?: boolean; embedded?: boolean } = {},
    ) {
      const pages: Page[] = [],
        contexts: BrowserContext[] = [];
      for (const lane of migration ? ["fixed", "actual"] : ["actual"]) {
        const isolated = await browser.newContext({
          viewport: { width: 1440, height: 900 },
        });
        contexts.push(isolated);
        const page = await isolated.newPage();
        page.setDefaultTimeout(10000);
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (
            ["fetch", "xhr"].includes(request.resourceType()) &&
            !request.url().includes("/@vite/")
          )
            businessReads.push(request.url());
        });
        if (options.clock) {
          await page.clock.install({ time: new Date("2026-10-04T00:00:00Z") });
          await page.clock.pauseAt(new Date("2026-10-04T00:00:00Z"));
        }
        const query = new URLSearchParams({
          lane,
          surface: options.surface ?? "controller",
          clock: options.clock ? "1" : "0",
          embedded: options.embedded === false ? "0" : "1",
        });
        await page.goto(url + "?" + query);
        await page.waitForFunction(
          () => !!Reflect.get(window, "inspectionFixture"),
        );
        await page.evaluate(() =>
          Reflect.get(window, "inspectionFixture").settle(),
        );
        pages.push(page);
      }
      context.after(() => Promise.all(contexts.map((item) => item.close())));
      async function read() {
        const values = await Promise.all(
          pages.map(
            (page) =>
              page.evaluate(() =>
                Reflect.get(window, "inspectionFixture").snapshot(),
              ) as Promise<Snapshot>,
          ),
        );
        if (migration)
          assert.deepEqual(
            values[1],
            values[0],
            "full bounded old/current actions, state, lifecycle and DOM: " +
              phase,
          );
        return values[0]!;
      }
      async function run(action: string, value?: unknown) {
        for (const page of pages)
          await page.evaluate(
            ({ action, value }) =>
              Reflect.get(window, "inspectionFixture").run(action, value),
            { action, value },
          );
        return read();
      }
      async function jobs(
        values: Record<string, unknown>[] = [{}],
        extra: Record<string, unknown> = {},
      ) {
        for (const page of pages)
          await page.evaluate(
            ({ values, extra }) => {
              const api = Reflect.get(window, "inspectionFixture");
              return api.run(
                "resolveSnapshots",
                api.makeSnapshot(values, extra),
              );
            },
            { values, extra },
          );
        return read();
      }
      async function click(selector: string) {
        for (const page of pages) {
          await page.locator(selector).click();
          await page.evaluate(() =>
            Reflect.get(window, "inspectionFixture").settle(),
          );
        }
        return read();
      }
      return {
        pages,
        read,
        run,
        jobs,
        click,
        async advance(ms: number) {
          for (const page of pages) {
            await page.clock.runFor(ms);
            await page.evaluate(() =>
              Reflect.get(window, "inspectionFixture").settle(),
            );
          }
          return read();
        },
        async close() {
          await Promise.all(contexts.map((item) => item.close()));
        },
      };
    }
    const view = (state: Snapshot) => {
      assert.ok(state.controller);
      return state.controller;
    };
    const pending = (state: Snapshot, kind: string) => {
      const result = state.requests.findLast(
        (item) => item.kind === kind && !item.settled,
      );
      assert.ok(result, "real held Client port " + kind);
      return result;
    };

    await context.test(
      "real StrictMode first read, held invalidation tail and disposable cleanup preserve modal-before-passive-read phase",
      async () => {
        phase = "phase-first-tail";
        const p = await pair({ embedded: false });
        let current = await p.read();
        assert.equal(current.modal, true);
        assert.equal(current.resizeListeners, 1);
        assert.equal(current.observers, 1);
        assert.ok(
          current.events.findIndex((event) => event[0] === "showModal") <
            current.events.findIndex((event) => event[0] === "snapshot"),
        );
        assert.equal(
          current.events.filter((event) => event[0] === "showModal").length,
          2,
          "actual StrictMode layout registration/cleanup/re-registration",
        );
        assert.equal(
          current.events.filter((event) => event[0] === "closeModal").length,
          1,
        );
        assert.deepEqual(view(current), {
          snapshot: null,
          error: "",
          busy: "",
          notice: "",
          result: null,
          producedId: null,
        });
        const initial = pending(current, "snapshot");
        current = await p.run("set", { revision: 1 });
        assert.equal(current.requests[initial.index]?.aborted, true);
        current = await p.jobs([
          { id: "STALE-must-not-publish", status: "failed" },
        ]);
        assert.equal(view(current).snapshot, null);
        assert.ok(
          current.requests.length > initial.index + 1,
          "held invalidation causes one real tail read",
        );
        current = await p.jobs([{ id: "tail-original", status: "succeeded" }]);
        assert.equal(view(current).snapshot?.jobs[0]?.id, "tail-original");
        assert.equal(
          current.renderTraces.some((trace) =>
            trace.snapshot?.jobs.some(
              (job) => job.id === "STALE-must-not-publish",
            ),
          ),
          false,
        );
        current = await p.run("set", { revision: 2 });
        const tail = pending(current, "snapshot");
        current = await p.run("unmount");
        assert.equal(current.requests[tail.index]?.aborted, true);
        assert.equal(current.resizeListeners, 0);
        assert.equal(current.observers, 0);
        assert.equal(current.modal, false);
        current = await p.run("settleRequest", {
          index: tail.index,
          value: { jobs: [], approvals: [], limit: 100 },
        });
        assert.equal(current.controller, null);
        assert.equal(current.unmounted, true);
        await p.close();
      },
    );

    await context.test(
      "real observer is healthy-idle and failed-only bounded backoff is 1/2/4/8 seconds with successful reset and cleanup",
      async () => {
        phase = "healthy-backoff";
        const p = await pair({ clock: true });
        await p.jobs();
        let current = await p.read();
        const healthy = current.requests.length;
        current = await p.advance(16000);
        assert.equal(
          current.requests.length,
          healthy,
          "healthy projection schedules no poll",
        );
        current = await p.run("refresh");
        let failed = pending(current, "snapshot");
        for (const delay of [1000, 2000, 4000, 8000, 8000]) {
          current = await p.run("settleRequest", {
            index: failed.index,
            error: "original retry error",
          });
          assert.equal(view(current).error, "original retry error");
          assert.equal(view(current).snapshot?.jobs.length, 1);
          const count = current.requests.length;
          current = await p.advance(delay - 1);
          assert.equal(current.requests.length, count);
          current = await p.advance(1);
          assert.equal(current.requests.length, count + 1);
          failed = pending(current, "snapshot");
        }
        current = await p.jobs([{ status: "succeeded" }]);
        assert.equal(view(current).error, "");
        const recovered = current.requests.length;
        assert.equal((await p.advance(16000)).requests.length, recovered);
        current = await p.run("refresh");
        current = await p.run("settleRequest", {
          index: pending(current, "snapshot").index,
          error: "original reset error",
          nonError: true,
        });
        assert.equal(view(current).error, "无法读取执行状态。");
        const reset = current.requests.length;
        assert.equal((await p.advance(999)).requests.length, reset);
        assert.equal((await p.advance(1)).requests.length, reset + 1);
        await p.jobs();
        current = await p.run("refresh");
        await p.run("settleRequest", {
          index: pending(current, "snapshot").index,
          error: "stop timer",
        });
        current = await p.run("unmount");
        const disposed = current.requests.length;
        assert.equal((await p.advance(32000)).requests.length, disposed);
        await p.close();
      },
    );

    await context.test(
      "same identity keeps state while captured commands use latest Client and captured scope; changed identity retires original UI",
      async () => {
        phase = "latest-captured";
        const p = await pair();
        await p.jobs();
        await p.run("capture", "readResult");
        await p.run("capture", "control");
        const scope = (await p.read()).scope;
        await p.run("set", { client: 1 });
        let current = await p.run("readResult", {
          captured: true,
          id: "original-result",
        });
        const result = pending(current, "result");
        assert.equal(result.client, 1);
        assert.deepEqual(result.args, [scope, "original-result"]);
        current = await p.run("settleRequest", {
          index: result.index,
          value: {
            text: "same-key retained result",
            available: true,
            truncated: false,
          },
        });
        assert.equal(view(current).result?.text, "same-key retained result");
        await p.run("set", { client: 2, project: "next", csrf: "csrf-next" });
        current = await p.run("control", {
          captured: true,
          action: { type: "cancel-job", jobId: "original-job", revision: 2 },
        });
        const control = pending(current, "control");
        assert.equal(control.client, 2);
        assert.deepEqual(control.args, [
          {
            scope,
            action: { type: "cancel-job", jobId: "original-job", revision: 2 },
          },
        ]);
        const count = current.requests.length;
        current = await p.run("settleRequest", {
          index: control.index,
          value: null,
        });
        assert.equal(view(current).notice, "");
        assert.equal(
          current.requests.length,
          count,
          "retired capture does not refresh latest scope",
        );
        assert.equal(
          current.renderTraces
            .filter((trace) => trace.scope.includes("csrf-next"))
            .every((trace) => trace.snapshot === null),
          true,
        );
        await p.jobs([{ id: "current-next" }]);
        current = await p.read();
        assert.equal(view(current).result, null);
        assert.equal(view(current).snapshot?.jobs[0]?.id, "current-next");
        await p.close();
      },
    );

    await context.test(
      "control and result retain separate IDs, thread override, failure words, guarded refresh order and Promise<void>",
      async () => {
        phase = "commands-order";
        const p = await pair();
        await p.jobs();
        const cases = [
          {
            action: { type: "cancel-job", jobId: "job-a", revision: 2 },
            busy: "job-a",
            threadId: "",
            notice: "已请求停止",
          },
          {
            action: { type: "cancel-thread", threadId: "child-a", revision: 2 },
            busy: "child-a",
            threadId: "child-a",
            notice: "已提交决定",
          },
          {
            action: {
              type: "allow-once",
              approvalId: "approval-a",
              fingerprint: "a".repeat(64),
            },
            busy: "approval-a",
            notice: "已提交决定",
          },
        ];
        for (const input of cases) {
          let current = await p.run("control", input);
          assert.equal(view(current).busy, input.busy);
          const call = pending(current, "control");
          const command = call.args[0] as {
            scope: Record<string, unknown>;
            action: unknown;
          };
          assert.equal(
            command.scope.threadId,
            input.threadId || current.scope.threadId,
          );
          assert.deepEqual(command.action, input.action);
          current = await p.run("settleRequest", {
            index: call.index,
            value: null,
          });
          assert.equal(view(current).notice, input.notice);
          assert.equal(view(current).busy, "");
          assert.equal(current.issued.at(-1)?.value, "void");
          assert.ok(current.issued.at(-1)?.done);
          assert.ok(
            pending(current, "snapshot"),
            "control resolves without awaiting held refresh",
          );
          await p.jobs();
        }
        for (const nonError of [false, true]) {
          let current = await p.run("control", cases[0]);
          current = await p.run("settleRequest", {
            index: pending(current, "control").index,
            error: "original control error",
            nonError,
          });
          assert.equal(
            view(current).notice,
            nonError
              ? "结果未确认，请核对最新状态。"
              : "original control error",
          );
          await p.jobs();
          current = await p.run("readResult", { id: "result-a" });
          const count = current.requests.length;
          assert.equal(view(current).busy, "result-a");
          current = await p.run("settleRequest", {
            index: pending(current, "result").index,
            error: "original result error",
            nonError,
          });
          assert.equal(
            view(current).notice,
            nonError ? "无法读取结果。" : "original result error",
          );
          assert.equal(view(current).busy, "");
          assert.equal(
            current.requests.length,
            count,
            "result read never refreshes",
          );
          assert.equal(current.issued.at(-1)?.value, "void");
        }
        await p.close();
      },
    );

    await context.test(
      "cross-scope/unmounted late commands retire UI, while original ABA and same-scope concurrent busy characteristics are only compared",
      async () => {
        phase = "retirement-and-characterization";
        const p = await pair();
        await p.jobs();
        let current = await p.run("readResult", { id: "late-result" });
        const result = pending(current, "result");
        await p.run("set", { project: "b" });
        await p.jobs();
        current = await p.run("settleRequest", {
          index: result.index,
          value: { text: "OLD SCOPE", available: true, truncated: false },
        });
        assert.equal(view(current).result, null);
        await p.run("set", { project: "original" });
        await p.jobs();
        current = await p.run("control", {
          action: { type: "cancel-job", jobId: "ABA-job", revision: 2 },
        });
        const aba = pending(current, "control");
        await p.run("set", { project: "b" });
        await p.jobs();
        await p.run("set", { project: "original" });
        await p.jobs();
        current = await p.run("settleRequest", {
          index: aba.index,
          value: null,
        });
        if (migration)
          assert.equal(
            view(current).notice,
            "已请求停止",
            "original equal-key ABA behavior, not a new policy",
          );
        await p.jobs();
        current = await p.run("control", {
          action: { type: "cancel-job", jobId: "first-job", revision: 2 },
        });
        const first = pending(current, "control");
        current = await p.run("control", {
          action: { type: "cancel-job", jobId: "second-job", revision: 2 },
        });
        const second = pending(current, "control");
        assert.equal(view(current).busy, "second-job");
        current = await p.run("settleRequest", {
          index: first.index,
          value: null,
        });
        if (migration) {
          assert.equal(
            view(current).busy,
            "",
            "original single busy slot is not a concurrency lock",
          );
          assert.equal(current.requests[second.index]?.settled, false);
        }
        await p.jobs();
        current = await p.run("unmount");
        const count = current.requests.length;
        current = await p.run("settleRequest", {
          index: second.index,
          error: "late after unmount",
        });
        assert.equal(current.controller, null);
        assert.equal(current.requests.length, count);
        await p.close();
      },
    );

    await context.test(
      "produced link derives from current render Boot/catalog same-project facts, not receipt availability or an extra read",
      async () => {
        phase = "produced-source";
        const p = await pair();
        await p.jobs();
        for (const text of [
          "",
          "plain output",
          "null",
          '{"ok":false,"artifactId":"artifact-original"}',
          '{"ok":true,"artifactId":17}',
        ]) {
          let current = await p.run("readResult", { id: "exact-job" });
          current = await p.run("settleRequest", {
            index: pending(current, "result").index,
            value: { text, available: true, truncated: false },
          });
          assert.equal(view(current).producedId, null);
          assert.equal(view(current).result?.id, "exact-job");
        }
        let current = await p.run("readResult", { id: "exact-job" });
        current = await p.run("settleRequest", {
          index: pending(current, "result").index,
          value: {
            text: '{"ok":true,"artifactId":"artifact-original"}',
            available: false,
            truncated: true,
          },
        });
        assert.equal(
          view(current).producedId,
          "artifact-original",
          "original receipt-link predicate does not add availability or revision authority",
        );
        const count = current.requests.length;
        current = await p.run("set", { presence: "none", client: 3 });
        assert.equal(view(current).producedId, null);
        current = await p.run("set", { presence: "catalog" });
        assert.equal(view(current).producedId, "artifact-original");
        current = await p.run("set", { wrongProject: true });
        assert.equal(view(current).producedId, null);
        current = await p.run("set", { presence: "boot", wrongProject: false });
        assert.equal(view(current).producedId, "artifact-original");
        assert.equal(
          current.requests.length,
          count,
          "render provenance changes do not query or refresh",
        );
        await p.close();
      },
    );

    await context.test(
      "complete actual renderer keeps native ref/modal selection, resize cleanup, same details node and open-before-close order",
      async () => {
        phase = "renderer-native";
        const p = await pair({ surface: "renderer", embedded: false });
        let current = await p.jobs();
        assert.equal(current.modal, true);
        const dialogId = current.dialogId;
        assert.ok(current.modalStyle?.includes("--modal-center"));
        current = await p.click(".execution-job details summary");
        const before = current.jobs[0]!;
        assert.equal(before.open, true);
        for (const page of p.pages)
          await page.locator(".execution-job details summary").focus();
        await p.run("set", { revision: 1 });
        current = await p.jobs([
          {
            status: "succeeded",
            annotation: { intent: "同一Job更新", result: "实际回执" },
          },
        ]);
        assert.equal(current.jobs[0]?.detailsId, before.detailsId);
        assert.equal(current.jobs[0]?.open, true);
        assert.equal(current.active.tag, "SUMMARY");
        assert.equal(current.dialogId, dialogId);
        for (const page of p.pages)
          await page.setViewportSize({ width: 1024, height: 768 });
        for (const page of p.pages)
          await page.evaluate(() =>
            Reflect.get(window, "inspectionFixture").settle(),
          );
        current = await p.read();
        assert.notEqual(current.modalStyle, null);
        current = await p.click('.execution-job button:has-text("查看结果")');
        current = await p.run("settleRequest", {
          index: pending(current, "result").index,
          value: {
            text: '{"ok":true,"artifactId":"artifact-original"}',
            available: true,
            truncated: true,
          },
        });
        current = await p.click('.execution-result button:has-text("原成果")');
        assert.deepEqual(
          current.events
            .filter((event) => event[0] === "onOpen" || event[0] === "onClose")
            .slice(-2),
          [["onOpen", "artifact-original"], ["onClose"]],
        );
        assert.equal(current.modal, false);
        assert.equal(current.active.id, "external-origin");
        assert.deepEqual(current.active.selection, [3, 8]);
        assert.equal(current.resizeListeners, 0);
        assert.equal(current.observers, 0);
        await p.close();
      },
    );

    await context.test(
      "same-key offline retains actual rows/result but existing approval and child-stop gates stay distinct from Job-stop",
      async () => {
        phase = "offline-renderer";
        const p = await pair({ surface: "renderer" });
        const stamp = "2026-10-04T00:00:00.000Z";
        const root = {
          id: "thread-original",
          sessionId: "session-original",
          contextId: "context-original",
          rootId: "root-original",
          parentThreadId: null,
          title: "原根",
          phase: "running",
          lifecycle: "open",
          revision: 2,
          updatedAt: stamp,
        };
        const child = {
          ...root,
          id: "thread-child",
          parentThreadId: root.id,
          title: "原子任务",
        };
        await p.jobs([{}], {
          threads: [root, child],
          approvals: [
            {
              requested_at: stamp,
              fingerprint: "a".repeat(64),
              request: {
                approval_id: "approval-original",
                session_id: "session-original",
                context_id: "context-original",
                thread_id: root.id,
                justification: "原单次审批",
                action: { type: "read" },
                requested: {},
              },
            },
          ],
        });
        let current = await p.click(
          '.execution-job button:has-text("查看结果")',
        );
        current = await p.run("settleRequest", {
          index: pending(current, "result").index,
          value: {
            text: "retained original result",
            available: true,
            truncated: false,
          },
        });
        const count = current.requests.length;
        current = await p.run("set", { online: false, revision: 1 });
        assert.equal(current.jobs.length, 1);
        assert.ok(current.execution?.includes("retained original result"));
        await p.run("set", { revision: 2 });
        assert.equal((await p.read()).requests.length, count);
        for (const page of p.pages) {
          assert.equal(
            await page
              .locator('.execution-approval button:has-text("仅允许这一次")')
              .isDisabled(),
            true,
          );
          assert.equal(
            await page.locator('button:has-text("停止此子任务")').isDisabled(),
            true,
          );
          if (migration)
            assert.equal(
              await page
                .locator('button:has-text("停止此项执行")')
                .isDisabled(),
              false,
              "original Job-stop predicate has no online term",
            );
        }
        await p.close();
        assert.deepEqual(errors, []);
        assert.deepEqual(businessReads, []);
      },
    );
  },
);
