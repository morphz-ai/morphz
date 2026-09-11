import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact, humanTask } from "./artifact-fixtures.js";
import { openInput, composerAction } from "./interaction-helpers.js";
test("真实对象、刷新恢复、引用批注、关联、事项和全局输入", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  // Application restoration may reopen an object left by an earlier test.
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(page).toHaveTitle("工作台 — Morphz");
  await expect(
    page.getByRole("button", { name: "应用启动台", exact: true }),
  ).toBeVisible();
  await page.locator(".project-link").filter({ hasText: "我的项目" }).click();
  await openLibrary(page);
  await page
    .locator(".library-authoring-options")
    .getByRole("button", { name: "手动写文档", exact: true })
    .click();
  await page.getByLabel("新对象标题", { exact: true }).fill("并发工作说明");
  await page
    .getByLabel("新文档正文")
    .fill(
      "# 同一个 Agent\n\n多条工作线共享上下文。\n\n需要 Human 与 Agent 共同参与。",
    );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "并发工作说明", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("并发工作说明 — Morphz");
  await page.getByLabel("AI 输入内容").fill("保留人和 Agent 的对等关系");
  await page.getByLabel("AI 输入内容").press("Control+j");
  await expect(page.getByLabel("AI 输入内容")).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "保留人和 Agent 的对等关系",
  );
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.getByRole("region", { name: "当前对话" })).toBeVisible();
  await expect(
    page
      .locator(".primary-panel .conversation-message p")
      .filter({ hasText: "保留人和 Agent 的对等关系" }),
  ).toHaveText("保留人和 Agent 的对等关系");
  await expect(page.locator("aside .conversation-message")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "并发工作说明", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".primary-panel .conversation-message p")
      .filter({ hasText: "保留人和 Agent 的对等关系" }),
  ).toHaveText("保留人和 Agent 的对等关系");
  await composerAction(page, "收起交流记录");
  await page
    .locator(".document-body p")
    .first()
    .evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
  await page.getByRole("button", { name: "围绕选中文本输入" }).click();
  await page.getByLabel("AI 输入内容").fill("这是核心机制。");
  await composerAction(page, "保存为批注");
  await expect(page.locator(".annotation blockquote")).toHaveText(
    "多条工作线共享上下文。",
  );
  await page
    .locator("nav")
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("heading", { name: "我的项目", exact: true }),
    })
    .click();
  await page.getByLabel("导入图片文件").setInputFiles({
    name: "示例封面.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(
    page.getByRole("heading", { name: "示例封面", exact: true }),
  ).toBeVisible();
  // setInputFiles bypasses the physical import-control click. Return to the
  // object canvas explicitly before using controls behind floating history.
  await page.getByRole("heading", { name: "示例封面", exact: true }).click();
  await expect(page.locator(".conversation")).toHaveCount(0);
  await page.getByRole("button", { name: "关联其他对象" }).click();
  await page.getByLabel("要关联的对象").selectOption({ label: "并发工作说明" });
  await page.getByRole("button", { name: "添加关联" }).click();
  await expect(page.locator(".relation-list")).toContainText("并发工作说明");
  await page
    .locator("nav")
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("heading", { name: "我的项目", exact: true }),
    })
    .click();
  await openLibrary(page);
  await seedLibraryArtifact(page, "检查文章", humanTask("核对术语与事实"));
  await page.locator("nav").getByRole("button", { name: /^事项/ }).click();
  await expect(
    page.getByRole("heading", { name: "检查文章", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "打开事项", exact: true })
    .filter({
      has: page.getByRole("heading", { name: "检查文章", exact: true }),
    })
    .click();
  await page.getByRole("button", { name: "手动编辑", exact: true }).click();
  await page.getByLabel("事项负责人").selectOption("morphz-agent");
  // This isolated center has no Runtime. Do not invent an available model.
  await expect(page.getByLabel("执行模型", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "保存版本" }).click();
  await expect(page.locator(".task-properties")).toContainText("Morphz");
  await page.locator("nav").getByRole("button", { name: /^事项/ }).click();
  await expect(
    page.getByRole("button", { name: "打开事项", exact: true }).filter({
      has: page.getByRole("heading", { name: "检查文章", exact: true }),
    }),
  ).toHaveCount(0);
  for (const color of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
    await page.getByRole("button", { name: "外观设置" }).click();
    await page.getByRole("button", { name: color, exact: true }).click();
  }
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-accent", "mono");
  for (const width of [1440, 1024, 736, 360, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await openInput(page);
    await expect(page.getByLabel("AI 输入内容")).toBeVisible();
    const overflow = await page
      .locator(".app")
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `test-results/workspace-${width}.png` });
  }
  expect(errors).toEqual([]);
});
test("多端旧版本冲突不会覆盖中心，草稿刷新后恢复", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await page
    .locator(".library-authoring-options")
    .getByRole("button", { name: "手动写文档", exact: true })
    .click();
  await page.getByLabel("新对象标题", { exact: true }).fill("冲突测试文档");
  await page.getByLabel("新文档正文").fill("初始内容");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "冲突测试文档", exact: true }),
  ).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(
    other.getByRole("heading", { name: "冲突测试文档", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("文档正文").fill("第一端保存");
  await other.getByRole("button", { name: "编辑", exact: true }).click();
  await other.getByLabel("文档正文").fill("第二端的未保存草稿");
  await page.getByRole("button", { name: "保存版本" }).click();
  await expect(page.locator(".document-body")).toContainText("第一端保存");
  await expect(other.locator(".conflict-banner")).toBeVisible({
    timeout: 8000,
  });
  await expect(other.getByLabel("文档正文")).toHaveValue("第二端的未保存草稿");
  await expect(other.getByRole("button", { name: "保存版本" })).toBeDisabled();
  other.on("dialog", (dialog) => void dialog.accept());
  await other.reload();
  await expect(other.getByLabel("文档正文")).toHaveValue("第二端的未保存草稿");
  await expect(other.locator(".conflict-banner")).toBeVisible();
});

test("对话位于输入框上方的主区域，切换不丢编辑，窄屏也不进入侧栏", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await page
    .locator(".library-authoring-options")
    .getByRole("button", { name: "手动写文档", exact: true })
    .click();
  await page.getByLabel("新对象标题", { exact: true }).fill("对话布局验证");
  await page.getByLabel("新文档正文").fill("这是对象的原始内容。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("文档正文", { exact: true }).fill("尚未保存的编辑内容");
  await page.getByLabel("AI 输入内容").fill("请围绕这个对象继续讨论。");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.getByLabel("文档正文", { exact: true })).toBeVisible();
  await expect(
    page.locator(".primary-panel").getByRole("log", { name: "对话消息" }),
  ).toContainText("请围绕这个对象继续讨论。");
  await expect(page.locator(".model-status")).toContainText("Agent 未连接");
  await expect(page.locator(".runtime-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "展开批注栏" }).click();
  await expect(
    page.getByRole("complementary", { name: "对象批注" }),
  ).not.toContainText("请围绕这个对象继续讨论。");
  const annotationHeader = page.locator(".collaboration > header");
  await expect(
    annotationHeader.locator(".collaboration-context"),
  ).toBeVisible();
  expect((await annotationHeader.boundingBox())!.height).toBeLessThanOrEqual(
    44,
  );
  await page.getByRole("button", { name: "关闭批注栏" }).click();
  await openInput(page);
  await composerAction(page, "收起交流记录");
  await expect(page.getByLabel("文档正文", { exact: true })).toHaveValue(
    "尚未保存的编辑内容",
  );
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await openInput(page);
  await page.reload();
  await expect(page.getByRole("region", { name: "当前对话" })).toBeVisible();
  await composerAction(page, "展开完整记录");
  for (const width of [1380, 760, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 740 : 920 });
    await page
      .getByLabel("AI 输入内容")
      .fill(`窗口宽度 ${width} 下的最新一条消息。`);
    await page.getByRole("button", { name: "保存输入", exact: true }).click();
    const latest = page.locator(".primary-panel .conversation-message").last();
    await expect(latest).toContainText(`窗口宽度 ${width}`);
    await expect(latest).toBeInViewport({ ratio: 1 });
    const messageBox = (await latest.boundingBox())!;
    const columnBox = (await page
      .getByRole("log", { name: "对话消息" })
      .boundingBox())!;
    const composerBox = (await page
      .getByRole("region", { name: "AI 输入", exact: true })
      .boundingBox())!;
    expect(messageBox.y + messageBox.height).toBeLessThanOrEqual(composerBox.y);
    expect(
      Math.abs(
        columnBox.x +
          columnBox.width / 2 -
          composerBox.x -
          composerBox.width / 2,
      ),
    ).toBeLessThan(12);
    // The reading column stays centered; Human bubbles now align to its right.
    expect(
      Math.abs(messageBox.x + messageBox.width - columnBox.x - columnBox.width),
    ).toBeLessThan(2);
    expect(messageBox.x).toBeGreaterThanOrEqual(columnBox.x);
    await expect(latest.locator(".message-author .avatar")).toHaveCount(0);
    expect(
      await page
        .locator(".app")
        .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    ).toBe(false);
    await page.screenshot({ path: `test-results/conversation-${width}.png` });
  }
  await page.getByLabel("AI 输入内容").press("Control+j");
  await expect(page.getByLabel("AI 输入内容")).toBeHidden();
  await expect(page.getByRole("region", { name: "当前对话" })).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(page.getByLabel("AI 输入内容")).toBeVisible();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await openInput(page);
  await expect(page.getByRole("region", { name: "当前对话" })).toContainText(
    "请围绕这个对象继续讨论。",
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await openInput(page);
  await expect(page.getByRole("region", { name: "当前对话" })).toContainText(
    "请围绕这个对象继续讨论。",
  );
});
