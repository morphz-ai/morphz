import { expect } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

test("变化通知失效不冒充业务断线，草稿和可用发送保持，重同步继续读取", async ({
  page,
}) => {
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: { ...disconnectedRuntime, configured: true, connected: true },
  }));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  const draft = "TEST 通知通道断开时不丢失的未发送草稿";
  await input.fill(draft);
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  await expect(send).toBeEnabled();

  // A rejected notification frame runs the same channel onClosed path as a
  // transport disconnect. Authoritative RPCs and Runtime remain available.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("morphz:test-workspace-change", {
        detail: { kind: "workspace", invalid: true },
      }),
    ),
  );
  await expect(input).toHaveValue(draft);
  await expect(send).toBeEnabled();
  await expect(page.getByText("应用连接中断", { exact: true })).toHaveCount(0);
  await fixture.refresh();
  await expect(input).toHaveValue(draft);
  await expect(send).toBeEnabled();
});
