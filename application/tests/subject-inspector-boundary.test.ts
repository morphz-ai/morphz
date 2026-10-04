import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inverseObjectAnnotationsFeature } from "./fixtures/object-annotations-consumption.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration as isPropertySignature,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
  type PropertySignatureDeclaration,
  type SourceFile,
} from "typescript/unstable/ast";

// A finite inspector ownership/consumption contract, not a whole-App purity,
// React scheduling, DOM identity or visual proof. The literal old formulas,
// memory effect and focus callback below come from fixed 85a50934, not the new
// owner. Independent old/new command traces and mounted Host tests cover the
// algorithms/update behavior; unrelated App JSX and resources are not frozen.
const path = "./host/use-subject-inspector.js";
const sources = {
  App: inverseObjectAnnotationsFeature(
    readFileSync("apps/web/src/App.tsx", "utf8"),
  ),
  Owner: readFileSync("apps/web/src/host/use-subject-inspector.ts", "utf8"),
};
const expectedText = `
function activity() { const [allActivity, setAllActivity] = useState(false); return {allActivity, setAllActivity}; }
function inspection() { const [executions, setExecutions] = useState<ExecutionScope | null>(null); const [understandingOpen, setUnderstandingOpen] = useState(false); return {executions, setExecutions, understandingOpen, setUnderstandingOpen}; }
function collaboration() { const [mobileCollaboration, setMobileCollaboration] = useState(false); return {mobileCollaboration, setMobileCollaboration}; }
function memory() { return useRef(new Map<string, InspectorSelection>()); }
function commit() {
  useLayoutEffect(() => {
    if (executions) inspectorSelections.current.set(contextKey, { view: "execution", scope: executions });
    else if (understandingOpen) inspectorSelections.current.set(contextKey, { view: "understanding" });
    else if (collaborationVisible) inspectorSelections.current.set(contextKey, { view: "collaboration" });
  }, [contextKey, executions, understandingOpen, collaborationVisible]);
}
function close() {
  return function closeInspector() {
    setExecutions(null); setUnderstandingOpen(false); setMobileCollaboration(false);
    prefer({ collaboration: false, subjectOpen: false }); onClosedFocus();
  };
}
function view() { return preferences.subjectOpen ? (preferences.subjectTab ?? "activity") : null; }
function visible() { return !executions && !subjectView && !understandingOpen && !!artifact && (compact ? mobileCollaboration : preferences.collaboration); }
function opened() { return !!executions || !!subjectView || understandingOpen || collaborationVisible; }
function presentation() {
  const inspectorTitle = understandingOpen ? "已发布摘要" : collaborationVisible ? "对象批注" : "Morphz 信息";
  const activityScope = executions ?? {projectId: conversationProjectId, conversationId, artifactId: null};
  return {inspectorTitle, activityScope};
}
const focus = () => { requestAnimationFrame(() => {
  const trigger = document.querySelector<HTMLElement>(".inspector-toggle");
  if (trigger?.getClientRects().length) trigger.focus();
  else (input.current ?? toggle.current)?.focus();
}); };
const activityBinding = {allActivity};
const inspectionBinding = {executions, setExecutions, understandingOpen, setUnderstandingOpen};
const collaborationBinding = {mobileCollaboration, setMobileCollaboration};
const closeOptions = {inspection: subjectInspection, collaboration: subjectCollaboration, prefer};
const commandsOptions = {
  activity: subjectActivity, inspection: subjectInspection, collaboration: subjectCollaboration,
  rememberedInspector, workspace: state, historyClient: client, preferences: prefs,
  conversationProjectId, conversationId, compact, prefer, keepExchangeOpen,
  onNotice: setNotice, close: closeInspector
};
const aliases = {openExecutions, openCollaboration, show: showInspector,
  selectSubject: selectSubjectView, openFromLogo: openSubjectFromLogo, inspectExecution};
const remembered = inspectorSelections.current.get(contextKey);
const commitArguments = {contextKey, executions, understandingOpen, collaborationVisible};
const visibleArguments = {executions, subjectView, understandingOpen, artifact, compact, mobileCollaboration, preferences: prefs};
const visibleWitness = !!artifact && subjectCollaborationVisible(visibleArguments);
const openArguments = {executions, subjectView, understandingOpen, collaborationVisible};
const presentationArguments = {executions, understandingOpen, collaborationVisible, conversationProjectId, conversationId};
const annotationDependencies = [artifact?.id, collaborationVisible, annotationRefresh, client.boot?.csrfToken, client.workspaceChangeRevision];
const keyboardDependencies = [interaction, dialogueCanvas, contextKey, creating, mobileCollaboration, executions, understandingOpen, collaborationVisible, speech];
type ReadPorts = {
  workspace: Pick<Workspace, "projects" | "inputs">;
  historyClient: Pick<WorkspaceClient, "loadHistoryUntil" | "getSnapshot">;
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
  const directory = "/subject-inspector-boundary";
  const config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [
      `${directory}/${name}.tsx`,
      text,
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
      "invalid syntax cannot satisfy a gate",
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
function syntax(node: Node): unknown {
  if (isParenthesizedExpression(node)) return syntax(node.expression);
  // TS's unary operator is a scalar, not a forEachChild token. Omitting it
  // would incorrectly equate Boolean coercion (!!) with numeric coercion (~~).
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
function within(parsed: Parsed, parent: Node) {
  return parsed.nodes.filter(
    (node) => node.pos >= parent.pos && node.end <= parent.end,
  );
}
function fn(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, `one ${name} function`);
  assert.ok(found[0]!.body);
  return found[0]!;
}
function boundName(node: Node, name: string) {
  let found = false;
  walk(node, (child) => {
    if (isIdentifier(child) && child.text === name) found = true;
  });
  return found;
}
function variable(parsed: Parsed, name: string, parent: Node = parsed.source) {
  const found = within(parsed, parent)
    .filter(isVariableDeclaration)
    .filter((node) => boundName(node.name, name));
  assert.equal(found.length, 1, `one ${name} declaration`);
  assert.ok(found[0]!.initializer);
  return found[0]!;
}
function property(node: Node, name: string) {
  assert.ok(
    isObjectLiteralExpression(node),
    "explicit object, not a setter bag/spread",
  );
  const found = node.properties.filter(
    (item) =>
      (isPropertyAssignment(item) || isShorthandPropertyAssignment(item)) &&
      item.name.getText() === name,
  );
  assert.equal(found.length, 1, `one ${name} property`);
  const item = found[0]!;
  assert.ok(isPropertyAssignment(item) || isShorthandPropertyAssignment(item));
  return isPropertyAssignment(item) ? item.initializer : item.name;
}
function imported(parsed: Parsed, module: string, name: string) {
  const matches: Identifier[] = [];
  for (const node of parsed.nodes.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== module ||
      node.importClause?.phaseModifier === SyntaxKind.TypeKeyword ||
      !node.importClause?.namedBindings ||
      !isNamedImports(node.importClause.namedBindings)
    )
      continue;
    for (const item of node.importClause.namedBindings.elements)
      if (!item.isTypeOnly && (item.propertyName ?? item.name).text === name)
        matches.push(item.name);
  }
  assert.equal(matches.length, 1, `one actual ${name} import`);
  const symbol = parsed.symbols.get(matches[0]!);
  assert.ok(symbol !== undefined, `${name} binding resolves`);
  return symbol;
}
function calls(parsed: Parsed, module: string, name: string) {
  const symbol = imported(parsed, module, name);
  return parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        parsed.symbols.get(node.expression) === symbol,
    );
}
function oneCall(parsed: Parsed, name: string) {
  const found = calls(parsed, path, name);
  assert.equal(found.length, 1, `one bound ${name} call`);
  return found[0]!;
}
function textCalls(parsed: Parsed, parent: Node, name: string) {
  return within(parsed, parent)
    .filter(isCallExpression)
    .filter(
      (node) => isIdentifier(node.expression) && node.expression.text === name,
    );
}
function contains(node: Node, name: string) {
  let found = false;
  walk(node, (child) => {
    if (isIdentifier(child) && child.text === name) found = true;
  });
  return found;
}
function ownership(contents = sources) {
  const parsed = parse({ ...contents, Expected: expectedText });
  const app = parsed.get("App")!,
    owner = parsed.get("Owner")!,
    expected = parsed.get("Expected")!;
  const workspace = fn(app, "WorkspaceApp");
  const problems: string[] = [];
  const rule = (name: string, check: () => void) => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      problems.push(name);
    }
  };
  rule("finite-dependencies-and-no-domain-dom-storage-owner", () => {
    const typePaths = new Set([
      "../../../../packages/core/src/execution.js",
      "../../../../packages/core/src/model.js",
      "../client.js",
      "../subject-sidebar-model.js",
    ]);
    for (const statement of owner.source.statements)
      assert.ok(
        isImportDeclaration(statement) ||
          isFunctionDeclaration(statement) ||
          isTypeAliasDeclaration(statement),
        "no module-global mutable store or initialization",
      );
    for (const node of owner.nodes) {
      if (isImportDeclaration(node)) {
        assert.ok(
          isStringLiteral(node.moduleSpecifier) &&
            node.importClause?.namedBindings &&
            isNamedImports(node.importClause.namedBindings) &&
            !node.importClause.name,
        );
        if (node.importClause.phaseModifier === SyntaxKind.TypeKeyword)
          assert.ok(typePaths.has(node.moduleSpecifier.text));
        else {
          assert.equal(node.moduleSpecifier.text, "react");
          assert.deepEqual(
            node.importClause.namedBindings.elements
              .filter((item) => !item.isTypeOnly)
              .map((item) => (item.propertyName ?? item.name).text)
              .sort(),
            ["useLayoutEffect", "useRef", "useState"],
          );
        }
      }
      assert.notEqual(node.kind, SyntaxKind.AnyKeyword, "real types, not any");
      assert.ok(
        !isJsxOpeningElement(node) && !isJsxSelfClosingElement(node),
        "no DOM wrapper",
      );
      if (isIdentifier(node))
        assert.ok(
          ![
            "document",
            "window",
            "requestAnimationFrame",
            "localStorage",
            "sessionStorage",
            "fetch",
            "WebSocket",
            "ResizeObserver",
            "useEffect",
            "useMemo",
            "useSyncExternalStore",
            "useCallback",
            "setPrefs",
            "writeLocal",
            "navigationGeneration",
            "latest",
            "getBoundingClientRect",
            "execute",
            "observe",
          ].includes(node.text),
          `unreviewed owner responsibility: ${node.text}`,
        );
    }
    assert.equal(calls(owner, "react", "useState").length, 4);
    assert.equal(calls(owner, "react", "useRef").length, 1);
    assert.equal(calls(owner, "react", "useLayoutEffect").length, 1);
  });
  rule("single-state-and-memory-registration", () => {
    for (const [actual, old] of Object.entries({
      useSubjectActivityState: "activity",
      useSubjectInspectionState: "inspection",
      useSubjectCollaborationState: "collaboration",
      useSubjectInspectorMemory: "memory",
    })) {
      same(fn(owner, actual).body, fn(expected, old).body);
      assert.equal(fn(owner, actual).parameters.length, 0);
      assert.equal(oneCall(app, actual).arguments.length, 0);
    }
    const moved = [
      "allActivity",
      "executions",
      "understandingOpen",
      "mobileCollaboration",
      "inspectorSelections",
    ];
    for (const field of moved) variable(app, field, workspace);
    for (const node of within(app, workspace).filter(isVariableDeclaration)) {
      if (!node.initializer) continue;
      const value = node.initializer;
      const isReactState =
        isCallExpression(value) &&
        (isIdentifier(value.expression)
          ? ["useState", "useRef"].includes(value.expression.text)
          : isPropertyAccessExpression(value.expression) &&
            ["useState", "useRef"].includes(value.expression.name.text));
      if (isReactState)
        assert.ok(
          !moved.some((field) => contains(node, field)) &&
            !contains(node, "InspectorSelection") &&
            !contains(node, "ExecutionScope"),
          "no mirrored inspector state/ref",
        );
    }
    for (const [name, group, shape] of [
      ["allActivity", "subjectActivity", "activityBinding"],
      ["executions", "subjectInspection", "inspectionBinding"],
      ["mobileCollaboration", "subjectCollaboration", "collaborationBinding"],
    ]) {
      const declaration = variable(app, name!, workspace);
      const shapeNode = variable(expected, shape!).initializer!;
      assert.ok(isObjectLiteralExpression(shapeNode));
      assert.deepEqual(syntax(declaration.name), [
        SyntaxKind.ObjectBindingPattern,
        shapeNode.properties.map((item) => {
          assert.ok(isShorthandPropertyAssignment(item));
          return [
            SyntaxKind.BindingElement,
            [[SyntaxKind.Identifier, item.name.getText()]],
          ];
        }),
      ]);
      assert.equal(declaration.initializer!.getText(), group);
    }
    assert.equal(
      variable(app, "inspectorSelections", workspace).initializer,
      oneCall(app, "useSubjectInspectorMemory"),
    );
    // Only the existing action snapshot reads this Map; writes belong to commit.
    const memoryUses = within(app, workspace)
      .filter(isPropertyAccessExpression)
      .filter(
        (node) =>
          node.name.text === "current" &&
          isIdentifier(node.expression) &&
          node.expression.text === "inspectorSelections",
      );
    assert.equal(memoryUses.length, 1);
    same(
      variable(app, "rememberedInspector", workspace).initializer,
      variable(expected, "remembered").initializer,
    );
  });
  rule("four-original-hook-seams-and-unique-call-bindings", () => {
    for (const [name, local, before, after] of [
      [
        "useSubjectActivityState",
        "subjectActivity",
        "notificationsOpen",
        "unreadNotifications",
      ],
      [
        "useSubjectInspectionState",
        "subjectInspection",
        "capture",
        "searchOpen",
      ],
      [
        "useSubjectCollaborationState",
        "subjectCollaboration",
        "compact",
        "personalSpace",
      ],
      [
        "useSubjectInspectorMemory",
        "inspectorSelections",
        "inspectorOpen",
        "resizeInspector",
      ],
    ]) {
      const call = oneCall(app, name!);
      assert.equal(variable(app, local!, workspace).initializer, call);
      assert.ok(variable(app, before!, workspace).end < call.pos);
      assert.ok(call.end < variable(app, after!, workspace).pos);
    }
    const group = oneCall(app, "useSubjectCollaborationState");
    const media = textCalls(app, workspace, "useEffect").filter((node) =>
      contains(node, "matchMedia"),
    );
    assert.equal(media.length, 1);
    assert.ok(group.end < media[0]!.pos);
    assert.equal(media[0]!.arguments[1]!.getText(), "[]");
    assert.ok(contains(media[0]!, "setMobileCollaboration"));
    const named = [
      "subjectInspectorView",
      "subjectCollaborationVisible",
      "subjectInspectorOpen",
      "subjectInspectorPresentation",
      "useSubjectInspectorCommit",
      "createSubjectInspectorCloseCommand",
      "createSubjectInspectorCommands",
    ];
    for (const name of named)
      assert.ok(
        oneCall(app, name).pos > workspace.pos &&
          oneCall(app, name).end < workspace.end,
      );
  });
  rule("original-memory-effect-priority-dependencies-and-commit-phase", () => {
    same(
      fn(owner, "useSubjectInspectorCommit").body,
      fn(expected, "commit").body,
    );
    const commit = oneCall(app, "useSubjectInspectorCommit");
    assert.equal(commit.arguments.length, 2);
    assert.equal(commit.arguments[0]!.getText(), "inspectorSelections");
    same(
      commit.arguments[1],
      variable(expected, "commitArguments").initializer,
    );
    const effects = textCalls(app, workspace, "useEffect");
    const annotation = effects.filter((node) =>
      contains(node, "listObjectAnnotations"),
    );
    const keyboard = effects.filter((node) => contains(node, "keyboard"));
    assert.equal(annotation.length, 1);
    assert.equal(keyboard.length, 1);
    same(
      annotation[0]!.arguments[1],
      variable(expected, "annotationDependencies").initializer,
    );
    same(
      keyboard[0]!.arguments[1],
      variable(expected, "keyboardDependencies").initializer,
    );
    const navigation = textCalls(
        app,
        workspace,
        "useWorkspaceNavigationCommit",
      ),
      focus = textCalls(app, workspace, "useExchangeControllerFocus");
    assert.equal(navigation.length, 1);
    assert.equal(focus.length, 1);
    assert.ok(
      navigation[0]!.end < focus[0]!.pos &&
        focus[0]!.end < annotation[0]!.pos &&
        annotation[0]!.end < commit.pos &&
        commit.end < keyboard[0]!.pos,
    );
    assert.ok(commit.end < variable(app, "resizeInspector", workspace).pos);
    assert.equal(
      within(app, workspace)
        .filter(isCallExpression)
        .filter(
          (node) =>
            (node.expression.getText() === "useLayoutEffect" ||
              node.expression.getText() === "useEffect") &&
            contains(node, "inspectorSelections"),
        ).length,
      0,
      "no second local memory effect",
    );
  });
  rule("pure-projections-and-artifact-narrowing-witness", () => {
    for (const [name, old] of Object.entries({
      subjectInspectorView: "view",
      subjectCollaborationVisible: "visible",
      subjectInspectorOpen: "opened",
      subjectInspectorPresentation: "presentation",
    }))
      same(fn(owner, name).body, fn(expected, old).body);
    assert.equal(
      variable(app, "subjectView", workspace).initializer,
      oneCall(app, "subjectInspectorView"),
    );
    assert.equal(
      oneCall(app, "subjectInspectorView").arguments[0]!.getText(),
      "prefs",
    );
    const visible = variable(
      app,
      "collaborationVisible",
      workspace,
    ).initializer!;
    const witness = variable(expected, "visibleWitness").initializer!;
    assert.ok(isBinaryExpression(visible) && isBinaryExpression(witness));
    same(visible.left, witness.left);
    assert.equal(
      visible.operatorToken.kind,
      SyntaxKind.AmpersandAmpersandToken,
    );
    assert.equal(visible.right, oneCall(app, "subjectCollaborationVisible"));
    same(
      oneCall(app, "subjectCollaborationVisible").arguments[0],
      variable(expected, "visibleArguments").initializer,
    );
    same(
      oneCall(app, "subjectInspectorOpen").arguments[0],
      variable(expected, "openArguments").initializer,
    );
    same(
      oneCall(app, "subjectInspectorPresentation").arguments[0],
      variable(expected, "presentationArguments").initializer,
    );
  });
  rule("synchronous-command-ports-original-captures-and-focus-in-app", () => {
    const close = oneCall(app, "createSubjectInspectorCloseCommand"),
      commands = oneCall(app, "createSubjectInspectorCommands");
    assert.equal(variable(app, "closeInspector", workspace).initializer, close);
    assert.equal(
      variable(app, "subjectInspector", workspace).initializer,
      commands,
    );
    same(
      commands.arguments[0],
      variable(expected, "commandsOptions").initializer,
    );
    assert.equal(commands.arguments.length, 1);
    assert.equal(close.arguments.length, 1);
    const closeOptions = close.arguments[0]!;
    assert.ok(isObjectLiteralExpression(closeOptions));
    assert.equal(closeOptions.properties.length, 4);
    for (const name of ["inspection", "collaboration", "prefer"])
      same(
        property(closeOptions, name),
        property(variable(expected, "closeOptions").initializer!, name),
      );
    same(
      property(closeOptions, "onClosedFocus"),
      variable(expected, "focus").initializer,
    );
    assert.ok(
      oneCall(app, "useSubjectInspectorCommit").end < close.pos &&
        close.end < variable(app, "surfaceDraft", workspace).pos,
    );
    const startup = within(app, workspace)
      .filter(isIfStatement)
      .filter(
        (node) =>
          node.expression.getText().replace(/\s/g, "") === "!state||!project",
      );
    assert.equal(startup.length, 1);
    assert.ok(close.end < startup[0]!.pos && startup[0]!.end < commands.pos);
    assert.ok(
      variable(app, "rememberedInspector", workspace).end < commands.pos,
    );
    same(
      fn(owner, "createSubjectInspectorCloseCommand").body,
      fn(expected, "close").body,
    );
    for (const name of [
      "createSubjectInspectorCloseCommand",
      "createSubjectInspectorCommands",
    ]) {
      const factory = fn(owner, name);
      assert.ok(
        !factory.modifiers?.some(
          (modifier) => modifier.kind === SyntaxKind.AsyncKeyword,
        ),
      );
      // Construction may register closures and return ports, never invoke them.
      for (const statement of factory.body!.statements) {
        assert.ok(
          isVariableStatement(statement) ||
            isFunctionDeclaration(statement) ||
            isReturnStatement(statement),
        );
        if (isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            assert.ok(
              declaration.initializer &&
                (isArrowFunction(declaration.initializer) ||
                  isFunctionExpression(declaration.initializer)),
            );
      }
    }
    const factory = fn(owner, "createSubjectInspectorCommands");
    const portTypes = factory.parameters[0]!.type;
    const readPorts = expected.nodes
      .filter(isTypeAliasDeclaration)
      .find((node) => node.name.text === "ReadPorts")?.type;
    assert.ok(
      portTypes &&
        isTypeLiteralNode(portTypes) &&
        readPorts &&
        isTypeLiteralNode(readPorts),
    );
    for (const member of readPorts.members) {
      assert.ok(isPropertySignature(member));
      const actual: PropertySignatureDeclaration[] = portTypes.members
        .filter(isPropertySignature)
        .filter((node) => node.name.getText() === member.name.getText());
      assert.equal(actual.length, 1);
      same(actual[0]!.type, member.type);
    }
    const returns = factory.body!.statements.filter(isReturnStatement);
    assert.equal(returns.length, 1);
    assert.ok(returns[0]!.expression);
    assert.ok(isObjectLiteralExpression(returns[0]!.expression));
    assert.deepEqual(
      returns[0]!.expression.properties.map((node) => {
        assert.ok(
          isPropertyAssignment(node) || isShorthandPropertyAssignment(node),
        );
        return node.name.getText();
      }),
      [
        "close",
        "openExecutions",
        "openCollaboration",
        "show",
        "selectSubject",
        "openFromLogo",
        "inspectExecution",
        "back",
        "selectScope",
        "toggleCollaboration",
        "selectExecution",
        "setAllActivity",
      ],
    );
    assert.equal(
      property(returns[0]!.expression, "selectExecution").getText(),
      "setExecutions",
    );
    assert.equal(
      property(returns[0]!.expression, "setAllActivity").getText(),
      "setAllActivity",
    );
    assert.equal(property(returns[0]!.expression, "close").getText(), "close");
    const aliases = variable(app, "showInspector", workspace);
    assert.equal(aliases.initializer!.getText(), "subjectInspector");
    const oldAlias = variable(expected, "aliases").initializer!;
    assert.ok(isObjectLiteralExpression(oldAlias));
    assert.deepEqual(
      within(app, aliases.name)
        .filter(isBindingElement)
        .map((node) => {
          assert.ok(node.name);
          return [
            node.propertyName?.getText() ?? node.name.getText(),
            node.name.getText(),
          ];
        }),
      oldAlias.properties.map((node) => {
        assert.ok(
          isPropertyAssignment(node) || isShorthandPropertyAssignment(node),
        );
        return [
          node.name.getText(),
          isPropertyAssignment(node)
            ? node.initializer.getText()
            : node.name.getText(),
        ];
      }),
    );
  });
  rule("actual-six-consumer-bindings-and-original-row-setter-identity", () => {
    const declaration = variable(app, "subjectInspector", workspace);
    assert.ok(isIdentifier(declaration.name));
    const symbol = app.symbols.get(declaration.name);
    assert.ok(symbol !== undefined);
    for (const [tag, attribute, member] of [
      ["WorkspaceTopbar", "onToggleCollaboration", "toggleCollaboration"],
      ["SubjectSidebar", "onBack", "back"],
      ["SubjectSidebar", "onInspect", "selectScope"],
      ["ExecutionSidebar", "onAllWorkChange", "setAllActivity"],
      ["ExecutionSidebar", "onSelect", "selectExecution"],
      ["SubjectObjectives", "onSelect", "selectExecution"],
    ]) {
      const attributes = within(app, workspace)
        .filter(isJsxAttribute)
        .filter(
          (node) =>
            node.name.getText() === attribute &&
            (isJsxOpeningElement(node.parent.parent) ||
              isJsxSelfClosingElement(node.parent.parent)) &&
            node.parent.parent.tagName.getText() === tag,
        );
      assert.equal(attributes.length, 1);
      const attributeNode = attributes[0]!;
      assert.ok(
        attributeNode.initializer && isJsxExpression(attributeNode.initializer),
      );
      const expression = attributeNode.initializer.expression;
      assert.ok(
        expression &&
          isPropertyAccessExpression(expression) &&
          isIdentifier(expression.expression),
      );
      assert.equal(app.symbols.get(expression.expression), symbol);
      assert.equal(expression.name.text, member);
    }
  });
  return problems;
}

test("subject inspector owns state, provenance memory and semantic commands at original host seams", () => {
  assert.deepEqual(ownership(), []);
});
test("subject inspector gate permits comments/formatting and unrelated host/feature evolution", () => {
  assert.deepEqual(
    ownership({
      App:
        sources.App.replace(
          "const subjectInspector =",
          "/* harmless comment */\nconst subjectInspector =",
        ) + "\nfunction unrelatedFeature() { return 42; }",
      Owner: sources.Owner.replace(
        "return { allActivity, setAllActivity };",
        "return {\n allActivity,\n setAllActivity\n};",
      ),
    }),
    [],
  );
});
function changed(source: string, from: string, to: string) {
  assert.ok(source.includes(from), `counterfactual seam exists: ${from}`);
  return source.replace(from, to);
}
test("subject inspector gate rejects actual binding, mirror and side-effect counterfactuals", () => {
  const cases: [string, keyof typeof sources, string, string][] = [
    [
      "four-original-hook-seams-and-unique-call-bindings",
      "App",
      path,
      "./host/fake-subject-inspector.js",
    ],
    [
      "four-original-hook-seams-and-unique-call-bindings",
      "App",
      "const subjectActivity = useSubjectActivityState();",
      "const useSubjectActivityState = () => ({ allActivity: false });\nconst subjectActivity = useSubjectActivityState();",
    ],
    [
      "single-state-and-memory-registration",
      "App",
      "const { allActivity } = subjectActivity;",
      "const { allActivity } = subjectActivity;\nconst mirror = useState(allActivity);",
    ],
    [
      "single-state-and-memory-registration",
      "App",
      "const { allActivity } = subjectActivity;",
      "const { allActivity } = subjectActivity;\nconst mirror = React.useState(executions);",
    ],
    [
      "single-state-and-memory-registration",
      "Owner",
      "useState(false)",
      "useState(true)",
    ],
    [
      "finite-dependencies-and-no-domain-dom-storage-owner",
      "Owner",
      "import { useLayoutEffect",
      'import "../ui.css";\nimport { useLayoutEffect',
    ],
    [
      "finite-dependencies-and-no-domain-dom-storage-owner",
      "Owner",
      "type InspectorSelection =",
      "const secondMemory = new Map();\ntype InspectorSelection =",
    ],
    [
      "finite-dependencies-and-no-domain-dom-storage-owner",
      "Owner",
      "onClosedFocus();",
      'document.querySelector(".inspector-toggle")?.focus();\nonClosedFocus();',
    ],
    [
      "finite-dependencies-and-no-domain-dom-storage-owner",
      "Owner",
      'workspace: Pick<Workspace, "projects" | "inputs">;',
      "workspace: any;",
    ],
    [
      "synchronous-command-ports-original-captures-and-focus-in-app",
      "Owner",
      'historyClient: Pick<WorkspaceClient, "loadHistoryUntil" | "getSnapshot">;',
      "historyClient: WorkspaceClient;",
    ],
    [
      "synchronous-command-ports-original-captures-and-focus-in-app",
      "Owner",
      "const openExecutions = () => {",
      "prefer({ subjectOpen: true });\nconst openExecutions = () => {",
    ],
    [
      "synchronous-command-ports-original-captures-and-focus-in-app",
      "Owner",
      "selectExecution: setExecutions,",
      "selectExecution: (scope: ExecutionScope) => setExecutions(scope),",
    ],
    [
      "synchronous-command-ports-original-captures-and-focus-in-app",
      "App",
      "workspace: state,\n    historyClient: client,",
      "workspace: { ...state },\n    historyClient: client,",
    ],
    [
      "synchronous-command-ports-original-captures-and-focus-in-app",
      "App",
      "close: closeInspector,",
      "close: () => closeInspector(),",
    ],
    [
      "synchronous-command-ports-original-captures-and-focus-in-app",
      "App",
      'document.querySelector<HTMLElement>(".inspector-toggle")',
      'document.querySelector<HTMLElement>(".composer")',
    ],
    [
      "actual-six-consumer-bindings-and-original-row-setter-identity",
      "App",
      "onSelect={subjectInspector.selectExecution}",
      "onSelect={subjectInspector.selectScope}",
    ],
    [
      "actual-six-consumer-bindings-and-original-row-setter-identity",
      "App",
      "onBack={subjectInspector.back}",
      "onBack={() => subjectInspector.back()}",
    ],
    [
      "actual-six-consumer-bindings-and-original-row-setter-identity",
      "App",
      "onInspect={subjectInspector.selectScope}",
      "onInspect={unrelated.selectScope}",
    ],
  ];
  for (const [rule, file, from, to] of cases)
    assert.ok(
      ownership({
        ...sources,
        [file]: changed(sources[file], from, to),
      }).includes(rule),
      `${file}: ${rule}`,
    );
});
test("subject inspector gate rejects memory priority/dependency changes and relocated registration", () => {
  const cases: [string, keyof typeof sources, string, string][] = [
    [
      "original-memory-effect-priority-dependencies-and-commit-phase",
      "Owner",
      "[contextKey, executions, understandingOpen, collaborationVisible]",
      "[contextKey, inspection.executions, understandingOpen, collaborationVisible]",
    ],
    [
      "original-memory-effect-priority-dependencies-and-commit-phase",
      "Owner",
      "[contextKey, executions, understandingOpen, collaborationVisible]",
      "[executions, contextKey, understandingOpen, collaborationVisible]",
    ],
    [
      "original-memory-effect-priority-dependencies-and-commit-phase",
      "Owner",
      "if (executions)",
      "if (subjectView === 'activity' && executions)",
    ],
    [
      "original-memory-effect-priority-dependencies-and-commit-phase",
      "App",
      "useSubjectInspectorCommit(inspectorSelections, {",
      "fakeCommit(inspectorSelections, {",
    ],
    [
      "original-memory-effect-priority-dependencies-and-commit-phase",
      "App",
      "useSubjectInspectorCommit(inspectorSelections, {",
      "useSubjectInspectorCommit(inspectorSelections, {});\nuseSubjectInspectorCommit(inspectorSelections, {",
    ],
    [
      "four-original-hook-seams-and-unique-call-bindings",
      "App",
      "const subjectActivity = useSubjectActivityState();",
      "const subjectActivity = useSubjectActivityState();\nconst extra = useSubjectInspectionState();",
    ],
    [
      "pure-projections-and-artifact-narrowing-witness",
      "Owner",
      'preferences.subjectTab ?? "activity"',
      'preferences.subjectTab ?? "settings"',
    ],
    [
      "pure-projections-and-artifact-narrowing-witness",
      "Owner",
      "!executions &&",
      "~executions &&",
    ],
    [
      "pure-projections-and-artifact-narrowing-witness",
      "Owner",
      "!!executions || !!subjectView",
      "~~executions || !!subjectView",
    ],
    [
      "pure-projections-and-artifact-narrowing-witness",
      "Owner",
      "!!executions || !!subjectView",
      "!!executions && !!subjectView",
    ],
    [
      "pure-projections-and-artifact-narrowing-witness",
      "App",
      "!!artifact &&\n    subjectCollaborationVisible",
      "~~artifact &&\n    subjectCollaborationVisible",
    ],
    [
      "pure-projections-and-artifact-narrowing-witness",
      "App",
      "!!artifact &&\n    subjectCollaborationVisible",
      "Boolean(artifact) &&\n    subjectCollaborationVisible",
    ],
    [
      "pure-projections-and-artifact-narrowing-witness",
      "App",
      "!!artifact &&\n    subjectCollaborationVisible",
      "!!artifact && customGuard &&\n    subjectCollaborationVisible",
    ],
  ];
  for (const [rule, file, from, to] of cases)
    assert.ok(
      ownership({
        ...sources,
        [file]: changed(sources[file], from, to),
      }).includes(rule),
      `${file}: ${rule}`,
    );
  const commit = sources.App.match(
    /  useSubjectInspectorCommit\(inspectorSelections, \{[\s\S]*?\n  \}\);/,
  )?.[0];
  assert.ok(commit);
  const relocated = changed(
    changed(sources.App, commit, ""),
    "  useExchangeControllerFocus(exchangeController);",
    `${commit}\n  useExchangeControllerFocus(exchangeController);`,
  );
  assert.ok(
    ownership({ ...sources, App: relocated }).includes(
      "original-memory-effect-priority-dependencies-and-commit-phase",
    ),
  );
});
