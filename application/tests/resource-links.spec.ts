import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";

async function prepare(page: Page) {
  let text = "";
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      deliveries: [],
      messages: [
        {
          id: "TEST-old-resource-message",
          ...fixture.scope,
          inputId: null,
          rootId: null,
          artifactId: null,
          kind: "reply" as const,
          createdAt: "2026-09-01T00:00:00Z",
          text,
        },
      ],
    },
  }));
  const target = (await fixture.client.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: fixture.spaces.deskId,
    title: `TEST 资源目标 ${randomUUID()}`,
    markdown: "TEST 原始第一版",
  })) as { contentId: string };
  await fixture.client.reviseDocument({
    commandId: randomUUID(),
    contentId: target.contentId,
    expectedRevision: 1,
    title: "TEST 资源目标第二版",
    markdown: "TEST 当前第二版",
  });
  text = [
    `旧消息原 ID：${target.contentId}。`,
    `代码形式：\`${target.contentId}\`。`,
    `[确切第一版](morphz://content/${target.contentId}?revision=1)`,
    `[不可用内容](morphz://content/content_0000000000000000000000000000000000000000)`,
    "[本机测试文件](</tmp/TEST 资源 中文.md>) 与 `/tmp/TEST 100% #?.txt`。",
    "[不存在文件](file:///tmp/TEST-missing-resource.txt)",
  ].join("\n\n");
  let inputs = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/inputs(?:\?|$)/.test(request.url()))
      inputs++;
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const root = page.locator(
    '[data-message-id="TEST-old-resource-message"] .reply-content',
  );
  await expect(root).toBeVisible();
  return { fixture, target, root, inputs: () => inputs, text };
}

test("old message raw/inline IDs resolve authorized current content; exact revision is not silently replaced", async ({
  page,
}) => {
  const { target, root, inputs, text } = await prepare(page);
  const sourceURL = page.url();
  const original = await root.innerText();
  const id = root.getByRole("button", { name: target.contentId, exact: true });
  await expect(id).toHaveCount(2);
  await id.first().click();
  await expect(page.locator(".object-paper .document-body")).toHaveText(
    "TEST 当前第二版",
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await root.getByRole("button", { name: "确切第一版", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".object-paper .document-body")).toHaveText(
    "TEST 原始第一版",
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await root.getByRole("button", { name: "不可用内容", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /无法读取|不存在|不可用|无权/ })
      .first(),
  ).toBeVisible();
  expect(await root.innerText()).toBe(original);
  expect(text).toContain(target.contentId);
  expect(page.url()).toBe(sourceURL);
  expect(inputs()).toBe(0);
});

test("native path bridge is click-only, decodes once, reports errors, and preserves the composer and page", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Reflect.set(window, "resourceFileCalls", calls);
    window.morphzDesktop = {
      openLocalFile: async (path: string) => {
        calls.push(path);
        if (path.includes("missing"))
          throw new Error(
            "Error invoking remote method 'open-local-file': Error: TEST 文件不存在或已移动，请核对路径后重试。",
          );
        return { action: "opened" };
      },
    } as typeof window.morphzDesktop;
  });
  const { root, inputs } = await prepare(page);
  // Use the actual shared composer, not a test-only input.
  const input = page.locator("textarea").filter({ visible: true }).last();
  await input.fill("TEST 未发送草稿必须保持");
  expect(
    await page.evaluate(() => Reflect.get(window, "resourceFileCalls")),
  ).toEqual([]);
  await root.getByRole("button", { name: "本机测试文件", exact: true }).click();
  await root
    .getByRole("button", { name: "/tmp/TEST 100% #?.txt", exact: true })
    .click();
  expect(
    await page.evaluate(() => Reflect.get(window, "resourceFileCalls")),
  ).toEqual(["/tmp/TEST 资源 中文.md", "/tmp/TEST 100% #?.txt"]);
  await root.getByRole("button", { name: "不存在文件", exact: true }).click();
  await expect(root.getByRole("alert")).toContainText("文件不存在或已移动");
  await expect(root.getByRole("alert")).not.toContainText("remote method");
  await expect(input).toHaveValue("TEST 未发送草稿必须保持");
  expect(inputs()).toBe(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await root
      .getByRole("button", { name: "本机测试文件", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await root.evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath(`resource-links-${width}.png`),
    });
  }
});
