import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isArrowFunction,
  isCallExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectLiteralExpression,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { executionInspectionOriginal as fixed114 } from "./fixtures/execution-inspection-114960d1.js";

// Finite first-two Thread-glyph contract, not all presentation/React/visual
// correctness. 14ae1de6 original row, group heading/status and hook arguments
// supply the hashes. Whitespace plus only the original Icon map and inner
// glyph are normalized; other expressions retain their parentheses.
// Job controls/body, other components and CSS are deliberately outside scope.
// Dialog lifecycle moved to the actual execution-inspection owner: current
// Dialog checks only its original Thread-glyph facts/tree. The original Dialog
// lifecycle digest remains below as an immutable fixed114 historical proof.
// Sidebar's original row contract is unchanged; the approved detail heading
// now consumes the same glyph, with separately checked live snapshot facts.
// CI needs no Git checkout/history;
// SSR and mounted scheduling are separate tests.
const baseline = {
  Sidebar: {
    scope: "a677e6fdecd44d0e500dcbe7a94ef42db84f62e3c66c2431150f7e8d640d9c22",
    hooks: "be2a8c9a4fc6e53503f17431c19d38365136d32edef00df8956e46f7b6f0ec58",
  },
  Dialog: {
    scope: "f8fd63c71a4b802477f18ab792c2cfc941dc8c03a52a750923d7bc750c0eff44",
    hooks: "1e998a4395b57e6b78a2459d27167f5c73ab0c650f689c8f8137281b794e4015",
  },
  Running: "7ef4664820d8b216d1ee724b63456459185b15eca9c741963e3f57b687e6478e",
} as const;
const paths = {
  Icon: "ExecutionStatusIcon.tsx",
  Sidebar: "ExecutionSidebar.tsx",
  Dialog: "ExecutionDialog.tsx",
  Running: "RunningActivityIcon.tsx",
} as const;
type Sources = Record<keyof typeof paths, string>;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  symbols: Map<Node, number | undefined>;
};
const glyphs = [
  "CircleCheck",
  "CircleHelp",
  "CircleSlash",
  "CircleX",
  "Clock3",
  "Pause",
];
const expectedIcon = `
import { CircleCheck, CircleHelp, CircleSlash, CircleX, Clock3, Pause } from "lucide-react";
import type { ActivityStatus } from "./execution-activity.js";
import { RunningActivityIcon } from "./RunningActivityIcon.js";
export function ExecutionStatusIcon({kind, size}: Readonly<{
  kind: ActivityStatus["kind"] | undefined; size: 18 | 19;
}>) {
  if (kind === "running") return <RunningActivityIcon />;
  const Icon = { waiting: Clock3, paused: Pause, ended: CircleCheck,
    failed: CircleX, cancelled: CircleSlash, unknown: CircleHelp }[kind ?? "unknown"];
  return <Icon size={size} aria-hidden="true" />;
}`;
const originalFragments = `function original() {
  const Icon = { running: Activity, waiting: Clock3, paused: Pause,
    ended: CircleCheck, failed: CircleX, cancelled: CircleSlash, unknown: CircleHelp }[status.kind];
  return <><span>{status.kind === "running" ? (<RunningActivityIcon />) : (<Icon size={19} aria-hidden="true" />)}</span>
    <span>{status?.kind === "running" ? (<RunningActivityIcon />) : (<Icon size={18} aria-hidden="true" />)}</span></>;
}`;
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
function parse(contents: Record<string, string>): Map<string, Parsed> {
  const directory = "/execution-status-glyph",
    config = `${directory}/tsconfig.json`;
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
    assert.deepEqual(project.program.getSyntacticDiagnostics(), []);
    const result = new Map<string, Parsed>();
    for (const name of Object.keys(contents)) {
      const source = project.program.getSourceFile(`${directory}/${name}.tsx`)!;
      const nodes: Node[] = [],
        identifiers: Identifier[] = [];
      walk(source, (node) => {
        nodes.push(node);
        if (isIdentifier(node)) identifiers.push(node);
      });
      const resolved = project.checker.getSymbolAtLocation(identifiers);
      const symbols = new Map<Node, number | undefined>();
      identifiers.forEach((node, index) =>
        symbols.set(node, resolved[index]?.id),
      );
      result.set(name, { source, nodes, symbols });
    }
    return result;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function syntax(node: Node, normalized = false): unknown {
  if (node.kind === SyntaxKind.JsxText && !node.getText().trim())
    return undefined;
  if (
    normalized &&
    isJsxSelfClosingElement(node) &&
    node.tagName.getText() === "ExecutionStatusIcon"
  )
    return "THREAD_GLYPH";
  if (
    normalized &&
    isJsxExpression(node) &&
    node.expression &&
    isConditionalExpression(node.expression) &&
    oldGlyphs.includes(JSON.stringify(syntax(node.expression)))
  )
    return "THREAD_GLYPH";
  if (
    normalized &&
    isVariableStatement(node) &&
    node.declarationList.declarations.length === 1
  ) {
    const declaration = node.declarationList.declarations[0]!;
    if (
      isIdentifier(declaration.name) &&
      declaration.name.text === "Icon" &&
      declaration.initializer
    ) {
      const entries: Node[] = [];
      walk(declaration.initializer, (child) => {
        if (isObjectLiteralExpression(child)) entries.push(child);
      });
      if (
        entries.length === 1 &&
        JSON.stringify(syntax(entries[0]!)) === oldMap
      )
        return undefined;
    }
  }
  const children: unknown[] = [];
  node.forEachChild((child) => {
    const value = syntax(child, normalized);
    if (value !== undefined) children.push(value);
  });
  return [node.kind, children.length ? children : node.getText()];
}
const templates = parse({
  Expected: expectedIcon,
  Original: originalFragments,
  SidebarCall:
    "const glyph = <ExecutionStatusIcon kind={status.kind} size={19} />;",
  SidebarDetailCall:
    "const glyph = <ExecutionStatusIcon kind={threadStatus?.kind} size={18} />;",
  SidebarDetailFacts:
    "const threadStatus = thread ? executionActivityGroupStatus(thread, activityThreads, activityAvailable && !!currentThread) : undefined;",
  DialogCall:
    "const glyph = <ExecutionStatusIcon kind={status?.kind} size={18} />;",
});
const oldGlyphs = templates
  .get("Original")!
  .nodes.filter(isConditionalExpression)
  .map((node) => JSON.stringify(syntax(node)));
const oldMap = JSON.stringify(
  syntax(templates.get("Original")!.nodes.find(isObjectLiteralExpression)!),
);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function attribute(element: Node, name: string) {
  const nodes: Node[] = [];
  walk(element, (node) => {
    nodes.push(node);
  });
  return nodes
    .filter(isJsxAttribute)
    .find((node) => node.name.getText() === name);
}
function scopes(parsed: Parsed, owner: "Sidebar" | "Dialog") {
  const component = parsed.nodes
    .filter(isFunctionDeclaration)
    .find((node) => node.name?.text === `Execution${owner}`);
  assert.ok(component, "original exported consumer exists");
  const inside: Node[] = [];
  walk(component, (node) => {
    inside.push(node);
  });
  const hooks = inside
    .filter(isCallExpression)
    .filter((node) => /^use[A-Z]/.test(node.expression.getText()));
  let scope: unknown;
  if (owner === "Sidebar") {
    const row = inside
      .filter(isVariableDeclaration)
      .find((node) => node.name.getText() === "row");
    assert.ok(row, "original row exists");
    scope = syntax(row, true);
  } else {
    const heading = inside
      .filter(isJsxElement)
      .find(
        (node) =>
          attribute(
            node.openingElement,
            "className",
          )?.initializer?.getText() === '"execution-thread-heading"',
      );
    assert.ok(heading, "original heading exists");
    let condition: Node = heading;
    while (condition.parent && !isJsxExpression(condition))
      condition = condition.parent;
    const section = condition.parent;
    assert.ok(section, "heading has original section");
    assert.ok(isJsxElement(section));
    let group: Node = section;
    while (group.parent && !isArrowFunction(group)) group = group.parent;
    const status: Node[] = [];
    walk(group, (node) => {
      if (isVariableDeclaration(node) && node.name.getText() === "status")
        status.push(node);
    });
    assert.equal(status.length, 1);
    scope = [
      syntax(status[0]!),
      syntax(section.openingElement),
      syntax(condition, true),
    ];
  }
  return {
    scope: digest(scope),
    hooks: digest(hooks.map((node) => syntax(node))),
  };
}
function imported(parsed: Parsed, path: string, name: string) {
  const matches: Identifier[] = [];
  for (const declaration of parsed.nodes.filter(isImportDeclaration)) {
    const clause = declaration.importClause;
    if (
      !isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== path ||
      clause?.phaseModifier === SyntaxKind.TypeKeyword ||
      !clause?.namedBindings ||
      !isNamedImports(clause.namedBindings)
    )
      continue;
    for (const item of clause.namedBindings.elements)
      if (!item.isTypeOnly && (item.propertyName ?? item.name).text === name)
        matches.push(item.name);
  }
  assert.equal(matches.length, 1);
  const symbol = parsed.symbols.get(matches[0]!);
  assert.notEqual(symbol, undefined);
  return symbol;
}
function inspect(sources: Sources) {
  const failures: string[] = [],
    parsed = parse(sources);
  function rule(name: string, check: () => void) {
    try {
      check();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failures.push(name);
    }
  }
  const icon = parsed.get("Icon")!;
  rule("pure-original-glyph-owner", () => {
    // Tiny module contract includes the export, readonly props, allowed imports,
    // original six constructors/unknown fallback and unchanged running branch.
    assert.deepEqual(
      syntax(icon.source),
      syntax(templates.get("Expected")!.source),
    );
  });
  rule("running-waveform-source-unchanged", () =>
    assert.equal(
      createHash("sha256").update(sources.Running).digest("hex"),
      baseline.Running,
    ),
  );
  for (const owner of ["Sidebar", "Dialog"] as const) {
    const consumer = parsed.get(owner)!;
    rule(`${owner}-actual-import-kind-size`, () => {
      const symbol = imported(
        consumer,
        "./ExecutionStatusIcon.js",
        "ExecutionStatusIcon",
      );
      const calls = consumer.nodes
        .filter(isJsxSelfClosingElement)
        .filter((node) => consumer.symbols.get(node.tagName) === symbol);
      assert.equal(calls.length, owner === "Sidebar" ? 2 : 1);
      const call = calls.find(
        (node) =>
          JSON.stringify(syntax(node.attributes)) ===
          JSON.stringify(
            syntax(
              templates
                .get(`${owner}Call`)!
                .nodes.find(isJsxSelfClosingElement)!.attributes,
            ),
          ),
      )!;
      assert.ok(
        call,
        "original list/Thread heading keeps its exact glyph facts",
      );
      assert.equal(call.tagName.getText(), "ExecutionStatusIcon");
      assert.deepEqual(
        syntax(call.attributes),
        syntax(
          templates.get(`${owner}Call`)!.nodes.find(isJsxSelfClosingElement)!
            .attributes,
        ),
      );
      assert.ok(isJsxElement(call.parent));
      assert.equal(call.parent.openingElement.tagName.getText(), "span");
      assert.equal(
        call.parent.children.filter((node) => syntax(node) !== undefined)
          .length,
        1,
      );
      if (owner === "Sidebar") {
        const detail = calls.find((node) => node !== call)!;
        assert.deepEqual(
          syntax(detail.attributes),
          syntax(
            templates
              .get("SidebarDetailCall")!
              .nodes.find(isJsxSelfClosingElement)!.attributes,
          ),
        );
        assert.ok(isJsxElement(detail.parent));
        assert.equal(
          attribute(
            detail.parent.openingElement,
            "className",
          )?.initializer?.getText(),
          '"execution-origin-status"',
        );
        assert.equal(
          attribute(
            detail.parent.openingElement,
            "data-status",
          )?.initializer?.getText(),
          '{threadStatus?.kind ?? "unknown"}',
        );
      }
    });
    if (owner === "Sidebar")
      rule("Sidebar-detail-authoritative-live-facts", () => {
        const status = consumer.nodes
          .filter(isVariableDeclaration)
          .filter((node) => node.name.getText() === "threadStatus");
        assert.equal(status.length, 1);
        assert.deepEqual(
          syntax(status[0]!),
          syntax(
            templates
              .get("SidebarDetailFacts")!
              .nodes.find(isVariableDeclaration)!,
          ),
        );
      });
    rule(`${owner}-sole-shared-glyph-consumption`, () => {
      for (const declaration of consumer.nodes.filter(isImportDeclaration)) {
        if (
          !declaration.importClause?.namedBindings ||
          !isNamedImports(declaration.importClause.namedBindings)
        )
          continue;
        for (const item of declaration.importClause.namedBindings.elements)
          assert.ok(
            ![...glyphs, "Activity", "RunningActivityIcon"].includes(
              (item.propertyName ?? item.name).text,
            ),
          );
      }
      for (const node of consumer.nodes.filter(isObjectLiteralExpression))
        assert.notEqual(JSON.stringify(syntax(node)), oldMap);
      assert.equal(
        consumer.nodes
          .filter(isJsxSelfClosingElement)
          .filter((node) => node.tagName.getText() === "ExecutionStatusIcon")
          .length,
        owner === "Sidebar" ? 2 : 1,
      );
    });
    rule(
      owner === "Sidebar"
        ? "Sidebar-original-facts-span-tree-and-lifecycle"
        : "Dialog-original-facts-span-tree",
      () => {
        const actual = scopes(consumer, owner);
        if (owner === "Sidebar") assert.deepEqual(actual, baseline.Sidebar);
        else assert.equal(actual.scope, baseline.Dialog.scope);
      },
    );
  }
  return failures;
}
const source = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), "utf8"),
  ]),
) as Sources;

test("two Thread consumers retain original glyph facts/tree and share the actual glyph owner", () => {
  assert.deepEqual(inspect(source), []);
});
test("fixed committed original Dialog retains its historical glyph facts and complete lifecycle digest", () => {
  const original = parse({ Dialog: fixed114.originalComponent.raw });
  assert.deepEqual(scopes(original.get("Dialog")!, "Dialog"), baseline.Dialog);
});
test("finite AST contract tolerates formatting, not a line-count/source-substring oracle", () => {
  const formatted = {
    ...source,
    Icon: expectedIcon,
    Sidebar: source.Sidebar.replace("size={19}", "size={ 19 }").replace(
      "const row =",
      "const   row =",
    ),
  };
  assert.deepEqual(inspect(formatted), []);
});
test("bounded counterfactuals fail their named contract without claiming arbitrary JS/UI proof", () => {
  function reject(
    file: keyof Sources,
    rule: string,
    ...changes: [string, string][]
  ) {
    for (const [before, after] of changes) {
      assert.ok(
        source[file].includes(before),
        `${file}: actual source must change`,
      );
      const candidate = {
        ...source,
        [file]: source[file].replace(before, after),
      };
      assert.ok(inspect(candidate).includes(rule), `${file}: ${rule}`);
    }
  }
  reject(
    "Icon",
    "pure-original-glyph-owner",
    ["return <RunningActivityIcon />", "return <Clock3 size={size} />"],
    [
      'return <Icon size={size} aria-hidden="true" />',
      'return <span><Icon size={size} aria-hidden="true" /></span>',
    ],
    ["waiting: Clock3", "waiting: Pause"],
    ["size: 18 | 19", "size?: number"],
    ["const Icon = {", 'fetch("/state"); const Icon = {'],
  );
  reject(
    "Sidebar",
    "Sidebar-actual-import-kind-size",
    ['from "./ExecutionStatusIcon.js"', 'from "./OtherIcon.js"'],
    [
      "const row = (t: ActivityThread) => {",
      "const row = (t: ActivityThread) => { const ExecutionStatusIcon = (_: unknown) => null;",
    ],
    ["kind={status.kind} size={19}", "kind={status.kind} size={18}"],
  );
  reject(
    "Dialog",
    "Dialog-actual-import-kind-size",
    [
      "<ExecutionStatusIcon kind={status?.kind} size={18} />",
      "<ExecutionStatusIcon kind={status?.kind} size={18} /><ExecutionStatusIcon kind={status?.kind} size={18} />",
    ],
    [
      "kind={status?.kind} size={18}",
      'kind={status?.kind ?? "unknown"} size={18}',
    ],
  );
  reject(
    "Sidebar",
    "Sidebar-original-facts-span-tree-and-lifecycle",
    ["data-status={status.kind}", ""],
    ["activityAvailable,\n    );", "true,\n    );"],
  );
  reject(
    "Dialog",
    "Dialog-original-facts-span-tree",
    ["title={status?.label}", ""],
    ["client.online && !error", "client.online"],
  );
  // Scope retirement is no longer in this glyph consumer. Its exact original
  // [observationScope] -> [] counterfactual is still executed against the real
  // Controller in execution-inspection-boundary.test.ts under the designated
  // original-scope-retirement-guard rule, not an expanded historical consumer.
  reject("Running", "running-waveform-source-unchanged", [
    'className="execution-signal-flow"',
    'className="execution-signal-base"',
  ]);
  reject("Sidebar", "Sidebar-sole-shared-glyph-consumption", [
    "  MessageSquarePlus,",
    "  MessageSquarePlus, CircleHelp,",
  ]);
  reject("Sidebar", "Sidebar-detail-authoritative-live-facts", [
    "activityAvailable && !!currentThread,\n      )",
    "true,\n      )",
  ]);
  reject("Sidebar", "Sidebar-actual-import-kind-size", [
    "kind={threadStatus?.kind} size={18}",
    'kind={"running"} size={18}',
  ]);
});
