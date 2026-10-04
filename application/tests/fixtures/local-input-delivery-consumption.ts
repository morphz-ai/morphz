import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  NodeFlags,
  SyntaxKind,
  isBlock,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
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
import {
  legacyConfirmationBlock,
  legacyRecordBlock,
} from "./local-input-delivery-32c52210.js";
import { inverseScriptCatalogPublicationFix } from "./script-catalog-publication-fix.js";

// Finite inverse of this delivery seam, not a generic AST framework or a proof
// of storage, authority, React scheduling, HTTP outcomes or native UI behavior.
export const localDeliveryOwnerText = readFileSync(
  new URL("../../apps/web/src/data/local-input-delivery.ts", import.meta.url),
  "utf8",
);
const fixedText = readFileSync(
  new URL("./local-input-delivery-32c52210.ts", import.meta.url),
  "utf8",
);
export const originalDeliveryClientSha =
  "5ef656793c9f70eada0bfc4eb0dcfc54ae4efab2d25eca6fd8d7dbdcdb2c3128";
export const deliverySourceHashes = {
  sendingInputIds:
    "8a397cb625982b39ec6976b5834e4d8c859410782b1d819d97ee0c96d332ef02",
  publishSavedInputs:
    "04ffdacfd5799e64f0ed21ee4c4f4b76215ef78ce209d1afd31bd44c70f87e4e",
  submitSavedInput:
    "3db6ed7338ca04d5b6183a0a0b70331c3d388b00104438abf4896646dc478fda",
  execute: "632e1d95d6b8c60505a2658e1c812702cdd45f6a705e64f389ec2381b8f11fca",
  dispatchInput:
    "8ca70fe6f7559c75d4d0c792d6ba96e30d49c4839d68f8343f1765d4233cbc28",
  record: "89309f544d8ccf1eadc04028325ff44c2596903f2c41c9af4fe1f33aa7e55557",
  confirm: "bc765397ff1333e9c0dc5a8110c1d5dcea6b83238f7d081316b37578399e29bb",
} as const;
const originalNames = [
  "sendingInputIds",
  "publishSavedInputs",
  "submitSavedInput",
  "dispatchInput",
] as const;
const allNames = [
  "readSaved",
  ...originalNames.slice(0, 3),
  "recordInput",
  "dispatchInput",
  "confirmAndProject",
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const expected = parseReaderSources({
  Expected: `
  function createLocalInputDelivery({ inputSends, current, platform, snapshotText, storage, savedInputScope, executePlatformOperation, setBoot, refreshAfterMutation, call: applicationCall }: LocalInputDeliveryPorts) {
    return { readSaved, sendingInputIds, publishSavedInputs, submitSavedInput, recordInput, dispatchInput, confirmAndProject };
  }
  const localInputDelivery = createLocalInputDelivery({ inputSends, current, platform, snapshotText, storage: () => localStorage, savedInputScope, executePlatformOperation, setBoot, refreshAfterMutation, call: applicationCall });
  const inputSends = useRef(new Map<string, Promise<Receipt>>()), current = useRef<Boot | null>(null), platform = useRef<PlatformClient | null>(null), snapshotText = useRef("");
  function readSaved(identity: Identity) { return readSavedInputs(localStorage, savedInputScope(identity)); }
  function confirmAndProject(workspace: Workspace, source: Pick<PlatformClient, "boot">) { return savedProjection; }
  function recordInput(identity: Boot, operation: RecordInput, dispatch: boolean, externalCommandId?: string, onInputStaged?: (inputId: string) => void): Receipt | Promise<Receipt> {}
  function execute() { if (operation.type === "record-input") return localInputDelivery.recordInput(identity, operation, dispatch, externalCommandId, onInputStaged); }
  function refresh() {
    const instances = await source.appViews(signal);
    const savedInputs = localInputDelivery.readSaved(source.boot);
    if (!navigationReadStillCurrent(navigation, finalNavigation)) throw new RequestError(409, "目录在读取期间已更新，请重试。", "navigation_changed");
    const savedProjection = localInputDelivery.confirmAndProject(workspace, source);
  }
  import { withoutSavedInputs, inputSubmissionSchema } from "./local-saved-inputs.js";
  import { contentOrganizationChangesSchema, stateSchema, taskContentSchema, type Operation, type Receipt, type Workspace } from "../../../packages/core/src/model.js";
  `,
}).get("Expected")!;
function same(actual: Node, original: Node, rule: string) {
  assert.deepEqual(readerShape(actual), readerShape(original), rule);
}
function normalized(text: string) {
  return parseReaderSources({
    Value: text.replaceAll("storage()", "localStorage"),
  }).get("Value")!;
}
export function verifiedDeliveryOriginals() {
  const fixed = parseReaderSources({ Fixed: fixedText }).get("Fixed")!;
  for (const name of [...originalNames, "execute"] as const)
    assert.equal(
      hash(readerFunction(fixed, name).getText()),
      deliverySourceHashes[name],
      "fixed actual Git32c complete " + name,
    );
  assert.equal(
    hash(legacyRecordBlock),
    deliverySourceHashes.record,
    "fixed actual Git32c record span",
  );
  assert.equal(
    hash(legacyConfirmationBlock),
    deliverySourceHashes.confirm,
    "fixed actual Git32c confirmation span",
  );
  return fixed;
}
export function verifyLocalInputDeliveryOwner(
  ownerText = localDeliveryOwnerText,
) {
  const owner = parseReaderSources({ Owner: ownerText }).get("Owner")!,
    fixed = verifiedDeliveryOriginals(),
    factory = readerFunction(owner, "createLocalInputDelivery");
  assert.deepEqual(
    factory.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "synchronous inert delivery factory",
  );
  assert.equal(factory.typeParameters?.length ?? 0, 0);
  assert.equal(factory.type, undefined);
  assert.deepEqual(
    factory.parameters.map(readerShape),
    readerFunction(expected, "createLocalInputDelivery").parameters.map(
      readerShape,
    ),
    "original borrowed delivery ports",
  );
  const functions = factory.body!.statements.filter(isFunctionDeclaration);
  assert.deepEqual(
    functions.map((node) => node.name?.text),
    allNames,
    "complete finite delivery family",
  );
  assert.equal(
    factory.body!.statements.length,
    allNames.length + 1,
    "no construction read, mirror, state or effect",
  );
  same(
    factory.body!.statements.at(-1)!,
    readerFunction(expected, "createLocalInputDelivery").body!.statements[0]!,
    "direct delivery return without wrappers",
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
      "return each actual delivery algorithm",
    );
  }
  const runtime: string[][] = [];
  for (const statement of owner.source.statements) {
    assert.ok(
      isImportDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        statement === factory,
      "finite inert delivery module",
    );
    if (
      !isImportDeclaration(statement) ||
      statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword
    )
      continue;
    assert.ok(isStringLiteral(statement.moduleSpecifier));
    const named = statement.importClause?.namedBindings;
    assert.ok(named && isNamedImports(named) && !statement.importClause?.name);
    runtime.push([
      statement.moduleSpecifier.text,
      ...named.elements
        .filter((node) => !node.isTypeOnly)
        .map((node) => node.getText()),
    ]);
  }
  assert.deepEqual(
    runtime,
    [
      ["../../../../packages/core/src/model.js", "operationSchema"],
      [
        "../local-saved-inputs.js",
        "readSavedInputs",
        "removeSavedInput",
        "saveInputLocally",
        "withSavedInputs",
        "withoutSavedInputs",
        "newInputOperation",
        "matchSavedInputOperation",
        "savedInputOperation",
      ],
    ],
    "only existing input schema and pure storage algorithms",
  );
  const restored = normalized(ownerText);
  for (const name of originalNames)
    same(
      readerFunction(restored, name),
      readerFunction(fixed, name),
      "complete original delivery algorithm " + name,
    );
  same(
    readerFunction(restored, "readSaved"),
    readerFunction(expected, "readSaved"),
    "original lazy saved-input read",
  );
  const confirm = readerFunction(restored, "confirmAndProject"),
    originalConfirm = readerFunction(expected, "confirmAndProject");
  assert.equal(
    confirm.modifiers,
    undefined,
    "confirmation remains synchronous",
  );
  assert.equal(confirm.typeParameters, undefined);
  assert.equal(confirm.type, undefined);
  assert.deepEqual(
    confirm.parameters.map(readerShape),
    originalConfirm.parameters.map(readerShape),
    "exact captured confirmation parameters",
  );
  same(
    confirm.body!.statements.at(-1)!,
    originalConfirm.body!.statements[0]!,
    "direct original confirmation projection",
  );
  const confirmation = confirm.body!.statements.slice(0, -1);
  assert.deepEqual(
    confirmation.map(readerShape),
    parseReaderSources({ Block: legacyConfirmationBlock })
      .get("Block")!
      .source.statements.map(readerShape),
    "complete publication-time confirmation block",
  );
  const record = readerFunction(restored, "recordInput"),
    signature = readerFunction(expected, "recordInput");
  assert.equal(
    record.modifiers,
    undefined,
    "record preparation remains synchronous",
  );
  assert.equal(record.typeParameters, undefined);
  assert.deepEqual(
    [record.parameters.map(readerShape), readerShape(record.type!)],
    [signature.parameters.map(readerShape), readerShape(signature.type!)],
    "exact captured record parameters",
  );
  const originalRecord = parseReaderSources({ Block: legacyRecordBlock }).get(
    "Block",
  )!.source.statements;
  assert.ok(
    originalRecord.length === 2 &&
      isIfStatement(originalRecord[1]!) &&
      isBlock(originalRecord[1]!.thenStatement),
  );
  assert.deepEqual(
    record.body!.statements.map(readerShape),
    [originalRecord[0]!, ...originalRecord[1]!.thenStatement.statements].map(
      readerShape,
    ),
    "complete synchronous original record branch",
  );
  return { owner, fixed };
}

// Validate actual ownership before restoring only this batch. The whole Client
// SHA is asserted separately by the new gate, so existing gates keep diagnosing
// their own legal counterexamples under their original named rules.
export function expandLocalInputDeliveryConsumption(
  clientText: string,
  ownerText = localDeliveryOwnerText,
) {
  clientText = inverseScriptCatalogPublicationFix(clientText);
  const { fixed } = verifyLocalInputDeliveryOwner(ownerText),
    client = parseReaderSources({ Client: clientText }).get("Client")!,
    workspace = readerFunction(client, "useWorkspace"),
    imported = readerImport(
      client,
      "./data/local-input-delivery.js",
      "createLocalInputDelivery",
    ),
    binding = readerVariable(client, "localInputDelivery");
  const imports = client.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "./data/local-input-delivery.js",
    );
  assert.equal(imports.length, 1, "one actual delivery import");
  const declaration = imports[0]!,
    named = declaration.importClause?.namedBindings;
  assert.ok(
    named &&
      isNamedImports(named) &&
      named.elements.length === 1 &&
      !named.elements[0]!.isTypeOnly &&
      declaration.importClause?.phaseModifier !== SyntaxKind.TypeKeyword,
    "runtime delivery factory import",
  );
  const calls = client.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        client.symbols.get(node.expression) === imported.symbol,
    );
  assert.equal(calls.length, 1, "one actual delivery construction");
  assert.equal(
    binding.initializer,
    calls[0],
    "direct delivery constructor, no memo or bridge",
  );
  const statement = binding.parent.parent;
  assert.ok(
    isVariableStatement(statement) &&
      statement.parent === workspace.body &&
      statement.declarationList.flags & NodeFlags.Const,
    "unconditional render-local delivery construction",
  );
  const siblings = workspace.body!.statements,
    index = siblings.indexOf(statement);
  assert.ok(
    index > 0 &&
      siblings[index - 1] ===
        readerVariable(client, "taskInteractions").parent.parent &&
      siblings[index + 1] ===
        readerFunction(client, "clearProtectedProjection"),
    "original delivery registration location",
  );
  assert.equal(calls[0]!.arguments.length, 1);
  same(
    calls[0]!.arguments[0]!,
    (
      readerVariable(expected, "localInputDelivery")
        .initializer as import("typescript/unstable/ast").CallExpression
    ).arguments[0]!,
    "exact lazy storage and original delivery captures",
  );
  const ports = calls[0]!.arguments[0]!;
  assert.ok(isObjectLiteralExpression(ports));
  for (const name of [
    "inputSends",
    "current",
    "platform",
    "snapshotText",
  ] as const) {
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
    same(ref, readerVariable(expected, name), "original Client ref " + name);
    assert.equal(
      client.symbols.get(property.name),
      client.symbols.get(ref.name),
      "borrow actual Client ref " + name,
    );
    assert.equal(
      client.symbols.get(ref.initializer.expression),
      readerImport(client, "react", "useRef").symbol,
      "original React ref registration",
    );
    assert.ok(ref.end < binding.pos);
  }
  const deliveryUses = client.nodes
    .filter(isPropertyAccessExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        client.symbols.get(node.expression) ===
          client.symbols.get(binding.name),
    );
  assert.deepEqual(
    deliveryUses.map((node) => node.name.text).sort(),
    ["confirmAndProject", "dispatchInput", "readSaved", "recordInput"],
    "only four actual Client delivery consumers",
  );
  const execute = readerFunction(client, "execute"),
    recordBranch = execute.body!.statements[2]!;
  same(
    recordBranch,
    readerFunction(expected, "execute").body!.statements[0]!,
    "synchronous captured Client record branch",
  );
  assert.equal(
    client.nodes
      .filter(isFunctionDeclaration)
      .filter((node) =>
        originalNames.includes(
          node.name?.text as (typeof originalNames)[number],
        ),
      ).length,
    0,
    "no duplicate Client delivery algorithm",
  );
  const returned = workspace.body!.statements.filter(isReturnStatement);
  assert.equal(returned.length, 1);
  assert.ok(
    returned[0]!.expression &&
      isObjectLiteralExpression(returned[0]!.expression),
  );
  const dispatch = returned[0]!.expression.properties.filter(
    (node) =>
      isPropertyAssignment(node) &&
      isIdentifier(node.name) &&
      node.name.text === "dispatchInput",
  );
  assert.equal(dispatch.length, 1);
  assert.ok(
    isPropertyAssignment(dispatch[0]!) &&
      isPropertyAccessExpression(dispatch[0]!.initializer) &&
      isIdentifier(dispatch[0]!.initializer.expression),
  );
  assert.equal(dispatch[0]!.initializer.name.text, "dispatchInput");
  assert.equal(
    client.symbols.get(dispatch[0]!.initializer.expression),
    client.symbols.get(binding.name),
    "direct actual dispatch alias",
  );
  const early = readerVariable(client, "savedInputs").parent.parent,
    late = readerVariable(client, "savedProjection").parent.parent;
  same(
    early,
    readerVariable(expected, "savedInputs").parent.parent,
    "original early refresh read seam",
  );
  same(
    late,
    readerVariable(expected, "savedProjection").parent.parent,
    "original publication-time refresh seam",
  );
  assert.ok(isBlock(early.parent) && early.parent === late.parent);
  const refreshStatements = early.parent.statements;
  same(
    refreshStatements[
      refreshStatements.indexOf(
        early as import("typescript/unstable/ast").Statement,
      ) - 1
    ]!,
    readerVariable(expected, "instances").parent.parent,
    "early read after original appViews await",
  );
  same(
    refreshStatements[
      refreshStatements.indexOf(
        late as import("typescript/unstable/ast").Statement,
      ) - 1
    ]!,
    readerFunction(expected, "refresh").body!.statements[2]!,
    "confirmation after original final navigation check",
  );
  const edits: { start: number; end: number; value: string }[] = [
    { start: declaration.getStart(), end: declaration.end + 1, value: "" },
    {
      start: statement.getStart(),
      end: statement.end,
      value:
        readerFunction(fixed, "sendingInputIds").getText() +
        "\n  " +
        readerFunction(fixed, "publishSavedInputs").getText(),
    },
    {
      start: execute.getStart(),
      end: execute.getStart(),
      value: readerFunction(fixed, "submitSavedInput").getText() + "\n  ",
    },
    {
      start: recordBranch.getStart(),
      end: recordBranch.end,
      value: legacyRecordBlock,
    },
    {
      start: early.getStart(),
      end: early.end,
      value:
        "const savedInputs = readSavedInputs(\n          localStorage,\n          savedInputScope(source.boot),\n        );",
    },
    { start: late.getStart(), end: late.end, value: legacyConfirmationBlock },
    {
      start: dispatch[0]!.getStart(),
      end: dispatch[0]!.end,
      value: "dispatchInput",
    },
  ];
  assert.equal(
    clientText[declaration.end],
    "\n",
    "finite complete import line removal",
  );
  const reading = readerFunction(client, "importReading");
  edits.push({
    start: reading.getStart(),
    end: reading.getStart(),
    value: readerFunction(fixed, "dispatchInput").getText() + "\n  ",
  });
  const restoredImports = [
    [
      "./local-saved-inputs.js",
      'import {\n  readSavedInputs,\n  removeSavedInput,\n  saveInputLocally,\n  withSavedInputs,\n  withoutSavedInputs,\n  inputSubmissionSchema,\n  newInputOperation,\n  matchSavedInputOperation,\n  savedInputOperation,\n  type LocalSavedInput,\n} from "./local-saved-inputs.js";',
    ],
    [
      "../../../packages/core/src/model.js",
      'import {\n  contentOrganizationChangesSchema,\n  operationSchema,\n  stateSchema,\n  taskContentSchema,\n  type Operation,\n  type Receipt,\n  type Workspace,\n} from "../../../packages/core/src/model.js";',
    ],
  ];
  for (const [path, value] of restoredImports) {
    const actual = client.source.statements
        .filter(isImportDeclaration)
        .filter(
          (node) =>
            isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === path,
        ),
      original = expected.source.statements
        .filter(isImportDeclaration)
        .find(
          (node) =>
            isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === path,
        )!;
    assert.equal(actual.length, 1);
    same(actual[0]!, original, "only removed unused delivery imports " + path);
    edits.push({
      start: actual[0]!.getStart(),
      end: actual[0]!.end,
      value: value!,
    });
  }
  let result = clientText;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}
