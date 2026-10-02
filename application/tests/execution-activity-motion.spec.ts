import { expect } from "@playwright/test";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openExecutionPanel } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("真实执行波形沿路径流动，底线与几何稳定；静态、陈旧与断线状态不动", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const threads: ExecutionActivity["threads"] = [];
  let connected = true;
  let available = true;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      activity: { available, truncated: false, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  for (const [id, phase, lifecycle, controlState] of [
    ["TEST-running", "running", "open", "active"],
    ["TEST-waiting", "waiting", "open", "active"],
    ["TEST-paused", "running", "open", "paused"],
    ["TEST-ended", "running", "completed", "active"],
    ["TEST-failed", "running", "failed", "active"],
    ["TEST-cancelled", "running", "cancelled", "active"],
  ])
    threads.push({
      ...fixture.scope,
      id: id!,
      kind: "execution",
      inputId: null,
      rootId: id + "-root",
      sessionId: "TEST-session",
      title: id!,
      phase: phase!,
      lifecycle: lifecycle!,
      controlState: controlState!,
      revision: 1,
      updatedAt: "2026-10-02T12:00:00Z",
    });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  const icon = panel.locator(
    '[data-thread-id="TEST-running"] .execution-activity-icon',
  );
  const svg = icon.locator("svg");
  const flow = svg.locator(".execution-signal-flow");
  const base = svg.locator(".execution-signal-base");
  await expect(svg).toHaveClass("execution-running-signal");
  await expect(svg).toHaveAttribute("aria-hidden", "true");
  await expect(flow).toHaveAttribute("pathLength", "100");
  await expect(flow).toHaveCSS("animation-name", "execution-signal-travel");
  await expect(flow).toHaveCSS("animation-duration", "2.4s");
  await expect(base).toHaveCSS("animation-name", "none");
  await expect(base).toHaveCSS("opacity", "0.38");
  for (const id of ["waiting", "paused", "ended", "failed", "cancelled"])
    await expect(
      panel.locator(
        `[data-thread-id="TEST-${id}"] .execution-activity-icon > svg`,
      ),
    ).toHaveCSS("animation-name", "none");
  const firstTime = await flow.evaluate((node) =>
    Number(node.getAnimations()[0]!.currentTime),
  );
  await expect
    .poll(() =>
      flow.evaluate((node) => Number(node.getAnimations()[0]!.currentTime)),
    )
    .toBeGreaterThan(firstTime + 100);
  // Consecutive real browser frames, not just keyframe assertions.
  const naturalOffsets = [];
  for (let frame = 0; frame < 5; frame++) {
    const target = await flow.evaluate(
      (node) => Number(node.getAnimations()[0]!.currentTime) + 250,
    );
    await expect
      .poll(() =>
        flow.evaluate((node) => Number(node.getAnimations()[0]!.currentTime)),
      )
      .toBeGreaterThan(target);
    naturalOffsets.push(
      await flow.evaluate((node) => getComputedStyle(node).strokeDashoffset),
    );
    await panel.screenshot({
      path: info.outputPath(`running-signal-natural-${frame}.png`),
    });
  }
  expect(new Set(naturalOffsets).size).toBe(5);
  const samples = [];
  for (const time of [
    0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 3000, 3600, 4200, 4800,
  ])
    samples.push(
      await flow.evaluate((node, time) => {
        const animation = node
          .getAnimations()
          .find(
            (item) =>
              (item as CSSAnimation).animationName ===
              "execution-signal-travel",
          )!;
        animation.pause();
        animation.currentTime = time;
        const style = getComputedStyle(node),
          bounds = node.closest("svg")!.getBoundingClientRect(),
          timing = animation.effect!.getTiming();
        return {
          opacity: Number(style.opacity),
          offset: parseFloat(style.strokeDashoffset),
          dash: style.strokeDasharray,
          transform: style.transform,
          stroke: style.stroke,
          duration: timing.duration,
          iterations: timing.iterations,
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
        };
      }, time),
    );
  for (const [index, sample] of samples.entries()) {
    const time = [
      0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 3000, 3600, 4200, 4800,
    ][index]!;
    expect(sample.offset).toBeCloseTo(18 - 118 * ((time % 2400) / 2400), 1);
    expect(sample.dash).toBe("18px, 100px");
    if (time % 2400 === 0) expect(sample.opacity).toBe(0);
    else if (time % 2400 <= 1800) expect(sample.opacity).toBe(1);
    else {
      expect(sample.opacity).toBeGreaterThan(0);
      expect(sample.opacity).toBeLessThan(1);
    }
    expect(sample.transform).toBe("none");
    expect(sample.stroke).toBe(samples[0]!.stroke);
    expect(sample.bounds).toEqual(samples[0]!.bounds);
    expect(sample.bounds.width).toBe(24);
    expect(sample.bounds.height).toBe(24);
    expect(sample.duration).toBe(2400);
    expect(sample.iterations).toBe(Infinity);
  }
  for (const time of [300, 900, 1500, 2100]) {
    await flow.evaluate((node, time) => {
      node.getAnimations()[0]!.currentTime = time;
    }, time);
    await panel.screenshot({
      path: info.outputPath(`running-signal-phase-${time}.png`),
    });
  }
  await openSettings(page, "外观");
  await page.getByRole("button", { name: "鸢尾紫", exact: true }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.keyboard.press("Escape");
  await flow.evaluate((node) => {
    const animation = node.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 900;
  });
  await expect(flow).toHaveCSS(
    "stroke",
    await icon.evaluate((node) => getComputedStyle(node).color),
  );
  await panel.screenshot({
    path: info.outputPath("running-signal-dark-iris.png"),
  });
  connected = false;
  await fixture.refresh();
  await expect(icon).toHaveAttribute("data-status", "unknown");
  await expect(flow).toHaveCount(0);
  await expect(svg).toHaveCSS("animation-name", "none");
  connected = true;
  available = false;
  await fixture.refresh();
  await expect(icon).toHaveAttribute("data-status", "unknown");
  await expect(flow).toHaveCount(0);
  await expect(svg).toHaveCSS("animation-name", "none");
  available = true;
  await fixture.refresh();
  await expect(flow).toHaveCSS("animation-name", "execution-signal-travel");
  // Terminal lifecycle wins even if the cached phase still says running.
  threads[0]!.lifecycle = "completed";
  threads[0]!.revision++;
  await fixture.refresh();
  await expect(icon).toHaveAttribute("data-status", "ended");
  await expect(svg).toHaveCSS("animation-name", "none");
});

test("系统与客户端减少动画均只保留静态波形，不改变真实运行状态", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const threads: ExecutionActivity["threads"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: { available: true, truncated: false, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  threads.push({
    ...fixture.scope,
    id: "TEST-running-reduce",
    kind: "execution",
    inputId: null,
    rootId: "TEST-root",
    sessionId: "TEST-session",
    title: "TEST 正在执行",
    phase: "running",
    lifecycle: "open",
    revision: 1,
    updatedAt: "2026-10-02T12:00:00Z",
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openExecutionPanel(page);
  const icon = page.locator(
      '[data-thread-id="TEST-running-reduce"] .execution-activity-icon',
    ),
    svg = icon.locator("svg"),
    flow = svg.locator(".execution-signal-flow"),
    base = svg.locator(".execution-signal-base");
  await expect(flow).toHaveCSS("animation-name", "execution-signal-travel");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(flow).toHaveCSS("animation-name", "none");
  await expect(flow).toHaveCSS("opacity", "0");
  await expect(base).toHaveCSS("opacity", "1");
  await expect(icon).toHaveAttribute("data-status", "running");
  await icon.screenshot({
    path: info.outputPath("running-signal-reduced.png"),
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(flow).toHaveCSS("animation-name", "execution-signal-travel");
  const settings = await openSettings(page, "外观");
  await settings.getByLabel("动画效果", { exact: true }).selectOption("reduce");
  await expect(page.locator("html")).toHaveAttribute(
    "data-app-motion",
    "reduce",
  );
  await expect(flow).toHaveCSS("animation-name", "none");
  await expect(flow).toHaveCSS("opacity", "0");
  await expect(base).toHaveCSS("opacity", "1");
  await expect(icon).toHaveAttribute("data-status", "running");
  await settings.getByLabel("动画效果", { exact: true }).selectOption("system");
  await page.keyboard.press("Escape");
  await expect(flow).toHaveCSS("animation-name", "execution-signal-travel");
});
