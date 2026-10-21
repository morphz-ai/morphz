import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { readingOcrModels } from "../dist/service/packages/application/src/reader-ocr.js";

// Explicit test-only download. Never searches application profiles or stores
// permission on behalf of a Human; normal product installation is unchanged.
const [destination, consent] = process.argv.slice(2);
assert.ok(
  destination && consent === "--download",
  "Usage: reader-ocr-model-fixture.mjs <test-model-directory> --download",
);
const directory = resolve(destination);
await mkdir(directory, { recursive: true });
assert.ok(
  (await lstat(directory)).isDirectory(),
  "Model fixture must be a directory, not a symlink",
);
const valid = (data, model) =>
  data.length === model.size &&
  createHash("sha256").update(data).digest("hex") === model.sha256;
for (const [index, model] of readingOcrModels.entries()) {
  const path = join(directory, index ? "small-rec.tar" : "small-det.tar");
  try {
    assert.ok(
      (await lstat(path)).isFile(),
      "Model fixture must be a regular file",
    );
    if (valid(await readFile(path), model)) {
      console.log(`Verified ${model.name}`);
      continue;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(
    `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${model.name}_onnx_infer.tar`,
    {
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
      credentials: "omit",
    },
  );
  if (!response.ok || !response.body) {
    // This public, credential-free endpoint may reject a CI region while being
    // reachable locally. Retain a bounded upstream diagnostic; do not silently
    // retry, switch mirrors, skip OCR or weaken the pinned integrity check.
    let diagnostic = "";
    const reader = response.body?.getReader();
    if (reader) {
      try {
        const chunks = [];
        let length = 0;
        while (length < 2048) {
          const { done, value } = await reader.read();
          if (done) break;
          const part = value.subarray(0, 2048 - length);
          chunks.push(part);
          length += part.length;
        }
        diagnostic = Buffer.concat(chunks).toString("utf8");
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    throw new Error(
      `Model download failed for ${model.name}: HTTP ${response.status}; ` +
        `content-type=${response.headers.get("content-type")}; ` +
        `request-id=${response.headers.get("x-bce-request-id")}; ` +
        `body=${JSON.stringify(diagnostic)}`,
    );
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert.ok(length <= model.size, "Model exceeds its pinned size");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  assert.ok(
    valid(data, model),
    "Model hash or size differs from the pinned version",
  );
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  console.log(`Downloaded and verified ${model.name}`);
}
