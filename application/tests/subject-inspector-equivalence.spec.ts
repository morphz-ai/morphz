import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput, settleTransitions } from "./interaction-helpers.js";
import { platformInputState } from "./platform-input-state-fixture.js";
import { compareExchangePaint } from "./exchange-paint-comparison.js";

// Opt-in compiled Host comparison against saved 85a50934. Presentation is
// controlled, identity/navigation/preferences are real isolated Platform data.
// Four finite viewport/theme combinations are not native App acceptance or a
// Cartesian accessibility matrix. Paint uses the existing heuristic AA/one-LSB
// oracle alongside strict geometry/style/icon equality; not raw RGBA equality.
type Asset = { url: string; sha256: string };
type Manifest = { html: string; assets: Asset[] };
const baselineDirectory = process.env.MORPHZ_INSPECTOR_BASELINE_DIR;
const candidatePath = process.env.MORPHZ_INSPECTOR_CANDIDATE_MANIFEST;
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const assetURLs = (html: string) =>
  [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(
    (match) => match[1]!,
  );
function manifests() {
  const html = readFileSync(join(baselineDirectory!, "index.html"), "utf8");
  const old: Manifest = {
    html,
    assets: assetURLs(html).map((url) => ({
      url,
      sha256: digest(
        readFileSync(join(baselineDirectory!, "assets", basename(url))),
      ),
    })),
  };
  expect(old.assets).toContainEqual({
    url: "/assets/app-BpOObY8v.js",
    sha256: "703fcfb3094e95372764c7a84b448a5fa6a89cece9df5958d4df478917ac351a",
  });
  expect(old.assets).toContainEqual({
    url: "/assets/app-B_zOsesV.css",
    sha256: "552d58cb432d3559ca7b754f8839ca2e9305c2ce726543970e6005c25841f3d9",
  });
  const candidate = JSON.parse(
    readFileSync(candidatePath!, "utf8"),
  ) as Manifest;
  expect(candidate.assets.map((asset) => asset.url).sort()).toEqual(
    assetURLs(candidate.html).sort(),
  );
  return { old, candidate };
}

async function capture(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await settleTransitions(page);
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  const panel = page.locator(".workspace-inspector");
  await expect(panel).toHaveCount(1);
  const state = await page.evaluate(() => {
    const properties = [
      "display",
      "position",
      "width",
      "height",
      "padding",
      "margin",
      "gap",
      "overflow",
      "grid-template-columns",
      "color",
      "background-color",
      "border-color",
      "border-radius",
      "box-shadow",
      "font-size",
      "font-weight",
      "line-height",
      "opacity",
      "transform",
      "animation-name",
      "animation-duration",
      "animation-iteration-count",
    ];
    const selectors = [
      ".workspace-body",
      ".primary-panel",
      ".inspector-toggle",
      ".workspace-inspector",
      ".inspector-header",
      ".subject-tabs",
      ".subject-tabs button",
      ".execution-origin",
      ".execution-origin-title",
      ".activity-card",
      ".execution-step",
      ".inspector-resizer",
      ".subject-content",
      ".collaboration",
    ];
    const nodes = selectors.flatMap((selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((element) => {
        const box = element.getBoundingClientRect(),
          computed = getComputedStyle(element);
        return {
          selector,
          rect: [box.x, box.y, box.width, box.height],
          style: Object.fromEntries(
            properties.map((key) => [key, computed.getPropertyValue(key)]),
          ),
          icons: [...element.querySelectorAll("svg")].map(
            (svg) => svg.outerHTML,
          ),
          aria: [
            element.getAttribute("aria-label"),
            element.getAttribute("aria-selected"),
            element.getAttribute("aria-expanded"),
          ],
        };
      }),
    );
    const panel = document.querySelector<HTMLElement>(".workspace-inspector")!;
    const input =
      document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    return {
      nodes,
      text: panel.innerText,
      draft: input.value,
      inputSame: input === Reflect.get(window, "inspectorInputRef"),
      inputConnected: input.isConnected,
      viewport: [innerWidth, innerHeight],
    };
  });
  // All exercised activities are completed; no running motion is disabled.
  expect(state.inputSame).toBe(true);
  expect(state.inputConnected).toBe(true);
  return {
    state,
    paint: await panel.screenshot({ caret: "hide", animations: "allow" }),
  };
}
type Capture = Awaited<ReturnType<typeof capture>>;

async function renderer(
  browser: Browser,
  baseURL: string,
  manifest: Manifest,
  old: boolean,
  width: number,
  appearance: string,
) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
  });
  let page: Page | undefined;
  try {
    page = await context.newPage();
    const receipts: Promise<Asset & { status: number }>[] = [],
      errors: string[] = [],
      writes: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        url.origin === baseURL &&
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
      if (
        !["GET", "HEAD"].includes(request.method()) &&
        /\/api\/(?:platform\/|inputs\/)/.test(request.url())
      )
        writes.push(request.url());
    });
    if (old) {
      await page.route(`${baseURL}/`, (route) =>
        route.fulfill({ body: manifest.html, contentType: "text/html" }),
      );
      for (const asset of manifest.assets)
        await page.route(`${baseURL}${asset.url}`, (route) =>
          route.fulfill({
            body: readFileSync(
              join(baselineDirectory!, "assets", basename(asset.url)),
            ),
            contentType: asset.url.endsWith(".css")
              ? "text/css"
              : "text/javascript",
          }),
        );
    }
    await page.clock.setFixedTime(new Date("2026-10-02T12:00:00Z"));
    const runtime = {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      model: "inspector-fixture-model",
      activity: {
        available: true,
        truncated: false,
        threads: [] as {
          id: string;
          kind: string;
          projectId: string;
          conversationId: string;
          inputId: null;
          rootId: string;
          sessionId: string;
          contextId: string;
          title: string;
          phase: string;
          lifecycle: string;
          revision: number;
          updatedAt: string;
        }[],
      },
    };
    const fixture = await mockPlatformConversation(page, () => ({
      inputs: [],
      runtime,
    }));
    runtime.activity.threads.push({
      id: "inspector-equivalence-thread",
      kind: "execution",
      projectId: fixture.spaces.dialogueId,
      conversationId: fixture.spaces.dialogueId,
      inputId: null,
      rootId: "inspector-equivalence-root",
      sessionId: "inspector-equivalence-session",
      contextId: "inspector-equivalence-context",
      title: "TEST 同一现场的已完成活动",
      phase: "idle",
      lifecycle: "completed",
      revision: 1,
      updatedAt: "2026-10-02T12:00:00Z",
    });
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "对话", exact: true })
      .click();
    const input = await openInput(page),
      draft = "TEST 原始草稿，不发送。\n仍保留第二行。";
    await input.fill(draft);
    await input.evaluate((element) =>
      Reflect.set(window, "inspectorInputRef", element),
    );
    const inputsBefore = await platformInputState(page, fixture.client),
      conversationsBefore = await fixture.client.allNavigationConversations();
    // The old Host itself ensures its personal spaces during bootstrap. Keep
    // that exact initialization receipt visible; the inspector action interval
    // must perform no Platform mutation, including app-view launch/save/close.
    const initializationWrites = writes.splice(0);
    expect(initializationWrites).toEqual([
      `${baseURL}/api/platform/spaces/ensure`,
    ]);
    await page.setViewportSize({ width, height: 960 });
    await settleTransitions(page);
    // Controlled paint theme only, not a new production preference or token.
    await page
      .locator(".app")
      .evaluate(
        (element, appearance) =>
          element.setAttribute("data-appearance", appearance),
        appearance,
      );
    const toggle = page.locator(".inspector-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
    const phases: Record<string, Capture> = {};
    const tabs = page.getByRole("tablist", { name: "Morphz 信息分类" });
    await tabs.getByRole("tab", { name: "活动", exact: true }).click();
    const activity = page.locator(
      '[data-thread-id="inspector-equivalence-thread"]',
    );
    await expect(activity).toBeVisible();
    phases.overview = await capture(page);
    await activity.click();
    await expect(page.locator(".execution-origin-title")).toHaveText(
      "TEST 同一现场的已完成活动",
    );
    phases.detail = await capture(page);
    await toggle.click();
    await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    await toggle.click();
    await expect(page.locator(".execution-origin-title")).toHaveText(
      "TEST 同一现场的已完成活动",
    );
    phases.reopenedDetail = await capture(page);
    await page
      .getByRole("button", { name: "返回活动列表", exact: true })
      .click();
    await expect(activity).toBeVisible();
    phases.back = await capture(page);
    for (const category of ["授权", "定时任务", "设定"]) {
      await tabs.getByRole("tab", { name: category, exact: true }).click();
      await expect(
        tabs.getByRole("tab", { name: category, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      phases[category] = await capture(page);
    }
    for (const phase of Object.values(phases))
      expect(phase.state.draft).toBe(draft);
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
    expect(await platformInputState(page, fixture.client)).toEqual(
      inputsBefore,
    );
    expect(await fixture.client.allNavigationConversations()).toEqual(
      conversationsBefore,
    );
    const loaded = await Promise.all(receipts);
    for (const asset of manifest.assets)
      expect(loaded).toContainEqual({ ...asset, status: 200 });
    return { phases, loaded, initializationWrites };
  } finally {
    try {
      await page?.unrouteAll({ behavior: "wait" });
    } finally {
      await context.close();
    }
  }
}

for (const width of [1440, 390])
  for (const appearance of ["light", "dark"])
    test(`主体信息栏真实编译 Host 旧新等价：${width}/${appearance}`, async ({
      browser,
      baseURL,
    }, info) => {
      test.skip(
        !baselineDirectory || !candidatePath,
        "需要保存的 85a50934 编译包和候选 manifest；不是常规截图快照",
      );
      const { old, candidate } = manifests();
      const left = await renderer(
        browser,
        baseURL!,
        old,
        true,
        width,
        appearance,
      );
      const right = await renderer(
        browser,
        baseURL!,
        candidate,
        false,
        width,
        appearance,
      );
      await info.attach("verified-asset-responses", {
        body: JSON.stringify(
          {
            old: left.loaded,
            candidate: right.loaded,
            initializationWrites: {
              old: left.initializationWrites,
              candidate: right.initializationWrites,
            },
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect(Object.keys(right.phases)).toEqual(Object.keys(left.phases));
      for (const [name, before] of Object.entries(left.phases)) {
        const after = right.phases[name]!;
        await info.attach(`${name}-old`, {
          body: before.paint,
          contentType: "image/png",
        });
        await info.attach(`${name}-candidate`, {
          body: after.paint,
          contentType: "image/png",
        });
        await info.attach(`${name}-states`, {
          body: JSON.stringify(
            { old: before.state, candidate: after.state },
            null,
            2,
          ),
          contentType: "application/json",
        });
        expect(
          after.state,
          `${name}: geometry, paint declarations, icons, selection, draft and DOM identity`,
        ).toEqual(before.state);
        const { comparatorResult, ...summary } = await compareExchangePaint(
          before.paint,
          after.paint,
        );
        await info.attach(`${name}-paint-diagnostic`, {
          body: JSON.stringify(
            {
              ...summary,
              classifiedDifference: comparatorResult?.errorMessage ?? null,
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
        if (comparatorResult?.diff)
          await info.attach(`${name}-diff`, {
            body: comparatorResult.diff,
            contentType: "image/png",
          });
        expect(
          comparatorResult,
          `${name}: classified non-AA paint, one-LSB calibration`,
        ).toBeNull();
      }
    });
