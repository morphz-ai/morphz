import type { Page } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { openInput, settleTransitions } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

// Isolated real HTTP Host and identity, controlled Runtime snapshots. No model
// calls, original business writes, or claim of native Electron acceptance.
async function prepare(page: Page, lifecycle = "completed") {
  const inputs: PlatformHistory["inputs"] = [];
  const threads: ExecutionActivity["threads"] = [];
  let connected = true;
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        current: "isolated-project-conversation-model",
        options: [
          { id: "isolated-project-conversation-model", label: "隔离测试模型" },
        ],
        reasoning: { current: null, levels: [] },
      },
    }),
  );
  await page.goto("/");
  const client = await conversationClient(page);
  const fixture = await mockPlatformConversation(
    page,
    () => ({
      inputs,
      runtime: {
        ...disconnectedRuntime,
        configured: true,
        connected,
        deliveries: inputs.map((input) => ({
          inputId: input.id,
          state: "completed",
          error: null,
          retryable: false,
        })),
        activity: { available: connected, truncated: false, threads },
      },
    }),
    client,
  );
  inputs.push(
    fixture.input(
      "TEST-record-input",
      "TEST 核对文件，不修改原件。",
      "2026-10-09T00:00:00Z",
    ),
  );
  inputs.push(
    fixture.input(
      "TEST-dialogue-input",
      "TEST 普通对话",
      "2026-10-09T00:01:00Z",
    ),
  );
  threads.push({
    ...fixture.scope,
    id: "TEST-record-thread",
    kind: "execution",
    inputId: inputs[0]!.id,
    rootId: "TEST-record-root",
    sessionId: "TEST-session",
    contextId: "TEST-context",
    title: "TEST 原核对活动",
    lifecycle,
    phase: "running",
    revision: 1,
    updatedAt: inputs[0]!.createdAt,
  });
  threads.push({
    ...threads[0]!,
    id: "TEST-dialogue-thread",
    inputId: inputs[1]!.id,
    kind: "dialogue_turn",
  });
  const queries: URL[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.method() !== "HEAD")
      writes.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/executions?*", (route) => {
    queries.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        jobs: [],
        approvals: [],
        limit: 100,
        threads: [
          {
            id: threads[0]!.id,
            parentThreadId: null,
            rootId: threads[0]!.rootId,
            sessionId: threads[0]!.sessionId,
            contextId: threads[0]!.contextId,
            title: threads[0]!.title,
            lifecycle: threads[0]!.lifecycle,
            phase: threads[0]!.phase,
            revision: threads[0]!.revision,
            updatedAt: threads[0]!.updatedAt,
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  return {
    fixture,
    threads,
    queries,
    writes,
    setConnected(value: boolean) {
      connected = value;
    },
    card: page.locator('.human-message[data-input-id="TEST-record-input"]'),
    ordinary: page.locator(
      '.human-message[data-input-id="TEST-dialogue-input"]',
    ),
    input: page.getByRole("textbox", { name: "AI 输入内容", exact: true }),
    panel: page.getByRole("complementary", {
      name: "Morphz 信息",
      exact: true,
    }),
  };
}

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));

test("正常结束用正文尾部的向右箭头，悬停不变黑、不改变气泡或增加底面", async ({
  page,
}) => {
  const f = await prepare(page);
  const marker = f.card.getByRole("button", {
    name: "查看执行活动：已结束",
    exact: true,
  });
  await expect(marker.locator(".lucide-chevron-right")).toBeVisible();
  await expect(marker.locator(".lucide-arrow-up-right")).toHaveCount(0);
  await expect(marker.locator(".lucide-circle-check")).toHaveCount(0);
  const geometry = await marker.evaluate((button) => {
    const card = button.closest(".human-message")!;
    const glyph = button.querySelector("svg")!.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    return {
      right: box.right - glyph.right,
      textCenter: (() => {
        const body = card.querySelector("p")!;
        const rect = body.getBoundingClientRect();
        return rect.bottom - parseFloat(getComputedStyle(body).lineHeight) / 2;
      })(),
      center: (glyph.top + glyph.bottom) / 2,
      width: glyph.width,
      height: glyph.height,
      padding: parseFloat(getComputedStyle(card).paddingRight),
      background: getComputedStyle(button).backgroundColor,
    };
  });
  expect(geometry.right).toBeGreaterThanOrEqual(13);
  expect(geometry.right).toBeLessThanOrEqual(15);
  expect(Math.abs(geometry.center - geometry.textCenter)).toBeLessThanOrEqual(
    2,
  );
  expect([geometry.width, geometry.height]).toEqual([16, 16]);
  expect(geometry.padding).toBe(44);
  expect(geometry.background).toBe("rgba(0, 0, 0, 0)");
  const normal = await f.ordinary.evaluate(
    (card) => getComputedStyle(card).backgroundColor,
  );
  await expect(f.card).toHaveCSS("background-color", normal);
  await page.mouse.move(0, 0);
  const color = await marker.evaluate(
    (button) => getComputedStyle(button).color,
  );
  await f.card.locator("p").hover();
  await expect(marker).toHaveCSS("color", color);
  await marker.hover();
  await expect(marker).toHaveCSS("color", color);
  await expect(marker).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("运行状态不再重复按钮，正文与键盘查看仍打开确切活动且不选补充", async ({
  page,
}) => {
  const f = await prepare(page, "open");
  await expect(
    f.card.getByRole("button", { name: "后台执行中", exact: true }),
  ).toHaveCount(0);
  const entry = f.card.getByRole("button", {
    name: "查看执行活动：执行中",
    exact: true,
  });
  await expect(entry).toHaveClass("message-activity-access");
  await expect(entry).toHaveCSS("clip-path", "inset(50%)");
  await f.input.fill("TEST 查看不能覆盖这份草稿");
  const writes = f.writes.length;
  await f.card.locator("p[data-quotable]").click();
  await expect(f.panel.locator(".execution-origin")).toContainText(
    "TEST 核对文件",
  );
  await entry.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(entry).toBeFocused();
  await expect(f.card).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Space");
  await expect(f.panel.locator(".execution-origin")).toContainText(
    "TEST 核对文件",
  );
  await expect(f.input).toHaveValue("TEST 查看不能覆盖这份草稿");
  await expect(page.getByRole("group", { name: "补充目标" })).toHaveCount(0);
  expect(f.writes.length).toBe(writes);
});

test("执行结束后仍有可见状态和卡片关联，刷新、键盘及断线保留；查看不改草稿或执行", async ({
  page,
}, info) => {
  const f = await prepare(page, "open");
  await expect(f.card).toHaveAttribute("data-background-execution", "true");
  const runningHeight = (await f.card.boundingBox())!.height;
  await f.input.fill("TEST 未发送的新草稿");
  await expect(f.card.locator(".message-activity-record")).toHaveCount(0);
  f.threads[0]!.lifecycle = "completed";
  f.threads[0]!.revision++;
  await f.fixture.refresh();
  const badge = f.card.getByRole("button", {
    name: "查看执行活动：已结束",
    exact: true,
  });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("");
  expect((await f.card.boundingBox())!.height).toBeLessThanOrEqual(
    runningHeight + 1,
  );
  await expect(f.card).toHaveAttribute("data-execution-inspectable", "true");
  await expect(f.card).not.toHaveAttribute("data-background-execution");
  await expect(f.card).toHaveCSS("cursor", "pointer");
  await expect(f.ordinary).not.toHaveAttribute("data-execution-inspectable");
  await expect(f.ordinary.locator(".message-activity-record")).toHaveCount(0);
  const beforeWrites = f.writes.length;
  await f.card.locator("p[data-quotable]").click();
  await expect(f.panel.locator(".execution-origin")).toContainText(
    "TEST 核对文件",
  );
  await expect
    .poll(() =>
      f.queries.some(
        (q) => q.searchParams.get("inputId") === "TEST-record-input",
      ),
    )
    .toBe(true);
  await expect(f.input).toHaveValue("TEST 未发送的新草稿");
  await badge.focus();
  await page.keyboard.press("Enter");
  await expect(
    f.panel.locator('[data-thread-id="TEST-record-thread"]'),
  ).toContainText("TEST 原核对活动");
  await f.panel.locator('[data-thread-id="TEST-record-thread"]').click();
  await expect(f.panel.locator(".execution-origin")).toContainText(
    "TEST 原核对活动",
  );
  await expect
    .poll(() =>
      f.queries.some(
        (q) =>
          q.searchParams.get("inputId") === "TEST-record-input" &&
          q.searchParams.get("threadId") === "TEST-record-thread",
      ),
    )
    .toBe(true);
  await expect(
    f.panel.getByRole("region", { name: "工具执行与审批", exact: true }),
  ).toBeVisible();
  expect(f.writes.length).toBe(beforeWrites);
  await page.reload();
  await expect(badge).toBeVisible();
  await expect(f.input).toHaveValue("TEST 未发送的新草稿");
  f.setConnected(false);
  await f.fixture.refresh();
  await expect(badge).toBeVisible();
  await expect(f.card).not.toHaveAttribute("data-background-execution");
  await page.screenshot({
    path: info.outputPath("completed-record-offline.png"),
  });
});

for (const [lifecycle, label] of [
  ["completed", "已结束"],
  ["failed", "执行失败"],
  ["cancelled", "已取消"],
  ["new-terminal", "状态待核对"],
]) {
  test(`历史执行 ${lifecycle} 不冒充成功，亮暗窄窗与缩放下入口可达`, async ({
    page,
  }, info) => {
    const f = await prepare(page, lifecycle);
    const badge = f.card.getByRole("button", {
      name: "查看执行活动：" + label,
      exact: true,
    });
    await expect(badge).toBeVisible();
    await expect(f.card).not.toHaveAttribute("data-background-execution");
    for (const [mode, width, zoom] of [
      ["亮色", 1440, 1],
      ["暗色", 760, 1],
      ["亮色", 760, 2],
    ] as const) {
      await page.setViewportSize({ width, height: 960 });
      await openSettings(page, "外观");
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.keyboard.press("Escape");
      if (zoom > 1) {
        const collapse = page.getByRole("button", {
          name: "隐藏侧边栏",
          exact: true,
        });
        if (await collapse.count()) await collapse.click();
      }
      await page.evaluate((zoom) => {
        document.documentElement.style.zoom = String(zoom);
      }, zoom);
      // A deliberately open overlay inspector covers the right side of the
      // message canvas in narrow windows. Close it before testing the trigger.
      const hide = page.getByRole("button", {
        name: "隐藏右侧栏",
        exact: true,
      });
      if (await hide.count()) await hide.click();
      await badge.scrollIntoViewIfNeeded();
      await expect(badge).toBeVisible();
      const geometry = await badge.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const card = node.closest(".human-message")!;
        const cardBox = card.getBoundingClientRect();
        const textBox = card.querySelector("p")!.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          inside:
            box.left >= cardBox.left &&
            box.right <= cardBox.right &&
            box.top >= cardBox.top &&
            box.bottom <= cardBox.bottom,
          textClear: textBox.right <= box.left,
          hit: node.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          ),
        };
      });
      expect(geometry.width).toBeGreaterThanOrEqual(24);
      expect(geometry.height).toBeGreaterThanOrEqual(24);
      expect(geometry.hit).toBe(true);
      expect(geometry.inside).toBe(true);
      expect(geometry.textClear).toBe(true);
      await expect(badge).toHaveText("");
      await f.card.screenshot({
        path: info.outputPath(`card-${mode}-${width}-${zoom}.png`),
      });
      await badge.focus();
      await page.keyboard.press("Space");
      await expect(f.panel.locator(".execution-origin")).toContainText(
        "TEST 核对文件",
      );
      await page.screenshot({
        path: info.outputPath(`record-${mode}-${width}-${zoom}.png`),
      });
    }
  });
}

test("历史标记在四强调色亮暗下融入卡片，不增加状态行或终态动效", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const badge = f.card.getByRole("button", {
    name: "查看执行活动：已结束",
    exact: true,
  });
  for (const mode of ["亮色", "暗色"]) {
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      const settings = await openSettings(page, "外观");
      await settings.getByRole("button", { name: mode, exact: true }).click();
      await settings.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText("");
      const style = await f.card.evaluate((card) => ({
        height: card.getBoundingClientRect().height,
        bodyHeight: card.querySelector("p")!.getBoundingClientRect().height,
        padding:
          parseFloat(getComputedStyle(card).paddingTop) +
          parseFloat(getComputedStyle(card).paddingBottom),
        stroke: getComputedStyle(card).boxShadow,
        animation: getComputedStyle(card, "::before").animationName,
      }));
      expect(style.height).toBeCloseTo(style.bodyHeight + style.padding, 1);
      expect(style.stroke).toBe("none");
      expect(style.animation).toBe("none");
      await page.mouse.move(0, 0);
      await settleTransitions(page);
      const color = await badge.evaluate(
        (node) => getComputedStyle(node).color,
      );
      await f.card.screenshot({
        path: info.outputPath(`compact-${mode}-${accent}.png`),
      });
      await f.card.locator("p").hover();
      await expect(badge).toHaveCSS("color", color);
      await badge.hover();
      await expect(badge).toHaveCSS("color", color);
      await expect(badge).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await f.card.screenshot({
        path: info.outputPath(`hover-${mode}-${accent}.png`),
      });
      await badge.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(badge).toBeFocused();
      await expect(badge).toHaveCSS("outline-style", "solid");
    }
  }
});

test.describe("触控历史入口", () => {
  test.use({ hasTouch: true });
  test("44px 命中区留在卡片内，不遮正文或增加一行", async ({ page }) => {
    const f = await prepare(page);
    const badge = f.card.getByRole("button", {
      name: "查看执行活动：已结束",
      exact: true,
    });
    expect(
      await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches),
    ).toBe(true);
    const box = (await badge.boundingBox())!;
    const card = (await f.card.boundingBox())!;
    const body = (await f.card.locator("p").boundingBox())!;
    expect(box.width).toBe(44);
    expect(box.height).toBe(44);
    expect(box.y).toBeGreaterThanOrEqual(card.y);
    expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height);
    expect(body.x + body.width).toBeLessThanOrEqual(box.x);
    await badge.tap();
    await expect(f.panel.locator(".execution-origin")).toContainText(
      "TEST 核对文件",
    );
  });
});

test("运行态保留原光圈：终态及断线无边线，减少动态保留原状态", async ({
  page,
}, info) => {
  const f = await prepare(page, "open");
  await f.input.fill("TEST 保留的新草稿");
  const marker = f.card.locator(".message-activity-record");
  await expect(marker).toHaveCount(0);
  await expect(f.card).toHaveAttribute("data-background-execution", "true");
  const halo = await f.card.evaluate((card) => {
    const style = getComputedStyle(card, "::before");
    return {
      content: style.content,
      animation: style.animationName,
      duration: style.animationDuration,
      pointerEvents: style.pointerEvents,
      angle: style.getPropertyValue("--execution-glow-angle"),
    };
  });
  expect(halo.content).toBe('\"\"');
  expect(halo.animation).toBe("execution-halo-orbit");
  expect(halo.duration).toBe("3.6s");
  expect(halo.pointerEvents).toBe("none");
  await expect
    .poll(() =>
      f.card.evaluate((card) =>
        getComputedStyle(card, "::before").getPropertyValue(
          "--execution-glow-angle",
        ),
      ),
    )
    .not.toBe(halo.angle);
  await page.screenshot({ path: info.outputPath("running-restored.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animation = () =>
    f.card.evaluate((card) => getComputedStyle(card, "::before").animationName);
  await expect.poll(animation).toBe("none");
  expect(
    await f.card.evaluate((card) => getComputedStyle(card, "::before").content),
  ).toBe('\"\"');
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(
    () => (document.documentElement.dataset.appMotion = "reduce"),
  );
  await expect.poll(animation).toBe("none");
  await page.evaluate(() => delete document.documentElement.dataset.appMotion);
  await expect.poll(animation).toBe("execution-halo-orbit");
  f.setConnected(false);
  await f.fixture.refresh();
  await expect(marker).toHaveAttribute("data-status", "unknown");
  await expect(f.card).toHaveCSS("box-shadow", "none");
  expect(
    await f.card.evaluate((card) => getComputedStyle(card, "::before").content),
  ).toBe("none");
  f.setConnected(true);
  f.threads[0]!.lifecycle = "completed";
  f.threads[0]!.revision++;
  await f.fixture.refresh();
  await expect(marker).toHaveAttribute("data-status", "ended");
  await expect(marker).toHaveText("");
  await expect(f.card).toHaveCSS("box-shadow", "none");
  await expect(f.card).toHaveCSS("border-top-width", "0px");
  expect(
    await f.card.evaluate((card) => getComputedStyle(card, "::before").content),
  ).toBe("none");
  await expect(marker.locator(".execution-signal-flow")).toHaveCount(0);
  await expect(f.input).toHaveValue("TEST 保留的新草稿");
  await f.card.screenshot({ path: info.outputPath("ended-clean.png") });
});
