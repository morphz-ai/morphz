/** Explicit live TTS check: isolated objects/profile, real center synthesis and
 * Electron audio decoder/player. Never samples a microphone or changes a key. */
import { _electron, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { SpeechService } from "../apps/service/src/speech.js";
import { readSpeechWav } from "../packages/core/src/audio.js";
import { localAccess } from "../packages/core/src/model.js";

const center = process.argv
  .find((arg) => arg.startsWith("--live-center="))
  ?.slice(14);
assert.ok(
  center,
  "Explicit --live-center=<local center URL> is required; uses TTS quota.",
);
const origin = new URL(center);
assert.equal(origin.protocol, "http:");
assert.equal(origin.hostname, "127.0.0.1");
const boot = await fetch(origin + "api/workspace").then((r) => r.json());
const project = boot.workspace.projects.find(
  (p: { kind: string }) => p.kind === "desk",
);
assert.ok(project);
const directory = mkdtempSync(join(tmpdir(), "morphz-live-tts-playback-"));
let waveform:
  { bytes: number; seconds: number; rms: number; peak: number } | undefined;
let calls = 0;
class CenterSpeech extends SpeechService {
  override configured() {
    return true;
  }
  override async synthesize(
    _principal: string,
    text: string,
    signal: AbortSignal,
  ) {
    calls++;
    assert.equal(text, "你好，这是桌面朗读测试。");
    const response = await fetch(origin + "api/speech/synthesize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MorphzWork-Token": boot.csrfToken,
        "X-Project-Id": project.id,
        Origin: origin.origin,
      },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!response.ok)
      throw new Error(
        `Live center TTS failed: ${response.status} ${(await response.json()).message}`,
      );
    const wav = Buffer.from(await response.arrayBuffer());
    const pcm = Buffer.from(readSpeechWav(wav));
    let power = 0,
      peak = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      const value = pcm.readInt16LE(i);
      power += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    waveform = {
      bytes: wav.length,
      seconds: pcm.length / 32000,
      rms: Math.sqrt(power / (pcm.length / 2)),
      peak,
    };
    assert.ok(waveform.rms > 10, "Real synthesis returned silent audio");
    writeFileSync(join(directory, "live-speech.wav"), wav, { mode: 0o600 });
    return wav;
  }
}
const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
store.execute(
  {
    commandId: randomUUID(),
    operation: {
      type: "create-artifact",
      projectId: "first-project",
      title: "短句真实朗读验收",
      content: { kind: "document", markdown: "你好，这是桌面朗读测试。" },
    },
  },
  localAccess,
);
const port = 65437;
const server = createAppServer(store, {
  port,
  webRoot: resolve("dist/web"),
  speech: new CenterSpeech(undefined),
});
await new Promise<void>((done, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", done);
});
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
const consoleErrors: string[] = [];
try {
  const env = {
    ...process.env,
    MORPHZWORK_ENV_FILE: "",
    MORPHZWORK_TEST_PROFILE: join(directory, "profile"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: ["apps/desktop/main.cjs", `--center=http://127.0.0.1:${port}`],
    env,
  });
  const ui = await app.firstWindow();
  ui.setDefaultTimeout(15000);
  ui.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  ui.on("pageerror", (error) => consoleErrors.push(error.message));
  await ui.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await ui.evaluate(() => {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      Reflect.set(window, "liveSpeechPlayer", this);
      return originalPlay.call(this);
    };
  });
  await ui
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await ui
    .locator(".artifact-card")
    .filter({ hasText: "短句真实朗读验收" })
    .click();
  await ui.getByRole("button", { name: "朗读对象", exact: true }).click();
  const reader = ui.getByRole("region", { name: "朗读对象", exact: true });
  assert.equal(calls, 0);
  await reader.getByRole("button", { name: "朗读", exact: true }).click();
  await expect
    .poll(
      () =>
        ui.evaluate(() => {
          const player = Reflect.get(window, "liveSpeechPlayer") as
            HTMLAudioElement | undefined;
          return player?.currentTime ?? 0;
        }),
      { timeout: 70000 },
    )
    .toBeGreaterThan(0.1);
  const playback = await ui.evaluate(() => {
    const player = Reflect.get(window, "liveSpeechPlayer") as HTMLAudioElement;
    return {
      currentTime: player.currentTime,
      duration: player.duration,
      muted: player.muted,
      volume: player.volume,
      error: player.error?.message ?? null,
    };
  });
  assert.equal(playback.muted, false);
  assert.ok(playback.volume > 0);
  assert.equal(playback.error, null);
  await ui.screenshot({ path: join(directory, "live-playback.png") });
  await reader.getByRole("button", { name: "关闭朗读", exact: true }).click();
  assert.equal(store.snapshot().artifacts[0]!.revision, 1);
  assert.equal(store.snapshot().inputs.length, 0);
  assert.equal(calls, 1);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        waveform,
        playback,
        calls,
        consoleErrors,
        directory,
        acousticOutput: "not verified by listening",
      },
      null,
      2,
    ),
  );
} catch (error) {
  const ui = app?.windows()[0];
  if (ui) {
    await ui
      .screenshot({ path: join(directory, "failure.png") })
      .catch(() => {});
    console.log(
      JSON.stringify({
        waveform,
        calls,
        consoleErrors,
        reader: await ui
          .locator(".read-aloud-player")
          .innerText()
          .catch(() => "unavailable"),
        directory,
      }),
    );
  }
  throw error;
} finally {
  await app?.close();
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
}
