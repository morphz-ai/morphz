import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

test("内容目录正文搜索恢复：首屏外产物、原文摘要、类型/项目切换和打开原件", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `body_${suffix}`,
    otherProjectId = `other_body_${suffix}`;
  await source.createProject("TEST 正文检索项目", randomUUID(), projectId);
  await source.createProject("TEST 其他检索项目", randomUUID(), otherProjectId);
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  ) as { directory: string };
  const seed = await agentDomainFixture({
    existingCenter: { directory, projectId },
  });
  const title = `TEST 首屏外正文 ${suffix}`;
  const query = `正文独特词${suffix}`;
  try {
    // Actual Agent tools, originals and index. Only accepted Runtime provenance
    // is controlled; no Human endpoint can choose an Agent origin flag.
    await seed.call({
      action: "operations",
      operations: {
        action: "invoke",
        operationId: "content.create-document",
        parameters: {
          title,
          markdown: `这是智能体原生产物。${query} 用来核对摘要。`,
        },
      },
    });
  } finally {
    await seed.close();
  }
  for (let index = 0; index < 55; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: `TEST 更近的内容 ${index} ${suffix}`,
      markdown: "普通人工内容",
    });
  // Matching Human text remains unindexed, even beside the Agent result.
  await source.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId,
    title: `TEST 人工正文 ${suffix}`,
    markdown: query,
  });
  await page.addInitScript(
    ({ centerId, principalId, projectId }) => {
      const scope = `morphz:${centerId}:${principalId}:`;
      localStorage.setItem(
        scope + "preferences",
        JSON.stringify({ view: "content" }),
      );
      localStorage.setItem(
        scope + "library-view:all-content",
        JSON.stringify({ scope: projectId, layout: "list" }),
      );
    },
    {
      centerId: source.boot.centerId,
      principalId: source.boot.principalId,
      projectId,
    },
  );
  await page.goto("/");
  const list = page.getByRole("region", { name: "全部内容" });
  const result = list.getByRole("button", { name: `打开内容：${title}` });
  await expect(list.getByRole("button", { name: /^打开内容：/ })).toHaveCount(
    50,
  );
  await expect(result).toHaveCount(0);
  await list.getByRole("textbox", { name: "搜索内容" }).fill(query);
  await expect(result).toBeVisible();
  await expect(list).toContainText("1 项内容");
  await expect(result.locator(".content-match")).toContainText(query);
  await expect(list).not.toContainText(`TEST 人工正文 ${suffix}`);
  await list.getByRole("button", { name: "卡片视图" }).click();
  await expect(result.locator(".content-match")).toContainText(query);
  await list.getByRole("button", { name: "剧本", exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(list).toContainText("0 项内容");
  await list.getByRole("button", { name: "全部", exact: true }).click();
  await expect(result).toBeVisible();
  await list
    .getByRole("combobox", { name: "内容范围" })
    .selectOption(otherProjectId);
  await expect(result).toHaveCount(0);
  await expect(list).toContainText("0 项内容");
  await list
    .getByRole("combobox", { name: "内容范围" })
    .selectOption(projectId);
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  await expect(page.locator(".document-body")).toContainText(query);
});
