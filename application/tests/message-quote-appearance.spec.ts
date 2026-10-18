import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

const quoteText =
  "先核对真实来源，再决定下一步；长中文引用应留在主题色气泡里，悬停和键盘焦点只加强同一主题，不改变引用卡片的尺寸。".repeat(
    3,
  );
const sourceText = `第一处：${quoteText}\n\n第二处：${quoteText}`;
const sourceStart = sourceText.lastIndexOf(quoteText);

async function prepare(page: Page, linkedDocument = false) {
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
  const original = fixture.input(
    "quote-appearance-source",
    sourceText,
    "2026-10-02T00:00:00.000Z",
  );
  const sent = fixture.input(
    "quote-appearance-sent",
    "TEST 请围绕引用讨论，不修改来源。",
    "2026-10-02T00:00:01.000Z",
  );
  sent.textQuotes = [
    {
      id: randomUUID(),
      text: quoteText,
      comment: "TEST 引用评论保持原样。",
      source: {
        kind: "message",
        ...fixture.scope,
        messageId: original.id,
        inputId: original.id,
        title: "我",
        createdAt: original.createdAt,
      },
      anchor: {
        start: sourceStart,
        end: sourceStart + quoteText.length,
        prefix: "第二处：",
        suffix: "",
      },
    },
  ];
  if (linkedDocument) {
    const objectId = randomUUID();
    await fixture.client.createDocument({
      commandId: randomUUID(),
      objectId,
      projectId: fixture.spaces.deskId,
      title: "TEST 关联文档引用的悬停底色",
      markdown: sourceText,
    });
    const document = await fixture.client.resolveContent({
      appId: "morphz.objects",
      appObjectId: objectId,
    });
    sent.artifactId = document.id;
    sent.artifactRevision = 1;
    sent.textQuotes[0]!.source = {
      kind: "artifact",
      projectId: fixture.spaces.deskId,
      artifactId: document.id,
      revision: 1,
      title: document.title,
    };
  }
  inputs.push(original, sent);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const message = page.locator(`.human-message[data-input-id="${sent.id}"]`);
  const quote = message.getByRole("button", {
    name: "查看引用 1 的原文",
    exact: true,
  });
  await expect(quote).toContainText(quoteText);
  return {
    quote,
    message,
    source: page.locator(`.human-message[data-input-id="${original.id}"]`),
  };
}

async function colors(quote: Locator) {
  return quote.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#010203";
      context.fillStyle = color;
      if (context.fillStyle === "#010203")
        throw new Error(`Invalid test color: ${color}`);
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const token = (name: string) => {
      // Resolve light-dark() in the real consumer's inherited color scheme.
      // This textless measurement probe is out of flow and immediately removed.
      const probe = document.createElement("span");
      probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;color:var(${name})`;
      element.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return rgba(value);
    };
    const background = rgba(style.backgroundColor);
    const hover = token("--human-message-hover");
    const pressed = token("--human-message-pressed");
    const neutral = token("--hover");
    const tint = token("--tint");
    const body = rgba(
      getComputedStyle(element.querySelector("span > span")!).color,
    );
    const settledBody = token("--sent-quote-ink");
    const small = rgba(getComputedStyle(element.querySelector("small")!).color);
    const ancestors: Element[] = [];
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    )
      ancestors.push(current);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    for (const ancestor of ancestors.reverse()) {
      context.fillStyle = getComputedStyle(ancestor).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const surface = [...context.getImageData(0, 0, 1, 1).data];
    const luminance = (rgb: number[]) => {
      const values = rgb.slice(0, 3).map((v) => {
        const channel = v / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    };
    const contrast = (ink: number[]) => {
      const a = luminance(ink),
        b = luminance(surface);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const rect = element.getBoundingClientRect();
    const message = element.closest(".human-message")!;
    const messageBody = message.querySelector(":scope > p")!;
    const comment = message.querySelector(".text-quote-comment")!;
    return {
      background,
      hover,
      pressed,
      neutral,
      tint,
      surface,
      body,
      settledBody,
      bodyContrast: contrast(body),
      smallContrast: contrast(small),
      messageContrast: contrast(rgba(getComputedStyle(messageBody).color)),
      quoteSize: Number.parseFloat(style.fontSize),
      commentSize: Number.parseFloat(getComputedStyle(comment).fontSize),
      messageSize: Number.parseFloat(getComputedStyle(messageBody).fontSize),
      width: rect.width,
      height: rect.height,
      weight: style.fontWeight,
      border: style.borderLeftWidth,
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      focusVisible: element.matches(":focus-visible"),
      hovered: element.matches(":hover"),
      active: element.matches(":active"),
    };
  });
}

async function settled(
  quote: Locator,
  token: "transparent" | "hover" | "pressed",
) {
  await expect
    .poll(async () => {
      const state = await colors(quote);
      return token === "transparent"
        ? state.background[3] === 0 &&
            state.body.join(",") === state.settledBody.join(",")
        : state.background.join(",") === state[token].join(",") &&
            state.body.join(",") === state.settledBody.join(",");
    })
    .toBe(true);
  return colors(quote);
}

function assertState(
  state: Awaited<ReturnType<typeof colors>>,
  normal?: Awaited<ReturnType<typeof colors>>,
) {
  expect(state.bodyContrast).toBeGreaterThanOrEqual(4.5);
  expect(state.smallContrast).toBeGreaterThanOrEqual(4.5);
  if (normal)
    expect([state.width, state.height, state.weight, state.border]).toEqual([
      normal.width,
      normal.height,
      normal.weight,
      normal.border,
    ]);
}

async function tabFocus(page: Page, quote: Locator) {
  await quote.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(quote).toBeFocused();
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("引用是正文的次级内容：亮暗无常驻高亮、字号与对比低于评论和正文", async ({
  page,
}, info) => {
  const { quote } = await prepare(page);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.mouse.move(0, 0);
    const normal = await settled(quote, "transparent");
    await info.attach(`quote-hierarchy-${theme}-metrics.json`, {
      contentType: "application/json",
      body: JSON.stringify(normal, null, 2),
    });
    expect(normal.background[3]).toBe(0);
    expect(normal.quoteSize).toBeLessThan(normal.commentSize);
    expect(normal.quoteSize).toBeLessThan(normal.messageSize);
    expect(normal.bodyContrast).toBeLessThan(normal.messageContrast);
    expect(normal.smallContrast).toBeLessThan(normal.messageContrast);
    assertState(normal);
    await page.screenshot({
      path: info.outputPath(`quote-hierarchy-${theme}.png`),
    });
  }
});

test("本人消息引用：四强调色亮暗正常、悬停、Tab与按下沿主题且文字可读", async ({
  page,
}, info) => {
  const { quote, message } = await prepare(page);
  const observations = [];
  for (const appearance of ["亮色", "暗色"]) {
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await settings.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      await quote.evaluate((element) => (element as HTMLElement).blur());
      await page.mouse.move(0, 0);
      const normal = await settled(quote, "transparent");
      await info.attach(`${appearance}-${accent}-normal-metrics.json`, {
        contentType: "application/json",
        body: JSON.stringify(normal, null, 2),
      });
      assertState(normal);
      await quote.hover();
      const hovered = await settled(quote, "hover");
      assertState(hovered, normal);
      expect(hovered.hovered).toBe(true);
      expect(hovered.background).not.toEqual(normal.background);
      expect(hovered.background).not.toEqual(hovered.neutral);
      await message.screenshot({
        path: info.outputPath(`${appearance}-${accent}-hover.png`),
      });
      await tabFocus(page, quote);
      await page.mouse.move(0, 0);
      const focused = await settled(quote, "hover");
      assertState(focused, normal);
      expect(focused.focusVisible).toBe(true);
      expect(focused.outline).toBe("solid");
      expect(parseFloat(focused.outlineWidth)).toBeGreaterThan(0);
      await quote.hover();
      await page.mouse.down();
      const active = await settled(quote, "pressed");
      assertState(active, normal);
      expect(active.active).toBe(true);
      expect(active.background).not.toEqual(active.neutral);
      await message.screenshot({
        path: info.outputPath(`${appearance}-${accent}-pressed.png`),
      });
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await quote.evaluate((element) => (element as HTMLElement).blur());
      await settled(quote, "transparent");
      observations.push({
        appearance,
        accent,
        normal,
        hovered,
        focused,
        active,
      });
      await message.screenshot({
        path: info.outputPath(`${appearance}-${accent}.png`),
      });
    }
  }
  await info.attach("message-quote-color-and-contrast", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
});

test("本人消息的关联文档引用条：悬停、Tab与按下不套用中性白底", async ({
  page,
}, info) => {
  const { quote, message } = await prepare(page, true);
  const reference = message.locator(".message-object-link");
  await expect(reference).toContainText("TEST 关联文档引用的悬停底色");
  const state = () =>
    reference.evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const rect = element.getBoundingClientRect();
      return {
        background: [...context.getImageData(0, 0, 1, 1).data],
        width: rect.width,
        height: rect.height,
        hovered: element.matches(":hover"),
        focused: element.matches(":focus-visible"),
        active: element.matches(":active"),
      };
    });
  const observations = [];
  for (const appearance of ["亮色", "暗色"]) {
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await settings.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      await reference.evaluate((element) => (element as HTMLElement).blur());
      await page.mouse.move(0, 0);
      const normal = await state();
      const tokens = await colors(quote);
      expect(normal.background[3]).toBeGreaterThan(0);
      expect(normal.background[3]).toBeLessThanOrEqual(13);
      await reference.hover();
      // Save the actual pre-assertion appearance too, so a regression retains
      // its white surface rather than only reporting a token mismatch.
      await message.screenshot({
        path: info.outputPath(`document-${appearance}-${accent}-hover.png`),
      });
      await expect
        .poll(async () => (await state()).background)
        .toEqual(tokens.hover);
      const hovered = await state();
      expect(hovered.hovered).toBe(true);
      expect(hovered.background).not.toEqual(tokens.neutral);
      // The preceding quote opens a focusable full-text popover. Close it
      // explicitly, then use the real next Tab stop instead of assuming a
      // Shift+Tab round trip leaves that popover out of the focus order.
      await quote.focus();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      await expect(reference).toBeFocused();
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => (await state()).background)
        .toEqual(tokens.hover);
      const focused = await state();
      expect(focused.focused).toBe(true);
      await reference.hover();
      await page.mouse.down();
      await expect
        .poll(async () => (await state()).background)
        .toEqual(tokens.pressed);
      const pressed = await state();
      expect(pressed.active).toBe(true);
      for (const interactive of [hovered, focused, pressed])
        expect([interactive.width, interactive.height]).toEqual([
          normal.width,
          normal.height,
        ]);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await reference.evaluate((element) => (element as HTMLElement).blur());
      observations.push({
        appearance,
        accent,
        normal,
        hovered,
        focused,
        pressed,
      });
    }
  }
  await info.attach("document-reference-interaction-colors.json", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
});

test("引用卡片在390px与CSS200%不横溢，交互不改变几何", async ({
  page,
}, info) => {
  const { quote, message } = await prepare(page);
  for (const [width, zoom] of [
    [390, 1],
    [1440, 2],
  ] as const) {
    await page.setViewportSize({ width, height: 960 });
    // Layout regression only, not native Electron zoom acceptance.
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, zoom);
    await quote.scrollIntoViewIfNeeded();
    await quote.evaluate((element) => (element as HTMLElement).blur());
    await page.mouse.move(0, 0);
    const normal = await settled(quote, "transparent");
    const geometry = await quote.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewport: innerWidth,
        overflow: element.scrollWidth - element.clientWidth,
        pageOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    await quote.hover();
    assertState(await settled(quote, "hover"), normal);
    await tabFocus(page, quote);
    await page.mouse.move(0, 0);
    assertState(await settled(quote, "hover"), normal);
    await message.screenshot({
      path: info.outputPath(`${width}px-css-${zoom * 100}percent.png`),
    });
  }
});

test("引用准确回跳重复原文的第二处，未发送草稿与引用评论保留且不提交消息", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/messages(?:\?|$)/.test(request.url())
    )
      writes.push(request.url());
  });
  const { quote, message, source } = await prepare(page);
  const draft = "TEST 尚未发送的草稿，不应被引用回跳清除。";
  await page.getByLabel("AI 输入内容").fill(draft);
  await quote.click();
  await expect(source).toHaveAttribute("data-quote-revealed", "true");
  const selected = await page.evaluate(() => {
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0);
    return {
      text: selection.toString(),
      start: range.startOffset,
      message: range.startContainer.parentElement
        ?.closest(".human-message")
        ?.getAttribute("data-input-id"),
    };
  });
  expect(selected).toEqual({
    text: quoteText,
    start: sourceStart,
    message: "quote-appearance-source",
  });
  await openInput(page);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(draft);
  await expect(message.locator(".text-quote-comment")).toHaveText(
    "TEST 引用评论保持原样。",
  );
  await page.reload();
  await openInput(page);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(draft);
  await expect(quote).toContainText(quoteText);
  expect(writes).toEqual([]);
});
