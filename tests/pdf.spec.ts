import { composerAction } from "./interaction-helpers.js";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openLibrary } from "./application-helpers.js";

test("PDF 真实画布、中文文字层、分页引用、批注与重开", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const title = "PDF 阅读-" + Date.now();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("新对象标题").fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  // Seed a retained pre-migration PDF, not a new UI import workflow.
  const boot = await (await page.request.get("/api/workspace")).json();
  const project = boot.workspace.projects.find(
    (p: { title: string }) => p.title === title,
  );
  const imported = await page.request.post("/api/import/pdf", {
    headers: {
      Origin: new URL(page.url()).origin,
      "X-MorphzWork-Token": boot.csrfToken,
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
  await expect(page.locator(".pdf-text-layer")).toContainText("DESIGN NOTES");
  await expect(page.locator(".pdf-text-layer")).toContainText("合成测试资料");
  await expect(page.getByText("正在渲染第 1 页…")).toHaveCount(0);
  // One integrated toolbar; no duplicate title, author or paging row above the PDF.
  await expect(page.locator(".topbar .pdf-controls")).toBeVisible();
  await expect(
    page.locator(
      ".pdf-paper > h1, .pdf-paper > .byline, .pdf-reader > .pdf-controls",
    ),
  ).toHaveCount(0);
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(async () => {
        const bar = await page.locator(".topbar").boundingBox();
        const canvas = await page.locator(".pdf-page").boundingBox();
        // Resizing may briefly unmount the old PDF canvas while its replacement
        // renders. Keep polling the same geometry bound instead of throwing.
        return bar && canvas ? canvas.y - bar.y - bar.height : Infinity;
      })
      .toBeLessThanOrEqual(12);
    const paging = (await page.getByLabel("PDF 页码").boundingBox())!;
    expect(paging.x + paging.width).toBeLessThanOrEqual(width);
    await expect(page.locator(".topbar")).toHaveJSProperty(
      "scrollWidth",
      await page.locator(".topbar").evaluate((e) => e.clientWidth),
    );
    await page.screenshot({ path: `test-results/pdf-integrated-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(
    await page
      .locator(".pdf-page canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width),
  ).toBeGreaterThan(300);
  await page.getByRole("button", { name: "PDF 下一页" }).click();
  await expect(page.locator(".pdf-text-layer")).toContainText(
    "durable butterfly",
  );
  await expect(page.getByText("正在渲染第 2 页…")).toHaveCount(0);
  await expect(page.locator(".pdf-page")).toBeVisible();
  await page
    .locator(".pdf-page")
    .screenshot({ path: "test-results/pdf-page.png" });
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await page.getByLabel("全文搜索").fill("durable butterfly");
  await page.getByLabel("搜索项目范围").selectOption({ label: title });
  await expect(
    page.getByRole("dialog").getByText("没有找到匹配内容"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .locator(".pdf-text-layer span")
    .filter({ hasText: "durable butterfly" })
    .first()
    .click({ clickCount: 3 });
  await page
    .getByRole("toolbar", { name: "选中文本操作" })
    .getByRole("button", { name: "询问 Morphz", exact: true })
    .click();
  await page.getByLabel("AI 输入内容").fill("这段原文需要进一步解释。");
  await composerAction(page, "保存为批注");
  const value = await page.request.get("/api/workspace").then((r) => r.json());
  expect(
    value.workspace.annotations.some(
      (a: { page?: number; body: string }) =>
        a.page === 2 && a.body === "这段原文需要进一步解释。",
    ),
  ).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator(".pdf-page")).toBeVisible();
  await expect(page.getByLabel("PDF 页码")).toHaveValue("2");
  await expect(page.locator(".pdf-text-layer")).toContainText(
    "durable butterfly",
  );
  await page.screenshot({
    path: "test-results/pdf-reader.png",
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
