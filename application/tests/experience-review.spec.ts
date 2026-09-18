import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { openInput } from "./interaction-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";

test("当前理解非模态核对，更新只准备统一草稿，不发送技术指令", async ({
  page,
}) => {
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("保留我的工作草稿。");
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "当前理解",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.locator("textarea")).toHaveCount(0);
  await expect(panel.locator(".understanding-empty")).toBeInViewport();
  await expect(panel.getByRole("heading", { name: "当前理解" })).toBeFocused();
  await panel.getByRole("button", { name: "梳理理解", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(
    "保留我的工作草稿。\n\n请梳理当前工作空间的公开理解，包括目标、约束和已确认的事实。",
  );
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs.length).toBe(before.workspace.inputs.length);
  expect(after.workspace.conversations).toEqual(before.workspace.conversations);
  expect(await input.inputValue()).not.toMatch(
    /context_tx|host_morphz(?:_work)?|mw-public|Session/,
  );
  await panel.screenshot({ path: "test-results/experience-understanding.png" });
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "执行面板" }),
  ).toBeVisible();
});

test("当前理解来源可打开，窄窗核对和关闭不丢草稿或遮住发送操作", async ({
  page,
}) => {
  const initial = await page.request
    .get("/api/workspace")
    .then((r) => r.json());
  const desk = initial.workspace.projects.find(
    (p: { kind: string }) => p.kind === "desk",
  );
  const created = await page.request.post("/api/commands", {
    headers: {
      "X-Morphz-Token": initial.csrfToken,
      Origin: "http://127.0.0.1:65421",
    },
    data: {
      commandId: crypto.randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: desk.id,
        title: "合成参考文档",
        content: { kind: "document", markdown: "合成依据。" },
      },
    },
  });
  expect(created.ok()).toBe(true);
  const { entityId } = await created.json();
  await page.route("**/api/workspace", async (route) => {
    // This synthetic snapshot must remain available after conditional refreshes.
    const response = await route.fetch({
      headers: Object.fromEntries(
        Object.entries(route.request().headers()).filter(
          ([key]) => key.toLowerCase() !== "if-none-match",
        ),
      ),
    });
    const boot = await response.json();
    const source = boot.workspace.artifacts.find(
      (a: { id: string }) => a.id === entityId,
    );
    const summary = {
      ...source,
      id: "review-understanding",
      title: "公开理解",
      content: {
        kind: "document",
        markdown: "### 工作目标\n核对事实，再继续工作。",
        understanding: {
          frameId: "test-frame",
          frameRevision: 1,
          mindVersion: 1,
          sources: [{ artifactId: source.id, revision: 1 }],
        },
      },
    };
    summary.versions = [
      {
        ...source.versions[0]!,
        title: summary.title,
        content: summary.content,
      },
    ];
    boot.workspace.artifacts.push(summary);
    await route.fulfill({ response, json: boot });
  });
  await page.goto("/");
  await page.setViewportSize({ width: 760, height: 540 });
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "当前理解",
    exact: true,
  });
  await expect(panel).toContainText("核对事实，再继续工作");
  await expect(panel).not.toContainText("认知帧");
  await panel.getByText("参考内容 · 1").click();
  await expect(
    panel.getByRole("button", { name: /合成参考文档/ }),
  ).toBeEnabled();
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(760);
  await panel.getByRole("button", { name: "纠正或补充", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    /需要纠正或补充的内容/,
  );
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await panel.getByText("参考内容 · 1").click();
  await panel.getByRole("button", { name: /合成参考文档/ }).click();
  await expect(page.locator(".object-paper")).toContainText("合成依据。");
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await panel.getByRole("button", { name: "更新理解", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
});

test("表格筛选空态能恢复；新增记录清除旧筛选并定位新行", async ({ page }) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "记录编辑验收", {
    ...structuredClone(emptyInteractive),
    rows: [{ id: "existing", cells: { name: "原有记录", value: 12 } }],
  });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("AI 输入内容")).not.toBeVisible();
  await page.getByLabel("筛选记录").fill("不匹配的词");
  await expect(page.locator(".interactive-empty")).toContainText(
    "没有匹配的记录",
  );
  await page.getByRole("button", { name: "添加记录", exact: true }).click();
  await expect(page.getByLabel("筛选记录")).toHaveValue("");
  await expect(page.locator(".interactive-table tbody tr")).toHaveCount(2);
  await expect(
    page.locator(".interactive-table tbody tr").last().locator("input").first(),
  ).toBeFocused();
  await page
    .locator(".interactive-table tbody tr")
    .last()
    .locator("input")
    .first()
    .fill("新增记录");
  await page.setViewportSize({ width: 760, height: 540 });
  const save = page.getByRole("button", { name: "保存版本", exact: true });
  await expect(save).toBeInViewport();
  expect(await save.evaluate((e) => !!e.closest(".topbar"))).toBe(true);
  await page.screenshot({ path: "test-results/experience-table-narrow.png" });
  await save.click();
  await expect(page.locator(".interactive-table")).toContainText("新增记录");
  await openInput(page);
  await expect(
    page.getByRole("button", { name: "附加文件", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await openInput(page);
  await expect(
    page.getByRole("button", { name: "附加文件", exact: true }),
  ).toHaveCount(1);
});

test("长文保存在现有顶栏，快捷键保存；查看旧版本时明确编辑目标", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "长文保存验收", {
    kind: "document",
    markdown: "原始版本",
  });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存版本", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("文档正文", { exact: true })
    .fill("修订版本\n\n" + "足够长的正文，用于验证保存位置。\n\n".repeat(60));
  await page.getByLabel("文档正文", { exact: true }).press("ControlOrMeta+s");
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".object-toolbar")).toContainText("v2");
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page.getByLabel("查看版本", { exact: true }).selectOption("1");
  await expect(page.locator(".document-body")).toContainText("原始版本");
  await page.getByRole("button", { name: "编辑当前版本", exact: true }).click();
  await expect(page.getByLabel("文档正文", { exact: true })).toHaveValue(
    /^修订版本/,
  );
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await expect(page.locator(".object-toolbar")).toContainText("v2");
});

test("旧同步桥不再触发后台读取，也不重新暴露同步入口", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, "legacySourceCalls", 0);
    Reflect.set(window, "morphzDesktop", {
      sources: {
        list: async () => {
          Reflect.set(
            window,
            "legacySourceCalls",
            Number(Reflect.get(window, "legacySourceCalls")) + 1,
          );
          throw new Error("Legacy polling must not start");
        },
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("工作空间选项", { exact: true }).click();
  await expect(page.getByRole("group", { name: "工作空间操作" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "资料导入与来源", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "legacySourceCalls")),
  ).toBe(0);
});
