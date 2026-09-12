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

/** Enter the floating tools directly; no menu or input-focus side effects. */
export async function composerAction(page: Page, name: string) {
  const tools = page.getByRole("group", { name: "输入工具", exact: true });
  await tools.hover();
  await expect(tools).toHaveCSS("opacity", "1");
  await tools.screenshot();
  await tools.getByLabel(name, { exact: true }).click();
}

/** Standalone transcription is a content tool, not a second composer mic. */
export async function openTranscription(page: Page) {
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  const menu = page.getByRole("group", { name: "工作空间操作", exact: true });
  await menu.screenshot();
  await menu.getByRole("button", { name: "录音转文字", exact: true }).click();
}
