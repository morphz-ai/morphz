import { expect, type Page, type Route } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { ModelCatalog } from "../packages/core/src/inference.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
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

test("真实滑块悬停居中放大、移开恢复，轨道和4px刻度不位移且不改变选择", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await chooseReasoning(f.slider, "high");
  const model = f.settings.getByLabel("本次输入模型", { exact: true });
  const whiteDiameter = async () => {
    const encoded = (
      await f.slider.screenshot({ scale: "css", animations: "disabled" })
    ).toString("base64");
    return page.evaluate(async (encoded) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], {
          type: "image/png",
        }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const center = Math.round(12 + (canvas.width - 24) * 0.75);
      const y = Math.floor(canvas.height / 2);
      const white = (x: number) =>
        [0, 1, 2].every(
          (channel) => data[(y * canvas.width + x) * 4 + channel]! >= 245,
        );
      let left = center,
        right = center;
      while (left > 0 && white(left - 1)) left--;
      while (right < canvas.width - 1 && white(right + 1)) right++;
      return { width: right - left + 1, center: (left + right) / 2 };
    }, encoded);
  };
  for (const [width, appearance] of [
    [1440, "dark"],
    [390, "light"],
  ] as const) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate((appearance) => {
      document.documentElement.dataset.appearance = appearance;
      document.querySelector<HTMLElement>(".app")!.dataset.appearance =
        appearance;
    }, appearance);
    await model.focus();
    await model.hover();
    const normal = await whiteDiameter();
    const bounds = (await f.slider.boundingBox())!;
    const positions = await f.control
      .locator(".composer-reasoning-stops > span")
      .evaluateAll((points) =>
        points.map((point) => point.getBoundingClientRect().x),
      );
    const x = bounds.x + 12 + (bounds.width - 24) * 0.75;
    await page.mouse.move(x, bounds.y + bounds.height / 2);
    // Native pseudo-element transitions can still be mid-frame when the
    // screenshot API resolves; wait for actual painted diameter, not a sleep.
    await expect
      .poll(async () => (await whiteDiameter()).width)
      .toBeGreaterThanOrEqual(normal.width + 3);
    const hover = await whiteDiameter();
    expect(hover.width).toBeGreaterThanOrEqual(normal.width + 3);
    expect(hover.width).toBeLessThanOrEqual(normal.width + 6);
    expect(Math.abs(hover.center - normal.center)).toBeLessThanOrEqual(0.5);
    expect(await f.slider.boundingBox()).toEqual(bounds);
    expect(
      await f.control
        .locator(".composer-reasoning-stops > span")
        .evaluateAll((points) =>
          points.map((point) => point.getBoundingClientRect().x),
        ),
    ).toEqual(positions);
    await page.screenshot({
      path: info.outputPath(`reasoning-hover-${appearance}-${width}.png`),
      fullPage: true,
    });
    await page.mouse.down();
    try {
      await expect(f.slider).toHaveAttribute("aria-valuetext", "high");
    } finally {
      await page.mouse.up();
    }
    await model.focus();
    await model.hover();
    await expect.poll(whiteDiameter).toEqual(normal);
  }
  await expect(f.slider).toHaveAttribute("aria-valuetext", "high");
  await expect(f.input).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("模型和推理标签统一纯文字、同轴同字号，不增加空图标位或发送消息", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await chooseReasoning(f.slider, "max");
  for (const [width, appearance] of [
    [1440, "dark"],
    [390, "light"],
  ] as const) {
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: width === 390 ? 700 : 960 });
    await page.evaluate((appearance) => {
      document.documentElement.dataset.appearance = appearance;
      document.querySelector<HTMLElement>(".app")!.dataset.appearance =
        appearance;
    }, appearance);
    await openInput(page);
    await openComposerSettings(page);
    await expect(
      f.settings.locator(
        ".composer-model-selector > svg, .composer-reasoning-heading > svg",
      ),
    ).toHaveCount(0);
    const geometry = await f.settings.evaluate((element) => {
      const model = element.querySelector<HTMLElement>(
        ".composer-model-selector > span",
      )!;
      const effort = element.querySelector<HTMLElement>(
        ".composer-reasoning-heading > span:first-child",
      )!;
      const modelBounds = model.getBoundingClientRect();
      const effortBounds = effort.getBoundingClientRect();
      const modelStyle = getComputedStyle(model);
      const effortStyle = getComputedStyle(effort);
      return {
        modelLeft: modelBounds.left,
        effortLeft: effortBounds.left,
        modelFont: modelStyle.fontSize,
        effortFont: effortStyle.fontSize,
        modelWeight: modelStyle.fontWeight,
        effortWeight: effortStyle.fontWeight,
        modelBottom: modelBounds.bottom,
        effortTop: effortBounds.top,
      };
    });
    expect(
      Math.abs(geometry.modelLeft - geometry.effortLeft),
    ).toBeLessThanOrEqual(1);
    expect(geometry.modelFont).toBe("13px");
    expect(geometry.effortFont).toBe(geometry.modelFont);
    expect(geometry.effortWeight).toBe(geometry.modelWeight);
    expect(geometry.effortTop).toBeGreaterThan(geometry.modelBottom);
    await f.settings.getByLabel("本次输入模型", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(f.slider).toBeFocused();
    await expect(f.slider).toHaveAttribute("aria-valuetext", "max");
    await expect(f.reset).toBeEnabled();
    await page.screenshot({
      path: info.outputPath(`aligned-settings-${appearance}-${width}.png`),
      fullPage: true,
    });
  }
  await expect(f.input).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("刻度保持4px与原位置，亮暗四主题填色区均为柔和浅色而非深色文字色", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await expect(f.slider).toBeEnabled();
  for (const appearance of ["light", "dark"]) {
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await page.evaluate(
        ({ accent, appearance }) => {
          document.documentElement.dataset.appearance = appearance;
          const app = document.querySelector<HTMLElement>(".app")!;
          app.dataset.appearance = appearance;
          app.dataset.accent = accent;
        },
        { accent, appearance },
      );
      for (const explicit of [false, true]) {
        if (explicit) await chooseReasoning(f.slider, "high");
        else if (await f.reset.isEnabled()) await f.reset.click();
        // Blur the focus treatment without changing either model or effort.
        await f.settings.getByLabel("本次输入模型", { exact: true }).focus();
        const rail = f.control.locator(".composer-reasoning-rail");
        const points = await rail.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [
            ...element.querySelectorAll<HTMLElement>(
              ".composer-reasoning-stops > span",
            ),
          ].map((point) => {
            const dot = point.querySelector("i")!.getBoundingClientRect();
            return {
              x: dot.left + dot.width / 2 - bounds.left,
              y: dot.top + dot.height / 2 - bounds.top,
              width: dot.width,
              height: dot.height,
              filled: point.dataset.filled === "true",
              selected: point.dataset.selected === "true",
              centerY: bounds.height / 2,
            };
          });
        });
        expect(points).toHaveLength(5);
        expect(points.filter((point) => point.selected)).toHaveLength(
          explicit ? 1 : 0,
        );
        for (const point of points) {
          expect(point.width).toBe(4);
          expect(point.height).toBe(4);
          expect(Math.abs(point.y - point.centerY)).toBeLessThanOrEqual(0.5);
        }
        const samples = await page.evaluate(
          async ({ encoded, points }) => {
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
            const { data } = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            const luminance = (x: number, y: number) => {
              const offset = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
              return [0.2126, 0.7152, 0.0722].reduce(
                (total, weight, channel) => {
                  const value = data[offset + channel]! / 255;
                  return (
                    total +
                    weight *
                      (value <= 0.04045
                        ? value / 12.92
                        : ((value + 0.055) / 1.055) ** 2.4)
                  );
                },
                0,
              );
            };
            const rgb = (x: number, y: number) => {
              const offset = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
              return Array.from(data.slice(offset, offset + 3));
            };
            return points
              .filter((point) => !point.selected)
              .map((point) => {
                const dot = luminance(point.x, point.y);
                const track = luminance(point.x, point.y - 6);
                return {
                  filled: point.filled,
                  dot: rgb(point.x, point.y),
                  track: rgb(point.x, point.y - 6),
                  contrast:
                    (Math.max(dot, track) + 0.05) /
                    (Math.min(dot, track) + 0.05),
                };
              });
          },
          {
            encoded: (await rail.screenshot({ scale: "css" })).toString(
              "base64",
            ),
            points,
          },
        );
        for (const sample of samples) {
          const context = `${appearance}/${accent}, explicit=${explicit}`;
          if (sample.filled) {
            // Decorative ticks follow the reviewed reference: 55% white tint,
            // not a black text-contrast target. The value/thumb remain primary.
            sample.dot.forEach((channel, index) => {
              expect(
                Math.abs(channel - (sample.track[index]! * 0.45 + 255 * 0.55)),
                context,
              ).toBeLessThanOrEqual(3);
            });
          } else expect(sample.contrast, context).toBeGreaterThanOrEqual(3);
        }
        if (accent === "cyan" && explicit)
          await page.screenshot({
            path: info.outputPath(`visible-stops-${appearance}.png`),
            fullPage: true,
          });
      }
    }
  }
  await expect(f.input).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("继承轻量仍显示默认：弹层、底栏、重开与刷新一致，只有明确选择才显示轻量", async ({
  page,
}) => {
  const f = await prepare(page, (route) =>
    route.fulfill({
      json: { ...catalog, reasoning: { ...catalog.reasoning, current: "low" } },
    }),
  );
  const summary = page.locator(
    ".composer-settings-trigger .composer-settings-effort",
  );
  await expect(f.slider).toHaveAttribute("aria-valuetext", "default");
  await expect(summary).toHaveText("default");
  await page.keyboard.press("Escape");
  await expect(summary).toHaveText("default");
  await openComposerSettings(page);
  await expect(f.slider).toHaveAttribute("aria-valuetext", "default");
  await chooseReasoning(f.slider, "low");
  await expect(summary).toHaveText("low");
  await f.reset.click();
  await expect(summary).toHaveText("default");
  await expect(f.input).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
  await f.input.fill("");
  await page.reload();
  await openInput(page);
  await openComposerSettings(page);
  await expect(
    page.getByLabel("本次输入推理强度", { exact: true }),
  ).toHaveAttribute("aria-valuetext", "default");
  await expect(summary).toHaveText("default");
  expect(f.writes).toEqual([]);
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
  await expect(f.slider).toHaveAttribute("aria-valuetext", "default");
  await expect(f.control.locator(".composer-reasoning-value")).toHaveText(
    "default",
  );
  await expect(
    f.control.locator(".composer-reasoning-rail"),
  ).not.toHaveAttribute("data-selected", "true");
  await expect(f.control.locator(".composer-reasoning-model")).toHaveCount(0);
  await expect(f.slider).toHaveAttribute("title", /TEST-real-model/);
  await expect(f.control.locator("select")).toHaveCount(0);
  await expect(
    f.settings.getByLabel("本次输入模型", { exact: true }),
  ).toHaveCount(1);
  await expect(
    f.control.locator("select[aria-label='本次输入推理强度']"),
  ).toHaveCount(0);
  await expect(f.reset).toBeDisabled();
  await f.control.locator(".composer-reasoning-value").click();
  await expect(f.slider).toBeFocused();
  await expect(f.slider).toHaveAttribute("aria-valuetext", "default");
  await expect(f.control.locator(".composer-reasoning-value")).toHaveCSS(
    "text-decoration-line",
    "underline",
  );
  await expect(
    f.control.locator(".composer-reasoning-rail"),
  ).not.toHaveAttribute("data-selected", "true");
  // Native range DOM value is already min while inherited. A real click on
  // that same first stop still has to become an explicit choice.
  await f.slider.click({ position: { x: 7, y: 12 } });
  await expect(f.slider).toHaveAttribute("aria-valuetext", "none");
  await expect(f.control).toHaveAttribute("data-state", "explicit");
  await expect(f.reset).toBeEnabled();
  await f.reset.click();
  await expect(f.control).toHaveAttribute("data-state", "default");
  await expect(f.slider).toBeFocused();
  await expect(f.slider).toHaveAttribute("aria-valuetext", "default");
  await f.slider.focus();
  await f.slider.press("ArrowRight");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "none");
  await f.slider.press("ArrowRight");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "low");
  await f.slider.press("End");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "max");
  await f.settings.getByLabel("本次输入模型", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(f.slider).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(f.reset).toBeFocused();
  await f.slider.focus();
  await f.slider.press("ArrowLeft");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "high");
  await f.slider.press("Home");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "none");
  await f.reset.click();
  await expect(f.control).toHaveAttribute("data-state", "default");
  await expect(f.input).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
  await f.settings.screenshot({
    path: info.outputPath("reasoning-default.png"),
  });
  await chooseReasoning(f.slider, "high");
  // Verify the unchanged normal thumb separately from its deliberate focus cue.
  await f.settings.getByLabel("本次输入模型", { exact: true }).focus();
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
  await expect(f.control.locator(".composer-reasoning-stops i")).toHaveCount(2);
  await chooseReasoning(f.slider, "high");
  await f.settings
    .getByLabel("本次输入模型", { exact: true })
    .selectOption("automatic");
  await expect(f.control).toHaveAttribute("data-state", "unsupported");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "high · 不支持");
  await expect(f.slider).toHaveAttribute("data-efforts", "");
  await expect(f.control.locator(".composer-reasoning-stops i")).toHaveCount(0);
  await expect(f.slider).toBeDisabled();
  await expect(f.control.getByRole("alert")).toHaveText("请重新选择推理强度");
  await f.reset.click();
  await expect(f.control).toHaveAttribute("data-state", "default");
  await expect(f.control).toBeFocused();
  await expect(f.control.locator(".composer-reasoning-value")).toHaveText(
    "default",
  );
  await expect(f.control.getByRole("alert")).toHaveCount(0);
  await f.settings
    .getByLabel("本次输入模型", { exact: true })
    .selectOption("single");
  await expect(f.slider).toBeEnabled();
  await expect(f.slider).toHaveAttribute("data-efforts", "medium");
  await expect(f.control.locator(".composer-reasoning-stops i")).toHaveCount(1);
  await f.slider.click({ position: { x: 7, y: 12 } });
  await expect(f.slider).toHaveAttribute("aria-valuetext", "medium");
  models.options[2]!.supported_reasoning_efforts = ["max"];
  await page.evaluate(() =>
    window.dispatchEvent(new Event("morphz:models-changed")),
  );
  await expect(f.slider).toHaveAttribute("data-efforts", "max");
  await expect(f.control).toHaveAttribute("data-state", "unsupported");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "medium · 不支持");
  await f.slider.focus();
  await f.slider.press("Home");
  await expect(f.slider).toHaveAttribute("aria-valuetext", "max");
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
      "用于后续新输入，不改变已提交工作；默认沿用模型设置。实际支持以所选模型为准。",
    );
    await expect(f.input).toHaveValue(f.draft);
    expect(f.writes).toEqual([]);
  } finally {
    release();
  }
});

test("390px 与 200% 下强度组与胶囊轨道不溢出，键盘焦点可见且调节不关闭菜单", async ({
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
      const output = element.querySelector(".composer-reasoning-value")!;
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
        headingRight: heading.right,
        outputRight: outputRect.right,
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
      Math.abs(geometry.headingRight - geometry.outputRight),
    ).toBeLessThanOrEqual(1);
    expect(geometry.sliderHeight).toBeGreaterThanOrEqual(34 * zoom!);
    expect(geometry.railWidth).toBeGreaterThan(150);
    expect(geometry.sliderTop).toBeGreaterThanOrEqual(geometry.headingBottom);
    expect(Number.parseFloat(geometry.outputFont)).toBe(13);
    expect(geometry.sliderTop - geometry.headingBottom).toBeLessThanOrEqual(
      4 * zoom!,
    );
    await f.settings.getByLabel("本次输入模型", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(f.slider).toBeFocused();
    await expect(f.slider).toHaveCSS("outline-style", "solid");
    await f.slider.press("End");
    await expect(f.slider).toHaveAttribute("aria-valuetext", "max");
    await expect(f.settings).toBeVisible();
    await f.reset.click();
    await expect(f.input).toHaveValue(f.draft);
    await f.settings.screenshot({
      path: info.outputPath(`reasoning-${width}-zoom-${zoom}.png`),
    });
  }
  expect(f.writes).toEqual([]);
});

test.describe("触控执行设置", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 700 } });
  test("四主题亮暗下模型和强度仍分组，触控目标完整，点击当前值不更改强度", async ({
    page,
  }, info) => {
    const f = await prepare(page);
    await chooseReasoning(f.slider, "max");
    await expect(
      f.settings.getByLabel("本次输入模型", { exact: true }),
    ).toHaveCSS("font-size", "16px");
    for (const control of [
      f.reset,
      f.slider,
      f.control.locator(".composer-reasoning-heading"),
    ])
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(f.control.locator(".composer-reasoning-heading")).toHaveCSS(
      "-webkit-tap-highlight-color",
      "rgba(0, 0, 0, 0)",
    );
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      for (const appearance of ["light", "dark"]) {
        await page.evaluate(
          ({ accent, appearance }) => {
            document.documentElement.dataset.appearance = appearance;
            const app = document.querySelector<HTMLElement>(".app")!;
            app.dataset.appearance = appearance;
            app.dataset.accent = accent;
          },
          { accent, appearance },
        );
        await f.control.locator(".composer-reasoning-value").tap();
        await expect(f.slider).toBeFocused();
        await expect(f.slider).toHaveAttribute("aria-valuetext", "max");
        await expect(f.control.locator(".composer-reasoning-value")).toHaveCSS(
          "text-decoration-line",
          "underline",
        );
        await page.screenshot({
          path: info.outputPath(
            `full-touch-settings-${accent}-${appearance}.png`,
          ),
        });
      }
    }
    await expect(f.input).toHaveValue(f.draft);
    expect(f.writes).toEqual([]);
  });
});
