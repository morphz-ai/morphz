import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, expect, type Page } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import type { ReactElement } from "react";
import type { BuiltinApplicationOptions } from "../apps/web/src/host/builtin-application-adapters.js";
import type { BuiltinApplicationSurface } from "../apps/web/src/ApplicationHost.js";
import {
  originalBuiltinIntegrationMetadata as metadata,
  originalBuiltinIntegrationRecipes as recipes,
  fixedBuiltinModuleSource,
} from "./fixtures/builtin-application-integration.js";

// Actual components/React/native HTML, controlled Client and desktop ports.
// Element inspection is not mounted evidence; neither is HTTP ACL, SQL, native
// guest, hardware, original App or full historical Host acceptance.
const migration =
  process.env.MORPHZ_TEST_BUILTIN_ADAPTER_MIGRATION_EQUIVALENCE === "1";
type Factory =
  typeof import("../apps/web/src/host/builtin-application-adapters.js").createBuiltinApplicationAdapters;
type Props = Record<string, any>;
const element = (value: unknown) => value as ReactElement<Props>;
function ports(
  events: unknown[][],
  overrides: Partial<BuiltinApplicationOptions> = {},
): BuiltinApplicationOptions {
  const callback =
    (name: string) =>
    (...values: unknown[]) => {
      events.push([name, ...values]);
    };
  return {
    client: {
      execute: async (operation: unknown) => {
        events.push(["execute", operation]);
      },
    } as unknown as BuiltinApplicationOptions["client"],
    onOpenScript: callback("script-open"),
    onScriptLibrary: callback("script-library"),
    onReadingOpen: callback("reading-open"),
    onReadingCompose: () => ({ ok: true }),
    onReadingContext: callback("reading-context"),
    onReadingLibrary: callback("reading-library"),
    onReadingJump: callback("reading-jump"),
    onReadingTargetConsumed: callback("reading-consumed"),
    onCompose: (...values) => {
      events.push(["compose", ...values]);
      return { ok: true };
    },
    onComposeIntent: callback("intent"),
    onOpen: callback("open"),
    onNotice: callback("notice"),
    onBrowserPage: callback("page"),
    onNativeDialog: callback("native-dialog"),
    onInput: callback("input"),
    ...overrides,
  };
}
function surface(
  view: BuiltinApplicationSurface["view"],
  extra: Partial<BuiltinApplicationSurface> = {},
): BuiltinApplicationSurface {
  return {
    view,
    workspaceId: "project-original",
    selected: true,
    activeView: true,
    instance: {
      id: "instance-original",
      workspaceId: "project-original",
      applicationId: "morphz.browser",
      applicationVersion: "1",
      status: "open",
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
      revision: 7,
      state: { url: "https://original.invalid", preserved: "original" },
    },
    onReturn() {},
    returnLabel: "项目",
    fallback: { fallback: true } as never,
    ...extra,
  };
}

// Follow the actual runtime closure in source order. Dispose each TS snapshot
// before recursion; do not permanently freeze a historical file list or drop
// future feature CSS. Vite consolidates only modules actually in this closure.
function currentCSS() {
  const visited = new Set<string>(),
    styles = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.endsWith(".css")) {
      styles.add(file);
      return;
    }
    const name = "/builtin/source" + (file.endsWith(".tsx") ? ".tsx" : ".ts"),
      config = "/builtin/tsconfig.json";
    const api = new API({
      cwd: "/builtin",
      fs: createVirtualFileSystem({
        [name]: readFileSync(file, "utf8"),
        [config]: JSON.stringify({
          compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
          files: [name],
        }),
      }),
    });
    const dependencies: string[] = [];
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)!.program;
      assert.deepEqual(
        program.getSyntacticDiagnostics(),
        [],
        "actual CSS runtime dependency parses",
      );
      for (const statement of program.getSourceFile(name)!.statements) {
        if (
          !ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement)
        )
          continue;
        if (
          ts.isImportDeclaration(statement) &&
          (statement.importClause?.phaseModifier ===
            ts.SyntaxKind.TypeKeyword ||
            (statement.importClause?.namedBindings &&
              ts.isNamedImports(statement.importClause.namedBindings) &&
              !statement.importClause.name &&
              statement.importClause.namedBindings.elements.every(
                (n) => n.isTypeOnly,
              )))
        )
          continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        if (
          !specifier ||
          !ts.isStringLiteral(specifier) ||
          !specifier.text.startsWith(".")
        )
          continue;
        const base = resolve(dirname(file), specifier.text),
          target = (
            base.endsWith(".js")
              ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
              : [base, base + ".ts", base + ".tsx", join(base, "index.ts")]
          ).find(existsSync);
        assert.ok(target, "actual runtime dependency exists");
        dependencies.push(target);
      }
    } finally {
      snapshot.dispose();
      api.close();
    }
    dependencies.forEach(visit);
  }
  visit(resolve("apps/web/src/main.tsx"));
  return styles;
}

const mountSource = `
import React,{StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import '/__builtin.css';import {ApplicationHost} from '/src/ApplicationHost.tsx';import {TextQuoteProvider} from '/src/TextQuotes.tsx';
import {createBuiltinApplicationAdapters} from '/src/host/builtin-application-adapters.tsx';import {createFixedBuiltinAdapters} from '/__fixed_builtin.tsx';
import {initialWorkspace} from '/@fs/${resolve("packages/core/src/model.ts")}';import {browserApplication,readerApplication,scriptStudioApplication} from '/@fs/${resolve("packages/core/src/applications.ts")}';
const fixed=new URL(location.href).searchParams.get('lane')==='fixed',factory=fixed?createFixedBuiltinAdapters:createBuiltinApplicationAdapters;
const events=[],reads=[],nodeIds=new WeakMap();let serial=0,api,last,root,currentPage=null,lastMotion=[];const stateListeners=new Set();
const id=n=>{if(!n)return null;if(!nodeIds.has(n))nodeIds.set(n,++serial);return nodeIds.get(n);};
const stamp='2026-10-05T00:00:00Z',text='原始阅读正文。\\n'.repeat(160),book={title:'TEST原读物',author:'',edition:'',format:'markdown'},section={id:'body',title:'正文',sourceId:'reading:book:3',html:'<p>'+text.replaceAll('\\n','</p><p>')+'</p>',text,book};
const artifact={id:'book',projectId:'project-original',title:book.title,revision:3,content:{kind:'document',body:text},versions:[{revision:3,title:book.title,content:{kind:'document',body:text},createdAt:stamp}],createdAt:stamp,updatedAt:stamp};
const instances=[['browser',browserApplication,{url:'https://original.invalid'}],['reader',readerApplication,{artifactId:'book'}],['script',scriptStudioApplication,{}]].map(([id,app,value])=>({id,workspaceId:'project-original',applicationId:app.id,applicationVersion:app.version,revision:7,state:value,status:'open',createdAt:stamp,updatedAt:stamp}));
window.morphzDesktop={browser:{onState:fn=>{stateListeners.add(fn);return()=>stateListeners.delete(fn);},onSelection:()=>()=>{},onInput:()=>()=>{},state:async()=>currentPage,open:async()=>{currentPage={pageId:'guest-original',surface:{partition:'persist:builtin-fixture',src:'https://original.invalid'},artifactId:null,projectId:'project-original',url:'https://original.invalid',title:'原网页',epoch:'1',granted:false,loading:false,visible:true,error:'',pending:null};events.push(['guest-open']);return currentPage;},close:async pageId=>events.push(['guest-close',pageId]),visibility:async(...args)=>events.push(['guest-visibility',...args]),navigate:async(id,url)=>{currentPage={...currentPage,url};return currentPage;},control:async()=>currentPage}};
function Frame(){const[facts,setFacts]=useState({active:'browser',foreground:true,wrapper:0,show:true,accent:'cyan',appearance:'light',zoom:1}),[toolbar,setToolbar]=useState(null);api=value=>setFacts(old=>({...old,...value}));last=facts;
 const workspace=initialWorkspace(stamp);workspace.projects.push({id:'project-original',title:'TEST原项目',kind:'project',revision:1});workspace.artifacts.push(artifact);workspace.applicationInstances.push(...instances);
 const boot={centerId:'builtin-fixture-center',principalId:'human-fixture',actantId:'human-fixture',csrfToken:'fixture-only',workspace,capabilities:{browserBookmarks:false},scriptLibrary:[],runtime:{configured:false,connected:false,harnesses:[]}};
 const client={boot,online:true,workspaceChangeRevision:0,contentCatalog:[],contentCatalogVersion:1,getSnapshot:()=>boot,
 listContentPage:async(...args)=>{reads.push(['directory',...args.slice(0,1)]);return{items:[],total:0};},countContent:async()=>0,
 readingState:async(...args)=>{reads.push(['reading-state',...args.slice(0,2)]);return{position:null,marks:[]};},readingContents:async(...args)=>{reads.push(['contents',...args.slice(0,2)]);return[{id:'body',title:'正文',characters:text.length}];},readReading:async(...args)=>{reads.push(['section',...args.slice(0,3)]);return section;},readingMarks:async()=>({marks:[],nextCursor:null,hasMore:false}),
 readerCommand:async command=>{events.push(['reader-command',command]);return{revision:1};},bookmarkList:async()=>[],
 execute:async command=>{events.push(['execute',command]);return{entityId:'original',revision:8};},readScriptEditor:async()=>undefined};
 const adapters=factory({client,onOpenScript:id=>events.push(['script-open',id]),onScriptLibrary:()=>events.push(['script-library']),onReadingOpen:id=>events.push(['reading-open',id]),onReadingLibrary:()=>events.push(['reading-library']),onReadingJump:target=>events.push(['reading-jump',target]),onReadingCompose:()=>({ok:true}),onReadingContext:(key,value)=>events.push(['context',key,value?{artifactId:value.artifactId,revision:value.revision,focus:value.focus}:null]),onReadingTargetConsumed:id=>events.push(['consumed',id]),onCompose:(...args)=>{events.push(['compose',...args]);return{ok:true};},onComposeIntent:intent=>events.push(['intent',intent]),onOpen:id=>events.push(['open',id]),onNotice:value=>events.push(['notice',value]),onBrowserPage:page=>events.push(['page',page]),onNativeDialog:value=>events.push(['native-dialog',value]),readingRevision:3});
 return <TextQuoteProvider quotes={[]} scope="builtin-fixture" disabled={false} onChange={()=>{}} onEngage={()=>{}} onFocusComposer={()=>{}} onOpen={()=>{}} onNotice={()=>{}}><div className="app without-collaboration" data-accent={facts.accent} data-appearance={facts.appearance} style={{zoom:facts.zoom}}><aside className="sidebar"/><div className="workspace"><header className="topbar" ref={setToolbar}/><div className="workspace-body"><div className="primary-panel"><main>{facts.show&&<ApplicationHost client={client} workspaceId="project-original" activeId={facts.active} foreground={facts.foreground} navigationId={1} toolbarTarget={toolbar} applicationActions={{activate:id=>{events.push(['activate',id]);api({active:id});},launch(){throw Error('no fixture launch');},close(){throw Error('no fixture close');}}} onOpen={()=>{}} onCompose={()=>({ok:true})} onNotice={value=>events.push(['notice',value])} renderBuiltin={adapters.renderBuiltin} onOpenRecent={adapters.openRecentContent}><span id="fallback">原内容fallback</span></ApplicationHost>}</main></div></div></div><textarea id="persistent-entry" aria-label="测试原输入" defaultValue="原草稿"/></div></TextQuoteProvider>;}
root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Frame/></StrictMode>));
async function settle(){await Promise.resolve();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.resolve();}
function snapshot(){const pane=document.querySelector('.application-pane:not([hidden])'),host=document.querySelector('.application-host'),rect=n=>{const r=n?.getBoundingClientRect();return r?['x','y','width','height'].map(k=>Math.round(r[k]*100)/100):null;};const style=n=>{if(!n)return null;const s=getComputedStyle(n);return Object.fromEntries(['backgroundColor','color','border','borderRadius','boxShadow','backdropFilter','padding','gap','transition','animation'].map(k=>[k,s[k]]));};return{facts:last,events:[...events],reads:[...reads],panes:[...document.querySelectorAll('.application-pane')].map(n=>({id:id(n),label:n.getAttribute('aria-label'),hidden:n.hidden,role:n.getAttribute('role')})),reader:{node:id(document.querySelector('.reader-text')),viewport:id(document.querySelector('.reader-viewport')),scroll:document.querySelector('.reader-viewport')?.scrollTop??null,text:document.querySelector('.reader-text')?.textContent??null},browser:{node:id(document.querySelector('.browser-host')),inputNode:id(document.querySelector('.browser-host input')),inputFocused:document.querySelector('.browser-host input')===document.activeElement,value:document.querySelector('.browser-host input')?.value??null},geometry:{host:rect(host),pane:rect(pane),center:rect(document.querySelector('.primary-panel')),materials:style(pane),hostMaterials:style(host)},motionBeforeSettle:lastMotion,focus:document.activeElement?.id??'',html:host?.outerHTML??null};}
Reflect.set(window,'builtinFixture',{snapshot,async set(value){flushSync(()=>api(value));lastMotion=document.getAnimations().map(a=>({name:a.animationName??null,timing:a.effect?.getTiming(),keyframes:a.effect?.getKeyframes()}));await settle();return snapshot();},async unmount(){flushSync(()=>root.unmount());await settle();return snapshot();},emit(url){currentPage={...currentPage,url,epoch:'2'};for(const fn of stateListeners)fn({pageId:'guest-original',generation:1,sequence:2,value:currentPage});},settle});
`;

test(
  "actual builtin factory preserves finite original element/command contracts",
  { timeout: 60000 },
  async (context) => {
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      plugins: [
        react(),
        {
          name: "fixed-builtin-recipe",
          resolveId(id) {
            if (id === "/__fixed_builtin.tsx") return "\0builtin-fixed";
          },
          async load(id) {
            if (id === "\0builtin-fixed")
              return transformWithOxc(
                fixedBuiltinModuleSource(),
                "builtin-fixed.tsx",
              );
          },
        },
      ],
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    context.after(() => server.close());
    await server.listen();
    const actual = (
      await server.ssrLoadModule("/src/host/builtin-application-adapters.tsx")
    ).createBuiltinApplicationAdapters as Factory;
    const old = migration
      ? ((await server.ssrLoadModule("/__fixed_builtin.tsx"))
          .createFixedBuiltinAdapters as Factory)
      : undefined;
    const factories = old ? [old, actual] : [actual];
    await context.test(
      "four fixed raw recipes have immutable finite provenance",
      () => {
        for (const [name, raw] of Object.entries(recipes)) {
          const m = metadata.recipes[name as keyof typeof metadata.recipes];
          assert.equal(
            createHash("sha256").update(raw).digest("hex"),
            m.sha256,
          );
          assert.equal(Buffer.byteLength(raw), m.bytes);
          assert.equal(raw.split("\n").length, m.lineCount);
        }
      },
    );
    await context.test(
      "constructor borrows only; branches are real elements or exact fallback",
      () => {
        for (const factory of factories) {
          const events: unknown[][] = [],
            client = new Proxy(
              {},
              {
                get() {
                  throw Error("constructor must not read Client");
                },
              },
            );
          const adapter = factory(
            ports(events, {
              client: client as BuiltinApplicationOptions["client"],
            }),
          );
          assert.deepEqual(events, []);
          assert.deepEqual(Object.keys(adapter), [
            "renderBuiltin",
            "openRecentContent",
          ]);
          for (const view of ["browser", "reader", "script-studio"] as const) {
            const p = surface(view),
              node = element(adapter.renderBuiltin(p));
            assert.equal(typeof node.type, "function");
            assert.equal(node.props.client, client);
            assert.equal(node.key, null);
            assert.equal(
              node.props.projectId ??
                node.props.instance.workspaceId ??
                p.workspaceId,
              p.workspaceId,
            );
          }
          const fallback = surface("objects");
          assert.equal(adapter.renderBuiltin(fallback), fallback.fallback);
        }
      },
    );
    await context.test(
      "Browser publish then captured CAS, unchanged/null and original error",
      async () => {
        const results = [];
        for (const factory of factories) {
          const events: unknown[][] = [],
            p = surface("browser"),
            adapter = factory(ports(events));
          const onPage = element(adapter.renderBuiltin(p)).props.onPage;
          onPage(null);
          onPage({ url: "https://original.invalid" });
          assert.equal(events.filter((e) => e[0] === "execute").length, 0);
          const next = { url: "https://changed.invalid", title: "new" };
          onPage(next);
          assert.deepEqual(events.slice(-2), [
            ["page", next],
            [
              "execute",
              {
                type: "set-application-state",
                instanceId: "instance-original",
                expectedRevision: 7,
                state: { url: next.url, preserved: "original" },
              },
            ],
          ]);
          const failure = factory(
            ports(events, {
              client: {
                execute: () => Promise.reject(Error("old error")),
              } as unknown as BuiltinApplicationOptions["client"],
            }),
          );
          element(failure.renderBuiltin(p)).props.onPage({
            url: "https://failed.invalid",
          });
          await Promise.resolve();
          await Promise.resolve();
          assert.deepEqual(events.at(-1), ["notice", "old error"]);
          results.push(events);
          const newEvents: unknown[][] = [];
          factory(ports(newEvents)).renderBuiltin(
            surface("browser", {
              instance: {
                id: "new-instance",
                revision: 11,
                state: { url: "https://latest.invalid" },
              } as never,
            }),
          );
          onPage({ url: "https://held-old.invalid" });
          assert.deepEqual(
            newEvents,
            [],
            "an old callback does not retarget a new wrapper",
          );
          assert.deepEqual(events.at(-1), [
            "execute",
            {
              type: "set-application-state",
              instanceId: "instance-original",
              expectedRevision: 7,
              state: { url: "https://held-old.invalid", preserved: "original" },
            },
          ]);
        }
        if (migration) assert.deepEqual(results[0], results[1]);
      },
    );
    await context.test(
      "Reader selected context differs from foreground activity; exact ports",
      () => {
        for (const factory of factories) {
          const events: unknown[][] = [],
            options = ports(events, {
              readingRevision: 3,
              readingTarget: { artifactId: "book" } as never,
              globalLibrary: true,
            });
          for (const [selected, activeView] of [
            [true, true],
            [true, false],
            [false, false],
          ]) {
            const p = element(
              factory(options).renderBuiltin(
                surface("reader", { selected, activeView }),
              ),
            ).props;
            assert.equal(p.active, activeView);
            assert.equal(
              p.onContext,
              selected ? options.onReadingContext : undefined,
            );
            assert.equal(p.revision, 3);
            assert.equal(p.target, options.readingTarget);
            assert.equal(p.globalLibrary, true);
            assert.equal(p.onLibrary, options.onReadingLibrary);
            assert.equal(p.onNativeDialog, options.onNativeDialog);
            assert.equal(p.onJump, options.onReadingJump);
            assert.equal(p.onTargetConsumed, options.onReadingTargetConsumed);
            assert.equal(p.onCompose, options.onReadingCompose);
            assert.equal(p.onOpen, options.onReadingOpen);
            assert.equal(p.onNotice, options.onNotice);
          }
        }
      },
    );
    await context.test(
      "Script generation/intent preserve argument order and actual return/throw",
      () => {
        for (const factory of factories) {
          const events: unknown[][] = [],
            failure = { ok: false as const, error: "draft locked" },
            generation = { revision: 4 } as never;
          const options = ports(events, {
            onCompose: (...args) => {
              events.push(["compose", ...args]);
              return failure;
            },
          });
          const p = element(
            factory(options).renderBuiltin(surface("script-studio")),
          ).props;
          assert.equal(p.onCompose("原创作", generation), failure);
          assert.deepEqual(events[0], [
            "compose",
            "原创作",
            undefined,
            generation,
          ]);
          p.onConceive();
          assert.deepEqual(events[1], ["intent", "script"]);
          const success = { ok: true as const };
          assert.equal(
            element(
              factory(ports([], { onCompose: () => success })).renderBuiltin(
                surface("script-studio"),
              ),
            ).props.onCompose("body", generation),
            success,
          );
          const thrown = factory(
            ports([], {
              onCompose() {
                throw Error("unchanged exception");
              },
            }),
          );
          assert.throws(
            () =>
              element(
                thrown.renderBuiltin(surface("script-studio")),
              ).props.onCompose("body", generation),
            /unchanged exception/,
          );
        }
      },
    );
    await context.test(
      "recent exact catalog/artifact IDs and captured throw; no side effects",
      () => {
        for (const factory of factories) {
          const events: unknown[][] = [],
            adapter = factory(ports(events));
          adapter.openRecentContent({
            kind: "catalog",
            value: {
              id: "content",
              appId: "morphz.script-studio",
              kind: "script",
              appObjectId: "production-original",
            },
          } as never);
          adapter.openRecentContent({
            kind: "script",
            value: { id: "old-script" },
          } as never);
          adapter.openRecentContent({
            kind: "artifact",
            value: { id: "document-original", content: { kind: "document" } },
          } as never);
          assert.deepEqual(events, [
            ["script-open", "production-original"],
            ["script-open", "old-script"],
            ["open", "document-original"],
          ]);
          const freshEvents: unknown[][] = [];
          factory(ports(freshEvents));
          adapter.openRecentContent({
            kind: "script",
            value: { id: "captured-old" },
          } as never);
          assert.deepEqual(freshEvents, []);
          assert.deepEqual(events.at(-1), ["script-open", "captured-old"]);
          const sentinel = { originalReturn: true };
          const returning = factory(
            ports([], { onOpenScript: () => sentinel }),
          );
          assert.equal(
            returning.openRecentContent({
              kind: "script",
              value: { id: "returned-id" },
            } as never),
            sentinel,
          );
          assert.throws(
            () =>
              factory(
                ports([], {
                  onOpenScript() {
                    throw Error("navigation original");
                  },
                }),
              ).openRecentContent({
                kind: "catalog",
                value: { kind: "script", appObjectId: "id" },
              } as never),
            /navigation original/,
          );
        }
      },
    );
  },
);

test(
  "real Host and builtin components preserve StrictMode lifetime, focus and current materials",
  { timeout: 120000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "default test entry must prepare the test browser",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-builtin-mounted-")),
      css = currentCSS();
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      logLevel: "error",
      plugins: [
        react(),
        {
          name: "builtin-integration-controlled-mount",
          resolveId(id) {
            if (
              [
                "/__builtin.tsx",
                "/__fixed_builtin.tsx",
                "/__builtin.css",
              ].includes(id)
            )
              return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__builtin.tsx")
              return transformWithOxc(mountSource, "builtin-mounted.tsx");
            if (id === "\0/__fixed_builtin.tsx")
              return transformWithOxc(
                fixedBuiltinModuleSource(),
                "builtin-fixed.tsx",
              );
            if (id === "\0/__builtin.css")
              return [...css]
                .map((file) => readFileSync(file, "utf8"))
                .join("\n");
            if (css.has(id.split("?")[0]!)) return "";
          },
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (!req.url?.startsWith("/__builtin?")) return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__builtin.tsx"></script></body></html>',
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
    const pages: Page[] = [],
      errors: string[] = [],
      requests: string[] = [],
      observations: unknown[] = [],
      motionCounts: number[] = [];
    for (const lane of migration ? ["fixed", "current"] : ["current"]) {
      const session = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      context.after(() => session.close());
      const page = await session.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => errors.push(lane + ":" + error.message));
      page.on("request", (req) => {
        if (
          ["fetch", "xhr"].includes(req.resourceType()) &&
          !req.url().includes("/@vite/")
        )
          requests.push(req.url());
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/__builtin?lane=${lane}`,
      );
      await page.waitForFunction(() => !!Reflect.get(window, "builtinFixture"));
      pages.push(page);
    }
    const each = async (run: (page: Page) => Promise<unknown>) =>
      Promise.all(pages.map(run));
    const set = (value: Record<string, unknown>) =>
      each((page) =>
        page.evaluate(
          (value) => Reflect.get(window, "builtinFixture").set(value),
          value,
        ),
      );
    // Reader's real ResizeObserver/rAF can publish the same source before or after
    // its layout effect. Preserve the raw ledger, validate every source, and
    // compare its complete authoritative value at each observed boundary. No
    // command, read, DOM, material, geometry or animation is normalized.
    const contextDiagnostics: unknown[] = [];
    function contexts(value: Props) {
      const latest = new Map<string, unknown>(),
        unique = new Set<string>();
      let published = 0,
        retired = 0;
      for (const event of value.events as unknown[][]) {
        if (event[0] !== "context") continue;
        assert.equal(event.length, 3);
        assert.equal(typeof event[1], "string");
        const key = event[1] as string;
        assert.match(key, /^reading-/);
        assert.ok(
          latest.size === 0 || latest.has(key),
          "only the one actual Reader context key is used",
        );
        const payload = event[2] as Props | null;
        if (payload === null) retired++;
        else {
          published++;
          assert.equal(payload.artifactId, "book");
          assert.equal(payload.revision, 3);
          if (payload.focus !== null) {
            assert.equal(payload.focus.selected, false);
            assert.deepEqual(payload.focus.reference.book, {
              title: "TEST原读物",
              author: "",
              edition: "",
              format: "markdown",
            });
            const location = payload.focus.reference.location;
            assert.equal(location.sourceId, "reading:book:3");
            assert.equal(location.sectionId, "body");
            assert.ok(
              Number.isInteger(location.start) &&
                Number.isInteger(location.end) &&
                location.start >= 0 &&
                location.end >= location.start &&
                location.end <= "原始阅读正文。\n".repeat(160).length,
            );
          }
        }
        unique.add(JSON.stringify([key, payload]));
        latest.set(key, payload);
      }
      if (value.facts.active === "reader")
        assert.ok(
          [...latest.values()].some((v) => v !== null),
          "selected Reader publishes its authoritative source",
        );
      else
        assert.ok(
          [...latest.values()].every((v) => v === null),
          "changing the selected application retires Reader context",
        );
      return {
        latest: [...latest],
        published,
        retired,
        unique: [...unique].map((raw) => JSON.parse(raw)),
      };
    }
    async function observe(name: string) {
      const values = (await each(async (page) => {
        await page.evaluate(() =>
          Reflect.get(window, "builtinFixture").settle(),
        );
        return page.evaluate(() =>
          Reflect.get(window, "builtinFixture").snapshot(),
        );
      })) as Props[];
      observations.push({ name, values });
      motionCounts.push(
        ...values.map((value) => value.motionBeforeSettle.length),
      );
      const states = values.map(contexts);
      contextDiagnostics.push({
        name,
        states,
        rawContexts: values.map((v) =>
          v.events.filter((e: unknown[]) => e[0] === "context"),
        ),
      });
      if (migration) {
        assert.deepEqual(
          states[0]!.latest,
          states[1]!.latest,
          "complete authoritative Reader context boundary: " + name,
        );
        const comparable = values.map((value) => ({
          ...value,
          events: value.events.filter(
            (event: unknown[]) => event[0] !== "context",
          ),
        }));
        assert.deepEqual(
          comparable[0],
          comparable[1],
          "complete bounded adapter DOM/motion/read/ordered noncontext event parity: " +
            name,
        );
      }
      return values;
    }
    context.after(() =>
      context.diagnostic(
        JSON.stringify({
          migration,
          observations: observations.length,
          cssModules: css.size,
          motionBeforeSettleCounts: motionCounts,
          contextDiagnostics,
          errors,
          businessRequests: requests,
          scope:
            "controlled real builtin mount; raw Reader measurement chronology recorded, source and complete last boundary value compared; Reader loaded-node preservation only, not scroll/target UI; not full old Host/native/ACL",
        }),
      ),
    );
    await context.test(
      "three real hidden panes retain nodes and Browser form/focus on rerender",
      async () => {
        const before = await observe("initial");
        assert.equal(before[0]!.panes.length, 3);
        await each(async (page) => {
          const field = page.locator(".browser-host input").first();
          await field.fill("https://typed.invalid");
          await field.focus();
        });
        await set({ wrapper: 1 });
        const after = await observe("wrapper");
        assert.deepEqual(after[0]!.panes, before[0]!.panes);
        assert.equal(after[0]!.browser.value, "https://typed.invalid");
        assert.equal(
          after[0]!.browser.inputNode,
          before[0]!.browser.inputNode,
          "same actual focused input node survives wrapper rerender",
        );
        assert.equal(
          after[0]!.browser.inputFocused,
          true,
          "the actual Browser input, not an empty id, remains document.activeElement",
        );
        await set({ active: "script" });
        await set({ active: "browser" });
        const returned = await observe("switch-return");
        assert.equal(returned[0]!.browser.node, before[0]!.browser.node);
        assert.equal(returned[0]!.browser.value, "https://typed.invalid");
      },
    );
    await context.test(
      "Reader selected-but-hidden context keeps exact source and loaded DOM",
      async () => {
        await set({ active: "reader" });
        await each((page) =>
          expect(page.locator(".reader-text")).toContainText("原始阅读正文"),
        );
        const before = await observe("reader");
        await set({ foreground: false });
        const hidden = await observe("reader-selected-inactive");
        assert.equal(hidden[0]!.reader.node, before[0]!.reader.node);
        assert.ok(
          hidden[0]!.events.some(
            (e: unknown[]) =>
              e[0] === "context" && (e[2] as Props)?.artifactId === "book",
          ),
        );
        await set({ foreground: true });
        const resumed = await observe("reader-resume");
        assert.equal(resumed[0]!.reader.node, before[0]!.reader.node);
        await set({ active: "script" });
        await set({ active: "reader" });
        const restored = await observe("reader-return");
        assert.equal(restored[0]!.reader.node, before[0]!.reader.node);
      },
    );
    await context.test(
      "actual Script library conceive and generic Host return consume original ports",
      async () => {
        await set({ active: "script" });
        await each((page) =>
          page
            .getByRole("button", { name: "构思新剧", exact: true })
            .first()
            .click(),
        );
        const value = await observe("script-conceive");
        assert.ok(
          value[0]!.events.some(
            (e: unknown[]) => e[0] === "intent" && e[1] === "script",
          ),
        );
        await each((page) =>
          page.getByRole("button", { name: "应用启动台", exact: true }).click(),
        );
        const returned = await observe("host-launcher-return");
        assert.equal(returned[0]!.facts.active, null);
      },
    );
    await context.test(
      "actual Browser bridge page event preserves publish/write order",
      async () => {
        await set({ active: "browser" });
        await each((page) =>
          page.evaluate(() =>
            Reflect.get(window, "builtinFixture").emit("https://event.invalid"),
          ),
        );
        const values = await observe("bridge-event"),
          events = values[0]!.events as unknown[][];
        const write = events.findLastIndex(
          (e) =>
            e[0] === "execute" &&
            (e[1] as Props).state?.url === "https://event.invalid",
        );
        assert.ok(write > 0);
        assert.equal(events[write - 1]![0], "page");
      },
    );
    await context.test(
      "four accents light/dark effective wide/narrow/zoom and real motion",
      async () => {
        await set({ active: "reader" });
        const widths: number[] = [];
        for (const accent of ["cyan", "iris", "coral", "mono"])
          for (const appearance of ["light", "dark"])
            for (const [width, zoom] of [
              [1280, 1],
              [560, 1],
              [1280, 2],
            ]) {
              await each((page) =>
                page.setViewportSize({ width: width!, height: 900 }),
              );
              await each((page) =>
                page.evaluate(() =>
                  Reflect.get(window, "builtinFixture").settle(),
                ),
              );
              await set({ accent, appearance, zoom });
              const values = await observe(
                `${accent}-${appearance}-${width}-zoom${zoom}`,
              );
              assert.ok(values[0]!.geometry.center[2] > 0);
              assert.ok(values[0]!.geometry.pane[2] > 0);
              widths.push(values[0]!.geometry.center[2]);
            }
        assert.notEqual(
          widths[0],
          widths[1],
          "fixture's effective center, not only viewport, narrows",
        );
        assert.notEqual(
          widths[0],
          widths[2],
          "CSS zoom actually changes geometry",
        );
      },
    );
    await context.test(
      "actual unmount cleans all pane DOM and preserves only controlled events",
      async () => {
        const values = (await each((page) =>
          page.evaluate(() => Reflect.get(window, "builtinFixture").unmount()),
        )) as Props[];
        for (const value of values) {
          const contextEvents = value.events.filter(
            (e: unknown[]) => e[0] === "context",
          );
          assert.equal(
            contextEvents.at(-1)?.[2],
            null,
            "unmount explicitly clears the actual Reader source",
          );
        }
        await each((page) =>
          expect(page.locator(".application-pane")).toHaveCount(0),
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
      },
    );
  },
);
