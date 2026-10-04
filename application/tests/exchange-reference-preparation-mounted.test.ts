import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";

// Actual React/Provider/SearchDocuments/ArtifactEditor/SelectionActions and
// scoped draft owner; controlled Client/navigation/Host ports, not App/HTTP,
// authorization, Runtime, native focus or actual receipt transaction evidence.
const source = `
import React,{StrictMode,useState,useRef,useEffect} from 'react';
import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {createExchangeReferenceCommands,useExchangeQuoteRevealState,useExchangeQuoteRevealCommit} from '/src/host/exchange-reference-commands.ts';
import {createFixedExchangeReferencePreparations,useFixedExchangeQuoteRevealState,useFixedExchangeQuoteRevealCommit} from '/@fs/${resolve("tests/fixtures/exchange-reference-preparation-75ba44c0.tsx")}';
import {useExchangeInputDraftState,useExchangeConversationDraftState,useExchangeDiscardedDraftState,createExchangeDraftCommands} from '/src/host/exchange-drafts.ts';
import {scopedStorage,storageScope,draftKey} from '/src/local-preferences.ts';
import {replaceComposerSurface,updateComposerDraft} from '/src/composer-drafts.ts';
import {readWorkSurfaceDraft,workSurfaceConversationId} from '/src/host/work-surface.ts';
import {TextQuoteProvider,TextQuoteDrafts} from '/src/TextQuotes.tsx';import {SearchDocuments} from '/src/LibraryDialogs.tsx';import {ArtifactEditor} from '/src/ArtifactEditor.tsx';
import '/src/styles.css';import '/src/ui.css';import '/src/workflow.css';import '/src/ui/dialog-surface.css';import '/src/visual-system.css';import '/src/exchange-layout.css';import '/src/inspector.css';import '/src/task-list.css';import '/src/content-catalog.css';import '/src/browser-bookmarks.css';import '/src/text-quotes.css';import '/src/profile-avatar.css';import '/src/personality-profile.css';import '/src/execution-activity.css';import '/src/execution-thread-groups.css';import '/src/application-icons.css';
const fixed=new URL(location.href).searchParams.get('lane')==='fixed',read=fixed?useFixedExchangeQuoteRevealState:useExchangeQuoteRevealState,commit=fixed?useFixedExchangeQuoteRevealCommit:useExchangeQuoteRevealCommit;
const empty={body:'',selection:'',revision:null},scope='center-test:human-test',storage=scopedStorage(scope);storageScope(scope);
const events=[],requests=[],navigation=[],captures=[],ids=new WeakMap(),motion=[];let nextId=0,api,last,unmounted=false,alive=true;
const id=value=>{if(!value)return null;if(!ids.has(value))ids.set(value,++nextId);return ids.get(value);};
const author={principalId:'human-test',actantId:'human'},createdAt='2026-10-04T00:00:00.000Z';
const artifact=(objectId,projectId)=>({id:objectId,projectId,title:objectId==='A'?'原件A':'原件B',revision:2,content:{kind:'document',markdown:'原文第一段。完整选文与版本保留。'},createdBy:author,createdAt,updatedAt:createdAt,source:null,versions:[{revision:1,title:'原件旧版',content:{kind:'document',markdown:'历史原文。完整旧版选文。'},author,createdAt},{revision:2,title:'当前原件',content:{kind:'document',markdown:'原文第一段。完整选文与版本保留。'},author,createdAt}]});
const originalQuote={id:'11111111-1111-4111-8111-111111111111',source:{kind:'artifact',projectId:'projectA',artifactId:'A',revision:2,title:'原件A'},text:'原文第一段',comment:'旧评论'};
storage.writeLocal(draftKey('inputs'),{'default:A':{...empty,body:'原未发送草稿',selection:'原旧选区',revision:1,annotation:true,intent:'document',taskResult:{taskId:'task',revision:4},model:'model-original',reasoningEffort:'high'},'default:quotes':{...empty,textQuotes:[]}});
function request(kind,args,signal){events.push([kind,...args]);const index=requests.length;requests.push({kind,args,signal,index,aborted:()=>signal?.aborted??false});if(signal)signal.addEventListener('abort',()=>events.push(['abort',kind,index]),{once:true});return Promise.resolve(kind==='search'?{hits:[{artifactId:'B',projectId:'projectB',projectTitle:'项目B',title:'搜索原件B',kind:'document',revision:1,excerpt:'历史原文片段',matchedIn:'content',quote:'确切搜索选文',page:0,createdAt,updatedAt:createdAt,source:null}],total:1,hasMore:false,workspaceRevision:1}:kind==='recent'?{items:[],hasMore:false}:[]);}
function Frame(){
 const[before,setBefore]=useState('before'),inputs=useExchangeInputDraftState(storage),conversations=useExchangeConversationDraftState(storage),discarded=useExchangeDiscardedDraftState(storage),sendPending=useRef(false);
 const{quoteReveal,setQuoteReveal}=read();
 const draftCommands=createExchangeDraftCommands({inputs,conversations,discarded,storage,onNotice:message=>events.push(['notice',message])});
 const[facts,setFacts]=useState({projectId:'projectA',conversationId:'default',artifactId:'A',revision:null,searchOpen:false,visible:true,disabled:false,generation:9,team:false}),[after,setAfter]=useState('after');
 const input=useRef(null),exchange=useRef(null),main=useRef(null),generation=useRef(9);generation.current=facts.generation;
 const contextKey=facts.conversationId+':'+facts.artifactId,quoteKey=facts.conversationId+':quotes',workSurface={project:{id:facts.projectId},conversationId:facts.conversationId,defaultConversation:facts.team?facts.projectId:'default',contextKey,quoteKey,legacyContextKey:facts.projectId+':'+facts.artifactId};
 const drafts=inputs.value,{draft}=readWorkSurfaceDraft(workSurface,drafts,empty),conversationId=facts.conversationId;
 function conversationKey(workspaceId){return workSurfaceConversationId(workSurface,{reserved:'reserved-draft'},workspaceId);}
 commit(conversationId,setQuoteReveal);
 const[toolbarWitness,setToolbarWitness]=useState('toolbar');
 const setDraft=(key,value)=>{events.push(['replace',key,value]);if(!alive)return;draftCommands.writeInputs(previous=>replaceComposerSurface(previous,key,empty,value));};
 const updateDraft=(key,update)=>{events.push(['update',key]);if(!alive)return;draftCommands.writeInputs(previous=>updateComposerDraft(previous,key,empty,update));};
 const frame=callback=>{events.push(['frame']);return requestAnimationFrame(callback);};
 const showInput=()=>{events.push(['show']);setFacts(old=>({...old,visible:true}));},setInteraction=value=>events.push(['interaction',value]);
 const openObject=(...args)=>{const index=navigation.length;events.push(['open',index,...args]);return new Promise(resolve=>navigation.push({args,resolve,settled:false}));};
 const client={boot:{csrfToken:'csrf-test',workspace:{revision:1,projects:[{id:'projectA',title:'项目A'},{id:'projectB',title:'项目B'}]}},contentCatalogVersion:'v1',contentCatalog:[],workspaceChangeRevision:0,search:(query,signal)=>request('search',[query],signal),listContentPage:(query,signal)=>request('recent',[query],signal),workRelationsFor:(objectId,signal)=>request('relations',[objectId],signal),resolveCatalogContent:async()=>undefined,resolveArtifact:async()=>undefined,execute:async()=>{throw new Error('fixture never authorizes writing');}};
 const options={render:{conversationId,contextKey,workspace:undefined,drafts,draft,sending:facts.disabled,emptyDraft:empty},scope:{conversationKey},origin:{isActive:()=>alive},navigation:{navigationGeneration:generation,isCurrent:value=>value===generation.current,openObject,openScriptLocation:async()=>undefined,openBrowser:async()=>undefined,activateApplication(){},selectConversation(projectId,id){setFacts(old=>({...old,projectId,conversationId:id}));},setExplicitWebsiteIntent(){}},client,drafts:{replace:setDraft,update:updateDraft},exchange:{showInput,setInteraction,keepOpen(){events.push(['keep']);},requestConversationFocus(){},scheduleSearchQuoteFocus(){frame(()=>{if(!exchange.current?.contains(document.activeElement))input.current?.focus();});},scheduleCommentComposerFocus(){frame(()=>input.current?.focus({preventScroll:true}));}},quotes:{clearSelection:()=>window.getSelection()?.removeAllRanges(),reveal:()=>false,setReveal:setQuoteReveal},onNotice:message=>events.push(['notice',message])};
 const current=createExchangeReferenceCommands(options),commands=fixed?{...current,...createFixedExchangeReferencePreparations({openObject,navigationGeneration:generation,conversationKey,setDraft,updateDraft,setInteraction,showInput,contextKey,drafts,draft,emptyDraft:empty,requestAnimationFrame:frame,exchange,input,document})}:current;
 const shown=artifact(facts.artifactId,facts.projectId),state={actants:[{id:'human',name:'原作者'}],artifacts:[shown],projects:client.boot.workspace.projects,conversations:[],applicationInstances:[]};
 last={facts,draft,drafts,quoteReveal,setQuoteReveal,before,after,toolbarWitness,commands};
 api={set(value){setFacts(old=>({...old,...value}));},reveal(value){setQuoteReveal(value);},capture(){captures.push(setQuoteReveal);},captured(index,value){captures[index](value);},concurrent(body){draftCommands.writeInputs(previous=>({...previous,[contextKey]:{...(previous[contextKey]??empty),body}}));},quoteChange(values){return commands.changeTextQuotes(values);},searchQuote(){return commands.prepareSearchQuote('B','projectB',1,'确切搜索选文',0);},select(){return commands.selectArtifactQuote('原件选区',2,0,false);},focus(){return commands.focusCommentComposer();},witness(){setBefore('before-new');setAfter('after-new');setToolbarWitness('toolbar-new');},openMessage(){return current.openTextQuote({id:originalQuote.id,source:{kind:'message',projectId:facts.projectId,conversationId,messageId:'message',createdAt},text:'message quote',comment:''});}};
 return <TextQuoteProvider quotes={draft.textQuotes} scope={conversationId} reveal={quoteReveal} disabled={facts.disabled} onChange={commands.changeTextQuotes} onEngage={()=>events.push(['engage'])} onFocusComposer={commands.focusCommentComposer} onOpen={quote=>void current.openTextQuote(quote)} onNotice={message=>events.push(['notice',message])}>
  <div className="app without-collaboration" data-accent="cyan" data-appearance="light"><aside className="sidebar" aria-hidden="true"/><div className="workspace"><header className="topbar"><button id="search-trigger" onClick={()=>setFacts(old=>({...old,searchOpen:true}))}>搜索资料</button><button id="outside">原画布按钮</button></header><div className="workspace-body"><div className="primary-panel"><main ref={main} aria-label="主工作区"><ArtifactEditor key={shown.id+':'+(facts.revision??'current')} artifact={shown} state={state} client={client} onOpen={()=>events.push(['consumer-open'])} onSelect={commands.selectArtifactQuote} onNotice={message=>events.push(['notice',message])} initialRevision={facts.revision} toolbarTarget={null} onTaskInput={()=>{}}/></main></div></div>
  {facts.visible&&<div className="conversation-exchange" ref={exchange}><form className="composer" onSubmit={event=>event.preventDefault()}><TextQuoteDrafts quotes={draft.textQuotes} disabled={facts.disabled}/><textarea ref={input} id="draft" aria-label="夹具原输入" value={draft.body} onChange={event=>updateDraft(contextKey,old=>({...old,body:event.target.value}))}/><button id="inside" type="button">原输入内按钮</button></form></div>}
  </div>{facts.searchOpen&&<SearchDocuments client={client} onClose={()=>{events.push(['search-close']);setFacts(old=>({...old,searchOpen:false}));}} onOpen={()=>events.push(['search-open'])} onQuote={commands.prepareSearchQuote}/>}</div>
 </TextQuoteProvider>;
}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Frame/></StrictMode>));
function captureMotion(){const dialog=document.querySelector('.search-dialog'),quote=document.querySelector('.text-quote-editor');motion.push({dialog:dialog?{name:getComputedStyle(dialog).animationName,duration:getComputedStyle(dialog).animationDuration}:null,quote:quote?{name:getComputedStyle(quote).animationName,duration:getComputedStyle(quote).animationDuration}:null,effects:document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>({name:a.animationName,timing:a.effect.getTiming(),keyframes:a.effect.getKeyframes()}))});}
async function settle(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
function geometry(node){if(!node)return null;const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return {x:Math.round(rect.x*100)/100,y:Math.round(rect.y*100)/100,width:Math.round(rect.width*100)/100,height:Math.round(rect.height*100)/100,color:style.color,background:style.backgroundColor,border:style.border,shadow:style.boxShadow};}
function snapshot(){const active=document.activeElement,draft=document.querySelector('#draft'),dialog=document.querySelector('.search-dialog'),quote=document.querySelector('.text-quote-editor'),paper=document.querySelector('.object-paper');return {facts:last.facts,draft:last.draft,drafts:last.drafts,stored:storage.readLocal(draftKey('inputs'),{}),quoteReveal:last.quoteReveal,setterId:id(last.setQuoteReveal),captured:captures.map(id),witnesses:[last.before,last.after,last.toolbarWitness],navigation:navigation.map(n=>({args:n.args,settled:n.settled})),requests:requests.map(q=>({kind:q.kind,args:q.args,aborted:q.aborted()})),events,focusCalls:window.focusCalls,motion,unmounted,dom:{dialog:dialog?.outerHTML??null,quote:quote?.outerHTML??null,paper:paper?.outerHTML??null,chip:document.querySelector('.text-quote-drafts')?.outerHTML??null,dialogId:id(dialog),quoteId:id(quote),paperId:id(paper),source:paper?.dataset.textSource??null,quoteParent:quote?.parentElement?.className??null,searchModal:dialog?.matches(':modal')??false},active:{id:active?.id??'',label:active?.getAttribute('aria-label')??'',tag:active?.tagName??''},input:draft?{value:draft.value,start:draft.selectionStart,end:draft.selectionEnd}:null,geometry:{workspace:geometry(document.querySelector('.workspace')),main:geometry(document.querySelector('main')),dialog:geometry(dialog),quote:geometry(quote)}};}
captureMotion();Object.assign(window,{referenceFixture:{snapshot,settle,quote:originalQuote,async run(action,value){let returned;flushSync(()=>{if(action==='set')api.set(value);else if(action==='reveal')api.reveal(value);else if(action==='capture')api.capture();else if(action==='captured')api.captured(value.index,value.reveal);else if(action==='concurrent')api.concurrent(value);else if(action==='quoteChange')returned=api.quoteChange(value);else if(action==='searchQuote')returned=api.searchQuote();else if(action==='select')returned=api.select();else if(action==='focus')returned=api.focus();else if(action==='witness')api.witness();else if(action==='message')void api.openMessage();else if(action==='resolve'){const n=navigation[value.index];n.settled=true;if(value.navigate!==false)api.set({projectId:n.args[0],artifactId:n.args[1],revision:n.args[2]??null});n.resolve(value.undefined?undefined:value.generation);}else if(action==='theme'){const app=document.querySelector('.app');app.dataset.accent=value.accent;app.dataset.appearance=value.appearance;app.style.zoom=String(value.zoom);window.dispatchEvent(new Event('resize'));}else if(action==='unmount'){alive=false;root.unmount();unmounted=true;}});captureMotion();await settle();return {returned:returned===undefined?'undefined':returned,snapshot:snapshot()};}}});
`;

type Draft = {
  body: string;
  selection: string;
  revision: number | null;
  annotation?: boolean;
  intent?: string;
  taskResult?: unknown;
  page?: number;
  textQuotes?: unknown[];
  model?: string;
  reasoningEffort?: string;
};
type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  background: string;
  border: string;
  shadow: string;
};
type Snapshot = {
  facts: {
    projectId: string;
    conversationId: string;
    artifactId: string;
    revision: number | null;
    searchOpen: boolean;
    visible: boolean;
    disabled: boolean;
    generation: number;
    team: boolean;
  };
  draft: Draft;
  drafts: Record<string, Draft>;
  stored: Record<string, Draft>;
  quoteReveal: { quote: unknown; token: string } | null;
  setterId: number;
  captured: number[];
  witnesses: string[];
  navigation: { args: unknown[]; settled: boolean }[];
  requests: { kind: string; args: unknown[]; aborted: boolean }[];
  events: unknown[][];
  focusCalls: unknown[];
  motion: unknown[];
  unmounted: boolean;
  dom: {
    dialog: string | null;
    quote: string | null;
    paper: string | null;
    chip: string | null;
    dialogId: number | null;
    quoteId: number | null;
    paperId: number | null;
    source: string | null;
    quoteParent: string | null;
    searchModal: boolean;
  };
  active: { id: string; label: string; tag: string };
  input: { value: string; start: number; end: number } | null;
  geometry: {
    workspace: Box | null;
    main: Box | null;
    dialog: Box | null;
    quote: Box | null;
  };
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
  available = executable
    ? existsSync(executable)
    : existsSync(chromium.executablePath());
test(
  "fixed-old and actual-new reference preparation preserve bounded real React/consumer/draft/focus contracts",
  {
    skip: available
      ? false
      : "set MORPHZ_TEST_BROWSER_EXECUTABLE or install existing Playwright Chromium capability",
  },
  async (context) => {
    const cache = mkdtempSync(
      join(tmpdir(), "morphz-reference-preparation-cache-"),
    );
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "isolated-reference-preparation",
          resolveId(id) {
            if (id === "/__reference.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__reference.tsx")
              return transformWithOxc(source, "reference.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__reference") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__reference.tsx"></script></body></html>',
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
    const url = `http://127.0.0.1:${address.port}/__reference`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const errors: string[] = [],
      businessReads: string[] = [];
    let phase = "initial";
    context.after(() =>
      context.diagnostic(JSON.stringify({ phase, errors, businessReads })),
    );
    async function pair() {
      const pages: Page[] = [];
      for (const lane of ["fixed", "actual"]) {
        const isolated = await browser.newContext({
          viewport: { width: 1440, height: 900 },
        });
        context.after(() => isolated.close());
        await isolated.addInitScript(
          `sessionStorage.setItem("morphz:window", "fixture-window"); Object.defineProperty(crypto, "randomUUID", { value: () => "00000000-0000-4000-8000-000000000001" }); window.focusCalls = []; const original = HTMLElement.prototype.focus; HTMLElement.prototype.focus = function (options) { window.focusCalls.push({ id: this.id, label: this.getAttribute("aria-label"), options: options ?? null }); original.call(this, options); };`,
        );
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
        await page.waitForFunction(
          () => !!Reflect.get(window, "referenceFixture"),
        );
        await page.evaluate(() =>
          Reflect.get(window, "referenceFixture").settle(),
        );
        pages.push(page);
      }
      async function read() {
        const snapshots = await Promise.all(
          pages.map(
            (page) =>
              page.evaluate(() =>
                Reflect.get(window, "referenceFixture").snapshot(),
              ) as Promise<Snapshot>,
          ),
        );
        assert.deepEqual(
          snapshots[1],
          snapshots[0],
          phase + " complete old/new snapshot",
        );
        return snapshots[0]!;
      }
      async function run(action: string, value?: unknown) {
        const result = await Promise.all(
          pages.map((page) =>
            page.evaluate(
              ({ action, value }) =>
                Reflect.get(window, "referenceFixture").run(action, value),
              { action, value },
            ),
          ),
        );
        assert.deepEqual(
          result[1],
          result[0],
          phase + " action/complete snapshot",
        );
        return result[0] as { returned: unknown; snapshot: Snapshot };
      }
      async function dom(action: (page: Page) => Promise<unknown>) {
        await Promise.all(pages.map(action));
        await Promise.all(
          pages.map((page) =>
            page.evaluate(() =>
              Reflect.get(window, "referenceFixture").settle(),
            ),
          ),
        );
        return read();
      }
      return { pages, read, run, dom };
    }
    const reveal = {
      quote: {
        id: "11111111-1111-4111-8111-111111111111",
        source: {
          kind: "message",
          projectId: "projectA",
          conversationId: "default",
          messageId: "message",
          createdAt: "2026-10-04T00:00:00.000Z",
        },
        text: "message quote",
        comment: "",
      },
      token: "fixed-reveal",
    };
    await context.test(
      "original state/effect slots, stable actual setter, same-default surfaces retain reveal and different conversation retires",
      async () => {
        phase = "state lifecycle";
        const h = await pair(),
          initial = await h.read();
        assert.equal(initial.quoteReveal, null);
        const setter = initial.setterId;
        await h.run("capture");
        let result = await h.run("reveal", reveal);
        assert.deepEqual(result.snapshot.quoteReveal, reveal);
        result = await h.run("set", {
          projectId: "projectB",
          artifactId: "B",
          visible: false,
        });
        assert.deepEqual(result.snapshot.quoteReveal, reveal);
        assert.equal(result.snapshot.setterId, setter);
        result = await h.run("witness");
        assert.deepEqual(result.snapshot.witnesses, [
          "before-new",
          "after-new",
          "toolbar-new",
        ]);
        result = await h.run("set", { conversationId: "named-conversation" });
        assert.equal(result.snapshot.quoteReveal, null);
        assert.equal(result.snapshot.setterId, setter);
        result = await h.run("captured", { index: 0, reveal });
        assert.deepEqual(result.snapshot.quoteReveal, reveal);
        assert.deepEqual(result.snapshot.captured, [setter]);
        await h.run("set", { conversationId: "default", visible: true });
        assert.equal((await h.read()).quoteReveal, null);
      },
    );
    await context.test(
      "actual SearchDocuments closes before exact quote navigation; held completion preserves captured draft and real scoped storage",
      async () => {
        phase = "SearchDocuments quote";
        const h = await pair();
        await h.dom((page) => page.locator("#search-trigger").click());
        assert.ok((await h.read()).dom.searchModal);
        await Promise.all(
          h.pages.map((page) =>
            page.getByRole("textbox", { name: "全文搜索" }).fill("原文"),
          ),
        );
        await Promise.all(
          h.pages.map((page) => page.locator(".search-result-quote").waitFor()),
        );
        let result = await h.dom((page) =>
          page.locator(".search-result-quote").click(),
        );
        assert.equal(result.dom.dialog, null);
        assert.equal(result.navigation.length, 1);
        assert.deepEqual(result.navigation[0]!.args, [
          "projectB",
          "B",
          1,
          0,
          false,
          undefined,
          "确切搜索选文",
        ]);
        assert.ok(
          result.events.findIndex((e) => e[0] === "search-close") <
            result.events.findIndex((e) => e[0] === "open"),
        );
        assert.equal(result.drafts["default:B"], undefined);
        await h.run("concurrent", "后续未发送草稿");
        result = (await h.run("resolve", { index: 0, generation: 9 })).snapshot;
        assert.equal(result.draft.selection, "确切搜索选文");
        assert.equal(result.draft.revision, 1);
        assert.equal(result.draft.page, 0);
        assert.equal(result.active.id, "draft");
        assert.equal(result.stored["default:A"]!.body, "后续未发送草稿");
        assert.deepEqual(
          result.stored,
          JSON.parse(JSON.stringify(result.drafts)),
          "original JSON storage serialization",
        );
      },
    );
    await context.test(
      "direct search returns void, reversed/undefined generations keep original rejection and focus-inside policy",
      async () => {
        phase = "generation and search focus";
        const h = await pair();
        assert.equal((await h.run("searchQuote")).returned, "undefined");
        await h.run("searchQuote");
        await h.dom((page) => page.locator("#inside").focus());
        let result = (
          await h.run("resolve", { index: 1, generation: 9, navigate: false })
        ).snapshot;
        assert.equal(result.active.id, "inside");
        assert.ok(result.stored["default:B"]);
        const replaced = result.events.filter((e) => e[0] === "replace").length;
        await h.run("set", { generation: 10 });
        result = (
          await h.run("resolve", { index: 0, generation: 9, navigate: false })
        ).snapshot;
        assert.equal(
          result.events.filter((e) => e[0] === "replace").length,
          replaced,
        );
        await h.run("searchQuote");
        result = (
          await h.run("resolve", { index: 2, undefined: true, navigate: false })
        ).snapshot;
        assert.equal(
          result.events.filter((e) => e[0] === "replace").length,
          replaced,
        );
        await h.dom((page) => page.locator("#outside").focus());
        result = (await h.run("focus")).snapshot;
        assert.equal(result.active.id, "draft");
        assert.ok(
          result.focusCalls.some((call) =>
            JSON.stringify(call).includes('"preventScroll":true'),
          ),
        );
      },
    );
    async function selectDocument(pages: Page[], historical = false) {
      await Promise.all(
        pages.map((page) =>
          page.evaluate((historical) => {
            const node =
              document.querySelector(".document-body p")!.firstChild!;
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, historical ? 4 : 6);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange"));
          }, historical),
        ),
      );
      await Promise.all(
        pages.map((page) => page.locator(".selection-actions").waitFor()),
      );
    }
    await context.test(
      "actual ArtifactEditor/SelectionActions selection keeps exact historical revision and original clearing without send guard",
      async () => {
        phase = "actual artifact selection";
        const h = await pair();
        await h.run("set", { revision: 1, disabled: true });
        await selectDocument(h.pages, true);
        let result = await h.dom((page) =>
          page
            .locator(".selection-actions")
            .getByRole("button", { name: "批注", exact: true })
            .click(),
        );
        assert.equal(result.draft.selection, "历史原文");
        assert.equal(result.draft.revision, 1);
        assert.equal(result.draft.annotation, true);
        assert.equal(result.draft.intent, undefined);
        assert.equal(result.draft.taskResult, undefined);
        assert.equal(result.draft.body, "原未发送草稿");
        assert.equal(result.draft.model, "model-original");
        assert.deepEqual(
          result.stored,
          JSON.parse(JSON.stringify(result.drafts)),
          "original JSON storage serialization",
        );
        await h.run("set", { revision: null, disabled: false });
        await selectDocument(h.pages);
        result = await h.dom((page) =>
          page
            .locator(".selection-actions")
            .getByRole("button", { name: "批注", exact: true })
            .click(),
        );
        assert.equal(result.draft.revision, 2);
      },
    );
    await context.test(
      "actual Provider comment portal/function merge and chip edit/remove retain draft and distinct preventScroll focus",
      async () => {
        phase = "actual Provider comment";
        const h = await pair();
        await selectDocument(h.pages);
        await h.dom((page) =>
          page
            .locator(".selection-actions")
            .getByRole("button", { name: "评论选中文字" })
            .click(),
        );
        let result = await h.read();
        assert.ok(result.dom.quote);
        assert.ok(result.dom.quoteParent?.includes("app"));
        assert.equal(result.draft.selection, "原旧选区");
        assert.equal(result.draft.textQuotes?.length, 1);
        assert.equal(result.active.label, "引用 1 的评论（可选）");
        await h.run("concurrent", "并发保留正文");
        await h.dom((page) =>
          page
            .getByRole("textbox", { name: "引用 1 的评论（可选）" })
            .fill("真实评论"),
        );
        result = await h.dom((page) =>
          page
            .getByRole("textbox", { name: "引用 1 的评论（可选）" })
            .press("Escape"),
        );
        assert.equal(result.draft.body, "并发保留正文");
        assert.equal(result.active.id, "draft");
        assert.ok(!result.events.some((e) => e[0] === "interaction"));
        result = await h.dom((page) =>
          page.getByRole("button", { name: "移除引用 1" }).click(),
        );
        assert.equal(result.draft.textQuotes?.length, 0);
        assert.equal(result.draft.body, "并发保留正文");
        assert.equal(result.active.id, "draft");
        assert.deepEqual(
          result.stored,
          JSON.parse(JSON.stringify(result.drafts)),
          "original JSON storage serialization",
        );
      },
    );
    await context.test(
      "Provider scope retirement, disabled contract and actual Search native cancel preserve focus/text selection",
      async () => {
        phase = "retirement and modal cancel";
        const h = await pair();
        await selectDocument(h.pages);
        await h.dom((page) =>
          page
            .locator(".selection-actions")
            .getByRole("button", { name: "评论选中文字" })
            .click(),
        );
        assert.ok((await h.read()).dom.quote);
        let result = (
          await h.run("set", { projectId: "projectB", artifactId: "B" })
        ).snapshot;
        assert.ok(
          result.dom.quote,
          "same default conversation keeps original Provider editor lifecycle",
        );
        result = (await h.run("set", { conversationId: "named" })).snapshot;
        assert.equal(result.dom.quote, null);
        assert.equal(result.draft.textQuotes?.length, 0);
        await h.run("set", {
          conversationId: "default",
          projectId: "projectA",
          artifactId: "A",
          disabled: true,
        });
        await selectDocument(h.pages);
        result = await h.dom((page) =>
          page
            .locator(".selection-actions")
            .getByRole("button", { name: "评论选中文字" })
            .click(),
        );
        assert.equal(result.dom.quote, null);
        assert.equal(result.draft.textQuotes?.length, 1);
        await h.run("set", { disabled: false });
        await h.dom((page) => page.locator("#draft").focus());
        await Promise.all(
          h.pages.map((page) =>
            page
              .locator("#draft")
              .evaluate((element: HTMLTextAreaElement) =>
                element.setSelectionRange(2, 5),
              ),
          ),
        );
        await h.run("set", { searchOpen: true });
        result = await h.dom((page) =>
          page.getByRole("textbox", { name: "全文搜索" }).press("Escape"),
        );
        assert.equal(result.dom.dialog, null);
        assert.equal(result.active.id, "draft");
        assert.equal(result.input!.start, 2);
        assert.equal(result.input!.end, 5);
        assert.equal(result.input!.value, "原未发送草稿");
      },
    );
    await context.test(
      "unmount aborts actual recent/search consumers, late controlled completion does not touch retired draft storage",
      async () => {
        phase = "unmount";
        const h = await pair();
        await h.run("searchQuote");
        await h.run("set", { searchOpen: true });
        const before = await h.read();
        assert.ok(
          before.requests.some((q) => q.kind === "recent" && !q.aborted),
        );
        let result = (await h.run("unmount")).snapshot;
        assert.ok(result.unmounted);
        assert.ok(
          result.requests
            .filter((q) => q.kind === "recent")
            .every((q) => q.aborted),
        );
        assert.equal(result.dom.paper, null);
        result = (
          await h.run("resolve", { index: 0, generation: 9, navigate: false })
        ).snapshot;
        assert.deepEqual(
          result.stored,
          before.stored,
          "borrowed retired Host writer blocks stale storage writes",
        );
      },
    );
    await context.test(
      "actual search ancestor geometry and unsuppressed motion compare all four themes/light-dark/viewport/zoom",
      async () => {
        phase = "geometry/motion";
        const h = await pair();
        await h.dom((page) => page.locator("#search-trigger").click());
        const observations: unknown[] = [],
          widths = new Map<string, number>();
        for (const accent of ["cyan", "iris", "coral", "mono"])
          for (const appearance of ["light", "dark"])
            for (const width of [1440, 1000, 760])
              for (const zoom of [1, 2]) {
                phase = [accent, appearance, width, zoom].join(":");
                await Promise.all(
                  h.pages.map((page) =>
                    page.setViewportSize({ width, height: 900 }),
                  ),
                );
                const result = (
                    await h.run("theme", { accent, appearance, zoom })
                  ).snapshot,
                  workspace = result.geometry.workspace!,
                  dialog = result.geometry.dialog!,
                  main = result.geometry.main!;
                assert.ok(
                  workspace.width > 0 && main.width > 0 && dialog.width > 0,
                );
                if (zoom === 1) {
                  assert.ok(dialog.width <= workspace.width);
                  assert.equal(
                    Math.round((dialog.x + dialog.width / 2) * 100),
                    Math.round((workspace.x + workspace.width / 2) * 100),
                    "original unzoomed search centers on effective workspace",
                  );
                }
                assert.ok(result.dom.searchModal);
                widths.set(phase, workspace.width);
                observations.push({
                  accent,
                  appearance,
                  width,
                  zoom,
                  geometry: result.geometry,
                  originalSearchOverflow: dialog.width > workspace.width,
                  motion: result.motion.at(-1),
                });
              }
        for (const accent of ["cyan", "iris", "coral", "mono"])
          for (const appearance of ["light", "dark"]) {
            assert.ok(
              widths.get([accent, appearance, 1440, 1].join(":"))! >
                widths.get([accent, appearance, 760, 1].join(":"))!,
            );
            assert.ok(
              widths.get([accent, appearance, 760, 1].join(":"))! >
                widths.get([accent, appearance, 760, 2].join(":"))!,
            );
          }
        context.diagnostic(
          JSON.stringify({
            geometryComparisons: observations.length,
            observationsSHA256: createHash("sha256")
              .update(JSON.stringify(observations))
              .digest("hex"),
            observations,
          }),
        );
      },
    );
    assert.deepEqual(errors, [], "real components have no browser error");
    assert.deepEqual(
      businessReads,
      [],
      "controlled Client ports cause no application HTTP reads",
    );
  },
);
