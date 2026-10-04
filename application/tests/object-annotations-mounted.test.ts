import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isFunctionDeclaration,
  isVariableStatement,
  isExpressionStatement,
  isJsxElement,
  isPropertyAssignment,
  isMethodDeclaration,
  type Node,
} from "typescript/unstable/ast";
import { format } from "prettier";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import { fixedObjectAnnotationBaseline as fixed } from "./fixtures/object-annotations-9c6b8dd1.js";
import {
  readObjectInteractionOwner,
  verifyObjectInteractionConsumption,
} from "./fixtures/object-interactions-consumption.js";

// Actual fixed-old and current hooks/panels, real React/InspectorPanel/layout.
// Query promises and render facts are controlled, not authorization or durable
// receipts. These tests do not mount App, start Application/Runtime or send work.
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function parse(text: string) {
  const file = "/annotation/source.tsx",
    config = "/annotation/tsconfig.json";
  const api = new API({
    cwd: "/annotation",
    fs: createVirtualFileSystem({
      [file]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: [file],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const program = snapshot.getProject(config)!.program;
  assert.deepEqual(program.getSyntacticDiagnostics(), []);
  const nodes: Node[] = [];
  function visit(node: Node) {
    nodes.push(node);
    node.forEachChild(visit);
  }
  visit(program.getSourceFile(file)!);
  return {
    nodes,
    close() {
      snapshot.dispose();
      api.close();
    },
  };
}
const one = (
  nodes: Node[],
  predicate: (node: Node) => boolean,
  rule: string,
) => {
  const found = nodes.filter(predicate);
  assert.equal(found.length, 1, rule);
  return found[0]!;
};
const fn = (nodes: Node[], name: string) => {
  const node = one(
    nodes,
    (node) => isFunctionDeclaration(node) && node.name?.text === name,
    name,
  );
  assert.ok(isFunctionDeclaration(node));
  assert.ok(node.body);
  return node;
};
test("actual Git9c6 complete state/effect/projection/panel/query/receipt provenance and approved candidate body mappings", async () => {
  for (const span of Object.values(fixed.spans)) {
    assert.equal(sha(span.raw), span.sha256);
    assert.equal(Buffer.byteLength(span.raw), span.bytes);
  }
  const old = parse(
    readFileSync(
      resolve("tests/fixtures/object-annotations-9c6b8dd1.tsx"),
      "utf8",
    ),
  );
  const actual = parse(
    readFileSync(
      resolve("apps/web/src/features/content/ObjectAnnotations.tsx"),
      "utf8",
    ),
  );
  const client = parse(readFileSync(resolve("apps/web/src/client.ts"), "utf8"));
  const objectOwnerText = readObjectInteractionOwner();
  const objectOwner = parse(objectOwnerText);
  const receipt = parse(
    readFileSync(
      resolve("apps/web/src/host/exchange-submission-commands.ts"),
      "utf8",
    ),
  );
  const platform = parse(
    readFileSync(resolve("apps/web/src/platform-client.ts"), "utf8"),
  );
  try {
    for (const [name, prefix] of [
      [
        "AnnotationRefreshState",
        "const [annotationRefresh, setAnnotationRefresh]",
      ],
      [
        "AnnotationResultState",
        "const [annotationResult, setAnnotationResult]",
      ],
      ["AnnotationItemsProjection", "const annotations ="],
    ] as const)
      assert.equal(
        one(
          old.nodes,
          (node) =>
            isVariableStatement(node) && node.getText().startsWith(prefix),
          name,
        ).getText(),
        fixed.spans[name].raw,
      );
    assert.equal(
      one(
        old.nodes,
        (node) =>
          isExpressionStatement(node) &&
          node.getText().startsWith("useEffect(") &&
          node.getText().includes(".listObjectAnnotations("),
        "fixed entire effect",
      ).getText(),
      fixed.spans.AnnotationReadEffect.raw,
    );
    assert.equal(
      fn(actual.nodes, "useObjectAnnotations").body!.getText(),
      fn(old.nodes, "useFixedObjectAnnotations").body!.getText(),
      "entire hook retains two registrations, five dependencies and direct setter return",
    );
    assert.equal(
      fn(actual.nodes, "objectAnnotationItems").body!.getText(),
      fn(old.nodes, "fixedObjectAnnotationItems").body!.getText(),
      "entire ID-qualified getter, same array/fresh []",
    );
    const panel = (nodes: Node[]) =>
      one(
        nodes,
        (node) =>
          isJsxElement(node) &&
          node.openingElement.tagName.getText() === "InspectorPanel",
        "one complete real panel",
      ).getText();
    assert.equal(panel(old.nodes), fixed.spans.AnnotationPanel.raw);
    const mapped = panel(actual.nodes)
      .replace(
        "{authorName(a.author.actantId)}",
        "{actorName(state, a.author.actantId)}",
      )
      .replace(
        "focusOnMount={focusOnMount}",
        "focusOnMount={!sentInputFocusPending}",
      );
    const normalized = (value: string) =>
      format("const panel = (" + value + ");", {
        parser: "typescript",
        filepath: "panel.tsx",
      });
    assert.equal(
      await normalized(mapped),
      await normalized(fixed.spans.AnnotationPanel.raw),
      "complete panel only original author/focus binding maps and formatting",
    );
    assert.equal(
      fn(actual.nodes, "ObjectAnnotationsPanel").body!.statements.length,
      1,
      "panel contains only original JSX return",
    );
    assert.equal(
      fn(objectOwner.nodes, "listObjectAnnotations").getText(),
      fixed.spans.ClientQuery.raw,
    );
    assert.equal(
      fn(client.nodes, "actorName").getText(),
      fixed.spans.ActorName.raw,
    );
    assert.equal(
      one(
        client.nodes,
        (node) =>
          isPropertyAssignment(node) &&
          node.name.getText() === "listObjectAnnotations",
        "direct Client query alias",
      ).getText(),
      "listObjectAnnotations: objectInteractions.listObjectAnnotations",
    );
    verifyObjectInteractionConsumption(
      readFileSync(resolve("apps/web/src/client.ts"), "utf8"),
      objectOwnerText,
    );
    assert.equal(
      one(
        receipt.nodes,
        (node) =>
          isPropertyAssignment(node) &&
          node.name.getText() === "onResolved" &&
          node.getText().includes("setAnnotationRefresh"),
        "unchanged full receipt callback",
      ).getText(),
      fixed.spans.AnnotationReceipt.raw,
    );
    assert.equal(
      one(
        platform.nodes,
        (node) =>
          isMethodDeclaration(node) &&
          node.name.getText() === "listObjectAnnotations",
        "unchanged full Platform method",
      ).getText(),
      fixed.spans.PlatformQuery.raw,
    );
    for (const path of ["InspectorPanel.tsx", "inspector-layout.ts"] as const)
      assert.equal(
        sha(readFileSync(resolve("apps/web/src/" + path), "utf8")),
        fixed.originalFiles[path].sha256,
        "unchanged real " + path,
      );
  } finally {
    old.close();
    actual.close();
    client.close();
    objectOwner.close();
    receipt.close();
    platform.close();
  }
});

const source = `
import React,{StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {MessageSquarePlus} from 'lucide-react';
import {useObjectAnnotations,objectAnnotationItems,ObjectAnnotationsPanel} from '/src/features/content/ObjectAnnotations.tsx';
import {useFixedObjectAnnotations,fixedObjectAnnotationItems,FixedObjectAnnotationsPanel} from '/@fs/${resolve("tests/fixtures/object-annotations-9c6b8dd1.tsx")}';
import {actorName} from '/src/client.ts';import {useInspectorLayout} from '/src/InspectorPanel.tsx';
import '/src/styles.css';import '/src/ui.css';import '/src/workflow.css';import '/src/ui/dialog-surface.css';import '/src/visual-system.css';import '/src/exchange-layout.css';import '/src/inspector.css';import '/src/task-list.css';import '/src/content-catalog.css';import '/src/browser-bookmarks.css';import '/src/text-quotes.css';import '/src/profile-avatar.css';import '/src/personality-profile.css';import '/src/execution-activity.css';import '/src/execution-thread-groups.css';import '/src/application-icons.css';
const fixed=new URL(location.href).searchParams.get('lane')==='fixed',read=fixed?useFixedObjectAnnotations:useObjectAnnotations,itemsFor=fixed?fixedObjectAnnotationItems:objectAnnotationItems,options=window.annotationOptions??{};
const queries=[],events=[],captures=[],ids=new WeakMap();let nextId=0,api,last,unmounted=false;
const id=value=>{if(!value)return null;if(!ids.has(value))ids.set(value,++nextId);return ids.get(value);};
function request(contentId,signal,version){const index=queries.length;events.push(['query',index,contentId,version]);return new Promise((resolve,reject)=>{queries.push({index,contentId,signal,version,resolve,reject,settled:false});signal.addEventListener('abort',()=>events.push(['abort',index]),{once:true});});}
function Frame(){
 const[facts,setFacts]=useState({visible:false,artifact:{id:'A',revision:1,title:'原件A'},csrf:'csrf-0',change:0,version:0,names:{human:'原作者'},context:'原件A',pending:false,preferred:340,...options}),[draft,setDraft]=useState('原未发送草稿');
 const artifact=facts.artifact,collaborationVisible=facts.visible&&!!artifact,client={boot:{csrfToken:facts.csrf},workspaceChangeRevision:facts.change,listObjectAnnotations:(contentId,signal)=>request(contentId,signal,facts.version)};
 const{annotationResult,setAnnotationRefresh}=read({artifact,collaborationVisible,client});
 const annotations=itemsFor(artifact,annotationResult),state={actants:Object.entries(facts.names).map(([id,name])=>({id,name}))};
 const{ref:inspectorWorkspace,layout:rightInspector}=useInspectorLayout(facts.preferred);
 const resizeInspector=width=>{events.push(['resize',width]);setFacts(old=>({...old,preferred:width}));};
 const closeInspector=()=>{events.push(['close']);setFacts(old=>({...old,visible:false}));requestAnimationFrame(()=>document.querySelector('#toggle')?.focus({preventScroll:true}));};
 const inspectorViewOptions=[{label:'批注',icon:<MessageSquarePlus/>,pressed:true,onSelect:()=>events.push(['select','批注'])},{label:'执行记录',icon:<MessageSquarePlus/>,onSelect:()=>events.push(['select','执行记录'])}];
 last={facts,annotationResult,annotations,setAnnotationRefresh,rightInspector,draft};
 api={set(value){setFacts(old=>({...old,...value,artifact:value.artifact==='none'?undefined:value.artifact===undefined?old.artifact:value.artifact}));},refresh(count=1){for(let i=0;i<count;i++)setAnnotationRefresh(value=>value+1);},capture(){captures.push(setAnnotationRefresh);},captured(index){captures[index](value=>value+1);}};
 return <div className="app without-collaboration" data-accent="cyan" data-appearance="light"><aside className="sidebar" aria-hidden="true"/><div className="workspace" ref={inspectorWorkspace} data-inspector-mode={collaborationVisible?rightInspector.mode:undefined} data-inspector-width={collaborationVisible?rightInspector.width:undefined} style={{'--inspector-width':rightInspector.width+'px'}}>
  <header className="topbar"><strong>真实面板挂载夹具</strong></header>
  <div className="workspace-inspector-controls"><button id="toggle" aria-label="夹具右栏开关" onClick={()=>setFacts(old=>({...old,visible:!old.visible}))}>批注</button></div>
  <div className="workspace-body"><div className="primary-panel"><main aria-label="主工作区"><p id="body">原件正文与选区保留。</p><textarea id="draft" aria-label="夹具未发送草稿" value={draft} onChange={event=>setDraft(event.target.value)} autoFocus/></main></div></div>
  {collaborationVisible&&(fixed?<FixedObjectAnnotationsPanel artifact={artifact} annotationResult={annotationResult} annotations={annotations} state={state} inspectorViewOptions={inspectorViewOptions} contextTitle={facts.context} sentInputFocusPending={facts.pending} rightInspector={rightInspector} resizeInspector={resizeInspector} closeInspector={closeInspector}/>:<ObjectAnnotationsPanel artifact={artifact} annotationResult={annotationResult} annotations={annotations} authorName={actantId=>actorName(state,actantId)} viewOptions={inspectorViewOptions} context={facts.context} focusOnMount={!facts.pending} layout={rightInspector} onResize={resizeInspector} onClose={closeInspector}/>)}
 </div></div>;
}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Frame/></StrictMode>));
const motion=[];
function captureMotion(){const panel=document.querySelector('.collaboration');motion.push(panel?{name:getComputedStyle(panel).animationName,duration:getComputedStyle(panel).animationDuration,effects:panel.getAnimations({subtree:true}).map(animation=>({name:animation.animationName,timing:animation.effect.getTiming(),keyframes:animation.effect.getKeyframes()}))}:null);}
async function settle(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
function geometry(node){if(!node)return null;const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return {x:Math.round(rect.x*100)/100,y:Math.round(rect.y*100)/100,width:Math.round(rect.width*100)/100,height:Math.round(rect.height*100)/100,background:style.backgroundColor,color:style.color,padding:style.padding,border:style.border,shadow:style.boxShadow};}
function snapshot(){const panel=document.querySelector('.collaboration'),heading=panel?.querySelector('h2'),active=document.activeElement,draft=document.querySelector('#draft'),result=last.annotationResult;
 return {facts:last.facts,setterId:id(last.setAnnotationRefresh),capturedSetterIds:captures.map(id),result:result?{artifactId:result.artifactId,items:result.items,itemsId:id(result.items),error:result.error,loading:result.loading}:null,projection:{items:last.annotations,id:id(last.annotations),sameAsResult:!!result&&last.annotations===result.items},queries:queries.map(query=>({index:query.index,contentId:query.contentId,version:query.version,aborted:query.signal.aborted,settled:query.settled})),events,motion,layout:last.rightInspector,unmounted,draft:draft?.value??null,selection:draft?[draft.selectionStart,draft.selectionEnd]:null,active:{id:active?.id??'',tag:active?.tagName??'',text:active?.textContent??''},dom:{panel:panel?.outerHTML??null,panelId:id(panel),headingId:id(heading),parent:panel?.parentElement?.className??null,title:heading?.textContent??'',context:panel?.querySelector('.inspector-context')?.textContent??'',alert:panel?.querySelector('[role=alert]')?.textContent??null,loading:!!panel?.textContent.includes('正在读取批注…'),empty:!!panel?.querySelector('.discussion-empty'),sections:[...(panel?.querySelectorAll('.message.annotation')??[])].map(section=>({nodeId:id(section),author:section.querySelector('.message-author')?.textContent,version:section.querySelector('small')?.textContent,quote:section.querySelector('blockquote')?.textContent,body:section.querySelector('p')?.textContent})),separator:panel?.querySelector('[role=separator]')?{value:panel.querySelector('[role=separator]').getAttribute('aria-valuenow'),min:panel.querySelector('[role=separator]').getAttribute('aria-valuemin'),max:panel.querySelector('[role=separator]').getAttribute('aria-valuemax')}:null},geometry:{workspace:geometry(document.querySelector('.workspace')),canvas:geometry(document.querySelector('.workspace-body')),panel:geometry(panel),heading:geometry(heading)}};
}
captureMotion();
Object.assign(window,{annotationFixture:{snapshot,settle,async run(action,value){flushSync(()=>{
 if(action==='set')api.set(value);
 else if(action==='refresh')api.refresh(value??1);
 else if(action==='capture')api.capture();
 else if(action==='captured')api.captured(value);
 else if(action==='resolve'){const query=queries[value.index];query.settled=true;events.push(['resolve',query.index]);query.resolve(value.items);}
 else if(action==='reject'){const query=queries[value.index];query.settled=true;events.push(['reject',query.index,value.error]);query.reject(value.error==='non-error'?'non-error':new Error(value.error));}
 else if(action==='theme'){const app=document.querySelector('.app');app.dataset.accent=value.accent;app.dataset.appearance=value.appearance;app.style.zoom=String(value.zoom);window.dispatchEvent(new Event('resize'));}
 else if(action==='unmount'){root.unmount();unmounted=true;}
});captureMotion();await settle();return snapshot();}}});
`;

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  color: string;
  padding: string;
  border: string;
  shadow: string;
};
type Snapshot = {
  facts: {
    visible: boolean;
    artifact?: { id: string; revision: number; title: string };
    csrf: string;
    change: number;
    version: number;
    names: Record<string, string>;
    context: string;
    pending: boolean;
    preferred: number;
  };
  setterId: number;
  capturedSetterIds: number[];
  result: {
    artifactId: string;
    items: Note[];
    itemsId: number;
    error: string;
    loading: boolean;
  } | null;
  projection: { items: Note[]; id: number; sameAsResult: boolean };
  queries: {
    index: number;
    contentId: string;
    version: number;
    aborted: boolean;
    settled: boolean;
  }[];
  events: unknown[][];
  motion: unknown[];
  layout: { mode: string; width: number; maxWidth: number };
  unmounted: boolean;
  draft: string | null;
  selection: number[] | null;
  active: { id: string; tag: string; text: string };
  dom: {
    panel: string | null;
    panelId: number | null;
    headingId: number | null;
    parent: string | null;
    title: string;
    context: string;
    alert: string | null;
    loading: boolean;
    empty: boolean;
    sections: {
      nodeId: number;
      author: string;
      version: string;
      quote: string;
      body: string;
    }[];
    separator: { value: string; min: string; max: string } | null;
  };
  geometry: {
    workspace: Box | null;
    canvas: Box | null;
    panel: Box | null;
    heading: Box | null;
  };
};
type Note = {
  id: string;
  artifactId: string;
  artifactRevision: number;
  author: { actantId: string };
  page?: number;
  quote: string;
  body: string;
};
const note = (
  id = "note-one",
  artifactId = "A",
  revision = 1,
  page?: number,
): Note => ({
  id,
  artifactId,
  artifactRevision: revision,
  author: { actantId: "human" },
  ...(page ? { page } : {}),
  quote: "原引文 <em>不是HTML</em>",
  body: "批注正文\n第二行",
});
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
  available = executable
    ? existsSync(executable)
    : existsSync(chromium.executablePath());
test(
  "fixed and actual Object annotations preserve eight bounded real React/panel lifecycle contracts",
  {
    skip: available
      ? false
      : "set MORPHZ_TEST_BROWSER_EXECUTABLE or install the existing Playwright Chromium capability",
  },
  async (context) => {
    const cache = mkdtempSync(
      join(tmpdir(), "morphz-object-annotation-cache-"),
    );
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "isolated-object-annotations",
          resolveId(id) {
            if (id === "/__annotations.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__annotations.tsx")
              return transformWithOxc(source, "annotations.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__annotations")
                return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__annotations.tsx"></script></body></html>',
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
    const url = `http://127.0.0.1:${address.port}/__annotations`;
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
    async function pair(options: Partial<Snapshot["facts"]> = {}) {
      const pages: Page[] = [];
      for (const lane of ["fixed", "actual"]) {
        const isolated = await browser.newContext({
          viewport: { width: 1440, height: 900 },
        });
        context.after(() => isolated.close());
        await isolated.addInitScript(
          (options) => Reflect.set(window, "annotationOptions", options),
          options,
        );
        const page = await isolated.newPage();
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
          () => !!Reflect.get(window, "annotationFixture"),
        );
        await page.evaluate(() =>
          Reflect.get(window, "annotationFixture").settle(),
        );
        pages.push(page);
      }
      const read = () =>
        Promise.all(
          pages.map(
            (page) =>
              page.evaluate(async () => {
                const f = Reflect.get(window, "annotationFixture");
                await f.settle();
                return f.snapshot();
              }) as Promise<Snapshot>,
          ),
        );
      const parity = (values: Snapshot[]) => {
        assert.deepEqual(values[1], values[0], phase);
        return values[1]!;
      };
      const both = async (action: string, value: unknown = null) =>
        parity(
          await Promise.all(
            pages.map(
              (page) =>
                page.evaluate(
                  ([action, value]) =>
                    Reflect.get(window, "annotationFixture").run(action, value),
                  [action, value],
                ) as Promise<Snapshot>,
            ),
          ),
        );
      const close = async () => {
        for (const page of pages) await page.close();
      };
      return { pages, read, parity, both, close };
    }
    const active = (s: Snapshot) =>
      s.queries.filter((query) => !query.aborted && !query.settled).at(-1)!
        .index;

    await context.test(
      "cold hidden/no artifact, StrictMode, retained loading/items/error and stable dispatcher across hiding",
      async () => {
        phase = "cold hidden";
        const lane = await pair();
        let s = lane.parity(await lane.read());
        assert.equal(s.result, null);
        assert.equal(s.queries.length, 0);
        const setter = s.setterId;
        s = await lane.both("capture");
        s = await lane.both("set", { visible: true });
        assert.equal(s.queries.length, 1);
        assert.equal(s.result!.loading, true);
        const pending = active(s);
        s = await lane.both("set", { visible: false });
        assert.equal(s.queries[pending]!.aborted, true);
        assert.equal(s.result!.loading, true);
        assert.equal(s.dom.panel, null);
        s = await lane.both("resolve", { index: pending, items: [note()] });
        assert.equal(s.result!.loading, true);
        assert.deepEqual(s.result!.items, []);
        s = await lane.both("set", { visible: true });
        s = await lane.both("resolve", { index: active(s), items: [note()] });
        const retained = s.result!.itemsId;
        s = await lane.both("set", { visible: false });
        assert.equal(s.result!.itemsId, retained);
        assert.equal(s.projection.sameAsResult, true);
        s = await lane.both("set", { artifact: "none" });
        assert.equal(s.result!.itemsId, retained);
        assert.deepEqual(s.projection.items, []);
        const empty = s.projection.id;
        s = await lane.both("set", { context: "仍隐藏" });
        assert.notEqual(s.projection.id, empty);
        assert.equal(s.setterId, setter);
        assert.deepEqual(s.capturedSetterIds, [setter]);
        assert.equal(s.queries.length, 2);
        await lane.close();
        phase = "initial visible StrictMode";
        const replay = await pair({ visible: true });
        s = replay.parity(await replay.read());
        assert.equal(s.queries.length, 2);
        assert.equal(s.queries[0]!.aborted, true);
        assert.equal(s.queries[1]!.aborted, false);
        s = await replay.both("resolve", {
          index: 0,
          items: [note("aborted")],
        });
        assert.equal(s.result!.loading, true);
        s = await replay.both("reject", { index: 1, error: "retained error" });
        s = await replay.both("set", { visible: false });
        assert.equal(s.result!.error, "retained error");
        await replay.close();
      },
    );
    await context.test(
      "only five original dependencies retrigger, no Client object/history/title/name dependency, next effect captures trigger render",
      async () => {
        phase = "five dependencies";
        const lane = await pair({ visible: true });
        let s = lane.parity(await lane.read());
        s = await lane.both("resolve", { index: active(s), items: [note()] });
        const count = s.queries.length,
          resultId = s.result!.itemsId,
          projection = s.projection.id,
          setter = s.setterId,
          panel = s.dom.panelId;
        s = await lane.both("set", {
          version: 1,
          artifact: { id: "A", revision: 7, title: "历史七" },
          context: "历史七",
          names: { human: "更新作者" },
          pending: true,
        });
        assert.equal(s.queries.length, count);
        assert.equal(s.result!.itemsId, resultId);
        assert.equal(s.projection.id, projection);
        assert.equal(s.dom.panelId, panel);
        assert.ok(s.dom.sections[0]!.author.includes("更新作者"));
        assert.equal(s.setterId, setter);
        for (const value of [
          { csrf: "csrf-1" },
          { change: 1 },
          { artifact: { id: "B", revision: 1, title: "B" } },
        ]) {
          const before = s.queries.length;
          s = await lane.both("set", value);
          assert.equal(s.queries.length, before + 1);
          assert.equal(s.queries.at(-1)!.version, 1);
          assert.equal(s.result!.loading, true);
          assert.deepEqual(s.projection.items, []);
        }
        s = await lane.both("refresh");
        assert.equal(s.queries.length, count + 4);
        s = await lane.both("set", { visible: false });
        const hidden = s.queries.length;
        s = await lane.both("set", { visible: true });
        assert.equal(s.queries.length, hidden + 1);
        assert.equal(s.setterId, setter);
        await lane.close();
      },
    );
    await context.test(
      "original functional receipt refresh uses the same global React setter, including captured callback while hidden and batched updates",
      async () => {
        phase = "global receipt setter";
        const lane = await pair();
        let s = await lane.both("capture");
        const setter = s.setterId;
        s = await lane.both("captured", 0);
        assert.equal(s.queries.length, 0);
        s = await lane.both("set", { visible: true });
        s = await lane.both("resolve", { index: active(s), items: [] });
        const before = s.queries.length;
        s = await lane.both("refresh", 2);
        assert.equal(s.queries.length, before + 1);
        assert.equal(s.result!.loading, true);
        s = await lane.both("set", { visible: false });
        s = await lane.both("captured", 0);
        assert.equal(s.queries.length, before + 1);
        s = await lane.both("set", { visible: true });
        assert.equal(s.queries.length, before + 2);
        s = await lane.both("capture");
        assert.deepEqual(s.capturedSetterIds, [setter, setter]);
        assert.equal(s.setterId, setter);
        await lane.close();
      },
    );
    await context.test(
      "real abort cleanup rejects reversed A/B, hidden and unmounted completions without clearing retained state",
      async () => {
        phase = "reverse completion";
        const lane = await pair({ visible: true });
        let s = lane.parity(await lane.read());
        const a = active(s);
        s = await lane.both("set", {
          artifact: { id: "B", revision: 2, title: "B" },
        });
        const b = active(s);
        assert.equal(s.queries[a]!.aborted, true);
        s = await lane.both("resolve", {
          index: b,
          items: [note("B-note", "B", 2)],
        });
        const result = s.result;
        s = await lane.both("resolve", { index: a, items: [note("A-late")] });
        assert.deepEqual(s.result, result);
        s = await lane.both("reject", { index: 0, error: "old replay error" });
        assert.deepEqual(s.result, result);
        s = await lane.both("refresh");
        const c = active(s);
        s = await lane.both("set", { visible: false });
        const loading = s.result;
        s = await lane.both("reject", { index: c, error: "hidden error" });
        assert.deepEqual(s.result, loading);
        s = await lane.both("set", { visible: true });
        const d = active(s);
        s = await lane.both("unmount");
        assert.equal(s.queries[d]!.aborted, true);
        const before = s.result;
        s = await lane.both("resolve", {
          index: d,
          items: [note("unmounted", "B")],
        });
        assert.equal(s.unmounted, true);
        assert.equal(s.dom.panel, null);
        assert.deepEqual(s.result, before);
        await lane.close();
      },
    );
    await context.test(
      "original Error/non-Error, retry/loading/empty and same-ID historical revisions remain object-wide",
      async () => {
        phase = "error history";
        const lane = await pair({ visible: true });
        let s = lane.parity(await lane.read());
        s = await lane.both("reject", {
          index: active(s),
          error: "read error",
        });
        assert.equal(s.dom.alert, "批注读取失败：read error");
        s = await lane.both("refresh");
        assert.equal(s.dom.loading, true);
        assert.equal(s.dom.alert, null);
        s = await lane.both("reject", { index: active(s), error: "non-error" });
        assert.equal(s.dom.alert, "批注读取失败：批注暂时无法读取。");
        s = await lane.both("refresh");
        const current = active(s),
          count = s.queries.length;
        s = await lane.both("set", {
          artifact: { id: "A", revision: 9, title: "旧版九" },
        });
        assert.equal(s.queries.length, count);
        assert.equal(s.queries[current]!.aborted, false);
        s = await lane.both("resolve", {
          index: current,
          items: [note("historic", "A", 1, 3)],
        });
        assert.equal(s.dom.sections[0]!.version, "批注 · v1 · 第 3 页");
        assert.equal(s.queries.at(-1)!.contentId, "A");
        s = await lane.both("set", {
          artifact: { id: "A", revision: 1, title: "旧版一" },
        });
        assert.equal(s.queries.length, count);
        assert.equal(s.dom.sections.length, 1);
        s = await lane.both("refresh");
        s = await lane.both("resolve", { index: active(s), items: [] });
        assert.equal(s.dom.empty, true);
        assert.equal(s.dom.alert, null);
        assert.equal(s.dom.loading, false);
        await lane.close();
      },
    );
    await context.test(
      "complete panel preserves author/version/page/text DOM, escaping/order/key identity and actual menu contracts",
      async () => {
        phase = "complete panel DOM";
        const lane = await pair({ visible: true });
        let s = lane.parity(await lane.read());
        const unknown = {
          ...note("unknown", "A", 4),
          author: { actantId: "missing" },
          quote: "<script>不得执行</script>",
          body: "<img src=x onerror=alert(1)>",
        };
        s = await lane.both("resolve", {
          index: active(s),
          items: [note("first", "A", 2, 2), unknown],
        });
        assert.equal(s.dom.parent, "workspace");
        assert.equal(s.dom.title, "批注");
        assert.equal(s.dom.context, "原件A");
        assert.equal(s.dom.sections.length, 2);
        assert.equal(s.dom.sections[0]!.version, "批注 · v2 · 第 2 页");
        assert.equal(s.dom.sections[1]!.version, "批注 · v4");
        assert.ok(s.dom.sections[1]!.author.startsWith("未知参与者"));
        assert.equal(s.dom.sections[1]!.quote, unknown.quote);
        assert.equal(s.dom.sections[1]!.body, unknown.body);
        const nodes = s.dom.sections.map((item) => item.nodeId),
          panel = s.dom.panelId;
        s = await lane.both("set", {
          names: { human: "新版参与者" },
          context: "新标题",
        });
        assert.deepEqual(
          s.dom.sections.map((item) => item.nodeId),
          nodes,
        );
        assert.equal(s.dom.panelId, panel);
        assert.ok(s.dom.sections[0]!.author.startsWith("新版参与者"));
        for (const page of lane.pages) {
          assert.equal(
            await page
              .locator(".collaboration script,.collaboration img")
              .count(),
            0,
          );
          await page
            .getByRole("button", { name: "切换右栏内容", exact: true })
            .click();
          await page
            .getByRole("group", { name: "右栏内容", exact: true })
            .getByRole("button", { name: "执行记录", exact: true })
            .click();
        }
        s = lane.parity(await lane.read());
        assert.deepEqual(
          s.events.filter((event) => event[0] === "select"),
          [["select", "执行记录"]],
        );
        await lane.close();
      },
    );
    await context.test(
      "mount-only real heading focus and continued-input witness survive receipt/reading updates and Escape without draft mutation",
      async () => {
        phase = "mount focus";
        const lane = await pair();
        let s = await lane.both("set", { visible: true });
        assert.equal(s.active.tag, "H2");
        const panel = s.dom.panelId;
        for (const page of lane.pages) {
          await page.getByLabel("夹具未发送草稿").fill("发送之后仍继续输入");
          await page
            .getByLabel("夹具未发送草稿")
            .evaluate((node) =>
              (node as HTMLTextAreaElement).setSelectionRange(2, 5),
            );
        }
        s = await lane.both("resolve", { index: active(s), items: [note()] });
        assert.equal(s.active.id, "draft");
        assert.deepEqual(s.selection, [2, 5]);
        assert.equal(s.dom.panelId, panel);
        s = await lane.both("refresh");
        assert.equal(s.active.id, "draft");
        s = await lane.both("set", { pending: true });
        assert.equal(s.active.id, "draft");
        for (const page of lane.pages) {
          await page.locator(".collaboration h2").focus();
          await page.keyboard.press("Escape");
        }
        s = lane.parity(await lane.read());
        assert.equal(s.dom.panel, null);
        assert.equal(s.active.id, "toggle");
        assert.equal(s.draft, "发送之后仍继续输入");
        s = await lane.both("set", { visible: true });
        assert.equal(s.active.id, "toggle");
        for (const page of lane.pages)
          await page.getByLabel("夹具未发送草稿").focus();
        s = await lane.both("set", { pending: false });
        assert.equal(s.active.id, "draft");
        assert.equal(s.draft, "发送之后仍继续输入");
        await lane.close();
      },
    );
    await context.test(
      "actual layout, keyboard/pointer resize, overlay and 48 theme/viewport/zoom geometry comparisons have effective center widths",
      async () => {
        phase = "real resize";
        const lane = await pair({ visible: true });
        let s = lane.parity(await lane.read());
        assert.equal(s.layout.mode, "docked");
        assert.equal(s.dom.separator!.value, "340");
        for (const page of lane.pages)
          await page
            .getByRole("separator", { name: "调整批注栏宽度", exact: true })
            .press("ArrowLeft");
        s = lane.parity(await lane.read());
        assert.equal(s.dom.separator!.value, "356");
        for (const page of lane.pages) {
          const sep = page.getByRole("separator", {
              name: "调整批注栏宽度",
              exact: true,
            }),
            rect = (await sep.boundingBox())!;
          await page.mouse.move(rect.x + rect.width / 2, rect.y + 80);
          await page.mouse.down();
          await page.mouse.move(rect.x - 20, rect.y + 80);
          await page.mouse.up();
        }
        s = lane.parity(await lane.read());
        assert.ok(Number(s.dom.separator!.value) > 356);
        const queries = s.queries.length;
        const observations: {
          accent: string;
          appearance: string;
          viewport: number;
          zoom: number;
          layout: Snapshot["layout"];
          geometry: Snapshot["geometry"];
        }[] = [];
        for (const accent of ["cyan", "iris", "coral", "mono"])
          for (const appearance of ["light", "dark"])
            for (const viewport of [1440, 1000, 760])
              for (const zoom of [1, 2]) {
                phase = [accent, appearance, viewport, zoom].join(":");
                for (const page of lane.pages)
                  await page.setViewportSize({ width: viewport, height: 900 });
                s = await lane.both("theme", { accent, appearance, zoom });
                assert.equal(s.queries.length, queries);
                assert.equal(s.dom.parent, "workspace");
                assert.equal(
                  s.dom.separator !== null,
                  s.layout.mode === "docked",
                );
                assert.ok(s.geometry.workspace!.width > 0);
                assert.ok(s.geometry.panel!.width > 0);
                assert.equal(
                  s.geometry.panel!.x + s.geometry.panel!.width,
                  s.geometry.workspace!.x + s.geometry.workspace!.width,
                );
                observations.push({
                  accent,
                  appearance,
                  viewport,
                  zoom,
                  layout: s.layout,
                  geometry: s.geometry,
                });
              }
        assert.equal(observations.length, 48);
        for (const accent of ["cyan", "iris", "coral", "mono"])
          for (const appearance of ["light", "dark"]) {
            const width = (viewport: number, zoom: number) =>
              observations.find(
                (value) =>
                  value.accent === accent &&
                  value.appearance === appearance &&
                  value.viewport === viewport &&
                  value.zoom === zoom,
              )!.geometry.workspace!.width;
            assert.ok(width(1440, 1) > width(760, 1));
            assert.ok(width(1440, 2) > width(760, 2));
            assert.ok(width(1440, 1) > width(1440, 2));
            assert.ok(width(760, 1) > width(760, 2));
          }
        assert.ok(observations.some((value) => value.layout.mode === "docked"));
        assert.ok(
          observations.some((value) => value.layout.mode === "overlay"),
        );
        context.diagnostic(
          JSON.stringify({
            exactSnapshotComparisons: 48,
            observationsSHA256: sha(JSON.stringify(observations)),
            observations,
            actualMotionComparedBeforeSettling: s.motion,
          }),
        );
        await lane.close();
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(businessReads, []);
  },
);
