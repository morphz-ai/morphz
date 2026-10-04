import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  NodeFlags,
  SyntaxKind,
  isArrayBindingPattern,
  isBindingElement,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
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
  readerImport,
  readerShape,
  readerVariable,
} from "./reader-reads-contract.js";
import { inverseScriptCatalogPublicationFix } from "./script-catalog-publication-fix.js";

// A finite source inverse of five original algorithms and their Client seam.
// This does not establish HTTP permission, Runtime outcomes, React scheduling
// or original App/native acceptance. CI needs neither Git history nor a shell.
export const executionOwnerText = readFileSync(
  new URL("../../apps/web/src/data/execution-interactions.ts", import.meta.url),
  "utf8",
);
const fixedText = readFileSync(
  new URL("./execution-interactions-51f9101e.ts", import.meta.url),
  "utf8",
);
export const originalExecutionClientSha =
  "effed98cb46cd9ab9ed968a1877ba3c363c2496ab6ca87bd243bd2034225c679";
export const executionNames = [
  "cancelInput",
  "executionSnapshot",
  "executionResult",
  "controlExecution",
  "approvalSubmitted",
] as const;
// Independently taken from the complete actual Git 51f9101e Client functions.
export const executionSourceHashes = {
  cancelInput:
    "e2fcdb5a456411526851f77347ae7e9cb3edcd91f6a5f576433e7e9fe2ade0c8",
  executionSnapshot:
    "27095ecdf2c8bef7939e3c5fd5c8c764612dfebccaeaab4963a4d8d955777411",
  executionResult:
    "8ee153277bd996ab4ff57c91c17c96640661fa6fc1a4930963244fb99f502a54",
  controlExecution:
    "d0475fb63d6bcd4afa17a17c56e135d8ca5d1e0f3da00eb0ea0acbef66946d6d",
  approvalSubmitted:
    "437a5679224991d49672cf83b9c1f9e8edd288c695a0da987c61e749ea24d409",
} as const;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const executionRegistration = `  const executionInteractions = createExecutionInteractions({
    current,
    approvalSubmissions,
    updateApprovalSubmissions,
    call: applicationCall,
    refreshAfterMutation,
  });\n`;
const expected = parseReaderSources({
  Expected: `
  export type ExecutionInteractionPorts = {
    current: { readonly current: Boot | null };
    approvalSubmissions: { readonly current: Set<string> };
    updateApprovalSubmissions(value: number | ((version: number) => number)): void;
    call: typeof applicationCall;
    refreshAfterMutation(): Promise<boolean>;
  };
  function createExecutionInteractions({ current, approvalSubmissions, updateApprovalSubmissions, call: applicationCall, refreshAfterMutation }: ExecutionInteractionPorts) {
    return { cancelInput, executionSnapshot, executionResult, controlExecution, approvalSubmitted };
  }
  ${executionRegistration}
  const current = useRef<Boot | null>(null);
  const approvalSubmissions = useRef(new Set<string>());
  const [, updateApprovalSubmissions] = useState(0);
  `,
}).get("Expected")!;
function same(actual: Node, original: Node, rule: string) {
  assert.deepEqual(readerShape(actual), readerShape(original), rule);
}
function replaceOnce(text: string, before: string, after: string) {
  assert.equal(
    text.split(before).length,
    2,
    "one finite execution inverse target",
  );
  return text.replace(before, after);
}
export function verifiedExecutionOriginals() {
  const fixed = parseReaderSources({ Fixed: fixedText }).get("Fixed")!;
  for (const name of executionNames)
    assert.equal(
      sha(readerFunction(fixed, name).getText()),
      executionSourceHashes[name],
      "fixed complete actual Git51f execution algorithm " + name,
    );
  return fixed;
}
export function verifyExecutionInteractionOwner(
  ownerText = executionOwnerText,
) {
  const owner = parseReaderSources({ Owner: ownerText }).get("Owner")!,
    fixed = verifiedExecutionOriginals(),
    factory = readerFunction(owner, "createExecutionInteractions");
  assert.deepEqual(
    factory.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "synchronous inert execution factory",
  );
  assert.equal(factory.typeParameters, undefined);
  assert.equal(factory.type, undefined);
  assert.deepEqual(
    factory.parameters.map(readerShape),
    readerFunction(expected, "createExecutionInteractions").parameters.map(
      readerShape,
    ),
    "exact borrowed execution ports",
  );
  const functions = factory.body!.statements.filter(isFunctionDeclaration);
  assert.deepEqual(
    functions.map((node) => node.name?.text),
    executionNames,
  );
  assert.equal(
    factory.body!.statements.length,
    executionNames.length + 1,
    "only five commands and direct return, no construction work",
  );
  same(
    factory.body!.statements.at(-1)!,
    readerFunction(expected, "createExecutionInteractions").body!
      .statements[0]!,
    "direct execution return without wrappers",
  );
  const returned = factory.body!.statements.at(-1)!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
  );
  for (const property of returned.expression.properties) {
    assert.ok(
      isShorthandPropertyAssignment(property) && isIdentifier(property.name),
    );
    assert.equal(
      owner.symbols.get(property.name),
      owner.symbols.get(readerFunction(owner, property.name.text).name!),
      "return actual execution algorithm",
    );
  }
  for (const name of executionNames)
    assert.equal(
      readerFunction(owner, name).getText(),
      readerFunction(fixed, name).getText(),
      "complete original execution algorithm " + name,
    );
  for (const statement of owner.source.statements)
    assert.ok(
      isImportDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        statement === factory,
      "finite inert execution module",
    );
  const types = owner.source.statements.filter(isTypeAliasDeclaration);
  assert.equal(types.length, 1, "one finite borrowed execution port type");
  same(
    types[0]!,
    expected.source.statements.find(isTypeAliasDeclaration)!,
    "exact original execution port contract",
  );
  assert.deepEqual(
    owner.source.statements
      .filter(isImportDeclaration)
      .filter(
        (node) => node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword,
      )
      .map((node) => node.getText()),
    [
      'import { z } from "zod";',
      'import {\n  executionSnapshotSchema,\n  type ExecutionScope,\n  type ExecutionControl,\n} from "../../../../packages/core/src/execution.js";',
    ],
    "only original execution schemas at runtime",
  );
  return { fixed };
}

// Validate this production seam before restoring only stage24. The complete
// Client SHA is checked by the new gate, not here: earlier gates must still
// diagnose their original legal mutations after stage24 then stage23 inverses.
export function expandExecutionInteractionConsumption(
  clientText: string,
  ownerText = executionOwnerText,
) {
  clientText = inverseScriptCatalogPublicationFix(clientText);
  const { fixed } = verifyExecutionInteractionOwner(ownerText),
    client = parseReaderSources({ Client: clientText }).get("Client")!,
    workspace = readerFunction(client, "useWorkspace"),
    imported = readerImport(
      client,
      "./data/execution-interactions.js",
      "createExecutionInteractions",
    ),
    binding = readerVariable(client, "executionInteractions");
  const imports = client.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "./data/execution-interactions.js",
    );
  assert.equal(imports.length, 1, "one actual execution import");
  const declaration = imports[0]!,
    named = declaration.importClause?.namedBindings;
  assert.ok(
    named &&
      isNamedImports(named) &&
      named.elements.length === 1 &&
      !named.elements[0]!.isTypeOnly &&
      !declaration.importClause?.name &&
      declaration.importClause?.phaseModifier !== SyntaxKind.TypeKeyword,
    "runtime execution factory import",
  );
  const calls = client.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        client.symbols.get(node.expression) === imported.symbol,
    );
  assert.equal(calls.length, 1, "one actual execution construction");
  assert.equal(
    binding.initializer,
    calls[0],
    "direct execution constructor, no memo or bridge",
  );
  const statement = binding.parent.parent;
  assert.ok(
    isVariableStatement(statement) &&
      statement.parent === workspace.body &&
      statement.declarationList.flags & NodeFlags.Const,
    "unconditional render-local execution construction",
  );
  const siblings = workspace.body!.statements,
    index = siblings.indexOf(statement);
  assert.ok(
    index > 0 &&
      siblings[index - 1] ===
        readerVariable(client, "localInputDelivery").parent.parent &&
      siblings[index + 1] ===
        readerFunction(client, "clearProtectedProjection"),
    "original execution registration location",
  );
  assert.equal(calls[0]!.arguments.length, 1);
  same(
    calls[0]!.arguments[0]!,
    (
      readerVariable(expected, "executionInteractions")
        .initializer as import("typescript/unstable/ast").CallExpression
    ).arguments[0]!,
    "exact original execution captures",
  );
  const ports = calls[0]!.arguments[0]!;
  assert.ok(isObjectLiteralExpression(ports));
  for (const name of ["current", "approvalSubmissions"] as const) {
    const ref = readerVariable(client, name);
    const property: Node | undefined = ports.properties.find(
      (node) =>
        isShorthandPropertyAssignment(node) &&
        isIdentifier(node.name) &&
        node.name.text === name,
    );
    assert.ok(
      property &&
        isShorthandPropertyAssignment(property) &&
        ref.initializer &&
        isCallExpression(ref.initializer),
    );
    same(
      ref,
      readerVariable(expected, name),
      "original execution Client ref " + name,
    );
    assert.equal(
      client.symbols.get(property.name),
      client.symbols.get(ref.name),
      "borrow actual execution Client ref " + name,
    );
    assert.equal(
      client.symbols.get(ref.initializer.expression),
      readerImport(client, "react", "useRef").symbol,
      "original execution useRef registration",
    );
    assert.ok(ref.end < binding.pos);
  }
  const updates = client.nodes
    .filter(isBindingElement)
    .filter(
      (node) =>
        node.name &&
        isIdentifier(node.name) &&
        node.name.text === "updateApprovalSubmissions",
    );
  assert.equal(updates.length, 1, "one original approval updater");
  const update = updates[0]!,
    array = update.parent,
    updateDeclaration = array.parent;
  assert.ok(
    isArrayBindingPattern(array) &&
      isVariableDeclaration(updateDeclaration) &&
      updateDeclaration.initializer &&
      isCallExpression(updateDeclaration.initializer),
  );
  assert.equal(
    updateDeclaration.parent.parent.getText(),
    "const [, updateApprovalSubmissions] = useState(0);",
    "original approval state registration",
  );
  assert.equal(
    client.symbols.get(updateDeclaration.initializer.expression),
    readerImport(client, "react", "useState").symbol,
    "original approval React hook",
  );
  const updater = ports.properties.find(
    (node) =>
      isShorthandPropertyAssignment(node) &&
      isIdentifier(node.name) &&
      node.name.text === "updateApprovalSubmissions",
  );
  assert.ok(updater && isShorthandPropertyAssignment(updater) && update.name);
  assert.equal(
    client.symbols.get(updater.name),
    client.symbols.get(update.name),
    "borrow original approval updater",
  );
  assert.ok(update.end < binding.pos);
  for (const name of ["call", "refreshAfterMutation"]) {
    const property: Node | undefined = ports.properties.find(
      (node) =>
        (isPropertyAssignment(node) || isShorthandPropertyAssignment(node)) &&
        isIdentifier(node.name) &&
        node.name.text === name,
    );
    assert.ok(property);
    const value: Node | undefined = isPropertyAssignment(property)
      ? property.initializer
      : isShorthandPropertyAssignment(property)
        ? property.name
        : undefined;
    assert.ok(value && isIdentifier(value));
    assert.equal(
      client.symbols.get(value),
      name === "call"
        ? readerImport(client, "./application-transport.js", "applicationCall")
            .symbol
        : client.symbols.get(readerFunction(client, name).name!),
      "capture actual original execution function " + name,
    );
  }
  assert.equal(
    client.nodes
      .filter(isFunctionDeclaration)
      .filter((node) =>
        executionNames.includes(
          node.name?.text as (typeof executionNames)[number],
        ),
      ).length,
    0,
    "no duplicate Client execution algorithms",
  );
  const uses = client.nodes
    .filter(isPropertyAccessExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        client.symbols.get(node.expression) ===
          client.symbols.get(binding.name),
    );
  assert.deepEqual(
    uses.map((node) => node.name.text).sort(),
    [...executionNames].sort(),
    "only five actual Client execution consumers",
  );
  const returns = workspace.body!.statements.filter(isReturnStatement);
  assert.equal(returns.length, 1);
  const result = returns[0]!.expression;
  assert.ok(result && isObjectLiteralExpression(result));
  for (const name of executionNames) {
    const properties: Node[] = result.properties.filter(
      (node) =>
        isPropertyAssignment(node) &&
        isIdentifier(node.name) &&
        node.name.text === name,
    );
    assert.equal(properties.length, 1, "one public execution method " + name);
    const property = properties[0]!;
    assert.ok(
      isPropertyAssignment(property) &&
        isPropertyAccessExpression(property.initializer) &&
        isIdentifier(property.initializer.expression),
      "direct public execution alias " + name,
    );
    assert.equal(
      property.initializer.name.text,
      name,
      "exact corresponding execution method",
    );
    assert.equal(
      client.symbols.get(property.initializer.expression),
      client.symbols.get(binding.name),
      "actual execution owner public alias",
    );
  }
  let restored = replaceOnce(
    clientText,
    'import { createExecutionInteractions } from "./data/execution-interactions.js";\n',
    "",
  );
  restored = replaceOnce(restored, executionRegistration, "");
  restored = replaceOnce(
    restored,
    "import type {\n  SearchRequest,",
    'import {\n  executionSnapshotSchema,\n  type ExecutionScope,\n  type ExecutionControl,\n} from "../../../packages/core/src/execution.js";\nimport type {\n  SearchRequest,',
  );
  restored = replaceOnce(
    restored,
    "  async function search(",
    "  " +
      readerFunction(fixed, "cancelInput").getText() +
      "\n  async function search(",
  );
  restored = replaceOnce(
    restored,
    "  async function speechStatus(",
    "  " +
      executionNames
        .slice(1)
        .map((name) => readerFunction(fixed, name).getText())
        .join("\n  ") +
      "\n  async function speechStatus(",
  );
  for (const name of executionNames)
    restored = replaceOnce(
      restored,
      `    ${name}: executionInteractions.${name},`,
      `    ${name},`,
    );
  return restored;
}
