import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import nodeTest from "node:test";
import {
  privateProjectScopeFixed,
  verifyCurrentPrivateProjectConversationScopeConsumption,
} from "./fixtures/private-project-conversation-scope-consumption.js";
import {
  historicalPrivateApp,
  historicalPrivateProjectScope,
  historicalReferenceEntry,
  humanPrivateGovernanceHistory,
} from "./fixtures/human-private-governance-history.js";
// Current uses raw App and finite actual symbols/captures/recipes. The original
// whole-App/peer-inverse rules below execute only immutable historical operands.
const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const owner = readFileSync(
  new URL(
    "../apps/web/src/host/private-project-conversation-scope.ts",
    import.meta.url,
  ),
  "utf8",
);
function changed(text: string, before: string, after: string) {
  assert.equal(
    text.split(before).length - 1,
    1,
    "counterfactual changes one specified finite seam",
  );
  return text.replace(before, after);
}
const test = nodeTest;

function rejected(appText: string, ownerText: string, rule: RegExp) {
  assert.throws(
    () =>
      verifyCurrentPrivateProjectConversationScopeConsumption(
        appText,
        ownerText,
      ),
    (error: unknown) =>
      error instanceof assert.AssertionError && rule.test(error.message),
  );
}
test("current Private: actual raw seven actions, three independent registrations, two projections and Launcher bridge", () => {
  verifyCurrentPrivateProjectConversationScopeConsumption(app, owner);
});
test("current private project scope: real imported factory may be aliased without weakening its symbol", () => {
  const aliased = changed(
    app,
    "  createPrivateProjectConversationScope,\n  projectConversationDraftPresence,",
    "  createPrivateProjectConversationScope as createScope,\n  projectConversationDraftPresence,",
  );
  const called = changed(
    aliased,
    "} = createPrivateProjectConversationScope({",
    "} = createScope({",
  );
  verifyCurrentPrivateProjectConversationScopeConsumption(called, owner);
  const shadowed = changed(
    app,
    "  const state = client.boot?.workspace;",
    "  const createPrivateProjectConversationScope = (_ports: unknown) => ({});\n  const state = client.boot?.workspace;",
  );
  rejected(
    shadowed,
    owner,
    /real imported private scope call createPrivateProjectConversationScope/,
  );
});

test("current private project scope: reject cloned render ports and wrapped public aliases by specified rule", () => {
  const latest = changed(
    app,
    "    render: {\n      state,\n      prefs,\n      navigationProject,",
    "    render: {\n      state: host.currentProjection()?.workspace,\n      prefs,\n      navigationProject,",
  );
  rejected(
    latest,
    owner,
    /seven direct aliases and exact captured private scope ports/,
  );
  const wrapped = changed(
    app,
    "    selectContentScope,\n    selectConversation,\n    createProjectConversation,",
    "    selectContentScope,\n    selectConversation: selectConversationCommand,\n    createProjectConversation,",
  );
  const wrapperAdded = changed(
    wrapped,
    "  const {\n    openTextQuote,\n    composeContent,",
    "  const selectConversation = (...args: [string, string, boolean?]) => selectConversationCommand(...args);\n  const {\n    openTextQuote,\n    composeContent,",
  );
  rejected(
    wrapperAdded,
    owner,
    /seven direct aliases and exact captured private scope ports/,
  );
  const partial = changed(
    app,
    "  useCommittedConversationDraftRetirement(draftCommands, state);",
    privateProjectScopeFixed.effects.retirement,
  );
  rejected(
    partial,
    owner,
    /one real private scope call useCommittedConversationDraftRetirement/,
  );
});

test("current private project scope: reject constructor reads and changed original guards or publication order", () => {
  const read = changed(
    owner,
    "  const { keepExchangeOpen, requestConversationFocus } = exchange;",
    "  const { keepExchangeOpen, requestConversationFocus } = exchange;\n  const capturedGeneration = navigationGeneration.current;",
  );
  rejected(
    app,
    read,
    /inert private scope factory has only four captures seven declarations and return/,
  );
  const guard = changed(
    owner,
    "        isCurrent(intent.generation) &&",
    "        true &&",
  );
  rejected(
    app,
    guard,
    /complete actual Git private scope algorithm prepareCreatedProject/,
  );
  const focus = changed(
    owner,
    "      keepExchangeOpen();\n      requestConversationFocus(id, navigationGeneration.current);",
    "      requestConversationFocus(id, navigationGeneration.current);\n      keepExchangeOpen();",
  );
  rejected(
    app,
    focus,
    /complete actual Git private scope algorithm selectConversation/,
  );
});

test("current private project scope: keep independent original hook registrations and projection recipes", () => {
  const dependencies = changed(
    owner,
    "  }, [conversationProjectId, conversationId, selectedDraft?.id]);",
    "  }, [conversationProjectId, conversationId, selectedDraft]);",
  );
  rejected(
    app,
    dependencies,
    /complete original private scope hook\/projection recipe usePrivateConversationHistorySelection/,
  );
  const draft = changed(
    owner,
    "          value.intent\n",
    "          value.intent || value.model\n",
  );
  rejected(
    app,
    draft,
    /complete original private scope hook\/projection recipe projectConversationDraftPresence/,
  );
  const moved = changed(
    app,
    "  useCommittedConversationDraftRetirement(draftCommands, state);\n  const projectMetrics = useMemo(() => {",
    "  const projectMetrics = useMemo(() => {",
  );
  const reordered = changed(
    moved,
    "  const { writeInputs: writeDrafts } = draftCommands;",
    "  const { writeInputs: writeDrafts } = draftCommands;\n  useCommittedConversationDraftRetirement(draftCommands, state);",
  );
  rejected(
    reordered,
    owner,
    /retirement effect follows original started projection/,
  );
});

test("current Private: const/import/helper aliases retain actual dependency origins", () => {
  let alias = changed(
    app,
    "  createPrivateProjectConversationScope,",
    "  createPrivateProjectConversationScope as importedScope,",
  );
  alias = changed(
    alias,
    "type View = WorkSurfaceView;",
    "type View = WorkSurfaceView;\nconst createPrivateProjectConversationScope = importedScope;",
  );
  const dependency = changed(
    owner,
    "useEffect, useState",
    "useEffect as scopeEffect, useState",
  ).replaceAll("useEffect(() =>", "scopeEffect(() =>");
  verifyCurrentPrivateProjectConversationScopeConsumption(alias, dependency);
});
test("current Private: independently consumed complete React feature with a new import is legal", () => {
  const growth =
    changed(owner, "useEffect, useState", "useEffect, useState, useRef") +
    "\nexport function IndependentPrivateFeature() { const [value] = useState(0); const slot = useRef(value); useEffect(() => {}, []); return null; }";
  const used = changed(
    changed(
      app,
      "  createPrivateProjectConversationScope,",
      "  createPrivateProjectConversationScope,\n  IndependentPrivateFeature,",
    ),
    "<WorkspaceTopbar",
    "<IndependentPrivateFeature /><WorkspaceTopbar",
  );
  verifyCurrentPrivateProjectConversationScopeConsumption(used, growth);
});
test("current Private: foreign actual consumption and owned mirror/ambient side effects reject specified rules", () => {
  const foreign = changed(
    app,
    "type View = WorkSurfaceView;",
    'import { createPrivateProjectConversationScope as ForeignScope } from "./foreign-scope.js";\ntype View = WorkSurfaceView;',
  ).replace(
    "} = createPrivateProjectConversationScope({",
    "} = ForeignScope({",
  );
  rejected(
    foreign,
    owner,
    /real imported private scope call createPrivateProjectConversationScope/,
  );
  const dependency = changed(
    changed(
      owner,
      'import { useEffect, useState } from "react";',
      'import { useEffect, useState } from "react";\nimport { useState as foreignState } from "foreign-react";',
    ),
    "= useState(",
    "= foreignState(",
  );
  rejected(
    app,
    dependency,
    /complete original private scope hook\/projection recipe usePrivateProjectContentScope/,
  );
  const mirror = changed(
    app,
    "    origin,\n    draftCommands,\n    sendPending,",
    "    origin,\n    draftCommands,\n    sendPending: mirrorPending,",
  );
  const consumed = changed(
    mirror,
    "  function open(id: string, revision?: number, page?: number) {",
    "  const mirrorPending = useRef(false);\n  function open(id: string, revision?: number, page?: number) {",
  );
  rejected(
    consumed,
    owner,
    /seven direct aliases and exact captured private scope ports/,
  );
  rejected(
    app,
    owner + '\nfetch("/write-scope");\n',
    /no ambient private scope mutation outside the owned lifecycle/,
  );
});
function registerHistoricalPrivateCounterfactuals() {
  const test = (name: string, body: () => void) =>
    nodeTest("historical Private: " + name, body);
  const inverseExchangeReferencePreparationApp = historicalReferenceEntry;
  const app = inverseExchangeReferencePreparationApp(historicalPrivateApp),
    owner = humanPrivateGovernanceHistory.sources.privateOwner!.raw;
  const {
    assertPrivateProjectConversationWholeApp,
    inversePrivateProjectConversationScope,
    privateProjectScopeFixed,
    privateProjectScopeActions,
  } = historicalPrivateProjectScope;
  function rejected(appText: string, ownerText: string, rule: RegExp) {
    assert.throws(
      () => inversePrivateProjectConversationScope(appText, ownerText),
      rule,
    );
  }
  test("private project scope: actual seven complete Git declarations and whole App inverse", () => {
    for (const name of privateProjectScopeActions)
      assert.equal(
        createHash("sha256")
          .update(privateProjectScopeFixed.functions[name])
          .digest("hex"),
        privateProjectScopeFixed.actionHashes[name],
        name,
      );
    const original = assertPrivateProjectConversationWholeApp(app, owner);
    assert.equal(
      inversePrivateProjectConversationScope(original, owner),
      original,
      "nested old gates keep the complete legacy source byte-for-byte",
    );
    assert.ok(
      original.includes('selectAllContent: () => setContentScope("all")'),
      "Launcher still borrows the original raw setter",
    );
  });

  test("private project scope: real imported factory may be aliased without weakening its symbol", () => {
    const aliased = changed(
      app,
      "  createPrivateProjectConversationScope,\n  projectConversationDraftPresence,",
      "  createPrivateProjectConversationScope as createScope,\n  projectConversationDraftPresence,",
    );
    const called = changed(
      aliased,
      "} = createPrivateProjectConversationScope({",
      "} = createScope({",
    );
    assertPrivateProjectConversationWholeApp(called, owner);
    const shadowed = changed(
      app,
      "  const state = client.boot?.workspace;",
      "  const createPrivateProjectConversationScope = (_ports: unknown) => ({});\n  const state = client.boot?.workspace;",
    );
    rejected(
      shadowed,
      owner,
      /real imported private scope call createPrivateProjectConversationScope/,
    );
  });

  test("private project scope: reject cloned render ports and wrapped public aliases by specified rule", () => {
    const latest = changed(
      app,
      "    render: {\n      state,\n      prefs,\n      navigationProject,",
      "    render: {\n      state: host.currentProjection()?.workspace,\n      prefs,\n      navigationProject,",
    );
    rejected(
      latest,
      owner,
      /seven direct aliases and exact captured private scope ports/,
    );
    const wrapped = changed(
      app,
      "    selectContentScope,\n    selectConversation,\n    createProjectConversation,",
      "    selectContentScope,\n    selectConversation: selectConversationCommand,\n    createProjectConversation,",
    );
    const wrapperAdded = changed(
      wrapped,
      "  const { openTextQuote, composeContent, composeReading, composeIntent } =",
      "  const selectConversation = (...args: [string, string, boolean?]) => selectConversationCommand(...args);\n  const { openTextQuote, composeContent, composeReading, composeIntent } =",
    );
    rejected(
      wrapperAdded,
      owner,
      /seven direct aliases and exact captured private scope ports/,
    );
    const partial = changed(
      app,
      "  useCommittedConversationDraftRetirement(draftCommands, state);",
      privateProjectScopeFixed.effects.retirement,
    );
    rejected(
      partial,
      owner,
      /one real private scope call useCommittedConversationDraftRetirement/,
    );
  });

  test("private project scope: reject constructor reads and changed original guards or publication order", () => {
    const read = changed(
      owner,
      "  const { keepExchangeOpen, requestConversationFocus } = exchange;",
      "  const { keepExchangeOpen, requestConversationFocus } = exchange;\n  const capturedGeneration = navigationGeneration.current;",
    );
    rejected(
      app,
      read,
      /inert private scope factory has only four captures seven declarations and return/,
    );
    const guard = changed(
      owner,
      "        isCurrent(intent.generation) &&",
      "        true &&",
    );
    rejected(
      app,
      guard,
      /complete actual Git private scope algorithm prepareCreatedProject/,
    );
    const focus = changed(
      owner,
      "      keepExchangeOpen();\n      requestConversationFocus(id, navigationGeneration.current);",
      "      requestConversationFocus(id, navigationGeneration.current);\n      keepExchangeOpen();",
    );
    rejected(
      app,
      focus,
      /complete actual Git private scope algorithm selectConversation/,
    );
  });

  test("private project scope: keep independent original hook registrations and projection recipes", () => {
    const dependencies = changed(
      owner,
      "  }, [conversationProjectId, conversationId, selectedDraft?.id]);",
      "  }, [conversationProjectId, conversationId, selectedDraft]);",
    );
    rejected(
      app,
      dependencies,
      /complete original private scope hook\/projection recipe usePrivateConversationHistorySelection/,
    );
    const draft = changed(
      owner,
      "          value.intent\n",
      "          value.intent || value.model\n",
    );
    rejected(
      app,
      draft,
      /complete original private scope hook\/projection recipe projectConversationDraftPresence/,
    );
    const moved = changed(
      app,
      "  useCommittedConversationDraftRetirement(draftCommands, state);\n  const projectMetrics = useMemo(() => {",
      "  const projectMetrics = useMemo(() => {",
    );
    const reordered = changed(
      moved,
      "  const { writeInputs: writeDrafts } = draftCommands;",
      "  const { writeInputs: writeDrafts } = draftCommands;\n  useCommittedConversationDraftRetirement(draftCommands, state);",
    );
    rejected(
      reordered,
      owner,
      /retirement effect follows original started projection/,
    );
  });

  test("private project scope: approved inverse cannot hide an unrelated complete App delta", () => {
    const unrelated = changed(
      app,
      "type View = WorkSurfaceView;",
      "type View = WorkSurfaceView;\nconst unrelatedDelta = true;",
    );
    const restored = inversePrivateProjectConversationScope(unrelated, owner);
    assert.ok(restored.includes("const unrelatedDelta = true;"));
    assert.throws(
      () => assertPrivateProjectConversationWholeApp(unrelated, owner),
      /whole actual Git App byte count after only approved private scope inverse/,
    );
    const legacy = assertPrivateProjectConversationWholeApp(app, owner);
    const changedLegacy = changed(
      legacy,
      "      keepExchangeOpen();\n      requestConversationFocus(id, navigationGeneration.current);",
      "      void keepExchangeOpen();\n      requestConversationFocus(id, navigationGeneration.current);",
    );
    assert.equal(
      inversePrivateProjectConversationScope(changedLegacy, owner),
      changedLegacy,
      "old specified negatives are not stripped or reclassified by a nested inverse",
    );
  });
}
registerHistoricalPrivateCounterfactuals();
