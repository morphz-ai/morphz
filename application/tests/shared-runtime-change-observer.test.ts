import test from "node:test";
import assert from "node:assert/strict";
import { SharedRuntimeChangeObserver } from "../packages/application/src/shared-runtime-change-observer.js";
import {
  runtimeChangeFixture,
  until,
  pause,
} from "./runtime-change-fixture.js";

test("one metadata subscription covers a large registry without reading or draining historical Events", async () => {
  const sessions = Array.from({ length: 1200 }, (_, n) => ({
    id: `session-${n}`,
    contextId: `context-${n % 3}`,
  }));
  const peer = await runtimeChangeFixture(sessions.map((s) => s.id));
  for (let n = 0; n < 1200; n++)
    peer.append("session-0", "chat/progress", {}, false);
  const changes: string[][] = [];
  const observer = new SharedRuntimeChangeObserver({
    url: peer.origin,
    sessions: () => sessions,
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    changed: (ids) => changes.push([...ids]),
  });
  try {
    await observer.sync();
    assert.equal(peer.opens.length, 1);
    assert.equal(peer.opens[0]!.sessionId, "*");
    assert.equal(peer.requests.length, 0);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.length, 1200);
    changes.length = 0;
    peer.append("session-17", "runtime/thread_phase_changed", {
      kind: "execution",
      body: "not part of the hint",
    });
    await until(() => changes.length === 1, "committed change was lost");
    assert.deepEqual(changes, [["session-17"]]);
    peer.append("session-17", "runtime/model_stream");
    peer.append("foreign", "runtime/thread_phase_changed");
    await pause(100);
    assert.equal(changes.length, 1);
    assert.equal(peer.requests.length, 0);
    await pause(2100);
    assert.equal(peer.opens.length, 1);
    assert.equal(
      peer.requests.length,
      0,
      "healthy idle must not read on an interval",
    );
  } finally {
    observer.close();
    await peer.close();
  }
});

test("subscription changes are local, reconnect closes only the current-state gap, and late removed scopes stay silent", async () => {
  const peer = await runtimeChangeFixture(["session-one", "session-two"]);
  let sessions = [{ id: "session-one", contextId: "context-one" }];
  const changes: string[][] = [];
  const observer = new SharedRuntimeChangeObserver({
    url: peer.origin,
    sessions: () => sessions,
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    changed: (ids) => changes.push([...ids]),
  });
  try {
    await observer.sync();
    changes.length = 0;
    sessions = [...sessions, { id: "session-two", contextId: "context-two" }];
    await observer.sync();
    assert.deepEqual(changes, [["session-two"]]);
    assert.equal(peer.opens.length, 1);
    sessions = sessions.filter((s) => s.id !== "session-one");
    await observer.sync();
    changes.length = 0;
    peer.append("session-one", "runtime/thread_completed");
    await pause(50);
    assert.deepEqual(changes, []);
    peer.disconnect("*");
    peer.append("session-two", "runtime/thread_completed", {}, false);
    await until(
      () => peer.opens.length === 2,
      "shared subscription did not reconnect",
    );
    await until(
      () => changes.length === 1,
      "current-state reconnect gap was not invalidated",
    );
    assert.deepEqual(changes, [["session-two"]]);
    assert.equal(peer.requests.length, 0);
    observer.close();
    peer.append("session-two", "runtime/thread_completed");
    await pause(50);
    assert.equal(changes.length, 1);
  } finally {
    observer.close();
    await peer.close();
  }
});

test("terminal metadata and transport gaps are delivered without reading or forwarding output bodies", async () => {
  const peer = await runtimeChangeFixture(["session-terminal"]);
  const frames: { topic?: string; hint?: unknown }[] = [];
  const observer = new SharedRuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-terminal", contextId: "context-terminal" }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    changed: (_ids, topic, hint) => frames.push({ topic, hint }),
  });
  try {
    await observer.sync();
    frames.length = 0;
    peer.append("session-terminal", "runtime/terminal_changed", {
      context_id: "context-terminal",
      terminal_id: "terminal-exact",
      principal_id: "principal",
      scope_ref: "scope",
      kind: "output",
      output: "excluded screen bytes",
    });
    await until(() => frames.length === 1, "terminal hint was lost");
    assert.equal(frames[0]?.topic, "runtime/terminal_changed");
    assert.deepEqual(frames[0]?.hint, {
      session_id: "session-terminal",
      context_id: "context-terminal",
      terminal_id: "terminal-exact",
      principal_id: "principal",
      scope_ref: "scope",
      kind: "output",
    });
    assert.equal(peer.requests.length, 0);
  } finally {
    observer.close();
    await peer.close();
  }
});
