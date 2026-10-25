import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";

// Real StrictMode and Conversation, consuming the actual history-head owner and
// main-exchange projection. Controlled timeline/stream facts only: no original
// profile, Host, Runtime, model request, input submission or storage is touched.
const source = `
import React,{StrictMode,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Conversation} from '/src/Conversation.tsx';
import {conversationMessages} from '/src/conversation-read.ts';
import {readHistoryHead} from '/src/data/conversation-history.ts';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
import {disconnectedRuntime} from '/@fs/${resolve("packages/core/src/conversation.ts")}';
const scope={projectId:'first-project',conversationId:'first-project'},attempt='TEST-ping-attempt';
const input={...scope,id:'TEST-ping-input',body:'TEST ping',createdAt:'2026-10-05T03:38:42.184955Z',author:{principalId:'human',actantId:'human'},targetActantId:'morphz-agent'};
const localFailures=[{...input,id:'TEST-old-local-failure',body:'TEST old local failure',createdAt:'2026-10-01T00:00:00Z'},
 {...input,id:'TEST-current-local-failure',body:'TEST current local failure',createdAt:'2026-10-05T03:39:00Z'}];
const base={...scope,id:'',inputId:input.id,rootId:'TEST-ping-root',artifactId:null,publicationKey:attempt,kind:'reply',text:'pong，我在。',createdAt:'2026-10-05T03:38:56.380581Z'};
const partial={...base,id:'stream:'+attempt,sequence:6888,incomplete:true,truncated:false};
const final={...base,id:'publication:'+attempt,sequence:6892};
const older={...base,id:'older-independent',publicationKey:undefined,inputId:'older-input',rootId:'older-root',text:'TEST older retained reply',createdAt:'2026-10-04T00:00:00Z'};
const page=messages=>({inputs:[input],scriptOutputs:[],nextCursor:null,runtime:{...disconnectedRuntime,configured:true,connected:true,messages}});
function Fixture(){
 const cache=useRef({scope,version:'v1',value:page([older,partial])}),positions=useRef(new Map());
 const [history,setHistory]=useState(cache.current.value),[live,setLive]=useState([]),[generation,setGeneration]=useState(0),[connected,setConnected]=useState(true),[oldestLoaded,setOldestLoaded]=useState('2026-10-04T00:00:00Z');
 const workspace=initialWorkspace(input.createdAt);workspace.inputs=[...localFailures,input];
 const messages=conversationMessages(workspace,scope.conversationId,history.runtime,live,false);
 const client={online:true,contentCatalog:[],contentVersionTitle:()=>null,approvalSubmitted:()=>false,olderHistoryCursor:oldestLoaded?{createdAt:oldestLoaded,id:'history-boundary'}:null,
 boot:{workspace,runtime:history.runtime,actantId:'human',outputs:[],scriptOutputs:[],localSavedInputIds:localFailures.map(row=>row.id),localInputSubmissions:Object.fromEntries(localFailures.map(row=>[row.id,{state:'failed',error:'TEST retained send failure'}]))},cancelInput:()=>{throw Error('no control request');},loadHistoryUntil:()=>{throw Error('no source request');}};
 window.publicationFixture={async run(action){
  if(action==='progress'||action==='progress-refresh'){
   const progress={...final,id:'progress:'+attempt,kind:'progress'};
   const head=readHistoryHead(async()=>page([progress]),scope,action==='progress'?'progress-1':'progress-2',cache.current);
   const value=head.kind==='cached'?head.value:await head.pending;
   cache.current={scope,version:action,value};flushSync(()=>{setHistory(value);setLive([partial,progress]);});
  }else if(action==='finish'||action==='refresh'||action==='error'||action==='retry-final'){
   const prefix=action==='retry-final'?{...partial,id:'stream:TEST-physical-retry',publicationKey:'TEST-physical-retry'}:partial;
   const terminal=action==='error'?{...final,sequence:6893,kind:'error',text:'TEST actual terminal error'}:action==='retry-final'?{...final,modelAttemptId:'TEST-physical-retry'}:final;
   const version=action==='finish'?'v2':action==='refresh'?'v3':action==='retry-final'?'v5':'v4';
   if(action==='retry-final')cache.current={scope,version:'retry-prefix',value:page([older,prefix])};
   const head=readHistoryHead(async()=>page([terminal]),scope,version,cache.current);
   const value=head.kind==='cached'?head.value:await head.pending;
   cache.current={scope,version,value};
   flushSync(()=>{setHistory(value);setLive([prefix,terminal]);});
  }else flushSync(()=>{
   if(action==='older-window')setOldestLoaded('2026-10-01T00:00:00Z');
   else if(action==='latest-window')setOldestLoaded('2026-10-04T00:00:00Z');
   if(action==='disconnect'){setConnected(false);setLive([{...partial,streaming:false}]);}
   else if(action==='reconnect'){setConnected(true);setLive([{...partial,streaming:true}]);}
   else if(action==='remount')setGeneration(value=>value+1);
   else if(action==='independent')setLive([{...partial,id:'stream:another-attempt',publicationKey:'another-attempt',inputId:'other-input',rootId:'other-root',streaming:false}]);
  });
 },report(){return {history:history.runtime.messages.map(message=>message.id),rendered:messages.map(message=>message.id),connected};}};
 return <Conversation key={generation} inputs={workspace.inputs} state={workspace} runtime={history.runtime} messages={messages} streamConnected={connected} seenReplies={{}} onRead={()=>{}} conversationId={scope.conversationId} onRetry={()=>{throw Error('no retry');}} client={client} onOpen={()=>{throw Error('no navigation');}} onInspect={()=>{throw Error('no inspector mutation');}} positions={positions.current} revealInputId={null}/>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
const installed = executable
  ? existsSync(executable)
  : existsSync(chromium.executablePath());

test(
  "actual Conversation replaces cached public output across final publication, reconnect, refresh and remount",
  { skip: !installed, timeout: 30000 },
  async (context) => {
    const cache = mkdtempSync(resolve(tmpdir(), "morphz-publications-vite-"));
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    context.after(async () => {
      try {
        await browser?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          rmSync(cache, { recursive: true, force: true });
        }
      }
    });
    server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      optimizeDeps: {
        // Discover the real component's dependencies before the virtual
        // fixture executes, rather than re-optimizing React after it mounts.
        entries: [resolve("apps/web/src/Conversation.tsx")],
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
        ],
      },
      plugins: [
        react(),
        {
          name: "isolated-publication-reconciliation",
          resolveId(id) {
            if (id === "/__publications.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__publications.tsx")
              return transformWithOxc(source, "publications.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__publications") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><style>.conversation{height:600px;overflow:auto}.conversation-message{padding:8px}</style></head><body><div id="root"></div><script type="module" src="/__publications.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    const page = await browser.newPage(),
      errors: string[] = [],
      writes: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
        writes.push(request.method() + " " + request.url());
    });
    await page.goto(`http://127.0.0.1:${address.port}/__publications`);
    const prefix = page.locator('[data-message-id="stream:TEST-ping-attempt"]');
    const terminal = page.locator(
      '[data-message-id="publication:TEST-ping-attempt"]',
    );
    await prefix.waitFor();
    assert.equal(
      await page.getByText("未完成的回复", { exact: true }).count(),
      0,
      "a partial reply does not add a standalone status row",
    );
    assert.equal(await prefix.count(), 1);
    assert.equal(await terminal.count(), 0);
    const run = async (action: string) => {
      await page.evaluate(
        (value) => Reflect.get(window, "publicationFixture").run(value),
        action,
      );
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      return page.evaluate(() =>
        Reflect.get(window, "publicationFixture").report(),
      ) as Promise<{
        history: string[];
        rendered: string[];
        connected: boolean;
      }>;
    };
    const oldFailure = page.locator(
      '[data-message-id="TEST-old-local-failure"]',
    );
    const currentFailure = page.locator(
      '[data-message-id="TEST-current-local-failure"]',
    );
    assert.equal(
      await oldFailure.count(),
      0,
      "old local failures do not bypass the latest page",
    );
    assert.equal(
      await currentFailure.count(),
      1,
      "a recent failed send remains immediately visible",
    );
    await run("older-window");
    assert.equal(
      await oldFailure.count(),
      1,
      "paging back reveals the same retained failure",
    );
    assert.deepEqual(
      await page
        .locator(".conversation-message")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-message-id")),
        ),
      [
        "TEST-old-local-failure",
        "older-independent",
        "TEST-ping-input",
        "stream:TEST-ping-attempt",
        "TEST-current-local-failure",
      ],
    );
    await run("latest-window");
    assert.equal(await oldFailure.count(), 0);
    for (const action of [
      "finish",
      "disconnect",
      "reconnect",
      "refresh",
      "remount",
    ]) {
      const report = await run(action);
      assert.deepEqual(report.history, [
        "older-independent",
        "publication:TEST-ping-attempt",
      ]);
      assert.deepEqual(report.rendered, report.history);
      assert.equal(await prefix.count(), 0, action);
      assert.equal(await terminal.count(), 1, action);
      assert.equal(
        await oldFailure.count(),
        0,
        action + " does not resurrect old local failures",
      );
      assert.equal(
        await currentFailure.count(),
        1,
        action + " preserves the recent failure",
      );
      assert.equal(
        await page.getByText("pong，我在。", { exact: true }).count(),
        1,
        action,
      );
      assert.equal(
        await page.locator('[data-message-id="older-independent"]').count(),
        1,
      );
    }
    await run("independent");
    assert.equal(
      await page.getByText("pong，我在。", { exact: true }).count(),
      2,
    );
    assert.equal(
      await page.locator('[data-message-id="stream:another-attempt"]').count(),
      1,
    );
    for (const action of ["retry-final", "remount"]) {
      const report = await run(action);
      assert.deepEqual(report.rendered, [
        "older-independent",
        "publication:TEST-ping-attempt",
      ]);
      assert.equal(
        await page
          .locator('[data-message-id="stream:TEST-physical-retry"]')
          .count(),
        0,
      );
      assert.equal(
        await page.getByText("pong，我在。", { exact: true }).count(),
        1,
      );
    }
    await run("error");
    assert.equal(await prefix.count(), 0);
    assert.equal(await terminal.count(), 1);
    assert.equal(
      await page
        .getByText("TEST actual terminal error", { exact: true })
        .count(),
      1,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    // This is the previously failing inspector-enabled main exchange: a
    // persisted progress handoff replaced the stream then vanished in render.
    await page.goto(`http://127.0.0.1:${address.port}/__publications`);
    await prefix.waitFor();
    for (const action of [
      "progress",
      "disconnect",
      "reconnect",
      "progress-refresh",
      "remount",
    ]) {
      const report = await run(action);
      assert.ok(report.rendered.includes("progress:TEST-ping-attempt"), action);
      assert.equal(
        await page
          .locator('[data-message-id="progress:TEST-ping-attempt"]')
          .count(),
        1,
        action,
      );
      assert.equal(
        await page.getByText("pong，我在。", { exact: true }).count(),
        1,
        action,
      );
      assert.equal(
        await prefix.count(),
        0,
        "durable progress replaces only its matching stream",
      );
      assert.equal(
        await page.getByText("未完成的回复", { exact: true }).count(),
        0,
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
  },
);
