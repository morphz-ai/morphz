import { test, expect } from "@playwright/test";
import { openLibrary } from "./application-helpers.js";
import { openInput } from "./interaction-helpers.js";
import { seedLibraryArtifact } from "./artifact-fixtures.js";

test("选区批注使用同一输入但不发送 Agent；对象交流可以切回完整历史", async ({
  page,
}) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "选区验收", {
    kind: "document",
    markdown: "这段合成正文用于验证选区操作。",
  });
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.locator(".document-body p").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page
    .getByRole("toolbar", { name: "选中文本操作" })
    .getByRole("button", { name: "批注", exact: true })
    .click();
  await expect(page.getByText("保存为批注", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent 未连接", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "截图输入", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "附加文件", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("AI 输入内容").fill("这是我自己的批注。");
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect(page.locator(".annotation")).toContainText("这是我自己的批注。");
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs.length).toBe(before.workspace.inputs.length);
  expect(after.workspace.annotations.length).toBe(
    before.workspace.annotations.length + 1,
  );
  await openInput(page);
  await expect(
    page.getByRole("button", { name: "查看全部交流" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看全部交流" }).click();
  await expect(
    page.getByRole("button", { name: "仅看当前对象的交流" }),
  ).toBeVisible();
});

test("截图默认附加到消息，发送前后均不创建内容对象", async ({ page }) => {
  await page.addInitScript(() =>
    Reflect.set(window, "morphzDesktop", {
      capture: {
        select: async () => ({
          mime: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKp8AAAAASUVORK5CYII=",
        }),
        cancel: async () => {},
      },
    }),
  );
  await page.goto("/");
  await openInput(page);
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "截图输入" });
  await dialog.getByRole("button", { name: "添加到消息", exact: true }).click();
  await expect(page.getByLabel("消息附件", { exact: true })).toBeVisible();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  const middle = await page.request.get("/api/workspace").then((r) => r.json());
  expect(middle.workspace.artifacts.length).toBe(
    before.workspace.artifacts.length,
  );
  expect(middle.workspace.inputs.length).toBe(before.workspace.inputs.length);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.request.get("/api/workspace").then((r) => r.json()))
          .workspace.inputs.length,
    )
    .toBe(before.workspace.inputs.length + 1);
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs.at(-1).attachments).toHaveLength(1);
  expect(after.workspace.artifacts.length).toBe(
    before.workspace.artifacts.length,
  );
});

test("首次授权后听写直接在输入框内追加，停止立即停采且不自动发送", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(),
        oscillator = context.createOscillator(),
        destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      await context.resume();
      oscillator.start();
      Reflect.set(window, "uxStream", destination.stream);
      Reflect.set(window, "uxAudio", context);
      return destination.stream;
    };
  });
  await page.route("**/api/speech/status", (r) =>
    r.fulfill({
      json: {
        configured: true,
        provider: "doubao",
        segmentSeconds: 30,
        streaming: true,
      },
    }),
  );
  let uploads = 0;
  let finished = false;
  await page.route("**/api/speech/stream", async (r) => {
    const { id, action } = r.request().postDataJSON();
    if (action === "push") uploads++;
    if (action === "finish") finished = true;
    if (action === "read")
      await new Promise((resolve) => setTimeout(resolve, 100));
    return r.fulfill({
      json: {
        id,
        revision: uploads + (finished ? 1 : 0),
        text: finished ? "合成听写内容" : uploads ? "合成听写" : "",
        status:
          action === "cancel"
            ? "cancelled"
            : finished
              ? "complete"
              : "listening",
      },
    });
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("已有草稿");
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  const consent = page.getByRole("dialog", { name: "语音输入授权" });
  await expect(consent).toContainText("豆包");
  expect(uploads).toBe(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "uxStream")),
  ).toBeUndefined();
  await consent.getByRole("button", { name: "允许并开始听写" }).click();
  const voice = page.getByRole("region", { name: "听写", exact: true });
  await expect(voice).toBeVisible();
  await expect.poll(() => uploads).toBeGreaterThan(0);
  await expect(input).toHaveValue("已有草稿\n合成听写");
  await expect(voice).toHaveAttribute("data-recording", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "uxAudio")?.currentTime ?? 0),
    )
    .toBeGreaterThan(0.5);
  await voice.getByRole("button", { name: "停止听写", exact: true }).click();
  await expect(input).toHaveValue("已有草稿\n合成听写内容");
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "uxStream")
        .getTracks()
        .every((t: MediaStreamTrack) => t.readyState === "ended"),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(voice).toHaveCount(0);
  await expect(input).toHaveValue("已有草稿\n合成听写内容");
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs.length).toBe(before.workspace.inputs.length);
  await page.evaluate(() => Reflect.get(window, "uxAudio").close());
});
