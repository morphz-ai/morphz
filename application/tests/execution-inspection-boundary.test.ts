import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxExpression,
  isJsxElement,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type BindingElement,
  type FunctionDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { executionInspectionOriginal as fixed } from "./fixtures/execution-inspection-114960d1.js";

// Complete feature-local inspection lifecycle, not a whole current renderer,
// App/Client hash, historical inverse chain or generic hook architecture engine.
// Actual React phases, StrictMode, observation and native modality have separate
// mounted tests. The standalone actual-Git source proof stays outside normal CI.
const paths = {
  Controller: "../apps/web/src/features/execution/useExecutionInspection.ts",
  Dialog: "../apps/web/src/ExecutionDialog.tsx",
  Observed: "../apps/web/src/useObservedRead.ts",
  Modal: "../apps/web/src/useModal.ts",
} as const;
type Sources = Record<keyof typeof paths, string>;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  symbols: Map<Node, number | undefined>;
  shorthandValues: Map<Node, number | undefined>;
};
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const returnedNames = [
  "snapshot",
  "error",
  "busy",
  "notice",
  "result",
  "producedId",
  "refresh",
  "control",
  "readResult",
] as const;
const clientFields = [
  "boot",
  "online",
  "workspaceChangeRevision",
  "executionSnapshot",
  "executionResult",
  "controlExecution",
  "contentCatalog",
];
const statementNames = [
  "refs",
  "publishApi",
  "feedbackStates",
  "resultState",
  "observationScope",
  "currentScope",
  "publishScope",
  "snapshot",
  "observation",
  "modal",
  "retirement",
  "control",
  "readResult",
  "producedDeclaration",
  "producedProjection",
] as const;
const originalRefs = parse({ Refs: fixed.spans.refs.raw })
  .get("Refs")!
  .nodes.filter(isVariableDeclaration);
const expectedBody = statementNames
  .map((name) =>
    name === "refs"
      ? `const ${originalRefs
          .slice(1)
          .map((node) => node.getText())
          .join(", ")};`
      : fixed.spans[name].raw,
  )
  .join("\n");
const templates = parse({
  Controller: `function useExecutionInspection() {${expectedBody}\nreturn {${returnedNames.join(",")}};}`,
  DialogRef: `const ${fixed.spans.dialogDeclaration.raw};`,
  Options: `function expected({client,scope,dialog,embedded}: {
    client: Pick<WorkspaceClient,"boot"|"online"|"workspaceChangeRevision"|"executionSnapshot"|"executionResult"|"controlExecution"|"contentCatalog">;
    scope: ExecutionScope; dialog: RefObject<HTMLDialogElement|null>; embedded:boolean;
  }) {}`,
  Consumer: `const {${returnedNames.join(",")}} = useExecutionInspection({client,scope,dialog,embedded});`,
  Original: fixed.originalComponent.raw,
});
function inside(node: Node) {
  const nodes: Node[] = [];
  function walk(value: Node) {
    nodes.push(value);
    value.forEachChild((child) => {
      walk(child);
    });
  }
  walk(node);
  return nodes;
}
function parse(contents: Record<string, string>) {
  const directory = "/inspection-boundary",
    config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([key, value]) => [
      `${directory}/${key}.tsx`,
      value,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((key) => `${key}.tsx`),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal parsed source/counterfactual",
    );
    const result = new Map<string, Parsed>();
    for (const key of Object.keys(contents)) {
      const source = project.program.getSourceFile(`${directory}/${key}.tsx`)!;
      const nodes = inside(source),
        identifiers = nodes.filter(isIdentifier);
      const resolved = project.checker.getSymbolAtLocation(identifiers);
      const symbols = new Map<Node, number | undefined>();
      identifiers.forEach((node, index) =>
        symbols.set(node, resolved[index]?.id),
      );
      const shorthandValues = new Map<Node, number | undefined>();
      for (const property of nodes.filter(isShorthandPropertyAssignment))
        shorthandValues.set(
          property,
          project.checker.getShorthandAssignmentValueSymbol(property)?.id,
        );
      result.set(key, { source, nodes, symbols, shorthandValues });
    }
    return result;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function shape(
  node: Node,
  names = new Map<number, string>(),
  parsed?: Parsed,
): unknown {
  if (node.kind === SyntaxKind.JsxText && !node.getText().trim())
    return undefined;
  const children: unknown[] = [];
  node.forEachChild((child) => {
    const value = shape(child, names, parsed);
    if (value !== undefined) children.push(value);
  });
  const symbol = parsed?.symbols.get(node);
  return [
    node.kind,
    node.flags &
      (NodeFlags.Const |
        NodeFlags.Let |
        NodeFlags.Using |
        NodeFlags.OptionalChain),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length
      ? children
      : symbol !== undefined && names.has(symbol)
        ? names.get(symbol)
        : isStringLiteral(node)
          ? node.text
          : node.getText(),
  ];
}
function fn(parsed: Parsed, name: string): FunctionDeclaration {
  const matches = parsed.source.statements
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(matches.length, 1, `single-inspection-declaration:${name}`);
  assert.ok(matches[0]!.body, `single-inspection-declaration:${name}`);
  return matches[0]!;
}
function imported(
  parsed: Parsed,
  module: string,
  name: string,
  typeOnly = false,
) {
  const matches = parsed.source.statements
    .filter(isImportDeclaration)
    .flatMap((node) => {
      if (
        !isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== module
      )
        return [];
      const clause = node.importClause;
      if (!clause?.namedBindings || !isNamedImports(clause.namedBindings))
        return [];
      return clause.namedBindings.elements
        .filter(
          (entry) =>
            (entry.propertyName ?? entry.name).text === name &&
            (clause.phaseModifier === SyntaxKind.TypeKeyword ||
              entry.isTypeOnly) === typeOnly,
        )
        .map((entry) => entry.name);
    });
  assert.equal(
    matches.length,
    1,
    `${typeOnly ? "type-only-inspection-port" : "actual-inspection-import"}:${name}`,
  );
  assert.notEqual(
    parsed.symbols.get(matches[0]!),
    undefined,
    `actual-inspection-symbol:${name}`,
  );
  return matches[0]!;
}
function canonicalImports(parsed: Parsed, owner: boolean) {
  const names = new Map<number, string>();
  const bindings = owner
    ? [
        ["react", "useRef"],
        ["react", "useState"],
        ["react", "useEffect"],
        ["../../useObservedRead.js", "useObservedRead"],
        ["../../useModal.js", "useModal"],
      ]
    : [
        ["react", "useRef"],
        [
          "./features/execution/useExecutionInspection.js",
          "useExecutionInspection",
        ],
      ];
  for (const [module, name] of bindings) {
    const binding = imported(parsed, module!, name!);
    names.set(parsed.symbols.get(binding)!, name!);
  }
  if (owner)
    for (const [module, name] of [
      ["react", "RefObject"],
      ["../../client.js", "WorkspaceClient"],
      ...["ExecutionScope", "ExecutionSnapshot", "ExecutionControl"].map(
        (name) => ["../../../../../packages/core/src/execution.js", name],
      ),
    ]) {
      const binding = imported(parsed, module!, name!, true);
      names.set(parsed.symbols.get(binding)!, name!);
    }
  return names;
}
function compare(
  actual: Node,
  expected: Node,
  rule: string,
  parsed: Parsed,
  names: Map<number, string>,
) {
  assert.deepEqual(shape(actual, names, parsed), shape(expected), rule);
}
function ownerDependencies(parsed: Parsed) {
  const runtimeModules = [
    "react",
    "../../useObservedRead.js",
    "../../useModal.js",
  ];
  for (const declaration of parsed.source.statements.filter(
    isImportDeclaration,
  )) {
    const clause = declaration.importClause;
    const entries =
      clause?.namedBindings && isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements
        : undefined;
    if (
      clause?.phaseModifier === SyntaxKind.TypeKeyword ||
      (entries?.length && entries.every((entry) => entry.isTypeOnly))
    )
      continue;
    assert.ok(
      isStringLiteral(declaration.moduleSpecifier) &&
        (runtimeModules.includes(declaration.moduleSpecifier.text) ||
          /^\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/packages\/core\/src\/(?:application-names|model|execution|script-studio)\.js$/.test(
            declaration.moduleSpecifier.text,
          )),
      "inspection-owned-dependencies",
    );
    assert.ok(
      clause && !clause.name && entries,
      "inspection-owned-dependencies",
    );
    if (
      isStringLiteral(declaration.moduleSpecifier) &&
      declaration.moduleSpecifier.text === "react"
    )
      assert.ok(
        entries.every(
          (entry) =>
            entry.isTypeOnly ||
            ["useEffect", "useRef", "useState"].includes(
              (entry.propertyName ?? entry.name).text,
            ),
        ),
        "inspection-owned-dependencies",
      );
  }
  for (const call of parsed.nodes.filter(isCallExpression))
    assert.ok(
      call.expression.kind !== SyntaxKind.ImportKeyword &&
        !/^(?:fetch|require|setInterval|setTimeout|requestAnimationFrame|queueMicrotask)$/.test(
          call.expression.getText(),
        ) &&
        !/^(?:applicationCall|localStorage|sessionStorage|document|window)\b/.test(
          call.expression.getText(),
        ),
      "inspection-owned-dependencies",
    );
  // Only executable module initializers/actions, not field names, type shapes
  // or unrelated pure exports. The original controller body is checked below.
  for (const statement of parsed.source.statements) {
    const initializers = isVariableStatement(statement)
      ? statement.declarationList.declarations.flatMap((node) =>
          node.initializer ? [node.initializer] : [],
        )
      : isExpressionStatement(statement)
        ? [statement.expression]
        : [];
    for (const initializer of initializers)
      for (const node of inside(initializer).filter(isIdentifier)) {
        if (
          ![
            "document",
            "window",
            "navigator",
            "localStorage",
            "sessionStorage",
            "globalThis",
          ].includes(node.text)
        )
          continue;
        if (
          (isPropertyAccessExpression(node.parent) ||
            isPropertyAssignment(node.parent)) &&
          node.parent.name === node
        )
          continue;
        const symbol = isShorthandPropertyAssignment(node.parent)
          ? parsed.shorthandValues.get(node.parent)
          : parsed.symbols.get(node);
        assert.notEqual(
          symbol,
          undefined,
          "inspection-owned-ambient-initialization",
        );
      }
  }
}
function resolveClientType(type: Node, parsed: Parsed): Node {
  if (
    isTypeReferenceNode(type) &&
    isIdentifier(type.typeName) &&
    type.typeArguments === undefined
  ) {
    const aliases = parsed.source.statements
      .filter(isTypeAliasDeclaration)
      .filter((node) => node.name.text === type.typeName.getText());
    assert.equal(aliases.length, 1, "exact-inspection-client-pick");
    return aliases[0]!.type;
  }
  return type;
}
function inputs(
  owner: Parsed,
  hook: FunctionDeclaration,
  names: Map<number, string>,
) {
  assert.equal(hook.parameters.length, 1, "borrowed-four-inspection-inputs");
  const parameter = hook.parameters[0]!;
  assert.ok(
    isObjectBindingPattern(parameter.name) &&
      parameter.type &&
      isTypeLiteralNode(parameter.type) &&
      !parameter.initializer &&
      !parameter.questionToken,
    "borrowed-four-inspection-inputs",
  );
  assert.deepEqual(
    shape(parameter.name),
    shape(fn(templates.get("Options")!, "expected").parameters[0]!.name),
    "borrowed-four-inspection-inputs",
  );
  const properties = parameter.type.members.filter(
    isPropertySignatureDeclaration,
  );
  assert.equal(
    properties.length,
    parameter.type.members.length,
    "borrowed-four-inspection-inputs",
  );
  assert.deepEqual(
    properties.map((node) => node.name?.getText()),
    ["client", "scope", "dialog", "embedded"],
    "borrowed-four-inspection-inputs",
  );
  const expected = fn(templates.get("Options")!, "expected").parameters[0]!
    .type;
  assert.ok(expected && isTypeLiteralNode(expected));
  for (const index of [1, 2, 3])
    compare(
      properties[index]!,
      expected.members[index]!,
      "typed-borrowed-inspection-inputs",
      owner,
      names,
    );
  const client = properties[0]!;
  assert.ok(
    client.type && !client.postfixToken && !client.modifiers?.length,
    "exact-inspection-client-pick",
  );
  const type = resolveClientType(client.type, owner);
  assert.ok(
    isTypeReferenceNode(type) &&
      type.typeName.getText() === "Pick" &&
      type.typeArguments?.length === 2,
    "exact-inspection-client-pick",
  );
  assert.equal(
    names.get(
      owner.symbols.get(inside(type.typeArguments[0]!).find(isIdentifier)!)!,
    ),
    "WorkspaceClient",
    "exact-inspection-client-pick",
  );
  assert.ok(
    isUnionTypeNode(type.typeArguments[1]!),
    "exact-inspection-client-pick",
  );
  assert.deepEqual(
    type.typeArguments[1]!.types.map((node) =>
      node.getText().replace(/^['"]|['"]$/g, ""),
    ),
    clientFields,
    "exact-inspection-client-pick",
  );
  const clientBinding = imported(
    owner,
    "../../client.js",
    "WorkspaceClient",
    true,
  );
  const clientTypeReference = inside(type.typeArguments[0]!).find(
    isIdentifier,
  )!;
  assert.equal(
    owner.symbols.get(clientTypeReference),
    owner.symbols.get(clientBinding),
    "actual-type-only-client-binding",
  );
  imported(owner, "react", "RefObject", true);
  for (const name of [
    "ExecutionScope",
    "ExecutionSnapshot",
    "ExecutionControl",
  ])
    imported(
      owner,
      "../../../../../packages/core/src/execution.js",
      name,
      true,
    );
  assert.ok(
    !owner.source.statements
      .filter(isTypeAliasDeclaration)
      .some((node) => node.name.text === "Pick"),
    "exact-inspection-client-pick",
  );
}
function registration(call: Node, parsed: Parsed, names: Map<number, string>) {
  assert.ok(isCallExpression(call));
  const identity = parsed.symbols.get(call.expression);
  const name =
    identity !== undefined && names.has(identity)
      ? names.get(identity)!
      : call.expression.getText();
  return name === "useEffect" || name === "useLayoutEffect"
    ? [name, call.arguments.slice(1).map((node) => shape(node, names, parsed))]
    : [
        name,
        call.typeArguments?.map((node) => shape(node, names, parsed)),
        call.arguments.map((node) => shape(node, names, parsed)),
      ];
}
function primitiveCalls(
  node: Node,
  parsed?: Parsed,
  names = new Map<number, string>(),
) {
  return inside(node)
    .filter(isCallExpression)
    .filter((call) =>
      ["useRef", "useState", "useEffect", "useLayoutEffect"].includes(
        parsed
          ? (names.get(parsed.symbols.get(call.expression)!) ?? "")
          : call.expression.getText(),
      ),
    );
}
function helperReactImports(parsed: Parsed) {
  const names = new Map<number, string>();
  for (const declaration of parsed.source.statements.filter(
    isImportDeclaration,
  )) {
    if (
      !isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== "react"
    )
      continue;
    const clause = declaration.importClause;
    if (!clause?.namedBindings || !isNamedImports(clause.namedBindings))
      continue;
    for (const entry of clause.namedBindings.elements) {
      const name = (entry.propertyName ?? entry.name).text;
      if (
        !["useRef", "useState", "useEffect", "useLayoutEffect"].includes(name)
      )
        continue;
      const binding = imported(parsed, "react", name);
      names.set(parsed.symbols.get(binding)!, name);
    }
  }
  return names;
}
function flattened(
  dialog: Parsed,
  controller: Parsed,
  observed: Parsed,
  modal: Parsed,
) {
  const names = canonicalImports(controller, true),
    output: unknown[] = [];
  const dialogNames = canonicalImports(dialog, false);
  const observedNames = helperReactImports(observed),
    modalNames = helperReactImports(modal);
  const component = fn(dialog, "ExecutionDialog"),
    hook = fn(controller, "useExecutionInspection");
  const first = inside(component.body!.statements[0]!).find(isCallExpression)!;
  output.push(registration(first, dialog, dialogNames));
  for (const call of inside(hook).filter(isCallExpression)) {
    const symbol = controller.symbols.get(call.expression),
      name =
        symbol !== undefined && names.has(symbol)
          ? names.get(symbol)!
          : call.expression.getText();
    if (["useRef", "useState", "useEffect"].includes(name))
      output.push(registration(call, controller, names));
    if (name === "useObservedRead")
      for (const child of primitiveCalls(
        fn(observed, "useObservedRead"),
        observed,
        observedNames,
      ))
        output.push(registration(child, observed, observedNames));
    if (name === "useModal")
      for (const child of primitiveCalls(
        fn(modal, "useModal"),
        modal,
        modalNames,
      ))
        output.push(registration(child, modal, modalNames));
  }
  return output;
}
function expectedRegistrations() {
  const parsed = parse({
    Original: fixed.originalComponent.raw,
    Observed: fixed.registrations.observed.map((span) => span.raw).join(";\n"),
    Modal: fixed.registrations.modal.map((span) => span.raw).join(";\n"),
  });
  const output: unknown[] = [];
  for (const call of inside(
    fn(parsed.get("Original")!, "ExecutionDialog"),
  ).filter(isCallExpression)) {
    if (["useRef", "useState", "useEffect"].includes(call.expression.getText()))
      output.push(registration(call, parsed.get("Original")!, new Map()));
    if (call.expression.getText() === "useObservedRead")
      for (const child of primitiveCalls(parsed.get("Observed")!.source))
        output.push(registration(child, parsed.get("Observed")!, new Map()));
    if (call.expression.getText() === "useModal")
      for (const child of primitiveCalls(parsed.get("Modal")!.source))
        output.push(registration(child, parsed.get("Modal")!, new Map()));
  }
  assert.equal(output.length, 17, "fixed original 17 primitive registrations");
  return output;
}
const originalRegistrations = expectedRegistrations();
function validate(contents: Sources) {
  const parsed = parse(contents),
    owner = parsed.get("Controller")!,
    dialog = parsed.get("Dialog")!;
  ownerDependencies(owner);
  const hook = fn(owner, "useExecutionInspection"),
    component = fn(dialog, "ExecutionDialog"),
    names = canonicalImports(owner, true),
    dialogNames = canonicalImports(dialog, false);
  const ownedNodes = new Set(inside(hook));
  for (const call of owner.nodes.filter(isCallExpression)) {
    const name = names.get(owner.symbols.get(call.expression)!);
    if (
      name &&
      [
        "useRef",
        "useState",
        "useEffect",
        "useObservedRead",
        "useModal",
      ].includes(name)
    )
      assert.ok(ownedNodes.has(call), "owned-inspection-registration-location");
  }
  assert.ok(
    hook.modifiers?.some((node) => node.kind === SyntaxKind.ExportKeyword) &&
      !hook.modifiers?.some((node) => node.kind === SyntaxKind.AsyncKeyword) &&
      !hook.asteriskToken &&
      !hook.typeParameters?.length,
    "synchronous-module-scope-inspection-hook",
  );
  assert.ok(
    !component.asteriskToken &&
      !component.modifiers?.some(
        (node) => node.kind === SyntaxKind.AsyncKeyword,
      ),
    "synchronous-inspection-renderer-declaration",
  );
  inputs(owner, hook, names);
  const body = hook.body!.statements,
    expected = fn(templates.get("Controller")!, "useExecutionInspection").body!
      .statements;
  assert.equal(
    body.length,
    expected.length,
    "complete-original-inspection-boundary",
  );
  for (const [index, method] of [
    [8, "useObservedRead"],
    [9, "useModal"],
    [10, "useEffect"],
  ] as const) {
    const calls = inside(body[index]!).filter(isCallExpression);
    const call = calls[0]!;
    assert.ok(
      call &&
        isIdentifier(call.expression) &&
        names.get(owner.symbols.get(call.expression)!) === method,
      "read-modal-retirement-order",
    );
  }
  for (const index of [0, 2, 3, 5])
    compare(
      body[index]!,
      expected[index]!,
      "original-inspection-state-ref-registrations",
      owner,
      names,
    );
  for (const index of [1, 6])
    compare(
      body[index]!,
      expected[index]!,
      "latest-ref-publication-before-passive-cleanup",
      owner,
      names,
    );
  compare(body[4]!, expected[4]!, "render-scope-key-capture", owner, names);
  compare(
    body[7]!,
    expected[7]!,
    "scope-bound-snapshot-projection",
    owner,
    names,
  );
  compare(
    body[8]!,
    expected[8]!,
    "captured-scope-latest-api-observation",
    owner,
    names,
  );
  compare(
    body[9]!,
    expected[9]!,
    "borrowed-native-modal-registration",
    owner,
    names,
  );
  compare(
    body[10]!,
    expected[10]!,
    "original-scope-retirement-guard",
    owner,
    names,
  );
  compare(
    body[11]!,
    expected[11]!,
    "complete-captured-control-clear-refresh",
    owner,
    names,
  );
  compare(
    body[12]!,
    expected[12]!,
    "complete-captured-result-no-refresh",
    owner,
    names,
  );
  for (const index of [13, 14])
    compare(
      body[index]!,
      expected[index]!,
      "produced-link-render-client-capture",
      owner,
      names,
    );
  compare(
    body[15]!,
    expected[15]!,
    "direct-six-facts-three-action-return",
    owner,
    names,
  );
  const returned = body[15]!;
  assert.ok(
    isReturnStatement(returned) &&
      returned.expression &&
      isObjectLiteralExpression(returned.expression),
    "direct-six-facts-three-action-return",
  );
  for (const property of returned.expression.properties) {
    assert.ok(
      isShorthandPropertyAssignment(property),
      "direct-six-facts-three-action-return",
    );
    const propertyName = property.name.getText();
    const declarations = inside(hook).filter(
      (node) =>
        (isVariableDeclaration(node) ||
          isFunctionDeclaration(node) ||
          isBindingElement(node)) &&
        node.name?.getText() === propertyName &&
        owner.symbols.get(node.name) === owner.shorthandValues.get(property),
    );
    assert.equal(
      declarations.length,
      1,
      "direct-six-facts-three-action-return",
    );
    const definition = declarations[0]!;
    assert.ok(
      (isVariableDeclaration(definition) ||
        isFunctionDeclaration(definition) ||
        isBindingElement(definition)) &&
        definition.name &&
        owner.symbols.get(definition.name) !== undefined &&
        owner.shorthandValues.get(property) ===
          owner.symbols.get(definition.name),
      "direct-six-facts-three-action-return",
    );
  }
  compare(
    component.body!.statements[0]!,
    templates.get("DialogRef")!.source.statements[0]!,
    "renderer-first-native-dialog-ref",
    dialog,
    dialogNames,
  );
  const bindings = inside(component)
    .filter(isVariableDeclaration)
    .filter(
      (node) =>
        isObjectBindingPattern(node.name) &&
        node.name.elements.some(
          (entry) => entry.name?.getText() === "snapshot",
        ),
    );
  assert.equal(bindings.length, 1, "single-direct-inspection-consumer");
  const binding = bindings[0]!;
  assert.ok(
    binding.parent.parent.parent === component.body &&
      binding.parent.parent === component.body!.statements[1] &&
      binding.initializer &&
      isCallExpression(binding.initializer),
    "unconditional-original-slot-inspection-hook",
  );
  const call = binding.initializer,
    hookImport = imported(
      dialog,
      "./features/execution/useExecutionInspection.js",
      "useExecutionInspection",
    );
  assert.ok(
    isIdentifier(call.expression) &&
      dialog.symbols.get(call.expression) === dialog.symbols.get(hookImport),
    "actual-direct-inspection-hook-symbol",
  );
  const expectedBinding = templates
    .get("Consumer")!
    .nodes.find(isVariableDeclaration)!;
  assert.deepEqual(
    shape(binding.name),
    shape(expectedBinding.name),
    "direct-six-facts-three-action-consumption",
  );
  const expectedCall = templates.get("Consumer")!.nodes.find(isCallExpression)!;
  assert.deepEqual(
    call.arguments.map((node) => shape(node)),
    expectedCall.arguments.map((node) => shape(node)),
    "borrowed-four-inspection-consumer-inputs",
  );
  const parameter = component.parameters[0];
  assert.ok(
    parameter && isObjectBindingPattern(parameter.name),
    "borrowed-inspection-consumer-symbols",
  );
  const dialogDecl = inside(component.body!.statements[0]!).find(
    isVariableDeclaration,
  )!;
  const inputObject = call.arguments[0];
  assert.ok(
    inputObject && isObjectLiteralExpression(inputObject),
    "borrowed-inspection-consumer-symbols",
  );
  for (const property of inputObject.properties) {
    assert.ok(
      isShorthandPropertyAssignment(property),
      "borrowed-inspection-consumer-symbols",
    );
    const field = property.name.getText();
    const fields: readonly BindingElement[] = parameter.name.elements.filter(
      (entry) => (entry.propertyName ?? entry.name)?.getText() === field,
    );
    if (field !== "dialog")
      assert.equal(fields.length, 1, "borrowed-inspection-consumer-symbols");
    const target = field === "dialog" ? dialogDecl.name : fields[0]!.name;
    assert.ok(
      target &&
        isIdentifier(target) &&
        dialog.symbols.get(target) !== undefined &&
        dialog.shorthandValues.get(property) === dialog.symbols.get(target),
      "borrowed-inspection-consumer-symbols",
    );
  }
  assert.equal(
    inside(component)
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) &&
          dialog.symbols.get(node.expression) ===
            dialog.symbols.get(hookImport),
      ).length,
    1,
    "single-direct-inspection-consumer",
  );
  const nativeRefs = inside(component)
    .filter(isJsxAttribute)
    .filter(
      (node) =>
        node.name.getText() === "ref" &&
        isJsxElement(node.parent.parent.parent) &&
        node.parent.parent.parent.openingElement.tagName.getText() === "dialog",
    );
  assert.equal(nativeRefs.length, 1, "native-ref-same-renderer-node");
  const ref = nativeRefs[0]!.initializer;
  assert.ok(
    ref &&
      isJsxExpression(ref) &&
      ref.expression &&
      isIdentifier(ref.expression) &&
      ref.expression.text === "dialog",
    "native-ref-same-renderer-node",
  );
  assert.equal(
    dialog.symbols.get(ref.expression),
    dialog.symbols.get(dialogDecl.name),
    "native-ref-same-renderer-node",
  );
  assert.deepEqual(
    flattened(dialog, owner, parsed.get("Observed")!, parsed.get("Modal")!),
    originalRegistrations,
    "original-seventeen-primitive-registration-order-deps",
  );
  // The original renderer has no second modal/read/state/effect lifecycle; other
  // unrelated components and JSX remain outside this finite original consumer.
  const rendererHooks = inside(component)
    .filter(isCallExpression)
    .filter(
      (node) =>
        dialogNames.has(dialog.symbols.get(node.expression)!) ||
        /^use[A-Z]/.test(node.expression.getText()),
    );
  assert.deepEqual(
    rendererHooks.map(
      (node) =>
        dialogNames.get(dialog.symbols.get(node.expression)!) ??
        node.expression.getText(),
    ),
    ["useRef", "useExecutionInspection"],
    "sole-native-ref-plus-feature-lifecycle",
  );
}
function replaceOnce(value: string, before: string, after: string) {
  assert.equal(
    value.split(before).length,
    2,
    `unique counterfactual seam: ${before}`,
  );
  return value.replace(before, after);
}
function changed(key: keyof Sources, before: string, after: string): Sources {
  return { ...sources, [key]: replaceOnce(sources[key], before, after) };
}
function reject(contents: Sources, rule: string) {
  parse(contents);
  assert.throws(
    () => validate(contents),
    (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes(rule),
  );
}
test("independent Git114 finite lifecycle/signatures and seventeen registration archive stay intact", () => {
  for (const span of [
    ...Object.values(fixed.spans),
    fixed.originalComponent,
    ...fixed.registrations.direct,
    ...fixed.registrations.observed,
    ...fixed.registrations.modal,
  ]) {
    assert.equal(
      createHash("sha256").update(span.raw).digest("hex"),
      span.sha256,
    );
    assert.equal(Buffer.byteLength(span.raw), span.bytes);
  }
  assert.equal(fixed.git, "114960d1cd1529082751efb424f0a7d8584bd721");
  assert.equal(originalRegistrations.length, 17);
});
test("actual inspection controller and direct real renderer preserve complete bounded lifecycle", () =>
  validate(sources));
test("consumer shorthand values must be borrowed from actual renderer parameters and native ref", () => {
  reject(
    {
      ...sources,
      Dialog:
        replaceOnce(
          sources.Dialog,
          "  client,\n  scope,",
          "  client: _renderClient,\n  scope,",
        ) + "\nconst client = {} as WorkspaceClient;\n",
    },
    "borrowed-inspection-consumer-symbols",
  );
  reject(
    {
      ...sources,
      Dialog:
        replaceOnce(
          sources.Dialog,
          "  scope,\n  onClose,",
          "  scope: _renderScope,\n  onClose,",
        ) + "\nconst scope = {} as ExecutionScope;\n",
    },
    "borrowed-inspection-consumer-symbols",
  );
});
test("module initializers cannot acquire ambient DOM or perform ambient actions", () => {
  reject(
    {
      ...sources,
      Controller:
        sources.Controller + "\nexport const hostDocument = document;\n",
    },
    "inspection-owned-ambient-initialization",
  );
  reject(
    { ...sources, Controller: sources.Controller + "\nwindow.focus();\n" },
    "inspection-owned-dependencies",
  );
  validate({
    ...sources,
    Controller:
      sources.Controller +
      '\nexport const pureResult = { document: "ordinary field", count: 2 + 3 };\n',
  });
});
test("helper primitive registrations follow real React import aliases", () => {
  const observed = sources.Observed.replace(
    /\buseRef\b/g,
    "borrowedRef",
  ).replace("borrowedRef }", "useRef as borrowedRef }");
  const modal = sources.Modal.replace(
    /\buseLayoutEffect\b/g,
    "borrowedLayout",
  ).replace("borrowedLayout,", "useLayoutEffect as borrowedLayout,");
  validate({ ...sources, Observed: observed, Modal: modal });
});
for (const [name, key, before, after, rule] of [
  [
    "generator hook",
    "Controller",
    "export function useExecutionInspection",
    "export function* useExecutionInspection",
    "synchronous-module-scope-inspection-hook",
  ],
  [
    "async renderer",
    "Dialog",
    "export function ExecutionDialog",
    "export async function ExecutionDialog",
    "synchronous-inspection-renderer-declaration",
  ],
  [
    "generator renderer",
    "Dialog",
    "export function ExecutionDialog",
    "export function* ExecutionDialog",
    "synchronous-inspection-renderer-declaration",
  ],
] as const)
  test(`real React inspection declarations reject ${name}`, () =>
    reject(changed(key, before, after), rule));
test("wrappers, conditional hooks, clones and fresh-client getters fail their real consumer rule", () => {
  reject(
    changed(
      "Dialog",
      "useExecutionInspection({ client, scope, dialog, embedded })",
      "embedded ? useExecutionInspection({ client, scope, dialog, embedded }) : undefined",
    ),
    "unconditional-original-slot-inspection-hook",
  );
  reject(
    changed(
      "Dialog",
      "useExecutionInspection({ client, scope, dialog, embedded })",
      "(() => useExecutionInspection({ client, scope, dialog, embedded }))()",
    ),
    "actual-direct-inspection-hook-symbol",
  );
  reject(
    changed(
      "Dialog",
      "useExecutionInspection({ client, scope, dialog, embedded })",
      "useExecutionInspection({ client: {...client}, scope, dialog, embedded })",
    ),
    "borrowed-four-inspection-consumer-inputs",
  );
  reject(
    changed(
      "Dialog",
      "useExecutionInspection({ client, scope, dialog, embedded })",
      "useExecutionInspection({ client, scope: {...scope}, dialog, embedded })",
    ),
    "borrowed-four-inspection-consumer-inputs",
  );
  reject(
    changed(
      "Dialog",
      "useExecutionInspection({ client, scope, dialog, embedded })",
      "useExecutionInspection({ client: client.getSnapshot(), scope, dialog, embedded })",
    ),
    "borrowed-four-inspection-consumer-inputs",
  );
  reject(
    changed(
      "Dialog",
      "  const jobs = executionJobsInReadingOrder",
      "  const again = useExecutionInspection({ client, scope, dialog, embedded });\n  const jobs = executionJobsInReadingOrder",
    ),
    "single-direct-inspection-consumer",
  );
  reject(
    changed(
      "Dialog",
      "  hideEmpty = false,",
      "  hideEmpty = false,\n  useExecutionInspection = (input: unknown) => input,",
    ),
    "actual-direct-inspection-hook-symbol",
  );
});
test("new state/effects, a second modal and reordered original phases cannot enter the lifecycle", () => {
  reject(
    {
      ...sources,
      Controller: sources.Controller + "\nconst outsideState = useState(0);\n",
    },
    "owned-inspection-registration-location",
  );
  reject(
    changed(
      "Controller",
      "  api.current = client;",
      "  const extra = useState(0);\n  api.current = client;",
    ),
    "complete-original-inspection-boundary",
  );
  reject(
    changed(
      "Controller",
      "  api.current = client;",
      "  useEffect(() => {}, []);\n  api.current = client;",
    ),
    "complete-original-inspection-boundary",
  );
  reject(
    changed(
      "Controller",
      "  useModal(dialog, undefined, !embedded);",
      "  useModal(dialog, undefined, !embedded);\n  useModal(dialog, undefined, !embedded);",
    ),
    "complete-original-inspection-boundary",
  );
  const modal = fixed.spans.modal.raw,
    retirement = fixed.spans.retirement.raw;
  reject(
    changed(
      "Controller",
      `${modal}\n  ${retirement}`,
      `${retirement}\n  ${modal}`,
    ),
    "read-modal-retirement-order",
  );
  reject(
    changed(
      "Controller",
      "  useModal(dialog, undefined, !embedded);",
      "  if (!embedded) useModal(dialog, undefined, !embedded);",
    ),
    "borrowed-native-modal-registration",
  );
});
test("render key and synchronous latest refs cannot be cloned, extended or deferred", () => {
  reject(
    changed(
      "Controller",
      "    client.boot?.csrfToken,",
      "    client.boot?.csrfToken, client.boot?.actantId,",
    ),
    "render-scope-key-capture",
  );
  reject(
    changed("Controller", "    scope,\n  ]);", "    {...scope},\n  ]);"),
    "render-scope-key-capture",
  );
  reject(
    changed(
      "Controller",
      "  api.current = client;",
      "  api.current = {...client};",
    ),
    "latest-ref-publication-before-passive-cleanup",
  );
  reject(
    changed(
      "Controller",
      "  currentScope.current = observationScope;",
      '  currentScope.current = "latest";',
    ),
    "latest-ref-publication-before-passive-cleanup",
  );
  reject(
    changed("Controller", "observation?.scope === observationScope", "true"),
    "scope-bound-snapshot-projection",
  );
});
test("observation captures exact scope with latest API and original enablement/invalidation", () => {
  reject(
    changed(
      "Controller",
      "api.current.executionSnapshot(scope, signal)",
      "client.executionSnapshot(scope, signal)",
    ),
    "captured-scope-latest-api-observation",
  );
  reject(
    changed(
      "Controller",
      "api.current.executionSnapshot(scope, signal)",
      "api.current.executionSnapshot({...scope}, signal)",
    ),
    "captured-scope-latest-api-observation",
  );
  reject(
    changed("Controller", "enabled: client.online,", "enabled: true,"),
    "captured-scope-latest-api-observation",
  );
  reject(
    changed(
      "Controller",
      "revision: client.workspaceChangeRevision,",
      "revision: 0,",
    ),
    "captured-scope-latest-api-observation",
  );
  reject(
    changed("Controller", "  }, [observationScope]);", "  }, []);"),
    "original-scope-retirement-guard",
  );
  reject(
    changed(
      "Controller",
      "      mounted.current = false;",
      "      mounted.current = true;",
    ),
    "original-scope-retirement-guard",
  );
});
test("control, result, late guards and refresh strategies remain independently complete", () => {
  const control = fixed.spans.control.raw,
    result = fixed.spans.readResult.raw;
  reject(
    changed(
      "Controller",
      control,
      control.replace(
        "const origin = observationScope;",
        "const origin = currentScope.current;",
      ),
    ),
    "complete-captured-control-clear-refresh",
  );
  reject(
    changed(
      "Controller",
      control,
      control.replace(
        "mounted.current && currentScope.current === origin",
        "mounted.current",
      ),
    ),
    "complete-captured-control-clear-refresh",
  );
  reject(
    changed(
      "Controller",
      control,
      control.replace("void refresh();", "await refresh();"),
    ),
    "complete-captured-control-clear-refresh",
  );
  reject(
    changed(
      "Controller",
      control,
      control.replace("void refresh();", "void refresh(); void refresh();"),
    ),
    "complete-captured-control-clear-refresh",
  );
  reject(
    changed(
      "Controller",
      result,
      result.replace(
        "api.current.executionResult(scope, id)",
        "client.executionResult(scope, id)",
      ),
    ),
    "complete-captured-result-no-refresh",
  );
  reject(
    changed(
      "Controller",
      result,
      result.replace(
        'if (current()) setBusy("");',
        'if (current()) { setBusy(""); void refresh(); }',
      ),
    ),
    "complete-captured-result-no-refresh",
  );
});
test("produced links borrow this render's Boot/catalog and never invent revision or receipt authority", () => {
  const produced = fixed.spans.producedProjection.raw;
  reject(
    changed(
      "Controller",
      produced,
      produced.replace("client.boot?", "api.current.boot?"),
    ),
    "produced-link-render-client-capture",
  );
  reject(
    changed(
      "Controller",
      produced,
      produced.replace("client.contentCatalog", "api.current.contentCatalog"),
    ),
    "produced-link-render-client-capture",
  );
  reject(
    changed(
      "Controller",
      produced,
      produced.replace(
        "data.ok === true",
        "result.available && data.ok === true",
      ),
    ),
    "produced-link-render-client-capture",
  );
  reject(
    changed(
      "Controller",
      produced,
      produced.replace("a.projectId === scope.projectId", "true"),
    ),
    "produced-link-render-client-capture",
  );
  reject(
    changed(
      "Controller",
      "    refresh,\n    control,\n    readResult,",
      "    refresh: () => refresh(),\n    control,\n    readResult,",
    ),
    "direct-six-facts-three-action-return",
  );
});
test("finite dependency/type contracts reject transport, storage and widened Client or ref ports", () => {
  reject(
    {
      ...sources,
      Controller:
        'import { applicationCall } from "../../application-transport.js";\n' +
        sources.Controller,
    },
    "inspection-owned-dependencies",
  );
  reject(
    {
      ...sources,
      Controller: 'import { useMemo } from "react";\n' + sources.Controller,
    },
    "inspection-owned-dependencies",
  );
  reject(
    changed(
      "Controller",
      "import type { WorkspaceClient }",
      "import { WorkspaceClient }",
    ),
    "inspection-owned-dependencies",
  );
  reject(
    changed(
      "Controller",
      '  | "contentCatalog"',
      '  | "contentCatalog"\n  | "refresh"',
    ),
    "exact-inspection-client-pick",
  );
  reject(
    changed("Controller", "embedded: boolean;", "embedded?: boolean;"),
    "typed-borrowed-inspection-inputs",
  );
});
test("unrelated legal JSX/CSS/comments/type imports/pure increments and real hook aliases remain allowed", () => {
  validate({
    ...sources,
    Controller:
      'import type { Artifact } from "../../../../../packages/core/src/model.js";\n// unrelated note\n' +
      sources.Controller +
      "\nconst pureExtra = (value: number) => value + 1;\n",
    Dialog:
      'import "./unrelated-feature.css";\n' +
      sources.Dialog +
      '\nfunction UnrelatedPane() { return <aside data-other="safe">Other</aside>; }\n',
  });
  validate({
    ...sources,
    Dialog: replaceOnce(
      replaceOnce(
        sources.Dialog,
        "import { useExecutionInspection }",
        "import { useExecutionInspection as inspect }",
      ),
      "useExecutionInspection({ client, scope, dialog, embedded })",
      "inspect({ client, scope, dialog, embedded })",
    ),
  });
  let ownerAliases = sources.Controller;
  for (const name of [
    "useRef",
    "useState",
    "useEffect",
    "RefObject",
    "WorkspaceClient",
    "ExecutionScope",
    "ExecutionSnapshot",
    "ExecutionControl",
  ]) {
    const alias = `borrowed${name}`;
    ownerAliases = ownerAliases
      .replace(new RegExp(`\\b${name}\\b`, "g"), alias)
      .replace(alias, `${name} as ${alias}`);
  }
  validate({ ...sources, Controller: ownerAliases });
});
