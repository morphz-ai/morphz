import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("内容页添加对象关联后刷新仍可打开目标", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const sourceTitle = `TEST 关联来源 ${suffix}`;
  const targetTitle = `TEST 关联目标 ${suffix}`;
  await page.goto("/");
  const boot = (await (
    await page.request.get("/api/platform/bootstrap")
  ).json()) as {
    csrfToken: string;
  };
  const headers = {
    Origin: "http://127.0.0.1:65421",
    "X-Morphz-Token": boot.csrfToken,
  };
  const projectId = randomUUID();
  expect(
    (
      await page.request.post("/api/platform/projects", {
        headers,
        data: {
          commandId: randomUUID(),
          projectId,
          title: `TEST 关联项目 ${suffix}`,
        },
      })
    ).ok(),
  ).toBeTruthy();
  for (const [index, title] of [sourceTitle, targetTitle].entries()) {
    expect(
      (
        await page.request.post("/api/platform/documents", {
          headers,
          data: {
            commandId: randomUUID(),
            objectId: `relation_${index}_${randomUUID().replaceAll("-", "")}`,
            projectId,
            title,
            markdown: `正文 ${title}`,
          },
        })
      ).ok(),
    ).toBeTruthy();
  }
  for (let index = 0; index < 50; index++) {
    expect(
      (
        await page.request.post("/api/platform/documents", {
          headers,
          data: {
            commandId: randomUUID(),
            objectId: randomUUID(),
            projectId,
            title: `TEST 关联干扰 ${index} ${suffix}`,
            markdown: `干扰正文 ${index}`,
          },
        })
      ).ok(),
    ).toBeTruthy();
  }
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await page.getByRole("textbox", { name: "搜索内容" }).fill(sourceTitle);
  await page.getByRole("button", { name: `打开内容：${sourceTitle}` }).click();
  const relations = page.getByRole("region", { name: "关联对象" });
  await relations.getByRole("button", { name: "关联其他对象" }).click();
  await relations
    .getByRole("searchbox", { name: "查找关联对象" })
    .fill(targetTitle);
  await relations
    .getByRole("combobox", { name: "要关联的对象" })
    .selectOption({ label: targetTitle });
  await relations.getByRole("button", { name: "添加关联" }).click();
  await expect(
    relations.getByRole("button", { name: targetTitle }),
  ).toBeVisible();

  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await page.getByRole("textbox", { name: "搜索内容" }).fill(sourceTitle);
  await page.getByRole("button", { name: `打开内容：${sourceTitle}` }).click();
  await expect(
    page
      .getByRole("region", { name: "关联对象" })
      .getByRole("button", { name: targetTitle }),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "关联对象" })
    .getByRole("button", { name: targetTitle })
    .click();
  await expect(page.locator(".document-body")).toContainText(
    `正文 ${targetTitle}`,
  );
});
