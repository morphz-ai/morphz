import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read-only diagnostics for disposable CI workers. Never inspect process
// arguments, environments, application data or credentials, and never signal
// another process. Unknown/unavailable counters stay null rather than zero.
export function parseCounters(text) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = /^([a-zA-Z_]+):?\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
        const value = match ? Number(match[2]) : NaN;
        return match && Number.isSafeInteger(value) ? [[match[1], value]] : [];
      }),
  );
}

export function unifiedCgroupPath(text) {
  const record = text.split("\n").find((line) => line.startsWith("0::"));
  if (!record) return null;
  const path = record.slice(3);
  if (
    !path.startsWith("/") ||
    path.split("/").includes("..") ||
    path.includes("\0")
  )
    return null;
  return `/sys/fs/cgroup${path === "/" ? "" : path}`;
}

function optional(read, path) {
  try {
    return read(path, "utf8");
  } catch {
    return null;
  }
}

function scalar(text) {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "max") return "max";
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export function linuxCounters(read = readFileSync) {
  const memory = optional(read, "/proc/meminfo");
  const membership = optional(read, "/proc/self/cgroup");
  const root = membership === null ? null : unifiedCgroupPath(membership);
  const counters = (name) => {
    const text = root === null ? null : optional(read, `${root}/${name}`);
    return text === null ? null : parseCounters(text);
  };
  const value = (name) =>
    root === null ? null : scalar(optional(read, `${root}/${name}`));
  const parsed = memory === null ? null : parseCounters(memory);
  return {
    memoryKiB:
      parsed === null
        ? null
        : Object.fromEntries(
            ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"].map((key) => [
              key,
              parsed[key] ?? null,
            ]),
          ),
    cgroup:
      root === null
        ? null
        : {
            path: root,
            memoryCurrentBytes: value("memory.current"),
            memoryPeakBytes: value("memory.peak"),
            memoryLimitBytes: value("memory.max"),
            memoryEvents: counters("memory.events"),
            pidsCurrent: value("pids.current"),
            pidsLimit: value("pids.max"),
            pidsEvents: counters("pids.events"),
          },
  };
}

// Aggregate resident memory by a fixed executable category, never by an
// argument, path, user-supplied process name or environment value.
export function linuxProcessMemory(read = readFileSync, list = readdirSync) {
  let entries;
  try {
    entries = list("/proc");
  } catch {
    return null;
  }
  const groups = new Map();
  let observed = 0;
  for (const id of entries.filter((name) => /^\d+$/.test(name))) {
    const status = optional(read, `/proc/${id}/status`);
    if (status === null) continue;
    const name = /^Name:\s*(\S+)/m.exec(status)?.[1];
    const kind = ["node", "tsc", "postgres", "chrome", "chromium"].includes(name)
      ? name
      : "other";
    const counters = parseCounters(status);
    const rss = counters.VmRSS;
    if (rss === undefined) continue;
    observed++;
    const group = groups.get(kind) ?? { processes: 0, residentKiB: 0, largestKiB: 0 };
    group.processes++;
    group.residentKiB += rss;
    group.largestKiB = Math.max(group.largestKiB, rss);
    groups.set(kind, group);
  }
  return { observed, groups: Object.fromEntries(groups) };
}

export function sample() {
  let filesystem = null,
    processCount = null;
  try {
    const stat = statfsSync(process.cwd());
    filesystem = {
      availableBytes: stat.bavail * stat.bsize,
      freeInodes: stat.ffree,
    };
  } catch {}
  if (process.platform === "linux") {
    try {
      processCount = readdirSync("/proc").filter((name) =>
        /^\d+$/.test(name),
      ).length;
    } catch {}
  }
  return {
    at: new Date().toISOString(),
    platform: process.platform,
    memoryBytes: { total: totalmem(), free: freemem() },
    load: loadavg(),
    filesystem,
    processCount,
    processMemory: process.platform === "linux" ? linuxProcessMemory() : null,
    linux: process.platform === "linux" ? linuxCounters() : null,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const interval = Number(process.argv[2] ?? 15000);
  if (!Number.isInteger(interval) || interval < 100 || interval > 60000) {
    throw new Error(
      "Resource sampling interval must be 100..60000 milliseconds",
    );
  }
  const emit = () => console.log(`[ci-resource] ${JSON.stringify(sample())}`);
  let timer,
    stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    emit();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  timer = setInterval(emit, interval);
  emit();
}
