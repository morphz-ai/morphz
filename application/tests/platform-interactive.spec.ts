import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";

test("正式内容界面编辑交互表格，修订由应用私库保存且刷新后仍可打开", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `project_${suffix}`;
  const objectId = `table_${suffix}`;
  const title = `表格切换验收${suffix}`;
  await source.createProject(`表格项目${suffix}`, randomUUID(), projectId);
  const created = (await source.createInteractive({
    commandId: randomUUID(),
    objectId,
    projectId,
    title,
    content: emptyInteractive,
  })) as { contentId: string };
  const rowWrites: {
    expectedRevision: number;
    operations: { type: string }[];
  }[] = [];
  let fullWrites = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/platform/interactive/patch")
      rowWrites.push(request.postDataJSON());
    if (path === "/api/platform/interactive/revise") fullWrites++;
  });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page.getByLabel("搜索内容", { exact: true }).fill(title);
  await page.getByRole("button", { name: `打开内容：${title}` }).click();
  await expect(page.locator(".interactive-table")).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "添加记录", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "保存版本", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel(/^名称 /)
    .fill("<script>window.compromised=true</script>");
  await page.getByLabel(/^数值 /).fill("12");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await expect(page.locator(".interactive-table")).toContainText(
    "<script>window.compromised=true</script>",
  );
  expect(
    await page.evaluate(() => Reflect.get(window, "compromised")),
  ).toBeUndefined();
  await page.getByRole("button", { name: "记录", exact: true }).click();
  await expect(page.locator(".interactive-form")).toContainText("12");
  await page.getByRole("button", { name: "统计", exact: true }).click();
  await expect(page.locator(".interactive-report")).toContainText("均值 12");
  await page
    .locator(".interactive-artifact")
    .screenshot({ path: "test-results/interactive-report.png" });

  const version = (await source.readObject(created.contentId)) as {
    revision: number;
    content: { kind: string; rows: { cells: Record<string, unknown> }[] };
  };
  expect(version.revision).toBe(2);
  expect(version.content.kind).toBe("interactive");
  expect(version.content.rows[0]?.cells.name).toBe(
    "<script>window.compromised=true</script>",
  );
  expect(rowWrites).toHaveLength(1);
  expect(rowWrites[0]!.expectedRevision).toBe(1);
  expect(rowWrites[0]!.operations.map((operation) => operation.type)).toEqual([
    "insert",
  ]);
  expect(fullWrites).toBe(0);
  expect((await source.getContent(created.contentId)).observedVersionRef).toBe(
    "2",
  );

  await page.reload();
  await expect(page.locator(".interactive-table")).toContainText(
    "<script>window.compromised=true</script>",
  );
  await expect(page.locator(".object-toolbar")).toContainText("v2");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel(/^名称 /).fill("修订名称");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page.getByLabel("查看版本").selectOption("2");
  await expect(page.locator(".interactive-table")).toContainText(
    "<script>window.compromised=true</script>",
  );
  expect(rowWrites).toHaveLength(2);
  expect(rowWrites[1]!.expectedRevision).toBe(2);
  expect(rowWrites[1]!.operations.map((operation) => operation.type)).toEqual([
    "update",
  ]);
  expect(fullWrites).toBe(0);
});

test("三种表格视图共用应用原件；切换查看不改写版本与标题", async ({ page }) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().replaceAll("-", "");
  const projectId = `project_${suffix}`;
  const projectTitle = `表格视图项目${suffix}`;
  const prefix = `表格视图${suffix}`;
  await source.createProject(projectTitle, randomUUID(), projectId);
  const contentIds: string[] = [];
  for (const layout of ["table", "form", "report"] as const) {
    const created = (await source.createInteractive({
      commandId: randomUUID(),
      objectId: `${layout}_${suffix}`,
      projectId,
      title: `${prefix}${{ table: "表格", form: "表单", report: "报告" }[layout]}`,
      content: {
        ...structuredClone(emptyInteractive),
        layout,
        rows: [
          { id: "r1", cells: { name: "甲", value: 12, done: true } },
          { id: "r2", cells: { name: "乙", value: 8, done: false } },
        ],
      },
    })) as { contentId: string };
    contentIds.push(created.contentId);
  }
  const before = await Promise.all(
    contentIds.map((id) => source.readObject(id)),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page.getByLabel("搜索内容", { exact: true }).fill(prefix);
  await page
    .getByRole("group", { name: "内容类型" })
    .getByRole("button", { name: "表格", exact: true })
    .click();
  for (const view of ["列表视图", "卡片视图"]) {
    await page.getByLabel(view, { exact: true }).click();
    await expect(page.locator(".artifact-card")).toHaveCount(3);
    await expect(
      page.locator(".artifact-caption > span:first-child"),
    ).toHaveText([
      `${projectTitle} · 表格`,
      `${projectTitle} · 表格`,
      `${projectTitle} · 表格`,
    ]);
  }
  await page.getByLabel(`打开内容：${prefix}报告`, { exact: true }).click();
  const views = page.getByRole("group", { name: "表格视图", exact: true });
  await expect(views.getByRole("button")).toHaveText(["表格", "记录", "统计"]);
  await expect(
    views.getByRole("button", { name: "统计", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".interactive-report")).toContainText("均值 10");
  await views.getByRole("button", { name: "记录", exact: true }).click();
  await page.getByLabel("选择记录", { exact: true }).selectOption("r2");
  await expect(page.locator(".interactive-form")).toContainText("乙");
  await views.getByRole("button", { name: "表格", exact: true }).click();
  await expect(page.locator(".interactive-table")).toContainText("甲");
  await page.reload();
  await expect(
    views.getByRole("button", { name: "统计", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const after = await Promise.all(
    contentIds.map((id) => source.readObject(id)),
  );
  expect(after).toEqual(before);
});
