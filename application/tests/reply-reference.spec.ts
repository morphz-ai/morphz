import { expect, type Page } from "@playwright/test";
import {
  disconnectedRuntime,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function fixture(page: Page, sourceBody: string) {
  const inputs: PlatformHistory["inputs"] = [];
  const messages: ConversationRuntime["messages"] = [];
  const inspected: string[] = [];
  const presentation = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      messages,
    },
  }));
  inputs.push(
    presentation.input("source-a", sourceBody, "2026-10-01T00:00:00Z"),
    // Equal bodies must never make the source link resolve by text instead of ID.
    presentation.input("source-b", sourceBody, "2026-10-01T00:00:01Z"),
  );
  messages.push(
    {
      id: "reply-b",
      ...presentation.scope,
      inputId: "source-b",
      artifactId: null,
      kind: "reply",
      text: "TEST 相邻消息的回复",
      createdAt: "2026-10-01T00:00:02Z",
    },
    {
      id: "reply-a",
      ...presentation.scope,
      inputId: "source-a",
      artifactId: null,
      kind: "reply",
      text: "TEST 迟到回复仍在自己的发布时间出现",
      createdAt: "2026-10-01T00:00:03Z",
    },
    {
      id: "reply-a-next",
      ...presentation.scope,
      inputId: "source-a",
      artifactId: null,
      kind: "reply",
      text: "TEST 同一来源的连续回复不重复引用",
      createdAt: "2026-10-01T00:00:04Z",
    },
  );
  await page.route("**/api/executions?*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("inputId");
    if (id) inspected.push(id);
    return route.fulfill({
      json: { jobs: [], approvals: [], limit: 100 },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(page.locator('[data-message-id="reply-a-next"]')).toBeVisible();
  const input = await openInput(page);
  await input.fill("TEST 来源引用点击后保留的未发送草稿");
  return { inspected, input };
}

test("迟到回复以原消息短引文表达来源，同文不同 ID 精确打开，不重排或重复引用", async ({
  page,
}) => {
  const { inspected, input } = await fixture(page, "困了");
  const reply = page.locator('[data-message-id="reply-a"]');
  const reference = reply.getByRole("button", {
    name: "回复：困了",
    exact: true,
  });
  await expect(reference).toHaveText("困了");
  await expect(reference.locator("svg")).toHaveCount(0);
  await expect(page.locator(".response-source")).toHaveCount(1);
  await expect(page.getByText("关于：", { exact: false })).toHaveCount(0);
  await expect(reply).toHaveAttribute("data-input-id", "source-a");
  const order = await page
    .locator(".conversation-message")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-message-id")),
    );
  expect(order).toEqual([
    "source-a",
    "source-b",
    "reply-b",
    "reply-a",
    "reply-a-next",
  ]);
  await reference.focus();
  await expect(reference).toBeFocused();
  await reference.press("Enter");
  await expect.poll(() => inspected).toContain("source-a");
  expect(inspected).not.toContain("source-b");
  await expect(input).toHaveValue("TEST 来源引用点击后保留的未发送草稿");
  expect(await page.locator(".human-message").count()).toBe(2);
});

test("来源引文单行截断而不撑宽消息，亮暗保留中性引用线及键盘入口", async ({
  page,
}) => {
  const body =
    "这是一条很长的原始消息，用于核验窄窗口下回复引用保持单行。\n".repeat(5);
  await fixture(page, body);
  // Preview the first 50 source characters, then flatten their whitespace;
  // normalizing the entire body first would change the source cutoff.
  const excerpt = body.slice(0, 50).replace(/\s+/g, " ").trim();
  const reference = page.getByRole("button", {
    name: "回复：" + excerpt,
    exact: true,
  });
  await expect(reference).toHaveText(excerpt);
  await expect(reference).toHaveAttribute("title", excerpt);
  await page.setViewportSize({ width: 760, height: 700 });
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
    await expect(reference).toBeVisible();
    await expect(reference).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(reference).toHaveCSS("border-left-width", "2px");
    await expect(reference).toHaveCSS("box-shadow", "none");
    const geometry = await reference.evaluate((element) => {
      const text = element.querySelector("span")!;
      const style = getComputedStyle(text);
      return {
        width: element.getBoundingClientRect().width,
        available: element.parentElement!.getBoundingClientRect().width,
        textHeight: text.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        overflow: style.textOverflow,
        nowrap: style.whiteSpace,
        truncated: text.scrollWidth > text.clientWidth,
      };
    });
    expect(geometry.width).toBeLessThanOrEqual(geometry.available);
    expect(geometry.textHeight).toBeLessThanOrEqual(geometry.lineHeight + 1);
    expect(geometry.overflow).toBe("ellipsis");
    expect(geometry.nowrap).toBe("nowrap");
    expect(geometry.truncated).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(760);
    await reference.focus();
    await expect(reference).toBeFocused();
  }
});
