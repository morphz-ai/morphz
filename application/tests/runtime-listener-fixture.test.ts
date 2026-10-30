import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  runtimeListenerFromJsonLine,
  stopRuntimeFixtureChild,
} from "./runtime-listener-fixture.js";

test(
  "fixture cleanup settles for both a live owned process and an already signal-terminated one",
  { timeout: 5000 },
  async () => {
    for (const alreadyExited of [false, true]) {
      const child = spawn(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      await once(child, "spawn");
      try {
        if (alreadyExited) {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await exited;
          assert.equal(child.exitCode, null);
          assert.equal(child.signalCode, "SIGTERM");
        }
        await stopRuntimeFixtureChild(child);
        assert.equal(child.signalCode, "SIGTERM");
        await stopRuntimeFixtureChild(child);
      } finally {
        await stopRuntimeFixtureChild(child);
      }
    }
  },
);

const ready = (addr: unknown) =>
  JSON.stringify({
    timestamp: "synthetic",
    level: "INFO",
    target: "morphz::web",
    fields: {
      event_code: "web.dashboard_api.started",
      addr,
      message: "Dashboard API Server started",
    },
  });
test("Runtime fixture accepts only the exact structured bound-listener receipt, not a guessed port or model text", () => {
  assert.equal(
    runtimeListenerFromJsonLine(ready("127.0.0.1:34567")),
    "http://127.0.0.1:34567",
  );
  for (const line of [
    "Dashboard API Server started 127.0.0.1:34567",
    "not JSON",
    "null",
    ready("127.0.0.1:34567").replace("morphz::web", "model::reply"),
    ready("127.0.0.1:0").replace(
      "web.dashboard_api.started",
      "app.server.started",
    ),
  ])
    assert.equal(runtimeListenerFromJsonLine(line), undefined);
  for (const address of [
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "0.0.0.0:34567",
    "remote.invalid:34567",
    "http://127.0.0.1:34567",
    null,
    34567,
  ])
    assert.throws(() => runtimeListenerFromJsonLine(ready(address)));
});
