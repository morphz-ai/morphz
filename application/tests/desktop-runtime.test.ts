import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareLocalHostTools } from "../packages/application/src/host-tools-ipc.js";

test("Runtime launcher accepts the Host manifest budget without loosening private configuration checks", () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-runtime-launcher-"));
  try {
    const center = join(root, "center");
    mkdirSync(center, { mode: 0o700 });
    const manifest = prepareLocalHostTools(center, randomUUID()).path;
    const validManifest = readFileSync(manifest);
    assert.ok(validManifest.byteLength > 128 * 1024);
    assert.ok(validManifest.byteLength <= 256 * 1024);
    const config = join(center, "runtime.json");
    writeFileSync(
      config,
      JSON.stringify({ url: "http://127.0.0.1:18089", token: "test-only" }),
      { mode: 0o600 },
    );
    const keyFile = join(root, "test.env");
    writeFileSync(keyFile, "TEST_MODEL_KEY=fixture-only", { mode: 0o600 });
    const run = () => {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/desktop-runtime.mjs", import.meta.url),
          ),
          `--root=${root}`,
          `--binary=${join(root, "intentionally-absent-runtime")}`,
          `--model-key-file=${keyFile}`,
          "--model-key-name=TEST_MODEL_KEY",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.status, 1);
      return result.stderr;
    };
    // A valid generated manifest reaches the next preflight check. There is no
    // Runtime binary, so this test never launches a process or binds a port.
    assert.match(run(), /Existing Runtime files are missing/);
    const invalid = /Configuration must be a bounded private regular file/;
    writeFileSync(manifest, " ".repeat(256 * 1024 + 1));
    assert.match(run(), invalid);
    writeFileSync(manifest, validManifest);
    chmodSync(manifest, 0o644);
    assert.match(run(), invalid);
    chmodSync(manifest, 0o600);
    const alternate = join(center, "linked-manifest.json");
    writeFileSync(alternate, validManifest, { mode: 0o600 });
    unlinkSync(manifest);
    symlinkSync(alternate, manifest);
    assert.match(run(), invalid);
    unlinkSync(manifest);
    writeFileSync(manifest, validManifest, { mode: 0o600 });
    writeFileSync(keyFile, "TEST_MODEL_KEY=" + "a".repeat(128 * 1024));
    assert.match(run(), invalid);
    writeFileSync(keyFile, "TEST_MODEL_KEY=fixture-only");
    writeFileSync(config, " ".repeat(128 * 1024 + 1));
    assert.match(run(), invalid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
