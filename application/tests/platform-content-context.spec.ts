import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { openInput } from "./interaction-helpers.js";

test("从内容继续交流只切换输入上下文，不发送消息或覆盖目录草稿", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `context_${suffix}`;
  const title = `TEST 内容交流 ${suffix}`;
  await source.createProject(
    `TEST 内容交流项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  const created = (await source.createDocument({
    commandId: randomUUID(),
    objectId: `document_${suffix}`,
    projectId,
    title,
    markdown: `真实原文 ${suffix}`,
  })) as { contentId: string };
  const beforeDeliveries = (
    await source.navigationRuntime()
  ).runtime.deliveries.map((delivery) => delivery.inputId);

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  const catalogInput = await openInput(page);
  await catalogInput.fill(`目录未发送草稿 ${suffix}`);
  await page.getByRole("textbox", { name: "搜索内容" }).fill(title);
  await page.getByRole("button", { name: `让智能体处理：${title}` }).click();
  await expect(page.locator(".document-body")).toContainText(suffix);
  const objectInput = page.getByRole("textbox", { name: "AI 输入内容" });
  await expect(objectInput).toBeFocused();
  await expect(objectInput).toHaveValue("");
  await expect(page.locator(".composer .context-chip")).toContainText(title);
  await objectInput.fill(`对象未发送草稿 ${suffix}`);

  await page
    .locator(".breadcrumb")
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await expect(await openInput(page)).toHaveValue(`目录未发送草稿 ${suffix}`);
  await page.getByRole("button", { name: `让智能体处理：${title}` }).click();
  await expect(objectInput).toHaveValue(`对象未发送草稿 ${suffix}`);
  expect(
    (await source.navigationRuntime()).runtime.deliveries.map(
      (delivery) => delivery.inputId,
    ),
  ).toEqual(beforeDeliveries);
  await expect(source.readDocument(created.contentId)).resolves.toMatchObject({
    markdown: `真实原文 ${suffix}`,
    revision: 1,
  });
});
