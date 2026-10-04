import assert, { AssertionError } from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SyntaxKind,
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
  isVariableStatement,
  type Node,
} from "typescript/unstable/ast";
import {
  fixedReaderHashes,
  parseReaderSources,
  readerFunction,
  readerFunctionHashes,
  readerImport,
  readerMethods,
  readerShape,
  readerVariable,
} from "./fixtures/reader-reads-contract.js";

// Finite ownership for four Reader algorithms and the actual Client seam.
// Not a whole-program purity, query facade, React lifecycle or UI proof.
const sources = {
  Client: readFileSync("apps/web/src/client.ts", "utf8"),
  Owner: readFileSync("apps/web/src/data/reader-reads.ts", "utf8"),
  Fixed: readFileSync("tests/fixtures/reader-reads-39cf13cf.ts", "utf8"),
};
const expected = parseReaderSources({
  Expected: `
  const current = useRef<Boot | null>(null), protectedReadGeneration = useRef(0);
  const ports = {current, protectedReadGeneration, call: applicationCall};
  export type ReaderReadIdentity = { csrfToken: string; principalId: string };
  export type ReaderReadPorts = {
    current: { readonly current: ReaderReadIdentity | null };
    protectedReadGeneration: { readonly current: number };
    call: typeof applicationCall;
  };
  function factory(options: ReaderReadPorts) {
    const { current, protectedReadGeneration, call: applicationCall } = options;
    return { readReading, readingContents, readingState, readingMarks };
  }
  function clear() { protectedReadGeneration.current++; current.current = null; platform.current = null; }
  function authClear() { protectedReadGeneration.current++; scriptEditorReads.clear(); current.current = null; }
`,
}).get("Expected")!;
function same(a: Node | undefined, b: Node | undefined) {
  assert.ok(a && b, "both contract nodes exist");
  assert.deepEqual(readerShape(a), readerShape(b));
}
function properties(node: Node | undefined) {
  assert.ok(node && isObjectLiteralExpression(node), "literal finite ports");
  const pairs = node.properties.map((property) => {
    assert.ok(
      isPropertyAssignment(property) || isShorthandPropertyAssignment(property),
    );
    assert.ok(isIdentifier(property.name));
    return [property.name.text, property] as const;
  });
  const result = new Map(pairs);
  assert.equal(result.size, node.properties.length, "no duplicate ports");
  return result;
}
function violations(input = sources) {
  const parsed = parseReaderSources(input),
    client = parsed.get("Client")!,
    owner = parsed.get("Owner")!,
    fixed = parsed.get("Fixed")!;
  const failures: string[] = [];
  function rule(name: string, check: () => void) {
    try {
      check();
    } catch (error) {
      if (!(error instanceof AssertionError)) throw error;
      failures.push(name);
    }
  }
  rule("actual-owner-and-borrowed-ports", () => {
    const imported = readerImport(
      client,
      "./data/reader-reads.js",
      "createReaderReads",
    );
    const declaration = client.source.statements
      .filter(isImportDeclaration)
      .find(
        (node) =>
          isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "./data/reader-reads.js",
      )!;
    assert.notEqual(
      declaration.importClause?.phaseModifier,
      SyntaxKind.TypeKeyword,
      "runtime factory import",
    );
    const importedBindings = declaration.importClause?.namedBindings;
    assert.ok(importedBindings && isNamedImports(importedBindings));
    assert.equal(
      importedBindings.elements.find((node) => node.name === imported.local)
        ?.isTypeOnly,
      false,
    );
    const calls = client.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          client.symbols.get(node.expression) === imported.symbol,
      );
    assert.equal(calls.length, 1, "single actual owner construction");
    const binding = readerVariable(client, "readerReads");
    assert.equal(binding.initializer, calls[0]);
    assert.ok(isVariableStatement(binding.parent.parent));
    assert.equal(
      binding.parent.parent.parent,
      readerFunction(client, "useWorkspace").body,
      "factory belongs to actual Client",
    );
    assert.equal(calls[0]!.arguments.length, 1);
    const ports = properties(calls[0]!.arguments[0]),
      original = properties(readerVariable(expected, "ports").initializer);
    assert.deepEqual([...ports.keys()], [...original.keys()]);
    for (const name of ["current", "protectedReadGeneration"] as const) {
      same(ports.get(name), original.get(name));
      const property = ports.get(name)!;
      assert.ok(isShorthandPropertyAssignment(property));
      const ref = readerVariable(client, name);
      assert.notEqual(client.symbols.get(ref.name), undefined);
      assert.equal(
        client.symbols.get(property.name),
        client.symbols.get(ref.name),
        "borrow original ref, not a mirror",
      );
      assert.ok(ref.pos < binding.pos);
    }
    const call = ports.get("call");
    assert.ok(
      call && isPropertyAssignment(call) && isIdentifier(call.initializer),
    );
    assert.equal(
      client.symbols.get(call.initializer),
      readerImport(client, "./application-transport.js", "applicationCall")
        .symbol,
      "original shared HTTP/IPC transport",
    );
    same(call, original.get("call"));
  });
  rule("direct-public-consumption", () => {
    const binding = readerVariable(client, "readerReads");
    const returns = readerFunction(
      client,
      "useWorkspace",
    ).body!.statements.filter(isReturnStatement);
    assert.equal(returns.length, 1);
    const exports = properties(returns[0]!.expression);
    for (const method of readerMethods) {
      const property = exports.get(method);
      assert.ok(property && isPropertyAssignment(property));
      assert.ok(
        isPropertyAccessExpression(property.initializer) &&
          isIdentifier(property.initializer.expression),
      );
      assert.equal(
        property.initializer.name.text,
        method,
        "correct method, not neighboring query",
      );
      assert.equal(
        client.symbols.get(property.initializer.expression),
        client.symbols.get(binding.name),
        "actual owner reference without async wrapper",
      );
      assert.equal(
        client.nodes
          .filter(isFunctionDeclaration)
          .filter((node) => node.name?.text === method).length,
        0,
        "no duplicate Client algorithm",
      );
    }
    assert.equal(
      client.nodes
        .filter(isStringLiteral)
        .filter((node) =>
          [
            "reader.read",
            "reader.contents",
            "reader.state",
            "reader.marks",
          ].includes(node.text),
        ).length,
      0,
      "no parallel raw Reader query route",
    );
  });
  rule("client-authority-and-clear-order", () => {
    const ref = readerImport(client, "react", "useRef");
    for (const name of ["current", "protectedReadGeneration"] as const) {
      const node = readerVariable(client, name);
      same(node, readerVariable(expected, name));
      assert.ok(node.initializer && isCallExpression(node.initializer));
      assert.equal(
        client.symbols.get(node.initializer.expression),
        ref.symbol,
        "actual React ref initializer",
      );
    }
    assert.deepEqual(
      readerFunction(client, "clearProtectedProjection")
        .body!.statements.slice(0, 3)
        .map(readerShape),
      readerFunction(expected, "clear").body!.statements.map(readerShape),
    );
    const auth = readerFunction(expected, "authClear").body!.statements.map(
      readerShape,
    );
    for (const name of ["login", "logout"]) {
      const statements = readerFunction(client, name).body!.statements;
      const start = statements.findIndex(
        (node) => JSON.stringify(readerShape(node)) === JSON.stringify(auth[0]),
      );
      assert.ok(start >= 0);
      assert.deepEqual(
        statements.slice(start, start + 3).map(readerShape),
        auth,
      );
    }
  });
  rule("inert-owner-and-dependencies", () => {
    const allowed = new Map([
      ["zod", []],
      ["../application-transport.js", []],
      [
        "../../../../packages/core/src/reader.js",
        ["readingMarkSchema", "readingStateSchema", "readerMarksReadSchema"],
      ],
    ]);
    const runtime: string[] = [];
    for (const statement of owner.source.statements) {
      if (isImportDeclaration(statement)) {
        assert.ok(
          isStringLiteral(statement.moduleSpecifier) &&
            allowed.has(statement.moduleSpecifier.text),
          "only finite core schemas and type dependencies",
        );
        const clause = statement.importClause;
        assert.ok(
          clause &&
            !clause.name &&
            clause.namedBindings &&
            isNamedImports(clause.namedBindings),
          "no side-effect imports",
        );
        if (clause.phaseModifier === SyntaxKind.TypeKeyword) continue;
        for (const binding of clause.namedBindings.elements) {
          if (binding.isTypeOnly) continue;
          assert.ok(
            allowed
              .get(statement.moduleSpecifier.text)!
              .includes(binding.name.text),
          );
          assert.equal(
            (binding.propertyName ?? binding.name).text,
            binding.name.text,
          );
          runtime.push(binding.name.text);
        }
      } else
        assert.ok(
          isFunctionDeclaration(statement) || isTypeAliasDeclaration(statement),
          "no top-level state or I/O",
        );
    }
    assert.deepEqual(runtime, [
      "readingMarkSchema",
      "readingStateSchema",
      "readerMarksReadSchema",
    ]);
    for (const name of runtime) {
      const imported = readerImport(
        owner,
        "../../../../packages/core/src/reader.js",
        name,
      );
      const uses = owner.nodes
        .filter(isIdentifier)
        .filter((node) => node.text === name);
      assert.ok(uses.length > 1);
      for (const use of uses)
        assert.equal(
          owner.symbols.get(use),
          imported.symbol,
          "schema uses actual core import",
        );
    }
    const factory = readerFunction(owner, "createReaderReads");
    assert.deepEqual(
      factory.modifiers?.map((node) => node.kind),
      [SyntaxKind.ExportKeyword],
      "synchronous exported factory",
    );
    assert.equal(factory.typeParameters?.length ?? 0, 0);
    assert.equal(factory.parameters.length, 1);
    same(
      factory.parameters[0],
      readerFunction(expected, "factory").parameters[0],
    );
    assert.equal(factory.type, undefined, "no new construction protocol");
    assert.equal(
      owner.source.statements.filter(isFunctionDeclaration).length,
      1,
    );
    const types = owner.source.statements.filter(isTypeAliasDeclaration);
    assert.equal(types.length, 2);
    types.forEach((type, index) =>
      same(
        type,
        expected.source.statements.filter(isTypeAliasDeclaration)[index],
      ),
    );
    const statements = factory.body!.statements;
    assert.equal(
      statements.length,
      6,
      "borrow, four complete algorithms, direct return only",
    );
    same(
      statements[0],
      readerFunction(expected, "factory").body!.statements[0],
    );
    for (const [index, name] of readerMethods.entries())
      assert.equal(statements[index + 1], readerFunction(owner, name));
    const returned = statements.at(-1);
    assert.ok(returned && isReturnStatement(returned));
    same(returned, readerFunction(expected, "factory").body!.statements.at(-1));
    const exports = properties(returned.expression);
    for (const name of readerMethods) {
      const declaration = readerFunction(owner, name);
      const property = exports.get(name);
      assert.ok(property && isShorthandPropertyAssignment(property));
      assert.notEqual(owner.symbols.get(declaration.name!), undefined);
      assert.equal(
        owner.symbols.get(declaration.name!),
        owner.symbols.get(property.name),
        "return each actual algorithm directly",
      );
    }
  });
  rule("four-fixed-algorithms", () => {
    assert.deepEqual(readerFunctionHashes(fixed), fixedReaderHashes);
    assert.deepEqual(readerFunctionHashes(owner), fixedReaderHashes);
  });
  return failures;
}
test("actual Client borrows original refs/transport and directly exposes one inert Reader family", () => {
  assert.deepEqual(violations(), []);
});
type Counterfactual = [keyof typeof sources, string, string, string];
const negatives: Counterfactual[] = [
  [
    "Client",
    "./data/reader-reads.js",
    "./data/not-reader-reads.js",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "import { createReaderReads }",
    "import { type createReaderReads }",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const readerReads = createReaderReads({",
    "const createReaderReads = (ports: unknown) => ports; const readerReads = createReaderReads({",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const readerReads = createReaderReads({",
    "const readerReads = fakeReaderReads({",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const readerReads = createReaderReads({",
    "const duplicate = createReaderReads({}); const readerReads = createReaderReads({",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const readerReads = createReaderReads({\n    current,",
    "const readerReads = createReaderReads({\n    current: {current: current.current},",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const readerReads = createReaderReads({\n    current,\n    protectedReadGeneration,",
    "const readerReads = createReaderReads({\n    current,\n    protectedReadGeneration: {current: 0},",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const readerReads = createReaderReads({\n    current,\n    protectedReadGeneration,\n    call: applicationCall,",
    "const readerReads = createReaderReads({\n    current,\n    protectedReadGeneration,\n    call: (...args) => applicationCall(...args),",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "readReading: readerReads.readReading",
    "readReading: async (...args) => readerReads.readReading(...args)",
    "direct-public-consumption",
  ],
  [
    "Client",
    "readingState: readerReads.readingState",
    "readingState: readerReads.readingContents",
    "direct-public-consumption",
  ],
  [
    "Client",
    "readingMarks: readerReads.readingMarks",
    "readingMarks: ({readingMarks: () => null}).readingMarks",
    "direct-public-consumption",
  ],
  [
    "Client",
    "current = useRef<Boot | null>(null)",
    "current = useRef<Boot | null>(fakeBoot)",
    "client-authority-and-clear-order",
  ],
  [
    "Client",
    "protectedReadGeneration = useRef(0)",
    "protectedReadGeneration = useRef(1)",
    "client-authority-and-clear-order",
  ],
  [
    "Client",
    "protectedReadGeneration.current++;\n    current.current = null;",
    "current.current = null;\n    protectedReadGeneration.current++;",
    "client-authority-and-clear-order",
  ],
  [
    "Owner",
    "  async function readReading(",
    "  const mirror = new Map();\n  async function readReading(",
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "  async function readReading(",
    "  void applicationCall('reader.state', {});\n  async function readReading(",
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "import type { z }",
    "import { z }",
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "import type { applicationCall }",
    "import { applicationCall }",
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "  readingMarkSchema,",
    "  readingMarkSchema as wrongSchema,",
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "import type { z }",
    'import "react";\nimport type { z }',
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "raw.marks.length > 50",
    "raw.marks.length > 51",
    "four-fixed-algorithms",
  ],
  [
    "Owner",
    "signal?.aborted ||",
    "!signal?.aborted ||",
    "four-fixed-algorithms",
  ],
  [
    "Owner",
    "ownerPrincipalId: identity.principalId",
    "ownerPrincipalId: current.current!.principalId",
    "four-fixed-algorithms",
  ],
  [
    "Owner",
    "const query = readerMarksReadSchema.parse(request);",
    "const query = request;",
    "four-fixed-algorithms",
  ],
  [
    "Fixed",
    "raw.marks.length > 50",
    "raw.marks.length > 51",
    "four-fixed-algorithms",
  ],
  [
    "Owner",
    "export function createReaderReads",
    "export async function createReaderReads",
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "export function createReaderReads",
    "function createReaderReads",
    "inert-owner-and-dependencies",
  ],
  [
    "Owner",
    "options: ReaderReadPorts)",
    "options: ReaderReadPorts = readDefaultPorts())",
    "inert-owner-and-dependencies",
  ],
];
test("legal counterfactuals fail their named rule rather than a parse error or absent mutation target", () => {
  for (const [file, from, to, rule] of negatives) {
    assert.ok(
      sources[file].includes(from),
      "existing mutation target: " + from,
    );
    const input = { ...sources, [file]: sources[file].replace(from, to) };
    parseReaderSources(input);
    assert.ok(
      violations(input).includes(rule),
      file + " must fail " + rule + ": " + from,
    );
  }
});
