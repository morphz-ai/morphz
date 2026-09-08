import { test, expect, type Page } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";

async function newProject(page: Page, title: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByLabel("项目对话", { exact: true })).toHaveText(
    "默认对话",
  );
}
async function choose(page: Page, title: string) {
  await page.getByLabel("项目对话", { exact: true }).click();
  await page
    .getByRole("button", { name: `打开对话：${title}`, exact: true })
    .click();
}
test("首位固定对话独立于工作台，草稿与历史可恢复且没有全局新建入口", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("button").first()).toHaveText("对话");
  await page.getByLabel("AI 输入内容").fill("未发送的工作台草稿");
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page).toHaveTitle("对话 — Morphz");
  await expect(page.getByRole("region", { name: "当前对话" })).toBeVisible();
  const box = await openInput(page);
  await expect(box).toHaveValue("");
  await box.fill("全局讨论，独立保存");
  await box.press("Enter");
  await expect(page.getByRole("log", { name: "对话消息" })).toContainText(
    "全局讨论，独立保存",
  );
  await box.fill("全局待发送草稿");
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(await openInput(page)).toHaveValue("未发送的工作台草稿");
  // The workbench may already contain its own history; global messages must
  // remain in the global conversation rather than leaking into that history.
  await expect(
    page.locator(".human-message").filter({ hasText: "全局讨论，独立保存" }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await page.reload();
  await expect(await openInput(page)).toHaveValue("全局待发送草稿");
  await expect(
    page.getByRole("button", { name: /新建.*对话|新对话/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText("全局讨论，独立保存");
  await page.screenshot({ path: "test-results/global-dialogue.png" });
});

test("项目多对话：不切应用，独立草稿、引用和消息，重命名、归档、恢复及重启", async ({
  page,
}) => {
  await page.goto("/");
  await newProject(page, "多对话界面验收");
  await openLibrary(page);
  const app = page.getByRole("button", { name: "关闭应用 资料", exact: true });
  let box = await openInput(page);
  await box.fill("默认记录");
  await box.press("Enter");
  await box.fill("默认未发送草稿");
  await page.getByLabel("项目对话", { exact: true }).click();
  await page.getByLabel("新建项目对话").click();
  await expect(page.getByLabel("项目对话", { exact: true })).toHaveText(
    "对话 2",
  );
  await expect(app).toBeVisible();
  box = await openInput(page);
  await expect(box).toHaveValue("");
  await expect(page.getByRole("log")).toHaveCount(0);
  await box.fill("第二条记录");
  await box.press("Enter");
  await box.fill("第二条未发送草稿");
  await choose(page, "默认对话");
  await expect(await openInput(page)).toHaveValue("默认未发送草稿");
  await expect(page.getByRole("log")).toContainText("默认记录");
  await expect(page.getByRole("log")).not.toContainText("第二条记录");
  await choose(page, "对话 2");
  await expect(await openInput(page)).toHaveValue("第二条未发送草稿");
  await page.getByLabel("项目对话", { exact: true }).click();
  await page.getByLabel("重命名：对话 2").click();
  await page.getByLabel("对话名称", { exact: true }).fill("架构讨论");
  await page.getByLabel("保存对话名称").click();
  await expect(page.getByLabel("项目对话", { exact: true })).toHaveText(
    "架构讨论",
  );
  await page.getByLabel("归档：架构讨论").click();
  await expect(page.getByLabel("AI 输入内容")).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText("第二条记录");
  await expect(app).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "恢复对话", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复对话", exact: true }).click();
  await expect(await openInput(page)).toHaveValue("第二条未发送草稿");
  await page.getByLabel("项目对话", { exact: true }).click();
  await expect(page.getByLabel("归档：默认对话")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/project-conversations-dark.png",
  });
  await page.keyboard.press("Escape");
  for (const width of [1440, 1000, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByLabel("项目对话", { exact: true }).click();
    const bounds = (await page.getByLabel("项目对话列表").boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
  }
});

test("迟到回复与执行记录按对话归属，不挤入当前对话", async ({ page }) => {
  await page.goto("/");
  await newProject(page, "迟到回复验收");
  const boot = await (await page.request.get("/api/workspace")).json();
  const p = boot.workspace.projects.find(
    (p: any) => p.title === "迟到回复验收",
  ).id;
  let c = "";
  let messages: any[] = [];
  await page.route("**/api/workspace", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        runtime: {
          ...data.runtime,
          configured: true,
          connected: true,
          messages,
        },
      },
    });
  });
  await page.getByLabel("项目对话", { exact: true }).click();
  await page.getByLabel("新建项目对话").click();
  // The database commit precedes the client refresh and onSelect callback.
  // Reload only once the new conversation is actually selected in the UI.
  await expect(page.getByLabel("项目对话", { exact: true })).toHaveText(
    "对话 2",
  );
  const next = await (await page.request.get("/api/workspace")).json();
  c = next.workspace.conversations.find(
    (x: any) => x.projectId === p && x.id !== p,
  ).id;
  await openInput(page);
  messages = [
    {
      id: "delayed-fixture",
      projectId: p,
      conversationId: p,
      artifactId: null,
      text: "默认对话的迟到回复",
      createdAt: new Date().toISOString(),
      kind: "reply",
    },
  ];
  await page.reload();
  await expect(page.getByLabel("项目对话", { exact: true })).toHaveText(
    "对话 2",
  );
  await openInput(page);
  await expect(page.getByRole("log")).toHaveCount(0);
  await choose(page, "默认对话");
  await expect(page.getByRole("log")).toContainText("默认对话的迟到回复");
  await choose(page, "对话 2");
  await openInput(page);
  let scope = "";
  await page.route("**/api/executions?*", async (route) => {
    scope =
      new URL(route.request().url()).searchParams.get("conversationId") ?? "";
    await route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } });
  });
  await composerAction(page, "执行记录与审批");
  await expect.poll(() => scope).toBe(c);
});

test("对象引用随对话草稿保存，切换不会把选区带到另一条对话", async ({
  page,
}) => {
  await page.goto("/");
  await newProject(page, "引用归属验收");
  await openLibrary(page);
  await page.getByRole("button", { name: "自己写文档", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("跨对话引用原文");
  await page
    .getByLabel("新文档正文")
    .fill("上下文事务维护当前认知，保留可追溯的历史。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("项目对话", { exact: true }).click();
  await page.getByLabel("新建项目对话").click();
  await page.getByRole("button", { name: "搜索工作空间", exact: true }).click();
  await page.getByLabel("全文搜索").fill("可追溯的历史");
  await page.getByLabel("搜索项目范围").selectOption({ label: "引用归属验收" });
  await page.getByRole("button", { name: "引用并提问", exact: true }).click();
  await expect(page.locator(".selection-quote")).toContainText("可追溯的历史");
  await page.getByLabel("AI 输入内容").fill("解释这段引用，尚未发送");
  await choose(page, "默认对话");
  await openInput(page);
  await expect(page.locator(".selection-quote")).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await expect(page.locator(".object-paper > h1")).toHaveText("跨对话引用原文");
  await choose(page, "对话 2");
  await page.reload();
  await openInput(page);
  await expect(page.locator(".selection-quote")).toContainText("可追溯的历史");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "解释这段引用，尚未发送",
  );
  await page.getByLabel("AI 输入内容").press("Enter");
  const boot = await (await page.request.get("/api/workspace")).json();
  const sent = boot.workspace.inputs.find(
    (i: any) => i.body === "解释这段引用，尚未发送",
  );
  const c = boot.workspace.conversations.find(
    (c: any) => c.projectId === sent.projectId && c.title === "对话 2",
  );
  expect(sent.conversationId).toBe(c.id);
  expect(sent.artifactRevision).toBe(1);
  expect(sent.selection).toContain("可追溯的历史");
});
