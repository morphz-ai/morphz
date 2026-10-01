import { test, expect, type Locator } from "@playwright/test";
import {
  conversationRuntimeSchema,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { openInput } from "./interaction-helpers.js";

const silhouette =
  "M8 4 48 40 38 40 38 70 8 92Z M88 4 48 40 58 40 58 70 88 92Z";
const runtimeSnapshot = (): ConversationRuntime =>
  conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "TEST Logo动效",
    error: "",
    messages: [],
    deliveries: [],
    // Bounded completed history must not make a complete open-work census
    // unknown. This is the current production projection's explicit contract.
    activity: {
      available: true,
      truncated: true,
      openWorkComplete: true,
      threads: [],
    },
    attention: { available: true, approvals: [] },
  });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function expectBareLogo(logo: Locator) {
  await expect(logo.locator(".agent-presence-status")).toHaveCount(0);
  await expect(logo.locator(".agent-presence-mark > *")).toHaveCount(1);
  await expect(logo.locator(".agent-presence-mark > .brand-mark")).toHaveCount(
    1,
  );
}

async function sampleAnimation(
  element: Locator,
  name: string,
  currentTime: number,
) {
  return element.evaluate(
    (node, { name, currentTime }) => {
      const animation = node
        .getAnimations()
        .find((value) => (value as CSSAnimation).animationName === name);
      if (!animation) throw new Error(`Missing actual CSSAnimation: ${name}`);
      animation.pause();
      animation.currentTime = currentTime;
      const style = getComputedStyle(node);
      const timing = animation.effect!.getTiming();
      return {
        transform: style.transform,
        opacity: Number(style.opacity),
        currentTime: Number(animation.currentTime),
        duration: timing.duration,
        iterations: timing.iterations,
      };
    },
    { name, currentTime },
  );
}

test("空闲Logo流光真实可见、悬停持续回应，减少动态静止且不挂状态下标", async ({
  page,
}, info) => {
  const runtime = runtimeSnapshot();
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime,
  }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const handle = page.getByRole("separator", {
    name: "调整左侧栏宽度",
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press("Home");
  const logo = page.locator(".sidebar .wordmark.agent-presence");
  const mark = logo.locator(".brand-mark");
  const glint = mark.locator(".brand-mark-glint");
  await expect(logo).toHaveAttribute("data-state", "idle");
  await expectBareLogo(logo);
  await expect(mark).toHaveCSS("width", "32px");
  await expect(mark.locator("path")).toHaveAttribute("d", silhouette);
  await expect(glint).toHaveCSS("animation-name", "subject-mark-glint");

  const atRest = await sampleAnimation(glint, "subject-mark-glint", 0);
  const bounds = await mark.boundingBox();
  const rest = await mark.screenshot({
    path: info.outputPath("idle-rest.png"),
  });
  const lit = await sampleAnimation(glint, "subject-mark-glint", 2800);
  const shimmer = await mark.screenshot({
    path: info.outputPath("idle-glint.png"),
  });
  expect(atRest.opacity).toBe(0);
  expect(lit.opacity).toBeGreaterThan(0.65);
  expect(lit.transform).not.toBe(atRest.transform);
  expect(lit.duration).toBe(8000);
  expect(lit.iterations).toBe(Infinity);
  // Real rasterized silhouette pixels change; declared CSS alone is not enough.
  expect(shimmer.equals(rest)).toBe(false);
  expect(await mark.boundingBox()).toEqual(bounds);
  await glint.evaluate((node) => {
    const animation = node.getAnimations()[0]!;
    animation.currentTime = 0;
    animation.play();
  });
  await expect
    .poll(() =>
      glint.evaluate((node) => Number(node.getAnimations()[0]?.currentTime)),
    )
    .toBeGreaterThan(150);

  await logo.hover();
  await expect(glint).toHaveCSS("animation-name", "subject-mark-greeting");
  await expect
    .poll(async () => (await mark.boundingBox())!.width)
    .toBeGreaterThan(bounds!.width + 1.5);
  const greetingRest = await sampleAnimation(glint, "subject-mark-greeting", 0);
  const hoverRest = await mark.screenshot({
    path: info.outputPath("hover-rest.png"),
  });
  const greeting = await sampleAnimation(glint, "subject-mark-greeting", 350);
  const hoverLit = await mark.screenshot({
    path: info.outputPath("hover-glint.png"),
  });
  expect(greeting.opacity).toBeGreaterThan(0.75);
  expect(greeting.transform).not.toBe(greetingRest.transform);
  expect(greeting.duration).toBe(1400);
  expect(greeting.iterations).toBe(Infinity);
  expect(hoverLit.equals(hoverRest)).toBe(false);
  // Holding the pointer still must continue to respond on the next cycle.
  const secondCycle = await sampleAnimation(
    glint,
    "subject-mark-greeting",
    1750,
  );
  expect(secondCycle.opacity).toBeCloseTo(greeting.opacity, 3);
  expect(secondCycle.transform).toBe(greeting.transform);

  for (const preference of ["system", "app"] as const) {
    if (preference === "system")
      await page.emulateMedia({ reducedMotion: "reduce" });
    else {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => {
        document.documentElement.dataset.appMotion = "reduce";
      });
    }
    await expect(glint).toHaveCSS("animation-name", "none");
    await expect(mark).toHaveCSS("transform", "none");
    expect(
      await logo.evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((a) =>
              (a as CSSAnimation).animationName?.startsWith("subject-mark-"),
            ).length,
      ),
    ).toBe(0);
    const first = await mark.screenshot();
    const next = await mark.screenshot();
    expect(next.equals(first)).toBe(true);
  }
  runtime.connected = false;
  await fixture.refresh();
  await expect(logo).toHaveAttribute("data-state", "unknown");
  await expectBareLogo(logo);
  await expect(logo).toHaveAttribute("title", /暂无法读取工作状态/);
  await expect(mark.locator("path")).toHaveAttribute("d", silhouette);
  await logo.screenshot({ path: info.outputPath("disconnected-no-dash.png") });
  await page.evaluate(() => {
    delete document.documentElement.dataset.appMotion;
  });
  await handle.focus();
  await page.mouse.move(300, 300);
  // Brand presence survives a read error; it is distinct from work breathing.
  await expect(glint).toHaveCSS("animation-name", "subject-mark-glint");
  await expect(mark).toHaveCSS("animation-name", "none");
});

test("首个真实模型文字增量立刻点亮工作动效，结束恢复空闲不等快照轮询", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const sources = new Set<any>();
    (window as any).__logoStreams = sources;
    (window as any).EventSource = class {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        sources.add(this);
      }
      close() {
        sources.delete(this);
      }
    };
  });
  const runtime = runtimeSnapshot();
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime,
  }));
  inputs.push(
    fixture.input("logo-live-input", "TEST 短回复动效", "2026-10-01T12:00:00Z"),
  );
  let sequence = 0;
  const projection = new LiveConversationProjection(() => ({
    ...fixture.scope,
    inputId: "logo-live-input",
    rootId: "logo-live-root",
    artifactId: null,
  }));
  const emit = async (stream: StreamEvent["payload"]["stream"]) => {
    projection.consume({
      id: `logo-event-${++sequence}`,
      sequence,
      timestamp: "2026-10-01T12:00:01Z",
      topic: "runtime/model_stream",
      payload: {
        root_turn_id: "logo-live-root",
        activation_id: "logo-live-activation",
        attempt_id: "logo-live-attempt",
        stream,
      },
    });
    await page.evaluate(
      ({ messages, scope }) => {
        const path = `/api/platform/projects/${encodeURIComponent(scope.projectId)}/conversations/${encodeURIComponent(scope.conversationId)}/stream`;
        let delivered = 0;
        for (const source of (window as any).__logoStreams) {
          if (new URL(source.url, location.origin).pathname !== path) continue;
          source.onmessage?.({
            data: JSON.stringify({
              connected: true,
              reset: true,
              removed: [],
              messages,
            }),
          });
          delivered++;
        }
        if (!delivered)
          throw new Error("Missing current conversation SSE subscription");
      },
      { messages: projection.snapshot(), scope: fixture.scope },
    );
  };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 动效期间保留草稿");
  await expect
    .poll(() => page.evaluate(() => (window as any).__logoStreams.size))
    .toBeGreaterThan(0);
  const logo = page.locator(".sidebar .wordmark.agent-presence");
  const mark = logo.locator(".brand-mark");
  const glint = mark.locator(".brand-mark-glint");
  await expect(logo).toHaveAttribute("data-state", "idle");
  await expectBareLogo(logo);
  await emit({ kind: "started" });
  // The existing projection deliberately omits empty reply prefixes. The first
  // actual text delta is public work evidence even if the scheduler is still idle.
  await emit({ kind: "text_delta", text: "TEST 正在回应" });
  await expect(logo).toHaveAttribute("data-state", "working");
  await expect(logo).toHaveAttribute("data-working", "true");
  await expectBareLogo(logo);
  await expect(logo).toHaveAttribute("title", /正在回应你/);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("TEST 动效期间保留草稿");
  expect(runtime.activity!.threads).toEqual([]);
  const still = await sampleAnimation(mark, "subject-mark-breathe", 0);
  await sampleAnimation(glint, "subject-mark-glint", 0);
  const original = (await mark.boundingBox())!;
  const workRest = await logo.screenshot({
    path: info.outputPath("working-rest.png"),
  });
  const breathe = await sampleAnimation(mark, "subject-mark-breathe", 1400);
  await sampleAnimation(glint, "subject-mark-glint", 1260);
  const expanded = (await mark.boundingBox())!;
  const workLit = await logo.screenshot({
    path: info.outputPath("working-breathe-glint.png"),
  });
  expect(breathe.duration).toBe(2800);
  expect(breathe.transform).not.toBe(still.transform);
  expect(expanded.width).toBeGreaterThan(original.width + 1);
  expect(expanded.height).toBeGreaterThan(original.height + 1);
  expect(workLit.equals(workRest)).toBe(false);
  await emit({ kind: "completed" });
  await expect(logo).toHaveAttribute("data-state", "idle");
  await expect(logo).toHaveAttribute("data-working", "false");
  await expectBareLogo(logo);
  await expect(mark).toHaveCSS("animation-name", "none");
  await expect(glint).toHaveCSS("animation-duration", "8s");
  await expect(mark.locator("path")).toHaveAttribute("d", silhouette);
  await expect(input).toHaveValue("TEST 动效期间保留草稿");
  expect(runtime.activity!.threads).toEqual([]);
});
