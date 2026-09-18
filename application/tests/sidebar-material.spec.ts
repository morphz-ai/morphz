import { test, expect } from "@playwright/test";

test("侧栏材质四主题明暗一致，选中与悬停分层且不改变布局", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const side = page.getByRole("complementary", { name: "工作空间导航" });
  const selected = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true });
  const other = page.getByRole("button", { name: "工作台", exact: true });
  const initial = await selected.boundingBox();
  for (const mode of ["light", "dark"]) {
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
      if (mode === "dark") {
        await expect(side).toHaveCSS("background-color", "rgb(36, 36, 36)");
        const wash = await side.evaluate(
          (el) => getComputedStyle(el).backgroundImage,
        );
        const colors = [
          ...wash.matchAll(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/g),
        ];
        expect(colors.length).toBeGreaterThanOrEqual(2);
        for (const color of colors) {
          expect(color[1]).toBe(color[2]);
          expect(color[2]).toBe(color[3]);
        }
      }
      expect(
        await side.evaluate((el) => getComputedStyle(el).backgroundImage),
      ).toContain("linear-gradient");
      await other.hover();
      expect(
        await selected.evaluate((el) => getComputedStyle(el).backgroundImage),
      ).toContain("linear-gradient");
      await expect(other).toHaveCSS("background-image", "none");
      expect(
        await selected.evaluate((el) => getComputedStyle(el).boxShadow),
      ).toContain("inset");
      await selected.hover();
      expect(await selected.boundingBox()).toEqual(initial);
    }
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

test("原生材质只透出侧栏，辅助功能与旧壳保留实底", async ({
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
  const nativeFill = await page
    .locator(".sidebar")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(
    nativeFill
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number),
  ).toEqual([27, 27, 27]);
  await expect(page.locator(".app")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  expect(
    await page
      .locator(".workspace")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toContain("rgba");
  await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.getByRole("button", { name: "显示侧边栏", exact: true }).click();
  const side = page.locator(".sidebar");
  await page.evaluate(() =>
    (window as any).__materialChange({ active: false }),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-active",
    "false",
  );
  await page.evaluate(() =>
    (window as any).__materialChange({
      material: "solid",
      reducedTransparency: true,
    }),
  );
  expect(
    await side.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toContain("rgba");
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
  expect(
    await side.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toContain("rgba");
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-contrast", value: "more" }],
  });
  expect(
    await side.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toContain("rgba");
  await page.evaluate(() =>
    (window as any).__materialChange({ material: "solid", highContrast: true }),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-native-contrast",
    "more",
  );
});
