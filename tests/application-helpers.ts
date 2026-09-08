import { expect, type Page } from "@playwright/test";
export async function openLibrary(page: Page) {
  await expect(
    page.getByRole("region", { name: "认知应用工作空间" }),
  ).toBeVisible();
  const tab = page.getByRole("tab", { name: "资料", exact: true });
  if (await tab.count()) await tab.click();
  else {
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await page.getByRole("button", { name: "资料 1.0.0", exact: true }).click();
  }
  const back = page.getByRole("button", { name: "所有资料", exact: true });
  // Reopening an application asynchronously restores its last object. Wait for
  // that surface before returning to the collection; a one-shot count can see
  // the transient empty view and skip the required back action.
  await expect(async () => {
    if (await back.isVisible()) await back.click({ timeout: 1000 });
    await expect(page.locator(".creation-actions")).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 6000 });
}
