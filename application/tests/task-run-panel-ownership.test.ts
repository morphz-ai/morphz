import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import { fixedTaskRunPanel as fixed } from "./fixtures/task-run-panel-d93326c0.js";

// Finite current feature contract, not a complete TS binding/purity theorem.
// Whole-file fresh-Git migration proof remains separate temporary evidence.
const paths = {
  Owner: "../apps/web/src/features/tasks/useTaskRunPanel.tsx",
  Renderer: "../apps/web/src/TaskRunPanel.tsx",
  Editor: "../apps/web/src/ArtifactEditor.tsx",
  List: "../apps/web/src/TaskList.tsx",
};
type Sources = Record<keyof typeof paths, string>;
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const facts =
  "busy error readError human view run active status connected responses responsesLoading canRespond thread threadId dependencies inspect primary secondary".split(
    " ",
  );
const actions =
  "stopCurrentRun withdrawArrangement toggleFutureTriggers closeInspection openInspectionContent".split(
    " ",
  );
const inputs =
  "artifact state client onOpen compact runtimeObserved runtimeReadError".split(
    " ",
  );
const oldImports = `import {useRef,useState} from "react";
import {taskPresentation,taskRunBusy,taskRuntimeSchema} from "../../../../../packages/core/src/task-runtime.js";
import {FileText,ListChecks,Play,X} from "lucide-react";
import {useObservedRead} from "../../useObservedRead.js";`;
const recipe =
  oldImports +
  "function Original(){\n" +
  fixed.statements.map((n) => n.raw).join("\n") +
  "\n}";
type Parsed = {
  source: ts.SourceFile;
  nodes: ts.Node[];
  ids: Map<ts.Node, number | undefined>;
  canonical: Map<number, string>;
  imported: Map<number, string>;
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
function parsed(contents: Record<string, string>) {
  const cwd = "/task-run-contract",
    config = cwd + "/tsconfig.json";
  const fs = Object.fromEntries(
    Object.entries(contents).map(([name, raw]) => [
      cwd + "/" + name + ".tsx",
      raw,
    ]),
  );
  fs[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((n) => n + ".tsx"),
  });
  const api = new API({ cwd, fs: createVirtualFileSystem(fs) }),
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
        const identifiers = all.filter(ts.isIdentifier),
          symbols = project.checker.getSymbolAtLocation(identifiers);
        const ids = new Map<ts.Node, number | undefined>();
        identifiers.forEach((node, index) => ids.set(node, symbols[index]?.id));
        for (const property of all.filter(ts.isShorthandPropertyAssignment))
          ids.set(
            property.name,
            project.checker.getShorthandAssignmentValueSymbol(property)?.id,
          );
        const imported = new Map<number, string>();
        for (const entry of source.statements.filter(ts.isImportDeclaration)) {
          const named = entry.importClause?.namedBindings;
          if (
            entry.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            !named ||
            !ts.isNamedImports(named)
          )
            continue;
          for (const binding of named.elements) {
            const id = ids.get(binding.name);
            if (id !== undefined && !binding.isTypeOnly)
              imported.set(
                id,
                entry.moduleSpecifier.getText().slice(1, -1) +
                  ":" +
                  (binding.propertyName ?? binding.name).text,
              );
          }
        }
        // Only actual const value aliases; unused correct imports cannot justify
        // a foreign/local call. No module-name regex or latest-client substitute.
        const canonical = new Map(imported);
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
              sourceId = ids.get(variable.initializer);
            if (
              id !== undefined &&
              sourceId !== undefined &&
              canonical.has(sourceId)
            )
              canonical.set(id, canonical.get(sourceId)!);
          }
        return [
          key,
          { source, nodes: all, ids, canonical, imported } satisfies Parsed,
        ];
      }),
    ) as Record<string, Parsed>;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function shape(node: ts.Node, p: Parsed, witness = false): unknown {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isParenthesizedExpression(node)
  )
    return shape(node.expression, p, witness);
  if (witness && ts.isNonNullExpression(node))
    return shape(node.expression, p, witness);
  const children: unknown[] = [];
  node.forEachChild((child) => {
    if (
      ("type" in node && child === node.type) ||
      ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        node.typeArguments?.some((t) => t === child)) ||
      child.kind === ts.SyntaxKind.TypeParameter ||
      (child.kind >= ts.SyntaxKind.FirstTypeNode &&
        child.kind <= ts.SyntaxKind.LastTypeNode) ||
      (child.kind === ts.SyntaxKind.JsxText && !child.getText().trim())
    )
      return;
    children.push(shape(child, p, witness));
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
  assert.equal(found.length, 1, "unique-feature-function:" + name);
  assert.ok(found[0]!.body, "complete-feature-body");
  return found[0]!;
}
function expression(raw: string) {
  const p = parsed({ Expression: "const value=" + raw + ";" }).Expression!;
  return { p, node: p.nodes.find(ts.isVariableDeclaration)!.initializer! };
}
function same(
  actual: ts.Node,
  p: Parsed,
  raw: string,
  rule: string,
  witness = false,
) {
  const expected = expression(raw);
  assert.deepEqual(
    shape(actual, p, witness),
    shape(expected.node, expected.p, witness),
    rule,
  );
}
function importedCall(
  call: ts.CallExpression,
  p: Parsed,
  module: string,
  name: string,
  rule: string,
) {
  assert.ok(ts.isIdentifier(call.expression), rule);
  const id = p.ids.get(call.expression);
  assert.equal(
    id === undefined ? undefined : p.canonical.get(id),
    module + ":" + name,
    rule,
  );
}
function reassigns(root: ts.Node, p: Parsed, names: ts.Identifier[]) {
  const bindings = new Set(names.map((n) => p.ids.get(n)));
  return nodes(root).some(
    (n) =>
      (ts.isBinaryExpression(n) &&
        ts.isAssignmentOperator(n.operatorToken.kind) &&
        ts.isIdentifier(n.left) &&
        bindings.has(p.ids.get(n.left))) ||
      ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        ts.isIdentifier(n.operand) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
          n.operator,
        ) &&
        bindings.has(p.ids.get(n.operand))),
  );
}
function parameters(feature: ts.FunctionDeclaration) {
  const binding = feature.parameters[0]?.name;
  assert.ok(
    binding && ts.isObjectBindingPattern(binding),
    "original-borrowed-inputs",
  );
  return new Map(
    binding.elements.map((n) => {
      assert.ok(n.name && ts.isIdentifier(n.name), "original-borrowed-inputs");
      return [(n.propertyName ?? n.name).getText(), n.name];
    }),
  );
}
function attribute(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
) {
  const found = element.attributes.properties
    .filter(ts.isJsxAttribute)
    .filter((n) => n.name.getText() === name);
  assert.equal(found.length, 1, "actual-jsx-attribute:" + name);
  const value = found[0]!.initializer;
  assert.ok(
    value && ts.isJsxExpression(value) && value.expression,
    "actual-jsx-value:" + name,
  );
  return value.expression;
}
function tag(p: Parsed, name: string) {
  const module =
    name === "ExecutionDialog"
      ? "./ExecutionDialog.js"
      : name === "ComposerOptions"
        ? "./ComposerOptions.js"
        : name === "TaskRunPanel"
          ? "./TaskRunPanel.js"
          : undefined;
  return p.nodes
    .filter(
      (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
        ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n),
    )
    .filter((n) =>
      module
        ? ts.isIdentifier(n.tagName) &&
          p.canonical.get(p.ids.get(n.tagName)!) === module + ":" + name
        : n.tagName.getText() === name,
    );
}
function guard(element: ts.Node, p: Parsed, raws: string[], rule: string) {
  const found: ts.Node[] = [];
  for (let n: ts.Node | undefined = element; n; n = n.parent)
    if (
      ts.isJsxExpression(n) &&
      n.expression &&
      ts.isBinaryExpression(n.expression) &&
      n.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    )
      found.push(n.expression.left);
  assert.equal(found.length, raws.length, rule);
  found.forEach((n, i) => same(n, p, raws[i]!, rule));
}
function validate(contents: Sources) {
  const p = parsed({ ...contents, Original: recipe }),
    owner = p.Owner!,
    renderer = p.Renderer!;
  const feature = fn(owner, "useTaskRunPanel"),
    original = fn(p.Original!, "Original");
  assert.equal(
    feature.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ??
      false,
    false,
    "original-synchronous-hook",
  );
  assert.equal(feature.asteriskToken, undefined, "original-synchronous-hook");
  const borrowed = parameters(feature);
  assert.deepEqual([...borrowed.keys()], inputs, "original-borrowed-inputs");
  const ownerPattern = feature.parameters[0]!.name;
  assert.ok(ownerPattern && ts.isObjectBindingPattern(ownerPattern));
  assert.ok(
    ownerPattern.elements.every((n) => !n.initializer),
    "original-owner-no-policy-defaults",
  );
  // Inspect this feature, not independent exports that may legitimately own
  // different React/data policies in the same module.
  for (const node of nodes(feature.body!)) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const value = owner.canonical.get(owner.ids.get(node.expression)!);
      assert.ok(
        !value ||
          !/^react:use(?:Effect|LayoutEffect|Memo|Callback|Reducer|SyncExternalStore)$/.test(
            value,
          ),
        "owner-no-new-lifecycle-or-io",
      );
      assert.ok(
        owner.ids.get(node.expression) !== undefined ||
          !["fetch", "setTimeout", "setInterval", "queueMicrotask"].includes(
            node.expression.text,
          ),
        "owner-no-new-lifecycle-or-io",
      );
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      owner.ids.get(node.expression) === undefined
    )
      assert.ok(
        ![
          "window",
          "document",
          "process",
          "globalThis",
          "localStorage",
        ].includes(node.expression.text),
        "owner-no-ambient-environment",
      );
  }
  const statements = feature.body!.statements;
  const old = original.body!.statements;
  assert.equal(
    statements.length,
    old.length + actions.length + 1,
    "original-registration-and-recipe-count",
  );
  old.forEach((statement, index) =>
    assert.deepEqual(
      shape(statements[index]!, owner),
      shape(statement, p.Original!),
      index < 18
        ? "original-registration-and-observations"
        : "original-task-facts-and-option-recipes",
    ),
  );
  // Actual module/value is encoded in the recipe shape, including useState and
  // its setters. A foreign hook with an unused correct import cannot match.
  actions.forEach((name, index) => {
    const statement = statements[old.length + index]!;
    assert.ok(ts.isVariableStatement(statement), "original-five-actions");
    const variable = statement.declarationList.declarations[0]!;
    assert.equal(variable.name.getText(), name, "original-five-actions");
    assert.ok(variable.initializer, "original-five-actions");
    same(
      variable.initializer,
      owner,
      fixed.actions[index]!.raw,
      "original-five-actions",
      true,
    );
  });
  const returned = statements.at(-1)!;
  assert.ok(
    ts.isReturnStatement(returned) && returned.expression,
    "private-controller-return",
  );
  const returnedValue = ts.isAsExpression(returned.expression)
    ? returned.expression.expression
    : returned.expression;
  assert.ok(
    ts.isObjectLiteralExpression(returnedValue),
    "private-controller-return",
  );
  assert.deepEqual(
    returnedValue.properties.map((n) => {
      assert.ok(
        ts.isShorthandPropertyAssignment(n),
        "private-controller-return",
      );
      return n.name.getText();
    }),
    [...facts, ...actions],
    "private-controller-return",
  );
  for (const property of returnedValue.properties) {
    assert.ok(ts.isShorthandPropertyAssignment(property));
    const declaration = owner.nodes
      .filter(ts.isIdentifier)
      .find(
        (n) =>
          n.text === property.name.getText() &&
          n.parent !== property &&
          owner.ids.get(n) === owner.ids.get(property.name),
      );
    assert.ok(declaration, "direct-original-return-binding");
  }
  assert.ok(
    !reassigns(feature.body!, owner, [...borrowed.values()]),
    "captured-owner-inputs-not-reassigned",
  );
  const render = fn(renderer, "TaskRunPanel"),
    renderInputs = parameters(render);
  const renderPattern = render.parameters[0]!.name;
  assert.ok(renderPattern && ts.isObjectBindingPattern(renderPattern));
  for (const element of renderPattern.elements) {
    assert.ok(element.name);
    const name = (element.propertyName ?? element.name).getText();
    if (name === "compact" || name === "runtimeObserved")
      assert.equal(
        element.initializer?.getText(),
        "false",
        "original-detail-list-defaults",
      );
    else
      assert.equal(
        element.initializer,
        undefined,
        "original-detail-list-defaults",
      );
  }
  const first = render.body!.statements[0]!;
  assert.ok(ts.isVariableStatement(first), "unique-unconditional-feature-call");
  const panel = first.declarationList.declarations[0]!;
  assert.ok(
    ts.isIdentifier(panel.name) &&
      panel.initializer &&
      ts.isCallExpression(panel.initializer),
    "unique-unconditional-feature-call",
  );
  importedCall(
    panel.initializer,
    renderer,
    "./features/tasks/useTaskRunPanel.js",
    "useTaskRunPanel",
    "actual-feature-module-call",
  );
  const calls = renderer.nodes
    .filter(ts.isCallExpression)
    .filter(
      (n) =>
        ts.isIdentifier(n.expression) &&
        renderer.canonical.get(renderer.ids.get(n.expression)!) ===
          "./features/tasks/useTaskRunPanel.js:useTaskRunPanel",
    );
  assert.equal(calls.length, 1, "unique-unconditional-feature-call");
  assert.equal(panel.initializer.arguments.length, 1, "direct-render-inputs");
  const ports = panel.initializer.arguments[0]!;
  assert.ok(ts.isObjectLiteralExpression(ports));
  assert.deepEqual(
    ports.properties.map((n) => {
      assert.ok(
        ts.isShorthandPropertyAssignment(n) || ts.isPropertyAssignment(n),
        "direct-render-inputs",
      );
      return n.name.getText();
    }),
    inputs,
    "direct-render-inputs",
  );
  for (const property of ports.properties) {
    assert.ok(
      ts.isShorthandPropertyAssignment(property) ||
        ts.isPropertyAssignment(property),
      "direct-render-inputs",
    );
    const value = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : property.initializer;
    assert.ok(ts.isIdentifier(value), "direct-render-inputs");
    assert.equal(
      renderer.ids.get(value),
      renderer.ids.get(renderInputs.get(property.name.getText())!),
      "original-render-captured-binding",
    );
  }
  assert.ok(
    !reassigns(render.body!, renderer, [...renderInputs.values()]),
    "original-render-inputs-not-reassigned",
  );
  const nullGuard = render.body!.statements[1]!;
  const expectedNull = parsed({
    Check: `function Check(){if(!${panel.name.text})return null;}`,
  }).Check!;
  assert.deepEqual(
    shape(nullGuard, renderer),
    shape(fn(expectedNull, "Check").body!.statements[0]!, expectedNull),
    "original-non-task-null-position",
  );
  const destructure = render.body!.statements[2]!;
  assert.ok(
    ts.isVariableStatement(destructure),
    "direct-panel-facts-and-actions",
  );
  const values = destructure.declarationList.declarations[0]!;
  assert.ok(
    values.name &&
      ts.isObjectBindingPattern(values.name) &&
      values.initializer &&
      ts.isIdentifier(values.initializer),
    "direct-panel-facts-and-actions",
  );
  assert.equal(
    renderer.ids.get(values.initializer),
    renderer.ids.get(panel.name),
    "direct-panel-facts-and-actions",
  );
  assert.deepEqual(
    values.name.elements.map((n) => {
      assert.ok(n.name);
      return (n.propertyName ?? n.name).getText();
    }),
    [...facts, ...actions],
    "direct-panel-facts-and-actions",
  );
  for (const element of values.name.elements) {
    assert.ok(
      element.name && ts.isIdentifier(element.name),
      "direct-panel-facts-and-actions",
    );
    const id = renderer.ids.get(element.name);
    assert.notEqual(id, undefined);
    renderer.canonical.set(
      id!,
      (element.propertyName ?? element.name).getText(),
    );
  }
  assert.ok(
    !reassigns(
      render.body!,
      renderer,
      values.name.elements.map((element) => {
        assert.ok(element.name && ts.isIdentifier(element.name));
        return element.name;
      }),
    ),
    "direct-panel-values-not-reassigned",
  );
  const buttonByClass = (name: string) => {
    const found = tag(renderer, "button").filter((n) =>
      n.attributes.properties.some(
        (a) =>
          ts.isJsxAttribute(a) &&
          a.name.getText() === "className" &&
          a.initializer &&
          ts.isStringLiteral(a.initializer) &&
          a.initializer.text === name,
      ),
    );
    assert.equal(found.length, 1, "original-domain-button:" + name);
    return found[0]!;
  };
  const primary = buttonByClass("task-primary-action");
  for (const [name, value] of Object.entries({
    disabled: "primary.disabled",
    title: "primary.title",
    onClick: "primary.onSelect",
  }))
    same(
      attribute(primary, name),
      renderer,
      value,
      "original-primary-consumption",
    );
  guard(primary, renderer, ["primary"], "original-primary-consumption");
  const respond = buttonByClass("task-result-action");
  same(
    attribute(respond, "onClick"),
    renderer,
    "onRespond",
    "original-human-response-callback",
  );
  guard(respond, renderer, ["canRespond"], "original-human-response-callback");
  const expectedGuards = [
    ["active && run"],
    ["active && !run"],
    [
      'run.record && !run.sourceStopped && (["queued","paused"].includes(run.record.status)||run.hasSourceWatch)',
      "!compact && run",
    ],
  ];
  for (let index = 0; index < 3; index++) {
    const name = actions[index]!,
      buttons = tag(renderer, "button").filter((n) =>
        n.attributes.properties.some(
          (a) =>
            ts.isJsxAttribute(a) &&
            a.name.getText() === "onClick" &&
            a.initializer &&
            ts.isJsxExpression(a.initializer) &&
            a.initializer.expression &&
            ts.isIdentifier(a.initializer.expression) &&
            renderer.canonical.get(
              renderer.ids.get(a.initializer.expression)!,
            ) === name,
        ),
      );
    assert.equal(buttons.length, 1, "direct-original-action-consumption");
    same(
      attribute(buttons[0]!, "onClick"),
      renderer,
      name,
      "direct-original-action-consumption",
    );
    same(
      attribute(buttons[0]!, "disabled"),
      renderer,
      index === 0
        ? "busy || !connected || run.stopRequested"
        : "busy || !connected",
      "original-action-qualification",
    );
    guard(
      buttons[0]!,
      renderer,
      expectedGuards[index]!,
      "original-action-qualification",
    );
  }
  const menus = tag(renderer, "ComposerOptions");
  assert.equal(menus.length, 1, "original-options-consumption");
  same(
    attribute(menus[0]!, "options"),
    renderer,
    "secondary",
    "original-options-consumption",
  );
  guard(
    menus[0]!,
    renderer,
    ["secondary.length > 0"],
    "original-options-consumption",
  );
  const dialogs = tag(renderer, "ExecutionDialog");
  assert.equal(dialogs.length, 1, "original-inspection-consumption");
  same(
    attribute(dialogs[0]!, "client"),
    renderer,
    "client",
    "original-inspection-consumption",
  );
  same(
    attribute(dialogs[0]!, "scope"),
    renderer,
    "{projectId:thread?.projectId??artifact.projectId,artifactId:artifact.id,conversationId:thread?.conversationId,threadId,taskRun:true}",
    "original-inspection-scope",
  );
  same(
    attribute(dialogs[0]!, "onClose"),
    renderer,
    "closeInspection",
    "direct-original-action-consumption",
  );
  same(
    attribute(dialogs[0]!, "onOpen"),
    renderer,
    "openInspectionContent",
    "direct-original-action-consumption",
  );
  guard(
    dialogs[0]!,
    renderer,
    ["inspect && threadId"],
    "original-inspection-consumption",
  );
  // The parents keep their different legitimate detail/list contracts. No
  // full parent JSX lock; unrelated components and domain growth are allowed.
  for (const [key, required, condition] of [
    [
      "Editor",
      {
        artifact: "artifact",
        state: "state",
        client: "client",
        onRespond: "()=>onTaskInput(true)",
        onOpen: "onOpen",
      },
      'artifact.content.kind==="task" && !draft && !old',
    ],
    [
      "List",
      {
        artifact: "a",
        state: "state",
        client: "client",
        onRespond: "()=>onOpen(a.id)",
        onOpen: "onOpen",
        runtimeReadError: "runtimeErrors[a.id]",
      },
      "!own",
    ],
  ] as const) {
    const parent = p[key]!,
      components = tag(parent, "TaskRunPanel");
    assert.equal(components.length, 1, "actual-parent-feature-consumer");
    for (const [name, raw] of Object.entries(required))
      same(
        attribute(components[0]!, name),
        parent,
        raw,
        "original-parent-borrowed-contract",
      );
    guard(
      components[0]!,
      parent,
      [condition],
      "original-parent-mount-qualification",
    );
    for (const name of ["compact", "runtimeObserved"]) {
      const attributes = components[0]!.attributes.properties
        .filter(ts.isJsxAttribute)
        .filter((n) => n.name.getText() === name);
      assert.equal(
        attributes.length,
        key === "List" ? 1 : 0,
        "original-detail-list-observation-policy",
      );
      if (key === "List")
        assert.equal(
          attributes[0]!.initializer,
          undefined,
          "original-detail-list-observation-policy",
        );
    }
  }
}

function changed(
  key: keyof Sources,
  target: string,
  replacement: string,
): Sources {
  assert.equal(
    sources[key].split(target).length,
    2,
    "unique-legal-mutation-target",
  );
  const changed = {
    ...sources,
    [key]: sources[key].replace(target, replacement),
  };
  parsed(changed);
  return changed;
}
test("finite committed controller recipe archive has independent raw hashes", () => {
  assert.equal(fixed.git, "d93326c0114bc6e77b2f50b0f6a19a86dd9cd774");
  assert.equal(fixed.statements.length, 42);
  assert.equal(fixed.actions.length, 5);
  for (const record of [...fixed.statements, ...fixed.actions])
    assert.equal(
      createHash("sha256").update(record.raw).digest("hex"),
      record.sha256,
    );
});
test("actual complete controller, renderer and two distinct parent consumers", () =>
  validate(sources));

type Negative = readonly [keyof Sources, string, string, string];
const negatives: Record<string, readonly Negative[]> = {
  "registration, actual helpers and distinct observation contracts": [
    [
      "Owner",
      'import { useRef, useState } from "react";',
      'import {useRef,useState as correctState} from "react"; import {useState} from "./foreign.js";',
      "original-registration-and-observations",
    ],
    [
      "Owner",
      'import { useObservedRead } from "../../useObservedRead.js";',
      'import {useObservedRead as originalRead} from "../../useObservedRead.js"; import {useObservedRead} from "./foreign.js";',
      "original-registration-and-observations",
    ],
    [
      "Owner",
      'from "../../../../../packages/core/src/task-runtime.js"',
      'from "./foreign-task.js"',
      "original-registration-and-observations",
    ],
    [
      "Owner",
      "const [inspect, setInspect] = useState(false);",
      "const [inspect,setInspect]=[false,()=>{}];",
      "original-registration-and-observations",
    ],
    [
      "Owner",
      "api.current = client;\n  const [inspect, setInspect] = useState(false);",
      "const [inspect,setInspect]=useState(false); api.current=client;",
      "original-registration-and-observations",
    ],
    [
      "Owner",
      "!runtimeObserved,",
      "runtimeObserved,",
      "original-registration-and-observations",
    ],
    [
      "Owner",
      "enabled: isTask && !!human && !compact && client.online,",
      "enabled: isTask && !!human && client.online,",
      "original-registration-and-observations",
    ],
    [
      "Owner",
      "client.boot?.csrfToken,",
      "client.boot?.actantId,",
      "original-registration-and-observations",
    ],
    [
      "Owner",
      "read: () => api.current.taskResponses(artifact.id),",
      "read: (signal) => api.current.taskResponses(artifact.id,{signal}),",
      "original-registration-and-observations",
    ],
    [
      "Owner",
      "export function useTaskRunPanel(",
      "export async function useTaskRunPanel(",
      "original-synchronous-hook",
    ],
  ],
  "no new lifecycle, transport or ambient environment": [
    [
      "Owner",
      "const pending = useRef(false);",
      'const pending = useRef(false); fetch("/bad");',
      "owner-no-new-lifecycle-or-io",
    ],
    [
      "Owner",
      "const pending = useRef(false);",
      "const pending = useRef(false); setInterval(()=>{},10);",
      "owner-no-new-lifecycle-or-io",
    ],
    [
      "Owner",
      "const pending = useRef(false);",
      "const pending = useRef(false); const environment = process.env.X;",
      "owner-no-ambient-environment",
    ],
  ],
  "qualified facts, captured mutation refresh and reference option ordering": [
    [
      "Owner",
      "live?.scope === observationScope &&",
      "live?.scope !== observationScope &&",
      "original-task-facts-and-option-recipes",
    ],
    [
      "Owner",
      "await client.refresh();",
      "await api.current.refresh();",
      "original-task-facts-and-option-recipes",
    ],
    [
      "Owner",
      "if (pending.current) return;",
      "if (busy) return;",
      "original-task-facts-and-option-recipes",
    ],
    [
      "Owner",
      'else if (run?.threadState === "failed") primary = start;',
      'else if (run?.threadState === "failed") primary = results;',
      "original-task-facts-and-option-recipes",
    ],
    [
      "Owner",
      "primary?.onSelect !== records.onSelect",
      "primary?.label !== records.label",
      "original-task-facts-and-option-recipes",
    ],
    [
      "Owner",
      "const connected = client.online && client.boot?.capabilities.runtime;",
      "const connected = Boolean(client.online && client.boot?.capabilities.runtime);",
      "original-task-facts-and-option-recipes",
    ],
  ],
  "five exact action payloads, close order and private return": [
    [
      "Owner",
      'run: run!.run,\n        revision: run!.controlRevision,\n        action: "stop",',
      'run: run!.run, revision: 1, action:"stop",',
      "original-five-actions",
    ],
    [
      "Owner",
      "run: task.runRequested,\n        revision: 1,",
      "run: task.runRequested, revision: 2,",
      "original-five-actions",
    ],
    [
      "Owner",
      'action: run!.paused ? "resume" : "pause",',
      'action: run!.paused ? "pause" : "resume",',
      "original-five-actions",
    ],
    [
      "Owner",
      "setInspect(false);\n    onOpen?.(id);",
      "onOpen?.(id); setInspect(false);",
      "original-five-actions",
    ],
    [
      "Owner",
      "    busy,\n    error,\n    readError,",
      "    busy,\n    error,\n    readError,\n    setBusy,",
      "private-controller-return",
    ],
  ],
  "actual renderer module, direct borrowed inputs and direct action values": [
    [
      "Renderer",
      'import { useTaskRunPanel } from "./features/tasks/useTaskRunPanel.js";',
      'import {useTaskRunPanel as correctPanel} from "./features/tasks/useTaskRunPanel.js"; import {useTaskRunPanel} from "./foreign.js";',
      "actual-feature-module-call",
    ],
    [
      "Renderer",
      "    client,\n    onOpen,\n    compact,",
      "    client: {...client},\n    onOpen,\n    compact,",
      "direct-render-inputs",
    ],
    [
      "Renderer",
      "  } = panel;\n  return (",
      "  } = panel;\n  client = {...client};\n  return (",
      "original-render-inputs-not-reassigned",
    ],
    [
      "Renderer",
      "  } = panel;",
      "  } = {...panel};",
      "direct-panel-facts-and-actions",
    ],
    [
      "Renderer",
      "  } = panel;\n  return (",
      "  } = panel;\n  stopCurrentRun = () => {};\n  return (",
      "direct-panel-values-not-reassigned",
    ],
    [
      "Renderer",
      "onClick={stopCurrentRun}",
      "onClick={() => stopCurrentRun()}",
      "direct-original-action-consumption",
    ],
    [
      "Renderer",
      "onClick={stopCurrentRun}",
      "onClick={(()=>{const stopCurrentRun=()=>{};return stopCurrentRun})()}",
      "direct-original-action-consumption",
    ],
  ],
  "original downstream qualifications and separate parent modes": [
    [
      "Renderer",
      "onClick={primary.onSelect}",
      "onClick={() => primary.onSelect()}",
      "original-primary-consumption",
    ],
    [
      "Renderer",
      "disabled={busy || !connected || run.stopRequested}",
      "disabled={busy || !connected}",
      "original-action-qualification",
    ],
    [
      "Renderer",
      "{active && run && (",
      "{active && (",
      "original-action-qualification",
    ],
    [
      "Renderer",
      "projectId: thread?.projectId ?? artifact.projectId,",
      "projectId: artifact.projectId,",
      "original-inspection-scope",
    ],
    [
      "Renderer",
      "onClick={onRespond}",
      "onClick={() => onRespond()}",
      "original-human-response-callback",
    ],
    [
      "Renderer",
      "compact = false,",
      "compact = true,",
      "original-detail-list-defaults",
    ],
    [
      "List",
      "                  runtimeObserved\n",
      "                  runtimeObserved={false}\n",
      "original-detail-list-observation-policy",
    ],
    [
      "Editor",
      'artifact.content.kind === "task" && !draft && !old && (',
      'artifact.content.kind === "task" && !draft && (',
      "original-parent-mount-qualification",
    ],
  ],
};
for (const [name, cases] of Object.entries(negatives))
  test(name + " reject parse-valid counterfactuals", () => {
    for (const [key, target, replacement, rule] of cases)
      assert.throws(
        () => validate(changed(key, target, replacement)),
        (error) => {
          assert.ok(error instanceof assert.AssertionError, rule);
          assert.equal(error.message.split("\n")[0], rule, target);
          return true;
        },
      );
  });
test("legal actual import/local aliases, static types and unrelated domain growth", () => {
  const owner = sources.Owner.replace(
    'import { useRef, useState } from "react";',
    'import {useRef as ref,useState as stateSlot} from "react";',
  )
    .replace(/\buseRef(?=[(<])/g, "ref")
    .replace(/\buseState(?=[(<])/g, "stateSlot")
    .replace(
      "export function useTaskRunPanel(",
      "const observe = useObservedRead;\nexport function useTaskRunPanel(",
    )
    .replace(/\buseObservedRead\(/g, "observe(");
  validate({ ...sources, Owner: owner });
  const renderer = sources.Renderer.replace(
    "import { useTaskRunPanel }",
    "import { useTaskRunPanel as panelHook }",
  )
    .replace("const panel = useTaskRunPanel(", "const panel = panelHook(")
    .replace(
      "import { ExecutionDialog }",
      "import { ExecutionDialog as Inspector }",
    )
    .replace(/<ExecutionDialog\b/g, "<Inspector")
    .replace("import { ComposerOptions }", "import { ComposerOptions as Menu }")
    .replace(/<ComposerOptions\b/g, "<Menu")
    .replace(/\bbusy\b/g, "isBusy")
    .replace("    isBusy,", "    busy: isBusy,");
  validate({ ...sources, Renderer: renderer });
  validate({
    ...sources,
    Owner:
      sources.Owner.replace("useState(false);", "useState<boolean>(false);") +
      '\nimport type {Future} from "./future.js";\nimport {unused} from "./foreign.js";\nimport {useEffect} from "react";\nexport function independentFeature(process:{env:{X:string}}){useEffect(()=>{},[]);return process.env.X;}\nexport const count=(process:readonly number[])=>process.map(value=>value+1);\nexport const version=1; // independent pure domain\n',
    Renderer:
      sources.Renderer.replace(
        'aria-label="实际执行与回应"',
        'aria-label="实际执行与回应" data-domain="future"',
      ) + "\nexport type FutureDomain = string;\n",
    Editor:
      sources.Editor +
      '\nexport const unrelatedFeature = () => <aside className="new-domain"/>;\n',
  });
});
