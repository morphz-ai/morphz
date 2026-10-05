import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fixtureEventEvidence,
  redactFixtureEvidence,
  retainFixtureFailure,
} from "../scripts/runtime-fixture-evidence.js";

test("public Runtime diagnostics allow causal fields, never raw input/tool/config payloads", () => {
  const payload = {
    reason: "Required final reply title missing",
    thread_id: "thread-1",
    token: "secret",
    text: "private input",
    request: { secret: true },
    raw_response: { content: "private reply" },
  };
  assert.deepEqual(
    fixtureEventEvidence({
      id: "error-1",
      timestamp: "now",
      topic: "runtime/response_protocol_error",
      payload: JSON.stringify(payload),
    }),
    {
      id: "error-1",
      timestamp: "now",
      topic: "runtime/response_protocol_error",
      thread_id: "thread-1",
      reason: payload.reason,
    },
  );
  assert.deepEqual(fixtureEventEvidence({ payload: "invalid secret bytes" }), {
    id: undefined,
    timestamp: undefined,
    topic: undefined,
  });
  assert.equal(
    redactFixtureEvidence(
      "Bearer unknown-secret token=unknown-token fixture-secret",
      ["fixture-secret"],
    ),
    "Bearer [redacted] token=[redacted] [redacted]",
  );
});

test("failure export keeps exact cause/outcome and is upload-safe without copying fixture databases", () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-evidence-test-"));
  try {
    const path = join(root, "fixture.sqlite"),
      output = join(root, "export");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE events(id TEXT, timestamp TEXT, topic TEXT, payload TEXT);
      CREATE TABLE thread_outcomes(thread_id TEXT, root_turn_id TEXT, activation_id TEXT, session_id TEXT, terminal_kind TEXT, disposition TEXT, event_id TEXT, created_at TEXT);`);
    db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(
      "event-1",
      "now",
      "runtime/response_protocol_error",
      JSON.stringify({
        reason: "required annotation absent",
        thread_id: "thread-1",
        text: "secret-input",
        token: "operator-secret",
      }),
    );
    db.prepare("INSERT INTO thread_outcomes VALUES(?,?,?,?,?,?,?,?)").run(
      "thread-1",
      "root-1",
      "activation-1",
      "session-1",
      "failed",
      "deliver",
      "event-1",
      "now",
    );
    db.close();
    const cause = retainFixtureFailure({
      databasePath: path,
      directory: output,
      logs: "operator-secret and Bearer unexpected-secret",
      error: new Error("operator-secret"),
      secrets: ["operator-secret"],
      metadata: {
        test: "runtime-ipc",
        nodeVersion: process.version,
        providerCalls: 2,
        binaryVersion: "synthetic",
      },
    });
    assert.equal(cause?.thread_id, "thread-1");
    const evidence = readFileSync(join(output, "failure.json"), "utf8");
    assert.ok(
      !evidence.includes("operator-secret") &&
        !evidence.includes("secret-input"),
    );
    assert.equal(JSON.parse(evidence).outcomes[0].terminal_kind, "failed");
    assert.match(evidence, /required annotation absent/);
    assert.deepEqual(readdirSync(output).sort(), [
      "failure.json",
      "runtime.log",
    ]);
    assert.equal(
      readFileSync(join(output, "runtime.log"), "utf8"),
      "[redacted] and Bearer [redacted]",
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("early failures report evidence-read failure without masking the original error", () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-early-evidence-test-"));
  try {
    retainFixtureFailure({
      databasePath: join(root, "missing.sqlite"),
      directory: root,
      logs: "",
      error: new Error("initial failure"),
      secrets: [],
      metadata: {
        test: "runtime-ipc",
        nodeVersion: process.version,
        providerCalls: 0,
        binaryVersion: "synthetic",
      },
    });
    const value = JSON.parse(readFileSync(join(root, "failure.json"), "utf8"));
    assert.match(value.error, /initial failure/);
    assert.ok(value.evidenceReadError);
  } finally {
    rmSync(root, { recursive: true });
  }
});
