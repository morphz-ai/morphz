import { expect, type Locator, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

async function prepare(page: Page, { withQuote = false } = {}) {
  const inputs: PlatformHistory["inputs"] = [];
  let phase = "running",
    connected = true,
    available = true,
    branches = 1;
  let lifecycle = "open",
    kind: string | undefined = "execution",
    controlState = "active",
    continuation = true;
  const sent: Record<string, any>[] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      model: "footer-fixture",
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "running" as const,
        error: null,
        retryable: false,
        cancellable: true,
      })),
      activity: {
        available,
        truncated: false,
        threads: inputs.flatMap((input) =>
          Array.from(
            { length: input.id === "footer-a" ? branches : 1 },
            (_, index) => ({
              id: `${input.id}-thread-${index}`,
              ...fixture.scope,
              kind,
              inputId: input.id,
              rootId: `${input.id}-root`,
              sessionId: "footer-session",
              title: `${input.id === "footer-a" ? "报告 A" : "资料 B"}${index ? "复核分支" : ""}`,
              phase,
              lifecycle,
              controlState,
              revision: 3,
              updatedAt: input.createdAt,
              continuation: continuation
                ? {
                    mode: "supplement" as const,
                    inputId: input.id,
                    threadId: `${input.id}-thread-${index}`,
                    generation: 2,
                  }
                : undefined,
            }),
          ),
        ),
      },
      attention: { available: true, approvals: [] },
    },
  }));
  inputs.push(
    fixture.input("footer-a", "核对报告 A。", "2026-10-02T09:30:00.000Z"),
    fixture.input(
      "footer-b",
      "整理资料 B，保留与报告 A 独立的执行。",
      "2026-10-02T09:31:00.000Z",
    ),
  );
  if (withQuote)
    inputs[0]!.textQuotes = [
      {
        id: "2157ef78-060e-4b91-9a3f-6ca9a924b447",
        source: {
          kind: "message",
          ...fixture.scope,
          messageId: "footer-b",
          inputId: "footer-b",
          title: "资料 B 原文",
          createdAt: "2026-10-02T09:31:00.000Z",
        },
        text: "整理资料 B，保留与报告 A 独立的执行。",
        comment: "这段引用只作为阅读依据，不选择报告 A 的工作。",
      },
    ];
  await page.route("**/api/platform/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.capabilities.directedInput = true;
    await route.fulfill({ response, json: body });
  });
  // Exercise the real Conversation -> composer -> typed Platform command path.
  // Only its HTTP transport is synthetic; no model request or original App.
  await page.route("**/api/platform/messages", async (route) => {
    const command = route.request().postDataJSON();
    sent.push(command);
    await route.fulfill({
      json: {
        commandId: command.commandId,
        entityId: "footer-sent",
        workspaceRevision: 1,
      },
    });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const composer = await openInput(page);
  const message = page.locator('.human-message[data-input-id="footer-a"]');
  const supplement = message.getByRole("button", {
    name: "补充要求",
    exact: true,
  });
  const status = message.locator(".message-work-status");
  await expect(supplement).toBeVisible();
  return {
    fixture,
    message,
    supplement,
    status,
    composer,
    sent,
    async update(update: {
      phase?: string;
      connected?: boolean;
      available?: boolean;
      branches?: number;
      lifecycle?: string;
      kind?: string | null;
      controlState?: string;
      continuation?: boolean;
    }) {
      if (update.phase !== undefined) phase = update.phase;
      if (update.connected !== undefined) connected = update.connected;
      if (update.available !== undefined) available = update.available;
      if (update.branches !== undefined) branches = update.branches;
      if (update.lifecycle !== undefined) lifecycle = update.lifecycle;
      if (update.kind !== undefined) kind = update.kind ?? undefined;
      if (update.controlState !== undefined) controlState = update.controlState;
      if (update.continuation !== undefined) continuation = update.continuation;
      await fixture.refresh();
    },
  };
}

async function appearance(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element),
      rect = element.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const ancestors: Element[] = [];
    for (
      let parent: Element | null = element;
      parent;
      parent = parent.parentElement
    )
      ancestors.push(parent);
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    for (const parent of ancestors.reverse()) {
      context.fillStyle = getComputedStyle(parent).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const surface = [...context.getImageData(0, 0, 1, 1).data];
    const luminance = (rgb: number[]) => {
      const channels = rgb.slice(0, 3).map((value) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return (
        channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
      );
    };
    const ink = luminance(rgba(style.color)),
      background = luminance(surface);
    return {
      contrast:
        (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05),
      color: style.backgroundColor,
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      width: rect.width,
      height: rect.height,
      borderWidth: style.borderWidth,
    };
  });
}

async function settleTransitions(page: Page) {
  // Appearance controls may start a short material transition. Measure the
  // requested palette after that real transition, not a white/black midpoint.
  // Do not wait on persistent execution/progress animations.
  await page.evaluate(async () => {
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

function information(page: Page) {
  return page.getByRole("complementary", { name: "Morphz 信息", exact: true });
}

async function cardGeometry(message: Locator) {
  return message.evaluate((element) => {
    const rect = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      card: rect(element),
      text: rect(element.querySelector(":scope > p")!),
      footer: rect(element.querySelector(".message-meta")!),
    };
  });
}

async function expectNoWorkSelection(
  page: Page,
  f: Awaited<ReturnType<typeof prepare>>,
  draft: string,
) {
  await expect(page.getByRole("group", { name: "补充目标" })).toHaveCount(0);
  await expect(f.composer).toHaveValue(draft);
  expect(f.sent).toHaveLength(0);
}

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));

test("仅可查看、没有补充目标的运行线程仍使用气泡外 footer", async ({
  page,
}) => {
  const f = await prepare(page);
  await f.update({ continuation: false });
  await expect(f.supplement).toHaveCount(0);
  await expect(f.status).toBeVisible();
  await expect(f.message.locator(".message-meta")).toHaveAttribute(
    "data-work-actions",
    "true",
  );
  const bubble = (await f.message.boundingBox())!;
  const footer = (await f.message.locator(".message-meta").boundingBox())!;
  expect(footer.y).toBeGreaterThanOrEqual(bubble.y + bubble.height);
  await f.message.hover();
  await f.status.click();
  await expect(
    page.getByRole("complementary", { name: "Morphz 信息", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "补充目标" })).toHaveCount(0);
});

test("工作动作在气泡外同一 footer：简短图标、真实状态、保留执行光效、窄窗与 200% 不遮正文", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await expect(f.supplement).toHaveText("补充");
  await expect(f.status).toHaveText("执行中");
  await expect(f.status.locator("svg")).toHaveCount(1);
  await expect(f.message).toHaveAttribute("data-background-execution", "true");
  expect(
    await f.message.evaluate((el) => getComputedStyle(el, "::before").content),
  ).toBe('""');
  expect(
    await f.message.evaluate(
      (el) => getComputedStyle(el, "::before").animationName,
    ),
  ).toBe("execution-halo-orbit");
  expect(
    await f.message.evaluate((el) => getComputedStyle(el).boxShadow),
  ).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await f.message.evaluate(
      (el) => getComputedStyle(el, "::before").animationName,
    ),
  ).toBe("none");
  for (const [width, height, zoom] of [
    [1440, 960, 1],
    [1024, 768, 1],
    [760, 540, 1],
    [390, 800, 1],
    [320, 800, 1],
    [1440, 960, 2],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, zoom);
    await f.message.hover();
    const bubble = (await f.message.boundingBox())!,
      text = (await f.message.locator(":scope > p").boundingBox())!;
    const footer = (await f.message.locator(".message-meta").boundingBox())!;
    const column = (await page
      .getByRole("log", { name: "对话消息" })
      .boundingBox())!;
    expect(bubble.height - text.height).toBeLessThanOrEqual(21 * zoom);
    expect(footer.y).toBeGreaterThanOrEqual(bubble.y + bubble.height);
    expect(footer.x).toBeGreaterThanOrEqual(column.x - 1);
    expect(footer.x + footer.width).toBeLessThanOrEqual(
      column.x + column.width + 1,
    );
    const work = (await f.message
      .locator(".message-work-actions")
      .boundingBox())!;
    expect(work.y - bubble.y - bubble.height).toBeLessThanOrEqual(6 * zoom);
    for (const button of [
      f.supplement,
      f.status,
      f.message.locator(".message-copy"),
      f.message.locator(".stop-response"),
    ]) {
      await expect(button).toBeInViewport();
      const target = (await button.boundingBox())!;
      expect(target.width).toBeGreaterThanOrEqual(24 * zoom);
      expect(target.height).toBeGreaterThanOrEqual(24 * zoom);
      expect(target.y).toBeGreaterThanOrEqual(bubble.y + bubble.height);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`footer-${width}-${height}-${zoom}.png`),
    });
  }
});

test("四主题亮暗 hover、按下与键盘保持可读，不再强外框；触控直接可发现", async ({
  page,
}, info) => {
  const f = await prepare(page),
    observations = [];
  for (const mode of ["亮色", "暗色"])
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      const settings = await openSettings(page, "外观");
      await settings.getByRole("button", { name: mode, exact: true }).click();
      await settings.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      for (const button of [f.supplement, f.status]) {
        await f.composer.focus();
        await page.mouse.move(0, 0);
        await settleTransitions(page);
        const normal = await appearance(button);
        expect(normal.contrast).toBeGreaterThanOrEqual(4.5);
        expect(normal.borderWidth).toBe("0px");
        await f.message.hover();
        await button.hover();
        await settleTransitions(page);
        const hover = await appearance(button);
        expect(hover.contrast).toBeGreaterThanOrEqual(4.5);
        expect([hover.width, hover.height]).toEqual([
          normal.width,
          normal.height,
        ]);
        await button.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(button).toBeFocused();
        await page.mouse.move(0, 0);
        await settleTransitions(page);
        const focus = await appearance(button);
        expect(focus.contrast).toBeGreaterThanOrEqual(4.5);
        expect(focus.outline).toBe("solid");
        expect(focus.outlineWidth).toBe("1px");
        await button.hover();
        await page.mouse.down();
        await settleTransitions(page);
        const pressed = await appearance(button);
        expect(pressed.contrast).toBeGreaterThanOrEqual(4.5);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        observations.push({ mode, accent, normal, hover, focus, pressed });
      }
      await page.screenshot({
        path: info.outputPath(`footer-${mode}-${accent}.png`),
      });
    }
  await info.attach("footer-appearance", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
  expect(f.sent).toHaveLength(0);
  const touch = await page
    .context()
    .browser()!
    .newContext({
      baseURL: "http://127.0.0.1:65421",
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
  try {
    const touchPage = await touch.newPage(),
      t = await prepare(touchPage);
    await expect(t.supplement).toBeVisible();
    await expect(t.message.locator(".message-peek")).toHaveCSS("opacity", "1");
    await expect(t.message.locator(".message-work-actions")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(t.message.locator(".message-work-actions")).toHaveCSS(
      "pointer-events",
      "auto",
    );
    const touchGeometry = await cardGeometry(t.message);
    await t.status.tap();
    await expect(
      information(touchPage).locator(".execution-origin"),
    ).toHaveText(/核对报告 A。/);
    expect(await cardGeometry(t.message)).toEqual(touchGeometry);
    await expectNoWorkSelection(touchPage, t, "");
    await touchPage.keyboard.press("Escape");
    await expect(information(touchPage)).toHaveCount(0);
    expect((await t.supplement.boundingBox())!.height).toBeGreaterThanOrEqual(
      44,
    );
    await t.supplement.tap();
    await expect(
      touchPage.getByRole("group", { name: "补充目标" }),
    ).toContainText("报告 A");
    expect(t.sent).toHaveLength(0);
    await touchPage.unrouteAll({ behavior: "wait" });
  } finally {
    await touch.close();
  }
});

test("等待/暂停/未知不冒称运行，断线、结束、旧类型撤下入口", async ({
  page,
}) => {
  const f = await prepare(page);
  const draft = "断线和已结束消息仍不能改变这份草稿";
  await f.composer.fill(draft);
  for (const [phase, text] of [
    ["waiting", "等待中"],
    ["runnable", "待执行"],
    ["idle", "等待唤醒"],
    ["future_phase", "状态待核对"],
  ]) {
    await f.update({ phase });
    await expect(f.status).toHaveText(text!);
    await expect(f.status).not.toHaveText("执行中");
  }
  await f.update({ phase: "running", controlState: "paused" });
  await expect(f.status).toHaveText("已暂停");
  await expect(f.status).toHaveAttribute("data-status", "paused");
  await f.update({ connected: false });
  await expect(f.message.locator(".message-work-actions")).toHaveCount(0);
  await expect(f.message).not.toHaveAttribute(
    "data-execution-inspectable",
    "true",
  );
  await f.message.locator(":scope > p").click();
  await expect(information(page)).toHaveCount(0);
  await expectNoWorkSelection(page, f, draft);
  await f.update({ connected: true, available: false });
  await expect(f.message.locator(".message-work-actions")).toHaveCount(0);
  await f.update({ available: true, lifecycle: "completed" });
  await expect(f.message.locator(".message-work-actions")).toHaveCount(0);
  await expect(f.message).not.toHaveAttribute(
    "data-execution-inspectable",
    "true",
  );
  await f.message.locator(":scope > p").click();
  await expect(information(page)).toHaveCount(0);
  await expectNoWorkSelection(page, f, draft);
  await f.update({ lifecycle: "open", kind: null });
  await expect(f.message.locator(".message-work-actions")).toHaveCount(0);
  expect(f.sent).toHaveLength(0);
});

test("查看不选补充，多分支须选择，补充发送精确原线程且不改另项工作", async ({
  page,
}) => {
  const f = await prepare(page);
  const draft = "补充 A 的核对要求，B 保持不变";
  await f.composer.fill(draft);
  await f.message.hover();
  await f.status.press("Enter");
  await expect(page.getByRole("group", { name: "补充目标" })).toHaveCount(0);
  await expect(f.composer).toHaveValue(draft);
  expect(f.sent).toHaveLength(0);
  await f.update({ branches: 2 });
  const choice = f.message.getByRole("button", {
    name: "选择补充分支",
    exact: true,
  });
  await expect(choice).toHaveText("补充");
  await choice.press("Space");
  await expect(page.getByRole("group", { name: "补充目标" })).toHaveCount(0);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  const branches = panel.getByRole("region", { name: "执行分支" });
  await branches.getByRole("button", { name: /报告 A复核分支/ }).click();
  await panel.getByRole("button", { name: "补充要求", exact: true }).click();
  await expect(page.getByRole("group", { name: "补充目标" })).toContainText(
    "报告 A复核分支",
  );
  await expect(f.composer).toHaveValue(draft);
  await page.getByRole("button", { name: "发送补充", exact: true }).click();
  await expect.poll(() => f.sent.length).toBe(1);
  expect(f.sent[0]!.operation.continuation).toEqual({
    mode: "supplement",
    inputId: "footer-a",
    threadId: "footer-a-thread-1",
    generation: 2,
  });
  for (const key of ["model", "directories", "applicationInstanceId"])
    expect(f.sent[0]!.operation).not.toHaveProperty(key);
  await expect(
    page.locator('[data-input-id="footer-b"] .message-work-status'),
  ).toHaveText("执行中");
});

test("默认收起操作但执行光效持续，悬停与键盘焦点只显露而不跳布局", async ({
  page,
}) => {
  const f = await prepare(page);
  await f.composer.focus();
  await page.mouse.move(0, 0);
  const work = f.message.locator(".message-work-actions");
  await expect(work).toHaveCSS("opacity", "0");
  await expect(work).toHaveCSS("pointer-events", "none");
  const geometry = await cardGeometry(f.message);
  const halo = await f.message.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    const animation = element
      .getAnimations({ subtree: true })
      .find(
        (candidate) =>
          candidate instanceof CSSAnimation &&
          candidate.animationName === "execution-halo-orbit",
      );
    return {
      content: style.content,
      name: style.animationName,
      state: animation?.playState,
      time: Number(animation?.currentTime),
    };
  });
  expect(halo).toMatchObject({
    content: '""',
    name: "execution-halo-orbit",
    state: "running",
  });
  await expect
    .poll(() =>
      f.message.evaluate((element) =>
        Number(
          element
            .getAnimations({ subtree: true })
            .find(
              (candidate) =>
                candidate instanceof CSSAnimation &&
                candidate.animationName === "execution-halo-orbit",
            )?.currentTime,
        ),
      ),
    )
    .toBeGreaterThan(halo.time);
  await f.message.hover();
  await expect(work).toHaveCSS("opacity", "1");
  await expect(work).toHaveCSS("pointer-events", "auto");
  expect(await cardGeometry(f.message)).toEqual(geometry);
  await f.supplement.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(f.supplement).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(work).toHaveCSS("opacity", "1");
  expect(await cardGeometry(f.message)).toEqual(geometry);
  await f.composer.focus();
  await expect(work).toHaveCSS("opacity", "0");
  expect(await cardGeometry(f.message)).toEqual(geometry);
  expect(f.sent).toHaveLength(0);
});

test("从正文跨过两像素间隙到 footer 操作始终可点", async ({ page }) => {
  const f = await prepare(page);
  const bubble = (await f.message.boundingBox())!,
    footer = (await f.message.locator(".message-meta").boundingBox())!,
    target = (await f.status.boundingBox())!;
  const x = Math.min(bubble.x + bubble.width - 4, footer.x + footer.width - 4);
  await page.mouse.move(x, bubble.y + bubble.height - 4);
  await expect(f.message.locator(".message-work-actions")).toHaveCSS(
    "opacity",
    "1",
  );
  for (const y of [
    bubble.y + bubble.height,
    bubble.y + bubble.height + 1,
    footer.y + 1,
  ]) {
    await page.mouse.move(x, y);
    await expect(f.message.locator(".message-work-actions")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(f.message.locator(".message-work-actions")).toHaveCSS(
      "pointer-events",
      "auto",
    );
  }
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 8 },
  );
  await expect(f.message.locator(".message-work-actions")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.mouse.click(
    target.x + target.width / 2,
    target.y + target.height / 2,
  );
  await expect(information(page).locator(".execution-origin")).toHaveText(
    /核对报告 A。/,
  );
  expect(f.sent).toHaveLength(0);
});

test("点击活跃正文只打开该 input 的活动，不选补充、不发送、不改草稿", async ({
  page,
}) => {
  const f = await prepare(page);
  const draft = "保留原草稿，查看不会把它送到任何工作";
  await f.composer.fill(draft);
  const second = page.locator('.human-message[data-input-id="footer-b"]');
  await second.locator(":scope > p").click();
  const panel = information(page);
  await expect(panel.locator(".execution-origin")).toHaveText(
    /整理资料 B，保留与报告 A 独立的执行。/,
  );
  await expect(panel.getByRole("region", { name: "执行分支" })).toContainText(
    "资料 B",
  );
  await expect(
    panel.getByRole("region", { name: "执行分支" }),
  ).not.toContainText("报告 A");
  await expectNoWorkSelection(page, f, draft);
  await f.message.locator(":scope > p").click();
  await expect(panel.locator(".execution-origin")).toHaveText(/核对报告 A。/);
  await expect(panel.getByRole("region", { name: "执行分支" })).toContainText(
    "报告 A",
  );
  await expect(
    panel.getByRole("region", { name: "执行分支" }),
  ).not.toContainText("资料 B");
  await expectNoWorkSelection(page, f, draft);
});

test("嵌套引用原文、全文和评论、复制与选中文字不触发卡片活动", async ({
  page,
}) => {
  const f = await prepare(page, { withQuote: true });
  const draft = "阅读与复制都保留原草稿";
  await f.composer.fill(draft);
  const quote = f.message.getByRole("button", {
    name: "查看引用 1 的原文",
    exact: true,
  });
  await quote.click();
  await expect(information(page)).toHaveCount(0);
  await expectNoWorkSelection(page, f, draft);
  // Desktop previews use hover/focus; the explicit 全文 button is touch-only.
  await page.mouse.move(0, 0);
  await quote.hover();
  const preview = f.message.getByRole("region", {
    name: "引用 1 全文",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await preview.locator(".sent-text-quote-preview-text").click();
  await expect(information(page)).toHaveCount(0);
  await expectNoWorkSelection(page, f, draft);
  await preview
    .getByRole("button", { name: "关闭引用全文", exact: true })
    .click();
  await f.message.locator(".text-quote-comment").click();
  await expect(information(page)).toHaveCount(0);
  await f.message.hover();
  await f.message
    .getByRole("button", { name: "复制消息", exact: true })
    .click();
  await expect(
    f.message.getByRole("button", { name: "已复制消息", exact: true }),
  ).toBeVisible();
  await expect(information(page)).toHaveCount(0);
  await expectNoWorkSelection(page, f, draft);
  const text = f.message.locator(":scope > p"),
    rect = (await text.boundingBox())!;
  await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString() ?? ""))
    .not.toBe("");
  await expect(information(page)).toHaveCount(0);
  await expectNoWorkSelection(page, f, draft);
});
