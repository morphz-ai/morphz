import { expect, type Page } from "@playwright/test";

/** Returning to work does not force its unpinned composer open. */
export async function openInput(page: Page) {
  const input = page.getByLabel("AI 输入内容");
  const reopen = page.getByRole("button", { name: /向 Morphz 输入/ });
  await expect(input.or(reopen)).toBeVisible();
  // A preceding outside click may still be completing the next-frame collapse.
  // Re-resolve both states instead of waiting forever on a textarea that unmounted.
  await expect(async () => {
    if (await reopen.isVisible()) await reopen.click({ timeout: 1000 });
    await input.focus({ timeout: 1000 });
    await expect(input).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 5000 });
  // Focus/layout can resolve before an out-of-process application iframe has
  // presented its resized hit-test surface. Wait for the visible frame, not
  // an arbitrary timeout, before the next real mouse action.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
  return input;
}

/** Low-frequency composer actions are reached through More, not hidden buttons. */
export async function composerAction(page: Page, name: string) {
  const action = page.getByLabel(name, { exact: true });
  if (!(await action.isVisible()))
    await page.getByLabel("更多输入选项", { exact: true }).click();
  // Native popovers above an out-of-process app frame can enter the DOM before
  // Chromium presents their hit-test surface. Capture the visible menu before
  // sending a physical mouse click, rather than bypassing it with dispatchEvent.
  await page.getByRole("group", { name: "输入选项", exact: true }).screenshot();
  await action.click();
}
