import assert from "node:assert/strict";
import test from "node:test";
import { platformMessageFixture } from "./platform-message-fixture.js";

test("a fixture Session IO subscription returns absent Session without inventing events or work", async () => {
  const fixture = await platformMessageFixture();
  try {
    const session = "/api/sessions/TEST-unexecuted-session";
    const missing = await fetch(fixture.runtimeOrigin + session);
    const expected = await missing.json();
    assert.equal(missing.status, 404);
    for (const suffix of [
      "/io/stream",
      "/io/stream?after=TEST-opaque-cursor",
    ]) {
      const response = await fetch(fixture.runtimeOrigin + session + suffix);
      assert.equal(response.status, 404);
      assert.match(
        response.headers.get("content-type") ?? "",
        /application\/json/,
      );
      assert.deepEqual(await response.json(), expected);
    }
    assert.deepEqual(fixture.deliveries(), []);
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});

test("fixture Session IO recognition does not permit unknown paths or write operations", async () => {
  const fixture = await platformMessageFixture();
  try {
    for (const [method, path] of [
      ["GET", "/api/sessions/TEST-unexecuted-session/io/stream-extra"],
      ["GET", "/api/sessions/TEST-unexecuted-session/io/stream/nested"],
      ["GET", "/api/sessions//io/stream"],
      ["POST", "/api/sessions/TEST-unexecuted-session/io/stream"],
      ["GET", "/api/unknown-fixture-operation"],
    ]) {
      const response = await fetch(fixture.runtimeOrigin + path, { method });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "Unexpected Runtime request",
      });
    }
    assert.throws(() => fixture.assertNoLegacyData(), assert.AssertionError);
    assert.deepEqual(fixture.deliveries(), []);
  } finally {
    await fixture.close();
  }
});
