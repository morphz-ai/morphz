import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { testCapabilityPlan } from "../../application/scripts/test-capabilities.mjs";
import {
  cognitiveRuntimeEnvironment,
  cognitiveRuntimeFiles,
} from "../../application/scripts/ci-cognitive-runtime.mjs";

const workflow = readFileSync(
  new URL("../../.github/workflows/application.yml", import.meta.url),
  "utf8",
);
// Read the authoritative test catalog without connecting to a database,
// starting a Runtime or treating an installed local binary as CI evidence.
const cases = testCapabilityPlan({
  env: {
    MORPHZ_TEST_POSTGRES_URL: "postgresql://catalog.invalid/not-connected",
  },
  binaryExists: () => true,
}).selected.filter((entry) => entry.capability === "runtime");

function jobSource(source, name) {
  const header = `\n  ${name}:\n`;
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${name} job`);
  const tail = source.slice(start + header.length);
  const next = tail.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? tail : tail.slice(0, next);
}

function runtimeStep(source) {
  const job = jobSource(source, "runtime-contract");
  const step = job
    .split("\n      - ")
    .find((part) => /npm --prefix application test --/.test(part));
  assert.ok(step, "Runtime contract uses the managed npm test entry");
  assert.match(step, /MORPHZ_TEST_REQUIRED_CAPABILITIES: postgres,runtime/);
  assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/);
  return {
    files: [...step.matchAll(/tests\/([a-z0-9-]+\.test\.ts)/g)].map(
      (match) => match[1],
    ),
    flags: new Set(
      [...step.matchAll(/(MORPHZ_[A-Z0-9_]+): "1"/g)].map((match) => match[1]),
    ),
  };
}

function verify(source) {
  const regular = runtimeStep(source);
  const cognitive = jobSource(source, "cognitive-runtime-contract");
  assert.match(
    cognitive,
    /npm exec --offline -- node scripts\/ci-cognitive-runtime\.mjs/,
  );
  const environment = cognitiveRuntimeEnvironment({});
  const cognitiveFiles = cognitiveRuntimeFiles.map((file) =>
    file.replace(/^tests\//, ""),
  );
  for (const entry of cases) {
    const regularRuns =
      regular.files.includes(entry.file) && regular.flags.has(entry.flag);
    const cognitiveRuns =
      cognitiveFiles.includes(entry.file) && environment[entry.flag] === "1";
    assert.ok(
      regularRuns || cognitiveRuns,
      `${entry.file}: ${entry.name} has no mandatory CI owner with ${entry.flag}=1`,
    );
  }
  assert.equal(new Set(regular.files).size, regular.files.length);
}

test("every declared actual Runtime application case has a mandatory CI owner", () => {
  assert.ok(
    cases.length >= 20,
    "the existing capability inventory must not shrink",
  );
  verify(workflow);
});

for (const file of [
  "host-tool-current-runtime.test.ts",
  "infer-model-controls-runtime.test.ts",
  "agent-reader-import-runtime.test.ts",
]) {
  test(`${file}: removing the previously omitted file fails coverage`, () => {
    assert.throws(
      () => verify(workflow.replace(`tests/${file}`, "")),
      /no mandatory CI owner/,
    );
  });
}

test("an unset import flag or optional Runtime gate cannot disguise omitted integrations", () => {
  assert.throws(
    () =>
      verify(
        workflow.replace(
          'MORPHZ_READER_IMPORT_RUNTIME_E2E: "1"',
          'MORPHZ_READER_IMPORT_RUNTIME_E2E: "0"',
        ),
      ),
    /no mandatory CI owner/,
  );
  const job = jobSource(workflow, "runtime-contract");
  assert.throws(() =>
    verify(workflow.replace(job, job.replace("postgres,runtime", "postgres"))),
  );
});

function verifyBrowserRuntime(source) {
  const web = jobSource(source, "web");
  const steps = web.split("\n      - ");
  const browser = steps.findIndex((step) => /npm run test:e2e/.test(step));
  const build = steps.findIndex((step) =>
    /\.\.\/scripts\/cargo-dev\.sh build --locked --manifest-path \.\.\/Cargo\.toml -p morphz --bin morphz/.test(
      step,
    ),
  );
  assert.ok(browser >= 0, "the complete browser inventory remains required");
  assert.ok(
    build >= 0 && build < browser,
    "actual Runtime browser tests need a source-built binary in their own CI job",
  );
  assert.doesNotMatch(steps[build], /continue-on-error|\|\|\s*true/);
  assert.match(web, /uses: dtolnay\/rust-toolchain@/);
}

test("the complete browser inventory builds its own actual Runtime prerequisite", () => {
  verifyBrowserRuntime(workflow);
});

test("omitting or ignoring the browser Runtime build fails its prerequisite gate", () => {
  const web = jobSource(workflow, "web");
  const command =
    "../scripts/cargo-dev.sh build --locked --manifest-path ../Cargo.toml -p morphz --bin morphz";
  for (const changed of [
    web.replace(command, "true"),
    web.replace(command, `${command} || true`),
  ]) {
    assert.throws(() => verifyBrowserRuntime(workflow.replace(web, changed)));
  }
});

function verifyNativeFocus(source) {
  const desktop = jobSource(source, "desktop");
  const step = desktop
    .split("\n      - ")
    .find((part) =>
      part.includes("npm test -- tests/exchange-read-receipts-mounted.test.ts"),
    );
  assert.ok(step, "native foreground/background case has a dedicated CI owner");
  assert.match(
    step,
    /MORPHZ_TEST_REQUIRED_CAPABILITIES: postgres,native-focus/,
  );
  assert.match(step, /MORPHZ_TEST_NATIVE_FOCUS: "1"/);
  assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/);
}

test("native foreground/background coverage is required rather than indefinitely optional", () => {
  verifyNativeFocus(workflow);
  for (const changed of [
    workflow.replace(
      "npm test -- tests/exchange-read-receipts-mounted.test.ts",
      "npm test -- tests/test-electron-readiness.test.ts",
    ),
    workflow.replace(
      'MORPHZ_TEST_NATIVE_FOCUS: "1"',
      'MORPHZ_TEST_NATIVE_FOCUS: "0"',
    ),
    workflow.replace("postgres,native-focus", "postgres"),
  ])
    assert.throws(() => verifyNativeFocus(changed));
});
