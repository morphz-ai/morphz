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
// correctness. 14ae1de6 supplies the original Dialog heading/status; the
// user-approved cross-surface Sidebar in 9fbe5942 supplies its complete row
// and hook hashes (original/all-work state retired, exact provenance shown).
// Those 9fbe5942 hashes were checked against Git independently of this action
// alignment change; do not capture arbitrary current source to pass the gate.
// Whitespace plus only the original Icon map and inner
// glyph are normalized; other expressions retain their parentheses.
// Job controls/body, other components and CSS are deliberately outside scope.
// Dialog lifecycle moved to the actual execution-inspection owner: current
// Dialog checks only its original Thread-glyph facts/tree. The original Dialog
// lifecycle digest remains below as an immutable fixed114 historical proof.
// Sidebar's accepted complete row remains protected; the detail heading
// consumes the same glyph, with separately checked live snapshot facts.
// CI needs no Git checkout/history;
// SSR and mounted scheduling are separate tests.
const baseline = {
  Sidebar: {
    scope: "9d64370e2a6964a6bfc5f2088c958b4831844583d712355fa85d010e4aabe860",
    hooks: "5dd1b590d9bfeb4f5bc26a8f955646e62866d66ec7915c3a8ac6d6b1dea56443",
  },
  Dialog: {
    scope: "f8fd63c71a4b802477f18ab792c2cfc941dc8c03a52a750923d7bc750c0eff44",
    hooks: "1e998a4395b57e6b78a2459d27167f5c73ab0c650f689c8f8137281b794e4015",
  },
  Running: "7ef4664820d8b216d1ee724b63456459185b15eca9c741963e3f57b687e6478e",
} as const;
// Reviewed production deltas, independently traced to 009b1826 (read-only
// visibility), e2d82aa5 (actual model settings), and 856cd6c0 (one metadata row).
// Historical glyph/lifecycle proofs above remain unchanged.
const currentBaseline = {
  Sidebar: {
    scope: "0ab55533292aca4ae028e76bf1112caeca88f0c0984a308f312c5ac2cd43f6d0",
    hooks: "dab58667dc6c0edc0fda3180ce7c9857f13bd709743e64a6dae56d3f6cacf12f",
  },
  Dialog: {
    scope: "b8b8c27ce8b4d8db892e1a65d7fdc79d6d4c829c4d1eb61a01fb30c1da0fc983",
  },
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
  if (normalized && isCallExpression(node)) {
    // Only these independently checked display-read arguments changed. The
    // existing row/glyph/lifecycle digests remain immutable; arbitrary helper
    // calls, wrong Contexts and unconditional live values do not normalize.
    const reviewed = reviewedAvailabilityCalls.find(
      (value) => JSON.stringify(syntax(node)) === value.current,
    );
    if (reviewed) return syntax(reviewed.original, true);
  }
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
    "const threadStatus = thread ? executionActivityGroupStatus(thread, activityThreads, (value) => client.online && !!currentThread && executionActivityThreadAvailable(value, runtime)) : undefined;",
  SidebarDetailSummary:
    'const threadSummary = thread ? executionActivitySummary(thread, client.online && !!currentThread && executionActivityThreadAvailable(thread, runtime)) : "";',
  SidebarRowFacts: `
    const status = executionActivityGroupStatus(t, activityThreads, (value) => client.online && executionActivityThreadAvailable(value, runtime));
    const summary = executionActivitySummary(t, client.online && executionActivityThreadAvailable(t, runtime));`,
  SidebarOriginalRowFacts: `
    const status = executionActivityGroupStatus(t, activityThreads, activityAvailable);
    const summary = executionActivitySummary(t, activityAvailable);`,
  SidebarQuestionRow:
    "const preview = <UserInputPreview thread={t} onReply={onReply} disabled={!client.online || !executionActivityThreadAvailable(t, runtime)} />;",
  SidebarQuestionDetail:
    "const preview = <>{thread && (<UserInputPreview thread={thread} onReply={onReply} disabled={!client.online || !executionActivityThreadAvailable(thread, runtime)} />)}</>;",
  SidebarQuestionEntry:
    'const entry = <div key={t.id} className="execution-activity-entry" />;',
  SidebarThreadControls: [
    "const controls = <ExecutionControlActions",
    "key={`${client.boot!.csrfToken}:${JSON.stringify(scope)}`}",
    "scope={scope}",
    "thread={currentThread}",
    "disabled={!client.online || !runtime.connected || !activityAvailable || !executionActivityThreadAvailable(currentThread, runtime)}",
    "onControl={async (action) => { await client.controlExecution({ scope, action }); await client.refreshView(); }}",
    "/>;",
  ].join("\n"),
  SidebarCurrentControlState:
    "const [showOther, setShowOther] = useState(false);",
  SidebarOriginalControlState:
    "const [showOther, setShowOther] = useState(false), [stopRequested, setStopRequested] = useState(false);",
  SidebarQuestionFacts: `
    const needsInput = !!t.userInputRequest && t.lifecycle === "open" && t.controlState !== "paused" && client.online && executionActivityThreadAvailable(t, runtime);
    const threadNeedsInput = !!thread?.userInputRequest && thread.lifecycle === "open" && thread.controlState !== "paused" && client.online && !!currentThread && executionActivityThreadAvailable(thread, runtime);
    const summary = needsInput ? "等待你的输入" : executionActivitySummary(t, client.online && executionActivityThreadAvailable(t, runtime));`,
  // User-approved 5ddfb935/aae741c7 visibility-only motion. Exclude only these
  // exact calls AND their original local bindings from the old lifecycle
  // digest. Keep every historical digest unchanged; inspect the React owner
  // and exact cardinality separately below. No timer, request or control write.
  SidebarMotion: `
    const summaryRef = useRef<HTMLParagraphElement>(null);
    const [summaryVisible, setSummaryVisible] = useState(true);
    useEffect(() => {
      const node = summaryRef.current;
      if (!node || threadStatus?.kind !== "running") return;
      let intersecting = true;
      const sync = () =>
        setSummaryVisible(intersecting && document.visibilityState !== "hidden");
      const observer = new IntersectionObserver(([entry]) => {
        intersecting = !!entry?.isIntersecting;
        sync();
      });
      observer.observe(node);
      document.addEventListener("visibilitychange", sync);
      sync();
      return () => {
        observer.disconnect();
        document.removeEventListener("visibilitychange", sync);
      };
    }, [threadStatus?.kind, threadSummary]);`,
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
const reviewedAvailabilityCalls = ["status", "summary"].map((name) => {
  const initializer = (template: string) => {
    const declaration = templates
      .get(template)!
      .nodes.filter(isVariableDeclaration)
      .find((node) => node.name.getText() === name);
    assert.ok(declaration?.initializer);
    return declaration.initializer;
  };
  return {
    current: JSON.stringify(syntax(initializer("SidebarRowFacts"))),
    original: initializer("SidebarOriginalRowFacts"),
  };
});
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
const reviewedMotionCalls = templates
  .get("SidebarMotion")!
  .nodes.filter(isCallExpression)
  .filter((node) => /^use[A-Z]/.test(node.expression.getText()));
function visibilityHookShape(node: Node) {
  return [
    syntax(node),
    isVariableDeclaration(node.parent) ? syntax(node.parent.name) : undefined,
  ];
}
function reviewedVisibilityHook(node: Node) {
  return reviewedMotionCalls.some(
    (expected) =>
      JSON.stringify(visibilityHookShape(node)) ===
      JSON.stringify(visibilityHookShape(expected)),
  );
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
    .filter((node) => /^use[A-Z]/.test(node.expression.getText()))
    .filter((node) => owner !== "Sidebar" || !reviewedVisibilityHook(node));
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

/** Verify the one question supplement seam, then restore the exact
 * former row for the immutable glyph/freshness/lifecycle checks. This does not
 * capture a new current hash or erase arbitrary JSX, callbacks or reads. */
function withoutReviewedQuestions(parsed: Parsed): string {
  const previewOwner = imported(
    parsed,
    "./UserInputPreview.js",
    "UserInputPreview",
  );
  const availabilityOwner = imported(
    parsed,
    "./execution-activity.js",
    "executionActivityThreadAvailable",
  );
  const previews = parsed.nodes
    .filter(isJsxSelfClosingElement)
    .filter((node) => node.tagName.getText() === "UserInputPreview");
  assert.equal(
    previews.length,
    1,
    "the detail reuses its existing supplement action, never a second answer button",
  );
  const reviewed = ["SidebarQuestionRow"].map((name) =>
    templates.get(name)!.nodes.find(isJsxSelfClosingElement)!,
  );
  const row = previews.find(
    (node) =>
      JSON.stringify(syntax(node.attributes)) ===
      JSON.stringify(syntax(reviewed[0]!.attributes)),
  );
  assert.ok(row, "the exact question owner and disabled guards are required");
  for (const preview of previews) {
    assert.equal(parsed.symbols.get(preview.tagName), previewOwner);
    const calls: Node[] = [];
    walk(preview, (node) => {
      if (isCallExpression(node)) calls.push(node);
    });
    assert.equal(calls.length, 1);
    assert.ok(isCallExpression(calls[0]!));
    assert.equal(parsed.symbols.get(calls[0].expression), availabilityOwner);
  }
  assert.ok(isJsxElement(row.parent));
  const wrapper = row.parent;
  const expectedWrapper = templates
    .get("SidebarQuestionEntry")!
    .nodes.find(isJsxSelfClosingElement)!;
  assert.equal(wrapper.openingElement.tagName.getText(), "div");
  assert.deepEqual(
    syntax(wrapper.openingElement.attributes),
    syntax(expectedWrapper.attributes),
  );
  const children = wrapper.children.filter(
    (node) => syntax(node) !== undefined,
  );
  assert.equal(children.length, 2);
  const button = children[0];
  assert.ok(button && isJsxElement(button));
  assert.equal(button.openingElement.tagName.getText(), "button");
  assert.equal(children[1], row);
  assert.equal(
    button.openingElement.attributes.properties.some(
      (node) => isJsxAttribute(node) && node.name.getText() === "key",
    ),
    false,
  );
  const className = attribute(button.openingElement, "className")!;
  assert.equal(className.initializer?.getText(), '"execution-activity-row"');
  const key = attribute(wrapper.openingElement, "key")!;
  const restoredButton = button
    .getText()
    .replace(className.getText(), `${className.getText()} ${key.getText()}`)
    // Undo just the one new wrapper's indentation. JSX text keeps trailing
    // indentation in this finite serializer, although React renders it alike.
    .replace(/^ {2}/gm, "");
  let source = parsed.source.getText();
  for (const [before, after] of [[wrapper.getText(), restoredButton]]) {
    assert.equal(
      source.split(before!).length,
      2,
      "reviewed source span must be unique",
    );
    source = source.replace(before!, after!);
  }
  // The approved question state changed only these exact read-only seams.
  // Verify every guard before restoring the original glyph/tree baseline;
  // never accept a new digest of arbitrary current production source.
  const facts = templates.get("SidebarQuestionFacts")!;
  for (const name of ["needsInput", "threadNeedsInput", "summary"]) {
    const actual = parsed.nodes
      .filter(isVariableDeclaration)
      .filter((node) => node.name.getText() === name);
    const expected = facts.nodes
      .filter(isVariableDeclaration)
      .find((node) => node.name.getText() === name)!;
    assert.equal(actual.length, 1);
    assert.deepEqual(syntax(actual[0]!), syntax(expected));
    const declaration = actual[0]!;
    const before =
      name === "summary"
        ? declaration.initializer!.getText()
        : declaration.parent.parent.getText();
    const after =
      name === "summary"
        ? templates
            .get("SidebarRowFacts")!
            .nodes.filter(isVariableDeclaration)
            .find((node) => node.name.getText() === name)!
            .initializer!.getText()
        : "";
    assert.equal(source.split(before).length, 2);
    source = source.replace(before, after);
  }
  for (const [before, after, count] of [
    ['needsInput ? "等待你的输入" : status.label', "status.label", 2],
    ['needsInput ? "" : summary', "summary", 1],
    ["data-user-input={needsInput || undefined}", "", 1],
  ] as const) {
    assert.equal(source.split(before).length - 1, count);
    source = source.replaceAll(before, after);
  }
  return source;
}
/** The new action owner replaces the old stop-only local state. Check its
 * complete, fixed seam before restoring just that moved state for the old
 * glyph/lifecycle digest. Do not update historical hashes or normalize any
 * other read, callback, hook or row. The shared owner has mounted control and
 * authority tests; this finite check protects the unchanged glyph consumer. */
function withoutReviewedThreadControls(parsed: Parsed): string {
  const owner = imported(
    parsed,
    "./features/execution/ExecutionControlActions.js",
    "ExecutionControlActions",
  );
  const controls = parsed.nodes
    .filter(isJsxSelfClosingElement)
    .filter((node) => node.tagName.getText() === "ExecutionControlActions");
  assert.equal(controls.length, 1);
  const control = controls[0]!;
  assert.equal(parsed.symbols.get(control.tagName), owner);
  assert.deepEqual(
    syntax(control),
    syntax(
      templates
        .get("SidebarThreadControls")!
        .nodes.find(isJsxSelfClosingElement)!,
    ),
  );
  const state = parsed.nodes
    .filter(isVariableStatement)
    .filter((node) =>
      node.declarationList.declarations.some((declaration) =>
        declaration.name.getText().includes("showOther"),
      ),
    );
  assert.equal(state.length, 1);
  assert.deepEqual(
    syntax(state[0]!),
    syntax(
      templates
        .get("SidebarCurrentControlState")!
        .nodes.find(isVariableStatement)!,
    ),
  );
  assert.equal(
    parsed.nodes
      .filter(isIdentifier)
      .some((node) =>
        ["stopRequested", "setStopRequested"].includes(node.text),
      ),
    false,
  );
  return parsed.source
    .getText()
    .replace(control.getText(), "null")
    .replace(
      state[0]!.getText(),
      templates.get("SidebarOriginalControlState")!.source.getText(),
    );
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
  rule("Sidebar-exact-shared-thread-control-seam", () => {
    parsed.set(
      "Sidebar",
      parse({
        Sidebar: withoutReviewedThreadControls(parsed.get("Sidebar")!),
      }).get("Sidebar")!,
    );
  });
  rule("Sidebar-exact-independent-question-previews", () => {
    parsed.set(
      "Sidebar",
      parse({ Sidebar: withoutReviewedQuestions(parsed.get("Sidebar")!) }).get(
        "Sidebar",
      )!,
    );
  });
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
    if (owner === "Sidebar")
      rule("Sidebar-exact-read-only-motion-visibility", () => {
        const hooks = consumer.nodes
          .filter(isCallExpression)
          .filter(reviewedVisibilityHook);
        assert.equal(hooks.length, 3);
        assert.deepEqual(
          hooks.map(visibilityHookShape),
          reviewedMotionCalls.map(visibilityHookShape),
        );
        for (const hook of hooks) {
          assert.ok(isIdentifier(hook.expression));
          assert.equal(
            consumer.symbols.get(hook.expression),
            imported(consumer, "react", hook.expression.text),
          );
        }
      });
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
      rule("Sidebar-per-Context-authorized-read-freshness", () => {
        const helper = imported(
          consumer,
          "./execution-activity.js",
          "executionActivityThreadAvailable",
        );
        const calls = consumer.nodes
          .filter(isCallExpression)
          .filter((node) => consumer.symbols.get(node.expression) === helper);
        assert.equal(
          calls.length,
          4,
          "all four real Sidebar display reads use the exact imported helper",
        );
        const declarations = [
          ["threadSummary", "SidebarDetailSummary"],
          ["threadStatus", "SidebarDetailFacts"],
          ["status", "SidebarRowFacts"],
          ["summary", "SidebarRowFacts"],
        ];
        for (const [name, template] of declarations) {
          const actual = consumer.nodes
            .filter(isVariableDeclaration)
            .filter((node) => node.name.getText() === name);
          const expected = templates
            .get(template!)!
            .nodes.filter(isVariableDeclaration)
            .find((node) => node.name.getText() === name);
          assert.equal(actual.length, 1);
          assert.ok(expected);
          assert.deepEqual(syntax(actual[0]!), syntax(expected));
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
        if (owner === "Sidebar")
          assert.deepEqual(actual, currentBaseline.Sidebar);
        else assert.equal(actual.scope, currentBaseline.Dialog.scope);
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

test("two Thread consumers retain accepted glyph facts/tree and share the actual glyph owner", () => {
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
test("new Thread controls retain exact source, revision owner, freshness and accepted refresh seam", () => {
  const control = parse({ Sidebar: source.Sidebar })
    .get("Sidebar")!
    .nodes.filter(isJsxSelfClosingElement)
    .find((node) => node.tagName.getText() === "ExecutionControlActions")!;
  assert.ok(control);
  for (const [before, after] of [
    ["scope={scope}", "scope={{ ...scope, threadId: 'other' }}"],
    ["thread={currentThread}", "thread={thread}"],
    ["!activityAvailable", "false"],
    ["!runtime.connected", "false"],
    [
      "await client.controlExecution({ scope, action });",
      "void client.controlExecution({ scope, action });",
    ],
    ["await client.refreshView();", "onRefresh?.();"],
  ]) {
    assert.equal(control.getText().split(before!).length, 2);
    const variant = source.Sidebar.replace(
      control.getText(),
      control.getText().replace(before!, after!),
    );
    assert.ok(
      inspect({ ...source, Sidebar: variant }).includes(
        "Sidebar-exact-shared-thread-control-seam",
      ),
    );
  }
});
test("question previews have exact independent owner, target, callback and freshness seams", () => {
  const preview = parse({ Sidebar: source.Sidebar })
    .get("Sidebar")!
    .nodes.filter(isJsxSelfClosingElement)
    .find((node) => node.tagName.getText() === "UserInputPreview")!;
  assert.ok(preview);
  for (const [before, after] of [
    ["!!t.userInputRequest &&", "true &&"],
    ['t.lifecycle === "open" &&', "true &&"],
    ['t.controlState !== "paused" &&', "true &&"],
    ["!!thread?.userInputRequest &&", "true &&"],
    ["data-user-input={needsInput || undefined}", "data-user-input={true}"],
    ['from "./UserInputPreview.js"', 'from "./UntrustedQuestion.js"'],
    [
      preview.getText(),
      preview.getText().replace("thread={t}", "thread={thread}"),
    ],
    [
      preview.getText(),
      preview
        .getText()
        .replace("onReply={onReply}", "onReply={() => onReply?.(thread!)}"),
    ],
    [
      preview.getText(),
      preview
        .getText()
        .replace("!executionActivityThreadAvailable(t, runtime)", "false"),
    ],
    [
      'className="execution-activity-entry"',
      'className="execution-activity-entry" onClick={() => onClose()}',
    ],
  ]) {
    assert.notEqual(before, after);
    assert.ok(
      inspect({
        ...source,
        Sidebar: source.Sidebar.replace(before!, after!),
      }).includes("Sidebar-exact-independent-question-previews"),
    );
  }
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
        `${file}: actual source must change at ${JSON.stringify(before).slice(0, 120)}`,
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
    ["executionActivityThreadAvailable(t, runtime)", "true"],
    [
      "  const [refreshing, setRefreshing] = useState(false);",
      "  const [refreshing, setRefreshing] = useState(false); const [allWork, setAllWork] = useState(false);",
    ],
    [
      "  const [refreshing, setRefreshing] = useState(false);",
      "  const [refreshing, setRefreshing] = useState(false); const [otherVisibility, setOtherVisibility] = useState(true);",
    ],
    ["          origin,\n", ""],
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
  const lucideImport = parse({ Sidebar: source.Sidebar })
    .get("Sidebar")!
    .nodes.filter(isImportDeclaration)
    .find(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "lucide-react",
    );
  assert.ok(lucideImport);
  reject("Sidebar", "Sidebar-sole-shared-glyph-consumption", [
    lucideImport.getText(),
    `import { CircleHelp } from "lucide-react";\n${lucideImport.getText()}`,
  ]);
  const detailStatus = parse({ Sidebar: source.Sidebar })
    .get("Sidebar")!
    .nodes.filter(isVariableDeclaration)
    .find((node) => node.name.getText() === "threadStatus");
  assert.ok(
    detailStatus?.initializer &&
      isConditionalExpression(detailStatus.initializer),
  );
  const detailCall = detailStatus.initializer.whenTrue;
  assert.ok(isCallExpression(detailCall));
  const callback = detailCall.arguments[2];
  assert.ok(callback && isArrowFunction(callback));
  const detailAvailability = callback.body.getText();
  reject("Sidebar", "Sidebar-detail-authoritative-live-facts", [
    detailAvailability,
    "true",
  ]);
  reject(
    "Sidebar",
    "Sidebar-per-Context-authorized-read-freshness",
    [
      detailAvailability,
      detailAvailability.replace(
        "executionActivityThreadAvailable(value, runtime)",
        "executionActivityThreadAvailable(thread, runtime)",
      ),
    ],
    [
      detailAvailability,
      detailAvailability.replace(/^client.online\s*&&\s*/, ""),
    ],
    [
      "client.online && executionActivityThreadAvailable(t, runtime)",
      "executionActivityThreadAvailable(t, runtime)",
    ],
    [
      "executionActivityThreadAvailable(t, runtime)",
      "executionActivityThreadAvailable(t, { ...runtime, activity: { ...runtime.activity, available: true } })",
    ],
    [
      "executionActivityThreadAvailable(thread, runtime)",
      "executionActivityThreadAvailable({ ...thread, contextId: 'wrong-context' }, runtime)",
    ],
    [
      "executionActivityThreadAvailable,",
      "executionActivityThreadAvailableFake as executionActivityThreadAvailable,",
    ],
    ['from "./execution-activity.js"', 'from "./untrusted-activity.js"'],
  );
  reject("Sidebar", "Sidebar-actual-import-kind-size", [
    "kind={threadStatus?.kind} size={18}",
    'kind={"running"} size={18}',
  ]);
  reject(
    "Sidebar",
    "Sidebar-exact-read-only-motion-visibility",
    [
      'setSummaryVisible(intersecting && document.visibilityState !== "hidden")',
      'client.cancelInput("TEST-forbidden-motion-control")',
    ],
    [
      'document.removeEventListener("visibilitychange", sync)',
      'document.addEventListener("visibilitychange", sync)',
    ],
    ["const summaryRef =", "const unrelatedRef ="],
    [
      "const summaryRef = useRef<HTMLParagraphElement>(null);",
      "const summaryRef = useRef<HTMLParagraphElement>(null); { const summaryRef = useRef<HTMLParagraphElement>(null); }",
    ],
    ["observer.disconnect()", "observer.observe(node)"],
  );
});
