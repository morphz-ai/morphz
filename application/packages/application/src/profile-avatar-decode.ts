import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { DomainError } from "../../core/src/model.js";
import { avatarMaximumBytes } from "../../core/src/profile.js";

export type ProfileAvatarMime =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ValidatedProfileAvatar {
  bytes: Uint8Array;
  poster: Uint8Array;
  mime: ProfileAvatarMime;
  width: number;
  height: number;
  frames: number;
  durationMs: number;
}

export const profileAvatarDecodeLimits = Object.freeze({
  maximumBytes: avatarMaximumBytes,
  maximumDimension: 2048,
  maximumFramePixels: 2048 * 2048,
  maximumTotalPixels: 32 * 1024 * 1024,
  maximumFrames: 120,
  maximumDurationMs: 30000,
  posterDimension: 256,
  nativeTimeoutSeconds: 3,
  wallTimeoutMs: 5000,
});

const sharpPath = createRequire(import.meta.url).resolve("sharp");

function invalid(message = "头像无法读取，请换一张图片。") {
  return new DomainError("invalid", message);
}

function sniffMime(bytes: Buffer): ProfileAvatarMime {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.length >= 20 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  )
    return "image/webp";
  throw invalid("请选择 PNG、JPEG、GIF 或 WebP 图片。");
}

/** APNG is not included: libvips' PNG metadata does not census APNG frames. */
function checkPngContainer(bytes: Buffer) {
  let offset = 8;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw invalid();
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (first && (type !== "IHDR" || length !== 13)) throw invalid();
    first = false;
    if (type === "acTL") throw invalid("动态图请使用 GIF 或 WebP。");
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) throw invalid();
      return;
    }
  }
  throw invalid();
}

// Resolve sharp beside this module, not relative to the current working directory.
// Metadata reads only establish budgets. The poster pipeline genuinely decodes
// page 0; no claim is made that the compressed pixels of later frames were decoded.
const workerSource = String.raw`
const {parentPort, workerData} = require('node:worker_threads');
const sharp = require(workerData.sharpPath);
const limits = workerData.limits;
const input = Buffer.from(workerData.bytes);
const expectedFormat = { 'image/png':'png', 'image/jpeg':'jpeg', 'image/gif':'gif', 'image/webp':'webp' }[workerData.mime];
const malformed = '头像无法读取，请换一张图片。';
const integer = value => Number.isSafeInteger(value) && value > 0;
(async () => {
  const metadata = await sharp(input, {
    page:0, pages:1, animated:false, failOn:'warning', unlimited:false,
    limitInputPixels:limits.maximumFramePixels, limitInputChannels:4,
  }).metadata();
  if (metadata.format !== expectedFormat) throw new Error(malformed);
  const width = metadata.width, height = metadata.height, frames = metadata.pages ?? 1;
  if (!integer(width) || !integer(height) || !integer(frames)) throw new Error(malformed);
  if (width > limits.maximumDimension || height > limits.maximumDimension)
    throw new Error('头像尺寸过大，请缩小到 2048 × 2048 以内。');
  if (frames > limits.maximumFrames || width * height * frames > limits.maximumTotalPixels)
    throw new Error('动态图过大，请缩小尺寸或减少帧数。');
  if (frames > 1 && !['gif','webp'].includes(metadata.format)) throw new Error(malformed);
  let durationMs = 0;
  if (frames > 1) {
    if (!Array.isArray(metadata.delay) || metadata.delay.length !== frames) throw new Error(malformed);
    for (const delay of metadata.delay) {
      if (!Number.isSafeInteger(delay) || delay < 0) throw new Error(malformed);
      durationMs += delay;
      if (!Number.isSafeInteger(durationMs) || durationMs > limits.maximumDurationMs)
        throw new Error('动态图过长，请控制在 30 秒以内。');
    }
  }
  const output = await sharp(input, {
    page:0, pages:1, animated:false, failOn:'warning', unlimited:false,
    limitInputPixels:limits.maximumFramePixels, limitInputChannels:4,
  }).autoOrient().resize({
    width:limits.posterDimension, height:limits.posterDimension,
    fit:'inside', withoutEnlargement:true,
  }).png({compressionLevel:6}).timeout({seconds:limits.nativeTimeoutSeconds}).toBuffer({resolveWithObject:true});
  if (output.info.format !== 'png' || output.info.width > limits.posterDimension || output.info.height > limits.posterDimension || !output.data.length)
    throw new Error(malformed);
  parentPort.postMessage({ok:true, poster:new Uint8Array(output.data), width,height,frames,durationMs});
})().catch(error => {
  const publicMessages = [malformed, '头像尺寸过大，请缩小到 2048 × 2048 以内。', '动态图过大，请缩小尺寸或减少帧数。', '动态图过长，请控制在 30 秒以内。'];
  parentPort.postMessage({ok:false, message:publicMessages.includes(error && error.message) ? error.message : malformed});
});
`;

/** Accepts original bytes only; filename and caller-supplied MIME grant no trust. */
export async function validateProfileAvatar(
  input: Uint8Array,
): Promise<ValidatedProfileAvatar> {
  if (!(input instanceof Uint8Array) || !input.byteLength) throw invalid();
  if (input.byteLength > profileAvatarDecodeLimits.maximumBytes)
    throw invalid("头像过大，请选择 4 MiB 以内的图片。");
  // Copy before asynchronous work: subsequent caller mutation cannot change
  // the validated original, MIME or digest that the Host subsequently publishes.
  const bytes = Buffer.from(input);
  const mime = sniffMime(bytes);
  if (mime === "image/png") checkPngContainer(bytes);
  const workerBytes = new Uint8Array(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: [],
      workerData: {
        sharpPath,
        bytes: workerBytes,
        mime,
        limits: profileAvatarDecodeLimits,
      },
      transferList: [workerBytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      work();
    };
    // A Worker is not a process sandbox: libvips async work has its own native
    // timeout. This deadline bounds the Host's wait, including metadata/queueing.
    const timer = setTimeout(
      () => finish(() => reject(invalid("头像处理超时，请换一张图片。"))),
      profileAvatarDecodeLimits.wallTimeoutMs,
    );
    worker.once(
      "message",
      (result: {
        ok: boolean;
        message?: string;
        poster: Uint8Array;
        width: number;
        height: number;
        frames: number;
        durationMs: number;
      }) => {
        finish(() => {
          if (!result.ok) return reject(invalid(result.message));
          resolve({
            bytes,
            poster: result.poster,
            mime,
            width: result.width,
            height: result.height,
            frames: result.frames,
            durationMs: result.durationMs,
          });
        });
      },
    );
    worker.once("error", () => finish(() => reject(invalid())));
    worker.once("exit", () => finish(() => reject(invalid())));
  });
}
