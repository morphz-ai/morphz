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

function verifyNativeRuntimeArtifact(source) {
  const job = jobSource(source, "native-sandbox-macos");
  const steps = job.split("\n      - ");
  const lastContract = steps.findIndex((step) =>
    step.includes("name: Verify signed Edge installer contract"),
  );
  const stage = steps.findIndex((step) =>
    step.includes("name: Stage the exact native-tested macOS development Runtime"),
  );
  const upload = steps.findIndex((step) =>
    step.includes("name: Preserve the native-tested macOS development Runtime"),
  );
  assert.ok(lastContract >= 0 && stage > lastContract && upload > stage);
  assert.match(steps[stage], /test -x target\/debug\/morphz/);
  assert.ok(steps[stage].includes('expected_commit="$(git rev-parse --short=12 HEAD)"'));
  assert.ok(steps[stage].includes('version="$(target/debug/morphz --version)"'));
  assert.ok(steps[stage].includes('*"$expected_commit"*) ;;'));
  assert.ok(steps[stage].includes('install -m 0755 target/debug/morphz "$destination/morphz"'));
  assert.ok(steps[stage].includes('git rev-parse HEAD > "$destination/source-commit.txt"'));
  assert.ok(steps[stage].includes('sh scripts/stage-release-legal.sh "$destination"'));
  assert.match(steps[stage], /shasum -a 256 morphz > morphz\.sha256/);
  assert.match(steps[upload], /name: morphz-macos-development-runtime-\$\{\{ runner.arch \}\}/);
  assert.match(steps[upload], /if-no-files-found: error/);
  assert.match(steps[upload], /retention-days: 7/);
  for (const step of [steps[stage], steps[upload]])
    assert.doesNotMatch(step, /\bif:|continue-on-error|\|\|\s*true|gh release|softprops\/action-gh-release/);
}

test("macOS acceptance uses a commit-fenced, checksummed artifact only after native contracts pass", () => {
  const runtimeWorkflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  verifyNativeRuntimeArtifact(runtimeWorkflow);
  for (const [before, after] of [
    ['*"$expected_commit"*) ;;', "*) ;;"],
    ["shasum -a 256 morphz > morphz.sha256", "true"],
    ["name: Preserve the native-tested macOS development Runtime", "name: Preserve the native-tested macOS development Runtime\n        if: always()"],
    ["if-no-files-found: error\n          retention-days: 7", "if-no-files-found: ignore\n          retention-days: 7"],
  ]) assert.throws(() => verifyNativeRuntimeArtifact(runtimeWorkflow.replace(before, after)));
});

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
  const web = jobSource(source, "web-browser");
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
  const web = jobSource(workflow, "web-browser");
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

function verifyCompleteWebPartitions(source) {
  const node = jobSource(source, "web-node");
  const browser = jobSource(source, "web-browser");
  const required = jobSource(source, "web");
  assert.match(node, /^          xvfb-run -a npm test\s*$/m);
  assert.doesNotMatch(node, /npm run test:e2e/);
  assert.doesNotMatch(browser, /\bnpm test\b/);
  assert.match(browser, /fail-fast: false\s+matrix:\s+shard: \[1, 2\]/);
  assert.doesNotMatch(browser, /(?:include|exclude):|continue-on-error|--grep|--last-failed/);
  assert.match(browser, /npm run test:e2e -- --shard=\$\{\{ matrix.shard \}\}\/2 --forbid-only\s*$/m);
  assert.match(browser, /name: application-web-failures-\$\{\{ matrix.shard \}\}/);
  assert.match(required, /name: Shared application and Web\n/);
  assert.match(required, /needs: \[web-node, web-browser\]/);
  assert.match(required, /if: \$\{\{ always\(\) \}\}/);
  for (const [variable, dependency] of [["NODE", "web-node"], ["BROWSER", "web-browser"]]) {
    assert.ok(required.includes(`${variable}_RESULT: \${{ needs.${dependency}.result }}`));
    assert.ok(required.includes(`test "$${variable}_RESULT" = success`));
  }
  assert.doesNotMatch(required, /continue-on-error|\|\|\s*true/);
}

test("full Node and complementary browser shards cannot be cancelled behind a green required check", () => {
  verifyCompleteWebPartitions(workflow);
  for (const [before, after] of [
    ["shard: [1, 2]", "shard: [1]"],
    ["fail-fast: false", "fail-fast: true"],
    ["needs: [web-node, web-browser]", "needs: [web-node]"],
    ['test "$BROWSER_RESULT" = success', "true"],
    ["/2 --forbid-only", "/3 --forbid-only"],
    ["/2 --forbid-only", "/2 --forbid-only --grep focused"],
  ]) assert.throws(() => verifyCompleteWebPartitions(workflow.replace(before, after)));
});
