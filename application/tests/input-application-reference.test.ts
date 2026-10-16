import test from "node:test";
import assert from "node:assert/strict";
import { inputApplicationReference } from "../apps/web/src/host/input-application-reference.js";
import {
  detachComposerAssociation,
  inputSurfaceContext,
  inputSurfaceDetached,
} from "../apps/web/src/host/input-surface-association.js";
import { consumeComposerDraft } from "../apps/web/src/composer-drafts.js";
import type { ExchangeSubmissionContext } from "../apps/web/src/host/submit-exchange-draft.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";

test("visible application association uses the same exact reference as submission, including script discussion", () => {
  for (const id of [
    "morphz.script-studio",
    "morphz.reader",
    "morphz.browser",
    "morphz.objects",
  ])
    assert.deepEqual(
      inputApplicationReference(
        {
          applicationId: id,
          applicationVersion: "1.0.0",
          state: { body: "not context" },
        },
        false,
      ),
      { id, version: "1.0.0" },
    );
  const instance = {
    applicationId: "morphz.terminal",
    applicationVersion: "1.0.0",
    state: { terminalId: "original" },
  };
  const frozen = inputApplicationReference(instance, false);
  instance.state.terminalId = "new";
  assert.deepEqual(frozen, {
    id: "morphz.terminal",
    version: "1.0.0",
    terminalId: "original",
  });
  assert.equal(inputApplicationReference(instance, true), undefined);
  assert.equal(inputApplicationReference(undefined, false), undefined);
});

test("unlinking is a persistent local choice, not closing the surface or changing input ownership", () => {
  const empty: InputDraft = { body: "", revision: null, selection: "" };
  const draft: InputDraft = {
    ...empty,
    body: "保留未发送的正文",
    selection: "当前选区",
    revision: 4,
    page: 2,
    annotation: true,
    model: "model-a",
    reasoningEffort: "high",
    attachments: [
      { assetId: "a".repeat(64), mime: "text/plain", name: "手动附件.txt" },
    ],
    textQuotes: [
      {
        id: "quote-a",
        source: {
          kind: "artifact",
          projectId: "project-a",
          artifactId: "other",
          revision: 2,
          title: "手动引用",
        },
        text: "原文",
        comment: "",
      },
    ],
  };
  const detached = detachComposerAssociation(draft);
  assert.equal(draft.selection, "当前选区");
  assert.equal(detached.detachedAssociation, true);
  assert.equal(detached.body, draft.body);
  assert.equal(detached.attachments, draft.attachments);
  assert.equal(detached.textQuotes, draft.textQuotes);
  assert.equal(detached.selection, "");
  assert.equal(detached.revision, null);
  assert.equal(detached.page, undefined);
  assert.equal(detached.annotation, false);
  const consumed = consumeComposerDraft(detached, empty);
  assert.equal(consumed.body, "");
  assert.equal(consumed.detachedAssociation, true);
  assert.equal(consumed.model, "model-a");
  const context = {
    projectId: "project-a",
    conversationId: "conversation-a",
    firstConversation: undefined,
    artifact: { id: "open-book", revision: 4 },
    activeInstance: {
      applicationId: "morphz.script-studio",
      applicationVersion: "1.0.0",
    },
    browserPage: null,
    readingExpected: true,
    currentReading: null,
    cognitiveSurface: null,
    canAuthorizeDirectories: true,
    directoryScope: "scope-a",
    directoryState: { scope: "scope-a", ready: true, grants: [] },
    capabilities: {
      runtimeConfigured: true,
      directedInput: true,
      conversationOnFirstInput: true,
    },
  } as ExchangeSubmissionContext;
  const unbound = inputSurfaceContext(context, detached);
  assert.equal(unbound.projectId, context.projectId);
  assert.equal(unbound.conversationId, context.conversationId);
  assert.equal(unbound.directoryState, context.directoryState);
  assert.equal(unbound.artifact, undefined);
  assert.equal(unbound.activeInstance, undefined);
  assert.equal(unbound.readingExpected, false);
  assert.equal(context.artifact?.id, "open-book");
  assert.equal(inputSurfaceContext(context, empty), context);
  const explicitQuote = {
    ...detached,
    selection: "随后主动选择的新原文",
    revision: 4,
  };
  assert.equal(inputSurfaceDetached(explicitQuote), false);
  assert.equal(inputSurfaceContext(context, explicitQuote), context);
  assert.equal(
    inputSurfaceDetached(consumeComposerDraft(explicitQuote, empty)),
    true,
  );
  const supplement = {
    ...detached,
    continuation: { inputId: "original" },
  } as InputDraft;
  assert.equal(inputSurfaceContext(context, supplement), context);
  assert.equal(detachComposerAssociation(supplement), supplement);
  let getterCalls = 0;
  const malformed = Object.defineProperty(
    { ...empty, detachedAssociation: true },
    "cognitiveObject",
    {
      get() {
        getterCalls++;
        throw Error("must not evaluate a source getter before admission");
      },
    },
  );
  assert.equal(inputSurfaceDetached(malformed), false);
  assert.equal(inputSurfaceContext(context, malformed), context);
  assert.equal(getterCalls, 0);
});
