import { openSettings } from "./settings-helpers.js";
import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact, humanTask } from "./artifact-fixtures.js";

test.afterEach(async ({ page }) => {
  const close = page.getByRole("button", {
    name: "关闭应用 内容",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
});

test("事项默认阅读，不铺字段表单；四主题与窄窗口的留白保持紧凑", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(
    page,
    "核对发布资料",
    humanTask(
      "核对安装说明和下载入口。\n\n- 验证安装步骤\n- 检查已有截图\n\n发现问题直接补充，不需要重新录入安排。",
    ),
  );
  const paper = page.locator(".task-paper");
  await expect(
    paper.locator(
      ".task-description input, .task-description textarea, .task-description select",
    ),
  ).toHaveCount(0);
  await expect(paper.locator(".task-inline-properties select")).toHaveCount(3);
  await expect(paper.getByLabel("优先级", { exact: true })).toHaveCount(0);
  await expect(page.locator(".task-run-panel textarea")).toHaveCount(0);
  await expect(paper.getByText("人工事项不使用模型")).toHaveCount(0);
  await expect(paper.locator(".task-metadata")).not.toHaveAttribute("open");
  await expect(paper.getByRole("listitem")).toHaveCount(2);
  if (await page.getByLabel("收起 AI 输入框").isVisible())
    await page.getByLabel("收起 AI 输入框").click();
  for (const theme of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
    await openSettings(page, "外观");
    await page.getByRole("button", { name: theme, exact: true }).click();
    await page.keyboard.press("Escape");
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 800 });
      const bounds = (await paper.boundingBox())!;
      const content = (await page
        .getByRole("main", { name: "主工作区" })
        .boundingBox())!;
      expect(bounds.x - content.x).toBeLessThan(25);
      expect(content.width - bounds.width).toBeLessThan(25);
      const metrics = await paper.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          padding: parseFloat(style.paddingLeft),
          overflow: el.scrollWidth > el.clientWidth,
        };
      });
      expect(metrics.padding).toBeLessThanOrEqual(24);
      expect(metrics.overflow).toBe(false);
      const response = (await page
        .getByRole("button", { name: "提交结果并完成", exact: true })
        .boundingBox())!;
      expect(response.y + response.height - bounds.y).toBeLessThan(410);
    }
  }
  await openSettings(page, "外观");
  await page.getByRole("button", { name: "电光青", exact: true }).click();
  for (const appearance of ["亮色", "暗色"]) {
    await openSettings(page, "外观");
    await page.getByRole("button", { name: appearance, exact: true }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({
      path: `test-results/task-detail-${appearance}.png`,
    });
  }
  await page.keyboard.press("Escape");
  await paper.locator(".task-metadata > summary").click();
  await expect(paper.getByText("尚未交付", { exact: true })).toBeVisible();
});

test("普通补充不完成事项；提交结果明确完成，失败及旧版本保留草稿", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(
    page,
    "核对事项回应语义",
    humanTask("核对资料后提交结论。"),
  );
  const input = page.getByLabel("AI 输入内容");
  await page.getByRole("button", { name: "补充或调整", exact: true }).click();
  await input.fill("补充：仍在检查，暂未完成。");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByLabel("事项状态", { exact: true })).toHaveValue(
    "planned",
  );
  await page
    .getByRole("button", { name: "提交结果并完成", exact: true })
    .click();
  await input.fill("检查完成，说明与实际安装过程一致。");
  await expect(page.locator(".task-result-intent")).toContainText(
    "提交结果并完成 · v1",
  );
  await page.reload();
  await expect(input).toHaveValue("检查完成，说明与实际安装过程一致。");
  await expect(page.locator(".task-result-intent")).toContainText("v1");
  await page.route("**/api/commands", (route) =>
    route.fulfill({ status: 503, json: { message: "测试失败，未写入" } }),
  );
  await page
    .getByRole("button", { name: "提交结果并完成事项", exact: true })
    .click();
  await expect(input).toHaveValue("检查完成，说明与实际安装过程一致。");
  await expect(page.getByLabel("事项状态", { exact: true })).toHaveValue(
    "planned",
  );
  await page.unroute("**/api/commands");
  // A concurrent edit must not silently advance the version captured by the draft.
  const boot = await (await page.request.get("/api/workspace")).json();
  const task = boot.workspace.artifacts.find(
    (a: { title: string }) => a.title === "核对事项回应语义",
  );
  const revised = await page.request.post("/api/commands", {
    headers: {
      "X-MorphzWork-Token": boot.csrfToken,
      Origin: "http://127.0.0.1:65421",
    },
    data: {
      commandId: crypto.randomUUID(),
      operation: {
        type: "revise-artifact",
        artifactId: task.id,
        expectedRevision: task.revision,
        title: task.title,
        content: {
          ...task.content,
          description: "检查范围已更新，请重新确认。",
        },
      },
    },
  });
  expect(revised.ok()).toBeTruthy();
  await expect(page.getByLabel("事项说明")).toContainText("检查范围已更新");
  await page
    .getByRole("button", { name: "提交结果并完成事项", exact: true })
    .click();
  await expect(
    page.getByText("事项已变化，请查看当前版本后操作。", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("检查完成，说明与实际安装过程一致。");
  await expect(page.getByLabel("事项状态", { exact: true })).toHaveValue(
    "planned",
  );
  await page
    .getByRole("button", { name: "提交结果并完成", exact: true })
    .click();
  await expect(page.locator(".task-result-intent")).toContainText("v2");
  await page
    .getByRole("button", { name: "提交结果并完成事项", exact: true })
    .click();
  await expect(page.getByLabel("事项状态", { exact: true })).toHaveValue(
    "completed",
  );
  await expect(page.locator(".task-run-panel blockquote")).toContainText(
    "检查完成，说明与实际安装过程一致。",
  );
  const result = await (await page.request.get("/api/workspace")).json();
  expect(
    result.workspace.taskResponses.filter(
      (r: { taskId: string }) => r.taskId === task.id,
    ),
  ).toHaveLength(1);
  expect(
    result.workspace.inputs.filter(
      (r: { artifactId: string }) => r.artifactId === task.id,
    ),
  ).toHaveLength(1);
});
