import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectBindingPattern,
  isCallExpression,
  isVariableDeclaration,
  isVariableStatement,
  isTryStatement,
  isShorthandPropertyAssignment,
  isPrefixUnaryExpression,
  isPostfixUnaryExpression,
  type Node,
  type Identifier,
} from "typescript/unstable/ast";
import { fixedSubmissionHashes } from "./exchange-submission-9122ad28.js";
export const submissionOwnerText = readFileSync(
  new URL(
    "../../apps/web/src/host/exchange-submission-commands.ts",
    import.meta.url,
  ),
  "utf8",
);
const fixedText = readFileSync(
  new URL("./exchange-submission-9122ad28.ts", import.meta.url),
  "utf8",
);
const ownerPath = "./host/exchange-submission-commands.js";
export function parseSubmission(text: string) {
  const file = "/submission/App.tsx",
    config = "/submission/tsconfig.json";
  const api = new API({
    cwd: "/submission",
    fs: createVirtualFileSystem({
      [file]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: ["App.tsx"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.equal(
      project.program.getSyntacticDiagnostics().length,
      0,
      "valid parsed submission source",
    );
    const source = project.program.getSourceFile(file)!;
    const nodes: Node[] = [],
      names: Identifier[] = [];
    function walk(node: Node) {
      nodes.push(node);
      if (isIdentifier(node)) names.push(node);
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
    const resolved = project.checker.getSymbolAtLocation(names);
    return {
      source,
      nodes,
      symbols: new Map(names.map((node, i) => [node, resolved[i]?.id])),
    };
  } finally {
    snapshot.dispose();
    api.close();
  }
}
export function submissionSyntax(node: Node): unknown {
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
    return [node.kind, node.operator, submissionSyntax(node.operand)];
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(submissionSyntax(child));
  });
  return [
    node.kind,
    node.flags &
      (NodeFlags.Const |
        NodeFlags.Let |
        NodeFlags.Using |
        NodeFlags.OptionalChain),
    children.length ? children : node.getText(),
  ];
}
function oneFunction(parsed: ReturnType<typeof parseSubmission>, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "single function " + name);
  assert.ok(found[0]!.body);
  return found[0]!;
}
export function fixedSubmissionDeclarations() {
  const fixed = parseSubmission(fixedText);
  return Object.fromEntries(
    (["send", "supplement"] as const).map((name) => {
      const value = oneFunction(fixed, name).getText();
      assert.equal(
        createHash("sha256").update(value).digest("hex"),
        fixedSubmissionHashes[name],
        "fixed Git9122 whole algorithm " + name,
      );
      return [name, value];
    }),
  ) as Record<"send" | "supplement", string>;
}
const captureText =
  "function createExchangeSubmissionCommands({ render, client, profile, feedback, dictationControls, drafts: draftPorts, exchange, inspector, onNotice: setNotice, focusAfterSupplement }: ExchangeSubmissionCommandOptions) {\nconst { project, selectedConversation, selectedDraft, draft, sending, uploadingDrafts, contextKey, conversationId, workspace: state, emptyDraft, artifact, activeInstance, browserPage, readingExpected, currentReading, cognitiveSurface, canAuthorizeDirectories, directoryScope, directoryState, rightInspector } = render;\nconst { sendPending, currentContext, setSending, setInputErrors, setRevealedInputs, setAnnotationRefresh } = feedback;\nconst { replace: setDraft, update: updateDraft } = draftPorts;\nconst { setMobileCollaboration, showSentInput, requestSentInputFocus, showInput } = exchange;\nconst { openCollaboration, closeInspector } = inspector;\nreturn { send, supplement };\n}";
export const submissionAppAdapter =
  "const { send, supplement } = createExchangeSubmissionCommands({\nrender: { project, selectedConversation, selectedDraft, draft, sending, uploadingDrafts, contextKey, conversationId, workspace: state, emptyDraft, artifact, activeInstance, browserPage, readingExpected, currentReading, canAuthorizeDirectories, directoryScope, directoryState, rightInspector },\nclient, profile,\nfeedback: { sendPending, currentContext, setSending, setInputErrors, setRevealedInputs, setAnnotationRefresh },\ndictationControls,\ndrafts: { replace: setDraft, update: updateDraft },\nexchange: { setMobileCollaboration, showSentInput, requestSentInputFocus, showInput },\ninspector: { openCollaboration, closeInspector },\nonNotice: setNotice,\nfocusAfterSupplement: () => requestAnimationFrame(() => input.current?.focus({ preventScroll: true })),\n});";
export const cognitiveSubmissionAppAdapter = submissionAppAdapter.replace(
  "currentReading, canAuthorizeDirectories",
  "currentReading, cognitiveSurface, canAuthorizeDirectories",
);
const cognitiveSlotGuard = `function expectedGuard() {
  try {
    guardCognitiveAppInputCommand({ operation: draft });
  } catch {
    setInputErrors((old) => ({ ...old, [contextKey]: "原件引用无效，草稿已保留。" }));
    return;
  }
}`;

export function verifySubmissionCommands(
  text = submissionOwnerText,
  algorithms = true,
  current = false,
) {
  const parsed = parseSubmission(text),
    factory = oneFunction(parsed, "createExchangeSubmissionCommands");
  assert.deepEqual(
    factory.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "synchronous inert submission factory",
  );
  const expected = oneFunction(
    parseSubmission(captureText),
    "createExchangeSubmissionCommands",
  );
  const captures = factory.body!.statements.filter(
    (node) => !isFunctionDeclaration(node),
  );
  assert.deepEqual(
    [factory.parameters.map(submissionSyntax), captures.map(submissionSyntax)],
    [
      expected.parameters.map(submissionSyntax),
      expected.body!.statements.map(submissionSyntax),
    ],
    "exact borrowed captures and direct public commands",
  );
  const runtime = [
    ["../composer-drafts.js", "consumeComposerDraft"],
    ["../application-transport.js", "RequestError"],
    ["./submit-exchange-draft.js", "submitExchangeDraft"],
    [
      "../../../../packages/core/src/cognitive-app-object-locator.js",
      "guardCognitiveAppInputCommand",
    ],
  ];
  const actualRuntime: string[][] = [];
  for (const statement of parsed.source.statements) {
    if (!current)
      assert.ok(
        isImportDeclaration(statement) ||
          statement.kind === SyntaxKind.TypeAliasDeclaration ||
          statement === factory,
        "finite inert submission module",
      );
    if (
      !isImportDeclaration(statement) ||
      statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword
    )
      continue;
    const named = statement.importClause?.namedBindings;
    assert.ok(named && isNamedImports(named), "named runtime dependencies");
    actualRuntime.push([
      statement.moduleSpecifier.getText().slice(1, -1),
      named.elements.map((node) => node.getText()).join(","),
    ]);
  }
  if (!current)
    assert.deepEqual(
      actualRuntime,
      runtime,
      "only existing submission runtime dependencies",
    );
  if (current) {
    for (const [path, name] of runtime) {
      const declarations = parsed.source.statements
        .filter(isImportDeclaration)
        .filter(
          (node) =>
            node.moduleSpecifier.getText().slice(1, -1) === path &&
            node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword,
        );
      const bindings = declarations.flatMap((node) => {
        const named = node.importClause?.namedBindings;
        return named && isNamedImports(named)
          ? named.elements.filter(
              (item) =>
                !item.isTypeOnly &&
                (item.propertyName?.text ?? item.name.text) === name,
            )
          : [];
      });
      assert.equal(bindings.length, 1, "actual submission dependency " + name);
      const id = parsed.symbols.get(bindings[0]!.name);
      assert.ok(id !== undefined);
      for (const node of parsed.nodes
        .filter(isIdentifier)
        .filter(
          (node) =>
            node.text === name &&
            node.getStart() >= factory.getStart() &&
            node.end <= factory.end,
        ))
        assert.equal(
          parsed.symbols.get(node),
          id,
          "called submission dependency " + name,
        );
    }
  }
  const old = fixedSubmissionDeclarations();
  assert.deepEqual(
    factory
      .body!.statements.filter(isFunctionDeclaration)
      .map((node) => node.name?.text),
    ["send", "supplement"],
    "complete two-command owner",
  );
  for (const name of ["send", "supplement"] as const) {
    let source = oneFunction(parsed, name).getText();
    if (name === "send") {
      // Validate the complete finite new guard and single source carry first.
      // Only then remove those exact additions to compare the unchanged
      // complete algorithm with the immutable Git9122 witness.
      const candidate = parseSubmission(source),
        fn = oneFunction(candidate, name);
      const guards = fn.body!.statements.filter(isTryStatement);
      assert.equal(guards.length, 1, "one cognitive own-slot pre-spread guard");
      const expectedGuard = oneFunction(
        parseSubmission(cognitiveSlotGuard),
        "expectedGuard",
      ).body!.statements[0]!;
      assert.deepEqual(
        submissionSyntax(guards[0]!),
        submissionSyntax(expectedGuard),
        "exact cognitive own-slot guard",
      );
      const statements = fn.body!.statements;
      assert.equal(
        statements.indexOf(guards[0]!),
        1,
        "cognitive guard after old admission before original shallow spread",
      );
      const carries = candidate.nodes
        .filter(isShorthandPropertyAssignment)
        .filter(
          (node) =>
            isIdentifier(node.name) && node.name.text === "cognitiveSurface",
        );
      assert.equal(carries.length, 1, "one exact cognitive source carry");
      const submissions = candidate.nodes
        .filter(isCallExpression)
        .filter((node) => node.expression.getText() === "submitExchangeDraft");
      assert.equal(submissions.length, 1);
      assert.ok(
        submissions[0]!.arguments[3]!.getStart() < carries[0]!.getStart() &&
          submissions[0]!.arguments[3]!.end > carries[0]!.end,
        "source only carried in captured submit context",
      );
      assert.equal(
        source[carries[0]!.end],
        ",",
        "source carry has original tuple separator",
      );
      const edits = [
        { start: guards[0]!.getStart(), end: guards[0]!.end },
        { start: carries[0]!.getStart(), end: carries[0]!.end + 1 },
      ];
      for (const edit of edits.sort((a, b) => b.start - a.start))
        source = source.slice(0, edit.start) + source.slice(edit.end);
    }
    if (name === "supplement") {
      assert.equal(
        source.split("focusAfterSupplement();").length,
        2,
        "one deferred DOM focus port",
      );
      source = source.replace(
        "focusAfterSupplement();",
        "requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));",
      );
    }
    if (algorithms)
      assert.deepEqual(
        submissionSyntax(oneFunction(parseSubmission(source), name)),
        submissionSyntax(oneFunction(parseSubmission(old[name]), name)),
        "whole original submission algorithm " + name,
      );
  }
}
function checkedConsumption(
  appText: string,
  ownerText: string,
  algorithms: boolean,
  current = false,
) {
  verifySubmissionCommands(ownerText, algorithms, current);
  const parsed = parseSubmission(appText);
  if (current)
    for (const declaration of parsed.nodes.filter(isVariableDeclaration)) {
      if (
        !isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !isIdentifier(declaration.initializer) ||
        !(declaration.parent.flags & NodeFlags.Const)
      )
        continue;
      const id = parsed.symbols.get(declaration.name),
        value = parsed.symbols.get(declaration.initializer);
      if (id === undefined || value === undefined) continue;
      for (const node of parsed.nodes.filter(isIdentifier))
        if (parsed.symbols.get(node) === id) parsed.symbols.set(node, value);
    }
  const imports = parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) => node.moduleSpecifier.getText().slice(1, -1) === ownerPath,
    );
  assert.equal(imports.length, 1, "one actual submission import");
  const declaration = imports[0]!,
    named = declaration.importClause?.namedBindings;
  assert.ok(named && isNamedImports(named));
  assert.deepEqual(
    named.elements.map((node) => node.propertyName?.text ?? node.name.text),
    ["createExchangeSubmissionCommands"],
    "actual imported submission factory",
  );
  assert.notEqual(
    declaration.importClause?.phaseModifier,
    SyntaxKind.TypeKeyword,
  );
  const binding = parsed.symbols.get(named.elements[0]!.name);
  assert.ok(binding !== undefined);
  const workspace = oneFunction(parsed, "WorkspaceApp");
  const calls = parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        parsed.symbols.get(node.expression) === binding &&
        (!current ||
          (node.getStart() > workspace.getStart() && node.end < workspace.end)),
    );
  assert.equal(calls.length, 1, "one real borrowed submission call");
  const call = calls[0]!;
  assert.ok(
    isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      isObjectBindingPattern(call.parent.name),
    "direct send supplement aliases",
  );
  const statement = call.parent.parent.parent;
  assert.ok(
    isVariableStatement(statement) &&
      statement.parent === workspace.body &&
      statement.declarationList.declarations.length === 1 &&
      statement.declarationList.flags & NodeFlags.Const,
    "render-local submission call",
  );
  const aliases = call.parent.name;
  assert.ok(isObjectBindingPattern(aliases));
  assert.deepEqual(
    aliases.elements.map((node) => node.getText()),
    ["send", "supplement"],
    "two original direct aliases",
  );
  // Two finite literal adapters: historical consumers omit the new optional
  // source; actual current App must borrow its trusted surface explicitly.
  const hasCognitiveSurface = call.arguments[0]
    ?.getText()
    .includes("cognitiveSurface");
  const expected = parseSubmission(
    hasCognitiveSurface ? cognitiveSubmissionAppAdapter : submissionAppAdapter,
  ).nodes.filter(isCallExpression)[0]!;
  assert.equal(call.typeArguments?.length ?? 0, 0, "no submission type bridge");
  assert.equal(call.arguments.length, 1);
  assert.deepEqual(
    submissionSyntax(call.arguments[0]!),
    submissionSyntax(expected.arguments[0]!),
    "exact captured submission ports",
  );
  const siblings = workspace.body!.statements,
    index = siblings.indexOf(statement);
  assert.ok(
    current
      ? index > 0 &&
          siblings.some(
            (node) =>
              node.end <= statement.getStart() &&
              node.getText().includes("} = subjectInspector;"),
          ) &&
          siblings.some(
            (node) =>
              node.getStart() >= statement.end &&
              node.getText().startsWith("const agentName"),
          )
      : index > 0 &&
          isVariableStatement(siblings[index - 1]!) &&
          siblings[index - 1]!.getText().includes("} = subjectInspector;") &&
          isVariableStatement(siblings[index + 1]!) &&
          siblings[index + 1]!.getText().startsWith("const agentName"),
    "late constructor after inspector aliases before agentName",
  );
  for (const alias of aliases.elements) {
    const name = alias.name;
    assert.ok(name && isIdentifier(name));
    const id = parsed.symbols.get(name);
    for (const node of parsed.nodes
      .filter(isCallExpression)
      .map((node) => node.expression)
      .filter(isIdentifier)
      .filter((node) => node.text === name.text))
      assert.equal(
        parsed.symbols.get(node),
        id,
        "actual direct submission consumer " + name.text,
      );
  }
  assert.equal(
    parsed.nodes
      .filter(isFunctionDeclaration)
      .filter(
        (node) =>
          ["send", "supplement"].includes(node.name?.text ?? "") &&
          (!current ||
            (node.getStart() > workspace.getStart() &&
              node.end < workspace.end)),
      ).length,
    0,
    "no old duplicate submission body",
  );
  if (!current)
    assert.equal(
      parsed.nodes
        .filter(isIdentifier)
        .filter((node) => parsed.symbols.get(node) === binding).length,
      2,
      "factory import only directly consumed once",
    );
  return { parsed, statement, declaration };
}
// Finite source contract, not visual/API proof. Validate actual production first;
// restore only this seam for the existing unchanged whole-App hashes/counts.
export function expandSubmissionConsumption(
  appText: string,
  ownerText = submissionOwnerText,
) {
  const { parsed, statement, declaration } = checkedConsumption(
    appText,
    ownerText,
    true,
  );
  const old = fixedSubmissionDeclarations(),
    image = oneFunction(parsed, "importImage");
  const edits = [
    { start: statement.getStart(), end: statement.end, value: "" },
    {
      start: image.getStart(),
      end: image.getStart(),
      value: old.send + "\n" + old.supplement + "\n",
    },
    {
      start: declaration.getStart(),
      end: declaration.end,
      value:
        'import { submitExchangeDraft } from "./host/submit-exchange-draft.js";',
    },
  ];
  const originals = [
    [
      "../../../packages/core/src/model.js",
      'import { spaceKind, inConversation, discussionId, applicationFor } from "../../../packages/core/src/model.js";',
      'import { spaceKind, inConversation, discussionId, applicationFor, type InputDispatchMode } from "../../../packages/core/src/model.js";',
    ],
    [
      "./composer-drafts.js",
      'import { composeArtifactDrafts, replaceComposerSurface, updateComposerDraft } from "./composer-drafts.js";',
      'import { composeArtifactDrafts, consumeComposerDraft, replaceComposerSurface, updateComposerDraft } from "./composer-drafts.js";',
    ],
  ];
  for (const [module, expected, value] of originals) {
    const imports = parsed.source.statements
      .filter(isImportDeclaration)
      .filter(
        (node) => node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword,
      )
      .filter((node) => node.moduleSpecifier.getText().slice(1, -1) === module);
    assert.equal(
      imports.length,
      1,
      "original submission import seam " + module,
    );
    assert.deepEqual(
      submissionSyntax(imports[0]!),
      submissionSyntax(parseSubmission(expected!).source.statements[0]!),
      "only unused submission symbol removed " + module,
    );
    edits.push({
      start: imports[0]!.getStart(),
      end: imports[0]!.end,
      value: value!,
    });
  }
  const desktop = parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) => node.moduleSpecifier.getText().slice(1, -1) === "./desktop.js",
    );
  assert.equal(desktop.length, 1);
  for (const module of [
    "../../../packages/core/src/continuation.js",
    "./application-transport.js",
  ])
    assert.equal(
      parsed.source.statements
        .filter(isImportDeclaration)
        .filter(
          (node) => node.moduleSpecifier.getText().slice(1, -1) === module,
        ).length,
      0,
      "unused import is absent " + module,
    );
  edits.push({
    start: desktop[0]!.getStart(),
    end: desktop[0]!.getStart(),
    value:
      'import type { InputContinuation } from "../../../packages/core/src/continuation.js";\nimport { RequestError } from "./application-transport.js";\n',
  });
  let result = appText;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}
export function verifySubmissionConsumption(
  appText: string,
  ownerText = submissionOwnerText,
) {
  checkedConsumption(appText, ownerText, false);
}

// Raw-current seam only: no inverse, whole-App hash or module inventory.
// Existing expand/verify entry points retain their historical peer semantics.
export function verifyRawSubmissionConsumption(
  appText: string,
  ownerText = submissionOwnerText,
) {
  checkedConsumption(appText, ownerText, true, true);
}
