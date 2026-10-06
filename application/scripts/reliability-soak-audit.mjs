/** Independent, read-only audit of reliability-soak evidence.
 * node scripts/reliability-soak-audit.mjs /absolute/evidence/directory
 * stdout only. Exit 0 = mechanical PASS, 1 = FAILED, 2 = INCOMPLETE.
 * A mechanical PASS is deliberately not a leak-free or live-model claim.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const scenarios = [
  "parallel-steering",
  "context-transaction",
  "durable-infer",
  "scheduled-task",
  "host-tool-write",
  "provider-disconnect",
  "host-reopen",
  "runtime-crash-recovery",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => JSON.stringify(value);
const sorted = (values) => [...values].sort();
const equalSet = (a, b) =>
  stable(sorted(new Set(a))) === stable(sorted(new Set(b))) &&
  a.length === new Set(a).size &&
  b.length === new Set(b).size;
const quantile = (values, q) => {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y),
    index = (a.length - 1) * q;
  return (
    a[Math.floor(index)] +
    (a[Math.ceil(index)] - a[Math.floor(index)]) * (index % 1)
  );
};
const stats = (values) => ({
  samples: values.length,
  min: quantile(values, 0),
  p50: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  max: quantile(values, 1),
});
function slope(points) {
  const rates = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (points[j][0] > points[i][0])
        rates.push(
          (points[j][1] - points[i][1]) / (points[j][0] - points[i][0]),
        );
  return quantile(rates, 0.5);
}
export function countFormula(cycles, coverage) {
  const f = coverage["provider-disconnect"] ?? 0,
    h = coverage["host-reopen"] ?? 0,
    r = coverage["runtime-crash-recovery"] ?? 0;
  return {
    roots: 7 * cycles + 2 * f + h + r,
    inputs: 6 * cycles + 2 * f + h + r,
    jobs: cycles + h,
    documents: cycles + h,
    plans: cycles,
    schedules: cycles,
    providerCalls: 11 * cycles + 3 * f + 2 * h + 2 * r,
  };
}
function expectedCadence(cycle) {
  return Object.fromEntries(
    scenarios.map((name) => [
      name,
      name === "provider-disconnect"
        ? cycle === 1 || cycle % 5 === 0
        : name === "host-reopen"
          ? cycle === 1 || cycle % 15 === 0
          : name === "runtime-crash-recovery"
            ? cycle === 1 || cycle % 60 === 0
            : true,
    ]),
  );
}
function traceCycles(trace) {
  let cycle = 0;
  return trace.map((entry) => {
    if (entry.event === "cycle-start") cycle = entry.value.cycle;
    return { ...entry, cycle };
  });
}
function processSummary(samples, name, warmup = 5) {
  const stableSamples = samples.slice(warmup),
    values = (key) =>
      stableSamples
        .map((x) => x.processStats[name][key])
        .filter(Number.isFinite);
  const metric = (key) => {
    const points = stableSamples
      .map((x) => [x.elapsedMs / 3_600_000, x.processStats[name][key]])
      .filter((x) => Number.isFinite(x[1]));
    const roots = stableSamples
      .map((x) => [x.counts.threads, x.processStats[name][key]])
      .filter((x) => Number.isFinite(x[1]));
    const a = values(key);
    return {
      ...stats(a),
      theilSenPerHour: slope(points),
      theilSenPerAdditionalRoot: slope(roots),
      first10Median: a.length >= 20 ? quantile(a.slice(0, 10), 0.5) : null,
      last10Median: a.length >= 20 ? quantile(a.slice(-10), 0.5) : null,
      medianDelta:
        a.length >= 20
          ? quantile(a.slice(-10), 0.5) - quantile(a.slice(0, 10), 0.5)
          : null,
    };
  };
  const windows = [];
  for (let i = 0; i + 10 <= stableSamples.length; i += 10) {
    const a = stableSamples.slice(i, i + 10);
    windows.push({
      firstCycle: a[0].cycle,
      lastCycle: a.at(-1).cycle,
      elapsedMs: a.at(-1).elapsedMs,
      rssMinimumKiB: Math.min(...a.map((x) => x.processStats[name].rssKiB)),
      ...(name === "harness"
        ? {
            heapUsedMinimum: Math.min(
              ...a.map((x) => x.harnessMemory.heapUsed),
            ),
            heapUsedMedian: quantile(
              a.map((x) => x.harnessMemory.heapUsed),
              0.5,
            ),
            externalMinimum: Math.min(
              ...a.map((x) => x.harnessMemory.external),
            ),
            arrayBuffersMinimum: Math.min(
              ...a.map((x) => x.harnessMemory.arrayBuffers),
            ),
          }
        : {}),
    });
  }
  return {
    pid: samples[0]?.processStats[name]?.pid,
    samples: samples.length,
    observedSpanMs: samples.length
      ? samples.at(-1).elapsedMs - samples[0].elapsedMs
      : 0,
    firstCycle: samples[0]?.cycle,
    lastCycle: samples.at(-1)?.cycle,
    excludedWarmupSamples: Math.min(warmup, samples.length),
    stableSamples: stableSamples.length,
    sufficientForEarlyLateComparison: stableSamples.length >= 20,
    rssKiB: metric("rssKiB"),
    fdCount: metric("fdCount"),
    tenSampleWindows: windows,
    rssLowEnvelopeKiBPerHour: slope(
      windows.map((w) => [w.elapsedMs / 3_600_000, w.rssMinimumKiB]),
    ),
    heapLowEnvelopeBytesPerHour:
      name === "harness"
        ? slope(
            windows.map((w) => [w.elapsedMs / 3_600_000, w.heapUsedMinimum]),
          )
        : null,
  };
}
export function resourceAnalysis(resources, trace, ledger) {
  const starts = trace.filter((x) => x.event === "runtime-started"),
    epochs = new Map();
  for (const sample of resources) {
    const startIndex = starts.findLastIndex(
      (x) => x.elapsedMs <= sample.elapsedMs,
    );
    const key = `${startIndex}:${sample.processStats.runtime?.pid}`;
    if (!epochs.has(key)) epochs.set(key, []);
    epochs.get(key).push(sample);
  }
  const runtimeEpochs = [...epochs.values()]
    .filter((a) => a[0]?.processStats.runtime)
    .map((a) => processSummary(a, "runtime"));
  const postWork = resources.filter((x) => x.cycle > 0);
  const harness = postWork.length ? processSummary(postWork, "harness") : null;
  const last = resources.at(-1);
  const tagged = traceCycles(trace),
    traffic = new Map();
  for (const item of tagged.filter((x) => x.event === "provider-request")) {
    if (!traffic.has(item.cycle)) traffic.set(item.cycle, []);
    traffic.get(item.cycle).push(item.value.byteLength);
  }
  return {
    status: "REQUIRES_INTERPRETATION",
    leakFreeClaim: false,
    runtimeEpochs,
    harness,
    longestObservedRuntimeSpanMs: Math.max(
      0,
      ...runtimeEpochs.map((x) => x.observedSpanMs),
    ),
    database: {
      firstBytes: resources[0]?.databaseBytes,
      lastBytes: last?.databaseBytes,
      finalFiles: last?.files,
      pageMetrics: ledger?.pageMetrics,
      eventPayloadBytesByType: ledger?.eventBytes,
      contextNodesByDomain: ledger?.contextDomains,
      contextNodeTemporalEvidence:
        "Final/snapshot node count only; resources do not sample live Context nodes over time.",
      bytesPerAdditionalRoot: slope(
        resources.map((x) => [x.counts.threads, x.databaseBytes]),
      ),
      bytesPerHour: slope(
        resources.map((x) => [x.elapsedMs / 3_600_000, x.databaseBytes]),
      ),
      retainedRowCounts: last?.counts,
      retainedHistoryInterpretation:
        "Thread/outcome/Job/plan/schedule history must match the workload formula; Event bytes are reported by type, not excused solely because the total is under budget.",
      rowDeltas: resources.slice(1).map((x, i) => ({
        cycle: x.cycle,
        databaseBytesDelta: x.databaseBytes - resources[i].databaseBytes,
        rootsDelta: x.counts.threads - resources[i].counts.threads,
        eventsDelta: x.counts.events - resources[i].counts.events,
      })),
    },
    providerTrafficByCycle: [...traffic].map(([cycle, bytes]) => ({
      cycle,
      requests: bytes.length,
      totalRequestBytes: bytes.reduce((sum, n) => sum + n, 0),
      byteLength: stats(bytes),
    })),
    expectedRetainedBookkeeping: {
      roots: last?.counts.threads,
      commands: ledger?.deliveries?.length,
      expectedTerminals: last?.counts.thread_outcomes,
      retainedHeapMeasured: false,
      boundedTransientState:
        "gate array drained; last provider request only; log tail 32KB; retirement batch <=100",
    },
    limits: [
      "Every 60 cycles Runtime restarts: this is not one PID alive for the entire run.",
      "Host reopens every 15 cycles; harness process remains continuous.",
      "Post-work samples do not measure peaks or a controlled idle/forced-GC baseline.",
      "RSS is confounded by GC, allocators, resident/compressed pages and other processes.",
      "Historical rows, immutable receipts and timer tombstones are not disposable live work.",
      "Bookkeeping is expected to grow, but its retained heap is not profiled; it cannot excuse arbitrary growth.",
      "Short/last cold epochs may lack 20 stable samples; positive trends require interpretation, not automatic leak attribution.",
    ],
  };
}
function parseReply(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replaceAll('\\"', '"'));
    } catch {
      return null;
    }
  }
}

/** Pure checks accept snapshots for negative-control unit tests; production IO is below. */
export function auditData(data) {
  const {
    manifest,
    result,
    trace = [],
    resources = [],
    ledger = {},
    hashes = {},
    cleanup = {},
  } = data;
  const failures = [...(data.ioErrors ?? [])],
    warnings = [...(data.warnings ?? [])];
  const check = (condition, code, detail = null) => {
    if (!condition) failures.push({ code, detail });
  };
  if (!manifest)
    return {
      status: "FAILED",
      mechanicalPass: false,
      failures: [...failures, { code: "manifest-missing" }],
      warnings,
    };
  const complete = !!result,
    tagged = traceCycles(trace),
    verified = tagged.filter((x) => x.event === "cycle-verified");
  const cycles = result?.cycles ?? verified.at(-1)?.value?.cycle ?? 0;
  const coverage = result?.coverage ?? verified.at(-1)?.value?.coverage ?? {};
  const formula = countFormula(cycles, coverage);
  check(manifest.format === "morphz-reliability-soak/v1", "manifest-format");
  check(
    Number.isSafeInteger(manifest.durationMs) &&
      manifest.durationMs > 0 &&
      Number.isSafeInteger(manifest.intervalMs) &&
      manifest.intervalMs > 0,
    "manifest-duration",
  );
  check(
    /^[a-f0-9]{40}$/.test(manifest.head ?? "") &&
      manifest.binary?.requiredHead === manifest.head &&
      manifest.binary?.version?.includes(`git ${manifest.head.slice(0, 12)}`),
    "frozen-version-head",
  );
  for (const [actual, expected, code] of [
    [hashes.binary, manifest.binary?.sha256, "frozen-binary-hash"],
    [hashes.harness, manifest.harnessSha256, "harness-source-hash"],
    [hashes.oracle, manifest.oracleSha256, "oracle-source-hash"],
  ])
    check(/^[a-f0-9]{64}$/.test(expected ?? "") && actual === expected, code);
  check(
    stable(sorted(manifest.requestedScenarios ?? [])) ===
      stable(sorted(scenarios)),
    "scenario-manifest",
  );
  check(
    stable(manifest.cadence) ===
      stable({
        workloadEveryCycle: scenarios.slice(0, 5),
        providerFaultEveryCycles: 5,
        hostReopenEveryCycles: 15,
        runtimeCrashEveryCycles: 60,
        firstCycleCoversAll: true,
      }),
    "cadence-manifest",
  );
  for (let i = 0; i < trace.length; i++)
    check(
      Number.isFinite(trace[i].elapsedMs) &&
        (i === 0 || trace[i].elapsedMs >= trace[i - 1].elapsedMs),
      "trace-time-order",
      i,
    );
  check(
    !trace.some((x) =>
      [
        "failure",
        "proxy-fault",
        "provider-fixture-error",
        "resource-capability-unavailable",
        "harness-signal",
        "cleanup-unconfirmed",
      ].includes(x.event),
    ),
    "trace-failure",
  );
  const finished = trace.filter((x) => x.event === "run-finished");
  if (complete) {
    check(
      result.format === "morphz-reliability-soak-result/v1" &&
        result.outcome === "passed" &&
        result.failure === null,
      "result-outcome",
    );
    check(
      Array.isArray(result.cleanupFailures) &&
        result.cleanupFailures.length === 0,
      "cleanup-result",
    );
    check(
      cleanup.confirmed === true &&
        cleanup.livePids?.length === 0 &&
        cleanup.proxyDirectoryExists === false,
      "cleanup-independent",
      cleanup,
    );
    check(
      finished.length === 1 && stable(finished[0]?.value) === stable(result),
      "finished-result-consistency",
    );
    check(
      result.startedAt === manifest.startedAt &&
        result.requestedDurationMs === manifest.durationMs &&
        result.elapsedMs >= manifest.durationMs,
      "completed-duration",
    );
    check(
      Date.parse(result.finishedAt) - Date.parse(manifest.startedAt) >=
        manifest.durationMs - 1000,
      "wall-duration",
    );
    check(
      result.originalAppTouched === false && result.paidModelCalls === 0,
      "scope-result",
    );
    check(
      Number.isSafeInteger(cycles) && cycles > 0 && verified.length === cycles,
      "cycle-count",
    );
    check(
      result.maximumVerifiedGapMs <= result.allowedVerifiedGapMs &&
        result.allowedVerifiedGapMs ===
          Math.max(manifest.intervalMs * 3, 180_000),
      "continuity-result",
    );
    const starts = tagged.filter((x) => x.event === "cycle-start");
    check(starts.length === cycles, "cycle-start-count");
    for (let c = 1; c <= cycles; c++) {
      const start = starts.filter((x) => x.value.cycle === c),
        done = verified.filter((x) => x.value.cycle === c);
      check(
        start.length === 1 &&
          done.length === 1 &&
          start[0]?.elapsedMs <= done[0]?.elapsedMs,
        "cycle-boundary",
        c,
      );
      if (c > 1)
        check(
          start[0]?.elapsedMs - starts[c - 2]?.elapsedMs >=
            manifest.intervalMs - 50,
          "cycle-cadence-time",
          c,
        );
      for (const [name, expected] of Object.entries(expectedCadence(c)))
        check(
          tagged.filter(
            (x) =>
              x.cycle === c &&
              x.event === "scenario-verified" &&
              x.value.scenario === name,
          ).length === Number(expected),
          "scenario-cadence",
          { cycle: c, scenario: name },
        );
      const sample = resources.filter(
        (x) =>
          x.cycle === c &&
          x.elapsedMs >= start[0]?.elapsedMs &&
          x.elapsedMs <= done[0]?.elapsedMs,
      );
      check(sample.length === 1, "cycle-resource-sample", c);
    }
    for (const name of scenarios) {
      const events = tagged.filter(
        (x) => x.event === "scenario-verified" && x.value.scenario === name,
      );
      check(
        events.length === coverage[name] &&
          events.every((x, i) => x.value.occurrence === i + 1),
        "coverage-count",
        name,
      );
    }
    check(
      stable(verified.at(-1)?.value.coverage) === stable(coverage),
      "coverage-result",
    );
    for (const [event, n] of [
      ["injected-provider-socket-disconnect", coverage["provider-disconnect"]],
      ["actual-committed-host-response-held", coverage["host-reopen"]],
      ["original-host-response-released", coverage["host-reopen"]],
      ["injected-runtime-crash", coverage["runtime-crash-recovery"]],
      ["runtime-started", coverage["runtime-crash-recovery"] + 1],
      ["host-opened", coverage["host-reopen"] + 1],
    ])
      check(
        trace.filter((x) => x.event === event).length === n,
        "actual-fault-count",
        event,
      );
    check(
      new Set(resources.map((x) => x.processStats?.harness?.pid)).size === 1,
      "harness-pid-continuity",
    );
  } else
    warnings.push(
      "Run has no final result: all global terminal/cleanup checks remain deferred; never PASS.",
    );

  const finalResource = resources.at(-1);
  const runtimeStarts = trace.filter((x) => x.event === "runtime-started");
  check(resources.length > 0, "resources-missing");
  for (let i = 0; i < resources.length; i++) {
    const sample = resources[i];
    const epochStart = runtimeStarts.findLast(
      (x) => x.elapsedMs <= sample.elapsedMs,
    );
    check(
      epochStart?.value?.pid === sample.processStats?.runtime?.pid,
      "runtime-epoch-pid",
      i,
    );
    for (const name of ["harness", "runtime"]) {
      const p = sample.processStats?.[name];
      check(Number.isSafeInteger(p?.pid) && p.pid > 0, "process-sample-pid", {
        sample: i,
        process: name,
      });
      check(
        Number.isSafeInteger(p?.fdCount) && p.fdCount >= 0,
        "fd-sample-missing",
        { sample: i, process: name },
      );
      check(
        Number.isFinite(p?.rssKiB) &&
          p.rssKiB >= 0 &&
          p.rssKiB < 2_097_152 &&
          p.fdCount < 512,
        "process-resource-budget",
        { sample: i, process: name },
      );
    }
    check(
      Number.isFinite(sample.databaseBytes) &&
        sample.databaseBytes < 1_073_741_824,
      "database-budget",
      i,
    );
    const coverageAtSample = verified.find(
      (x) => x.value.cycle === sample.cycle,
    )?.value.coverage;
    if (sample.cycle === 0 || coverageAtSample) {
      const expected = countFormula(sample.cycle, coverageAtSample ?? {});
      for (const [table, n] of Object.entries({
        threads: expected.roots,
        thread_outcomes: expected.roots,
        execution_jobs: expected.jobs,
        plan_executions: expected.plans,
        schedules: expected.schedules,
      }))
        check(sample.counts?.[table] === n, "sample-history-count-formula", {
          sample: i,
          table,
          expected: n,
          actual: sample.counts?.[table],
        });
      check(
        sample.providerCalls === expected.providerCalls,
        "sample-provider-count-formula",
        i,
      );
    }
    if (i) {
      const gap = Date.parse(sample.at) - Date.parse(resources[i - 1].at);
      check(
        gap >= -1000 &&
          gap <= Math.max(manifest.intervalMs * 3, 180_000) + 1000,
        "observed-continuity-gap",
        gap,
      );
      check(
        sample.elapsedMs >= resources[i - 1].elapsedMs,
        "resource-time-order",
        i,
      );
    }
  }
  if (complete) {
    check(
      resources.length === cycles + 2 &&
        resources[0]?.cycle === 0 &&
        finalResource?.cycle === cycles &&
        finalResource?.elapsedMs >= manifest.durationMs,
      "final-resource-completeness",
    );
    const traceSamples = trace.filter((x) => x.event === "resource-sample");
    check(
      traceSamples.length === resources.length &&
        traceSamples.every(
          (x, i) =>
            x.value.providerCalls === resources[i].providerCalls &&
            stable(x.value.counts) === stable(resources[i].counts),
        ),
      "resource-trace-consistency",
    );
    check(
      result.finishedAt &&
        Date.parse(result.finishedAt) - Date.parse(finalResource?.at) <=
          result.allowedVerifiedGapMs + 1000,
      "final-tail-gap",
    );
    check(
      result.providerCalls === formula.providerCalls &&
        result.verifiedRoots === formula.roots,
      "result-count-formula",
      formula,
    );
    const requests = trace.filter((x) => x.event === "provider-request");
    check(
      requests.length === formula.providerCalls &&
        requests.every((x, i) => x.value.sequence === i + 1),
      "provider-request-count",
    );
    const inputs = trace.filter((x) => x.event === "host-input-accepted");
    check(
      inputs.length === formula.inputs &&
        equalSet(
          inputs.map((x) => x.value.receipt.entityId),
          inputs.map((x) => x.value.command.commandId),
        ),
      "input-receipt-set",
    );
    const terminals = new Map();
    for (const item of trace.filter(
      (x) => x.event === "terminal-root-verified",
    )) {
      const t = item.value.evidence?.threads?.[0];
      check(
        item.value.evidence?.threads?.length === 1 &&
          t?.root_turn_id === item.value.root &&
          t?.status === "completed" &&
          item.value.evidence?.outcomes?.length === 1 &&
          item.value.evidence.liveActivations?.length === 0 &&
          item.value.evidence.pendingSignals?.length === 0,
        "trace-terminal-evidence",
        item.value.root,
      );
      check(
        !terminals.has(item.value.root) ||
          terminals.get(item.value.root) === t?.status,
        "terminal-changed",
        item.value.root,
      );
      terminals.set(item.value.root, t?.status);
    }
    check(
      terminals.size === formula.roots &&
        equalSet(
          [...terminals.keys()],
          (ledger.threads ?? []).map((x) => x.root_turn_id),
        ),
      "exact-root-set",
    );
    check(
      (ledger.outcomes ?? []).length === formula.roots &&
        equalSet(
          [...terminals.keys()],
          (ledger.outcomes ?? []).map((x) => x.root_turn_id),
        ),
      "exact-outcome-set",
    );
    for (const t of ledger.threads ?? []) {
      const outcomes = (ledger.outcomes ?? []).filter(
        (x) =>
          x.thread_id === t.id &&
          x.root_turn_id === t.root_turn_id &&
          x.thread_generation === t.generation,
      );
      check(
        t.status === "completed" &&
          outcomes.length === 1 &&
          outcomes[0]?.terminal_kind === t.status &&
          terminals.get(t.root_turn_id) === t.status,
        "terminal-generation-status",
        t.root_turn_id,
      );
    }
    check(
      stable(result.verifiedTerminalCounts) ===
        stable(
          Object.fromEntries(
            ["completed", "failed", "cancelled"].map((s) => [
              s,
              [...terminals.values()].filter((v) => v === s).length,
            ]),
          ),
        ),
      "terminal-counts-result",
    );
    for (const [name, live] of [
      ["signals", ["pending", "claimed"]],
      ["activations", ["queued", "running"]],
      ["plans", ["queued", "running", "waiting"]],
      ["timers", ["pending", "claimed"]],
    ])
      check(
        !(ledger[name] ?? []).some((x) => live.includes(x.status)),
        "live-" + name,
      );
    check(
      (ledger.plans ?? []).length === formula.plans &&
        (ledger.plans ?? []).every((x) => x.status === "succeeded"),
      "plan-count-status",
    );
    check(
      (ledger.schedules ?? []).length === formula.schedules &&
        (ledger.schedules ?? []).every(
          (x) =>
            ["dispatched", "completed"].includes(x.status) &&
            terminals.has(x.source_turn_id),
        ),
      "schedule-count-status",
    );
    const deliveries = ledger.deliveries ?? [];
    const inputIds = inputs.map((x) => x.value.receipt.entityId);
    check(
      deliveries.length === formula.inputs &&
        equalSet(
          deliveries.map((x) => x.inputId),
          inputIds,
        ) &&
        deliveries.every((x) => x.state === "completed"),
      "delivery-input-set-status",
    );
    check(
      equalSet(
        inputIds,
        (ledger.sessionRequests ?? []).map((x) => x.client_message_id),
      ),
      "durable-input-receipt-set",
    );
    for (const delivery of deliveries)
      check(
        (ledger.sessionRequests ?? []).some(
          (x) =>
            x.client_message_id === delivery.inputId &&
            x.session_id === delivery.sessionId,
        ),
        "delivery-durable-receipt",
        delivery.inputId,
      );
    for (const binding of trace.filter((x) => x.event === "root-bound"))
      check(
        deliveries.some(
          (x) =>
            x.inputId === binding.value.inputId &&
            x.rootId === binding.value.root,
        ),
        "delivery-exact-root-binding",
        binding.value.inputId,
      );
    const writes = tagged.filter(
      (x) =>
        x.event === "scenario-verified" &&
        ["host-tool-write", "host-reopen"].includes(x.value.scenario),
    );
    const expectedWrites = writes.map((x) => ({
      root: x.value.evidence.root,
      inputId: x.value.evidence.inputId ?? x.value.evidence.originalCommandId,
      jobId: x.value.evidence.jobs?.[0]?.id ?? x.value.evidence.physicalJobId,
      contentId:
        x.value.evidence.contentId ?? x.value.evidence.committedContentId,
      title: `${x.value.scenario === "host-reopen" ? "SOAK_HOST" : "SOAK_DOCUMENT"}_${x.cycle}`,
      bodySha256: x.value.evidence.bodySha256,
      catalogReceipt: x.value.evidence.provenance?.[0]?.commandId,
    }));
    check(
      expectedWrites.length === formula.jobs &&
        equalSet(
          expectedWrites.map((x) => x.jobId),
          (ledger.jobs ?? []).map((x) => x.id),
        ),
      "exact-job-set",
    );
    check(
      equalSet(
        expectedWrites.map((x) => x.contentId),
        (ledger.contents ?? []).map((x) => x.content_id),
      ),
      "exact-content-set",
    );
    check(
      (ledger.objects ?? []).length === formula.documents &&
        (ledger.versions ?? []).length === formula.documents &&
        (ledger.objectReceipts ?? []).length === formula.documents &&
        (ledger.provenance ?? []).length === formula.documents,
      "object-receipt-count",
    );
    const usedObjects = [],
      usedReceipts = [];
    for (const write of expectedWrites) {
      const jobs = (ledger.jobs ?? []).filter((x) => x.id === write.jobId),
        job = jobs[0];
      check(
        jobs.length === 1 &&
          job?.root_turn_id === write.root &&
          job?.status === "succeeded" &&
          job.result_type === "tool_output" &&
          job.result_thread_id === job.thread_id &&
          job.result_event_id,
        "job-result-link",
        write.jobId,
      );
      const request = job ? JSON.parse(job.request_json) : null,
        output = job ? JSON.parse(job.result_payload ?? "null") : null,
        reply = parseReply(output?.text);
      check(
        request?.action === "create-document" &&
          request.title === write.title &&
          request.markdown === `Exact persisted body ${write.title}`,
        "job-exact-request",
        write.jobId,
      );
      check(
        output?.tool_status === "success" &&
          output.root_turn_id === write.root &&
          output.execution_job_id === write.jobId &&
          reply?.ok === true &&
          reply.contentId === write.contentId &&
          reply.versionRef === "1",
        "job-physical-receipt",
        write.jobId,
      );
      const provenance = (ledger.provenance ?? []).filter(
        (x) => x.content_id === write.contentId,
      );
      const p = provenance[0];
      check(
        provenance.length === 1 &&
          p?.runtime_input_id === write.inputId &&
          p?.title === write.title &&
          p.project_id === "soak-project" &&
          p.observed_version_ref === "1" &&
          (!write.catalogReceipt || p.command_id === write.catalogReceipt) &&
          p.event_kind === "content.recorded",
        "content-exact-provenance",
        write.contentId,
      );
      const versions = (ledger.versions ?? []).filter(
          (x) => x.object_id === p?.app_object_id,
        ),
        version = versions[0];
      const receipts = (ledger.objectReceipts ?? []).filter(
          (x) => x.command_id === reply?.receipt,
        ),
        receipt = receipts[0];
      const objects = (ledger.objects ?? []).filter(
        (x) => x.object_id === p?.app_object_id,
      );
      const payload = version ? JSON.parse(version.payload_body) : null;
      check(
        versions.length === 1 &&
          objects.length === 1 &&
          objects[0].head_revision === 1 &&
          version?.revision === 1 &&
          version.title === write.title &&
          payload?.markdown === request?.markdown &&
          version.payload_sha256 === digest(version.payload_body) &&
          (!write.bodySha256 || digest(payload.markdown) === write.bodySha256),
        "original-exact-content-version",
        write.contentId,
      );
      check(
        receipts.length === 1 &&
          receipt?.object_id === p?.app_object_id &&
          receipt.revision === 1 &&
          receipt.operation === "create-document",
        "original-command-receipt",
        write.jobId,
      );
      usedObjects.push(p?.app_object_id);
      usedReceipts.push(reply?.receipt);
    }
    check(
      equalSet(
        usedObjects,
        (ledger.objects ?? []).map((x) => x.object_id),
      ) &&
        equalSet(
          usedReceipts,
          (ledger.objectReceipts ?? []).map((x) => x.command_id),
        ),
      "exact-original-receipt-set",
    );
    check(
      (ledger.undeliveredObjectEvents ?? []).length === 0 &&
        (ledger.pendingTaskEvents ?? []).length === 0,
      "pending-business-outbox",
    );
    const expectedCounts = {
      threads: formula.roots,
      thread_outcomes: formula.roots,
      execution_jobs: formula.jobs,
      plan_executions: formula.plans,
      schedules: formula.schedules,
    };
    for (const [table, n] of Object.entries(expectedCounts))
      check(
        finalResource?.counts?.[table] === n,
        "final-resource-count-formula",
        table,
      );
    check(
      (ledger.integrity ?? []).length >= 4 &&
        (ledger.integrity ?? []).every(
          (x) =>
            stable(x.quickCheck) === stable(["ok"]) &&
            x.foreignKeyErrors.length === 0,
        ),
      "sqlite-integrity",
    );
    check(
      equalSet(
        (ledger.integrity ?? []).map((x) => x.relativePath),
        (finalResource?.files ?? [])
          .filter((x) => x.path.endsWith(".sqlite"))
          .map((x) => x.path),
      ),
      "sqlite-integrity-file-set",
    );
  }
  const status = failures.length ? "FAILED" : !complete ? "INCOMPLETE" : "PASS";
  return {
    format: "morphz-reliability-soak-independent-audit/v1",
    status,
    mechanicalPass: status === "PASS",
    requestedDurationMs: manifest.durationMs,
    cycles,
    coverage,
    expectedCounts: formula,
    frozenEvidence: {
      head: manifest.head,
      binaryVersion: manifest.binary?.version,
      actualHashes: hashes,
      expectedHashes: {
        binary: manifest.binary?.sha256,
        harness: manifest.harnessSha256,
        oracle: manifest.oracleSha256,
      },
    },
    failures,
    warnings,
    resources: resourceAnalysis(resources, trace, ledger),
    statement:
      "Mechanical PASS is ledger/cadence/integrity/cleanup acceptance only. Resource trends require interpretation; no leak-free claim.",
    boundaries: [
      "Only isolated SQLite and scripted provider; not paid/live cognition, PostgreSQL or the original App.",
      "Evidence is cross-checked independently, not cryptographically authenticated against a malicious producer.",
      "No-result snapshots may span in-flight commits across databases; no global terminal assertion is made then.",
      "Whole-run proof of unchanged production imports is limited to the manifest harness/oracle/binary hashes, not every JS import.",
    ],
  };
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function readLines(path, complete, warnings) {
  const text = readFileSync(path, "utf8"),
    lines = text.trimEnd().split("\n"),
    values = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      values.push(JSON.parse(lines[i]));
    } catch (error) {
      if (!complete && i === lines.length - 1 && !text.endsWith("\n"))
        warnings.push(
          `In-flight partial final JSONL line in ${basename(path)} ignored.`,
        );
      else throw error;
    }
  }
  return values;
}
function readDatabase(path, read, integrity) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON;PRAGMA busy_timeout=1000;BEGIN");
    const all = (sql) =>
      db
        .prepare(sql)
        .all()
        .map((x) => ({ ...x }));
    const result = read(all);
    result.pageMetrics = {
      path,
      pageCount: all("PRAGMA page_count")[0].page_count,
      pageSize: all("PRAGMA page_size")[0].page_size,
      freelistCount: all("PRAGMA freelist_count")[0].freelist_count,
    };
    if (integrity)
      result.integrity = {
        path,
        quickCheck: all("PRAGMA quick_check").map((x) => x.quick_check),
        foreignKeyErrors: all("PRAGMA foreign_key_check"),
      };
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
function sqliteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sqliteFiles(join(directory, entry.name))
      : entry.isFile() && entry.name.endsWith(".sqlite")
        ? [join(directory, entry.name)]
        : [],
  );
}
export async function readEvidence(directory) {
  directory = realpathSync(resolve(directory));
  const warnings = [],
    manifest = JSON.parse(
      readFileSync(join(directory, "manifest.json"), "utf8"),
    );
  const resultPath = join(directory, "result.json"),
    result = existsSync(resultPath)
      ? JSON.parse(readFileSync(resultPath, "utf8"))
      : null;
  const trace = readLines(join(directory, "trace.jsonl"), !!result, warnings),
    resources = readLines(
      join(directory, "resources.jsonl"),
      !!result,
      warnings,
    );
  const frozen = realpathSync(manifest.binary.frozenPath);
  if (frozen !== join(directory, "morphz-frozen"))
    throw new Error(
      "Frozen binary must be the owned morphz-frozen file, not a user-supplied external path",
    );
  const source = dirname(fileURLToPath(import.meta.url));
  const hashes = {
    binary: await fileHash(frozen),
    harness: await fileHash(join(source, "reliability-soak.ts")),
    oracle: await fileHash(join(source, "reliability-soak-model.ts")),
  };
  const ledger = { integrity: [], pageMetrics: [] },
    paths = [
      join(directory, "runtime/runtime.sqlite"),
      join(directory, "application/platform.sqlite"),
      join(directory, "application/workspace.sqlite"),
      join(directory, "application/objects.sqlite"),
    ];
  const readers = [
    (all) => ({
      threads: all("SELECT id,root_turn_id,generation,status FROM threads"),
      outcomes: all(
        "SELECT thread_id,root_turn_id,thread_generation,terminal_kind FROM thread_outcomes",
      ),
      signals: all("SELECT id,thread_id,status FROM thread_signals"),
      sessionRequests: all(
        "SELECT session_id,client_message_id,event_id FROM session_message_requests",
      ),
      activations: all("SELECT id,root_turn_id,status FROM thread_activations"),
      plans: all("SELECT id,thread_id,status FROM plan_executions"),
      schedules: all(
        "SELECT id,source_turn_id,thread_id,status FROM schedules",
      ),
      timers: all("SELECT id,kind,owner_id,status FROM runtime_timers"),
      jobs: all(
        "SELECT j.id,j.activation_id,j.thread_id,j.tool_call_id,j.status,j.result_event_id,j.request_json,t.root_turn_id,e.type result_type,e.thread_id result_thread_id,e.payload result_payload FROM execution_jobs j LEFT JOIN threads t ON t.id=j.thread_id LEFT JOIN events e ON e.id=j.result_event_id",
      ),
      eventBytes: all(
        "SELECT type,COUNT(*) rows,SUM(length(CAST(payload AS BLOB))) bytes,MAX(length(CAST(payload AS BLOB))) maximumBytes FROM events GROUP BY type",
      ),
      contextDomains: all(
        "SELECT owner_domain,COUNT(*) rows,SUM(length(CAST(body_sexpr AS BLOB))) bytes FROM experimental_contextdb_nodes GROUP BY owner_domain",
      ),
    }),
    (all) => ({
      contents: all(
        "SELECT content_id,app_object_id,title,observed_version_ref,project_id FROM content_entries",
      ),
      provenance: all(
        "SELECT r.command_id,r.runtime_input_id,r.result_ref,c.content_id,c.app_object_id,c.title,c.project_id,c.observed_version_ref,o.event_kind FROM command_receipts r JOIN outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.aggregate_kind='content' AND o.aggregate_id=r.result_ref JOIN content_entries c ON c.tenant_id=r.tenant_id AND c.content_id=r.result_ref WHERE r.operation='record-content'",
      ),
      pendingTaskEvents: all(
        "SELECT event_id,event_kind FROM outbox WHERE aggregate_kind='task' AND delivered_at IS NULL AND event_kind IN ('task.run_requested','task.run_prepared','task.run_stop_requested','task.source_changed')",
      ),
    }),
    (all) => ({
      deliveries: all("SELECT state,body FROM runtime_deliveries").map((x) => ({
        ...JSON.parse(x.body),
        state: x.state,
      })),
    }),
    (all) => ({
      objects: all("SELECT object_id,head_revision FROM objects"),
      versions: all(
        "SELECT object_id,revision,title,payload_body,payload_sha256 FROM object_versions",
      ),
      objectReceipts: all(
        "SELECT command_id,object_id,revision,operation FROM object_command_receipts",
      ),
      undeliveredObjectEvents: all(
        "SELECT event_id FROM object_outbox WHERE delivered_at IS NULL",
      ),
    }),
  ];
  for (let i = 0; i < paths.length; i++) {
    const part = readDatabase(paths[i], readers[i], !!result),
      { integrity, pageMetrics, ...rows } = part;
    Object.assign(ledger, rows);
    ledger.pageMetrics.push(pageMetrics);
    if (integrity)
      ledger.integrity.push({
        ...integrity,
        relativePath: paths[i].slice(directory.length + 1),
      });
  }
  if (result)
    for (const path of [
      ...sqliteFiles(join(directory, "runtime")),
      ...sqliteFiles(join(directory, "application")),
    ].filter((x) => !paths.includes(x))) {
      const part = readDatabase(path, () => ({}), true);
      ledger.integrity.push({
        ...part.integrity,
        relativePath: path.slice(directory.length + 1),
      });
      ledger.pageMetrics.push(part.pageMetrics);
    }
  const cleanup = {
    confirmed: false,
    livePids: [],
    proxyDirectoryExists: null,
  };
  if (result) {
    const pids = new Set([
      ...trace
        .filter((x) => x.event === "runtime-started")
        .map((x) => x.value.pid),
      ...resources.map((x) => x.processStats.harness.pid),
    ]);
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Invalid owned PID");
      try {
        process.kill(pid, 0);
        cleanup.livePids.push(pid);
      } catch (error) {
        if (error.code !== "ESRCH") cleanup.livePids.push(pid);
      }
    }
    const proxy = manifest.fixtureUnixRelayDirectory;
    if (
      typeof proxy !== "string" ||
      !basename(proxy).startsWith("morphz-soak-proxy-") ||
      proxy.includes(`..${sep}`)
    )
      throw new Error("Invalid owned relay path");
    cleanup.proxyDirectoryExists = existsSync(proxy);
    cleanup.confirmed =
      cleanup.livePids.length === 0 && !cleanup.proxyDirectoryExists;
  }
  return {
    manifest,
    result,
    trace,
    resources,
    ledger,
    hashes,
    cleanup,
    warnings,
    directory,
  };
}
export async function auditEvidenceDirectory(directory) {
  try {
    return {
      ...auditData(await readEvidence(directory)),
      evidenceDirectory: resolve(directory),
      auditedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      format: "morphz-reliability-soak-independent-audit/v1",
      status: "FAILED",
      mechanicalPass: false,
      evidenceDirectory: resolve(directory),
      failures: [{ code: "audit-read-failed", detail: error.message }],
      resources: { status: "NOT_EVALUATED", leakFreeClaim: false },
    };
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3) {
    console.error(
      "Usage: node reliability-soak-audit.mjs /absolute/evidence/directory",
    );
    process.exitCode = 1;
  } else {
    const report = await auditEvidenceDirectory(process.argv[2]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode =
      report.status === "PASS" ? 0 : report.status === "INCOMPLETE" ? 2 : 1;
  }
}
