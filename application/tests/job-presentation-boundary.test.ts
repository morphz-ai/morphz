import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isNamedImports,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { jobPresentationOriginal as fixed } from "./fixtures/job-presentation-08215636.js";

// Finite Job presentation ownership, not a whole renderer/App migration hash.
// Historical complete-file provenance belongs to the independent actual-Git
// proof. CI permits unrelated TSX, CSS, comments and pure/type imports. Behavior
// and actual renderer mounting are independently exercised in separate tests.
const paths = {
  Owner: "../apps/web/src/execution-presentation.ts",
  Conversation: "../apps/web/src/Conversation.tsx",
  Dialog: "../apps/web/src/ExecutionDialog.tsx",
  Core: "../packages/core/src/execution.ts",
} as const;
type Sources = Record<keyof typeof paths, string>;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  symbols: Map<Node, number | undefined>;
};
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const legacyNames = [
  "executionJobsInReadingOrder",
  "executionJobPresentation",
  "executionPresentation",
  "executionResultSummary",
  "record",
  "text",
  "short",
] as const;
const liveExpected = `export function liveToolPresentation(
  tool: NonNullable<LiveMessage["tool"]>, state: Workspace,
): Readonly<{title: string; detail: string | undefined; statusLabel: string}> {
  ${fixed.spans.livePresentationDeclaration.raw}
  ${fixed.spans.liveParse.raw}
  ${fixed.spans.liveStatus.raw}
  return {title: ${fixed.spans.liveTitle.raw}, detail: ${fixed.spans.liveTooltip.raw}, statusLabel: status};
}`;
const snapshotExpected = `export function executionSnapshotJobPresentation(
  job: ExecutionSnapshot["jobs"][number], state: Workspace,
): Readonly<{title: string; detail: string; result: string | null; statusLabel: string}> {
  const presentation = executionJobPresentation(job, state);
  return {...presentation, statusLabel: ${fixed.spans.snapshotStatus.raw}};
}`;
const templates = parse({
  Legacy: legacyNames.map((name) => fixed.spans[name].raw).join("\n"),
  Live: liveExpected,
  Snapshot: snapshotExpected,
  Core: fixed.spans.snapshotLabelTable.raw,
  OriginalTool: fixed.spans.ToolMessage.raw,
  LiveCall: "const presentation = liveToolPresentation(tool, state);",
  SnapshotCall:
    "const presentation = executionSnapshotJobPresentation(job, client.boot!.workspace);",
  LiveName:
    '<span className="tool-name" title={presentation.detail}>{presentation.title}{presentation.detail ? ` · ${presentation.detail}` : ""}</span>;',
  LiveState: '<span className="tool-state">{presentation.statusLabel}</span>;',
  SnapshotStatus:
    "<span className={`job-status ${job.status}`}>{presentation.statusLabel}</span>;",
  SnapshotTitle:
    "<strong title={presentation.title}>{presentation.title}</strong>;",
  SnapshotDetail: '<p className="execution-object">{presentation.detail}</p>;',
});
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
function inside(node: Node) {
  const nodes: Node[] = [];
  walk(node, (child) => {
    nodes.push(child);
  });
  return nodes;
}
function parse(contents: Record<string, string>) {
  const directory = "/job-presentation-boundary",
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
      "legal parsed counterfactual/source",
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
      result.set(key, { source, nodes, symbols });
    }
    return result;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function shape(node: Node): unknown {
  if (node.kind === SyntaxKind.JsxText && !node.getText().trim())
    return undefined;
  const children: unknown[] = [];
  node.forEachChild((child) => {
    const value = shape(child);
    if (value !== undefined) children.push(value);
  });
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
      : isStringLiteral(node)
        ? node.text
        : node.getText(),
  ];
}
function same(actual: Node, expected: Node, rule: string) {
  assert.deepEqual(shape(actual), shape(expected), rule);
}
function fn(parsed: Parsed, name: string): FunctionDeclaration {
  const matches = parsed.source.statements
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(matches.length, 1, `complete-original-declaration:${name}`);
  const node = matches[0]!;
  assert.ok(node.body, `complete-original-declaration:${name}`);
  return node;
}
function declaration(parsed: Parsed, name: string) {
  const nodes = parsed.source.statements
    .filter(isVariableStatement)
    .filter((node) =>
      node.declarationList.declarations.some(
        (decl) => isIdentifier(decl.name) && decl.name.text === name,
      ),
    );
  assert.equal(nodes.length, 1, `complete-original-declaration:${name}`);
  return nodes[0]!;
}
function variable(node: Node, name: string) {
  const matches = inside(node)
    .filter(isVariableDeclaration)
    .filter((decl) => isIdentifier(decl.name) && decl.name.text === name);
  assert.equal(matches.length, 1, `direct-captured-presentation:${name}`);
  return matches[0]!;
}
function returned(node: FunctionDeclaration) {
  const returns = node.body!.statements.filter(isReturnStatement);
  assert.equal(returns.length, 1, "pure-presentation-return");
  assert.ok(
    returns[0]!.expression && isObjectLiteralExpression(returns[0]!.expression),
    "pure-presentation-return",
  );
  return returns[0]!.expression;
}
function field(node: Node, name: string) {
  assert.ok(isObjectLiteralExpression(node), `presentation-field:${name}`);
  const matches = node.properties
    .filter(isPropertyAssignment)
    .filter((property) => property.name.getText() === name);
  assert.equal(matches.length, 1, `presentation-field:${name}`);
  return matches[0]!.initializer;
}
function table(node: Node) {
  const object = inside(node).find(isObjectLiteralExpression);
  assert.ok(object, "live-status-vocabulary");
  return object.properties.map((property) => {
    assert.ok(
      isPropertyAssignment(property) && isStringLiteral(property.initializer),
      "live-status-vocabulary",
    );
    return [property.name.getText(), property.initializer.text];
  });
}
function runtimeImport(parsed: Parsed, exported: string) {
  const matches = parsed.source.statements
    .filter(isImportDeclaration)
    .flatMap((node) => {
      if (
        !isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== "./execution-presentation.js"
      )
        return [];
      const clause = node.importClause;
      if (
        !clause ||
        clause.phaseModifier === SyntaxKind.TypeKeyword ||
        !clause.namedBindings ||
        !isNamedImports(clause.namedBindings)
      )
        return [];
      return clause.namedBindings.elements
        .filter(
          (entry) =>
            !entry.isTypeOnly &&
            (entry.propertyName ?? entry.name).text === exported,
        )
        .map((entry) => entry.name);
    });
  assert.equal(matches.length, 1, `actual-presentation-import:${exported}`);
  return matches[0]!;
}
function directCall(
  parsed: Parsed,
  declaration: Node,
  binding: Identifier,
  expectedKey: "LiveCall" | "SnapshotCall",
  rule: string,
) {
  assert.ok(
    isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isCallExpression(declaration.initializer),
    rule,
  );
  const call = declaration.initializer;
  assert.ok(
    isIdentifier(call.expression) && call.expression.text === binding.text,
    rule,
  );
  assert.ok(
    parsed.symbols.get(binding) !== undefined &&
      parsed.symbols.get(call.expression) === parsed.symbols.get(binding),
    rule,
  );
  const expected = templates.get(expectedKey)!.nodes.find(isCallExpression)!;
  assert.deepEqual(
    call.arguments.map(shape),
    expected.arguments.map(shape),
    `${rule}:captured-arguments`,
  );
}
function jsxClass(node: Node, classText: string) {
  const matches = inside(node)
    .filter(isJsxElement)
    .filter((element) =>
      element.openingElement.attributes.properties.some(
        (attr) =>
          isJsxAttribute(attr) &&
          attr.name.getText() === "className" &&
          attr.initializer &&
          isStringLiteral(attr.initializer) &&
          attr.initializer.text === classText,
      ),
    );
  assert.equal(matches.length, 1, `finite-job-jsx:${classText}`);
  return matches[0]!;
}
function attribute(element: Node, name: string) {
  assert.ok(isJsxElement(element), `finite-job-attribute:${name}`);
  const matches = element.openingElement.attributes.properties
    .filter(isJsxAttribute)
    .filter((attr) => attr.name.getText() === name);
  assert.equal(matches.length, 1, `finite-job-attribute:${name}`);
  return matches[0]!;
}
function requireTypeImport(parsed: Parsed, name: string, module: string) {
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
      return clause.namedBindings.elements.filter(
        (entry) =>
          (entry.propertyName ?? entry.name).text === name &&
          entry.name.text === name &&
          (clause.phaseModifier === SyntaxKind.TypeKeyword || entry.isTypeOnly),
      );
    });
  assert.equal(matches.length, 1, `type-only-presentation-input:${name}`);
  return matches[0]!.name;
}
function pureDependencies(parsed: Parsed) {
  // New projection methods have complete bounded bodies below. Runtime imports
  // remain the existing pure core leaf families; extra type imports are legal.
  const pureLeaves = [
    "application-names",
    "execution",
    "script-studio",
    "model",
  ];
  for (const node of parsed.source.statements.filter(isImportDeclaration)) {
    const clause = node.importClause;
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
      isStringLiteral(node.moduleSpecifier) &&
        pureLeaves.some(
          (leaf) =>
            isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text ===
              `../../../packages/core/src/${leaf}.js`,
        ),
      "pure-owner-dependencies",
    );
    assert.ok(clause && !clause.name && entries, "pure-owner-dependencies");
  }
  for (const node of parsed.nodes.filter(isCallExpression)) {
    const callee = node.expression.getText();
    assert.ok(
      !/^(?:fetch|require|use\w+|setTimeout|setInterval|requestAnimationFrame|queueMicrotask)$/.test(
        callee,
      ) &&
        !/^(?:client|window|document|localStorage|sessionStorage|process)\./.test(
          callee,
        ) &&
        !["Date.now", "Math.random"].includes(callee),
      "pure-owner-dependencies",
    );
    assert.notEqual(
      node.expression.kind,
      SyntaxKind.ImportKeyword,
      "pure-owner-dependencies",
    );
  }
}
function validate(contents: Sources) {
  const parsed = parse(contents),
    owner = parsed.get("Owner")!,
    core = parsed.get("Core")!;
  pureDependencies(owner);
  for (const [name, module] of [
    ["Workspace", "model"],
    ["LiveMessage", "live-conversation"],
    ["ExecutionSnapshot", "execution"],
  ]) {
    const binding = requireTypeImport(
      owner,
      name!,
      `../../../packages/core/src/${module}.js`,
    );
    const signatures = [
      fn(owner, "liveToolPresentation"),
      fn(owner, "executionSnapshotJobPresentation"),
    ].flatMap((node) => node.parameters.flatMap(inside));
    const uses = signatures
      .filter(isIdentifier)
      .filter((node) => node.text === name);
    assert.ok(
      uses.length &&
        uses.every(
          (node) => owner.symbols.get(node) === owner.symbols.get(binding),
        ),
      `type-only-presentation-input:${name}`,
    );
  }
  same(
    declaration(core, "jobStatusLabel"),
    declaration(templates.get("Core")!, "jobStatusLabel"),
    "snapshot-status-vocabulary",
  );
  const receipt = field(
    returned(fn(owner, "executionJobPresentation")),
    "result",
  );
  same(
    receipt,
    field(
      returned(fn(templates.get("Legacy")!, "executionJobPresentation")),
      "result",
    ),
    "typed-job-result-receipt",
  );
  for (const name of legacyNames) {
    const actual =
      name === "record" || name === "text" || name === "short"
        ? declaration(owner, name)
        : fn(owner, name);
    const expected =
      name === "record" || name === "text" || name === "short"
        ? declaration(templates.get("Legacy")!, name)
        : fn(templates.get("Legacy")!, name);
    same(actual, expected, `original-presentation-algorithm:${name}`);
  }
  const live = fn(owner, "liveToolPresentation"),
    expectedLive = fn(templates.get("Live")!, "liveToolPresentation");
  const status = variable(live, "status");
  assert.ok(status.initializer, "live-status-vocabulary");
  assert.deepEqual(
    table(status.initializer),
    fixed.tables.live.map((entry) => [...entry]),
    "live-status-vocabulary",
  );
  same(status, variable(expectedLive, "status"), "live-status-fallback");
  const tries = live.body!.statements.filter(
    (node) => node.kind === SyntaxKind.TryStatement,
  );
  assert.equal(tries.length, 1, "live-json-catch-boundary");
  same(
    tries[0]!,
    expectedLive.body!.statements[1]!,
    "live-json-catch-boundary",
  );
  same(live, expectedLive, "complete-live-presentation-algorithm");
  const snapshot = fn(owner, "executionSnapshotJobPresentation"),
    expectedSnapshot = fn(
      templates.get("Snapshot")!,
      "executionSnapshotJobPresentation",
    );
  same(
    field(returned(snapshot), "statusLabel"),
    field(returned(expectedSnapshot), "statusLabel"),
    "snapshot-stop-priority",
  );
  same(snapshot, expectedSnapshot, "complete-snapshot-presentation-algorithm");
  const coreStatus = owner.source.statements
    .filter(isImportDeclaration)
    .flatMap((node) => {
      if (
        !isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== "../../../packages/core/src/execution.js"
      )
        return [];
      const clause = node.importClause;
      return clause?.phaseModifier !== SyntaxKind.TypeKeyword &&
        clause?.namedBindings &&
        isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.filter(
            (entry) =>
              !entry.isTypeOnly &&
              (entry.propertyName ?? entry.name).text === "jobStatusLabel",
          )
        : [];
    });
  assert.equal(coreStatus.length, 1, "actual-snapshot-label-import");
  const snapshotStatusUse = inside(snapshot)
    .filter(isIdentifier)
    .find((node) => node.text === "jobStatusLabel");
  assert.ok(
    snapshotStatusUse &&
      owner.symbols.get(snapshotStatusUse) ===
        owner.symbols.get(coreStatus[0]!.name),
    "actual-snapshot-label-import",
  );
  const conversation = parsed.get("Conversation")!,
    toolMessage = fn(conversation, "ToolMessage");
  assert.deepEqual(
    toolMessage.parameters.map(shape),
    fn(templates.get("OriginalTool")!, "ToolMessage").parameters.map(shape),
    "live-original-render-inputs",
  );
  const tool = variable(toolMessage, "tool");
  same(
    tool.parent.parent,
    fn(templates.get("OriginalTool")!, "ToolMessage").body!.statements[0]!,
    "live-original-tool-capture",
  );
  const liveDeclaration = variable(toolMessage, "presentation"),
    liveImport = runtimeImport(conversation, "liveToolPresentation");
  directCall(
    conversation,
    liveDeclaration,
    liveImport,
    "LiveCall",
    "actual-live-direct-consumer",
  );
  assert.ok(
    tool.getStart() < liveDeclaration.getStart() &&
      liveDeclaration.parent.parent.parent === toolMessage.body,
    "live-original-capture-order",
  );
  same(
    jsxClass(toolMessage, "tool-name"),
    templates.get("LiveName")!.nodes.find(isJsxElement)!,
    "live-rendered-title-detail",
  );
  same(
    jsxClass(toolMessage, "tool-state"),
    templates.get("LiveState")!.nodes.find(isJsxElement)!,
    "live-rendered-status",
  );
  const oldTool = fn(templates.get("OriginalTool")!, "ToolMessage");
  same(
    attribute(jsxClass(toolMessage, "message-tool"), "data-tool-status"),
    attribute(jsxClass(oldTool, "message-tool"), "data-tool-status"),
    "live-raw-status-identity",
  );
  same(
    jsxClass(toolMessage, "tool-details"),
    jsxClass(oldTool, "tool-details"),
    "live-raw-technical-details",
  );
  const dialog = parsed.get("Dialog")!,
    component = fn(dialog, "ExecutionDialog"),
    snapshotImport = runtimeImport(dialog, "executionSnapshotJobPresentation");
  const rowCandidates = inside(component)
    .filter(isArrowFunction)
    .filter(
      (node) =>
        node.parameters.length === 1 &&
        node.parameters[0]!.name.getText() === "job" &&
        inside(node).some(
          (child) =>
            isVariableDeclaration(child) &&
            child.name.getText() === "presentation",
        ),
    );
  assert.equal(rowCandidates.length, 1, "actual-snapshot-row-consumer");
  const row = rowCandidates[0]!,
    snapshotDeclaration = variable(row, "presentation");
  directCall(
    dialog,
    snapshotDeclaration,
    snapshotImport,
    "SnapshotCall",
    "actual-snapshot-direct-consumer",
  );
  assert.ok(
    row.parent &&
      isCallExpression(row.parent) &&
      row.parent.expression.getText() === "group.jobs.map",
    "actual-snapshot-row-consumer",
  );
  const section = jsxClass(row, "execution-job");
  for (const name of ["key", "data-job-id"]) {
    const attr = attribute(section, name);
    assert.ok(
      attr.initializer &&
        isJsxExpression(attr.initializer) &&
        attr.initializer.expression?.getText() === "job.id",
      "snapshot-job-identity",
    );
  }
  const statuses = inside(section)
    .filter(isJsxElement)
    .filter(
      (node) =>
        attributeOptional(node, "className")?.initializer?.getText() ===
        "{`job-status ${job.status}`}",
    );
  assert.equal(statuses.length, 1, "snapshot-raw-status-class");
  same(
    statuses[0]!,
    templates.get("SnapshotStatus")!.nodes.find(isJsxElement)!,
    "snapshot-rendered-status",
  );
  const titles = inside(section)
    .filter(isJsxElement)
    .filter(
      (node) =>
        node.openingElement.tagName.getText() === "strong" &&
        attributeOptional(node, "title")?.initializer?.getText() ===
          "{presentation.title}",
    );
  assert.equal(titles.length, 1, "snapshot-rendered-title");
  same(
    titles[0]!,
    templates.get("SnapshotTitle")!.nodes.find(isJsxElement)!,
    "snapshot-rendered-title",
  );
  same(
    jsxClass(row, "execution-object"),
    templates.get("SnapshotDetail")!.nodes.find(isJsxElement)!,
    "snapshot-rendered-detail",
  );
  const results = jsxClass(row, "execution-step-result");
  let resultGuard = results.parent;
  while (resultGuard.kind === SyntaxKind.ParenthesizedExpression)
    resultGuard = resultGuard.parent;
  assert.ok(
    isBinaryExpression(resultGuard) &&
      resultGuard.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken &&
      resultGuard.left.getText() === "presentation.result",
    "snapshot-result-prose-binding",
  );
  assert.equal(
    attribute(results, "aria-label").initializer?.getText(),
    '"返回结果解读"',
    "snapshot-result-prose-binding",
  );
  assert.equal(
    attribute(results, "title").initializer?.getText(),
    "{presentation.result}",
    "snapshot-result-prose-binding",
  );
  assert.deepEqual(
    results.children
      .filter(isJsxExpression)
      .map((node) => node.expression?.getText()),
    ["presentation.result"],
    "snapshot-result-prose-binding",
  );
}
function attributeOptional(element: Node, name: string) {
  return isJsxElement(element)
    ? element.openingElement.attributes.properties
        .filter(isJsxAttribute)
        .find((attr) => attr.name.getText() === name)
    : undefined;
}
function replaceOnce(value: string, before: string, after: string) {
  assert.equal(
    value.split(before).length,
    2,
    `unique mutation target: ${before}`,
  );
  return value.replace(before, after);
}
function changed(key: keyof Sources, before: string, after: string): Sources {
  return { ...sources, [key]: replaceOnce(sources[key], before, after) };
}
function reject(contents: Sources, rule: string) {
  parse(contents); // A parse failure never qualifies as the designated rejection.
  assert.throws(
    () => validate(contents),
    (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes(rule),
  );
}
test("fixed finite Job algorithms/vocabularies are internally intact, without current whole-file locks", () => {
  for (const span of Object.values(fixed.spans)) {
    assert.equal(
      createHash("sha256").update(span.raw).digest("hex"),
      span.sha256,
    );
    assert.equal(Buffer.byteLength(span.raw), span.bytes);
  }
  assert.equal(fixed.git, "0821563681516b78f63e2d79d1fc79bb782bb07d");
  assert.equal(fixed.tables.live.length, 12);
  assert.equal(fixed.tables.snapshot.length, 7);
});
test("actual pure owner and two direct renderer consumers retain their distinct Job contracts", () =>
  validate(sources));
test("live generation, unknown/lost and approval vocabulary cannot become snapshot outcomes", () => {
  reject(
    changed("Owner", 'pending: "参数已生成"', 'pending: "已完成"'),
    "live-status-vocabulary",
  );
  reject(
    changed("Owner", 'generating: "正在生成参数"', 'generating: "已完成"'),
    "live-status-vocabulary",
  );
  reject(
    changed(
      "Owner",
      'approval_required: "等待审批"',
      'approval_required: "等待批准"',
    ),
    "live-status-vocabulary",
  );
  reject(
    changed(
      "Owner",
      'cancelled: "已取消",',
      'cancelled: "已取消", lost: "需核对结果",',
    ),
    "live-status-vocabulary",
  );
  reject(
    changed(
      "Owner",
      ")[tool.status] ?? tool.status",
      ')[tool.status] ?? "未知"',
    ),
    "live-status-fallback",
  );
  reject(
    changed(
      "Core",
      'waiting_approval: "等待批准"',
      'waiting_approval: "等待审批"',
    ),
    "snapshot-status-vocabulary",
  );
  reject(
    changed("Core", 'lost: "需核对结果"', 'lost: "已完成"'),
    "snapshot-status-vocabulary",
  );
});
test("snapshot stop requests cannot override a terminal result or lose active priority", () => {
  reject(
    changed(
      "Owner",
      '["queued", "waiting_approval", "running"].includes(job.status)',
      '["queued", "waiting_approval", "running", "succeeded"].includes(job.status)',
    ),
    "snapshot-stop-priority",
  );
  reject(
    changed("Owner", "job.cancel_requested_at &&", "true &&"),
    "snapshot-stop-priority",
  );
  reject(
    changed("Owner", '? "正在停止"', '? "已取消"'),
    "snapshot-stop-priority",
  );
});
test("typed annotation receipt and all four original complete algorithms stay authoritative", () => {
  reject(
    changed(
      "Owner",
      "job.result_event_id ? text(job.annotation?.result) || null : null",
      "text(job.annotation?.result) || null",
    ),
    "typed-job-result-receipt",
  );
  reject(
    changed("Owner", ".slice(0, 160)", ".slice(0, 600)"),
    "original-presentation-algorithm:short",
  );
  reject(
    changed("Owner", "result.ok !== true", "result.ok === false"),
    "original-presentation-algorithm:executionResultSummary",
  );
});
test("live parsing keeps the original incomplete JSON catch and exact render fallbacks", () => {
  reject(
    changed(
      "Owner",
      fixed.spans.liveParse.raw,
      "presentation = executionPresentation(tool.name, JSON.parse(tool.arguments), state);",
    ),
    "live-json-catch-boundary",
  );
  reject(
    changed(
      "Owner",
      "/* Streaming arguments may be incomplete. */",
      'throw new Error("incomplete");',
    ),
    "live-json-catch-boundary",
  );
  reject(
    changed("Owner", "JSON.parse(tool.arguments)", "tool.arguments"),
    "live-json-catch-boundary",
  );
  reject(
    changed(
      "Owner",
      'title: presentation?.title ?? tool.name ?? "工具调用"',
      'title: presentation?.title || tool.name || "工具调用"',
    ),
    "complete-live-presentation-algorithm",
  );
});
test("pure projection cannot acquire IO, React state, runtime Client types or async state", () => {
  reject(
    {
      ...sources,
      Owner: 'import { readFileSync } from "node:fs";\n' + sources.Owner,
    },
    "pure-owner-dependencies",
  );
  reject(
    {
      ...sources,
      Owner: 'import { useState } from "react";\n' + sources.Owner,
    },
    "pure-owner-dependencies",
  );
  reject(
    changed("Owner", "import type { LiveMessage }", "import { LiveMessage }"),
    "pure-owner-dependencies",
  );
  reject(
    {
      ...sources,
      Owner: sources.Owner + '\nconst surprise = fetch("/work");\n',
    },
    "pure-owner-dependencies",
  );
  reject(
    changed(
      "Owner",
      "export function liveToolPresentation(",
      "export async function liveToolPresentation(",
    ),
    "complete-live-presentation-algorithm",
  );
});
test("real import symbols, unwrapped calls and original render captures are required", () => {
  reject(
    changed(
      "Conversation",
      "const presentation = liveToolPresentation(tool, state);",
      "const wrapped = (tool: unknown, state: unknown) => liveToolPresentation(tool as never, state as never);\n  const presentation = wrapped(tool, state);",
    ),
    "actual-live-direct-consumer",
  );
  reject(
    changed(
      "Conversation",
      "const presentation = liveToolPresentation(tool, state);",
      "function hidden(liveToolPresentation: any) { return liveToolPresentation(tool, state); }\n  const presentation = hidden(null);",
    ),
    "actual-live-direct-consumer",
  );
  reject(
    changed(
      "Conversation",
      "const presentation = liveToolPresentation(tool, state);",
      'const liveToolPresentation = (_tool: unknown, _state: unknown) => ({title:"",detail:"",statusLabel:""});\n  const presentation = liveToolPresentation(tool, state);',
    ),
    "actual-live-direct-consumer",
  );
  reject(
    changed(
      "Conversation",
      "const presentation = liveToolPresentation(tool, state);",
      "const presentation = liveToolPresentation(tool, { ...state });",
    ),
    "actual-live-direct-consumer:captured-arguments",
  );
  reject(
    changed("Dialog", "{presentation.statusLabel}", "{job.status}"),
    "snapshot-rendered-status",
  );
  reject(
    changed(
      "Dialog",
      "const presentation = executionSnapshotJobPresentation(",
      "const wrapped = (...args: any[]) => executionSnapshotJobPresentation(args[0], args[1]);\n                  const presentation = wrapped(",
    ),
    "actual-snapshot-direct-consumer",
  );
  reject(
    changed(
      "Dialog",
      "client.boot!.workspace,\n                  );",
      "client.getSnapshot().workspace,\n                  );",
    ),
    "actual-snapshot-direct-consumer:captured-arguments",
  );
});
test("original visible status, identities and technical/prose bindings stay precise", () => {
  reject(
    changed(
      "Conversation",
      "data-tool-status={tool.status}",
      "data-tool-status={presentation.statusLabel}",
    ),
    "live-raw-status-identity",
  );
  reject(
    changed(
      "Conversation",
      '<span className="tool-state">{presentation.statusLabel}</span>',
      '<span className="tool-state">{tool.status}</span>',
    ),
    "live-rendered-status",
  );
  reject(
    changed(
      "Conversation",
      '{tool.result || "无文本输出"}',
      '{presentation.detail || "无文本输出"}',
    ),
    "live-raw-technical-details",
  );
  reject(
    changed(
      "Dialog",
      "className={`job-status ${job.status}`}",
      "className={`job-status ${presentation.statusLabel}`}",
    ),
    "snapshot-raw-status-class",
  );
  reject(
    changed("Dialog", "data-job-id={job.id}", "data-job-id={job.thread_id}"),
    "snapshot-job-identity",
  );
});
test("unrelated lawful module/TSX/CSS/comment changes and direct local import aliases are accepted", () => {
  validate({
    ...sources,
    Owner:
      'import type { Artifact } from "../../../packages/core/src/model.js";\n' +
      sources.Owner +
      "\nexport const unrelatedPure = (value: number) => value + 1;\n",
    Conversation:
      'import "./unrelated-feature.css";\n// unrelated comment\n' +
      sources.Conversation +
      '\nexport function UnrelatedPanel() { return <aside data-other="yes">Other</aside>; }\n',
    Dialog:
      sources.Dialog +
      '\nconst unrelatedDisplay = <footer data-extra="safe">Other</footer>;\n',
  });
  validate({
    ...sources,
    Conversation: replaceOnce(
      replaceOnce(
        sources.Conversation,
        "import { liveToolPresentation }",
        "import { liveToolPresentation as liveJob }",
      ),
      "const presentation = liveToolPresentation(tool, state);",
      "const presentation = liveJob(tool, state);",
    ),
    Dialog: replaceOnce(
      replaceOnce(
        sources.Dialog,
        "  executionSnapshotJobPresentation,",
        "  executionSnapshotJobPresentation as snapshotJob,",
      ),
      "const presentation = executionSnapshotJobPresentation(",
      "const presentation = snapshotJob(",
    ),
  });
});
