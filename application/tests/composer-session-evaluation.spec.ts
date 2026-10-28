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
  let capacityGate: Promise<void> | undefined,
    releaseCapacity: (() => void) | undefined;
  let requestedCapacity: number | null = null,
    capacityRevision = 0;
  const state = {
    missing,
    failRead: false,
    loseWrite: false,
    failCapacity: false,
    loseCapacityWrite: false,
    holdCapacity() {
      capacityGate = new Promise<void>((resolve) => {
        releaseCapacity = resolve;
      });
    },
    releaseCapacity() {
      releaseCapacity?.();
      capacityGate = undefined;
    },
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
      if (request.method === "session-context-budget.read") {
        await capacityGate;
        if (state.failCapacity)
          return {
            ok: false,
            error: {
              status: 503,
              code: "unavailable",
              message: "TEST 容量读取失败",
            },
          };
        const scope = request.params as {
          projectId: string;
          conversationId: string;
        };
        const policy = snapshot(scope);
        return {
          ok: true,
          value: {
            scope: policy.scope,
            source: state.missing ? "not_started" : "runtime",
            inputTokens: state.missing
              ? null
              : Math.min(
                  requestedCapacity ??
                    (policy.defaults.model === other ? 114688 : 229376),
                  policy.defaults.model === other ? 114688 : 229376,
                ),
            windowTokens: state.missing
              ? null
              : policy.defaults.model === other
                ? 131072
                : 262144,
            outputTokens: state.missing
              ? null
              : policy.defaults.model === other
                ? 16384
                : 32768,
            model: policy.defaults.model,
            capacitySource: "provider-route-model-config",
            contextId: "TEST-context",
            runtimeSessionId: "TEST-session",
            requestedTokens: requestedCapacity,
            physicalInputTokens:
              policy.defaults.model === other ? 114688 : 229376,
            revision: capacityRevision,
            canUpdate: !state.missing,
            usage: state.missing
              ? null
              : {
                  contextId: "TEST-context",
                  sessionId: "TEST-session",
                  model: policy.defaults.model ?? model,
                  physicalModel: policy.defaults.model ?? model,
                  inputTokens: policy.defaults.model === other ? 32768 : 209715,
                  accuracy: "heuristic-estimate",
                  measuredAt: "2026-10-28T00:00:00Z",
                  sequence: 1,
                },
          },
        };
      }
      if (request.method === "session-context-budget.update") {
        const params = request.params as {
          expectedRevision: number;
          requestedTokens: number | null;
        };
        if (params.expectedRevision !== capacityRevision)
          return {
            ok: false,
            error: {
              status: 409,
              code: "conflict",
              message: "TEST 容量已经变化",
            },
          };
        capacityRevision++;
        requestedCapacity = params.requestedTokens;
        if (state.loseCapacityWrite) {
          state.loseCapacityWrite = false;
          return {
            ok: false,
            error: {
              status: 503,
              code: "unavailable",
              message: "TEST 容量回执未知",
            },
          };
        }
        const scope = request.params as {
          projectId: string;
          conversationId: string;
        };
        const policy = snapshot(scope);
        return {
          ok: true,
          value: {
            scope: policy.scope,
            source: "runtime",
            inputTokens: Math.min(
              requestedCapacity ??
                (policy.defaults.model === other ? 114688 : 229376),
              policy.defaults.model === other ? 114688 : 229376,
            ),
            windowTokens: policy.defaults.model === other ? 131072 : 262144,
            outputTokens: policy.defaults.model === other ? 16384 : 32768,
            model: policy.defaults.model,
            capacitySource: "provider-route-model-config",
            contextId: "TEST-context",
            runtimeSessionId: "TEST-session",
            requestedTokens: requestedCapacity,
            physicalInputTokens:
              policy.defaults.model === other ? 114688 : 229376,
            revision: capacityRevision,
            canUpdate: true,
            usage: {
              contextId: "TEST-context",
              sessionId: "TEST-session",
              model: policy.defaults.model ?? model,
              physicalModel: policy.defaults.model ?? model,
              inputTokens: policy.defaults.model === other ? 32768 : 209715,
              accuracy: "heuristic-estimate",
              measuredAt: "2026-10-28T00:00:00Z",
              sequence: 1,
            },
          },
        };
      }
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
    const subscriptions = new Set<string>();
    const listeners = new Set<
      (value: {
        id: string;
        value: {
          connected: boolean;
          messages: never[];
          contextUsages: unknown[];
        };
      }) => void
    >();
    Object.defineProperty(window, "__emitCapacityUsage", {
      value: (contextUsages: unknown[]) => {
        for (const id of subscriptions)
          for (const listener of listeners)
            listener({
              id,
              value: { connected: true, messages: [], contextUsages },
            });
      },
    });
    Object.defineProperty(window, "morphzDesktop", {
      configurable: true,
      value: {
        application: {
          invoke: (request: ApplicationInvocation) =>
            bridge.__evaluationHostInvoke(request),
          cancel() {},
          subscribe: async (id: string) => {
            subscriptions.add(id);
          },
          unsubscribe(id: string) {
            subscriptions.delete(id);
          },
          onStream: (
            listener: (value: {
              id: string;
              value: {
                connected: boolean;
                messages: never[];
                contextUsages: unknown[];
              };
            }) => void,
          ) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
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

test("上下文容量随会话模型更新，独立慢读不阻塞正文，也不随输入轮询", async ({
  page,
  messageHost,
}, info) => {
  const f = await fixture(page, messageHost);
  await page.keyboard.press("Escape");
  const capacity = page.getByRole("button", {
    name: "上下文容量",
    exact: true,
  });
  await expect(capacity).toHaveText("");
  await expect(capacity).toHaveAttribute(
    "aria-description",
    /256K.*80%.*预留 32K/,
  );
  f.state.holdCapacity();
  const settings = await openComposerSettings(page);
  await settings.getByLabel("会话模型", { exact: true }).selectOption(other);
  await expect.poll(() => f.writes().length).toBe(1);
  await page.keyboard.press("Escape");
  await f.input.fill("TEST 容量慢读时仍可立即写入，正文保持。");
  await expect(f.input).toHaveValue("TEST 容量慢读时仍可立即写入，正文保持。");
  await capacity.click();
  await expect(
    page.getByText("正在读取当前上下文…", { exact: true }),
  ).toBeVisible();
  f.state.releaseCapacity();
  await expect(capacity).toHaveText("");
  await expect(capacity).toHaveAttribute("aria-description", /128K/);
  await expect(page.getByText("预留 16K", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("capacity-light.png") });
  await page.keyboard.press("Escape");
  const reads = f.state.calls.filter(
    (x) => x.method === "session-context-budget.read",
  ).length;
  for (const text of ["TEST 编辑一", "TEST 编辑二", "TEST 编辑三"])
    await f.input.fill(text);
  await expect(f.input).toHaveValue("TEST 编辑三");
  expect(
    f.state.calls.filter((x) => x.method === "session-context-budget.read"),
  ).toHaveLength(reads);
  expect(f.messages()).toHaveLength(0);
  await page.setViewportSize({ width: 1050, height: 850 });
  await capacity.click();
  await expect(page.getByText("最大上下文", { exact: true })).toBeVisible();
  const bounds = await page
    .locator(".composer-capacity-menu:popover-open")
    .boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1050);
  await page.emulateMedia({ colorScheme: "dark" });
  await settleTransitions(page);
  await page.screenshot({ path: info.outputPath("capacity-dark-narrow.png") });
});

test("容量读取失败只影响容量入口，重读不改模型、正文或发送消息", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  f.state.failCapacity = true;
  await f.picker.selectOption(other);
  await expect.poll(() => f.writes().length).toBe(1);
  await page.keyboard.press("Escape");
  const capacity = page.getByRole("button", {
    name: "上下文容量",
    exact: true,
  });
  await expect(capacity).toHaveText("");
  await f.input.fill("TEST 容量暂不可读时保留正文");
  await capacity.click();
  await expect(
    page.getByText("容量暂时无法读取。", { exact: true }),
  ).toBeVisible();
  f.state.failCapacity = false;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(capacity).toHaveText("");
  await expect(capacity).toHaveAttribute("aria-description", /128K/);
  await page.keyboard.press("Escape");
  await expect(f.input).toHaveValue("TEST 容量暂不可读时保留正文");
  expect(f.writes()).toHaveLength(1);
  expect(f.messages()).toHaveLength(0);
});

test("用量沿现有事件流更新；容量可调、可恢复自动，回车不会发送正文", async ({
  page,
  messageHost,
}, info) => {
  const f = await fixture(page, messageHost);
  await page.keyboard.press("Escape");
  const capacity = page.getByRole("button", {
    name: "上下文容量",
    exact: true,
  });
  await expect(capacity).toHaveText("");
  await expect(capacity).toHaveAttribute("aria-description", /80%/);
  const reads = f.state.calls.filter(
    (c) => c.method === "session-context-budget.read",
  ).length;
  await page.evaluate((model) => {
    (
      window as unknown as { __emitCapacityUsage(values: unknown[]): void }
    ).__emitCapacityUsage([
      {
        contextId: "TEST-context",
        sessionId: "TEST-session",
        model,
        physicalModel: model,
        inputTokens: 235930,
        accuracy: "heuristic-estimate",
        measuredAt: "2026-10-28T01:00:00Z",
        sequence: 10,
      },
      {
        contextId: "TEST-context",
        sessionId: "foreign",
        model,
        physicalModel: model,
        inputTokens: 999999,
        accuracy: "exact",
        measuredAt: "2026-10-28T02:00:00Z",
        sequence: 11,
      },
    ]);
  }, model);
  await expect(capacity).toHaveText("");
  await expect(capacity).toHaveAttribute("aria-description", /256K.*90%/);
  expect(
    f.state.calls.filter((c) => c.method === "session-context-budget.read"),
  ).toHaveLength(reads);
  await f.input.fill("TEST 主输入草稿保持，容量操作不发送消息");
  await capacity.click();
  const value = page.getByRole("spinbutton", {
    name: "最大上下文 K",
    exact: true,
  });
  await expect(value).toBeEnabled();
  await expect(value).toHaveValue("256");
  await value.fill("128");
  await value.press("Enter");
  await expect
    .poll(
      () =>
        f.state.calls.filter(
          (c) => c.method === "session-context-budget.update",
        ).length,
    )
    .toBe(1);
  await expect(capacity).toHaveText("");
  await expect(capacity).toHaveAttribute("aria-description", /128K.*180%/);
  expect(
    f.state.calls.filter((c) => c.method === "session-context-budget.update")[0]
      ?.params,
  ).toMatchObject({ requestedTokens: 98304 });
  await settleTransitions(page);
  await page.screenshot({
    path: info.outputPath("capacity-configurable-light.png"),
  });
  await page.getByRole("button", { name: "自动", exact: true }).focus();
  await page.getByRole("button", { name: "自动", exact: true }).press("Enter");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(capacity).toHaveAttribute("aria-description", /256K/);
  await expect(
    page.getByRole("button", { name: "应用", exact: true }),
  ).toBeDisabled();
  expect(
    f.state.calls.filter((c) => c.method === "session-context-budget.update"),
  ).toHaveLength(2);
  expect(f.messages()).toHaveLength(0);
  expect(f.writes()).toHaveLength(0);
  await page.emulateMedia({ colorScheme: "dark" });
  await settleTransitions(page);
  await page.screenshot({
    path: info.outputPath("capacity-configurable-dark.png"),
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await settleTransitions(page);
  const zoomed = await page
    .getByRole("group", { name: "上下文容量", exact: true })
    .boundingBox();
  expect(zoomed).not.toBeNull();
  expect(zoomed!.x).toBeGreaterThanOrEqual(0);
  expect(zoomed!.y).toBeGreaterThanOrEqual(0);
  expect(zoomed!.x + zoomed!.width).toBeLessThanOrEqual(1280);
  expect(zoomed!.y + zoomed!.height).toBeLessThanOrEqual(900);
  await page.screenshot({ path: info.outputPath("capacity-zoom-200.png") });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await page.keyboard.press("Escape");
  await expect(f.input).toHaveValue("TEST 主输入草稿保持，容量操作不发送消息");
});

test("容量写入回执未知时停止重放；重新读取确认实际值并保留正文", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  await page.keyboard.press("Escape");
  await f.input.fill("TEST 容量写入结果未知也保留正文");
  await page.getByRole("button", { name: "上下文容量", exact: true }).click();
  const value = page.getByRole("spinbutton", {
    name: "最大上下文 K",
    exact: true,
  });
  await expect(value).toBeEnabled();
  await value.fill("128");
  f.state.loseCapacityWrite = true;
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("回执未知");
  expect(
    f.state.calls.filter((c) => c.method === "session-context-budget.update"),
  ).toHaveLength(1);
  await expect(value).toBeDisabled();
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(value).toBeEnabled();
  await expect(value).toHaveValue("128");
  await expect(
    page.getByRole("button", { name: "应用", exact: true }),
  ).toBeDisabled();
  expect(
    f.state.calls.filter((c) => c.method === "session-context-budget.update"),
  ).toHaveLength(1);
  expect(f.messages()).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(f.input).toHaveValue("TEST 容量写入结果未知也保留正文");
});
