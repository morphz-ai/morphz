import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, transformWithOxc } from "vite";

// Existing private React/Vite framework. Real Host/origin, draft hooks/storage,
// work-surface derivation and the three registrations run under StrictMode.
// External Client/history/authorization projections are controlled. This is
// not a compiled App, application HTTP, Platform, Runtime or native acceptance.
const source = `
import React,{StrictMode,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';
import {draftKey,scopedStorage,storageScope} from '/src/local-preferences.ts';
import {deriveWorkSurface} from '/src/host/work-surface.ts';
import {createExchangeDraftCommands,useExchangeInputDraftState,useExchangeConversationDraftState,useExchangeDiscardedDraftState} from '/src/host/exchange-drafts.ts';
import {NavigationHostLifetime,NavigationOriginLifetime,useWorkspaceNavigationHost,useWorkspaceNavigationOrigin} from '/src/host/use-workspace-navigation-host.ts';
import {isNavigationPreferenceChange,mergeNavigationPreferences} from '/src/host/use-workspace-navigation.ts';
import {createPrivateProjectConversationScope,usePrivateProjectContentScope,useCommittedConversationDraftRetirement,usePrivateConversationHistorySelection} from '/src/host/private-project-conversation-scope.ts';
import {createFixedPrivateProjectConversationScope,useFixedPrivateProjectContentScope,useFixedCommittedConversationDraftRetirement,useFixedPrivateConversationHistorySelection} from '/@fs/${resolve("tests/fixtures/private-project-conversation-scope-c35b9fde.ts")}';
const now='2026-10-04T00:00:00.000Z',modes=['fixed','production'],domain={},apis={},old={},closed={},hostIds=new WeakMap();let nextHost=0,parent;
function makeBoot(account,mode){const workspace=initialWorkspace(now);workspace.projects.push({...workspace.projects[0],id:'created-project',kind:'project',title:'新增项目'});return {centerId:'center-'+account+'-'+mode,principalId:'local-owner',csrfToken:'session-'+account,workspace,capabilities:{teamAuthentication:false},runtime:{messages:[]},localSavedInputIds:[],scriptLibrary:[]};}
function seed(account){for(const mode of modes){const scope='center-'+account+'-'+mode+':local-owner';localStorage.setItem('morphzwork:'+scope+':library-view:all-content',JSON.stringify({scope:'legacy-scope-'+account}));const storage=scopedStorage(scope);storage.writeLocal('preferences',{view:'projects',projectId:'first-project',projectOpen:true,artifactId:null,interactions:{'first-project':'history','created-project':'history'}});storage.writeLocal(draftKey('conversations'),{'first-project':{id:'pending-'+account,projectId:'first-project',title:'未提交标题',inputId:'first-input-'+account}});storage.writeLocal(draftKey('inputs'),{['pending-'+account+':object']:{body:'未发送原文 '+account,selection:'精确引用',revision:2}});domain[mode]={boot:makeBoot(account,mode),events:[],history:[],manual:null,prepared:null,privateMounts:0};}}
seed('A');
function Private({mode,host,boot}){
 const d=domain[mode],origin=useWorkspaceNavigationOrigin(host),events=d.events;
 const storage={readLocal(key,fallback){events.push(['read',key]);return host.storage.readLocal(key,fallback);},writeLocal(key,value){events.push(['write',key]);host.storage.writeLocal(key,value);}};
 const content=mode==='fixed'?useFixedPrivateProjectContentScope(storage):usePrivateProjectContentScope(storage);
 const [unrelated,setUnrelated]=useState(0),inputs=useExchangeInputDraftState(storage),[creating,setCreating]=useState('initial'),conversations=useExchangeConversationDraftState(storage),discarded=useExchangeDiscardedDraftState(storage),[executions,setExecutions]=useState('initial'),sendPending=useRef(false),first=useRef({setter:content.setContentScope,conversationRef:conversations.ref,inputSetter:inputs.set,conversationSetter:conversations.set});
 const commands=createExchangeDraftCommands({inputs,conversations,discarded,storage,onNotice:message=>events.push(['notice',message])});
 const state=boot.workspace,prefs=host.prefs,navigation=host.navigation,navigationGeneration=navigation.navigationGeneration;
 const surface=deriveWorkSurface({state,prefs,principalId:boot.principalId,teamAuthentication:boot.capabilities.teamAuthentication,scriptLibrary:boot.scriptLibrary,contentScope:content.contentScope,conversationDrafts:conversations.value,restoredPlace:null});
 useEffect(()=>{events.push(['retire-before']);},[state.conversations]);
 const observed={retireCommittedConversations(value){events.push(['retire',value?.map(c=>c.id)]);commands.retireCommittedConversations(value);}};
 if(mode==='fixed')useFixedCommittedConversationDraftRetirement(observed,state);else useCommittedConversationDraftRetirement(observed,state);
 useEffect(()=>{events.push(['retire-after']);},[state.conversations]);
 const scope=d.manual??{projectId:surface.conversationProjectId,conversationId:surface.conversationId,selectedDraft:surface.selectedDraft};
 const client={selectHistoryScope(value){d.history.push({...value,client:unrelated});events.push(['history',value]);return new Promise(()=>{});}};
 useEffect(()=>{events.push(['history-before']);},[scope.projectId,scope.conversationId,scope.selectedDraft?.id]);
 const historyPorts={client,selectedDraft:scope.selectedDraft,conversationProjectId:scope.projectId,conversationId:scope.conversationId};
 if(mode==='fixed')useFixedPrivateConversationHistorySelection(historyPorts);else usePrivateConversationHistorySelection(historyPorts);
 useEffect(()=>{events.push(['history-after']);},[scope.projectId,scope.conversationId,scope.selectedDraft?.id]);
 function prefer(change){if(!origin.isActive())return;events.push(['prefer',change]);if(isNavigationPreferenceChange(change)){navigation.beginIntent();navigation.resetPreferenceNavigation();}host.writePreferences(previous=>mergeNavigationPreferences(previous,change),'settings',origin.capturePrivateCommit());}
 function continueNavigation(change,intent,destination){const current=host.currentProjection();if(!navigation.isCurrent(intent.generation)||!current||!destination(current))return;if(isNavigationPreferenceChange(change)){intent.generation=navigation.beginIntent();navigation.resetPreferenceNavigation();}events.push(['continued',change]);host.writePreferences(previous=>mergeNavigationPreferences(previous,change),'settings',destination);}
 const ports={render:{state,prefs,navigationProject:surface.navigationProject,project:surface.project,sharedDefault:surface.sharedDefault,defaultConversation:surface.defaultConversation,conversationId:surface.conversationId,hasConversationDraft:id=>Object.entries(inputs.value).some(([key,draft])=>key.startsWith(id+':')&&!!draft.body.trim()),personalSpace:kind=>state.projects.find(p=>p.kind===kind&&p.ownerPrincipalId===boot.principalId)},origin,draftCommands:commands,sendPending,navigation:{navigationGeneration,isCurrent:navigation.isCurrent,setWebsiteIntent:navigation.setExplicitWebsiteIntent,prefer,continueNavigation},host,privateUi:{setContentScope:content.setContentScope,setCreating,setExecutions},exchange:{keepExchangeOpen(){events.push(['keepOpen']);},requestConversationFocus(id,generation){events.push(['focus',id,generation]);}},onNotice:message=>events.push(['notice',message])};
 const scopeCommands=mode==='fixed'?createFixedPrivateProjectConversationScope(ports):createPrivateProjectConversationScope(ports);
 useLayoutEffect(()=>{d.privateMounts++;return()=>{closed[mode]=(closed[mode]??0)+1;};},[]);
 apis[mode]={host,origin,commands:scopeCommands,report(){return {contentScope:content.contentScope,unrelated,creating,executions,conversationId:surface.conversationId,selectedDraft:surface.selectedDraft?.id??null,inputs:inputs.value,conversations:conversations.value,trash:discarded.value,stable:{contentSetter:first.current.setter===content.setContentScope,conversationRef:first.current.conversationRef===conversations.ref,inputSetter:first.current.inputSetter===inputs.set,conversationSetter:first.current.conversationSetter===conversations.set}};},run(action,value){if(action==='tick')setUnrelated(v=>v+1);if(action==='scope')scopeCommands.selectContentScope(value);if(action==='rawScope')content.setContentScope(value);if(action==='interaction')prefer({interactions:{'created-project':value}});if(action==='create')void scopeCommands.createProjectConversation('first-project','不能重命名');if(action==='discard')scopeCommands.discardConversationDraft('pending-'+parent.account);if(action==='restoreDraft')scopeCommands.restoreConversationDraft('pending-'+parent.account);if(action==='prepare')d.prepared=scopeCommands.prepareCreatedProject();if(action==='capture')old[mode]={commands:scopeCommands,prepared:scopeCommands.prepareCreatedProject(),origin,host};}};
 return <><NavigationOriginLifetime origin={origin}/><article id={'private-'+mode}><output>{content.contentScope}</output></article></>;
}
function Host({mode,account}){const[tick,setTick]=useState(0),d=domain[mode],host=useWorkspaceNavigationHost({identity:{centerId:'center-'+account+'-'+mode,principalId:'local-owner',csrfToken:'session-'+account},getSnapshot:()=>d.boot});if(!hostIds.has(host.navigation.navigationGeneration))hostIds.set(host.navigation.navigationGeneration,++nextHost);d.host=host;d.publish=()=>setTick(v=>v+1);return <section data-tick={tick}><NavigationHostLifetime host={host}/>{d.boot&&<Private mode={mode} host={host} boot={d.boot}/>}</section>;}
function Fixture(){const[account,setAccount]=useState('A');parent={account,setAccount};return <main>{modes.map(mode=><Host key={account+mode} mode={mode} account={account}/>)}</main>;}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Fixture/></StrictMode>));
function report(){const result={};for(const mode of modes){const d=domain[mode],api=apis[mode],scope='center-'+parent.account+'-'+mode+':local-owner';result[mode]={...api.report(),hostId:hostIds.get(d.host.navigation.navigationGeneration),generation:d.host.navigation.navigationGeneration.current,prefs:d.host.prefs,mounted:!!document.getElementById('private-'+mode),events:d.events,history:d.history,privateMounts:d.privateMounts,closed:closed[mode]??0,saved:scopedStorage(scope).readLocal(draftKey('conversations'),{}),allDraftKeys:Object.keys(localStorage).filter(key=>key.includes(scope+':draft:')),legacyScope:localStorage.getItem('morphzwork:'+scope+':library-view:all-content')};}return result;}
Object.assign(window,{privateScopeFixture:{report,async run(action,value){flushSync(()=>{
 if(action==='identity'){seed(value);parent.setAccount(value);return;}
 if(action==='globalScope'){storageScope('unrelated','unrelated');return;}
 for(const mode of modes){const d=domain[mode],api=apis[mode];
  if(action==='clear'){d.boot=null;d.publish();}
  else if(action==='restore'){d.boot=makeBoot(parent.account,mode);d.publish();}
  else if(action==='refresh'){d.boot={...d.boot,workspace:{...d.boot.workspace}};d.publish();}
  else if(action==='conversationCopy'){d.boot={...d.boot,workspace:{...d.boot.workspace,conversations:[...d.boot.workspace.conversations]}};d.publish();}
  else if(action==='persistConversation'){d.boot={...d.boot,workspace:{...d.boot.workspace,conversations:[...d.boot.workspace.conversations,{id:'pending-'+parent.account,projectId:'first-project',title:'持久会话',revision:1,createdAt:now,updatedAt:now,archivedAt:null}]}};d.publish();}
  else if(action==='historyPending'){d.manual={projectId:'first-project',conversationId:'reserved-history',selectedDraft:{id:'reserved-history'}};d.publish();}
  else if(action==='historyDraftSameId'){d.manual={...d.manual,selectedDraft:{id:'reserved-history'}};d.publish();}
  else if(action==='historyPersisted'){d.manual={...d.manual,selectedDraft:undefined};d.publish();}
  else if(action==='historyEmpty'){d.manual={projectId:'',conversationId:'reserved-history',selectedDraft:undefined};d.publish();}
  else if(action==='historyProject'){d.manual={projectId:'another-project',conversationId:'reserved-history',selectedDraft:undefined};d.publish();}
  else if(action==='externalStoredScope'){scopedStorage('center-'+parent.account+'-'+mode+':local-owner').writeLocal('library-view:all-content',{scope:value});}
  else if(action==='oldScope'){old[mode].commands.selectContentScope(value);}
  else if(action==='complete'){d.prepared?.('created-project','project');}
  else if(action==='oldComplete'){old[mode].prepared('created-project','project');}
  else if(action==='revoke'){d.boot={...d.boot,workspace:{...d.boot.workspace,projects:d.boot.workspace.projects.filter(p=>p.id!=='created-project')}};d.publish();}
  else api.run(action,value);
 }
});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return report();},unmount(){flushSync(()=>root.unmount());}}});
`;

type Lane = {
  contentScope: string;
  unrelated: number;
  creating: string | null;
  executions: string | null;
  conversationId: string;
  selectedDraft: string | null;
  inputs: Record<string, { body: string }>;
  conversations: Record<string, { id: string; inputId: string; title: string }>;
  trash: Record<string, unknown>;
  stable: Record<string, boolean>;
  hostId: number;
  generation: number;
  prefs: {
    projectId: string;
    selectedConversations?: Record<string, string>;
    interactions?: Record<string, string>;
  };
  mounted: boolean;
  events: unknown[][];
  history: { projectId: string; conversationId: string; client: number }[];
  privateMounts: number;
  closed: number;
  saved: Record<string, { id: string; inputId: string }>;
  allDraftKeys: string[];
  legacyScope: string;
};
type Report = { fixed: Lane; production: Lane };
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
const available = executable
  ? existsSync(executable)
  : existsSync(chromium.executablePath());
test(
  "fixed and actual private-scope registrations preserve StrictMode lifetime, effect dependencies, scoped legacy storage and captured completions",
  {
    skip: available
      ? false
      : "install the existing Playwright Chromium capability or set MORPHZ_TEST_BROWSER_EXECUTABLE for isolated actual React mounting",
  },
  async (context) => {
    const cacheDir = mkdtempSync(join(tmpdir(), "morphz-private-scope-vite-"));
    context.after(() => rmSync(cacheDir, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "isolated-private-project-conversation-scope",
          resolveId(id) {
            if (id === "/__private-scope.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__private-scope.tsx")
              return transformWithOxc(source, "private-scope.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__private-scope") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__private-scope.tsx"></script></body></html>',
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
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const page = await browser.newPage(),
      errors: string[] = [],
      queries: string[] = [];
    let phase = "mount",
      complete = false;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        ["fetch", "xhr"].includes(request.resourceType()) &&
        !request.url().includes("/@vite/")
      )
        queries.push(request.url());
    });
    context.after(() => {
      if (!complete)
        context.diagnostic(JSON.stringify({ phase, errors, queries }));
    });
    await page.goto(`http://127.0.0.1:${address.port}/__private-scope`);
    await page.waitForSelector("#private-production");
    const read = () =>
      page.evaluate(() =>
        Reflect.get(window, "privateScopeFixture").report(),
      ) as Promise<Report>;
    const run = (action: string, value: unknown = null) =>
      page.evaluate(
        ([action, value]) =>
          Reflect.get(window, "privateScopeFixture").run(action, value),
        [action, value],
      ) as Promise<Report>;
    function parity(result: Report) {
      const normalized = (lane: Lane) => {
        const { hostId, allDraftKeys, ...facts } = lane;
        assert.ok(hostId);
        assert.equal(
          allDraftKeys.every((key) => key.includes(":draft:")),
          true,
        );
        return facts;
      };
      assert.deepEqual(normalized(result.production), normalized(result.fixed));
      for (const value of Object.values(result.production.stable))
        assert.equal(value, true);
      return result.production;
    }
    let initial = parity(await read());
    assert.equal(initial.contentScope, "legacy-scope-A");
    assert.equal(initial.privateMounts, 2);
    assert.equal(initial.closed, 1);
    assert.equal(
      initial.events.filter(
        (e) => e[0] === "read" && e[1] === "library-view:all-content",
      ).length,
      2,
    );
    const retire = initial.events
      .filter((e) =>
        ["retire-before", "retire", "retire-after"].includes(String(e[0])),
      )
      .map((e) => e[0]);
    assert.deepEqual(retire, [
      "retire-before",
      "retire",
      "retire-after",
      "retire-before",
      "retire",
      "retire-after",
    ]);
    const history = initial.events
      .filter((e) =>
        ["history-before", "history", "history-after"].includes(String(e[0])),
      )
      .map((e) => e[0]);
    assert.deepEqual(history, [
      "history-before",
      "history",
      "history-after",
      "history-before",
      "history",
      "history-after",
    ]);
    phase = "stable hooks and unchanged effect dependencies";
    const reads = initial.events.filter((e) => e[0] === "read").length,
      retirements = initial.events.filter((e) => e[0] === "retire").length,
      historyReads = initial.history.length,
      host = initial.hostId;
    let value = parity(await run("tick"));
    assert.equal(value.history.length, historyReads);
    assert.equal(value.events.filter((e) => e[0] === "read").length, reads);
    value = parity(await run("refresh"));
    assert.equal(value.hostId, host);
    assert.equal(
      value.events.filter((e) => e[0] === "retire").length,
      retirements,
    );
    assert.equal(value.history.length, historyReads);
    value = parity(await run("conversationCopy"));
    assert.equal(
      value.events.filter((e) => e[0] === "retire").length,
      retirements + 1,
    );
    assert.equal(value.history.length, historyReads);
    phase = "reserved draft history and exact three dependencies";
    value = parity(await run("historyPending"));
    assert.equal(value.history.length, historyReads);
    value = parity(await run("historyDraftSameId"));
    assert.equal(value.history.length, historyReads);
    value = parity(await run("tick"));
    assert.equal(value.history.length, historyReads);
    value = parity(await run("historyPersisted"));
    assert.equal(value.history.length, historyReads + 1);
    assert.equal(value.history.at(-1)!.conversationId, "reserved-history");
    value = parity(await run("historyEmpty"));
    assert.equal(value.history.length, historyReads + 1);
    value = parity(await run("historyProject"));
    assert.equal(value.history.length, historyReads + 2);
    assert.equal(value.history.at(-1)!.projectId, "another-project");
    phase = "actual draft owner and original storage keys";
    value = parity(await run("globalScope"));
    value = parity(await run("create"));
    assert.equal(value.selectedDraft, "pending-A");
    assert.equal(
      value.conversations["first-project"]!.inputId,
      "first-input-A",
    );
    assert.equal(value.conversations["first-project"]!.title, "未提交标题");
    value = parity(await run("create"));
    assert.equal(value.conversations["first-project"]!.id, "pending-A");
    assert.equal(value.inputs["pending-A:object"]!.body, "未发送原文 A");
    const focus = value.events.filter((e) => e[0] === "focus");
    assert.equal(focus.length, 2);
    assert.equal(focus.at(-1)![2], value.generation);
    const contentReads = value.events.filter(
      (e) => e[0] === "read" && e[1] === "library-view:all-content",
    ).length;
    value = parity(await run("rawScope", "local-unsaved-scope"));
    await run("externalStoredScope", "remount-stored-scope");
    value = parity(await run("tick"));
    assert.equal(value.contentScope, "local-unsaved-scope");
    assert.equal(
      value.events.filter(
        (e) => e[0] === "read" && e[1] === "library-view:all-content",
      ).length,
      contentReads,
    );
    phase = "captured active origin and same-Host private retirement";
    value = parity(await run("capture"));
    const capturedGeneration = value.generation;
    value = parity(await run("clear"));
    assert.equal(value.mounted, false);
    assert.equal(value.hostId, host);
    value = parity(await run("oldScope", "must-not-write"));
    assert.equal(value.contentScope, "local-unsaved-scope");
    value = parity(await run("oldComplete"));
    assert.equal(value.prefs.projectId, "first-project");
    value = parity(await run("restore"));
    assert.equal(value.mounted, true);
    assert.equal(value.hostId, host);
    assert.equal(value.contentScope, "remount-stored-scope");
    assert.equal(value.generation, capturedGeneration);
    assert.equal(value.saved["first-project"]!.id, "pending-A");
    const newPrivateState = {
        creating: value.creating,
        executions: value.executions,
      },
      focusBefore = value.events.filter((e) => e[0] === "focus").length;
    value = parity(await run("interaction", "recent"));
    assert.equal(value.prefs.interactions!["created-project"], "recent");
    assert.equal(value.generation, capturedGeneration);
    value = parity(await run("oldComplete"));
    assert.equal(value.prefs.projectId, "created-project");
    assert.equal(
      value.prefs.selectedConversations!["created-project"],
      "local-dialogue",
    );
    assert.equal(value.prefs.interactions!["created-project"], "history");
    assert.deepEqual(
      { creating: value.creating, executions: value.executions },
      newPrivateState,
    );
    assert.equal(
      value.events.filter((e) => e[0] === "focus").length,
      focusBefore,
    );
    phase = "latest authorization rejection and whole-Host retirement";
    value = parity(await run("prepare"));
    await run("revoke");
    value = parity(await run("complete"));
    assert.equal(value.events.filter((e) => e[0] === "continued").length, 1);
    value = parity(await run("capture"));
    value = parity(await run("identity", "B"));
    assert.notEqual(value.hostId, host);
    assert.equal(value.contentScope, "legacy-scope-B");
    assert.equal(value.saved["first-project"]!.id, "pending-B");
    const newHostGeneration = value.generation;
    value = parity(await run("oldComplete"));
    assert.equal(value.prefs.projectId, "first-project");
    assert.equal(value.generation, newHostGeneration);
    phase =
      "actual reserved-ID selection and authoritative first-send retirement";
    const beforePendingHistory = value.history.length;
    value = parity(await run("create"));
    assert.equal(value.selectedDraft, "pending-B");
    assert.equal(value.history.length, beforePendingHistory);
    value = parity(await run("persistConversation"));
    assert.equal(value.selectedDraft, null);
    assert.deepEqual(value.conversations, {});
    assert.deepEqual(value.saved, {});
    assert.equal(value.inputs["pending-B:object"]!.body, "未发送原文 B");
    assert.equal(value.history.at(-1)!.conversationId, "pending-B");
    assert.equal(value.history.length, beforePendingHistory + 1);
    await page.evaluate(() =>
      Reflect.get(window, "privateScopeFixture").unmount(),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(queries, []);
    complete = true;
  },
);
