import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { openInput } from "./interaction-helpers.js";

const platform = () =>
  PlatformClient.connect(new HttpApplicationClient("http://127.0.0.1:65421"));

const deliveryIds = async (source: PlatformClient) =>
  (await source.navigationRuntime()).runtime.deliveries.map(
    (delivery) => delivery.inputId,
  );

test("选区批注使用同一输入但不发送 Agent；对象交流可以切回完整历史", async ({
  page,
}) => {
  const source = await platform();
  const suffix = randomUUID().replaceAll("-", "");
  const title = `TEST 选区验收 ${suffix}`;
  const projectId = `annotation_${suffix}`;
  await source.createProject(
    `TEST 批注项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  const created = (await source.createDocument({
    commandId: randomUUID(),
    objectId: `document_${suffix}`,
    projectId,
    title,
    markdown: "这段合成正文用于验证选区操作。",
  })) as { contentId: string };
  const beforeDeliveries = await deliveryIds(source);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page.getByRole("textbox", { name: "搜索内容" }).fill(title);
  await page.getByRole("button", { name: `打开内容：${title}` }).click();
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
  expect(await deliveryIds(source)).toEqual(beforeDeliveries);
  const annotations = (await source.listObjectAnnotations(
    created.contentId,
  )) as Array<{ annotation: { body: string } }>;
  expect(annotations).toHaveLength(1);
  expect(annotations[0]?.annotation.body).toBe("这是我自己的批注。");
  await openInput(page);
  await expect(
    page.getByRole("button", { name: "查看全部交流" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看全部交流" }).click();
  await expect(
    page.getByRole("button", { name: "仅看当前对象的交流" }),
  ).toBeVisible();
});

test("截图附加后保存为未发送消息，不创建内容对象", async ({ page }) => {
  const source = await platform();
  const beforeContent = await source.contentCounts();
  const beforeDeliveries = await deliveryIds(source);
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
  // This case tests an ordinary screenshot message, independent of any book
  // or application restored by earlier tests in the same server.
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  await page.getByRole("button", { name: "截图输入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "截图输入" });
  await dialog.getByRole("button", { name: "添加到消息", exact: true }).click();
  await expect(page.getByLabel("消息附件", { exact: true })).toBeVisible();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  expect(await source.contentCounts()).toEqual(beforeContent);
  expect(await deliveryIds(source)).toEqual(beforeDeliveries);
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(page.locator(".human-message")).toContainText("未发送");
  await expect(page.locator(".human-message .message-attachments")).toHaveCount(
    1,
  );
  await page.reload();
  await expect(page.locator(".human-message .message-attachments")).toHaveCount(
    1,
  );
  expect(await source.contentCounts()).toEqual(beforeContent);
  expect(await deliveryIds(source)).toEqual(beforeDeliveries);
});

test("首次授权后听写直接在输入框内追加，停止立即停采且不自动发送", async ({
  page,
}) => {
  const source = await platform();
  const beforeDeliveries = await deliveryIds(source);
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
  expect(await deliveryIds(source)).toEqual(beforeDeliveries);
  await page.evaluate(() => Reflect.get(window, "uxAudio").close());
});
