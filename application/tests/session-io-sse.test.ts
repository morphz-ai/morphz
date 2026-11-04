import assert from "node:assert/strict";
import test from "node:test";
import { sessionIoFrames } from "../packages/core/src/session-io-sse.js";

test("Session IO framing retains split UTF-8, CRLF and accepted cursors without exposing incomplete frames", async () => {
  const bytes = new TextEncoder().encode(
    'id: accepted-1\r\ndata: {"text":"界面"}\r\n\r\n: heartbeat\r\n\r\nid: accepted-2\ndata: {"text":"next"}\n\ndata: {"incomplete":',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 3)
        controller.enqueue(bytes.slice(at, at + 3));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of sessionIoFrames(
    stream,
    new AbortController().signal,
  ))
    frames.push(frame);
  assert.deepEqual(frames, [
    { data: { text: "界面" }, id: "accepted-1" },
    { data: { text: "next" }, id: "accepted-2" },
  ]);
});
test("retiring a stream cancels its reader and frame/cursor budgets cannot be bypassed", async () => {
  let cancelled = 0;
  const owner = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"first":true}\n\n'));
    },
    cancel() {
      cancelled++;
    },
  });
  const iterator = sessionIoFrames(stream, owner.signal);
  assert.deepEqual((await iterator.next()).value, { data: { first: true } });
  owner.abort();
  await assert.rejects(iterator.next());
  assert.equal(cancelled, 1);
  for (const frame of [
    `id: ${"x".repeat(2049)}\ndata: {}\n\n`,
    "x".repeat(4 * 1024 * 1024 + 1),
  ]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    await assert.rejects(async () => {
      for await (const _ of sessionIoFrames(
        body,
        new AbortController().signal,
      )) {
        void _;
      }
    }, /bounds/);
  }
});
