import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { format } from "prettier";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isFunctionDeclaration,
  isVariableDeclaration,
  isArrowFunction,
  isExpressionStatement,
  isVariableStatement,
  type Node,
} from "typescript/unstable/ast";
import {
  createExchangeReferenceCommands,
  type ExchangeReferenceOptions,
} from "../apps/web/src/host/exchange-reference-commands.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import type { TextQuote } from "../packages/core/src/text-quotes.js";
import { workSurfaceConversationId } from "../apps/web/src/host/work-surface.js";
import {
  createFixedExchangeReferencePreparations,
  fixedReferencePreparationBaseline as fixed,
  type FixedReferencePreparationBindings,
} from "./fixtures/exchange-reference-preparation-75ba44c0.js";
import { historicalReferencePreparationSources } from "./fixtures/exchange-reference-preparation-source-provenance.js";

// Controlled semantic ports, not real Client authorization, App consumption,
// HTTP, native focus or a complete durable submission receipt.
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
function parse(text: string) {
  const file = "/reference/source.tsx",
    config = "/reference/tsconfig.json";
  const api = new API({
    cwd: "/reference",
    fs: createVirtualFileSystem({
      [file]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: [file],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] }),
    program = snapshot.getProject(config)!.program;
  assert.deepEqual(
    program.getSyntacticDiagnostics(),
    [],
    "counterfactual must be valid TypeScript",
  );
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
function one(nodes: Node[], predicate: (node: Node) => boolean, rule: string) {
  const found = nodes.filter(predicate);
  assert.equal(found.length, 1, rule);
  return found[0]!;
}
const normalized = (body: string) =>
  format("const callback = () => " + body + ";", { parser: "typescript" });
const ownerSource = readFileSync(
  new URL(
    "../apps/web/src/host/exchange-reference-commands.ts",
    import.meta.url,
  ),
  "utf8",
);
const fixedSource = readFileSync(
  new URL(
    "./fixtures/exchange-reference-preparation-75ba44c0.tsx",
    import.meta.url,
  ),
  "utf8",
);
async function assertPreparationBodies(source: string) {
  const candidate = parse(source),
    old = parse(fixedSource);
  try {
    for (const name of [
      "prepareSearchQuote",
      "selectArtifactQuote",
      "changeTextQuotes",
      "focusCommentComposer",
    ] as const) {
      const oldNode = one(
        old.nodes,
        (n) => isVariableDeclaration(n) && n.name.getText() === name,
        "one fixed " + name,
      );
      assert.ok(
        isVariableDeclaration(oldNode) &&
          oldNode.initializer &&
          isArrowFunction(oldNode.initializer),
      );
      assert.equal(
        oldNode.initializer.getText(),
        fixed.spans[
          {
            prepareSearchQuote: "PrepareSearchQuote",
            selectArtifactQuote: "SelectArtifactQuote",
            changeTextQuotes: "ChangeTextQuotes",
            focusCommentComposer: "FocusCommentComposer",
          }[name] as "PrepareSearchQuote"
        ].raw,
        "complete original " + name,
      );
      const node = one(
        candidate.nodes,
        (n) =>
          name === "changeTextQuotes"
            ? isVariableDeclaration(n) && n.name.getText() === name
            : isFunctionDeclaration(n) && n.name?.text === name,
        "one actual " + name,
      );
      let body: string;
      if (isFunctionDeclaration(node)) {
        assert.ok(node.body);
        body = node.body.getText();
      } else {
        assert.ok(
          isVariableDeclaration(node) &&
            node.initializer &&
            isArrowFunction(node.initializer),
        );
        body = node.initializer.body.getText();
      }
      const oldBody = oldNode.initializer.body.getText();
      if (name === "prepareSearchQuote") {
        const frame = oldBody.slice(
          oldBody.indexOf("requestAnimationFrame("),
          oldBody.lastIndexOf("});"),
        );
        body = body.replace("scheduleSearchQuoteFocus();", frame.trimEnd());
      }
      if (name === "focusCommentComposer") {
        const frame = oldBody.slice(
          oldBody.indexOf("requestAnimationFrame("),
          oldBody.lastIndexOf("}"),
        );
        body = body.replace("scheduleCommentComposerFocus();", frame.trimEnd());
      }
      assert.equal(
        await normalized(body),
        await normalized(oldBody),
        "complete original algorithm " + name,
      );
    }
    for (const [name, prefix, raw, count] of [
      [
        "useExchangeQuoteRevealState",
        "const [quoteReveal, setQuoteReveal]",
        fixed.spans.QuoteRevealState.raw,
        2,
      ],
      [
        "useExchangeQuoteRevealCommit",
        "useEffect(",
        fixed.spans.QuoteRevealCommit.raw,
        1,
      ],
    ] as const) {
      const node = one(
        candidate.nodes,
        (n) => isFunctionDeclaration(n) && n.name?.text === name,
        name,
      );
      assert.ok(isFunctionDeclaration(node) && node.body);
      assert.equal(
        node.body.statements.length,
        count,
        "only original registrations/direct return " + name,
      );
      const statement = node.body.statements.find(
        (s) =>
          (isVariableStatement(s) || isExpressionStatement(s)) &&
          s.getText().startsWith(prefix),
      );
      assert.ok(statement);
      assert.equal(
        statement.getText(),
        raw,
        "complete original registration " + name,
      );
    }
  } finally {
    candidate.close();
    old.close();
  }
}
test("independent actual Git75ba embedded spans and complete original algorithms/registrations", async () => {
  assert.equal(fixed.git, "75ba44c030bfc9d569be4145044621600cf7572a");
  assert.equal(
    fixed.originalFiles["App.tsx"].sha256,
    "8a0deb7d7239318f862113529868c416c7d2283772de7ab5547485b4c1b6c2b1",
  );
  for (const span of Object.values(fixed.spans)) {
    assert.equal(sha(span.raw), span.sha256);
    assert.equal(Buffer.byteLength(span.raw), span.bytes);
  }
  // Historical Stage30 scope evidence, not a current-file safety contract.
  for (const [path, contract] of Object.entries(fixed.originalFiles))
    if (path !== "App.tsx" && path !== "host/exchange-reference-commands.ts")
      assert.equal(
        sha(historicalReferencePreparationSources[path]!),
        contract.sha256,
        "historical Stage30 consumer " + path,
      );
  await assertPreparationBodies(ownerSource);
});
test("finite legal source counterfactuals reject wrong guard, clearing, merge, dependency and focus policy", async () => {
  for (const [from, to, rule] of [
    [
      "generation !== navigationGeneration.current",
      "generation === navigationGeneration.current",
      "prepareSearchQuote",
    ],
    ["...(drafts[key] ?? emptyDraft)", "...emptyDraft", "prepareSearchQuote"],
    [
      "annotation,\n      taskResult: undefined,",
      "annotation,\n      taskResult: draft.taskResult,",
      "selectArtifactQuote",
    ],
    [
      "updateDraft(contextKey, (old) => ({ ...old, textQuotes }))",
      "updateDraft(contextKey, () => ({ ...draft, textQuotes }))",
      "changeTextQuotes",
    ],
    [
      "scheduleCommentComposerFocus();",
      "scheduleSearchQuoteFocus();",
      "focusCommentComposer",
    ],
    [
      "[conversationId]);",
      "[conversationId, setQuoteReveal]);",
      "useExchangeQuoteRevealCommit",
    ],
  ] as const) {
    assert.ok(ownerSource.includes(from), from);
    const changed = ownerSource.replace(from, to),
      parsed = parse(changed);
    parsed.close();
    await assert.rejects(
      assertPreparationBodies(changed),
      (error) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
    );
  }
});

const empty: InputDraft = { body: "", selection: "", revision: null };
const rich: InputDraft = {
  body: "captured body",
  selection: "old selection",
  revision: 2,
  page: 8,
  annotation: true,
  intent: "document",
  taskResult: { taskId: "task", revision: 4 },
  model: "original-model",
  reasoningEffort: "high",
  attachments: [],
  skipReading: true,
  continuation: {
    mode: "supplement",
    inputId: "input",
    threadId: "thread",
    generation: 3,
  },
  pendingSupplement: {
    commandId: "old-command",
    operation: {
      type: "record-input",
      projectId: "project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "saved",
      targetActantId: "agent",
    },
  },
};
const quote: TextQuote = {
  id: "11111111-1111-4111-8111-111111111111",
  source: {
    kind: "artifact",
    artifactId: "object",
    projectId: "project",
    revision: 2,
    title: "原件",
  },
  text: "original text",
  comment: "comment",
};
type Preparation = ReturnType<typeof createFixedExchangeReferencePreparations>;
function harness(
  lane: "old" | "new",
  options: {
    draft?: InputDraft;
    captured?: Record<string, InputDraft>;
    fail?: string;
    inside?: boolean;
    nullInput?: boolean;
    direct?: boolean;
    named?: string;
    team?: boolean;
  } = {},
) {
  const events: unknown[][] = [],
    frames: Array<() => void> = [],
    waits: Array<{
      resolve(value: number | undefined): void;
      promise: Promise<number | undefined>;
    }> = [];
  let generation = 9,
    activeElement: unknown = "outside",
    live: Record<string, InputDraft> = {
      "default:object": structuredClone(rich),
      "named:object": structuredClone(rich),
    };
  const draft = options.draft ?? structuredClone(rich),
    captured = options.captured ?? { ...live },
    contextKey = "current:object";
  const surface = {
    project: { id: "project" },
    conversationId: options.named ?? (options.team ? "project" : "default"),
    defaultConversation: options.team ? "project" : "default",
  };
  const fail = (step: string) => {
    if (options.fail === step) throw new Error("failure:" + step);
  };
  const bindings: FixedReferencePreparationBindings = {
    openObject(...args) {
      events.push(["open", ...args]);
      fail("open");
      if (options.direct)
        return {
          then(callback: (value: number | undefined) => void) {
            callback(generation);
          },
        } as unknown as Promise<number | undefined>;
      let resolve!: (value: number | undefined) => void;
      const promise = new Promise<number | undefined>((done) => {
        resolve = done;
      });
      waits.push({ resolve, promise });
      return promise;
    },
    navigationGeneration: {
      get current() {
        events.push(["generation", generation]);
        return generation;
      },
    },
    conversationKey(projectId) {
      events.push(["key", projectId]);
      fail("key");
      return workSurfaceConversationId(
        surface,
        { other: "reserved" },
        projectId,
      );
    },
    setDraft(key, value) {
      events.push(["replace", key, structuredClone(value)]);
      fail("replace");
      live = { ...live, [key]: value };
    },
    updateDraft(key, update) {
      events.push(["update", key]);
      fail("update");
      const next = update(live[key] ?? empty);
      events.push(["merged", structuredClone(next)]);
      live = { ...live, [key]: next };
    },
    setInteraction(value) {
      events.push(["interaction", value]);
      fail("interaction");
    },
    showInput() {
      events.push(["show"]);
      fail("show");
    },
    contextKey,
    drafts: captured,
    draft,
    emptyDraft: empty,
    requestAnimationFrame(callback) {
      events.push(["frame"]);
      fail("frame");
      frames.push(callback);
      return frames.length;
    },
    exchange: {
      current: {
        contains(element) {
          events.push(["contains", element]);
          return options.inside ?? false;
        },
      },
    },
    input: {
      current: options.nullInput
        ? null
        : {
            focus(value) {
              events.push(["focus", value]);
              fail("focus");
            },
          },
    },
    document: {
      get activeElement() {
        events.push(["active", activeElement]);
        return activeElement;
      },
    },
  };
  const actualOptions: ExchangeReferenceOptions = {
    render: {
      conversationId: surface.conversationId,
      contextKey,
      workspace: undefined,
      drafts: captured,
      draft,
      sending: true,
      emptyDraft: empty,
    },
    scope: { conversationKey: bindings.conversationKey },
    origin: {
      isActive() {
        throw new Error("new four methods must not add origin guard");
      },
    },
    navigation: {
      navigationGeneration: bindings.navigationGeneration,
      openObject: bindings.openObject,
      isCurrent() {
        throw new Error("original search uses direct generation equality");
      },
      setExplicitWebsiteIntent() {
        throw new Error("unexpected website intent");
      },
      async openScriptLocation() {
        throw new Error("unexpected script");
      },
      async openBrowser() {
        throw new Error("unexpected browser");
      },
      activateApplication() {
        throw new Error("unexpected activate");
      },
      selectConversation() {
        throw new Error("unexpected select");
      },
    },
    client: {
      async resolveArtifact() {
        throw new Error("unexpected query");
      },
    },
    drafts: { replace: bindings.setDraft, update: bindings.updateDraft },
    exchange: {
      keepOpen() {
        throw new Error("unexpected keepOpen");
      },
      showInput: bindings.showInput,
      setInteraction: bindings.setInteraction,
      requestConversationFocus() {
        throw new Error("unexpected focus lease");
      },
      scheduleSearchQuoteFocus() {
        bindings.requestAnimationFrame(() => {
          if (
            !bindings.exchange.current?.contains(
              bindings.document.activeElement,
            )
          )
            bindings.input.current?.focus();
        });
      },
      scheduleCommentComposerFocus() {
        bindings.requestAnimationFrame(() =>
          bindings.input.current?.focus({ preventScroll: true }),
        );
      },
    },
    quotes: {
      clearSelection() {
        throw new Error("unexpected clear");
      },
      reveal() {
        throw new Error("unexpected reveal");
      },
      setReveal() {
        throw new Error("unexpected reveal");
      },
    },
    onNotice() {
      throw new Error("unexpected notice");
    },
  };
  const methods: Preparation =
    lane === "old"
      ? createFixedExchangeReferencePreparations(bindings)
      : createExchangeReferenceCommands(actualOptions);
  assert.deepEqual(
    events,
    [],
    "construction does not read navigation/DOM/authority or perform work",
  );
  return {
    methods,
    events,
    bindings,
    options: actualOptions,
    get live() {
      return live;
    },
    setLive(next: Record<string, InputDraft>) {
      live = next;
    },
    setGeneration(value: number) {
      generation = value;
    },
    setActive(value: unknown) {
      activeElement = value;
    },
    runFrames() {
      while (frames.length) frames.shift()!();
    },
    async resolve(index: number, value: number | undefined) {
      waits[index]!.resolve(value);
      await waits[index]!.promise;
      await Promise.resolve();
    },
  };
}
async function lanes(
  run: (h: ReturnType<typeof harness>) => Promise<void> | void,
  options: Parameters<typeof harness>[1] = {},
) {
  const results = [];
  for (const lane of ["old", "new"] as const) {
    const h = harness(lane, options);
    await run(h);
    results.push({ events: h.events, live: h.live });
  }
  assert.deepEqual(
    results[1],
    results[0],
    "actual factory equals complete fixed original callbacks",
  );
  return results[0]!;
}
test("search is synchronous void, held navigation uses captured draft, exact arguments and original action order", async () => {
  const result = await lanes(async (h) => {
    assert.equal(
      h.methods.prepareSearchQuote("object", "project", 7, "chosen quote", 0),
      undefined,
    );
    assert.deepEqual(h.events, [
      ["open", "project", "object", 7, 0, false, undefined, "chosen quote"],
    ]);
    h.setLive({
      "default:object": {
        ...rich,
        body: "latest concurrent body",
        intent: "task",
      },
    });
    await h.resolve(0, 9);
    h.setActive("focus changed after scheduling");
    h.runFrames();
    assert.equal(h.live["default:object"]!.body, "captured body");
    assert.equal(h.live["default:object"]!.intent, "document");
    assert.equal(h.live["default:object"]!.taskResult?.taskId, "task");
    assert.equal(h.live["default:object"]!.selection, "chosen quote");
    assert.equal(h.live["default:object"]!.revision, 7);
    assert.equal(h.live["default:object"]!.page, 0);
  });
  assert.deepEqual(
    result.events.map((event) => event[0]),
    [
      "open",
      "generation",
      "key",
      "replace",
      "interaction",
      "frame",
      "active",
      "contains",
      "focus",
    ],
  );
});
test("undefined/stale/reverse generations reject only original completions, latest generation is read after await", async () => {
  await lanes(async (h) => {
    h.methods.prepareSearchQuote("A", "project", 1, "A");
    h.methods.prepareSearchQuote("B", "project", 2, "B");
    await h.resolve(1, 9);
    h.setGeneration(10);
    await h.resolve(0, 9);
    assert.equal(h.live["default:B"]!.selection, "B");
    assert.equal(h.live["default:A"], undefined);
    h.runFrames();
  });
  for (const value of [undefined, 8] as const)
    await lanes(async (h) => {
      h.methods.prepareSearchQuote("object", "project", 1, "q");
      await h.resolve(0, value);
      assert.ok(!h.events.some((event) => event[0] === "replace"));
    });
});
test("search borrows real default/named/reserved/team scope projection, absent captured draft uses original empty", async () => {
  for (const options of [{}, { named: "named" }, { team: true }] as const)
    await lanes(async (h) => {
      h.methods.prepareSearchQuote("object", "project", 3, "q");
      await h.resolve(0, 9);
      const replaced = h.events.find((event) => event[0] === "replace")!;
      assert.equal(
        replaced[1],
        ("named" in options
          ? "named"
          : "team" in options
            ? "project"
            : "default") + ":object",
      );
    }, options);
  await lanes(async (h) => {
    h.methods.prepareSearchQuote("new", "other", 3, "q");
    await h.resolve(0, 9);
    assert.deepEqual(h.live["reserved:new"], {
      ...empty,
      selection: "q",
      revision: 3,
      page: undefined,
    });
  });
});
test("artifact selection preserves captured fields but clears only original taskResult/intent, all optional variants", async () => {
  for (const annotation of [undefined, false, true])
    for (const page of [undefined, 0])
      await lanes((h) => {
        assert.equal(
          h.methods.selectArtifactQuote("", 5, page, annotation),
          undefined,
        );
        assert.deepEqual(h.live["current:object"], {
          ...rich,
          selection: "",
          revision: 5,
          page,
          annotation,
          taskResult: undefined,
          intent: undefined,
        });
        assert.deepEqual(
          h.events.map((e) => e[0]),
          ["replace", "show"],
        );
      });
});
test("Provider changes functionally merge latest body/attachment fields, do not clear legacy selection or choose recent", async () => {
  await lanes((h) => {
    const latest = {
      ...rich,
      body: "latest body",
      page: 0,
      intent: "task" as const,
    };
    h.setLive({ "current:object": latest });
    assert.equal(h.methods.changeTextQuotes([quote]), undefined);
    assert.deepEqual(h.live["current:object"], {
      ...latest,
      textQuotes: [quote],
    });
    assert.deepEqual(
      h.events.map((e) => e[0]),
      ["update", "merged"],
    );
  });
  const sentinel = { originalWriterValue: true };
  for (const lane of ["old", "new"] as const) {
    const h = harness(lane);
    const bindings = { ...h.bindings, updateDraft: () => sentinel };
    const methods =
      lane === "old"
        ? createFixedExchangeReferencePreparations(bindings)
        : createExchangeReferenceCommands({
            ...h.options,
            drafts: { ...h.options.drafts, update: () => sentinel },
          });
    assert.equal(
      methods.changeTextQuotes([]),
      sentinel,
      "preserve original expression return even when a void port supplies a runtime value",
    );
  }
});
test("comment/search retain distinct lazy focus policy, inside exchange avoids search stealing, null input is safe", async () => {
  for (const inside of [false, true]) {
    const search = await lanes(
      async (h) => {
        h.methods.prepareSearchQuote("object", "project", 1, "q");
        await h.resolve(0, 9);
        h.runFrames();
      },
      { inside },
    );
    assert.equal(
      search.events.filter((e) => e[0] === "focus").length,
      inside ? 0 : 1,
    );
    const comment = await lanes(
      (h) => {
        assert.equal(h.methods.focusCommentComposer(), undefined);
        h.runFrames();
      },
      { inside },
    );
    assert.deepEqual(comment.events, [
      ["show"],
      ["frame"],
      ["focus", { preventScroll: true }],
    ]);
  }
  await lanes(
    (h) => {
      h.methods.focusCommentComposer();
      h.runFrames();
    },
    { nullInput: true },
  );
});
test("original exceptions preserve exact committed prefix, no new recovery, guards or action after failure", async () => {
  for (const fail of ["open", "key", "replace", "interaction", "frame"])
    await lanes(
      (h) => {
        assert.throws(
          () => h.methods.prepareSearchQuote("object", "project", 1, "q"),
          new RegExp("failure:" + fail),
        );
        assert.equal(
          h.events.at(-1)![0],
          fail === "open"
            ? "open"
            : fail === "key"
              ? "key"
              : fail === "frame"
                ? "frame"
                : fail,
        );
      },
      { direct: true, fail },
    );
  for (const fail of ["replace", "show"])
    await lanes(
      (h) => {
        assert.throws(
          () => h.methods.selectArtifactQuote("q", 1),
          new RegExp("failure:" + fail),
        );
        assert.equal(h.events.at(-1)![0], fail);
      },
      { fail },
    );
  await lanes(
    (h) => {
      assert.throws(() => h.methods.changeTextQuotes([]), /failure:update/);
      assert.deepEqual(h.events, [["update", "current:object"]]);
    },
    { fail: "update" },
  );
  await lanes(
    (h) => {
      assert.throws(() => h.methods.focusCommentComposer(), /failure:show/);
      assert.deepEqual(h.events, [["show"]]);
    },
    { fail: "show" },
  );
});
