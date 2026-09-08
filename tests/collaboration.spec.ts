import { openLibrary } from "./application-helpers.js";
import { test, expect } from "@playwright/test";
test("人工事项在对象内提交回应，刷新保留作者和回应版本", async ({ page }) => {
  await page.goto("/");
  await openLibrary(page);
  await page
    .locator(".creation-actions")
    .getByRole("button", { name: "新建事项", exact: true })
    .click();
  await page.getByLabel("新对象标题", { exact: true }).fill("确认资料引用范围");
  await page
    .getByLabel("工作要求", { exact: true })
    .fill("请确认仅使用已经导入的项目资料，然后继续撰写文档。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const panel = page.getByRole("region", { name: "实际执行与回应" });
  await expect(
    panel.getByRole("heading", { name: "回应这件事项" }),
  ).toBeVisible();
  await page
    .getByLabel("事项回应")
    .fill("确认。仅使用项目内授权资料，不引用个人文件。");
  await page.getByRole("button", { name: "提交回应并继续协作" }).click();
  await expect(panel.locator("blockquote")).toContainText("不引用个人文件");
  await expect(panel.locator("blockquote")).toContainText("回应 v1");
  await page.reload();
  await expect(panel.locator("blockquote")).toContainText("不引用个人文件");
  await panel.screenshot({ path: "test-results/task-response.png" });
});
