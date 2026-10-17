import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import {
  conversationRuntimeSchema,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import {
  initialWorkspace,
  type RecordedInput,
} from "../packages/core/src/model.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";
import { collapsedComposerState } from "../apps/web/src/features/exchange/collapsed-composer-state.js";

const styles = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "export {};", shortCircuit: true }
      : next(url, context);
  },
});
const { CollapsedComposerEntry } =
  await import("../apps/web/src/features/exchange/CollapsedComposerEntry.js").finally(
    () => styles.deregister(),
  );
const stamp = "2026-10-16T04:00:00Z",
  later = "2026-10-16T04:01:00Z";
const input = (id = "input-a"): RecordedInput => ({
  id,
  projectId: "first-project",
  conversationId: "first-project",
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "TEST 查询终端目录",
  author: { principalId: "human", actantId: "local-human" },
  targetActantId: "morphz-agent",
  status: "recorded",
  createdAt: stamp,
});
const message = (overrides: Partial<LiveMessage> = {}): LiveMessage => ({
  id: "message-a",
  inputId: "input-a",
  projectId: "first-project",
  conversationId: "first-project",
  artifactId: null,
  rootId: "root-a",
  createdAt: stamp,
  kind: "progress",
  text: "正在核对终端输出",
  ...overrides,
});
function facts() {
  return {
    runtime: conversationRuntimeSchema.parse({
      configured: true,
      connected: true,
      model: "TEST",
      error: "",
      deliveries: [],
      messages: [],
      activity: { available: true, openWorkComplete: true, threads: [] },
      attention: { available: true, approvals: [] },
    }),
    online: true,
    inputs: [input()],
    messages: [] as LiveMessage[],
    streamConnected: true,
    outputInputIds: [] as string[],
    unseenReply: false,
    workspace: initialWorkspace(stamp),
  };
}
function thread(
  overrides: Partial<
    NonNullable<ConversationRuntime["activity"]>["threads"][number]
  > = {},
) {
  return {
    id: "thread-a",
    kind: "execution",
    projectId: "first-project",
    conversationId: "first-project",
    inputId: "input-a",
    rootId: "root-a",
    contextId: "context-a",
    sessionId: "session-a",
    title: "TEST 检查终端",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: stamp,
    ...overrides,
  };
}
function delivery(
  state: ConversationRuntime["deliveries"][number]["state"] = "running",
) {
  return { inputId: "input-a", state, error: null, retryable: false };
}

test("collapsed entry stays idle without work and preserves existing unread notifications", () => {
  const f = facts();
  assert.equal(collapsedComposerState(f).kind, "idle");
  f.unseenReply = true;
  f.messages.push(message({ kind: "reply", text: "已核对实际输出" }));
  assert.equal(collapsedComposerState(f).kind, "unread");
  assert.equal(collapsedComposerState(f).detail, "已核对实际输出");
  f.messages[0]!.text = "已在 **TEST Terminal 1016** 完成 `MY_ENV` 检查。";
  assert.equal(
    collapsedComposerState(f).detail,
    "已在 TEST Terminal 1016 完成 MY_ENV 检查。",
  );
  f.runtime.configured = false;
  assert.equal(collapsedComposerState(f).kind, "unread");
});
test("acceptance is processing, queue/sending are static, and delivered content ends pending feedback", () => {
  const f = facts();
  for (const state of ["queued", "sending", "running"] as const) {
    f.runtime.deliveries = [delivery(state)];
    const shown = collapsedComposerState(f);
    assert.equal(shown.kind, state === "running" ? "processing" : "queued");
    assert.equal(shown.animated, state === "running");
  }
  f.outputInputIds.push("input-a");
  assert.equal(collapsedComposerState(f).kind, "idle");
  f.outputInputIds = [];
  f.messages.push(message({ kind: "reply", text: "已完成" }));
  assert.equal(collapsedComposerState(f).kind, "idle");
});
test("public progress stays visible while exact Runtime execution continues; parallel count uses real branches", () => {
  const f = facts();
  f.runtime.activity!.threads = Array.from({ length: 4 }, (_, index) =>
    thread({ id: `thread-${index}` }),
  );
  f.messages = [
    message({ text: "旧进展" }),
    message({
      id: "progress-latest",
      createdAt: later,
      text: "四路校验已开始，正在收集结果。\n其余正文不会塞入按钮。",
    }),
  ];
  const before = structuredClone(f);
  const shown = collapsedComposerState(f);
  assert.equal(shown.kind, "running");
  assert.equal(shown.label, "执行中 · 4 路并行");
  assert.equal(shown.detail, "四路校验已开始，正在收集结果。");
  assert.equal(shown.count, 1);
  assert.deepEqual(
    f,
    before,
    "projection never mutates source or read receipts",
  );
});
test("actual tool activity uses the shared presentation, never raw arguments or outputs", () => {
  const f = facts();
  f.runtime.deliveries = [delivery()];
  f.messages = [
    message({
      kind: "tool",
      text: "",
      streaming: true,
      tool: {
        name: "terminal",
        status: "running",
        arguments: JSON.stringify({
          action: "write",
          terminal_id: "opaque-private-id",
          text: "secret input must not be copied",
        }),
        result: "private result",
      },
    }),
  ];
  const shown = collapsedComposerState(f);
  assert.equal(shown.kind, "running");
  assert.equal(shown.detail, "向终端输入命令");
  assert.doesNotMatch(JSON.stringify(shown), /secret|private|opaque/);
  f.messages[0]!.tool!.status = "pending";
  assert.equal(collapsedComposerState(f).animated, false);
  f.messages.push(
    message({
      text: "正在同一终端检查真实输出，原环境保持不变。",
      createdAt: later,
    }),
  );
  assert.equal(
    collapsedComposerState(f).detail,
    "正在同一终端检查真实输出，原环境保持不变。",
  );
});
test("scoped current inputs exclude other conversations, supplements and merged old turns", () => {
  const f = facts();
  f.runtime.deliveries = [{ ...delivery(), inputId: "other-conversation" }];
  f.runtime.activity!.threads = [thread({ inputId: "other-conversation" })];
  f.messages = [
    message({ inputId: "other-conversation", kind: "reply", streaming: true }),
  ];
  assert.equal(collapsedComposerState(f).kind, "idle");
  f.runtime.activity!.threads = [];
  f.runtime.deliveries = [{ ...delivery(), supplement: "pending" }];
  assert.equal(collapsedComposerState(f).kind, "idle");
  f.runtime.deliveries = [
    {
      ...delivery(),
      state: "merged",
      handoff: {
        signalId: "signal",
        sourceThreadId: "old",
        destinationThreadId: "new",
        destinationRootId: "next",
        destinationGeneration: 1,
      },
    },
  ];
  f.messages = [message({ kind: "reply", streaming: true })];
  assert.equal(collapsedComposerState(f).kind, "idle");
});
test("stream tails are bounded Unicode excerpts and known terminal snapshots stop stale animation", () => {
  const f = facts();
  f.runtime.deliveries = [delivery()];
  f.messages = [
    message({
      kind: "reply",
      streaming: true,
      threadId: "thread-a",
      text: "旧前缀".repeat(1000) + "\n这是最新一行 😀",
    }),
  ];
  assert.equal(collapsedComposerState(f).detail, "这是最新一行 😀");
  f.runtime.activity!.threads = [
    thread({ lifecycle: "completed", updatedAt: later }),
  ];
  assert.equal(collapsedComposerState(f).kind, "idle");
  f.messages = [];
  assert.equal(
    collapsedComposerState(f).kind,
    "idle",
    "stale running delivery cannot override observed terminal Thread",
  );
});
test("waiting and paused use exact scheduler labels without busy animation; deferred schedules are not work", () => {
  const f = facts();
  const t = thread({ phase: "waiting", waitKinds: ["user_input"] });
  f.runtime.activity!.threads = [t];
  assert.equal(collapsedComposerState(f).label, "等待你回复");
  assert.equal(collapsedComposerState(f).animated, false);
  t.waitKinds = ["thread_group"];
  assert.equal(collapsedComposerState(f).label, "等待子任务结果");
  t.controlState = "paused";
  assert.equal(collapsedComposerState(f).kind, "paused");
  t.controlState = "active";
  f.runtime.activity!.schedulesAvailable = true;
  f.runtime.activity!.schedules = [
    {
      scheduleId: "schedule",
      threadId: t.id,
      sessionId: t.sessionId,
      contextId: t.contextId,
      rootId: t.rootId,
      inputId: t.inputId!,
      sourceTurnId: t.rootId,
      sourceRootId: t.rootId,
      projectId: t.projectId!,
      conversationId: t.conversationId!,
      status: "queued",
      revision: 1,
      notBefore: later,
      intervalSeconds: null,
      dependencyThreadIds: [],
      intent: "future",
      updatedAt: stamp,
    },
  ];
  assert.equal(collapsedComposerState(f).kind, "idle");
});
test("recovery distinguishes service retry from credential repair and a resumed recovery is not still waiting", () => {
  const f = facts();
  f.runtime.deliveries = [delivery()];
  for (const reason of [
    "service",
    "credentials",
    "configuration",
    "capacity",
    "unknown",
  ] as const) {
    f.messages = [
      message({
        providerRecovery: { phase: "waiting", reason, startedAt: stamp },
      }),
    ];
    const shown = collapsedComposerState(f);
    assert.equal(shown.kind, "waiting");
    assert.equal(shown.animated, reason === "service");
    assert.equal(shown.label.includes("自动重试"), reason === "service");
  }
  f.messages.push(
    message({
      id: "resumed",
      createdAt: later,
      providerRecovery: {
        phase: "resumed",
        reason: "unknown",
        startedAt: later,
      },
    }),
  );
  assert.equal(collapsedComposerState(f).kind, "processing");
});
test("approval, failed input, stop confirmation and offline remain static and do not fabricate retries", () => {
  const f = facts();
  f.runtime.deliveries = [{ ...delivery(), cancelRequested: true }];
  assert.equal(collapsedComposerState(f).label, "已请求停止，等待确认");
  assert.equal(collapsedComposerState(f).animated, false);
  f.runtime.deliveries = [
    { ...delivery("failed"), error: "DO NOT EXPOSE PRIVATE RAW ERROR" },
  ];
  assert.equal(collapsedComposerState(f).kind, "error");
  assert.doesNotMatch(JSON.stringify(collapsedComposerState(f)), /PRIVATE/);
  f.runtime.attention!.approvals = [
    {
      scope: {
        projectId: "first-project",
        artifactId: null,
        inputId: "input-a",
      },
      approval: {
        requested_at: stamp,
        fingerprint: "f".repeat(64),
        request: {
          approval_id: "approval",
          session_id: "session-a",
          context_id: "context-a",
          justification: "private",
          action: {},
          requested: {},
        },
      },
    },
  ];
  assert.equal(collapsedComposerState(f).kind, "approval");
  f.online = false;
  assert.equal(collapsedComposerState(f).kind, "offline");
  assert.equal(collapsedComposerState(f).animated, false);
});
test("concurrent requests are counted once each, even with several tools or streaming messages", () => {
  const f = facts();
  f.inputs.push(input("input-b"));
  f.runtime.deliveries = [delivery(), { ...delivery(), inputId: "input-b" }];
  f.runtime.activity!.threads = [thread()];
  f.messages = [
    message({ kind: "reply", streaming: true }),
    message({ id: "more", kind: "reply", streaming: true }),
  ];
  assert.equal(collapsedComposerState(f).count, 2);
});
test("real collapsed button keeps keyboard/expand action, escaped text, unread state and motion preference", () => {
  const state = {
    kind: "running",
    label: "执行中",
    detail: "<script>只是公开文本</script>",
    animated: true,
    count: 2,
  } as const;
  const html = renderToStaticMarkup(
    createElement(CollapsedComposerEntry, {
      agentName: "Morphz",
      shortcut: "⌘J",
      state,
      unseenReply: true,
      allowMotion: false,
      onOpen() {
        assert.fail("SSR must not open or execute");
      },
    }),
  );
  assert.match(html, /向 Morphz 输入/);
  assert.match(html, /有新回复/);
  assert.match(html, /新回复/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|data-animated|textarea|input type/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /⌘J/);
});
