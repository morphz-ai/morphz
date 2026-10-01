import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { openLibrary } from "./application-helpers.js";

test("导入副本可阅读、引用和打开历史版本，但不进入 Agent 成果全文搜索", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `project_${suffix}`;
  const objectId = `document_${suffix}`;
  const name = `导入资料验证-${suffix}`;
  await source.createProject(name, randomUUID(), projectId);
  const imported = (await source.importDocument({
    commandId: randomUUID(),
    objectId,
    projectId,
    relativePath: "产品说明.md",
    text: "# 产品说明\n\n只有正文出现的测试短语：蝴蝶资料检索。\n\n这是可引用的原文。",
  })) as { contentId: string };
  await page.goto("/");
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
  await expect(
    page.getByRole("dialog", { name: "引用 1 的评论", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("group", { name: "选文与评论", exact: true })
      .getByRole("button", { name: "编辑引用 1 的评论", exact: true }),
  ).toHaveAttribute("title", /蝴蝶资料检索/);
  await page.getByLabel("AI 输入内容").fill("请解释这段资料");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const saved = page
    .locator(".human-message")
    .filter({ hasText: "请解释这段资料" });
  await expect(saved).toContainText("已保存 · 未发送");
  await expect(saved.locator(".sent-text-quotes")).toContainText(
    "蝴蝶资料检索",
  );
  expect((await source.getContent(imported.contentId)).projectId).toBe(
    projectId,
  );
  await page.reload();
  await expect(saved.locator(".sent-text-quotes")).toContainText(
    "蝴蝶资料检索",
  );
  await expect(page.locator(".document-body")).toContainText("蝴蝶资料检索");
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await expect(page.getByLabel("查看版本")).toHaveValue("1");
});
