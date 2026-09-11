/** Explicit, billable live speech acceptance. Uses a previously synthesized WAV,
 * never the user's microphone, through Chromium's real AudioWorklet pipeline. */
import { _electron, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { SpeechService } from "../apps/service/src/speech.js";
import { loadServiceEnvironment } from "../apps/service/src/environment.js";
import { readSpeechWav } from "../packages/core/src/audio.js";
import { localAccess } from "../packages/core/src/model.js";

const input = process.argv
  .find((arg) => arg.startsWith("--synthetic-wav="))
  ?.slice(16);
assert.ok(
  input,
  "Specify --synthetic-wav=<absolute synthesized WAV path>; never use personal audio.",
);
const source = resolve(input);
const asrOnly = process.argv.includes("--asr-only");
const longReading = process.argv.includes("--long-reading");
assert.equal(source, input, "Synthetic fixture path must be absolute");
const pcm = readSpeechWav(readFileSync(source));
assert.ok(pcm.length > 0 && pcm.length < 32000 * 10);
loadServiceEnvironment();
const speech = new SpeechService(process.env.DOUBAO_API_KEY);
assert.ok(
  speech.configured(),
  "A server-side Doubao Plan credential is required",
);
const directory = mkdtempSync(join(tmpdir(), "morphzwork-native-speech-"));
const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
const artifactId = store.execute(
  {
    commandId: randomUUID(),
    operation: {
      type: "create-artifact",
      projectId: "first-project",
      title: "桌面语音验收",
      content: {
        kind: "document",
        markdown: "你好，这是一段合成语音，用于测试语音输入。".repeat(
          longReading ? 18 : 1,
        ),
      },
    },
  },
  localAccess,
).entityId;
const server = createAppServer(store, {
  port: 65423,
  webRoot: resolve("dist/web"),
  speech,
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(65423, "127.0.0.1", resolve);
});
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let stage = "launch";
try {
  app = await _electron.launch({
    args: [
      "apps/desktop/main.cjs",
      "--center=http://127.0.0.1:65423",
      "--use-fake-device-for-media-stream",
    ],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      MORPHZWORK_TEST_PROFILE: join(directory, "profile"),
      MORPHZWORK_ENV_FILE: "",
    },
  });
  const ui = await app.firstWindow();
  ui.setDefaultTimeout(20000);
  await ui.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await ui.evaluate(
    async (wav) => {
      const audio = new AudioContext();
      const buffer = await audio.decodeAudioData(new Uint8Array(wav).buffer);
      const get = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await get(constraints);
        // Fail closed if Chromium did not bind the synthetic device; no real audio upload.
        if (
          stream.getAudioTracks().some((track) => !/fake/i.test(track.label))
        ) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error(
            "Synthetic input device unavailable; live microphone forbidden in this test",
          );
        }
        // Chromium's fake device can emit its built-in tone instead of a supplied
        // WAV. Use explicit synthetic WebAudio as AudioWorklet input, preserving
        // the real desktop permission handshake without sampling live hardware.
        stream.getTracks().forEach((track) => track.stop());
        const destination = audio.createMediaStreamDestination();
        const sample = audio.createBufferSource();
        sample.buffer = buffer;
        sample.loop = true;
        sample.connect(destination);
        await audio.resume();
        sample.start();
        (window as any).__speechTracks = destination.stream.getTracks();
        (window as any).__stopSpeechFixture = () => {
          sample.stop();
          void audio.close();
        };
        return destination.stream;
      };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        (window as any).__speechPlayback = this;
        return play.call(this);
      };
    },
    [...readFileSync(source)],
  );
  await ui
    .getByRole("button")
    .filter({ hasText: "桌面语音验收" })
    .first()
    .click();
  if (!asrOnly) {
    stage = "tts";
    await ui.getByRole("button", { name: "朗读对象", exact: true }).click();
    const reader = ui.getByRole("dialog", { name: "朗读对象", exact: true });
    console.log(
      "Live desktop speech: synthesizing a short fixture sentence through the real service.",
    );
    await reader.getByRole("button", { name: "朗读", exact: true }).click();
    await expect(
      reader.getByRole("button", { name: "停止朗读", exact: true }),
    ).toBeVisible({ timeout: 70000 });
    await expect
      .poll(
        () =>
          ui.evaluate(() => (window as any).__speechPlayback?.currentTime ?? 0),
        { timeout: 70000 },
      )
      .toBeGreaterThan(0.1);
    await reader.getByRole("button", { name: "停止朗读", exact: true }).click();
    assert.equal(
      await ui.evaluate(() => (window as any).__speechPlayback.paused),
      true,
    );
    await reader.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(store.snapshot().artifacts[0]!.revision, 1);
    console.log(
      "PASS: real Doubao TTS -> native audio playback progressed -> explicit stop; object unchanged.",
    );
  }
  stage = "recording";
  await ui.locator(".document-body p").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await ui.getByRole("button", { name: "围绕选中文本输入" }).click();
  await ui.getByRole("button", { name: "语音输入", exact: true }).click();
  const recorder = ui.getByRole("dialog", { name: "语音输入", exact: true });
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0]!.focus();
  });
  await recorder.getByRole("button", { name: "开始录音", exact: true }).click();
  await expect(recorder.getByText("正在录音", { exact: true })).toBeVisible();
  await expect(recorder.getByText("00:06", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await recorder.getByRole("button", { name: "结束录音", exact: true }).click();
  await ui.evaluate(() => (window as any).__stopSpeechFixture());
  assert.equal(
    await ui.evaluate(() =>
      (window as any).__speechTracks.every(
        (t: MediaStreamTrack) => t.readyState === "ended",
      ),
    ),
    true,
  );
  stage = "transcribing";
  await expect(recorder.getByLabel("语音识别文字")).toHaveValue(/语音/, {
    timeout: 100000,
  });
  const transcript = await recorder.getByLabel("语音识别文字").inputValue();
  stage = "annotation";
  assert.equal(store.snapshot().inputs.length, 0);
  await recorder
    .getByRole("button", { name: "放入输入框", exact: true })
    .click();
  await expect(ui.getByLabel("AI 输入内容")).toHaveValue(transcript);
  await ui.locator(".composer-floating-tools").hover();
  await ui.getByRole("button", { name: "保存为批注", exact: true }).click();
  await expect(ui.locator(".annotation")).toContainText(transcript);
  await expect(ui.locator(".annotation")).toContainText("v1");
  assert.equal(store.snapshot().annotations[0]!.artifactId, artifactId);
  assert.equal(store.snapshot().inputs.length, 0);
  await ui.screenshot({
    path: join(directory, "desktop-voice-annotation.png"),
  });
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({
      tts: asrOnly ? "not-run" : "passed",
      asr: "passed",
      nativePlaybackStop: !asrOnly,
      source: "synthetic WebAudio fixture",
      syntheticAudioWorklet: true,
      microphoneUsed: false,
      annotationVersion: 1,
      transcript,
    }),
    { mode: 0o600 },
  );
  console.log(
    "PASS: synthetic device -> native AudioWorklet -> real Doubao ASR -> confirmed v1 object annotation; no Agent input.",
  );
} catch (error) {
  const ui = app?.windows()[0];
  writeFileSync(
    join(directory, "failure.json"),
    JSON.stringify({
      stage,
      message: error instanceof Error ? error.message : "Test failed",
      ui: ui
        ? await ui
            .locator("body")
            .innerText()
            .catch(() => "")
        : "",
    }),
    { mode: 0o600 },
  );
  await ui
    ?.screenshot({ path: join(directory, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  console.log("Native speech fixture:", directory);
}
