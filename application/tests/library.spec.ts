import { test, expect } from "@playwright/test";
import { seedLegacyDocument } from "./center-fixtures.js";
import { openLibrary } from "./application-helpers.js";

test("旧导入副本仍可阅读、引用和打开历史版本，但不再进入成果搜索", async ({
  page,
}) => {
  await page.goto("/");
  const name = "旧资料验证-" + Date.now();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const boot = await (await page.request.get("/api/workspace")).json();
  const project = boot.workspace.projects.find(
    (p: { title: string }) => p.title === name,
  );
  await seedLegacyDocument(
    page,
    project.id,
    "产品说明.md",
    "# 产品说明\n\n只有正文出现的测试短语：蝴蝶资料检索。\n\n这是可引用的原文。",
  );
  await openLibrary(page);
  await page.locator(".artifact-card").filter({ hasText: "产品说明" }).click();
  await expect(page.locator(".source-strip")).toContainText("产品说明.md");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await page.getByLabel("全文搜索").fill("蝴蝶资料检索");
  await page.getByLabel("搜索项目范围").selectOption({ label: name });
  await expect(
    page
      .getByRole("dialog", { name: "搜索资料" })
      .getByText("没有找到匹配内容"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .locator(".document-body p")
    .filter({ hasText: "蝴蝶资料检索" })
    .click({ clickCount: 3 });
  await page
    .getByRole("button", { name: "围绕选中文本输入", exact: true })
    .click();
  await expect(page.locator(".selection-quote")).toContainText("蝴蝶资料检索");
  await page.getByLabel("AI 输入内容").fill("请解释这段资料");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const after = await (await page.request.get("/api/workspace")).json();
  const input = after.workspace.inputs.find(
    (i: { body: string }) => i.body === "请解释这段资料",
  );
  expect(input.artifactRevision).toBe(1);
  expect(input.selection).toContain("蝴蝶资料检索");
  await page.reload();
  await expect(page.locator(".document-body")).toContainText("蝴蝶资料检索");
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await expect(page.getByLabel("查看版本")).toHaveValue("1");
});
