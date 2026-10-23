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
    "**https://github.com/shafreeck/24frames**：public，默认分支 `main`，远端 HEAD。",
    `[${longLabel}](https://example.org/long)`,
    "[HTTP 兼容链接](http://example.org/plain)",
    "[危险协议](javascript:alert%281%29) [不允许的凭据链接](https://test:fixture@example.org/private) [数据协议](data:text/html,test)",
    "https://test:fixture@example.org/bare，普通说明。",
    "![外部图片](https://example.org/markdown-image.png)",
    '<a href="https://example.org/raw">原始 HTML 链接</a>',
  ].join("\n\n");
}

/** Only presentation is synthetic. Documents and object opening use the actual
 * Platform client/Host; neither consumer is mounted by a test-only component. */
async function prepare(page: Page, consumer: Consumer, content = markdown) {
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
  const source = content(target.contentId);
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
  await expect(reply).toBeVisible();
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
    const bare = root.getByRole("link", {
      name: "https://github.com/shafreeck/24frames",
      exact: true,
    });
    await expect(bare).toHaveAttribute(
      "href",
      "https://github.com/shafreeck/24frames",
    );
    await expect(bare.locator("..")).toHaveJSProperty("tagName", "STRONG");
    await expect(root).toContainText("：public，默认分支 main，远端 HEAD。");
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
    await expect(
      root.getByRole("link", {
        name: "https://test:fixture@example.org/bare",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      root
        .locator('span[title="不支持的链接地址"]')
        .getByText("https://test:fixture@example.org/bare", { exact: true }),
    ).toBeVisible();
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

for (const appearance of appearances) {
  test(`对话 Markdown 阅读层次、原文与局部溢出：${appearance}`, async ({
    page,
  }, info) => {
    const { root } = await prepare(page, "对话回复", () =>
      [
        "# 项目已经创建并推送",
        "已建好并推上去了。后续说明保留原文，只调整阅读层次。",
        "**https://github.com/shafreeck/24frames**：public，默认分支 `main`。",
        "## 许可怎么拆",
        "代码、设计与媒体素材分开说明，先看结论，再看依据。",
        "- 代码：沿用开源许可。\n- 图片：核对原始来源。\n  - 保留署名和使用条件。",
        "> 原始资料与推断必须分开。\n> 这条说明仍保留原来的换行。",
        "### 下一步",
        "| 对象 | 建议 | 验证方式 | 状态 | 备注 |\n| --- | --- | --- | --- | --- |\n| 源代码 | 保留许可 | 检查文件 | 已完成 | 保留原文 |",
        "```text\n" +
          "literal-content-with-no-line-break/".repeat(12) +
          "\n```",
        "正文结束，不新增任何模型请求。",
      ].join("\n\n"),
    );
    await chooseAppearance(page, appearance, "电光青");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await root.locator("h1").scrollIntoViewIfNeeded();
      const typography = await root.evaluate((element) => {
        const size = (selector: string) =>
          parseFloat(
            getComputedStyle(element.querySelector(selector)!).fontSize,
          );
        return {
          body: parseFloat(getComputedStyle(element).fontSize),
          line: parseFloat(getComputedStyle(element).lineHeight),
          headings: [size("h1"), size("h2"), size("h3")],
          paragraphGap: getComputedStyle(element.querySelector("p")!)
            .marginBottom,
          overflow: element.scrollWidth - element.clientWidth,
          pageOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          tableScroll: !!element.querySelector(".markdown-table-scroll"),
        };
      });
      expect(typography.body).toBe(15);
      expect(typography.line / typography.body).toBeCloseTo(1.65);
      expect(typography.headings[0]).toBeGreaterThan(typography.headings[1]!);
      expect(typography.headings[1]).toBeGreaterThan(typography.headings[2]!);
      expect(typography.headings[2]).toBeGreaterThan(typography.body);
      expect(typography.paragraphGap).toBe("11.25px");
      expect(typography.overflow).toBeLessThanOrEqual(1);
      expect(typography.pageOverflow).toBeLessThanOrEqual(1);
      expect(typography.tableScroll).toBe(true);
      await expect(
        root.getByRole("link", {
          name: "https://github.com/shafreeck/24frames",
          exact: true,
        }),
      ).toHaveAttribute("href", "https://github.com/shafreeck/24frames");
      await expect(root).toContainText("这条说明仍保留原来的换行。");
      await page.screenshot({ path: info.outputPath(`message-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    for (const [preference, expectedSize] of [
      ["large", 17],
      ["larger", 19],
    ] as const) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("combobox", { name: "阅读字号" })
        .selectOption(preference);
      await page.keyboard.press("Escape");
      await expect(root).toHaveCSS("font-size", `${expectedSize}px`);
      await expect(root.locator("h1")).toHaveCSS(
        "font-size",
        `${(expectedSize * 1.4).toFixed(1)}px`,
      );
      await expect(root.locator("h2")).toHaveCSS(
        "font-size",
        `${(expectedSize * 1.2).toFixed(1)}px`,
      );
    }
  });
}
