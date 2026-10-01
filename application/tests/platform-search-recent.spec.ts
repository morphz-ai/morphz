import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

test("搜索面板的最近内容按项目从 Platform 有界读取", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `project_${suffix}`;
  const otherProjectId = `other_${suffix}`;
  await source.createProject(`最近内容${suffix}`, randomUUID(), projectId);
  await source.createProject(`其他项目${suffix}`, randomUUID(), otherProjectId);
  await source.createDocument({
    commandId: randomUUID(),
    objectId: `document_other_${suffix}`,
    projectId: otherProjectId,
    title: `其他项目文档 ${suffix}`,
    markdown: "只在其他项目可见",
  });
  for (let index = 0; index < 7; index++) {
    await source.createDocument({
      commandId: randomUUID(),
      objectId: `document_${suffix}_${index}`,
      projectId,
      title: `近期文档 ${index === 6 ? "第六篇" : index} ${suffix}`,
      markdown: `正文 ${index}`,
    });
  }

  await page.goto("/");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "搜索资料" });
  await dialog
    .getByRole("combobox", { name: "搜索项目范围" })
    .selectOption(projectId);
  const items = dialog.locator(".workspace-search-results .search-result-open");
  await expect(items).toHaveCount(6);
  await expect(dialog).toContainText(`近期文档 第六篇 ${suffix}`);
  await expect(dialog).not.toContainText(`近期文档 0 ${suffix}`);
  await expect(dialog.locator(".workspace-search-results")).not.toContainText(
    `其他项目文档 ${suffix}`,
  );
  const input = dialog.getByRole("textbox", { name: "全文搜索" });
  await input.fill(`第六篇 ${suffix}`);
  await expect(dialog.getByRole("status")).toHaveText("找到 1 项内容");
  await expect(dialog.locator(".workspace-search-results article")).toHaveCount(
    1,
  );
  await input.fill(`正文 6`);
  await expect(dialog.getByRole("status")).toHaveText("找到 0 项内容");
});
