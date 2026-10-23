import assert from "node:assert/strict";

// A moving band can cross spaces and sparse glyph strokes. Measure a fixed
// interval on either side, not a font-specific instant or a retry-until-green.
export const paintedSweepTimes = [300, 450, 600, 1200, 1350, 1500] as const;
export type PaintedSweepFrame = {
  time: number;
  painted: readonly (readonly [number, number])[];
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
    (frame) => frame.time <= 600 && frame.painted.length,
  );
  const late = frames.filter(
    (frame) => frame.time >= 1200 && frame.painted.length,
  );
  assert(
    early.length >= 2,
    "the glint must paint visible text at two early phases",
  );
  assert(
    late.length >= 2,
    "the glint must paint visible text at two late phases",
  );
  const coverage = (samples: readonly PaintedSweepFrame[]) => {
    const pixels = new Map<string, number>();
    for (const sample of samples)
      for (const [x, y] of sample.painted) {
        assert(Number.isInteger(x) && x >= 0 && x < Math.ceil(width));
        assert(Number.isInteger(y) && y >= 0);
        pixels.set(`${x}:${y}`, x);
      }
    assert(
      pixels.size > 10,
      "the fixed interval must paint more than ten distinct high-gain glyph pixels",
    );
    return {
      pixels: pixels.size,
      x: [...pixels.values()].reduce((sum, x) => sum + x, 0) / pixels.size,
    };
  };
  const earlyCoverage = coverage(early),
    lateCoverage = coverage(late);
  const travel = lateCoverage.x - earlyCoverage.x;
  assert(
    travel > width * 0.3,
    "the painted glint must travel through the text, not darken the whole paragraph",
  );
  return { early, late, earlyCoverage, lateCoverage, travel, width };
}
