import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "morphz-dependency-install-"));
try {
  const vendor = join(fixture, "third_party", "npm");
  mkdirSync(vendor, { recursive: true });
  for (const tarball of ["braces-3.0.4-morphz.1.tgz", "minimatch-11.0.1+morphz.1.tgz"])
    copyFileSync(join(root, "third_party", "npm", tarball), join(vendor, tarball));
  for (const workspace of ["dashboard", "website"]) {
    const directory = join(fixture, workspace);
    mkdirSync(directory);
    for (const file of ["package.json", "package-lock.json"])
      copyFileSync(join(root, workspace, file), join(directory, file));
    const install = spawnSync(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(
      install.status,
      0,
      `${workspace} clean install: ${install.error ?? install.stderr}`,
    );
    const require = createRequire(join(directory, "package.json"));
    assert.equal(require("braces/package.json").version, "3.0.4-morphz.1");
    assert.throws(
      () =>
        require("braces").compile("{".repeat(4000) + "a,b" + "}".repeat(4000)),
      /nesting depth/,
    );
    const minimatch = require("minimatch");
    assert.equal(require("minimatch/package.json").version, "11.0.1+morphz.1");
    assert.equal(minimatch("src/file.ts", "src/**/*.ts"), true);
    assert.equal(minimatch.minimatch("src/file.ts", "src/**/*.ts"), true);
    assert.equal(new minimatch.Minimatch(Array(30).fill("**/../a/b").join("/"), {
      optimizationLevel: 2, braceExpandMax: 64,
    }).set.length, 64);
    console.log(`${workspace}: clean locked install and actual dependency security guards passed`);
    rmSync(directory, { recursive: true, force: true });
  }
} finally {
  // Exact disposable fixture created above; never a workspace or user profile.
  rmSync(fixture, { recursive: true, force: true });
}
