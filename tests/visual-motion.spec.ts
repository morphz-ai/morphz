import { test, expect } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

test("半开历史透出真实画布，固定和短窗口回到占位，不缩小书写区", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "视觉材质验收", {
    kind: "document",
    markdown:
      "## 保持工作现场\n\n" +
      Array.from(
        { length: 30 },
        (_, i) =>
          `第 ${i + 1} 段：浮层应该保留底下的文档关系，而不是另一块灰色卡片。`,
      ).join("\n\n"),
  });
  const input = await openInput(page);
  // Frequent input is immediately interactive; do not animate its geometry
  // while a hosted application is establishing its compositor hit surface.
  await expect(page.locator(".composer")).toHaveCSS("animation-name", "none");
  await input.fill("视觉验收草稿，不发送");
  const history = page.locator(".conversation");
  const main = page.getByRole("main", { name: "主工作区" });
  const composer = page.getByRole("region", { name: "AI 输入", exact: true });
  await expect(history).toHaveCSS("position", "absolute");
  await expect(history).toHaveCSS("opacity", "1");
  const backdrop = await history.evaluate((el) => ({
    fill: getComputedStyle(el).backgroundColor,
    blur: getComputedStyle(el).backdropFilter,
    opacity: getComputedStyle(el).opacity,
  }));
  expect(backdrop.fill).toMatch(/rgba\(.+, 0\.[0-9]+\)/);
  expect(backdrop.blur).toContain("blur(20px)");
  const h = (await history.boundingBox())!;
  const m = (await main.boundingBox())!;
  const c = (await composer.boundingBox())!;
  expect(h.y).toBeLessThan(m.y + m.height);
  expect(h.y + h.height).toBeLessThanOrEqual(c.y);
  expect(c.y).toBeGreaterThanOrEqual(m.y + m.height);
  expect(Math.abs(h.x - c.x)).toBeLessThan(2);
  expect(Math.abs(h.width - c.width)).toBeLessThan(2);
  const writingHeight = (await input.boundingBox())!.height;
  expect(writingHeight).toBeGreaterThanOrEqual(60);
  await page.screenshot({ path: "test-results/visual-history-floating.png" });
  await composerAction(page, "固定输入框");
  await expect(history).toHaveCSS("position", "relative");
  const pinnedMain = (await main.boundingBox())!;
  expect((await history.boundingBox())!.y).toBeGreaterThanOrEqual(
    pinnedMain.y + pinnedMain.height,
  );
  await page.getByLabel("取消固定输入框", { exact: true }).click();
  await expect(history).toHaveCSS("position", "absolute");
  await page.setViewportSize({ width: 760, height: 540 });
  await expect(history).toHaveCSS("position", "relative");
  await expect(
    composer.getByRole("button", { name: "保存输入", exact: true }),
  ).toBeInViewport();
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(60);
  await expect(input).toHaveValue("视觉验收草稿，不发送");
});

test("菜单入场不移动命中区域，关闭立即失去交互，动效不延迟焦点", async ({
  page,
}) => {
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("动画期间保留草稿");
  const trigger = page.getByRole("button", {
    name: "工作空间选项",
    exact: true,
  });
  // Keep resolving the same node after inert removes it from the accessibility
  // tree, so the closed-state assertion tests the element rather than lookup.
  const menu = page.getByRole("group", {
    name: "工作空间操作",
    exact: true,
    includeHidden: true,
  });
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveJSProperty("inert", false);
  await expect(menu).toHaveCSS("opacity", "1");
  expect(
    await menu.evaluate((el) => getComputedStyle(el).transitionProperty),
  ).not.toContain("overlay");
  await expect(menu.locator("button:not(:disabled)").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(menu).toHaveJSProperty("inert", true);
  await expect(menu).toBeHidden();
  // Rapid reopen uses the actual button and current popover, not a second layer.
  await trigger.click();
  await expect(menu).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await openInput(page);
  await expect(input).toHaveValue("动画期间保留草稿");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  const search = page.getByRole("dialog", { name: "搜索资料", exact: true });
  await expect(search.locator("input").first()).toBeFocused();
  const frames = await search.evaluate((el) => {
    const motion = el.getAnimations().find((a) => a instanceof CSSAnimation);
    if (!motion) return null;
    motion.pause();
    motion.currentTime = 0;
    const first = Number(getComputedStyle(el).opacity);
    motion.currentTime = 90;
    const middle = Number(getComputedStyle(el).opacity);
    motion.finish();
    return { first, middle, end: Number(getComputedStyle(el).opacity) };
  });
  expect(frames).not.toBeNull();
  expect(frames!.first).toBe(0);
  expect(frames!.middle).toBeGreaterThan(0);
  expect(frames!.middle).toBeLessThan(1);
  expect(frames!.end).toBe(1);
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
});

test("减少动态、减少透明和增强对比度保持所有操作及文本可读", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const input = await openInput(page);
  await input.fill("减少动态效果仍可以正常工作");
  const history = page.locator(".conversation");
  await expect(history).toHaveCSS("animation-name", "none");
  await expect(page.locator(".composer")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  await expect(history).toHaveCSS("backdrop-filter", "none");
  expect(
    await history.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toContain("rgba");
  await composerAction(page, "展开完整记录");
  await expect(input).toHaveValue("减少动态效果仍可以正常工作");
  await page.getByRole("button", { name: "搜索资料", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("animation-name", "none");
  await expect(dialog).toHaveCSS("backdrop-filter", "none");
  await expect(dialog.locator("input").first()).toBeFocused();
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-contrast", value: "more" }],
  });
  await expect(dialog).toHaveCSS("backdrop-filter", "none");
  await page.keyboard.press("Escape");
});
