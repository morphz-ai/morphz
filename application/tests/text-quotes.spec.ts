import { test, expect, type Page, type Locator } from "@playwright/test";
import { seedCenter } from "./center-fixtures.js";
import { openInput } from "./interaction-helpers.js";
import type { Boot } from "../apps/web/src/client.js";

async function fixture(page: Page) {
  const boot: Boot = await (await page.request.get("/api/workspace")).json();
  const projectId = boot.workspace.projects.find(
    (project) => project.kind === "dialogue",
  )!.id;
  const inputId = await seedCenter(page, {
    type: "record-input",
    projectId,
    conversationId: projectId,
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "TEST 消息引用：如何选择工具？",
    targetActantId: "morphz-agent",
  });
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const data: Boot = await response.json();
    const original = data.workspace.inputs.find(
      (input) => input.id === inputId,
    )!;
    data.runtime.messages = [
      {
        id: "publication:quote-fixture",
        projectId,
        conversationId: projectId,
        inputId,
        artifactId: null,
        rootId: null,
        kind: "reply",
        createdAt: new Date(Date.parse(original.createdAt) + 1).toISOString(),
        text: "先**理解问题**，再选择工具。\n\n第二段：可以比较多个方案。\n\n`代码与标点 <tag> 🦋` 也可以引用。",
      },
    ];
    data.runtime.deliveries = data.workspace.inputs.map((input) => ({
      inputId: input.id,
      state: "completed",
      error: null,
      retryable: false,
    }));
    await route.fulfill({ response, json: data });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const reply = page.locator('[data-message-id="publication:quote-fixture"]');
  await expect(reply).toBeVisible();
  return { reply, inputId, projectId };
}

async function selectText(locator: Locator, text: string) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element, text) => {
    const offset = element.textContent!.indexOf(text);
    if (offset < 0) throw new Error("Selection not found");
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let count = 0,
      start = false,
      node: Node | null;
    while ((node = walker.nextNode())) {
      const end = count + node.textContent!.length;
      if (!start && offset < end) {
        range.setStart(node, offset - count);
        start = true;
      }
      if (start && offset + text.length <= end) {
        range.setEnd(node, offset + text.length - count);
        break;
      }
      count = end;
    }
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, text);
}

test("选文引用、逐段评论、去重、移除、草稿恢复、真实保存与来源回跳", async ({
  page,
}, info) => {
  const { reply } = await fixture(page);
  const selected = "先理解问题，再选择工具。";
  await selectText(reply.locator("[data-quotable]"), selected);
  const quoteButton = page.getByRole("button", { name: "评论选中文字" });
  await expect(quoteButton).toBeVisible();
  await quoteButton.click();
  const drafts = page.getByRole("group", { name: "选文与评论", exact: true });
  await expect(drafts).toContainText(selected);
  await expect(page.getByLabel("引用 1 的评论（可选）")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await selectText(reply.locator("[data-quotable]"), selected);
  await quoteButton.click();
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await selectText(reply.locator("[data-quotable]"), "可以比较多个方案。");
  await quoteButton.click();
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await drafts.getByRole("button", { name: "移除引用 2", exact: true }).click();
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(1);
  await drafts.getByRole("button", { name: "编辑引用 1 的评论" }).click();
  await page
    .getByLabel("引用 1 的评论（可选）")
    .fill("先判断问题的依据是什么？");
  await page.screenshot({ path: info.outputPath("inline-comment.png") });
  await page.keyboard.press("Escape");
  await page.getByLabel("AI 输入内容").fill("请举一个具体例子。");
  await page.reload();
  await openInput(page);
  await expect(drafts).toContainText("先判断问题的依据是什么？");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "请举一个具体例子。",
  );
  await page.screenshot({ path: info.outputPath("quote-draft.png") });
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/commands"),
  );
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await response;
  await expect(drafts).toHaveCount(0);
  const sent = page
    .locator(".human-message")
    .filter({ hasText: "请举一个具体例子。" })
    .last();
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
  await sent.getByRole("button", { name: "查看引用 1 的原文" }).click();
  await expect(reply).toHaveAttribute("data-quote-revealed", "true");
  const saved: Boot = await (await page.request.get("/api/workspace")).json();
  expect(saved.workspace.inputs.at(-1)!.textQuotes![0]).toMatchObject({
    text: selected,
    comment: "先判断问题的依据是什么？",
    source: { messageId: "publication:quote-fixture" },
  });
  await page.reload();
  await openInput(page);
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
});

test("评论只呈现两行输入，失焦保留草稿，窄窗和明暗主题不增加重复内容", async ({
  page,
}, info) => {
  const { reply } = await fixture(page);
  const drafts = page.getByRole("group", { name: "选文与评论", exact: true });
  const editor = page.getByRole("dialog", {
    name: "引用 1 的评论",
    exact: true,
  });
  const comment = page.getByLabel("引用 1 的评论（可选）");
  const input = page.getByLabel("AI 输入内容", { exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await selectText(reply.locator("[data-quotable]"), "再选择工具。");
    await page.getByRole("button", { name: "评论选中文字" }).click();
    await expect(comment).toBeFocused();
    const box = (await editor.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(260);
    expect(box.height).toBeLessThanOrEqual(60);
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.y + box.height).toBeLessThanOrEqual(752);
    await expect(
      editor.locator("header, blockquote, footer, button"),
    ).toHaveCount(0);
    await expect(comment).toHaveAttribute("rows", "2");
    expect(
      await comment.evaluate((node) => getComputedStyle(node).outlineStyle),
    ).toBe("none");
    await comment.fill("TEST 紧凑评论");
    await comment.press("Enter");
    await comment.pressSequentially("TEST");
    await expect(comment).toHaveValue("TEST 紧凑评论\nTEST");
    await page.screenshot({
      path: info.outputPath(`compact-comment-${width}.png`),
    });
    await input.click();
    await expect(editor).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(drafts).toContainText("TEST 紧凑评论");
    await drafts
      .getByRole("button", { name: "编辑引用 1 的评论", exact: true })
      .click();
    await expect(comment).toHaveValue("TEST 紧凑评论\nTEST");
    // A keyboard blur must dismiss too, without moving focus back to the editor.
    await comment.press("Tab");
    await expect(editor).toHaveCount(0);
    await expect(drafts.locator(".text-quote-chip")).toHaveCount(1);
  }
  await page.reload();
  await openInput(page);
  await drafts
    .getByRole("button", { name: "编辑引用 1 的评论", exact: true })
    .click();
  await expect(comment).toHaveValue("TEST 紧凑评论\nTEST");
  await comment.press("Escape");
  await expect(input).toBeFocused();
});

test("行中引用的编号位于正文外侧，同一行多个编号不重叠，点击可切换和收起评论", async ({
  page,
}, info) => {
  const { reply } = await fixture(page);
  const source = reply.locator("[data-quotable]");
  for (const text of ["理解问题", "再选择工具", "代码与标点"]) {
    await selectText(source, text);
    await page.getByRole("button", { name: "评论选中文字" }).click();
    await page.keyboard.press("Escape");
  }
  const markers = page.locator(".text-quote-marker");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await source.scrollIntoViewIfNeeded();
    await expect(markers).toHaveCount(3);
    await expect
      .poll(async () => {
        const body = (await source.boundingBox())!;
        const badges = await markers.evaluateAll((nodes) =>
          nodes.map((node) => {
            const r = node.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          }),
        );
        return badges.every(
          (r, i) =>
            // The whole content column, not just the selected word, stays clear.
            r.right <= body.x - 2 &&
            r.left >= 0 &&
            r.bottom <= 760 &&
            badges.every(
              (other, j) =>
                i === j ||
                r.right <= other.left ||
                r.left >= other.right ||
                r.bottom + 2 <= other.top ||
                r.top >= other.bottom + 2,
            ),
        );
      })
      .toBe(true);
    const first = markers.filter({ hasText: /^1$/ });
    const second = markers.filter({ hasText: /^2$/ });
    const comment = page.getByRole("dialog", {
      name: "引用 1 的评论",
      exact: true,
    });
    await first.click();
    await comment.getByRole("textbox").fill("TEST 第一处");
    await first.click();
    await expect(comment).toHaveCount(0);
    await first.click();
    await expect(comment.getByRole("textbox")).toHaveValue("TEST 第一处");
    await second.click();
    await expect(page.getByLabel("引用 2 的评论（可选）")).toBeFocused();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: info.outputPath(`quote-gutter-${width}.png`),
    });
  }
});

test("失败保留引用与正文，可重试；只引用也能发送", async ({ page }) => {
  const { reply } = await fixture(page);
  await selectText(
    reply.locator("[data-quotable]"),
    "第二段：可以比较多个方案。",
  );
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.keyboard.press("Escape");
  const drafts = page.getByRole("group", { name: "选文与评论", exact: true });
  await page.route(
    "**/api/commands",
    (route) =>
      route.fulfill({ status: 503, json: { error: "TEST 暂时不可用" } }),
    { times: 1 },
  );
  const send = page.getByRole("button", { name: "保存输入", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(drafts).toContainText("可以比较多个方案");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(drafts).toHaveCount(0);
  await expect(
    page.locator(".human-message").last().locator(".sent-text-quotes"),
  ).toContainText("可以比较多个方案");
});

test("选文按钮跟随阅读区域，不引用时间或跨消息内容，Escape 关闭；窄屏和暗色不溢出", async ({
  page,
}, info) => {
  const { reply, inputId } = await fixture(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await selectText(reply.locator("[data-quotable]"), "再选择工具");
    const popup = page.getByRole("button", { name: "评论选中文字" });
    await expect(popup).toBeVisible();
    const bounds = (await popup.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    const hit = await popup.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    });
    expect(hit).toBe(true);
    await page.screenshot({ path: info.outputPath(`selection-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await reply.locator("[data-quotable]").evaluate((element, inputId) => {
      const start = document.querySelector(
        `[data-message-id="${inputId}"] [data-quotable]`,
      )!;
      const range = document.createRange();
      range.setStart(start.firstChild!, 0);
      range.setEnd(element.lastChild!, 1);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    }, inputId);
    await expect(popup).toHaveCount(0);
  }
});

test("消息、文档、阅读选文跨页面汇总，翻章不改引用，刷新与回跳保留当前对话", async ({
  page,
}, info) => {
  const { reply, projectId: conversationId } = await fixture(page);
  await selectText(
    reply.locator("[data-quotable]"),
    "先理解问题，再选择工具。",
  );
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.getByLabel("引用 1 的评论（可选）").fill("第一处：历史消息");
  await page.keyboard.press("Escape");
  const boot: Boot = await (await page.request.get("/api/workspace")).json();
  const projectId = boot.workspace.projects.find((p) => p.kind === "desk")!.id;
  const title = "TEST 统一评论文档 " + Date.now();
  const documentId = await seedCenter(page, {
    type: "create-artifact",
    projectId,
    title,
    content: {
      kind: "document",
      markdown: "# 合成文档\n\n文档中的第二处意见。\n\n另一段原文。",
    },
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  const documentText = page.locator(".document-body");
  await expect(documentText).toBeVisible();
  await selectText(documentText, "文档中的第二处意见。");
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.getByLabel("引用 2 的评论（可选）").fill("第二处：文档");
  await page.keyboard.press("Escape");
  const drafts = page.getByRole("group", { name: "选文与评论" });
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(2);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "阅读 1.0.0", exact: true }).click();
  const back = page.getByRole("button", { name: "全部读物", exact: true });
  await expect(
    back.or(page.getByRole("region", { name: "阅读书库" })),
  ).toBeVisible();
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "TEST 统一评论跨章.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# 第一章\n\n第一章的原文保持不变。\n\n# 第二章\n\n第二章不能替换第一处引用。",
    ),
  });
  const reader = page.locator(".reading-app:visible .reader-text");
  await expect(reader).toContainText("第一章的原文");
  await selectText(reader, "第一章的原文保持不变。");
  await reader.dispatchEvent("mouseup");
  await page
    .getByRole("toolbar", { name: "阅读选文操作" })
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await expect(page.getByLabel("引用 3 的评论（可选）")).toBeFocused();
  await page.getByLabel("引用 3 的评论（可选）").fill("第三处：阅读第一章");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await page.getByRole("button", { name: "下一章", exact: true }).click();
  await expect(reader).toContainText("第二章不能替换");
  await page.reload();
  await openInput(page);
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(3);
  await drafts.getByRole("button", { name: "编辑引用 3 的评论" }).click();
  const comment = page.getByRole("dialog", {
    name: "引用 3 的评论",
    exact: true,
  });
  await expect(comment.getByRole("textbox")).toHaveValue("第三处：阅读第一章");
  await expect(
    drafts.getByRole("button", { name: "编辑引用 3 的评论" }),
  ).toHaveAttribute("title", /第一章的原文保持不变。/);
  await drafts.getByRole("button", { name: "查看引用 3 的原文" }).click();
  await expect(reader).toContainText("第一章的原文保持不变。");
  await openInput(page);
  await page
    .getByLabel("AI 输入内容", { exact: true })
    .fill("TEST 将这三处一起讨论");
  await page.screenshot({ path: info.outputPath("multi-source-quotes.png") });
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(drafts).toHaveCount(0);
  const saved: Boot = await (await page.request.get("/api/workspace")).json();
  const submitted = saved.workspace.inputs.findLast(
    (i) => i.body === "TEST 将这三处一起讨论",
  )!;
  expect(submitted.conversationId).toBe(conversationId);
  expect(submitted.textQuotes!.map((q) => q.source.kind)).toEqual([
    "message",
    "artifact",
    "reading",
  ]);
  expect(submitted.textQuotes![1]!.source).toMatchObject({
    artifactId: documentId,
    revision: 1,
  });
  expect(submitted.textQuotes![2]).toMatchObject({
    text: "第一章的原文保持不变。",
    comment: "第三处：阅读第一章",
    source: { chapter: "第一章" },
  });
  expect(submitted.reading).toBeUndefined();
});

test("编辑中正文选文可评论、回跳，发送不保存或覆盖原文", async ({ page }) => {
  await fixture(page);
  const boot: Boot = await (await page.request.get("/api/workspace")).json();
  const projectId = boot.workspace.projects.find((p) => p.kind === "desk")!.id;
  const title = "TEST 草稿评论 " + Date.now();
  const artifactId = await seedCenter(page, {
    type: "create-artifact",
    projectId,
    title,
    content: { kind: "document", markdown: "已保存的原文。" },
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const field = page.getByLabel("文档正文", { exact: true });
  await field.fill("TEST 尚未保存的改写。后半段保留。");
  await field.evaluate((node: HTMLTextAreaElement) => {
    node.focus();
    node.setSelectionRange(0, 14);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const selected = await field.evaluate((node: HTMLTextAreaElement) =>
    node.value.slice(node.selectionStart, node.selectionEnd),
  );
  await page.getByRole("button", { name: "评论选中文字" }).click();
  const draftSource = page
    .getByRole("group", { name: "选文与评论" })
    .getByRole("button", { name: "查看引用 1 的原文", exact: true });
  await page
    .getByLabel("引用 1 的评论（可选）")
    .fill("TEST 讨论草稿，不保存正文");
  await page.keyboard.press("Escape");
  await expect(draftSource).toHaveAttribute("title", /编辑中/);
  await draftSource.click();
  await expect(field).toBeFocused();
  expect(
    await field.evaluate((node: HTMLTextAreaElement) =>
      node.value.slice(node.selectionStart, node.selectionEnd),
    ),
  ).toBe(selected);
  await openInput(page);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.getByRole("group", { name: "选文与评论" })).toHaveCount(0);
  const after: Boot = await (await page.request.get("/api/workspace")).json();
  expect(
    after.workspace.artifacts.find((a) => a.id === artifactId)!.content,
  ).toEqual({ kind: "document", markdown: "已保存的原文。" });
  expect(
    after.workspace.inputs.findLast(
      (i) => i.textQuotes?.[0]?.comment === "TEST 讨论草稿，不保存正文",
    )?.textQuotes?.[0],
  ).toMatchObject({
    draft: true,
    text: selected,
    anchor: { field: "文档正文" },
  });
});

test("切换命名对话不带入另一 Session 的评论草稿", async ({ page }) => {
  const { reply } = await fixture(page);
  await selectText(
    reply.locator("[data-quotable]"),
    "先理解问题，再选择工具。",
  );
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.getByLabel("引用 1 的评论（可选）").fill("TEST 原 Session 评论");
  await page.keyboard.press("Escape");
  const title = "TEST 独立引用 " + Date.now();
  await seedCenter(page, { type: "create-project", title });
  await page
    .getByRole("button", { name: "新建项目对话：" + title, exact: true })
    .click();
  await openInput(page);
  await expect(page.getByRole("group", { name: "选文与评论" })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  await expect(page.getByRole("group", { name: "选文与评论" })).toContainText(
    "TEST 原 Session 评论",
  );
});

test("服务器已保存但回执丢失时，原评论可重试且只保存一次", async ({ page }) => {
  const { reply } = await fixture(page);
  await selectText(reply.locator("[data-quotable]"), "再选择工具。");
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.getByLabel("引用 1 的评论（可选）").fill("TEST 回执丢失");
  await page.keyboard.press("Escape");
  const ids: string[] = [];
  await page.route("**/api/commands", async (route) => {
    const request = route.request().postDataJSON();
    if (request.operation.type !== "record-input") return route.continue();
    ids.push(request.commandId);
    if (ids.length === 1) {
      const result = await route.fetch();
      expect(result.ok()).toBe(true);
      return route.fulfill({ status: 503, json: { message: "TEST 回执丢失" } });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.getByRole("group", { name: "选文与评论" })).toContainText(
    "TEST 回执丢失",
  );
  await page.reload();
  await openInput(page);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.getByRole("group", { name: "选文与评论" })).toHaveCount(0);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  const boot: Boot = await (await page.request.get("/api/workspace")).json();
  expect(
    boot.workspace.inputs.filter((i) =>
      i.textQuotes?.some((q) => q.comment === "TEST 回执丢失"),
    ),
  ).toHaveLength(1);
});
