import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript/unstable/ast";
import {
  parseReaderSources,
  type ParsedReaderSource,
} from "./fixtures/reader-reads-contract.js";
import {
  originalBookmarkDeclarations as original,
  originalBookmarkDefinitions as definitions,
  originalBookmarkMetadata as metadata,
} from "./fixtures/bookmark-interactions-original.js";

// Current bounded algorithms and actual Client consumption, not a whole-Client
// snapshot, arbitrary TS flow theorem, HTTP authority or original-App acceptance.
const names = ["bookmarkList", "bookmarkCommand"] as const;
const sources = {
  Client: readFileSync("apps/web/src/client.ts", "utf8"),
  Owner: readFileSync("apps/web/src/data/bookmark-interactions.ts", "utf8"),
};
const expectedOwner = `import {z} from 'zod';
import {bookmarkSchema, type BookmarkOperation} from '../../../../packages/core/src/bookmarks.js';
import {RequestError} from '../application-transport.js';
import {draftKey,scopedStorage} from '../local-preferences.js';
export function original(options){const {current,call:applicationCall,savedInputScope}=options;
${original.bookmarkList}\n${original.bookmarkCommand}
return {bookmarkList,bookmarkCommand};}`;
type Context = ParsedReaderSource & {
  imports: Map<number, string>;
  aliases: Map<number, number>;
  labels: Map<number, string>;
};
function one<T>(values: T[], rule: string): T {
  assert.equal(values.length, 1, rule);
  return values[0]!;
}
function fn(statements: readonly ts.Statement[], name: string) {
  const value = one(
    statements
      .filter(ts.isFunctionDeclaration)
      .filter((n) => n.name?.text === name),
    "actual-function:" + name,
  );
  assert.ok(value.body, "actual-function:" + name);
  return value;
}
function within(p: Context, node: ts.Node) {
  return p.nodes.filter(
    (n) => n.getStart() >= node.getStart() && n.end <= node.end,
  );
}
function context(p: ParsedReaderSource): Context {
  const imports = new Map<number, string>(),
    aliases = new Map<number, number>();
  for (const n of p.source.statements.filter(ts.isImportDeclaration)) {
    const bindings = n.importClause?.namedBindings;
    if (
      !bindings ||
      !ts.isNamedImports(bindings) ||
      n.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    )
      continue;
    for (const b of bindings.elements)
      if (!b.isTypeOnly) {
        const id = p.symbols.get(b.name);
        if (id !== undefined)
          imports.set(
            id,
            n.moduleSpecifier.getText().slice(1, -1) +
              ":" +
              (b.propertyName ?? b.name).text,
          );
      }
  }
  for (const n of p.nodes.filter(ts.isVariableDeclaration))
    if (
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      n.parent.flags & ts.NodeFlags.Const
    ) {
      const id = p.symbols.get(n.name),
        from = p.symbols.get(n.initializer);
      if (id !== undefined && from !== undefined) aliases.set(id, from);
    }
  return { ...p, imports, aliases, labels: new Map() };
}
function id(p: Context, node: ts.Node): number | undefined {
  let value = p.symbols.get(node);
  for (let i = 0; i < 2 && value !== undefined && p.aliases.has(value); i++)
    value = p.aliases.get(value);
  return value;
}
function origin(p: Context, node: ts.Node) {
  const key = id(p, node);
  return key === undefined ? undefined : p.imports.get(key);
}
function unwrap(n: ts.Node): ts.Node {
  return ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertion(n)
    ? unwrap(n.expression)
    : n;
}
function shape(n: ts.Node, p: Context): unknown {
  if (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertion(n)
  )
    return shape(n.expression, p);
  const children: unknown[] = [];
  n.forEachChild((child) => {
    if (
      ("type" in n && child === n.type) ||
      (child.kind >= ts.SyntaxKind.FirstTypeNode &&
        child.kind <= ts.SyntaxKind.LastTypeNode) ||
      child.kind === ts.SyntaxKind.TypeParameter ||
      ((ts.isCallExpression(n) || ts.isNewExpression(n)) &&
        n.typeArguments?.some((t) => t === child))
    )
      return;
    children.push(shape(child, p));
  });
  const key = id(p, n);
  return [
    n.kind,
    n.flags &
      (ts.NodeFlags.Const | ts.NodeFlags.Let | ts.NodeFlags.OptionalChain),
    ...(ts.isBinaryExpression(n) ? [n.operatorToken.kind] : []),
    ...(ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)
      ? [n.operator]
      : []),
    children.length
      ? children
      : key !== undefined
        ? (p.labels.get(key) ?? p.imports.get(key) ?? n.getText())
        : ts.isStringLiteral(n)
          ? n.text
          : n.getText(),
  ];
}
function label(p: Context, node: ts.Node, name: string) {
  const key = id(p, node);
  assert.notEqual(key, undefined, "actual-symbol:" + name);
  p.labels.set(key!, name);
}
function properties(n: ts.Node, rule: string) {
  n = unwrap(n);
  assert.ok(ts.isObjectLiteralExpression(n), rule);
  return n.properties.map((v) => {
    assert.ok(
      ts.isShorthandPropertyAssignment(v) || ts.isPropertyAssignment(v),
      rule,
    );
    return {
      name: v.name.getText(),
      value: ts.isShorthandPropertyAssignment(v) ? v.name : v.initializer,
    };
  });
}
function variable(body: ts.Block, name: string) {
  return one(
    body.statements
      .filter(ts.isVariableStatement)
      .flatMap((n) => [...n.declarationList.declarations])
      .filter((n) => ts.isIdentifier(n.name) && n.name.text === name),
    "actual-workspace-binding:" + name,
  );
}
function constructor(p: Context, name: string) {
  const factory = fn(p.source.statements, name);
  assert.ok(
    !factory.asteriskToken &&
      !factory.modifiers?.some((n) => n.kind === ts.SyntaxKind.AsyncKeyword),
    "bookmark-inert-constructor",
  );
  assert.equal(factory.parameters.length, 1, "bookmark-capture-ports");
  const parameter = factory.parameters[0]!;
  assert.ok(
    ts.isIdentifier(parameter.name) &&
      !parameter.initializer &&
      !parameter.dotDotDotToken,
    "bookmark-capture-ports",
  );
  assert.equal(
    factory.body!.statements.length,
    4,
    "bookmark-inert-constructor",
  );
  const first = factory.body!.statements[0]!;
  assert.ok(
    ts.isVariableStatement(first) &&
      first.declarationList.flags & ts.NodeFlags.Const,
    "bookmark-capture-ports",
  );
  const capture = one(
    [...first.declarationList.declarations],
    "bookmark-capture-ports",
  );
  assert.ok(
    ts.isObjectBindingPattern(capture.name) &&
      capture.initializer &&
      id(p, capture.initializer) === id(p, parameter.name),
    "bookmark-capture-ports",
  );
  assert.deepEqual(
    capture.name.elements.map((n) => {
      assert.ok(n.name, "bookmark-capture-ports");
      return (n.propertyName ?? n.name).getText();
    }),
    ["current", "call", "savedInputScope"],
    "bookmark-capture-ports",
  );
  for (const n of capture.name.elements) {
    assert.ok(
      n.name && ts.isIdentifier(n.name) && !n.initializer && !n.dotDotDotToken,
      "bookmark-capture-ports",
    );
    label(p, n.name, "port:" + (n.propertyName ?? n.name).getText());
  }
  const methods = names.map((n) => fn(factory.body!.statements, n));
  assert.deepEqual(
    factory.body!.statements.slice(1, 3),
    methods,
    "bookmark-method-phase",
  );
  for (const method of methods)
    label(p, method.name!, "method:" + method.name!.text);
  const returned = factory.body!.statements[3]!;
  assert.ok(
    ts.isReturnStatement(returned) && returned.expression,
    "bookmark-direct-return",
  );
  const fields = properties(returned.expression, "bookmark-direct-return");
  assert.deepEqual(
    fields.map((n) => n.name),
    names,
    "bookmark-direct-return",
  );
  fields.forEach((value, i) =>
    assert.equal(
      id(p, value.value),
      id(p, methods[i]!.name!),
      "bookmark-direct-return",
    ),
  );
  return { factory, methods };
}
function typeOrigin(
  p: Context,
  type: ts.Node | undefined,
  module: string,
  name: string,
) {
  assert.ok(type, "bookmark-operation-type-origin");
  let n = type;
  for (let i = 0; i < 2; i++) {
    assert.ok(
      ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName),
      "bookmark-operation-type-origin",
    );
    const key = p.symbols.get(n.typeName);
    const alias = p.source.statements
      .filter(ts.isTypeAliasDeclaration)
      .find((a) => p.symbols.get(a.name) === key);
    if (alias) {
      n = alias.type;
      continue;
    }
    const match = p.source.statements
      .filter(ts.isImportDeclaration)
      .some((d) => {
        const b = d.importClause?.namedBindings;
        return (
          d.moduleSpecifier.getText().slice(1, -1) === module &&
          b &&
          ts.isNamedImports(b) &&
          b.elements.some(
            (v) =>
              p.symbols.get(v.name) === key &&
              (v.propertyName ?? v.name).text === name &&
              (v.isTypeOnly ||
                d.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword),
          )
        );
      });
    assert.ok(match, "bookmark-operation-type-origin");
    return;
  }
  assert.fail("bookmark-operation-type-origin");
}
function borrowedCallType(p: Context, type: ts.TypeNode | undefined) {
  const rule = "bookmark-borrowed-call-type-origin";
  let value = type;
  for (
    let i = 0;
    i < 2 &&
    value &&
    ts.isTypeReferenceNode(value) &&
    ts.isIdentifier(value.typeName);
    i++
  ) {
    const key = p.symbols.get(value.typeName);
    value = p.source.statements
      .filter(ts.isTypeAliasDeclaration)
      .find((n) => p.symbols.get(n.name) === key)?.type;
  }
  assert.ok(value && ts.isTypeLiteralNode(value), rule);
  assert.deepEqual(
    value.members.map((n) => {
      assert.ok(ts.isPropertySignatureDeclaration(n), rule);
      return n.name.getText();
    }),
    ["current", "call", "savedInputScope"],
    rule,
  );
  const call = value.members[1]!;
  assert.ok(ts.isPropertySignatureDeclaration(call), rule);
  assert.ok(
    call.type &&
      ts.isTypeQueryNode(call.type) &&
      ts.isIdentifier(call.type.exprName),
    rule,
  );
  const key = p.symbols.get(call.type.exprName);
  assert.ok(
    p.source.statements.filter(ts.isImportDeclaration).some((n) => {
      const bindings = n.importClause?.namedBindings;
      return (
        n.moduleSpecifier.getText().slice(1, -1) ===
          "../application-transport.js" &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (b) =>
            p.symbols.get(b.name) === key &&
            (b.propertyName ?? b.name).text === "applicationCall" &&
            (b.isTypeOnly ||
              n.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword),
        )
      );
    }),
    rule,
  );
}
function currentLifetime(
  client: Context,
  clear: ts.FunctionDeclaration,
  current: ts.BindingName,
) {
  const rule = "bookmark-current-lifetime-clear";
  assert.ok(
    clear.body &&
      !clear.asteriskToken &&
      !clear.modifiers?.some((n) => n.kind === ts.SyntaxKind.AsyncKeyword),
    rule,
  );
  const member = (node: ts.Node) => {
    node = unwrap(node);
    return (
      ((ts.isPropertyAccessExpression(node) && node.name.text === "current") ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === "current")) &&
      id(client, unwrap(node.expression)) === id(client, current)
    );
  };
  const nodes = within(client, clear.body);
  const writes = nodes.filter(ts.isBinaryExpression).filter((n) => {
    const assignment =
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    if (!assignment) return false;
    assert.ok(
      !ts.isIdentifier(unwrap(n.left)) ||
        id(client, unwrap(n.left)) !== id(client, current),
      rule,
    );
    return member(n.left);
  });
  const write = one(writes, rule);
  assert.ok(
    write.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      unwrap(write.right).kind === ts.SyntaxKind.NullKeyword &&
      ts.isExpressionStatement(write.parent) &&
      write.parent.parent === clear.body,
    rule,
  );
  // Only the borrowed identity retirement belongs to Bookmark. Other owners'
  // cache/state cleanup may grow. Explicit early exits cannot bypass the step;
  // uncalled nested functions are not this clear function's execution flow.
  for (const node of nodes) {
    if (node.getStart() >= write.getStart()) continue;
    if (!ts.isReturnStatement(node) && !ts.isThrowStatement(node)) continue;
    let parent: ts.Node | undefined = node.parent;
    while (
      parent &&
      !ts.isFunctionDeclaration(parent) &&
      !ts.isFunctionExpression(parent) &&
      !ts.isArrowFunction(parent) &&
      !ts.isMethodDeclaration(parent)
    )
      parent = parent.parent;
    assert.notEqual(parent, clear, rule);
  }
  assert.ok(
    !nodes.some(
      (n) =>
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken) &&
        member(n.operand),
    ),
    rule,
  );
}
function verify(clientText = sources.Client, ownerText = sources.Owner) {
  const parsed = parseReaderSources({
    Client: clientText,
    Owner: ownerText,
    Fixed: expectedOwner,
    Definitions: definitions.savedInputScope,
  });
  const client = context(parsed.get("Client")!),
    owner = context(parsed.get("Owner")!),
    fixed = context(parsed.get("Fixed")!),
    defs = context(parsed.get("Definitions")!);
  const actual = constructor(owner, "createBookmarkInteractions"),
    expected = constructor(fixed, "original");
  typeOrigin(
    owner,
    actual.methods[1]!.parameters[0]!.type,
    "../../../../packages/core/src/bookmarks.js",
    "BookmarkOperation",
  );
  borrowedCallType(owner, actual.factory.parameters[0]!.type);
  actual.methods.forEach((method, i) =>
    assert.deepEqual(
      shape(method, owner),
      shape(expected.methods[i]!, fixed),
      "bookmark-complete-algorithm:" + names[i],
    ),
  );
  // Import evaluation effects are distinct from uncalled independent features.
  for (const statement of owner.source.statements)
    if (ts.isExpressionStatement(statement))
      assert.fail("bookmark-module-import-effect");
  const workspace = fn(client.source.statements, "useWorkspace"),
    body = workspace.body!;
  const imports = client.source.statements
    .filter(ts.isImportDeclaration)
    .flatMap((d) => {
      const b = d.importClause?.namedBindings;
      return b && ts.isNamedImports(b)
        ? b.elements
            .filter(
              (n) =>
                (n.propertyName ?? n.name).text ===
                "createBookmarkInteractions",
            )
            .map((n) => ({ d, n }))
        : [];
    });
  const imported = one(imports, "bookmark-runtime-factory-origin");
  assert.equal(
    imported.d.moduleSpecifier.getText().slice(1, -1),
    "./data/bookmark-interactions.js",
    "bookmark-runtime-factory-origin",
  );
  assert.ok(
    !imported.n.isTypeOnly &&
      imported.d.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword,
    "bookmark-runtime-factory-origin",
  );
  const calls = within(client, body)
    .filter(ts.isCallExpression)
    .filter((n) => id(client, n.expression) === id(client, imported.n.name));
  const call = one(calls, "bookmark-actual-factory-call");
  assert.ok(
    ts.isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      ts.isIdentifier(call.parent.name),
    "bookmark-direct-registration",
  );
  const statement = call.parent.parent.parent;
  assert.ok(
    ts.isVariableStatement(statement) &&
      statement.parent === body &&
      statement.declarationList.flags & ts.NodeFlags.Const,
    "bookmark-direct-registration",
  );
  const slot = body.statements.indexOf(statement);
  const reader = variable(body, "readerInteractions"),
    task = variable(body, "taskInteractions");
  assert.ok(
    reader.initializer &&
      ts.isCallExpression(reader.initializer) &&
      origin(client, reader.initializer.expression) ===
        "./data/reader-interactions.js:createReaderInteractions" &&
      task.initializer &&
      ts.isCallExpression(task.initializer) &&
      origin(client, task.initializer.expression) ===
        "./data/task-interactions.js:createTaskInteractions",
    "bookmark-original-constructor-slot",
  );
  assert.ok(
    body.statements.indexOf(reader.parent.parent as ts.Statement) < slot &&
      slot < body.statements.indexOf(task.parent.parent as ts.Statement),
    "bookmark-original-constructor-slot",
  );
  assert.equal(call.arguments.length, 1, "bookmark-actual-captured-ports");
  const fields = properties(
    call.arguments[0]!,
    "bookmark-actual-captured-ports",
  );
  assert.deepEqual(
    fields.map((n) => n.name),
    ["current", "call", "savedInputScope"],
    "bookmark-actual-captured-ports",
  );
  const current = variable(body, "current");
  assert.ok(
    current.initializer && ts.isCallExpression(current.initializer),
    "bookmark-actual-current-ref",
  );
  assert.equal(
    origin(client, current.initializer.expression),
    "react:useRef",
    "bookmark-actual-current-ref",
  );
  assert.equal(
    current.initializer.arguments.length,
    1,
    "bookmark-actual-current-ref",
  );
  assert.equal(
    current.initializer.arguments[0]!.kind,
    ts.SyntaxKind.NullKeyword,
    "bookmark-actual-current-ref",
  );
  assert.equal(
    id(client, fields[0]!.value),
    id(client, current.name),
    "bookmark-actual-captured-ports",
  );
  assert.equal(
    origin(client, fields[1]!.value),
    "./application-transport.js:applicationCall",
    "bookmark-actual-captured-ports",
  );
  const scope = one(
    client.source.statements
      .filter(ts.isVariableStatement)
      .flatMap((n) => [...n.declarationList.declarations])
      .filter(
        (n) => ts.isIdentifier(n.name) && n.name.text === "savedInputScope",
      ),
    "bookmark-actual-scope-binding",
  );
  assert.equal(
    id(client, fields[2]!.value),
    id(client, scope.name),
    "bookmark-actual-captured-ports",
  );
  for (const node of within(client, body).filter(
    (n) => n.getStart() < call.getStart(),
  ))
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      assert.ok(
        id(client, node.left) !== id(client, current.name) &&
          id(client, node.left) !== id(client, scope.name) &&
          origin(client, node.left) !==
            "./application-transport.js:applicationCall",
        "bookmark-captured-port-not-reassigned",
      );
  const expectedScope = defs.source.statements.filter(
    ts.isVariableStatement,
  )[0]!.declarationList.declarations[0]!;
  assert.ok(
    scope.initializer && expectedScope.initializer,
    "bookmark-original-scope-recipe",
  );
  assert.deepEqual(
    shape(scope.initializer, client),
    shape(expectedScope.initializer, defs),
    "bookmark-original-scope-recipe",
  );
  currentLifetime(
    client,
    fn(body.statements, "clearProtectedProjection"),
    current.name,
  );
  assert.equal(
    body.statements
      .filter(ts.isFunctionDeclaration)
      .filter((n) => names.includes(n.name?.text as (typeof names)[number]))
      .length,
    0,
    "bookmark-no-duplicate-client-algorithm",
  );
  const returned = one(
    body.statements.filter(ts.isReturnStatement),
    "bookmark-actual-public-object",
  );
  assert.ok(returned.expression, "bookmark-actual-public-object");
  const publicFields = properties(
    returned.expression,
    "bookmark-actual-public-object",
  );
  for (const name of names) {
    const field = one(
      publicFields.filter((n) => n.name === name),
      "bookmark-direct-public-consumer:" + name,
    );
    const value = unwrap(field.value);
    assert.ok(
      ts.isPropertyAccessExpression(value) &&
        value.name.text === name &&
        id(client, value.expression) === id(client, call.parent.name),
      "bookmark-direct-public-consumer:" + name,
    );
  }
}
function changed(text: string, before: string, after: string) {
  assert.equal(
    text.split(before).length - 1,
    1,
    "unique legal bookmark mutation",
  );
  return text.replace(before, after);
}
function changedClear(text: string, before: string, after: string) {
  const parsed = parseReaderSources({ Client: text }).get("Client")!;
  const clear = fn(
    fn(parsed.source.statements, "useWorkspace").body!.statements,
    "clearProtectedProjection",
  );
  return (
    text.slice(0, clear.getStart()) +
    changed(clear.getText(), before, after) +
    text.slice(clear.end)
  );
}
function rejects(client: string, owner: string, rule: string) {
  parseReaderSources({ Client: client, Owner: owner });
  assert.throws(
    () => verify(client, owner),
    (error) =>
      error instanceof assert.AssertionError && error.message.includes(rule),
  );
}

test("bookmark fixed raw complete algorithms and finite identity definitions remain independent original Git", () => {
  for (const entry of metadata.functions)
    assert.equal(
      createHash("sha256").update(original[entry.name]).digest("hex"),
      entry.sha256,
    );
  for (const name of Object.keys(definitions) as (keyof typeof definitions)[])
    assert.equal(
      createHash("sha256").update(definitions[name]).digest("hex"),
      metadata.definitions[name],
    );
});
test("bookmark current bounded algorithms and real direct Client consumption preserve identity and durable policy", () =>
  verify());
test("bookmark factory value binding registration captured ports and public consumers reject legal counterfactuals", () => {
  const cases: [string, string][] = [
    [
      changed(
        sources.Client,
        '"./data/bookmark-interactions.js"',
        '"./data/fake-bookmarks.js"',
      ),
      "bookmark-runtime-factory-origin",
    ],
    [
      changed(
        sources.Client,
        "import { createBookmarkInteractions }",
        "import type { createBookmarkInteractions }",
      ),
      "bookmark-runtime-factory-origin",
    ],
    [
      changed(
        sources.Client,
        "const bookmarkInteractions = createBookmarkInteractions({",
        "const bookmarkInteractions = Promise.resolve(createBookmarkInteractions({",
      ).replace(
        "    savedInputScope,\n  });\n  const taskInteractions",
        "    savedInputScope,\n  }));\n  const taskInteractions",
      ),
      "bookmark-direct-registration",
    ],
    [
      changed(
        sources.Client,
        "    current,\n    call: applicationCall,\n    savedInputScope,",
        "    current: { ...current },\n    call: applicationCall,\n    savedInputScope,",
      ),
      "bookmark-actual-captured-ports",
    ],
    [
      changed(
        sources.Client,
        "    current,\n    call: applicationCall,\n    savedInputScope,",
        "    current,\n    call: (...args) => applicationCall(...args),\n    savedInputScope,",
      ),
      "bookmark-actual-captured-ports",
    ],
    [
      changed(
        sources.Client,
        definitions.savedInputScope,
        definitions.savedInputScope.replace(
          "${identity.principalId}:${identity.actantId}",
          "${identity.principalId}",
        ),
      ),
      "bookmark-original-scope-recipe",
    ],
    [
      changedClear(
        sources.Client,
        "current.current = null;",
        "current.current = null; current.current = boot;",
      ),
      "bookmark-current-lifetime-clear",
    ],
    [
      changedClear(
        sources.Client,
        "current.current = null;",
        "if (boot) return; current.current = null;",
      ),
      "bookmark-current-lifetime-clear",
    ],
    [
      changedClear(
        sources.Client,
        "current.current = null;",
        "if (boot) current.current = null;",
      ),
      "bookmark-current-lifetime-clear",
    ],
    [
      changedClear(
        sources.Client,
        "current.current = null;",
        "platform.current = null;",
      ),
      "bookmark-current-lifetime-clear",
    ],
    [
      changed(
        sources.Client,
        "bookmarkList: bookmarkInteractions.bookmarkList",
        "bookmarkList: (...args) => bookmarkInteractions.bookmarkList(...args)",
      ),
      "bookmark-direct-public-consumer:bookmarkList",
    ],
    [
      changed(
        sources.Client,
        "bookmarkCommand: bookmarkInteractions.bookmarkCommand",
        "bookmarkCommand: bookmarkInteractions.bookmarkList",
      ),
      "bookmark-direct-public-consumer:bookmarkCommand",
    ],
    [
      changed(
        sources.Client,
        "  const bookmarkInteractions =",
        "  const createBookmarkInteractions = (_options:unknown) => ({});\n  const bookmarkInteractions =",
      ),
      "bookmark-actual-factory-call",
    ],
    [
      changed(
        sources.Client,
        "  const bookmarkInteractions =",
        "  current = {current:boot};\n  const bookmarkInteractions =",
      ),
      "bookmark-captured-port-not-reassigned",
    ],
    [
      changed(
        sources.Client,
        "bookmarkList: bookmarkInteractions.bookmarkList,",
        "bookmarkList: bookmarkInteractions.bookmarkList, bookmarkList: bookmarkInteractions.bookmarkList,",
      ),
      "bookmark-direct-public-consumer:bookmarkList",
    ],
  ];
  for (const [client, rule] of cases) rejects(client, sources.Owner, rule);
});
test("bookmark complete algorithms reject parse-valid scope hash payload timeout guard and error policy changes", () => {
  const cases: [string, string, string][] = [
    [
      "signal: AbortSignal.timeout(8000)",
      "signal: AbortSignal.timeout(12000)",
      "bookmarkList",
    ],
    [
      "return z.array(bookmarkSchema).parse(",
      "return z.array(bookmarkSchema).catch([]).parse(",
      "bookmarkList",
    ],
    [
      "JSON.stringify(operation)",
      "JSON.stringify({ operation })",
      "bookmarkCommand",
    ],
    ['"pending:bookmark:"', '"pending:bookmarks:"', "bookmarkCommand"],
    [
      "current.current?.csrfToken !== identity.csrfToken",
      "false",
      "bookmarkCommand",
    ],
    ["error.status !== 408", "error.status !== 409", "bookmarkCommand"],
    ["error.status < 500", "error.status < 600", "bookmarkCommand"],
    [
      "writeLocal(key, command);",
      "writeLocal(key, { commandId: command.commandId, operation });",
      "bookmarkCommand",
    ],
    [
      "return receipt;",
      "return z.unknown().parse(receipt);",
      "bookmarkCommand",
    ],
  ];
  for (const [before, after, name] of cases) {
    const occurrence = sources.Owner.indexOf(before);
    assert.ok(occurrence >= 0);
    const owner =
      sources.Owner.slice(0, occurrence) +
      sources.Owner.slice(occurrence).replace(before, after);
    rejects(sources.Client, owner, "bookmark-complete-algorithm:" + name);
  }
});
test("bookmark constructor and called dependency symbols cannot hide eager IO shadows or borrowed type drift", () => {
  for (const [owner, rule] of [
    [
      changed(
        sources.Owner,
        "  return { bookmarkList, bookmarkCommand };",
        "  current.current;\n  return { bookmarkList, bookmarkCommand };",
      ),
      "bookmark-inert-constructor",
    ],
    [
      changed(
        sources.Owner,
        "export function createBookmarkInteractions",
        "export async function createBookmarkInteractions",
      ),
      "bookmark-inert-constructor",
    ],
    [
      changed(
        sources.Owner,
        'from "../local-preferences.js"',
        'from "../fake-storage.js"',
      ),
      "bookmark-complete-algorithm:bookmarkCommand",
    ],
    [
      changed(
        sources.Owner,
        'import { RequestError } from "../application-transport.js"',
        'import { RequestError } from "../fake-transport.js"',
      ),
      "bookmark-complete-algorithm:bookmarkCommand",
    ],
    [
      changed(
        sources.Owner,
        'from "../../../../packages/core/src/bookmarks.js"',
        'from "../../../../packages/core/src/fake-bookmarks.js"',
      ),
      "bookmark-operation-type-origin",
    ],
    [
      changed(
        sources.Owner,
        'import type { applicationCall } from "../application-transport.js"',
        'import type { applicationCall } from "../fake-transport.js"',
      ),
      "bookmark-borrowed-call-type-origin",
    ],
    [
      sources.Owner + '\nfetch("/unreviewed-bookmarks");',
      "bookmark-module-import-effect",
    ],
  ] as const)
    rejects(sources.Client, owner, rule);
});
test("bookmark finite gate permits real aliases static types and independently consumed future features", () => {
  let client = changed(
    sources.Client,
    "import { createBookmarkInteractions }",
    "import { createBookmarkInteractions as MakeBookmarks }",
  );
  client = changed(
    client,
    "const bookmarkInteractions = createBookmarkInteractions({",
    "const MakeLocal = MakeBookmarks;\n  const bookmarkInteractions = MakeLocal({",
  );
  let owner = changed(
    sources.Owner,
    "call: applicationCall, savedInputScope",
    "call: callBookmarks, savedInputScope",
  );
  owner = owner.replaceAll("await applicationCall(", "await callBookmarks(");
  verify(client, owner);
  client = changed(
    sources.Client,
    "  const bookmarkInteractions =",
    "  const originalCurrent = current;\n  const bookmarkInteractions =",
  );
  client = changed(
    client,
    "    current,\n    call: applicationCall,\n    savedInputScope,",
    "    current: originalCurrent,\n    call: applicationCall,\n    savedInputScope,",
  );
  verify(client, sources.Owner);
  owner =
    changed(
      sources.Owner,
      "type BookmarkOperation,",
      "type BookmarkOperation as CoreBookmarkOperation,",
    ) + "\ntype BookmarkOperation = CoreBookmarkOperation;";
  verify(sources.Client, owner);
  owner = changed(
    sources.Owner,
    "import type { applicationCall }",
    "import type { applicationCall as TransportCall }",
  );
  owner = changed(
    owner,
    "call: typeof applicationCall;",
    "call: typeof TransportCall;",
  );
  owner =
    changed(
      owner,
      "options: BookmarkInteractionPorts",
      "options: AliasedBookmarkPorts",
    ) + "\ntype AliasedBookmarkPorts = BookmarkInteractionPorts;";
  verify(sources.Client, owner);
  verify(
    sources.Client +
      "\nexport function IndependentBookmarkFeature(){const current=useRef(null);const [visible,setVisible]=useState(false);useEffect(()=>{},[visible]);const extra=createBookmarkInteractions({current,call:applicationCall,savedInputScope});return {visible,toggle:()=>setVisible(!visible),extra};}",
    sources.Owner +
      "\nexport const unrelatedPure = (value:number)=>value+1;\nexport type FutureBookmarkLabel = Readonly<{title:string}>;\nfunction unusedSameNames(current:unknown,savedInputScope:unknown){return {current,savedInputScope};}",
  );
  client = changed(
    sources.Client,
    "  const bookmarkInteractions =",
    "  const futureCache = useRef(new Map<string, string>());\n  const [futureVisible, setFutureVisible] = useState(false);\n  const bookmarkInteractions =",
  );
  client = changedClear(
    client,
    "current.current = null;",
    "current.current = null; futureCache.current.clear(); setFutureVisible(false);",
  );
  client = changed(
    client,
    "bookmarkList: bookmarkInteractions.bookmarkList,",
    "futureFeature: { visible: futureVisible, cache: futureCache.current, toggle: () => setFutureVisible(!futureVisible) },\n    bookmarkList: bookmarkInteractions.bookmarkList,",
  );
  verify(client, sources.Owner);
});
