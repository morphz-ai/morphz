import {
  closeSync,
  constants,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { basename, join } from "node:path";

// Disposable CI diagnostics only. Read counters and the opt-in self-reports;
// never inspect another process's arguments, environment or application data.
function boundedRead(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(32769);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 32768) throw new Error("Diagnostic record exceeds its bound");
    return buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

export function sampleProbeProcesses(
  directory,
  { read = boundedRead, list = readdirSync, link = readlinkSync } = {},
) {
  const probes = new Map();
  for (const name of list(directory).slice(0, 4096)) {
    if (!/^morphz-node-probe-\d+-\d+\.json$/.test(name)) continue;
    try {
      const text = read(join(directory, name), "utf8");
      if (Buffer.byteLength(text) > 32768) continue;
      const probe = JSON.parse(text);
      if (
        probe.schema !== 1 ||
        !Number.isSafeInteger(probe.pid) ||
        probe.pid < 1 ||
        !Number.isSafeInteger(probe.startedAtMs) ||
        probe.startedAtMs < 1 ||
        name !== `morphz-node-probe-${probe.pid}-${probe.startedAtMs}.json`
      )
        continue;
      if ((probes.get(probe.pid)?.startedAtMs ?? 0) > probe.startedAtMs)
        continue;
      const latest = Array.isArray(probe.samples) ? probe.samples.at(-1) : null;
      const safeLatest = {};
      if (latest && typeof latest === "object") {
        for (const field of [
          "atMs",
          "heapUsedBytes",
          "externalBytes",
          "rssBytes",
        ])
          if (Number.isSafeInteger(latest[field]) && latest[field] >= 0)
            safeLatest[field] = latest[field];
        if (["preload", "interval"].includes(latest.phase))
          safeLatest.phase = latest.phase;
      }
      probes.set(probe.pid, {
        startedAtMs: probe.startedAtMs,
        ppid:
          Number.isSafeInteger(probe.ppid) && probe.ppid > 0
            ? probe.ppid
            : null,
        role: ["manager", "coordinator", "worker", "node"].includes(probe.role)
          ? probe.role
          : null,
        testFile:
          typeof probe.testFile === "string" &&
          /^[a-zA-Z0-9_.-]+\.test\.ts$/.test(probe.testFile)
            ? probe.testFile
            : null,
        latest: Object.keys(safeLatest).length ? safeLatest : null,
      });
    } catch {}
  }
  const processes = [];
  for (const name of list("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const executable = basename(
        link(`/proc/${name}/exe`).replace(/ \(deleted\)$/, ""),
      );
      if (!["node", "tsc"].includes(executable)) continue;
      const status = read(`/proc/${name}/status`, "utf8");
      const rssKiB = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1]);
      if (!Number.isSafeInteger(rssKiB)) continue;
      const pid = Number(name);
      const ppid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
      processes.push({
        pid,
        ppid: Number.isSafeInteger(ppid) && ppid > 0 ? ppid : null,
        kind: executable,
        rssKiB,
        probe: probes.get(pid) ?? null,
        parentOfTestFiles: [
          ...new Set(
            [...probes.values()]
              .filter((probe) => probe.ppid === pid && probe.testFile)
              .map((probe) => probe.testFile),
          ),
        ].slice(0, 8),
      });
    } catch {}
  }
  return processes.sort((a, b) => b.rssKiB - a.rssKiB).slice(0, 8);
}

if (process.argv[1]?.endsWith("/ci-node-probe-sampler.mjs")) {
  const directory = process.argv[2];
  if (!directory || process.platform !== "linux")
    throw new Error("An explicit diagnostic directory on Linux is required");
  let stopped = false;
  const emit = () => {
    try {
      console.log(
        JSON.stringify({
          atMs: Date.now(),
          processes: sampleProbeProcesses(directory),
        }),
      );
    } catch {
      console.log(JSON.stringify({ atMs: Date.now(), unavailable: true }));
    }
  };
  const timer = setInterval(emit, 1000);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    emit();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  emit();
}
