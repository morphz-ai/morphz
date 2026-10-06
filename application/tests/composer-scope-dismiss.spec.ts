import { expect } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput, settleTransitions } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

// Real isolated HTTP Host and production UI; only Runtime presentation is
// controlled. These actions must remain local, with no message or task dispatch.
for (const appearance of ["亮色", "暗色"])
  for (const view of [
    { width: 1440, zoom: 1 },
    { width: 760, zoom: 1 },
    { width: 390, zoom: 1 },
    { width: 320, zoom: 1 },
    { width: 1440, zoom: 2 },
  ])
    test(`${appearance} ${view.width}px ${view.zoom * 100}%：一键取消意图保留草稿、底栏独立命中且不取消工作`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: view.width, height: 960 });
      await mockPlatformConversation(page, () => ({
        inputs: [],
        runtime: {
          ...disconnectedRuntime,
          configured: true,
          connected: false,
          error: "TEST 智能体暂不可用，原输入保留",
        },
      }));
      let sent = 0;
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith("/api/platform/messages")
        )
          sent++;
      });
      await page.goto("/");
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "对话", exact: true })
        .click();
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await page.keyboard.press("Escape");
      await settleTransitions(page);
      await page.locator(".app").evaluate((element, zoom) => {
        (element as HTMLElement).style.zoom = String(zoom);
      }, view.zoom);
      const input = await openInput(page);
      const body = "TEST 只取消输入意图，不发送，不丢弃编辑中的正文 😀";
      await input.fill(body);
      const scope = page.locator(".composer-scope-trigger");
      const remove = page.locator(".composer-scope-remove");
      await expect(remove).toHaveCount(0);
      const tools = (await page.locator(".composer-action-bar").boundingBox())!;
      for (const [label, application] of [
        ["起草文档", "内容库"],
        ["构思剧本", "剧本工作室"],
        ["新建事项", "事项"],
      ] as const) {
        await page
          .getByRole("button", { name: "新建或添加", exact: true })
          .click();
        await page
          .getByRole("group", { name: "新建与添加", exact: true })
          .getByRole("button", {
            name: `${label}，${application}`,
            exact: true,
          })
          .click();
        await expect(scope).toContainText(label);
        await expect(remove).toHaveAccessibleName(`取消${label}`);
        await expect(
          page.getByRole("group", { name: "本次输入关联", exact: true }),
        ).toHaveCount(0);
        const geometry = await page
          .locator(".composer-action-bar")
          .evaluate((row) => {
            const bounds = row.getBoundingClientRect();
            const buttons = [...row.querySelectorAll("button")].filter(
              (button) =>
                button.checkVisibility() && !button.closest("[popover]"),
            );
            return {
              bounds: {
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
                bottom: bounds.bottom,
              },
              buttons: buttons.map((button) => {
                const rect = button.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2,
                );
                return {
                  name: button.getAttribute("aria-label"),
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  width: rect.width,
                  height: rect.height,
                  hit: !!hit && button.contains(hit),
                  hitLabel: hit?.closest("button")?.getAttribute("aria-label"),
                };
              }),
            };
          });
        await info.attach(`scope-geometry-${label}`, {
          body: JSON.stringify(geometry),
          contentType: "application/json",
        });
        if (label === "起草文档")
          await page.screenshot({
            path: info.outputPath("scope-direct-dismiss.png"),
            animations: "disabled",
          });
        expect(
          geometry.buttons.find((button) => button.name === `取消${label}`),
        ).toBeTruthy();
        for (const button of geometry.buttons) {
          expect(button.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
            geometry.bounds.left - 1,
          );
          expect(button.right, JSON.stringify(geometry)).toBeLessThanOrEqual(
            geometry.bounds.right + 1,
          );
          expect(button.top).toBeGreaterThanOrEqual(geometry.bounds.top - 1);
          expect(button.bottom).toBeLessThanOrEqual(geometry.bounds.bottom + 1);
          expect(button.width).toBeGreaterThanOrEqual(32 * view.zoom - 1);
          expect(button.height).toBeGreaterThanOrEqual(32 * view.zoom - 1);
          expect(
            button.hit,
            `${button.name} must have its own actual hit target`,
          ).toBe(true);
        }
        expect(
          Math.abs(
            (await page.locator(".composer-action-bar").boundingBox())!.height -
              tools.height,
          ),
        ).toBeLessThanOrEqual(1);
        await remove.click();
        await expect(remove).toHaveCount(0);
        await expect(input).toHaveValue(body);
        await expect(input).toBeFocused();
        await expect(page.locator(".composer-scope-label")).toHaveCount(0);
      }
      expect(sent).toBe(0);
    });
