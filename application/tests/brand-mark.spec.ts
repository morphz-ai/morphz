import { test, expect } from "@playwright/test";

test("亮色品牌标记清亮，四主题保持色相、单色中性且暗色不变", async ({
  page,
}) => {
  await page.goto("/");
  const mark = page.locator(".sidebar .wordmark .brand-mark");
  await expect(mark).toBeVisible();
  const initialBox = await mark.boundingBox();
  const initialPath = await mark.locator("path").getAttribute("d");
  const accents = {
    cyan: { light: "#168997", dark: "#56d0de" },
    iris: { light: "#7357d9", dark: "#a58cff" },
    coral: { light: "#c65e52", dark: "#f08a7e" },
    mono: { light: "#555965", dark: "#d2d3da" },
  };
  for (const [accent, foreground] of Object.entries(accents)) {
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(
        ({ accent, mode }) => {
          document.documentElement.dataset.appearance = mode;
          const app = document.querySelector<HTMLElement>(".app")!;
          app.dataset.appearance = mode;
          app.dataset.accent = accent;
        },
        { accent, mode },
      );
      const colors = await mark.evaluate(
        (element, { accent, mode, expectedForeground }) => {
          const context = document.createElement("canvas").getContext("2d")!;
          const rgba = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          };
          const style = getComputedStyle(element);
          // Resolve the foreground token as an actual CSS color, rather than
          // comparing the unresolved light-dark() token string.
          const probe = document.createElement("span");
          element.parentElement!.append(probe);
          probe.style.color = "var(--accent)";
          const foreground = rgba(getComputedStyle(probe).color);
          probe.style.color =
            mode === "light" && accent !== "mono"
              ? "hsl(from var(--accent) h 90% 60%)"
              : "var(--accent)";
          const expectedMark = rgba(getComputedStyle(probe).color);
          probe.remove();
          return {
            mark: rgba(style.color),
            path: rgba(getComputedStyle(element.querySelector("path")!).fill),
            foreground,
            expectedForeground: rgba(expectedForeground),
            expectedMark,
            shadow: style.boxShadow,
            filter: style.filter,
          };
        },
        { accent, mode, expectedForeground: foreground[mode] },
      );
      expect(colors.foreground).toEqual(colors.expectedForeground);
      expect(colors.mark).toEqual(colors.expectedMark);
      expect(colors.path).toEqual(colors.mark);
      expect(colors.mark[3]).toBe(255);
      expect(colors.shadow).toBe("none");
      expect(colors.filter).toBe("none");
      if (mode === "light" && accent !== "mono") {
        expect(colors.mark).not.toEqual(colors.foreground);
        expect(Math.max(...colors.mark.slice(0, 3))).toBeGreaterThan(
          Math.max(...colors.foreground.slice(0, 3)),
        );
        expect(
          Math.max(...colors.mark.slice(0, 3)) -
            Math.min(...colors.mark.slice(0, 3)),
        ).toBeGreaterThan(
          Math.max(...colors.foreground.slice(0, 3)) -
            Math.min(...colors.foreground.slice(0, 3)),
        );
      } else {
        expect(colors.mark).toEqual(colors.foreground);
      }
      expect(await mark.boundingBox()).toEqual(initialBox);
      expect(await mark.locator("path").getAttribute("d")).toBe(initialPath);
    }
  }
});
