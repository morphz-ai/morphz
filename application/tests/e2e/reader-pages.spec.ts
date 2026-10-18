import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { zip, epubFiles } from "../fixtures/reader-publication.js";
import { PlatformClient } from "../../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../../packages/core/src/http-application-client.js";
import {
  readerOffsets,
  readerViewport,
} from "../../apps/web/src/reader-dom.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

async function visibleSource(page: Page, source: string) {
  return page.locator(".reading-app:visible .reader-text").evaluate(
    (root, args) => {
      const offsets = new Function("__name", `return (${args.offsets})`)(
        (fn: unknown) => fn,
      );
      const read = new Function(
        "readerOffsets",
        "__name",
        `return (${args.viewport})`,
      )(offsets, (fn: unknown) => fn);
      return read(
        root,
        args.source,
        root.closest(".reader-viewport"),
        "visible",
      ) as { start: number; end: number } | null;
    },
    {
      source,
      offsets: readerOffsets.toString(),
      viewport: readerViewport.toString(),
    },
  );
}

async function library(page: Page) {
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
  await expect(page.getByRole("region", { name: "阅读书库" })).toBeVisible();
}

async function importLongBook(page: Page, format: "md" | "epub") {
  const title = `TEST 分页阅读 ${randomUUID().slice(0, 8)}`;
  const paragraphs = Array.from(
    { length: 80 },
    (_, i) =>
      `第${i + 1}段：这是合成阅读材料，用来验证真实页面的滚动、翻页、精确定位和阅读进度，不是用户书籍。`,
  );
  const buffer =
    format === "md"
      ? Buffer.from(
          `# 第一章\n\n${paragraphs.join("\n\n")}\n\n# 第二章\n\n这是第二章。`,
        )
      : zip({
          ...epubFiles,
          "OEBPS/content.opf": epubFiles["OEBPS/content.opf"].replace(
            "合成通鉴",
            title,
          ),
          // A long single text node also crosses columns; paragraph-only fixtures miss this case.
          "OEBPS/a.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>${paragraphs.slice(0, 30).join("")}</p>${paragraphs
            .slice(30)
            .map((p) => `<p>${p}</p>`)
            .join("")}</body></html>`,
          "OEBPS/b.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1><p>这是第二章。</p></body></html>`,
        });
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name: `${title}.${format}`,
    mimeType: format === "epub" ? "application/epub+zip" : "text/markdown",
    buffer,
  });
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    "第80段",
  );
  return title;
}

test("普通长文在真实应用壳中保持有界、可滚动的正文", async ({ page }) => {
  await library(page);
  await importLongBook(page, "md");
  const view = page.locator(".reading-app:visible .reader-viewport");
  const bounded = () =>
    view.evaluate((v) => ({
      height: v.clientHeight,
      excess: v.scrollHeight - v.clientHeight,
      bottom: v.getBoundingClientRect().bottom,
      window: innerHeight,
    }));
  const geometry = await bounded();
  expect(geometry.height).toBeGreaterThan(100);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.window);
  expect(geometry.excess).toBeGreaterThan(1000);
  await view.hover();
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => view.evaluate((v) => v.scrollTop))
    .toBeGreaterThan(100);
});

test("内容库打开 EPUB 必须约束在画布内，不能把正文和导航撑出窗口", async ({
  page,
}) => {
  await library(page);
  const title = await importLongBook(page, "epub");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
    .click();
  await page
    .getByRole("button", { name: `打开内容：${title}`, exact: true })
    .click();
  const view = page.locator(".reading-app:visible .reader-viewport");
  await expect(view).toBeVisible();
  const rect = await view.boundingBox();
  expect(rect!.height).toBeGreaterThan(100);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
});

test("EPUB 按真实文字分页，鼠标、触控板与键盘翻页可跨章，输入和选文不被劫持", async ({
  page,
}) => {
  await library(page);
  await importLongBook(page, "epub");
  const reader = page.locator(".reading-app:visible"),
    view = reader.locator(".reader-viewport"),
    counter = reader.locator(".reader-page-position");
  await expect(view).toHaveAttribute("data-layout", "pages");
  await expect(counter).toContainText("本章 1 /");
  const count = Number((await counter.innerText()).match(/\/ (\d+) 页/)![1]);
  expect(count).toBeGreaterThan(3);
  expect(
    await view.evaluate((v) => v.scrollHeight - v.clientHeight),
  ).toBeLessThanOrEqual(1);
  await reader.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(counter).toContainText("本章 2 /");
  await expect
    .poll(() => view.evaluate((v) => Math.abs(v.scrollLeft - v.clientWidth)))
    .toBeLessThan(2);
  await page.keyboard.press("ArrowRight");
  await expect(counter).toContainText("本章 3 /");
  await page.keyboard.press("Shift+Space");
  await expect(counter).toContainText("本章 2 /");
  await expect
    .poll(() => view.evaluate((v) => Math.abs(v.scrollLeft - v.clientWidth)))
    .toBeLessThan(2);
  await view.hover();
  await page.mouse.wheel(100, 0);
  await page.mouse.wheel(60, 0); // one trackpad gesture, not two turns
  await expect(counter).toContainText("本章 3 /");
  await expect
    .poll(() =>
      view.evaluate((v) => Math.abs(v.scrollLeft - 2 * v.clientWidth)),
    )
    .toBeLessThan(2);
  await page.keyboard.press("End");
  await expect(counter).toContainText(`本章 ${count} / ${count}`);
  await page.keyboard.press("PageDown");
  await expect(reader.locator(".reader-text")).toContainText("这是第二章");
  await expect(counter).toContainText("本章 1 / 1");
  await page.keyboard.press("PageUp");
  await expect(counter).toContainText(`本章 ${count} / ${count}`);
  // Keyboard arrows in the shared input must edit text, not turn the book.
  const reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await input.fill("TEST 保留草稿");
  await input.press("ArrowLeft");
  await input.press("Space");
  await expect(counter).toContainText(`本章 ${count} / ${count}`);
});

test("EPUB 长文本节点的可见原文、进度、书签及重排隔离正确；截取完整阅读画面", async ({
  page,
}) => {
  test.setTimeout(60000);
  await library(page);
  const title = await importLongBook(page, "epub");
  const client = await PlatformClient.connect(
    new HttpApplicationClient(new URL(page.url()).origin),
  );
  const entry = (
    await client.content({ appId: "morphz.reader", query: title, limit: 10 })
  ).items.find((v) => v.title === title)!;
  const contents = await (
    await page.request.get(
      `/api/reader/contents?artifactId=${entry.id}&revision=1`,
    )
  ).json();
  const section = await (
    await page.request.get(
      `/api/reader/section?artifactId=${entry.id}&revision=1&sectionId=${contents[0].id}`,
    )
  ).json();
  const state = async () =>
    (
      await (
        await page.request.get(
          `/api/reader/state?artifactId=${entry.id}&revision=1`,
        )
      ).json()
    ).position;
  const reader = page.locator(".reading-app:visible"),
    view = reader.locator(".reader-viewport"),
    counter = reader.locator(".reader-page-position");
  await view.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => view.evaluate((v) => Math.abs(v.scrollLeft - v.clientWidth)))
    .toBeLessThan(2);
  const second = await visibleSource(page, section.text);
  expect(second).not.toBeNull();
  expect(second!.start).toBeGreaterThan(50);
  expect(second!.end - second!.start).toBeGreaterThan(100);
  expect(second!.end).toBeLessThan(section.text.indexOf("第30段"));
  await expect
    .poll(async () => (await state())?.location.start)
    .toBe(second!.start);
  await page.reload();
  await expect(counter).toContainText("本章 2 /");
  await expect
    .poll(async () => (await visibleSource(page, section.text))?.start)
    .toBe(second!.start);
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  await page.getByRole("button", { name: "保存当前位置", exact: true }).click();
  await expect(reader.locator(".reader-mark")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await view.focus();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  await reader.locator(".reader-mark > button").click();
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await expect
    .poll(async () => {
      const v = await visibleSource(page, section.text);
      return v && v.start <= second!.start && v.end > second!.start;
    })
    .toBe(true);
  const evidence = process.env.MORPHZ_TEST_READER_PAGES_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  if (evidence)
    await page.screenshot({
      path: resolve(evidence, "desktop.png"),
      fullPage: true,
    });
  const reopen = page.locator(".composer-reopen");
  if (await reopen.isVisible()) await reopen.click();
  const association = page.getByRole("group", {
    name: "阅读引用",
    exact: true,
  });
  await expect(association).toBeVisible();
  const compact = await association.evaluate((node) => {
    const row = node.getBoundingClientRect(),
      composer = node.closest(".composer")!,
      textarea = composer.querySelector("textarea")!,
      writing = textarea.getBoundingClientRect(),
      style = getComputedStyle(textarea);
    return {
      height: row.height,
      gap: writing.top + parseFloat(style.paddingTop) - row.bottom,
      margin: getComputedStyle(node).marginBottom,
    };
  });
  expect(compact.height).toBeLessThanOrEqual(24);
  expect(compact.gap).toBeLessThanOrEqual(4);
  expect(compact.margin).toBe("0px");
  if (evidence)
    await page.screenshot({
      path: resolve(evidence, "composer-context.png"),
      fullPage: true,
    });
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect
    .poll(async () => {
      const v = await visibleSource(page, section.text);
      return v && v.start <= second!.start && v.end > second!.start;
    })
    .toBe(true);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("阅读字号", { exact: true }).fill("26");
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await expect
    .poll(async () => {
      const v = await visibleSource(page, section.text);
      return v && v.start <= second!.start && v.end > second!.start;
    })
    .toBe(true);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  if (evidence)
    await page.screenshot({
      path: resolve(evidence, "narrow-dark.png"),
      fullPage: true,
    });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect
    .poll(() => view.evaluate((v) => v.clientHeight))
    .toBeGreaterThan(100);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  if (evidence)
    await page.screenshot({
      path: resolve(evidence, "zoom-200.png"),
      fullPage: true,
    });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const hide = page.getByRole("button", { name: "隐藏侧边栏", exact: true });
  if (await hide.isVisible()) await hide.click();
  await expect
    .poll(() => view.evaluate((v) => v.clientWidth))
    .toBeGreaterThan(280);
  if (evidence)
    await page.screenshot({
      path: resolve(evidence, "mobile.png"),
      fullPage: true,
    });
});
