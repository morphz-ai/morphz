import assert from "node:assert/strict";

// A moving band can cross spaces and sparse glyph strokes. Measure a fixed
// interval on either side, not a font-specific instant or a retry-until-green.
export const paintedSweepTimes = [300, 450, 600, 1200, 1350, 1500] as const;
export type PaintedSweepFrame = {
  time: number;
  pixels: number;
  x: number | null;
  maximumGain: number;
};

export function assertPaintedSweep(
  frames: readonly PaintedSweepFrame[],
  width: number,
  maximumGain: number,
) {
  assert.deepEqual(
    frames.map((frame) => frame.time),
    [...paintedSweepTimes],
    "every fixed phase must be measured, including sparse ones",
  );
  assert(width > 0);
  for (const frame of frames)
    assert(
      frame.maximumGain <= maximumGain,
      "the light must not wash the text out to pure white at any phase",
    );
  const early = frames.filter(
    (frame) => frame.time <= 600 && frame.pixels > 10,
  );
  const late = frames.filter(
    (frame) => frame.time >= 1200 && frame.pixels > 10,
  );
  assert(
    early.length >= 2,
    "the glint must paint visible text at two early phases",
  );
  assert(
    late.length >= 2,
    "the glint must paint visible text at two late phases",
  );
  const center = (samples: readonly PaintedSweepFrame[]) => {
    assert(samples.every((sample) => Number.isFinite(sample.x)));
    return samples.reduce((sum, sample) => sum + sample.x!, 0) / samples.length;
  };
  const travel = center(late) - center(early);
  assert(
    travel > width * 0.3,
    "the painted glint must travel through the text, not darken the whole paragraph",
  );
  return { early, late, travel, width };
}
