import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/application.yml", import.meta.url),
  "utf8",
);
const jobs = [
  "web",
  "storage-postgres",
  "desktop",
  "cognitive-runtime-contract",
  "runtime-contract",
];

function jobSource(source, name) {
  const header = `\n  ${name}:\n`;
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${name} job`);
  const tail = source.slice(start + header.length);
  const next = tail.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? tail : tail.slice(0, next);
}

function installer(name) {
  return `node ${name === "runtime-contract" ? "application/" : ""}node_modules/electron/install.js`;
}

function verify(source) {
  for (const name of jobs) {
    const job = jobSource(source, name);
    const command = installer(name);
    const prepare = job.indexOf(command);
    const dependencies = job.indexOf("npm ci");
    const tests = job.search(/\bnpm(?: --prefix application)? test\b/);
    assert.ok(
      dependencies >= 0 && prepare > dependencies && tests > prepare,
      `${name}: install Electron after npm ci and before parallel test consumers`,
    );
    assert.equal(job.split(command).length, 2, `${name}: one installer owner`);
    const step = job.slice(
      job.lastIndexOf("      - ", prepare),
      job.indexOf("\n      - ", prepare),
    );
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/);
  }
  for (const name of ["web", "storage-postgres"]) {
    const job = jobSource(source, name);
    assert.match(job, /apt-get install[^\n]*\bxvfb\b[^\n]*\bxauth\b/);
    assert.match(job, /xvfb-run -a npm test/);
    assert.ok(
      job.indexOf("xvfb xauth") < job.indexOf("xvfb-run -a npm test"),
      `${name}: a virtual display must exist before the full native inventory`,
    );
  }
}

test("every managed application CI job prepares pinned Electron before parallel imports", () =>
  verify(workflow));

for (const name of jobs) {
  test(`${name}: missing, late or ignored Electron preparation is rejected`, () => {
    const job = jobSource(workflow, name),
      command = installer(name);
    for (const changed of [
      job.replace(command, "echo missing"),
      job.replace(command, "echo too-late") + `\n      - run: ${command}\n`,
      job.replace(command, `${command} || true`),
    ])
      assert.throws(() => verify(workflow.replace(job, changed)));
  });
}

for (const name of ["web", "storage-postgres"]) {
  test(`${name}: full Node inventory cannot silently lose its native display`, () => {
    const job = jobSource(workflow, name);
    for (const changed of [
      job.replace("xvfb xauth", ""),
      job.replace("xvfb-run -a npm test", "npm test"),
    ])
      assert.throws(() => verify(workflow.replace(job, changed)));
  });
}

test("Runtime's reusable source diagnostics never select an Electron lane from the caller event", () => {
  const source = readFileSync(new URL("../../.github/workflows/application-source-resources.yml", import.meta.url), "utf8");
  const native = readFileSync(new URL("../../.github/workflows/application-native-regressions.yml", import.meta.url), "utf8");
  function verifyIsolation(candidate) {
    assert.match(candidate, /  workflow_call:/);
    assert.doesNotMatch(candidate, /native_probes|github\.event_name|github\.ref|electron\/install|xvfb|linux-native-regressions/);
    assert.doesNotMatch(jobSource(candidate, "source-contracts"), /^    if:/m);
  }
  verifyIsolation(source);
  assert.throws(() => verifyIsolation(source.replace("  source-contracts:", "  source-contracts:\n    if: github.event_name == 'push'")));
  assert.throws(() => verifyIsolation(source + "\n  linux-native-regressions:\n    steps: []\n"));
  assert.doesNotMatch(native, /workflow_call/);
  assert.match(native, /branches: \[fix\/full-application-regressions-20261021\]/);
  const job = jobSource(native, "linux-native-regressions");
  assert.ok(job.indexOf("node node_modules/electron/install.js") < job.indexOf("xvfb-run -a npm test"));
  assert.doesNotMatch(job, /continue-on-error|\|\|\s*true/);
});

test("small macOS runner bounds file workers without narrowing the full test inventory", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/application.yml", import.meta.url), "utf8");
  const desktop = jobSource(workflow, "desktop");
  assert.match(desktop, /npm test -- --test-concurrency=1\s*\n/);
  assert.doesNotMatch(desktop, /npm test -- --test-concurrency=1.*\.test\.ts/);
});
