import { openSettings } from "./settings-helpers.js";
import { seedCenter } from "./center-fixtures.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Command } from "../packages/core/src/model.js";
import type { Boot } from "../apps/web/src/client.js";
import { openInput } from "./interaction-helpers.js";
import { humanTask } from "./artifact-fixtures.js";

async function snapshot(page: Page): Promise<Boot> {
  return (await page.request.get("/api/workspace")).json();
}
async function command(page: Page, operation: Command["operation"]) {
  const boot = await snapshot(page);
  const response = await page.request.post("/api/commands", {
    headers: {
      "X-Morphz-Token": boot.csrfToken,
      Origin: "http://127.0.0.1:65421",
    },
    data: { commandId: randomUUID(), operation },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).entityId as string;
}

test("内容能直接找到对话和项目文档，长文滚动、返回和重载不丢目录", async ({
  page,
}) => {
  await page.goto("/");
  const initial = await snapshot(page);
  const owner = initial.workspace.projects.find((p) => p.kind === "desk")!;
  const title = "对话中生成的现场清单-" + randomUUID();
  const doc = await command(page, {
    type: "create-artifact",
    projectId: owner.id,
    title,
    content: {
      kind: "document",
      markdown:
        "这份文档由对话创建，保存在未归项目。\n\n" +
        "长文阅读与滚动验证。\n\n".repeat(120),
    },
  });
  const projectTitle = "资料归属验证-" + randomUUID();
  const projectId = await command(page, {
    type: "create-project",
    title: projectTitle,
  });
  const projectDoc = "项目自己的文档-" + randomUUID();
  await command(page, {
    type: "create-artifact",
    projectId,
    title: projectDoc,
    content: { kind: "document", markdown: "项目正文" },
  });
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
  const after = await snapshot(page);
  expect(after.workspace.artifacts.find((a) => a.id === doc)?.projectId).toBe(
    owner.id,
  );
  expect(after.workspace.inputs).toEqual(initial.workspace.inputs);
  expect(after.workspace.applicationInstances).toEqual(
    initial.workspace.applicationInstances,
  );
  expect(
    after.workspace.conversations.filter((c) => c.id !== projectId),
  ).toEqual(initial.workspace.conversations);
  await page.screenshot({ path: "test-results/library-all-spaces.png" });
});

test("搜索先看到刚创建的对象时，打开会补齐快照而不是无响应", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  const initial = await snapshot(page);
  const owner = initial.workspace.projects.find((p) => p.kind === "desk")!;
  const title = "先被搜索发现的新对象-" + randomUUID();
  await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId: owner.id,
      title,
      content: { kind: "document", markdown: "这是轮询尚未送达的新内容。" },
    },
    true,
  );
  let deliverLatest = false;
  await page.route("**/api/workspace", async (route) => {
    if (deliverLatest) return route.continue();
    await route.fulfill({ status: 200, json: initial });
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
  const after = await snapshot(page);
  expect(after.workspace.applicationInstances).toEqual(
    initial.workspace.applicationInstances,
  );
  expect(after.workspace.inputs).toEqual(initial.workspace.inputs);
});

test("内容排除事项及其计数，事项入口仍能编辑和关联输入，不复制数据", async ({
  page,
}) => {
  await page.goto("/");
  const initial = await snapshot(page);
  const dialogue = initial.workspace.projects.find(
    (p) => p.kind === "dialogue",
  )!;
  const title = "同一事项不同入口-" + randomUUID();
  const projectId = await command(page, {
    type: "create-project",
    title: "只有事项的空间-" + randomUUID(),
  });
  const id = await command(page, {
    type: "create-artifact",
    projectId,
    title,
    content: humanTask("这是同一个事项的正文，只记录，不执行。"),
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
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.artifacts.find((a) => a.id === id)
          ?.revision,
    )
    .toBe(2);
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
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.inputs.find((i) => i.body === body)
          ?.artifactId,
    )
    .toBe(id);
  const sent = (await snapshot(page)).workspace.inputs.find(
    (i) => i.body === body,
  )!;
  expect(sent.projectId).toBe(projectId);
  expect(sent.conversationId).toBe(dialogue.id);
  expect(sent.artifactRevision).toBe(2);
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
  const final = await snapshot(page);
  expect(
    final.workspace.artifacts.filter((a) => a.title === title),
  ).toHaveLength(1);
  expect(
    final.workspace.conversations.filter((c) => c.id !== projectId),
  ).toEqual(initial.workspace.conversations);
  expect(final.workspace.applicationInstances).toEqual(
    initial.workspace.applicationInstances,
  );
  const documentTitle = "事项关联的成果-" + randomUUID();
  const documentId = await command(page, {
    type: "create-artifact",
    projectId,
    title: documentTitle,
    content: { kind: "document", markdown: "事项关联的文档仍然属于内容。" },
  });
  await command(page, {
    type: "link-artifacts",
    fromId: id,
    toId: documentId,
    relation: "produces",
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
  const linked = await snapshot(page);
  expect(
    linked.workspace.relations.some(
      (r) => r.fromId === id && r.toId === documentId && r.type === "produces",
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
  await page.goto("/");
  const boot = await snapshot(page);
  const dialogue = boot.workspace.projects.find((p) => p.kind === "dialogue")!;
  const empty = await command(page, {
    type: "create-project",
    title: "空内容范围-" + randomUUID(),
  });
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
  await expect
    .poll(async () =>
      (await snapshot(page)).workspace.inputs.find((i) => i.body === body),
    )
    .toBeTruthy();
  const sent = (await snapshot(page)).workspace.inputs.find(
    (i) => i.body === body,
  )!;
  expect(sent.projectId).toBe(empty);
  expect(sent.conversationId).toBe(dialogue.id);
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
