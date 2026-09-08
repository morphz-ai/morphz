import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact, humanTask } from "./artifact-fixtures.js";
import { test, expect } from "@playwright/test";
test("人工事项通过统一输入提交结果，刷新保留作者和回应版本", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(
    page,
    "确认资料引用范围",
    humanTask("请确认仅使用已经导入的项目资料，然后继续撰写文档。"),
  );
  const panel = page.getByRole("region", { name: "实际执行与回应" });
  await expect(panel.locator("textarea")).toHaveCount(0);
  await panel
    .getByRole("button", { name: "提交结果并完成", exact: true })
    .click();
  await page
    .getByLabel("AI 输入内容")
    .fill("确认。仅使用项目内授权资料，不引用个人文件。");
  await page
    .getByRole("button", { name: "提交结果并完成事项", exact: true })
    .click();
  await expect(panel.locator("blockquote")).toContainText("不引用个人文件");
  await expect(panel.locator("blockquote")).toContainText("回应 v1");
  await expect(page.locator(".task-state")).toHaveText("执行进度已完成");
  await page.reload();
  await expect(panel.locator("blockquote")).toContainText("不引用个人文件");
  await panel.screenshot({ path: "test-results/task-response.png" });
});
