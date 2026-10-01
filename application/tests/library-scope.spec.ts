import { openSettings } from "./settings-helpers.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import type { LocalSavedInput } from "../apps/web/src/local-saved-inputs.js";
import { openInput } from "./interaction-helpers.js";

const connect = () =>
  PlatformClient.connect(new HttpApplicationClient("http://127.0.0.1:65421"));

async function createDocument(
  source: PlatformClient,
  projectId: string,
  title: string,
  markdown: string,
) {
  const objectId = randomUUID();
  await source.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId,
    title,
    markdown,
  });
  return source.resolveContent({
    appId: "morphz.objects",
    appObjectId: objectId,
  });
}

/** No Runtime is configured in this UI fixture. Saving an input must remain
 * a recoverable Client record, not a fake Platform or Runtime message. */
async function savedInput(page: Page, body: string) {
  return page.evaluate((text) => {
    for (const key of Object.keys(localStorage)) {
      if (!key.includes(":saved-input:")) continue;
      const input = JSON.parse(localStorage.getItem(key)!);
      if (input.operation.body === text) return input;
    }
    return null;
  }, body) as Promise<LocalSavedInput | null>;
}

test("内容能直接找到对话和项目文档，长文滚动、返回和重载不丢目录", async ({
  page,
}) => {
  const source = await connect();
  const spaces = await source.ensurePersonalSpaces();
  const initialRuntime = await source.navigationRuntime();
  const initialViews = await source.appViews();
  const initialConversations = await source.conversations(spaces.dialogueId);
  await page.goto("/");
  const title = "对话中生成的现场清单-" + randomUUID();
  const doc = await createDocument(
    source,
    spaces.deskId,
    title,
    "这份文档由对话创建，保存在未归项目。\n\n" +
      "长文阅读与滚动验证。\n\n".repeat(120),
  );
  const projectTitle = "资料归属验证-" + randomUUID();
  const projectId = randomUUID();
  await source.createProject(projectTitle, randomUUID(), projectId);
  const projectDoc = "项目自己的文档-" + randomUUID();
  await createDocument(source, projectId, projectDoc, "项目正文");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await expect(page.getByLabel("内容范围", { exact: true })).toHaveValue("all");
  await page
    .getByRole("group", { name: "内容类型" })
    .getByRole("button", { name: "文档", exact: true })
    .click();
  const card = page.locator(".artifact-card").filter({ hasText: title });
  await expect(card).toContainText("未归项目 · 文档");
  await expect(card.locator(".artifact-card-open")).toHaveAttribute(
    "title",
    title + " · v1",
  );
  await expect(
    page.locator(".artifact-card").filter({ hasText: projectDoc }),
  ).toContainText(projectTitle);
  await card.click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  await expect(page.locator(".document-body")).toContainText(
    "这份文档由对话创建，保存在未归项目",
  );
  const main = page.getByRole("main", { name: "主工作区" });
  await main.evaluate((el) => el.scrollTo({ top: 300 }));
  await expect
    .poll(() => main.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page
    .locator(".breadcrumb")
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await expect(page.getByLabel("内容范围", { exact: true })).toHaveValue("all");
  await expect(card).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "内容类型" })
      .getByRole("button", { name: "文档", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(card).toBeVisible();
  expect((await source.getContent(doc.id)).projectId).toBe(spaces.deskId);
  expect(await source.readDocument(doc.id)).toMatchObject({
    revision: 1,
    title,
  });
  expect((await source.navigationRuntime()).runtime.deliveries).toEqual(
    initialRuntime.runtime.deliveries,
  );
  expect(await source.appViews()).toEqual(initialViews);
  expect(await source.conversations(spaces.dialogueId)).toEqual(
    initialConversations,
  );
  await page.screenshot({ path: "test-results/library-all-spaces.png" });
});

test("搜索先看到刚创建的对象时，打开会补齐目录而不是无响应", async ({
  page,
}) => {
  const source = await connect();
  const spaces = await source.ensurePersonalSpaces();
  const initialRuntime = await source.navigationRuntime();
  const initialViews = await source.appViews();
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  const initialContent = await source.content({ limit: 100 });
  const title = "先被搜索发现的新对象-" + randomUUID();
  const doc = await createDocument(
    source,
    spaces.deskId,
    title,
    "这是轮询尚未送达的新内容。",
  );
  let deliverLatest = false;
  await page.route(/\/api\/platform\/content\?/, async (route) => {
    if (deliverLatest) return route.continue();
    const query = new URL(route.request().url()).searchParams;
    const after = query.get("beforeContentId");
    const start = after
      ? initialContent.items.findIndex((entry) => entry.id === after) + 1
      : 0;
    const limit = Number(query.get("limit") ?? 50);
    await route.fulfill({
      status: 200,
      json: initialContent.items.slice(start, start + limit),
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  await page.getByLabel("全文搜索").fill(title);
  const result = page.locator(".search-result-open").filter({ hasText: title });
  await expect(result).toBeVisible();
  deliverLatest = true;
  await result.click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  await expect(page.locator(".document-body")).toContainText("轮询尚未送达");
  expect(await source.appViews()).toEqual(initialViews);
  expect((await source.navigationRuntime()).runtime.deliveries).toEqual(
    initialRuntime.runtime.deliveries,
  );
  expect(await source.readDocument(doc.id)).toMatchObject({
    revision: 1,
    markdown: "这是轮询尚未送达的新内容。",
  });
});

test("内容排除事项及其计数，事项入口仍能编辑和关联输入，不复制数据", async ({
  page,
}) => {
  const source = await connect();
  const spaces = await source.ensurePersonalSpaces();
  const initialViews = await source.appViews();
  const initialConversations = await source.conversations(spaces.dialogueId);
  await page.goto("/");
  const title = "同一事项不同入口-" + randomUUID();
  const projectId = randomUUID();
  await source.createProject(
    "只有事项的空间-" + randomUUID(),
    randomUUID(),
    projectId,
  );
  const id = randomUUID();
  await source.createTask({
    commandId: randomUUID(),
    taskId: id,
    projectId,
    title,
    description: "这是同一个事项的正文，只记录，不执行。",
    assigneeId: source.boot.actantId,
  });
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "内容类型" })
      .getByRole("button", { name: "事项", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "新建事项", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("内容范围", { exact: true }).selectOption(projectId);
  await expect(page.locator(".library-caption")).toContainText("0 项内容");
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  await expect(
    page.getByText("这个范围内还没有内容", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("搜索内容").fill(title);
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  await nav.getByRole("button", { name: /^事项/ }).click();
  await page
    .locator(".matter-collection")
    .getByRole("button")
    .filter({ hasText: title })
    .click();
  await expect(page.locator(".breadcrumb")).toContainText("事项");
  await expect(page.getByLabel("事项说明")).toContainText("同一个事项的正文");
  await page.getByRole("button", { name: "手动编辑", exact: true }).click();
  await expect(page.getByLabel("优先级", { exact: true })).toHaveCount(0);
  await page.getByLabel("截止日期", { exact: true }).fill("2099-09-18");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await expect.poll(async () => (await source.taskHead(id)).revision).toBe(2);
  expect((await source.taskVersion(id, 2)).description).toContain(
    "同一个事项的正文",
  );
  expect((await source.taskHead(id)).dueDate).toBe("2099-09-18");
  await page
    .locator(".breadcrumb")
    .getByRole("button", { name: "事项", exact: true })
    .click();
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(page.getByLabel("搜索内容")).toHaveValue(title);
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  await nav.getByRole("button", { name: /^事项/ }).click();
  await page
    .locator(".matter-collection")
    .getByRole("button")
    .filter({ hasText: title })
    .click();
  await expect(page.locator(".breadcrumb")).toContainText("事项");
  await expect(page.locator(".breadcrumb")).not.toContainText("对话");
  await expect(page.getByLabel("事项说明")).toContainText("同一个事项的正文");
  const body = "从事项入口补充-" + randomUUID();
  await (await openInput(page)).fill(body);
  await expect(page.locator(".composer .context-chip")).toContainText(title);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect.poll(() => savedInput(page, body)).not.toBeNull();
  const sent = (await savedInput(page, body))!;
  expect(sent.operation).toMatchObject({
    projectId,
    conversationId: spaces.dialogueId,
    artifactId: id,
    artifactRevision: 2,
  });
  await page
    .locator(".breadcrumb")
    .getByRole("button", { name: "事项", exact: true })
    .click();
  await expect(page.getByLabel("事项列表")).toBeVisible();
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(page.getByLabel("搜索内容")).toHaveValue(title);
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  await page.reload();
  await expect(
    nav.getByRole("button", { name: "内容", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  expect((await source.tasks({ projectId, query: title })).items).toHaveLength(
    1,
  );
  expect(await source.conversations(spaces.dialogueId)).toEqual(
    initialConversations,
  );
  expect(await source.appViews()).toEqual(initialViews);
  expect((await savedInput(page, body))!.commandId).toBe(sent.commandId);
  const documentTitle = "事项关联的成果-" + randomUUID();
  const doc = await createDocument(
    source,
    projectId,
    documentTitle,
    "事项关联的文档仍然属于内容。",
  );
  await source.linkWork({
    commandId: randomUUID(),
    fromId: id,
    toId: doc.id,
    kind: "produces",
  });
  await page.getByLabel("清除搜索", { exact: true }).click();
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".artifact-card")).toContainText(documentTitle);
  await expect(page.locator(".library-caption")).toContainText("1 项内容");
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.endsWith("library-view:all-content"),
    );
    if (!key) throw new Error("Catalog preferences were not persisted");
    localStorage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(key)!),
        filter: "task",
      }),
    );
  });
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "内容类型" })
      .getByRole("button", { name: /^全部/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await page.locator(".artifact-card").click();
  await expect(page.locator(".document-body")).toContainText(
    "事项关联的文档仍然属于内容",
  );
  expect(
    (await source.workRelations(id)).items.some(
      (r) => r.fromId === id && r.toId === doc.id && r.type === "produces",
    ),
  ).toBe(true);
});

test("内容是固定目录，不再作为应用卡片；全局输入和工作台草稿分别恢复", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  const deskDraft = "工作台未发草稿-" + randomUUID();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await (await openInput(page)).fill(deskDraft);
  await expect(
    page.locator(".application-tile").filter({ hasText: /^(资料|内容)/ }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "内容", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "已打开的应用" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("group", { name: "创建内容" })).toBeVisible();
  await expect(await openInput(page)).toHaveValue("");
  await page.getByLabel("AI 输入内容").fill("内容目录草稿");
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  for (const appearance of ["亮色", "暗色"]) {
    await openSettings(page, "外观");
    await page.getByRole("button", { name: appearance, exact: true }).click();
    await page.keyboard.press("Escape");
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByLabel("内容范围", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const actions = await page
        .getByRole("group", { name: "创建内容" })
        .boundingBox();
      const toolbar = await page.getByLabel("内容工具栏").boundingBox();
      expect(actions!.y + actions!.height).toBeLessThanOrEqual(
        toolbar!.y + toolbar!.height,
      );
      await page.screenshot({
        path: `test-results/content-${appearance}-${width}.png`,
      });
    }
  }
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(await openInput(page)).toHaveValue(deskDraft);
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(await openInput(page)).toHaveValue("内容目录草稿");
});

test("内容空态和起草使用所选范围，不改变持续会话", async ({ page }) => {
  const source = await connect();
  const spaces = await source.ensurePersonalSpaces();
  const initialConversations = await source.conversations(spaces.dialogueId);
  const empty = randomUUID();
  await source.createProject("空内容范围-" + randomUUID(), randomUUID(), empty);
  await createDocument(
    source,
    spaces.deskId,
    `其他范围文档-${randomUUID()}`,
    "原件",
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  const scope = page.getByLabel("内容范围", { exact: true });
  await scope.selectOption(empty);
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  await expect(
    page.getByText("这个范围内还没有内容", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(scope).toHaveValue(empty);
  // The displayed scope and actual input destination agree, including an
  // empty project. Selecting it never creates a separate conversation.
  await page
    .getByRole("button", { name: "让 Morphz 起草", exact: true })
    .click();
  const input = await openInput(page);
  const body = "在所选空项目起草-" + randomUUID();
  await input.fill(body);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect.poll(() => savedInput(page, body)).not.toBeNull();
  const sent = (await savedInput(page, body))!;
  expect(sent.operation).toMatchObject({
    projectId: empty,
    conversationId: spaces.dialogueId,
  });
  expect(await source.conversations(spaces.dialogueId)).toEqual(
    initialConversations,
  );
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await page.getByRole("button", { name: "显示全部内容", exact: true }).click();
  await expect(scope).toHaveValue("all");
  await expect(page.locator(".artifact-card").first()).toBeVisible();
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(scope).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const box = await scope.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await page.screenshot({ path: "test-results/library-scope-narrow.png" });
});
