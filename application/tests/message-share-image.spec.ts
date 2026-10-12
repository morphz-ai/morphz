import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

type ShareCall = {
  action: string;
  request: {
    centerId: string;
    principalId: string;
    pictures: { mime: string; data: string }[];
  };
};
type ShareTest = {
  calls: ShareCall[];
  failCopy: boolean;
  cancelSave: boolean;
  waitCopy?: boolean;
  waitSave?: boolean;
  finishCopy?: () => void;
  finishSave?: () => void;
};
declare global {
  interface Window {
    shareImageTest: ShareTest;
    shareImageToBlob?: typeof HTMLCanvasElement.prototype.toBlob;
  }
}

async function prepare(
  page: Page,
  text = "# TEST 分享正文\n\n正文中的 **重点** 和段落应当保留。\n\n> 次级引用保持清晰，但不要抢正文。\n\n| 维度 | 说明 |\n| --- | --- |\n| 格式 | 表格内容自动换行，不截掉文字。 |\n\n- 第一项\n- 第二项\n\n末尾完整标记。",
) {
  await page.addInitScript(() => {
    window.shareImageTest = { calls: [], failCopy: false, cancelSave: false };
    Object.defineProperty(window, "morphzDesktop", {
      configurable: true,
      value: {
        capture: { select: async () => null, cancel: async () => {} },
        voice: {
          requestMicrophone: async () => false,
          cancelMicrophone: async () => {},
        },
        browser: {
          state: async () => null,
          onState: () => () => {},
          onInput: () => () => {},
          onSelection: () => () => {},
        },
        messageImages: {
          copy: async (request: ShareCall["request"]) => {
            window.shareImageTest.calls.push({ action: "copy", request });
            if (window.shareImageTest.waitCopy)
              await new Promise<void>((resolve) => {
                window.shareImageTest.finishCopy = resolve;
              });
            if (window.shareImageTest.failCopy)
              throw new Error("TEST 复制暂不可用");
            return { status: "copied", count: 1 };
          },
          save: async (request: ShareCall["request"]) => {
            window.shareImageTest.calls.push({ action: "save", request });
            if (window.shareImageTest.waitSave)
              await new Promise<void>((resolve) => {
                window.shareImageTest.finishSave = resolve;
              });
            return {
              status: window.shareImageTest.cancelSave ? "cancelled" : "saved",
              count: window.shareImageTest.cancelSave
                ? 0
                : request.pictures.length,
            };
          },
        },
      },
    });
  });
  const inputs: PlatformHistory["inputs"] = [];
  const runtime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    messages: [] as PlatformHistory["runtime"]["messages"],
  };
  const f = await mockPlatformConversation(page, () => ({ inputs, runtime }));
  inputs.push(
    f.input(
      "TEST-share-input",
      "TEST 我也可以分享普通消息。",
      "2026-10-12T12:00:00Z",
    ),
  );
  inputs[0]!.textQuotes = [
    {
      id: randomUUID(),
      text: "TEST 可见的选文。",
      comment: "TEST 对选文的评论。",
      source: {
        kind: "message",
        ...f.scope,
        messageId: "TEST-private-source",
        inputId: "TEST-private-input",
        title: "我",
        createdAt: "2026-10-12T11:59:00Z",
      },
      anchor: { start: 0, end: 12, prefix: "", suffix: "" },
    },
  ];
  runtime.messages.push({
    id: "TEST-share-reply",
    ...f.scope,
    inputId: inputs[0]!.id,
    artifactId: null,
    kind: "reply",
    text,
    createdAt: "2026-10-12T12:00:01Z",
  });
  const writes: string[] = [],
    external: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(?:platform\/messages|commands|executions\/(?:cancel|continue))/.test(
        request.url(),
      )
    )
      writes.push(request.url());
    if (
      /^https?:/.test(request.url()) &&
      new URL(request.url()).hostname !== "127.0.0.1"
    )
      external.push(request.url());
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await (await openInput(page)).fill("TEST 分享和关闭后仍保留的未发送草稿");
  return { ...f, inputs, runtime, writes, external, errors };
}

async function openShare(page: Page, id = "TEST-share-reply") {
  const message = page.locator(`[data-message-id="${id}"]`);
  await message.hover();
  await message.getByRole("button", { name: "分享图片", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分享图片", exact: true });
  await expect(dialog.getByRole("img")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "复制图片", exact: true }),
  ).toBeEnabled();
  return dialog;
}

async function pngFacts(page: Page) {
  return page
    .getByRole("dialog", { name: "分享图片", exact: true })
    .getByRole("img")
    .evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      // The real CSP intentionally excludes blob: from connect-src. Inspect
      // the displayed raster without widening that gate just for a test read.
      const bytes = Uint8Array.from(
        atob(canvas.toDataURL("image/png").split(",")[1]!),
        (character) => character.charCodeAt(0),
      );
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let bodyInk = 0;
      // Prove the actual warning glyphs are painted, rather than depending on
      // the old footer's word length or accepting a repeated brand word.
      const expected = document.createElement("canvas");
      expected.width = canvas.width;
      expected.height = 96;
      const marker = expected.getContext("2d")!;
      const sheet = document.querySelector<HTMLElement>(
        ".message-share-sheet",
      )!;
      marker.fillStyle = getComputedStyle(sheet).backgroundColor;
      marker.fillRect(0, 0, expected.width, expected.height);
      marker.scale(2, 2);
      const swatch = document.createElement("span");
      swatch.style.color = "var(--muted)";
      sheet.append(swatch);
      marker.fillStyle = getComputedStyle(swatch).color;
      swatch.remove();
      marker.font = `13px ${getComputedStyle(sheet).fontFamily}`;
      marker.fillText("当前已显示内容（未完成）", 52, 30);
      const reference = marker.getImageData(0, 0, expected.width, 96).data;
      const base = marker.getImageData(0, 0, 1, 1).data;
      let markerInk = 0,
        matchingMarkerInk = 0;
      for (let y = 0; y < 96; y++)
        for (let x = 104; x < 700; x++) {
          const at = (y * expected.width + x) * 4;
          if (
            Math.max(
              Math.abs(reference[at]! - base[0]!),
              Math.abs(reference[at + 1]! - base[1]!),
              Math.abs(reference[at + 2]! - base[2]!),
            ) < 30
          )
            continue;
          markerInk++;
          const actual = ((canvas.height - 152 + y) * canvas.width + x) * 4;
          if (
            Math.max(
              Math.abs(data[actual]! - reference[at]!),
              Math.abs(data[actual + 1]! - reference[at + 1]!),
              Math.abs(data[actual + 2]! - reference[at + 2]!),
            ) <= 2
          )
            matchingMarkerInk++;
        }
      for (let y = 124; y < canvas.height - 70; y++)
        for (let x = 64; x < canvas.width - 64; x++) {
          const at = (y * canvas.width + x) * 4;
          if (
            Math.max(
              Math.abs(data[at]! - data[0]!),
              Math.abs(data[at + 1]! - data[1]!),
              Math.abs(data[at + 2]! - data[2]!),
            ) > 40
          )
            bodyInk++;
        }
      return {
        header: [...bytes.slice(0, 8)],
        width: image.naturalWidth,
        height: image.naturalHeight,
        bodyInk,
        paper: [...ctx.getImageData(60, 200, 1, 1).data.slice(0, 3)],
        markerInk,
        footerLabelMatch: matchingMarkerInk / markerInk,
      };
    });
}

test("复制旁可生成真实PNG预览，保留Markdown表格和可见引用；复制／保存不发送输入或泄露内部来源", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const dialog = await openShare(page);
  const facts = await pngFacts(page);
  expect(facts.header).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(facts.width).toBe(1408);
  expect(facts.height).toBeLessThanOrEqual(3440);
  expect(facts.bodyInk).toBeGreaterThan(5000);
  await expect(dialog.locator(".message-share-sheet table")).toHaveCount(1);
  await expect(dialog.locator(".message-share-sheet")).toContainText(
    "末尾完整标记",
  );
  await dialog.getByRole("button", { name: "复制图片", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "已复制", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "保存图片", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "已保存", exact: true }),
  ).toBeEnabled();
  const calls = await page.evaluate(() => window.shareImageTest.calls);
  expect(calls.map((call) => call.action)).toEqual(["copy", "save"]);
  for (const call of calls) {
    expect(call.request.centerId).toBe(f.client.boot.centerId);
    expect(call.request.principalId).toBe(f.client.boot.principalId);
    expect(Object.keys(call.request)).toEqual([
      "centerId",
      "principalId",
      "createdAt",
      "pictures",
    ]);
    expect(
      Buffer.from(call.request.pictures[0]!.data, "base64").subarray(0, 8),
    ).toEqual(Buffer.from(facts.header));
  }
  await writeFile(
    info.outputPath("message-share-export.png"),
    Buffer.from(calls[0]!.request.pictures[0]!.data, "base64"),
  );
  await page.screenshot({
    path: info.outputPath("message-share-markdown.png"),
  });
  await dialog
    .getByRole("button", { name: "关闭分享图片", exact: true })
    .click();
  await expect(
    page
      .locator('[data-message-id="TEST-share-reply"]')
      .getByRole("button", { name: "分享图片", exact: true }),
  ).toBeFocused();
  const human = await openShare(page, "TEST-share-input");
  await expect(human.locator(".message-share-sheet")).toContainText(
    "TEST 对选文的评论",
  );
  await expect(human.locator(".message-share-sheet")).not.toContainText(
    "TEST-private",
  );
  await expect(human.locator(".message-share-sheet")).not.toContainText(
    "projectId",
  );
  await page.keyboard.press("Escape");
  await expect(human).not.toBeVisible();
  await expect(await openInput(page)).toHaveValue(
    "TEST 分享和关闭后仍保留的未发送草稿",
  );
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("长消息按实际文字行分页，末尾与完整正文保留；当前页复制、全部保存及取消／失败重试", async ({
  page,
}, info) => {
  const text =
    Array.from(
      { length: 100 },
      (_, index) =>
        `第 ${index + 1} 段：TEST 很长的任务结果，需要完整保留，每一段都能阅读，不能截断。`,
    ).join("\n\n") + "\n\nTEST 全文最终标记。";
  const f = await prepare(page, text);
  const dialog = await openShare(page);
  const count = Number(
    (await dialog.getByRole("group", { name: "图片分页" }).textContent())!
      .split("/")[1]!
      .trim(),
  );
  expect(count).toBeGreaterThan(1);
  await expect(dialog.locator(".message-share-sheet")).toContainText(
    "TEST 全文最终标记",
  );
  await page.evaluate(() => {
    window.shareImageTest.failCopy = true;
  });
  await dialog.getByRole("button", { name: "复制图片", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("TEST 复制暂不可用");
  await expect(dialog.getByRole("img")).toBeVisible();
  await page.evaluate(() => {
    window.shareImageTest.failCopy = false;
    window.shareImageTest.cancelSave = true;
  });
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "保存全部", exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await page.evaluate(() => {
    window.shareImageTest.cancelSave = false;
  });
  for (let index = 1; index < count; index++)
    await dialog.getByRole("button", { name: "下一张", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "下一张", exact: true }),
  ).toBeDisabled();
  expect((await pngFacts(page)).bodyInk).toBeGreaterThan(1000);
  await dialog.getByRole("button", { name: "复制图片", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "已复制", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "保存全部", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "已保存", exact: true }),
  ).toBeEnabled();
  const calls = await page.evaluate(() => window.shareImageTest.calls);
  expect(calls.at(-1)!.request.pictures).toHaveLength(count);
  expect(calls.at(-2)!.request.pictures).toHaveLength(1);
  for (const [index, picture] of calls.at(-1)!.request.pictures.entries())
    await writeFile(
      info.outputPath(`long-export-${index + 1}.png`),
      Buffer.from(picture.data, "base64"),
    );
  await page.screenshot({
    path: info.outputPath("message-share-long-last-page.png"),
  });
  await page.keyboard.press("Escape");
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("真实分享图片在亮暗四主题与两倍布局下完整可读，未完成正文明确标示", async ({
  page,
}, info) => {
  const f = await prepare(
    page,
    "## TEST 分享版式\n\n一段正常的正文，与 **重点** 形成清楚的层级。\n\n> 次级引用不抢正文，也不制造额外空行。\n\n| 项目 | 说明 |\n| --- | --- |\n| 中文 | 自动换行，正文完整保留，含 [链接](https://example.invalid/) 与 English。 |\n\nTEST 完整末尾。",
  );
  f.runtime.messages[0]!.incomplete = true;
  await f.refresh();
  const sizes = [];
  for (const appearance of ["light", "dark"]) {
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await page.evaluate(
        ({ appearance, accent }) => {
          document.documentElement.dataset.appearance = appearance;
          const app = document.querySelector(".app") as HTMLElement;
          app.dataset.appearance = appearance;
          app.dataset.accent = accent;
          app.style.colorScheme = appearance;
          document.documentElement.style.colorScheme = appearance;
          document.documentElement.style.zoom =
            appearance === "dark" ? "2" : "1";
        },
        { appearance, accent },
      );
      const dialog = await openShare(page);
      const facts = await pngFacts(page);
      expect(facts.width).toBe(1408);
      expect(
        facts.paper.every((channel) =>
          appearance === "dark" ? channel < 80 : channel > 200,
        ),
      ).toBe(true);
      expect(facts.bodyInk).toBeGreaterThan(4000);
      expect(facts.markerInk).toBeGreaterThan(500);
      expect(facts.footerLabelMatch).toBeGreaterThan(0.98);
      sizes.push([facts.width, facts.height]);
      await dialog
        .getByRole("button", { name: "复制图片", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "已复制", exact: true }),
      ).toBeEnabled();
      const picture = await page.evaluate(
        () => window.shareImageTest.calls.at(-1)!.request.pictures[0]!,
      );
      await writeFile(
        info.outputPath(`${appearance}-${accent}-export.png`),
        Buffer.from(picture.data, "base64"),
      );
      await page.screenshot({
        path: info.outputPath(`${appearance}-${accent}-preview.png`),
      });
      await page.keyboard.press("Escape");
    }
  }
  expect(new Set(sizes.map((size) => size.join("x"))).size).toBe(1);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("分享预览冻结点击时的消息内容，刷新不重新生成；窄屏与CSS两倍布局、键盘焦点保持", async ({
  page,
}, info) => {
  const f = await prepare(
    page,
    "TEST 点击时的分享内容。\n\n<script>不执行</script>\n\n[外部图片](https://example.invalid/secret.png)",
  );
  const dialog = await openShare(page);
  const url = await dialog.getByRole("img").getAttribute("src");
  f.runtime.messages[0]!.text =
    "TEST 后续刷新后的正文，不应改写已打开的分享图片。";
  await f.refresh();
  await expect(dialog.getByRole("img")).toHaveAttribute("src", url!);
  await expect(dialog.locator(".message-share-sheet")).toContainText(
    "TEST 点击时的分享内容",
  );
  for (const [width, zoom] of [
    [390, 1],
    [1440, 2],
  ]) {
    await page.setViewportSize({ width: width!, height: 960 });
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, zoom);
    const geometry = await dialog.evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    await page.screenshot({
      path: info.outputPath(`message-share-${width}-${zoom}.png`),
    });
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await dialog
    .getByRole("button", { name: "关闭分享图片", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "放大预览", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(await openInput(page)).toHaveValue(
    "TEST 分享和关闭后仍保留的未发送草稿",
  );
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("图片预览默认完整适应窗口，操作留在低调底栏；放大与换页只改变本地预览", async ({
  page,
}, info) => {
  const text = Array.from(
    { length: 55 },
    (_, index) =>
      `TEST ${index + 1}：这是一张长图，完整预览不该把全文放大铺满弹窗；想看细节时可以放大。`,
  ).join("\n\n");
  const f = await prepare(page, text);
  const dialog = await openShare(page);
  const image = dialog.getByRole("img");
  const stage = dialog.getByRole("region", { name: "图片预览" });
  const facts = async () =>
    stage.evaluate((element) => {
      const image = element.querySelector("img")!;
      const picture = image.getBoundingClientRect();
      const frame = element.getBoundingClientRect();
      return {
        top: picture.top - frame.top,
        bottom: frame.bottom - picture.bottom,
        left: picture.left - frame.left,
        right: frame.right - picture.right,
        scroll: element.scrollHeight - element.clientHeight,
        width: picture.width,
        height: picture.height,
      };
    });
  const fit = await facts();
  expect(fit.scroll).toBeLessThanOrEqual(1);
  expect(
    Math.min(fit.top, fit.bottom, fit.left, fit.right),
  ).toBeGreaterThanOrEqual(-1);
  expect(Math.min(fit.top, fit.bottom)).toBeLessThanOrEqual(1);
  await expect(dialog.locator("header button")).toHaveCount(4);
  await expect(
    dialog.locator("header").getByRole("button", { name: "复制图片" }),
  ).toHaveCount(0);
  await expect(dialog.locator(".message-share-toolbar .primary")).toHaveText(
    "保存全部",
  );
  const url = await image.getAttribute("src");
  await page.screenshot({
    path: info.outputPath("preview-long-fit-light.png"),
  });
  await dialog.getByRole("button", { name: "放大预览", exact: true }).click();
  await expect(dialog).toHaveAttribute("data-expanded", "true");
  await expect.poll(async () => (await facts()).scroll).toBeGreaterThan(100);
  expect((await facts()).width).toBeGreaterThan(fit.width * 1.5);
  await stage.evaluate((element) => (element.scrollTop = 80));
  await f.refresh();
  await expect(image).toHaveAttribute("src", url!);
  expect(await stage.evaluate((element) => element.scrollTop)).toBe(80);
  await page.screenshot({ path: info.outputPath("preview-long-expanded.png") });
  await dialog.getByRole("button", { name: "适应窗口", exact: true }).click();
  await expect(dialog).toHaveAttribute("data-expanded", "false");
  await expect.poll(async () => (await facts()).scroll).toBeLessThanOrEqual(1);
  expect(await stage.evaluate((element) => element.scrollTop)).toBe(0);
  await dialog.getByRole("button", { name: "下一张", exact: true }).click();
  await expect(image).toHaveAttribute("alt", "消息分享图片，第 2 张");
  expect(await stage.evaluate((element) => element.scrollTop)).toBe(0);
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "dark";
    document.documentElement.style.colorScheme = "dark";
    const app = document.querySelector<HTMLElement>(".app")!;
    app.dataset.appearance = "dark";
    app.style.colorScheme = "dark";
  });
  await page.screenshot({ path: info.outputPath("preview-long-fit-dark.png") });
  await page.setViewportSize({ width: 390, height: 740 });
  await expect(dialog.getByRole("button", { name: "保存全部" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "复制图片" })).toBeVisible();
  expect((await facts()).scroll).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("preview-long-narrow.png") });
  await dialog
    .getByRole("group", { name: "图片模板" })
    .getByRole("button", { name: "简洁" })
    .focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "保存全部" })).toBeFocused();
  await dialog.getByRole("button", { name: "关闭分享图片" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "纸笺" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭分享图片" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(await openInput(page)).toHaveValue(
    "TEST 分享和关闭后仍保留的未发送草稿",
  );
  expect(await page.evaluate(() => window.shareImageTest.calls)).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("三种分享模板生成各自配色与字体，默认跟随亮暗；切换仅重排冻结正文、原PNG不泄露或外传", async ({
  page,
}, info) => {
  const f = await prepare(
    page,
    "# TEST 模板\n\n分享卡片保留 **重点**，但不应该把预览套成一层层盒子。\n\n> TEST 引用是次级内容。\n\n末尾必须完整。",
  );
  for (const appearance of ["light", "dark"] as const) {
    await page.evaluate((appearance) => {
      const app = document.querySelector<HTMLElement>(".app")!;
      app.dataset.appearance = appearance;
      app.style.colorScheme = appearance;
      document.documentElement.dataset.appearance = appearance;
      document.documentElement.style.colorScheme = appearance;
    }, appearance);
    const dialog = await openShare(page);
    const templates = dialog.getByRole("group", { name: "图片模板" });
    await expect(
      templates.getByRole("button", { name: "卡片" }),
    ).toHaveAttribute("aria-pressed", "true");
    const images: string[] = [];
    for (const [id, label] of [
      ["card", "卡片"],
      ["simple", "简洁"],
      ["paper", "纸笺"],
    ] as const) {
      await templates.getByRole("button", { name: label }).click();
      await expect(
        dialog.getByRole("button", { name: "复制图片" }),
      ).toBeEnabled();
      await expect(dialog.locator(".message-share-sheet")).toHaveAttribute(
        "data-template",
        id,
      );
      const png = await pngFacts(page);
      expect(
        png.paper.every((channel) =>
          appearance === "dark" ? channel < 80 : channel > 200,
        ),
      ).toBe(true);
      await expect(dialog.locator(".message-share-sheet")).toContainText(
        "末尾必须完整",
      );
      await dialog.getByRole("button", { name: "复制图片" }).click();
      await expect(
        dialog.getByRole("button", { name: "已复制", exact: true }),
      ).toBeEnabled();
      const data = await page.evaluate(
        () => window.shareImageTest.calls.at(-1)!.request.pictures[0]!.data,
      );
      images.push(data);
      await writeFile(
        info.outputPath(`${appearance}-${id}-template.png`),
        Buffer.from(data, "base64"),
      );
      await page.screenshot({
        path: info.outputPath(`${appearance}-${id}-compact-preview.png`),
      });
      const spacing = await dialog.evaluate((element) => {
        const header = element.querySelector("header")!;
        const stage = element.querySelector<HTMLElement>(
          ".message-share-preview",
        )!;
        return {
          headerBottom: header.getBoundingClientRect().bottom,
          stageTop: stage.getBoundingClientRect().top,
          padding: getComputedStyle(stage).padding,
          background: getComputedStyle(stage).backgroundColor,
          imageWidth: stage.querySelector("img")!.getBoundingClientRect().width,
          stageWidth: stage.getBoundingClientRect().width,
        };
      });
      expect(spacing.padding).toBe("0px");
      expect(spacing.background).toBe("rgba(0, 0, 0, 0)");
      expect(spacing.stageTop - spacing.headerBottom).toBeLessThanOrEqual(8);
      expect(
        Math.abs(spacing.stageWidth - spacing.imageWidth),
      ).toBeLessThanOrEqual(2);
    }
    expect(new Set(images).size).toBe(3);
    await page.keyboard.press("Escape");
  }
  await expect(await openInput(page)).toHaveValue(
    "TEST 分享和关闭后仍保留的未发送草稿",
  );
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("新模板生成失败保留旧预览但不能导出旧模板，重试完成后才恢复复制保存", async ({
  page,
}) => {
  const f = await prepare(page, "TEST 模板切换仍保留这条原消息。");
  const dialog = await openShare(page);
  const image = dialog.getByRole("img");
  const original = await image.getAttribute("src");
  await page.evaluate(() => {
    window.shareImageToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = () => {
      throw new Error("TEST 新模板生成暂不可用");
    };
  });
  await dialog
    .getByRole("group", { name: "图片模板" })
    .getByRole("button", { name: "纸笺" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "TEST 新模板生成暂不可用",
  );
  await expect(image).toHaveAttribute("src", original!);
  await image.evaluate((element) => (element as HTMLImageElement).decode());
  await expect(dialog.getByRole("button", { name: "复制图片" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "保存图片" })).toBeDisabled();
  f.runtime.messages[0]!.text = "TEST 更新不应该替换打开的分享内容。";
  await f.refresh();
  await expect(dialog.locator(".message-share-sheet")).toContainText(
    "仍保留这条原消息",
  );
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = window.shareImageToBlob!;
    delete window.shareImageToBlob;
  });
  await dialog.getByRole("button", { name: "重新生成" }).click();
  await expect(dialog.getByRole("button", { name: "复制图片" })).toBeEnabled();
  await expect(image).not.toHaveAttribute("src", original!);
  await expect(
    dialog
      .getByRole("group", { name: "图片模板" })
      .getByRole("button", { name: "纸笺" }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "复制图片" }).click();
  await expect(
    dialog.getByRole("button", { name: "已复制", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.shareImageTest.calls.length)).toBe(1);
  await page.keyboard.press("Escape");
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("复制和保存只更新原按钮，等待、成功、重复操作和取消不增行或移动弹窗", async ({
  page,
}, info) => {
  const f = await prepare(page, "TEST 分享成功不应该使预览窗口上下抖动。");
  for (const appearance of ["light", "dark"]) {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator(".app").evaluate((element) => {
      (element as HTMLElement).style.zoom = "1";
    });
    const settings = await openSettings(page, "外观");
    await settings
      .getByRole("button", {
        name: appearance === "dark" ? "暗色" : "亮色",
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".app")).toHaveAttribute(
      "data-appearance",
      appearance,
    );
    for (const view of [
      { width: 1440, zoom: 1 },
      { width: 390, zoom: 1 },
      { width: 1440, zoom: 2 },
    ]) {
      await page.setViewportSize({ width: view.width, height: 960 });
      await page.locator(".app").evaluate((element, zoom) => {
        (element as HTMLElement).style.zoom = String(zoom);
      }, view.zoom);
      const dialog = await openShare(page);
      expect(
        (await pngFacts(page)).paper.every((channel) =>
          appearance === "dark" ? channel < 80 : channel > 200,
        ),
      ).toBe(true);
      const copy = dialog.locator(".message-share-copy");
      const save = dialog.locator(".message-share-actions > .primary");
      // Measure output feedback after the existing finite dialog entrance,
      // not halfway through its initial 4px reveal. Do not stop runtime motion.
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      const geometry = () =>
        dialog.evaluate((element) =>
          [
            element,
            element.querySelector(".message-share-preview")!,
            ...element.querySelectorAll(".message-share-actions > button"),
          ].map((node) => {
            const bounds = node.getBoundingClientRect();
            return [bounds.x, bounds.y, bounds.width, bounds.height];
          }),
        );
      const before = await geometry();
      const unchanged = async () => {
        const after = await geometry();
        for (const [index, bounds] of after.entries())
          for (const [coordinate, value] of bounds.entries())
            expect(
              Math.abs(value - before[index]![coordinate]!),
              JSON.stringify({
                appearance,
                view,
                index,
                coordinate,
                before,
                after,
              }),
            ).toBeLessThanOrEqual(1);
        await expect(dialog.locator(".message-share-notice")).toHaveCount(0);
        await expect(dialog.getByRole("status")).toHaveCount(0);
      };
      for (const repeat of [false, true]) {
        await page.evaluate(() => {
          window.shareImageTest.waitCopy = true;
          delete window.shareImageTest.finishCopy;
        });
        await copy.click();
        await expect(copy).toHaveText("复制中…");
        await expect(save).toBeDisabled();
        await unchanged();
        await expect
          .poll(() =>
            page.evaluate(() => typeof window.shareImageTest.finishCopy),
          )
          .toBe("function");
        await page.evaluate(() => window.shareImageTest.finishCopy!());
        await expect(copy).toHaveText("已复制");
        await expect(copy).toBeEnabled();
        await unchanged();
        if (repeat)
          await page.screenshot({
            path: info.outputPath(
              `copy-button-${appearance}-${view.width}-${view.zoom}.png`,
            ),
          });
      }
      await page.evaluate(() => {
        window.shareImageTest.waitSave = true;
        window.shareImageTest.cancelSave = true;
        delete window.shareImageTest.finishSave;
      });
      await save.click();
      await expect(save).toHaveText("保存中…");
      await unchanged();
      await expect
        .poll(() =>
          page.evaluate(() => typeof window.shareImageTest.finishSave),
        )
        .toBe("function");
      await page.evaluate(() => window.shareImageTest.finishSave!());
      await expect(save).toHaveText("保存图片");
      await expect(copy).toHaveText("已复制");
      await unchanged();
      await page.evaluate(() => {
        window.shareImageTest.cancelSave = false;
        delete window.shareImageTest.finishSave;
      });
      await save.click();
      await expect(save).toHaveText("保存中…");
      await unchanged();
      await expect
        .poll(() =>
          page.evaluate(() => typeof window.shareImageTest.finishSave),
        )
        .toBe("function");
      await page.evaluate(() => window.shareImageTest.finishSave!());
      await expect(save).toHaveText("已保存");
      await expect(save).toBeEnabled();
      await unchanged();
      await dialog.getByRole("button", { name: "简洁", exact: true }).click();
      await expect(copy).toHaveText("复制图片");
      await expect(save).toHaveText("保存图片");
      await expect(copy).toBeEnabled();
      await page.keyboard.press("Escape");
    }
  }
  expect(f.writes).toEqual([]);
  expect(f.external).toEqual([]);
  expect(f.errors).toEqual([]);
});

test.describe("模板与预览触控", () => {
  test.use({ hasTouch: true });
  test("窄窗模板、关闭和导出均有完整触控高度，不外溢或改变草稿", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 740 });
    const f = await prepare(page, "TEST 窄窗分享正文与完整末尾。");
    const dialog = await openShare(page);
    for (const name of [
      "简洁",
      "卡片",
      "纸笺",
      "关闭分享图片",
      "放大预览",
      "复制图片",
      "保存图片",
    ]) {
      const button = dialog.getByRole("button", { name, exact: true });
      const bounds = await button.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({
      path: info.outputPath("templates-coarse-narrow.png"),
    });
    await dialog.getByRole("button", { name: "关闭分享图片" }).click();
    await expect(await openInput(page)).toHaveValue(
      "TEST 分享和关闭后仍保留的未发送草稿",
    );
    expect(f.writes).toEqual([]);
    expect(f.external).toEqual([]);
    expect(f.errors).toEqual([]);
  });
});
