import { randomUUID } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { observeScriptSnapshotReads } from "./script-browser-read-proof.js";

test("项目最近活动包含内容首屏之外的原件", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const prefix = `TEST 活动排序 ${randomUUID().slice(0, 8)}`;
  const olderId = randomUUID();
  const middleId = randomUUID();
  const newestId = randomUUID();
  await source.createProject(`${prefix} 旧项目`, randomUUID(), olderId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await source.createProject(`${prefix} 后建项目`, randomUUID(), middleId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const olderObjectId = randomUUID();
  await source.createDocument({
    commandId: randomUUID(),
    objectId: olderObjectId,
    projectId: olderId,
    title: "首屏之外的原件",
    markdown: "这份内容使旧项目比后建项目更活跃。",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await source.createProject(`${prefix} 最新项目`, randomUUID(), newestId);
  for (let index = 0; index < 50; index++)
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: newestId,
      title: `新内容 ${index}`,
      markdown: `第 ${index} 份`,
    });
  expect(
    (await source.content({ limit: 50 })).items.some(
      (entry) => entry.appObjectId === olderObjectId,
    ),
  ).toBe(false);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page.getByLabel("搜索项目", { exact: true }).fill(prefix);
  await page.getByLabel("项目排序").selectOption("recent");
  await expect(page.locator(".project-card h2")).toHaveText([
    `${prefix} 最新项目`,
    `${prefix} 旧项目`,
    `${prefix} 后建项目`,
  ]);
});

test("非事项页只读取事项汇总，进入事项页才加载事项列表", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = randomUUID();
  const title = `TEST 按需事项 ${randomUUID().slice(0, 8)}`;
  await source.createProject("TEST 按需事项目录", randomUUID(), projectId);
  await source.createTask({
    commandId: randomUUID(),
    taskId: randomUUID(),
    projectId,
    title,
    assigneeId: source.boot.actantId,
  });
  await page.addInitScript(
    ({ centerId, principalId }) => {
      const scope = `morphz:${centerId}:${principalId}:`;
      localStorage.setItem(
        scope + "preferences",
        JSON.stringify({ view: "content" }),
      );
    },
    { centerId: source.boot.centerId, principalId: source.boot.principalId },
  );
  let listReads = 0;
  let countReads = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/platform/tasks" && request.method() === "GET")
      listReads++;
    if (path === "/api/platform/tasks/counts") countReads++;
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect.poll(() => countReads).toBeGreaterThan(0);
  expect(listReads).toBe(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await expect(
    page.getByLabel("事项列表", { exact: true }).getByRole("button", {
      name: `打开事项：${title}`,
    }),
  ).toBeVisible();
  expect(listReads).toBeGreaterThan(0);
});

test("内容目录冷启动不读正文，打开一项只读对应应用原件", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = randomUUID();
  await source.createProject("TEST 按需内容目录", randomUUID(), projectId);
  const objectIds: string[] = Array.from({ length: 12 }, () => randomUUID());
  for (const [index, objectId] of objectIds.entries())
    await source.createDocument({
      commandId: randomUUID(),
      objectId,
      projectId,
      title: `TEST 按需文档 ${index}`,
      markdown: `仅第 ${index} 份原文`,
    });
  const contentIds = new Set(
    (
      await source.content({
        appId: "morphz.objects",
        appObjectIds: objectIds,
        limit: 50,
      })
    ).items.map((entry) => entry.id),
  );
  expect(contentIds.size).toBe(12);
  await page.addInitScript(
    ({ centerId, principalId }) => {
      const scope = `morphz:${centerId}:${principalId}:`;
      localStorage.setItem(
        scope + "preferences",
        JSON.stringify({ view: "content" }),
      );
      localStorage.setItem(
        scope + "library-view:all-content",
        JSON.stringify({ layout: "list", scope: "all" }),
      );
    },
    { centerId: source.boot.centerId, principalId: source.boot.principalId },
  );
  const reads: string[] = [];
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(
      /^\/api\/platform\/objects\/([^/]+)$/,
    );
    if (match && contentIds.has(match[1]!)) reads.push(match[1]!);
  });
  await page.goto("/");
  const list = page.getByRole("region", { name: "全部内容" });
  await expect(
    list.getByRole("button", { name: /^打开内容：TEST 按需文档/ }),
  ).toHaveCount(12);
  expect(reads).toEqual([]);
  await list
    .getByRole("button", { name: "打开内容：TEST 按需文档 11" })
    .click();
  await expect(page.locator(".document-body")).toContainText("仅第 11 份原文");
  expect(new Set(reads).size).toBe(1);
});

test("剧本目录不批量读摘要，可见卡片按需读，打开与选中才读取相应目录和正文", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 500 });
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const personal = await source.ensurePersonalSpaces();
  const productionIds = Array.from({ length: 15 }, () => randomUUID());
  const productions = await Promise.all(
    productionIds.map((productionId, index) =>
      source.createScript({
        commandId: randomUUID(),
        productionId,
        projectId: personal.deskId,
        title: `TEST 按需剧本 ${index}`,
      }),
    ),
  );
  const contentIds = new Set(
    (
      await source.content({
        appId: "morphz.script-studio",
        appObjectIds: productionIds,
        limit: 50,
      })
    ).items.map((entry) => entry.id),
  );
  expect(productions).toHaveLength(15);
  expect(contentIds.size).toBe(15);
  const snapshots = observeScriptSnapshotReads(page);
  const overviews: string[] = [];
  const selected = await source.resolveContent({
    appId: "morphz.script-studio",
    appObjectId: productionIds[14]!,
  });
  const itemId = randomUUID();
  const itemTitle = "第一集：按需打开的实际条目";
  const text = "只有选中这集，才需要读取这份实际保存的正文。";
  const editorReads = { requests: [] as string[], responses: [] as string[] };
  const recordEditorRead = (request: Request, target: string[]) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/platform\/scripts\/editor\/(head|page)$/.test(path)) {
      if (request.postDataJSON()?.contentId === selected.id) target.push(path);
    } else if (path === `/api/platform/scripts/${selected.id}/items/${itemId}`)
      target.push(path);
  };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    const match = path.match(/^\/api\/platform\/scripts\/([^/]+)$/);
    if (match && contentIds.has(match[1]!)) overviews.push(match[1]!);
    recordEditorRead(request, editorReads.requests);
  });
  page.on("response", (response) => {
    if (response.ok())
      recordEditorRead(response.request(), editorReads.responses);
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  expect(overviews).toEqual([]);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
    .click();
  // Launching the existing app restores its open script. Enter its library
  // explicitly; accumulated tests must not assume an empty app window.
  const library = page.getByRole("button", { name: "全部剧本", exact: true });
  await expect(library.or(page.locator(".script-library"))).toBeVisible();
  if (await library.isVisible()) await library.click();
  const card = page.getByRole("button", {
    name: "打开剧本：TEST 按需剧本 14",
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText("尚无分集或分场");
  expect(new Set(overviews).size).toBeGreaterThan(0);
  expect(new Set(overviews).size).toBeLessThan(contentIds.size);
  expect(snapshots).toEqual({ requests: [], responses: [] });
  expect(editorReads).toEqual({ requests: [], responses: [] });
  // Preserve the empty-card assertion above, then publish an actual item.
  // The existing open path must obtain current metadata rather than a stale
  // card observation; no partial production snapshot is manufactured.
  const overview = await source.readScript(selected.id);
  await source.createScriptItem({
    commandId: randomUUID(),
    contentId: selected.id,
    itemId,
    kind: "episode",
    expectedActivityRevision: overview.activityRevision,
    draft: { ...emptyScriptDraft(itemTitle), sources: [], text },
  });
  await card.click();
  await expect(page.locator(".script-studio")).toContainText(
    "TEST 按需剧本 14",
  );
  const headPath = "/api/platform/scripts/editor/head";
  const pagePath = "/api/platform/scripts/editor/page";
  const bodyPath = `/api/platform/scripts/${selected.id}/items/${itemId}`;
  await expect.poll(() => editorReads.responses.includes(headPath)).toBe(true);
  await expect.poll(() => editorReads.responses.includes(pagePath)).toBe(true);
  expect(editorReads.requests).not.toContain(bodyPath);
  const exact = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === bodyPath && response.ok(),
  );
  const navigation = page.getByRole("navigation", {
    name: "剧本目录",
    exact: true,
  });
  if (!(await navigation.isVisible()))
    await page
      .getByRole("button", { name: "剧本目录开关", exact: true })
      .click();
  await navigation.getByRole("button", { name: new RegExp(itemTitle) }).click();
  await exact;
  await expect(page.getByLabel("剧本正文", { exact: true })).toHaveValue(text);
  expect(editorReads.requests).toContain(bodyPath);
  expect(editorReads.responses).toContain(bodyPath);
  expect(snapshots).toEqual({ requests: [], responses: [] });
});

test("内容目录滚动到剧本卡片时才读取该卡片进度", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 450 });
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = randomUUID();
  await source.createProject("TEST 剧本卡片按需", randomUUID(), projectId);
  const productionIds = Array.from({ length: 12 }, () => randomUUID());
  await Promise.all(
    productionIds.map((productionId, index) =>
      source.createScript({
        commandId: randomUUID(),
        productionId,
        projectId,
        title: `TEST 卡片按需 ${index}`,
      }),
    ),
  );
  const contentIds = new Set(
    (
      await source.content({
        appId: "morphz.script-studio",
        appObjectIds: productionIds,
        limit: 50,
      })
    ).items.map((entry) => entry.id),
  );
  expect(contentIds.size).toBe(12);
  await page.addInitScript(
    ({ centerId, principalId, projectId }) => {
      const scope = `morphz:${centerId}:${principalId}:`;
      localStorage.setItem(
        scope + "preferences",
        JSON.stringify({ view: "content" }),
      );
      localStorage.setItem(
        scope + "library-view:all-content",
        JSON.stringify({ layout: "grid", scope: projectId }),
      );
    },
    {
      centerId: source.boot.centerId,
      principalId: source.boot.principalId,
      projectId,
    },
  );
  const overviews: string[] = [];
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(
      /^\/api\/platform\/scripts\/([^/]+)$/,
    );
    if (match && contentIds.has(match[1]!)) overviews.push(match[1]!);
  });
  await page.goto("/");
  const cards = page.getByRole("button", { name: /^打开内容：TEST 卡片按需/ });
  await expect(cards).toHaveCount(12);
  const top = cards.first();
  await top.scrollIntoViewIfNeeded();
  await expect(top).toContainText("0 集 · 0 场");
  const initiallyRead = new Set(overviews);
  expect(initiallyRead.size).toBeGreaterThan(0);
  expect(initiallyRead.size).toBeLessThan(contentIds.size);
  const bottom = cards.last();
  await bottom.scrollIntoViewIfNeeded();
  await expect(bottom).toContainText("0 集 · 0 场");
  expect(new Set(overviews).size).toBeGreaterThan(initiallyRead.size);
});

test("导入副本通过应用原件保存来源，重开内容仍能看到来源与正文", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = randomUUID();
  await source.createProject("TEST 导入来源", randomUUID(), projectId);
  const imported = (await source.importDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId,
    relativePath: "测试资料/导入持久化.md",
    text: "导入来源与正文需要同时保留。",
  })) as { contentId: string };
  await page.addInitScript(
    ({ centerId, principalId }) => {
      const scope = `morphz:${centerId}:${principalId}:`;
      localStorage.setItem(
        scope + "preferences",
        JSON.stringify({ view: "content" }),
      );
    },
    { centerId: source.boot.centerId, principalId: source.boot.principalId },
  );
  await page.goto("/");
  const content = page.getByRole("button", { name: "打开内容：导入持久化" });
  await content.click();
  await expect(page.locator(".document-body")).toContainText(
    "导入来源与正文需要同时保留。",
  );
  await expect(page.locator(".source-strip summary")).toContainText(
    "测试资料/导入持久化.md",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "打开内容：导入持久化" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开内容：导入持久化" }).click();
  await expect(page.locator(".document-body")).toContainText(
    "导入来源与正文需要同时保留。",
  );
  await expect(page.locator(".source-strip summary")).toContainText(
    "测试资料/导入持久化.md",
  );
  expect(imported.contentId).toBeTruthy();
});
