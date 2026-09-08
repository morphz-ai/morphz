import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

test("已完成的人类消息不为隐藏操作留出空行，悬停操作在气泡外且不撑高正文", async ({
  page,
}) => {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    // Presentation fixture only: no model or changes to persisted delivery state.
    body.runtime.deliveries = body.workspace.inputs.map(
      (input: { id: string }) => ({
        inputId: input.id,
        state: "completed",
        error: null,
      }),
    );
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  for (const text of ["简短消息", "这是一条需要自动换行的消息。".repeat(12)]) {
    await page.getByLabel("AI 输入内容").fill(text);
    await page.getByRole("button", { name: "保存输入", exact: true }).click();
    const message = page.locator(".human-message").last();
    await expect(message.locator(":scope > p")).toHaveText(text);
    await expect(
      message.locator(".message-meta > span:not(.message-peek)"),
    ).toHaveCount(0);
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.getByLabel("AI 输入内容").focus();
      await page.mouse.move(0, 0);
      const bubble = (await message.boundingBox())!;
      const paragraph = (await message.locator(":scope > p").boundingBox())!;
      expect(bubble.height - paragraph.height).toBeLessThanOrEqual(21);
      expect(
        (await message.locator(".message-meta").boundingBox())!.height,
      ).toBe(0);
      await expect(message.locator(".message-peek")).toHaveCSS("opacity", "0");
      await message.hover();
      await expect(message.locator(".message-peek")).toHaveCSS("opacity", "1");
      expect((await message.boundingBox())!.height).toBe(bubble.height);
      const actions = (await message.locator(".message-peek").boundingBox())!;
      expect(Math.abs(actions.y - bubble.y - bubble.height)).toBeLessThan(1);
      const column = (await page
        .getByRole("log", { name: "对话消息" })
        .boundingBox())!;
      expect(actions.x).toBeGreaterThanOrEqual(column.x);
      expect(actions.x + actions.width).toBeLessThanOrEqual(
        column.x + column.width + 1,
      );
      await message.locator(".message-copy").focus();
      await page.mouse.move(0, 0);
      await expect(message.locator(".message-peek")).toHaveCSS("opacity", "1");
    }
  }
});

test("消息隐藏重复身份，时间与复制按悬停和键盘焦点显示，复制不混入元数据", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copied = text;
        },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const body = "复制正文 **原样保留**\n第二行：中文与 🦋。";
  await page.getByLabel("AI 输入内容").fill(body);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const message = page.locator(".human-message").last();
  await expect(message).toContainText(body);
  await expect(message.locator(".message-author, .avatar")).toHaveCount(0);
  await expect(
    message
      .locator(".message-meta > span")
      .filter({ hasText: /^(我|Morphz)$/ }),
  ).toHaveCount(0);
  const actions = message.locator(".message-peek");
  await page.mouse.move(0, 0);
  await page.getByLabel("AI 输入内容").focus();
  await expect(actions).toHaveCSS("opacity", "0");
  // Essential unsent status remains visible, independently of optional metadata.
  await expect(
    message.getByText("已保存 · 未发送", { exact: true }),
  ).toBeVisible();
  const before = await message.boundingBox();
  await message.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  expect(await message.boundingBox()).toEqual(before);
  await message.getByRole("button", { name: "复制消息", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__copied))
    .toBe(body);
  await expect(
    message.getByRole("button", { name: "已复制消息" }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await page.getByLabel("AI 输入内容").focus();
  await expect(actions).toHaveCSS("opacity", "0");
  await message.locator(".message-copy").focus();
  await expect(actions).toHaveCSS("opacity", "1");
  await message.locator(".message-copy").press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as any).__copied))
    .toBe(body);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
    document.execCommand = () => false;
  });
  await message.locator(".message-copy").click();
  await expect(message.getByRole("alert")).toContainText("复制失败");
  await page.evaluate(() => {
    document.execCommand = () => {
      (window as any).__fallbackCopied = (
        document.activeElement as HTMLTextAreaElement
      ).value;
      return true;
    };
  });
  await message.locator(".message-copy").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__fallbackCopied))
    .toBe(body);
  await expect(message.getByRole("alert")).toHaveCount(0);
  await expect(message.locator(".message-copy")).toBeFocused();
});
