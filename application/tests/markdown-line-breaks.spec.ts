import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

let server: ViteDevServer, origin: string, cacheDir: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  cacheDir = await mkdtemp(join(tmpdir(), "morphz-markdown-fixture-"));
  server = await createServer({
    root,
    configFile: false,
    plugins: [react()],
    cacheDir,
    // Isolate dependency identity from any active App development server.
    // Discovering React twice mid-page can otherwise give different copies.
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "react",
        "react-dom/client",
        "react/jsx-dev-runtime",
        "react-markdown",
        "remark-gfm",
        "remark-cjk-friendly/parseOnly",
        "zod",
      ],
    },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
});

// Real SafeMarkdown component served by an isolated development Vite server.
// The source is synthetic; no Platform state, paid model or original App is used.
test("SafeMarkdown聊天/文档、流式/非流式保留原换行与结构", async ({
  page,
}, info) => {
  await page.goto(origin + "/tests/fixtures/markdown-line-breaks.html");
  const original = await page.getByLabel("原始 Markdown").textContent();
  await page.getByRole("button", { name: "追加流式正文" }).click();
  for (const surface of ["chat", "document"]) {
    for (const mode of ["flow", "static"]) {
      const section = page.getByRole("region", {
        name: `${surface}-${mode}`,
        exact: true,
      });
      const body = section.locator("[data-markdown-body]");
      await expect(body).toContainText("验收：第四行");
      await expect(
        body.getByRole("heading", { name: "文档标题", exact: true }),
      ).toHaveCount(surface === "document" ? 0 : 1);
      const paragraph = body.locator("p").first();
      await expect(paragraph.locator("br")).toHaveCount(3);
      const lineTops = await paragraph.evaluate((element) => {
        const labels = ["问题", "复现", "第三行", "验收"];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          texts.push(node as Text);
        const point = (position: number, end = false) => {
          let offset = 0;
          for (const node of texts) {
            if (
              position < offset + node.length ||
              (end && position === offset + node.length)
            )
              return { node, offset: position - offset };
            offset += node.length;
          }
          throw new Error("Markdown text point is outside the paragraph");
        };
        return labels.map((label) => {
          // Real streaming reveals split words across text nodes. Measure the
          // complete source label across those nodes instead of assuming one.
          const offset = element.textContent!.indexOf(label);
          if (offset < 0) throw new Error("Missing Markdown source label");
          const from = point(offset),
            to = point(offset + label.length, true),
            range = document.createRange();
          range.setStart(from.node, from.offset);
          range.setEnd(to.node, to.offset);
          return range.getBoundingClientRect().top;
        });
      });
      for (let index = 1; index < lineTops.length; index++)
        expect(lineTops[index]).toBeGreaterThan(lineTops[index - 1]!);
      await expect(body.locator("p").nth(1).locator("br")).toHaveCount(2);
      await expect(body.locator("li")).toHaveCount(3);
      await expect(body.locator("ul br")).toHaveCount(2);
      await expect(body.locator("pre code")).toHaveText(
        "代码第一行\n    代码第二行\n",
      );
      await expect(body.locator("pre br, pre [data-stream-at]")).toHaveCount(0);
      if (mode === "flow") {
        expect(
          await body.locator("p [data-stream-at]").count(),
        ).toBeGreaterThan(0);
      }
      await expect(body.locator("p").first().getByRole("link")).toHaveAttribute(
        "href",
        "https://example.invalid/",
      );
    }
  }
  expect(await page.getByLabel("原始 Markdown").textContent()).toBe(original);
  await page.screenshot({
    path: info.outputPath("markdown-line-breaks-real-components.png"),
    fullPage: true,
  });
});
