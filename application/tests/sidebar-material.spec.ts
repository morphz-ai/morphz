import { test, expect, type Locator } from "@playwright/test";

async function paint(surface: Locator, underlay = "#fff") {
  return surface.evaluate(async (element, underlay) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d")!;
    // Let Chromium resolve CSS color syntax, including color-mix(), then
    // composite transparent controls over their actual opaque sidebar.
    const rgba = (value: string, background?: string) => {
      context.clearRect(0, 0, 1, 1);
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, 1, 1);
      }
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (color: number[]) => {
      const linear = color.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    const background = rgba(style.backgroundColor, underlay);
    const ink = luminance(rgba(style.color));
    const fill = luminance(background);
    return {
      background,
      rawBackground: rgba(style.backgroundColor),
      color: rgba(style.color),
      contrast: (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05),
    };
  }, underlay);
}

test("侧栏四主题明暗使用平面实底，浅主题色选中清晰且不改变布局", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const side = page.getByRole("complementary", { name: "工作空间导航" });
  const selected = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true });
  const other = page.getByRole("button", { name: "工作台", exact: true });
  const initial = await selected.boundingBox();
  for (const mode of ["light", "dark"]) {
    const selections = new Set<string>();
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await page.evaluate(
        ({ mode, accent }) => {
          document.documentElement.dataset.appearance = mode;
          const app = document.querySelector<HTMLElement>(".app")!;
          app.dataset.appearance = mode;
          app.dataset.accent = accent;
        },
        { mode, accent },
      );
      await expect(side).toHaveCSS("opacity", "1");
      const sidebarFill =
        mode === "light" ? "rgb(250, 250, 250)" : "rgb(36, 36, 36)";
      await expect(side).toHaveCSS("background-color", sidebarFill);
      await expect(side).toHaveCSS("background-image", "none");
      await expect(side).toHaveCSS("box-shadow", "none");
      expect((await paint(side)).rawBackground[3]).toBe(255);
      const canvas = await paint(page.locator(".workspace"));
      expect(canvas.rawBackground).toEqual(
        mode === "light" ? [255, 255, 255, 255] : [32, 32, 34, 255],
      );
      await other.hover();
      await expect(selected).toHaveCSS("background-image", "none");
      await expect(other).toHaveCSS("background-image", "none");
      await expect(selected).toHaveCSS("box-shadow", "none");
      const selectedPaint = await paint(selected, sidebarFill);
      const hoveredPaint = await paint(other, sidebarFill);
      expect(selectedPaint.rawBackground[3]).toBe(255);
      expect(selectedPaint.background).not.toEqual(hoveredPaint.background);
      expect(selectedPaint.contrast).toBeGreaterThanOrEqual(4.5);
      expect(hoveredPaint.contrast).toBeGreaterThanOrEqual(4.5);
      selections.add(JSON.stringify(selectedPaint.background));
      const metadata = side.locator(
        ".space-label, .profile-status > span:last-child",
      );
      expect(await metadata.count()).toBeGreaterThanOrEqual(2);
      for (const label of await metadata.all()) {
        await expect(label).toBeVisible();
        expect(
          (await paint(label, sidebarFill)).contrast,
        ).toBeGreaterThanOrEqual(4.5);
      }
      await selected.hover();
      expect((await paint(selected, sidebarFill)).background).toEqual(
        selectedPaint.background,
      );
      expect(await selected.boundingBox()).toEqual(initial);
    }
    expect(selections.size).toBe(4);
    await page.screenshot({
      path: `test-results/sidebar-material-${mode}.png`,
      animations: "disabled",
    });
  }
  await page.keyboard.press("Tab");
  await selected.focus();
  await expect(selected).toBeFocused();
  expect(
    await selected.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe("none");
  for (const width of [1440, 1024, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(selected).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test("原生外观协议与辅助功能保持有效，导航和画布始终使用实底", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const state = {
      revision: 1,
      material: "sidebar",
      active: true,
      reducedTransparency: false,
      highContrast: false,
    };
    let notify: (value: typeof state) => void = () => {};
    (window as any).__materialChange = (change: Partial<typeof state>) =>
      notify({ ...state, ...change, revision: ++state.revision });
    (window as any).morphzDesktop = {
      appearance: {
        setMode: async () => state,
        onChange: (cb: typeof notify) => {
          notify = cb;
          return () => {
            notify = () => {};
          };
        },
      },
    };
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-native-material",
    "sidebar",
  );
  const repeatedMutations = await page.evaluate(async () => {
    const root = document.documentElement;
    let changes = 0;
    const observer = new MutationObserver((records) => {
      changes += records.length;
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: [
        "data-native-material",
        "data-window-active",
        "data-reduced-transparency",
        "data-native-contrast",
      ],
    });
    for (let n = 0; n < 100; n++) (window as any).__materialChange({});
    await Promise.resolve();
    observer.disconnect();
    return changes;
  });
  expect(repeatedMutations).toBe(0);
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "dark";
    document.querySelector<HTMLElement>(".app")!.dataset.appearance = "dark";
  });
  expect((await paint(page.locator(".sidebar"))).rawBackground).toEqual([
    36, 36, 36, 255,
  ]);
  await expect(page.locator(".app")).toHaveCSS(
    "background-color",
    "rgb(25, 25, 27)",
  );
  expect((await paint(page.locator(".workspace"))).rawBackground).toEqual([
    32, 32, 34, 255,
  ]);
  await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.getByRole("button", { name: "显示侧边栏", exact: true }).click();
  const side = page.locator(".sidebar");
  const selected = side.locator('nav button[aria-current="page"]');
  const activeSelection = await paint(selected, "#242424");
  const activeBounds = await selected.boundingBox();
  await page.evaluate(() =>
    (window as any).__materialChange({ active: false }),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-active",
    "false",
  );
  const inactiveSelection = await paint(selected, "#242424");
  expect(inactiveSelection.background).not.toEqual(activeSelection.background);
  expect(inactiveSelection.contrast).toBeGreaterThanOrEqual(4.5);
  expect(await selected.boundingBox()).toEqual(activeBounds);
  expect((await paint(side)).rawBackground).toEqual([36, 36, 36, 255]);
  await page.evaluate(() =>
    (window as any).__materialChange({
      material: "solid",
      reducedTransparency: true,
    }),
  );
  expect((await paint(side)).rawBackground).toEqual([36, 36, 36, 255]);
  await page.evaluate(() =>
    (window as any).__materialChange({
      material: "sidebar",
      reducedTransparency: false,
    }),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  expect((await paint(side)).rawBackground).toEqual([36, 36, 36, 255]);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-contrast", value: "more" }],
  });
  expect((await paint(side)).rawBackground).toEqual([36, 36, 36, 255]);
  await expect
    .poll(() => selected.evaluate((el) => getComputedStyle(el).boxShadow))
    .toContain("inset");
  await page.evaluate(() =>
    (window as any).__materialChange({ material: "solid", highContrast: true }),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-native-contrast",
    "more",
  );
  await expect(side).toHaveCSS("background-image", "none");
  expect((await paint(side)).rawBackground).toEqual([36, 36, 36, 255]);
  await expect
    .poll(() => selected.evaluate((el) => getComputedStyle(el).boxShadow))
    .toContain("inset");
});
