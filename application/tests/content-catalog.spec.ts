import { openSettings } from "./settings-helpers.js";
import { test, expect, type Page } from "@playwright/test";
import {
  assertDialogControlMetrics,
  assertSingleFieldDialog,
} from "./dialog-control-helpers.js";
import { randomUUID } from "node:crypto";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  isolatedCenterDirectory,
  seedAgentOriginal,
} from "./platform-agent-original-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { seedProjectUnderstanding } from "./platform-understanding-fixture.js";
const platform = () =>
  PlatformClient.connect(new HttpApplicationClient("http://127.0.0.1:65421"));
const catalog = async (p: Page) =>
  p
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
async function doc(
  source: PlatformClient,
  projectId: string,
  title: string,
  markdown: string,
) {
  const created = (await source.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId,
    title,
    markdown,
  })) as { contentId: string };
  return created.contentId;
}

test("公开状态不混入内容；未知筛选恢复全部，查看原件和理解不改数据或草稿", async ({
  page,
}) => {
  await page.goto("/");
  const source = await platform();
  const prefix = "边界验收" + randomUUID();
  const projectId = await source.createProject(
    prefix,
    randomUUID(),
    randomUUID(),
  );
  const document = await doc(
    source,
    projectId,
    prefix + "普通文档",
    "保留的工作成果",
  );
  const other = await doc(source, projectId, prefix + "另一文档", "另一份原件");
  await seedProjectUnderstanding(source, projectId, prefix + "状态正文", [
    { contentId: document, versionRef: "1" },
  ]);
  const records = () =>
    Promise.all([
      source.content({ projectId }),
      source.readDocument(document),
      source.readDocument(other),
      source.projectUnderstanding(projectId),
    ]);
  const before = await records();
  const beforeDeliveries = (
    await source.navigationRuntime()
  ).runtime.deliveries.map((delivery) => delivery.inputId);
  await page.reload();
  await catalog(page);
  const input = await openInput(page);
  await input.fill("内容边界未发送草稿");
  await page.getByLabel("搜索内容", { exact: true }).fill(prefix);
  const types = page.getByRole("group", { name: "内容类型" });
  await expect(types.getByRole("button")).toHaveText([
    "全部",
    "文档",
    "PDF",
    "图片",
    "表格",
    "剧本",
  ]);
  await expect(page.locator(".artifact-card")).toHaveCount(2);
  await page.getByLabel("内容范围", { exact: true }).selectOption(projectId);
  await expect(page.locator(".library-caption")).toContainText("2 项内容");
  await page.getByLabel("列表视图", { exact: true }).click();
  await expect(page.locator(".artifact-card")).toHaveCount(2);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.endsWith("library-view:all-content"),
    )!;
    localStorage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(key)!),
        filter: "website",
      }),
    );
  });
  await page.reload();
  await expect(
    types.getByRole("button", { name: "全部", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".artifact-card")).toHaveCount(2);
  await page
    .getByLabel("打开内容：" + prefix + "普通文档", { exact: true })
    .click();
  await expect(page.locator(".document-body")).toContainText("保留的工作成果");
  await catalog(page);
  await page.getByLabel("内容范围", { exact: true }).selectOption("all");
  await expect(await openInput(page)).toHaveValue("内容边界未发送草稿");
  await page.getByRole("button", { name: prefix, exact: true }).click();
  const launcher = page.getByRole("button", {
    name: "应用启动台",
    exact: true,
  });
  await launcher.click();
  await expect(page.getByLabel("继续工作")).not.toContainText(prefix + "状态");
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "当前理解", exact: true }),
  ).toContainText(prefix + "状态正文");
  expect(await records()).toEqual(before);
  expect(
    (await source.navigationRuntime()).runtime.deliveries.map(
      (delivery) => delivery.inputId,
    ),
  ).toEqual(beforeDeliveries);
});

test("内容专用入口与起草位置；正文查找只索引 Agent 原创，不索引手写和导入副本", async ({
  page,
}) => {
  const prefix = randomUUID(),
    body = "bodyonly" + prefix;
  const title = "目录产物" + prefix;
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = `catalog_${prefix.replaceAll("-", "")}`;
  const projectTitle = `内容检索项目${prefix}`;
  await source.createProject(projectTitle, randomUUID(), projectId);
  await seedAgentOriginal(isolatedCenterDirectory(), projectId, title, body);
  await source.importDocument({
    commandId: randomUUID(),
    objectId: `import_${prefix.replaceAll("-", "")}`,
    projectId,
    relativePath: `旧副本${prefix}.md`,
    text: body,
  });
  await source.createDocument({
    commandId: randomUUID(),
    objectId: `manual_${prefix.replaceAll("-", "")}`,
    projectId,
    title: "手写" + prefix,
    markdown: body,
  });
  await page.goto("/");
  await catalog(page);
  await expect(page.getByLabel("工作空间选项", { exact: true })).toHaveCount(0);
  const create = page.getByRole("group", { name: "创建内容" });
  await expect(create).toContainText("起草文档");
  await expect(create).not.toContainText("工作台");
  await page.getByLabel("内容范围", { exact: true }).selectOption(projectId);
  await expect(create).toContainText("起草文档");
  await page.getByLabel("让 Morphz 起草", { exact: true }).click();
  await expect(page.locator(".composer-meta .context-chip")).toHaveText(
    projectTitle,
  );
  await page.getByLabel("其他内容创作").click();
  const menu = page.getByRole("group", { name: "内容创作", exact: true });
  await expect(menu.getByRole("button")).toHaveCount(1);
  await expect(menu).toContainText("手动写文档");
  await expect(menu).not.toContainText("工作台");
  await expect(
    page.getByRole("button", { name: "制作表格或报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "表格与报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "内容类型" }).getByRole("button", {
      name: "表格",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  const search = page.getByRole("dialog", { name: "搜索资料", exact: true });
  await search.getByLabel("全文搜索", { exact: true }).fill(body);
  await search.getByLabel("搜索项目范围").selectOption(projectId);
  await expect(search.getByRole("status")).toHaveText("找到 1 项内容");
  await expect(search.locator("article")).toContainText(title);
  await expect(search.locator(".search-excerpt")).toContainText(body);
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索内容", { exact: true }).fill(title);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".content-origin")).toHaveText("Morphz生成");
  await page.getByLabel("搜索内容", { exact: true }).fill("旧副本" + prefix);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".content-origin")).toHaveText("导入副本");
  await page.getByLabel("搜索内容", { exact: true }).fill("手写" + prefix);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await page.getByLabel("内容排序", { exact: true }).selectOption("title");
  await page.getByLabel("列表视图", { exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("内容排序", { exact: true })).toHaveValue(
    "title",
  );
  await expect(page.locator(".artifact-list .artifact-card")).toHaveCount(1);
});

test("重命名、移动、撤销保留同一内容与历史；并发冲突留下未保存名称", async ({
  page,
}) => {
  await page.goto("/");
  const source = await platform();
  const title = "整理验收" + randomUUID();
  const projectId = await source.createProject(
    "整理来源" + randomUUID(),
    randomUUID(),
    randomUUID(),
  );
  const id = await doc(source, projectId, title, "正文保持不变");
  const target = await source.createProject(
    "整理目标" + randomUUID(),
    randomUUID(),
    randomUUID(),
  );
  const beforeDeliveries = (
    await source.navigationRuntime()
  ).runtime.deliveries.map((delivery) => delivery.inputId);
  await page.reload();
  await catalog(page);
  await page.getByLabel("搜索内容", { exact: true }).fill(title);
  await page.getByLabel("内容操作：" + title, { exact: true }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await expect(page.getByLabel("内容名称", { exact: true })).toBeFocused();
  await assertDialogControlMetrics(page.getByRole("dialog"));
  await assertSingleFieldDialog(page.getByRole("dialog"));
  await page.getByLabel("内容名称", { exact: true }).fill(title + "已改名");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByLabel("打开内容：" + title + "已改名", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    page.getByLabel("打开内容：" + title, { exact: true }),
  ).toBeVisible();
  await page.getByLabel("内容操作：" + title, { exact: true }).click();
  await page.getByRole("button", { name: "设置项目", exact: true }).click();
  await page.getByLabel("目标项目", { exact: true }).selectOption(target);
  await assertDialogControlMetrics(page.getByRole("dialog"));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(async () => (await source.getContent(id)).projectId)
    .toBe(target);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => (await source.getContent(id)).projectId)
    .toBe(projectId);
  const entry = await source.getContent(id);
  expect(entry.revision).toBe(5);
  // Moving only changes the catalog relation. Rename/undo append app versions.
  await expect(source.readDocument(id)).resolves.toMatchObject({
    revision: 3,
    title,
    markdown: "正文保持不变",
  });
  await expect(source.readDocument(id, 1)).resolves.toMatchObject({
    revision: 1,
    title,
    markdown: "正文保持不变",
  });
  await page.getByLabel("内容操作：" + title, { exact: true }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByLabel("内容名称", { exact: true }).fill("尚未保存的名称");
  await source.renameObject({
    commandId: randomUUID(),
    contentId: id,
    expectedCatalogRevision: entry.revision,
    title: title + "另一处修改",
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已变化");
  await expect(page.getByLabel("内容名称", { exact: true })).toHaveValue(
    "尚未保存的名称",
  );
  await page.keyboard.press("Escape");
  await expect(source.readDocument(id)).resolves.toMatchObject({
    revision: 4,
    title: title + "另一处修改",
    markdown: "正文保持不变",
  });
  expect(
    (await source.navigationRuntime()).runtime.deliveries.map(
      (delivery) => delivery.inputId,
    ),
  ).toEqual(beforeDeliveries);
});

test("从内容继续交流准确引用版本、不自动发送、不覆盖其他草稿；返回保持视图", async ({
  page,
}) => {
  await page.goto("/");
  const source = await platform();
  const title = "继续处理" + randomUUID();
  const projectId = await source.createProject(
    "继续交流" + randomUUID(),
    randomUUID(),
    randomUUID(),
  );
  const id = await doc(source, projectId, title, "需要智能体处理的产物");
  await page.reload();
  await catalog(page);
  await (await openInput(page)).fill("目录自身草稿不能被覆盖");
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await page.getByLabel("搜索内容", { exact: true }).fill(title);
  await page.getByLabel("列表视图", { exact: true }).click();
  const beforeDeliveries = (
    await source.navigationRuntime()
  ).runtime.deliveries.map((delivery) => delivery.inputId);
  const beforeConversations = await source.allConversations(projectId);
  await page.getByLabel("让智能体处理：" + title, { exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(page.locator(".composer .context-chip")).toContainText(title);
  await input.fill("此产物的未发草稿");
  await page
    .locator(".breadcrumb")
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await expect(page.getByLabel("搜索内容", { exact: true })).toHaveValue(title);
  await expect(page.getByLabel("列表视图", { exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(await openInput(page)).toHaveValue("目录自身草稿不能被覆盖");
  await page.getByLabel("让智能体处理：" + title, { exact: true }).click();
  await expect(input).toHaveValue("此产物的未发草稿");
  expect(
    (await source.navigationRuntime()).runtime.deliveries.map(
      (delivery) => delivery.inputId,
    ),
  ).toEqual(beforeDeliveries);
  expect(await source.allConversations(projectId)).toEqual(beforeConversations);
  await expect(source.readDocument(id)).resolves.toMatchObject({
    revision: 1,
    markdown: "需要智能体处理的产物",
  });
});

test("搜索翻页、切换查询与失败重试；卡片/列表窄窗可见且无溢出", async ({
  page,
}) => {
  await page.goto("/");
  const source = await platform();
  const token = "页内词" + randomUUID();
  const projectId = await source.createProject(
    "分页验收" + randomUUID(),
    randomUUID(),
    randomUUID(),
  );
  for (let i = 0; i < 52; i++)
    await doc(source, projectId, `分页验收 ${i} ${token}`, `分页正文 ${i}`);
  await page.reload();
  await catalog(page);
  await page.getByLabel("内容范围", { exact: true }).selectOption(projectId);
  await page.getByLabel("搜索内容", { exact: true }).fill(token);
  await expect(page.locator(".artifact-card")).toHaveCount(50);
  // The exchange now overlays the canvas; close it before reaching the last row.
  if (await page.getByLabel("AI 输入内容", { exact: true }).isVisible())
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
  await page
    .getByRole("region", { name: "内容列表" })
    .evaluate((element) => (element.scrollTop = element.scrollHeight));
  await page.getByRole("button", { name: "继续加载", exact: true }).click();
  await expect(page.locator(".artifact-card")).toHaveCount(52);
  await page.getByLabel("搜索内容", { exact: true }).fill("不存在" + token);
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  const directoryRoute = "**/api/platform/content?**";
  await page.route(directoryRoute, (route) =>
    new URL(route.request().url()).searchParams.get("query") === token
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "目录暂不可用" }),
        })
      : route.continue(),
  );
  await page.getByLabel("搜索内容", { exact: true }).fill(token);
  await expect(page.getByRole("alert")).toContainText("目录暂不可用");
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  await expect(page.getByLabel("搜索内容", { exact: true })).toHaveValue(token);
  await page.unroute(directoryRoute);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".artifact-card")).toHaveCount(50);
  for (const appearance of ["亮色", "暗色"]) {
    await openSettings(page, "外观");
    await page.getByRole("button", { name: appearance, exact: true }).click();
    await page.keyboard.press("Escape");
    for (const width of [1440, 760, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const layout of ["卡片视图", "列表视图"]) {
        await page.getByLabel(layout, { exact: true }).click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const card = page.locator(".artifact-card").first();
        expect(
          await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        const title = await card
            .locator(".artifact-card-heading")
            .boundingBox(),
          actions = await card.locator(".content-item-actions").boundingBox();
        const heading = await card.locator("h2").boundingBox();
        expect(heading!.x + heading!.width).toBeLessThanOrEqual(actions!.x + 1);
        expect(title!.height).toBeGreaterThan(0);
      }
      await page.screenshot({
        path: `test-results/content-catalog-${appearance}-${width}.png`,
      });
    }
  }
});
