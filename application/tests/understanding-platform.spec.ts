import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  isolatedCenterDirectory,
  seedAgentOriginal,
} from "./platform-agent-original-fixture.js";
import { seedProjectUnderstanding } from "./platform-understanding-fixture.js";

test("当前理解从正式项目视图读取，来源回到原件精确版本", async ({ page }) => {
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

  await page.goto("/");
  await page.setViewportSize({ width: 760, height: 540 });
  await page.getByRole("button", { name: projectTitle, exact: true }).click();
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "当前理解",
    exact: true,
  });
  await expect(panel).toContainText("核对事实，再继续工作。");
  await expect(panel).toContainText("v1");
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(760);
  await panel.getByRole("button", { name: "纠正或补充" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    /需要纠正或补充的内容/,
  );
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await panel.getByText("参考内容 · 1").click();
  await panel.getByRole("button", { name: /来源文档/ }).click();
  await expect(page.locator(".object-paper")).toContainText(
    "这是可核验的原件正文。",
  );
  await expect(page.locator(".object-paper")).not.toContainText(
    "这是修订后的第二版",
  );
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await panel.getByRole("button", { name: "更新理解" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
});
