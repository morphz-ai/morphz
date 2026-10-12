import assert from "node:assert/strict";
import test from "node:test";
import { httpFixtureClient } from "./http-fixture-client.js";

test("Node fixture uses the exact test origin and one request, without swallowing errors", async () => {
  let calls = 0;
  const error = new TypeError("fixture transport failure");
  const client = httpFixtureClient(async (input, init) => {
    calls++;
    assert.equal(input, "http://127.0.0.1:65421/api/platform/bootstrap");
    assert.equal(new Headers(init?.headers).get("connection"), "close");
    assert.equal(init?.method, "GET");
    throw error;
  });
  await assert.rejects(
    client.call("platform.bootstrap"),
    (cause) => cause === error,
  );
  assert.equal(calls, 1);
});
