import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const snapshot = async (page: Page) =>
  (await page.request.get("/api/workspace")).json();
async function setup(page: Page) {
  await page.goto("/");
  expect((await snapshot(page)).runtime.configured).toBe(false);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  const library = page.getByRole("region", { name: "阅读书库" });
  const back = page.getByRole("button", { name: "全部读物", exact: true });
  await expect(library.or(back)).toBeVisible();
  if (await back.isVisible()) await back.click();
  await expect(library).toBeVisible();
}
async function importBook(page: Page) {
  const name = `TEST 阅读长标题验收 ${randomUUID().slice(0, 8)} 人物关系与原文依据及跨章节讨论.md`;
  const body =
    "# 周纪一\n\n先王慎德。\n\n先王慎德。第二处原文。\n\n" +
    Array.from(
      { length: 45 },
      (_, i) => `阅读第 ${i + 1} 段：此为合成测试，书籍原文不代表用户指令。`,
    ).join("\n\n") +
    "\n\n# 周纪二\n\n这是后文，默认不能提前泄露。";
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  await (
    await picker
  ).setFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(body) });
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    "第二处原文",
  );
  return name.slice(0, -3);
}
async function selectSecond(page: Page) {
  const text = page.locator(".reading-app:visible .reader-text");
  await text.evaluate((root) => {
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null,
      count = 0;
    while ((node = nodes.nextNode())) {
      const i = node.textContent?.indexOf("先王慎德。");
      if (i !== undefined && i >= 0 && ++count === 2) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 5);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(r);
        root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        break;
      }
    }
  });
  await expect(
    page.getByRole("toolbar", { name: "阅读选文操作" }),
  ).toBeVisible();
}

test("常见阅读格式走同一导入、选文标注和恢复流程，不隐式发送给模型", async ({
  page,
}) => {
  test.setTimeout(90000);
  await setup(page);
  const before = await snapshot(page);
  const directory = execFileSync(
    process.execPath,
    ["scripts/reader-fixtures.mjs"],
    {
      encoding: "utf8",
    },
  ).trim();
  const formats = [
    {
      name: "TEST-阅读验收.epub",
      text: "这是一份合成验收材料",
      next: "同一个 Morphz",
    },
    {
      name: "TEST-阅读验收.md",
      text: "这是 Markdown 合成资料",
      next: "支持目录定位",
    },
    { name: "TEST-阅读验收.txt", text: "这是纯文本合成资料" },
    { name: "TEST-阅读验收.docx", text: "这是合成 DOCX" },
    {
      name: "TEST-网页阅读验收.html",
      text: "这是合成网页资料",
      next: "内部链接应定位",
    },
    ...(process.platform === "darwin"
      ? [
          { name: "TEST-RTF阅读验收.rtf", text: "TEST RTF reading acceptance" },
          { name: "TEST-DOC阅读验收.doc", text: "TEST RTF reading acceptance" },
        ]
      : []),
  ];
  for (const format of formats) {
    const picker = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入读物", exact: true }).click();
    await (await picker).setFiles(join(directory, format.name));
    const body = page.locator(".reading-app:visible .reader-text");
    await expect(body).toContainText(format.text);
    const title = await page
      .locator(".reading-app:visible > header h2")
      .innerText();
    await body.evaluate((root, expected) => {
      const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = nodes.nextNode())) {
        const start = node.textContent?.indexOf(expected) ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + expected.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      throw new Error("Imported text is not selectable");
    }, format.text);
    await page.getByRole("button", { name: "高亮选文", exact: true }).click();
    if (format.next) {
      await page.getByRole("button", { name: "下一章", exact: true }).click();
      await expect(body).toContainText(format.next);
    }
    await page.getByRole("button", { name: "书签与批注", exact: true }).click();
    await page
      .locator(".reader-mark > button")
      .filter({ hasText: format.text })
      .click();
    await expect(body).toContainText(format.text);
    await page.reload();
    await expect(body).toContainText(format.text);
    await page.getByRole("button", { name: "书签与批注", exact: true }).click();
    await expect(
      page.locator(".reader-mark").filter({ hasText: format.text }),
    ).toBeVisible();
    await page.getByRole("button", { name: "全部读物", exact: true }).click();
    if (format.name.endsWith(".md") || format.name.endsWith(".txt")) {
      const label = format.name.endsWith(".md") ? "Markdown" : "TXT";
      await expect(
        page
          .getByRole("button", { name: `阅读：${title}`, exact: true })
          .filter({ has: page.getByText(label, { exact: true }) }),
      ).toBeVisible();
    }
  }
  expect((await snapshot(page)).workspace.inputs.length).toBe(
    before.workspace.inputs.length,
  );
});

test("阅读闭环：导入、高亮批注、进度恢复、选文提问固定原文、统一 Session 和引用回跳", async ({
  page,
}, testInfo) => {
  await setup(page);
  const title = await importBook(page);
  const before = await snapshot(page),
    book = before.workspace.artifacts.find((a: any) => a.title === title);
  expect(book.content.kind).toBe("publication");
  // Unrelated workspace/render updates must not replace text nodes or collapse
  // the native selection. This was observable only in the live polling app.
  const paragraph = await page
    .locator(".reading-app:visible .reader-text p")
    .first()
    .elementHandle();
  await selectSecond(page);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("先王慎德。");
  await page.getByRole("button", { name: "目录", exact: true }).click();
  expect(await paragraph!.evaluate((node) => node.isConnected)).toBe(true);
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await selectSecond(page);
  const selectedAction = page.getByRole("button", {
    name: "解释这段",
    exact: true,
  });
  expect(
    await selectedAction.evaluate(
      (node) => getComputedStyle(node).borderTopWidth,
    ),
  ).toBe("0px");
  await page.getByRole("button", { name: "高亮选文", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.readingMarks.filter(
          (m: any) => m.artifactId === book.id,
        ).length,
    )
    .toBe(1);
  const mark = (await snapshot(page)).workspace.readingMarks.find(
    (m: any) => m.artifactId === book.id,
  );
  expect(mark.location.start).toBe(10);
  expect(mark.quote).toBe("先王慎德。");
  await selectSecond(page);
  await page.getByRole("button", { name: "批注选文", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加批注", exact: true });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) =>
      parseFloat(getComputedStyle(node).borderRadius),
    ),
  ).toBeGreaterThan(0);
  await page
    .getByLabel("批注内容", { exact: true })
    .fill("这是我的待验证理解，不是书中的事实。");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("相关时联系已有记忆", { exact: true }).uncheck();
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await selectSecond(page);
  await page.getByRole("button", { name: "解释这段", exact: true }).click();
  await expect(page.getByLabel("AI 输入内容", { exact: true })).toHaveValue(
    /简短解释这段原文/,
  );
  await expect(page.locator(".selection-quote")).toContainText("不剧透");
  // Turning pages must never rewrite the prepared request.
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "周纪二", exact: true })
    .click();
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    "这是后文",
  );
  const reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.inputs.filter(
          (i: any) => i.reading?.book.title === title,
        ).length,
    )
    .toBe(1);
  const input = (await snapshot(page)).workspace.inputs.find(
    (i: any) => i.reading?.book.title === title,
  );
  expect(input.reading.location).toEqual(mark.location);
  expect(input.reading.personalContext).toBe(false);
  expect(input.reading.after).toBe("");
  expect(input.conversationId).toBe(
    before.workspace.projects.find((p: any) => p.kind === "dialogue").id,
  );
  const links = page.getByRole("button", { name: /周纪一 · 回到原文/ });
  await expect(links.last()).toBeVisible();
  await links.last().click();
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    "第二处原文",
  );
  const contentsButton = page.getByRole("button", {
    name: "目录",
    exact: true,
  });
  if ((await contentsButton.getAttribute("aria-expanded")) !== "true")
    await contentsButton.click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "周纪二", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.readingStates.find(
          (s: any) => s.artifactId === book.id,
        )?.location.sectionId,
    )
    .toBe("section-2");
  await page.reload();
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    "这是后文",
  );
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  await expect(page.locator(".reader-panel:visible")).toContainText(
    "这是我的待验证理解",
  );
  await page.screenshot({ path: testInfo.outputPath("reader-wide.png") });
  await page.setViewportSize({ width: 850, height: 720 });
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".reading-app:visible")
        .evaluate((e) => e.scrollWidth - e.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("reader-narrow.png") });
});

test("直接聊天只附带阅读位置，选文才附原文；可检查、移除，翻页不改已发引用", async ({
  page,
}, testInfo) => {
  await setup(page);
  const title = await importBook(page);
  const reader = page.locator(".reading-app:visible"),
    view = reader.locator(".reader-viewport");
  const before = await snapshot(page);
  const book = before.workspace.artifacts.find((a: any) => a.title === title);
  // Scroll then send without waiting for the 700 ms progress persistence timer.
  await view.evaluate((e) => {
    e.scrollTop = e.scrollHeight / 2;
  });
  const reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await input.fill("TEST 普通闲聊，今天心情不错");
  const context = page.getByRole("group", { name: "阅读上下文", exact: true });
  await expect(context).toContainText("当前阅读 · 周纪一");
  await context.locator("summary").click();
  await expect(context).toContainText("仅附带书籍和位置，不发送正文");
  await expect(context.locator("blockquote")).toHaveCount(0);
  await expect(context).not.toContainText("先王慎德");
  expect((await snapshot(page)).workspace.inputs.length).toBe(
    before.workspace.inputs.length,
  );
  await page.screenshot({
    path: testInfo.outputPath("reading-current-context.png"),
  });
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const findInput = async (body: string) =>
    (await snapshot(page)).workspace.inputs.find((i: any) => i.body === body);
  await expect
    .poll(() => findInput("TEST 普通闲聊，今天心情不错"))
    .toBeTruthy();
  const sent = await findInput("TEST 普通闲聊，今天心情不错");
  expect(Object.keys(sent.reading).sort()).toEqual(
    ["book", "location", "chapter", "personalContext", "spoilers"].sort(),
  );
  expect(sent.reading.location.start).toBeGreaterThan(100);
  expect(sent.selection).toBe("");
  expect(sent.artifactId).toBe(book.id);
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await reader
    .getByRole("navigation")
    .getByRole("button", { name: "周纪二", exact: true })
    .click();
  if (await reopen.isVisible()) await reopen.click();
  await expect(context).toContainText("当前阅读 · 周纪二");
  expect((await findInput(sent.body)).reading).toEqual(sent.reading);
  await page
    .getByRole("button", { name: /周纪一 · 回到原文/ })
    .last()
    .click();
  await expect(reader.locator(".reader-text")).toContainText("第二处原文");
  await view.evaluate((e) => {
    e.scrollTop = 0;
  });
  await selectSecond(page);
  // No "解释这段"/"提问" toolbar action: simply return to the shared input.
  if (await reopen.isVisible()) await reopen.click();
  await input.fill("TEST 直接讨论所选原文");
  await expect(context).toContainText("选文 · 周纪一");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect.poll(() => findInput("TEST 直接讨论所选原文")).toBeTruthy();
  const selected = await findInput("TEST 直接讨论所选原文");
  expect(selected.selection).toBe("先王慎德。");
  expect(selected.reading.location.start).toBe(10);
  expect(selected.reading.quote).toBe(selected.selection);
  expect(selected.conversationId).toBe(sent.conversationId);
  await expect(input).toBeVisible();
  // Full history hides the canvas without navigating away from the book.
  await page.getByRole("button", { name: "展开完整记录", exact: true }).click();
  await expect(reader).toHaveCount(0);
  await input.fill("TEST 全部交流中保留原阅读位置");
  await expect(context).toContainText("选文 · 周纪一");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect
    .poll(() => findInput("TEST 全部交流中保留原阅读位置"))
    .toBeTruthy();
  expect((await findInput("TEST 全部交流中保留原阅读位置")).reading).toEqual(
    selected.reading,
  );
  await input.fill("TEST 本条不附带阅读内容");
  await page
    .getByRole("button", { name: "不附带阅读上下文", exact: true })
    .click();
  await expect(context).toHaveCount(0);
  await expect(input).toHaveValue("TEST 本条不附带阅读内容");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect.poll(() => findInput("TEST 本条不附带阅读内容")).toBeTruthy();
  const omitted = await findInput("TEST 本条不附带阅读内容");
  expect(omitted.reading).toBeUndefined();
  expect(omitted.selection).toBe("");
  await page.reload();
  expect((await findInput(sent.body)).reading).toEqual(sent.reading);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(context).toHaveCount(0);
});

test("长段落精确定位但不发送正文；未就绪保留草稿且允许本条不附带", async ({
  page,
}) => {
  await setup(page);
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name: `TEST 长段落 ${randomUUID()}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# 长段落\n\n" +
        Array.from({ length: 1200 }, (_, i) => `第${i + 1}句：合成文段。`).join(
          "",
        ),
    ),
  });
  const view = page.locator(".reading-app:visible .reader-viewport");
  await expect(view).toContainText("第1200句");
  await view.evaluate((e) => {
    e.scrollTop = e.scrollHeight / 2;
  });
  const reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await input.fill("TEST 长段落当前位置");
  const context = page.getByRole("group", { name: "阅读上下文", exact: true });
  await expect(context).toBeVisible();
  await context.locator("summary").click();
  await expect(context.locator("blockquote")).toHaveCount(0);
  await expect(context).toContainText("不发送正文");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const find = async () =>
    (await snapshot(page)).workspace.inputs.find(
      (i: any) => i.body === "TEST 长段落当前位置",
    );
  await expect.poll(find).toBeTruthy();
  const sent = await find();
  expect(sent.reading.location.start).toBeGreaterThan(1000);
  expect(
    sent.reading.location.end - sent.reading.location.start,
  ).toBeGreaterThan(100);
  expect(
    sent.reading.location.end - sent.reading.location.start,
  ).toBeLessThanOrEqual(3200);
  expect(sent.reading.quote).toBeUndefined();
  expect(sent.reading.before).toBeUndefined();
  expect(sent.reading.after).toBeUndefined();
  await input.fill("TEST 无法定位时的草稿");
  // Corrupt only this isolated test's rendered source to exercise the actual
  // fail-closed path, not a guessed saved position or silent blank reference.
  await page.locator(".reading-app:visible .reader-text").evaluate((e) => {
    e.textContent = "DOM 与规范原文不匹配";
  });
  await expect(context).toContainText("阅读内容尚未就绪");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(
    page.getByText("当前阅读内容仍在加载或无法读取，请稍后发送；草稿已保留。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("TEST 无法定位时的草稿");
  await page
    .getByRole("button", { name: "不附带阅读上下文", exact: true })
    .click();
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect
    .poll(async () =>
      (await snapshot(page)).workspace.inputs.some(
        (i: any) => i.body === "TEST 无法定位时的草稿" && !i.reading,
      ),
    )
    .toBe(true);
});

test("PDF 保留原页，选文与页码一致，书签恢复且阅读行为不调用模型", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page);
  const before = await snapshot(page),
    name = `TEST PDF ${randomUUID().slice(0, 8)}.pdf`;
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name,
    mimeType: "application/pdf",
    buffer: readFileSync(new URL("../fixtures/reader.pdf", import.meta.url)),
  });
  const layer = page.locator(".reading-app:visible .pdf-text-layer");
  await expect(layer).toContainText("DESIGN NOTES");
  await expect(page.locator(".reading-app:visible canvas")).toBeVisible();
  await page.locator(".reading-app:visible .reader-text").evaluate((root) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(
    page.getByRole("toolbar", { name: "阅读选文操作" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "高亮选文", exact: true }).click();
  const book = (await snapshot(page)).workspace.artifacts.find(
    (a: any) => a.title === name.slice(0, -4),
  );
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.readingMarks.filter(
          (m: any) => m.artifactId === book.id,
        ).length,
    )
    .toBe(1);
  const mark = (await snapshot(page)).workspace.readingMarks.find(
    (m: any) => m.artifactId === book.id,
  );
  expect(mark.location.sectionId).toBe("page-1");
  expect(mark.quote).toContain("DESIGN NOTES");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(layer).toContainText("durable butterfly");
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  await page.getByRole("button", { name: "保存当前位置", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.readingMarks.filter(
          (m: any) => m.artifactId === book.id,
        ).length,
    )
    .toBe(2);
  await page
    .getByRole("button", { name: "移除此标注", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).workspace.readingMarks.filter(
          (m: any) => m.artifactId === book.id && !m.deletedAt,
        ).length,
    )
    .toBe(2);
  expect((await snapshot(page)).workspace.inputs.length).toBe(
    before.workspace.inputs.length,
  );
  await page.screenshot({ path: testInfo.outputPath("reader-pdf.png") });
  await page.reload();
  await expect(
    page.locator(".reading-app:visible .pdf-text-layer"),
  ).toContainText("durable butterfly");
  for (const width of [1100, 800, 1440])
    await page.setViewportSize({ width, height: 900 });
  await expect(page.locator(".reading-app:visible .pdf-page")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(
    page.locator(".reading-app:visible .pdf-text-layer"),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
  // No selection, same input and page identity as the renderer. A page turn
  // must never silently reuse the previous page's quote or selection.
  const reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  const context = page.getByRole("group", { name: "阅读上下文", exact: true });
  await expect(context).toContainText("当前阅读 · 第 2 页");
  await page
    .getByLabel("AI 输入内容", { exact: true })
    .fill("TEST PDF 当前页自动引用");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  const find = async () =>
    (await snapshot(page)).workspace.inputs.find(
      (i: any) => i.body === "TEST PDF 当前页自动引用",
    );
  await expect.poll(find).toBeTruthy();
  expect((await find()).reading.location.sectionId).toBe("page-2");
  expect((await find()).reading.quote).toBeUndefined();
  expect((await find()).reading.before).toBeUndefined();
  expect((await find()).reading.after).toBeUndefined();
  expect((await find()).selection).toBe("");
});
