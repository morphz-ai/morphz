import type { Locator, Page } from "@playwright/test";
import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
} from "../packages/core/src/applications.js";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";
import { applicationIdentities } from "../apps/web/src/application-identity.js";

const applications = [
  { app: browserApplication, identity: "browser" },
  { app: readerApplication, identity: "reader" },
  { app: scriptStudioApplication, identity: "studio" },
] as const;
const draft = "TEST 应用图标验证：原工作面草稿保留，不发送。";

async function openWorkbench(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "应用列表", exact: true }),
  ).toBeVisible();
  const input = await openInput(page);
  await input.fill(draft);
  return input;
}

function launcherPanel(page: Page) {
  return page.getByRole("group", { name: "选择应用", exact: true });
}

async function openLauncher(page: Page) {
  await openInput(page);
  await page.getByRole("button", { name: "全部应用", exact: true }).click();
  const panel = launcherPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function finishColorTransitions(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function artwork(icon: Locator) {
  return icon.evaluate((element) => {
    const ids = [...element.querySelectorAll("[id]")].map((node) => node.id);
    const normalize = (value: string) =>
      ids.reduce(
        (text, id, index) => text.split(id).join(`paint-${index}`),
        value,
      );
    return {
      identity: element.getAttribute("data-application-identity"),
      shape: normalize(element.innerHTML),
      field: [
        ...element.querySelectorAll("defs > linearGradient:first-child stop"),
      ].map((node) => getComputedStyle(node).stopColor),
      // Computed paint detects host CSS recoloring even when SVG attrs match.
      paint: [...element.querySelectorAll("stop, rect, path, circle")].map(
        (node) => {
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            fill: normalize(style.fill),
            stroke: normalize(style.stroke),
            stop: style.stopColor,
          };
        },
      ),
      ownPaintServers: [...element.querySelectorAll("[fill]")].every((node) => {
        const match = node.getAttribute("fill")?.match(/^url\(#(.+)\)$/);
        return !match || element.contains(document.getElementById(match[1]!));
      }),
    };
  });
}

async function savedDrafts(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.includes(":draft:") && key.endsWith(":inputs"))
        .sort()
        .map((key) => [key, JSON.parse(localStorage.getItem(key)!)]),
    ),
  );
}

async function stateGuard(page: Page) {
  const source = await conversationClient(page);
  const origin = new URL(page.url()).origin;
  const snapshot = async () => {
    const response = await page.request.get(`${origin}/api/platform/app-views`);
    expect(response.ok(), await response.text()).toBe(true);
    const views: unknown = await response.json();
    expect(Array.isArray(views)).toBe(true);
    return {
      conversations: await source.allNavigationConversations(),
      views,
      drafts: await savedDrafts(page),
    };
  };
  const before = await snapshot();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (
      [
        "/api/platform/messages",
        "/api/platform/conversations/start",
        "/api/platform/app-views/launch",
      ].includes(path)
    )
      writes.push(path);
  });
  return async () => {
    expect(
      writes,
      "Artwork, focus and pinning do not authorize execution",
    ).toEqual([]);
    expect(await snapshot()).toEqual(before);
  };
}

async function expectBox(iconBox: Locator, size: number) {
  await expect(iconBox).toHaveCSS("width", `${size}px`);
  await expect(iconBox).toHaveCSS("height", `${size}px`);
  const bounds = (await iconBox.boundingBox())!;
  expect(bounds.width).toBe(size);
  expect(bounds.height).toBe(size);
}

test("Launcher／工作台共享三个应用身份；四主题亮暗不串色，原图标盒与Dock尺寸保持", async ({
  page,
  messageHost,
}, info) => {
  const input = await openWorkbench(page);
  const unchanged = await stateGuard(page);
  const deliveries = structuredClone(messageHost.deliveries());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const panel = await openLauncher(page);
  const readerEntry = panel.getByRole("listitem").filter({
    has: page.getByRole("button", { name: "打开阅读", exact: true }),
  });
  await readerEntry.hover();
  await readerEntry
    .getByRole("button", { name: "固定到 Dock：阅读", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const baselineArt = new Map<string, Awaited<ReturnType<typeof artwork>>>();
  const baselineMarks = new Map<
    string,
    Awaited<ReturnType<typeof artwork>>[]
  >();
  let baselineLauncher: Awaited<ReturnType<typeof artwork>> | undefined;

  for (const [appearanceLabel, appearance] of [
    ["亮色", "light"],
    ["暗色", "dark"],
  ] as const) {
    for (const [accentLabel, accent] of [
      ["电光青", "cyan"],
      ["鸢尾紫", "iris"],
      ["暖珊瑚", "coral"],
      ["纯单色", "mono"],
    ] as const) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearanceLabel, exact: true })
        .click();
      await settings
        .getByRole("button", { name: accentLabel, exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(page.locator(".app")).toHaveAttribute(
        "data-appearance",
        appearance,
      );
      await expect(page.locator(".app")).toHaveAttribute("data-accent", accent);
      await finishColorTransitions(page);
      const launcher = await openLauncher(page);
      const launcherTrigger = page.getByRole("button", {
        name: "全部应用",
        exact: true,
      });
      await expectBox(launcherTrigger, 32);
      const launcherSymbol = launcherTrigger.locator(
        "svg.application-launcher-symbol",
      );
      // User-authorized bare Dock glyphs are 22px; the 32px hit box stays above.
      await expectBox(launcherSymbol, 22);
      await expect(launcherSymbol).toHaveAttribute("aria-hidden", "true");
      await expect(launcherSymbol).toHaveAttribute("focusable", "false");
      await expect(launcherSymbol).toHaveAttribute("viewBox", "0 0 24 24");
      await expect(launcherSymbol.locator("rect")).toHaveCount(1);
      await expect(launcherSymbol.locator("circle")).toHaveCount(9);
      await expect(launcherSymbol.locator("[id]")).toHaveCount(1);
      const collectionPaint = await launcherSymbol.evaluate((node) => {
        const rect = node.querySelector("rect")!;
        const id = rect.getAttribute("fill")!.match(/^url\(#(.+)\)$/)![1]!;
        const gradient = node.querySelector(`[id="${id}"]`)!;
        return {
          geometry: ["x", "y", "width", "height", "rx", "transform"].map(
            (key) => rect.getAttribute(key),
          ),
          stops: [...gradient.querySelectorAll("stop")].map(
            (stop) => getComputedStyle(stop).stopColor,
          ),
          dots: [...node.querySelectorAll("circle")].map((circle) => ({
            geometry: ["cx", "cy", "r", "transform"].map((key) =>
              circle.getAttribute(key),
            ),
            fill: getComputedStyle(circle).fill,
          })),
        };
      });
      const collectionColors = [
        applicationIdentities.browser.field[0],
        applicationIdentities.studio.field[1],
      ];
      const resolvedCollectionColors = await page.evaluate(
        (colors) =>
          colors.map((color) => {
            const probe = document.createElement("span");
            probe.style.color = color;
            document.body.append(probe);
            const result = getComputedStyle(probe).color;
            probe.remove();
            return result;
          }),
        collectionColors,
      );
      expect(collectionPaint.geometry).toEqual([
        null,
        null,
        "24",
        "24",
        "6",
        null,
      ]);
      expect(collectionPaint.stops).toEqual(resolvedCollectionColors);
      expect(collectionPaint.dots).toEqual(
        ["7", "12", "17"].flatMap((cy) =>
          ["7", "12", "17"].map((cx) => ({
            geometry: [cx, cy, "1.3", null],
            fill: "rgb(255, 255, 255)",
          })),
        ),
      );
      const collectionArt = await artwork(launcherSymbol);
      expect(collectionArt.ownPaintServers).toBe(true);
      if (!baselineLauncher) baselineLauncher = collectionArt;
      expect(collectionArt).toEqual(baselineLauncher);
      const workspaceLauncher = page
        .getByRole("button", {
          name: "应用启动台",
          exact: true,
        })
        .locator("svg.application-launcher-symbol");
      await expect(workspaceLauncher).toHaveAttribute("aria-hidden", "true");
      await expect(workspaceLauncher.locator("[id]")).toHaveCount(1);
      expect(
        await workspaceLauncher.locator("[id]").getAttribute("id"),
      ).not.toBe(await launcherSymbol.locator("[id]").getAttribute("id"));
      expect(await artwork(workspaceLauncher)).toEqual(collectionArt);
      const artSignatures: string[] = [];
      const palettes: string[] = [];
      for (const { app, identity } of applications) {
        const tile = page.getByRole("button", {
          name: `${app.title} ${app.version}`,
          exact: true,
        });
        const launch = launcher.getByRole("button", {
          name: `打开${app.title}`,
          exact: true,
        });
        await expect(tile.locator("strong")).toHaveText(app.title);
        await expect(launch.locator(".application-dock-app-name")).toHaveText(
          app.title,
        );
        await expectBox(tile.locator(".application-icon"), 66);
        await expectBox(launch.locator(".application-dock-app-icon"), 54);
        const tileIcon = tile.locator(
          `svg.application-emblem[data-application-identity="${identity}"]`,
        );
        const launchIcon = launch.locator(
          `svg.application-emblem[data-application-identity="${identity}"]`,
        );
        for (const icon of [tileIcon, launchIcon]) {
          await expect(icon).toHaveCount(1);
          await expect(icon).toHaveAttribute("aria-hidden", "true");
          await expect(icon).toHaveAttribute("focusable", "false");
          await expect(icon).toHaveAttribute("viewBox", "0 0 64 64");
          await expect(icon).toHaveCSS("stroke-width", "0px");
        }
        const rendered = await artwork(tileIcon);
        expect(rendered.ownPaintServers).toBe(true);
        expect(await artwork(launchIcon)).toEqual(rendered);
        if (!baselineArt.has(identity)) baselineArt.set(identity, rendered);
        expect(rendered).toEqual(baselineArt.get(identity));
        artSignatures.push(rendered.shape);
        palettes.push(JSON.stringify(rendered.field));
      }
      expect(new Set(artSignatures).size).toBe(3);
      expect(new Set(palettes).size).toBe(3);
      const ids = await page
        .locator("svg.application-emblem [id]")
        .evaluateAll((nodes) => nodes.map((node) => node.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(6);

      const marks: Awaited<ReturnType<typeof artwork>>[] = [];
      for (const { app, identity } of applications) {
        const shortcut = page
          .locator(".application-dock-pins")
          .getByRole("button", { name: `打开${app.title}`, exact: true });
        await expectBox(shortcut, 32);
        const mark = shortcut.locator(
          `svg.application-emblem[data-application-identity="${identity}"]`,
        );
        await expectBox(mark, 22);
        await expect(mark).toHaveAttribute("aria-hidden", "true");
        await expect(mark).toHaveAttribute("focusable", "false");
        await expect(mark).toHaveAttribute("viewBox", "0 0 64 64");
        await expect(mark).toHaveCSS("stroke-width", "0px");
        const rendered = await artwork(mark);
        expect(rendered.ownPaintServers).toBe(true);
        // A Dock mark is the original application artwork scaled down, not
        // a separately drawn symbol. Normalize only instance-local paint IDs.
        expect(rendered).toEqual(baselineArt.get(identity));
        marks.push(rendered);
      }
      expect(new Set(marks.map((mark) => mark.shape)).size).toBe(3);
      expect(
        new Set(marks.map((mark) => JSON.stringify(mark.field))).size,
      ).toBe(3);
      if (!baselineMarks.has(appearance)) baselineMarks.set(appearance, marks);
      expect(marks).toEqual(baselineMarks.get(appearance));
      await expect(input).toHaveValue(draft);
      // Screenshots are review material, not an assertion of aesthetic acceptance.
      await page.screenshot({
        path: info.outputPath(`application-icons-${appearance}-${accent}.png`),
        fullPage: true,
      });
      await launcher.screenshot({
        path: info.outputPath(
          `application-icons-detail-${appearance}-${accent}.png`,
        ),
      });
      await launcherTrigger.screenshot({
        path: info.outputPath(
          `application-launcher-trigger-${appearance}-${accent}.png`,
        ),
      });
      await info.attach(`paint-${appearance}-${accent}`, {
        body: JSON.stringify({ artwork: [...baselineArt], marks }),
        contentType: "application/json",
      });
      await page.keyboard.press("Escape");
    }
  }
  expect(baselineMarks.get("light")).toEqual(baselineMarks.get("dark"));
  expect(messageHost.deliveries()).toEqual(deliveries);
  expect(errors).toEqual([]);
  await unchanged();
});

test("原中文名称和Tab／Escape／键盘固定可达；刷新保留图标身份及草稿，不创建输入或应用", async ({
  page,
  messageHost,
}) => {
  const input = await openWorkbench(page);
  const unchanged = await stateGuard(page);
  const deliveries = structuredClone(messageHost.deliveries());
  const panel = await openLauncher(page);
  await page.mouse.move(1, 1);
  await expect(panel).toBeFocused();
  await expect(panel).toHaveCSS("outline-style", "none");
  for (const pin of await panel.locator(".application-dock-pin").all())
    await expect(pin).toHaveCSS("opacity", "0");
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: "打开浏览器", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: "从 Dock 移除：浏览器", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: "打开阅读", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  const pin = panel.getByRole("button", {
    name: "固定到 Dock：阅读",
    exact: true,
  });
  await expect(pin).toBeFocused();
  await expect(pin).toHaveCSS("opacity", "1");
  await pin.press("Enter");
  await expect(
    panel.getByRole("button", { name: "从 Dock 移除：阅读", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "全部应用", exact: true }),
  ).toBeFocused();
  await expect(panel).toBeHidden();
  await expect(input).toHaveValue(draft);
  await page.reload();
  await expect(await openInput(page)).toHaveValue(draft);
  const shortcut = page
    .locator(".application-dock-pins")
    .getByRole("button", { name: "打开阅读", exact: true });
  await expect(
    shortcut.locator(
      'svg.application-emblem[data-application-identity="reader"]',
    ),
  ).toBeVisible();
  await expectBox(shortcut, 32);
  await expectBox(shortcut.locator("svg"), 22);
  const restored = await openLauncher(page);
  const remove = restored.getByRole("button", {
    name: "从 Dock 移除：阅读",
    exact: true,
  });
  await remove.focus();
  await page.keyboard.press("Space");
  await expect(
    restored.getByRole("button", { name: "固定到 Dock：阅读", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(shortcut).toHaveCount(0);
  const browserTile = page.getByRole("button", {
    name: `${browserApplication.title} ${browserApplication.version}`,
    exact: true,
  });
  await browserTile.focus();
  await page.keyboard.press("Tab");
  const readerTile = page.getByRole("button", {
    name: `${readerApplication.title} ${readerApplication.version}`,
    exact: true,
  });
  await expect(readerTile).toBeFocused();
  await expect(readerTile).toHaveAccessibleName(
    `${readerApplication.title} ${readerApplication.version}`,
  );
  await expect(readerTile).toHaveCSS("outline-style", "solid");
  await expect(readerTile).toHaveCSS("outline-width", "2px");
  await expect(await openInput(page)).toHaveValue(draft);
  expect(messageHost.deliveries()).toEqual(deliveries);
  await unchanged();
});

for (const { app, identity } of applications.filter(
  ({ identity }) => identity !== "browser",
)) {
  test(`真实打开${app.title}后16px应用标签仍是原图缩放；返回工作台保留原稿且不发送`, async ({
    page,
    messageHost,
  }, info) => {
    await openWorkbench(page);
    const source = await conversationClient(page);
    const conversations = await source.allNavigationConversations();
    const deliveries = structuredClone(messageHost.deliveries());
    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        [
          "/api/platform/messages",
          "/api/platform/conversations/start",
        ].includes(path)
      )
        writes.push(path);
    });
    const tile = page.getByRole("button", {
      name: `${app.title} ${app.version}`,
      exact: true,
    });
    const original = await artwork(
      tile.locator(
        `svg.application-emblem[data-application-identity="${identity}"]`,
      ),
    );
    // This case explicitly opens the installed application through its real Host.
    // The preceding two inspection-only cases retain their zero-launch guards.
    await tile.click();
    const tab = page.getByRole("tab", { name: app.title, exact: true });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const mark = tab.locator(
      `svg.application-emblem[data-application-identity="${identity}"]`,
    );
    await expectBox(mark, 16);
    expect(await artwork(mark)).toEqual(original);
    await page.screenshot({
      path: info.outputPath(`application-${identity}-tab-16px.png`),
      fullPage: true,
    });
    await page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    // The navigation item retains the active app; return to the exact original
    // launcher surface before reading that surface's independently scoped draft.
    const home = page.getByRole("button", { name: "应用启动台", exact: true });
    await home.click();
    await expect(home).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("list", { name: "应用列表", exact: true }),
    ).toBeVisible();
    await expect(await openInput(page)).toHaveValue(draft);
    expect(writes).toEqual([]);
    expect(messageHost.deliveries()).toEqual(deliveries);
    expect(await source.allNavigationConversations()).toEqual(conversations);
  });
}
