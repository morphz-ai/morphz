import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
const require = createRequire(import.meta.url);
const { registerDesktopShutdown } = require("../apps/desktop/shutdown.cjs");
const desktop = join(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/desktop",
);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: { close?: () => Promise<void>; flush?: () => Promise<void> } = {},
) {
  const app = new EventEmitter() as EventEmitter & { quit(): void };
  const exitEvents = new EventEmitter();
  const events: string[] = [];
  app.quit = () => {
    events.push("native-quit");
  };
  registerDesktopShutdown({
    app,
    exitEvents,
    hasApplication: () => true,
    close: async () => {
      events.push("close");
      await options.close?.();
    },
    flush: async () => {
      events.push("flush");
      await options.flush?.();
    },
    prepareGuard: async () => {
      events.push("prepare");
      return {
        arm: () => events.push("arm"),
        dispose: () => events.push("dispose"),
      };
    },
    reportFailure: () => events.push("failed"),
  });
  function quit() {
    let prevented = false;
    app.emit("before-quit", {
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  }
  return { app, exitEvents, events, quit };
}

test("Desktop quit waits for Host receipt barrier and storage flush; duplicate quit never bypasses them", async () => {
  const write = deferred(),
    flush = deferred();
  const f = fixture({ close: () => write.promise, flush: () => flush.promise });
  assert.equal(f.quit(), true);
  assert.equal(f.quit(), true);
  await turn();
  assert.deepEqual(f.events, ["close"]);
  write.resolve();
  await turn();
  assert.deepEqual(f.events, ["close", "flush"]);
  assert.equal(f.quit(), true);
  flush.resolve();
  await turn();
  await turn();
  assert.deepEqual(f.events, ["close", "flush", "prepare", "native-quit"]);
  assert.equal(f.quit(), false);
  // Even a prevented native window/will-quit must not arm the watchdog.
  assert.equal(f.events.includes("arm"), false);
  f.app.emit("quit");
  assert.equal(f.events.includes("arm"), false);
  f.exitEvents.emit("exit");
  assert.deepEqual(f.events, [
    "close",
    "flush",
    "prepare",
    "native-quit",
    "arm",
  ]);
});

for (const stage of ["close", "flush"] as const) {
  test(`Desktop ${stage} failure remains observable and never arms or proceeds to native quit`, async () => {
    const f = fixture({
      [stage]: async () => {
        throw new Error("private test detail");
      },
    });
    assert.equal(f.quit(), true);
    await turn();
    f.app.emit("quit");
    f.exitEvents.emit("exit");
    assert.equal(f.events.at(-1), "failed");
    assert.equal(f.events.includes("arm"), false);
    assert.equal(f.events.includes("prepare"), false);
    assert.equal(f.events.includes("native-quit"), false);
  });
}

async function runParent(mode: string) {
  const child = spawn(
    process.execPath,
    [
      join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures/desktop-shutdown-parent.cjs",
      ),
      join(desktop, "native-quit-worker.cjs"),
      mode,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: {} },
  );
  let output = "",
    error = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    error += bytes;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 5000);
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  clearTimeout(timeout);
  assert.equal(error, "");
  assert.equal(
    timedOut,
    false,
    "the test deadline must not masquerade as the quit guard",
  );
  return { code, signal, output };
}

test("actual Desktop guard gives its child only its parent identity and fixed deadline, never inherited credentials", async () => {
  const calls: unknown[][] = [];
  const child = new EventEmitter() as EventEmitter & {
    connected: boolean;
    channel: { unref(): void };
    unref(): void;
    kill(): void;
    send(value: unknown, done: () => void): void;
  };
  child.connected = true;
  child.channel = {
    unref() {
      calls.push(["unref-channel"]);
    },
  };
  child.unref = () => {
    calls.push(["unref"]);
  };
  child.kill = () => {
    calls.push(["dispose"]);
  };
  child.send = (value, done) => {
    calls.push(["send", value]);
    done();
  };
  const context = createContext({
    module: { exports: {} },
    __dirname: desktop,
    setTimeout,
    clearTimeout,
    Buffer,
    process: {
      platform: "darwin",
      pid: 4242,
      execPath: "/fixture/electron",
      env: { MODEL_API_KEY: "must-not-leak", NODE_OPTIONS: "must-not-inherit" },
    },
    require(name: string) {
      if (name === "node:path") return { join };
      if (name === "node:os") return { tmpdir: () => "/fixture/tmp" };
      if (name === "node:fs")
        return {
          mkdtempSync: (prefix: string) => prefix + "fixture",
          openSync: () => 44,
          writeSync: (fd: number, bytes: Buffer) =>
            calls.push(["marker", fd, bytes[0]]),
          closeSync: (fd: number) => calls.push(["close-marker", fd]),
          unlinkSync() {},
          rmdirSync() {},
        };
      assert.equal(name, "node:child_process");
      return {
        spawn(...args: unknown[]) {
          calls.push(args);
          queueMicrotask(() =>
            child.emit("message", { type: "ready", owner: 4242 }),
          );
          return child;
        },
      };
    },
  });
  runInContext(
    readFileSync(join(desktop, "native-quit-guard.cjs"), "utf8"),
    context,
  );
  const guard = await context.module.exports.prepareNativeQuitGuard();
  const [binary, args, options] = calls.find(
    (call) => call[0] === "/fixture/electron",
  ) as [
    string,
    string[],
    { env: Record<string, string>; stdio: Array<string | number> },
  ];
  assert.equal(binary, "/fixture/electron");
  assert.deepEqual(
    [...args],
    [join(desktop, "native-quit-worker.cjs"), "4242", "5000"],
  );
  assert.deepEqual({ ...options.env }, { ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(
    [...options.stdio],
    ["ignore", "ignore", "ignore", "ipc", 44],
  );
  guard.arm();
  assert.ok(
    calls.some(
      (call) => call[0] === "marker" && call[1] === 44 && call[2] === 1,
    ),
  );
  assert.equal(calls.filter((call) => call[0] === "close-marker").length, 1);
  guard.dispose();
  assert.equal(calls.at(-1)![0], "dispose");
});

test("native quit guard survives IPC disconnect and ends only its armed wedged parent", async () => {
  const result = await runParent("wedged");
  assert.match(result.output, /clean-quit-confirmed/);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
  // This test process is independent, not a target of the guard.
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

for (const mode of ["unarmed", "wrong-owner", "normal"]) {
  test(`native quit guard ${mode}: no implicit arming, unrelated target or leftover guard`, async () => {
    const result = await runParent(mode);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.signal, null);
    const worker = /worker:(\d+)/.exec(result.output);
    assert.ok(worker);
    // The kernel reparents an exited parent's child. Wait for its bounded
    // ownership check, rather than treating IPC disconnect as OS exit proof.
    const until = Date.now() + 1500;
    let alive = true;
    while (alive && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        process.kill(Number(worker[1]), 0);
      } catch {
        alive = false;
      }
    }
    assert.equal(
      alive,
      false,
      "orphan guard must exit without signalling a reused PID",
    );
  });
}
