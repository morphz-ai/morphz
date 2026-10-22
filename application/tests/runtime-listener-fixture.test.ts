import test from "node:test";
import assert from "node:assert/strict";
import { runtimeListenerFromJsonLine } from "./runtime-listener-fixture.js";

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
