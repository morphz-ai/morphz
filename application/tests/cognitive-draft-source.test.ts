import test from "node:test";
import assert from "node:assert/strict";
import { pinCognitiveDraftOriginal } from "../apps/web/src/host/cognitive-draft-source.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import type { CognitiveWorkSurface } from "../apps/web/src/host/work-surface.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";

// Pure preparation UNIT, not current Human authorization, persistence,
// mounted App, author HTTP or actual Runtime acceptance.
const authority = {
  appId: "author.notes",
  version: "1.0.0",
  definitionHash: "a".repeat(64),
  instanceId: "notes-instance",
  serviceId: "notes-service",
  dataAuthorityId: "notes-data",
};
const locator = (versionRef = "opaque:V1") =>
  parseCognitiveAppObjectLocator({
    contentId: "content-one",
    projectId: "project-one",
    connectionId: "connection-one",
    authority,
    object: { objectId: "opaque:对象", versionRef },
  });
const source = (): CognitiveWorkSurface => ({
  kind: "original",
  locator: locator(),
});
const draft = (fields: Partial<InputDraft> = {}): InputDraft => ({
  body: "Human text",
  selection: "",
  revision: null,
  ...fields,
});

test("UNIT first original text or attachment edit pins detached whole exact source", () => {
  for (const current of [
    draft(),
    draft({
      body: "",
      attachments: [
        { assetId: "a".repeat(64), name: "file.txt", mime: "text/plain" },
      ],
    }),
  ]) {
    const surface = structuredClone(source());
    const result = pinCognitiveDraftOriginal(current, surface);
    assert.equal(result.ok, true);
    if (!result.ok) throw Error("expected prepared draft");
    assert.deepEqual(result.draft.cognitiveObject, locator());
    assert.notStrictEqual(
      result.draft.cognitiveObject,
      surface.kind === "original" ? surface.locator : undefined,
    );
    assert.equal(current.cognitiveObject, undefined);
    assert.equal(result.draft.body, current.body);
    assert.strictEqual(result.draft.attachments, current.attachments);
  }
});
test("UNIT stored V1 survives reopened V2 and caller mutation without replacing model/body/quotes", () => {
  const raw = structuredClone(locator());
  const current = draft({
    cognitiveObject: raw,
    model: "user-model",
    reasoningEffort: "max",
  });
  const result = pinCognitiveDraftOriginal(current, {
    kind: "original",
    locator: locator("opaque:V2"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("expected V1 draft");
  Object.defineProperty(raw.object, "versionRef", {
    value: "caller mutation",
    enumerable: true,
  });
  assert.deepEqual(result.draft.cognitiveObject, locator());
  assert.equal(result.draft.model, "user-model");
  assert.equal(result.draft.reasoningEffort, "max");
  assert.equal(result.draft.body, current.body);
});
test("UNIT every identity change refuses instead of overwriting the old source", () => {
  for (const changed of [
    { ...locator(), contentId: "other-content" },
    { ...locator(), projectId: "other-project" },
    { ...locator(), connectionId: "other-connection" },
    {
      ...locator(),
      object: { objectId: "other-object", versionRef: "opaque:V2" },
    },
    ...(
      [
        "appId",
        "version",
        "definitionHash",
        "instanceId",
        "serviceId",
        "dataAuthorityId",
      ] as const
    ).map((field) => ({
      ...locator(),
      authority: {
        ...authority,
        [field]:
          field === "appId"
            ? "other.notes"
            : field === "version"
              ? "2.0.0"
              : field === "definitionHash"
                ? "b".repeat(64)
                : "other-value",
      },
    })),
  ]) {
    const current = draft({ cognitiveObject: locator() });
    const result = pinCognitiveDraftOriginal(current, {
      kind: "original",
      locator: parseCognitiveAppObjectLocator(changed),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(current.cognitiveObject, locator());
    assert.equal(current.body, "Human text");
  }
});
test("UNIT text-only view, absent surface and empty original never guess an object", () => {
  const view: CognitiveWorkSurface = {
    kind: "view",
    projectId: "project-one",
    viewId: "view-one",
    connectionId: "connection-one",
    authority,
  };
  for (const surface of [view, null, undefined]) {
    const current = draft();
    const result = pinCognitiveDraftOriginal(current, surface);
    assert.deepEqual(result, { ok: true, draft: current });
    if (result.ok) assert.strictEqual(result.draft, current);
  }
  const empty = draft({ body: "  " });
  const result = pinCognitiveDraftOriginal(empty, source());
  assert.deepEqual(result, { ok: true, draft: empty });
  if (result.ok) assert.strictEqual(result.draft, empty);
});
test("UNIT special requests and old builtin source are left untouched", () => {
  const operation = {
    type: "record-input" as const,
    projectId: "project-one",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "pending",
    targetActantId: "morphz-agent",
  };
  for (const change of [
    {
      continuation: {
        mode: "supplement" as const,
        inputId: "input-one",
        threadId: "thread-one",
        generation: 1,
      },
    },
    { pendingSupplement: { commandId: "old-command", operation } },
    { continuationFailure: "unknown" as const },
    { taskResult: { taskId: "task-one", revision: 1 } },
    { annotation: true },
    { selection: "builtin selected text", revision: 2 },
    { page: 3 },
    {
      scriptGeneration: {
        productionId: "script-one",
        targetId: "target-one",
        baseRevision: 1,
        contextRevision: 1,
        purpose: "rewrite" as const,
        references: [],
        maxCandidates: 1,
        maxOutputCharacters: 100,
        maxReviewPasses: 0,
      },
    },
  ]) {
    const current = draft(change);
    const result = pinCognitiveDraftOriginal(current, source());
    assert.deepEqual(result, { ok: true, draft: current });
    if (result.ok) assert.strictEqual(result.draft, current);
    assert.equal(current.cognitiveObject, undefined);
  }
});
test("UNIT new slot and nested locator getters are rejected without execution", () => {
  let reads = 0;
  const current = draft();
  Object.defineProperty(current, "cognitiveObject", {
    enumerable: true,
    get() {
      reads++;
      return locator();
    },
  });
  assert.equal(pinCognitiveDraftOriginal(current, source()).ok, false);
  const sourceWithGetter = structuredClone(source());
  if (sourceWithGetter.kind !== "original") throw Error("fixture original");
  Object.defineProperty(sourceWithGetter.locator.object, "versionRef", {
    enumerable: true,
    get() {
      reads++;
      return "private";
    },
  });
  assert.equal(pinCognitiveDraftOriginal(draft(), sourceWithGetter).ok, false);
  assert.equal(reads, 0);
});
test("UNIT removing body retains old V1 slot until an explicit reference clear", () => {
  const current = draft({ body: "", cognitiveObject: locator() });
  const result = pinCognitiveDraftOriginal(current, {
    kind: "original",
    locator: locator("opaque:V2"),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.draft.cognitiveObject, locator());
});
