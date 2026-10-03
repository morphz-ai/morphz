import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { compareExchangePaint } from "./exchange-paint-comparison.js";

const size = 9;
const white = () => Buffer.alloc(size * size * 4, 255);
function pixel(data: Buffer, x: number, y: number, rgba: readonly number[]) {
  for (const [channel, value] of rgba.entries())
    data[(y * size + x) * 4 + channel] = value;
}
const png = (data: Buffer, width = size, height = size) =>
  sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
async function compare(old: Buffer, candidate: Buffer) {
  return compareExchangePaint(await png(old), await png(candidate));
}

test("Exchange paint preserves identical images and input PNG buffers", async () => {
  const image = await png(white());
  const before = Buffer.from(image);
  assert.deepEqual(await compareExchangePaint(image, image), {
    rawPixels: 0,
    quantizedPixels: 0,
    rawChannels: 0,
    maxChannelDelta: 0,
    comparatorResult: null,
  });
  assert.deepEqual(image, before);
});

test("Exchange paint accepts only equal-alpha per-pixel RGB one-LSB noise", async () => {
  const old = white(),
    candidate = Buffer.from(old);
  pixel(candidate, 4, 4, [254, 254, 254, 255]);
  const oldPNG = await png(old),
    candidatePNG = await png(candidate);
  const originals = [Buffer.from(oldPNG), Buffer.from(candidatePNG)];
  assert.deepEqual(await compareExchangePaint(oldPNG, candidatePNG), {
    rawPixels: 1,
    quantizedPixels: 1,
    rawChannels: 3,
    maxChannelDelta: 1,
    comparatorResult: null,
  });
  assert.deepEqual([oldPNG, candidatePNG], originals);
});

test("Exchange paint rejects opaque flat two-LSB and ten-level color changes", async () => {
  for (const delta of [2, 10]) {
    const old = white(),
      candidate = Buffer.from(old);
    pixel(candidate, 4, 4, [255 - delta, 255, 255, 255]);
    const result = await compare(old, candidate);
    assert.equal(result.rawPixels, 1);
    assert.equal(result.quantizedPixels, 0);
    assert.equal(result.rawChannels, 1);
    assert.equal(result.maxChannelDelta, delta);
    assert.ok(result.comparatorResult);
  }
});

test("Exchange paint retains a larger RGB change even beside normalized noise", async () => {
  const old = white(),
    candidate = Buffer.from(old);
  pixel(candidate, 2, 2, [254, 255, 255, 255]);
  pixel(candidate, 6, 6, [253, 254, 255, 255]);
  const result = await compare(old, candidate);
  assert.equal(result.rawPixels, 2);
  assert.equal(result.quantizedPixels, 1);
  assert.equal(result.rawChannels, 3);
  assert.equal(result.maxChannelDelta, 2);
  assert.ok(result.comparatorResult);
});

test("Exchange paint rejects changed alpha even when white compositing looks identical", async () => {
  for (const rgb of [255, 0]) {
    for (const delta of [1, 10]) {
      const old = white();
      pixel(old, 4, 4, [rgb, rgb, rgb, 255]);
      const candidate = Buffer.from(old);
      pixel(candidate, 4, 4, [rgb, rgb, rgb, 255 - delta]);
      const result = await compare(old, candidate);
      assert.equal(result.rawPixels, 1);
      assert.equal(result.quantizedPixels, 0);
      assert.equal(result.rawChannels, 1);
      assert.equal(result.maxChannelDelta, delta);
      assert.match(result.comparatorResult!.errorMessage, /changed alpha/);
    }
  }
});

test("Exchange paint rejects image-size changes", async () => {
  const result = await compareExchangePaint(
    await png(white()),
    await png(Buffer.alloc(10 * size * 4, 255), 10),
  );
  assert.equal(result.quantizedPixels, 0);
  assert.match(
    result.comparatorResult!.errorMessage,
    /Expected an image 9px by 9px, received 10px by 9px/,
  );
});

test("Exchange paint rejects a one-pixel translation of an opaque solid figure", async () => {
  const old = white(),
    candidate = white();
  for (let y = 2; y <= 6; y++)
    for (let x = 2; x <= 5; x++) pixel(old, x, y, [0, 0, 0, 255]);
  for (let y = 2; y <= 6; y++)
    for (let x = 3; x <= 6; x++) pixel(candidate, x, y, [0, 0, 0, 255]);
  const result = await compare(old, candidate);
  assert.equal(result.rawPixels, 10);
  assert.equal(result.quantizedPixels, 0);
  assert.equal(result.maxChannelDelta, 255);
  assert.ok(result.comparatorResult);
});

test("Exchange paint explicitly records pixelmatch's heuristic-AA edge blind spot", async () => {
  const old = white();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < 4; x++) pixel(old, x, y, [0, 0, 0, 255]);
    pixel(old, 4, y, [128, 128, 128, 255]);
  }
  const candidate = Buffer.from(old);
  pixel(candidate, 4, 4, [64, 64, 64, 255]);
  const result = await compare(old, candidate);
  assert.equal(result.rawPixels, 1);
  assert.equal(result.quantizedPixels, 0);
  assert.equal(result.maxChannelDelta, 64);
  // A deliberate visible edge mutation can still be classified as AA. This
  // oracle is not an assertion that every real visual change must fail.
  assert.equal(result.comparatorResult, null);
});

test("Exchange paint preserves original AA neighborhoods before checking one-LSB noise", async () => {
  const old = white();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const gray = x < 4 ? 10 : x > 4 ? 20 : 30;
      pixel(old, x, y, [gray, gray, gray, 255]);
    }
  pixel(old, 4, 4, [10, 10, 10, 255]);
  const candidate = Buffer.from(old);
  pixel(candidate, 4, 4, [20, 20, 20, 255]);
  for (let y = 3; y <= 5; y++) pixel(candidate, 5, y, [21, 21, 21, 255]);
  const result = await compare(old, candidate);
  assert.equal(result.rawPixels, 4);
  assert.equal(result.quantizedPixels, 3);
  assert.equal(result.maxChannelDelta, 10);
  assert.equal(result.comparatorResult, null);

  // Normalizing these neighbors first gives the center three equal siblings,
  // changes AA classification, and creates a non-AA ten-level difference.
  const prematureNormalization = Buffer.from(candidate);
  for (let y = 3; y <= 5; y++)
    pixel(prematureNormalization, 5, y, [20, 20, 20, 255]);
  assert.ok((await compare(old, prematureNormalization)).comparatorResult);
});
