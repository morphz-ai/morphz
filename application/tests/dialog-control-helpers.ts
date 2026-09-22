import { expect, type Locator } from "@playwright/test";

/** A one-field dialog is a title and one input/action row, not a miniature form. */
export async function assertSingleFieldDialog(dialog: Locator) {
  await expect(dialog.locator("label:visible")).toHaveCount(0);
  const layout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const header = element.querySelector("header")!.getBoundingClientRect();
    const input = element.querySelector("input")!.getBoundingClientRect();
    const action = element
      .querySelector("button.primary")!
      .getBoundingClientRect();
    return {
      height: bounds.height,
      gap: input.top - header.bottom,
      inputY: input.top,
      actionY: action.top,
    };
  });
  expect(layout.gap).toBeGreaterThanOrEqual(0);
  expect(layout.gap).toBeLessThanOrEqual(4);
  expect(layout.actionY).toBeCloseTo(layout.inputY, 2);
  // No reserved label/footer rows. Scope descriptions and errors may add height.
  if (!(await dialog.locator('[role="alert"]').count()))
    expect(layout.height).toBeLessThanOrEqual(96);
}

/** Check rendered controls across the real dialog variants, not CSS source. */
export async function assertDialogControlMetrics(dialog: Locator, height = 32) {
  const controls = await dialog.evaluate((element) =>
    [
      ...element.querySelectorAll(
        'input:not([type="checkbox"], [type="radio"], [type="file"], [type="range"], [type="color"], [type="hidden"]), select:not([multiple], [size]), .primary, .secondary-action:not(.model-service-button), footer button, .bookmark-edit-actions button',
      ),
    ]
      .filter((control) => control.getClientRects().length)
      .map((control) => ({
        name:
          control.getAttribute("aria-label") ||
          control.textContent ||
          control.tagName,
        height: control.getBoundingClientRect().height,
        lineHeight: getComputedStyle(control).lineHeight,
        nativeSelect: control instanceof HTMLSelectElement,
      })),
  );
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.height, control.name).toBeCloseTo(height, 2);
    // Chromium's native select reports "normal" even with a specified line-height.
    // Its actual border-box height above must still match adjacent actions.
    if (!control.nativeSelect)
      expect(control.lineHeight, control.name).toBe("20px");
  }
}
