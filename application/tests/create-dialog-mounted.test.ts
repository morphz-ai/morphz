import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isFunctionDeclaration, type Node } from "typescript/unstable/ast";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import {
  fixedCreationConsumerSha,
  fixedCreationConsumers,
  fixedCreationDependencySha,
  fixedCreationFunctionSha,
} from "./fixtures/create-dialog-778e6b93.js";

// Full fixed-old component and actual new component, original consumption JSX,
// real storage, stable WorkspaceTopbar slots and native useModal. Each lane has
// an independent page/context: two dialogs never compete in one document.
// Client.execute is controlled. These are component/lifecycle proofs, not
// application HTTP/SQLite authority, Runtime/model or original/native App.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function component(text: string, name: string) {
  const api = new API({
    cwd: "/creation",
    fs: createVirtualFileSystem({
      "/creation/source.tsx": text,
      "/creation/tsconfig.json": JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: ["source.tsx"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({
    openProjects: ["/creation/tsconfig.json"],
  });
  try {
    const p = snapshot.getProject("/creation/tsconfig.json")!.program;
    assert.deepEqual(p.getSyntacticDiagnostics(), []);
    const found: string[] = [];
    function visit(node: Node) {
      if (isFunctionDeclaration(node) && node.name?.text === name)
        found.push(node.getText());
      node.forEachChild(visit);
    }
    visit(p.getSourceFile("/creation/source.tsx")!);
    assert.equal(found.length, 1);
    return found[0]!;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
test("complete fixed Git778e creation function and consumers retain raw bytes; candidate differs only by export and approved execute-only client type", () => {
  const fixed = component(
    readFileSync(resolve("tests/fixtures/create-dialog-778e6b93.tsx"), "utf8"),
    "FixedCreateDialog",
  ).replace("export function FixedCreateDialog(", "function CreateDialog(");
  const actual = component(
    readFileSync(
      resolve("apps/web/src/features/creation/CreateDialog.tsx"),
      "utf8",
    ),
    "CreateDialog",
  )
    .replace("export function CreateDialog(", "function CreateDialog(")
    .replace(
      'client: Pick<WorkspaceClient, "execute">;',
      "client: ReturnType<typeof useWorkspace>;",
    );
  assert.equal(sha(fixed), fixedCreationFunctionSha);
  assert.equal(actual, fixed);
  for (const kind of ["document", "project"] as const)
    assert.equal(
      sha(fixedCreationConsumers[kind]),
      fixedCreationConsumerSha[kind],
    );
  for (const [key, path] of [
    ["useModal", "apps/web/src/useModal.ts"],
    ["storage", "apps/web/src/local-preferences.ts"],
    ["topbar", "apps/web/src/shell/WorkspaceTopbar.tsx"],
  ] as const)
    assert.equal(
      sha(readFileSync(resolve(path), "utf8")),
      fixedCreationDependencySha[key],
      key + ": unchanged original owner",
    );
});

const source = `
import React,{StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CreateDialog as ActualCreateDialog} from '/src/features/creation/CreateDialog.tsx';
import {FixedCreateDialog} from '/@fs/${resolve("tests/fixtures/create-dialog-778e6b93.tsx")}';
import {WorkspaceTopbar} from '/src/shell/WorkspaceTopbar.tsx';
import {scopedStorage,storageScope,draftKey,draftOwner} from '/src/local-preferences.ts';
import '/src/styles.css';import '/src/ui.css';import '/src/workflow.css';import '/src/ui/dialog-surface.css';import '/src/visual-system.css';import '/src/exchange-layout.css';import '/src/inspector.css';import '/src/task-list.css';import '/src/content-catalog.css';import '/src/browser-bookmarks.css';import '/src/text-quotes.css';import '/src/profile-avatar.css';import '/src/personality-profile.css';import '/src/execution-activity.css';import '/src/execution-thread-groups.css';import '/src/application-icons.css';
const mode=new URL(location.href).searchParams.get('mode'),CreateDialog=mode==='fixed'?FixedCreateDialog:ActualCreateDialog,options=window.creationOptions??{};
const events=[],pending=[],ids=new WeakMap();let nextId=0,api,phase='idle',failWrites=false,throwPrepare=false,throwPrepared=false,throwOrdinary=false,syncExecuteError=false;
const id=node=>{if(!node)return null;if(!ids.has(node))ids.set(node,++nextId);return ids.get(node);};
storageScope('center-A','human-A');
const oldGet=Storage.prototype.getItem,oldSet=Storage.prototype.setItem;
for(const project of ['project-A','project-B'])oldSet.call(localStorage,'morphzwork:center-A:human-A:'+draftKey('create-document:'+project),JSON.stringify({title:'cached '+project,markdown:'cached body '+project}));
Storage.prototype.getItem=function(key){if(key.includes(':draft:'))events.push(['read',key]);return oldGet.call(this,key);};
Storage.prototype.setItem=function(key,value){if(key.includes(':draft:')){events.push(['write',key,JSON.parse(value)]);if(failWrites)throw Error('controlled storage failure');}return oldSet.call(this,key,value);};
const nativeShow=HTMLDialogElement.prototype.showModal,nativeClose=HTMLDialogElement.prototype.close;
HTMLDialogElement.prototype.showModal=function(){events.push(['showModal']);return nativeShow.call(this);};
HTMLDialogElement.prototype.close=function(){events.push(['closeModal']);return nativeClose.call(this);};
window.addEventListener('unhandledrejection',event=>{events.push(['unhandled',event.reason instanceof Error?event.reason.message:String(event.reason)]);event.preventDefault();});
const clientFor=version=>({execute(operation){events.push(['execute',version,operation]);if(syncExecuteError)throw Error('synchronous write error');return new Promise((resolve,reject)=>pending.push({resolve,reject}));}}),clients=[clientFor(0),clientFor(1)];
const origin=document.getElementById('origin');origin.focus();origin.setSelectionRange(2,5);
function Fixture(){
 const[creatingValue,rawSetCreating]=useState(options.kind??'document'),[projectId,setProjectId]=useState('project-A'),[version,setVersion]=useState(0),[tick,setTick]=useState(0),[detailToolbarTarget,setDetailToolbarTarget]=useState(null),[pageTarget,setPageTarget]=useState(null),[appTarget,setAppTarget]=useState(null),[portal,setPortal]=useState(true);
 const creating=creatingValue,project={id:projectId},client=clients[version];
 const setCreating=value=>{events.push(['setCreating',value,projectId]);if(throwOrdinary&&phase==='receipt')throw Error('ordinary callback error');rawSetCreating(value);};
 const openObject=(projectId,id)=>{events.push(['openObject',projectId,id]);return Promise.resolve();};
 const prepareCreatedProject=()=>{events.push(['prepare',projectId]);if(throwPrepare)throw Error('preparation error');const captured=projectId;return(id,kind)=>{events.push(['prepared',id,kind,captured]);if(throwPrepared)throw Error('prepared callback error');};};
 api={run(action,value){if(action==='tick')setTick(v=>v+1);if(action==='close')rawSetCreating(null);if(action==='open')rawSetCreating(value);if(action==='project')setProjectId(value);if(action==='client')setVersion(1);if(action==='portal')setPortal(value);},report(){return {projectId,creating,version,tick,targets:{detail:id(detailToolbarTarget),page:id(pageTarget),application:id(appTarget)}};}};
 // Preserve the existing shell's layout roles: the empty sidebar occupies
 // its original grid column, and the modal remains the workspace's sibling.
 return <div className="app without-collaboration" data-accent="cyan" data-appearance="light"><aside className="sidebar" aria-hidden="true"/><div className="workspace">
  <WorkspaceTopbar view={{applicationWorkspaceOpen:false,view:'projects',viewLabel:'项目',projectTitle:projectId,projectOpen:true,artifact:null,openingObject:false,creating,collaborationVisible:false}} history={{index:0,length:1}} sidebarExpanded={true} slots={{application:setAppTarget,page:setPageTarget,detail:setDetailToolbarTarget}} projectControls={null} onToggleSidebar={()=>{}} onTravel={()=>{}} onNavigateView={()=>{}} onOpenProject={()=>{}} onToggleCollaboration={()=>{}}/>
  <div className="workspace-body"><div className="primary-panel"><main aria-label="主工作区" data-tick={tick}>
   {creating==='document'&&(()=>{const detailToolbarTarget=portal?apiTarget():null;return (${fixedCreationConsumers.document});})()}
   <div className="object-surface" hidden={creating==='document'}><p>Existing canvas stays mounted.</p></div>
  </main></div></div>
 </div>
  {creating&&creating!=='document'&&(${fixedCreationConsumers.project})}
 </div>;
 function apiTarget(){return detailToolbarTarget;}
}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Fixture/></StrictMode>));
// Capture the actual native entry effect before awaiting it; terminal geometry
// alone must not hide a changed animation name, timing or keyframes.
const entryMotion=[...document.querySelectorAll('dialog[open]')].map(node=>({name:getComputedStyle(node).animationName,effects:node.getAnimations().map(animation=>({name:animation.animationName,timing:animation.effect.getTiming(),keyframes:animation.effect.getKeyframes()}))}));
async function settle(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
function snapshot(){const title=document.querySelector('[aria-label="新对象标题"],[aria-label="项目名称"]'),markdown=document.querySelector('[aria-label="新文档正文"]'),form=document.querySelector('form'),dialog=document.querySelector('dialog'),slot=document.querySelector('.detail-toolbar-slot'),heading=document.querySelector('#create-title'),active=document.activeElement;
 const geometry=node=>{if(!node)return null;const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {x:Math.round(r.x*100)/100,y:Math.round(r.y*100)/100,width:Math.round(r.width*100)/100,height:Math.round(r.height*100)/100,background:style.backgroundColor,color:style.color,border:style.borderRadius,shadow:style.boxShadow,center:style.getPropertyValue('--modal-center'),maxWidth:style.getPropertyValue('--modal-max-width'),maxHeight:style.getPropertyValue('--modal-max-height')};};
 return {...api.report(),draftOwner,entryMotion,events,pending:pending.length,fields:{title:title?.value??null,markdown:markdown?.value??null,titleDisabled:title?.disabled??null,markdownDisabled:markdown?.disabled??null,maxLength:title?.maxLength??null,rows:markdown?.rows??null},buttons:[...document.querySelectorAll('form button,.draft-toolbar button')].map(n=>({text:n.textContent,label:n.getAttribute('aria-label'),disabled:n.disabled,type:n.getAttribute('type')})),error:document.querySelector('[role="alert"]')?.textContent??'',documentSection:!!document.querySelector('section.document-draft[aria-label="新建文档编辑区"]'),dialog:dialog?{open:dialog.open,label:dialog.getAttribute('aria-labelledby'),className:dialog.className}:null,portal:!!heading&&slot.contains(heading),heading:heading?.textContent??null,ids:{title:id(title),markdown:id(markdown),slot:id(slot)},active:{id:active?.id??'',label:active?.getAttribute('aria-label')??'',tag:active?.tagName??''},selection:[origin.selectionStart,origin.selectionEnd],geometry:{workspace:geometry(document.querySelector('.workspace')),surface:geometry(dialog??document.querySelector('.document-draft')),slot:geometry(slot),heading:geometry(heading)},stored:Object.fromEntries(Object.keys(localStorage).filter(key=>key.includes(':draft:')).sort().map(key=>[key,JSON.parse(oldGet.call(localStorage,key))]))};
}
Object.assign(window,{creationFixture:{snapshot,async run(action,value){flushSync(()=>{
 if(action==='scope')storageScope('center-B','human-B');
 else if(action==='externalCache')oldSet.call(localStorage,'morphz:center-A:human-A:'+draftKey('create-document:project-A'),JSON.stringify(value));
 else if(action==='failWrites')failWrites=!!value;
 else if(action==='throwPrepare')throwPrepare=!!value;
 else if(action==='throwPrepared')throwPrepared=!!value;
 else if(action==='throwOrdinary')throwOrdinary=!!value;
 else if(action==='syncExecuteError')syncExecuteError=!!value;
 else if(action==='submit')document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 else if(action==='resolve'){phase='receipt';pending.shift().resolve({entityId:'created-id'});}
 else if(action==='reject'){pending.shift().reject(value==='non-error'?'non-error':new Error('write error'));}
 else if(action==='theme'){const app=document.querySelector('.app');app.dataset.accent=value.accent;app.dataset.appearance=value.appearance;app.style.zoom=String(value.zoom);window.dispatchEvent(new Event('resize'));}
 else api.run(action,value);
});await settle();return snapshot();},settle,unmount(){flushSync(()=>root.unmount());}}});
`;

type Geometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  color: string;
  border: string;
  shadow: string;
  center: string;
  maxWidth: string;
  maxHeight: string;
};
type Snapshot = {
  projectId: string;
  creating: string | null;
  version: number;
  tick: number;
  draftOwner: string;
  entryMotion: {
    name: string;
    effects: { name: string; timing: unknown; keyframes: unknown }[];
  }[];
  targets: Record<string, number>;
  events: unknown[][];
  pending: number;
  fields: {
    title: string | null;
    markdown: string | null;
    titleDisabled: boolean | null;
    markdownDisabled: boolean | null;
    maxLength: number | null;
    rows: number | null;
  };
  buttons: {
    text: string | null;
    label: string | null;
    disabled: boolean;
    type: string | null;
  }[];
  error: string;
  documentSection: boolean;
  dialog: { open: boolean; label: string; className: string } | null;
  portal: boolean;
  heading: string | null;
  ids: { title: number | null; markdown: number | null; slot: number };
  active: { id: string; label: string; tag: string };
  selection: number[];
  geometry: {
    workspace: Geometry;
    surface: Geometry | null;
    slot: Geometry | null;
    heading: Geometry | null;
  };
  stored: Record<string, { title: string; markdown: string }>;
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
  available = executable
    ? existsSync(executable)
    : existsSync(chromium.executablePath());
test(
  "fixed and actual Human creation preserve complete real storage, portal, native modal and receipt lifecycle",
  {
    skip: available
      ? false
      : "set MORPHZ_TEST_BROWSER_EXECUTABLE or install the existing Playwright Chromium capability",
  },
  async (context) => {
    const cacheDir = mkdtempSync(join(tmpdir(), "morphz-create-dialog-cache-"));
    context.after(() => rmSync(cacheDir, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "isolated-full-create-dialog",
          resolveId(id) {
            if (id === "/__creation.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__creation.tsx")
              return transformWithOxc(source, "creation.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__creation") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><textarea id="origin" aria-label="fixture origin">原始输入选择</textarea><div id="root"></div><script type="module" src="/__creation.tsx"></script></body></html>',
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
    const url = `http://127.0.0.1:${address.port}/__creation`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    let phase = "initial";
    const errors: string[] = [],
      queries: string[] = [];
    context.after(() =>
      context.diagnostic(JSON.stringify({ phase, errors, queries })),
    );
    async function pair(kind: "document" | "project") {
      const pages: Page[] = [];
      for (const mode of ["fixed", "production"]) {
        const isolated = await browser.newContext({
          viewport: { width: 1440, height: 900 },
        });
        context.after(() => isolated.close());
        await isolated.addInitScript(
          ({ kind }) => {
            sessionStorage.setItem("morphzwork:window", "fixed-window");
            Reflect.set(window, "creationOptions", { kind });
          },
          { kind },
        );
        const page = await isolated.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (
            ["fetch", "xhr"].includes(request.resourceType()) &&
            !request.url().includes("/@vite/")
          )
            queries.push(request.url());
        });
        await page.goto(url + `?mode=${mode}`);
        await page.waitForSelector(
          kind === "project" ? "dialog[open]" : ".document-draft",
        );
        await page.evaluate(() =>
          Reflect.get(window, "creationFixture").settle(),
        );
        pages.push(page);
      }
      const read = () =>
        Promise.all(
          pages.map(
            (page) =>
              page.evaluate(async () => {
                const fixture = Reflect.get(window, "creationFixture");
                await fixture.settle();
                return fixture.snapshot();
              }) as Promise<Snapshot>,
          ),
        );
      const run = (action: string, value: unknown = null) =>
        Promise.all(
          pages.map(
            (page) =>
              page.evaluate(
                ([action, value]) =>
                  Reflect.get(window, "creationFixture").run(action, value),
                [action, value],
              ) as Promise<Snapshot>,
          ),
        );
      const parity = (values: Snapshot[]) => {
        assert.deepEqual(values[1], values[0], phase);
        return values[1]!;
      };
      const both = async (action: string, value: unknown = null) =>
        parity(await run(action, value));
      const fill = async (label: string, value: string) => {
        for (const page of pages)
          await page.getByLabel(label, { exact: true }).fill(value);
        return parity(await read());
      };
      const close = async () => {
        for (const page of pages) await page.close();
      };
      return { pages, read, run, parity, both, fill, close };
    }
    const events = (s: Snapshot, name: string) =>
      s.events.filter((event) => event[0] === name);
    const draft = (s: Snapshot, project = "project-A") =>
      s.stored[
        "morphz:center-A:human-A:draft:fixed-window:create-document:" + project
      ];

    await context.test(
      "document recovers legacy draft/window identity, keeps stable actual portal and state despite render-time reads, cancel/reopen and keyed scope",
      async () => {
        phase = "document recovery";
        const lane = await pair("document");
        let s = lane.parity(await lane.read());
        assert.equal(s.draftOwner, "fixed-window");
        assert.equal(s.fields.title, "cached project-A");
        assert.equal(s.fields.markdown, "cached body project-A");
        assert.equal(s.fields.maxLength, 180);
        assert.equal(s.fields.rows, 8);
        assert.equal(s.portal, true);
        assert.equal(s.documentSection, true);
        assert.equal(s.dialog, null);
        assert.equal(events(s, "execute").length, 0);
        assert.equal(events(s, "showModal").length, 0);
        const ids = s.ids,
          target = s.targets;
        const reads = events(s, "read").length;
        s = await lane.both("externalCache", {
          title: "external newer value",
          markdown: "external body",
        });
        s = await lane.both("tick");
        assert.ok(events(s, "read").length > reads);
        assert.equal(s.fields.title, "cached project-A");
        assert.deepEqual(s.ids, ids);
        assert.deepEqual(s.targets, target);
        s = await lane.both("portal", false);
        assert.equal(s.heading, null);
        assert.equal(s.ids.title, ids.title);
        s = await lane.both("portal", true);
        assert.equal(s.portal, true);
        assert.deepEqual(s.targets, target);
        s = await lane.fill("新对象标题", "保存的未发送标题");
        s = await lane.fill("新文档正文", "未发送正文\n保留第二行");
        s = await lane.both("close");
        assert.deepEqual(draft(s), {
          title: "保存的未发送标题",
          markdown: "未发送正文\n保留第二行",
        });
        s = await lane.both("open", "document");
        assert.equal(s.fields.title, "保存的未发送标题");
        assert.equal(s.fields.markdown, "未发送正文\n保留第二行");
        const current = s.ids.title;
        s = await lane.both("project", "project-B");
        assert.notEqual(s.ids.title, current);
        assert.equal(s.fields.title, "cached project-B");
        assert.equal(s.fields.markdown, "cached body project-B");
        s = await lane.both("project", "project-A");
        assert.equal(s.fields.title, "保存的未发送标题");
        await lane.close();
      },
    );
    await context.test(
      "document captures storage once, keeps busy fields editable and captured execute bytes, clears old scope before ordinary callback/open",
      async () => {
        phase = "document write";
        const lane = await pair("document");
        let s = await lane.fill("新对象标题", "  原始标题  ");
        s = await lane.fill("新文档正文", "原始Markdown");
        s = await lane.both("scope");
        s = await lane.both("submit");
        assert.equal(s.pending, 1);
        assert.deepEqual(events(s, "execute")[0], [
          "execute",
          0,
          {
            type: "create-artifact",
            projectId: "project-A",
            title: "  原始标题  ",
            content: { kind: "document", markdown: "原始Markdown" },
          },
        ]);
        assert.equal(s.buttons.filter((b) => b.text === "保存中…").length, 1);
        assert.equal(s.fields.titleDisabled, false);
        assert.equal(s.fields.markdownDisabled, false);
        s = await lane.both("submit");
        assert.equal(events(s, "execute").length, 1);
        s = await lane.fill("新对象标题", "请求中仍可编辑");
        s = await lane.fill("新文档正文", "请求中的新本机正文");
        assert.deepEqual(draft(s), {
          title: "请求中仍可编辑",
          markdown: "请求中的新本机正文",
        });
        s = await lane.both("client");
        s = await lane.both("resolve");
        assert.equal(s.creating, null);
        assert.deepEqual(draft(s), { title: "", markdown: "" });
        assert.equal(
          Object.keys(s.stored).some((k) =>
            k.startsWith("morphz:center-B:human-B:"),
          ),
          false,
        );
        const clear = s.events.findIndex(
            (e) => e[0] === "write" && (e[2] as { title: string }).title === "",
          ),
          callback = s.events.findIndex((e) => e[0] === "setCreating"),
          opened = s.events.findIndex((e) => e[0] === "openObject");
        assert.ok(clear >= 0 && clear < callback && callback < opened);
        assert.deepEqual(events(s, "openObject"), [
          ["openObject", "project-A", "created-id"],
        ]);
        assert.equal(events(s, "execute").length, 1);
        await lane.close();
      },
    );
    await context.test(
      "empty guard and persistence/clear failures preserve original banner and do not repeat a successful write",
      async () => {
        phase = "storage failure";
        const lane = await pair("document");
        let s = await lane.fill("新对象标题", "   ");
        s = await lane.both("submit");
        assert.equal(events(s, "execute").length, 0);
        s = await lane.both("failWrites", true);
        s = await lane.fill("新对象标题", "quota title");
        assert.equal(s.error, "草稿未能保存，请保留当前页面。\n");
        s = await lane.both("failWrites", false);
        s = await lane.fill("新文档正文", "保存失败仍保留");
        s = await lane.both("submit");
        assert.equal(s.error, "");
        s = await lane.both("failWrites", true);
        s = await lane.both("resolve");
        assert.equal(s.creating, null);
        assert.equal(events(s, "execute").length, 1);
        assert.notDeepEqual(draft(s), { title: "", markdown: "" });
        assert.deepEqual(events(s, "openObject"), [
          ["openObject", "project-A", "created-id"],
        ]);
        await lane.close();
      },
    );
    await context.test(
      "project has no document storage IO, keeps no-key fields, uses actual modal focus/selection and exact prepare/receipt order",
      async () => {
        phase = "project modal";
        const lane = await pair("project");
        let s = lane.parity(await lane.read());
        assert.deepEqual(events(s, "read"), []);
        assert.deepEqual(events(s, "write"), []);
        assert.equal(s.dialog!.className, "create-dialog project-dialog");
        assert.equal(s.dialog!.label, "create-title");
        assert.equal(s.dialog!.open, true);
        assert.equal(s.active.label, "项目名称");
        assert.equal(events(s, "showModal").length, 2);
        assert.equal(events(s, "closeModal").length, 1);
        assert.equal(s.entryMotion[0]!.name, "dialog-reveal");
        assert.equal(s.entryMotion[0]!.effects.length, 1);
        assert.equal(s.entryMotion[0]!.effects[0]!.name, "dialog-reveal");
        context.diagnostic(
          JSON.stringify({
            actualNativeEntryMotionBothLanesEqual: s.entryMotion,
          }),
        );
        s = await lane.fill("项目名称", "  原项目名称  ");
        const titleId = s.ids.title;
        s = await lane.both("submit");
        assert.deepEqual(events(s, "prepare"), [["prepare", "project-A"]]);
        assert.deepEqual(events(s, "execute"), [
          ["execute", 0, { type: "create-project", title: "  原项目名称  " }],
        ]);
        assert.ok(
          s.events.findIndex((e) => e[0] === "prepare") <
            s.events.findIndex((e) => e[0] === "execute"),
        );
        for (const page of lane.pages) await page.keyboard.press("Escape");
        s = lane.parity(await lane.read());
        assert.equal(s.dialog!.open, true);
        assert.equal(s.fields.titleDisabled, false);
        s = await lane.both("project", "project-B");
        assert.equal(s.ids.title, titleId);
        assert.equal(s.fields.title, "  原项目名称  ");
        s = await lane.both("client");
        s = await lane.both("resolve");
        assert.equal(s.creating, null);
        assert.deepEqual(events(s, "prepared"), [
          ["prepared", "created-id", "project", "project-A"],
        ]);
        assert.deepEqual(events(s, "setCreating"), [
          ["setCreating", null, "project-A"],
        ]);
        assert.equal(events(s, "openObject").length, 0);
        assert.equal(s.active.id, "origin");
        assert.deepEqual(s.selection, [2, 5]);
        assert.ok(
          s.events.findIndex((e) => e[0] === "prepared") <
            s.events.findIndex((e) => e[0] === "setCreating"),
        );
        await lane.close();
      },
    );
    await context.test(
      "native modal cancel and keyboard loop use the actual hook and restore initiating selection",
      async () => {
        phase = "modal keyboard";
        const lane = await pair("project");
        for (const page of lane.pages) {
          const controls = page.locator(
            "dialog button:not(:disabled),dialog input",
          );
          await controls.first().focus();
          await page.keyboard.press("Shift+Tab");
          assert.equal(
            await controls
              .last()
              .evaluate((node) => node === document.activeElement),
            true,
          );
          await page.keyboard.press("Tab");
          assert.equal(
            await controls
              .first()
              .evaluate((node) => node === document.activeElement),
            true,
          );
          await page.keyboard.press("Escape");
        }
        const s = lane.parity(await lane.read());
        assert.equal(s.creating, null);
        assert.equal(s.active.id, "origin");
        assert.deepEqual(s.selection, [2, 5]);
        assert.equal(events(s, "execute").length, 0);
        assert.equal(events(s, "prepare").length, 0);
        await lane.close();
      },
    );
    await context.test(
      "execute Error/non-Error/synchronous failure retains draft and releases busy with exact original error text",
      async () => {
        for (const failure of ["error", "non-error", "sync"]) {
          phase = "execute " + failure;
          const lane = await pair("document");
          await lane.fill("新对象标题", "错误前草稿");
          if (failure === "sync") await lane.both("syncExecuteError", true);
          let s = await lane.both("submit");
          if (failure !== "sync") s = await lane.both("reject", failure);
          assert.equal(
            s.error,
            failure === "non-error"
              ? "创建失败。"
              : failure === "sync"
                ? "synchronous write error"
                : "write error",
          );
          assert.equal(s.creating, "document");
          assert.equal(
            s.buttons.find((b) => b.text === "创建")!.disabled,
            false,
          );
          assert.equal(draft(s)!.title, "错误前草稿");
          assert.equal(events(s, "openObject").length, 0);
          await lane.close();
        }
      },
    );
    await context.test(
      "prepare outside try preserves original unhandled rejection and busy lock; callback errors remain inside catch after successful write",
      async () => {
        phase = "prepare outside try";
        const lane = await pair("project");
        await lane.fill("项目名称", "准备失败");
        await lane.both("throwPrepare", true);
        let s = await lane.both("submit");
        assert.deepEqual(events(s, "unhandled"), [
          ["unhandled", "preparation error"],
        ]);
        assert.equal(events(s, "execute").length, 0);
        assert.equal(s.error, "");
        assert.equal(
          s.buttons.find((b) => b.text === "保存中…")!.disabled,
          true,
        );
        for (const page of lane.pages) await page.keyboard.press("Escape");
        s = lane.parity(await lane.read());
        assert.equal(s.dialog!.open, true);
        await lane.close();
        for (const callback of ["throwPrepared", "throwOrdinary"]) {
          phase = callback;
          const next = await pair("project");
          await next.fill("项目名称", "回调失败");
          await next.both(callback, true);
          await next.both("submit");
          s = await next.both("resolve");
          assert.equal(
            s.error,
            callback === "throwPrepared"
              ? "prepared callback error"
              : "ordinary callback error",
          );
          assert.equal(s.creating, "project");
          assert.equal(
            s.buttons.find((b) => b.text === "创建")!.disabled,
            false,
          );
          assert.equal(events(s, "execute").length, 1);
          assert.equal(events(s, "prepared").length, 1);
          assert.equal(
            events(s, "setCreating").length,
            callback === "throwPrepared" ? 0 : 1,
          );
          await next.close();
        }
      },
    );
    await context.test(
      "late document receipts clear only captured draft while replacement UI stays untouched; prepared project callback survives unmount, ordinary callbacks do not",
      async () => {
        phase = "late document success";
        const lane = await pair("document");
        await lane.fill("新对象标题", "旧项目请求");
        await lane.both("submit");
        let s = await lane.both("project", "project-B");
        const replacement = s.ids.title;
        s = await lane.both("resolve");
        assert.equal(s.creating, "document");
        assert.equal(s.projectId, "project-B");
        assert.equal(s.ids.title, replacement);
        assert.equal(s.fields.title, "cached project-B");
        assert.deepEqual(draft(s, "project-A"), { title: "", markdown: "" });
        assert.equal(events(s, "setCreating").length, 0);
        assert.equal(events(s, "openObject").length, 0);
        await lane.close();
        phase = "late document failure";
        const failure = await pair("document");
        await failure.both("submit");
        await failure.both("project", "project-B");
        s = await failure.both("reject", "error");
        assert.equal(s.error, "");
        assert.equal(s.fields.title, "cached project-B");
        assert.equal(s.buttons.find((b) => b.text === "创建")!.disabled, false);
        await failure.close();
        phase = "late project success";
        const project = await pair("project");
        await project.fill("项目名称", "迟到项目");
        await project.both("submit");
        await project.both("close");
        s = await project.both("resolve");
        assert.deepEqual(events(s, "prepared"), [
          ["prepared", "created-id", "project", "project-A"],
        ]);
        assert.equal(events(s, "setCreating").length, 0);
        assert.equal(events(s, "execute").length, 1);
        await project.close();
      },
    );
    await context.test(
      "actual styles and stable portal/native geometry stay equal across four accents, light/dark, narrow widths and CSS zoom",
      async () => {
        const observations: {
          kind: string;
          accent: string;
          appearance: string;
          width: number;
          zoom: number;
          geometry: Snapshot["geometry"];
        }[] = [];
        for (const kind of ["document", "project"] as const) {
          const lane = await pair(kind);
          for (const accent of ["cyan", "iris", "coral", "mono"])
            for (const appearance of ["light", "dark"])
              for (const width of [1440, 760])
                for (const zoom of [1, 2]) {
                  phase = [kind, accent, appearance, width, zoom].join(":");
                  for (const page of lane.pages)
                    await page.setViewportSize({ width, height: 900 });
                  const s = await lane.both("theme", {
                    accent,
                    appearance,
                    zoom,
                  });
                  assert.equal(events(s, "execute").length, 0);
                  assert.equal(s.dialog?.open ?? s.documentSection, true);
                  observations.push({
                    kind,
                    accent,
                    appearance,
                    width,
                    zoom,
                    geometry: s.geometry,
                  });
                }
          await lane.close();
        }
        assert.equal(observations.length, 64);
        // The real sidebar/center ancestors must exercise actual viewport and
        // CSS-zoom geometry, not a fixed-width fixture in the sidebar column.
        for (const kind of ["document", "project"])
          for (const accent of ["cyan", "iris", "coral", "mono"])
            for (const appearance of ["light", "dark"]) {
              const width = (viewport: number, zoom: number) => {
                const observation = observations.find(
                  (value) =>
                    value.kind === kind &&
                    value.accent === accent &&
                    value.appearance === appearance &&
                    value.width === viewport &&
                    value.zoom === zoom,
                );
                assert.ok(observation);
                assert.ok(observation.geometry.workspace.width > 0);
                return observation.geometry.workspace.width;
              };
              assert.ok(width(1440, 1) > width(760, 1));
              assert.ok(width(1440, 2) > width(760, 2));
              assert.ok(width(1440, 1) > width(1440, 2));
              assert.ok(width(760, 1) > width(760, 2));
            }
        context.diagnostic(
          JSON.stringify({
            exactCompleteSnapshotComparisons: 64,
            geometryObservationSHA256: sha(JSON.stringify(observations)),
            observations,
          }),
        );
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(queries, []);
  },
);
