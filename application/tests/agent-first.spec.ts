import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openLibrary } from "./application-helpers.js";
import { openInput } from "./interaction-helpers.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

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
  let failedRefreshes = 0;
  await page.route("**/api/platform/runtime-navigation*", (route) => {
    failedRefreshes++;
    return route.fulfill({ status: 503, json: { message: "隔离测试断线" } });
  });
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      return failedRefreshes;
    })
    .toBeGreaterThan(0);
  await expect(page.locator(".model-status")).toContainText("应用连接中断");
  await expect(
    page.locator(".sidebar-bottom .profile-warning"),
  ).toHaveAttribute("aria-label", "应用连接中断");
  expect(await page.locator(".workspace-body").boundingBox()).toEqual(before);
  expect(await page.locator(".composer").boundingBox()).toEqual(composerBefore);
  await expect(input).toHaveValue("断线时保留草稿");
  await page
    .locator(".model-status")
    .getByRole("button", { name: "连接详情", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "连接详情", exact: true });
  await page.unroute("**/api/platform/runtime-navigation*");
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
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  await source.ensurePersonalSpaces();
  await page.goto("/");
  await openLibrary(page);
  const initialContent = await source.contentCounts();
  const initialDeliveries = (
    await source.navigationRuntime()
  ).runtime.deliveries.map((delivery) => delivery.inputId);
  const input = await openInput(page);
  await input.fill("这段草稿不能被入口覆盖");
  for (const [button, intent] of [["让 Morphz 起草", "起草文档"]] as const) {
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
  await expect(page.locator(".composer-intent")).toContainText("起草文档");
  await page.locator(".composer").screenshot({
    path: "test-results/composer-inline-intent.png",
    animations: "disabled",
  });
  await page.getByLabel("移除输入意图").click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("这段草稿不能被入口覆盖");
  await expect(page.locator(".composer-intent")).toHaveCount(0);
  expect(await source.contentCounts()).toEqual(initialContent);
  expect(
    (await source.navigationRuntime()).runtime.deliveries.map(
      (delivery) => delivery.inputId,
    ),
  ).toEqual(initialDeliveries);
  await page.screenshot({ path: "test-results/agent-first-composer.png" });
  await page.getByLabel("收起 AI 输入框").click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
});

test("事项意图按空间保存；本机保存失败留草稿，未连接不冒充创建", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const spaces = await source.ensurePersonalSpaces();
  const tasksBefore = (await source.tasks({ limit: 100 })).items.map(
    (task) => task.id,
  );
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
  await expect(page.locator(".composer-intent")).toContainText("新建事项");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (
      window as typeof window & { restoreSavedInput?: () => void }
    ).restoreSavedInput = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.includes(":saved-input:")) throw new Error("TEST storage full");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.locator(".composer-error")).toContainText(
    "本机暂时无法保存这条消息",
  );
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await expect(input).toHaveValue(body);
  await expect(page.locator(".composer-intent")).toContainText("新建事项");
  await page.evaluate(() => {
    (
      window as typeof window & { restoreSavedInput?: () => void }
    ).restoreSavedInput?.();
  });
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
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) =>
      value.includes(":saved-input:"),
    );
    return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
  });
  expect(saved.operation).toMatchObject({
    type: "record-input",
    body,
    intent: "task",
    projectId: spaces.deskId,
    conversationId: spaces.dialogueId,
  });
  expect(
    (await source.tasks({ limit: 100 })).items.map((task) => task.id),
  ).toEqual(tasksBefore);
});

test("关联跟随当前视图和事项，只作用于新输入，不切换持续会话或改写旧输入", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const spaces = await source.ensurePersonalSpaces();
  const suffix = randomUUID().slice(0, 8);
  const title = `TEST 下一次输入的关联事项 ${suffix}`;
  const projectId = randomUUID();
  const taskId = randomUUID();
  await source.createProject(
    `TEST 关联项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  await source.createTask({
    commandId: randomUUID(),
    taskId,
    projectId,
    title,
    description: "用于验证对象关联，不执行",
    assigneeId: source.boot.actantId,
  });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  const savedInputs: { commandId: string; operation: unknown }[] = [];
  const saveInput = async (
    body: string,
    ownerProjectId: string,
    artifactId: string | null = null,
  ) => {
    await (await openInput(page)).fill(body);
    await page.getByRole("button", { name: "保存输入", exact: true }).click();
    await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
    const recorded = await page.evaluate((body) => {
      const entries = Object.keys(localStorage)
        .filter((key) => key.includes(":saved-input:"))
        .map((key) => JSON.parse(localStorage.getItem(key) ?? "null"));
      return entries.find((entry) => entry.operation.body === body) ?? null;
    }, body);
    expect(recorded.operation).toMatchObject({
      projectId: ownerProjectId,
      conversationId: spaces.dialogueId,
      artifactId,
      artifactRevision: artifactId ? 1 : null,
    });
    for (const previous of savedInputs) {
      const retained = await page.evaluate((commandId) => {
        const key = Object.keys(localStorage).find((item) =>
          item.endsWith(`:saved-input:${commandId}`),
        );
        return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
      }, previous.commandId);
      expect(retained).toEqual(previous);
    }
    savedInputs.push(recorded);
  };
  for (const label of ["对话", "事项", "工作台"] as const) {
    await nav
      .getByRole("button", {
        name: label === "事项" ? /^事项/ : label,
        exact: label !== "事项",
      })
      .click();
    await openInput(page);
    await expect(page.locator(".composer .context-chip")).toHaveText(
      "未归项目",
    );
    await saveInput(`在${label}保存的关联测试 ${suffix}`, spaces.deskId);
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
  await saveInput(`围绕这件事项补充信息 ${suffix}`, projectId, taskId);
  await page
    .locator(".composer")
    .screenshot({ path: "test-results/task-input-association.png" });
  await nav.getByRole("button", { name: /^事项/ }).click();
  await openInput(page);
  await expect(page.locator(".composer .context-chip")).toHaveText("未归项目");
  await saveInput(`回到事项列表后不沿用对象 ${suffix}`, spaces.deskId);
});
