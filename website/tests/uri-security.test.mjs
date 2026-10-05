import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const webpackRequire = createRequire(require.resolve("webpack"));
const schemaUtilsRequire = createRequire(webpackRequire.resolve("schema-utils"));
const ajvRequire = createRequire(schemaUtilsRequire.resolve("ajv"));
const uri = ajvRequire("fast-uri");

// GHSA-hrr3-gc8f-f4qj: a percent-decoded host must be case-folded too,
// including scheme-relative references used in host allowlists/denylists.
test("URI parsing case-folds percent-encoded uppercase hosts", () => {
  for (const input of ["//%41.com", "//A.com", "//a.com"]) {
    assert.equal(uri.parse(input).host, "a.com", input);
    assert.equal(uri.normalize(input), "//a.com", input);
    assert.equal(uri.equal(input, "//a.com"), true, input);
  }
});

test("every locked fast-uri branch clears the host-normalization advisory", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const dependencies = Object.entries(lock.packages).filter(([path]) => path === "node_modules/fast-uri" || path.endsWith("/node_modules/fast-uri"));
  assert.ok(dependencies.length > 0);
  const floors = new Map([[2, [4, 7]], [3, [1, 8]], [4, [1, 5]]]);
  for (const [path, dependency] of dependencies) {
    assert.match(dependency.version, /^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = dependency.version.split(".").map(Number);
    const minimum = floors.get(major);
    assert.ok(minimum, `Review the security floor for ${path}@${dependency.version}`);
    assert.ok(minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1]), `${path}@${dependency.version} is below the patched release`);
  }
});
