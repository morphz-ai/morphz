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
  const resultReply = {
    available: true,
    truncated: false,
    text: '{"ok":true,"fixture":"TEST receipt"}',
  };
  const resultReads: string[] = [];
  const resultHttp = { status: 200 };
  const jobs = { secondStatus: "succeeded" };
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
          status: index === 0 ? "succeeded" : jobs.secondStatus,
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
  await page.route("**/api/executions/result?*", (route) => {
    resultReads.push(new URL(route.request().url()).searchParams.get("jobId")!);
    return route.fulfill({
      status: resultHttp.status,
      json:
        resultHttp.status === 200
          ? resultReply
          : { message: "TEST 无法读取结果" },
    });
  });
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
  return {
    card,
    input,
    panel,
    writes,
    fixture,
    activity,
    resultReply,
    resultReads,
    resultHttp,
    jobs,
  };
}

test("步骤两排共用图标中轴并收紧间距，亮暗窄窗和缩放仍可准确点击", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const first = f.panel.locator(".execution-job").first();
  const button = first.getByRole("button", { name: "查看结果", exact: true });
  for (const [width, height, zoom] of [
    [1440, 960, 1],
    [760, 540, 1],
    [760, 540, 2],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.evaluate((zoom) => {
      (document.querySelector(".app") as HTMLElement).style.zoom = String(zoom);
    }, zoom!);
    for (const appearance of ["dark", "light"]) {
      await page.evaluate((appearance) => {
        document
          .querySelector(".app")!
          .setAttribute("data-appearance", appearance);
        document.documentElement.setAttribute("data-appearance", appearance);
      }, appearance);
      await settleTransitions(page);
      await button.scrollIntoViewIfNeeded();
      await f.panel.screenshot({
        path: info.outputPath(`alignment-${width}-${zoom}-${appearance}.png`),
      });
      const metrics = await first.evaluate((el) => {
        const rect = (selector: string) =>
          el.querySelector(selector)!.getBoundingClientRect();
        const title = rect("header strong");
        const check = rect(".job-status svg");
        const eye = rect('[aria-label="查看结果"] svg');
        const header = rect("header");
        const meta = rect(".execution-step-meta");
        const time = rect(".execution-step-time");
        return {
          iconAxis: check.x + check.width / 2 - (eye.x + eye.width / 2),
          titleAlignment:
            title.y + title.height / 2 - (check.y + check.height / 2),
          textAxis: title.x - time.x,
          rowGap: meta.y - header.bottom,
        };
      });
      expect(Math.abs(metrics.iconAxis)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(metrics.titleAlignment)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(metrics.textAxis)).toBeLessThanOrEqual(0.5);
      expect(metrics.rowGap / zoom!).toBeCloseTo(2, 2);
      const box = (await button.boundingBox())!;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(
        await button.evaluate((el, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === el || (hit !== null && el.contains(hit));
        }, point),
      ).toBe(true);
      await page.mouse.click(point.x, point.y);
      await expect(first.locator(".execution-result pre")).toBeVisible();
      await button.click();
      await expect(first.locator(".execution-result")).toHaveCount(0);
    }
  }
  expect(f.resultReads).toEqual(["TEST-ui-job-0"]);
  expect(f.writes).toEqual([]);
  await expect(f.input).toHaveValue("TEST 未发送的原草稿");
});

test.describe("触控步骤对齐", () => {
  test.use({ hasTouch: true });
  test("圆圈和操作图标仍共用中轴，保留完整触控点击区", async ({ page }) => {
    const f = await prepare(page);
    await openExecutionPanel(page);
    await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const first = f.panel.locator(".execution-job").first();
    const button = first.getByRole("button", { name: "查看结果", exact: true });
    await button.scrollIntoViewIfNeeded();
    const check = (await first.locator(".job-status svg").boundingBox())!;
    const eye = (await button.locator("svg").boundingBox())!;
    expect(
      Math.abs(check.x + check.width / 2 - (eye.x + eye.width / 2)),
    ).toBeLessThanOrEqual(0.5);
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(first.locator(".execution-result pre")).toBeVisible();
    await button.click();
    await expect(first.locator(".execution-result")).toHaveCount(0);
    expect(f.writes).toEqual([]);
    await expect(f.input).toHaveValue("TEST 未发送的原草稿");
  });
});

test("查看结果一次展开内容，再次收起，缓存复开及换步骤保持准确且没有写入", async ({
  page,
}, info) => {
  const f = await prepare(page);
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const first = f.panel.locator(".execution-job").first();
  const button = first.getByRole("button", { name: "查看结果", exact: true });
  await button.click();
  await expect(first.locator(".execution-result pre")).toBeVisible();
  await expect(first.locator(".execution-result pre")).toContainText(
    "TEST receipt",
  );
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(first.getByText("完整返回内容", { exact: true })).toHaveCount(0);
  const region = first.getByRole("region", { name: "返回结果", exact: true });
  await expect(region).toHaveAttribute(
    "id",
    (await button.getAttribute("aria-controls"))!,
  );
  expect(f.resultReads).toEqual(["TEST-ui-job-0"]);
  await page.mouse.move(20, 200);
  await button.hover();
  await expect(page.getByRole("tooltip")).toHaveText("查看结果");
  await page.keyboard.press("Escape");
  await expect(first.locator(".execution-result pre")).toBeVisible();
  await button.click();
  await expect(first.locator(".execution-result")).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  expect(f.resultReads).toEqual(["TEST-ui-job-0"]);
  await button.press("Enter");
  await expect(first.locator(".execution-result pre")).toBeVisible();
  expect(f.resultReads).toEqual(["TEST-ui-job-0"]);
  for (const appearance of ["dark", "light"]) {
    await page.evaluate((appearance) => {
      document
        .querySelector(".app")!
        .setAttribute("data-appearance", appearance);
      document.documentElement.setAttribute("data-appearance", appearance);
    }, appearance);
    await settleTransitions(page);
    await f.panel.screenshot({
      path: info.outputPath(`result-open-${appearance}.png`),
    });
  }
  f.resultReply.text = "TEST 第二个步骤的精确结果";
  const second = f.panel.locator(".execution-job").nth(1);
  await second.getByRole("button", { name: "查看结果", exact: true }).click();
  await expect(second.locator(".execution-result pre")).toHaveText(
    f.resultReply.text,
  );
  await expect(first.locator(".execution-result")).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  expect(f.resultReads).toEqual(["TEST-ui-job-0", "TEST-ui-job-1"]);
  await second.getByRole("button", { name: "查看结果", exact: true }).click();
  await expect(f.panel.locator(".execution-result")).toHaveCount(0);
  await expect(f.input).toHaveValue("TEST 未发送的原草稿");
  expect(f.writes).toEqual([]);
});

test("成功圆圈对勾使用可辨绿色，失败取消不冒充成功", async ({ page }, info) => {
  const f = await prepare(page);
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const first = f.panel.locator(".execution-job").first();
  const second = f.panel.locator(".execution-job").nth(1);
  const check = first.getByRole("img", { name: "已完成", exact: true });
  for (const [appearance, color] of [
    ["dark", "rgb(131, 217, 155)"],
    ["light", "rgb(24, 125, 61)"],
  ] as const) {
    await page.evaluate((appearance) => {
      document
        .querySelector(".app")!
        .setAttribute("data-appearance", appearance);
      document.documentElement.setAttribute("data-appearance", appearance);
    }, appearance);
    await settleTransitions(page);
    await expect(check).toHaveCSS("color", color);
    await expect(check.locator("svg")).toHaveCSS("width", "16px");
    await expect(check.locator("svg.lucide-circle-check")).toHaveCount(1);
    await expect(check.locator("circle")).toHaveCount(1);
    await f.panel.screenshot({
      path: info.outputPath(`success-check-${appearance}.png`),
    });
  }
  for (const [status, label] of [
    ["failed", "失败"],
    ["cancelled", "已取消"],
  ]) {
    f.jobs.secondStatus = status!;
    await f.fixture.refresh();
    await expect(second.locator(".job-status")).toHaveText(label!);
    await expect(
      second.getByRole("img", { name: "已完成", exact: true }),
    ).toHaveCount(0);
    expect(
      await second
        .locator(".job-status")
        .evaluate((el) => getComputedStyle(el).color),
    ).not.toBe("rgb(24, 125, 61)");
  }
  expect(f.writes).toEqual([]);
});

test("未完成结果重新打开会重读，空结果和截断直接显示，普通输出不执行HTML", async ({
  page,
}) => {
  const f = await prepare(page);
  f.resultReply.available = false;
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const first = f.panel.locator(".execution-job").first();
  const button = first.getByRole("button", { name: "查看结果", exact: true });
  await button.click();
  await expect(first.locator(".execution-result pre")).toHaveText(
    "尚无最终结果。",
  );
  await button.click();
  await expect(first.locator(".execution-result")).toHaveCount(0);
  f.resultReply.available = true;
  f.resultReply.text = "";
  await button.click();
  await expect(first.locator(".execution-result pre")).toHaveText(
    "执行返回了空内容。",
  );
  expect(f.resultReads).toEqual(["TEST-ui-job-0", "TEST-ui-job-0"]);
  const second = f.panel.locator(".execution-job").nth(1);
  f.resultReply.text = '<img src="TEST" onerror="alert(1)">TEST 原样输出';
  f.resultReply.truncated = true;
  await second.getByRole("button", { name: "查看结果", exact: true }).click();
  await expect(second.locator(".execution-result pre")).toHaveText(
    f.resultReply.text,
  );
  await expect(second.locator(".execution-result img")).toHaveCount(0);
  await expect(second.locator(".execution-result")).toContainText("64,000");
  expect(f.writes).toEqual([]);
});

test("结果读取失败后原按钮可重试，收起不读取或停止任务", async ({ page }) => {
  const f = await prepare(page);
  f.resultHttp.status = 503;
  await openExecutionPanel(page);
  await f.panel.locator('[data-thread-id="TEST-ui-thread"]').click();
  const first = f.panel.locator(".execution-job").first();
  const button = first.getByRole("button", { name: "查看结果", exact: true });
  await button.click();
  await expect(f.panel.locator(".execution-notice")).toContainText(
    "TEST 无法读取结果",
  );
  await expect(button).toBeEnabled();
  await expect(first.locator(".execution-result")).toHaveCount(0);
  f.resultHttp.status = 200;
  await button.click();
  await expect(first.locator(".execution-result pre")).toBeVisible();
  await button.click();
  await expect(first.locator(".execution-result")).toHaveCount(0);
  expect(f.resultReads).toEqual(["TEST-ui-job-0", "TEST-ui-job-0"]);
  await expect(f.input).toHaveValue("TEST 未发送的原草稿");
  expect(f.writes).toEqual([]);
});

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
