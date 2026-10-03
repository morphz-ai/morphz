import { expect, type Locator, type Page } from "@playwright/test";

type WorkSource = { inputId: string; body: string };

async function expectWorkSource(message: Locator, source: WorkSource) {
  await expect(message).toHaveAttribute("data-input-id", source.inputId);
  await expect(message.locator(":scope > p")).toHaveText(source.body);
}

/** The inspectable card has a pointer handler, not a button role. Click its
 * original body, then verify the exact source's branch in the activity panel. */
export async function inspectExchangeWork(
  page: Page,
  message: Locator,
  source: WorkSource & { threadId: string },
) {
  await expectWorkSource(message, source);
  await expect(message).toHaveAttribute("data-execution-inspectable", "true");
  await message.locator(":scope > p").click();
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".execution-origin > p")).toHaveText(source.body);
  await expect(
    panel
      .getByRole("region", { name: "执行分支", exact: true })
      .locator(`[data-thread-id=${JSON.stringify(source.threadId)}]`),
  ).toBeVisible();
  return panel;
}

/** Opacity-zero footer controls are not an available pointer action. Reveal
 * the real footer before using an ordinary, fully actionable click. */
export async function supplementExchangeWork(
  page: Page,
  message: Locator,
  source: WorkSource,
) {
  await expectWorkSource(message, source);
  await expect(message).toHaveAttribute("data-supplement-target", "true");
  await message.hover();
  const actions = message.locator(".message-work-actions");
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(actions).toHaveCSS("pointer-events", "auto");
  const action = actions.getByRole("button", {
    name: "补充要求",
    exact: true,
  });
  await expect(action).toBeVisible();
  await expect(action).toBeEnabled();
  await action.click();
  await expect(
    page.getByRole("group", { name: "补充目标", exact: true }),
  ).toContainText(source.body);
}
