import test from "node:test";
import assert from "node:assert/strict";
import {
  isoTimeAtMicros,
  isoTimeMicros,
  sameIsoTimeMicros,
} from "../packages/application/src/iso-time.js";

test("Runtime nanoseconds and SQL microseconds describe the same precise instant", () => {
  const micros = 1_790_783_240_670_650;
  assert.equal(isoTimeMicros("2026-09-30T15:47:20.670650987Z"), micros);
  assert.equal(isoTimeMicros("2026-09-30T23:47:20.670650987+08:00"), micros);
  assert.equal(isoTimeMicros("2026-09-30T10:17:20.670650987-05:30"), micros);
  assert.equal(isoTimeAtMicros(micros), "2026-09-30T15:47:20.670650Z");
  assert.equal(
    sameIsoTimeMicros(
      "2026-09-30T15:47:20.670650987Z",
      "2026-09-30T23:47:20.670650+08:00",
    ),
    true,
  );
  assert.equal(
    sameIsoTimeMicros(
      "2026-09-30T15:47:20.670650987Z",
      "2026-09-30T15:47:20.670651Z",
    ),
    false,
    "a one-microsecond mutation is not rounded away",
  );
  assert.equal(isoTimeMicros("2026-09-30T15:47:20Z"), 1_790_783_240_000_000);
  assert.equal(isoTimeMicros("2026-09-30T15:47:20.6Z"), 1_790_783_240_600_000);
});

test("ISO time parsing rejects invalid dates and unsupported precision instead of normalizing them", () => {
  for (const value of [
    "2026-02-30T15:47:20Z",
    "2025-02-29T15:47:20Z",
    "2026-00-30T15:47:20Z",
    "2026-09-30T24:00:00Z",
    "2026-09-30T15:60:20Z",
    "2026-09-30T15:47:60Z",
    "2026-09-30T15:47:20.6706509876Z",
    "2026-09-30T15:47:20.Z",
    "2026-09-30 15:47:20Z",
    "2026-09-30T15:47:20",
    "2026-09-30T15:47:20+24:00",
    "2026-09-30T15:47:20+08:60",
    "2026-09-30T15:47:20+0800",
    "9999-09-30T15:47:20Z",
  ])
    assert.equal(isoTimeMicros(value), null, value);
  assert.equal(sameIsoTimeMicros("invalid", "invalid"), false);
  assert.equal(isoTimeAtMicros(1.5), null);
  assert.equal(isoTimeAtMicros(Number.MAX_SAFE_INTEGER + 1), null);
  assert.notEqual(isoTimeMicros("2024-02-29T15:47:20Z"), null);
});

test("microsecond cursor formatting also preserves instants before the Unix epoch", () => {
  assert.equal(isoTimeMicros("1969-12-31T23:59:59.999999999Z"), -1);
  assert.equal(isoTimeAtMicros(-1), "1969-12-31T23:59:59.999999Z");
});
