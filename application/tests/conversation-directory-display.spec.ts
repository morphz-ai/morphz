import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";
import { localAccess, type Command } from "../packages/core/src/model.js";
import type { LocalSavedInput } from "../apps/web/src/local-saved-inputs.js";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import type { platformMessageFixture } from "./platform-message-fixture.js";

type Host = Awaited<ReturnType<typeof platformMessageFixture>>;
test.use({ localFiles: true });

/** Actual Host grants and durable outbox, not a fabricated accepted history.
 * Runtime dispatch is stopped by the isolated fixture; no model outcome is
 * inferred from the rendered message. */
async function directoryInput(page: Page, host: Host, body: string) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const source = await conversationClient(page);
  const { deskId, dialogueId } = await source.ensurePersonalSpaces();
  const directories = ["Downloads", "Desktop"].map((name) => {
    const path = join(host.directory, name);
    mkdirSync(path);
    return host.localFiles!.authorizeDirectory(
      path,
      deskId,
      dialogueId,
      localAccess,
    );
  });
  const path = join(host.directory, "Downloads", "TEST-reader-notes.txt");
  writeFileSync(path, "TEST 原文件仅按显式授权读取\n");
  const localFile = host.localFiles!.select(
    path,
    deskId,
    localAccess,
  ).reference;
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "record-input" as const,
      projectId: deskId,
      conversationId: dialogueId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      targetActantId: "morphz-agent",
      dispatchMode: "interrupt" as const,
      body,
      directories,
      localFile,
    },
  } satisfies Command;
  return { source, command, directories, localFile };
}

test("Host 已接收的气泡不常驻目录权限；真实冻结授权、原文件引用和未发草稿跨刷新保持", async ({
  page,
  messageHost,
}, info) => {
  const { command, directories, localFile } = await directoryInput(
    page,
    messageHost,
    "TEST 已提交 Host 的阅读请求保留原文件与目录授权",
  );
  await messageHost.session().platformMessage(command);
  const frozen = structuredClone(messageHost.deliveries()[0]!);
  expect(frozen.platformSource.directories).toEqual(directories);
  expect(frozen.platformSource.localFile).toEqual(localFile);
  expect(frozen.request.message.content.value).toMatchObject({
    directories,
    localFile,
  });
  await page.reload();
  const bubble = page.locator(
    `.human-message[data-input-id="${command.commandId}"]`,
  );
  await expect(bubble).toContainText(command.operation.body);
  await expect(bubble.locator(".message-local-file")).toHaveCount(1);
  await expect(bubble.locator(".message-local-file")).toHaveText(
    "原文件：TEST-reader-notes.txt",
  );
  await expect(bubble.getByText(/目录读写：|Downloads|Desktop/)).toHaveCount(0);
  const draft = "TEST 当前未发送的草稿不受消息展示清理影响";
  await (await openInput(page)).fill(draft);
  await page.reload();
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(bubble).toContainText(command.operation.body);
  await expect(bubble.getByText(/目录读写：|Downloads|Desktop/)).toHaveCount(0);
  expect(messageHost.input(command.commandId).directories).toEqual(directories);
  expect(messageHost.deliveries()).toEqual([frozen]);
  await bubble.screenshot({
    path: info.outputPath("message-without-directory-row.png"),
  });
});

test("失败气泡不显示目录行；重试仍提交原授权和原文件，不用新草稿替换冻结载荷", async ({
  page,
  messageHost,
}) => {
  const { source, command, directories, localFile } = await directoryInput(
    page,
    messageHost,
    "TEST 带目录授权的失败消息只从原气泡重试",
  );
  const saved: LocalSavedInput = {
    ...command,
    createdAt: "2026-10-02T00:00:00Z",
    submission: { state: "failed", error: "TEST 原发送失败" },
  };
  const key = `${applicationStoragePrefix}${source.boot.centerId}:${source.boot.principalId}:${source.boot.actantId}:saved-input:${command.commandId}`;
  await page.evaluate(
    ({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)),
    { key, saved },
  );
  const attempts: Command[] = [];
  let reject = true;
  await page.route("**/api/platform/messages", async (route) => {
    attempts.push(structuredClone(route.request().postDataJSON()) as Command);
    if (reject)
      await route.fulfill({
        status: 503,
        json: { message: "TEST 重试暂不可用" },
      });
    else await route.continue();
  });
  await page.reload();
  const input = await openInput(page);
  const draft = "TEST 下一条独立草稿不会覆盖旧权限";
  await input.fill(draft);
  const bubble = page.locator(
    `.human-message[data-input-id="${command.commandId}"]`,
  );
  const retry = bubble.getByRole("button", {
    name: "重新发送消息",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await expect(bubble.getByText(/目录读写：|Downloads|Desktop/)).toHaveCount(0);
  expect(attempts).toHaveLength(0);
  await retry.click();
  await expect(bubble).toHaveAttribute("data-submission-state", "failed");
  await expect.poll(() => attempts.length).toBe(1);
  await expect(retry).toHaveAttribute("title", /TEST 重试暂不可用/);
  expect(attempts[0]).toEqual(command);
  expect(attempts[0]!.operation).toMatchObject({ directories, localFile });
  await expect(await openInput(page)).toHaveValue(draft);
  await page.reload();
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(retry).toBeEnabled();
  expect(attempts).toHaveLength(1);
  reject = false;
  await retry.click();
  await expect.poll(() => messageHost.deliveries().length).toBe(1);
  expect(attempts).toEqual([command, command]);
  const frozen = messageHost.deliveries()[0]!;
  expect(frozen.platformSource.directories).toEqual(directories);
  expect(frozen.platformSource.localFile).toEqual(localFile);
  expect(frozen.request.message.content.value).toMatchObject({
    directories,
    localFile,
  });
  await expect(bubble.getByText(/目录读写：|Downloads|Desktop/)).toHaveCount(0);
  await expect(bubble.locator(".message-local-file")).toHaveText(
    "原文件：TEST-reader-notes.txt",
  );
  await expect(await openInput(page)).toHaveValue(draft);
});
