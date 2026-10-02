import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  applicationFailure,
  ApplicationUnavailable,
  invokeApplication,
} from "../packages/application/src/application.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../packages/core/src/application-api.js";
import { localAccess, type Command } from "../packages/core/src/model.js";
import {
  test,
  expect,
  conversationClient,
  conversationState,
} from "./project-conversation-fixture.js";
import type { platformMessageFixture } from "./platform-message-fixture.js";
import {
  openInput,
  openComposerSettings,
  openExecutionPanel,
} from "./interaction-helpers.js";
import { chooseReasoning } from "./reasoning-helpers.js";

type Host = Awaited<ReturnType<typeof platformMessageFixture>>;
type Scope = { projectId: string; conversationId: string };
type PendingConversation = {
  projectId: string;
  id: string;
  inputId: string;
  title: string;
};
const model = "isolated-project-conversation-model";
test.use({ localFiles: true });
if (process.env.MORPHZ_TEST_BROWSER_EXECUTABLE)
  test.use({
    launchOptions: {
      executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
    },
  });

/** The real App, Human IPC invocation, Platform stores, actual directory
 * grants and queued ingress participate. Only the model catalog/connected
 * presentation and native chooser are controlled. Runtime dispatch stays
 * stopped: no Session or model execution is fabricated by this fixture. */
async function desktopDirectories(page: Page, host: Host) {
  const calls: ApplicationInvocation[] = [];
  const directoryResponses: Array<{
    scope: Scope;
    ok: boolean;
    message?: string;
  }> = [];
  const state = {
    holdReads: false,
    failReads: false,
    chooseCount: 0,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.exposeBinding(
    "__draftDirectoryHostInvoke",
    async (
      _source,
      request: ApplicationInvocation,
    ): Promise<ApplicationReply> => {
      calls.push(structuredClone(request));
      if (request.method === "models")
        return {
          ok: true,
          value: {
            current: model,
            options: [
              {
                id: model,
                label: "TEST 草稿目录模型",
                supported_reasoning_efforts: ["low", "medium", "high"],
              },
            ],
            reasoning: { current: "medium", levels: ["low", "medium", "high"] },
          },
        };
      try {
        if (request.method === "directories.list") {
          if (state.holdReads) await gate;
          if (state.failReads)
            throw new ApplicationUnavailable("TEST 已有对话目录读取失败");
        }
        let value: unknown = await invokeApplication(
          host.session(),
          request.method,
          request.params,
          request.identityGeneration || "TEST-draft-directory-generation",
          new AbortController().signal,
        );
        const connected = (runtime: Record<string, unknown>) => ({
          ...runtime,
          configured: true,
          connected: true,
          model,
        });
        if (request.method === "runtime.snapshot")
          value = connected(value as Record<string, unknown>);
        else if (
          request.method === "runtime.navigation" ||
          request.method === "conversations.history"
        ) {
          const projection = value as Record<string, unknown>;
          value = {
            ...projection,
            runtime: connected(projection.runtime as Record<string, unknown>),
          };
        }
        if (request.method === "directories.list")
          directoryResponses.push({ scope: request.params as Scope, ok: true });
        return { ok: true, value };
      } catch (error) {
        if (request.method === "directories.list")
          directoryResponses.push({
            scope: request.params as Scope,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        return { ok: false, error: applicationFailure(error) };
      }
    },
  );
  await page.exposeBinding("__draftDirectoryChoose", async () => {
    state.chooseCount++;
    throw new Error("TEST 此回归不得调用原生目录选择器");
  });
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      __draftDirectoryHostInvoke(
        request: ApplicationInvocation,
      ): Promise<ApplicationReply>;
      __draftDirectoryChoose(): Promise<unknown>;
    };
    Object.defineProperty(window, "morphzDesktop", {
      configurable: true,
      value: {
        application: {
          invoke: (request: ApplicationInvocation) =>
            bridge.__draftDirectoryHostInvoke(request),
          cancel() {},
          subscribe: async () => {},
          unsubscribe() {},
          onStream: () => () => {},
        },
        directories: { choose: () => bridge.__draftDirectoryChoose() },
      },
    });
  });
  return { calls, directoryResponses, state, release };
}

async function pendingConversation(page: Page, projectId: string) {
  return page.evaluate((projectId) => {
    for (const key of Object.keys(localStorage)) {
      if (!key.includes(":draft:") || !key.endsWith(":conversations")) continue;
      const draft = JSON.parse(localStorage.getItem(key) ?? "{}")[projectId];
      if (draft?.projectId === projectId) return draft as PendingConversation;
    }
    return null;
  }, projectId);
}

test("Desktop目录能力下新命名草稿不查询不存在对话；首发零继承授权并恢复真实读取", async ({
  page,
  messageHost,
}) => {
  const f = await desktopDirectories(page, messageHost);
  await page.goto("/");
  const source = await conversationClient(page);
  const { deskId, dialogueId } = await source.ensurePersonalSpaces();
  const oldScope = { projectId: deskId, conversationId: dialogueId };
  await messageHost.session().directoryScope(oldScope);
  const oldPath = join(messageHost.directory, "TEST-old-conversation-grant");
  mkdirSync(oldPath);
  const oldGrant = messageHost.localFiles!.authorizeDirectory(
    oldPath,
    deskId,
    dialogueId,
    localAccess,
  );
  const projectId = randomUUID();
  const title = "TEST 草稿目录隔离 " + projectId.slice(0, 8);
  await source.createProject(title, randomUUID(), projectId);
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  let settings = await openComposerSettings(page);
  await expect(settings.locator(".agent-directories")).toContainText(
    oldGrant.name,
  );
  await expect(
    settings.getByLabel("当前会话审批方式", { exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  const before = await conversationState(page);
  const group = page.getByRole("group", {
    name: title + "的会话",
    exact: true,
  });
  const create = group.getByRole("button", {
    name: "新建项目对话：" + title,
    exact: true,
  });
  await create.click();
  const body = "TEST 首发正文逐字保留\n第二行仍是原始输入，不替换成准备说明。";
  await (await openInput(page)).fill(body);
  const pending = await pendingConversation(page, projectId);
  expect(pending).not.toBeNull();
  const draftId = pending!.id;
  settings = await openComposerSettings(page);
  await expect(settings).toContainText("首次发送后可调整");
  await expect(
    settings.getByLabel("授权 Agent 读写目录", { exact: true }),
  ).toHaveCount(0);
  await expect(settings.locator(".agent-directories")).toHaveCount(0);
  await chooseReasoning(
    settings.getByLabel("本次输入推理强度", { exact: true }),
    "low",
  );
  await page.keyboard.press("Escape");
  await create.click();
  await page.reload();
  await expect(await openInput(page)).toHaveValue(body);
  expect(await pendingConversation(page, projectId)).toEqual(pending);
  await openExecutionPanel(page);
  await expect(await openInput(page)).toHaveValue(body);
  expect((await conversationState(page)).conversations).toEqual(
    before.conversations,
  );
  expect(messageHost.deliveries()).toHaveLength(0);
  expect(f.directoryResponses.every((response) => response.ok)).toBe(true);
  expect(
    f.calls.filter((call) => {
      const scope = call.params as Partial<Scope> | undefined;
      return (
        scope?.conversationId === draftId &&
        [
          "directories.list",
          "directories.scope",
          "session-permissions.read",
          "session-permissions.update",
        ].includes(call.method)
      );
    }),
  ).toHaveLength(0);
  expect(f.state.chooseCount).toBe(0);
  // The absent draft remains an authorization failure at the actual Host.
  // The UI must skip this read, not reinterpret arbitrary 404s as safe grants.
  await expect(
    messageHost.session().directories({ projectId, conversationId: draftId }),
  ).rejects.toThrow("对话不存在");
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    group.getByLabel("打开对话：对话 1", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect.poll(() => messageHost.deliveries().length).toBe(1);
  const sent = f.calls.filter((call) => call.method === "platform.message");
  expect(sent).toHaveLength(1);
  const command = sent[0]!.params as Command;
  expect(command.commandId).toBe(pending!.inputId);
  expect(command.operation).toMatchObject({
    type: "record-input",
    projectId,
    conversationId: draftId,
    newConversation: { title: pending!.title },
    body,
    reasoningEffort: "low",
    dispatchMode: "interrupt",
  });
  expect("directories" in command.operation).toBe(false);
  const delivery = messageHost.deliveries()[0]!;
  expect(delivery.inputId).toBe(pending!.inputId);
  expect(delivery.platformSource.body).toBe(body);
  expect(delivery.request.activation.reasoning_effort).toBe("low");
  expect(delivery.platformSource.directories ?? []).toEqual([]);
  expect(delivery.request.message.content.value).toMatchObject({
    text: body,
    input_id: pending!.inputId,
  });
  await expect
    .poll(() =>
      f.directoryResponses.filter(
        (response) => response.scope.conversationId === draftId,
      ),
    )
    .toEqual([{ scope: { projectId, conversationId: draftId }, ok: true }]);
  settings = await openComposerSettings(page);
  await expect(
    settings.getByLabel("授权 Agent 读写目录", { exact: true }),
  ).toBeEnabled();
  await expect(settings.locator(".agent-directories")).toHaveCount(0);
  expect(
    messageHost.localFiles!.directories(deskId, dialogueId, localAccess),
  ).toEqual([oldGrant]);
  expect(
    messageHost.localFiles!.directories(projectId, draftId, localAccess),
  ).toEqual([]);
  expect(
    f.calls.filter((call) => call.method === "session-permissions.update"),
  ).toHaveLength(0);
  expect((await conversationState(page)).conversations).toHaveLength(
    before.conversations.length + 1,
  );
  messageHost.assertNoLegacyData();
});

test("已有对话目录读取未完成或失败仍阻止发送，不清空原授权或改审批", async ({
  page,
  messageHost,
}) => {
  const f = await desktopDirectories(page, messageHost);
  f.state.holdReads = true;
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const source = await conversationClient(page);
  const { deskId, dialogueId } = await source.ensurePersonalSpaces();
  const scope = { projectId: deskId, conversationId: dialogueId };
  await messageHost.session().directoryScope(scope);
  const path = join(messageHost.directory, "TEST-retained-existing-grant");
  mkdirSync(path);
  const grant = messageHost.localFiles!.authorizeDirectory(
    path,
    deskId,
    dialogueId,
    localAccess,
  );
  const before = await conversationState(page);
  const body = "TEST 真实已存在会话不得跳过失败的授权读取";
  await (await openInput(page)).fill(body);
  await expect
    .poll(() => f.calls.some((call) => call.method === "directories.list"))
    .toBe(true);
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  await expect(send).toBeDisabled();
  f.state.failReads = true;
  f.release();
  await expect(page.locator(".composer-status-slot")).toContainText(
    "TEST 已有对话目录读取失败",
  );
  await expect(send).toBeDisabled();
  await expect(await openInput(page)).toHaveValue(body);
  await page.getByLabel("AI 输入内容").press("Enter");
  await expect(page.locator(".composer-status-slot")).toContainText(
    "目录授权尚未确认",
  );
  expect(messageHost.deliveries()).toHaveLength(0);
  expect(
    f.calls.filter((call) =>
      [
        "platform.message",
        "session-permissions.update",
        "directories.revoke",
      ].includes(call.method),
    ),
  ).toHaveLength(0);
  expect(f.state.chooseCount).toBe(0);
  expect(
    messageHost.localFiles!.directories(deskId, dialogueId, localAccess),
  ).toEqual([grant]);
  expect((await conversationState(page)).conversations).toEqual(
    before.conversations,
  );
  messageHost.assertNoLegacyData();
});
