import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPaintedSweep,
  paintedSweepTimes,
  type PaintedSweepFrame,
} from "./fixtures/painted-sweep.js";

const moving = (): PaintedSweepFrame[] =>
  paintedSweepTimes.map((time, index) => ({
    time,
    // Actual Linux dark short-label counts: no individual early frame reaches
    // eleven pixels, but the moving band illuminates distinct glyph strokes.
    painted: Array.from(
      { length: [8, 10, 1, 2, 12, 13][index]! },
      (_, y) => [[8, 16, 21, 55, 62, 71][index]!, y] as const,
    ),
    maximumGain: 54,
  }));

test("fixed sweep intervals measure distinct painted glyphs without depending on one frame's font density", () => {
  const frames = moving();
  const measured = assertPaintedSweep(frames, 80, 60);
  assert.deepEqual(
    measured.early.map((frame) => frame.time),
    [300, 450, 600],
  );
  assert.deepEqual(
    measured.late.map((frame) => frame.time),
    [1200, 1350, 1500],
  );
  assert.equal(measured.earlyCoverage.pixels, 19);
  assert.equal(measured.lateCoverage.pixels, 27);
  assert(measured.travel > 80 * 0.3);
  assert.equal(frames.length, 6, "no unfavorable frame is dropped");
});

test("no light, static pixels, whole-paragraph changes and one-phase flashes fail", () => {
  const stationary = moving()[1]!.painted;
  for (const frames of [
    moving().map((frame) => ({ ...frame, painted: [] })),
    moving().map((frame) => ({ ...frame, painted: stationary })),
    moving().map((frame) => ({
      ...frame,
      painted: Array.from({ length: 80 }, (_, x) => [x, 0] as const),
    })),
    moving().map((frame, index) => ({
      ...frame,
      painted: index <= 2 && index !== 0 ? [] : frame.painted,
    })),
    moving().map((frame, index) => ({
      ...frame,
      painted: index >= 3 && index !== 5 ? [] : frame.painted,
    })),
  ])
    assert.throws(() => assertPaintedSweep(frames, 80, 60));
  assert.throws(
    () => assertPaintedSweep(moving().slice(1), 80, 60),
    /every fixed phase/,
  );
});

test("repeated pixels cannot inflate coverage; tiny spots and exactly thirty-percent movement fail", () => {
  for (const frames of [
    moving().map((frame) => ({
      ...frame,
      painted: Array.from({ length: 30 }, () => frame.painted[0]!),
    })),
    moving().map((frame) => ({ ...frame, painted: frame.painted.slice(0, 1) })),
    moving().map((frame, index) => ({
      ...frame,
      painted: Array.from(
        { length: 11 },
        (_, y) => [index < 3 ? 10 : 34, y] as const,
      ),
    })),
  ])
    assert.throws(() => assertPaintedSweep(frames, 80, 60));
});

test("brightness caps apply to every frame, including a sparse glyph phase", () => {
  for (const cap of [60, 115]) {
    const frames = moving();
    frames[2] = { ...frames[2]!, maximumGain: cap + 1 };
    assert.throws(
      () => assertPaintedSweep(frames, 80, cap),
      /must not wash the text out/,
    );
  }
});
