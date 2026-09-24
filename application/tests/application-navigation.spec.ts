import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedCenter } from "./center-fixtures.js";
import { openInput } from "./interaction-helpers.js";

async function openProjectDocument(page: Page) {
  await page.goto("/");
  const title = `TEST 应用导航 ${randomUUID().slice(0, 8)}`;
  const projectId = await seedCenter(page, { type: "create-project", title });
  await seedCenter(page, {
    type: "create-artifact",
    projectId,
    title: title + "文档",
    content: { kind: "document", markdown: "保留原文与草稿。" },
  });
  await page.reload();
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
    const matches = (op: any) =>
      operation === "close"
        ? op?.type === "close-application"
        : op?.type === "launch-application" &&
          op.applicationId === "morphz.reader";
    let captured = false;
    await page.route("**/api/commands", async (route) => {
      if (captured || !matches(route.request().postDataJSON()?.operation))
        return route.continue();
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
      await expect(document).toHaveText(title + "文档");
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/commands") &&
          matches(r.request().postDataJSON()?.operation),
      );
      release();
      await response;
      // The receipt is followed by two state refreshes. Check after another
      // complete round trip, not just before the stale callback is delivered.
      await page.waitForResponse((r) => r.url().endsWith("/api/workspace"));
      await expect
        .poll(async () => {
          await page.waitForTimeout(200);
          return document.isVisible();
        })
        .toBe(true);
      await expect(await openInput(page)).toHaveValue(
        "TEST 导航期间保留的草稿",
      );
    } finally {
      release();
    }
  });
}
