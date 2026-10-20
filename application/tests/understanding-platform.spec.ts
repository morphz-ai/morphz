import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  isolatedCenterDirectory,
  seedAgentOriginal,
} from "./platform-agent-original-fixture.js";
import { seedProjectUnderstanding } from "./platform-understanding-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";

test("已撤下的当前理解入口不恢复，正式摘要与精确来源版本仍保留", async ({ page }) => {
  const client = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const id = randomUUID().replaceAll("-", "");
  const projectId = `understanding_${id}`;
  const projectTitle = `理解验收${id.slice(0, 8)}`;
  await client.createProject(projectTitle, randomUUID(), projectId);
  const objectId = await seedAgentOriginal(
    isolatedCenterDirectory(),
    projectId,
    `来源文档${id.slice(0, 8)}`,
    "这是可核验的原件正文。",
  );
  const entries = await client.content({
    projectId,
    appId: "morphz.objects",
    appObjectIds: [objectId],
  });
  expect(entries.items).toHaveLength(1);
  const source = entries.items[0]!;
  await client.reviseDocument({
    commandId: randomUUID(),
    contentId: source.id,
    expectedRevision: 1,
    title: source.title,
    markdown: "这是修订后的第二版，不应替代引用的第一版。",
  });
  await seedProjectUnderstanding(
    client,
    projectId,
    "### 当前目标\n核对事实，再继续工作。",
    [{ contentId: source.id, versionRef: "1" }],
  );
  const understanding = await client.projectUnderstanding(projectId);
  expect(understanding).toMatchObject({
    body: "### 当前目标\n核对事实，再继续工作。",
    sources: [{ contentId: source.id, versionRef: "1" }],
  });
  const deliveries = (await client.navigationRuntime()).runtime.deliveries;
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/platform/messages")
      submissions.push(request.url());
  });

  await page.goto("/");
  await page.setViewportSize({ width: 760, height: 540 });
  await page.getByRole("button", { name: projectTitle, exact: true }).click();
  const draft = "保留项目草稿，不自动发送梳理指令";
  await (await openInput(page)).fill(draft);
  // See acf76a53 and docs/13 (2026-10-04 content catalogue regression):
  // withdrawal removes the entry, not the authorized data or its sources.
  await expect(page.getByRole("button", { name: "工作空间选项", exact: true, includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "当前理解", exact: true, includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "当前理解", exact: true, includeHidden: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 700 });
  await openLibrary(page);
  await page.getByRole("button", { name: `打开内容：${source.title}`, exact: true }).click();
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page.getByLabel("查看版本", { exact: true }).selectOption("1");
  await expect(page.locator(".object-paper")).toContainText(
    "这是可核验的原件正文。",
  );
  await expect(page.locator(".object-paper")).not.toContainText(
    "这是修订后的第二版",
  );
  await page.getByRole("button", { name: projectTitle, exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  expect(await client.projectUnderstanding(projectId)).toEqual(understanding);
  expect((await client.navigationRuntime()).runtime.deliveries).toEqual(deliveries);
  expect(submissions).toEqual([]);
});
