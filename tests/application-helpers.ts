import { expect, type Page } from "@playwright/test";
export async function openLibrary(page: Page) {
  await expect(
    page.getByRole("region", { name: "认知应用工作空间" }),
  ).toBeVisible();
  const tab = page.getByRole("tab", { name: "资料", exact: true });
  if (await tab.count()) await tab.click();
  else {
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await page.getByRole("listitem", { name: "资料 1.0.0" }).dblclick();
  }
  const back = page.getByRole("button", { name: "所有资料", exact: true });
  if (await back.count()) await back.click();
  await expect(page.locator(".creation-actions")).toBeVisible();
}
