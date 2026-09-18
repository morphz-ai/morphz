import { test, expect, type Page } from "@playwright/test";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
type PasteFile = {
  name: string;
  text?: string;
  image?: boolean;
  size?: number;
};

async function pasteFiles(page: Page, files: PasteFile[], text = "") {
  return page.getByLabel("AI 输入内容").evaluate(
    (input, { files, text, png }) => {
      const data = new DataTransfer();
      if (text) data.setData("text/plain", text);
      for (const file of files) {
        const bytes = file.image
          ? Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
          : file.size
            ? new Uint8Array(file.size)
            : (file.text ?? "TEST 附件");
        data.items.add(
          new File([bytes], file.name, {
            type: file.image ? "image/png" : "text/plain",
          }),
        );
      }
      return !input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { files, text, png },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
});

test("粘贴多文件和图片成为当前草稿附件，不插入路径、不发送或创建内容", async ({
  page,
}) => {
  const before = await (await page.request.get("/api/workspace")).json();
  const input = page.getByLabel("AI 输入内容");
  await input.fill("保留原有文字");
  // File selection and paste use the same uploader and preview list.
  const choosing = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "附加文件", exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: "existing.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("TEST 已有"),
  });
  await expect(
    page.getByRole("button", { name: "移除附件 existing.txt" }),
  ).toBeEnabled();
  expect(
    await pasteFiles(
      page,
      [
        { name: "paste.md", text: "# TEST 粘贴文件" },
        { name: "image.png", image: true },
      ],
      "/local/paste.md\n/local/image.png",
    ),
  ).toBe(true);
  const attachments = page.getByLabel("消息附件", { exact: true });
  await expect(
    attachments.getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(3);
  await expect(input).toHaveValue("保留原有文字");
  await input.focus();
  await expect(input).toBeFocused();
  await page.reload();
  await expect(
    attachments.getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(3);
  await expect(input).toHaveValue("保留原有文字");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await expect(attachments).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(
    attachments.getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(3);
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(after.workspace.artifacts).toEqual(before.workspace.artifacts);
  await page.getByRole("button", { name: "移除附件 image.png" }).click();
  await expect(
    attachments.getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(2);
  await expect(input).toHaveValue("保留原有文字");
});

test("普通文字和路径保持原生粘贴，不下载链接或读取文件", async ({ page }) => {
  expect(
    await pasteFiles(
      page,
      [],
      "文字\nfile:///private/example.txt\nhttps://example.com/image.png",
    ),
  ).toBe(false);
  await expect(page.getByLabel("消息附件", { exact: true })).toHaveCount(0);
});

test("粘贴附件限制与文件选择一致，失败不影响原草稿或成功附件", async ({
  page,
}) => {
  const input = page.getByLabel("AI 输入内容");
  await input.fill("失败也保留");
  await pasteFiles(page, [
    { name: "large.txt", size: 20 * 1024 * 1024 + 1 },
    { name: "valid.txt" },
  ]);
  await expect(page.getByRole("alert")).toContainText("20 MB");
  await expect(
    page.getByRole("button", { name: "移除附件 valid.txt" }),
  ).toBeEnabled();
  await expect(input).toHaveValue("失败也保留");
  await pasteFiles(
    page,
    Array.from({ length: 8 }, (_, i) => ({ name: `overflow-${i}.txt` })),
  );
  await expect(page.getByRole("alert")).toContainText("最多附加 8 个文件");
  await expect(
    page
      .getByLabel("消息附件", { exact: true })
      .getByRole("button", { name: /^移除附件/ }),
  ).toHaveCount(1);
});

test("上传中再次粘贴有明确提示，迟到附件不会进入切换后的草稿", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/attachments", async (route) => {
    await gate;
    await route.continue();
  });
  const request = page.waitForRequest("**/api/attachments");
  await pasteFiles(page, [{ name: "slow.txt" }]);
  await request;
  await pasteFiles(page, [{ name: "retry.txt" }]);
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
    page.getByRole("button", { name: "移除附件 slow.txt" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "移除附件 retry.txt" }),
  ).toHaveCount(0);
});
