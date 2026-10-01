import { test, expect, type Page, type Route } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { ModelCatalog } from "../packages/core/src/inference.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";
import { openComposerSettings, openInput } from "./interaction-helpers.js";
import { chooseReasoning } from "./reasoning-helpers.js";

const catalog: ModelCatalog = {
  current: "reasoning-route",
  options: [
    {
      id: "reasoning-route",
      label: "TEST 推理线路",
      physical_models: ["TEST-real-model"],
      supported_reasoning_efforts: ["none", "low", "medium", "high", "max"],
    },
  ],
  reasoning: {
    current: "high",
    levels: ["none", "low", "medium", "high", "max"],
  },
};

async function prepare(
  page: Page,
  models: (route: Route) => Promise<void> = (route) =>
    route.fulfill({ json: catalog }),
) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(?:messages|conversations\/start)(?:\?|$)/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  await page.route("**/api/models", models);
  await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      model: "reasoning-route",
      activity: { available: true, truncated: false, threads: [] },
      attention: { available: true, approvals: [] },
    },
  }));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  const draft = "TEST 强度调节保留的未发送草稿";
  await input.fill(draft);
  const settings = await openComposerSettings(page);
  const slider = settings.getByLabel("本次输入推理强度", { exact: true });
  const control = settings.locator(".composer-reasoning-control");
  const reset = settings.getByRole("button", {
    name: "恢复默认推理强度",
    exact: true,
  });
  return { input, draft, settings, slider, control, reset, writes };
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("默认不冒充标准：首档可鼠标选择、键盘离散调节并恢复默认，不发消息或丢草稿", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await expect(f.slider).toBeEnabled();
  expect((await f.slider.boundingBox())!.width).toBeGreaterThan(200);
  await expect(f.control.locator(".composer-reasoning-stops")).toHaveText("");
  await expect(
    f.control.locator(".composer-reasoning-stops > span > span"),
  ).toHaveCount(0);
  await expect(f.control.locator(".composer-reasoning-stops i")).toHaveCount(5);
  await expect(f.slider).toHaveAttribute("type", "range");
  await expect(f.slider).toHaveAttribute(
    "data-efforts",
    "none,low,medium,high,max",
  );
  await expect(f.control).toHaveAttribute("data-state", "default");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "默认");
  await expect(f.control.locator(".composer-reasoning-value")).toHaveText(
    "默认",
  );
  await expect(
    f.control.locator(".composer-reasoning-rail"),
  ).not.toHaveAttribute("data-selected", "true");
  await expect(f.control.locator(".composer-reasoning-model")).toHaveCount(0);
  await expect(f.slider).toHaveAttribute("title", /TEST-real-model/);
  await expect(f.control.locator("select")).toHaveCount(0);
  await expect(f.reset).toBeDisabled();
  // Native range DOM value is already min while inherited. A real click on
  // that same first stop still has to become an explicit choice.
  await f.slider.click({ position: { x: 7, y: 12 } });
  await expect(f.slider).toHaveAttribute("aria-valuetext", "关闭");
  await expect(f.control).toHaveAttribute("data-state", "explicit");
  await expect(f.reset).toBeEnabled();
  await f.reset.click();
  await expect(f.control).toHaveAttribute("data-state", "default");
  await expect(f.slider).toBeFocused();
  await expect(f.slider).toHaveAttribute("aria-valuetext", "默认");
  await f.slider.focus();
  await f.slider.press("ArrowRight");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "关闭");
  await f.slider.press("ArrowRight");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "轻量");
  await f.slider.press("End");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "最高");
  await f.slider.press("ArrowLeft");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "深入");
  await f.slider.press("Home");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "关闭");
  await f.reset.click();
  await expect(f.control).toHaveAttribute("data-state", "default");
  await expect(f.input).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
  await f.settings.screenshot({
    path: info.outputPath("reasoning-default.png"),
  });
  await chooseReasoning(f.slider, "high");
  for (const appearance of ["light", "dark"] as const) {
    await page.evaluate((appearance) => {
      document.documentElement.dataset.appearance = appearance;
      document.querySelector<HTMLElement>(".app")!.dataset.appearance =
        appearance;
    }, appearance);
    await f.settings.screenshot({
      path: info.outputPath(`reasoning-explicit-high-${appearance}.png`),
    });
    // Inspect rasterized native range parts. Chromium does not expose their
    // actual thumb box as a DOM node, and pseudo computed styles can report
    // the input's metrics, so stylesheet names alone are not visual evidence.
    const png = await f.slider.screenshot({
      scale: "css",
      path: info.outputPath(`reasoning-rendered-rail-${appearance}.png`),
    });
    const pixels = await page.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const rgb = (x: number, y: number) => {
        const offset = (Math.round(y) * canvas.width + Math.round(x)) * 4;
        return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
      };
      const white = (colour: number[]) =>
        colour.every((channel) => channel >= 245);
      const distance = (a: number[], b: number[]) =>
        Math.max(...a.map((channel, index) => Math.abs(channel - b[index]!)));
      const centerX = Math.round(12 + (canvas.width - 24) * 0.75);
      const centerY = Math.floor(canvas.height / 2);
      const sampleY = centerY - 4;
      let left = centerX,
        right = centerX;
      while (left > 0 && white(rgb(left - 1, sampleY))) left--;
      while (right < canvas.width - 1 && white(rgb(right + 1, sampleY)))
        right++;
      const background = rgb(0, 0);
      const trackX = Math.floor(canvas.width / 4);
      const trackRows = Array.from(
        { length: canvas.height },
        (_, y) => y,
      ).filter((y) => distance(rgb(trackX, y), background) > 20);
      const edgeX = 1;
      return {
        width: canvas.width,
        height: canvas.height,
        thumbCenterWhite: white(rgb(centerX, sampleY)),
        thumbWhiteWidth: right - left + 1,
        thumbCornerWhite: white(rgb(centerX - 10, centerY - 10)),
        trackThickness: trackRows.length,
        roundedEndDifference: distance(rgb(edgeX, centerY), rgb(edgeX, 1)),
      };
    }, png.toString("base64"));
    expect(pixels.width).toBeGreaterThan(200);
    expect(pixels.thumbCenterWhite).toBe(true);
    expect(pixels.thumbWhiteWidth).toBeGreaterThanOrEqual(18);
    expect(pixels.thumbWhiteWidth).toBeLessThanOrEqual(26);
    expect(pixels.thumbCornerWhite).toBe(false);
    expect(pixels.trackThickness).toBeGreaterThanOrEqual(22);
    expect(pixels.trackThickness).toBeLessThanOrEqual(26);
    expect(pixels.roundedEndDifference).toBeGreaterThan(12);
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "执行设置", exact: true }),
  ).toBeFocused();
  await expect(f.input).toHaveValue(f.draft);
});

test("档位按所选模型声明，不兼容选择保留且可恢复默认，零档位不捏造可调能力", async ({
  page,
}) => {
  const models: ModelCatalog = {
    ...catalog,
    options: [
      {
        id: "reasoning-route",
        label: "TEST 两档模型",
        supported_reasoning_efforts: ["high", "low"],
      },
      {
        id: "automatic",
        label: "TEST 自动模型",
        supported_reasoning_efforts: [],
      },
      {
        id: "single",
        label: "TEST 单档模型",
        supported_reasoning_efforts: ["medium"],
      },
    ],
  };
  const f = await prepare(page, (route) => route.fulfill({ json: models }));
  await expect(f.slider).toHaveAttribute("data-efforts", "low,high");
  await chooseReasoning(f.slider, "high");
  await f.settings
    .getByLabel("本次输入模型", { exact: true })
    .selectOption("automatic");
  await expect(f.control).toHaveAttribute("data-state", "unsupported");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "深入 · 不支持");
  await expect(f.slider).toHaveAttribute("data-efforts", "");
  await expect(f.slider).toBeDisabled();
  await expect(f.control.getByRole("alert")).toHaveText("请重新选择推理强度");
  await f.reset.click();
  await expect(f.control).toHaveAttribute("data-state", "default");
  await expect(f.control).toBeFocused();
  await expect(f.control.locator(".composer-reasoning-value")).toHaveText(
    "模型自动",
  );
  await expect(f.control.getByRole("alert")).toHaveCount(0);
  await f.settings
    .getByLabel("本次输入模型", { exact: true })
    .selectOption("single");
  await expect(f.slider).toBeEnabled();
  await expect(f.slider).toHaveAttribute("data-efforts", "medium");
  await f.slider.click({ position: { x: 7, y: 12 } });
  await expect(f.slider).toHaveAttribute("aria-valuetext", "标准");
  models.options[2]!.supported_reasoning_efforts = ["max"];
  await page.evaluate(() =>
    window.dispatchEvent(new Event("morphz:models-changed")),
  );
  await expect(f.slider).toHaveAttribute("data-efforts", "max");
  await expect(f.control).toHaveAttribute("data-state", "unsupported");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "标准 · 不支持");
  await f.slider.focus();
  await f.slider.press("Home");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "最高");
  await expect(f.input).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("加载、失败、旧服务与未声明模型能力分别保留，重试不丢草稿", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let requests = 0;
  let legacy = true;
  const f = await prepare(page, async (route) => {
    if (++requests === 1) {
      await gate;
      await route.fulfill({
        status: 503,
        json: { message: "TEST 模型目录读取失败" },
      });
      return;
    }
    await route.fulfill({
      json: {
        current: "reasoning-route",
        options: [
          {
            id: "reasoning-route",
            label: "TEST 能力未声明模型",
            supported_reasoning_efforts: null,
          },
        ],
        ...(!legacy
          ? { reasoning: { current: null, levels: ["low", "high"] } }
          : {}),
      },
    });
  });
  try {
    await expect(f.control).toHaveAttribute("title", "正在读取模型设置…");
    await expect(f.slider).toBeDisabled();
    release();
    await expect(f.control).toHaveAttribute(
      "title",
      "暂时无法读取模型设置，请重试。",
    );
    await expect(f.slider).toBeDisabled();
    await f.settings.getByRole("button", { name: "重试", exact: true }).click();
    await expect(
      f.settings.getByLabel("本次输入模型", { exact: true }),
    ).toBeFocused();
    await expect(f.control).toHaveAttribute(
      "title",
      "当前运行服务不支持推理强度设置。",
    );
    await expect(f.slider).toBeDisabled();
    legacy = false;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("morphz:models-changed")),
    );
    await expect(f.slider).toHaveAttribute("data-efforts", "low,high");
    await expect(f.slider).toBeEnabled();
    await expect(f.control).toHaveAttribute(
      "title",
      "仅用于下一次发送；默认沿用模型设置。实际支持以所选模型为准。",
    );
    await expect(f.input).toHaveValue(f.draft);
    expect(f.writes).toEqual([]);
  } finally {
    release();
  }
});

test("390px 与 200% 下居中强度与胶囊轨道不溢出，键盘焦点可见且调节不关闭菜单", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await expect(f.slider).toBeEnabled();
  for (const [width, zoom] of [
    [390, 1],
    [1440, 2],
  ]) {
    await page.keyboard.press("Escape");
    await page.setViewportSize({
      width: width!,
      height: zoom === 2 ? 960 : 540,
    });
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, zoom);
    await openInput(page);
    await openComposerSettings(page);
    await expect(f.slider).toBeInViewport();
    await expect(f.reset).toBeInViewport();
    const geometry = await f.control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const slider = element.querySelector("input")!.getBoundingClientRect();
      const heading = element
        .querySelector(".composer-reasoning-heading")!
        .getBoundingClientRect();
      const output = element.querySelector("output")!;
      const outputRect = output.getBoundingClientRect();
      const markers = [
        ...element.querySelectorAll<HTMLElement>(".composer-reasoning-stops i"),
      ];
      return {
        left: rect.left,
        right: rect.right,
        overflow: element.scrollWidth > element.clientWidth + 1,
        sliderTop: slider.top,
        headingBottom: heading.bottom,
        outputFont: getComputedStyle(output).fontSize,
        railWidth: slider.width,
        headingCenter: heading.x + heading.width / 2,
        outputCenter: outputRect.x + outputRect.width / 2,
        sliderHeight: slider.height,
        markerText: element.querySelector(".composer-reasoning-stops")!
          .textContent,
        markersWithin: markers.every((marker) => {
          const bounds = marker.getBoundingClientRect();
          return bounds.left >= rect.left && bounds.right <= rect.right;
        }),
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width!);
    expect(geometry.overflow).toBe(false);
    expect(geometry.markerText).toBe("");
    expect(geometry.markersWithin).toBe(true);
    expect(
      Math.abs(geometry.headingCenter - geometry.outputCenter),
    ).toBeLessThanOrEqual(1);
    expect(geometry.sliderHeight).toBeGreaterThanOrEqual(34 * zoom!);
    expect(geometry.railWidth).toBeGreaterThan(150);
    expect(geometry.sliderTop).toBeGreaterThanOrEqual(geometry.headingBottom);
    expect(Number.parseFloat(geometry.outputFont)).toBeGreaterThanOrEqual(15);
    await f.settings.getByLabel("本次输入模型", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(f.slider).toBeFocused();
    await expect(f.slider).toHaveCSS("outline-style", "solid");
    await f.slider.press("End");
    await expect(f.slider).toHaveAttribute("aria-valuetext", "最高");
    await expect(f.settings).toBeVisible();
    await f.reset.click();
    await expect(f.input).toHaveValue(f.draft);
    await f.settings.screenshot({
      path: info.outputPath(`reasoning-${width}-zoom-${zoom}.png`),
    });
  }
  expect(f.writes).toEqual([]);
});
