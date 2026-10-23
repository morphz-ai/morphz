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
    pixels: [24, 10, 22, 26, 21, 9][index]!,
    x: [10, 20, 30, 70, 80, 90][index]!,
    maximumGain: 48,
  }));

test("fixed sweep intervals allow sparse glyph phases without reducing the visible-pixel or travel thresholds", () => {
  const frames = moving();
  const measured = assertPaintedSweep(frames, 100, 60);
  assert.deepEqual(
    measured.early.map((frame) => frame.time),
    [300, 600],
  );
  assert.deepEqual(
    measured.late.map((frame) => frame.time),
    [1200, 1350],
  );
  assert.equal(measured.travel, 55);
  assert.equal(frames.length, 6, "no unfavorable frame is dropped");
});

test("no light, a static glint, whole-paragraph changes and one-frame flashes still fail", () => {
  for (const frames of [
    moving().map((frame) => ({ ...frame, pixels: 0, x: null })),
    moving().map((frame) => ({ ...frame, x: 50 })),
    moving().map((frame) => ({ ...frame, pixels: 1000, x: 50 })),
    moving().map((frame, index) => ({
      ...frame,
      pixels: index === 0 ? 20 : 10,
    })),
    moving().map((frame, index) => ({
      ...frame,
      pixels: index === 5 ? 20 : 10,
    })),
  ])
    assert.throws(() => assertPaintedSweep(frames, 100, 60));
  assert.throws(
    () => assertPaintedSweep(moving().slice(1), 100, 60),
    /every fixed phase/,
  );
});

test("brightness caps apply to every frame, even one too sparse for travel measurement", () => {
  for (const cap of [60, 115]) {
    const frames = moving();
    frames[1] = { ...frames[1]!, maximumGain: cap + 1 };
    assert.throws(
      () => assertPaintedSweep(frames, 100, cap),
      /must not wash the text out/,
    );
  }
});
