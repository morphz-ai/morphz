import { expect, test } from "@playwright/test";

// Even a failing loading assertion must not leave an immersive app selected
// in the shared isolated center for the next spec.
test.afterEach(async ({ page }) => {
  const exit = page.getByRole("button", { name: "返回工作空间", exact: true });
  if (await exit.isVisible()) await exit.click();
  const close = page.getByRole("button", {
    name: "关闭应用 浏览器",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
});

test("慢网页加载有就地反馈，结束或失败后停止，不遮住网页或输入", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let current: any = null;
    (window as any).__finishPage = (error = "") => {
      current = { ...current, loading: false, error };
    };
    (window as any).morphzDesktop = {
      browser: {
        open: async (target: any) =>
          (current = {
            ...target,
            pageId: "loading-test",
            epoch: "1",
            artifactId: null,
            surface: { partition: "fixture", src: target.url },
            loading: true,
            title: "",
            error: "",
            pending: null,
            granted: false,
            visible: true,
          }),
        state: async () => current,
        control: async () =>
          (current = { ...current, loading: true, error: "" }),
        visibility: async () => {},
        close: async () => {
          current = null;
        },
      },
    };
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  const address = page.getByRole("textbox", { name: "网站地址" });
  await address.fill("https://loading.invalid/");
  await address.press("Enter");
  const waiting = page.getByRole("status", {
    name: "正在加载网页",
    exact: true,
  });
  await expect(waiting).toBeVisible();
  const bounds = await page.locator(".browser-slot").boundingBox();
  await page.evaluate(() => (window as any).__finishPage());
  await expect(waiting).toHaveCount(0);
  expect(await page.locator(".browser-slot").boundingBox()).toEqual(bounds);
  await page.getByRole("button", { name: "重新载入网页", exact: true }).click();
  await expect(waiting).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(waiting.locator("svg")).toHaveCSS("animation-name", "none");
  await page.evaluate(() =>
    (window as any).__finishPage("网页未能载入，请检查地址或重新载入。"),
  );
  await expect(waiting).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("网页未能载入");
  await expect(
    page.getByRole("button", { name: "重新载入网页", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "允许 Agent 协助", exact: true }),
  ).toBeVisible();
});
