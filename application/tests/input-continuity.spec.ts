import { expect } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  test,
  mockPlatformConversation,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

// Actual App/Client/React and DOM, controlled transport only. The separate
// runtime-input-history-handoff test exercises the real Host acceptance race.
for (const success of [true, false])
  test(`发送中的消息从首次显示到${success ? "正式历史" : "发送失败"}始终保留同一气泡`, async ({
    page,
  }) => {
    const body = `TEST continuous bubble ${success ? "accepted" : "failed"}`;
    let inputs: PlatformHistory["inputs"] = [];
    let runtime = { ...disconnectedRuntime, configured: true, connected: true };
    const fixture = await mockPlatformConversation(page, () => ({
      inputs,
      runtime,
    }));
    let release!: () => void;
    const ack = new Promise<void>((done) => {
      release = done;
    });
    let command: { commandId: string; operation: { body: string } } | undefined;
    let createdAt = "";
    await page.route("**/api/platform/messages", async (route) => {
      command = route.request().postDataJSON();
      createdAt = await page.evaluate((id) => {
        const key = Object.keys(localStorage).find((key) =>
          key.endsWith(":saved-input:" + id),
        );
        return key ? JSON.parse(localStorage.getItem(key)!).createdAt : "";
      }, command!.commandId);
      await ack;
      await route.fulfill(
        success
          ? {
              status: 202,
              json: {
                commandId: command!.commandId,
                entityId: command!.commandId,
              },
            }
          : {
              status: 400,
              json: {
                message: "TEST controlled submission failure",
                code: "test_send_failed",
              },
            },
      );
    });
    await page.addInitScript((body) => {
      let first: Element | undefined;
      const observations: Array<{ count: number; same: boolean }> = [];
      const sample = () => {
        const bubbles = [...document.querySelectorAll(".human-message")].filter(
          (node) => node.textContent?.includes(body),
        );
        first ??= bubbles[0];
        if (first)
          observations.push({
            count: bubbles.length,
            same: bubbles[0] === first,
          });
      };
      new MutationObserver(sample).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      Reflect.set(window, "inputContinuityObservations", observations);
    }, body);
    try {
      await page.goto("/");
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "对话", exact: true })
        .click();
      const editor = await openInput(page);
      await editor.fill(body);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const bubble = page.locator(".human-message").filter({ hasText: body });
      await expect(bubble).toHaveAttribute("data-submission-state", "sending");
      await expect.poll(() => command).toBeDefined();
      await expect(editor).toHaveValue("");
      await editor.fill("TEST following draft must remain");
      await fixture.refresh();
      await expect(bubble).toHaveAttribute("data-submission-state", "sending");
      release();

      if (success) {
        // ACK is not a history row: keep the local accepted projection while
        // the history endpoint still returns the pre-submit window.
        await expect(bubble).toHaveAttribute(
          "data-submission-state",
          "accepted",
        );
        inputs = [fixture.input(command!.commandId, body, createdAt)];
        runtime = {
          ...runtime,
          deliveries: [
            {
              inputId: command!.commandId,
              state: "queued",
              error: null,
              retryable: false,
              cancelRequested: false,
              cancellable: false,
            },
          ],
        };
        await fixture.refresh();
        await expect(bubble).not.toHaveAttribute("data-submission-state");
        await expect
          .poll(() =>
            page.evaluate(
              (id) =>
                Object.keys(localStorage).some((key) =>
                  key.endsWith(":saved-input:" + id),
                ),
              command!.commandId,
            ),
          )
          .toBe(false);
        runtime = {
          ...runtime,
          deliveries: [{ ...runtime.deliveries[0]!, state: "running" }],
        };
        await fixture.refresh();
      } else {
        await expect(bubble).toHaveAttribute("data-submission-state", "failed");
        await expect(
          bubble.getByRole("button", { name: "重新发送消息" }),
        ).toHaveAttribute("title", /TEST controlled submission failure/);
        await fixture.refresh();
        await expect(bubble).toHaveAttribute("data-submission-state", "failed");
      }
      await expect(bubble).toHaveCount(1);
      await expect(editor).toHaveValue("TEST following draft must remain");
      const observations = await page.evaluate(
        () =>
          Reflect.get(window, "inputContinuityObservations") as Array<{
            count: number;
            same: boolean;
          }>,
      );
      expect(observations.length).toBeGreaterThan(2);
      expect(
        observations.every((sample) => sample.count === 1 && sample.same),
      ).toBe(true);
    } finally {
      release();
    }
  });
