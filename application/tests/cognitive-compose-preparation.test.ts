import test from "node:test";
import assert from "node:assert/strict";
import {
  composeCognitiveViewDraft,
  createCognitiveComposePreparation,
} from "../apps/web/src/host/cognitive-compose-preparation.js";
import { updateComposerDraft } from "../apps/web/src/composer-drafts.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import {
  composeSource,
  composeScope,
  composeLocator,
  composeDraft,
  composeEmpty,
  composeQuote,
} from "./fixtures/cognitive-compose-data.js";

// Pure/latest-writer UNIT only. Mounted publication, SQL authorization and
// real navigation owner integration have their own evidence.
test("UNIT cognitive compose preserves latest body/settings/attachments/shared quotes and exact opaque original", () => {
  const source = composeSource(),
    scope = composeScope(),
    locator = composeLocator();
  const old = composeDraft();
  const latest = { ...old, textQuotes: [composeQuote] };
  const result = composeCognitiveViewDraft(
    latest,
    { source, text: "整理这份原文", locator },
    scope,
  );
  assert.ok(result.ok);
  assert.equal(result.draft.body, old.body + "\n整理这份原文");
  assert.strictEqual(result.draft.attachments, old.attachments);
  assert.strictEqual(result.draft.textQuotes, latest.textQuotes);
  assert.equal(result.draft.model, old.model);
  assert.equal(result.draft.reasoningEffort, "max");
  assert.deepEqual(result.draft.cognitiveObject, locator);
  assert.equal(
    result.draft.cognitiveObject!.object.versionRef,
    "opaque:V1/原文\n😀",
  );
  assert.deepEqual(result.draft.cognitiveApplication, {
    connectionId: source.binding.connectionId,
    authority: source.authority,
  });
  const map = {
    [scope.key]: old,
    "conversation:quotes": { ...composeEmpty, textQuotes: [composeQuote] },
    other: { ...composeEmpty, body: "other" },
  };
  const next = updateComposerDraft(
    map,
    scope.key,
    composeEmpty,
    () => result.draft,
  );
  assert.deepEqual(next["conversation:quotes"]!.textQuotes, [composeQuote]);
  assert.strictEqual(next.other, map.other);
  assert.deepEqual(old, composeDraft());
});
test("UNIT ordinary no-object compose does not manufacture catalog references or replace an existing original", () => {
  const source = composeSource(),
    scope = composeScope();
  const noObject = composeCognitiveViewDraft(
    composeEmpty,
    { source, text: "应用协作" },
    scope,
  );
  assert.ok(noObject.ok);
  assert.equal(noObject.draft.cognitiveObject, undefined);
  const old = { ...composeDraft(), cognitiveObject: composeLocator() };
  const preserved = composeCognitiveViewDraft(
    old,
    { source, text: "追加要求" },
    scope,
  );
  assert.ok(preserved.ok);
  assert.strictEqual(preserved.draft.cognitiveObject, old.cognitiveObject);
  assert.equal(
    composeCognitiveViewDraft(
      old,
      { source, text: "V2", locator: composeLocator("opaque:V2") },
      scope,
    ).ok,
    false,
  );
});
test("UNIT incoherent CAS/surface, foreign source, special request and overflow refuse without changing latest carrier", () => {
  const source = composeSource(),
    scope = composeScope(),
    old = composeDraft();
  for (const altered of [
    { ...scope, key: "other:cognitive:wrong" },
    { ...scope, viewRevision: 3 },
    { ...scope, bindingRevision: 4 },
    { ...scope, surface: { ...scope.surface, connectionId: "other" } },
    { ...scope, surface: { ...scope.surface, projectId: "other" } },
  ])
    assert.equal(
      composeCognitiveViewDraft(old, { source, text: "new" }, altered).ok,
      false,
    );
  for (const draft of [
    { ...old, selection: "old selection" },
    { ...old, revision: 1 },
    { ...old, page: 1 },
    { ...old, annotation: true },
    { ...old, continuationFailure: "unknown" as const },
    { ...old, taskResult: { taskId: "task", revision: 1 } },
    { ...old, intent: "script" as const },
    {
      ...old,
      cognitiveApplication: {
        connectionId: "other",
        authority: source.authority,
      },
    },
    { ...old, body: "x".repeat(30000) },
  ]) {
    const before = structuredClone(draft);
    assert.equal(
      composeCognitiveViewDraft(draft, { source, text: "new" }, scope).ok,
      false,
    );
    assert.deepEqual(draft, before);
  }
  const denied = {
    ...source,
    manifest: { ...source.manifest, permissions: [] },
  };
  assert.equal(
    composeCognitiveViewDraft(old, { source: denied, text: "new" }, scope).ok,
    false,
  );
  const foreign = { ...composeLocator(), projectId: "other" };
  assert.equal(
    composeCognitiveViewDraft(
      old,
      { source, text: "new", locator: foreign },
      scope,
    ).ok,
    false,
  );
});

function fixture() {
  let drafts: Record<string, InputDraft> = {
    [composeScope().key]: composeDraft(),
  };
  let current = true;
  const prepared: boolean[] = [];
  const ports = {
    captureScope: () => ({ scope: composeScope(), isCurrent: () => current }),
    locatorForView: async () => composeLocator(),
    writeInputs: (
      update: (
        previous: Record<string, InputDraft>,
      ) => Record<string, InputDraft>,
    ) => {
      drafts = update(drafts);
    },
    flushSync: (run: () => void) => run(),
    publishedDraft: (key: string) => drafts[key],
    emptyDraft: composeEmpty,
    onPrepared: (changed: boolean) => prepared.push(changed),
  };
  return {
    ports,
    get drafts() {
      return drafts;
    },
    set current(value: boolean) {
      current = value;
    },
    prepared,
  };
}
test("UNIT preparation ACK requires actual updater outcome and committed exact publication witness, not merely a void writer call", async () => {
  const f = fixture(),
    source = composeSource();
  assert.deepEqual(
    await createCognitiveComposePreparation(f.ports)(
      { source, text: "append", object: composeLocator().object },
      new AbortController().signal,
    ),
    { prepared: true },
  );
  assert.equal(
    f.drafts[composeScope().key]!.body,
    composeDraft().body + "\nappend",
  );
  assert.deepEqual(f.prepared, [true]);
  const noPublication = fixture();
  noPublication.ports.publishedDraft = () => undefined;
  await assert.rejects(
    createCognitiveComposePreparation(noPublication.ports)(
      { source, text: "append" },
      new AbortController().signal,
    ),
    { code: "unavailable" },
  );
  assert.deepEqual(noPublication.prepared, []);
});
test("UNIT async locator captures original request but current owner change or signal abort leaves exact previous map", async () => {
  for (const invalidation of ["owner", "abort"] as const) {
    const f = fixture(),
      before = f.drafts,
      controller = new AbortController();
    let finish!: () => void;
    f.ports.locatorForView = async () => {
      await new Promise<void>((r) => (finish = r));
      return composeLocator();
    };
    const request = {
      source: composeSource(),
      text: "append",
      object: composeLocator().object,
    };
    const work = createCognitiveComposePreparation(f.ports)(
      request,
      controller.signal,
    );
    request.text = "mutated";
    if (invalidation === "owner") f.current = false;
    else controller.abort();
    finish();
    await assert.rejects(work, {
      code: invalidation === "owner" ? "conflict" : "unavailable",
    });
    assert.strictEqual(f.drafts, before);
    assert.deepEqual(f.prepared, []);
  }
});
test("UNIT rejected deferred writer cannot later publish after unavailable ACK; lifecycle recheck also occurs inside updater", async () => {
  const source = composeSource(),
    f = fixture(),
    before = f.drafts;
  let queued!: Parameters<typeof f.ports.writeInputs>[0];
  f.ports.writeInputs = (update) => {
    queued = update;
  };
  await assert.rejects(
    createCognitiveComposePreparation(f.ports)(
      { source, text: "not yet" },
      new AbortController().signal,
    ),
    { code: "unavailable" },
  );
  assert.strictEqual(queued(before), before);
  const retired = fixture(),
    original = retired.drafts,
    writer = retired.ports.writeInputs;
  retired.ports.writeInputs = (update) => {
    retired.current = false;
    writer(update);
  };
  await assert.rejects(
    createCognitiveComposePreparation(retired.ports)(
      { source, text: "not current" },
      new AbortController().signal,
    ),
    { code: "conflict" },
  );
  assert.strictEqual(retired.drafts, original);
});
test("UNIT returned locator must preserve requested opaque version; no input send/read/authorization fallback exists", async () => {
  const f = fixture(),
    before = f.drafts;
  f.ports.locatorForView = async () => composeLocator("wrong:V2");
  await assert.rejects(
    createCognitiveComposePreparation(f.ports)(
      {
        source: composeSource(),
        text: "append",
        object: composeLocator().object,
      },
      new AbortController().signal,
    ),
    { code: "conflict" },
  );
  assert.strictEqual(f.drafts, before);
  const denied = fixture(),
    source = composeSource();
  source.manifest.permissions = [];
  await assert.rejects(
    createCognitiveComposePreparation(denied.ports)(
      { source, text: "append" },
      new AbortController().signal,
    ),
    { code: "forbidden" },
  );
  assert.deepEqual(denied.prepared, []);
});
