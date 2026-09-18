import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  runtimeBinaryPath,
  repositoryRoot,
} = require("../scripts/runtime-path.mjs");

test("application integration resolves this repository's Runtime independently of cwd", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  assert.equal(repositoryRoot, root);
  for (const cwd of [root, join(root, "application"), "/unrelated/work"])
    assert.equal(
      runtimeBinaryPath({}, { cwd, platform: "darwin" }),
      join(root, "target/debug/morphz"),
    );
  assert.equal(
    runtimeBinaryPath({}, { platform: "win32" }),
    join(root, "target/debug/morphz.exe"),
  );
});

test("explicit Runtime paths and legacy aliases retain precedence without guessing", () => {
  const options = { cwd: "/fixture/operator", root: "/fixture/checkout" };
  assert.equal(
    runtimeBinaryPath({ MORPHZ_APP_RUNTIME_BINARY: "custom/morphz" }, options),
    resolve(options.cwd, "custom/morphz"),
  );
  assert.equal(
    runtimeBinaryPath(
      { MORPHZWORK_RUNTIME_BINARY: "/fixture/legacy" },
      options,
    ),
    "/fixture/legacy",
  );
  assert.equal(
    runtimeBinaryPath(
      {
        MORPHZ_APP_RUNTIME_BINARY: "/fixture/new",
        MORPHZWORK_RUNTIME_BINARY: "/fixture/legacy",
      },
      options,
    ),
    "/fixture/new",
  );
  assert.throws(
    () =>
      runtimeBinaryPath(
        {
          MORPHZ_APP_RUNTIME_BINARY: "",
          MORPHZWORK_RUNTIME_BINARY: "/fixture/legacy",
        },
        options,
      ),
    /must name an executable path/,
  );
});
