import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
const base={...scope,id:'',inputId:input.id,rootId:'TEST-ping-root',artifactId:null,publicationKey:attempt,kind:'reply',text:'pong，我在。',createdAt:'2026-10-05T03:38:56.380581Z'};
const partial={...base,id:'stream:'+attempt,sequence:6888,incomplete:false,truncated:false};
const final={...base,id:'publication:'+attempt,sequence:6892};
const older={...base,id:'older-independent',publicationKey:undefined,inputId:'older-input',rootId:'older-root',text:'TEST older retained reply',createdAt:'2026-10-04T00:00:00Z'};
const page=messages=>({inputs:[input],scriptOutputs:[],nextCursor:null,runtime:{...disconnectedRuntime,configured:true,connected:true,messages}});
function Fixture(){
 const cache=useRef({scope,version:'v1',value:page([older,partial])}),positions=useRef(new Map());
 const [history,setHistory]=useState(cache.current.value),[live,setLive]=useState([]),[generation,setGeneration]=useState(0),[connected,setConnected]=useState(true);
 const workspace=initialWorkspace(input.createdAt);workspace.inputs=[input];
 const messages=conversationMessages(workspace,scope.conversationId,history.runtime,live,false);
 const client={online:true,contentCatalog:[],contentVersionTitle:()=>null,approvalSubmitted:()=>false,boot:{workspace,runtime:history.runtime,actantId:'human',outputs:[],scriptOutputs:[],localSavedInputIds:[],localInputSubmissions:{}},cancelInput:()=>{throw Error('no control request');},loadHistoryUntil:()=>{throw Error('no source request');}};
 window.publicationFixture={async run(action){
  if(action==='finish'||action==='refresh'||action==='error'){
   const terminal=action==='error'?{...final,sequence:6893,kind:'error',text:'TEST actual terminal error'}:final;
   const version=action==='finish'?'v2':action==='refresh'?'v3':'v4';
   const head=readHistoryHead(async()=>page([terminal]),scope,version,cache.current);
   const value=head.kind==='cached'?head.value:await head.pending;
   cache.current={scope,version,value};
   flushSync(()=>{setHistory(value);setLive([partial,terminal]);});
  }else flushSync(()=>{
   if(action==='disconnect'){setConnected(false);setLive([{...partial,streaming:false}]);}
   else if(action==='reconnect'){setConnected(true);setLive([{...partial,streaming:true}]);}
   else if(action==='remount')setGeneration(value=>value+1);
   else if(action==='independent')setLive([{...partial,id:'stream:another-attempt',publicationKey:'another-attempt',inputId:'other-input',rootId:'other-root',streaming:false}]);
  });
 },report(){return {history:history.runtime.messages.map(message=>message.id),rendered:messages.map(message=>message.id),connected};}};
 return <Conversation key={generation} inputs={[input]} state={workspace} runtime={history.runtime} messages={messages} streamConnected={connected} seenReplies={{}} onRead={()=>{}} conversationId={scope.conversationId} onRetry={()=>{throw Error('no retry');}} client={client} onOpen={()=>{throw Error('no navigation');}} positions={positions.current} revealInputId={null}/>;
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
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
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
    context.after(() => server.close());
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
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
  },
);
