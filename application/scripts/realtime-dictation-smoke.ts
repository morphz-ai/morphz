/** Billable live-provider acceptance using generated audio only, never ambient audio.
 * --native additionally exercises production Electron IPC + AudioWorklet in an isolated automated fixture.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect } from "@playwright/test";
import { loadServiceEnvironment } from "../packages/application/src/environment.js";
import { SpeechService } from "../packages/application/src/speech.js";
import { readSpeechWav } from "../packages/core/src/audio.js";

loadServiceEnvironment();
const speech = new SpeechService(process.env.DOUBAO_API_KEY);
assert.ok(speech.configured(), "A server-side Doubao credential is required");
const directory = mkdtempSync(join(tmpdir(), "morphz-realtime-acceptance-"));
const sentence =
  "你好，现在测试实时语音输入。说话的时候，文字应该出现在输入框里，不需要等待停止。";
const fixturePath = process.argv
  .find((arg) => arg.startsWith("--synthetic-wav="))
  ?.slice(16);
const wav = fixturePath
  ? readFileSync(fixturePath)
  : await speech.synthesize(
      "synthetic-fixture",
      sentence,
      AbortSignal.timeout(60000),
    );
writeFileSync(join(directory, "synthetic.wav"), wav);
const pcm = readSpeechWav(wav);
const started = performance.now();
let firstTextMs: number | undefined,
  finalText = "",
  final = false,
  failed = "";
const stream = speech.openStream(
  "synthetic-fixture",
  (text, complete) => {
    if (text && firstTextMs === undefined)
      firstTextMs = Math.round(performance.now() - started);
    finalText = text;
    final = complete;
    console.log(
      JSON.stringify({
        event: complete ? "final" : "partial",
        elapsedMs: Math.round(performance.now() - started),
        text,
      }),
    );
  },
  (message) => {
    failed = message;
  },
);
try {
  await stream.ready;
  for (let offset = 0; offset < pcm.length; offset += 6400) {
    if (failed) throw new Error(failed);
    stream.write(pcm.subarray(offset, offset + 6400));
    await delay(200);
  }
  const stoppedMs = Math.round(performance.now() - started);
  stream.finish();
  const deadline = Date.now() + 15000;
  while (!final && !failed && Date.now() < deadline) await delay(50);
  assert.equal(failed, "");
  assert.ok(final && finalText.length > 10, "Final recognition must complete");
  assert.ok(
    firstTextMs !== undefined && firstTextMs < stoppedMs,
    "Text must arrive before stopping",
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      firstTextMs,
      stoppedMs,
      source: "synthetic TTS",
      directory,
    }),
  );
} finally {
  stream.close();
}

if (process.argv.includes("--native")) {
  const env = {
    ...process.env,
    MORPHZ_APP_PROFILE: join(directory, "profile"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    args: ["apps/desktop/main.cjs", `--data-dir=${join(directory, "center")}`],
    env,
  });
  try {
    // This test has no permission to sample hardware. Only the OS permission
    // handshake is stubbed; production preload, IPC, worklet and provider remain real.
    await app.evaluate(({ systemPreferences }) => {
      systemPreferences.askForMediaAccess = async () => true;
      systemPreferences.getMediaAccessStatus = () => "granted";
    });
    await expect
      .poll(
        () => app.windows().some((page) => page.url() === "morphz://app/"),
        { timeout: 20000 },
      )
      .toBe(true);
    const ui = app.windows().find((page) => page.url() === "morphz://app/")!;
    ui.setDefaultTimeout(20000);
    await ui.getByRole("heading", { name: "工作台", exact: true }).waitFor();
    assert.equal(ui.url(), "morphz://app/");
    await ui.evaluate(
      (bytes) => {
        Reflect.set(window, "fixtureTracks", []);
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          const buffer = await context.decodeAudioData(
            new Uint8Array(bytes).buffer,
          );
          const destination = context.createMediaStreamDestination();
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(destination);
          await context.resume();
          source.start(context.currentTime + 0.5);
          for (const track of destination.stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              stop();
              void context.close();
            };
          }
          Reflect.set(window, "fixtureTracks", destination.stream.getTracks());
          return destination.stream;
        };
      },
      [...wav],
    );
    await ui
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "对话", exact: true })
      .click();
    const input = ui.getByLabel("AI 输入内容");
    await input.fill("TEST 实时听写验收（合成音频）");
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]!.focus();
    });
    const mic = ui.getByRole("button", { name: "语音输入", exact: true });
    await mic.click();
    const nativeStarted = performance.now();
    await ui.getByRole("button", { name: "允许并开始听写" }).click();
    const voice = ui.getByRole("region", { name: "听写", exact: true });
    await expect(voice).toHaveAttribute("data-recording", "true");
    await expect(input).toHaveValue(/TEST 实时听写验收（合成音频）\n.+/, {
      timeout: 10000,
    });
    const visibleMs = Math.round(performance.now() - nativeStarted);
    await expect(input).toHaveValue(/不需要等待停止/, { timeout: 15000 });
    await expect(voice).toHaveAttribute("data-recording", "true");
    await ui.screenshot({ path: join(directory, "native-listening.png") });
    await mic.click();
    await expect(voice).toContainText("听写已停止");
    await expect(voice.getByRole("alert")).toHaveCount(0);
    assert.equal(
      await ui.evaluate(() =>
        Reflect.get(window, "fixtureTracks").every(
          (track: MediaStreamTrack) => track.readyState === "ended",
        ),
      ),
      true,
    );
    await ui.screenshot({ path: join(directory, "native-stopped.png") });
    console.log(
      JSON.stringify({
        result: "NATIVE PASS",
        transport: "embedded IPC",
        visibleMs,
        text: await input.inputValue(),
        directory,
      }),
    );
  } catch (error) {
    await app
      .windows()
      .find((page) => page.url() === "morphz://app/")
      ?.screenshot({ path: join(directory, "native-failed.png") });
    console.error("Native fixture artifacts:", directory);
    throw error;
  } finally {
    await app.close();
  }
}
