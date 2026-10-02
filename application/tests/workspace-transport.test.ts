import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationCall,
  subscribeWorkspaceChanges,
} from "../apps/web/src/application-transport.js";

function nativeFixture() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let identity = "one";
  const listeners = new Set<(event: any) => void>();
  const subscriptions: Array<{
    id: string;
    scope: unknown;
    generation: string;
  }> = [];
  const removed: string[] = [];
  Reflect.set(globalThis, "window", {
    morphzDesktop: {
      application: {
        invoke: async () => ({
          ok: true,
          value: {
            centerId: "center",
            principalId: identity,
            csrfToken: "generation-" + identity,
          },
        }),
        subscribe: async (id: string, scope: unknown, generation: string) => {
          subscriptions.push({ id, scope, generation });
        },
        unsubscribe: (id: string) => removed.push(id),
        onStream: (listener: (event: any) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  });
  return {
    subscriptions,
    removed,
    listeners,
    switchIdentity: () => {
      identity = "two";
    },
    emit: (id: string, value: unknown) => {
      for (const listener of listeners) listener({ id, value });
    },
    restore: () => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}
const frame = (sequence: number, reason: "changed" | "resync" = "changed") => ({
  kind: "workspace",
  sequence,
  reason,
  accessChanged: false,
});

test("native workspace stream is strict, distinct from chat, ordered and cancellable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = nativeFixture();
  let connected = 0,
    closed = 0;
  const received: unknown[] = [];
  let dispose = () => {};
  try {
    await applicationCall("platform.bootstrap");
    dispose = subscribeWorkspaceChanges((value) => received.push(value), {
      onConnected: () => {
        connected++;
      },
      onClosed: () => {
        closed++;
      },
    });
    const first = fixture.subscriptions[0]!;
    assert.deepEqual(first.scope, { kind: "workspace" });
    assert.equal(first.generation, "generation-one");
    fixture.emit("another", frame(1));
    fixture.emit(first.id, frame(1, "resync"));
    fixture.emit(first.id, frame(1));
    fixture.emit(first.id, frame(2));
    assert.equal(connected, 1);
    assert.equal(received.length, 2);
    fixture.emit(first.id, { connected: true, messages: [] });
    assert.equal(closed, 1);
    t.mock.timers.tick(1000);
    const second = fixture.subscriptions[1]!;
    assert.notEqual(second.id, first.id);
    assert.ok(fixture.removed.includes(first.id));
    fixture.emit(first.id, frame(3));
    fixture.emit(second.id, frame(1, "resync"));
    assert.equal(connected, 2);
    assert.equal(received.length, 3);
    dispose();
    fixture.emit(second.id, frame(2));
    assert.equal(received.length, 3);
    assert.equal(fixture.listeners.size, 0);
  } finally {
    dispose();
    fixture.restore();
  }
});

test("old identity's workspace frames and reconnects cannot cross login generation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = nativeFixture();
  const received: unknown[] = [];
  let dispose = () => {};
  try {
    await applicationCall("platform.bootstrap");
    dispose = subscribeWorkspaceChanges((value) => received.push(value));
    const first = fixture.subscriptions[0]!;
    fixture.emit(first.id, frame(1));
    fixture.emit(first.id, {
      ...frame(2),
      principalId: "leaked-private-metadata",
    });
    await applicationCall("logout");
    fixture.switchIdentity();
    await applicationCall("platform.bootstrap");
    fixture.emit(first.id, frame(2));
    t.mock.timers.tick(2000);
    assert.equal(received.length, 1);
    assert.equal(fixture.subscriptions.length, 1);
  } finally {
    dispose();
    fixture.restore();
  }
});

test("Web workspace SSE resets connection-local sequence and rejects unknown fields", async () => {
  const descriptors = new Map(
    ["window", "EventSource"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    ),
  );
  let stream!: FakeStream;
  class FakeStream {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      stream = this;
    }
    close() {
      this.closed = true;
    }
  }
  Reflect.set(globalThis, "window", {});
  Reflect.set(globalThis, "EventSource", FakeStream);
  const received: unknown[] = [];
  let connected = 0,
    lost = 0;
  const dispose = subscribeWorkspaceChanges((value) => received.push(value), {
    onConnected: () => {
      connected++;
    },
    onClosed: () => {
      lost++;
    },
  });
  try {
    assert.equal(stream.url, "/api/platform/workspace/stream");
    stream.onopen!();
    stream.onmessage!({ data: JSON.stringify(frame(5, "resync")) });
    stream.onmessage!({
      data: JSON.stringify({ ...frame(6), grant: "forbidden" }),
    });
    assert.equal(lost, 1);
    assert.equal(received.length, 1);
    stream.onopen!();
    stream.onmessage!({ data: JSON.stringify(frame(1, "resync")) });
    assert.equal(connected, 2);
    assert.equal(received.length, 2);
    dispose();
    stream.onmessage!({ data: JSON.stringify(frame(2)) });
    assert.equal(received.length, 2);
    assert.equal(stream.closed, true);
  } finally {
    dispose();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
