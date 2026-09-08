import { composerAction } from "./interaction-helpers.js";
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

test("PDF 真实画布、中文文字层、分页引用、批注与重开", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const title = "PDF 阅读-" + Date.now();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("新对象标题").fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("工作空间选项").click();
  await page.getByRole("button", { name: "导入资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入资料" });
  await dialog
    .getByLabel("选择资料文件")
    .setInputFiles(
      fileURLToPath(new URL("./fixtures/reader.pdf", import.meta.url)),
    );
  await dialog.getByRole("button", { name: "导入 1 篇资料" }).click();
  await expect(dialog.getByRole("status")).toHaveText("已导入 1 篇");
  await dialog.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".pdf-text-layer")).toContainText("DESIGN NOTES");
  await expect(page.locator(".pdf-text-layer")).toContainText("合成测试资料");
  await expect(page.getByText("正在渲染第 1 页…")).toHaveCount(0);
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
  await page.getByRole("button", { name: "搜索工作空间", exact: true }).click();
  await page.getByLabel("全文搜索").fill("durable butterfly");
  await page.getByLabel("搜索项目范围").selectOption({ label: title });
  await expect(page.getByRole("dialog").getByText(/第 2 页/)).toBeVisible();
  await page.getByRole("button", { name: "引用并提问" }).click();
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
