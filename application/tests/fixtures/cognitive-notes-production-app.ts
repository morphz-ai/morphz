/** Complete production App/main/styles against the existing isolated real
 * center and author. No renderer bridge, controlled boot DTO, routed API,
 * fixture business reply or second manual application is used here. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
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

/** Public automatic-fixture login configuration. The frozen transport fixture
 * initializes its real IdentityCenter member from SHA256 of this synthetic
 * value. Native acceptance must submit it through the actual login form, not
 * manufacture a cookie/session/actor or read a user's credentials. */
export const notesProductionLoginToken = "a".repeat(64);

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
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let network: CDPSession | undefined;
  const close = async () => {
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
    // Read-only actual Chromium wire observation. No request interception,
    // response fixture, EventSource replacement or browser API monkey patch.
    network = await context.newCDPSession(page);
    const streams = new Set<string>();
    const streamPath = "/api/platform/workspace/stream";
    network.on("Network.requestWillBeSent", (event) => {
      if (new URL(event.request.url).pathname !== streamPath) return;
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
        await outerElement.waitFor();
        const handle = await outerElement.elementHandle();
        const outer = await handle!.contentFrame();
        assert.ok(outer);
        await outer.waitForFunction(
          () => document.querySelector("iframe") !== null,
        );
        // A real DOM iframe can precede Chromium's frameattached publication.
        // Wait for the actual author connection, not an arbitrary duration or
        // an immediately sampled childFrames array during fresh restore.
        await outer
          .frameLocator("iframe")
          .locator("#connection")
          .filter({ hasText: /^工作区已连接$/ })
          .waitFor();
        const guest = outer.childFrames()[0];
        assert.ok(guest);
        await guest.waitForFunction(
          () =>
            document.getElementById("connection")?.textContent ===
            "工作区已连接",
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
