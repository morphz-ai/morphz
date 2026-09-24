import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openInput } from "./interaction-helpers.js";
import type { Command } from "../packages/core/src/model.js";
import type { Boot } from "../apps/web/src/client.js";

const dialogue = (page: Page) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true });

async function command(page: Page, operation: Command["operation"]) {
  const boot: Boot = await (await page.request.get("/api/workspace")).json();
  const response = await page.request.post("/api/commands", {
    headers: {
      "X-Morphz-Token": boot.csrfToken,
      Origin: "http://127.0.0.1:65421",
    },
    data: { commandId: randomUUID(), operation },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).entityId as string;
}

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
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot: Boot = await response.json();
    const projectId = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    )!.id;
    boot.workspace.inputs = Array.from({ length: 24 }, (_, i) => ({
      id: `dialogue-fixture-${i}`,
      projectId,
      conversationId: projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: `第 ${i} 轮问题`,
      author: { actantId: boot.actantId, principalId: "local-owner" },
      targetActantId: "morphz-agent",
      status: "recorded",
      createdAt: new Date(
        Date.UTC(2026, 8, i < 12 ? 9 : 10, 10, i),
      ).toISOString(),
    }));
    boot.runtime.messages = boot.workspace.inputs.map((input, i) => ({
      id: `dialogue-reply-${i}`,
      projectId,
      conversationId: projectId,
      inputId: input.id,
      rootId: null,
      artifactId: null,
      kind: "reply",
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
    }));
    boot.runtime.deliveries = boot.workspace.inputs.map((input) => ({
      inputId: input.id,
      state: "completed",
      error: null,
      retryable: false,
    }));
    boot.outputs = [];
    if (fresh)
      boot.runtime.messages.push({
        id: "dialogue-fresh",
        projectId,
        conversationId: projectId,
        inputId: "dialogue-fixture-0",
        rootId: null,
        artifactId: null,
        kind: "reply",
        createdAt: "2026-09-11T10:00:00Z",
        text: "较早工作的迟到交付，按发布时间追加。",
      });
    await route.fulfill({ response, json: boot });
  });
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

test("历史引用显示并打开当时标题与版本，真实交付也保持准确版本", async ({
  page,
}) => {
  await page.goto("/");
  const boot: Boot = await (await page.request.get("/api/workspace")).json();
  const projectId = boot.workspace.projects.find((p) => p.kind === "desk")!.id;
  const artifactId = await command(page, {
    type: "create-artifact",
    projectId,
    title: "历史引用第一版",
    content: { kind: "document", markdown: "当时讨论的正文" },
  });
  const inputId = await command(page, {
    type: "record-input",
    projectId,
    artifactId,
    artifactRevision: 1,
    selection: "当时讨论的正文",
    body: "请查看这个旧版本",
    targetActantId: "morphz-agent",
  });
  await command(page, {
    type: "revise-artifact",
    artifactId,
    expectedRevision: 1,
    title: "更新后的第二版标题",
    content: { kind: "document", markdown: "已经更新的正文" },
  });
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const current: Boot = await response.json();
    current.outputs = [
      {
        commandId: "historical-delivery",
        inputId,
        projectId,
        artifactId,
        revision: 1,
        createdAt: new Date().toISOString(),
      },
    ];
    await route.fulfill({ response, json: current });
  });
  await dialogue(page).click();
  await page
    .getByRole("button", { name: "历史引用第一版 · v1", exact: true })
    .click();
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
