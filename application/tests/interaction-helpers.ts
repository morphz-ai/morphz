import { expect, type Page } from "@playwright/test";

/** The shell toggle controls visibility; the subject tab chooses activity. */
export async function openExecutionPanel(page: Page) {
  if (!(await page.locator(".workspace-inspector").isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await page
    .getByRole("complementary", { name: "Morphz 信息", exact: true })
    .getByRole("tab", { name: "活动", exact: true })
    .click();
}

/** Returning to work does not force its unpinned composer open. */
export async function openInput(page: Page) {
  const input = page.getByLabel("AI 输入内容");
  const reopen = page.locator(".composer-reopen");
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

/** Use the existing direct action in its input or panel group; never a menu. */
export async function composerAction(page: Page, name: string) {
  await page
    .locator(".exchange-panel")
    .getByLabel(name, { exact: true })
    .click();
}

/** Files and screenshots share the explicit + input menu, not the app Dock. */
export async function openComposerMedia(page: Page) {
  const trigger = page.getByRole("button", {
    name: "添加输入内容",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  const menu = page.getByRole("group", { name: "添加到这条消息", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Next-input configuration is inside one setting menu; it never sends. */
export async function openComposerSettings(page: Page) {
  const trigger = page.getByRole("button", { name: "执行设置", exact: true });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  const menu = page.getByRole("group", {
    name: "本次输入执行设置",
    exact: true,
  });
  await expect(menu).toBeVisible();
  return menu;
}

/** Standalone transcription is a content tool, not a second composer mic. */
export async function openTranscription(page: Page) {
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  const menu = page.getByRole("group", { name: "工作空间操作", exact: true });
  await menu.screenshot();
  await menu.getByRole("button", { name: "录音转文字", exact: true }).click();
}
