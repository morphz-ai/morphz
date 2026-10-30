"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { releasePolicy } = require("../release-policy.cjs");
const root = path.resolve(__dirname, "../..");

test("RC is explicitly a prerelease and can never become latest", () => {
  assert.deepEqual(releasePolicy("0.1.4-rc.1", "v0.1.4-rc.1"), {
    version: "0.1.4-rc.1", tag: "v0.1.4-rc.1", prerelease: "true",
    make_latest: "false", release_branch: "release/0.1.4",
  });
});

test("final versions are stable and all SemVer prereleases stay isolated", () => {
  assert.equal(releasePolicy("0.1.4", "v0.1.4").make_latest, "true");
  for (const value of ["0.1.4-alpha.1", "0.1.4-beta", "0.1.4-rc.2+build.37"]) {
    assert.equal(releasePolicy(value, `v${value}`).prerelease, "true");
    assert.equal(releasePolicy(value, `v${value}`).make_latest, "false");
  }
  assert.equal(releasePolicy("0.1.4+build.37", "v0.1.4+build.37").prerelease, "false");
});

test("invalid, coerced, noncanonical and output-injection versions fail closed", () => {
  for (const value of ["", "0.1", "01.1.4", "0.01.4", "v0.1.4", "=0.1.4", " 0.1.4",
    "0.1.4\nmake_latest=true", "0.1.4-rc.01", "0.1.4-", "0.1.4+", "0.1.4/rc.1"]) {
    assert.throws(() => releasePolicy(value, `v${value}`), undefined, value);
  }
});

test("tag matching is exact and cannot turn an RC build into a stable tag", () => {
  for (const tag of ["v0.1.4", "0.1.4-rc.1", "v0.1.4-rc.2", "v0.1.4-rc.1\n"]) {
    assert.throws(() => releasePolicy("0.1.4-rc.1", tag), /exactly match/);
  }
});

test("production CLI emits only validated GitHub output and errors are nonzero", () => {
  const script = path.join(root, "scripts/release-policy.cjs");
  const good = spawnSync(process.execPath, [script, "0.1.4-rc.1", "v0.1.4-rc.1"], { encoding: "utf8" });
  assert.equal(good.status, 0);
  assert.match(good.stdout, /^prerelease=true$/m);
  assert.match(good.stdout, /^make_latest=false$/m);
  const bad = spawnSync(process.execPath, [script, "0.1.4-rc.1", "v0.1.4"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
});

test("full main and release CI cannot be filtered out by changed paths", () => {
  for (const file of ["ci.yml", "application.yml"]) {
    const source = fs.readFileSync(path.join(root, ".github/workflows", file), "utf8");
    const entry = source.split("\njobs:", 1)[0];
    assert.equal((entry.match(/branches: \[main, "release\/\*\*"\]/g) ?? []).length, 2);
    assert.doesNotMatch(entry, /\bpaths(?:-ignore)?:/);
  }
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  for (const workflow of ["application-native-regressions.yml", "linux-sandbox-service.yml"]) {
    assert.ok(ci.includes(`uses: ./.github/workflows/${workflow}`));
    const source = fs.readFileSync(path.join(root, ".github/workflows", workflow), "utf8");
    assert.match(source.split("\njobs:", 1)[0], /^  workflow_call:/m);
  }
  assert.ok(ci.includes("node --test scripts/tests/release-policy.test.cjs"));
  assert.ok(ci.includes("python3 -B -m unittest discover -s scripts/tests -p 'test_release_*.py' -v"));
});

test("publish needs exact-commit complete CI and explicit channel flags", () => {
  const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const publish = release.split("\n  publish:\n")[1];
  assert.match(publish, /needs: \[validate-tag, complete-ci,/);
  assert.match(publish, /actions: read/);
  assert.match(publish, /scripts\/verify-release-ci\.py/);
  assert.match(publish, /commits\/\$RELEASE_TAG/);
  assert.match(publish, /channel_args=\(--latest="\$RELEASE_MAKE_LATEST"\)/);
  assert.match(publish, /channel_args\+=\(--prerelease\)/);
  assert.match(publish, /"\$\{channel_args\[@\]\}"/);
  assert.match(publish, /pattern: morphz-\*/);
  assert.match(publish, /python3 -B scripts\/verify-release-assets\.py dist > "\$RUNNER_TEMP\/release-assets\.txt"/);
  assert.match(publish, /mapfile -t release_assets < "\$RUNNER_TEMP\/release-assets\.txt"/);
  assert.match(publish, /gh release create "\$RELEASE_TAG" "\$\{release_assets\[@\]\}"/);
  assert.doesNotMatch(publish, /dist\/\*|<\s*<\(/);
  assert.match(release, /node scripts\/release-policy\.cjs "\$package_version" "\$RELEASE_TAG"/);
  assert.equal((release.match(/MORPHZ_VERSION="\$\{\{ needs.validate-tag.outputs.tag \}\}"/g) ?? []).length, 2);
});
