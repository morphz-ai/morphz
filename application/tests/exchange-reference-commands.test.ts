import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  createExchangeReferenceCommands,
  type ExchangeReferenceOptions,
} from "../apps/web/src/host/exchange-reference-commands.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import type { Artifact } from "../packages/core/src/model.js";
import type { ReadingReference } from "../packages/core/src/reader.js";
import type {
  TextQuote,
  TextQuoteSource,
} from "../packages/core/src/text-quotes.js";
import {
  createFixedReferenceCommands,
  type FixedReferenceBindings,
} from "./fixtures/exchange-reference-39cf13cf.js";
import {
  parseReference,
  verifyFixedReference,
  verifyReferenceOwner,
} from "./fixtures/exchange-reference-contract.js";

// Controlled semantic ports, not App mounting, HTTP/source authorization,
// persistence, Browser guest, native selection or model acceptance evidence.
const fixedSource = readFileSync(
  new URL("./fixtures/exchange-reference-39cf13cf.ts", import.meta.url),
  "utf8",
);
const ownerSource = readFileSync(
  new URL(
    "../apps/web/src/host/exchange-reference-commands.ts",
    import.meta.url,
  ),
  "utf8",
);
const empty: InputDraft = { body: "", selection: "", revision: null };
const token = "11111111-1111-4111-8111-111111111111";
const contentKey = "conversation:object";
const reference: ReadingReference = {
  book: { title: "读物", author: "作者", edition: "第一版", format: "text" },
  location: { sourceId: "source", sectionId: "chapter", start: 1, end: 3 },
  chapter: "第一章",
  quote: "原文",
  before: "之前",
  after: "之后",
};
const continuation: NonNullable<InputDraft["continuation"]> = {
  mode: "supplement",
  inputId: "input-original",
  threadId: "thread-original",
  generation: 4,
};
const scriptGeneration: NonNullable<InputDraft["scriptGeneration"]> = {
  productionId: "production",
  targetId: "scene",
  baseRevision: 4,
  contextRevision: 8,
  purpose: "rewrite",
  references: [],
  maxCandidates: 1,
  maxOutputCharacters: 24000,
  maxReviewPasses: 1,
};
const pendingSupplement: NonNullable<InputDraft["pendingSupplement"]> = {
  commandId: "pending",
  operation: {
    type: "record-input",
    projectId: "project",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    targetActantId: "morphz-agent",
    body: "原补充",
  },
};
function artifact(): Artifact {
  const author = { principalId: "human", actantId: "human-actant" };
  const content = { kind: "document" as const, markdown: "原文" };
  const createdAt = "2026-10-04T00:00:00.000Z";
  return {
    id: "object",
    projectId: "owner-project",
    title: "同一原件",
    revision: 9,
    content,
    createdBy: author,
    createdAt,
    updatedAt: createdAt,
    source: null,
    versions: [{ revision: 9, title: "同一原件", content, author, createdAt }],
  };
}
const sourceOwner = { projectId: "source-project", title: "原文来源" };
const sources: TextQuoteSource[] = [
  {
    ...sourceOwner,
    kind: "message",
    messageId: "message-original",
    inputId: "input-original",
    conversationId: "conversation",
    createdAt: "2026-10-04T00:00:00.000Z",
  },
  {
    ...sourceOwner,
    kind: "artifact",
    artifactId: "object",
    revision: 3,
    page: 2,
  },
  {
    ...sourceOwner,
    kind: "reading",
    artifactId: "object",
    revision: 4,
    location: reference.location,
    chapter: reference.chapter,
  },
  {
    ...sourceOwner,
    kind: "script",
    productionId: "production",
    entryId: "scene",
    revision: 5,
    candidateId: "candidate",
  },
  {
    ...sourceOwner,
    kind: "web",
    url: "https://example.invalid/original",
    pageId: "page-original",
    epoch: "page-epoch",
  },
  { ...sourceOwner, kind: "surface", applicationInstanceId: "instance" },
  { ...sourceOwner, kind: "surface" },
];
function quote(source: TextQuoteSource): TextQuote {
  return { id: token, source, text: "原文", comment: "评论" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type Setup = Partial<ExchangeReferenceOptions["render"]> & {
  loaded?: boolean;
  active?: boolean;
};
function harness(t: TestContext, lane: "fixed" | "owner", setup: Setup = {}) {
  const events: unknown[][] = [];
  const object = artifact();
  const renderedDrafts = setup.drafts ?? {};
  let stored = { ...renderedDrafts };
  let revealed: { quote: TextQuote; token: string } | null = null;
  const behavior = {
    active: setup.active ?? true,
    current: 7,
    found: false,
    nullSelection: false,
    target: object as Artifact | undefined,
    navigationResult: 7 as number | undefined,
    resolvePending: undefined as Promise<Artifact | undefined> | undefined,
    openPending: undefined as Promise<number | undefined> | undefined,
    replaceError: undefined as Error | undefined,
    updateError: undefined as Error | undefined,
    afterUpdateError: undefined as Error | undefined,
    selectionError: undefined as Error | undefined,
    revealError: undefined as Error | undefined,
    selectError: undefined as Error | undefined,
    showError: undefined as Error | undefined,
  };
  const generation = { current: 7 };
  const isActive = () => {
    events.push(["active", behavior.active]);
    return behavior.active;
  };
  const isCurrent = (value: number) => {
    events.push(["current", value]);
    return value === behavior.current;
  };
  const removeAllRanges = () => {
    events.push(["clear-selection"]);
    if (behavior.selectionError) throw behavior.selectionError;
  };
  const windowPort = {
    getSelection: () => {
      events.push(["get-selection"]);
      return behavior.nullSelection ? null : { removeAllRanges };
    },
  };
  const reveal = (value: TextQuote) => {
    events.push(["try-reveal", value]);
    if (behavior.revealError) throw behavior.revealError;
    return behavior.found;
  };
  const setReveal = (value: { quote: TextQuote; token: string }) => {
    events.push(["set-reveal", value]);
    revealed = value;
  };
  const replace = (key: string, value: InputDraft) => {
    events.push(["replace", key, value]);
    if (behavior.replaceError) throw behavior.replaceError;
    stored = { ...stored, [key]: value };
  };
  const update = (key: string, updater: (value: InputDraft) => InputDraft) => {
    events.push(["update", key]);
    if (behavior.updateError) throw behavior.updateError;
    stored = { ...stored, [key]: updater(stored[key] ?? empty) };
    events.push(["updated", key, stored[key]]);
    if (behavior.afterUpdateError) throw behavior.afterUpdateError;
  };
  const openObject: ExchangeReferenceOptions["navigation"]["openObject"] = (
    ...args
  ) => {
    events.push(["open-object", ...args]);
    return behavior.openPending ?? Promise.resolve(behavior.navigationResult);
  };
  const openScriptLocation: ExchangeReferenceOptions["navigation"]["openScriptLocation"] =
    (...args) => {
      events.push(["open-script", ...args]);
      return behavior.openPending ?? Promise.resolve(behavior.navigationResult);
    };
  const openBrowser: ExchangeReferenceOptions["navigation"]["openBrowser"] = (
    ...args
  ) => {
    events.push(["open-browser", ...args]);
    return behavior.openPending ?? Promise.resolve(behavior.navigationResult);
  };
  const activateApplication: ExchangeReferenceOptions["navigation"]["activateApplication"] =
    (...args) => {
      events.push(["activate", ...args]);
    };
  const selectConversation = (...args: [string, string, boolean?]) => {
    events.push(["select-conversation", ...args]);
    if (behavior.selectError) throw behavior.selectError;
  };
  const setExplicitWebsiteIntent: ExchangeReferenceOptions["navigation"]["setExplicitWebsiteIntent"] =
    (value) => {
      events.push(["website-intent", value]);
    };
  const resolveArtifact = (id: string) => {
    events.push(["resolve", id]);
    return behavior.resolvePending ?? Promise.resolve(behavior.target);
  };
  const keepOpen = () => {
    events.push(["keep-open"]);
  };
  const showInput = () => {
    events.push(["show-input"]);
    if (behavior.showError) throw behavior.showError;
  };
  const setInteraction: ExchangeReferenceOptions["exchange"]["setInteraction"] =
    (...args) => {
      events.push(["interaction", ...args]);
    };
  const requestConversationFocus = (id: string, value: number) => {
    events.push(["focus-conversation", id, value]);
  };
  const onNotice = (message: string) => {
    events.push(["notice", message]);
  };
  const options: ExchangeReferenceOptions = {
    render: {
      conversationId: "conversation",
      contextKey: "conversation:current",
      workspace: { artifacts: setup.loaded === false ? [] : [object] },
      drafts: renderedDrafts,
      draft: empty,
      sending: false,
      emptyDraft: empty,
      ...setup,
    },
    origin: { isActive },
    navigation: {
      navigationGeneration: generation,
      isCurrent,
      setExplicitWebsiteIntent,
      openObject,
      openScriptLocation,
      openBrowser,
      activateApplication,
      selectConversation,
    },
    client: { resolveArtifact },
    drafts: { replace, update },
    exchange: { keepOpen, showInput, setInteraction, requestConversationFocus },
    quotes: {
      clearSelection: () => windowPort.getSelection()?.removeAllRanges(),
      reveal,
      setReveal,
    },
    onNotice,
  };
  const fixed: FixedReferenceBindings = {
    conversationId: options.render.conversationId,
    contextKey: options.render.contextKey,
    state: options.render.workspace,
    drafts: options.render.drafts,
    draft: options.render.draft,
    sending: options.render.sending,
    emptyDraft: options.render.emptyDraft,
    origin: options.origin,
    navigation: options.navigation,
    navigationGeneration: generation,
    client: options.client,
    openObject,
    openScriptLocation,
    openBrowser,
    activateApplication,
    selectConversation,
    setWebsiteIntent: (value) => setExplicitWebsiteIntent(value),
    setDraft: replace,
    updateDraft: update,
    keepExchangeOpen: keepOpen,
    showInput,
    setInteraction,
    requestConversationFocus,
    revealTextQuote: reveal,
    setQuoteReveal: setReveal,
    setNotice: onNotice,
    window: windowPort,
  };
  t.mock.method(crypto, "randomUUID", () => {
    events.push(["uuid"]);
    return token;
  });
  const commands =
    lane === "fixed"
      ? createFixedReferenceCommands(fixed)
      : createExchangeReferenceCommands(options);
  assert.equal(events.length, 0, "construction performs no action");
  return {
    events,
    behavior,
    options,
    generation,
    commands,
    object,
    renderedDrafts,
    stored: () => stored,
    revealed: () => revealed,
    writeLatest(key: string, value: InputDraft) {
      stored = { ...stored, [key]: value };
    },
  };
}
type Harness = ReturnType<typeof harness>;
async function parity(
  t: TestContext,
  run: (value: Harness) => unknown | Promise<unknown>,
  setup: Setup = {},
) {
  async function lane(name: "fixed" | "owner") {
    const value = harness(t, name, setup);
    const result = await run(value);
    return {
      result,
      events: value.events,
      stored: value.stored(),
      revealed: value.revealed(),
    };
  }
  const original = await lane("fixed");
  const actual = await lane("owner");
  assert.deepEqual(actual, original, "complete original action/result parity");
  return actual;
}

test("fixed four complete Git algorithms and the finite owner adapters remain exact", () => {
  verifyFixedReference(fixedSource);
  verifyReferenceOwner(ownerSource, fixedSource);
});

test("legal counterfactuals reject the specific algorithm/constructor rule, not parse errors", () => {
  const mutations = [
    [
      'source.kind !== "message" && revealTextQuote(quote)',
      "revealTextQuote(quote)",
      "openTextQuote",
    ],
    ['source.kind === "reading",', "false,", "openTextQuote"],
    [
      "candidateId: source.candidateId,",
      "candidateId: undefined,",
      "openTextQuote",
    ],
    [
      "!origin.isActive() ||\n        generation === undefined",
      "false ||\n        generation === undefined",
      "openTextQuote",
    ],
    [
      'const key = conversationId + ":" + id;',
      'const key = target.projectId + ":" + id;',
      "composeContent",
    ],
    [
      "const revision = drafts[key]?.revision ?? target.revision;",
      "const revision = target.revision;",
      "composeContent",
    ],
    ["revision: old.revision ?? revision", "revision", "composeContent"],
    [
      "requestConversationFocus(conversationId, generation);",
      "requestConversationFocus(contextKey, generation);",
      "composeContent",
    ],
    [
      "old.continuation ||",
      "old.pendingSupplement || old.continuation ||",
      "composeReading",
    ],
    [
      "reading: structuredClone(reference),",
      "reading: reference,",
      "composeReading",
    ],
    ['intent === "script" &&', "true &&", "composeIntent"],
    [
      "void openBrowser();\n      return;",
      "void openBrowser();\n      showInput();\n      return;",
      "composeIntent",
    ],
    [
      "return { openTextQuote, composeContent, composeReading, composeIntent };",
      'client.resolveArtifact("eager");\n  return { openTextQuote, composeContent, composeReading, composeIntent };',
      "construction",
    ],
    [
      "const { reveal: revealTextQuote, setReveal: setQuoteReveal } = quotes;",
      "const eager = navigationGeneration.current;\n  const { reveal: revealTextQuote, setReveal: setQuoteReveal } = quotes;",
      "live ref",
    ],
  ] as const;
  for (const [before, after, rule] of mutations) {
    assert.ok(ownerSource.includes(before), "mutation has a real target");
    const source = ownerSource.replace(before, after);
    parseReference(source);
    assert.throws(
      () => verifyReferenceOwner(source, fixedSource),
      (error: unknown) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
      "finite rule rejects " + rule,
    );
  }
});

test("construction borrows workspace/ref/ports without reading or invoking them", (t) => {
  const value = harness(t, "owner");
  const forbidden = () => {
    throw new Error("constructor read/action");
  };
  Object.defineProperty(value.options.render.workspace!, "artifacts", {
    get: forbidden,
  });
  Object.defineProperty(value.generation, "current", { get: forbidden });
  value.options.origin.isActive = forbidden;
  value.options.client.resolveArtifact = forbidden;
  value.options.quotes.clearSelection = forbidden;
  value.options.quotes.reveal = forbidden;
  value.options.drafts.replace = forbidden;
  value.options.exchange.showInput = forbidden;
  const result = createExchangeReferenceCommands(value.options);
  assert.deepEqual(Object.keys(result), [
    "openTextQuote",
    "composeContent",
    "composeReading",
    "composeIntent",
  ]);
  assert.deepEqual(value.events, []);
});

test("all seven quote source branches preserve arguments, quote identity and token/action order", async (t) => {
  for (const source of sources) {
    const captured = quote(source);
    const result = await parity(t, async (value) => {
      await value.commands.openTextQuote(captured);
      if (value.revealed())
        assert.strictEqual(value.revealed()!.quote, captured);
    });
    assert.deepEqual(result.events[0], ["active", true]);
    assert.deepEqual(result.events[1], ["get-selection"]);
    assert.deepEqual(result.events[2], ["clear-selection"]);
    if (source.kind === "message") {
      assert.equal(
        result.events.some(([name]) => name === "try-reveal"),
        false,
      );
      assert.deepEqual(
        result.events.slice(3).map(([name]) => name),
        ["keep-open", "interaction", "uuid", "set-reveal"],
      );
    }
    if (source.kind === "artifact")
      assert.deepEqual(
        result.events.find(([name]) => name === "open-object"),
        [
          "open-object",
          source.projectId,
          source.artifactId,
          3,
          2,
          false,
          undefined,
        ],
      );
    if (source.kind === "reading")
      assert.deepEqual(
        result.events.find(([name]) => name === "open-object"),
        [
          "open-object",
          source.projectId,
          source.artifactId,
          4,
          undefined,
          true,
          source.location,
        ],
      );
  }
});

test("quote fast reveal returns without navigation/token; messages never use that shortcut", async (t) => {
  for (const source of sources) {
    const result = await parity(t, async (value) => {
      value.behavior.found = true;
      value.behavior.nullSelection = true;
      await value.commands.openTextQuote(quote(source));
    });
    if (source.kind !== "message")
      assert.deepEqual(
        result.events.map(([name]) => name),
        ["active", "get-selection", "try-reveal"],
      );
    else assert.ok(result.revealed);
  }
  const source = { ...sources[0]!, kind: "message" as const };
  if (source.kind !== "message" || !("messageId" in source))
    throw new Error("message source");
  const result = await parity(t, async (value) => {
    await value.commands.openTextQuote(
      quote({ ...source, conversationId: "other" }),
    );
  });
  assert.deepEqual(result.events[3], [
    "select-conversation",
    "source-project",
    "other",
  ]);
});

test("retired origin has no quote effects, and delayed source reads cannot publish stale reveals", async (t) => {
  const inactive = await parity(
    t,
    async (value) => {
      await value.commands.openTextQuote(quote(sources[1]!));
    },
    { active: false },
  );
  assert.deepEqual(inactive.events, [["active", false]]);
  for (const source of sources.slice(1, 5)) {
    for (const outcome of ["retired", "new-navigation", "undefined"] as const) {
      const result = await parity(t, async (value) => {
        const pending = deferred<number | undefined>();
        value.behavior.openPending = pending.promise;
        const promise = value.commands.openTextQuote(quote(source));
        value.behavior.active = outcome !== "retired";
        if (outcome === "new-navigation") value.behavior.current++;
        pending.resolve(outcome === "undefined" ? undefined : 7);
        await promise;
      });
      assert.equal(result.revealed, null);
      assert.equal(
        result.events.some(([name]) => name === "uuid"),
        false,
      );
    }
  }
});

test("quote DOM/selection/navigation errors propagate without added notice or rollback", async (t) => {
  for (const phase of [
    "selection",
    "reveal",
    "select",
    "navigation",
  ] as const) {
    const result = await parity(t, async (value) => {
      const error = new Error("original " + phase);
      let source = sources[1]!;
      if (phase === "selection") value.behavior.selectionError = error;
      if (phase === "reveal") value.behavior.revealError = error;
      if (phase === "select") {
        const message = sources[0]!;
        assert.ok(message.kind === "message");
        source = { ...message, conversationId: "other" };
        value.behavior.selectError = error;
      }
      if (phase === "navigation")
        value.behavior.openPending = Promise.reject(error);
      await assert.rejects(
        value.commands.openTextQuote(quote(source)),
        (cause) => cause === error,
      );
    });
    assert.equal(
      result.events.some(([name]) => name === "notice"),
      false,
    );
    assert.equal(result.revealed, null);
  }
});

test("content loaded path has no resolve/extra await, current version is live and the Session key stays captured", async (t) => {
  const result = await parity(t, async (value) => {
    const promise = value.commands.composeContent("object");
    assert.ok(value.stored()[contentKey]);
    value.events.push(["caller-after-call"]);
    await promise;
    value.events.push(["caller-after-await"]);
  });
  assert.equal(
    result.events.some(([name]) => name === "resolve"),
    false,
  );
  assert.deepEqual(
    result.events.find(([name]) => name === "open-object"),
    ["open-object", "owner-project", "object", undefined],
  );
  assert.ok(
    result.events.findIndex(([name]) => name === "update") <
      result.events.findIndex(([name]) => name === "caller-after-call"),
  );
  assert.equal(
    result.events.filter(([name]) => name === "keep-open").length,
    2,
  );
  assert.deepEqual(
    result.events.find(([name]) => name === "focus-conversation"),
    ["focus-conversation", "conversation", 7],
  );
});

test("content preserves pinned/null/falsy revisions, model/quotes/attachments and latest updater fields", async (t) => {
  for (const revision of [null, 3, 0]) {
    const original: InputDraft = {
      ...empty,
      revision,
      body: "旧版未发正文",
      model: "model-route",
      reasoningEffort: "max",
      attachments: [
        { assetId: "a".repeat(64), name: "素材", mime: "text/plain" },
      ],
      textQuotes: [quote(sources[1]!)],
    };
    const result = await parity(
      t,
      async (value) => {
        const pending = deferred<Artifact | undefined>();
        value.behavior.resolvePending = pending.promise;
        const promise = value.commands.composeContent("object");
        value.writeLatest(contentKey, {
          ...original,
          body: "期间继续输入",
          revision: 5,
        });
        pending.resolve(value.object);
        await promise;
      },
      { loaded: false, drafts: { [contentKey]: original } },
    );
    assert.deepEqual(result.stored[contentKey], {
      ...original,
      body: "期间继续输入",
      revision: 5,
    });
    assert.deepEqual(
      result.events.find(([name]) => name === "open-object"),
      [
        "open-object",
        "owner-project",
        "object",
        revision === null ? undefined : revision,
      ],
    );
  }
});

test("missing/retired/changed content stops before write; resolve rejects at the original boundary", async (t) => {
  for (const outcome of [
    "missing",
    "retired",
    "new-navigation",
    "error",
  ] as const) {
    const result = await parity(
      t,
      async (value) => {
        const pending = deferred<Artifact | undefined>();
        value.behavior.resolvePending = pending.promise;
        const promise = value.commands.composeContent("object");
        if (outcome === "retired") value.behavior.active = false;
        if (outcome === "new-navigation") value.behavior.current++;
        if (outcome === "error") {
          const error = new Error("resolve original");
          pending.reject(error);
          await assert.rejects(promise, (cause) => cause === error);
        } else {
          pending.resolve(outcome === "missing" ? undefined : value.object);
          await promise;
        }
      },
      { loaded: false },
    );
    assert.deepEqual(result.stored, {});
    assert.equal(
      result.events.some(([name]) => name === "update"),
      false,
    );
    assert.equal(
      result.events.some(([name]) => name === "notice"),
      false,
    );
  }
});

test("content retains partial writes on later failure; undefined/late navigation never adds focus", async (t) => {
  for (const phase of [
    "before-write",
    "after-write",
    "open-error",
    "undefined",
    "retired",
    "changed",
  ] as const) {
    const result = await parity(t, async (value) => {
      const error = new Error(phase);
      if (phase === "before-write") value.behavior.updateError = error;
      if (phase === "after-write") value.behavior.afterUpdateError = error;
      const pending = deferred<number | undefined>();
      value.behavior.openPending = pending.promise;
      const promise = value.commands.composeContent("object");
      if (phase === "before-write" || phase === "after-write") {
        await assert.rejects(promise, (cause) => cause === error);
      } else if (phase === "open-error") {
        pending.reject(error);
        await assert.rejects(promise, (cause) => cause === error);
      } else {
        if (phase === "retired") value.behavior.active = false;
        if (phase === "changed") value.behavior.current++;
        pending.resolve(phase === "undefined" ? undefined : 7);
        await promise;
      }
    });
    assert.equal(!!result.stored[contentKey], phase !== "before-write");
    assert.equal(
      result.events.some(([name]) => name === "focus-conversation"),
      false,
    );
    assert.equal(
      result.events.some(([name]) => name === "notice"),
      false,
    );
  }
});

test("original one-await completion/Caller.then order is exact for loaded and fetched content and quotes", async (t) => {
  for (const action of ["quote", "loaded", "fetched"] as const) {
    await parity(
      t,
      async (value) => {
        const read = deferred<Artifact | undefined>();
        const open = deferred<number | undefined>();
        value.behavior.openPending = open.promise;
        if (action === "fetched") value.behavior.resolvePending = read.promise;
        const promise =
          action === "quote"
            ? value.commands.openTextQuote(quote(sources[1]!))
            : value.commands.composeContent("object");
        const finished = promise.then(() => value.events.push(["caller-then"]));
        value.events.push(["caller-sync"]);
        await Promise.resolve();
        value.events.push(["before-resolve"]);
        if (action === "fetched") {
          read.resolve(value.object);
          await Promise.resolve();
          value.events.push(["after-read-microtask"]);
        }
        open.resolve(7);
        await Promise.resolve();
        value.events.push(["after-open-microtask"]);
        await finished;
        assert.ok(
          value.events.findIndex(
            ([name]) => name === "set-reveal" || name === "focus-conversation",
          ) < value.events.findIndex(([name]) => name === "caller-then"),
        );
      },
      { loaded: action !== "fetched" },
    );
  }
});

test("reading compatibility command rejects exactly its six original conflicts with original error", async (t) => {
  const conflicts: Partial<InputDraft>[] = [
    { body: "已输入" },
    { selection: "原选文" },
    {
      attachments: [
        { assetId: "a".repeat(64), mime: "text/plain", name: "素材" },
      ],
    },
    { continuation },
    { taskResult: { taskId: "task", revision: 2 } },
    { scriptGeneration },
  ];
  for (const conflict of conflicts) {
    const original = { ...empty, ...conflict };
    const result = await parity(
      t,
      (value) => value.commands.composeReading("object", 3, reference, "问题"),
      {
        drafts: { [contentKey]: original },
      },
    );
    assert.deepEqual(result.result, {
      ok: false,
      error: "输入框中有未发送内容，请先处理原草稿；这次选文仍保留。",
    });
    assert.deepEqual(result.events, []);
    assert.strictEqual(result.stored[contentKey], original);
  }
});

test("reading legal omitted guards stay legal and reference is cloned exactly once", async (t) => {
  const legal: InputDraft = {
    ...empty,
    body: "  ",
    textQuotes: [quote(sources[1]!)],
    pendingSupplement,
    annotation: true,
    intent: "script",
    reasoningEffort: "max",
    model: "model-route",
    page: 2,
    skipReading: true,
  };
  const result = await parity(
    t,
    (value) => {
      const result = value.commands.composeReading(
        "object",
        4,
        reference,
        "问题",
      );
      const saved = value.stored()[contentKey]!;
      assert.notStrictEqual(saved.reading, reference);
      assert.notStrictEqual(saved.reading!.location, reference.location);
      assert.strictEqual(saved.textQuotes, legal.textQuotes);
      assert.strictEqual(saved.pendingSupplement, legal.pendingSupplement);
      return result;
    },
    { drafts: { [contentKey]: legal }, sending: true, active: false },
  );
  assert.deepEqual(result.result, { ok: true });
  assert.deepEqual(result.stored[contentKey], {
    ...legal,
    reading: reference,
    skipReading: false,
    revision: 4,
    selection: reference.quote,
    body: "问题",
    annotation: false,
    intent: undefined,
  });
  assert.deepEqual(
    result.events.map(([name]) => name),
    ["replace", "show-input"],
  );
});

test("reading and intent preserve replace failures and already-written draft when show fails", async (t) => {
  for (const command of ["reading", "intent"] as const) {
    for (const phase of ["replace", "show"] as const) {
      const result = await parity(t, (value) => {
        const error = new Error(phase);
        if (phase === "replace") value.behavior.replaceError = error;
        else value.behavior.showError = error;
        assert.throws(
          () =>
            command === "reading"
              ? value.commands.composeReading("object", 4, reference, "问题")
              : value.commands.composeIntent("document"),
          (cause) => cause === error,
        );
      });
      assert.equal(
        Object.keys(result.stored).length,
        phase === "replace" ? 0 : 1,
      );
      assert.equal(
        result.events.some(([name]) => name === "notice"),
        false,
      );
    }
  }
});

test("script intent blocks exactly original request guards and preserves error → show order", async (t) => {
  for (const conflict of [
    { pendingSupplement },
    { continuation },
    { annotation: true },
    { taskResult: { taskId: "task", revision: 2 } },
    { scriptGeneration },
  ] satisfies Partial<InputDraft>[]) {
    const result = await parity(
      t,
      (value) => value.commands.composeIntent("script"),
      { draft: { ...empty, ...conflict } },
    );
    assert.deepEqual(result.events, [
      [
        "notice",
        "输入中已有另一份请求，请先完成或明确移除原请求，再构思新剧。原草稿保留。",
      ],
      ["show-input"],
    ]);
    assert.deepEqual(result.stored, {});
  }
  const result = await parity(
    t,
    (value) => value.commands.composeIntent("script"),
    { sending: true },
  );
  assert.deepEqual(
    result.events.map(([name]) => name),
    ["notice", "show-input"],
  );
});

test("all ordinary intents retain captured draft fields, repeat script is legal, website touches no input", async (t) => {
  const draft: InputDraft = {
    ...empty,
    body: "正文\n不追加模板",
    selection: "原选文",
    revision: 3,
    page: 2,
    reading: reference,
    model: "model-route",
    reasoningEffort: "max",
    attachments: [
      { assetId: "a".repeat(64), mime: "text/plain", name: "附件" },
    ],
    textQuotes: [quote(sources[1]!)],
  };
  for (const intent of ["task", "document", "interactive", "script"] as const) {
    const result = await parity(
      t,
      (value) => {
        value.commands.composeIntent(intent);
        value.commands.composeIntent(intent);
        const saved = value.stored()["conversation:current"]!;
        assert.strictEqual(saved.reading, reference);
        assert.strictEqual(saved.attachments, draft.attachments);
        assert.strictEqual(saved.textQuotes, draft.textQuotes);
      },
      { draft, active: false },
    );
    assert.deepEqual(result.stored["conversation:current"], {
      ...draft,
      intent,
      annotation: false,
      taskResult: undefined,
    });
    assert.deepEqual(
      result.events.map(([name]) => name),
      ["replace", "show-input", "replace", "show-input"],
    );
  }
  const website = await parity(
    t,
    (value) => value.commands.composeIntent("website"),
    { sending: true, draft: { ...draft, continuation } },
  );
  assert.deepEqual(website.events, [["open-browser"]]);
  assert.deepEqual(website.stored, {});
});

test("render scalar/draft/client/action captures never become a latest-value mirror", async (t) => {
  await parity(
    t,
    async (value) => {
      const captured = value.options.render.draft;
      value.options.render.conversationId = "new-conversation";
      value.options.render.contextKey = "new-context";
      value.options.render.draft = { ...empty, body: "新render不能替换旧捕获" };
      value.options.render.workspace = { artifacts: [] };
      value.options.client = {
        resolveArtifact: () => {
          throw new Error("new client");
        },
      };
      value.options.navigation.openObject = () => {
        throw new Error("new action");
      };
      value.commands.composeIntent("document");
      assert.equal(value.stored()["conversation:current"]!.body, captured.body);
      await value.commands.composeContent("object");
      assert.ok(value.stored()[contentKey]);
      assert.equal(value.stored()["new-conversation:object"], undefined);
    },
    { loaded: false, draft: { ...empty, body: "原render" } },
  );
});
