import { test, expect, _electron, type Locator } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composerAction, openInput } from "./interaction-helpers.js";

async function paint(button: Locator) {
  return button.evaluate(async (element) => {
    if (!(element instanceof HTMLButtonElement))
      throw new Error("Contrast helper requires a real button");
    // Capture the settled paint, not a fractional frame of the shadow transition.
    // Keep the real transition enabled; no fixed sleeps or animation override.
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d")!;
    const backgrounds: HTMLElement[] = [];
    for (
      let node: HTMLElement | null = element;
      node;
      node = node.parentElement
    )
      backgrounds.unshift(node);
    // This is CSS background-color ancestry composition, not a screen-pixel
    // sample: it does not claim to model sibling content or backdrop blur.
    // Keep alpha in source-over painting. Transparent is not opaque black.
    for (const node of backgrounds) {
      const layer = getComputedStyle(node);
      if (
        layer.backgroundImage !== "none" ||
        layer.mixBlendMode !== "normal" ||
        Number(layer.opacity) !== 1 ||
        layer.filter !== "none"
      )
        throw new Error(
          "Unsupported contrast background layer: " + node.tagName,
        );
      for (const pseudo of ["::before", "::after"]) {
        const decoration = getComputedStyle(node, pseudo);
        if (decoration.content !== "none" && decoration.content !== "normal")
          throw new Error(
            "Contrast helper cannot model generated decoration: " + pseudo,
          );
      }
      context.fillStyle = layer.backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const compositedBackground = [...context.getImageData(0, 0, 1, 1).data];
    if (compositedBackground[3] !== 255)
      throw new Error(
        "Contrast helper requires a real opaque ancestor background",
      );
    context.fillStyle = style.color;
    context.fillRect(0, 0, 1, 1);
    const compositedInk = [...context.getImageData(0, 0, 1, 1).data];
    const luminance = (color: number[]) => {
      const linear = color.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    const ink = luminance(compositedInk.slice(0, 3));
    const background = luminance(compositedBackground.slice(0, 3));
    return {
      color: style.color,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      stroke: getComputedStyle(element.querySelector("svg")!).strokeWidth,
      compositedBackground: compositedBackground.slice(0, 3),
      compositedInk: compositedInk.slice(0, 3),
      contrast:
        (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05),
    };
  });
}

test("交流控制选中态独立于悬停和焦点，四主题明暗下可辨认且不移动按钮", async ({
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
  // Focus restores writing only. Reading is an explicit panel action, not an
  // implicit side effect of input focus (the old tool-Dock test assumed that).
  await expect(history).toHaveAttribute("aria-pressed", "false");
  await input.focus();
  await input.hover();
  await expect(history).toHaveAttribute("aria-pressed", "false");
  await history.click();
  await expect(history).toHaveAttribute("aria-pressed", "true");
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
      // These are panel-local 28px flat controls, not the media/application
      // Dock's raised 32px surfaces. Selection is fill + stronger ink/stroke.
      expect(selected.shadow).toBe("none");
      expect(normal.shadow).toBe("none");
      expect(normal.background).toBe("rgba(0, 0, 0, 0)");
      expect(selected.stroke).toBe("2px");
      expect(normal.stroke).toBe("1.65px");
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

test("生产 Desktop 的交流选中态在窄窗和真实 200% 缩放下清晰可达", async () => {
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
    await composerAction(page, "固定输入框");
    const controls = page.getByRole("group", {
      name: "交流面板操作",
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
      // Match the real panel decision, not a guessed outer-window breakpoint.
      await expect
        .poll(() =>
          controls.evaluate((element) => {
            const panel = element.closest<HTMLElement>(".exchange-panel")!;
            return (
              element.hasAttribute("data-compact") === panel.clientWidth <= 620
            );
          }),
        )
        .toBe(true);
      const compact = (await controls.getAttribute("data-compact")) === "true";
      for (const appearance of ["light", "dark"])
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
          for (const button of await controls
            .locator(":scope > button")
            .all()) {
            await expect(button).toBeInViewport({ ratio: 1 });
            await expect(button).toHaveCSS("width", "28px");
            await expect(button).toHaveCSS("height", "28px");
            await expect(button.locator(":scope > svg")).toHaveCSS(
              "width",
              "13px",
            );
          }
          const more = controls.getByRole("button", {
            name: "更多交流选项",
            exact: true,
          });
          const menu = controls.getByRole("group", {
            name: "交流选项",
            exact: true,
          });
          if (compact) {
            // Pin is the original text menu row in compact mode. Keep its state
            // and keyboard access without inventing direct-icon-button styling.
            await expect(controls.locator(":scope > button")).toHaveCount(3);
            await more.focus();
            await more.press("Enter");
            await expect(menu).toBeVisible();
          } else
            await expect(controls.locator(":scope > button")).toHaveCount(4);
          const pin = controls.getByRole("button", {
            name: "取消固定输入框",
            exact: true,
          });
          await expect(pin).toHaveAttribute("aria-pressed", "true");
          await expect(pin).toHaveCSS(
            "color",
            compact
              ? appearance === "light"
                ? "rgb(32, 32, 32)"
                : "rgb(244, 244, 244)"
              : appearance === "light"
                ? "rgb(31, 32, 36)"
                : "rgb(244, 244, 246)",
          );
          if (compact) {
            await pin.focus();
            await pin.press("Escape");
            await expect(more).toBeFocused();
            await expect(menu).not.toBeVisible();
            await more.press("Enter");
            await expect(menu).toBeVisible();
            await input.hover();
            // The first menu row has focus; pin is neither hovered nor focused.
            // Outside focus intentionally dismisses this nonmodal popover.
            await expect(pin).not.toBeFocused();
            await expect(pin).toHaveAttribute("aria-pressed", "true");
            await expect(pin).toBeInViewport({ ratio: 1 });
            await expect(pin).toHaveCSS("min-height", "32px");
          }
          const selected = await paint(pin);
          expect(selected.contrast).toBeGreaterThanOrEqual(4.5);
          if (!compact) {
            expect(selected.shadow).toBe("none");
            expect(selected.stroke).toBe("2px");
            expect(selected.background).not.toBe("rgba(0, 0, 0, 0)");
            await pin.hover();
            await expect.poll(() => paint(pin)).toEqual(selected);
          }
          const screenshot = await desktop.evaluate(
            async ({ BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows().find(
                (window) => window.webContents.getURL() === "morphz://app/",
              )!;
              return (await window.webContents.capturePage())
                .toPNG()
                .toString("base64");
            },
          );
          await writeFile(
            `test-results/exchange-selected-desktop-${appearance}-${accent}-${width}-${zoom}.png`,
            Buffer.from(screenshot, "base64"),
          );
          if (compact) {
            await input.focus();
            await expect(menu).not.toBeVisible();
            await more.focus();
            await more.press("Enter");
            await expect(pin).toHaveAttribute("aria-pressed", "true");
            await pin.press("Escape");
            await expect(more).toBeFocused();
            await expect(menu).not.toBeVisible();
          }
        }
    }
    await composerAction(page, "取消固定输入框");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 原生 Dock 验收，不发送");
  } finally {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CSS contrast helper composes transparent/alpha ancestor backgrounds and refuses unsupported layers", async ({
  page,
}) => {
  // A standalone controlled document, not production DOM or screen pixels.
  await page.setContent(`<html><body style="background:rgb(255,255,255)">
    <div style="background:rgb(20,30,40)"><button id="transparent" style="color:rgb(255,255,255);background:transparent;border:0"><svg/></button></div>
    <div style="background:rgb(0,0,0)"><div style="background:rgba(255,255,255,.5)"><button id="alpha" style="color:rgba(255,255,255,.5);background:transparent;border:0"><svg/></button></div></div>
    <button id="white" style="color:rgb(0,0,0);background:transparent;border:0"><svg/></button>
    <button id="unsupported" style="color:rgb(0,0,0);background-image:linear-gradient(white,black)"><svg/></button>
  </body></html>`);
  const transparent = await paint(page.locator("#transparent"));
  expect(transparent.compositedBackground).toEqual([20, 30, 40]);
  expect(transparent.compositedInk).toEqual([255, 255, 255]);
  expect(transparent.contrast).toBeGreaterThanOrEqual(4.5);
  const alpha = await paint(page.locator("#alpha"));
  expect(alpha.compositedBackground).toEqual([128, 128, 128]);
  expect(alpha.compositedInk).toEqual([192, 192, 192]);
  const white = await paint(page.locator("#white"));
  expect(white.compositedBackground).toEqual([255, 255, 255]);
  expect(white.contrast).toBe(21);
  await expect(paint(page.locator("#unsupported"))).rejects.toThrow(
    "Unsupported contrast background layer",
  );
  await page.locator("body").evaluate((element) => {
    element.style.background = "transparent";
  });
  await expect(paint(page.locator("#white"))).rejects.toThrow(
    "real opaque ancestor background",
  );
});
