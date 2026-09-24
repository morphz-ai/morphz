import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

test("文档不重复首标题，关联按需展开，失败就近重试且不改变原文", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "关联参考", {
    kind: "document",
    markdown: "参考内容。",
  });
  await openLibrary(page);
  const markdown =
    "# **文档阅读验收**\n\n保留原文和版本。\n\n## 正文小节\n\n实际内容。";
  await seedLibraryArtifact(page, "文档阅读验收", {
    kind: "document",
    markdown,
  });
  await expect(
    page.getByRole("heading", { name: "文档阅读验收", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "正文小节", exact: true }),
  ).toBeVisible();
  const relations = page.getByRole("region", { name: "关联对象", exact: true });
  await expect(relations.getByLabel("要关联的对象")).toHaveCount(0);
  expect((await relations.boundingBox())!.height).toBeLessThan(65);
  await relations.getByRole("button", { name: "关联其他对象" }).click();
  await relations
    .getByLabel("要关联的对象")
    .selectOption({ label: "关联参考" });
  let fail = true;
  await page.route("**/api/commands", async (route) => {
    if (
      route.request().postDataJSON()?.operation?.type === "link-artifacts" &&
      fail
    ) {
      fail = false;
      return route.fulfill({
        status: 409,
        json: { error: "关联暂未保存，请重试。" },
      });
    }
    return route.continue();
  });
  await relations
    .getByRole("button", { name: "添加关联", exact: true })
    .click();
  await expect(relations.getByRole("alert")).toBeVisible();
  await expect(relations.getByLabel("要关联的对象")).not.toHaveValue("");
  await relations
    .getByRole("button", { name: "添加关联", exact: true })
    .click();
  await expect(relations.locator(".relation-list")).toContainText("关联参考");
  await expect(relations.getByLabel("要关联的对象")).toHaveCount(0);
  const boot = await page.request.get("/api/workspace").then((r) => r.json());
  const object = boot.workspace.artifacts.find(
    (a: { title: string }) => a.title === "文档阅读验收",
  );
  expect(object.content.markdown).toBe(markdown);
  expect(object.revision).toBe(1);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("文档正文", { exact: true })).toHaveValue(
    markdown,
  );
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await page.setViewportSize({ width: 760, height: 540 });
  const toolbar = page.getByRole("banner", { name: "内容工具栏" });
  const back = toolbar.getByRole("button", { name: "内容", exact: true });
  await expect(back).toBeInViewport();
  const toolbarBounds = (await toolbar.boundingBox())!;
  const backBounds = (await back.boundingBox())!;
  // The global catalog is a destination, not an application tab. Its return
  // control must remain reachable beside the object actions at narrow widths.
  expect(backBounds.x).toBeGreaterThanOrEqual(toolbarBounds.x);
  expect(backBounds.x + backBounds.width).toBeLessThanOrEqual(
    toolbarBounds.x + toolbarBounds.width,
  );
  for (const name of ["朗读对象", "版本历史", "编辑"]) {
    const action = page.getByRole("button", { name, exact: true });
    await expect(action).toBeInViewport();
    expect((await action.boundingBox())!.width).toBeLessThanOrEqual(36);
  }
  await page.screenshot({ path: "test-results/object-reading-compact.png" });
  await back.click();
  await expect(page.locator(".content-actions")).toBeVisible();
  await expect(
    page.locator(".artifact-card").filter({ hasText: "文档阅读验收" }),
  ).toBeVisible();
});

test("朗读用能力命名，服务身份只出现在按需查看的说明", async ({ page }) => {
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: "test-voice",
        providerLabel: "隔离测试语音",
      },
    }),
  );
  let syntheses = 0;
  await page.route("**/api/speech/synthesize", (route) => {
    syntheses++;
    return route.abort();
  });
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "语音界面验收", {
    kind: "document",
    markdown: "这是一段测试文字。",
  });
  await page.getByRole("button", { name: "朗读对象", exact: true }).click();
  const reader = page.getByRole("region", { name: "朗读对象", exact: true });
  await expect(reader).toContainText("未播放");
  await expect(reader).not.toContainText(/豆包|test-voice|隔离测试语音/);
  await reader.getByRole("button", { name: "朗读内容与章节" }).click();
  await reader.getByText("语音服务与隐私", { exact: true }).click();
  await expect(reader).toContainText("当前服务：隔离测试语音");
  await expect(reader).toContainText("朗读文字发送至该服务");
  await expect(reader).toContainText("可能消耗服务额度");
  expect(syntheses).toBe(0);
});
