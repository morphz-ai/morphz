import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertPrivateProjectConversationWholeApp,
  inversePrivateProjectConversationScope,
  privateProjectScopeActions,
  privateProjectScopeFixed,
} from "./fixtures/private-project-conversation-scope-consumption.js";

// Actual production consumer and owner, not a model of their wiring. This
// finite source proof is separate from controlled owner/React behavior tests
// and does not claim compiled App, Platform permissions or native acceptance.
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
