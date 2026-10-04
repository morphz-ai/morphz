import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import { fixedBuiltinModuleSource } from "./fixtures/builtin-application-integration.js";

// Finite current owner/actual consumers, not whole App/Host hashes, a historical
// inverse chain, arbitrary TS purity/binding theorem or mounted/authority proof.
type Parsed = {
  source: ts.SourceFile;
  nodes: ts.Node[];
  symbols: Map<ts.Node, number | undefined>;
  imports: Map<number, string>;
  aliases: Map<number, number>;
  labels: Map<number, string>;
};
const sources = {
  Owner: readFileSync(
    "apps/web/src/host/builtin-application-adapters.tsx",
    "utf8",
  ),
  Host: readFileSync("apps/web/src/ApplicationHost.tsx", "utf8"),
  App: readFileSync("apps/web/src/App.tsx", "utf8"),
};
function parse(values: Record<string, string>) {
  const root = "/builtin-contract",
    config = root + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      root + "/" + name + ".tsx",
      value,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(values).map((name) => name + ".tsx"),
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) }),
    snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "parse-valid-builtin-counterfactual",
    );
    return Object.fromEntries(
      Object.keys(values).map((name) => {
        const source = project.program.getSourceFile(
            root + "/" + name + ".tsx",
          )!,
          nodes: ts.Node[] = [],
          identifiers: ts.Identifier[] = [];
        function visit(node: ts.Node) {
          nodes.push(node);
          if (ts.isIdentifier(node)) identifiers.push(node);
          node.forEachChild(visit);
        }
        visit(source);
        const resolved = project.checker.getSymbolAtLocation(identifiers),
          symbols = new Map<ts.Node, number | undefined>(
            identifiers.map((n, i) => [n, resolved[i]?.id]),
          );
        nodes
          .filter(ts.isShorthandPropertyAssignment)
          .forEach((n) =>
            symbols.set(
              n.name,
              project.checker.getShorthandAssignmentValueSymbol(n)?.id,
            ),
          );
        const imports = new Map<number, string>(),
          aliases = new Map<number, number>();
        for (const declaration of source.statements.filter(
          ts.isImportDeclaration,
        )) {
          const bindings = declaration.importClause?.namedBindings;
          if (
            !bindings ||
            !ts.isNamedImports(bindings) ||
            declaration.importClause?.phaseModifier ===
              ts.SyntaxKind.TypeKeyword
          )
            continue;
          for (const b of bindings.elements)
            if (!b.isTypeOnly) {
              const key = symbols.get(b.name);
              if (key !== undefined)
                imports.set(
                  key,
                  declaration.moduleSpecifier.getText().slice(1, -1) +
                    ":" +
                    (b.propertyName ?? b.name).text,
                );
            }
        }
        for (const declaration of nodes.filter(ts.isVariableDeclaration))
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            ts.isIdentifier(declaration.initializer) &&
            declaration.parent.flags & ts.NodeFlags.Const
          ) {
            const key = symbols.get(declaration.name),
              from = symbols.get(declaration.initializer);
            if (key !== undefined && from !== undefined) aliases.set(key, from);
          }
        return [
          name,
          {
            source,
            nodes,
            symbols,
            imports,
            aliases,
            labels: new Map(),
          } satisfies Parsed,
        ];
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function one<T>(values: T[], rule: string) {
  assert.equal(values.length, 1, rule);
  return values[0]!;
}
function local(p: Parsed, node: ts.Node) {
  return p.nodes.filter(
    (n) => n.getStart() >= node.getStart() && n.end <= node.end,
  );
}
function id(p: Parsed, node: ts.Node) {
  let result = p.symbols.get(node);
  for (let i = 0; i < 4 && result !== undefined && p.aliases.has(result); i++)
    result = p.aliases.get(result);
  return result;
}
function origin(p: Parsed, node: ts.Node) {
  const key = id(p, node);
  return key === undefined ? undefined : p.imports.get(key);
}
function label(p: Parsed, node: ts.Node, value: string) {
  const key = id(p, node);
  assert.notEqual(key, undefined, "builtin-actual-symbol:" + value);
  p.labels.set(key!, value);
}
function unwrap(n: ts.Node): ts.Node {
  return ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertion(n)
    ? unwrap(n.expression)
    : n;
}
function shape(p: Parsed, n: ts.Node): unknown {
  n = unwrap(n);
  const children: unknown[] = [];
  n.forEachChild((child) => {
    if (
      ("type" in n && child === n.type) ||
      (child.kind >= ts.SyntaxKind.FirstTypeNode &&
        child.kind <= ts.SyntaxKind.LastTypeNode) ||
      child.kind === ts.SyntaxKind.TypeParameter ||
      ((ts.isCallExpression(n) || ts.isNewExpression(n)) &&
        n.typeArguments?.some((t) => t === child))
    )
      return;
    children.push(shape(p, child));
  });
  const key = id(p, n);
  return [
    n.kind,
    ...(ts.isBinaryExpression(n) ? [n.operatorToken.kind] : []),
    ...(ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)
      ? [n.operator]
      : []),
    children.length
      ? children
      : key !== undefined
        ? (p.labels.get(key) ?? p.imports.get(key) ?? n.getText())
        : ts.isStringLiteral(n)
          ? n.text
          : n.getText(),
  ];
}
function functionAt(statements: readonly ts.Statement[], name: string) {
  const fn = one(
    statements
      .filter(ts.isFunctionDeclaration)
      .filter((n) => n.name?.text === name),
    "builtin-function:" + name,
  );
  assert.ok(fn.body);
  return fn;
}
function runtimeImport(declaration: ts.ImportDeclaration) {
  const clause = declaration.importClause;
  if (!clause) return true;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  return (
    !!bindings &&
    (ts.isNamespaceImport(bindings) ||
      bindings.elements.some((element) => !element.isTypeOnly))
  );
}
function object(n: ts.Node, rule: string) {
  n = unwrap(n);
  assert.ok(ts.isObjectLiteralExpression(n), rule);
  return n.properties.map((property) => {
    assert.ok(
      ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property),
      rule,
    );
    return {
      name: property.name.getText(),
      value: ts.isPropertyAssignment(property)
        ? property.initializer
        : property.name,
    };
  });
}
function binding(p: Parsed, body: ts.Block, name: string) {
  return one(
    local(p, body)
      .filter(ts.isVariableDeclaration)
      .filter((n) => ts.isIdentifier(n.name) && n.name.text === name),
    "builtin-binding:" + name,
  );
}
function capture(p: Parsed, pattern: ts.BindingName, rule: string) {
  assert.ok(ts.isObjectBindingPattern(pattern), rule);
  for (const b of pattern.elements) {
    assert.ok(
      ts.isBindingElement(b) &&
        b.name &&
        ts.isIdentifier(b.name) &&
        !b.dotDotDotToken,
      rule,
    );
    label(p, b.name, "port:" + (b.propertyName ?? b.name).getText());
  }
}
function methods(p: Parsed, name: string) {
  const factory = functionAt(p.source.statements, name);
  assert.ok(
    !factory.asteriskToken &&
      !factory.modifiers?.some((n) => n.kind === ts.SyntaxKind.AsyncKeyword),
    "builtin-inert-construction",
  );
  assert.equal(factory.parameters.length, 1, "builtin-captured-ports");
  capture(p, factory.parameters[0]!.name, "builtin-captured-ports");
  const render = functionAt(factory.body!.statements, "renderBuiltin");
  capture(p, render.parameters[0]!.name, "builtin-surface-ports");
  const recent = one(
    factory
      .body!.statements.filter(ts.isVariableStatement)
      .flatMap((n) => [...n.declarationList.declarations])
      .filter(
        (n) => ts.isIdentifier(n.name) && n.name.text === "openRecentContent",
      ),
    "builtin-recent-algorithm",
  );
  assert.ok(
    recent.initializer && ts.isArrowFunction(recent.initializer),
    "builtin-recent-algorithm",
  );
  label(p, render.name!, "method:render");
  label(p, recent.name, "method:recent");
  const returned = one(
    factory.body!.statements.filter(ts.isReturnStatement),
    "builtin-direct-return",
  );
  assert.ok(returned.expression, "builtin-direct-return");
  const fields = object(returned.expression, "builtin-direct-return");
  assert.deepEqual(
    fields.map((n) => n.name),
    ["renderBuiltin", "openRecentContent"],
    "builtin-direct-return",
  );
  assert.equal(
    id(p, fields[0]!.value),
    id(p, render.name!),
    "builtin-direct-return",
  );
  assert.equal(
    id(p, fields[1]!.value),
    id(p, recent.name),
    "builtin-direct-return",
  );
  assert.deepEqual(
    factory.body!.statements.filter(
      (n) => n !== render && n !== recent.parent.parent && n !== returned,
    ),
    [],
    "builtin-inert-construction",
  );
  return { factory, render, recent };
}
const squashed = (n: ts.Node) => n.getText().replace(/\s+/g, "");
function attribute(
  opening: ts.JsxOpeningLikeElement,
  name: string,
  rule: string,
) {
  const a = one(
    opening.attributes.properties
      .filter(ts.isJsxAttribute)
      .filter((n) => n.name.getText() === name),
    rule,
  );
  assert.ok(
    a.initializer &&
      ts.isJsxExpression(a.initializer) &&
      a.initializer.expression,
    rule,
  );
  return a.initializer.expression;
}
function verify(values: typeof sources) {
  const expected = fixedBuiltinModuleSource()
    .replaceAll("'/src/", "'../")
    .replaceAll(".tsx'", ".js'")
    .replaceAll(".ts'", ".js'");
  const parsed = parse({ ...values, Expected: expected }),
    owner = parsed.Owner!,
    old = parsed.Expected!,
    host = parsed.Host!,
    app = parsed.App!;
  const actual = methods(owner, "createBuiltinApplicationAdapters"),
    original = methods(old, "createFixedBuiltinAdapters");
  assert.deepEqual(
    shape(owner, actual.render.body!),
    shape(old, original.render.body!),
    "builtin-complete-render-recipes",
  );
  assert.deepEqual(
    shape(owner, actual.recent.initializer!),
    shape(old, original.recent.initializer!),
    "builtin-recent-algorithm",
  );
  // Canonical recipe leaves retain actual runtime import identities; same-name
  // foreign components are not rescued by an unused correct import.
  const called = local(owner, actual.render).filter(ts.isJsxSelfClosingElement);
  assert.deepEqual(
    called.map((n) => origin(owner, n.tagName)),
    [
      "../BrowserHost.js:BrowserHost",
      "../Reader.js:Reader",
      "../ScriptStudio.js:ScriptStudio",
    ],
    "builtin-component-value-origin",
  );
  const valueImports = owner.source.statements
    .filter(ts.isImportDeclaration)
    .filter(runtimeImport)
    .filter((n) =>
      /\/(ScriptStudio|BrowserHost|Reader)\.js/.test(
        n.moduleSpecifier.getText(),
      ),
    );
  assert.deepEqual(
    valueImports.map((n) => n.moduleSpecifier.getText().slice(1, -1)),
    ["../ScriptStudio.js", "../BrowserHost.js", "../Reader.js"],
    "builtin-runtime-import-phase",
  );

  const hostFn = functionAt(host.source.statements, "ApplicationHost"),
    hostNodes = local(host, hostFn);
  assert.ok(ts.isObjectBindingPattern(hostFn.parameters[0]!.name));
  const hostPorts = hostFn.parameters[0]!.name.elements;
  const getPort = (name: string) => {
    const port = one(
      hostPorts
        .filter(ts.isBindingElement)
        .filter((n) => (n.propertyName ?? n.name)?.getText() === name),
      "builtin-host-port:" + name,
    );
    assert.ok(
      port.name && ts.isIdentifier(port.name),
      "builtin-host-port:" + name,
    );
    return port.name;
  };
  const renderCalls = hostNodes
    .filter(ts.isCallExpression)
    .filter(
      (n) => id(host, n.expression) === id(host, getPort("renderBuiltin")),
    );
  const call = one(renderCalls, "builtin-host-direct-render"),
    fields = object(call.arguments[0]!, "builtin-host-context");
  assert.deepEqual(
    fields.map((n) => n.name),
    [
      "view",
      "instance",
      "workspaceId",
      "selected",
      "activeView",
      "onReturn",
      "returnLabel",
      "fallback",
    ],
    "builtin-host-context",
  );
  for (const [field, expectedText] of [
    ["view", "app.ui.view"],
    ["selected", "active?.id===instance.id"],
    ["activeView", "foreground&&active?.id===instance.id"],
    ["onReturn", "()=>onActivate(null)"],
    ["returnLabel", 'spaceKind(space)==="desk"?"工作台":"项目"'],
  ] as const)
    assert.equal(
      squashed(fields.find((n) => n.name === field)!.value),
      expectedText,
      "builtin-host-context:" + field,
    );
  for (const [field, port] of [
    ["workspaceId", "workspaceId"],
    ["fallback", "children"],
  ])
    assert.equal(
      id(host, fields.find((n) => n.name === field)!.value),
      id(host, getPort(port!)),
      "builtin-host-context:" + field,
    );
  let instanceRegion: ts.Node = call.parent;
  while (!ts.isArrowFunction(instanceRegion) && instanceRegion.parent)
    instanceRegion = instanceRegion.parent;
  assert.ok(
    ts.isArrowFunction(instanceRegion) &&
      instanceRegion.parameters.length === 1 &&
      ts.isIdentifier(instanceRegion.parameters[0]!.name),
    "builtin-host-captured-instance",
  );
  assert.equal(
    id(host, fields.find((n) => n.name === "instance")!.value),
    id(host, instanceRegion.parameters[0]!.name),
    "builtin-host-captured-instance",
  );
  const activity = fields.find((n) => n.name === "activeView")!.value;
  assert.ok(ts.isBinaryExpression(activity), "builtin-host-context:activeView");
  assert.equal(
    id(host, activity.left),
    id(host, getPort("foreground")),
    "builtin-host-context:activeView",
  );
  let parent = call.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  assert.ok(
    ts.isConditionalExpression(parent) && unwrap(parent.whenTrue) === call,
    "builtin-plain-element-no-wrapper",
  );
  const branch = parent;
  assert.equal(
    squashed(branch.condition),
    'app.ui.type==="builtin"',
    "builtin-host-branch",
  );
  const pane = one(
    hostNodes
      .filter(ts.isJsxOpeningElement)
      .filter((n) =>
        n.attributes.properties.some(
          (a) =>
            ts.isJsxAttribute(a) &&
            a.name.getText() === "className" &&
            a.initializer &&
            ts.isStringLiteral(a.initializer) &&
            a.initializer.text === "application-pane",
        ),
      ),
    "builtin-stable-pane",
  );
  assert.equal(
    squashed(attribute(pane, "key", "builtin-stable-pane")),
    "instance.id",
    "builtin-stable-pane",
  );
  assert.equal(
    squashed(attribute(pane, "hidden", "builtin-stable-pane")),
    "active?.id!==instance.id",
    "builtin-stable-pane",
  );
  const sandbox = one(
    hostNodes
      .filter(ts.isJsxSelfClosingElement)
      .filter((n) => n.tagName.getText() === "SandboxApplication"),
    "builtin-sandbox-trust",
  );
  assert.deepEqual(
    sandbox.attributes.properties.map((n) => {
      assert.ok(ts.isJsxAttribute(n), "builtin-sandbox-trust");
      return n.name.getText();
    }),
    [
      "key",
      "client",
      "instance",
      "manifest",
      "active",
      "navigationId",
      "onOpen",
      "onCompose",
      "onNotice",
    ],
    "builtin-sandbox-trust",
  );
  assert.equal(
    id(host, attribute(sandbox, "onCompose", "builtin-sandbox-trust")),
    id(host, getPort("onCompose")),
    "builtin-sandbox-trust",
  );
  assert.ok(
    !host.source.statements
      .filter(ts.isImportDeclaration)
      .some(
        (n) =>
          runtimeImport(n) &&
          /\/(Reader|BrowserHost|ScriptStudio)\.js/.test(
            n.moduleSpecifier.getText(),
          ),
      ),
    "builtin-generic-host-no-specialist-import",
  );

  const workspace = functionAt(app.source.statements, "WorkspaceApp"),
    appNodes = local(app, workspace),
    ctor = one(
      appNodes
        .filter(ts.isCallExpression)
        .filter(
          (n) =>
            origin(app, n.expression) ===
            "./host/builtin-application-adapters.js:createBuiltinApplicationAdapters",
        ),
      "builtin-actual-factory-value",
    );
  assert.ok(
    ts.isVariableDeclaration(ctor.parent),
    "builtin-render-local-factory",
  );
  const bag = ctor.parent.name,
    options = object(ctor.arguments[0]!, "builtin-app-captured-options");
  assert.equal(
    options.filter((n) => n.name === "client").length,
    1,
    "builtin-app-captured-client",
  );
  assert.ok(ts.isObjectBindingPattern(workspace.parameters[0]!.name));
  const clientPort = one(
    workspace.parameters[0]!.name.elements.filter(ts.isBindingElement).filter(
      (n) => (n.propertyName ?? n.name)?.getText() === "client",
    ),
    "builtin-app-captured-client",
  );
  assert.ok(
    clientPort.name && ts.isIdentifier(clientPort.name),
    "builtin-app-captured-client",
  );
  assert.equal(
    id(app, options.find((n) => n.name === "client")!.value),
    id(app, clientPort.name),
    "builtin-app-captured-client",
  );
  const clientId = id(app, clientPort.name);
  assert.ok(
    !appNodes
      .filter((n) => n.getStart() < ctor.getStart())
      .some(
        (n) =>
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          id(app, n.left) === clientId,
      ),
    "builtin-app-captured-client",
  );
  const hostNode = one(
    appNodes
      .filter(ts.isJsxOpeningElement)
      .filter(
        (n) =>
          origin(app, n.tagName) === "./ApplicationHost.js:ApplicationHost",
      ),
    "builtin-actual-host-consumer",
  );
  for (const [prop, method] of [
    ["renderBuiltin", "renderBuiltin"],
    ["onOpenRecent", "openRecentContent"],
  ]) {
    const value = unwrap(
      attribute(hostNode, prop!, "builtin-direct-public-consumer"),
    );
    assert.ok(
      ts.isPropertyAccessExpression(value),
      "builtin-direct-public-consumer",
    );
    assert.equal(
      id(app, value.expression),
      id(app, bag),
      "builtin-direct-public-consumer",
    );
    assert.equal(value.name.text, method, "builtin-direct-public-consumer");
  }
  const compose = binding(app, workspace.body!, "applicationCompose");
  assert.ok(
    compose.initializer && ts.isCallExpression(unwrap(compose.initializer)),
    "builtin-one-compose-writer",
  );
  assert.equal(
    id(app, options.find((n) => n.name === "onCompose")!.value),
    id(app, compose.name),
    "builtin-one-compose-writer",
  );
  assert.equal(
    id(app, attribute(hostNode, "onCompose", "builtin-one-compose-writer")),
    id(app, compose.name),
    "builtin-one-compose-writer",
  );
}
function changed(source: string, before: string, after: string) {
  assert.equal(
    source.split(before).length,
    2,
    "counterfactual unique source target",
  );
  return source.replace(before, after);
}

test("actual builtin adapter recipes, captured ports, stable Host and App consumers", () =>
  verify(sources));
test("finite owner recipe/source counterfactuals reject their specified rules", () => {
  const cases: [string, keyof typeof sources, string, string, RegExp][] = [
    [
      "foreign Reader",
      "Owner",
      'from "../Reader.js"',
      'from "../foreign-reader.js"',
      /builtin-complete-render-recipes/,
    ],
    [
      "unused correct Reader with foreign consumed",
      "Owner",
      "      <Reader\n",
      "      <ForeignReader\n",
      /builtin-complete-render-recipes/,
    ],
    [
      "selected versus foreground",
      "Owner",
      "selected ? onReadingContext : undefined",
      "activeView ? onReadingContext : undefined",
      /builtin-complete-render-recipes/,
    ],
    [
      "fresh CAS revision",
      "Owner",
      "expectedRevision: instance.revision",
      "expectedRevision: client.boot.workspace.revision",
      /builtin-complete-render-recipes/,
    ],
    [
      "Browser lost original state",
      "Owner",
      "state: { ...instance.state, url: page.url }",
      "state: { url: page.url }",
      /builtin-complete-render-recipes/,
    ],
    [
      "Script wrong generation slot",
      "Owner",
      "onCompose(text, undefined, generation)",
      "onCompose(text, generation)",
      /builtin-complete-render-recipes/,
    ],
    [
      "intent changed",
      "Owner",
      'onComposeIntent("script")',
      'onComposeIntent("document")',
      /builtin-complete-render-recipes/,
    ],
    [
      "fallback wrapper",
      "Owner",
      "      fallback\n",
      "      <>{fallback}</>\n",
      /builtin-complete-render-recipes/,
    ],
    [
      "catalog script content ID",
      "Owner",
      "entry.value.appObjectId",
      "entry.value.id",
      /builtin-recent-algorithm/,
    ],
    [
      "recent retarget",
      "Owner",
      "onOpen(entry.value.id)",
      "onOpenScript(entry.value.id)",
      /builtin-recent-algorithm/,
    ],
    [
      "construction IO",
      "Owner",
      "  function renderBuiltin({",
      "  client.refresh();\n  function renderBuiltin({",
      /builtin-inert-construction/,
    ],
    [
      "direct return wrapper",
      "Owner",
      "return { renderBuiltin, openRecentContent };",
      "return { renderBuiltin: s => renderBuiltin(s), openRecentContent };",
      /builtin-direct-return/,
    ],
  ];
  for (const [name, key, before, after, rule] of cases) {
    let value = changed(sources[key], before, after);
    if (name === "unused correct Reader with foreign consumed")
      value +=
        '\nimport {Reader as ForeignReader} from "../foreign-reader.js";\n';
    assert.throws(
      () => verify({ ...sources, [key]: value }),
      { name: "AssertionError", message: rule },
      name,
    );
  }
});
test("finite actual consumer/context/trust counterfactuals reject their specified rules", () => {
  const cases: [string, keyof typeof sources, string, string, RegExp][] = [
    [
      "foreground incorrectly gates context",
      "Host",
      "selected: active?.id === instance.id",
      "selected: foreground && active?.id === instance.id",
      /builtin-host-context:selected/,
    ],
    [
      "foreign instance",
      "Host",
      "                instance,\n                workspaceId,",
      "                instance: latestInstance,\n                workspaceId,",
      /builtin-host-captured-instance/,
    ],
    [
      "missing activity gate",
      "Host",
      "activeView: foreground && active?.id === instance.id",
      "activeView: active?.id === instance.id",
      /builtin-host-context:activeView/,
    ],
    [
      "remount generation key",
      "Host",
      "hidden={active?.id !== instance.id}\n            key={instance.id}",
      "hidden={active?.id !== instance.id}\n            key={instance.id + navigationId}",
      /builtin-stable-pane/,
    ],
    [
      "new trusted generation on sandbox",
      "Host",
      "                  onNotice={onNotice}\n",
      "                  onNotice={onNotice}\n                  scriptGeneration={instance.state}\n",
      /builtin-sandbox-trust/,
    ],
    [
      "public wrapper",
      "App",
      "renderBuiltin={builtinApplications.renderBuiltin}",
      "renderBuiltin={surface => builtinApplications.renderBuiltin(surface)}",
      /builtin-direct-public-consumer/,
    ],
    [
      "different compose writer",
      "App",
      "onCompose={applicationCompose}",
      "onCompose={text => applicationCompose(text)}",
      /builtin-one-compose-writer/,
    ],
    [
      "foreign called factory",
      "App",
      "const builtinApplications = createBuiltinApplicationAdapters({",
      "const builtinApplications = foreignFactory({",
      /builtin-actual-factory-value/,
    ],
    [
      "type-only fake factory",
      "App",
      'import { createBuiltinApplicationAdapters } from "./host/builtin-application-adapters.js";',
      'import { type createBuiltinApplicationAdapters } from "./host/builtin-application-adapters.js";',
      /builtin-actual-factory-value/,
    ],
  ];
  for (const [name, key, before, after, rule] of cases)
    assert.throws(
      () => verify({ ...sources, [key]: changed(sources[key], before, after) }),
      { name: "AssertionError", message: rule },
      name,
    );
});
test("actual import/local aliases, static types and genuinely consumed independent growth remain legal", () => {
  const owner =
    changed(
      sources.Owner,
      "import { Reader, type ReadingCompose }",
      "import { Reader as ActualReader, type ReadingCompose }",
    ).replace("<Reader\n", "<ReaderAlias\n") +
    "\nconst ReaderAlias = ActualReader;\nexport const unrelated = (value: number) => value + 1;\n";
  verify({ ...sources, Owner: owner });
  const host =
    sources.Host +
    "\nfunction FutureSurface(){ const [current,setCurrent]=useState(0); useEffect(()=>{setCurrent(v=>v+1)},[]); return <output>{current}</output>; }\n";
  verify({
    ...sources,
    Host: changed(
      host,
      "      <input\n        ref={upload}",
      "      <FutureSurface />\n      <input\n        ref={upload}",
    ),
  });
  const app =
    changed(
      sources.App,
      'import { createBuiltinApplicationAdapters } from "./host/builtin-application-adapters.js";',
      'import { createBuiltinApplicationAdapters as actualBuiltinFactory } from "./host/builtin-application-adapters.js";',
    ).replace(
      "= createBuiltinApplicationAdapters({",
      "= borrowedBuiltinFactory({",
    ) +
    "\nconst borrowedBuiltinFactory = actualBuiltinFactory;\nexport type FutureBuiltinType = Readonly<{ independent: true }>;\n";
  verify({ ...sources, App: app });
  verify({
    ...sources,
    Owner:
      sources.Owner +
      '\nimport { type Reader as FutureReaderType, type ReadingCompose as FutureReadingCompose } from "../Reader.js";\n',
  });
  verify({
    ...sources,
    Host:
      sources.Host +
      '\nimport { type Reader as FutureReaderType, type ReadingCompose as FutureReadingCompose } from "./Reader.js";\n',
  });
  assert.throws(
    () =>
      verify({
        ...sources,
        Owner:
          sources.Owner +
          '\nimport { type ReadingCompose as FutureReadingCompose, Reader as FutureReaderValue } from "../Reader.js";\n',
      }),
    { name: "AssertionError", message: /builtin-runtime-import-phase/ },
    "mixed named import still evaluates the Reader value in owner phase",
  );
  assert.throws(
    () =>
      verify({
        ...sources,
        Host:
          sources.Host +
          '\nimport { type ReadingCompose as FutureReadingCompose, Reader as FutureReaderValue } from "./Reader.js";\n',
      }),
    {
      name: "AssertionError",
      message: /builtin-generic-host-no-specialist-import/,
    },
    "mixed named import still borrows the Reader runtime into generic Host",
  );
});
