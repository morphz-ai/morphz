import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import {
  fixedScriptWorkspaceArrows as arrows,
  fixedScriptWorkspaceConsumers as consumers,
  fixedScriptWorkspaceMetadata as metadata,
  fixedScriptWorkspacePrelude as prelude,
} from "./fixtures/script-workspace-controller-13dbe571.js";

// This finite feature contract is not a general TS binding or purity theorem.
// Complete historical components and whole-source migration proof live in /tmp,
// not in ordinary CI. Only the owned recipes and actual consumers are fixed here.
const paths = {
  Owner: "../apps/web/src/features/script/useScriptStudioWorkspace.ts",
  Renderer: "../apps/web/src/ScriptStudio.tsx",
};
type Sources = Record<keyof typeof paths, string>;
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const inputs =
  "client instance activeView locationRequest onNavigate globalLibrary onOpenScript onLibrary onNotice onNativeDialog".split(
    " ",
  );
const facts =
  "boot space productionId itemId query organizing dialog createDefaults error busy saving exportStatus directoryId compactDirectory directoryOpen historyOpen exportSelection editorRead production issuesOpen reviewRead issues exportRead item sorted library canWrite executionIssue deliveryTarget".split(
    " ",
  );
const refs = "studio directoryTrigger exportTrigger exportHistory".split(" ");
const oldCommands =
  "choose showLibrary closeDirectory openCreate run restoreEditorFocus download".split(
    " ",
  );
const actionIndices = {
  toggleDirectory: 0,
  openOrganization: 1,
  openProductionDialog: 2,
  openSettingsDialog: 3,
  beginExport: 4,
  showExportHistory: 5,
  closeExportStatus: 6,
  libraryReady: 7,
  openLibraryProduction: 8,
  issuesToggle: 15,
  historyToggle: 17,
  closeOrganization: 19,
  organizationSaved: 20,
  closeDialog: 21,
  submitProduction: 22,
  itemCreated: 24,
  closeExportSelection: 26,
  submitExport: 27,
} as const;
const actions = Object.keys(actionIndices) as (keyof typeof actionIndices)[];
const publicKeys = [
  ...facts,
  ...refs,
  ...oldCommands,
  ...actions,
  "queryChanged",
];
const actionUses = new Map<number, string>([
  ...actions.map((name) => [actionIndices[name], name] as [number, string]),
  [13, "openSettingsDialog"],
  [14, "openSettingsDialog"],
  [23, "closeDialog"],
  [25, "closeDialog"],
]);
const imports = `import {useEffect,useId,useLayoutEffect,useRef,useState} from "react";
import {flushSync} from "react-dom";
import {scriptLocationSchema} from "../../../../../packages/core/src/script-delivery.js";
import {harnessReadinessError,scriptStudioApplication} from "../../../../../packages/core/src/applications.js";
import {scriptIssues,scriptStructureIssues} from "../../../../../packages/core/src/script-studio.js";
import {buildScriptDocx} from "../../../../../packages/core/src/script-studio-docx.js";
import {spaceKind} from "../../../../../packages/core/src/model.js";
import {scopedStorage} from "../../local-preferences.js";
import {scriptFocusReturn} from "../../script-studio-focus.js";
import {useScriptEditorRead} from "../../useScriptEditorRead.js";`;
const original =
  imports +
  `function Original({${inputs.join(",")}}){\n` +
  prelude.join("\n") +
  "\n" +
  actions
    .map((name) => `const ${name}=${arrows[actionIndices[name]].raw};`)
    .join("\n") +
  "\n}";

type Parsed = {
  source: ts.SourceFile;
  nodes: ts.Node[];
  ids: Map<ts.Node, number | undefined>;
  origin: Map<number, string>;
  canonical: Map<number, string>;
};
function nodes(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const walk = (node: ts.Node) => {
    all.push(node);
    node.forEachChild((child) => {
      walk(child);
    });
  };
  walk(root);
  return all;
}
function parse(contents: Record<string, string>): Record<string, Parsed> {
  const cwd = "/script-workspace-contract",
    config = cwd + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, raw]) => [
      cwd + "/" + name + ".tsx",
      raw,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((n) => n + ".tsx"),
  });
  const api = new API({ cwd, fs: createVirtualFileSystem(files) }),
    snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "parse-valid-counterfactual",
    );
    return Object.fromEntries(
      Object.keys(contents).map((key) => {
        const source = project.program.getSourceFile(cwd + "/" + key + ".tsx")!,
          all = nodes(source);
        const ids = new Map<ts.Node, number | undefined>(),
          identifiers = all.filter(ts.isIdentifier),
          symbols = project.checker.getSymbolAtLocation(identifiers);
        identifiers.forEach((node, index) => ids.set(node, symbols[index]?.id));
        for (const property of all.filter(ts.isShorthandPropertyAssignment))
          ids.set(
            property.name,
            project.checker.getShorthandAssignmentValueSymbol(property)?.id,
          );
        const origin = new Map<number, string>(),
          canonical = new Map<number, string>();
        for (const entry of source.statements.filter(ts.isImportDeclaration)) {
          const named = entry.importClause?.namedBindings;
          if (
            entry.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            !named ||
            !ts.isNamedImports(named)
          )
            continue;
          for (const binding of named.elements) {
            const id = ids.get(binding.name),
              exported = (binding.propertyName ?? binding.name).text;
            if (id !== undefined && !binding.isTypeOnly) {
              origin.set(
                id,
                entry.moduleSpecifier.getText().slice(1, -1) + ":" + exported,
              );
              canonical.set(id, "import:" + exported);
            }
          }
        }
        // Two-hop immutable aliases to actual imported values, not name matching.
        for (let pass = 0; pass < 2; pass++)
          for (const variable of all.filter(ts.isVariableDeclaration)) {
            if (
              !ts.isIdentifier(variable.name) ||
              !variable.initializer ||
              !ts.isIdentifier(variable.initializer) ||
              !(variable.parent.flags & ts.NodeFlags.Const)
            )
              continue;
            const id = ids.get(variable.name),
              from = ids.get(variable.initializer);
            if (id !== undefined && from !== undefined && origin.has(from)) {
              origin.set(id, origin.get(from)!);
              canonical.set(id, canonical.get(from)!);
            }
          }
        return [
          key,
          { source, nodes: all, ids, origin, canonical } satisfies Parsed,
        ];
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node;
}
function shape(node: ts.Node, p: Parsed): unknown {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return shape(node.expression, p);
  const children: unknown[] = [];
  node.forEachChild((child) => {
    if (
      ("type" in node && child === node.type) ||
      ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        node.typeArguments?.some((t) => t === child)) ||
      child.kind === ts.SyntaxKind.TypeParameter ||
      (child.kind >= ts.SyntaxKind.FirstTypeNode &&
        child.kind <= ts.SyntaxKind.LastTypeNode)
    )
      return;
    children.push(shape(child, p));
  });
  const id = p.ids.get(node);
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
      : id !== undefined && p.canonical.has(id)
        ? p.canonical.get(id)
        : ts.isStringLiteral(node)
          ? node.text
          : node.getText(),
  ];
}
function fn(p: Parsed, name: string) {
  const found = p.source.statements
    .filter(ts.isFunctionDeclaration)
    .filter((n) => n.name?.text === name);
  assert.equal(found.length, 1, "unique-workspace-function:" + name);
  assert.ok(found[0]!.body, "complete-workspace-body");
  return found[0]!;
}
function variable(root: ts.Node, name: string) {
  const found = nodes(root)
    .filter(ts.isVariableDeclaration)
    .filter((n) => ts.isIdentifier(n.name) && n.name.text === name);
  assert.equal(found.length, 1, "unique-owned-variable:" + name);
  return found[0]!;
}
function bindingId(node: ts.Identifier, p: Parsed, rule: string) {
  const id = p.ids.get(node);
  assert.notEqual(id, undefined, rule);
  return id!;
}
function propertyName(node: ts.PropertyName) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node)
    ? node.text
    : node.getText();
}
function variableReference(node: ts.Identifier) {
  return (
    !(
      ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
    ) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
  );
}
function inputBindings(main: ts.FunctionDeclaration, p: Parsed) {
  assert.equal(main.parameters.length, 1, "original-workspace-inputs");
  const pattern = main.parameters[0]!.name;
  assert.ok(ts.isObjectBindingPattern(pattern), "original-workspace-inputs");
  const result = new Map<string, number>();
  for (const element of pattern.elements) {
    assert.ok(
      element.name && ts.isIdentifier(element.name),
      "direct-workspace-input",
    );
    result.set(
      element.propertyName
        ? propertyName(element.propertyName)
        : element.name.text,
      bindingId(element.name, p, "direct-workspace-input"),
    );
  }
  return result;
}
function bindInputs(main: ts.FunctionDeclaration, p: Parsed) {
  const bound = inputBindings(main, p);
  for (const name of inputs) {
    assert.ok(bound.has(name), "original-workspace-inputs");
    p.canonical.set(bound.get(name)!, "input:" + name);
  }
  return bound;
}
function attributes(main: ts.FunctionDeclaration) {
  return nodes(main.body!)
    .filter(ts.isJsxAttribute)
    .filter(
      (n) =>
        n.initializer &&
        (!ts.isJsxExpression(n.initializer) || n.initializer.expression),
    );
}
function tag(attribute: ts.JsxAttribute, p?: Parsed) {
  const opening = attribute.parent.parent;
  assert.ok(
    ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening),
  );
  const imported =
    p && ts.isIdentifier(opening.tagName)
      ? p.origin.get(p.ids.get(opening.tagName)!)
      : undefined;
  return imported
    ? imported.slice(imported.lastIndexOf(":") + 1)
    : opening.tagName.getText();
}
function value(attribute: ts.JsxAttribute) {
  const init = attribute.initializer;
  assert.ok(init, "complete-consumer-value");
  const expression = ts.isJsxExpression(init) ? init.expression : init;
  assert.ok(expression, "complete-consumer-value");
  return expression;
}
function validate(current: Sources) {
  const parsed = parse({ ...current, Original: original }),
    owner = parsed.Owner!,
    renderer = parsed.Renderer!,
    expected = parsed.Original!;
  const main = fn(owner, "useScriptStudioWorkspace"),
    old = fn(expected, "Original"),
    view = fn(renderer, "ScriptStudio");
  assert.ok(
    !main.asteriskToken &&
      !main.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
    "synchronous-workspace-hook",
  );
  assert.deepEqual(
    [...inputBindings(main, owner).keys()],
    inputs,
    "original-workspace-inputs",
  );
  bindInputs(main, owner);
  bindInputs(old, expected);
  const renderInputs = bindInputs(view, renderer);
  const required = new Map<string, string>();
  for (const entry of expected.origin.values())
    required.set(entry.slice(entry.lastIndexOf(":") + 1), entry);
  for (const identifier of nodes(main.body!).filter(ts.isIdentifier)) {
    const id = owner.ids.get(identifier),
      actual = id === undefined ? undefined : owner.origin.get(id),
      name = actual?.slice(actual.lastIndexOf(":") + 1);
    if (name && required.has(name))
      assert.equal(
        actual,
        required.get(name),
        "actual-owner-value-origin:" + name,
      );
  }
  assert.ok(
    !owner.source.statements
      .filter(ts.isImportDeclaration)
      .some(
        (n) =>
          ts.isStringLiteral(n.moduleSpecifier) &&
          n.moduleSpecifier.text === "../../client.js" &&
          n.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
          (!n.importClause?.namedBindings ||
            !ts.isNamedImports(n.importClause.namedBindings) ||
            n.importClause.namedBindings.elements.some(
              (binding) => !binding.isTypeOnly,
            )),
      ),
    "client-type-only-import",
  );
  const statements = main.body!.statements,
    owned: ts.Statement[] = [],
    statementShapes = statements.map((node, at) => ({
      node,
      at,
      key: JSON.stringify(shape(node, owner)),
    }));
  let previous = -1;
  // Ordered finite recipes, not a total hook statement count. An independent
  // feature may add its own state/effects/actions and actual rendered consumers.
  for (let index = 0; index < prelude.length; index++) {
    const wanted = JSON.stringify(
      shape(old.body!.statements[index]!, expected),
    );
    const matches = statementShapes.filter(({ key }) => key === wanted);
    assert.equal(matches.length, 1, "original-workspace-recipe:" + index);
    assert.ok(
      matches[0]!.at > previous,
      "original-registration-order:" + index,
    );
    previous = matches[0]!.at;
    owned.push(matches[0]!.node);
  }
  for (const [index, name] of actions.entries()) {
    const declaration = variable(main.body!, name),
      originalAction = old.body!.statements[prelude.length + index]!;
    assert.deepEqual(
      shape(declaration.parent.parent, owner),
      shape(originalAction, expected),
      "complete-named-action:" + name,
    );
    owned.push(declaration.parent.parent as ts.Statement);
  }
  const returned = statements.find(ts.isReturnStatement);
  assert.ok(
    returned &&
      returned.expression &&
      ts.isAsExpression(returned.expression) &&
      returned.expression.type.getText() === "const",
    "readonly-public-workspace-result",
  );
  const object = unwrap(returned.expression);
  assert.ok(
    ts.isObjectLiteralExpression(object),
    "direct-public-workspace-result",
  );
  const keys = object.properties.map((n) =>
    "name" in n && n.name ? propertyName(n.name) : "spread",
  );
  assert.deepEqual(
    keys.filter((name) => publicKeys.includes(name)),
    publicKeys,
    "complete-workspace-public-surface",
  );
  const privateIds = new Set<number>();
  for (const statement of owned)
    for (const node of nodes(statement)) {
      if (
        (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        !publicKeys.includes(node.name.text)
      ) {
        const id = owner.ids.get(node.name);
        if (id !== undefined) privateIds.add(id);
      }
    }
  for (const [index, name] of keys.entries())
    if (!publicKeys.includes(name)) {
      const property = object.properties[index]!;
      assert.ok(
        ts.isShorthandPropertyAssignment(property) ||
          ts.isPropertyAssignment(property),
        "closed-workspace-private-boundary",
      );
      assert.ok(
        !nodes(property).some((n) => privateIds.has(owner.ids.get(n)!)),
        "closed-workspace-private-boundary",
      );
    }
  for (const statement of statements)
    if (!owned.includes(statement) && statement !== returned)
      assert.ok(
        !nodes(statement).some((n) => privateIds.has(owner.ids.get(n)!)),
        "original-private-writer-lifetime",
      );
  for (const name of publicKeys) {
    const property = object.properties[keys.indexOf(name)]!;
    if (name === "queryChanged") {
      assert.ok(ts.isPropertyAssignment(property), "query-setter-identity");
      const expression = unwrap(property.initializer);
      assert.ok(ts.isIdentifier(expression), "query-setter-identity");
      const queryState = nodes(
        owned[
          prelude.findIndex((raw) => raw.startsWith("const [query, setQuery]"))
        ]!,
      ).find(ts.isVariableDeclaration)!;
      assert.ok(
        ts.isArrayBindingPattern(queryState.name),
        "query-setter-identity",
      );
      const setter = queryState.name.elements[1];
      assert.ok(
        setter &&
          ts.isBindingElement(setter) &&
          setter.name &&
          ts.isIdentifier(setter.name),
        "query-setter-identity",
      );
      assert.equal(
        owner.ids.get(expression),
        owner.ids.get(setter.name),
        "query-setter-identity",
      );
    } else
      assert.ok(
        ts.isShorthandPropertyAssignment(property) &&
          propertyName(property.name) === name,
        "direct-public-workspace-result:" + name,
      );
  }
  // Actual borrowed values enter once, at the original unconditional first slot.
  const calls = nodes(view.body!)
    .filter(ts.isCallExpression)
    .filter(
      (call) =>
        ts.isIdentifier(call.expression) &&
        renderer.origin.get(renderer.ids.get(call.expression)!) ===
          "./features/script/useScriptStudioWorkspace.js:useScriptStudioWorkspace",
    );
  assert.equal(calls.length, 1, "actual-workspace-hook-consumer");
  const call = calls[0]!;
  const declaration = view.body!.statements[0];
  assert.ok(
    declaration &&
      ts.isVariableStatement(declaration) &&
      declaration.declarationList.declarations.length === 1,
    "original-workspace-registration-slot",
  );
  const registration = declaration.declarationList.declarations[0]!;
  assert.equal(
    registration.initializer,
    call,
    "unconditional-direct-workspace-hook",
  );
  assert.ok(
    ts.isObjectBindingPattern(registration.name),
    "direct-workspace-fact-consumption",
  );
  assert.equal(call.arguments.length, 1, "borrowed-render-ports");
  const ports = call.arguments[0]!;
  assert.ok(ts.isObjectLiteralExpression(ports), "borrowed-render-ports");
  assert.deepEqual(
    ports.properties.map((n) =>
      "name" in n && n.name ? propertyName(n.name) : "spread",
    ),
    inputs,
    "borrowed-render-ports",
  );
  for (const property of ports.properties) {
    assert.ok(
      ts.isShorthandPropertyAssignment(property) ||
        ts.isPropertyAssignment(property),
      "borrowed-render-ports",
    );
    const name = propertyName(property.name),
      expression = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : unwrap(property.initializer);
    assert.ok(ts.isIdentifier(expression), "borrowed-render-ports:" + name);
    assert.equal(
      renderer.ids.get(expression),
      renderInputs.get(name),
      "borrowed-render-ports:" + name,
    );
  }
  const captures = new Set(inputs.map((name) => renderInputs.get(name)!));
  for (const node of nodes(view.body!))
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      captures.has(renderer.ids.get(node.left)!)
    )
      assert.fail("unreassigned-workspace-input");
  const exposed = new Map<string, number>();
  for (const element of registration.name.elements) {
    assert.ok(
      element.name && ts.isIdentifier(element.name),
      "direct-workspace-fact-consumption",
    );
    const name = element.propertyName
      ? propertyName(element.propertyName)
      : element.name.text;
    exposed.set(
      name,
      bindingId(element.name, renderer, "direct-workspace-fact-consumption"),
    );
    renderer.canonical.set(exposed.get(name)!, "result:" + name);
  }
  assert.deepEqual(
    [...exposed.keys()].filter((name) => publicKeys.includes(name)),
    publicKeys,
    "complete-workspace-fact-consumption",
  );
  // Canonical result bindings allow genuine destructuring aliases, not local
  // shadows, wrappers, cloned facts or a newer Client introduced in JSX.
  for (const name of [...facts, ...refs, ...oldCommands, ...actions]) {
    const candidates = nodes(old.body!).filter(
      (n) =>
        ts.isIdentifier(n) &&
        n.text === name &&
        expected.ids.get(n) !== undefined,
    );
    for (const candidate of candidates)
      expected.canonical.set(expected.ids.get(candidate)!, "result:" + name);
  }
  const attrs = attributes(view);
  const childOrigins: Record<string, string> = {
    ScriptStudioLibrary: "./ScriptStudioLibrary.js:ScriptStudioLibrary",
    ScriptStudioNavigation:
      "./ScriptStudioNavigation.js:ScriptStudioNavigation",
    ScriptItemEditor: "./ScriptStudioEditor.js:ScriptItemEditor",
    ContentMetadata: "./ContentMetadata.js:ContentMetadata",
  };
  for (const opening of nodes(view.body!).filter(
    (n) => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n),
  )) {
    const first = opening.attributes.properties.find(ts.isJsxAttribute);
    if (!first) continue;
    const name = tag(first, renderer),
      id = renderer.ids.get(opening.tagName);
    if (childOrigins[name])
      assert.equal(
        id === undefined ? undefined : renderer.origin.get(id),
        childOrigins[name],
        "actual-child-module:" + name,
      );
    if (
      [
        "CreateDialog",
        "CreateItemDialog",
        "ProductionSettings",
        "ExportDialog",
      ].includes(name)
    )
      assert.equal(
        id,
        renderer.ids.get(fn(renderer, name).name!),
        "actual-local-dialog-consumer:" + name,
      );
  }
  for (const [name, element] of refs.map(
    (n, i) => [n, ["section", "button", "button", "details"][i]!] as const,
  )) {
    const found = attrs.filter(
      (n) =>
        n.name.getText() === "ref" &&
        ts.isIdentifier(value(n)) &&
        renderer.ids.get(value(n)) === exposed.get(name),
    );
    assert.equal(found.length, 1, "actual-dom-attachment:" + name);
    assert.equal(
      tag(found[0]!, renderer),
      element,
      "actual-dom-attachment:" + name,
    );
  }
  for (const name of actions) {
    const wanted = [...actionUses.entries()]
      .filter(([, n]) => n === name)
      .sort(([a], [b]) => a - b)
      .map(([index]) => ({
        tag: arrows[index]!.tag,
        attribute: arrows[index]!.attribute,
      }));
    const found = attrs
      .filter(
        (n) =>
          ts.isIdentifier(value(n)) &&
          renderer.ids.get(value(n)) === exposed.get(name),
      )
      .map((n) => ({ tag: tag(n, renderer), attribute: n.name.getText() }));
    assert.deepEqual(found, wanted, "direct-action-consumer:" + name);
  }
  const selections = nodes(view.body!)
    .filter(ts.isPropertyAssignment)
    .filter(
      (n) =>
        propertyName(n.name) === "onSelect" &&
        ts.isIdentifier(n.initializer) &&
        renderer.ids.get(n.initializer) === exposed.get("openProductionDialog"),
    );
  assert.equal(selections.length, 1, "embedded-production-action-consumer");
  // The six row/prop compositions remain renderer-owned, not new controller
  // state. Match only their actual command symbols, not all future JSX arrows.
  const composed = attrs.filter(
    (n) =>
      ts.isArrowFunction(value(n)) &&
      nodes(value(n)).some(
        (child) =>
          ts.isIdentifier(child) &&
          ["choose", "openCreate", "download"].some(
            (name) => renderer.ids.get(child) === exposed.get(name),
          ),
      ),
  );
  const oldRows = arrows.filter((_, index) => !actionUses.has(index));
  assert.equal(composed.length, oldRows.length, "renderer-row-composition");
  for (const [index, entry] of oldRows.entries()) {
    const fixed = parse({
      Row: `function row(){const value=${entry.raw};}`,
    }).Row!;
    // Free identifiers in isolated recipes have no TS symbol, so give only the
    // known original renderer bindings a canonical value at their use sites.
    for (const node of fixed.nodes.filter(ts.isIdentifier))
      if (
        variableReference(node) &&
        [...facts, ...oldCommands].includes(node.text)
      )
        (fixed.canonical.set(
          fixed.ids.get(node) ?? -node.pos,
          "result:" + node.text,
        ),
          fixed.ids.set(node, fixed.ids.get(node) ?? -node.pos));
    assert.equal(
      tag(composed[index]!, renderer),
      entry.tag,
      "renderer-row-composition",
    );
    assert.equal(
      composed[index]!.name.getText(),
      entry.attribute,
      "renderer-row-composition",
    );
    assert.deepEqual(
      shape(value(composed[index]!), renderer),
      shape(variable(fn(fixed, "row"), "value").initializer!, fixed),
      "renderer-row-composition",
    );
  }
  for (const entry of consumers) {
    const found = attrs.filter(
      (n) =>
        tag(n, renderer) === entry.tag && n.name.getText() === entry.attribute,
    );
    assert.equal(
      found.length,
      1,
      "actual-child-port:" + entry.tag + "." + entry.attribute,
    );
    const currentValue = value(found[0]!);
    const action =
      actions.find((name) => arrows[actionIndices[name]].raw === entry.raw) ||
      (entry.raw === "() => setDialog(null)" ? "closeDialog" : undefined);
    if (action) {
      assert.ok(
        ts.isIdentifier(currentValue),
        "actual-child-port:" + entry.tag + "." + entry.attribute,
      );
      assert.equal(
        renderer.ids.get(currentValue),
        exposed.get(action),
        "actual-child-port:" + entry.tag + "." + entry.attribute,
      );
      continue;
    }
    if (entry.tag === "ScriptStudioLibrary" && entry.attribute === "onQuery") {
      assert.ok(ts.isIdentifier(currentValue), "actual-query-setter-consumer");
      assert.equal(
        renderer.ids.get(currentValue),
        exposed.get("queryChanged"),
        "actual-query-setter-consumer",
      );
      continue;
    }
    if (oldRows.some((row) => row.raw === entry.raw)) continue; // Already compared in the six row compositions.
    const fixed = parse({
      Port: `function port({${inputs.join(",")}}){const value=${entry.raw};}`,
    }).Port!;
    bindInputs(fn(fixed, "port"), fixed);
    for (const node of fixed.nodes.filter(ts.isIdentifier))
      if (
        variableReference(node) &&
        publicKeys.includes(node.text) &&
        node.text !== "queryChanged"
      ) {
        const id = fixed.ids.get(node) ?? -node.pos;
        fixed.ids.set(node, id);
        fixed.canonical.set(id, "result:" + node.text);
      }
    assert.deepEqual(
      shape(currentValue, renderer),
      shape(variable(fn(fixed, "port"), "value").initializer!, fixed),
      "actual-child-port:" + entry.tag + "." + entry.attribute,
    );
  }
}
function changed(source: string, from: string, to: string) {
  assert.equal(source.split(from).length, 2, "unique-counterfactual-target");
  return source.replace(from, to);
}
function reject(current: Sources, rule: string) {
  parse(current);
  assert.throws(() => validate(current), {
    name: "AssertionError",
    message: new RegExp(rule),
  });
}

test("fixed owned ScriptStudio recipes retain independently captured provenance", () => {
  assert.equal(metadata.git, "13dbe5719c659c1de5bc3d40a64c1f43fef427d9");
  assert.equal(prelude.length, 70);
  assert.equal(arrows.length, 28);
  const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
  prelude.forEach((raw, index) =>
    assert.equal(sha(raw), metadata.statements[index]!.sha),
  );
  arrows.forEach((entry, index) =>
    assert.equal(sha(entry.raw), metadata.arrows[index]!.sha),
  );
  consumers.forEach((entry) => assert.equal(sha(entry.raw), entry.sha));
});
test("actual workspace controller owns ordered registration, recipes and direct consumers", () =>
  validate(sources));
test("owned recipe and action drift reject at named rules", () => {
  const cases: [string, string, string][] = [
    [
      "const boot = client.boot!;",
      "const boot = client.getSnapshot()!;",
      "original-workspace-recipe:0",
    ],
    ["[instance.state.navigationId]", "[]", "original-workspace-recipe:8"],
    ["locationRequest ??", "null ??", "original-workspace-recipe:11"],
    [
      "const toggleDirectory = () => {",
      "const toggleDirectory = async () => {",
      "complete-named-action:toggleDirectory",
    ],
    [
      "void client\n      .resolveCatalogContent",
      "client\n      .resolveCatalogContent",
      "complete-named-action:openOrganization",
    ],
    [
      "if (!request || !activeView || document.activeElement !== request.anchor)",
      "if (!request || !activeView)",
      "complete-named-action:libraryReady",
    ],
    [
      "queryChanged: setQuery as (query: string) => void",
      "queryChanged: (query: string) => setQuery(query)",
      "query-setter-identity",
    ],
    [
      "queryChanged: setQuery as (query: string) => void",
      "queryChanged: setItemId as (query: string) => void",
      "query-setter-identity",
    ],
    [
      "return {\n    boot,",
      "return {\n    boot: structuredClone(boot),",
      "direct-public-workspace-result:boot",
    ],
    [
      "queryChanged: setQuery as (query: string) => void,",
      "queryChanged: setQuery as (query: string) => void,\n    setDialog,",
      "closed-workspace-private-boundary",
    ],
  ];
  for (const [from, to, rule] of cases)
    reject({ ...sources, Owner: changed(sources.Owner, from, to) }, rule);
});
test("actual module values cannot be replaced by nominal unused correct imports", () => {
  reject(
    {
      ...sources,
      Owner:
        sources.Owner.replace("  useState,", "  useState as unusedState,") +
        '\nimport {useState} from "foreign-react";',
    },
    "actual-owner-value-origin:useState",
  );
  reject(
    {
      ...sources,
      Owner: changed(
        sources.Owner,
        'import { useScriptEditorRead } from "../../useScriptEditorRead.js";',
        'import {useScriptEditorRead} from "foreign-reader";',
      ),
    },
    "actual-owner-value-origin:useScriptEditorRead",
  );
  reject(
    {
      ...sources,
      Owner: changed(
        sources.Owner,
        'import { scopedStorage } from "../../local-preferences.js";',
        'import {scopedStorage} from "../../client.js";',
      ),
    },
    "actual-owner-value-origin:scopedStorage",
  );
  reject(
    {
      ...sources,
      Renderer:
        changed(
          sources.Renderer,
          "  useScriptStudioWorkspace,\n  type ScriptRun,",
          "  useScriptStudioWorkspace as unusedWorkspace,\n  type ScriptRun,",
        ) + '\nimport {useScriptStudioWorkspace} from "foreign-controller";',
    },
    "actual-workspace-hook-consumer",
  );
  reject(
    {
      ...sources,
      Renderer: changed(
        sources.Renderer,
        "  useScriptStudioWorkspace,\n  type ScriptRun,",
        "  type useScriptStudioWorkspace,\n  type ScriptRun,",
      ),
    },
    "actual-workspace-hook-consumer",
  );
  reject(
    {
      ...sources,
      Renderer: changed(
        sources.Renderer,
        'import { ScriptStudioLibrary } from "./ScriptStudioLibrary.js";',
        'import { ScriptStudioLibrary } from "foreign-library";',
      ),
    },
    "actual-child-module:ScriptStudioLibrary",
  );
});
test("captured inputs, readonly facts and actual DOM consumers reject wrappers or shadows", () => {
  const cases: [string, string, string][] = [
    [
      "  } = useScriptStudioWorkspace({",
      "  } = (() => useScriptStudioWorkspace)()({",
      "actual-workspace-hook-consumer",
    ],
    [
      "  } = useScriptStudioWorkspace({\n    client,",
      "  } = useScriptStudioWorkspace({\n    client: {...client},",
      "borrowed-render-ports:client",
    ],
    [
      "}: Props) {\n  const {",
      "}: Props) {\n  client = {} as typeof client;\n  const {",
      "original-workspace-registration-slot",
    ],
    [
      "onQuery={queryChanged}",
      "onQuery={(value) => queryChanged(value)}",
      "actual-query-setter-consumer",
    ],
    ["ref={studio}", "ref={directoryTrigger}", "actual-dom-attachment:studio"],
    [
      "onReady={libraryReady}",
      "onReady={() => libraryReady()}",
      "direct-action-consumer:libraryReady",
    ],
    [
      "onClick={toggleDirectory}",
      "onClick={openSettingsDialog}",
      "direct-action-consumer:toggleDirectory",
    ],
    [
      "onSelect: openProductionDialog",
      "onSelect: () => openProductionDialog()",
      "embedded-production-action-consumer",
    ],
    [
      "query={query}",
      'query={""}',
      "actual-child-port:ScriptStudioLibrary.query",
    ],
    [
      "onReady={restoreEditorFocus}",
      "onReady={() => restoreEditorFocus()}",
      "actual-child-port:ScriptItemEditor.onReady",
    ],
    [
      "onChoose={(id) => choose(production.id, id)}",
      "onChoose={(id) => choose(production.id)}",
      "renderer-row-composition",
    ],
  ];
  for (const [from, to, rule] of cases)
    reject({ ...sources, Renderer: changed(sources.Renderer, from, to) }, rule);
});
test("genuine imported/local aliases, static types and independent features remain legal", () => {
  const owner =
    sources.Owner.replace("  useState,", "  useState as importedState,")
      .replaceAll("useState(", "localState(")
      .replaceAll("useState<", "localState<") +
    "\nconst localState = importedState;\nexport function IndependentFeature(){const [client]=importedState(null);return client;}\nexport type FutureWorkspaceType={readonly client:string};";
  const renderer =
    sources.Renderer.replace(
      "  useScriptStudioWorkspace,",
      "  useScriptStudioWorkspace as importedWorkspace,",
    ).replace("} = useScriptStudioWorkspace({", "} = localWorkspace({") +
    '\nconst localWorkspace=importedWorkspace;\nexport function FuturePanel(){const current={client:"future"};return <aside className="independent-feature">{current.client}</aside>;}';
  validate({ Owner: owner, Renderer: renderer });
  validate({
    ...sources,
    Renderer: sources.Renderer.replace(
      "    query,\n    organizing,",
      "    query: filterText,\n    organizing,",
    ).replace("query={query}", "query={filterText}"),
  });
  validate({
    ...sources,
    Owner:
      sources.Owner.replace(
        "import { scriptFocusReturn }",
        "import { scriptFocusReturn as importedFocus }",
      ).replaceAll("scriptFocusReturn(", "localFocus(") +
      "\nconst localFocus=importedFocus;",
    Renderer: sources.Renderer.replace(
      "import { ScriptStudioLibrary }",
      "import { ScriptStudioLibrary as Library }",
    ).replace("<ScriptStudioLibrary", "<Library"),
  });
  validate({
    ...sources,
    Owner:
      sources.Owner.replace(
        "const toggleDirectory = () => {",
        "const toggleDirectory: () => void = () => {",
      ) +
      "\n// Unrelated helper and module evolution are not part of this controller.\nexport function IndependentHook(){ const [current]=useState(null);useEffect(()=>{},[]);return current; }",
  });
  validate({
    Owner: sources.Owner.replace(
      "  const boot = client.boot!;",
      "  const [futureVisible,setFutureVisible]=useState(false);\n  useEffect(()=>{},[futureVisible]);\n  const toggleFuture=()=>setFutureVisible(old=>!old);\n  const boot = client.boot!;",
    ).replace(
      "  return {\n    boot,",
      "  return {\n    futureVisible,\n    toggleFuture,\n    boot,",
    ),
    Renderer: sources.Renderer.replace(
      "  const {\n    boot,",
      "  const {\n    futureVisible,\n    toggleFuture,\n    boot,",
    ).replace(
      '<header className="script-toolbar">',
      '<header className="script-toolbar">\n        <button onClick={toggleFuture}>Future</button>{futureVisible&&<aside className="independent-feature">Future</aside>}',
    ),
  });
});
