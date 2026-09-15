import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Boot } from "../apps/web/src/client.js";
import { seedCenter } from "./center-fixtures.js";
import { openInput } from "./interaction-helpers.js";

const snapshot = async (page: Page): Promise<Boot> =>
  (await page.request.get("/api/workspace")).json();
const catalog = (page: Page) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();

test("内容范围也是起草目标；草稿与附件分开保存，迟到发送不串项目", async ({
  page,
}) => {
  await page.goto("/");
  const second = await seedCenter(page, {
    type: "create-project",
    title: "TEST 起草 B " + randomUUID(),
  });
  await page.reload();
  const initial = await snapshot(page);
  const first = initial.workspace.projects.find(
    (p) => p.id === "first-project",
  )!;
  const dialogue = initial.workspace.projects.find(
    (p) => p.kind === "dialogue",
  )!;
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
  await scope.selectOption(second);
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
  expect((await snapshot(page)).workspace.inputs).toEqual(
    initial.workspace.inputs,
  );

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = false;
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON()?.operation?.type === "record-input") {
      submitted = true;
      await gate;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect.poll(() => submitted).toBe(true);
  await scope.selectOption(second);
  // Submission locks editing until its receipt; inspect the destination draft
  // without trying to focus the disabled textarea before releasing that receipt.
  await expect(input).toHaveValue("B 的未发送草稿");
  release();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.inputs.find((i) => i.body === body)
          ?.projectId,
    )
    .toBe(first.id);
  const after = (await snapshot(page)).workspace;
  const recorded = after.inputs.find((i) => i.body === body)!;
  expect(recorded.conversationId).toBe(dialogue.id);
  expect(recorded.intent).toBe("document");
  expect(recorded.artifactId).toBeNull();
  expect(recorded.application).toBeUndefined();
  expect(recorded.attachments?.map((a) => a.name)).toEqual(["draft-a.txt"]);
  expect(after.conversations).toEqual(initial.workspace.conversations);
  expect(after.artifacts).toEqual(initial.workspace.artifacts);
  expect(after.applicationInstances).toEqual(
    initial.workspace.applicationInstances,
  );
  await expect(await openInput(page)).toHaveValue("B 的未发送草稿");
  await scope.selectOption("all");
  await expect(await openInput(page)).toHaveValue("全目录旧草稿");
});

test("手写和继续修改沿用实际内容归属，返回目录保留筛选", async ({ page }) => {
  await page.goto("/");
  const projectId = await seedCenter(page, {
    type: "create-project",
    title: "TEST 内容闭环 " + randomUUID(),
  });
  await page.reload();
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
  const created = (await snapshot(page)).workspace.artifacts.find(
    (a) => a.title === title,
  )!;
  expect(created.projectId).toBe(projectId);
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
  const after = (await snapshot(page)).workspace;
  const recorded = after.inputs.find((i) => i.body === body)!;
  expect(recorded.projectId).toBe(projectId);
  expect(recorded.artifactId).toBe(created.id);
  expect(recorded.artifactRevision).toBe(1);
  expect(after.artifacts.filter((a) => a.title === title)).toHaveLength(1);
  await catalog(page);
  await expect(scope).toHaveValue("all");
});

test("继续处理当前报告实时显示新版本，历史查看与旧版未发草稿仍固定", async ({
  page,
}) => {
  await page.goto("/");
  const title = "TEST 连续修改 " + randomUUID();
  const id = await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId: "first-project",
      title,
      content: { kind: "document", markdown: "第一版正文" },
    },
    true,
  );
  await page.reload();
  await catalog(page);
  const compose = page.getByLabel("让智能体处理：" + title, { exact: true });
  await compose.click();
  await expect(page.getByLabel("回到当前版本", { exact: true })).toHaveCount(0);
  const input = await openInput(page);
  await input.fill("TEST 更新这份报告");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  const revise = (revision: number, markdown: string) =>
    seedCenter(
      page,
      {
        type: "revise-artifact",
        artifactId: id,
        expectedRevision: revision,
        title,
        content: { kind: "document", markdown },
      },
      true,
    );
  // Synthetic Agent delivery is used only in this isolated center. The native
  // acceptance runs the actual model; both must update this same document.
  await revise(1, "第二版正文");
  await expect(page.locator(".document-body")).toContainText("第二版正文");
  await expect(page.getByLabel("查看版本", { exact: true })).toHaveCount(0);
  await page.getByLabel("版本历史", { exact: true }).click();
  await page.getByLabel("查看版本", { exact: true }).selectOption("1");
  await revise(2, "第三版正文");
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.artifacts.find((a) => a.id === id)
          ?.revision,
    )
    .toBe(3);
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
