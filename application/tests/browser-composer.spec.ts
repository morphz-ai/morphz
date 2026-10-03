import { test, expect, _electron } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openInput } from "./interaction-helpers.js";
import {
  sidebarLayout,
  sidebarPreference,
} from "../apps/web/src/sidebar-layout.js";

test("认知应用的交流面板悬浮，不改变画布尺寸；固定和收起均保留草稿", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
    .click();
  await openInput(page);
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  const canvas = page.locator("main.application-canvas");
  const before = (await canvas.boundingBox())!;
  await page.locator(".composer-reopen").click();
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await input.fill("TEST 悬浮交流草稿");
  await expect
    .poll(async () =>
      Math.abs((await canvas.boundingBox())!.height - before.height),
    )
    .toBeLessThan(2);
  await page.getByRole("button", { name: "固定输入框", exact: true }).click();
  await expect
    .poll(async () =>
      Math.abs((await canvas.boundingBox())!.height - before.height),
    )
    .toBeLessThan(2);
  await expect(input).toHaveValue("TEST 悬浮交流草稿");
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await expect(page.locator(".composer-reopen")).toBeVisible();
  // A collapsed entry must not leave an invisible, full-width click barrier.
  await expect
    .poll(() =>
      page.locator(".composer-dock").evaluate((dock) => {
        const rect = dock.getBoundingClientRect();
        return !!document
          .elementFromPoint(rect.left + 1, rect.top + rect.height / 2)
          ?.closest(".exchange-surface");
      }),
    )
    .toBe(false);
  await page.locator(".composer-reopen").press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("TEST 悬浮交流草稿");
});

test("真实 Electron 网页上叠放交流：视口与表单不变、入口可点击、网页无宿主权限", async ({}, info) => {
  test.setTimeout(90000);
  const fixture = await mkdtemp(join(tmpdir(), "morphz-embedded-electron-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !/^(MORPHZ_APP_|MORPHZ_WORK_|DOUBAO_|ELECTRON_RUN_AS_NODE$)/.test(
          entry[0],
        ),
    ),
  );
  env.MORPHZ_APP_EMBEDDED_FIXTURE = fixture;
  env.MORPHZ_APP_ENV_FILE = "";
  const desktop = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  const dragRequests: {
    at: number;
    reading: number;
    height: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
  }[] = [];
  try {
    await expect
      .poll(() => desktop.windows().some((p) => p.url() === "morphz://app/"))
      .toBe(true);
    const page = desktop.windows().find((p) => p.url() === "morphz://app/")!;
    // Native focus transfer cannot be asserted from an inactive OS window.
    // Establish the same foreground prerequisite as the capture-window test.
    await desktop.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "morphz://app/",
      )!;
      const events: unknown[] = [];
      (
        globalThis as unknown as { browserExchangeNativeDiagnostic: unknown[] }
      ).browserExchangeNativeDiagnostic = events;
      const record = (type: string, details: Record<string, unknown> = {}) =>
        events.push({
          at: Date.now(),
          type,
          focused: main.isFocused(),
          bounds: main.getBounds(),
          contentBounds: main.getContentBounds(),
          zoom: main.webContents.getZoomFactor(),
          ...details,
        });
      main.on("focus", () => record("focus"));
      main.on("blur", () => record("blur"));
      main.on("move", () => record("move"));
      main.on("resize", () => record("resize"));
      // Native keyboard provenance complements the renderer's input events.
      // A stray character must not be mistaken for a draft lifecycle change.
      main.webContents.on("before-input-event", (_event, input) =>
        record("before-input-event", {
          input: {
            type: input.type,
            key: input.key,
            code: input.code,
            meta: input.meta,
            control: input.control,
            alt: input.alt,
            shift: input.shift,
            isAutoRepeat: input.isAutoRepeat,
            isComposing: input.isComposing,
          },
        }),
      );
      record("installed");
      app.focus({ steal: true });
      main.focus();
    });
    await expect
      .poll(
        () =>
          desktop.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .find(
                  (window) => window.webContents.getURL() === "morphz://app/",
                )
                ?.isFocused() ?? false,
          ),
        { message: "原生网页键盘回归需要已解锁的前台窗口" },
      )
      .toBe(true);
    const boot = await page.evaluate(async () => {
      const result = await window.morphzDesktop!.application!.invoke({
        id: crypto.randomUUID(),
        method: "platform.bootstrap",
      });
      if (!result.ok) throw new Error("fixture Platform bootstrap unavailable");
      return result.value as { centerId: string; principalId: string };
    });
    const partition =
      "persist:morphz-browser-" +
      createHash("sha256")
        .update(boot.centerId + ":" + boot.principalId)
        .digest("hex");
    await desktop.evaluate(({ session }, partition) => {
      session
        .fromPartition(partition)
        .protocol.handle(
          "https",
          () =>
            new Response(
              `<!doctype html><title>TEST 悬浮网页</title><style>body{margin:0;background:#d9eef2;font:20px system-ui}header{padding:60px}article{height:1800px;background:repeating-linear-gradient(#d9eef2 0px,#d9eef2 79px,#84aeb7 80px)}button{position:fixed;left:20px;bottom:80px;padding:15px}#footer-button{left:calc(50% + 200px);bottom:10px;height:32px;padding:0 8px}</style><header><input id="form" value="TEST 网页未提交表单"><p>TEST 网页画布</p></header><article></article><button id="page-button" onclick="this.textContent='TEST 网页点击成功'">TEST 网页按钮</button><button id="footer-button" onclick="this.textContent='TEST 底部点击成功'">TEST 网页底部</button><script>window.instance=crypto.randomUUID()</script>`,
              { headers: { "Content-Type": "text/html; charset=utf-8" } },
            ),
        );
    }, partition);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await page
      .getByRole("button", { name: "浏览器 1.0.0", exact: true })
      .click();
    const address = page.getByRole("textbox", { name: "网站地址" });
    await address.fill("https://browser-overlay.invalid/");
    await address.press("Enter");
    const siteStateExpression =
      "({width:innerWidth,height:innerHeight,scroll:scrollY,form:document.querySelector('#form').value,instance:window.instance,node:typeof require,bridge:typeof window.morphzDesktop,button:document.querySelector('#page-button').textContent})";
    const siteState = () =>
      desktop.evaluate(async ({ webContents }, expression) => {
        const site = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === "https://browser-overlay.invalid/");
        if (!site) return null;
        return site.executeJavaScript(expression);
      }, siteStateExpression);
    const browserViewportSnapshot = () =>
      page.evaluate(async (expression) => {
        const slot = document.querySelector<HTMLElement>(".browser-slot")!;
        const guest = slot.querySelector<
          HTMLElement & {
            executeJavaScript: (code: string) => Promise<unknown>;
          }
        >("webview.browser-guest")!;
        const host = () => ({
          viewport: { width: innerWidth, height: innerHeight },
          sidebar: document
            .querySelector(".sidebar")!
            .getBoundingClientRect()
            .toJSON(),
          slot: slot.getBoundingClientRect().toJSON(),
          guest: guest.getBoundingClientRect().toJSON(),
        });
        const before = host();
        const site = await guest.executeJavaScript(expression);
        return { before, site, after: host() };
      }, siteStateExpression);
    await expect
      .poll(async () => (await siteState())?.form)
      .toBe("TEST 网页未提交表单");
    // Real guest mouse selection, host-owned comment UI, no page preload/IPC.
    const selectionRect = await desktop.evaluate(async ({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
      return site.executeJavaScript(
        "(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('header p'));const b=r.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()",
      );
    });
    const selectionSlot = (await page.locator(".browser-slot").boundingBox())!;
    await page.mouse.move(
      selectionSlot.x + selectionRect.x,
      selectionSlot.y + selectionRect.y + selectionRect.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      selectionSlot.x + selectionRect.x + selectionRect.width,
      selectionSlot.y + selectionRect.y + selectionRect.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    await page.getByRole("button", { name: "评论选中文字" }).click();
    await expect(page.getByLabel("引用 1 的评论（可选）")).toBeFocused();
    await page.getByLabel("引用 1 的评论（可选）").fill("TEST 网页选文评论");
    const commentBounds = (await page
      .locator(".text-quote-editor")
      .boundingBox())!;
    expect(commentBounds.width).toBeLessThanOrEqual(260);
    expect(commentBounds.height).toBeLessThanOrEqual(60);
    await info.attach("browser-inline-comment", {
      body: await page.screenshot({
        path: info.outputPath("browser-inline-comment.png"),
      }),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(
      page
        .getByRole("group", { name: "选文与评论" })
        .getByRole("button", { name: "编辑引用 1 的评论", exact: true }),
    ).toHaveAttribute("title", /TEST 网页画布/);
    await expect(page.getByRole("group", { name: "选文与评论" })).toContainText(
      "TEST 网页选文评论",
    );
    expect((await siteState())?.bridge).toBe("undefined");
    expect((await siteState())?.node).toBe("undefined");
    await page
      .getByRole("group", { name: "选文与评论" })
      .getByRole("button", { name: "查看引用 1 的原文", exact: true })
      .click();
    await expect
      .poll(() =>
        desktop.evaluate(async ({ webContents }) => {
          const site = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
          return site.executeJavaScript("getSelection().toString()");
        }),
      )
      .toBe("TEST 网页画布");
    await openInput(page);
    await page.getByRole("button", { name: "移除引用 1", exact: true }).click();
    await openInput(page);
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    const reopen = page.locator(".composer-reopen");
    await expect(reopen).toBeVisible();
    // A guest has a separate compositor hit-test surface. DOM elementFromPoint
    // alone cannot prove that the collapsed Dock's blank margin passes clicks.
    const footerPoint = await desktop.evaluate(async ({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
      return site.executeJavaScript(
        "(()=>{const r=document.querySelector('#footer-button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
    });
    const guestBounds = (await page.locator(".browser-slot").boundingBox())!;
    await page.mouse.click(
      guestBounds.x + footerPoint.x,
      guestBounds.y + footerPoint.y,
    );
    await expect
      .poll(() =>
        desktop.evaluate(async ({ webContents }) => {
          const site = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
          return site.executeJavaScript(
            "document.querySelector('#footer-button').textContent",
          );
        }),
      )
      .toBe("TEST 底部点击成功");
    const before = await siteState();
    await reopen.click();
    const input = page.getByLabel("AI 输入内容", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("TEST 网页悬浮输入，不发送");
    await expect.poll(siteState).toEqual(before);
    await page.getByRole("button", { name: "固定输入框", exact: true }).click();
    await expect.poll(siteState).toEqual(before);
    await page
      .getByRole("button", { name: "查看交流记录", exact: true })
      .click();
    await page
      .getByRole("button", { name: "收起交流记录", exact: true })
      .click();
    await expect.poll(siteState).toEqual(before);
    await expect(input).toHaveValue("TEST 网页悬浮输入，不发送");
    // Input-only has no reading header or resize affordance. Reopening the
    // actual reading surface is the explicit path back to its edge gesture.
    await expect(page.locator(".exchange-panel-header")).toHaveCount(0);
    await expect(page.locator(".exchange-resizer")).toHaveCount(0);
    await page
      .getByRole("button", { name: "查看交流记录", exact: true })
      .click();
    // The composed guest must not intercept an edge drag or lose its viewport,
    // instance or form when the host exchange changes size.
    const resize = page.getByRole("separator", { name: "调整消息区高度" });
    // Test-only causal recorder. It adds no per-gesture wait or synthetic
    // pointer delivery: the original coordinate mouse gesture remains intact.
    // A missing shield after mouseup alone cannot prove that pointerdown reached
    // the handle, especially where Electron has native draggable hit regions.
    await page.evaluate(() => {
      const events: unknown[] = [];
      (
        window as unknown as { browserExchangeGestureDiagnostic: unknown[] }
      ).browserExchangeGestureDiagnostic = events;
      const bindings = Object.keys(localStorage)
        .filter((key) => key.includes(":draft:") && key.endsWith(":inputs"))
        .flatMap((storageKey) =>
          Object.entries(
            JSON.parse(localStorage.getItem(storageKey)!) as Record<
              string,
              { body?: unknown }
            >,
          )
            .filter(([, value]) => value.body === "TEST 网页悬浮输入，不发送")
            .map(([surfaceKey]) => ({ storageKey, surfaceKey })),
        );
      if (bindings.length !== 1)
        throw new Error(
          "The original TEST draft must have one exact persisted surface key",
        );
      (
        window as unknown as {
          browserComposerDraftBinding: {
            storageKey: string;
            surfaceKey: string;
          };
        }
      ).browserComposerDraftBinding = bindings[0]!;
      const name = (target: EventTarget | null) =>
        target instanceof Element
          ? {
              tag: target.tagName,
              class: target.getAttribute("class"),
              role: target.getAttribute("role"),
              label: target.getAttribute("aria-label"),
            }
          : { tag: target === window ? "WINDOW" : "DOCUMENT" };
      const state = () => {
        const handle = document.querySelector(".exchange-resizer");
        const panel = document.querySelector(".exchange-panel");
        const input = document.querySelector<HTMLTextAreaElement>(
          '.composer textarea[aria-label="AI 输入内容"]',
        );
        return {
          mode: document
            .querySelector(".primary-panel")
            ?.getAttribute("data-interaction"),
          reading: handle?.getAttribute("aria-valuenow"),
          max: handle?.getAttribute("aria-valuemax"),
          resizing: !!panel?.hasAttribute("data-resizing"),
          shield: !!document.querySelector(".exchange-resize-shield"),
          focused: document.hasFocus(),
          active: name(document.activeElement),
          body: input?.value ?? null,
          selection: input
            ? { start: input.selectionStart, end: input.selectionEnd }
            : null,
        };
      };
      const record = (event: Event) => {
        const pointer = event instanceof PointerEvent ? event : undefined;
        const keyboard = event instanceof KeyboardEvent ? event : undefined;
        const input = event instanceof InputEvent ? event : undefined;
        const composition =
          event instanceof CompositionEvent ? event : undefined;
        const handle = document.querySelector(".exchange-resizer");
        events.push({
          at: Date.now(),
          type: event.type,
          target: name(event.target),
          trusted: event.isTrusted,
          defaultPrevented: event.defaultPrevented,
          ...(keyboard
            ? {
                key: keyboard.key,
                code: keyboard.code,
                keyCode: keyboard.keyCode,
                meta: keyboard.metaKey,
                control: keyboard.ctrlKey,
                alt: keyboard.altKey,
                shift: keyboard.shiftKey,
                repeat: keyboard.repeat,
                isComposing: keyboard.isComposing,
              }
            : {}),
          ...(input
            ? {
                data: input.data,
                inputType: input.inputType,
                isComposing: input.isComposing,
              }
            : {}),
          ...(composition ? { data: composition.data } : {}),
          ...(pointer
            ? {
                x: pointer.clientX,
                y: pointer.clientY,
                pointerId: pointer.pointerId,
                button: pointer.button,
                buttons: pointer.buttons,
                primary: pointer.isPrimary,
                capture: !!handle?.hasPointerCapture(pointer.pointerId),
                ...(event.type === "pointermove"
                  ? {}
                  : {
                      hit: name(
                        document.elementFromPoint(
                          pointer.clientX,
                          pointer.clientY,
                        ),
                      ),
                    }),
              }
            : {}),
          ...state(),
        });
        if (event.type === "input")
          queueMicrotask(() =>
            events.push({
              at: Date.now(),
              type: "after-input",
              target: name(event.target),
              ...state(),
            }),
          );
      };
      for (const type of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "gotpointercapture",
        "lostpointercapture",
        "focus",
        "blur",
        "keydown",
        "keyup",
        "beforeinput",
        "input",
        "compositionstart",
        "compositionupdate",
        "compositionend",
      ])
        window.addEventListener(type, record, true);
      const observer = new MutationObserver((changes) => {
        events.push({
          at: Date.now(),
          type: "mutation",
          changes: changes.map((change) => ({
            target: name(change.target),
            attribute: change.attributeName,
            added: [...change.addedNodes].map(name),
            removed: [...change.removedNodes].map(name),
          })),
          ...state(),
        });
      });
      observer.observe(document.querySelector(".primary-panel")!, {
        attributes: true,
        subtree: true,
        attributeFilter: [
          "data-interaction",
          "data-resizing",
          "data-resized",
          "aria-valuenow",
          "aria-valuemax",
        ],
      });
      observer.observe(document.body, { childList: true });
      events.push({ at: Date.now(), type: "installed", ...state() });
      (
        window as unknown as {
          browserComposerCheckpoint: (label: string) => void;
        }
      ).browserComposerCheckpoint = (label) =>
        events.push({
          at: Date.now(),
          type: "draft-checkpoint",
          label,
          binding: bindings[0],
          ...state(),
          savedDrafts: Object.fromEntries(
            Object.keys(localStorage)
              .filter(
                (key) => key.includes(":draft:") && key.endsWith(":inputs"),
              )
              .map((key) => [key, JSON.parse(localStorage.getItem(key)!)]),
          ),
        });
    });
    const expectDraft = async (step: string, visible = true) => {
      const savedBody = await page.evaluate((step) => {
        const diagnostic = window as unknown as {
          browserComposerCheckpoint: (label: string) => void;
          browserComposerDraftBinding: {
            storageKey: string;
            surfaceKey: string;
          };
        };
        diagnostic.browserComposerCheckpoint(step);
        const { storageKey, surfaceKey } =
          diagnostic.browserComposerDraftBinding;
        return (
          JSON.parse(localStorage.getItem(storageKey) ?? "{}")[surfaceKey]
            ?.body ?? null
        );
      }, step);
      expect(
        savedBody,
        `原稿持久值在 ${step} 后保持同一 surface key 与正文`,
      ).toBe("TEST 网页悬浮输入，不发送");
      if (visible)
        await expect(input, `原稿在 ${step} 后保持不变`).toHaveValue(
          "TEST 网页悬浮输入，不发送",
        );
    };
    const notice = page.locator(".workspace-notice");
    const noticeMessage =
      "TEST 原生阅读提示：应用窗口已变化，请刷新后重试。" +
      "这条实际保存失败提示应完整换行，同时保持交流操作、输入草稿和原网页不变。".repeat(
        3,
      ) +
      " https://browser-overlay.invalid/" +
      "long-unbroken-reference-".repeat(4) +
      " TEST 提示尾句";
    const captureNative = async (name: string) => {
      const png = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === "morphz://app/",
        )!;
        return (await window.webContents.capturePage())
          .toPNG()
          .toString("base64");
      });
      await writeFile(info.outputPath(name), Buffer.from(png, "base64"));
    };
    const readingSnapshot = () =>
      page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(".exchange-panel")!;
        const reading = panel.querySelector<HTMLElement>(
          ":scope > .conversation",
        )!;
        const handle = panel.querySelector<HTMLElement>(".exchange-resizer")!;
        const header = panel.querySelector<HTMLElement>(
          ".exchange-panel-header",
        );
        const notice = reading.querySelector<HTMLElement>(".workspace-notice");
        const text = notice?.querySelector<HTMLElement>('[role="alert"]');
        return {
          aria: Number(handle.getAttribute("aria-valuenow")),
          actual: reading.getBoundingClientRect().height,
          reading: reading.getBoundingClientRect().toJSON(),
          panel: panel.getBoundingClientRect().toJSON(),
          handle: handle.getBoundingClientRect().toJSON(),
          resized: panel.hasAttribute("data-resized"),
          header: header?.getBoundingClientRect().toJSON() ?? null,
          paddingTop: getComputedStyle(reading).paddingTop,
          paddingBottom: getComputedStyle(reading).paddingBottom,
          notice: notice
            ? {
                bounds: notice.getBoundingClientRect().toJSON(),
                maxHeight: getComputedStyle(notice).maxHeight,
                text: text
                  ? {
                      bounds: text.getBoundingClientRect().toJSON(),
                      scrollHeight: text.scrollHeight,
                      clientHeight: text.clientHeight,
                      scrollTop: text.scrollTop,
                    }
                  : null,
              }
            : null,
        };
      });
    const settledReading = async () => {
      let snapshot = await readingSnapshot();
      await expect(async () => {
        snapshot = await readingSnapshot();
        expect(
          snapshot.actual,
          "同一布局快照中的实际阅读高度与ARIA必须一致",
        ).toBeCloseTo(snapshot.aria, 0);
      }).toPass({ timeout: 5000 });
      return snapshot;
    };
    const injectNotice = async (label: string, expectedSite: typeof before) => {
      const noticeURL = `https://browser-overlay.invalid/?notice-probe=${label}`;
      await desktop.evaluate(
        async ({ webContents }, { url, message }) => {
          (
            globalThis as unknown as {
              __fixtureAppViewSaveConflict: {
                url: string;
                message: string;
                remaining: number;
                requests: unknown[];
              };
            }
          ).__fixtureAppViewSaveConflict = {
            url,
            message,
            remaining: 1,
            requests: [],
          };
          const site = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
          await site.executeJavaScript(
            `history.pushState(null, "", ${JSON.stringify(url)})`,
          );
        },
        { url: noticeURL, message: noticeMessage },
      );
      await expect(notice.getByRole("alert")).toHaveText(noticeMessage);
      await expect(
        page.locator(".exchange-panel > .conversation > .workspace-notice"),
      ).toHaveCount(1);
      await expect(notice).toHaveCount(1);
      const injected = await desktop.evaluate(
        () =>
          (
            globalThis as unknown as {
              __fixtureAppViewSaveConflict: {
                remaining: number;
                requests: {
                  method: string;
                  params: {
                    commandId: string;
                    viewId: string;
                    expectedRevision: number;
                    state: { url: string };
                  };
                }[];
              };
            }
          ).__fixtureAppViewSaveConflict,
      );
      expect(injected.remaining).toBe(0);
      expect(injected.requests).toHaveLength(1);
      expect(injected.requests[0]!.method).toBe("app-views.save");
      expect(injected.requests[0]!.params.state.url).toBe(noticeURL);
      expect(injected.requests[0]!.params.commandId).toBeTruthy();
      expect(injected.requests[0]!.params.viewId).toBeTruthy();
      expect(injected.requests[0]!.params.expectedRevision).toBeGreaterThan(0);
      await desktop.evaluate(async ({ webContents }, url) => {
        const site = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === url)!;
        await site.executeJavaScript('history.replaceState(null, "", "/")');
      }, noticeURL);
      await expect.poll(siteState).toEqual(expectedSite);
      await expect(notice.getByRole("alert")).toHaveText(noticeMessage);
      await expectDraft(
        `native 200 percent ${label} real save conflict notice`,
      );
    };
    const expectReadableNoticeTail = async (
      expectedSite: typeof before,
      expectedHeight?: string,
    ) => {
      const text = notice.getByRole("alert");
      await expect(text).toHaveAttribute("tabindex", "0");
      const maximum = await text.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      );
      expect(
        maximum,
        "长提示使用内部滚动而不是越过阅读/Dock边界",
      ).toBeGreaterThan(expectedHeight === undefined ? -1 : 0);
      await text.focus();
      await text.press("End");
      await expect
        .poll(() => text.evaluate((element) => element.scrollTop))
        .toBeGreaterThanOrEqual(maximum - 1);
      await text.press("Home");
      await expect
        .poll(() => text.evaluate((element) => element.scrollTop))
        .toBe(0);
      // The same tail must also be reachable with real pointer scrolling.
      await text.hover();
      const nativeZoom = await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "morphz://app/")!
          .webContents.getZoomFactor(),
      );
      // Native Chromium wheel deltas use viewport pixels, while scrollTop and
      // the text's maximum are CSS layout pixels (59 / 2 = 29.5 at 200%).
      await page.mouse.wheel(0, (maximum + 1) * nativeZoom);
      await expect
        .poll(() => text.evaluate((element) => element.scrollTop))
        .toBeGreaterThanOrEqual(maximum - 1);
      const visibleTail = await text.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        const reading = element
          .closest(".conversation")!
          .getBoundingClientRect();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const start = node.textContent!.indexOf("TEST 提示尾句");
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + "TEST 提示尾句".length);
          return {
            viewport: viewport.toJSON(),
            reading: reading.toJSON(),
            lines: [...range.getClientRects()]
              .filter((bounds) => bounds.width > 0)
              .map((bounds) => {
                const hit = document.elementFromPoint(
                  bounds.x + bounds.width / 2,
                  bounds.y + bounds.height / 2,
                );
                return {
                  bounds: bounds.toJSON(),
                  hit: !!hit && element.contains(hit),
                };
              }),
          };
        }
        throw new Error("真实提示尾句的文本节点不存在");
      });
      expect(visibleTail.lines.length).toBeGreaterThan(0);
      for (const line of visibleTail.lines) {
        expect(line.bounds.y).toBeGreaterThanOrEqual(
          visibleTail.viewport.y - 1,
        );
        expect(line.bounds.bottom).toBeLessThanOrEqual(
          Math.min(visibleTail.viewport.bottom, visibleTail.reading.bottom) + 1,
        );
        expect(line.bounds.x).toBeGreaterThanOrEqual(
          visibleTail.viewport.x - 1,
        );
        expect(line.bounds.right).toBeLessThanOrEqual(
          visibleTail.viewport.right + 1,
        );
        expect(line.hit, "提示尾句真实可见，不能被Dock遮住").toBe(true);
      }
      const close = notice.getByRole("button", {
        name: "关闭提示",
        exact: true,
      });
      const closeGeometry = await close.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        const upper = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + 2,
        );
        return {
          bounds: bounds.toJSON(),
          hit: !!hit && element.contains(hit),
          upperHit: !!upper && element.contains(upper),
        };
      });
      expect(closeGeometry.bounds.y).toBeGreaterThanOrEqual(
        visibleTail.reading.y,
      );
      expect(closeGeometry.bounds.bottom).toBeLessThanOrEqual(
        visibleTail.reading.bottom,
      );
      expect(closeGeometry.hit, "滚到尾句后关闭按钮仍可点击").toBe(true);
      expect(closeGeometry.upperHit).toBe(true);
      const current = await settledReading();
      if (expectedHeight !== undefined)
        await expect(resize).toHaveAttribute("aria-valuenow", expectedHeight);
      else expect(current.resized).toBe(false);
      await expectDraft(
        "native 200 percent notice tail reached by keyboard/mouse",
      );
      await expect.poll(siteState).toEqual(expectedSite);
    };
    const expectNoticeSafeArea = async () => {
      const noticeGeometry = await page.evaluate(() => {
        const notice =
          document.querySelector<HTMLElement>(".workspace-notice")!;
        const reading = document.querySelector<HTMLElement>(
          ".exchange-panel > .conversation",
        )!;
        const bounds = notice.getBoundingClientRect();
        const readingBounds = reading.getBoundingClientRect();
        return {
          notice: bounds.toJSON(),
          reading: readingBounds.toJSON(),
          overflow: notice.scrollWidth - notice.clientWidth,
          controls: [
            ...document.querySelectorAll<HTMLButtonElement>(
              ".exchange-view-tools > button",
            ),
          ]
            .filter((button) => button.getBoundingClientRect().width > 0)
            .map((button) => {
              const box = button.getBoundingClientRect();
              const hit = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              const upper = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + 2,
              );
              return {
                label: button.getAttribute("aria-label"),
                bounds: box.toJSON(),
                hit: !!hit && button.contains(hit),
                upperHit: !!upper && button.contains(upper),
              };
            }),
        };
      });
      expect(noticeGeometry.notice.x).toBeGreaterThanOrEqual(
        noticeGeometry.reading.x,
      );
      expect(noticeGeometry.notice.right).toBeLessThanOrEqual(
        noticeGeometry.reading.right,
      );
      expect(noticeGeometry.notice.bottom).toBeLessThanOrEqual(
        noticeGeometry.reading.bottom + 1,
      );
      expect(noticeGeometry.overflow).toBeLessThanOrEqual(1);
      expect(noticeGeometry.controls.length).toBeGreaterThanOrEqual(3);
      for (const button of noticeGeometry.controls) {
        expect(
          noticeGeometry.notice.y,
          `提示应位于 ${button.label} 的内容安全区下方`,
        ).toBeGreaterThanOrEqual(button.bounds.bottom);
        expect(button.hit, `${button.label} 中心仍可点击`).toBe(true);
        expect(button.upperHit, `${button.label} 上沿仍可点击`).toBe(true);
      }
      return noticeGeometry;
    };
    const dragTo = async (height: number) => {
      const baseline = await settledReading();
      const reading = baseline.aria;
      const r = baseline.handle;
      dragRequests.push({
        at: Date.now(),
        reading,
        height,
        from: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        to: {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2 + reading - height,
        },
      });
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        r.x + r.width / 2,
        r.y + r.height / 2 + reading - height,
        { steps: 10 },
      );
      await page.mouse.up();
      await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
      return baseline;
    };
    // Before any gesture saves a height, prove the real automatic recent layout
    // can contain a long error at native 200%, without inventing a resize pref.
    expect((await settledReading()).resized).toBe(false);
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .webContents.setZoomFactor(2);
    });
    await expect(input).toBeInViewport();
    await expect(resize).toBeInViewport();
    expect((await settledReading()).resized).toBe(false);
    const automaticSite = await siteState();
    await injectNotice("automatic", automaticSite);
    await info.attach("browser-automatic-notice-geometry", {
      body: JSON.stringify(await settledReading(), null, 2),
      contentType: "application/json",
    });
    await captureNative("browser-automatic-notice-200.png");
    await expectReadableNoticeTail(automaticSite);
    await expectNoticeSafeArea();
    expect((await settledReading()).resized).toBe(false);
    await notice.getByRole("button", { name: "关闭提示", exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "recent",
    );
    expect((await settledReading()).resized).toBe(false);
    await expectDraft(
      "native 200 percent automatic notice close preserves draft",
    );
    await expect.poll(siteState).toEqual(automaticSite);
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .webContents.setZoomFactor(1);
    });
    await expect.poll(siteState).toEqual(before);
    const firstDrag = await dragTo(200);
    const readingBefore = firstDrag.aria;
    const panelBefore = firstDrag.panel;
    // The reading surface is already open, so its visible frame edge follows
    // the exact pointer delta without recreating a hidden input header.
    await expect
      .poll(
        async () =>
          (await page.locator(".exchange-panel").boundingBox())!.height,
      )
      .toBeCloseTo(panelBefore.height + 200 - readingBefore, 0);
    await dragTo(200);
    await expect(resize).toHaveAttribute("aria-valuenow", "200");
    await expect.poll(siteState).toEqual(before);
    await dragTo(Number(await resize.getAttribute("aria-valuemax")) - 20);
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "history",
    );
    await dragTo(180);
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "recent",
    );
    await expect.poll(siteState).toEqual(before);
    await expect(input).toHaveValue("TEST 网页悬浮输入，不发送");
    await info.attach("browser-overlay", {
      body: await page.screenshot({
        path: info.outputPath("browser-overlay.png"),
      }),
      contentType: "image/png",
    });
    // Click the guest beside the panel, through Chromium's composed hit-testing.
    const slot = (await page.locator(".browser-slot").boundingBox())!;
    await page.mouse.click(slot.x + 55, slot.y + slot.height - 100);
    await expect
      .poll(async () => (await siteState())?.button)
      .toBe("TEST 网页点击成功");
    await expect(input).toBeVisible();
    await page
      .getByRole("button", { name: "取消固定输入框", exact: true })
      .click();
    await page.mouse.click(slot.x + 55, slot.y + slot.height - 100);
    await expect(input).toBeHidden();
    await expect(reopen).toBeVisible();
    // The shortcut originates in the isolated guest, not the host document.
    await desktop.evaluate(({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
      site.sendInputEvent({
        type: "keyDown",
        keyCode: "J",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    });
    await expect(input).toBeFocused();
    // Focus moved to the host on keydown. A physical key release goes there;
    // send it to that surface, not to the previously focused guest.
    await desktop.evaluate(({ webContents }) => {
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "morphz://app/")!
        .sendInputEvent({
          type: "keyUp",
          keyCode: "J",
          modifiers: [process.platform === "darwin" ? "meta" : "control"],
        });
    });
    await expect(input).toBeFocused();
    await expectDraft("guest shortcut and host key release");
    // Hold the hide action's next-frame focus restoration until the Human has
    // focused the reopen button. A stale callback must not steal that focus.
    await page.evaluate(() => {
      document.querySelector('[aria-label="收起 AI 输入框"]')!.addEventListener(
        "click",
        () => {
          const original = window.requestAnimationFrame.bind(window);
          const frames: (() => void)[] = [];
          window.requestAnimationFrame = (callback) =>
            original((time) => frames.push(() => callback(time)));
          (
            window as unknown as { releaseHideFrames: () => Promise<void> }
          ).releaseHideFrames = async () => {
            await new Promise<void>((resolve) => original(() => resolve()));
            window.requestAnimationFrame = original;
            frames.forEach((run) => run());
          };
        },
        { once: true, capture: true },
      );
    });
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    await expect(reopen).toBeVisible();
    await reopen.focus();
    await page.evaluate(() =>
      (
        window as unknown as { releaseHideFrames: () => Promise<void> }
      ).releaseHideFrames(),
    );
    await expect(reopen).toBeFocused();
    await reopen.press("Enter");
    await expect(input).toBeFocused();
    await expectDraft("keyboard reopen after delayed hide frames");
    await expect(
      page.getByRole("button", { name: "允许 Agent 协助", exact: true }),
    ).toBeVisible();
    expect(before.node).toBe("undefined");
    expect(before.bridge).toBe("undefined");
    await page
      .getByRole("button", { name: "返回工作空间", exact: true })
      .click();
    await page.getByRole("tab", { name: /浏览器/ }).click();
    await expect
      .poll(async () => (await siteState())?.instance)
      .toBe(before.instance);
    await expect.poll(async () => (await siteState())?.form).toBe(before.form);
    await openInput(page);
    await expectDraft("return to original browser instance");
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === "morphz://app/",
      )!;
      window.webContents.setZoomFactor(2);
    });
    await expect(reopen).toBeInViewport();
    // Native zoom can paint the entry before the responsive sidebar and guest
    // viewport catch up. Capture the pre-click baseline only after all three
    // actual surfaces agree, not after opening input changes the canvas.
    let zoomedSnapshot = await browserViewportSnapshot();
    try {
      await expect(async () => {
        zoomedSnapshot = await browserViewportSnapshot();
        expect(zoomedSnapshot.before).toEqual(zoomedSnapshot.after);
        const host = zoomedSnapshot.after;
        const expectedSidebar = sidebarLayout(
          host.viewport.width,
          sidebarPreference(),
        );
        expect(host.sidebar.width).toBeCloseTo(expectedSidebar.width, 0);
        expect(host.slot).toEqual(host.guest);
        const site = zoomedSnapshot.site as { width: number; height: number };
        // The guest exposes an integer CSS viewport: native 200% can leave
        // half-pixel layout bounds, whose fractional edge is not a whole pixel.
        expect(site.width).toBe(Math.floor(host.guest.width));
        expect(site.height).toBe(Math.floor(host.guest.height));
      }).toPass({ timeout: 5000 });
    } finally {
      await info.attach("browser-native-zoom-settled-viewport", {
        body: JSON.stringify(zoomedSnapshot, null, 2),
        contentType: "application/json",
      });
    }
    const zoomed = zoomedSnapshot.site;
    await reopen.click();
    await expect(input).toBeInViewport();
    await expectDraft("native 200 percent reopen before resize keys");
    await expect.poll(siteState).toEqual(zoomed);
    await page
      .getByRole("button", { name: "查看交流记录", exact: true })
      .click();
    await expect(resize).toBeInViewport();
    await resize.focus();
    await page.keyboard.press("End");
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "history",
    );
    await expectDraft("native 200 percent resize End");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "recent",
    );
    await expectDraft("native 200 percent resize ArrowDown");
    await expect(input).toBeInViewport();
    await expect.poll(siteState).toEqual(zoomed);
    const geometry = await page.evaluate(() => {
      const input = document
        .querySelector(".composer textarea")!
        .getBoundingClientRect();
      return { input: input.toJSON(), width: innerWidth, height: innerHeight };
    });
    expect(geometry.input.x).toBeGreaterThanOrEqual(0);
    expect(geometry.input.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.input.y).toBeGreaterThanOrEqual(0);
    expect(geometry.input.bottom).toBeLessThanOrEqual(geometry.height);
    const readingHeight = await resize.getAttribute("aria-valuenow");
    const readingBounds = (await page
      .locator(".exchange-panel > .conversation")
      .boundingBox())!;
    // Keep the fixed-height 200% gate independent of the initial automatic
    // recent-height gate: its original resize/close invariants stay exact.
    await injectNotice("fixed", zoomed);
    await expectReadableNoticeTail(zoomed, readingHeight!);
    const noticeGeometry = await expectNoticeSafeArea();
    await expect(resize).toHaveAttribute("aria-valuenow", readingHeight!);
    expect(noticeGeometry.reading.height).toBeCloseTo(readingBounds.height, 0);
    // Keep the notice in place while taking compositor evidence and clicking
    // the actual toolbar. Do not dismiss it or force clicks to pass the gate.
    // Playwright's page screenshot clips Electron zoom coordinates; capture
    // the actual window compositor for the 200% visual evidence.
    await captureNative("browser-overlay-200.png");
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "hidden",
    );
    await expectDraft("native 200 percent hide with retained notice", false);
    await expect(notice.getByRole("alert")).toHaveText(noticeMessage);
    await reopen.click();
    await expectDraft("native 200 percent reopen with retained notice");
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "input",
    );
    await page
      .getByRole("button", { name: "查看交流记录", exact: true })
      .click();
    await expect(
      page.locator(".exchange-panel > .conversation > .workspace-notice"),
    ).toHaveCount(1);
    await expect(resize).toHaveAttribute("aria-valuenow", readingHeight!);
    expect(
      (await page.locator(".exchange-panel > .conversation").boundingBox())!
        .height,
    ).toBeCloseTo(readingBounds.height, 0);
    await expectReadableNoticeTail(zoomed, readingHeight!);
    await notice.getByRole("button", { name: "关闭提示", exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "recent",
    );
    await expect(resize).toHaveAttribute("aria-valuenow", readingHeight!);
    expect(
      (await page.locator(".exchange-panel > .conversation").boundingBox())!
        .height,
    ).toBeCloseTo(readingBounds.height, 0);
    await expectDraft("native 200 percent close notice without placeholder");
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    await page.evaluate(() => {
      (
        window as unknown as { quoteSelectionEvents: unknown[] }
      ).quoteSelectionEvents = [];
      window.morphzDesktop!.browser!.onSelection!((event) =>
        (
          window as unknown as { quoteSelectionEvents: unknown[] }
        ).quoteSelectionEvents.push(event),
      );
    });
    await desktop.evaluate(async ({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
      await site.executeJavaScript(`(() => {
        const p = document.querySelector('header p');
        const style = document.createElement('style'); style.textContent = '.PRIVATE_STYLE_TOKEN { color: red; }';
        const hidden = document.createElement('span'); hidden.hidden = true; hidden.textContent = 'PRIVATE_HIDDEN_TOKEN';
        const tail = document.createTextNode('，TEST 可见尾句');
        const second = document.createElement('span'); second.style.display = 'block'; second.textContent = 'TEST 第二行';
        p.append(style, hidden, tail, second); p.scrollIntoView({block:'center'}); document.activeElement?.blur();
        const range = document.createRange(); range.selectNodeContents(p);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      })()`);
      site.focus();
      site.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
      site.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
    });
    try {
      await page
        .getByRole("button", { name: "评论选中文字" })
        .click({ timeout: 5000 });
    } catch (error) {
      const selectionCode = createRequire(import.meta.url)(
        "../apps/desktop/browser-page.cjs",
      ).pageSelection.toString();
      const diagnostic = await desktop.evaluate(
        async ({ webContents }, selectionCode) => {
          const site = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
          return {
            selection: await site.executeJavaScriptInIsolatedWorld(1002, [
              { code: `(${selectionCode})()` },
            ]),
            state: await site.executeJavaScript(
              "({active:document.activeElement.tagName,text:getSelection().toString(),focus:document.hasFocus(),scroll:scrollY})",
            ),
          };
        },
        selectionCode,
      );
      const delivered = await page.evaluate(
        () =>
          (window as unknown as { quoteSelectionEvents: unknown[] })
            .quoteSelectionEvents,
      );
      throw new Error(
        `${String(error)} ${JSON.stringify({ diagnostic, delivered })}`,
      );
    }
    const cleanQuote = page.getByRole("dialog", {
      name: "引用 1 的评论",
      exact: true,
    });
    const cleanDraft = page
      .getByRole("group", { name: "选文与评论" })
      .getByRole("button", { name: "编辑引用 1 的评论", exact: true });
    await expect(cleanQuote).toBeInViewport();
    // The host input was explicitly hidden before selecting guest text. The
    // standalone quote editor does not reopen it; check its exact saved draft.
    await expectDraft("native 200 percent selection comment opened", false);
    const zoomedCommentBounds = (await cleanQuote.boundingBox())!;
    expect(zoomedCommentBounds.width).toBeLessThanOrEqual(260);
    expect(zoomedCommentBounds.height).toBeLessThanOrEqual(60);
    await expect(
      cleanQuote.locator("header, blockquote, footer, button"),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectDraft("native 200 percent selection comment Escape", false);
    await expect(cleanDraft).toHaveAttribute(
      "title",
      /TEST 网页画布，TEST 可见尾句/,
    );
    await expect(cleanDraft).toHaveAttribute("title", /TEST 第二行/);
    await expect(cleanDraft).not.toHaveAttribute("title", /PRIVATE_/);
    await desktop.evaluate(async ({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
      await site.executeJavaScript("getSelection().removeAllRanges()");
    });
    await page
      .getByRole("group", { name: "选文与评论" })
      .getByRole("button", { name: "查看引用 1 的原文", exact: true })
      .click();
    await expect
      .poll(() =>
        desktop.evaluate(async ({ webContents }) => {
          const site = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
          return site.executeJavaScript("getSelection().toString().trim()");
        }),
      )
      .toBe("TEST 网页画布，TEST 可见尾句\nTEST 第二行");
    await openInput(page);
    await expectDraft(
      "native 200 percent quote original reveal and input reopen",
    );
    await page.getByRole("button", { name: "移除引用 1", exact: true }).click();
    await expect(input).toBeFocused();
    await expectDraft("native 200 percent quote removal");
  } finally {
    try {
      const page = desktop.windows().find((p) => p.url() === "morphz://app/");
      const renderer = page
        ? await page
            .evaluate(
              () =>
                (
                  window as unknown as {
                    browserExchangeGestureDiagnostic?: unknown[];
                  }
                ).browserExchangeGestureDiagnostic ?? [],
            )
            .catch((error: unknown) => ({ unavailable: String(error) }))
        : { unavailable: "Host page closed" };
      const native = await desktop
        .evaluate(
          () =>
            (
              globalThis as unknown as {
                browserExchangeNativeDiagnostic?: unknown[];
              }
            ).browserExchangeNativeDiagnostic ?? [],
        )
        .catch((error: unknown) => ({ unavailable: String(error) }));
      await info.attach("browser-exchange-gesture-diagnostic", {
        body: Buffer.from(JSON.stringify({ dragRequests, renderer, native })),
        contentType: "application/json",
      });
    } finally {
      await desktop.close();
      await rm(fixture, { recursive: true, force: true });
    }
  }
});
