import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Disposable CI diagnosis only. The ordinary test/application path never sets
// this opt-in directory. Do not log environments, arbitrary argv, source text,
// error objects or application data, including when a diagnostic write fails.
// Node's CLI test coordinator may not run user preloads. The external read-only
// process observer must also retain unregistered parent PIDs; a missing probe
// record never proves that a process did not exist or use memory.
export const PROBE_ENV = "MORPHZ_CI_NODE_PROBE_DIR";
export const SAMPLE_INTERVAL_MS = 1000;
export const MAX_SAMPLES = 64;
export const MAX_DOCUMENT_BYTES = 32 * 1024;
export const MAX_PROCESS_FILES = 4096;
const prefix = "morphz-node-probe-";
const manager = fileURLToPath(
  new URL("../application/scripts/run-tests.mjs", import.meta.url),
);

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function processIdentity({ argv1, execArgv = [], selectedFiles, cwd }) {
  const current = typeof argv1 === "string" ? resolve(cwd, argv1) : null;
  if (current === manager) return { role: "manager", testFile: null };
  if (execArgv.includes("--test"))
    return { role: "coordinator", testFile: null };
  const name = current === null ? null : basename(current);
  // This is the only argv-derived value permitted in a record. An arbitrary
  // argument, absolute path, or merely test-looking filename is never emitted.
  if (
    name !== null &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.test\.ts$/.test(name) &&
    typeof selectedFiles === "string" &&
    selectedFiles.length <= 1024 * 1024
  ) {
    let selection;
    try {
      selection = JSON.parse(selectedFiles);
    } catch {}
    if (
      Array.isArray(selection) &&
      selection.length <= 4096 &&
      selection.some(
        (file) =>
          typeof file === "string" &&
          file.length <= 4096 &&
          resolve(cwd, file) === current,
      )
    )
      return { role: "worker", testFile: name };
  }
  return { role: "node", testFile: null };
}

export function memorySnapshot(atMs, phase, memory) {
  return {
    atMs: counter(atMs),
    phase: phase === "preload" ? "preload" : "interval",
    heapUsedBytes: counter(memory.heapUsed),
    externalBytes: counter(memory.external),
    rssBytes: counter(memory.rss),
  };
}

export function appendSnapshot(record, snapshot) {
  return {
    ...record,
    samples: [...record.samples.slice(-(MAX_SAMPLES - 1)), snapshot],
  };
}

export function serializeRecord(record) {
  const text = JSON.stringify(record) + "\n";
  return Buffer.byteLength(text) <= MAX_DOCUMENT_BYTES ? text : null;
}

function privateDirectory(directory) {
  if (
    typeof directory !== "string" ||
    directory.length > 4096 ||
    !isAbsolute(directory)
  )
    return false;
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (
    typeof process.getuid === "function" &&
    (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
  )
    return false;
  return (
    readdirSync(directory).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".json"),
    ).length < MAX_PROCESS_FILES
  );
}

export function startProbe(directory) {
  let timer,
    file,
    temporary,
    record,
    stopped = false;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
  };
  const write = (phase) => {
    if (stopped) return;
    let createdTemporary = false;
    try {
      record = appendSnapshot(
        record,
        memorySnapshot(Date.now(), phase, process.memoryUsage()),
      );
      const text = serializeRecord(record);
      if (text === null) return stop();
      // A reader sees either the previous complete bounded document or the new
      // one. Exclusive creation and a private directory avoid following a
      // pre-existing link or overwriting an unrelated diagnostic file.
      const descriptor = openSync(temporary, "wx", 0o600);
      createdTemporary = true;
      try {
        writeFileSync(descriptor, text);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, file);
      createdTemporary = false;
    } catch {
      if (createdTemporary) {
        try {
          unlinkSync(temporary);
        } catch {}
      }
      stop();
    }
  };
  try {
    if (!privateDirectory(directory)) return null;
    const startedAtMs = Date.now();
    file = join(directory, `${prefix}${process.pid}-${startedAtMs}.json`);
    temporary = file + ".tmp";
    // Reserve only this process's new record; never truncate an existing file.
    closeSync(openSync(file, "wx", 0o600));
    record = {
      schema: 1,
      pid: process.pid,
      ppid: process.ppid,
      ...processIdentity({
        argv1: process.argv[1],
        execArgv: process.execArgv,
        selectedFiles: process.env.MORPHZ_TEST_SELECTED_FILES,
        cwd: process.cwd(),
      }),
      startedAtMs,
      samples: [],
    };
    // Preload runs before the test module. No reporter ordering is involved.
    write("preload");
    if (stopped) return null;
    timer = setInterval(() => write("interval"), SAMPLE_INTERVAL_MS);
    timer.unref();
    // No exit/beforeExit handler, asynchronous flush, or referenced timer can
    // delay a worker's exit. A killed worker leaves its last complete snapshot.
    return { file, stop };
  } catch {
    stop();
    return null;
  }
}

if (process.env[PROBE_ENV]) startProbe(process.env[PROBE_ENV]);
