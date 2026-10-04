import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NodeFlags,
  SyntaxKind,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
} from "typescript/unstable/ast";
import {
  parseReaderSources,
  readerFunction,
  readerShape,
  readerVariable,
  walkReader,
  type ParsedReaderSource,
} from "./fixtures/reader-reads-contract.js";
import { fixedOperationDelivery } from "./fixtures/operation-delivery-618fc8b9.js";

// Five borrowed values, bounded execute/classifier/class and actual consumption.
// No whole Client hash/inverse, module-wide purity theorem or UI/HTTP authority.
const clientText = readFileSync("apps/web/src/client.ts", "utf8");
const ownerText = readFileSync(
  "apps/web/src/data/operation-delivery.ts",
  "utf8",
);
const fixedText = readFileSync(
  "tests/fixtures/operation-delivery-618fc8b9.ts",
  "utf8",
);
const one = <T>(values: readonly T[], rule: string) => {
  assert.equal(values.length, 1, rule);
  return values[0]!;
};
const scoped = (parsed: ParsedReaderSource, body: Node) => {
  const nodes: Node[] = [];
  walkReader(body, (node) => {
    nodes.push(node);
  });
  return { ...parsed, nodes };
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
  for (let n = 0; n < 4 && isIdentifier(node); n++) {
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
function imported(
  parsed: ParsedReaderSource,
  module: string,
  name: string,
  value: boolean,
) {
  const found = parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === module,
    )
    .flatMap((node) => {
      const bindings = node.importClause?.namedBindings;
      return bindings && isNamedImports(bindings)
        ? bindings.elements
            .filter(
              (member) => (member.propertyName ?? member.name).text === name,
            )
            .map((member) => ({ member, clause: node.importClause! }))
        : [];
    });
  const result = one(found, "operation-real-import " + name);
  if (value)
    assert.ok(
      !result.member.isTypeOnly &&
        result.clause.phaseModifier !== SyntaxKind.TypeKeyword,
      "operation-real-runtime-import " + name,
    );
  return result.member.name;
}
function symbol(
  parsed: ParsedReaderSource,
  use: Node,
  actual: Node,
  rule: string,
) {
  const expected = parsed.symbols.get(actual);
  assert.notEqual(expected, undefined, rule);
  assert.equal(parsed.symbols.get(local(parsed, use)), expected, rule);
}
function canonical(
  parsed: ParsedReaderSource,
  node: Node,
  names: Map<number, string>,
): unknown {
  node = bare(node);
  if (isStringLiteral(node)) return [node.kind, node.text];
  if (isIdentifier(node)) {
    const id = parsed.symbols.get(local(parsed, node));
    const name = id === undefined ? undefined : names.get(id);
    if (name) return [node.kind, name];
  }
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(canonical(parsed, child, names));
  });
  return [
    node.kind,
    ...((node as Node & { operator?: number }).operator === undefined
      ? []
      : [(node as Node & { operator: number }).operator]),
    children.length ? children : node.getText(),
  ];
}
function valueProperty(node: Node, name: string, rule: string) {
  assert.ok(isObjectLiteralExpression(node), rule);
  const property = one(
    node.properties.filter(
      (value) =>
        (isPropertyAssignment(value) || isShorthandPropertyAssignment(value)) &&
        value.name.getText() === name,
    ),
    rule,
  );
  return isShorthandPropertyAssignment(property)
    ? property.name
    : (property as import("typescript/unstable/ast").PropertyAssignment)
        .initializer;
}
const originals = parseReaderSources({ Fixed: fixedText }).get("Fixed")!;
const expectedPorts = parseReaderSources({
  Ports: `type OperationDeliveryPorts = { current: { readonly current: Boot | null }; platform: { readonly current: PlatformClient | null }; localInputDelivery: Pick<ReturnType<typeof createLocalInputDelivery>, "recordInput">; executePlatformOperation: typeof executePlatformOperation; refreshAfterMutation(): Promise<boolean>; };`,
}).get("Ports")!;
const originalExecute = readerFunction(originals, "execute");
const portNames = [
  "current",
  "platform",
  "localInputDelivery",
  "executePlatformOperation",
  "refreshAfterMutation",
] as const;

function verify(clientSource = clientText, ownerSource = ownerText) {
  const parsed = parseReaderSources({
    Client: clientSource,
    Owner: ownerSource,
  });
  const client = parsed.get("Client")!,
    owner = parsed.get("Owner")!;
  const workspace = one(
    client.source.statements
      .filter(isFunctionDeclaration)
      .filter((fn) => fn.name?.text === "useWorkspace"),
    "operation-actual-client-host",
  );
  assert(workspace.body);
  const host = scoped(client, workspace.body),
    factory = one(
      owner.source.statements
        .filter(isFunctionDeclaration)
        .filter((fn) => fn.name?.text === "createOperationDelivery"),
      "operation-borrowed-inert-ports",
    );
  assert.ok(
    factory.body &&
      factory.parameters.length === 1 &&
      !factory.asteriskToken &&
      !factory.modifiers?.some((node) => node.kind === SyntaxKind.AsyncKeyword),
    "operation-borrowed-inert-ports",
  );
  assert.equal(
    factory.body.statements.length,
    3,
    "operation-borrowed-inert-ports",
  );
  const constructor = factory.body.statements[0];
  assert.ok(
    constructor &&
      isVariableStatement(constructor) &&
      constructor.declarationList.flags & NodeFlags.Const,
    "operation-borrowed-inert-ports",
  );
  const borrow = one(
    constructor.declarationList.declarations,
    "operation-borrowed-inert-ports",
  );
  assert.ok(
    isObjectBindingPattern(borrow.name) && borrow.initializer,
    "operation-borrowed-inert-ports",
  );
  symbol(
    owner,
    borrow.initializer,
    factory.parameters[0]!.name,
    "operation-borrowed-inert-ports",
  );
  const bindings = borrow.name.elements.filter(isBindingElement);
  assert.deepEqual(
    bindings.map((node) => {
      const name = node.propertyName ?? node.name;
      assert.ok(name, "operation-borrowed-inert-ports");
      return name.getText();
    }),
    [...portNames],
    "operation-borrowed-inert-ports",
  );
  const names = new Map<number, string>();
  const runtimeDependencies = new Map<string, Node>();
  for (const member of bindings) {
    assert.ok(member.name, "operation-borrowed-inert-ports");
    assert.ok(
      isIdentifier(member.name) &&
        !member.initializer &&
        !member.dotDotDotToken,
      "operation-borrowed-inert-ports",
    );
    const id = owner.symbols.get(member.name);
    assert.notEqual(id, undefined);
    names.set(id!, (member.propertyName ?? member.name).getText());
  }
  for (const [module, name, value] of [
    ["../local-preferences.js", "scopedStorage", true],
    ["../local-preferences.js", "draftKey", true],
    ["../application-transport.js", "RequestError", true],
    ["../../../../packages/core/src/model.js", "Operation", false],
    ["../../../../packages/core/src/model.js", "Receipt", false],
    ["../client.js", "Boot", false],
    ["../client.js", "executePlatformOperation", false],
    ["../platform-client.js", "PlatformClient", false],
    ["./local-input-delivery.js", "createLocalInputDelivery", false],
  ] as const) {
    const node = imported(owner, module, name, value),
      id = owner.symbols.get(node);
    if (value) runtimeDependencies.set(name, node);
    assert.notEqual(id, undefined);
    names.set(id!, name);
  }
  // Independently specified finite API, not a whole-module type inventory.
  const portsType = one(
    owner.source.statements
      .filter(isTypeAliasDeclaration)
      .filter((node) => node.name.text === "OperationDeliveryPorts"),
    "operation-five-typed-borrowports",
  );
  assert.deepEqual(
    canonical(owner, portsType.type, names),
    canonical(
      expectedPorts,
      expectedPorts.source.statements.filter(isTypeAliasDeclaration)[0]!.type,
      new Map(),
    ),
    "operation-five-typed-borrowports",
  );
  const error = one(
    owner.source.statements
      .filter(isClassDeclaration)
      .filter((node) => node.name?.text === "UnsentOperationError"),
    "operation-uncertain-receipt-policy",
  );
  assert.equal(
    error.getText().replace(/^export /, ""),
    "class UnsentOperationError extends Error {}",
    "operation-uncertain-receipt-policy",
  );
  assert.ok(
    error.modifiers?.some((node) => node.kind === SyntaxKind.ExportKeyword),
    "operation-uncertain-receipt-policy",
  );
  const classifier = readerFunction(owner, "operationMayCommitBeforeError");
  assert.deepEqual(
    canonical(owner, classifier, names),
    canonical(
      originals,
      readerFunction(originals, "operationMayCommitBeforeError"),
      new Map(),
    ),
    "operation-complete-may-commit-classifier",
  );
  const execute = one(
    factory.body.statements
      .filter(isFunctionDeclaration)
      .filter((fn) => fn.name?.text === "execute"),
    "operation-complete-bounded-execute",
  );
  assert.ok(
    execute.body && !execute.asteriskToken,
    "operation-complete-bounded-execute",
  );
  // Canonical names describe the bounded recipe; they do not prove provenance.
  // Inspect only its actual two helper calls and two instanceof constructors.
  // An unused correct import plus a same-named foreign value is not equivalent.
  const executeNodes = scoped(owner, execute.body).nodes;
  for (const name of ["scopedStorage", "draftKey"] as const) {
    const actual = runtimeDependencies.get(name)!;
    const calls = executeNodes
      .filter(isCallExpression)
      .filter(
        (call) =>
          owner.symbols.get(local(owner, call.expression)) ===
          owner.symbols.get(actual),
      );
    assert.equal(calls.length, 1, "operation-real-runtime-dependency " + name);
  }
  const checks = executeNodes.filter(
    (node) =>
      node.kind === SyntaxKind.BinaryExpression &&
      (node as import("typescript/unstable/ast").BinaryExpression).operatorToken
        .kind === SyntaxKind.InstanceOfKeyword,
  ) as import("typescript/unstable/ast").BinaryExpression[];
  assert.equal(checks.length, 2, "operation-uncertain-receipt-policy");
  assert.ok(error.name);
  symbol(
    owner,
    checks[0]!.right,
    error.name,
    "operation-uncertain-receipt-policy",
  );
  symbol(
    owner,
    checks[1]!.right,
    runtimeDependencies.get("RequestError")!,
    "operation-real-runtime-dependency RequestError",
  );
  assert.deepEqual(
    execute.modifiers?.map((node) => node.kind),
    [SyntaxKind.AsyncKeyword],
    "operation-complete-bounded-execute",
  );
  assert.deepEqual(
    execute.parameters.map((node) => canonical(owner, node, names)),
    originalExecute.parameters.map(readerShape),
    "operation-complete-bounded-execute",
  );
  assert.equal(
    execute.body.statements.length,
    9,
    "operation-complete-bounded-execute",
  );
  const rules = [
    "operation-captured-command-origin",
    "operation-captured-command-origin",
    "operation-exact-refresh-and-input-handoff",
    "operation-frozen-pending-identity",
    "operation-frozen-pending-identity",
    "operation-captured-command-origin",
    "operation-frozen-pending-identity",
    "operation-preflight-storage-order",
  ];
  for (let n = 0; n < 8; n++)
    assert.deepEqual(
      canonical(owner, execute.body.statements[n]!, names),
      canonical(originals, originalExecute.body!.statements[n]!, new Map()),
      rules[n],
    );
  const currentTry = execute.body
      .statements[8] as import("typescript/unstable/ast").TryStatement,
    oldTry = originalExecute.body!
      .statements[8] as import("typescript/unstable/ast").TryStatement;
  assert.equal(
    currentTry.kind,
    SyntaxKind.TryStatement,
    "operation-preflight-storage-order",
  );
  assert.equal(
    currentTry.tryBlock.statements.length,
    oldTry.tryBlock.statements.length,
    "operation-exact-refresh-and-input-handoff",
  );
  currentTry.tryBlock.statements.forEach((statement, n) =>
    assert.deepEqual(
      canonical(owner, statement, names),
      canonical(originals, oldTry.tryBlock.statements[n]!, new Map()),
      n < 3
        ? "operation-captured-command-origin"
        : "operation-exact-refresh-and-input-handoff",
    ),
  );
  assert.ok(
    currentTry.catchClause && oldTry.catchClause && !currentTry.finallyBlock,
    "operation-uncertain-receipt-policy",
  );
  assert.deepEqual(
    canonical(owner, currentTry.catchClause, names),
    canonical(originals, oldTry.catchClause, new Map()),
    "operation-uncertain-receipt-policy",
  );
  const returned = factory.body.statements[2];
  assert.ok(
    returned &&
      isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
    "operation-direct-execute-reference",
  );
  assert.equal(
    returned.expression.properties.length,
    1,
    "operation-direct-execute-reference",
  );
  symbol(
    owner,
    valueProperty(
      returned.expression,
      "execute",
      "operation-direct-execute-reference",
    ),
    execute.name!,
    "operation-direct-execute-reference",
  );

  const binding = readerVariable(host, "operationDelivery"),
    runtimeFactory = imported(
      client,
      "./data/operation-delivery.js",
      "createOperationDelivery",
      true,
    );
  const calls = host.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        client.symbols.get(local(client, node.expression)) ===
        client.symbols.get(runtimeFactory),
    );
  assert.equal(calls.length, 1, "operation-one-actual-constructor");
  assert.ok(
    binding.initializer && isCallExpression(binding.initializer),
    "operation-direct-constructor",
  );
  assert.equal(binding.initializer, calls[0], "operation-direct-constructor");
  const statement = binding.parent.parent,
    siblings = workspace.body.statements,
    index = siblings.indexOf(
      statement as import("typescript/unstable/ast").Statement,
    );
  assert.ok(
    isVariableStatement(statement) &&
      statement.parent === workspace.body &&
      statement.declarationList.flags & NodeFlags.Const &&
      siblings.indexOf(
        readerVariable(host, "localInputDelivery").parent
          .parent as import("typescript/unstable/ast").Statement,
      ) < index &&
      index <
        siblings.indexOf(
          readerVariable(host, "executionInteractions").parent
            .parent as import("typescript/unstable/ast").Statement,
        ),
    "operation-original-registration-slot",
  );
  assert.equal(
    binding.initializer.arguments.length,
    1,
    "operation-borrowed-inert-ports",
  );
  const values = binding.initializer.arguments[0]!;
  assert.ok(
    isObjectLiteralExpression(values) && values.properties.length === 5,
    "operation-borrowed-inert-ports",
  );
  for (const name of portNames) {
    const value = valueProperty(values, name, "operation-borrowed-inert-ports");
    const actual =
      name === "executePlatformOperation"
        ? one(
            client.source.statements
              .filter(isFunctionDeclaration)
              .filter((node) => node.name?.text === name),
            "operation-real-dispatcher",
          ).name!
        : name === "refreshAfterMutation"
          ? one(
              workspace.body.statements
                .filter(isFunctionDeclaration)
                .filter((node) => node.name?.text === name),
              "operation-real-refresh-authority",
            ).name!
          : readerVariable(host, name).name;
    symbol(client, value, actual, "operation-borrowed-inert-ports");
  }
  for (const name of ["current", "platform"] as const) {
    const ref = readerVariable(host, name);
    assert.ok(
      ref.initializer &&
        isCallExpression(ref.initializer) &&
        ref.parent.flags & NodeFlags.Const,
      "operation-original-live-refs",
    );
    symbol(
      client,
      ref.initializer.expression,
      imported(client, "react", "useRef", true),
      "operation-original-live-refs",
    );
    assert.equal(
      ref.initializer.arguments[0]?.kind,
      SyntaxKind.NullKeyword,
      "operation-original-live-refs",
    );
    assert.ok(ref.end < binding.pos, "operation-original-live-refs");
  }
  const clear = one(
    workspace.body.statements
      .filter(isFunctionDeclaration)
      .filter((node) => node.name?.text === "clearProtectedProjection"),
    "operation-current-retirement",
  );
  assert.ok(clear.body, "operation-current-retirement");
  const current = readerVariable(host, "current").name;
  const writes = scoped(client, clear.body)
    .nodes.filter((node) => node.kind === SyntaxKind.BinaryExpression)
    .filter((node) => {
      const expression =
        node as import("typescript/unstable/ast").BinaryExpression;
      return (
        isPropertyAccessExpression(expression.left) &&
        expression.left.name.text === "current" &&
        client.symbols.get(local(client, expression.left.expression)) ===
          client.symbols.get(current)
      );
    }) as import("typescript/unstable/ast").BinaryExpression[];
  assert.equal(writes.length, 1, "operation-current-retirement");
  assert.equal(
    writes[0]!.right.kind,
    SyntaxKind.NullKeyword,
    "operation-current-retirement",
  );
  assert.equal(
    writes[0]!.parent.parent,
    clear.body,
    "operation-current-retirement",
  );
  assert.equal(
    clear.body.statements
      .slice(
        0,
        clear.body.statements.indexOf(
          writes[0]!.parent as import("typescript/unstable/ast").Statement,
        ),
      )
      .some(
        (node) =>
          node.kind === SyntaxKind.ReturnStatement ||
          node.kind === SyntaxKind.IfStatement,
      ),
    false,
    "operation-current-retirement",
  );
  const publicReturn = one(
    workspace.body.statements.filter(isReturnStatement),
    "operation-direct-execute-reference",
  );
  assert(publicReturn.expression);
  const direct = bare(
    valueProperty(
      publicReturn.expression,
      "execute",
      "operation-direct-execute-reference",
    ),
  );
  assert.ok(
    isPropertyAccessExpression(direct) && direct.name.text === "execute",
    "operation-direct-execute-reference",
  );
  symbol(
    client,
    direct.expression,
    binding.name,
    "operation-direct-execute-reference",
  );
  assert.equal(
    host.nodes
      .filter(isFunctionDeclaration)
      .filter((node) => node.name?.text === "execute").length,
    0,
    "operation-no-duplicate-client-delivery",
  );
  const dispatcher = readerFunction(client, "executePlatformOperation"),
    unsent = imported(
      client,
      "./data/operation-delivery.js",
      "UnsentOperationError",
      true,
    );
  const constructors = scoped(client, dispatcher.body!)
    .nodes.filter(isNewExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) && node.expression.text !== "Error",
    );
  assert.ok(constructors.length > 0, "operation-identical-unsent-constructor");
  constructors.forEach((node) =>
    symbol(
      client,
      node.expression,
      unsent,
      "operation-identical-unsent-constructor",
    ),
  );
  return true;
}
function changed(text: string, before: string, after: string) {
  assert.equal(
    text.split(before).length,
    2,
    "one exact counterfactual source target",
  );
  const value = text.replace(before, after);
  parseReaderSources({ Variant: value });
  return value;
}

test("fixed fresh618 six complete executable algorithms preserve raw provenance without CI Git", () => {
  assert.equal(
    fixedOperationDelivery.baseline,
    "618fc8b96f56cc6447f1b2471f46c1d24fabbc57",
  );
  for (const [name, metadata] of Object.entries(fixedOperationDelivery.spans)) {
    let raw: string;
    if (name === "UnsentOperationError")
      raw = one(
        originals.source.statements
          .filter(isClassDeclaration)
          .filter((node) => node.name?.text === name),
        "fixed original class",
      ).getText();
    else
      raw = readerFunction(
        originals,
        name === "executePlatformOperation"
          ? "fixedExecutePlatformOperation"
          : name,
      )
        .getText()
        .replace(
          "export async function fixedExecutePlatformOperation(",
          "export async function executePlatformOperation(",
        );
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      metadata.sha256,
      "complete actual Git618 raw " + name,
    );
    assert.equal(Buffer.byteLength(raw), metadata.bytes);
  }
});
test("actual durable owner is inert, uses complete bounded algorithms and live direct Client consumption", () => {
  assert.equal(verify(), true);
});
test("parse-valid owner variants reject designated origin, pending, uncertainty, order and input contracts", () => {
  const variants = [
    [
      "current: { readonly current: Boot | null }",
      "current: Boot | null",
      "operation-five-typed-borrowports",
    ],
    [
      "  async function execute(",
      "  current.current;\n  async function execute(",
      "operation-borrowed-inert-ports",
    ],
    [
      "scope = `${identity.centerId}:${identity.principalId}`",
      "scope = `${identity.centerId}:${identity.principalId}:${identity.actantId}`",
      "operation-captured-command-origin",
    ],
    [
      "          applicationInstanceId,\n",
      "          applicationInstanceId: undefined,\n",
      "operation-frozen-pending-identity",
    ],
    [
      "commandId: externalCommandId ?? crypto.randomUUID()",
      "commandId: crypto.randomUUID()",
      "operation-frozen-pending-identity",
    ],
    [
      "current.current?.csrfToken !== identity.csrfToken",
      "false",
      "operation-captured-command-origin",
    ],
    [
      "return localInputDelivery.recordInput(",
      "return await localInputDelivery.recordInput(",
      "operation-exact-refresh-and-input-handoff",
    ],
    [
      "writeLocal(key, command);",
      "writeLocal(key, null);",
      "operation-preflight-storage-order",
    ],
    [
      "      writeLocal(key, null);\n      await refreshAfterMutation();",
      "      await refreshAfterMutation();\n      writeLocal(key, null);",
      "operation-exact-refresh-and-input-handoff",
    ],
    [
      "e.status !== 408",
      "e.status !== 400",
      "operation-uncertain-receipt-policy",
    ],
    [
      "if (e instanceof UnsentOperationError)",
      'if (e instanceof Error && e.message.includes("未发送"))',
      "operation-uncertain-receipt-policy",
    ],
    [
      '["document", "image", "interactive"]',
      '["document", "image", "interactive", "task"]',
      "operation-complete-may-commit-classifier",
    ],
  ] as const;
  for (const [before, after, rule] of variants) {
    const source = before.startsWith('["document"')
      ? ownerText.replace(before, after)
      : changed(ownerText, before, after);
    parseReaderSources({ Variant: source });
    assert.throws(() => verify(clientText, source), {
      name: "AssertionError",
      message: new RegExp(rule),
    });
  }
  for (const [before, after, name] of [
    [
      'import { scopedStorage, draftKey } from "../local-preferences.js";',
      'import { scopedStorage as unusedCorrectStorage, draftKey } from "../local-preferences.js"; import { scopedStorage } from "../foreign-storage.js";',
      "scopedStorage",
    ],
    [
      'import { scopedStorage, draftKey } from "../local-preferences.js";',
      'import { scopedStorage, draftKey as unusedCorrectKey } from "../local-preferences.js"; import { draftKey } from "../foreign-storage.js";',
      "draftKey",
    ],
    [
      'import { RequestError } from "../application-transport.js";',
      'import { RequestError as unusedCorrectError } from "../application-transport.js"; import { RequestError } from "../foreign-transport.js";',
      "RequestError",
    ],
  ] as const)
    assert.throws(() => verify(clientText, changed(ownerText, before, after)), {
      name: "AssertionError",
      message: new RegExp("operation-real-runtime-dependency " + name),
    });
});
test("parse-valid Client variants reject actual import, borrowed refs, wrapper, retirement and error identity", () => {
  const variants = [
    [
      "  createOperationDelivery,",
      "  type createOperationDelivery,",
      "operation-real-runtime-import createOperationDelivery",
    ],
    [
      "const operationDelivery = createOperationDelivery({",
      "const operationDelivery = (() => createOperationDelivery({",
      "operation-direct-constructor",
    ],
    [
      "    execute: operationDelivery.execute,",
      "    execute: (...args) => operationDelivery.execute(...args),",
      "operation-direct-execute-reference",
    ],
    [
      "    localInputDelivery,\n    executePlatformOperation,\n    refreshAfterMutation,\n  });\n  const executionInteractions",
      "    localInputDelivery: {recordInput:localInputDelivery.recordInput},\n    executePlatformOperation,\n    refreshAfterMutation,\n  });\n  const executionInteractions",
      "operation-borrowed-inert-ports",
    ],
    [
      "throw new UnsentOperationError(",
      "throw new ForeignUnsentOperationError(",
      "operation-identical-unsent-constructor",
    ],
  ] as const;
  for (const [before, after, rule] of variants) {
    let source: string;
    if (rule === "operation-direct-constructor")
      source = changed(
        clientText,
        "  const operationDelivery = createOperationDelivery({\n    current,\n    platform,\n    localInputDelivery,\n    executePlatformOperation,\n    refreshAfterMutation,\n  });",
        "  const operationDelivery = (() => createOperationDelivery({current,platform,localInputDelivery,executePlatformOperation,refreshAfterMutation}))();",
      );
    else if (rule === "operation-identical-unsent-constructor") {
      source =
        clientText.replace(before, after) +
        "\nclass ForeignUnsentOperationError extends Error {}\n";
      parseReaderSources({ Variant: source });
    } else source = changed(clientText, before, after);
    assert.throws(() => verify(source), {
      name: "AssertionError",
      message: new RegExp(rule),
    });
  }
  const clear = readerFunction(
    parseReaderSources({ Client: clientText }).get("Client")!,
    "clearProtectedProjection",
  ).getText();
  for (const replacement of [
    clear.replace(
      "current.current = null;",
      "if (Date.now()) current.current = null;",
    ),
    clear.replace(
      "current.current = null;",
      "current.current = current.current;",
    ),
    clear.replace(
      "    protectedReadGeneration.current++;",
      "    return;\n    protectedReadGeneration.current++;",
    ),
  ])
    assert.throws(() => verify(changed(clientText, clear, replacement)), {
      name: "AssertionError",
      message: /operation-current-retirement/,
    });
});
test("real import/local aliases, static types and consumed unrelated Client or module growth remain legal", () => {
  let client = changed(
    clientText,
    "  createOperationDelivery,",
    "  createOperationDelivery as makeDelivery,",
  );
  client =
    changed(
      client,
      "  const operationDelivery = createOperationDelivery(",
      "  const operationDelivery = deliveryFactory(",
    ) + "\nconst deliveryFactory: typeof makeDelivery = makeDelivery;\n";
  client = changed(
    client,
    "    execute: operationDelivery.execute,",
    "    execute: borrowedDelivery.execute,",
  );
  client = changed(
    client,
    "  const executionInteractions =",
    "  const borrowedDelivery = operationDelivery;\n  const executionInteractions =",
  );
  // Alias is separate from the original constructor slot, never a wrapper.
  client = client
    .replace(
      "  const borrowedDelivery = operationDelivery;\n  const executionInteractions =",
      "  const executionInteractions =",
    )
    .replace(
      "  return {\n    notifications:",
      "  const borrowedDelivery = operationDelivery;\n  return {\n    notifications:",
    );
  assert.equal(verify(client), true);
  const owner = ownerText
    .replace(
      "import { RequestError }",
      "import { RequestError as TransportFailure }",
    )
    .replaceAll("instanceof RequestError", "instanceof TransportFailure");
  assert.equal(verify(clientText, owner), true);
  const localDependencies =
    ownerText
      .replace(
        "import { scopedStorage, draftKey }",
        "import { scopedStorage as originalStorage, draftKey as originalKey }",
      )
      .replace(
        "import { RequestError }",
        "import { RequestError as OriginalRequestError }",
      )
      .replace("= scopedStorage(scope)", "= storageAlias(scope)")
      .replace("const key = draftKey(", "const key = keyAlias(")
      .replaceAll("instanceof RequestError", "instanceof requestAlias") +
    "\nconst storageAlias: typeof originalStorage = originalStorage; const keyAlias = originalKey; const requestAlias = OriginalRequestError;\n";
  assert.equal(verify(clientText, localDependencies), true);
  const typed = changed(
    changed(
      ownerText,
      "{ Boot, executePlatformOperation }",
      "{ Boot as OriginBoot, executePlatformOperation }",
    ),
    "current: Boot | null",
    "current: OriginBoot | null",
  );
  assert.equal(
    verify(
      clientText,
      typed + "\nexport type FutureDeliveryBoot = OriginBoot[];\n",
    ),
    true,
  );
  const growth = changed(
    changed(
      changed(
        clientText,
        "export function useWorkspace() {",
        "export function useWorkspace() {\n const independent = useRef(new Map<string,string>()); const [future,updateFuture] = useState(0); useEffect(()=>{independent.current.set('future',String(future));},[future]); const futureAction=()=>updateFuture(n=>n+1);",
      ),
      "    setContentCounts([]);",
      "    setContentCounts([]); independent.current.clear();",
    ),
    "    execute: operationDelivery.execute,",
    "    execute: operationDelivery.execute, future,futureAction,",
  );
  assert.equal(
    verify(
      growth,
      ownerText +
        "\nexport function independentFeature(current: string) { return current.trim(); }\nexport type IndependentType = { value: number };\n",
    ),
    true,
  );
});
