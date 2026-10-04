import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isBinaryExpression,
  isCallExpression,
  isExpressionStatement,
  isIfStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
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
  isTypeLiteralNode,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// Finite Client/content-family ownership, not all Client scheduling or JS purity.
// Algorithms are restored to six independently pinned Git 84de08bb functions;
// HTTP/SQLite and differential tests cover their actual authority/timing paths.
const sources = {
  Client: readFileSync("apps/web/src/client.ts", "utf8"),
  Owner: readFileSync("apps/web/src/data/content-reads.ts", "utf8"),
  Fixed: readFileSync("tests/fixtures/content-reads-84de08bb.ts", "utf8"),
};
const methods = [
  "listContentPage",
  "countContent",
  "readProjectUnderstanding",
  "rememberContent",
  "resolveArtifact",
  "resolveCatalogContent",
];
const hashes: Record<string, string> = {
  listContentPage:
    "c869eb39a4a742a38f7b1ec3101a41c9ae887c2594751a2f1f77d671c91b5817",
  countContent:
    "1991e2db718b4b8954a6993758e19e71e7b84230e7d744c70b5abece23b4f286",
  readProjectUnderstanding:
    "bd5f7b44a87d034640e3aa97a997b2afee963090d6f5df73374135540df5a1c5",
  rememberContent:
    "134555812efeaea7086c0d365a766917ddc9b96a515195d51375421dc76bccea",
  resolveArtifact:
    "92c800cc733da54f790df91e3a687b97f11757dc29c590e266b81fc70080b522",
  resolveCatalogContent:
    "0d279cdb15a7d2d0bddd7c7ee9365f93b3faf554601a2b7db883e9baf233f97b",
};
// Original borrowed ref initializers/session/clear order; only the new explicit
// publication spelling below is an approved seam, not a candidate-derived hash.
const expectedText = `
const current = useRef<Boot | null>(null), platform = useRef<PlatformClient | null>(null),
  catalogCache = useRef<PlatformNavigationCache | null>(null), protectedReadGeneration = useRef(0);
const ports = {platform,current,protectedReadGeneration,catalogCache,
  publishCatalog: setContentCatalog,
  publishScriptLibrary: (entries) => {
    const latest = current.current;
    if (!latest) return;
    if (latest.scriptLibrary.length === entries.length &&
      latest.scriptLibrary.every((existing, index) => {
        const entry = entries[index]!;
        return existing.id === entry.id && existing.contentId === entry.contentId &&
          existing.projectId === entry.projectId && existing.title === entry.title &&
          existing.updatedAt === entry.updatedAt && existing.catalogRevision === entry.catalogRevision &&
          existing.activityRevision === entry.activityRevision;
      })) return;
    const updated = {...latest, scriptLibrary: entries};
    current.current = updated; setBoot(updated);
  },
  publishArtifact: (updated) => {current.current = updated; setBoot(updated);}, refresh};
function borrow() {const {platform,current,protectedReadGeneration,catalogCache,publishCatalog,publishScriptLibrary,publishArtifact,refresh}=options;}
type ScriptPublication = {publishScriptLibrary: (entries: ScriptLibraryEntry[]) => void};
function scriptPublication() {publishScriptLibrary(cache.value.scriptLibrary);}
function equalReferenceConfirmation() {
  if (existing.appId !== "morphz.script-studio" || existing.kind !== "script" ||
    existing.availability !== "available" ||
    cache.value.headContents.some((item) => item.id === existing.id) ||
    (cache.value.contents.at(-1)?.id === existing.id &&
      cache.value.contents.filter((item) =>
        !cache.value.headContents.some((head) => head.id === item.id)).length <= 150)) {
    publishScriptLibrary(cache.value.scriptLibrary); return;
  }
  entry = existing;
}
function refreshCapture() {const readCatalogCache = catalogCache.current; const readCatalogValue = readCatalogCache?.value;}
function refreshCommit() {
  const finalNavigation = await source.navigationRuntime(signal,requestedScope);
  if (finalNavigation.revisions.access !== navigation.revisions.access) clearProtectedProjection();
  if (!navigationReadStillCurrent(navigation, finalNavigation))
    throw new RequestError(409,"目录在读取期间已更新，请重试。","navigation_changed");
  if (version !== epoch.current || !conversationHistory.isSelectionCurrent(requestedScope)) return false;
  if (readCatalogCache && catalogCache.current === readCatalogCache && readCatalogCache.value !== readCatalogValue) {
    void refresh(); return false;
  }
  const savedProjection = localInputDelivery.confirmAndProject(workspace,source);
}
const selection = {scope: requestedScope, preferences: {...preferences,contentScope}, recentContentIds,
  confirmedScriptContentIds: [...new Set((readCatalogValue?.contents ?? [])
    .filter((entry) => entry.appId === "morphz.script-studio" && entry.kind === "script" &&
      entry.availability === "available" && !readCatalogValue?.headContents.some((head) => head.id === entry.id))
    .map((entry) => entry.id))].slice(0,150)};
function scriptReadSession() {
  const identity = current.current, source = platform.current;
  const generation = protectedReadGeneration.current;
  if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
    throw new Error("身份已变化，剧本未读取。");
  const check = () => {
    if (current.current?.csrfToken !== identity.csrfToken || protectedReadGeneration.current !== generation)
      throw new Error("身份或访问范围已变化，剧本未读取。");
  };
  return {identity,source,check};
}
function protectedClear() {
  protectedReadGeneration.current++; current.current = null; platform.current = null;
  conversationHistory.clear(); catalogCache.current = null;
}
function authClear() {
  protectedReadGeneration.current++; scriptEditorReads.clear(); current.current = null;
  platform.current = null; conversationHistory.clear(); catalogCache.current = null;
}
function publish() {publishArtifact(updated); publishCatalog(contents);}
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
  const root = "/content-reads-boundary",
    config = root + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [
      root + "/" + name + ".ts",
      text,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true },
    files: Object.keys(contents).map((name) => name + ".ts"),
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    // Syntax is checked outside named rules. Invalid counterfactuals are errors,
    // not proof that an ownership rule correctly rejected a legal program.
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "all sources/fixtures first parse",
    );
    return new Map(
      Object.keys(contents).map((name): [string, Parsed] => {
        const source = project.program.getSourceFile(
          root + "/" + name + ".ts",
        )!;
        const nodes: Node[] = [],
          names: Identifier[] = [];
        walk(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) names.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(names);
        const symbols = new Map(
          names.map((node, index) => [node, resolved[index]?.id]),
        );
        // A shorthand's property symbol is not its captured variable/function.
        for (const node of nodes.filter(isShorthandPropertyAssignment)) {
          assert.ok(isIdentifier(node.name));
          symbols.set(
            node.name,
            project.checker.getShorthandAssignmentValueSymbol(node)?.id,
          );
        }
        return [
          name,
          {
            source,
            nodes,
            symbols,
          },
        ];
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function shape(node: Node, normalize = true): unknown {
  if (normalize && isParenthesizedExpression(node))
    return shape(node.expression);
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child, normalize));
  });
  return [
    node.kind,
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    normalize && isStringLiteral(node)
      ? node.text
      : children.length
        ? children
        : node.getText(),
  ];
}
function same(actual: Node | undefined, expected: Node | undefined) {
  assert.ok(actual && expected, "both contract nodes exist");
  assert.deepEqual(shape(actual), shape(expected));
}
function fn(parsed: Parsed, name: string) {
  const matches = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(matches.length, 1, "one " + name);
  assert.ok(matches[0]!.body);
  return matches[0]!;
}
function variable(parsed: Parsed, name: string) {
  const matches = parsed.nodes
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, "one " + name + " binding");
  return matches[0]!;
}
function properties(node: Node | undefined) {
  assert.ok(node && isObjectLiteralExpression(node));
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
function imported(parsed: Parsed, path: string, name: string) {
  const matches: Identifier[] = [];
  for (const node of parsed.nodes.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== path
    )
      continue;
    const clause = node.importClause;
    if (
      !clause ||
      clause.phaseModifier === SyntaxKind.TypeKeyword ||
      !clause.namedBindings ||
      !isNamedImports(clause.namedBindings)
    )
      continue;
    for (const member of clause.namedBindings.elements)
      if (
        !member.isTypeOnly &&
        (member.propertyName ?? member.name).text === name
      )
        matches.push(member.name);
  }
  assert.equal(matches.length, 1, "one actual runtime import " + name);
  const symbol = parsed.symbols.get(matches[0]!);
  assert.notEqual(symbol, undefined);
  assert.equal(
    parsed.nodes
      .filter(isFunctionDeclaration)
      .filter((node) => node.name?.text === matches[0]!.text).length,
    0,
    "no shadow owner",
  );
  assert.equal(
    parsed.nodes
      .filter(isVariableDeclaration)
      .filter(
        (node) =>
          isIdentifier(node.name) && node.name.text === matches[0]!.text,
      ).length,
    0,
    "no shadow owner",
  );
  return symbol;
}
function member(
  parsed: Parsed,
  node: Node | undefined,
  binding: Node,
  name: string,
) {
  assert.ok(
    node && isPropertyAccessExpression(node) && isIdentifier(node.expression),
  );
  assert.equal(node.name.text, name);
  const symbol = parsed.symbols.get(binding);
  assert.notEqual(symbol, undefined);
  assert.equal(
    parsed.symbols.get(node.expression),
    symbol,
    "actual owner binding consumed",
  );
}
const expected = parse({ Expected: expectedText }).get("Expected")!;
function violations(input = sources) {
  const parsed = parse(input),
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
    const symbol = imported(
      client,
      "./data/content-reads.js",
      "createContentReads",
    );
    const calls = client.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          client.symbols.get(node.expression) === symbol,
      );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.arguments.length, 1);
    const binding = variable(client, "contentReads");
    assert.equal(binding.initializer, calls[0]);
    assert.ok(isVariableStatement(binding.parent.parent));
    assert.equal(binding.parent.parent.parent, fn(client, "useWorkspace").body);
    const ports = properties(calls[0]!.arguments[0]),
      original = properties(variable(expected, "ports").initializer);
    assert.deepEqual([...ports.keys()], [...original.keys()]);
    for (const name of [
      "platform",
      "current",
      "protectedReadGeneration",
      "catalogCache",
      "refresh",
    ]) {
      same(ports.get(name), original.get(name));
      const property = ports.get(name)!;
      assert.ok(isShorthandPropertyAssignment(property));
      const declaration =
        name === "refresh"
          ? fn(client, name).name
          : variable(client, name).name;
      assert.ok(declaration);
      assert.notEqual(client.symbols.get(declaration), undefined);
      assert.equal(
        client.symbols.get(property.name),
        client.symbols.get(declaration),
      );
    }
    assert.ok(variable(client, "conversationHistory").pos < binding.pos);
    assert.ok(binding.pos < variable(client, "scriptEditorReads").pos);
  });
  rule("synchronous-publication", () => {
    const call = variable(client, "contentReads").initializer;
    assert.ok(call && isCallExpression(call));
    const ports = properties(call.arguments[0]),
      original = properties(variable(expected, "ports").initializer);
    same(ports.get("publishCatalog"), original.get("publishCatalog"));
    same(ports.get("publishArtifact"), original.get("publishArtifact"));
  });
  rule("authorized-script-publication", () => {
    const call = variable(client, "contentReads").initializer;
    assert.ok(call && isCallExpression(call));
    const ports = properties(call.arguments[0]),
      original = properties(variable(expected, "ports").initializer);
    same(
      ports.get("publishScriptLibrary"),
      original.get("publishScriptLibrary"),
    );
    const type = owner.nodes
      .filter(isTypeAliasDeclaration)
      .find((node) => node.name.text === "ContentReadPorts");
    assert.ok(type && isTypeLiteralNode(type.type));
    const publication = type.type.members
      .filter((node) => node.kind === SyntaxKind.PropertySignature)
      .filter((node) => {
        let name: string | undefined;
        node.forEachChild((child) => {
          if (isIdentifier(child)) name = child.text;
        });
        return name === "publishScriptLibrary";
      });
    const expectedType = expected.nodes
      .filter(isTypeAliasDeclaration)
      .find((node) => node.name.text === "ScriptPublication");
    assert.ok(expectedType && isTypeLiteralNode(expectedType.type));
    assert.equal(publication.length, 1);
    same(publication[0], expectedType.type.members[0]);
    const remember = fn(owner, "rememberContent");
    const equal = remember.body!.statements[4];
    assert.ok(equal && isIfStatement(equal));
    const oldEqual = fn(fixed, "rememberContent").body!.statements[4];
    assert.ok(oldEqual && isIfStatement(oldEqual));
    same(equal.expression, oldEqual.expression);
    assert.equal(equal.thenStatement.kind, SyntaxKind.Block);
    const children: Node[] = [];
    equal.thenStatement.forEachChild((node) => {
      children.push(node);
    });
    assert.equal(children.length, 2);
    assert.deepEqual(
      children.map((node) => shape(node)),
      fn(expected, "equalReferenceConfirmation").body!.statements.map((node) =>
        shape(node),
      ),
    );
    const statements = remember.body!.statements;
    same(
      statements.at(-2),
      fn(expected, "scriptPublication").body!.statements[0],
    );
    same(statements.at(-1), fn(expected, "publish").body!.statements[1]);
    const calls = owner.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          node.expression.text === "publishScriptLibrary",
      );
    assert.equal(calls.length, 2);
  });
  rule("refresh-authorized-catalog-preimage", () => {
    const capture = variable(client, "readCatalogCache"),
      value = variable(client, "readCatalogValue");
    same(capture, variable(expected, "readCatalogCache"));
    same(value, variable(expected, "readCatalogValue"));
    const block = capture.parent.parent.parent;
    assert.equal(block.kind, SyntaxKind.Block);
    const statements: Node[] = [];
    block.forEachChild((node) => {
      statements.push(node);
    });
    const start = statements.indexOf(capture.parent.parent);
    assert.ok(start >= 0);
    assert.equal(statements[start + 1], value.parent.parent);
    assert.ok(
      statements[start + 2]!.getText().includes("await readPlatformWorkspace("),
    );
    const confirm = variable(client, "savedProjection");
    assert.equal(confirm.parent.parent.parent, block);
    const commit = statements.indexOf(confirm.parent.parent);
    assert.ok(commit > start);
    assert.deepEqual(
      statements.slice(commit - 5, commit + 1).map((node) => shape(node)),
      fn(expected, "refreshCommit").body!.statements.map((node) => shape(node)),
    );
    const guards = client.nodes
      .filter(isIfStatement)
      .filter(
        (node) =>
          JSON.stringify(shape(node.expression)) ===
          JSON.stringify(
            shape(
              (
                fn(expected, "refreshCommit").body!
                  .statements[3] as import("typescript/unstable/ast").IfStatement
              ).expression,
            ),
          ),
      );
    assert.equal(
      guards.length,
      1,
      "one original epoch/selection guard, before confirmation",
    );
  });
  rule("confirmed-script-reference-selection", () => {
    const calls = client.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          node.expression.text === "readPlatformWorkspace",
      );
    assert.equal(calls.length, 1);
    same(calls[0]!.arguments[6], variable(expected, "selection").initializer);
  });
  rule("direct-public-and-editor-references", () => {
    const declaration = variable(client, "contentReads");
    const returns = fn(client, "useWorkspace").body!.statements.filter(
      isReturnStatement,
    );
    assert.equal(returns.length, 1);
    const exports = properties(returns[0]!.expression);
    for (const name of methods.filter((name) => name !== "rememberContent")) {
      const property = exports.get(name);
      assert.ok(property && isPropertyAssignment(property));
      member(client, property.initializer, declaration.name, name);
      assert.equal(
        client.nodes
          .filter(isFunctionDeclaration)
          .filter((node) => node.name?.text === name).length,
        0,
        "no copied Client algorithm",
      );
    }
    const remember = variable(client, "rememberContent");
    member(client, remember.initializer, declaration.name, "rememberContent");
    assert.equal(
      client.nodes
        .filter(isFunctionDeclaration)
        .filter((node) => node.name?.text === "rememberContent").length,
      0,
    );
    const editor = variable(client, "scriptEditorReads").initializer;
    assert.ok(editor && isCallExpression(editor));
    const port = properties(editor.arguments[0]).get("rememberContent");
    assert.ok(port && isShorthandPropertyAssignment(port));
    assert.equal(
      client.symbols.get(port.name),
      client.symbols.get(remember.name),
    );
  });
  rule("client-authority-and-clears", () => {
    const refSymbol = imported(client, "react", "useRef");
    const variables = [
      "current",
      "platform",
      "catalogCache",
      "protectedReadGeneration",
    ].map((name) => variable(client, name));
    variables.forEach((node, index) => {
      same(
        node,
        variable(
          expected,
          ["current", "platform", "catalogCache", "protectedReadGeneration"][
            index
          ]!,
        ),
      );
      assert.ok(node.initializer && isCallExpression(node.initializer));
      assert.equal(client.symbols.get(node.initializer.expression), refSymbol);
      assert.ok(node.pos < variable(client, "contentReads").pos);
      if (index) assert.ok(variables[index - 1]!.pos < node.pos);
    });
    same(fn(client, "scriptReadSession"), fn(expected, "scriptReadSession"));
    const protectedStatements = fn(client, "clearProtectedProjection").body!
      .statements;
    assert.deepEqual(
      protectedStatements.slice(0, 5).map((node) => shape(node)),
      fn(expected, "protectedClear").body!.statements.map((node) =>
        shape(node),
      ),
    );
    for (const name of ["login", "logout"]) {
      const statements = fn(client, name).body!.statements;
      const index = statements.findIndex(
        (node) =>
          JSON.stringify(shape(node)) ===
          JSON.stringify(shape(fn(expected, "authClear").body!.statements[0]!)),
      );
      assert.ok(index >= 0);
      assert.deepEqual(
        statements.slice(index, index + 6).map((node) => shape(node)),
        fn(expected, "authClear").body!.statements.map((node) => shape(node)),
      );
    }
  });
  rule("inert-owner-and-finite-dependencies", () => {
    const allowed = new Map([
      ["../../../../packages/core/src/model.js", []],
      ["../platform-client.js", []],
      [
        "../platform-workspace-view.js",
        [
          "readContentArtifact",
          "readTaskArtifact",
          "scriptLibraryEntryFromContent",
        ],
      ],
      ["../application-transport.js", ["RequestError"]],
    ]);
    const runtime: string[] = [];
    for (const node of owner.source.statements) {
      if (isImportDeclaration(node)) {
        assert.ok(isStringLiteral(node.moduleSpecifier));
        const path = node.moduleSpecifier.text;
        assert.ok(allowed.has(path));
        const clause = node.importClause;
        assert.ok(clause);
        if (clause.phaseModifier === SyntaxKind.TypeKeyword) continue;
        assert.ok(
          !clause.name &&
            clause.namedBindings &&
            isNamedImports(clause.namedBindings),
        );
        for (const specifier of clause.namedBindings.elements)
          if (!specifier.isTypeOnly) {
            const name = (specifier.propertyName ?? specifier.name).text;
            assert.ok(allowed.get(path)!.includes(name));
            assert.equal(specifier.name.text, name, "original helper binding");
            runtime.push(path + ":" + name);
          }
      } else
        assert.ok(isTypeAliasDeclaration(node) || isFunctionDeclaration(node));
    }
    assert.deepEqual(
      runtime.sort(),
      [...allowed]
        .flatMap(([path, names]) => names.map((name) => path + ":" + name))
        .sort(),
    );
    const factory = fn(owner, "createContentReads"),
      body = factory.body!;
    assert.equal(
      owner.nodes.filter(isFunctionDeclaration).length,
      7,
      "no additional authority/helper algorithms",
    );
    assert.equal(body.statements.length, 8);
    same(body.statements[0], fn(expected, "borrow").body!.statements[0]);
    assert.deepEqual(
      body.statements.slice(1, 7).map((node) => {
        assert.ok(isFunctionDeclaration(node));
        return node.name?.text;
      }),
      methods,
    );
    const returned = body.statements[7];
    assert.ok(returned && isReturnStatement(returned));
    const exports = properties(returned.expression);
    assert.deepEqual([...exports.keys()], methods);
    for (const name of methods) {
      const port = exports.get(name)!;
      assert.ok(isShorthandPropertyAssignment(port));
      assert.equal(
        owner.symbols.get(port.name),
        owner.symbols.get(fn(owner, name).name!),
      );
    }
  });
  rule("six-fixed-algorithms", () => {
    const replacements: { start: number; end: number; text: string }[] = [];
    const remember = fn(owner, "rememberContent"),
      equal = remember.body!.statements[4],
      oldEqual = fn(fixed, "rememberContent").body!.statements[4];
    assert.ok(
      equal && isIfStatement(equal) && oldEqual && isIfStatement(oldEqual),
    );
    same(equal.expression, oldEqual.expression);
    assert.equal(equal.thenStatement.kind, SyntaxKind.Block);
    const equalStatements: Node[] = [];
    equal.thenStatement.forEachChild((node) => {
      equalStatements.push(node);
    });
    assert.equal(equalStatements.length, 2);
    assert.deepEqual(
      equalStatements.map((node) => shape(node)),
      fn(expected, "equalReferenceConfirmation").body!.statements.map((node) =>
        shape(node),
      ),
    );
    replacements.push({
      start: equal.getStart(),
      end: equal.end,
      text: oldEqual.getText(),
    });
    const scriptPublication = remember.body!.statements.at(-2);
    same(
      scriptPublication,
      fn(expected, "scriptPublication").body!.statements[0],
    );
    replacements.push({
      start: scriptPublication!.getStart(),
      end: scriptPublication!.end,
      text: "",
    });
    for (const node of owner.nodes.filter(isExpressionStatement)) {
      const call = node.expression;
      if (!isCallExpression(call) || !isIdentifier(call.expression)) continue;
      if (call.expression.text === "publishArtifact") {
        same(node, fn(expected, "publish").body!.statements[0]);
        replacements.push({
          start: node.getStart(),
          end: node.end,
          text: "current.current = updated; setBoot(updated);",
        });
      } else if (call.expression.text === "publishCatalog") {
        same(node, fn(expected, "publish").body!.statements[1]);
        replacements.push({
          start: node.getStart(),
          end: node.end,
          text: "setContentCatalog(contents);",
        });
      }
    }
    assert.equal(
      replacements.filter((item) => item.text.startsWith("current.")).length,
      3,
    );
    assert.equal(
      replacements.filter((item) => item.text.startsWith("setContentCatalog"))
        .length,
      1,
    );
    let restored = input.Owner;
    for (const edit of replacements.sort((a, b) => b.start - a.start))
      restored =
        restored.slice(0, edit.start) + edit.text + restored.slice(edit.end);
    const normalizedFixed = input.Fixed.replace(
      'import("../../apps/web/src/platform-client.js").PlatformContent',
      "PlatformContent",
    );
    const pair = parse({ Restored: restored, Old: normalizedFixed });
    for (const name of methods) {
      assert.equal(
        createHash("sha256")
          .update(JSON.stringify(shape(fn(fixed, name), false)))
          .digest("hex"),
        hashes[name],
        "independent fixed Git function " + name,
      );
      same(fn(pair.get("Restored")!, name), fn(pair.get("Old")!, name));
    }
  });
  return failures;
}
test("actual Client consumes the single inert content owner and exact original algorithms", () => {
  assert.deepEqual(violations(), []);
});
test("formatting, parentheses and a genuine imported alias remain legal", () => {
  const input = {
    ...sources,
    Client: sources.Client.replace(
      "import { createContentReads }",
      "import { createContentReads as makeContentReads }",
    ).replace("= createContentReads({", "= makeContentReads({"),
    Owner: sources.Owner.replaceAll(
      "publishArtifact(updated);",
      "publishArtifact(\n(updated)\n);",
    ),
  };
  assert.deepEqual(violations(input), []);
});
type Counterfactual = [keyof typeof sources, string, string, string];
const negatives: Counterfactual[] = [
  [
    "Client",
    "./data/content-reads.js",
    "./data/not-content-reads.js",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const contentReads = createContentReads({",
    "const createContentReads = (ports: unknown) => ports; const contentReads = createContentReads({",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const contentReads = createContentReads({",
    "const contentReads = fakeContentReads({",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "const contentReads = createContentReads({",
    "const duplicate = createContentReads({}); const contentReads = createContentReads({",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "    catalogCache,\n    publishCatalog:",
    "    catalogCache: useRef(catalogCache.current),\n    publishCatalog:",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "    refresh,\n  });\n  const rememberContent",
    "    refresh: () => refresh(),\n  });\n  const rememberContent",
    "actual-owner-and-borrowed-ports",
  ],
  [
    "Client",
    "publishCatalog: setContentCatalog",
    "publishCatalog: entries => setContentCatalog(entries)",
    "synchronous-publication",
  ],
  [
    "Client",
    "publishArtifact: (updated) =>",
    "publishArtifact: async (updated) =>",
    "synchronous-publication",
  ],
  [
    "Client",
    "    publishArtifact: (updated) => {\n      current.current = updated;\n      setBoot(updated);",
    "    publishArtifact: (updated) => {\n      setBoot(updated);\n      current.current = updated;",
    "synchronous-publication",
  ],
  [
    "Client",
    "const rememberContent = contentReads.rememberContent;",
    "const rememberContent = (...args: unknown[]) => contentReads.rememberContent(...args);",
    "direct-public-and-editor-references",
  ],
  [
    "Client",
    "    rememberContent,\n  });",
    "    rememberContent: (entry, identity) => rememberContent(entry, identity),\n  });",
    "direct-public-and-editor-references",
  ],
  [
    "Client",
    "resolveArtifact: contentReads.resolveArtifact",
    "resolveArtifact: (...args) => contentReads.resolveArtifact(...args)",
    "direct-public-and-editor-references",
  ],
  [
    "Client",
    "countContent: contentReads.countContent",
    "countContent: contentReads.listContentPage",
    "direct-public-and-editor-references",
  ],
  [
    "Client",
    "catalogCache = useRef<PlatformNavigationCache | null>(null)",
    "catalogCache = useRef<PlatformNavigationCache | null>(new Map())",
    "client-authority-and-clears",
  ],
  [
    "Client",
    "    conversationHistory.clear();\n    catalogCache.current = null;",
    "    conversationHistory.clear();",
    "client-authority-and-clears",
  ],
  [
    "Client",
    "    protectedReadGeneration.current++;\n    scriptEditorReads.clear();",
    "    scriptEditorReads.clear();\n    protectedReadGeneration.current++;",
    "client-authority-and-clears",
  ],
  [
    "Client",
    "if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)",
    "if (~identity || !source || source.boot.csrfToken !== identity.csrfToken)",
    "client-authority-and-clears",
  ],
  [
    "Client",
    'import { useEffect, useRef, useState } from "react";',
    'import { useEffect, useRef as actualRef, useState } from "react"; function useRef(value: unknown) { return {current: value}; }',
    "client-authority-and-clears",
  ],
  [
    "Owner",
    "import { RequestError }",
    "import { RequestError as WrongError }",
    "inert-owner-and-finite-dependencies",
  ],
  [
    "Owner",
    "import type {\n  PlatformClient,\n  PlatformContent,\n  ScriptLibraryEntry,\n}",
    "import {\n  PlatformClient,\n  type PlatformContent,\n  type ScriptLibraryEntry,\n}",
    "inert-owner-and-finite-dependencies",
  ],
  [
    "Owner",
    "  async function listContentPage(",
    "  const mirror = new Map();\n  async function listContentPage(",
    "inert-owner-and-finite-dependencies",
  ],
  [
    "Owner",
    "  async function listContentPage(",
    "  refresh();\n  async function listContentPage(",
    "inert-owner-and-finite-dependencies",
  ],
  [
    "Owner",
    "import type {\n  Artifact,",
    'import "react";\nimport type {\n  Artifact,',
    "inert-owner-and-finite-dependencies",
  ],
  ["Owner", ".slice(-149)", ".slice(-150)", "six-fixed-algorithms"],
  ["Owner", "if (!source)", "if (~source)", "six-fixed-algorithms"],
  [
    "Owner",
    "    return source.content(options, signal);",
    "    if (!current.current) throw new Error('new guard'); return source.content(options, signal);",
    "six-fixed-algorithms",
  ],
  [
    "Owner",
    "      if (error instanceof RequestError && error.status === 404) return null;",
    "      if (error instanceof RequestError && error.status === 404) { if (protectedReadGeneration.current !== readGeneration) throw error; return null; }",
    "six-fixed-algorithms",
  ],
  [
    "Owner",
    "        publishArtifact(updated);",
    "        await publishArtifact(updated);",
    "six-fixed-algorithms",
  ],
  [
    "Owner",
    "if (!headIds.has(entry.id)) references.push(entry);",
    "if (!headIds.has(entry.id)) references.unshift(entry);",
    "six-fixed-algorithms",
  ],
  ["Fixed", ".slice(-149)", ".slice(-150)", "six-fixed-algorithms"],
  [
    "Client",
    "publishScriptLibrary: (entries) =>",
    "publishScriptLibrary: async (entries) =>",
    "authorized-script-publication",
  ],
  [
    "Client",
    "existing.activityRevision === entry.activityRevision",
    "existing.activityRevision >= entry.activityRevision",
    "authorized-script-publication",
  ],
  [
    "Client",
    "existing.catalogRevision === entry.catalogRevision",
    "existing.catalogRevision >= entry.catalogRevision",
    "authorized-script-publication",
  ],
  [
    "Client",
    "const entry = entries[index]!;",
    "const entry = entries[0]!;",
    "authorized-script-publication",
  ],
  [
    "Client",
    "const updated = { ...latest, scriptLibrary: entries };",
    "const updated = { ...latest, scriptLibrary: [...entries] };",
    "authorized-script-publication",
  ],
  [
    "Owner",
    "publishScriptLibrary: (entries: ScriptLibraryEntry[]) => void",
    "publishScriptLibrary?: (entries: ScriptLibraryEntry[]) => void",
    "authorized-script-publication",
  ],
  [
    "Owner",
    "publishScriptLibrary(cache.value.scriptLibrary);",
    "publishScriptLibrary([scriptLibraryEntryFromContent(entry)]);",
    "authorized-script-publication",
  ],
  [
    "Owner",
    "    publishScriptLibrary(cache.value.scriptLibrary);\n    publishCatalog(contents);",
    "    publishCatalog(contents);\n    publishScriptLibrary(cache.value.scriptLibrary);",
    "authorized-script-publication",
  ],
  [
    "Client",
    "const readCatalogValue = readCatalogCache?.value;",
    "const readCatalogValue = structuredClone(readCatalogCache?.value);",
    "refresh-authorized-catalog-preimage",
  ],
  [
    "Client",
    "catalogCache.current === readCatalogCache",
    "catalogCache.current !== readCatalogCache",
    "refresh-authorized-catalog-preimage",
  ],
  [
    "Client",
    "readCatalogCache.value !== readCatalogValue",
    "readCatalogCache.value === readCatalogValue",
    "refresh-authorized-catalog-preimage",
  ],
  [
    "Client",
    "          void refresh();\n          return false;",
    "          await refresh();\n          return false;",
    "refresh-authorized-catalog-preimage",
  ],
  [
    "Client",
    "].slice(0, 150)",
    "].slice(0, 151)",
    "confirmed-script-reference-selection",
  ],
  [
    "Client",
    "!readCatalogValue?.headContents.some(",
    "readCatalogValue?.headContents.some(",
    "confirmed-script-reference-selection",
  ],
  [
    "Client",
    "(readCatalogValue?.contents ?? [])",
    "(catalogCache.current?.value.contents ?? [])",
    "confirmed-script-reference-selection",
  ],
  [
    "Client",
    'entry.availability === "available" &&',
    'entry.availability !== "available" &&',
    "confirmed-script-reference-selection",
  ],
  [
    "Owner",
    'existing.appId !== "morphz.script-studio"',
    'existing.appId === "morphz.script-studio"',
    "authorized-script-publication",
  ],
  [
    "Owner",
    'existing.kind !== "script"',
    'existing.kind === "script"',
    "authorized-script-publication",
  ],
  [
    "Owner",
    'existing.availability !== "available"',
    'existing.availability === "available"',
    "authorized-script-publication",
  ],
  [
    "Owner",
    "cache.value.headContents.some((item) => item.id === existing.id)",
    "!cache.value.headContents.some((item) => item.id === existing.id)",
    "authorized-script-publication",
  ],
  [
    "Owner",
    "cache.value.contents.at(-1)?.id === existing.id",
    "cache.value.contents.at(-1)?.id !== existing.id",
    "authorized-script-publication",
  ],
  [
    "Owner",
    "entry = existing;",
    "entry = { ...entry };",
    "authorized-script-publication",
  ],
  [
    "Owner",
    ").length <= 150)",
    ").length <= 151)",
    "authorized-script-publication",
  ],
  [
    "Owner",
    "!cache.value.headContents.some((head) => head.id === item.id)",
    'item.kind === "script" && !cache.value.headContents.some((head) => head.id === item.id)',
    "authorized-script-publication",
  ],
];
test("legal counterfactuals fail their designated finite rule, not parser/runtime accidents", () => {
  for (const [file, from, to, rule] of negatives) {
    assert.ok(sources[file].includes(from), "fixture target exists: " + from);
    const input = { ...sources, [file]: sources[file].replace(from, to) };
    parse(input);
    assert.ok(
      violations(input).includes(rule),
      file + " must fail " + rule + ": " + from,
    );
  }
});
