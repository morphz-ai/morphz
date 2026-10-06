import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  applicationFailure,
  invokeApplication,
} from "../packages/application/src/application.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../packages/core/src/application-api.js";
import {
  sessionPermissionsSnapshotSchema,
  sessionPermissionsUpdateSchema,
  type SessionPermissionsSnapshot,
  type SessionPermissionsUpdate,
} from "../packages/core/src/session-permissions.js";
import {
  test,
  expect,
  conversationClient,
  conversationState,
} from "./project-conversation-fixture.js";
import { platformMessageFixture } from "./platform-message-fixture.js";
import { chooseReasoning } from "./reasoning-helpers.js";
import { supplementExchangeWork } from "./exchange-action-helpers.js";
import {
  openInput,
  openComposerSettings,
  openComposerMedia,
} from "./interaction-helpers.js";

type Host = Awaited<ReturnType<typeof platformMessageFixture>>;
type Scope = { projectId: string; conversationId: string };
type Mode = SessionPermissionsUpdate["permissionMode"];
const model = "isolated-project-conversation-model";

/** Real identity, navigation, draft persistence and queued ingress; only the
 * desktop IPC policy response is controlled presentation data. Dispatch is
 * stopped. These tests never grant a real Runtime or native-user permission.
 * `realRead` delegates to the real Host's missing-Session read path. */
async function fixture(
  page: Page,
  host: Host,
  realRead = false,
  previewMode?: Mode,
) {
  const calls: ApplicationInvocation[] = [];
  const policies = new Map<string, Mode>();
  const revisions = new Map<string, number>();
  const state = {
    calls,
    failRead: false,
    failUpdate: false,
    readOnly: null as SessionPermissionsSnapshot["readOnlyReason"],
    unknownPolicy: false,
    workspaceReason: null as string | null,
    rotatedGeneration: "",
    originalGeneration: "",
    globalConversationId: "",
    updating: false,
    continuation: false,
    hold() {},
    release() {},
  };
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  state.hold = () => {
    gate = new Promise<void>((resolve) => (release = resolve));
  };
  state.release = () => {
    release?.();
    gate = undefined;
  };
  const policyKey = (scope: Scope, identityGeneration?: string) =>
    `${identityGeneration}:${scope.conversationId}`;
  const snapshot = (scope: Scope, identityGeneration?: string) => {
    if (!state.globalConversationId)
      state.globalConversationId = scope.conversationId;
    const key = policyKey(scope, identityGeneration);
    const mode = policies.get(key) ?? previewMode ?? "request_approval";
    return sessionPermissionsSnapshotSchema.parse({
      scope: {
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        kind:
          scope.conversationId === state.globalConversationId
            ? "global"
            : "conversation",
      },
      runtimeSessionId: `TEST-session-${scope.conversationId}`,
      permissionMode: state.unknownPolicy ? null : mode,
      sandboxMode: state.unknownPolicy
        ? null
        : mode === "full_access"
          ? "danger-full-access"
          : "workspace-write",
      reviewer: state.unknownPolicy
        ? null
        : mode === "full_access"
          ? "deny"
          : mode === "auto_review"
            ? "auto_review"
            : "user",
      source: "runtime",
      canUpdate: !state.readOnly && !state.unknownPolicy,
      readOnlyReason: state.readOnly,
      fingerprint: (revisions.get(key) ?? 1).toString(16).padStart(64, "0"),
      workspace: {
        targetId: "TEST-node",
        targetName: "TEST-local-default-node",
        workspaceRoot: state.workspaceReason
          ? null
          : join(
              host.directory,
              "TEST-node-default",
              "工作目录长路径".repeat(12),
            ),
        ready: !state.workspaceReason,
        reason: state.workspaceReason,
      },
    });
  };
  await page.exposeBinding(
    "__permissionHostInvoke",
    async (
      _source,
      request: ApplicationInvocation,
    ): Promise<ApplicationReply> => {
      calls.push(structuredClone(request));
      if (request.method === "session-permissions.read" && !realRead) {
        if (state.failRead)
          return {
            ok: false,
            error: {
              code: "unavailable",
              status: 503,
              message: "TEST 审批读取失败",
            },
          };
        return {
          ok: true,
          value: snapshot(request.params as Scope, request.identityGeneration),
        };
      }
      if (request.method === "session-permissions.update") {
        const update = sessionPermissionsUpdateSchema.parse(request.params);
        state.updating = true;
        await gate;
        state.updating = false;
        if (state.failUpdate)
          return {
            ok: false,
            error: {
              code: "conflict",
              status: 409,
              message: "TEST 审批策略已变化",
            },
          };
        const key = policyKey(update, request.identityGeneration);
        const original = snapshot(update, request.identityGeneration);
        expect(update.expectedFingerprint).toBe(original.fingerprint);
        policies.set(key, update.permissionMode);
        revisions.set(key, (revisions.get(key) ?? 1) + 1);
        return {
          ok: true,
          value: snapshot(update, request.identityGeneration),
        };
      }
      if (request.method === "models")
        return {
          ok: true,
          value: {
            current: model,
            options: [
              {
                id: model,
                label: "TEST 很长的模型名称 ".repeat(20),
                supported_reasoning_efforts: ["low", "medium", "high"],
              },
            ],
            reasoning: { current: "medium", levels: ["low", "medium", "high"] },
          },
        };
      try {
        let value: unknown = await invokeApplication(
          host.session(),
          request.method,
          request.params,
          request.identityGeneration || "TEST-permission-generation",
          new AbortController().signal,
        );
        if (request.method === "platform.bootstrap") {
          const boot = value as Record<string, unknown>;
          state.originalGeneration = String(boot.csrfToken);
          value = {
            ...boot,
            ...(state.rotatedGeneration
              ? { csrfToken: state.rotatedGeneration }
              : {}),
            capabilities: {
              ...(boot.capabilities as object),
              directedInput: true,
            },
          };
        }
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
          if (
            state.continuation &&
            request.method === "conversations.history"
          ) {
            const inputs = projection.inputs as Array<{
              id: string;
              projectId: string;
              conversationId: string;
              body: string;
              createdAt: string;
            }>;
            const runtime = (value as { runtime: Record<string, unknown> })
              .runtime;
            runtime.deliveries = inputs.map((input) => ({
              inputId: input.id,
              state: "running",
              error: null,
            }));
            runtime.activity = {
              available: true,
              truncated: false,
              openWorkComplete: true,
              threads: inputs.map((input) => ({
                id: `TEST-thread-${input.id}`,
                kind: "execution",
                inputId: input.id,
                projectId: input.projectId,
                conversationId: input.conversationId,
                rootId: `TEST-root-${input.id}`,
                sessionId: "TEST-session",
                title: input.body,
                phase: "running",
                lifecycle: "open",
                revision: 1,
                updatedAt: input.createdAt,
                continuation: {
                  mode: "supplement",
                  inputId: input.id,
                  threadId: `TEST-thread-${input.id}`,
                  generation: 1,
                },
              })),
            };
          }
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: applicationFailure(error) };
      }
    },
  );
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      __permissionHostInvoke(
        request: ApplicationInvocation,
      ): Promise<ApplicationReply>;
    };
    Object.defineProperty(window, "morphzDesktop", {
      configurable: true,
      value: {
        application: {
          invoke: (request: ApplicationInvocation) =>
            bridge.__permissionHostInvoke(request),
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
  const settings = previewMode
    ? page.locator(".composer-settings-menu")
    : await openComposerSettings(page);
  const approval = settings.getByLabel("当前会话审批方式", { exact: true });
  if (!previewMode) {
    await expect(approval).toHaveValue("request_approval");
    await expect(settings).not.toContainText("正在读取审批方式");
  }
  return {
    state,
    input,
    settings,
    approval,
    reads: () => calls.filter((c) => c.method === "session-permissions.read"),
    updates: () =>
      calls.filter((c) => c.method === "session-permissions.update"),
  };
}

async function seedScopes(page: Page) {
  const source = await conversationClient(page);
  const a = { id: randomUUID(), title: "TEST 审批项目 A" };
  const b = { id: randomUUID(), title: "TEST 审批项目 B" };
  await source.createProject(a.title, randomUUID(), a.id);
  await source.createProject(b.title, randomUUID(), b.id);
  const named = { id: randomUUID(), title: "TEST 独立审批会话" };
  await source.sendMessage({
    commandId: randomUUID(),
    projectId: b.id,
    conversationId: named.id,
    newConversation: { title: named.title },
    body: "TEST 真实独立会话首条输入，仅入队",
  });
  await page.reload();
  const group = (project: { title: string }) =>
    page.getByRole("group", { name: project.title + "的会话", exact: true });
  const parent = (project: { title: string }) =>
    group(project).getByRole("button", { name: project.title, exact: true });
  await expect(parent(a)).toBeVisible();
  const expand = group(b).getByRole("button", {
    name: "展开项目会话：" + b.title,
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  await expect(
    group(b).getByRole("button", {
      name: "打开对话：" + named.title,
      exact: true,
    }),
  ).toBeVisible();
  return { a, b, named, group, parent, source };
}

function approvalIcons(page: Page) {
  return {
    trigger: page
      .getByRole("button", { name: "执行设置", exact: true })
      .locator(".composer-approval-icon"),
    row: page.locator(
      ".composer-session-permissions .composer-setting-row > .composer-approval-icon",
    ),
  };
}

for (const zoom of [1, 2]) {
  test(`审批读回过程中不闪现说明、不改变弹层与工作画布几何 (${zoom * 100}%)`, async ({
    page,
    messageHost,
  }, testInfo) => {
    const { state, settings, approval } = await fixture(page, messageHost);
    if (zoom === 2) {
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      await openInput(page);
      await openComposerSettings(page);
      await expect(approval).toBeEnabled();
    }
    const geometry = () =>
      page.evaluate(() => {
        const selectors = [
          ".composer-settings-menu",
          ".composer",
          ".composer-action-bar",
          ".app",
        ];
        return selectors.map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect();
          return {
            selector,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          };
        });
      });
    const before = await geometry();
    state.hold();
    try {
      await approval.selectOption("auto_review");
      await expect.poll(() => state.updating).toBe(true);
      const pending = await geometry();
      await testInfo.attach("permission-pending-geometry", {
        body: JSON.stringify({ before, pending }),
        contentType: "application/json",
      });
      await testInfo.attach("permission-pending", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      expect(pending).toEqual(before);
      await expect(
        settings.locator(".composer-session-permissions"),
      ).toHaveAttribute("aria-busy", "true");
      await expect(approval).toBeDisabled();
      await expect(
        settings.locator(".composer-setting-row > [role=status]"),
      ).toHaveClass("visually-hidden");
      await expect(approval).toHaveAttribute("title", "正在确认审批方式…");
      const samples = await page.evaluate(async () => {
        const samples: string[] = [];
        for (let frame = 0; frame < 12; frame++) {
          await new Promise(requestAnimationFrame);
          samples.push(
            JSON.stringify(
              [
                ".composer-settings-menu",
                ".composer",
                ".composer-action-bar",
                ".app",
              ].map((selector) => {
                const box = document
                  .querySelector(selector)!
                  .getBoundingClientRect();
                return {
                  selector,
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                };
              }),
            ),
          );
        }
        return samples;
      });
      expect(samples.every((sample) => sample === JSON.stringify(before))).toBe(
        true,
      );
    } finally {
      state.release();
    }
    await expect(approval).toHaveValue("auto_review");
    await expect(approval).toBeEnabled();
    expect(await geometry()).toEqual(before);
  });
}

async function iconDrawing(icon: Locator) {
  return icon.evaluate((svg) => ({
    fill: getComputedStyle(svg).fill,
    nodes: Array.from(
      svg.querySelectorAll("path,circle,rect,line,polyline,polygon,ellipse"),
    ).map((node) => ({
      tag: node.tagName,
      attributes: Object.fromEntries(
        Array.from(node.attributes)
          .filter((attribute) =>
            /^(d|cx|cy|r|x|y|width|height|rx|ry|x1|x2|y1|y2|points)$/.test(
              attribute.name,
            ),
          )
          .map((attribute) => [attribute.name, attribute.value]),
      ),
    })),
  }));
}

/** Read actual rendered geometry and colour, not the component or CSS text. */
async function expectApprovalPresentation(page: Page, mode: Mode) {
  // Default icons inherit control colours; remove pointer hover before
  // comparing two controls with otherwise different interaction states.
  await page.mouse.move(0, 0);
  const icons = approvalIcons(page);
  await expect(icons.trigger).toHaveAttribute("data-approval-mode", mode);
  await expect(icons.row).toHaveAttribute("data-approval-mode", mode);
  await expect(icons.trigger).toHaveAttribute("aria-hidden", "true");
  await expect(icons.row).toHaveAttribute("aria-hidden", "true");
  const drawing = await iconDrawing(icons.trigger);
  expect(drawing.fill).toBe("none");
  const expectedNodes = {
    request_approval: [
      {
        tag: "path",
        attributes: {
          d: "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2",
        },
      },
      {
        tag: "path",
        attributes: { d: "M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" },
      },
      {
        tag: "path",
        attributes: { d: "M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" },
      },
      {
        tag: "path",
        attributes: {
          d: "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
        },
      },
    ],
    auto_review: [
      {
        tag: "path",
        attributes: {
          d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        },
      },
      { tag: "path", attributes: { d: "m8 10 3 3-3 3m5 0h3" } },
    ],
    full_access: [
      {
        tag: "path",
        attributes: {
          d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        },
      },
      { tag: "path", attributes: { d: "M12 8v4" } },
      { tag: "path", attributes: { d: "M12 16h.01" } },
    ],
  } satisfies Record<Mode, unknown>;
  // The user-selected hand / terminal shield / warning shield stay distinct
  // without changing approval behavior. Neither shield means a confirmed action.
  expect(drawing.nodes).toEqual(expectedNodes[mode]);
  expect(await iconDrawing(icons.row)).toEqual(drawing);
  await expect(icons.trigger).toHaveCSS("width", "16px");
  await expect(icons.trigger).toHaveCSS("height", "16px");
  for (const icon of [icons.trigger, icons.row]) {
    await expect(icon).toHaveCSS("stroke-width", "2px");
    await expect(icon).toHaveCSS("stroke-linecap", "round");
    await expect(icon).toHaveCSS("stroke-linejoin", "round");
  }
  const paths = JSON.stringify(drawing);
  const colour = await icons.trigger.evaluate(
    (svg) => getComputedStyle(svg).color,
  );
  // Neutral popup tokens intentionally differ slightly from the canvas.
  // Mode accents must match; shape and exact mode must match for all three.
  if (mode !== "request_approval")
    await expect(icons.row).toHaveCSS("color", colour);
  return { paths, colour };
}

for (const mode of [
  "request_approval",
  "auto_review",
  "full_access",
] as const) {
  test(`未打开设置也主动读回 ${mode} 图标，刷新后不退回空盾牌`, async ({
    page,
    messageHost,
  }, info) => {
    const f = await fixture(page, messageHost, false, mode);
    await expect(f.settings).not.toBeVisible();
    await expect.poll(() => f.reads().length).toBeGreaterThan(0);
    await expectApprovalPresentation(page, mode);
    await page.screenshot({ path: info.outputPath(`closed-${mode}.png`) });
    const before = await conversationState(page);
    await page.reload();
    await openInput(page);
    await expect(f.settings).not.toBeVisible();
    await expectApprovalPresentation(page, mode);
    expect(f.updates()).toHaveLength(0);
    expect(messageHost.deliveries()).toHaveLength(0);
    expect((await conversationState(page)).conversations).toEqual(
      before.conversations,
    );
  });
}

test("真实 Host 首次发送前只读安全默认：打开读取不创建 Session、输入或命名会话", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost, true);
  const before = await conversationState(page);
  await expect(f.approval).toBeDisabled();
  await expect(f.settings).toContainText("首次发送后可调整");
  await f.settings.locator("summary").click();
  await expect(f.settings).toContainText("首次发送后可查看默认工作目录");
  await expect(f.settings).not.toContainText("not_started");
  await page.keyboard.press("Escape");
  await f.input.fill("TEST 未发送草稿，审批读取不能改变它");
  const readCount = f.reads().length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(
      () =>
        f.state.calls.filter((c) => c.method === "platform.bootstrap").length,
    )
    .toBeGreaterThan(1);
  expect(f.reads()).toHaveLength(readCount);
  await openComposerSettings(page);
  await expect.poll(() => f.reads().length).toBeGreaterThan(readCount);
  await expect(f.input).toHaveValue("TEST 未发送草稿，审批读取不能改变它");
  expect((await conversationState(page)).conversations).toEqual(
    before.conversations,
  );
  expect(messageHost.deliveries()).toHaveLength(0);
  expect(messageHost.transport.runtimeState()).toBeNull();
  expect(f.updates()).toHaveLength(0);
});

test("未发送的命名草稿不调用 Session API，不预存权限；模型仍只配置下一次输入", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  const scopes = await seedScopes(page);
  const before = await conversationState(page);
  await scopes
    .group(scopes.a)
    .getByRole("button", {
      name: "新建项目对话：" + scopes.a.title,
      exact: true,
    })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 独立草稿，不发送不建 Session");
  const readCount = f.reads().length;
  const settings = await openComposerSettings(page);
  await expect(
    settings.getByLabel("当前会话审批方式", { exact: true }),
  ).toBeDisabled();
  await expect(settings).toContainText("首次发送后可调整");
  await chooseReasoning(
    settings.getByLabel("本次输入推理强度", { exact: true }),
    "high",
  );
  await expect(settings).not.toContainText("模型与推理仅用于下一次发送");
  const trigger = page.getByRole("button", {
    name: "执行设置",
    exact: true,
  });
  await expect(trigger).toHaveAccessibleDescription(
    /模型与推理用于后续新输入，不改变已提交工作/,
  );
  await expect(trigger).toHaveAttribute(
    "title",
    /用于后续新输入，不改变已提交工作/,
  );
  await expect(
    settings.getByLabel("本次输入模型", { exact: true }),
  ).toHaveAttribute("title", /用于后续新输入，不改变已提交工作/);
  expect(f.reads()).toHaveLength(readCount);
  expect(f.updates()).toHaveLength(0);
  expect((await conversationState(page)).conversations).toEqual(
    before.conversations,
  );
  await expect(input).toHaveValue("TEST 独立草稿，不发送不建 Session");
  expect(messageHost.deliveries()).toHaveLength(1);
});

test("默认工作目录取执行节点路径且不等于额外授权；全局审批跨项目持续，独立会话隔离", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  await f.settings.locator("summary").click();
  const defaultWorkspace = f.settings.locator(
    ".composer-default-workspace code",
  );
  const defaultPath = join(
    messageHost.directory,
    "TEST-node-default",
    "工作目录长路径".repeat(12),
  );
  await expect(defaultWorkspace).toHaveText(defaultPath);
  await expect(defaultWorkspace).toHaveAttribute("title", defaultPath);
  await expect(defaultWorkspace).toHaveAccessibleDescription(
    "执行节点：TEST-local-default-node",
  );
  await expect(f.settings).not.toContainText("TEST-local-default-node");
  await expect(
    f.settings.locator(".composer-default-workspace small"),
  ).toHaveCount(0);
  const directoryDescription =
    "额外目录仅当前对话与工作空间可读写，持续有效直到撤销。目录授权不含执行命令或删除文件；撤销会阻止进行中工作的后续目录访问。";
  const directoryDetails = f.settings.locator(".composer-directory-details");
  await expect(directoryDetails).toHaveAttribute("title", directoryDescription);
  await expect(directoryDetails).toHaveAccessibleDescription(
    directoryDescription,
  );
  await expect(directoryDetails).not.toContainText(
    "额外目录仅当前对话与工作空间可读写",
  );
  await expect(directoryDetails).not.toContainText(
    "目录授权不含执行命令或删除文件",
  );
  await expect(f.settings).not.toContainText("未授权");
  const scopes = await seedScopes(page);
  await scopes.parent(scopes.a).click();
  const input = await openInput(page);
  await input.fill("TEST 全局草稿 A");
  const projectAssociation = page.locator(".composer-scope-label");
  await expect(projectAssociation).toContainText(scopes.a.title);
  await expect(projectAssociation).not.toHaveAttribute("role", "button");
  await expect(projectAssociation).not.toHaveAttribute("tabindex");
  await expect(projectAssociation).toHaveAttribute("title", scopes.a.title);
  await openComposerSettings(page);
  await expect(f.approval).toBeEnabled();
  const firstRead = f.reads().at(-1)!;
  expect(firstRead.params).toMatchObject({
    projectId: scopes.a.id,
    conversationId: f.state.globalConversationId,
  });
  await f.approval.selectOption("auto_review");
  await expect(f.approval).toHaveValue("auto_review");
  await expect(f.settings).not.toContainText("可能拒绝或交由你批准");
  await expect(f.approval).toHaveAccessibleDescription(
    /当前全局会话持续生效，跨项目.*自动安全评审，可能拒绝或交由你批准/,
  );
  await expect(f.approval).toHaveAttribute(
    "title",
    /当前全局会话持续生效，跨项目/,
  );
  await expect(f.settings).not.toContainText("当前全局会话持续生效，跨项目");
  await expect(
    page.getByRole("button", { name: "执行设置", exact: true }),
  ).toHaveAccessibleDescription(/审批在当前全局会话持续生效，跨项目/);
  await expectApprovalPresentation(page, "auto_review");
  await page.keyboard.press("Escape");
  await scopes.parent(scopes.b).click();
  await openInput(page);
  await openComposerSettings(page);
  await expect(f.approval).toHaveValue("auto_review");
  await expectApprovalPresentation(page, "auto_review");
  expect(f.reads().at(-1)!.params).toEqual({
    projectId: scopes.b.id,
    conversationId: f.state.globalConversationId,
  });
  await page.keyboard.press("Escape");
  await scopes
    .group(scopes.b)
    .getByRole("button", {
      name: "打开对话：" + scopes.named.title,
      exact: true,
    })
    .click();
  await openInput(page);
  await openComposerSettings(page);
  await expect(f.approval).toHaveValue("request_approval");
  await expect(page.locator(".composer-scope-label")).toContainText(
    scopes.b.title,
  );
  await expectApprovalPresentation(page, "request_approval");
  await expect(f.approval).toHaveAccessibleDescription(/仅当前会话持续生效/);
  await expect(f.approval).toHaveAttribute("title", /仅当前会话持续生效/);
  await expect(f.settings).not.toContainText("仅当前会话持续生效");
  await expect(f.settings).not.toContainText("当前全局会话持续生效");
  await expect(
    page.getByRole("button", { name: "执行设置", exact: true }),
  ).toHaveAccessibleDescription(/审批仅当前会话持续生效/);
  expect(f.reads().at(-1)!.params).toEqual({
    projectId: scopes.b.id,
    conversationId: scopes.named.id,
  });
  expect(messageHost.deliveries()).toHaveLength(1);
});

test("三种已读回审批模式有不同图形与颜色，触发器和审批行一致且收起后可识别", async ({
  page,
  messageHost,
}, info) => {
  const f = await fixture(page, messageHost);
  const presentations = [
    await expectApprovalPresentation(page, "request_approval"),
  ];
  expect(await f.approval.locator("option").allTextContents()).toEqual([
    "询问批准",
    "自动审批",
    "完全访问",
  ]);
  await f.settings.screenshot({
    path: info.outputPath("approval-request.png"),
  });
  await approvalIcons(page).trigger.screenshot({
    path: info.outputPath("approval-request-16px.png"),
  });
  for (const mode of ["auto_review", "full_access"] as const) {
    await f.approval.selectOption(mode);
    if (mode === "full_access")
      await f.settings
        .getByRole("group", { name: "确认完全访问", exact: true })
        .getByRole("button", { name: "确认完全访问", exact: true })
        .click();
    await expect(f.approval).toHaveValue(mode);
    presentations.push(await expectApprovalPresentation(page, mode));
    await f.settings.screenshot({
      path: info.outputPath(`approval-${mode}.png`),
    });
    await approvalIcons(page).trigger.screenshot({
      path: info.outputPath(`approval-${mode}-16px.png`),
    });
    await page.keyboard.press("Escape");
    await expect(f.settings).not.toBeVisible();
    await expect(approvalIcons(page).trigger).toHaveAttribute(
      "data-approval-mode",
      mode,
    );
    await openComposerSettings(page);
    await expect(f.approval).toHaveValue(mode);
    expect(await expectApprovalPresentation(page, mode)).toEqual(
      presentations.at(-1),
    );
  }
  expect(new Set(presentations.map((value) => value.paths)).size).toBe(3);
  expect(new Set(presentations.map((value) => value.colour)).size).toBe(3);
  expect(f.updates()).toHaveLength(2);
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("完全访问先显示准确风险，取消及 Escape 均不提交；明确确认才写持久会话策略", async ({
  page,
  messageHost,
}, info) => {
  const f = await fixture(page, messageHost);
  const originalIcon = await expectApprovalPresentation(
    page,
    "request_approval",
  );
  await f.settings.screenshot({
    path: info.outputPath("permissions-normal.png"),
  });
  await page.keyboard.press("Escape");
  await f.input.fill("TEST 完全访问确认不得丢失草稿");
  await openComposerSettings(page);
  const confirm = f.settings.getByRole("group", {
    name: "确认完全访问",
    exact: true,
  });
  for (const cancel of ["click", "escape"] as const) {
    await f.approval.selectOption("full_access");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("执行沙盒切为完全访问");
    await expect(confirm).toContainText("此全局会话跨项目生效");
    await expect(confirm).toContainText("不改变系统或项目权限");
    await expect(
      confirm.getByRole("button", { name: "取消", exact: true }),
    ).toBeFocused();
    await expect(f.approval).toHaveValue("request_approval");
    expect(await expectApprovalPresentation(page, "request_approval")).toEqual(
      originalIcon,
    );
    if (cancel === "click") {
      await page.setViewportSize({ width: 390, height: 540 });
      await expect(
        confirm.getByRole("button", { name: "确认完全访问", exact: true }),
      ).toBeInViewport();
      await f.settings.screenshot({
        path: info.outputPath("full-access-confirm-390.png"),
      });
    }
    if (cancel === "click")
      await confirm.getByRole("button", { name: "取消", exact: true }).click();
    else await page.keyboard.press("Escape");
    await expect(confirm).not.toBeVisible();
    await expect(f.settings).toBeVisible();
    await expect(f.approval).toBeFocused();
    expect(await expectApprovalPresentation(page, "request_approval")).toEqual(
      originalIcon,
    );
    expect(f.updates()).toHaveLength(0);
  }
  await f.approval.selectOption("full_access");
  await confirm
    .getByRole("button", { name: "确认完全访问", exact: true })
    .click();
  await expect(f.approval).toHaveValue("full_access");
  await expectApprovalPresentation(page, "full_access");
  expect(f.updates()).toHaveLength(1);
  expect(f.updates()[0]!.params).toMatchObject({
    permissionMode: "full_access",
    confirmation: true,
    expectedFingerprint: "1".padStart(64, "0"),
  });
  expect(f.updates()[0]!.identityGeneration).toBe(f.state.originalGeneration);
  await expect(f.input).toHaveValue("TEST 完全访问确认不得丢失草稿");
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("策略冲突和读取失败不会乐观授权或自动重写；主动重读失败仍守门", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  const originalDrawing = await iconDrawing(approvalIcons(page).row);
  f.state.failUpdate = true;
  await f.approval.selectOption("auto_review");
  await expect(f.settings.getByRole("alert")).toContainText(
    "TEST 审批策略已变化",
  );
  await expect(f.approval).toHaveValue("request_approval");
  await expect(f.approval).toBeDisabled();
  await expect(approvalIcons(page).row).toHaveAttribute(
    "data-approval-mode",
    "request_approval",
  );
  expect(await iconDrawing(approvalIcons(page).row)).toEqual(originalDrawing);
  await expect(approvalIcons(page).trigger).toHaveAttribute(
    "data-approval-mode",
    "unread",
  );
  const trigger = page.getByRole("button", { name: "执行设置", exact: true });
  await expect(trigger).toHaveAccessibleDescription(/审批方式尚未读取/);
  await expect(trigger).toHaveAttribute("title", /审批方式尚未读取/);
  expect(f.updates()).toHaveLength(1);
  f.state.failRead = true;
  await f.settings
    .getByRole("button", { name: "重新读取", exact: true })
    .click();
  await expect(f.settings.getByRole("alert")).toContainText(
    "TEST 审批读取失败",
  );
  await expect(f.approval).toBeDisabled();
  await expect(f.approval).toHaveValue("request_approval");
  await expect(approvalIcons(page).trigger).toHaveAttribute(
    "data-approval-mode",
    "unread",
  );
  expect(f.updates()).toHaveLength(1);
  f.state.failRead = false;
  await f.settings
    .getByRole("button", { name: "重新读取", exact: true })
    .click();
  await expect(f.approval).toBeEnabled();
  await expect(f.approval).toHaveValue("request_approval");
  await expectApprovalPresentation(page, "request_approval");
  expect(f.updates()).toHaveLength(1);
  // A confirmed request is still not a confirmed Runtime policy. A failed
  // full-access write must not colour either presentation as full access.
  await f.approval.selectOption("full_access");
  const confirmation = f.settings.getByRole("group", {
    name: "确认完全访问",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "确认完全访问", exact: true })
    .click();
  await expect(f.settings.getByRole("alert")).toContainText(
    "TEST 审批策略已变化",
  );
  await expect(confirmation).not.toBeVisible();
  await expect(f.approval).toHaveValue("request_approval");
  await expect(f.approval).toBeDisabled();
  await expect(approvalIcons(page).row).toHaveAttribute(
    "data-approval-mode",
    "request_approval",
  );
  expect(await iconDrawing(approvalIcons(page).row)).toEqual(originalDrawing);
  await expect(approvalIcons(page).trigger).toHaveAttribute(
    "data-approval-mode",
    "unread",
  );
  expect(f.updates()).toHaveLength(2);
  expect(f.updates()[1]!.params).toMatchObject({
    permissionMode: "full_access",
    confirmation: true,
  });
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("未知继承策略不冒充询问批准；远端本机限制与目录内部原因均如实展示", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  f.state.readOnly = "team_managed";
  f.state.unknownPolicy = true;
  f.state.workspaceReason = "selected_target_offline";
  await page.keyboard.press("Escape");
  await openComposerSettings(page);
  await expect(f.approval).toHaveValue("");
  await expect(f.approval.locator("option:checked")).toHaveText(
    "审批方式待核对",
  );
  await expect(f.approval).toBeDisabled();
  await expect(f.settings).toContainText("此会话由团队管理");
  await f.settings.locator("summary").click();
  await expect(f.settings).toContainText("执行节点离线");
  await expect(f.settings).not.toContainText("selected_target_offline");
  for (const [reason, text] of [
    ["workspace_root_unavailable", "尚未配置默认工作目录"],
    ["TEST-new-internal-code", "默认工作目录暂不可用"],
  ]) {
    f.state.workspaceReason = reason!;
    await page.keyboard.press("Escape");
    await openComposerSettings(page);
    await expect(f.settings.locator(`p[title="${reason}"]`)).toContainText(
      text!,
    );
    await expect(f.settings).not.toContainText(reason!);
  }
  f.state.unknownPolicy = false;
  f.state.readOnly = "local_only";
  await page.keyboard.press("Escape");
  await openComposerSettings(page);
  await expect(f.settings).toContainText("请在本机 Morphz 调整");
  await expect(f.settings).not.toContainText("此会话由团队管理");
  await expect(f.approval).toBeDisabled();
  expect(f.updates()).toHaveLength(0);
});

for (const switchTo of ["project", "named"] as const) {
  test(`保存期间切换 ${switchTo}：旧回执不串范围，完成后新范围必读取`, async ({
    page,
    messageHost,
  }) => {
    const f = await fixture(page, messageHost);
    const scopes = await seedScopes(page);
    await scopes.parent(scopes.a).click();
    const input = await openInput(page);
    await input.fill("TEST 原工作草稿，写回不能抢导航");
    await openComposerSettings(page);
    await expect(f.approval).toBeEnabled();
    const original = f.reads().at(-1)!;
    const originalIcon = await expectApprovalPresentation(
      page,
      "request_approval",
    );
    f.state.hold();
    await f.approval.selectOption("auto_review");
    await expect.poll(() => f.state.updating).toBe(true);
    await expect(f.approval).toBeDisabled();
    expect(await expectApprovalPresentation(page, "request_approval")).toEqual(
      originalIcon,
    );
    if (switchTo === "project") await scopes.parent(scopes.b).click();
    else
      await scopes
        .group(scopes.b)
        .getByRole("button", {
          name: "打开对话：" + scopes.named.title,
          exact: true,
        })
        .click();
    const nextInput = await openInput(page);
    await nextInput.fill("TEST 新范围草稿");
    await openComposerSettings(page);
    // The old scope's last read and pending mutation are not a preview of the
    // newly selected scope, even when both projects share a global Session.
    await expect(approvalIcons(page).trigger).toHaveAttribute(
      "data-approval-mode",
      "unread",
    );
    await expect(approvalIcons(page).row).toHaveAttribute(
      "data-approval-mode",
      "unread",
    );
    f.state.release();
    const nextScope = {
      projectId: scopes.b.id,
      conversationId:
        switchTo === "project" ? f.state.globalConversationId : scopes.named.id,
    };
    await expect
      .poll(() =>
        f
          .reads()
          .some(
            (read) => JSON.stringify(read.params) === JSON.stringify(nextScope),
          ),
      )
      .toBe(true);
    await expect(f.approval).toBeEnabled();
    await expect(f.approval).toHaveValue(
      switchTo === "project" ? "auto_review" : "request_approval",
    );
    await expectApprovalPresentation(
      page,
      switchTo === "project" ? "auto_review" : "request_approval",
    );
    expect(f.updates()[0]!.params).toMatchObject(
      original.params as Record<string, unknown>,
    );
    expect(f.updates()).toHaveLength(1);
    await expect(nextInput).toHaveValue("TEST 新范围草稿");
    await expect(page).toHaveTitle(scopes.b.title + " — Morphz");
    if (switchTo === "named")
      await expect(
        scopes.group(scopes.b).getByRole("button", {
          name: "打开对话：" + scopes.named.title,
          exact: true,
        }),
      ).toHaveAttribute("aria-current", "true");
    expect(messageHost.deliveries()).toHaveLength(1);
  });
}

test("身份代次变化时迟到写回不覆盖新身份；新读取显式绑定新代次", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  const original = f.state.originalGeneration;
  f.state.hold();
  await f.approval.selectOption("auto_review");
  await expect.poll(() => f.state.updating).toBe(true);
  f.state.rotatedGeneration = "TEST-rotated-session-generation";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(
      () =>
        f.state.calls.filter((c) => c.method === "platform.bootstrap").length,
    )
    .toBeGreaterThan(1);
  // Workspace identity protection deliberately unmounts the old controller.
  // Reopen the new identity's own panel before delivering the old response.
  await expect(f.settings).not.toBeVisible();
  await openInput(page);
  await openComposerSettings(page);
  f.state.release();
  await expect
    .poll(() =>
      f
        .reads()
        .some((read) => read.identityGeneration === f.state.rotatedGeneration),
    )
    .toBe(true);
  await expect(f.approval).toBeEnabled();
  await expect(f.approval).toHaveValue("request_approval");
  await expectApprovalPresentation(page, "request_approval");
  expect(f.updates()[0]!.identityGeneration).toBe(original);
  expect(f.updates()).toHaveLength(1);
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("390 窄窗和 200% 放大不溢出；键盘可抵达审批和目录，不恢复整行高亮", async ({
  page,
  messageHost,
}, info) => {
  const f = await fixture(page, messageHost);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(f.settings).toBeInViewport();
    expect(
      await f.settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    const box = (await f.settings.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(7);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 7);
    await f.settings.locator("summary").click();
    await expect(
      f.settings.locator(".composer-default-workspace code"),
    ).toBeVisible();
    expect(
      await f.settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await f.settings.locator("summary").click();
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await openInput(page);
  await openComposerSettings(page);
  await expect(f.approval).toBeInViewport();
  await expect(f.settings.locator("summary")).toBeInViewport();
  expect(
    await f.settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await f.settings.screenshot({
    path: info.outputPath("permissions-200-percent.png"),
  });
  await expect(
    f.settings.getByLabel("本次输入模型", { exact: true }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  const media = await openComposerMedia(page);
  await expect(
    media.getByRole("button", { name: "附加文件", exact: true }),
  ).toBeInViewport();
  await expect(
    media.getByRole("button", { name: "截图输入", exact: true }),
  ).toBeInViewport();
  expect(
    await media.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.keyboard.press("Escape");
  const association = page.locator(".composer-scope-label");
  await expect(association).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "输入关联", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "本次输入关联", exact: true }),
  ).not.toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await page.keyboard.press("Escape");
  const trigger = page.getByRole("button", { name: "执行设置", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(f.settings).toBeFocused();
  for (const name of ["本次输入模型", "本次输入推理强度", "当前会话审批方式"]) {
    const select = f.settings.getByLabel(name, { exact: true });
    const idleBackground = await select
      .locator("..")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    if (name === "当前会话审批方式")
      expect(idleBackground).toBe(
        await f.settings
          .locator("summary")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      );
    else expect(idleBackground).toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Tab");
    await expect(select).toBeFocused();
    await expect(select).toHaveCSS("outline-width", "1px");
    await expect(select.locator("..")).toHaveCSS(
      "background-color",
      idleBackground,
    );
  }
  await page.keyboard.press("Tab");
  await expect(f.settings.locator("summary")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(f.settings.locator("details")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("补充工作沿用原授权，不因当前范围打开设置而读取或修改 Session", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  const source = await conversationClient(page);
  const scope = f.reads().at(-1)!.params as Scope;
  const id = randomUUID();
  await source.sendMessage({
    commandId: id,
    ...scope,
    body: "TEST 原工作执行中，只验证补充入口",
  });
  f.state.continuation = true;
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  await supplementExchangeWork(
    page,
    page.locator(`.human-message[data-input-id="${id}"]`),
    { inputId: id, body: "TEST 原工作执行中，只验证补充入口" },
  );
  const input = await openInput(page);
  await input.fill("TEST 保持原工作补充草稿");
  await expect(page.locator(".composer-scope-label")).toContainText(
    "补充原工作",
  );
  await expect(
    page.getByRole("button", { name: "输入关联", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "本次输入关联", exact: true }),
  ).toHaveCount(0);
  const readCount = f.reads().length;
  await openComposerSettings(page);
  await expect(f.settings).toContainText("补充沿用原工作的模型、推理与授权");
  await expect(f.approval).not.toBeVisible();
  expect(f.reads()).toHaveLength(readCount);
  expect(f.updates()).toHaveLength(0);
  await expect(input).toHaveValue("TEST 保持原工作补充草稿");
  expect(messageHost.deliveries()).toHaveLength(1);
});

test("真正可操作的事项关联仍可展开，移除意图后隐藏空范围而不发送草稿", async ({
  page,
  messageHost,
}) => {
  const f = await fixture(page, messageHost);
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await page.getByRole("button", { name: "新建事项", exact: true }).click();
  const input = await openInput(page);
  await input.fill("TEST 有明确事项意图的草稿，暂不发送");
  const readCount = f.reads().length;
  await page.getByRole("button", { name: "输入关联", exact: true }).click();
  const association = page.getByRole("group", {
    name: "本次输入关联",
    exact: true,
  });
  await expect(association).toBeVisible();
  await expect(association.locator(".context-chip")).toHaveText("无项目");
  await expect(association).not.toContainText("未归项目");
  await expect(
    association.getByRole("button", { name: "移除输入意图", exact: true }),
  ).toBeVisible();
  await association
    .getByRole("button", { name: "移除输入意图", exact: true })
    .click();
  await expect(page.locator(".composer-scope-label")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "输入关联", exact: true }),
  ).toHaveCount(0);
  await expect(association).toHaveCount(0);
  await expect(input).toHaveValue("TEST 有明确事项意图的草稿，暂不发送");
  await expect(input).toBeFocused();
  expect(f.reads()).toHaveLength(readCount);
  expect(f.updates()).toHaveLength(0);
  expect(messageHost.deliveries()).toHaveLength(0);
});
