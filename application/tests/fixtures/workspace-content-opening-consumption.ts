import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inversePrivateProjectConversationScope } from "./private-project-conversation-scope-consumption.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type ShorthandPropertyAssignment,
} from "typescript/unstable/ast";

// Only the two explicit content-opening methods and their existing navigation
// seams. This inverse is not a JS evaluator, lifecycle or native UI proof.
export const fixedContentOpeningBaseline = {
  commit: "2cf6a3f294b6d33acdb34dc177e428ab772bb14c",
  app: "b41aa1bd3ed4349dfb589a01981be56f5c48f65fbbe43f09e710e160d873b59c",
  owner: "3648a8f8eef79761f50a57113e3aa88bdcdc5cfd437bcfb978090f3918e9029b",
  openUser: "6ca8996a8a25f548554da5f945ffa6ed51f3c862a4ab66cbc101856210caf827",
  openReading:
    "95361cffed26a0c69c59ef524de590b3ce7f4331655123e3b4e6648a90fe826b",
} as const;
const methods = ["openUser", "openReading"] as const;
const fixedText = readFileSync(
  new URL("./workspace-content-opening-2cf6a3f2.ts", import.meta.url),
  "utf8",
);
const explicitComment =
  "  // Only first-party, explicit user navigation opens a network page. Application\n" +
  "  // bridge requests and restored views do not grant that browser intent.\n";
const capturedComment =
  "  // boot/contentCatalog are the original render Client's ordinary properties,\n" +
  "  // distinct from the continuation's current authorized projection witness.\n";
const originalPick = `type NavigationClient = Pick<
  WorkspaceClient,
  "resolveArtifact" | "resolveScriptLocation" | "execute"
>;`;
const readingImport =
  'import type { ReadingLocation } from "../../../packages/core/src/reader.js";\n';
const existingNames = [
  "travel",
  "openObject",
  "openScriptLocation",
  "launchDockApplication",
  "readingLibrary",
  "openScriptLibrary",
  "openWorkspaceContents",
  "activateApplication",
  "navigate",
  "openBrowser",
  "applicationActions",
];
const returnedNames = [
  ...existingNames.slice(0, 2),
  ...methods,
  ...existingNames.slice(2),
];
const expectedText = `
type NavigationClient = Pick<WorkspaceClient,
  "resolveArtifact" | "resolveScriptLocation" | "execute" |
  "boot" | "contentCatalog" | "resolveCatalogContent">;
const { travel, openObject, openUser, openReading, openScriptLocation,
  launchDockApplication, readingLibrary, openScriptLibrary, activateApplication,
  navigate, openBrowser, applicationActions } = createWorkspaceNavigationCommands({
  owner: navigation, client, workspace: state, surface: workSurface,
  preferences: prefs, prefer,
  shell: { finishCreation: () => setCreating(null), dismissExecutionInspector: () => setExecutions(null) },
  onNotice: setNotice,
  continuation: { isActive: origin.isActive, currentProjection: host.currentProjection,
    captureCommit: host.captureCommit, prefer: continueNavigation,
    writePreferences: host.writePreferences, recordContentVisit: host.recordContentVisit },
  application: { historyVisible, personalDesk: () => personalSpace("desk"),
    readCapturedInstance: (id) => client.boot?.workspace.applicationInstances.find((i) => i.id === id),
    selectAllContent: () => setContentScope("all") }
});
`;
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>) {
  const root = "/workspace-content-opening-consumption";
  const config = root + "/tsconfig.json";
  const paths = Object.fromEntries(
    Object.entries(contents).map(([name, value]) => [
      `${root}/${name}.tsx`,
      value,
    ]),
  );
  paths[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((name) => name + ".tsx"),
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(paths) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal content-opening sources",
    );
    return new Map(
      Object.keys(contents).map((name) => {
        const source = project.program.getSourceFile(`${root}/${name}.tsx`)!;
        const nodes: Node[] = [];
        const identifiers: Identifier[] = [];
        walk(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) identifiers.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(identifiers);
        const symbols = new Map<Node, number | undefined>(
          identifiers.map((node, index) => [node, resolved[index]?.id]),
        );
        for (const node of nodes.filter(isShorthandPropertyAssignment))
          symbols.set(
            node.name,
            project.checker.getShorthandAssignmentValueSymbol(node)?.id,
          );
        return [name, { source, nodes, symbols }] as const;
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
type Parsed = ReturnType<typeof parse> extends Map<string, infer P> ? P : never;
function shape(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child));
  });
  return [
    node.kind,
    node.flags &
      (NodeFlags.Const |
        NodeFlags.Let |
        NodeFlags.Using |
        NodeFlags.OptionalChain),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(),
  ];
}
function fn(parsed: Parsed, name: string): FunctionDeclaration {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "unique content-opening function " + name);
  assert.ok(found[0]!.body);
  return found[0]!;
}
function uniqueReplace(text: string, from: string, to: string, rule: string) {
  assert.equal(text.split(from).length - 1, 1, rule);
  return text.replace(from, to);
}
function same(actual: Node, expected: Node, rule: string) {
  assert.deepEqual(shape(actual), shape(expected), rule);
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function expandWorkspaceContentOpeningConsumption(
  appText: string,
  ownerText: string,
) {
  appText = inversePrivateProjectConversationScope(appText);
  const parsed = parse({
    App: appText,
    Owner: ownerText,
    Fixed: fixedText,
    Expected: expectedText,
  });
  const app = parsed.get("App")!;
  const owner = parsed.get("Owner")!;
  const fixed = parsed.get("Fixed")!;
  const expected = parsed.get("Expected")!;
  const factory = fn(owner, "createWorkspaceNavigationCommands");
  const workspaceApp = fn(app, "WorkspaceApp");
  for (const name of methods) {
    const original = fn(fixed, name);
    assert.equal(
      hash(original.getText()),
      fixedContentOpeningBaseline[name],
      "fixed actual Git complete " + name,
    );
    const candidate = fn(owner, name);
    assert.equal(
      candidate.parent,
      factory.body,
      "content opening belongs to the existing factory",
    );
    const mapped = candidate
      .getText()
      .replaceAll("owner.setExplicitWebsiteIntent", "setWebsiteIntent")
      .replace(/\bcontinuation\b/g, "origin")
      .replace(/\bowner\b/g, "navigation")
      .replace(/\bworkspace\b/g, "state")
      .replace(/\bonNotice\b/g, "setNotice");
    same(
      fn(parse({ Mapped: mapped }).get("Mapped")!, name),
      original,
      "complete original content-opening algorithm " + name,
    );
    assert.equal(
      app.nodes
        .filter(isFunctionDeclaration)
        .filter((node) => node.name?.text === name).length,
      0,
      "no duplicate App content-opening algorithm",
    );
    for (const identifier of owner.nodes
      .filter(isIdentifier)
      .filter(
        (node) =>
          node.getStart() >= candidate.getStart() &&
          node.end <= candidate.end &&
          ["client", "owner", "workspace", "continuation", "onNotice"].includes(
            node.text,
          ),
      )) {
      const parameter = factory.parameters[0]!.name;
      assert.ok(isObjectBindingPattern(parameter));
      const binding = parameter.elements.find(
        (element) =>
          element.name &&
          isIdentifier(element.name) &&
          element.name.text === identifier.text,
      );
      assert.ok(binding?.name && isIdentifier(binding.name));
      assert.notEqual(owner.symbols.get(binding.name), undefined);
      assert.equal(
        owner.symbols.get(identifier),
        owner.symbols.get(binding.name),
        "borrow the original captured navigation port " + identifier.text,
      );
    }
  }
  const pick = owner.source.statements
    .filter(isTypeAliasDeclaration)
    .filter((node) => node.name.text === "NavigationClient");
  assert.equal(pick.length, 1, "single narrow NavigationClient");
  same(
    pick[0]!,
    expected.source.statements[0]!,
    "only three required captured Client fields added to the original Pick",
  );
  assert.deepEqual(
    factory.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "original synchronous navigation constructor",
  );
  assert.equal(
    factory.body!.statements.length,
    29,
    "only two methods added; no constructor reads, effects or latest mirror",
  );
  const openObject = fn(owner, "openObject");
  const openUser = fn(owner, "openUser");
  const openReading = fn(owner, "openReading");
  const launch = fn(owner, "launchDockApplication");
  const statements = [...factory.body!.statements];
  const slot = statements.indexOf(openObject);
  assert.deepEqual(
    statements.slice(slot + 1, slot + 4),
    [openUser, openReading, launch],
    "only the original content-opening slot",
  );
  assert.equal(
    ownerText.slice(openObject.end, openUser.getStart()),
    "\n" + explicitComment + capturedComment + "  ",
    "explicit user and captured-render source comments",
  );
  const returned = statements.at(-1)!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
  );
  assert.deepEqual(
    returned.expression.properties.map((property) => {
      assert.ok(
        isShorthandPropertyAssignment(property) && isIdentifier(property.name),
        "direct shorthand public aliases",
      );
      return property.name.text;
    }),
    returnedNames,
    "two direct public aliases in the original return order",
  );
  for (const name of methods) {
    const property: ShorthandPropertyAssignment | undefined =
      returned.expression.properties
        .filter(isShorthandPropertyAssignment)
        .find((node) => isIdentifier(node.name) && node.name.text === name)!;
    assert.ok(isShorthandPropertyAssignment(property));
    assert.equal(
      owner.symbols.get(property.name),
      owner.symbols.get(fn(owner, name).name!),
      "public return points at its actual content-opening declaration",
    );
  }
  const imports = app.source.statements
    .filter(isImportDeclaration)
    .flatMap((declaration) => {
      if (
        !isStringLiteral(declaration.moduleSpecifier) ||
        declaration.moduleSpecifier.text !==
          "./host/use-workspace-navigation.js"
      )
        return [];
      assert.notEqual(
        declaration.importClause?.phaseModifier,
        SyntaxKind.TypeKeyword,
        "actual runtime navigation import",
      );
      const bindings = declaration.importClause?.namedBindings;
      assert.ok(bindings && isNamedImports(bindings));
      return bindings.elements.filter(
        (element) =>
          (element.propertyName ?? element.name).text ===
          "createWorkspaceNavigationCommands",
      );
    });
  assert.equal(imports.length, 1, "single real navigation factory import");
  assert.equal(
    imports[0]!.isTypeOnly,
    false,
    "runtime factory rather than a type witness",
  );
  const importSymbol = app.symbols.get(imports[0]!.name);
  assert.notEqual(importSymbol, undefined);
  const calls = app.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        app.symbols.get(node.expression) === importSymbol,
    );
  assert.equal(calls.length, 1, "unique actual navigation factory call");
  const call = calls[0]!;
  assert.ok(
    isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      isObjectBindingPattern(call.parent.name),
    "real direct const destructuring, not wrapper or second client",
  );
  const declaration = call.parent;
  assert.ok(
    isVariableStatement(declaration.parent.parent) &&
      declaration.parent.parent.parent === workspaceApp.body,
    "navigation constructor stays in WorkspaceApp render",
  );
  assert.equal(
    declaration.parent.flags & (NodeFlags.Const | NodeFlags.Let),
    NodeFlags.Const,
    "unchanged const navigation aliases",
  );
  const expectedDeclaration = expected.nodes.filter(isVariableDeclaration)[0]!;
  assert.ok(isIdentifier(call.expression));
  const declaredText = declaration.getText();
  const expressionStart = call.expression.getStart() - declaration.getStart();
  const normalizedDeclaration =
    call.expression.text === "createWorkspaceNavigationCommands"
      ? declaration
      : parse({
          Alias:
            "const " +
            declaredText.slice(0, expressionStart) +
            "createWorkspaceNavigationCommands" +
            declaredText.slice(
              expressionStart + call.expression.getText().length,
            ) +
            ";",
        })
          .get("Alias")!
          .nodes.filter(isVariableDeclaration)[0]!;
  same(
    normalizedDeclaration,
    expectedDeclaration,
    "exact original ten captured options and direct App aliases",
  );
  assert.equal(
    workspaceApp.body!.statements.indexOf(declaration.parent.parent) + 1,
    workspaceApp.body!.statements.findIndex(
      (node) =>
        isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (value) =>
            isIdentifier(value.name) && value.name.text === "positions",
        ),
    ),
    "original constructor position before positions ref",
  );
  for (const name of methods) {
    assert.ok(isObjectBindingPattern(declaration.name));
    const binding = declaration.name.elements.find(
      (node) => node.name && isIdentifier(node.name) && node.name.text === name,
    )!;
    assert.ok(
      binding &&
        binding.name &&
        isIdentifier(binding.name) &&
        !binding.propertyName &&
        !binding.initializer,
    );
    const symbol = app.symbols.get(binding.name);
    assert.notEqual(symbol, undefined);
    const uses = app.nodes
      .filter(isIdentifier)
      .filter((node) => node.text === name);
    assert.ok(uses.length > 2, "actual page consumers of " + name);
    assert.ok(
      uses.every((node) => app.symbols.get(node) === symbol),
      "all actual page callbacks bind the captured direct " + name,
    );
  }
  assert.ok(
    !appText.includes(readingImport),
    "App has no residual ReadingLocation import",
  );
  let expandedApp = uniqueReplace(
    appText,
    "    openObject,\n    openUser,\n    openReading,\n",
    "    openObject,\n",
    "single direct App alias seam",
  );
  expandedApp = uniqueReplace(
    expandedApp,
    'import { SearchDocuments } from "./LibraryDialogs.js";\n',
    readingImport + 'import { SearchDocuments } from "./LibraryDialogs.js";\n',
    "original type import position",
  );
  expandedApp = uniqueReplace(
    expandedApp,
    "  function readingTargetConsumed(requestId: string) {",
    explicitComment +
      methods.map((name) => "  " + fn(fixed, name).getText() + "\n").join("") +
      "  function readingTargetConsumed(requestId: string) {",
    "original complete App declaration position",
  );
  let expandedOwner =
    ownerText.slice(0, openObject.end) + ownerText.slice(openReading.end);
  expandedOwner = uniqueReplace(
    expandedOwner,
    pick[0]!.getText(),
    originalPick,
    "original Client Pick seam",
  );
  expandedOwner = uniqueReplace(
    expandedOwner,
    "    openObject,\n    openUser,\n    openReading,\n",
    "    openObject,\n",
    "single direct owner return seam",
  );
  return { app: expandedApp, owner: expandedOwner };
}

// Verify the two current methods and their actual render-local port. This does
// not call any historical inverse or lock the module's unrelated declarations.
export function verifyCurrentWorkspaceContentOpeningConsumption(
  appText: string,
  ownerText: string,
) {
  const parsed = parse({
    App: appText,
    Owner: ownerText,
    Fixed: fixedText,
    Expected: expectedText,
  });
  const app = parsed.get("App")!,
    owner = parsed.get("Owner")!,
    fixed = parsed.get("Fixed")!,
    expected = parsed.get("Expected")!;
  for (const declaration of app.nodes.filter(isVariableDeclaration)) {
    if (
      !isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !isIdentifier(declaration.initializer) ||
      !(declaration.parent.flags & NodeFlags.Const)
    )
      continue;
    const id = app.symbols.get(declaration.name),
      value = app.symbols.get(declaration.initializer);
    if (id === undefined || value === undefined) continue;
    for (const node of app.nodes.filter(isIdentifier))
      if (app.symbols.get(node) === id) app.symbols.set(node, value);
  }
  const factory = fn(owner, "createWorkspaceNavigationCommands"),
    workspaceApp = fn(app, "WorkspaceApp");
  for (const name of methods) {
    const original = fn(fixed, name);
    assert.equal(
      hash(original.getText()),
      fixedContentOpeningBaseline[name],
      "fixed actual Git complete " + name,
    );
    const candidate = fn(owner, name);
    assert.equal(
      candidate.parent,
      factory.body,
      "content opening belongs to the existing factory",
    );
    const mapped = candidate
      .getText()
      .replaceAll("owner.setExplicitWebsiteIntent", "setWebsiteIntent")
      .replace(/\bcontinuation\b/g, "origin")
      .replace(/\bowner\b/g, "navigation")
      .replace(/\bworkspace\b/g, "state")
      .replace(/\bonNotice\b/g, "setNotice");
    same(
      fn(parse({ Mapped: mapped }).get("Mapped")!, name),
      original,
      "complete original content-opening algorithm " + name,
    );
    assert.equal(
      app.nodes
        .filter(isFunctionDeclaration)
        .filter((node) => node.name?.text === name).length,
      0,
      "no duplicate App content-opening algorithm",
    );
    for (const identifier of owner.nodes
      .filter(isIdentifier)
      .filter(
        (node) =>
          node.getStart() >= candidate.getStart() &&
          node.end <= candidate.end &&
          ["client", "owner", "workspace", "continuation", "onNotice"].includes(
            node.text,
          ),
      )) {
      const parameter = factory.parameters[0]!.name;
      assert.ok(isObjectBindingPattern(parameter));
      const binding = parameter.elements.find(
        (element) =>
          element.name &&
          isIdentifier(element.name) &&
          element.name.text === identifier.text,
      );
      assert.ok(binding?.name && isIdentifier(binding.name));
      assert.notEqual(owner.symbols.get(binding.name), undefined);
      assert.equal(
        owner.symbols.get(identifier),
        owner.symbols.get(binding.name),
        "borrow the original captured navigation port " + identifier.text,
      );
    }
  }

  assert.deepEqual(
    factory.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "synchronous current navigation factory",
  );
  assert.equal(
    factory.asteriskToken,
    undefined,
    "non-generator navigation factory",
  );
  const returned = factory.body!.statements.at(-1)!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
  );
  for (const name of methods) {
    const members: ShorthandPropertyAssignment[] =
      returned.expression.properties
        .filter(isShorthandPropertyAssignment)
        .filter((node) => node.name.getText() === name);
    assert.equal(members.length, 1, "direct current return " + name);
    assert.equal(
      owner.symbols.get(members[0]!.name),
      owner.symbols.get(fn(owner, name).name!),
      "actual current method return " + name,
    );
  }
  const imports = app.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        node.moduleSpecifier.getText().slice(1, -1) ===
        "./host/use-workspace-navigation.js",
    )
    .flatMap((node) => {
      assert.notEqual(
        node.importClause?.phaseModifier,
        SyntaxKind.TypeKeyword,
        "runtime navigation import",
      );
      const named = node.importClause?.namedBindings;
      assert.ok(named && isNamedImports(named));
      return named.elements.filter(
        (item) =>
          !item.isTypeOnly &&
          (item.propertyName?.text ?? item.name.text) ===
            "createWorkspaceNavigationCommands",
      );
    });
  assert.equal(imports.length, 1, "single real navigation factory import");
  const symbol = app.symbols.get(imports[0]!.name);
  assert.ok(symbol !== undefined);
  const calls = app.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        app.symbols.get(node.expression) === symbol &&
        node.getStart() > workspaceApp.getStart() &&
        node.end < workspaceApp.end,
    );
  assert.equal(calls.length, 1, "one actual WorkspaceApp factory call");
  const call = calls[0]!;
  assert.ok(
    isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      isObjectBindingPattern(call.parent.name),
  );
  assert.ok(
    isVariableStatement(call.parent.parent.parent) &&
      call.parent.parent.parent.parent === workspaceApp.body,
    "unconditional direct navigation registration",
  );
  assert.equal(
    call.parent.parent.flags & (NodeFlags.Const | NodeFlags.Let),
    NodeFlags.Const,
    "const navigation result",
  );
  const expectedCall = expected.nodes
    .filter(isCallExpression)
    .find(
      (node) =>
        node.expression.getText() === "createWorkspaceNavigationCommands",
    )!;
  same(
    call.arguments[0]!,
    expectedCall.arguments[0]!,
    "original captured ten navigation options",
  );
  assert.equal(call.arguments.length, 1);
  assert.equal(call.typeArguments?.length ?? 0, 0);
  assert.ok(
    call.end <
      app.nodes
        .filter(isVariableDeclaration)
        .find(
          (node) => isIdentifier(node.name) && node.name.text === "positions",
        )!.pos,
    "navigation capture before original positions",
  );
  for (const name of methods) {
    const element = call.parent.name.elements.find(
      (node) => node.name?.getText() === name,
    );
    assert.ok(
      element?.name &&
        isIdentifier(element.name) &&
        !element.propertyName &&
        !element.initializer,
      "direct current App alias " + name,
    );
    const id = app.symbols.get(element.name);
    assert.ok(id !== undefined);
    const uses = app.nodes
      .filter(isIdentifier)
      .filter(
        (node) =>
          node.text === name &&
          node.getStart() > workspaceApp.getStart() &&
          node.end < workspaceApp.end,
      );
    assert.ok(uses.length > 2, "real current consumers " + name);
    for (const use of uses)
      assert.equal(
        app.symbols.get(use),
        id,
        "current captured alias consumer " + name,
      );
  }
}

// Separately named current-only entry. The historical expand and its complete
// module prefix above keep their original APIs/defaults. This does not restore
// App/Private/Human/Object code or constrain unrelated module declarations.
export function verifyRawCurrentWorkspaceContentOpeningConsumption(
  appText: string,
  ownerText: string,
) {
  const owner = parse({ Owner: ownerText }).get("Owner")!;
  const client = owner.nodes
    .filter(isTypeAliasDeclaration)
    .filter((node) => node.name.text === "NavigationClient");
  assert.equal(client.length, 1, "only three required captured Client fields");
  const fields: string[] = [];
  walk(client[0]!.type, (node) => {
    if (isStringLiteral(node)) fields.push(node.text);
  });
  assert.deepEqual(
    fields,
    [
      "resolveArtifact",
      "resolveScriptLocation",
      "execute",
      "boot",
      "contentCatalog",
      "resolveCatalogContent",
    ],
    "only three required captured Client fields",
  );
  const clientImports = owner.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "../client.js",
    )
    .flatMap((node) => {
      const named = node.importClause?.namedBindings;
      if (!named || !isNamedImports(named)) return [];
      return named.elements.filter(
        (entry) =>
          (entry.propertyName?.text ?? entry.name.text) === "WorkspaceClient" &&
          (node.importClause?.phaseModifier === SyntaxKind.TypeKeyword ||
            entry.isTypeOnly),
      );
    });
  const typeReference: Identifier[] = [];
  walk(client[0]!.type, (node) => {
    if (isIdentifier(node) && node.text !== "Pick") typeReference.push(node);
  });
  assert.ok(
    clientImports.length === 1 &&
      typeReference.length === 1 &&
      owner.symbols.get(typeReference[0]!) !== undefined &&
      owner.symbols.get(typeReference[0]!) ===
        owner.symbols.get(clientImports[0]!.name),
    "narrow captured Client type uses its actual type-only source",
  );
  const factory = fn(owner, "createWorkspaceNavigationCommands");
  function noEagerWork(node: Node): boolean {
    // Function bodies execute on explicit invocation, not construction. The
    // original applicationActions object is intentionally a closure recipe.
    if (
      [
        SyntaxKind.FunctionDeclaration,
        SyntaxKind.FunctionExpression,
        SyntaxKind.ArrowFunction,
        SyntaxKind.MethodDeclaration,
      ].includes(node.kind)
    )
      return true;
    if (
      [
        SyntaxKind.CallExpression,
        SyntaxKind.NewExpression,
        SyntaxKind.PropertyAccessExpression,
        SyntaxKind.ElementAccessExpression,
        SyntaxKind.AwaitExpression,
        SyntaxKind.YieldExpression,
        SyntaxKind.ComputedPropertyName,
      ].includes(node.kind)
    )
      return false;
    let valid = true;
    node.forEachChild((child) => {
      valid = noEagerWork(child) && valid;
    });
    return valid;
  }
  for (const statement of factory.body!.statements) {
    if (
      isFunctionDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isReturnStatement(statement)
    )
      continue;
    assert.equal(
      statement.kind,
      SyntaxKind.VariableStatement,
      "only two methods added; no constructor reads",
    );
    const declarations: Node[] = [];
    walk(statement, (node) => {
      if (isVariableDeclaration(node) && node.parent.parent === statement)
        declarations.push(node);
    });
    for (const node of declarations.filter(isVariableDeclaration)) {
      assert.ok(
        node.initializer && noEagerWork(node.initializer),
        "only two methods added; no constructor reads",
      );
    }
  }
  try {
    verifyCurrentWorkspaceContentOpeningConsumption(appText, ownerText);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    const message = error.message.split("\n")[0]!;
    const rule =
      /original captured ten navigation options|direct current App alias/.test(
        message,
      )
        ? "exact original ten captured options and direct App aliases"
        : /one actual WorkspaceApp factory call/.test(message)
          ? "unique actual navigation factory call"
          : /direct current return|actual current method return/.test(message)
            ? "direct shorthand public aliases"
            : message;
    assert.fail(rule);
  }
}
