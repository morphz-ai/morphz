import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Coverage = {
  required: string[];
  selectedFiles: string[];
  counts: Record<string, number>;
  optionalNotExecuted: unknown[];
  unexpectedSkips: string[];
};
type CIRecord = {
  state: string;
  cleanup?: string;
  error?: string;
  exitSignal?: string | null;
  coverage?: unknown;
};
const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
const module = (await import(
  new URL("../scripts/ci-cognitive-runtime.mjs", import.meta.url).href
)) as {
  cognitiveRuntimeFiles: string[];
  cognitiveRuntimeFlags: string[];
  cognitiveRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  sanitizeCognitiveEvidence(text: string, env?: NodeJS.ProcessEnv): string;
  cognitiveCoverageGate(text: string): unknown;
  runCognitiveRuntimeCI(options: {
    env: NodeJS.ProcessEnv;
    evidenceRoot: string;
    launch?: (...args: unknown[]) => ChildProcess;
    signal?: AbortSignal;
    timeoutMs?: number;
    cancellationGraceMs?: number;
    maximumBytes?: number;
  }): Promise<{ directory: string; record: CIRecord; exitCode: number }>;
};
const {
  cognitiveRuntimeFiles,
  cognitiveRuntimeFlags,
  cognitiveRuntimeEnvironment,
  cognitiveCoverageGate,
  sanitizeCognitiveEvidence,
  runCognitiveRuntimeCI,
} = module;
type Contract = {
  file: string;
  name: string;
  passes: number;
  failures: number;
  skips: number;
};
const { cognitiveRuntimeContracts } = (await import(
  new URL("../scripts/cognitive-runtime-contracts.mjs", import.meta.url).href
)) as {
  cognitiveRuntimeContracts: { file: string; name: string; flag: string }[];
};
const { default: reportCognitiveContracts } = (await import(
  new URL("../scripts/ci-cognitive-runtime-reporter.mjs", import.meta.url).href
)) as {
  default(
    events: AsyncIterable<{ type: string; data: Record<string, unknown> }>,
  ): AsyncGenerator<string>;
};
function contracts(): Contract[] {
  return cognitiveRuntimeContracts.map(({ file, name }) => ({
    file,
    name,
    passes: 1,
    failures: 0,
    skips: 0,
  }));
}
function complete(): Coverage {
  return {
    required: ["postgres", "runtime"],
    selectedFiles: cognitiveRuntimeFiles.map((file) =>
      resolve(applicationRoot, file),
    ),
    counts: {
      tests: 6,
      passed: 6,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    },
    optionalNotExecuted: [],
    unexpectedSkips: [],
  };
}
const coverage = (record: Coverage = complete()) =>
  "[test coverage] " +
  JSON.stringify(record) +
  "\n" +
  "[cognitive contracts] " +
  JSON.stringify({
    rootSummaryObserved: true,
    complete: true,
    contracts: contracts(),
  }) +
  "\n";

test("cognitive CI isolates environment and requires all four groups without database fallback", () => {
  const source = {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    npm_execpath: "/fixture/npm-cli.js",
    NODE_OPTIONS: "--import=private-loader",
    OPENAI_API_KEY: "private-provider-key",
    HTTPS_PROXY: "https://private-proxy.example",
    MORPHZ_APP_ENV_FILE: "/private/business.env",
    MORPHZ_TEST_POSTGRES_URL: "postgres://user:private-db-key@example/business",
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "",
    MORPHZ_COGNITIVE_RUNTIME_E2E: "0",
  };
  const prepared = cognitiveRuntimeEnvironment(source);
  assert.equal(prepared.MORPHZ_TEST_REQUIRED_CAPABILITIES, "postgres,runtime");
  for (const flag of cognitiveRuntimeFlags) assert.equal(prepared[flag], "1");
  for (const name of [
    "OPENAI_API_KEY",
    "HTTPS_PROXY",
    "NODE_OPTIONS",
    "MORPHZ_TEST_POSTGRES_URL",
  ])
    assert.equal(prepared[name], undefined);
  assert.equal(prepared.MORPHZ_APP_ENV_FILE, "");
  assert.equal(prepared.npm_execpath, source.npm_execpath);
  assert.equal(source.MORPHZ_COGNITIVE_RUNTIME_E2E, "0");
});

test("cognitive CI requires completed exact-file coverage and cannot pass omissions or zero tests", () => {
  assert.ok(cognitiveCoverageGate(coverage()));
  for (const mutate of [
    (record: Coverage) => {
      record.counts.skipped = 1;
      record.counts.passed = 5;
    },
    (record: Coverage) => {
      record.counts.cancelled = 1;
    },
    (record: Coverage) => {
      record.counts.todo = 1;
    },
    (record: Coverage) => {
      record.counts.tests = 0;
      record.counts.passed = 0;
    },
    (record: Coverage) => {
      record.counts.tests = 5;
      record.counts.passed = 5;
    },
    (record: Coverage) => {
      record.optionalNotExecuted.push({ capability: "runtime" });
    },
    (record: Coverage) => {
      record.unexpectedSkips.push("unexpected");
    },
    (record: Coverage) => {
      record.required = ["postgres"];
    },
    (record: Coverage) => {
      record.selectedFiles.pop();
    },
    (record: Coverage) => {
      record.selectedFiles[0] = record.selectedFiles[1]!;
    },
    (record: Coverage) => {
      record.selectedFiles[0] = resolve(
        "/elsewhere",
        cognitiveRuntimeFiles[0]!,
      );
    },
  ]) {
    const record = complete();
    mutate(record);
    assert.throws(() => cognitiveCoverageGate(coverage(record)));
  }
  for (const value of [
    "",
    "[test coverage] {broken}\n",
    coverage() + coverage(),
  ])
    assert.throws(() => cognitiveCoverageGate(value));
  for (const mutation of [
    (values: Contract[]) => {
      values[0]!.passes = 0;
      values[1]!.passes = 2;
    },
    (values: Contract[]) => {
      values[0]!.skips = 1;
    },
    (values: Contract[]) => {
      values[0]!.failures = 1;
    },
    (values: Contract[]) => {
      values[0]!.file = "/elsewhere/" + values[0]!.file;
    },
    (values: Contract[]) => {
      values[0]!.name += " copied";
    },
  ]) {
    const values = contracts();
    mutation(values);
    assert.throws(() =>
      cognitiveCoverageGate(
        coverage().split("[cognitive contracts]")[0] +
          "[cognitive contracts] " +
          JSON.stringify({
            rootSummaryObserved: true,
            complete: true,
            contracts: values,
          }) +
          "\n",
      ),
    );
  }
});

test("per-contract reporter drains real event identities before rejecting missing, duplicate or skipped contracts", async () => {
  type Event = { type: string; data: Record<string, unknown> };
  const base: Event[] = cognitiveRuntimeContracts.map(({ file, name }) => ({
    type: "test:pass",
    data: { file: resolve(applicationRoot, file), name },
  }));
  const summary = { type: "test:summary", data: {} };
  async function consume(values: Event[], trace: string[] = []) {
    async function* events() {
      for (const event of values) yield event;
      trace.push("drained");
    }
    const lines: string[] = [];
    for await (const line of reportCognitiveContracts(events()))
      lines.push(line);
    return lines;
  }
  const success = await consume([...base, summary]);
  assert.equal(success.length, 1);
  assert.equal(
    JSON.parse(success[0]!.slice("[cognitive contracts] ".length)).complete,
    true,
  );
  for (const values of [
    [...base.slice(1), summary],
    [...base, base[0]!, summary],
    [
      ...base.slice(1),
      { ...base[0]!, data: { ...base[0]!.data, skip: true } },
      summary,
    ],
    [
      ...base.slice(1),
      {
        ...base[0]!,
        data: {
          ...base[0]!.data,
          file: "/elsewhere/" + String(base[0]!.data.file),
        },
      },
      summary,
    ],
    [...base],
  ]) {
    const trace: string[] = [];
    await assert.rejects(
      consume(values, trace),
      /six exact cognitive Runtime contracts/,
    );
    assert.deepEqual(trace, ["drained"]);
  }
});

test("cognitive failure evidence removes inherited secrets, generated credentials and URL credentials", () => {
  const env = {
    OPENAI_API_KEY: "provider-secret-never-upload",
    MORPHZ_TEST_POSTGRES_URL: "postgres://user:db-password@127.0.0.1/test",
  };
  const secret = "9".repeat(64);
  const sanitized = sanitizeCognitiveEvidence(
    `provider-secret-never-upload\nAuthorization: Bearer generated-author-secret\n` +
      `{"token":"${secret}"}\nhttps://account:another-password@example.test/failed?key=another-query-secret\n` +
      env.MORPHZ_TEST_POSTGRES_URL +
      "\n" +
      resolve(applicationRoot, "tests/a.test.ts"),
    env,
  );
  for (const value of [
    "provider-secret-never-upload",
    "generated-author-secret",
    "db-password",
    "another-password",
    "another-query-secret",
    secret,
  ])
    assert.equal(sanitized.includes(value), false);
  assert.match(sanitized, /<application>/);
});

async function probe(
  source: string,
  options: {
    controller?: AbortController;
    timeoutMs?: number;
    cancellationGraceMs?: number;
    maximumBytes?: number;
  } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "morphz-cognitive-ci-gate-test-"),
  );
  let child: ChildProcess | undefined;
  try {
    const result = await runCognitiveRuntimeCI({
      env: {
        ...process.env,
        npm_execpath: "/fixture/npm-cli.js",
        PRIVATE_API_KEY: "failure-probe-secret",
      },
      evidenceRoot: directory,
      signal: options.controller?.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
      cancellationGraceMs: options.cancellationGraceMs ?? 1_000,
      maximumBytes: options.maximumBytes,
      launch: (...args) => {
        assert.deepEqual(args[1], [
          resolve(applicationRoot, "scripts/run-tests.mjs"),
          ...cognitiveRuntimeFiles,
        ]);
        const prepared = args[2] as { env: NodeJS.ProcessEnv };
        assert.equal(prepared.env.PRIVATE_API_KEY, undefined);
        child = spawn(process.execPath, ["--input-type=module", "-e", source], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout!.once("data", () => options.controller?.abort("SIGTERM"));
        return child;
      },
    });
    const stored = JSON.parse(
      await readFile(join(result.directory, "summary.json"), "utf8"),
    ) as CIRecord;
    assert.equal(stored.state, result.record.state);
    assert.deepEqual((await readdir(result.directory)).sort(), [
      "summary.json",
      "test-output.redacted.log",
    ]);
    if (process.platform !== "win32") {
      assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(result.directory, "summary.json"))).mode & 0o777,
        0o600,
      );
    }
    return {
      ...result,
      output: await readFile(
        join(result.directory, "test-output.redacted.log"),
        "utf8",
      ),
    };
  } finally {
    if (child?.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

test("real CI child success requires the reporter and failure output is bounded and redacted", async () => {
  const result = await probe(
    `process.stdout.write(${JSON.stringify(coverage())});`,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.record.state, "passed");
  assert.ok(result.record.coverage);
  const incomplete = await probe(
    'console.error("Authorization: Bearer generated-credential failure-probe-secret");',
  );
  assert.equal(incomplete.exitCode, 1);
  assert.equal(incomplete.record.state, "failed");
  assert.equal(incomplete.output.includes("generated-credential"), false);
  assert.equal(incomplete.output.includes("failure-probe-secret"), false);
  const failed = await probe(
    `process.stdout.write(${JSON.stringify(coverage())}); process.exitCode = 1;`,
  );
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.record.state, "failed");
  assert.equal(failed.record.coverage, undefined);
  const excessive = await probe(
    'process.stdout.write("X".repeat(4096)); setInterval(() => {}, 1000);',
    { maximumBytes: 64 },
  );
  assert.equal(excessive.exitCode, 1);
  assert.equal(excessive.record.state, "output-limit");
  assert.ok(excessive.output.length <= 64);
});

test("explicit cancellation, timeout and unexpected child loss never masquerade as passed contracts", async () => {
  const controller = new AbortController();
  const cancelled = await probe(
    'console.log("ready"); setInterval(() => {}, 1000);',
    { controller },
  );
  assert.equal(cancelled.record.state, "cancelled");
  assert.equal(cancelled.exitCode, 143);
  assert.equal(cancelled.record.coverage, undefined);
  const timeout = await probe("setInterval(() => {}, 1000);", {
    timeoutMs: 50,
  });
  assert.equal(timeout.record.state, "timed-out");
  assert.equal(timeout.exitCode, 1);
  const lost = await probe('process.kill(process.pid, "SIGKILL");');
  assert.equal(lost.record.state, "failed");
  assert.equal(lost.record.exitSignal, "SIGKILL");
  assert.equal(lost.record.coverage, undefined);
  assert.match(lost.record.cleanup!, /not proven/);
});

test("forced cancellation reports unconfirmed cleanup rather than declaring resources preserved", async () => {
  const result = await probe(
    'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
    { controller: new AbortController(), cancellationGraceMs: 50 },
  );
  assert.equal(result.record.state, "cancelled");
  assert.equal(result.record.exitSignal, "SIGKILL");
  assert.match(result.record.cleanup!, /cleanup unconfirmed/);
  assert.equal(result.record.coverage, undefined);
});

test("actual runner disappearance leaves an unfinished started record, never a fabricated final outcome", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "morphz-cognitive-ci-loss-test-"),
  );
  try {
    const entry = new URL(
      "../scripts/ci-cognitive-runtime.mjs",
      import.meta.url,
    ).href;
    const source = `import { runCognitiveRuntimeCI } from ${JSON.stringify(entry)};
await runCognitiveRuntimeCI({ env: { npm_execpath: "/fixture/npm-cli.js" },
evidenceRoot: ${JSON.stringify(directory)}, launch: () => { process.kill(process.pid, "SIGKILL"); } });`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exit = await new Promise<[number | null, NodeJS.Signals | null]>(
      (accept, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => accept([code, signal]));
      },
    );
    assert.deepEqual(exit, [null, "SIGKILL"]);
    const entries = await readdir(directory);
    assert.equal(entries.length, 1);
    const evidence = join(directory, entries[0]!);
    assert.deepEqual(await readdir(evidence), ["summary.json"]);
    const record = JSON.parse(
      await readFile(join(evidence, "summary.json"), "utf8"),
    );
    assert.equal(record.state, "running");
    assert.equal(record.finishedAt, undefined);
    assert.equal(record.exitCode, undefined);
    assert.equal(record.coverage, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
