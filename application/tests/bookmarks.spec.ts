import { test, expect, type Page } from "@playwright/test";
import { seedCenter } from "./center-fixtures.js";

// The center is shared across specs. Do not leave this fixture's immersive
// browser selected for unrelated dialog/launcher tests in fresh windows.
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) return;
  await page.unroute("**/api/commands");
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
        layout: async () => {},
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
const boot = async (p: Page) => (await p.request.get("/api/workspace")).json();

test("收藏可添加、查找、编辑、打开、移除和撤销；刷新保持且不创建成果", async ({
  page,
}) => {
  await browser(page);
  const before = await boot(page);
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
  const after = await boot(page);
  expect(after.workspace.artifacts).toEqual(before.workspace.artifacts);
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(
    after.workspace.bookmarks.filter((b: any) => b.url === url && !b.deletedAt),
  ).toHaveLength(1);
});

test("收藏编辑遇到并发修改或保存失败保留输入，不显示假成功", async ({
  page,
}) => {
  await browser(page);
  const url = `https://example.org/${crypto.randomUUID()}`;
  const id = await seedCenter(page, {
    type: "bookmark-add",
    title: "TEST 冲突收藏",
    url,
  });
  await page.getByRole("button", { name: "浏览器收藏", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索收藏" }).fill(url);
  await page.getByRole("button", { name: "编辑收藏：TEST 冲突收藏" }).click();
  await page.getByRole("textbox", { name: "收藏名称" }).fill("未保存的名称");
  await seedCenter(page, {
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
  expect(
    (await boot(page)).workspace.bookmarks.find((b: any) => b.id === id).title,
  ).toBe("另一端已保存");
  await page.getByRole("button", { name: "返回收藏列表" }).click();
  await page.getByRole("button", { name: "编辑收藏：另一端已保存" }).click();
  await page.getByRole("textbox", { name: "收藏名称" }).fill("失败后保留");
  await page.route("**/api/commands", (route) =>
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
  await page.unroute("**/api/commands");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开收藏：失败后保留" }),
  ).toBeVisible();
});
