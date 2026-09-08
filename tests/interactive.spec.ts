import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import { test, expect } from "@playwright/test";
test("表格录入、表单查看与汇总报告保留对象版本", async ({ page }) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(
    page,
    "资料处理报告",
    structuredClone(emptyInteractive),
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "添加记录", exact: true }).click();
  await page.reload(); // incomplete draft must not disappear
  await expect(
    page.getByRole("button", { name: "保存版本", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel(/^名称 /)
    .fill("<script>window.compromised=true</script>");
  await page.getByLabel(/^数值 /).fill("12");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await expect(page.locator(".interactive-table")).toContainText(
    "<script>window.compromised=true</script>",
  );
  expect(
    await page.evaluate(() => Reflect.get(window, "compromised")),
  ).toBeUndefined();
  await page.getByRole("button", { name: "表单", exact: true }).click();
  await expect(page.locator(".interactive-form")).toContainText("12");
  await page.getByRole("button", { name: "报告", exact: true }).click();
  await expect(page.locator(".interactive-report")).toContainText("均值 12");
  await page
    .locator(".interactive-artifact")
    .screenshot({ path: "test-results/interactive-report.png" });
  await page.reload();
  await expect(page.locator(".object-toolbar")).toContainText("v2");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel(/^名称 /).fill("修订名称");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page.getByLabel("查看版本").selectOption("2");
  await expect(page.locator(".interactive-table")).toContainText(
    "<script>window.compromised=true</script>",
  );
});
