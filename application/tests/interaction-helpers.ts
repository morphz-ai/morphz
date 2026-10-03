import { expect, type Page } from "@playwright/test";

/** Measure the requested palette after finite transitions, not its midpoint. */
export async function settleTransitions(page: Page) {
  // Do not wait on persistent execution/progress animations.
  await page.evaluate(async () => {
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

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

/** Use the same panel action, directly or in its narrow-width overflow menu. */
export async function composerAction(page: Page, name: string) {
  const panel = page.locator(".exchange-panel");
  if (
    ["固定输入框", "取消固定输入框", "展开完整记录", "返回工作内容"].includes(
      name,
    )
  )
    // ResizeObserver can replace More with direct buttons after a viewport
    // change. Wait only for that layout decision before choosing a branch;
    // never retry an already clicked toggle, reopen input, or accept hiding.
    await expect
      .poll(
        () =>
          panel.evaluate((root) => {
            const controls = root.querySelector<HTMLElement>(
              ".exchange-view-tools",
            );
            if (
              !root.hasAttribute("data-open") ||
              !controls ||
              !controls.getClientRects().length
            )
              throw new Error(
                "Exchange controls unexpectedly hidden or missing",
              );
            return (
              controls.hasAttribute("data-compact") === root.clientWidth <= 620
            );
          }),
        {
          timeout: 5000,
          message: "Exchange controls must match the actual panel breakpoint",
        },
      )
      .toBe(true);
  const direct = panel.getByRole("button", { name, exact: true });
  if (await direct.isVisible()) {
    await direct.click();
    return;
  }
  const more = panel.getByRole("button", {
    name: "更多交流选项",
    exact: true,
  });
  if (!(await more.isVisible())) {
    // A missing or incorrectly named wide control remains a real failure.
    await direct.click();
    return;
  }
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  const menu = panel.getByRole("group", { name: "交流选项", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name, exact: true }).click();
}

/** Focus restores writing only; reading requires its explicit panel action. */
export async function openExchangeReading(page: Page) {
  await openInput(page);
  const reading = page.locator(".exchange-panel > .conversation");
  if (!(await reading.isVisible())) await composerAction(page, "查看交流记录");
  await expect(reading).toBeVisible();
  return reading;
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

/** Next-input model and persistent Session permissions share a menu; no send. */
export async function openComposerSettings(page: Page) {
  const trigger = page.getByRole("button", { name: "执行设置", exact: true });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  const menu = page.getByRole("group", {
    name: "执行设置",
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
