import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isArrayBindingPattern,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import {
  acknowledgeReplies,
  hasUnreadReplies,
  projectConversationReadScope,
  replyReceipts,
  type ConversationFocus,
  type ReadReplies,
  type ReplyReceipt,
} from "../apps/web/src/conversation-read.js";
import {
  useExchangeReadAcknowledgement,
  useExchangeReadReceiptCommit,
  useExchangeReadReceiptState,
} from "../apps/web/src/host/use-exchange-read-receipts.js";
import {
  conversationGroups,
  disconnectedRuntime,
} from "../packages/core/src/conversation.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";
import type { Workspace } from "../packages/core/src/model.js";
import type { ScriptOutput } from "../packages/core/src/script-delivery.js";
import {
  fixedAppRead,
  fixedHistoryRead,
  type FixedReadSource,
} from "./fixtures/exchange-read-receipts-4ce98b64.js";

const fixedHashes = {
  app: "77224e3cf9f5c3d100936cd0c2cb0743e3b57a56f6551e28c6453f9fbb10e237",
  history: "b876a5e9cc2e2904ef7c8738334d504d86bc5c0eae25cf00c52eac9f1782e30e",
  state: "13b1a0bbc9c838419a26051d54d775fe6c5614f8d7b76f139ef8041dc032f401",
  ack: "d9df1d5b8d8a3ecfc2121f7b18ff6ab582e1e08dd670bbfcb458d28f76b6f996",
  commit: "d8b01ffb8c18b7f6a0254070fa568463efc6371990a76d1fafa4bb73649cd4c3",
};
const fixedSource = readFileSync(
  new URL("./fixtures/exchange-read-receipts-4ce98b64.ts", import.meta.url),
  "utf8",
);
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
function shape(node: Node, source: SourceFile): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child, source));
  });
  return [
    node.kind,
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(source),
  ];
}
function withSource<T>(
  text: string,
  read: (source: SourceFile, symbols: Map<Node, number | undefined>) => T,
): T {
  const directory = "/exchange-read-fixture",
    config = directory + "/tsconfig.json";
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [directory + "/source.tsx"]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["source.tsx"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!,
      program = project.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(directory + "/source.tsx")!,
      identifiers: Node[] = [];
    walk(source, (node) => {
      if (isIdentifier(node)) identifiers.push(node);
    });
    const resolved = project.checker.getSymbolAtLocation(identifiers),
      symbols = new Map<Node, number | undefined>();
    identifiers.forEach((node, index) =>
      symbols.set(node, resolved[index]?.id),
    );
    return read(source, symbols);
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function fixtureHashes(text: string) {
  return withSource(text, (source) => {
    function recipe(name: string, names: string[]) {
      const fn = source.statements.find(
        (node) => isFunctionDeclaration(node) && node.name?.text === name,
      )!;
      const vars = new Map<string, Node>();
      const effects: Node[] = [];
      let state: Node | undefined;
      walk(fn, (node) => {
        if (
          isVariableDeclaration(node) &&
          isIdentifier(node.name) &&
          node.initializer
        )
          vars.set(node.name.text, node.initializer);
        if (
          isVariableDeclaration(node) &&
          isArrayBindingPattern(node.name) &&
          node.name.elements.some(
            (element) =>
              isBindingElement(element) &&
              !!element.name &&
              isIdentifier(element.name) &&
              element.name.text === "seenReplies",
          )
        )
          state = node.initializer;
        if (
          isCallExpression(node) &&
          isIdentifier(node.expression) &&
          node.expression.text === "useEffect"
        )
          effects.push(node);
      });
      return {
        recipe: names.map((name) => shape(vars.get(name)!, source)),
        state: state && shape(state, source),
        ack: vars.has("readReplies") && shape(vars.get("readReplies")!, source),
        effects: effects.map((node) => shape(node, source)),
      };
    }
    return {
      app: hash(
        recipe("fixedAppRead", [
          "badgeInputs",
          "badgeInputIds",
          "conversationInputIds",
          "badgeReplies",
          "receipts",
          "receiptVersion",
          "unseenReply",
        ]).recipe,
      ),
      history: hash(
        recipe("fixedHistoryRead", [
          "focused",
          "inputs",
          "inputById",
          "groups",
          "items",
          "outputs",
          "scriptOutputs",
          "receipts",
          "readVersion",
          "unread",
        ]).recipe,
      ),
      state: hash(recipe("useFixedReceiptState", []).state),
      ack: hash(recipe("useFixedReceiptAcknowledgement", []).ack),
      commit: hash(recipe("useFixedReceiptCommit", []).effects),
    };
  });
}
test("fixed Git 4ce98b64 source recipes and registrations remain independent of the new owner", () => {
  assert.deepEqual(fixtureHashes(fixedSource), fixedHashes);
  for (const [old, changed] of [
    ["|| m.text.trim()", "|| !m.text.trim()"],
    ["[seenReplies]", "[receipts]"],
    [
      "{ artifactId: focusedArtifactId, applicationId: focusedApplicationId }",
      "{ artifactId: focusedArtifactId, applicationId: undefined }",
    ],
  ]) {
    assert.notEqual(fixedSource.replace(old!, changed!), fixedSource);
    assert.notDeepEqual(
      fixtureHashes(fixedSource.replace(old!, changed!)),
      fixedHashes,
    );
  }
});

const now = "2026-10-04T00:00:00.000Z";
function input(
  id: string,
  extra: Partial<Workspace["inputs"][number]> = {},
): Workspace["inputs"][number] {
  return {
    id,
    projectId: "project",
    conversationId: "named",
    body: id,
    artifactId: null,
    createdAt: now,
    ...extra,
  } as Workspace["inputs"][number];
}
function message(
  id: string,
  inputId: string | null,
  extra: Partial<LiveMessage> = {},
): LiveMessage {
  return {
    id,
    inputId,
    projectId: "project",
    conversationId: "named",
    artifactId: null,
    rootId: null,
    createdAt: now,
    kind: "reply",
    text: id,
    ...extra,
  };
}
function source(
  focus: ConversationFocus = {},
  seenReplies: ReadReplies = {},
): FixedReadSource {
  const replies = [
    message("late", "derived", {
      createdAt: "2026-10-04T00:00:09.000Z",
      publicationKey: "attempt",
    }),
    message("early", "direct", { createdAt: "2026-10-04T00:00:01.000Z" }),
    message("other", "other"),
    message("unattributed", null),
    message("progress", "direct", { kind: "progress" }),
    message("tool", "browser", { kind: "tool" }),
    message("blank", "direct", { text: " \n" }),
    message("error", "browser", { kind: "error" }),
  ];
  const outputs = [
    {
      commandId: "derived-result",
      inputId: "derived",
      projectId: "project",
      artifactId: "object",
      revision: 3,
      createdAt: now,
    },
    {
      commandId: "other-result",
      inputId: "other",
      projectId: "project",
      artifactId: "other",
      revision: 1,
      createdAt: now,
    },
    {
      commandId: "unscoped-result",
      inputId: "absent",
      projectId: "project",
      artifactId: "object",
      revision: 2,
      createdAt: now,
    },
  ];
  const scriptOutputs: ScriptOutput[] = ["first-review", "second-review"].map(
    (reviewId) => ({
      commandId: "reviews",
      inputId: "direct",
      projectId: "project",
      productionId: "production",
      kind: "review",
      productionTitle: "Production",
      itemKind: "episode",
      itemId: "episode",
      reviewId,
      title: "Episode",
      revision: 1,
      createdAt: now,
    }),
  );
  return {
    inputs: [
      input("direct", { artifactId: "object" }),
      input("derived"),
      input("browser", {
        application: {
          instanceId: "browser-instance",
          id: "morphz.browser",
          version: "1.0.0",
          harness: null,
        },
      }),
      input("other", { artifactId: "other" }),
    ],
    replies,
    client: {
      boot: {
        outputs,
        scriptOutputs,
        runtime: {
          ...disconnectedRuntime,
          messages: replies.flatMap((message) =>
            message.kind === "tool" ? [] : [{ ...message, kind: message.kind }],
          ),
        },
      },
    },
    conversationFocus: focus,
    seenReplies,
  };
}
function scope(
  value: FixedReadSource,
  focus: ConversationFocus,
  messageArray: "preserve-unfocused" | "filter-always",
) {
  return projectConversationReadScope({
    inputs: value.inputs,
    messages: value.replies,
    outputs: value.client.boot.outputs,
    scriptOutputs: value.client.boot.scriptOutputs,
    scope: { focus, messageArray },
  });
}
test("App keeps separate full reconciliation and focused unread scopes, including receipt order", () => {
  for (const focus of [
    {},
    { artifactId: "object" },
    { applicationId: "browser-instance" },
    { artifactId: "object", applicationId: "browser-instance" },
    { artifactId: "absent" },
  ]) {
    for (const read of [false, true]) {
      const value = source(focus);
      if (read)
        value.seenReplies = acknowledgeReplies(
          {},
          replyReceipts(
            value.replies,
            value.client.boot.outputs,
            value.client.boot.scriptOutputs,
          ),
        );
      const old = fixedAppRead(value),
        badge = scope(value, focus, "preserve-unfocused"),
        full = scope(value, {}, "preserve-unfocused");
      assert.deepEqual(badge.inputs, old.badgeInputs);
      assert.deepEqual(badge.messages, old.badgeReplies);
      const receipts = replyReceipts(
        full.messages,
        full.outputs,
        full.scriptOutputs,
      );
      assert.deepEqual(receipts, old.receipts);
      assert.equal(JSON.stringify(receipts), old.receiptVersion);
      assert.equal(
        hasUnreadReplies(
          value.seenReplies,
          replyReceipts(badge.messages, badge.outputs, badge.scriptOutputs),
        ),
        old.unseenReply,
      );
      if (focus.artifactId === "object") {
        assert.deepEqual(
          badge.inputs.map((value) => value.id),
          ["direct", "derived"],
        );
        assert(full.messages.some((value) => value.id === "other"));
        assert(!badge.messages.some((value) => value.id === "other"));
      }
    }
  }
});
test("history retains allHistory, inspect filtering and its sorted receipt order instead of badge ordering", () => {
  for (const focus of [
    {},
    { artifactId: "object" },
    { applicationId: "browser-instance" },
    { artifactId: "object", applicationId: "browser-instance" },
  ]) {
    for (const allHistory of [false, true])
      for (const onInspect of [undefined, (_id: string) => {}]) {
        const value = source(focus),
          old = fixedHistoryRead({ ...value, allHistory, onInspect });
        const projected = scope(
          value,
          allHistory ? {} : focus,
          "filter-always",
        );
        assert.deepEqual(projected.inputs, old.inputs);
        assert.deepEqual(
          conversationGroups(projected.inputs, projected.messages),
          old.groups,
        );
        assert.deepEqual(projected.outputs, old.outputs);
        assert.deepEqual(projected.scriptOutputs, old.scriptOutputs);
        // The actual Conversation items initializer remains fixed below. It is
        // deliberately not replaced by a common badge message/order pipeline.
        const receipts = replyReceipts(
          old.items.flatMap((item) => (item.reply ? [item.reply] : [])),
          projected.outputs,
          projected.scriptOutputs,
        );
        assert.deepEqual(receipts, old.receipts);
        assert.equal(JSON.stringify(receipts), old.readVersion);
        assert.equal(hasUnreadReplies(value.seenReplies, receipts), old.unread);
      }
  }
  const value = source();
  assert.notDeepEqual(
    fixedAppRead(value).receipts,
    fixedHistoryRead({ ...value, allHistory: false }).receipts,
  );
});
test("array identity and contained object identity preserve both explicit old consumer contracts", () => {
  for (const messageArray of ["preserve-unfocused", "filter-always"] as const) {
    const value = source(),
      projected = scope(value, {}, messageArray);
    assert.equal(projected.inputs, value.inputs);
    assert.equal(
      projected.messages === value.replies,
      messageArray === "preserve-unfocused",
    );
    assert.notEqual(projected.outputs, value.client.boot.outputs);
    assert.notEqual(projected.scriptOutputs, value.client.boot.scriptOutputs);
    for (const element of projected.messages)
      assert(value.replies.includes(element));
    for (const element of projected.outputs)
      assert(value.client.boot.outputs.includes(element));
    const focused = scope(value, { artifactId: "object" }, messageArray);
    assert.notEqual(focused.inputs, value.inputs);
    assert.notEqual(focused.messages, value.replies);
    for (const element of focused.inputs)
      assert(value.inputs.includes(element));
  }
});
test("empty/missing ownership and prose/publication/script-version changes preserve receipt facts", () => {
  const value = source({ artifactId: "absent" }),
    projected = scope(value, value.conversationFocus, "preserve-unfocused");
  assert.deepEqual(projected, {
    inputs: [],
    messages: [],
    outputs: [],
    scriptOutputs: [],
  });
  value.inputs = [];
  const full = scope(value, {}, "preserve-unfocused");
  assert.equal(full.messages, value.replies);
  assert.deepEqual(full.outputs, []);
  assert.deepEqual(full.scriptOutputs, []);
  const original = source({ artifactId: "object" });
  const read = acknowledgeReplies(
    {},
    replyReceipts(
      original.replies,
      original.client.boot.outputs,
      original.client.boot.scriptOutputs,
    ),
  );
  original.seenReplies = read;
  assert.equal(fixedAppRead(original).unseenReply, false);
  original.replies = original.replies.map((reply) =>
    reply.id === "late" ? { ...reply, id: "durable-late" } : reply,
  );
  const reconciled = scope(
    original,
    original.conversationFocus,
    "preserve-unfocused",
  );
  assert.equal(
    hasUnreadReplies(
      read,
      replyReceipts(
        reconciled.messages,
        reconciled.outputs,
        reconciled.scriptOutputs,
      ),
    ),
    false,
  );
  original.replies = original.replies.map((reply) =>
    reply.id === "early" ? { ...reply, text: "alter" } : reply,
  );
  assert.equal(fixedAppRead(original).unseenReply, true);
});
test("scope projection does not add serialization or fold timeline/receipt ordering into a default", () => {
  const value = source();
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    calls++;
    return stringify(...args);
  }) as typeof JSON.stringify;
  try {
    scope(value, {}, "preserve-unfocused");
    scope(value, value.conversationFocus, "filter-always");
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(calls, 0);
});
test("actual Conversation keeps its original items/receipt initializers and allHistory reset", () => {
  const actual = readFileSync(
    new URL("../apps/web/src/Conversation.tsx", import.meta.url),
    "utf8",
  );
  const extract = (text: string, functionName: string) =>
    withSource(text, (source) => {
      const fn = source.statements.find(
        (node) =>
          isFunctionDeclaration(node) && node.name?.text === functionName,
      )!;
      const values: Record<string, unknown> = {};
      walk(fn, (node) => {
        if (
          isVariableDeclaration(node) &&
          isIdentifier(node.name) &&
          ["items", "receipts", "readVersion", "unread"].includes(
            node.name.text,
          )
        )
          values[node.name.text] = shape(node.initializer!, source);
      });
      return values;
    });
  assert.deepEqual(
    extract(actual, "Conversation"),
    extract(fixedSource, "fixedHistoryRead"),
  );
  verifyCognitiveHistoryReset(actual);
  // The renderer still owns receipt computation; its visibility/focus/modal
  // guards now live in the directly consumed complete viewport controller.
  const viewport = readFileSync(
    new URL(
      "../apps/web/src/features/exchange/useConversationViewport.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert(
    actual.includes('from "./features/exchange/useConversationViewport.js"'),
  );
  assert(actual.includes("useConversationViewportCommit("));
  assert(viewport.includes('document.visibilityState === "visible"'));
  assert(viewport.includes("document.hasFocus()"));
  assert(viewport.includes('!document.querySelector("dialog[open]")'));
});

function verifyCognitiveHistoryReset(text: string) {
  const expected = withSource(
    "useEffect(() => setAllHistory(false), [focusedArtifactId, focusedApplicationId, cognitiveFocusKey]);",
    (source) => shape(source.statements[0]!, source),
  );
  withSource(text, (source, symbols) => {
    const component = source.statements.find(
      (node) =>
        isFunctionDeclaration(node) && node.name?.text === "Conversation",
    )!;
    const setters: Node[] = [];
    walk(component, (node) => {
      if (isVariableDeclaration(node) && isArrayBindingPattern(node.name))
        for (const entry of node.name.elements)
          if (
            isBindingElement(entry) &&
            entry.name &&
            isIdentifier(entry.name) &&
            entry.name.text === "setAllHistory"
          )
            setters.push(entry.name);
    });
    assert.equal(setters.length, 1, "exact-cognitive-allHistory-reset");
    const setter = symbols.get(setters[0]!);
    assert.notEqual(setter, undefined, "exact-cognitive-allHistory-reset");
    const effects: Node[] = [];
    walk(component, (node) => {
      if (
        !isCallExpression(node) ||
        !isIdentifier(node.expression) ||
        node.expression.text !== "useEffect" ||
        !node.arguments[0]
      )
        return;
      let used = false;
      walk(node.arguments[0], (child) => {
        if (isIdentifier(child) && symbols.get(child) === setter) used = true;
      });
      if (used) effects.push(node);
    });
    assert.equal(effects.length, 1, "exact-cognitive-allHistory-reset");
    const bindings: Node[] = [];
    for (const declaration of source.statements.filter(isImportDeclaration)) {
      const named = declaration.importClause?.namedBindings;
      if (
        !isStringLiteral(declaration.moduleSpecifier) ||
        declaration.moduleSpecifier.text !== "react" ||
        !named ||
        !isNamedImports(named) ||
        declaration.importClause?.phaseModifier === SyntaxKind.TypeKeyword
      )
        continue;
      for (const entry of named.elements)
        if (
          (entry.propertyName ?? entry.name).text === "useEffect" &&
          !entry.isTypeOnly
        )
          bindings.push(entry.name);
    }
    assert.equal(bindings.length, 1, "exact-cognitive-allHistory-reset");
    const effect = effects[0]!;
    assert.ok(isCallExpression(effect), "exact-cognitive-allHistory-reset");
    assert.equal(
      symbols.get(effect.expression),
      symbols.get(bindings[0]!),
      "exact-cognitive-allHistory-reset",
    );
    // Only this exact callback/dependency extension is approved. Receipt and
    // original item initializers above still compare with the immutable 4ce.
    assert.deepEqual(
      shape(effect.parent, source),
      expected,
      "exact-cognitive-allHistory-reset",
    );
  });
}
test("actual cognitive history reset rejects a missing/wrong key, callback inversion and foreign effect", () => {
  const actual = readFileSync(
    new URL("../apps/web/src/Conversation.tsx", import.meta.url),
    "utf8",
  );
  for (const [before, after] of [
    [
      "[focusedArtifactId, focusedApplicationId, cognitiveFocusKey]",
      "[focusedArtifactId, focusedApplicationId]",
    ],
    [
      "[focusedArtifactId, focusedApplicationId, cognitiveFocusKey]",
      "[focusedArtifactId, focusedApplicationId, focusedCognitiveObject]",
    ],
    ["() => setAllHistory(false)", "() => setAllHistory(true)"],
    [
      "() => setAllHistory(false)",
      "() => setAllHistory(false), () => setAllHistory(false)",
    ],
    ['from "react";', 'from "./fake-react.js";'],
  ]) {
    assert.equal(
      actual.split(before!).length - 1,
      1,
      "unique cognitive read-reset seam",
    );
    const candidate = actual.replace(before!, after!);
    withSource(candidate, () => undefined);
    assert.throws(
      () => verifyCognitiveHistoryReset(candidate),
      assert.AssertionError,
    );
  }
});

// Isolated registration adapter, not a React renderer or a real visibility
// oracle. It executes both actual hook modules and compares callbacks/deps and
// setter/persistence traces. Real SSR initialization is separately tested.
class Registrations {
  cursor = 0;
  slots: Array<{
    value?: unknown;
    setter?: (next: unknown) => void;
    deps?: unknown[];
  }> = [];
  pending: Array<() => void> = [];
  trace: unknown[][] = [];
  useState(initial: unknown) {
    const index = this.cursor++;
    this.trace.push(["register", "state", index]);
    if (!this.slots[index])
      this.slots[index] = {
        value:
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
      };
    const slot = this.slots[index]!;
    slot.setter ??= (next) => {
      const old = slot.value;
      slot.value =
        typeof next === "function"
          ? (next as (old: unknown) => unknown)(old)
          : next;
      this.trace.push(["set", index, slot.value, old === slot.value]);
    };
    return [slot.value, slot.setter];
  }
  useCallback(callback: unknown, deps: unknown[]) {
    const index = this.cursor++;
    this.trace.push(["register", "callback", index, deps]);
    if (!this.same(this.slots[index]?.deps, deps))
      this.slots[index] = { value: callback, deps };
    return this.slots[index]!.value;
  }
  useEffect(callback: () => void, deps: unknown[]) {
    const index = this.cursor++;
    this.trace.push(["register", "effect", index, deps]);
    if (!this.same(this.slots[index]?.deps, deps)) this.pending.push(callback);
    this.slots[index] = { deps };
  }
  same(old: unknown[] | undefined, next: unknown[]) {
    return (
      !!old &&
      old.length === next.length &&
      old.every((value, index) => Object.is(value, next[index]))
    );
  }
  begin() {
    this.cursor = 0;
  }
  flush() {
    const pending = this.pending.splice(0);
    for (const effect of pending) effect();
  }
}
const shimKey = "__exchangeReadReceiptRegistrationContract";
const shimUrl =
  "data:text/javascript," +
  encodeURIComponent(`
export const useState = initial => globalThis.${shimKey}.useState(initial);
export const useCallback = (callback,deps) => globalThis.${shimKey}.useCallback(callback,deps);
export const useEffect = (callback,deps) => globalThis.${shimKey}.useEffect(callback,deps);
`);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "react" &&
      context.parentURL?.includes("receipt-registration-contract")
    )
      return { url: shimUrl, shortCircuit: true };
    return next(specifier, context);
  },
});
const productionHooks = (await import(
  new URL(
    "../apps/web/src/host/use-exchange-read-receipts.ts?receipt-registration-contract",
    import.meta.url,
  ).href
)) as typeof import("../apps/web/src/host/use-exchange-read-receipts.js");
const fixedHooks = (await import(
  new URL(
    "./fixtures/exchange-read-receipts-4ce98b64.ts?receipt-registration-contract",
    import.meta.url,
  ).href
)) as typeof import("./fixtures/exchange-read-receipts-4ce98b64.js");
hooks.deregister();
function lane(mode: "fixed" | "production", stored: unknown) {
  const registrations = new Registrations(),
    value = source();
  const ports: unknown[][] = [];
  let writeFails = false;
  const readLocal = <T>(key: string, fallback: T): T => {
    ports.push(["stored", key, fallback]);
    return stored as T;
  };
  const client = {
    get boot() {
      ports.push(["bootstrap"]);
      return value.client.boot;
    },
  };
  const writeLocal = (key: string, seen: ReadReplies) => {
    ports.push(["persist", key, seen]);
    if (writeFails) throw new Error("storage failed");
  };
  const setNotice = (message: string) => {
    ports.push(["notice", message]);
  };
  function render(receipts: ReplyReceipt[]) {
    registrations.begin();
    Reflect.set(globalThis, shimKey, registrations);
    try {
      const state =
        mode === "fixed"
          ? fixedHooks.useFixedReceiptState({ readLocal, client })
          : productionHooks.useExchangeReadReceiptState({
              readStored: () =>
                readLocal<unknown>("conversation-read-receipts", null),
              readBootstrap: () => ({
                messages: client.boot.runtime.messages,
                outputs: client.boot.outputs,
                scriptOutputs: client.boot.scriptOutputs,
              }),
            });
      const acknowledge =
        mode === "fixed"
          ? fixedHooks.useFixedReceiptAcknowledgement(state)
          : productionHooks.useExchangeReadAcknowledgement(state);
      const version = JSON.stringify(receipts);
      if (mode === "fixed")
        fixedHooks.useFixedReceiptCommit({
          ...state,
          receipts,
          receiptVersion: version,
          writeLocal,
          setNotice,
        });
      else
        productionHooks.useExchangeReadReceiptCommit(state, {
          receipts,
          version,
          persist: (seen) => writeLocal("conversation-read-receipts", seen),
          onNotice: setNotice,
        });
      return { ...state, acknowledge };
    } finally {
      Reflect.deleteProperty(globalThis, shimKey);
    }
  }
  return {
    registrations,
    ports,
    value,
    render,
    failWrites() {
      writeFails = true;
    },
  };
}
test("registration contract keeps lazy full-bootstrap initialization, stable acknowledgement and original effect ordering", () => {
  for (const stored of [null, [], { "wrong:key": "bad" }, {}]) {
    const old = lane("fixed", stored),
      next = lane("production", stored);
    const receipts = replyReceipts(
      old.value.replies,
      old.value.client.boot.outputs,
      old.value.client.boot.scriptOutputs,
    );
    const a = old.render(receipts),
      b = next.render(receipts);
    assert.deepEqual(b.seenReplies, a.seenReplies);
    assert.deepEqual(next.ports, old.ports);
    assert.deepEqual(next.registrations.trace, old.registrations.trace);
    if (
      stored !== null &&
      !Array.isArray(stored) &&
      Object.keys(stored).length === 0
    ) {
      assert.equal(b.seenReplies, stored);
      assert.equal(next.ports.length, 1);
    }
    old.registrations.flush();
    next.registrations.flush();
    assert.deepEqual(next.ports, old.ports);
    const aa = old.render(receipts),
      bb = next.render(receipts);
    assert.equal(aa.acknowledge, a.acknowledge);
    assert.equal(bb.acknowledge, b.acknowledge);
    assert.equal(bb.setSeenReplies, b.setSeenReplies);
    assert.equal(next.registrations.pending.length, 0);
    assert.deepEqual(next.registrations.trace, old.registrations.trace);
  }
});
test("ack/reconcile/persistence contract preserves no-op references, publication aliases, new unread prose and notice failure", () => {
  const old = lane("fixed", {}),
    next = lane("production", {});
  const streaming = [
    {
      id: "stream",
      kind: "reply" as const,
      text: "known",
      publicationKey: "publication",
    },
  ];
  const streamReceipts = replyReceipts(streaming, []);
  const a = old.render(streamReceipts),
    b = next.render(streamReceipts);
  old.registrations.flush();
  next.registrations.flush();
  a.acknowledge(streamReceipts);
  b.acknowledge(streamReceipts);
  const seen = next.registrations.slots[0]!.value;
  b.acknowledge(streamReceipts);
  assert.equal(next.registrations.slots[0]!.value, seen);
  // Match the extra no-op invocation in the fixed lane too.
  a.acknowledge(streamReceipts);
  old.render(streamReceipts);
  next.render(streamReceipts);
  old.registrations.flush();
  next.registrations.flush();
  const durable = replyReceipts([{ ...streaming[0]!, id: "durable" }], []);
  old.render(durable);
  next.render(durable);
  old.registrations.flush();
  next.registrations.flush();
  const aa = old.render(durable),
    bb = next.render(durable);
  assert.deepEqual(bb.seenReplies, aa.seenReplies);
  assert.equal(bb.seenReplies["reply:durable"], streamReceipts[0]!.version);
  old.failWrites();
  next.failWrites();
  old.registrations.flush();
  next.registrations.flush();
  assert.deepEqual(next.ports, old.ports);
  assert.deepEqual(next.registrations.trace, old.registrations.trace);
  assert.deepEqual(next.ports.at(-1), [
    "notice",
    "已读状态暂时无法保存，重开后可能再次提示。",
  ]);
  const changed = replyReceipts([{ ...streaming[0]!, text: "new!!" }], []);
  old.render(changed);
  next.render(changed);
  old.registrations.flush();
  next.registrations.flush();
  assert.equal(hasUnreadReplies(bb.seenReplies, changed), true);
  assert.deepEqual(next.registrations.trace, old.registrations.trace);
});
test("real React SSR initializes once from stored state or the entire bootstrap without eager fallback reads", () => {
  for (const stored of [null, { "reply:stored": "reply:6:1" }]) {
    const value = source({ artifactId: "object" }),
      trace: string[] = [];
    let result: ReadReplies | undefined;
    function Fixture() {
      const state = useExchangeReadReceiptState({
        readStored() {
          trace.push("stored");
          return stored;
        },
        readBootstrap() {
          trace.push("bootstrap");
          return {
            messages: value.replies,
            outputs: value.client.boot.outputs,
            scriptOutputs: value.client.boot.scriptOutputs,
          };
        },
      });
      useExchangeReadAcknowledgement(state);
      useExchangeReadReceiptCommit(state, {
        receipts: [],
        version: "[]",
        persist() {
          throw new Error("SSR must not persist");
        },
        onNotice() {
          throw new Error("SSR must not notice");
        },
      });
      result = state.seenReplies;
      return createElement(
        "output",
        null,
        Object.keys(state.seenReplies).length,
      );
    }
    renderToString(createElement(Fixture));
    assert.deepEqual(trace, stored ? ["stored"] : ["stored", "bootstrap"]);
    if (stored) assert.equal(result, stored);
    else
      assert.deepEqual(
        result,
        acknowledgeReplies(
          {},
          replyReceipts(
            value.replies,
            value.client.boot.outputs,
            value.client.boot.scriptOutputs,
          ),
        ),
      );
  }
});
