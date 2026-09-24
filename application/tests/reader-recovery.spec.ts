import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

async function openTestBook(page: Page, paragraphs = 80) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const exit = page.getByRole("button", { name: "返回工作空间", exact: true });
  if (await exit.isVisible()) await exit.click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  const back = page.getByRole("button", { name: "全部读物", exact: true });
  await expect(
    page.getByRole("region", { name: "阅读书库" }).or(back),
  ).toBeVisible();
  if (await back.isVisible()) await back.click();
  const title = `TEST 阅读现场恢复 ${randomUUID().slice(0, 8)}`;
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  const importStarted = Date.now();
  await (
    await picker
  ).setFiles({
    name: `${title}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# 第一章\n\n" +
        Array.from(
          { length: paragraphs },
          (_, i) =>
            `第 ${i + 1} 段：合成原文，用于核对切换应用与快速离开时，是否保留当前阅读位置。`,
        ).join("\n\n"),
    ),
  });
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    `第 ${Math.min(paragraphs, 80)} 段`,
    { timeout: 60_000 },
  );
  const importMs = Date.now() - importStarted;
  const boot = await (await page.request.get("/api/workspace")).json();
  const book = boot.workspace.artifacts.find(
    (a: { title: string }) => a.title === title,
  );
  const position = async () => {
    const next = await (await page.request.get("/api/workspace")).json();
    return (
      next.workspace.readingStates.find(
        (s: { artifactId: string }) => s.artifactId === book.id,
      )?.location.start ?? 0
    );
  };
  return {
    title,
    book,
    importMs,
    position,
    view: page.locator(".reading-app:visible .reader-viewport"),
  };
}

test("阅读中切到启动台再回来，保留原文位置而不是回到章节开头", async ({
  page,
}) => {
  const { view, position } = await openTestBook(page);
  await view.evaluate((el) => {
    el.scrollTop = 1600;
  });
  await expect.poll(position).toBeGreaterThan(500);
  const before = await view.evaluate((el) => el.scrollTop);
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("tab", { name: "阅读", exact: true }).click();
  await expect(view).toBeVisible();
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    "第 80 段",
  );
  await expect
    .poll(() => view.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before - 80);
  await expect.poll(position).toBeGreaterThan(500);
});

test("长读物按段加载，连续滚动和保存进度不阻塞原文阅读", async ({
  page,
}, info) => {
  const { book, view, position } = await openTestBook(page, 2400);
  // Long imports are deliberately split into bounded sections. Check that all
  // source text is cataloged, while measuring the actual visible section.
  expect(book.content.sections.length).toBeGreaterThan(1);
  expect(
    book.content.sections.reduce(
      (sum: number, section: { characters: number }) =>
        sum + section.characters,
      0,
    ),
  ).toBeGreaterThan(90_000);
  const timings = await view.evaluate(async (el) => {
    const frames: number[] = [];
    for (let i = 1; i <= 24; i++) {
      const start = performance.now();
      el.scrollTop = i * 160;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      frames.push(performance.now() - start);
    }
    return frames.sort((a, b) => a - b);
  });
  await info.attach("reader-scroll-frame-times", {
    body: JSON.stringify({
      paragraphs: 2400,
      medianMs: timings[12],
      p95Ms: timings[22],
    }),
    contentType: "application/json",
  });
  // Includes two animation frames, source-offset alignment and the shared
  // reading context update; no synthetic model/network timing is measured.
  expect(timings[12]).toBeLessThan(65);
  expect(timings[22]).toBeLessThan(150);
  await expect.poll(position).toBeGreaterThan(800);
});

test("百万字读物有界加载，末章可达且刷新保留末章位置", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const paragraphs = 25_000;
  const { book, view, position, importMs } = await openTestBook(
    page,
    paragraphs,
  );
  const characters = book.content.sections.reduce(
    (sum: number, section: { characters: number }) => sum + section.characters,
    0,
  );
  expect(characters).toBeGreaterThan(1_000_000);
  expect(book.content.sections.length).toBeGreaterThan(80);
  // The workspace snapshot contains a catalog, never the million-character body.
  expect(JSON.stringify(book).length).toBeLessThan(100_000);
  for (const section of book.content.sections) {
    expect(section.characters).toBeLessThan(12_100);
    expect(section).not.toHaveProperty("text");
    expect(section).not.toHaveProperty("html");
  }
  const text = page.locator(".reading-app:visible .reader-text");
  // innerText also includes browser-generated blank lines between paragraphs.
  expect((await text.innerText()).length).toBeLessThan(13_000);
  await page.getByRole("button", { name: "目录", exact: true }).click();
  const last = book.content.sections.at(-1);
  await page
    .getByRole("complementary", { name: "阅读目录", exact: true })
    .getByRole("button", { name: last.title, exact: true })
    .click();
  await expect(text).toContainText(`第 ${paragraphs} 段`);
  const close = page.getByRole("button", { name: "关闭阅读侧栏", exact: true });
  if (await close.isVisible()) await close.click();
  const timings = await view.evaluate(async (el) => {
    const frames: number[] = [];
    for (let i = 1; i <= 24; i++) {
      const start = performance.now();
      el.scrollTop = i * 100;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      frames.push(performance.now() - start);
    }
    return frames.sort((a, b) => a - b);
  });
  const metrics = info.outputPath("million-character-reader.json");
  await writeFile(
    metrics,
    JSON.stringify({
      paragraphs,
      characters,
      sections: book.content.sections.length,
      importMs,
      medianMs: timings[12],
      p95Ms: timings[22],
    }),
  );
  await info.attach("million-character-reader", {
    path: metrics,
    contentType: "application/json",
  });
  expect(timings[12]).toBeLessThan(65);
  expect(timings[22]).toBeLessThan(150);
  await expect.poll(position).toBeGreaterThan(500);
  const before = await view.evaluate((el) => el.scrollTop);
  await page.reload();
  await expect(text).toContainText(`第 ${paragraphs} 段`);
  await expect
    .poll(() => view.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before - 80);
  await page.screenshot({
    path: info.outputPath("million-character-last-section.png"),
  });
});

test("滚动后立即返回书库，最后看到的位置仍被保存，重开和刷新可以接续", async ({
  page,
}) => {
  const { title, view, position } = await openTestBook(page);
  // Stay inside the save debounce: ordinary navigation must flush the latest
  // observed viewport before its DOM is removed, not wait for the user to pause.
  await view.evaluate((el) => {
    el.scrollTop = 1800;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    document
      .querySelector<HTMLButtonElement>('button[aria-label="全部读物"]')!
      .click();
  });
  await expect(page.getByRole("region", { name: "阅读书库" })).toBeVisible();
  await expect.poll(position).toBeGreaterThan(600);
  await page
    .getByRole("button", { name: `阅读：${title}`, exact: true })
    .click();
  await expect
    .poll(() => view.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1600);
  await page.reload();
  await expect
    .poll(() => view.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1600);
});

test("在目录再次点击当前章节，回到章首并保存一致的位置", async ({ page }) => {
  const { view, position } = await openTestBook(page);
  await view.evaluate((el) => {
    el.scrollTop = 1500;
  });
  await expect.poll(position).toBeGreaterThan(500);
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await page
    .getByRole("complementary", { name: "阅读目录", exact: true })
    .getByRole("button", { name: "第一章", exact: true })
    .click();
  await expect.poll(() => view.evaluate((el) => el.scrollTop)).toBe(0);
  await expect.poll(position).toBe(0);
  await page.reload();
  await expect.poll(() => view.evaluate((el) => el.scrollTop)).toBe(0);
});

test("书库标题、搜索和导入共用紧凑操作行，说明按需展开，窄窗不挤掉操作", async ({
  page,
}, info) => {
  const { title } = await openTestBook(page);
  await page.getByRole("button", { name: "全部读物", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "查找读物", exact: true });
  const header = page.locator(".reader-library-header");
  const titleBox = (await header
    .getByRole("heading", { name: "阅读", exact: true })
    .boundingBox())!;
  const searchBox = (await search.boundingBox())!;
  expect(
    Math.abs(
      titleBox.y + titleBox.height / 2 - searchBox.y - searchBox.height / 2,
    ),
  ).toBeLessThan(3);
  const privacy = page.locator(".reader-privacy");
  await expect(privacy.locator("p").first()).not.toBeVisible();
  await privacy.getByText("文件与阅读数据", { exact: true }).click();
  await expect(privacy).toContainText("文件会上传至该中心");
  await privacy.getByText("文件与阅读数据", { exact: true }).click();
  await search.fill("没有这份读物" + title);
  await expect(
    page.getByText("没有找到相关读物。", { exact: true }),
  ).toBeVisible();
  await search.fill(title);
  await expect(
    page.getByRole("button", { name: `阅读：${title}`, exact: true }),
  ).toBeVisible();
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(
      page.getByRole("button", { name: "导入读物", exact: true }),
    ).toBeInViewport();
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(44);
    expect(
      await header.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`reader-library-${width}.png`),
    });
  }
});
