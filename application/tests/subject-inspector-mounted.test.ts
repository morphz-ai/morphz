import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import type { ExecutionScope } from "../packages/core/src/execution.js";
import type { FixedInspectorSelection } from "./fixtures/subject-inspector-85a50934.js";

const oldSource = readFileSync(
  new URL("./fixtures/subject-inspector-85a50934.ts", import.meta.url),
  "utf8",
);
// This is a lifecycle adapter, not an App clone or a simulated Runtime. The
// fixed old hook initializers/effect/body were separately verified from Git85.
// Same scope objects and original inputs are supplied to two real React lanes.
const source = `
import React, { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { initialWorkspace } from '/@fs/${resolve("packages/core/src/model.ts")}';
import { createSubjectInspectorCloseCommand, createSubjectInspectorCommands,
  subjectInspectorView, subjectCollaborationVisible, subjectInspectorOpen, subjectInspectorPresentation,
  useSubjectActivityState, useSubjectInspectionState, useSubjectCollaborationState, useSubjectInspectorMemory, useSubjectInspectorCommit,
} from '/src/host/use-subject-inspector.ts';
import { createFixedSubjectInspector, deriveFixedSubjectInspector,
  useFixedSubjectInspectorState, useFixedSubjectInspectorCommit,
} from '/__fixed-subject-inspector.ts';
const workspace = initialWorkspace('2026-10-04T00:00:00.000Z');
workspace.inputs = [{id:'input-A', projectId:'first-project', conversationId:'conversation-A', artifactId:'artifact-A'}];
const scopes = {
 A: {projectId:'first-project', conversationId:'conversation-A', artifactId:'artifact-A', inputId:'input-A', threadId:'thread-A'},
 B: {projectId:'first-project', conversationId:'conversation-B', artifactId:null, threadId:'thread-B'},
};
const lanes = new Map(), mounted = new Set(); let mount;
function Lane({ mode }) {
 const old = mode === 'fixed' ? useFixedSubjectInspectorState() : null;
 const activity = old ?? useSubjectActivityState();
 const inspection = old ?? useSubjectInspectionState();
 const collaboration = old ?? useSubjectCollaborationState();
 const memory = old?.inspectorSelections ?? useSubjectInspectorMemory();
 const [preferences, setPreferences] = useState({subjectOpen:false, collaboration:false});
 const [contextKey, setContextKey] = useState('A'), [artifact, setArtifact] = useState(null), [compact, setCompact] = useState(false), [tick, setTick] = useState(0);
 const original = useRef({memory: memory.current, executionSetter: inspection.setExecutions, allWorkSetter: activity.setAllActivity});
 const events = useRef([]);
 const prefer = change => {events.current.push(['prefer',change]);setPreferences(p=>({...p,...change}));};
 const keepExchangeOpen = () => events.current.push(['keep-exchange-open']);
 const historyClient = { loadHistoryUntil(id) {events.current.push(['history',id]);return Promise.resolve(false);}, getSnapshot() {events.current.push(['snapshot']);return {workspace};} };
 const facts = {prefs:preferences, executions:inspection.executions, understandingOpen:inspection.understandingOpen,
  mobileCollaboration:collaboration.mobileCollaboration, compact, artifact, conversationProjectId:'first-project', conversationId:'conversation-'+contextKey};
 let presentation;
 if (old) presentation = deriveFixedSubjectInspector(facts);
 else {
  const subjectView = subjectInspectorView(preferences);
  const collaborationVisible = !!artifact && subjectCollaborationVisible({...facts,subjectView,preferences});
  presentation = {subjectView,collaborationVisible,inspectorOpen:subjectInspectorOpen({...facts,subjectView,collaborationVisible}),...subjectInspectorPresentation({...facts,collaborationVisible})};
 }
 const oldCommands = old && createFixedSubjectInspector({...facts,state:workspace,contextKey,inspectorSelections:memory,
  client:historyClient, ...inspection,...collaboration,setAllActivity:activity.setAllActivity,
  setNotice:message=>events.current.push(['notice',message]),prefer,keepExchangeOpen,
  input:{current:null},toggle:{current:null},document,requestAnimationFrame:()=>{events.current.push(['close-focus']);return 0;},
 });
 const close = oldCommands?.closeInspector ?? createSubjectInspectorCloseCommand({inspection,collaboration,prefer,onClosedFocus:()=>events.current.push(['close-focus'])});
 const commands = oldCommands ? {
  close, selectSubject:oldCommands.selectSubjectView, selectScope:oldCommands.onInspect, show:oldCommands.showInspector,
  openFromLogo:oldCommands.openSubjectFromLogo, inspectExecution:oldCommands.inspectExecution,
 } : createSubjectInspectorCommands({activity,inspection,collaboration,rememberedInspector:memory.current.get(contextKey),
  workspace,historyClient,preferences,conversationProjectId:facts.conversationProjectId,conversationId:facts.conversationId,
  compact,prefer,keepExchangeOpen,onNotice:message=>events.current.push(['notice',message]),close,
 });
 const commit = {contextKey,executions:inspection.executions,understandingOpen:inspection.understandingOpen,collaborationVisible:presentation.collaborationVisible};
 if (old) useFixedSubjectInspectorCommit(memory,commit); else useSubjectInspectorCommit(memory,commit);
 useEffect(()=>{mounted.add(mode);return()=>{mounted.delete(mode);};},[mode]);
 lanes.set(mode, {
  run(action,value) {
   if(action==='scope') commands.selectScope(scopes[value]);
   else if(action==='tab') commands.selectSubject(value);
   else if(action==='close') commands.close();
   else if(action==='show') commands.show();
   else if(action==='logo') commands.openFromLogo(value);
   else if(action==='inspect') void commands.inspectExecution(value);
   else if(action==='surface') setContextKey(value);
   else if(action==='unrelated') setTick(n=>n+1);
   else if(action==='understanding') inspection.setUnderstandingOpen(value);
   else if(action==='execution') inspection.setExecutions(value===null?null:scopes[value]);
   else if(action==='tabPreference') setPreferences(p=>({...p,subjectTab:value}));
   else if(action==='collaboration') {setArtifact({id:'artifact-A'});setCompact(true);collaboration.setMobileCollaboration(true);setPreferences(p=>({...p,subjectOpen:false,collaboration:true}));}
  },
  report() {return {
   facts:{...presentation,executions:inspection.executions,allActivity:activity.allActivity,understandingOpen:inspection.understandingOpen,mobileCollaboration:collaboration.mobileCollaboration,contextKey},
   entries:[...memory.current],events:events.current,
   identity:{memory:memory.current===original.current.memory,executionSetter:inspection.setExecutions===original.current.executionSetter,
    allWorkSetter:activity.setAllActivity===original.current.allWorkSetter,
    execution:inspection.executions===scopes.A?'A':inspection.executions===scopes.B?'B':null,
    memories:[...memory.current].map(([key,value])=>[key,value.view==='execution'?(value.scope===scopes.A?'A':value.scope===scopes.B?'B':null):null])},
  };},
 });
 return <output id={'lane-'+mode} data-tick={tick}>{JSON.stringify(presentation)}</output>;
}
function Fixture() {
 const [visible,setVisible] = useState(true); mount = setVisible;
 return <main>{visible && <><Lane mode="fixed"/><Lane mode="production"/></>}</main>;
}
Object.assign(window,{subjectInspectorFixture:{
 run(action,value) {flushSync(()=>{if(action==='mount')mount(value);else for(const lane of lanes.values())lane.run(action,value);});},
 report() {return {mounted:[...mounted].sort(), fixed:lanes.get('fixed')?.report(),production:lanes.get('production')?.report()};},
}});
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;
type LaneReport = {
  facts: {
    executions: ExecutionScope | null;
    allActivity: boolean;
    understandingOpen: boolean;
    mobileCollaboration: boolean;
    contextKey: string;
    subjectView: string | null;
    collaborationVisible: boolean;
    activityScope: ExecutionScope;
  };
  entries: [string, FixedInspectorSelection][];
  events: unknown[][];
  identity: {
    memory: boolean;
    executionSetter: boolean;
    allWorkSetter: boolean;
    execution: string | null;
    memories: [string, string | null][];
  };
};
type Report = { mounted: string[]; fixed: LaneReport; production: LaneReport };

const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
const installed = executable
  ? existsSync(executable)
  : existsSync(chromium.executablePath());
test(
  "real StrictMode hooks preserve initial state, stable setters/ref, priority/scoped memory, hide/restore and remount without eager reads",
  { skip: !installed, timeout: 25000 },
  async (context) => {
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      plugins: [
        react(),
        {
          name: "isolated-subject-inspector-lifecycle",
          resolveId(id) {
            if (
              [
                "/__subject-inspector.tsx",
                "/__fixed-subject-inspector.ts",
              ].includes(id)
            )
              return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__subject-inspector.tsx")
              return transformWithOxc(source, "subject-inspector.tsx");
            if (id === "\0/__fixed-subject-inspector.ts")
              return transformWithOxc(oldSource, "fixed-subject-inspector.ts");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__subject-inspector") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="/__subject-inspector.tsx"></script></body></html>',
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
    const page = await browser.newPage(),
      errors: string[] = [],
      queries: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (["fetch", "xhr"].includes(request.resourceType()))
        queries.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${address.port}/__subject-inspector`);
    await page.waitForSelector("#lane-production");
    const report = () =>
      page.evaluate(() =>
        Reflect.get(window, "subjectInspectorFixture").report(),
      ) as Promise<Report>;
    const parity = (value: Report) => {
      assert.deepEqual(value.production, value.fixed);
      assert.deepEqual(value.production.identity, {
        ...value.production.identity,
        memory: true,
        executionSetter: true,
        allWorkSetter: true,
      });
    };
    const run = async (action: string, value: unknown = null) => {
      await page.evaluate(
        ({ action, value }) =>
          Reflect.get(window, "subjectInspectorFixture").run(action, value),
        { action, value },
      );
      const current = await report();
      parity(current);
      return current.production;
    };
    const first = await report();
    parity(first);
    assert.deepEqual(first.mounted, ["fixed", "production"]);
    assert.deepEqual(first.production.entries, []);
    assert.deepEqual(first.production.events, []);
    assert.equal(first.production.facts.executions, null);
    assert.equal(first.production.facts.allActivity, false);
    assert.equal(first.production.facts.understandingOpen, false);
    assert.equal(first.production.facts.mobileCollaboration, false);
    let current = await run("scope", "A");
    assert.equal(current.identity.execution, "A");
    assert.deepEqual(current.identity.memories, [["A", "A"]]);
    current = await run("unrelated");
    assert.deepEqual(current.identity.memories, [["A", "A"]]);
    current = await run("tab", "settings");
    assert.equal(current.facts.subjectView, "settings");
    assert.equal(current.identity.execution, "A");
    current = await run("close");
    assert.equal(current.facts.executions, null);
    assert.deepEqual(current.identity.memories, [["A", "A"]]);
    current = await run("surface", "B");
    assert.deepEqual(current.identity.memories, [["A", "A"]]);
    await run("tabPreference", "activity");
    current = await run("show");
    assert.deepEqual(current.facts.activityScope, {
      projectId: "first-project",
      conversationId: "conversation-B",
      artifactId: null,
    });
    assert.deepEqual(
      current.entries.map(([key]) => key),
      ["A", "B"],
    );
    current = await run("scope", "B");
    assert.equal(current.identity.execution, "B");
    await run("understanding", true);
    current = await run("execution", null);
    assert.deepEqual(current.entries[1], ["B", { view: "understanding" }]);
    await run("collaboration");
    current = await run("understanding", false);
    assert.equal(current.facts.collaborationVisible, true);
    assert.deepEqual(current.entries[1], ["B", { view: "collaboration" }]);
    current = await run("tab", "settings");
    assert.equal(current.facts.collaborationVisible, false);
    assert.deepEqual(current.entries[1], ["B", { view: "collaboration" }]);
    await run("close");
    await run("surface", "A");
    await run("tabPreference", "activity");
    current = await run("show");
    assert.equal(current.identity.execution, "A");
    current = await run("logo", "activity");
    assert.equal(current.facts.allActivity, true);
    assert.equal(current.facts.executions?.inputId, undefined);
    current = await run("inspect", "input-A");
    assert.equal(current.facts.executions?.inputId, "input-A");
    assert.equal(
      current.events.some(
        (event) => event[0] === "history" || event[0] === "snapshot",
      ),
      false,
    );
    const nodes = await page.locator("output").elementHandles();
    await run("mount", false);
    assert.deepEqual((await report()).mounted, []);
    for (const node of nodes)
      assert.equal(
        await node.evaluate((element) => element.isConnected),
        false,
      );
    await run("mount", true);
    current = (await report()).production;
    assert.deepEqual(current.entries, []);
    assert.deepEqual(current.events, []);
    assert.equal(current.facts.allActivity, false);
    assert.equal(current.facts.executions, null);
    assert.deepEqual(errors, []);
    assert.deepEqual(queries, []);
  },
);
