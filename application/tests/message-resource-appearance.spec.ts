import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput, settleTransitions } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

async function prepare(
  page: Page,
  title = "TEST 一碗面换一间铺｜原创短篇小说",
) {
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      messages: [],
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "completed" as const,
        error: null,
        retryable: false,
      })),
    },
  }));
  const objectId = randomUUID();
  await fixture.client.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId: fixture.spaces.deskId,
    title,
    markdown: "TEST 原件 v1，点击关联资源不能创建内容或发送消息。",
  });
  const content = await fixture.client.resolveContent({
    appId: "morphz.objects",
    appObjectId: objectId,
  });
  for (let revision = 1; revision < 3; revision++)
    await fixture.client.reviseDocument({
      commandId: randomUUID(),
      contentId: content.id,
      expectedRevision: revision,
      edits: [{ old_text: `v${revision}`, new_text: `v${revision + 1}` }],
    });
  const sent = fixture.input(
    "resource-presentation",
    "那你什么时候算练好？我什么时候可以让你继续写？",
    "2026-10-11T00:25:00.000Z",
  );
  sent.artifactId = content.id;
  sent.artifactRevision = 3;
  inputs.push(sent);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const message = page.locator(`.human-message[data-input-id="${sent.id}"]`);
  const resource = message.locator(".message-object-link");
  await expect(resource).toContainText(title);
  await page.mouse.move(0, 0);
  await settleTransitions(page);
  return { resource, message, title, fixture, sent };
}

async function metrics(resource: Locator) {
  return resource.evaluate((element) => {
    const style = getComputedStyle(element);
    const title = element.querySelector(".message-resource-title");
    const body = element
      .closest(".human-message")!
      .querySelector(":scope > p")!;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const ancestors = [];
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    )
      ancestors.push(current);
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    for (const ancestor of ancestors.reverse()) {
      context.fillStyle = getComputedStyle(ancestor).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const surface = [...context.getImageData(0, 0, 1, 1).data];
    const luminance = (rgb: number[]) => {
      const channels = rgb.slice(0, 3).map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return (
        channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
      );
    };
    const contrast = (color: string) => {
      const a = luminance(rgba(color)),
        b = luminance(surface);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const rect = element.getBoundingClientRect(),
      bodyStyle = getComputedStyle(body);
    return {
      width: rect.width,
      height: rect.height,
      font: Number.parseFloat(style.fontSize),
      bodyFont: Number.parseFloat(bodyStyle.fontSize),
      ink: style.color,
      background: rgba(style.backgroundColor),
      contrast: contrast(style.color),
      bodyContrast: contrast(bodyStyle.color),
      outline: style.outlineStyle,
      shadow: style.boxShadow,
      border: style.borderLeftWidth,
      titleDecoration: title
        ? getComputedStyle(title).textDecorationLine
        : null,
      focusVisible: element.matches(":focus-visible"),
      hovered: element.matches(":hover"),
      active: element.matches(":active"),
    };
  });
}

test("关联资源不是选文：类型图标、次级标题与版本同行，四主题亮暗交互不盖过正文", async ({
  page,
}, info) => {
  const { resource, message, title } = await prepare(page);
  const observations = [];
  for (const appearance of ["亮色", "暗色"])
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await settings.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      await resource.evaluate((element) => (element as HTMLElement).blur());
      await page.mouse.move(0, 0);
      await settleTransitions(page);
      await message.screenshot({
        path: info.outputPath(`resource-${appearance}-${accent}-normal.png`),
      });
      await expect(resource).toHaveAccessibleName(
        `打开关联资源：${title} · v3`,
      );
      await expect(
        resource.locator(".message-resource-icon svg.lucide-file-text"),
      ).toHaveCount(1);
      await expect(resource.locator(".message-resource-version")).toHaveText(
        "v3",
      );
      await expect(message.locator("blockquote,.sent-text-quotes")).toHaveCount(
        0,
      );
      const normal = await metrics(resource);
      expect(normal.background[3]).toBe(0);
      expect(normal.border).toBe("0px");
      expect(normal.shadow).toBe("none");
      expect(normal.font).toBeLessThan(normal.bodyFont);
      expect(normal.contrast).toBeGreaterThanOrEqual(4.5);
      expect(normal.contrast).toBeLessThan(normal.bodyContrast);
      await resource.hover();
      await settleTransitions(page);
      const hovered = await metrics(resource);
      expect(hovered.hovered).toBe(true);
      expect(hovered.contrast).toBeGreaterThanOrEqual(4.5);
      await message.screenshot({
        path: info.outputPath(`resource-${appearance}-${accent}-hover.png`),
      });
      await resource.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(resource).toBeFocused();
      await page.mouse.move(0, 0);
      await settleTransitions(page);
      const focused = await metrics(resource);
      expect(focused.focusVisible).toBe(true);
      expect(focused.outline).toBe("none");
      expect(focused.titleDecoration).toContain("underline");
      expect(focused.contrast).toBeGreaterThanOrEqual(4.5);
      await message.screenshot({
        path: info.outputPath(`resource-${appearance}-${accent}-focus.png`),
      });
      await resource.hover();
      await page.mouse.down();
      await settleTransitions(page);
      const pressed = await metrics(resource);
      expect(pressed.active).toBe(true);
      expect(pressed.contrast).toBeGreaterThanOrEqual(4.5);
      for (const state of [hovered, focused, pressed])
        expect([state.width, state.height]).toEqual([
          normal.width,
          normal.height,
        ]);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      observations.push({
        appearance,
        accent,
        normal,
        hovered,
        focused,
        pressed,
      });
    }
  await info.attach("resource-hierarchy-and-focus.json", {
    contentType: "application/json",
    body: JSON.stringify(observations, null, 2),
  });
});

test("长资源标题在窄窗200%下省略而保留类型与版本，点击仍打开确切v3且不发消息", async ({
  page,
}, info) => {
  const { resource, title, message } = await prepare(
    page,
    "TEST 关联小说原件的长标题".repeat(8),
  );
  await page.setViewportSize({ width: 650, height: 900 });
  await page.locator(".app").evaluate((element) => {
    (element as HTMLElement).style.zoom = "2";
  });
  await openInput(page);
  await resource.scrollIntoViewIfNeeded();
  await expect(resource.locator(".message-resource-icon")).toBeVisible();
  await expect(resource.locator(".message-resource-version")).toBeVisible();
  expect(
    await resource.locator(".message-resource-title").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        ellipsis: style.textOverflow,
        truncated: element.scrollWidth > element.clientWidth,
      };
    }),
  ).toEqual({ ellipsis: "ellipsis", truncated: true });
  expect(
    await message.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("resource-narrow-200.png") });
  const sends: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/platform/messages")
    )
      sends.push(request.url());
  });
  await resource.click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  await expect(page.locator(".object-paper")).toContainText("TEST 原件 v3");
  expect(sends).toEqual([]);
});

test("强制颜色模式保留系统焦点轮廓，Enter仍打开资源原版本", async ({
  page,
}, info) => {
  const { resource, message, title } = await prepare(page);
  await page.emulateMedia({ forcedColors: "active" });
  await resource.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(resource).toBeFocused();
  await expect(resource).toHaveCSS("outline-style", "solid");
  await expect(resource).toHaveCSS("outline-width", "2px");
  await message.screenshot({
    path: info.outputPath("resource-forced-colors-focus.png"),
  });
  const sends: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/platform/messages")
    )
      sends.push(request.url());
  });
  await page.keyboard.press("Enter");
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
  await expect(page.locator(".object-paper")).toContainText("TEST 原件 v3");
  expect(sends).toEqual([]);
});
