import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openLibrary } from "./application-helpers.js";
import { openInput } from "./interaction-helpers.js";
import { humanTask, seedLibraryArtifact } from "./artifact-fixtures.js";
import type { Command } from "../packages/core/src/model.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";

test("模型列表按实际目录选择，只发送所选模型；失败保留输入与选择", async ({
  page,
}) => {
  let submitted: any = null;
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), "if-none-match": "" },
      });
      const navigation = await response.json();
      await route.fulfill({
        response,
        json: {
          ...navigation,
          runtime: {
            ...navigation.runtime,
            configured: true,
            connected: true,
            model: "model-a",
          },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history$/,
    (route) =>
      route.fulfill({
        json: {
          inputs: [],
          nextCursor: null,
          runtime: {
            configured: true,
            connected: true,
            model: "model-a",
            error: "",
            messages: [],
            deliveries: [],
          },
        },
      }),
  );
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        current: "model-a",
        reasoning: {
          current: "low",
          levels: ["none", "low", "medium", "high", "max"],
        },
        options: [
          { id: "model-a", label: "模型 A", sources: ["主用"] },
          { id: "model-b", label: "模型 B", sources: ["备用"] },
          {
            id: "model-c",
            label: "自动推理模型",
            supported_reasoning_efforts: [],
          },
        ],
      },
    }),
  );
  await page.route("**/api/platform/messages", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 503,
      json: { message: "隔离测试发送失败" },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("指定下一次模型");
  const select = page.getByLabel("本次输入模型");
  await expect(select).toBeVisible();
  await expect(select).toBeEnabled();
  await select.selectOption("model-b");
  await expect(select).toHaveValue("model-b");
  await expect(select).toContainText("模型 B · 备用");
  const effort = page.getByLabel("本次输入推理强度");
  await expect(effort).toBeEnabled();
  await effort.selectOption("high");
  await expect(select).toHaveAttribute("title", /仅用于下一次发送/);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => submitted?.operation?.model).toBe("model-b");
  await expect.poll(() => submitted?.operation?.reasoningEffort).toBe("high");
  await expect(input).toHaveValue("指定下一次模型");
  await expect(page.getByLabel("本次输入模型")).toHaveValue("model-b");
  await page.reload();
  await expect(effort).toHaveValue("high");
  await expect(page.getByLabel("本次输入模型")).toHaveValue("model-b");
  await expect(input).toHaveValue("指定下一次模型");
  await page.screenshot({ path: "test-results/audit-model-picker.png" });
  await select.selectOption("model-c");
  await expect(effort).toBeEnabled();
  await expect(effort).toHaveValue("high");
  await expect(
    page.getByText("请重新选择推理强度", { exact: true }),
  ).toBeVisible();
  await effort.selectOption("");
  await expect(effort).toBeDisabled();
  await expect(effort).toContainText("模型自动");
});

async function command(page: Page, operation: Command["operation"]) {
  const boot = await (await page.request.get("/api/platform/bootstrap")).json();
  const commandId = randomUUID();
  let path: string;
  let data: Record<string, unknown>;
  let entityId: string;
  if (operation.type === "create-project") {
    entityId = `audit_${randomUUID().replaceAll("-", "")}`;
    path = "/api/platform/projects";
    data = { commandId, projectId: entityId, title: operation.title };
  } else if (
    operation.type === "create-artifact" &&
    operation.content.kind === "document"
  ) {
    entityId = commandId;
    path = "/api/platform/documents";
    data = {
      commandId,
      objectId: entityId,
      projectId: operation.projectId,
      title: operation.title,
      markdown: operation.content.markdown,
    };
  } else if (
    operation.type === "create-artifact" &&
    operation.content.kind === "task"
  ) {
    entityId = commandId;
    path = "/api/platform/tasks";
    data = {
      commandId,
      taskId: entityId,
      projectId: operation.projectId,
      title: operation.title,
      description: operation.content.description,
      assigneeId: operation.content.assigneeId,
      modelId: operation.content.model,
      reasoningEffort: operation.content.reasoningEffort ?? null,
      notBefore: operation.content.notBefore,
      everySeconds: operation.content.everySeconds,
      ...(operation.content.dueDate
        ? { dueDate: operation.content.dueDate }
        : {}),
    };
  } else {
    throw new Error(`没有正式存储夹具：${operation.type}`);
  }
  const res = await page.request.post(path, {
    headers: {
      "X-Morphz-Token": boot.csrfToken,
      Origin: new URL(page.url()).origin,
    },
    data,
  });
  expect(res.ok(), await res.text()).toBe(true);
  if (
    operation.type === "create-artifact" &&
    operation.content.kind === "document"
  ) {
    const created = (await res.json()) as { contentId: string };
    return created.contentId;
  }
  return entityId;
}
async function desk(page: Page) {
  await page.goto("/");
  const title = "审计场景-" + randomUUID();
  const id = await command(page, { type: "create-project", title });
  await page.getByRole("button", { name: title, exact: true }).click();
  await openLibrary(page);
  return id;
}

test("事项可独立选择模型和思考深度，改派给人清除设置", async ({ page }) => {
  await desk(page);
  await seedLibraryArtifact(page, "任务模型设置", humanTask("检查任务设置"));
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        current: "model-a",
        reasoning: { current: "low", levels: ["low", "high"] },
        options: [
          { id: "model-a", label: "模型 A" },
          { id: "model-b", label: "模型 B" },
        ],
      },
    }),
  );
  let submitted: any = null;
  await page.route("**/api/platform/tasks/revise", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 503,
      json: { message: "隔离测试保留编辑状态" },
    });
  });
  await page.getByRole("button", { name: "手动编辑", exact: true }).click();
  const owner = page.getByLabel("事项负责人");
  const human = await owner.inputValue();
  await owner.selectOption("morphz-agent");
  await page.getByLabel("执行模型", { exact: true }).selectOption("model-b");
  await page.getByLabel("事项思考深度", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await expect.poll(() => submitted?.modelId).toBe("model-b");
  await expect.poll(() => submitted?.reasoningEffort).toBe("high");
  await expect(page.getByLabel("事项思考深度", { exact: true })).toHaveValue(
    "high",
  );
  await owner.selectOption(human);
  await expect(page.getByLabel("事项思考深度", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await expect.poll(() => submitted?.modelId).toBeNull();
  await expect.poll(() => submitted?.reasoningEffort).toBeNull();
});

test("资料 → A → B → 返回恢复对象、筛选和未发送草稿，不切换会话", async ({
  page,
}) => {
  const projectId = await desk(page);
  const b = await command(page, {
    type: "create-artifact",
    projectId,
    title: "返回测试 B",
    content: { kind: "document", markdown: "B 的正文" },
  });
  await command(page, {
    type: "create-artifact",
    projectId,
    title: "返回测试 A",
    content: {
      kind: "document",
      markdown: "[打开 B](artifact:" + b + ")\n\nA 的正文",
    },
  });
  await page.getByLabel("搜索内容").fill("返回测试 A");
  await page
    .locator(".artifact-card")
    .filter({ hasText: "返回测试 A" })
    .click();
  const input = await openInput(page);
  await input.fill("A 的未发送草稿");
  await page.getByRole("button", { name: "打开 B", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("返回测试 B");
  await page.getByLabel("返回上一位置").click();
  await expect(page.locator(".object-paper > h1")).toHaveText("返回测试 A");
  await openInput(page);
  await expect(input).toHaveValue("A 的未发送草稿");
  await page.getByLabel("返回上一位置").click();
  await expect(page.getByLabel("搜索内容")).toHaveValue("返回测试 A");
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await page.getByLabel("前往下一位置").click();
  await expect(page.locator(".object-paper > h1")).toHaveText("返回测试 A");
  await expect(
    page.locator(".project-conversation-row[aria-current=true]"),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/audit-navigation.png" });
});

test("Web 内容页不展示无法原位访问的文件入口，不再展示导入同步", async ({
  page,
}) => {
  await desk(page);
  const before = await (
    await page.request.get("/api/platform/content?limit=50")
  ).json();
  await expect(
    page.getByRole("button", { name: "导入资料", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开文件", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("工作空间选项").click();
  await expect(
    page.getByRole("button", { name: "资料导入与来源", exact: true }),
  ).toHaveCount(0);
  const after = await (
    await page.request.get("/api/platform/content?limit=50")
  ).json();
  expect(after).toEqual(before);
});

test("标记通知已读失败不阻止打开，恢复后补记；失去权限时拒绝读取", async ({
  page,
}) => {
  const projectId = await desk(page);
  const id = await command(page, {
    type: "create-artifact",
    projectId,
    title: "通知故障测试",
    content: humanTask(),
  });
  let fail = true,
    acknowledged = false,
    deny = false;
  await page.route("**/api/notifications", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().action === "read"
    ) {
      if (fail)
        return route.fulfill({
          status: 503,
          json: { message: "test-only read failure" },
        });
      acknowledged = true;
    }
    return route.continue();
  });
  await page.locator(".notification-trigger").click();
  await page
    .locator(".notification-dialog")
    .getByRole("button", { name: /通知故障测试/ })
    .click();
  await expect(page.locator(".object-paper > h1")).toHaveText("通知故障测试");
  expect(acknowledged).toBe(false);
  fail = false;
  await expect.poll(() => acknowledged, { timeout: 7000 }).toBe(true);
  await page.route(`**/api/platform/tasks/${id}`, async (route) => {
    if (deny)
      return route.fulfill({
        status: 403,
        json: { message: "已撤销访问权限" },
      });
    return route.continue();
  });
  await page.locator(".notification-trigger").click();
  deny = true;
  await page
    .locator(".notification-dialog")
    .getByRole("button", { name: /通知故障测试/ })
    .click();
  await expect(page.locator(".notification-dialog [role=alert]")).toContainText(
    /权限|身份/,
  );
  expect(id).toBeTruthy();
});

test("过时 blur 不覆盖最新输入焦点；关闭弹窗反复恢复草稿", async ({ page }) => {
  await desk(page);
  const input = await openInput(page);
  await input.fill("焦点保留");
  for (let n = 0; n < 4; n++) {
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.keyboard.press("Escape");
    await openInput(page);
    await page.evaluate(async () => {
      if (!document.hasFocus()) throw new Error("test browser has no focus");
      window.dispatchEvent(new Event("blur"));
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
    });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("焦点保留");
  }
  const b = (await page.locator(".composer").boundingBox())!;
  await page.mouse.click(b.x - 12, b.y + 12);
  await expect(input).toHaveCount(0);
});

test("交付回执直接打开准确版本；没有回执时不猜测产物", async ({ page }) => {
  const inputId = randomUUID();
  let inputProjectId = "";
  const identity: { principalId: string; actantId: string } = await (
    await page.request.get("/api/platform/bootstrap")
  ).json();
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch();
      const navigation = await response.json();
      await route.fulfill({
        response,
        json: {
          ...navigation,
          runtime: { ...navigation.runtime, configured: true },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
    async (route) => {
      const match = new URL(route.request().url()).pathname.match(
        /\/projects\/([^/]+)\/conversations\/([^/]+)\/history$/,
      );
      if (!match) throw new Error("Expected a Platform history request");
      inputProjectId = match[1]!;
      await route.fulfill({
        json: {
          inputs: [
            {
              id: inputId,
              projectId: match[1],
              conversationId: match[2],
              author: identity,
              targetActantId: "morphz-agent",
              body: "audit-output-request",
              createdAt: "2026-09-28T00:00:00.000Z",
            },
          ],
          nextCursor: null,
          runtime: { ...disconnectedRuntime, configured: true },
        },
      });
    },
  );
  const projectId = await desk(page);
  const artifactId = await command(page, {
    type: "create-artifact",
    projectId,
    title: "交付入口测试",
    content: { kind: "document", markdown: "真正保存的正文" },
  });
  const content: { appObjectId: string } = await (
    await page.request.get(`/api/platform/content/${artifactId}`)
  ).json();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(page.getByText("audit-output-request")).toBeVisible();
  let delivered = false;
  await page.route("**/api/platform/content/deliveries?**", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const data = delivered
      ? [
          {
            commandId: "fixture-output",
            operation: "record-content",
            inputId,
            sourceProjectId: inputProjectId,
            contentId: artifactId,
            projectId,
            appId: "morphz.objects",
            appObjectId: content.appObjectId,
            kind: "document",
            title: "交付入口测试",
            versionRef: "1",
            committedAt: new Date().toISOString(),
          },
        ]
      : [];
    await route.fulfill({ response, json: data });
  });
  await expect(page.getByLabel("打开交付：交付入口测试")).toHaveCount(0);
  delivered = true;
  await page.reload();
  await page.getByLabel("打开交付：交付入口测试").click();
  await expect(page.locator(".object-paper > h1")).toHaveText("交付入口测试");
  await expect(page.getByLabel("查看版本")).toHaveValue("1");
  await page.screenshot({ path: "test-results/audit-delivery.png" });
});

test("只保留紧凑连接提示；详情区分应用数据与智能体，模型故障不能伪装可选", async ({
  page,
}) => {
  await page.goto("/");
  await openInput(page);
  await expect(page.locator(".runtime-notice")).toHaveCount(0);
  await page
    .locator(".model-status")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "连接详情" });
  await expect(details).toContainText("应用数据");
  await expect(details).toContainText("可访问");
  await expect(details).toContainText("尚未连接");
  await expect(details).not.toContainText("工作中心");
  await page.screenshot({ path: "test-results/audit-connection.png" });
  await page.keyboard.press("Escape");
  await openInput(page);
  await expect(page.getByLabel("本次输入模型")).toBeDisabled();
  await expect(page.locator(".composer-reasoning")).toHaveAttribute(
    "title",
    "连接智能体后可设置推理强度。",
  );
});

test("推理设置区分加载、读取失败和旧服务缺少能力，不误报需要更新中心", async ({
  page,
}) => {
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), "if-none-match": "" },
      });
      const navigation = await response.json();
      await route.fulfill({
        response,
        json: {
          ...navigation,
          runtime: {
            ...navigation.runtime,
            configured: true,
            connected: true,
            model: "model-a",
          },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history$/,
    (route) =>
      route.fulfill({
        json: {
          inputs: [],
          nextCursor: null,
          runtime: {
            configured: true,
            connected: true,
            model: "model-a",
            error: "",
            messages: [],
            deliveries: [],
          },
        },
      }),
  );
  let release!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  let reasoningSupported = false;
  await page.route("**/api/models", async (route) => {
    requests++;
    if (requests === 1) {
      await firstRequest;
      await route.fulfill({
        status: 503,
        json: { message: "测试：暂时无法读取模型目录" },
      });
      return;
    }
    await route.fulfill({
      json: {
        current: "model-a",
        options: [{ id: "model-a", label: "模型 A" }],
        ...(reasoningSupported
          ? { reasoning: { current: null, levels: ["low", "high"] } }
          : {}),
      },
    });
  });
  try {
    await page.goto("/");
    const input = await openInput(page);
    await input.fill("模型设置异常时保留草稿");
    const hint = page.locator(".composer-reasoning");
    const effort = page.getByLabel("本次输入推理强度");
    await expect(hint).toHaveAttribute("title", "正在读取模型设置…");
    await expect(effort).toBeDisabled();
    release();
    await expect(hint).toHaveAttribute(
      "title",
      "暂时无法读取模型设置，请重试。",
    );
    await expect(effort).toBeDisabled();
    await page
      .locator(".model-picker")
      .getByRole("button", { name: "重试", exact: true })
      .click();
    await expect(page.getByLabel("本次输入模型")).toBeEnabled();
    await expect(page.getByLabel("本次输入模型")).toBeFocused();
    await expect(hint).toHaveAttribute(
      "title",
      "当前运行服务不支持推理强度设置。",
    );
    await expect(effort).toBeDisabled();
    await expect(input).toHaveValue("模型设置异常时保留草稿");
    reasoningSupported = true;
    await page.reload();
    await openInput(page);
    await expect(effort).toBeEnabled();
    await expect(hint).toHaveAttribute(
      "title",
      "仅用于下一次发送；默认沿用模型设置。实际支持以所选模型为准。",
    );
    await expect(input).toHaveValue("模型设置异常时保留草稿");
  } finally {
    release();
  }
});
