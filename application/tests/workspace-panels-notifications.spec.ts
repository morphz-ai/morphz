import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";
import type { ReadingSection } from "../packages/core/src/reader.js";
import { openLibrary } from "./application-helpers.js";
import { openInput } from "./interaction-helpers.js";

// Real Runtime Profile, five SQL stores, Host, SSE and mounted production UI.
// These tests never submit input or invoke a language model.
test.setTimeout(120_000);
let fixture: Awaited<ReturnType<typeof profileActualTransportFixture>>;
test.beforeEach(async () => {
  fixture = await profileActualTransportFixture();
});
test.afterEach(async () => {
  await fixture?.close();
});

async function editor(page: Page) {
  await page.goto(fixture.origin);
  const toggle = page.getByRole("button", { name: /^(显示|隐藏)右侧栏$/ });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const panel = page.locator(".subject-sidebar");
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const name = panel.getByRole("button", {
    name: "编辑智能体名字",
    exact: true,
  });
  await expect(name).toBeEnabled();
  return name;
}

test("Profile真实外部提交在当前页面更新；读取中再提交不会丢最后一版", async ({
  page,
}) => {
  const name = await editor(page);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  let holdNext = true;
  await page.route(fixture.origin + "/api/profile", async (route) => {
    if (route.request().method() !== "GET" || !holdNext)
      return route.continue();
    holdNext = false;
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  try {
    const first = (await fixture.read()).agent;
    await fixture.update({
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: first.revision,
      enabled: true,
      data: { ...first.data, name: "TEST 通知第一版" },
    });
    await seen;
    const next = (await fixture.read()).agent;
    await fixture.update({
      subject: "agent",
      commandId: randomUUID(),
      expectedRevision: next.revision,
      enabled: true,
      data: { ...next.data, name: "TEST 通知最终版" },
    });
    release();
    await expect(name).toHaveText("TEST 通知最终版");
    expect((await fixture.read()).agent.data.name).toBe("TEST 通知最终版");
    expect(fixture.requests).toHaveLength(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("Reader真实外部标注通知重读打开面板，不换正文DOM、选文或阅读位置", async ({
  page,
}) => {
  const projectId = randomUUID(),
    title = "TEST 通知阅读原件";
  await fixture.client.call(
    "projects.create",
    { commandId: randomUUID(), projectId, title: "TEST 通知阅读项目" },
    fixture.options,
  );
  const createdDocument = (await fixture.client.call(
    "documents.create",
    {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title,
      markdown:
        "# 通知章节\n\n真实通知阅读原文，后台新增批注不应打断当前选文。",
    },
    fixture.options,
  )) as { contentId: string };
  await page.goto(fixture.origin);
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
  const reading = page.locator(".reading-app:visible");
  const text = reading.locator(".reader-text");
  await expect(text).toContainText("真实通知阅读原文");
  await reading
    .getByRole("button", { name: "书签与批注", exact: true })
    .click();
  const marks = reading.getByRole("complementary", {
    name: "阅读标注",
    exact: true,
  });
  await expect(marks).toContainText("暂无书签或标注");
  await text.evaluate((root) => {
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      const offset = node.textContent?.indexOf("真实通知阅读原文") ?? -1;
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + "真实通知阅读原文".length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      break;
    }
    Reflect.set(window, "notificationReaderBody", root);
    Reflect.set(
      window,
      "notificationReaderScroll",
      root.closest(".reader-viewport")?.scrollTop ?? 0,
    );
  });
  const contents = (await fixture.client.call(
    "reader.contents",
    { artifactId: createdDocument.contentId, revision: 1 },
    fixture.options,
  )) as { id: string }[];
  const section = (await fixture.client.call(
    "reader.read",
    {
      artifactId: createdDocument.contentId,
      revision: 1,
      sectionId: contents[0]!.id,
    },
    fixture.options,
  )) as ReadingSection;
  const start = section.text.indexOf("真实通知阅读原文");
  expect(start).toBeGreaterThanOrEqual(0);
  await fixture.client.call(
    "reader.command",
    {
      commandId: randomUUID(),
      artifactId: createdDocument.contentId,
      revision: 1,
      command: {
        action: "mark-add",
        artifactId: createdDocument.contentId,
        artifactRevision: 1,
        location: {
          sourceId: section.sourceId,
          sectionId: section.id,
          start,
          end: start + "真实通知阅读原文".length,
        },
        quote: "真实通知阅读原文",
        kind: "note",
        color: "yellow",
        note: "TEST 外部提交的阅读批注",
      },
    },
    fixture.options,
  );
  await expect(marks).toContainText("TEST 外部提交的阅读批注");
  expect(
    await text.evaluate((root) => ({
      sameBody: Reflect.get(window, "notificationReaderBody") === root,
      selection: window.getSelection()?.toString(),
      sameScroll:
        Reflect.get(window, "notificationReaderScroll") ===
        (root.closest(".reader-viewport")?.scrollTop ?? 0),
    })),
  ).toEqual({
    sameBody: true,
    selection: "真实通知阅读原文",
    sameScroll: true,
  });
  expect(fixture.requests).toHaveLength(0);
});

test("Browser已打开收藏列表消费真实外部提交，不导航或发起工作", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "浏览器 1.0.0" })
    .click();
  await page.getByRole("button", { name: "浏览器收藏", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "浏览器收藏", exact: true });
  await expect(dialog).toBeVisible();
  await fixture.client.call(
    "bookmarks.command",
    {
      commandId: randomUUID(),
      operation: {
        type: "bookmark-add",
        title: "TEST 外部提交的收藏",
        url: "https://example.test/notification-bookmark",
      },
    },
    fixture.options,
  );
  await expect(dialog).toContainText("TEST 外部提交的收藏");
  expect(fixture.requests).toHaveLength(0);
});

test("Objects已打开批注栏消费真实外部提交，当前未发送草稿保留", async ({
  page,
}) => {
  const spaces = (await fixture.client.call(
    "spaces.ensure",
    undefined,
    fixture.options,
  )) as { deskId: string };
  const title = "TEST 通知批注原件";
  const created = (await fixture.client.call(
    "documents.create",
    {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: spaces.deskId,
      title,
      markdown: "真实批注原文。",
    },
    fixture.options,
  )) as { contentId: string };
  await page.goto(fixture.origin);
  await openLibrary(page);
  await page.getByLabel(`打开内容：${title}`, { exact: true }).click();
  await page.getByRole("button", { name: "展开批注栏", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "对象批注",
    exact: true,
  });
  await expect(panel).toContainText("暂无批注");
  const input = await openInput(page);
  const draft = "TEST 未发送内容，不因批注通知丢失";
  await input.fill(draft);
  await fixture.client.call(
    "objects.annotate",
    {
      commandId: randomUUID(),
      contentId: created.contentId,
      revision: 1,
      quote: "真实批注原文",
      body: "TEST 外部提交的对象批注",
    },
    fixture.options,
  );
  await expect(panel).toContainText("TEST 外部提交的对象批注");
  await expect(input).toHaveValue(draft);
  expect(fixture.requests).toHaveLength(0);
});

test("前台恢复校验独立Profile；丢失一次真实SSE变化提示也不留旧资料", async ({
  page,
}) => {
  // Deliberately lose only a real notification event. The native EventSource
  // still connects, authenticates, receives bytes and closes normally; all
  // Profile reads and mutations retain the actual Runtime and Host transports.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    Reflect.set(window, "dropWorkspaceHints", false);
    Reflect.set(window, "droppedWorkspaceHints", 0);
    Reflect.set(window, "forwardedWorkspaceResync", false);
    window.EventSource = new Proxy(NativeEventSource, {
      construct(target, args, newTarget) {
        const stream = Reflect.construct(
          target,
          args,
          newTarget,
        ) as EventSource;
        if (
          new URL(String(args[0]), window.location.href).pathname ===
          "/api/platform/workspace/stream"
        ) {
          // Register before the application assigns onmessage. A lost change
          // must not reach either onmessage or a later message listener.
          stream.addEventListener("message", (event) => {
            const hint = JSON.parse(event.data);
            if (hint.reason === "resync")
              Reflect.set(window, "forwardedWorkspaceResync", true);
            if (
              Reflect.get(window, "dropWorkspaceHints") &&
              hint.reason === "changed"
            ) {
              Reflect.set(
                window,
                "droppedWorkspaceHints",
                Number(Reflect.get(window, "droppedWorkspaceHints")) + 1,
              );
              event.stopImmediatePropagation();
            }
          });
        }
        return stream;
      },
    });
  });
  const name = await editor(page);
  await page.waitForFunction(() =>
    Reflect.get(window, "forwardedWorkspaceResync"),
  );
  // Complete an actual initial foreground read before suppressing changes;
  // the baseline must not race an initial resync's deferred read.
  const readyRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/profile" &&
      response.request().method() === "GET" &&
      response.ok(),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await (await readyRead).finished();
  const initialName = await name.textContent();
  await page.evaluate(() => Reflect.set(window, "dropWorkspaceHints", true));
  const head = (await fixture.read()).agent;
  await fixture.update({
    subject: "agent",
    commandId: randomUUID(),
    expectedRevision: head.revision,
    enabled: true,
    data: { ...head.data, name: "TEST 前台恢复后的最新资料" },
  });
  await expect
    .poll(() =>
      page.evaluate(() => Number(Reflect.get(window, "droppedWorkspaceHints"))),
    )
    .toBeGreaterThan(0);
  await expect(name).toHaveText(initialName!);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(name).toHaveText("TEST 前台恢复后的最新资料");
  expect(fixture.requests).toHaveLength(0);
});
