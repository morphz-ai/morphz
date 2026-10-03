import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  conversationRuntimeSchema,
  type ArtifactOutput,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import type {
  ConversationStream,
  LiveMessage,
} from "../packages/core/src/live-conversation.js";
import {
  initialWorkspace,
  type RecordedInput,
} from "../packages/core/src/model.js";
import type { ScriptOutput } from "../packages/core/src/script-delivery.js";
import type { WorkspaceClient } from "../apps/web/src/client.js";
import { isPendingResponse } from "../apps/web/src/conversation-presentation.js";
import { subjectLogoState } from "../apps/web/src/subject-sidebar-model.js";

// Node-only SSR checks text/ownership, not CSS or browser geometry. Import the
// actual component with inert styles, then remove the local import hook.
const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css")
      ? { format: "module", source: "export {};", shortCircuit: true }
      : nextLoad(url, context);
  },
});
let Conversation: typeof import("../apps/web/src/Conversation.js").Conversation;
try {
  ({ Conversation } = await import("../apps/web/src/Conversation.js"));
} finally {
  styles.deregister();
}

type Delivery = ConversationRuntime["deliveries"][number];
type ResponseMessage = LiveMessage & {
  kind: ConversationRuntime["messages"][number]["kind"];
};
type Facts = Parameters<typeof isPendingResponse>[0];
const stamp = "2026-10-03T00:00:00Z";

// The two pre-extraction predicates remain independent test oracles. The
// shared primitive intentionally does not inherit the Logo's cancel policy.
const previousMessagePending = (facts: Facts) =>
  !(
    !facts.configured ||
    !facts.delivery ||
    facts.delivery.supplement ||
    facts.delivery.error ||
    !["queued", "sending", "running"].includes(facts.delivery.state) ||
    facts.answered ||
    facts.approvalPending
  );
const previousLogoPending = (facts: Facts, delivery: Delivery | undefined) =>
  !!(
    facts.configured &&
    delivery &&
    !delivery.error &&
    !delivery.supplement &&
    !delivery.cancelRequested &&
    ["queued", "sending", "running"].includes(delivery.state) &&
    !facts.answered &&
    !facts.approvalPending
  );
const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  inputId: "TEST-input-a",
  state: "running",
  error: null,
  retryable: false,
  ...overrides,
});

test("回应事实与两个原谓词组合等价；取消策略仍只由Logo排除", () => {
  const deliveries: Array<Delivery | undefined> = [undefined];
  for (const state of [
    "queued",
    "sending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ] as const)
    for (const error of [null, "", "TEST 失败"])
      for (const supplement of [
        undefined,
        "pending",
        "delivered",
        "rejected",
        "unknown",
      ] as const)
        for (const cancelRequested of [undefined, false, true])
          deliveries.push(
            Object.freeze(
              delivery({ state, error, supplement, cancelRequested }),
            ),
          );
  let comparisons = 0;
  for (const current of deliveries)
    for (const configured of [false, true])
      for (const answered of [false, true])
        for (const approvalPending of [false, true]) {
          const facts = Object.freeze({
            configured,
            delivery: current,
            answered,
            approvalPending,
          });
          const before = structuredClone(facts);
          assert.equal(isPendingResponse(facts), previousMessagePending(facts));
          assert.equal(
            !!current && !current.cancelRequested && isPendingResponse(facts),
            previousLogoPending(facts, current),
          );
          assert.deepEqual(facts, before);
          comparisons++;
        }
  assert.equal(comparisons, 2168);
});

test("未配置先短路、不读取投递；未知投递不伪造回应状态", () => {
  const current = delivery();
  Object.defineProperty(current, "state", {
    get() {
      assert.fail(
        "An unconfigured observation must not inspect delivery state",
      );
    },
  });
  assert.equal(
    isPendingResponse({
      configured: false,
      delivery: current,
      answered: false,
      approvalPending: false,
    }),
    false,
  );
  assert.equal(
    isPendingResponse({
      configured: true,
      delivery: delivery({ state: "future-state" as Delivery["state"] }),
      answered: false,
      approvalPending: false,
    }),
    false,
  );
});

function runtime(overrides: Partial<ConversationRuntime> = {}) {
  return conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "TEST-model",
    error: "",
    deliveries: [delivery()],
    messages: [],
    activity: { available: true, openWorkComplete: true, threads: [] },
    attention: { available: true, approvals: [] },
    ...overrides,
  });
}
function message(overrides: Partial<ResponseMessage> = {}): ResponseMessage {
  return {
    id: "TEST-reply",
    inputId: "TEST-input-a",
    projectId: "first-project",
    conversationId: "first-project",
    artifactId: null,
    rootId: "TEST-root",
    createdAt: stamp,
    kind: "reply",
    text: "TEST 实际首字",
    ...overrides,
  };
}
function approval(inputId: string) {
  return {
    scope: { projectId: "first-project", artifactId: null, inputId },
    approval: {
      fingerprint: "a".repeat(64),
      requested_at: stamp,
      request: {
        approval_id: "TEST-approval",
        session_id: "TEST-session",
        context_id: "TEST-context",
        justification: "TEST 审批",
        action: {},
        requested: {},
      },
    },
  };
}
function output(inputId: string): ArtifactOutput {
  return {
    inputId,
    commandId: "TEST-output",
    artifactId: "TEST-artifact-a",
    projectId: "first-project",
    revision: 1,
    createdAt: stamp,
  };
}
function scriptOutput(inputId: string): ScriptOutput {
  return {
    inputId,
    commandId: "TEST-script-output",
    projectId: "first-project",
    productionId: "TEST-production",
    productionTitle: "TEST 剧本",
    title: "TEST 剧本",
    kind: "production",
    createdAt: stamp,
  };
}

function render(
  observation: ConversationRuntime,
  {
    messages = [],
    outputs = [],
    scriptOutputs = [],
    online = true,
    focusedArtifactId,
  }: {
    messages?: LiveMessage[];
    outputs?: ArtifactOutput[];
    scriptOutputs?: ScriptOutput[];
    online?: boolean;
    focusedArtifactId?: string;
  } = {},
) {
  const state = initialWorkspace(stamp);
  const inputs: RecordedInput[] = ["a", "b"].map((name) => ({
    id: `TEST-input-${name}`,
    projectId: "first-project",
    conversationId: "first-project",
    artifactId: `TEST-artifact-${name}`,
    artifactRevision: null,
    selection: "",
    body: `TEST 原输入 ${name}`,
    author: { principalId: "local-owner", actantId: "local-human" },
    targetActantId: "morphz-agent",
    status: "recorded",
    createdAt: stamp,
  }));
  state.inputs = inputs;
  const client = {
    online,
    contentCatalog: [],
    contentVersionTitle: () => undefined,
    approvalSubmitted: () => false,
    boot: {
      actantId: "local-human",
      outputs,
      scriptOutputs,
      localSavedInputIds: [],
      localInputSubmissions: {},
    },
  } as unknown as WorkspaceClient;
  const props: ComponentProps<typeof Conversation> = {
    state,
    inputs,
    runtime: observation,
    messages,
    streamConnected: true,
    seenReplies: {},
    positions: new Map(),
    conversationId: "first-project",
    revealInputId: null,
    client,
    focusedArtifactId,
    onRead: () => assert.fail("Presentation must not publish read receipts"),
    onRetry: async () => assert.fail("Presentation must not retry a delivery"),
    onOpen: () => assert.fail("Presentation must not navigate"),
  };
  const html = renderToStaticMarkup(createElement(Conversation, props));
  return {
    html,
    pendingIds: [...html.matchAll(/data-waiting-input-id="([^"]+)"/g)].map(
      (match) => match[1],
    ),
  };
}

test("真实消息投影保留等待/发送/断线/停止确认；Logo不把取消当处理", () => {
  for (const [state, label] of [
    ["queued", "等待处理…"],
    ["sending", "正在发送…"],
    ["running", "正在处理…"],
  ] as const) {
    const observation = runtime({ deliveries: [delivery({ state })] });
    const result = render(observation);
    assert.deepEqual(result.pendingIds, ["TEST-input-a"]);
    assert.ok(result.html.includes(label));
    assert.equal(
      subjectLogoState(observation, true).state,
      state === "running" ? "processing" : "waiting",
    );
    const stopped = runtime({
      deliveries: [delivery({ state, cancelRequested: true })],
    });
    assert.ok(render(stopped).html.includes("已请求停止，等待确认"));
    assert.equal(subjectLogoState(stopped, true).state, "idle");
    assert.ok(
      render(stopped, { online: false }).html.includes("连接中断，等待恢复"),
    );
    assert.equal(subjectLogoState(stopped, false).state, "unknown");
  }
  for (const state of ["completed", "failed", "cancelled"] as const)
    assert.deepEqual(
      render(runtime({ deliveries: [delivery({ state })] })).pendingIds,
      [],
    );
  const disconnected = runtime({ connected: false });
  assert.ok(render(disconnected).html.includes("连接中断，等待恢复"));
  assert.equal(subjectLogoState(disconnected, true).state, "unknown");
  const unconfigured = runtime({ configured: false });
  assert.deepEqual(render(unconfigured).pendingIds, []);
  assert.equal(subjectLogoState(unconfigured, true).state, "idle");
});

test("消息与Logo各用原输入回应/审批/输出来源，不借其他input移除等待", () => {
  const observation = runtime();
  for (const kind of ["reply", "error"] as const) {
    const other = message({ inputId: "TEST-input-b", kind });
    assert.deepEqual(render(observation, { messages: [other] }).pendingIds, [
      "TEST-input-a",
    ]);
    assert.equal(
      subjectLogoState({ ...observation, messages: [other] }, true).state,
      "processing",
    );
    const own = message({ kind });
    assert.deepEqual(render(observation, { messages: [own] }).pendingIds, []);
    assert.equal(
      subjectLogoState({ ...observation, messages: [own] }, true).state,
      "idle",
    );
    const empty = message({ kind, text: " \n " });
    assert.deepEqual(render(observation, { messages: [empty] }).pendingIds, [
      "TEST-input-a",
    ]);
    assert.equal(
      subjectLogoState({ ...observation, messages: [empty] }, true).state,
      "processing",
    );
  }
  for (const inputId of ["TEST-input-a", "TEST-input-b"])
    for (const artifacts of [true, false]) {
      const rendered = render(
        observation,
        artifacts
          ? { outputs: [output(inputId)] }
          : { scriptOutputs: [scriptOutput(inputId)] },
      );
      assert.deepEqual(
        rendered.pendingIds,
        inputId === "TEST-input-a" ? [] : ["TEST-input-a"],
      );
      assert.equal(
        subjectLogoState(observation, true, undefined, [inputId]).state,
        inputId === "TEST-input-a" ? "idle" : "processing",
      );
    }
  for (const inputId of ["TEST-input-a", "TEST-input-b"])
    for (const available of [false, true]) {
      const approved = runtime({
        attention: { available, approvals: [approval(inputId)] },
      });
      assert.deepEqual(
        render(approved).pendingIds,
        inputId === "TEST-input-a" ? [] : ["TEST-input-a"],
      );
      assert.equal(
        subjectLogoState(approved, true).processing,
        inputId === "TEST-input-b",
      );
    }
});

test("历史/focus与stream可见性仍由调用方确定，补充与未来安排不是首字处理", () => {
  const observation = runtime({
    deliveries: [delivery(), delivery({ inputId: "TEST-input-b" })],
  });
  assert.deepEqual(render(observation).pendingIds, [
    "TEST-input-a",
    "TEST-input-b",
  ]);
  assert.deepEqual(
    render(observation, { focusedArtifactId: "TEST-artifact-b" }).pendingIds,
    ["TEST-input-b"],
  );
  const stream: ConversationStream = {
    connected: true,
    messages: [message()],
  };
  for (const connected of [true, false])
    assert.equal(
      subjectLogoState(runtime(), true, { ...stream, connected }).state,
      connected ? "idle" : "processing",
    );
  for (const supplement of [
    "pending",
    "delivered",
    "rejected",
    "unknown",
  ] as const) {
    const supplemented = runtime({ deliveries: [delivery({ supplement })] });
    assert.deepEqual(render(supplemented).pendingIds, []);
    assert.equal(subjectLogoState(supplemented, true).state, "idle");
  }
  const future = runtime({
    deliveries: [],
    activity: {
      available: true,
      truncated: false,
      openWorkComplete: true,
      threads: [
        {
          id: "TEST-future-thread",
          kind: "execution",
          projectId: "first-project",
          conversationId: "first-project",
          inputId: "TEST-input-a",
          rootId: "TEST-root",
          sessionId: "TEST-session",
          title: "TEST 将来的提醒",
          lifecycle: "open",
          phase: "waiting",
          revision: 1,
          updatedAt: stamp,
        },
      ],
    },
  });
  assert.deepEqual(render(future).pendingIds, []);
  assert.equal(subjectLogoState(future, true).state, "waiting");
  assert.equal(subjectLogoState(future, true).processing, false);
});

test("进度、未归属回应与工具不假装首字；实际流式工具活动仍由Logo单独识别", () => {
  for (const current of [
    message({ kind: "progress" }),
    message({ inputId: null }),
  ]) {
    assert.deepEqual(render(runtime(), { messages: [current] }).pendingIds, [
      "TEST-input-a",
    ]);
    assert.equal(
      subjectLogoState({ ...runtime(), messages: [current] }, true).state,
      "processing",
    );
  }
  const tool: LiveMessage = {
    ...message(),
    kind: "tool",
    text: "",
    tool: { name: "read", arguments: "{}", status: "generating" },
  };
  assert.deepEqual(render(runtime(), { messages: [tool] }).pendingIds, [
    "TEST-input-a",
  ]);
  for (const streaming of [true, false])
    assert.equal(
      subjectLogoState(runtime(), true, {
        connected: true,
        messages: [{ ...tool, streaming }],
      }).state,
      streaming ? "working" : "processing",
    );
});
