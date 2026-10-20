import assert from "node:assert/strict";
import test from "node:test";
import { createScriptLocationWriter } from "../apps/web/src/features/script/script-location-writer.js";

const location = (itemId: string) => ({ productionId: "book", itemId, view: "editor" as const });
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let witness: { owner: string; instanceId: string; revision: number } | null =
    { owner: "identity-A:lease-1", instanceId: "view-A", revision: 7 };
  const calls: { id: string; revision: number; item: string; gate: ReturnType<typeof deferred> }[] = [];
  const write = createScriptLocationWriter({
    current: () => witness && { ...witness },
    save(id, revision, state) {
      const gate = deferred();
      calls.push({ id, revision, item: state.itemId, gate });
      return gate.promise;
    },
  });
  return { write, calls, update(value: typeof witness) { witness = value; } };
}

test("rapid choices serialize confirmed view CAS receipts without changing their order or contents", async () => {
  const f = fixture();
  const first = f.write(location("one")), second = f.write(location("two")), third = f.write(location("three"));
  assert.deepEqual(f.calls.map((c) => [c.revision, c.item]), [[7, "one"]]);
  f.calls[0]!.gate.resolve();
  await first;
  assert.deepEqual(f.calls.map((c) => [c.revision, c.item]), [[7, "one"], [8, "two"]]);
  f.calls[1]!.gate.resolve();
  await second;
  f.calls[2]!.gate.resolve();
  await third;
  assert.deepEqual(f.calls.map((c) => [c.revision, c.item]), [[7, "one"], [8, "two"], [9, "three"]]);
});

test("a rejected or unknown commit does not advance CAS, retry, or dispatch queued choices", async () => {
  const f = fixture();
  const first = f.write(location("one")), second = f.write(location("two"));
  const failures = Promise.all([assert.rejects(first, /lost receipt/), assert.rejects(second, /lost receipt/)]);
  f.calls[0]!.gate.reject(new Error("lost receipt"));
  await failures;
  assert.equal(f.calls.length, 1);
});

test("another writer's revision is not treated as our own confirmed advance", async () => {
  const f = fixture();
  const first = f.write(location("one")), second = f.write(location("two"));
  f.update({ owner: "identity-A:lease-1", instanceId: "view-A", revision: 9 });
  const rejected = assert.rejects(second, /应用窗口已变化/);
  f.calls[0]!.gate.resolve();
  await first;
  await rejected;
  assert.equal(f.calls.length, 1);
});

for (const [name, current] of [
  ["unmount or inactive view", null],
  ["new identity", { owner: "identity-B:lease-1", instanceId: "view-A", revision: 7 }],
  ["return to same view in a new activation", { owner: "identity-A:lease-2", instanceId: "view-A", revision: 7 }],
  ["new instance", { owner: "identity-A:lease-1", instanceId: "view-B", revision: 7 }],
] as const)
  test(`queued location is retired after ${name}`, async () => {
    const f = fixture();
    const first = f.write(location("one")), second = f.write(location("two"));
    f.update(current);
    f.calls[0]!.gate.resolve();
    await Promise.all([first, second]);
    assert.equal(f.calls.length, 1);
  });

test("a new owner's explicit choice does not inherit a retired owner's failed queue", async () => {
  const f = fixture();
  const old = f.write(location("one"));
  const rejected = assert.rejects(old, /old failure/);
  f.update({ owner: "identity-B:lease-1", instanceId: "view-B", revision: 2 });
  const fresh = f.write(location("new"));
  assert.deepEqual(f.calls.map((c) => [c.id, c.revision]), [["view-A", 7], ["view-B", 2]]);
  f.calls[0]!.gate.reject(new Error("old failure"));
  f.calls[1]!.gate.resolve();
  await Promise.all([rejected, fresh]);
});
