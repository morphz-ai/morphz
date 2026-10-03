import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isBindingElement,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxAttributes,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type CallExpression,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// Finite consumption contract, not arbitrary JS purity, React scheduling or
// visual/OS hit-test proof. cb7246a2 canonical hashes below were computed from
// the fixed original App/Host, not the migrated implementation. CI needs no git
// history. Only the two approved App→Host prop replacements are normalized;
// literal trees, callbacks, keys/refs/hidden/portals and hook arguments remain.
// A future deliberate UI/lifecycle change must explicitly review this baseline.
const baseline = {
  App: {
    jsxNodes: 196,
    jsxRoots: 14,
    jsx: "0462fe0a8503ae683190966d423547dc451cd14c73f5630d1a32b86d3033b66f",
    effectsCount: 16,
    effects: "d92523acc4e40a0ed0f32aa5b6a4a7e8db96327403173f9823e3b7000f430562",
    hooksCount: 81,
    hooks: "c6ed83e4de5d7b4f1497671e611429fa9ee96d5d311e31cee372e0b6a4739de6",
  },
  Host: {
    jsxNodes: 71,
    jsxRoots: 5,
    jsx: "409f5e6e0f02684d364194c204c9723160f8dbe8bde3925a7ba2c35a98cfaf36",
    effectsCount: 5,
    effects: "d9935ce60400847c4ebe466baa13bcb40a8f9d5d6c4cf256c1641cb6e2104416",
    hooksCount: 20,
    hooks: "920302f2c6c8dd66d3959d8fe96dd57db898a5536a6660ee94b446eb0c660b18",
  },
} as const;

// Approved adapter: the original Host guard/catch/finally remain local and the
// original execute promise is awaited there. This is not an extra async owner
// bridge, a second lock or a copy of the moved feature/navigation algorithms.
const adapterText = `
async function launch(app: ApplicationCatalogEntry, contents = false) {
  if (launching.current) return;
  launching.current = true;
  setBusy(true);
  try {
    const action = applicationActions.launch(app, navigationSnapshot, contents);
    if (action.kind === "contents") { await action.pending; return; }
    action.commit(await action.pending);
  } catch (error) { onNotice((error as Error).message); }
  finally { launching.current = false; setBusy(false); }
}
async function close(instance: ApplicationInstance) {
  try {
    const action = applicationActions.close(instance, navigationSnapshot);
    await action.pending;
    action.commit();
  } catch (error) { onNotice((error as Error).message); }
}
function capture() {
  const navigationSnapshot = { workspaceId, navigationId, activeId, instances };
}
function prepared() {
  const applicationActions: ApplicationNavigationActions = {
    activate: activateApplication,
    launch(app, captured, contents = false) {
      if (contents) return { kind: "contents", pending: openWorkspaceContents() };
      return {
        kind: "application",
        pending: client.execute({ type: "launch-application", workspaceId: captured.workspaceId,
          applicationId: app.id, applicationVersion: app.version }),
        commit(receipt) { activateApplication(receipt.entityId, captured.navigationId); },
      };
    },
    close(instance, captured) {
      return {
        pending: client.execute({ type: "close-application", instanceId: instance.id,
          expectedRevision: instance.revision }),
        commit() {
          if (captured.activeId === instance.id) {
            const index = captured.instances.findIndex((i) => i.id === instance.id);
            activateApplication(captured.instances[index + 1]?.id ?? captured.instances[index - 1]?.id ?? null,
              captured.navigationId);
          }
        },
      };
    },
  };
}
`;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  identifiers: Identifier[];
  symbols: Map<Node, number | undefined>;
};
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>) {
  const directory = "/application-navigation-consumption";
  const config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, source]) => [
      `${directory}/${name}.tsx`,
      source,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((name) => `${name}.tsx`),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "invalid source cannot satisfy a consumption gate",
    );
    return new Map(
      Object.keys(contents).map((name): [string, Parsed] => {
        const source = project.program.getSourceFile(
          `${directory}/${name}.tsx`,
        )!;
        const nodes: Node[] = [],
          identifiers: Identifier[] = [];
        walk(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) identifiers.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(identifiers);
        return [
          name,
          {
            source,
            nodes,
            identifiers,
            symbols: new Map(
              identifiers.map((node, index) => [node, resolved[index]?.id]),
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
function syntax(node: Node, normalizeAppHost = false): unknown {
  if (
    normalizeAppHost &&
    isJsxAttribute(node) &&
    isJsxAttributes(node.parent)
  ) {
    const tag = node.parent.parent;
    if (
      (isJsxOpeningElement(tag) || isJsxSelfClosingElement(tag)) &&
      tag.tagName.getText() === "ApplicationHost" &&
      ["onActivate", "onOpenContents", "applicationActions"].includes(
        node.name.getText(),
      )
    )
      return undefined;
  }
  const children: unknown[] = [];
  node.forEachChild((child) => {
    const value = syntax(child, normalizeAppHost);
    if (value !== undefined) children.push(value);
  });
  return [node.kind, children.length ? children : node.getText()];
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jsx = (node: Node) =>
  isJsxElement(node) || isJsxFragment(node) || isJsxSelfClosingElement(node);
function imported(
  parsed: Parsed,
  path: string,
  name: string,
  typeOnly = false,
) {
  const matches: Identifier[] = [];
  for (const node of parsed.nodes.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== path ||
      !node.importClause?.namedBindings ||
      !isNamedImports(node.importClause.namedBindings)
    )
      continue;
    for (const item of node.importClause.namedBindings.elements)
      if (
        (item.propertyName ?? item.name).text === name &&
        (item.isTypeOnly ||
          node.importClause.phaseModifier === SyntaxKind.TypeKeyword) ===
          typeOnly
      )
        matches.push(item.name);
  }
  assert.equal(matches.length, 1, `one actual ${name} import`);
  const binding = parsed.symbols.get(matches[0]!);
  assert.ok(binding !== undefined, `${name} import binding resolves`);
  return binding;
}
function oneFunction(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, `one ${name} function`);
  return found[0]!;
}
function oneVariable(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, `one ${name} variable`);
  return found[0]!;
}
function structure(parsed: Parsed, normalizeAppHost: boolean) {
  const hooks = new Map<number | undefined, string>();
  for (const node of parsed.nodes.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "react"
    )
      continue;
    assert.ok(
      node.importClause?.namedBindings &&
        isNamedImports(node.importClause.namedBindings) &&
        !node.importClause.name,
      "original explicit React imports, no hidden namespace lifecycle",
    );
    for (const item of node.importClause.namedBindings.elements) {
      const name = (item.propertyName ?? item.name).text;
      if (
        item.isTypeOnly ||
        node.importClause.phaseModifier === SyntaxKind.TypeKeyword
      )
        continue;
      assert.ok(
        [
          "createElement",
          "useState",
          "useRef",
          "useEffect",
          "useLayoutEffect",
          "useCallback",
          "useMemo",
        ].includes(name),
        "no unreviewed React store or lifecycle primitive",
      );
      if (/^use[A-Z]/.test(name)) {
        const binding = parsed.symbols.get(item.name);
        assert.ok(binding !== undefined);
        hooks.set(binding, name);
        for (const use of parsed.identifiers.filter(
          (node) => parsed.symbols.get(node) === binding,
        ))
          assert.ok(
            use === item.name ||
              (isCallExpression(use.parent) && use.parent.expression === use),
            "hook imports are original direct calls, not alias/async bridges",
          );
      }
    }
  }
  const calls = parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        hooks.has(parsed.symbols.get(node.expression)),
    );
  const hook = (node: CallExpression) => [
    hooks.get(parsed.symbols.get(node.expression)),
    [...(node.typeArguments ?? [])].map((node) => syntax(node)),
    [...node.arguments].map((node) => syntax(node)),
  ];
  const effects = calls.filter((node) =>
    ["useEffect", "useLayoutEffect"].includes(
      hooks.get(parsed.symbols.get(node.expression))!,
    ),
  );
  const jsxNodes = parsed.nodes.filter(jsx);
  const roots = jsxNodes.filter((node) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (jsx(parent)) return false;
    return true;
  });
  return {
    jsxNodes: jsxNodes.length,
    jsxRoots: roots.length,
    jsx: digest(roots.map((node) => syntax(node, normalizeAppHost))),
    effectsCount: effects.length,
    effects: digest(effects.map(hook)),
    hooksCount: calls.length,
    hooks: digest(calls.map(hook)),
  };
}
function consumption(appText: string, hostText: string, ownerText: string) {
  const parsed = parse({
    App: appText,
    Host: hostText,
    Owner: ownerText,
    Adapter: adapterText,
  });
  const app = parsed.get("App")!,
    host = parsed.get("Host")!,
    owner = parsed.get("Owner")!,
    adapter = parsed.get("Adapter")!;
  const factory = imported(
    app,
    "./host/use-workspace-navigation.js",
    "createWorkspaceNavigationCommands",
  );
  const factoryCalls = app.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        app.symbols.get(node.expression) === factory,
    );
  assert.equal(factoryCalls.length, 1, "one real owner factory call");
  const call = factoryCalls[0]!;
  assert.ok(
    isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      isObjectBindingPattern(call.parent.name),
    "commands consumed directly, not returned from an async wrapper",
  );
  const command = call.parent.name.elements.filter(
    (node) =>
      isBindingElement(node) &&
      !node.propertyName &&
      !!node.name &&
      isIdentifier(node.name) &&
      node.name.text === "applicationActions",
  );
  assert.equal(command.length, 1, "actual applicationActions owner binding");
  const actions = app.symbols.get(command[0]!.name!);
  assert.ok(actions !== undefined);
  const hostImport = imported(app, "./ApplicationHost.js", "ApplicationHost");
  const hostRenders = app.nodes
    .filter(
      (node) => isJsxOpeningElement(node) || isJsxSelfClosingElement(node),
    )
    .filter(
      (node) =>
        isIdentifier(node.tagName) &&
        app.symbols.get(node.tagName) === hostImport,
    );
  assert.equal(hostRenders.length, 1, "one actual imported Host render");
  const attributes = hostRenders[0]!.attributes.properties;
  const actionProps = attributes
    .filter(isJsxAttribute)
    .filter((node) => node.name.getText() === "applicationActions");
  assert.equal(actionProps.length, 1, "one applicationActions Host port");
  const value = actionProps[0]!.initializer;
  assert.ok(
    value &&
      isJsxExpression(value) &&
      value.expression &&
      isIdentifier(value.expression) &&
      app.symbols.get(value.expression) === actions,
    "Host uses the real directly-destructured applicationActions, no wrapper",
  );
  assert.equal(
    attributes
      .filter(isJsxAttribute)
      .some((node) =>
        ["onActivate", "onOpenContents"].includes(node.name.getText()),
      ),
    false,
    "retired Host callback props cannot duplicate the owner",
  );

  const actionType = imported(
    host,
    "./host/use-workspace-navigation.js",
    "ApplicationNavigationActions",
    true,
  );
  const hostFunction = oneFunction(host, "ApplicationHost");
  const parameter = hostFunction.parameters[0]!;
  assert.ok(isObjectBindingPattern(parameter.name));
  const local = parameter.name.elements.filter(
    (node) =>
      !!node.name &&
      isIdentifier(node.name) &&
      node.name.text === "applicationActions",
  );
  assert.equal(local.length, 1, "Host original prop binding receives actions");
  const localBinding = host.symbols.get(local[0]!.name!);
  assert.ok(localBinding !== undefined);
  const typed: Node[] = [];
  parameter.type!.forEachChild((node) => {
    if (
      node.kind === SyntaxKind.PropertySignature &&
      node.getText().replace(/\s+/g, "") ===
        "applicationActions:ApplicationNavigationActions;"
    )
      typed.push(node);
  });
  assert.equal(typed.length, 1, "Host actions use the real typed owner port");
  const typeUses: Identifier[] = [];
  walk(typed[0]!, (node) => {
    if (isIdentifier(node) && host.symbols.get(node) === actionType)
      typeUses.push(node);
  });
  assert.equal(typeUses.length, 1, "not a locally-shadowed action type");
  const uses = host.identifiers.filter(
    (node) => host.symbols.get(node) === localBinding,
  );
  assert.equal(
    uses.length,
    4,
    "only receive/activate/launch/close action uses",
  );
  assert.deepEqual(
    uses
      .filter((node) => node !== local[0]!.name)
      .map((node) => {
        assert.ok(
          isPropertyAccessExpression(node.parent) &&
            node.parent.expression === node,
          "direct typed port, no Host-local second action store",
        );
        return node.parent.name.text;
      }),
    ["activate", "launch", "close"],
  );
  const activate = oneVariable(host, "onActivate").initializer;
  assert.ok(
    activate &&
      isPropertyAccessExpression(activate) &&
      isIdentifier(activate.expression) &&
      host.symbols.get(activate.expression) === localBinding &&
      activate.name.text === "activate",
    "original JSX callbacks use the direct owner activation reference",
  );
  assert.deepEqual(
    syntax(oneVariable(host, "navigationSnapshot").initializer!),
    syntax(oneVariable(adapter, "navigationSnapshot").initializer!),
    "captured original workspace/generation/active/ordered instances",
  );
  for (const name of ["launch", "close"])
    assert.deepEqual(
      syntax(oneFunction(host, name).body!),
      syntax(oneFunction(adapter, name).body!),
      `${name}: raw promise inside original caller-local try/catch/finally`,
    );

  const prepared = oneVariable(owner, "applicationActions");
  assert.equal(prepared.type?.getText(), "ApplicationNavigationActions");
  assert.deepEqual(
    syntax(prepared.initializer!),
    syntax(oneVariable(adapter, "applicationActions").initializer!),
    "prepared union is synchronous and exposes only original raw promises",
  );
  const actionTypes = owner.nodes
    .filter(isTypeAliasDeclaration)
    .filter((node) => node.name.text === "ApplicationNavigationActions");
  assert.equal(actionTypes.length, 1, "one typed prepared action owner");
  const preparedTypeNames: Identifier[] = [];
  walk(prepared.type!, (node) => {
    if (isIdentifier(node)) preparedTypeNames.push(node);
  });
  assert.equal(preparedTypeNames.length, 1);
  assert.equal(
    owner.symbols.get(preparedTypeNames[0]!),
    owner.symbols.get(actionTypes[0]!.name),
    "prepared value uses its actual declared action type",
  );
  const returned = oneFunction(
    owner,
    "createWorkspaceNavigationCommands",
  ).body!.statements.at(-1)!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
  );
  const returnedActions = returned.expression.properties.filter(
    (node) =>
      (isShorthandPropertyAssignment(node) || isPropertyAssignment(node)) &&
      node.name.getText() === "applicationActions",
  );
  assert.equal(returnedActions.length, 1);
  assert.ok(isShorthandPropertyAssignment(returnedActions[0]!));

  assert.deepEqual(
    structure(app, true),
    baseline.App,
    "original App JSX/effects/all React lifecycle registrations",
  );
  assert.deepEqual(
    structure(host, false),
    baseline.Host,
    "original Host JSX/effects/all React lifecycle registrations",
  );
}
const app = readFileSync("apps/web/src/App.tsx", "utf8");
const host = readFileSync("apps/web/src/ApplicationHost.tsx", "utf8");
const owner = readFileSync(
  "apps/web/src/host/use-workspace-navigation.ts",
  "utf8",
);
function changed(source: string, from: string, to: string) {
  assert.ok(source.includes(from), `negative fixture target absent: ${from}`);
  return source.replace(from, to);
}

test("actual App/Host consume the typed prepared navigation owner and retain fixed cb7246a2 JSX/lifecycle", () => {
  consumption(app, host, owner);
});
test("App consumption rejects fake/shadowed ports and unapproved DOM or lifecycle changes", () => {
  const candidates = [
    changed(
      app,
      "applicationActions={applicationActions}",
      "applicationActions={otherActions}",
    ),
    changed(
      app,
      "applicationActions={applicationActions}",
      "applicationActions={{ ...applicationActions }}",
    ),
    changed(
      app,
      "applicationActions={applicationActions}",
      "onActivate={activateApplication} applicationActions={applicationActions}",
    ),
    changed(
      app,
      "applicationActions={applicationActions}",
      "applicationActions={applicationActions} key={navigationGeneration.current}",
    ),
    changed(
      app,
      "  const {\n    travel,",
      "  const createWorkspaceNavigationCommands = () => ({});\n  const {\n    travel,",
    ),
    changed(
      app,
      '<div className="object-surface" hidden={creating === "document"}>',
      '<div className="object-surface" hidden={false}>',
    ),
    changed(
      app,
      "const positions = useRef(new Map<string, number>());",
      "useEffect(() => {}, []);\n  const positions = useRef(new Map<string, number>());",
    ),
    changed(
      app,
      "const positions = useRef(new Map<string, number>());",
      "const mirror = useState(null);\n  const positions = useRef(new Map<string, number>());",
    ),
  ];
  for (const candidate of candidates)
    assert.throws(
      () => consumption(candidate, host, owner),
      assert.AssertionError,
    );
});
test("Host rejects an async bridge, changed capture or relocated local busy/error/finally contract", () => {
  for (const candidate of [
    changed(
      host,
      "const action = applicationActions.launch(",
      "const action = await applicationActions.launch(",
    ),
    changed(
      host,
      "action.commit(await action.pending);",
      "await action.pending;\n      await Promise.resolve();\n      action.commit(undefined);",
    ),
    changed(
      host,
      "await action.pending;\n      action.commit();",
      "action.commit();\n      await action.pending;",
    ),
    changed(
      host,
      "const navigationSnapshot = { workspaceId, navigationId, activeId, instances };",
      "const navigationSnapshot = { workspaceId, navigationId: 0, activeId, instances };",
    ),
    changed(
      host,
      "const navigationSnapshot = { workspaceId, navigationId, activeId, instances };",
      "const navigationSnapshot = { workspaceId, navigationId, activeId, instances: [...instances] };",
    ),
    changed(
      host,
      "const onActivate = applicationActions.activate;",
      "const onActivate = (...args) => applicationActions.activate(...args);",
    ),
    changed(host, "if (launching.current) return;", "if (busy) return;"),
    changed(
      host,
      "launching.current = false;\n      setBusy(false);",
      "setBusy(false);\n      launching.current = false;",
    ),
    changed(
      host,
      "onNotice((error as Error).message);",
      "if (activeId) onNotice((error as Error).message);",
    ),
    changed(
      host,
      "applicationActions: ApplicationNavigationActions;",
      "applicationActions: any;",
    ),
    changed(
      host,
      "import type { ApplicationNavigationActions }",
      "import type { OtherActions as ApplicationNavigationActions }",
    ),
  ])
    assert.throws(
      () => consumption(app, candidate, owner),
      assert.AssertionError,
    );
});
test("Host fixed-tree/lifecycle gate rejects pane remount, altered portal and new state/effects", () => {
  for (const candidate of [
    changed(host, "key={instance.id}", "key={navigationId}"),
    changed(host, "hidden={active?.id !== instance.id}", "hidden={false}"),
    changed(
      host,
      "createPortal(toolbar, toolbarTarget)",
      "createPortal(<section>{toolbar}</section>, toolbarTarget)",
    ),
    changed(
      host,
      "const launching = useRef(false);",
      "useEffect(() => {}, []);\n  const launching = useRef(false);",
    ),
    changed(
      host,
      "const launching = useRef(false);",
      "const [mirrored, setMirrored] = useState(null);\n  const launching = useRef(false);",
    ),
    changed(
      host,
      "[activeId, instanceIds, enabled, toolbarTarget]",
      "[activeId, instances, enabled, toolbarTarget]",
    ),
    changed(
      host,
      "<small>{applicationDescription(app)}</small>",
      "<small>changed late sibling</small>",
    ),
    changed(
      host,
      'attributeFilter: ["data-appearance", "data-accent"]',
      'attributeFilter: ["data-appearance", "data-unreviewed"]',
    ),
  ])
    assert.throws(
      () => consumption(app, candidate, owner),
      assert.AssertionError,
    );
});
test("prepared owner rejects async/raw-promise wrappers and changed captured activation/neighbor order", () => {
  for (const candidate of [
    changed(
      owner,
      "launch(app, captured, contents = false) {",
      "async launch(app, captured, contents = false) {",
    ),
    changed(
      owner,
      "pending: openWorkspaceContents()",
      "pending: Promise.resolve().then(() => openWorkspaceContents())",
    ),
    changed(
      owner,
      "}),\n        commit(receipt)",
      "}).then((receipt) => receipt),\n        commit(receipt)",
    ),
    changed(
      owner,
      "activateApplication(receipt.entityId, captured.navigationId);",
      "activateApplication(receipt.entityId);",
    ),
    changed(
      owner,
      "captured.instances[index + 1]?.id ??",
      "captured.instances[index - 1]?.id ??",
    ),
  ])
    assert.throws(
      () => consumption(app, host, candidate),
      assert.AssertionError,
    );
});
test("finite gate permits comments and unrelated non-UI/non-lifecycle helpers", () => {
  consumption(
    app +
      "\n// No governed JSX or lifecycle changed.\nfunction unrelatedPureHelper(value: number) { return value + 1; }\n",
    host + "\n// An unrelated comment is not a mount or state change.\n",
    owner,
  );
});
