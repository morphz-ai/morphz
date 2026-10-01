import { openSettings } from "./settings-helpers.js";
import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { platformInputState } from "./platform-input-state-fixture.js";

test("真实 Electron 外观桥接与原生材质只作用于受信主窗口", async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS 原生材质专项");
  const directory = await mkdtemp(join(tmpdir(), "morphz-sidebar-native-"));
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  await source.ensurePersonalSpaces();
  const before = {
    content: await source.contentCounts(),
    conversations: await source.allNavigationConversations(),
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  env.MORPHZ_APP_PROFILE = directory;
  const desktop = await _electron.launch({
    args: [
      "tests/fixtures/remote-desktop-entry.cjs",
      "--center=http://127.0.0.1:65421",
    ],
    env,
  });
  try {
    const page = await desktop.firstWindow();
    await expect(page.locator(".app")).toBeVisible();
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
      ),
    ).toEqual({ x: 8, y: 16 });
    const inputs = await platformInputState(page, source);
    await desktop.evaluate(({ BrowserWindow, nativeTheme }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const sample = () => ({
        material:
          nativeTheme.prefersReducedTransparency ||
          nativeTheme.shouldUseHighContrastColors
            ? "solid"
            : "sidebar",
        active: window.isFocused(),
        reducedTransparency: nativeTheme.prefersReducedTransparency,
        highContrast: nativeTheme.shouldUseHighContrastColors,
        mode: nativeTheme.themeSource,
        dark: nativeTheme.shouldUseDarkColors,
      });
      const probe = {
        phase: "setup",
        records: [] as {
          at: number;
          phase: string;
          kind: string;
          state: ReturnType<typeof sample>;
          payload?: unknown;
        }[],
        sample,
      };
      const record = (kind: string, payload?: unknown) =>
        probe.records.push({
          at: performance.now(),
          phase: probe.phase,
          kind,
          state: sample(),
          ...(payload === undefined ? {} : { payload }),
        });
      const send = window.webContents.send;
      window.webContents.send = function (channel, ...args) {
        if (channel === "appearance:changed") record("publication", args[0]);
        return send.call(this, channel, ...args);
      };
      nativeTheme.on("updated", () => record("native-updated"));
      window.on("focus", () => record("focus"));
      window.on("blur", () => record("blur"));
      record("installed");
      (globalThis as any).__sidebarAppearanceProbe = probe;
    });
    // Inspect Chromium's actual native-region CSS as well as DOM clicks:
    // Playwright's renderer input alone does not exercise macOS hit-testing.
    for (const [width, zoom] of [
      [1440, 1],
      [1000, 1],
      [1440, 2],
    ]) {
      await desktop.evaluate(
        ({ BrowserWindow }, { width, zoom }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setSize(width, 900);
          window.webContents.setZoomFactor(zoom);
        },
        { width: width!, zoom: zoom! },
      );
      const toggle = page.locator(".inspector-toggle");
      await toggle.click();
      await expect(page.locator(".inspector-header")).toBeVisible();
      await expect
        .poll(async () => {
          const header = (await page
            .locator(".inspector-header")
            .boundingBox())!;
          const controls = (await page
            .locator(".workspace-inspector-controls")
            .boundingBox())!;
          return header.x + header.width <= controls.x;
        })
        .toBe(true);
      await page.getByRole("button", { name: "切换右栏内容" }).click();
      const menu = page.getByRole("group", { name: "右栏内容" });
      const regions = await menu.evaluate((element) => [
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        getComputedStyle(element, "::backdrop").getPropertyValue(
          "-webkit-app-region",
        ),
      ]);
      expect(regions).toEqual(["no-drag", "no-drag"]);
      await toggle.click();
      await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    }
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.webContents.setZoomFactor(1);
      window.setSize(1440, 960);
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-native-material",
      /sidebar|solid/,
    );
    const reduced = await desktop.evaluate(
      ({ nativeTheme }) =>
        nativeTheme.prefersReducedTransparency ||
        nativeTheme.shouldUseHighContrastColors,
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-native-material",
      reduced ? "solid" : "sidebar",
    );
    for (const [label, value] of [
      ["亮色", "light"],
      ["暗色", "dark"],
      ["跟随系统", "system"],
    ]) {
      await openSettings(page, "外观");
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect
        .poll(() =>
          desktop.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
        )
        .toBe(value);
      await page.keyboard.press("Escape");
      expect(
        await page
          .locator(".workspace")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ).not.toContain("rgba");
    }
    const bridge = await page.evaluate(async () => {
      const native = window.morphzDesktop!.appearance!;
      let changed = 0;
      const off = native.onChange(() => changed++);
      await native.setMode("dark");
      await new Promise((resolve) => setTimeout(resolve, 50));
      off();
      const previous = changed;
      await native.setMode("light");
      await new Promise((resolve) => setTimeout(resolve, 50));
      let invalidRejected = false;
      try {
        await native.setMode("menu" as "light");
      } catch {
        invalidRejected = true;
      }
      await native.setMode("system");
      return {
        previous,
        changed,
        invalidRejected,
        node: typeof (window as any).require,
      };
    });
    expect(bridge.previous).toBeGreaterThan(0);
    expect(bridge.changed).toBe(bridge.previous);
    expect(bridge.invalidRejected).toBe(true);
    expect(bridge.node).toBe("undefined");
    const observation = await desktop.evaluate(
      async ({ BrowserWindow, nativeTheme }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const probe = (globalThis as any).__sidebarAppearanceProbe;
        probe.phase = "redundant-native-updates";
        const baseline = probe.sample();
        const lastPublication = probe.records.findLast(
          (record: { kind: string }) => record.kind === "publication",
        );
        probe.records.push({
          at: performance.now(),
          phase: probe.phase,
          kind: "baseline",
          state: baseline,
        });
        const vibrancy = window.setVibrancy.bind(window);
        const background = window.setBackgroundColor.bind(window);
        const send = window.webContents.send.bind(window.webContents);
        let materialWrites = 0;
        let backgroundWrites = 0;
        let appearanceMessages = 0;
        window.setVibrancy = (...args) => {
          materialWrites++;
          return vibrancy(...args);
        };
        window.setBackgroundColor = (...args) => {
          backgroundWrites++;
          return background(...args);
        };
        window.webContents.send = (channel, ...args) => {
          if (channel === "appearance:changed") appearanceMessages++;
          return send(channel, ...args);
        };
        try {
          // EventEmitter invokes the appearance handlers synchronously. Count
          // only these controlled no-change events as duplicate publications;
          // a later genuine focus/theme event must still publish its new state.
          for (let n = 0; n < 100; n++) nativeTheme.emit("updated");
          const unchanged = {
            materialWrites,
            backgroundWrites,
            appearanceMessages,
          };
          const controlledEvents = probe.records.filter(
            (record: { phase: string; kind: string }) =>
              record.phase === "redundant-native-updates" &&
              record.kind === "native-updated",
          );
          probe.phase = "asynchronous-native-observation";
          await new Promise((resolve) => setTimeout(resolve, 250));
          probe.records.push({
            at: performance.now(),
            phase: probe.phase,
            kind: "measurement-end",
            state: probe.sample(),
          });
          const asynchronousEvents = probe.records.filter(
            (record: { phase: string }) => record.phase === probe.phase,
          );
          probe.phase = "after-native-observation";
          return {
            unchanged,
            baseline,
            baselinePublication: lastPublication,
            controlledEvents,
            asynchronousEvents,
            total: { materialWrites, backgroundWrites, appearanceMessages },
          };
        } finally {
          window.setVibrancy = vibrancy;
          window.setBackgroundColor = background;
          window.webContents.send = send;
        }
      },
    );
    expect(observation.unchanged).toEqual({
      materialWrites: 0,
      backgroundWrites: 0,
      appearanceMessages: 0,
    });
    expect(observation.controlledEvents).toHaveLength(100);
    for (const event of observation.controlledEvents)
      expect(event.state).toEqual(observation.baseline);
    expect(observation.baselinePublication.state).toEqual(observation.baseline);
    let previousState = observation.baseline;
    let previousRevision = observation.baselinePublication.payload.revision;
    expect(Number.isSafeInteger(previousRevision)).toBe(true);
    const asynchronousPublications = observation.asynchronousEvents.filter(
      (event: { kind: string }) => event.kind === "publication",
    );
    for (const publication of asynchronousPublications) {
      expect(publication.state).not.toEqual(previousState);
      expect(Number.isSafeInteger(publication.payload.revision)).toBe(true);
      expect(publication.payload.revision).toBeGreaterThan(previousRevision);
      expect(publication.payload).toMatchObject({
        material: publication.state.material,
        active: publication.state.active,
        reducedTransparency: publication.state.reducedTransparency,
        highContrast: publication.state.highContrast,
      });
      previousState = publication.state;
      previousRevision = publication.payload.revision;
    }
    expect(observation.total).toEqual({
      materialWrites: 0,
      backgroundWrites: 0,
      appearanceMessages: asynchronousPublications.length,
    });
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "untrusted-material-frame";
      frame.srcdoc =
        "<!doctype html><title>权限隔离验收</title><p>独立子页面</p>";
      document.body.append(frame);
    });
    const frame = page.frameLocator("#untrusted-material-frame");
    await expect(frame.locator("body")).toBeVisible();
    expect(
      await frame.locator("body").evaluate(() => typeof window.morphzDesktop),
    ).toBe("undefined");
    expect(await platformInputState(page, source)).toEqual(inputs);
    expect({
      content: await source.contentCounts(),
      conversations: await source.allNavigationConversations(),
    }).toEqual(before);
  } finally {
    const diagnostic = await desktop
      .evaluate(() => {
        const probe = (globalThis as any).__sidebarAppearanceProbe;
        return probe ? { records: probe.records, final: probe.sample() } : null;
      })
      .catch((error) => ({ diagnosticError: String(error) }));
    await testInfo.attach("native-appearance-causal-record", {
      body: Buffer.from(JSON.stringify(diagnostic, null, 2)),
      contentType: "application/json",
    });
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});
