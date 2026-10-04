import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { storageScope } from "../apps/web/src/local-preferences.js";
import { useWorkspaceNavigationHost } from "../apps/web/src/host/use-workspace-navigation-host.js";

test("Host keeps original preference normalization/unknown fields and explicit scoped storage, without eager projection reads or SSR writes", () => {
  const reads: string[] = [],
    writes: string[] = [];
  const values = new Map([
    [
      "morphz:center-A:principal-A:preferences",
      JSON.stringify({
        view: "projects",
        subjectOpen: true,
        subjectTab: "unknown",
        collaboration: true,
        sidebarWidth: 999,
        sidebarCompact: "yes",
        appearance: "dark",
        accent: "bad",
        textSize: "large",
        motion: "reduce",
        sendShortcut: "mod-enter",
        unrelated: { keep: true },
      }),
    ],
    [
      "morphz:center-A:principal-A:recent-content",
      JSON.stringify([
        { artifactId: "content-A", openedAt: 10, body: "not retained" },
        { artifactId: "content-A", openedAt: 20 },
        { artifactId: "", openedAt: 30 },
        { artifactId: "content-B", openedAt: 40 },
      ]),
    ],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        reads.push(key);
        return values.get(key) ?? null;
      },
      setItem(key: string) {
        writes.push(key);
      },
    },
  });
  storageScope("wrong-center", "wrong-principal");
  let projectionReads = 0;
  let host: ReturnType<typeof useWorkspaceNavigationHost> | undefined;
  function Probe() {
    host = useWorkspaceNavigationHost({
      identity: {
        centerId: "center-A",
        principalId: "principal-A",
        csrfToken: "session-A",
      },
      getSnapshot() {
        projectionReads++;
        return null;
      },
    });
    return null;
  }
  try {
    renderToString(createElement(Probe));
    assert.ok(host);
    assert.deepEqual(host.prefs, {
      appearance: "dark",
      accent: "cyan",
      textSize: "large",
      motion: "reduce",
      sendShortcut: "mod-enter",
      view: "projects",
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      collaboration: false,
      subjectOpen: true,
      composer: true,
      conversation: null,
      sidebar: true,
      projectOpen: true,
      sidebarWidth: 360,
      sidebarCompact: false,
      subjectTab: "activity",
      unrelated: { keep: true },
    });
    assert.deepEqual(host.recentContentVisits, [
      { artifactId: "content-A", openedAt: 10 },
      { artifactId: "content-B", openedAt: 40 },
    ]);
    assert.deepEqual(reads, [
      "morphz:center-A:principal-A:recent-content",
      "morphz:center-A:principal-A:preferences",
    ]);
    host.writePreferences(
      () => {
        throw Error("SSR updater must not run");
      },
      "position",
      () => true,
    );
    host.recordContentVisit("blocked", () => true);
    assert.equal(host.isCurrentHost(), false);
    assert.equal(projectionReads, 0);
    assert.deepEqual(writes, []);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
    storageScope("disconnected", "disconnected");
  }
});

// Real React lifecycle proof for the Host and private-origin hooks. The current
// authorized snapshot port is controlled: this is not a Client/App/Runtime test,
// nor an oracle for domain command implementations or Platform authorization.
const source = `
import React, { StrictMode, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { NavigationHostLifetime, NavigationOriginLifetime, useWorkspaceNavigationHost, useWorkspaceNavigationOrigin } from '/src/host/use-workspace-navigation-host.ts';
const identity = label => ({centerId:'center-'+label[0], principalId:'principal-'+label[0], csrfToken:'session-'+label});
const projection = (label='A', permitted=true) => ({...identity(label), workspace:{
 projects:permitted?[{id:'project-'+label[0]}]:[], applicationInstances:permitted?[{id:'instance-'+label[0],workspaceId:'project-'+label[0],applicationId:'script-studio',version:'1',closedAt:null}]:[]}});
let current = projection(), snapshotReads=0, api, origin, privateSetter, hostSetter, visibleSetter, tickSetter, mountSetter;
const firstStrict = {}, retiredHosts=[], retiredOrigins=[], pending=[];
const events={writes:[], updates:0, cleanup:0, predicate:0, layoutCalls:0, layoutUpdates:0}; let deny=false, firstTrail, firstStorage;
const oldSet=Storage.prototype.setItem;
oldSet.call(localStorage,'morphz:center-A:principal-A:preferences',JSON.stringify({view:'desk',projectId:'project-A',unrelated:{keep:true}}));
Storage.prototype.setItem=function(key,value){
 if(key.startsWith('morphz:')){events.writes.push(key);if(deny)throw Error('fixture storage denied');}
 return oldSet.call(this,key,value);
};
const target=(host,generation,label='A')=>value=>host.navigation.isCurrent(generation)
 && value.workspace.projects.some(project=>project.id==='project-'+label[0])
 && value.workspace.applicationInstances.some(instance=>instance.id==='instance-'+label[0] && instance.workspaceId==='project-'+label[0] && instance.applicationId==='script-studio' && instance.version==='1' && !instance.closedAt);
function PrivateBoundary({host}){const lease=useWorkspaceNavigationOrigin(host);return <><NavigationOriginLifetime origin={lease}/><Private host={host} lease={lease}/></>;}
function Private({host,lease}){
 origin=lease;
 const [tick,setTick]=useState(0);privateSetter=setTick;
 useLayoutEffect(()=>{
  if(!firstStrict.lease)firstStrict.lease=lease.capturePrivateCommit();
  events.layoutCalls++;
  host.writePreferences(p=>{events.layoutUpdates++;return {...p,layoutSeen:true};},'settings',lease.capturePrivateCommit());
  return()=>{retiredOrigins.push(lease);};
 },[]);
 return <output id="private" data-tick={tick}>private fixture</output>;
}
function Boundary({label,visible}){
 const host=useWorkspaceNavigationHost({identity:identity(label),getSnapshot(){snapshotReads++;return current;}});api=host;
 const [tick,setTick]=useState(0);tickSetter=setTick;
 useLayoutEffect(()=>{
  if(firstStrict.generation===undefined)firstStrict.generation=host.navigation.navigationGeneration.current;
  if(!firstTrail){firstTrail=host.navigation.trail;firstStorage=host.storage;}
  return()=>{retiredHosts.push(host);};
 },[]);
 return <><NavigationHostLifetime host={host}/><main id="host" data-tick={tick} data-view={host.prefs.view} data-notice={host.persistenceNotice}>
  {visible?<PrivateBoundary host={host}/>:<output id="connection">original connection branch placeholder</output>}
 </main></>;
}
function Fixture(){
 const [label,setLabel]=useState('A'),[visible,setVisible]=useState(true),[mounted,setMounted]=useState(true);
 hostSetter=setLabel;visibleSetter=setVisible;mountSetter=setMounted;
 return mounted?<Boundary key={label} label={label} visible={visible}/>:null;
}
function privatePrefer(previousOrigin=origin){
 // The real App adapter must retain this precondition before beginIntent and
 // before any child cleanup. This exercises that integration contract only.
 if(!previousOrigin.isActive())return;
 api.navigation.beginIntent();events.cleanup++;
 const commit=previousOrigin.capturePrivateCommit();
 api.writePreferences(p=>({...p,view:'content'}),'settings',commit);
}
const fixture={
 async run(action,value){
  let completion;
  flushSync(()=>{
   if(action==='unrelated')tickSetter(n=>n+1);
   else if(action==='write')api.writePreferences(p=>{events.updates++;return {...p,view:value};},'settings',()=>true);
   else if(action==='visit')api.recordContentVisit('content-before-refresh',()=>true);
   else if(action==='trail'){
    const place={view:'desk',projectId:'project-A',projectOpen:false,artifactId:null,artifactRevision:null};
    api.navigation.recordPlace(place,JSON.stringify(place));
   }
   else if(action==='prepare'){
    const host=api,generation=host.navigation.beginOpen(),label=value??'A';let release;
    const wait=new Promise(resolve=>{release=resolve;});
    const done=wait.then(()=>flushSync(()=>{
     const destination=target(host,generation,label);
     host.writePreferences(p=>{events.updates++;return {...p,view:'projects',projectId:'project-'+label[0],applications:{...p.applications,['project-'+label[0]]:'instance-'+label[0]}};},'position',destination);
     host.recordContentVisit('content-'+label[0],destination);host.navigation.finishOpen(generation);
    }));pending.push({release,done,host,generation});
   }
   else if(action==='release'){const item=pending[value??pending.length-1];item.release();completion=item.done;}
   else if(action==='hide'){current=null;visibleSetter(false);}
   else if(action==='restore'){current=projection(value??'A');visibleSetter(true);}
   else if(action==='revoke')current=projection(value??'A',false);
   else if(action==='identity'){current=projection(value);hostSetter(value);visibleSetter(true);}
   else if(action==='logout'){current=null;mountSetter(false);}
   else if(action==='human'){api.navigation.beginIntent();api.navigation.resetPreferenceNavigation();api.writePreferences(p=>({...p,view:'inbox'}),'settings',()=>true);}
   else if(action==='old-private')privatePrefer(retiredOrigins.at(-1));
   else if(action==='private')privatePrefer();
   else if(action==='old-write')pending[value??0].host.writePreferences(p=>{events.updates++;return {...p,view:'content'};},'settings',()=>true);
   else if(action==='guard-twice')api.writePreferences(p=>{events.updates++;return {...p,view:'content'};},'settings',()=>++events.predicate===1);
   else if(action==='identity-between'){
    api.writePreferences(p=>{events.updates++;return {...p,view:'content'};},'settings',()=>{events.predicate++;current=projection('B');return true;});
   }
   else if(action==='fail'){
    deny=true;
    if(value==='recent')api.recordContentVisit('content-error',()=>true);
    else api.writePreferences(p=>({...p,view:'inbox'}),value,()=>true);
   }
   else if(action==='dismiss'){deny=false;api.dismissPersistenceNotice();}
  });
  if(action==='identity-between')current=projection('A');
  if(completion)await completion;
 },
 report(){const reads=snapshotReads;return {
  prefs:api.prefs,visits:api.recentContentVisits,notice:api.persistenceNotice,events:{...events,writes:[...events.writes]},
  generation:api.navigation.navigationGeneration.current,opening:api.navigation.openingObject,trailLength:api.navigation.trail.current.places.length,
  mounted:!!document.getElementById('private'),connection:!!document.getElementById('connection'),
  hostCurrent:api.isCurrentHost(),originCurrent:origin.isActive(),snapshotReads:reads,
  identity:{trail:api.navigation.trail===firstTrail,storage:api.storage===firstStorage},
  firstStrictLease:firstStrict.lease(),firstStrictIntent:api.navigation.isCurrent(firstStrict.generation),
  retiredHostCurrent:pending.map(item=>item.host.isCurrentHost()),
  values:Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('morphz:')).sort().map(key=>[key,JSON.parse(localStorage.getItem(key))])),
 };},
};
Object.assign(window,{navigationHostFixture:fixture});
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;
type Report = {
  prefs: {
    view: string;
    projectId: string;
    unrelated?: { keep: boolean };
    applications?: Record<string, string>;
  };
  visits: { artifactId: string; openedAt: number }[];
  notice: string;
  events: {
    writes: string[];
    updates: number;
    cleanup: number;
    predicate: number;
    layoutCalls: number;
    layoutUpdates: number;
  };
  generation: number;
  opening: boolean;
  trailLength: number;
  mounted: boolean;
  connection: boolean;
  hostCurrent: boolean;
  originCurrent: boolean;
  snapshotReads: number;
  identity: { trail: boolean; storage: boolean };
  firstStrictLease: boolean;
  firstStrictIntent: boolean;
  retiredHostCurrent: boolean[];
  values: Record<string, unknown>;
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
const installed = executable
  ? existsSync(executable)
  : existsSync(chromium.executablePath());
test(
  "real StrictMode Host/private-origin lifetimes and fresh semantic gates",
  { skip: !installed, timeout: 30000 },
  async (context) => {
    const cacheDir = mkdtempSync(
      join(tmpdir(), "morphz-navigation-hook-cache-"),
    );
    context.after(() => rmSync(cacheDir, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "isolated-workspace-navigation-host",
          resolveId(id) {
            if (id === "/__navigation-host.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__navigation-host.tsx")
              return transformWithOxc(source, "navigation-host.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__navigation-host") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__navigation-host.tsx"></script></body></html>',
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
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__navigation-host`;
    async function scene(
      run: (
        run: (action: string, value?: unknown) => Promise<Report>,
        report: () => Promise<Report>,
      ) => Promise<void>,
    ) {
      const page = await browser.newPage(),
        errors: string[] = [],
        queries: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("request", (request) => {
        if (["fetch", "xhr"].includes(request.resourceType()))
          queries.push(request.url());
      });
      try {
        await page.goto(url);
        await page.waitForSelector("#private");
        const report = () =>
          page.evaluate(() =>
            Reflect.get(window, "navigationHostFixture").report(),
          ) as Promise<Report>;
        const action = async (action: string, value: unknown = null) => {
          await page.evaluate(
            ({ action, value }) =>
              Reflect.get(window, "navigationHostFixture").run(action, value),
            { action, value },
          );
          return report();
        };
        await run(action, report);
        assert.deepEqual(errors, []);
        assert.deepEqual(queries, []);
      } finally {
        await page.close();
      }
    }
    await context.test(
      "same-identity empty projection unmounts private origin but retains Host state and completes authorized deferred navigation",
      () =>
        scene(async (run, report) => {
          const first = await report();
          assert.equal(first.hostCurrent, true);
          assert.equal(first.originCurrent, true);
          assert.equal(first.events.layoutCalls, 2);
          assert.ok(first.events.layoutUpdates >= 2);
          assert.equal(first.firstStrictLease, false);
          assert.equal(first.firstStrictIntent, false);
          await run("write", "dialogue");
          await run("visit");
          await run("trail");
          const pending = await run("prepare");
          assert.equal(pending.opening, true);
          const hidden = await run("hide");
          assert.equal(hidden.mounted, false);
          assert.equal(hidden.connection, true);
          assert.equal(hidden.hostCurrent, false);
          assert.equal(hidden.originCurrent, false);
          assert.equal(hidden.generation, pending.generation);
          assert.equal(hidden.prefs.view, "dialogue");
          assert.equal(hidden.trailLength, 1);
          assert.equal(hidden.visits[0]?.artifactId, "content-before-refresh");
          assert.deepEqual(hidden.identity, { trail: true, storage: true });
          const dead = await run("old-private");
          assert.equal(dead.generation, hidden.generation);
          assert.equal(dead.events.cleanup, hidden.events.cleanup);
          assert.deepEqual(dead.events.writes, hidden.events.writes);
          const restored = await run("restore");
          assert.equal(restored.hostCurrent, true);
          assert.equal(restored.originCurrent, true);
          assert.equal(restored.generation, pending.generation);
          assert.deepEqual(restored.identity, { trail: true, storage: true });
          const result = await run("release");
          assert.equal(result.prefs.view, "projects");
          assert.equal(result.prefs.projectId, "project-A");
          assert.deepEqual(result.prefs.applications, {
            "project-A": "instance-A",
          });
          assert.deepEqual(result.prefs.unrelated, { keep: true });
          assert.equal(result.visits[0]?.artifactId, "content-A");
          assert.equal(result.visits[1]?.artifactId, "content-before-refresh");
          assert.equal(result.trailLength, 1);
          assert.equal(result.opening, false);
          assert.ok(
            result.events.writes.every((key) =>
              key.startsWith("morphz:center-A:principal-A:"),
            ),
          );
        }),
    );
    await context.test(
      "same-session target revocation and a newer human intent each reject all late route/recency writes",
      async () => {
        for (const invalidation of ["revoke", "human"]) {
          await scene(async (run) => {
            await run("prepare");
            const before = await run(invalidation);
            const after = await run("release");
            assert.deepEqual(after.events.writes, before.events.writes);
            assert.equal(after.events.updates, before.events.updates);
            assert.deepEqual(after.visits, []);
            assert.equal(
              after.prefs.view,
              invalidation === "human" ? "inbox" : "desk",
            );
          });
        }
      },
    );
    await context.test(
      "identity ABA, CSRF rotation and logout permanently retire old Host handles",
      async () => {
        for (const next of ["B", "A-rotated", "logout"]) {
          await scene(async (run) => {
            await run("prepare");
            await run(next === "logout" ? "logout" : "identity", next);
            if (next === "B") await run("identity", "A");
            const before = await run("unrelated");
            const after = await run("release");
            assert.equal(after.retiredHostCurrent[0], false);
            assert.deepEqual(after.events.writes, before.events.writes);
            assert.equal(after.events.updates, before.events.updates);
            assert.deepEqual(after.visits, []);
            const oldWrite = await run("old-write");
            assert.deepEqual(oldWrite.events.writes, before.events.writes);
            assert.equal(oldWrite.events.updates, before.events.updates);
          });
        }
      },
    );
    await context.test(
      "a current-projection check runs again inside the actual React functional updater before evaluating a preference patch",
      async () => {
        for (const action of ["guard-twice", "identity-between"]) {
          await scene(async (run, report) => {
            const before = await report();
            const after = await run(action);
            assert.equal(after.events.updates, 0);
            assert.deepEqual(after.events.writes, before.events.writes);
            assert.equal(after.prefs.view, before.prefs.view);
            assert.equal(
              after.events.predicate,
              action === "guard-twice" ? 3 : 1,
            );
          });
        }
      },
    );
    await context.test(
      "stable Host owns all three original persistence failures without dead-child callbacks or cross-component updates",
      () =>
        scene(async (run) => {
          const messages = {
            settings: "设置暂时无法持久保存。",
            position: "当前位置暂时无法持久保存。",
            recent: "最近打开记录暂时无法保存，内容不受影响。",
          };
          for (const [kind, message] of Object.entries(messages)) {
            const failed = await run("fail", kind);
            assert.equal(failed.notice, message);
            if (kind === "recent")
              assert.equal(failed.visits[0]?.artifactId, "content-error");
            else assert.equal(failed.prefs.view, "inbox");
            assert.equal((await run("dismiss")).notice, "");
          }
        }),
    );
  },
);
