import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { openInput } from "./interaction-helpers.js";

test("无 Runtime 时保存到当前客户端，刷新后仍是未发送消息", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("这条消息只保存在本机，尚未发给 Agent");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(
    page.locator(".human-message").filter({ hasText: "这条消息只保存在本机" }),
  ).toContainText("已保存 · 未发送");
  await page.reload();
  await expect(
    page.locator(".human-message").filter({ hasText: "这条消息只保存在本机" }),
  ).toContainText("已保存 · 未发送");
  expect((await page.request.get("/api/platform/bootstrap")).status()).toBe(
    200,
  );
});

test("项目新对话的首条输入本机保存后可重新打开", async ({ page }) => {
  await page.goto("/");
  const title = `本机未发送对话-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const group = page.getByRole("group", { name: `${title}的会话` });
  await group.getByLabel(`新建项目对话：${title}`).click();
  const input = await openInput(page);
  await input.fill("项目新对话的本机首条消息");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".human-message")).toContainText(
    "项目新对话的本机首条消息",
  );
  const projects = (await (
    await page.request.get("/api/platform/projects?limit=100")
  ).json()) as Array<{ id: string; title: string }>;
  const project = projects.find((entry) => entry.title === title);
  expect(project).toBeDefined();
  const conversations = (await (
    await page.request.get(
      `/api/platform/projects/${project!.id}/conversations?limit=100`,
    )
  ).json()) as Array<{ id: string }>;
  expect(conversations).toHaveLength(1);
  expect(conversations[0]!.id).toBe(project!.id);
  await page.reload();
  await group.getByRole("button", { name: /继续草稿：对话 1/ }).click();
  await expect(page.locator(".human-message")).toContainText(
    "项目新对话的本机首条消息",
  );
});

test("连接恢复后发送本机消息沿用原 ID，且不误走服务端重试", async ({
  page,
}) => {
  let runtimeConfigured = false;
  let confirmedInput: Record<string, unknown> | undefined;
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
    async (route) => {
      await route.fulfill({
        json: {
          inputs: confirmedInput ? [confirmedInput] : [],
          nextCursor: null,
          runtime: { ...disconnectedRuntime, configured: runtimeConfigured },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch();
      const navigation = await response.json();
      await route.fulfill({
        response,
        json: {
          ...navigation,
          historyVersion: confirmedInput
            ? createHash("sha256")
                .update(JSON.stringify(confirmedInput))
                .digest("hex")
            : navigation.historyVersion,
          runtime: { ...navigation.runtime, configured: runtimeConfigured },
        },
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await (await openInput(page)).fill("恢复连接后发送同一条本机消息");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const savedId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) =>
      value.includes(":saved-input:"),
    );
    return key?.split(":saved-input:")[1] ?? null;
  });
  expect(savedId).not.toBeNull();

  let sent: { commandId: string; operation: { body: string } } | null = null;
  let wrongRetry = false;
  await page.route("**/api/inputs/*/send", async (route) => {
    wrongRetry = true;
    await route.fulfill({ status: 500 });
  });
  await page.route("**/api/platform/messages", async (route) => {
    sent = route.request().postDataJSON();
    const saved = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((value) =>
        value.includes(":saved-input:"),
      );
      return key ? JSON.parse(localStorage.getItem(key)!) : null;
    });
    const boot = await (
      await page.request.get("/api/platform/bootstrap")
    ).json();
    confirmedInput = {
      id: savedId,
      projectId: saved.operation.projectId,
      conversationId:
        saved.operation.conversationId ?? saved.operation.projectId,
      body: saved.operation.body,
      targetActantId: saved.operation.targetActantId,
      author: { principalId: boot.principalId, actantId: boot.actantId },
      createdAt: saved.createdAt,
    };
    await route.fulfill({
      status: 202,
      json: { commandId: savedId, entityId: savedId },
    });
  });
  runtimeConfigured = true;
  await page.reload();
  await page.getByRole("button", { name: "发送这条消息" }).click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({
    commandId: savedId,
    operation: { body: "恢复连接后发送同一条本机消息" },
  });
  expect(wrongRetry).toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((value) =>
          value.includes(":saved-input:"),
        ),
      ),
    )
    .toBe(false);
});
