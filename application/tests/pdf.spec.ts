import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openLibrary } from "./application-helpers.js";

test("既有 PDF 在阅读器中保留真实画布、中文文字层、分页批注与重开", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const title = "PDF 阅读-" + Date.now();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  // Seed a retained pre-migration PDF, not a new UI import workflow.
  const boot = await (await page.request.get("/api/workspace")).json();
  const project = boot.workspace.projects.find(
    (p: { title: string }) => p.title === title,
  );
  const imported = await page.request.post("/api/import/pdf", {
    headers: {
      Origin: new URL(page.url()).origin,
      "X-Morphz-Token": boot.csrfToken,
      "X-Command-Id": randomUUID(),
      "X-Project-Id": project.id,
      "X-Source-Path": "reader.pdf",
      "Content-Type": "application/pdf",
    },
    data: readFileSync(new URL("./fixtures/reader.pdf", import.meta.url)),
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await openLibrary(page);
  await page.locator(".artifact-card").filter({ hasText: "reader" }).click();
  // Existing PDFs now open in the same reader as new imports, not the retired
  // object PDF toolbar. Hidden application instances must not match this test.
  const paper = page.locator(".reading-app:visible");
  await expect(paper.locator(".pdf-text-layer")).toContainText("DESIGN NOTES");
  await expect(paper.locator(".pdf-text-layer")).toContainText("合成测试资料");
  await expect(page.getByText("正在渲染第 1 页…")).toHaveCount(0);
  const toolbar = paper.locator(".reader-toolbar");
  await expect(
    toolbar.getByRole("heading", { name: "reader", exact: true }),
  ).toHaveCount(1);
  expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(48);
  await paper.getByRole("button", { name: "阅读设置", exact: true }).click();
  const settings = paper.getByRole("complementary", { name: "阅读设置" });
  // A fixed-layout PDF is not re-typeset: do not offer inert typography controls.
  await expect(settings.getByLabel("阅读字号", { exact: true })).toHaveCount(0);
  await expect(settings.getByLabel("阅读字体", { exact: true })).toHaveCount(0);
  await settings.getByLabel("阅读主题", { exact: true }).selectOption("paper");
  await expect(paper).toHaveAttribute("data-theme", "paper");
  await settings.getByLabel("阅读主题", { exact: true }).selectOption("system");
  await settings
    .getByRole("button", { name: "关闭阅读侧栏", exact: true })
    .click();
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(async () => {
        const bar = await paper.locator(".reader-viewport").boundingBox();
        const canvas = await paper.locator(".pdf-page").boundingBox();
        // Resizing may briefly unmount the old PDF canvas while its replacement
        // renders. Keep polling the same geometry bound instead of throwing.
        return bar && canvas ? canvas.y - bar.y : Infinity;
      })
      .toBeLessThanOrEqual(64);
    const ocr = paper.locator(".reader-ocr-controls");
    await expect(ocr).not.toHaveAttribute("open");
    expect((await ocr.boundingBox())!.height).toBeLessThanOrEqual(36);
    await ocr.getByText("扫描文字识别", { exact: true }).click();
    await expect(ocr.getByLabel("OCR 阅读顺序", { exact: true })).toBeVisible();
    await ocr.getByText("扫描文字识别", { exact: true }).click();
    const paging = (await paper.locator(".reader-page-count").boundingBox())!;
    expect(paging.x + paging.width).toBeLessThanOrEqual(width);
    await expect(toolbar).toHaveJSProperty(
      "scrollWidth",
      await toolbar.evaluate((e) => e.clientWidth),
    );
    await page.screenshot({ path: `test-results/pdf-integrated-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(
    await paper
      .locator(".pdf-page canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width),
  ).toBeGreaterThan(300);
  await paper.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(paper.locator(".pdf-text-layer")).toContainText(
    "durable butterfly",
  );
  await expect(page.getByText("正在渲染第 2 页…")).toHaveCount(0);
  await expect(paper.locator(".pdf-page")).toBeVisible();
  await paper
    .locator(".pdf-page")
    .screenshot({ path: "test-results/pdf-page.png" });
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await page.getByLabel("全文搜索").fill("durable butterfly");
  await page.getByLabel("搜索项目范围").selectOption({ label: title });
  await expect(
    page.getByRole("dialog").getByText("没有找到匹配内容"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await paper
    .locator(".pdf-text-layer span")
    .filter({ hasText: "durable butterfly" })
    .first()
    .click({ clickCount: 3 });
  await page
    .getByRole("toolbar", { name: "阅读选文操作" })
    .getByRole("button", { name: "批注选文", exact: true })
    .click();
  await page
    .getByLabel("批注内容", { exact: true })
    .fill("这段原文需要进一步解释。");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect
    .poll(async () => {
      const value = await page.request
        .get("/api/workspace")
        .then((r) => r.json());
      return value.workspace.readingMarks.some(
        (a: any) =>
          a.location.sectionId === "page-2" &&
          a.kind === "note" &&
          a.note === "这段原文需要进一步解释。" &&
          a.quote.includes("durable butterfly"),
      );
    })
    .toBe(true);
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(paper.locator(".pdf-page")).toBeVisible();
  await expect(paper.locator(".reader-page-count")).toHaveText("2 / 2");
  await expect(paper.locator(".pdf-text-layer")).toContainText(
    "durable butterfly",
  );
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "阅读标注" }),
  ).toContainText("这段原文需要进一步解释。");
  await page.screenshot({
    path: "test-results/pdf-reader.png",
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
