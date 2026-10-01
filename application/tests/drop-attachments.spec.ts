import { test, expect, type Page } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
type DroppedFile = { name: string; image?: boolean; size?: number };

async function dragFiles(
  page: Page,
  files: DroppedFile[],
  options: {
    event?: "dragenter" | "dragover" | "dragleave" | "drop";
    target?: "input" | "button" | "outside";
    text?: string;
    directory?: boolean;
  } = {},
) {
  const target =
    options.target === "outside"
      ? page.locator(".primary-panel > main")
      : options.target === "button"
        ? page.getByRole("button", { name: "添加输入内容", exact: true })
        : page.getByLabel("AI 输入内容");
  return target.evaluate(
    (element, { files, options, png }) => {
      const data = new DataTransfer();
      if (options.text) data.setData("text/plain", options.text);
      for (const file of files) {
        const bytes = file.image
          ? Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
          : file.size
            ? new Uint8Array(file.size)
            : "TEST 拖入附件";
        data.items.add(
          new File([bytes], file.name, {
            type: file.image ? "image/png" : "text/plain",
          }),
        );
      }
      const event = new DragEvent(options.event ?? "drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      });
      const entry = Object.getOwnPropertyDescriptor(
        DataTransferItem.prototype,
        "webkitGetAsEntry",
      );
      if (options.directory)
        Object.defineProperty(DataTransferItem.prototype, "webkitGetAsEntry", {
          configurable: true,
          value: () => ({ isDirectory: true }),
        });
      try {
        return !element.dispatchEvent(event);
      } finally {
        if (options.directory && entry)
          Object.defineProperty(
            DataTransferItem.prototype,
            "webkitGetAsEntry",
            entry,
          );
      }
    },
    { files, options, png },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
});

test("仅输入框接收文件拖入；提示只在拖入期间出现，附件不发送也不创建内容", async ({
  page,
}) => {
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const before = await source.contentCounts();
  const submitted: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/platform/messages"
    )
      submitted.push(request.url());
  });
  const input = page.getByLabel("AI 输入内容");
  const composer = page.locator(".composer");
  await input.fill("TEST 原文字保留");
  const files = [
    { name: "TEST-drop.txt" },
    { name: "TEST-image.png", image: true },
  ];
  expect(await dragFiles(page, files, { event: "dragenter" })).toBe(true);
  await expect(composer).toHaveAttribute("data-file-drop", "ready");
  expect(await dragFiles(page, files, { event: "dragover" })).toBe(true);
  await dragFiles(page, files, { event: "dragenter", target: "button" });
  await dragFiles(page, files, { event: "dragleave" });
  await expect(composer).toHaveAttribute("data-file-drop", "ready");
  await dragFiles(page, files, { event: "dragleave", target: "button" });
  await expect(composer).not.toHaveAttribute("data-file-drop");
  expect(await dragFiles(page, files, { target: "outside" })).toBe(false);
  await expect(page.getByLabel("消息附件", { exact: true })).toHaveCount(0);
  await dragFiles(page, files, { event: "dragenter" });
  expect(
    await dragFiles(page, files, { text: "file:///private/TEST-drop.txt" }),
  ).toBe(true);
  await expect(composer).not.toHaveAttribute("data-file-drop");
  const attachments = page.getByLabel("消息附件", { exact: true });
  await expect(
    attachments.getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(2);
  await expect(input).toHaveValue("TEST 原文字保留");
  await expect(input).toBeFocused();
  await page.reload();
  await expect(
    attachments.getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(2);
  await expect(input).toHaveValue("TEST 原文字保留");
  await page.getByRole("button", { name: "移除附件 TEST-image.png" }).click();
  await expect(
    attachments.getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(1);
  expect(await source.contentCounts()).toEqual(before);
  expect(submitted).toEqual([]);
});

test("文字、路径和URL拖动保留原生行为，文件夹不递归读取", async ({ page }) => {
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/attachments"
    )
      uploads.push(request.url());
  });
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 未改动文字");
  for (const event of ["dragenter", "dragover", "drop"] as const) {
    expect(
      await dragFiles(page, [], {
        event,
        text: "文字\nfile:///private/example.txt\nhttps://example.com/image.png",
      }),
    ).toBe(false);
    await expect(page.locator(".composer")).not.toHaveAttribute(
      "data-file-drop",
    );
  }
  expect(
    await dragFiles(page, [{ name: "TEST-folder" }], { directory: true }),
  ).toBe(true);
  await expect(page.getByRole("alert")).toContainText("不支持文件夹");
  await expect(page.getByLabel("消息附件", { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue("TEST 未改动文字");
  expect(uploads).toEqual([]);
});

test("拖入沿用大小和8个附件限制，失败不丢成功附件或文字", async ({ page }) => {
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/attachments"
    )
      uploads.push(request.url());
  });
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 超限仍保留");
  await dragFiles(page, [
    { name: "TEST-large.txt", size: 20 * 1024 * 1024 + 1 },
    { name: "TEST-valid.txt" },
  ]);
  await expect(page.getByRole("alert")).toContainText("20 MB");
  await expect(
    page.getByRole("button", { name: "移除附件 TEST-valid.txt" }),
  ).toBeEnabled();
  expect(uploads).toHaveLength(1);
  await dragFiles(
    page,
    Array.from({ length: 8 }, (_, i) => ({ name: `TEST-overflow-${i}.txt` })),
  );
  await expect(page.getByRole("alert")).toContainText("最多附加 8 个文件");
  expect(uploads).toHaveLength(1);
  await expect(input).toHaveValue("TEST 超限仍保留");
});

test("上传失败显示真实错误，批次中成功文件仍可预览移除", async ({ page }) => {
  let attempt = 0;
  await page.route("**/api/attachments", async (route) => {
    if (++attempt === 1)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "unavailable",
          message: "TEST 上传不可用",
        }),
      });
    else await route.continue();
  });
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 上传失败保留");
  await dragFiles(page, [
    { name: "TEST-failed.txt" },
    { name: "TEST-success.txt" },
  ]);
  await expect(page.getByRole("alert")).toContainText("TEST-failed.txt");
  await expect(
    page.getByRole("button", { name: "移除附件 TEST-success.txt" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "移除附件 TEST-failed.txt" }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("TEST 上传失败保留");
});

test("上传中重复拖入不会新增上传；切换场景后迟到附件仍归原草稿", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploads = 0;
  await page.route("**/api/attachments", async (route) => {
    uploads++;
    await gate;
    await route.continue();
  });
  const request = page.waitForRequest("**/api/attachments");
  await page.getByLabel("AI 输入内容").fill("TEST 原范围草稿");
  await dragFiles(page, [{ name: "TEST-slow.txt" }]);
  await request;
  await dragFiles(page, [{ name: "TEST-retry.txt" }], { event: "dragenter" });
  await expect(page.locator(".composer")).not.toHaveAttribute("data-file-drop");
  await dragFiles(page, [{ name: "TEST-retry.txt" }]);
  await expect(page.getByRole("alert")).toContainText("请稍后再添加附件");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  release();
  await expect(page.getByLabel("消息附件", { exact: true })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "移除附件 TEST-slow.txt" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "移除附件 TEST-retry.txt" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("TEST 原范围草稿");
  expect(uploads).toBe(1);
});
