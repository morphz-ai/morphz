import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";

test("新存储中的剧本条目可从消息交付直达，返回后保留对话草稿", async ({
  page,
}) => {
  const title = `TEST 交付剧本 ${randomUUID().slice(0, 8)}`;
  const episodeTitle = `TEST 第一集 ${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  const manualCreate = page.getByRole("button", { name: "手动新建剧本" });
  const scriptOptions = page.getByRole("button", {
    name: "剧本选项",
    exact: true,
  });
  await expect(manualCreate.or(scriptOptions).first()).toBeVisible();
  if (!(await manualCreate.isVisible())) await scriptOptions.click();
  await manualCreate.click();
  const create = page.getByRole("dialog", { name: "手动新建剧本" });
  await create.getByLabel("剧本名称").fill(title);
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByLabel("当前剧本")).toContainText(title);
  await page
    .getByRole("region", { name: "创作入口" })
    .getByRole("button", { name: "新建一集" })
    .click();
  const itemDialog = page.getByRole("dialog", { name: "新建一集" });
  await itemDialog.getByLabel("条目标题").fill(episodeTitle);
  await itemDialog.getByRole("button", { name: "创建条目" }).click();
  await expect(itemDialog).not.toBeVisible();

  const catalog = (await (
    await page.request.get("/api/platform/content?limit=100")
  ).json()) as Array<{
    id: string;
    appId: string;
    appObjectId: string;
    projectId: string;
    title: string;
  }>;
  const entry = catalog.find(
    (item) => item.appId === "morphz.script-studio" && item.title === title,
  );
  expect(entry).toBeDefined();
  const snapshotResponse = await page.request.get(
    `/api/platform/scripts/${entry!.id}/snapshot`,
  );
  expect(snapshotResponse.ok()).toBeTruthy();
  const production = (await snapshotResponse.json()) as {
    id: string;
    items: Array<{ id: string; versions: Array<{ revision: number }> }>;
  };
  const item = production.items.find((value) => value.versions.length === 1);
  expect(item).toBeDefined();
  await page.getByRole("button", { name: "全部剧本", exact: true }).click();
  await page.getByRole("button", { name: "手动新建剧本" }).click();
  const duplicate = page.getByRole("dialog", { name: "手动新建剧本" });
  await duplicate.getByLabel("剧本名称").fill(title);
  await duplicate.getByRole("button", { name: "创建", exact: true }).click();
  const duplicateCatalog = (await (
    await page.request.get("/api/platform/content?limit=100")
  ).json()) as typeof catalog;
  expect(
    duplicateCatalog.filter(
      (value) =>
        value.appId === "morphz.script-studio" && value.title === title,
    ),
  ).toHaveLength(2);
  const identity = (await (
    await page.request.get("/api/platform/bootstrap")
  ).json()) as { principalId: string; actantId: string };
  const inputId = randomUUID();
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch();
      const navigation = await response.json();
      await route.fulfill({
        response,
        json: {
          ...navigation,
          runtime: { ...navigation.runtime, configured: true },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
    async (route) => {
      const match = new URL(route.request().url()).pathname.match(
        /\/projects\/([^/]+)\/conversations\/([^/]+)\/history$/,
      );
      if (!match) throw new Error("Expected Platform history request");
      await route.fulfill({
        json: {
          inputs: [
            {
              id: inputId,
              projectId: match[1],
              conversationId: match[2],
              author: identity,
              targetActantId: "morphz-agent",
              body: "TEST 请写第一集",
              createdAt: "2026-09-28T00:00:00.000Z",
            },
          ],
          scriptOutputs: [
            {
              commandId: "fixture-script-item",
              inputId,
              projectId: entry!.projectId,
              productionId: production.id,
              kind: "item",
              itemId: item!.id,
              productionTitle: title,
              itemKind: "episode",
              isEmpty: true,
              revision: 1,
              title: episodeTitle,
              createdAt: "2026-09-28T00:00:01.000Z",
            },
          ],
          nextCursor: null,
          runtime: { ...disconnectedRuntime, configured: true },
        },
      });
    },
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 返回后仍保留的草稿");
  const delivered = page.getByRole("button", {
    name: `打开剧本结果：${episodeTitle}`,
  });
  await expect(delivered).toBeEnabled();
  await delivered.click();
  const editor = page.getByLabel("剧本正文", { exact: true });
  await expect(editor).toBeVisible();
  await editor.fill("TEST 后来保存的第二版");
  await page.getByRole("button", { name: "保存文稿" }).click();
  await expect(page.locator(".script-edit-status")).toContainText("v2");
  await page.getByRole("button", { name: "返回上一位置" }).click();
  await expect(input).toHaveValue("TEST 返回后仍保留的草稿");
  await page.reload();
  await expect(input).toHaveValue("TEST 返回后仍保留的草稿");
  await page
    .getByRole("button", {
      name: `打开剧本结果：${episodeTitle}`,
    })
    .click();
  await expect(page.getByRole("tab", { name: /^版本/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("combobox", { name: "查看版本" })).toHaveValue(
    "1",
  );
});
