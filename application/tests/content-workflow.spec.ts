import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openInput } from "./interaction-helpers.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";

const catalog = (page: Page) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();

test("内容范围也是起草目标；草稿与附件分开保存，迟到发送不串项目", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const first = { id: randomUUID(), title: "TEST 起草 A " + randomUUID() };
  const second = { id: randomUUID(), title: "TEST 起草 B " + randomUUID() };
  await source.createProject(first.title, randomUUID(), first.id);
  await source.createProject(second.title, randomUUID(), second.id);
  const dialogue = await source.ensurePersonalSpaces();
  let runtimeConfigured = false;
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history$/,
    (route) =>
      route.fulfill({
        json: {
          inputs: [],
          nextCursor: null,
          runtime: { ...disconnectedRuntime, configured: runtimeConfigured },
        },
      }),
  );
  await page.route("**/api/platform/runtime-navigation", async (route) => {
    const response = await route.fetch();
    const navigation = await response.json();
    await route.fulfill({
      response,
      json: {
        ...navigation,
        runtime: { ...navigation.runtime, configured: runtimeConfigured },
      },
    });
  });
  await page.goto("/");
  await catalog(page);
  const scope = page.getByLabel("内容范围", { exact: true });
  const input = await openInput(page);
  await input.fill("全目录旧草稿");
  await scope.selectOption(first.id);
  await openInput(page);
  await expect(page.locator(".composer-meta .context-chip")).toHaveText(
    first.title,
  );
  await expect(input).toHaveValue("");
  await input.fill("TEST 为 A 起草报告 " + randomUUID());
  const body = await input.inputValue();
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "draft-a.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A 的附件"),
  });
  await expect(
    page.getByLabel("移除附件 draft-a.txt", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("让 Morphz 起草", { exact: true }).click();
  await expect(input).toBeFocused();
  await expect(page.locator(".composer-intent")).toContainText("创作文档");
  await scope.selectOption(second.id);
  await expect(await openInput(page)).toHaveValue("");
  await expect(
    page.getByLabel("移除附件 draft-a.txt", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".composer-intent")).toHaveCount(0);
  await input.fill("B 的未发送草稿");
  await scope.selectOption(first.id);
  await page.reload();
  await expect(scope).toHaveValue(first.id);
  await expect(await openInput(page)).toHaveValue(body);
  await expect(
    page.getByLabel("移除附件 draft-a.txt", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".composer-intent")).toContainText("创作文档");
  expect((await source.content({ projectId: first.id })).items).toHaveLength(0);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted: {
    commandId: string;
    operation: Record<string, unknown>;
  } | null = null;
  await page.route("**/api/platform/messages", async (route) => {
    submitted = route.request().postDataJSON();
    await gate;
    await route.fulfill({
      status: 202,
      json: { commandId: submitted!.commandId, entityId: submitted!.commandId },
    });
  });
  runtimeConfigured = true;
  await page.reload();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  try {
    await expect.poll(() => submitted).not.toBeNull();
    await scope.selectOption(second.id);
    // The in-flight request belongs to A even while the user views B's draft.
    await expect(input).toHaveValue("B 的未发送草稿");
  } finally {
    release();
  }
  expect(submitted!.operation).toMatchObject({
    projectId: first.id,
    conversationId: dialogue.dialogueId,
    body,
    intent: "document",
    artifactId: null,
    attachments: [{ name: "draft-a.txt" }],
  });
  await expect(await openInput(page)).toHaveValue("B 的未发送草稿");
  await scope.selectOption("all");
  await expect(await openInput(page)).toHaveValue("全目录旧草稿");
});

test("手写和继续修改沿用实际内容归属，返回目录保留筛选", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = randomUUID();
  await source.createProject(
    "TEST 内容闭环 " + randomUUID(),
    randomUUID(),
    projectId,
  );
  await page.goto("/");
  await catalog(page);
  const scope = page.getByLabel("内容范围", { exact: true });
  await scope.selectOption(projectId);
  await page.getByLabel("其他内容创作", { exact: true }).click();
  await page.getByRole("button", { name: "手动写文档", exact: true }).click();
  const title = "TEST 手写报告 " + randomUUID();
  await page.getByLabel("新对象标题").fill(title);
  await page.getByLabel("新文档正文").fill("同一份报告的第一版。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  const created = (
    await source.content({ projectId, query: title })
  ).items.find((entry) => entry.title === title)!;
  expect(created.projectId).toBe(projectId);
  expect(await source.readDocument(created.id)).toMatchObject({
    markdown: "同一份报告的第一版。",
  });
  await catalog(page);
  await expect(scope).toHaveValue(projectId);
  await expect(
    page.getByLabel("打开内容：" + title, { exact: true }),
  ).toBeVisible();
  await scope.selectOption("all");
  await page.getByLabel("让智能体处理：" + title, { exact: true }).click();
  const input = await openInput(page);
  await expect(page.locator(".composer-meta .context-chip")).toHaveText(
    title + " · v1",
  );
  const body = "TEST 继续修改同一文档 " + randomUUID();
  await input.fill(body);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  const recorded = await page.evaluate(
    (text) =>
      Object.keys(localStorage)
        .filter((key) => key.includes(":saved-input:"))
        .map(
          (key) =>
            JSON.parse(localStorage.getItem(key)!) as {
              operation: {
                body: string;
                projectId: string;
                artifactId: string | null;
                artifactRevision: number | null;
              };
            },
        )
        .find((entry) => entry.operation.body === text)?.operation,
    body,
  );
  expect(recorded).toMatchObject({
    projectId,
    artifactId: created.id,
    artifactRevision: 1,
  });
  expect(
    (await source.content({ projectId, query: title })).items,
  ).toHaveLength(1);
  await catalog(page);
  await expect(scope).toHaveValue("all");
});

test("继续处理当前报告实时显示新版本，历史查看与旧版未发草稿仍固定", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const projectId = randomUUID();
  await source.createProject("TEST 连续修改项目", randomUUID(), projectId);
  const title = "TEST 连续修改 " + randomUUID();
  const objectId = randomUUID();
  await source.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId,
    title,
    markdown: "第一版正文",
  });
  const id = (
    await source.resolveContent({
      appId: "morphz.objects",
      appObjectId: objectId,
    })
  ).id;
  await page.goto("/");
  await catalog(page);
  const compose = page.getByLabel("让智能体处理：" + title, { exact: true });
  await compose.click();
  await expect(page.getByLabel("回到当前版本", { exact: true })).toHaveCount(0);
  const input = await openInput(page);
  await input.fill("TEST 更新这份报告");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  const revise = (revision: number, markdown: string) =>
    source.reviseDocument({
      commandId: randomUUID(),
      contentId: id,
      expectedRevision: revision,
      title,
      markdown,
    });
  // Synthetic Agent delivery is used only in this isolated center. The native
  // acceptance runs the actual model; both must update this same document.
  await revise(1, "第二版正文");
  await expect(page.locator(".document-body")).toContainText("第二版正文");
  await expect(page.getByLabel("查看版本", { exact: true })).toHaveCount(0);
  await page.getByLabel("版本历史", { exact: true }).click();
  await page.getByLabel("查看版本", { exact: true }).selectOption("1");
  await revise(2, "第三版正文");
  await expect
    .poll(() => source.readDocument(id))
    .toMatchObject({ revision: 3 });
  await expect(page.locator(".document-body")).toContainText("第一版正文");
  await page.getByLabel("回到当前版本", { exact: true }).click();
  await expect(page.locator(".document-body")).toContainText("第三版正文");
  await catalog(page);
  await compose.click();
  await (await openInput(page)).fill("基于第三版的未发送修改");
  await catalog(page);
  await revise(3, "第四版正文");
  await expect(
    page.getByLabel("打开内容：" + title, { exact: true }),
  ).toHaveAttribute("title", title + " · v4");
  await compose.click();
  await expect(await openInput(page)).toHaveValue("基于第三版的未发送修改");
  await expect(page.getByLabel("查看版本", { exact: true })).toHaveValue("3");
  await expect(page.locator(".document-body")).toContainText("第三版正文");
  await expect(page.locator(".composer-meta .context-chip")).toHaveText(
    title + " · v3",
  );
});
