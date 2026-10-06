import { expect, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

const error =
  "TEST 附件暂时不能添加；草稿与执行设置必须保持不变。".repeat(35) +
  "全文末尾校验。";

async function prepare(page: Page) {
  let connected = true;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      model: "status-fixture-model",
      error: connected ? "" : "TEST 连接已断开，未发送内容保留",
    },
  }));
  await page.route("**/api/attachments", (route) =>
    route.fulfill({ status: 503, json: { message: error } }),
  );
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({ json: { configured: false, provider: null } }),
  );
  let messages = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/platform/messages")
    )
      messages++;
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 错误、连接提示不挤动输入；不发送");
  return {
    input,
    sent: () => messages,
    async disconnect() {
      connected = false;
      await fixture.refresh();
      await expect(page.locator(".model-status")).toContainText(
        "智能体连接异常",
      );
    },
    async failUpload() {
      await page.getByLabel("消息附件文件", { exact: true }).setInputFiles({
        name: "TEST-attachment.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("fixture failure only; no stored upload"),
      });
      await expect(page.locator(".composer-error")).toContainText(
        "全文末尾校验。",
      );
    },
    async reconnect() {
      connected = true;
      await fixture.refresh();
    },
  };
}

for (const appearance of ["亮色", "暗色"])
  for (const view of [
    { width: 1440, zoom: 1 },
    { width: 390, zoom: 1 },
    { width: 320, zoom: 1 },
    { width: 1440, zoom: 2 },
  ])
    test(`${appearance} ${view.width}px ${view.zoom * 100}%：提示同工具栏、全文可读、不增高或丢草稿`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: view.width, height: 960 });
      const f = await prepare(page);
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await page.keyboard.press("Escape");
      await page.locator(".app").evaluate((element, zoom) => {
        (element as HTMLElement).style.zoom = String(zoom);
      }, view.zoom);
      await openInput(page);
      await expect(page.locator(".composer-status-slot")).toHaveCount(0);
      const before = (await page.locator(".composer").boundingBox())!;
      const writing = (await f.input.boundingBox())!;
      const tools = (await page.locator(".composer-action-bar").boundingBox())!;
      await f.disconnect();
      const disconnected = (await page.locator(".composer").boundingBox())!;
      const connection = page
        .locator(".composer-action-bar .model-status")
        .getByRole("button", { name: "连接详情", exact: true });
      await expect(connection).toBeVisible();
      await sameRow(page, connection, view.zoom);
      await connection.click();
      await expect(
        page.getByRole("dialog", { name: "连接详情", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await openInput(page);
      await f.failUpload();
      const failed = (await page.locator(".composer").boundingBox())!;
      await info.attach("composer-status-geometry", {
        body: JSON.stringify({ before, disconnected, failed }),
        contentType: "application/json",
      });
      expect(Math.abs(disconnected.height - before.height)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(failed.height - before.height)).toBeLessThanOrEqual(1);
      expect(
        Math.abs((await f.input.boundingBox())!.height - writing.height),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          (await page.locator(".composer-action-bar").boundingBox())!.height -
            tools.height,
        ),
      ).toBeLessThanOrEqual(1);
      await expect(
        page.locator(".composer-action-bar .composer-error"),
      ).toContainText("全文末尾校验。");
      const notice = page.getByRole("button", {
        name: "输入错误详情",
        exact: true,
      });
      await sameRow(page, notice, view.zoom);
      await expect(notice).toHaveAttribute(
        "title",
        `输入错误详情 · TEST-attachment.txt：${error}`,
      );
      const summary = notice.locator(".composer-error");
      expect(
        await summary.evaluate((element) => ({
          nowrap: getComputedStyle(element).whiteSpace,
          overflow: getComputedStyle(element).textOverflow,
        })),
      ).toEqual({ nowrap: "nowrap", overflow: "ellipsis" });
      await f.input.focus();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "新建或添加", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(notice).toBeFocused();
      await page.keyboard.press("Enter");
      const details = page.getByRole("group", {
        name: "输入错误详情",
        exact: true,
      });
      await expect(details).toBeVisible();
      await expect(details).toBeFocused();
      await expect(details.locator("p")).toHaveText(
        `TEST-attachment.txt：${error}`,
      );
      if (
        await details.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        )
      ) {
        await page.keyboard.press("PageDown");
        await expect
          .poll(() => details.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
      }
      const full = (await details.boundingBox())!;
      expect(full.x).toBeGreaterThanOrEqual(0);
      expect(full.y).toBeGreaterThanOrEqual(0);
      expect(full.x + full.width).toBeLessThanOrEqual(view.width + 1);
      expect(full.y + full.height).toBeLessThanOrEqual(961);
      await expect(details.locator(".model-status")).toContainText(
        "智能体连接异常",
      );
      await details
        .getByRole("button", { name: "连接详情", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "连接详情", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await openInput(page);
      await notice.click();
      await expect(details).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(notice).toBeFocused();
      await expect(details).toBeHidden();
      await f.reconnect();
      await expect(page.locator(".model-status")).toHaveCount(0);
      await expect(notice).toBeVisible();
      await page.getByRole("button", { name: "执行设置", exact: true }).click();
      await expect(
        page.getByRole("group", { name: "执行设置", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "语音输入", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "听写", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "关闭听写", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "语音输入", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole("button", { name: "发送消息", exact: true }),
      ).toBeEnabled();
      await page.locator(".composer").screenshot({
        path: info.outputPath("composer-status.png"),
        animations: "disabled",
      });
      await expect(f.input).toHaveValue(
        "TEST 错误、连接提示不挤动输入；不发送",
      );
      expect(f.sent()).toBe(0);
    });

async function sameRow(
  page: Page,
  notice: import("@playwright/test").Locator,
  zoom: number,
) {
  const row = (await page.locator(".composer-action-bar").boundingBox())!;
  const bounds = (await notice.boundingBox())!;
  expect(bounds.height / zoom).toBeGreaterThanOrEqual(32);
  expect(bounds.y).toBeGreaterThanOrEqual(row.y - 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(row.y + row.height + 1);
  const targets = [bounds];
  for (const name of ["新建或添加", "执行设置", "语音输入", "发送消息"]) {
    const control = page.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    const rect = (await control.boundingBox())!;
    targets.push(rect);
    expect(rect.y).toBeGreaterThanOrEqual(row.y - 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(row.y + row.height + 1);
    expect(rect.x).toBeGreaterThanOrEqual(row.x - 1);
    expect(rect.x + rect.width).toBeLessThanOrEqual(row.x + row.width + 1);
  }
  for (let index = 0; index < targets.length; index++)
    for (let other = index + 1; other < targets.length; other++) {
      const a = targets[index]!,
        b = targets[other]!;
      expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1).toBe(true);
    }
  expect(
    await page
      .locator(".composer-action-bar")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
}

test.describe("触控错误详情", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 960 } });
  test("320px保持44px触控入口，错误全文点按可读并可返回草稿", async ({
    page,
  }) => {
    const f = await prepare(page);
    await f.disconnect();
    await f.failUpload();
    const notice = page.getByRole("button", {
      name: "输入错误详情",
      exact: true,
    });
    await sameRow(page, notice, 1);
    expect((await notice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await notice.tap();
    const details = page.getByRole("group", {
      name: "输入错误详情",
      exact: true,
    });
    await expect(details).toBeVisible();
    await expect(details).toContainText("全文末尾校验。");
    await page.keyboard.press("Escape");
    await expect(notice).toBeFocused();
    await page.getByRole("button", { name: "执行设置", exact: true }).tap();
    await expect(
      page.getByRole("group", { name: "执行设置", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "语音输入", exact: true }).tap();
    await expect(
      page.getByRole("region", { name: "听写", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭听写", exact: true }).tap();
    await expect(
      page.getByRole("button", { name: "发送消息", exact: true }),
    ).toBeEnabled();
    await expect(f.input).toHaveValue("TEST 错误、连接提示不挤动输入；不发送");
    expect(f.sent()).toBe(0);
  });
});
