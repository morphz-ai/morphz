import type { Page } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import {
  openInput,
  openExecutionPanel,
  settleTransitions,
} from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

const draft = "TEST 三栏中性表面：仅检查外观与布局，不发送。";
const appearances = [
  ["亮色", "light"],
  ["暗色", "dark"],
] as const;
const accents = [
  ["电光青", "cyan"],
  ["鸢尾紫", "iris"],
  ["暖珊瑚", "coral"],
  ["纯单色", "mono"],
] as const;

async function chooseAppearance(
  page: Page,
  label: string,
  mode: string,
  accentLabel: string,
  accent: string,
) {
  const settings = await openSettings(page, "外观");
  await settings.getByRole("button", { name: label, exact: true }).click();
  await settings
    .getByRole("button", { name: accentLabel, exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app")).toHaveAttribute("data-appearance", mode);
  await expect(page.locator(".app")).toHaveAttribute("data-accent", accent);
  await settleTransitions(page);
}

async function shellPaint(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector<HTMLElement>(".app")!;
    // Resolve the shared semantic recipe through Chromium in its actual App
    // scope; custom-property text alone does not resolve light-dark().
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--sidebar-base)";
    probe.style.borderColor = "var(--sidebar-edge)";
    app.append(probe);
    const semantic = getComputedStyle(probe);
    const sharedSurface = semantic.backgroundColor;
    const sharedEdge = semantic.borderLeftColor;
    probe.remove();
    const read = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)!;
      const style = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        image: style.backgroundImage,
        opacity: style.opacity,
        borderLeft: {
          color: style.borderLeftColor,
          width: style.borderLeftWidth,
          style: style.borderLeftStyle,
        },
        borderRight: {
          color: style.borderRightColor,
          width: style.borderRightWidth,
          style: style.borderRightStyle,
        },
        rect: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
      };
    };
    return {
      sharedSurface,
      sharedEdge,
      left: read(".sidebar"),
      right: read(".workspace-inspector"),
      workspace: read(".workspace"),
      center: read(".primary-panel"),
      topbar: read(".topbar"),
      mode: document
        .querySelector(".workspace-inspector")!
        .getAttribute("data-inspector-mode"),
    };
  });
}

async function expectSharedSurface(page: Page, appearance: string) {
  const paint = await shellPaint(page);
  const surface =
    appearance === "light" ? "rgb(250, 250, 250)" : "rgb(36, 36, 36)";
  const paper =
    appearance === "light" ? "rgb(255, 255, 255)" : "rgb(32, 32, 34)";
  expect(paint.sharedSurface).toBe(surface);
  for (const side of [paint.left, paint.right]) {
    expect(side.background).toBe(paint.sharedSurface);
    expect(side.image).toBe("none");
    expect(side.opacity).toBe("1");
  }
  for (const center of [paint.workspace, paint.center, paint.topbar])
    expect(center.background).toBe(paper);
  expect(paint.left.borderRight).toEqual({
    color: paint.sharedEdge,
    width: "1px",
    style: "solid",
  });
  expect(paint.right.borderLeft).toEqual(paint.left.borderRight);
  return paint;
}

async function preserveBusinessState(page: Page) {
  const client = await conversationClient(page);
  const snapshot = async () => ({
    conversations: await client.allNavigationConversations(),
    drafts: await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.includes(":draft:") && key.endsWith(":inputs"))
          .sort()
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    ),
  });
  const before = await snapshot();
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method()) && path.startsWith("/api/"))
      writes.push(`${request.method()} ${path}`);
  });
  return async () => {
    expect(
      writes,
      "Theme, sidebar and accessibility choices do not authorize business writes",
    ).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await openInput(page)).toHaveValue(draft);
  };
}

test("真实三栏四主题亮暗共享中性侧面；主画布和既有栏宽不变", async ({
  page,
  messageHost,
}, info) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await (await openInput(page)).fill(draft);
  await openExecutionPanel(page);
  const unchanged = await preserveBusinessState(page);
  const deliveries = structuredClone(messageHost.deliveries());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const receipts = [];
  let geometry: unknown;
  for (const [label, appearance] of appearances) {
    for (const [accentLabel, accent] of accents) {
      await chooseAppearance(page, label, appearance, accentLabel, accent);
      const paint = await expectSharedSurface(page, appearance);
      expect(paint.mode).toBe("docked");
      expect(paint.left.rect.width).toBe(280);
      expect(paint.right.rect.width).toBe(340);
      const currentGeometry = [
        paint.left.rect,
        paint.right.rect,
        paint.workspace.rect,
        paint.center.rect,
        paint.topbar.rect,
      ];
      if (!geometry) geometry = currentGeometry;
      expect(currentGeometry).toEqual(geometry);
      receipts.push({ appearance, accent, paint });
      await page.screenshot({
        path: info.outputPath(`shell-surfaces-${appearance}-${accent}.png`),
        fullPage: true,
      });
    }
  }
  await info.attach("actual-shell-surface-paint", {
    body: JSON.stringify(receipts, null, 2),
    contentType: "application/json",
  });
  expect(messageHost.deliveries()).toEqual(deliveries);
  expect(errors).toEqual([]);
  await unchanged();
});

test("共享侧面在减少透明／增强对比度、显隐和窄窗覆盖时仍有效且不丢草稿", async ({
  page,
  context,
  messageHost,
}, info) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await (await openInput(page)).fill(draft);
  await openExecutionPanel(page);
  const unchanged = await preserveBusinessState(page);
  const deliveries = structuredClone(messageHost.deliveries());
  const cdp = await context.newCDPSession(page);
  const receipts = [];
  try {
    for (const [label, appearance] of appearances) {
      await chooseAppearance(page, label, appearance, "纯单色", "mono");
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-transparency", value: "reduce" },
          { name: "prefers-contrast", value: "more" },
        ],
      });
      expect(
        await page.evaluate(() => [
          matchMedia("(prefers-reduced-transparency: reduce)").matches,
          matchMedia("(prefers-contrast: more)").matches,
        ]),
      ).toEqual([true, true]);
      await settleTransitions(page);
      const paint = await expectSharedSurface(page, appearance);
      const ink =
        appearance === "light" ? "rgb(31, 32, 36)" : "rgb(244, 244, 246)";
      expect(paint.sharedEdge).toBe(ink);
      expect(paint.mode).toBe("docked");
      receipts.push({
        appearance,
        accessibility: "reduced-transparency-and-more-contrast",
        paint,
      });
      await page.screenshot({
        path: info.outputPath(`shell-surfaces-accessible-${appearance}.png`),
        fullPage: true,
      });
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    }
    const toggle = page.locator(".inspector-toggle");
    const before = (await shellPaint(page)).center.rect;
    await toggle.click();
    await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    expect(
      (await page.locator(".primary-panel").boundingBox())!.width,
    ).toBeGreaterThan(before.width);
    await toggle.click();
    await expect(page.locator(".workspace-inspector")).toBeVisible();
    expect((await shellPaint(page)).center.rect).toEqual(before);
    await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.getByRole("button", { name: "显示侧边栏", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    expect((await expectSharedSurface(page, "dark")).left.rect.width).toBe(280);
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(page.locator(".workspace-inspector")).toHaveAttribute(
      "data-inspector-mode",
      "overlay",
    );
    const overlay = await expectSharedSurface(page, "dark");
    expect(overlay.mode).toBe("overlay");
    const canvas = overlay.center.rect;
    await toggle.click();
    await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    expect(await page.locator(".primary-panel").boundingBox()).toEqual(canvas);
    await toggle.click();
    await expect(page.locator(".workspace-inspector")).toBeVisible();
    const reopened = await expectSharedSurface(page, "dark");
    expect(reopened.mode).toBe("overlay");
    expect(reopened.center.rect).toEqual(canvas);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await expect(page.locator(".workspace-inspector")).toHaveAttribute(
        "data-inspector-mode",
        "overlay",
      );
      await expect(toggle).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await expect(page.locator(".workspace-inspector")).toHaveCSS(
        "background-color",
        "rgb(36, 36, 36)",
      );
    }
    await toggle.click();
    await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 960 });
    await info.attach("actual-accessible-shell-paint", {
      body: JSON.stringify(receipts, null, 2),
      contentType: "application/json",
    });
    expect(messageHost.deliveries()).toEqual(deliveries);
    await unchanged();
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.detach();
  }
});
