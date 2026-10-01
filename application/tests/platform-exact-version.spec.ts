import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";

test("历史内容位置重开后仍读取应用私库的确切版本", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = randomUUID();
  const objectId = randomUUID();
  const title = `TEST 历史原件 ${randomUUID().slice(0, 8)}`;
  await source.createProject(title, randomUUID(), projectId);
  await source.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId,
    title,
    markdown: "第一版原文",
  });
  const contentId = (
    await source.resolveContent({
      appId: "morphz.objects",
      appObjectId: objectId,
    })
  ).id;
  await source.reviseDocument({
    commandId: randomUUID(),
    contentId,
    expectedRevision: 1,
    title,
    markdown: "第二版原文",
  });
  await source.reviseDocument({
    commandId: randomUUID(),
    contentId,
    expectedRevision: 2,
    title,
    markdown: "第三版原文",
  });

  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await page.addInitScript(
    ({ centerId, principalId, projectId, contentId }) => {
      localStorage.setItem(
        `morphz:${centerId}:${principalId}:preferences`,
        JSON.stringify({
          view: "content",
          projectId,
          artifactId: contentId,
          artifactRevision: 1,
        }),
      );
    },
    {
      centerId: source.boot.centerId,
      principalId: source.boot.principalId,
      projectId,
      contentId,
    },
  );
  const exactReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/platform/objects/${contentId}`)
      exactReads.push(url.searchParams.get("revision") ?? "current");
  });
  await page.reload();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect.poll(() => exactReads, { timeout: 15000 }).toContain("1");
  await expect(page.locator(".document-body")).toContainText("第一版原文");
  await expect(page.locator(".document-body")).not.toContainText("第三版原文");
  await page.getByLabel("回到当前版本").click();
  await expect(page.locator(".document-body")).toContainText("第三版原文");
});
