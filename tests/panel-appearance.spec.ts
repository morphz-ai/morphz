import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";

test("搜索与通知在四主题亮暗模式下保持中性色层次和可见键盘焦点", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "自己写文档", exact: true }).click();
  await page
    .getByLabel("新对象标题", { exact: true })
    .fill("整理品牌与产品资料");
  await page
    .getByLabel("新文档正文")
    .fill(
      "整理产品资料，核对文档、设计方案和本周工作安排。人和 Agent 围绕同一份内容协作。",
    );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText(
    "整理品牌与产品资料",
  );

  for (const appearance of ["亮色", "暗色"]) {
    for (const color of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      await page.getByRole("button", { name: "外观设置", exact: true }).click();
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await page.getByRole("button", { name: color, exact: true }).click();
      await page.keyboard.press("Control+k");
      const search = page.getByRole("dialog", { name: "搜索工作空间" });
      const field = page.getByLabel("全文搜索");
      await expect(field).toBeFocused();
      await expect(search.locator(".search-field")).toHaveCSS(
        "outline-style",
        "none",
      );
      await expect(search.locator(".workspace-search-controls")).toHaveCSS(
        "box-shadow",
        "none",
      );
      await expect(search.locator("article[data-selected=true]")).toHaveCSS(
        "box-shadow",
        "none",
      );
      await expect(search.locator("article[data-selected=true]")).toHaveCSS(
        "background-color",
        appearance === "亮色" ? "rgb(232, 232, 232)" : "rgb(43, 43, 43)",
      );
      await field.fill("产品资料");
      await expect(search.getByText("找到 1 项内容")).toBeVisible();
      const quote = search.getByRole("button", { name: "引用并提问" });
      await expect(quote).toHaveCSS(
        "color",
        appearance === "亮色" ? "rgb(104, 104, 104)" : "rgb(163, 163, 163)",
      );
      await search.screenshot({
        path: `test-results/search-${appearance}-${color}.png`,
      });
      await page.keyboard.press("Tab");
      await expect(search.getByLabel("搜索项目范围")).toBeFocused();
      await expect(search.getByLabel("搜索项目范围")).toHaveCSS(
        "outline-width",
        "2px",
      );
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "通知", exact: true }).click();
      const notifications = page.getByRole("dialog", {
        name: "通知",
        exact: true,
      });
      await expect(
        notifications.getByRole("heading", { name: "通知", exact: true }),
      ).toBeFocused();
      await expect(notifications.locator("input:checked + span")).toHaveCSS(
        "background-color",
        appearance === "亮色" ? "rgb(255, 255, 255)" : "rgb(32, 32, 32)",
      );
      await notifications.screenshot({
        path: `test-results/notifications-${appearance}-${color}.png`,
      });
      await page.keyboard.press("Escape");
    }
  }
});
