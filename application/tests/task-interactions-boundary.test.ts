import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isCallExpression,
  isBindingElement,
  isArrayBindingPattern,
  isNamedImports,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
  isFunctionDeclaration,
  type Node,
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

import {
  originalTaskInteractionRefs,
  verifyClientProjectionLifetime,
} from "./fixtures/client-projection-lifetime-21cb34dc.js";

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
  const parsed = parseReaderSources(input),
    client = parsed.get("Client")!,
    owner = parsed.get("Owner")!,
    fixed = parsed.get("Fixed")!;
  const workspace = readerFunction(client, "useWorkspace");
  const scoped = {
    ...client,
    nodes: client.nodes.filter((node) => {
      for (let parent: Node | undefined = node; parent; parent = parent.parent)
        if (parent === workspace.body) return true;
      return false;
    }),
  };
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
  const calls = scoped.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        client.symbols.get(node.expression) === imported.symbol,
    );
  assert.equal(calls.length, 1, "one actual owner call");
  assert.ok(
    importNode.importClause?.namedBindings &&
      isNamedImports(importNode.importClause.namedBindings) &&
      !importNode.importClause.namedBindings.elements.find(
        (node) =>
          (node.propertyName?.text ?? node.name.text) ===
          "createTaskInteractions",
      )?.isTypeOnly,
    "actual runtime task factory value",
  );
  const binding = readerVariable(scoped, "taskInteractions");
  assert.equal(binding.initializer, calls[0]);
  assert.ok(isVariableStatement(binding.parent.parent));
  assert.equal(
    binding.parent.parent.parent,
    workspace.body,
    "unconditional actual Client registration",
  );
  const result =
    workspace.body!.statements.filter(isReturnStatement)[0]!.expression;
  assert.ok(result && isObjectLiteralExpression(result));
  for (const name of names) {
    const properties: Node[] = result.properties.filter(
      (node) =>
        isPropertyAssignment(node) &&
        isIdentifier(node.name) &&
        node.name.text === name,
    );
    assert.equal(properties.length, 1, "one public task member " + name);
    const property: Node | undefined = properties[0];
    assert.ok(property && isPropertyAssignment(property));
    const value: import("typescript/unstable/ast").Expression =
      property.initializer;
    assert.ok(
      isPropertyAccessExpression(value) && isIdentifier(value.expression),
      "direct actual owner consumption",
    );
    assert.equal(value.name.text, name, "exact corresponding method");
    assert.equal(
      client.symbols.get(value.expression),
      client.symbols.get(binding.name),
      "direct actual owner consumption",
    );
  }
  assert.equal(calls[0]!.arguments.length, 1, "one finite task port object");
  const expected = parseReaderSources({
    Expected:
      registration +
      "\n" +
      Object.values(originalTaskInteractionRefs)
        .map((raw) => "const " + raw + ";")
        .join("\n") +
      "\nconst [boot,setBoot] = useState<Boot|null>(null);",
  }).get("Expected")!;
  const ports = calls[0]!.arguments[0]!;
  assert.deepEqual(
    readerShape(ports),
    readerShape(
      (
        readerVariable(expected, "taskInteractions")
          .initializer as import("typescript/unstable/ast").CallExpression
      ).arguments[0]!,
    ),
    "exact six original task captures",
  );
  assert.ok(isObjectLiteralExpression(ports));
  for (const name of [
    "current",
    "platform",
    "taskRuntimeReads",
    "taskRuntimeReadGeneration",
  ] as const) {
    const ref = readerVariable(scoped, name);
    assert.deepEqual(
      readerShape(ref),
      readerShape(readerVariable(expected, name)),
      "original task Client ref " + name,
    );
    assert.ok(
      ref.initializer && isCallExpression(ref.initializer),
      "original task ref registration",
    );
    assert.equal(
      client.symbols.get(ref.initializer.expression),
      readerImport(client, "react", "useRef").symbol,
      "actual original task React useRef",
    );
    const property: Node | undefined = ports.properties.find(
      (node) =>
        isShorthandPropertyAssignment(node) &&
        isIdentifier(node.name) &&
        node.name.text === name,
    );
    assert.ok(property && isShorthandPropertyAssignment(property));
    assert.equal(
      client.symbols.get(property.name),
      client.symbols.get(ref.name),
      "borrow actual original task ref " + name,
    );
    assert.ok(ref.end < binding.pos, "task ref registered before constructor");
  }
  const call = ports.properties.find(
    (node) =>
      isPropertyAssignment(node) &&
      isIdentifier(node.name) &&
      node.name.text === "call",
  );
  assert.ok(
    call && isPropertyAssignment(call) && isIdentifier(call.initializer),
  );
  assert.equal(
    client.symbols.get(call.initializer),
    readerImport(client, "./application-transport.js", "applicationCall")
      .symbol,
    "actual task application transport capture",
  );
  const publisher = ports.properties.find(
    (node) =>
      isPropertyAssignment(node) &&
      isIdentifier(node.name) &&
      node.name.text === "publishBoot",
  );
  assert.ok(
    publisher &&
      isPropertyAssignment(publisher) &&
      isIdentifier(publisher.initializer),
  );
  const setters = scoped.nodes
    .filter(isBindingElement)
    .filter(
      (node) =>
        node.name &&
        isIdentifier(node.name) &&
        client.symbols.get(node.name) ===
          client.symbols.get(publisher.initializer),
    );
  assert.equal(setters.length, 1, "one actual task Boot React setter");
  const setter = setters[0]!,
    pattern = setter.parent;
  assert.ok(
    isArrayBindingPattern(pattern) &&
      pattern.elements[1] === setter &&
      isVariableDeclaration(pattern.parent) &&
      pattern.parent.initializer &&
      isCallExpression(pattern.parent.initializer),
    "original task Boot setter registration",
  );
  const bootRegistration = expected.nodes
    .filter(isVariableDeclaration)
    .find((node) => isArrayBindingPattern(node.name))!;
  assert.deepEqual(
    readerShape(pattern.parent.initializer),
    readerShape(bootRegistration.initializer!),
    "original task Boot state initializer",
  );
  assert.equal(
    client.symbols.get(pattern.parent.initializer.expression),
    readerImport(client, "react", "useState").symbol,
    "actual task Boot React setter",
  );
  assert.equal(
    scoped.nodes
      .filter(isFunctionDeclaration)
      .filter((node) =>
        names.includes(node.name?.text as (typeof names)[number]),
      ).length,
    0,
    "no duplicate actual Client task algorithms",
  );
  verifyClientProjectionLifetime(input.Client);
}
test("complete fixed task algorithms, inert constructor, real captures and direct Client consumers", () =>
  validate());
test("independent Client React features and types do not become task interaction contracts", () => {
  validate({
    ...sources,
    Client:
      sources.Client +
      `\nexport type FutureTaskView = { label: string };\nexport function useFutureTaskView() { const current = useRef(0); const [value] = useState(0); function clearProtectedProjection() { return current.current; } return value + clearProtectedProjection(); }\nexport const futureTaskLabel = "independent";\n`,
  });
  validate({
    ...sources,
    Client:
      sources.Client +
      `\nexport function futureTaskOwner(ports: Parameters<typeof createTaskInteractions>[0]) { return createTaskInteractions(ports); }\n`,
  });
  validate({
    ...sources,
    Client: replaceOnce(
      replaceOnce(
        sources.Client,
        "import { createTaskInteractions }",
        "import { createTaskInteractions as makeTask }",
      ),
      "const taskInteractions = createTaskInteractions(",
      "const taskInteractions = makeTask(",
    ),
  });
});
test("legal task factory and projection authority variants reject actual typed imports, captures and clear lifetime", () => {
  for (const [before, after, rule] of [
    [
      "    taskResponses: taskInteractions.taskResponses,",
      "    taskResponses: taskInteractions.taskResponses, taskResponses: taskInteractions.taskResponses,",
      "one public task member taskResponses",
    ],
    [
      "  function clearProtectedProjection(keepRead?: AbortController) {",
      "  async function taskResponses() { return undefined; }\n  function clearProtectedProjection(keepRead?: AbortController) {",
      "no duplicate actual Client task algorithms",
    ],
    [
      'import { createTaskInteractions } from "./data/task-interactions.js";',
      'import { type createTaskInteractions } from "./data/task-interactions.js";',
      "actual runtime task factory value",
    ],
    [
      'import { createTaskInteractions } from "./data/task-interactions.js";',
      'import type { createTaskInteractions } from "./data/task-interactions.js";',
      "actual runtime import",
    ],
    [
      "    taskRuntimeReadGeneration,\n    call: applicationCall,",
      "    taskRuntimeReadGeneration: { current: 0 },\n    call: applicationCall,",
      "exact six original task captures",
    ],
    [
      "const taskRuntimeReadGeneration = useRef(0);",
      "const taskRuntimeReadGeneration = useRef(1);",
      "original task Client ref taskRuntimeReadGeneration",
    ],
    [
      "function clearProtectedProjection(keepRead?: AbortController) {",
      "function clearProtectedProjection(keepRead?: AbortController) { taskRuntimeReads.current.clear();",
      "complete original protected projection clear and approval lifetime",
    ],
    [
      "function clearProtectedProjection(keepRead?: AbortController) {\n    protectedReadGeneration.current++;",
      "function clearProtectedProjection(keepRead?: AbortController) {\n    protectedReadGeneration.current += 0;",
      "complete original protected projection clear and approval lifetime",
    ],
  ]) {
    const variant = {
      ...sources,
      Client: replaceOnce(sources.Client, before!, after!),
    };
    parseReaderSources(variant);
    assert.throws(() => validate(variant), {
      name: "AssertionError",
      message: new RegExp(rule!),
    });
  }
});
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
  const rules = [
    "complete original algorithm verifyArtifact",
    "complete original algorithm taskRuntime",
    "complete original algorithm taskRuntime",
    "complete original algorithm taskRuntime",
    "direct public aliases, no async wrapper",
    "only three commands and direct return, no construction work",
    "direct actual owner consumption",
    "exact six original task captures",
    "exact six original task captures",
  ];
  for (const [index, variant] of variants.entries()) {
    parseReaderSources(variant);
    assert.throws(() => validate(variant), {
      name: "AssertionError",
      message: new RegExp(rules[index]!),
    });
  }
});
