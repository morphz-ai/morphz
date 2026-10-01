import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

test("历史前进后退按 ID 核对目录；内容移动后仍打开同一原件", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `navigation_${suffix}`;
  const otherProjectId = `navigation_other_${suffix}`;
  const firstId = `first_${suffix}`;
  const secondId = `second_${suffix}`;
  const firstTitle = `历史首项${suffix}`;
  const secondTitle = `历史次项${suffix}`;
  await source.createProject(firstTitle, randomUUID(), projectId);
  await source.createProject(secondTitle, randomUUID(), otherProjectId);
  await source.createDocument({
    commandId: randomUUID(),
    objectId: secondId,
    projectId,
    title: secondTitle,
    markdown: "第二项正文",
  });
  const second = await source.resolveContent({
    appId: "morphz.objects",
    appObjectId: secondId,
  });
  await source.createDocument({
    commandId: randomUUID(),
    objectId: firstId,
    projectId,
    title: firstTitle,
    markdown: `[打开第二项](artifact:${second.id})\n\n第一项正文`,
  });
  const first = await source.resolveContent({
    appId: "morphz.objects",
    appObjectId: firstId,
  });
  const authorizedReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/platform/content/${first.id}`)
      authorizedReads.push(request.url());
  });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page.getByRole("button", { name: `打开内容：${firstTitle}` }).click();
  await expect(page.locator(".document-body")).toContainText("第一项正文");
  await page.getByRole("button", { name: "打开第二项" }).click();
  await expect(page.locator(".document-body")).toContainText("第二项正文");
  const readsBeforeBack = authorizedReads.length;

  await page.getByRole("button", { name: "返回上一位置" }).click();
  await expect(page.locator(".document-body")).toContainText("第一项正文");
  expect(authorizedReads.length).toBeGreaterThan(readsBeforeBack);
  await page.getByRole("button", { name: "前往下一位置" }).click();
  await expect(page.locator(".document-body")).toContainText("第二项正文");

  await source.moveContent({
    commandId: randomUUID(),
    contentId: first.id,
    targetProjectId: otherProjectId,
    expectedRevision: first.revision,
  });
  await page.getByRole("button", { name: "返回上一位置" }).click();
  await expect(page.locator(".document-body")).toContainText("第一项正文");
  await expect(page.getByRole("heading", { name: firstTitle })).toBeVisible();
  await page.getByRole("button", { name: "前往下一位置" }).click();
  await expect(page.locator(".document-body")).toContainText("第二项正文");
});
