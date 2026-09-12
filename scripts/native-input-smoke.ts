import { _electron, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { SpeechService } from "../apps/service/src/speech.js";

// Interactive acceptance: real OS dialogs, devices and screenshot selection.
// Never transmits microphone audio or loads personal provider credentials.
class NoNetworkSpeech extends SpeechService {
  override configured() {
    return true;
  }
  override async transcribe(): Promise<string> {
    // Local test double: no audio ever reaches a provider.
    return "本机采集验收，不调用语音供应商。";
  }
  override async synthesize(): Promise<never> {
    throw new Error("Native privacy test must not call a provider");
  }
}
const directory = mkdtempSync(join(tmpdir(), "morphzwork-native-input-"));
const captureOnly = process.argv.includes("--capture-only");
const microphoneOnly = process.argv.includes("--microphone-only");
assert.ok(!(captureOnly && microphoneOnly), "Choose one native input phase");
const result = {
  microphone: "not-run",
  captureCancellation: "not-run",
  capture: "not-run",
  noProviderCalls: true,
};
const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
const server = createAppServer(store, {
  port: 65421,
  webRoot: resolve("dist/web"),
  speech: new NoNetworkSpeech(undefined),
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(65421, "127.0.0.1", resolve);
});
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  const env = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      MORPHZWORK_TEST_PROFILE: join(directory, "profile"),
      MORPHZWORK_ENV_FILE: "",
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  app = await _electron.launch({
    args: ["apps/desktop/main.cjs", "--center=http://127.0.0.1:65421"],
    env,
  });
  const ui = await app.firstWindow();
  ui.setDefaultTimeout(20000);
  await ui.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0]!.focus();
  });
  if (!captureOnly) {
    // Observe the real device streams without replacing getUserMedia or its data.
    await ui.evaluate(() => {
      const media = navigator.mediaDevices;
      const original = media.getUserMedia.bind(media);
      (window as any).__nativeTracks = [];
      media.getUserMedia = async (options) => {
        const stream = await original(options);
        (window as any).__nativeTracks.push(...stream.getTracks());
        return stream;
      };
    });
    await ui.getByRole("button", { name: "工作空间选项", exact: true }).click();
    await ui.getByRole("button", { name: "录音转文字", exact: true }).click();
    const voice = ui.getByRole("dialog", { name: "录音转文字", exact: true });
    console.log(
      "NATIVE_STAGE microphone: approve the actual macOS prompt if shown; audio goes only to a local no-network test double.",
    );
    await voice.getByRole("button", { name: "开始录音", exact: true }).click();
    await expect(voice.getByText("正在录音", { exact: true })).toBeVisible({
      timeout: 120000,
    });
    await expect(voice.getByText("00:02", { exact: true })).toBeVisible();
    await voice.getByRole("button", { name: "结束录音", exact: true }).click();
    await expect(
      voice.getByRole("button", { name: "继续输入", exact: true }),
    ).toBeEnabled();
    assert.deepEqual(
      await ui.evaluate(() =>
        (window as any).__nativeTracks.map(
          (t: MediaStreamTrack) => t.readyState,
        ),
      ),
      ["ended"],
    );
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]!.focus();
    });
    await voice.getByRole("button", { name: "继续输入", exact: true }).click();
    await expect(voice.getByText("正在录音", { exact: true })).toBeVisible();
    await voice
      .getByRole("button", { name: "关闭录音转文字", exact: true })
      .click();
    assert.deepEqual(
      await ui.evaluate(() =>
        (window as any).__nativeTracks.map(
          (t: MediaStreamTrack) => t.readyState,
        ),
      ),
      ["ended", "ended"],
    );
    assert.equal(store.snapshot().inputs.length, 0);
    console.log(
      "PASS native microphone: real getUserMedia/AudioWorklet, stop, restart, close; all tracks ended; no provider/Agent input.",
    );
    result.microphone = "passed";
  }
  if (!microphoneOnly) {
    // Exercise the actual native cancellation path without asking the user to
    // perform a second selection. No PNG is saved or transmitted by cancellation.
    const cancelled = await ui.evaluate(async () => {
      const pending = window.morphzDesktop!.capture.select();
      const cancel = setTimeout(
        () => void window.morphzDesktop!.capture.cancel(),
        200,
      );
      try {
        return await pending;
      } finally {
        clearTimeout(cancel);
      }
    });
    assert.equal(cancelled, null);
    assert.equal(store.snapshot().artifacts.length, 0);
    assert.equal(store.snapshot().inputs.length, 0);
    result.captureCancellation = "passed";
    console.log(
      "PASS native screenshot cancellation: no image object or Agent input; next selection must still work.",
    );
    await ui.getByRole("button", { name: "截图输入", exact: true }).click();
    const capture = ui.getByRole("dialog", { name: "截图输入", exact: true });
    console.log(
      "NATIVE_STAGE screenshot: select only a small synthetic region inside the test window using macOS UI.",
    );
    await expect(capture.getByAltText("待确认的截图")).toBeVisible({
      timeout: 120000,
    });
    assert.equal(store.snapshot().artifacts.length, 0);
    assert.equal(store.snapshot().inputs.length, 0);
    await capture
      .getByRole("textbox", { name: "截图标题" })
      .fill("原生截图验收（合成界面）");
    await capture
      .getByRole("button", { name: "保存到内容", exact: true })
      .click();
    await expect(capture).not.toBeVisible();
    assert.equal(store.snapshot().artifacts.length, 1);
    assert.equal(store.snapshot().artifacts[0]!.content.kind, "image");
    assert.equal(store.snapshot().inputs.length, 0);
    mkdirSync("test-results", { recursive: true });
    await ui.screenshot({ path: "test-results/desktop-native-capture.png" });
    console.log(
      "PASS native screenshot: interactive OS selection, local preview, explicit image object save, no automatic Agent input.",
    );
    result.capture = "passed";
  }
} finally {
  // Retain successful phases even if a later human-assisted selection times out.
  // A missing/not-run phase must never be confused with a completed acceptance.
  writeFileSync(join(directory, "result.json"), JSON.stringify(result), {
    mode: 0o600,
  });
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  console.log("Native input fixture:", directory);
}
