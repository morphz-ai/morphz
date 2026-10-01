import { test, expect, type Page, type Route } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readerOffsets,
  readerRange,
  readerViewport,
} from "../../apps/web/src/reader-dom.js";
import { createAppServer } from "../../apps/service/src/http.js";
import { WorkspaceStore } from "../../packages/application/src/store.js";
import { IdentityCenter } from "../../packages/application/src/identity.js";
import { openApplicationDomainsHost } from "../../packages/application/src/application-domains-host.js";
import {
  Application,
  invokeApplication,
} from "../../packages/application/src/application.js";
import type { ApplicationMethod } from "../../packages/core/src/application-api.js";
import type {
  ReadingSection,
  ReaderCommand,
} from "../../packages/core/src/reader.js";
import { openInput } from "../interaction-helpers.js";

const text = (page: Page) => page.locator(".reading-app:visible .reader-text");
const marksPanel = (page: Page) =>
  page.locator('.reading-app:visible .reader-panel[aria-label="阅读标注"]');
type StoredMark = {
  id: string;
  note: string;
  color: string;
  kind: string;
  revision: number;
  location: { sectionId: string; start: number; end: number };
  deletedAt: string | null;
};

async function headers(page: Page) {
  const response = await page.request.get(
    new URL("/api/platform/bootstrap", page.url()).href,
  );
  expect(response.ok(), await response.text()).toBe(true);
  const boot = (await response.json()) as { csrfToken: string };
  return {
    Origin: new URL(page.url()).origin,
    "X-Morphz-Token": boot.csrfToken,
  };
}
async function createBook(page: Page, title: string, markdown: string) {
  const auth = await headers(page);
  const projectId = randomUUID();
  const project = await page.request.post("/api/platform/projects", {
    headers: auth,
    data: {
      commandId: randomUUID(),
      projectId,
      title: `TEST 分页项目 ${randomUUID().slice(0, 8)}`,
    },
  });
  expect(project.ok(), await project.text()).toBe(true);
  const document = await page.request.post("/api/platform/documents", {
    headers: auth,
    data: {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title,
      markdown,
    },
  });
  expect(document.ok(), await document.text()).toBe(true);
  const { contentId } = (await document.json()) as { contentId: string };
  const outline = await page.request.get(
    `/api/reader/contents?artifactId=${contentId}&revision=1`,
  );
  expect(outline.ok(), await outline.text()).toBe(true);
  const sections: ReadingSection[] = [];
  for (const section of (await outline.json()) as Array<{ id: string }>) {
    const response = await page.request.get(
      `/api/reader/section?artifactId=${contentId}&revision=1&sectionId=${section.id}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    sections.push((await response.json()) as ReadingSection);
  }
  return { contentId, sections };
}
async function command(page: Page, artifactId: string, value: ReaderCommand) {
  const response = await page.request.post("/api/reader/commands", {
    headers: await headers(page),
    data: { commandId: randomUUID(), artifactId, revision: 1, command: value },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string; revision: number }>;
}
async function addMark(
  page: Page,
  artifactId: string,
  section: ReadingSection,
  start: number,
  end: number,
  note: string,
  kind: "highlight" | "note" | "bookmark" = "highlight",
) {
  expect(start).toBeGreaterThanOrEqual(0);
  return command(page, artifactId, {
    action: "mark-add",
    artifactId,
    artifactRevision: 1,
    location: { sourceId: section.sourceId, sectionId: section.id, start, end },
    quote: section.text.slice(start, end),
    kind,
    color: "yellow",
    note,
  });
}
async function allMarks(page: Page, artifactId: string) {
  const marks: StoredMark[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      artifactId,
      revision: "1",
      limit: "50",
      ...(cursor ? { after: cursor } : {}),
    });
    const response = await page.request.get(`/api/reader/marks?${params}`);
    expect(response.ok(), await response.text()).toBe(true);
    const result = (await response.json()) as {
      marks: StoredMark[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(result.marks.length).toBeLessThanOrEqual(50);
    expect(result.hasMore).toBe(result.nextCursor !== null);
    marks.push(...result.marks);
    cursor = result.nextCursor;
  } while (cursor);
  expect(new Set(marks.map((mark) => mark.id)).size).toBe(marks.length);
  return marks;
}
async function openReader(page: Page, title: string) {
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
  const library = page.getByRole("region", { name: "阅读书库" });
  const back = page.getByRole("button", { name: "全部读物", exact: true });
  await expect(library.or(back)).toBeVisible();
  if (await back.isVisible()) await back.click();
  await page
    .getByRole("button", { name: `阅读：${title}`, exact: true })
    .click();
  await expect(text(page)).toBeVisible();
}
function observeReads(page: Page, artifactId: string) {
  const reads: Array<{ params: Record<string, string>; rows: number }> = [];
  const states: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  const pending: Promise<void>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(?:platform\/messages|messages)(?:\?|$)/.test(request.url())
    )
      sent.push(request.url());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.searchParams.get("artifactId") !== artifactId || !response.ok())
      return;
    if (url.pathname === "/api/reader/marks")
      pending.push(
        response
          .json()
          .then((result) => {
            reads.push({
              params: Object.fromEntries(url.searchParams),
              rows: result.marks.length,
            });
          })
          .catch(() => {}),
      );
    if (url.pathname === "/api/reader/state")
      pending.push(
        response
          .json()
          .then((result) => {
            states.push(result);
          })
          .catch(() => {}),
      );
  });
  return {
    reads,
    states,
    sent,
    async assertBounded() {
      await Promise.all(pending);
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(Number(read.params.limit)).toBeLessThanOrEqual(50);
        expect(read.rows).toBeLessThanOrEqual(50);
        expect(read.params.deleted).not.toBe("true");
        expect(read.params.revision).toBe("1");
      }
      expect(states.length).toBeGreaterThan(0);
      for (const state of states)
        expect(Object.keys(state)).toEqual(["position"]);
      expect(sent).toEqual([]);
    },
  };
}
async function paintedMarks(page: Page) {
  return text(page).evaluate((root) =>
    [...(CSS as any).highlights.entries()]
      .filter(
        ([key]: [string]) =>
          key.startsWith("reader-mark-") && !key.endsWith("-citation"),
      )
      .reduce(
        (sum: number, [, mark]: [string, Iterable<Range>]) =>
          sum +
          [...mark].filter(
            (range) =>
              root.contains(range.startContainer) &&
              root.contains(range.endContainer),
          ).length,
        0,
      ),
  );
}
/** Execute the existing production pure DOM algorithms against the real page,
 * not a guessed quote/index mapping or a fabricated viewport. */
async function sourcePoint(
  page: Page,
  section: ReadingSection,
  offset: number,
  scroll = false,
) {
  return text(page).evaluate(
    (root, args) => {
      const offsetsFn = new Function("__name", `return (${args.offsets});`)(
        (fn: unknown) => fn,
      ) as typeof readerOffsets;
      const rangeFn = new Function("__name", `return (${args.range});`)(
        (fn: unknown) => fn,
      ) as typeof readerRange;
      const alignment = offsetsFn(root.textContent ?? "", args.source);
      if (!alignment)
        throw new Error("actual DOM and stored text are not aligned");
      const range = rangeFn(
        root as HTMLElement,
        alignment.sourceToDom[args.offset]!,
        alignment.sourceToDom[args.offset + 1]!,
      );
      if (!range) throw new Error("source offset has no actual DOM range");
      const view = root.closest(".reader-viewport") as HTMLElement;
      if (args.scroll)
        view.scrollTop +=
          range.getBoundingClientRect().top -
          view.getBoundingClientRect().top -
          100;
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    {
      source: section.text,
      offset,
      scroll,
      offsets: readerOffsets.toString(),
      range: readerRange.toString(),
    },
  );
}

test("分页原文：超过50条重叠标注全部可点改，3200字后的可见标注与跨视口长高亮不遗漏", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 5000 });
  await page.goto("/");
  const title = `TEST 密集分页 ${randomUUID().slice(0, 8)}`;
  const markdown =
    "# 第一章\n\n" +
    "甲".repeat(200) +
    "密集选点" +
    "乙".repeat(4000) +
    "远端可见标注" +
    "丙".repeat(3500) +
    "\n\n" +
    "丁".repeat(6000);
  const book = await createBook(page, title, markdown);
  const section = book.sections[0]!;
  const denseStart = section.text.indexOf("甲");
  const commonPoint = section.text.indexOf("密集选点");
  const distant = section.text.indexOf("远端可见标注");
  expect(distant).toBeGreaterThan(3200);
  const dense: Array<{ id: string; revision: number }> = [];
  for (let i = 0; i < 55; i++)
    dense.push(
      await addMark(
        page,
        book.contentId,
        section,
        denseStart + i,
        commonPoint + 20 + i,
        `DENSE_${String(i).padStart(3, "0")}`,
      ),
    );
  const long = await addMark(
    page,
    book.contentId,
    section,
    denseStart,
    denseStart + 7600,
    "LONG_BEFORE_VIEW",
  );
  await addMark(
    page,
    book.contentId,
    section,
    distant,
    distant + 7,
    "VISIBLE_AFTER_3200",
  );
  await command(page, book.contentId, {
    action: "save-position",
    artifactId: book.contentId,
    artifactRevision: 1,
    location: {
      sourceId: section.sourceId,
      sectionId: section.id,
      start: 0,
      end: 0,
    },
    preferences: { fontSize: 14, font: "serif", theme: "system" },
    expectedRevision: 0,
  });
  await page.reload();
  const probe = observeReads(page, book.contentId);
  await openReader(page, title);
  await expect.poll(() => paintedMarks(page)).toBe(57);
  const actualRanges = await text(page).evaluate(
    (root, args) => {
      const offsets = new Function("__name", `return (${args.offsets});`)(
        (fn: unknown) => fn,
      );
      const viewport = new Function(
        "readerOffsets",
        "__name",
        `return (${args.viewport});`,
      )(offsets, (fn: unknown) => fn) as typeof readerViewport;
      const view = root.closest(".reader-viewport") as HTMLElement;
      return {
        visible: viewport(root as HTMLElement, args.source, view, "visible"),
        context: viewport(root as HTMLElement, args.source, view),
      };
    },
    {
      source: section.text,
      offsets: readerOffsets.toString(),
      viewport: readerViewport.toString(),
    },
  );
  expect(
    actualRanges.visible!.end - actualRanges.visible!.start,
  ).toBeGreaterThan(3200);
  expect(actualRanges.context!.end - actualRanges.context!.start).toBe(3200);
  const paragraph = await text(page)
    .locator("p")
    .first()
    .evaluateHandle((element) => element.firstChild);
  const point = await sourcePoint(page, section, commonPoint + 1);
  await page.mouse.click(point.x, point.y);
  const toolbar = page.getByRole("toolbar", { name: "阅读选文操作" });
  await expect(toolbar.locator(".reader-selected-mark")).toHaveCount(56);
  const latePageMark = toolbar
    .locator(".reader-selected-mark")
    .filter({ has: page.locator("p", { hasText: /^DENSE_054$/ }) });
  await latePageMark.getByRole("button", { name: "绿色", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await allMarks(page, book.contentId)).find(
          (mark) => mark.id === dense[54]!.id,
        )?.color,
    )
    .toBe("green");
  expect(await paragraph.evaluate((node) => node?.isConnected)).toBe(true);
  await page.keyboard.press("Escape");
  const remotePoint = await sourcePoint(page, section, distant + 1);
  expect(remotePoint.y).toBeGreaterThan(0);
  expect(remotePoint.y).toBeLessThan(5000);
  await page.mouse.click(remotePoint.x, remotePoint.y);
  await expect(toolbar).toContainText("VISIBLE_AFTER_3200");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 960 });
  const laterPoint = await sourcePoint(page, section, denseStart + 6000, true);
  await expect
    .poll(async () => {
      const last = probe.reads
        .filter((read) => read.params.sectionId === section.id)
        .at(-1);
      return Number(last?.params.start ?? 0);
    })
    .toBeGreaterThan(commonPoint + 100);
  await page.mouse.click(laterPoint.x, laterPoint.y);
  await expect(toolbar).toContainText("LONG_BEFORE_VIEW");
  await toolbar
    .locator(".reader-selected-mark")
    .filter({ hasText: "LONG_BEFORE_VIEW" })
    .getByRole("button", { name: "编辑批注", exact: true })
    .click();
  await page
    .getByLabel("批注内容", { exact: true })
    .fill("LONG_REVISED_FROM_LATER_VIEW");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await allMarks(page, book.contentId)).find(
          (mark) => mark.id === long.id,
        )?.note,
    )
    .toBe("LONG_REVISED_FROM_LATER_VIEW");
  await expect
    .poll(() =>
      page
        .locator(".reading-app:visible .reader-viewport")
        .evaluate((view) => view.scrollTop),
    )
    .toBeGreaterThan(500);
  await probe.assertBounded();
  expect(
    probe.reads.every((read) => Boolean(read.params.sectionId)),
    "closed sidebar never causes a whole-book marks read",
  ).toBe(true);
  expect(probe.reads.some((read) => Boolean(read.params.after))).toBe(true);
  await info.attach("reader-dense-page-reads", {
    body: JSON.stringify(probe.reads, null, 2),
    contentType: "application/json",
  });
});

test("分页侧栏：自然续页、零长书签、删除失败同命令重试、撤销及重开保持标注和位置", async ({
  page,
}, info) => {
  await page.goto("/");
  const title = `TEST 侧栏分页 ${randomUUID().slice(0, 8)}`;
  const body = Array.from(
    { length: 70 },
    (_, i) =>
      `段落${String(i).padStart(3, "0")}：真实分页原文，标注可以继续修改和取消。`,
  ).join("\n\n");
  const book = await createBook(
    page,
    title,
    `# 第一章\n\n${body}\n\n# 第二章\n\n零长书签跳转到这里。\n\n${body}`,
  );
  const section = book.sections[0]!;
  const second = book.sections.find((item) => item.title === "第二章")!;
  expect(second).toBeDefined();
  for (let i = 0; i < 60; i++) {
    const start = section.text.indexOf(`段落${String(i).padStart(3, "0")}`);
    await addMark(
      page,
      book.contentId,
      section,
      start,
      start + 8,
      `PAGED_${String(i).padStart(3, "0")}`,
      "note",
    );
  }
  const bookmark = await addMark(
    page,
    book.contentId,
    second,
    0,
    0,
    "",
    "bookmark",
  );
  await page.reload();
  const probe = observeReads(page, book.contentId);
  await openReader(page, title);
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  const panel = marksPanel(page);
  await expect(panel.locator(".reader-mark")).toHaveCount(50);
  const firstRow = await panel.locator(".reader-mark").first().elementHandle();
  const textNode = await text(page)
    .locator("p")
    .first()
    .evaluateHandle((node) => node.firstChild);
  await panel.hover();
  await page.mouse.wheel(0, 5000);
  await expect(panel.locator(".reader-mark")).toHaveCount(61);
  expect(await firstRow!.evaluate((node) => node.isConnected)).toBe(true);
  expect(await textNode.evaluate((node) => node?.isConnected)).toBe(true);
  expect(await panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  // Observe (without replacing) actual CSS Highlight publications. A sidebar
  // jump flashes its exact quote; the subsequent paginated mark paint must not
  // clear that unrelated citation registry entry or its timer.
  await text(page).evaluate((root) => {
    const registry = (CSS as any).highlights;
    const original = registry.set;
    // An intentional sidebar jump reloads even the current section. The app
    // stays mounted, but its article is replaced while that exact text loads.
    const reader = root.closest(".reading-app")!;
    let citationKey = "",
      citation: Iterable<Range> | null = null,
      citationRoot: Element | null = null;
    const trace: Array<{
      key: string;
      preserved: boolean;
      quote: string;
      connected: boolean;
    }> = [];
    (window as any).__readerPaginationCitationTrace = trace;
    registry.set = function (key: string, highlight: Iterable<Range>) {
      const result = original.call(this, key, highlight);
      const currentRoot = reader.querySelector(".reader-text");
      if (
        key.startsWith("reader-mark-") &&
        key.endsWith("-citation") &&
        currentRoot?.isConnected &&
        [...highlight].some((range) =>
          currentRoot.contains(range.startContainer),
        )
      ) {
        citationKey = key;
        citation = highlight;
        citationRoot = currentRoot;
      } else if (
        citation &&
        key.startsWith(citationKey.slice(0, -"citation".length))
      ) {
        trace.push({
          key,
          preserved: registry.get(citationKey) === citation,
          quote: [...citation].map((range) => range.toString()).join(""),
          connected:
            !!citationRoot?.isConnected && citationRoot === currentRoot,
        });
      }
      return result;
    };
  });
  await panel
    .locator(".reader-mark")
    .filter({ hasText: "PAGED_055" })
    .getByRole("button")
    .first()
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__readerPaginationCitationTrace.length as number,
      ),
    )
    .toBeGreaterThan(0);
  const citationTrace = await page.evaluate(
    () =>
      (window as any).__readerPaginationCitationTrace as Array<{
        preserved: boolean;
        quote: string;
        connected: boolean;
      }>,
  );
  expect(
    citationTrace.every((entry) => entry.preserved && entry.connected),
  ).toBe(true);
  expect(citationTrace.every((entry) => entry.quote.includes("段落055"))).toBe(
    true,
  );
  await info.attach("reader-citation-survives-page-paint", {
    body: JSON.stringify(citationTrace, null, 2),
    contentType: "application/json",
  });
  const removalIds: string[] = [];
  await page.route("**/api/reader/commands", async (route) => {
    const request = route.request().postDataJSON();
    if (request.command?.action === "mark-remove") {
      removalIds.push(request.commandId);
      if (removalIds.length === 1) {
        await route.fulfill({
          status: 503,
          json: { message: "TEST 第二页标注删除暂失败" },
        });
        return;
      }
    }
    await route.continue();
  });
  const row = panel.locator(".reader-mark").filter({ hasText: "PAGED_055" });
  await row.getByRole("button", { name: "移除此标注", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "TEST 第二页标注删除暂失败",
  );
  expect((await allMarks(page, book.contentId)).length).toBe(61);
  await row.getByRole("button", { name: "移除此标注", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(panel.locator(".reader-mark")).toHaveCount(60);
  expect(removalIds).toEqual([removalIds[0], removalIds[0]]);
  await page.unroute("**/api/reader/commands");
  await page
    .getByRole("status")
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await expect(panel.locator(".reader-mark")).toHaveCount(61);
  await expect(row).toBeVisible();
  const restored = (await allMarks(page, book.contentId)).find(
    (mark) => mark.note === "PAGED_055",
  );
  expect(restored?.revision).toBe(3);
  // The already verified failed-delete notice overlaps the header control.
  // Dismiss it through the same visible action a Human uses before navigation.
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  // A real, previously authorized first page still contains PAGED_001. Hold
  // that response during a subsequent successful Human delete: releasing it
  // must not resurrect the removed row or shrink the already loaded prefix.
  let releasePage!: () => void;
  const heldPage = new Promise<void>((done) => {
    releasePage = done;
  });
  let pageStarted!: () => void;
  const startedPage = new Promise<void>((done) => {
    pageStarted = done;
  });
  let pageSettled!: () => void;
  const settledPage = new Promise<void>((done) => {
    pageSettled = done;
  });
  let holdPage = true;
  const stalePage = async (route: Route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("artifactId") !== book.contentId ||
      url.searchParams.has("sectionId") ||
      url.searchParams.has("after") ||
      !holdPage
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const result = (await response.json()) as { marks: StoredMark[] };
    expect(result.marks.some((mark) => mark.note === "PAGED_001")).toBe(true);
    holdPage = false;
    pageStarted();
    await heldPage;
    try {
      await route.fulfill({ response });
    } finally {
      pageSettled();
    }
  };
  await page.route("**/api/reader/marks?**", stalePage);
  try {
    await page.getByRole("button", { name: "书签与批注", exact: true }).click();
    await page.getByRole("button", { name: "书签与批注", exact: true }).click();
    await startedPage;
    const oldRow = panel
      .locator(".reader-mark")
      .filter({ hasText: "PAGED_001" });
    await oldRow
      .getByRole("button", { name: "移除此标注", exact: true })
      .click();
    await expect(oldRow).toHaveCount(0);
    await expect(panel.locator(".reader-mark")).toHaveCount(60);
    releasePage();
    await settledPage;
    await expect(oldRow).toHaveCount(0);
    await expect(panel.locator(".reader-mark")).toHaveCount(60);
    expect(
      (await allMarks(page, book.contentId)).some(
        (mark) => mark.note === "PAGED_001",
      ),
    ).toBe(false);
    await page
      .getByRole("status")
      .getByRole("button", { name: "撤销", exact: true })
      .click();
    await expect(panel.locator(".reader-mark")).toHaveCount(61);
    await expect(oldRow).toHaveCount(1);
  } finally {
    releasePage();
    await page.unroute("**/api/reader/marks?**", stalePage);
  }
  const zero = (await allMarks(page, book.contentId)).find(
    (mark) => mark.id === bookmark.id,
  )!;
  expect(zero.location.start).toBe(zero.location.end);
  await panel
    .locator(".reader-mark")
    .filter({ hasText: "从这里继续" })
    .getByRole("button")
    .first()
    .click();
  await expect(text(page)).toContainText("零长书签跳转到这里");
  const position = async () => {
    const response = await page.request.get(
      `/api/reader/state?artifactId=${book.contentId}&revision=1`,
    );
    expect(response.ok()).toBe(true);
    return (await response.json()).position as {
      location: { sectionId: string; start: number };
    } | null;
  };
  await expect
    .poll(async () => (await position())?.location.sectionId)
    .toBe(second.id);
  expect((await position())?.location.start).toBe(0);
  await page.reload();
  await expect(text(page)).toContainText("零长书签跳转到这里");
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  await expect(panel.locator(".reader-mark")).toHaveCount(50);
  await panel.hover();
  await page.mouse.wheel(0, 5000);
  await expect(panel.locator(".reader-mark")).toHaveCount(61);
  await expect(
    panel.locator(".reader-mark").filter({ hasText: "PAGED_055" }),
  ).toHaveCount(1);
  expect((await position())?.location.sectionId).toBe(second.id);
  await probe.assertBounded();
  expect(
    probe.reads.some(
      (read) => !read.params.sectionId && Boolean(read.params.after),
    ),
  ).toBe(true);
  await info.attach("reader-sidebar-page-reads", {
    body: JSON.stringify(probe.reads, null, 2),
    contentType: "application/json",
  });
});

test("迟到标注页：同 CSRF 撤权后不回填旧书，重新授权的新批注和其他读物草稿不被旧响应覆盖", async ({
  page,
}, info) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-reader-gui-late-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const owner = {
    principalId: "gui-marks-owner",
    actantId: "gui-marks-owner-human",
  };
  const reader = {
    principalId: "gui-marks-reader",
    actantId: "gui-marks-reader-human",
  };
  const token = "f".repeat(64);
  const members = [owner, reader].map((member) => ({
    ...member,
    enabled: true,
    projectIds: [] as string[],
  }));
  const identity = new IdentityCenter(
    store,
    {
      version: 1,
      members: [owner, reader].map((member, index) => ({
        ...member,
        enabled: true,
        loginTokenHash: createHash("sha256")
          .update(index ? token : "e".repeat(64))
          .digest("hex"),
      })),
    },
    Date.now,
    members,
  );
  const domains = await openApplicationDomainsHost(directory, store, identity);
  const options = {
    identity,
    platformWork: domains.work,
    platformDocuments: domains.content,
    platformScripts: domains.content,
    platformReader: domains.reader,
    bookmarkDomain: domains.browser,
    messageAttachments: domains.messageAttachments,
    images: domains.images,
    uiPackages: domains.uiPackages,
    notifications: domains.notifications,
    platformTaskRuns: domains.taskRuns(),
  };
  const app = new Application(store, options);
  const call = (
    who: typeof owner,
    method: ApplicationMethod,
    params: unknown,
  ) =>
    invokeApplication(
      app.session(who),
      method,
      params,
      "actual-reader-gui-setup",
      new AbortController().signal,
    );
  const projectIds = [randomUUID(), randomUUID()];
  const titles = [
    `TEST 可撤权读物 ${randomUUID().slice(0, 8)}`,
    `TEST 仍授权读物 ${randomUUID().slice(0, 8)}`,
  ];
  const contents: string[] = [];
  for (const [index, projectId] of projectIds.entries()) {
    await call(owner, "projects.create", {
      commandId: randomUUID(),
      projectId,
      title: `TEST GUI 标注项目 ${index}`,
    });
    const created = (await call(owner, "documents.create", {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: titles[index],
      markdown: `# 阅读章节\n\n${index ? "仍获授权原文" : "旧书私有原文"}，这是实际应用原件。`,
    })) as { contentId: string };
    contents.push(created.contentId);
  }
  const grants = [members[0]!, { ...members[1]!, projectIds }];
  await domains.content.platform.reconcileOperatorMembers(
    store.identity(),
    grants,
  );
  const marks: string[] = [];
  for (const [index, artifactId] of contents.entries()) {
    const sections = (await call(reader, "reader.contents", {
      artifactId,
      revision: 1,
    })) as Array<{ id: string }>;
    const section = (await call(reader, "reader.read", {
      artifactId,
      revision: 1,
      sectionId: sections[0]!.id,
    })) as ReadingSection;
    const start = section.text.indexOf(index ? "仍获授权原文" : "旧书私有原文");
    const receipt = (await call(reader, "reader.command", {
      commandId: randomUUID(),
      artifactId,
      revision: 1,
      command: {
        action: "mark-add",
        artifactId,
        artifactRevision: 1,
        location: {
          sourceId: section.sourceId,
          sectionId: section.id,
          start,
          end: start + 6,
        },
        quote: section.text.slice(start, start + 6),
        kind: "note",
        color: "yellow",
        note: index ? "ALLOWED_NOTE" : "REVOKED_OLD_NOTE",
      },
    })) as { id: string };
    marks.push(receipt.id);
  }
  const portProbe = createServer();
  await new Promise<void>((done) => portProbe.listen(0, "127.0.0.1", done));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((done) => portProbe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const server = createAppServer(store, {
    ...options,
    port,
    webRoot: resolve("dist/web"),
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let reached!: () => void;
  const started = new Promise<void>((done) => {
    reached = done;
  });
  let holdOnce = true;
  const routeEvents: Array<{
    phase: string;
    status?: number;
    notes?: string[];
  }> = [];
  const intercept = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("artifactId") !== contents[0] || !holdOnce) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const data = (await response.json()) as { marks: StoredMark[] };
    expect(data.marks.map((mark) => mark.note)).toEqual(["REVOKED_OLD_NOTE"]);
    holdOnce = false;
    routeEvents.push({
      phase: "actual-authorized-old-page",
      status: response.status(),
      notes: data.marks.map((mark) => mark.note),
    });
    reached();
    await held;
    try {
      await route.fulfill({ response });
      routeEvents.push({ phase: "late-page-released" });
    } catch {
      routeEvents.push({ phase: "old-page-request-aborted-after-navigation" });
    }
  };
  try {
    await page.goto(origin);
    await page.getByLabel("登录凭据").fill(token);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "主导航" }),
    ).toBeVisible();
    const auth = await headers(page);
    const oldProbe = observeReads(page, contents[0]!);
    await page.route(`${origin}/api/reader/marks?**`, intercept);
    await openReader(page, titles[0]!);
    await started;
    await domains.content.platform.reconcileOperatorMembers(store.identity(), [
      grants[0]!,
      { ...grants[1]!, projectIds: [projectIds[1]!] },
    ]);
    expect(
      (
        await page.request.get(
          `${origin}/api/reader/marks?artifactId=${contents[0]}&revision=1&limit=50`,
        )
      ).status(),
    ).toBe(404);
    const revokedBootstrap = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/platform/runtime-navigation" && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await revokedBootstrap;
    await expect
      .poll(async () => (await headers(page))["X-Morphz-Token"])
      .toBe(auth["X-Morphz-Token"]);
    await openReader(page, titles[1]!);
    await expect(text(page)).toContainText("仍获授权原文");
    await page.getByRole("button", { name: "书签与批注", exact: true }).click();
    await expect(marksPanel(page)).toContainText("ALLOWED_NOTE");
    await domains.content.platform.reconcileOperatorMembers(
      store.identity(),
      grants,
    );
    await call(reader, "reader.command", {
      commandId: randomUUID(),
      artifactId: contents[0],
      revision: 1,
      command: {
        action: "mark-update",
        markId: marks[0],
        expectedRevision: 1,
        color: "green",
        note: "REGRANTED_NEW_NOTE",
      },
    });
    const regrantBootstrap = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/platform/runtime-navigation" && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await regrantBootstrap;
    await openReader(page, titles[0]!);
    await page.getByRole("button", { name: "书签与批注", exact: true }).click();
    await expect(marksPanel(page)).toContainText("REGRANTED_NEW_NOTE");
    await expect(marksPanel(page)).not.toContainText("REVOKED_OLD_NOTE");
    await openReader(page, titles[1]!);
    const input = await openInput(page);
    await input.fill("其他读物的未发送草稿不受迟到页影响");
    release();
    await expect
      .poll(() =>
        routeEvents.some(
          (event) =>
            event.phase.startsWith("late-page") ||
            event.phase.startsWith("old-page-request"),
        ),
      )
      .toBe(true);
    await expect(text(page)).toContainText("仍获授权原文");
    await expect(text(page)).not.toContainText("旧书私有原文");
    await expect(input).toHaveValue("其他读物的未发送草稿不受迟到页影响");
    await openReader(page, titles[0]!);
    await page.getByRole("button", { name: "书签与批注", exact: true }).click();
    await expect(marksPanel(page)).toContainText("REGRANTED_NEW_NOTE");
    await expect(marksPanel(page)).not.toContainText("REVOKED_OLD_NOTE");
    expect((await headers(page))["X-Morphz-Token"]).toBe(
      auth["X-Morphz-Token"],
    );
    await oldProbe.assertBounded();
  } finally {
    release();
    await page.unroute(`${origin}/api/reader/marks?**`, intercept);
    await info.attach("reader-late-authorized-page", {
      body: JSON.stringify(routeEvents, null, 2),
      contentType: "application/json",
    });
    await page.goto("about:blank");
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
