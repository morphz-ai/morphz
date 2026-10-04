import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";

// Real React/StrictMode and actual Conversation, with in-memory presentation
// facts and real browser storage/focus/scroll/dialogs. No Host, Runtime, model,
// input submission or original App is accessed. Dimensions only create a
// deterministic scrollable mount; this is not a visual-equivalence fixture.
const source = `
import React, {StrictMode,useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Conversation} from '/src/Conversation.tsx';
import {scopedStorage,storageScope} from '/src/local-preferences.ts';
import {projectConversationReadScope,replyReceipts,hasUnreadReplies} from '/src/conversation-read.ts';
import {useExchangeReadReceiptState,useExchangeReadAcknowledgement,useExchangeReadReceiptCommit} from '/src/host/use-exchange-read-receipts.ts';
import {fixedAppRead,useFixedReceiptState,useFixedReceiptAcknowledgement,useFixedReceiptCommit} from '/@fs/${resolve("tests/fixtures/exchange-read-receipts-4ce98b64.ts")}';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
import {disconnectedRuntime} from '/@fs/${resolve("packages/core/src/conversation.ts")}';
const now='2026-10-04T00:00:00.000Z', lanes=new Map(), closed=new Map(); let root;
function input(id,artifactId,conversationId='conversation-A') {return {id,projectId:'first-project',conversationId,artifactId,artifactRevision:1,body:id,createdAt:now,author:{principalId:'human',actantId:'human'}};}
const inputs=[input('input-A','object-A'),input('input-B','object-B')];
function message(id,text,inputId='input-A',publicationKey) {return {id,text,inputId,publicationKey,kind:'reply',projectId:'first-project',conversationId:'conversation-A',artifactId:null,rootId:null,createdAt:now};}
const messages=Array.from({length:16},(_,i)=>message('known-'+i,'TEST known reply '+i+' '.repeat(3)+'body '.repeat(10),i%2?'input-B':'input-A'));
const outside=message('outside','TEST outside snapshot','outside-input'); outside.conversationId='conversation-B';
const outputs=[{commandId:'outside-output',inputId:'outside-input',projectId:'first-project',artifactId:'outside-object',revision:2,createdAt:now}];
const scriptOutputs=[{commandId:'outside-script',inputId:'outside-input',projectId:'first-project',productionId:'production',kind:'review',productionTitle:'Production',itemKind:'episode',itemId:'episode',reviewId:'review',title:'Episode',revision:1,createdAt:now}];
function Lane({mode,account}) {
 const [storage]=useState(()=>scopedStorage('center-'+account+':principal-'+account+':'+mode));
 const [shown,setShown]=useState(false),[currentMessages,setMessages]=useState(messages),[focus,setFocus]=useState(null),[tick,setTick]=useState(0),[toolbar,setToolbar]=useState(null);
 const events=useRef([]), fail=useRef(false), positions=useRef(new Map());
 const workspace=initialWorkspace(now); workspace.inputs=inputs;
 const runtime={...disconnectedRuntime,messages:currentMessages};
 const boot={workspace,runtime:{...runtime,messages:[...currentMessages,outside]},outputs,scriptOutputs,localSavedInputIds:[],localInputSubmissions:{},actantId:'human'};
 const initializerClient={get boot(){events.current.push(['bootstrap']);return boot;}};
 const readLocal=(key,fallback)=>{events.current.push(['stored',key]);return storage.readLocal(key,fallback);};
 const writeLocal=(key,value)=>{events.current.push(['persist',key,value]);if(fail.current)throw Error('fixture storage failure');storage.writeLocal(key,value);};
 const setNotice=message=>events.current.push(['notice',message]);
 const state=mode==='fixed'?useFixedReceiptState({readLocal,client:initializerClient}):useExchangeReadReceiptState({readStored:()=>readLocal('conversation-read-receipts',null),readBootstrap:()=>({messages:initializerClient.boot.runtime.messages,outputs:initializerClient.boot.outputs,scriptOutputs:initializerClient.boot.scriptOutputs})});
 const conversationFocus=focus?{artifactId:focus}:{};
 let receipts,version,unread;
 if(mode==='fixed') {const read=fixedAppRead({inputs,replies:currentMessages,client:{boot},conversationFocus,seenReplies:state.seenReplies});receipts=read.receipts;version=read.receiptVersion;unread=read.unseenReply;}
 else {
  const full=projectConversationReadScope({inputs,messages:currentMessages,outputs,scriptOutputs,scope:{focus:{},messageArray:'preserve-unfocused'}});
  const badge=projectConversationReadScope({inputs,messages:currentMessages,outputs,scriptOutputs,scope:{focus:conversationFocus,messageArray:'preserve-unfocused'}});
  receipts=replyReceipts(full.messages,full.outputs,full.scriptOutputs);version=JSON.stringify(receipts);unread=hasUnreadReplies(state.seenReplies,replyReceipts(badge.messages,badge.outputs,badge.scriptOutputs));
 }
 const acknowledge=mode==='fixed'?useFixedReceiptAcknowledgement(state):useExchangeReadAcknowledgement(state);
 const original=useRef({acknowledge,setter:state.setSeenReplies});
 if(mode==='fixed')useFixedReceiptCommit({...state,receipts,receiptVersion:version,writeLocal,setNotice});
 else useExchangeReadReceiptCommit(state,{receipts,version,persist:seen=>writeLocal('conversation-read-receipts',seen),onNotice:setNotice});
 const onRead=useCallback(receipts=>{events.current.push(['visible-read',receipts]);acknowledge(receipts);},[acknowledge]);
 const client={boot:{...boot,runtime},online:true,contentCatalog:[],contentVersionTitle:()=>null,cancelInput:()=>{throw Error('no control requests');},loadHistoryUntil:()=>{throw Error('no history requests');}};
 const report=()=>({account,seen:state.seenReplies,unread,shown,focus,events:events.current,stable:{callback:original.current.acknowledge===acknowledge,setter:original.current.setter===state.setSeenReplies},saved:storage.readLocal('conversation-read-receipts',null)});
 lanes.set(mode,{report,run(action,value){if(action==='show')setShown(value);else if(action==='message')setMessages(messages=>[...messages,message(value.id,value.text,value.inputId,value.publicationKey)]);else if(action==='replace'){const{id,nextId,...changes}=value;setMessages(messages=>messages.map(m=>m.id===id?{...m,...changes,id:nextId??m.id}:m));}else if(action==='focus')setFocus(value);else if(action==='tick')setTick(t=>t+1);else if(action==='fail')fail.current=value;}});
 useEffect(()=>()=>{closed.set(mode,events.current);},[mode]);
 return <article className="test-lane" id={'lane-'+mode}>
  <header ref={setToolbar}/><button type="button" id={'focus-'+mode}>Focus {mode}</button><output data-unread={unread} data-tick={tick}/>
  {shown&&<Conversation inputs={inputs} state={workspace} runtime={runtime} messages={currentMessages} streamConnected={false} seenReplies={state.seenReplies} onRead={onRead} conversationId="conversation-A" onRetry={()=>{throw Error('no retry');}} client={client} onOpen={()=>{throw Error('no object open');}} positions={positions.current} revealInputId={null} focusedArtifactId={focus??undefined} toolbarTarget={toolbar}/>}
 </article>;
}
function Fixture(){const[account,setAccount]=useState('A'),[mounted,setMounted]=useState(true);root={setAccount,setMounted};return <><dialog style={{position:'fixed',top:'auto',left:'auto',bottom:0,right:0,margin:0}}><button type="button">Dialog focus</button></dialog><main>{mounted&&<><Lane key={'fixed:'+account} mode="fixed" account={account}/><Lane key={'production:'+account} mode="production" account={account}/></>}</main></>;}
Object.assign(window,{receiptFixture:{
 run(action,value){flushSync(()=>{if(action==='account')root.setAccount(value);else if(action==='mount')root.setMounted(value);else if(action==='globalScope')storageScope('unrelated-center','unrelated-principal');else for(const lane of lanes.values())lane.run(action,value);});},
 report(){return {fixed:lanes.get('fixed').report(),production:lanes.get('production').report(),closed:Object.fromEntries(closed),storage:Object.fromEntries(Object.keys(localStorage).filter(k=>k.includes('conversation-read-receipts')).map(k=>[k,localStorage.getItem(k)]))};},
 seedLegacy(account){for(const mode of ['fixed','production'])localStorage.setItem('morphzwork:center-'+account+':principal-'+account+':'+mode+':conversation-read-receipts',JSON.stringify({'reply:legacy-B':'reply:8:1'}));},
}});
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;

type Lane = {
  account: string;
  seen: Record<string, string>;
  unread: boolean;
  shown: boolean;
  focus: string | null;
  events: unknown[][];
  stable: { callback: boolean; setter: boolean };
  saved: Record<string, string>;
};
type Report = {
  fixed: Lane;
  production: Lane;
  closed: Record<string, unknown[][]>;
  storage: Record<string, string>;
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
const installed = executable
  ? existsSync(executable)
  : existsSync(chromium.executablePath());
async function mountReceiptFixture(context: TestContext) {
  const server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "isolated-exchange-read-lifecycle",
        resolveId(id) {
          if (id === "/__read-receipts.tsx") return "\0" + id;
        },
        async load(id) {
          if (id === "\0/__read-receipts.tsx")
            return transformWithOxc(source, "read-receipts.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__read-receipts") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                '<!doctype html><html><head><style>main{display:flex;gap:20px}.test-lane{width:45%;min-width:0}.conversation{height:180px;overflow:auto}.conversation-message{padding:12px}.conversation-return{position:sticky;bottom:0}</style></head><body><div id="root"></div><script type="module" src="/__read-receipts.tsx"></script></body></html>',
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
  const browserContext = await browser.newContext();
  context.after(() => browserContext.close());
  const page = await browserContext.newPage(),
    errors: string[] = [],
    queries: string[] = [];
  let phase = "initial module mount",
    complete = false;
  context.after(() => {
    if (!complete)
      context.diagnostic(JSON.stringify({ phase, errors, queries }));
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      ["fetch", "xhr"].includes(request.resourceType()) &&
      !request.url().includes("/@vite/")
    )
      queries.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${address.port}/__read-receipts`);
  await page.waitForSelector("#lane-production");
  const report = () =>
    page.evaluate(() =>
      Reflect.get(window, "receiptFixture").report(),
    ) as Promise<Report>;
  const parity = (value: Report) => {
    assert.deepEqual(value.production, value.fixed);
    assert.deepEqual(value.production.stable, {
      callback: true,
      setter: true,
    });
  };
  const settled = async () => {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const value = await report();
    parity(value);
    return value;
  };
  const run = async (action: string, value: unknown = null) => {
    phase = action + ":" + JSON.stringify(value);
    await page.evaluate(
      ({ action, value }) =>
        Reflect.get(window, "receiptFixture").run(action, value),
      { action, value },
    );
    return settled();
  };
  return {
    page,
    browserContext,
    errors,
    queries,
    report,
    settled,
    run,
    setPhase(value: string) {
      phase = value;
    },
    finish() {
      complete = true;
    },
  };
}
test(
  "real StrictMode receipts preserve full bootstrap, captured storage, stable callbacks and actual Conversation visible-read ordering",
  { skip: !installed, timeout: 30000 },
  async (context) => {
    // This primary mounted contract uses actual DOM focus/dialog/scroll and
    // Playwright's ordinary headless page focus. It does not claim native
    // foreground/background activation, which has a separate opt-in contract.
    const { page, errors, queries, report, settled, run, finish } =
      await mountReceiptFixture(context);
    let current = await settled();
    assert.equal(current.production.unread, false);
    assert(current.production.seen["reply:outside"]);
    assert.equal(
      current.production.seen["output:outside-output"],
      "outside-object:2",
    );
    assert(
      Object.keys(current.production.seen).some((key) =>
        key.includes("outside-script"),
      ),
    );
    assert.deepEqual(current.production.saved, current.production.seen);
    const initialBootReads = current.production.events.filter(
      (event) => event[0] === "bootstrap",
    ).length;
    const initialWrites = current.production.events.filter(
      (event) => event[0] === "persist",
    ).length;
    assert.equal(initialBootReads, 6);
    await run("globalScope");
    current = await run("tick");
    assert.equal(
      current.production.events.filter((event) => event[0] === "bootstrap")
        .length,
      initialBootReads,
    );
    assert.equal(
      current.production.events.filter((event) => event[0] === "persist")
        .length,
      initialWrites,
    );
    await page.locator("#focus-production").focus();
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    current = await run("message", {
      id: "stream",
      text: "TEST new stream",
      publicationKey: "publication",
    });
    assert.equal(current.production.unread, true);
    assert.equal(current.production.seen["reply:stream"], undefined);
    current = await run("show", true);
    assert.equal(current.production.unread, false);
    assert(current.production.seen["publication:publication"]);
    assert(
      current.production.events.some((event) => event[0] === "visible-read"),
    );
    await page
      .locator("dialog")
      .evaluate((element) => (element as HTMLDialogElement).showModal());
    current = await run("replace", {
      id: "stream",
      text: "TEST stream continued",
    });
    assert.equal(current.production.unread, true);
    const blocked = current.production.seen["reply:stream"];
    await page
      .locator("dialog")
      .evaluate((element) => (element as HTMLDialogElement).close());
    await page.locator("#focus-production").focus();
    current = await settled();
    assert.equal(current.production.unread, false);
    assert.notEqual(current.production.seen["reply:stream"], blocked);
    const readingCount = current.production.events.filter(
      (event) => event[0] === "visible-read",
    ).length;
    // Publication reconciliation adds the durable alias without making prose
    // unread. It must work even when the actual history is unmounted.
    await run("show", false);
    current = await run("replace", { id: "stream", nextId: "durable" });
    assert.equal(current.production.unread, false);
    assert.equal(
      current.production.seen["reply:durable"],
      current.production.seen["publication:publication"],
    );
    assert.equal(
      current.production.events.filter((event) => event[0] === "visible-read")
        .length,
      readingCount,
    );
    await run("show", true);
    await page.locator(".conversation").evaluateAll((elements) =>
      elements.forEach((element) => {
        element.scrollTop = 0;
      }),
    );
    await page.waitForSelector("#lane-production .conversation-return");
    current = await settled();
    current = await run("message", { id: "away", text: "TEST away unread" });
    assert.equal(current.production.unread, true);
    assert.equal(current.production.seen["reply:away"], undefined);
    // Both lanes share native focusin events. A real non-modal dialog applies
    // the existing read gate while sequentially clicking their latest buttons,
    // so the first lane does not get an extra read from the second lane's focus.
    await page
      .locator("dialog")
      .evaluate((element) => (element as HTMLDialogElement).show());
    await page.locator("#lane-fixed .conversation-return button").click();
    await page.locator("#lane-production .conversation-return button").click();
    current = await settled();
    assert.equal(current.production.unread, true);
    await page
      .locator("dialog")
      .evaluate((element) => (element as HTMLDialogElement).close());
    await page.locator("#focus-production").focus();
    current = await settled();
    assert.equal(current.production.unread, false);
    await run("focus", "object-A");
    await page
      .locator("dialog")
      .evaluate((element) => (element as HTMLDialogElement).show());
    await page.locator("#lane-fixed .conversation-scope").click();
    await page.locator("#lane-production .conversation-scope").click();
    await page.waitForSelector(
      '#lane-production .human-message[data-input-id="input-B"]',
    );
    await page
      .locator("dialog")
      .evaluate((element) => (element as HTMLDialogElement).close());
    await page.locator("#focus-production").focus();
    current = await settled();
    await run("focus", "object-B");
    await page.waitForSelector(
      '#lane-production .human-message[data-input-id="input-B"]',
    );
    assert.equal(
      await page
        .locator('#lane-production .human-message[data-input-id="input-A"]')
        .count(),
      0,
    );
    await run("show", false);
    const writesBefore = current.production.events.filter(
      (event) => event[0] === "persist",
    ).length;
    current = await run("message", {
      id: "hidden",
      text: "TEST unmounted reader",
      inputId: "input-B",
    });
    await page.locator("#focus-production").focus();
    current = await settled();
    assert.equal(current.production.unread, true);
    assert.equal(current.production.seen["reply:hidden"], undefined);
    assert.equal(
      current.production.events.filter((event) => event[0] === "persist")
        .length,
      writesBefore,
    );
    await run("fail", true);
    current = await run("show", true);
    assert.equal(current.production.unread, false);
    const notices = current.production.events.flatMap((event, index) =>
      event[0] === "notice" ? [index] : [],
    );
    assert(notices.length > 0);
    for (const index of notices) {
      assert.deepEqual(current.production.events[index], [
        "notice",
        "已读状态暂时无法保存，重开后可能再次提示。",
      ]);
      // Later native scroll/focus may repeat an idempotent visible read. The
      // owned synchronous contract is failed persist -> exact notice, not that
      // no later browser event can exist in the shared event ledger.
      assert.deepEqual(current.production.events[index - 1]!.slice(0, 2), [
        "persist",
        "conversation-read-receipts",
      ]);
    }
    assert.notDeepEqual(current.production.saved, current.production.seen);
    await page.evaluate(() =>
      Reflect.get(window, "receiptFixture").seedLegacy("B"),
    );
    const oldStorage = (await report()).storage;
    current = await run("account", "B");
    assert.deepEqual(current.production.seen, {
      "reply:legacy-B": "reply:8:1",
    });
    assert.equal(
      current.production.events.some((event) => event[0] === "bootstrap"),
      false,
    );
    assert.deepEqual(current.production.saved, current.production.seen);
    for (const [key, value] of Object.entries(oldStorage))
      assert.equal(current.storage[key], value);
    assert.equal(
      Object.keys(current.storage).some((key) =>
        key.includes("unrelated-center"),
      ),
      false,
    );
    await run("mount", false);
    const closed = await report();
    assert.deepEqual(closed.closed.production, closed.closed.fixed);
    await page.mouse.click(1, 1);
    const after = await report();
    assert.deepEqual(after.closed, closed.closed);
    assert.deepEqual(after.storage, closed.storage);
    assert.deepEqual(errors, []);
    assert.deepEqual(queries, []);
    finish();
  },
);

test(
  "native foreground/background activation preserves actual Conversation unread and both receipt event ledgers",
  {
    skip: !installed
      ? "cached Chromium executable is unavailable"
      : process.env.MORPHZ_TEST_NATIVE_FOCUS !== "1"
        ? "requires MORPHZ_TEST_NATIVE_FOCUS=1 and a browser environment that supports actual target deactivation; ordinary headless activation is not guaranteed"
        : false,
    timeout: 30000,
  },
  async (context) => {
    const {
      page,
      browserContext,
      errors,
      queries,
      settled,
      run,
      setPhase,
      finish,
    } = await mountReceiptFixture(context);
    // Disable Playwright's default focus=true only for this explicit native
    // capability test. No guard replacement or fake focus event is used.
    await (
      await browserContext.newCDPSession(page)
    ).send("Emulation.setFocusEmulationEnabled", { enabled: false });
    setPhase("native initial foreground activation");
    await page.bringToFront();
    await page.waitForFunction(() => document.hasFocus());
    await page.locator("#focus-production").click();
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    let current = await settled();
    assert.equal(current.production.unread, false);
    current = await run("show", true);
    assert.equal(current.production.unread, false);
    const other = await browserContext.newPage();
    await other.goto("about:blank");
    await other.setContent('<button type="button">Other page focus</button>');
    await (
      await browserContext.newCDPSession(other)
    ).send("Emulation.setFocusEmulationEnabled", { enabled: false });
    setPhase("native background deactivation readiness");
    await other.bringToFront();
    await other.locator("button").click();
    await page.waitForFunction(() => !document.hasFocus());
    assert.equal(await page.evaluate(() => document.hasFocus()), false);
    assert.equal(
      await page.evaluate(() => document.visibilityState),
      "visible",
    );
    current = await run("message", {
      id: "background",
      text: "TEST background unread",
    });
    assert.equal(current.production.unread, true);
    assert.equal(current.production.seen["reply:background"], undefined);
    assert.deepEqual(current.production.saved, current.production.seen);
    await other.close();
    setPhase("native foreground reactivation readiness");
    await page.bringToFront();
    // Command completion or two RAFs do not establish native activation.
    await page.waitForFunction(() => document.hasFocus());
    await page.locator("#focus-fixed").click();
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "focus-fixed",
    );
    current = await settled();
    assert.equal(current.production.unread, false);
    assert(current.production.seen["reply:background"]);
    assert.deepEqual(current.production.saved, current.production.seen);
    assert.deepEqual(errors, []);
    assert.deepEqual(queries, []);
    finish();
  },
);
