import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openInput } from "./interaction-helpers.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";
import {
  isolatedCenterDirectory,
  seedAgentOriginal,
} from "./platform-agent-original-fixture.js";

const dialogue = (page: Page) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("对话常驻输入：失焦与 Escape 不隐藏，快捷键聚焦，其他工作页仍收起并保留草稿", async ({
  page,
}) => {
  await page.goto("/");
  await dialogue(page).click();
  const input = page.getByLabel("AI 输入内容");
  await expect(input).toBeVisible();
  await expect(page.getByLabel("收起 AI 输入框", { exact: true })).toHaveCount(
    0,
  );
  await input.fill("对话常驻验收：仅本机草稿");
  await page.getByRole("heading", { name: "对话", exact: true }).click();
  await expect(input).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(input).toBeVisible();
  await expect(input).not.toBeFocused();
  await page.getByRole("group", { name: "输入工具", exact: true }).hover();
  await expect(page.getByLabel("更多输入选项")).toHaveCount(0);
  await expect(page.getByLabel("固定输入框", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await openInput(page);
  await input.fill("工作台独立草稿");
  await page.getByLabel("收起 AI 输入框", { exact: true }).click();
  await expect(input).toHaveCount(0);
  await dialogue(page).click();
  await expect(input).toHaveValue("对话常驻验收：仅本机草稿");
  await page.reload();
  await expect(input).toHaveValue("对话常驻验收：仅本机草稿");
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = (await page.locator(".composer").boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(
      await page
        .locator(".composer")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await input.fill("增长测试。\n".repeat(18));
  expect((await input.boundingBox())!.height).toBeGreaterThan(60);
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await openInput(page);
  await expect(input).toHaveValue("工作台独立草稿");
});

test("日期分隔与回到最新独立于未读；新回复不抢旧消息阅读位置，表格在窄屏内部滚动", async ({
  page,
}) => {
  let fresh = false;
  const inputs: PlatformHistory["inputs"] = [];
  const presentation = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      model: "dialogue-fixture-model",
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "completed" as const,
        error: null,
        retryable: false,
      })),
      messages: [
        ...inputs.map((input, i) => ({
          id: `dialogue-reply-${i}`,
          ...presentation.scope,
          inputId: input.id,
          rootId: null,
          artifactId: null,
          kind: "reply" as const,
          createdAt: new Date(
            new Date(input.createdAt).getTime() + 1000,
          ).toISOString(),
          text:
            i === 23
              ? "截图里**「截图输入」挡住了 PDF**，这是实际格式。\n\n| 名称 | 状态 |\n| --- | --- |\n| " +
                "long-column-".repeat(35) +
                " | 完成 |"
              : `第 ${i} 轮回复。\n\n` +
                "这是一段用于验证长期阅读位置的合成正文。".repeat(8),
        })),
        ...(fresh
          ? [
              {
                id: "dialogue-fresh",
                ...presentation.scope,
                inputId: "dialogue-fixture-0",
                rootId: null,
                artifactId: null,
                kind: "reply" as const,
                createdAt: "2026-09-11T10:00:00Z",
                text: "较早工作的迟到交付，按发布时间追加。",
              },
            ]
          : []),
      ],
    },
  }));
  inputs.push(
    ...Array.from({ length: 24 }, (_, i) =>
      presentation.input(
        `dialogue-fixture-${i}`,
        `第 ${i} 轮问题`,
        new Date(Date.UTC(2026, 8, i < 12 ? 9 : 10, 10, i)).toISOString(),
      ),
    ),
  );
  await page.goto("/");
  await dialogue(page).click();
  const scroll = page.locator(".conversation");
  await expect(page.locator(".conversation-date")).toHaveCount(2);
  await expect(page.locator(".reply-content strong")).toHaveText(
    "「截图输入」挡住了 PDF",
  );
  await expect(
    page.getByRole("button", { name: "返回最新", exact: true }),
  ).toHaveCount(0);
  const initialHeight = await scroll.evaluate((el) => el.scrollHeight);
  await scroll.evaluate((el) => {
    el.scrollTop = 240;
  });
  await expect(
    page.getByRole("button", { name: "返回最新", exact: true }),
  ).toBeVisible();
  const top = await scroll.evaluate((el) => el.scrollTop);
  expect(await scroll.evaluate((el) => el.scrollHeight)).toBe(initialHeight);
  // Showing or hiding the return control must not become part of the log height.
  expect(
    await page
      .locator(".conversation-return")
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(0);
  fresh = true;
  await presentation.refresh();
  await expect(page.locator('[data-message-id="dialogue-fresh"]')).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: "有新内容 · 返回最新", exact: true }),
  ).toBeVisible();
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(top);
  const updatedHeight = await scroll.evaluate((el) => el.scrollHeight);
  await page
    .getByRole("button", { name: "有新内容 · 返回最新", exact: true })
    .click();
  await expect(page.locator(".new-exchange")).toHaveCount(0);
  expect(await scroll.evaluate((el) => el.scrollHeight)).toBe(updatedHeight);
  await expect(page.locator(".conversation-date")).toHaveCount(3);
  await expect(page.locator(".conversation-message").last()).toHaveAttribute(
    "data-message-id",
    "dialogue-fresh",
  );
  for (const appearance of ["light", "dark"]) {
    await page.locator(".app").evaluate((el, value) => {
      // Match the real preference effect at both token roots.
      el.setAttribute("data-appearance", value);
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await page.setViewportSize({ width: 760, height: 540 });
    await expect(page.getByLabel("AI 输入内容")).toBeVisible();
    const table = page.getByRole("region", { name: "表格", exact: true });
    expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      true,
    );
    await table.focus();
    await table.press("ArrowRight");
    await expect
      .poll(() => table.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
    const overflow = await scroll.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return {
        width: el.clientWidth,
        scroll: el.scrollWidth,
        outside: [...el.querySelectorAll("*")]
          .filter(
            (child) =>
              child.getBoundingClientRect().right > right + 1 &&
              !child.closest(".markdown-table-scroll"),
          )
          .map((child) => ({
            tag: child.tagName,
            class: child.className,
            right: child.getBoundingClientRect().right,
          })),
      };
    });
    expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(
      overflow.width,
    );
    await page.screenshot({
      path: `test-results/dialogue-${appearance}-760.png`,
      animations: "disabled",
    });
  }
});

test("历史引用显示并打开当时标题与版本，Platform 交付回执也保持准确版本", async ({
  page,
}) => {
  const inputs: PlatformHistory["inputs"] = [];
  const presentation = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      model: "historical-reference-fixture",
    },
  }));
  const inputId = `historical_${randomUUID()}`;
  // Real app versions and Platform delivery receipt; only Runtime history is
  // controlled presentation data, not a claim of model dispatch.
  const objectId = await seedAgentOriginal(
    isolatedCenterDirectory(),
    presentation.spaces.deskId,
    "历史引用第一版",
    "当时讨论的正文",
    inputId,
  );
  const contents = await presentation.client.content({
    projectId: presentation.spaces.deskId,
    appId: "morphz.objects",
    appObjectIds: [objectId],
  });
  expect(contents.items).toHaveLength(1);
  const artifactId = contents.items[0]!.id;
  inputs.push({
    ...presentation.input(
      inputId,
      "请查看这个旧版本",
      new Date().toISOString(),
    ),
    artifactId,
    artifactRevision: 1,
    selection: "当时讨论的正文",
  });
  await presentation.client.reviseDocument({
    commandId: randomUUID(),
    contentId: artifactId,
    expectedRevision: 1,
    title: "更新后的第二版标题",
    markdown: "已经更新的正文",
  });
  expect(await presentation.client.contentDeliveries([inputId])).toEqual([
    expect.objectContaining({
      inputId,
      contentId: artifactId,
      // Catalog metadata is current; the historical title below must be
      // resolved from the owning app's exact version, not this catalog label.
      title: "更新后的第二版标题",
      versionRef: "1",
    }),
  ]);
  const originalReads: string[] = [];
  const titleReads: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/platform/objects/${artifactId}`)
      originalReads.push(request.url());
    if (path === `/api/platform/objects/${artifactId}/versions`)
      titleReads.push(request.url());
  });
  await page.goto("/");
  await dialogue(page).click();
  const historicalLink = page.getByRole("button", {
    name: "历史引用第一版 · v1",
    exact: true,
  });
  await expect(historicalLink).toBeVisible();
  expect(originalReads).toHaveLength(0);
  expect(titleReads.length).toBeGreaterThan(0);
  const titlesBeforeRefresh = titleReads.length;
  await presentation.refresh();
  await expect(historicalLink).toBeVisible();
  expect(originalReads).toHaveLength(0);
  expect(titleReads).toHaveLength(titlesBeforeRefresh);
  await historicalLink.click();
  await expect(page.getByLabel("查看版本")).toHaveValue("1");
  await expect(page.locator(".object-paper")).toContainText("当时讨论的正文");
  await expect(page.locator(".object-paper > h1")).toHaveText("历史引用第一版");
  await dialogue(page).click();
  await expect(page.getByLabel("打开交付：历史引用第一版")).toContainText(
    "交付内容",
  );
  await page.getByLabel("打开交付：历史引用第一版").click();
  await expect(page.getByLabel("查看版本")).toHaveValue("1");
  await expect(page.locator(".object-paper")).toContainText("当时讨论的正文");
});
