import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  trustedAppURL,
  webPreferences,
  centerFromArgs,
} = require("../apps/desktop/security.cjs");
test("桌面壳不暴露 Node，禁止第三方页面与危险协议导航", () => {
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal(webPreferences.webviewTag, false);
  for (const url of [
    "https://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://127.0.0.1:65420.evil.example",
    "http://user@127.0.0.1:65420",
  ])
    assert.equal(trustedAppURL(url), false, url);
  assert.equal(trustedAppURL("http://127.0.0.1:65420/"), true);
  assert.equal(
    centerFromArgs(["--center=http://127.0.0.1:65422"]),
    "http://127.0.0.1:65422",
  );
  assert.equal(
    trustedAppURL("http://127.0.0.1:65420", "http://127.0.0.1:65422"),
    false,
  );
  for (const value of [
    "https://example.com",
    "http://127.0.0.1:65422/foreign",
    "http://user@127.0.0.1:65422",
    "file:///tmp/a",
    "http://127.0.0.1:80",
  ])
    assert.throws(() => centerFromArgs(["--center=" + value]));
});
