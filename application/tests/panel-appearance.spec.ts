import { openSettings } from "./settings-helpers.js";
import { seedCenter } from "./center-fixtures.js";
import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";

test("搜索与通知在四主题亮暗模式下保持中性色层次和可见键盘焦点", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  const boot = await (await page.request.get("/api/workspace")).json();
  const label = await page
    .locator(".library-collection")
    .getAttribute("aria-label");
  const project = boot.workspace.projects.find(
    (p: { title: string }) => label === p.title + "的内容",
  );
  await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId: project.id,
      title: "整理品牌与产品资料",
      content: {
        kind: "document",
        markdown:
          "整理产品资料，核对文档、设计方案和本周工作安排。人和 Agent 围绕同一份内容协作。",
      },
    },
    true,
  );
  await page
    .locator(".artifact-card")
    .filter({ hasText: "整理品牌与产品资料" })
    .click();
  await expect(page.locator(".object-paper > h1")).toHaveText(
    "整理品牌与产品资料",
  );

  for (const appearance of ["亮色", "暗色"]) {
    for (const color of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      await openSettings(page, "外观");
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await page.getByRole("button", { name: color, exact: true }).click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      const search = page.getByRole("dialog", { name: "搜索资料" });
      const field = page.getByLabel("全文搜索");
      await expect(field).toBeFocused();
      expect(
        (await search.getByLabel("搜索项目范围").boundingBox())!.width,
      ).toBeLessThan(150);
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
        appearance === "亮色" ? "rgb(228, 228, 228)" : "rgb(58, 58, 58)",
      );
      await field.fill("产品资料");
      await expect(search.getByText("找到 1 项内容")).toBeVisible();
      const quote = search.getByRole("button", {
        name: "AI 交互：整理品牌与产品资料",
        exact: true,
      });
      await expect(quote).toHaveText("AI");
      await expect(quote.locator(".lucide-message-square-quote")).toHaveCount(
        1,
      );
      const aiSurface = await quote.evaluate((button) => {
        // Composite the transparent entry over the selected row, not black.
        const context = document.createElement("canvas").getContext("2d")!;
        const rgb = (value: string, surface?: string) => {
          context.clearRect(0, 0, 1, 1);
          if (surface) {
            context.fillStyle = surface;
            context.fillRect(0, 0, 1, 1);
          }
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return `rgb(${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(",")})`;
        };
        const style = getComputedStyle(button);
        return {
          ink: rgb(style.color),
          background: rgb(
            style.backgroundColor,
            getComputedStyle(button.closest("article")!).backgroundColor,
          ),
        };
      });
      const hierarchy = await search
        .locator("article")
        .first()
        .evaluate((row) => {
          const color = (selector: string) =>
            getComputedStyle(row.querySelector(selector)!).color;
          return {
            title: color("strong"),
            excerpt: color(".search-excerpt"),
            metadata: color(".search-result-meta"),
            background: getComputedStyle(row).backgroundColor,
          };
        });
      expect(
        new Set([hierarchy.title, hierarchy.excerpt, hierarchy.metadata]).size,
      ).toBe(3);
      for (const [ink, background] of [
        [hierarchy.title, hierarchy.background],
        [hierarchy.excerpt, hierarchy.background],
        [hierarchy.metadata, hierarchy.background],
        [aiSurface.ink, aiSurface.background],
      ]) {
        const luminance = (css: string) => {
          const rgb = css
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => v / 255)
            .map((v) =>
              v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
            );
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
        };
        const a = luminance(ink!),
          b = luminance(background!);
        expect(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        ).toBeGreaterThanOrEqual(4.5);
      }
      await search.screenshot({
        path: `test-results/search-${appearance}-${color}.png`,
      });
      await page.keyboard.press("Tab");
      await expect(search.getByLabel("搜索项目范围")).toBeFocused();
      await expect(search.getByLabel("搜索项目范围")).toHaveCSS(
        "outline-width",
        "2px",
      );
      await quote.focus();
      await expect(quote).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^通知(?:，|$)/ }).click();
      const notifications = page.getByRole("dialog", {
        name: "通知",
        exact: true,
      });
      await expect(
        notifications.getByRole("heading", { name: "通知", exact: true }),
      ).toBeFocused();
      const settings = notifications.getByRole("button", {
        name: "通知设置",
        exact: true,
      });
      await settings.click();
      const preferences = page.getByRole("dialog", {
        name: "设置",
        exact: true,
      });
      await expect(preferences.locator("input:checked + span")).toHaveCSS(
        "background-color",
        appearance === "亮色" ? "rgb(255, 255, 255)" : "rgb(48, 48, 48)",
      );
      await preferences.screenshot({
        path: `test-results/notifications-${appearance}-${color}.png`,
      });
      await page.keyboard.press("Escape");
    }
  }
});
