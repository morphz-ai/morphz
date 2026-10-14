import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hostFailureDiagnostic,
  privateHostFailureReporter,
} from "../packages/application/src/host-diagnostics.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";

test("Host diagnostics never serialize credentials, error prose, request values or unrelated paths", () => {
  const secret = "Bearer private-secret-value";
  const cause = Object.assign(new Error(secret), { code: "ECONNRESET" });
  const error = new TypeError(secret, { cause });
  error.stack = `${error.name}: ${secret}\n    at read (/Users/example/Codes/Morphz/application/packages/application/src/application.ts:12:34)\n    at https://user:${secret}@example.test/private.js:2:3\n    at /Users/example/Documents/private-book.txt:1:2`;
  const diagnostic = hostFailureDiagnostic(
    "application.runtime.navigation",
    error,
  );
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private-book"), false);
  assert.equal(serialized.includes("https://"), false);
  assert.deepEqual(diagnostic.frames, [
    "application/packages/application/src/application.ts:12:34",
  ]);
  assert.deepEqual(diagnostic.errors, [
    { name: "TypeError" },
    { name: "Error", code: "ECONNRESET" },
  ]);
});

test("diagnostics bound cyclic causes and refuse arbitrary error name/code values", () => {
  const error = Object.assign(new Error("not recorded"), {
    name: "PrivateCredential",
    code: "EPRIVATE_CREDENTIAL",
    errcode: "private",
    cause: undefined as unknown,
  });
  error.cause = error;
  assert.deepEqual(hostFailureDiagnostic("not an operation", error).errors, [
    { name: "Error" },
  ]);
  assert.equal(
    hostFailureDiagnostic("not an operation", error).operation,
    "unknown",
  );
  const sqlite = Object.assign(new Error("private SQL text"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  assert.deepEqual(hostFailureDiagnostic("runtime.poll", sqlite).errors, [
    { name: "Error", code: "ERR_SQLITE_ERROR", sqliteCode: 5 },
  ]);
});

test("multiline error prose and a missing stack separator cannot become diagnostic frames", () => {
  const error = new Error("private\n at /application/apps/private-key.js:1:2");
  error.stack = `${error.name}: ${error.message}\n at /application/packages/application/src/runtime.ts:3:4`;
  assert.deepEqual(hostFailureDiagnostic("runtime.poll", error).frames, [
    "application/packages/application/src/runtime.ts:3:4",
  ]);
  error.stack = "Error: /application/apps/private-key.js:1:2";
  assert.deepEqual(hostFailureDiagnostic("runtime.poll", error).frames, []);
});

test("private diagnostics deduplicate alternating errors, preserve 0600 and bound retention", () => {
  const profile = mkdtempSync(join(tmpdir(), "morphz-diagnostics-"));
  try {
    const report = privateHostFailureReporter(profile);
    const error = new Error("private content");
    report("runtime.poll", error);
    report("application.runtime.navigation", error);
    report("runtime.poll", error);
    const file = join(profile, "diagnostics", "host-failures.jsonl");
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].pid, process.pid);
    if (process.platform !== "win32")
      assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, " ".repeat(128 * 1024), { mode: 0o600 });
    report("application.app-views.list", error);
    assert.equal(
      statSync(join(profile, "diagnostics", "host-failures.previous.jsonl"))
        .size,
      128 * 1024,
    );
    assert.ok(statSync(file).size < 4096);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("diagnostics reject symlink roots/files and never overwrite their targets", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "morphz-diagnostics-links-"));
  try {
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    const first = join(root, "first");
    mkdirSync(first, { mode: 0o700 });
    symlinkSync(target, join(first, "diagnostics"));
    privateHostFailureReporter(first)(
      "runtime.poll",
      new Error("not recorded"),
    );
    assert.equal(existsSync(join(target, "host-failures.jsonl")), false);
    const second = join(root, "second");
    mkdirSync(join(second, "diagnostics"), { recursive: true, mode: 0o700 });
    const original = join(root, "original");
    writeFileSync(original, "preserved", { mode: 0o600 });
    symlinkSync(original, join(second, "diagnostics", "host-failures.jsonl"));
    privateHostFailureReporter(second)(
      "runtime.poll",
      new Error("not recorded"),
    );
    assert.equal(readFileSync(original, "utf8"), "preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected local invocation failures report their exact method without changing the reply", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const app = new Application(store);
    const original = app.session.bind(app);
    const failure = new TypeError("private body not logged");
    app.session = (access, active) => {
      const session = original(access, active);
      session.platformBootstrap = () => {
        throw failure;
      };
      return session;
    };
    const calls: string[] = [];
    const connection = new LocalApplicationConnection(
      app,
      undefined,
      (method, error) => {
        calls.push(method);
        assert.equal(error, failure);
        throw new Error("logger also failed");
      },
    );
    const reply = await connection.invoke({
      id: crypto.randomUUID(),
      method: "platform.bootstrap",
    });
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.status, 500);
    assert.deepEqual(calls, ["application.platform.bootstrap"]);
    connection.close();
  } finally {
    store.close();
  }
});
