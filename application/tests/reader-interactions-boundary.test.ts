import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript/unstable/ast";
import {
  parseReaderSources,
  type ParsedReaderSource,
} from "./fixtures/reader-reads-contract.js";
import { fixedReaderInteractions as fixed } from "./fixtures/reader-interactions-21cb34dc.js";

// These three complete algorithms and their actual seam are the boundary.
// No complete current Client hash, historical inverse chain or global IO ban.
const names = ["importReading", "readingOcr", "readerCommand"] as const;
const sources = {
  Client: readFileSync("apps/web/src/client.ts", "utf8"),
  Owner: readFileSync("apps/web/src/data/reader-interactions.ts", "utf8"),
};
const fixedSource = `import {runPendingFileImport} from "../pending-file-import.js";
import {draftKey,scopedStorage} from "../local-preferences.js";
import {RequestError} from "../application-transport.js";
function original(options){const {current,call:applicationCall,refreshAfterMutation}=options;
${fixed.functions.map((f) => f.raw).join("\n")}
return {importReading,readingOcr,readerCommand};}`;
type Context = ParsedReaderSource & {
  imports: Map<number, string>;
  aliases: Map<number, number>;
  labels: Map<number, string>;
};
function localFunction(statements: readonly ts.Statement[], name: string) {
  const found = statements
    .filter(ts.isFunctionDeclaration)
    .filter((fn) => fn.name?.text === name);
  assert.equal(found.length, 1, "actual-local-function:" + name);
  assert.ok(found[0]!.body);
  return found[0]!;
}
function context(p: ParsedReaderSource): Context {
  const imports = new Map<number, string>(),
    aliases = new Map<number, number>();
  for (const entry of p.source.statements.filter(ts.isImportDeclaration)) {
    const named = entry.importClause?.namedBindings;
    if (
      !named ||
      !ts.isNamedImports(named) ||
      entry.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    )
      continue;
    for (const binding of named.elements)
      if (!binding.isTypeOnly) {
        const id = p.symbols.get(binding.name);
        if (id !== undefined)
          imports.set(
            id,
            entry.moduleSpecifier.getText().slice(1, -1) +
              ":" +
              (binding.propertyName ?? binding.name).text,
          );
      }
  }
  for (const variable of p.nodes.filter(ts.isVariableDeclaration))
    if (
      ts.isIdentifier(variable.name) &&
      variable.initializer &&
      ts.isIdentifier(variable.initializer) &&
      variable.parent.flags & ts.NodeFlags.Const
    ) {
      const id = p.symbols.get(variable.name),
        source = p.symbols.get(variable.initializer);
      if (id !== undefined && source !== undefined) aliases.set(id, source);
    }
  return { ...p, imports, aliases, labels: new Map() };
}
function id(p: Context, node: ts.Node): number | undefined {
  let value = p.symbols.get(node);
  // Explicit ordinary const value aliases, not arbitrary TS value-flow.
  for (
    let depth = 0;
    depth < 2 && value !== undefined && p.aliases.has(value);
    depth++
  )
    value = p.aliases.get(value);
  return value;
}
function shape(node: ts.Node, p: Context): unknown {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isParenthesizedExpression(node)
  )
    return shape(node.expression, p);
  const children: unknown[] = [];
  node.forEachChild((child) => {
    if (
      ("type" in node && child === node.type) ||
      child.kind === ts.SyntaxKind.TypeParameter ||
      (child.kind >= ts.SyntaxKind.FirstTypeNode &&
        child.kind <= ts.SyntaxKind.LastTypeNode) ||
      ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        node.typeArguments?.some((t) => t === child))
    )
      return;
    children.push(shape(child, p));
  });
  const key = id(p, node);
  return [
    node.kind,
    node.flags &
      (ts.NodeFlags.Const | ts.NodeFlags.Let | ts.NodeFlags.OptionalChain),
    ...(ts.isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length
      ? children
      : key !== undefined
        ? (p.labels.get(key) ?? p.imports.get(key) ?? node.getText())
        : ts.isStringLiteral(node)
          ? node.text
          : node.getText(),
  ];
}
function unwrap(node: ts.Node): ts.Node {
  return ts.isAsExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertion(node)
    ? unwrap(node.expression)
    : node;
}
function fields(node: ts.Node, rule: string) {
  node = unwrap(node);
  assert.ok(ts.isObjectLiteralExpression(node), rule);
  return node.properties.map((property) => {
    assert.ok(
      ts.isShorthandPropertyAssignment(property) ||
        ts.isPropertyAssignment(property),
      rule,
    );
    return {
      name: property.name.getText(),
      value: ts.isShorthandPropertyAssignment(property)
        ? property.name
        : property.initializer,
    };
  });
}
function ctor(p: Context, name: string) {
  const fn = localFunction(p.source.statements, name);
  assert.equal(fn.asteriskToken, undefined, "inert-reader-constructor");
  assert.ok(
    !fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
    "inert-reader-constructor",
  );
  assert.equal(fn.parameters.length, 1, "only-original-reader-ports");
  const parameter = fn.parameters[0]!.name;
  assert.ok(
    parameter &&
      ts.isIdentifier(parameter) &&
      !fn.parameters[0]!.initializer &&
      !fn.parameters[0]!.dotDotDotToken,
    "only-original-reader-ports",
  );
  assert.equal(fn.body!.statements.length, 5, "inert-reader-constructor");
  const first = fn.body!.statements[0]!;
  assert.ok(
    ts.isVariableStatement(first) &&
      first.declarationList.flags & ts.NodeFlags.Const,
    "only-original-reader-ports",
  );
  assert.equal(
    first.declarationList.declarations.length,
    1,
    "only-original-reader-ports",
  );
  const captured = first.declarationList.declarations[0]!;
  assert.ok(
    captured.name &&
      ts.isObjectBindingPattern(captured.name) &&
      captured.initializer &&
      ts.isIdentifier(captured.initializer),
    "only-original-reader-ports",
  );
  assert.equal(
    id(p, captured.initializer),
    id(p, parameter),
    "only-original-reader-ports",
  );
  assert.deepEqual(
    captured.name.elements.map((n) => {
      assert.ok(n.name);
      return (n.propertyName ?? n.name).getText();
    }),
    ["current", "call", "refreshAfterMutation"],
    "only-original-reader-ports",
  );
  for (const binding of captured.name.elements) {
    assert.ok(
      binding.name &&
        ts.isIdentifier(binding.name) &&
        !binding.initializer &&
        !binding.dotDotDotToken,
      "only-original-reader-ports",
    );
    p.labels.set(
      id(p, binding.name)!,
      "port:" + (binding.propertyName ?? binding.name).getText(),
    );
  }
  assert.deepEqual(
    fn.body!.statements.slice(1, 4).map((n) => {
      assert.ok(ts.isFunctionDeclaration(n));
      return n.name?.text;
    }),
    names,
    "closed-three-reader-methods",
  );
  const last = fn.body!.statements[4]!;
  assert.ok(
    ts.isReturnStatement(last) && last.expression,
    "closed-three-reader-methods",
  );
  const returned = fields(last.expression, "direct-reader-method-return");
  assert.deepEqual(
    returned.map((n) => n.name),
    names,
    "closed-three-reader-methods",
  );
  for (const field of returned) {
    assert.ok(ts.isIdentifier(field.value), "direct-reader-method-return");
    assert.equal(
      id(p, field.value),
      id(p, localFunction(fn.body!.statements, field.name).name!),
      "direct-reader-method-return",
    );
  }
  return fn;
}
function directVariable(fn: ts.FunctionDeclaration, name: string) {
  const found = fn
    .body!.statements.filter(ts.isVariableStatement)
    .flatMap((n) => [...n.declarationList.declarations])
    .filter((n) => ts.isIdentifier(n.name) && n.name.text === name);
  assert.equal(found.length, 1, "actual-client-binding:" + name);
  return found[0]!;
}
function validate(input = sources) {
  const parsed = parseReaderSources({ ...input, Fixed: fixedSource }),
    client = context(parsed.get("Client")!),
    owner = context(parsed.get("Owner")!),
    old = context(parsed.get("Fixed")!);
  const original = ctor(old, "original");
  const factory = ctor(owner, "createReaderInteractions");
  for (const name of names)
    assert.deepEqual(
      shape(localFunction(factory.body!.statements, name), owner),
      shape(localFunction(original.body!.statements, name), old),
      "complete-original-reader-algorithm:" + name,
    );
  const workspace = localFunction(client.source.statements, "useWorkspace");
  const workspaceNodes = client.nodes.filter(
    (node) => node.pos >= workspace.body!.pos && node.end <= workspace.end,
  );
  const calls = workspaceNodes
    .filter(ts.isCallExpression)
    .filter(
      (call) =>
        ts.isIdentifier(call.expression) &&
        client.imports.get(id(client, call.expression)!) ===
          "./data/reader-interactions.js:createReaderInteractions",
    );
  assert.equal(calls.length, 1, "one-actual-reader-factory-call");
  const call = calls[0]!,
    declaration = call.parent;
  assert.ok(
    ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer === call,
    "direct-client-reader-construction",
  );
  assert.equal(
    declaration.parent.parent.parent,
    workspace.body,
    "direct-client-reader-construction",
  );
  assert.equal(call.arguments.length, 1, "same-original-client-reader-ports");
  const ports = fields(call.arguments[0]!, "same-original-client-reader-ports");
  assert.deepEqual(
    ports.map((n) => n.name),
    ["current", "call", "refreshAfterMutation"],
    "same-original-client-reader-ports",
  );
  const current = directVariable(workspace, "current");
  assert.ok(
    current.initializer && ts.isCallExpression(current.initializer),
    "actual-original-current-ref",
  );
  assert.equal(
    client.imports.get(id(client, current.initializer.expression)!),
    "react:useRef",
    "actual-original-current-ref",
  );
  assert.equal(
    current.initializer.arguments.length,
    1,
    "actual-original-current-ref",
  );
  assert.equal(
    current.initializer.arguments[0]!.kind,
    ts.SyntaxKind.NullKeyword,
    "actual-original-current-ref",
  );
  const refresh = localFunction(
    workspace.body!.statements,
    "refreshAfterMutation",
  );
  for (const port of ports) {
    assert.ok(ts.isIdentifier(port.value), "same-original-client-reader-ports");
    if (port.name === "call")
      assert.equal(
        client.imports.get(id(client, port.value)!),
        "./application-transport.js:applicationCall",
        "same-original-application-call",
      );
    else
      assert.equal(
        id(client, port.value),
        id(client, port.name === "current" ? current.name : refresh.name!),
        "same-original-client-reader-ports",
      );
  }
  const before = directVariable(workspace, "readerReads"),
    after = directVariable(workspace, "taskInteractions");
  assert.ok(
    current.end < declaration.pos &&
      before.end < declaration.pos &&
      declaration.end < after.pos,
    "original-reader-construction-region",
  );
  const returned = workspace.body!.statements.find(ts.isReturnStatement);
  assert.ok(returned?.expression, "actual-client-reader-publication");
  const publicFields = fields(
    returned.expression,
    "actual-client-reader-publication",
  );
  for (const name of names) {
    const aliases = publicFields.filter((field) => field.name === name);
    assert.equal(aliases.length, 1, "direct-public-reader-alias:" + name);
    const value = aliases[0]!.value;
    assert.ok(
      ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression),
      "direct-public-reader-alias:" + name,
    );
    assert.equal(value.name.text, name, "direct-public-reader-alias:" + name);
    assert.equal(
      id(client, value.expression),
      id(client, declaration.name),
      "direct-public-reader-alias:" + name,
    );
  }
  const uses = workspaceNodes
    .filter(ts.isPropertyAccessExpression)
    .filter(
      (n) =>
        ts.isIdentifier(n.expression) &&
        id(client, n.expression) === id(client, declaration.name),
    );
  assert.deepEqual(
    uses.map((n) => n.name.text).sort(),
    [...names].sort(),
    "only-three-direct-reader-consumers",
  );
  assert.equal(
    workspace
      .body!.statements.filter(ts.isFunctionDeclaration)
      .filter((n) => names.includes(n.name?.text as (typeof names)[number]))
      .length,
    0,
    "no-duplicate-client-reader-algorithm",
  );
  // Only the borrowed identities, not arbitrary state updates elsewhere.
  const borrowed = new Set([
    id(client, current.name),
    id(client, declaration.name),
    id(client, refresh.name!),
    id(client, ports[1]!.value),
  ]);
  assert.ok(
    !workspaceNodes.some(
      (n) =>
        ts.isBinaryExpression(n) &&
        ts.isAssignmentOperator(n.operatorToken.kind) &&
        ts.isIdentifier(n.left) &&
        borrowed.has(id(client, n.left)),
    ),
    "reader-borrowed-values-not-reassigned",
  );
  assert.equal(factory.parent, owner.source, "actual-module-reader-owner");
}
function changed(key: keyof typeof sources, before: string, after: string) {
  assert.equal(
    sources[key].split(before).length,
    2,
    "one-parse-valid-mutation-target",
  );
  const result = { ...sources, [key]: sources[key].replace(before, after) };
  parseReaderSources(result);
  return result;
}
test("independent committed three-method archive retains full original raw hashes", () => {
  assert.equal(fixed.git, "21cb34dc4d3c975247feda810d4d15f70c678737");
  assert.deepEqual(
    fixed.functions.map((f) => f.name),
    names,
  );
  for (const record of fixed.functions)
    assert.equal(
      createHash("sha256").update(record.raw).digest("hex"),
      record.sha256,
    );
});
test("actual inert Reader family and direct Client consumption preserve all three contracts", () =>
  validate());

type Case = readonly [keyof typeof sources, string, string, string];
function counterexamples(name: string, cases: readonly Case[]) {
  test(name, () => {
    for (const [key, before, after, rule] of cases)
      assert.throws(
        () => validate(changed(key, before, after)),
        (error) => {
          assert.ok(error instanceof assert.AssertionError, rule);
          assert.equal(error.message.split("\n")[0], rule, before);
          return true;
        },
      );
  });
}
counterexamples(
  "inert closed constructor rejects work, policy and public wrappers",
  [
    [
      "Owner",
      "  async function importReading(",
      "  current.current;\n  async function importReading(",
      "inert-reader-constructor",
    ],
    [
      "Owner",
      "  async function importReading(",
      "  refreshAfterMutation();\n  async function importReading(",
      "inert-reader-constructor",
    ],
    [
      "Owner",
      "return { importReading, readingOcr, readerCommand };",
      "return { importReading: async (...args) => importReading(...args), readingOcr, readerCommand };",
      "direct-reader-method-return",
    ],
  ],
);
counterexamples(
  "complete import, OCR and command retain distinct original policies",
  [
    [
      "Owner",
      "AbortSignal.timeout(35000)",
      "AbortSignal.timeout(30000)",
      "complete-original-reader-algorithm:importReading",
    ],
    [
      "Owner",
      "if (!(await refreshAfterMutation()))",
      "if (!refreshAfterMutation())",
      "complete-original-reader-algorithm:importReading",
    ],
    [
      "Owner",
      "if (signal?.aborted || current.current?.csrfToken !== identity.csrfToken)",
      "if (current.current?.csrfToken !== identity.csrfToken)",
      "complete-original-reader-algorithm:readingOcr",
    ],
    [
      "Owner",
      "      signal,\n",
      "      signal: signal ?? AbortSignal.timeout(12000),\n",
      "complete-original-reader-algorithm:readingOcr",
    ],
    [
      "Owner",
      "error.status !== 408",
      "error.status !== 409",
      "complete-original-reader-algorithm:readerCommand",
    ],
    [
      "Owner",
      "      return receipt;",
      "      await refreshAfterMutation();\n      return receipt;",
      "complete-original-reader-algorithm:readerCommand",
    ],
  ],
);
counterexamples(
  "called storage, retry helper and error class require actual module values",
  [
    [
      "Owner",
      'import { runPendingFileImport } from "../pending-file-import.js";',
      'import {runPendingFileImport as originalImport} from "../pending-file-import.js"; import {runPendingFileImport} from "./foreign.js";',
      "complete-original-reader-algorithm:importReading",
    ],
    [
      "Owner",
      'import { draftKey, scopedStorage } from "../local-preferences.js";',
      'import {draftKey,scopedStorage as originalStorage} from "../local-preferences.js"; import {scopedStorage} from "./foreign.js";',
      "complete-original-reader-algorithm:importReading",
    ],
    [
      "Owner",
      'import { RequestError } from "../application-transport.js";',
      'import {RequestError as originalError} from "../application-transport.js"; import {RequestError} from "./foreign.js";',
      "complete-original-reader-algorithm:readerCommand",
    ],
  ],
);
counterexamples(
  "actual Client borrows original ref, transport and refresh, not nominal substitutes",
  [
    [
      "Client",
      'import { createReaderInteractions } from "./data/reader-interactions.js";',
      'import {createReaderInteractions as originalOwner} from "./data/reader-interactions.js"; import {createReaderInteractions} from "./foreign.js";',
      "one-actual-reader-factory-call",
    ],
    [
      "Client",
      "  const readerInteractions = createReaderInteractions({\n    current,",
      "  const readerInteractions = createReaderInteractions({\n    current: {current:current.current},",
      "same-original-client-reader-ports",
    ],
    [
      "Client",
      "  const readerInteractions = createReaderInteractions({\n    current,\n    call: applicationCall,",
      "  const readerInteractions = createReaderInteractions({\n    current,\n    call: (...args)=>applicationCall(...args),",
      "same-original-client-reader-ports",
    ],
    [
      "Client",
      "  const readerInteractions = createReaderInteractions({\n    current,\n    call: applicationCall,\n    refreshAfterMutation,",
      "  const readerInteractions = createReaderInteractions({\n    current,\n    call: applicationCall,\n    refreshAfterMutation: async ()=>refreshAfterMutation(),",
      "same-original-client-reader-ports",
    ],
    [
      "Client",
      "readerCommand: readerInteractions.readerCommand,",
      "readerCommand: async (...args)=>readerInteractions.readerCommand(...args),",
      "direct-public-reader-alias:readerCommand",
    ],
    [
      "Client",
      "importReading: readerInteractions.importReading,",
      "importReading: readerInteractions.readingOcr,",
      "direct-public-reader-alias:importReading",
    ],
  ],
);
test("true import and local value aliases, static annotations and unrelated features remain legal", () => {
  validate({
    ...sources,
    Owner: sources.Owner.replace(
      "import { runPendingFileImport }",
      "import { runPendingFileImport as retryImport }",
    )
      .replace("return runPendingFileImport(", "return retryImport(")
      .replace(
        "export function createReaderInteractions(",
        "const storageFor = scopedStorage;\nexport function createReaderInteractions(",
      )
      .replace(/\bscopedStorage\(/g, "storageFor(")
      .replace(
        "call: applicationCall, refreshAfterMutation",
        "call: rpc, refreshAfterMutation",
      )
      .replace(/\bapplicationCall\(/g, "rpc("),
    Client: sources.Client.replace(
      "import { createReaderInteractions }",
      "import { createReaderInteractions as readerFactory }",
    )
      .replace(
        "export function useWorkspace(",
        "const directReaderFactory = readerFactory;\nexport function useWorkspace(",
      )
      .replace(
        "const readerInteractions = createReaderInteractions(",
        "const readerInteractions = directReaderFactory(",
      ),
  });
  validate({
    ...sources,
    Owner:
      sources.Owner.replace(
        "file: File,",
        "file: File & {readonly extra?:true},",
      ) +
      '\nimport type {Future} from "./future.js";\nimport {useEffect} from "react";\nexport function independentFeature(){function readerCommand(){return "independent";} useEffect(()=>{},[]);return readerCommand();}\nexport const independent = 1;\n',
    Client:
      sources.Client +
      '\nexport function independentUI(){return "reader-independent";}\n',
  });
});
