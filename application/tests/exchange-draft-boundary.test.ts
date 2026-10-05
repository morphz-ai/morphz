import test, { default as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  historicalWorkspaceDraftApp,
  historicalDraftPrivateInverse,
  workspaceDraftGovernanceHistory,
} from "./fixtures/workspace-draft-governance-history.js";
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
  isExpressionStatement,
  isObjectLiteralExpression,
  isObjectBindingPattern,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isPrefixUnaryExpression,
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
  // A prefix operator is a scalar, not a forEachChild child. Preserve it so
  // the private origin guard and the original pending test cannot invert.
  return [
    node.kind,
    isPrefixUnaryExpression(node) ? node.operator : undefined,
    children.length ? children : node.getText(),
  ];
}
function signature(node: FunctionDeclaration): unknown {
  return [
    node.kind,
    node.modifiers?.map(syntax),
    node.asteriskToken?.kind,
    node.name && syntax(node.name),
    node.typeParameters?.map(syntax),
    node.parameters.map(syntax),
    node.type && syntax(node.type),
  ];
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
            JSON.stringify(signature(actual)) ===
              JSON.stringify(signature(expected!))
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
const privateOwner = readFileSync(
  new URL(
    "../apps/web/src/host/private-project-conversation-scope.ts",
    import.meta.url,
  ),
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
function registerHistoricalDraftCounterfactuals() {
  const owner = workspaceDraftGovernanceHistory.sources.draftOwner!.raw;
  const app = historicalDraftPrivateInverse(historicalWorkspaceDraftApp);
  const test = (title: string, callback: () => void) =>
    nodeTest("historical " + title, callback);
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
  for (const [label, side, name, before, after, rule] of [
    [
      "setDraft prefix operator",
      "app",
      "setDraft",
      "if (!origin.isActive()) return;",
      "if (+origin.isActive()) return;",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "updateDraft prefix operator",
      "app",
      "updateDraft",
      "if (!origin.isActive()) return;",
      "if (+origin.isActive()) return;",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "setDraft async declaration",
      "app",
      "setDraft",
      "function setDraft(",
      "async function setDraft(",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "updateDraft async declaration",
      "app",
      "updateDraft",
      "function updateDraft(",
      "async function updateDraft(",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "setDraft generator declaration",
      "app",
      "setDraft",
      "function setDraft(",
      "function* setDraft(",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "createConversation prefix operator",
      "owner",
      "createConversation",
      "if (!pending)",
      "if (+pending)",
      "create-current-ref-persist-ref-state-stable-ids",
    ],
  ] as const)
    test(`draft gate rejects parsed ${label} counterfactual`, () => {
      const source = side === "app" ? app : owner;
      const filename = side === "app" ? "App.tsx" : "owner.ts";
      const parsed = parse({ [filename]: source }).get(filename)!;
      const targets = functions(parsed.source, name);
      assert.equal(
        targets.length,
        1,
        "Counterfactual has one actual function target",
      );
      const original = targets[0]!.getText(parsed.source);
      const candidate = changed(
        source,
        original,
        changed(original, before, after),
      );
      parse({ [filename]: candidate });
      rejected(
        side === "owner" ? candidate : owner,
        side === "app" ? candidate : app,
        rule,
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
}
registerHistoricalDraftCounterfactuals();

// Current-only source contract. It reads actual registrations/borrowers, never
// restores App inline effects or runs a Private/Human/Object/Reference inverse.
// Dependency/alias resolution is bounded to the draft recipes consumed below;
// unrelated complete React features and pure module exports may evolve.
function parseCurrentDraft(
  contents: Record<string, string>,
): Map<string, Parsed> {
  const directory = "/current-exchange-draft-boundary-fixtures";
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
          walk(source, (node) => {
            if (isShorthandPropertyAssignment(node)) {
              const value =
                project.checker.getShorthandAssignmentValueSymbol(node);
              if (value) symbols.set(node.name, value.id);
            }
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
// Independently captured actual Git e464367d five owned command recipes.
// This finite oracle does not freeze the module, unrelated exports or App.
const originalDraftCommands =
  '  function writeInputs(update: (previous: Inputs) => Inputs) {\n    inputs.set((previous) => {\n      const next = update(previous);\n      try {\n        storage.writeLocal(draftKey("inputs"), next);\n      } catch {\n        onNotice("本地草稿保存失败，请不要刷新页面。");\n      }\n      return next;\n    });\n  }\n  function createConversation(projectId: string, title: string) {\n    let pending = conversations.ref.current[projectId];\n    if (!pending) {\n      pending = {\n        id: crypto.randomUUID(),\n        projectId,\n        title,\n        inputId: crypto.randomUUID(),\n      };\n      const next = { ...conversations.ref.current, [projectId]: pending };\n      storage.writeLocal(draftKey("conversations"), next);\n      conversations.ref.current = next;\n      conversations.set(next);\n    }\n    return pending;\n  }\n  function retireCommittedConversations(persisted?: readonly Discussion[]) {\n    // A local bubble is not a Session. Only the authoritative conversation\n    // collection retires its corresponding unfinished named draft.\n    const next = { ...conversations.ref.current };\n    let changed = false;\n    for (const [projectId, entry] of Object.entries(next)) {\n      if (persisted?.some((conversation) => conversation.id === entry.id)) {\n        delete next[projectId];\n        changed = true;\n      }\n    }\n    if (changed) {\n      conversations.ref.current = next;\n      conversations.set(next);\n      storage.writeLocal(draftKey("conversations"), next);\n    }\n  }\n  function discardConversation(\n    id: string,\n    readPersisted: () => Discussion | undefined,\n    onDiscarded: (conversation: ConversationDraft | Discussion) => void,\n  ) {\n    const conversation =\n      Object.values(conversations.value).find((entry) => entry.id === id) ??\n      readPersisted();\n    if (!conversation) return;\n    const trash = {\n      ...discarded.value,\n      [id]: {\n        conversation: {\n          ...conversation,\n          inputId:\n            "inputId" in conversation\n              ? conversation.inputId\n              : crypto.randomUUID(),\n        },\n        drafts: Object.fromEntries(\n          Object.entries(inputs.value).filter(([key]) =>\n            key.startsWith(id + ":"),\n          ),\n        ),\n      },\n    };\n    const remaining = { ...conversations.value };\n    if (remaining[conversation.projectId]?.id === id)\n      delete remaining[conversation.projectId];\n    const remainingInputs = Object.fromEntries(\n      Object.entries(inputs.value).filter(([key]) => !key.startsWith(id + ":")),\n    );\n    try {\n      storage.writeLocal(draftKey("discarded-conversations"), trash);\n      storage.writeLocal(draftKey("inputs"), remainingInputs);\n      storage.writeLocal(draftKey("conversations"), remaining);\n      discarded.set(trash);\n      inputs.set(remainingInputs);\n      conversations.set(remaining);\n      conversations.ref.current = remaining;\n      onDiscarded(conversation);\n    } catch {\n      onNotice("草稿整理未完成，原文仍保留，请重试。");\n    }\n  }\n  function restoreConversation(\n    id: string,\n    hasConversationDraft: (id: string) => boolean | undefined,\n    onRestored: (conversation: ConversationDraft) => void,\n  ) {\n    const saved = discarded.value[id];\n    if (!saved) return;\n    const pending = conversations.value[saved.conversation.projectId];\n    if (pending && pending.id !== id && hasConversationDraft(pending.id)) {\n      onNotice("请先发送或丢弃当前项目的新草稿，再恢复这份草稿。");\n      return;\n    }\n    const nextInputs = { ...inputs.value, ...saved.drafts },\n      next = {\n        ...conversations.value,\n        [saved.conversation.projectId]: saved.conversation,\n      },\n      trash = { ...discarded.value };\n    delete trash[id];\n    try {\n      storage.writeLocal(draftKey("inputs"), nextInputs);\n      storage.writeLocal(draftKey("conversations"), next);\n      storage.writeLocal(draftKey("discarded-conversations"), trash);\n      inputs.set(nextInputs);\n      conversations.set(next);\n      conversations.ref.current = next;\n      discarded.set(trash);\n      onRestored(saved.conversation);\n    } catch {\n      onNotice("草稿恢复失败，保存的原文仍在，请重试。");\n    }\n  }';
const originalDraftCommandsSource = parse({
  "commands.ts": originalDraftCommands,
}).get("commands.ts")!.source;
const cognitiveWriterAdapter = parse({
  "adapter.ts": `function WorkspaceApp() {
  const writeDrafts = createCognitiveDraftWriter({
    writeInputs: draftCommands.writeInputs,
    captureScope: () => cognitiveSurface ? { key: contextKey, surface: cognitiveSurface } : null,
    onError: setNotice,
  });
}`,
}).get("adapter.ts")!.source;

function currentDraftFacts(parsed: Parsed) {
  const aliases = new Map<number, number>();
  walk(parsed.source, (node) => {
    if (
      !isVariableDeclaration(node) ||
      !isIdentifier(node.name) ||
      !node.initializer ||
      !isIdentifier(node.initializer) ||
      !(node.parent.flags & 2)
    )
      return;
    const key = parsed.symbols.get(node.name),
      value = parsed.symbols.get(node.initializer);
    if (key !== undefined && value !== undefined) aliases.set(key, value);
  });
  const identity = (node: Node) => {
    let value = parsed.symbols.get(node),
      remaining = aliases.size + 1;
    while (value !== undefined && aliases.has(value) && remaining-- > 0)
      value = aliases.get(value);
    return value;
  };
  const imports = new Map<
    number,
    { path: string; name: string; typeOnly: boolean }
  >();
  for (const node of parsed.source.statements.filter(isImportDeclaration)) {
    const named = node.importClause?.namedBindings;
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      !named ||
      !isNamedImports(named)
    )
      continue;
    for (const entry of named.elements) {
      const id = identity(entry.name);
      if (id !== undefined)
        imports.set(id, {
          path: node.moduleSpecifier.text,
          name: (entry.propertyName ?? entry.name).text,
          typeOnly:
            node.importClause?.phaseModifier === SyntaxKind.TypeKeyword ||
            entry.isTypeOnly,
        });
    }
  }
  const names = new Map<number, string>();
  for (const [id, value] of imports) names.set(id, value.name);
  function bind(node: Node | undefined, name: string) {
    if (!node) return;
    walk(node, (child) => {
      if (!isIdentifier(child) || child.text !== name) return;
      const id = identity(child);
      if (id !== undefined) names.set(id, name);
    });
  }
  function shape(node: Node): unknown {
    const children: unknown[] = [];
    node.forEachChild((child) => {
      children.push(shape(child));
    });
    return [
      node.kind,
      isPrefixUnaryExpression(node) ? node.operator : undefined,
      children.length
        ? children
        : isIdentifier(node)
          ? (names.get(identity(node)!) ?? node.getText())
          : node.getText(),
    ];
  }
  const same = (left: Node | undefined, right: Node | undefined) =>
    !!left &&
    !!right &&
    JSON.stringify(shape(left)) === JSON.stringify(syntax(right));
  return { identity, imports, names, bind, shape, same };
}

function currentDraftOwnership(
  ownerText: string,
  appText: string,
  privateText: string,
): string[] {
  const parsed = parseCurrentDraft({
    "Owner.ts": ownerText,
    "App.tsx": appText,
    "Private.ts": privateText,
  });
  const owner = parsed.get("Owner.ts")!,
    app = parsed.get("App.tsx")!,
    privateOwner = parsed.get("Private.ts")!;
  const o = currentDraftFacts(owner),
    a = currentDraftFacts(app),
    p = currentDraftFacts(privateOwner);
  const problems = new Set<string>();
  const check = (valid: boolean, rule: string) => {
    if (!valid) problems.add(rule);
  };
  const workspace = functions(app.source, "WorkspaceApp")[0];
  check(!!workspace?.body, "one-host-workspace");
  if (!workspace?.body) return [...problems];
  const factory = owner.source.statements
    .filter(isFunctionDeclaration)
    .find((node) => node.name?.text === "createExchangeDraftCommands");
  const hooks = [
    "useExchangeInputDraftState",
    "useExchangeConversationDraftState",
    "useExchangeDiscardedDraftState",
  ];
  const commandNames = [
    "writeInputs",
    "createConversation",
    "retireCommittedConversations",
    "discardConversation",
    "restoreConversation",
  ];
  const fn = (name: string) =>
    hooks.includes(name)
      ? owner.source.statements
          .filter(isFunctionDeclaration)
          .find((node) => node.name?.text === name)
      : factory?.body?.statements
          .filter(isFunctionDeclaration)
          .find((node) => node.name?.text === name);
  const dependency = (
    facts: ReturnType<typeof currentDraftFacts>,
    root: Node,
    expected: Record<string, string>,
    rule: string,
  ) => {
    walk(root, (node) => {
      if (!isIdentifier(node)) return;
      const imported = facts.imports.get(facts.identity(node)!);
      const name = imported?.name ?? node.text;
      if (!Object.hasOwn(expected, name)) return;
      // Property names are not value dependencies, while calls and type/value
      // references resolve to their real local/import symbols.
      if (isPropertyAccessExpression(node.parent) && node.parent.name === node)
        return;
      check(
        !!imported && imported.path === expected[name] && !imported.typeOnly,
        rule,
      );
    });
  };
  const parameterBindings = factory?.parameters[0]?.name;
  check(
    !!parameterBindings &&
      isObjectBindingPattern(parameterBindings) &&
      parameterBindings.elements.length === 5 &&
      ["inputs", "conversations", "discarded", "storage", "onNotice"].every(
        (name) => {
          const found = parameterBindings.elements.filter(
            (node) => (node.propertyName ?? node.name)?.getText() === name,
          );
          return (
            found.length === 1 &&
            !!found[0]!.name &&
            isIdentifier(found[0]!.name) &&
            !found[0]!.initializer
          );
        },
      ),
    "actual-owned-draft-ports-and-captured-values",
  );
  if (parameterBindings)
    for (const name of [
      "inputs",
      "conversations",
      "discarded",
      "storage",
      "onNotice",
    ])
      o.bind(parameterBindings, name);
  for (const name of commandNames)
    if (fn(name))
      walk(fn(name)!, (node) => {
        if (
          !isIdentifier(node) ||
          ![
            "inputs",
            "conversations",
            "discarded",
            "storage",
            "onNotice",
          ].includes(node.text)
        )
          return;
        if (
          isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        )
          return;
        check(
          o.names.get(o.identity(node)!) === node.text,
          "actual-owned-draft-ports-and-captured-values",
        );
      });
  for (const [index, name] of hooks.entries()) {
    const actual = fn(name);
    check(
      !!actual?.body &&
        o.same(
          actual.body,
          body(["inputState", "conversationState", "discardedState"][index]!),
        ),
      "three-original-effect-free-state-initializers-and-ref",
    );
    if (actual)
      dependency(
        o,
        actual,
        {
          useState: "react",
          useRef: "react",
          draftKey: "../local-preferences.js",
        },
        "actual-owned-draft-dependency-origin-and-phase",
      );
  }
  for (const name of [...hooks, "createExchangeDraftCommands"]) {
    const actual = name === "createExchangeDraftCommands" ? factory : fn(name);
    check(
      !!actual &&
        !actual.asteriskToken &&
        !actual.modifiers?.some(
          (node) => node.kind === SyntaxKind.AsyncKeyword,
        ),
      "owned-draft-registrations-and-factory-synchronous",
    );
  }
  const hookCalls: CallExpression[] = [];
  for (const name of hooks)
    if (fn(name))
      walk(fn(name)!, (node) => {
        if (isCallExpression(node)) hookCalls.push(node);
      });
  check(
    hookCalls.filter(
      (node) =>
        o.imports.get(o.identity(node.expression)!)?.name === "useState",
    ).length === 3 &&
      hookCalls.filter(
        (node) =>
          o.imports.get(o.identity(node.expression)!)?.name === "useRef",
      ).length === 1,
    "no-second-draft-state-or-latest-ref",
  );
  const statements = factory?.body?.statements;
  check(
    !!statements &&
      statements.length === 6 &&
      statements.slice(0, 5).every(isFunctionDeclaration) &&
      statements
        .slice(0, 5)
        .filter(isFunctionDeclaration)
        .map((node) => node.name?.text)
        .join(",") === commandNames.join(",") &&
      o.same(statements[5], body("returnedCommands").statements[0]),
    "five-local-commands-no-hooks-or-factory-construction-work",
  );
  for (const [name, recipe, rule] of [
    [
      "writeInputs",
      "writer",
      "functional-input-writer-publishes-even-after-storage-failure",
    ],
    [
      "createConversation",
      "create",
      "create-current-ref-persist-ref-state-stable-ids",
    ],
    [
      "retireCommittedConversations",
      "reconcile",
      "retire-authoritative-collection-ref-state-persist-no-catch",
    ],
  ])
    check(o.same(fn(name!)?.body, body(recipe!)), rule!);
  for (const [name, recipe] of [
    ["discardConversation", "discardCommit"],
    ["restoreConversation", "restoreCommit"],
  ]) {
    const actual = fn(name!),
      commits = actual?.body?.statements.filter(isTryStatement) ?? [];
    check(
      commits.length === 1 &&
        o.same(commits[0], body(recipe!).statements[0]) &&
        commits[0] === actual?.body?.statements.at(-1),
      "partial-writes-then-publication-navigation-inside-catch-boundary",
    );
  }
  check(
    !!fn("discardConversation") &&
      o.same(
        declarations(fn("discardConversation")!, "conversation")[0]
          ?.initializer,
        declarations(body("discardSnapshots"), "conversation")[0]?.initializer,
      ),
    "discard-render-snapshot-and-lazy-persisted-fallback",
  );
  for (const name of ["saved", "pending", "nextInputs", "next", "trash"])
    check(
      !!fn("restoreConversation") &&
        o.same(
          declarations(fn("restoreConversation")!, name)[0]?.initializer,
          declarations(body("restoreSnapshots"), name)[0]?.initializer,
        ),
      "restore-render-snapshots-saved-inputs-win",
    );
  // Complete bodies also constrain early returns/guards around the reviewed
  // snapshots and try blocks; a callee whitelist alone cannot prove them.
  for (const name of commandNames) {
    const fixed = functions(originalDraftCommandsSource, name)[0]!;
    check(
      o.same(fn(name)?.body, fixed.body),
      "complete-original-draft-command-recipe " + name,
    );
  }
  const allowedCalls = new Set([
    "storage.readLocal",
    "storage.writeLocal",
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
  for (const name of [...hooks, ...commandNames])
    if (fn(name))
      walk(fn(name)!, (node) => {
        if (!isCallExpression(node)) return;
        const imported = o.imports.get(o.identity(node.expression)!);
        const expression = node.expression.getText();
        check(
          (!!imported &&
            ["useState", "useRef", "draftKey"].includes(imported.name)) ||
            allowedCalls.has(expression) ||
            expression.endsWith(").find") ||
            expression.endsWith(").filter"),
          "owner-has-no-unreviewed-execution-or-effects",
        );
        if (imported?.name === "draftKey") {
          const key = node.arguments[0];
          check(
            node.arguments.length === 1 &&
              !!key &&
              isStringLiteral(key) &&
              keys.has(key.text),
            "original-three-storage-keys-only",
          );
          check(
            imported.path === "../local-preferences.js" && !imported.typeOnly,
            "actual-owned-draft-dependency-origin-and-phase",
          );
        }
      });
  const bindApp = (name: string) => {
    const values = declarations(workspace, name);
    if (values.length === 1) a.bind(values[0]!.name, name);
    return values;
  };
  const names = [
    "inputDraftState",
    "conversationDraftState",
    "discardedDraftState",
    "draftCommands",
    "drafts",
    "conversationDrafts",
    "discardedDrafts",
    "readLocal",
    "writeLocal",
    "writeDrafts",
    "hasConversationDraft",
    "sendPending",
  ];
  for (const name of names) bindApp(name);
  const importedCalls = (name: string, path: string) => {
    const found: CallExpression[] = [];
    walk(app.source, (node) => {
      if (!isCallExpression(node) || !isIdentifier(node.expression)) return;
      const entry = a.imports.get(a.identity(node.expression)!);
      if (entry?.name === name && entry.path === path && !entry.typeOnly)
        found.push(node);
    });
    return found;
  };
  const stateNames = names.slice(0, 3);
  for (const [index, name] of hooks.entries()) {
    const entries = importedCalls(name, "./host/exchange-drafts.js"),
      variable = bindApp(stateNames[index]!);
    check(
      entries.length === 1 &&
        variable.length === 1 &&
        variable[0]?.initializer === entries[0] &&
        entries[0]!.arguments.length === 1 &&
        a.same(entries[0]!.arguments[0], storagePorts),
      "one-real-imported-state-hook-with-original-scoped-storage",
    );
  }
  const factoryCalls = importedCalls(
      "createExchangeDraftCommands",
      "./host/exchange-drafts.js",
    ),
    command = bindApp("draftCommands");
  check(
    factoryCalls.length === 1 &&
      command.length === 1 &&
      command[0]!.initializer === factoryCalls[0] &&
      a.same(factoryCalls[0]!.arguments[0], declaration("ports").initializer),
    "one-render-local-command-owner-no-setter-bag",
  );
  for (const name of [
    "readLocal",
    "drafts",
    "conversationDrafts",
    "discardedDrafts",
    "writeDrafts",
  ]) {
    const found = bindApp(name);
    if (name === "writeDrafts") {
      const entries = importedCalls(
        "createCognitiveDraftWriter",
        "./host/cognitive-draft-writer.js",
      );
      const value = entries[0]?.arguments[0];
      const properties =
        value && isObjectLiteralExpression(value) ? value.properties : [];
      const rawWriter = properties.find(
        (property) =>
          isPropertyAssignment(property) &&
          property.name.getText() === "writeInputs",
      );
      const borrowed =
        rawWriter && isPropertyAssignment(rawWriter)
          ? rawWriter.initializer
          : undefined;
      check(
        found.length === 1 &&
          entries.length === 1 &&
          found[0]?.initializer === entries[0] &&
          entries[0]?.arguments.length === 1 &&
          !entries[0]?.typeArguments?.length &&
          a.same(
            found[0],
            declarations(cognitiveWriterAdapter, "writeDrafts")[0],
          ) &&
          !!borrowed &&
          isPropertyAccessExpression(borrowed) &&
          isIdentifier(borrowed.expression) &&
          a.identity(borrowed.expression) === a.identity(command[0]!.name),
        "exact-cognitive-public-writer-adapter-real-import-and-borrowed-owner",
      );
      for (const expected of ["cognitiveSurface", "contextKey", "setNotice"]) {
        const variables = declarations(workspace, expected),
          functionsFound =
            expected === "setNotice" ? functions(workspace, expected) : [];
        const identifiers: Identifier[] = [];
        const target =
          expected === "setNotice"
            ? functionsFound[0]?.name
            : variables[0]?.name;
        if (target)
          walk(target, (node) => {
            if (isIdentifier(node) && node.text === expected)
              identifiers.push(node);
          });
        const references: Identifier[] = [];
        if (value)
          walk(value, (node) => {
            if (isIdentifier(node) && node.text === expected)
              references.push(node);
          });
        check(
          (expected === "setNotice"
            ? functionsFound.length === 1
            : variables.length === 1) &&
            identifiers.length === 1 &&
            references.length > 0 &&
            a.identity(identifiers[0]!) !== undefined &&
            references.every(
              (node) => a.identity(node) === a.identity(identifiers[0]!),
            ),
          "exact-cognitive-public-writer-adapter-real-import-and-borrowed-owner",
        );
      }
      continue;
    }
    check(
      found.length === 1 &&
        a.same(
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
        position >= 0 && (!index || position > positions[index - 1]!),
    ),
    "state-hooks-retain-original-init-slots-before-unique-surface",
  );
  const leaf = (
    node: Node | undefined,
    name: string,
  ): Identifier | undefined => {
    let result: Identifier | undefined;
    if (node)
      walk(node, (child) => {
        if (isIdentifier(child) && child.text === name) result = child;
      });
    return result;
  };
  const appId = (name: string) =>
    a.identity(
      leaf(bindApp(name)[0]?.name, name) ??
        leaf(workspace.parameters[0]?.name, name)!,
    );
  for (const name of [
    "state",
    "client",
    "origin",
    "currentContext",
    "dictationControls",
    "emptyDraft",
    "setNotice",
  ]) {
    const values = declarations(workspace, name);
    if (values.length === 1) a.bind(values[0]!.name, name);
    a.bind(workspace.parameters[0]?.name, name);
  }
  const members = (node: Node | undefined) =>
    node && isObjectLiteralExpression(node) ? node.properties : [];
  const memberValue = (node: Node) =>
    isShorthandPropertyAssignment(node)
      ? node.name
      : isPropertyAssignment(node)
        ? node.initializer
        : undefined;
  const retirement = importedCalls(
    "useCommittedConversationDraftRetirement",
    "./host/private-project-conversation-scope.js",
  );
  const actualRetirement = privateOwner.source.statements
    .filter(isFunctionDeclaration)
    .find(
      (node) => node.name?.text === "useCommittedConversationDraftRetirement",
    );
  check(
    retirement.length === 1 &&
      retirement[0]!.arguments.length === 2 &&
      a.identity(retirement[0]!.arguments[0]!) === appId("draftCommands") &&
      a.identity(retirement[0]!.arguments[1]!) === appId("state") &&
      retirement[0]!.pos > positions[9]! &&
      retirement[0]!.pos < positions[10]!,
    "retirement-effect-original-position-dependencies-authority",
  );
  if (actualRetirement?.body) {
    for (const parameter of actualRetirement.parameters) {
      p.bind(parameter.name, "draftCommands");
      p.bind(parameter.name, "state");
    }
    const effect = calls(body("appSeams"), "useEffect")[0]!;
    const statement = actualRetirement.body.statements[0];
    check(
      actualRetirement.body.statements.length === 1 &&
        !!statement &&
        isExpressionStatement(statement) &&
        p.same(statement.expression, effect),
      "retirement-effect-original-position-dependencies-authority",
    );
    dependency(
      p,
      actualRetirement.body,
      { useEffect: "react" },
      "actual-retirement-dependency-origin-and-phase",
    );
  } else
    check(false, "retirement-effect-original-position-dependencies-authority");
  const privateFactoryCalls = importedCalls(
    "createPrivateProjectConversationScope",
    "./host/private-project-conversation-scope.js",
  );
  const borrowed = members(privateFactoryCalls[0]?.arguments[0]);
  check(
    privateFactoryCalls.length === 1 &&
      ["draftCommands", "sendPending"].every((name) => {
        const found = borrowed.filter(
          (node) =>
            (isShorthandPropertyAssignment(node) ||
              isPropertyAssignment(node)) &&
            node.name.getText() === name,
        );
        return (
          found.length === 1 &&
          !!memberValue(found[0]!) &&
          a.identity(memberValue(found[0]!)!) === appId(name)
        );
      }),
    "actual-private-actions-borrow-original-drafts-and-send-lock",
  );
  for (const name of ["setDraft", "updateDraft"]) {
    const target = functions(workspace, name),
      expected = functions(oracle, name)[0]!;
    const actual = target[0],
      guard = body("privateOriginGuard").statements[0];
    check(
      target.length === 1 &&
        !!actual?.body &&
        a.same(actual.body.statements[0], guard) &&
        actual.body.statements.length ===
          expected.body!.statements.length + 1 &&
        actual.body.statements
          .slice(1)
          .every((node, index) =>
            a.same(node, expected.body!.statements[index]),
          ) &&
        JSON.stringify(signature(actual)) ===
          JSON.stringify(signature(expected)),
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    );
    if (actual)
      dependency(
        a,
        actual.body!,
        {
          replaceComposerSurface: "./composer-drafts.js",
          updateComposerDraft: "./composer-drafts.js",
        },
        "actual-host-draft-helper-origin-and-phase",
      );
  }
  const privateFactory = privateOwner.source.statements
    .filter(isFunctionDeclaration)
    .find(
      (node) => node.name?.text === "createPrivateProjectConversationScope",
    );
  for (const name of ["draftCommands", "sendPending", "render"])
    p.bind(privateFactory?.parameters[0]?.name, name);
  const captured = privateFactory && declarations(privateFactory, "state")[0];
  check(
    !!captured?.initializer &&
      isIdentifier(captured.initializer) &&
      p.names.get(p.identity(captured.initializer)!) === "render",
    "actual-private-actions-borrow-original-drafts-and-send-lock",
  );
  if (captured)
    for (const name of ["state", "conversationId", "hasConversationDraft"])
      p.bind(captured.name, name);
  for (const name of [
    "createProjectConversation",
    "discardConversationDraft",
    "restoreConversationDraft",
  ]) {
    const actual = privateFactory?.body?.statements
      .filter(isFunctionDeclaration)
      .find((node) => node.name?.text === name);
    check(
      p.same(actual, functions(oracle, name)[0]),
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    );
    if (actual)
      walk(actual, (node) => {
        if (
          !isIdentifier(node) ||
          ![
            "draftCommands",
            "sendPending",
            "state",
            "conversationId",
            "hasConversationDraft",
          ].includes(node.text)
        )
          return;
        if (
          isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        )
          return;
        check(
          p.names.get(p.identity(node)!) === node.text,
          "actual-private-actions-borrow-original-drafts-and-send-lock",
        );
      });
  }
  const presenceCalls = importedCalls(
    "projectConversationDraftPresence",
    "./host/private-project-conversation-scope.js",
  );
  const presence = privateOwner.source.statements
    .filter(isFunctionDeclaration)
    .find((node) => node.name?.text === "projectConversationDraftPresence");
  const presenceReturn = presence?.body?.statements[0];
  const expectedPresence = declaration("hasConversationDraft").initializer;
  if (presence)
    for (const parameter of presence.parameters) {
      for (const name of ["state", "client", "drafts"])
        p.bind(parameter.name, name);
    }
  const presenceMembers = members(presenceCalls[0]?.arguments[0]);
  check(
    presenceCalls.length === 1 &&
      bindApp("hasConversationDraft")[0]?.initializer === presenceCalls[0] &&
      presenceMembers.length === 3 &&
      ["state", "client", "drafts"].every((name) => {
        const found = presenceMembers.filter(
          (node) =>
            (isShorthandPropertyAssignment(node) ||
              isPropertyAssignment(node)) &&
            node.name.getText() === name,
        );
        return (
          found.length === 1 &&
          !!memberValue(found[0]!) &&
          a.identity(memberValue(found[0]!)!) === appId(name)
        );
      }) &&
      !!presenceReturn &&
      isReturnStatement(presenceReturn) &&
      p.same(presenceReturn.expression, expectedPresence),
    "real-local-input-and-composer-content-restore-guard",
  );
  if (presence)
    dependency(
      p,
      presence.body!,
      { discussionId: "../../../../packages/core/src/model.js" },
      "actual-draft-presence-dependency-origin-and-phase",
    );
  const recordIds = [
    "drafts",
    "conversationDrafts",
    "discardedDrafts",
    ...stateNames,
    "draftCommands",
  ].map((name) => ({ name, id: appId(name) }));
  walk(workspace, (node) => {
    if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
      const handle = recordIds.find(
        (value) =>
          stateNames.includes(value.name) &&
          value.id !== undefined &&
          value.id === a.identity(node.expression),
      );
      if (handle) {
        const member = isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression && isStringLiteral(node.argumentExpression)
            ? node.argumentExpression.text
            : "<computed>";
        check(member === "value", "host-cannot-bypass-draft-commands");
      }
    }
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= SyntaxKind.LastAssignment
    ) {
      let root: Node = node.left;
      while (
        isPropertyAccessExpression(root) ||
        isElementAccessExpression(root)
      )
        root = root.expression;
      check(
        !recordIds.some(
          (value) => value.id !== undefined && value.id === a.identity(root),
        ),
        "host-cannot-mutate-owned-records",
      );
    }
    if (isCallExpression(node)) {
      const entry = a.imports.get(a.identity(node.expression)!);
      const readsOwned = node.arguments.some((argument) => {
        let found = false;
        walk(argument, (leaf) => {
          if (
            recordIds.some(
              (value) =>
                value.id !== undefined && value.id === a.identity(leaf),
            )
          )
            found = true;
        });
        return found;
      });
      if (entry?.name === "useRef" && readsOwned)
        check(false, "no-second-host-draft-writer-ref");
      if (entry?.name === "useState" && readsOwned)
        check(false, "no-second-host-draft-state");
      const key = node.arguments[0];
      if (
        (entry?.name === "draftKey" ||
          (isIdentifier(node.expression) &&
            node.expression.text === "draftKey")) &&
        key &&
        isStringLiteral(key)
      )
        check(!keys.has(key.text), "migrated-key-storage-only-in-owner");
    }
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
    if (isIdentifier(node) && node.text === "conversationDraftsRef")
      check(false, "no-second-host-draft-writer-ref");
  });
  return [...problems];
}

// 47 current counterparts of the original 49 draft operands. The unused
// import and unused Map inventory operands remain historical-only above.
function registerCurrentDraftCounterfactuals() {
  const ownership = (owner: string, app: string, scope = privateOwner) =>
    currentDraftOwnership(owner, app, scope);
  const test = (title: string, callback: () => void) =>
    nodeTest("current " + title, callback);
  const rejected = (
    owner: string,
    app: string,
    rule: string,
    scope = privateOwner,
  ) => {
    assert.ok(
      currentDraftOwnership(owner, app, scope).includes(rule),
      "Current counterfactual must violate " + rule,
    );
  };
  test("exchange drafts have one local owner and original Host lifecycle seams", () => {
    assert.deepEqual(ownership(owner, app), []);
  });
  test("draft gate rejects unreviewed dependencies, eager construction, effects and replacement keys", () => {
    for (const [candidate, rule] of [
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
    for (const [before, after] of [
      [
        "}, [state?.conversations]);",
        "}, [state?.conversations, draftCommands]);",
      ],
      [
        "draftCommands.retireCommittedConversations(state?.conversations);",
        "draftCommands.retireCommittedConversations(state?.inputs);",
      ],
    ])
      rejected(
        owner,
        app,
        "retirement-effect-original-position-dependencies-authority",
        changed(privateOwner, before!, after!),
      );
    const retirement =
      "  useCommittedConversationDraftRetirement(draftCommands, state);";
    rejected(
      owner,
      changed(
        changed(app, retirement, ""),
        "  const personalSpace =",
        retirement + "\n  const personalSpace =",
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
    ])
      rejected(
        owner,
        app,
        "host-guards-dictation-async-shell-navigation-seams-unchanged",
        changed(privateOwner, before!, after!),
      );
    for (const [before, after] of [
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
      app,
      "real-local-input-and-composer-content-restore-guard",
      changed(
        privateOwner,
        "          value.intent",
        "          value.intent || value.model",
      ),
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
  for (const [label, side, name, before, after, rule] of [
    [
      "setDraft prefix operator",
      "app",
      "setDraft",
      "if (!origin.isActive()) return;",
      "if (+origin.isActive()) return;",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "updateDraft prefix operator",
      "app",
      "updateDraft",
      "if (!origin.isActive()) return;",
      "if (+origin.isActive()) return;",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "setDraft async declaration",
      "app",
      "setDraft",
      "function setDraft(",
      "async function setDraft(",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "updateDraft async declaration",
      "app",
      "updateDraft",
      "function updateDraft(",
      "async function updateDraft(",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "setDraft generator declaration",
      "app",
      "setDraft",
      "function setDraft(",
      "function* setDraft(",
      "host-guards-dictation-async-shell-navigation-seams-unchanged",
    ],
    [
      "createConversation prefix operator",
      "owner",
      "createConversation",
      "if (!pending)",
      "if (+pending)",
      "create-current-ref-persist-ref-state-stable-ids",
    ],
  ] as const)
    test(`draft gate rejects parsed ${label} counterfactual`, () => {
      const source = side === "app" ? app : owner;
      const filename = side === "app" ? "App.tsx" : "owner.ts";
      const parsed = parse({ [filename]: source }).get(filename)!;
      const targets = functions(parsed.source, name);
      assert.equal(
        targets.length,
        1,
        "Counterfactual has one actual function target",
      );
      const original = targets[0]!.getText(parsed.source);
      const candidate = changed(
        source,
        original,
        changed(original, before, after),
      );
      parse({ [filename]: candidate });
      rejected(
        side === "owner" ? candidate : owner,
        side === "app" ? candidate : app,
        rule,
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
}
registerCurrentDraftCounterfactuals();

test("current cognitive writer requires the real factory, exact owner/scope/error ports and no legacy bypass", () => {
  const parsed = parseCurrentDraft({ "App.tsx": app }).get("App.tsx")!;
  const workspace = functions(parsed.source, "WorkspaceApp")[0]!;
  const writer = declarations(workspace, "writeDrafts")[0]!;
  const property = (name: string) => {
    const found: Node[] = [];
    walk(writer, (node) => {
      if (isPropertyAssignment(node) && node.name.getText() === name)
        found.push(node.initializer);
    });
    assert.equal(found.length, 1, "unique-new-writer-counterfactual:" + name);
    return found[0]!;
  };
  const replaceNode = (node: Node, replacement: string) =>
    app.slice(0, node.getStart()) + replacement + app.slice(node.end);
  const factory = writer.initializer!;
  assert.ok(isCallExpression(factory));
  const imports = parsed.source.statements.filter(
    (node) =>
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./host/cognitive-draft-writer.js",
  );
  assert.equal(imports.length, 1, "unique-new-writer-import-counterfactual");
  const cases = [
    replaceNode(
      writer.parent.parent,
      "const { writeInputs: writeDrafts } = draftCommands;",
    ),
    replaceNode(property("writeInputs"), "{ ...draftCommands }.writeInputs"),
    replaceNode(property("key"), "conversationId"),
    replaceNode(property("surface"), "{ ...cognitiveSurface }"),
    replaceNode(property("captureScope"), "() => undefined"),
    replaceNode(property("onError"), "() => {}"),
    replaceNode(
      imports[0]!,
      'import type { createCognitiveDraftWriter } from "./host/cognitive-draft-writer.js";',
    ),
    'import { createCognitiveDraftWriter as foreignWriter } from "./foreign-writer.js";\n' +
      replaceNode(factory.expression, "foreignWriter"),
  ];
  for (const candidate of cases) {
    parseCurrentDraft({ "App.tsx": candidate });
    assert.ok(
      currentDraftOwnership(owner, candidate, privateOwner).includes(
        "exact-cognitive-public-writer-adapter-real-import-and-borrowed-owner",
      ),
    );
  }
});

test("current draft recipes permit real import/const aliases and independently consumed React growth", () => {
  const aliasedOwner = changed(
    owner,
    'import { useRef, useState } from "react";',
    'import { useRef as draftRef, useState as draftState } from "react";',
  )
    .replaceAll(" = useState<", " = draftState<")
    .replace(" = useRef(value)", " = draftRef(value)");
  const aliasedApp = changed(
    changed(
      app,
      "  useExchangeInputDraftState,",
      "  useExchangeInputDraftState as inputStateHook,",
    ),
    "const inputDraftState = useExchangeInputDraftState(",
    "const inputDraftState = inputStateHook(",
  );
  assert.deepEqual(
    currentDraftOwnership(aliasedOwner, aliasedApp, privateOwner),
    [],
  );
  const constAlias = changed(
    changed(
      app,
      "const inputDraftState = useExchangeInputDraftState(",
      "const inputDraftState = inputStateHook(",
    ),
    "  const inputDraftState =",
    "  const inputStateHook = useExchangeInputDraftState;\n  const inputDraftState =",
  );
  assert.deepEqual(currentDraftOwnership(owner, constAlias, privateOwner), []);
  const grown =
    'import { useState as independentState, useEffect as independentEffect } from "react";\n' +
    changed(app, "<WorkspaceTopbar", "<IndependentFeature /><WorkspaceTopbar") +
    "\nfunction IndependentFeature() { const [value, setValue] = independentState(false); independentEffect(() => { return () => {}; }, []); return <button onClick={() => setValue(!value)}>{String(value)}</button>; }";
  assert.deepEqual(
    currentDraftOwnership(
      owner + "\nexport function independentPureFeature() { return 1; }",
      grown,
      privateOwner,
    ),
    [],
  );
});

test("current draft contracts reject actual foreign dependencies/phase and consumed mirrors, not unused imports", () => {
  const rejected = (
    candidateOwner: string,
    candidateApp: string,
    scope: string,
    rule: string,
  ) =>
    assert.ok(
      currentDraftOwnership(candidateOwner, candidateApp, scope).includes(rule),
      "Additional current counterfactual must violate " + rule,
    );
  // Correct imports are retained but unused: the actual consumed symbol comes
  // from the wrong module. Export spelling alone must never prove provenance.
  const foreignHook =
    'import { useExchangeInputDraftState as foreignHook } from "./foreign-drafts.js";\n' +
    changed(
      app,
      "const inputDraftState = useExchangeInputDraftState(",
      "const inputDraftState = foreignHook(",
    );
  rejected(
    owner,
    foreignHook,
    privateOwner,
    "one-real-imported-state-hook-with-original-scoped-storage",
  );
  const foreignFactory =
    'import { createExchangeDraftCommands as foreignFactory } from "./foreign-drafts.js";\n' +
    changed(
      app,
      "const draftCommands = createExchangeDraftCommands(",
      "const draftCommands = foreignFactory(",
    );
  rejected(
    owner,
    foreignFactory,
    privateOwner,
    "one-render-local-command-owner-no-setter-bag",
  );
  const foreignReact =
    'import { useState as foreignState } from "../foreign-react.js";\n' +
    owner.replaceAll(" = useState<", " = foreignState<");
  rejected(
    foreignReact,
    app,
    privateOwner,
    "actual-owned-draft-dependency-origin-and-phase",
  );
  const foreignKey =
    'import { draftKey as foreignKey } from "../foreign-preferences.js";\n' +
    owner.replaceAll("draftKey(", "foreignKey(");
  rejected(
    foreignKey,
    app,
    privateOwner,
    "actual-owned-draft-dependency-origin-and-phase",
  );
  rejected(
    changed(
      owner,
      'import { useRef, useState } from "react";',
      'import { useRef, type useState } from "react";',
    ),
    app,
    privateOwner,
    "actual-owned-draft-dependency-origin-and-phase",
  );
  const foreignRetirement =
    'import { useCommittedConversationDraftRetirement as foreignRetirement } from "./foreign-private.js";\n' +
    changed(
      app,
      "useCommittedConversationDraftRetirement(draftCommands, state)",
      "foreignRetirement(draftCommands, state)",
    );
  rejected(
    owner,
    foreignRetirement,
    privateOwner,
    "retirement-effect-original-position-dependencies-authority",
  );
  const mirror = changed(
    app,
    "  const drafts = inputDraftState.value;",
    "  const [mirror] = useState(inputDraftState.value);\n  const drafts = mirror;",
  );
  rejected(owner, mirror, privateOwner, "no-second-host-draft-state");
  rejected(
    owner,
    changed(
      app,
      "  useCommittedConversationDraftRetirement(draftCommands, state);",
      "  useCommittedConversationDraftRetirement(draftCommands, client.boot?.workspace);",
    ),
    privateOwner,
    "retirement-effect-original-position-dependencies-authority",
  );
  rejected(
    owner,
    changed(
      app,
      "    draftCommands,\n    sendPending,",
      "    draftCommands: { ...draftCommands },\n    sendPending,",
    ),
    privateOwner,
    "actual-private-actions-borrow-original-drafts-and-send-lock",
  );
  rejected(
    owner,
    app,
    changed(privateOwner, "  } = render;", "  } = host.currentProjection()!;"),
    "actual-private-actions-borrow-original-drafts-and-send-lock",
  );
});

test("current five complete draft command recipes reject additional early guards/returns", () => {
  for (const [name, from, to] of [
    [
      "discardConversation",
      "    if (!conversation) return;",
      "    if (!conversation) return;\n    if (inputs.value) return;",
    ],
    [
      "restoreConversation",
      "    if (!saved) return;",
      "    if (!saved) return;\n    if (saved.drafts) return;",
    ],
  ] as const) {
    assert.ok(
      currentDraftOwnership(
        changed(owner, from, to),
        app,
        privateOwner,
      ).includes("complete-original-draft-command-recipe " + name),
      "Additional current counterfactual must violate complete-original-draft-command-recipe " +
        name,
    );
  }
});
