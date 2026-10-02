import { expect, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { Operation } from "../packages/core/src/model.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

type Command = {
  commandId: string;
  operation: Extract<Operation, { type: "record-input" }>;
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function setup(page: Page) {
  const inputs: PlatformHistory["inputs"] = [];
  const runtime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    model: "fixture-model",
  };
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime,
  }));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  return {
    input: await openInput(page),
    fixture,
    confirm(command: Command) {
      inputs.push({
        ...fixture.input(
          command.commandId,
          command.operation.body,
          new Date().toISOString(),
        ),
        projectId: command.operation.projectId,
        conversationId:
          command.operation.conversationId ?? fixture.scope.conversationId,
        ...(command.operation.selection
          ? { selection: command.operation.selection }
          : {}),
      });
      runtime.deliveries.push({
        inputId: command.commandId,
        state: "queued",
        error: null,
        retryable: false,
      });
    },
  };
}

test("点击发送立即显示同 ID 气泡并继续编辑，不等待提交或目录刷新", async ({
  page,
}) => {
  const session = await setup(page);
  const pending = gate();
  let command: Command | undefined;
  await page.route("**/api/platform/messages", async (route) => {
    command = route.request().postDataJSON();
    await pending.promise;
    session.confirm(command!);
    await route.fulfill({
      status: 202,
      json: { commandId: command!.commandId, entityId: command!.commandId },
    });
  });
  try {
    await session.input.fill("TEST 不等服务端先显示");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const bubble = page
      .locator(".human-message")
      .filter({ hasText: "TEST 不等服务端先显示" });
    await expect(bubble).toBeVisible({ timeout: 1000 });
    await expect(bubble).toHaveAttribute("data-submission-state", "sending");
    await expect(session.input).toHaveValue("");
    await expect(session.input).toBeEnabled();
    await session.input.fill("TEST 后来输入的草稿不能被回执清空");
    await session.fixture.refresh();
    await expect(bubble).toBeVisible();
    await expect.poll(() => command).toBeDefined();
    const id = command!.commandId;
    pending.release();
    await expect(bubble).not.toHaveAttribute(
      "data-submission-state",
      "sending",
    );
    await expect(page.locator(`[data-message-id="${id}"]`)).toHaveCount(1);
    await expect(bubble).not.toHaveAttribute(
      "data-submission-state",
      "accepted",
    );
    await expect(session.input).toHaveValue(
      "TEST 后来输入的草稿不能被回执清空",
    );
  } finally {
    pending.release();
  }
});

test("发送失败只在原气泡提供重试图标，重开后仍用原 ID 和载荷", async ({
  page,
}) => {
  const session = await setup(page);
  const commands: Command[] = [];
  let fail = true;
  await page.route("**/api/platform/messages", async (route) => {
    const command: Command = route.request().postDataJSON();
    commands.push(command);
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: "TEST 暂时无法提交" },
      });
    session.confirm(command);
    await route.fulfill({
      status: 202,
      json: { commandId: command.commandId, entityId: command.commandId },
    });
  });
  await session.input.fill("TEST 失败消息不能丢失");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const bubble = page
    .locator(".human-message")
    .filter({ hasText: "TEST 失败消息不能丢失" });
  await expect(
    bubble.getByRole("button", { name: "重新发送消息" }),
  ).toBeVisible();
  await expect(bubble.locator(".delivery-error")).toHaveCount(0);
  const original = commands[0]!;
  await page.reload();
  await expect(
    bubble.getByRole("button", { name: "重新发送消息" }),
  ).toBeVisible();
  expect(commands).toHaveLength(1); // No silent resend on restart.
  const input = await openInput(page);
  await input.fill("TEST 重新写的内容不参与原消息重试");
  fail = false;
  await bubble.getByRole("button", { name: "重新发送消息" }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(original);
  await expect(
    page.locator(`[data-message-id="${original.commandId}"]`),
  ).toHaveCount(1);
  await expect(
    bubble.getByRole("button", { name: "重新发送消息" }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("TEST 重新写的内容不参与原消息重试");
});

test("连续两条发送独立处理，迟到失败不阻塞后一条也不清空新草稿", async ({
  page,
}) => {
  const session = await setup(page);
  const pending = gate();
  const commands: Command[] = [];
  await page.route("**/api/platform/messages", async (route) => {
    const command: Command = route.request().postDataJSON();
    commands.push(command);
    if (command.operation.body === "TEST 第一条慢请求") {
      await pending.promise;
      return route.fulfill({ status: 503, json: { error: "TEST 第一条失败" } });
    }
    session.confirm(command);
    await route.fulfill({
      status: 202,
      json: { commandId: command.commandId, entityId: command.commandId },
    });
  });
  try {
    await session.input.fill("TEST 第一条慢请求");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(session.input).toHaveValue("");
    await session.input.fill("TEST 第二条不等待第一条");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[0]!.commandId).not.toBe(commands[1]!.commandId);
    await expect(
      page
        .locator(".human-message")
        .filter({ hasText: "TEST 第二条不等待第一条" }),
    ).toBeVisible();
    await session.input.fill("TEST 第三份尚未发送的草稿");
    pending.release();
    await expect(
      page
        .locator(".human-message")
        .filter({ hasText: "TEST 第一条慢请求" })
        .getByRole("button", { name: "重新发送消息" }),
    ).toBeVisible();
    await expect(session.input).toHaveValue("TEST 第三份尚未发送的草稿");
    await expect(page.locator(".composer > [role=alert]")).toHaveCount(0);
  } finally {
    pending.release();
  }
});
