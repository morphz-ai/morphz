import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyClientProjectionLifetime } from "./fixtures/client-projection-lifetime-21cb34dc.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isNamedImports,
  isNewExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// Finite ownership/wiring rules for this migrated read family. Not a general
// purity sandbox, scheduling proof or full Client freeze. Fixed 4ce98b64 read
// traces separately verify requests, late results, budgets and error timing.
const modulePath = "./data/script-editor-reads.js";
const methods = [
  "readScriptEditorPage",
  "readScriptEditor",
  "getScriptEditor",
  "readScriptVersion",
  "readScriptCandidate",
  "readScriptVersionTitle",
  "readScriptReview",
  "readScriptExport",
  "readScriptContext",
  "readScriptExportManifest",
  "resolveScriptLocation",
  "scriptVersionTitle",
];
const sources = {
  Client: readFileSync("apps/web/src/client.ts", "utf8"),
  Owner: readFileSync("apps/web/src/data/script-editor-reads.ts", "utf8"),
};
// Literal old session/cache/clear shapes, plus the approved typed-port spelling
// of the two existing callbacks. No candidate-derived hash is used as oracle.
const expectedText = `
function scriptReadSession() {
  const identity = current.current, source = platform.current;
  const generation = protectedReadGeneration.current;
  if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
    throw new Error("身份已变化，剧本未读取。");
  const check = () => {
    if (current.current?.csrfToken !== identity.csrfToken || protectedReadGeneration.current !== generation)
      throw new Error("身份或访问范围已变化，剧本未读取。");
  };
  return {identity, source, check};
}
const scriptEditorModels = useRef(new Map<string, {identity: string; value: ScriptEditorProduction}>());
const scriptVersionTitles = useRef(new Map<string, string>());
const approvalSubmissions = useRef(new Set<string>());
const ports = {
  session: scriptReadSession, call: applicationCall, models: scriptEditorModels,
  titles: scriptVersionTitles, currentIdentity: () => current.current?.csrfToken,
  currentEntry: (productionId) => current.current?.scriptLibrary.find(value => value.id === productionId),
  rememberContent,
};
function clearProtectedProjection() {
  protectedReadGeneration.current++; current.current = null; platform.current = null;
  conversationHistory.clear(); catalogCache.current = null; scriptOverviews.current.clear();
  pendingScriptOverviews.current.clear(); scriptEditorReads.clear();
  navigationCacheKey.current = ""; snapshotText.current = "";
}
function authClear() {
  protectedReadGeneration.current++; scriptEditorReads.clear();
  current.current = null; platform.current = null; conversationHistory.clear();
  catalogCache.current = null; scriptOverviews.current.clear(); pendingScriptOverviews.current.clear();
  navigationCacheKey.current = ""; snapshotText.current = "";
}
function editorPageReader(identity: ScriptReadSession["identity"], check: ScriptReadSession["check"]) {
  return async (request: ScriptEditorPageRequest) => {
    const value = await applicationCall("scripts.editor.page", request, {identityGeneration: identity.csrfToken});
    check(); return value;
  };
}
function rememberTitle(key: string, title: string) {
  scriptVersionTitles.current.set(key, title);
  if (scriptVersionTitles.current.size > 512)
    scriptVersionTitles.current.delete(scriptVersionTitles.current.keys().next().value!);
}
function clear() { scriptEditorModels.current.clear(); scriptVersionTitles.current.clear(); }
function borrow() {
  const {session: scriptReadSession, call: applicationCall, models: scriptEditorModels,
    titles: scriptVersionTitles, rememberContent} = options;
}
function boundedModels() {
  if (scriptEditorModels.current.size > 64)
    scriptEditorModels.current.delete(scriptEditorModels.current.keys().next().value!);
}
function getScriptEditor(productionId: string) {
  const cached = scriptEditorModels.current.get(productionId);
  const entry = options.currentEntry(productionId);
  if (!cached || !entry || cached.identity !== options.currentIdentity() ||
      entry.catalogRevision !== cached.value.catalogRevision || entry.activityRevision !== cached.value.activityRevision)
    return undefined;
  return cached.value;
}
function scriptVersionTitle(productionId: string, itemId: string, revision: number) {
  return scriptVersionTitles.current.get(
    \`\${options.currentIdentity()}:\${productionId}:\${itemId}:\${revision}\`,
  );
}
function captured() { const {identity, source, check} = scriptReadSession(); }
function pageCaptured() { const {identity, check} = scriptReadSession(); }
function outerCaptured() { const {check} = scriptReadSession(); }
function construction(options: ScriptEditorReadPorts) {}
type ScriptReadSession = { identity: {csrfToken: string}; source: PlatformClient; check: () => void };
type ScriptEditorReadPorts = {
  session: () => ScriptReadSession; call: typeof applicationCall;
  models: {current: ScriptEditorModelCache}; titles: {current: ScriptVersionTitleCache};
  currentIdentity: () => string | undefined;
  currentEntry: (productionId: string) => Pick<ScriptEditorProduction, "catalogRevision" | "activityRevision"> | undefined;
  rememberContent: (entry: PlatformContent, generation: string) => void;
};
`;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  symbols: Map<Node, number | undefined>;
};
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
function parse(contents: Record<string, string>) {
  const directory = "/script-editor-reads-boundary",
    config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [
      `${directory}/${name}.ts`,
      text,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true },
    files: Object.keys(contents).map((name) => `${name}.ts`),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "fixtures must first parse successfully",
    );
    return new Map(
      Object.keys(contents).map((name): [string, Parsed] => {
        const source = project.program.getSourceFile(
          `${directory}/${name}.ts`,
        )!;
        const nodes: Node[] = [],
          names: Identifier[] = [];
        walk(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) names.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(names);
        return [
          name,
          {
            source,
            nodes,
            symbols: new Map(
              names.map((node, index) => [node, resolved[index]?.id]),
            ),
          },
        ];
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function syntax(node: Node): unknown {
  if (isParenthesizedExpression(node)) return syntax(node.expression);
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
    return [node.kind, node.operator, syntax(node.operand)];
  if (isBinaryExpression(node))
    return [
      node.kind,
      node.operatorToken.kind,
      syntax(node.left),
      syntax(node.right),
    ];
  if (isStringLiteral(node)) return [node.kind, node.text];
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(syntax(child));
  });
  return [node.kind, children.length ? children : node.getText()];
}
function same(actual: Node | undefined, expected: Node | undefined) {
  assert.ok(actual && expected, "both contract nodes exist");
  assert.deepEqual(syntax(actual), syntax(expected));
}
function fn(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, `one ${name}`);
  assert.ok(found[0]!.body);
  return found[0]!;
}
function variable(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, `one ${name} binding`);
  return found[0]!;
}
function imported(parsed: Parsed, from: string, name: string) {
  const matches: Identifier[] = [];
  for (const node of parsed.nodes.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== from
    )
      continue;
    const clause = node.importClause;
    if (
      clause?.phaseModifier === SyntaxKind.TypeKeyword ||
      !clause?.namedBindings ||
      !isNamedImports(clause.namedBindings)
    )
      continue;
    for (const item of clause.namedBindings.elements)
      if (!item.isTypeOnly && (item.propertyName ?? item.name).text === name)
        matches.push(item.name);
  }
  assert.equal(matches.length, 1, `${name} actual runtime import`);
  const symbol = parsed.symbols.get(matches[0]!);
  assert.notEqual(symbol, undefined);
  return symbol;
}
function properties(node: Node | undefined) {
  assert.ok(node && isObjectLiteralExpression(node));
  const result = new Map(
    node.properties.map((property) => {
      assert.ok(
        isPropertyAssignment(property) ||
          isShorthandPropertyAssignment(property),
      );
      assert.ok(isIdentifier(property.name));
      return [property.name.text, property];
    }),
  );
  assert.equal(
    result.size,
    node.properties.length,
    "no duplicate ports/exports",
  );
  return result;
}
const expected = parse({ Expected: expectedText }).get("Expected")!;
const forbidden = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "XMLHttpRequest",
  "EventSource",
  "WebSocket",
  "setTimeout",
  "setInterval",
  "queueMicrotask",
  "globalThis",
  "process",
  "require",
  "useRef",
  "useState",
  "useEffect",
  "useLayoutEffect",
  "WorkspaceClient",
  "protectedReadGeneration",
]);
const runtimeImports: Record<string, string[]> = {
  "../script-editor-reader.js": [
    "collectEditorPage",
    "parseEditorHead",
    "parseEditorVersion",
    "parseEditorCandidate",
  ],
  "../../../../packages/core/src/script-editor.js": [
    "scriptReviewDetailSchema",
    "scriptExportDetailSchema",
    "scriptVersionTitleSchema",
  ],
  "../../../../packages/core/src/script-studio.js": ["scriptProductionSchema"],
  "../../../../packages/core/src/script-studio-docx.js": ["scriptDocxLimits"],
};
const typeImports = new Set([
  ...Object.keys(runtimeImports),
  "../application-transport.js",
  "../platform-client.js",
  "../../../../packages/core/src/script-delivery.js",
]);

function violations(contents: typeof sources) {
  // Syntax validation is outside the rule catcher: invalid fixtures fail the
  // test rather than masquerading as a successful negative counterexample.
  const parsed = parse(contents),
    client = parsed.get("Client")!,
    owner = parsed.get("Owner")!;
  const issues: string[] = [];
  const rule = (name: string, check: () => void) => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      issues.push(name);
    }
  };
  rule("typed-dependencies-no-ambient-effects", () => {
    for (const node of owner.nodes) {
      assert.notEqual(node.kind, SyntaxKind.AnyKeyword);
      assert.notEqual(node.kind, SyntaxKind.ImportType);
      assert.notEqual(node.kind, SyntaxKind.ExportDeclaration);
      if (isIdentifier(node)) {
        assert.ok(!forbidden.has(node.text), node.text);
        if (node.text === "PlatformClient")
          assert.ok(
            [SyntaxKind.ImportSpecifier, SyntaxKind.TypeReference].includes(
              node.parent.kind,
            ),
            "PlatformClient is a type, not a new connection",
          );
      }
      if (isCallExpression(node))
        assert.notEqual(node.expression.kind, SyntaxKind.ImportKeyword);
      if (!isImportDeclaration(node)) continue;
      assert.ok(isStringLiteral(node.moduleSpecifier));
      const from = node.moduleSpecifier.text,
        clause = node.importClause;
      assert.ok(
        clause &&
          !clause.name &&
          clause.namedBindings &&
          isNamedImports(clause.namedBindings),
      );
      for (const item of clause.namedBindings.elements) {
        const name = (item.propertyName ?? item.name).text;
        if (clause.phaseModifier === SyntaxKind.TypeKeyword || item.isTypeOnly)
          assert.ok(typeImports.has(from));
        else assert.ok(runtimeImports[from]?.includes(name), `${from}:${name}`);
      }
    }
  });
  rule("single-actual-owner-and-direct-exports", () => {
    const factorySymbol = imported(
      client,
      modulePath,
      "createScriptEditorReads",
    );
    const calls = client.nodes
      .filter(isCallExpression)
      .filter((node) => client.symbols.get(node.expression) === factorySymbol);
    assert.equal(calls.length, 1);
    const binding = variable(client, "scriptEditorReads");
    assert.equal(binding.initializer, calls[0]);
    assert.ok(isIdentifier(binding.name));
    const ownerSymbol = client.symbols.get(binding.name);
    assert.notEqual(ownerSymbol, undefined);
    assert.equal(calls[0]!.arguments.length, 1);
    same(calls[0]!.arguments[0], variable(expected, "ports").initializer);
    const workspace = fn(client, "useWorkspace");
    const returns = workspace.body!.statements.filter(isReturnStatement);
    assert.equal(returns.length, 1);
    const exports = properties(returns[0]!.expression);
    for (const name of methods) {
      const property = exports.get(name);
      assert.ok(property && isPropertyAssignment(property));
      const value = property.initializer;
      assert.ok(
        isPropertyAccessExpression(value) && isIdentifier(value.expression),
      );
      assert.equal(value.name.text, name);
      assert.equal(client.symbols.get(value.expression), ownerSymbol);
      assert.equal(
        client.nodes
          .filter(isFunctionDeclaration)
          .filter((node) => node.name?.text === name).length,
        0,
      );
    }
    const conversation = variable(client, "conversationHistory");
    assert.ok(
      binding.pos > conversation.end &&
        binding.end < fn(client, "clearProtectedProjection").pos,
    );
  });
  rule("original-cache-registration-and-session-authority", () => {
    const workspace = fn(client, "useWorkspace");
    const refSymbol = imported(client, "react", "useRef");
    const instance = variable(client, "scriptEditorReads").initializer;
    assert.ok(instance && isCallExpression(instance));
    const ports = properties(instance.arguments[0]);
    for (const [index, name] of [
      "scriptEditorModels",
      "scriptVersionTitles",
      "approvalSubmissions",
    ].entries()) {
      const binding = variable(client, name);
      const statement = workspace.body!.statements[index];
      assert.ok(statement && isVariableStatement(statement));
      assert.equal(statement.declarationList.declarations[0], binding);
      same(binding.initializer, variable(expected, name).initializer);
      assert.ok(binding.initializer && isCallExpression(binding.initializer));
      assert.equal(
        client.symbols.get(binding.initializer.expression),
        refSymbol,
      );
      if (name === "approvalSubmissions") continue;
      const port = ports.get(
        name === "scriptEditorModels" ? "models" : "titles",
      );
      assert.ok(port && isPropertyAssignment(port));
      const symbol = client.symbols.get(binding.name);
      assert.notEqual(symbol, undefined);
      for (const use of client.nodes
        .filter(isIdentifier)
        .filter((node) => client.symbols.get(node) === symbol))
        assert.ok(
          use === binding.name || use === port.initializer,
          "cache ref is borrowed once, without another Client adapter",
        );
    }
    same(fn(client, "scriptReadSession"), fn(expected, "scriptReadSession"));
    for (const node of client.nodes.filter(isPropertyAccessExpression)) {
      if (
        isIdentifier(node.expression) &&
        ["scriptEditorModels", "scriptVersionTitles"].includes(
          node.expression.text,
        )
      )
        assert.fail("cache refs must be passed intact, not used by Client");
    }
  });
  rule("original-generation-and-synchronous-clear-order", () => {
    // The same fixed historical clear now has a finite reviewed extension:
    // old synchronous retirement first, guarded pending-read cancellation and
    // empty cognitive projection. Compare its complete function through the
    // shared provenance-checked oracle, not a broad statement filter or a new
    // candidate-derived historical template. Auth clears remain unchanged.
    verifyClientProjectionLifetime(contents.Client);
    const binding = variable(client, "scriptEditorReads");
    assert.ok(isIdentifier(binding.name));
    const ownerSymbol = client.symbols.get(binding.name);
    const clears = client.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "clear" &&
          client.symbols.get(node.expression.expression) === ownerSymbol,
      );
    assert.equal(clears.length, 3);
    for (const name of ["clearProtectedProjection", "login", "logout"]) {
      const statements = fn(client, name).body!.statements;
      if (name !== "clearProtectedProjection") {
        const target = fn(expected, "authClear").body!.statements;
        const start = statements.findIndex(
          (statement) =>
            JSON.stringify(syntax(statement)) ===
            JSON.stringify(syntax(target[0]!)),
        );
        assert.ok(start >= 0);
        assert.deepEqual(
          statements.slice(start, start + target.length).map(syntax),
          target.map(syntax),
        );
      }
      assert.equal(
        clears.filter(
          (call) =>
            call.pos >= fn(client, name).pos &&
            call.end <= fn(client, name).end,
        ).length,
        1,
      );
    }
  });
  rule("inert-construction-original-cache-ownership", () => {
    const factory = fn(owner, "createScriptEditorReads"),
      statements = factory.body!.statements;
    assert.deepEqual(
      factory.modifiers?.map((node) => node.kind),
      [SyntaxKind.ExportKeyword],
    );
    assert.equal(factory.parameters.length, 1);
    same(factory.parameters[0], fn(expected, "construction").parameters[0]);
    for (const name of ["ScriptReadSession", "ScriptEditorReadPorts"]) {
      const actual = owner.nodes
        .filter(isTypeAliasDeclaration)
        .filter((node) => node.name.text === name);
      const original = expected.nodes
        .filter(isTypeAliasDeclaration)
        .filter((node) => node.name.text === name);
      assert.equal(actual.length, 1);
      same(actual[0]!.type, original[0]!.type);
    }
    assert.ok(statements[0] && isVariableStatement(statements[0]));
    assert.equal(statements[0]!.declarationList.declarations.length, 1);
    const declaration = statements[0]!.declarationList.declarations[0]!;
    same(statements[0], fn(expected, "borrow").body!.statements[0]);
    assert.ok(
      declaration.initializer &&
        isIdentifier(declaration.initializer) &&
        declaration.initializer.text === "options",
    );
    for (const statement of statements.slice(1, -1))
      assert.ok(isFunctionDeclaration(statement));
    const returned = statements.at(-1)!;
    assert.ok(isReturnStatement(returned));
    assert.deepEqual(
      [...properties(returned.expression).keys()].sort(),
      [...methods, "clear"].sort(),
    );
    for (const property of properties(returned.expression).values())
      assert.ok(isShorthandPropertyAssignment(property));
    for (const node of owner.nodes.filter(isNewExpression))
      assert.ok(
        isIdentifier(node.expression) &&
          ["Set", "Error"].includes(node.expression.text),
        "no mirrored cache or authority",
      );
    for (const node of owner.nodes.filter(isBinaryExpression))
      if (
        node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= SyntaxKind.LastAssignment
      )
        assert.ok(
          !(
            isPropertyAccessExpression(node.left) &&
            node.left.name.text === "current"
          ),
        );
    for (const statement of owner.source.statements)
      assert.ok(
        isImportDeclaration(statement) ||
          statement.kind === SyntaxKind.TypeAliasDeclaration ||
          statement === factory,
      );
    same(fn(owner, "clear"), fn(expected, "clear"));
    same(fn(owner, "rememberTitle"), fn(expected, "rememberTitle"));
    const evictions = owner.nodes.filter(isIfStatement).filter((node) => {
      const expression = node.expression;
      if (!isBinaryExpression(expression)) return false;
      const size = expression.left;
      return (
        isPropertyAccessExpression(size) &&
        size.name.text === "size" &&
        isPropertyAccessExpression(size.expression) &&
        size.expression.name.text === "current" &&
        isIdentifier(size.expression.expression) &&
        size.expression.expression.text === "scriptEditorModels"
      );
    });
    assert.equal(evictions.length, 1);
    same(evictions[0], fn(expected, "boundedModels").body!.statements[0]);
  });
  rule("shared-page-reader-and-no-session-getters", () => {
    same(fn(owner, "editorPageReader"), fn(expected, "editorPageReader"));
    same(fn(owner, "getScriptEditor"), fn(expected, "getScriptEditor"));
    same(fn(owner, "scriptVersionTitle"), fn(expected, "scriptVersionTitle"));
    const collectorSymbol = imported(
      owner,
      "../script-editor-reader.js",
      "collectEditorPage",
    );
    const collectors = owner.nodes
      .filter(isCallExpression)
      .filter((node) => owner.symbols.get(node.expression) === collectorSymbol);
    assert.equal(collectors.length, 2);
    const reader = fn(owner, "editorPageReader");
    const symbol = owner.symbols.get(reader.name!);
    assert.notEqual(symbol, undefined);
    for (const collect of collectors) {
      const argument = collect.arguments[0];
      assert.ok(argument && isCallExpression(argument));
      assert.equal(owner.symbols.get(argument.expression), symbol);
    }
    const sessionBindings = owner.nodes
      .filter(isIdentifier)
      .filter(
        (node) =>
          node.text === "scriptReadSession" &&
          node.parent.kind === SyntaxKind.BindingElement,
      );
    assert.equal(sessionBindings.length, 1);
    const sessionSymbol = owner.symbols.get(sessionBindings[0]!);
    assert.notEqual(sessionSymbol, undefined);
    const callBindings = owner.nodes
      .filter(isIdentifier)
      .filter(
        (node) =>
          node.text === "applicationCall" &&
          node.parent.kind === SyntaxKind.BindingElement,
      );
    assert.equal(callBindings.length, 1);
    const callSymbol = owner.symbols.get(callBindings[0]!);
    assert.notEqual(callSymbol, undefined);
    const calls = owner.nodes
      .filter(isCallExpression)
      .filter((node) => owner.symbols.get(node.expression) === callSymbol);
    assert.equal(calls.length, 7);
    for (const call of calls) {
      const operation = call.arguments[0];
      assert.ok(operation && isStringLiteral(operation));
      assert.ok(
        [
          "scripts.editor.page",
          "scripts.editor.head",
          "scripts.editor.detail",
        ].includes(operation.text),
      );
    }
    for (const call of owner.nodes.filter(isCallExpression))
      if (
        isPropertyAccessExpression(call.expression) &&
        isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "source"
      )
        assert.ok(
          ["resolveContent", "getContent", "readScriptItem"].includes(
            call.expression.name.text,
          ),
        );
    for (const name of methods.filter(
      (name) => !["getScriptEditor", "scriptVersionTitle"].includes(name),
    )) {
      const first = fn(owner, name).body!.statements[0];
      assert.ok(first && isVariableStatement(first));
      const declaration = first.declarationList.declarations[0]!;
      const template = [
        "readScriptExportManifest",
        "resolveScriptLocation",
      ].includes(name)
        ? "outerCaptured"
        : [
              "readScriptEditorPage",
              "readScriptVersionTitle",
              "readScriptReview",
              "readScriptExport",
              "readScriptContext",
            ].includes(name)
          ? "pageCaptured"
          : "captured";
      same(first, fn(expected, template).body!.statements[0]);
      assert.ok(
        declaration.initializer && isCallExpression(declaration.initializer),
      );
      assert.ok(
        isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === "scriptReadSession",
      );
      assert.equal(
        owner.symbols.get(declaration.initializer.expression),
        sessionSymbol,
      );
      assert.equal(declaration.initializer.arguments.length, 0);
    }
    const writerSymbol = owner.symbols.get(fn(owner, "rememberTitle").name!);
    const writes = owner.nodes
      .filter(isCallExpression)
      .filter((node) => owner.symbols.get(node.expression) === writerSymbol);
    assert.equal(writes.length, 2);
    for (const name of ["readScriptVersion", "readScriptVersionTitle"])
      assert.equal(
        writes.filter(
          (node) =>
            node.pos >= fn(owner, name).pos && node.end <= fn(owner, name).end,
        ).length,
        1,
      );
  });
  return issues;
}

test("Client directly consumes one inert ScriptEditor read owner and original authority/cache refs", () => {
  assert.deepEqual(violations(sources), []);
});

test("finite projection growth cannot omit or reorder original synchronous clears, broaden cancellation or retain the new catalog", () => {
  const clear = fn(
    parse(sources).get("Client")!,
    "clearProtectedProjection",
  ).getText();
  const cancellation =
    "if (navigationReadController.current !== keepRead)\n      navigationReadController.current?.abort();";
  assert.ok(clear.includes(cancellation));
  const change = (before: string, after: string) => {
    assert.ok(
      clear.includes(before),
      "finite clear fixture target exists: " + before,
    );
    return clear.replace(before, after);
  };
  const candidates = [
    // Every old generation/cache statement remains mandatory in this named
    // ScriptEditor gate as well as the shared complete lifetime oracle.
    ...fn(expected, "clearProtectedProjection").body!.statements.map(
      (statement) => change(statement.getText(), ""),
    ),
    change("keepRead?: AbortController", "keepRead?: AbortSignal"),
    change("if (navigationReadController.current !== keepRead)", "if (true)"),
    change(cancellation, ""),
    change(
      "navigationReadController.current?.abort();",
      "void Promise.resolve().then(() => navigationReadController.current?.abort());",
    ),
    change(cancellation, "").replace(
      "protectedReadGeneration.current++;",
      cancellation + "\n    protectedReadGeneration.current++;",
    ),
    change(cancellation, "").replace(
      "scriptEditorReads.clear();",
      "scriptEditorReads.clear();\n    " + cancellation,
    ),
    change("setCognitiveAppCatalog({ versions: [], connections: [] });", ""),
    change(
      "setCognitiveAppCatalog({ versions: [], connections: [] });",
      "setCognitiveAppCatalog({ versions: [], connections: retainedConnections });",
    ),
    change(
      "setCognitiveAppCatalog({ versions: [], connections: [] });",
      "void Promise.resolve().then(() => setCognitiveAppCatalog({ versions: [], connections: [] }));",
    ),
  ];
  for (const candidate of candidates) {
    assert.notEqual(candidate, clear);
    assert.ok(
      violations({
        ...sources,
        Client: sources.Client.replace(clear, candidate),
      }).includes("original-generation-and-synchronous-clear-order"),
      "the original named synchronous-clear rule rejects this finite change: " +
        candidate,
    );
  }
});

test("finite ownership rules accept formatting and reject parsed counterexamples by named AssertionError", () => {
  assert.deepEqual(
    violations({
      Client: sources.Client.replaceAll(
        "scriptEditorReads.",
        "scriptEditorReads /* formatting */ .",
      )
        .replace(
          "import { createScriptEditorReads }",
          "import { createScriptEditorReads as createReadFamily }",
        )
        .replace("= createScriptEditorReads({", "= createReadFamily({"),
      Owner: sources.Owner.replaceAll("check();", "(check) ( );")
        .replaceAll(
          "options: ScriptEditorReadPorts",
          "options :\n ScriptEditorReadPorts",
        )
        .replaceAll(
          "scriptEditorModels.current.size",
          "scriptEditorModels . current . size",
        ),
    }),
    [],
  );
  const cases: [keyof typeof sources, string, string, string][] = [
    [
      "Client",
      "export function useWorkspace() {",
      "export function useWorkspace() { const createScriptEditorReads = (...args) => ({});",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "export function useWorkspace() {",
      "export function useWorkspace() { createScriptEditorReads({});",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      modulePath,
      "./data/not-script-editor-reads.js",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "session: scriptReadSession",
      "session: () => ({ identity: current.current!, source: platform.current!, check: () => {} })",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "call: applicationCall",
      "call: ((...args) => applicationCall(...args))",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "models: scriptEditorModels",
      "models: {current: new Map()}",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "models: scriptEditorModels",
      "models: scriptVersionTitles",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "titles: scriptVersionTitles,\n    currentIdentity: () => current.current?.csrfToken",
      "titles: scriptVersionTitles,\n    currentIdentity: () => boot?.csrfToken",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "readScriptEditor: scriptEditorReads.readScriptEditor",
      "readScriptEditor: () => ({}), readScriptEditor: scriptEditorReads.readScriptEditor",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "readScriptEditor: scriptEditorReads.readScriptEditor",
      "readScriptEditor: async (...args) => scriptEditorReads.readScriptEditor(...args)",
      "single-actual-owner-and-direct-exports",
    ],
    [
      "Client",
      "const generation = protectedReadGeneration.current;\n    if (!identity || !source",
      "const generation = protectedReadGeneration.current;\n    if (~identity || !source",
      "original-cache-registration-and-session-authority",
    ],
    [
      "Client",
      "export function useWorkspace() {",
      "export function useWorkspace() { const scriptEditorMirror = useRef(new Map());",
      "original-cache-registration-and-session-authority",
    ],
    [
      "Client",
      "export function useWorkspace() {",
      "export function useWorkspace() { function useRef(value) { return {current: value}; }",
      "original-cache-registration-and-session-authority",
    ],
    [
      "Client",
      "const approvalSubmissions = useRef(new Set<string>());",
      "const approvalSubmissions = useRef(new Set<string>()); const mirror = scriptEditorModels;",
      "original-cache-registration-and-session-authority",
    ],
    [
      "Client",
      "const scriptVersionTitles = useRef(new Map<string, string>());",
      "const scriptVersionTitles = useRef(new Map<string, string>()); scriptVersionTitles.current.clear();",
      "original-cache-registration-and-session-authority",
    ],
    [
      "Client",
      "protectedReadGeneration.current++;\n    scriptEditorReads.clear();",
      "scriptEditorReads.clear();\n    protectedReadGeneration.current++;",
      "original-generation-and-synchronous-clear-order",
    ],
    [
      "Client",
      "scriptEditorReads.clear();",
      "void Promise.resolve().then(() => scriptEditorReads.clear());",
      "original-generation-and-synchronous-clear-order",
    ],
    [
      "Client",
      "scriptEditorReads.clear();",
      "",
      "original-generation-and-synchronous-clear-order",
    ],
    [
      "Owner",
      "import type { applicationCall }",
      "import { applicationCall }",
      "typed-dependencies-no-ambient-effects",
    ],
    [
      "Owner",
      "function clear() {",
      "function clear() { const cache = localStorage;",
      "typed-dependencies-no-ambient-effects",
    ],
    [
      "Owner",
      "function clear() {",
      "function clear() { PlatformClient.connect();",
      "typed-dependencies-no-ambient-effects",
    ],
    [
      "Owner",
      "function clear() {",
      "function clear() { const mirror = new Map();",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "} = options;",
      "} = options; scriptReadSession();",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "export function createScriptEditorReads",
      "export async function createScriptEditorReads",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "session: () => ScriptReadSession;",
      "session: () => ScriptReadSession; currentBoot: () => PlatformClient;",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "models: scriptEditorModels",
      "titles: scriptEditorModels",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "function clear() {",
      "function clear() { scriptEditorModels.current = options.models.current;",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "scriptEditorModels.current.size > 64",
      "scriptEditorModels.current.size >= 64",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "scriptVersionTitles.current.size > 512",
      "scriptVersionTitles.current.size >= 512",
      "inert-construction-original-cache-ownership",
    ],
    [
      "Owner",
      "function getScriptEditor(productionId: string) {",
      "function getScriptEditor(productionId: string) { scriptReadSession();",
      "shared-page-reader-and-no-session-getters",
    ],
    [
      "Owner",
      "!cached ||",
      "~cached ||",
      "shared-page-reader-and-no-session-getters",
    ],
    [
      "Owner",
      "editorPageReader(identity, check)",
      "async request => options.call('scripts.editor.page', request)",
      "shared-page-reader-and-no-session-getters",
    ],
    [
      "Owner",
      '"scripts.editor.page", request',
      '"scripts.request.run", request',
      "shared-page-reader-and-no-session-getters",
    ],
    [
      "Owner",
      "source.getContent(catalog.id)",
      "source.deleteContent(catalog.id)",
      "shared-page-reader-and-no-session-getters",
    ],
    [
      "Owner",
      "const { identity, check } = scriptReadSession();",
      "const { identity, check } = scriptReadSession(); function scriptReadSession() { return {}; }",
      "shared-page-reader-and-no-session-getters",
    ],
    [
      "Owner",
      "const { identity, check } = scriptReadSession();",
      "const { identity, check } = scriptReadSession(); function collectEditorPage() { return {}; }",
      "shared-page-reader-and-no-session-getters",
    ],
    [
      "Owner",
      "check();\n      return value;",
      "return value;",
      "shared-page-reader-and-no-session-getters",
    ],
  ];
  for (const [file, before, after, rule] of cases) {
    assert.ok(
      sources[file].includes(before),
      `fixture target exists: ${before}`,
    );
    const fixture = {
      ...sources,
      [file]: sources[file].replace(before, after),
    };
    assert.ok(violations(fixture).includes(rule), `${rule}: ${before}`);
  }
  for (const addition of [
    'import { useEffect } from "react";',
    'import type { WorkspaceClient } from "../client.js";',
    'export { applicationCall } from "../application-transport.js";',
    'const read = import("../application-transport.js");',
    "type Payload = any;",
  ])
    assert.ok(
      violations({
        ...sources,
        Owner: sources.Owner + "\n" + addition,
      }).includes("typed-dependencies-no-ambient-effects"),
      addition,
    );
});
