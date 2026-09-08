import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  rendererURL,
  preferenceSeed,
} = require("../apps/desktop/development.cjs");
const center = "http://127.0.0.1:65424";

test("热更新只在开发模式切换渲染地址，发布壳与中心地址不变", () => {
  assert.equal(rendererURL(center, false, true), center);
  assert.equal(rendererURL(center, true, false), "http://127.0.0.1:65419");
  assert.throws(() => rendererURL(center, true, true));
  assert.throws(() => rendererURL("http://127.0.0.1:65419", true, false));
});

test("开发偏好迁移限定同中心同身份，不覆盖已有偏好，也不复制其他存储", () => {
  const previous = {
    centerId: "center",
    principalId: "alice",
    entries: [
      ["morphzwork:center:alice:preferences", "existing"],
      ["morphzwork:center:alice:draft:a:document", "draft"],
      ["morphzwork:center:bob:preferences", "private"],
      ["token", "secret"],
    ],
  };
  const current = {
    centerId: "center",
    principalId: "alice",
    entries: [["morphzwork:center:alice:preferences", "newer"]],
  };
  assert.deepEqual(preferenceSeed(previous, current), [
    ["morphzwork:center:alice:draft:a:document", "draft"],
  ]);
  assert.deepEqual(
    preferenceSeed(previous, { ...current, centerId: "other" }),
    [],
  );
  assert.deepEqual(
    preferenceSeed(previous, { ...current, principalId: "bob" }),
    [],
  );
  assert.deepEqual(preferenceSeed(previous, null), []);
});
