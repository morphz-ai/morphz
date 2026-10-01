import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  profileAvatarDecodeLimits,
  validateProfileAvatar,
} from "../packages/application/src/profile-avatar-decode.js";
import { DomainError } from "../packages/core/src/model.js";

async function still(
  format: "png" | "jpeg" | "gif" | "webp",
  width = 40,
  height = 24,
) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 24, g: 140, b: 170, alpha: 1 },
    },
  })
    [format]()
    .toBuffer();
}

async function animation(
  format: "gif" | "webp",
  frames: number,
  width = 8,
  height = 6,
  delay = 100,
) {
  const inputs = Array.from({ length: frames }, (_, index) => ({
    create: {
      width,
      height,
      channels: 4 as const,
      background: { r: (index * 80) % 255, g: 140, b: 170, alpha: 1 },
    },
  }));
  const frameBuffers = await Promise.all(
    inputs.map((input) => sharp(input).png().toBuffer()),
  );
  return sharp(frameBuffers, { join: { animated: true } })
    [format]({ delay: Array.from({ length: frames }, () => delay) })
    .toBuffer();
}

async function rejectsInvalid(bytes: Uint8Array, message?: RegExp) {
  await assert.rejects(validateProfileAvatar(bytes), (error) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "invalid");
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("四种真实图片魔数和解码匹配，原件不改写、poster是真正独立PNG首帧", async () => {
  for (const format of ["png", "jpeg", "gif", "webp"] as const) {
    const original = await still(format);
    const result = await validateProfileAvatar(original);
    assert.equal(
      result.mime,
      format === "jpeg" ? "image/jpeg" : `image/${format}`,
    );
    assert.deepEqual(result.bytes, original);
    assert.notEqual(result.bytes, original);
    assert.equal(result.width, 40);
    assert.equal(result.height, 24);
    assert.equal(result.frames, 1);
    assert.equal(result.durationMs, 0);
    const poster = await sharp(result.poster).metadata();
    assert.equal(poster.format, "png");
    assert.equal(poster.width, 40);
    assert.equal(poster.height, 24);
    assert.equal(poster.pages || 1, 1);
    const raw = await sharp(result.poster)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.ok(raw.data.length > 0);
  }
});

test("256px以内poster保留比例和EXIF朝向，验证后调用方改bytes不影响保存原件", async () => {
  const original = await still("png", 512, 384);
  const reference = Buffer.from(original);
  const pending = validateProfileAvatar(original);
  original.fill(0);
  const result = await pending;
  assert.deepEqual(result.bytes, reference);
  const metadata = await sharp(result.poster).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 192);
  assert.equal(metadata.exif, undefined);
  const oriented = await sharp({
    create: { width: 80, height: 40, channels: 3, background: "#168997" },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const orientedResult = await validateProfileAvatar(oriented);
  assert.equal(orientedResult.width, 80);
  assert.equal(orientedResult.height, 40);
  const orientedPoster = await sharp(orientedResult.poster).metadata();
  assert.equal(orientedPoster.width, 40);
  assert.equal(orientedPoster.height, 80);
  assert.equal(orientedPoster.orientation, undefined);
});

test("GIF和WebP动画按原件真实帧和delay预算，只将第0帧解码为静态poster", async () => {
  for (const format of ["gif", "webp"] as const) {
    const original = await animation(format, 3, 8, 6, 120);
    const result = await validateProfileAvatar(original);
    assert.equal(result.frames, 3);
    assert.equal(result.durationMs, 360);
    assert.equal(result.width, 8);
    assert.equal(result.height, 6);
    const expected = await sharp(original, { page: 0, pages: 1 })
      .raw()
      .toBuffer();
    const actual = await sharp(result.poster).raw().toBuffer();
    assert.deepEqual(actual, expected);
    assert.equal((await sharp(result.poster).metadata()).pages || 1, 1);
  }
});

test("拒绝空值、超4MiB、SVGHTML路径URL和伪装图片头，不接受声明MIME作为授权", async () => {
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(profileAvatarDecodeLimits.maximumBytes + 1),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from("<html><script>alert(1)</script></html>"),
    Buffer.from("https://example.com/avatar.png"),
    Buffer.from("/Users/example/private.png"),
    Buffer.from("GIF89a<html>not pixels</html>"),
    Buffer.from([255, 216, 255, 224, 0, 0, 0, 0]),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("<script/>"),
    ]),
  ])
    await rejectsInvalid(bytes);
  await rejectsInvalid(
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .tiff()
      .toBuffer(),
    /PNG/,
  );
});

test("真实超尺寸／帧数／时长和总展开像素被拒绝，低字节高压缩图不能绕过", async () => {
  const oversize = await still("png", 2049, 3);
  assert.ok(oversize.length < 4 * 1024 * 1024);
  await rejectsInvalid(oversize, /尺寸过大/);
  await rejectsInvalid(await animation("gif", 121), /减少帧数/);
  await rejectsInvalid(await animation("webp", 2, 8, 6, 16000), /30 秒/);
  const expansion = await animation("webp", 33, 1024, 1024);
  assert.ok(expansion.byteLength < profileAvatarDecodeLimits.maximumBytes);
  await rejectsInvalid(expansion, /减少帧数/);
});

test("破损像素数据不能仅凭可读header通过，PNG APNG帧目录明确不支持", async () => {
  const png = await still("png", 128, 128);
  const corrupted = Buffer.from(png);
  let position = 8;
  while (position + 12 <= corrupted.length) {
    const length = corrupted.readUInt32BE(position);
    if (
      corrupted.subarray(position + 4, position + 8).toString("ascii") ===
      "IDAT"
    ) {
      corrupted.fill(0, position + 8, position + 8 + length);
      break;
    }
    position += length + 12;
  }
  // Header-only metadata can be readable; the poster decode must still reject.
  await rejectsInvalid(corrupted);
  const apngChunk = Buffer.alloc(20);
  apngChunk.writeUInt32BE(8, 0);
  apngChunk.write("acTL", 4, "ascii");
  apngChunk.writeUInt32BE(200, 8);
  const apng = Buffer.concat([
    png.subarray(0, 33),
    apngChunk,
    png.subarray(33),
  ]);
  await rejectsInvalid(apng, /GIF 或 WebP/);
  await rejectsInvalid(Buffer.concat([png, Buffer.from("trailing")]));
  for (const format of ["jpeg", "gif", "webp"] as const) {
    const original = await still(format, 128, 128);
    await rejectsInvalid(original.subarray(0, Math.floor(original.length / 2)));
  }
});

test("2048px静态和120帧/30秒边界仍可用，单帧尺寸不会误用动画堆叠高度", async () => {
  const largestStill = await validateProfileAvatar(
    await still("png", 2048, 2048),
  );
  assert.equal(largestStill.width, 2048);
  assert.equal(largestStill.height, 2048);
  assert.equal((await sharp(largestStill.poster).metadata()).width, 256);
  const longest = await validateProfileAvatar(
    await animation("gif", 120, 8, 6, 250),
  );
  assert.equal(longest.frames, 120);
  assert.equal(longest.durationMs, 30000);
  assert.equal(longest.height, 6);
});

test("Host处理截止真实触发超时并终止worker，不等待无限解码", async (context) => {
  const bytes = await still("png");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = validateProfileAvatar(bytes);
    context.mock.timers.tick(profileAvatarDecodeLimits.wallTimeoutMs + 1);
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof DomainError);
      assert.match(error.message, /超时/);
      return true;
    });
  } finally {
    context.mock.timers.reset();
  }
});
