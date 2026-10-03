import { test, expect } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";

test("长对话先读最近消息，旧消息按需加载且保持阅读位置", async ({ page }) => {
  let principalId = "local-owner";
  let actantId = "local-human";
  let catalogBump = 0;
  let earlierAccessRemoved = false;
  const requests: string[] = [];
  await page.route("**/api/platform/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    principalId = body.principalId;
    actantId = body.actantId;
    await route.fulfill({ response, json: body });
  });
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          catalogVersion: body.catalogVersion + catalogBump,
          historyVersion: "a".repeat(64),
          runtime: { ...body.runtime, configured: true },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const match = url.pathname.match(
        /\/projects\/([^/]+)\/conversations\/([^/]+)\/history$/,
      );
      if (!match) throw new Error("Expected a Platform history request");
      const inputs = Array.from({ length: 120 }, (_, index) => ({
        id: `history-${index.toString().padStart(3, "0")}`,
        projectId: match[1]!,
        conversationId: match[2]!,
        author: { principalId, actantId },
        targetActantId: "morphz-agent",
        body: `历史输入 ${index.toString().padStart(3, "0")}`,
        createdAt: new Date(Date.UTC(2026, 8, 28) + index * 1000).toISOString(),
        ...(index === 119
          ? {
              textQuotes: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  source: {
                    kind: "message",
                    projectId: match[1]!,
                    conversationId: match[2]!,
                    title: "对话",
                    messageId: "history-000",
                    inputId: "history-000",
                    createdAt: new Date(Date.UTC(2026, 8, 28)).toISOString(),
                  },
                  text: "历史输入 000",
                  comment: "",
                },
              ],
            }
          : {}),
      }));
      const beforeCreatedAt = url.searchParams.get("beforeCreatedAt");
      const beforeId = url.searchParams.get("beforeId");
      const eligible = (
        earlierAccessRemoved ? inputs.slice(-20) : inputs
      ).filter(
        (input) =>
          !beforeCreatedAt ||
          input.createdAt < beforeCreatedAt ||
          (input.createdAt === beforeCreatedAt && input.id < beforeId!),
      );
      const items = eligible.slice(-100);
      await route.fulfill({
        json: {
          inputs: items,
          nextCursor:
            eligible.length > items.length
              ? { createdAt: items[0]!.createdAt, id: items[0]!.id }
              : null,
          runtime: { ...disconnectedRuntime, configured: true },
        },
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const conversation = page.locator(".conversation");
  await expect(conversation.getByText("历史输入 119")).toBeVisible();
  await expect(
    conversation.locator('[data-message-id="history-000"]'),
  ).toHaveCount(0);
  await conversation.getByRole("button", { name: "查看引用 1 的原文" }).click();
  await expect(
    conversation.locator(
      '[data-message-id="history-000"][data-quote-revealed="true"]',
    ),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(
    conversation.locator('[data-message-id="history-000"]'),
  ).toHaveCount(0);
  const olderButton = conversation.getByRole("button", {
    name: "查看更早消息",
  });
  await olderButton.scrollIntoViewIfNeeded();
  const anchor = conversation.getByText("历史输入 020");
  const beforeTop = await anchor.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  await olderButton.click();
  await expect(
    conversation.locator('[data-message-id="history-000"]'),
  ).toBeVisible();
  const afterTop = await anchor.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  expect(Math.abs(afterTop - beforeTop)).toBeLessThan(3);
  await expect(
    conversation.getByRole("button", { name: "查看更早消息" }),
  ).toHaveCount(0);
  expect(requests.some((request) => request.includes("beforeCreatedAt"))).toBe(
    true,
  );
  earlierAccessRemoved = true;
  catalogBump++;
  // This access change belongs to the synthetic response, not the real Host.
  // Use its existing foreground reconciliation instead of inventing polling.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    conversation.locator('[data-message-id="history-000"]'),
  ).toHaveCount(0, { timeout: 12_000 });
  await expect(
    conversation.getByRole("button", { name: "查看更早消息" }),
  ).toHaveCount(0);
});

test("翻页跳过不可见窗口后显示更早的可见消息", async ({ page }) => {
  let principalId = "local-owner";
  let actantId = "local-human";
  const beforeIds: string[] = [];
  await page.route("**/api/platform/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    principalId = body.principalId;
    actantId = body.actantId;
    await route.fulfill({ response, json: body });
  });
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          historyVersion: "a".repeat(64),
          runtime: { ...body.runtime, configured: true },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const match = url.pathname.match(
        /\/projects\/([^/]+)\/conversations\/([^/]+)\/history$/,
      );
      if (!match) throw new Error("Expected a Platform history request");
      const beforeId = url.searchParams.get("beforeId") ?? "";
      beforeIds.push(beforeId);
      const input = (id: string, body: string, createdAt: string) => ({
        id,
        projectId: match[1]!,
        conversationId: match[2]!,
        author: { principalId, actantId },
        targetActantId: "morphz-agent",
        body,
        createdAt,
      });
      await route.fulfill({
        json: {
          inputs:
            beforeId === ""
              ? [input("current", "当前消息", "2026-09-28T00:00:03.000Z")]
              : beforeId === "hidden-b"
                ? [input("older", "更早消息", "2026-09-28T00:00:00.000Z")]
                : [],
          nextCursor:
            beforeId === ""
              ? { createdAt: "2026-09-28T00:00:02.000Z", id: "hidden-a" }
              : beforeId === "hidden-a"
                ? { createdAt: "2026-09-28T00:00:01.000Z", id: "hidden-b" }
                : null,
          runtime: { ...disconnectedRuntime, configured: true },
        },
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const conversation = page.locator(".conversation");
  await expect(conversation.getByText("当前消息")).toBeVisible();
  await conversation.getByRole("button", { name: "查看更早消息" }).click();
  await expect(conversation.getByText("更早消息")).toBeVisible();
  expect(beforeIds).toEqual(["", "hidden-a", "hidden-b"]);
});
