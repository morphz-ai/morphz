import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isCallExpression,
  isVariableDeclaration,
  isVariableStatement,
} from "typescript/unstable/ast";
import {
  createExchangeReferenceCommands,
  type ExchangeReferenceOptions,
} from "../apps/web/src/host/exchange-reference-commands.js";
import {
  assertExchangeReferencePreparationWholeApp,
  assertExchangeReferencePreparationWholeModule,
  inverseExchangeReferencePreparationApp,
  inverseExchangeReferencePreparationModule,
  parseReferencePreparation,
  referencePreparationFixed,
} from "./fixtures/exchange-reference-preparation-consumption.js";

// Actual source/consumer and inert construction evidence. Separate fixed-old /
// actual-new React tests and full compiled pages own scheduling and DOM behavior;
// this suite does not claim authority/HTTP/native/model acceptance.
const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const owner = readFileSync(
  new URL(
    "../apps/web/src/host/exchange-reference-commands.ts",
    import.meta.url,
  ),
  "utf8",
);
function changed(text: string, before: string, after: string) {
  assert.equal(
    text.split(before).length - 1,
    1,
    "one specified legal preparation counterfactual seam",
  );
  return text.replace(before, after);
}
function rejected(appText: string, ownerText: string, rule: RegExp) {
  parseReferencePreparation({ App: appText, Owner: ownerText });
  assert.throws(
    () => assertExchangeReferencePreparationWholeApp(appText, ownerText),
    rule,
  );
}
test("actual preparation complete two recipes eight methods captured ports and four real consumers inverse actual Git75ba whole App and module", () => {
  const originalApp = assertExchangeReferencePreparationWholeApp(app, owner);
  const originalOwner = assertExchangeReferencePreparationWholeModule(owner);
  assert.equal(
    Buffer.byteLength(originalApp),
    referencePreparationFixed.appBytes,
  );
  assert.equal(originalOwner, referencePreparationFixed.ownerRaw);
  assert.equal(
    inverseExchangeReferencePreparationApp(originalApp, owner),
    originalApp,
  );
  assert.equal(
    inverseExchangeReferencePreparationModule(originalOwner),
    originalOwner,
  );
  assert.equal(
    inverseExchangeReferencePreparationApp(
      inverseExchangeReferencePreparationApp(app, owner),
      owner,
    ),
    originalApp,
  );
  assert.equal(
    inverseExchangeReferencePreparationModule(
      inverseExchangeReferencePreparationModule(owner),
    ),
    originalOwner,
  );
});
test("actual factory construction returns exactly eight ordered direct methods without invoking the new or old action/ref ports", () => {
  const forbidden = () => {
    throw new Error(
      "inert actual preparation constructor must not call or read live ports",
    );
  };
  const draft = { body: "", selection: "", revision: null };
  const options: ExchangeReferenceOptions = {
    render: {
      conversationId: "c",
      contextKey: "c:o",
      workspace: undefined,
      drafts: {},
      draft,
      sending: false,
      emptyDraft: draft,
    },
    scope: { conversationKey: forbidden },
    origin: { isActive: forbidden },
    navigation: {
      navigationGeneration: {
        get current() {
          return forbidden();
        },
      },
      isCurrent: forbidden,
      setExplicitWebsiteIntent: forbidden,
      openObject: forbidden,
      openScriptLocation: forbidden,
      openBrowser: forbidden,
      activateApplication: forbidden,
      selectConversation: forbidden,
    },
    client: { resolveArtifact: forbidden },
    drafts: { replace: forbidden, update: forbidden },
    exchange: {
      keepOpen: forbidden,
      showInput: forbidden,
      setInteraction: forbidden,
      requestConversationFocus: forbidden,
      scheduleSearchQuoteFocus: forbidden,
      scheduleCommentComposerFocus: forbidden,
    },
    quotes: {
      clearSelection: forbidden,
      reveal: forbidden,
      setReveal: forbidden,
    },
    onNotice: forbidden,
  };
  const result = createExchangeReferenceCommands(options);
  assert.deepEqual(Object.keys(result), [
    "openTextQuote",
    "composeContent",
    "composeReading",
    "composeIntent",
    "prepareSearchQuote",
    "selectArtifactQuote",
    "changeTextQuotes",
    "focusCommentComposer",
  ]);
});
test("preparation hooks retain complete original state stable setter effect only-conversation dependency and type-only ports", () => {
  rejected(
    app,
    changed(
      owner,
      "useEffect(() => setQuoteReveal(null), [conversationId]);",
      "useEffect(() => setQuoteReveal(null), [conversationId, setQuoteReveal]);",
    ),
    /complete original preparation hook recipe useExchangeQuoteRevealCommit/,
  );
  rejected(
    app,
    changed(
      owner,
      "return { quoteReveal, setQuoteReveal };",
      "return { quoteReveal, setQuoteReveal: (value: QuoteReveal) => setQuoteReveal(value) };",
    ),
    /complete original preparation hook recipe useExchangeQuoteRevealState/,
  );
  rejected(
    app,
    changed(
      owner,
      "  return { quoteReveal, setQuoteReveal };",
      "  const extra = useState(0);\n  return { quoteReveal, setQuoteReveal };",
    ),
    /complete original preparation hook recipe useExchangeQuoteRevealState/,
  );
  rejected(
    app,
    changed(
      owner,
      'import type { WorkspaceClient } from "../client.js";',
      'import { WorkspaceClient } from "../client.js";',
    ),
    /original type-only preparation dependencies plus one reviewed React runtime import/,
  );
  rejected(
    app,
    changed(
      owner,
      "type Dispatch, type SetStateAction",
      "Dispatch, SetStateAction",
    ),
    /exact preparation React runtime hooks and type-only writer ports/,
  );
  rejected(
    app,
    changed(
      owner,
      "    scheduleSearchQuoteFocus(): void;",
      "    scheduleSearchQuoteFocus(): Promise<void>;",
    ),
    /exact preparation scope focus render and authority port types/,
  );
});
test("actual preparation hook bindings are real same-name imports unconditional original slots not shadows or moved registration", () => {
  rejected(
    changed(
      app,
      "  useExchangeQuoteRevealState,\n",
      "  type useExchangeQuoteRevealState,\n",
    ),
    owner,
    /complete same-name runtime preparation owner import/,
  );
  const registration =
    "const { quoteReveal, setQuoteReveal } = useExchangeQuoteRevealState();";
  rejected(
    changed(app, registration, "if (client.boot) { " + registration + " }"),
    owner,
    /unconditional original preparation hook slot useExchangeQuoteRevealState/,
  );
  rejected(
    changed(
      app,
      "  const state = client.boot?.workspace;",
      "  const useExchangeQuoteRevealState = () => ({quoteReveal:null,setQuoteReveal:()=>{}});\n  const state = client.boot?.workspace;",
    ),
    owner,
    /real imported preparation hook not local shadow useExchangeQuoteRevealState/,
  );
  const moved = changed(
    app,
    registration + "\n  " + referencePreparationFixed.spans.afterState,
    referencePreparationFixed.spans.afterState + "\n  " + registration,
  );
  rejected(
    moved,
    owner,
    /original preparation hook preceding witness useExchangeQuoteRevealState/,
  );
  rejected(
    changed(
      app,
      "useExchangeQuoteRevealCommit(conversationId, setQuoteReveal);",
      "useExchangeQuoteRevealCommit(contextKey, setQuoteReveal);",
    ),
    owner,
    /exact original preparation state writer and effect arguments/,
  );
  rejected(
    changed(
      app,
      "  const state = client.boot?.workspace;",
      "  const createExchangeReferenceCommands = (_options: unknown) => ({});\n  const state = client.boot?.workspace;",
    ),
    owner,
    /real imported preparation factory not shadowed/,
  );
});
test("search preparation retains void Promise bridge exact generation target key captured replacement and original unnormalized fields", () => {
  for (const [before, after] of [
    [
      "generation !== navigationGeneration.current",
      "generation === navigationGeneration.current",
    ],
    [
      'const key = conversationKey(projectId) + ":" + id;',
      'const key = conversationId + ":" + id;',
    ],
    ["...(drafts[key] ?? emptyDraft),", "...draft,"],
    [
      "        selection: quote,\n        revision,\n        page,",
      "        selection: quote,\n        revision,\n        page,\n        intent: undefined,",
    ],
    [
      "    void openObject(\n      projectId,",
      "    return openObject(\n      projectId,",
    ],
    [
      '      setInteraction("recent");\n      scheduleSearchQuoteFocus();',
      '      setInteraction("recent");\n      scheduleCommentComposerFocus();',
    ],
  ])
    rejected(
      app,
      changed(owner, before!, after!),
      /complete original preparation recipe prepareSearchQuote/,
    );
  const addedRequest = changed(
    owner,
    "    void openObject(\n      projectId,",
    "    void client.resolveArtifact(id);\n    void openObject(\n      projectId,",
  );
  assert.notEqual(addedRequest, owner);
  rejected(
    app,
    addedRequest,
    /complete original preparation recipe prepareSearchQuote/,
  );
  const functional = changed(
    owner,
    `      setDraft(key, {
        ...(drafts[key] ?? emptyDraft),
        selection: quote,
        revision,
        page,
      });`,
    `      updateDraft(key, (old) => ({
        ...old,
        selection: quote,
        revision,
        page,
      }));`,
  );
  rejected(
    app,
    functional,
    /complete original preparation recipe prepareSearchQuote/,
  );
});
test("artifact selection and quote changes preserve their distinct captured versus functional writers cleanup and expression return", () => {
  rejected(
    app,
    changed(
      owner,
      "      annotation,\n      taskResult: undefined,",
      "      annotation,\n      taskResult: draft.taskResult,",
    ),
    /complete original preparation recipe selectArtifactQuote/,
  );
  rejected(
    app,
    changed(
      owner,
      "  function selectArtifactQuote(\n",
      "  async function selectArtifactQuote(\n",
    ),
    /complete original preparation recipe selectArtifactQuote/,
  );
  rejected(
    app,
    changed(
      owner,
      "updateDraft(contextKey, (old) => ({ ...old, textQuotes }));",
      "setDraft(contextKey, { ...draft, textQuotes });",
    ),
    /complete original preparation recipe changeTextQuotes/,
  );
  rejected(
    app,
    changed(
      owner,
      "const changeTextQuotes = (textQuotes: TextQuote[]) =>\n    updateDraft(contextKey, (old) => ({ ...old, textQuotes }));",
      "const changeTextQuotes = (textQuotes: TextQuote[]) => { updateDraft(contextKey, (old) => ({ ...old, textQuotes })); };",
    ),
    /complete original preparation recipe changeTextQuotes/,
  );
  rejected(
    app,
    changed(
      owner,
      "    showInput();\n    scheduleCommentComposerFocus();",
      '    setInteraction("recent");\n    showInput();\n    scheduleCommentComposerFocus();',
    ),
    /complete original preparation recipe focusCommentComposer/,
  );
});
test("actual factory borrows the captured original fields and conversation function with distinct lazy focus ports no state queries or wrappers", () => {
  const factoryCall = parseReferencePreparation({ App: app })
    .get("App")!
    .nodes.filter(isCallExpression)
    .find(
      (node) => node.expression.getText() === "createExchangeReferenceCommands",
    );
  assert.ok(factoryCall && isVariableDeclaration(factoryCall.parent));
  const factoryStatement = factoryCall.parent.parent?.parent;
  assert.ok(factoryStatement && isVariableStatement(factoryStatement));
  const rawFactory = factoryStatement.getText();
  rejected(
    changed(
      app,
      referencePreparationFixed.spans.beforeFactory + "\n  " + rawFactory,
      rawFactory + "\n  " + referencePreparationFixed.spans.beforeFactory,
    ),
    owner,
    /original preparation factory preceding/,
  );
  rejected(
    changed(app, rawFactory, "if (client.boot) { " + rawFactory + " }"),
    owner,
    /inert preparation factory original unconditional Host slot/,
  );
  rejected(
    changed(
      app,
      "  const state = client.boot?.workspace;",
      "  const createPrivateProjectConversationScope = (_ports: unknown) => ({});\n  const state = client.boot?.workspace;",
    ),
    owner,
    /real original private owner preceding preparation factory/,
  );
  rejected(
    changed(
      app,
      "    scope: { conversationKey },",
      "    scope: { conversationKey: (id) => conversationKey(id) },",
    ),
    owner,
    /complete preparation captured render fields scope and distinct lazy focus ports/,
  );
  rejected(
    changed(
      app,
      "    client,\n    drafts: { replace: setDraft, update: updateDraft },",
      "    client: { ...client },\n    drafts: { replace: setDraft, update: updateDraft },",
    ),
    owner,
    /complete preparation captured render fields scope and distinct lazy focus ports/,
  );
  const searchPort = `scheduleSearchQuoteFocus: () =>
        requestAnimationFrame(() => {
          if (!exchange.current?.contains(document.activeElement))
            input.current?.focus();
        })`;
  const commentPort = `scheduleCommentComposerFocus: () =>
        requestAnimationFrame(() =>
          input.current?.focus({ preventScroll: true }),
        )`;
  rejected(
    changed(
      app,
      searchPort,
      searchPort.replace(
        searchPort.slice(searchPort.indexOf("requestAnimationFrame")),
        commentPort.slice(commentPort.indexOf("requestAnimationFrame")),
      ),
    ),
    owner,
    /complete preparation captured render fields scope and distinct lazy focus ports/,
  );
  rejected(
    app,
    changed(
      owner,
      "  const { conversationKey } = scope;",
      "  const { conversationKey } = scope;\n  const read = client.resolveArtifact('extra');",
    ),
    /inert preparation construction exact borrowed captures and eight direct returns/,
  );
  rejected(
    app,
    changed(
      owner,
      "    prepareSearchQuote,\n    selectArtifactQuote,\n    changeTextQuotes,\n    focusCommentComposer,",
      "    prepareSearchQuote: (...args) => prepareSearchQuote(...args),\n    selectArtifactQuote,\n    changeTextQuotes,\n    focusCommentComposer,",
    ),
    /inert preparation construction exact borrowed captures and eight direct returns/,
  );
});
test("four actual consumers are sole direct returned symbols and retain full original tree keys guards and captured neighboring callbacks", () => {
  rejected(
    changed(
      app,
      "onQuote={prepareSearchQuote}",
      "onQuote={(...args) => prepareSearchQuote(...args)}",
    ),
    owner,
    /direct actual preparation consumer prepareSearchQuote/,
  );
  rejected(
    changed(
      app,
      "onSelect={selectArtifactQuote}",
      "onSelect={prepareSearchQuote}",
    ),
    owner,
    /direct actual preparation consumer selectArtifactQuote/,
  );
  rejected(
    changed(
      app,
      "onChange: changeTextQuotes",
      "onChange: (textQuotes) => changeTextQuotes(textQuotes)",
    ),
    owner,
    /direct actual preparation consumer changeTextQuotes/,
  );
  rejected(
    changed(
      app,
      "  async function openScript(output: ScriptOutput) {",
      "  const extraAlias = prepareSearchQuote;\n  async function openScript(output: ScriptOutput) {",
    ),
    owner,
    /one direct preparation consumer no alias wrapper or extra invocation prepareSearchQuote/,
  );
  const artifact = referencePreparationFixed.spans.artifactElement.replace(
    "onSelect={" + referencePreparationFixed.spans.select + "}",
    "onSelect={selectArtifactQuote}",
  );
  rejected(
    changed(
      app,
      artifact,
      artifact.replace("artifact.id +", "artifact.projectId +"),
    ),
    owner,
    /complete original Artifact consumer identity keys captured callbacks and selection/,
  );
  rejected(
    changed(
      app,
      "      scope: conversationId,\n      reveal: quoteReveal,",
      "      scope: contextKey,\n      reveal: quoteReveal,",
    ),
    owner,
    /complete original Provider props reveal disabled engage notice and distinct direct focus change/,
  );
  rejected(
    changed(app, "{searchOpen && (", "{searchOpen || ("),
    owner,
    /whole actual Git75ba App SHA after only approved preparation inverse/,
  );
});
test("finite inverse is byte-idempotent in legacy lanes retains unrelated deltas and cannot strip extra approved-span comments or new inventory", () => {
  const oldApp = inverseExchangeReferencePreparationApp(app, owner),
    oldOwner = referencePreparationFixed.ownerRaw;
  for (const original of [
    oldApp,
    oldApp + "\n// unrelated old counterfactual\n",
    oldApp + "\n// useExchangeQuoteRevealState is not an actual hook import\n",
  ])
    assert.equal(
      inverseExchangeReferencePreparationApp(original, owner),
      original,
    );
  for (const original of [
    oldOwner,
    oldOwner +
      "\n// useExchangeQuoteRevealState is not an actual hook declaration\n",
    oldOwner.replace(
      "quotes.clearSelection();",
      "quotes.clearSelection();\n    extra();",
    ),
  ])
    assert.equal(inverseExchangeReferencePreparationModule(original), original);
  const outside = app + "\n// unrelated new delta\n";
  assert.equal(
    inverseExchangeReferencePreparationApp(outside, owner),
    oldApp + "\n// unrelated new delta\n",
  );
  rejected(
    outside,
    owner,
    /whole actual Git75ba App bytes after only approved preparation inverse/,
  );
  rejected(
    app,
    owner + "\n// unrelated module delta\n",
    /whole actual Git75ba owner bytes after only approved preparation inverse/,
  );
  rejected(
    app,
    changed(
      owner,
      "    scheduleSearchQuoteFocus();",
      "    // unapproved delta\n    scheduleSearchQuoteFocus();",
    ),
    /complete original preparation recipe prepareSearchQuote raw approved span/,
  );
  rejected(
    changed(
      app,
      "    scope: { conversationKey },",
      "    // unapproved delta\n    scope: { conversationKey },",
    ),
    owner,
    /complete preparation captured render fields scope and distinct lazy focus ports raw approved span/,
  );
  rejected(
    app,
    owner + "\nconst extraOwner = {};\n",
    /reviewed finite preparation module inventory/,
  );
});
