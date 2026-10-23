import test from "node:test";
import assert from "node:assert/strict";
import { sampleProbeProcesses } from "../ci-node-probe-sampler.mjs";
import { memorySnapshot } from "../ci-node-worker-probe.mjs";

function fixture(overrides = {}) {
  const reads = [];
  const probe = {
    schema: 1,
    pid: 42,
    ppid: 41,
    role: "worker",
    testFile: "subject-inspector-boundary.test.ts",
    startedAtMs: 123,
    samples: [{ atMs: 456, phase: "interval", heapUsedBytes: 10 }],
    ...overrides,
  };
  return {
    reads,
    read(path) {
      reads.push(path);
      if (path === "/probe/morphz-node-probe-42-123.json")
        return JSON.stringify(probe);
      if (path === "/proc/42/status") return "VmRSS:\t987 kB\nPPid:\t41\n";
      throw new Error("Unexpected diagnostic read");
    },
    list(path) {
      if (path === "/probe")
        return ["morphz-node-probe-42-123.json", "private-environment.txt"];
      if (path === "/proc") return ["42", "self"];
      throw new Error("Unexpected diagnostic directory");
    },
    link(path) {
      assert.equal(path, "/proc/42/exe");
      return "/path/not-emitted/node";
    },
  };
}

test("correlates numeric process RSS with a bounded worker self-report", () => {
  const fs = fixture();
  assert.deepEqual(sampleProbeProcesses("/probe", fs), [
    {
      pid: 42,
      ppid: 41,
      kind: "node",
      rssKiB: 987,
      probe: {
        startedAtMs: 123,
        ppid: 41,
        role: "worker",
        testFile: "subject-inspector-boundary.test.ts",
        latest: { atMs: 456, heapUsedBytes: 10, phase: "interval" },
      },
      parentOfTestFiles: [],
    },
  ]);
  assert.deepEqual(fs.reads, [
    "/probe/morphz-node-probe-42-123.json",
    "/proc/42/status",
  ]);
});

test("preserves the actual preload probe snapshot schema", () => {
  const snapshot = memorySnapshot(456, "interval", {
    heapUsed: 10,
    external: 20,
    rss: 30,
  });
  const result = sampleProbeProcesses(
    "/probe",
    fixture({ samples: [snapshot] }),
  );
  assert.deepEqual(result[0].probe.latest, snapshot);
});

test("does not emit arbitrary probe fields, paths, arguments or environment", () => {
  const fs = fixture({
    role: "SECRET",
    testFile: "/private/SECRET.test.ts",
    environment: "SECRET",
    samples: [{ atMs: 456, heapUsedBytes: "SECRET", arbitrary: "SECRET" }],
  });
  const result = sampleProbeProcesses("/probe", fs);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.deepEqual(result[0].probe, {
    startedAtMs: 123,
    ppid: 41,
    role: null,
    testFile: null,
    latest: { atMs: 456 },
  });
});

test("correlates an unregistered manager by observed worker parent identity", () => {
  const fs = fixture();
  const list = fs.list;
  const read = fs.read;
  fs.list = (path) => (path === "/proc" ? ["41", "42"] : list(path));
  fs.read = (path) =>
    path === "/proc/41/status" ? "VmRSS:\t9999 kB\nPPid:\t40\n" : read(path);
  fs.link = () => "/public/node";
  const manager = sampleProbeProcesses("/probe", fs)[0];
  assert.equal(manager.pid, 41);
  assert.equal(manager.probe, null);
  assert.deepEqual(manager.parentOfTestFiles, [
    "subject-inspector-boundary.test.ts",
  ]);
});

test("rejects mismatched identities and oversized self-reports", () => {
  assert.equal(
    sampleProbeProcesses("/probe", fixture({ pid: 43 }))[0].probe,
    null,
  );
  const fs = fixture();
  const read = fs.read;
  fs.read = (path) =>
    path.startsWith("/probe/") ? " ".repeat(32769) : read(path);
  assert.equal(sampleProbeProcesses("/probe", fs)[0].probe, null);
});
