import { test, expect, type Page } from "@playwright/test";
import { assertDialogControlMetrics } from "./dialog-control-helpers.js";
import type { BookmarkOperation } from "../packages/core/src/bookmarks.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

// The center is shared across specs. Do not leave this fixture's immersive
// browser selected for unrelated dialog/launcher tests in fresh windows.
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) return;
  await page.unroute("**/api/bookmarks/commands");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
  await page
    .getByRole("button", { name: "关闭应用 浏览器", exact: true })
    .click();
});

async function browser(page: Page) {
  await page.addInitScript(() => {
    let current: any = null;
    (window as any).__visits = 0;
    (window as any).morphzDesktop = {
      browser: {
        open: async (target: any) => {
          (window as any).__visits++;
          return (current = {
            ...target,
            pageId: "bookmark-page",
            surface: { partition: "fixture", src: target.url },
            artifactId: null,
            epoch: "1",
            title: "示例网页",
            granted: false,
            visible: true,
            error: "",
            pending: null,
          });
        },
        navigate: async (_id: string, url: string) => {
          (window as any).__visits++;
          return (current = { ...current, url });
        },
        state: async () => current,
        visibility: async () => {},
        close: async () => {
          current = null;
        },
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  if (await page.getByRole("textbox", { name: "网站地址" }).count()) return;
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
}
const platform = () =>
  PlatformClient.connect(new HttpApplicationClient("http://127.0.0.1:65421"));
async function commandBookmark(page: Page, operation: BookmarkOperation) {
  const bootstrap = await (
    await page.request.get("/api/platform/bootstrap")
  ).json();
  const response = await page.request.post("/api/bookmarks/commands", {
    headers: {
      Origin: new URL(page.url()).origin,
      "X-Morphz-Token": bootstrap.csrfToken,
    },
    data: { commandId: crypto.randomUUID(), operation },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).receipt as {
    bookmarkId: string;
    revision: number;
  };
}

test("收藏可添加、查找、编辑、打开、移除和撤销；刷新保持且不创建成果", async ({
  page,
}) => {
  await browser(page);
  const source = await platform();
  expect(source.boot.capabilities.browserBookmarks).toBe(true);
  const beforeContent = await source.contentCounts();
  const beforeInputs = (await source.navigationRuntime()).runtime.deliveries.map(
    (delivery) => delivery.inputId,
  );
  const url = `https://example.com/bookmark-${crypto.randomUUID()}`;
  const address = page.getByRole("textbox", { name: "网站地址" });
  await address.fill(url);
  await page.getByRole("button", { name: "收藏此页", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑当前收藏" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).__visits)).toBe(0);
  await page.getByRole("button", { name: "编辑当前收藏" }).click();
  const dialog = page.getByRole("dialog", { name: "浏览器收藏" });
  await assertDialogControlMetrics(dialog);
  expect((await dialog.locator("header").boundingBox())!.height).toBeCloseTo(
    32,
    2,
  );
  await page
    .getByRole("textbox", { name: "收藏名称" })
    .fill("TEST 浏览器个人收藏");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索收藏" }).fill("TEST 个人收藏");
  await expect(dialog.locator(".bookmark-row")).toHaveCount(1);
  await page
    .getByRole("button", { name: "打开收藏：TEST 浏览器个人收藏", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(address).toHaveValue(url);
  expect(await page.evaluate(() => (window as any).__visits)).toBe(1);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "编辑当前收藏" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "浏览器收藏", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索收藏" }).fill(url);
  await page
    .getByRole("button", { name: "移除收藏：TEST 浏览器个人收藏" })
    .click();
  await expect(dialog.locator(".bookmark-row")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(dialog.locator(".bookmark-row")).toHaveCount(1);
  await page.setViewportSize({ width: 760, height: 540 });
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 760;
    })
    .toBe(true);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page
    .getByRole("button", { name: "编辑收藏：TEST 浏览器个人收藏" })
    .click();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("textbox", { name: "收藏网址" }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "浏览器收藏", exact: true }),
  ).toBeFocused();
  expect(await source.contentCounts()).toEqual(beforeContent);
  expect(
    (await source.navigationRuntime()).runtime.deliveries.map(
      (delivery) => delivery.inputId,
    ),
  ).toEqual(beforeInputs);
  const bookmarks = await (
    await page.request.get(`/api/bookmarks?query=${encodeURIComponent(url)}`)
  ).json();
  expect(
    bookmarks.filter(
      (b: { url: string; deletedAt: string | null }) =>
        b.url === url && !b.deletedAt,
    ),
  ).toHaveLength(1);
});

test("收藏编辑遇到并发修改或保存失败保留输入，不显示假成功", async ({
  page,
}) => {
  await browser(page);
  const url = `https://example.org/${crypto.randomUUID()}`;
  const { bookmarkId: id } = await commandBookmark(page, {
    type: "bookmark-add",
    title: "TEST 冲突收藏",
    url,
  });
  await page.getByRole("button", { name: "浏览器收藏", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索收藏" }).fill(url);
  await page.getByRole("button", { name: "编辑收藏：TEST 冲突收藏" }).click();
  await page.getByRole("textbox", { name: "收藏名称" }).fill("未保存的名称");
  await commandBookmark(page, {
    type: "bookmark-update",
    bookmarkId: id,
    expectedRevision: 1,
    title: "另一端已保存",
    url,
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("收藏已被修改");
  await expect(page.getByRole("textbox", { name: "收藏名称" })).toHaveValue(
    "未保存的名称",
  );
  const bookmarks = await (
    await page.request.get(`/api/bookmarks?query=${encodeURIComponent(url)}`)
  ).json();
  expect(bookmarks.find((b: { id: string }) => b.id === id).title).toBe(
    "另一端已保存",
  );
  await page.getByRole("button", { name: "返回收藏列表" }).click();
  await page.getByRole("button", { name: "编辑收藏：另一端已保存" }).click();
  await page.getByRole("textbox", { name: "收藏名称" }).fill("失败后保留");
  await page.route("**/api/bookmarks/commands", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "TEST 保存不可用" }),
    }),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "收藏名称" })).toHaveValue(
    "失败后保留",
  );
  await page.unroute("**/api/bookmarks/commands");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开收藏：失败后保留" }),
  ).toBeVisible();
});

test("独立收藏域界面按当前网址精确读取、分页搜索，并只调用新领域入口", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const rows: any[] = Array.from({ length: 60 }, (_, index) => ({
    id: `bookmark_seed_${index}`,
    ownerPrincipalId: "local-owner",
    title: `示例 ${index}`,
    url: `https://example.com/seed-${index}`,
    revision: 1,
    createdAt: now,
    updatedAt: new Date(Date.now() - index * 1000).toISOString(),
    createdBy: { principalId: "local-owner", actantId: "local-human" },
    updatedBy: { principalId: "local-owner", actantId: "local-human" },
    deletedAt: null,
  }));
  let oldBookmarkWrites = 0;
  expect((await platform()).boot.capabilities.browserBookmarks).toBe(true);
  await page.route("**/api/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.operation?.type?.startsWith("bookmark-")) oldBookmarkWrites++;
    await route.continue();
  });
  await page.route("**/api/bookmarks**", async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (request.method() === "GET") {
      const query = (target.searchParams.get("query") ?? "").toLowerCase();
      const url = target.searchParams.get("url");
      const deleted = target.searchParams.get("deleted") === "true";
      const offset = Number(target.searchParams.get("offset") ?? 0);
      const limit = Number(target.searchParams.get("limit") ?? 20);
      const result = rows
        .filter(
          (row) =>
            !!row.deletedAt === deleted &&
            (!url || row.url === url) &&
            `${row.title} ${row.url}`.toLowerCase().includes(query),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(offset, offset + limit);
      await route.fulfill({ status: 200, json: result });
      return;
    }
    const command = request.postDataJSON();
    const operation = command.operation;
    let row = rows.find((item) => item.id === operation.bookmarkId);
    if (operation.type === "bookmark-add") {
      row = rows.find((item) => item.url === operation.url && !item.deletedAt);
      if (!row) {
        row = {
          ...rows[0],
          id: `bookmark_${crypto.randomUUID().replaceAll("-", "")}`,
          title: operation.title,
          url: operation.url,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        };
        rows.push(row);
      }
    } else if (row) {
      row.revision++;
      row.updatedAt = new Date().toISOString();
      if (operation.type === "bookmark-update") {
        row.title = operation.title;
        row.url = operation.url;
      } else
        row.deletedAt =
          operation.type === "bookmark-remove" ? row.updatedAt : null;
    }
    await route.fulfill({
      status: 200,
      json: {
        source: "browser",
        receipt: {
          tenantId: "tenant-one",
          commandId: command.commandId,
          ownerPrincipalId: "local-owner",
          bookmarkId: row?.id,
          revision: row?.revision,
          operation: operation.type,
          committedAt: new Date().toISOString(),
        },
      },
    });
  });
  await browser(page);
  const address = page.getByRole("textbox", { name: "网站地址" });
  await address.fill("https://example.com/seed-59");
  await address.press("Enter");
  await expect(
    page.getByRole("button", { name: "编辑当前收藏" }),
  ).toBeVisible();
  const url = `https://example.com/managed-${crypto.randomUUID()}`;
  await address.fill(url);
  await address.press("Enter");
  await page.getByRole("button", { name: "收藏此页" }).click();
  await expect(
    page.getByRole("button", { name: "编辑当前收藏" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "浏览器收藏", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "浏览器收藏" });
  await dialog.getByRole("searchbox", { name: "搜索收藏" }).fill(url);
  await expect(dialog.locator(".bookmark-row")).toHaveCount(1);
  await dialog.getByRole("button", { name: /移除收藏：/ }).click();
  await expect(dialog.locator(".bookmark-row")).toHaveCount(0);
  await dialog.getByRole("button", { name: "撤销" }).click();
  await expect(dialog.locator(".bookmark-row")).toHaveCount(1);
  expect(oldBookmarkWrites).toBe(0);
});
