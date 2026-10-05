/** Actual isolated Electron production main/preload/custom scheme + Remote.
 * The existing notes center, HPA/SQL and packed author are not replaced. This
 * is not Local embedded, the installed user's App, or online Runtime acceptance.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  _electron,
  expect,
  type ElectronApplication,
  type Frame,
} from "@playwright/test";
import {
  applicationStoragePrefix,
  applicationWindowKey,
} from "../../packages/core/src/application-names.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import type { NotesGuiTransports } from "./cognitive-notes-gui-transports.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function environment() {
  const value: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "DISPLAY",
    "XDG_RUNTIME_DIR",
  ])
    if (process.env[name] !== undefined) value[name] = process.env[name];
  return value;
}
function desktopFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return desktopFiles(path);
    assert.ok(entry.isFile(), "production desktop source is an ordinary file");
    return [path];
  });
}

/** Build current actual server source only into this generated shadow tree.
 * Production main and all desktop source bytes are copied without transforms.
 * No repository dist, installed bundle or original profile is written.
 */
export async function buildNotesNativeProduction(webRoot: string) {
  assert.ok(existsSync(join(webRoot, "index.html")));
  const root = await mkdtemp(join(tmpdir(), "morphz-notes-native-production-"));
  try {
    const source = resolve("apps/desktop");
    const desktop = join(root, "apps/desktop");
    mkdirSync(join(root, "dist"), { recursive: true });
    cpSync(source, desktop, { recursive: true });
    cpSync(resolve("package.json"), join(root, "package.json"));
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    symlinkSync(webRoot, join(root, "dist/web"), "dir");
    const hashes = desktopFiles(source)
      .sort()
      .map((file) => {
        const path = relative(source, file);
        const sourceHash = hash(readFileSync(file));
        const copyHash = hash(readFileSync(join(desktop, path)));
        assert.equal(
          copyHash,
          sourceHash,
          `unchanged production desktop ${path}`,
        );
        return { path, sourceHash, copyHash };
      });
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "-p",
        resolve("tsconfig.server.json"),
        "--outDir",
        join(root, "dist/service"),
        "--pretty",
        "false",
      ],
      { cwd: resolve("."), env: environment(), timeout: 90_000 },
    );
    const main = join(desktop, "main.cjs");
    assert.ok(
      existsSync(join(root, "dist/service/apps/desktop/remote-host.js")),
    );
    return {
      root,
      main,
      hashes,
      uiEntrySha256: hash(readFileSync(join(webRoot, "index.html"))),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export type NotesNativeBuild = Awaited<
  ReturnType<typeof buildNotesNativeProduction>
>;

export async function openNotesNativeProduction(
  f: NotesGuiTransports,
  build: NotesNativeBuild,
  origin: string,
  loginToken: string,
) {
  const url = new URL(origin);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/");
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  const profile = await mkdtemp(join(build.root, "profile-"));
  let electron: ElectronApplication | undefined;
  let stderr = "";
  const close = async () => {
    try {
      await electron?.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  };
  try {
    // This is an automated isolated process, not another manual user App.
    // Actual main reads its real supported profile variable and --center arg.
    electron = await _electron.launch({
      args: [build.main, `--center=${origin}`],
      cwd: build.root,
      env: {
        ...environment(),
        MORPHZ_APP_PROFILE: profile,
        MORPHZ_APP_ENV_FILE: "",
      },
      timeout: 30_000,
    });
    electron.process().stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-12_000);
    });
    await expect
      .poll(
        () =>
          electron!.windows().some((page) => page.url() === "morphz://app/"),
        { timeout: 30_000 },
      )
      .toBe(true);
    const page = electron
      .windows()
      .find((value) => value.url() === "morphz://app/")!;
    page.setDefaultTimeout(12_000);
    // Read-only native network evidence: observe the real main session's
    // requests without replacing fetch, connection.invoke, resources or replies.
    // Only the two synthetic receipt request bodies are retained, never login
    // or cookie/credential headers. This main-process observation is not a
    // renderer capability or production API.
    await electron.evaluate(({ BrowserWindow }, center) => {
      const owner = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "morphz://app/",
      );
      if (!owner) throw Error("actual native owning window is missing");
      const trace: {
        path: string;
        commandId: string | null;
        status: number;
      }[] = [];
      const pending = new Map<
        number,
        { path: string; commandId: string | null }
      >();
      const filter = { urls: [center + "/api/platform/cognitive-apps/*"] };
      const requests = owner.webContents.session.webRequest;
      requests.onBeforeRequest(filter, (details, callback) => {
        try {
          const path = new URL(details.url).pathname;
          if (path.endsWith("/command-status") || path.endsWith("/recover")) {
            const bytes = details.uploadData?.flatMap((entry) =>
              entry.bytes ? [entry.bytes] : [],
            );
            const body = bytes?.length
              ? JSON.parse(Buffer.concat(bytes).toString("utf8"))
              : {};
            pending.set(details.id, {
              path,
              commandId:
                typeof body.commandId === "string" ? body.commandId : null,
            });
          }
        } finally {
          // The observation never decides authorization or stalls a request.
          callback({ cancel: false });
        }
      });
      requests.onCompleted(filter, (details) => {
        const request = pending.get(details.id);
        if (request) {
          pending.delete(details.id);
          trace.push({ ...request, status: details.statusCode });
        }
      });
      requests.onErrorOccurred(filter, (details) => pending.delete(details.id));
      Reflect.set(globalThis, "__notesNativeRemoteTrace", trace);
    }, origin);
    const errors: string[] = [];
    const responses: { path: string; status: number }[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/"))
        responses.push({ path: url.pathname, status: response.status() });
    });
    // Fresh native Remote authentication goes through the real login form,
    // Remote connection, IdentityCenter and actual main bridge. No cookies are
    // imported from the Chromium fixture or the original user's session.
    await page
      .getByRole("heading", { name: "登录 Morphz", exact: true })
      .waitFor();
    await page.getByLabel("登录凭据", { exact: true }).fill(loginToken);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page
      .getByRole("button", {
        name: "TEST isolated actual notes GUI",
        exact: true,
      })
      .waitFor();
    const bootstrap = await page.evaluate(async () => {
      const reply = await window.morphzDesktop!.application!.invoke({
        id: crypto.randomUUID(),
        method: "platform.bootstrap",
      });
      if (!reply.ok) throw Error(reply.error.message);
      const value = reply.value as {
        centerId: string;
        principalId: string;
        actantId: string;
      };
      return {
        centerId: value.centerId,
        principalId: value.principalId,
        actantId: value.actantId,
      };
    });
    assert.deepEqual(bootstrap, {
      centerId: f.tenantId,
      principalId: f.principalId,
      actantId: f.actantId,
    });
    const native = await electron.evaluate(({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().filter(
        (window) => window.webContents.getURL() === "morphz://app/",
      );
      const window = windows[0];
      const method =
        window && Reflect.get(window.webContents, "getLastWebPreferences");
      if (typeof method !== "function")
        throw Error("actual native preferences reader is absent");
      const preferences = method.call(window!.webContents) as {
        sandbox: boolean;
        nodeIntegration: boolean;
        contextIsolation: boolean;
      };
      return {
        userData: app.getPath("userData"),
        name: app.getName(),
        windows: windows.length,
        sandbox: preferences?.sandbox,
        nodeIntegration: preferences?.nodeIntegration,
        contextIsolation: preferences?.contextIsolation,
      };
    });
    assert.deepEqual(native, {
      userData: profile,
      name: "Morphz",
      windows: 1,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    });
    assert.deepEqual(
      await page.evaluate(() => ({
        protocol: location.protocol,
        host: location.host,
        secure: isSecureContext,
        node: typeof Reflect.get(window, "require"),
      })),
      { protocol: "morphz:", host: "app", secure: true, node: "undefined" },
    );
    return {
      page,
      electron,
      profile,
      bootstrap,
      responses,
      errors,
      close,
      async remoteRequests() {
        return electron!.evaluate(() =>
          Reflect.get(globalThis, "__notesNativeRemoteTrace"),
        ) as Promise<
          { path: string; commandId: string | null; status: number }[]
        >;
      },
      async diagnostics(label: string) {
        const screenshot = join(
          tmpdir(),
          `morphz-notes-native-${label}-${f.tenantId}-oct06.png`,
        );
        await page.screenshot({ path: screenshot });
        console.log(
          JSON.stringify({
            label,
            screenshot,
            bootstrap,
            responses,
            errors,
            stderr,
            frames: page.frames().map((frame) => frame.url()),
            text: (await page.locator("body").innerText()).slice(0, 3500),
          }),
        );
      },
      async stored() {
        return page.evaluate(
          ({ prefix, key, center, principal }) => {
            const owner = sessionStorage.getItem(key);
            if (!owner)
              throw Error("actual native persistent window owner is absent");
            return JSON.parse(
              localStorage.getItem(
                `${prefix}${center}:${principal}:draft:${owner}:inputs`,
              ) || "{}",
            );
          },
          {
            prefix: applicationStoragePrefix,
            key: applicationWindowKey,
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
      async currentGuest() {
        const element = page.locator("iframe.cognitive-application-frame");
        await element.waitFor();
        const outer = await (await element.elementHandle())!.contentFrame();
        assert.ok(outer);
        const inner = outer.locator("iframe");
        await inner.waitFor();
        const guest = await (await inner.elementHandle())!.contentFrame();
        assert.ok(guest);
        await expect(guest.locator("#connection")).toHaveText("工作区已连接");
        return { element, outer, guest };
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
        await page
          .getByRole("dialog", { name: "打开应用界面", exact: true })
          .getByRole("button", {
            name: `打开独立笔记 1.1.0，数据连接 ${f.target.connectionId}`,
            exact: true,
          })
          .click();
        return this.currentGuest();
      },
    };
  } catch (error) {
    console.log(JSON.stringify({ stage: "native-production-start", stderr }));
    await close();
    throw error;
  }
}
export type NotesNativeProduction = Awaited<
  ReturnType<typeof openNotesNativeProduction>
>;
export async function notesNativeStatus(guest: Frame, value: string) {
  await expect(guest.locator("#status")).toContainText(value);
}
