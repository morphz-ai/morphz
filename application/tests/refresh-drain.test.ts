import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshDrain } from "../apps/web/src/refresh-drain.js";

test("refresh coalesces a synchronous burst without periodic work", async () => {
  let reads = 0;
  const drain = createRefreshDrain(async () => {
    reads++;
    return true;
  });
  const first = drain.request();
  assert.equal(drain.request(), first);
  assert.equal(drain.request(), first);
  assert.equal(await first, true);
  assert.equal(reads, 1);
  await Promise.resolve();
  assert.equal(reads, 1);
});

test("a commit hint during a slow read forces a final reread for every requester", async () => {
  const releases: Array<(ok: boolean) => void> = [];
  const drain = createRefreshDrain(
    () => new Promise((resolve) => releases.push(resolve)),
  );
  const first = drain.request();
  await Promise.resolve();
  assert.equal(releases.length, 1);
  assert.equal(drain.request(), first);
  assert.equal(drain.request(), first);
  releases[0]!(false);
  await Promise.resolve();
  assert.equal(releases.length, 2);
  releases[1]!(true);
  assert.equal(await first, true);
  assert.equal(releases.length, 2);
  const next = drain.request();
  await Promise.resolve();
  releases[2]!(true);
  assert.equal(await next, true);
});

test("a failed read releases the drain so the next explicit request can retry", async () => {
  let reads = 0;
  const drain = createRefreshDrain(async () => {
    if (!reads++) throw new Error("read failed");
    return true;
  });
  await assert.rejects(drain.request(), /read failed/);
  assert.equal(await drain.request(), true);
  assert.equal(reads, 2);
});
