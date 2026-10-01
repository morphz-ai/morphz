import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openInput } from "./interaction-helpers.js";

function seedExistingNamedConversation(projectTitle: string) {
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  ) as { directory: string };
  const db = new DatabaseSync(join(directory, "platform.sqlite"));
  try {
    const project = db
      .prepare("SELECT tenant_id,project_id FROM projects WHERE title=?")
      .get(projectTitle) as
      | {
          tenant_id: string;
          project_id: string;
        }
      | undefined;
    if (!project) throw new Error("测试项目未保存到 Platform");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO conversations(tenant_id,conversation_id,project_id,kind,title,revision,created_at,updated_at) VALUES(?,?,?,'named',?,1,?,?)",
    ).run(
      project.tenant_id,
      randomUUID(),
      project.project_id,
      "对话 1",
      now,
      now,
    );
  } finally {
    db.close();
  }
}
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
  await expect(
    page
      .getByRole("group", { name: "项目操作", exact: true })
      .getByRole("button"),
  ).toHaveText(["重命名", "归档", "删除"]);
  await page
    .getByRole("group", { name: "项目操作", exact: true })
    .getByRole("button", { name: action + "：" + title, exact: true })
    .click();
}

test("项目空态明确筛选范围，可清除搜索或返回使用中，刷新不偷改筛选", async ({
  page,
}) => {
  await page.goto("/");
  const title = "TEST 筛选边界 " + Date.now();
  await create(page, title);
  await directory(page);
  await page.getByLabel("项目排序").selectOption("name");
  await page.getByLabel("项目范围", { exact: true }).selectOption("deleted");
  await page.getByLabel("搜索项目", { exact: true }).fill(title);
  await page.reload();
  await expect(page.getByLabel("项目范围", { exact: true })).toHaveValue(
    "deleted",
  );
  await expect(page.locator(".project-scope-count")).toHaveText(
    "已删除 · 0 项",
  );
  await expect(
    page.getByRole("heading", { name: "在已删除项目中未找到结果" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(page.getByLabel("搜索项目", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("搜索项目", { exact: true })).toBeFocused();
  await expect(page.getByLabel("项目范围", { exact: true })).toHaveValue(
    "deleted",
  );
  await page.getByLabel("搜索项目", { exact: true }).fill(title);
  await page
    .getByRole("button", { name: "查看使用中的项目", exact: true })
    .click();
  await expect(page.getByLabel("项目范围", { exact: true })).toHaveValue(
    "active",
  );
  await expect(page.getByLabel("搜索项目", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("项目排序")).toHaveValue("name");
  await expect(page.getByLabel("搜索项目", { exact: true })).toBeFocused();
  await expect(
    page.getByLabel("打开项目：" + title, { exact: true }),
  ).toBeVisible();
});

test("项目管理：改名同步两处，目录往返保留；Runtime 不可达时归档不改状态", async ({
  page,
}) => {
  await page.goto("/");
  const title = "TEST 项目管理 " + Date.now();
  await create(page, title);
  await menu(page, title, "重命名项目");
  await expect(
    page.getByRole("dialog", { name: "重命名项目", exact: true }),
  ).toBeVisible();
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
  await expect(
    page
      .locator(".project-card")
      .getByRole("group", { name: "项目操作", exact: true })
      .getByRole("button"),
  ).toHaveText(["重命名", "归档", "删除"]);
  await page
    .getByRole("button", { name: "归档项目：" + renamed, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "归档项目", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Runtime 暂不可用，项目没有归档或删除",
  );
  await expect(
    page.getByRole("group", { name: renamed + "的会话", exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  await page.reload();
  await directory(page);
  await expect(
    page.getByLabel("打开项目：" + renamed, { exact: true }),
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
  await expect(page.getByRole("log", { name: "对话消息" })).toContainText(
    "已保存 · 未发送",
  );
  await expect(group.getByLabel("继续草稿：对话 1")).toBeVisible();
  // This isolated UI fixture has no Runtime. Seed an existing navigation
  // record to test archive/restore separately from first-input delivery.
  seedExistingNamedConversation(title);
  await page.reload();
  await expect(
    group.getByLabel("打开对话：对话 1", { exact: true }),
  ).toBeVisible();
  await group.getByLabel("对话操作：对话 1").click();
  await page.getByLabel("归档：对话 1", { exact: true }).click();
  await expect(
    group.getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveCount(0);
  await expect(
    group.getByRole("button", { name: "已归档 · 1", exact: true }),
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
  await menu(page, title, "删除项目");
  await expect(
    page.getByRole("dialog", { name: "删除项目", exact: true }),
  ).toContainText("1 个会话");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
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
  await page.route("**/api/platform/projects", (route) =>
    route.fulfill({ status: 409, json: { message: "测试：项目已发生变化" } }),
  );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("项目已发生变化");
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(
    "失败保留",
  );
  await page.keyboard.press("Escape");
});
