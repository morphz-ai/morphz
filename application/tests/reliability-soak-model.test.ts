import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRunComplete,
  assertTerminalRoot,
  positiveMilliseconds,
  requiredScenarios,
  observeVerifiedGap,
  runCleanupStages,
  cleanupOwnedProxyDirectory,
  type TerminalEvidence,
} from "../scripts/reliability-soak-model.js";

const terminal = (): TerminalEvidence => ({
  threads: [
    { id: "thread", root_turn_id: "root", generation: 2, status: "completed" },
  ],
  outcomes: [
    {
      thread_id: "thread",
      root_turn_id: "root",
      thread_generation: 2,
      terminal_kind: "completed",
    },
  ],
  liveActivations: [],
  pendingSignals: [],
});

test("soak oracle rejects replies without the exact persisted terminal chain", () => {
  assertTerminalRoot("root", terminal());
  for (const mutate of [
    (e: TerminalEvidence) => {
      e.outcomes = [];
    },
    (e: TerminalEvidence) => {
      e.outcomes.push(e.outcomes[0]!);
    },
    (e: TerminalEvidence) => {
      e.outcomes[0]!.thread_generation = 1;
    },
    (e: TerminalEvidence) => {
      e.outcomes[0]!.root_turn_id = "other";
    },
    (e: TerminalEvidence) => {
      e.liveActivations = [{ status: "running" }];
    },
    (e: TerminalEvidence) => {
      e.pendingSignals = [{ status: "pending" }];
    },
  ]) {
    const evidence = terminal();
    mutate(evidence);
    assert.throws(() => assertTerminalRoot("root", evidence));
  }
});

test("a five-minute smoke cannot become an eight-hour pass or invent scenario coverage", () => {
  const complete = {
    elapsedMs: 28_800_000,
    requestedDurationMs: 28_800_000,
    cycles: 20,
    coverage: Object.fromEntries(
      requiredScenarios.map((scenario) => [scenario, 1]),
    ),
    unsettledRoots: 0,
  };
  assertRunComplete(complete);
  assert.throws(() => assertRunComplete({ ...complete, elapsedMs: 300_000 }));
  assert.throws(() => assertRunComplete({ ...complete, coverage: {} }));
  assert.throws(() => assertRunComplete({ ...complete, unsettledRoots: 1 }));
  assert.throws(() => assertRunComplete({ ...complete, cycles: 0 }));
  assert.throws(() =>
    assertRunComplete({
      ...complete,
      maximumVerifiedGapMs: 3_600_000,
      allowedVerifiedGapMs: 180_000,
    }),
  );
});

test("duration parsing rejects zero, fractional, overflowing and injected values", () => {
  assert.equal(positiveMilliseconds("28800000", "duration"), 28_800_000);
  for (const value of [
    "0",
    "-1",
    "1.5",
    "1e3",
    "Infinity",
    "9007199254740993",
    "100;exit",
  ])
    assert.throws(() => positiveMilliseconds(value, "duration"));
});

test("the unobserved final idle interval cannot turn suspension into a completed soak", () => {
  assert.equal(observeVerifiedGap(61_000, 1000, 10_000, 180_000), 60_000);
  assert.throws(() => observeVerifiedGap(3_601_000, 1000, 10_000, 180_000));
  assert.throws(() => observeVerifiedGap(900, 1000, 10_000, 180_000));
});

test("throwing or hanging cleanup does not skip provider/proxy or evidence-finalization stages", async () => {
  const attempted: string[] = [];
  const failures = await runCleanupStages([
    {
      name: "runtime",
      run: () => {
        attempted.push("runtime");
        throw new Error("injected stop failure");
      },
    },
    {
      name: "host",
      timeoutMs: 10,
      run: () => {
        attempted.push("host");
        return new Promise<void>(() => {});
      },
    },
    {
      name: "proxy",
      run: () => {
        attempted.push("proxy");
      },
    },
    {
      name: "provider",
      run: () => {
        attempted.push("provider");
      },
    },
    {
      name: "result",
      run: () => {
        attempted.push("result");
      },
    },
  ]);
  assert.deepEqual(attempted, [
    "runtime",
    "host",
    "proxy",
    "provider",
    "result",
  ]);
  assert.deepEqual(
    failures.map((failure) => failure.stage),
    ["runtime", "host"],
  );
  assert.match(failures[1]!.error, /unconfirmed/);
});

test("owned relay cleanup removes only its empty generated folder and preserves unexpected material", () => {
  const clean = mkdtempSync(join(tmpdir(), "morphz-soak-proxy-"));
  cleanupOwnedProxyDirectory(clean);
  assert.equal(existsSync(clean), false);
  const retained = mkdtempSync(join(tmpdir(), "morphz-soak-proxy-"));
  const unexpected = join(retained, "evidence.txt");
  writeFileSync(unexpected, "keep", { mode: 0o600 });
  try {
    assert.throws(() => cleanupOwnedProxyDirectory(retained));
    assert.ok(existsSync(unexpected));
  } finally {
    unlinkSync(unexpected);
    rmdirSync(retained);
  }
});
