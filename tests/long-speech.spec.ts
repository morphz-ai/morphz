import { seedLegacyDocument } from "./center-fixtures.js";
import { openLibrary } from "./application-helpers.js";
import { test, expect, type Page } from "@playwright/test";
import { openTranscription } from "./interaction-helpers.js";
import { readSpeechWav, wavFromPCM } from "../packages/core/src/audio.js";

async function syntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(),
        oscillator = context.createOscillator(),
        destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      await context.resume();
      oscillator.start();
      Reflect.set(window, "testStream", destination.stream);
      Reflect.set(window, "testContext", context);
      return destination.stream;
    };
  });
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", segmentSeconds: 30 },
    }),
  );
}
test("持续说话超过一分钟仍在采集，自动分段有序识别，停止后保留尾段", async ({
  page,
}) => {
  test.setTimeout(100000);
  await syntheticMicrophone(page);
  let uploads = 0,
    totalSamples = 0;
  await page.route("**/api/speech/transcribe", async (route) => {
    const pcm = readSpeechWav(route.request().postDataBuffer()!);
    totalSamples += pcm.length / 2;
    expect(pcm.length).toBeLessThanOrEqual(320000);
    await route.fulfill({ json: { text: "第" + ++uploads + "段。" } });
  });
  await page.goto("/");
  const before = (await (await page.request.get("/api/workspace")).json())
    .workspace.inputs.length;
  await openTranscription(page);
  const dialog = page.getByRole("dialog", { name: "录音转文字", exact: true });
  expect(uploads).toBe(0);
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await expect(dialog.getByText("正在录音", { exact: true })).toBeVisible();
  await expect
    .poll(() => uploads, { timeout: 75000 })
    .toBeGreaterThanOrEqual(6);
  await expect
    .poll(
      async () => {
        const time = (await dialog
          .locator(".voice-recorder span")
          .textContent())!
          .split(":")
          .map(Number);
        return time[0]! * 60 + time[1]!;
      },
      { timeout: 12000 },
    )
    .toBeGreaterThanOrEqual(63);
  await expect(dialog.getByText("正在录音", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "结束录音", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "放入输入框", exact: true }),
  ).toBeEnabled();
  expect(uploads).toBeGreaterThanOrEqual(7);
  expect(totalSamples).toBeGreaterThan(16000 * 60);
  expect(await dialog.getByLabel("语音识别文字").inputValue()).toBe(
    Array.from({ length: uploads }, (_, i) => "第" + (i + 1) + "段。").join(
      "\n",
    ),
  );
  expect(
    await page.evaluate(() =>
      (Reflect.get(window, "testStream") as MediaStream)
        .getTracks()
        .every((t) => t.readyState === "ended"),
    ),
  ).toBe(true);
  await dialog.screenshot({ path: "test-results/continuous-speech.png" });
  await dialog.getByRole("button", { name: "放入输入框", exact: true }).click();
  const after = (await (await page.request.get("/api/workspace")).json())
    .workspace.inputs.length;
  expect(after).toBe(before);
  await page.evaluate(() =>
    (Reflect.get(window, "testContext") as AudioContext).close(),
  );
});

test("旧百万字 TXT 副本仍可连续朗读、暂停不预取、章节跳转与刷新恢复", async ({
  page,
}) => {
  test.setTimeout(90000);
  const source =
    "第一章 开篇\n" +
    "这是长篇小说正文，用于检验连续朗读。".repeat(60000) +
    "\n第二章 尾声\n这是全书最后一句。";
  expect(source.length).toBeGreaterThan(1000000);
  const calls: string[] = [];
  await page.route("**/api/speech/synthesize", async (route) => {
    const { text } = route.request().postDataJSON();
    calls.push(text);
    expect(text.length).toBeLessThanOrEqual(2000);
    await route.fulfill({
      contentType: "audio/wav",
      body: Buffer.from(wavFromPCM(new Uint8Array(16000))),
    });
  });
  await page.goto("/");
  await openLibrary(page);
  const boot = await (await page.request.get("/api/workspace")).json();
  const label = await page
    .locator(".library-collection")
    .getAttribute("aria-label");
  const project = boot.workspace.projects.find(
    (p: { title: string }) => label === p.title + "的内容",
  );
  await seedLegacyDocument(page, project.id, "百万字朗读.txt", source);
  await page
    .locator(".artifact-card")
    .filter({ hasText: "百万字朗读" })
    .click();
  await page.getByRole("button", { name: "朗读对象", exact: true }).click();
  const reader = page.getByRole("region", { name: "朗读对象", exact: true });
  await expect(
    reader.getByRole("button", { name: "朗读", exact: true }),
  ).toBeEnabled();
  expect(calls.length).toBe(0);
  await reader.getByRole("button", { name: "朗读内容与章节" }).click();
  await expect(reader).toContainText(source.length.toLocaleString());
  await reader.getByRole("button", { name: "朗读", exact: true }).click();
  await expect.poll(() => calls.length).toBeGreaterThanOrEqual(4);
  await reader.getByRole("button", { name: "暂停朗读", exact: true }).click();
  const pausedCalls = calls.length;
  await expect(
    reader.getByRole("button", { name: "继续朗读", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(700);
  expect(calls.length).toBe(pausedCalls);
  await reader.getByLabel("朗读章节").selectOption({ label: "第二章 尾声" });
  await expect(reader.getByLabel("朗读文字")).toHaveText(
    "第二章 尾声\n这是全书最后一句。",
  );
  await reader.getByLabel("朗读语速").selectOption("1.5");
  const index = await reader.getByLabel("朗读进度").inputValue();
  await reader.screenshot({
    path: "test-results/million-character-reading.png",
  });
  await reader.getByRole("button", { name: "关闭朗读", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "朗读对象", exact: true }).click();
  await expect(reader.getByLabel("朗读进度")).toHaveValue(index);
  await expect(reader.getByLabel("朗读语速")).toHaveValue("1.5");
  expect(calls.length).toBe(pausedCalls);
  await reader.getByRole("button", { name: "继续朗读", exact: true }).click();
  await expect(reader.getByText("已读完", { exact: false })).toBeVisible();
  expect(calls.at(-1)).toBe("第二章 尾声\n这是全书最后一句。");
});

test("长转写不被输入框截断，可完整保存为文档", async ({ page }) => {
  await syntheticMicrophone(page);
  let uploads = 0;
  await page.route("**/api/speech/transcribe", (route) => {
    uploads++;
    return route.fulfill({ json: { text: "合成转写" } });
  });
  await page.goto("/");
  await openTranscription(page);
  const dialog = page.getByRole("dialog", { name: "录音转文字", exact: true });
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await expect(dialog.getByText("正在录音", { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await dialog.getByRole("button", { name: "结束录音", exact: true }).click();
  await expect(dialog.getByLabel("语音识别文字")).toHaveValue("合成转写");
  const text = "这是完整的长语音记录。".repeat(4000);
  await dialog.getByLabel("语音识别文字").fill(text);
  await dialog.getByRole("button", { name: "放入输入框", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("文字不会被截断");
  await expect(dialog.getByLabel("语音识别文字")).toHaveValue(text);
  await dialog.getByRole("button", { name: "保存为文档", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const boot = await (await page.request.get("/api/workspace")).json();
  expect(
    boot.workspace.artifacts.some(
      (a: { content: { markdown?: string } }) => a.content.markdown === text,
    ),
  ).toBe(true);
  expect(uploads).toBe(1);
  await page.evaluate(() =>
    (Reflect.get(window, "testContext") as AudioContext).close(),
  );
});
