import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

// Rasterize the approved vector silhouette at native 1024 resolution. Do not
// upscale the 512px social avatar or add a second, hand-drawn platform mask.
const source = new URL("../apps/desktop/assets/morphz.svg", import.meta.url);
const target = new URL("../apps/desktop/assets/morphz.png", import.meta.url);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  });
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    `<style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden}svg{display:block}</style>${await readFile(source, "utf8")}`,
  );
  await page.screenshot({ path: fileURLToPath(target), omitBackground: true });
  console.log("Rendered the unchanged Morphz mark at 1024 × 1024.");
} finally {
  await browser.close();
}
