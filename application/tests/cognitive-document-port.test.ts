import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import {
  createCognitiveDocumentPort,
  CognitiveDocumentPortError,
} from "../apps/web/src/host/cognitive-document-port.js";

const connect = '{"type":"morphz-cognitive-ui/v1:connect"}';
type NativeFrame = { kind?: unknown; text?: unknown; sequence?: unknown };
type Bridge = ReturnType<typeof createCognitiveDocumentPort>;

/** Actual Node native MessageChannel, not Chromium, SQL, Electron, author SDK
 * or production mounting. The private peer is a controlled trusted endpoint;
 * malicious direct-native frames do not imply authors possess this endpoint. */
function fixture(
  options: {
    onWire?: (bridge: Bridge) => void;
    onReady?: (bridge: Bridge) => void;
  } = {},
) {
  const { port1, port2 } = new MessageChannel();
  const frames: NativeFrame[] = [],
    posted: NativeFrame[] = [],
    wires: string[] = [];
  const observers = new Set<() => void>();
  let ready = 0,
    retired = 0;
  const notify = () => {
    for (const observer of [...observers]) observer();
  };
  const nativePost = port1.postMessage;
  // Transparent observation only: every accepted post uses the actual native
  // method and the peer below must receive its structured-cloned frame.
  port1.postMessage = function (...args) {
    posted.push(args[0] as NativeFrame);
    return nativePost.apply(this, args);
  };
  port2.on("message", (message: NativeFrame) => {
    frames.push(message);
    notify();
  });
  const bridge = createCognitiveDocumentPort(port1 as unknown as MessagePort, {
    onWire(text) {
      wires.push(text);
      options.onWire?.(bridge);
      notify();
    },
    onReady() {
      ready++;
      options.onReady?.(bridge);
      notify();
    },
    onRetire() {
      retired++;
      notify();
    },
  });
  async function wait(predicate: () => boolean, description: string) {
    if (predicate()) return;
    let timer!: ReturnType<typeof setTimeout>;
    let observe!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        observe = () => {
          if (predicate()) resolve();
        };
        observers.add(observe);
        timer = setTimeout(
          () => reject(new Error(`Missing actual native ${description}`)),
          3000,
        );
        observe();
      });
    } finally {
      clearTimeout(timer);
      observers.delete(observe);
    }
  }
  let barrierSequence = 0;
  return {
    bridge,
    port: port1,
    peer: port2,
    frames,
    posted,
    wires,
    ready: () => ready,
    retired: () => retired,
    wait,
    async parserReady() {
      port2.postMessage({ kind: "parser-ready" });
      await wait(() => ready === 1, "parser-ready consumption");
    },
    async barrier() {
      // An actual FIFO wire callback is a positive observation that preceding
      // credit frames were consumed. There is no sleep or exposed credit seam.
      const text = JSON.stringify(["native-test-barrier", ++barrierSequence]);
      port2.postMessage({ kind: "wire", text });
      await wait(() => wires.includes(text), "FIFO wire consumption barrier");
      return text;
    },
    close() {
      bridge.dispose();
      port1.close();
      port2.close();
    },
  };
}
const denied = (code: "busy" | "retired" | "invalid") => (error: unknown) => {
  assert.ok(error instanceof CognitiveDocumentPortError);
  assert.equal(error.code, code);
  return true;
};

test(
  "ACTUAL Node native port: Host cannot post before private parser-ready; one strict early connect is consumed without publishing",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      assert.throws(() => f.bridge.send('"premature-init"'), denied("busy"));
      assert.equal(f.posted.length, 0);
      f.peer.postMessage({ kind: "wire", text: connect });
      await f.wait(() => f.frames.length === 1, "early connect credit");
      assert.deepEqual(f.wires, [connect]);
      assert.deepEqual(f.frames, [{ kind: "credit", sequence: 1 }]);
      assert.equal(f.ready(), 0);
      assert.throws(() => f.bridge.send('"still-premature"'), denied("busy"));
      assert.equal(
        f.posted.length,
        1,
        "Only the legitimate early-connect transport credit was posted.",
      );
      await f.parserReady();
      f.bridge.send('"after-ready"');
      await f.wait(() => f.frames.length === 2, "normal post-ready wire");
      assert.deepEqual(f.frames[1], { kind: "wire", text: '"after-ready"' });
      assert.equal(f.retired(), 0);
    } finally {
      f.close();
    }
  },
);

for (const text of [
  '"ordinary-pre-ready-data"',
  '{"type":"morphz-cognitive-ui/v1:connect","extra":true}',
  '{"type":"morphz-cognitive-ui/v1:request"}',
  '{"kind":"parser-ready"}',
])
  test(
    `ACTUAL Node native port: pre-ready non-connect wire retires without ACK or callback: ${text}`,
    { timeout: 10000 },
    async () => {
      const f = fixture();
      try {
        f.peer.postMessage({ kind: "wire", text });
        await f.wait(() => f.retired() === 1, "pre-ready retirement");
        assert.deepEqual(f.wires, []);
        assert.equal(f.ready(), 0);
        assert.equal(f.posted.length, 0);
        assert.throws(() => f.bridge.send('"retired"'), denied("retired"));
      } finally {
        f.close();
      }
    },
  );

test(
  "ACTUAL Node native port: a second early connect is not queued, credited or retried",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      f.peer.postMessage({ kind: "wire", text: connect });
      await f.wait(() => f.frames.length === 1, "first early-connect credit");
      f.peer.postMessage({ kind: "wire", text: connect });
      await f.wait(() => f.retired() === 1, "second early-connect retirement");
      assert.deepEqual(f.wires, [connect]);
      assert.deepEqual(f.posted, [{ kind: "credit", sequence: 1 }]);
      assert.equal(f.ready(), 0);
    } finally {
      f.close();
    }
  },
);

test(
  "ACTUAL Node native port: Host native egress caps at 16; one continuous real credit restores exactly one slot without retry",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      await f.parserReady();
      for (let sequence = 1; sequence <= 16; sequence++)
        f.bridge.send(JSON.stringify(sequence));
      assert.throws(() => f.bridge.send('"not-posted-17"'), denied("busy"));
      assert.equal(f.posted.length, 16);
      await f.wait(
        () => f.frames.length === 16,
        "all sixteen native wire frames",
      );
      assert.deepEqual(
        f.frames,
        Array.from({ length: 16 }, (_, index) => ({
          kind: "wire",
          text: JSON.stringify(index + 1),
        })),
      );
      f.peer.postMessage({ kind: "credit", sequence: 1 });
      await f.barrier();
      f.bridge.send('"new-17"');
      assert.throws(
        () => f.bridge.send('"still-not-posted-18"'),
        denied("busy"),
      );
      await f.wait(
        () => f.frames.filter((frame) => frame.kind === "wire").length === 17,
        "one restored native send",
      );
      assert.equal(
        f.posted.filter((frame) => frame.kind === "wire").length,
        17,
      );
      assert.equal(
        f.frames.some(
          (frame) =>
            frame.text === '"not-posted-17"' ||
            frame.text === '"still-not-posted-18"',
        ),
        false,
      );
      assert.equal(f.retired(), 0);
    } finally {
      f.close();
    }
  },
);

test(
  "ACTUAL Node native port: sixteen FIFO consumption credits open exactly a second bounded window without replaying rejected sends",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      await f.parserReady();
      for (let sequence = 1; sequence <= 16; sequence++)
        f.bridge.send(JSON.stringify(["first", sequence]));
      assert.throws(
        () => f.bridge.send('"rejected-first-window"'),
        denied("busy"),
      );
      await f.wait(
        () => f.frames.length === 16,
        "first window actual native consumption",
      );
      for (let sequence = 1; sequence <= 16; sequence++)
        f.peer.postMessage({ kind: "credit", sequence });
      await f.barrier();
      for (let sequence = 1; sequence <= 16; sequence++)
        f.bridge.send(JSON.stringify(["second", sequence]));
      assert.throws(
        () => f.bridge.send('"rejected-second-window"'),
        denied("busy"),
      );
      await f.wait(
        () => f.frames.filter((frame) => frame.kind === "wire").length === 32,
        "second window actual native consumption",
      );
      const wireFrames = f.frames.filter((frame) => frame.kind === "wire");
      assert.deepEqual(
        wireFrames.slice(16),
        Array.from({ length: 16 }, (_, index) => ({
          kind: "wire",
          text: JSON.stringify(["second", index + 1]),
        })),
      );
      assert.equal(
        f.posted.filter((frame) => frame.kind === "wire").length,
        32,
      );
      assert.equal(
        wireFrames.some(
          (frame) =>
            frame.text === '"rejected-first-window"' ||
            frame.text === '"rejected-second-window"',
        ),
        false,
      );
      assert.equal(f.retired(), 0);
    } finally {
      f.close();
    }
  },
);

test(
  "ACTUAL Node native port: duplicate parser-ready cannot reinitialize the peer",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      await f.parserReady();
      f.peer.postMessage({ kind: "parser-ready" });
      await f.wait(
        () => f.retired() === 1,
        "duplicate parser-ready retirement",
      );
      assert.equal(f.ready(), 1);
      assert.equal(f.posted.length, 0);
    } finally {
      f.close();
    }
  },
);

test(
  "ACTUAL Node native port: credit before parser-ready cannot create a first unearned send slot",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      f.peer.postMessage({ kind: "credit", sequence: 1 });
      await f.wait(
        () => f.retired() === 1,
        "unearned pre-ready credit retirement",
      );
      assert.equal(f.ready(), 0);
      assert.equal(f.posted.length, 0);
      assert.deepEqual(f.wires, []);
    } finally {
      f.close();
    }
  },
);

test(
  "ACTUAL Node native port: a native array with frame-like own fields is not a control or wire frame",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      await f.parserReady();
      const packet = Object.assign([], { kind: "wire", text: '"array-frame"' });
      f.peer.postMessage(packet);
      await f.wait(() => f.retired() === 1, "native array retirement");
      assert.equal(f.posted.length, 0);
      assert.deepEqual(f.wires, []);
    } finally {
      f.close();
    }
  },
);

for (const attack of [
  "replay",
  "skip",
  "beyond-sent",
  "unsafe",
  "fractional",
  "extra",
] as const)
  test(
    `ACTUAL Node native port: ${attack} native credit retires exactly once and releases no unearned slot`,
    { timeout: 10000 },
    async () => {
      const f = fixture();
      try {
        await f.parserReady();
        if (attack !== "beyond-sent") {
          for (let sequence = 1; sequence <= 16; sequence++)
            f.bridge.send(JSON.stringify(sequence));
          await f.wait(
            () => f.frames.length === 16,
            "positive original sixteen frames",
          );
        }
        if (attack === "replay") {
          f.peer.postMessage({ kind: "credit", sequence: 1 });
          await f.barrier();
        }
        const before = f.posted.length;
        const sequence =
          attack === "skip"
            ? 2
            : attack === "unsafe"
              ? Number.MAX_SAFE_INTEGER + 1
              : attack === "fractional"
                ? 1.5
                : 1;
        f.peer.postMessage({
          kind: "credit",
          sequence,
          ...(attack === "extra" ? { text: "private-control-not-wire" } : {}),
        });
        await f.wait(() => f.retired() === 1, "malformed control retirement");
        assert.equal(
          f.posted.length,
          before,
          "No credit, wire or business ACK is generated by malformed credit.",
        );
        assert.throws(() => f.bridge.send('"unearned"'), denied("retired"));
        f.bridge.dispose();
        assert.equal(f.retired(), 1);
      } finally {
        f.close();
      }
    },
  );

test(
  "ACTUAL Node native port: nested business JSON cannot inject native credit or parser-ready",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      await f.parserReady();
      for (let sequence = 1; sequence <= 16; sequence++)
        f.bridge.send(JSON.stringify(sequence));
      await f.wait(() => f.frames.length === 16, "sixteen held wire frames");
      for (const text of [
        '{"kind":"credit","sequence":1}',
        '{"kind":"parser-ready"}',
      ]) {
        f.peer.postMessage({ kind: "wire", text });
        await f.wait(
          () => f.wires.includes(text),
          "ordinary business JSON consumption",
        );
        assert.throws(
          () => f.bridge.send('"no-credit-earned"'),
          denied("busy"),
        );
      }
      assert.equal(f.ready(), 1);
      assert.equal(
        f.posted.filter((frame) => frame.kind === "wire").length,
        16,
      );
      assert.deepEqual(
        f.posted.filter((frame) => frame.kind === "credit"),
        [
          { kind: "credit", sequence: 1 },
          { kind: "credit", sequence: 2 },
        ],
      );
    } finally {
      f.close();
    }
  },
);

test(
  "ACTUAL Node native port: send budgets reject before native post and retain the original active channel",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      await f.parserReady();
      for (const invalid of [
        "not JSON",
        JSON.stringify({ value: "x".repeat(524_288) }),
        JSON.stringify({ value: "😀".repeat(131_073) }),
        "[".repeat(41) + "0" + "]".repeat(41),
        JSON.stringify(Array.from({ length: 32768 }, () => 0)),
      ])
        assert.throws(() => f.bridge.send(invalid));
      assert.equal(f.posted.length, 0);
      f.bridge.send('"valid-positive-control"');
      await f.wait(
        () => f.frames.length === 1,
        "valid wire after send rejection",
      );
      assert.deepEqual(f.frames, [
        { kind: "wire", text: '"valid-positive-control"' },
      ]);
      assert.equal(f.retired(), 0);
    } finally {
      f.close();
    }
  },
);

for (const invalid of [
  { kind: "wire", text: "not JSON" },
  { kind: "wire", text: JSON.stringify({ value: "😀".repeat(131_073) }) },
  { kind: "wire", text: "[".repeat(41) + "0" + "]".repeat(41) },
  { kind: "wire", text: '"valid"', extra: true },
  { kind: "parser-ready", extra: true },
])
  test(
    `ACTUAL Node native port: malformed native ingress ${invalid.kind}/${Object.keys(invalid).length} fields retires without consumption credit`,
    { timeout: 10000 },
    async () => {
      const f = fixture();
      try {
        await f.parserReady();
        f.peer.postMessage(invalid);
        await f.wait(
          () => f.retired() === 1,
          "invalid native ingress retirement",
        );
        assert.deepEqual(f.wires, []);
        assert.equal(f.posted.length, 0);
      } finally {
        f.close();
      }
    },
  );

test(
  "ACTUAL Node native port: callback disposal precedes credit; accepted old wire cannot ACK or publish another native wire",
  { timeout: 10000 },
  async () => {
    const f = fixture({
      onWire(bridge) {
        bridge.dispose();
      },
    });
    try {
      await f.parserReady();
      f.peer.postMessage({ kind: "wire", text: '"old-document-wire"' });
      await f.wait(() => f.retired() === 1, "callback-triggered retirement");
      assert.deepEqual(f.wires, ['"old-document-wire"']);
      assert.equal(f.posted.length, 0);
      assert.throws(() => f.bridge.send('"post-disposal"'), denied("retired"));
      assert.equal(f.posted.length, 0);
      // No assertion equates MessagePort.close() with immediate native queue GC.
    } finally {
      f.close();
    }
  },
);

test(
  "ACTUAL Node native port: onReady disposal does not escape synchronous lifecycle checks",
  { timeout: 10000 },
  async () => {
    const f = fixture({
      onReady(bridge) {
        bridge.dispose();
      },
    });
    try {
      f.peer.postMessage({ kind: "parser-ready" });
      await f.wait(() => f.retired() === 1, "onReady disposal");
      assert.equal(f.ready(), 1);
      assert.equal(f.posted.length, 0);
      assert.throws(() => f.bridge.send('"retired-ready"'), denied("retired"));
    } finally {
      f.close();
    }
  },
);

for (const field of ["kind", "text", "sequence", "extra"] as const)
  test(`CONTROLLED UNIT descriptor ingress: ${field} accessor is rejected without invoking the getter`, () => {
    const f = fixture();
    try {
      let getters = 0;
      const packet: Record<string, unknown> =
        field === "sequence"
          ? { kind: "credit", sequence: 1 }
          : { kind: "wire", text: '"data"' };
      Object.defineProperty(packet, field, {
        enumerable: true,
        get() {
          getters++;
          throw new Error("PRIVATE fixture accessor");
        },
      });
      // Not structured clone: native clone may run sender-side getters. This
      // explicit synthetic Event tests receiver descriptor discipline only.
      f.port.dispatchEvent(new MessageEvent("message", { data: packet }));
      assert.equal(getters, 0);
      assert.equal(f.retired(), 1);
      assert.deepEqual(f.wires, []);
      assert.equal(f.posted.length, 0);
    } finally {
      f.close();
    }
  });
