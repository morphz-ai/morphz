import { test, expect, type Locator } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

async function material(surface: Locator) {
  await expect(surface).toBeVisible();
  await expect(surface).toHaveCSS("opacity", "1");
  return surface.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      fill: style.backgroundColor,
      edge: style.borderTopColor,
      shadow: style.boxShadow,
      blur: style.backdropFilter,
      radius: style.borderTopLeftRadius,
    };
  });
}

test("外观模式的选中面不与底槽或悬停混淆，系统模式和键盘选择保留", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "外观设置", exact: true }).click();
  const menu = page.getByLabel("外观设置面板");
  const modes = menu.locator(".mode-options");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const name of ["跟随系统", "亮色", "暗色"]) {
      const choice = modes.getByRole("button", { name, exact: true });
      // Start a fresh pointer interaction after the preceding keyboard choice;
      // clicking the already-focused button can retain :focus-visible.
      await menu.getByText("外观模式", { exact: true }).click();
      await choice.click();
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      await expect(modes.locator('[aria-pressed="true"]')).toHaveCount(1);
      const dark =
        name === "暗色" || (name === "跟随系统" && colorScheme === "dark");
      await expect(choice).toHaveCSS(
        "background-color",
        dark ? "rgb(85, 85, 85)" : "rgb(255, 255, 255)",
      );
      await expect(choice).toHaveCSS("box-shadow", "none");
      await expect(choice).toHaveCSS("border-width", "0px");
      await expect(choice).toHaveCSS("outline-style", "none");
      await expect(choice).toHaveCSS(
        "color",
        dark ? "rgb(244, 244, 244)" : "rgb(32, 32, 32)",
      );
      const state = await choice.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          fill: style.backgroundColor,
          track: getComputedStyle(el.parentElement!).backgroundColor,
          ink: style.color,
        };
      });
      expect(state.fill).not.toBe(state.track);
      const contrast = (a: string, b: string) => {
        const luminance = (css: string) => {
          const rgb = css
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
        };
        const [x, y] = [luminance(a), luminance(b)];
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      expect(contrast(state.ink, state.fill)).toBeGreaterThanOrEqual(4.5);
      // Regression floor for the filled selection, not a claim of a complete
      // non-text contrast audit. The previous identical colors had ratio 1.
      expect(contrast(state.fill, state.track)).toBeGreaterThan(1.2);
      const other = modes.getByRole("button", {
        name: name === "跟随系统" ? "亮色" : "跟随系统",
        exact: true,
      });
      await other.hover();
      await expect(choice).toHaveCSS("background-color", state.fill);
      await expect(other).not.toHaveCSS("background-color", state.fill);
      await page.keyboard.press("Tab");
      await other.focus();
      await expect(other).toHaveCSS("outline-width", "2px");
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      await expect(choice).toHaveCSS("font-weight", "600");
      await page.keyboard.press("Enter");
      await expect(other).toHaveAttribute("aria-pressed", "true");
    }
  }
  await modes.getByRole("button", { name: "跟随系统", exact: true }).click();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, contrast: "more" });
    const selected = modes.getByRole("button", {
      name: "跟随系统",
      exact: true,
    });
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect(selected).toHaveCSS(
      "background-color",
      colorScheme === "dark" ? "rgb(85, 85, 85)" : "rgb(255, 255, 255)",
    );
    await menu.getByText("外观模式", { exact: true }).click();
    await expect(selected).toHaveCSS("outline-style", "none");
    await menu.screenshot({
      path: `test-results/appearance-selection-${colorScheme}.png`,
    });
  }
  await page.reload();
  await page.getByRole("button", { name: "外观设置", exact: true }).click();
  await expect(
    modes.getByRole("button", { name: "跟随系统", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("亮暗模式的大弹窗与轻菜单分别共用中性材质、边界和投影", async ({
  page,
}) => {
  await page.goto("/");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const dialogs = [];
    for (const name of ["搜索资料", "通知", "连接详情"]) {
      await page
        .getByRole("complementary", { name: "工作空间导航" })
        .getByRole("button", {
          name: name === "通知" ? /^通知(?:，|$)/ : name,
          exact: name !== "通知",
        })
        .click();
      const dialog = page.getByRole("dialog", { name, exact: true });
      dialogs.push(await material(dialog));
      const mask = await dialog.evaluate(
        (el) => getComputedStyle(el, "::backdrop").backgroundColor,
      );
      expect(mask).toBe(
        colorScheme === "light" ? "rgba(0, 0, 0, 0.12)" : "rgba(0, 0, 0, 0.25)",
      );
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    expect(dialogs[1]).toEqual(dialogs[0]);
    expect(dialogs[2]).toEqual(dialogs[0]);
    expect(dialogs[0]!.radius).toBe("14px");
    expect(dialogs[0]!.blur).toBe("blur(20px)");
    expect(dialogs[0]!.fill).toBe(
      colorScheme === "light"
        ? "rgba(255, 255, 255, 0.98)"
        : "rgba(39, 39, 39, 0.98)",
    );
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    const appearance = await material(page.getByLabel("外观设置面板"));
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "工作空间选项", exact: true })
      .click();
    const menu = page.getByRole("group", { name: "工作空间操作", exact: true });
    const actions = await material(menu);
    expect(actions).toEqual(appearance);
    expect(actions.radius).toBe("10px");
    expect(actions.edge).toBe(dialogs[0]!.edge);
    expect(actions.blur).toBe("blur(20px)");
    expect(actions.fill).toBe(
      colorScheme === "light"
        ? "rgba(255, 255, 255, 0.95)"
        : "rgba(38, 38, 38, 0.95)",
    );
    expect(actions.shadow).not.toBe(dialogs[0]!.shadow);
    await expect(menu.locator("button:not(:disabled)").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "工作空间选项", exact: true }),
    ).toBeFocused();
  }
});

test("弹窗与菜单在系统、原生辅助功能和独立网页上方使用实底", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const cdp = await context.newCDPSession(page);
  await expect(page.locator(".app")).toBeVisible();
  for (const fallback of [
    "transparency",
    "contrast",
    "native-transparency",
    "native-contrast",
    "native-browser",
  ]) {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        {
          name: "prefers-reduced-transparency",
          value: fallback === "transparency" ? "reduce" : "no-preference",
        },
        {
          name: "prefers-contrast",
          value: fallback === "contrast" ? "more" : "no-preference",
        },
      ],
    });
    // Exercise the exact host state contract without changing OS preferences
    // or requiring a separate manually operated Electron window.
    await page.evaluate((fallback) => {
      document.documentElement.dataset.reducedTransparency = String(
        fallback === "native-transparency",
      );
      document.documentElement.dataset.nativeContrast =
        fallback === "native-contrast" ? "more" : "no-preference";
      document
        .querySelector(".app")!
        .classList.toggle(
          "application-browser-workspace",
          fallback === "native-browser",
        );
    }, fallback);
    await page.getByRole("button", { name: "搜索资料", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "搜索资料", exact: true });
    const thick = await material(dialog);
    expect(thick.fill).toBe("rgb(39, 39, 39)");
    expect(thick.blur).toBe("none");
    await expect(dialog.getByLabel("全文搜索")).toBeFocused();
    if (fallback.includes("contrast"))
      expect(thick.edge).toBe("rgb(152, 152, 152)");
    await page.keyboard.press("Escape");
    // The sidebar menu remains available in both native and HTML layouts;
    // native browser chrome and composer geometry have their own regressions.
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    const thin = await material(page.getByLabel("外观设置面板"));
    expect(thin.fill).toBe(thick.fill);
    expect(thin.blur).toBe("none");
    expect(thin.edge).toBe(thick.edge);
    await page.keyboard.press("Escape");
  }
});

test("正文选中文字工具沿用轻菜单材质且保持全不透明文字与实色回退", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "弹出工具材质回归", {
    kind: "document",
    markdown: "选中文字应保持清楚，工具栏不改变正文或自动发送。",
  });
  await page
    .locator(".document-body p")
    .first()
    .evaluate((el) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  const toolbar = page.getByRole("toolbar", { name: "选中文本操作" });
  const style = await material(toolbar);
  expect(style.fill).toBe("rgba(38, 38, 38, 0.95)");
  expect(style.blur).toBe("blur(20px)");
  const action = toolbar.getByRole("button").first();
  await expect(action).toHaveCSS("opacity", "1");
  await expect(action).toHaveCSS("color", "rgb(244, 244, 244)");
  await page.evaluate(() => {
    document.documentElement.dataset.reducedTransparency = "true";
  });
  await expect(toolbar).toHaveCSS("background-color", "rgb(39, 39, 39)");
  await expect(toolbar).toHaveCSS("backdrop-filter", "none");
});
