import { test, expect, type Page } from "@playwright/test";
import { composerAction, openInput } from "./interaction-helpers.js";

async function syntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      await context.resume();
      oscillator.start();
      Reflect.set(window, "feedbackAudio", context);
      Reflect.set(window, "feedbackStream", destination.stream);
      return destination.stream;
    };
  });
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", segmentSeconds: 30 },
    }),
  );
}

async function waitForSamples(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "feedbackAudio").currentTime),
    )
    .toBeGreaterThan(0.5);
}

for (const emptyResponse of ["empty text", "no speech error"] as const) {
  test(`听写空结果有反馈且不覆盖草稿、失败与重试：${emptyResponse}`, async ({
    page,
  }) => {
    await syntheticMicrophone(page);
    let uploads = 0;
    let releaseEmpty!: () => void;
    const pendingEmpty = new Promise<void>(
      (resolve) => (releaseEmpty = resolve),
    );
    await page.route("**/api/speech/transcribe", async (route) => {
      uploads++;
      if (uploads === 2) {
        await pendingEmpty;
        return emptyResponse === "empty text"
          ? route.fulfill({ json: { text: "" } })
          : route.fulfill({ status: 422, json: { message: "没有识别到语音" } });
      }
      if (uploads === 3)
        return route.fulfill({
          status: 503,
          json: { message: "语音服务暂时不可用" },
        });
      await route.fulfill({ json: { text: "合成识别结果" } });
    });
    await page.goto("/");
    const input = await openInput(page);
    await input.fill("保留已有草稿");
    const before = await page.request
      .get("/api/workspace")
      .then((r) => r.json());
    await page.getByRole("button", { name: "语音输入", exact: true }).click();
    const voice = page.getByRole("region", { name: "听写", exact: true });
    const empty = voice.getByText("未识别到文字，可重新听写", { exact: true });
    await expect(empty).toHaveCount(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      await voice
        .getByRole("button", { name: "开始听写", exact: true })
        .click();
      await expect(empty).toHaveCount(0);
      await waitForSamples(page);
      await voice
        .getByRole("button", { name: "停止听写", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            Reflect.get(window, "feedbackStream")
              .getTracks()
              .every((t: MediaStreamTrack) => t.readyState === "ended"),
          ),
        )
        .toBe(true);
      if (attempt === 0) {
        await expect(input).toHaveValue("保留已有草稿\n合成识别结果");
        await expect(empty).toHaveCount(0);
      } else if (attempt === 1) {
        await expect.poll(() => uploads).toBe(2);
        await expect(voice).toContainText("正在识别 1 段");
        await expect(empty).toHaveCount(0);
        releaseEmpty();
        await expect(empty).toBeVisible();
        await expect(input).toHaveValue("保留已有草稿\n合成识别结果");
        await voice.screenshot({
          path: `test-results/dictation-${emptyResponse.replaceAll(" ", "-")}.png`,
        });
      } else {
        await expect(voice.getByRole("alert")).toContainText(
          "语音服务暂时不可用",
        );
        await expect(empty).toHaveCount(0);
        await voice
          .getByRole("button", { name: "重试识别", exact: true })
          .click();
        await expect(input).toHaveValue(
          "保留已有草稿\n合成识别结果\n合成识别结果",
        );
        await expect(voice.getByRole("alert")).toHaveCount(0);
      }
      await page.evaluate(() => Reflect.get(window, "feedbackAudio").close());
    }
    await voice.getByRole("button", { name: "关闭听写", exact: true }).click();
    await expect(input).toHaveValue("保留已有草稿\n合成识别结果\n合成识别结果");
    const after = await page.request
      .get("/api/workspace")
      .then((r) => r.json());
    expect(after.workspace.inputs.length).toBe(before.workspace.inputs.length);
    expect(uploads).toBe(4);
  });
}

test("长录音空结果在现有状态位置说明，不启用空文字保存", async ({ page }) => {
  await syntheticMicrophone(page);
  await page.route("**/api/speech/transcribe", (route) =>
    route.fulfill({ json: { text: "" } }),
  );
  await page.goto("/");
  await openInput(page);
  await composerAction(page, "长录音转写");
  const dialog = page.getByRole("dialog", { name: "语音输入", exact: true });
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await waitForSamples(page);
  await dialog.getByRole("button", { name: "结束录音", exact: true }).click();
  await expect(dialog).toContainText("未识别到文字，可重新录音");
  await expect(
    dialog.getByRole("button", { name: "保存为文档", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "放入输入框", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => Reflect.get(window, "feedbackAudio").close());
});
