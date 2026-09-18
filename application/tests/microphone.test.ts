import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { MicrophoneGate } = createRequire(import.meta.url)("../apps/desktop/microphone.cjs");
test("麦克风只授权一次可信主页面的音频请求，取消、过期与其他页面拒绝", () => {
  let now = 100;
  const gate = new MicrophoneGate("http://127.0.0.1:65420", () => now);
  const details = { requestingUrl: "http://127.0.0.1:65420/", isMainFrame: true, mediaTypes: ["audio"] };
  assert.equal(gate.request(true, "media", details), false);
  gate.arm();
  for (const change of [{ isMainFrame: false }, { mediaTypes: ["audio", "video"] }, { mediaTypes: ["video"] }, { mediaTypes: [] }, { requestingUrl: "https://example.com/" }]) assert.equal(gate.request(true, "media", { ...details, ...change }), false);
  assert.equal(gate.request(false, "media", details), false);
  assert.equal(gate.request(true, "clipboard-read", details), false);
  assert.equal(gate.request(true, "media", details), true);
  assert.equal(gate.request(true, "media", details), false);
  gate.arm(); gate.cancel(); assert.equal(gate.request(true, "media", details), false);
  gate.arm(); now += 15000; assert.equal(gate.request(true, "media", details), false);
});
