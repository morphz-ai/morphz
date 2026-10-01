import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("正式剧本工作室保存设置到应用私库并从同一原件恢复", async ({ page }) => {
  const title = `TEST 新存储剧本 ${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" }).click();
  await expect(page.getByRole("region", { name: "剧本工作区" })).toBeVisible();
  await page.getByRole("button", { name: "手动新建剧本" }).click();
  const create = page.getByRole("dialog", { name: "手动新建剧本" });
  await create.getByLabel("剧本名称").fill(title);
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByLabel("当前剧本")).toContainText(title);

  await page.getByRole("button", { name: "剧本设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "剧本设置" });
  await settings.getByRole("checkbox", {
    name: "我确认本剧本所选资料允许交给当前模型服务处理",
  }).check();
  await settings.getByRole("button", { name: "保存规范", exact: true }).click();
  await expect(settings).not.toBeVisible();

  const listing = await page.request.get("/api/platform/content?limit=100");
  expect(listing.ok()).toBeTruthy();
  const entries = await listing.json() as Array<{ id: string; title: string; appId: string }>;
  const entry = entries.find((value) => value.title === title && value.appId === "morphz.script-studio");
  expect(entry).toBeDefined();
  const response = await page.request.get(`/api/platform/scripts/${entry!.id}`);
  expect(response.ok()).toBeTruthy();
  const overview = await response.json() as { brief: { modelProcessingAllowed: boolean }; metadataRevision: number };
  expect(overview.brief.modelProcessingAllowed).toBe(true);
  expect(overview.metadataRevision).toBe(2);

  await page.reload();
  await page.getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" }).click();
  await page.getByRole("button", { name: "全部剧本", exact: true }).click();
  await page.getByRole("button", { name: `打开剧本：${title}` }).click();
  await page.getByRole("button", { name: "剧本设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "剧本设置" }).getByRole("checkbox", {
    name: "我确认本剧本所选资料允许交给当前模型服务处理",
  })).toBeChecked();
  await page.getByRole("dialog", { name: "剧本设置" })
    .getByRole("button", { name: "关闭" }).click();
  await page.getByRole("region", { name: "创作入口" })
    .getByRole("button", { name: "新建一集", exact: true }).click();
  const itemDialog = page.getByRole("dialog", { name: "新建一集" });
  await itemDialog.getByLabel("条目标题").fill("第一集");
  await itemDialog.getByRole("button", { name: "创建条目" }).click();
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
  await expect(page.getByRole("region", { name: "人工审阅与锁稿" })).toContainText("待审");
  await page.getByRole("button", { name: "批准此版本" }).click();
  const approval = page.getByRole("dialog", { name: "批准此版本" });
  await approval.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("region", { name: "人工审阅与锁稿" })).toContainText("已批准");
  await page.getByRole("button", { name: "锁稿", exact: true }).click();
  await expect(page.getByRole("region", { name: "人工审阅与锁稿" })).toContainText("已锁稿");
  await page.getByRole("button", { name: "说明原因并解锁" }).click();
  const unlock = page.getByRole("dialog", { name: "说明原因并解锁" });
  await unlock.getByRole("textbox").fill("继续打磨");
  await unlock.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("region", { name: "人工审阅与锁稿" })).toContainText("草稿");
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
});
