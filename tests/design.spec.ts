import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact, humanTask } from "./artifact-fixtures.js";
import { openInput } from "./interaction-helpers.js";

test("桌面视觉与真实集合操作：检索、筛选、布局、侧边栏和四主题", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("新对象标题", { exact: true }).fill("设计工作室");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设计工作室", exact: true }),
  ).toBeVisible();
  const projects = async () => {
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "项目", exact: true })
      .click();
    await page
      .locator(".project-card")
      .filter({ hasText: "设计工作室" })
      .click();
    await openLibrary(page);
  };
  const docs: [string, string][] = [
    [
      "围绕对象，一起工作",
      "# 一处输入，多种产出\n\n文档、图片与事项不应散落在不同的对话里。每一份内容都有自己的版本，也能和其他内容建立关联。\n\n## 对象是工作的起点\n\n打开文档，可以阅读、编辑、批注，也可以直接与 Morphz 讨论。切回内容时，未保存的编辑依然保留。\n\n> 人和 Agent 都能参与工作，身份不同不意味着地位不同。\n\n## 下一步\n\n- 整理第一批资料\n- 明确每项工作的负责人\n- 围绕对象继续讨论",
    ],
    [
      "产品交互笔记",
      "## 让工作连续发生\n\n输入框始终围绕当前内容。打开对象，继续编辑；切到对话，把想法交给 Morphz。",
    ],
    [
      "本周工作安排",
      "## 本周重点\n\n完善内容视图，检查界面在不同窗口大小下的表现，并整理需要共同讨论的问题。",
    ],
  ];
  for (const [title, body] of docs) {
    await projects();
    await page
      .locator(".library-authoring-options")
      .getByRole("button", { name: "自己写文档", exact: true })
      .click();
    await page.getByLabel("新对象标题", { exact: true }).fill(title);
    await page.getByLabel("新文档正文").fill(body);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator(".object-paper > h1")).toHaveText(title);
  }
  for (const [title, body] of [
    ["审阅交互方案", "检查对象与对话切换时的上下文是否清晰。"],
    ["整理发布素材", "确认文档、封面与发布说明之间的关联。"],
  ] as const) {
    await projects();
    await seedLibraryArtifact(page, title, humanTask(body));
    await expect(page.locator(".object-paper > h1")).toHaveText(title);
  }
  await projects();
  for (const appearance of ["亮色", "暗色"]) {
    for (const color of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      await page.getByRole("button", { name: "外观设置", exact: true }).click();
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await page.getByRole("button", { name: color, exact: true }).click();
      await expect(page.locator(".app")).toHaveCSS(
        "color-scheme",
        appearance === "亮色" ? "light" : "dark",
      );
      await expect(page.locator(".workspace")).toHaveCSS(
        "background-color",
        appearance === "亮色" ? "rgb(255, 255, 255)" : "rgb(32, 32, 32)",
      );
      await page.screenshot({
        animations: "disabled",
        path: `test-results/library-${appearance}-${color}.png`,
      });
    }
  }
  await page.getByLabel("搜索项目内容").fill("产品交互笔记");
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await page.getByLabel("清除搜索", { exact: true }).click();
  await page
    .getByRole("group", { name: "内容类型" })
    .getByRole("button", { name: "文档", exact: true })
    .click();
  await expect(page.locator(".artifact-card")).toHaveCount(3);
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  await expect(page.locator(".artifact-list .artifact-card")).toHaveCount(3);
  await page.getByLabel("搜索项目内容").fill("no-such-object");
  await expect(
    page.getByRole("heading", { name: "没有找到匹配的内容" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "显示全部内容", exact: true }).click();
  await expect(page.locator(".artifact-list .artifact-card")).toHaveCount(5);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/library-list.png",
  });
  await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.reload();
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.getByRole("button", { name: "显示侧边栏", exact: true }).click();
  await page.getByRole("button", { name: "外观设置", exact: true }).click();
  await page.getByRole("button", { name: "亮色", exact: true }).click();
  await page.getByRole("button", { name: "电光青", exact: true }).click();
  await page
    .locator(".artifact-card")
    .filter({ hasText: "围绕对象，一起工作" })
    .click();
  await expect(page.locator(".object-paper > h1")).toHaveText(
    "围绕对象，一起工作",
  );
  await expect(page.locator("main")).toHaveJSProperty("scrollTop", 0);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/document-light.png",
  });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: "test-results/editor-light.png",
  });
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await page.getByLabel("AI 输入内容").fill("请帮我梳理这份文档的重点。");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.locator(".human-message")).toContainText("请帮我梳理");
  await page.screenshot({
    animations: "disabled",
    path: "test-results/conversation-light.png",
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await expect(page.locator(".task-row")).toHaveCount(2);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/inbox-light.png",
  });
  for (const width of [1380, 1024, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 820 });
    await projects();
    await openInput(page);
    await expect(page.getByLabel("AI 输入内容")).toBeVisible();
    expect(
      await page
        .locator(".app")
        .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    ).toBe(false);
    const toolbar = await page.locator(".topbar").boundingBox();
    for (const button of await page.locator(".topbar button:visible").all()) {
      const bounds = await button.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
        toolbar!.y + toolbar!.height + 1,
      );
    }
    await page.screenshot({
      animations: "disabled",
      path: `test-results/library-${width}.png`,
    });
  }
  await page.setViewportSize({ width: 1380, height: 920 });
  for (const title of ["审阅交互方案", "整理发布素材"]) {
    await projects();
    await page.locator(".artifact-card").filter({ hasText: title }).click();
    await page.getByRole("button", { name: "手动编辑", exact: true }).click();
    await page.getByLabel("事项负责人").selectOption("morphz-agent");
    await page.getByRole("button", { name: "保存版本", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "手动编辑", exact: true }),
    ).toBeVisible();
  }
  expect(errors).toEqual([]);
});
