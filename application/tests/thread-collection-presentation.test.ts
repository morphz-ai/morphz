import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import {
  initialWorkspace,
  type RecordedInput,
  type Workspace,
} from "../packages/core/src/model.js";
import {
  disconnectedRuntime,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import type { ExecutionScope } from "../packages/core/src/execution.js";
import { liveMessageSchema } from "../packages/core/src/live-conversation.js";
import {
  inputExecutionActivityPresentation,
  executionActivityOverview,
  executionActivityOverviewSummary,
  executionActivitySummary,
  type ActivityThread,
} from "../apps/web/src/execution-activity.js";
import {
  fixedThreadMetadata,
  fixedThreadDeclarations,
  fixedInputExecutionActivityPresentation,
  fixedExecutionActivityOverview,
  fixedExecutionActivityOverviewSummary,
} from "./fixtures/thread-collection-a1acc677.js";

// Domain projection and real complete React consumers with controlled original ports.
// Not App/native acceptance, Client ACL/HTTP/SQLite proof or Runtime/model execution.
const migration =
  process.env.MORPHZ_TEST_THREAD_COLLECTION_MIGRATION_EQUIVALENCE === "1";
const stamp = "2026-10-04T12:00:00.000Z";
const scope: ExecutionScope = {
  projectId: "first-project",
  conversationId: "first-project",
  artifactId: null,
};
function thread(extra: Partial<ActivityThread> = {}): ActivityThread {
  return {
    id: "thread-one",
    kind: "execution",
    projectId: "first-project",
    conversationId: "first-project",
    inputId: "input-one",
    rootId: "root-one",
    sessionId: "session-one",
    contextId: "context-one",
    title: "原后台工作",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: stamp,
    ...extra,
  };
}
function input(extra: Partial<RecordedInput> = {}): RecordedInput {
  return {
    id: "input-one",
    projectId: "first-project",
    conversationId: "first-project",
    artifactId: "artifact-one",
    artifactRevision: null,
    selection: "",
    body: "原始要求",
    author: { principalId: "local-owner", actantId: "local-human" },
    targetActantId: "morphz-agent",
    status: "recorded",
    createdAt: stamp,
    ...extra,
  };
}
function runtime(
  threads: ActivityThread[] = [],
  extra: Partial<ConversationRuntime> = {},
): ConversationRuntime {
  return {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    activity: { available: true, truncated: false, threads },
    ...extra,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function inputProjection(
  rt: ConversationRuntime,
  item?: Pick<RecordedInput, "id"> | null,
  online?: boolean | null,
) {
  const subject = arguments.length < 2 ? { id: "input-one" } : item;
  const connected = arguments.length < 3 ? true : online;
  const before = structuredClone(rt),
    result = inputExecutionActivityPresentation(freeze(rt), subject, connected);
  if (migration)
    assert.deepEqual(
      result,
      fixedInputExecutionActivityPresentation(rt, subject, connected),
    );
  assert.deepEqual(rt, before, "input projection never changes Runtime facts");
  return result;
}
function overview(
  threads: ActivityThread[],
  options: {
    state?: Workspace;
    scope?: ExecutionScope;
    allWork?: boolean;
    sharedDefault?: boolean;
    runtime?: ConversationRuntime;
  } = {},
) {
  const state = options.state ?? initialWorkspace(stamp),
    rt = options.runtime ?? runtime(threads);
  const args = [
    freeze(state),
    freeze(threads),
    options.scope ?? scope,
    options.allWork ?? false,
    options.sharedDefault ?? false,
    freeze(rt),
  ] as const;
  const before = [
      structuredClone(state),
      structuredClone(threads),
      structuredClone(rt),
    ],
    result = executionActivityOverview(...args);
  if (migration)
    assert.deepEqual(result, fixedExecutionActivityOverview(...args));
  assert.deepEqual(
    [state, threads, rt],
    before,
    "overview never mutates authorized collections",
  );
  const summary = executionActivityOverviewSummary(
    rt,
    result.activityAvailable,
    result.activeCount,
  );
  if (migration)
    assert.equal(
      summary,
      fixedExecutionActivityOverviewSummary(
        rt,
        result.activityAvailable,
        result.activeCount,
      ),
    );
  return { ...result, summary };
}
const ids = (threads: readonly ActivityThread[]) => threads.map((t) => t.id);
function fixedNow<T>(run: () => T): T {
  const Original = globalThis.Date;
  class Clock extends Original {
    constructor(value?: string | number | Date) {
      super(
        value === undefined
          ? stamp
          : value instanceof Original
            ? value.getTime()
            : value,
      );
    }
    static override now() {
      return Original.parse(stamp);
    }
  }
  globalThis.Date = Clock as DateConstructor;
  try {
    return run();
  } finally {
    globalThis.Date = Original;
  }
}

test("independent Git a1acc archive keeps thirteen complete raw declarations, not a current-renderer hash contract", () => {
  assert.equal(
    fixedThreadMetadata.git,
    "a1acc677402045068384a73f8f72a2d8c28f6b1e",
  );
  assert.equal(Object.keys(fixedThreadDeclarations).length, 13);
  for (const name of Object.keys(
    fixedThreadDeclarations,
  ) as (keyof typeof fixedThreadDeclarations)[]) {
    assert.equal(
      createHash("sha256").update(fixedThreadDeclarations[name]).digest("hex"),
      fixedThreadMetadata.spans[name].sha256,
      name,
    );
    assert.ok(fixedThreadDeclarations[name].startsWith(`const ${name} =`));
  }
});

test("input identity, execution/open and connectivity exclude replies, delivery and terminal work without invented idle", () => {
  const source = [
    thread(),
    thread({ id: "other-input", inputId: "input-other" }),
    thread({ id: "dialogue", kind: "dialogue" }),
    thread({ id: "turn", kind: "dialogue_turn" }),
    thread({ id: "legacy", kind: undefined }),
    ...["completed", "failed", "cancelled"].map((lifecycle) =>
      thread({ id: lifecycle, lifecycle }),
    ),
  ];
  assert.deepEqual(inputProjection(runtime(source)), {
    activeBranch: true,
    workStatus: { kind: "running", label: "执行中" },
  });
  for (const item of [null, undefined, { id: "not-recorded" }])
    assert.deepEqual(inputProjection(runtime(source), item), {
      activeBranch: false,
      workStatus: undefined,
    });
  for (const online of [false, null, undefined])
    assert.deepEqual(
      inputProjection(runtime(source), { id: "input-one" }, online),
      { activeBranch: false, workStatus: undefined },
    );
  for (const rt of [
    runtime(source, { connected: false }),
    runtime(source, {
      activity: { available: false, truncated: false, threads: source },
    }),
    runtime(source, { activity: undefined }),
    runtime([]),
  ])
    assert.deepEqual(inputProjection(rt), {
      activeBranch: false,
      workStatus: undefined,
    });
});

test("input complete phases/control and mixed priority stay running then unknown then paused then first, not family waiting priority", () => {
  const phases = {
    running: ["running", "执行中"],
    runnable: ["waiting", "待执行"],
    waiting: ["waiting", "等待中"],
    idle: ["waiting", "等待唤醒"],
    future: ["unknown", "状态待核对"],
  } as const;
  for (const [phase, [kind, label]] of Object.entries(phases))
    for (const controlState of [
      undefined,
      "active",
      "paused",
      "cancel_requested",
      "future-control",
    ])
      assert.deepEqual(
        inputProjection(runtime([thread({ phase, controlState })])).workStatus,
        controlState === "paused"
          ? { kind: "paused", label: "已暂停" }
          : { kind, label },
      );
  const values = [
    thread({ id: "waiting", phase: "waiting" }),
    thread({ id: "paused", controlState: "paused" }),
    thread({ id: "unknown", phase: "future" }),
    thread({ id: "running" }),
  ];
  for (const order of [
    values,
    [...values].reverse(),
    [values[2]!, values[0]!, values[3]!, values[1]!],
  ]) {
    assert.equal(inputProjection(runtime(order)).workStatus?.kind, "running");
    assert.equal(
      inputProjection(runtime(order.filter((t) => t.id !== "running")))
        .workStatus?.kind,
      "unknown",
    );
    assert.equal(
      inputProjection(
        runtime(order.filter((t) => !["running", "unknown"].includes(t.id))),
      ).workStatus?.kind,
      "paused",
    );
  }
  assert.equal(
    inputProjection(
      runtime([
        thread({ phase: "runnable" }),
        thread({ phase: "waiting", id: "second" }),
      ]),
    ).workStatus?.label,
    "待执行",
  );
  assert.equal(
    inputProjection(
      runtime([
        thread({ phase: "waiting" }),
        thread({ phase: "runnable", id: "second" }),
      ]),
    ).workStatus?.label,
    "等待中",
  );
});

test("input absent/offline/unavailable branches preserve original getter short circuits", () => {
  const forbidden = () => {
    throw new Error("must not eagerly read unavailable Runtime");
  };
  const rt = new Proxy(runtime(), {
    get(target, key) {
      if (key === "connected") return forbidden();
      return Reflect.get(target, key);
    },
  });
  for (const [item, online] of [
    [null, true],
    [undefined, true],
    [{ id: "input-one" }, false],
  ] as const)
    assert.deepEqual(inputExecutionActivityPresentation(rt, item, online), {
      activeBranch: false,
      workStatus: undefined,
    });
  const disconnected = new Proxy(runtime([], { connected: false }), {
    get(target, key) {
      if (key === "activity") return forbidden();
      return Reflect.get(target, key);
    },
  });
  assert.equal(
    inputExecutionActivityPresentation(disconnected, { id: "input-one" }, true)
      .activeBranch,
    false,
  );
  const activity = new Proxy(
    { available: false, truncated: false, threads: [thread()] },
    {
      get(target, key) {
        if (key === "threads") return forbidden();
        return Reflect.get(target, key);
      },
    },
  );
  assert.equal(
    inputExecutionActivityPresentation(
      runtime([], { activity }),
      { id: "input-one" },
      true,
    ).activeBranch,
    false,
  );
});

test("overview authorized default/named/artifact/all-work scopes retain immutable identities, versions and order", () => {
  const state = initialWorkspace(stamp);
  state.inputs.push(input(), input({ id: "other-input" }));
  const source = [
    thread(),
    thread({ id: "named", conversationId: "named-session" }),
    thread({ id: "sibling" }),
    thread({
      id: "foreign",
      inputId: "other-input",
      projectId: "private-project",
      conversationId: "private-project",
    }),
    thread({ id: "dialogue", kind: "dialogue" }),
    thread({
      revision: 3,
      lifecycle: "completed",
      updatedAt: "2026-10-04T13:00:00Z",
    }),
    thread({ id: "sibling", revision: 2, updatedAt: "2026-10-04T14:00:00Z" }),
  ];
  const current = overview(source, { state });
  assert.deepEqual(ids(current.activityThreads), ["sibling", "thread-one"]);
  assert.equal(current.activityThreads[1]!.revision, 3);
  assert.deepEqual(
    ids(
      overview(source, {
        state,
        scope: { ...scope, conversationId: "named-session" },
      }).activityThreads,
    ),
    ["named"],
  );
  assert.deepEqual(
    ids(
      overview(source, {
        state,
        scope: { ...scope, artifactId: "artifact-one" },
      }).activityThreads,
    ),
    ["sibling", "named", "thread-one"],
  );
  assert.equal(
    overview(source, { state, allWork: true }).activityThreads.length,
    4,
  );
  const global = {
    projectId: "local-dialogue",
    conversationId: "local-dialogue",
    artifactId: null,
  };
  const desk = state.projects.find((p) => p.id === "local-worktable")!;
  const personal = [
    thread({ id: "desk", projectId: desk.id, conversationId: desk.id }),
    thread({
      id: "named",
      projectId: desk.id,
      conversationId: "named-session",
    }),
  ];
  assert.deepEqual(
    ids(
      overview(personal, {
        state: structuredClone(state),
        scope: global,
        sharedDefault: true,
      }).activityThreads,
    ),
    ["desk"],
  );
  assert.equal(
    overview(personal, {
      state: structuredClone(state),
      scope: global,
      sharedDefault: false,
    }).activityThreads.length,
    0,
  );
  const ties = [
    thread({ id: "z", updatedAt: "not-a-date" }),
    thread({ id: "a", updatedAt: "not-a-date" }),
    thread({ id: "a", revision: 1, updatedAt: stamp }),
  ];
  assert.deepEqual(ids(overview(ties).activityThreads), ["a", "z"]);
  assert.equal(overview(ties).activityThreads[0]!.updatedAt, stamp);
});

test("overview counts real roots: completed parents stay active for open descendants, missing/cyclic/cross-domain parents remain discoverable", () => {
  const parent = thread({ id: "parent", lifecycle: "completed" }),
    child = thread({ id: "child", parentThreadId: "parent" }),
    grandchild = thread({ id: "grand", parentThreadId: "child" }),
    sibling = thread({ id: "sibling" });
  const family = overview([parent, child, grandchild, sibling]);
  assert.deepEqual(ids(family.active), ["sibling", "parent"]);
  assert.equal(family.activeCount, 2);
  assert.equal(family.activityThreads.length, 4);
  assert.equal(family.recent.length, 0);
  assert.deepEqual(
    ids(overview([thread({ id: "orphan", parentThreadId: "missing" })]).active),
    ["orphan"],
  );
  assert.deepEqual(
    ids(
      overview([
        thread({ id: "cycle-a", parentThreadId: "cycle-b" }),
        thread({ id: "cycle-b", parentThreadId: "cycle-a" }),
      ]).active,
    ),
    ["cycle-a", "cycle-b"],
  );
  for (const changed of [
    { sessionId: "other" },
    { contextId: "other" },
    { conversationId: "other" },
    { projectId: "other", conversationId: "other" },
  ]) {
    const result = overview(
      [
        parent,
        thread({ id: "foreign-child", parentThreadId: "parent", ...changed }),
      ],
      { allWork: true },
    );
    assert.deepEqual(ids(result.active), ["foreign-child"]);
    assert.deepEqual(
      result.recent.flatMap((group) => ids(group.threads)),
      ["parent"],
    );
  }
  const closed = overview([
    parent,
    thread({
      id: "failed-child",
      parentThreadId: "parent",
      lifecycle: "failed",
    }),
  ]);
  assert.equal(closed.activeCount, 0);
  assert.deepEqual(
    closed.recent.flatMap((group) => ids(group.threads)),
    ["parent"],
  );
});

test("overview availability/completeness and truncated lower bound never promote cached zero to confirmed idle", () => {
  for (const connected of [false, true])
    for (const available of [false, true])
      for (const truncated of [false, true])
        for (const source of [[], [thread()]]) {
          const result = overview(source, {
            runtime: runtime(source, {
              connected,
              activity: { available, truncated, threads: source },
            }),
          });
          assert.equal(result.activityAvailable, connected && available);
          assert.equal(
            result.activityComplete,
            connected && available && !truncated,
          );
          assert.equal(result.activeCount, source.length);
          assert.equal(
            result.summary,
            !connected || !available || (truncated && !source.length)
              ? "工作状态待核对"
              : truncated
                ? "至少 1 项进行中"
                : `${source.length} 项进行中`,
          );
        }
  const missing = overview([thread()], {
    runtime: runtime([], { activity: undefined }),
  });
  assert.equal(missing.activityAvailable, false);
  assert.equal(missing.summary, "工作状态待核对");
  assert.equal(missing.activeCount, 1);
});

test("overview date quality uses matching terminal time and keeps first group order with controlled local now", () =>
  fixedNow(() => {
    const source = [
      thread({
        id: "today",
        lifecycle: "completed",
        updatedAt: "wrong",
        outcome: {
          terminalKind: "completed",
          disposition: "succeeded",
          summary: null,
          createdAt: stamp,
        },
      }),
      thread({
        id: "yesterday",
        lifecycle: "failed",
        updatedAt: "2026-10-03T12:00:00Z",
      }),
      thread({
        id: "old",
        lifecycle: "cancelled",
        updatedAt: "2026-09-30T12:00:00Z",
      }),
      thread({
        id: "unknown",
        lifecycle: "completed",
        updatedAt: "invalid",
        outcome: {
          terminalKind: "failed",
          disposition: "failed",
          summary: null,
          createdAt: stamp,
        },
      }),
    ];
    const result = overview(source);
    assert.deepEqual(
      result.recent.map((group) => group.label),
      ["今天", "昨天", "2026年9月30日", "时间待核对"],
    );
    assert.deepEqual(
      result.recent.flatMap((group) => ids(group.threads)),
      ["today", "yesterday", "old", "unknown"],
    );
  }));

test("two original overview phases keep date construction before availability, prose between phases and lazy summary quality reads", () => {
  function lane(
    collect: typeof executionActivityOverview,
    summarize: typeof executionActivityOverviewSummary,
  ) {
    const log: string[] = [],
      Original = globalThis.Date;
    class Clock extends Original {
      constructor(value?: string | number | Date) {
        log.push(value === undefined ? "date-now" : "date-value");
        super(
          value === undefined
            ? stamp
            : value instanceof Original
              ? value.getTime()
              : value,
        );
      }
    }
    const activity = new Proxy(
      { available: true, truncated: true, threads: [] as ActivityThread[] },
      {
        get(target, key) {
          if (key === "available" || key === "truncated") log.push(String(key));
          return Reflect.get(target, key);
        },
      },
    );
    const rt = new Proxy(runtime([], { activity }), {
      get(target, key) {
        if (key === "connected" || key === "activity") log.push(String(key));
        return Reflect.get(target, key);
      },
    });
    const closed = thread({ lifecycle: "completed" });
    Object.defineProperty(closed, "summary", {
      get() {
        log.push("thread-summary");
        return "原历史成果";
      },
    });
    globalThis.Date = Clock as DateConstructor;
    try {
      const result = collect(
        initialWorkspace(stamp),
        [closed],
        scope,
        false,
        false,
        rt,
      );
      assert.equal(
        executionActivitySummary(closed, result.activityAvailable),
        "原历史成果",
      );
      assert.equal(
        summarize(rt, result.activityAvailable, result.activeCount),
        "工作状态待核对",
      );
    } finally {
      globalThis.Date = Original;
    }
    assert.ok(log.indexOf("date-now") < log.indexOf("connected"));
    assert.ok(log.indexOf("thread-summary") > log.indexOf("truncated"));
    assert.equal(log.filter((value) => value === "truncated").length, 2);
    assert.equal(log.at(-1), "truncated");
    return log;
  }
  const actual = lane(
    executionActivityOverview,
    executionActivityOverviewSummary,
  );
  if (migration)
    assert.deepEqual(
      actual,
      lane(
        fixedExecutionActivityOverview,
        fixedExecutionActivityOverviewSummary,
      ),
    );
  const forbidden = new Proxy(runtime(), {
    get(target, key) {
      if (key === "activity")
        throw new Error("summary must not eagerly read quality");
      return Reflect.get(target, key);
    },
  });
  assert.equal(
    executionActivityOverviewSummary(forbidden, false, 0),
    "工作状态待核对",
  );
});

const browserSource = `
import React,{StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {Conversation} from '/src/Conversation.tsx';import {ExecutionSidebar} from '/src/ExecutionSidebar.tsx';
const state=${JSON.stringify({ ...initialWorkspace(stamp), inputs: [input(), input({ id: "named-input", conversationId: "named-session", artifactId: null, body: "具名原始要求" })] })},events=[],reads=[],positions=new Map(),nodes=new WeakMap();let serial=0,api;
const initialThreads=${JSON.stringify([thread({ id: "parent", lifecycle: "completed", summary: "父工作成果" }), thread({ id: "child", parentThreadId: "parent", summary: "真实子任务进度" }), thread({ id: "named", conversationId: "named-session", inputId: "named-input" })])};
window.morphzDesktop={application:{onStream:()=>()=>{},subscribe:async(id,scope)=>{reads.push(['subscribe',scope]);},unsubscribe:()=>{}}};
function Frame(){const[facts,setFacts]=useState({threads:initialThreads,online:true,connected:true,available:true,truncated:false,allWork:false,scope:${JSON.stringify(scope)}});api=value=>setFacts(old=>({...old,...value}));
const runtime={configured:true,connected:facts.connected,model:'',error:'',deliveries:[],messages:[],activity:{available:facts.available,truncated:facts.truncated,threads:facts.threads}};
const client={online:facts.online,workspaceChangeRevision:0,boot:{centerId:'fixture-center',principalId:'local-owner',csrfToken:'fixture-generation',actantId:'local-human',workspace:state,runtime,outputs:[],scriptOutputs:[],localSavedInputIds:[],localInputSubmissions:{},capabilities:{teamAuthentication:true}},contentCatalog:[],contentVersionTitle:()=> '原对象',executionSnapshot:async(scope)=>{reads.push(['snapshot',scope]);return{jobs:[],approvals:[],limit:100};},executionResult:async()=>null,controlExecution:async operation=>{events.push(['control',operation]);},cancelInput:async id=>events.push(['cancel',id]),approvalSubmitted:()=>false};
return <main><button id="outside">原画布</button><Conversation inputs={[state.inputs[0]]} state={state} runtime={runtime} messages={[]} streamConnected={false} seenReplies={{}} onRead={()=>{}} conversationId="first-project" onRetry={async()=>{}} client={client} onOpen={()=>{}} positions={positions} revealInputId={null} onInspect={id=>events.push(['inspect',id])}/><ExecutionSidebar client={client} scope={facts.scope} layout={{mode:'docked',width:340,maxWidth:520}} onResize={()=>{}} onClose={()=>events.push(['close'])} onSelect={scope=>{events.push(['select',scope]);api({scope});}} onOpen={()=>{}} onSupplement={value=>events.push(['supplement',value])} allWork={facts.allWork} onAllWorkChange={allWork=>{events.push(['allWork',allWork]);api({allWork});}} onRefresh={async()=>events.push(['refresh'])}/></main>;}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<StrictMode><Frame/></StrictMode>));
const id=node=>{if(!node)return null;if(!nodes.has(node))nodes.set(node,++serial);return nodes.get(node);};
function snapshot(){return{events:[...events],reads:[...reads],cards:[...document.querySelectorAll('[data-message-id]')].map(n=>({id:n.getAttribute('data-message-id'),node:id(n),background:n.hasAttribute('data-background-execution')})),rows:[...document.querySelectorAll('.execution-activity-row')].map(n=>({id:n.getAttribute('data-thread-id'),root:n.getAttribute('data-root-id'),node:id(n),text:n.textContent,aria:n.getAttribute('aria-label'),status:n.querySelector('[data-status]')?.getAttribute('data-status')})),badge:document.querySelector('.message-work-status')?.textContent??null,badgeStatus:document.querySelector('.message-work-status')?.getAttribute('data-status')??null,count:document.querySelector('.execution-scope-count')?.textContent??null,quiet:document.querySelector('.execution-quiet')?.textContent??null,summary:document.querySelector('.execution-origin .execution-activity-summary')?.textContent??null,stopDisabled:document.querySelector('.execution-stop-thread')?.disabled??null,focus:document.activeElement?.id??'',selectedScope:factsScope()};}
let currentScope;function factsScope(){return currentScope;}
async function settle(){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
Reflect.set(window,'threadFixture',{snapshot,async set(value){currentScope=value.scope??currentScope;flushSync(()=>api(value));await settle();return snapshot();},async unmount(){root.unmount();await settle();}});
`;

test(
  "actual complete Conversation and ExecutionSidebar consume thread collections through SSR and mounted identity/quality/actions",
  { timeout: 90_000 },
  async (context) => {
    const cache = mkdtempSync(join(tmpdir(), "morphz-thread-collection-vite-"));
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "isolated-thread-collection",
          resolveId(id) {
            if (id === "/__thread.tsx") return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__thread.tsx")
              return transformWithOxc(browserSource, "thread.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__thread") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__thread.tsx"></script></body></html>',
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
    const conversation = await server.ssrLoadModule("/src/Conversation.tsx"),
      sidebar = await server.ssrLoadModule("/src/ExecutionSidebar.tsx");
    function client(state: Workspace, rt: ConversationRuntime, online = true) {
      return {
        online,
        boot: {
          workspace: state,
          runtime: rt,
          actantId: "local-human",
          outputs: [],
          scriptOutputs: [],
          localSavedInputIds: [],
          localInputSubmissions: {},
          capabilities: { teamAuthentication: true },
        },
        contentCatalog: [],
        contentVersionTitle: () => "原对象",
      };
    }
    await context.test(
      "actual SSR input card uses identity and status priority; offline card cannot fabricate a background badge",
      () => {
        const state = initialWorkspace(stamp);
        state.inputs.push(input());
        for (const [threads, online, kind, label] of [
          [
            [thread({ phase: "future" }), thread({ controlState: "paused" })],
            true,
            "unknown",
            "状态待核对",
          ],
          [[thread({ phase: "waiting" }), thread()], true, "running", "执行中"],
          [[thread()], false, null, null],
        ] as const) {
          const rt = runtime([...threads]);
          const html = renderToStaticMarkup(
            createElement(conversation.Conversation, {
              inputs: state.inputs,
              state,
              runtime: rt,
              messages: [],
              streamConnected: false,
              seenReplies: {},
              onRead: () => {},
              conversationId: "first-project",
              onRetry: async () => {},
              client: client(state, rt, online),
              onOpen: () => {},
              positions: new Map(),
              revealInputId: null,
              onInspect: () => {},
            }),
          );
          assert.equal(
            html.includes('data-background-execution="true"'),
            online,
          );
          if (kind) {
            assert.ok(
              html.includes(
                `class="message-execution-link message-work-status" data-status="${kind}"`,
              ),
            );
            assert.ok(html.includes(`>${label}</span>`));
          } else assert.ok(!html.includes("message-work-status"));
        }
        const reply = liveMessageSchema.parse({
          id: "reply-only",
          projectId: scope.projectId,
          conversationId: scope.conversationId,
          artifactId: null,
          inputId: null,
          rootId: null,
          createdAt: stamp,
          text: "没有对应输入的真实回复",
          kind: "reply",
        });
        const replyState = initialWorkspace(stamp),
          replyRuntime = runtime();
        const replyClient = client(replyState, replyRuntime);
        Object.defineProperty(replyClient, "online", {
          get() {
            throw new Error(
              "reply-only consumer must not read input-only online port",
            );
          },
        });
        const replyHTML = renderToStaticMarkup(
          createElement(conversation.Conversation, {
            inputs: [],
            state: replyState,
            runtime: replyRuntime,
            messages: [reply],
            streamConnected: false,
            seenReplies: {},
            onRead: () => {},
            conversationId: scope.conversationId,
            onRetry: async () => {},
            client: replyClient,
            onOpen: () => {},
            positions: new Map(),
            revealInputId: null,
            onInspect: () => {},
          }),
        );
        assert.ok(replyHTML.includes('data-message-id="reply-only"'));
        assert.ok(replyHTML.includes("没有对应输入的真实回复"));
        assert.ok(!replyHTML.includes("message-work-status"));
        assert.ok(!replyHTML.includes("data-background-execution"));
      },
    );
    await context.test(
      "actual SSR overview counts roots, preserves child discoverability and distinguishes bounded/unknown idle",
      () => {
        const state = initialWorkspace(stamp);
        for (const [threads, truncated, available, expected] of [
          [
            [
              thread({ id: "parent", lifecycle: "completed" }),
              thread({ id: "child", parentThreadId: "parent" }),
            ],
            false,
            true,
            "1 项进行中",
          ],
          [[], true, true, "工作状态待核对"],
          [[], false, false, "工作状态待核对"],
          [[], false, true, "0 项进行中"],
        ] as const) {
          const rt = runtime([...threads], {
              activity: { threads: [...threads], available, truncated },
            }),
            html = renderToStaticMarkup(
              createElement(sidebar.ExecutionSidebar, {
                client: client(state, rt),
                scope,
                layout: { mode: "docked", width: 340, maxWidth: 520 },
                onResize: () => {},
                onClose: () => {},
                onSelect: () => {},
                onOpen: () => {},
              }),
            );
          assert.ok(
            html.includes(
              `<small class="execution-scope-count">${expected}</small>`,
            ),
          );
          if (threads.length) {
            assert.ok(html.includes('data-thread-id="parent"'));
            assert.ok(!html.includes('data-thread-id="child"'));
            assert.ok(html.includes("子任务执行中"));
          } else
            assert.equal(
              html.includes("当前没有正在处理的工作"),
              available && !truncated,
            );
        }
      },
    );
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "real consumer mount requires the test entry's existing browser capability",
    );
    const browser = await chromium.launch({
      executablePath: executable,
      headless: true,
    });
    context.after(() => browser.close());
    const page = await browser.newPage(),
      errors: string[] = [],
      business: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/**", (route) => {
      business.push(route.request().url());
      return route.abort();
    });
    await page.goto(`http://127.0.0.1:${address.port}/__thread`);
    await page.waitForFunction(() => Reflect.has(window, "threadFixture"));
    const snapshot = () =>
      page.evaluate(() =>
        Reflect.get(window, "threadFixture").snapshot(),
      ) as Promise<{
        events: unknown[][];
        reads: unknown[][];
        cards: { id: string; node: number; background: boolean }[];
        rows: {
          id: string;
          node: number;
          text: string;
          aria: string;
          status: string | null;
        }[];
        badge: string | null;
        badgeStatus: string | null;
        count: string | null;
        quiet: string | null;
        summary: string | null;
        stopDisabled: boolean | null;
        focus: string;
      }>;
    const set = (value: Record<string, unknown>) =>
      page.evaluate(
        (value) => Reflect.get(window, "threadFixture").set(value),
        value,
      );
    const initial = await snapshot();
    assert.equal(initial.badgeStatus, "running");
    assert.equal(initial.count, "1 项进行中");
    assert.deepEqual(
      initial.rows.map((row) => row.id),
      ["parent"],
    );
    assert.ok(initial.rows[0]!.aria.includes("子任务执行中"));
    await page.locator(".message-work-status").click();
    assert.deepEqual((await snapshot()).events.at(-1), [
      "inspect",
      "input-one",
    ]);
    await page.getByRole("button", { name: "全部工作", exact: true }).click();
    assert.deepEqual(
      (await snapshot()).rows.map((row) => row.id),
      ["named", "parent"],
    );
    assert.equal((await snapshot()).count, "2 项进行中");
    await page.getByRole("button", { name: "当前工作", exact: true }).click();
    await page.locator("#outside").focus();
    await set({
      threads: [
        thread({ id: "parent", lifecycle: "completed", summary: "父工作成果" }),
        thread({
          id: "child",
          parentThreadId: "parent",
          controlState: "paused",
        }),
        thread({
          id: "named",
          conversationId: "named-session",
          inputId: "named-input",
        }),
      ],
    });
    const paused = await snapshot();
    assert.equal(paused.badgeStatus, "paused");
    assert.equal(paused.rows[0]!.node, initial.rows[0]!.node);
    assert.equal(paused.cards[0]!.node, initial.cards[0]!.node);
    assert.equal(paused.focus, "outside");
    await set({ connected: false });
    const offline = await snapshot();
    assert.equal(offline.badge, null);
    assert.equal(offline.count, "工作状态待核对");
    assert.ok(offline.rows[0]!.aria.includes("状态待核对"));
    assert.equal(offline.rows[0]!.node, initial.rows[0]!.node);
    await set({ connected: true, threads: [], truncated: true });
    assert.equal((await snapshot()).quiet, "尚不能确认是否有工作进行中");
    assert.equal((await snapshot()).count, "工作状态待核对");
    await set({ truncated: false });
    assert.equal((await snapshot()).quiet, "当前没有正在处理的工作");
    const continuation = {
      mode: "supplement" as const,
      inputId: "input-one",
      threadId: "thread-one",
      generation: 3,
    };
    await set({ threads: [thread({ summary: "当前进度", continuation })] });
    await page.locator(".execution-activity-row").focus();
    await page.keyboard.press("Enter");
    const selected = await snapshot();
    assert.deepEqual(
      selected.events.find((event) => event[0] === "select"),
      [
        "select",
        {
          ...scope,
          artifactId: "artifact-one",
          inputId: "input-one",
          threadId: "thread-one",
        },
      ],
    );
    await page.locator(".execution-supplement").click();
    assert.deepEqual((await snapshot()).events.at(-1), [
      "supplement",
      continuation,
    ]);
    await page.getByRole("button", { name: "停止此分支", exact: true }).click();
    assert.deepEqual((await snapshot()).events.at(-1), [
      "control",
      {
        scope: {
          ...scope,
          artifactId: "artifact-one",
          inputId: "input-one",
          threadId: "thread-one",
        },
        action: { type: "cancel-thread", threadId: "thread-one", revision: 1 },
      },
    ]);
    assert.equal((await snapshot()).stopDisabled, true);
    assert.equal((await snapshot()).summary, "当前进度");
    await set({ threads: [], available: false });
    assert.equal((await snapshot()).summary, null);
    assert.ok((await snapshot()).reads.some((read) => read[0] === "snapshot"));
    assert.ok((await snapshot()).reads.some((read) => read[0] === "subscribe"));
    await page.evaluate(() => Reflect.get(window, "threadFixture").unmount());
    assert.deepEqual(errors, []);
    assert.deepEqual(business, []);
  },
);
