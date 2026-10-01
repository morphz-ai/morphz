import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("剧本设置项目沿 Platform 目录移动同一应用原件，刷新后仍能打开", async ({
  page,
}) => {
  const title = `TEST 剧本归属 ${randomUUID().slice(0, 8)}`;
  const projectTitle = `TEST 剧本项目 ${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  await page.getByRole("button", { name: "手动新建剧本" }).click();
  const create = page.getByRole("dialog", { name: "手动新建剧本" });
  await create.getByLabel("剧本名称").fill(title);
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByLabel("当前剧本")).toContainText(title);

  const entries = async () => {
    const response = await page.request.get("/api/platform/content?limit=100");
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as Array<{
      id: string;
      appId: string;
      appObjectId: string;
      projectId: string;
      title: string;
    }>;
  };
  const before = (await entries()).find(
    (entry) => entry.appId === "morphz.script-studio" && entry.title === title,
  );
  expect(before).toBeDefined();

  await page.getByRole("button", { name: "设置项目", exact: true }).click();
  const move = page.getByRole("dialog", { name: "设置项目", exact: true });
  await move.getByLabel("目标项目").selectOption("new");
  await move.getByLabel("新项目名称").fill(projectTitle);
  await move.getByRole("button", { name: "保存", exact: true }).click();
  await expect(move).not.toBeVisible();
  await expect(page.locator(".script-project")).toHaveText(projectTitle);

  const after = (await entries()).filter((entry) => entry.id === before!.id);
  expect(after).toHaveLength(1);
  expect(after[0]!.appObjectId).toBe(before!.appObjectId);
  expect(after[0]!.projectId).not.toBe(before!.projectId);

  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const recent = page.getByRole("list", { name: "最近打开的内容" });
  const continued = recent.getByRole("button", { name: `继续打开：${title}` });
  await expect(continued).toBeVisible();
  await expect(continued.locator(".workspace-recent-meta")).toContainText(
    "剧本",
  );
  await continued.click();
  await expect(page.getByLabel("当前剧本")).toContainText(title);
  await expect(page.locator(".script-project")).toHaveText(projectTitle);
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  await page.getByRole("button", { name: `打开剧本：${title}` }).click();
  await expect(page.getByLabel("当前剧本")).toContainText(title);
  await expect(page.locator(".script-project")).toHaveText(projectTitle);
});
