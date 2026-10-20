import { expect, type Page } from "@playwright/test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import type { SpeechScope } from "../apps/web/src/client.js";

const prefix = "/__retained-transcription/";
let bundle: Promise<Map<string, { body: string | Uint8Array; contentType: string }>> | undefined;
function assets() {
  return bundle ??= (async () => {
    const main = resolve("apps/web/src/main.tsx");
    const styles = [...readFileSync(main, "utf8").matchAll(/^import "(.+\.css)";/gm)]
      .map((match) => `import ${JSON.stringify(resolve(dirname(main), match[1]!))};`)
      .join("\n");
    const result = await build({
      configFile: false,
      root: resolve("."),
      publicDir: false,
      base: prefix,
      logLevel: "error",
      plugins: [react(), {
        name: "retained-transcription-styles",
        resolveId(id) { if (id === "virtual:application-styles") return "\0application-styles"; },
        load(id) { if (id === "\0application-styles") return styles; },
      }],
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: resolve("tests/fixtures/retained-transcription.tsx"),
          output: { entryFileNames: "fixture.js", assetFileNames: "[name]-[hash][extname]" },
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      "output" in item ? item.output : [],
    );
    const files = new Map<string, { body: string | Uint8Array; contentType: string }>();
    for (const item of outputs) files.set(prefix + item.fileName, {
      body: item.type === "chunk" ? item.code : item.source,
      contentType: item.fileName.endsWith(".css") ? "text/css" :
        item.fileName.endsWith(".js") ? "text/javascript" : "application/octet-stream",
    });
    files.set(prefix, {
      contentType: "text/html",
      body: `<!doctype html><html data-appearance="light"><head><link rel="icon" href="data:,">${
        [...files.keys()].filter((path) => path.endsWith(".css"))
          .map((path) => `<link rel="stylesheet" href="${path}">`).join("")
      }</head><body><div id="root"></div><script type="module" src="${prefix}fixture.js"></script></body></html>`,
    });
    return files;
  })();
}

/** Mount the retained component only. No production menu is restored. */
export async function openRetainedTranscription(
  page: Page,
  scene?: { scope: SpeechScope; title: string },
) {
  const origin = new URL(page.url()).origin;
  if (new URL(page.url()).pathname !== prefix) {
    const files = await assets();
    await page.route(`**${prefix}**`, async (route) => {
      const file = files.get(new URL(route.request().url()).pathname);
      if (!file) throw new Error("Unregistered component fixture asset");
      await route.fulfill({ ...file, body: typeof file.body === "string" ? file.body : Buffer.from(file.body) });
    });
    await page.goto(origin + prefix);
    await expect(page.getByRole("status")).toHaveText("测试组件已连接");
  }
  if (!scene) {
    const source = await PlatformClient.connect(new HttpApplicationClient(origin));
    const spaces = await source.ensurePersonalSpaces();
    scene = { scope: { projectId: spaces.deskId }, title: "TEST 保留转写组件" };
  }
  await page.evaluate((value) => Reflect.get(window, "retainedTranscription").open(value), scene);
  await expect(page.getByRole("dialog", { name: "录音转文字", exact: true })).toBeVisible();
}
