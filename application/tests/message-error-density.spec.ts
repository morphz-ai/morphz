import { expect } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test("失败只显示一次：气泡不堆状态和废话，中文说明与可展开原始诊断分层", async ({
  page,
}) => {
  const inputs: PlatformHistory["inputs"] = [];
  const messages: PlatformHistory["runtime"]["messages"] = [];
  const sends: Array<{
    commandId: string;
    operation: Record<string, unknown>;
  }> = [];
  await page.route("**/api/platform/messages", async (route) => {
    const request = route.request().postDataJSON();
    sends.push(request);
    await route.fulfill({
      json: { commandId: request.commandId, entityId: request.commandId },
    });
  });
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "failed" as const,
        error: "Morphz 执行失败，请查看错误信息。",
        retryable: false,
      })),
      messages,
    },
  }));
  const input = fixture.input(
    "failed-density",
    "这是合成失败消息：请解释这一段的含义。",
    "2026-10-18T14:19:00Z",
  );
  input.artifactId = "synthetic-reader-book";
  input.artifactRevision = 1;
  input.reading = {
    book: {
      title: "TEST 合成读物",
      author: "合成作者",
      edition: "",
      format: "epub",
    },
    chapter: "卷004",
    location: {
      sourceId: "synthetic-reader-book@1",
      sectionId: "section-4",
      start: 0,
      end: 0,
    },
  };
  inputs.push(input);
  for (const [id, phase, text] of [
    ["diagnostic", "diagnostic", "Unescaped JSON control character"],
    [
      "terminal",
      "terminal",
      "The model returned invalid response-annotation control syntax.",
    ],
  ] as const)
    messages.push({
      id,
      ...fixture.scope,
      artifactId: input.artifactId,
      inputId: input.id,
      rootId: "root",
      threadId: "thread",
      createdAt: "2026-10-18T14:20:00Z",
      kind: "error",
      text,
      failure: {
        kind: "response_protocol",
        phase,
        state: "response_annotations",
        attemptId: "attempt",
      },
    });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const human = page.locator('.human-message[data-input-id="failed-density"]');
  await expect(human.locator(":scope > p")).toHaveText(input.body);
  await expect(human.locator(".delivery-error")).toHaveCount(0);
  await expect(human).not.toContainText("执行失败");
  const resend = human.getByRole("button", {
    name: "重新发送原消息",
    exact: true,
  });
  await expect(resend).toBeVisible();
  expect(sends).toHaveLength(0);
  const error = page.locator(".runtime-message-error");
  await expect(error).toHaveCount(1);
  await expect(error.locator(":scope > p")).toHaveText(
    "回复格式解析失败，未能显示本次回答。",
  );
  await expect(error.locator("pre")).toBeHidden();
  await error.getByText("错误详情", { exact: true }).click();
  await expect(error.locator("pre")).toContainText(
    "Unescaped JSON control character",
  );
  await expect(error.locator("pre")).toContainText("The model returned");
  await error.getByText("错误详情", { exact: true }).click();
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 960 });
    const geometry = await human.evaluate((node) => {
      const body = node.querySelector(":scope > p")!.getBoundingClientRect(),
        resource = node
          .querySelector(".message-resources")!
          .getBoundingClientRect(),
        bubble = node.getBoundingClientRect();
      return {
        gap: resource.top - body.bottom,
        before: body.top - bubble.top,
        after: bubble.bottom - resource.bottom,
        font: getComputedStyle(node.querySelector(".message-object-link")!)
          .fontSize,
      };
    });
    expect(geometry.gap).toBeLessThanOrEqual(8);
    expect(geometry.before).toBeLessThanOrEqual(11);
    expect(geometry.after).toBeLessThanOrEqual(11);
    expect(geometry.font).toBe("12px");
  }
  const evidence = process.env.MORPHZ_TEST_READER_PAGES_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.screenshot({
      path: resolve(evidence, "message-error.png"),
      fullPage: false,
      animations: "disabled",
    });
  }
  await resend.click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]!.commandId).not.toBe(input.id);
  expect(sends[0]!.operation).toMatchObject({
    type: "record-input",
    body: input.body,
    artifactId: input.artifactId,
    artifactRevision: input.artifactRevision,
    reading: input.reading,
  });
});
