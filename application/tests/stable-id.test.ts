import test from "node:test";
import assert from "node:assert/strict";
import { stableId } from "../packages/application/src/stable-id.js";

test("Host 请求的确定标识保持原编码，存储切换不改变已接收命令身份", () => {
  assert.equal(stableId(), "4f53cda1-8c2b-5a0c-8354-bb5f9a3ecbe5");
  assert.equal(
    stableId("host-input", "project", "command"),
    "5a63213c-5c75-5107-bcfa-5c8e9c34f0cd",
  );
  assert.equal(stableId("a", "bc"), "42a6f3f4-4be0-5af2-bc93-6b1547dd5e41");
  assert.equal(stableId("ab", "c"), "82582501-8f58-5795-ae2d-3d8df6a87956");
  assert.notEqual(stableId("a", "bc"), stableId("ab", "c"));
  assert.notEqual(stableId(1), stableId("1"));
});
