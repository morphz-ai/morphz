import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import {
  scheduleOriginal,
  scheduleSourceRecipes,
} from "./fixtures/subject-schedules-controller.js";

// Finite owned lifecycle and actual borrowed consumers. This is neither a
// whole-renderer/Client snapshot nor a general JavaScript purity theorem.
const paths = {
  Owner: "../apps/web/src/features/subject/useSubjectSchedules.ts",
  Renderer: "../apps/web/src/SubjectSchedules.tsx",
};
type Sources = Record<keyof typeof paths, string>;
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const facts =
  "rows error loading more activity nativeError nativeRows refresh".split(" ");
const imports = `import {useEffect,useRef,useState} from "react";
import {z} from "zod";
import type {applicationCall} from "../../application-transport.js";
import {platformTaskSchema,type PlatformTask} from "../../platform-client.js";
import {taskRuntimeSchema,type TaskRuntime} from "../../../../../packages/core/src/task-runtime.js";
import {liveArrangement} from "../../subject-sidebar-model.js";
import {runtimeArrangements} from "../../subject-schedules-model.js";
import type {WorkspaceClient} from "../../client.js";
type SubjectSchedulesClient=Pick<WorkspaceClient,"boot"|"online"|"refresh">;
type SubjectScheduleGateway=(method:"runtime.navigation"|"tasks.list"|"task.snapshot",params:unknown,options:NonNullable<Parameters<typeof applicationCall>[2]>)=>ReturnType<typeof applicationCall>;
`;
const old =
  imports +
  `function Original({client,call:applicationCall}:{client:SubjectSchedulesClient;call:SubjectScheduleGateway}){
${scheduleOriginal.prelude.join("\n")}
const refresh=()=>{setAttempt(n=>n+1)};
return {${facts.join(",")}} as const;
}
function Sources(){const exactThread=${scheduleSourceRecipes.exactThread};onInspect(${scheduleSourceRecipes.inspect});}`;
function nodes(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  function walk(n: ts.Node) {
    all.push(n);
    n.forEachChild((c) => {
      walk(c);
    });
  }
  walk(root);
  return all;
}
type Parsed = {
  source: ts.SourceFile;
  all: ts.Node[];
  ids: Map<ts.Node, number | undefined>;
  imports: Map<number, string>;
  runtime: Map<number, string>;
};
function parse(contents: Record<string, string>) {
  const cwd = "/schedules-boundary",
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
    snap = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snap.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "parse-valid-counterfactual",
    );
    return Object.fromEntries(
      Object.keys(contents).map((key) => {
        const source = project.program.getSourceFile(cwd + "/" + key + ".tsx")!,
          all = nodes(source),
          identifiers = all.filter(ts.isIdentifier),
          symbols = project.checker.getSymbolAtLocation(identifiers),
          ids = new Map<ts.Node, number | undefined>();
        identifiers.forEach((node, i) => ids.set(node, symbols[i]?.id));
        for (const p of all.filter(ts.isShorthandPropertyAssignment))
          ids.set(
            p.name,
            project.checker.getShorthandAssignmentValueSymbol(p)?.id,
          );
        const imports = new Map<number, string>(),
          runtime = new Map<number, string>();
        for (const entry of source.statements.filter(ts.isImportDeclaration)) {
          const named = entry.importClause?.namedBindings;
          if (!named || !ts.isNamedImports(named)) continue;
          for (const binding of named.elements) {
            const id = ids.get(binding.name);
            if (id === undefined) continue;
            const tag =
              entry.moduleSpecifier.getText().slice(1, -1) +
              ":" +
              (binding.propertyName ?? binding.name).text;
            imports.set(id, tag);
            if (
              entry.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
              !binding.isTypeOnly
            )
              runtime.set(id, tag);
          }
        }
        return [key, { source, all, ids, imports, runtime } satisfies Parsed];
      }),
    ) as Record<string, Parsed>;
  } finally {
    snap.dispose();
  }
}
function shape(node: ts.Node | undefined, p: Parsed): unknown {
  if (!node) return null;
  if (ts.isIdentifier(node)) {
    const id = p.ids.get(node);
    return [
      "id",
      id === undefined ? node.text : (p.imports.get(id) ?? node.text),
    ];
  }
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    return [node.kind, node.text];
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child, p));
  });
  return children.length
    ? [node.kind, ...children]
    : [node.kind, node.getText()];
}
function fn(p: Parsed, name: string) {
  const n = p.source.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  assert(
    n && ts.isFunctionDeclaration(n) && n.body,
    "actual module function " + name,
  );
  return n;
}
function same(
  a: ts.Node | undefined,
  ap: Parsed,
  b: ts.Node | undefined,
  bp: Parsed,
  rule: string,
) {
  assert.deepEqual(shape(a, ap), shape(b, bp), rule);
}
function binding(p: Parsed, node: ts.Node) {
  return p.ids.get(node);
}
function imported(p: Parsed, node: ts.Node, tag: string) {
  const id = p.ids.get(node);
  return id !== undefined && p.runtime.get(id) === tag;
}
function variable(root: ts.Node, name: string) {
  const v = nodes(root).find(
    (n) => ts.isVariableDeclaration(n) && n.name.getText() === name,
  );
  assert(v && ts.isVariableDeclaration(v), "owned variable " + name);
  return v;
}
function validate(input: Sources) {
  const { Owner: o, Renderer: r, Old: e } = parse({ ...input, Old: old }),
    owner = fn(o!, "useSubjectSchedules"),
    renderer = fn(r!, "SubjectSchedules"),
    expected = fn(e!, "Original");
  assert(
    !owner.asteriskToken &&
      !owner.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
    "synchronous-owned-hook",
  );
  assert(
    !renderer.asteriskToken &&
      !renderer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
    "synchronous-actual-renderer",
  );
  // Exact narrow borrowed types, not import-count or complete-module locks.
  for (const name of ["SubjectSchedulesClient", "SubjectScheduleGateway"]) {
    const actual = o!.source.statements.find(
        (n) => ts.isTypeAliasDeclaration(n) && n.name.text === name,
      ),
      original = e!.source.statements.find(
        (n) => ts.isTypeAliasDeclaration(n) && n.name.text === name,
      );
    assert(
      actual &&
        original &&
        ts.isTypeAliasDeclaration(actual) &&
        ts.isTypeAliasDeclaration(original),
      "narrow-borrowed-types",
    );
    same(actual.type, o!, original.type, e!, "narrow-borrowed-types");
  }
  const parameter = owner.parameters[0]!;
  same(
    parameter,
    o!,
    expected.parameters[0],
    e!,
    "borrowed-client-and-logical-gateway",
  );
  const statements = [...owner.body!.statements],
    expectedStatements = [...expected.body!.statements];
  const effect = nodes(owner).find(
    (n) =>
      ts.isCallExpression(n) && imported(o!, n.expression, "react:useEffect"),
  );
  const oldEffect = nodes(expected).find(
    (n) =>
      ts.isCallExpression(n) && imported(e!, n.expression, "react:useEffect"),
  );
  assert(
    effect &&
      oldEffect &&
      ts.isCallExpression(effect) &&
      ts.isCallExpression(oldEffect),
    "original-observation-registration",
  );
  same(
    effect.arguments[1],
    o!,
    oldEffect.arguments[1],
    e!,
    "identity-attempt-online-invalidation",
  );
  const list = nodes(effect).find(
      (n) =>
        ts.isCallExpression(n) && n.arguments[0]?.getText() === '"tasks.list"',
    ),
    oldList = nodes(oldEffect).find(
      (n) =>
        ts.isCallExpression(n) && n.arguments[0]?.getText() === '"tasks.list"',
    );
  assert(
    list &&
      oldList &&
      ts.isCallExpression(list) &&
      ts.isCallExpression(oldList),
    "limit50-agent-list",
  );
  same(list.arguments[1], o!, oldList.arguments[1], e!, "limit50-agent-list");
  const loop = nodes(effect).find(ts.isForStatement),
    oldLoop = nodes(oldEffect).find(ts.isForStatement);
  assert(loop && oldLoop, "snapshot16-batch4");
  same(loop.condition, o!, oldLoop.condition, e!, "snapshot16-batch4");
  same(loop.incrementor, o!, oldLoop.incrementor, e!, "snapshot16-batch4");
  const refreshCall = nodes(effect).find(
      (n) =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "refresh",
    ),
    oldRefresh = nodes(oldEffect).find(
      (n) =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "refresh",
    );
  same(refreshCall, o!, oldRefresh, e!, "captured-render-client-refresh");
  assert.equal(
    statements.length,
    13,
    "complete-owned-lifecycle-not-setter-bag",
  );
  for (let i = 0; i < 11; i++)
    same(
      statements[i],
      o!,
      expectedStatements[i],
      e!,
      i === 10
        ? "complete-cancelled-atomic-observation"
        : "original-ordered-state-and-facts",
    );
  same(
    statements[11],
    o!,
    expectedStatements[11],
    e!,
    "functional-semantic-refresh",
  );
  same(
    statements[12],
    o!,
    expectedStatements[12],
    e!,
    "direct-readonly-facts-and-semantic-action",
  );
  const registrations = nodes(owner).filter(
    (n) =>
      ts.isCallExpression(n) &&
      ["react:useState", "react:useRef", "react:useEffect"].some((tag) =>
        imported(o!, n.expression, tag),
      ),
  );
  assert.deepEqual(
    registrations
      .map((n) => (n as ts.CallExpression).expression)
      .map((n) => o!.runtime.get(o!.ids.get(n)!)),
    [
      "react:useState",
      "react:useState",
      "react:useState",
      "react:useState",
      "react:useState",
      "react:useRef",
      "react:useEffect",
    ],
    "original-seven-primitive-order",
  );
  const first = renderer.body!.statements[0];
  assert(
    first &&
      ts.isVariableStatement(first) &&
      first.declarationList.declarations.length === 1,
    "original-unconditional-consumer-slot",
  );
  const declaration = first.declarationList.declarations[0]!;
  assert(
    ts.isObjectBindingPattern(declaration.name) &&
      declaration.initializer &&
      ts.isCallExpression(declaration.initializer),
    "direct-owned-hook-consumer",
  );
  const call = declaration.initializer;
  assert(
    imported(
      r!,
      call.expression,
      "./features/subject/useSubjectSchedules.js:useSubjectSchedules",
    ),
    "actual-hook-import-symbol",
  );
  assert.deepEqual(
    declaration.name.elements.map((b) => b.name?.getText()),
    facts,
    "direct-eight-facts",
  );
  const clientParameter = renderer.parameters[0]!.name;
  assert(
    clientParameter && ts.isObjectBindingPattern(clientParameter),
    "actual-borrowed-client-symbol",
  );
  const clientBinding = clientParameter.elements.find(
    (b) => (b.propertyName ?? b.name)?.getText() === "client",
  );
  assert(
    clientBinding && clientBinding.name && ts.isIdentifier(clientBinding.name),
    "actual-borrowed-client-symbol",
  );
  assert.equal(call.arguments.length, 1, "exact-two-borrowed-ports");
  const options = call.arguments[0];
  assert(
    options && ts.isObjectLiteralExpression(options),
    "exact-two-borrowed-ports",
  );
  assert.deepEqual(
    options.properties.map((p) => (p as ts.PropertyAssignment).name?.getText()),
    ["client", "call"],
    "exact-two-borrowed-ports",
  );
  const clientOption = options.properties[0],
    gatewayOption = options.properties[1];
  assert(
    clientOption &&
      ts.isShorthandPropertyAssignment(clientOption) &&
      binding(r!, clientOption.name) !== undefined &&
      binding(r!, clientOption.name) === binding(r!, clientBinding.name),
    "actual-borrowed-client-symbol",
  );
  assert(
    gatewayOption &&
      ts.isPropertyAssignment(gatewayOption) &&
      imported(
        r!,
        gatewayOption.initializer,
        "./application-transport.js:applicationCall",
      ),
    "actual-logical-gateway-symbol",
  );
  const refreshBinding = declaration.name.elements.at(-1)!;
  assert(
    refreshBinding.name && ts.isIdentifier(refreshBinding.name),
    "direct-semantic-refresh-consumer",
  );
  const button = nodes(renderer).find(
    (n) =>
      ts.isJsxOpeningElement(n) &&
      n.tagName.getText() === "button" &&
      n.attributes.getText().includes("刷新定时任务"),
  );
  assert(button && ts.isJsxOpeningElement(button), "actual-refresh-button");
  const action = button.attributes.properties.find(
    (n) => ts.isJsxAttribute(n) && n.name.getText() === "onClick",
  );
  assert(
    action &&
      ts.isJsxAttribute(action) &&
      action.initializer &&
      ts.isJsxExpression(action.initializer) &&
      action.initializer.expression &&
      binding(r!, action.initializer.expression as ts.Identifier) ===
        binding(r!, refreshBinding.name),
    "direct-semantic-refresh-consumer",
  );
  const exact = variable(renderer, "exactThread"),
    originalExact = variable(fn(e!, "Sources"), "exactThread");
  same(
    exact.initializer,
    r!,
    originalExact.initializer,
    e!,
    "exact-four-source-qualification",
  );
  const inspect = nodes(renderer).find(
      (n) => ts.isCallExpression(n) && n.expression.getText() === "onInspect",
    ),
    originalInspect = nodes(fn(e!, "Sources")).find(
      (n) => ts.isCallExpression(n) && n.expression.getText() === "onInspect",
    );
  assert(
    inspect &&
      originalInspect &&
      ts.isCallExpression(inspect) &&
      ts.isCallExpression(originalInspect),
    "exact-five-inspection-scope",
  );
  same(
    inspect.arguments[0],
    r!,
    originalInspect.arguments[0],
    e!,
    "exact-five-inspection-scope",
  );
}
function changed(key: keyof Sources, from: string, to: string) {
  assert(sources[key].includes(from), "counterfactual target");
  return { ...sources, [key]: sources[key].replace(from, to) };
}
function rejects(input: Sources, rule: string) {
  assert.throws(() => validate(input), new RegExp(rule));
}

test("independent eleven complete original statements retain actual Git provenance", () => {
  assert.equal(scheduleOriginal.prelude.length, 11);
  scheduleOriginal.prelude.forEach((raw, i) =>
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      scheduleOriginal.manifest.preludeSha[i],
    ),
  );
  validate(sources);
});
test("parse-valid limit, batching, invalidation and captured refresh counterfactuals", () => {
  rejects(changed("Owner", "limit: 50", "limit: 51"), "limit50-agent-list");
  rejects(
    changed(
      "Owner",
      "Math.min(candidates.length, 16)",
      "Math.min(candidates.length, 17)",
    ),
    "snapshot16-batch4",
  );
  rejects(changed("Owner", "offset += 4", "offset += 8"), "snapshot16-batch4");
  rejects(
    changed(
      "Owner",
      "[identity, attempt, client.online, client.boot!.runtime.connected]",
      "[identity, attempt, client.online]",
    ),
    "identity-attempt-online-invalidation",
  );
  rejects(
    changed(
      "Owner",
      "await client.refresh();",
      'await applicationCall("runtime.navigation", {});',
    ),
    "captured-render-client-refresh",
  );
});
test("parse-valid cancellation, publication and functional-refresh counterfactuals", () => {
  rejects(
    changed(
      "Owner",
      "if (!controller.signal.aborted)\n          setError",
      "if (true)\n          setError",
    ),
    "complete-cancelled-atomic-observation",
  );
  rejects(
    changed(
      "Owner",
      "if (readError) throw new Error",
      "if (false) throw new Error",
    ),
    "complete-cancelled-atomic-observation",
  );
  rejects(
    changed("Owner", "setAttempt((n) => n + 1)", "setAttempt(attempt + 1)"),
    "functional-semantic-refresh",
  );
  rejects(
    changed(
      "Owner",
      "    refresh,\n  } as const",
      "    refresh,\n    setAttempt,\n  } as const",
    ),
    "direct-readonly-facts-and-semantic-action",
  );
  rejects(
    changed(
      "Owner",
      "  const refreshedAttempt = useRef(0);",
      "  const refreshedAttempt = useRef(0);\n  useState(false);",
    ),
    "complete-owned-lifecycle-not-setter-bag",
  );
});
test("actual import, direct call and render parameter symbols cannot be replaced", () => {
  rejects(
    changed(
      "Renderer",
      "./features/subject/useSubjectSchedules.js",
      "./fake-useSubjectSchedules.js",
    ),
    "actual-hook-import-symbol",
  );
  rejects(
    changed(
      "Renderer",
      "useSubjectSchedules({ client, call: applicationCall })",
      "(() => useSubjectSchedules({ client, call: applicationCall }))()",
    ),
    "actual-hook-import-symbol",
  );
  rejects(
    changed(
      "Renderer",
      "useSubjectSchedules({ client, call: applicationCall })",
      "client.online ? useSubjectSchedules({ client, call: applicationCall }) : null!",
    ),
    "direct-owned-hook-consumer",
  );
  const shadow = changed(
    "Renderer",
    "  client,\n  onOpen,",
    "  client: _renderClient,\n  onOpen,",
  );
  rejects(
    {
      ...shadow,
      Renderer: shadow.Renderer + "\nconst client = {} as WorkspaceClient;\n",
    },
    "actual-borrowed-client-symbol",
  );
  rejects(
    changed(
      "Renderer",
      "call: applicationCall",
      "call: (() => applicationCall)()",
    ),
    "actual-logical-gateway-symbol",
  );
  rejects(
    changed("Renderer", "onClick={refresh}", "onClick={() => refresh()}"),
    "direct-semantic-refresh-consumer",
  );
});
test("native action uses complete persisted source qualification and inspection scope", () => {
  rejects(
    changed(
      "Renderer",
      "thread.inputId === row.inputId",
      "thread.inputId !== row.inputId",
    ),
    "exact-four-source-qualification",
  );
  rejects(
    changed("Renderer", "artifactId: null", "artifactId: row.rootId"),
    "exact-five-inspection-scope",
  );
  rejects(
    changed(
      "Owner",
      '"boot" | "online" | "refresh"',
      '"boot" | "online" | "refresh" | "execute"',
    ),
    "narrow-borrowed-types",
  );
  rejects(
    changed("Owner", 'from "../../client.js"', 'from "../../fake-client.js"'),
    "narrow-borrowed-types",
  );
});
test("legitimate React/type/import aliases and unrelated pure/renderer growth remain valid", () => {
  const aliases = {
    ...sources,
    Owner:
      sources.Owner.replaceAll("useState", "ownedState")
        .replace("useRef, ownedState", "useRef, useState as ownedState")
        .replaceAll("PlatformTask", "OwnedTask")
        .replace("type OwnedTask,", "type PlatformTask as OwnedTask,") +
      "\nexport const unrelatedQuality = (value: number) => value + 1;\n",
    Renderer: sources.Renderer.replaceAll(
      "useSubjectSchedules",
      "scheduleObservation",
    )
      .replace(
        "import { scheduleObservation }",
        "import { useSubjectSchedules as scheduleObservation }",
      )
      .replace(
        "./features/subject/scheduleObservation.js",
        "./features/subject/useSubjectSchedules.js",
      )
      .replace(
        "<h3>定时任务</h3>",
        "<h3>定时任务</h3>{false && <span>unrelated legal JSX</span>}",
      ),
  };
  validate(aliases);
});
