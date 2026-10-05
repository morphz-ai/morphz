import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SetStateAction } from "react";
import {
  createExchangeSubmissionCommands,
  type ExchangeSubmissionCommandOptions,
} from "../apps/web/src/host/exchange-submission-commands.js";
import { RequestError } from "../apps/web/src/application-transport.js";
import {
  initialWorkspace,
  type Receipt,
  type RecordedInput,
} from "../packages/core/src/model.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { Boot } from "../apps/web/src/client.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import { parseCognitiveAppApplicationTarget } from "../packages/core/src/cognitive-app-application-target.js";
import {
  createFixedSubmissionCommands,
  type FixedSubmissionBindings,
} from "./fixtures/exchange-submission-9122ad28.js";
import {
  expandSubmissionConsumption,
  fixedSubmissionDeclarations,
  parseSubmission,
  submissionSyntax,
  submissionOwnerText,
  verifySubmissionCommands,
  verifyRawSubmissionConsumption,
} from "./fixtures/exchange-submission-contract.js";

// Actual command + existing protocol with controlled typed ports. These are not
// HTTP, React scheduling, source authorization or native-window evidence.
const empty: InputDraft = { body: "", selection: "", revision: null };
const target = {
  mode: "supplement" as const,
  inputId: "original",
  threadId: "thread",
  generation: 4,
};
const original: RecordedInput = {
  id: "original",
  projectId: "project",
  conversationId: "conversation",
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "原请求",
  author: { principalId: "human", actantId: "human-actant" },
  targetActantId: "agent",
  status: "recorded",
  createdAt: "2026-10-04T00:00:00.000Z",
};
const receipt: Receipt = {
  commandId: "command",
  entityId: "accepted",
  workspaceRevision: 7,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function value<T>(action: SetStateAction<T>, previous: T): T {
  return typeof action === "function"
    ? (action as (previous: T) => T)(previous)
    : action;
}
function harness(
  lane: "fixed" | "owner",
  setup: Partial<ExchangeSubmissionCommandOptions["render"]> = {},
) {
  const events: unknown[][] = [],
    flush = deferred<void>(),
    execution = deferred<Receipt>(),
    started = deferred<void>();
  const workspace = initialWorkspace("2026-10-04T00:00:00.000Z");
  workspace.inputs = [structuredClone(original)];
  const boot: Boot = {
    centerId: "11111111-1111-4111-8111-111111111111",
    csrfToken: "csrf",
    principalId: "human",
    actantId: "human-actant",
    workspace,
    scriptLibrary: [],
    outputs: [],
    scriptOutputs: [],
    taskRuns: {},
    activityByProject: {},
    localSavedInputIds: [],
    localInputSubmissions: {},
    capabilities: {
      runtime: true,
      teamAuthentication: false,
      conversationOnFirstInput: true,
      directedInput: true,
      localFiles: false,
      agentDirectories: false,
      modelSettings: false,
      taskCompletion: false,
      browserBookmarks: false,
    },
    runtime: { ...disconnectedRuntime, configured: true },
  };
  const render: ExchangeSubmissionCommandOptions["render"] = {
    project: workspace.projects[0],
    selectedConversation: undefined,
    selectedDraft: undefined,
    draft: { ...empty, body: "正文" },
    sending: false,
    uploadingDrafts: {},
    contextKey: "conversation:object",
    conversationId: "conversation",
    workspace,
    emptyDraft: empty,
    artifact: undefined,
    activeInstance: undefined,
    browserPage: null,
    readingExpected: false,
    currentReading: null,
    canAuthorizeDirectories: false,
    directoryScope: "directory",
    directoryState: { scope: "directory", ready: true, grants: [] },
    rightInspector: { mode: "docked" },
    ...setup,
  };
  const feedback = {
    sendPending: { current: false },
    currentContext: { current: render.contextKey },
    setSending: (update: SetStateAction<boolean>) => {
      sending = value(update, sending);
      events.push(["sending", sending]);
    },
    setInputErrors: (update: SetStateAction<Record<string, string>>) => {
      errors = value(update, errors);
      events.push(["errors", errors]);
    },
    setRevealedInputs: (update: SetStateAction<Record<string, string>>) => {
      revealed = value(update, revealed);
      events.push(["revealed", revealed]);
    },
    setAnnotationRefresh: (update: SetStateAction<number>) => {
      annotation = value(update, annotation);
      events.push(["annotation", annotation]);
    },
  };
  let sending = render.sending,
    errors: Record<string, string> = {},
    revealed: Record<string, string> = {},
    annotation = 0;
  let stored = render.draft;
  let stagedCallback: ((inputId: string) => void) | undefined;
  const behavior = {
    replaceError: undefined as Error | undefined,
    updateError: undefined as Error | undefined,
    interruptError: undefined as Error | undefined,
    profileError: undefined as Error | undefined,
  };
  const client: ExchangeSubmissionCommandOptions["client"] = {
    boot,
    execute: (operation, dispatch, instance, command, onStaged) => {
      events.push(["execute", operation, dispatch, instance, command]);
      stagedCallback = onStaged;
      started.resolve();
      return execution.promise;
    },
  };
  const profile = {
    flush: () => {
      events.push(["flush"]);
      return flush.promise;
    },
    assertCurrentScope: () => {
      events.push(["profile-scope"]);
      if (behavior.profileError) throw behavior.profileError;
    },
  };
  const dictationControls = {
    current: {
      interrupt: () => {
        events.push(["interrupt"]);
        if (behavior.interruptError) throw behavior.interruptError;
      },
    },
  };
  const drafts = {
    replace: (key: string, next: InputDraft) => {
      events.push(["replace", key, next]);
      if (behavior.replaceError) throw behavior.replaceError;
      stored = next;
    },
    update: (key: string, update: (draft: InputDraft) => InputDraft) => {
      if (behavior.updateError) throw behavior.updateError;
      stored = update(stored);
      events.push(["update", key, stored]);
    },
  };
  let mobile = true;
  const exchange = {
    setMobileCollaboration: (update: SetStateAction<boolean>) => {
      mobile = value(update, mobile);
      events.push(["mobile", mobile]);
    },
    showSentInput: (key: string) => {
      events.push(["show-sent", key]);
    },
    requestSentInputFocus: (key: string) => {
      events.push(["sent-focus", key]);
    },
    showInput: () => {
      events.push(["show-input"]);
    },
  };
  const inspector = {
    openCollaboration: () => {
      events.push(["collaboration"]);
    },
    closeInspector: () => {
      events.push(["close-inspector"]);
    },
  };
  const onNotice = (message: string) => {
    events.push(["notice", message]);
  };
  const frames: FrameRequestCallback[] = [];
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    events.push(["schedule-focus"]);
    frames.push(callback);
    return frames.length;
  };
  const input = {
    current: {
      focus: (options: { preventScroll: true }) => {
        events.push(["focus", options]);
      },
    },
  };
  const options: ExchangeSubmissionCommandOptions = {
    render,
    client,
    profile,
    feedback,
    dictationControls,
    drafts,
    exchange,
    inspector,
    onNotice,
    focusAfterSupplement: () =>
      requestAnimationFrame(() =>
        input.current?.focus({ preventScroll: true }),
      ),
  };
  const fixed: FixedSubmissionBindings = {
    ...render,
    state: render.workspace,
    client,
    profile,
    ...feedback,
    dictationControls,
    setDraft: drafts.replace,
    updateDraft: drafts.update,
    ...exchange,
    ...inspector,
    setNotice: onNotice,
    requestAnimationFrame,
    input,
  };
  const commands =
    lane === "owner"
      ? createExchangeSubmissionCommands(options)
      : createFixedSubmissionCommands(fixed);
  return {
    commands,
    render,
    client,
    events,
    feedback,
    flush,
    execution,
    started,
    behavior,
    stored: () => stored,
    replaceStored: (next: InputDraft) => {
      stored = next;
    },
    state: () => ({
      sending,
      errors,
      revealed,
      annotation,
      pending: feedback.sendPending.current,
    }),
    stage: (id: string) => {
      assert.ok(stagedCallback);
      stagedCallback(id);
    },
    frame: () => frames.shift()?.(0),
  };
}
async function parity(
  action: (h: ReturnType<typeof harness>) => Promise<void> | void,
  setup: Partial<ExchangeSubmissionCommandOptions["render"]> = {},
) {
  const old = harness("fixed", setup),
    current = harness("owner", setup);
  await action(old);
  await action(current);
  assert.deepEqual(current.events, old.events);
  assert.deepEqual(current.state(), old.state());
  assert.deepEqual(current.stored(), old.stored());
  return current;
}
test("fixed Git9122 two complete algorithms and actual inert owner match", () => {
  assert.equal(Object.keys(fixedSubmissionDeclarations()).length, 2);
  verifySubmissionCommands();
});
test("actual App borrowed constructor retains raw-current ports and fixed Git9122 algorithms", () => {
  verifyRawSubmissionConsumption(
    readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8"),
  );
});
test("construction performs no Boot/ref/DOM/profile/port read or action", () => {
  const h = harness("owner"),
    events = h.events;
  assert.equal(events.length, 0);
  function poison<T extends object>(target: T): T {
    return new Proxy(target, {
      get() {
        throw new Error("eager read");
      },
    });
  }
  const options: ExchangeSubmissionCommandOptions = {
    render: h.render,
    client: poison(h.client),
    profile: poison({ flush: async () => {}, assertCurrentScope() {} }),
    feedback: {
      sendPending: poison(h.feedback.sendPending),
      currentContext: poison(h.feedback.currentContext),
      setSending() {},
      setInputErrors() {},
      setRevealedInputs() {},
      setAnnotationRefresh() {},
    },
    dictationControls: poison({ current: null }),
    drafts: { replace() {}, update() {} },
    exchange: {
      setMobileCollaboration() {},
      showSentInput() {},
      requestSentInputFocus() {},
      showInput() {},
    },
    inspector: { openCollaboration() {}, closeInspector() {} },
    onNotice() {},
    focusAfterSupplement() {},
  };
  const result = createExchangeSubmissionCommands(options);
  assert.deepEqual(Object.keys(result), ["send", "supplement"]);
});
test("all render admission guards preserve no-op behavior", async () => {
  const cases: Partial<ExchangeSubmissionCommandOptions["render"]>[] = [
    { project: undefined },
    { sending: true },
    { draft: { ...empty } },
    { uploadingDrafts: { "conversation:object": true } },
    {
      selectedConversation: {
        id: "archived",
        projectId: "project",
        title: "旧",
        revision: 1,
        createdAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T00:00:00.000Z",
        archivedAt: "2026-10-04T00:00:00.000Z",
      },
    },
  ];
  for (const setup of cases)
    await parity(async (h) => {
      await h.commands.send();
      assert.equal(h.events.length, 0);
    }, setup);
  await parity(async (h) => {
    h.feedback.sendPending.current = true;
    await h.commands.send();
    assert.equal(h.events.length, 0);
  });
  await parity(
    async (h) => {
      h.client.boot!.localSavedInputIds.push("first-input");
      await h.commands.send();
      assert.equal(h.events.length, 0);
    },
    {
      selectedDraft: {
        id: "named",
        projectId: "project",
        title: "新会话",
        inputId: "first-input",
      },
    },
  );
});
test("original root preparation, captured client and direct Promise continuation ordering", async () => {
  await parity(async (h) => {
    const pending = h.commands.send().then(() => {
      h.events.push(["caller"]);
    });
    assert.deepEqual(
      h.events.map((e) => e[0]),
      ["interrupt", "sending", "errors", "flush"],
    );
    assert.equal(h.feedback.sendPending.current, true);
    h.render.draft = { ...empty, body: "替换render字段不改变捕获" };
    h.flush.resolve();
    await h.started.promise;
    assert.equal(
      (h.events.find((e) => e[0] === "execute")![1] as { body: string }).body,
      "正文",
    );
    h.execution.resolve(receipt);
    await pending;
    assert.deepEqual(
      h.events.slice(-5).map((e) => e[0]),
      ["update", "mobile", "show-sent", "sending", "caller"],
    );
  });
});
test("staging consumes current draft once and late rejection cannot erase/unlock the next draft", async () => {
  await parity(async (h) => {
    const pending = h.commands.send();
    h.flush.resolve();
    await h.started.promise;
    h.stage("staged-input");
    assert.equal(h.state().sending, false);
    assert.equal(h.feedback.sendPending.current, false);
    const next = { ...empty, body: "下一条" };
    h.replaceStored(next);
    h.feedback.sendPending.current = true;
    const before = h.events.length;
    h.execution.reject(new Error("旧交付失败"));
    await pending;
    assert.equal(h.events.length, before);
    assert.equal(h.stored(), next);
    assert.equal(h.feedback.sendPending.current, true);
  });
});
test("staged success preserves new contents and originating revealed receipt despite surface change", async () => {
  await parity(async (h) => {
    const pending = h.commands.send();
    h.flush.resolve();
    await h.started.promise;
    h.feedback.currentContext.current = "another";
    h.stage("staged");
    const next = { ...empty, body: "新范围草稿" };
    h.replaceStored(next);
    h.execution.resolve(receipt);
    await pending;
    assert.equal(h.stored(), next);
    assert.deepEqual(h.state().revealed, { conversation: "staged" });
    assert.equal(
      h.events.some((e) => e[0] === "show-sent"),
      false,
    );
  });
});

test("UNIT real command stage retains choice A, and its late receipt never overwrites newer B", async () => {
  const application = (connectionId: string) =>
    parseCognitiveAppApplicationTarget({
      connectionId,
      authority: {
        appId: "author.notes",
        version: "1.0.0",
        definitionHash: "a".repeat(64),
        instanceId: "instance-one",
        serviceId: "service-one",
        dataAuthorityId: "data-one",
      },
    });
  const h = harness("owner", {
    draft: {
      ...empty,
      body: "send A",
      cognitiveApplication: application("connection-A"),
    },
  });
  const pending = h.commands.send();
  h.flush.resolve();
  await h.started.promise;
  h.stage("accepted-A");
  assert.deepEqual(
    h.stored().cognitiveApplication,
    application("connection-A"),
  );
  h.replaceStored({
    ...empty,
    body: "new B bytes",
    cognitiveApplication: application("connection-B"),
  });
  h.execution.resolve(receipt);
  await pending;
  assert.equal(h.stored().body, "new B bytes");
  assert.deepEqual(
    h.stored().cognitiveApplication,
    application("connection-B"),
  );
  assert.deepEqual(
    (
      h.events.find((event) => event[0] === "execute")![1] as {
        cognitiveApplication: unknown;
      }
    ).cognitiveApplication,
    application("connection-A"),
  );
});
test("scope change during profile flush rejects without execute and retains original draft", async () => {
  await parity(async (h) => {
    const old = h.stored(),
      pending = h.commands.send();
    h.feedback.currentContext.current = "other";
    h.flush.resolve();
    await pending;
    assert.equal(
      h.events.some((e) => e[0] === "execute"),
      false,
    );
    assert.equal(h.stored(), old);
    assert.equal(
      h.state().errors["conversation:object"],
      "工作范围已切换，草稿已保留，请回到原处发送。",
    );
  });
});
test("follow-up normalizes before lock while preserving shallow references and first conversation", async () => {
  const attachment = {
    assetId: "a".repeat(64),
    name: "附件",
    mime: "text/plain" as const,
  };
  const setup = {
    draft: {
      ...empty,
      body: "正文",
      attachments: [attachment],
      continuation: { ...target, mode: "follow-up" as const },
      continuationLabel: "旧",
      continuationFailure: "unknown" as const,
    },
    selectedDraft: {
      id: "named",
      projectId: "project",
      title: "命名",
      inputId: "first",
    },
  };
  await parity(async (h) => {
    const pending = h.commands.send();
    const normalized = h.stored();
    assert.equal(h.events[1]![0], "replace");
    assert.equal(normalized.attachments, h.render.draft.attachments);
    assert.equal(normalized.continuation, undefined);
    h.flush.resolve();
    await h.started.promise;
    assert.deepEqual(
      (
        h.events.find((e) => e[0] === "execute")![1] as {
          newConversation: unknown;
        }
      ).newConversation,
      { title: "命名" },
    );
    h.execution.resolve(receipt);
    await pending;
  }, setup);
  await parity(async (h) => {
    h.behavior.replaceError = new Error("写入失败");
    await assert.rejects(h.commands.send(), /写入失败/);
    assert.equal(h.feedback.sendPending.current, false);
  }, setup);
});
test("annotation feedback and task-result focus exceptions retain ordering", async () => {
  await parity(
    async (h) => {
      const pending = h.commands.send();
      await h.started.promise;
      assert.equal(
        h.events.some((e) => e[0] === "flush"),
        false,
      );
      h.execution.resolve(receipt);
      await pending;
      assert.deepEqual(
        h.events.slice(-5).map((e) => e[0]),
        ["annotation", "update", "collaboration", "sent-focus", "sending"],
      );
    },
    {
      artifact: { id: "object", revision: 4 },
      draft: {
        ...empty,
        body: "批注",
        annotation: true,
        selection: "原文",
        revision: 4,
      },
    },
  );
  await parity(
    async (h) => {
      const pending = h.commands.send();
      await h.started.promise;
      h.execution.resolve(receipt);
      await pending;
      assert.equal(
        h.events.some((e) => e[0] === "show-sent"),
        false,
      );
    },
    {
      artifact: { id: "task", revision: 3 },
      draft: {
        ...empty,
        body: "结果",
        taskResult: { taskId: "task", revision: 3 },
      },
    },
  );
});
test("continuation failures classify exact RequestError and retain unknown retry bytes", async () => {
  const retry = {
    commandId: "fixed-supplement",
    operation: {
      type: "record-input" as const,
      projectId: "project",
      conversationId: "conversation",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "补充",
      targetActantId: "agent",
      continuation: target,
    },
  };
  for (const [error, reason] of [
    [new RequestError(409, "结束", "work_closed"), "closed"],
    [new RequestError(403, "变化"), "changed"],
    [new RequestError(408, "超时"), "unknown"],
    [new RequestError(503, "断线"), "unknown"],
    ["非Error", "unknown"],
  ] as const)
    await parity(
      async (h) => {
        const pending = h.commands.send(true);
        await h.started.promise;
        assert.equal(
          h.events.some((e) => e[0] === "flush"),
          false,
        );
        h.execution.reject(error);
        await pending;
        assert.equal(h.stored().continuationFailure, reason);
        assert.equal(
          h.stored().pendingSupplement,
          reason === "unknown" ? retry : undefined,
        );
        assert.equal(
          h.state().errors["conversation:object"],
          error instanceof Error ? error.message : "保存失败，草稿已保留。",
        );
      },
      {
        draft: {
          ...empty,
          body: "补充",
          continuation: target,
          pendingSupplement: retry,
        },
      },
    );
});
test("supplement uses exact captured author, ordered feedback and deferred original focus", async () => {
  await parity(
    (h) => {
      h.commands.supplement(target);
      assert.equal(h.stored().continuation, target);
      assert.deepEqual(
        h.events.map((e) => e[0]),
        [
          "interrupt",
          "replace",
          "errors",
          "close-inspector",
          "show-input",
          "schedule-focus",
        ],
      );
      assert.equal(h.stored().continuationLabel, "原请求");
      h.frame();
      assert.deepEqual(h.events.at(-1), ["focus", { preventScroll: true }]);
    },
    { rightInspector: { mode: "overlay" } },
  );
  for (const denied of ["principal", "actant", "missing"] as const)
    await parity((h) => {
      if (denied === "principal") h.client.boot!.principalId = "other";
      else if (denied === "actant") h.client.boot!.actantId = "other";
      else h.render.workspace!.inputs.length = 0;
      h.commands.supplement(target);
      assert.equal(h.events.length, 0);
    });
});
test("supplement busy guards and partial write errors retain exact notice/no cleanup", async () => {
  await parity(
    (h) => {
      h.commands.supplement(target);
      assert.deepEqual(h.events, [
        ["notice", "请先核对当前补充的送达结果，再切换目标。"],
      ]);
    },
    { sending: true },
  );
  await parity((h) => {
    h.behavior.replaceError = new Error("replace");
    assert.throws(() => h.commands.supplement(target), /replace/);
    assert.deepEqual(
      h.events.map((e) => e[0]),
      ["interrupt", "replace"],
    );
  });
});
test("supplement pending receipt and captured execution title retain original label rules", async () => {
  const pendingSupplement = {
    commandId: "pending",
    operation: {
      type: "record-input" as const,
      projectId: "project",
      conversationId: "conversation",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "",
      targetActantId: "agent",
    },
  };
  await parity(
    (h) => {
      h.commands.supplement(target);
      assert.deepEqual(h.events, [
        ["notice", "请先核对当前补充的送达结果，再切换目标。"],
      ]);
    },
    { draft: { ...empty, body: "新补充", pendingSupplement } },
  );
  for (const [kind, title, expected] of [
    ["execution", "支线", "文".repeat(60) + " · 支线"],
    ["evaluation", "支线", "文".repeat(90)],
    ["execution", "文".repeat(90), "文".repeat(90)],
  ] as const) {
    await parity((h) => {
      h.render.workspace!.inputs[0]!.body = "文".repeat(90);
      h.client.boot!.runtime.activity = {
        available: true,
        truncated: false,
        threads: [
          {
            id: target.threadId,
            kind,
            title,
            projectId: "project",
            conversationId: "conversation",
            inputId: "original",
            rootId: "root",
            sessionId: "session",
            phase: "running",
            lifecycle: "active",
            revision: 4,
            updatedAt: "2026-10-04T00:00:00.000Z",
          },
        ],
      };
      h.commands.supplement(target);
      assert.equal(h.stored().continuationLabel, expected);
    });
  }
});
test("finite gate rejects valid capture, public wrapper, protocol and actual consumer mutations", () => {
  const app = readFileSync(
    new URL("../apps/web/src/App.tsx", import.meta.url),
    "utf8",
  );
  function mutation(text: string, before: string, after: string) {
    assert.equal(text.split(before).length, 2);
    const changed = text.replace(before, after);
    parseSubmission(changed);
    return changed;
  }
  const constructor = app.slice(
    app.indexOf(
      "const { send, supplement } = createExchangeSubmissionCommands",
    ),
    app.indexOf("\n  const agentName"),
  );
  for (const [before, after, rule] of [
    [
      "workspace: state,",
      "workspace: { ...state! },",
      "exact captured submission ports",
    ],
    [
      "onNotice: setNotice,",
      "onNotice: () => {},",
      "exact captured submission ports",
    ],
    [
      "    client,",
      "    client: { ...client },",
      "exact captured submission ports",
    ],
    [
      "      currentContext,",
      "      currentContext: { current: currentContext.current },",
      "exact captured submission ports",
    ],
    [
      "preventScroll: true",
      "preventScroll: false",
      "exact captured submission ports",
    ],
    [
      "createExchangeSubmissionCommands({",
      "((options) => createExchangeSubmissionCommands(options))({",
      "direct send supplement aliases",
    ],
  ]) {
    const mutatedConstructor = mutation(constructor, before!, after!);
    const mutatedApp = mutation(app, constructor, mutatedConstructor);
    assert.throws(() => expandSubmissionConsumption(mutatedApp), {
      name: "AssertionError",
      message: new RegExp(rule!),
    });
  }
  const duplicate = constructor.replace(
    "{ send, supplement }",
    "{ send: otherSend, supplement: otherSupplement }",
  );
  const duplicateApp = mutation(
    app,
    constructor,
    constructor + "\n" + duplicate,
  );
  assert.throws(() => expandSubmissionConsumption(duplicateApp), {
    name: "AssertionError",
    message: /one real borrowed submission call/,
  });
  const fakeApp = mutation(
    app,
    constructor,
    "const createExchangeSubmissionCommands = () => ({});\n" + constructor,
  );
  assert.throws(() => expandSubmissionConsumption(fakeApp), {
    name: "AssertionError",
    message: /one real borrowed submission call/,
  });
  const without = mutation(app, constructor, "");
  const relocated = mutation(
    without,
    "async function importImage(",
    constructor + "\nasync function importImage(",
  );
  assert.throws(() => expandSubmissionConsumption(relocated), {
    name: "AssertionError",
    message: /late constructor after inspector aliases before agentName/,
  });
  for (const [before, after, rule] of [
    [
      "} = render;",
      "} = { ...render, workspace: { ...render.workspace! } };",
      "exact borrowed captures",
    ],
    [
      "return { send, supplement };",
      "return { send: async (...args) => send(...args), supplement };",
      "exact borrowed captures",
    ],
    [
      "if (staged) return;",
      "if (false) return;",
      "whole original submission algorithm",
    ],
    [
      "focusAfterSupplement();",
      "queueMicrotask(focusAfterSupplement);",
      "one deferred DOM focus port",
    ],
  ])
    assert.throws(
      () =>
        verifySubmissionCommands(
          mutation(submissionOwnerText, before!, after!),
        ),
      { name: "AssertionError", message: new RegExp(rule!) },
    );
  assert.deepEqual(
    submissionSyntax(parseSubmission("const a = 1;").source),
    submissionSyntax(parseSubmission("const  a=1;").source),
  );
});
