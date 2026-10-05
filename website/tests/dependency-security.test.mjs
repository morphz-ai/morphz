import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

function lockedPackages(name) {
  const packages = Object.entries(lock.packages).filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
  assert.ok(packages.length > 0, `Expected ${name} in the dependency graph`);
  return packages;
}

function release(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `Security floors require a stable release: ${version}`);
  return version.split(".").map(Number);
}

function atLeast(version, minimum) {
  const actual = release(version);
  const floor = release(minimum);
  for (let index = 0; index < floor.length; index++) {
    if (actual[index] !== floor[index]) return actual[index] > floor[index];
  }
  return true;
}

test("every locked brace-expansion branch clears GHSA-q2hr-2g5m-vwhr", () => {
  const floors = new Map([[1, "1.1.21"], [2, "2.1.7"], [3, "3.0.9"], [5, "5.0.12"]]);
  for (const [path, dependency] of lockedPackages("brace-expansion")) {
    const minimum = floors.get(release(dependency.version)[0]);
    assert.ok(minimum, `Review the security floor for ${path}@${dependency.version}`);
    assert.ok(atLeast(dependency.version, minimum), `${path}@${dependency.version} must be >=${minimum}`);
  }
});

test("every locked undici branch clears the six reported HTTP, cache, retry and TLS advisories", () => {
  // GHSA-pmjh-fq2x-6v4x, GHSA-r53p-7pc4-xj5r, GHSA-2jfj-6hjv-fm6j,
  // GHSA-2gqq-gqf2-x968, GHSA-w293-vg96-wgc3 and GHSA-8436-99hf-9mmv.
  const floors = new Map([[7, "7.29.1"], [8, "8.10.2"]]);
  for (const [path, dependency] of lockedPackages("undici")) {
    const minimum = floors.get(release(dependency.version)[0]);
    assert.ok(minimum, `Review the security floor for ${path}@${dependency.version}`);
    assert.ok(atLeast(dependency.version, minimum), `${path}@${dependency.version} must be >=${minimum}`);
  }
});

test("Miniflare's exact vulnerable pin cannot reintroduce undici on a fresh install", () => {
  for (const [, dependency] of lockedPackages("miniflare")) {
    if (dependency.dependencies?.undici === "7.29.0") {
      assert.equal(manifest.overrides?.miniflare?.undici, "7.29.1");
    }
  }
});
