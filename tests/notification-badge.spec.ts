import { test, expect } from "@playwright/test";

test("通知角标固定高度、数字居中、零隐藏、大数封顶且不撑开工具按钮", async ({
  page,
}) => {
  let unread = 1;
  await page.route("**/api/notifications", (route) =>
    route.fulfill({ json: { mode: "all", unread, items: [] } }),
  );
  await page.goto("/");
  for (const appearance of ["亮色", "暗色"]) {
    await page.getByLabel("外观设置", { exact: true }).click();
    await page.getByRole("button", { name: appearance, exact: true }).click();
    await page.keyboard.press("Escape");
    for (const count of [1, 12, 1000, 0]) {
      unread = count;
      await expect(
        page.getByRole("button", {
          name: count ? `通知，${count} 项未读` : "通知",
          exact: true,
        }),
      ).toBeVisible({ timeout: 5000 });
      const trigger = page.locator(".notification-trigger"),
        badge = trigger.locator(".notification-badge");
      await expect(trigger).toHaveCSS("width", "32px");
      if (!count) {
        await expect(badge).toHaveCount(0);
        continue;
      }
      await expect(badge).toHaveText(count > 99 ? "99+" : String(count));
      await expect(badge).toHaveCSS("align-items", "center");
      await expect(badge).toHaveCSS("justify-content", "center");
      await expect(badge).toHaveCSS("pointer-events", "none");
      const b = (await badge.boundingBox())!,
        t = (await trigger.boundingBox())!;
      expect(b.height).toBe(18);
      if (count === 1) expect(b.width).toBe(b.height);
      expect(b.width).toBeLessThan(34);
      expect(b.y).toBe(t.y - 1);
      expect(b.x + b.width).toBe(t.x + t.width + 3);
      expect(
        await badge.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page
        .locator(".sidebar-header")
        .screenshot({
          path: `test-results/notification-badge-${appearance}-${count}.png`,
        });
    }
  }
});
