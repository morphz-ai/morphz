#!/usr/bin/env node
// Explicit, two-phase recovery of old Morphz test WAL files. Never visits a
// production database or recursively removes a directory. Future tests own a
// private temporary directory instead; this only addresses pre-existing leaks.
import {
  closeSync, constants, lstatSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WAL_NAME = /^\.tmp[A-Za-z0-9]+-wal$/;
const MARKERS = [
  "CREATE TABLE cognitive_contexts",
  "CREATE TABLE thread_activations",
  "CREATE TABLE session_message_timeline",
];
const MINIMUM_AGE = 2 * 60 * 60 * 1000;
const MAX_WAL = 16 * 1024 * 1024;

function statOrMissing(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.size,
    stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs];
}

function sameFile(path, expected) {
  const stat = statOrMissing(path);
  return stat && JSON.stringify(fingerprint(stat)) === JSON.stringify(expected);
}

function oldOwnedFile(path, now) {
  const stat = statOrMissing(path);
  if (!stat || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || now - Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs) < MINIMUM_AGE) return null;
  return stat;
}

function isMorphzWal(path, size) {
  if (size < 32 || size > MAX_WAL) return false;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const found = new Set();
    let carry = Buffer.alloc(0);
    let position = 0;
    while (position < size) {
      const count = readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      if (position === 0 && ![0x377f0682, 0x377f0683].includes(buffer.readUInt32BE(0))) return false;
      const part = Buffer.concat([carry, buffer.subarray(0, count)]);
      for (const marker of MARKERS) if (part.includes(marker)) found.add(marker);
      if (found.size === MARKERS.length) return true;
      carry = Buffer.from(part.subarray(Math.max(0, part.length - 128)));
      position += count;
    }
    return false;
  } finally { closeSync(fd); }
}

export function openPathsIn(directory, run = execFileSync) {
  // -a is essential: without it, lsof ORs the owner/directory selectors.
  let output;
  try {
    output = run("lsof", ["-nP", "-a", "-u", String(process.getuid()), "+d", directory, "-Fn"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  } catch (error) {
    // macOS lsof reports a global stale network mount even when examining only
    // our local temp directory. Accept only this exact unrelated-filesystem
    // warning, never permission/read failures for this directory or its files.
    let stderr = String(error.stderr ?? "");
    if (directory.startsWith("/private/var/")) {
      stderr = stderr.replace(
        /^lsof: WARNING: can't stat\(\) smbfs file system \/Volumes\/[^\n]+\n[ \t]+Output information may be incomplete\.\n[ \t]+assuming "dev=[^"\n]+" from mount table\n?/gm, "");
    }
    if (error.status !== 1 || error.signal || stderr.trim()) throw error;
    output = String(error.stdout ?? "");
    if (output.split("\n").some(line => line && !/^[pfn]/.test(line))) throw error;
  }
  const result = new Set();
  for (const line of output.split("\n")) {
    if (!line.startsWith("n")) continue;
    const path = line.slice(1).replace(/ \(deleted\)$/, "");
    // Resolve directory aliases without requiring the named file to exist.
    try { result.add(join(realpathSync(dirname(path)), basename(path))); } catch { /* unrelated handle */ }
  }
  return result;
}

export function inspectOrphan(directory, name, { openPaths, now = Date.now() }) {
  if (!WAL_NAME.test(name)) return null;
  const wal = join(directory, name);
  const main = wal.slice(0, -4);
  const shm = `${main}-shm`;
  if (statOrMissing(main) || [main, wal, shm].some(path => openPaths.has(path))) return null;
  const stat = oldOwnedFile(wal, now);
  if (!stat || !isMorphzWal(wal, stat.size)) return null;
  const files = [{ path: wal, fingerprint: fingerprint(stat), bytes: stat.blocks * 512 }];
  const shmStat = statOrMissing(shm);
  if (shmStat) {
    if (!oldOwnedFile(shm, now) || shmStat.size > 1024 * 1024) return null;
    files.push({ path: shm, fingerprint: fingerprint(shmStat), bytes: shmStat.blocks * 512 });
  }
  if (!files.every(file => sameFile(file.path, file.fingerprint))) return null;
  return { name, files };
}

export function scan(directory, openPaths, now = Date.now()) {
  return readdirSync(directory).flatMap(name => {
    const candidate = inspectOrphan(directory, name, { openPaths, now });
    return candidate ? [candidate] : [];
  });
}

export function applyCandidate(directory, candidate, openPaths, now = Date.now()) {
  if (!candidate || !WAL_NAME.test(candidate.name) || !Array.isArray(candidate.files)) return false;
  const current = inspectOrphan(directory, candidate.name, { openPaths, now });
  if (!current || JSON.stringify(current) !== JSON.stringify(candidate)) return false;
  // Recheck immediately before unlink; a returned/changed database is retained.
  if (statOrMissing(join(directory, candidate.name.slice(0, -4)))
    || !candidate.files.every(file => sameFile(file.path, file.fingerprint))) return false;
  for (const file of candidate.files) unlinkSync(file.path);
  return true;
}

function main() {
  const [mode, manifestPath] = process.argv.slice(2);
  if (!["--scan", "--apply"].includes(mode) || !manifestPath || !isAbsolute(manifestPath))
    throw new Error("Usage: node scripts/prune-orphan-test-sqlite.mjs --scan|--apply /absolute/audit-manifest.json");
  if (process.platform === "win32") throw new Error("This historical recovery tool requires POSIX lsof; use test-directory ownership on Windows.");
  const directory = realpathSync(tmpdir());
  const openPaths = openPathsIn(directory);
  if (mode === "--scan") {
    const candidates = scan(directory, openPaths);
    const manifest = { version: 1, directory, uid: process.getuid(), createdAt: new Date().toISOString(), candidates };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ manifest: manifestPath, candidates: candidates.length,
      bytes: candidates.flatMap(c => c.files).reduce((sum, f) => sum + f.bytes, 0) }));
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.version !== 1 || manifest.directory !== directory || manifest.uid !== process.getuid()
      || !Array.isArray(manifest.candidates)) throw new Error("Manifest does not identify this user's exact temporary directory.");
    const removed = [], retained = [];
    for (const candidate of manifest.candidates) {
      if (applyCandidate(directory, candidate, openPaths)) removed.push(candidate);
      else retained.push(candidate.name);
    }
    writeFileSync(`${manifestPath}.result.json`, JSON.stringify({ removed, retained }, null, 2),
      { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ removed: removed.length, retained: retained.length,
      bytes: removed.flatMap(c => c.files).reduce((sum, f) => sum + f.bytes, 0) }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
