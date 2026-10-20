import { openRetainedTranscription } from "./retained-transcription-fixture.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { randomUUID } from "node:crypto";
import { openLibrary } from "./application-helpers.js";
import { test, expect } from "@playwright/test";
import { readSpeechWav, wavFromPCM } from "../packages/core/src/audio.js";

test("保留转写组件：语音未配置与读取失败分别提示，不启动麦克风", async ({
  page,
}) => {
  let failed = false;
  await page.addInitScript(() => {
    Reflect.set(window, "microphoneRequests", 0);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        Reflect.set(
          window,
          "microphoneRequests",
          Reflect.get(window, "microphoneRequests") + 1,
        );
        throw new Error("本用例不允许启动麦克风");
      },
    });
  });
  await page.route("**/api/speech/status", (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: { message: "测试：配置读取失败" } }
        : { json: { configured: false, provider: null } },
    ),
  );
  await page.goto("/");
  await openRetainedTranscription(page);
  const dialog = page.getByRole("dialog", { name: "录音转文字", exact: true });
  await expect(dialog.getByRole("status")).toHaveText("尚未配置语音服务。");
  await expect(
    dialog.getByRole("button", { name: "开始录音", exact: true }),
  ).toBeDisabled();
  await dialog.getByText("语音服务与隐私", { exact: true }).click();
  await expect(dialog.locator(".speech-service-details")).toContainText(
    "尚未配置语音服务。",
  );
  await expect(dialog).not.toContainText("工作中心");
  await page.keyboard.press("Escape");
  failed = true;
  await openRetainedTranscription(page);
  await expect(dialog.getByRole("alert")).toHaveText(
    "无法读取语音配置，请重试。",
  );
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "开始录音", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => Reflect.get(window, "microphoneRequests")),
  ).toBe(0);
});

test("保留转写组件：明确开始后分段识别，保持调用方的确切版本范围，确认和取消均不写原文", async ({
  page,
  browser,
}, testInfo) => {
  let scenarioFailed = false;
  try {
    // Synthetic oscillator, not a real microphone or user recording.
    await page.addInitScript(() => {
      const sources: {
        context: AudioContext;
        oscillator?: OscillatorNode;
        destination?: MediaStreamAudioDestinationNode;
        started: boolean;
      }[] = [];
      Reflect.set(window, "syntheticAudioSources", sources);
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async () => {
          const context = new AudioContext();
          const source: (typeof sources)[number] = { context, started: false };
          sources.push(source);
          const oscillator = context.createOscillator();
          source.oscillator = oscillator;
          const destination = context.createMediaStreamDestination();
          source.destination = destination;
          const diagnostics: unknown[] = [];
          Reflect.set(window, "syntheticAudioDiagnostics", diagnostics);
          const record = (event: string) =>
            diagnostics.push({
              event,
              elapsedMs: performance.now(),
              state: context.state,
              currentTime: context.currentTime,
            });
          context.addEventListener("statechange", () => record("statechange"));
          record("created");
          oscillator.connect(destination);
          await context.resume();
          record("resumed");
          oscillator.start();
          source.started = true;
          record("oscillator-started");
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
    const source = await PlatformClient.connect(
      new HttpApplicationClient(new URL(page.url()).origin),
    );
    const spaces = await source.ensurePersonalSpaces();
    const title = "TEST 语音范围 " + randomUUID();
    await source.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: spaces.deskId,
      title,
      markdown: "第一版原文",
    });
    const content = (
      await source.content({ projectId: spaces.deskId, limit: 100 })
    ).items.find((item) => item.title === title)!;
    expect(content).toBeDefined();
    await source.reviseDocument({
      commandId: randomUUID(),
      contentId: content.id,
      expectedRevision: 1,
      title,
      markdown: "第二版原文",
    });
    const original = await source.readDocument(content.id);
    const scene = {
      scope: { projectId: spaces.deskId, artifactId: content.id, revision: 2 },
      title,
    };
    await openRetainedTranscription(page, scene);
    const dialog = page.getByRole("dialog", {
      name: "录音转文字",
      exact: true,
    });
    await expect(dialog).toContainText("v2");
    expect(uploads).toBe(0);
    await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
    await expect(dialog).toContainText("正在录音");
    let clockFailed = false;
    try {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (Reflect.get(window, "syntheticContext") as AudioContext)
                .currentTime,
          ),
        )
        .toBeGreaterThan(0.5);
    } catch (error) {
      clockFailed = true;
      throw error;
    } finally {
      try {
        // No CDP session/domain exists before the original clock assertion. Read
        // the JS clock first, then collect explicitly post-assert diagnostics.
        // This cannot reconstruct unobserved creation or shutdown history.
        const diagnostics = await page.evaluate(() => {
          const context = Reflect.get(
            window,
            "syntheticContext",
          ) as AudioContext;
          const stream = Reflect.get(window, "syntheticStream") as MediaStream;
          return {
            events: Reflect.get(window, "syntheticAudioDiagnostics"),
            state: context.state,
            currentTime: context.currentTime,
            sampleRate: context.sampleRate,
            baseLatency: context.baseLatency,
            outputLatency: Reflect.get(context, "outputLatency"),
            outputTimestamp: context.getOutputTimestamp(),
            streamActive: stream.active,
            tracks: stream.getTracks().map((track) => ({
              kind: track.kind,
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
              settings: track.getSettings(),
            })),
            visibility: document.visibilityState,
            focused: document.hasFocus(),
            userActivation: {
              hasBeenActive: navigator.userActivation.hasBeenActive,
              isActive: navigator.userActivation.isActive,
            },
          };
        });
        const browserSession = await browser.newBrowserCDPSession();
        let browserCommandLine: unknown;
        try {
          browserCommandLine = await browserSession
            .send("Browser.getBrowserCommandLine")
            .catch((error) => ({ unavailable: String(error) }));
        } finally {
          await browserSession.detach();
        }
        const audioSession = await page.context().newCDPSession(page);
        try {
          const audioContexts = new Map<string, unknown>();
          const audioEvents: unknown[] = [];
          audioSession.on("WebAudio.contextCreated", (payload) => {
            audioContexts.set(payload.context.contextId, payload.context);
            audioEvents.push({ event: "created", payload });
          });
          audioSession.on("WebAudio.contextChanged", (payload) => {
            audioContexts.set(payload.context.contextId, payload.context);
            audioEvents.push({ event: "changed", payload });
          });
          audioSession.on("WebAudio.contextWillBeDestroyed", (payload) => {
            audioContexts.delete(payload.contextId);
            audioEvents.push({ event: "destroyed", payload });
          });
          audioSession.on("WebAudio.nodesConnected", (payload) =>
            audioEvents.push({ event: "nodesConnected", payload }),
          );
          audioSession.on("WebAudio.audioNodeCreated", (payload) =>
            audioEvents.push({ event: "audioNodeCreated", payload }),
          );
          await audioSession.send("WebAudio.enable");
          const contexts = await Promise.all(
            [...audioContexts].map(async ([contextId, context]) => {
              try {
                return {
                  context,
                  ...(await audioSession.send("WebAudio.getRealtimeData", {
                    contextId,
                  })),
                };
              } catch (error) {
                return { context, readError: String(error) };
              }
            }),
          );
          const microphonePermission = await page.evaluate(
            async () =>
              (
                await navigator.permissions.query({
                  name: "microphone" as PermissionName,
                })
              ).state,
          );
          await testInfo.attach("synthetic-audio-clock", {
            body: Buffer.from(
              JSON.stringify(
                {
                  phase: "post-assert snapshot",
                  clockAssertion: clockFailed ? "failed" : "passed",
                  cdpHistory:
                    "Not observed before the clock assertion; events below are post-enable only, not complete creation or teardown proof.",
                  ...diagnostics,
                  contexts,
                  audioEvents,
                  microphonePermission,
                  browserCommandLine,
                  browserVersion: browser.version(),
                  launchOptions: testInfo.project.use.launchOptions,
                  permissions: testInfo.project.use.permissions,
                  channel: testInfo.project.use.channel,
                  postCdpClock: await page.evaluate(() => {
                    const context = Reflect.get(
                      window,
                      "syntheticContext",
                    ) as AudioContext;
                    return {
                      state: context.state,
                      currentTime: context.currentTime,
                      elapsedMs: performance.now(),
                    };
                  }),
                },
                null,
                2,
              ),
            ),
            contentType: "application/json",
          });
        } finally {
          await audioSession.detach();
        }
      } catch (error) {
        // A diagnostic failure must not replace the original clock failure.
        if (!clockFailed) throw error;
        try {
          await testInfo.attach("post-assert-audio-diagnostic-error", {
            body: String(error),
            contentType: "text/plain",
          });
        } catch (attachmentError) {
          console.error("Audio diagnostic attachment failed", attachmentError);
        }
      }
    }
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
    await expect(page.getByLabel("测试组件插入结果")).toHaveValue("");
    await dialog.getByLabel("语音识别文字").fill("确认后的语音批注。");
    await dialog
      .getByRole("button", { name: "放入输入框", exact: true })
      .click();
    expect(uploads).toBe(1);
    await expect(page.getByLabel("测试组件插入结果")).toHaveValue(
      "确认后的语音批注。",
    );
    expect(await source.readDocument(content.id)).toEqual(original);
    await openRetainedTranscription(page, scene);
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
    expect(await source.readDocument(content.id)).toEqual(original);
  } catch (error) {
    scenarioFailed = true;
    throw error;
  } finally {
    try {
      const cleanup = await page.evaluate(async () => {
        const sources = (Reflect.get(window, "syntheticAudioSources") ??
          []) as {
          context: AudioContext;
          oscillator?: OscillatorNode;
          destination?: MediaStreamAudioDestinationNode;
          started: boolean;
        }[];
        const results = [];
        for (const [index, source] of sources.entries()) {
          const errors: string[] = [];
          for (const action of [
            () =>
              source.destination?.stream
                .getTracks()
                .forEach((track) => track.stop()),
            () => {
              if (source.started) source.oscillator?.stop();
            },
            () => source.oscillator?.disconnect(),
            () => source.destination?.disconnect(),
          ]) {
            try {
              action();
            } catch (error) {
              errors.push(String(error));
            }
          }
          try {
            if (source.context.state !== "closed") await source.context.close();
          } catch (error) {
            errors.push(String(error));
          }
          results.push({
            index,
            state: source.context.state,
            tracks: (source.destination?.stream.getTracks() ?? []).map(
              (track) => track.readyState,
            ),
            errors,
          });
        }
        return results;
      });
      await testInfo.attach("synthetic-producer-cleanup", {
        body: JSON.stringify(cleanup, null, 2),
        contentType: "application/json",
      });
      for (const source of cleanup) {
        expect(
          source.errors,
          `synthetic producer ${source.index} cleanup`,
        ).toEqual([]);
        expect(source.state).toBe("closed");
        expect(source.tracks.every((state) => state === "ended")).toBe(true);
      }
    } catch (error) {
      if (!scenarioFailed) throw error;
      // Preserve the original failed assertion while still reporting every
      // cleanup issue. A passing scenario cannot silently ignore cleanup errors.
      try {
        await testInfo.attach("synthetic-producer-cleanup-error", {
          body: String(error),
          contentType: "text/plain",
        });
      } catch (attachmentError) {
        console.error("Audio cleanup attachment failed", attachmentError);
      }
    }
  }
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
