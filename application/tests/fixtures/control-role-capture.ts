import assert from "node:assert/strict";
import type { CDPSession, Page } from "@playwright/test";

/** Screenshot observation must preserve the fixture's native input device. */
export async function captureControlRolePaint(
  page: Page,
  session: CDPSession,
  hasTouch: boolean,
  options: NonNullable<Parameters<Page["screenshot"]>[0]> = {},
) {
  const input = () =>
    page.evaluate(() => ({
      touchPoints: navigator.maxTouchPoints,
      coarse: matchMedia("(pointer: coarse)").matches,
      fine: matchMedia("(pointer: fine)").matches,
    }));
  const before = await input();
  assert.equal(before.touchPoints, hasTouch ? 1 : 0, "native input premise");
  assert.equal(before.coarse, hasTouch, "native pointer premise");
  const image = await page.screenshot(options);
  const captured = await input();
  if (
    hasTouch &&
    captured.touchPoints === 0 &&
    !captured.coarse &&
    captured.fine
  ) {
    // Chromium capture can replace WebPreferences and clear touch emulation.
    // Restore the original native fixture setting, never override matchMedia.
    // The caller owns this session until page close: detach also clears it.
    // Do not reset an unchanged device: that cancels a held mouse gesture.
    // https://github.com/microsoft/playwright/issues/42607
    await session.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
    });
  }
  assert.deepEqual(await input(), before, "capture preserves native input");
  return image;
}
