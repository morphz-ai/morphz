import assert from "node:assert/strict";
import test from "node:test";
import { nativeTestEnvironment } from "./fixtures/native-test-environment.js";

test("isolated native tests preserve the X display and its authorization together", () => {
  const source = Object.freeze({
    PATH: "/test/bin",
    HOME: "/test/home",
    DISPLAY: ":97",
    XAUTHORITY: "/test/private/Xauthority",
    XDG_RUNTIME_DIR: "/test/runtime",
    OPENAI_API_KEY: "never-forward",
    MORPHZ_TEST_POSTGRES_URL: "never-forward",
    MORPHZ_APP_PROFILE: "never-forward",
    ELECTRON_RUN_AS_NODE: "never-forward",
    UNRELATED_SECRET: "never-forward",
  });
  assert.deepEqual(nativeTestEnvironment(source), {
    PATH: "/test/bin",
    HOME: "/test/home",
    DISPLAY: ":97",
    XAUTHORITY: "/test/private/Xauthority",
    XDG_RUNTIME_DIR: "/test/runtime",
  });
});

test("native test environment neither invents a display nor changes the caller", () => {
  const source = Object.freeze({ PATH: "/test/bin", TMPDIR: undefined });
  assert.deepEqual(nativeTestEnvironment(source), { PATH: "/test/bin" });
  assert.deepEqual(source, { PATH: "/test/bin", TMPDIR: undefined });
});
