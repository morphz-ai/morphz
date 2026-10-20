import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Controlled streams exercise the real reporter helper; one bounded real Node
// test process also verifies its default CLI entry. No database or other server
// is contacted, and no process-global environment is mutated.
type Event = { type: string; data: Record<string, unknown> };
type Plan = {
  env: NodeJS.ProcessEnv;
  files: Set<string> | null;
  platform: NodeJS.Platform;
  required: Set<string>;
  selected: { file: string; name: string; capability: string; flag?: string }[];
  browser: boolean;
  cloud: boolean;
};
const { testCapabilityPlan } = (await import(
  new URL("../scripts/test-capabilities.mjs", import.meta.url).href
)) as {
  testCapabilityPlan(options?: {
    env?: NodeJS.ProcessEnv;
    files?: string[] | null;
    platform?: NodeJS.Platform;
    binaryExists?: (path: unknown) => boolean;
  }): Plan;
};
const { reportTestCoverage } = (await import(
  new URL("../scripts/test-coverage-reporter.mjs", import.meta.url).href
)) as {
  reportTestCoverage(
    events: AsyncIterable<Event>,
    plan: Plan,
  ): AsyncGenerator<string>;
};
const base = {
  MORPHZ_TEST_POSTGRES_URL:
    "postgres://fixture:dummy-secret@127.0.0.1:59999/isolated_test",
  MORPHZ_TEST_BROWSER_EXECUTABLE: "/fixture/browser",
};
const testsRoot = fileURLToPath(new URL("./", import.meta.url));
const known = {
  file: join(testsRoot, "cloud-artifact-store.test.ts"),
  name: "云 Store：两个 Host 共读原件、精确版本、备份恢复和损坏拒绝",
  skip: true,
};
const counts = {
  tests: 3,
  passed: 2,
  failed: 0,
  cancelled: 0,
  skipped: 1,
  todo: 0,
};
function plan(env: NodeJS.ProcessEnv = {}, files: string[] | null = null) {
  return testCapabilityPlan({
    env: { ...base, ...env },
    files,
    platform: "darwin",
    binaryExists: (path: unknown) =>
      typeof path === "string" &&
      ["/fixture/browser", "/fixture/dump", "/fixture/restore"].includes(path),
  });
}
async function* events(values: Event[]) {
  yield* values;
}
async function consume(source: AsyncIterable<Event>, actual = plan()) {
  const result: string[] = [];
  for await (const line of reportTestCoverage(source, actual))
    result.push(line);
  return result;
}
const summary = (value = counts): Event => ({
  type: "test:summary",
  data: { counts: value },
});
function coverage(lines: string[]) {
  assert.equal(lines.length, 1);
  const prefix = "[test coverage] ";
  assert.ok(lines[0]!.startsWith(prefix));
  return JSON.parse(lines[0]!.slice(prefix.length));
}

test("failures are emitted before later events and retain bounded real causes without reading attached state", async () => {
  const cause = new Error("expected terminal reply");
  Object.defineProperty(cause, "actual", { value: false });
  Object.defineProperty(cause, "expected", { value: true });
  Object.defineProperty(cause, "code", {
    get() {
      throw new Error("must not read getter");
    },
  });
  Object.defineProperty(cause, "attachedPrivateState", { value: base });
  const error = new Error("test failed", { cause });
  const iterator = reportTestCoverage(
    events([
      {
        type: "test:fail",
        data: {
          name: "specific failing test",
          file: "fixture.test.ts",
          line: 42,
          column: 3,
          details: { error },
        },
      },
      summary({ ...counts, tests: 1, passed: 0, failed: 1, skipped: 0 }),
    ]),
    plan(),
  );
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert(first.value!.startsWith("[test failure] "));
  const diagnostic = JSON.parse(first.value!.slice("[test failure] ".length));
  assert.equal(diagnostic.line, 42);
  assert.equal(diagnostic.error.cause.message, "expected terminal reply");
  assert.equal(diagnostic.error.cause.actual, false);
  assert.equal(diagnostic.error.cause.expected, true);
  assert.equal(first.value!.includes("dummy-secret"), false);
  assert.equal(first.value!.includes("must not read getter"), false);
  const second = await iterator.next();
  assert.equal(coverage([second.value!]).counts.failed, 1);
  assert.equal((await iterator.next()).done, true);
});

test("circular and oversized errors cannot make failure diagnostics unbounded", async () => {
  const error = Object.assign(new Error("x".repeat(10000)), {
    cause: null as unknown,
  });
  error.cause = error;
  const lines = await consume(
    events([
      { type: "test:fail", data: { name: "bounded", details: { error } } },
      summary({ ...counts, tests: 1, passed: 0, failed: 1, skipped: 0 }),
    ]),
  );
  const record = JSON.parse(lines[0]!.slice("[test failure] ".length));
  assert.equal(record.error.message.length, 3000);
  assert.equal(record.error.cause, "[nested error omitted]");
  assert(lines[0]!.length < 10000);
  assert.equal(coverage(lines.slice(1)).counts.failed, 1);
});

test("reporter exposes exact declared omissions and final Node counts without credentials", async () => {
  const lines = await consume(
    events([
      {
        type: "test:pass",
        data: { name: "ordinary", file: "ordinary.test.ts" },
      },
      { type: "test:pass", data: known },
      {
        type: "test:summary",
        data: { file: known.file, counts: { tests: 100, skipped: 99 } },
      },
      summary(),
    ]),
  );
  assert.deepEqual(coverage(lines), {
    required: ["postgres"],
    selectedFiles: null,
    counts,
    optionalNotExecuted: [
      {
        file: "cloud-artifact-store.test.ts",
        name: known.name,
        capability: "s3",
        reason: "explicit integration not enabled",
      },
    ],
    unexpectedSkips: [],
  });
  assert.equal(lines.join("").includes(base.MORPHZ_TEST_POSTGRES_URL), false);
  assert.equal(lines.join("").includes("dummy-secret"), false);
});

test("selected exact path scope is explicit and deduplicated, never presented as a full run", async () => {
  const selected = plan({}, [
    "tests/response-annotations-runtime.test.ts",
    join(testsRoot, "response-annotations-runtime.test.ts"),
  ]);
  const lines = await consume(
    events([
      {
        type: "test:pass",
        data: {
          file: "response-annotations-runtime.test.ts",
          name: "selected ordinary",
        },
      },
      summary({ ...counts, tests: 1, passed: 1, skipped: 0 }),
    ]),
    selected,
  );
  assert.deepEqual(coverage(lines).selectedFiles, [
    join(testsRoot, "response-annotations-runtime.test.ts"),
  ]);
  assert.deepEqual(coverage(lines).optionalNotExecuted, []);
  assert.deepEqual(coverage(lines).unexpectedSkips, []);
});

test("real Node loads the default reporter and emits both ordinary and scoped coverage output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morphz-coverage-entry-"));
  const file = join(directory, "coverage-entry-probe.test.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MORPHZ_APP_ENV_FILE: "",
    MORPHZ_TEST_POSTGRES_URL: base.MORPHZ_TEST_POSTGRES_URL,
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "postgres",
    MORPHZ_TEST_SELECTED_FILES: JSON.stringify([file]),
  };
  // A nested Node test runner must not inherit its parent's worker identity.
  delete env.NODE_TEST_CONTEXT;
  try {
    await writeFile(
      file,
      'import test from "node:test";\n' +
        'test("controlled coverage entry", () => {});\n',
      "utf8",
    );
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--test",
        "--test-reporter=spec",
        `--test-reporter=${fileURLToPath(new URL("../scripts/test-coverage-reporter.mjs", import.meta.url))}`,
        "--test-reporter-destination=stdout",
        "--test-reporter-destination=stdout",
        file,
      ],
      { env, timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(stderr, "");
    assert.match(stdout, /controlled coverage entry/);
    const reports = stdout
      .split("\n")
      .filter((line) => line.startsWith("[test coverage] "));
    assert.equal(reports.length, 1);
    const record = coverage(reports);
    assert.deepEqual(record.required, ["postgres"]);
    assert.deepEqual(record.selectedFiles, [file]);
    assert.deepEqual(record.optionalNotExecuted, []);
    assert.deepEqual(record.unexpectedSkips, []);
    assert.equal(record.counts.tests, 1);
    assert.equal(record.counts.passed, 1);
    for (const name of ["failed", "cancelled", "skipped", "todo"])
      assert.equal(record.counts[name], 0);
    assert.equal(stdout.includes(base.MORPHZ_TEST_POSTGRES_URL), false);
    assert.equal(stdout.includes("dummy-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected skips fail only after the complete stream and sibling cleanup are consumed", async () => {
  const trace: string[] = [],
    lines: string[] = [];
  async function* source() {
    trace.push("unknown");
    yield {
      type: "test:pass",
      data: { file: "unknown.test.ts", name: "unknown skip", skip: true },
    };
    trace.push("sibling cleanup");
    yield {
      type: "test:pass",
      data: { file: "ordinary.test.ts", name: "ordinary" },
    };
    trace.push("final summary");
    yield summary();
    trace.push("stream exhausted");
  }
  await assert.rejects(async () => {
    for await (const line of reportTestCoverage(source(), plan()))
      lines.push(line);
  }, /Test coverage failed: Unexpected skipped test: unknown skip/);
  assert.deepEqual(trace, [
    "unknown",
    "sibling cleanup",
    "final summary",
    "stream exhausted",
  ]);
  assert.deepEqual(coverage(lines).unexpectedSkips, [
    "Unexpected skipped test: unknown skip",
  ]);
});

test("known optional names do not excuse a prepared or required capability skip", async () => {
  const ready = plan({
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "postgres,s3",
    MORPHZ_TEST_S3_ENDPOINT: "http://fixture.invalid:4566",
    MORPHZ_TEST_PG_DUMP: "/fixture/dump",
    MORPHZ_TEST_PG_RESTORE: "/fixture/restore",
  });
  await assert.rejects(
    consume(events([{ type: "test:pass", data: known }, summary()]), ready),
    /Test coverage failed: Required or prepared test was skipped/,
  );
});

test("a file/name mismatch and an unselected declared test both remain unexpected", async () => {
  for (const [data, actual] of [
    [{ ...known, file: "copied.test.ts" }, plan()],
    [known, plan({}, ["test-capability-reporter.test.ts"])],
  ] as const)
    await assert.rejects(
      consume(events([{ type: "test:pass", data }, summary()]), actual),
      /Test coverage failed: Unexpected skipped test/,
    );
});

test("reporter rejects a same-basename nested or external skip and retains the exact selected path", async () => {
  const copies = [
    join(testsRoot, "copied", "cloud-artifact-store.test.ts"),
    resolve(
      testsRoot,
      "../../../other-workspace/application/tests/cloud-artifact-store.test.ts",
    ),
    "tests/../cloud-artifact-store.test.ts",
    "tests/../../cloud-artifact-store.test.ts",
  ];
  for (const file of copies) {
    const lines: string[] = [];
    const selected = plan({}, [file]);
    await assert.rejects(async () => {
      for await (const line of reportTestCoverage(
        events([{ type: "test:pass", data: { ...known, file } }, summary()]),
        selected,
      ))
        lines.push(line);
    }, /Test coverage failed: Unexpected skipped test/);
    assert.deepEqual(coverage(lines).selectedFiles, [...selected.files!]);
    assert.deepEqual(coverage(lines).optionalNotExecuted, []);
    assert.equal(coverage(lines).unexpectedSkips.length, 1);
  }
});

test("no final root summary is an error after draining, not a coverage success", async () => {
  let drained = false;
  async function* source() {
    yield { type: "test:summary", data: { file: "ordinary.test.ts", counts } };
    drained = true;
  }
  await assert.rejects(
    consume(source()),
    /Test process produced no final coverage summary/,
  );
  assert.equal(drained, true);
});

test("failing tests are reported faithfully and skipped-looking diagnostics are not exceptions", async () => {
  const failed = { ...counts, passed: 1, failed: 1, skipped: 0 };
  const lines = await consume(
    events([
      {
        type: "test:diagnostic",
        data: { name: known.name, file: known.file, skip: true },
      },
      {
        type: "test:fail",
        data: { file: "ordinary.test.ts", name: "ordinary failure" },
      },
      summary(failed),
    ]),
  );
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!.slice("[test failure] ".length)), {
    file: "ordinary.test.ts",
    name: "ordinary failure",
    error: null,
  });
  assert.deepEqual(coverage(lines.slice(1)).counts, failed);
  assert.deepEqual(coverage(lines.slice(1)).optionalNotExecuted, []);
  assert.deepEqual(coverage(lines.slice(1)).unexpectedSkips, []);
});

test("a real failed Node child emits its precise cause and retains its nonzero exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morphz-failure-entry-"));
  const file = join(directory, "failure.test.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MORPHZ_APP_ENV_FILE: "",
    MORPHZ_TEST_POSTGRES_URL: base.MORPHZ_TEST_POSTGRES_URL,
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "postgres",
    MORPHZ_TEST_SELECTED_FILES: JSON.stringify([file]),
  };
  delete env.NODE_TEST_CONTEXT;
  try {
    await writeFile(
      file,
      'import test from "node:test"; test("precise fixture failure", () => { throw new Error("specific missing reply"); });\n',
    );
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--test",
          "--test-reporter=spec",
          "--test-reporter-destination=stdout",
          `--test-reporter=${fileURLToPath(new URL("../scripts/test-coverage-reporter.mjs", import.meta.url))}`,
          "--test-reporter-destination=stdout",
          file,
        ],
        { env, timeout: 15_000, maxBuffer: 1024 * 1024 },
      ),
      (error: any) => {
        assert.equal(error.code, 1);
        const lines = String(error.stdout).split("\n");
        const failures = lines.filter((line) =>
          line.startsWith("[test failure] "),
        );
        assert.equal(failures.length, 1);
        const record = JSON.parse(failures[0]!.slice("[test failure] ".length));
        assert.equal(record.name, "precise fixture failure");
        assert.equal(record.error.cause.message, "specific missing reply");
        assert.equal(
          coverage(lines.filter((line) => line.startsWith("[test coverage] ")))
            .counts.failed,
          1,
        );
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source errors propagate rather than yielding a synthetic successful summary", async () => {
  const failure = new Error("controlled stream interruption");
  async function* source() {
    yield { type: "test:pass", data: known };
    throw failure;
  }
  await assert.rejects(consume(source()), (error) => error === failure);
});
