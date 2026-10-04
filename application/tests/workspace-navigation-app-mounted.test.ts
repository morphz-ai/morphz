import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isFunctionDeclaration, type Node } from "typescript/unstable/ast";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, transformWithOxc } from "vite";
import { inversePrivateProjectConversationScope } from "./fixtures/private-project-conversation-scope-consumption.js";

// Execute the actual finite App boundary/dialog functions, not a hand-written
// copy of their identity or completion algorithms. Private WorkspaceApp below
// is only a hook/port adapter; this does not replace compiled full App+Client
// regression or prove actual Platform authorization/HTTP persistence.
function appFunctions() {
  // Validate the actual new owner, then restore only this finite App seam;
  // the old mounted algorithms remain the original, not direct new-owner calls.
  const text = inversePrivateProjectConversationScope(
    readFileSync(resolve("apps/web/src/App.tsx"), "utf8"),
  );
  const api = new API({
    cwd: "/app",
    fs: createVirtualFileSystem({
      "/app/App.tsx": text,
      "/app/tsconfig.json": JSON.stringify({
        compilerOptions: { jsx: "preserve", noLib: true, noResolve: true },
        files: ["App.tsx"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: ["/app/tsconfig.json"] });
  const file = snapshot
    .getProject("/app/tsconfig.json")!
    .program.getSourceFile("/app/App.tsx")!;
  try {
    const result = new Map<string, string>();
    const names = [
      "App",
      "WorkspaceNavigationHost",
      "PrivateNavigationBoundary",
      "WorkspaceConnection",
      "WorkspaceLogin",
      "CreateDialog",
      "prefer",
      "writePreferences",
      "continueNavigation",
      "prepareCreatedProject",
      "setNotice",
    ];
    function visit(node: Node) {
      if (
        isFunctionDeclaration(node) &&
        node.name &&
        names.includes(node.name.text)
      ) {
        assert.equal(
          result.has(node.name.text),
          false,
          "unique actual function " + node.name.text,
        );
        result.set(node.name.text, node.getText());
      }
      node.forEachChild(visit);
    }
    visit(file);
    assert.equal(result.size, names.length);
    return result;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
const functions = appFunctions();
const source = `
import React, {StrictMode, Suspense, startTransition, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal, flushSync} from 'react-dom';
import {X} from 'lucide-react';
import {spaceKind, initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
import {scopedStorage, storageScope, draftKey} from '/src/local-preferences.ts';
import {useModal} from '/src/useModal.ts';
import {BrandMark} from '/src/BrandMark.tsx';
import {NavigationHostLifetime, NavigationOriginLifetime, useWorkspaceNavigationHost, useWorkspaceNavigationOrigin} from '/src/host/use-workspace-navigation-host.ts';
import {isNavigationPreferenceChange, mergeNavigationPreferences} from '/src/host/use-workspace-navigation.ts';
const now='2026-10-04T00:00:00.000Z';
function boot(label='A', session=label, includeProject=false) {
 const workspace=initialWorkspace(now);
 if(includeProject)workspace.projects.push({...workspace.projects[0],id:'created-project',title:'Created',kind:'project'});
 return {centerId:'center-'+label,principalId:'local-owner',csrfToken:'session-'+session,workspace,capabilities:{teamAuthentication:false},scriptLibrary:[]};
}
let currentBoot=boot(), auth=false, suspend=false, publish;
let latest, oldPrivate, pending=[], suspendedRenders=0;
const hostIds=new WeakMap();let nextHost=0;
const events={commands:[],writes:[],liveCreated:[],privateCleanup:0,privateEffects:[],refresh:0,childLayouts:0};
const oldSet=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){if(key.startsWith('morphz:')&&key.endsWith(':preferences'))events.writes.push({key,route:JSON.parse(value).projectId});return oldSet.call(this,key,value);};
const client={getSnapshot:()=>currentBoot,refresh:async()=>{events.refresh++;},login:async()=>{},execute(operation){
 events.commands.push(operation);return new Promise((resolve,reject)=>pending.push({resolve,reject}));
}};
function useWorkspace(){const [snapshot,setSnapshot]=useState({...client,boot:currentBoot,authenticationRequired:auth});publish=()=>setSnapshot({...client,boot:currentBoot,authenticationRequired:auth});return snapshot;}
${functions.get("App")}
${functions.get("WorkspaceNavigationHost")}
${functions.get("PrivateNavigationBoundary")}
${functions.get("WorkspaceConnection")}
${functions.get("WorkspaceLogin")}
${functions.get("CreateDialog")}
function LayoutChild({onNotice,prefer}){useLayoutEffect(()=>{events.childLayouts++;onNotice('exact child layout notice');prefer({subjectOpen:true});},[]);return null;}
function WorkspaceApp({client,host,origin}) {
 const {prefs,navigation}=host, navigationGeneration=navigation.navigationGeneration;
 const [creating,setCreating]=useState(null), [understandingOpen,setUnderstandingOpen]=useState(false);
 const [privateNotice,setPrivateNotice]=useState('');
 const clearResizePreview=()=>events.privateEffects.push('resize');
 ${functions.get("setNotice")}
 ${functions.get("prefer")}
 ${functions.get("writePreferences")}
 ${functions.get("continueNavigation")}
 ${functions.get("prepareCreatedProject")}
 if(suspend&&client.boot?.centerId==='center-B'){suspendedRenders++;throw new Promise(()=>{});}
 useLayoutEffect(()=>{
  if(!hostIds.has(navigationGeneration))hostIds.set(navigationGeneration,++nextHost);
  const api={host,origin,prefs,setCreating,prefer,prepareCreatedProject};latest=api;oldPrivate=api;
  return()=>{events.privateCleanup++;};
 });
 return <main className="workspace" data-host={hostIds.get(navigationGeneration)} data-project={prefs.projectId} data-view={prefs.view} data-notice={privateNotice}>
  <LayoutChild onNotice={setNotice} prefer={prefer}/>
  <output id="private">{understandingOpen?'understanding':'private adapter'}</output>
  {creating&&<CreateDialog kind={creating} projectId="first-project" client={client} prepareCreated={creating==='project'?prepareCreatedProject:undefined}
    onClose={()=>setCreating(null)} onCreated={(id,kind)=>{events.liveCreated.push({id,kind});setCreating(null);}}/>}
 </main>;
}
const root=createRoot(document.getElementById('root'));
flushSync(()=>root.render(<StrictMode><Suspense fallback={<output id="suspended">pending</output>}><App/></Suspense></StrictMode>));
function render(next,authenticationRequired=false){currentBoot=next;auth=authenticationRequired;flushSync(()=>publish());}
async function settle(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
window.appNavigationFixture={
 report(){return {host:latest&&hostIds.get(latest.host.navigation.navigationGeneration),generation:latest?.host.navigation.navigationGeneration.current,
  prefs:latest?.host.prefs,notice:document.querySelector('.workspace')?.getAttribute('data-notice')??'',private:!!document.querySelector('#private'),connection:!!document.querySelector('.connection-screen'),
  dialog:!!document.querySelector('dialog[open]'),alert:document.querySelector('[role=alert]')?.textContent??'',
  heading:document.querySelector('.connection-screen h1')?.textContent??'',events,suspendedRenders};},
 async run(action,value){
  if(action==='create')flushSync(()=>latest.setCreating(value??'project'));
  if(action==='clear')render(null);
  if(action==='restore')render(boot('A','A',value!==false));
  if(action==='revoke')render(boot('A'));
  if(action==='identity')render(boot(value,value,true));
  if(action==='session')render(boot('A','rotated',true));
  if(action==='logout')render(null,true);
  if(action==='human')flushSync(()=>latest.prefer({view:'inbox',projectId:'first-project'}));
  if(action==='old-private')flushSync(()=>oldPrivate.prefer({view:'dialogue'}));
  if(action==='resolve'){pending.shift().resolve({commandId:'create-command',entityId:'created-project',workspaceRevision:2});}
  if(action==='reject'){pending.shift().reject(new Error('exact create failure'));}
  if(action==='speculative'){suspend=true;currentBoot=boot('B');startTransition(()=>publish());}
  if(action==='cancel-speculative'){suspend=false;render(boot('A'));}
  if(action==='retry')document.querySelector('.connection-screen button').click();
  await settle();return this.report();
 }
};
`;
type Report = {
  host: number;
  generation: number;
  prefs: {
    view: string;
    projectId: string;
    projectOpen: boolean;
    artifactId: string | null;
    selectedConversations?: Record<string, string>;
    interactions?: Record<string, string>;
    subjectOpen: boolean;
  };
  private: boolean;
  connection: boolean;
  dialog: boolean;
  alert: string;
  heading: string;
  notice: string;
  suspendedRenders: number;
  events: {
    commands: unknown[];
    writes: { key: string; route: string }[];
    liveCreated: { id: string; kind: string }[];
    privateCleanup: number;
    privateEffects: string[];
    refresh: number;
    childLayouts: number;
  };
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
test(
  "actual App identity boundary/CreateDialog and captured project completion mount under StrictMode",
  {
    skip:
      !executable || !existsSync(executable)
        ? "set MORPHZ_TEST_BROWSER_EXECUTABLE for actual isolated React mounting"
        : false,
  },
  async (context) => {
    const cacheDir = mkdtempSync(
      join(tmpdir(), "morphz-navigation-app-cache-"),
    );
    context.after(() => rmSync(cacheDir, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "finite-actual-app-navigation",
          resolveId(id) {
            if (id === "/__actual-navigation.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__actual-navigation.tsx")
              return transformWithOxc(source, "actual-navigation.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__actual-navigation") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__actual-navigation.tsx"></script></body></html>',
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
      executablePath: executable,
    });
    context.after(() => browser.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__actual-navigation`;
    async function scene(
      run: (
        action: (name: string, value?: unknown) => Promise<Report>,
        report: () => Promise<Report>,
        submit: () => Promise<void>,
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
            Reflect.get(window, "appNavigationFixture").report(),
          ) as Promise<Report>;
        const action = async (name: string, value: unknown = null) =>
          name === "document-input"
            ? (await page
                .getByRole("textbox", { name: "新对象标题" })
                .fill("Document"),
              await page
                .getByRole("textbox", { name: "新文档正文" })
                .fill("Unsent original"),
              await page
                .getByRole("button", { name: "创建", exact: true })
                .click(),
              report())
            : (page.evaluate(
                ({ name, value }) =>
                  Reflect.get(window, "appNavigationFixture").run(name, value),
                { name, value },
              ) as Promise<Report>);
        const submit = async () => {
          await action("create");
          await page.getByRole("textbox", { name: "项目名称" }).fill("Created");
          await page.getByRole("button", { name: "创建", exact: true }).click();
        };
        await run(action, report, submit);
        assert.deepEqual(errors, []);
        assert.deepEqual(queries, []);
      } finally {
        await page.close();
      }
    }
    await context.test(
      "actual descendant layout can call original private notice/prefer on first commit and both StrictMode setup rounds",
      () =>
        scene(async (_action, report) => {
          const first = await report();
          assert.equal(first.events.childLayouts, 2);
          assert.equal(first.notice, "exact child layout notice");
          assert.equal(first.prefs.subjectOpen, true);
        }),
    );
    await context.test(
      "same-identity clear unmounts original dialog/private DOM; authorized completion keeps the Host and opens original default route without old child callbacks",
      () =>
        scene(async (action, report, submit) => {
          const first = await report();
          await submit();
          const submitted = await report();
          assert.equal(submitted.dialog, true);
          assert.equal(submitted.events.commands.length, 1);
          assert.deepEqual(submitted.events.commands[0], {
            type: "create-project",
            title: "Created",
          });
          const hidden = await action("clear");
          assert.equal(hidden.private, false);
          assert.equal(hidden.dialog, false);
          assert.equal(hidden.connection, true);
          assert.equal(hidden.heading, "Morphz");
          assert.equal(hidden.host, first.host);
          await action("retry");
          assert.equal((await report()).events.refresh, 1);
          const restored = await action("restore");
          assert.equal(restored.host, first.host);
          const effects = restored.events.privateEffects.length;
          const done = await action("resolve");
          assert.equal(done.prefs.projectId, "created-project");
          assert.equal(done.prefs.view, "projects");
          assert.equal(done.prefs.projectOpen, true);
          assert.equal(done.prefs.artifactId, null);
          assert.equal(
            done.prefs.selectedConversations?.["created-project"],
            "local-dialogue",
          );
          assert.equal(done.prefs.interactions?.["created-project"], "recent");
          assert.deepEqual(done.events.liveCreated, []);
          assert.equal(done.events.privateEffects.length, effects);
          assert.ok(done.events.writes.length > restored.events.writes.length);
          assert.equal(done.host, first.host);
        }),
    );
    await context.test(
      "living success/error keeps original dialog callback and exact local error; unloaded error cannot resurrect original dialog or banner",
      () =>
        scene(async (action, _report, submit) => {
          await submit();
          await action("restore");
          let done = await action("resolve");
          assert.deepEqual(done.events.liveCreated, [
            { id: "created-project", kind: "project" },
          ]);
          assert.equal(done.dialog, false);
          await submit();
          done = await action("reject");
          assert.equal(done.dialog, true);
          assert.equal(done.alert, "exact create failure");
          assert.equal(done.events.commands.length, 2);
          await submit();
          await action("clear");
          done = await action("reject");
          assert.equal(done.dialog, false);
          assert.equal(done.alert, "");
          assert.equal(done.private, false);
        }),
    );
    await context.test(
      "document creation retains its original operation/draft-clear contract and never receives project continuation authority",
      () =>
        scene(async (action, report, _submit) => {
          await action("create", "document");
          // The actual document editor's controls/submit path remain unchanged.
          // Trigger through its native input events, not by invoking submit directly.
          // Scene actions below are intentionally limited to the controlled fixture.
          await action("document-input");
          const submitted = await report();
          assert.deepEqual(submitted.events.commands[0], {
            type: "create-artifact",
            projectId: "first-project",
            title: "Document",
            content: { kind: "document", markdown: "Unsent original" },
          });
          await action("clear");
          await action("restore");
          const before = await report(),
            done = await action("resolve");
          assert.deepEqual(done.prefs, before.prefs);
          assert.deepEqual(done.events.writes, before.events.writes);
          assert.deepEqual(done.events.liveCreated, []);
        }),
    );
    await context.test(
      "same-session target revocation and later human navigation reject old project completion without replacing any original route",
      async () => {
        for (const mode of ["revoke", "human"])
          await scene(async (action, report, submit) => {
            await submit();
            await action("clear");
            await action(mode === "revoke" ? "revoke" : "restore");
            if (mode === "human") await action("human");
            const before = await report(),
              done = await action("resolve");
            assert.deepEqual(done.prefs, before.prefs);
            assert.deepEqual(done.events.writes, before.events.writes);
            assert.deepEqual(done.events.liveCreated, []);
          });
      },
    );
    await context.test(
      "logout, CSRF rotation and identity A→B→A destroy the old Host incarnation; matching IDs never revive its queued completion",
      async () => {
        for (const mode of ["logout", "session", "identity"])
          await scene(async (action, report, submit) => {
            const first = await report();
            await submit();
            await action(mode, mode === "identity" ? "B" : null);
            if (mode === "logout")
              assert.equal((await report()).heading, "登录 Morphz");
            await action("restore");
            const before = await report();
            assert.notEqual(before.host, first.host);
            const done = await action("resolve");
            assert.deepEqual(done.prefs, before.prefs);
            assert.deepEqual(done.events.writes, before.events.writes);
            assert.deepEqual(done.events.liveCreated, []);
          });
      },
    );
    await context.test(
      "aborted suspended identity render cannot retire the still-committed A Host; urgent A return preserves it and its pending approved continuation",
      () =>
        scene(async (action, report, submit) => {
          const first = await report();
          await submit();
          await action("speculative");
          let current = await report();
          assert.ok(current.suspendedRenders > 0);
          assert.equal(current.host, first.host);
          assert.equal(current.private, true);
          current = await action("cancel-speculative");
          assert.equal(current.host, first.host);
          await action("restore");
          const done = await action("resolve");
          assert.equal(done.host, first.host);
          assert.equal(done.prefs.projectId, "created-project");
        }),
    );
  },
);
