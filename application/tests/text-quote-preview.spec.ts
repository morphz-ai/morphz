import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

const quoteText =
  "这种固定消息提醒可以不经过模型求值。".repeat(10) +
  "\n\n第二段保持完整：https://example.invalid/" +
  "long-path-".repeat(40) +
  "\n末尾验证：引用内容没有被截断。";
const comment = "就算需要求值，也不一定需要创建一个目标。";

async function prepare(page: Page, body = "", text = quoteText) {
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      messages: [],
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "completed" as const,
        error: null,
        retryable: false,
      })),
    },
  }));
  const source = fixture.input(
    "quote-preview-source",
    text,
    "2026-10-02T13:49:00.000Z",
  );
  const sent = fixture.input(
    "quote-preview-sent",
    body,
    "2026-10-02T13:49:01.000Z",
  );
  sent.textQuotes = [
    {
      id: randomUUID(),
      text,
      comment,
      source: {
        kind: "message",
        ...fixture.scope,
        title: "Morphz",
        messageId: source.id,
        inputId: source.id,
        createdAt: source.createdAt,
      },
      anchor: { start: 0, end: text.length, prefix: "", suffix: "" },
    },
  ];
  inputs.push(source, sent);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const message = page.locator(
    '.human-message[data-input-id="quote-preview-sent"]',
  );
  const quote = message.getByRole("button", {
    name: "查看引用 1 的原文",
    exact: true,
  });
  const preview = message.getByRole("region", { name: "引用 1 全文" });
  await expect(quote).toBeVisible();
  await page.mouse.move(0, 0);
  return { message, quote, preview, fixture, sent };
}

test("长多段引用默认一行ellipsis，全文与评论未截断，引用-only无多余尾距", async ({
  page,
}, testInfo) => {
  const { message, quote } = await prepare(page);
  const line = quote.locator("span > span");
  await expect(line).toHaveText(quoteText);
  await expect(message.locator(".text-quote-comment")).toHaveText(comment);
  expect(
    await line.evaluate((e) => ({
      whiteSpace: getComputedStyle(e).whiteSpace,
      ellipsis: getComputedStyle(e).textOverflow,
      height: e.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(e).lineHeight),
      overflowing: e.scrollWidth > e.clientWidth,
    })),
  ).toMatchObject({
    whiteSpace: "nowrap",
    ellipsis: "ellipsis",
    overflowing: true,
  });
  const metrics = await message.evaluate((e) => {
    const comment = e.querySelector(".text-quote-comment")!;
    const line = e.querySelector(".sent-text-quote > span > span")!;
    return {
      bottomGap:
        e.getBoundingClientRect().bottom -
        comment.getBoundingClientRect().bottom,
      padding: Number.parseFloat(getComputedStyle(e).paddingBottom),
      lines:
        line.getBoundingClientRect().height /
        Number.parseFloat(getComputedStyle(line).lineHeight),
      horizontalOverflow: e.scrollWidth > e.clientWidth,
      emptyParagraphs: [...e.querySelectorAll("p")].filter(
        (p) => !p.textContent?.trim(),
      ).length,
    };
  });
  expect(metrics.lines).toBeCloseTo(1, 1);
  expect(metrics.bottomGap).toBeCloseTo(metrics.padding, 1);
  expect(metrics.horizontalOverflow).toBe(false);
  expect(metrics.emptyParagraphs).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("quote-preview-default.png"),
  });
});

test("有实际正文时引用后保留8px间距，而不是移除所有内容间隔", async ({
  page,
}) => {
  const { message } = await prepare(page, "这里有实际正文。");
  expect(
    await message.evaluate(
      (e) =>
        e.querySelector(":scope > p")!.getBoundingClientRect().top -
        e.querySelector(".text-quote-comment")!.getBoundingClientRect().bottom,
    ),
  ).toBeCloseTo(8, 1);
});

test("悬停全文可跨间隙阅读，不改变气泡高度；Escape关闭后主按钮仍跳原文", async ({
  page,
}, testInfo) => {
  const { message, quote, preview } = await prepare(page);
  const height = (await message.boundingBox())!.height;
  await quote.hover();
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("quote-preview-full.png"),
  });
  await expect(preview.locator(".sent-text-quote-preview-text")).toHaveText(
    quoteText,
  );
  await preview.hover();
  await page.waitForTimeout(220);
  await expect(preview).toBeVisible();
  expect((await message.boundingBox())!.height).toBeCloseTo(height, 1);
  await page.keyboard.press("Escape");
  await expect(preview).not.toBeVisible();
  await expect(quote).toBeFocused();
  await quote.click();
  await expect(
    page.locator('[data-input-id="quote-preview-source"]'),
  ).toHaveAttribute("data-quote-revealed", "true");
});

test("键盘focus显示全文，Tab可进入滚动面板，Escape关闭不跳原文", async ({
  page,
}) => {
  const { quote, preview } = await prepare(page);
  await quote.focus();
  await expect(preview).toBeVisible();
  await quote.hover();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(220);
  await expect(preview).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(preview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).not.toBeVisible();
  await expect(quote).toBeFocused();
});

test("窄窗200%缩放与reduced-motion下长全文仍在视口内且可滚动", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { message, quote, preview } = await prepare(
    page,
    "",
    "完整长引用。".repeat(4000),
  );
  await page.locator(".app").evaluate((e) => {
    (e as HTMLElement).style.zoom = "2";
  });
  await quote.scrollIntoViewIfNeeded();
  await quote.focus();
  await expect(preview).toBeVisible();
  const box = (await preview.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(700);
  expect(await preview.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(
    true,
  );
  expect(await message.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
    true,
  );
  await preview.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => preview.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath("quote-preview-narrow-200.png"),
  });
});

test.describe("触控引用全文", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 700 } });
  test("全文按钮不触发原文跳转，点击外部关闭", async ({ page }) => {
    const { message, preview } = await prepare(page);
    const full = message.getByRole("button", {
      name: "阅读引用 1 的全文",
      exact: true,
    });
    await expect(full).toBeVisible();
    await full.tap();
    await expect(preview).toBeVisible();
    await page.waitForTimeout(220);
    await expect(preview).toBeVisible();
    await expect(full).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.locator('[data-input-id="quote-preview-source"]'),
    ).not.toHaveAttribute("data-quote-revealed", "true");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "对话", exact: true })
      .tap();
    await expect(preview).not.toBeVisible();
  });
});
