import { expect, type Page } from "@playwright/test";
export async function openLibrary(page: Page) {
  const contentToolbar = page.getByRole("banner", { name: "内容工具栏" });
  if (await contentToolbar.isVisible()) {
    // Opening global content enters its own route, not an application tab.
    if (!(await page.locator(".content-actions").isVisible()))
      await contentToolbar
        .getByRole("heading", { name: "内容", exact: true })
        .getByRole("button", { name: "内容", exact: true })
        .click();
    await expect(page.locator(".content-actions")).toBeVisible();
    return;
  }
  const exit = page.getByRole("button", { name: "返回工作空间", exact: true });
  if (await exit.isVisible()) await exit.click();
  await expect(
    page.getByRole("region", { name: "认知应用工作空间" }),
  ).toBeVisible();
  const contents = page.getByRole("button", {
    name: /^查看(?:全部|项目)内容$/,
    exact: true,
  });
  // Let a newly revealed toolbar reach the native compositor before clicking.
  await contents.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await contents.click();
  await expect(page.locator(".content-actions")).toBeVisible();
}
