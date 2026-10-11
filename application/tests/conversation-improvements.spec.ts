import { expect, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

const historyRoute =
  /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/;
const searchRoute =
  /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/search(?:\?.*)?$/;

async function setup(page: Page) {
  const inputs: PlatformHistory["inputs"] = [];
  const runtime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    messages: [] as PlatformHistory["runtime"]["messages"],
  };
  const presentation = await mockPlatformConversation(page, () => ({
    inputs,
    runtime,
  }));
  const now = Date.now() - 10000;
  inputs.push(
    presentation.input("current", "TEST 当前消息", new Date(now).toISOString()),
  );
  runtime.messages.push({
    id: "current-reply",
    ...presentation.scope,
    inputId: "current",
    artifactId: null,
    kind: "reply",
    text: "TEST 回复第一段。\n\n第二段保留清晰的段落节奏。",
    createdAt: new Date(now + 1000).toISOString(),
  });
  const old = presentation.input(
    "older-source",
    "TEST 旧消息的唯一内容 [.*]",
    new Date(now - 100000).toISOString(),
  );
  const olderReply = {
    id: "older-reply",
    ...presentation.scope,
    inputId: old.id,
    artifactId: null,
    kind: "reply" as const,
    text: "TEST 旧回复与当前首屏无关 [.*]",
    createdAt: new Date(now - 99000).toISOString(),
  };
  const headCursor = { createdAt: inputs[0]!.createdAt, id: "current" };
  const historyReads: URL[] = [];
  await page.route(historyRoute, (route) => {
    const url = new URL(route.request().url());
    historyReads.push(url);
    return route.fulfill({
      json: url.searchParams.has("beforeId")
        ? {
            inputs: [old],
            runtime: { ...runtime, messages: [olderReply] },
            nextCursor: null,
          }
        : { inputs, runtime, nextCursor: headCursor },
    });
  });
  const writes: string[] = [],
    inspected: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // Cognitive app catalog discovery is a typed read transported by POST.
    if (
      !["GET", "HEAD"].includes(request.method()) &&
      path.startsWith("/api/") &&
      ![
        "/api/platform/spaces/ensure",
        "/api/platform/cognitive-apps/list",
      ].includes(path)
    )
      writes.push(request.method() + " " + path);
  });
  await page.route("**/api/executions?*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("inputId");
    if (id) inspected.push(id);
    return route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(page.locator('[data-message-id="current-reply"]')).toBeVisible();
  return {
    ...presentation,
    inputs,
    runtime,
    old,
    olderReply,
    headCursor,
    historyReads,
    writes,
    inspected,
  };
}

test("原生长输入不丢尾部，明确拒绝超限按钮／快捷键，重载仍保留完整草稿", async ({
  page,
}, info) => {
  const f = await setup(page);
  const input = await openInput(page);
  const text = "前".repeat(30000) + "末尾标记";
  await page.keyboard.insertText(text);
  await expect(input).toHaveValue(text);
  expect(await input.getAttribute("maxlength")).toBeNull();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText(
    "30,000 字符限制；全文已保留",
  );
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await input.press("Enter");
  await input.press("Alt+Enter");
  await expect(input).toHaveValue(text);
  expect(f.writes).toEqual([]);
  await page.reload();
  const retained = await openInput(page);
  await expect(retained).toHaveValue(text);
  await page.screenshot({ path: info.outputPath("long-draft-retained.png") });
  await retained.fill("TEST 缩短后允许发送，但本测试不发送。");
  await expect(retained).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  expect(f.writes).toEqual([]);
});

test("当前对话查找扫描未加载历史，继续游标后精确定位旧回复，不打开任务或修改草稿", async ({
  page,
}, info) => {
  const f = await setup(page);
  const searchReads: URL[] = [];
  const cursor = { createdAt: f.old.createdAt, id: "search-window" };
  await page.route(searchRoute, (route) => {
    const url = new URL(route.request().url());
    searchReads.push(url);
    expect(url.pathname).toContain(
      `/projects/${f.spaces.deskId}/conversations/${f.scope.conversationId}/search`,
    );
    expect(url.searchParams.get("query")).toBe("[.*]");
    return route.fulfill({
      json: url.searchParams.has("beforeId")
        ? {
            hits: [
              {
                messageId: f.olderReply.id,
                ...f.scope,
                createdAt: f.olderReply.createdAt,
                kind: "reply",
                preview: f.olderReply.text,
              },
            ],
            nextCursor: null,
            scanned: 12,
          }
        : { hits: [], nextCursor: cursor, scanned: 200 },
    });
  });
  const input = await openInput(page);
  await input.fill("TEST 查找前的未发送草稿");
  await page.getByRole("button", { name: "查找对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "查找当前对话" });
  expect(
    await dialog.evaluate((el) => ({
      border: getComputedStyle(el).borderTopWidth,
      radius: getComputedStyle(el).borderRadius,
    })),
  ).toEqual({ border: "1px", radius: "14px" });
  await dialog
    .getByRole("textbox", { name: "查找当前对话", exact: true })
    .fill("[.*]");
  await expect(dialog).toContainText("更早消息尚未查找");
  await expect(dialog).not.toContainText("当前对话没有匹配的消息");
  await dialog.getByRole("button", { name: "继续查找更早消息" }).click();
  await expect(
    dialog.getByRole("list", { name: "对话查找结果" }),
  ).toContainText(f.olderReply.text);
  expect(searchReads.at(-1)!.searchParams.get("beforeId")).toBe(cursor.id);
  await page.screenshot({ path: info.outputPath("search-older-result.png") });
  await dialog.getByRole("textbox").press("Enter");
  await expect(dialog).not.toBeVisible();
  const target = page.locator(`[data-message-id="${f.olderReply.id}"]`);
  await expect(target).toHaveAttribute("data-quote-revealed", "true");
  await expect(target).toBeInViewport();
  await expect(
    page.locator('[data-message-id="current-reply"]'),
  ).not.toHaveAttribute("data-quote-revealed", "true");
  expect(
    f.historyReads.some(
      (url) => url.searchParams.get("beforeId") === f.headCursor.id,
    ),
  ).toBe(true);
  await expect(input).toHaveValue("TEST 查找前的未发送草稿");
  expect(f.inspected).toEqual([]);
  expect(f.writes).toEqual([]);
});

test("查找失败可以重试，过期查询不覆盖新结果，预览不会执行 HTML", async ({
  page,
}) => {
  const f = await setup(page);
  let retry = 0,
    release: (() => void) | undefined,
    oldReturned = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(searchRoute, async (route) => {
    const query = new URL(route.request().url()).searchParams.get("query");
    if (query === "失败" && retry++ === 0)
      return route.fulfill({
        status: 503,
        json: { error: "TEST Runtime 暂不可用" },
      });
    if (query === "旧查询") {
      await held;
      oldReturned = true;
    }
    return route.fulfill({
      json: {
        hits: [
          {
            messageId: "current-reply",
            ...f.scope,
            createdAt: f.runtime.messages[0]!.createdAt,
            kind: "reply",
            preview:
              query === "旧查询"
                ? "TEST 过期结果不得显示"
                : `TEST ${query} <img src=x onerror=alert(1)>`,
          },
        ],
        nextCursor: null,
        scanned: 2,
      },
    });
  });
  await page.getByRole("button", { name: "查找对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "查找当前对话" });
  const search = dialog.getByRole("textbox");
  await search.fill("失败");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).not.toContainText("当前对话没有匹配的消息");
  await dialog.getByRole("button", { name: "重试查找" }).click();
  await expect(dialog.getByRole("list")).toContainText("TEST 失败");
  const started = page.waitForRequest(
    (req) =>
      searchRoute.test(req.url()) &&
      new URL(req.url()).searchParams.get("query") === "旧查询",
  );
  await search.fill("旧查询");
  await started;
  await search.fill("新查询");
  await expect(dialog.getByRole("list")).toContainText("TEST 新查询");
  release!();
  await expect.poll(() => oldReturned).toBe(true);
  await expect(dialog).not.toContainText("过期结果不得显示");
  await expect(dialog.locator("img")).toHaveCount(0);
  await search.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(f.writes).toEqual([]);
});

test("旧消息来源直接回填历史，使用精确 ID 且不误开活动", async ({ page }) => {
  const f = await setup(page);
  f.runtime.messages.push({
    id: "late-older-reply",
    ...f.scope,
    inputId: f.old.id,
    artifactId: null,
    kind: "reply",
    text: "TEST 对旧输入的迟到回复",
    createdAt: new Date().toISOString(),
  });
  await f.refresh();
  const input = await openInput(page);
  await input.fill("TEST 来源跳转保留的草稿");
  await page
    .locator('[data-message-id="late-older-reply"]')
    .getByRole("button", { name: "回复：原消息", exact: true })
    .click();
  await expect(page.locator(`[data-message-id="${f.old.id}"]`)).toHaveAttribute(
    "data-quote-revealed",
    "true",
  );
  await expect(
    page.locator(`[data-message-id="${f.old.id}"]`),
  ).toBeInViewport();
  await expect(input).toHaveValue("TEST 来源跳转保留的草稿");
  expect(f.inspected).toEqual([]);
  expect(f.writes).toEqual([]);
});

test("右上角查找无关闭叉号：外部单击关闭但不穿透，内部空白及跨边界拖选不关闭，工作页读写选择保留", async ({
  page,
}) => {
  const f = await setup(page);
  await page.route(searchRoute, (route) =>
    route.fulfill({ json: { hits: [], nextCursor: null, scanned: 2 } }),
  );
  const trigger = page.getByRole("button", { name: "查找对话", exact: true });
  const dialog = page.getByRole("dialog", { name: "查找当前对话" });
  await trigger.click();
  await expect(dialog.getByRole("button", { name: "关闭查找" })).toHaveCount(0);
  const search = dialog.getByRole("textbox", {
    name: "查找当前对话",
    exact: true,
  });
  await search.press("Tab");
  await expect(search).toBeFocused();
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(dialog).toBeVisible();
  await search.fill("TEST 拖选不关闭");
  const inputBox = (await search.boundingBox())!;
  await page.mouse.move(inputBox.x + 12, inputBox.y + inputBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 12, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(search).toHaveValue("TEST 拖选不关闭");
  const nav = page.getByRole("navigation", { name: "主导航" });
  const workbench = nav.getByRole("button", { name: "工作台", exact: true });
  const backgroundButton = (await workbench.boundingBox())!;
  // The native dialog consumes this press. Closing must not activate the
  // otherwise clickable navigation button underneath the backdrop.
  await page.mouse.click(backgroundButton.x + 12, backgroundButton.y + 12);
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "对话", exact: true }),
  ).toBeVisible();
  await expect(trigger).toBeFocused();
  await workbench.click();
  const draft = await openInput(page);
  await draft.fill("TEST 工作页未发送草稿");
  await page.getByRole("button", { name: "查看交流记录", exact: true }).click();
  const records = page.getByRole("button", {
    name: "收起交流记录",
    exact: true,
  });
  await expect(records).toHaveAttribute("aria-pressed", "true");
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".conversation")).toBeVisible();
  const outside = (await dialog.boundingBox())!;
  await page.mouse.click(outside.x + outside.width / 2, outside.y - 12);
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(records).toHaveAttribute("aria-pressed", "true");
  await expect(draft).toHaveValue("TEST 工作页未发送草稿");
  await trigger.click();
  await dialog.getByRole("textbox").press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(records).toHaveAttribute("aria-pressed", "true");
  await expect(draft).toHaveValue("TEST 工作页未发送草稿");
  // Protecting the search interaction must not disable ordinary auto-hide.
  await page.getByRole("heading", { name: "工作台", exact: true }).click();
  await expect(page.locator(".conversation")).not.toBeVisible();
  await openInput(page);
  await expect(records).toHaveAttribute("aria-pressed", "true");
  await expect(draft).toHaveValue("TEST 工作页未发送草稿");
  expect(f.writes).toEqual([]);
});

test("空输入框收紧，长内容自适应；亮暗与窄窗口保留可点击的查找入口和单底栏", async ({
  page,
}, info) => {
  const f = await setup(page);
  const input = await openInput(page);
  await input.fill("");
  const composer = page.locator(".composer");
  const empty = (await composer.boundingBox())!.height;
  expect(empty).toBeLessThanOrEqual(130);
  await input.fill("TEST 长草稿行\n".repeat(18));
  expect((await composer.boundingBox())!.height).toBeGreaterThan(empty);
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(181);
  await input.fill("TEST 视觉验收未发送草稿");
  for (const [appearance, label] of [
    ["light", "亮色"],
    ["dark", "暗色"],
  ] as const) {
    const settings = await openSettings(page, "外观");
    await settings.getByRole("button", { name: label, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await expect(page.locator(".app")).toHaveAttribute(
      "data-appearance",
      appearance,
    );
    for (const width of [1440, 760, 390]) {
      await page.setViewportSize({ width, height: 960 });
      const trigger = page.getByRole("button", {
        name: "查找对话",
        exact: true,
      });
      await expect(trigger).toBeInViewport();
      const toolbarBox = (await page.locator(".topbar").boundingBox())!;
      const triggerBox = (await trigger.boundingBox())!;
      expect(
        toolbarBox.x + toolbarBox.width - triggerBox.x - triggerBox.width,
      ).toBeLessThanOrEqual(20);
      expect(triggerBox.y).toBeGreaterThanOrEqual(toolbarBox.y);
      expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(
        toolbarBox.y + toolbarBox.height,
      );
      expect(
        await trigger.evaluate(
          (button) => !!button.closest(".topbar .top-actions"),
        ),
      ).toBe(true);
      await expect(
        page.locator(".exchange-panel-header .conversation-search-trigger"),
      ).toHaveCount(0);
      const actualHit = await trigger.evaluate((button) => {
        const b = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
        );
      });
      expect(actualHit).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await expect(composer.locator(".composer-action-bar")).toHaveCount(1);
      await page.screenshot({
        path: info.outputPath(`dialogue-${appearance}-${width}.png`),
        animations: "disabled",
      });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "查找当前对话" });
      await expect(dialog).toBeInViewport();
      await expect(
        dialog.getByRole("button", { name: "关闭查找" }),
      ).toHaveCount(0);
      const searchInput = dialog.getByRole("textbox", {
        name: "查找当前对话",
        exact: true,
      });
      await expect(searchInput).toBeFocused();
      expect(
        await searchInput.evaluate((el) => {
          const inputStyle = getComputedStyle(el);
          const fieldStyle = getComputedStyle(el.parentElement!);
          return {
            inputBorder: inputStyle.borderTopWidth,
            inputOutline: inputStyle.outlineStyle,
            inputShadow: inputStyle.boxShadow,
            fieldBorder: fieldStyle.borderTopWidth,
            fieldOutline: fieldStyle.outlineStyle,
            fieldShadow: fieldStyle.boxShadow,
          };
        }),
      ).toMatchObject({
        inputBorder: "0px",
        inputOutline: "none",
        inputShadow: "none",
        fieldBorder: "1px",
        fieldOutline: "none",
        fieldShadow: "none",
      });
      await page.screenshot({
        path: info.outputPath(`search-focus-${appearance}-${width}.png`),
        animations: "disabled",
      });
      await searchInput.press("Escape");
      await expect(dialog).not.toBeVisible();
    }
  }
  await expect(input).toHaveValue("TEST 视觉验收未发送草稿");
  expect(f.writes).toEqual([]);
});
