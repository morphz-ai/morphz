import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isArrayBindingPattern,
  isAssignmentOperator,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isNamedImports,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type FunctionDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from "typescript/unstable/ast";
import {
  fixedViewportMetadata,
  fixedViewportSpans,
} from "./fixtures/conversation-viewport-29863c3f.js";

// Current owned contracts, not whole component/module SHA or an inverse chain.
// The embedded original registrations/actions are independent Git captures.
// Actual React lifetime, browser geometry and App validation are separate.
const files = {
  Owner: "../apps/web/src/features/exchange/useConversationViewport.ts",
  Conversation: "../apps/web/src/Conversation.tsx",
} as const;
type Sources = Record<keyof typeof files, string>;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  symbols: Map<Node, number | undefined>;
  imports: Map<number, { name: string; module: string; typeOnly: boolean }>;
  names: Map<number, string>;
};
const current = Object.fromEntries(
  Object.entries(files).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const stateNames = [
  "scroller",
  "prependPosition",
  "loadingEarlier",
  "earlierError",
  "revealedQuote",
  "loadingQuote",
  "latestButton",
  "positionKey",
  "saved",
  "previousPositionKey",
  "following",
  "initialized",
  "revealed",
  "awayFromLatest",
] as const;
const publicNames = [
  "scroller",
  "latestButton",
  "loadingEarlier",
  "earlierError",
  "awayFromLatest",
];
const registrationNames = [
  "positions",
  "revealInputId",
  "prependPosition",
  "revealedQuote",
  "loadingQuote",
  "previousPositionKey",
  "following",
  "initialized",
  "revealed",
  "positionKey",
  "saved",
  "setLoadingEarlier",
  "setEarlierError",
  "setAwayFromLatest",
];
const statePorts = [
  "conversationId",
  "focused",
  "focusedArtifactId",
  "focusedApplicationId",
  "focusedCognitiveKey",
  "positions",
  "revealInputId",
];
const commitPorts = [
  "contentVersion",
  "readVersion",
  "receipts",
  "onRead",
  "onFocusComposer",
  "onLoadEarlierHistory",
  "quoteReveal",
  "onQuoteUnavailable",
  "focused",
  "allInputs",
  "messages",
  "hasEarlierHistory",
  "setAllHistory",
  "client",
];
function walk(root: Node): Node[] {
  const result: Node[] = [];
  function visit(node: Node) {
    result.push(node);
    node.forEachChild((child) => {
      visit(child);
    });
  }
  visit(root);
  return result;
}
function parse(sources: Record<string, string>): Map<string, Parsed> {
  const cwd = "/conversation-viewport-contract",
    config = cwd + "/tsconfig.json";
  const fs = createVirtualFileSystem({
    ...Object.fromEntries(
      Object.entries(sources).map(([key, value]) => [
        cwd + "/" + key + ".tsx",
        value,
      ]),
    ),
    [config]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
      files: Object.keys(sources).map((key) => key + ".tsx"),
    }),
  });
  const api = new API({ cwd, fs }),
    snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal-parsed-source",
    );
    return new Map(
      Object.keys(sources).map((key) => {
        const source = project.program.getSourceFile(cwd + "/" + key + ".tsx")!,
          nodes = walk(source);
        const identifiers = nodes.filter(isIdentifier),
          symbols = project.checker.getSymbolAtLocation(identifiers);
        const resolved = new Map<Node, number | undefined>();
        identifiers.forEach((node, index) =>
          resolved.set(
            node,
            isShorthandPropertyAssignment(node.parent)
              ? project.checker.getShorthandAssignmentValueSymbol(node.parent)
                  ?.id
              : symbols[index]?.id,
          ),
        );
        const imports = new Map<
          number,
          { name: string; module: string; typeOnly: boolean }
        >();
        for (const declaration of source.statements.filter(
          isImportDeclaration,
        )) {
          const bindings = declaration.importClause?.namedBindings;
          if (bindings && isNamedImports(bindings))
            for (const entry of bindings.elements) {
              const id = resolved.get(entry.name);
              if (id !== undefined)
                imports.set(id, {
                  name: (entry.propertyName ?? entry.name).text,
                  module: isStringLiteral(declaration.moduleSpecifier)
                    ? declaration.moduleSpecifier.text
                    : "",
                  typeOnly: !!(
                    declaration.importClause?.phaseModifier ===
                      SyntaxKind.TypeKeyword || entry.isTypeOnly
                  ),
                });
            }
        }
        return [
          key,
          { source, nodes, symbols: resolved, imports, names: new Map() },
        ] as const;
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function shape(node: Node, parsed?: Parsed): unknown {
  // Type spelling, comments and whitespace are not runtime algorithms.
  if (isTypeNode(node)) return undefined;
  if (node.kind === SyntaxKind.JsxText && !node.getText().trim())
    return undefined;
  const children: unknown[] = [];
  node.forEachChild((child) => {
    const item = shape(child, parsed);
    if (item !== undefined) children.push(item);
  });
  const symbol = parsed?.symbols.get(node);
  return [
    node.kind,
    node.flags & (NodeFlags.Const | NodeFlags.Let | NodeFlags.OptionalChain),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length
      ? children
      : isStringLiteral(node)
        ? node.text
        : symbol === undefined
          ? node.getText()
          : (parsed?.names.get(symbol) ??
            parsed?.imports.get(symbol)?.name ??
            node.getText()),
  ];
}
function same(actual: Node, expected: Node, parsed: Parsed, rule: string) {
  assert.deepEqual(shape(actual, parsed), shape(expected), rule);
}
function symbol(parsed: Parsed, node: Node, rule: string): number {
  const id = parsed.symbols.get(node);
  assert.notEqual(id, undefined, rule);
  return id!;
}
function imported(
  parsed: Parsed,
  name: string,
  module: string,
  typeOnly = false,
): number {
  const matches = [...parsed.imports].filter(
    ([, entry]) =>
      entry.name === name &&
      entry.module === module &&
      entry.typeOnly === typeOnly,
  );
  assert.equal(matches.length, 1, "runtime-import:" + name);
  return matches[0]![0];
}
function calledViewportValues(parsed: Parsed, hook: FunctionDeclaration) {
  // Only these six consumed values belong to this role. A foreign same-named
  // export may still be imported/used by an independent feature elsewhere.
  const approved = new Map([
    ["useRef", "react"],
    ["useState", "react"],
    ["useEffect", "react"],
    ["useLayoutEffect", "react"],
    ["shouldFollow", "../../interaction.js"],
    ["locateTextQuote", "../../text-quote-dom.js"],
  ]);
  for (const call of walk(hook).filter(isCallExpression)) {
    if (!isIdentifier(call.expression)) continue;
    const id = parsed.symbols.get(call.expression);
    const entry = id === undefined ? undefined : parsed.imports.get(id);
    const name = entry?.name ?? call.expression.text;
    if (!approved.has(name)) continue;
    assert.ok(
      entry && !entry.typeOnly && entry.module === approved.get(name),
      "viewport-runtime-binding:" + name,
    );
  }
}
function unreassignedCapture(
  parsed: Parsed,
  component: FunctionDeclaration,
  id: number,
  before: Node,
  name: string,
) {
  // Reject rebinding only this original parameter before its role boundary.
  // Property updates and other local/domain symbols are not globally banned.
  const rule = "renderer-unreassigned-capture:" + name;
  for (const node of walk(component)) {
    if (node.end > before.pos) continue;
    if (
      isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      isIdentifier(node.left)
    )
      assert.notEqual(parsed.symbols.get(node.left), id, rule);
    if (
      (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
      (node.operator === SyntaxKind.PlusPlusToken ||
        node.operator === SyntaxKind.MinusMinusToken) &&
      isIdentifier(node.operand)
    )
      assert.notEqual(parsed.symbols.get(node.operand), id, rule);
  }
}
function allHistorySetter(parsed: Parsed, component: FunctionDeclaration) {
  const rule = "renderer-real-all-history-setter";
  const tuples = component
    .body!.statements.filter(isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        isArrayBindingPattern(declaration.name) &&
        declaration.name.elements.some(
          (element) =>
            isBindingElement(element) &&
            element.name &&
            isIdentifier(element.name) &&
            element.name.text === "allHistory",
        ),
    );
  assert.equal(tuples.length, 1, rule);
  const tuple = tuples[0]!;
  assert.ok(
    isArrayBindingPattern(tuple.name) && tuple.name.elements.length === 2,
    rule,
  );
  const first = tuple.name.elements[0]!,
    second = tuple.name.elements[1]!;
  assert.ok(
    isBindingElement(first) &&
      first.name &&
      isIdentifier(first.name) &&
      first.name.text === "allHistory" &&
      !first.initializer &&
      !first.dotDotDotToken,
    rule,
  );
  assert.ok(
    isBindingElement(second) &&
      second.name &&
      isIdentifier(second.name) &&
      !second.initializer &&
      !second.dotDotDotToken,
    rule,
  );
  assert.ok(
    tuple.initializer &&
      isCallExpression(tuple.initializer) &&
      isIdentifier(tuple.initializer.expression),
    rule,
  );
  const entry = parsed.imports.get(
    symbol(parsed, tuple.initializer.expression, rule),
  );
  assert.ok(
    entry &&
      entry.name === "useState" &&
      entry.module === "react" &&
      !entry.typeOnly,
    rule,
  );
  return symbol(parsed, second.name, rule);
}
function fn(parsed: Parsed, name: string): FunctionDeclaration {
  const found = parsed.source.statements
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "owned-hook:" + name);
  assert.ok(found[0]!.body, "owned-hook:" + name);
  assert.ok(
    !found[0]!.asteriskToken &&
      !found[0]!.modifiers?.some(
        (modifier) => modifier.kind === SyntaxKind.AsyncKeyword,
      ),
    "synchronous-hook:" + name,
  );
  return found[0]!;
}
function declaration(scope: Node, name: string): VariableDeclaration {
  const found = walk(scope)
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, "borrowed-binding:" + name);
  return found[0]!;
}
function bindingNames(pattern: Node, allowDefaults = false) {
  assert.ok(isObjectBindingPattern(pattern), "direct-object-bindings");
  return pattern.elements.map((entry) => {
    assert.ok(
      !entry.dotDotDotToken &&
        (allowDefaults || !entry.initializer) &&
        entry.name &&
        isIdentifier(entry.name),
      "direct-object-bindings",
    );
    return {
      key: (entry.propertyName ?? entry.name).getText(),
      value: entry.name,
    };
  });
}
function markBindings(
  parsed: Parsed,
  pattern: Node,
  expected: readonly string[],
  rule: string,
) {
  const entries = bindingNames(pattern);
  assert.deepEqual(
    entries.map((entry) => entry.key),
    expected,
    rule,
  );
  for (const entry of entries)
    parsed.names.set(symbol(parsed, entry.value, rule), entry.key);
}
function objectValues(node: Node, rule: string) {
  assert.ok(isObjectLiteralExpression(node), rule);
  return node.properties.map((property) => {
    assert.ok(
      isShorthandPropertyAssignment(property) || isPropertyAssignment(property),
      rule,
    );
    const name = property.name;
    assert.ok(isIdentifier(name), rule);
    return {
      key: name.text,
      value: isShorthandPropertyAssignment(property)
        ? property.name
        : property.initializer,
    };
  });
}
function directFields(
  node: Node,
  keys: readonly string[],
  references: Map<string, number>,
  parsed: Parsed,
  rule: string,
) {
  const entries = objectValues(node, rule);
  assert.deepEqual(
    entries.map((entry) => entry.key),
    keys,
    rule,
  );
  for (const entry of entries) {
    assert.ok(isIdentifier(entry.value), rule);
    assert.equal(
      symbol(parsed, entry.value, rule),
      references.get(entry.key),
      rule + ":" + entry.key,
    );
  }
}
const reference = parse({
  Reference:
    "function registration(){\n" +
    stateNames.map((name) => fixedViewportSpans[name]).join("\n") +
    "\n}\n" +
    ["loadEarlier", "acknowledgeVisibleReplies", "updateLatestIndicator"]
      .map(
        (name) => fixedViewportSpans[name as keyof typeof fixedViewportSpans],
      )
      .join("\n") +
    "\nfunction effects(){\n" +
    [0, 1, 2, 3, 4]
      .map(
        (index) =>
          fixedViewportSpans[
            ("effect" + index) as keyof typeof fixedViewportSpans
          ],
      )
      .join("\n") +
    "\n}\n" +
    "const onScroll=" +
    fixedViewportSpans.onScroll +
    ";\nconst returnLatest=" +
    fixedViewportSpans.returnLatest +
    ";",
}).get("Reference")!;
// The one new key branch and consumed focus, not a re-recorded old archive.
const cognitiveReference = parse({
  Cognitive: `
const positionKey = focused && focusedCognitiveKey !== undefined
  ? JSON.stringify(["cognitive", conversationId, focusedCognitiveKey]) : undefined;
function cognitiveRenderer() {
  const cognitiveFocusKey = focusedCognitiveObject
    ? cognitiveWorkSurfaceKey({ kind: "original", locator: focusedCognitiveObject }) : undefined;
  useEffect(() => setAllHistory(false), [focusedArtifactId, focusedApplicationId, cognitiveFocusKey]);
  const focused = !!(focusedArtifactId || focusedApplicationId || focusedCognitiveObject) && !allHistory;
  const readScope = projectConversationReadScope({
    inputs: allInputs, messages, outputs: client.boot!.outputs,
    scriptOutputs: client.boot?.scriptOutputs ?? [],
    scope: { focus: focused ? { artifactId: focusedArtifactId, applicationId: focusedApplicationId,
      cognitiveObject: focusedCognitiveObject } : {}, messageArray: "filter-always" },
  });
}`,
}).get("Cognitive")!;

function validate(sources: Sources) {
  const parsed = parse(sources),
    owner = parsed.get("Owner")!,
    renderer = parsed.get("Conversation")!;
  const state = fn(owner, "useConversationViewportState"),
    commit = fn(owner, "useConversationViewportCommit");
  const keyTypes = owner.nodes.filter(
    (node) =>
      node.kind === SyntaxKind.PropertySignature &&
      (node as Node & { name: Node }).name.getText() === "focusedCognitiveKey",
  );
  assert.equal(keyTypes.length, 1, "exact-cognitive-optional-state-key-type");
  const keyChildren: Node[] = [];
  keyTypes[0]!.forEachChild((child) => {
    keyChildren.push(child);
  });
  assert.deepEqual(
    keyChildren.map((node) => node.kind),
    [SyntaxKind.Identifier, SyntaxKind.QuestionToken, SyntaxKind.StringKeyword],
    "exact-cognitive-optional-state-key-type",
  );
  for (const name of ["useRef", "useState", "useEffect", "useLayoutEffect"])
    imported(owner, name, "react");
  for (const [name, path] of [
    ["shouldFollow", "../../interaction.js"],
    ["locateTextQuote", "../../text-quote-dom.js"],
  ])
    imported(owner, name!, path!);
  calledViewportValues(owner, state);
  calledViewportValues(owner, commit);
  // The only bridge is a module-private Symbol, not a public writer bag/store.
  const privateKey = declaration(owner.source, "viewportRegistration");
  assert.ok(
    privateKey.initializer &&
      isCallExpression(privateKey.initializer) &&
      isIdentifier(privateKey.initializer.expression) &&
      privateKey.initializer.expression.text === "Symbol",
    "private-registration-symbol",
  );
  assert.equal(
    owner.symbols.get(privateKey.initializer.expression),
    undefined,
    "private-registration-symbol",
  );
  assert.ok(
    isVariableStatement(privateKey.parent.parent),
    "private-registration-symbol",
  );
  assert.ok(
    !privateKey.parent.parent.modifiers?.some(
      (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
    ),
    "private-registration-symbol",
  );
  const privateId = symbol(
    owner,
    privateKey.name,
    "private-registration-symbol",
  );
  assert.equal(state.parameters.length, 1, "state-captured-ports");
  markBindings(
    owner,
    state.parameters[0]!.name,
    statePorts,
    "state-captured-ports",
  );
  const refs = new Map<string, number>();
  for (const parameter of bindingNames(state.parameters[0]!.name))
    refs.set(
      parameter.key,
      symbol(owner, parameter.value, "state-captured-ports"),
    );
  const statements = state.body!.statements;
  assert.equal(
    statements.length,
    stateNames.length + 1,
    "state-register-phase",
  );
  for (let index = 0; index < stateNames.length; index++) {
    const statement = statements[index]!;
    assert.ok(isVariableStatement(statement), "state-register-phase");
    const entries = statement.declarationList.declarations;
    assert.equal(entries.length, 1, "state-register-phase");
    const names = walk(entries[0]!.name)
      .filter(isBindingElement)
      .map((entry) => entry.name)
      .filter((name) => name !== undefined);
    if (isIdentifier(entries[0]!.name)) names.push(entries[0]!.name);
    for (const name of names)
      if (isIdentifier(name)) {
        refs.set(name.text, symbol(owner, name, "state-register-phase"));
        owner.names.set(symbol(owner, name, "state-register-phase"), name.text);
      }
    if (stateNames[index] === "positionKey") {
      const actual = entries[0]!.initializer,
        expected = declaration(
          cognitiveReference.source,
          "positionKey",
        ).initializer!;
      assert.ok(
        actual &&
          isConditionalExpression(actual) &&
          isConditionalExpression(expected),
        "exact-cognitive-position-key-branch",
      );
      assert.equal(
        statement.declarationList.flags & (NodeFlags.Const | NodeFlags.Let),
        NodeFlags.Const,
        "state-register-phase:positionKey",
      );
      same(
        entries[0]!.name,
        declaration(fn(reference, "registration"), "positionKey").name,
        owner,
        "state-register-phase:positionKey",
      );
      same(
        actual.condition,
        expected.condition,
        owner,
        "exact-cognitive-position-key-branch",
      );
      same(
        actual.whenTrue,
        expected.whenTrue,
        owner,
        "exact-cognitive-position-key-branch",
      );
      const json = walk(actual.whenTrue)
        .filter(isIdentifier)
        .filter((node) => node.text === "JSON");
      assert.equal(json.length, 1, "exact-cognitive-position-key-branch");
      assert.equal(
        owner.symbols.get(json[0]!),
        undefined,
        "exact-cognitive-position-key-branch",
      );
      same(
        actual.whenFalse,
        declaration(fn(reference, "registration"), "positionKey").initializer!,
        owner,
        "state-register-phase:positionKey",
      );
    } else
      same(
        statement,
        fn(reference, "registration").body!.statements[index]!,
        owner,
        "state-register-phase:" + stateNames[index],
      );
  }
  const returned = statements.at(-1)!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
    "public-facts-private-writers",
  );
  const fields = returned.expression.properties;
  assert.equal(
    fields.length,
    publicNames.length + 1,
    "public-facts-private-writers",
  );
  for (let index = 0; index < publicNames.length; index++) {
    const field = fields[index]!;
    assert.ok(
      isShorthandPropertyAssignment(field) && isIdentifier(field.name),
      "public-facts-private-writers",
    );
    assert.equal(
      field.name.text,
      publicNames[index],
      "public-facts-private-writers",
    );
    assert.equal(
      symbol(owner, field.name, "public-facts-private-writers"),
      refs.get(field.name.text),
      "public-facts-private-writers",
    );
  }
  const registration = fields.at(-1)!;
  assert.ok(
    isPropertyAssignment(registration) &&
      isComputedPropertyName(registration.name) &&
      isIdentifier(registration.name.expression),
    "public-facts-private-writers",
  );
  assert.equal(
    symbol(owner, registration.name.expression, "public-facts-private-writers"),
    privateId,
    "public-facts-private-writers",
  );
  directFields(
    registration.initializer,
    registrationNames,
    refs,
    owner,
    "private-registration-identity",
  );
  assert.equal(commit.parameters.length, 2, "commit-captured-ports");
  assert.ok(isIdentifier(commit.parameters[0]!.name), "commit-captured-ports");
  const viewportId = symbol(
    owner,
    commit.parameters[0]!.name,
    "commit-captured-ports",
  );
  markBindings(
    owner,
    commit.parameters[1]!.name,
    commitPorts,
    "commit-captured-ports",
  );
  const body = commit.body!.statements;
  assert.equal(body.length, 13, "commit-five-effects-actions-phase");
  for (const [index, keys] of [
    [0, ["scroller", "latestButton", "loadingEarlier"]],
    [1, registrationNames],
  ] as const) {
    const statement = body[index]!;
    assert.ok(isVariableStatement(statement), "commit-borrowed-registration");
    assert.equal(
      statement.declarationList.declarations.length,
      1,
      "commit-borrowed-registration",
    );
    const declaration = statement.declarationList.declarations[0]!;
    markBindings(owner, declaration.name, keys, "commit-borrowed-registration");
    const init = declaration.initializer;
    assert.ok(init, "commit-borrowed-registration");
    if (index === 0)
      assert.equal(
        symbol(owner, init, "commit-borrowed-registration"),
        viewportId,
        "commit-borrowed-registration",
      );
    else {
      assert.ok(
        isElementAccessExpression(init) &&
          isIdentifier(init.expression) &&
          init.argumentExpression &&
          isIdentifier(init.argumentExpression),
        "commit-borrowed-registration",
      );
      assert.equal(
        symbol(owner, init.expression, "commit-borrowed-registration"),
        viewportId,
        "commit-borrowed-registration",
      );
      assert.equal(
        symbol(owner, init.argumentExpression, "commit-borrowed-registration"),
        privateId,
        "commit-borrowed-registration",
      );
    }
  }
  for (const [index, name] of [
    "loadEarlier",
    "acknowledgeVisibleReplies",
    "updateLatestIndicator",
  ].entries()) {
    const declaration = body[index + 2]!;
    assert.ok(
      isFunctionDeclaration(declaration) && declaration.name?.text === name,
      "viewport-action:" + name,
    );
    same(
      declaration,
      reference.source.statements
        .filter(isFunctionDeclaration)
        .find((node) => node.name?.text === name)!,
      owner,
      "viewport-action:" + name,
    );
  }
  const originalEffects = fn(reference, "effects").body!.statements;
  for (let index = 0; index < 5; index++) {
    const actual = body[index + 5]!;
    assert.ok(
      isExpressionStatement(actual) &&
        isCallExpression(actual.expression) &&
        isIdentifier(actual.expression.expression),
      "viewport-effect:" + index,
    );
    const name = index === 2 ? "useEffect" : "useLayoutEffect";
    assert.equal(
      symbol(owner, actual.expression.expression, "viewport-effect:" + index),
      imported(owner, name, "react"),
      "viewport-effect:" + index,
    );
    same(actual, originalEffects[index]!, owner, "viewport-effect:" + index);
  }
  for (const [index, name] of ["onScroll", "returnLatest"].entries()) {
    const actual = body[index + 10]!;
    assert.ok(isVariableStatement(actual), "viewport-action:" + name);
    const binding = actual.declarationList.declarations[0]!;
    assert.ok(
      isIdentifier(binding.name) &&
        binding.name.text === name &&
        binding.initializer,
      "viewport-action:" + name,
    );
    same(
      binding.initializer,
      declaration(reference.source, name).initializer!,
      owner,
      "viewport-action:" + name,
    );
  }
  const actionReturn = body[12]!;
  assert.ok(
    isReturnStatement(actionReturn) && actionReturn.expression,
    "direct-action-return",
  );
  const actions = new Map(
    ["loadEarlier", "onScroll", "returnLatest"].map((name) => {
      const match = walk(commit).find(
        (node) =>
          (isFunctionDeclaration(node) && node.name?.text === name) ||
          (isVariableDeclaration(node) &&
            isIdentifier(node.name) &&
            node.name.text === name),
      )!;
      return [
        name,
        symbol(
          owner,
          (match as FunctionDeclaration | VariableDeclaration).name!,
          "direct-action-return",
        ),
      ] as const;
    }),
  );
  directFields(
    actionReturn.expression,
    [...actions.keys()],
    actions,
    owner,
    "direct-action-return",
  );

  const hookPath = "./features/exchange/useConversationViewport.js";
  const stateImport = imported(
      renderer,
      "useConversationViewportState",
      hookPath,
    ),
    commitImport = imported(
      renderer,
      "useConversationViewportCommit",
      hookPath,
    );
  const component = fn(renderer, "Conversation");
  const callFor = (id: number, rule: string) => {
    const calls = walk(component)
      .filter(isCallExpression)
      .filter((call) => renderer.symbols.get(call.expression) === id);
    assert.equal(calls.length, 1, rule);
    return calls[0]!;
  };
  const stateCall = callFor(stateImport, "actual-state-hook-call"),
    commitCall = callFor(commitImport, "actual-commit-hook-call");
  assert.ok(
    isVariableDeclaration(stateCall.parent) &&
      stateCall.parent.initializer === stateCall &&
      isIdentifier(stateCall.parent.name),
    "actual-state-hook-call",
  );
  const handle = stateCall.parent.name,
    handleId = symbol(renderer, handle, "actual-state-hook-call");
  const parameterBindings = bindingNames(component.parameters[0]!.name, true);
  for (const entry of parameterBindings)
    renderer.names.set(
      symbol(renderer, entry.value, "renderer-captured-ports"),
      entry.key === "inputs" ? "allInputs" : entry.key,
    );
  const renderRefs = new Map(
    parameterBindings.map((entry) => [
      entry.key,
      symbol(renderer, entry.value, "renderer-captured-ports"),
    ]),
  );
  // The original Conversation names its captured inputs parameter allInputs.
  renderRefs.set("allInputs", renderRefs.get("inputs")!);
  renderRefs.set("setAllHistory", allHistorySetter(renderer, component));
  renderer.names.set(renderRefs.get("setAllHistory")!, "setAllHistory");
  const focusKey = declaration(component, "cognitiveFocusKey");
  renderRefs.set(
    "focusedCognitiveKey",
    symbol(renderer, focusKey.name, "exact-cognitive-renderer-focus"),
  );
  imported(renderer, "cognitiveWorkSurfaceKey", "./host/work-surface.js");
  imported(renderer, "projectConversationReadScope", "./conversation-read.js");
  same(
    focusKey.initializer!,
    declaration(cognitiveReference.source, "cognitiveFocusKey").initializer!,
    renderer,
    "exact-cognitive-renderer-focus",
  );
  unreassignedCapture(
    renderer,
    component,
    renderRefs.get("focusedCognitiveObject")!,
    focusKey,
    "focusedCognitiveObject",
  );
  for (const name of ["focused", "readScope"])
    same(
      declaration(component, name).initializer!,
      declaration(cognitiveReference.source, name).initializer!,
      renderer,
      "exact-cognitive-renderer-focus",
    );
  const keyExpression = focusKey.initializer!;
  assert.ok(
    isConditionalExpression(keyExpression) &&
      isCallExpression(keyExpression.whenTrue),
    "exact-cognitive-renderer-focus",
  );
  assert.equal(
    symbol(
      renderer,
      keyExpression.whenTrue.expression,
      "exact-cognitive-renderer-focus",
    ),
    imported(renderer, "cognitiveWorkSurfaceKey", "./host/work-surface.js"),
    "exact-cognitive-renderer-focus",
  );
  const readExpression = declaration(component, "readScope").initializer!;
  assert.ok(isCallExpression(readExpression), "exact-cognitive-renderer-focus");
  assert.equal(
    symbol(
      renderer,
      readExpression.expression,
      "exact-cognitive-renderer-focus",
    ),
    imported(
      renderer,
      "projectConversationReadScope",
      "./conversation-read.js",
    ),
    "exact-cognitive-renderer-focus",
  );
  const historyEffects = walk(component)
    .filter(isCallExpression)
    .filter(
      (call) =>
        walk(call).some(
          (node) =>
            isIdentifier(node) &&
            renderer.symbols.get(node) === renderRefs.get("setAllHistory"),
        ) &&
        isIdentifier(call.expression) &&
        renderer.imports.get(renderer.symbols.get(call.expression)!)?.name ===
          "useEffect",
    );
  assert.equal(historyEffects.length, 1, "exact-cognitive-all-history-reset");
  assert.equal(
    symbol(
      renderer,
      historyEffects[0]!.expression,
      "exact-cognitive-all-history-reset",
    ),
    imported(renderer, "useEffect", "react"),
    "exact-cognitive-all-history-reset",
  );
  const expectedHistoryEffect = fn(cognitiveReference, "cognitiveRenderer")
    .body!.statements[1]!;
  assert.ok(
    isExpressionStatement(expectedHistoryEffect),
    "exact-cognitive-all-history-reset",
  );
  same(
    historyEffects[0]!,
    expectedHistoryEffect.expression,
    renderer,
    "exact-cognitive-all-history-reset",
  );
  for (const name of ["focused", "contentVersion", "readVersion", "receipts"]) {
    const entry = walk(component)
      .filter(isVariableDeclaration)
      .find(
        (node) =>
          (isIdentifier(node.name) && node.name.text === name) ||
          (isArrayBindingPattern(node.name) &&
            node.name.elements.some(
              (item) =>
                isBindingElement(item) &&
                item.name &&
                isIdentifier(item.name) &&
                item.name.text === name,
            )),
      );
    assert.ok(entry, "renderer-captured-ports");
    const identifier = walk(entry.name).find(
      (node) => isIdentifier(node) && node.text === name,
    )!;
    renderRefs.set(
      name,
      symbol(renderer, identifier, "renderer-captured-ports"),
    );
  }
  unreassignedCapture(
    renderer,
    component,
    renderRefs.get("positions")!,
    stateCall,
    "positions",
  );
  unreassignedCapture(
    renderer,
    component,
    renderRefs.get("client")!,
    commitCall,
    "client",
  );
  assert.equal(stateCall.arguments.length, 1, "renderer-state-captured-ports");
  directFields(
    stateCall.arguments[0]!,
    statePorts,
    renderRefs,
    renderer,
    "renderer-state-captured-ports",
  );
  assert.equal(
    commitCall.arguments.length,
    2,
    "renderer-commit-captured-ports",
  );
  assert.ok(
    isIdentifier(commitCall.arguments[0]!),
    "renderer-commit-captured-ports",
  );
  assert.equal(
    symbol(
      renderer,
      commitCall.arguments[0]!,
      "renderer-commit-captured-ports",
    ),
    handleId,
    "renderer-commit-captured-ports",
  );
  directFields(
    commitCall.arguments[1]!,
    commitPorts,
    renderRefs,
    renderer,
    "renderer-commit-captured-ports",
  );
  // Keep original phase without freezing the independent timeline algorithms.
  const groups = declaration(component, "groups"),
    stop = walk(component).find(
      (node) =>
        isFunctionDeclaration(node) && node.name?.text === "stopResponse",
    )!;
  assert.ok(
    stop.end < stateCall.pos && stateCall.end < groups.pos,
    "renderer-register-phase",
  );
  for (const name of ["receipts", "readVersion", "contentVersion"])
    assert.ok(
      declaration(component, name).end < commitCall.pos,
      "renderer-commit-phase",
    );
  const renderReturn = component.body!.statements.find(isReturnStatement)!;
  assert.ok(commitCall.end < renderReturn.pos, "renderer-commit-phase");
  const publicBinding = walk(component)
    .filter(isVariableDeclaration)
    .filter(
      (node) =>
        node.initializer && renderer.symbols.get(node.initializer) === handleId,
    );
  assert.equal(publicBinding.length, 1, "renderer-direct-facts");
  const facts = bindingNames(publicBinding[0]!.name);
  assert.deepEqual(
    facts.map((entry) => entry.key),
    publicNames,
    "renderer-direct-facts",
  );
  const factIds = new Map(
    facts.map((entry) => [
      entry.key,
      symbol(renderer, entry.value, "renderer-direct-facts"),
    ]),
  );
  assert.ok(
    isVariableDeclaration(commitCall.parent) &&
      commitCall.parent.initializer === commitCall,
    "renderer-direct-actions",
  );
  const actionEntries = bindingNames(commitCall.parent.name);
  assert.deepEqual(
    actionEntries.map((entry) => entry.key),
    [...actions.keys()],
    "renderer-direct-actions",
  );
  const actionIds = new Map(
    actionEntries.map((entry) => [
      entry.key,
      symbol(renderer, entry.value, "renderer-direct-actions"),
    ]),
  );
  const attributes = walk(component).filter(isJsxAttribute);
  function attribute(className: string, name: string) {
    const found = attributes.filter(
      (attr) =>
        attr.name.getText() === name &&
        walk(attr.parent).some(
          (node) =>
            isJsxAttribute(node) &&
            node.name.getText() === "className" &&
            node.initializer &&
            isStringLiteral(node.initializer) &&
            node.initializer.text === className,
        ),
    );
    assert.equal(
      found.length,
      1,
      "dom-direct-binding:" + className + ":" + name,
    );
    return found[0]!;
  }
  function expression(attr: Node & { initializer?: Node }, rule: string) {
    assert.ok(
      attr.initializer &&
        isJsxExpression(attr.initializer) &&
        attr.initializer.expression,
      rule,
    );
    return attr.initializer.expression;
  }
  for (const [css, name, id] of [
    ["conversation", "ref", factIds.get("scroller")],
    ["conversation", "onScroll", actionIds.get("onScroll")],
    ["new-exchange", "ref", factIds.get("latestButton")],
    ["new-exchange", "onClick", actionIds.get("returnLatest")],
    ["conversation-load-older", "disabled", factIds.get("loadingEarlier")],
  ] as const) {
    const rule = "dom-direct-binding:" + css + ":" + name,
      value = expression(attribute(css, name), rule);
    assert.ok(isIdentifier(value), rule);
    assert.equal(symbol(renderer, value, rule), id, rule);
  }
  const older = expression(
    attribute("conversation-load-older", "onClick"),
    "dom-older-action",
  );
  assert.ok(
    isArrowFunction(older) &&
      isVoidExpression(older.body) &&
      isCallExpression(older.body.expression),
    "dom-older-action",
  );
  assert.equal(
    symbol(renderer, older.body.expression.expression, "dom-older-action"),
    actionIds.get("loadEarlier"),
    "dom-older-action",
  );
  assert.equal(older.body.expression.arguments.length, 0, "dom-older-action");
  for (const [css, name] of [
    ["conversation-load-error", "earlierError"],
    ["conversation-return", "awayFromLatest"],
  ] as const) {
    const elements = walk(renderReturn)
      .filter(isJsxElement)
      .filter((element) =>
        element.openingElement.attributes.properties.some(
          (attr) =>
            isJsxAttribute(attr) &&
            attr.name.getText() === "className" &&
            attr.initializer &&
            isStringLiteral(attr.initializer) &&
            attr.initializer.text === css,
        ),
      );
    assert.equal(elements.length, 1, "dom-fact:" + name);
    const element = elements[0]!;
    let guard = element.parent;
    while (isParenthesizedExpression(guard)) guard = guard.parent;
    assert.ok(
      isBinaryExpression(guard) &&
        guard.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken &&
        isIdentifier(guard.left),
      "dom-fact:" + name,
    );
    assert.equal(
      symbol(renderer, guard.left, "dom-fact:" + name),
      factIds.get(name),
      "dom-fact:" + name,
    );
    if (name === "earlierError") {
      assert.ok(
        element.openingElement.attributes.properties.some(
          (attr) =>
            isJsxAttribute(attr) &&
            attr.name.getText() === "role" &&
            attr.initializer &&
            isStringLiteral(attr.initializer) &&
            attr.initializer.text === "alert",
        ),
        "dom-fact:earlierError",
      );
      const children = element.children.filter(
        (child) => child.kind !== SyntaxKind.JsxText || child.getText().trim(),
      );
      assert.equal(children.length, 1, "dom-fact:earlierError");
      const content = children[0]!;
      assert.ok(
        isJsxExpression(content) &&
          content.expression &&
          isIdentifier(content.expression),
        "dom-fact:earlierError",
      );
      assert.equal(
        symbol(renderer, content.expression, "dom-fact:earlierError"),
        factIds.get("earlierError"),
        "dom-fact:earlierError",
      );
    }
  }
  assert.ok(
    walk(stop).some(
      (node) =>
        isIdentifier(node) &&
        renderer.symbols.get(node) === factIds.get("scroller"),
    ),
    "stop-focus-borrowed-scroller",
  );
}

function changed(
  source: Sources,
  key: keyof Sources,
  before: string,
  after: string,
): Sources {
  // Preserve the old literal state-call mutations while borrowing the one
  // new key in that same actual call, including phase/wrapper counterfactuals.
  if (key === "Conversation") {
    const old = "    focusedApplicationId,\n    positions,",
      next =
        "    focusedApplicationId,\n    focusedCognitiveKey: cognitiveFocusKey,\n    positions,";
    before = before.replace(old, next);
    after = after.replace(old, next);
  }
  assert.equal(
    source[key].split(before).length,
    2,
    "unique-counterfactual-target",
  );
  const result = { ...source, [key]: source[key].replace(before, after) };
  parse(result);
  return result; // Counterfactual parses independently before rejection.
}
function rejects(
  key: keyof Sources,
  before: string,
  after: string,
  rule: string,
) {
  const candidate = changed(current, key, before, after);
  assert.throws(
    () => validate(candidate),
    (error) =>
      error instanceof assert.AssertionError && error.message.includes(rule),
    rule,
  );
}
test("viewport finite original archive is immutable and needs no historical checkout", () => {
  assert.equal(
    fixedViewportMetadata.git,
    "29863c3f227edd6267826e423f764b17779024f1",
  );
  assert.equal(Object.keys(fixedViewportSpans).length, 25);
  for (const [name, raw] of Object.entries(fixedViewportSpans)) {
    const expected =
      fixedViewportMetadata.spans[
        name as keyof typeof fixedViewportMetadata.spans
      ];
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      expected.sha256,
    );
    assert.equal(Buffer.byteLength(raw), expected.bytes);
  }
});
test("actual viewport hooks preserve registration, phase and direct renderer/DOM consumption", () =>
  validate(current));
test("cognitive viewport key accepts only the optional string and exact focused opaque tuple branch", () => {
  for (const [before, after, rule] of [
    [
      "focusedCognitiveKey?: string;",
      "focusedCognitiveKey: string;",
      "exact-cognitive-optional-state-key-type",
    ],
    [
      "focusedCognitiveKey?: string;",
      "focusedCognitiveKey?: unknown;",
      "exact-cognitive-optional-state-key-type",
    ],
    [
      "focused && focusedCognitiveKey !== undefined",
      "focusedCognitiveKey !== undefined",
      "exact-cognitive-position-key-branch",
    ],
    [
      "focused && focusedCognitiveKey !== undefined",
      "focused && !!focusedCognitiveKey",
      "exact-cognitive-position-key-branch",
    ],
    [
      'JSON.stringify(["cognitive", conversationId, focusedCognitiveKey])',
      'JSON.stringify(["cognitive", focusedCognitiveKey])',
      "exact-cognitive-position-key-branch",
    ],
    [
      'JSON.stringify(["cognitive", conversationId, focusedCognitiveKey])',
      'conversationId + ":" + focusedCognitiveKey',
      "exact-cognitive-position-key-branch",
    ],
    [
      "const positionKey =",
      "let positionKey =",
      "state-register-phase:positionKey",
    ],
  ])
    rejects("Owner", before!, after!, rule!);
  const shadow = {
    ...current,
    Owner: 'import { JSON } from "../../fake-json.js";\n' + current.Owner,
  };
  parse(shadow);
  assert.throws(
    () => validate(shadow),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("exact-cognitive-position-key-branch"),
  );
});
test("cognitive renderer focus requires the same original identity, real helper, key port and reset", () => {
  const parsed = parse(current).get("Conversation")!;
  const component = fn(parsed, "Conversation");
  const property = (scope: Node, name: string) => {
    const found = walk(scope)
      .filter(isPropertyAssignment)
      .filter((node) => node.name.getText() === name);
    assert.equal(found.length, 1, "unique-new-counterfactual-property:" + name);
    return found[0]!;
  };
  const replaceNode = (node: Node, replacement: string): Sources => {
    const result = {
      ...current,
      Conversation:
        current.Conversation.slice(0, node.getStart()) +
        replacement +
        current.Conversation.slice(node.end),
    };
    parse(result);
    return result;
  };
  const keyPort = property(component, "focusedCognitiveKey");
  const keyPorts = keyPort.parent;
  assert.ok(isObjectLiteralExpression(keyPorts));
  const focusKey = declaration(component, "cognitiveFocusKey").initializer!;
  assert.ok(isConditionalExpression(focusKey));
  assert.ok(isCallExpression(focusKey.whenTrue));
  const focused = declaration(component, "focused").initializer!;
  const focusedOriginal = walk(focused)
    .filter(isBinaryExpression)
    .filter(
      (node) =>
        node.operatorToken.kind === SyntaxKind.BarBarToken &&
        isIdentifier(node.right) &&
        node.right.text === "focusedCognitiveObject",
    );
  assert.equal(focusedOriginal.length, 1, "unique-new-focus-counterfactual");
  const reset = walk(component)
    .filter(isCallExpression)
    .filter(
      (node) =>
        node.expression.getText() === "useEffect" &&
        walk(node.arguments[1]!).some(
          (child) => isIdentifier(child) && child.text === "cognitiveFocusKey",
        ),
    );
  assert.equal(reset.length, 1, "unique-new-reset-counterfactual");
  const cases: [Node, string, string][] = [
    [
      keyPorts,
      "{" +
        keyPorts.properties
          .filter((node) => node !== keyPort)
          .map((node) => node.getText())
          .join(",") +
        "}",
      "renderer-state-captured-ports",
    ],
    [keyPort.initializer, "focusedArtifactId", "renderer-state-captured-ports"],
    [
      property(focusKey.whenTrue, "locator").initializer,
      "{ ...focusedCognitiveObject }",
      "exact-cognitive-renderer-focus",
    ],
    [
      focusedOriginal[0]!,
      focusedOriginal[0]!.left.getText(),
      "exact-cognitive-renderer-focus",
    ],
    [
      property(declaration(component, "readScope"), "cognitiveObject")
        .initializer,
      "undefined",
      "exact-cognitive-renderer-focus",
    ],
    [
      reset[0]!.arguments[1]!,
      "[focusedArtifactId, focusedApplicationId]",
      "exact-cognitive-all-history-reset",
    ],
  ];
  for (const [node, replacement, rule] of cases)
    assert.throws(
      () => validate(replaceNode(node, replacement)),
      (error) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
      rule,
    );
  const foreign = replaceNode(focusKey.whenTrue.expression, "foreignKey");
  foreign.Conversation =
    'import { cognitiveWorkSurfaceKey as foreignKey } from "./fake-work-surface.js";\n' +
    foreign.Conversation;
  parse(foreign);
  assert.throws(
    () => validate(foreign),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("exact-cognitive-renderer-focus"),
  );
});
test("viewport permits unrelated JSX/comments/type annotations/domain exports and real runtime aliases", () => {
  let candidate: Sources = {
    ...current,
    Owner:
      current.Owner +
      "\nexport function unrelated(value:number){return value+1;}\n",
    Conversation:
      'import type { CSSProperties } from "react";\nimport "./unrelated-feature.css";\n' +
      current.Conversation,
  };
  candidate = changed(
    candidate,
    "Conversation",
    "{notice}",
    '{/* independent renderer detail */}{notice}<span data-independent="yes" />',
  );
  candidate = changed(
    candidate,
    "Owner",
    "const saved = positions.get(positionKey);",
    "const saved: ExchangePosition | undefined = positions.get(positionKey);",
  );
  candidate = changed(
    candidate,
    "Owner",
    "  useLayoutEffect,",
    "  useLayoutEffect as commitLayout,",
  );
  candidate = {
    ...candidate,
    Owner: candidate.Owner.replaceAll(
      "  useLayoutEffect(() =>",
      "  commitLayout(() =>",
    ),
  };
  candidate = changed(
    candidate,
    "Conversation",
    "  useConversationViewportState,",
    "  useConversationViewportState as registerViewport,",
  );
  candidate = changed(
    candidate,
    "Conversation",
    "= useConversationViewportState({",
    "= registerViewport({",
  );
  candidate = changed(
    candidate,
    "Owner",
    "import { shouldFollow }",
    "import { shouldFollow as followsViewport }",
  );
  candidate = changed(
    candidate,
    "Owner",
    "following.current = shouldFollow(",
    "following.current = followsViewport(",
  );
  candidate = changed(
    candidate,
    "Owner",
    "import { locateTextQuote }",
    "import { locateTextQuote as quoteRange }",
  );
  candidate = changed(
    candidate,
    "Owner",
    "const range = locateTextQuote(",
    "const range = quoteRange(",
  );
  validate(candidate);
  // Same-named foreign exports may legitimately belong to another feature;
  // only the values actually consumed by these viewport hooks are governed.
  candidate = {
    ...candidate,
    Owner:
      'import { useRef as featureRef, locateTextQuote as featureRange } from "../../independent-feature.js";\n' +
      candidate.Owner +
      "\nexport function independentFeature(value: string) { return featureRef(featureRange(value)); }\n",
  };
  candidate = changed(candidate, "Owner", "  useRef,", "  useRef as stateRef,");
  candidate = {
    ...candidate,
    Owner: candidate.Owner.replaceAll("useRef<", "stateRef<").replaceAll(
      "useRef(",
      "stateRef(",
    ),
  };
  validate(candidate);
  candidate = changed(
    candidate,
    "Conversation",
    "useState, type ReactNode",
    "useState as renderState, type ReactNode",
  );
  candidate = {
    ...candidate,
    Conversation: candidate.Conversation.replaceAll("useState<", "renderState<")
      .replaceAll("useState(", "renderState(")
      .replaceAll("setAllHistory", "changeHistory"),
  };
  candidate = changed(
    candidate,
    "Conversation",
    "      changeHistory,\n      client,",
    "      setAllHistory: changeHistory,\n      client,",
  );
  candidate = changed(
    candidate,
    "Conversation",
    "  onOpenScript,\n  positions,\n  revealInputId,",
    "  onOpenScript,\n  positions: capturedPositions,\n  revealInputId,",
  );
  candidate = changed(
    candidate,
    "Conversation",
    "    positions,\n    revealInputId,\n  });",
    "    positions: capturedPositions,\n    revealInputId,\n  });",
  );
  const componentStart = candidate.Conversation.indexOf(
    "export function Conversation(",
  );
  const componentEnd = candidate.Conversation.indexOf(
    "export function StopResponse(",
  );
  const componentText = candidate.Conversation.slice(
    componentStart,
    componentEnd,
  )
    .replace(
      "  onRetry,\n  client,\n  onOpen,",
      "  onRetry,\n  client: capturedClient,\n  onOpen,",
    )
    .replaceAll("client.", "capturedClient.")
    .replaceAll("client={client}", "client={capturedClient}")
    .replace("      client,\n    },", "      client: capturedClient,\n    },");
  candidate = {
    ...candidate,
    Conversation:
      candidate.Conversation.slice(0, componentStart) +
      componentText +
      candidate.Conversation.slice(componentEnd),
  };
  validate(candidate);
  candidate = changed(
    candidate,
    "Conversation",
    "  const viewport = registerViewport({",
    "  function independentLocal(positions: Map<string, number>, client: { online: boolean }) {\n" +
      "    positions = new Map(positions); client = { online: true }; return { positions, client };\n" +
      "  }\n  const viewport = registerViewport({",
  );
  validate(candidate);
});
test("viewport state rejects mirrored Maps, changed initialization/timing and extra registration", () => {
  rejects(
    "Owner",
    "const saved = positions.get(positionKey);",
    "const saved = new Map(positions).get(positionKey);",
    "state-register-phase:saved",
  );
  rejects(
    "Owner",
    "const saved = positions.get(positionKey);",
    "const saved = useRef(positions.get(positionKey)).current;",
    "state-register-phase:saved",
  );
  rejects(
    "Owner",
    "const initialized = useRef(false);",
    "const initialized = useRef(true);",
    "state-register-phase:initialized",
  );
  rejects(
    "Owner",
    'const [earlierError, setEarlierError] = useState("");',
    'const extra=useState(false);\n  const [earlierError, setEarlierError] = useState("");',
    "state-register-phase",
  );
  rejects(
    "Owner",
    "export function useConversationViewportState(",
    "export async function useConversationViewportState(",
    "synchronous-hook:useConversationViewportState",
  );
});
test("viewport private registration rejects public writers, clones and substituted refs", () => {
  rejects(
    "Owner",
    "    [viewportRegistration]: {",
    "    registration: {",
    "public-facts-private-writers",
  );
  rejects(
    "Owner",
    "      positions,",
    "      positions: new Map(positions),",
    "private-registration-identity",
  );
  rejects(
    "Owner",
    "} = viewport[viewportRegistration];",
    "} = { ...viewport[viewportRegistration] };",
    "commit-borrowed-registration",
  );
  rejects(
    "Owner",
    "const viewportRegistration = Symbol(",
    "export const viewportRegistration = Symbol(",
    "private-registration-symbol",
  );
  rejects(
    "Owner",
    "const viewportRegistration = Symbol(",
    "function Symbol(value: string) { return value; }\nconst viewportRegistration = Symbol(",
    "private-registration-symbol",
  );
});
test("viewport actions preserve exact preload, read/focus ordering and return-latest behavior", () => {
  rejects(
    "Owner",
    "if (!onLoadEarlierHistory || loadingEarlier) return;",
    "if (!onLoadEarlierHistory) return;",
    "viewport-action:loadEarlier",
  );
  rejects(
    "Owner",
    '!document.querySelector("dialog[open]")',
    "true",
    "viewport-action:acknowledgeVisibleReplies",
  );
  rejects(
    "Owner",
    "      acknowledgeVisibleReplies();",
    "      setAwayFromLatest(false);\n      acknowledgeVisibleReplies();",
    "viewport-action:updateLatestIndicator",
  );
  rejects(
    "Owner",
    "following.current = shouldFollow(",
    "following.current = Boolean(",
    "viewport-action:onScroll",
  );
  rejects(
    "Owner",
    "    following.current = true;\n    if (scroller.current)",
    "    following.current = false;\n    if (scroller.current)",
    "viewport-action:returnLatest",
  );
  rejects(
    "Owner",
    "return { loadEarlier, onScroll, returnLatest };",
    "return { loadEarlier, onScroll: () => onScroll(), returnLatest };",
    "direct-action-return",
  );
});
test("viewport commits preserve five effect phases/dependencies and quote cleanup/history policies", () => {
  rejects(
    "Owner",
    "[contentVersion, readVersion, revealInputId, positionKey, onRead]",
    "[contentVersion, readVersion, revealInputId, positionKey]",
    "viewport-effect:0",
  );
  rejects(
    "Owner",
    "[contentVersion, loadingEarlier, positionKey]",
    "[]",
    "viewport-effect:1",
  );
  rejects(
    "Owner",
    'window.addEventListener("focus", read);',
    'window.addEventListener("blur", read);',
    "viewport-effect:2",
  );
  rejects(
    "Owner",
    "return () => observer.disconnect();",
    "return () => {};",
    "viewport-effect:3",
  );
  rejects(
    "Owner",
    "[quoteReveal, focused, contentVersion, hasEarlierHistory]",
    "[quoteReveal, focused, contentVersion, hasEarlierHistory, client]",
    "viewport-effect:4",
  );
  rejects(
    "Owner",
    "      clearTimeout(timeout);",
    "      void timeout;",
    "viewport-effect:4",
  );
  rejects(
    "Owner",
    "    const range = locateTextQuote(quoteReveal.quote);",
    "    const range = null;",
    "viewport-effect:4",
  );
  rejects(
    "Owner",
    "  return { loadEarlier, onScroll, returnLatest };",
    "  useEffect(() => {}, []);\n  return { loadEarlier, onScroll, returnLatest };",
    "commit-five-effects-actions-phase",
  );
});
test("viewport rejects wrappers/latest ports/shadow imports and changed actual DOM binding", () => {
  rejects(
    "Conversation",
    "    positions,\n    revealInputId,\n  });",
    "    positions: new Map(positions),\n    revealInputId,\n  });",
    "renderer-state-captured-ports",
  );
  rejects(
    "Conversation",
    "      client,\n    },",
    "      client: latestClient.current,\n    },",
    "renderer-commit-captured-ports",
  );
  rejects(
    "Conversation",
    "  const viewport = useConversationViewportState({",
    "  function useConversationViewportState(value: unknown) { return value; }\n  const viewport = useConversationViewportState({",
    "actual-state-hook-call",
  );
  rejects(
    "Conversation",
    "      onScroll={onScroll}",
    "      onScroll={() => onScroll()}",
    "dom-direct-binding:conversation:onScroll",
  );
  rejects(
    "Conversation",
    "            onClick={returnLatest}",
    "            onClick={() => returnLatest()}",
    "dom-direct-binding:new-exchange:onClick",
  );
  rejects(
    "Conversation",
    "      ref={scroller}",
    "      ref={otherScroller}",
    "dom-direct-binding:conversation:ref",
  );
  rejects(
    "Conversation",
    "{earlierError && (",
    "{true && (",
    "dom-fact:earlierError",
  );
  rejects(
    "Conversation",
    "{awayFromLatest && (",
    "{true && (",
    "dom-fact:awayFromLatest",
  );
  rejects(
    "Owner",
    '":focus:" + (focusedArtifactId ?? focusedApplicationId)',
    '":focus:" + focusedApplicationId',
    "state-register-phase:positionKey",
  );
  rejects(
    "Conversation",
    "  useConversationViewportState,",
    "  type useConversationViewportState,",
    "runtime-import:useConversationViewportState",
  );
  rejects(
    "Conversation",
    '  type ExchangePosition,\n} from "./features/exchange/useConversationViewport.js";',
    '  type ExchangePosition,\n} from "./features/exchange/fakeViewport.js";',
    "runtime-import:useConversationViewportState",
  );
});
test("viewport registration/commit reject wrappers and wrong renderer phase", () => {
  const stateBlock =
    "  const viewport = useConversationViewportState({\n    conversationId,\n    focused,\n    focusedArtifactId,\n    focusedApplicationId,\n    positions,\n    revealInputId,\n  });";
  rejects(
    "Conversation",
    stateBlock,
    stateBlock
      .replace(
        "useConversationViewportState({",
        "(() => useConversationViewportState({",
      )
      .replace("\n  });", "\n  }))();"),
    "actual-state-hook-call",
  );
  const commitStart = current.Conversation.indexOf(
    "  const { loadEarlier, onScroll, returnLatest } = useConversationViewportCommit(",
  );
  assert.ok(commitStart > 0);
  const commitEnd = current.Conversation.indexOf("\n  );", commitStart) + 6;
  const commitBlock = current.Conversation.slice(commitStart, commitEnd);
  let candidate = changed(current, "Conversation", commitBlock, "");
  candidate = changed(
    candidate,
    "Conversation",
    "  const contentVersion =",
    commitBlock + "\n  const contentVersion =",
  );
  assert.throws(
    () => validate(candidate),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("renderer-commit-phase"),
    "renderer-commit-phase",
  );
  candidate = changed(current, "Conversation", stateBlock, "");
  candidate = changed(
    candidate,
    "Conversation",
    "  const groups = conversationGroups(inputs, readScope.messages);",
    "  const groups = conversationGroups(inputs, readScope.messages);\n" +
      stateBlock,
  );
  assert.throws(
    () => validate(candidate),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("renderer-register-phase"),
    "renderer-register-phase",
  );
});
test("viewport nominal ports reject foreign value imports, rebound inputs and fake React setter", () => {
  const foreignRef = changed(
    {
      ...current,
      Owner:
        'import { useRef as foreignRef } from "../../fake-react.js";\n' +
        current.Owner,
    },
    "Owner",
    "const scroller = useRef<",
    "const scroller = foreignRef<",
  );
  assert.throws(
    () => validate(foreignRef),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("viewport-runtime-binding:useRef"),
    "viewport-runtime-binding:useRef",
  );
  const foreignQuote = changed(
    {
      ...current,
      Owner:
        'import { locateTextQuote as foreignRange } from "../../fake-quote.js";\n' +
        current.Owner,
    },
    "Owner",
    "const range = locateTextQuote(",
    "const range = foreignRange(",
  );
  assert.throws(
    () => validate(foreignQuote),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("viewport-runtime-binding:locateTextQuote"),
    "viewport-runtime-binding:locateTextQuote",
  );
  const foreignFollow = changed(
    {
      ...current,
      Owner:
        'import { shouldFollow as foreignFollow } from "../../fake-follow.js";\n' +
        current.Owner,
    },
    "Owner",
    "following.current = shouldFollow(",
    "following.current = foreignFollow(",
  );
  assert.throws(
    () => validate(foreignFollow),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.includes("viewport-runtime-binding:shouldFollow"),
    "viewport-runtime-binding:shouldFollow",
  );
  rejects(
    "Conversation",
    "  const viewport = useConversationViewportState({",
    "  positions = new Map(positions);\n  const viewport = useConversationViewportState({",
    "renderer-unreassigned-capture:positions",
  );
  rejects(
    "Conversation",
    "  const [allHistory, setAllHistory] = useState(false);",
    "  const [allHistory, setAllHistory] = [false, (value: boolean | ((previous: boolean) => boolean)) => void value] as const;",
    "renderer-real-all-history-setter",
  );
  rejects(
    "Conversation",
    "  const { loadEarlier, onScroll, returnLatest } = useConversationViewportCommit(",
    "  client = { ...client, loadHistoryUntil: async () => false };\n  const { loadEarlier, onScroll, returnLatest } = useConversationViewportCommit(",
    "renderer-unreassigned-capture:client",
  );
});
