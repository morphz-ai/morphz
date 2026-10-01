import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openInput } from "./interaction-helpers.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

async function openProjectDocument(page: Page) {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const title = `TEST 应用导航 ${randomUUID().slice(0, 8)}`;
  const projectId = `navigation_${randomUUID().replaceAll("-", "")}`;
  await source.createProject(title, randomUUID(), projectId);
  await source.createDocument({
    commandId: randomUUID(),
    objectId: `document_${randomUUID().replaceAll("-", "")}`,
    projectId,
    title: title + "文档",
    markdown: "保留原文与草稿。",
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "查看项目内容", exact: true }).click();
  await page.getByLabel("打开内容：" + title + "文档", { exact: true }).click();
  const document = page.locator(".object-paper > h1");
  await expect(document).toHaveText(title + "文档");
  await (await openInput(page)).fill("TEST 导航期间保留的草稿");
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  return { title, document };
}

for (const operation of ["close", "launch"] as const) {
  test(`${operation === "close" ? "关闭" : "启动"}应用的迟到回执不覆盖后来打开的文档`, async ({
    page,
  }) => {
    const { title, document } = await openProjectDocument(page);
    let release!: () => void, committed!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let captured = false;
    const responsePath = `/api/platform/app-views/${operation}`;
    await page.route(`**${responsePath}`, async (route) => {
      if (captured) return route.continue();
      captured = true;
      const response = await route.fetch();
      committed();
      await held;
      await route.fulfill({ response });
    });
    try {
      if (operation === "close") {
        await page
          .getByRole("button", { name: "关闭应用 内容", exact: true })
          .click();
        await ready;
        await page
          .getByRole("button", { name: "应用启动台", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: "继续打开：" + title + "文档",
            exact: true,
          })
          .click();
      } else {
        await page
          .getByRole("button", { name: "应用启动台", exact: true })
          .click();
        await page
          .getByRole("button", { name: "阅读 1.0.0", exact: true })
          .click();
        await ready;
        await page.getByRole("tab", { name: "内容", exact: true }).click();
      }
      const response = page.waitForResponse((r) =>
        r.url().endsWith(responsePath),
      );
      release();
      await response;
      await expect(document).toHaveText(title + "文档");
      // Let the post-mutation read settle; a later callback must still leave
      // the explicitly opened document selected.
      await expect(
        page.getByRole("button", { name: "应用启动台" }),
      ).not.toHaveAttribute("aria-pressed", "true");
      await expect(await openInput(page)).toHaveValue(
        "TEST 导航期间保留的草稿",
      );
    } finally {
      release();
    }
  });
}
