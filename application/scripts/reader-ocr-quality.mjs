import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { readingOcrModels } from "../dist/service/packages/application/src/reader-ocr.js";

// Research probe, NOT production Desktop acceptance. All input paths are explicit;
// inference is local, with no providers, implicit downloads or private credentials.
const [modelDirectory, ...manifests] = process.argv.slice(2);
assert.ok(
  modelDirectory && manifests.length,
  "Usage: reader-ocr-quality.mjs <models> <scan-manifest.json> [...]",
);
const directory = mkdtempSync(join(tmpdir(), "morphz-ocr-quality-"));
const files = new Map();
readingOcrModels.forEach((model, index) => {
  const data = readFileSync(
    join(modelDirectory, index ? "small-rec.tar" : "small-det.tar"),
  );
  assert.equal(data.length, model.size);
  assert.equal(createHash("sha256").update(data).digest("hex"), model.sha256);
  files.set(`/quality-assets/model-${index}`, data);
});
const samples = manifests.map((path, index) => {
  const sample = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(
    sample.title.startsWith("TEST ") && sample.source && sample.pages.length,
  );
  const data = readFileSync(resolve(dirname(path), sample.pdf));
  assert.ok(data.length <= 32 * 1024 * 1024);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sample.sha256) assert.equal(sha256, sample.sha256);
  files.set(`/quality-assets/pdf-${index}`, data);
  return { ...sample, sha256 };
});
const variants = [
  { name: "previous-raster", maxEdge: 2000, maxScale: 2.5, params: {} },
  { name: "production", maxEdge: 2000, maxScale: null, params: {} },
  { name: "detail-3000", maxEdge: 3000, maxScale: 3.75, params: {} },
  {
    name: "det-1536",
    maxEdge: 2000,
    maxScale: 2.5,
    params: { textDetLimitSideLen: 1536, textDetLimitType: "max" },
  },
  {
    name: "unclip-1.5",
    maxEdge: 2000,
    maxScale: 2.5,
    params: { textDetUnclipRatio: 1.5 },
  },
];
const code = Object.fromEntries(
  [
    "packages/core/src/reader-ocr.ts",
    "tests/fixtures/reader-ocr-quality.ts",
  ].map((path) => [
    path,
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  ]),
);
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    previous = row;
  }
  return previous[b.length];
}
const server = await createServer({
  configFile: false,
  root: resolve("tests/fixtures"),
  server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
  logLevel: "error",
  plugins: [
    {
      name: "explicit-quality-assets",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = new URL(req.url, "http://localhost").pathname;
          let file = files.get(path);
          if (/^\/quality-runtime\/ort-wasm[\w.-]+\.(mjs|wasm)$/.test(path)) {
            file = readFileSync(
              resolve(
                "node_modules/onnxruntime-web/dist",
                path.split("/").at(-1),
              ),
            );
            res.setHeader(
              "Content-Type",
              path.endsWith(".wasm")
                ? "application/wasm"
                : "application/javascript",
            );
          }
          const pdfAsset =
            /^\/quality-pdf\/(cmaps|standard_fonts|wasm)\/([a-zA-Z0-9_.-]+)$/.exec(
              path,
            );
          if (pdfAsset) {
            file = readFileSync(
              resolve("node_modules/pdfjs-dist", pdfAsset[1], pdfAsset[2]),
            );
            res.setHeader(
              "Content-Type",
              path.endsWith(".wasm")
                ? "application/wasm"
                : "application/octet-stream",
            );
          }
          if (!file) return next();
          res.end(file);
        });
      },
    },
  ],
});
let browser;
const rows = [],
  errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const origin = server.resolvedUrls.local[0];
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ||
    /^(blob|data):/.test(route.request().url())
      ? route.continue()
      : route.abort(),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}reader-ocr-quality.html`);
  await page.waitForFunction(() => typeof window.runQuality === "function");
  for (const [sampleIndex, sample] of samples.entries())
    for (const expected of sample.pages)
      for (const variant of variants) {
        const result = await page.evaluate(
          (input) => window.runQuality(input),
          {
            sample: sampleIndex,
            page: expected.page,
            layout: expected.layout,
            ...variant,
          },
        );
        await page.locator("canvas").screenshot({
          path: join(
            directory,
            `sample-${sampleIndex}-page-${expected.page}-${variant.name}.png`,
          ),
        });
        const truth = Array.from(expected.lines.join("").replace(/\s/gu, ""));
        const actual = Array.from(
          result.items
            .map((item) => item.text)
            .join("")
            .replace(/\s/gu, ""),
        );
        const row = {
          title: sample.title,
          page: expected.page,
          variant: variant.name,
          expected: expected.lines,
          characters: truth.length,
          edits: distance(truth, actual),
          ...result,
        };
        rows.push(row);
        writeFileSync(
          join(directory, "results.json"),
          JSON.stringify({ samples, variants, code, rows, errors }, null, 2),
        );
        console.log(
          JSON.stringify({
            title: row.title,
            page: row.page,
            variant: row.variant,
            edits: row.edits,
            characters: row.characters,
            milliseconds: Math.round(row.milliseconds),
            image: row.image,
          }),
        );
      }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
  console.log(`Quality evidence: ${join(directory, "results.json")}`);
}
