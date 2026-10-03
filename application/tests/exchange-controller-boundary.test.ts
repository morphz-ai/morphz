import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isArrayLiteralExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  type CallExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// A bounded ownership/wiring gate for this migrated controller, not a proof of
// arbitrary JS purity or visual equivalence. Geometry remains a browser gate.
const paths = {
  controller: "apps/web/src/host/use-exchange-controller.ts",
  app: "apps/web/src/App.tsx",
};
const requestRefs = [
  "requestedComposerFocus",
  "requestedConversationFocus",
  "sentInputFocus",
];
const suspensionInputs = [
  "dialogueCanvas",
  "!!speech",
  "!!capture",
  "searchOpen",
  "connectionOpen",
  "settingsSection!==null",
  "!!creating",
  "!!executions",
  "nativeExportDialog",
  "directoryPickerScope===directoryScope",
  "!!uploadingDrafts[contextKey]",
];
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
const text = (node: Node, source: SourceFile) =>
  node.getText(source).replace(/\s+/g, "");
function parse(controller: string, app: string) {
  const directory = "/exchange-controller-boundary-fixtures";
  const config = `${directory}/tsconfig.json`;
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: ["controller.ts", "App.tsx"],
      }),
      [`${directory}/controller.ts`]: controller,
      [`${directory}/App.tsx`]: app,
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)!.program;
      assert.deepEqual(program.getSyntacticDiagnostics(), []);
      const appSource = program.getSourceFile(`${directory}/App.tsx`)!;
      const identifiers: Node[] = [];
      walk(appSource, (node) => {
        if (isIdentifier(node)) identifiers.push(node);
      });
      const resolved = snapshot
        .getProject(config)!
        .checker.getSymbolAtLocation(identifiers);
      return {
        controller: program.getSourceFile(`${directory}/controller.ts`)!,
        app: appSource,
        appSymbols: new Map(
          identifiers.map((node, index) => [node, resolved[index]?.id]),
        ),
      };
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
function calls(source: SourceFile, name: string): CallExpression[] {
  const found: CallExpression[] = [];
  walk(source, (node) => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found.push(node);
  });
  return found;
}
function mentions(node: Node, name: string) {
  let found = false;
  walk(node, (child) => {
    if (isIdentifier(child) && child.text === name) found = true;
  });
  return found;
}
function ownership(controllerText: string, appText: string): string[] {
  const { controller, app, appSymbols } = parse(controllerText, appText);
  const problems: string[] = [];
  const check = (valid: boolean, message: string) => {
    if (!valid) problems.push(message);
  };
  const runtimeImports = new Set([
    "react",
    "../interaction.js",
    "../useExchangeFocus.js",
  ]);
  const typeImports = new Set([
    ...runtimeImports,
    "../ExchangeResizeHandle.js",
    "./work-surface.js",
  ]);
  walk(controller, (node) => {
    if (isImportDeclaration(node)) {
      const path = isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      const clause = node.importClause;
      const allTypes = clause?.phaseModifier === SyntaxKind.TypeKeyword;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        allTypes ||
        (bindings &&
          isNamedImports(bindings) &&
          bindings.elements.every((binding) => binding.isTypeOnly));
      check(
        (onlyTypes ? typeImports : runtimeImports).has(path),
        `Unreviewed controller dependency: ${path}`,
      );
    }
    if (isIdentifier(node))
      check(
        ![
          "fetch",
          "XMLHttpRequest",
          "WebSocket",
          "EventSource",
          "localStorage",
          "sessionStorage",
          "writeLocal",
          "getBoundingClientRect",
          "ResizeObserver",
          "createPortal",
        ].includes(node.text),
        `Controller must not own transport/storage/geometry: ${node.text}`,
      );
  });
  for (const name of requestRefs) {
    const declarations: Node[] = [];
    walk(controller, (node) => {
      if (
        isVariableDeclaration(node) &&
        isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        isCallExpression(node.initializer) &&
        text(node.initializer.expression, controller) === "useRef"
      )
        declarations.push(node);
    });
    check(
      declarations.length === 1,
      `One private controller request ref: ${name}`,
    );
  }
  check(
    calls(controller, "useState").length === 1,
    "Only transient resize preview is controller state",
  );
  check(
    calls(controller, "useExchangeFocus").length === 1,
    "One existing auto-leave subscription",
  );
  for (const name of [
    ...requestRefs,
    "previousFocus",
    "latestInteraction",
    "exchangeResizePreview",
  ])
    check(
      !mentions(app, name),
      `App must not hold another exchange intent owner: ${name}`,
    );
  check(
    calls(app, "useExchangeFocus").length === 0,
    "Auto-leave belongs to controller",
  );
  const entries = calls(app, "useExchangeController");
  const commits = calls(app, "useExchangeControllerFocus");
  check(
    entries.length === 1 && commits.length === 1,
    "One controller and one ordered focus commit seam",
  );
  const options = entries[0]?.arguments[0];
  if (options && isObjectLiteralExpression(options)) {
    const values = new Map<string, Node>();
    for (const property of options.properties)
      if (isPropertyAssignment(property) && isIdentifier(property.name))
        values.set(property.name.text, property.initializer);
      else if (
        isShorthandPropertyAssignment(property) &&
        isIdentifier(property.name)
      )
        values.set(property.name.text, property.name);
    for (const [name, value] of Object.entries({
      surface: "workSurface",
      preferences: "prefs",
      input: "input",
      exchange: "exchange",
      toggle: "toggle",
      navigationGeneration: "navigationGeneration",
      sending: "sending",
      prefer: "prefer",
    }))
      check(
        values.has(name) && text(values.get(name)!, app) === value,
        `Original Host-owned controller input: ${name}`,
      );
    const suspended = values.get("suspended");
    check(
      !!suspended && text(suspended, app) === suspensionInputs.join("||"),
      "All eleven suspension inputs retain the original expression and order",
    );
  } else check(false, "Controller receives explicit Host-owned inputs");
  const focus = commits[0];
  check(
    !!focus && text(focus.arguments[0]!, app) === "exchangeController",
    "Focus seam receives the same controller",
  );
  const effects = calls(app, "useLayoutEffect");
  check(
    !!focus &&
      effects.some(
        (effect) => mentions(effect, "positions") && effect.pos < focus.pos,
      ),
    "Owner restoration precedes explicit focus: positions",
  );
  const navigationCommits = calls(app, "useWorkspaceNavigationCommit");
  const navigationCommit = navigationCommits[0];
  check(
    navigationCommits.length === 1 &&
      !!navigationCommit &&
      !!focus &&
      navigationCommit.arguments.length === 2 &&
      text(navigationCommit.arguments[0]!, app) === "navigation" &&
      text(navigationCommit.arguments[1]!, app) === "{place,travel}" &&
      effects.some(
        (effect) =>
          mentions(effect, "positions") && effect.pos < navigationCommit.pos,
      ) &&
      navigationCommit.pos < focus.pos,
    "Named trail commit follows position restoration and precedes explicit focus",
  );
  // Inspector memory now has one named commit seam; the inspector's own gate
  // checks its original layout effect/body/deps. Resolve the actual import so a
  // same-named local function cannot stand in for that lifecycle boundary.
  const inspectorImports: Node[] = [];
  walk(app, (node) => {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./host/use-subject-inspector.js" &&
      node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword &&
      node.importClause?.namedBindings &&
      isNamedImports(node.importClause.namedBindings)
    )
      for (const item of node.importClause.namedBindings.elements)
        if (
          !item.isTypeOnly &&
          (item.propertyName ?? item.name).text === "useSubjectInspectorCommit"
        )
          inspectorImports.push(item.name);
  });
  const inspectorSymbol = appSymbols.get(inspectorImports[0]!);
  const inspectorCommits: CallExpression[] = [];
  walk(app, (node) => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      inspectorSymbol !== undefined &&
      appSymbols.get(node.expression) === inspectorSymbol
    )
      inspectorCommits.push(node);
  });
  const inspectorCommit = inspectorCommits[0];
  const inspectorFacts = inspectorCommit?.arguments[1];
  check(
    inspectorImports.length === 1 &&
      inspectorCommits.length === 1 &&
      !!focus &&
      !!inspectorCommit &&
      inspectorCommit.pos > focus.pos &&
      inspectorCommit.arguments.length === 2 &&
      text(inspectorCommit.arguments[0]!, app) === "inspectorSelections" &&
      !!inspectorFacts &&
      isObjectLiteralExpression(inspectorFacts) &&
      inspectorFacts.properties.length === 4 &&
      inspectorFacts.properties.every(
        (property, index) =>
          isShorthandPropertyAssignment(property) &&
          property.name.getText() ===
            [
              "contextKey",
              "executions",
              "understandingOpen",
              "collaborationVisible",
            ][index],
      ) &&
      !effects.some((effect) => mentions(effect, "inspectorSelections")),
    "Inspector effects remain after explicit focus",
  );
  const focusEffects = calls(controller, "useLayoutEffect");
  check(
    focusEffects.length === 3 &&
      focusEffects
        .map((effect) => text(effect.arguments[0]!, controller))
        .join(";") ===
        "()=>focus.composer();()=>focus.conversation();()=>focus.sent()" &&
      focusEffects[0]!.arguments.length === 1 &&
      focusEffects[1]!.arguments.length === 1 &&
      isArrayLiteralExpression(focusEffects[2]!.arguments[1]!) &&
      text(focusEffects[2]!.arguments[1]!, controller) ===
        "[focus.sending,focus.contextKey,focus.inputVisible]",
    "Three original focus effects retain their order and dependency semantics",
  );
  return problems;
}
const controller = readFileSync(paths.controller, "utf8");
const app = readFileSync(paths.app, "utf8");

test("exchange controller owns intent but preserves Host inputs and layout commit order", () => {
  assert.deepEqual(ownership(controller, app), []);
});
test("controller ownership gate rejects transport/storage/geometry creep", () => {
  for (const extra of [
    'import { HttpApplicationClient } from "../../../../packages/core/src/http-application-client.js";',
    'fetch("/api/send");',
    'localStorage.setItem("draft", "body");',
    "new ResizeObserver(() => {});",
  ])
    assert.ok(ownership(controller + "\n" + extra, app).length > 0, extra);
});
test("controller ownership gate rejects duplicate requests, lost suspension and reordered effects", () => {
  for (const changed of [
    app + "\nconst requestedComposerFocus = useRef(null);",
    app.replace("!!capture ||", ""),
    app.replace("surface: workSurface,", "surface: { ...workSurface },"),
    app.replace("useExchangeControllerFocus(exchangeController);", ""),
    app.replace(
      "useWorkspaceNavigationCommit(navigation, { place, travel });",
      "",
    ),
    app
      .replace(
        "useWorkspaceNavigationCommit(navigation, { place, travel });",
        "",
      )
      .replace(
        "useExchangeControllerFocus(exchangeController);",
        "useExchangeControllerFocus(exchangeController);\nuseWorkspaceNavigationCommit(navigation, { place, travel });",
      ),
  ])
    assert.ok(ownership(controller, changed).length > 0);
  assert.ok(
    ownership(
      controller.replace(
        "useLayoutEffect(() => focus.composer());",
        "useLayoutEffect(() => focus.composer(), []);",
      ),
      app,
    ).length > 0,
  );
});

test("controller gate rejects moved, duplicate or falsely bound inspector commit", () => {
  const commit = app.match(
    /  useSubjectInspectorCommit\(inspectorSelections, \{[\s\S]*?\n  \}\);/,
  )?.[0];
  assert.ok(commit, "actual migrated inspector seam exists");
  for (const changed of [
    app
      .replace(commit, "")
      .replace(
        "useExchangeControllerFocus(exchangeController);",
        `${commit}\nuseExchangeControllerFocus(exchangeController);`,
      ),
    app.replace(commit, `${commit}\n${commit}`),
    app.replace(
      commit,
      `const useSubjectInspectorCommit = () => {};\n${commit}`,
    ),
  ]) {
    assert.notEqual(changed, app);
    assert.ok(
      ownership(controller, changed).includes(
        "Inspector effects remain after explicit focus",
      ),
    );
  }
});
