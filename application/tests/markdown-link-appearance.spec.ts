import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openSettings } from "./settings-helpers.js";

const consumers = ["对话回复", "文档正文"] as const;
type Consumer = (typeof consumers)[number];
const appearances = ["亮色", "暗色"] as const;
const accents = ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"] as const;
const externalURL = "https://example.org/morphz?topic=%E4%B8%AD%E6%96%87";
const longLabel =
  "这是一段需要在狭窄窗口和放大显示时自然换行的中文链接文字，阅读产品设计与实现记录时不应撑宽正文，也不应让键盘焦点改变段落高度。".repeat(
    3,
  );

function markdown(targetId: string) {
  return [
    `常规链接：[产品说明](${externalURL})，以及 [本地资料](artifact:${targetId})。`,
    `[${longLabel}](https://example.org/long)`,
    "[HTTP 兼容链接](http://example.org/plain)",
    "[危险协议](javascript:alert%281%29) [不允许的凭据链接](https://test:fixture@example.org/private) [数据协议](data:text/html,test)",
    "![外部图片](https://example.org/markdown-image.png)",
    '<a href="https://example.org/raw">原始 HTML 链接</a>',
  ].join("\n\n");
}

/** Only presentation is synthetic. Documents and object opening use the actual
 * Platform client/Host; neither consumer is mounted by a test-only component. */
async function prepare(page: Page, consumer: Consumer) {
  let text = "";
  const presentation = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      model: "markdown-appearance-fixture",
      deliveries: [],
      messages: [
        {
          id: "markdown-appearance-reply",
          ...presentation.scope,
          inputId: null,
          rootId: null,
          artifactId: null,
          kind: "reply" as const,
          createdAt: "2026-10-02T00:00:00Z",
          text,
        },
      ],
    },
  }));
  const target = (await presentation.client.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: presentation.spaces.deskId,
    title: `TEST 链接目标 ${randomUUID()}`,
    markdown: "TEST 引用对象原文，打开链接不发送模型请求。",
  })) as { contentId: string };
  const source = markdown(target.contentId);
  const document = (await presentation.client.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: presentation.spaces.deskId,
    title: `TEST Markdown 链接 ${randomUUID()}`,
    markdown: source,
  })) as { contentId: string };
  text = `${source}\n\n[打开测试文档](artifact:${document.contentId})`;
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const reply = page.locator(
    '[data-message-id="markdown-appearance-reply"] .reply-content',
  );
  await expect(reply.getByRole("link", { name: "产品说明" })).toBeVisible();
  if (consumer === "文档正文") {
    await reply
      .getByRole("button", { name: "打开测试文档", exact: true })
      .click();
    await expect(page.locator(".object-paper .document-body")).toBeVisible();
  }
  return {
    root:
      consumer === "对话回复"
        ? reply
        : page.locator(".object-paper .document-body"),
    presentation,
  };
}

async function chooseAppearance(
  page: Page,
  appearance: (typeof appearances)[number],
  accent: (typeof accents)[number],
) {
  const settings = await openSettings(page, "外观");
  await settings.getByRole("button", { name: appearance, exact: true }).click();
  await settings.getByRole("button", { name: accent, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
}

async function appearanceOf(link: Locator) {
  return link.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#010203";
      context.fillStyle = color;
      if (context.fillStyle === "#010203")
        throw new Error(`Canvas 无法解析测试颜色：${color}`);
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const tokenColor = (name: string) => {
      // Canvas does not resolve light-dark() using the consumer's color scheme.
      // A textless, out-of-flow probe resolves only its inherited CSS token; all
      // appearance/geometry assertions still inspect the actual Markdown link.
      const probe = document.createElement("span");
      probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;color:var(${name})`;
      element.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return rgba(resolved);
    };
    const ink = rgba(style.color);
    const token = tokenColor("--markdown-link-color");
    const strong = tokenColor("--accent-strong");
    const decoration = rgba(style.textDecorationColor);
    // Composite actual transparent ancestors rather than treating them as black.
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
    const background = [...context.getImageData(0, 0, 1, 1).data];
    const luminance = (values: number[]) => {
      const channels = values.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return (
        channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
      );
    };
    const foregroundLight = luminance(ink);
    const backgroundLight = luminance(background);
    const rect = element.getBoundingClientRect();
    return {
      ink,
      token,
      strong,
      decoration,
      background,
      contrast:
        (Math.max(foregroundLight, backgroundLight) + 0.05) /
        (Math.min(foregroundLight, backgroundLight) + 0.05),
      underline: style.textDecorationLine,
      thickness: style.textDecorationThickness,
      offset: style.textUnderlineOffset,
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      focusVisible: element.matches(":focus-visible"),
      hovered: element.matches(":hover"),
      active: element.matches(":active"),
      weight: style.fontWeight,
      width: rect.width,
      height: rect.height,
    };
  });
}

function assertReadable(state: Awaited<ReturnType<typeof appearanceOf>>) {
  expect(state.contrast).toBeGreaterThanOrEqual(4.5);
  expect(state.ink.slice(0, 3)).not.toEqual([0, 0, 255]);
  expect(state.underline).toContain("underline");
  expect(state.thickness).toBe("1px");
  expect(state.offset).toBe("3px");
}

async function keyboardFocus(page: Page, link: Locator) {
  // Return through native sequential Tab navigation, not a forced CSS class.
  await link.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  expect(
    await link.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
}

async function settleColor(link: Locator, token: "token" | "strong") {
  // Object links inherit the existing button color transition. Wait for its
  // actual computed endpoint rather than sampling the first animation frame.
  await expect
    .poll(async () => {
      const state = await appearanceOf(link);
      return state.ink.join(",") === state[token].join(",");
    })
    .toBe(true);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

for (const consumer of consumers) {
  test(`${consumer}：四强调色亮暗链接可读，悬停与键盘焦点不改变布局`, async ({
    page,
  }, info) => {
    const { root } = await prepare(page, consumer);
    const links = [
      root.getByRole("link", { name: "产品说明", exact: true }),
      root.getByRole("button", { name: "本地资料", exact: true }),
    ];
    const observations = [];
    const palette = new Set<string>();
    for (const appearance of appearances) {
      for (const accent of accents) {
        await chooseAppearance(page, appearance, accent);
        const normalColors = [];
        for (const link of links) {
          await link.evaluate((element) => (element as HTMLElement).blur());
          await page.mouse.move(0, 0);
          await settleColor(link, "token");
          const normal = await appearanceOf(link);
          assertReadable(normal);
          expect(normal.ink).toEqual(normal.token);
          expect(normal.decoration[3]).toBeGreaterThanOrEqual(139);
          expect(normal.decoration[3]).toBeLessThanOrEqual(141);
          normalColors.push(normal.ink);

          await link.hover();
          await settleColor(link, "strong");
          const hovered = await appearanceOf(link);
          expect(hovered.hovered).toBe(true);
          assertReadable(hovered);
          expect(hovered.ink).toEqual(hovered.strong);
          expect(hovered.decoration).toEqual(hovered.ink);
          expect([hovered.width, hovered.height, hovered.weight]).toEqual([
            normal.width,
            normal.height,
            normal.weight,
          ]);

          await keyboardFocus(page, link);
          await page.mouse.move(0, 0);
          const focused = await appearanceOf(link);
          assertReadable(focused);
          expect(focused.ink).toEqual(focused.strong);
          expect(focused.decoration).toEqual(focused.ink);
          expect(focused.outline).toBe("solid");
          expect(focused.outlineWidth).toBe("1px");
          expect(focused.outlineOffset).toBe("3px");
          expect([focused.width, focused.height, focused.weight]).toEqual([
            normal.width,
            normal.height,
            normal.weight,
          ]);

          await link.hover();
          await page.mouse.down();
          const active = await appearanceOf(link);
          expect(active.active).toBe(true);
          assertReadable(active);
          expect(active.ink).toEqual(active.strong);
          expect([active.width, active.height, active.weight]).toEqual([
            normal.width,
            normal.height,
            normal.weight,
          ]);
          // Release outside: inspect the pressed state without opening a site
          // or navigating the object away from this theme-matrix consumer.
          await page.mouse.move(0, 0);
          await page.mouse.up();
          observations.push({
            consumer,
            appearance,
            accent,
            normal,
            hovered,
            focused,
            active,
          });
        }
        expect(normalColors[0]).toEqual(normalColors[1]);
        palette.add(normalColors[0]!.join(","));
        await root.screenshot({
          path: info.outputPath(`${appearance}-${accent}.png`),
        });
      }
    }
    expect(palette.size).toBe(8);
    await info.attach("markdown-link-contrast-and-states", {
      body: JSON.stringify(observations, null, 2),
      contentType: "application/json",
    });
  });

  test(`${consumer}：390px 与 CSS 200% 长中文链接换行，焦点不撑宽正文`, async ({
    page,
  }, info) => {
    const { root } = await prepare(page, consumer);
    const link = root.getByRole("link", { name: longLabel, exact: true });
    for (const [width, zoom] of [
      [390, 1],
      [1440, 2],
    ] as const) {
      await page.setViewportSize({ width, height: 960 });
      // CSS zoom is a layout regression, not native Electron zoom acceptance.
      await page.evaluate((scale) => {
        document.documentElement.style.zoom = String(scale);
      }, zoom);
      await link.scrollIntoViewIfNeeded();
      const geometry = await link.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rows = new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.top)),
        );
        const root = element.closest(".reply-content, .document-body")!;
        const bounds = root.getBoundingClientRect();
        return {
          rows: rows.size,
          rootOverflow: root.scrollWidth - root.clientWidth,
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          left: bounds.left,
          right: bounds.right,
          viewport: innerWidth,
          height: bounds.height,
        };
      });
      expect(geometry.rows).toBeGreaterThan(1);
      expect(geometry.rootOverflow).toBeLessThanOrEqual(1);
      expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
      expect(geometry.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
      await keyboardFocus(page, link);
      const focused = await appearanceOf(link);
      expect(focused.outlineWidth).toBe("1px");
      expect(
        await root.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      ).toBe(geometry.height);
      await page.screenshot({
        path: info.outputPath(`${width}px-css-${zoom * 100}percent.png`),
      });
    }
  });

  test(`${consumer}：真实 Markdown 保留安全 URL、对象入口及桌面外部打开`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const opened: string[] = [];
      (window as any).__markdownExternal = opened;
      (window as any).morphzDesktop = {
        openExternal: async (url: string) => {
          opened.push(url);
        },
      };
    });
    const { root } = await prepare(page, consumer);
    const link = root.getByRole("link", { name: "产品说明", exact: true });
    await expect(link).toHaveClass("markdown-link");
    await expect(link).toHaveAttribute("href", externalURL);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(
      root.getByRole("link", { name: "HTTP 兼容链接" }),
    ).toHaveAttribute("href", "http://example.org/plain");
    for (const name of ["危险协议", "不允许的凭据链接", "数据协议"]) {
      await expect(root.getByRole("link", { name, exact: true })).toHaveCount(
        0,
      );
      await expect(
        root
          .locator('span[title="不支持的链接地址"]')
          .getByText(name, { exact: true }),
      ).toBeVisible();
    }
    await expect(root.locator('a[href="https://example.org/raw"]')).toHaveCount(
      0,
    );
    await expect(root.locator("img")).toHaveCount(0);
    await expect(
      root.getByRole("link", { name: "查看外部图片：外部图片" }),
    ).toHaveAttribute("href", "https://example.org/markdown-image.png");
    const beforeURL = page.url();
    await link.hover();
    await page.mouse.down();
    const active = await appearanceOf(link);
    expect(active.active).toBe(true);
    assertReadable(active);
    expect(active.ink).toEqual(active.strong);
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => (window as any).__markdownExternal))
      .toEqual([externalURL]);
    expect(page.url()).toBe(beforeURL);
    expect(page.context().pages()).toHaveLength(1);
    await page.evaluate(() => {
      window.morphzDesktop!.openExternal = async () => {
        throw new Error("TEST 系统浏览器拒绝打开");
      };
    });
    await link.click();
    await expect(root.getByRole("alert")).toHaveText("TEST 系统浏览器拒绝打开");
    const objectLink = root.getByRole("button", {
      name: "本地资料",
      exact: true,
    });
    await expect(objectLink).toHaveClass("inline-object-link");
    await expect(
      root.getByRole("link", { name: "本地资料", exact: true }),
    ).toHaveCount(0);
    await objectLink.click();
    await expect(page.locator(".object-paper .document-body")).toHaveText(
      "TEST 引用对象原文，打开链接不发送模型请求。",
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).__markdownExternal))
      .toEqual([externalURL]);
  });
}
