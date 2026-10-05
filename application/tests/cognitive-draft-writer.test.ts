import test from "node:test";
import assert from "node:assert/strict";
import {
  createCognitiveDraftWriter,
  type CognitiveDraftWriterScope,
} from "../apps/web/src/host/cognitive-draft-writer.js";
import {
  createExchangeDraftCommands,
  type InputDraft,
} from "../apps/web/src/host/exchange-drafts.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import { cognitiveWorkSurfaceKey } from "../apps/web/src/host/work-surface.js";
import {
  replaceComposerSurface,
  updateComposerDraft,
  consumeComposerDraft,
} from "../apps/web/src/composer-drafts.js";
import { draftKey } from "../apps/web/src/local-preferences.js";

// UNIT controlled scheduling/owner facts + actual public draft command writer.
// Not mounted App, author HTTP, current Human grants or Runtime acceptance.
const empty: InputDraft = { body: "", selection: "", revision: null };
const locator = (versionRef = "opaque:V1") =>
  parseCognitiveAppObjectLocator({
    contentId: "content-one",
    projectId: "project-one",
    connectionId: "connection-one",
    authority: {
      appId: "author.notes",
      version: "1.0.0",
      definitionHash: "a".repeat(64),
      instanceId: "instance-one",
      serviceId: "service-one",
      dataAuthorityId: "authority-one",
    },
    object: { objectId: "opaque:对象", versionRef },
  });
const scope = (versionRef = "opaque:V1"): CognitiveDraftWriterScope => {
  const surface = { kind: "original" as const, locator: locator(versionRef) };
  return {
    key: "conversation:cognitive:" + cognitiveWorkSurfaceKey(surface),
    surface,
  };
};
const key = scope().key;
type Drafts = Record<string, InputDraft>;
function fixture(
  initial: Drafts = {},
  options: { queued?: boolean; failStorage?: boolean } = {},
) {
  let drafts = initial,
    current: CognitiveDraftWriterScope | null = scope(),
    stored: unknown;
  const pending: (() => void)[] = [],
    errors: string[] = [],
    notices: string[] = [],
    events: string[] = [];
  const commands = createExchangeDraftCommands({
    inputs: {
      value: initial,
      set(action) {
        const run = () => {
          drafts = typeof action === "function" ? action(drafts) : action;
        };
        if (options.queued) pending.push(run);
        else run();
      },
    },
    conversations: {
      value: {},
      ref: { current: {} },
      set() {
        throw Error("Unexpected conversation mutation");
      },
    },
    discarded: {
      value: {},
      set() {
        throw Error("Unexpected discarded mutation");
      },
    },
    storage: {
      readLocal: (_key, fallback) => fallback,
      writeLocal(storageKey, value) {
        assert.equal(storageKey, draftKey("inputs"));
        events.push("storage");
        if (options.failStorage) throw Error("controlled storage quota");
        stored = structuredClone(value);
      },
    },
    onNotice: (message) => notices.push(message),
  });
  const write = createCognitiveDraftWriter({
    writeInputs: commands.writeInputs,
    captureScope: () => current,
    onError: (message) => errors.push(message),
  });
  return {
    write,
    commands,
    errors,
    notices,
    events,
    drafts: () => drafts,
    stored: () => stored,
    setScope: (value: CognitiveDraftWriterScope | null) => {
      current = value;
    },
    flush: () => {
      for (const run of pending.splice(0)) run();
    },
  };
}
test("UNIT public latest writer pins the first real text and attachment edit without an ACK", () => {
  for (const value of [
    { ...empty, body: "first text", model: "my-model" },
    {
      ...empty,
      attachments: [
        {
          assetId: "a".repeat(64),
          name: "file.txt",
          mime: "text/plain" as const,
        },
      ],
    },
  ]) {
    const f = fixture();
    assert.equal(
      f.write((previous) =>
        replaceComposerSurface(previous, key, empty, value),
      ),
      undefined,
    );
    assert.deepEqual(f.drafts()[key]?.cognitiveObject, locator());
    assert.deepEqual(f.stored(), f.drafts());
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.events, ["storage"]);
  }
});
test("UNIT source is captured before a deferred updater, never at a later V2 render", () => {
  const f = fixture({}, { queued: true });
  const raw = structuredClone(scope());
  f.setScope(raw);
  assert.equal(
    f.write((previous) =>
      updateComposerDraft(previous, key, empty, (old) => ({
        ...old,
        body: "V1 edit",
      })),
    ),
    undefined,
  );
  if (raw.surface.kind !== "original") throw Error("expected original");
  Object.defineProperty(raw.surface.locator.object, "versionRef", {
    value: "mutated source",
    enumerable: true,
  });
  f.setScope(scope("opaque:V2"));
  assert.deepEqual(f.drafts(), {});
  assert.equal(f.stored(), undefined);
  f.flush();
  assert.equal(
    f.drafts()[key]?.cognitiveObject?.object.versionRef,
    "opaque:V1",
  );
});
test("UNIT queued latest drafts preserve V1 and settings even when a stale replacement has no slot", () => {
  const f = fixture({}, { queued: true });
  f.write((previous) =>
    updateComposerDraft(previous, key, empty, (old) => ({
      ...old,
      body: "first",
      model: "latest-model",
      reasoningEffort: "max",
    })),
  );
  f.setScope(scope("opaque:V2"));
  f.write((previous) =>
    updateComposerDraft(previous, key, empty, (old) => ({
      ...old,
      body: old.body + "\nsecond",
    })),
  );
  f.flush();
  assert.equal(f.drafts()[key]?.body, "first\nsecond");
  assert.equal(
    f.drafts()[key]?.cognitiveObject?.object.versionRef,
    "opaque:V1",
  );
  assert.equal(f.drafts()[key]?.model, "latest-model");
  f.write((previous) =>
    replaceComposerSurface(previous, key, empty, {
      ...empty,
      body: "stale replace",
      model: "chosen",
    }),
  );
  f.flush();
  assert.equal(
    f.drafts()[key]?.cognitiveObject?.object.versionRef,
    "opaque:V1",
  );
  assert.equal(f.drafts()[key]?.model, "chosen");
});
test("UNIT an explicit V2 slot cannot rewrite an existing V1 source", () => {
  const old = { ...empty, body: "old body", cognitiveObject: locator() };
  const f = fixture({ [key]: old });
  f.setScope(scope("opaque:V2"));
  f.write((previous) => ({
    ...previous,
    [key]: { ...old, body: "new body", cognitiveObject: locator("opaque:V2") },
  }));
  assert.equal(f.drafts()[key]?.body, "new body");
  assert.deepEqual(f.drafts()[key]?.cognitiveObject, locator());
});
test("UNIT identity or invalid slot refusal keeps the exact previous draft and reports only after execution", () => {
  const old = {
    ...empty,
    body: "saved old body",
    cognitiveObject: locator(),
    model: "preserved",
  };
  for (const objectId of ["different-object", "opaque:对象"]) {
    const f = fixture({ [key]: old }, { queued: true });
    const candidate = {
      ...old,
      body: "must not commit",
      cognitiveObject: parseCognitiveAppObjectLocator({
        ...locator(),
        object: { objectId, versionRef: "opaque:V2" },
      }),
    };
    let getters = 0;
    if (objectId === "opaque:对象")
      Object.defineProperty(candidate, "cognitiveObject", {
        enumerable: true,
        get() {
          getters++;
          return locator();
        },
      });
    assert.equal(
      f.write((previous) => ({ ...previous, [key]: candidate })),
      undefined,
    );
    assert.deepEqual(f.errors, []);
    f.flush();
    assert.strictEqual(f.drafts()[key], old);
    assert.deepEqual(f.stored(), f.drafts());
    assert.equal(f.errors.length, 1);
    assert.equal(getters, 0);
  }
});
test("UNIT unrelated keys, cleanup and special requests are never pinned or repurposed", () => {
  const old = { ...empty, body: "old", cognitiveObject: locator() };
  const f = fixture({ [key]: old });
  f.write((previous) => ({
    ...previous,
    "other:ordinary": { ...empty, body: "unrelated" },
  }));
  assert.strictEqual(f.drafts()[key], old);
  assert.equal(f.drafts()["other:ordinary"]?.cognitiveObject, undefined);
  f.write((previous) => ({
    ...previous,
    [key]: consumeComposerDraft(previous[key]!, empty),
  }));
  assert.equal(f.drafts()[key]?.cognitiveObject, undefined);
  assert.equal(f.drafts()[key]?.body, "");
  for (const fields of [
    { annotation: true },
    { revision: 2, selection: "builtin" },
    {
      continuation: {
        mode: "supplement" as const,
        inputId: "old-input",
        threadId: "old-thread",
        generation: 1,
      },
    },
    {
      pendingSupplement: {
        commandId: "old-command",
        operation: {
          type: "record-input" as const,
          projectId: "project-one",
          body: "old",
          selection: "",
          artifactId: null,
          artifactRevision: null,
          targetActantId: "morphz-agent",
        },
      },
    },
  ]) {
    const value = { ...empty, body: "special", ...fields };
    f.write((previous) => ({ ...previous, [key]: value }));
    assert.strictEqual(f.drafts()[key], value);
    assert.equal(value.cognitiveObject, undefined);
  }
  assert.deepEqual(f.errors, []);
});
test("UNIT absent cognitive scope delegates the exact original updater; model-only edits do not guess a source", () => {
  const f = fixture({ [key]: { ...empty, body: "restored unbound" } });
  f.write((previous) => ({
    ...previous,
    [key]: { ...previous[key]!, model: "new-model" },
  }));
  assert.equal(f.drafts()[key]?.cognitiveObject, undefined);
  f.setScope(null);
  f.write((previous) => ({
    ...previous,
    [key]: { ...previous[key]!, body: "legacy ordinary" },
  }));
  assert.equal(f.drafts()[key]?.cognitiveObject, undefined);
  assert.deepEqual(f.errors, []);
});
test("UNIT real writer storage failure keeps the pinned React-side state and original failure notice", () => {
  const f = fixture({}, { failStorage: true });
  assert.equal(
    f.write((previous) => ({
      ...previous,
      [key]: { ...empty, body: "keep me" },
    })),
    undefined,
  );
  assert.deepEqual(f.drafts()[key]?.cognitiveObject, locator());
  assert.equal(f.stored(), undefined);
  assert.deepEqual(f.notices, ["本地草稿保存失败，请不要刷新页面。"]);
  assert.deepEqual(f.errors, []);
});
test("UNIT a malformed or wrong-key scope fails before any updater/storage and without evaluating getters", () => {
  const f = fixture();
  f.setScope({ ...scope(), key: "old:legacy" });
  let updates = 0;
  f.write(() => {
    updates++;
    return {};
  });
  assert.equal(updates, 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.errors.length, 1);
  const raw = structuredClone(scope());
  let reads = 0;
  Object.defineProperty(raw, "surface", {
    enumerable: true,
    get() {
      reads++;
      return scope().surface;
    },
  });
  f.setScope(raw);
  f.write(() => {
    updates++;
    return {};
  });
  assert.equal(reads, 0);
  assert.equal(updates, 0);
  assert.equal(f.errors.length, 2);
});
test("UNIT a trusted view text edit never fabricates an original object", () => {
  const f = fixture();
  const surface = {
    kind: "view" as const,
    projectId: "project-one",
    connectionId: "connection-one",
    viewId: "view-one",
    authority: locator().authority,
  };
  const viewKey = "conversation:cognitive:" + cognitiveWorkSurfaceKey(surface);
  f.setScope({ key: viewKey, surface });
  f.write((previous) => ({
    ...previous,
    [viewKey]: { ...empty, body: "view text only" },
  }));
  assert.equal(f.drafts()[viewKey]?.cognitiveObject, undefined);
  assert.equal(f.drafts()[viewKey]?.body, "view text only");
  assert.deepEqual(f.errors, []);
});
test("UNIT a JSON-restored invalid old source cannot be replaced by a new head", () => {
  // Persisted JSON can contain invalid data, but cannot contain a getter.
  // New incoming candidate getters are separately rejected before any write.
  const old = {
    ...empty,
    body: "old body",
    cognitiveObject: {
      ...locator(),
      object: { objectId: "opaque:对象", versionRef: "" },
    },
  };
  const f = fixture({ [key]: old });
  f.write((previous) => ({
    ...previous,
    [key]: { ...empty, body: "no old slot in this stale replacement" },
  }));
  assert.strictEqual(f.drafts()[key], old);
  assert.equal(f.errors.length, 1);
});
