import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/application.yml", import.meta.url),
  "utf8",
);
const jobs = [
  "web-node",
  "web-browser",
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
    const tests = name === "web-browser" ? job.indexOf("npm run test:e2e") :
      job.search(/\bnpm(?: --prefix application)? test\b/);
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
  for (const name of ["web-node", "storage-postgres"]) {
    const job = jobSource(source, name);
    assert.match(job, /apt-get install[^\n]*\bxvfb\b[^\n]*\bxauth\b/);
    assert.match(job, /xvfb-run -a npm test/);
    assert.ok(
      job.indexOf("xvfb xauth") < job.indexOf("xvfb-run -a npm test"),
      `${name}: a virtual display must exist before the full native inventory`,
    );
  }
  const web = jobSource(source, "web-browser");
  assert.match(
    web,
    /^      - run: xvfb-run -a --server-args="-screen 0 1920x1200x24" npm run test:e2e -- --shard=\$\{\{ matrix.shard \}\}\/2 --forbid-only\s*$/m,
    "the complete browser inventory needs an authenticated native display too",
  );
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

for (const name of ["web-node", "storage-postgres"]) {
  test(`${name}: full Node inventory cannot silently lose its native display`, () => {
    const job = jobSource(workflow, name);
    for (const changed of [
      job.replace("xvfb xauth", ""),
      job.replace("xvfb-run -a npm test", "npm test"),
    ])
      assert.throws(() => verify(workflow.replace(job, changed)));
  });
}

test("Web browser inventory keeps its display without filtering native or performance cases", () => {
  const job = jobSource(workflow, "web-browser");
  const command = 'xvfb-run -a --server-args="-screen 0 1920x1200x24" npm run test:e2e';
  for (const replacement of [
    "npm run test:e2e",
    command + " -- tests/only-one.spec.ts",
    command.replace("xvfb-run -a", "xvfb-run -a --server-args=-ac"),
  ])
    assert.throws(() => verify(workflow.replace(job, job.replace(command, replacement))));
});

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
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  function verifyExplicitNativeOwner(owner, candidate) {
    const entry = jobSource(owner, "native-regressions");
    assert.match(entry, /uses: \.\/\.github\/workflows\/application-native-regressions\.yml/);
    assert.doesNotMatch(entry, /^    if:|continue-on-error|github\.event_name|github\.ref/m);
    assert.match(candidate, /^  workflow_call:/m);
    for (const name of ["remaining-browser-regressions", "macos-reader-regressions",
      "linux-native-regressions", "macos-compose-regressions"]) {
      const job = jobSource(candidate, name);
      assert.doesNotMatch(job, /^    if:|github\.event_name|github\.ref/m,
        `${name}: native coverage cannot silently skip for its caller event`);
    }
  }
  verifyExplicitNativeOwner(ci, native);
  assert.throws(() => verifyExplicitNativeOwner(ci.replace(
    "  native-regressions:\n", "  native-regressions:\n    if: github.ref == 'refs/heads/main'\n"), native));
  assert.throws(() => verifyExplicitNativeOwner(ci, native.replace(
    "  linux-native-regressions:\n", "  linux-native-regressions:\n    if: github.event_name == 'push'\n")));
  assert.throws(() => verifyExplicitNativeOwner(ci, native.replace("  workflow_call:\n", "")));
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

test("complete macOS inventory leaves bounded room for native validation and cleanup", () => {
  function verifyBudget(source) {
    const desktop = jobSource(source, "desktop");
    const minutes = Number(/^    timeout-minutes: (\d+)$/m.exec(desktop)?.[1]);
    assert.ok(minutes >= 120 && minutes <= 150);
    assert.match(desktop, /npm test -- --test-concurrency=1\s*\n/);
    for (const command of [
      "npm run test:embedded",
      "npm run test:platform-embedded-desktop",
      "npm run test:platform-desktop",
      "npm run test:draft-restart",
      "npm run test:reader-ocr",
      "npm run test:reader-stability",
    ])
      assert.ok(desktop.includes(command), `missing ${command}`);
  }
  verifyBudget(workflow);
  const desktop = jobSource(workflow, "desktop");
  for (const changed of [
    desktop.replace("timeout-minutes: 120", "timeout-minutes: 90"),
    desktop.replace("timeout-minutes: 120", "timeout-minutes: 360"),
    desktop.replace("npm run test:reader-stability", "echo omitted"),
    desktop.replace("npm test -- --test-concurrency=1", "npm test -- tests/one.test.ts"),
  ])
    assert.throws(() => verifyBudget(workflow.replace(desktop, changed)));
});
