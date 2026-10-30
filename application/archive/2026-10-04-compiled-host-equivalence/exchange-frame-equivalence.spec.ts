import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  expect,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import sharp from "sharp";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import {
  composerAction,
  openExchangeReading,
  openInput,
  settleTransitions,
} from "./interaction-helpers.js";
import { platformInputState } from "./platform-input-state-fixture.js";
import { compareExchangePaint } from "./exchange-paint-comparison.js";

// Opt-in real compiled Host comparison, not a synthetic Exchange component.
// Root supplies saved b9906e0c assets and the candidate's actual index/asset manifest.
// Twelve supported combinations plus two separately labelled old limitations:
// not a Cartesian matrix, native zoom, native-window acceptance, or proof of live
// animation timing. A passing old-limit comparison does not mean that UI is usable.
// Paint is sampled after finite transitions, with persistent animations paused
// at zero phase. Same-asset old/old runs prove rounded-edge raster noise; image
// comparison explicitly normalizes one-LSB RGB and uses heuristic AA detection.
// It is not raw RGBA equality or a substitute for exact source/paint/geometry.
type Asset = { url: string; sha256: string };
type Manifest = { html: string; assets: Asset[] };
const oldDirectory = process.env.MORPHZ_EXCHANGE_BASELINE_DIR;
const candidatePath = process.env.MORPHZ_EXCHANGE_CANDIDATE_MANIFEST;
const fixedAssets = [
  {
    url: "/assets/app-pazy4bUJ.js",
    sha256: "ce03c5e8f250f913b1ef6746e7d32f6030a6939a9f2ab553126282b29228a38b",
  },
  {
    url: "/assets/app-Bl-K6QYD.css",
    sha256: "0a46e4301841e99b7c688123e4a07ff83e8ebd6b33918325331294aaad442648",
  },
] satisfies Asset[];
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function assetsIn(html: string) {
  return [
    ...new Set(
      [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];
}
function manifests() {
  const html = readFileSync(join(oldDirectory!, "index.html"), "utf8");
  const old = {
    html,
    assets: assetsIn(html).map((url) => ({
      url,
      sha256: digest(readFileSync(join(oldDirectory!, basename(url)))),
    })),
  };
  for (const asset of fixedAssets) expect(old.assets).toContainEqual(asset);
  const candidate = JSON.parse(
    readFileSync(candidatePath!, "utf8"),
  ) as Manifest;
  expect(candidate.assets.map((asset) => asset.url).sort()).toEqual(
    assetsIn(candidate.html).sort(),
  );
  expect(candidate.assets.length).toBeGreaterThanOrEqual(2);
  for (const asset of candidate.assets)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
  return { old, candidate };
}

const combinations = (
  [
    ["wide-empty", 1440, 960, false, 1, false, "workbench"],
    ["wide-scoped-long", 1440, 960, false, 1, true, "project"],
    ["narrow-long", 390, 540, false, 1, true, "workbench"],
    ["minimum-coarse", 320, 540, true, 1, false, "workbench"],
    ["short-scaled", 760, 540, false, 2, true, "workbench"],
    ["supported-scaled", 1440, 960, false, 2, true, "workbench"],
    ["dialogue-scaled", 1440, 960, true, 2, true, "dialogue"],
  ] as const
).map(([name, width, height, coarse, zoom, long, scope]) => ({
  name,
  width,
  height,
  coarse,
  zoom,
  long,
  scope,
  knownLimit: name === "short-scaled",
}));
type Combination = (typeof combinations)[number];
const selectors = [
  ".app",
  ".workspace",
  ".workspace-body",
  ".primary-panel",
  ".primary-panel > main",
  ".exchange-surface",
  ".exchange-panel",
  ".exchange-panel-header",
  ".exchange-scope",
  ".exchange-controls-slot",
  ".exchange-view-tools",
  ".application-dock-slot",
  ".application-dock",
  ".composer-dock",
  ".composer",
  ".composer-writing",
  ".composer textarea",
  ".composer-action-bar",
  ".conversation",
  ".exchange-resizer",
  ".exchange-resize-shield",
];
const properties = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "padding",
  "margin",
  "gap",
  "flex",
  "grid-template-columns",
  "box-sizing",
  "overflow",
  "overscroll-behavior",
  "scrollbar-gutter",
  "touch-action",
  "z-index",
  "visibility",
  "pointer-events",
  "transform",
  "zoom",
  "container-type",
  "border-radius",
  "border-width",
  "border-color",
  "border-style",
  "box-shadow",
  "color",
  "background-color",
  "background-image",
  "backdrop-filter",
  "filter",
  "outline-color",
  "outline-width",
  "outline-offset",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "opacity",
  "animation-name",
  "animation-duration",
  "animation-iteration-count",
  "--composer-tools-height",
  "--exchange-overlay-height",
  "--exchange-height",
  "--exchange-max-height",
];

async function remember(page: Page, reading = false) {
  await page.evaluate((reading) => {
    const previous = Reflect.get(window, "exchangeFrameRefs") || {};
    Reflect.set(window, "exchangeFrameRefs", {
      input: previous.input || document.querySelector(".composer textarea"),
      panel: previous.panel || document.querySelector(".exchange-panel"),
      reading: reading
        ? document.querySelector(".conversation")
        : previous.reading,
      message: reading
        ? document.querySelector(".conversation-message")
        : previous.message,
    });
  }, reading);
}
async function snapshot(page: Page) {
  await settleTransitions(page);
  // Exchange/menu reveal uses finite CSSAnimation, not CSSTransition. Let that
  // actual entry animation finish naturally; never disable production motion.
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    // The animation promise can resolve before its final compositor frame.
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  return page.evaluate(
    ({ selectors, properties }) => {
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          right: box.right,
          bottom: box.bottom,
        };
      };
      const style = (element: Element, pseudo?: string) => {
        const computed = getComputedStyle(element, pseudo);
        return Object.fromEntries(
          properties.map((key) => [key, computed.getPropertyValue(key)]),
        );
      };
      const panel = document.querySelector<HTMLElement>(".exchange-panel")!;
      const workspace = panel.closest<HTMLElement>(".primary-panel")!;
      const refs = Reflect.get(window, "exchangeFrameRefs");
      const reading = panel.querySelector<HTMLElement>(
        ":scope > .conversation",
      );
      const tools = Number.parseFloat(
        getComputedStyle(panel).getPropertyValue("--composer-tools-height"),
      );
      const overlay = Number.parseFloat(
        getComputedStyle(workspace).getPropertyValue(
          "--exchange-overlay-height",
        ),
      );
      const buttons = [
        ...panel.querySelectorAll<HTMLButtonElement>(
          ".application-dock button, .exchange-view-tools > button, .exchange-view-tools > .composer-options > button",
        ),
      ]
        .filter(
          (element) =>
            element.getClientRects().length &&
            getComputedStyle(element).visibility !== "hidden",
        )
        .map((button) => {
          const box = rect(button);
          const zoom =
            (button as HTMLElement & { currentCSSZoom?: number })
              .currentCSSZoom || 1;
          const hit = (y: number) =>
            button.contains(
              document.elementFromPoint(box.x + box.width / 2, y),
            );
          const hitOwner = (y: number) => {
            const element = document.elementFromPoint(box.x + box.width / 2, y);
            return element
              ? {
                  tag: element.tagName,
                  class: element.getAttribute("class"),
                  label: element.getAttribute("aria-label"),
                  rect: rect(element),
                  sidebar: !!element.closest(".sidebar"),
                  controls: !!element.closest(".exchange-view-tools"),
                }
              : null;
          };
          return {
            label: button.getAttribute("aria-label"),
            group: button.closest(".application-dock") ? "dock" : "controls",
            rect: box,
            icon: button.querySelector("svg")?.outerHTML,
            iconRect: button.querySelector("svg")
              ? rect(button.querySelector("svg")!)
              : null,
            style: style(button),
            centerHit: hit(box.y + box.height / 2),
            upperHit: hit(box.y + 2 * zoom),
            centerOwner: hitOwner(box.y + box.height / 2),
            upperOwner: hitOwner(box.y + 2 * zoom),
          };
        });
      return {
        mode: workspace.getAttribute("data-interaction"),
        dialogue: workspace.hasAttribute("data-dialogue-canvas"),
        coarse: matchMedia("(pointer: coarse)").matches,
        viewport: { width: innerWidth, height: innerHeight },
        raster: {
          devicePixelRatio,
          viewportScale: visualViewport?.scale,
          viewportSize: [visualViewport?.width, visualViewport?.height],
          pageScroll: [scrollX, scrollY],
          rootZoom: getComputedStyle(document.documentElement).zoom,
          appZoom: getComputedStyle(document.querySelector(".app")!).zoom,
        },
        nodes: selectors.map((selector) => {
          const element = document.querySelector<HTMLElement>(selector);
          return element
            ? {
                selector,
                rect: rect(element),
                client: [element.clientWidth, element.clientHeight],
                scroll: [
                  element.scrollWidth,
                  element.scrollHeight,
                  element.scrollLeft,
                  element.scrollTop,
                ],
                attrs: Object.fromEntries(
                  [...element.attributes]
                    .filter((attribute) =>
                      /^(?:data-|aria-)/.test(attribute.name),
                    )
                    .map((attribute) => [attribute.name, attribute.value]),
                ),
                style: style(element),
                before: style(element, "::before"),
                after: style(element, "::after"),
              }
            : { selector, absent: true };
        }),
        identity: {
          input: refs.input === panel.querySelector("textarea"),
          panel: refs.panel === panel,
          reading: refs.reading ? refs.reading === reading : null,
          readingConnected: refs.reading?.isConnected ?? null,
          message: refs.message
            ? refs.message === document.querySelector(".conversation-message")
            : null,
        },
        draft: panel.querySelector<HTMLTextAreaElement>("textarea")!.value,
        buttons,
        budget: {
          overlay,
          expected: Math.ceil(
            panel.offsetHeight +
              tools +
              parseFloat(getComputedStyle(panel).marginBottom),
          ),
        },
        animations: document
          .getAnimations()
          .filter((animation) => !(animation instanceof CSSTransition))
          .map((animation) => ({
            name:
              animation instanceof CSSAnimation
                ? animation.animationName
                : "web-animation",
            iterations: animation.effect?.getTiming().iterations,
          })),
      };
    },
    { selectors, properties },
  );
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Capture = {
  snapshot: Snapshot;
  paint: Buffer;
  clip: { x: number; y: number; width: number; height: number };
};
async function capture(
  page: Page,
  combination: Combination,
  resizing = false,
): Promise<Capture> {
  // A real captured pointer must stay at the gesture's last position; moving it
  // away for a screenshot would itself resize the production panel.
  if (!resizing) await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  const state = await snapshot(page);
  try {
    expect(state.identity.input).toBe(true);
    expect(state.identity.panel).toBe(true);
    expect(state.coarse).toBe(combination.coarse);
    expect(state.raster.devicePixelRatio).toBe(1);
    expect(state.raster.viewportScale).toBe(1);
    expect(Number.parseFloat(state.raster.rootZoom)).toBe(1);
    expect(Number.parseFloat(state.raster.appZoom)).toBe(combination.zoom);
    expect(state.budget.overlay).toBe(state.budget.expected);
    expect(
      state.buttons.filter((button) => button.group === "dock").length,
    ).toBeGreaterThanOrEqual(1);
    if (!state.dialogue) {
      expect(
        state.buttons.filter((button) => button.group === "controls").length,
      ).toBeGreaterThanOrEqual(3);
      const panel = state.nodes.find(
        (node) => node.selector === ".exchange-panel",
      )!;
      const controls = state.nodes.find(
        (node) => node.selector === ".exchange-view-tools",
      )!;
      expect(
        controls.attrs && Object.hasOwn(controls.attrs, "data-compact"),
      ).toBe(panel.client![0]! <= 620);
    }
    for (const button of state.buttons) {
      if (!resizing && !combination.knownLimit) {
        expect(button.centerHit, button.label || "button").toBe(true);
        expect(button.upperHit, button.label || "button upper edge").toBe(true);
      }
      const size = combination.coarse ? 44 : button.group === "dock" ? 32 : 28;
      expect(button.rect.width).toBeCloseTo(size * combination.zoom, 0);
      expect(button.rect.height).toBeCloseTo(size * combination.zoom, 0);
      expect(button.iconRect!.width).toBeCloseTo(
        (button.group === "dock" ? 14 : 13) * combination.zoom,
        0,
      );
      expect(button.rect.x).toBeGreaterThanOrEqual(-1);
      expect(button.rect.right).toBeLessThanOrEqual(combination.width + 1);
      expect(button.rect.y).toBeGreaterThanOrEqual(-1);
      expect(button.rect.bottom).toBeLessThanOrEqual(combination.height + 1);
    }
    if (combination.knownLimit) {
      expect(state.mode).toBe("input");
      const main = state.nodes.find(
        (node) => node.selector === ".primary-panel > main",
      )!;
      const panel = state.nodes.find(
        (node) => node.selector === ".exchange-panel",
      )!;
      expect(main.rect).toEqual({
        x: 560,
        y: 96,
        width: 200,
        height: 744,
        right: 760,
        bottom: 840,
      });
      expect(panel.rect).toEqual({
        x: 584,
        y: 352,
        width: 152,
        height: 468,
        right: 736,
        bottom: 820,
      });
      expect(main.style?.overflow).toBe("hidden");
      const history = state.buttons.find(
        (button) => button.label === "查看交流记录",
      )!;
      expect(history.rect).toEqual({
        x: 520,
        y: 280,
        width: 56,
        height: 56,
        right: 576,
        bottom: 336,
      });
      expect(history.rect.x + history.rect.width / 2).toBeLessThan(
        main.rect!.x,
      );
      expect(history.centerHit).toBe(false);
      expect(history.upperHit).toBe(false);
      expect(history.centerOwner?.sidebar).toBe(true);
      const launcher = state.buttons.find(
        (button) => button.label === "全部应用",
      )!;
      expect(launcher.centerHit).toBe(false);
      expect(launcher.upperHit).toBe(true);
      expect(launcher.centerOwner?.controls).toBe(true);
    }
  } catch (error) {
    await test.info().attach("failed-frame-state", {
      body: JSON.stringify(state, null, 2),
      contentType: "application/json",
    });
    await test.info().attach("failed-frame-viewport", {
      body: await page.screenshot({ caret: "hide" }),
      contentType: "image/png",
    });
    throw error;
  }
  // Sample only the production Exchange and its floating controls, not unrelated
  // service-status UI. This pauses paint, not the recorded motion declarations.
  const paused = await page.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter(
        (animation) => animation.effect?.getTiming().iterations === Infinity,
      );
    Reflect.set(
      window,
      "exchangeFrameAnimations",
      animations.map((animation) => ({
        animation,
        time: animation.currentTime,
        state: animation.playState,
      })),
    );
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    // pause() is asynchronous: ready acknowledges the pending pause before the
    // zero-phase style is sampled by the two following compositor frames.
    await Promise.all(animations.map((animation) => animation.ready));
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    return animations.length;
  });
  const clip = await page.evaluate((zoom) => {
    const boxes = [
      ...document.querySelectorAll<HTMLElement>(
        ".exchange-panel, .application-dock, .exchange-controls-slot",
      ),
    ]
      .filter((element) => element.getClientRects().length)
      .map((element) => element.getBoundingClientRect());
    const margin = 12 * zoom;
    const x = Math.max(
      0,
      Math.floor(Math.min(...boxes.map((box) => box.x)) - margin),
    );
    const y = Math.max(
      0,
      Math.floor(Math.min(...boxes.map((box) => box.y)) - margin),
    );
    return {
      x,
      y,
      width:
        Math.min(
          innerWidth,
          Math.ceil(Math.max(...boxes.map((box) => box.right)) + margin),
        ) - x,
      height:
        Math.min(
          innerHeight,
          Math.ceil(Math.max(...boxes.map((box) => box.bottom)) + margin),
        ) - y,
    };
  }, combination.zoom);
  try {
    const paint = await page.screenshot({
      clip,
      caret: "hide",
      animations: "allow",
      scale: "device",
    });
    expect(paused).toBe(
      state.animations.filter((animation) => animation.iterations === Infinity)
        .length,
    );
    return { snapshot: state, paint, clip };
  } finally {
    await page.evaluate(() => {
      for (const entry of Reflect.get(window, "exchangeFrameAnimations")) {
        entry.animation.currentTime = entry.time;
        if (entry.state === "running") entry.animation.play();
      }
    });
  }
}

async function renderer(
  browser: Browser,
  baseURL: string,
  manifest: Manifest,
  old: boolean,
  combination: Combination,
  appearance: string,
  projectTitle: string,
) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 960 },
    hasTouch: combination.coarse,
    // Explicitly retain newContext's existing default: CSS clip pixels and PNG
    // device pixels have the same 1:1 transform in both isolated renderers.
    deviceScaleFactor: 1,
  });
  let page: Page | undefined;
  try {
    page = await context.newPage();
    const receipts: Promise<{ url: string; status: number; sha256: string }>[] =
      [];
    const writes: string[] = [];
    const historyRequests: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== new URL(baseURL).origin) return;
      if (
        url.pathname === "/" ||
        manifest.assets.some((asset) => asset.url === url.pathname)
      )
        receipts.push(
          response.body().then((body) => ({
            url: url.pathname,
            status: response.status(),
            sha256: digest(body),
          })),
        );
    });
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history$/.test(
          pathname,
        )
      )
        historyRequests.push(pathname);
      if (
        request.method() === "POST" &&
        /\/api\/(?:platform\/(?:messages|conversations|applications)|inputs\/)/.test(
          request.url(),
        )
      )
        writes.push(request.url());
    });
    if (old) {
      await page.route(
        new RegExp(`^${baseURL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/$`),
        (route) =>
          route.fulfill({ body: manifest.html, contentType: "text/html" }),
      );
      await page.route("**/assets/*", async (route) => {
        const url = new URL(route.request().url()).pathname;
        if (!manifest.assets.some((asset) => asset.url === url))
          return route.continue();
        await route.fulfill({
          body: readFileSync(join(oldDirectory!, basename(url))),
          contentType: url.endsWith(".css") ? "text/css" : "text/javascript",
        });
      });
    }
    await page.clock.setFixedTime(new Date("2026-09-21T12:00:00.000Z"));
    const messages: PlatformHistory["runtime"]["messages"] = [];
    const fixture = await mockPlatformConversation(page, () => ({
      inputs: [],
      runtime: {
        ...disconnectedRuntime,
        configured: true,
        connected: true,
        model: "frame-fixture-model",
        messages,
      },
    }));
    let messageProjectId = fixture.spaces.deskId;
    if (combination.scope === "project") {
      const project = (await fixture.client.allProjects()).find(
        (project) => project.title === projectTitle,
      );
      messageProjectId =
        project?.id ??
        (await fixture.client.createProject(
          projectTitle,
          randomUUID(),
          randomUUID(),
        ));
    }
    if (combination.long)
      for (let index = 0; index < 24; index++)
        messages.push({
          // Personal project-default exchanges intentionally share the actual dialogue
          // conversation, while the work/message owner is the actual project receipt.
          id: `frame-message-${index}`,
          projectId: messageProjectId,
          conversationId: fixture.scope.conversationId,
          artifactId: null,
          inputId: null,
          kind: "reply",
          text: `### 片段 ${index + 1}\n保留原始换行与 Markdown。\n\n${"这是同一真实宿主里的固定长消息，只检查布局，不启动工作。".repeat(4)}`,
          createdAt: new Date(Date.UTC(2026, 8, 21, 10, index)).toISOString(),
        });
    const phases: Record<string, Capture> = {};
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "主导航" });
    if (combination.scope === "project")
      await page
        .locator(".project-link")
        .filter({ hasText: projectTitle })
        .click();
    else
      await nav
        .getByRole("button", {
          name: combination.scope === "dialogue" ? "对话" : "工作台",
          exact: true,
        })
        .click();
    if (combination.scope === "workbench")
      await page
        .getByRole("button", { name: "应用启动台", exact: true })
        .click();
    const input = await openInput(page);
    if (combination.scope === "project")
      await expect(
        page.locator(".composer-scope-label, .composer-scope-trigger"),
      ).toContainText(projectTitle);
    const draft = combination.long
      ? Array.from(
          { length: 30 },
          (_, index) => `TEST 草稿 ${index + 1}：不发送、不换作用域、不执行。`,
        ).join("\n")
      : "TEST 几何草稿，不发送。\n保留第二行。";
    await input.fill(draft);
    if (combination.scope !== "dialogue") {
      await composerAction(page, "固定输入框");
      if (await page.locator(".exchange-panel > .conversation").isVisible())
        await composerAction(page, "收起交流记录");
    }
    await page.setViewportSize({
      width: combination.width,
      height: combination.height,
    });
    // Deliver the native resize before applying the fixture's CSS zoom. The
    // unchanged sidebar uses both window.innerWidth and root.clientWidth; a
    // pending native resize after this artificial transform would mix them.
    await settleTransitions(page);
    await page.locator(".app").evaluate(
      (element, { appearance, zoom }) => {
        const app = element as HTMLElement;
        app.setAttribute("data-appearance", appearance);
        // Identical to the established exchange-floating-controls fixture: CSS
        // zoom needs physical-height correction, unlike native browser page zoom.
        // This controlled fixture is not a change to the production shell geometry.
        app.style.zoom = String(zoom);
        app.style.height = zoom === 1 ? "" : `calc(100dvh / ${zoom})`;
      },
      { appearance, zoom: combination.zoom },
    );
    await remember(page);
    const inputsBefore = await platformInputState(page, fixture.client);
    const canvas = page.locator(".primary-panel > main");
    if (combination.scope === "dialogue") {
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-dialogue-canvas",
        "true",
      );
      await expect(
        page.locator(".exchange-controls-slot, .exchange-resizer"),
      ).toHaveCount(0);
      await expect(page.locator(".conversation-message")).toHaveCount(24);
      await remember(page, true);
      phases.dialogue = await capture(page, combination);
    } else {
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        "input",
      );
      const canvasBounds = await canvas.boundingBox();
      phases.input = await capture(page, combination);
      if (!combination.knownLimit) {
        const reading = await openExchangeReading(page);
        await expect(reading.locator(".conversation-message")).toHaveCount(
          combination.long ? 24 : 0,
        );
        if (combination.long)
          await reading.evaluate((element) => {
            element.scrollTop = 120;
          });
        await remember(page, true);
        phases.recent = await capture(page, combination);
        expect(await canvas.boundingBox()).toEqual(canvasBounds);
        await composerAction(page, "展开完整记录");
        await expect(page.locator(".primary-panel")).toHaveAttribute(
          "data-interaction",
          "history",
        );
        await expect(canvas).toBeHidden();
        phases.history = await capture(page, combination);
        expect(phases.history.snapshot.identity.reading).toBe(true);
        await composerAction(page, "返回工作内容");
        await expect(canvas).toBeVisible();
        const handle = page.getByRole("separator", {
          name: "调整消息区高度",
          exact: true,
        });
        await expect(handle).toBeInViewport();
        const box = (await handle.boundingBox())!;
        const scrollBefore = await reading.evaluate(
          (element) => element.scrollTop,
        );
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          box.x + box.width / 2,
          box.y + box.height / 2 - 24 * combination.zoom,
          { steps: 8 },
        );
        await expect(page.locator(".exchange-panel")).toHaveAttribute(
          "data-resizing",
          "",
        );
        phases.resizing = await capture(page, combination, true);
        expect(phases.resizing.snapshot.identity.reading).toBe(true);
        expect(await reading.evaluate((element) => element.scrollTop)).toBe(
          scrollBefore,
        );
        await page.mouse.up();
        await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
        phases.resized = await capture(page, combination);
        await composerAction(page, "收起交流记录");
        await expect(reading).toHaveCount(0);
        phases.inputAgain = await capture(page, combination);
        expect(phases.inputAgain.snapshot.identity.readingConnected).toBe(
          false,
        );
        expect(await canvas.boundingBox()).toEqual(canvasBounds);
      }
    }
    for (const phase of Object.values(phases))
      expect(phase.snapshot.draft).toBe(draft);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    expect(await platformInputState(page, fixture.client)).toEqual(
      inputsBefore,
    );
    const expectedHistory = `/api/platform/projects/${fixture.scope.projectId}/conversations/${fixture.scope.conversationId}/history`;
    expect(historyRequests).toContain(expectedHistory);
    const scene = {
      workProjectId: messageProjectId,
      conversationId: fixture.scope.conversationId,
      historyRequests: [...new Set(historyRequests)].sort(),
    };
    const loaded = await Promise.all(receipts);
    expect(loaded).toContainEqual({
      url: "/",
      status: 200,
      sha256: digest(manifest.html),
    });
    for (const asset of manifest.assets)
      expect(loaded).toContainEqual({ ...asset, status: 200 });
    return { phases, loaded, scene };
  } finally {
    try {
      await page?.unrouteAll({ behavior: "wait" });
    } finally {
      await context.close();
    }
  }
}

async function comparePaint(
  old: Capture,
  candidate: Capture,
  label: string,
  info: TestInfo,
) {
  expect(candidate.clip, `${label} screenshot region`).toEqual(old.clip);
  const left = await sharp(old.paint)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const right = await sharp(candidate.paint)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  await info.attach(`${label}-old`, {
    body: old.paint,
    contentType: "image/png",
  });
  await info.attach(`${label}-candidate`, {
    body: candidate.paint,
    contentType: "image/png",
  });
  expect(right.info).toEqual(left.info);
  let differentChannels = 0;
  const differences: {
    x: number;
    y: number;
    channel: number;
    old: number;
    candidate: number;
  }[] = [];
  for (let index = 0; index < left.data.length; index++)
    if (left.data[index] !== right.data[index]) {
      differentChannels++;
      if (differences.length < 100)
        differences.push({
          x: ((index / 4) % left.info.width) | 0,
          y: Math.floor(index / 4 / left.info.width),
          channel: index % 4,
          old: left.data[index]!,
          candidate: right.data[index]!,
        });
    }
  if (differentChannels)
    await info.attach(`${label}-paint-differences`, {
      body: JSON.stringify(
        { differentChannels, clip: old.clip, first100: differences },
        null,
        2,
      ),
      contentType: "application/json",
    });
  const comparison = await compareExchangePaint(old.paint, candidate.paint);
  expect(comparison.rawChannels).toBe(differentChannels);
  const { comparatorResult, ...summary } = comparison;
  await info.attach(`${label}-paint-comparison`, {
    body: JSON.stringify(
      {
        ...summary,
        calibration: "one-LSB equal-alpha RGB quantization; heuristic AA",
        nonAADifference: comparatorResult?.errorMessage ?? null,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  if (comparatorResult?.diff)
    await info.attach(`${label}-non-AA-diff`, {
      body: comparatorResult.diff,
      contentType: "image/png",
    });
  expect(
    comparatorResult,
    `${label} zero classified non-AA difference after one-LSB calibration`,
  ).toBeNull();
}

for (const combination of combinations)
  for (const appearance of ["light", "dark"])
    test(`真实 Host Exchange ${combination.knownLimit ? "已知旧限制等价" : "支持场景旧新等价"}：${combination.name}/${appearance}`, async ({
      browser,
      baseURL,
    }, info) => {
      test.skip(
        !oldDirectory || !candidatePath,
        "Requires independently saved baseline and candidate asset manifest",
      );
      test.setTimeout(90_000);
      expect(baseURL).toBeTruthy();
      const source = manifests();
      const title = `TEST Exchange frame ${combination.name}/${appearance}`;
      const old = await renderer(
        browser,
        baseURL!,
        source.old,
        true,
        combination,
        appearance,
        title,
      );
      const candidate = await renderer(
        browser,
        baseURL!,
        source.candidate,
        false,
        combination,
        appearance,
        title,
      );
      await info.attach("loaded-renderer-receipts", {
        body: JSON.stringify(
          {
            baseline: "b9906e0c",
            classification: combination.knownLimit
              ? "known-old-limitation-not-usable"
              : "supported-representative",
            old: { loaded: old.loaded, scene: old.scene },
            candidate: { loaded: candidate.loaded, scene: candidate.scene },
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await info.attach("frame-snapshots", {
        body: JSON.stringify(
          {
            old: Object.fromEntries(
              Object.entries(old.phases).map(([key, value]) => [
                key,
                value.snapshot,
              ]),
            ),
            candidate: Object.fromEntries(
              Object.entries(candidate.phases).map(([key, value]) => [
                key,
                value.snapshot,
              ]),
            ),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect(Object.keys(candidate.phases)).toEqual(Object.keys(old.phases));
      expect(candidate.scene).toEqual(old.scene);
      for (const [name, phase] of Object.entries(old.phases)) {
        expect(candidate.phases[name]!.snapshot, name).toEqual(phase.snapshot);
        await comparePaint(phase, candidate.phases[name]!, name, info);
      }
    });
