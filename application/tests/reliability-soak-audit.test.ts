import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// The audit CLI is intentionally native ESM and is also callable without tsx.
const {
  auditData,
  countFormula,
  resourceAnalysis,
  scenarios: rawScenarios,
} = await import(
  new URL("../scripts/reliability-soak-audit.mjs", import.meta.url).href
);
const scenarios = rawScenarios as string[];
// Negative controls deliberately mutate individual fields into invalid states.
type Row = Record<string, any>;
type Ledger = Record<
  | "threads"
  | "outcomes"
  | "signals"
  | "sessionRequests"
  | "activations"
  | "jobs"
  | "plans"
  | "schedules"
  | "timers"
  | "deliveries"
  | "contents"
  | "objects"
  | "versions"
  | "objectReceipts"
  | "provenance"
  | "undeliveredObjectEvents"
  | "pendingTaskEvents"
  | "integrity",
  Row[]
>;
type Evidence = {
  manifest: Row;
  result: Row | null;
  trace: Row[];
  resources: Row[];
  ledger: Ledger;
  hashes: Row;
  cleanup: Row;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const at = (ms: number) => new Date(Date.UTC(2026, 9, 5) + ms).toISOString();

function fixture(cycles = 6): Evidence {
  const hash = "a".repeat(64),
    head = "b".repeat(40),
    trace: Row[] = [],
    resources: Row[] = [];
  const manifest = {
    format: "morphz-reliability-soak/v1",
    startedAt: at(0),
    durationMs: cycles * 1000,
    intervalMs: 1000,
    head,
    harnessSha256: hash,
    oracleSha256: hash,
    binary: {
      requiredHead: head,
      version: `morphz 0.1.3 (git ${head.slice(0, 12)})`,
      sha256: hash,
    },
    requestedScenarios: [...scenarios],
    cadence: {
      workloadEveryCycle: scenarios.slice(0, 5),
      providerFaultEveryCycles: 5,
      hostReopenEveryCycles: 15,
      runtimeCrashEveryCycles: 60,
      firstCycleCoversAll: true,
    },
  };
  const ledger: Ledger = {
    threads: [],
    outcomes: [],
    signals: [],
    sessionRequests: [],
    activations: [],
    jobs: [],
    plans: [],
    schedules: [],
    timers: [],
    deliveries: [],
    contents: [],
    objects: [],
    versions: [],
    objectReceipts: [],
    provenance: [],
    undeliveredObjectEvents: [],
    pendingTaskEvents: [],
    integrity: [
      "runtime/runtime.sqlite",
      "application/platform.sqlite",
      "application/workspace.sqlite",
      "application/objects.sqlite",
    ].map((relativePath) => ({
      relativePath,
      quickCheck: ["ok"],
      foreignKeyErrors: [],
    })),
  };
  const push = (ms: number, event: string, value: Row = {}) =>
    trace.push({ at: at(ms), elapsedMs: ms, event, value });
  let rootIndex = 0,
    inputIndex = 0,
    jobIndex = 0,
    requestIndex = 0,
    runtimePid = 100;
  const coverage = Object.fromEntries(scenarios.map((s) => [s, 0]));
  function root(ms: number) {
    const id = `root-${++rootIndex}`,
      t = {
        id: "thread-" + id,
        root_turn_id: id,
        generation: 1,
        status: "completed",
      };
    const o = {
      thread_id: t.id,
      root_turn_id: id,
      thread_generation: 1,
      terminal_kind: "completed",
    };
    ledger.threads.push(t);
    ledger.outcomes.push(o);
    push(ms, "terminal-root-verified", {
      root: id,
      evidence: {
        threads: [t],
        outcomes: [o],
        liveActivations: [],
        pendingSignals: [],
      },
    });
    return id;
  }
  function input(ms: number, rootId?: string) {
    const id = `input-${++inputIndex}`;
    push(ms, "host-input-accepted", {
      command: { commandId: id },
      receipt: { commandId: id, entityId: id },
    });
    if (rootId) push(ms, "root-bound", { inputId: id, root: rootId });
    ledger.deliveries.push({
      inputId: id,
      rootId: rootId ?? null,
      state: "completed",
      sessionId: "fixture-session",
    });
    ledger.sessionRequests.push({
      session_id: "fixture-session",
      client_message_id: id,
      event_id: rootId ?? "steer-" + id,
    });
    return id;
  }
  function write(
    ms: number,
    cycle: number,
    name: string,
    rootId: string,
    inputId: string,
  ) {
    const jobId = `job-${++jobIndex}`,
      contentId = "content-" + jobId,
      objectId = "object-" + jobId,
      receipt = "receipt-" + jobId,
      catalog = "catalog-" + jobId,
      title = `${name === "host-reopen" ? "SOAK_HOST" : "SOAK_DOCUMENT"}_${cycle}`,
      markdown = "Exact persisted body " + title,
      payload = JSON.stringify({ kind: "document", markdown });
    const job = {
      id: jobId,
      activation_id: "activation-" + jobId,
      thread_id: "thread-" + rootId,
      tool_call_id: "call-" + jobId,
      root_turn_id: rootId,
      status: "succeeded",
      result_event_id: "event-" + jobId,
      result_type: "tool_output",
      result_thread_id: "thread-" + rootId,
      request_json: JSON.stringify({
        action: "create-document",
        title,
        markdown,
      }),
      result_payload: JSON.stringify({
        tool_status: "success",
        root_turn_id: rootId,
        execution_job_id: jobId,
        text: JSON.stringify({ ok: true, contentId, versionRef: "1", receipt }),
      }),
    };
    ledger.jobs.push(job);
    ledger.contents.push({ content_id: contentId });
    ledger.objects.push({ object_id: objectId, head_revision: 1 });
    ledger.versions.push({
      object_id: objectId,
      revision: 1,
      title,
      payload_body: payload,
      payload_sha256: sha(payload),
    });
    ledger.objectReceipts.push({
      command_id: receipt,
      object_id: objectId,
      revision: 1,
      operation: "create-document",
    });
    ledger.provenance.push({
      command_id: catalog,
      runtime_input_id: inputId,
      content_id: contentId,
      app_object_id: objectId,
      title,
      project_id: "soak-project",
      observed_version_ref: "1",
      event_kind: "content.recorded",
    });
    if (name === "host-reopen") {
      push(ms, "actual-committed-host-response-held", { jobId });
      push(ms, "original-host-response-released", { jobId });
      push(ms, "host-opened");
      return {
        root: rootId,
        originalCommandId: inputId,
        physicalJobId: jobId,
        committedContentId: contentId,
      };
    }
    return {
      root: rootId,
      inputId,
      jobs: [{ id: jobId }],
      contentId,
      bodySha256: sha(markdown),
      provenance: [{ commandId: catalog }],
    };
  }
  function sample(ms: number, cycle: number) {
    const s = {
      at: at(ms),
      elapsedMs: ms,
      cycle,
      providerCalls: requestIndex,
      processStats: {
        harness: { pid: 300, rssKiB: 1000 + cycle, fdCount: 20 },
        runtime: { pid: runtimePid, rssKiB: 2000 + cycle, fdCount: 21 },
      },
      harnessMemory: {
        rss: 100_000,
        heapUsed: 5000 + cycle,
        external: 2000,
        arrayBuffers: 1000,
      },
      databaseBytes: 4000 + cycle * 100,
      files: ledger.integrity.map((x) => ({
        path: x.relativePath,
        byteLength: 1000,
      })),
      counts: {
        events: 1 + cycle * 100,
        threads: ledger.threads.length,
        thread_outcomes: ledger.outcomes.length,
        thread_signals: 0,
        thread_activations: 0,
        execution_jobs: ledger.jobs.length,
        plan_executions: ledger.plans.length,
        schedules: ledger.schedules.length,
      },
    };
    resources.push(s);
    push(ms, "resource-sample", {
      providerCalls: requestIndex,
      counts: s.counts,
    });
  }
  push(0, "runtime-started", { pid: runtimePid });
  push(0, "host-opened");
  sample(1, 0);
  for (let c = 1; c <= cycles; c++) {
    const start = (c - 1) * 1000 + 10,
      ms = start + 20;
    push(start, "cycle-start", { cycle: c });
    const ordinary = Array.from({ length: 7 }, () => root(ms));
    const ordinaryInputs = ordinary.slice(0, 5).map((r) => input(ms, r));
    input(ms);
    ledger.plans.push({ id: "plan-" + c, status: "succeeded" });
    ledger.schedules.push({
      id: "schedule-" + c,
      source_turn_id: ordinary[6],
      status: "dispatched",
    });
    for (const name of scenarios.slice(0, 5)) {
      const evidence =
        name === "host-tool-write"
          ? write(ms, c, name, ordinary[4]!, ordinaryInputs[4]!)
          : {};
      push(ms, "scenario-verified", {
        scenario: name,
        occurrence: (coverage[name] = (coverage[name] ?? 0) + 1),
        evidence,
      });
    }
    if (c === 1 || c % 5 === 0) {
      const r = root(ms);
      input(ms, r);
      input(ms, root(ms));
      push(ms, "injected-provider-socket-disconnect");
      push(ms, "scenario-verified", {
        scenario: "provider-disconnect",
        occurrence: (coverage["provider-disconnect"] =
          (coverage["provider-disconnect"] ?? 0) + 1),
        evidence: { root: r },
      });
    }
    if (c === 1 || c % 15 === 0) {
      const r = root(ms),
        i = input(ms, r),
        evidence = write(ms, c, "host-reopen", r, i);
      push(ms, "scenario-verified", {
        scenario: "host-reopen",
        occurrence: (coverage["host-reopen"] =
          (coverage["host-reopen"] ?? 0) + 1),
        evidence,
      });
    }
    if (c === 1 || c % 60 === 0) {
      const r = root(ms);
      input(ms, r);
      push(ms, "injected-runtime-crash", { ownedPid: runtimePid });
      runtimePid++;
      push(ms, "runtime-started", { pid: runtimePid });
      push(ms, "scenario-verified", {
        scenario: "runtime-crash-recovery",
        occurrence: (coverage["runtime-crash-recovery"] =
          (coverage["runtime-crash-recovery"] ?? 0) + 1),
        evidence: { root: r },
      });
    }
    const expected = countFormula(c, coverage);
    while (requestIndex < expected.providerCalls)
      push(ms, "provider-request", {
        sequence: ++requestIndex,
        byteLength: 100,
      });
    sample(start + 100, c);
    push(start + 101, "cycle-verified", {
      cycle: c,
      providerCalls: requestIndex,
      coverage: { ...coverage },
    });
  }
  sample(manifest.durationMs + 1, cycles);
  const result = {
    format: "morphz-reliability-soak-result/v1",
    outcome: "passed",
    failure: null,
    cleanupFailures: [],
    startedAt: manifest.startedAt,
    finishedAt: at(manifest.durationMs + 100),
    elapsedMs: manifest.durationMs + 100,
    requestedDurationMs: manifest.durationMs,
    cycles,
    coverage: { ...coverage },
    providerCalls: requestIndex,
    verifiedRoots: rootIndex,
    verifiedTerminalCounts: { completed: rootIndex, failed: 0, cancelled: 0 },
    maximumVerifiedGapMs: 1000,
    allowedVerifiedGapMs: 180_000,
    originalAppTouched: false,
    paidModelCalls: 0,
  };
  push(result.elapsedMs, "run-finished", result);
  return {
    manifest,
    result,
    trace,
    resources,
    ledger,
    hashes: { binary: hash, harness: hash, oracle: hash },
    cleanup: { confirmed: true, livePids: [], proxyDirectoryExists: false },
  };
}

test("complete synthetic ledger passes mechanically without a leak-free claim", () => {
  const report = auditData(fixture());
  assert.equal(report.status, "PASS", JSON.stringify(report.failures));
  assert.equal(report.mechanicalPass, true);
  assert.equal(report.resources.status, "REQUIRES_INTERPRETATION");
  assert.equal(report.resources.leakFreeClaim, false);
  assert.equal(report.resources.runtimeEpochs.length, 2);
  assert.equal(
    report.resources.harness.sufficientForEarlyLateComparison,
    false,
  );
});

test("mechanical acceptance rejects a consistently failed workload root", () => {
  const e = fixture();
  const thread = e.ledger.threads[0]!;
  thread.status = "failed";
  e.ledger.outcomes.find(
    (outcome) => outcome.root_turn_id === thread.root_turn_id,
  )!.terminal_kind = "failed";
  for (const entry of e.trace.filter(
    (entry) =>
      entry.event === "terminal-root-verified" &&
      entry.value.root === thread.root_turn_id,
  )) {
    entry.value.evidence.threads[0].status = "failed";
    entry.value.evidence.outcomes[0].terminal_kind = "failed";
  }
  e.result!.verifiedTerminalCounts.completed--;
  e.result!.verifiedTerminalCounts.failed++;
  e.trace.find((entry) => entry.event === "run-finished")!.value = e.result;

  const report = auditData(e);
  assert.equal(report.status, "FAILED");
  assert.equal(report.mechanicalPass, false);
  for (const code of ["trace-terminal-evidence", "terminal-generation-status"])
    assert.ok(report.failures.some((failure: Row) => failure.code === code));
  assert.ok(
    !report.failures.some(
      (failure: Row) => failure.code === "terminal-counts-result",
    ),
    "Matching failed terminal counts do not satisfy successful work acceptance",
  );
});

test("negative controls reject stranded claimed Signal, missing root, duplicate Job and exact original corruption", () => {
  const controls: Array<[string, (e: Evidence) => void]> = [
    [
      "live-signals",
      (e) => e.ledger.signals.push({ id: "stranded", status: "claimed" }),
    ],
    ["exact-root-set", (e) => e.ledger.threads.pop()],
    ["exact-job-set", (e) => e.ledger.jobs.push({ ...e.ledger.jobs[0] })],
    [
      "original-exact-content-version",
      (e) => {
        e.ledger.versions[0]!.payload_body = JSON.stringify({
          kind: "document",
          markdown: "wrong",
        });
      },
    ],
    [
      "original-command-receipt",
      (e) => {
        e.ledger.objectReceipts[0]!.object_id = "wrong-object";
      },
    ],
    [
      "delivery-exact-root-binding",
      (e) => {
        e.ledger.deliveries[0]!.rootId = "wrong-root";
      },
    ],
    [
      "durable-input-receipt-set",
      (e) => {
        e.ledger.sessionRequests.pop();
      },
    ],
  ];
  for (const [code, mutate] of controls) {
    const e = fixture();
    mutate(e);
    const report = auditData(e);
    assert.equal(report.status, "FAILED", code);
    assert.ok(
      report.failures.some((x: Row) => x.code === code),
      code,
    );
  }
});

test("negative controls reject missing FD, cleanup, hash, cadence, actual fault evidence and integrity", () => {
  const controls: Array<[string, (e: Evidence) => void]> = [
    [
      "fd-sample-missing",
      (e) => {
        e.resources[2]!.processStats.runtime.fdCount = null;
      },
    ],
    [
      "runtime-epoch-pid",
      (e) => {
        e.resources[2]!.processStats.runtime.pid++;
      },
    ],
    [
      "sample-history-count-formula",
      (e) => {
        e.resources[2]!.counts.threads++;
      },
    ],
    [
      "cleanup-result",
      (e) => {
        delete e.result!.cleanupFailures;
      },
    ],
    [
      "cleanup-independent",
      (e) => {
        e.cleanup.livePids = [100];
      },
    ],
    [
      "frozen-binary-hash",
      (e) => {
        e.hashes.binary = "c".repeat(64);
      },
    ],
    [
      "scenario-cadence",
      (e) => {
        const i = e.trace.findIndex(
          (x) =>
            x.event === "scenario-verified" &&
            x.value.scenario === "provider-disconnect" &&
            x.value.occurrence === 2,
        );
        e.trace.splice(i, 1);
      },
    ],
    [
      "actual-fault-count",
      (e) => {
        e.trace = e.trace.filter(
          (x) => x.event !== "injected-provider-socket-disconnect",
        );
      },
    ],
    [
      "sqlite-integrity",
      (e) => {
        e.ledger.integrity[0]!.foreignKeyErrors.push({ table: "threads" });
      },
    ],
    [
      "sqlite-integrity-file-set",
      (e) => {
        e.ledger.integrity.pop();
      },
    ],
    [
      "live-timers",
      (e) => {
        e.ledger.timers.push({ id: "abandoned", status: "pending" });
      },
    ],
    [
      "schedule-count-status",
      (e) => {
        e.ledger.schedules[0]!.status = "queued";
      },
    ],
  ];
  for (const [code, mutate] of controls) {
    const e = fixture();
    mutate(e);
    const report = auditData(e);
    assert.equal(report.status, "FAILED", code);
    assert.ok(
      report.failures.some((x: Row) => x.code === code),
      code,
    );
  }
});

test("no result is always INCOMPLETE, even if a synthetic ledger is already settled", () => {
  const e = fixture();
  e.result = null;
  e.trace = e.trace.filter((x) => x.event !== "run-finished");
  const report = auditData(e);
  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.mechanicalPass, false);
  assert.match(report.warnings.join(" "), /never PASS/);
});

test("resource trends separate PID epochs, discard warmup and expose ten-sample heap lower envelopes", () => {
  const e = fixture(40);
  for (let i = 0; i < e.resources.length; i++) {
    const s = e.resources[i]!;
    s.harnessMemory.heapUsed = 1000 + i * 100;
    s.processStats.harness.rssKiB = 10_000 + i * 100;
    s.processStats.runtime.rssKiB = 20_000 + i * 50;
  }
  const report = resourceAnalysis(e.resources, e.trace, e.ledger);
  assert.equal(report.runtimeEpochs.length, 2);
  assert.equal(report.harness.excludedWarmupSamples, 5);
  assert.equal(report.harness.tenSampleWindows.length, 3);
  assert.ok(report.harness.heapLowEnvelopeBytesPerHour > 0);
  assert.ok(report.harness.rssKiB.theilSenPerHour > 0);
  assert.ok(report.harness.sufficientForEarlyLateComparison);
  assert.equal(report.leakFreeClaim, false);
});
