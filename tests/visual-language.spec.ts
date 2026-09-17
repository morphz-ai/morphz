import { openSettings } from "./settings-helpers.js";
import { test, expect, type Locator } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact, humanTask } from "./artifact-fixtures.js";

async function action(control: Locator, label: string) {
  await expect(control).toHaveText(label);
  await expect(control.locator("svg")).toHaveCount(1);
  await expect(control).toHaveCSS("border-style", "solid");
  await expect(control).toHaveCSS("border-width", "1px");
  expect(
    await control.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(28);
}

test("常用操作用图标与短标签区分正文，完整语义及未发送状态保留", async ({
  page,
}) => {
  await page.goto("/");
  const before = await (await page.request.get("/api/workspace")).json();
  await openLibrary(page);
  await action(
    page.getByRole("button", { name: "让 Morphz 起草", exact: true }),
    "起草文档",
  );
  await expect(
    page.getByRole("button", { name: "导入资料", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("其他内容创作", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "手动写文档", exact: true }),
  ).toHaveText("手动写文档");
  await page.keyboard.press("Escape");
  await seedLibraryArtifact(page, "统一视觉规则回归", {
    kind: "document",
    markdown: "## 明确层级\n\n正文、辅助信息与操作不应混为一谈。",
  });
  await action(
    page.getByRole("button", { name: "朗读对象", exact: true }),
    "朗读",
  );
  await action(
    page.getByRole("button", { name: "版本历史", exact: true }),
    "版本",
  );
  await action(page.getByRole("button", { name: "编辑", exact: true }), "编辑");
  await action(
    page.getByRole("button", { name: "围绕选中文本输入", exact: true }),
    "选区提问",
  );

  for (const appearance of ["亮色", "暗色"]) {
    await openSettings(page, "外观");
    await page.getByRole("button", { name: appearance, exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator(".object-paper > h1").click();
    await page.screenshot({
      path: `test-results/visual-actions-${appearance}.png`,
    });
  }
  await openLibrary(page);
  await seedLibraryArtifact(
    page,
    "统一操作层级回归",
    humanTask("只检查控件，不执行工作。"),
  );
  await action(
    page.getByRole("button", { name: "补充或调整", exact: true }),
    "补充",
  );
  // Completion must retain its consequence in the visible label.
  await expect(
    page.getByRole("button", { name: "提交结果并完成", exact: true }),
  ).toHaveText("提交结果并完成");
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.inputs).toHaveLength(before.workspace.inputs.length);
});
