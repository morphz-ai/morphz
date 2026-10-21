/** Run the registered inheritance/receipt contracts through the canonical test
 * entry. Do not keep a second smoke implementation that expects the withdrawn
 * operator-default snapshot: the real Runtime tests now observe physical model
 * requests, live Session changes, explicit task overrides and stable tools.
 * Only controlled local providers and fresh test stores are used.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runtimeBinaryPath } from "./runtime-path.mjs";

const binary = runtimeBinaryPath();
assert.ok(
  existsSync(binary),
  "Build Morphz Runtime before this isolated check.",
);
const child = spawn(
  process.execPath,
  [
    "scripts/run-tests.mjs",
    "--test-concurrency=1",
    "tests/input-model-freeze.test.ts",
    "tests/infer-model-controls-runtime.test.ts",
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      MORPHZ_APP_RUNTIME_BINARY: binary,
      MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E: "1",
    },
    stdio: "inherit",
  },
);
const interrupt = () => child.kill("SIGINT");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
