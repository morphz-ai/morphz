import { expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openInput } from "./interaction-helpers.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { commandSchema } from "../packages/core/src/model.js";
import type {
  PlatformHistory,
  PlatformClient,
} from "../apps/web/src/platform-client.js";
import type { LocalSavedInput } from "../apps/web/src/local-saved-inputs.js";

async function createDocument(
  source: PlatformClient,
  projectId: string,
  title: string,
  markdown: string,
) {
  const objectId = randomUUID();
  await source.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId,
    title,
    markdown,
  });
  return source.resolveContent({
    appId: "morphz.objects",
    appObjectId: objectId,
  });
}

/** Message presentation uses controlled Runtime history. Document/Reader data
 * use real app domains. Persistence and source authorization are separately
 * exercised by text-quotes.test.ts through the formal Host ingress/outbox. */
async function fixture(page: Page, failure?: "reject-once" | "lose-once") {
  const inputId = randomUUID();
  const createdAt = "2026-09-30T00:00:00.000Z";
  const records = new Map<
    string,
    { operation: LocalSavedInput["operation"]; createdAt: string }
  >();
  const sentIds: string[] = [];
  const submitted: PlatformHistory["inputs"] = [];
  const runtime: PlatformHistory["runtime"] = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    messages: [],
    deliveries: [
      { inputId, state: "completed", error: null, retryable: false },
    ],
  };
  const source = await mockPlatformConversation(page, () => ({
    inputs: [original, ...submitted],
    runtime,
  }));
  const original = source.input(
    inputId,
    "TEST 消息引用：如何选择工具？",
    createdAt,
  );
  const projectId = source.scope.projectId;
  runtime.messages = [
    {
      id: "publication:quote-fixture",
      ...source.scope,
      inputId,
      artifactId: null,
      rootId: null,
      kind: "reply",
      createdAt: "2026-09-30T00:00:00.001Z",
      text:
        "先**理解问题**，再选择工具。\n\n第二段：可以比较多个方案。\n\n" +
        "\u0060代码与标点 <tag> 🦋\u0060 也可以引用。",
    },
  ];
  await page.route("**/api/platform/messages", async (route) => {
    const { commandId, operation } = commandSchema.parse(
      route.request().postDataJSON(),
    );
    expect(operation.type).toBe("record-input");
    if (operation.type !== "record-input")
      throw new Error("Wrong message operation");
    sentIds.push(commandId);
    if (sentIds.length === 1 && failure === "reject-once")
      return route.fulfill({
        status: 503,
        json: { message: "TEST 暂时不可用" },
      });
    const existing = records.get(commandId);
    if (existing) expect(operation).toEqual(existing.operation);
    else
      records.set(commandId, {
        operation,
        createdAt: new Date().toISOString(),
      });
    if (sentIds.length === 1 && failure === "lose-once")
      return route.fulfill({
        status: 503,
        json: { message: "TEST 回执丢失" },
      });
    const record = records.get(commandId)!;
    if (!submitted.some((input) => input.id === commandId)) {
      const {
        type: _type,
        newConversation: _new,
        artifactId,
        artifactRevision,
        application,
        applicationInstanceId,
        ...fields
      } = operation;
      submitted.push({
        ...fields,
        ...source.input(commandId, operation.body, record.createdAt),
        projectId: operation.projectId,
        conversationId: operation.conversationId ?? operation.projectId,
        ...(artifactId ? { artifactId } : {}),
        ...(artifactRevision ? { artifactRevision } : {}),
        ...(application && applicationInstanceId
          ? {
              application: {
                ...application,
                instanceId: applicationInstanceId,
                harness: null,
              },
            }
          : {}),
      });
      runtime.deliveries.push({
        inputId: commandId,
        state: "queued",
        error: null,
        retryable: false,
      });
    }
    await route.fulfill({
      status: 202,
      json: { commandId, entityId: commandId },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const reply = page.locator('[data-message-id="publication:quote-fixture"]');
  await expect(reply).toBeVisible();
  return { ...source, reply, inputId, projectId, sentIds, records };
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

test("选文引用、逐段评论、去重、移除、发送与来源回跳", async ({
  page,
}, info) => {
  const { reply, records } = await fixture(page);
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
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(drafts).toHaveCount(0);
  const sent = page
    .locator(".human-message")
    .filter({ hasText: "请举一个具体例子。" })
    .last();
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
  await sent.getByRole("button", { name: "查看引用 1 的原文" }).click();
  await expect(reply).toHaveAttribute("data-quote-revealed", "true");
  const saved = [...records.values()].find(
    (input) => input.operation.body === "请举一个具体例子。",
  )!;
  expect(saved.operation.textQuotes![0]).toMatchObject({
    text: selected,
    comment: "先判断问题的依据是什么？",
    source: { messageId: "publication:quote-fixture" },
  });
  await page.reload();
  await openInput(page);
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
});

test("四条待发引用经普通输入、工作台切换和重载仍完整保留", async ({ page }) => {
  const { reply } = await fixture(page);
  const drafts = page.getByRole("group", { name: "选文与评论", exact: true });
  const selections = [
    "理解问题",
    "再选择工具",
    "可以比较多个方案",
    "代码与标点",
  ];
  for (const selection of selections) {
    await selectText(reply.locator("[data-quotable]"), selection);
    await page.getByRole("button", { name: "评论选中文字" }).click();
    await page.keyboard.press("Escape");
  }
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(4);
  await page.getByLabel("AI 输入内容").fill("这条消息暂时不发送");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await openInput(page);
  await page.getByLabel("AI 输入内容").fill("工作台也有自己的输入");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(4);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "这条消息暂时不发送",
  );
  await page.reload();
  await openInput(page);
  await expect(drafts.locator(".text-quote-chip")).toHaveCount(4);
  for (const selection of selections)
    await expect(drafts).toContainText(selection);
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

test("仅引用消息失败后保留引文，可从原卡片重试", async ({ page }) => {
  const { reply, sentIds, records } = await fixture(page, "reject-once");
  const selected = "第二段：可以比较多个方案。";
  await selectText(reply.locator("[data-quotable]"), selected);
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.keyboard.press("Escape");
  const drafts = page.getByRole("group", { name: "选文与评论", exact: true });
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  const input = page.getByLabel("AI 输入内容");
  await expect(input).toHaveValue("");
  await expect(send).toBeEnabled();
  const firstRequest = page.waitForRequest("**/api/platform/messages");
  await send.click();
  const original = commandSchema.parse((await firstRequest).postDataJSON());
  const sent = page.locator(
    `.human-message[data-input-id="${original.commandId}"]`,
  );
  const retry = sent.getByRole("button", { name: "重新发送消息", exact: true });
  await expect(sent).toHaveCount(1);
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
  await expect(retry).toBeVisible();
  await expect(sent).toHaveAttribute("data-submission-state", "failed");
  await expect(drafts).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(send).toBeDisabled();
  expect(sentIds).toEqual([original.commandId]);
  expect(records.size).toBe(0); // The first request was rejected before storage.

  const nextDraft = "TEST 新草稿不参与原引用消息重试";
  await input.fill(nextDraft);
  const retryRequest = page.waitForRequest("**/api/platform/messages");
  await retry.click();
  expect(commandSchema.parse((await retryRequest).postDataJSON())).toEqual(
    original,
  );
  await expect(retry).toHaveCount(0);
  await expect(sent).toHaveCount(1);
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
  await expect(input).toHaveValue(nextDraft);
  await expect(drafts).toHaveCount(0);
  expect(sentIds).toHaveLength(2);
  expect(sentIds[1]).toBe(sentIds[0]);
  expect(records.size).toBe(1);
  expect(records.get(original.commandId)!.operation).toMatchObject({
    body: "",
    textQuotes: [
      { text: selected, source: { messageId: "publication:quote-fixture" } },
    ],
  });
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
  const {
    reply,
    projectId: conversationId,
    client,
    spaces,
    records,
  } = await fixture(page);
  await selectText(
    reply.locator("[data-quotable]"),
    "先理解问题，再选择工具。",
  );
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.getByLabel("引用 1 的评论（可选）").fill("第一处：历史消息");
  await page.keyboard.press("Escape");
  const projectId = spaces.deskId;
  const title = "TEST 统一评论文档 " + Date.now();
  const doc = await createDocument(
    client,
    projectId,
    title,
    "# 合成文档\n\n文档中的第二处意见。\n\n另一段原文。",
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
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
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(drafts).toHaveCount(0);
  const submitted = [...records.values()].findLast(
    (i) => i.operation.body === "TEST 将这三处一起讨论",
  )!.operation;
  expect(submitted.conversationId).toBe(conversationId);
  expect(submitted.textQuotes!.map((q) => q.source.kind)).toEqual([
    "message",
    "artifact",
    "reading",
  ]);
  expect(submitted.textQuotes![1]!.source).toMatchObject({
    artifactId: doc.id,
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
  const { client, spaces, records } = await fixture(page);
  const projectId = spaces.deskId;
  const title = "TEST 草稿评论 " + Date.now();
  const doc = await createDocument(client, projectId, title, "已保存的原文。");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容库", exact: true })
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
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("group", { name: "选文与评论" })).toHaveCount(0);
  expect(await client.readDocument(doc.id)).toMatchObject({
    revision: 1,
    markdown: "已保存的原文。",
  });
  expect(
    [...records.values()].findLast(
      (i) =>
        i.operation.textQuotes?.[0]?.comment === "TEST 讨论草稿，不保存正文",
    )?.operation.textQuotes?.[0],
  ).toMatchObject({
    draft: true,
    text: selected,
    anchor: { field: "文档正文" },
  });
});

test("切换命名对话不带入另一 Session 的评论草稿", async ({ page }) => {
  const { reply, client, refresh } = await fixture(page);
  await selectText(
    reply.locator("[data-quotable]"),
    "先理解问题，再选择工具。",
  );
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.getByLabel("引用 1 的评论（可选）").fill("TEST 原 Session 评论");
  await page.keyboard.press("Escape");
  const title = "TEST 独立引用 " + Date.now();
  await client.createProject(title, randomUUID(), randomUUID());
  // This suite controls invalidations as well as Runtime presentation data.
  await refresh();
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

test("消息回执丢失时，原评论使用同一命令重试且不重复提交", async ({ page }) => {
  const { reply, sentIds, records } = await fixture(page, "lose-once");
  const selected = "再选择工具。";
  const comment = "TEST 回执丢失";
  const body = "TEST 回执丢失时原消息正文";
  await selectText(reply.locator("[data-quotable]"), selected);
  await page.getByRole("button", { name: "评论选中文字" }).click();
  await page.getByLabel("引用 1 的评论（可选）").fill(comment);
  await page.keyboard.press("Escape");
  const input = page.getByLabel("AI 输入内容");
  await input.fill(body);
  const firstRequest = page.waitForRequest("**/api/platform/messages");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const original = commandSchema.parse((await firstRequest).postDataJSON());
  const sent = page.locator(
    `.human-message[data-input-id="${original.commandId}"]`,
  );
  const retry = sent.getByRole("button", { name: "重新发送消息", exact: true });
  await expect(retry).toBeVisible();
  await expect(sent).toHaveCount(1);
  await expect(sent).toHaveAttribute("data-submission-state", "failed");
  await expect(sent).toContainText(body);
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
  await expect(sent.locator(".text-quote-comment")).toHaveText(comment);
  await expect(page.getByRole("group", { name: "选文与评论" })).toHaveCount(0);
  await expect(input).toHaveValue("");
  expect(sentIds).toEqual([original.commandId]);
  expect(records.size).toBe(1); // Stored once even though its receipt was lost.

  await page.reload();
  await openInput(page);
  await expect(retry).toBeVisible();
  await expect(sent).toHaveCount(1);
  await expect(sent).toHaveAttribute("data-submission-state", "failed");
  await expect(sent).toContainText(body);
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
  await expect(sent.locator(".text-quote-comment")).toHaveText(comment);
  expect(sentIds).toHaveLength(1); // Reload must not silently resend.
  const nextDraft = "TEST 刷新后的新草稿不参与原消息重试";
  await input.fill(nextDraft);
  const retryRequest = page.waitForRequest("**/api/platform/messages");
  await retry.click();
  expect(commandSchema.parse((await retryRequest).postDataJSON())).toEqual(
    original,
  );
  await expect(retry).toHaveCount(0);
  await expect(sent).toHaveCount(1);
  await expect(sent).toContainText(body);
  await expect(sent.locator(".sent-text-quotes")).toContainText(selected);
  await expect(sent.locator(".text-quote-comment")).toHaveText(comment);
  await expect(input).toHaveValue(nextDraft);
  await expect(page.getByRole("group", { name: "选文与评论" })).toHaveCount(0);
  expect(sentIds).toHaveLength(2);
  expect(sentIds[1]).toBe(sentIds[0]);
  expect(records.size).toBe(1);
  expect(records.get(original.commandId)!.operation).toMatchObject({
    body,
    textQuotes: [
      {
        text: selected,
        comment,
        source: { messageId: "publication:quote-fixture" },
      },
    ],
  });
  expect(
    [...records.values()].filter((i) =>
      i.operation.textQuotes?.some((q) => q.comment === comment),
    ),
  ).toHaveLength(1);
});
