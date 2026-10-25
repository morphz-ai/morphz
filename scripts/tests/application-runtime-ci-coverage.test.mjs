import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

function verifyTimingStability(source) {
  const job = jobSource(source, "linux-native-regressions");
  const step = job.split("\n      - ").find(part => part.includes("name: Require five consecutive timing and healthy-idle passes without retries"));
  assert.ok(step, "mandatory timing stability step");
  for (const file of ["tests/conversation-performance.spec.ts", "tests/platform-history-cache.spec.ts", "tests/search-panel.spec.ts", "tests/exchange-controller.spec.ts"])
    assert.ok(step.includes(`            ${file} \\\n`), `complete ${file} must be repeated`);
  assert.match(step, /--repeat-each=5 --forbid-only/);
  assert.doesNotMatch(step, /--grep|--shard|--retries|continue-on-error|\bif:|\|\|/);
}

function verifyHarnessStackStability(source) {
  const job = jobSource(source, "runtime-admission");
  const steps = job.split("\n      - ");
  const inventory = steps.findIndex(part => part.includes("name: Run the complete Runtime library inventory through the installed implementation"));
  const repeated = steps.findIndex(part => part.includes("name: Require five Harness root passes on the default 2 MiB test stack"));
  assert.ok(inventory >= 0 && repeated > inventory, "stack repetition supplements the complete inventory");
  const step = steps[repeated];
  assert.match(step, /shell: bash/);
  assert.match(step, /for round in 1 2 3 4 5; do/);
  assert.match(step, /RUST_MIN_STACK=2097152 \/usr\/local\/libexec\/morphz-runtime-ci\/lib/);
  assert.match(step, /runtime::tests::bound_runtime_harness_returns_without_a_model_rewrite_or_goal_completion/);
  assert.match(step, /--exact --test-threads=1/);
  assert.doesNotMatch(step, /continue-on-error|\bif:|\|\||--ignored|\buntil\b/);
}

function verifyNotesGuiStability(source) {
  const triggers = source.slice(0, source.indexOf("\npermissions:"));
  for (const path of [
    "application/tests/cognitive-notes-gui-package.test.ts",
    "application/tests/fixtures/cognitive-notes-gui-package.ts",
    "application/tests/connection-read-diagnostics-mounted.test.ts",
  ]) assert.ok(triggers.includes(`      - ${path}\n`), `${path} must trigger stability checks`);
  const job = jobSource(source, "macos-compose-regressions");
  const steps = job.split("\n      - ");
  const prepare = steps.findIndex(part => part.includes("name: Prepare exact independent author dependencies for early GUI stability"));
  const repeated = steps.findIndex(part => part.includes("name: Require five complete Notes GUI and connection resize passes without retries"));
  assert.ok(prepare >= 0 && repeated > prepare);
  assert.match(steps[prepare], /scripts\/prepare-cognitive-author-dependencies\.ts/);
  assert.match(steps[repeated], /for round in 1 2 3 4 5; do/);
  assert.match(steps[repeated], /npm test -- --test-concurrency=1 tests\/cognitive-notes-gui-package\.test\.ts/);
  assert.match(steps[repeated], /tests\/connection-read-diagnostics-mounted\.test\.ts/);
  assert.doesNotMatch(steps[repeated], /--test-name-pattern|--grep|--retries|continue-on-error|\bif:|\|\||\buntil\b/);
  assert.match(job, /timeout-minutes: 20/);
}

test("macOS repeats complete Notes GUI and connection resize files five times before the long inventory without narrowing or retrying", () => {
  const source = readFileSync(new URL("../../.github/workflows/application-native-regressions.yml", import.meta.url), "utf8");
  verifyNotesGuiStability(source);
  for (const changed of [
    source.replace("for round in 1 2 3 4 5; do", "for round in 1; do"),
    source.replaceAll("scripts/prepare-cognitive-author-dependencies.ts", "scripts/omitted.ts"),
    source.replace("tests/connection-read-diagnostics-mounted.test.ts\n          done", "--test-name-pattern=fast\n          done"),
    source.replace("tests/connection-read-diagnostics-mounted.test.ts\n          done", "tests/connection-read-diagnostics-mounted.test.ts || true\n          done"),
    source.replace(" tests/connection-read-diagnostics-mounted.test.ts\n          done", "\n          done"),
    source.replace("      - application/tests/connection-read-diagnostics-mounted.test.ts\n", ""),
  ]) assert.throws(() => verifyNotesGuiStability(changed));
});

test("Harness stack stability must pass five times at the default budget after the complete installed inventory", () => {
  const source = readFileSync(new URL("../../.github/workflows/linux-sandbox-service.yml", import.meta.url), "utf8");
  verifyHarnessStackStability(source);
  for (const changed of [
    source.replace("for round in 1 2 3 4 5; do", "for round in 1; do"),
    source.replace("RUST_MIN_STACK=2097152", "RUST_MIN_STACK=8388608"),
    source.replace("--exact --test-threads=1\n          done", "--exact --test-threads=1 || true\n          done"),
  ]) assert.throws(() => verifyHarnessStackStability(changed));
});

test("the latest commit must pass every timing and healthy-idle case five times, not retry failures", () => {
  const source = readFileSync(new URL("../../.github/workflows/application-native-regressions.yml", import.meta.url), "utf8");
  verifyTimingStability(source);
  for (const changed of [
    source.replace("--repeat-each=5", "--repeat-each=1"),
    source.replace("            tests/platform-history-cache.spec.ts \\\n", ""),
    source.replace("            tests/search-panel.spec.ts \\\n", ""),
    source.replace("            tests/exchange-controller.spec.ts \\\n", ""),
    source.replace("--repeat-each=5", "--retries=5"),
    source.replace("--repeat-each=5", "--repeat-each=5 --grep fast"),
  ]) assert.throws(() => verifyTimingStability(changed));
});

function verifyModelSettingsDiagnostic(source) {
  const triggers = source.slice(0, source.indexOf("\npermissions:"));
  for (const path of [
    "application/apps/web/src/ModelSettings.tsx",
    "application/tests/model-settings.spec.ts",
    "application/tests/ui-consistency.spec.ts",
    "application/tests/execution-ui-details.spec.ts",
    "application/tests/fixtures/painted-sweep.ts",
    "application/tests/painted-sweep.test.ts",
  ]) assert.ok(triggers.includes(`      - ${path}\n`), `${path} must trigger diagnostics`);
  const job = jobSource(source, "remaining-browser-regressions");
  const step = job.split("\n      - ").find(part =>
    part.includes("name: Reproduce every remaining full Web failure without retries"),
  );
  assert.ok(step);
  assert.match(step, /npm run test:e2e -- --forbid-only/);
  for (const path of ["tests/model-settings.spec.ts", "tests/ui-consistency.spec.ts", "tests/execution-ui-details.spec.ts"])
    assert.ok(step.includes(`            ${path} \\\n`), `${path} must run as a complete file`);
  assert.doesNotMatch(step, /--grep|--shard|--retries|--list|continue-on-error|\bif:|\|\|/);
}

test("model-setting icons and their global layout tests trigger complete early browser diagnostics", () => {
  const source = readFileSync(new URL("../../.github/workflows/application-native-regressions.yml", import.meta.url), "utf8");
  verifyModelSettingsDiagnostic(source);
});

test("settings diagnostic trigger omissions, narrowed files and hidden failures cannot pass coverage", () => {
  const source = readFileSync(new URL("../../.github/workflows/application-native-regressions.yml", import.meta.url), "utf8");
  for (const changed of [
    source.replace("      - application/tests/ui-consistency.spec.ts\n", ""),
    source.replace("            tests/ui-consistency.spec.ts \\\n", ""),
    source.replace("      - application/tests/fixtures/painted-sweep.ts\n", ""),
    source.replace("            tests/execution-ui-details.spec.ts \\\n", ""),
    source.replace(" --forbid-only", ""),
    source.replace(" --forbid-only", " --forbid-only --grep settings"),
    source.replace(" --forbid-only", " --forbid-only --retries=1"),
    source.replace("name: Reproduce every remaining full Web failure without retries", "continue-on-error: true\n        name: Reproduce every remaining full Web failure without retries"),
  ]) assert.throws(() => verifyModelSettingsDiagnostic(changed));
});

function verifyNativeRuntimeArtifact(source) {
  const job = jobSource(source, "native-sandbox-macos");
  const steps = job.split("\n      - ");
  const lastContract = steps.findIndex((step) =>
    step.includes("name: Verify signed Edge installer contract"),
  );
  const stage = steps.findIndex((step) =>
    step.includes(
      "name: Stage the exact native-tested macOS development Runtime",
    ),
  );
  const upload = steps.findIndex((step) =>
    step.includes("name: Preserve the native-tested macOS development Runtime"),
  );
  assert.ok(lastContract >= 0 && stage > lastContract && upload > stage);
  assert.match(steps[stage], /test -x target\/debug\/morphz/);
  assert.ok(
    steps[stage].includes('expected_commit="$(git rev-parse --short=12 HEAD)"'),
  );
  assert.ok(
    steps[stage].includes('version="$(target/debug/morphz --version)"'),
  );
  assert.ok(steps[stage].includes('*"$expected_commit"*) ;;'));
  assert.ok(
    steps[stage].includes(
      'install -m 0755 target/debug/morphz "$destination/morphz"',
    ),
  );
  assert.ok(
    steps[stage].includes(
      'git rev-parse HEAD > "$destination/source-commit.txt"',
    ),
  );
  assert.ok(
    steps[stage].includes('sh scripts/stage-release-legal.sh "$destination"'),
  );
  assert.match(steps[stage], /shasum -a 256 morphz > morphz\.sha256/);
  assert.match(
    steps[upload],
    /name: morphz-macos-development-runtime-\$\{\{ runner.arch \}\}/,
  );
  assert.match(steps[upload], /if-no-files-found: error/);
  assert.match(steps[upload], /retention-days: 7/);
  for (const step of [steps[stage], steps[upload]])
    assert.doesNotMatch(
      step,
      /\bif:|continue-on-error|\|\|\s*true|gh release|softprops\/action-gh-release/,
    );
}

test("macOS acceptance uses a commit-fenced, checksummed artifact only after native contracts pass", () => {
  const runtimeWorkflow = readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  verifyNativeRuntimeArtifact(runtimeWorkflow);
  for (const [before, after] of [
    ['*"$expected_commit"*) ;;', "*) ;;"],
    ["shasum -a 256 morphz > morphz.sha256", "true"],
    [
      "name: Preserve the native-tested macOS development Runtime",
      "name: Preserve the native-tested macOS development Runtime\n        if: always()",
    ],
    [
      "if-no-files-found: error\n          retention-days: 7",
      "if-no-files-found: ignore\n          retention-days: 7",
    ],
  ])
    assert.throws(() =>
      verifyNativeRuntimeArtifact(runtimeWorkflow.replace(before, after)),
    );
});

test("optional render profiling cannot replace or disable the normal Runtime CI inventory", () => {
  const source = readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /conversation_profile:\s+description:[^\n]+\s+required: false\s+default: false\s+type: boolean/,
  );
  const profile = jobSource(source, "conversation-profile");
  assert.ok(
    profile.includes(
      "if: ${{ github.event_name == 'workflow_dispatch' && inputs.conversation_profile }}",
    ),
  );
  assert.match(
    profile,
    /uses: \.\/.github\/workflows\/conversation-performance-diagnostics.yml/,
  );
  for (const name of [
    "application-source-resources",
    "session-io",
    "check",
    "test",
    "postgres-conformance",
    "native-sandbox-macos",
    "native-sandbox-linux",
    "native-sandbox-windows",
    "build",
    "dashboard",
    "website",
  ])
    assert.doesNotMatch(
      jobSource(source, name),
      /inputs\.conversation_profile|needs:.*conversation-profile/,
    );
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
  assert.doesNotMatch(
    browser,
    /(?:include|exclude):|continue-on-error|--grep|--last-failed/,
  );
  assert.match(
    browser,
    /npm run test:e2e -- --shard=\$\{\{ matrix.shard \}\}\/2 --forbid-only\s*$/m,
  );
  assert.match(
    browser,
    /name: application-web-failures-\$\{\{ matrix.shard \}\}/,
  );
  assert.match(required, /name: Shared application and Web\n/);
  assert.match(required, /needs: \[web-node, web-browser\]/);
  assert.match(required, /if: \$\{\{ always\(\) \}\}/);
  for (const [variable, dependency] of [
    ["NODE", "web-node"],
    ["BROWSER", "web-browser"],
  ]) {
    assert.ok(
      required.includes(
        `${variable}_RESULT: \${{ needs.${dependency}.result }}`,
      ),
    );
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
  ])
    assert.throws(() =>
      verifyCompleteWebPartitions(workflow.replace(before, after)),
    );
});

function macBrowserFiles(
  directory = new URL("../../application/tests/", import.meta.url),
  prefix = "tests/",
) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = new URL(entry.name, directory);
      if (entry.isDirectory())
        return macBrowserFiles(
          new URL(`${entry.name}/`, directory),
          `${prefix}${entry.name}/`,
        );
      if (!entry.isFile() || !entry.name.endsWith(".spec.ts")) return [];
      return /test\.skip\(\s*process\.platform\s*!==\s*["']darwin["']/.test(
        readFileSync(path, "utf8"),
      )
        ? [`${prefix}${entry.name}`]
        : [];
    })
    .sort();
}

function verifyNativeBrowser(source, files = macBrowserFiles()) {
  const desktop = jobSource(source, "desktop");
  assert.match(desktop, /runs-on: macos-/);
  assert.doesNotMatch(desktop, /^    (?:if:|continue-on-error:)/m);
  const commands = desktop.split("\n      - ").flatMap((step) => {
    const lines = step.replace(/\\\r?\n\s*/g, " ");
    return [
      ...lines.matchAll(/^\s*(?:run:\s*)?npx playwright test\s+([^\n]+)/gm),
    ].map((match) => ({
      step,
      tokens: match[1].split(/\s+#/)[0].trim().split(/\s+/),
    }));
  });
  const owners = files.map((file) => {
    const found = commands.filter(({ tokens }) => tokens.includes(file));
    assert.equal(
      found.length,
      1,
      `${file} has no single mandatory macOS native browser owner`,
    );
    return found[0];
  });
  for (const { step, tokens } of owners) {
    assert(
      tokens.includes("--forbid-only"),
      "native browser coverage rejects test.only",
    );
    assert.doesNotMatch(
      step,
      /\bif:|continue-on-error|\|\||--grep|--last-failed|--list|--retries|\s-g\s/,
    );
  }
}

test("every declared macOS-only browser file has a mandatory unfiltered CI owner", () => {
  const files = macBrowserFiles();
  for (const expected of [
    "tests/capture-window.spec.ts",
    "tests/sidebar-native.spec.ts",
    "tests/sidebar-resize.spec.ts",
  ])
    assert(
      files.includes(expected),
      `the existing native contract must not disappear: ${expected}`,
    );
  verifyNativeBrowser(workflow, files);
});

test("native browser omission, optional execution and name filters cannot pass coverage", () => {
  const desktop = jobSource(workflow, "desktop");
  for (const changed of [
    desktop.replace(" tests/sidebar-resize.spec.ts", ""),
    desktop.replace("runs-on: macos-latest", "runs-on: ubuntu-latest"),
    desktop.replace(
      "run: npx playwright test",
      "continue-on-error: true\n        run: npx playwright test",
    ),
    desktop.replace(
      "run: npx playwright test",
      "if: always()\n        run: npx playwright test",
    ),
    desktop.replace("--forbid-only", "--forbid-only --grep focused"),
    desktop.replace("--forbid-only", ""),
  ])
    assert.throws(() =>
      verifyNativeBrowser(workflow.replace(desktop, changed)),
    );
  assert.throws(() =>
    verifyNativeBrowser(workflow, [
      ...macBrowserFiles(),
      "tests/new-native-contract.spec.ts",
    ]),
  );
});

function verifyStorageInventory(source) {
  const storage = jobSource(source, "storage-postgres");
  assert.match(storage, /timeout-minutes: 120/);
  const step = storage
    .split("\n      - ")
    .find((part) =>
      part.includes(
        "name: Require PostgreSQL and cloud conformance; audit every remaining skip",
      ),
    );
  assert(step);
  assert.match(step, /MORPHZ_TEST_REQUIRED_CAPABILITIES: postgres,s3/);
  assert.match(
    step,
    /^          xvfb-run -a npm test -- --test-concurrency=1\s*$/m,
  );
  assert.doesNotMatch(
    step,
    /continue-on-error|--test-name-pattern|--test-skip-pattern|--test-only/,
  );
  assert.doesNotMatch(step, /^.*xvfb-run.*\|\|/m);
}

test("the complete PostgreSQL/cloud inventory bounds file scheduling without omitting tests or required capabilities", () => {
  verifyStorageInventory(workflow);
});

test("parallel storage files, a narrowed inventory or a dropped required backend fail the CI gate", () => {
  const storage = jobSource(workflow, "storage-postgres");
  for (const changed of [
    storage.replace("--test-concurrency=1", "--test-concurrency=4"),
    storage.replace(
      "--test-concurrency=1",
      "--test-concurrency=1 tests/cloud-artifact-store.test.ts",
    ),
    storage.replace("postgres,s3", "postgres"),
    storage.replace("timeout-minutes: 120", "timeout-minutes: 60"),
  ])
    assert.throws(() =>
      verifyStorageInventory(workflow.replace(storage, changed)),
    );
});
