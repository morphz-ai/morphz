import { openSettings } from "./settings-helpers.js";
import { seedCenter } from "./center-fixtures.js";
import { test, expect, type Page } from "@playwright/test";
import { openInput, openExecutionPanel } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";

test("新建只开草稿：反复点击与刷新不建空会话，首发失败可重试，迟到回执不抢导航", async ({
  page,
}) => {
  await page.goto("/");
  const title = `延迟创建验收-${crypto.randomUUID().slice(0, 8)}`;
  await newProject(page, title);
  const initial = await (await page.request.get("/api/workspace")).json();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await (await openInput(page)).fill("保留全局草稿");
  const group = page.getByRole("group", {
    name: title + "的会话",
    exact: true,
  });
  const create = group.getByRole("button", {
    name: "新建项目对话：" + title,
    exact: true,
  });
  await expect(create.locator("svg.lucide-square-pen")).toBeVisible();
  await expect(create.locator("svg.lucide-plus")).toHaveCount(0);
  let creates = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/commands") &&
      request.postDataJSON()?.operation.type === "create-conversation"
    )
      creates++;
  });
  await create.click();
  await expect(page).toHaveTitle(title + " — Morphz");
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await create.dblclick();
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(group.locator(".conversation-choice")).toHaveCount(0);
  expect(
    (await (await page.request.get("/api/workspace")).json()).workspace
      .conversations,
  ).toEqual(initial.workspace.conversations);
  await (await openInput(page)).fill("首条独立消息");
  await expect(group.getByLabel("继续草稿：对话 1")).toBeVisible();
  await create.click();
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(await openInput(page)).toHaveValue("首条独立消息");
  await page.reload();
  await expect(await openInput(page)).toHaveValue("首条独立消息");
  expect(
    (await (await page.request.get("/api/workspace")).json()).workspace
      .conversations,
  ).toEqual(initial.workspace.conversations);
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON().operation.type === "record-input")
      await route.fulfill({
        status: 503,
        json: { message: "测试：发送暂不可用" },
      });
    else await route.continue();
  });
  await page.getByLabel("AI 输入内容").press("Enter");
  await expect(page.getByRole("alert")).toContainText("发送暂不可用");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("首条独立消息");
  expect(
    (await (await page.request.get("/api/workspace")).json()).workspace
      .conversations,
  ).toEqual(initial.workspace.conversations);
  await page.unroute("**/api/commands");
  await page.getByLabel("AI 输入内容").press("Enter");
  await expect(
    group.getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await expect(page.locator(".topbar .conversation-switch")).toHaveCount(0);
  const first = await (await page.request.get("/api/workspace")).json();
  expect(first.workspace.inputs).toHaveLength(
    initial.workspace.inputs.length + 1,
  );
  expect(first.workspace.conversations).toHaveLength(
    initial.workspace.conversations.length + 1,
  );
  expect(creates).toBe(0);
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await expect(await openInput(page)).toHaveValue("保留全局草稿");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = false;
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON().operation.type !== "record-input")
      return route.continue();
    arrived = true;
    await gate;
    await route.continue();
  });
  await create.dblclick();
  await (await openInput(page)).fill("迟到的首条消息");
  await page.getByLabel("AI 输入内容").press("Enter");
  await expect.poll(() => arrived).toBe(true);
  await nav.getByRole("button", { name: /^事项/ }).click();
  release();
  await expect(
    group.getByLabel("打开对话：对话 2", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("事项 — Morphz");
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.conversations.length).toBe(
    first.workspace.conversations.length + 1,
  );
  expect(after.workspace.inputs).toHaveLength(
    initial.workspace.inputs.length + 2,
  );
  await group.getByLabel("打开对话：对话 2", { exact: true }).click();
  await expect(
    group.getByLabel("打开对话：对话 2", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await group.getByLabel("对话操作：对话 2", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("重命名：对话 2", { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("归档：对话 2", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    group.getByLabel("对话操作：对话 2", { exact: true }),
  ).toBeFocused();
});

async function newProject(page: Page, title: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(title);
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
test("从项目搜索打开其他空间对象后，点击项目或草稿回到正确工作范围", async ({
  page,
}) => {
  await page.goto("/");
  const title = "跨空间草稿返回-" + crypto.randomUUID().slice(0, 8);
  await newProject(page, title);
  const group = page.getByRole("group", {
    name: title + "的会话",
    exact: true,
  });
  await (await openInput(page)).fill("默认项目草稿，不发送");
  await group.getByLabel("新建项目对话：" + title, { exact: true }).click();
  await (await openInput(page)).fill("命名会话草稿，不发送");
  const draft = group.getByLabel("继续草稿：对话 1", { exact: true });
  await expect(draft).toBeVisible();
  const boot = await (await page.request.get("/api/workspace")).json();
  const workspaceId = boot.workspace.projects.find(
    (p: any) => p.kind === "desk",
  ).id;
  const objectTitle = "其他空间的阅读对象-" + crypto.randomUUID().slice(0, 8);
  await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId: workspaceId,
      title: objectTitle,
      content: { kind: "document", markdown: "只读验收原文，不修改。" },
    },
    true,
  );
  const openOtherObject = async () => {
    await page.getByRole("button", { name: "搜索资料", exact: true }).click();
    await page.getByLabel("全文搜索", { exact: true }).fill(objectTitle);
    await page
      .getByRole("dialog", { name: "搜索资料", exact: true })
      .locator(".search-result-open")
      .click();
    await expect(page).toHaveTitle(objectTitle + " — Morphz");
    await expect(page.locator(".object-paper > h1")).toHaveText(objectTitle);
  };
  await openOtherObject();
  await draft.click();
  await expect(page).toHaveTitle(title + " — Morphz");
  await expect(await openInput(page)).toHaveValue("命名会话草稿，不发送");
  await expect(page.locator(".composer .context-chip")).toHaveText(title);
  await expect(page.locator(".object-paper > h1")).toHaveCount(0);
  await openOtherObject();
  await group.locator(".project-link").click();
  await expect(page).toHaveTitle(title + " — Morphz");
  await expect(await openInput(page)).toHaveValue("默认项目草稿，不发送");
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.inputs).toEqual(boot.workspace.inputs);
  expect(after.workspace.conversations).toEqual(boot.workspace.conversations);
});
test("旧空会话不占列表，已有草稿可恢复；只发附件才落库，丢回执重试不重复", async ({
  page,
}) => {
  await page.goto("/");
  await newProject(page, "首发边界验收");
  const boot = await (await page.request.get("/api/workspace")).json();
  const project = boot.workspace.projects.find(
    (p: any) => p.title === "首发边界验收",
  );
  const post = async (operation: unknown) => {
    const response = await page.request.post("/api/commands", {
      headers: {
        "X-Morphz-Token": boot.csrfToken,
        Origin: new URL(page.url()).origin,
      },
      data: { commandId: crypto.randomUUID(), operation },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response;
  };
  const empty = await (
    await post({
      type: "create-conversation",
      projectId: project.id,
      title: "旧空记录",
    })
  ).json();
  const saved = await (
    await post({
      type: "create-conversation",
      projectId: project.id,
      title: "旧草稿记录",
    })
  ).json();
  await page.evaluate(
    ({ boot, project, saved }) => {
      const owner = sessionStorage.getItem("morphz:window");
      const key = `morphz:${boot.centerId}:${boot.principalId}:draft:${owner}:inputs`;
      const drafts = JSON.parse(localStorage.getItem(key) ?? "{}");
      drafts[`${saved.entityId}:${project.id}:projects`] = {
        body: "旧会话的未发送草稿",
        selection: "",
        revision: null,
      };
      localStorage.setItem(key, JSON.stringify(drafts));
    },
    { boot, project, saved },
  );
  await page.reload();
  const group = projectGroup(page);
  await expect(group.getByLabel("打开对话：旧空记录")).toHaveCount(0);
  await expect(group.getByLabel("打开对话：旧草稿记录")).toHaveCount(0);
  await group.getByLabel("继续草稿：旧草稿记录").click();
  await expect(await openInput(page)).toHaveValue("旧会话的未发送草稿");
  await group.getByLabel("新建项目对话：首发边界验收").click();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await page.getByLabel("消息附件文件").setInputFiles({
    name: "首发附件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("只有附件的首条消息"),
  });
  await expect(page.getByLabel("消息附件", { exact: true })).toContainText(
    "首发附件.txt",
  );
  await group.locator(".project-link").click();
  await group.getByLabel("继续草稿：对话 1").click();
  await page.reload();
  await openInput(page);
  await expect(page.getByLabel("消息附件", { exact: true })).toContainText(
    "首发附件.txt",
  );
  const before = await (await page.request.get("/api/workspace")).json();
  let dropped = false;
  await page.route("**/api/commands", async (route) => {
    if (
      route.request().postDataJSON().operation.type !== "record-input" ||
      dropped
    )
      return route.continue();
    dropped = true;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.fulfill({
      status: 503,
      json: { message: "测试：已提交但回执丢失" },
    });
  });
  await page.getByLabel("保存输入", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("回执丢失");
  await expect(group.getByLabel("打开对话：对话 1")).toHaveAttribute(
    "aria-current",
    "true",
  );
  // A repeated new action must not discard the unresolved first-send identity.
  await group.getByLabel("新建项目对话：首发边界验收").click();
  await expect(page.getByLabel("消息附件", { exact: true })).toContainText(
    "首发附件.txt",
  );
  await page.getByLabel("保存输入", { exact: true }).click();
  await expect(
    page.locator(".composer").getByLabel("消息附件", { exact: true }),
  ).toHaveCount(0);
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.inputs).toHaveLength(
    before.workspace.inputs.length + 1,
  );
  expect(after.workspace.conversations).toHaveLength(
    before.workspace.conversations.length + 1,
  );
  const sent = after.workspace.inputs.at(-1);
  expect(sent.body).toBe("");
  expect(sent.attachments).toHaveLength(1);
  expect(
    after.workspace.conversations.some((c: any) => c.id === empty.entityId),
  ).toBe(true);
  expect(
    after.workspace.conversations.some((c: any) => c.id === saved.entityId),
  ).toBe(true);
  await group.getByLabel("继续草稿：旧草稿记录").click();
  await expect(await openInput(page)).toHaveValue("旧会话的未发送草稿");
});
test("项目本身选默认会话，子项只列显式 Session；折叠不切换，刷新保留，目录进入回默认", async ({
  page,
}) => {
  await page.goto("/");
  const title = "项目入口与会话选择验收";
  await newProject(page, title);
  const group = page.getByRole("group", {
    name: title + "的会话",
    exact: true,
  });
  const parent = group.locator(".project-link");
  await expect(parent).toHaveAttribute("aria-current", "true");
  await expect(group.locator(".conversation-choice")).toHaveCount(0);
  let box = await openInput(page);
  await box.fill("入口默认消息");
  await box.press("Enter");
  await expect(page.getByRole("log")).toContainText("入口默认消息");
  await box.fill("项目默认草稿");
  await group.getByLabel("新建项目对话：" + title, { exact: true }).click();
  const child = group.getByLabel("打开对话：对话 1", { exact: true });
  await expect(child).toHaveCount(0);
  await expect(group.locator(".conversation-choice")).toHaveCount(0);
  await expect(
    group.getByLabel("打开对话：持续对话", { exact: true }),
  ).toHaveCount(0);
  await expect(parent).not.toHaveAttribute("aria-current", "true");
  box = await openInput(page);
  await box.fill("入口独立消息");
  await box.press("Enter");
  await expect(page.getByRole("log")).toContainText("入口独立消息");
  await expect(child).toHaveAttribute("aria-current", "true");
  await box.fill("独立会话草稿");
  const before = await (await page.request.get("/api/workspace")).json();
  const project = before.workspace.projects.find((p: any) => p.title === title);
  const defaultId = before.workspace.projects.find(
    (p: any) => p.kind === "dialogue",
  ).id;
  const named = before.workspace.conversations.find(
    (c: any) => c.projectId === project.id && c.id !== project.id,
  );
  expect(
    before.workspace.inputs.find((i: any) => i.body === "入口默认消息"),
  ).toMatchObject({
    projectId: project.id,
    conversationId: defaultId,
  });
  expect(
    before.workspace.inputs.find((i: any) => i.body === "入口独立消息"),
  ).toMatchObject({
    projectId: project.id,
    conversationId: named.id,
  });
  // Legacy storage is retained even though its redundant navigation row is gone.
  expect(
    before.workspace.conversations.some((c: any) => c.id === project.id),
  ).toBe(true);
  await group.getByLabel("收起项目会话：" + title).click();
  await expect(group.locator(".conversation-choice")).toHaveCount(0);
  await expect(await openInput(page)).toHaveValue("独立会话草稿");
  await expect(page.getByRole("log")).toContainText("入口独立消息");
  await group.getByLabel("展开项目会话：" + title).click();
  await expect(child).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(child).toHaveAttribute("aria-current", "true");
  await expect(await openInput(page)).toHaveValue("独立会话草稿");
  await parent.click();
  await expect(parent).toHaveAttribute("aria-current", "true");
  await expect(child).not.toHaveAttribute("aria-current", "true");
  await expect(await openInput(page)).toHaveValue("项目默认草稿");
  await expect(page.getByRole("log")).toContainText("入口默认消息");
  await expect(page.getByRole("log")).not.toContainText("入口独立消息");
  await page.reload();
  await expect(parent).toHaveAttribute("aria-current", "true");
  await child.click();
  await expect(await openInput(page)).toHaveValue("独立会话草稿");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: /^事项/ }).click();
  await parent.click();
  await expect(parent).toHaveAttribute("aria-current", "true");
  await expect(await openInput(page)).toHaveValue("项目默认草稿");
  await child.click();
  await nav.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByLabel("搜索项目", { exact: true }).fill(title);
  await page.locator(".project-card").click();
  await expect(parent).toHaveAttribute("aria-current", "true");
  await expect(await openInput(page)).toHaveValue("项目默认草稿");
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(after.workspace.conversations).toEqual(before.workspace.conversations);
  // A real named Session with this title is not mistaken for the old default.
  await child.click();
  await group.getByLabel("对话操作：对话 1", { exact: true }).click();
  await page.getByLabel("重命名：对话 1", { exact: true }).click();
  await page.getByLabel("对话名称", { exact: true }).fill("持续对话");
  await page.getByLabel("保存对话名称", { exact: true }).click();
  await expect(
    group.getByLabel("打开对话：持续对话", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(group.locator(".conversation-choice")).toHaveCount(1);
});
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
  // A restored object can scope the workbench history; explicitly inspect the shared history.
  const allExchanges = page.getByRole("button", {
    name: "查看全部交流",
    exact: true,
  });
  if (await allExchanges.isVisible()) await allExchanges.click();
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
    projectGroup(page).getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveCount(0);
  await expect(projectGroup(page).locator(".conversation-choice")).toHaveCount(
    0,
  );
  await expect(projectGroup(page).getByLabel("打开对话：持续对话")).toHaveCount(
    0,
  );
  await expect(projectGroup(page).locator(".project-link")).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(app).toBeVisible();
  box = await openInput(page);
  await expect(box).toHaveValue("");
  await expect(page.getByRole("log")).toHaveCount(0);
  await box.fill("第二条记录");
  await box.press("Enter");
  await expect(
    projectGroup(page).getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await box.fill("第二条未发送草稿");
  await projectGroup(page).locator(".project-link").click();
  await expect(projectGroup(page).locator(".project-link")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(
    projectGroup(page).locator(
      '.project-conversation-row[data-selected="true"]',
    ),
  ).toHaveCount(0);
  await expect(await openInput(page)).toHaveValue("默认未发送草稿");
  await expect(page.getByRole("log")).toContainText("默认记录");
  await expect(page.getByRole("log")).not.toContainText("第二条记录");
  await choose(page, "对话 1");
  await expect(await openInput(page)).toHaveValue("第二条未发送草稿");
  await projectGroup(page).getByLabel("对话操作：对话 1").click();
  await page.getByLabel("重命名：对话 1").click();
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
  await openSettings(page, "外观");
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "电光青", exact: true }).click();
  await page.keyboard.press("Escape");
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
  // A Session exists only after a real first message (no model dispatch in this fixture).
  await page.route("**/api/messages", async (route) => {
    const result = await page.request.post("/api/commands", {
      data: route.request().postDataJSON(),
      headers: {
        "X-Morphz-Token": boot.csrfToken,
        Origin: new URL(page.url()).origin,
      },
    });
    expect(result.ok()).toBe(true);
    await route.fulfill({ response: result });
  });
  await (await openInput(page)).fill("独立会话的首条输入");
  await page.getByLabel("AI 输入内容").press("Enter");
  await expect(
    projectGroup(page).getByRole("button", {
      name: "打开对话：对话 1",
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
      name: "打开对话：对话 1",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "true");
  await openInput(page);
  await expect(page.getByRole("log")).not.toContainText("默认对话的迟到回复");
  await projectGroup(page).locator(".project-link").click();
  await expect(page.getByRole("log")).toContainText("默认对话的迟到回复");
  await choose(page, "对话 1");
  await openInput(page);
  let scope = "";
  await page.route("**/api/executions?*", async (route) => {
    scope =
      new URL(route.request().url()).searchParams.get("conversationId") ?? "";
    await route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } });
  });
  await openExecutionPanel(page);
  await page.getByText("工具执行记录", { exact: true }).click();
  await expect.poll(() => scope).toBe(c);
  // The workspace poll can still be inside route.fetch when this test ends.
  // Drain handlers here instead of leaking teardown errors into the next test.
  await page.unrouteAll({ behavior: "wait" });
});

test("对象引用随对话草稿保存，切换不会把选区带到另一条对话", async ({
  page,
}) => {
  await page.goto("/");
  await newProject(page, "引用归属验收");
  await openLibrary(page);
  const seedBoot = await (await page.request.get("/api/workspace")).json();
  const project = seedBoot.workspace.projects.find(
    (p: { title: string }) => p.title === "引用归属验收",
  );
  await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId: project.id,
      title: "跨对话引用原文",
      content: {
        kind: "document",
        markdown: "上下文事务维护当前认知，保留可追溯的历史。",
      },
    },
    true,
  );
  await page
    .locator(".artifact-card")
    .filter({ hasText: "跨对话引用原文" })
    .click();
  await projectGroup(page)
    .getByRole("button", { name: /^新建项目对话：/ })
    .click();
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(
    projectGroup(page).getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await page.getByLabel("全文搜索").fill("可追溯的历史");
  await page.getByLabel("搜索项目范围").selectOption({ label: "引用归属验收" });
  await page
    .getByRole("button", { name: "AI 交互：跨对话引用原文", exact: true })
    .click();
  await expect(page.locator(".selection-quote")).toContainText("可追溯的历史");
  await page.getByLabel("AI 输入内容").fill("解释这段引用，尚未发送");
  await projectGroup(page).locator(".project-link").click();
  await openInput(page);
  await expect(page.locator(".selection-quote")).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await expect(page.locator(".object-paper > h1")).toHaveText("跨对话引用原文");
  await projectGroup(page)
    .getByLabel("继续草稿：对话 1", { exact: true })
    .click();
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
    (c: any) => c.projectId === sent.projectId && c.title === "对话 1",
  );
  expect(sent.conversationId).toBe(c.id);
  expect(sent.artifactRevision).toBe(1);
  expect(sent.selection).toContain("可追溯的历史");
});
