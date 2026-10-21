import { createHash } from "node:crypto";

// PaddlePaddle's public, immutable Hugging Face revisions distribute the same
// ONNX/YAML bytes as the original BOS archives. Pin both the individual files
// and the original archive: existing installations and the OCR engine do not
// change identity, model, format or consent when the download source changes.
export const readingOcrModels = [
  {
    name: "PP-OCRv6_small_det",
    size: 9_891_840,
    sha256: "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4",
    revision: "28fe5895c24fd108c19eb3e8479f4ab385fbfc62",
    modifiedAt: 0o15211727610,
    files: [
      {
        name: "inference.onnx",
        size: 9_880_512,
        sha256:
          "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
      },
      {
        name: "inference.yml",
        size: 885,
        sha256:
          "193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516",
      },
    ],
  },
  {
    name: "PP-OCRv6_small_rec",
    size: 21_319_680,
    sha256: "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1",
    revision: "b8f84f0b80c529de40b4fbb3544b84fa7233a513",
    modifiedAt: 0o15211735535,
    files: [
      {
        name: "inference.onnx",
        size: 21_159_378,
        sha256:
          "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
      },
      {
        name: "inference.yml",
        size: 150_579,
        sha256:
          "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1",
      },
    ],
  },
] as const;
type Model = (typeof readingOcrModels)[number];
type PinnedBytes = { readonly size: number; readonly sha256: string };

export function verifiedOcrBytes(
  bytes: Uint8Array,
  pinned: PinnedBytes,
): boolean {
  return (
    bytes.length === pinned.size &&
    createHash("sha256").update(bytes).digest("hex") === pinned.sha256
  );
}

/** Reproduce this publisher's existing GNU tar packaging, not a new cache ABI. */
export function assembleReadingOcrModel(
  model: Model,
  files: readonly Uint8Array[],
): Buffer {
  if (
    files.length !== model.files.length ||
    files.some((file, index) => !verifiedOcrBytes(file, model.files[index]!))
  ) {
    throw new Error("模型文件完整性校验失败，已拒绝加载。");
  }
  const archive = Buffer.alloc(model.size);
  const directory = `${model.name}_onnx_infer/`;
  let offset = 0;
  const entry = (name: string, data: Uint8Array | null) => {
    const header = archive.subarray(offset, offset + 512);
    const octal = (value: number, start: number, length: number) => {
      header.write(
        value.toString(8).padStart(length - 1, "0"),
        start,
        length - 1,
        "ascii",
      );
    };
    header.write(name, 0, 100, "ascii");
    octal(data === null ? 0o755 : 0o644, 100, 8);
    octal(0o2005, 108, 8);
    octal(0o2006, 116, 8);
    octal(data?.length ?? 0, 124, 12);
    octal(model.modifiedAt, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = data === null ? 0x35 : 0x30;
    header.write("ustar  ", 257, "ascii");
    header.write("zhangyue66", 265, "ascii");
    header.write("zhangyue66", 297, "ascii");
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    offset += 512;
    if (data) {
      archive.set(data, offset);
      offset += Math.ceil(data.length / 512) * 512;
    }
  };
  entry(directory, null);
  files.forEach((data, index) =>
    entry(directory + model.files[index]!.name, data),
  );
  if (offset + 1024 > archive.length || !verifiedOcrBytes(archive, model)) {
    throw new Error("模型归档完整性校验失败，已拒绝加载。");
  }
  return archive;
}

const downloadHosts = new Set(["huggingface.co", "us.aws.cdn.hf.co"]);

async function downloadFile(
  url: URL,
  pinned: PinnedBytes,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !downloadHosts.has(url.hostname)
    ) {
      throw new Error("OCR 模型下载地址不在允许的官方分发范围内。");
    }
    const response = await fetcher(url.href, {
      signal,
      redirect: "manual",
      credentials: "omit",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("OCR 模型下载重定向缺少地址。");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        `下载 OCR 模型失败（HTTP ${response.status}），请检查网络后重试。`,
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > pinned.size)
          throw new Error("模型大小与固定版本不符，已拒绝加载。");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    if (!verifiedOcrBytes(bytes, pinned))
      throw new Error("模型完整性校验失败，已拒绝加载。");
    return bytes;
  }
  throw new Error("OCR 模型下载重定向次数超限。");
}

/** Called only after explicit download consent; never retries or changes models. */
export async function downloadReadingOcrModel(
  model: Model,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const files: Uint8Array[] = [];
  for (const file of model.files) {
    const url = new URL(
      `https://huggingface.co/PaddlePaddle/${model.name}_onnx/resolve/${model.revision}/${file.name}`,
    );
    files.push(await downloadFile(url, file, bounded, fetcher));
  }
  return assembleReadingOcrModel(model, files);
}
