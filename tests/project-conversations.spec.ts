import { test, expect, type Page } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";

test("项目行直接新建：从其他页面一击进入、失败可重试、迟到回执不抢走新导航", async ({
  page,
}) => {
  await page.goto("/");
  const initial = await (await page.request.get("/api/workspace")).json();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await (await openInput(page)).fill("保留全局草稿");
  const group = page.getByRole("group", {
    name: "我的项目的会话",
    exact: true,
  });
  const create = group.getByRole("button", {
    name: "新建项目对话：我的项目",
    exact: true,
  });
  await expect(create.locator("svg.lucide-square-pen")).toBeVisible();
  await expect(create.locator("svg.lucide-plus")).toHaveCount(0);
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON().operation.type === "create-conversation")
      await route.fulfill({
        status: 503,
        json: { message: "测试：创建暂不可用" },
      });
    else await route.continue();
  });
  await create.click();
  await expect(group.getByRole("alert")).toContainText("创建暂不可用");
  await expect(page).toHaveTitle("对话 — Morphz");
  await expect(await openInput(page)).toHaveValue("保留全局草稿");
  await page.unroute("**/api/commands");
  await create.click();
  await expect(
    group.getByLabel("打开对话：对话 2", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await expect(page.locator(".topbar .conversation-switch")).toHaveCount(0);
  const first = await (await page.request.get("/api/workspace")).json();
  expect(first.workspace.inputs).toHaveLength(initial.workspace.inputs.length);
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await expect(await openInput(page)).toHaveValue("保留全局草稿");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = false;
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON().operation.type !== "create-conversation")
      return route.continue();
    arrived = true;
    await gate;
    await route.continue();
  });
  await create.dblclick();
  await expect.poll(() => arrived).toBe(true);
  await expect(create).toBeDisabled();
  await nav.getByRole("button", { name: /^事项/ }).click();
  release();
  await expect(create).toBeEnabled();
  await expect(page).toHaveTitle("事项 — Morphz");
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.conversations.length).toBe(
    first.workspace.conversations.length + 1,
  );
  expect(after.workspace.inputs).toHaveLength(initial.workspace.inputs.length);
  await group.getByLabel("打开对话：对话 3", { exact: true }).click();
  await expect(
    group.getByLabel("打开对话：对话 3", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await group.getByLabel("对话操作：对话 3", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("重命名：对话 3", { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("归档：对话 3", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    group.getByLabel("对话操作：对话 3", { exact: true }),
  ).toBeFocused();
});

async function newProject(page: Page, title: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.locator('.sidebar-project[data-active="true"] .project-link'),
  ).toHaveText(title);
  await expect(page.locator(".topbar .conversation-switch")).toHaveCount(0);
}
const projectGroup = (page: Page) =>
  page.locator('.sidebar-project[data-active="true"]');
async function choose(page: Page, title: string) {
  await projectGroup(page)
    .getByRole("button", { name: `打开对话：${title}`, exact: true })
    .click();
}
test("首位对话与工作台共享历史，场景草稿可恢复且没有全局新建入口", async ({
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
  // Views share one continuous conversation; unsent drafts remain scoped to the work surface.
  await expect(
    page.locator(".human-message").filter({ hasText: "全局讨论，独立保存" }),
  ).toHaveCount(1);
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await page.reload();
  await expect(await openInput(page)).toHaveValue("全局待发送草稿");
  await expect(
    nav.getByRole("button", { name: /新建.*对话|新对话/ }),
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
  const app = page.getByRole("button", { name: "关闭应用 内容", exact: true });
  let box = await openInput(page);
  await box.fill("默认记录");
  await box.press("Enter");
  await box.fill("默认未发送草稿");
  await projectGroup(page)
    .getByRole("button", { name: /^新建项目对话：/ })
    .click();
  await expect(
    projectGroup(page).getByRole("button", {
      name: "打开对话：对话 2",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "true");
  await expect(app).toBeVisible();
  box = await openInput(page);
  await expect(box).toHaveValue("");
  await expect(page.getByRole("log")).toHaveCount(0);
  await box.fill("第二条记录");
  await box.press("Enter");
  await box.fill("第二条未发送草稿");
  await choose(page, "持续对话");
  await expect(await openInput(page)).toHaveValue("默认未发送草稿");
  await expect(page.getByRole("log")).toContainText("默认记录");
  await expect(page.getByRole("log")).not.toContainText("第二条记录");
  await choose(page, "对话 2");
  await expect(await openInput(page)).toHaveValue("第二条未发送草稿");
  await projectGroup(page).getByLabel("对话操作：对话 2").click();
  await page.getByLabel("重命名：对话 2").click();
  await page.getByLabel("对话名称", { exact: true }).fill("架构讨论");
  await page.getByLabel("保存对话名称").click();
  await expect(
    projectGroup(page).getByLabel("打开对话：架构讨论"),
  ).toHaveAttribute("aria-current", "true");
  await projectGroup(page).getByLabel("对话操作：架构讨论").click();
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
  await expect(projectGroup(page).getByLabel("对话操作：持续对话")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "外观设置", exact: true }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "电光青", exact: true }).click();
  await page.screenshot({
    path: "test-results/project-conversations-dark.png",
  });
  await page.keyboard.press("Escape");
  for (const width of [1440, 1000, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await projectGroup(page).getByLabel("对话操作：架构讨论").click();
    const bounds = (await page
      .getByRole("group", { name: "对话选项", exact: true })
      .boundingBox())!;
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
  await projectGroup(page)
    .getByRole("button", { name: /^新建项目对话：/ })
    .click();
  // The database commit precedes the client refresh and onSelect callback.
  // Reload only once the new conversation is actually selected in the UI.
  await expect(
    projectGroup(page).getByRole("button", {
      name: "打开对话：对话 2",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "true");
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
  await expect(
    projectGroup(page).getByRole("button", {
      name: "打开对话：对话 2",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "true");
  await openInput(page);
  await expect(page.getByRole("log")).toHaveCount(0);
  await choose(page, "持续对话");
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
  await page.getByText("其他后台执行与审批", { exact: true }).click();
  await expect.poll(() => scope).toBe(c);
});

test("对象引用随对话草稿保存，切换不会把选区带到另一条对话", async ({
  page,
}) => {
  await page.goto("/");
  await newProject(page, "引用归属验收");
  await openLibrary(page);
  await page.getByRole("button", { name: "手动写文档", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("跨对话引用原文");
  await page
    .getByLabel("新文档正文")
    .fill("上下文事务维护当前认知，保留可追溯的历史。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await projectGroup(page)
    .getByRole("button", { name: /^新建项目对话：/ })
    .click();
  // Start quoting only after the asynchronous creation has selected its Session.
  await expect(
    projectGroup(page).getByLabel("打开对话：对话 2", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await page.getByLabel("全文搜索").fill("可追溯的历史");
  await page.getByLabel("搜索项目范围").selectOption({ label: "引用归属验收" });
  await page.getByRole("button", { name: "引用并提问", exact: true }).click();
  await expect(page.locator(".selection-quote")).toContainText("可追溯的历史");
  await page.getByLabel("AI 输入内容").fill("解释这段引用，尚未发送");
  await choose(page, "持续对话");
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
