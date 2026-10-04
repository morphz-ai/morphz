import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyExchangeReferencePreparationConsumption } from "./fixtures/exchange-reference-preparation-consumption.js";
import { referenceGovernanceHistory } from "./fixtures/exchange-reference-governance-history.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectBindingPattern,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
} from "typescript/unstable/ast";
import {
  referenceMethods,
  verifyFixedReference,
  verifyReferenceOwner,
} from "./fixtures/exchange-reference-contract.js";
import {
  referenceConsumptionAdapter,
  referenceConsumptionBaseline,
  referenceOriginalImports,
} from "./fixtures/exchange-reference-consumption-b5f698dd.js";

// Immutable actual Git source retains all original whole-tree assertions and
// twenty-six counterfactuals. It is not an inverse of today's App or an ordinary
// current whole-App contract. Current consumption is checked separately below.
const app = referenceGovernanceHistory.consumptionApp;
const owner = referenceGovernanceHistory.owner;
const currentApp = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const currentOwner = readFileSync(
  new URL(
    "../apps/web/src/host/exchange-reference-commands.ts",
    import.meta.url,
  ),
  "utf8",
);
const fixed = readFileSync(
  new URL("./fixtures/exchange-reference-39cf13cf.ts", import.meta.url),
  "utf8",
);
const ownerPath = "./host/exchange-reference-commands.js";
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
function parse(text: string) {
  const file = "/reference-consumption/App.tsx";
  const config = "/reference-consumption/tsconfig.json";
  const api = new API({
    cwd: "/reference-consumption",
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
      "valid parsed source",
    );
    const source = project.program.getSourceFile(file)!;
    const nodes: Node[] = [],
      identifiers: Identifier[] = [];
    walk(source, (node) => {
      nodes.push(node);
      if (isIdentifier(node)) identifiers.push(node);
    });
    const resolved = project.checker.getSymbolAtLocation(identifiers);
    return {
      source,
      nodes,
      symbols: new Map(
        identifiers.map((node, index) => [node, resolved[index]?.id]),
      ),
    };
  } finally {
    snapshot.dispose();
    api.close();
  }
}
type Parsed = ReturnType<typeof parse>;
function syntax(node: Node): unknown {
  // These grammar scalars are not all forEachChild children. Do not equate
  // const/let, optional chaining or !!/~~ by silently dropping them.
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
    return [node.kind, node.operator, syntax(node.operand)];
  const flags =
    node.flags &
    (NodeFlags.Let |
      NodeFlags.Const |
      NodeFlags.Using |
      NodeFlags.OptionalChain);
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(syntax(child));
  });
  return [node.kind, flags, children.length ? children : node.getText()];
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function oneFunction(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "one original function " + name);
  assert.ok(found[0]!.body);
  return found[0]!;
}
function oneVariable(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, "one original binding " + name);
  return found[0]!;
}
function imported(parsed: Parsed, path: string, name: string) {
  const imports = parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === path,
    );
  assert.equal(imports.length, 1, "one actual import " + name);
  const node = imports[0]!;
  const clause = node.importClause;
  assert.ok(
    clause &&
      clause.phaseModifier !== SyntaxKind.TypeKeyword &&
      clause.namedBindings &&
      isNamedImports(clause.namedBindings),
    "actual runtime import " + name,
  );
  const members = clause.namedBindings.elements.filter(
    (item) =>
      !item.isTypeOnly && (item.propertyName ?? item.name).text === name,
  );
  assert.equal(members.length, 1, "actual runtime import " + name);
  const binding = parsed.symbols.get(members[0]!.name);
  assert.ok(binding !== undefined, "resolved import binding " + name);
  return { node, local: members[0]!.name.text, binding };
}
function metrics(parsed: Parsed) {
  const hooks = new Map<unknown, string>();
  for (const node of parsed.source.statements.filter(isImportDeclaration)) {
    if (
      !isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "react" ||
      !node.importClause?.namedBindings ||
      !isNamedImports(node.importClause.namedBindings)
    )
      continue;
    for (const item of node.importClause.namedBindings.elements) {
      const name = (item.propertyName ?? item.name).text;
      if (/^use[A-Z]/.test(name))
        hooks.set(parsed.symbols.get(item.name), name);
    }
  }
  const calls = parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        hooks.has(parsed.symbols.get(node.expression)),
    );
  return {
    tree: digest(syntax(parsed.source)),
    nodes: parsed.nodes.length,
    jsxNodes: parsed.nodes.filter(
      (node) =>
        isJsxElement(node) ||
        isJsxFragment(node) ||
        isJsxSelfClosingElement(node),
    ).length,
    hooks: calls.length,
    effects: calls.filter(
      (node) =>
        isIdentifier(node.expression) &&
        ["useEffect", "useLayoutEffect"].includes(
          hooks.get(parsed.symbols.get(node.expression))!,
        ),
    ).length,
  };
}

function validate(text: string, ownerText = owner) {
  // Validate actual complete algorithms BEFORE allowing any finite App expansion.
  const ownerParsed = parse(ownerText);
  const ownerFactory = oneFunction(
    ownerParsed,
    "createExchangeReferenceCommands",
  );
  assert.ok(
    ownerParsed.source.statements.every(
      (node) =>
        node === ownerFactory ||
        isImportDeclaration(node) ||
        isTypeAliasDeclaration(node),
    ),
    "single inert reference module inventory",
  );
  assert.deepEqual(
    ownerFactory.modifiers?.map((node) => node.kind),
    [SyntaxKind.ExportKeyword],
    "synchronous reference factory",
  );
  const capture = ownerFactory.body!.statements.filter((node) => {
    if (isFunctionDeclaration(node)) {
      assert.ok(
        ["openTextQuote", "composeContent", "composeIntent"].includes(
          node.name?.text ?? "",
        ),
        "reviewed reference command inventory",
      );
      return false;
    }
    return (
      !isVariableStatement(node) ||
      !node.declarationList.declarations.some(
        (declaration) =>
          isIdentifier(declaration.name) &&
          declaration.name.text === "composeReading",
      )
    );
  });
  assert.equal(
    digest([ownerFactory.parameters.map(syntax), capture.map(syntax)]),
    referenceConsumptionBaseline.ownerCapture,
    "fixed reference capture/direct return",
  );
  verifyReferenceOwner(ownerText, fixed);
  const old = verifyFixedReference(fixed);
  const parsed = parse(text);
  const factory = imported(
    parsed,
    ownerPath,
    "createExchangeReferenceCommands",
  );
  const calls = parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        isIdentifier(node.expression) &&
        parsed.symbols.get(node.expression) === factory.binding,
    );
  assert.equal(calls.length, 1, "one actual reference owner call");
  const call = calls[0]!;
  assert.ok(
    isVariableDeclaration(call.parent) &&
      call.parent.initializer === call &&
      isObjectBindingPattern(call.parent.name),
    "direct reference command aliases",
  );
  const declaration = call.parent;
  const statement = declaration.parent.parent;
  const workspace = oneFunction(parsed, "WorkspaceApp");
  assert.ok(
    isVariableStatement(statement) &&
      statement.parent === workspace.body &&
      statement.declarationList.declarations.length === 1 &&
      !!(statement.declarationList.flags & NodeFlags.Const),
    "unconditional render-local reference registration",
  );
  const aliases = declaration.name;
  assert.ok(
    isObjectBindingPattern(aliases),
    "direct reference command binding",
  );
  assert.deepEqual(
    aliases.elements.map((item) => item.getText()),
    referenceMethods,
    "four original direct aliases",
  );
  const adapter = parse(referenceConsumptionAdapter);
  const adapterCall = adapter.nodes.filter(isCallExpression)[0]!;
  assert.equal(
    call.typeArguments?.length ?? 0,
    0,
    "no reference factory type bridge",
  );
  assert.equal(call.arguments.length, 1, "one reference capture argument");
  assert.deepEqual(
    syntax(call.arguments[0]!),
    syntax(adapterCall.arguments[0]!),
    "exact original captured reference ports",
  );
  for (const item of aliases.elements) {
    const name = item.name;
    assert.ok(name && isIdentifier(name), "direct command identifier");
    const binding = parsed.symbols.get(name);
    assert.ok(binding !== undefined, "resolved command alias");
    for (const identifier of parsed.nodes
      .filter(isIdentifier)
      .filter((node) => node.text === name.text))
      assert.equal(
        parsed.symbols.get(identifier),
        binding,
        "no shadowed reference consumer " + name.text,
      );
  }
  // No call/alias normalization touches JSX. Whole-tree restoration below only
  // replaces the checked declaration, the two exact now-unused type imports and
  // reinserts the fixed old declarations at their original anchors.
  const edits: { start: number; end: number; value: string }[] = [
    { start: factory.node.getStart(), end: factory.node.end, value: "" },
    {
      start: statement.getStart(),
      end: statement.end,
      value: old.openTextQuote + "\n" + old.composeContent,
    },
  ];
  for (const [path, original] of Object.entries(referenceOriginalImports)) {
    const name = path === "./Reader.js" ? "Reader" : "inputIntents";
    const current = imported(parsed, path, name);
    const expected = parse(
      path === "./Reader.js"
        ? 'import { Reader } from "./Reader.js";'
        : 'import { inputIntents } from "../../../packages/core/src/input-intent.js";',
    ).source.statements[0]!;
    assert.deepEqual(
      syntax(current.node),
      syntax(expected),
      "only removed unused reference type " + name,
    );
    edits.push({
      start: current.node.getStart(),
      end: current.node.end,
      value: original,
    });
  }
  const script = oneFunction(parsed, "openScript"),
    close = oneVariable(parsed, "closeSpeech");
  assert.equal(
    script.parent,
    workspace.body,
    "original reading restore anchor",
  );
  assert.ok(
    isVariableStatement(close.parent.parent) &&
      close.parent.parent.parent === workspace.body,
    "original intent restore anchor",
  );
  edits.push({
    start: script.getStart(),
    end: script.getStart(),
    value: "const " + old.composeReading + ";\n",
  });
  edits.push({
    start: close.parent.parent.getStart(),
    end: close.parent.parent.getStart(),
    value: old.composeIntent + "\n",
  });
  let restored = text;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    restored =
      restored.slice(0, edit.start) + edit.value + restored.slice(edit.end);
  const actual = metrics(parse(restored));
  const {
    sourceSha256: _source,
    ownerCapture: _owner,
    ...baseline
  } = referenceConsumptionBaseline;
  assert.deepEqual(
    actual,
    baseline,
    "fixed complete b5f698dd App tree/lifecycle/JSX",
  );
}

test("immutable historical App retains the complete original tree and reference proof", () => {
  validate(app);
});

test("raw current App borrows the real eight-command owner without whole-App inverse or inventory", () => {
  const actual = verifyExchangeReferencePreparationConsumption(
    currentApp,
    currentOwner,
  );
  assert.deepEqual(actual.methods, [
    ...referenceMethods,
    "prepareSearchQuote",
    "selectArtifactQuote",
    "changeTextQuotes",
    "focusCommentComposer",
  ]);
  for (const [key, value] of [
    ["baseline", referenceGovernanceHistory.baselineApp],
    ["consumption", app],
    ["owner", owner],
  ] as const)
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      referenceGovernanceHistory.metadata[key].sha256,
      "immutable actual Git reference history " + key,
    );
});

test("current reference consumption permits actually consumed independent React features and actual import/command aliases", () => {
  const independent = `\nfunction IndependentReferenceFeature(){ const [value,setValue]=useState(0);useEffect(()=>setValue(v=>v+1),[]);return <aside>{value}</aside>; }\n`;
  // This new feature has an actual JSX consumer, not an unused helper.
  // This is a parsed source contract, not mounted React execution.
  const withFeature =
    currentApp
      .replace(
        "        <SearchDocuments",
        "        <><IndependentReferenceFeature /><IndependentOwnerFeature /><SearchDocuments",
      )
      .replace(
        "          onQuote={prepareSearchQuote}\n        />",
        "          onQuote={prepareSearchQuote}\n        /></>",
      ) + independent;
  assert.notEqual(withFeature, currentApp);
  verifyExchangeReferencePreparationConsumption(
    'import {IndependentOwnerFeature} from "./host/exchange-reference-commands.js";\n' +
      withFeature,
    currentOwner +
      `\nexport function IndependentOwnerFeature(){const [value,setValue]=useState(0);useEffect(()=>setValue(v=>v+1),[]);return value;}\n`,
  );
  const alias = currentApp
    .replace(
      "  createExchangeReferenceCommands,",
      "  createExchangeReferenceCommands as referenceCommands,",
    )
    .replace("} = createExchangeReferenceCommands({", "} = referenceCommands({")
    .replace(
      "    prepareSearchQuote,\n    selectArtifactQuote,",
      "    prepareSearchQuote: quoteFromSearch,\n    selectArtifactQuote,",
    )
    .replace("onQuote={prepareSearchQuote}", "onQuote={quoteFromSearch}");
  verifyExchangeReferencePreparationConsumption(alias, currentOwner);
  const constAliases = currentApp
    .replace(
      "  const state = client.boot?.workspace;",
      "  const referenceFactory = createExchangeReferenceCommands;\n  const state = client.boot?.workspace;",
    )
    .replace("} = createExchangeReferenceCommands({", "} = referenceFactory({")
    .replace(
      "  function readingTargetConsumed(requestId: string) {",
      "  const searchQuote = prepareSearchQuote;\n  const contentQuote = composeContent;\n  function readingTargetConsumed(requestId: string) {",
    )
    .replace("onQuote={prepareSearchQuote}", "onQuote={searchQuote}")
    .replace("onCompose={composeContent}", "onCompose={contentQuote}");
  verifyExchangeReferencePreparationConsumption(constAliases, currentOwner);
});

test("current borrowed modules runtime phases and returned command origins reject foreign nominal lookalikes", () => {
  const variants: [string, string, RegExp][] = [
    [
      "foreign called controller",
      currentApp.replace(
        '} from "./host/use-exchange-controller.js";',
        '} from "./host/foreign-controller.js";',
      ),
      /reference called borrowed factory origin useExchangeController/,
    ],
    [
      "foreign called draft factory",
      currentApp.replace(
        '} from "./host/exchange-drafts.js";',
        '} from "./host/foreign-drafts.js";',
      ),
      /reference called borrowed factory origin createExchangeDraftCommands/,
    ],
    [
      "unused actual controller import",
      'import {useExchangeController as actualController} from "./host/use-exchange-controller.js";\n' +
        currentApp.replace(
          '} from "./host/use-exchange-controller.js";',
          '} from "./host/foreign-controller.js";',
        ),
      /reference called borrowed factory origin useExchangeController/,
    ],
    [
      "unused actual draft import",
      'import {createExchangeDraftCommands as actualDrafts} from "./host/exchange-drafts.js";\n' +
        currentApp.replace(
          '} from "./host/exchange-drafts.js";',
          '} from "./host/foreign-drafts.js";',
        ),
      /reference called borrowed factory origin createExchangeDraftCommands/,
    ],
    [
      "type-only controller",
      currentApp.replace(
        "  useExchangeController,\n",
        "  type useExchangeController,\n",
      ),
      /reference called borrowed factory origin useExchangeController/,
    ],
    [
      "type-only draft factory",
      currentApp.replace(
        "  createExchangeDraftCommands,\n",
        "  type createExchangeDraftCommands,\n",
      ),
      /reference called borrowed factory origin createExchangeDraftCommands/,
    ],
    [
      "unused returned search command",
      'import {prepareSearchQuote as foreignQuote} from "./host/foreign-quote.js";\n' +
        currentApp.replace(
          "onQuote={prepareSearchQuote}",
          "onQuote={foreignQuote}",
        ),
      /direct actual preparation consumer prepareSearchQuote/,
    ],
    [
      "unused returned content command",
      'import {composeContent as foreignContent} from "./host/foreign-content.js";\n' +
        currentApp.replace(
          "onCompose={composeContent}",
          "onCompose={foreignContent}",
        ),
      /reference original direct consumer composeContent/,
    ],
  ];
  for (const [label, variant, rule] of variants) {
    assert.notEqual(variant, currentApp, label);
    parse(variant);
    assert.throws(
      () =>
        verifyExchangeReferencePreparationConsumption(variant, currentOwner),
      rule,
      label,
    );
  }
});

test("current handoff rejects actual reference authority phase command identity and lifecycle deltas for finite named rules", () => {
  function rejects(
    before: string,
    after: string,
    rule: RegExp,
    module = false,
  ) {
    const source = module ? currentOwner : currentApp;
    const factory = module ? "" : parseReferencePreparationForCurrent(source);
    const target = factory.includes(before) ? factory : source;
    assert.equal(
      target.split(before).length - 1,
      1,
      "exact current handoff target " + before,
    );
    const changed = source.replace(target, target.replace(before, after));
    parse(changed);
    assert.throws(
      () =>
        verifyExchangeReferencePreparationConsumption(
          module ? currentApp : changed,
          module ? changed : currentOwner,
        ),
      rule,
    );
  }
  for (const [before, after, rule] of [
    [
      ownerPath,
      "./host/not-the-reference-owner.js",
      /one actual reference owner import/,
    ],
    [
      "  createExchangeReferenceCommands,",
      "  type createExchangeReferenceCommands,",
      /one actual reference owner import/,
    ],
    [
      "    workspace: state,",
      "    workspace: {artifacts:state?.artifacts??[]},",
      /complete preparation captured render fields/,
    ],
    [
      "      conversationId,\n      contextKey,",
      "      conversationId: conversationProjectId,\n      contextKey,",
      /complete preparation captured render fields/,
    ],
    [
      "drafts: { replace: setDraft, update: updateDraft }",
      "drafts: {replace:setDraft,update:(key,change)=>updateDraft(key,change)}",
      /complete preparation captured render fields/,
    ],
    [
      "      requestConversationFocus,\n      scheduleSearchQuoteFocus:",
      "      requestConversationFocus: requestSentInputFocus,\n      scheduleSearchQuoteFocus:",
      /complete preparation captured render fields/,
    ],
    [
      "clearSelection: () => window.getSelection()?.removeAllRanges()",
      "clearSelection: () => window.getSelection()?.empty()",
      /complete preparation captured render fields/,
    ],
    [
      "    onNotice: setNotice,\n  });\n  function readingTargetConsumed",
      "    onNotice: (message)=>setNotice(message),\n  });\n  function readingTargetConsumed",
      /complete preparation captured render fields/,
    ],
    [
      "onReadingCompose: composeReading,",
      "onReadingCompose: (...args)=>composeReading(...args),",
      /reference original direct consumer/,
    ],
    [
      "onOpenQuote={(quote) => void openTextQuote(quote)}",
      "onOpenQuote={(quote)=>{if(sending)return;void openTextQuote(quote);}}",
      /reference original void quote consumer/,
    ],
    [
      "onCompose={composeContent}",
      "onCompose={composeIntent}",
      /reference original direct consumer/,
    ],
    [
      "onCompose={composeContent}",
      'onCompose={composeContent} key="new-mount"',
      /reference original compose consumer identity/,
    ],
    [
      "function setDraft(key: string, value: InputDraft) {\n    if (!origin.isActive()) return;",
      "function setDraft(key: string, value: InputDraft) {",
      /reference borrowed live binding setDraft/,
    ],
  ] as const) {
    rejects(before, after, rule);
  }
  const factory = parseReferencePreparationForCurrent(currentApp);
  for (const [value, rule] of [
    [
      "if (state) { " + factory + " }",
      /inert preparation factory original unconditional Host slot/,
    ],
    [
      factory.replace(/^const /, "let "),
      /inert preparation factory original unconditional Host slot/,
    ],
    [
      factory
        .replace(
          "createExchangeReferenceCommands({",
          "Promise.resolve(createExchangeReferenceCommands({",
        )
        .replace(/\}\);$/, "}));"),
      /eight same-name direct preparation aliases no Promise bridge/,
    ],
    [
      factory.replace(
        "    composeReading,",
        "    composeReading: wrongReading,",
      ),
      /reference original direct consumer/,
    ],
    [
      factory + "\ncreateExchangeReferenceCommands({} as never);",
      /real imported preparation factory not shadowed/,
    ],
  ] as const) {
    const variant = currentApp.replace(factory, value);
    parse(variant);
    assert.throws(
      () =>
        verifyExchangeReferencePreparationConsumption(variant, currentOwner),
      rule,
    );
  }
  rejects(
    "  } = render;",
    "  } = {...render};",
    /inert preparation construction exact borrowed captures/,
    true,
  );
  rejects(
    "old.body.trim() ||",
    "false ||",
    /original reference algorithm composeReading/,
    true,
  );
  rejects(
    "export function createExchangeReferenceCommands",
    "export async function createExchangeReferenceCommands",
    /synchronous reference factory/,
    true,
  );
  rejects(
    "  async function openTextQuote",
    "  function structuredClone(value){return value;}\n  async function openTextQuote",
    /reference-called-clone-origin/,
    true,
  );
  rejects(
    "useEffect(() => setQuoteReveal(null), [conversationId]);",
    "useEffect(() => setQuoteReveal(null), [contextKey]);",
    /complete original preparation hook recipe/,
    true,
  );
  rejects(
    "  const state = client.boot?.workspace;",
    "  const createExchangeDraftCommands=(_ports:unknown)=>({});\n  const state = client.boot?.workspace;",
    /reference called borrowed factory origin/,
  );
});

function parseReferencePreparationForCurrent(text: string) {
  const parsed = parse(text);
  const call = parsed.nodes
    .filter(isCallExpression)
    .find((c) => c.expression.getText() === "createExchangeReferenceCommands");
  assert(call && isVariableDeclaration(call.parent));
  return call.parent.parent.parent.getText();
}

test("current Reference commands keep their true builtin borrow and generic Host ports", () => {
  const builtin = readFileSync(
    new URL(
      "../apps/web/src/host/builtin-application-adapters.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const host = readFileSync(
    new URL("../apps/web/src/ApplicationHost.tsx", import.meta.url),
    "utf8",
  );
  const integration = { builtin, host };
  const aliasApp = currentApp
    .replace(
      "  createBuiltinApplicationAdapters,",
      "  createBuiltinApplicationAdapters as builtinFactory,",
    )
    .replace(
      "  const builtinApplications = createBuiltinApplicationAdapters({",
      "  const capturedBuiltinFactory = builtinFactory;\n  const builtinApplications = capturedBuiltinFactory({",
    )
    .replace(
      "import { ApplicationHost }",
      "import { ApplicationHost as GenericHost }",
    )
    .replace("<ApplicationHost\n", "<GenericHost\n")
    .replace("</ApplicationHost>", "</GenericHost>");
  assert.notEqual(aliasApp, currentApp, "actual called builtin import alias");
  const aliasBuiltin = builtin
    .replace(
      "import { Reader, type ReadingCompose }",
      "import { Reader as BookReader, type ReadingCompose }",
    )
    .replace("      <Reader\n", "      <BookReader\n")
    .replace("  onReadingCompose,\n", "  onReadingCompose: readQuote,\n")
    .replace("onCompose={onReadingCompose}", "onCompose={readQuote}")
    .replace("  onComposeIntent,\n", "  onComposeIntent: prepareIntent,\n")
    .replace(
      '() => onComposeIntent("script")',
      '() => prepareIntent("script")',
    );
  const aliasHost = host
    .replace("  renderBuiltin,\n", "  renderBuiltin: trustedRenderer,\n")
    .replace(
      "              renderBuiltin({",
      "              trustedRenderer({",
    );
  assert.notEqual(
    aliasBuiltin,
    builtin,
    "real builtin leaf and captured-port aliases",
  );
  parse(aliasApp);
  parse(aliasBuiltin);
  parse(aliasHost);
  verifyExchangeReferencePreparationConsumption(aliasApp, currentOwner, {
    builtin: aliasBuiltin,
    host: aliasHost,
  });

  const cases: [
    string,
    "app" | "builtin" | "host",
    string,
    string,
    RegExp,
    string?,
  ][] = [
    [
      "foreign called factory with unused correct import",
      "app",
      '} from "./host/builtin-application-adapters.js";',
      '} from "./host/foreign-builtin-adapters.js";',
      /reference actual builtin factory value origin/,
      'import {createBuiltinApplicationAdapters as unusedActualBuiltin} from "./host/builtin-application-adapters.js";\n',
    ],
    [
      "type-only called builtin",
      "app",
      "  createBuiltinApplicationAdapters,",
      "  type createBuiltinApplicationAdapters,",
      /reference actual builtin factory value origin/,
    ],
    [
      "duplicate compose borrow",
      "app",
      "    onReadingCompose: composeReading,",
      "    onReadingCompose: composeReading,\n    onReadingCompose: composeReading,",
      /reference original direct consumer onReadingCompose/,
    ],
    [
      "unused correct Reader with foreign consumed",
      "builtin",
      "      <Reader\n",
      "      <ForeignReader\n",
      /reference actual builtin leaf value consumer Reader/,
      'import {Reader as ForeignReader} from "../foreign-reader.js";\n',
    ],
    [
      "Reader leaf bridge",
      "builtin",
      "onCompose={onReadingCompose}",
      "onCompose={(...args)=>onReadingCompose(...args)}",
      /reference original direct consumer composeReading onReadingCompose/,
    ],
    [
      "different Script intent",
      "builtin",
      'onConceive={() => onComposeIntent("script")}',
      'onConceive={() => onComposeIntent("website")}',
      /reference original direct consumer composeIntent onComposeIntent/,
    ],
    [
      "wrapper public renderer",
      "app",
      "renderBuiltin={builtinApplications.renderBuiltin}",
      "renderBuiltin={(surface)=>builtinApplications.renderBuiltin(surface)}",
      /reference actual direct builtin renderer consumption/,
    ],
    [
      "unused actual Host renderer",
      "host",
      "              renderBuiltin({",
      "              fakeBuiltinRenderer({",
      /reference actual generic Host renderer invocation/,
      "function fakeBuiltinRenderer(_surface:unknown){return null;}\n",
    ],
  ];
  for (const [label, target, before, after, rule, prefix = ""] of cases) {
    const source = target === "app" ? currentApp : integration[target];
    assert.equal(
      source.split(before).length - 1,
      1,
      "exact current builtin target " + label,
    );
    const changed = prefix + source.replace(before, after);
    parse(changed);
    assert.throws(
      () =>
        verifyExchangeReferencePreparationConsumption(
          target === "app" ? changed : currentApp,
          currentOwner,
          {
            ...integration,
            ...(target === "app" ? {} : { [target]: changed }),
          },
        ),
      rule,
      label,
    );
  }
});
test("historical reference proof accepts its original import alias and trivia without normalizing consumers", () => {
  validate(
    app
      .replace(
        "import { createExchangeReferenceCommands }",
        "import { createExchangeReferenceCommands as ReferenceCommands }",
      )
      .replace(
        "    createExchangeReferenceCommands({",
        "    ReferenceCommands({",
      ),
  );
  validate(app + "\n// comments are not new behavior\n");
});

test("historical twenty-six parsed counterfactuals retain every original specified rejection rule", () => {
  const parsed = parse(app);
  const importedFactory = imported(
    parsed,
    ownerPath,
    "createExchangeReferenceCommands",
  );
  const actualCall = parsed.nodes
    .filter(isCallExpression)
    .find(
      (node) =>
        isIdentifier(node.expression) &&
        parsed.symbols.get(node.expression) === importedFactory.binding,
    )!;
  assert.ok(isVariableDeclaration(actualCall.parent));
  const actualStatement = actualCall.parent.parent.parent;
  assert.ok(isVariableStatement(actualStatement));
  const mutations = [
    [ownerPath, "./host/not-the-reference-owner.js", "one actual import"],
    [
      "import { createExchangeReferenceCommands }",
      "import type { createExchangeReferenceCommands }",
      "actual runtime import",
    ],
    [
      actualCall.getText(),
      "Promise.resolve(" + actualCall.getText() + ")",
      "direct reference command aliases",
    ],
    [
      actualStatement.getText(),
      "if (state) { " + actualStatement.getText() + " }",
      "unconditional render-local reference registration",
    ],
    [
      "const { openTextQuote, composeContent, composeReading, composeIntent }",
      "let { openTextQuote, composeContent, composeReading, composeIntent }",
      "unconditional render-local reference registration",
    ],
    [
      "const { openTextQuote, composeContent, composeReading, composeIntent }",
      "const { openTextQuote: revisit, composeContent, composeReading, composeIntent }",
      "four original direct aliases",
    ],
    [
      "workspace: state,",
      "workspace: { artifacts: state?.artifacts ?? [] },",
      "exact original captured reference ports",
    ],
    [
      "        conversationId,\n        contextKey,",
      "        conversationId: conversationProjectId,\n        contextKey,",
      "exact original captured reference ports",
    ],
    [
      "      drafts: { replace: setDraft, update: updateDraft },",
      "      drafts: { replace: setDraft, update: (key, change) => updateDraft(key, change) },",
      "exact original captured reference ports",
    ],
    [
      "        requestConversationFocus,\n      },\n      quotes:",
      "        requestConversationFocus: requestSentInputFocus,\n      },\n      quotes:",
      "exact original captured reference ports",
    ],
    [
      "clearSelection: () => window.getSelection()?.removeAllRanges()",
      "clearSelection: () => window.getSelection()?.empty()",
      "exact original captured reference ports",
    ],
    [
      "      onNotice: setNotice,\n    });",
      "      onNotice: (message) => setNotice(message),\n    });",
      "exact original captured reference ports",
    ],
    [
      "onReadingCompose={composeReading}",
      "onReadingCompose={(...args) => composeReading(...args)}",
      "fixed complete b5f698dd",
    ],
    [
      "onOpenQuote={(quote) => void openTextQuote(quote)}",
      "onOpenQuote={(quote) => { if (sending) return; void openTextQuote(quote); }}",
      "fixed complete b5f698dd",
    ],
    [
      "onCompose={composeContent}",
      "onCompose={composeIntent}",
      "fixed complete b5f698dd",
    ],
    [
      "useEffect(() => setQuoteReveal(null), [conversationId]);",
      "useEffect(() => setQuoteReveal(null), [contextKey]);",
      "fixed complete b5f698dd",
    ],
  ] as const;
  function rejected(variant: string, rule: string) {
    parse(variant);
    assert.throws(
      () => validate(variant),
      (error: unknown) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
    );
  }
  for (const [before, after, rule] of mutations) {
    assert.ok(app.includes(before), "actual mutation target");
    const statementText = actualStatement.getText();
    const variant = statementText.includes(before)
      ? app.replace(statementText, statementText.replace(before, after))
      : app.replace(before, after);
    rejected(variant, rule);
  }
  rejected(
    app +
      "\nfunction duplicateReference(){createExchangeReferenceCommands({} as never);}\n",
    "one actual reference owner call",
  );
  rejected(
    app.replace(
      "import { createExchangeReferenceCommands }",
      "import { createExchangeReferenceCommands as ActualReference }",
    ) + "\nfunction createExchangeReferenceCommands(){return {};}",
    "one actual reference owner call",
  );
  const moved = app
    .replace(actualStatement.getText(), "")
    .replace(
      "  function open(id: string",
      actualStatement.getText() + "\n  function open(id: string",
    );
  assert.notEqual(moved, app, "real relocation target");
  rejected(moved, "fixed complete b5f698dd");
  rejected(
    app + "\nfunction extraReferenceLifecycle(){useEffect(()=>{},[]);}\n",
    "fixed complete b5f698dd",
  );
  rejected(
    app.replace(
      "onCompose={composeContent}",
      'onCompose={composeContent}\n key="new-mount"',
    ),
    "fixed complete b5f698dd",
  );
  assert.ok(
    owner.includes("old.body.trim() ||"),
    "actual owner mutation target",
  );
  const ownerDrift = owner.replace("old.body.trim() ||", "false ||");
  parse(ownerDrift);
  assert.throws(
    () => validate(app, ownerDrift),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.includes("original reference algorithm composeReading"),
  );
  for (const [before, after] of [
    [
      "  } = render;",
      "  } = { ...render, workspace: { ...render.workspace } };",
    ],
    [
      "return { openTextQuote, composeContent, composeReading, composeIntent };",
      "return { openTextQuote: async (...args) => openTextQuote(...args), composeContent, composeReading, composeIntent };",
    ],
  ] as const) {
    assert.ok(
      owner.includes(before),
      "actual owner capture/return mutation target",
    );
    const variant = owner.replace(before, after);
    parse(variant);
    assert.throws(
      () => validate(app, variant),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        error.message.includes("fixed reference capture/direct return"),
    );
  }
  for (const [before, after, rule] of [
    [
      "export function createExchangeReferenceCommands",
      "export async function createExchangeReferenceCommands",
      "synchronous reference factory",
    ],
    [
      "  async function openTextQuote",
      "  function structuredClone(value){return value;}\n  async function openTextQuote",
      "reviewed reference command inventory",
    ],
  ] as const) {
    assert.ok(
      owner.includes(before),
      "actual constructor inventory mutation target",
    );
    const variant = owner.replace(before, after);
    parse(variant);
    assert.throws(
      () => validate(app, variant),
      (error: unknown) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
    );
  }
});
