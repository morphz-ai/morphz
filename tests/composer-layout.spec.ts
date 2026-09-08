import { test, expect } from "@playwright/test";
import { composerAction } from "./interaction-helpers.js";

test("全宽输入、轻量意图和更多菜单在明暗与窄窗口中可用", async ({ page }) => {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    body.runtime = {
      ...body.runtime,
      configured: true,
      connected: true,
      model: "fixture-model",
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await page.getByRole("button", { name: "新建事项", exact: true }).click();
  const input = page.getByLabel("AI 输入内容");
  const composer = page.locator(".composer");
  await input.fill(
    "整理下一阶段的工作安排，先形成草稿。\n确认之后再决定负责人和时间。",
  );
  await composerAction(page, "固定输入框");
  for (const theme of ["dark", "light"]) {
    // Appearance is a renderer-only setting in this isolated fixture.
    await page
      .locator(".app")
      .evaluate(
        (el, appearance) => el.setAttribute("data-appearance", appearance),
        theme,
      );
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await input.focus();
      const text = (await input.boundingBox())!;
      const writing = (await composer
        .locator(".composer-writing")
        .boundingBox())!;
      expect(text.width).toBe(writing.width);
      expect(text.y + text.height).toBeLessThanOrEqual(
        (await composer.locator(".composer-actions").boundingBox())!.y,
      );
      expect(
        await composer.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expect(
        composer.getByText("fixture-model", { exact: true }),
      ).toBeHidden();
      await expect(composer.locator(".brand-mark")).toHaveCount(0);
      expect(
        await composer.evaluate((el) => getComputedStyle(el).boxShadow),
      ).toBe("none");
      await composer.screenshot({
        path: `test-results/composer-clean-${theme}-${width}.png`,
      });
      await page.getByLabel("更多输入选项").click();
      const menu = page.getByRole("group", { name: "输入选项" });
      await expect(menu.getByText("fixture-model")).toBeVisible();
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
      await page.keyboard.press("Escape");
      await expect(page.getByLabel("更多输入选项")).toBeFocused();
    }
  }
  await expect(input).toHaveValue(
    "整理下一阶段的工作安排，先形成草稿。\n确认之后再决定负责人和时间。",
  );
  await page.getByLabel("移除输入意图").click();
  await expect(input).toBeFocused();
  await expect(composer.locator(".composer-intent")).toHaveCount(0);
});
