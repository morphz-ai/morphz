import { expect, type Page } from "@playwright/test";

export async function openSettings(page: Page, section?: string) {
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  if (!(await dialog.isVisible())) {
    const sidebar = page.locator(".sidebar");
    let settings = sidebar.getByRole("button", { name: "设置", exact: true });
    if (!(await settings.isVisible())) {
      await sidebar
        .getByRole("button", { name: "用户菜单", exact: true })
        .filter({ visible: true })
        .click();
      settings = sidebar.getByRole("button", { name: "设置", exact: true });
    }
    await settings.click();
  }
  await expect(dialog).toBeVisible();
  if (section)
    await dialog
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: section, exact: true })
      .click();
  return dialog;
}
