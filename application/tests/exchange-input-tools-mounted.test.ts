import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createServer } from "vite";

// The two private pages mount real React/StrictMode and the four original
// features. Acquisition/Client ports are controlled, not real permissions,
// native pickers, Host/Runtime, transcription providers or input submissions.
type Report = {
  contextKey: string;
  visible: boolean;
  stored: Record<string, { body: string; attachments?: { name: string }[] }>;
  inputErrors: Record<string, string>;
  media: {
    speech: unknown;
    capture: unknown;
    uploadingDrafts: Record<string, boolean>;
  };
  native: {
    directoryPickerScope: string | null;
    nativeExportDialog: boolean;
  };
  recording: boolean;
  controlsAttached: boolean;
  stable: Record<string, boolean>;
  ledger: unknown[][];
  active: string | null;
  domain: {
    uploads: string[];
    captureRequests: { hideWindow: boolean }[];
    captureCancels: number;
    directories: string[];
    calls: string[];
    streamScopes: unknown[];
    streams: { state: { status: string }; pendingReads: number }[];
    executions: unknown[];
  };
  closed: unknown[][];
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
const installed = existsSync(executable || chromium.executablePath());
const report = (page: Page) =>
  page.evaluate<Report>(() => Reflect.get(window, "inputToolFixture").report());
const invoke = (page: Page, action: string, value?: unknown) =>
  page.evaluate(
    ([name, argument]) =>
      Reflect.get(window, "inputToolFixture").run(name, argument),
    [action, value],
  );
const domain = (page: Page, method: string, value?: unknown) =>
  page.evaluate(
    ([name, argument]) =>
      Reflect.get(window, "inputToolFixture")[name as string](argument),
    [method, value],
  );
async function capture(page: Page, hideWindow = false) {
  const previous = (await report(page)).domain.captureRequests.length;
  await page.getByRole("button", { name: "添加输入内容", exact: true }).click();
  await page.getByRole("button", { name: "截图输入", exact: true }).click({
    modifiers: hideWindow ? ["Alt"] : [],
  });
  await expect
    .poll(async () => (await report(page)).domain.captureRequests.length)
    .toBe(previous + 1);
}
async function microphone(page: Page) {
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  const allow = page.getByRole("button", { name: "允许并开始听写" });
  if (await allow.isVisible()) await allow.click();
  await expect.poll(async () => (await report(page)).recording).toBe(true);
}

test(
  "input-tool owner preserves fixed Git state/lifecycle with actual feature entries in StrictMode",
  {
    skip:
      !installed &&
      "No installed browser executable for isolated React fixture",
    timeout: 60_000,
  },
  async (context) => {
    const scratch = mkdtempSync(join(tmpdir(), "morphz-input-tools-mount-"));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: join(scratch, "vite-cache"),
      plugins: [
        react(),
        {
          name: "isolated-input-tools",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (!request.url?.startsWith("/__input-tools?")) return next();
              const mode = new URL(
                request.url,
                "http://fixture.invalid",
              ).searchParams.get("mode");
              assert(mode === "fixed" || mode === "production");
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><style>body{margin:0}.workspace{padding:20px}.exchange-panel{position:relative;width:600px}.composer{display:flex;flex-wrap:wrap;gap:8px}textarea{width:560px;height:90px}button{min-height:28px}svg{width:16px;height:16px}.hidden-file{display:none}</style></head><body><div id="root"></div><script type="module">import {mountInputToolsFixture} from '/@fs/${resolve("tests/fixtures/exchange-input-tools-mounted.ts")}';mountInputToolsFixture('${mode}');</script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    const pages: Page[] = [],
      contexts: BrowserContext[] = [],
      errors: string[] = [],
      requests: string[] = [];
    let browser: Browser | undefined,
      phase = "mount",
      complete = false;
    context.after(async () => {
      try {
        if (!complete) {
          context.diagnostic(
            JSON.stringify({
              phase,
              errors,
              requests,
              reports: await Promise.all(
                pages.map((page) => report(page).catch(String)),
              ),
            }),
          );
          for (let i = 0; i < pages.length; i++)
            await pages[i]!.screenshot({
              path: join(scratch, "failed-" + i + ".png"),
            }).catch(() => {});
        }
        context.diagnostic("Private fixture evidence: " + scratch);
      } finally {
        try {
          await Promise.all(contexts.map((value) => value.close()));
        } finally {
          try {
            await browser?.close();
          } finally {
            await server.close();
          }
        }
      }
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    for (const mode of ["fixed", "production"] as const) {
      const browserContext = await browser.newContext();
      contexts.push(browserContext);
      const page = await browserContext.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(mode + ": " + error.message));
      await page.route("**/api/**", (route) => {
        if (
          route.request().method() === "GET" &&
          decodeURIComponent(new URL(route.request().url()).pathname) ===
            "/api/attachments/asset-现场截图.png"
        )
          return route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWOQ0zD6DwACWAF492PbxQAAAABJRU5ErkJggg==",
              "base64",
            ),
          });
        requests.push(
          mode +
            ": " +
            route.request().method() +
            " " +
            new URL(route.request().url()).pathname,
        );
        return route.abort();
      });
      await page.addInitScript(() => {
        const streams: MediaStream[] = [];
        Reflect.set(window, "syntheticTracks", streams);
        navigator.mediaDevices.getUserMedia = async () => {
          const audio = new AudioContext(),
            oscillator = audio.createOscillator(),
            destination = audio.createMediaStreamDestination();
          oscillator.connect(destination);
          await audio.resume();
          oscillator.start();
          for (const track of destination.stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              if (track.readyState === "ended") return;
              stop();
              oscillator.stop();
              void audio.close().catch(() => {});
            };
          }
          streams.push(destination.stream);
          return destination.stream;
        };
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/__input-tools?mode=${mode}`,
      );
      await expect(
        page.getByRole("button", { name: "授权 Agent 读写目录" }),
      ).toBeEnabled();
      await expect
        .poll(async () => (await report(page)).domain.calls.length)
        .toBe(2);
    }
    async function parity(name: string) {
      phase = name;
      const [fixed, production] = await Promise.all(pages.map(report));
      assert.deepEqual(production, fixed, name);
      assert.deepEqual(production!.stable, {
        controls: true,
        recording: true,
        native: true,
        closeAlias: true,
      });
      assert.deepEqual(errors, [], name + " browser errors");
      assert.deepEqual(requests, [], name + " must not access any API");
      return production!;
    }
    await parity(
      "initial StrictMode registration and original surrounding commit order",
    );
    for (const page of pages) {
      await invoke(page, "tick");
      await invoke(page, "native", true);
    }
    assert.equal(
      (await parity("stable controls/setters across unrelated render")).native
        .nativeExportDialog,
      true,
    );
    for (const page of pages) await invoke(page, "native", false);

    phase = "real file chooser with late upload after scope switch";
    for (const page of pages) {
      await domain(page, "holdUpload");
      await page
        .getByRole("button", { name: "添加输入内容", exact: true })
        .click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "附加文件", exact: true }).click();
      await (
        await chooser
      ).setFiles({
        name: "late.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("controlled"),
      });
      await expect
        .poll(
          async () => (await report(page)).media.uploadingDrafts["A:object"],
        )
        .toBe(true);
      await invoke(page, "scope", "B:object");
      await domain(page, "releaseUpload");
      await expect
        .poll(
          async () =>
            (await report(page)).stored["A:object"]!.attachments?.length,
        )
        .toBe(1);
    }
    let current = await parity(
      "late attachment writes captured origin and preserves false map entry",
    );
    assert.equal(current.media.uploadingDrafts["A:object"], false);
    assert.equal(current.stored["B:object"]!.body, "other scene");
    for (const page of pages) {
      await invoke(page, "scope", "A:object");
      await page.getByRole("button", { name: "移除附件 late.txt" }).click();
      await expect(
        page.getByRole("textbox", { name: "AI 输入内容" }),
      ).toBeFocused();
    }
    await parity(
      "actual attachment removal focuses original input before callback",
    );

    phase = "native chooser captured scope and late finally";
    for (const page of pages) {
      await page.getByRole("button", { name: "授权 Agent 读写目录" }).click();
      assert.equal(
        (await report(page)).native.directoryPickerScope,
        "project-A:A",
      );
      await invoke(page, "scope", "B:object");
      await page.getByRole("button", { name: "授权 Agent 读写目录" }).click();
      const previousCalls = (await report(page)).domain.calls.length;
      await domain(page, "finishDirectory");
      await expect
        .poll(async () => (await report(page)).domain.calls.length)
        .toBe(previousCalls + 1);
      assert.equal(
        (await report(page)).native.directoryPickerScope,
        "project-B:B",
      );
      await domain(page, "finishDirectory");
      await expect
        .poll(async () => (await report(page)).native.directoryPickerScope)
        .toBe(null);
      await expect(
        page.getByRole("button", { name: "授权 Agent 读写目录" }),
      ).toBeFocused();
    }
    await parity("old chooser finally cannot clear new scope's pause");

    phase = "actual capture attachment preserves origin across scope switch";
    for (const page of pages) {
      await capture(page, true);
      await invoke(page, "scope", "A:object");
      await domain(page, "finishCapture", true);
      await expect
        .poll(() =>
          page
            .getByAltText("待确认的截图")
            .evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(1);
      await page
        .getByRole("button", { name: "添加到消息", exact: true })
        .click();
      await expect
        .poll(async () => (await report(page)).media.capture)
        .toBe(null);
    }
    current = await parity(
      "capture result attaches to captured B without showing current A",
    );
    assert.equal(current.stored["B:object"]!.attachments?.length, 1);
    assert.equal(
      current.ledger.some(([event]) => event === "show-input"),
      false,
    );
    assert.deepEqual(current.domain.captureRequests, [{ hideWindow: true }]);
    for (const page of pages) {
      await capture(page);
      await invoke(page, "scope", "B:object");
      await domain(page, "finishCapture", true);
      await expect
        .poll(() =>
          page
            .getByAltText("待确认的截图")
            .evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(1);
      await page
        .getByRole("button", { name: "保存到内容", exact: true })
        .click();
      await expect
        .poll(async () => (await report(page)).media.capture)
        .toBe(null);
    }
    current = await parity(
      "save callback retains captured project and original no-new-navigation-guard semantics",
    );
    assert.deepEqual(current.ledger.at(-1), [
      "open-object",
      "project-A",
      "saved-object",
    ]);
    assert.equal(current.domain.executions.length, 2);
    for (const page of pages) {
      await capture(page);
      await domain(page, "finishCapture", false);
      await expect
        .poll(async () => (await report(page)).media.capture)
        .toBe(null);
    }
    await parity(
      "initial native capture cancellation closes without a result or new write",
    );

    phase =
      "real inline dictation entry/consent/audio/transcript/manual interrupt";
    for (const page of pages) {
      await microphone(page);
      await domain(page, "publish", "first transcript");
      await expect(
        page.getByRole("textbox", { name: "AI 输入内容" }),
      ).toHaveValue("other scene\nfirst transcript");
      await page
        .getByRole("textbox", { name: "AI 输入内容" })
        .fill("manual editing");
      await expect.poll(async () => (await report(page)).recording).toBe(false);
      await domain(page, "publish", "late transcript");
      await page.getByRole("button", { name: "关闭听写", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "语音输入", exact: true }),
      ).toBeFocused();
    }
    current = await parity(
      "manual body edit interrupts latest controls; old transcript cannot overwrite draft",
    );
    assert.equal(current.stored["B:object"]!.body, "manual editing");
    for (const page of pages) {
      await microphone(page);
      await domain(page, "publish", "second transcript");
      await expect(
        page.getByRole("textbox", { name: "AI 输入内容" }),
      ).toHaveValue("manual editing\nsecond transcript");
      // Same inline scene: the Host handler must use the latest original
      // controls ref instead of constructing a second speech scene.
      await page.getByRole("button", { name: "语音输入", exact: true }).click();
      await expect.poll(async () => (await report(page)).recording).toBe(false);
      await microphone(page);
      await invoke(page, "visible", false);
      await expect
        .poll(async () => (await report(page)).media.speech)
        .toBe(null);
      await expect.poll(async () => (await report(page)).recording).toBe(false);
      await domain(page, "publish", "retired transcript");
      await invoke(page, "visible", true);
    }
    await parity(
      "original retirement effect cancels actual feature on input hide without dropping recognized text",
    );

    // Explicit retained-branch counterfactual only. No removed transcription
    // entry is exposed, restored or claimed reachable in production App.
    phase = "retained modal callback counterfactual via actual SpeechDialog";
    for (const page of pages) {
      await invoke(page, "modal");
      await page
        .getByRole("textbox", { name: "语音识别文字" })
        .fill("retained branch");
      await page
        .getByRole("button", { name: "放入输入框", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "AI 输入内容" }),
      ).toBeFocused();
    }
    current = await parity(
      "modal insert uses original snapshot and next-frame input focus",
    );
    assert.equal(
      current.stored["B:object"]!.body,
      "manual editing\nsecond transcript\nretained branch",
    );
    phase = "active dictation scope retirement";
    for (const page of pages) {
      await microphone(page);
      await domain(page, "publish", "scope transcript");
      await expect(
        page.getByRole("textbox", { name: "AI 输入内容" }),
      ).toHaveValue(
        "manual editing\nsecond transcript\nretained branch\nscope transcript",
      );
      await invoke(page, "scope", "A:object");
      await expect
        .poll(async () => (await report(page)).media.speech)
        .toBe(null);
      await expect.poll(async () => (await report(page)).recording).toBe(false);
      await domain(page, "publish", "late scope result");
    }
    current = await parity(
      "scope retirement cancels captured speech while preserving both original drafts",
    );
    assert.equal(current.stored["A:object"]!.body, "original");
    assert.equal(
      current.stored["B:object"]!.body,
      "manual editing\nsecond transcript\nretained branch\nscope transcript",
    );
    phase = "actual Escape and Dialog share the original early close command";
    for (const page of pages) {
      await microphone(page);
      await page.keyboard.press("Escape");
      await expect
        .poll(async () => (await report(page)).media.speech)
        .toBe(null);
      await expect.poll(async () => (await report(page)).recording).toBe(false);
      await expect(
        page.getByRole("button", { name: "语音输入", exact: true }),
      ).toBeFocused();
    }
    await parity(
      "actual Escape has the same synchronous close/focus semantics as Dialog",
    );
    phase = "unmount while actual inline acquisition is active";
    for (const page of pages) {
      await microphone(page);
      assert.equal((await report(page)).controlsAttached, true);
      assert.equal(
        await page.evaluate(() =>
          (Reflect.get(window, "syntheticTracks") as MediaStream[]).some(
            (stream) =>
              stream.getTracks().some((track) => track.readyState === "live"),
          ),
        ),
        true,
      );
    }
    await parity(
      "both original and owner have genuinely active acquisition before unmount",
    );
    for (const page of pages) {
      await domain(page, "unmount");
      await expect
        .poll(async () =>
          (await report(page)).domain.streams.every(
            (stream) =>
              ["complete", "cancelled"].includes(stream.state.status) &&
              stream.pendingReads === 0,
          ),
        )
        .toBe(true);
      assert.equal((await report(page)).controlsAttached, false);
      assert.equal(
        await page.evaluate(() =>
          (Reflect.get(window, "syntheticTracks") as MediaStream[]).every(
            (stream) =>
              stream.getTracks().every((track) => track.readyState === "ended"),
          ),
        ),
        true,
      );
    }
    await parity(
      "unmount cancels acquired synthetic tracks and keeps original cleanup parity",
    );
    complete = true;
  },
);
