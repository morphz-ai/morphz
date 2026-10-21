import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionEvaluationEditor,
  sessionEvaluationEditorKey,
} from "../apps/web/src/session-evaluation-editor.js";
import type {
  SessionEvaluationDefaults,
  SessionEvaluationSnapshot,
} from "../packages/core/src/session-evaluation.js";

const defaults: SessionEvaluationDefaults = {
  model: "test-a",
  reasoningEffort: "low",
};

test("Session editor identity ignores page/object drafts but isolates conversation, identity and unsent drafts", () => {
  const input = {
    identity: "human-a",
    identityGeneration: "generation-a",
    enabled: true,
    scope: {
      projectId: "conversation-owner",
      conversationId: "global-conversation",
    },
    draftKey: "dialogue",
  };
  const key = sessionEvaluationEditorKey(input);
  for (const draftKey of [
    "inbox",
    "reader:book-a",
    "reader:book-b",
    "browser",
    "terminal",
  ])
    assert.equal(sessionEvaluationEditorKey({ ...input, draftKey }), key);
  assert.notEqual(
    sessionEvaluationEditorKey({
      ...input,
      scope: { projectId: "project-a", conversationId: "named-a" },
    }),
    key,
  );
  assert.notEqual(
    sessionEvaluationEditorKey({
      ...input,
      identityGeneration: "generation-b",
    }),
    key,
  );
  assert.notEqual(
    sessionEvaluationEditorKey({ ...input, identity: "human-b" }),
    key,
  );
  assert.notEqual(
    sessionEvaluationEditorKey({ ...input, scope: undefined }),
    sessionEvaluationEditorKey({
      ...input,
      scope: undefined,
      draftKey: "other-unsent",
    }),
  );
});
const snapshot = (
  fields: Partial<SessionEvaluationSnapshot> = {},
): SessionEvaluationSnapshot => ({
  scope: {
    projectId: "project-a",
    conversationId: "conversation-a",
    kind: "global",
  },
  runtimeSessionId: "session-a",
  defaults: { ...defaults },
  source: "runtime",
  canUpdate: true,
  readOnlyReason: null,
  fingerprint: "1".repeat(64),
  ...fields,
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    noScope?: boolean;
    missing?: boolean;
    seed?: SessionEvaluationDefaults;
  } = {},
) {
  let actual = options.missing
    ? snapshot({
        source: "not_started",
        runtimeSessionId: null,
        fingerprint: null,
        canUpdate: false,
        readOnlyReason: "not_started",
        defaults: { model: null, reasoningEffort: null },
      })
    : snapshot();
  let active = true,
    reads = 0,
    revision = 1;
  let readError: unknown,
    writeError: unknown,
    lostReceipt = false;
  let holdRead: Promise<void> | undefined, holdWrite: Promise<void> | undefined;
  const entered = deferred();
  const writes: {
    defaults: SessionEvaluationDefaults;
    fingerprint: string | null;
  }[] = [];
  const drafts: SessionEvaluationDefaults[] = [];
  const editor = new SessionEvaluationEditor(
    options.seed ?? { model: "stale-draft-model", reasoningEffort: "max" },
    {
      assertScope() {
        if (!active) throw new DOMException("Scope changed", "AbortError");
      },
      read: options.noScope
        ? undefined
        : async () => {
            reads++;
            await holdRead;
            if (readError) throw readError;
            return structuredClone(actual);
          },
      async save(value, baseline) {
        writes.push({
          defaults: structuredClone(value),
          fingerprint: baseline.fingerprint,
        });
        entered.resolve();
        await holdWrite;
        if (writeError) throw writeError;
        if (baseline.fingerprint !== actual.fingerprint)
          throw new Error("Conflict");
        actual = snapshot({
          defaults: structuredClone(value),
          fingerprint: String(++revision).repeat(64),
        });
        if (lostReceipt) throw new Error("Receipt lost");
        return structuredClone(actual);
      },
      changed() {},
      localDraft(value) {
        drafts.push(value);
      },
      isRejected: (error) => error === "validation-rejected",
    },
  );
  return {
    editor,
    writes,
    drafts,
    entered,
    reads: () => reads,
    actual: () => structuredClone(actual),
    external(value: SessionEvaluationSnapshot) {
      actual = value;
    },
    cancel() {
      active = false;
      editor.cancelScheduled();
    },
    holdRead(gate: Promise<void>) {
      holdRead = gate;
    },
    holdWrite(gate: Promise<void>) {
      holdWrite = gate;
    },
    failRead(error: unknown) {
      readError = error;
    },
    failWrite(error: unknown) {
      writeError = error;
    },
    loseReceipt() {
      lostReceipt = true;
    },
  };
}

test("an existing Session ignores stale draft bindings and reading never writes", async () => {
  const f = fixture();
  assert.equal(f.editor.state.editable, false);
  await f.editor.refresh();
  assert.deepEqual(f.editor.state.defaults, defaults);
  assert.equal(await f.editor.prepareInput(), undefined);
  assert.equal(f.reads(), 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.drafts.length, 0);
});

test("a new named draft has no read/write; first admission carries only its initial pair", async () => {
  const f = fixture({ noScope: true });
  f.editor.edit({ model: "test-b", reasoningEffort: "none" });
  assert.deepEqual(await f.editor.prepareInput(), {
    model: "test-b",
    reasoningEffort: "none",
  });
  assert.equal(f.reads(), 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.drafts, [{ model: "test-b", reasoningEffort: "none" }]);
});

test("a missing Session keeps a local first-input choice without creating or PATCHing", async () => {
  const f = fixture({ missing: true });
  await f.editor.refresh();
  f.editor.edit({ reasoningEffort: null });
  assert.deepEqual(await f.editor.prepareInput(), {
    model: "stale-draft-model",
    reasoningEffort: null,
  });
  assert.equal(f.writes.length, 0);
  assert.equal(f.reads(), 1);
  const untouched = fixture({
    missing: true,
    seed: { model: null, reasoningEffort: null },
  });
  assert.equal(await untouched.editor.prepareInput(), undefined);
  assert.equal(untouched.writes.length, 0);
});

test("rapid slider edits coalesce and immediate send flushes the latest pair", async () => {
  const f = fixture();
  await f.editor.refresh();
  f.editor.edit({ reasoningEffort: "medium" }, 100_000);
  f.editor.edit({ reasoningEffort: "high" }, 100_000);
  f.editor.edit({ reasoningEffort: "max" }, 100_000);
  assert.equal(await f.editor.prepareInput(), undefined);
  assert.deepEqual(f.writes, [
    {
      defaults: { ...defaults, reasoningEffort: "max" },
      fingerprint: "1".repeat(64),
    },
  ]);
  assert.equal(f.editor.state.saving, false);
  assert.equal(f.editor.state.defaults.reasoningEffort, "max");
});

test("reopening the menu before debounce saves the retained choice only after checking its base", async () => {
  const f = fixture();
  await f.editor.refresh();
  f.editor.edit({ reasoningEffort: "max" }, 100_000);
  assert.equal(f.editor.state.pending, true);
  await f.editor.refresh();
  assert.equal(f.writes.length, 1);
  assert.equal(f.reads(), 2);
  assert.equal(f.actual().defaults.reasoningEffort, "max");
  assert.equal(f.editor.state.pending, false);
});

test("an edit during an in-flight save stays usable and drains with the confirmed next fingerprint", async () => {
  const f = fixture(),
    gate = deferred();
  await f.editor.refresh();
  f.holdWrite(gate.promise);
  f.editor.edit({ reasoningEffort: "max" }, 100_000);
  const pending = f.editor.prepareInput();
  await f.entered.promise;
  assert.equal(f.editor.state.saving, true);
  assert.equal(f.editor.state.editable, true);
  f.editor.edit({ model: "test-b", reasoningEffort: "none" }, 100_000);
  assert.equal(f.writes.length, 1);
  gate.resolve();
  assert.equal(await pending, undefined);
  f.editor.cancelScheduled();
  assert.deepEqual(f.writes, [
    {
      defaults: { ...defaults, reasoningEffort: "max" },
      fingerprint: "1".repeat(64),
    },
    {
      defaults: { model: "test-b", reasoningEffort: "none" },
      fingerprint: "2".repeat(64),
    },
  ]);
  assert.deepEqual(f.editor.state.defaults, {
    model: "test-b",
    reasoningEffort: "none",
  });
});

test("an unknown write blocks admission and automatic replay; explicit reread uses actual saved defaults", async () => {
  const f = fixture();
  await f.editor.refresh();
  f.loseReceipt();
  f.editor.edit({ reasoningEffort: "max" }, 100_000);
  await assert.rejects(f.editor.prepareInput(), /Receipt lost/);
  assert.equal(f.editor.state.needsRead, true);
  assert.equal(f.editor.state.editable, false);
  await assert.rejects(f.editor.prepareInput(), /Receipt lost/);
  assert.equal(f.writes.length, 1);
  await f.editor.refresh(true);
  assert.equal(await f.editor.prepareInput(), undefined);
  assert.deepEqual(f.editor.state.defaults, f.actual().defaults);
  assert.equal(f.writes.length, 1);
});

test("a definite pre-write validation rejection permits correction but never retries an unchanged invalid choice", async () => {
  const f = fixture();
  await f.editor.refresh();
  f.failWrite("validation-rejected");
  f.editor.edit({ reasoningEffort: "max" }, 100_000);
  await assert.rejects(f.editor.prepareInput());
  assert.equal(f.editor.state.editable, true);
  assert.equal(f.editor.state.needsRead, false);
  await assert.rejects(f.editor.prepareInput());
  assert.equal(f.writes.length, 1);
  f.failWrite(undefined);
  f.editor.edit({ reasoningEffort: "none" }, 100_000);
  await f.editor.prepareInput();
  assert.equal(f.actual().defaults.reasoningEffort, "none");
  assert.equal(f.writes.length, 2);
});

test("a different writer is not silently rebased; the local body and new remote choice remain untouched", async () => {
  const f = fixture();
  await f.editor.refresh();
  f.editor.edit({ reasoningEffort: "max" }, 100_000);
  f.external(
    snapshot({
      defaults: { model: "remote-b", reasoningEffort: "none" },
      fingerprint: "9".repeat(64),
    }),
  );
  await assert.rejects(f.editor.refresh(), /会话模型已变化/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.editor.state.defaults.reasoningEffort, "max");
  await assert.rejects(f.editor.prepareInput());
  await f.editor.refresh(true);
  assert.deepEqual(f.editor.state.defaults, {
    model: "remote-b",
    reasoningEffort: "none",
  });
  assert.equal(await f.editor.prepareInput(), undefined);
});

test("a failed initial read does not convert a stored draft into task or Session authority", async () => {
  const f = fixture();
  f.failRead(new Error("Read unavailable"));
  await assert.rejects(f.editor.refresh(), /Read unavailable/);
  await assert.rejects(f.editor.prepareInput(), /Read unavailable/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.editor.state.editable, false);
  f.failRead(undefined);
  await f.editor.refresh(true);
  assert.deepEqual(f.editor.state.defaults, defaults);
});

test("a late read or write after scope invalidation cannot authorize a new input", async () => {
  const f = fixture(),
    gate = deferred();
  f.holdRead(gate.promise);
  const pending = f.editor.refresh();
  f.cancel();
  gate.resolve();
  await assert.rejects(pending, /Scope changed/);
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.editor.prepareInput(), /Scope changed/);

  const w = fixture(),
    saveGate = deferred();
  await w.editor.refresh();
  w.holdWrite(saveGate.promise);
  w.editor.edit({ reasoningEffort: "max" }, 100_000);
  const saving = w.editor.prepareInput();
  await w.entered.promise;
  w.cancel();
  saveGate.resolve();
  await assert.rejects(saving, /Scope changed/);
  assert.equal(
    w.writes.length,
    1,
    "An accepted old-scope write is not rolled back or replayed",
  );
});

test("read-only runtime settings are readable and cannot be edited; none and null stay distinct", async () => {
  const f = fixture();
  f.external(
    snapshot({
      canUpdate: false,
      readOnlyReason: "team_managed",
      defaults: { model: null, reasoningEffort: "none" },
    }),
  );
  await f.editor.refresh();
  assert.equal(f.editor.state.editable, false);
  assert.throws(() => f.editor.edit({ reasoningEffort: "max" }), /重新读取/);
  assert.equal(await f.editor.prepareInput(), undefined);
  assert.deepEqual(f.editor.state.defaults, {
    model: null,
    reasoningEffort: "none",
  });
  assert.equal(f.writes.length, 0);
});
