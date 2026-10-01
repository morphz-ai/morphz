import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

test("原内容界面按授权范围分页，搜索和切换范围不混入旧结果", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  // Keep a numeric collision in the shared suffix: the item selector must be
  // distinct from an incidental substring in the unique fixture identity.
  const suffix = `54${randomUUID().replaceAll("-", "")}`;
  const projectId = `page_${suffix}`;
  const otherProjectId = `other_${suffix}`;
  await source.createProject("TEST 内容分页", randomUUID(), projectId);
  await source.createProject("TEST 其他项目", randomUUID(), otherProjectId);
  for (let index = 0; index < 55; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: `item_${suffix}_${index}`,
      projectId,
      title: `TEST 分页文档 第${index}项 ${suffix}`,
      markdown: `分页正文 ${index}`,
    });
  await source.createDocument({
    commandId: randomUUID(),
    objectId: `outside_${suffix}`,
    projectId: otherProjectId,
    title: `TEST 其他文档 ${suffix}`,
    markdown: "不属于当前项目",
  });
  for (let index = 0; index < 49; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: `boundary_${suffix}_${index}`,
      projectId: otherProjectId,
      title: `TEST 边界文档 ${index} ${suffix}`,
      markdown: `边界正文 ${index}`,
    });
  await page.addInitScript(
    ({ centerId, principalId, projectId }) => {
      const scope = `morphz:${centerId}:${principalId}:`;
      localStorage.setItem(
        scope + "preferences",
        JSON.stringify({ view: "content" }),
      );
      localStorage.setItem(
        scope + "library-view:all-content",
        JSON.stringify({ layout: "list", scope: projectId }),
      );
    },
    {
      centerId: source.boot.centerId,
      principalId: source.boot.principalId,
      projectId,
    },
  );
  const coldDirectoryRequests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/platform/content" &&
      !url.searchParams.has("projectId") &&
      !url.searchParams.has("appIds") &&
      !url.searchParams.has("appId") &&
      !url.searchParams.has("contentIds") &&
      !url.searchParams.has("query")
    )
      coldDirectoryRequests.push(url);
  });
  await page.goto("/");
  const list = page.getByRole("region", { name: "全部内容" });
  const cards = list.getByRole("button", { name: /^打开内容：TEST 分页文档/ });
  await expect(cards).toHaveCount(50);
  expect(
    coldDirectoryRequests.map((url) => url.searchParams.get("limit")),
  ).toEqual(["50"]);
  await expect(list).toContainText("55 项内容");
  await expect(list).not.toContainText(`TEST 其他文档 ${suffix}`);
  await list
    .getByRole("region", { name: "内容列表" })
    .evaluate((element) => (element.scrollTop = element.scrollHeight));
  await list.getByRole("button", { name: "继续加载" }).click();
  await expect(cards).toHaveCount(55);
  await expect(list.getByRole("button", { name: "继续加载" })).toHaveCount(0);

  await list
    .getByRole("textbox", { name: "搜索内容" })
    .fill(`分页文档 第54项 ${suffix}`);
  await expect(cards).toHaveCount(1);
  await expect(list).toContainText("1 项内容");
  await list
    .getByRole("combobox", { name: "内容范围" })
    .selectOption(otherProjectId);
  await expect(cards).toHaveCount(0);
  await expect(list).toContainText("0 项内容");
  await list.getByRole("button", { name: "清除搜索" }).click();
  await expect(
    list.getByRole("button", { name: `打开内容：TEST 其他文档 ${suffix}` }),
  ).toBeVisible();
  await expect(cards).toHaveCount(0);
  await expect(list).toContainText("50 项内容");
  await expect(list.getByRole("button", { name: "继续加载" })).toHaveCount(0);
});

test("冷启动最近打开可恢复首屏之外的原件", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const personal = await source.ensurePersonalSpaces();
  const suffix = randomUUID().replaceAll("-", "");
  const title = `TEST 首屏外的最近内容 ${suffix}`;
  const target = (await source.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: personal.deskId,
    title,
    markdown: "最近打开的原文",
  })) as { contentId: string };
  for (let index = 0; index < 55; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: personal.deskId,
      title: `TEST 后续内容 ${index} ${suffix}`,
      markdown: "正文",
    });
  await page.addInitScript(
    ({ centerId, principalId, contentId }) => {
      localStorage.setItem(
        `morphz:${centerId}:${principalId}:recent-content`,
        JSON.stringify([{ artifactId: contentId, openedAt: Date.now() }]),
      );
    },
    {
      centerId: source.boot.centerId,
      principalId: source.boot.principalId,
      contentId: target.contentId,
    },
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const recent = page.getByRole("region", { name: "继续工作" });
  await expect(
    recent.getByRole("button", { name: `继续打开：${title}` }),
  ).toBeVisible();
  await recent.getByRole("button", { name: `继续打开：${title}` }).click();
  await expect(page.locator(".document-body")).toContainText("最近打开的原文");
});

test("搜索结果引用首屏外的原件时仍能打开同一版本并带入原文", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `quote_${suffix}`;
  const title = `TEST 首屏外引用 ${suffix}`;
  const quote = `首屏外的准确原文 ${suffix}`;
  await source.createProject(
    `TEST 引用项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  const target = (await source.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId,
    title,
    markdown: quote,
  })) as { contentId: string };
  for (let index = 0; index < 55; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: `TEST 后续引用 ${index} ${suffix}`,
      markdown: "后续正文",
    });
  await page.route(
    (url) => url.pathname === "/api/search",
    async (route) => {
      await route.fulfill({
        json: {
          hits: [
            {
              artifactId: target.contentId,
              projectId,
              projectTitle: `TEST 引用项目 ${suffix}`,
              title,
              kind: "document",
              revision: 1,
              excerpt: quote,
              matchedIn: "content",
              quote,
              updatedAt: new Date().toISOString(),
              source: null,
            },
          ],
          total: 1,
          hasMore: false,
          workspaceRevision: 1,
        },
      });
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "搜索资料" }).click();
  const dialog = page.getByRole("dialog", { name: "搜索资料" });
  await dialog.getByRole("textbox", { name: "全文搜索" }).fill(suffix);
  await dialog.getByRole("button", { name: `AI 交互：${title}` }).click();
  await expect(page.locator(".document-body")).toContainText(quote);
  await expect(page.locator(".selection-quote blockquote")).toHaveText(quote);
});

test("搜索引用与原件不符时不将伪造选文带入对话", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `quote_mismatch_${suffix}`;
  const title = `TEST 失效引用 ${suffix}`;
  const quote = `不属于原件的引用 ${suffix}`;
  await source.createProject(
    `TEST 失效引用项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  const target = (await source.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId,
    title,
    markdown: `真实原文 ${suffix}`,
  })) as { contentId: string };
  await page.route(
    (url) => url.pathname === "/api/search",
    async (route) => {
      await route.fulfill({
        json: {
          hits: [
            {
              artifactId: target.contentId,
              projectId,
              projectTitle: `TEST 失效引用项目 ${suffix}`,
              title,
              kind: "document",
              revision: 1,
              excerpt: quote,
              matchedIn: "content",
              quote,
              updatedAt: new Date().toISOString(),
              source: null,
            },
          ],
          total: 1,
          hasMore: false,
          workspaceRevision: 1,
        },
      });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "搜索资料" }).click();
  const dialog = page.getByRole("dialog", { name: "搜索资料" });
  await dialog.getByRole("textbox", { name: "全文搜索" }).fill(suffix);
  await dialog.getByRole("button", { name: `AI 交互：${title}` }).click();
  await expect(
    page.getByText("引用与当前原件版本不一致，请重新搜索后再试。"),
  ).toBeVisible();
  await expect(page.locator(".selection-quote")).toHaveCount(0);
});

test("正式搜索可直接打开首屏之外的内容原件", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `search_${suffix}`;
  const title = `TEST 可直达首屏外 ${suffix}`;
  const body = `首屏外原件正文 ${suffix}`;
  await source.createProject(
    `TEST 搜索项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  await source.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId,
    title,
    markdown: body,
  });
  for (let index = 0; index < 55; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: `TEST 新近内容 ${index} ${suffix}`,
      markdown: "其他内容",
    });

  await page.goto("/");
  await page.getByRole("button", { name: "搜索资料" }).click();
  const dialog = page.getByRole("dialog", { name: "搜索资料" });
  await dialog.getByRole("textbox", { name: "全文搜索" }).fill(title);
  await expect(dialog.getByText("找到 1 项内容")).toBeVisible();
  await dialog
    .locator("article")
    .filter({ hasText: title })
    .locator(".search-result-open")
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  await expect(page.locator(".document-body")).toContainText(body);
});

test("剧本工作室从应用目录逐页列出剧本", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = `script_${randomUUID().replaceAll("-", "")}`;
  await source.createProject("TEST 分页剧本项目", randomUUID(), projectId);
  for (let index = 0; index < 52; index++)
    await source.createScript({
      commandId: randomUUID(),
      productionId: randomUUID(),
      projectId,
      title: `TEST 分页剧本 ${projectId} ${index}`,
    });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
    .click();
  const returnToLibrary = page.getByRole("button", {
    name: "全部剧本",
    exact: true,
  });
  const library = page.locator(".script-library");
  await expect(returnToLibrary.or(library)).toBeVisible();
  if (await returnToLibrary.isVisible()) await returnToLibrary.click();
  await library.getByRole("searchbox", { name: "查找剧本" }).fill(projectId);
  const cards = library.getByRole("button", {
    name: /^打开剧本：TEST 分页剧本/,
  });
  await expect(cards).toHaveCount(50);
  await expect(library).toContainText("52 部剧本");
  await library.evaluate(
    (element) => (element.scrollTop = element.scrollHeight),
  );
  await library.getByRole("button", { name: "继续加载" }).click();
  await expect(cards).toHaveCount(52);
  const lastCard = library.getByRole("button", {
    name: `打开剧本：TEST 分页剧本 ${projectId} 51`,
  });
  await lastCard.scrollIntoViewIfNeeded();
  await expect(lastCard).toContainText("尚无分集或分场");
});

test("阅读书库逐页列出可读内容并按书名查找", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = `books_${randomUUID().replaceAll("-", "")}`;
  await source.createProject("TEST 阅读分页", randomUUID(), projectId);
  for (let index = 0; index < 51; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: `TEST 阅读分页 ${projectId} ${index}`,
      markdown: `正文 ${index}`,
    });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "阅读 1.0.0", exact: true }).click();
  const returnToLibrary = page.getByRole("button", {
    name: "全部读物",
    exact: true,
  });
  const library = page.getByRole("region", { name: "阅读书库" });
  await expect(returnToLibrary.or(library)).toBeVisible();
  if (await returnToLibrary.isVisible()) await returnToLibrary.click();
  await library.getByRole("searchbox", { name: "查找读物" }).fill(projectId);
  const cards = library.getByRole("button", { name: /^阅读：TEST 阅读分页/ });
  await expect(cards).toHaveCount(50);
  await expect(library).toContainText("51 份读物");
  await library.evaluate(
    (element) => (element.scrollTop = element.scrollHeight),
  );
  await library.getByRole("button", { name: "继续加载" }).click();
  await expect(cards).toHaveCount(51);
});

test("剧本引用项目原文从授权目录查找超过首屏的对象", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `sources_${suffix}`;
  const title = `TEST 引用分页剧本 ${suffix}`;
  await source.createProject("TEST 剧本引用分页", randomUUID(), projectId);
  for (let index = 0; index < 52; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: `TEST 引用原文 ${index} ${suffix}`,
      markdown: `第 ${index} 份原文`,
    });
  await source.createScript({
    commandId: randomUUID(),
    productionId: randomUUID(),
    projectId,
    title,
  });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
    .click();
  const returnToLibrary = page.getByRole("button", {
    name: "全部剧本",
    exact: true,
  });
  const library = page.locator(".script-library");
  await expect(returnToLibrary.or(library)).toBeVisible();
  if (await returnToLibrary.isVisible()) await returnToLibrary.click();
  await library.getByRole("searchbox", { name: "查找剧本" }).fill(suffix);
  await library.getByRole("button", { name: `打开剧本：${title}` }).click();
  await page
    .getByRole("region", { name: "创作入口" })
    .getByRole("button", { name: "新建一集", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "新建一集" });
  await create.getByLabel("条目标题").fill("第一集");
  await create.getByRole("button", { name: "创建条目" }).click();
  await page.getByText("结构、来源与连续性信息").click();
  await page.getByRole("button", { name: "引用项目原文" }).click();
  const dialog = page.getByRole("dialog", { name: "引用项目原文" });
  await expect(
    dialog.getByRole("option", { name: /^TEST 引用原文/ }),
  ).toHaveCount(50);
  await dialog.getByRole("button", { name: "继续加载" }).click();
  await expect(
    dialog.getByRole("option", { name: /^TEST 引用原文/ }),
  ).toHaveCount(52);
  await dialog
    .getByRole("searchbox", { name: "查找项目原文" })
    .fill(`引用原文 51 ${suffix}`);
  await expect(
    dialog.getByRole("option", { name: `TEST 引用原文 51 ${suffix}` }),
  ).toHaveCount(1);
});
