import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { seedCenter } from "./center-fixtures.js";

async function fixture(
  page: Page,
  overrides: { title?: string; project?: string; relativePath?: string } = {},
) {
  await page.goto("/");
  const boot = await (await page.request.get("/api/workspace")).json();
  const command = async (operation: object) => {
    const response = await page.request.post("/api/commands", {
      headers: {
        Origin: new URL(page.url()).origin,
        "X-MorphzWork-Token": boot.csrfToken,
      },
      data: { commandId: randomUUID(), operation },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).entityId as string;
  };
  const project = overrides.project ?? "搜索回归-" + randomUUID();
  const projectId = await command({ type: "create-project", title: project });
  await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId,
      title: overrides.title ?? "交互验收笔记",
      content: {
        kind: "document",
        markdown: "这段摘要用于检查整条搜索结果的点击、拖选和引用行为。",
      },
    },
    true,
  );
  await seedCenter(
    page,
    {
      type: "create-artifact",
      projectId,
      title: "交互验收报告",
      content: {
        kind: "document",
        markdown: "验收结果来自 Agent 产物，可以直接打开。",
      },
    },
    true,
  );
  await page.reload();
  const search = page.getByRole("dialog", { name: "搜索资料", exact: true });
  const open = async () => {
    await page.getByRole("button", { name: "搜索资料", exact: true }).click();
    await page.getByLabel("全文搜索", { exact: true }).fill("验收 交互");
    await page.getByLabel("搜索项目范围").selectOption({ label: project });
    await expect(
      search.getByText("找到 2 项内容", { exact: true }),
    ).toBeVisible();
  };
  return { open, search, inputCount: boot.workspace.inputs.length };
}

test("Agent 产物多关键词结果可点击摘要；外部来源不进入结果，摘要仍限两行", async ({
  page,
}) => {
  const { open, search } = await fixture(page);
  await open();
  await expect(search.getByText("工作空间内容", { exact: true })).toHaveCount(
    0,
  );
  const note = search.locator("article").filter({ hasText: "交互验收笔记" });
  const excerpt = note.locator(".search-excerpt");
  await expect(excerpt).toHaveCSS("-webkit-line-clamp", "2");
  expect((await excerpt.textContent())!.trim().length).toBeLessThanOrEqual(160);
  await expect(note.locator(".search-source")).toHaveCount(0);
  await expect(note.locator(".search-result-footer small")).toHaveCount(0);
  await note.hover();
  const quote = note.getByRole("button", {
    name: "AI 交互：交互验收笔记",
    exact: true,
  });
  await expect(quote).toHaveText("AI");
  await expect(quote).toHaveAttribute("title", "引用《交互验收笔记》");
  await expect(quote.locator(".lucide-message-square-quote")).toHaveCount(1);
  await expect(quote).toHaveCSS("border-width", "0px");
  await expect(quote).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const rowBox = (await note.boundingBox())!;
  const quoteBox = (await quote.boundingBox())!;
  expect(
    Math.abs(quoteBox.y + quoteBox.height / 2 - rowBox.y - rowBox.height / 2),
  ).toBeLessThanOrEqual(1);
  expect(quoteBox.height).toBeGreaterThanOrEqual(32);
  await expect(note.locator(".search-result-footer")).toHaveCount(0);
  await expect(search.locator(".search-help")).toHaveCount(0);
  await excerpt.click();
  await expect(search).toHaveCount(0);
  await expect(page.locator(".object-paper > h1")).toHaveText("交互验收笔记");
  await expect(page.locator(".selection-quote")).toHaveCount(0);

  await open();
  await expect(search.locator(".search-source")).toHaveCount(0);
  await search
    .locator("article")
    .filter({ hasText: "交互验收报告" })
    .locator(".search-result-open")
    .click();
  await expect(search).toHaveCount(0);
  await expect(page.locator(".object-paper > h1")).toHaveText("交互验收报告");
  await expect(page.locator(".source-strip")).toHaveCount(0);
});

test("摘要拖选不误打开，键盘仍可打开，引用独立且不会发送输入", async ({
  page,
}) => {
  const { open, search, inputCount } = await fixture(page);
  await open();
  const note = search.locator("article").filter({ hasText: "交互验收笔记" });
  const excerpt = note.locator(".search-excerpt");
  const bounds = (await excerpt.boundingBox())!;
  await page.mouse.move(bounds.x + 3, bounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 120, bounds.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect(search).toBeVisible();
  expect(
    await page.evaluate(() => window.getSelection()?.toString()),
  ).toBeTruthy();
  await note.locator(".search-result-open").focus();
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(page.locator(".object-paper > h1")).toHaveText("交互验收笔记");

  await open();
  await note.hover();
  await search
    .locator("article")
    .filter({ hasText: "交互验收笔记" })
    .getByRole("button", { name: "AI 交互：交互验收笔记", exact: true })
    .click();
  await expect(search).toHaveCount(0);
  await expect(page.locator(".selection-quote")).toContainText(
    "这段摘要用于检查",
  );
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.inputs).toHaveLength(inputCount);
});

test("最近修改和搜索结果的归属与标题同行，长标题和路径不挤出窄窗口", async ({
  page,
}) => {
  const title = "交互验收笔记与后续计划".repeat(8);
  const project = "搜索归属与空间名称".repeat(8) + randomUUID();
  const relativePath = "长期项目资料/".repeat(12) + "交互来源.md";
  const { open, search } = await fixture(page, {
    title,
    project,
    relativePath,
  });
  await open();
  const note = search.locator("article").filter({ hasText: title });
  await expect(note.locator("strong")).toHaveAttribute("title", title);
  await expect(note.locator(".search-result-meta")).toHaveAttribute(
    "title",
    project,
  );
  const source = search.locator("article").filter({ hasText: "交互验收报告" });
  await expect(source.locator(".search-result-meta")).toHaveAttribute(
    "title",
    project,
  );

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: width === 760 ? 540 : 960 });
    for (const query of ["验收 交互", ""]) {
      await search.getByLabel("全文搜索", { exact: true }).fill(query);
      await expect(search.getByRole("status")).toHaveText(
        query ? "找到 2 项内容" : "最近修改",
      );
      const headings = search.locator(".search-result-heading");
      await expect(headings).toHaveCount(2);
      for (const heading of await headings.all()) {
        const row = (await heading.boundingBox())!;
        const name = (await heading.locator("strong").boundingBox())!;
        const meta = (await heading
          .locator(".search-result-meta")
          .boundingBox())!;
        expect(row.height).toBeLessThanOrEqual(29);
        expect(Math.abs(name.y - meta.y)).toBeLessThanOrEqual(3);
        expect(meta.x).toBeGreaterThanOrEqual(name.x + name.width);
        expect(meta.x + meta.width).toBeLessThanOrEqual(row.x + row.width + 1);
        expect(name.width).toBeGreaterThan(row.width * 0.45);
      }
      expect(
        await search.evaluate(
          (dialog) => dialog.scrollWidth <= dialog.clientWidth,
        ),
      ).toBe(true);
    }
  }
});

test("行内 AI 入口只跟随当前结果，鼠标与键盘可达且不挤动文字", async ({
  page,
}) => {
  const { open, search } = await fixture(page);
  await open();
  const rows = search.locator("article");
  const actions = search.getByRole("button", { name: /^AI 交互：/ });
  await expect(actions).toHaveCount(1);
  const before = await rows
    .locator(".search-result-heading")
    .evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, width: rect.width, height: rect.height };
      }),
    );
  await search.getByLabel("全文搜索").press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(actions).toHaveCount(1);
  await expect(rows.first().locator(".search-result-quote")).toBeHidden();
  await rows.first().hover();
  await expect(rows.first()).toHaveAttribute("data-selected", "true");
  await expect(actions).toHaveCount(1);
  await rows.nth(1).locator(".search-result-open").focus();
  await page.keyboard.press("Tab");
  const action = rows.nth(1).getByRole("button", { name: /^AI 交互：/ });
  await expect(action).toBeFocused();
  await expect(action).toHaveCSS("outline-width", "2px");
  expect(
    await rows.locator(".search-result-heading").evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, width: rect.width, height: rect.height };
      }),
    ),
  ).toEqual(before);
  await expect(
    search.getByRole("button", { name: /^问 AI：/, includeHidden: true }),
  ).toHaveCount(0);
  await action.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(page.locator(".selection-quote")).toBeVisible();
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
});

test.describe("无悬停设备", () => {
  test.use({ hasTouch: true });
  test("AI 入口直接可见，触控目标保留", async ({ page }) => {
    const { open, search } = await fixture(page);
    await open();
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const actions = search.getByRole("button", { name: /^AI 交互：/ });
    await expect(actions).toHaveCount(2);
    for (const action of await actions.all()) {
      const bounds = (await action.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
  });
});
