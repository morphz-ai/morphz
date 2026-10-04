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
  isBindingElement,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isNamedImports,
  isParameterDeclaration,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from "typescript/unstable/ast";

// Fixed finite algorithms, not whole App/Client/renderer hashes. Actual-Git
// complete-file provenance/inverse is a one-time /tmp proof, never normal CI.
// Related behavior and actual React surfaces are covered independently.
const fixed = {
  baseline: "a1acc677402045068384a73f8f72a2d8c28f6b1e",
  recipes: {
    activeBranches: {
      raw: "const activeBranches =\n                item && client.online\n                  ? activeExecutionThreads(runtime).filter(\n                      (t) => t.inputId === item.id,\n                    )\n                  : [];",
      sha256:
        "36d388056ce045b05f4caa08539d3bd682df3907459bc9270178ac3840af727e",
    },
    activeBranch: {
      raw: "const activeBranch = activeBranches.length > 0;",
      sha256:
        "e7264c403b55d0db9b6031e33a3b2d00838cc91bacc088ee66d0f620d918dffc",
    },
    branchStatuses: {
      raw: "const branchStatuses = activeBranches.map((thread) =>\n                executionActivityStatus(thread, true),\n              );",
      sha256:
        "ffe0a75b3563ef73f4f62f19c01307c8330624023762bb5cd96e377255b15c01",
    },
    workStatus: {
      raw: 'const workStatus =\n                branchStatuses.find((s) => s.kind === "running") ??\n                branchStatuses.find((s) => s.kind === "unknown") ??\n                branchStatuses.find((s) => s.kind === "paused") ??\n                branchStatuses[0];',
      sha256:
        "d3ffdd9b3b3d8bdaba231283f0fad3992571858dd4d4df5bdbb21dbebce40463",
    },
    activityThreads: {
      raw: "const activityThreads = executionActivityThreads(\n    state,\n    threads,\n    scope,\n    allWork,\n    !client.boot!.capabilities.teamAuthentication,\n  );",
      sha256:
        "55d69fadef86a047f19a5d595f855a5d9ba3b07ec6616ccf3d1fbe537fba27c9",
    },
    groupedActivities: {
      raw: "const groupedActivities = executionActivityRoots(activityThreads);",
      sha256:
        "00c4ec00e369cc81eda060490fa5c65e740f13aab0d1b8640689e682c09c2c2c",
    },
    hasOpenWork: {
      raw: 'const hasOpenWork = (t: ActivityThread) =>\n    t.lifecycle === "open" ||\n    executionActivityDescendants(t, activityThreads).some(\n      (child) => child.lifecycle === "open",\n    );',
      sha256:
        "05393d0cdf4dbb3092d9b880a477b07c431c0ab7ce40f48bcf2ac1ba10d9b6bc",
    },
    active: {
      raw: "const active = groupedActivities.filter(hasOpenWork);",
      sha256:
        "2b0b739177198732cdf14b80afe715812ff84fabca21ec004bf14fd3f9921392",
    },
    recent: {
      raw: "const recent = executionActivityDateGroups(\n    groupedActivities.filter((t) => !hasOpenWork(t)),\n  );",
      sha256:
        "3506b93fa909d10c31a9c609de1f363b5beed0f28163f5bd00c740da9e470c78",
    },
    activeCount: {
      raw: "const activeCount = active.length;",
      sha256:
        "7a08369d3d19127cd77c3d48898108536b5216e1bdad7a7d4b510ea54d3cf1f2",
    },
    activityAvailable: {
      raw: "const activityAvailable =\n    runtime.connected && runtime.activity?.available === true;",
      sha256:
        "e862b0398b58e301be39162ba21b0ccddf2fc858078bfce8b9ee321bd6a56a57",
    },
    activityComplete: {
      raw: "const activityComplete = activityAvailable && !runtime.activity?.truncated;",
      sha256:
        "313c37af26ef79b5c722153c00d22d2bc8d689ca68e1fe7273e4ea3410fdc80c",
    },
    activitySummary: {
      raw: 'const activitySummary = !activityAvailable\n    ? "工作状态待核对"\n    : runtime.activity?.truncated\n      ? activeCount\n        ? `至少 ${activeCount} 项进行中`\n        : "工作状态待核对"\n      : `${activeCount} 项进行中`;',
      sha256:
        "b58305c8debcf0ad1056cb37134bdd4267bba00702043434d7940d325d641cc7",
    },
  },
  algorithms: {
    executionActivityStatus:
      "c09a77a531d25e9a81527af730ddc8f95568b28e492c2689de0ca9ce822f5ea4",
    sameActivityDomain:
      "0906ddf97deb78ddf1bbcb65dbd6d44d4a36a48b37c728b76abebd4733f09d24",
    executionActivityDescendants:
      "a86c734e4769867953c17502c669396897bfb49bd656ae2fd41e3f85e702a4d6",
    executionActivityRoots:
      "abd7e48550fc34dcd8a0c0fe66db9361538afc6f061ca18e22d8388c2003cbd5",
    executionActivityTime:
      "d57d4eafd4cbd311198c8d05285feaedc92cf7e0bcc743ee7309c43efc276978",
    timestampRank:
      "4a44d5c27b2e6e518db53455c17577c9a44a74ce2613bdaec2ab92a632e28b13",
    executionActivityThreads:
      "54e1d563c1ef80f5471a9fe97d41f97ed83fe5e9538d6406e7e8cd6082f9ca47",
    executionActivityDateGroups:
      "003a321aa16c0c239319b44e3654757b9895c25691df32d21bda2772dfbd878f",
    activeExecutionThreads:
      "8a5e537a9173a4a5e281c2989c3eb88cd961374575cef3d542f95ebd924c1597",
  },
  threadSummary:
    'const threadSummary = thread\n    ? executionActivitySummary(thread, activityAvailable && !!currentThread)\n    : "";',
} as const;
const paths = {
  Owner: "../apps/web/src/execution-activity.ts",
  Conversation: "../apps/web/src/Conversation.tsx",
  Sidebar: "../apps/web/src/ExecutionSidebar.tsx",
  Core: "../packages/core/src/conversation.ts",
} as const;
type Sources = Record<keyof typeof paths, string>;
type Parsed = {
  source: SourceFile;
  nodes: Node[];
  symbols: Map<Node, number | undefined>;
  imports: Map<number, string>;
};
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function inside(node: Node): Node[] {
  const nodes: Node[] = [];
  function walk(current: Node) {
    nodes.push(current);
    current.forEachChild((child) => {
      walk(child);
    });
  }
  walk(node);
  return nodes;
}
function parse(contents: Record<string, string>) {
  const cwd = "/thread-collection-contract",
    config = cwd + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(contents).map(([key, value]) => [
      cwd + "/" + key + ".tsx",
      value,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((key) => key + ".tsx"),
  });
  const api = new API({ cwd, fs: createVirtualFileSystem(files) }),
    snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal-parsed-source",
    );
    const result = new Map<string, Parsed>();
    for (const key of Object.keys(contents)) {
      const source = project.program.getSourceFile(cwd + "/" + key + ".tsx")!,
        nodes = inside(source);
      const ids = nodes.filter(isIdentifier),
        resolved = project.checker.getSymbolAtLocation(ids);
      const symbols = new Map<Node, number | undefined>();
      ids.forEach((node, index) => symbols.set(node, resolved[index]?.id));
      const imports = new Map<number, string>();
      for (const node of source.statements.filter(isImportDeclaration)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && isNamedImports(bindings))
          for (const entry of bindings.elements) {
            const symbol = symbols.get(entry.name);
            if (symbol !== undefined)
              imports.set(symbol, (entry.propertyName ?? entry.name).text);
          }
      }
      result.set(key, { source, nodes, symbols, imports });
    }
    return result;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function shape(node: Node, parsed?: Parsed): unknown {
  if (node.kind === SyntaxKind.JsxText && !node.getText().trim())
    return undefined;
  const children: unknown[] = [];
  node.forEachChild((child) => {
    const value = shape(child, parsed);
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
      : isStringLiteral(node)
        ? node.text
        : symbol === undefined
          ? node.getText()
          : (parsed?.imports.get(symbol) ?? node.getText()),
  ];
}
function fn(parsed: Parsed, name: string): FunctionDeclaration {
  const matches = parsed.source.statements
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(matches.length, 1, "complete-algorithm:" + name);
  assert.ok(matches[0]!.body, "complete-algorithm:" + name);
  return matches[0]!;
}
function variable(node: Node, name: string): VariableDeclaration {
  const matches = inside(node)
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, "original-fact:" + name);
  return matches[0]!;
}
function statement(node: VariableDeclaration) {
  assert.ok(isVariableStatement(node.parent?.parent!), "direct-statement");
  return node.parent!.parent!;
}
function same(actual: Node, expected: Node, rule: string, parsed?: Parsed) {
  assert.deepEqual(shape(actual, parsed), shape(expected), rule);
}
function expression(raw: string) {
  return parse({ Expression: "const expression=" + raw + ";" })
    .get("Expression")!
    .nodes.filter(isVariableDeclaration)[0]!.initializer!;
}
function imported(
  parsed: Parsed,
  name: string,
  module = "./execution-activity.js",
): Identifier {
  const matches = parsed.source.statements
    .filter(isImportDeclaration)
    .flatMap((node) => {
      if (
        !isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== module ||
        node.importClause?.phaseModifier === SyntaxKind.TypeKeyword
      )
        return [];
      const bindings = node.importClause?.namedBindings;
      return bindings && isNamedImports(bindings)
        ? bindings.elements
            .filter(
              (entry) =>
                !entry.isTypeOnly &&
                (entry.propertyName ?? entry.name).text === name,
            )
            .map((entry) => entry.name)
        : [];
    });
  assert.equal(matches.length, 1, "actual-import:" + name);
  return matches[0]!;
}
function sameBinding(
  parsed: Parsed,
  actual: Identifier,
  expected: Node,
  rule: string,
) {
  const symbol = parsed.symbols.get(expected);
  assert.ok(
    symbol !== undefined && symbol === parsed.symbols.get(actual),
    rule,
  );
}
function references(
  parsed: Parsed,
  node: Node,
  bindings: Record<string, Node>,
  rule: string,
) {
  for (const id of inside(node).filter(isIdentifier)) {
    // An object field (client.boot.runtime) is not the render variable runtime.
    if (
      id.parent &&
      isPropertyAccessExpression(id.parent) &&
      id.parent.name === id
    )
      continue;
    if (bindings[id.text])
      sameBinding(parsed, id, bindings[id.text]!, rule + ":" + id.text);
  }
}
function boundName(node: Node): Identifier {
  assert.ok(
    isBindingElement(node) || isVariableDeclaration(node),
    "original-bound-name",
  );
  assert.ok(node.name && isIdentifier(node.name), "original-bound-name");
  return node.name;
}
function param(component: FunctionDeclaration, name: string) {
  const matches = inside(component.parameters[0]!)
    .filter(isBindingElement)
    .filter(
      (node) => node.name && isIdentifier(node.name) && node.name.text === name,
    );
  assert.equal(matches.length, 1, "captured-render-parameter:" + name);
  return boundName(matches[0]!);
}
function consumption(
  parsed: Parsed,
  component: FunctionDeclaration,
  name: string,
  fields: readonly string[],
  argumentsText: string,
  rule: string,
) {
  const binding = imported(parsed, name);
  const calls = inside(component)
    .filter(isCallExpression)
    .filter(
      (call) =>
        isIdentifier(call.expression) && call.expression.text === binding.text,
    );
  assert.equal(calls.length, 1, rule);
  const call = calls[0]!;
  assert.ok(isIdentifier(call.expression), rule);
  sameBinding(parsed, call.expression, binding, rule + ":import-binding");
  assert.ok(isVariableDeclaration(call.parent!), rule + ":direct-alias");
  const declaration = call.parent!;
  same(
    declaration.name,
    parse({ Binding: "const {" + fields.join(",") + "} = value;" })
      .get("Binding")!
      .nodes.filter(isVariableDeclaration)[0]!.name,
    rule + ":fields",
  );
  const expected = expression("collect(" + argumentsText + ")");
  assert.ok(isCallExpression(expected));
  assert.deepEqual(
    call.arguments.map((node) => shape(node)),
    expected.arguments.map((node) => shape(node)),
    rule + ":captured-arguments",
  );
  return {
    call,
    declaration,
    statement: statement(declaration),
    fields: Object.fromEntries(
      inside(declaration.name)
        .filter(isBindingElement)
        .map((node) => {
          const name = boundName(node);
          return [name.text, name];
        }),
    ),
  };
}
const inputNames = [
  "activeBranches",
  "activeBranch",
  "branchStatuses",
  "workStatus",
] as const;
const overviewNames = [
  "activityThreads",
  "groupedActivities",
  "hasOpenWork",
  "active",
  "recent",
  "activeCount",
  "activityAvailable",
  "activityComplete",
] as const;
const expected = parse({
  Input: `export function inputExecutionActivityPresentation(runtime:ConversationRuntime,item:Pick<RecordedInput,"id">|null|undefined,online:boolean|null|undefined):Readonly<{activeBranch:boolean;workStatus:ActivityStatus|undefined}>{
    ${inputNames
      .map((name) => fixed.recipes[name].raw)
      .join("\n")
      .replace("client.online", "online")}
    return {activeBranch,workStatus};
  }`,
  Overview: `export function executionActivityOverview(state:Workspace,threads:readonly ActivityThread[],scope:ExecutionScope,allWork:boolean,sharedDefault:boolean,runtime:ConversationRuntime):Readonly<{activityThreads:ActivityThread[];active:ActivityThread[];recent:ReturnType<typeof executionActivityDateGroups>;activeCount:number;activityAvailable:boolean;activityComplete:boolean}>{
    ${overviewNames
      .map((name) => fixed.recipes[name].raw)
      .join("\n")
      .replace(
        "!client.boot!.capabilities.teamAuthentication",
        "sharedDefault",
      )}
    return {activityThreads,active,recent,activeCount,activityAvailable,activityComplete};
  }`,
  Summary: `export function executionActivityOverviewSummary(runtime:ConversationRuntime,activityAvailable:boolean,activeCount:number):string{${fixed.recipes.activitySummary.raw} return activitySummary;}`,
  Prose: fixed.threadSummary,
});
function typedCoreInputs(owner: Parsed) {
  for (const [name, module, methods] of [
    [
      "ConversationRuntime",
      "conversation",
      [
        "inputExecutionActivityPresentation",
        "executionActivityOverview",
        "executionActivityOverviewSummary",
      ],
    ],
    ["RecordedInput", "model", ["inputExecutionActivityPresentation"]],
    ["Workspace", "model", ["executionActivityOverview"]],
    ["ExecutionScope", "execution", ["executionActivityOverview"]],
  ] as const) {
    const matches = owner.source.statements
      .filter(isImportDeclaration)
      .flatMap((node) => {
        if (
          !isStringLiteral(node.moduleSpecifier) ||
          node.moduleSpecifier.text !==
            "../../../packages/core/src/" + module + ".js"
        )
          return [];
        const clause = node.importClause,
          entries = clause?.namedBindings;
        if (!entries || !isNamedImports(entries)) return [];
        return entries.elements
          .filter(
            (entry) =>
              (entry.propertyName ?? entry.name).text === name &&
              (entry.isTypeOnly ||
                clause?.phaseModifier === SyntaxKind.TypeKeyword),
          )
          .map((entry) => entry.name);
      });
    const rule = "typed-core-input:" + name;
    assert.equal(matches.length, 1, rule);
    const binding = matches[0]!;
    for (const method of methods) {
      const declaration = fn(owner, method);
      const signature = [
        ...declaration.parameters.flatMap(inside),
        ...(declaration.type ? inside(declaration.type) : []),
      ];
      const uses = signature
        .filter(isIdentifier)
        .filter((id) => id.text === binding.text || id.text === name);
      assert.ok(uses.length > 0, rule);
      for (const id of uses) sameBinding(owner, id, binding, rule);
    }
  }
}
function pureOwner(parsed: Parsed) {
  const localSymbols = new Set(
    parsed.nodes
      .filter(isIdentifier)
      .filter((id) => {
        const parent = id.parent;
        return (
          parent &&
          (isVariableDeclaration(parent) ||
            isBindingElement(parent) ||
            isParameterDeclaration(parent) ||
            isFunctionDeclaration(parent)) &&
          parent.name === id
        );
      })
      .map((id) => parsed.symbols.get(id))
      .filter((symbol) => symbol !== undefined),
  );
  for (const node of parsed.source.statements.filter(isImportDeclaration)) {
    const clause = node.importClause,
      entries =
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
        [
          "../../../packages/core/src/conversation.js",
          "../../../packages/core/src/model.js",
        ].includes(node.moduleSpecifier.text) &&
        clause &&
        !clause.name &&
        entries,
      "pure-owner-dependencies",
    );
    assert.ok(
      entries.every(
        (entry) =>
          entry.isTypeOnly ||
          ["activeExecutionThreads", "inConversation"].includes(
            (entry.propertyName ?? entry.name).text,
          ),
      ),
      "pure-owner-dependencies",
    );
  }
  for (const node of parsed.nodes) {
    if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
      let root = node.expression;
      while (
        isPropertyAccessExpression(root) ||
        isElementAccessExpression(root)
      )
        root = root.expression;
      if (
        isIdentifier(root) &&
        [
          "process",
          "globalThis",
          "window",
          "document",
          "navigator",
          "localStorage",
          "sessionStorage",
        ].includes(root.text)
      ) {
        const symbol = parsed.symbols.get(root);
        assert.ok(
          symbol !== undefined && localSymbols.has(symbol),
          "pure-owner-no-environment-or-global-write",
        );
      }
    }
    if (isCallExpression(node)) {
      let receiver = node.expression;
      while (
        isPropertyAccessExpression(receiver) ||
        isElementAccessExpression(receiver)
      )
        receiver = receiver.expression;
      const receiverSymbol = isIdentifier(receiver)
        ? parsed.symbols.get(receiver)
        : undefined;
      const localReceiver =
        receiverSymbol !== undefined && localSymbols.has(receiverSymbol);
      assert.ok(
        !/^(?:fetch|require|use[A-Z]\w*|setTimeout|setInterval|requestAnimationFrame|queueMicrotask)$/.test(
          node.expression.getText(),
        ) &&
          (!/^(?:client|window|document|localStorage|sessionStorage|process)\./.test(
            node.expression.getText(),
          ) ||
            localReceiver) &&
          node.expression.kind !== SyntaxKind.ImportKeyword,
        "pure-owner-no-effect-or-io",
      );
    }
  }
}
function classElement(container: Node, className: string) {
  const elements = inside(container)
    .filter(isJsxElement)
    .filter((node) =>
      node.openingElement.attributes.properties.some(
        (attr) =>
          isJsxAttribute(attr) &&
          attr.name.getText() === "className" &&
          attr.initializer &&
          isStringLiteral(attr.initializer) &&
          attr.initializer.text === className,
      ),
    );
  assert.equal(elements.length, 1, "collection-DOM:" + className);
  return elements[0]!;
}
function jsxValue(element: Node, name: string) {
  assert.ok(isJsxElement(element));
  const attrs = element.openingElement.attributes.properties
    .filter(isJsxAttribute)
    .filter((attr) => attr.name.getText() === name);
  assert.equal(attrs.length, 1, "collection-DOM-attribute:" + name);
  const value = attrs[0]!.initializer;
  assert.ok(
    value && isJsxExpression(value) && value.expression,
    "collection-DOM-attribute:" + name,
  );
  return value.expression;
}
function originalValue(
  actual: Node,
  raw: string,
  parsed: Parsed,
  bindings: Record<string, Node>,
  rule: string,
) {
  same(actual, expression(raw), rule);
  references(parsed, actual, bindings, rule + ":result-binding");
}
function validate(contents: Sources) {
  const parsed = parse(contents),
    owner = parsed.get("Owner")!,
    core = parsed.get("Core")!;
  pureOwner(owner);
  typedCoreInputs(owner);
  for (const [name, key, rule] of [
    [
      "inputExecutionActivityPresentation",
      "Input",
      "input-collection-algorithm",
    ],
    ["executionActivityOverview", "Overview", "overview-collection-algorithm"],
    [
      "executionActivityOverviewSummary",
      "Summary",
      "overview-bounded-quality-summary",
    ],
  ] as const)
    same(fn(owner, name), fn(expected.get(key)!, name), rule, owner);
  for (const [name, digest] of Object.entries(fixed.algorithms)) {
    const where = name === "activeExecutionThreads" ? core : owner;
    const node =
      name === "sameActivityDomain"
        ? statement(variable(where.source, name))
        : fn(where, name);
    assert.equal(
      hash(JSON.stringify(shape(node, where))),
      digest,
      "collection-domain-algorithm:" + name,
    );
  }
  imported(
    owner,
    "activeExecutionThreads",
    "../../../packages/core/src/conversation.js",
  );
  imported(owner, "inConversation", "../../../packages/core/src/model.js");
  const conversation = parsed.get("Conversation")!,
    conversationFn = fn(conversation, "Conversation");
  const input = consumption(
    conversation,
    conversationFn,
    "inputExecutionActivityPresentation",
    ["activeBranch", "workStatus"],
    "runtime,item,item && client.online",
    "input-direct-consumer",
  );
  const inputBlock = input.statement.parent!;
  assert.ok(
    isArrowFunction(inputBlock.parent!),
    "input-original-timeline-phase",
  );
  const renderItem = inside(inputBlock.parent!.parameters[0]!)
    .filter(isBindingElement)
    .find(
      (node) =>
        node.name && isIdentifier(node.name) && node.name.text === "item",
    );
  assert.ok(
    renderItem && renderItem.propertyName?.getText() === "input",
    "input-original-timeline-phase",
  );
  const itemName = boundName(renderItem);
  references(
    conversation,
    input.call,
    {
      runtime: param(conversationFn, "runtime"),
      client: param(conversationFn, "client"),
      item: itemName,
    },
    "input-captured-render-facts",
  );
  const inputBindings = input.fields;
  const background = inside(conversationFn)
    .filter(isJsxAttribute)
    .filter((node) => node.name.getText() === "data-background-execution");
  assert.equal(background.length, 1, "input-background-marker");
  assert.ok(
    background[0]!.initializer &&
      isJsxExpression(background[0]!.initializer) &&
      background[0]!.initializer.expression,
  );
  originalValue(
    background[0]!.initializer.expression,
    "activeBranch || undefined",
    conversation,
    inputBindings,
    "input-background-marker",
  );
  const card = classElement(
    conversationFn,
    "message-execution-link message-work-status",
  );
  assert.ok(
    isBinaryExpression(card.parent!.parent!),
    "input-original-work-guard",
  );
  same(
    card.parent!.parent!.left,
    expression("activeBranch && onInspect && workStatus"),
    "input-original-work-guard",
  );
  references(
    conversation,
    card.parent!.parent!.left,
    inputBindings,
    "input-original-work-guard",
  );
  for (const [attr, raw] of [
    ["data-status", "workStatus.kind"],
    ["onClick", "() => onInspect(item.id)"],
    ["title", 'workStatus.label + " · 查看这条消息的执行记录"'],
  ] as const)
    originalValue(
      jsxValue(card, attr),
      raw,
      conversation,
      { ...inputBindings, item: itemName },
      "input-DOM:" + attr,
    );
  const label = card.children
    .filter(isJsxElement)
    .find((element) => element.openingElement.tagName.getText() === "span")!;
  assert.ok(label, "input-status-label");
  same(
    label,
    parse({ Label: "<span>{workStatus.label}</span>;" })
      .get("Label")!
      .nodes.find(isJsxElement)!,
    "input-status-label",
  );
  references(conversation, label, inputBindings, "input-status-label");
  const sidebar = parsed.get("Sidebar")!,
    sidebarFn = fn(sidebar, "ExecutionSidebar");
  const overview = consumption(
    sidebar,
    sidebarFn,
    "executionActivityOverview",
    [
      "activityThreads",
      "active",
      "recent",
      "activeCount",
      "activityAvailable",
      "activityComplete",
    ],
    "state,threads,scope,allWork,!client.boot!.capabilities.teamAuthentication,runtime",
    "overview-direct-consumer",
  );
  const state = variable(sidebarFn, "state"),
    runtime = variable(sidebarFn, "runtime"),
    threads = variable(sidebarFn, "threads");
  for (const [actual, raw] of [
    [state, "client.boot!.workspace"],
    [runtime, "client.boot!.runtime"],
    [threads, "runtime.activity?.threads ?? []"],
  ] as const) {
    assert.ok(actual.initializer, "overview-render-record");
    originalValue(
      actual.initializer,
      raw,
      sidebar,
      { client: param(sidebarFn, "client"), runtime: boundName(runtime) },
      "overview-render-record",
    );
  }
  references(
    sidebar,
    overview.call,
    {
      state: boundName(state),
      runtime: boundName(runtime),
      threads: boundName(threads),
      scope: param(sidebarFn, "scope"),
      client: param(sidebarFn, "client"),
      allWork: boundName(variable(sidebarFn, "allWork")),
    },
    "overview-captured-render-facts",
  );
  const prose = variable(sidebarFn, "threadSummary");
  same(
    statement(prose),
    expected.get("Prose")!.source.statements[0]!,
    "original-thread-prose-phase",
  );
  references(sidebar, prose, overview.fields, "original-thread-prose-phase");
  const summary = variable(sidebarFn, "activitySummary"),
    summaryImport = imported(sidebar, "executionActivityOverviewSummary");
  assert.ok(
    summary.initializer &&
      isCallExpression(summary.initializer) &&
      isIdentifier(summary.initializer.expression),
    "overview-summary-direct-consumer",
  );
  sameBinding(
    sidebar,
    summary.initializer.expression,
    summaryImport,
    "overview-summary-direct-consumer",
  );
  same(
    summary.initializer,
    expression(
      "executionActivityOverviewSummary(runtime,activityAvailable,activeCount)",
    ),
    "overview-summary-direct-consumer",
    sidebar,
  );
  references(
    sidebar,
    summary.initializer,
    { runtime: boundName(runtime), ...overview.fields },
    "overview-summary-captured-facts",
  );
  assert.ok(
    overview.statement.end < statement(prose).getStart() &&
      statement(prose).end < statement(summary).getStart() &&
      overview.statement.parent === statement(prose).parent &&
      statement(prose).parent === statement(summary).parent,
    "original-collect-prose-summary-order",
  );
  const count = classElement(sidebarFn, "execution-scope-count");
  same(
    count,
    parse({
      Count:
        '<small className="execution-scope-count">{activitySummary}</small>;',
    })
      .get("Count")!
      .nodes.find(isJsxElement)!,
    "overview-count-DOM",
  );
  references(
    sidebar,
    count,
    { activitySummary: boundName(summary) },
    "overview-count-DOM",
  );
  for (const [raw, rule] of [
    ["active.map(row)", "overview-active-rows"],
    ["recent.map", "overview-recent-groups"],
  ] as const) {
    const calls = inside(sidebarFn)
      .filter(isCallExpression)
      .filter((node) =>
        raw === "recent.map"
          ? node.expression.getText() === raw
          : node.getText() === raw,
      );
    assert.equal(calls.length, 1, rule);
    references(sidebar, calls[0]!, overview.fields, rule);
  }
  const quiet = classElement(sidebarFn, "execution-quiet");
  const quietValue = quiet.children.find(isJsxExpression);
  assert.ok(quietValue?.expression);
  originalValue(
    quietValue.expression,
    'activityComplete ? "当前没有正在处理的工作" : "尚不能确认是否有工作进行中"',
    sidebar,
    overview.fields,
    "overview-quiet-quality-DOM",
  );
}

function changed(key: keyof Sources, before: string, after: string): Sources {
  assert.equal(
    sources[key].split(before).length,
    2,
    "unique-counterfactual-target",
  );
  return { ...sources, [key]: sources[key].replace(before, after) };
}
function rejected(mutated: Sources, rule: string) {
  parse(mutated); // Invalid syntax is never evidence that the owned rule works.
  assert.throws(
    () => validate(mutated),
    (error) =>
      error instanceof assert.AssertionError && error.message.includes(rule),
    "specified contract: " + rule,
  );
}
test("fixed thirteen complete historical declarations retain their independently captured raw hashes", () => {
  assert.equal(fixed.baseline, "a1acc677402045068384a73f8f72a2d8c28f6b1e");
  assert.deepEqual(Object.keys(fixed.recipes), [
    ...inputNames,
    ...overviewNames,
    "activitySummary",
  ]);
  for (const recipe of Object.values(fixed.recipes))
    assert.equal(hash(recipe.raw), recipe.sha256);
  assert.equal(Object.keys(fixed.algorithms).length, 9);
});
test("three typed collection projections own the complete original algorithms and actual consumers", () =>
  validate(sources));

test("input priority, exact identity and first fallback cannot be replaced by a different family policy", () => {
  for (const [before, after] of [
    [
      'branchStatuses.find((s) => s.kind === "running")',
      'branchStatuses.find((s) => s.kind === "waiting")',
    ],
    [
      'branchStatuses.find((s) => s.kind === "unknown")',
      'branchStatuses.find((s) => s.kind === "paused")',
    ],
    ["(t) => t.inputId === item.id", "(t) => t.projectId === item.id"],
    ["branchStatuses[0]", "branchStatuses.at(-1)"],
    [
      "executionActivityStatus(thread, true)",
      "executionActivityGroupStatus(thread, activeBranches, true)",
    ],
    ["online: boolean | null | undefined", "online: () => boolean"],
    [
      "export function inputExecutionActivityPresentation(",
      "export async function inputExecutionActivityPresentation(",
    ],
  ] as const)
    rejected(changed("Owner", before, after), "input-collection-algorithm");
  rejected(
    changed(
      "Core",
      't.kind === "execution" && t.lifecycle === "open"',
      't.lifecycle === "open"',
    ),
    "collection-domain-algorithm:activeExecutionThreads",
  );
});
test("overview roots, active descendants, date/read ordering and bounded quality retain their complete contract", () => {
  for (const [before, after] of [
    [
      "const groupedActivities = executionActivityRoots(activityThreads);",
      "const groupedActivities = activityThreads;",
    ],
    [
      "executionActivityDescendants(t, activityThreads).some(",
      "executionActivityDescendants(t, threads).some(",
    ],
    [
      "const activeCount = active.length;",
      "const activeCount = activityThreads.length;",
    ],
    [
      "runtime.connected && runtime.activity?.available === true",
      "runtime.configured && runtime.activity?.available === true",
    ],
    [
      "activityAvailable && !runtime.activity?.truncated",
      "activityAvailable && runtime.openWorkComplete",
    ],
  ] as const)
    rejected(changed("Owner", before, after), "overview-collection-algorithm");
  rejected(
    changed(
      "Owner",
      'const activitySummary = !activityAvailable\n    ? "工作状态待核对"',
      'const activitySummary = !activityAvailable\n    ? "当前没有正在处理的工作"',
    ),
    "overview-bounded-quality-summary",
  );
  rejected(
    changed("Owner", "至少 ${activeCount} 项进行中", "${activeCount} 项进行中"),
    "overview-bounded-quality-summary",
  );
  rejected(
    changed(
      "Owner",
      "export function executionActivityOverviewSummary(",
      "export function* executionActivityOverviewSummary(",
    ),
    "overview-bounded-quality-summary",
  );
  const available =
    "const activityAvailable =\n    runtime.connected && runtime.activity?.available === true;";
  const reordered = {
    ...sources,
    Owner: sources.Owner.replace(available, "").replace(
      "const recent = executionActivityDateGroups(",
      available + "\n  const recent = executionActivityDateGroups(",
    ),
  };
  rejected(reordered, "overview-collection-algorithm");
});
test("same-domain roots, actual scope/revision and date algorithms reject legal but unauthorized substitutions", () => {
  for (const [before, after, rule] of [
    ["a.projectId === b.projectId", "true", "sameActivityDomain"],
    [
      "!parent || !sameActivityDomain(thread, parent)",
      "!parent",
      "executionActivityRoots",
    ],
    [
      "!sameActivityDomain(thread, child)",
      "false",
      "executionActivityDescendants",
    ],
    [
      "source.projectId !== thread.projectId",
      "source.projectId !== scope.projectId",
      "executionActivityThreads",
    ],
    [
      "const previous = byId.get(thread.id);",
      "const previous = byId.get(thread.inputId!);",
      "executionActivityThreads",
    ],
    [
      "thread.revision > previous.revision",
      "thread.revision >= previous.revision",
      "executionActivityThreads",
    ],
    [
      "thread.outcome?.terminalKind === thread.lifecycle",
      "!!thread.outcome",
      "executionActivityTime",
    ],
    ["Number.NEGATIVE_INFINITY", "0", "timestampRank"],
    ['? "时间待核对"', '? "今天"', "executionActivityDateGroups"],
    [
      'if (thread.controlState === "paused")',
      'if (thread.phase === "running")',
      "executionActivityStatus",
    ],
  ] as const)
    rejected(
      changed("Owner", before, after),
      "collection-domain-algorithm:" + rule,
    );
});
test("real input import, direct alias and captured item-online guard reject wrappers, latest values and shadowing", () => {
  rejected(
    changed("Conversation", "item && client.online,", "client.online,"),
    "input-direct-consumer:captured-arguments",
  );
  rejected(
    changed(
      "Conversation",
      "inputExecutionActivityPresentation(\n                  runtime,",
      "inputExecutionActivityPresentation(\n                  client.getSnapshot().runtime,",
    ),
    "input-direct-consumer:captured-arguments",
  );
  rejected(
    changed(
      "Conversation",
      "inputExecutionActivityPresentation(\n                  runtime,\n                  item,\n                  item && client.online,\n                )",
      "(() => inputExecutionActivityPresentation(runtime,item,item && client.online))()",
    ),
    "input-direct-consumer:direct-alias",
  );
  rejected(
    changed(
      "Conversation",
      "const { activeBranch, workStatus } =",
      "const inputExecutionActivityPresentation = () => ({activeBranch:false,workStatus:undefined});\n              const { activeBranch, workStatus } =",
    ),
    "input-direct-consumer:import-binding",
  );
  rejected(
    changed(
      "Conversation",
      "import { inputExecutionActivityPresentation }",
      "import type { inputExecutionActivityPresentation }",
    ),
    "actual-import:inputExecutionActivityPresentation",
  );
});
test("overview uses the original captured render facts and keeps collect-prose-summary in one evaluation phase", () => {
  rejected(
    changed(
      "Sidebar",
      "!client.boot!.capabilities.teamAuthentication,",
      "true,",
    ),
    "overview-direct-consumer:captured-arguments",
  );
  rejected(
    changed(
      "Sidebar",
      "runtime = client.boot!.runtime;",
      "runtime = client.getSnapshot().runtime;",
    ),
    "overview-render-record",
  );
  rejected(
    changed(
      "Sidebar",
      "  const {\n    activityThreads,",
      "  const executionActivityOverview = () => ({activityThreads:[],active:[],recent:[],activeCount:0,activityAvailable:true,activityComplete:true});\n  const {\n    activityThreads,",
    ),
    "overview-direct-consumer:import-binding",
  );
  rejected(
    changed(
      "Sidebar",
      "const activitySummary = executionActivityOverviewSummary(",
      'const executionActivityOverviewSummary = () => "0 项进行中";\n  const activitySummary = executionActivityOverviewSummary(',
    ),
    "overview-summary-direct-consumer",
  );
  const parsed = parse(sources).get("Sidebar")!,
    component = fn(parsed, "ExecutionSidebar");
  const summary = statement(variable(component, "activitySummary")).getText(),
    prose = statement(variable(component, "threadSummary")).getText();
  const reordered = {
    ...sources,
    Sidebar: sources.Sidebar.replace(summary, "").replace(
      prose,
      summary + "\n  " + prose,
    ),
  };
  rejected(reordered, "original-collect-prose-summary-order");
});
test("original background marker, status/provenance click, collection rows and empty-quality DOM use actual result bindings", () => {
  for (const [before, after, rule] of [
    [
      "data-background-execution={activeBranch || undefined}",
      "data-background-execution={true}",
      "input-background-marker",
    ],
    [
      "activeBranch && onInspect && workStatus",
      "onInspect && workStatus",
      "input-original-work-guard",
    ],
    [
      "data-status={workStatus.kind}",
      'data-status={"running"}',
      "input-DOM:data-status",
    ],
    [
      "onClick={() => onInspect(item.id)}",
      "onClick={() => onInspect(reply!.inputId)}",
      "input-DOM:onClick",
    ],
  ] as const)
    rejected(changed("Conversation", before, after), rule);
  rejected(
    changed("Sidebar", "{activitySummary}</small>", '{"0 项进行中"}</small>'),
    "overview-count-DOM",
  );
  rejected(
    changed("Sidebar", "{active.map(row)}", "{threads.map(row)}"),
    "overview-active-rows",
  );
  rejected(
    changed(
      "Sidebar",
      'activityComplete\n                ? "当前没有正在处理的工作"',
      'true\n                ? "当前没有正在处理的工作"',
    ),
    "overview-quiet-quality-DOM",
  );
});
test("presentation ownership rejects additional effect subscriptions, IO and transport imports rather than hiding them in helpers", () => {
  rejected(
    {
      ...sources,
      Owner:
        sources.Owner + '\nexport const diagnostic=fetch("about:blank");\n',
    },
    "pure-owner-no-effect-or-io",
  );
  rejected(
    {
      ...sources,
      Owner:
        sources.Owner +
        "\nexport function subscribe(){setInterval(()=>{},1000);}\n",
    },
    "pure-owner-no-effect-or-io",
  );
  rejected(
    { ...sources, Owner: 'import {useEffect} from "react";\n' + sources.Owner },
    "pure-owner-dependencies",
  );
  rejected(
    {
      ...sources,
      Owner: sources.Owner + "\nexport const unrelated=process.env.X;\n",
    },
    "pure-owner-no-environment-or-global-write",
  );
  rejected(
    {
      ...sources,
      Owner: sources.Owner + '\nglobalThis.threadPresentation="idle";\n',
    },
    "pure-owner-no-environment-or-global-write",
  );
  rejected(
    {
      ...sources,
      Owner: sources.Owner + '\nglobalThis["threadPresentation"]="idle";\n',
    },
    "pure-owner-no-environment-or-global-write",
  );
});
test("unrelated JSX, comments, CSS/type imports and pure exports plus true owner/consumer import aliases remain lawful", () => {
  const allowed: Sources = {
    ...sources,
    Owner:
      'import type { ReactNode } from "react";\n// unrelated annotation\n' +
      sources.Owner +
      "\nexport const unrelatedPure=(value:number)=>value+1;\n",
    Conversation:
      'import "./unrelated.css";\n' +
      sources.Conversation +
      '\nconst unrelatedFooter=<footer data-note="extra">Unrelated</footer>;\n',
    Sidebar: sources.Sidebar + "\nexport const unrelatedSidebarValue=7;\n",
    Core:
      sources.Core +
      "\nexport const unrelatedCorePure=(value:string)=>value.trim();\n",
  };
  validate(allowed);
  allowed.Owner = allowed.Owner.replace(
    "activeExecutionThreads,",
    "activeExecutionThreads as selectActive,",
  )
    .replace("activeExecutionThreads(runtime)", "selectActive(runtime)")
    .replace("inConversation,", "inConversation as matchesConversation,")
    .replace("!inConversation(", "!matchesConversation(");
  allowed.Conversation = allowed.Conversation.replace(
    "import { inputExecutionActivityPresentation }",
    "import { inputExecutionActivityPresentation as presentInput }",
  ).replace("inputExecutionActivityPresentation(\n", "presentInput(\n");
  allowed.Sidebar = allowed.Sidebar.replace(
    "  executionActivityOverview,",
    "  executionActivityOverview as collectOverview,",
  )
    .replace(
      "  executionActivityOverviewSummary,",
      "  executionActivityOverviewSummary as summarizeOverview,",
    )
    .replace("} = executionActivityOverview(", "} = collectOverview(")
    .replace("= executionActivityOverviewSummary(", "= summarizeOverview(");
  validate(allowed);
});

test("core typed ports reject unrelated source and local fake types at the exact rule", () => {
  rejected(
    {
      ...sources,
      Owner:
        sources.Owner.replace("  type Workspace,\n", "") +
        '\nimport type {Workspace} from "./unowned-input.js";\n',
    },
    "typed-core-input:Workspace",
  );
  rejected(
    {
      ...sources,
      Owner:
        sources.Owner.replace(
          "  type Workspace,",
          "  type Workspace as CoreWorkspace,",
        ) + "\ntype Workspace = any;\n",
    },
    "typed-core-input:Workspace",
  );
});
test("true core type-import aliases and local process data parameters remain pure and borrowed", () => {
  const owner =
    sources.Owner.replace(
      "type ConversationRuntime,",
      "type ConversationRuntime as BorrowedRuntime,",
    )
      .replaceAll(": ConversationRuntime", ": BorrowedRuntime")
      .replace("type RecordedInput,", "type RecordedInput as BorrowedInput,")
      .replaceAll("Pick<RecordedInput", "Pick<BorrowedInput")
      .replace("type Workspace,", "type Workspace as BorrowedWorkspace,")
      .replaceAll(": Workspace", ": BorrowedWorkspace")
      .replace(
        "import type { ExecutionScope }",
        "import type { ExecutionScope as BorrowedScope }",
      )
      .replaceAll(": ExecutionScope", ": BorrowedScope") +
    "\nexport const localPure=(process:{value:number})=>process.value+1;\n" +
    "\nexport const localMap=(process:readonly number[])=>process.map(value=>value+1);\n" +
    "\nexport const localGlobalMap=(globalThis:readonly number[])=>globalThis.map(value=>value+1);\n";
  validate({ ...sources, Owner: owner });
});
