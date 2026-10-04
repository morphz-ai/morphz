import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import { fixedApplicationComposeSource } from "./fixtures/application-compose-7c1aea5a.js";

// Finite current constructor/borrowed values/three complete
// recipes and actual consumers; not whole-page hashes or a peer inverse chain.
// Controlled AST symbols do not prove arbitrary TS purity/Runtime authority.
type Sources = { App: string; Owner: string };
type Parsed = {
  source: ts.SourceFile;
  nodes: ts.Node[];
  symbols: Map<ts.Node, number | undefined>;
  imports: Map<number, string>;
  aliases: Map<number, number>;
  labels: Map<number, string>;
};
const sources: Sources = {
  App: readFileSync("apps/web/src/App.tsx", "utf8"),
  Owner: readFileSync(
    "apps/web/src/host/application-compose-preparation.ts",
    "utf8",
  ),
};
const renderPorts = [
  "state",
  "project",
  "draft",
  "contextKey",
  "conversationId",
  "defaultConversation",
  "sending",
  "emptyDraft",
] as const;
const otherPorts = [
  "client",
  "setDraft",
  "writeDrafts",
  "flushSync",
  "currentContext",
  "dictationControls",
  "prefer",
  "showInput",
] as const;
const factoryOrigin =
  "./host/application-compose-preparation.js:createApplicationComposePreparation";
const helperOrigin = "../composer-drafts.js:composeArtifactDrafts";
const oldSource =
  'import { composeArtifactDrafts } from "../composer-drafts.js";\n' +
  [...renderPorts, ...otherPorts]
    .map((name) => `declare const ${name}: any;`)
    .join("\n") +
  "\n" +
  fixedApplicationComposeSource.declaration;

function one<T>(values: readonly T[], rule: string): T {
  assert.equal(values.length, 1, rule);
  return values[0]!;
}
function unwrap(node: ts.Node): ts.Node {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node)
    ? unwrap(node.expression)
    : node;
}
function parse(values: Record<string, string>): Record<string, Parsed> {
  const root = "/compose-preparation-contract",
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
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "parse-valid-compose-counterfactual",
    );
    return Object.fromEntries(
      Object.keys(values).map((name) => {
        const source = project.program.getSourceFile(
          root + "/" + name + ".tsx",
        )!;
        const nodes: ts.Node[] = [],
          identifiers: ts.Identifier[] = [];
        function visit(node: ts.Node): void {
          nodes.push(node);
          if (ts.isIdentifier(node)) identifiers.push(node);
          node.forEachChild((child) => {
            visit(child);
          });
        }
        visit(source);
        const resolved = project.checker.getSymbolAtLocation(identifiers);
        const symbols = new Map<ts.Node, number | undefined>(
          identifiers.map((node, i) => [node, resolved[i]?.id]),
        );
        nodes.filter(ts.isShorthandPropertyAssignment).forEach((node) => {
          symbols.set(
            node.name,
            project.checker.getShorthandAssignmentValueSymbol(node)?.id,
          );
        });
        const imports = new Map<number, string>(),
          aliases = new Map<number, number>();
        for (const declaration of source.statements.filter(
          ts.isImportDeclaration,
        )) {
          const clause = declaration.importClause,
            bindings = clause?.namedBindings;
          if (
            clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            !bindings ||
            !ts.isNamedImports(bindings)
          )
            continue;
          for (const binding of bindings.elements) {
            const key = symbols.get(binding.name);
            if (!binding.isTypeOnly && key !== undefined)
              imports.set(
                key,
                declaration.moduleSpecifier.getText().slice(1, -1) +
                  ":" +
                  (binding.propertyName ?? binding.name).text,
              );
          }
        }
        for (const declaration of nodes.filter(ts.isVariableDeclaration)) {
          if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !ts.isIdentifier(declaration.initializer) ||
            !(declaration.parent.flags & ts.NodeFlags.Const)
          )
            continue;
          const target = symbols.get(declaration.name),
            from = symbols.get(declaration.initializer);
          if (target !== undefined && from !== undefined)
            aliases.set(target, from);
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
function id(parsed: Parsed, node: ts.Node): number | undefined {
  let result = parsed.symbols.get(unwrap(node));
  const seen = new Set<number>();
  while (result !== undefined && parsed.aliases.has(result)) {
    assert.equal(seen.has(result), false, "compose-finite-alias-cycle");
    seen.add(result);
    result = parsed.aliases.get(result);
  }
  return result;
}
function origin(parsed: Parsed, node: ts.Node) {
  const key = id(parsed, node);
  return key === undefined ? undefined : parsed.imports.get(key);
}
function sameValue(
  parsed: Parsed,
  actual: ts.Node,
  expected: ts.Node,
  rule: string,
) {
  assert.ok(ts.isIdentifier(unwrap(actual)), rule);
  const actualId = id(parsed, actual),
    expectedId = id(parsed, expected);
  assert.notEqual(expectedId, undefined, rule);
  assert.equal(actualId, expectedId, rule);
}
function label(parsed: Parsed, node: ts.Node, name: string) {
  const key = id(parsed, node);
  assert.notEqual(key, undefined, "compose-owned-symbol:" + name);
  parsed.labels.set(key!, name);
}
function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => {
    if (!ts.isBindingElement(element)) return [];
    const binding = element.name;
    assert.ok(binding, "compose-binding-name");
    return bindingNames(binding);
  });
}
function directDeclarations(
  statements: readonly ts.Statement[],
): ts.VariableDeclaration[] {
  return statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
}
function actualBinding(
  parsed: Parsed,
  workspace: ts.FunctionDeclaration,
  name: string,
): ts.Identifier {
  const identifiers = [
    ...workspace.parameters.flatMap((parameter) =>
      bindingNames(parameter.name),
    ),
    ...directDeclarations(workspace.body!.statements).flatMap((declaration) =>
      bindingNames(declaration.name),
    ),
    ...workspace
      .body!.statements.filter(ts.isFunctionDeclaration)
      .flatMap((fn) => (fn.name ? [fn.name] : [])),
    ...directDeclarations(parsed.source.statements).flatMap((declaration) =>
      bindingNames(declaration.name),
    ),
  ];
  return one(
    identifiers.filter((node) => node.text === name),
    "compose-original-binding:" + name,
  );
}
function namedFunction(parsed: Parsed, name: string) {
  const fn = one(
    parsed.source.statements
      .filter(ts.isFunctionDeclaration)
      .filter((node) => node.name?.text === name),
    "compose-owned-function:" + name,
  );
  assert.ok(fn.body, "compose-owned-function:" + name);
  return fn;
}
function declarationAt(
  statements: readonly ts.Statement[],
  name: string,
  rule: string,
) {
  return one(
    directDeclarations(statements).filter(
      (node) => ts.isIdentifier(node.name) && node.name.text === name,
    ),
    rule,
  );
}
function object(node: ts.Node, rule: string): Map<string, ts.Node> {
  node = unwrap(node);
  assert.ok(ts.isObjectLiteralExpression(node), rule);
  const entries = node.properties.map((property) => {
    assert.ok(
      ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property),
      rule,
    );
    assert.ok(ts.isIdentifier(property.name), rule);
    return [
      property.name.text,
      ts.isPropertyAssignment(property) ? property.initializer : property.name,
    ] as const;
  });
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, rule);
  return new Map(entries);
}
function pattern(
  node: ts.BindingName,
  rule: string,
): Map<string, ts.BindingName> {
  assert.ok(ts.isObjectBindingPattern(node), rule);
  const entries = node.elements.map((element) => {
    assert.equal(element.dotDotDotToken, undefined, rule);
    assert.equal(element.initializer, undefined, rule);
    const binding = element.name;
    assert.ok(binding, rule);
    const key = element.propertyName ?? binding;
    assert.ok(ts.isIdentifier(key), rule);
    return [key.text, binding] as const;
  });
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, rule);
  return new Map(entries);
}
function shape(parsed: Parsed, node: ts.Node): unknown {
  node = unwrap(node);
  const children: unknown[] = [];
  node.forEachChild((child) => {
    if (
      ("type" in node && child === node.type) ||
      (child.kind >= ts.SyntaxKind.FirstTypeNode &&
        child.kind <= ts.SyntaxKind.LastTypeNode) ||
      child.kind === ts.SyntaxKind.TypeParameter ||
      ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        node.typeArguments?.some((type) => type === child))
    )
      return;
    children.push(shape(parsed, child));
  });
  const key = id(parsed, node);
  // A property name is a runtime field spelling, not a lexical free/bound
  // variable. The fixed ports are declared any while current ports are typed;
  // inferred property symbols must not turn that static difference into drift.
  const propertyName =
    ts.isIdentifier(node) &&
    ((ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name === node) ||
      (ts.isPropertyAssignment(node.parent) && node.parent.name === node));
  const leaf = propertyName
    ? "property:" + node.getText()
    : key === undefined
      ? "free:" + node.getText()
      : (parsed.labels.get(key) ??
        parsed.imports.get(key) ??
        "local:" + node.getText());
  return [
    node.kind,
    ...(ts.isVariableDeclarationList(node)
      ? [node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)]
      : []),
    ...(ts.isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(ts.isCallExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
      ? [node.questionDotToken?.kind ?? null]
      : []),
    children.length ? children : ts.isStringLiteral(node) ? node.text : leaf,
  ];
}
function isAsync(node: ts.FunctionDeclaration | ts.ArrowFunction) {
  return (
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ?? false
  );
}
function local(parsed: Parsed, node: ts.Node) {
  return parsed.nodes.filter(
    (child) => child.getStart() >= node.getStart() && child.end <= node.end,
  );
}
function jsxValue(attribute: ts.JsxAttribute, rule: string) {
  assert.ok(
    attribute.initializer &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression,
    rule,
  );
  return attribute.initializer.expression;
}
function verify(values: Sources = sources) {
  const parsed = parse({ ...values, Old: oldSource }),
    app = parsed.App!,
    owner = parsed.Owner!,
    old = parsed.Old!;
  const workspace = namedFunction(app, "WorkspaceApp");
  const compose = declarationAt(
    workspace.body!.statements,
    "applicationCompose",
    "compose-direct-construction",
  );
  assert.ok(compose.initializer, "compose-direct-construction");
  const call = unwrap(compose.initializer);
  assert.ok(ts.isCallExpression(call), "compose-direct-construction");
  assert.equal(
    origin(app, call.expression),
    factoryOrigin,
    "compose-factory-origin",
  );
  assert.equal(call.arguments.length, 1, "compose-original-borrow");
  const options = object(call.arguments[0]!, "compose-original-borrow");
  assert.deepEqual(
    [...options.keys()],
    ["render", ...otherPorts],
    "compose-original-borrow",
  );
  const render = object(options.get("render")!, "compose-original-borrow");
  assert.deepEqual(
    [...render.keys()],
    [...renderPorts],
    "compose-original-borrow",
  );
  for (const port of renderPorts)
    sameValue(
      app,
      render.get(port)!,
      actualBinding(app, workspace, port),
      "compose-original-borrow",
    );
  for (const port of otherPorts) {
    if (port === "flushSync")
      assert.equal(
        origin(app, options.get(port)!),
        "react-dom:flushSync",
        "compose-original-borrow",
      );
    else
      sameValue(
        app,
        options.get(port)!,
        actualBinding(app, workspace, port),
        "compose-original-borrow",
      );
  }

  const builtin = one(
    local(app, workspace)
      .filter(ts.isCallExpression)
      .filter(
        (node) =>
          origin(app, node.expression) ===
          "./host/builtin-application-adapters.js:createBuiltinApplicationAdapters",
      ),
    "compose-actual-consumers",
  );
  const builtinOptions = object(
    builtin.arguments[0]!,
    "compose-actual-consumers",
  );
  sameValue(
    app,
    builtinOptions.get("onCompose")!,
    compose.name,
    "compose-actual-consumers",
  );
  const host = one(
    local(app, workspace)
      .filter(ts.isJsxOpeningElement)
      .filter(
        (node) =>
          origin(app, node.tagName) === "./ApplicationHost.js:ApplicationHost",
      ),
    "compose-actual-consumers",
  );
  const onCompose = one(
    host.attributes.properties
      .filter(ts.isJsxAttribute)
      .filter((node) => node.name.getText() === "onCompose"),
    "compose-actual-consumers",
  );
  sameValue(
    app,
    jsxValue(onCompose, "compose-actual-consumers"),
    compose.name,
    "compose-actual-consumers",
  );
  assert.equal(
    local(app, workspace)
      .filter(ts.isCallExpression)
      .filter((node) => origin(app, node.expression) === factoryOrigin).length,
    1,
    "compose-direct-construction",
  );
  const startup = one(
    workspace.body!.statements.filter(ts.isIfStatement).filter((statement) => {
      const condition = unwrap(statement.expression);
      if (
        !ts.isBinaryExpression(condition) ||
        condition.operatorToken.kind !== ts.SyntaxKind.BarBarToken
      )
        return false;
      const left = unwrap(condition.left),
        right = unwrap(condition.right);
      return (
        ts.isPrefixUnaryExpression(left) &&
        left.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isPrefixUnaryExpression(right) &&
        right.operator === ts.SyntaxKind.ExclamationToken &&
        id(app, left.operand) ===
          id(app, actualBinding(app, workspace, "state")) &&
        id(app, right.operand) ===
          id(app, actualBinding(app, workspace, "project"))
      );
    }),
    "compose-direct-construction",
  );
  assert.ok(
    startup.end < compose.getStart() && compose.end < builtin.getStart(),
    "compose-direct-construction",
  );

  const factory = namedFunction(owner, "createApplicationComposePreparation");
  assert.ok(
    factory.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ),
    "compose-factory-origin",
  );
  assert.equal(isAsync(factory), false, "compose-shared-result-order");
  assert.equal(factory.asteriskToken, undefined, "compose-shared-result-order");
  assert.equal(factory.parameters.length, 1, "compose-inert-construction");
  assert.equal(
    factory.parameters[0]!.initializer,
    undefined,
    "compose-inert-construction",
  );
  const captured = pattern(
    factory.parameters[0]!.name,
    "compose-inert-construction",
  );
  assert.deepEqual(
    [...captured.keys()],
    ["render", ...otherPorts],
    "compose-inert-construction",
  );
  const capturedRender = pattern(
    captured.get("render")!,
    "compose-inert-construction",
  );
  assert.deepEqual(
    [...capturedRender.keys()],
    [...renderPorts],
    "compose-inert-construction",
  );
  for (const port of [...renderPorts, ...otherPorts]) {
    const binding = (renderPorts as readonly string[]).includes(port)
      ? capturedRender.get(port)!
      : captured.get(port)!;
    assert.ok(ts.isIdentifier(binding), "compose-inert-construction");
    label(owner, binding, "port:" + port);
    const oldBinding = declarationAt(
      old.source.statements,
      port,
      "compose-fixed-recipe-binding",
    );
    label(old, oldBinding.name, "port:" + port);
  }
  const returned = one(factory.body!.statements, "compose-inert-construction");
  assert.ok(
    ts.isReturnStatement(returned) && returned.expression,
    "compose-inert-construction",
  );
  const command = unwrap(returned.expression);
  assert.ok(ts.isArrowFunction(command), "compose-inert-construction");
  assert.equal(isAsync(command), false, "compose-shared-result-order");
  assert.equal(command.parameters.length, 3, "compose-shared-result-order");
  assert.ok(ts.isBlock(command.body), "compose-shared-result-order");
  const oldDeclaration = declarationAt(
    old.source.statements,
    "applicationCompose",
    "compose-fixed-recipe",
  );
  assert.ok(
    oldDeclaration.initializer &&
      ts.isArrowFunction(oldDeclaration.initializer),
    "compose-fixed-recipe",
  );
  const original = oldDeclaration.initializer;
  assert.ok(ts.isBlock(original.body), "compose-fixed-recipe");
  for (let i = 0; i < 3; i++) {
    assert.ok(
      ts.isIdentifier(command.parameters[i]!.name),
      "compose-shared-result-order",
    );
    assert.equal(
      command.parameters[i]!.initializer,
      undefined,
      "compose-shared-result-order",
    );
    label(owner, command.parameters[i]!.name, "argument:" + i);
    label(old, original.parameters[i]!.name, "argument:" + i);
  }
  const assignedComposer = one(
    local(owner, command.body)
      .filter(ts.isBinaryExpression)
      .filter(
        (node) =>
          ts.isIdentifier(node.left) &&
          node.left.text === "composed" &&
          ts.isCallExpression(unwrap(node.right)),
      ),
    "compose-runtime-dependency-origin",
  );
  const composerCall = unwrap(assignedComposer.right);
  assert.ok(
    ts.isCallExpression(composerCall),
    "compose-runtime-dependency-origin",
  );
  assert.equal(
    origin(owner, composerCall.expression),
    helperOrigin,
    "compose-runtime-dependency-origin",
  );
  label(owner, composerCall.expression, "helper:composeArtifactDrafts");
  const oldComposer = one(
    old.nodes
      .filter(ts.isCallExpression)
      .filter((node) => origin(old, node.expression) === helperOrigin),
    "compose-fixed-recipe",
  );
  label(old, oldComposer.expression, "helper:composeArtifactDrafts");

  const first = command.body.statements[0],
    oldFirst = original.body.statements[0];
  assert.ok(
    first && ts.isIfStatement(first) && oldFirst && ts.isIfStatement(oldFirst),
    "compose-script-recipe",
  );
  assert.deepEqual(
    [shape(owner, first.expression), shape(owner, first.thenStatement)],
    [shape(old, oldFirst.expression), shape(old, oldFirst.thenStatement)],
    "compose-script-recipe",
  );
  const artifact = first.elseStatement,
    oldArtifact = oldFirst.elseStatement;
  assert.ok(
    artifact &&
      ts.isIfStatement(artifact) &&
      oldArtifact &&
      ts.isIfStatement(oldArtifact),
    "compose-artifact-recipe",
  );
  assert.deepEqual(
    [shape(owner, artifact.expression), shape(owner, artifact.thenStatement)],
    [shape(old, oldArtifact.expression), shape(old, oldArtifact.thenStatement)],
    "compose-artifact-recipe",
  );
  assert.ok(
    artifact.elseStatement && oldArtifact.elseStatement,
    "compose-plain-recipe",
  );
  assert.deepEqual(
    shape(owner, artifact.elseStatement),
    shape(old, oldArtifact.elseStatement),
    "compose-plain-recipe",
  );
  assert.deepEqual(
    command.body.statements.slice(1).map((node) => shape(owner, node)),
    original.body.statements.slice(1).map((node) => shape(old, node)),
    "compose-shared-result-order",
  );
}
function changed(source: string, before: string, after: string): string {
  assert.equal(
    source.split(before).length,
    2,
    "counterfactual unique intended source target",
  );
  return source.replace(before, after);
}
type Counterfactual = {
  name: string;
  key: keyof Sources;
  before: string;
  after: string;
  rule: RegExp;
};
const counterfactuals: Counterfactual[] = [
  {
    name: "1 used factory wrong module",
    key: "App",
    before: 'from "./host/application-compose-preparation.js"',
    after: 'from "./host/foreign-preparation.js"',
    rule: /compose-factory-origin/,
  },
  {
    name: "2 unused correct import plus foreign consumed",
    key: "App",
    before: "const applicationCompose = createApplicationComposePreparation({",
    after: "const applicationCompose = foreignPreparation({",
    rule: /compose-factory-origin/,
  },
  {
    name: "3 async public wrapper",
    key: "App",
    before: "const applicationCompose = createApplicationComposePreparation({",
    after:
      "const applicationCompose = async (...args) => createApplicationComposePreparation({",
    rule: /compose-direct-construction/,
  },
  {
    name: "4 second real factory used only by Host",
    key: "App",
    before: "onCompose={applicationCompose}",
    after: "onCompose={foreignCompose}",
    rule: /compose-actual-consumers/,
  },
  {
    name: "5 clone captured draft",
    key: "App",
    before: "      draft,\n      contextKey,\n      conversationId,",
    after:
      "      draft: { ...draft },\n      contextKey,\n      conversationId,",
    rule: /compose-original-borrow/,
  },
  {
    name: "6 latest client substitution",
    key: "App",
    before: "    client,\n    setDraft,\n    writeDrafts,\n    flushSync,",
    after:
      "    client: client.getSnapshot(),\n    setDraft,\n    writeDrafts,\n    flushSync,",
    rule: /compose-original-borrow/,
  },
  {
    name: "7 fake flushSync while real import stays",
    key: "App",
    before: "    flushSync,\n    currentContext,\n    dictationControls,",
    after:
      "    flushSync: (run) => run(),\n    currentContext,\n    dictationControls,",
    rule: /compose-original-borrow/,
  },
  {
    name: "8 captured current ref value",
    key: "App",
    before: "    currentContext,\n    dictationControls,\n    prefer,",
    after:
      "    currentContext: { current: currentContext.current },\n    dictationControls,\n    prefer,",
    rule: /compose-original-borrow/,
  },
  {
    name: "9 eager constructor read",
    key: "Owner",
    before: "  return (text, artifactId, scriptGeneration) => {",
    after:
      '  client.getScriptEditor("eager");\n  return (text, artifactId, scriptGeneration) => {',
    rule: /compose-inert-construction/,
  },
  {
    name: "10 foreign composer with unused correct import",
    key: "Owner",
    before: "composed = composeArtifactDrafts(",
    after: "composed = foreignComposer(",
    rule: /compose-runtime-dependency-origin/,
  },
  {
    name: "11 artifact priority instead of script",
    key: "Owner",
    before: "    if (scriptGeneration) {",
    after: "    if (artifactId) {",
    rule: /compose-script-recipe/,
  },
  {
    name: "12 missing original production project guard",
    key: "Owner",
    before: "        production.projectId !== project.id ||\n",
    after: "",
    rule: /compose-script-recipe/,
  },
  {
    name: "13 generation no longer cloned",
    key: "Owner",
    before: "structuredClone(scriptGeneration)",
    after: "scriptGeneration",
    rule: /compose-script-recipe/,
  },
  {
    name: "14 artifact updater loses real flushSync",
    key: "Owner",
    before: "      flushSync(() =>\n",
    after: "      ((run) => run())(() =>\n",
    rule: /compose-artifact-recipe/,
  },
  {
    name: "15 artifact uses captured draft instead of previous",
    key: "Owner",
    before: "            previous,\n            key,",
    after: "            { [key]: draft },\n            key,",
    rule: /compose-artifact-recipe/,
  },
  {
    name: "16 refusal creates new map",
    key: "Owner",
    before: "return composed.ok ? composed.drafts : previous;",
    after: "return composed.ok ? composed.drafts : { ...previous };",
    rule: /compose-artifact-recipe/,
  },
  {
    name: "17 legacy broadened beyond default conversation",
    key: "Owner",
    before: "conversationId === defaultConversation",
    after: "true",
    rule: /compose-artifact-recipe/,
  },
  {
    name: "18 prefer moved before original interrupt",
    key: "Owner",
    before:
      "      if (key === currentContext.current && composed.bodyChanged)\n        dictationControls.current?.interrupt();\n      prefer({ artifactId });",
    after:
      "      prefer({ artifactId });\n      if (key === currentContext.current && composed.bodyChanged)\n        dictationControls.current?.interrupt();",
    rule: /compose-artifact-recipe/,
  },
  {
    name: "19 plain append loses captured original body",
    key: "Owner",
    before: 'body: [draft.body, text].filter(Boolean).join("\\n"),',
    after: "body: text,",
    rule: /compose-plain-recipe/,
  },
  {
    name: "20 direct synchronous ACK becomes Promise",
    key: "Owner",
    before: "  return (text, artifactId, scriptGeneration) => {",
    after: "  return async (text, artifactId, scriptGeneration) => {",
    rule: /compose-shared-result-order/,
  },
];
function mutation(entry: Counterfactual): Sources {
  const result = {
    ...sources,
    [entry.key]: changed(sources[entry.key], entry.before, entry.after),
  };
  if (entry.name.startsWith("2 "))
    result.App =
      'import { createApplicationComposePreparation as foreignPreparation } from "./host/foreign-preparation.js";\n' +
      result.App;
  if (entry.name.startsWith("3 "))
    result.App = changed(
      result.App,
      "    showInput,\n  });\n  const builtinApplications",
      "    showInput,\n  })(...args);\n  const builtinApplications",
    );
  if (entry.name.startsWith("4 "))
    result.App = changed(
      result.App,
      "  const builtinApplications =",
      "  const foreignCompose = createApplicationComposePreparation({ render: { state, project, draft, contextKey, conversationId, defaultConversation, sending, emptyDraft }, client, setDraft, writeDrafts, flushSync, currentContext, dictationControls, prefer, showInput });\n  const builtinApplications =",
    );
  if (entry.name.startsWith("10 "))
    result.Owner =
      'import { composeArtifactDrafts as foreignComposer } from "../foreign-composer.js";\n' +
      result.Owner;
  return result;
}
test("actual render-local preparation constructor, complete recipes and same real consumers", () =>
  verify());
test("twenty finite parse-valid counterfactuals reject their specified current rule", () => {
  for (const entry of counterfactuals)
    assert.throws(
      () => verify(mutation(entry)),
      { name: "AssertionError", message: entry.rule },
      entry.name,
    );
});
test("real import and const aliases retain actual factory/helper/capture/consumer identities", () => {
  let app = changed(
    sources.App,
    'import { createApplicationComposePreparation } from "./host/application-compose-preparation.js";',
    'import { createApplicationComposePreparation as RealPreparation } from "./host/application-compose-preparation.js";',
  );
  app = changed(
    app,
    "const applicationCompose = createApplicationComposePreparation({",
    "const applicationCompose = PreparationAlias({",
  );
  app = changed(
    app,
    "  const applicationCompose =",
    "  const CapturedDraft = draft;\n  const applicationCompose =",
  );
  app = changed(
    app,
    "      draft,\n      contextKey,\n      conversationId,",
    "      draft: CapturedDraft,\n      contextKey,\n      conversationId,",
  );
  app = changed(
    app,
    "  const builtinApplications =",
    "  const SameCompose = applicationCompose;\n  const builtinApplications =",
  );
  app = changed(
    app,
    "    onCompose: applicationCompose,",
    "    onCompose: SameCompose,",
  );
  app = changed(
    app,
    "onCompose={applicationCompose}",
    "onCompose={SameCompose}",
  );
  app += "\nconst PreparationAlias = RealPreparation;\n";
  let owner = changed(
    sources.Owner,
    'import { composeArtifactDrafts } from "../composer-drafts.js";',
    'import { composeArtifactDrafts as RealComposer } from "../composer-drafts.js";',
  );
  owner = owner.replaceAll(
    "typeof composeArtifactDrafts",
    "typeof ComposerAlias",
  );
  owner = changed(
    owner,
    "composed = composeArtifactDrafts(",
    "composed = ComposerAlias(",
  );
  owner += "\nconst ComposerAlias = RealComposer;\n";
  verify({ App: app, Owner: owner });
});
test("genuine independently consumed React feature and pure/type growth are not whole-page locks", () => {
  let app =
    'import { useReducer as futureReducer } from "react";\n' + sources.App;
  app = changed(
    app,
    '      <aside\n        className="sidebar"',
    '      <IndependentComposeFuture />\n      <aside\n        className="sidebar"',
  );
  app +=
    "\nfunction IndependentComposeFuture() { const [value] = futureReducer((value: number) => value, 0); return <output>{value}</output>; }\n";
  verify({
    App: app,
    Owner:
      sources.Owner +
      "\nexport type IndependentFutureType = Readonly<{ independent: true }>;\nexport function independentFuture(value: number) { return value + 1; }\n",
  });
});
