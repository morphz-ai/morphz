import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyTestElectron } from "../scripts/test-electron.mjs";

function fixture(context: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "morphz-test-electron-ready-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "44.2.0" }),
  );
  writeFileSync(
    join(root, "index.js"),
    'throw new Error("preflight must never import Electron");',
  );
  writeFileSync(join(root, "dist", "version"), "44.2.0");
  writeFileSync(join(root, "path.txt"), "electron");
  writeFileSync(
    join(root, "dist", "electron"),
    "TEST executable, never launched",
    { mode: 0o755 },
  );
  return root;
}

test("test Electron readiness is a read-only check of the exact installed binary", (context) => {
  const root = fixture(context);
  assert.equal(verifyTestElectron(root), join(root, "dist", "electron"));
  assert.equal(
    readFileSync(join(root, "dist", "electron"), "utf8"),
    "TEST executable, never launched",
  );
});

for (const [name, damage] of Object.entries({
  "missing completion marker": (root: string) => rmSync(join(root, "path.txt")),
  "incomplete extraction": (root: string) =>
    rmSync(join(root, "dist", "electron")),
  "stale installed version": (root: string) =>
    writeFileSync(join(root, "dist", "version"), "43.0.0"),
  "empty entry": (root: string) => writeFileSync(join(root, "path.txt"), ""),
  "outside entry": (root: string) =>
    writeFileSync(join(root, "path.txt"), "../index.js"),
  "directory instead of executable": (root: string) =>
    writeFileSync(join(root, "path.txt"), "."),
})) {
  test(`test Electron readiness refuses ${name} before any worker can import it`, (context) => {
    const root = fixture(context);
    damage(root);
    assert.throws(
      () => verifyTestElectron(root),
      /Test preparation: Electron.*install\.js/,
    );
    assert.equal(existsSync(join(root, "download-started")), false);
  });
}
