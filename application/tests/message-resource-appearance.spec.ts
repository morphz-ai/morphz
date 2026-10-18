import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import {
  composerAction,
  openExchangeReading,
  openInput,
  settleTransitions,
} from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

async function prepare(
  page: Page,
  title = "TEST 一碗面换一间铺｜原创短篇小说",
  withQuote = false,
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
  if (withQuote) {
    const original = fixture.input(
      "quoted-message-source",
      "TEST 这是被引用的消息正文。",
      "2026-10-11T00:24:00.000Z",
    );
    inputs.push(original);
    sent.textQuotes = [
      {
        id: randomUUID(),
        text: original.body,
        comment: "TEST 针对选文的评论。",
        source: {
          kind: "message",
          ...fixture.scope,
          messageId: original.id,
          inputId: original.id,
          title: "我",
          createdAt: original.createdAt,
        },
        anchor: {
          start: 0,
          end: original.body.length,
          prefix: "",
          suffix: "",
        },
      },
    ];
  }
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

async function setFixtureViewport(page: Page, width: number, zoom: number) {
  await page.setViewportSize({ width, height: 960 });
  await page.locator(".app").evaluate((element, zoom) => {
    const app = element as HTMLElement;
    app.style.zoom = String(zoom);
    app.style.height = zoom === 1 ? "" : `calc(100dvh / ${zoom})`;
  }, zoom);
  // CSS zoom leaves window.innerWidth/media queries unscaled, unlike native
  // browser zoom. Use the real sidebar control for this narrow work surface,
  // rather than accepting an impossible expanded 200px sidebar in 325px.
  const sidebarToggle = page.getByRole("button", {
    name: zoom === 2 ? "隐藏侧边栏" : "显示侧边栏",
    exact: true,
  });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
  await settleTransitions(page);
}

test("选文在正文上方，关联资源独立放在正文下方；亮暗窄窗和缩放不混用位置", async ({
  page,
}, info) => {
  const { message, resource } = await prepare(page, undefined, true);
  const quotes = message.locator(":scope > .sent-text-quotes");
  const body = message.locator(":scope > p");
  const footer = message.getByRole("group", { name: "关联资源", exact: true });
  await expect(footer).toHaveCount(1);
  await expect(footer.locator(".message-object-link")).toHaveCount(1);
  await expect(resource.locator(".message-resource-prefix")).toHaveCount(0);
  await expect(resource).not.toContainText("关联");
  await expect(resource.locator(".message-resource-open")).toHaveCount(1);
  for (const appearance of ["亮色", "暗色"]) {
    const settings = await openSettings(page, "外观");
    await settings
      .getByRole("button", { name: appearance, exact: true })
      .click();
    await page.keyboard.press("Escape");
    for (const zoom of [1, 2]) {
      await setFixtureViewport(page, zoom === 1 ? 1440 : 650, zoom);
      await openInput(page);
      await message.scrollIntoViewIfNeeded();
      await settleTransitions(page);
      const q = (await quotes.boundingBox())!;
      const b = (await body.boundingBox())!;
      const f = (await footer.boundingBox())!;
      const m = (await message.boundingBox())!;
      await info.attach(`resource-layout-${appearance}-${zoom}.json`, {
        contentType: "application/json",
        body: JSON.stringify(
          await message.evaluate((element) =>
            [element, ...element.querySelectorAll("*")].map((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return {
                className: node.className,
                width: rect.width,
                x: rect.x,
                y: rect.y,
                scrollWidth: node.scrollWidth,
                clientWidth: node.clientWidth,
                font: style.font,
                position: style.position,
                overflow: style.overflow,
              };
            }),
          ),
          null,
          2,
        ),
      });
      expect(q.y + q.height).toBeLessThanOrEqual(b.y + 1);
      expect(f.y).toBeGreaterThanOrEqual(b.y + b.height + 4 * zoom);
      expect(f.y + f.height).toBeLessThanOrEqual(m.y + m.height - 4 * zoom);
      expect(f.x).toBeGreaterThanOrEqual(m.x);
      expect(f.x + f.width).toBeLessThanOrEqual(m.x + m.width);
      await expect(footer.locator(".sent-text-quote,blockquote")).toHaveCount(
        0,
      );
      await expect(resource).not.toHaveAttribute("data-quotable");
      expect(
        await message.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(2);
      await message.screenshot({
        path: info.outputPath(`quote-body-resource-${appearance}-${zoom}.png`),
      });
    }
    await setFixtureViewport(page, 1440, 1);
  }
});

test("对象交流仅浮动局部按钮、不铺整行底板；范围在边框内且窄窗200%不动草稿", async ({
  page,
}, info) => {
  const { resource, fixture, sent, message } = await prepare(
    page,
    undefined,
    true,
  );
  const sends: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/messages(?:\?|$)/.test(request.url())
    )
      sends.push(request.url());
  });
  sent.body += "\nTEST 消息滚动时不能穿过范围与操作行。".repeat(24);
  await fixture.refresh();
  await expect(message).toContainText(sent.body);
  await resource.click();
  // Reading is an explicit remembered selection for this work surface. Opening
  // a resource never selects it implicitly; set it through the real control.
  await openExchangeReading(page);
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 仅核验布局，原草稿不发送。");
  await composerAction(page, "固定输入框");
  const panel = page.locator(".exchange-panel");
  const history = panel.locator(":scope > .conversation");
  const scope = panel.locator(".conversation-scope");
  const controls = panel.getByRole("group", {
    name: "交流面板操作",
    exact: true,
  });
  const layout = [];
  for (const appearance of ["亮色", "暗色"]) {
    const settings = await openSettings(page, "外观");
    await settings
      .getByRole("button", { name: appearance, exact: true })
      .click();
    await page.keyboard.press("Escape");
    for (const [width, zoom] of [
      [1440, 1],
      [760, 1],
      [650, 2],
    ] as const) {
      await setFixtureViewport(page, width, zoom);
      await expect(scope).toBeVisible();
      await history.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const h = (await history.boundingBox())!;
      const s = (await scope.boundingBox())!;
      const c = (await controls.boundingBox())!;
      const floating = await panel.evaluate((element) => {
        const header = element.querySelector(".exchange-panel-header")!;
        const scope = element.querySelector(".conversation-scope")!;
        const controls = element.querySelector(".exchange-view-tools")!;
        const reading = element.querySelector(":scope > .conversation")!;
        const style = getComputedStyle(header);
        const scopeStyle = getComputedStyle(scope);
        const controlsStyle = getComputedStyle(controls);
        const s = scope.getBoundingClientRect();
        const c = controls.getBoundingClientRect();
        const gapHit = document.elementFromPoint(
          (s.right + c.left) / 2,
          c.y + c.height / 2,
        );
        return {
          position: style.position,
          headerBackground: style.backgroundColor,
          headerShadow: style.boxShadow,
          beforeContent: getComputedStyle(header, "::before").content,
          afterContent: getComputedStyle(header, "::after").content,
          gapReadsThrough: !!gapHit && reading.contains(gapHit),
          scopeBackground: scopeStyle.backgroundColor,
          controlsBackground: controlsStyle.backgroundColor,
          scopeBlur: scopeStyle.backdropFilter,
          controlsBlur: controlsStyle.backdropFilter,
          scopeRadius: scopeStyle.borderRadius,
          controlsRadius: controlsStyle.borderRadius,
        };
      });
      await info.attach(`local-floating-${appearance}-${width}-${zoom}.json`, {
        contentType: "application/json",
        body: JSON.stringify(floating, null, 2),
      });
      await panel.screenshot({
        path: info.outputPath(
          `local-floating-${appearance}-${width}-${zoom}.png`,
        ),
      });
      expect(floating.position).toBe("absolute");
      expect(floating.headerBackground).toBe("rgba(0, 0, 0, 0)");
      expect(floating.headerShadow).toBe("none");
      expect(floating.beforeContent).toBe("none");
      expect(floating.afterContent).toBe("none");
      expect(floating.gapReadsThrough).toBe(true);
      expect(floating.scopeBackground).toBe(floating.controlsBackground);
      expect(floating.scopeBlur).toBe(floating.controlsBlur);
      expect(floating.scopeRadius).toBe(floating.controlsRadius);
      await info.attach(`header-layout-${appearance}-${width}-${zoom}.json`, {
        contentType: "application/json",
        body: JSON.stringify(
          {
            h,
            s,
            c,
            details: await panel.evaluate((element) =>
              [
                element,
                ...element.querySelectorAll(
                  ".exchange-panel-header,.conversation-scope,.exchange-view-tools,.exchange-view-tools > button",
                ),
              ].map((node) => {
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return {
                  className: node.className,
                  width: rect.width,
                  x: rect.x,
                  y: rect.y,
                  font: style.font,
                  controlsWidth: style.getPropertyValue(
                    "--exchange-controls-width",
                  ),
                  padding: style.padding,
                };
              }),
            ),
          },
          null,
          2,
        ),
      });
      for (const box of [s, c]) {
        expect(box.y).toBeGreaterThanOrEqual(h.y + zoom);
        expect(box.y + box.height).toBeLessThanOrEqual(h.y + h.height - zoom);
        expect(box.x).toBeGreaterThanOrEqual(h.x + zoom);
        expect(box.x + box.width).toBeLessThanOrEqual(h.x + h.width - zoom);
      }
      expect(s.x + s.width).toBeLessThanOrEqual(c.x);
      expect(
        Math.abs(s.y + s.height / 2 - (c.y + c.height / 2)),
      ).toBeLessThanOrEqual(4 * zoom);
      const hits = await panel.evaluate((element) =>
        [
          ...element.querySelectorAll<HTMLButtonElement>(
            ".conversation-scope > button,.exchange-view-tools > button",
          ),
        ]
          .filter((button) => button.getClientRects().length)
          .map((button) => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + 2,
            );
            return {
              label: button.getAttribute("aria-label") ?? button.textContent,
              hit: !!hit && button.contains(hit),
            };
          }),
      );
      for (const hit of hits) expect(hit.hit, String(hit.label)).toBe(true);
      const current = scope.getByRole("button", {
        name: "当前作品",
        exact: true,
      });
      const all = scope.getByRole("button", { name: "全部交流", exact: true });
      await current.click();
      await expect(current).toHaveAttribute("aria-pressed", "true");
      await all.click();
      await expect(all).toHaveAttribute("aria-pressed", "true");
      await expect(current).toHaveAttribute("aria-pressed", "false");
      await all.press("Enter");
      await expect(all).toHaveAttribute("aria-pressed", "true");
      await current.press("Space");
      await expect(current).toHaveAttribute("aria-pressed", "true");
      await expect(all).toHaveAttribute("aria-pressed", "false");
      await expect(scope.getByRole("button")).toHaveCount(2);
      await expect(input).toHaveValue("TEST 仅核验布局，原草稿不发送。");
      await page.mouse.move(0, 0);
      await panel.screenshot({
        path: info.outputPath(
          `exchange-header-${appearance}-${width}-${zoom}.png`,
        ),
      });
      layout.push({
        appearance,
        width,
        zoom,
        reading: h,
        scope: s,
        controls: c,
        hits,
      });
    }
    await setFixtureViewport(page, 1440, 1);
  }
  expect(sends).toEqual([]);
  await info.attach("inside-reading-header.json", {
    contentType: "application/json",
    body: JSON.stringify(layout, null, 2),
  });
});

test.describe("交流范围直接筛选的触控路径", () => {
  test.use({ hasTouch: true });
  test("两项均可直接触控，当前范围不被悬停冒充；窄窗200%保持框内且不改输入关联", async ({
    page,
  }, info) => {
    const { resource } = await prepare(page, undefined, true);
    await resource.click();
    await openExchangeReading(page);
    const input = page.getByLabel("AI 输入内容");
    await input.fill("TEST 触控筛选保留草稿，不发送");
    await composerAction(page, "固定输入框");
    const association = await page
      .locator(".composer-scope-label")
      .textContent();
    const scope = page.getByRole("group", { name: "交流范围", exact: true });
    const current = scope.getByRole("button", {
      name: "当前作品",
      exact: true,
    });
    const all = scope.getByRole("button", { name: "全部交流", exact: true });
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    for (const appearance of ["亮色", "暗色"]) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await page.keyboard.press("Escape");
      for (const [width, zoom] of [
        [1440, 1],
        [760, 1],
        [650, 2],
      ] as const) {
        await setFixtureViewport(page, width, zoom);
        const reading = (await page.locator(".conversation").boundingBox())!;
        const tools = (await page
          .getByRole("group", { name: "交流面板操作", exact: true })
          .boundingBox())!;
        const box = (await scope.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(reading.x + zoom);
        expect(box.x + box.width).toBeLessThanOrEqual(tools.x);
        expect(box.y + box.height).toBeLessThanOrEqual(
          reading.y + reading.height - zoom,
        );
        for (const button of [current, all]) {
          const hit = (await button.boundingBox())!;
          expect(hit.height).toBeGreaterThanOrEqual(44 * zoom);
          expect(hit.width).toBeGreaterThanOrEqual(44 * zoom);
          expect(
            await button.evaluate((button) => {
              const box = button.getBoundingClientRect();
              return button.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + 2),
              );
            }),
          ).toBe(true);
        }
        await all.tap();
        await expect(all).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".conversation")).toContainText(
          "TEST 这是被引用的消息正文。",
        );
        await expect(page.locator(".conversation .human-message")).toHaveCount(
          2,
        );
        await settleTransitions(page);
        const selectedSurface = await all.evaluate(
          (button) => getComputedStyle(button).backgroundColor,
        );
        await current.hover();
        await settleTransitions(page);
        await expect(current).toHaveAttribute("aria-pressed", "false");
        expect(
          await all.evaluate(
            (button) => getComputedStyle(button).backgroundColor,
          ),
        ).toBe(selectedSurface);
        await current.tap();
        await expect(current).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".conversation .human-message")).toHaveCount(
          1,
        );
        await expect(input).toHaveValue("TEST 触控筛选保留草稿，不发送");
        await expect(page.locator(".composer-scope-label")).toHaveText(
          association!,
        );
        await expect(page.getByRole("menu")).toHaveCount(0);
        await page.mouse.move(0, 0);
        await page.locator(".exchange-panel").screenshot({
          path: info.outputPath(
            `scope-touch-${appearance}-${width}-${zoom}.png`,
          ),
        });
      }
      await setFixtureViewport(page, 1440, 1);
    }
    await composerAction(page, "收起交流记录");
    await expect(scope).toHaveCount(0);
    await expect(input).toHaveValue("TEST 触控筛选保留草稿，不发送");
  });
});

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
      const body = (await message.locator(":scope > p").boundingBox())!;
      expect((await resource.boundingBox())!.y).toBeGreaterThanOrEqual(
        body.y + body.height,
      );
      expect(normal.background[3]).toBeGreaterThan(0);
      expect(normal.background[3]).toBeLessThanOrEqual(13);
      expect(normal.border).toBe("1px");
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
