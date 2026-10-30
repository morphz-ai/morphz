import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  linuxCounters,
  linuxProcessMemory,
  parseCounters,
  parseCpuMax,
  parsePressure,
  sample,
  unifiedCgroupPath,
} from "../observe-ci-resources.mjs";

test(
  "CI observer cleanup cannot replace the test command exit status",
  { timeout: 10000 },
  async () => {
    const observer = fileURLToPath(
      new URL("../observe-ci-resources.mjs", import.meta.url),
    );
    for (const expected of [0, 17]) {
      const command = `node ${JSON.stringify(observer)} &\nresource_observer=$!\ntrap 'kill "$resource_observer" 2>/dev/null || true; wait "$resource_observer" 2>/dev/null || true' EXIT\nnode -e 'setTimeout(() => process.exit(${expected}), 100)'`;
      const child = spawn("bash", ["-e", "-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (bytes) => {
        output += bytes;
      });
      const [code, signal] = await once(child, "close");
      assert.equal(code, expected);
      assert.equal(signal, null);
      assert.match(output, /\[ci-resource\]/);
    }
  },
);

test("only bounded numeric counters are parsed; missing values are not success or zero", () => {
  assert.deepEqual(
    parseCounters(
      "oom 2\noom_kill 1\nMemTotal: 123 kB\ninvalid max\nnegative -1\nlarge 999999999999999999999",
    ),
    {
      oom: 2,
      oom_kill: 1,
      MemTotal: 123,
    },
  );
  assert.deepEqual(
    linuxCounters(() => {
      throw new Error("unavailable");
    }),
    {
      memoryKiB: null,
      pressure: { cpu: null, io: null, memory: null },
      cgroup: null,
    },
  );
});

test("unified cgroup membership resolves the actual current group and rejects traversal", () => {
  assert.equal(unifiedCgroupPath("0::/"), "/sys/fs/cgroup");
  assert.equal(
    unifiedCgroupPath("1:cpu:/old\n0::/system.slice/job.scope\n"),
    "/sys/fs/cgroup/system.slice/job.scope",
  );
  for (const text of [
    "1:memory:/old",
    "0::relative",
    "0::/../../outside",
    "0::/bad\0path",
  ])
    assert.equal(unifiedCgroupPath(text), null);
});

test("resource snapshot retains actual OOM and PID events without guessing unsupported counters", () => {
  const files = new Map([
    [
      "/proc/meminfo",
      "MemTotal: 2048 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
    ],
    ["/proc/self/cgroup", "0::/test"],
    ["/sys/fs/cgroup/test/memory.current", "1024"],
    ["/sys/fs/cgroup/test/memory.max", "max"],
    ["/sys/fs/cgroup/test/memory.events", "oom 3\noom_kill 2"],
    ["/sys/fs/cgroup/test/pids.current", "17"],
    ["/sys/fs/cgroup/test/pids.max", "1024"],
    ["/sys/fs/cgroup/test/pids.events", "max 0"],
    ["/sys/fs/cgroup/test/cpu.max", "200000 100000"],
    [
      "/sys/fs/cgroup/test/cpu.stat",
      "usage_usec 12345\nnr_periods 50\nnr_throttled 7\nthrottled_usec 800",
    ],
    ["/proc/pressure/cpu", "some avg10=9.50 avg60=3.00 avg300=1.25 total=3000"],
  ]);
  const result = linuxCounters((path) => {
    if (!files.has(path)) throw new Error("missing");
    return files.get(path);
  });
  assert.deepEqual(result, {
    memoryKiB: { MemTotal: 2048, MemAvailable: 512, SwapTotal: 0, SwapFree: 0 },
    pressure: {
      cpu: { some: { avg10: 9.5, avg60: 3, avg300: 1.25, totalMicros: 3000 } },
      io: null,
      memory: null,
    },
    cgroup: {
      path: "/sys/fs/cgroup/test",
      memoryCurrentBytes: 1024,
      memoryPeakBytes: null,
      memoryLimitBytes: "max",
      memoryEvents: { oom: 3, oom_kill: 2 },
      pidsCurrent: 17,
      pidsLimit: 1024,
      pidsEvents: { max: 0 },
      cpuMax: { quotaMicros: 200000, periodMicros: 100000, quotaCores: 2 },
      cpuStat: {
        usage_usec: 12345,
        nr_periods: 50,
        nr_throttled: 7,
        throttled_usec: 800,
      },
    },
  });
});

test("real sampling is read-only and emits no process arguments or environment", () => {
  const value = sample();
  assert.equal(value.platform, process.platform);
  assert(value.memoryBytes.total > 0);
  assert.equal(value.load.length, 3);
  assert(
    Number.isSafeInteger(value.availableParallelism) &&
      value.availableParallelism > 0,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "at",
      "availableParallelism",
      "filesystem",
      "linux",
      "load",
      "memoryBytes",
      "platform",
      "processCount",
      "processMemory",
    ].sort(),
  );
});

test("CPU quota and pressure retain measured limits without inventing unsupported or unlimited values", () => {
  assert.deepEqual(parseCpuMax("200000 100000\n"), {
    quotaMicros: 200000,
    periodMicros: 100000,
    quotaCores: 2,
  });
  assert.deepEqual(parseCpuMax("max 100000"), {
    quotaMicros: "max",
    periodMicros: 100000,
    quotaCores: null,
  });
  for (const text of [
    null,
    "unavailable",
    "0 100000",
    "200000 0",
    "-1 100000",
    "999999999999999999999 100000",
  ])
    assert.equal(parseCpuMax(text), null);
  assert.deepEqual(
    parsePressure(
      "some avg10=9.50 avg60=3.00 avg300=1.25 total=3000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0",
    ),
    {
      some: { avg10: 9.5, avg60: 3, avg300: 1.25, totalMicros: 3000 },
      full: { avg10: 0, avg60: 0, avg300: 0, totalMicros: 0 },
    },
  );
  for (const text of [
    null,
    "private process arguments",
    "some avg10=NaN avg60=0 avg300=0 total=0",
  ])
    assert.equal(parsePressure(text), null);
});

test("process memory is aggregated without exposing process names or reading arguments", () => {
  const paths = [];
  const result = linuxProcessMemory(
    (path) => {
      paths.push(path);
      if (path === "/proc/1/status") return "Name:\ttsc\nVmRSS:\t100 kB\n";
      if (path === "/proc/2/status") return "Name:\ttsc\nVmRSS:\t200 kB\n";
      if (path === "/proc/3/status")
        return "Name:\tprivate-name\nVmRSS:\t40 kB\n";
      throw new Error("process exited");
    },
    () => ["self", "1", "2", "3", "4", "../bad"],
    () => {
      throw new Error("executable unavailable");
    },
  );
  assert.deepEqual(result, {
    observed: 3,
    groups: {
      tsc: { processes: 2, residentKiB: 300, largestKiB: 200 },
      other: { processes: 1, residentKiB: 40, largestKiB: 40 },
    },
  });
  assert.deepEqual(paths, [
    "/proc/1/status",
    "/proc/2/status",
    "/proc/3/status",
    "/proc/4/status",
  ]);
  assert.equal(
    linuxProcessMemory(
      () => "",
      () => {
        throw new Error("unavailable");
      },
    ),
    null,
  );
});

test(
  "the owned sampler stops promptly on TERM without signalling another process",
  { timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../observe-ci-resources.mjs", import.meta.url)),
        "100",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    let output = "",
      sentStop = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      output += text;
      if (!sentStop && output.includes("\n")) {
        sentStop = true;
        child.kill("SIGTERM");
      }
    });
    try {
      const [code, signal] = await closed;
      assert.equal(code, 0);
      assert.equal(signal, null);
      const lines = output.trim().split("\n");
      assert(lines.length >= 1 && lines.length <= 3);
      for (const line of lines)
        assert.equal(
          JSON.parse(line.slice("[ci-resource] ".length)).platform,
          process.platform,
        );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  },
);

test("renamed Node main threads are classified without exposing executable paths", () => {
  const result = linuxProcessMemory(
    () => "Name:\tMainThread\nVmRSS:\t120 kB\n",
    () => ["1"],
    () => "/private/test-only/path/node",
  );
  assert.deepEqual(result, {
    observed: 1,
    groups: { node: { processes: 1, residentKiB: 120, largestKiB: 120 } },
  });
  assert(!JSON.stringify(result).includes("private"));
});
