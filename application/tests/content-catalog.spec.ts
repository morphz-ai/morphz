import { openSettings } from "./settings-helpers.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  seedCenter,
  seedLegacyDocument,
  seedLegacyWebsiteCenter,
} from "./center-fixtures.js";
import { openInput } from "./interaction-helpers.js";
import type { Boot } from "../apps/web/src/client.js";
const snapshot = async (p: Page): Promise<Boot> =>
  (await p.request.get("/api/workspace")).json();
const catalog = async (p: Page) =>
  p
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
const doc = (p: Page, title: string, body: string, agent = true) =>
  seedCenter(
    p,
    {
      type: "create-artifact",
      projectId: "first-project",
      title,
      content: { kind: "document", markdown: body },
    },
    agent,
  );

test("状态不再混入内容；旧链接可打开，旧网站筛选恢复全部且不丢草稿", async ({
  page,
}) => {
  await page.goto("/");
  const prefix = "边界验收" + randomUUID();
  const projectId = await seedCenter(page, {
    type: "create-project",
    title: prefix,
  });
  const summary = await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId,
      title: prefix + "状态",
      content: {
        kind: "document",
        markdown: prefix + "状态正文",
        understanding: {
          frameId: "f",
          frameRevision: 1,
          mindVersion: 1,
          sources: [],
        },
      },
    },
    true,
  );
  const document = await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId,
      title: prefix + "普通文档",
      content: { kind: "document", markdown: "保留的工作成果" },
    },
    true,
  );
  const website = await seedLegacyWebsiteCenter(
    page,
    prefix + "旧链接",
    projectId,
  );
  const before = (await snapshot(page)).workspace.artifacts.filter((a) =>
    [summary, document, website].includes(a.id),
  );
  await page.reload();
  await catalog(page);
  const input = await openInput(page);
  await input.fill("内容边界未发送草稿");
  await page.getByLabel("搜索内容", { exact: true }).fill(prefix);
  const types = page.getByRole("group", { name: "内容类型" });
  await expect(types.getByRole("button")).toHaveText([
    "全部",
    "文档",
    "PDF",
    "图片",
    "表格",
  ]);
  await expect(page.locator(".artifact-card")).toHaveCount(2);
  await page.getByLabel("内容范围", { exact: true }).selectOption(projectId);
  await expect(page.locator(".library-caption")).toContainText("2 项内容");
  await page.getByLabel("列表视图", { exact: true }).click();
  await expect(page.locator(".artifact-card")).toHaveCount(2);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.endsWith("library-view:all-content"),
    )!;
    localStorage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(key)!),
        filter: "website",
      }),
    );
  });
  await page.reload();
  await expect(
    types.getByRole("button", { name: "全部", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".artifact-card")).toHaveCount(2);
  await page
    .getByLabel("打开内容：" + prefix + "旧链接", { exact: true })
    .click();
  await expect(page.locator(".object-toolbar")).toContainText("网页链接");
  await expect(page.locator(".browser-host")).toContainText(
    "https://example.com/",
  );
  await catalog(page);
  await page.getByLabel("内容范围", { exact: true }).selectOption("all");
  await expect(await openInput(page)).toHaveValue("内容边界未发送草稿");
  await page.getByRole("button", { name: prefix, exact: true }).click();
  const launcher = page.getByRole("button", {
    name: "应用启动台",
    exact: true,
  });
  await launcher.click();
  await expect(page.getByLabel("继续工作")).not.toContainText(prefix + "状态");
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page.getByRole("button", { name: "当前理解", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "当前理解", exact: true }),
  ).toContainText(prefix + "状态正文");
  const after = (await snapshot(page)).workspace.artifacts.filter((a) =>
    [summary, document, website].includes(a.id),
  );
  expect(after).toEqual(before);
});

test("内容专用入口、明确起草位置，正文查找沿用产物索引而不索引外部文件", async ({
  page,
}) => {
  await page.goto("/");
  const prefix = randomUUID(),
    body = "bodyonly" + prefix;
  const title = "目录产物" + prefix;
  await doc(page, title, body);
  await seedLegacyDocument(page, "first-project", `旧副本${prefix}.md`, body);
  await doc(page, "手写" + prefix, body, false);
  await page.reload();
  await catalog(page);
  await expect(page.getByLabel("工作空间选项", { exact: true })).toHaveCount(0);
  const create = page.getByRole("group", { name: "创建内容" });
  await expect(create).toContainText("起草文档");
  await expect(create).not.toContainText("工作台");
  await page
    .getByLabel("内容范围", { exact: true })
    .selectOption("first-project");
  await expect(create).toContainText("起草文档");
  await page.getByLabel("让 Morphz 起草", { exact: true }).click();
  const project = (await snapshot(page)).workspace.projects.find(
    (p) => p.id === "first-project",
  )!;
  await expect(page.locator(".composer-meta .context-chip")).toHaveText(
    project.title,
  );
  await page.getByLabel("其他内容创作").click();
  const menu = page.getByRole("group", { name: "内容创作", exact: true });
  await expect(menu.getByRole("button")).toHaveCount(1);
  await expect(menu).toContainText("手动写文档");
  await expect(menu).not.toContainText("工作台");
  await expect(
    page.getByRole("button", { name: "制作表格或报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "表格与报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "内容类型" }).getByRole("button", {
      name: "表格",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索内容", { exact: true }).fill(body);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".content-match")).toContainText(body);
  await expect(page.locator(".content-origin")).toHaveText("Morphz生成");
  await page.getByLabel("搜索内容", { exact: true }).fill("旧副本" + prefix);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".content-origin")).toHaveText("导入副本");
  await page.getByLabel("搜索内容", { exact: true }).fill("手写" + prefix);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await page.getByLabel("内容排序", { exact: true }).selectOption("title");
  await page.getByLabel("列表视图", { exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("内容排序", { exact: true })).toHaveValue(
    "title",
  );
  await expect(page.locator(".artifact-list .artifact-card")).toHaveCount(1);
});

test("重命名、移动、撤销保留同一内容与历史；并发冲突留下未保存名称", async ({
  page,
}) => {
  await page.goto("/");
  const title = "整理验收" + randomUUID(),
    id = await doc(page, title, "正文保持不变");
  const target = await seedCenter(page, {
    type: "create-project",
    title: "整理目标" + randomUUID(),
  });
  await page.reload();
  await catalog(page);
  await page.getByLabel("搜索内容", { exact: true }).fill("整理验收");
  await page.getByLabel("内容操作：" + title, { exact: true }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await expect(page.getByLabel("内容名称", { exact: true })).toBeFocused();
  await page.getByLabel("内容名称", { exact: true }).fill(title + "已改名");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByLabel("打开内容：" + title + "已改名", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    page.getByLabel("打开内容：" + title, { exact: true }),
  ).toBeVisible();
  await page.getByLabel("内容操作：" + title, { exact: true }).click();
  await page.getByRole("button", { name: "移动到项目", exact: true }).click();
  await page.getByLabel("目标项目", { exact: true }).selectOption(target);
  await page.getByRole("button", { name: "移动", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.artifacts.find((a) => a.id === id)
          ?.projectId,
    )
    .toBe(target);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.artifacts.find((a) => a.id === id)
          ?.projectId,
    )
    .toBe("first-project");
  const before = (await snapshot(page)).workspace;
  const original = before.artifacts.find((a) => a.id === id)!;
  expect(original.revision).toBe(5);
  expect(original.content).toEqual(original.versions[0]!.content);
  await page.getByLabel("内容操作：" + title, { exact: true }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByLabel("内容名称", { exact: true }).fill("尚未保存的名称");
  await seedCenter(page, {
    type: "organize-content",
    artifactId: id,
    expectedRevision: 5,
    changes: { title: title + "另一处修改" },
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已变化");
  await expect(page.getByLabel("内容名称", { exact: true })).toHaveValue(
    "尚未保存的名称",
  );
  await page.keyboard.press("Escape");
  expect((await snapshot(page)).workspace.inputs).toEqual(before.inputs);
});

test("从内容继续交流准确引用版本、不自动发送、不覆盖其他草稿；返回保持视图", async ({
  page,
}) => {
  await page.goto("/");
  const title = "继续处理" + randomUUID(),
    id = await doc(page, title, "需要智能体处理的产物");
  await page.reload();
  await catalog(page);
  await (await openInput(page)).fill("目录自身草稿不能被覆盖");
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await page.getByLabel("搜索内容", { exact: true }).fill(title);
  await page.getByLabel("列表视图", { exact: true }).click();
  const before = (await snapshot(page)).workspace;
  await page.getByLabel("让智能体处理：" + title, { exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(page.locator(".composer .context-chip")).toContainText(title);
  await input.fill("此产物的未发草稿");
  await page
    .locator(".breadcrumb")
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await expect(page.getByLabel("搜索内容", { exact: true })).toHaveValue(title);
  await expect(page.getByLabel("列表视图", { exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(await openInput(page)).toHaveValue("目录自身草稿不能被覆盖");
  await page.getByLabel("让智能体处理：" + title, { exact: true }).click();
  await expect(input).toHaveValue("此产物的未发草稿");
  const after = (await snapshot(page)).workspace;
  expect(after.inputs).toEqual(before.inputs);
  expect(after.conversations).toEqual(before.conversations);
  expect(after.artifacts.find((a) => a.id === id)?.revision).toBe(1);
});

test("搜索翻页、切换查询与失败重试；卡片/列表窄窗可见且无溢出", async ({
  page,
}) => {
  await page.goto("/");
  const token = "页内词" + randomUUID();
  for (let i = 0; i < 52; i++) await doc(page, `分页验收 ${i}`, token);
  await page.reload();
  await catalog(page);
  await page.getByLabel("搜索内容", { exact: true }).fill(token);
  await expect(page.locator(".artifact-card")).toHaveCount(50);
  // The exchange now overlays the canvas; close it before reaching the last row.
  if (await page.getByLabel("AI 输入内容", { exact: true }).isVisible())
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
  await page.getByRole("button", { name: "继续查找", exact: true }).click();
  await expect(page.locator(".artifact-card")).toHaveCount(52);
  await page.getByLabel("搜索内容", { exact: true }).fill("不存在" + token);
  await expect(page.locator(".artifact-card")).toHaveCount(0);
  await page.route("**/api/search**", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.getByLabel("搜索内容", { exact: true }).fill("分页验收");
  await expect(page.getByRole("alert")).toContainText("当前仅显示标题匹配");
  await expect(page.locator(".artifact-card")).toHaveCount(52);
  await page.unroute("**/api/search**");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  for (const appearance of ["亮色", "暗色"]) {
    await openSettings(page, "外观");
    await page.getByRole("button", { name: appearance, exact: true }).click();
    await page.keyboard.press("Escape");
    for (const width of [1440, 760, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const layout of ["卡片视图", "列表视图"]) {
        await page.getByLabel(layout, { exact: true }).click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const card = page.locator(".artifact-card").first();
        expect(
          await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        const title = await card
            .locator(".artifact-card-heading")
            .boundingBox(),
          actions = await card.locator(".content-item-actions").boundingBox();
        const heading = await card.locator("h2").boundingBox();
        expect(heading!.x + heading!.width).toBeLessThanOrEqual(actions!.x + 1);
        expect(title!.height).toBeGreaterThan(0);
      }
      await page.screenshot({
        path: `test-results/content-catalog-${appearance}-${width}.png`,
      });
    }
  }
});
