import test from "node:test";
import assert from "node:assert/strict";
import {
  initialWorkspace,
  type Operation,
  type Receipt,
  type RecordedInput,
} from "../packages/core/src/model.js";
import { randomUUID } from "node:crypto";
import { textQuotesSchema } from "../packages/core/src/text-quotes.js";
import {
  createExchangeSubmissionCommands,
  type ExchangeSubmissionCommandOptions,
} from "../apps/web/src/host/exchange-submission-commands.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import {
  deriveWorkSurface,
  readWorkSurfaceDraft,
  type CognitiveWorkSurface,
} from "../apps/web/src/host/work-surface.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import {
  submitExchangeDraft,
  type ExchangeSubmissionContext,
  type ExchangeSubmissionPorts,
} from "../apps/web/src/host/submit-exchange-draft.js";

// Controlled work-surface/submission ports UNIT: not a Human authorization,
// actual Runtime, mounted App, draft persistence or author-network acceptance.
const authority = {
  appId: "author.notes",
  version: "1.0.0",
  definitionHash: "a".repeat(64),
  instanceId: "notes-instance",
  serviceId: "notes-service",
  dataAuthorityId: "notes-data",
};
const locator = (versionRef = "old:版@1") =>
  parseCognitiveAppObjectLocator({
    contentId: "notes-content",
    projectId: "first-project",
    connectionId: "notes-connection",
    authority,
    object: { objectId: "opaque:原件@id", versionRef },
  });
const empty: InputDraft = { body: "", selection: "", revision: null };
const original = (versionRef = "old:版@1") => ({
  kind: "original" as const,
  locator: locator(versionRef),
});
const view = () => ({
  kind: "view" as const,
  projectId: "first-project",
  viewId: "notes-view",
  connectionId: "notes-connection",
  authority,
});
function surface(cognitiveSurface = original()) {
  return deriveWorkSurface({
    state: initialWorkspace("2026-10-05T00:00:00.000Z"),
    prefs: {
      view: "projects" as const,
      projectId: "first-project",
      projectOpen: true,
      artifactId: null,
    },
    principalId: "local-owner",
    teamAuthentication: false,
    scriptLibrary: [],
    contentScope: "all",
    conversationDrafts: {},
    restoredPlace: null,
    cognitiveSurface,
  });
}
function context(
  cognitiveSurface: CognitiveWorkSurface | null = original(),
): ExchangeSubmissionContext {
  return Object.assign(
    {
      projectId: "first-project",
      conversationId: "local-dialogue",
      firstConversation: undefined,
      artifact: undefined,
      activeInstance: undefined,
      browserPage: null,
      readingExpected: false,
      currentReading: null,
      canAuthorizeDirectories: false,
      directoryScope: "first-project:local-dialogue",
      directoryState: {
        scope: "first-project:local-dialogue",
        ready: true,
        grants: [],
      },
      capabilities: {
        directedInput: true,
        conversationOnFirstInput: true,
        runtimeConfigured: true,
      },
    },
    { cognitiveSurface },
  );
}
function ports(flush: Promise<void> = Promise.resolve()) {
  const calls: Operation[] = [],
    envelopes: Parameters<ExchangeSubmissionPorts["execute"]>[] = [],
    errors: unknown[] = [],
    events: string[] = [];
  const value: ExchangeSubmissionPorts = {
    execute: async (...args) => {
      calls.push(args[0]);
      envelopes.push(args);
      events.push("execute");
      return {
        commandId: "accepted-command",
        entityId: "accepted-input",
        workspaceRevision: 1,
      } as Receipt;
    },
    profile: {
      flush: async () => {
        events.push("flush");
        await flush;
      },
      assertCurrentScope: () => {
        events.push("assert");
      },
    },
    isCurrentSurface: () => true,
    originalInput: () => undefined,
    persistSupplement: () => {
      events.push("persist");
    },
    onInputStaged: () => {},
    onResolved: () => {
      events.push("resolved");
    },
    onRejected: (error) => {
      errors.push(error);
    },
    onSettled: () => {
      events.push("settled");
    },
  };
  return { value, calls, envelopes, errors, events };
}

test("UNIT cognitive original owns scope, never first builtin instance or legacy draft", () => {
  const s = surface();
  assert.equal(s.project?.id, locator().projectId);
  assert.equal(s.artifact, undefined);
  assert.equal(s.activeInstance, undefined);
  assert.equal(s.applicationWorkspaceOpen, false);
  const oldDraft = { ...empty, body: "legacy must stay separate" };
  assert.equal(
    readWorkSurfaceDraft(s, { [s.legacyContextKey]: oldDraft }, empty).draft
      .body,
    "",
  );
  assert.notEqual(s.contextKey, s.legacyContextKey);
});
test("UNIT opaque identity keys survive head changes but not authority/connection rebind", () => {
  assert.equal(
    surface(original("old:版@1")).contextKey,
    surface(original("new:版@2")).contextKey,
  );
  const changed = original();
  changed.locator = parseCognitiveAppObjectLocator({
    ...changed.locator,
    connectionId: "other-connection",
  });
  assert.notEqual(surface(changed).contextKey, surface().contextKey);
  const a = view(),
    b = { ...a, viewRevision: 99, bindingRevision: 99 };
  const input = {
    state: initialWorkspace("2026-10-05T00:00:00.000Z"),
    prefs: {
      view: "projects" as const,
      projectId: "first-project",
      projectOpen: true,
      artifactId: null,
    },
    principalId: "local-owner",
    teamAuthentication: false,
    scriptLibrary: [],
    contentScope: "all",
    conversationDrafts: {},
    restoredPlace: null,
  };
  assert.equal(
    deriveWorkSurface({ ...input, cognitiveSurface: a }).contextKey,
    deriveWorkSurface({ ...input, cognitiveSurface: b }).contextKey,
  );
  assert.notEqual(
    deriveWorkSurface({ ...input, cognitiveSurface: a }).contextKey,
    surface().contextKey,
  );
});
test("UNIT missing cognitive owner never falls back to the desk", () => {
  const target = original();
  target.locator = parseCognitiveAppObjectLocator({
    ...target.locator,
    projectId: "missing-project",
  });
  assert.equal(surface(target).project, undefined);
});
test("UNIT first original send captures trusted exact old locator with no application Harness", async () => {
  const f = ports(),
    captured = { ...empty, body: "continue the original" };
  await submitExchangeDraft(captured, false, "interrupt", context(), f.value);
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 1);
  const op = f.calls[0] as Extract<Operation, { type: "record-input" }>;
  assert.deepEqual(op.cognitiveObject, locator());
  assert.equal(op.artifactId, null);
  assert.equal(op.artifactRevision, null);
  assert.equal(op.application, undefined);
  assert.equal(op.reading, undefined);
});
test("UNIT restored draft V1 beats current same original V2 and is detached before Profile await", async () => {
  let release!: () => void;
  const f = ports(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const raw = structuredClone(locator()) as {
    object: { objectId: string; versionRef: string };
  };
  const captured = Object.assign(
    { ...empty, body: "keep V1" },
    { cognitiveObject: raw },
  );
  const pending = submitExchangeDraft(
    captured,
    false,
    "parallel",
    context(original("new:版@2")),
    f.value,
  );
  assert.deepEqual(f.events, ["flush"]);
  raw.object.versionRef = "mutated-after-await";
  release();
  await pending;
  assert.deepEqual(f.errors, []);
  assert.deepEqual(
    (f.calls[0] as Extract<Operation, { type: "record-input" }>)
      .cognitiveObject,
    locator(),
  );
});
test("UNIT pure cognitive GUI input has no fabricated original or builtin application", async () => {
  const f = ports();
  const c = context(view());
  c.activeInstance = {
    applicationId: "author.notes",
    applicationVersion: "1.0.0",
  };
  await submitExchangeDraft(
    { ...empty, body: "ordinary project dialogue" },
    false,
    "interrupt",
    c,
    f.value,
  );
  assert.deepEqual(f.errors, []);
  const op = f.calls[0] as Extract<Operation, { type: "record-input" }>;
  assert.equal(op.cognitiveObject, undefined);
  assert.equal(op.application, undefined);
});
test("UNIT changed target or incompatible old numeric source fails before Profile and execute", async () => {
  for (const change of [
    { selection: "numeric builtin selection" },
    { revision: 2 },
    {
      scriptGeneration: {
        productionId: "script",
        targetId: "target",
        baseRevision: 1,
        contextRevision: 1,
        purpose: "rewrite" as const,
        references: [],
        maxCandidates: 1,
        maxOutputCharacters: 100,
        maxReviewPasses: 0,
      },
    },
  ]) {
    const f = ports();
    await submitExchangeDraft(
      Object.assign(
        { ...empty, body: "retain me", cognitiveObject: locator() },
        change,
      ),
      false,
      "interrupt",
      context(),
      f.value,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.events, ["settled"]);
  }
  const other = original();
  other.locator = parseCognitiveAppObjectLocator({
    ...other.locator,
    contentId: "other-content",
    object: { ...other.locator.object, objectId: "another-object" },
  });
  const f = ports();
  await submitExchangeDraft(
    Object.assign(
      { ...empty, body: "retain V1" },
      { cognitiveObject: locator() },
    ),
    false,
    "interrupt",
    context(other),
    f.value,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 1);
});
test("UNIT whole six-field authority and project/connection identities are not draft retargeting", async () => {
  for (const field of [
    "appId",
    "version",
    "definitionHash",
    "instanceId",
    "serviceId",
    "dataAuthorityId",
  ] as const) {
    const changed = view();
    changed.authority = {
      ...authority,
      [field]:
        field === "definitionHash"
          ? "b".repeat(64)
          : field === "version"
            ? "2.0.0"
            : field === "appId"
              ? "other.notes"
              : "other-value",
    };
    const f = ports();
    await submitExchangeDraft(
      { ...empty, body: "retain exact authority", cognitiveObject: locator() },
      false,
      "interrupt",
      context(changed),
      f.value,
    );
    assert.equal(f.calls.length, 0, field);
    assert.equal(f.errors.length, 1, field);
    assert.deepEqual(f.events, ["settled"], field);
  }
  const changed = view();
  changed.projectId = "other-project";
  const f = ports();
  await submitExchangeDraft(
    { ...empty, body: "wrong project" },
    false,
    "interrupt",
    context(changed),
    f.value,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 1);
});
test("UNIT JSON scope key cannot collide on opaque delimiters and does not merge named drafts", () => {
  const a = original(),
    b = original();
  a.locator = parseCognitiveAppObjectLocator({
    ...a.locator,
    authority: { ...authority, serviceId: "a:b", dataAuthorityId: "c" },
  });
  b.locator = parseCognitiveAppObjectLocator({
    ...b.locator,
    authority: { ...authority, serviceId: "a", dataAuthorityId: "b:c" },
  });
  assert.notEqual(surface(a).contextKey, surface(b).contextKey);
  const s = surface(),
    changed = {
      ...s,
      conversationId: "named-conversation",
      contextKey: s.contextKey.replace(
        "local-dialogue:",
        "named-conversation:",
      ),
      quoteKey: "named-conversation:quotes",
    };
  assert.equal(
    readWorkSurfaceDraft(
      changed,
      {
        [s.contextKey]: {
          ...empty,
          body: "other conversation",
          cognitiveObject: locator(),
        },
      },
      empty,
    ).draft.body,
    "",
  );
});
test("UNIT original fallback and source identity are detached before a held Profile", async () => {
  let release!: () => void;
  const f = ports(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const source = structuredClone(original());
  const pending = submitExchangeDraft(
    { ...empty, body: "capture opening V1" },
    false,
    "interrupt",
    context(source),
    f.value,
  );
  assert.deepEqual(f.events, ["flush"]);
  source.locator = locator("changed-current-head");
  release();
  await pending;
  assert.deepEqual(
    (f.calls[0] as Extract<Operation, { type: "record-input" }>)
      .cognitiveObject,
    locator(),
  );
  assert.deepEqual(f.errors, []);
});
test("UNIT inherited or nested getter source slots fail without reading them or sending", async () => {
  let reads = 0;
  const inherited = Object.assign(
    Object.create({ cognitiveObject: locator() }),
    { ...empty, body: "inherited source" },
  );
  const raw = structuredClone(locator());
  Object.defineProperty(raw.object, "versionRef", {
    enumerable: true,
    get() {
      reads++;
      return "hidden";
    },
  });
  for (const captured of [
    inherited,
    { ...empty, body: "nested source", cognitiveObject: raw },
  ]) {
    const f = ports();
    await submitExchangeDraft(captured, false, "interrupt", context(), f.value);
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors.length, 1);
  }
  assert.equal(reads, 0);
});
test("UNIT supplement ignores current cognitive surface, keeps original fields and pending command", async () => {
  const f = ports();
  const input: RecordedInput = {
    id: "original-input",
    projectId: "first-project",
    conversationId: "local-dialogue",
    author: { principalId: "local-owner", actantId: "local-human" },
    targetActantId: "morphz-agent",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "original",
    createdAt: "2026-10-05T00:00:00.000Z",
    status: "recorded",
    cognitiveObject: locator(),
  };
  f.value.originalInput = () => input;
  const continuation = {
    mode: "supplement" as const,
    inputId: input.id,
    threadId: "actual-thread-reference",
    generation: 2,
  };
  const pending: NonNullable<InputDraft["pendingSupplement"]> = {
    commandId: "same-original-command",
    operation: {
      type: "record-input",
      continuation,
      projectId: input.projectId,
      conversationId: input.conversationId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "supplement",
      targetActantId: input.targetActantId,
    },
  };
  await submitExchangeDraft(
    {
      ...empty,
      body: "not a retry replacement",
      continuation,
      cognitiveObject: locator("new:版@2"),
      pendingSupplement: pending,
    },
    false,
    "interrupt",
    context({ ...view(), projectId: "not-original-project" }),
    f.value,
  );
  assert.deepEqual(f.errors, []);
  assert.equal(f.envelopes.length, 1);
  assert.strictEqual(f.envelopes[0]![0], pending.operation);
  assert.equal(f.envelopes[0]![3], pending.commandId);
  assert.equal(
    (f.calls[0] as Extract<Operation, { type: "record-input" }>)
      .cognitiveObject,
    undefined,
  );
  assert.deepEqual(f.events, ["persist", "execute", "resolved", "settled"]);
});
test("UNIT legacy valid large quote carrier is not restricted by new source wire budget", async () => {
  const quotes = textQuotesSchema.parse(
    Array.from({ length: 30 }, (_, index) => ({
      id: randomUUID(),
      source: {
        kind: "web",
        projectId: "first-project",
        title: "Web quote",
        url: "https://example.invalid/" + "甲".repeat(8100) + index,
        pageId: "legacy-page",
        epoch: "legacy-epoch",
      },
      text: "甲",
      comment: "",
    })),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(quotes)) > 512 * 1024);
  for (const cognitiveSurface of [null, original()]) {
    const f = ports();
    await submitExchangeDraft(
      {
        ...empty,
        body: "legacy optional undefined fields",
        reading: undefined,
        scriptGeneration: undefined,
        textQuotes: quotes,
      },
      false,
      "interrupt",
      context(cognitiveSurface),
      f.value,
    );
    assert.deepEqual(f.errors, []);
    assert.strictEqual(
      (f.calls[0] as Extract<Operation, { type: "record-input" }>).textQuotes,
      quotes,
    );
  }
});
test("UNIT actual submission command rejects new slot getter before its original shallow spread", async () => {
  let reads = 0;
  const draft = { ...empty, body: "must remain" };
  Object.defineProperty(draft, "cognitiveObject", {
    enumerable: true,
    get() {
      reads++;
      return locator();
    },
  });
  const f = ports(),
    errors: Record<string, string> = {};
  const noop = () => {};
  const options: ExchangeSubmissionCommandOptions = {
    render: {
      ...context(),
      project: surface().project,
      selectedConversation: undefined,
      selectedDraft: undefined,
      draft,
      sending: false,
      uploadingDrafts: {},
      contextKey: surface().contextKey,
      workspace: undefined,
      emptyDraft: empty,
      rightInspector: { mode: "docked" },
    },
    client: {
      boot: null,
      execute: (
        operation,
        dispatch,
        applicationInstanceId,
        commandId,
        onInputStaged,
      ) => {
        assert.equal(applicationInstanceId, undefined);
        return f.value.execute(
          operation,
          dispatch,
          undefined,
          commandId,
          onInputStaged,
        );
      },
    },
    profile: f.value.profile,
    feedback: {
      sendPending: { current: false },
      currentContext: { current: surface().contextKey },
      setSending: noop,
      setInputErrors: (update) =>
        Object.assign(
          errors,
          typeof update === "function" ? update(errors) : update,
        ),
      setRevealedInputs: noop,
      setAnnotationRefresh: noop,
    },
    dictationControls: { current: null },
    drafts: { replace: noop, update: noop },
    exchange: {
      setMobileCollaboration: noop,
      showSentInput: noop,
      requestSentInputFocus: noop,
      showInput: noop,
    },
    inspector: { openCollaboration: noop, closeInspector: noop },
    onNotice: noop,
    focusAfterSupplement: noop,
  };
  await createExchangeSubmissionCommands(options).send();
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(errors[surface().contextKey], "原件引用无效，草稿已保留。");
  assert.equal(draft.body, "must remain");
});
test("UNIT new source slot accessor is not evaluated", async () => {
  let reads = 0;
  const captured = { ...empty, body: "retain me" };
  Object.defineProperty(captured, "cognitiveObject", {
    enumerable: true,
    get() {
      reads++;
      return locator();
    },
  });
  const f = ports();
  await submitExchangeDraft(captured, false, "interrupt", context(), f.value);
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 1);
});
