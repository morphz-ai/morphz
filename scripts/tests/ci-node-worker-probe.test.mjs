import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendSnapshot,
  MAX_DOCUMENT_BYTES,
  MAX_PROCESS_FILES,
  MAX_SAMPLES,
  memorySnapshot,
  processIdentity,
  PROBE_ENV,
  serializeRecord,
  startProbe,
} from "../ci-node-worker-probe.mjs";

const probe = fileURLToPath(
  new URL("../ci-node-worker-probe.mjs", import.meta.url),
);
const manager = fileURLToPath(
  new URL("../../application/scripts/run-tests.mjs", import.meta.url),
);
function temporary(context) {
  const root = mkdtempSync(join(tmpdir(), "morphz-node-probe-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function child(args, cwd, directory, extra = {}, viaNodeOptions = false) {
  const env = { ...process.env, ...extra };
  delete env[PROBE_ENV];
  // The nested CLI is a coordinator, not this unit test's Node worker.
  delete env.NODE_TEST_CONTEXT;
  if (directory !== undefined) env[PROBE_ENV] = directory;
  if (viaNodeOptions)
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(probe)}`;
  return spawnSync(
    process.execPath,
    viaNodeOptions ? args : ["--import", probe, ...args],
    {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    },
  );
}
function records(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      value: JSON.parse(readFileSync(join(directory, name), "utf8")),
    }));
}

test("default preload creates no output and does not keep an idle Node alive", (context) => {
  const root = temporary(context);
  const result = child(["-e", ""], root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(readdirSync(root), []);
});

test("role and test basename require an exact selected file, never other argv", () => {
  const cwd = resolve("application");
  const file = resolve(cwd, "tests/allowed.test.ts");
  const selectedFiles = JSON.stringify(["tests/allowed.test.ts"]);
  assert.deepEqual(processIdentity({ argv1: file, selectedFiles, cwd }), {
    role: "worker",
    testFile: "allowed.test.ts",
  });
  assert.deepEqual(processIdentity({ argv1: manager, cwd }), {
    role: "manager",
    testFile: null,
  });
  assert.deepEqual(
    processIdentity({ argv1: file, execArgv: ["--test"], selectedFiles, cwd }),
    { role: "coordinator", testFile: null },
  );
  for (const options of [
    { argv1: file },
    { argv1: file, selectedFiles: "not-json" },
    {
      argv1: file,
      selectedFiles: JSON.stringify(["elsewhere/allowed.test.ts"]),
    },
    {
      argv1: resolve(cwd, "tests/private secret.test.ts"),
      selectedFiles: JSON.stringify(["tests/private secret.test.ts"]),
    },
    { argv1: file, selectedFiles: " ".repeat(1024 * 1024 + 1) },
    { argv1: file, selectedFiles: JSON.stringify(Array(4097).fill(file)) },
    { argv1: "--a-private-argument", selectedFiles },
  ])
    assert.deepEqual(processIdentity({ ...options, cwd }), {
      role: "node",
      testFile: null,
    });
});

test("real worker records its allowlisted identity before importing the test module", (context) => {
  const root = temporary(context),
    directory = join(root, "records");
  mkdirSync(directory, { mode: 0o700 });
  const fixture = join(root, "early.test.ts");
  writeFileSync(
    fixture,
    `
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const records = readdirSync(process.env.${PROBE_ENV}).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(process.env.${PROBE_ENV}, n), 'utf8')));
const own = records.find(r => r.pid === process.pid);
assert.ok(own, 'preload snapshot already exists at module import');
assert.equal(own.role, 'worker');
assert.equal(own.testFile, 'early.test.ts');
assert.equal(own.samples[0].phase, 'preload');
test('bounded early identity fixture', () => {});
`,
  );
  const result = child(["--test", fixture], root, directory, {
    MORPHZ_TEST_SELECTED_FILES: JSON.stringify([fixture]),
    MORPHZ_PROBE_TEST_PRIVATE_SENTINEL: "never-serialize-this-environment",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const inheritedDirectory = join(root, "inherited-records");
  mkdirSync(inheritedDirectory, { mode: 0o700 });
  const inherited = child(
    ["--test", fixture],
    root,
    inheritedDirectory,
    {
      MORPHZ_TEST_SELECTED_FILES: JSON.stringify([fixture]),
    },
    true,
  );
  assert.equal(inherited.status, 0, inherited.stderr + inherited.stdout);
  const values = [...records(directory), ...records(inheritedDirectory)].map(
    ({ value }) => value,
  );
  // The Node CLI coordinator can omit user preloads; only actual worker
  // instrumentation is promised. An external observer owns parent PID coverage.
  assert.ok(
    values.some(
      (value) =>
        value.role === "worker" && value.testFile === basename(fixture),
    ),
  );
  for (const value of values) {
    assert.deepEqual(
      Object.keys(value).sort(),
      [
        "schema",
        "pid",
        "ppid",
        "role",
        "testFile",
        "startedAtMs",
        "samples",
      ].sort(),
    );
    assert.ok(value.samples.length >= 1);
    assert.ok(!JSON.stringify(value).includes(root));
    assert.ok(!JSON.stringify(value).includes("never-serialize"));
    for (const sample of value.samples) {
      assert.deepEqual(
        Object.keys(sample).sort(),
        ["atMs", "phase", "heapUsedBytes", "externalBytes", "rssBytes"].sort(),
      );
      for (const key of ["atMs", "heapUsedBytes", "externalBytes", "rssBytes"])
        assert.ok(Number.isSafeInteger(sample[key]) && sample[key] >= 0);
    }
  }
});

test("opt-in idle process exits immediately and arbitrary arguments are not stored", (context) => {
  const root = temporary(context),
    directory = join(root, "records");
  mkdirSync(directory, { mode: 0o700 });
  const fixture = join(root, "ordinary.mjs");
  writeFileSync(fixture, "");
  const result = child([fixture, "private-user-argument"], root, directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const [{ name, value }] = records(directory);
  assert.equal(value.role, "node");
  assert.equal(value.testFile, null);
  assert.equal(value.samples.length, 1);
  assert.ok(!JSON.stringify(value).includes("private-user-argument"));
  assert.ok(!JSON.stringify(value).includes("ordinary"));
  if (process.platform !== "win32")
    assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
});

test("opt-in diagnostics preserve a failing process exit status", (context) => {
  const root = temporary(context);
  const result = child(["-e", "process.exit(17)"], root, root);
  assert.equal(result.status, 17);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(records(root).length, 1);
});

test("live sampling replaces one bounded file and has no exit flush or temp leftovers", (context) => {
  const root = temporary(context),
    directory = join(root, "records");
  mkdirSync(directory, { mode: 0o700 });
  const result = child(["-e", "setTimeout(() => {}, 2200)"], root, directory);
  assert.equal(result.status, 0, result.stderr);
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  const [{ name, value }] = records(directory);
  assert.ok(value.samples.length >= 3);
  assert.equal(value.samples[0].phase, "preload");
  assert.ok(
    value.samples.slice(1).every((sample) => sample.phase === "interval"),
  );
  assert.ok(statSync(join(directory, name)).size <= MAX_DOCUMENT_BYTES);
});

test("counter serialization and retained snapshots are bounded independent of runtime duration", () => {
  const memory = {
    heapUsed: 12,
    external: 34,
    rss: 56,
    privateField: "do not store",
  };
  assert.deepEqual(memorySnapshot(10, "anything", memory), {
    atMs: 10,
    phase: "interval",
    heapUsedBytes: 12,
    externalBytes: 34,
    rssBytes: 56,
  });
  assert.deepEqual(
    memorySnapshot(-1, "preload", {
      heapUsed: Infinity,
      external: -2,
      rss: "3",
    }),
    {
      atMs: null,
      phase: "preload",
      heapUsedBytes: null,
      externalBytes: null,
      rssBytes: null,
    },
  );
  let value = {
    schema: 1,
    pid: 1,
    ppid: 0,
    role: "node",
    testFile: null,
    startedAtMs: 0,
    samples: [],
  };
  for (let index = 0; index < 10000; index++)
    value = appendSnapshot(value, memorySnapshot(index, "interval", memory));
  assert.equal(value.samples.length, MAX_SAMPLES);
  assert.equal(value.samples[0].atMs, 10000 - MAX_SAMPLES);
  assert.equal(value.samples.at(-1).atMs, 9999);
  assert.ok(Buffer.byteLength(serializeRecord(value)) < MAX_DOCUMENT_BYTES);
  assert.equal(
    serializeRecord({ extra: "x".repeat(MAX_DOCUMENT_BYTES) }),
    null,
  );
});

test("invalid, missing, shared or symlink directories never create records or break the child", (context) => {
  const root = temporary(context),
    missing = join(root, "missing"),
    shared = join(root, "shared"),
    privatePath = join(root, "private");
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(shared, 0o755);
  mkdirSync(privatePath, { mode: 0o700 });
  const directories = ["relative-path", missing];
  if (process.platform !== "win32") {
    directories.push(shared);
    const linked = join(root, "linked");
    symlinkSync(privatePath, linked);
    directories.push(linked);
  }
  for (const directory of directories) {
    const result = child(["-e", ""], root, directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "");
  }
  assert.equal(existsSync(missing), false);
  assert.deepEqual(readdirSync(shared), []);
  assert.deepEqual(readdirSync(privatePath), []);
});

test("record-directory admission refuses a full inventory and preserves existing files", (context) => {
  const root = temporary(context);
  for (let index = 0; index < MAX_PROCESS_FILES; index++)
    writeFileSync(
      join(root, `morphz-node-probe-${index}-1.json`),
      "existing\n",
    );
  assert.equal(startProbe(root), null);
  assert.equal(readdirSync(root).length, MAX_PROCESS_FILES);
  assert.equal(
    readFileSync(join(root, "morphz-node-probe-0-1.json"), "utf8"),
    "existing\n",
  );
});
