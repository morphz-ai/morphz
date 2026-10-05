import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  createCognitiveViewInvalidation,
  type CognitiveViewInvalidation,
} from "../apps/web/src/host/cognitive-view-invalidation.js";
import { composeSource } from "./fixtures/cognitive-compose-data.js";

// Finite UNIT clock/transport/lease controls only. No SQL, HPA, production
// mounting, author SDK execution or entitlement claim follows from these.
function fixture() {
  const source = composeSource();
  const slot = {
    projectId: source.binding.projectId,
    appId: source.authority.appId,
    version: source.authority.version,
    expectedDefinitionHash: source.authority.definitionHash,
  };
  const location = () => ({
    slot: {
      projectId: slot.projectId,
      appId: slot.appId,
      version: slot.version,
      definitionHash: slot.expectedDefinitionHash,
    },
    view: {
      viewId: source.view.id,
      viewRevision: source.view.revision,
      status: "open" as "open" | "closed",
      binding: {
        bindingRevision: source.binding.revision,
        connectionId: source.binding.connectionId,
        instanceId: source.binding.instanceId,
        serviceId: source.binding.serviceId,
        dataAuthorityId: source.binding.dataAuthorityId,
      },
    },
  });
  let current = true,
    now = 0;
  const retired: CognitiveViewInvalidation[] = [];
  const calls: Array<{
    slot: unknown;
    signal: AbortSignal;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }> = [];
  const timers: Array<{ live: boolean; callback(): void }> = [];
  const observer = createCognitiveViewInvalidation({
    source,
    slot,
    current: () => current,
    locate(slot, signal) {
      return new Promise((resolve, reject) => {
        // Intentionally ignore abort. Production must fence every late reply.
        calls.push({ slot: structuredClone(slot), signal, resolve, reject });
      });
    },
    onRetire: (value) => retired.push(value),
    timing: {
      now: () => now,
      deadline(callback, milliseconds) {
        assert.equal(milliseconds, 30_000);
        const timer = { live: true, callback };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    },
  });
  return {
    source,
    slot,
    location,
    observer,
    calls,
    retired,
    timers,
    owner(value: boolean) {
      current = value;
    },
    advance(milliseconds: number, fire = true) {
      now += milliseconds;
      if (fire) for (const timer of timers) if (timer.live) timer.callback();
    },
  };
}
test("UNIT initial exact locator only; same-token renders and higher own-save CAS keep the initial source warm without UI/body/CAS publication", async () => {
  const f = fixture();
  const initial = structuredClone(f.source);
  f.observer.invalidate(0);
  await setImmediate();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.slot, f.slot);
  for (let i = 0; i < 1000; i++) f.observer.invalidate(0);
  const ownSave = f.location();
  ownSave.view.viewRevision = 3;
  f.calls[0]!.resolve(ownSave);
  await setImmediate();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.retired, []);
  assert.deepEqual(f.source, initial);
  assert.equal(f.timers.filter((t) => t.live).length, 0);
  f.observer.invalidate(1);
  await setImmediate();
  assert.equal(f.calls.length, 2);
  f.calls[1]!.resolve(f.location());
  await setImmediate();
  assert.deepEqual(f.retired, []);
  f.observer.dispose();
});
test("UNIT observer captures only initial scalar metadata, never HTML/state/body, and contradictory initial slot is rejected before any read", async () => {
  const f = fixture();
  f.observer.dispose();
  let bodyReads = 0;
  Object.defineProperty(f.source.view, "state", {
    get() {
      bodyReads++;
      throw Error("No state read permitted");
    },
  });
  if (f.source.manifest.ui.type === "sandbox")
    Object.defineProperty(f.source.manifest.ui, "html", {
      get() {
        bodyReads++;
        throw Error("No HTML read permitted");
      },
    });
  const own = createCognitiveViewInvalidation({
    slot: f.slot,
    source: f.source,
    current: () => true,
    locate: async (slot) => {
      assert.deepEqual(slot, f.slot);
      return f.location();
    },
    onRetire: () => assert.fail("unchanged scalar metadata must stay warm"),
  });
  own.invalidate(0);
  await setImmediate();
  assert.equal(bodyReads, 0);
  own.dispose();
  assert.throws(() =>
    createCognitiveViewInvalidation({
      slot: { ...f.slot, expectedDefinitionHash: "c".repeat(64) },
      source: f.source,
      current: () => true,
      locate: async () => assert.fail("invalid initial slot cannot read"),
      onRetire: () => assert.fail("no owner was admitted"),
    }),
  );
  assert.equal(bodyReads, 0);
});
test("UNIT 1000-event storm retains one in-flight plus latest dirty; superseded close cannot publish and only one latest successor is read", async () => {
  const f = fixture();
  f.observer.invalidate(0);
  await setImmediate();
  for (let token = 1; token <= 1000; token++) f.observer.invalidate(token);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.filter((t) => t.live).length, 1);
  const superseded = f.location();
  superseded.view.status = "closed";
  f.calls[0]!.resolve(superseded);
  await setImmediate();
  assert.deepEqual(f.retired, []);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.filter((t) => t.live).length, 1);
  f.calls[1]!.resolve(f.location());
  await setImmediate();
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.filter((t) => t.live).length, 0);
  f.observer.invalidate(1000);
  f.observer.invalidate(999);
  await setImmediate();
  assert.equal(f.calls.length, 2);
  f.observer.dispose();
});
test("UNIT exact absent/closed/unbound metadata retires once and never reads a UI or retries", async () => {
  for (const status of ["absent", "closed", "unbound"] as const) {
    const f = fixture();
    f.observer.invalidate(0);
    await setImmediate();
    const current = f.location();
    const reply = {
      ...current,
      view:
        status === "absent"
          ? null
          : {
              ...current.view,
              status: status === "closed" ? "closed" : "open",
              binding: status === "unbound" ? null : current.view.binding,
            },
    };
    f.calls[0]!.resolve(reply);
    await setImmediate();
    assert.equal(f.retired[0]!.status, status);
    assert.equal(Object.isFrozen(f.retired[0]), true);
    f.observer.invalidate(1);
    await setImmediate();
    assert.equal(f.calls.length, 1);
    assert.equal(f.retired.length, 1);
    assert.equal(f.timers.filter((t) => t.live).length, 0);
  }
});
test("UNIT wrong slot/hash/view, regressed revision or fixed binding/connection/authority changes fail closed", async () => {
  const changes: Array<
    (value: ReturnType<ReturnType<typeof fixture>["location"]>) => void
  > = [
    (v) => {
      v.slot.projectId = "other";
    },
    (v) => {
      v.slot.appId = "example.other";
    },
    (v) => {
      v.slot.version = "2.0.0";
    },
    (v) => {
      v.slot.definitionHash = "c".repeat(64);
    },
    (v) => {
      v.view.viewId = "other";
    },
    (v) => {
      v.view.viewRevision = 1;
    },
    (v) => {
      v.view.binding.bindingRevision++;
    },
    (v) => {
      v.view.binding.connectionId = "other";
    },
    (v) => {
      v.view.binding.instanceId = "other";
    },
    (v) => {
      v.view.binding.serviceId = "other/service";
    },
    (v) => {
      v.view.binding.dataAuthorityId = "other/data";
    },
  ];
  for (const change of changes) {
    const f = fixture();
    f.observer.invalidate(0);
    await setImmediate();
    const current = f.location();
    change(current);
    f.calls[0]!.resolve(current);
    await setImmediate();
    assert.equal(f.retired[0]!.status, "error");
    f.observer.invalidate(1);
    assert.equal(f.calls.length, 1);
  }
});
test("UNIT strict metadata accessor is never invoked; invalid hint starts no request", async () => {
  let getters = 0;
  const f = fixture();
  f.observer.invalidate(0);
  await setImmediate();
  const raw = Object.defineProperty({}, "slot", {
    enumerable: true,
    get() {
      getters++;
      return f.location().slot;
    },
  });
  f.calls[0]!.resolve(raw);
  await setImmediate();
  assert.equal(getters, 0);
  assert.equal(f.retired[0]!.status, "error");
  for (const token of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = fixture();
    invalid.observer.invalidate(token);
    await setImmediate();
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.retired[0]!.status, "error");
  }
});
test("UNIT actual denial is terminal even with dirty hints; no failure retry", async () => {
  const f = fixture();
  f.observer.invalidate(0);
  await setImmediate();
  f.observer.invalidate(1);
  f.calls[0]!.reject(Error("CONTROLLED_LOCATE_DENIED"));
  await setImmediate();
  assert.equal(f.retired[0]!.status, "error");
  assert.equal(f.calls[0]!.signal.aborted, true);
  f.observer.invalidate(2);
  assert.equal(f.calls.length, 1);
});
test("UNIT absolute 30s timeout aborts current read and late ignored-abort reply cannot publish or retry", async () => {
  const f = fixture();
  f.observer.invalidate(0);
  await setImmediate();
  f.observer.invalidate(1);
  f.advance(30_000);
  assert.equal(f.calls[0]!.signal.aborted, true);
  assert.equal(f.retired[0]!.status, "error");
  if (f.retired[0]!.status === "error")
    assert.match(f.retired[0]!.message, /超时/);
  f.calls[0]!.resolve(f.location());
  await setImmediate();
  assert.equal(f.retired.length, 1);
  assert.equal(f.calls.length, 1);
  f.observer.invalidate(2);
  assert.equal(f.calls.length, 1);
});
test("UNIT late reply exceeding absolute deadline is rejected even when the timer has not fired", async () => {
  const f = fixture();
  f.observer.invalidate(0);
  await setImmediate();
  f.advance(30_001, false);
  f.calls[0]!.resolve(f.location());
  await setImmediate();
  assert.equal(f.retired[0]!.status, "error");
  assert.equal(f.calls[0]!.signal.aborted, true);
});
test("UNIT navigation/identity/cleanup owner retirement aborts before any late reply; no old callback may clear a newer owner", async () => {
  for (const event of ["dispose", "owner"] as const) {
    const f = fixture();
    f.observer.invalidate(0);
    await setImmediate();
    f.observer.invalidate(1);
    if (event === "dispose") f.observer.dispose();
    else {
      f.owner(false);
      f.observer.invalidate(2);
    }
    assert.equal(f.calls[0]!.signal.aborted, true);
    f.owner(true);
    const closed = f.location();
    closed.view.status = "closed";
    f.calls[0]!.resolve(closed);
    await setImmediate();
    f.observer.invalidate(3);
    assert.deepEqual(f.retired, []);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.filter((t) => t.live).length, 0);
  }
  const f = fixture();
  f.observer.invalidate(0);
  f.owner(false);
  await setImmediate();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.retired, []);
});
