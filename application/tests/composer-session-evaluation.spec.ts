import type { Page } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { randomUUID } from "node:crypto";
import { platformMessageFixture } from "./platform-message-fixture.js";
import {
  applicationFailure,
  invokeApplication,
} from "../packages/application/src/application.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../packages/core/src/application-api.js";
import {
  sessionEvaluationUpdateSchema,
  type SessionEvaluationDefaults,
  type SessionEvaluationSnapshot,
} from "../packages/core/src/session-evaluation.js";
import {
  openInput,
  openComposerSettings,
  settleTransitions,
} from "./interaction-helpers.js";
import { chooseReasoning } from "./reasoning-helpers.js";

type Host = Awaited<ReturnType<typeof platformMessageFixture>>;
const model = "isolated-project-conversation-model";
const other = "TEST-other-model";

/** Actual App, IPC invocation shape, local Human ingress and durable outbox.
 * Only policy receipts/catalog/connected presentation are controlled; Runtime
 * dispatch is stopped. The separate actual-Rust suite proves physical requests. */
async function fixture(page: Page, host: Host, missing = false) {
  const calls: ApplicationInvocation[] = [];
  const policies = new Map<string, SessionEvaluationDefaults>();
  const revisions = new Map<string, number>();
  let gate: Promise<void> | undefined, release: (() => void) | undefined;
  const state = {
    missing,
    failRead: false,
    loseWrite: false,
    calls,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      gate = undefined;
    },
  };
  function snapshot(scope: {
    projectId: string;
    conversationId: string;
  }): SessionEvaluationSnapshot {
    return {
      scope: {
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        kind: "global",
      },
      runtimeSessionId: state.missing ? null : "TEST-session",
      defaults: state.missing
        ? { model: null, reasoningEffort: null }
        : (policies.get(scope.conversationId) ?? {
            model,
            reasoningEffort: "low",
          }),
      source: state.missing ? "not_started" : "runtime",
      canUpdate: !state.missing,
      readOnlyReason: state.missing ? "not_started" : null,
      fingerprint: state.missing
        ? null
        : String(revisions.get(scope.conversationId) ?? 1).repeat(64),
    };
  }
  await page.exposeBinding(
    "__evaluationHostInvoke",
    async (
      _source,
      request: ApplicationInvocation,
    ): Promise<ApplicationReply> => {
      calls.push(structuredClone(request));
      if (request.method === "session-evaluation.read") {
        if (state.failRead)
          return {
            ok: false,
            error: {
              status: 503,
              code: "unavailable",
              message: "TEST 无法读取会话模型",
            },
          };
        return {
          ok: true,
          value: snapshot(
            request.params as { projectId: string; conversationId: string },
          ),
        };
      }
      if (request.method === "session-evaluation.update") {
        const update = sessionEvaluationUpdateSchema.parse(request.params);
        await gate;
        if (update.expectedFingerprint !== snapshot(update).fingerprint)
          return {
            ok: false,
            error: {
              status: 409,
              code: "conflict",
              message: "TEST 设置已变化",
            },
          };
        policies.set(update.conversationId, structuredClone(update.defaults));
        revisions.set(
          update.conversationId,
          (revisions.get(update.conversationId) ?? 1) + 1,
        );
        if (state.loseWrite) {
          state.loseWrite = false;
          return {
            ok: false,
            error: {
              status: 503,
              code: "unavailable",
              message: "TEST 保存回执丢失",
            },
          };
        }
        return { ok: true, value: snapshot(update) };
      }
      if (request.method === "models")
        return {
          ok: true,
          value: {
            current: model,
            options: [model, other].map((id) => ({
              id,
              label: id,
              supported_reasoning_efforts: [
                "none",
                "low",
                "medium",
                "high",
                "max",
              ],
            })),
            reasoning: {
              current: "low",
              levels: ["none", "low", "medium", "high", "max"],
            },
          },
        };
      try {
        let value = await invokeApplication(
          host.session(),
          request.method,
          request.params,
          request.identityGeneration || "TEST-evaluation-generation",
          new AbortController().signal,
        );
        const connected = (runtime: Record<string, unknown>) => ({
          ...runtime,
          configured: true,
          connected: true,
          model,
        });
        if (request.method === "platform.bootstrap") {
          const boot = value as Record<string, unknown>;
          value = {
            ...boot,
            capabilities: {
              ...(boot.capabilities as object),
              modelSettings: true,
            },
          };
        }
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
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: applicationFailure(error) };
      }
    },
  );
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      __evaluationHostInvoke(
        request: ApplicationInvocation,
      ): Promise<ApplicationReply>;
    };
    Object.defineProperty(window, "morphzDesktop", {
      configurable: true,
      value: {
        application: {
          invoke: (request: ApplicationInvocation) =>
            bridge.__evaluationHostInvoke(request),
          cancel() {},
          subscribe: async () => {},
          unsubscribe() {},
          onStream: () => () => {},
        },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  const settings = await openComposerSettings(page);
  const picker = settings.getByLabel("会话模型", { exact: true });
  await expect(picker).toBeEnabled();
  return {
    state,
    input,
    settings,
    picker,
    writes: () =>
      calls.filter((entry) => entry.method === "session-evaluation.update"),
    messages: () =>
      calls.filter((entry) => entry.method === "platform.message"),
  };
}

test("持续模型选择：在途保存可继续调档，立即发送等待最新回执且新任务不固化模型", async ({
  page,
  messageHost,
}, info) => {
  const f = await fixture(page, messageHost);
  await expect(f.picker).toHaveValue(model);
  await page.keyboard.press("Escape");
  await f.input.fill("TEST 会话持续模型选择；只入队不执行");
  await openComposerSettings(page);
  f.state.hold();
  await f.picker.selectOption(other);
  await expect.poll(() => f.writes().length).toBe(1);
  const effort = f.settings.getByLabel("会话推理强度", { exact: true });
  await expect(effort).toBeEnabled();
  await chooseReasoning(effort, "max");
  await page.keyboard.press("Escape");
  await f.input.press("Enter");
  expect(f.messages()).toHaveLength(0);
  f.state.release();
  await expect.poll(() => messageHost.deliveries().length).toBe(1);
  expect(f.writes()).toHaveLength(2);
  expect((f.writes().at(-1)!.params as { defaults: unknown }).defaults).toEqual(
    { model: other, reasoningEffort: "max" },
  );
  const operation = (
    f.messages()[0]!.params as { operation: Record<string, unknown> }
  ).operation;
  expect(Object.hasOwn(operation, "model")).toBe(false);
  expect(Object.hasOwn(operation, "reasoningEffort")).toBe(false);
  expect(Object.hasOwn(operation, "initialSessionEvaluation")).toBe(false);
  const delivery = messageHost.deliveries()[0]!;
  expect(Object.hasOwn(delivery.request, "model_alias")).toBe(false);
  expect(Object.hasOwn(delivery.request, "reasoning_effort")).toBe(false);
  await openInput(page);
  await openComposerSettings(page);
  await expect(f.picker).toHaveValue(other);
  await expect(effort).toHaveAttribute("aria-valuetext", "max");
  await settleTransitions(page);
  await page.screenshot({
    path: info.outputPath("session-evaluation-confirmed-full.png"),
    fullPage: true,
  });
  await page.reload();
  await openInput(page);
  await openComposerSettings(page);
  await expect(page.getByLabel("会话模型", { exact: true })).toHaveValue(other);
  await expect(
    page.getByLabel("会话推理强度", { exact: true }),
  ).toHaveAttribute("aria-valuetext", "max");
});

test("模型保存回执未知：阻止误发并保留正文，重新读取只核验实际值不重放保存", async ({
  page,
  messageHost,
}, info) => {
  const f = await fixture(page, messageHost);
  await page.keyboard.press("Escape");
  await f.input.fill("TEST 回执未知后保留的输入正文");
  await openComposerSettings(page);
  f.state.loseWrite = true;
  await f.picker.selectOption(other);
  await expect(f.settings.getByRole("alert")).toContainText(
    "TEST 保存回执丢失",
  );
  expect(f.writes()).toHaveLength(1);
  await page.keyboard.press("Escape");
  await f.input.press("Enter");
  await expect(f.input).toHaveValue("TEST 回执未知后保留的输入正文");
  expect(f.messages()).toHaveLength(0);
  await openComposerSettings(page);
  await expect(f.picker).toBeDisabled();
  await settleTransitions(page);
  await page.screenshot({
    path: info.outputPath("session-evaluation-unknown-full.png"),
    fullPage: true,
  });
  await f.settings
    .getByRole("button", { name: "重新读取", exact: true })
    .click();
  await expect(f.picker).toBeEnabled();
  await expect(f.picker).toHaveValue(other);
  expect(f.writes()).toHaveLength(1);
  await page.keyboard.press("Escape");
  await f.input.press("Enter");
  await expect.poll(() => messageHost.deliveries().length).toBe(1);
  expect(f.messages()).toHaveLength(1);
});

test("未开始的会话：打开与选择不建 Session，首条输入携带初始化收据而非任务覆盖", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost, true);
  await f.picker.selectOption(model);
  expect(f.writes()).toHaveLength(0);
  expect(messageHost.deliveries()).toHaveLength(0);
  await page.keyboard.press("Escape");
  await f.input.fill("TEST 首条消息原子初始化会话默认");
  await f.input.press("Enter");
  await expect.poll(() => messageHost.deliveries().length).toBe(1);
  const operation = (
    f.messages()[0]!.params as { operation: Record<string, unknown> }
  ).operation;
  expect(operation.initialSessionEvaluation).toEqual({
    model,
    reasoningEffort: null,
  });
  expect(Object.hasOwn(operation, "model")).toBe(false);
  expect(Object.hasOwn(operation, "reasoningEffort")).toBe(false);
  expect(messageHost.deliveries()[0]!.initialSessionEvaluation).toEqual({
    model,
    reasoningEffort: null,
  });
  expect(f.writes()).toHaveLength(0);
});

test("同一全局Session跨对话、事项、内容、工作台和项目页面共享模型，独立会话保持隔离", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  await f.picker.selectOption(other);
  await chooseReasoning(
    f.settings.getByLabel("会话推理强度", { exact: true }),
    "max",
  );
  // Navigate before the debounce: changing page must not discard the choice.
  await page.keyboard.press("Escape");
  const nav = page.getByRole("navigation", { name: "主导航" });
  for (const name of ["事项 0", "内容库", "工作台", "对话"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await openInput(page);
    const settings = await openComposerSettings(page);
    await expect(settings.getByLabel("会话模型", { exact: true })).toHaveValue(
      other,
    );
    await expect(
      settings.getByLabel("会话推理强度", { exact: true }),
    ).toHaveAttribute("aria-valuetext", "max");
    await page.keyboard.press("Escape");
  }
  const source = await conversationClient(page);
  const project = { id: randomUUID(), title: "TEST 会话模型隔离" };
  const named = { id: randomUUID(), title: "TEST 独立模型会话" };
  await source.createProject(project.title, randomUUID(), project.id);
  await source.sendMessage({
    commandId: randomUUID(),
    projectId: project.id,
    conversationId: named.id,
    newConversation: { title: named.title },
    body: "TEST 建立独立会话，只入队",
  });
  await page.reload();
  const group = page.getByRole("group", {
    name: project.title + "的会话",
    exact: true,
  });
  await group.getByRole("button", { name: project.title, exact: true }).click();
  await openInput(page);
  let settings = await openComposerSettings(page);
  await expect(settings.getByLabel("会话模型", { exact: true })).toHaveValue(
    other,
  );
  await expect(
    settings.getByLabel("会话推理强度", { exact: true }),
  ).toHaveAttribute("aria-valuetext", "max");
  await page.keyboard.press("Escape");
  const expand = group.getByRole("button", {
    name: "展开项目会话：" + project.title,
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  await group
    .getByRole("button", { name: "打开对话：" + named.title, exact: true })
    .click();
  await openInput(page);
  settings = await openComposerSettings(page);
  await expect(settings.getByLabel("会话模型", { exact: true })).toHaveValue(
    model,
  );
  await expect(
    settings.getByLabel("会话推理强度", { exact: true }),
  ).toHaveAttribute("aria-valuetext", "low");
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await openInput(page);
  settings = await openComposerSettings(page);
  await expect(settings.getByLabel("会话模型", { exact: true })).toHaveValue(
    other,
  );
  await expect(
    settings.getByLabel("会话推理强度", { exact: true }),
  ).toHaveAttribute("aria-valuetext", "max");
});
