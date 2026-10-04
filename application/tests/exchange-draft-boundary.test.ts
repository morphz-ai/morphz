import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  isElementAccessExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
  isTryStatement,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type CallExpression,
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from "typescript/unstable/ast";

// Finite ownership/seam contract for the three migrated local records. The
// independently frozen a5278c21 write orders deliberately are NOT transactions.
// This is not general JS purity, all App storage, React update scheduling,
// first-send persistence, permission or visual-equivalence verification.
const oracleText = `
function inputState() {
  const [value, set] = useState<Inputs>(() => storage.readLocal(draftKey("inputs"), {}));
  return { value, set };
}
function conversationState() {
  const [value, set] = useState<Conversations>(() => storage.readLocal(draftKey("conversations"), {}));
  const ref = useRef(value);
  ref.current = value;
  return { value, set, ref };
}
function discardedState() {
  const [value, set] = useState<Discarded>(() => storage.readLocal(draftKey("discarded-conversations"), {}));
  return { value, set };
}
function returnedCommands() {
  return { writeInputs, createConversation, retireCommittedConversations, discardConversation, restoreConversation };
}
function storagePorts() { return { readLocal, writeLocal }; }
function writer() {
  inputs.set((previous) => {
    const next = update(previous);
    try { storage.writeLocal(draftKey("inputs"), next); }
    catch { onNotice("本地草稿保存失败，请不要刷新页面。"); }
    return next;
  });
}
function create() {
  let pending = conversations.ref.current[projectId];
  if (!pending) {
    pending = { id: crypto.randomUUID(), projectId, title, inputId: crypto.randomUUID() };
    const next = { ...conversations.ref.current, [projectId]: pending };
    storage.writeLocal(draftKey("conversations"), next);
    conversations.ref.current = next;
    conversations.set(next);
  }
  return pending;
}
function reconcile() {
  const next = { ...conversations.ref.current };
  let changed = false;
  for (const [projectId, entry] of Object.entries(next)) {
    if (persisted?.some((conversation) => conversation.id === entry.id)) {
      delete next[projectId]; changed = true;
    }
  }
  if (changed) {
    conversations.ref.current = next;
    conversations.set(next);
    storage.writeLocal(draftKey("conversations"), next);
  }
}
function discardCommit() {
  try {
    storage.writeLocal(draftKey("discarded-conversations"), trash);
    storage.writeLocal(draftKey("inputs"), remainingInputs);
    storage.writeLocal(draftKey("conversations"), remaining);
    discarded.set(trash); inputs.set(remainingInputs); conversations.set(remaining);
    conversations.ref.current = remaining;
    onDiscarded(conversation);
  } catch { onNotice("草稿整理未完成，原文仍保留，请重试。"); }
}
function restoreCommit() {
  try {
    storage.writeLocal(draftKey("inputs"), nextInputs);
    storage.writeLocal(draftKey("conversations"), next);
    storage.writeLocal(draftKey("discarded-conversations"), trash);
    inputs.set(nextInputs); conversations.set(next); conversations.ref.current = next;
    discarded.set(trash);
    onRestored(saved.conversation);
  } catch { onNotice("草稿恢复失败，保存的原文仍在，请重试。"); }
}
function discardSnapshots() {
  const conversation = Object.values(conversations.value).find((entry) => entry.id === id) ?? readPersisted();
}
function restoreSnapshots() {
  const saved = discarded.value[id];
  const pending = conversations.value[saved.conversation.projectId];
  const nextInputs = { ...inputs.value, ...saved.drafts },
    next = { ...conversations.value, [saved.conversation.projectId]: saved.conversation },
    trash = { ...discarded.value };
}
function appSeams() {
  const { readLocal, writeLocal } = useState(() => scopedStorage())[0];
  const drafts = inputDraftState.value;
  const conversationDrafts = conversationDraftState.value;
  const discardedDrafts = discardedDraftState.value;
  const { writeInputs: writeDrafts } = draftCommands;
  const ports = { inputs: inputDraftState, conversations: conversationDraftState,
    discarded: discardedDraftState, storage: { readLocal, writeLocal }, onNotice: setNotice };
  useEffect(() => { draftCommands.retireCommittedConversations(state?.conversations); }, [state?.conversations]);
  const hasConversationDraft = (id: string) =>
    state?.inputs.some((input) => discussionId(input) === id && client.boot?.localSavedInputIds.includes(input.id)) ||
    Object.entries(drafts).some(([key, value]) => key.startsWith(id + ":") && !!(
      value.body.trim() || value.attachments?.length || value.textQuotes?.length || value.selection || value.intent));
}
function currentStorageSeam() { const { readLocal, writeLocal } = host.storage; }
function privateOriginGuard() { if (!origin.isActive()) return; }
function setDraft(key: string, value: InputDraft) {
  if (key === currentContext.current && value.body !== drafts[key]?.body) dictationControls.current?.interrupt();
  writeDrafts((previous) => replaceComposerSurface(previous, key, emptyDraft, value));
}
function updateDraft(key: string, update: (value: InputDraft) => InputDraft, initial: InputDraft = emptyDraft) {
  writeDrafts((previous) => updateComposerDraft(previous, key, emptyDraft, update, initial));
}
async function createProjectConversation(workspaceId: string, title: string) {
  const pending = draftCommands.createConversation(workspaceId, title);
  selectConversation(workspaceId, pending.id, true);
}
function discardConversationDraft(id: string) {
  if (sendPending.current) { setNotice("消息正在提交，请等待结果后整理草稿。"); return; }
  draftCommands.discardConversation(id, () => state?.conversations.find((c) => c.id === id),
    (conversation) => { if (conversationId === id) openProject(conversation.projectId); });
}
function restoreConversationDraft(id: string) {
  draftCommands.restoreConversation(id, hasConversationDraft,
    (conversation) => { selectConversation(conversation.projectId, id, true); });
}
`;
type Parsed = { source: SourceFile; symbols: Map<Node, number> };
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>): Map<string, Parsed> {
  const directory = "/exchange-draft-boundary-fixtures";
  const config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, value]) => [
      `${directory}/${name}`,
      value,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!;
      assert.deepEqual(
        project.program.getSyntacticDiagnostics(),
        [],
        "Fixtures must parse",
      );
      return new Map(
        Object.keys(contents).map((name) => {
          const source = project.program.getSourceFile(`${directory}/${name}`)!;
          const names: Identifier[] = [];
          walk(source, (node) => {
            if (isIdentifier(node)) names.push(node);
          });
          const resolved = project.checker.getSymbolAtLocation(names);
          const symbols = new Map<Node, number>();
          names.forEach((node, index) => {
            if (resolved[index]) symbols.set(node, resolved[index]!.id);
          });
          return [name, { source, symbols }];
        }),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
function functions(node: Node, name?: string): FunctionDeclaration[] {
  const found: FunctionDeclaration[] = [];
  walk(node, (child) => {
    if (isFunctionDeclaration(child) && (!name || child.name?.text === name))
      found.push(child);
  });
  return found;
}
function declarations(node: Node, name: string): VariableDeclaration[] {
  const found: VariableDeclaration[] = [];
  walk(node, (child) => {
    if (!isVariableDeclaration(child)) return;
    let named = false;
    walk(child.name, (leaf) => {
      if (isIdentifier(leaf) && leaf.text === name) named = true;
    });
    if (named) found.push(child);
  });
  return found;
}
function calls(node: Node, expression: string): CallExpression[] {
  const found: CallExpression[] = [];
  walk(node, (child) => {
    if (isCallExpression(child) && child.expression.getText() === expression)
      found.push(child);
  });
  return found;
}
function syntax(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(syntax(child));
  });
  return [node.kind, children.length ? children : node.getText()];
}
function same(left: Node | undefined, right: Node | undefined) {
  return (
    !!left &&
    !!right &&
    JSON.stringify(syntax(left)) === JSON.stringify(syntax(right))
  );
}
const oracle = parse({ "oracle.ts": oracleText }).get("oracle.ts")!.source;
const body = (name: string) => functions(oracle, name)[0]!.body!;
const declaration = (name: string) => declarations(body("appSeams"), name)[0]!;
const currentStorage = declarations(
  body("currentStorageSeam"),
  "readLocal",
)[0]!;
const ports = body("storagePorts").statements[0]!;
assert.ok(isReturnStatement(ports));
const storagePorts = isReturnStatement(ports) ? ports.expression : undefined;
const keys = new Set(["inputs", "conversations", "discarded-conversations"]);
function ownership(ownerText: string, appText: string): string[] {
  const parsed = parse({ "owner.ts": ownerText, "App.tsx": appText });
  const { source: owner } = parsed.get("owner.ts")!;
  const app = parsed.get("App.tsx")!;
  const problems = new Set<string>();
  const check = (valid: boolean, rule: string) => {
    if (!valid) problems.add(rule);
  };
  const runtime = new Map([
    ["react", new Set(["useState", "useRef"])],
    ["../local-preferences.js", new Set(["draftKey"])],
  ]);
  const types = new Set([
    ...runtime.keys(),
    ...[
      "model",
      "continuation",
      "input-intent",
      "inference",
      "reader",
      "script-studio",
      "text-quotes",
    ].map((name) => `../../../../packages/core/src/${name}.js`),
  ]);
  for (const statement of owner.statements) {
    check(
      isImportDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isFunctionDeclaration(statement),
      "no-module-store-or-construction-effects",
    );
    if (!isImportDeclaration(statement)) continue;
    const path = isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : "";
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    check(
      !!clause && !clause.name && !!bindings && isNamedImports(bindings),
      "explicit-scoped-owner-dependencies",
    );
    if (bindings && isNamedImports(bindings))
      for (const entry of bindings.elements) {
        const typeOnly =
          clause?.phaseModifier === SyntaxKind.TypeKeyword || entry.isTypeOnly;
        check(
          typeOnly
            ? types.has(path)
            : !!runtime.get(path)?.has((entry.propertyName ?? entry.name).text),
          "no-runtime-feature-transport-navigation-dependency",
        );
      }
  }
  const fn = (name: string) => functions(owner, name)[0];
  const hookNames = [
    "useExchangeInputDraftState",
    "useExchangeConversationDraftState",
    "useExchangeDiscardedDraftState",
  ];
  for (const [index, name] of hookNames.entries()) {
    check(
      functions(owner, name).length === 1 &&
        same(
          fn(name)?.body,
          body(["inputState", "conversationState", "discardedState"][index]!),
        ),
      "three-original-effect-free-state-initializers-and-ref",
    );
  }
  check(
    calls(owner, "useState").length === 3 &&
      calls(owner, "useRef").length === 1,
    "no-second-draft-state-or-latest-ref",
  );
  const factory = fn("createExchangeDraftCommands");
  const commandNames = [
    "writeInputs",
    "createConversation",
    "retireCommittedConversations",
    "discardConversation",
    "restoreConversation",
  ];
  const statements = factory?.body?.statements;
  check(
    functions(owner).length === 9 &&
      !!statements &&
      statements.length === 6 &&
      statements.slice(0, 5).every(isFunctionDeclaration) &&
      statements
        .slice(0, 5)
        .filter(isFunctionDeclaration)
        .map((entry) => entry.name?.text)
        .join(",") === commandNames.join(",") &&
      isReturnStatement(statements[5]!) &&
      same(statements[5], body("returnedCommands").statements[0]),
    "five-local-commands-no-hooks-or-factory-construction-work",
  );
  // Exact AST statement oracles protect unusual original publication/failure
  // boundaries; pure trace tests independently exercise every partial write.
  check(
    same(fn("writeInputs")?.body, body("writer")),
    "functional-input-writer-publishes-even-after-storage-failure",
  );
  check(
    same(fn("createConversation")?.body, body("create")),
    "create-current-ref-persist-ref-state-stable-ids",
  );
  check(
    same(fn("retireCommittedConversations")?.body, body("reconcile")),
    "retire-authoritative-collection-ref-state-persist-no-catch",
  );
  for (const [name, expected] of [
    ["discardConversation", "discardCommit"],
    ["restoreConversation", "restoreCommit"],
  ]) {
    const commits = fn(name!)?.body?.statements.filter(isTryStatement) ?? [];
    check(
      commits.length === 1 &&
        same(commits[0], body(expected!).statements[0]) &&
        commits[0] === fn(name!)?.body?.statements.at(-1),
      "partial-writes-then-publication-navigation-inside-catch-boundary",
    );
  }
  const discard = fn("discardConversation");
  check(
    same(
      declarations(discard!, "conversation")[0]?.initializer,
      declarations(body("discardSnapshots"), "conversation")[0]?.initializer,
    ),
    "discard-render-snapshot-and-lazy-persisted-fallback",
  );
  const restore = fn("restoreConversation");
  for (const name of ["saved", "pending", "nextInputs", "next", "trash"]) {
    check(
      same(
        declarations(restore!, name)[0]?.initializer,
        declarations(body("restoreSnapshots"), name)[0]?.initializer,
      ),
      "restore-render-snapshots-saved-inputs-win",
    );
  }
  walk(owner, (node) => {
    if (isIdentifier(node))
      check(
        ![
          "document",
          "window",
          "navigator",
          "globalThis",
          "localStorage",
          "sessionStorage",
        ].includes(node.text),
        "local-owner-does-not-read-dom-or-unscoped-storage",
      );
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= SyntaxKind.LastAssignment
    )
      check(
        [
          "pending",
          "changed",
          "ref.current",
          "conversations.ref.current",
        ].includes(node.left.getText()),
        "only-original-local-ref-mutation",
      );
    check(
      node.kind !== SyntaxKind.NewExpression,
      "no-new-service-or-global-store",
    );
    if (isCallExpression(node)) {
      const allowed = new Set([
        "useState",
        "useRef",
        "storage.readLocal",
        "storage.writeLocal",
        "draftKey",
        "inputs.set",
        "conversations.set",
        "discarded.set",
        "update",
        "onNotice",
        "crypto.randomUUID",
        "Object.entries",
        "Object.values",
        "Object.fromEntries",
        "persisted?.some",
        "key.startsWith",
        "readPersisted",
        "hasConversationDraft",
        "onDiscarded",
        "onRestored",
      ]);
      const expression = node.expression.getText();
      check(
        allowed.has(expression) ||
          expression.endsWith(").find") ||
          expression.endsWith(").filter"),
        "owner-has-no-unreviewed-execution-or-effects",
      );
      const key = node.arguments[0];
      if (expression === "draftKey")
        check(
          node.arguments.length === 1 &&
            !!key &&
            isStringLiteral(key) &&
            keys.has(key.text),
          "original-three-storage-keys-only",
        );
    }
  });
  const workspace = functions(app.source, "WorkspaceApp")[0];
  check(!!workspace?.body, "one-host-workspace");
  if (!workspace?.body) return [...problems];
  const imported = new Map<string, number>();
  for (const statement of app.source.statements) {
    if (
      isImportDeclaration(statement) &&
      isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./host/exchange-drafts.js" &&
      statement.importClause?.namedBindings &&
      isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const entry of statement.importClause.namedBindings.elements) {
        if (
          entry.isTypeOnly ||
          statement.importClause.phaseModifier === SyntaxKind.TypeKeyword
        )
          continue;
        const symbol = app.symbols.get(entry.name);
        if (symbol !== undefined)
          imported.set((entry.propertyName ?? entry.name).text, symbol);
      }
    }
  }
  function importedCalls(name: string) {
    const found: CallExpression[] = [];
    walk(app.source, (node) => {
      if (
        isCallExpression(node) &&
        isIdentifier(node.expression) &&
        imported.has(name) &&
        app.symbols.get(node.expression) === imported.get(name)
      )
        found.push(node);
    });
    return found;
  }
  const stateVariables = [
    "inputDraftState",
    "conversationDraftState",
    "discardedDraftState",
  ];
  for (const [index, name] of hookNames.entries()) {
    const entries = importedCalls(name);
    const variable = declarations(workspace, stateVariables[index]!);
    check(
      entries.length === 1 &&
        variable.length === 1 &&
        variable[0]?.initializer === entries[0] &&
        entries[0]!.arguments.length === 1 &&
        same(entries[0]?.arguments[0], storagePorts),
      "one-real-imported-state-hook-with-original-scoped-storage",
    );
  }
  const factoryEntries = importedCalls("createExchangeDraftCommands");
  check(
    factoryEntries.length === 1 &&
      declarations(workspace, "draftCommands")[0]?.initializer ===
        factoryEntries[0] &&
      same(factoryEntries[0]?.arguments[0], declaration("ports").initializer),
    "one-render-local-command-owner-no-setter-bag",
  );
  for (const name of [
    "readLocal",
    "drafts",
    "conversationDrafts",
    "discardedDrafts",
    "writeDrafts",
  ]) {
    const found = declarations(workspace, name);
    check(
      found.length === 1 &&
        same(
          found[0],
          name === "readLocal" ? currentStorage : declaration(name),
        ),
      "original-storage-capture-read-aliases-and-single-functional-writer",
    );
  }
  const ordered = [
    "sending",
    "inputDraftState",
    "conversationDraftState",
    "projectAction",
    "projectDirectoryVersion",
    "discardedDraftState",
    "sendPending",
    "quoteReveal",
    "draftCommands",
    "startedConversations",
    "projectMetrics",
    "workSurface",
  ];
  const positions = ordered.map(
    (name) => declarations(workspace, name)[0]?.pos ?? -1,
  );
  check(
    positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > positions[index - 1]!),
    ),
    "state-hooks-retain-original-init-slots-before-unique-surface",
  );
  const stableState = declarations(workspace, "navigation");
  check(
    stableState.length === 1 &&
      stableState[0]!.initializer?.getText() === "host" &&
      stableState[0]!.pos < positions[0]!,
    "stable-navigation-before-private-drafts-not-a-second-owner",
  );
  check(
    calls(workspace, "deriveWorkSurface").length === 1,
    "one-work-surface-not-another-draft-resolver",
  );
  const effects = calls(workspace, "useEffect").filter(
    (effect) =>
      calls(effect, "draftCommands.retireCommittedConversations").length > 0,
  );
  const expectedEffect = calls(body("appSeams"), "useEffect")[0];
  check(
    effects.length === 1 &&
      calls(workspace, "draftCommands.retireCommittedConversations").length ===
        1 &&
      same(effects[0], expectedEffect) &&
      effects[0]!.pos > positions[9]! &&
      effects[0]!.pos < positions[10]!,
    "retirement-effect-original-position-dependencies-authority",
  );
  for (const name of [
    "setDraft",
    "updateDraft",
    "createProjectConversation",
    "discardConversationDraft",
    "restoreConversationDraft",
  ]) {
    const target = functions(workspace, name);
    const expected = functions(oracle, name)[0];
    const guarded = name === "setDraft" || name === "updateDraft";
    const actual = target[0];
    const originalBody = expected?.body;
    const guard = body("privateOriginGuard").statements[0];
    check(
      target.length === 1 &&
        !!actual?.body &&
        !!originalBody &&
        (guarded
          ? same(actual.body.statements[0], guard) &&
            actual.body.statements.length ===
              originalBody.statements.length + 1 &&
            actual.body.statements
              .slice(1)
              .every((node, index) =>
                same(node, originalBody.statements[index]),
              ) &&
            JSON.stringify(actual.parameters.map(syntax)) ===
              JSON.stringify(expected!.parameters.map(syntax))
          : same(actual, expected)),
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    );
  }
  check(
    same(
      declarations(workspace, "hasConversationDraft")[0],
      declaration("hasConversationDraft"),
    ),
    "real-local-input-and-composer-content-restore-guard",
  );
  walk(workspace, (node) => {
    if (isIdentifier(node))
      check(
        ![
          "setDrafts",
          "setConversationDrafts",
          "setDiscardedDrafts",
          "conversationDraftsRef",
        ].includes(node.text),
        "no-second-host-draft-writer-ref",
      );
    if (isArrayBindingPattern(node))
      for (const element of node.elements) {
        if (
          isBindingElement(element) &&
          element.name &&
          isIdentifier(element.name)
        )
          check(
            !["drafts", "conversationDrafts", "discardedDrafts"].includes(
              element.name.text,
            ),
            "no-second-host-draft-state",
          );
      }
    if (isCallExpression(node)) {
      check(
        !stateVariables.some(
          (name) => node.expression.getText() === `${name}.set`,
        ),
        "host-cannot-bypass-draft-commands",
      );
      const key = node.arguments[0];
      if (
        node.expression.getText() === "draftKey" &&
        key &&
        isStringLiteral(key)
      )
        check(!keys.has(key.text), "migrated-key-storage-only-in-owner");
    }
    if (
      (isPropertyAccessExpression(node) || isElementAccessExpression(node)) &&
      isIdentifier(node.expression) &&
      stateVariables.includes(node.expression.text)
    ) {
      const member = isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : "<computed>";
      check(member === "value", "host-cannot-bypass-draft-commands");
    }
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= SyntaxKind.LastAssignment
    ) {
      check(
        ![
          "drafts",
          "conversationDrafts",
          "discardedDrafts",
          ...stateVariables,
          "draftCommands",
        ].some(
          (name) =>
            node.left.getText() === name ||
            node.left.getText().startsWith(`${name}.`) ||
            node.left.getText().startsWith(`${name}[`),
        ),
        "host-cannot-mutate-owned-records",
      );
    }
  });
  return [...problems];
}
const owner = readFileSync(
  new URL("../apps/web/src/host/exchange-drafts.ts", import.meta.url),
  "utf8",
);
const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
function changed(source: string, before: string, after: string) {
  assert.equal(
    source.split(before).length - 1,
    1,
    `Counterfactual must change exactly one seam: ${before}`,
  );
  return source.replace(before, after);
}
function rejected(ownerText: string, appText: string, rule: string) {
  assert.ok(
    ownership(ownerText, appText).includes(rule),
    `Counterfactual must violate ${rule}`,
  );
}
test("exchange drafts have one local owner and original Host lifecycle seams", () => {
  assert.deepEqual(ownership(owner, app), []);
});
test("draft gate rejects unreviewed dependencies, eager construction, effects and replacement keys", () => {
  for (const [candidate, rule] of [
    [
      owner + '\nimport { client } from "../client.js";',
      "no-runtime-feature-transport-navigation-dependency",
    ],
    [
      owner + "\nconst shared = new Map();",
      "no-module-store-or-construction-effects",
    ],
    [
      changed(
        owner,
        "  function writeInputs(",
        '  storage.writeLocal(draftKey("inputs"), {});\n  function writeInputs(',
      ),
      "five-local-commands-no-hooks-or-factory-construction-work",
    ],
    [
      changed(
        owner,
        '    storage.readLocal(draftKey("inputs"), {}),\n  );',
        '    storage.readLocal(draftKey("inputs"), {}),\n  );\n  useEffect(() => storage.writeLocal(draftKey("inputs"), value), [value]);',
      ),
      "three-original-effect-free-state-initializers-and-ref",
    ],
    [
      changed(
        owner,
        'storage.readLocal(draftKey("inputs"), {})',
        'storage.readLocal(draftKey("new-inputs"), {})',
      ),
      "original-three-storage-keys-only",
    ],
    [
      changed(
        owner,
        "  const ref = useRef(value);",
        "  const ref = useRef(value); const latestRef = useRef(value);",
      ),
      "no-second-draft-state-or-latest-ref",
    ],
    [
      changed(
        owner,
        "      onRestored(saved.conversation);",
        '      globalThis["fetch"]("/input"); onRestored(saved.conversation);',
      ),
      "owner-has-no-unreviewed-execution-or-effects",
    ],
  ])
    rejected(candidate!, app, rule!);
});
test("draft gate rejects altered publication failure and snapshot boundaries", () => {
  for (const [before, after, rule] of [
    [
      "      return next;",
      "      return previous;",
      "functional-input-writer-publishes-even-after-storage-failure",
    ],
    [
      "    let pending = conversations.ref.current[projectId];",
      "    let pending = conversations.value[projectId];",
      "create-current-ref-persist-ref-state-stable-ids",
    ],
    [
      "      conversations.set(next);\n      storage.writeLocal",
      "      storage.writeLocal",
      "retire-authoritative-collection-ref-state-persist-no-catch",
    ],
    [
      "Object.values(conversations.value)",
      "Object.values(conversations.ref.current)",
      "discard-render-snapshot-and-lazy-persisted-fallback",
    ],
    [
      "      readPersisted();",
      "      readPersisted;",
      "discard-render-snapshot-and-lazy-persisted-fallback",
    ],
    [
      "{ ...inputs.value, ...saved.drafts }",
      "{ ...saved.drafts, ...inputs.value }",
      "restore-render-snapshots-saved-inputs-win",
    ],
    [
      '      storage.writeLocal(draftKey("discarded-conversations"), trash);\n      storage.writeLocal(draftKey("inputs"), remainingInputs);',
      '      storage.writeLocal(draftKey("inputs"), remainingInputs);\n      storage.writeLocal(draftKey("discarded-conversations"), trash);',
      "partial-writes-then-publication-navigation-inside-catch-boundary",
    ],
    [
      "      onRestored(saved.conversation);",
      "",
      "partial-writes-then-publication-navigation-inside-catch-boundary",
    ],
  ])
    rejected(changed(owner, before!, after!), app, rule!);
  rejected(
    changed(
      owner,
      '      onNotice("草稿恢复失败，保存的原文仍在，请重试。");\n    }',
      '      onNotice("草稿恢复失败，保存的原文仍在，请重试。");\n    }\n    onRestored(saved.conversation);',
    ),
    app,
    "partial-writes-then-publication-navigation-inside-catch-boundary",
  );
});
test("draft gate rejects fake imports, duplicate owners, moved hooks and retirement effects", () => {
  for (const [before, after, rule] of [
    [
      "const inputDraftState = useExchangeInputDraftState",
      "const useExchangeInputDraftState = () => ({}); const inputDraftState = useExchangeInputDraftState",
      "one-real-imported-state-hook-with-original-scoped-storage",
    ],
    [
      "  const drafts = inputDraftState.value;",
      "  const drafts = inputDraftState.value; inputDraftState.set({});",
      "host-cannot-bypass-draft-commands",
    ],
    [
      "  const drafts = inputDraftState.value;",
      '  const drafts = inputDraftState.value; const replace = inputDraftState["set"]; replace({});',
      "host-cannot-bypass-draft-commands",
    ],
    [
      "  const conversationDrafts = conversationDraftState.value;",
      "  const conversationDrafts = conversationDraftState.value; const conversationDraftsRef = useRef(conversationDrafts);",
      "no-second-host-draft-writer-ref",
    ],
    [
      "  const draftCommands = createExchangeDraftCommands({",
      "  const createExchangeDraftCommands = () => ({}); const draftCommands = createExchangeDraftCommands({",
      "one-render-local-command-owner-no-setter-bag",
    ],
    [
      "  const drafts = inputDraftState.value;",
      "  const [drafts, replaceDrafts] = useState({});",
      "no-second-host-draft-state",
    ],
    [
      "  }, [state?.conversations]);",
      "  }, [state?.conversations, conversationDrafts]);",
      "retirement-effect-original-position-dependencies-authority",
    ],
    [
      "draftCommands.retireCommittedConversations(state?.conversations);",
      "draftCommands.retireCommittedConversations(client.boot?.runtime.messages);",
      "retirement-effect-original-position-dependencies-authority",
    ],
    [
      "  const drafts = inputDraftState.value;",
      '  const drafts = inputDraftState.value; drafts["other"] = emptyDraft;',
      "host-cannot-mutate-owned-records",
    ],
    [
      "  const drafts = inputDraftState.value;",
      '  const drafts = inputDraftState.value; writeLocal(draftKey("inputs"), {});',
      "migrated-key-storage-only-in-owner",
    ],
  ])
    rejected(owner, changed(app, before!, after!), rule!);
  const hook =
    "  const inputDraftState = useExchangeInputDraftState({ readLocal, writeLocal });";
  const moved = changed(
    changed(app, hook, ""),
    "  const projectMetrics = useMemo",
    `${hook}\n  const projectMetrics = useMemo`,
  );
  rejected(
    owner,
    moved,
    "state-hooks-retain-original-init-slots-before-unique-surface",
  );
  const retirement =
    "  useEffect(() => {\n    draftCommands.retireCommittedConversations(state?.conversations);\n  }, [state?.conversations]);";
  rejected(
    owner,
    changed(
      changed(app, retirement, ""),
      "  const personalSpace =",
      `${retirement}\n  const personalSpace =`,
    ),
    "retirement-effect-original-position-dependencies-authority",
  );
});
test("draft gate rejects shell guard, async, dictation and navigation seam drift", () => {
  for (const [before, after] of [
    [
      "  async function createProjectConversation",
      "  function createProjectConversation",
    ],
    ["    if (sendPending.current) {", "    if (false) {"],
    [
      "      () => state?.conversations.find((c) => c.id === id),",
      "      state?.conversations.find((c) => c.id === id),",
    ],
    ["      hasConversationDraft,", "      () => false,"],
    [
      "if (conversationId === id) openProject(conversation.projectId);",
      "openProject(conversation.projectId);",
    ],
    ["value.body !== drafts[key]?.body", "value.body !== draft.body"],
    [
      "      replaceComposerSurface(previous, key, emptyDraft, value),",
      "      replaceComposerSurface(previous, contextKey, emptyDraft, value),",
    ],
  ])
    rejected(
      owner,
      changed(app, before!, after!),
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    );
  rejected(
    owner,
    changed(
      app,
      "          value.intent",
      "          value.intent || value.model",
    ),
    "real-local-input-and-composer-content-restore-guard",
  );
});
test("retired private draft entry guard is mandatory, before original dictation/updater code, not a replacement of that original code", () => {
  for (const name of ["setDraft", "updateDraft"]) {
    const actual = functions(
      parse({ "App.tsx": app }).get("App.tsx")!.source,
      name,
    )[0]!;
    const guard = actual.body!.statements[0]!.getText();
    for (const replacement of [
      "",
      "if (origin.isActive()) return;",
      "if (!origin.isActive()) { writeDrafts(() => ({})); return; }",
    ])
      rejected(
        owner,
        changed(
          app,
          actual.getText(),
          actual.getText().replace(guard, replacement),
        ),
        "host-guards-dictation-async-shell-navigation-seams-unchanged",
      );
  }
  rejected(
    owner,
    changed(
      app,
      "const { readLocal, writeLocal } = host.storage;",
      "const { readLocal, writeLocal } = useState(() => scopedStorage())[0];",
    ),
    "original-storage-capture-read-aliases-and-single-functional-writer",
  );
});
test("draft gate permits formatting and unrelated local UI/storage owners", () => {
  assert.deepEqual(
    ownership(
      owner.replaceAll("  ", "    "),
      changed(
        app,
        "  const drafts = inputDraftState.value;",
        "  const unrelated = useState(false); const drafts = inputDraftState.value;",
      ),
    ),
    [],
  );
});
