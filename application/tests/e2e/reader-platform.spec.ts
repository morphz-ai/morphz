import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

async function openReader(page: Page, title: string) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  await page.getByRole("button", { name: `阅读：${title}` }).click();
  await expect(page.locator(".reading-app:visible .reader-text")).toContainText(
    "真实阅读原文",
  );
}

test("正式界面通过 Reader 私库读取 Objects Markdown、取消高亮并恢复", async ({
  page,
}) => {
  const title = `TEST Reader Platform ${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  const boot = (await (
    await page.request.get("/api/platform/bootstrap")
  ).json()) as {
    csrfToken: string;
  };
  const origin = "http://127.0.0.1:65421";
  const headers = { Origin: origin, "X-Morphz-Token": boot.csrfToken };
  const projectId = randomUUID();
  const createdProject = await page.request.post("/api/platform/projects", {
    headers,
    data: { commandId: randomUUID(), projectId, title: "TEST 阅读原件项目" },
  });
  expect(createdProject.ok()).toBeTruthy();
  const createdDocument = await page.request.post("/api/platform/documents", {
    headers,
    data: {
      commandId: randomUUID(),
      objectId: `reader_${randomUUID().replaceAll("-", "")}`,
      projectId,
      title,
      markdown: "# 第一节\n\n真实阅读原文。下一句。",
    },
  });
  expect(createdDocument.ok()).toBeTruthy();
  const { contentId } = (await createdDocument.json()) as { contentId: string };
  await page.reload();
  await openReader(page, title);
  const text = page.locator(".reading-app:visible .reader-text");
  await text.evaluate((root) => {
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = nodes.nextNode())) {
      const offset = node.textContent?.indexOf("真实阅读原文") ?? -1;
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + "真实阅读原文".length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      break;
    }
  });
  const toolbar = page.getByRole("toolbar", { name: "阅读选文操作" });
  await toolbar.getByRole("button", { name: "高亮选文", exact: true }).click();
  const state = async () => {
    const response = await page.request.get(
      `/api/reader/marks?artifactId=${contentId}&revision=1&limit=50`,
    );
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<{
      marks: Array<{ deletedAt: string | null }>;
    }>;
  };
  await expect
    .poll(async () => (await state()).marks.filter((m) => !m.deletedAt).length)
    .toBe(1);
  // The body is available before the independently paged annotations. Hold a
  // genuinely authorized range response and click once while it is pending:
  // its completion must recover that click, not require a second user action.
  let releaseMarks!: () => void, marksStarted!: () => void;
  const heldMarks = new Promise<void>((done) => {
    releaseMarks = done;
  });
  const startedMarks = new Promise<void>((done) => {
    marksStarted = done;
  });
  let holdMarks = true;
  await page.route("**/api/reader/marks?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      !holdMarks ||
      url.searchParams.get("artifactId") !== contentId ||
      !url.searchParams.has("sectionId")
    ) {
      await route.continue();
      return;
    }
    holdMarks = false;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    expect((await response.json()).marks).toHaveLength(1);
    marksStarted();
    await heldMarks;
    await route.fulfill({ response });
  });
  try {
    await page.reload();
    await openReader(page, title);
    await startedMarks;
    const point = await page
      .locator(".reading-app:visible .reader-text p")
      .filter({ hasText: "真实阅读原文" })
      .evaluate((p) => {
        const range = document.createRange();
        range.setStart(p.firstChild!, 1);
        range.setEnd(p.firstChild!, 2);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
    await page.mouse.click(point.x, point.y);
    await expect(toolbar).toHaveCount(0);
    releaseMarks();
    await toolbar
      .getByRole("button", { name: "取消高亮", exact: true })
      .click();
  } finally {
    releaseMarks();
    await page.unroute("**/api/reader/marks?**");
  }
  await expect
    .poll(async () => (await state()).marks.filter((m) => !m.deletedAt).length)
    .toBe(0);
});

test("正式界面导入书籍并打开，PDF 原件按授权范围读取", async ({ page }) => {
  await page.goto("/");
  const boot = (await (
    await page.request.get("/api/platform/bootstrap")
  ).json()) as {
    csrfToken: string;
  };
  const origin = "http://127.0.0.1:65421";
  const projectId = randomUUID();
  expect(
    (
      await page.request.post("/api/platform/projects", {
        headers: { Origin: origin, "X-Morphz-Token": boot.csrfToken },
        data: { commandId: randomUUID(), projectId, title: "TEST 阅读导入" },
      })
    ).ok(),
  ).toBeTruthy();
  const title = `TEST 导入原文 ${randomUUID().slice(0, 8)}`;
  const imported = await page.request.post("/api/import/reading", {
    headers: {
      Origin: origin,
      "X-Morphz-Token": boot.csrfToken,
      "X-Command-Id": randomUUID(),
      "X-Project-Id": projectId,
      "X-Source-Path": encodeURIComponent(`${title}.md`),
    },
    data: Buffer.from("# 第一章\n\n真实阅读原文。", "utf8"),
  });
  expect(imported.ok()).toBeTruthy();
  await page.reload();
  await openReader(page, title);
  const pdf = readFileSync(new URL("../fixtures/reader.pdf", import.meta.url));
  const importedPdf = await page.request.post("/api/import/reading", {
    headers: {
      Origin: origin,
      "X-Morphz-Token": boot.csrfToken,
      "X-Command-Id": randomUUID(),
      "X-Project-Id": projectId,
      "X-Source-Path": encodeURIComponent("TEST PDF 原件.pdf"),
    },
    data: pdf,
  });
  expect(importedPdf.ok()).toBeTruthy();
  const { entityId } = (await importedPdf.json()) as { entityId: string };
  const response = await page.request.get(
    `/api/reader/original?artifactId=${entityId}&revision=1`,
    { headers: { Range: "bytes=0-127" } },
  );
  expect(response.status()).toBe(206);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect(Buffer.from(await response.body())).toEqual(pdf.subarray(0, 128));
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  await page.getByRole("button", { name: "阅读：TEST PDF 原件" }).click();
  await expect(
    page.locator(".reading-app:visible .reader-pdf-page canvas"),
  ).toBeVisible();
});
