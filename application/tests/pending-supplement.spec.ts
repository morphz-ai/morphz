import { expect } from "@playwright/test";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openExecutionPanel } from "./interaction-helpers.js";

test("待答线程明确显示等待你的输入，原补充按钮呼吸而不流转，失去新鲜状态不冒称当前待答", async ({
  page,
}) => {
  const threads: ExecutionActivity["threads"] = [];
  const inputs: ReturnType<
    Awaited<ReturnType<typeof mockPlatformConversation>>["input"]
  >[] = [];
  let available = true;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: { available, truncated: false, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  inputs.push(
    fixture.input("TEST-input-wait", "TEST 原始追问", "2026-10-25T06:00:00Z"),
  );
  threads.push({
    ...fixture.scope,
    id: "TEST-wait",
    kind: "execution",
    inputId: "TEST-input-wait",
    rootId: "TEST-root",
    sessionId: "TEST-session",
    contextId: "TEST-context",
    title: "TEST 待答线程",
    summary: "此前的执行进展",
    phase: "waiting",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: "2026-10-25T06:00:00Z",
    continuation: {
      mode: "supplement",
      inputId: "TEST-input-wait",
      threadId: "TEST-wait",
      generation: 1,
    },
    userInputRequest: {
      request_id: "TEST-request",
      thread_id: "TEST-wait",
      thread_generation: 1,
      session_id: "TEST-session",
      context_id: "TEST-context",
      requested_at: "2026-10-25T06:00:00Z",
      questions: [
        {
          id: "scope",
          question: "TEST：仅检查视觉吗？",
          options: [],
          multi_select: false,
        },
      ],
    },
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openExecutionPanel(page);
  const row = page.locator('[data-thread-id="TEST-wait"]');
  await expect(row.getByText("等待你的输入", { exact: true })).toBeVisible();
  await expect(row.getByText("此前的执行进展")).toHaveCount(0);
  const supplement = page
    .locator(".execution-activity-entry")
    .filter({ has: row })
    .getByRole("button", { name: "补充", exact: true });
  await expect(supplement).toHaveAttribute("data-attention-motion", "on");
  await expect(supplement.locator("svg")).toHaveCSS(
    "animation-name",
    "none",
  );
  expect(
    await supplement.evaluate(
      (button) => getComputedStyle(button, "::after").backgroundImage,
    ),
  ).toBe("none");
  await expect(page.locator(".composer-question")).toHaveCount(0);
  threads[0]!.controlState = "paused";
  await fixture.refresh();
  await expect(row.getByText("等待你的输入", { exact: true })).toHaveCount(0);
  threads[0]!.controlState = "active";
  await fixture.refresh();
  await expect(row.getByText("等待你的输入", { exact: true })).toBeVisible();
  available = false;
  await fixture.refresh();
  await expect(row.getByText("等待你的输入", { exact: true })).toHaveCount(0);
  await expect(supplement).toBeDisabled();
});
