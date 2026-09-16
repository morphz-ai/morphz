import { test, expect, type Page } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";
async function create(page: Page, title: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function directory(page: Page) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
}
async function menu(page: Page, title: string, action: string) {
  await page
    .getByRole("group", { name: title + "的会话", exact: true })
    .getByLabel("项目操作：" + title, { exact: true })
    .click();
  await page
    .getByRole("group", { name: "项目操作", exact: true })
    .getByRole("button", { name: action + "：" + title, exact: true })
    .click();
}

test("项目统一管理：改名同步两处，归档与删除可恢复，目录查找与排序往返保留", async ({
  page,
}) => {
  await page.goto("/");
  const title = "TEST 项目管理 " + Date.now();
  await create(page, title);
  await menu(page, title, "重命名项目");
  await page.getByLabel("项目名称", { exact: true }).fill(title + " 已改名");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const renamed = title + " 已改名";
  await expect(
    page.getByRole("group", { name: renamed + "的会话", exact: true }),
  ).toBeVisible();
  await directory(page);
  await page.getByLabel("搜索项目", { exact: true }).fill(renamed);
  await page.getByLabel("项目排序").selectOption("name");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page.getByLabel("打开项目：" + renamed, { exact: true }).click();
  await page.getByLabel("返回上一位置", { exact: true }).click();
  await expect(page.getByLabel("搜索项目", { exact: true })).toHaveValue(
    renamed,
  );
  await expect(page.getByLabel("项目排序")).toHaveValue("name");
  await page
    .locator(".project-card")
    .getByLabel("项目操作：" + renamed, { exact: true })
    .click();
  await page
    .getByRole("button", { name: "归档项目：" + renamed, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "归档项目", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: renamed + "的会话", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".project-card")).toHaveCount(0);
  await page.getByLabel("项目范围").selectOption("archived");
  await expect(
    page.getByLabel("打开项目：" + renamed, { exact: true }),
  ).toBeVisible();
  await page
    .locator(".project-card")
    .getByLabel("项目操作：" + renamed, { exact: true })
    .click();
  await page
    .getByRole("button", { name: "删除项目：" + renamed, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除项目", exact: true })
    .click();
  await page.getByLabel("项目范围").selectOption("deleted");
  await page.reload();
  await expect(page.getByLabel("项目范围")).toHaveValue("deleted");
  await page
    .locator(".project-card")
    .getByLabel("项目操作：" + renamed, { exact: true })
    .click();
  await page
    .getByRole("button", { name: "恢复项目：" + renamed, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "恢复项目", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: renamed + "的会话", exact: true }),
  ).toBeVisible();
});

test("未发送草稿可丢弃与恢复，不创建空会话，不丢正文；归档会话独立分组", async ({
  page,
}) => {
  await page.goto("/");
  const title = "TEST 会话整理 " + Date.now();
  await create(page, title);
  const group = page.getByRole("group", {
    name: title + "的会话",
    exact: true,
  });
  await group.getByLabel("新建项目对话：" + title).click();
  await (await openInput(page)).fill("保留这份未发送草稿");
  await group.getByLabel("草稿操作：对话 1").click();
  await page.getByLabel("丢弃草稿：对话 1").click();
  await expect(group.getByLabel("继续草稿：对话 1")).toHaveCount(0);
  await page.reload();
  await group
    .getByRole("button", { name: "已丢弃草稿 · 1", exact: true })
    .click();
  await group.getByLabel("恢复草稿：对话 1").click();
  await expect(await openInput(page)).toHaveValue("保留这份未发送草稿");
  await (await openInput(page)).press("Enter");
  await expect(
    group.getByLabel("打开对话：对话 1", { exact: true }),
  ).toBeVisible();
  await group.getByLabel("对话操作：对话 1").click();
  await page.getByLabel("归档：对话 1", { exact: true }).click();
  await expect(
    group.getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "恢复对话", exact: true }),
  ).toBeVisible();
  await group.getByRole("button", { name: "已归档 · 1", exact: true }).click();
  await expect(
    group
      .locator(".archived-conversation-group")
      .getByLabel("打开对话：对话 1", { exact: true }),
  ).toBeVisible();
  await group.getByLabel("对话操作：对话 1").click();
  await page.getByLabel("恢复：对话 1", { exact: true }).click();
  await expect(
    group
      .locator(".archived-conversation-group")
      .getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveCount(0);
  await expect(
    group.getByLabel("打开对话：对话 1", { exact: true }),
  ).toBeVisible();
});

test("短项目弹窗与错误保留：名称旁确认，键盘取消，窄窗不越界", async ({
  page,
}) => {
  await page.goto("/");
  await directory(page);
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 650 });
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await expect(page.getByLabel("项目名称", { exact: true })).toBeFocused();
    await page.getByLabel("项目名称", { exact: true }).fill("新建项目错误验收");
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(420);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.height).toBeLessThan(190);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("失败保留");
  await page.route("**/api/commands", (route) =>
    route.fulfill({ status: 409, json: { message: "测试：项目已发生变化" } }),
  );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("项目已发生变化");
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(
    "失败保留",
  );
  await page.keyboard.press("Escape");
});
