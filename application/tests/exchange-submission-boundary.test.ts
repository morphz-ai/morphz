import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isArrayLiteralExpression,
  isArrowFunction,
  isAwaitExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isNamedImports,
  isNewExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isTryStatement,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// A finite gate for this submission protocol and its real App callsite only.
// Runtime/Host remain authority, client owns outbox, and App owns preparation
// lock and same-key UI feedback. Traces/browser tests, not this AST gate, prove
// outcomes, async scheduling, React effects or native/visual equivalence.
const oracleText = `
const conditions = [
  !asAnnotation && !captured.continuation && !captured.taskResult && !captured.scriptGeneration && !captured.reading && !captured.selection && !captured.textQuotes?.length && !captured.skipReading && readingExpected,
  !captured.continuation && canAuthorizeDirectories && (directoryState.scope !== directoryScope || !directoryState.ready),
  asAnnotation && (!artifact || !captured.selection || !captured.revision),
  !captured.continuation && (asAnnotation || captured.taskResult) && captured.attachments?.length,
  captured.continuation,
  captured.taskResult && !asAnnotation,
  asAnnotation && artifact && captured.selection && captured.revision
];
const context = {
  projectId: project.id, conversationId, firstConversation, artifact, activeInstance,
  browserPage, readingExpected, currentReading, canAuthorizeDirectories,
  directoryScope, directoryState, capabilities: {
    directedInput: client.boot?.capabilities.directedInput,
    conversationOnFirstInput: client.boot?.capabilities.conversationOnFirstInput,
    runtimeConfigured: client.boot?.runtime.configured,
  }
};
const ports = {
  execute: client.execute,
  profile: { flush: profile.flush, assertCurrentScope: profile.assertCurrentScope },
  isCurrentSurface: () => currentContext.current === key,
  originalInput: (id) => state!.inputs.find((input) => input.id === id),
  persistSupplement: (command) => updateDraft(key, (old) => ({ ...old, pendingSupplement: command, continuationFailure: undefined })),
  onInputStaged,
};
const onInputStaged = (inputId: string) => {
  staged = true;
  updateDraft(key, (current) => consumeComposerDraft(current, emptyDraft));
  setRevealedInputs((old) => ({ ...old, [conversationId]: inputId }));
  if (currentContext.current === key) { setMobileCollaboration(false); showSentInput(key); }
  sendPending.current = false; setSending(false);
};
const onResolved = (result) => {
  if (result.kind === "supplement") setRevealedInputs((old) => ({ ...old, [conversationId]: result.receipt.entityId }));
  else if (result.kind === "annotation") setAnnotationRefresh((value) => value + 1);
  if (!staged) updateDraft(key, (current) => consumeComposerDraft(current, emptyDraft));
  if (!staged && currentContext.current === key) {
    if (asAnnotation) { openCollaboration(); requestSentInputFocus(key); }
    else if (captured.continuation || !captured.taskResult) { setMobileCollaboration(false); showSentInput(key); }
  }
};
const onRejected = (e) => {
  if (staged) return;
  if (captured.continuation) {
    const reason = e instanceof RequestError && e.code === "work_closed" ? "closed"
      : e instanceof RequestError && e.status < 500 && e.status !== 408 ? "changed" : "unknown";
    updateDraft(key, (old) => ({ ...old, continuationFailure: reason, ...(reason !== "unknown" ? { pendingSupplement: undefined } : {}) }));
  }
  setInputErrors((old) => ({ ...old, [key]: e instanceof Error ? e.message : "保存失败，草稿已保留。" }));
};
const onSettled = () => { if (!staged) { sendPending.current = false; setSending(false); } };
const sourceFields = { continuation: captured.continuation, projectId: original.projectId,
  conversationId: discussionId(original), artifactId: original.artifactId,
  artifactRevision: original.artifactRevision, selection: "", body: captured.body,
  targetActantId: original.targetActantId };
function finalCallbacks() {
  try { ports.onResolved(result); } catch (error) { ports.onRejected(error); } finally { ports.onSettled(); }
}
function profileOrder() { await ports.profile.flush(); ports.profile.assertCurrentScope(); if (!ports.isCurrentSurface()) throw new Error("工作范围已切换，草稿已保留，请回到原处发送。"); }
`;
type Parsed = {
  source: SourceFile;
  symbols: Map<Node, number>;
  parents: Map<Node, Node>;
};
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>): Map<string, Parsed> {
  const directory = "/exchange-submission-boundary-fixtures";
  const config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, source]) => [
      `${directory}/${name}`,
      source,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!;
      assert.deepEqual(
        project.program.getSyntacticDiagnostics(),
        [],
        "Invalid fixtures cannot pass",
      );
      return new Map(
        Object.keys(contents).map((name) => {
          const source = project.program.getSourceFile(`${directory}/${name}`)!;
          const names: Identifier[] = [];
          const parents = new Map<Node, Node>();
          walk(source, (node) => {
            if (isIdentifier(node)) names.push(node);
            node.forEachChild((child) => {
              parents.set(child, node);
            });
          });
          const resolved = project.checker.getSymbolAtLocation(names);
          const symbols = new Map<Node, number>();
          names.forEach((node, index) => {
            // A shorthand property has its own property symbol; this protocol
            // needs the lexical value symbol, e.g. the actual awaited receipt.
            const parent = parents.get(node);
            const symbol =
              parent && isShorthandPropertyAssignment(parent)
                ? project.checker.getShorthandAssignmentValueSymbol(parent)
                : resolved[index];
            if (symbol) symbols.set(node, symbol.id);
          });
          return [name, { source, symbols, parents }];
        }),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
function nodes(node: Node | undefined, match: (node: Node) => boolean): Node[] {
  const found: Node[] = [];
  if (node)
    walk(node, (child) => {
      if (match(child)) found.push(child);
    });
  return found;
}
function functions(node: Node, name: string) {
  return nodes(
    node,
    (child) => isFunctionDeclaration(child) && child.name?.text === name,
  ).filter(isFunctionDeclaration);
}
function variable(node: Node, name: string) {
  return nodes(
    node,
    (child) =>
      isVariableDeclaration(child) &&
      isIdentifier(child.name) &&
      child.name.text === name,
  ).filter(isVariableDeclaration);
}
function calls(node: Node | undefined, expression: string) {
  return nodes(
    node,
    (child) =>
      isCallExpression(child) && child.expression.getText() === expression,
  ).filter(isCallExpression);
}
function syntax(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(syntax(child));
  });
  return [node.kind, children.length ? children : node.getText()];
}
function same(left: Node | undefined, right: Node | undefined) {
  return (
    !!left &&
    !!right &&
    JSON.stringify(syntax(left)) === JSON.stringify(syntax(right))
  );
}
function properties(node: Node | undefined) {
  const result = new Map<string, Node>();
  if (node && isObjectLiteralExpression(node))
    for (const prop of node.properties) {
      if (isPropertyAssignment(prop) && isIdentifier(prop.name))
        result.set(prop.name.text, prop.initializer);
      else if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name))
        result.set(prop.name.text, prop.name);
    }
  return result;
}
function operationFields(node: Node | undefined): string[] {
  if (!node || !isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((prop) => {
    if (isPropertyAssignment(prop) || isShorthandPropertyAssignment(prop))
      return [prop.name.getText()];
    if (isSpreadAssignment(prop)) {
      const expr = isParenthesizedExpression(prop.expression)
        ? prop.expression.expression
        : prop.expression;
      if (isConditionalExpression(expr))
        return operationFields(expr.whenTrue).concat(
          operationFields(expr.whenFalse),
        );
    }
    return ["<unreviewed-spread>"];
  });
}
function importedSymbols(parsed: Parsed, path: string) {
  const entries = new Map<string, number>();
  for (const statement of parsed.source.statements) {
    if (
      isImportDeclaration(statement) &&
      isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === path &&
      statement.importClause?.namedBindings &&
      isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const binding of statement.importClause.namedBindings.elements) {
        if (
          binding.isTypeOnly ||
          statement.importClause.phaseModifier === SyntaxKind.TypeKeyword
        )
          continue;
        const symbol = parsed.symbols.get(binding.name);
        if (symbol !== undefined)
          entries.set((binding.propertyName ?? binding.name).text, symbol);
      }
    }
  }
  return entries;
}
function importedCalls(
  parsed: Parsed,
  entries: Map<string, number>,
  name: string,
) {
  return nodes(
    parsed.source,
    (node) =>
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      entries.has(name) &&
      parsed.symbols.get(node.expression) === entries.get(name),
  ).filter(isCallExpression);
}
const oracle = parse({ "oracle.ts": oracleText }).get("oracle.ts")!.source;
const expected = (name: string) => variable(oracle, name)[0]!.initializer!;
const finalCallbacks = functions(
  oracle,
  "finalCallbacks",
)[0]!.body!.statements.filter(isTryStatement)[0]!;
assert.ok(finalCallbacks);
const conditionArray = expected("conditions");
assert.ok(isArrayLiteralExpression(conditionArray));
const expressionOracles = isArrayLiteralExpression(conditionArray)
  ? conditionArray.elements
  : [];

function ownership(
  ownerText: string,
  appText: string,
  modelText: string,
): string[] {
  const parsed = parse({
    "owner.ts": ownerText,
    "App.tsx": appText,
    "model.ts": modelText,
  });
  const owner = parsed.get("owner.ts")!,
    app = parsed.get("App.tsx")!,
    model = parsed.get("model.ts")!;
  const failures = new Set<string>();
  const check = (valid: boolean, rule: string) => {
    if (!valid) failures.add(rule);
  };
  const runtime = new Map([
    ["../../../../packages/core/src/model.js", new Set(["discussionId"])],
    [
      "../../../../packages/core/src/text-quotes.js",
      new Set(["quotedInputText"]),
    ],
  ]);
  const types = new Set([
    ...runtime.keys(),
    "../../../../packages/core/src/local-files.js",
    "../reading-context-model.js",
    "./exchange-drafts.js",
  ]);
  for (const statement of owner.source.statements) {
    check(
      isImportDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isFunctionDeclaration(statement),
      "no-module-store-hooks-or-construction-effects",
    );
    if (!isImportDeclaration(statement)) continue;
    const path = isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : "";
    const clause = statement.importClause,
      bindings = clause?.namedBindings;
    check(
      !!clause && !clause.name && !!bindings && isNamedImports(bindings),
      "explicit-owner-dependencies",
    );
    if (bindings && isNamedImports(bindings))
      for (const entry of bindings.elements) {
        check(
          clause?.phaseModifier === SyntaxKind.TypeKeyword || entry.isTypeOnly
            ? types.has(path)
            : !!runtime.get(path)?.has((entry.propertyName ?? entry.name).text),
          "owner-only-core-runtime-and-pure-type-dependencies",
        );
      }
  }
  for (const statement of model.source.statements) {
    check(
      isTypeAliasDeclaration(statement) ||
        (isImportDeclaration(statement) &&
          isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text ===
            "../../../packages/core/src/reader.js" &&
          statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword),
      "reading-model-is-type-only-not-react-page",
    );
  }
  const submits = functions(owner.source, "submitExchangeDraft");
  const submit = submits[0];
  check(
    submits.length === 1 &&
      nodes(owner.source, isFunctionDeclaration).length === 1 &&
      submit?.modifiers?.some(
        (modifier) => modifier.kind === SyntaxKind.AsyncKeyword,
      ) === true,
    "one-stateless-async-submission-function",
  );
  const statements = submit?.body?.statements;
  const transaction = statements?.find(isTryStatement);
  check(
    !!statements &&
      statements.length === 2 &&
      isVariableStatement(statements[0]!) &&
      !!transaction &&
      statements[1] === transaction,
    "snapshot-unpack-then-one-execution-boundary",
  );
  if (transaction) {
    check(
      same(transaction.catchClause, finalCallbacks.catchClause) &&
        same(transaction.finallyBlock, finalCallbacks.finallyBlock),
      "synchronous-rejected-settled-callbacks-in-owner-boundary",
    );
    check(
      same(
        transaction.tryBlock.statements.at(-1),
        finalCallbacks.tryBlock.statements[0],
      ),
      "resolved-callback-before-return-and-finally",
    );
    const sequence = transaction.tryBlock.statements;
    check(
      sequence.length === 7 && sequence.slice(0, 4).every(isIfStatement),
      "original-preflight-order-before-four-branches",
    );
    for (let index = 0; index < 4; index++) {
      const guard = sequence[index];
      check(
        !!guard &&
          isIfStatement(guard) &&
          same(guard.expression, expressionOracles[index]),
        "reading-directory-annotation-attachment-guards-unchanged",
      );
    }
    const branches: Node[] = [];
    let current: Node | undefined = sequence[5];
    for (let index = 0; index < 3; index++) {
      if (!current || !isIfStatement(current)) break;
      check(
        same(current.expression, expressionOracles[index + 4]),
        "four-exclusive-submission-branches-original-priority",
      );
      branches.push(current.thenStatement);
      current = current.elseStatement;
    }
    if (current) branches.push(current);
    check(
      branches.length === 4 &&
        branches.every(isBlock) &&
        calls(submit, "ports.execute").length === 4,
      "one-execute-per-branch-no-added-command",
    );
    const expectedKinds = ["supplement", "task-result", "annotation", "input"];
    const allowedFields = [
      "type,continuation,projectId,conversationId,artifactId,artifactRevision,selection,body,textQuotes,targetActantId,attachments",
      "type,taskId,expectedRevision,body",
      "type,artifactId,artifactRevision,quote,page,body",
      "type,dispatchMode,model,reasoningEffort,projectId,conversationId,newConversation,application,artifactId,artifactRevision,selection,reading,body,textQuotes,scriptGeneration,directories,attachments,browser,intent,targetActantId",
    ];
    branches.forEach((branch, index) => {
      const execute = calls(branch, "ports.execute");
      check(
        execute.length === 1 &&
          !!owner.parents.get(execute[0]!) &&
          isAwaitExpression(owner.parents.get(execute[0]!)!),
        "each-execute-awaited-in-its-original-branch",
      );
      const result = nodes(
        branch,
        (node) => isBinaryExpression(node) && node.left.getText() === "result",
      ).filter(isBinaryExpression);
      const kind = properties(result[0]?.right).get("kind");
      check(
        result.length === 1 &&
          !!kind &&
          isStringLiteral(kind) &&
          kind.text === expectedKinds[index],
        "branch-result-facts-not-generic-success",
      );
      const receipt = variable(branch, "receipt")[0],
        delivered = properties(result[0]?.right).get("receipt");
      check(
        !!receipt &&
          isIdentifier(receipt.name) &&
          !!receipt.initializer &&
          isAwaitExpression(receipt.initializer) &&
          receipt.initializer.expression === execute[0] &&
          !!delivered &&
          isIdentifier(delivered) &&
          owner.symbols.get(receipt.name) !== undefined &&
          owner.symbols.get(receipt.name) === owner.symbols.get(delivered),
        "only-real-awaited-receipt-delivered-to-feedback",
      );
      const command =
        index === 0 ? variable(branch, "command")[0]?.initializer : undefined;
      const operation =
        command && isBinaryExpression(command)
          ? properties(command.right).get("operation")
          : execute[0]?.arguments[0];
      check(
        operationFields(operation).join(",") === allowedFields[index],
        "exact-operation-field-families-no-supplement-scope-escalation",
      );
      if (index === 0) {
        check(
          !!command &&
            isBinaryExpression(command) &&
            command.operatorToken.kind === SyntaxKind.QuestionQuestionToken &&
            command.left.getText() === "captured.pendingSupplement",
          "pending-command-short-circuit-no-new-retry-identity",
        );
        const actual = properties(operation);
        for (const [name, value] of properties(expected("sourceFields")))
          check(
            same(actual.get(name), value),
            "supplement-uses-original-request-not-current-surface",
          );
        const persist = calls(branch, "ports.persistSupplement");
        check(
          persist.length === 1 &&
            persist[0]!.pos < execute[0]!.pos &&
            persist[0]!.arguments[0]?.getText() === "command" &&
            execute[0]!.arguments.map((arg) => arg.getText()).join(",") ===
              "command.operation,true,undefined,command.commandId",
          "supplement-persist-before-transport-no-staging-unlock",
        );
      } else if (index === 3) {
        const flush = calls(branch, "ports.profile.flush"),
          scope = calls(branch, "ports.profile.assertCurrentScope"),
          surface = calls(branch, "ports.isCurrentSurface");
        check(
          flush.length === 1 &&
            scope.length === 1 &&
            surface.length === 1 &&
            isAwaitExpression(owner.parents.get(flush[0]!)!) &&
            flush[0]!.pos < scope[0]!.pos &&
            scope[0]!.pos < surface[0]!.pos &&
            surface[0]!.pos < execute[0]!.pos &&
            operation!.pos > surface[0]!.pos,
          "normal-profile-flush-assert-current-before-operation-construction",
        );
        const original = functions(oracle, "profileOrder")[0]!.body!.statements;
        if (isBlock(branch))
          check(
            branch.statements
              .slice(1, 4)
              .every((statement, offset) => same(statement, original[offset])),
            "profile-await-and-current-surface-denial-not-ignored",
          );
        check(
          execute[0]!.arguments
            .slice(1)
            .map((arg) => arg.getText())
            .join(",") ===
            "!!capabilities.runtimeConfigured,undefined,firstConversation?.inputId,ports.onInputStaged",
          "new-root-first-input-identity-and-client-staging-port",
        );
      } else
        check(
          execute[0]?.arguments.length === 1,
          "non-input-operation-preserves-default-gateway-options",
        );
    });
    check(
      calls(submit, "ports.profile.flush").length === 1 &&
        calls(submit, "ports.profile.assertCurrentScope").length === 1 &&
        calls(submit, "ports.isCurrentSurface").length === 1,
      "profile-only-for-new-root-not-directed-or-human-write",
    );
  }
  const imports = importedSymbols(
    owner,
    "../../../../packages/core/src/model.js",
  );
  check(
    importedCalls(owner, imports, "discussionId").length === 1 &&
      importedCalls(
        owner,
        importedSymbols(owner, "../../../../packages/core/src/text-quotes.js"),
        "quotedInputText",
      ).length === 2,
    "real-core-helper-imports-not-same-name-local-fakes",
  );
  const allowedCalls = new Set([
    "currentReading?.capture",
    "structuredClone",
    "crypto.randomUUID",
    "discussionId",
    "quotedInputText",
    "ports.originalInput",
    "ports.persistSupplement",
    "ports.execute",
    "ports.profile.flush",
    "ports.profile.assertCurrentScope",
    "ports.isCurrentSurface",
    "ports.onResolved",
    "ports.onRejected",
    "ports.onSettled",
  ]);
  const portsParameter = submit?.parameters[4]?.name;
  const portsSymbol =
    portsParameter && isIdentifier(portsParameter)
      ? owner.symbols.get(portsParameter)
      : undefined;
  walk(owner.source, (node) => {
    if (isCallExpression(node)) {
      check(
        allowedCalls.has(node.expression.getText()),
        "no-direct-transport-storage-react-or-implicit-retry",
      );
      if (node.expression.getText().startsWith("ports."))
        check(
          portsSymbol !== undefined &&
            nodes(
              node.expression,
              (part) => isIdentifier(part) && part.text === "ports",
            ).every((part) => owner.symbols.get(part) === portsSymbol),
          "semantic-ports-use-real-supplied-parameter-not-local-fakes",
        );
    }
    if (isNewExpression(node))
      check(
        isIdentifier(node.expression) && node.expression.text === "Error",
        "owner-no-service-store-or-extra-retry-construction",
      );
    check(
      ![
        SyntaxKind.ForStatement,
        SyntaxKind.ForInStatement,
        SyntaxKind.ForOfStatement,
        SyntaxKind.WhileStatement,
        SyntaxKind.DoStatement,
      ].includes(node.kind),
      "owner-no-implicit-command-retry-loop",
    );
    if (isIdentifier(node))
      check(
        ![
          "window",
          "document",
          "globalThis",
          "localStorage",
          "sessionStorage",
          "setTimeout",
          "setInterval",
          "fetch",
          "latestRef",
        ].includes(node.text),
        "owner-no-dom-outbox-or-latest-global-state",
      );
  });
  const host = functions(app.source, "WorkspaceApp")[0];
  const send = host && functions(host, "send")[0];
  const entries = importedCalls(
    app,
    importedSymbols(app, "./host/submit-exchange-draft.js"),
    "submitExchangeDraft",
  );
  const entry = entries[0];
  check(
    entries.length === 1 &&
      !!send &&
      nodes(send, (node) => node === entry).length === 1,
    "one-real-imported-submission-entry-in-send",
  );
  const entryStatement = entry && app.parents.get(entry),
    lastStatement = send?.body?.statements.at(-1);
  check(
    !!entryStatement &&
      isAwaitExpression(entryStatement) &&
      !!lastStatement &&
      isExpressionStatement(lastStatement) &&
      app.parents.get(entryStatement) === lastStatement &&
      entry?.arguments.length === 5 &&
      entry.arguments
        .slice(0, 3)
        .map((arg) => arg.getText())
        .join(",") === "captured,asAnnotation,dispatchMode",
    "no-ui-cleanup-after-awaiting-submission-owner",
  );
  check(
    same(entry?.arguments[3], expected("context")),
    "captured-render-context-only-no-client-state-setter-bag",
  );
  const suppliedPorts = properties(entry?.arguments[4]);
  // Include the three UI callbacks after the shared ports, with no defaults.
  check(
    [...suppliedPorts.keys()].join(",") ===
      "execute,profile,isCurrentSurface,originalInput,persistSupplement,onInputStaged,onResolved,onRejected,onSettled",
    "complete-named-semantic-ports",
  );
  for (const [name, value] of properties(expected("ports")))
    check(
      same(suppliedPorts.get(name), value),
      "original-gateway-profile-current-key-and-pending-writer-seams",
    );
  for (const name of ["onResolved", "onRejected", "onSettled"]) {
    const callback = suppliedPorts.get(name);
    check(
      !!callback && isArrowFunction(callback) && same(callback, expected(name)),
      "synchronous-original-receipt-error-lock-feedback",
    );
  }
  check(
    !!send &&
      same(
        variable(send, "onInputStaged")[0]?.initializer,
        expected("onInputStaged"),
      ) &&
      variable(send, "staged")[0]?.initializer?.getText() === "false",
    "same-staged-closure-consumes-origin-and-releases-preparation-once",
  );
  check(
    calls(send, "client.execute").length === 0 &&
      calls(send, "profile.flush").length === 0 &&
      calls(send, "quotedInputText").length === 0,
    "app-send-does-not-duplicate-operation-protocol",
  );
  return [...failures];
}
const owner = readFileSync(
  new URL("../apps/web/src/host/submit-exchange-draft.ts", import.meta.url),
  "utf8",
);
const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const model = readFileSync(
  new URL("../apps/web/src/reading-context-model.ts", import.meta.url),
  "utf8",
);
function changed(source: string, before: string, after: string) {
  assert.equal(
    source.split(before).length - 1,
    1,
    `Fixture must change exactly one seam: ${before}`,
  );
  return source.replace(before, after);
}
function reject(
  ownerText: string,
  appText: string,
  rule: string,
  modelText = model,
) {
  assert.ok(
    ownership(ownerText, appText, modelText).includes(rule),
    `Expected designated violation: ${rule}`,
  );
}
test("submission owner uses the real imported seam and preserves finite protocol boundaries", () => {
  assert.deepEqual(ownership(owner, app, model), []);
});
test("submission gate rejects dependency, global state, fake helper and callback boundary bypasses", () => {
  for (const [before, after, rule] of [
    [
      'import type { ReadingSurface } from "../reading-context-model.js";',
      'import { ReadingContext } from "../ReadingContext.js";',
      "owner-only-core-runtime-and-pure-type-dependencies",
    ],
    [
      "  const {\n    projectId,",
      "  localStorage.setItem('saved-input', 'x'); const {\n    projectId,",
      "snapshot-unpack-then-one-execution-boundary",
    ],
    [
      "    ports.onResolved(result);",
      "    await ports.onResolved(result);",
      "resolved-callback-before-return-and-finally",
    ],
    [
      "    ports.onRejected(error);",
      "    queueMicrotask(() => ports.onRejected(error));",
      "synchronous-rejected-settled-callbacks-in-owner-boundary",
    ],
    [
      "    ports.onSettled();",
      "",
      "synchronous-rejected-settled-callbacks-in-owner-boundary",
    ],
    [
      "    let result: ExchangeSubmissionResult;",
      "    const discussionId = () => 'other'; let result: ExchangeSubmissionResult;",
      "real-core-helper-imports-not-same-name-local-fakes",
    ],
    [
      "      const focus = currentReading?.capture();",
      "      new Map(); const focus = currentReading?.capture();",
      "owner-no-service-store-or-extra-retry-construction",
    ],
    [
      "      const original = ports.originalInput(captured.continuation.inputId);",
      "      const ports = { execute: async () => ({}) }; const original = ports.originalInput(captured.continuation.inputId);",
      "semantic-ports-use-real-supplied-parameter-not-local-fakes",
    ],
    [
      '      result = { kind: "annotation", receipt };',
      '      result = { kind: "annotation", receipt: { entityId: "made-up" } };',
      "only-real-awaited-receipt-delivered-to-feedback",
    ],
    [
      "      const receipt = await ports.execute(\n        command.operation,\n        true,\n        undefined,\n        command.commandId,\n      );",
      "      while (true) { const receipt = await ports.execute(\n        command.operation,\n        true,\n        undefined,\n        command.commandId,\n      ); }",
      "owner-no-implicit-command-retry-loop",
    ],
  ])
    reject(changed(owner, before!, after!), app, rule!);
  reject(
    owner + "\nconst latestRef = { current: null };",
    app,
    "no-module-store-hooks-or-construction-effects",
  );
  reject(
    owner,
    app,
    "reading-model-is-type-only-not-react-page",
    model + "\nimport { useState } from 'react';",
  );
});
test("submission gate rejects branch order, Profile ordering and frozen supplement violations", () => {
  for (const [before, after, rule] of [
    [
      "    if (captured.continuation) {",
      "    if (captured.taskResult) {",
      "four-exclusive-submission-branches-original-priority",
    ],
    [
      "      await ports.profile.flush();\n      ports.profile.assertCurrentScope();",
      "      ports.profile.assertCurrentScope();\n      await ports.profile.flush();",
      "normal-profile-flush-assert-current-before-operation-construction",
    ],
    [
      "      await ports.profile.flush();",
      "      void ports.profile.flush();",
      "normal-profile-flush-assert-current-before-operation-construction",
    ],
    [
      "      if (!ports.isCurrentSurface())",
      "      if (false && !ports.isCurrentSurface())",
      "profile-await-and-current-surface-denial-not-ignored",
    ],
    [
      "captured.pendingSupplement ??",
      "captured.pendingSupplement ||",
      "pending-command-short-circuit-no-new-retry-identity",
    ],
    [
      "          projectId: original.projectId,",
      "          projectId,",
      "supplement-uses-original-request-not-current-surface",
    ],
    [
      "          continuation: captured.continuation,",
      "          continuation: captured.continuation, model: captured.model,",
      "exact-operation-field-families-no-supplement-scope-escalation",
    ],
    [
      "        command.commandId,",
      "        crypto.randomUUID(),",
      "supplement-persist-before-transport-no-staging-unlock",
    ],
    [
      "      ports.persistSupplement(command);",
      "",
      "supplement-persist-before-transport-no-staging-unlock",
    ],
    [
      "        ports.onInputStaged,",
      "        undefined,",
      "new-root-first-input-identity-and-client-staging-port",
    ],
  ])
    reject(changed(owner, before!, after!), app, rule!);
});
test("submission gate rejects fake App imports, context escape and changed UI feedback seams", () => {
  for (const [before, after, rule] of [
    [
      "    await submitExchangeDraft(",
      "    const submitExchangeDraft = async () => {}; await submitExchangeDraft(",
      "one-real-imported-submission-entry-in-send",
    ],
    [
      "        projectId: project.id,\n        conversationId,\n        firstConversation,",
      "        projectId: project.id,\n        conversationId,\n        firstConversation, client,",
      "captured-render-context-only-no-client-state-setter-bag",
    ],
    [
      "        onInputStaged,\n        onResolved:",
      "        onInputStaged, setSending,\n        onResolved:",
      "complete-named-semantic-ports",
    ],
    [
      "        onResolved: (result) => {",
      "        onResolved: async (result) => {",
      "synchronous-original-receipt-error-lock-feedback",
    ],
    [
      "        isCurrentSurface: () => currentContext.current === key,",
      "        isCurrentSurface: () => true,",
      "original-gateway-profile-current-key-and-pending-writer-seams",
    ],
    [
      "      staged = true;",
      "      staged = false;",
      "same-staged-closure-consumes-origin-and-releases-preparation-once",
    ],
    [
      "          if (staged) return;",
      "          if (false) return;",
      "synchronous-original-receipt-error-lock-feedback",
    ],
    [
      "        execute: client.execute,",
      "        execute: async () => ({ entityId: 'made-up' }),",
      "original-gateway-profile-current-key-and-pending-writer-seams",
    ],
  ])
    reject(owner, changed(app, before!, after!), rule!);
});
test("submission gate permits formatting and unrelated UI owners outside the migrated protocol", () => {
  assert.deepEqual(
    ownership(
      owner.replaceAll("  ", "    "),
      app +
        "\nfunction unrelated() { const state = useState(false); return state; }",
      model,
    ),
    [],
  );
});
