import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SyntaxKind,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPrefixUnaryExpression,
  isPostfixUnaryExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isThrowStatement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type IfStatement,
} from "typescript/unstable/ast";
import {
  parseReaderSources,
  readerShape,
  walkReader,
  type ParsedReaderSource,
} from "./reader-reads-contract.js";
import { fixedObjectInteractions as fixed } from "./object-interactions-original.js";

export const readObjectInteractionOwner = () =>
  readFileSync(
    new URL("../../apps/web/src/data/object-interactions.ts", import.meta.url),
    "utf8",
  );
const one = <T>(values: readonly T[], rule: string) => {
  assert.equal(values.length, 1, rule);
  return values[0]!;
};
function bare(node: Node): Node {
  while (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}
function local(parsed: ParsedReaderSource, node: Node): Node {
  node = bare(node);
  for (let i = 0; i < 8 && isIdentifier(node); i++) {
    const symbol = parsed.symbols.get(node);
    const declaration = parsed.nodes
      .filter(isVariableDeclaration)
      .find(
        (value) =>
          isIdentifier(value.name) && parsed.symbols.get(value.name) === symbol,
      );
    if (
      !declaration?.initializer ||
      !isIdentifier(bare(declaration.initializer))
    )
      break;
    node = bare(declaration.initializer);
  }
  return node;
}
function same(
  parsed: ParsedReaderSource,
  use: Node,
  binding: Node,
  rule: string,
) {
  const left = parsed.symbols.get(local(parsed, use)),
    right = parsed.symbols.get(binding);
  assert.notEqual(right, undefined, rule);
  assert.equal(left, right, rule);
}
function imported(parsed: ParsedReaderSource, path: string, name: string) {
  const members = parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (value) =>
        isStringLiteral(value.moduleSpecifier) &&
        value.moduleSpecifier.text === path,
    )
    .flatMap((value) => {
      const clause = value.importClause;
      if (!clause?.namedBindings || !isNamedImports(clause.namedBindings))
        return [];
      return clause.namedBindings.elements
        .filter((member) => (member.propertyName ?? member.name).text === name)
        .map((member) => ({ member, clause }));
    });
  const { member, clause } = one(members, "object-real-runtime-import " + name);
  assert.equal(
    clause.phaseModifier,
    undefined,
    "object-real-runtime-import " + name,
  );
  assert.equal(member.isTypeOnly, false, "object-real-runtime-import " + name);
  return member.name;
}
function scoped(parsed: ParsedReaderSource, body: Node) {
  const nodes: Node[] = [];
  walkReader(body, (node) => nodes.push(node));
  return { ...parsed, nodes };
}
function fn(statements: readonly Node[], name: string) {
  const result = one(
    statements
      .filter(isFunctionDeclaration)
      .filter((value) => value.name?.text === name),
    "object-complete-function " + name,
  );
  assert.ok(result.body, "object-complete-function " + name);
  assert.ok(
    !result.asteriskToken &&
      result.modifiers?.some((value) => value.kind === SyntaxKind.AsyncKeyword),
    "object-original-async-function " + name,
  );
  return result;
}
function variable(statements: readonly Node[], name: string) {
  return one(
    statements
      .filter(isVariableStatement)
      .flatMap((value) => [...value.declarationList.declarations])
      .filter((value) => isIdentifier(value.name) && value.name.text === name),
    "object-original-binding " + name,
  );
}
function valueProperty(node: Node, name: string) {
  assert.ok(isObjectLiteralExpression(node), "object-exact-ports");
  const property = one(
    node.properties.filter(
      (value) =>
        (isPropertyAssignment(value) || isShorthandPropertyAssignment(value)) &&
        value.name.getText() === name,
    ),
    "object-exact-port " + name,
  );
  assert.ok(
    isPropertyAssignment(property) || isShorthandPropertyAssignment(property),
  );
  return isPropertyAssignment(property) ? property.initializer : property.name;
}
function canonical(
  parsed: ParsedReaderSource,
  node: Node,
  names: Map<number, string>,
): unknown {
  node = bare(node);
  if (isIdentifier(node)) {
    const symbol = parsed.symbols.get(local(parsed, node));
    return [
      node.kind,
      symbol === undefined ? node.text : (names.get(symbol) ?? node.text),
    ];
  }
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(canonical(parsed, child, names));
  });
  return [
    node.kind,
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length ? children : node.getText(),
  ];
}
function originalBody(
  parsed: ParsedReaderSource,
  actual: Node,
  original: Node,
  names: Map<number, string>,
  rule: string,
) {
  assert.deepEqual(
    canonical(parsed, actual, names),
    canonical(parsed, original, new Map()),
    rule,
  );
}

/** Only this complete object's read factory, two bounded algorithms and the
 * original Client consumption/dispatch seams. No whole Client hash/inverse.
 * Unrelated owners, exports, UI and independent React features are not scanned.
 */
export function verifyObjectInteractionConsumption(
  clientText: string,
  ownerText = readObjectInteractionOwner(),
) {
  const expectedText = `${fixed.spans.listObjectAnnotations.raw}\n${fixed.spans.workRelationsFor.raw}\nfunction oldAnnotation(){${fixed.spans.annotateBranch.raw.slice(fixed.spans.annotateBranch.raw.indexOf("{") + 1, -1)}}\nfunction oldRelation(){${fixed.spans.linkArtifactsBranch.raw.slice(fixed.spans.linkArtifactsBranch.raw.indexOf("{") + 1, -1)}}\nconst ${fixed.spans.done.raw};`;
  const parsed = parseReaderSources({
    Client: clientText,
    Owner: ownerText,
    Expected: expectedText,
  });
  const client = parsed.get("Client")!,
    owner = parsed.get("Owner")!,
    expected = parsed.get("Expected")!;
  const workspace = one(
    client.source.statements
      .filter(isFunctionDeclaration)
      .filter((value) => value.name?.text === "useWorkspace"),
    "object-actual-workspace",
  );
  assert.ok(workspace.body);
  const factory = one(
    owner.source.statements
      .filter(isFunctionDeclaration)
      .filter((value) => value.name?.text === "createObjectInteractions"),
    "object-inert-factory",
  );
  assert.ok(factory.body);
  assert.equal(factory.body.statements.length, 4, "object-inert-factory");
  const bindings = factory.body.statements[0]!;
  assert.ok(
    isVariableStatement(bindings) &&
      bindings.declarationList.declarations.length === 1,
    "object-inert-factory",
  );
  const borrowed = bindings.declarationList.declarations[0]!;
  assert.ok(
    isObjectBindingPattern(borrowed.name) &&
      borrowed.initializer &&
      factory.parameters[0],
    "object-inert-factory",
  );
  same(
    owner,
    borrowed.initializer,
    factory.parameters[0].name,
    "object-inert-factory",
  );
  const borrowedBindings = borrowed.name.elements.filter(isBindingElement);
  assert.equal(borrowedBindings.length, 2, "object-original-two-ref-ports");
  assert.deepEqual(
    borrowedBindings.map(
      (value) => value.propertyName?.getText() ?? value.name?.getText(),
    ),
    ["current", "platform"],
    "object-original-two-ref-ports",
  );
  const portNames = new Map<number, string>();
  for (const binding of borrowedBindings) {
    assert.ok(
      binding.name && !binding.initializer && !binding.dotDotDotToken,
      "object-original-two-ref-ports",
    );
    const symbol = owner.symbols.get(binding.name);
    assert.notEqual(symbol, undefined, "object-original-two-ref-ports");
    portNames.set(symbol!, (binding.propertyName ?? binding.name).getText());
  }
  for (const [module, name] of [
    ["zod", "z"],
    ["../../../../packages/core/src/model.js", "stateSchema"],
  ] as const) {
    const symbol = owner.symbols.get(imported(owner, module, name));
    assert.notEqual(symbol, undefined, "object-original-schema-bindings");
    portNames.set(symbol!, name);
  }
  for (const name of ["listObjectAnnotations", "workRelationsFor"] as const) {
    const method = fn(factory.body.statements, name),
      original = fn(expected.source.statements, name);
    assert.deepEqual(
      method.parameters.map((value) => value.name.getText()),
      original.parameters.map((value) => value.name.getText()),
      "object-original-reader-signature " + name,
    );
    originalBody(
      owner,
      method.body!,
      original.body!,
      portNames,
      name === "listObjectAnnotations"
        ? "complete original authorized annotation Client reader identity pagination and bounds"
        : "object-complete-relations-read",
    );
  }
  const returned = factory.body.statements[3]!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
    "object-closed-read-methods",
  );
  assert.deepEqual(
    returned.expression.properties.map((value) => value.getText()),
    ["listObjectAnnotations", "workRelationsFor"],
    "object-closed-read-methods",
  );
  for (const method of returned.expression.properties) {
    assert.ok(isShorthandPropertyAssignment(method));
    same(
      owner,
      method.name,
      fn(factory.body.statements, method.name.getText()).name!,
      "object-actual-returned-method",
    );
  }

  for (const [name, old] of [
    ["annotateObjectOperation", "oldAnnotation"],
    ["linkWorkOperation", "oldRelation"],
  ] as const) {
    const actual = fn(owner.source.statements, name);
    const original = one(
      expected.source.statements
        .filter(isFunctionDeclaration)
        .filter((value) => value.name?.text === old),
      "object-fixed-write-recipe",
    );
    assert.deepEqual(
      actual.parameters.map((value) => value.name.getText()),
      name === "annotateObjectOperation"
        ? ["source", "op", "commandId", "done", "UnsentOperationError"]
        : ["source", "op", "commandId", "done"],
      "object-captured-write-ports " + name,
    );
    assert.ok(original.body);
    originalBody(
      owner,
      actual.body!,
      original.body,
      new Map(),
      "object-complete-write " + name,
    );
  }
  const host = scoped(client, workspace.body);
  const current = variable(workspace.body.statements, "current"),
    platform = variable(workspace.body.statements, "platform");
  const react = imported(client, "react", "useRef");
  for (const ref of [current, platform]) {
    assert.ok(
      ref.initializer && isCallExpression(ref.initializer),
      "object-original-react-refs",
    );
    same(
      client,
      ref.initializer.expression,
      react,
      "object-original-react-refs",
    );
    assert.deepEqual(
      ref.initializer.arguments.map((value) => value.getText()),
      ["null"],
      "object-original-react-refs",
    );
  }
  const registration = variable(
    workspace.body.statements,
    "objectInteractions",
  );
  assert.ok(
    registration.initializer &&
      isCallExpression(bare(registration.initializer)),
    "object-direct-factory-consumer",
  );
  const call = bare(registration.initializer);
  assert.ok(isCallExpression(call));
  same(
    client,
    call.expression,
    imported(
      client,
      "./data/object-interactions.js",
      "createObjectInteractions",
    ),
    "object-real-factory-callee",
  );
  assert.equal(call.arguments.length, 1, "object-exact-ports");
  assert.ok(isObjectLiteralExpression(call.arguments[0]!));
  assert.deepEqual(
    call.arguments[0]!.properties.map((value) =>
      isPropertyAssignment(value) || isShorthandPropertyAssignment(value)
        ? value.name.getText()
        : undefined,
    ),
    ["current", "platform"],
    "object-exact-ports",
  );
  same(
    client,
    valueProperty(call.arguments[0]!, "current"),
    current.name,
    "object-borrow-original-current-ref",
  );
  same(
    client,
    valueProperty(call.arguments[0]!, "platform"),
    platform.name,
    "object-borrow-original-platform-ref",
  );
  const statements = [...workspace.body.statements],
    index = statements.findIndex(
      (value) => value === registration.parent.parent,
    );
  const before = statements.findIndex(
    (value) =>
      isVariableStatement(value) &&
      value.getText().startsWith("const bookmarkInteractions ="),
  );
  const after = statements.findIndex(
    (value) =>
      isVariableStatement(value) &&
      value.getText().startsWith("const taskInteractions ="),
  );
  assert.ok(
    before >= 0 && index > before && after > index,
    "object-original-constructor-region",
  );
  for (const statement of statements.slice(0, index)) {
    if (isFunctionDeclaration(statement)) continue;
    walkReader(statement, (node) => {
      if (
        isBinaryExpression(node) &&
        node.operatorToken.kind === SyntaxKind.EqualsToken &&
        isIdentifier(node.left)
      )
        assert.ok(
          ![current.name, platform.name].some(
            (value) =>
              client.symbols.get(value) === client.symbols.get(node.left),
          ),
          "object-no-rebound-borrowed-ref",
        );
    });
  }
  const clear = one(
    workspace.body.statements
      .filter(isFunctionDeclaration)
      .filter((value) => value.name?.text === "clearProtectedProjection"),
    "object-original-ref-retirement",
  );
  assert.ok(clear.body, "object-original-ref-retirement");
  for (const ref of [current, platform]) {
    const writes: Node[] = [];
    walkReader(clear.body, (node) => {
      if (
        isBinaryExpression(node) &&
        node.operatorToken.kind === SyntaxKind.EqualsToken &&
        isPropertyAccessExpression(node.left) &&
        node.left.name.text === "current" &&
        client.symbols.get(local(client, node.left.expression)) ===
          client.symbols.get(ref.name)
      )
        writes.push(node);
    });
    const write = one(writes, "object-original-ref-retirement");
    assert.ok(
      isBinaryExpression(write) &&
        write.right.kind === SyntaxKind.NullKeyword &&
        isExpressionStatement(write.parent) &&
        write.parent.parent === clear.body,
      "object-original-ref-retirement",
    );
    const position = clear.body.statements.indexOf(write.parent);
    for (const statement of clear.body.statements.slice(0, position))
      walkReader(statement, (node) =>
        assert.ok(
          !isReturnStatement(node) && !isThrowStatement(node),
          "object-original-ref-retirement",
        ),
      );
  }
  const publicReturn = one(
    statements
      .filter(isReturnStatement)
      .filter(
        (value) =>
          value.expression && isObjectLiteralExpression(value.expression),
      ),
    "object-actual-public-client",
  );
  assert.ok(
    publicReturn.expression &&
      isObjectLiteralExpression(publicReturn.expression),
  );
  for (const name of ["listObjectAnnotations", "workRelationsFor"]) {
    const value = bare(valueProperty(publicReturn.expression, name));
    assert.ok(
      isPropertyAccessExpression(value) && value.name.text === name,
      "object-direct-public-method " + name,
    );
    same(
      client,
      value.expression,
      registration.name,
      "object-direct-public-method " + name,
    );
  }
  assert.equal(
    host.nodes
      .filter(isFunctionDeclaration)
      .filter((value) =>
        ["listObjectAnnotations", "workRelationsFor"].includes(
          value.name?.text ?? "",
        ),
      ).length,
    0,
    "object-no-duplicate-client-algorithm",
  );

  const dispatch = one(
    client.source.statements
      .filter(isFunctionDeclaration)
      .filter((value) => value.name?.text === "executePlatformOperation"),
    "object-original-dispatch",
  );
  assert.ok(dispatch.body && dispatch.parameters[0]);
  const done = variable(dispatch.body.statements, "done");
  const expectedDone = variable(expected.source.statements, "done");
  assert.deepEqual(
    readerShape(done),
    readerShape(expectedDone),
    "object-original-captured-receipt",
  );
  // Durable delivery owns the sole class now. The domain leaf must borrow the
  // exact actual value import of that exported constructor, never a namesake.
  const operationOwner = parseReaderSources({
    Operation: readFileSync(
      new URL("../../apps/web/src/data/operation-delivery.ts", import.meta.url),
      "utf8",
    ),
  }).get("Operation")!;
  const errorClass = one(
    operationOwner.source.statements
      .filter(isClassDeclaration)
      .filter((value) => value.name?.text === "UnsentOperationError"),
    "object-original-unsent-constructor",
  );
  assert.equal(
    errorClass.getText().replace(/^export /, ""),
    fixed.spans.UnsentOperationError.raw,
    "object-original-unsent-constructor",
  );
  assert.ok(
    errorClass.modifiers?.some(
      (value) => value.kind === SyntaxKind.ExportKeyword,
    ),
    "object-original-unsent-constructor",
  );
  const error = imported(
    client,
    "./data/operation-delivery.js",
    "UnsentOperationError",
  );
  const command = one(
    dispatch.body.statements
      .filter(isVariableStatement)
      .flatMap((value) => [...value.declarationList.declarations])
      .filter((value) => isObjectBindingPattern(value.name)),
    "object-original-command-capture",
  );
  assert.ok(isObjectBindingPattern(command.name));
  const commandNames = command.name.elements.filter(isBindingElement);
  const captured = (name: string): Node => {
    const value = one(
      commandNames.filter((value) => value.name?.getText() === name),
      "object-original-command-capture " + name,
    );
    assert.ok(value.name);
    return value.name;
  };
  for (const [type, name] of [
    ["annotate", "annotateObjectOperation"],
    ["link-artifacts", "linkWorkOperation"],
  ] as const) {
    const slot: IfStatement = one(
      dispatch.body.statements
        .filter(isIfStatement)
        .filter(
          (value) =>
            isBinaryExpression(value.expression) &&
            isStringLiteral(value.expression.right) &&
            value.expression.right.text === type,
        ),
      "object-original-dispatch-slot " + type,
    );
    assert.equal(
      slot.expression.getText(),
      `op.type === "${type}"`,
      "object-original-dispatch-guard " + type,
    );
    assert.ok(
      isReturnStatement(slot.thenStatement) &&
        slot.thenStatement.expression &&
        isCallExpression(bare(slot.thenStatement.expression)),
      "object-direct-dispatch-leaf " + type,
    );
    const invocation = bare(slot.thenStatement.expression);
    assert.ok(isCallExpression(invocation));
    same(
      client,
      invocation.expression,
      imported(client, "./data/object-interactions.js", name),
      "object-real-dispatch-leaf " + type,
    );
    const ports: Node[] = [
      dispatch.parameters[0].name,
      captured("op"),
      captured("commandId"),
      done.name,
      ...(type === "annotate" ? [error] : []),
    ];
    assert.equal(
      invocation.arguments.length,
      ports.length,
      "object-original-dispatch-ports " + type,
    );
    ports.forEach((value, index) =>
      same(
        client,
        invocation.arguments[index]!,
        value,
        "object-original-dispatch-ports " + type,
      ),
    );
  }
  return true;
}
