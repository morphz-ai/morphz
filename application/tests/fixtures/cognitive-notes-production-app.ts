/** Complete production App/main/styles against the existing isolated real
 * center and author. No renderer bridge, controlled boot DTO, routed API,
 * fixture business reply or second manual application is used here. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
} from "@playwright/test";
import { createAppServer } from "../../apps/service/src/http.js";
import { ProfileService } from "../../packages/application/src/profile-service.js";
import { Notifications } from "../../packages/application/src/notifications.js";
import type { NotesGuiTransports } from "./cognitive-notes-gui-transports.js";
import {
  applicationStoragePrefix,
  applicationWindowKey,
} from "../../packages/core/src/application-names.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import { platformContentSchema } from "../../apps/web/src/platform-client.js";

/** Public automatic-fixture login configuration. The frozen transport fixture
 * initializes its real IdentityCenter member from SHA256 of this synthetic
 * value. Native acceptance must submit it through the actual login form, not
 * manufacture a cookie/session/actor or read a user's credentials. */
export const notesProductionLoginToken = "a".repeat(64);

/** Controlled delivery timing ONLY, after the unchanged real HTTP handler has
 * completed its SQL/HPA operation and supplied its successful original JSON.
 * No request/DTO/header/API/author reply is manufactured or browser API patched.
 * A retired App's real abort may discard this body; release does not bypass it. */
function notesResolutionResponseHolds(
  server: ReturnType<typeof createAppServer>,
  f: NotesGuiTransports,
) {
  type Gate = {
    objectId: string;
    instanceId: string;
    capture(value: {
      path: string;
      query: Record<string, string>;
      status: number;
      body: string;
      source: ReturnType<typeof platformContentSchema.parse>;
      at: number;
    }): void;
    fail(error: Error): void;
    markClosed(value: { at: number; destroyed: boolean }): void;
    failClosed(error: Error): void;
    deliver?: () => void;
    restore?: () => void;
    releaseCount: number;
    events: { at: number; event: string; destroyed?: boolean }[];
  };
  let next: Gate | undefined;
  const gates = new Set<Gate>();
  const observe = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://isolated.invalid");
    const gate = next;
    if (
      !gate ||
      request.method !== "GET" ||
      url.pathname !== "/api/platform/content/resolve" ||
      url.searchParams.size !== 3 ||
      url.searchParams.get("appId") !== f.target.appId ||
      url.searchParams.get("instanceId") !== gate.instanceId ||
      url.searchParams.get("appObjectId") !== gate.objectId
    )
      return;
    next = undefined;
    gate.events.push({ at: Date.now(), event: "real-request" });
    const end = response.end;
    const restore = () => {
      response.end = end;
      gate.restore = undefined;
    };
    gate.restore = restore;
    response.once("close", () => {
      restore();
      const at = Date.now();
      gate.events.push({
        at,
        event: "response-close",
        destroyed: response.destroyed,
      });
      gate.markClosed({ at, destroyed: response.destroyed });
    });
    response.once("finish", () => {
      gate.events.push({ at: Date.now(), event: "real-finish" });
    });
    response.end = ((...args: unknown[]) => {
      // The production json() writer uses precisely this original string.
      // Non-success/malformed responses remain real failures, not new fixtures.
      restore();
      if (response.statusCode !== 200 || typeof args[0] !== "string") {
        gate.fail(
          new Error("The actual resolver did not return JSON HTTP200."),
        );
        return Reflect.apply(end, response, args);
      }
      const body = args[0];
      let source: ReturnType<typeof platformContentSchema.parse>;
      try {
        source = platformContentSchema.parse(JSON.parse(body));
        assert.equal(source.appId, f.target.appId);
        assert.equal(source.instanceId, gate.instanceId);
        assert.equal(source.appObjectId, gate.objectId);
        assert.equal(source.projectId, f.projectId);
      } catch (error) {
        gate.fail(error instanceof Error ? error : new Error(String(error)));
        return Reflect.apply(end, response, args);
      }
      gate.deliver = () => {
        gate.events.push({
          at: Date.now(),
          event: "release-original-end",
          destroyed: response.destroyed,
        });
        // Same response, exact same args/bytes and original writer, once. A
        // closed socket is not rescued or replaced with a successful reply.
        Reflect.apply(end, response, args);
      };
      response.flushHeaders();
      gate.events.push({ at: Date.now(), event: "real-200-body-held" });
      gate.capture({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        status: response.statusCode,
        body,
        source,
        at: Date.now(),
      });
      return response;
    }) as typeof response.end;
  };
  server.prependListener("request", observe);
  return {
    next(objectId: string, instanceId: string) {
      assert.equal(next, undefined, "only one explicitly armed resolver slot");
      let capture!: Gate["capture"], fail!: Gate["fail"];
      const captured = new Promise<Parameters<Gate["capture"]>[0]>(
        (done, reject) => {
          capture = done;
          fail = reject;
        },
      );
      // Observe cleanup rejection, preserving the original required promise.
      void captured.catch(() => undefined);
      let markClosed!: Gate["markClosed"], failClosed!: Gate["failClosed"];
      const closed = new Promise<Parameters<Gate["markClosed"]>[0]>(
        (done, reject) => {
          markClosed = done;
          failClosed = reject;
        },
      );
      void closed.catch(() => undefined);
      const gate: Gate = {
        objectId,
        instanceId,
        capture,
        fail,
        markClosed,
        failClosed,
        releaseCount: 0,
        events: [],
      };
      next = gate;
      gates.add(gate);
      return {
        captured,
        closed,
        events: gate.events,
        release() {
          assert.ok(gate.deliver, "real successful resolver response was held");
          assert.equal(gate.releaseCount, 0, "original response releases once");
          gate.releaseCount++;
          gate.deliver();
        },
      };
    },
    close() {
      server.removeListener("request", observe);
      next = undefined;
      const errors: unknown[] = [];
      for (const gate of gates) {
        // A failed delivery cannot leave another isolated response patched or
        // held. Owner cleanup outside this helper remains nested finally.
        try {
          gate.restore?.();
        } catch (error) {
          errors.push(error);
        }
        try {
          if (!gate.releaseCount && gate.deliver) {
            gate.releaseCount++;
            gate.deliver();
          } else if (!gate.deliver) {
            const error = new Error(
              "Isolated resolver hold was closed before capture.",
            );
            gate.fail(error);
            gate.failClosed(error);
          }
        } catch (error) {
          errors.push(error);
        }
      }
      gates.clear();
      if (errors.length)
        throw new AggregateError(
          errors,
          "Isolated resolver hold cleanup failed.",
        );
    },
  };
}

export async function buildNotesProductionUi() {
  const root = await mkdtemp(resolve(tmpdir(), "morphz-notes-production-ui-"));
  const webRoot = resolve(root, "web");
  try {
    // Actual production entry, CSS order, lazy chunks and PDF asset loader.
    // Do not read the user's environment files or write the repository dist.
    await build({
      configFile: resolve("vite.config.ts"),
      mode: "test",
      envDir: root,
      build: { outDir: webRoot, emptyOutDir: true },
    });
    assert.ok(existsSync(resolve(webRoot, "index.html")));
    return { webRoot, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function openNotesProductionApp(
  f: NotesGuiTransports,
  webRoot: string,
) {
  const authority = f.local.application.options.platformWork!.authority;
  const versions: {
    version: string;
    accessVersion: string;
    projectIds: string[];
  }[] = [];
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done, fail) =>
    probe.close((error) => (error ? fail(error) : done())),
  );
  const server = createAppServer(f.local.application.store, {
    ...f.local.application.options,
    profiles: {
      authority,
      service: new ProfileService(() => undefined, f.platform),
    },
    notifications: new Notifications(f.platform, authority),
    workspaceChanges: {
      sources: [f.platform.changeSource()],
      async readVersion(access, assertActive) {
        // Access comes from the real authenticated HTTP session, never a
        // fixture actor. Version/access hashes come from the actual SQL read.
        return authority.withSession(access, assertActive, async (actor) => {
          assertActive();
          const value = await f.platform.workspaceChangeVersion(actor);
          assertActive();
          versions.push({
            version: value.version,
            accessVersion: value.accessVersion,
            projectIds: [...value.projectIds],
          });
          return value;
        });
      },
    },
    port,
    webRoot,
  });
  const resolutionHolds = notesResolutionResponseHolds(server, f);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let network: CDPSession | undefined;
  const close = async () => {
    try {
      resolutionHolds.close();
    } finally {
      await network?.detach().catch(() => undefined);
      try {
        await context?.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          if (server.listening)
            await new Promise<void>((done, fail) =>
              server.close((error) => (error ? fail(error) : done())),
            );
        }
      }
    }
  };
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${port}`;
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "formal entry requires actual Chromium",
    );
    browser = await chromium.launch({ headless: true, executablePath });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const cookie = f.local.authenticationCookie();
    assert.ok(
      cookie,
      "existing actual IdentityCenter login must have a cookie",
    );
    const cookiePrefix = f.identity.cookieName + "=";
    assert.ok(cookie.startsWith(cookiePrefix));
    await context.addCookies([
      {
        name: f.identity.cookieName,
        value: cookie.slice(cookiePrefix.length),
        url: origin,
      },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    const requests: { method: string; path: string; body: string | null }[] =
      [];
    const responses: { method: string; path: string; status: number }[] = [];
    const trace: { at: number; event: string; path: string; value: unknown }[] =
      [];
    // Observe actual browser endpoint/parser lifetime without lending a peer
    // authority, replacing a response, or adding a readiness retry.
    const lifecycle = (event: string) => (frame: Frame) =>
      trace.push({
        at: Date.now(),
        event: `frame-lifecycle:${event}`,
        path: frame.url(),
        value: {
          detached: frame.isDetached(),
          parent: frame.parentFrame()?.url() ?? null,
        },
      });
    page.on("frameattached", lifecycle("frameattached"));
    page.on("framenavigated", lifecycle("framenavigated"));
    page.on("framedetached", lifecycle("framedetached"));
    page.on("console", (message) => {
      if (message.type() === "error")
        trace.push({
          at: Date.now(),
          event: "browser-console-error",
          path: message.location().url,
          value: message.text(),
        });
    });
    // Read-only actual Chromium wire observation. No request interception,
    // response fixture, EventSource replacement or browser API monkey patch.
    network = await context.newCDPSession(page);
    const streams = new Set<string>();
    const resolutions = new Set<string>();
    const streamPath = "/api/platform/workspace/stream";
    network.on("Network.requestWillBeSent", (event) => {
      const path = new URL(event.request.url).pathname;
      if (path === "/api/platform/content/resolve") {
        resolutions.add(event.requestId);
        trace.push({
          at: Date.now(),
          event: "resolver-request",
          path,
          value: event.requestId,
        });
      }
      if (path !== streamPath) return;
      streams.add(event.requestId);
      trace.push({
        at: Date.now(),
        event: "sse-request",
        path: streamPath,
        value: event.requestId,
      });
    });
    network.on("Network.eventSourceMessageReceived", (event) => {
      if (!streams.has(event.requestId)) return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        value = event.data;
      }
      trace.push({
        at: Date.now(),
        event: "sse-message",
        path: streamPath,
        value,
      });
    });
    network.on("Network.loadingFailed", (event) => {
      if (resolutions.delete(event.requestId))
        trace.push({
          at: Date.now(),
          event: "resolver-closed",
          path: "/api/platform/content/resolve",
          value: {
            requestId: event.requestId,
            error: event.errorText,
            cancelled: event.canceled,
          },
        });
      if (!streams.delete(event.requestId)) return;
      trace.push({
        at: Date.now(),
        event: "sse-closed",
        path: streamPath,
        value: {
          requestId: event.requestId,
          error: event.errorText,
          cancelled: event.canceled,
        },
      });
    });
    network.on("Network.loadingFinished", (event) => {
      if (resolutions.delete(event.requestId))
        trace.push({
          at: Date.now(),
          event: "resolver-finished",
          path: "/api/platform/content/resolve",
          value: event.requestId,
        });
      if (!streams.delete(event.requestId)) return;
      trace.push({
        at: Date.now(),
        event: "sse-finished",
        path: streamPath,
        value: event.requestId,
      });
    });
    await network.send("Network.enable");
    const responseReads = new Set<Promise<void>>();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/"))
        requests.push({
          method: request.method(),
          path,
          body: request.postData(),
        });
      if (path.includes("/cognitive-app"))
        trace.push({
          at: Date.now(),
          event: "request",
          path,
          value: request.postData(),
        });
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/api/"))
        responses.push({
          method: response.request().method(),
          path,
          status: response.status(),
        });
      if (path.includes("/cognitive-app")) {
        const read = response.json().then(
          (value: unknown) => {
            trace.push({
              at: Date.now(),
              event: `response:${response.status()}`,
              path,
              // Immutable installed HTML is already hash-verified by the real
              // pipeline. Retain all response metadata/CAS, not megabytes of
              // repeated author bundles in a failure diagnostic.
              value: JSON.parse(
                JSON.stringify(value, (key, field: unknown) =>
                  key === "html" && typeof field === "string"
                    ? `[omitted ${new TextEncoder().encode(field).byteLength} installed UTF-8 bytes]`
                    : field,
                ),
              ),
            });
          },
          () => undefined,
        );
        responseReads.add(read);
        void read.finally(() => responseReads.delete(read));
      }
    });
    await page.goto(origin + "/");
    try {
      await page
        .getByRole("button", {
          name: "TEST isolated actual notes GUI",
          exact: true,
        })
        .waitFor();
    } catch (error) {
      const screenshot = `/tmp/morphz-production-notes-boot-${f.tenantId}-oct06.png`;
      await page.screenshot({ path: screenshot });
      assert.fail(
        JSON.stringify({
          error: String(error),
          screenshot,
          errors,
          responses,
          body: (await page.locator("body").innerText()).slice(0, 2000),
        }),
      );
    }
    if (
      !responses.some(
        (r) => r.path === "/api/platform/workspace/stream" && r.status === 200,
      )
    )
      await page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/platform/workspace/stream" && response.status() === 200,
      );
    assert.ok(
      versions.length,
      "real HPA/SQL change observer must have read its first version",
    );
    return {
      page,
      origin,
      errors,
      requests,
      responses,
      versions,
      trace,
      holdNextResolution: resolutionHolds.next,
      close,
      async diagnostics(label: string, failure?: unknown) {
        // Read-only evidence, not a renderer lifecycle hook or authority. Never
        // seed preferences, rescue an old Document or suppress the real SSE.
        await Promise.all([...responseReads]);
        const screenshot = `/tmp/morphz-production-notes-${label}-${f.tenantId}-oct06.png`;
        await page.screenshot({ path: screenshot });
        console.log(
          JSON.stringify({
            label,
            failure:
              failure instanceof Error
                ? {
                    name: failure.name,
                    message: failure.message,
                    stack: failure.stack,
                  }
                : failure,
            screenshot,
            errors,
            responses,
            versions,
            trace,
            // Exact isolated SQL facts disambiguate a lost projection/hint
            // from an uncommitted grant. Never query a user's business store.
            grants: await f.rows("cognitive_app_grants"),
            connections: await f.rows("cognitive_app_connections"),
            body: (await page.locator("body").innerText()).slice(0, 4000),
            location: await page.evaluate(
              ({ prefix, center, principal }) =>
                JSON.parse(
                  localStorage.getItem(
                    `${prefix}${center}:${principal}:preferences`,
                  ) || "{}",
                ).cognitiveLocation,
              {
                prefix: applicationStoragePrefix,
                center: f.tenantId,
                principal: f.principalId,
              },
            ),
          }),
        );
      },
      async stored() {
        return page.evaluate(
          ({ prefix, windowKey, center, principal }) => {
            const owner = sessionStorage.getItem(windowKey);
            if (!owner)
              throw new Error("actual persistent window owner is missing");
            const key = `${prefix}${center}:${principal}:draft:${owner}:inputs`;
            return JSON.parse(localStorage.getItem(key) || "{}");
          },
          {
            prefix: applicationStoragePrefix,
            windowKey: applicationWindowKey,
            center: f.tenantId,
            principal: f.principalId,
          },
        ) as Promise<Record<string, InputDraft>>;
      },
      async preferences() {
        return page.evaluate(
          ({ prefix, center, principal }) =>
            JSON.parse(
              localStorage.getItem(
                `${prefix}${center}:${principal}:preferences`,
              ) || "{}",
            ),
          {
            prefix: applicationStoragePrefix,
            center: f.tenantId,
            principal: f.principalId,
          },
        );
      },
      async recentContent() {
        return page.evaluate(
          ({ prefix, center, principal }) =>
            JSON.parse(
              localStorage.getItem(
                `${prefix}${center}:${principal}:recent-content`,
              ) || "[]",
            ) as { artifactId: string; openedAt: number }[],
          {
            prefix: applicationStoragePrefix,
            center: f.tenantId,
            principal: f.principalId,
          },
        );
      },
      async appearance(mode: "light" | "dark") {
        // The original Human settings controls and preference writer. No local
        // storage seed, media-query override or author-context fixture update.
        await page
          .getByRole("button", { name: "用户菜单", exact: true })
          .click();
        await page
          .getByRole("group", { name: "用户菜单", exact: true })
          .getByRole("button", { name: "外观设置", exact: true })
          .click();
        const settings = page.getByRole("dialog", {
          name: "设置",
          exact: true,
        });
        await settings
          .getByRole("group", { name: "外观模式", exact: true })
          .getByRole("button", {
            name: mode === "light" ? "亮色" : "暗色",
            exact: true,
          })
          .click();
        await settings
          .getByRole("button", { name: "关闭设置", exact: true })
          .click();
        await settings.waitFor({ state: "hidden" });
      },
      async openGui() {
        await page
          .locator(".sidebar-project-list")
          .getByRole("button", {
            name: "TEST isolated actual notes GUI",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", {
            name: "打开界面：独立笔记 1.1.0",
            exact: true,
          })
          .click();
        const picker = page.getByRole("dialog", {
          name: "打开应用界面",
          exact: true,
        });
        await picker
          .getByRole("button", {
            name: `打开独立笔记 1.1.0，数据连接 ${f.target.connectionId}`,
            exact: true,
          })
          .click();
        const outerElement = page.locator("iframe.cognitive-application-frame");
        const readyDeadline = Date.now() + 12_000;
        const remaining = () => {
          const timeout = readyDeadline - Date.now();
          assert.ok(timeout > 0, "actual published GUI readiness timed out");
          return timeout;
        };
        await outerElement.waitFor({ timeout: remaining() });
        // Choosing is a real async Human operation; click delivery alone does
        // not publish its final Document. Resolve readiness against the current
        // DOM before borrowing a Frame, rather than retaining an initial or
        // previously restoring WindowProxy. This is no read/click retry.
        await outerElement
          .contentFrame()
          .locator("iframe")
          .waitFor({ timeout: remaining() });
        await outerElement
          .contentFrame()
          .frameLocator("iframe")
          .locator("#connection")
          .filter({ hasText: /^工作区已连接$/ })
          .waitFor({ timeout: remaining() });
        const handle = await outerElement.elementHandle({
          timeout: remaining(),
        });
        const outer = await handle!.contentFrame();
        assert.ok(outer);
        const currentOuter = await handle!.evaluate((node) => ({
          src: (node as HTMLIFrameElement).src,
          connected: node.isConnected,
        }));
        assert.equal(currentOuter.connected, true);
        assert.equal(outer.isDetached(), false);
        assert.equal(
          await outerElement.evaluate(
            (node, captured) => node === captured,
            handle,
          ),
          true,
          "captured outer is still the actual published DOM element",
        );
        assert.equal(outer.url(), currentOuter.src);
        const proof = new URL(currentOuter.src).searchParams.get(
          "documentProof",
        );
        assert.ok(proof);
        trace.push({
          at: Date.now(),
          event: "gui-published-frame",
          path: outer.url(),
          value: {
            elementSrc: currentOuter.src,
            capturedUrl: outer.url(),
            proof,
            connected: currentOuter.connected,
            elapsedMs: 12_000 - remaining(),
          },
        });
        try {
          await outer.waitForFunction(
            () => document.querySelector("iframe") !== null,
            undefined,
            { timeout: remaining() },
          );
        } catch (error) {
          trace.push({
            at: Date.now(),
            event: "outer-parser-readiness-failed",
            path: outer.url(),
            value: {
              capturedOuterDetached: outer.isDetached(),
              capturedOuterChildren: outer.childFrames().map((frame) => ({
                url: frame.url(),
                detached: frame.isDetached(),
              })),
              currentFrames: page.frames().map((frame) => ({
                url: frame.url(),
                parent: frame.parentFrame()?.url() ?? null,
                detached: frame.isDetached(),
              })),
              currentElements: await page
                .locator("iframe.cognitive-application-frame")
                .evaluateAll((frames) =>
                  frames.map((frame) => ({
                    src: (frame as HTMLIFrameElement).src,
                    connected: frame.isConnected,
                    hidden: (frame as HTMLIFrameElement).hidden,
                  })),
                ),
              parser: await outer
                .evaluate(() => ({
                  href: location.href,
                  readyState: document.readyState,
                  htmlLength: document.documentElement?.outerHTML.length,
                  bodyText: document.body?.textContent?.slice(0, 1000),
                  innerCount: document.querySelectorAll("iframe").length,
                  scripts: [...document.scripts].map((script) => ({
                    source: script.src,
                    bytes: script.textContent?.length,
                  })),
                }))
                .catch((error: unknown) => ({ error: String(error) })),
            },
          });
          throw error;
        }
        // A real DOM iframe can precede Chromium's frameattached publication.
        // Wait for the actual author connection, not an arbitrary duration or
        // an immediately sampled childFrames array during fresh restore.
        await outer
          .frameLocator("iframe")
          .locator("#connection")
          .filter({ hasText: /^工作区已连接$/ })
          .waitFor({ timeout: remaining() });
        const guest = outer.childFrames()[0];
        assert.ok(guest);
        await guest.waitForFunction(
          () =>
            document.getElementById("connection")?.textContent ===
            "工作区已连接",
          undefined,
          { timeout: remaining() },
        );
        const started = Date.now();
        page.on("framedetached", (frame) => {
          if (frame === guest || frame === outer)
            trace.push({
              at: Date.now(),
              event: "frame-detached",
              path: frame.url(),
              value: { afterOpenMs: Date.now() - started },
            });
        });
        return { guest, outer, outerElement };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type NotesProductionApp = Awaited<
  ReturnType<typeof openNotesProductionApp>
>;
