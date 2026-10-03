import { createRequire } from "node:module";
import sharp from "sharp";

export type ExchangePaintComparatorResult = {
  errorMessage: string;
  diff?: Buffer;
} | null;

const require = createRequire(import.meta.url);
const version = (require("playwright-core/package.json") as { version: string })
  .version;
if (version !== "1.63.0")
  throw new Error(
    `Exchange paint comparator requires Playwright 1.63.0, got ${version}`,
  );

// Test-only, undocumented seam exported by the installed package. A version
// change requires rechecking its pixelmatch defaults and these contracts.
const comparePNG = (
  require("playwright-core/lib/coreBundle") as {
    utils: {
      getComparator(
        mimeType: "image/png",
      ): (
        actual: Buffer,
        expected: Buffer,
        options: { threshold: 0; maxDiffPixels: 0; maxDiffPixelRatio: 0 },
      ) => ExchangePaintComparatorResult;
    };
  }
).utils.getComparator("image/png");

/** Finite screenshot oracle, not raw RGBA equality: classify the unmodified
 * images with pixelmatch's heuristic AA, then accept only at-most-one-LSB RGB
 * noise at every reported non-AA pixel. Never change AA's input neighborhood.
 * Real edge changes can share its blind spot. Pair this with fixed CSS tuples
 * and strict computed paint/geometry, not an all-visual-changes guarantee. */
export async function compareExchangePaint(
  oldPNG: Buffer,
  candidatePNG: Buffer,
) {
  const decode = (png: Buffer) =>
    sharp(png)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  const [old, candidate] = await Promise.all([
    decode(oldPNG),
    decode(candidatePNG),
  ]);
  const sameSize =
    old.info.width === candidate.info.width &&
    old.info.height === candidate.info.height;
  const isQuantum = (offset: number) =>
    sameSize &&
    old.data[offset + 3] === candidate.data[offset + 3] &&
    [0, 1, 2].every((channel) => {
      const before = old.data[offset + channel],
        after = candidate.data[offset + channel];
      return (
        before !== undefined &&
        after !== undefined &&
        Math.abs(before - after) <= 1
      );
    });
  let rawPixels = 0,
    quantizedPixels = 0,
    rawChannels = 0,
    maxChannelDelta = 0,
    alphaPixels = 0;
  // Size differences are independently rejected below; this summary compares
  // decoded channel order (missing channels count as differences), not geometry.
  for (
    let offset = 0;
    offset < Math.max(old.data.length, candidate.data.length);
    offset += 4
  ) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const before = old.data[offset + channel],
        after = candidate.data[offset + channel];
      const delta = Math.abs((before ?? 0) - (after ?? 0));
      if (before !== after) {
        changed = true;
        rawChannels++;
      }
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (!changed) continue;
    rawPixels++;
    if (old.data[offset + 3] !== candidate.data[offset + 3]) alphaPixels++;
    // A raw summary only: these pixels are not necessarily reported non-AA.
    if (isQuantum(offset)) quantizedPixels++;
  }
  // Pixelmatch composites alpha onto white and can hide transparency changes.
  // Reject them before invoking it; differing dimensions remain its size check.
  if (sameSize && alphaPixels)
    return {
      rawPixels,
      quantizedPixels,
      rawChannels,
      maxChannelDelta,
      comparatorResult: {
        errorMessage: `${alphaPixels} pixels changed alpha.`,
      } as ExchangePaintComparatorResult,
    };
  let comparatorResult = comparePNG(candidatePNG, oldPNG, {
    threshold: 0,
    maxDiffPixels: 0,
    maxDiffPixelRatio: 0,
  });
  if (sameSize && comparatorResult?.diff) {
    const diff = await decode(comparatorResult.diff);
    let quantumDiffs = 0,
      allQuantum = true;
    for (let offset = 0; offset < diff.data.length; offset += 4) {
      // Fixed 1.63.0 defaults: non-AA differences red, AA yellow, rest gray.
      if (
        diff.data[offset] !== 255 ||
        diff.data[offset + 1] !== 0 ||
        diff.data[offset + 2] !== 0 ||
        diff.data[offset + 3] !== 255
      )
        continue;
      if (!isQuantum(offset)) {
        allQuantum = false;
        break;
      }
      quantumDiffs++;
    }
    if (allQuantum && quantumDiffs > 0) comparatorResult = null;
  }
  return {
    rawPixels,
    quantizedPixels,
    rawChannels,
    maxChannelDelta,
    comparatorResult,
  };
}
