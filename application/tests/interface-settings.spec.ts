import { test, expect } from "@playwright/test";
import { openSettings } from "./settings-helpers.js";
import { openInput } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

test("外观快捷按钮保留原位置和选择行为，并与统一设置同步", async ({ page }) => {
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("TEST 外观设置切换保留草稿");
  const trigger = page.getByRole("button", { name: "外观设置", exact: true });
  const menu = page.getByRole("group", { name: "外观设置面板", exact: true });
  await trigger.click();
  await menu.getByRole("button", { name: "亮色", exact: true }).click();
  await expect(menu).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute(
    "data-appearance",
    "light",
  );
  await menu.getByRole("button", { name: "鸢尾紫", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  const settings = await openSettings(page, "外观");
  await expect(
    settings.getByRole("button", { name: "亮色", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    settings.getByRole("button", { name: "鸢尾紫", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await settings.getByRole("button", { name: "暗色", exact: true }).click();
  await page.keyboard.press("Escape");
  await trigger.press("Enter");
  await expect(
    menu.getByRole("button", { name: "暗色", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await menu.getByRole("button", { name: "更多外观设置", exact: true }).click();
  await expect(settings.getByLabel("阅读字号")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await openInput(page);
  await expect(input).toHaveValue("TEST 外观设置切换保留草稿");
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-appearance", "dark");
  await expect(page.locator(".app")).toHaveAttribute("data-accent", "iris");
});

test("发送快捷键可切换并持久化，换行和输入法不误提交", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 默认 Enter 发送");
  await input.press("Enter");
  await expect(input).toBeEmpty();
  await expect(
    page.locator(".human-message").filter({ hasText: "TEST 默认 Enter 发送" }),
  ).toHaveCount(1);
  await input.fill("TEST 设置期间保留正文");
  const settings = await openSettings(page, "输入");
  await settings.getByLabel("发送快捷键").selectOption("mod-enter");
  await expect(settings).toContainText("Enter 换行");
  await page.keyboard.press("Escape");
  await input.press("Enter");
  await expect(input).toHaveValue("TEST 设置期间保留正文\n");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("TEST 设置期间保留正文\n\n");
  const before = await (await page.request.get("/api/workspace")).json();
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    metaKey: true,
    isComposing: true,
  });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    ctrlKey: true,
    keyCode: 229,
  });
  await expect(input).toHaveValue("TEST 设置期间保留正文\n\n");
  expect(
    (await (await page.request.get("/api/workspace")).json()).workspace.inputs
      .length,
  ).toBe(before.workspace.inputs.length);
  await page.reload();
  await expect(input).toHaveValue("TEST 设置期间保留正文\n\n");
  await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  await input.press("Enter");
  await expect(input).toHaveValue("TEST 设置期间保留正文\n\n\n");
  await input.press("ControlOrMeta+Enter");
  await expect(input).toBeEmpty();
  expect(
    (await (await page.request.get("/api/workspace")).json()).workspace.inputs
      .length,
  ).toBe(before.workspace.inputs.length + 1);
});

test("阅读字号真实改变文档和消息，刷新保持且不修改正文或导航字号", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  const markdown =
    "## 阅读测试\n\n这是一份不应被外观设置修改的文档。\n\n```js\nconst value = 1;\n```";
  await seedLibraryArtifact(page, "TEST 阅读字号", {
    kind: "document",
    markdown,
  });
  const document = page.locator(".document-body");
  const bodyBefore = await document.textContent();
  const navigation = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true });
  const navSize = await navigation.evaluate(
    (el) => getComputedStyle(el).fontSize,
  );
  const settings = await openSettings(page, "外观");
  await settings.getByLabel("阅读字号").selectOption("larger");
  await expect(settings.locator(".reading-size-preview")).toHaveCSS(
    "font-size",
    "19px",
  );
  await page.keyboard.press("Escape");
  await expect(document).toHaveCSS("font-size", "19px");
  await expect(document.locator("pre")).toHaveCSS("font-size", "16px");
  await expect(navigation).toHaveCSS("font-size", navSize);
  expect(await document.textContent()).toBe(bodyBefore);
  await page.reload();
  await expect(document).toHaveCSS("font-size", "19px");
  expect(await document.textContent()).toBe(bodyBefore);
  await navigation.click();
  const input = await openInput(page);
  await input.fill("TEST 消息字号");
  await input.press("Enter");
  await expect(
    page
      .locator(".human-message")
      .filter({ hasText: "TEST 消息字号" })
      .locator(":scope > p"),
  ).toHaveCSS("font-size", "19px");
});

test("减少动画立即生效且不覆盖系统偏好，窄窗所有设置可操作", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const settings = await openSettings(page, "外观");
  await settings.getByLabel("动画效果").selectOption("reduce");
  await expect(settings).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await page.reload();
  for (const width of [1380, 760, 380, 320]) {
    await page.setViewportSize({ width, height: 540 });
    const trigger = page.getByRole("button", { name: "外观设置", exact: true });
    await expect(trigger).toBeInViewport();
    await trigger.click();
    const menu = page.getByRole("group", { name: "外观设置面板", exact: true });
    await expect(menu).toBeInViewport();
    await expect(menu.locator(".appearance-settings")).toHaveCSS(
      "animation-name",
      "none",
    );
    await menu
      .getByRole("button", { name: "更多外观设置", exact: true })
      .click();
    await expect(settings.getByLabel("动画效果")).toHaveValue("reduce");
    await settings.getByLabel("阅读字号").selectOption("large");
    expect(
      await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await settings.getByLabel("动画效果").selectOption("reduce");
    await page.screenshot({
      path: `test-results/interface-settings-${width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await openSettings(page, "外观");
  await settings.getByLabel("动画效果").selectOption("system");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettings(page, "外观");
  await expect(settings).toHaveCSS("animation-name", "none");
});
