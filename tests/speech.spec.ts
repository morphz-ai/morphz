import { composerAction, openTranscription } from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";
import { test, expect } from "@playwright/test";
import { readSpeechWav, wavFromPCM } from "../packages/core/src/audio.js";

test("明确开始后分段识别，结束停止采集，文字确认后保留对象批注范围", async ({
  page,
}) => {
  // Synthetic oscillator, not a real microphone or user recording.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        const context = new AudioContext(),
          oscillator = context.createOscillator(),
          destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        await context.resume();
        oscillator.start();
        Reflect.set(window, "syntheticStream", destination.stream);
        Reflect.set(window, "syntheticContext", context);
        return destination.stream;
      },
    });
  });
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", segmentSeconds: 30 },
    }),
  );
  let uploads = 0;
  await page.route("**/api/speech/transcribe", async (route) => {
    uploads++;
    expect(route.request().headers()["x-artifact-revision"]).toBe("2");
    const pcm = readSpeechWav(route.request().postDataBuffer()!);
    expect(pcm.length).toBeGreaterThan(0);
    await route.fulfill({ json: { text: "这是合成的语音批注。" } });
  });
  await page.goto("/");
  await openLibrary(page);
  await page.getByLabel("其他内容创作", { exact: true }).click();
  await page.getByRole("button", { name: "手动写文档", exact: true }).click();
  await page.getByLabel("新对象标题").fill("语音范围测试");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("文档正文").fill("用这段正文测试语音批注。");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await page.locator(".document-body p").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
  });
  await page.getByRole("button", { name: "围绕选中文本输入" }).click();
  // Opening this standalone content tool is outside the composer. Keep the
  // input pinned here so its unchanged draft can also be checked underneath.
  await composerAction(page, "固定输入框");
  await openTranscription(page);
  const dialog = page.getByRole("dialog", { name: "录音转文字", exact: true });
  await expect(dialog).toContainText("v2");
  expect(uploads).toBe(0);
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await expect(dialog).toContainText("正在录音");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Reflect.get(window, "syntheticContext") as AudioContext).currentTime,
      ),
    )
    .toBeGreaterThan(0.5);
  await expect
    .poll(async () =>
      Number(
        (await dialog.locator(".voice-recorder span").textContent())!.split(
          ":",
        )[1],
      ),
    )
    .toBeGreaterThanOrEqual(1);
  await dialog.getByRole("button", { name: "结束录音", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, "syntheticStream") as MediaStream)
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await expect(dialog.getByLabel("语音识别文字")).toHaveValue(
    "这是合成的语音批注。",
  );
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await dialog.getByLabel("语音识别文字").fill("确认后的语音批注。");
  await dialog.getByRole("button", { name: "放入输入框", exact: true }).click();
  expect(uploads).toBe(1);
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "确认后的语音批注。",
  );
  await composerAction(page, "保存为批注");
  await expect(page.locator(".annotation")).toContainText("确认后的语音批注。");
  await expect(page.locator(".annotation")).toContainText("v2");
  await expect(page.getByLabel("AI 输入内容")).toBeVisible();
  await expect(page.getByLabel("AI 输入内容")).toBeFocused();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await openTranscription(page);
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await expect(dialog).toContainText("正在录音");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Reflect.get(window, "syntheticStream") as MediaStream)
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  expect(uploads).toBe(1);
  await page.evaluate(() =>
    (Reflect.get(window, "syntheticContext") as AudioContext).close(),
  );
});

test("朗读不会自动请求，取消后可关闭且不修改对象", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/speech/synthesize", async (route) => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({
      text: "用于朗读的测试正文。",
    });
    await route.fulfill({
      contentType: "audio/wav",
      body: Buffer.from(wavFromPCM(new Uint8Array(32000))),
    });
  });
  await page.goto("/");
  await openLibrary(page);
  await page.getByLabel("其他内容创作", { exact: true }).click();
  await page.getByRole("button", { name: "手动写文档", exact: true }).click();
  await page.getByLabel("新对象标题").fill("朗读测试");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("文档正文").fill("用于朗读的测试正文。");
  await page.getByRole("button", { name: "保存版本", exact: true }).click();
  await page.getByRole("button", { name: "朗读对象", exact: true }).click();
  const dialog = page.getByRole("region", { name: "朗读对象", exact: true });
  await dialog.getByRole("button", { name: "朗读内容与章节" }).click();
  await expect(dialog.getByLabel("朗读文字")).toHaveText(
    "用于朗读的测试正文。",
  );
  expect(calls).toBe(0);
  await dialog.screenshot({ path: "test-results/read-aloud.png" });
  await dialog.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "停止朗读", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "停止朗读", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭朗读", exact: true }).click();
  expect(calls).toBe(1);
  await expect(page.locator(".object-toolbar")).toContainText("v2");
});
