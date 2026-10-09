import { expect, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import {
  openInput,
  openExecutionPanel,
  settleTransitions,
} from "./interaction-helpers.js";

// Real isolated Host/identity and mounted renderer; Runtime status/receipts are
// controlled. No provider, original business input, or cancellation is run.
async function prepare(page: Page) {
  const inputs: PlatformHistory["inputs"] = [];
  const activity = {
    connected: true,
    available: true,
    phase: "running",
    lifecycle: "open" as "open" | "completed" | "failed" | "cancelled",
  };
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: activity.connected,
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "running" as const,
        error: null,
        retryable: false,
        cancellable: true,
      })),
      activity: {
        available: activity.available,
        truncated: false,
        threads: inputs.map((input) => ({
          ...fixture.scope,
          id: "TEST-ui-thread",
          inputId: input.id,
          rootId: "TEST-ui-root",
          sessionId: "TEST-ui-session",
          kind: "execution" as const,
          title: "TEST 交付人物设定与五场戏大纲",
          phase: activity.phase,
          lifecycle: activity.lifecycle,
          revision: 1,
          updatedAt: input.createdAt,
          continuation: {
            mode: "supplement" as const,
            inputId: input.id,
            threadId: "TEST-ui-thread",
            generation: 1,
          },
        })),
      },
      attention: { available: true, approvals: [] },
    },
  }));
  inputs.push(
    fixture.input(
      "TEST-ui-input",
      "TEST 核对工作界面，不修改原件。",
      "2026-10-09T12:00:00Z",
    ),
  );
  await page.route("**/api/platform/bootstrap", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.capabilities.directedInput = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({
      json: {
        jobs: [0, 1].map((index) => ({
          id: `TEST-ui-job-${index}`,
          revision: 1,
          session_id: "TEST-ui-session",
          context_id: "TEST-ui-context",
          thread_id: "TEST-ui-thread",
          tool_name: "host_morphz",
          target_id: "local",
          status: "succeeded",
          request: { action: "script", script: { action: "read-workflow" } },
          result_event_id: `TEST-ui-result-${index}`,
          created_at: `2026-10-09T12:00:0${index}Z`,
          updated_at: `2026-10-09T12:00:0${index}Z`,
        })),
        approvals: [],
        limit: 100,
      },
    }),
  );
  await page.route("**/api/executions/result?*", (route) =>
    route.fulfill({
      json: {
        available: true,
        truncated: false,
        text: '{"ok":true,"fixture":"TEST receipt"}',
      },
    }),
  );
  const writes: string[] = [];
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const input = page.getByRole("textbox", { name: "AI 输入内容", exact: true });
  await input.fill("TEST 未发送的原草稿");
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method()))
      writes.push(new URL(request.url()).pathname);
  });
  const card = page.locator('.human-message[data-input-id="TEST-ui-input"]');
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  return { card, input, panel, writes, fixture, activity };
}

test("纯图标按钮悬停与键盘显示简短名称，Escape只关闭提示、没有写入", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await f.card.hover();
  const copy = f.card.getByRole("button", { name: "复制消息", exact: true });
  const stop = f.card.getByRole("button", {
    name: "停止这次处理",
    exact: true,
  });
  const supplement = f.card.getByRole("button", {
    name: "补充要求",
    exact: true,
  });
  for (const [button, name] of [
    [copy, "复制消息"],
    [stop, "停止"],
    [supplement, "补充要求"],
  ] as const) {
    // The footer is intentionally hover-only. Enter from outside and await
    // its existing finite fade before targeting a different action.
    await page.mouse.move(20, 200);
    await f.card.hover();
    await settleTransitions(page);
    await button.hover();
    const hint = page.getByRole("tooltip");
    await expect(hint).toHaveText(name);
    await expect(hint).toBeVisible();
    await expect(button).toHaveAttribute(
      "aria-describedby",
      (await hint.getAttribute("id")) as string,
    );
    await page.screenshot({
      path: info.outputPath(`message-hint-${name}.png`),
    });
    await hint.hover();
    await expect(hint).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  await copy.focus();
  await page.keyboard.press("Tab");
  await expect(stop).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("停止");
  await page.screenshot({ path: info.outputPath("message-stop-tooltip.png") });
  await page.keyboard.press("Escape");
  await expect(stop).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(supplement).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("补充要求");
  await expect(f.input).toHaveValue("TEST 未发送的原草稿");
  expect(f.writes).toEqual([]);
});

test("活动详情运行标识会动，已完成为图标，时间与工具按钮同一行，真实结果仍可展开", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const status = f.panel.locator(
    ".execution-origin-status[data-status=running]",
  );
  await expect(status).toHaveText("执行中");
  const flow = status.locator(".execution-signal-flow");
  await expect(flow).toBeVisible();
  const offset = await flow.evaluate(
    (el) => getComputedStyle(el).strokeDashoffset,
  );
  await expect
    .poll(() => flow.evaluate((el) => getComputedStyle(el).strokeDashoffset))
    .not.toBe(offset);
  const jobs = f.panel.locator(".execution-job");
  await expect(jobs).toHaveCount(2);
  for (const job of await jobs.all()) {
    await expect(job.locator(".job-status")).toHaveText("");
    await expect(
      job.getByRole("img", { name: "已完成", exact: true }),
    ).toBeVisible();
    const technical = job.getByRole("button", {
        name: "技术详情",
        exact: true,
      }),
      result = job.getByRole("button", { name: "查看结果", exact: true });
    await expect(technical).toHaveText("");
    await expect(result).toHaveText("");
    const time = await job.locator("time").boundingBox(),
      a = await technical.boundingBox(),
      b = await result.boundingBox();
    expect(
      Math.abs(a!.y + a!.height / 2 - (b!.y + b!.height / 2)),
    ).toBeLessThan(2);
    expect(
      Math.abs(time!.y + time!.height / 2 - (a!.y + a!.height / 2)),
    ).toBeLessThan(2);
    expect((await job.boundingBox())!.height).toBeLessThan(100);
  }
  const first = jobs.first(),
    technical = first.getByRole("button", { name: "技术详情", exact: true });
  await technical.click();
  await expect(technical).toHaveAttribute("aria-expanded", "true");
  await expect(first.locator(".execution-technical pre")).toContainText(
    '"read-workflow"',
  );
  await technical.click();
  await expect(first.locator(".execution-technical")).toHaveCount(0);
  await first.getByRole("button", { name: "查看结果", exact: true }).click();
  await first.getByText("完整返回内容", { exact: true }).click();
  await expect(first.locator(".execution-result pre")).toContainText(
    "TEST receipt",
  );
  for (const appearance of ["dark", "light"]) {
    await page.evaluate((appearance) => {
      document
        .querySelector(".app")!
        .setAttribute("data-appearance", appearance);
      document.documentElement.setAttribute("data-appearance", appearance);
    }, appearance);
    await settleTransitions(page);
    await f.panel.screenshot({
      path: info.outputPath(`execution-details-${appearance}.png`),
    });
  }
  await expect(f.input).toHaveValue("TEST 未发送的原草稿");
  expect(f.writes).toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(flow).toHaveCSS("animation-name", "none");
});

test("窄窗与200%缩放提示不被裁切，移开或滚动撤下提示、按钮位置不变", async ({
  page,
}) => {
  const f = await prepare(page);
  await page.setViewportSize({ width: 760, height: 540 });
  await page.evaluate(() => {
    (document.querySelector(".app") as HTMLElement).style.zoom = "2";
  });
  await f.card.scrollIntoViewIfNeeded();
  await f.card.hover();
  const button = f.card.getByRole("button", { name: "补充要求", exact: true });
  await button.hover();
  // Hover first performs the actual target's scroll-into-view. Measure before
  // the delayed hint opens, not before Playwright's automatic scrolling.
  const before = await button.boundingBox();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText("补充要求");
  const box = (await tip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(760);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(540);
  expect(await button.boundingBox()).toEqual(before);
  await page.mouse.move(20, 200);
  await expect(tip).toHaveCount(0);
  await f.card.hover();
  await button.hover();
  await expect(tip).toBeVisible();
  await page.mouse.wheel(0, -120);
  await expect(tip).toHaveCount(0);
});

test("根活动仅实际运行时有动效，等待、失败、结束及断线都按真实状态呈现", async ({
  page,
}) => {
  const f = await prepare(page);
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const status = f.panel.locator(".execution-origin-status");
  for (const [phase, lifecycle, kind, label] of [
    ["waiting", "open", "waiting", "等待中"],
    ["idle", "completed", "ended", "已结束"],
    ["idle", "failed", "failed", "执行失败"],
    ["idle", "cancelled", "cancelled", "已取消"],
  ] as const) {
    Object.assign(f.activity, { phase, lifecycle });
    await f.fixture.refresh();
    await expect(status).toHaveAttribute("data-status", kind);
    await expect(status).toHaveText(label);
    await expect(status.locator(".execution-signal-flow")).toHaveCount(0);
  }
  Object.assign(f.activity, {
    phase: "running",
    lifecycle: "open",
    connected: false,
    available: false,
  });
  await f.fixture.refresh();
  await expect(status).toHaveAttribute("data-status", "unknown");
  await expect(status).toHaveText("状态待核对");
  await expect(status.locator(".execution-signal-flow")).toHaveCount(0);
  await expect(
    f.panel.getByRole("button", { name: "停止此分支", exact: true }),
  ).toBeDisabled();
  await expect(
    f.panel.getByRole("img", { name: "已完成", exact: true }),
  ).toHaveCount(2);
  await expect(f.input).toHaveValue("TEST 未发送的原草稿");
  expect(f.writes).toEqual([]);
});

test("技术和结果提示是按钮名称，Escape不退出活动，点击提示不触发操作", async ({
  page,
}) => {
  const f = await prepare(page);
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const first = f.panel.locator(".execution-job").first();
  for (const name of ["技术详情", "查看结果"] as const) {
    const button = first.getByRole("button", { name, exact: true });
    await button.hover();
    const hint = page.getByRole("tooltip");
    await expect(hint).toHaveText(name);
    await hint.click();
    await expect(
      first.locator(".execution-technical,.execution-result"),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(hint).toHaveCount(0);
    await expect(first).toBeVisible();
  }
  await expect(f.input).toHaveValue("TEST 未发送的原草稿");
  expect(f.writes).toEqual([]);
});
