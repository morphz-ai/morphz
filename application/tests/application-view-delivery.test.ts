import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplicationViewDelivery,
  type ApplicationViewWrite,
} from "../apps/web/src/data/application-view-delivery.js";
import type { Boot } from "../apps/web/src/client.js";
import type { Operation, Receipt } from "../packages/core/src/model.js";
const save = (url: string, expectedRevision = 7): Operation => ({
  type: "set-application-state",
  instanceId: "view",
  expectedRevision,
  state: { url },
});
const close: Operation = {
  type: "close-application",
  instanceId: "view",
  expectedRevision: 7,
};
function fixture() {
  const instance = {
    id: "view",
    workspaceId: "project",
    applicationId: "browser",
    applicationVersion: "1",
    revision: 7,
    status: "open",
  };
  const current = {
    current: {
      centerId: "center",
      principalId: "human",
      actantId: "human",
      csrfToken: "lease",
      workspace: { applicationInstances: [instance] },
    } as unknown as Boot | null,
  };
  const pending = new Map<string, ApplicationViewWrite>();
  const calls: {
    operation: Operation;
    resolve(value: Receipt): void;
    reject(error: Error): void;
  }[] = [];
  const make = () =>
    createApplicationViewDelivery({
      current,
      pending,
      execute: (operation) =>
        new Promise<Receipt>((resolve, reject) =>
          calls.push({ operation, resolve, reject }),
        ),
    });
  return { current, pending, calls, make };
}
const receipt = (id: string): Receipt => ({
  commandId: id,
  workspaceRevision: 1,
  entityId: id,
});
const turn = () => new Promise<void>((done) => setImmediate(done));

test(
  "save/save/close serialize across renders and advance only our confirmed revisions",
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const first = f.make().execute(save("one"));
    const second = f.make().execute(save("two"));
    const last = f.make().execute(close);
    assert.equal(f.calls.length, 1);
    f.current.current!.workspace.applicationInstances[0]!.revision = 8;
    const firstReceipt = receipt("one");
    f.calls[0]!.resolve(firstReceipt);
    assert.equal(await first, firstReceipt);
    await turn();
    assert.deepEqual(f.calls[1]!.operation, save("two", 8));
    f.current.current!.workspace.applicationInstances[0]!.revision = 9;
    f.calls[1]!.resolve(receipt("two"));
    await second;
    await turn();
    assert.deepEqual(f.calls[2]!.operation, { ...close, expectedRevision: 9 });
    f.current.current!.workspace.applicationInstances = [];
    f.calls[2]!.resolve(receipt("closed"));
    await last;
    assert.equal(f.pending.size, 0);
  },
);

test(
  "uncertain save prevents queued close, without retrying or advancing CAS",
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const first = f.make().execute(save("one"));
    const second = f.make().execute(close);
    const observed = Promise.all([
      assert.rejects(first, /unknown commit/),
      assert.rejects(second, /unknown commit/),
    ]);
    f.calls[0]!.reject(new Error("unknown commit"));
    await observed;
    assert.equal(f.calls.length, 1);
    assert.equal(f.pending.size, 0);
  },
);

test(
  "another writer's revision cannot be rebased onto our successful save",
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const first = f.make().execute(save("one"));
    const second = f.make().execute(close);
    const rejected = assert.rejects(second, /应用窗口已变化/);
    f.current.current!.workspace.applicationInstances[0]!.revision = 10;
    f.calls[0]!.resolve(receipt("one"));
    await first;
    await rejected;
    assert.equal(f.calls.length, 1);
  },
);

for (const replacement of ["identity", "lease", "view", "removed"])
  test(
    `queued close is rejected when ${replacement} changes`,
    { timeout: 3000 },
    async () => {
      const f = fixture();
      const first = f.make().execute(save("one"));
      const last = f.make().execute(close);
      const rejected = assert.rejects(last, /不可用或无访问权限/);
      if (replacement === "identity")
        f.current.current = { ...f.current.current!, principalId: "other" };
      if (replacement === "lease")
        f.current.current = { ...f.current.current!, csrfToken: "new" };
      if (replacement === "view")
        f.current.current!.workspace.applicationInstances[0]!.workspaceId =
          "other";
      if (replacement === "removed")
        f.current.current!.workspace.applicationInstances = [];
      f.calls[0]!.resolve(receipt("one"));
      await first;
      await rejected;
      assert.equal(f.calls.length, 1);
    },
  );

test(
  "a queued save cannot reopen a confirmed closed view",
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const first = f.make().execute(close);
    const second = f.make().execute(save("late"));
    const rejected = assert.rejects(second, /应用窗口已变化/);
    f.calls[0]!.resolve(receipt("closed"));
    await first;
    await rejected;
    assert.equal(f.calls.length, 1);
  },
);

test(
  "durable externally identified requests retain their exact payload and command identity",
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const operation = save("frozen", 3);
    const p = f.make().execute(operation, false, undefined, "external-command");
    assert.equal(f.calls[0]!.operation, operation);
    assert.equal(f.pending.size, 0);
    f.calls[0]!.resolve(receipt("frozen"));
    await p;
  },
);
