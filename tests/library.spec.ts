import { test, expect } from "@playwright/test";

test("导入资料、搜索正文、引用提问与旧版本打开", async ({ page }) => {
  await page.goto("/");
  const name = "资料验证-" + Date.now();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("新对象标题").fill(name);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("工作空间选项").click();
  await page.getByRole("button", { name: "资料导入与来源", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入资料" });
  await dialog.getByLabel("选择资料文件").setInputFiles([
    {
      name: "产品说明.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "# 产品说明\n\n只有正文出现的测试短语：蝴蝶资料检索。\n\n这是可引用的原文。",
      ),
    },
    {
      name: ".env",
      mimeType: "text/plain",
      buffer: Buffer.from("SECRET=test-only"),
    },
  ]);
  await expect(
    dialog.getByText("隐藏文件、依赖目录和构建产物不作为资料导入。"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "导入 1 份资料" }).click();
  await expect(dialog.getByRole("status")).toHaveText("已导入 1 份");
  await dialog.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".source-strip")).toContainText("产品说明.md");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await page.getByLabel("全文搜索").fill("蝴蝶资料检索");
  await page.getByLabel("搜索项目范围").selectOption({ label: name });
  const search = page.getByRole("dialog", { name: "搜索资料" });
  await expect(search.getByText("找到 1 项内容")).toBeVisible();
  await expect(
    search.locator(".workspace-search-results article > p"),
  ).toContainText("蝴蝶资料检索");
  await search.getByRole("button", { name: "引用并提问" }).click();
  await expect(page.locator(".selection-quote")).toContainText("蝴蝶资料检索");
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  // The selected original is carried with the exact version, not pasted into prose.
  await page.getByLabel("AI 输入内容").fill("请解释这段资料");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const workspace = await page.request
    .get("/api/workspace")
    .then((r) => r.json());
  const input = workspace.workspace.inputs.find(
    (i: { body: string }) => i.body === "请解释这段资料",
  );
  expect(input.artifactRevision).toBe(1);
  expect(input.selection).toContain("蝴蝶资料检索");
  expect(
    workspace.workspace.artifacts.some(
      (a: { title: string }) => a.title === ".env",
    ),
  ).toBe(false);
  await page.reload();
  await page.keyboard.press("Control+k");
  await page.getByLabel("全文搜索").fill("蝴蝶资料检索");
  await page.getByLabel("搜索项目范围").selectOption({ label: name });
  await page.locator(".search-result-open").click();
  await expect(page.getByLabel("查看版本")).toHaveValue("1");
});
