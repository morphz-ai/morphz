import { test, expect } from "../project-conversation-fixture.js";
import { openInput } from "../interaction-helpers.js";
import { randomUUID } from "node:crypto";

test("正式剧本工作室保存资料说明、保留旧字段并从同一原件恢复，false不禁用创作", async ({
  page,
}, testInfo) => {
  const title = `TEST 新存储剧本 ${randomUUID().slice(0, 8)}`;
  const modelInputs: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/platform/messages")
      modelInputs.push(path);
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  await expect(page.getByRole("region", { name: "剧本工作区" })).toBeVisible();
  await page.getByRole("button", { name: "手动新建剧本" }).click();
  const create = page.getByRole("dialog", { name: "手动新建剧本" });
  await create.getByLabel("剧本名称").fill(title);
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByLabel("当前剧本")).toContainText(title);

  await page.getByRole("button", { name: "剧本设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "剧本设置" });
  await expect(settings.locator(".script-hint")).toContainText(
    "创作要求、资料说明或审阅人变更需要重新审阅",
  );
  await expect(settings).not.toContainText("资料许可");
  await expect(
    settings.getByRole("checkbox", {
      name: "我确认本剧本所选资料允许交给当前模型服务处理",
    }),
  ).toHaveCount(0);
  const sourceDescription = "TEST 资料来源记录，不是 Agent 创作开关。";
  await settings.getByLabel("资料来源与使用说明").fill(sourceDescription);
  await settings.screenshot({
    path: testInfo.outputPath("script-source-description.png"),
  });
  await settings.getByRole("button", { name: "保存规范", exact: true }).click();
  await expect(settings).not.toBeVisible();

  const listing = await page.request.get("/api/platform/content?limit=100");
  expect(listing.ok()).toBeTruthy();
  const entries = (await listing.json()) as Array<{
    id: string;
    title: string;
    appId: string;
  }>;
  const entry = entries.find(
    (value) => value.title === title && value.appId === "morphz.script-studio",
  );
  expect(entry).toBeDefined();
  const response = await page.request.get(`/api/platform/scripts/${entry!.id}`);
  expect(response.ok()).toBeTruthy();
  const overview = (await response.json()) as {
    brief: { modelProcessingAllowed: boolean; rightsStatement: string };
    metadataRevision: number;
  };
  expect(overview.brief.modelProcessingAllowed).toBe(false);
  expect(overview.brief.rightsStatement).toBe(sourceDescription);
  expect(overview.metadataRevision).toBe(2);

  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  await page.getByRole("button", { name: "全部剧本", exact: true }).click();
  await page.getByRole("button", { name: `打开剧本：${title}` }).click();
  await page.getByRole("button", { name: "剧本设置", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "剧本设置" }).getByRole("checkbox", {
      name: "我确认本剧本所选资料允许交给当前模型服务处理",
    }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("dialog", { name: "剧本设置" })
      .getByLabel("资料来源与使用说明"),
  ).toHaveValue(sourceDescription);
  await page
    .getByRole("dialog", { name: "剧本设置" })
    .getByRole("button", { name: "关闭" })
    .click();
  await page
    .getByRole("region", { name: "创作入口" })
    .getByRole("button", { name: "新建一集", exact: true })
    .click();
  const itemDialog = page.getByRole("dialog", { name: "新建一集" });
  await itemDialog.getByLabel("条目标题").fill("第一集");
  await itemDialog.getByRole("button", { name: "创建条目" }).click();
  // A legacy false value cannot disable the browser creative entry or local
  // preparation. The isolated Host never dispatches this draft to a model.
  const generate = page.getByRole("button", { name: "生成候选", exact: true });
  await expect(generate).toBeEnabled();
  await generate.click();
  const generation = page.getByRole("dialog", { name: "准备生成候选请求" });
  await expect(generation).toBeVisible();
  await expect(
    generation.getByRole("button", { name: "准备到输入框", exact: true }),
  ).toBeEnabled();
  await generation.screenshot({
    path: testInfo.outputPath("legacy-false-generation-ready.png"),
  });
  await generation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(generation).not.toBeVisible();
  await generate.click();
  await generation
    .getByRole("button", { name: "准备到输入框", exact: true })
    .click();
  await expect(generation).not.toBeVisible();
  const preparedInput = await openInput(page);
  await expect(preparedInput).toHaveValue(
    /请对《.*》的「第一集」v1进行生成候选/,
  );
  await expect(page.getByTestId("script-input-reference")).toContainText(
    "第一集",
  );
  expect(modelInputs, "Preparation is not authority to send an Input").toEqual(
    [],
  );
  await page.getByRole("button", { name: "输入关联", exact: true }).click();
  await page
    .getByRole("button", { name: "移除剧本请求引用", exact: true })
    .click();
  // Removing the last association can close the unpinned composer; reopening
  // uses the same shared interaction as the rest of the browser test suite.
  await (await openInput(page)).fill("");
  await page.getByLabel("剧本正文").fill("初稿。");
  await page.getByRole("button", { name: "保存文稿" }).click();
  await expect(page.locator(".script-edit-status")).toContainText("v2");
  await page.getByRole("tab", { name: "历史" }).click();
  await page.getByLabel("查看版本").selectOption("1");
  await page.getByRole("button", { name: "将此历史稿恢复为新版本" }).click();
  await expect(page.locator(".script-edit-status")).toContainText("v3");
  await page.getByRole("tab", { name: "正文" }).click();
  await expect(page.getByLabel("剧本正文")).toHaveValue("");
  await page.getByLabel("剧本正文").fill("导出稿。");
  await page.getByRole("button", { name: "保存文稿" }).click();
  await expect(page.locator(".script-edit-status")).toContainText("v4");
  await page.getByRole("tab", { name: "审阅" }).click();
  await page.getByRole("button", { name: "提交审阅" }).click();
  await expect(
    page.getByRole("region", { name: "人工审阅与锁稿" }),
  ).toContainText("待审");
  await page.getByRole("button", { name: "批准此版本" }).click();
  const approval = page.getByRole("dialog", { name: "批准此版本" });
  await approval.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "人工审阅与锁稿" }),
  ).toContainText("已批准");
  await page.getByRole("button", { name: "锁稿", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "人工审阅与锁稿" }),
  ).toContainText("已锁稿");
  await page.getByRole("button", { name: "说明原因并解锁" }).click();
  const unlock = page.getByRole("dialog", { name: "说明原因并解锁" });
  await unlock.getByRole("textbox").fill("继续打磨");
  await unlock.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "人工审阅与锁稿" }),
  ).toContainText("草稿");
  await page.getByLabel("审阅引用").fill("导出稿");
  await page.getByLabel("审阅意见").fill("核对开场节奏");
  await page.getByRole("button", { name: "添加意见" }).click();
  await expect(page.locator(".script-review")).toContainText("核对开场节奏");
  await page.getByRole("button", { name: "记录解决方式" }).click();
  const resolution = page.getByRole("dialog", { name: "解决审阅意见" });
  await resolution.getByLabel("决定说明").fill("已核对");
  await resolution.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.locator(".script-review")).toContainText("已解决");
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await page.getByRole("button", { name: "导出 Word" }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出 Word" });
  await expect(exportDialog.getByLabel("导出用途")).toHaveValue("working-copy");
  const download = page.waitForEvent("download");
  await exportDialog.getByRole("button", { name: "导出所选" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.docx$/);
  await expect(page.getByText("导出历史（1）")).toBeVisible();
  expect(
    modelInputs,
    "Manual editing/review/export cannot send a model Input",
  ).toEqual([]);
});
