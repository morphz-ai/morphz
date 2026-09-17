/** Exercise the same visible entry as a person; never invoke settings internally. */
export async function openSettings(page, section) {
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  if (!(await dialog.isVisible())) {
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
  }
  if (section)
    await dialog
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: section, exact: true })
      .click();
  return dialog;
}
