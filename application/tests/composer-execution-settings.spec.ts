import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  applicationFailure,
  invokeApplication,
} from "../packages/application/src/application.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";
import type { SessionPermissionsSnapshot } from "../packages/core/src/session-permissions.js";
import { test, expect } from "./project-conversation-fixture.js";
import { platformMessageFixture } from "./platform-message-fixture.js";
import { openInput, openComposerSettings } from "./interaction-helpers.js";
import { chooseReasoning } from "./reasoning-helpers.js";

const modelId = "isolated-project-conversation-model";
const longModelName = "TEST 很长的真实目录授权回归模型名称 ".repeat(12);
type Host = Awaited<ReturnType<typeof platformMessageFixture>>;
type Scope = { projectId: string; conversationId: string };
test.use({ localFiles: true });

/** Only the IPC transport and native chooser are controlled. Directory scope,
 * grants, revoke, message admission and the frozen outbox use the real Host.
 * The catalog and connected status are presentation data: dispatch remains
 * stopped, so the fixture proves queued configuration, not model execution. */
async function desktopFixture(page: Page, host: Host) {
  const files = host.localFiles!;
  const directory = join(host.directory, "TEST-editor-directory");
  mkdirSync(directory);
  const calls: ApplicationInvocation[] = [];
  const state = {
    choice: "add" as "add" | "cancel" | "fail",
    failRevoke: false,
    chooseCount: 0,
    scope: undefined as Scope | undefined,
    files,
    calls,
    hold: () => {},
    release: () => {},
  };
  let chooserGate: Promise<void> | undefined;
  let releaseChooser: (() => void) | undefined;
  state.hold = () => {
    chooserGate = new Promise<void>((resolve) => {
      releaseChooser = resolve;
    });
  };
  state.release = () => {
    releaseChooser?.();
    chooserGate = undefined;
  };
  await page.exposeBinding(
    "__composerHostInvoke",
    async (
      _source,
      request: ApplicationInvocation,
    ): Promise<ApplicationReply> => {
      calls.push(structuredClone(request));
      if (request.method === "directories.list")
        state.scope = request.params as Scope;
      if (request.method === "session-permissions.read") {
        const scope = request.params as Scope;
        const snapshot: SessionPermissionsSnapshot = {
          scope: { ...scope, kind: "global" },
          runtimeSessionId: null,
          permissionMode: "request_approval",
          sandboxMode: "workspace-write",
          reviewer: "user",
          source: "safe_default",
          canUpdate: false,
          readOnlyReason: "not_started",
          fingerprint: null,
          workspace: {
            targetId: null,
            targetName: null,
            workspaceRoot: null,
            ready: false,
            reason: "not_started",
          },
        };
        return { ok: true, value: snapshot };
      }
      if (request.method === "models")
        return {
          ok: true,
          value: {
            current: modelId,
            options: [
              {
                id: modelId,
                label: longModelName,
                supported_reasoning_efforts: [
                  "none",
                  "low",
                  "medium",
                  "high",
                  "max",
                ],
              },
            ],
            reasoning: {
              current: "medium",
              levels: ["none", "low", "medium", "high", "max"],
            },
          },
        };
      if (request.method === "directories.revoke" && state.failRevoke)
        return {
          ok: false,
          error: {
            status: 503,
            code: "unavailable",
            message: "TEST 撤销失败，原授权保持有效",
          },
        };
      try {
        let value: unknown = await invokeApplication(
          host.session(),
          request.method,
          request.params,
          request.identityGeneration || "test-composer-generation",
          new AbortController().signal,
        );
        // The isolated Runtime fixture deliberately stops dispatch and has no
        // connection projection. Let the composer expose its settings without
        // fabricating a Session, delivery, model reply or execution outcome.
        const connectedStatus = (runtime: Record<string, unknown>) => ({
          ...runtime,
          configured: true,
          connected: true,
          model: modelId,
        });
        if (request.method === "runtime.snapshot")
          value = connectedStatus(value as Record<string, unknown>);
        else if (
          request.method === "runtime.navigation" ||
          request.method === "conversations.history"
        ) {
          const projection = value as Record<string, unknown>;
          value = {
            ...projection,
            runtime: connectedStatus(
              projection.runtime as Record<string, unknown>,
            ),
          };
        }
        return {
          ok: true,
          value,
        };
      } catch (error) {
        return { ok: false, error: applicationFailure(error) };
      }
    },
  );
  await page.exposeBinding(
    "__composerDirectoryChoose",
    async (_source, scope: Scope) => {
      state.chooseCount++;
      await host.session().directoryScope(scope);
      await chooserGate;
      if (state.choice === "fail") throw new Error("TEST 目录选择失败");
      if (state.choice === "cancel") return null;
      return files.authorizeDirectory(
        directory,
        scope.projectId,
        scope.conversationId,
        localAccess,
      );
    },
  );
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      __composerHostInvoke(
        request: ApplicationInvocation,
      ): Promise<ApplicationReply>;
      __composerDirectoryChoose(scope: Scope): Promise<unknown>;
    };
    Object.defineProperty(window, "morphzDesktop", {
      configurable: true,
      value: {
        application: {
          invoke: (request: ApplicationInvocation) =>
            bridge.__composerHostInvoke(request),
          cancel: () => {},
          subscribe: async () => {},
          unsubscribe: () => {},
          onStream: () => () => {},
        },
        directories: {
          choose: (projectId: string, conversationId: string) =>
            bridge.__composerDirectoryChoose({ projectId, conversationId }),
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
  await expect(
    settings.getByLabel("本次输入模型", { exact: true }),
  ).toBeEnabled();
  await expect(settings.locator("summary")).toContainText("待核对");
  await expect.poll(() => state.scope).toBeTruthy();
  return { ...state, state, input, settings };
}

test("执行设置以强度、模型和滑轨为主，审批与目录同排；390×540 长模型名不撑破弹层", async ({
  page,
  messageHost,
}, info) => {
  const { input, settings } = await desktopFixture(page, messageHost);
  await page.keyboard.press("Escape");
  await input.fill("TEST 三行执行设置草稿，不发送");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 540 });
    await openComposerSettings(page);
    const heading = settings.locator(".composer-reasoning-heading");
    const modelRow = settings.locator(".composer-model-selector");
    const model = settings.getByLabel("本次输入模型", { exact: true });
    const rail = settings.getByLabel("本次输入推理强度", { exact: true });
    const footer = settings.locator(".composer-session-permissions");
    const approval = settings.locator(".composer-approval-choice");
    const directory = settings.locator(
      ".composer-directory-settings > summary",
    );
    for (const control of [
      heading,
      modelRow,
      rail,
      footer,
      approval,
      directory,
    ])
      await expect(control).toHaveCount(1);
    await expect(model).toBeEnabled();
    await expect(rail).toHaveAttribute("type", "range");
    await expect(
      approval.getByLabel("当前会话审批方式", { exact: true }),
    ).toBeDisabled();
    await expect(directory).toHaveAccessibleName(/工作目录/);
    await expect(settings.locator("details")).not.toHaveAttribute("open", "");
    const geometry = await settings.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        height: rect.height,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    expect(geometry.height).toBeLessThanOrEqual(280);
    expect(geometry.top).toBeGreaterThanOrEqual(7);
    expect(geometry.bottom).toBeLessThanOrEqual(533);
    expect(geometry.left).toBeGreaterThanOrEqual(7);
    expect(geometry.right).toBeLessThanOrEqual(width - 7);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    const layout = await settings.evaluate((element) => {
      const rect = (selector: string) => {
        const bounds = element.querySelector(selector)!.getBoundingClientRect();
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          centerX: (bounds.left + bounds.right) / 2,
          centerY: (bounds.top + bounds.bottom) / 2,
        };
      };
      return {
        heading: rect(".composer-reasoning-heading"),
        model: rect(".composer-model-selector select"),
        rail: rect(".composer-reasoning-rail input"),
        footer: rect(".composer-session-permissions"),
        approval: rect(".composer-approval-choice"),
        directory: rect(".composer-directory-settings > summary"),
      };
    });
    expect(layout.heading.bottom).toBeLessThanOrEqual(layout.model.top + 1);
    expect(layout.model.bottom).toBeLessThanOrEqual(layout.rail.top + 1);
    expect(layout.rail.bottom).toBeLessThanOrEqual(layout.footer.top + 1);
    expect(layout.rail.width).toBeGreaterThan(200);
    expect(
      Math.abs(layout.model.centerX - layout.heading.centerX),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(layout.approval.centerY - layout.directory.centerY),
    ).toBeLessThanOrEqual(1);
    expect(
      layout.directory.left - layout.approval.right,
    ).toBeGreaterThanOrEqual(4);
    expect(layout.directory.right).toBeLessThanOrEqual(layout.footer.right + 1);
    expect(
      layout.footer.bottom -
        Math.max(layout.approval.bottom, layout.directory.bottom),
    ).toBeLessThanOrEqual(2);
    // Duplicate field names remain available to assistive technology, but
    // cannot take a permanent text column from the primary/secondary controls.
    for (const label of [
      modelRow.locator(".visually-hidden"),
      approval.locator("span.visually-hidden"),
      directory.locator(".visually-hidden"),
    ]) {
      await expect(label).toHaveCount(1);
      await expect(label).toHaveCSS("clip-path", "inset(50%)");
      await expect(label).toHaveCSS("width", "1px");
    }
    await expect(model).toHaveAttribute("title", new RegExp("TEST 很长"));
    await expect(model).toHaveCSS("text-align-last", "center");
    await expect(model).toHaveCSS("text-overflow", "ellipsis");
    await model.selectOption(modelId);
    await expect(model).toHaveValue(modelId);
    await expect(input).toHaveValue("TEST 三行执行设置草稿，不发送");
    if (width === 390) {
      const overflow = await model.evaluate((element) => {
        const select = element as HTMLSelectElement;
        const style = getComputedStyle(select);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        context.font = style.font;
        return {
          textWidth: context.measureText(select.selectedOptions[0]!.label)
            .width,
          controlWidth: select.getBoundingClientRect().width,
        };
      });
      expect(overflow.textWidth).toBeGreaterThan(overflow.controlWidth);
      for (const appearance of ["light", "dark"] as const) {
        await page.evaluate((appearance) => {
          document.documentElement.dataset.appearance = appearance;
          document.querySelector<HTMLElement>(".app")!.dataset.appearance =
            appearance;
        }, appearance);
        await settings.screenshot({
          path: info.outputPath(
            `${appearance}-390-primary-secondary-settings.png`,
          ),
        });
      }
    }
    // Restore inheritance so keyboard traversal in the next opening does not
    // gain an enabled reset control, and prove selection never sends a message.
    await model.selectOption("");
    await expect(model).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(settings).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "执行设置", exact: true }),
    ).toBeFocused();
    await expect(input).toHaveValue("TEST 三行执行设置草稿，不发送");
  }
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("鼠标打开执行设置不高亮模型行或画选择器框，键盘主动导航仍可见且可操作", async ({
  page,
  messageHost,
}, info) => {
  const { input, settings } = await desktopFixture(page, messageHost);
  const trigger = page.getByRole("button", { name: "执行设置", exact: true });
  const model = settings.getByLabel("本次输入模型", { exact: true });
  const reasoning = settings.getByLabel("本次输入推理强度", { exact: true });
  const modelRow = settings.locator(".composer-model-selector");
  const neutralModel = async () => {
    const style = await model.evaluate((element) => {
      const select = getComputedStyle(element);
      const row = getComputedStyle(element.closest("label")!);
      return {
        background: row.backgroundColor,
        rowShadow: row.boxShadow,
        outline: select.outlineStyle,
        selectShadow: select.boxShadow,
        border: select.borderTopWidth,
      };
    });
    expect(style.background).toBe("rgba(0, 0, 0, 0)");
    expect(style.rowShadow).toBe("none");
    expect(style.outline).toBe("none");
    expect(style.selectShadow).toBe("none");
    expect(style.border).toBe("0px");
  };
  await expect(settings).toBeFocused();
  await expect(model).not.toBeFocused();
  const initial = await settings.boundingBox();
  for (const appearance of ["light", "dark"] as const) {
    await page.evaluate((appearance) => {
      document.documentElement.dataset.appearance = appearance;
      document.querySelector<HTMLElement>(".app")!.dataset.appearance =
        appearance;
    }, appearance);
    await neutralModel();
    await modelRow.hover();
    await neutralModel();
    await settings.screenshot({
      path: info.outputPath(`${appearance}-neutral-settings.png`),
    });
  }
  await page.keyboard.press("Escape");
  await input.fill("TEST 模型设置焦点保持草稿");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(settings).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(model).toBeFocused();
  await expect(settings).toHaveAttribute("data-keyboard-navigation", "true");
  await expect(model).toHaveCSS("outline-style", "solid");
  await expect(model).toHaveCSS("outline-width", "1px");
  await expect(modelRow).toHaveCSS("box-shadow", "none");
  await expect(modelRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await model.selectOption(modelId);
  await expect(model).toHaveValue(modelId);
  await page.keyboard.press("Tab");
  await expect(reasoning).toBeFocused();
  await expect(modelRow).toHaveCSS("box-shadow", "none");
  await expect(reasoning).toHaveCSS("outline-style", "solid");
  await expect(reasoning).toHaveCSS("outline-width", "1px");
  await page.keyboard.press("Tab");
  const directory = settings.locator("details > summary");
  await expect(directory).toBeFocused();
  await expect(directory).toHaveCSS("outline-style", "solid");
  await expect(directory).toHaveCSS("outline-width", "1px");
  await page.keyboard.press("Space");
  await expect(settings.locator("details")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue("TEST 模型设置焦点保持草稿");
  await trigger.click();
  await expect(settings).toBeFocused();
  await expect(settings).not.toHaveAttribute(
    "data-keyboard-navigation",
    "true",
  );
  await neutralModel();
  // Pointer navigation into a native select must not inherit its unconditional
  // :focus-visible appearance or leave the keyboard cue behind.
  await model.click();
  await neutralModel();
  await model.selectOption(modelId);
  expect((await settings.boundingBox())!.width).toBe(initial!.width);
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("模型推理绑定真实新输入；后续菜单与目录撤销不能修改已冻结的输入授权", async ({
  page,
  messageHost,
}) => {
  const fixture = await desktopFixture(page, messageHost);
  const { settings, input, state } = fixture;
  await page.keyboard.press("Escape");
  await input.fill("TEST 使用深入推理和目录授权的新输入");
  await openComposerSettings(page);
  await settings
    .getByLabel("本次输入模型", { exact: true })
    .selectOption(modelId);
  await chooseReasoning(
    settings.getByLabel("本次输入推理强度", { exact: true }),
    "high",
  );
  await expect(input).toHaveValue("TEST 使用深入推理和目录授权的新输入");
  await settings.locator("summary").click();
  await settings
    .getByRole("button", { name: "授权 Agent 读写目录", exact: true })
    .click();
  await expect(settings.locator("summary")).toContainText("额外 1 个");
  const scope = state.scope!;
  const grants = state.files.directories(
    scope.projectId,
    scope.conversationId,
    localAccess,
  );
  expect(grants).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^(发送消息|保存输入)$/ }).click();
  await expect.poll(() => messageHost.deliveries().length).toBe(1);
  const frozen = structuredClone(messageHost.deliveries()[0]!);
  expect(frozen.request.activation?.model_alias).toBe(modelId);
  expect(frozen.request.activation?.reasoning_effort).toBe("high");
  expect(frozen.platformSource.directories).toEqual(grants);
  const nextInput = await openInput(page);
  await nextInput.fill("TEST 下一条尚未发送的草稿");
  await openComposerSettings(page);
  await chooseReasoning(
    settings.getByLabel("本次输入推理强度", { exact: true }),
    "low",
  );
  const disclosure = settings.locator("details");
  if (
    !(await disclosure.evaluate(
      (element) => (element as HTMLDetailsElement).open,
    ))
  )
    await disclosure.locator("summary").click();
  await settings
    .getByRole("button", {
      name: "撤销 TEST-editor-directory 的读写权限",
      exact: true,
    })
    .click();
  await expect(settings.locator("summary")).toContainText("待核对");
  expect(
    state.files.directories(scope.projectId, scope.conversationId, localAccess),
  ).toEqual([]);
  expect(messageHost.deliveries()[0]).toEqual(frozen);
  await expect(nextInput).toHaveValue("TEST 下一条尚未发送的草稿");
  expect(messageHost.deliveries()).toHaveLength(1);
});

test("目录 details 和执行弹层关闭不卸载授权控制器、不额外读取或调用原生选择器", async ({
  page,
  messageHost,
}) => {
  const { input, settings, state } = await desktopFixture(page, messageHost);
  await page.keyboard.press("Escape");
  await input.fill("TEST disclosure 保持授权与草稿");
  await openComposerSettings(page);
  await settings.locator("summary").click();
  const directoryDetails = settings.locator(".composer-directory-details");
  // The permission boundary remains explicit in hover/accessibility details,
  // without repeating paragraphs in this compact directory disclosure.
  for (const attribute of ["title", "aria-description"]) {
    for (const boundary of [
      "额外目录仅当前对话与工作空间可读写，持续有效直到撤销",
      "不含执行命令或删除文件",
      "撤销会阻止进行中工作的后续目录访问",
    ])
      await expect(directoryDetails).toHaveAttribute(
        attribute,
        new RegExp(boundary),
      );
  }
  const listCount = state.calls.filter(
    (call) => call.method === "directories.list",
  ).length;
  for (let i = 0; i < 3; i++) {
    await settings.locator("summary").click();
    await expect(
      settings.getByRole("button", {
        name: "授权 Agent 读写目录",
        exact: true,
      }),
    ).not.toBeVisible();
    await page.keyboard.press("Escape");
    await openComposerSettings(page);
    await settings.locator("summary").click();
    await expect(
      settings.getByRole("button", {
        name: "授权 Agent 读写目录",
        exact: true,
      }),
    ).toBeVisible();
  }
  expect(
    state.calls.filter((call) => call.method === "directories.list"),
  ).toHaveLength(listCount);
  expect(
    state.calls.filter((call) => call.method === "directories.revoke"),
  ).toHaveLength(0);
  expect(state.chooseCount).toBe(0);
  await expect(input).toHaveValue("TEST disclosure 保持授权与草稿");
  expect(messageHost.deliveries()).toHaveLength(0);
});

test("原生目录取消、失败与撤销失败保留草稿和真实授权；进行中选择阻止发送并恢复焦点", async ({
  page,
  messageHost,
}) => {
  const { input, settings, state } = await desktopFixture(page, messageHost);
  await page.keyboard.press("Escape");
  await input.fill("TEST picker 取消和失败都不能清空草稿");
  await openComposerSettings(page);
  await settings.locator("summary").click();
  const authorize = settings.getByRole("button", {
    name: "授权 Agent 读写目录",
    exact: true,
  });
  await authorize.click();
  await expect(settings.locator("summary")).toContainText("额外 1 个");
  const scope = state.scope!;
  const original = structuredClone(
    state.files.directories(scope.projectId, scope.conversationId, localAccess),
  );
  state.choice = "cancel";
  state.hold();
  const beforeChoose = state.chooseCount;
  await authorize.click();
  await expect.poll(() => state.chooseCount).toBe(beforeChoose + 1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(settings.locator("summary")).toContainText("待核对");
  await expect(
    page.getByRole("button", { name: /^(发送消息|保存输入)$/ }),
  ).toBeDisabled();
  await expect(input).toBeVisible();
  state.release();
  await expect(settings.locator("summary")).toContainText("额外 1 个");
  await expect(authorize).toBeFocused();
  expect(
    state.files.directories(scope.projectId, scope.conversationId, localAccess),
  ).toEqual(original);
  state.choice = "fail";
  await authorize.click();
  await expect(page.getByText(/TEST 目录选择失败/)).toBeVisible();
  await expect(authorize).toBeFocused();
  await expect(input).toHaveValue("TEST picker 取消和失败都不能清空草稿");
  expect(
    state.files.directories(scope.projectId, scope.conversationId, localAccess),
  ).toEqual(original);
  state.failRevoke = true;
  await settings
    .getByRole("button", {
      name: "撤销 TEST-editor-directory 的读写权限",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("TEST 撤销失败，原授权保持有效", { exact: true }),
  ).toBeVisible();
  await expect(settings.locator("summary")).toContainText("额外 1 个");
  expect(
    state.files.directories(scope.projectId, scope.conversationId, localAccess),
  ).toEqual(original);
  await expect(input).toHaveValue("TEST picker 取消和失败都不能清空草稿");
  expect(messageHost.deliveries()).toHaveLength(0);
});
