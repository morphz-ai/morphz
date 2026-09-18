import { test, expect, type Page } from "@playwright/test";
import { openTranscription, openInput } from "./interaction-helpers.js";

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
      json: {
        configured: true,
        provider: "doubao",
        segmentSeconds: 30,
        streaming: true,
      },
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

// Empty-audio protocol errors are normalized by asrResponse (speech.test.ts).
// Here verify the normalized stream, preserving the original draft/failure checks.
test("流式听写空结果有反馈且不覆盖草稿，失败后可重新开始", async ({ page }) => {
  await syntheticMicrophone(page);
  let uploads = 0;
  let releaseEmpty!: () => void;
  const pendingEmpty = new Promise<void>((resolve) => (releaseEmpty = resolve));
  const streams = new Map<
    string,
    {
      attempt: number;
      id: string;
      text: string;
      status: string;
      revision: number;
    }
  >();
  await page.route("**/api/speech/stream", async (route) => {
    const { id, action } = route.request().postDataJSON();
    if (action === "open")
      streams.set(id, {
        attempt: ++uploads,
        id,
        text: "",
        status: "listening",
        revision: 0,
      });
    const stream = streams.get(id)!;
    if (action === "push" && [1, 4].includes(stream.attempt)) {
      stream.text = "合成识别结果";
      stream.revision++;
    }
    if (action === "finish" && stream.attempt === 2) await pendingEmpty;
    if (action === "finish" && stream.attempt === 3)
      return route.fulfill({
        status: 503,
        json: { message: "语音服务暂时不可用" },
      });
    if (action === "finish") {
      stream.status = "complete";
      stream.revision++;
    }
    if (action === "cancel") {
      stream.status = "cancelled";
      stream.revision++;
    }
    if (action === "read")
      await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ json: stream });
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("保留已有草稿");
  const before = await page.request.get("/api/workspace").then((r) => r.json());
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await page
    .getByRole("button", { name: "允许并开始听写", exact: true })
    .click();
  const voice = page.getByRole("region", { name: "听写", exact: true });
  const empty = voice.getByText("未识别到文字，可重新听写", { exact: true });
  await expect(empty).toHaveCount(0);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0)
      await voice
        .getByRole("button", { name: "开始听写", exact: true })
        .click();
    await expect(empty).toHaveCount(0);
    await waitForSamples(page);
    await voice.getByRole("button", { name: "停止听写", exact: true }).click();
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
      await expect(voice).toContainText("正在结束听写");
      await expect(empty).toHaveCount(0);
      releaseEmpty();
      await expect(empty).toBeVisible();
      await expect(input).toHaveValue("保留已有草稿\n合成识别结果");
      await voice.screenshot({
        path: "test-results/dictation-empty-stream.png",
      });
    } else {
      await expect(voice.getByRole("alert")).toContainText(
        "语音服务暂时不可用",
      );
      await expect(empty).toHaveCount(0);
      await page.evaluate(() => Reflect.get(window, "feedbackAudio").close());
      await voice
        .getByRole("button", { name: "开始听写", exact: true })
        .click();
      await waitForSamples(page);
      await expect(input).toHaveValue(
        "保留已有草稿\n合成识别结果\n合成识别结果",
      );
      await expect(voice.getByRole("alert")).toHaveCount(0);
      await voice
        .getByRole("button", { name: "停止听写", exact: true })
        .click();
      await expect(voice).toContainText("听写已停止");
    }
    await page.evaluate(() => Reflect.get(window, "feedbackAudio").close());
  }
  await voice.getByRole("button", { name: "关闭听写", exact: true }).click();
  await expect(input).toHaveValue("保留已有草稿\n合成识别结果\n合成识别结果");
  const after = await page.request.get("/api/workspace").then((r) => r.json());
  expect(after.workspace.inputs.length).toBe(before.workspace.inputs.length);
  expect(uploads).toBe(4);
});

test("长录音空结果在现有状态位置说明，不启用空文字保存", async ({ page }) => {
  await syntheticMicrophone(page);
  await page.route("**/api/speech/transcribe", (route) =>
    route.fulfill({ json: { text: "" } }),
  );
  await page.goto("/");
  await openInput(page);
  await openTranscription(page);
  const dialog = page.getByRole("dialog", { name: "录音转文字", exact: true });
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
