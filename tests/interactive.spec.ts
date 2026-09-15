import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedCenter } from "./center-fixtures.js";
test("表格录入、逐条记录与统计保留对象版本", async ({ page }) => {
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
  await page.getByRole("button", { name: "记录", exact: true }).click();
  await expect(page.locator(".interactive-form")).toContainText("12");
  await page.getByRole("button", { name: "统计", exact: true }).click();
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

test("旧三种布局仍为同一表格类型，切换查看不改写数据、标题或历史", async ({
  page,
}) => {
  await page.goto("/");
  const prefix = "旧表格兼容" + randomUUID();
  const ids: string[] = [];
  for (const layout of ["table", "form", "report"] as const) {
    ids.push(
      await seedCenter(page, {
        type: "create-artifact",
        projectId: "first-project",
        title: prefix + { table: "表格", form: "表单", report: "报告" }[layout],
        content: {
          ...structuredClone(emptyInteractive),
          layout,
          rows: [
            { id: "r1", cells: { name: "甲", value: 12, done: true } },
            { id: "r2", cells: { name: "乙", value: 8, done: false } },
          ],
        },
      }),
    );
  }
  const before = (
    await (await page.request.get("/api/workspace")).json()
  ).workspace.artifacts.filter((a: { id: string }) => ids.includes(a.id));
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page.getByLabel("搜索内容", { exact: true }).fill(prefix);
  await page
    .getByRole("group", { name: "内容类型" })
    .getByRole("button", { name: "表格", exact: true })
    .click();
  for (const view of ["列表视图", "卡片视图"]) {
    await page.getByLabel(view, { exact: true }).click();
    await expect(page.locator(".artifact-card")).toHaveCount(3);
    await expect(
      page.locator(".artifact-caption > span:first-child"),
    ).toHaveText(["我的项目 · 表格", "我的项目 · 表格", "我的项目 · 表格"]);
  }
  await page
    .getByLabel("打开内容：" + prefix + "报告", { exact: true })
    .click();
  const views = page.getByRole("group", { name: "表格视图" });
  await expect(views.getByRole("button")).toHaveText(["表格", "记录", "统计"]);
  await expect(
    views.getByRole("button", { name: "统计", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".interactive-report")).toContainText("均值 10");
  await views.getByRole("button", { name: "记录", exact: true }).click();
  await page.getByLabel("选择记录", { exact: true }).selectOption("r2");
  await expect(page.locator(".interactive-form")).toContainText("乙");
  await views.getByRole("button", { name: "表格", exact: true }).click();
  await expect(page.locator(".interactive-table")).toContainText("甲");
  await page.reload();
  await expect(
    views.getByRole("button", { name: "统计", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const after = (
    await (await page.request.get("/api/workspace")).json()
  ).workspace.artifacts.filter((a: { id: string }) => ids.includes(a.id));
  expect(after).toEqual(before);
});
