import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { expandLocalInputDeliveryConsumption } from "./fixtures/local-input-delivery-consumption.js";
import {
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  isVariableStatement,
  SyntaxKind,
} from "typescript/unstable/ast";
import {
  parseReaderSources,
  readerFunction,
  readerImport,
  readerShape,
  readerVariable,
} from "./fixtures/reader-reads-contract.js";

const names = ["verifyArtifact", "taskRuntime", "taskResponses"] as const;
const hashes = {
  verifyArtifact:
    "29c134150e014130840dcac2d7decff2a3409f725cc1afdb386c85016c0438fb",
  taskRuntime:
    "037120e5bb3761530dec38c542a2000cc544b6414c5faba470d7bc333d8a6986",
  taskResponses:
    "c042f12bead71382c94b32b779421c01530e4f8eb57b202b960e38b25cbc4e54",
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sources = {
  Client: readFileSync("apps/web/src/client.ts", "utf8"),
  Owner: readFileSync("apps/web/src/data/task-interactions.ts", "utf8"),
  Fixed: readFileSync("tests/fixtures/task-interactions-9122ad28.ts", "utf8"),
};
const registration = `  const taskInteractions = createTaskInteractions({
    current,
    platform,
    taskRuntimeReads,
    taskRuntimeReadGeneration,
    call: applicationCall,
    publishBoot: setBoot,
  });\n`;
function replaceOnce(source: string, before: string, after: string) {
  assert.equal(source.split(before).length - 1, 1, "one finite source target");
  return source.replace(before, after);
}
function validate(input = sources) {
  input = {
    ...input,
    Client: expandLocalInputDeliveryConsumption(input.Client),
  };
  const parsed = parseReaderSources(input),
    client = parsed.get("Client")!,
    owner = parsed.get("Owner")!,
    fixed = parsed.get("Fixed")!;
  for (const name of names) {
    assert.equal(
      sha(readerFunction(fixed, name).getText()),
      hashes[name],
      "fixed actual Git algorithm " + name,
    );
    assert.equal(
      readerFunction(owner, name).getText(),
      readerFunction(fixed, name).getText(),
      "complete original algorithm " + name,
    );
  }
  const factory = readerFunction(owner, "createTaskInteractions"),
    oldFactory = readerFunction(fixed, "createFixedTaskInteractions");
  assert.deepEqual(
    factory.parameters.map(readerShape),
    oldFactory.parameters.map(readerShape),
    "borrow refs and original ports only",
  );
  assert.equal(
    factory.body!.statements.length,
    4,
    "only three commands and direct return, no construction work",
  );
  assert.equal(
    factory.body!.statements.at(-1)!.getText(),
    "return { verifyArtifact, taskRuntime, taskResponses };",
    "direct public aliases, no async wrapper",
  );
  const runtimeImports = owner.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) => node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword,
    );
  assert.deepEqual(
    runtimeImports.map((node) => node.getText()),
    [
      'import { taskRuntimeSchema } from "../../../../packages/core/src/task-runtime.js";',
      'import { taskRuntimeResponseStillCurrent } from "../task-runtime-projection.js";',
    ],
    "only existing schema and pure projection dependencies",
  );
  assert.equal(
    owner.source.statements.length,
    7,
    "no top-level I/O, state, subscription or effect",
  );
  const imported = readerImport(
    client,
    "./data/task-interactions.js",
    "createTaskInteractions",
  );
  const importNode = client.source.statements
    .filter(isImportDeclaration)
    .find(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "./data/task-interactions.js",
    )!;
  assert.notEqual(
    importNode.importClause?.phaseModifier,
    SyntaxKind.TypeKeyword,
    "actual runtime import",
  );
  const calls = client.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        client.symbols.get(node.expression) === imported.symbol,
    );
  assert.equal(calls.length, 1, "one actual owner call");
  const binding = readerVariable(client, "taskInteractions");
  assert.equal(binding.initializer, calls[0]);
  assert.ok(isVariableStatement(binding.parent.parent));
  const workspace = readerFunction(client, "useWorkspace");
  assert.equal(
    binding.parent.parent.parent,
    workspace.body,
    "unconditional actual Client registration",
  );
  const result =
    workspace.body!.statements.filter(isReturnStatement)[0]!.expression;
  assert.ok(result && isObjectLiteralExpression(result));
  for (const name of names) {
    const property: import("typescript/unstable/ast").Node | undefined =
      result.properties.find(
        (node) =>
          isPropertyAssignment(node) &&
          isIdentifier(node.name) &&
          node.name.text === name,
      );
    assert.ok(property && isPropertyAssignment(property));
    const value: import("typescript/unstable/ast").Expression =
      property.initializer;
    assert.ok(
      isPropertyAccessExpression(value) && isIdentifier(value.expression),
    );
    assert.equal(value.name.text, name, "exact corresponding method");
    assert.equal(
      client.symbols.get(value.expression),
      client.symbols.get(binding.name),
      "direct actual owner consumption",
    );
  }
  // Finite inverse of this batch only. All original hooks, authority/clear/refresh,
  // current-before-React publication and neighboring algorithms remain byte exact.
  let restored = replaceOnce(
    input.Client,
    'import { createTaskInteractions } from "./data/task-interactions.js";\n',
    "",
  );
  restored = replaceOnce(
    restored,
    'import { retainTaskRuntimeProjections } from "./task-runtime-projection.js";',
    'import {\n  retainTaskRuntimeProjections,\n  taskRuntimeResponseStillCurrent,\n} from "./task-runtime-projection.js";',
  );
  restored = replaceOnce(restored, registration, "");
  restored = replaceOnce(
    restored,
    "  async function cancelInput(",
    "  " +
      readerFunction(fixed, "verifyArtifact").getText() +
      "\n  async function cancelInput(",
  );
  restored = replaceOnce(
    restored,
    "  async function executionResult(",
    "  " +
      readerFunction(fixed, "taskRuntime").getText() +
      "\n  " +
      readerFunction(fixed, "taskResponses").getText() +
      "\n  async function executionResult(",
  );
  for (const name of names)
    restored = replaceOnce(
      restored,
      "    " + name + ": taskInteractions." + name + ",",
      "    " + name + ",",
    );
  assert.equal(
    sha(restored),
    "21c02ad3c622262f768fda0a0022e6acccf811d42a43f507cfa2c4f620d8e505",
    "complete actual Git 9122 Client inverse",
  );
}
test("complete fixed algorithms, inert constructor and actual Client consumption preserve the entire original Client", () =>
  validate());
test("legal parsed counterfactuals fail finite original algorithm, construction and actual consumption rules", () => {
  const variants = [
    {
      ...sources,
      Owner: replaceOnce(
        sources.Owner,
        "AbortSignal.timeout(8000)",
        "AbortSignal.timeout(12000)",
      ),
    },
    {
      ...sources,
      Owner: replaceOnce(
        sources.Owner,
        "      return view;",
        "      return undefined;",
      ),
    },
    {
      ...sources,
      Owner: replaceOnce(
        sources.Owner,
        "        current.current = updated;\n        setBoot(updated);",
        "        setBoot(updated);\n        current.current = updated;",
      ),
    },
    {
      ...sources,
      Owner: replaceOnce(
        sources.Owner,
        "    } finally {",
        "    } finally { taskRuntimeReads.current.clear();",
      ),
    },
    {
      ...sources,
      Owner: replaceOnce(
        sources.Owner,
        "  return { verifyArtifact, taskRuntime, taskResponses };",
        "  return { verifyArtifact, taskRuntime: async (...args: Parameters<typeof taskRuntime>) => taskRuntime(...args), taskResponses };",
      ),
    },
    {
      ...sources,
      Owner: replaceOnce(
        sources.Owner,
        "  async function verifyArtifact",
        "  current.current;\n  async function verifyArtifact",
      ),
    },
    {
      ...sources,
      Client: replaceOnce(
        sources.Client,
        "taskRuntime: taskInteractions.taskRuntime",
        "taskRuntime: async (...args: Parameters<typeof taskInteractions.taskRuntime>) => taskInteractions.taskRuntime(...args)",
      ),
    },
    {
      ...sources,
      Client: replaceOnce(
        sources.Client,
        "    publishBoot: setBoot,",
        "    publishBoot: () => {},",
      ),
    },
    {
      ...sources,
      Client: replaceOnce(
        sources.Client,
        "    taskRuntimeReads,\n    taskRuntimeReadGeneration,",
        "    taskRuntimeReads: { current: new Map() },\n    taskRuntimeReadGeneration,",
      ),
    },
  ];
  for (const variant of variants) {
    parseReaderSources(variant);
    assert.throws(() => validate(variant), assert.AssertionError);
  }
});
