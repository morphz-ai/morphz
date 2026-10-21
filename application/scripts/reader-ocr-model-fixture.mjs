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
import {
  readingOcrModels,
  downloadReadingOcrModel,
} from "../dist/service/packages/application/src/reader-ocr-models.js";

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
  const data = await downloadReadingOcrModel(
    model,
    AbortSignal.timeout(120_000),
  );
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
