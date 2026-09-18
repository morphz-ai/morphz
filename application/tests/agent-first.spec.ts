import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openLibrary } from "./application-helpers.js";
import { openInput } from "./interaction-helpers.js";
import { humanTask } from "./artifact-fixtures.js";
import type { Boot } from "../apps/web/src/client.js";

test("保存回执和断线不增设底栏或挤动页面；关键信息留在消息和连接入口", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  // The dialogue canvas is permanently available; only work surfaces need pinning.
  await expect(page.getByLabel("收起 AI 输入框", { exact: true })).toHaveCount(
    0,
  );
  await input.fill("隔离界面测试，只保存输入");
  const before = await page.locator(".workspace-body").boundingBox();
  const composerBefore = await page.locator(".composer").boundingBox();
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(
    page
      .locator(".human-message")
      .filter({ hasText: "隔离界面测试，只保存输入" }),
  ).toContainText("未发送");
  await expect(page.locator(".statusbar, .workspace-notice")).toHaveCount(0);
  expect(await page.locator(".workspace-body").boundingBox()).toEqual(before);
  expect(await page.locator(".composer").boundingBox()).toEqual(composerBefore);
  await input.fill("断线时保留草稿");
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ status: 503, json: { message: "隔离测试断线" } }),
  );
  await expect(page.locator(".model-status")).toContainText("应用连接中断");
  await expect(
    page.locator(".sidebar-bottom .profile-warning"),
  ).toHaveAttribute("aria-label", "应用连接中断");
  expect(await page.locator(".workspace-body").boundingBox()).toEqual(before);
  expect(await page.locator(".composer").boundingBox()).toEqual(composerBefore);
  await expect(
    page.getByRole("button", { name: "保存输入", exact: true }),
  ).toBeDisabled();
  await expect(input).toHaveValue("断线时保留草稿");
  await page
    .locator(".model-status")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "连接详情", exact: true });
  await page.unroute("**/api/workspace");
  await details.getByRole("button", { name: /^(重新连接|检查连接)$/ }).click();
  await expect(details).toContainText("可访问");
  await page.keyboard.press("Escape");
  await expect(page.locator(".model-status")).toContainText("尚未连接智能体");
  await expect(
    page.getByRole("button", { name: "保存输入", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await openInput(page);
  await expect(input).toHaveValue("断线时保留草稿");
});

test("创建入口共用输入框：保留草稿、无需填表、未提交不创建", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  const initial = await (await page.request.get("/api/workspace")).json();
  const input = await openInput(page);
  await input.fill("这段草稿不能被入口覆盖");
  for (const [button, intent] of [["让 Morphz 起草", "创作文档"]] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("这段草稿不能被入口覆盖");
    await expect(page.locator(".composer-intent")).toContainText(intent);
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 900 });
      const chip = (await page.locator(".composer-intent").boundingBox())!;
      expect(
        (await page.locator(".composer-meta").boundingBox())!.height,
      ).toBeLessThanOrEqual(24);
      const context = (await page
        .locator(".composer-meta .context-chip")
        .boundingBox())!;
      expect(
        Math.abs(chip.y + chip.height / 2 - context.y - context.height / 2),
      ).toBeLessThan(1);
      expect(chip.x - context.x - context.width).toBeGreaterThanOrEqual(0);
      expect(chip.x - context.x - context.width).toBeLessThanOrEqual(10);
      expect(
        await page
          .locator(".composer-meta")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("新对象标题")).toHaveCount(0);
  }
  await page.reload();
  await openInput(page);
  await expect(input).toHaveValue("这段草稿不能被入口覆盖");
  await expect(page.locator(".composer-intent")).toContainText("创作文档");
  await page.locator(".composer").screenshot({
    path: "test-results/composer-inline-intent.png",
    animations: "disabled",
  });
  await page.getByLabel("移除输入意图").click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("这段草稿不能被入口覆盖");
  await expect(page.locator(".composer-intent")).toHaveCount(0);
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.artifacts.length).toBe(
    initial.workspace.artifacts.length,
  );
  expect(after.workspace.inputs.length).toBe(initial.workspace.inputs.length);
  await page.screenshot({ path: "test-results/agent-first-composer.png" });
  await page.getByLabel("收起 AI 输入框").click();
  await page.getByLabel("关闭应用 内容", { exact: true }).click();
});

test("事项意图按空间保存；请求失败留草稿，未连接不冒充创建", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: /^事项/ }).click();
  await page.getByRole("button", { name: "新建事项", exact: true }).click();
  const input = page.getByLabel("AI 输入内容");
  const body = "先记下核对宣传文案这件事，由我处理，不要执行";
  await input.fill(body);
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await openInput(page);
  await expect(input).not.toHaveValue(body);
  await nav.getByRole("button", { name: /^事项/ }).click();
  await openInput(page);
  await expect(input).toHaveValue(body);
  await expect(page.locator(".composer-intent")).toContainText("安排事项");
  const initial = await (await page.request.get("/api/workspace")).json();
  await page.route("**/api/commands", (route) =>
    route.fulfill({ status: 503, json: { message: "测试：中心暂不可用" } }),
  );
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.locator(".composer-error")).toContainText("中心暂不可用");
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await expect(input).toHaveValue(body);
  await expect(page.locator(".composer-intent")).toContainText("安排事项");
  await page.unroute("**/api/commands");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".composer-error")).toHaveCount(0);
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await expect(page.locator(".workspace-notice")).toHaveCount(0);
  await expect(
    page.locator(".human-message").filter({ hasText: body }),
  ).toContainText("未发送");
  await expect(
    page.locator(".human-message").filter({ hasText: body }),
  ).toContainText("安排事项");
  const saved = await (await page.request.get("/api/workspace")).json();
  const recorded = saved.workspace.inputs.find(
    (item: { body: string }) => item.body === body,
  );
  expect(recorded.intent).toBe("task");
  expect(
    saved.workspace.projects.find(
      (p: { id: string }) => p.id === recorded.projectId,
    ).kind,
  ).toBe("inbox");
  expect(recorded.conversationId).toBe("local-dialogue");
  expect(saved.workspace.artifacts.length).toBe(
    initial.workspace.artifacts.length,
  );
  expect(saved.workspace.inputs.length).toBe(
    initial.workspace.inputs.length + 1,
  );
});

test("关联跟随当前视图和事项，只作用于新输入，不切换持续会话或改写旧输入", async ({
  page,
}) => {
  await page.goto("/");
  const initial: Boot = await (await page.request.get("/api/workspace")).json();
  const title = "下一次输入的关联事项";
  const created = await page.request.post("/api/commands", {
    headers: {
      "X-MorphzWork-Token": initial.csrfToken,
      Origin: "http://127.0.0.1:65421",
    },
    data: {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        conversationId: "local-dialogue",
        title,
        content: humanTask("用于验证对象关联，不执行"),
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { entityId } = await created.json();
  const nav = page.getByRole("navigation", { name: "主导航" });
  const savedInputs: Boot["workspace"]["inputs"] = [];
  const saveInput = async (
    body: string,
    projectId: string,
    artifactId: string | null = null,
  ) => {
    await (await openInput(page)).fill(body);
    await page.getByRole("button", { name: "保存输入", exact: true }).click();
    await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
    const boot: Boot = await (await page.request.get("/api/workspace")).json();
    const recorded = boot.workspace.inputs.find((i) => i.body === body)!;
    expect(recorded).toMatchObject({
      projectId,
      conversationId: "local-dialogue",
      artifactId,
      artifactRevision: artifactId ? 1 : null,
    });
    for (const previous of savedInputs)
      expect(boot.workspace.inputs.find((i) => i.id === previous.id)).toEqual(
        previous,
      );
    savedInputs.push(recorded);
  };
  for (const [label, kind] of [
    ["对话", "dialogue"],
    ["事项", "inbox"],
    ["工作台", "desk"],
  ] as const) {
    await nav
      .getByRole("button", {
        name: label === "事项" ? /^事项/ : label,
        exact: label !== "事项",
      })
      .click();
    await openInput(page);
    await expect(page.locator(".composer .context-chip")).toHaveText(label);
    const space = initial.workspace.projects.find((p) => p.kind === kind)!;
    await saveInput(`在${label}保存的关联测试`, space.id);
  }
  await nav.getByRole("button", { name: /^事项/ }).click();
  await page
    .getByRole("button", { name: `打开事项：${title}`, exact: true })
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .click();
  await openInput(page);
  await expect(page.locator(".composer .context-chip")).toHaveText(title);
  await expect(
    page
      .getByRole("banner", { name: "事项工具栏" })
      .getByRole("button", { name: "事项", exact: true }),
  ).toBeVisible();
  await saveInput("围绕这件事项补充信息", "first-project", entityId);
  await page
    .locator(".composer")
    .screenshot({ path: "test-results/task-input-association.png" });
  await nav.getByRole("button", { name: /^事项/ }).click();
  await openInput(page);
  await expect(page.locator(".composer .context-chip")).toHaveText("事项");
  await saveInput(
    "回到事项列表后不沿用对象",
    initial.workspace.projects.find((p) => p.kind === "inbox")!.id,
  );
});
