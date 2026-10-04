import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectBindingPattern,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
} from "typescript/unstable/ast";
import {
  referenceMethods,
  verifyFixedReference,
  verifyReferenceOwner,
} from "./fixtures/exchange-reference-contract.js";
import {
  referenceConsumptionAdapter,
  referenceConsumptionBaseline,
  referenceOriginalImports,
} from "./fixtures/exchange-reference-consumption-b5f698dd.js";

const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const owner = readFileSync(
  new URL(
    "../apps/web/src/host/exchange-reference-commands.ts",
    import.meta.url,
  ),
  "utf8",
);
const fixed = readFileSync(
  new URL("./fixtures/exchange-reference-39cf13cf.ts", import.meta.url),
  "utf8",
);
const ownerPath = "./host/exchange-reference-commands.js";
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
function parse(text: string) {
  const file = "/reference-consumption/App.tsx";
  const config = "/reference-consumption/tsconfig.json";
  const api = new API({
    cwd: "/reference-consumption",
    fs: createVirtualFileSystem({
      [file]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: ["App.tsx"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.equal(
      project.program.getSyntacticDiagnostics().length,
      0,
      "valid parsed source",
    );
    const source = project.program.getSourceFile(file)!;
    const nodes: Node[] = [],
      identifiers: Identifier[] = [];
    walk(source, (node) => {
      nodes.push(node);
      if (isIdentifier(node)) identifiers.push(node);
    });
    const resolved = project.checker.getSymbolAtLocation(identifiers);
    return {
      source,
      nodes,
      symbols: new Map(
        identifiers.map((node, index) => [node, resolved[index]?.id]),
      ),
    };
  } finally {
    snapshot.dispose();
    api.close();
  }
}
type Parsed = ReturnType<typeof parse>;
function syntax(node: Node): unknown {
  // These grammar scalars are not all forEachChild children. Do not equate
  // const/let, optional chaining or !!/~~ by silently dropping them.
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
    return [node.kind, node.operator, syntax(node.operand)];
  const flags =
    node.flags &
    (NodeFlags.Let |
      NodeFlags.Const |
      NodeFlags.Using |
      NodeFlags.OptionalChain);
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(syntax(child));
  });
  return [node.kind, flags, children.length ? children : node.getText()];
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function oneFunction(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "one original function " + name);
  assert.ok(found[0]!.body);
  return found[0]!;
}
function oneVariable(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, "one original binding " + name);
  return found[0]!;
}
function imported(parsed: Parsed, path: string, name: string) {
  const imports = parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === path,
    );
  assert.equal(imports.length, 1, "one actual import " + name);
  const node = imports[0]!;
  const clause = node.importClause;
  assert.ok(
    clause &&
      clause.phaseModifier !== SyntaxKind.TypeKeyword &&
      clause.namedBindings &&
      isNamedImports(clause.namedBindings),
    "actual runtime import " + name,
  );
  const members = clause.namedBindings.elements.filter(
    (item) =>
      !item.isTypeOnly && (item.propertyName ?? item.name).text === name,
  );
  assert.equal(members.length, 1, "actual runtime import " + name);
  const binding = parsed.symbols.get(members[0]!.name);
  assert.ok(binding !== undefined, "resolved import binding " + name);
  return { node, local: members[0]!.name.text, binding };
}
function metrics(parsed: Parsed) {
  const hooks = new Map<unknown, string>();
  for (const node of parsed.source.statements.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "react" ||
      !node.importClause?.namedBindings ||
      !isNamedImports(node.importClause.namedBindings)
    )
      continue;
    for (const item of node.importClause.namedBindings.elements) {
      const name = (item.propertyName ?? item.name).text;
      if (/^use[A-Z]/.test(name))
        hooks.set(parsed.symbols.get(item.name), name);
    }
  }
  const calls = parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        hooks.has(parsed.symbols.get(node.expression)),
    );
  return {
    tree: digest(syntax(parsed.source)),
    nodes: parsed.nodes.length,
    jsxNodes: parsed.nodes.filter(
      (node) =>
        isJsxElement(node) ||
        isJsxFragment(node) ||
        isJsxSelfClosingElement(node),
    ).length,
    hooks: calls.length,
    effects: calls.filter(
      (node) =>
        isIdentifier(node.expression) &&
        ["useEffect", "useLayoutEffect"].includes(
          hooks.get(parsed.symbols.get(node.expression))!,
        ),
    ).length,
  };
}

function validate(text: string, ownerText = owner) {
  // Validate actual complete algorithms BEFORE allowing any finite App expansion.
  const ownerParsed = parse(ownerText);
  const ownerFactory = oneFunction(
    ownerParsed,
    "createExchangeReferenceCommands",
  );
  assert.ok(
    ownerParsed.source.statements.every(
      (node) =>
        node === ownerFactory ||
        isImportDeclaration(node) ||
        isTypeAliasDeclaration(node),
    ),
    "single inert reference module inventory",
  );
  assert.deepEqual(
    ownerFactory.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "synchronous reference factory",
  );
  const capture = ownerFactory.body!.statements.filter((node) => {
    if (isFunctionDeclaration(node)) {
      assert.ok(
        ["openTextQuote", "composeContent", "composeIntent"].includes(
          node.name?.text ?? "",
        ),
        "reviewed reference command inventory",
      );
      return false;
    }
    return (
      !isVariableStatement(node) ||
      !node.declarationList.declarations.some(
        (declaration) =>
          isIdentifier(declaration.name) &&
          declaration.name.text === "composeReading",
      )
    );
  });
  assert.equal(
    digest([ownerFactory.parameters.map(syntax), capture.map(syntax)]),
    referenceConsumptionBaseline.ownerCapture,
    "fixed reference capture/direct return",
  );
  verifyReferenceOwner(ownerText, fixed);
  const old = verifyFixedReference(fixed);
  const parsed = parse(text);
  const factory = imported(
    parsed,
    ownerPath,
    "createExchangeReferenceCommands",
  );
  const calls = parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        parsed.symbols.get(node.expression) === factory.binding,
    );
  assert.equal(calls.length, 1, "one actual reference owner call");
  const call = calls[0]!;
  assert.ok(
    isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      isObjectBindingPattern(call.parent.name),
    "direct reference command aliases",
  );
  const declaration = call.parent;
  const statement = declaration.parent.parent;
  const workspace = oneFunction(parsed, "WorkspaceApp");
  assert.ok(
    isVariableStatement(statement) &&
      statement.parent === workspace.body &&
      statement.declarationList.declarations.length === 1 &&
      !!(statement.declarationList.flags & NodeFlags.Const),
    "unconditional render-local reference registration",
  );
  const aliases = declaration.name;
  assert.ok(
    isObjectBindingPattern(aliases),
    "direct reference command binding",
  );
  assert.deepEqual(
    aliases.elements.map((item) => item.getText()),
    referenceMethods,
    "four original direct aliases",
  );
  const adapter = parse(referenceConsumptionAdapter);
  const adapterCall = adapter.nodes.filter(isCallExpression)[0]!;
  assert.equal(
    call.typeArguments?.length ?? 0,
    0,
    "no reference factory type bridge",
  );
  assert.equal(call.arguments.length, 1, "one reference capture argument");
  assert.deepEqual(
    syntax(call.arguments[0]!),
    syntax(adapterCall.arguments[0]!),
    "exact original captured reference ports",
  );
  for (const item of aliases.elements) {
    const name = item.name;
    assert.ok(name && isIdentifier(name), "direct command identifier");
    const binding = parsed.symbols.get(name);
    assert.ok(binding !== undefined, "resolved command alias");
    for (const identifier of parsed.nodes
      .filter(isIdentifier)
      .filter((node) => node.text === name.text))
      assert.equal(
        parsed.symbols.get(identifier),
        binding,
        "no shadowed reference consumer " + name.text,
      );
  }
  // No call/alias normalization touches JSX. Whole-tree restoration below only
  // replaces the checked declaration, the two exact now-unused type imports and
  // reinserts the fixed old declarations at their original anchors.
  const edits: { start: number; end: number; value: string }[] = [
    { start: factory.node.getStart(), end: factory.node.end, value: "" },
    {
      start: statement.getStart(),
      end: statement.end,
      value: old.openTextQuote + "\n" + old.composeContent,
    },
  ];
  for (const [path, original] of Object.entries(referenceOriginalImports)) {
    const name = path === "./Reader.js" ? "Reader" : "inputIntents";
    const current = imported(parsed, path, name);
    const expected = parse(
      path === "./Reader.js"
        ? 'import { Reader } from "./Reader.js";'
        : 'import { inputIntents } from "../../../packages/core/src/input-intent.js";',
    ).source.statements[0]!;
    assert.deepEqual(
      syntax(current.node),
      syntax(expected),
      "only removed unused reference type " + name,
    );
    edits.push({
      start: current.node.getStart(),
      end: current.node.end,
      value: original,
    });
  }
  const script = oneFunction(parsed, "openScript"),
    close = oneVariable(parsed, "closeSpeech");
  assert.equal(
    script.parent,
    workspace.body,
    "original reading restore anchor",
  );
  assert.ok(
    isVariableStatement(close.parent.parent) &&
      close.parent.parent.parent === workspace.body,
    "original intent restore anchor",
  );
  edits.push({
    start: script.getStart(),
    end: script.getStart(),
    value: "const " + old.composeReading + ";\n",
  });
  edits.push({
    start: close.parent.parent.getStart(),
    end: close.parent.parent.getStart(),
    value: old.composeIntent + "\n",
  });
  let restored = text;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    restored =
      restored.slice(0, edit.start) + edit.value + restored.slice(edit.end);
  const actual = metrics(parse(restored));
  const {
    sourceSha256: _source,
    ownerCapture: _owner,
    ...baseline
  } = referenceConsumptionBaseline;
  assert.deepEqual(
    actual,
    baseline,
    "fixed complete b5f698dd App tree/lifecycle/JSX",
  );
}

test("actual App uniquely consumes complete reference owner with original ports and complete fixed tree", () => {
  validate(app);
});

test("finite reference gate accepts an actual import alias and trivia without normalizing consumers", () => {
  validate(
    app
      .replace(
        "import { createExchangeReferenceCommands }",
        "import { createExchangeReferenceCommands as ReferenceCommands }",
      )
      .replace(
        "    createExchangeReferenceCommands({",
        "    ReferenceCommands({",
      ),
  );
  validate(app + "\n// comments are not new behavior\n");
});

test("parsed counterfactuals reject actual-port, phase, alias, lifecycle and later JSX drift for precise rules", () => {
  const parsed = parse(app);
  const importedFactory = imported(
    parsed,
    ownerPath,
    "createExchangeReferenceCommands",
  );
  const actualCall = parsed.nodes
    .filter(isCallExpression)
    .find(
      (node) =>
        isIdentifier(node.expression) &&
        parsed.symbols.get(node.expression) === importedFactory.binding,
    )!;
  assert.ok(isVariableDeclaration(actualCall.parent));
  const actualStatement = actualCall.parent.parent.parent;
  assert.ok(isVariableStatement(actualStatement));
  const mutations = [
    [ownerPath, "./host/not-the-reference-owner.js", "one actual import"],
    [
      "import { createExchangeReferenceCommands }",
      "import type { createExchangeReferenceCommands }",
      "actual runtime import",
    ],
    [
      actualCall.getText(),
      "Promise.resolve(" + actualCall.getText() + ")",
      "direct reference command aliases",
    ],
    [
      actualStatement.getText(),
      "if (state) { " + actualStatement.getText() + " }",
      "unconditional render-local reference registration",
    ],
    [
      "const { openTextQuote, composeContent, composeReading, composeIntent }",
      "let { openTextQuote, composeContent, composeReading, composeIntent }",
      "unconditional render-local reference registration",
    ],
    [
      "const { openTextQuote, composeContent, composeReading, composeIntent }",
      "const { openTextQuote: revisit, composeContent, composeReading, composeIntent }",
      "four original direct aliases",
    ],
    [
      "workspace: state,",
      "workspace: { artifacts: state?.artifacts ?? [] },",
      "exact original captured reference ports",
    ],
    [
      "        conversationId,\n        contextKey,",
      "        conversationId: conversationProjectId,\n        contextKey,",
      "exact original captured reference ports",
    ],
    [
      "      drafts: { replace: setDraft, update: updateDraft },",
      "      drafts: { replace: setDraft, update: (key, change) => updateDraft(key, change) },",
      "exact original captured reference ports",
    ],
    [
      "        requestConversationFocus,\n      },\n      quotes:",
      "        requestConversationFocus: requestSentInputFocus,\n      },\n      quotes:",
      "exact original captured reference ports",
    ],
    [
      "clearSelection: () => window.getSelection()?.removeAllRanges()",
      "clearSelection: () => window.getSelection()?.empty()",
      "exact original captured reference ports",
    ],
    [
      "      onNotice: setNotice,\n    });",
      "      onNotice: (message) => setNotice(message),\n    });",
      "exact original captured reference ports",
    ],
    [
      "onReadingCompose={composeReading}",
      "onReadingCompose={(...args) => composeReading(...args)}",
      "fixed complete b5f698dd",
    ],
    [
      "onOpenQuote={(quote) => void openTextQuote(quote)}",
      "onOpenQuote={(quote) => { if (sending) return; void openTextQuote(quote); }}",
      "fixed complete b5f698dd",
    ],
    [
      "onCompose={composeContent}",
      "onCompose={composeIntent}",
      "fixed complete b5f698dd",
    ],
    [
      "useEffect(() => setQuoteReveal(null), [conversationId]);",
      "useEffect(() => setQuoteReveal(null), [contextKey]);",
      "fixed complete b5f698dd",
    ],
  ] as const;
  function rejected(variant: string, rule: string) {
    parse(variant);
    assert.throws(
      () => validate(variant),
      (error: unknown) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
    );
  }
  for (const [before, after, rule] of mutations) {
    assert.ok(app.includes(before), "actual mutation target");
    const statementText = actualStatement.getText();
    const variant = statementText.includes(before)
      ? app.replace(statementText, statementText.replace(before, after))
      : app.replace(before, after);
    rejected(variant, rule);
  }
  rejected(
    app +
      "\nfunction duplicateReference(){createExchangeReferenceCommands({} as never);}\n",
    "one actual reference owner call",
  );
  rejected(
    app.replace(
      "import { createExchangeReferenceCommands }",
      "import { createExchangeReferenceCommands as ActualReference }",
    ) + "\nfunction createExchangeReferenceCommands(){return {};}",
    "one actual reference owner call",
  );
  const moved = app
    .replace(actualStatement.getText(), "")
    .replace(
      "  function open(id: string",
      actualStatement.getText() + "\n  function open(id: string",
    );
  assert.notEqual(moved, app, "real relocation target");
  rejected(moved, "fixed complete b5f698dd");
  rejected(
    app + "\nfunction extraReferenceLifecycle(){useEffect(()=>{},[]);}\n",
    "fixed complete b5f698dd",
  );
  rejected(
    app.replace(
      "onCompose={composeContent}",
      'onCompose={composeContent}\n key="new-mount"',
    ),
    "fixed complete b5f698dd",
  );
  assert.ok(
    owner.includes("old.body.trim() ||"),
    "actual owner mutation target",
  );
  const ownerDrift = owner.replace("old.body.trim() ||", "false ||");
  parse(ownerDrift);
  assert.throws(
    () => validate(app, ownerDrift),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.includes("original reference algorithm composeReading"),
  );
  for (const [before, after] of [
    [
      "  } = render;",
      "  } = { ...render, workspace: { ...render.workspace } };",
    ],
    [
      "return { openTextQuote, composeContent, composeReading, composeIntent };",
      "return { openTextQuote: async (...args) => openTextQuote(...args), composeContent, composeReading, composeIntent };",
    ],
  ] as const) {
    assert.ok(
      owner.includes(before),
      "actual owner capture/return mutation target",
    );
    const variant = owner.replace(before, after);
    parse(variant);
    assert.throws(
      () => validate(app, variant),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        error.message.includes("fixed reference capture/direct return"),
    );
  }
  for (const [before, after, rule] of [
    [
      "export function createExchangeReferenceCommands",
      "export async function createExchangeReferenceCommands",
      "synchronous reference factory",
    ],
    [
      "  async function openTextQuote",
      "  function structuredClone(value){return value;}\n  async function openTextQuote",
      "reviewed reference command inventory",
    ],
  ] as const) {
    assert.ok(
      owner.includes(before),
      "actual constructor inventory mutation target",
    );
    const variant = owner.replace(before, after);
    parse(variant);
    assert.throws(
      () => validate(app, variant),
      (error: unknown) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
    );
  }
});
