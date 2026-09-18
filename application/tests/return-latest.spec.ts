import { test, expect, type Page } from "@playwright/test";
import type { Boot } from "../apps/web/src/client.js";
import { openInput, composerAction } from "./interaction-helpers.js";

const draft = "TEST 返回最新后仍能继续输入，不发送";

async function longHistory(page: Page, view = "事项") {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot: Boot = await response.json();
    const projectId = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    )!.id;
    boot.workspace.inputs = Array.from({ length: 24 }, (_, i) => ({
      id: `latest-input-${i}`,
      projectId,
      conversationId: projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body:
        `第 ${i} 条历史消息。` +
        "用于验证未固定工作页面的按钮、焦点与滚动。".repeat(12),
      author: { actantId: boot.actantId, principalId: "local-owner" },
      targetActantId: "morphz-agent",
      status: "recorded",
      createdAt: new Date(Date.UTC(2026, 8, 15, 10, i)).toISOString(),
    }));
    boot.runtime.messages = [];
    boot.runtime.deliveries = [];
    boot.outputs = [];
    await route.fulfill({ response, json: boot });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: new RegExp(`^${view}`) })
    .click();
  const input = await openInput(page);
  await input.fill(draft);
  await expect(page.locator(".conversation .human-message")).toHaveCount(24);
  return input;
}

const latest = (page: Page) => page.getByRole("button", { name: /返回最新/ });
async function scrollBack(page: Page, fraction = 0.5) {
  await page.locator(".conversation").evaluate((el, fraction) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction;
  }, fraction);
  await expect(latest(page)).toBeVisible();
}

for (const mode of ["recent", "history"])
  for (const action of ["mouse", "Enter", "Space"]) {
    test(`未固定事项页 ${mode}：${action} 返回最新不收起输入或丢草稿`, async ({
      page,
    }) => {
      const input = await longHistory(page);
      if (mode === "history") await composerAction(page, "展开完整记录");
      await expect(
        page.getByLabel("固定输入框", { exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      await scrollBack(page);
      if (action === "mouse") await latest(page).click();
      else {
        await latest(page).focus();
        await page.keyboard.press(action);
      }
      // Do not reopen/refocus here: that would conceal the actual regression.
      await expect(input).toBeVisible();
      await expect(input).toHaveValue(draft);
      await expect(input).toBeFocused();
      await expect(latest(page)).toHaveCount(0);
      await expect(page.locator(".primary-panel")).toHaveAttribute(
        "data-interaction",
        mode,
      );
      await expect
        .poll(() =>
          page
            .locator(".conversation")
            .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
        )
        .toBeLessThanOrEqual(1);
      await page.keyboard.type(" 继续");
      await expect(input).toHaveValue(draft + " 继续");
      // Preserve real leave-to-collapse; don't fix the bug by disabling it.
      await page.getByRole("heading", { name: "事项", exact: true }).click();
      await expect(input).toHaveCount(0);
      await openInput(page);
      await expect(input).toHaveValue(draft + " 继续");
    });
  }

test("返回最新贴合可见阅读区底部，宽窄窗与换行 Dock 不重叠也不增加滚动高度", async ({
  page,
}) => {
  const input = await longHistory(page);
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await input.fill(
      width < 400 ? draft + "\n继续写长草稿。".repeat(12) : draft,
    );
    for (const mode of ["recent", "history"]) {
      if (mode === "history") await composerAction(page, "展开完整记录");
      const scroll = page.locator(".conversation");
      const height = await scroll.evaluate((el) => el.scrollHeight);
      for (const fraction of [0, 0.5, 0.9]) {
        await scrollBack(page, fraction);
        await expect(async () => {
          const button = (await latest(page).boundingBox())!;
          const dock = (await page
            .locator(".composer-floating-tools")
            .boundingBox())!;
          const reading = (await scroll.boundingBox())!;
          const gap = dock.y - button.y - button.height;
          expect(
            gap,
            `${width}/${mode}: avoid double bottom clearance`,
          ).toBeGreaterThanOrEqual(4);
          expect(
            gap,
            `${width}/${mode}: anchor beside input, not mid-message`,
          ).toBeLessThanOrEqual(12);
          expect(button.y).toBeGreaterThanOrEqual(reading.y);
          expect(button.x).toBeGreaterThanOrEqual(reading.x);
          expect(button.x + button.width).toBeLessThanOrEqual(
            reading.x + reading.width,
          );
          expect(await scroll.evaluate((el) => el.scrollHeight)).toBe(height);
        }).toPass({ timeout: 1500 });
      }
      await latest(page).click();
      await expect(input).toBeVisible();
      expect(await scroll.evaluate((el) => el.scrollHeight)).toBe(height);
      if (mode === "history") await composerAction(page, "返回工作内容");
    }
  }
});

test("按钮聚焦后滚轮已到最新也不误收起；输入和复制按钮不被抢焦点", async ({
  page,
}) => {
  const input = await longHistory(page);
  const scroll = page.locator(".conversation");
  await scrollBack(page);
  await latest(page).focus();
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(input).toBeFocused();
  await expect(latest(page)).toHaveCount(0);
  await scrollBack(page);
  await input.focus();
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(input).toBeFocused();
  const copy = scroll
    .getByRole("button", { name: "复制消息", exact: true })
    .last();
  await copy.focus();
  await scrollBack(page);
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(copy).toBeFocused();
  await expect(input).toHaveValue(draft);
});

test("未固定消息复制的正常与兼容路径保留输入和按钮焦点", async ({ page }) => {
  const input = await longHistory(page);
  for (const fallback of [false, true]) {
    await page.evaluate((fallback) => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: fallback
          ? () => Promise.reject(new Error("TEST 使用原生复制兼容路径"))
          : () => Promise.resolve(),
      });
    }, fallback);
    const copy = page
      .locator(".conversation .human-message")
      .last()
      .locator(".message-copy");
    // This optional action is revealed by hovering its message first.
    const message = page.locator(".conversation .human-message").last();
    const box = (await message.boundingBox())!;
    await message.hover({ position: { x: box.width - 8, y: box.height - 8 } });
    await expect(message.locator(".message-peek")).toHaveCSS("opacity", "1");
    await copy.click();
    await expect(copy).toHaveAccessibleName("已复制消息");
    await expect(copy).toBeFocused();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(draft);
  }
});
