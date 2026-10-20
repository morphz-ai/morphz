import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync, realpathSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyCandidate, inspectOrphan, openPathsIn, scan } from "../prune-orphan-test-sqlite.mjs";

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "morphz-orphan-wal-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = ".tmpABC123-wal";
  const wal = join(directory, name);
  const main = wal.slice(0, -4), shm = `${main}-shm`;
  const header = Buffer.alloc(32); header.writeUInt32BE(0x377f0682);
  writeFileSync(wal, Buffer.concat([header, Buffer.from("CREATE TABLE cognitive_contexts; CREATE TABLE thread_activations; CREATE TABLE session_message_timeline;")]));
  writeFileSync(shm, Buffer.alloc(32768));
  const now = Date.now() + 3 * 3600_000, openPaths = new Set();
  return { directory, name, wal, main, shm, now, openPaths };
}

test("dry run keeps files; exact reviewed orphan pair can be reclaimed", t => {
  const f = fixture(t);
  const candidates = scan(f.directory, f.openPaths, f.now);
  assert.equal(candidates.length, 1);
  assert.equal(readFileSync(f.shm).length, 32768);
  assert.equal(applyCandidate(f.directory, candidates[0], f.openPaths, f.now), true);
  assert.equal(scan(f.directory, f.openPaths, f.now).length, 0);
});

test("existing or returning main database always protects sidecars", t => {
  const f = fixture(t);
  const candidate = inspectOrphan(f.directory, f.name, f);
  writeFileSync(f.main, "live database");
  assert.equal(inspectOrphan(f.directory, f.name, f), null);
  assert.equal(applyCandidate(f.directory, candidate, f.openPaths, f.now), false);
  assert.equal(readFileSync(f.main, "utf8"), "live database");
});

test("open main, WAL or SHM protects the whole pair", t => {
  const f = fixture(t);
  for (const path of [f.main, f.wal, f.shm])
    assert.equal(inspectOrphan(f.directory, f.name, { ...f, openPaths: new Set([path]) }), null);
});

test("new files and non-Morphz WAL data are retained", t => {
  const f = fixture(t);
  assert.equal(inspectOrphan(f.directory, f.name, { ...f, now: Date.now() }), null);
  writeFileSync(f.wal, "unrelated or corrupt database");
  assert.equal(inspectOrphan(f.directory, f.name, f), null);
});

test("changed files and forged manifest paths are refused", t => {
  const f = fixture(t), candidate = inspectOrphan(f.directory, f.name, f);
  candidate.files[0].path = "/unrelated";
  assert.equal(applyCandidate(f.directory, candidate, f.openPaths, f.now), false);
  const original = inspectOrphan(f.directory, f.name, f);
  writeFileSync(f.shm, "changed");
  assert.equal(applyCandidate(f.directory, original, f.openPaths, f.now), false);
  assert.equal(readFileSync(f.shm, "utf8"), "changed");
  assert.equal(inspectOrphan(f.directory, "../.tmpABC123-wal", f), null);
});

test("symlink and hard-linked files cannot be reclaimed", t => {
  const f = fixture(t);
  linkSync(f.wal, join(f.directory, "retained"));
  assert.equal(inspectOrphan(f.directory, f.name, f), null);
  rmSync(f.wal);
  symlinkSync(join(f.directory, "retained"), f.wal);
  assert.equal(inspectOrphan(f.directory, f.name, f), null);
});

test("live lsof evidence protects an actually open WAL", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), fd = openSync(f.wal, "r");
  t.after(() => closeSync(fd));
  const openPaths = openPathsIn(f.directory);
  assert.ok(openPaths.has(f.wal));
  assert.equal(inspectOrphan(f.directory, f.name, { ...f, openPaths }), null);
});

test("failed or partial local handle inspection refuses cleanup", t => {
  const f = fixture(t);
  for (const stderr of ["permission denied", `lsof: WARNING: can't stat() ${f.directory}/file`]) {
    assert.throws(() => openPathsIn(f.directory, () => {
      throw Object.assign(new Error("inspection failed"), { status: 1, stderr, stdout: "" });
    }), /inspection failed/);
  }
  assert.throws(() => openPathsIn(f.directory, () => {
    throw Object.assign(new Error("timed out"), { status: null, signal: "SIGTERM", stderr: "", stdout: "" });
  }), /timed out/);
});
