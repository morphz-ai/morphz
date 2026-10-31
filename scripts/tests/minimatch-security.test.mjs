import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../../", import.meta.url);
const version = "11.0.1+morphz.1";
const patch = "\n// Local export adapter only; matching remains unchanged upstream 11.0.1.\nmodule.exports = Object.assign(exports.minimatch, exports);\n";
const receipt = JSON.parse(readFileSync(new URL("third_party/npm/minimatch/UPSTREAM.json", root)));
const selected = basename(process.cwd());
const workspaces = ["dashboard", "website"].includes(selected) ? [selected] : ["dashboard", "website"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("the security matcher retains every upstream JavaScript byte, with only the documented CommonJS export adapter", () => {
  assert.equal(receipt.version, "11.0.1");
  for (const [path, hash] of Object.entries(receipt.code_sha256)) {
    let source = readFileSync(new URL(`third_party/npm/minimatch/${path}`, root), "utf8");
    if (path === "dist/commonjs/index.js") {
      assert.ok(source.endsWith(patch));
      source = source.slice(0, -patch.length);
    }
    assert.equal(digest(source), hash, path);
  }
});

for (const workspace of workspaces) {
  const require = createRequire(new URL(`${workspace}/package.json`, root));
  test(`${workspace}: installed modern and legacy lint callers use the same patched matcher`, async () => {
    const matcher = require("minimatch");
    assert.equal(require("minimatch/package.json").version, version);
    for (const path of Object.keys(receipt.code_sha256))
      assert.equal(digest(readFileSync(new URL(`${workspace}/node_modules/minimatch/${path}`, root))),
        digest(readFileSync(new URL(`third_party/npm/minimatch/${path}`, root))), path);
    const esm = await import(new URL(`${workspace}/node_modules/minimatch/dist/esm/index.js`, root));
    for (const [file, pattern, options, expected] of [
      ["src/file.ts", "src/**/*.ts", {}, true],
      ["src/file.js", "src/**/*.ts", {}, false],
      [".config.ts", "*.ts", {}, false],
      [".config.ts", "*.ts", { dot: true }, true],
      ["src/File.TS", "**/*.ts", { nocase: true }, true],
      ["src/file.ts", "*.ts", { matchBase: true }, true],
      ["src/file.tsx", "src/*.{ts,tsx}", {}, true],
      ["src/test.ts", "src/!(test).ts", {}, false],
      ["src/file.ts", "!src/*.js", {}, true],
    ]) {
      for (const actual of [matcher(file, pattern, options), matcher.minimatch(file, pattern, options),
        new matcher.Minimatch(pattern, options).match(file), esm.minimatch(file, pattern, options)])
        assert.equal(actual, expected, `${file}: ${pattern}`);
    }
    assert.deepEqual(matcher.match(["a.ts", "b.js"], "*.ts"), ["a.ts"]);
    assert.equal(matcher.defaults({ dot: true })(".config.ts", "*.ts"), true);
    const lock = JSON.parse(readFileSync(new URL(`${workspace}/package-lock.json`, root)));
    const instances = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/minimatch$/.test(path));
    assert.ok(instances.length > 0);
    for (const [path, entry] of instances) assert.equal(entry.version, version, path);
  });

  test(`${workspace}: the upstream globparts amplification attack stops at its configured bound`, () => {
    // A real isolated invocation, not a source-string assertion or a disabled
    // audit. The old preprocessing expands this pattern exponentially.
    const source = `const assert = require('node:assert/strict');
      const {Minimatch} = require(${JSON.stringify(require.resolve("minimatch"))});
      const pattern = Array(30).fill('**/../a/b').join('/');
      const matcher = new Minimatch(pattern, {optimizationLevel:2, braceExpandMax:64});
      assert.equal(matcher.set.length,64);`;
    execFileSync(process.execPath, ["--eval", source], { timeout: 10_000, stdio: "pipe" });
  });
}
