import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { openInput, composerAction } from "./interaction-helpers.js";

test("工作台与项目拥有独立空间；应用恢复、对话归属和多窗口尺寸保持一致", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  for (const label of ["导航甲", "导航乙"]) {
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("新对象标题", { exact: true }).fill(label);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
    await openLibrary(page);
    await page
      .locator(".library-authoring-options")
      .getByRole("button", { name: "手动写文档", exact: true })
      .click();
    await page.getByLabel("新对象标题", { exact: true }).fill(label + "文档");
    await page.getByLabel("新文档正文").fill(label + " 的独立内容。");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator(".object-paper > h1")).toHaveText(label + "文档");
    await (await openInput(page)).fill(label + " 的对象消息");
    await page.getByRole("button", { name: "保存输入", exact: true }).click();
    await expect(page.locator(".conversation-heading")).toHaveCount(0);
    await expect(page.locator(".composer .context-chip")).toContainText(
      label + "文档",
    );
    await expect(page.getByRole("log", { name: "对话消息" })).toContainText(
      label + " 的对象消息",
    );
  }
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await openLibrary(page);
  await expect(page.getByLabel("内容范围", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "认知应用工作空间" }),
  ).not.toContainText("导航甲文档");
  await page.getByRole("button", { name: "外观设置", exact: true }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "电光青", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "280px");
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(23, 23, 23)",
  );
  await expect(page.locator(".workspace")).toHaveCSS(
    "background-color",
    "rgb(32, 32, 32)",
  );
  await page.screenshot({
    path: "test-results/workbench-dark.png",
    animations: "disabled",
  });
  const project = async (name: string) => {
    await page.locator(".project-link").filter({ hasText: name }).click();
    await openInput(page);
  };
  await project("导航甲");
  await expect(page.locator(".object-paper > h1")).toHaveText("导航甲文档");
  const conversation = () => composerAction(page, "查看交流记录");
  if (await page.getByLabel("查看交流记录").isVisible()) await conversation();
  await expect(
    page.locator(".human-message").filter({ hasText: "导航甲 的对象消息" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".human-message").filter({ hasText: "导航乙 的对象消息" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "查看全部交流", exact: true }).click();
  await expect(
    page.locator(".human-message").filter({ hasText: "导航乙 的对象消息" }),
  ).toHaveCount(1);
  await nav.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("region", { name: "项目目录" })).toBeVisible();
  await page.getByLabel("搜索项目", { exact: true }).fill("导航甲");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page.locator(".project-card").click();
  await openLibrary(page);
  await expect(page.getByLabel("内容范围", { exact: true })).toHaveCount(0);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".artifact-card")).toContainText("导航甲文档");
  await page.reload();
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await page.locator(".artifact-card").click();
  await expect(page.locator(".object-paper > h1")).toHaveText("导航甲文档");
  await openInput(page);
  await page.getByLabel("AI 输入内容").fill("甲项目未发送的草稿");
  await project("导航乙");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await page.getByLabel("AI 输入内容").fill("乙项目未发送的草稿");
  await project("导航甲");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "甲项目未发送的草稿",
  );
  for (const width of [1380, 1024, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await openInput(page);
    await expect(page.getByLabel("AI 输入内容")).toBeVisible();
    expect(
      await page
        .locator(".app")
        .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    ).toBe(false);
    await nav.getByRole("button", { name: "项目", exact: true }).click();
    await expect(page.locator(".project-directory")).toBeVisible();
    await page.screenshot({
      path: `test-results/projects-${width}.png`,
      animations: "disabled",
    });
    await nav.getByRole("button", { name: "工作台", exact: true }).click();
  }
});
