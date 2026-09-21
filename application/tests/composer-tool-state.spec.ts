import { test, expect, _electron, type Locator } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInput } from "./interaction-helpers.js";

async function paint(button: Locator) {
  return button.evaluate(async (element) => {
    // Capture the settled paint, not a fractional frame of the shadow transition.
    // Keep the real transition enabled; no fixed sleeps or animation override.
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
    const style = getComputedStyle(element);
    const rgb = (color: string) => {
      const context = document.createElement("canvas").getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = (color: number[]) => {
      const linear = color.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    const ink = luminance(rgb(style.color));
    const background = luminance(rgb(style.backgroundColor));
    return {
      color: style.color,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      stroke: getComputedStyle(element.querySelector("svg")!).strokeWidth,
      contrast:
        (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05),
    };
  });
}

test("Dock 选中态独立于悬停和焦点，四主题明暗下可辨认且不移动按钮", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST Dock 状态验收草稿，不发送");
  const tools = page.getByRole("group", { name: "交流面板操作", exact: true });
  const history = tools.getByRole("button", { name: /^(查看|收起)交流记录$/ });
  const pin = tools.getByRole("button", { name: /^(取消)?固定输入框$/ });
  const expand = tools.getByRole("button", {
    name: /^(展开完整记录|返回工作内容)$/,
  });
  const geometry = () =>
    tools.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  // All states are entered through real controls, not by setting aria-pressed.
  for (const appearance of ["light", "dark"]) {
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await page.locator(".app").evaluate(
        (element, theme) => {
          element.setAttribute("data-appearance", theme.appearance);
          element.setAttribute("data-accent", theme.accent);
        },
        { appearance, accent },
      );
      await input.focus();
      await input.hover();
      await expect(history).toHaveAttribute("aria-pressed", "true");
      await expect(pin).toHaveAttribute("aria-pressed", "false");
      const position = await geometry();
      // Wait for the actual color transition before comparing stable states.
      await expect(history).toHaveCSS(
        "color",
        appearance === "light" ? "rgb(31, 32, 36)" : "rgb(244, 244, 246)",
      );
      const selected = await paint(history);
      const normal = await paint(pin);
      expect(selected.color).not.toBe(normal.color);
      expect(selected.background).not.toBe(normal.background);
      expect(selected.shadow).not.toBe(normal.shadow);
      expect(selected.stroke).not.toBe(normal.stroke);
      expect(selected.contrast).toBeGreaterThanOrEqual(4.5);
      await pin.hover();
      await expect
        .poll(async () => (await paint(pin)).background)
        .not.toBe(normal.background);
      expect((await paint(pin)).background).not.toBe(selected.background);
      await pin.click();
      await input.focus();
      await input.hover();
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => paint(pin)).toEqual(selected);
      await pin.hover();
      await expect.poll(() => paint(pin)).toEqual(selected);
      // Space toggles without moving the target or borrowing the focus outline
      // as the only persistent indication of selection.
      await expand.focus();
      await page.keyboard.press("Tab");
      await expect(pin).toBeFocused();
      await expect(pin).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Space");
      await expect(pin).toHaveAttribute("aria-pressed", "false");
      await expect(input).toBeFocused();
      await pin.focus();
      await page.keyboard.press("Space");
      await input.focus();
      await input.hover();
      await expect.poll(() => paint(pin)).toEqual(selected);
      expect(await geometry()).toEqual(position);
      await page.screenshot({
        path: `test-results/dock-selected-${appearance}-${accent}.png`,
      });
      await pin.click();
    }
  }
  await expand.click();
  await expect(expand).toHaveAttribute("aria-pressed", "true");
  await input.focus();
  await input.hover();
  await expect.poll(() => paint(expand)).toEqual(await paint(history));
  await expand.click();
  await history.click();
  await expect(history).toHaveAttribute("aria-pressed", "false");
  await history.click();
  await expect(history).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveValue("TEST Dock 状态验收草稿，不发送");
});

test("生产 Desktop 的 Dock 选中态在窄窗和真实 200% 缩放下清晰可达", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morphz-embedded-electron-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  const desktop = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env: {
      ...env,
      MORPHZ_APP_EMBEDDED_FIXTURE: directory,
      MORPHZ_APP_ENV_FILE: "",
    },
  });
  try {
    await expect
      .poll(() =>
        desktop.windows().some((page) => page.url() === "morphz://app/"),
      )
      .toBe(true);
    const page = desktop
      .windows()
      .find((page) => page.url() === "morphz://app/")!;
    const input = await openInput(page);
    await input.fill("TEST 原生 Dock 验收，不发送");
    await page.getByRole("button", { name: "固定输入框", exact: true }).click();
    const controls = page.getByRole("group", {
      name: "交流面板操作",
      exact: true,
    });
    const pin = controls.getByRole("button", {
      name: "取消固定输入框",
      exact: true,
    });
    for (const [width, zoom] of [
      [1380, 1],
      [760, 1],
      [1380, 2],
    ]) {
      await desktop.evaluate(
        ({ BrowserWindow }, { width, zoom }) => {
          const window = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "morphz://app/",
          )!;
          window.setSize(width, 900);
          window.webContents.setZoomFactor(zoom);
        },
        { width: width!, zoom: zoom! },
      );
      for (const appearance of ["light", "dark"]) {
        await page
          .locator(".app")
          .evaluate(
            (element, appearance) =>
              element.setAttribute("data-appearance", appearance),
            appearance,
          );
        await input.focus();
        await input.hover();
        await expect(pin).toHaveAttribute("aria-pressed", "true");
        await expect(pin).toHaveCSS(
          "color",
          appearance === "light" ? "rgb(31, 32, 36)" : "rgb(244, 244, 246)",
        );
        const selected = await paint(pin);
        expect(selected.contrast).toBeGreaterThanOrEqual(4.5);
        expect(selected.shadow).toContain("inset");
        for (const button of await controls.getByRole("button").all()) {
          await expect(button).toBeInViewport({ ratio: 1 });
          expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(
            32,
          );
        }
        const screenshot = await desktop.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "morphz://app/",
          )!;
          return (await window.webContents.capturePage())
            .toPNG()
            .toString("base64");
        });
        await writeFile(
          `test-results/dock-selected-desktop-${appearance}-${width}-${zoom}.png`,
          Buffer.from(screenshot, "base64"),
        );
      }
    }
    await pin.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 原生 Dock 验收，不发送");
  } finally {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});
