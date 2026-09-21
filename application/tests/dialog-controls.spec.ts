import { test, expect, type Locator } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";
import {
  assertDialogControlMetrics,
  assertSingleFieldDialog,
} from "./dialog-control-helpers.js";

async function assertControlRow(row: Locator) {
  // Read the pair in the same rendered frame; the opening animation translates
  // the entire dialog between two separate boundingBox round trips.
  const { input, button } = await row.evaluate((element) => ({
    input: element.querySelector("input")!.getBoundingClientRect().toJSON(),
    button: element.querySelector("button")!.getBoundingClientRect().toJSON(),
  }));
  expect(input.height).toBeCloseTo(32, 2);
  expect(button.height).toBeCloseTo(input.height, 2);
  if (input.y < button.y && button.x < input.x + input.width)
    expect(button.y).toBeGreaterThanOrEqual(input.y + input.height);
  else expect(button.y).toBeCloseTo(input.y, 2);
}

test("项目表单共用紧凑控件，四主题焦点不重边，窄窗与键盘提交保留", async ({
  page,
}, info) => {
  await page.goto("/");
  const draft = await openInput(page);
  await draft.fill("TEST 弹窗验收保留草稿，不发送");
  const trigger = page.getByRole("button", { name: "新建项目", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
  const field = dialog.getByLabel("项目名称", { exact: true });
  const submit = dialog.getByRole("button", { name: "创建", exact: true });
  await expect(field).toBeFocused();
  await expect(submit).toBeDisabled();
  await assertSingleFieldDialog(dialog);
  await expect(field).toHaveAttribute("placeholder", "项目名称");
  await assertDialogControlMetrics(dialog);
  await assertControlRow(dialog.locator(".dialog-input-row"));
  const title = "TEST 统一弹窗 " + Date.now();
  for (const appearance of ["light", "dark"]) {
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await page.locator(".app").evaluate(
        (element, theme) => {
          element.setAttribute("data-appearance", theme.appearance);
          element.setAttribute("data-accent", theme.accent);
        },
        { appearance, accent },
      );
      await field.focus();
      await expect(field).toHaveCSS("outline-width", "2px");
      await expect(field).toHaveCSS("outline-offset", "-2px");
      await expect(field).toHaveCSS("outline-style", "solid");
      await field.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      expect(
        await field.evaluate((element) => {
          const css = getComputedStyle(element);
          return css.outlineColor === css.borderTopColor;
        }),
      ).toBe(true);
      await assertControlRow(dialog.locator(".dialog-input-row"));
      await assertSingleFieldDialog(dialog);
      await dialog.screenshot({
        path: info.outputPath(`project-${appearance}-${accent}.png`),
      });
    }
  }
  await field.fill(title);
  for (const width of [760, 320]) {
    await page.setViewportSize({ width, height: 640 });
    await assertControlRow(dialog.locator(".dialog-input-row"));
    await assertSingleFieldDialog(dialog);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBe(0);
    await expect(submit).toBeInViewport();
    await dialog.screenshot({ path: info.outputPath(`project-${width}.png`) });
  }
  // Restore the sidebar before checking return focus: at 320px its trigger is hidden.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await openInput(page);
  await expect(draft).toHaveValue("TEST 弹窗验收保留草稿，不发送");
  await trigger.click();
  await field.fill(title);
  await field.press("Tab");
  await expect(submit).toBeFocused();
  await expect(submit).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  const group = page.getByRole("group", {
    name: title + "的会话",
    exact: true,
  });
  await group.getByLabel("项目操作：" + title, { exact: true }).click();
  await page
    .getByRole("group", { name: "项目操作", exact: true })
    .getByRole("button", { name: "重命名项目：" + title, exact: true })
    .click();
  const rename = page.getByRole("dialog", { name: "重命名项目", exact: true });
  await assertControlRow(rename.locator(".dialog-input-row"));
  await assertSingleFieldDialog(rename);
  await page.keyboard.press("Escape");
});

test.describe("触屏弹窗", () => {
  test.use({ hasTouch: true });
  test("紧凑规则不压缩触屏操作目标", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await page.setViewportSize({ width: 390, height: 700 });
    await assertDialogControlMetrics(dialog, 44);
    await expect(
      dialog.getByLabel("项目名称", { exact: true }),
    ).toBeInViewport();
    await expect(dialog.getByLabel("项目名称", { exact: true })).toHaveCSS(
      "font-size",
      "16px",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
