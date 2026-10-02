import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultAgentProfile,
  defaultHumanProfile,
  type ProfileSnapshot,
  type ProfileUpdate,
} from "../packages/core/src/profile.js";
import {
  ProfileAutosave,
  ProfileAutosaveConflictError,
} from "../apps/web/src/profile-autosave.js";

function initial(): ProfileSnapshot {
  return {
    human: {
      data: structuredClone(defaultHumanProfile),
      revision: 0,
      available: true,
      editable: true,
      enabled: false,
      avatar: { revision: 0, media: null },
    },
    agent: {
      id: "agent-personal",
      data: structuredClone(defaultAgentProfile),
      revision: 0,
      available: true,
      editable: true,
      enabled: false,
      avatar: { revision: 0, media: null },
    },
    avatarUploadAvailable: true,
  };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(snapshot = initial()) {
  let actual = structuredClone(snapshot);
  let sequence = 0;
  let active = true;
  let lostReceipt = false;
  let gate: Promise<void> | undefined;
  const calls: ProfileUpdate[] = [];
  const receipts = new Map<string, string>();
  const controller = new ProfileAutosave({
    assertScope() {
      if (!active) throw new DOMException("Scope changed", "AbortError");
    },
    changed() {},
    commandId: () => `command-${++sequence}`,
    isConflict: (error) => error instanceof ProfileAutosaveConflictError,
    async read() {
      return structuredClone(actual);
    },
    async save(command) {
      calls.push(structuredClone(command));
      if (gate) await gate;
      const frozen = JSON.stringify(command);
      const receipt = receipts.get(command.commandId);
      if (receipt) assert.equal(frozen, receipt, "retry payload is immutable");
      else {
        if (command.expectedRevision !== actual[command.subject].revision)
          throw new ProfileAutosaveConflictError("CAS conflict");
        Object.assign(actual[command.subject], {
          data: structuredClone(command.data),
          enabled: command.enabled,
          revision: command.expectedRevision + 1,
        });
        receipts.set(command.commandId, frozen);
      }
      if (lostReceipt) {
        lostReceipt = false;
        throw new Error("Receipt lost");
      }
      return structuredClone(actual);
    },
  });
  controller.hydrate(snapshot);
  return {
    controller,
    calls,
    actual: () => structuredClone(actual),
    external(next: ProfileSnapshot) {
      actual = structuredClone(next);
    },
    loseNextReceipt() {
      lostReceipt = true;
    },
    block(value: Promise<void>) {
      gate = value;
    },
    cancelScope() {
      active = false;
      controller.dispose();
    },
  };
}
const agentName = (name: string | null) => ({
  ...structuredClone(defaultAgentProfile),
  name,
});
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("network failures use Chinese feedback and keep the immutable retry command", async () => {
  for (const description of [
    "Failed to fetch",
    "NetworkError",
    "Load failed",
  ]) {
    const commands: ProfileUpdate[] = [];
    const snapshot = initial();
    const controller = new ProfileAutosave({
      assertScope() {},
      changed() {},
      isConflict: () => false,
      read: async () => snapshot,
      save: async (command) => {
        commands.push(structuredClone(command));
        if (commands.length === 1) throw new TypeError(description);
        Object.assign(snapshot[command.subject], {
          data: command.data,
          enabled: true,
          revision: command.expectedRevision + 1,
        });
        return snapshot;
      },
    });
    controller.hydrate(snapshot);
    controller.edit("agent", agentName("Echo"), true, 1000);
    await assert.rejects(controller.flush(), /保存结果未确认，请重试。/);
    assert.equal(controller.state.agent.error, "保存结果未确认，请重试。");
    await controller.retry("agent");
    assert.deepEqual(commands[1], commands[0]);
    assert.equal(controller.state.agent.error, "");
    controller.dispose();
  }
});

test("default/unset, empty controls and master priming do not write ROM", async () => {
  const h = harness();
  h.controller.edit("agent", agentName(null), false, 1000);
  await h.controller.flush();
  h.controller.edit("agent", agentName(null), true, 1000);
  await h.controller.flush();
  h.controller.edit("agent", { ...agentName(""), customStyle: "" }, true, 1000);
  h.controller.edit("human", { name: "", preferredAddress: "" }, true, 1000);
  await h.controller.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.state.agent.dirty, false);
  assert.equal(h.controller.state.agent.data?.name, "");
  assert.equal(h.controller.state.agent.data?.customStyle, "");
  assert.equal(h.controller.state.human.data?.preferredAddress, "");
  assert.equal(h.controller.state.agent.enabled, true);
  h.controller.dispose();
});

test("flush drains text debounce before admission and zero is explicit", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("E"), true, 10000);
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  const value = agentName("Echo");
  value.traits.humor = 0;
  h.controller.edit("agent", value, true, 10000);
  assert.equal(h.controller.state.agent.dirty, true);
  let admitted = false;
  await h.controller.flush().then(() => {
    assert.equal(h.actual().agent.data.name, "Echo");
    assert.equal(h.actual().agent.data.traits.humor, 0);
    admitted = true;
  });
  assert.equal(admitted, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.enabled, true);
  assert.equal(h.controller.state.agent.dirty, false);
  await delay(5);
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
});

test("edits during a save keep latest raw intent and commit serially", async () => {
  const h = harness();
  const gate = deferred();
  h.block(gate.promise);
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  const flush = h.controller.flush();
  await delay();
  assert.equal(h.controller.state.agent.saving, true);
  h.controller.edit("agent", agentName("Nora"), true, 10000);
  assert.equal(h.controller.state.agent.data?.name, "Nora");
  gate.resolve();
  await flush;
  assert.equal(h.actual().agent.data.name, "Nora");
  assert.deepEqual(
    h.calls.map((command) => [command.expectedRevision, command.data.name]),
    [
      [0, "Echo"],
      [1, "Nora"],
    ],
  );
  assert.equal(h.controller.state.agent.data?.name, "Nora");
  assert.equal(h.controller.state.agent.dirty, false);
  h.controller.dispose();
});

test("uncertain receipt is retried byte-for-byte before a newer edit", async () => {
  const h = harness();
  h.loseNextReceipt();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  await assert.rejects(h.controller.flush(), /Receipt lost/);
  assert.equal(h.actual().agent.data.name, "Echo");
  assert.equal(h.controller.state.agent.dirty, true);
  assert.throws(() => h.controller.discard("agent"), /不能丢弃/);
  h.controller.edit("agent", agentName("Nora"), true, 10000);
  await assert.rejects(h.controller.flush(), /Receipt lost/);
  assert.equal(
    h.calls.length,
    1,
    "ordinary flush never hides an uncertain write",
  );
  await h.controller.retry("agent");
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.notEqual(h.calls[2]?.commandId, h.calls[0]?.commandId);
  assert.equal(h.calls[2]?.expectedRevision, 1);
  assert.equal(h.actual().agent.data.name, "Nora");
  h.controller.dispose();
});

test("unknown pending resolves before an invalid later name; other subject still saves", async () => {
  const h = harness();
  h.loseNextReceipt();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  await assert.rejects(h.controller.flush(), /Receipt lost/);
  h.controller.edit("agent", agentName("x".repeat(41)), true, 10000);
  h.controller.edit(
    "human",
    { name: "谢先生", preferredAddress: null },
    true,
    10000,
  );
  await assert.rejects(h.controller.retry("agent"));
  assert.deepEqual(h.calls[0], h.calls[1]);
  await assert.rejects(h.controller.flush());
  assert.equal(h.actual().agent.data.name, "Echo");
  assert.equal(h.actual().human.data.name, "谢先生");
  assert.equal(h.controller.state.agent.dirty, true);
  h.controller.edit("agent", agentName("Nora"), true, 10000);
  await h.controller.flush();
  assert.equal(h.actual().agent.data.name, "Nora");
  h.controller.dispose();
});

test("new edits cannot automatically retry a frozen unknown command", async () => {
  const h = harness();
  h.loseNextReceipt();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  await assert.rejects(h.controller.flush(), /Receipt lost/);
  h.controller.edit("agent", agentName("Nora"), true, 2);
  await delay(8);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.state.agent.data?.name, "Nora");
  await h.controller.retry("agent");
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(h.actual().agent.data.name, "Nora");
  h.controller.dispose();
});

test("background receipt waits for the newest text debounce", async () => {
  const h = harness();
  const gate = deferred();
  h.block(gate.promise);
  h.controller.edit("agent", agentName("Echo"), true, 0);
  await delay(3);
  assert.equal(h.calls.length, 1);
  h.controller.edit("agent", agentName("N"), true, 10000);
  gate.resolve();
  await delay(3);
  assert.equal(h.calls.length, 1);
  assert.equal(h.actual().agent.data.name, "Echo");
  assert.equal(h.controller.state.agent.dirty, true);
  h.controller.edit("agent", agentName("Nora"), true, 10000);
  await h.controller.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.actual().agent.data.name, "Nora");
  h.controller.dispose();
});

test("partial name doesn't erase a saved name or block valid fields", async () => {
  const snapshot = initial();
  snapshot.agent = {
    ...snapshot.agent,
    data: agentName("Echo"),
    enabled: true,
    revision: 1,
  };
  const h = harness(snapshot);
  const value = agentName(" ");
  value.traits.humor = 5;
  value.customStyle = "";
  h.controller.edit("agent", value, true, 10000);
  await h.controller.flush();
  assert.equal(h.actual().agent.data.name, "Echo");
  assert.equal(h.actual().agent.data.traits.humor, 5);
  assert.equal(h.actual().agent.data.customStyle, null);
  assert.equal(h.controller.state.agent.data?.name, " ");
  assert.equal(h.controller.state.agent.data?.customStyle, "");
  assert.equal(h.controller.state.agent.dirty, false);
  h.controller.dispose();
});

test("master off keeps chosen fields; editing them does not force enable", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  await h.controller.flush();
  h.controller.edit("agent", agentName("Echo"), false, 10000);
  await h.controller.flush();
  const value = agentName("Echo");
  value.traits.humor = 5;
  h.controller.edit("agent", value, false, 10000);
  await h.controller.flush();
  assert.equal(h.actual().agent.enabled, false);
  assert.equal(h.actual().agent.data.traits.humor, 5);
  h.controller.edit("agent", agentName(null), true, 10000);
  await h.controller.flush();
  assert.equal(h.calls.at(-1)?.enabled, false);
  assert.equal(h.actual().agent.enabled, false);
  h.controller.dispose();
});

test("same semantic intent does not rewrite saved legacy empty text", async () => {
  const snapshot = initial();
  snapshot.human = {
    ...snapshot.human,
    data: { name: "谢先生", preferredAddress: "" },
    revision: 2,
    enabled: true,
  };
  const h = harness(snapshot);
  h.controller.edit("human", snapshot.human.data, true, 10000);
  await h.controller.flush();
  assert.equal(h.calls.length, 0);
  h.controller.dispose();
});

test("CAS conflict requires explicit refresh/overwrite and a new command", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  const external = initial();
  external.agent = {
    ...external.agent,
    data: agentName("Other"),
    revision: 1,
    enabled: true,
  };
  h.external(external);
  // A background read must not silently rebase an unsent local edit.
  h.controller.hydrate(external);
  await assert.rejects(h.controller.flush(), /CAS conflict/);
  assert.equal(h.calls[0]?.expectedRevision, 0);
  assert.equal(h.controller.state.agent.conflict, true);
  h.controller.edit("agent", agentName("Nora"), true, 10000);
  await assert.rejects(h.controller.retry("agent"), /别处更改/);
  assert.equal(h.calls.length, 1);
  await h.controller.resolveConflict("agent", "overwrite");
  assert.equal(h.actual().agent.data.name, "Nora");
  assert.equal(h.calls[1]?.expectedRevision, 1);
  assert.notEqual(h.calls[1]?.commandId, h.calls[0]?.commandId);
  assert.equal(h.controller.state.agent.conflict, false);
  h.controller.dispose();
});

test("explicit conflict reload/discard clears only unsent local intent", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  const external = initial();
  external.agent = {
    ...external.agent,
    data: agentName("Other"),
    revision: 1,
    enabled: true,
  };
  h.external(external);
  await assert.rejects(h.controller.flush());
  await h.controller.resolveConflict("agent", "reload");
  assert.equal(h.controller.state.agent.data, undefined);
  assert.equal(h.controller.state.agent.dirty, false);
  assert.equal(h.actual().agent.data.name, "Other");
  h.controller.edit(
    "human",
    { name: "谢先生", preferredAddress: null },
    true,
    10000,
  );
  h.controller.discard("human");
  await h.controller.flush();
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
});

test("clean overlay follows an external update rather than writing an old value", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  await h.controller.flush();
  const external = h.actual();
  external.agent = { ...external.agent, data: agentName("Other"), revision: 2 };
  h.external(external);
  h.controller.hydrate(external);
  assert.equal(h.controller.state.agent.data, undefined);
  await h.controller.flush();
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
});

test("scope change cancels timer/queued writes and ignores late result", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("Echo"), true, 2);
  h.cancelScope();
  await delay(8);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.controller.flush(), { name: "AbortError" });

  const active = harness();
  const gate = deferred();
  active.block(gate.promise);
  active.controller.edit("agent", agentName("Echo"), true, 10000);
  const flushing = active.controller.flush();
  await delay();
  active.controller.edit("agent", agentName("Nora"), true, 10000);
  active.cancelScope();
  gate.resolve();
  await assert.rejects(flushing, { name: "AbortError" });
  assert.equal(active.calls.length, 1, "no later queued edit is transmitted");
});

test("one shared queue survives editor close and serializes Human/Agent reads", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  h.controller.edit(
    "human",
    { name: "谢先生", preferredAddress: "老谢" },
    true,
    10000,
  );
  // No editor lifecycle is part of this controller: unmount/reopen does not
  // cancel the raw draft or uncertain write, and send flush admits both heads.
  await Promise.all([h.controller.flush("human"), h.controller.flush("agent")]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.actual().human.data.name, "谢先生");
  assert.equal(h.actual().agent.data.name, "Echo");
  assert.equal(h.controller.state.human.dirty, false);
  assert.equal(h.controller.state.agent.dirty, false);
  h.controller.dispose();
});

test("send flush revisits an earlier subject edited during the later subject save", async () => {
  const h = harness();
  const gate = deferred();
  h.block(gate.promise);
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  const flushing = h.controller.flush();
  await delay();
  assert.equal(h.calls[0]?.subject, "agent");
  h.controller.edit(
    "human",
    { name: "谢先生", preferredAddress: null },
    true,
    10000,
  );
  gate.resolve();
  await flushing;
  assert.equal(h.actual().human.data.name, "谢先生");
  assert.equal(h.controller.state.human.dirty, false);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("resolving one conflict does not rebase another dirty subject", async () => {
  const h = harness();
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  h.controller.edit(
    "human",
    { name: "谢先生", preferredAddress: null },
    true,
    10000,
  );
  const external = initial();
  external.agent = {
    ...external.agent,
    data: agentName("Other"),
    enabled: true,
    revision: 1,
  };
  external.human = {
    ...external.human,
    data: { name: "别人", preferredAddress: null },
    enabled: true,
    revision: 1,
  };
  h.external(external);
  await assert.rejects(h.controller.flush("agent"));
  await h.controller.resolveConflict("agent", "reload");
  await assert.rejects(h.controller.flush("human"), /CAS conflict/);
  assert.equal(h.calls.at(-1)?.expectedRevision, 0);
  assert.equal(h.actual().human.data.name, "别人");
  h.controller.dispose();
});

test("unavailable or noneditable profile never creates an unauthorised command", async () => {
  const snapshot = initial();
  snapshot.agent.editable = false;
  snapshot.human.available = false;
  const h = harness(snapshot);
  h.controller.edit("agent", agentName("Echo"), true, 10000);
  h.controller.edit(
    "human",
    { name: "谢先生", preferredAddress: null },
    true,
    10000,
  );
  await assert.rejects(h.controller.flush(), /尚未读取/);
  assert.equal(h.calls.length, 0);
  assert.match(h.controller.state.agent.error, /不能修改/);
  assert.equal(h.controller.state.agent.conflict, false);
  h.controller.dispose();
});
