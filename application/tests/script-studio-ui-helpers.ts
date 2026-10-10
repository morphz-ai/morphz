import type { Page } from "@playwright/test";

/** The real Studio's compact auxiliary controls, not hidden tab click hacks. */
export async function selectScriptOption(page: Page, name: string | RegExp) {
  const control = page.getByRole("button", {
    name,
    exact: typeof name === "string",
  });
  if (!(await control.isVisible()))
    await page.getByRole("button", { name: /^(文稿选项|剧本选项)$/ }).click();
  await control.click();
}
