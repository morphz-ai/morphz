import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { chromium, type Page, type BrowserContext } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";
import { initialWorkspace } from "../packages/core/src/model.js";
import { FixedToolMessage } from "./fixtures/job-presentation-08215636-behavior.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";

// Real components and observation/modal hooks, controlled Client ports only.
// No App, Runtime, HTTP/SQLite authorization, native OS or pixel evidence.
const migration =
  process.env.MORPHZ_TEST_JOB_PRESENTATION_MIGRATION_EQUIVALENCE === "1";
const fixture = resolve(
  "tests/fixtures/job-presentation-08215636-behavior.tsx",
);
const source = `
import React,{StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ToolMessage} from '/src/Conversation.tsx';import {ExecutionDialog} from '/src/ExecutionDialog.tsx';
import {FixedToolMessage,FixedExecutionDialog} from '/@fs/${fixture}';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';import {jobSchema} from '/@fs/${resolve("packages/core/src/execution.ts")}';
${currentAppCSSImports()}
const fixed=new URL(location.href).searchParams.get('lane')==='fixed',Tool=fixed?FixedToolMessage:ToolMessage,Dialog=fixed?FixedExecutionDialog:ExecutionDialog;
const stamp='2026-10-04T00:00:00.000Z',state=initialWorkspace(stamp),events=[],requests=[],ids=new WeakMap();let serial=0,api,last,unmounted=false;
state.artifacts.push({id:'artifact-original',projectId:'project-original',title:'原成果'});
const nodeId=node=>{if(!node)return null;if(!ids.has(node))ids.set(node,++serial);return ids.get(node);};
const makeJob=value=>jobSchema.parse({id:'job-original',revision:2,session_id:'session-original',context_id:'context-original',thread_id:'thread-original',tool_name:'read',target_id:'local',request:{path:'original.md'},status:'running',created_at:stamp,updated_at:stamp,...value});
const makeSnapshot=jobs=>({jobs:jobs.map(makeJob),approvals:[],limit:100});
function request(kind,args,signal){const index=requests.length;events.push([kind,index,...args]);return new Promise((resolve,reject)=>{requests.push({kind,index,args,signal,resolve,reject,settled:false});signal?.addEventListener('abort',()=>events.push(['abort',index]),{once:true});});}
const originalMessage={id:'message-original',projectId:'project-original',conversationId:'conversation-original',artifactId:null,inputId:'input-original',rootId:'root-original',threadId:'thread-original',createdAt:stamp,text:'',kind:'tool',streaming:true,tool:{name:'read',arguments:'{"path":"original.md"}',status:'generating'}};
function Frame(){
 const[facts,setFacts]=useState({scope:'original',csrf:'csrf-original',online:true,revision:0,show:true,embedded:true,message:originalMessage,second:null});
 const scope={projectId:'project-'+facts.scope,artifactId:null,conversationId:'conversation-'+facts.scope,inputId:'input-'+facts.scope,threadId:'thread-'+facts.scope};
 const client={boot:{centerId:'center-original',principalId:'human-original',csrfToken:facts.csrf,workspace:state},online:facts.online,workspaceChangeRevision:facts.revision,contentCatalog:[],executionSnapshot:(...args)=>request('snapshot',[args[0]],args[1]),executionResult:(...args)=>request('result',args),controlExecution:operation=>request('control',[operation]),approvalSubmitted:()=>false};
 last={facts,scope};api={set:value=>setFacts(old=>({...old,...value})),tool:value=>setFacts(old=>({...old,message:{...old.message,tool:{...old.message.tool,...value}}})),swap:()=>setFacts(old=>({...old,message:{...old.message,id:'message-second'},second:old.message}))};
 return <div className="app without-collaboration" data-appearance="light" data-accent="cyan"><aside className="sidebar" aria-hidden="true"/><div className="workspace"><header className="topbar"><button id="origin" onClick={()=>api.set({show:true,embedded:false})}>打开执行记录</button><button id="outside">原画布按钮</button></header><div className="workspace-body"><div className="primary-panel"><main aria-label="主工作区"><div className="conversation-replies">{[facts.message,facts.second].filter(Boolean).map(message=><article key={message.id} data-message-id={message.id}><Tool message={message} state={state}/></article>)}</div>{facts.show&&<Dialog client={client} scope={scope} embedded={facts.embedded} onClose={()=>{events.push(['close']);api.set({show:false});}} onOpen={id=>events.push(['open',id])}/>}</main></div></div></div></div>;
}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Frame/></StrictMode>));
async function settle(){await Promise.resolve();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
function snapshot(){const active=document.activeElement;return{facts:last.facts,scope:last.scope,events:[...events],requests:requests.map(r=>({kind:r.kind,index:r.index,args:r.args,settled:r.settled,aborted:r.signal?.aborted??false})),tools:[...document.querySelectorAll('article[data-message-id]')].map(n=>({html:n.outerHTML,id:nodeId(n),detailsId:nodeId(n.querySelector('details')),open:n.querySelector('details')?.open??false})),jobs:[...document.querySelectorAll('.execution-job')].map(n=>({html:n.outerHTML,id:nodeId(n),detailsId:nodeId(n.querySelector('details')),open:n.querySelector('details')?.open??false})),execution:document.querySelector('.execution-details,.execution-dialog')?.outerHTML??null,active:{id:active?.id??'',text:active?.textContent??'',tag:active?.tagName??''},notice:document.querySelector('.execution-notice')?.textContent??null,error:document.querySelector('[role=alert]')?.textContent??null,modal:document.querySelector('dialog')?.matches(':modal')??false,unmounted};}
Reflect.set(window,'jobFixture',{snapshot,settle,makeSnapshot,async run(action,value){flushSync(()=>{if(action==='set')api.set(value);else if(action==='tool')api.tool(value);else if(action==='swap')api.swap();else if(action==='resolveSnapshots'){for(const r of requests.filter(r=>r.kind==='snapshot'&&!r.settled)){r.settled=true;r.resolve(value);}}else if(action==='settleRequest'){const r=requests[value.index];r.settled=true;if(value.error)r.reject(new Error(value.error));else r.resolve(value.value);}else if(action==='unmount'){root.unmount();unmounted=true;}});await settle();return snapshot();}});
`;
type Snapshot = {
  facts: { online: boolean; show: boolean; revision: number; scope: string };
  scope: Record<string, unknown>;
  events: unknown[][];
  requests: {
    kind: string;
    index: number;
    args: unknown[];
    settled: boolean;
    aborted: boolean;
  }[];
  tools: { html: string; id: number; detailsId: number; open: boolean }[];
  jobs: { html: string; id: number; detailsId: number; open: boolean }[];
  execution: string | null;
  active: { id: string; text: string; tag: string };
  notice: string | null;
  error: string | null;
  modal: boolean;
  unmounted: boolean;
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
test(
  "real Job renderers keep current ToolMessage and complete ExecutionDialog contracts",
  {
    skip: existsSync(executable || chromium.executablePath())
      ? false
      : "set MORPHZ_TEST_BROWSER_EXECUTABLE or install existing Playwright Chromium capability",
  },
  async (context) => {
    const cache = mkdtempSync(join(tmpdir(), "morphz-job-mounted-cache-"));
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "isolated-job-presentation",
          resolveId(id) {
            if (id === "/__job.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__job.tsx")
              return transformWithOxc(source, "job.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__job") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__job.tsx"></script></body></html>',
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
    const url = `http://127.0.0.1:${address.port}/__job`;
    const errors: string[] = [],
      businessReads: string[] = [];
    let phase = "SSR";
    context.after(() =>
      context.diagnostic(
        JSON.stringify({ migration, phase, errors, businessReads }),
      ),
    );
    await context.test(
      "actual ToolMessage SSR keeps all live states, original full details DOM and fallback bytes",
      async () => {
        const module = await server.ssrLoadModule("/src/Conversation.tsx");
        const state = initialWorkspace("2026-10-04T00:00:00Z");
        for (const [status, label] of Object.entries({
          generating: "正在生成参数",
          pending: "参数已生成",
          running: "执行中",
          queued: "排队中",
          waiting_approval: "等待审批",
          approval_required: "等待审批",
          success: "已完成",
          succeeded: "已完成",
          completed: "已完成",
          failed: "失败",
          error: "失败",
          cancelled: "已取消",
          lost: "lost",
          "future-phase": "future-phase",
        }))
          for (const args of [
            '{"path":"original.md","secret":"original-secret"}',
            '{"unfinished":',
            "",
          ]) {
            const message = {
              id: "original",
              tool: {
                name: "read",
                status,
                arguments: args,
                result: "",
                truncated: true,
              },
            } as LiveMessage;
            const actual = renderToStaticMarkup(
              createElement(module.ToolMessage, { message, state }),
            );
            if (migration)
              assert.equal(
                actual,
                renderToStaticMarkup(
                  createElement(FixedToolMessage, { message, state }),
                ),
              );
            assert.ok(actual.includes(`data-tool-status="${status}"`));
            assert.ok(
              actual.includes(`<span class="tool-state">${label}</span>`),
            );
            const displayedName = actual
              .match(/<span class="tool-name"[^>]*>([\s\S]*?)<\/span>/)?.[1]
              ?.replace(/<!--[\s\S]*?-->/g, "");
            assert.equal(
              displayedName,
              args.startsWith('{"path":') ? "读取文件 · original.md" : "read",
            );
            assert.ok(actual.includes("无文本输出"));
            assert.ok(actual.includes("内容已截断"));
            assert.equal(actual.match(/class="tool-details"/g)?.length, 1);
          }
      },
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    async function pair() {
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
        await page.goto(url + "?lane=" + lane);
        await page.waitForFunction(() => !!Reflect.get(window, "jobFixture"));
        await page.evaluate(() => Reflect.get(window, "jobFixture").settle());
        pages.push(page);
      }
      context.after(() => Promise.all(contexts.map((item) => item.close())));
      async function read() {
        const values = await Promise.all(
          pages.map(
            (page) =>
              page.evaluate(() =>
                Reflect.get(window, "jobFixture").snapshot(),
              ) as Promise<Snapshot>,
          ),
        );
        if (migration)
          assert.deepEqual(
            values[1],
            values[0],
            "complete old/new bounded DOM/action/identity parity: " + phase,
          );
        return values[0]!;
      }
      async function run(action: string, value?: unknown) {
        for (const page of pages)
          await page.evaluate(
            ({ action, value }) =>
              Reflect.get(window, "jobFixture").run(action, value),
            { action, value },
          );
        return read();
      }
      async function jobs(values: Record<string, unknown>[]) {
        for (const page of pages)
          await page.evaluate((values) => {
            const api = Reflect.get(window, "jobFixture");
            return api.run("resolveSnapshots", api.makeSnapshot(values));
          }, values);
        return read();
      }
      async function click(selector: string) {
        for (const page of pages) {
          await page.locator(selector).click();
          await page.evaluate(() => Reflect.get(window, "jobFixture").settle());
        }
        return read();
      }
      return {
        pages,
        read,
        run,
        jobs,
        click,
        async close() {
          await Promise.all(contexts.map((item) => item.close()));
        },
      };
    }
    const pending = (s: Snapshot, kind: string) => {
      const result = s.requests.findLast(
        (item) => item.kind === kind && !item.settled,
      );
      assert.ok(result, "real controlled call is pending: " + kind);
      return result;
    };

    await context.test(
      "same message ID and keyed reorder retain real details open state and keyboard focus",
      async () => {
        phase = "live-details-identity";
        const p = await pair();
        await p.jobs([]);
        const before = await p.click(".message-tool summary");
        assert.equal(before.tools[0]?.open, true);
        for (const page of p.pages)
          await page.locator(".message-tool summary").focus();
        const after = await p.run("tool", {
          status: "succeeded",
          arguments: '{"path":"updated-original.md"}',
          result: '{"ok":false,"error":"original domain failure"}',
        });
        assert.equal(after.tools[0]?.detailsId, before.tools[0]?.detailsId);
        assert.equal(after.tools[0]?.open, true);
        assert.equal(after.active.tag, "SUMMARY");
        assert.ok(
          after.tools[0]?.html.includes('data-tool-status="succeeded"'),
        );
        assert.ok(after.tools[0]?.html.includes("original domain failure"));
        const reordered = await p.run("swap");
        assert.equal(reordered.tools[1]?.detailsId, before.tools[0]?.detailsId);
        assert.equal(reordered.tools[1]?.open, true);
        await p.close();
      },
    );
    await context.test(
      "complete snapshot renderer preserves seven states, stop priority, typed annotation and same Job technical details",
      async () => {
        phase = "snapshot-job-render";
        const p = await pair();
        const statuses = [
          "queued",
          "waiting_approval",
          "running",
          "succeeded",
          "failed",
          "cancelled",
          "lost",
        ];
        await p.jobs(
          statuses.map((status, i) => ({
            id: "job-" + status,
            status,
            cancel_requested_at: "original-stop",
            created_at: `2026-10-04T00:00:0${i}.000Z`,
            annotation: {
              intent: "原意图 " + status,
              result: "原结果 " + status,
            },
            result_event_id: i % 2 ? "receipt-original" : null,
            error: status === "failed" ? "原步骤失败" : null,
          })),
        );
        const before = await p.click(
          '[data-job-id="job-running"] details summary',
        );
        for (const page of p.pages)
          await page
            .locator('[data-job-id="job-running"] details summary')
            .focus();
        for (const page of p.pages) {
          assert.equal(await page.locator(".execution-job").count(), 7);
          assert.equal(
            await page.locator(".job-status:has-text('正在停止')").count(),
            3,
          );
          assert.equal(
            await page
              .locator('[data-job-id="job-lost"] .job-status')
              .textContent(),
            "需核对结果",
          );
          assert.equal(
            await page
              .locator('[data-job-id="job-failed"] .delivery-error')
              .textContent(),
            "原步骤失败",
          );
        }
        await p.run("set", { revision: 1 });
        const after = await p.jobs([
          {
            id: "job-running",
            status: "succeeded",
            annotation: { intent: "已更新的原意图", result: "原确认回执" },
            result_event_id: "receipt-original",
          },
        ]);
        const previous = before.jobs.find((item) =>
          item.html.includes('data-job-id="job-running"'),
        )!;
        assert.equal(after.jobs[0]?.detailsId, previous.detailsId);
        assert.equal(after.jobs[0]?.open, true);
        assert.equal(after.active.tag, "SUMMARY");
        assert.ok(after.jobs[0]?.html.includes("原确认回执"));
        await p.close();
      },
    );
    await context.test(
      "complete result read preserves domain envelope, unavailable/truncated output and open-before-close receipt order",
      async () => {
        phase = "result-read";
        const p = await pair();
        await p.jobs([
          { status: "succeeded", result_event_id: "receipt-original" },
        ]);
        let current = await p.click(
          '.execution-job button:has-text("查看结果")',
        );
        current = await p.run("settleRequest", {
          index: pending(current, "result").index,
          value: {
            text: '{"ok":false,"error":"原冲突"}',
            available: true,
            truncated: true,
          },
        });
        assert.ok(current.execution?.includes("原冲突"));
        assert.ok(current.execution?.includes("64,000"));
        current = await p.click('.execution-job button:has-text("查看结果")');
        current = await p.run("settleRequest", {
          index: pending(current, "result").index,
          value: { text: "", available: false, truncated: false },
        });
        assert.ok(current.execution?.includes("尚无最终结果。"));
        current = await p.click('.execution-job button:has-text("查看结果")');
        current = await p.run("settleRequest", {
          index: pending(current, "result").index,
          value: {
            text: '{"ok":true,"artifactId":"artifact-original"}',
            available: true,
            truncated: false,
          },
        });
        current = await p.click('.execution-result button:has-text("原成果")');
        assert.deepEqual(current.events.slice(-2), [
          ["open", "artifact-original"],
          ["close"],
        ]);
        assert.equal(current.facts.show, false);
        await p.close();
      },
    );
    await context.test(
      "scope/identity transitions and unmount retire late snapshots, result/control UI and old refresh continuation",
      async () => {
        phase = "scope-and-late";
        const p = await pair();
        await p.jobs([{ result_event_id: "receipt-original" }]);
        let current = await p.click(
          '.execution-job button:has-text("查看结果")',
        );
        const result = pending(current, "result");
        current = await p.run("set", { scope: "next", csrf: "csrf-next" });
        await p.jobs([{ id: "job-next" }]);
        current = await p.run("settleRequest", {
          index: result.index,
          value: {
            text: "OLD RESULT MUST NOT PUBLISH",
            available: true,
            truncated: false,
          },
        });
        assert.equal(
          current.execution?.includes("OLD RESULT MUST NOT PUBLISH"),
          false,
        );
        current = await p.click(
          '.execution-job button:has-text("停止此项执行")',
        );
        const control = pending(current, "control");
        await p.run("set", { scope: "third" });
        await p.jobs([{ id: "job-third" }]);
        const count = (await p.read()).requests.length;
        current = await p.run("settleRequest", {
          index: control.index,
          error: "OLD CONTROL ERROR",
        });
        assert.equal(current.notice, null);
        assert.equal(
          current.requests.length,
          count,
          "retired command must not refresh the newer scope",
        );
        await p.run("set", { revision: 2 });
        current = await p.read();
        const late = pending(current, "snapshot");
        await p.run("unmount");
        current = await p.run("settleRequest", {
          index: late.index,
          value: { jobs: [], approvals: [], limit: 100 },
        });
        assert.equal(current.execution, null);
        assert.equal(current.unmounted, true);
        await p.close();
      },
    );
    await context.test(
      "read errors retain original rows but disable stop; retry/online and real modal focus lifecycle remain separate",
      async () => {
        phase = "read-error-and-modal";
        const p = await pair();
        await p.jobs([{ status: "running" }]);
        let current = await p.run("set", { revision: 1 });
        current = await p.run("settleRequest", {
          index: pending(current, "snapshot").index,
          error: "原读取失败",
        });
        assert.equal(current.error, "原读取失败");
        assert.equal(current.jobs.length, 1);
        for (const page of p.pages)
          assert.equal(
            await page
              .locator('.execution-job button:has-text("停止此项执行")')
              .isDisabled(),
            true,
          );
        await p.click('[aria-label="刷新执行记录"]');
        await p.jobs([{ status: "running" }]);
        current = await p.read();
        assert.equal(current.error, null);
        await p.run("set", { online: false, revision: 2 });
        const before = (await p.read()).requests.length;
        await p.run("set", { revision: 3 });
        assert.equal(
          (await p.read()).requests.length,
          before,
          "offline revision is not permission to query",
        );
        await p.run("set", { show: false, online: true });
        await p.click("#origin");
        await p.jobs([]);
        current = await p.read();
        assert.equal(current.modal, true);
        await p.click('[aria-label="关闭执行记录"]');
        current = await p.read();
        assert.equal(current.active.id, "origin");
        assert.equal(current.modal, false);
        await p.close();
        assert.deepEqual(errors, []);
        assert.deepEqual(businessReads, []);
      },
    );
  },
);
