import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import configuration from "../vite.config.js";

test("本机重建保留旧哈希延迟模块，已打开的桌面不会丢失 PDF 等按需资源", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-desktop-assets-"));
  try {
    writeFileSync(
      join(directory, "index.html"),
      '<script type="module" src="/entry.js"></script>',
    );
    writeFileSync(
      join(directory, "entry.js"),
      'window.openFixture = () => import("./lazy.js")',
    );
    writeFileSync(
      join(directory, "lazy.js"),
      'export const value = "original-resource"',
    );
    const config = typeof configuration === "object" ? configuration : null;
    assert.ok(config && "build" in config);
    const buildOptions = config.build as { emptyOutDir: boolean };
    assert.equal(buildOptions.emptyOutDir, false);
    const compile = () =>
      build({
        configFile: false,
        root: directory,
        logLevel: "silent",
        build: {
          outDir: join(directory, "dist"),
          emptyOutDir: buildOptions.emptyOutDir,
          minify: false,
        },
      });
    await compile();
    const assets = join(directory, "dist/assets");
    const oldChunk = readdirSync(assets).find((name) =>
      name.startsWith("lazy-"),
    )!;
    const oldBytes = readFileSync(join(assets, oldChunk));
    writeFileSync(
      join(directory, "lazy.js"),
      'export const value = "updated-resource"',
    );
    await compile();
    assert.equal(
      readdirSync(assets).filter((name) => name.startsWith("lazy-")).length,
      2,
    );
    assert.deepEqual(readFileSync(join(assets, oldChunk)), oldBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
