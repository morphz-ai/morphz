import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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
  const name = `TEST 阅读 ${randomUUID().slice(0, 8)}.md`;
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
});
