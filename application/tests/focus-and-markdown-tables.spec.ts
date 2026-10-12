import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openSettings } from "./settings-helpers.js";

const description =
  "身份、审批、执行记录和未知结果处理形成较完整的治理链路，但组成机制并非全新发明，需要用对照证明实际收益。".repeat(
    3,
  );
const longToken = "morphz_exact_identity_".repeat(24);
const markdown = [
  "正文保持可读，表格不应要求读者逐格左右滚动。",
  "| 维度 | 项目评价 | 说明 |",
  "| --- | --- | --- |",
  `| **技术创新 30%** | ${description} | 自动换行保留完整文字。 |`,
  `| 场景落地 30% | ${description} | 支持中文与 English prose。 |`,
  `| 精确标识 | \`${longToken}\` | [长网址](https://example.invalid/${longToken}) |`,
  "",
  "```text",
  longToken,
  "```",
].join("\n");

async function prepare(page: Page, document = false) {
  let text = markdown;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      deliveries: [],
      messages: [
        {
          id: "focus-table-reply",
          ...fixture.scope,
          inputId: null,
          rootId: null,
          artifactId: null,
          kind: "reply" as const,
          createdAt: "2026-10-12T00:00:00Z",
          text,
        },
      ],
    },
  }));
  if (document) {
    const saved = (await fixture.client.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: fixture.spaces.deskId,
      title: `TEST 表格换行 ${randomUUID()}`,
      markdown,
    })) as { contentId: string };
    text = `[打开测试文档](artifact:${saved.contentId})`;
  }
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const reply = page.locator(
    '[data-message-id="focus-table-reply"] .reply-content',
  );
  if (document) {
    await reply.getByRole("button", { name: "打开测试文档" }).click();
  }
  const root = document ? page.locator(".object-paper .document-body") : reply;
  await expect(root.getByRole("table")).toBeVisible();
  return {
    root,
    table: root.getByRole("region", { name: "表格", exact: true }),
  };
}

async function focusStyle(target: Locator) {
  return target.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      outline: css.outlineStyle,
      width: css.outlineWidth,
      color: css.outlineColor,
      offset: css.outlineOffset,
      visible: element.matches(":focus-visible"),
      mode: document.documentElement.dataset.uiFocus,
    };
  });
}

async function keyboardFocus(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

async function wrapped(table: Locator) {
  return table.evaluate((element) => {
    const cell = element.querySelector("tbody td:nth-child(2)")!;
    const range = document.createRange();
    range.selectNodeContents(cell);
    const lines = new Set(
      [...range.getClientRects()].map((r) => Math.round(r.top)),
    );
    const css = getComputedStyle(cell);
    return {
      overflow: element.scrollWidth - element.clientWidth,
      lines: lines.size,
      whiteSpace: css.whiteSpace,
      wrapping: css.overflowWrap,
      smallestColumn:
        Math.min(
          ...[...element.querySelectorAll("th")].map(
            (header) => header.getBoundingClientRect().width,
          ),
        ) / element.getBoundingClientRect().width,
    };
  });
}

for (const document of [false, true]) {
  test(`${document ? "文档" : "对话"}表格：文字自动换行，窄窗与放大不截断`, async ({
    page,
  }, info) => {
    const { root, table } = await prepare(page, document);
    for (const [width, zoom] of [
      [1440, 1],
      [760, 1],
      [390, 1],
      [1440, 2],
    ] as const) {
      await page.setViewportSize({ width, height: 960 });
      await page.locator(".app").evaluate((element, zoom) => {
        (element as HTMLElement).style.zoom = String(zoom);
      }, zoom);
      const state = await wrapped(table);
      await info.attach(`${width}-${zoom}-geometry`, {
        body: JSON.stringify(state),
        contentType: "application/json",
      });
      expect(state.overflow).toBeLessThanOrEqual(1);
      expect(state.lines).toBeGreaterThan(1);
      expect(state.whiteSpace).toBe("normal");
      expect(state.smallestColumn).toBeGreaterThan(0.2);
      await expect(root.locator("tbody td").nth(1)).toHaveText(description);
      await expect(root.locator("tbody code")).toHaveText(longToken);
      // Table wrapping cannot alter code bytes or the consumers' existing
      // policies: chat scrolls code; documents already wrap code visually.
      await expect(root.locator("pre code")).toHaveText(longToken + "\n");
      if (document) {
        expect(
          await root
            .locator("pre")
            .evaluate((e) => getComputedStyle(e).whiteSpace),
        ).toBe("pre-wrap");
      } else {
        expect(
          await root
            .locator("pre")
            .evaluate((e) => e.scrollWidth > e.clientWidth),
        ).toBe(true);
      }
      await table.screenshot({
        path: info.outputPath(`${width}-${zoom}-table.png`),
      });
    }
  });
}

test("鼠标点击表格和消息区不留原生焦点框，键盘仍可定位和滚动", async ({
  page,
}, info) => {
  const { table } = await prepare(page);
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 未发送草稿");
  await input.press("ArrowLeft");
  await table.locator("td").first().click();
  await expect(table).toBeFocused();
  await info.attach("pointer-focus", {
    body: JSON.stringify(await focusStyle(table)),
    contentType: "application/json",
  });
  expect((await focusStyle(table)).outline).toBe("none");
  const conversation = page.locator(".conversation");
  await conversation.click({ position: { x: 4, y: 120 } });
  expect((await focusStyle(conversation)).outline).toBe("none");
  await keyboardFocus(page, table);
  expect((await focusStyle(table)).outline).toBe("solid");
  expect((await focusStyle(table)).width).toBe("1px");
  expect((await focusStyle(table)).offset).toBe("-2px");
  const before = await conversation.evaluate((e) => e.scrollTop);
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => conversation.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(before);
  await table.locator("td").first().click();
  expect((await focusStyle(table)).outline).toBe("none");
  await expect(input).toHaveValue("TEST 未发送草稿");
  await page.screenshot({ path: info.outputPath("pointer-no-frame.png") });
});

test("搜索自动聚焦输入，鼠标关闭不把原生框带回按钮，键盘关闭保留焦点提示", async ({
  page,
}) => {
  await prepare(page);
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 搜索不发送草稿");
  const trigger = page.getByRole("button", { name: "查找对话", exact: true });
  const dialog = page.getByRole("dialog", {
    name: "查找当前对话",
    exact: true,
  });
  await trigger.click();
  await expect(dialog.locator("input")).toBeFocused();
  await page.mouse.click(1, 1);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await focusStyle(trigger)).outline).toBe("none");
  await keyboardFocus(page, trigger);
  await page.keyboard.press("Enter");
  await expect(dialog.locator("input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect((await focusStyle(trigger)).outline).toBe("solid");
  await expect(input).toHaveValue("TEST 搜索不发送草稿");
  await page.emulateMedia({ forcedColors: "active" });
  expect((await focusStyle(trigger)).outline).toBe("solid");
  expect(parseFloat((await focusStyle(trigger)).width)).toBeGreaterThan(0);
});

test("按钮和弹层统一区分鼠标与键盘，四主题亮暗不回退原生颜色", async ({
  page,
}, info) => {
  await prepare(page);
  const trigger = page.getByRole("button", { name: "外观设置", exact: true });
  for (const appearance of ["亮色", "暗色"]) {
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await settings.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByLabel("AI 输入内容").click();
      await trigger.click();
      expect((await focusStyle(trigger)).outline).toBe("none");
      await page.getByRole("heading", { name: "对话", exact: true }).click();
      expect((await focusStyle(trigger)).outline).toBe("none");
      await keyboardFocus(page, trigger);
      expect((await focusStyle(trigger)).outline).toBe("solid");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect((await focusStyle(trigger)).outline).toBe("solid");
      await trigger.click();
      expect((await focusStyle(trigger)).outline).toBe("none");
      await page.getByRole("heading", { name: "对话", exact: true }).click();
    }
  }
  await page.screenshot({
    path: info.outputPath("buttons-no-pointer-ring.png"),
  });
});
