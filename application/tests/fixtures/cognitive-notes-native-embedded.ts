/** Real production Electron main creates its own embedded SQLite center.
 * Public Human setup/business use the actual restricted IPC; HTML uses the
 * actual morphz resource handler and private Local pipeline, not public IPC or
 * an application HTTP server. No user's App/profile/Runtime is opened here.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  _electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { ApplicationMethod } from "../../packages/core/src/application-api.js";
import {
  parseCognitiveAppInstalled,
  parseCognitiveAppGrant,
  parseCognitiveAppConnection,
} from "../../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppViewResponse } from "../../packages/core/src/cognitive-app-view-api.js";
import {
  applicationStoragePrefix,
  applicationWindowKey,
} from "../../packages/core/src/application-names.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import type { NotesNativeBuild } from "./cognitive-notes-native-production.js";
import { notesProductionLoginToken } from "./cognitive-notes-production-app.js";
import {
  startNotesGuiAuthor,
  type packCognitiveNotesGui,
} from "./cognitive-notes-gui-package.js";

const principalId = "alice",
  actantId = "alice-human",
  projectId = "project-a",
  connectionId = "actual-embedded-author-connection";
// The same existing synthetic author integration value, not a user's secret or
// a newly issued external credential. Only this dedicated name enters main.
const credential = "isolated_gui_author_credential_abcdefghijklmnopqrstuvwxyz";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const platformTables = [
  "projects",
  "tasks",
  "conversations",
  "cognitive_app_versions",
  "cognitive_app_registrations",
  "cognitive_app_grants",
  "cognitive_app_connections",
  "cognitive_app_authorities",
  "cognitive_app_commands",
  "app_instances",
  "app_view_instances",
  "cognitive_app_view_bindings",
  "content_entries",
] as const;
const authorTables = [
  "notes",
  "note_versions",
  "author_commands",
  "author_definitions",
  "metadata",
  "project_acl",
] as const;
const transportTables = [
  "runtime_sessions",
  "runtime_deliveries",
  "runtime_publications",
  "runtime_thread_bindings",
  "runtime_session_events",
] as const;
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
function rows(filename: string, table: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
}

export async function openNotesNativeEmbedded(
  build: NotesNativeBuild,
  packed: ReturnType<typeof packCognitiveNotesGui>,
) {
  const root = await mkdtemp(join(tmpdir(), "morphz-notes-native-embedded-"));
  const directory = join(root, "center"),
    profile = join(root, "profile"),
    authorDirectory = join(root, "author"),
    database = join(authorDirectory, "author.sqlite"),
    bindingsFile = join(root, "bindings.json");
  let electron: ElectronApplication | undefined;
  let author: Awaited<ReturnType<typeof startNotesGuiAuthor>> | undefined;
  let page: Page | undefined;
  let stderr = "";
  const errors: string[] = [];
  const requests: string[] = [];
  const responses: { url: string; status: number }[] = [];
  const bootstrap = {
    centerId: "",
    principalId: "",
    actantId: "",
    csrfToken: "",
  };
  const call = (method: ApplicationMethod, params?: unknown) => {
    assert.ok(page);
    return page.evaluate(
      async ({ method, params, generation }) => {
        const reply = await window.morphzDesktop!.application!.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          ...(method === "platform.bootstrap" || method === "login"
            ? {}
            : { identityGeneration: generation }),
        });
        if (!reply.ok)
          throw Error(
            `Actual embedded ${method}: ${reply.error.status}/${reply.error.code}: ${reply.error.message}`,
          );
        return reply.value;
      },
      { method, params, generation: bootstrap.csrfToken },
    );
  };
  const streamWatch = async () => {
    assert.ok(page);
    // Read-only subscriber to real preload stream deliveries; no emission,
    // wrapping of invoke/subscribe or replacement of an App owner happens.
    await page.evaluate(() => {
      const values: unknown[] = [];
      Reflect.set(window, "__notesEmbeddedStreams", values);
      window.morphzDesktop!.application!.onStream((value) => {
        if (value.value && typeof value.value === "object")
          values.push(structuredClone(value.value));
      });
    });
  };
  const close = async () => {
    try {
      await electron?.close();
    } finally {
      try {
        await author?.stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  try {
    await mkdir(directory, { mode: 0o700 });
    await mkdir(profile, { mode: 0o700 });
    await mkdir(authorDirectory, { mode: 0o700 });
    await writeFile(
      join(directory, "members.json"),
      JSON.stringify({
        version: 1,
        members: [
          {
            principalId,
            actantId,
            name: "TEST embedded Alice",
            projectIds: [],
            enabled: true,
            loginTokenHash: digest(notesProductionLoginToken),
          },
        ],
      }),
      { mode: 0o600 },
    );
    assert.equal(existsSync(join(directory, "workspace.sqlite")), false);
    assert.equal(existsSync(join(directory, "runtime.json")), false);
    assert.equal(existsSync(bindingsFile), false);
    // Empty Runtime config means loadRuntimeConfig returns null, not an
    // environment/default Runtime. Explicit current vars block old aliases.
    electron = await _electron.launch({
      args: [build.main, `--data-dir=${directory}`],
      cwd: build.root,
      env: {
        ...environment(),
        MORPHZ_APP_PROFILE: profile,
        MORPHZ_APP_ENV_FILE: "",
        MORPHZ_APP_COGNITIVE_BINDINGS_FILE: bindingsFile,
        MORPHZ_APP_COGNITIVE_CREDENTIAL_TEST: credential,
      },
      timeout: 30_000,
    });
    electron.process().stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-12_000);
    });
    await expect
      .poll(
        () =>
          electron!.windows().some((value) => value.url() === "morphz://app/"),
        { timeout: 30_000 },
      )
      .toBe(true);
    page = electron.windows().find((value) => value.url() === "morphz://app/")!;
    page.setDefaultTimeout(12_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    page.on("response", (response) =>
      responses.push({ url: response.url(), status: response.status() }),
    );
    await page
      .getByRole("heading", { name: "登录 Morphz", exact: true })
      .waitFor();
    await page
      .getByLabel("登录凭据", { exact: true })
      .fill(notesProductionLoginToken);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "登录 Morphz", exact: true }),
    ).toHaveCount(0);
    Object.assign(bootstrap, await call("platform.bootstrap"));
    assert.match(bootstrap.centerId, /^[a-f0-9-]{36}$/);
    assert.equal(bootstrap.principalId, principalId);
    assert.equal(bootstrap.actantId, actantId);
    assert.match(bootstrap.csrfToken, /^[a-f0-9]{64}$/);
    const actualIdentity = rows(
      join(directory, "workspace.sqlite"),
      "center_metadata",
    );
    assert.equal(actualIdentity.length, 1);
    assert.equal(actualIdentity[0]!.identity, bootstrap.centerId);
    await streamWatch();
    const authorBootstrap = join(authorDirectory, "bootstrap.json");
    await writeFile(
      authorBootstrap,
      JSON.stringify({
        format: "cognitive-notes-bootstrap/v1",
        integrations: [
          {
            credentialSha256: digest(credential),
            issuer: "isolated_gui_matrix",
            tenantId: bootstrap.centerId,
            principalId,
            humanActantId: actantId,
            agentActantIds: [],
            projects: [{ projectId, read: true, write: true }],
          },
        ],
      }),
      { mode: 0o600 },
    );
    author = await startNotesGuiAuthor(
      packed.root,
      database,
      authorBootstrap,
      true,
    );
    await writeFile(
      bindingsFile,
      JSON.stringify({
        format: "morphz-host-cognitive-bindings/v1",
        issuer: "isolated_gui_matrix",
        bindings: [
          {
            tenantId: bootstrap.centerId,
            principalId,
            appId: author.ready.definition.appId,
            serviceId: author.ready.serviceId,
            dataAuthorityId: author.ready.dataAuthorityId,
            baseUrl: author.origin,
            credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_TEST",
            current: true,
            approvedLoopback: { host: "127.0.0.1", port: author.ready.port },
          },
        ],
      }),
      { mode: 0o600 },
    );
    await call("projects.create", {
      commandId: randomUUID(),
      projectId,
      title: "TEST isolated actual embedded notes GUI",
    });
    const carrier = JSON.parse(
      readFileSync(join(packed.root, "dist/install.gui.json"), "utf8"),
    );
    const installed = parseCognitiveAppInstalled(
      await call("cognitive-apps.install", {
        commandId: randomUUID(),
        ...carrier,
      }),
    );
    // The author's startup ready describes its retained headless 1.0.0 release.
    // Its independently persisted 1.1.0 GUI declaration is the exact authority
    // for this install; admission later crosses the actual /describe endpoint.
    assert.equal(installed.appId, author.ready.definition.appId);
    const authorGuiDefinition = rows(database, "author_definitions").find(
      (row) => row.version === installed.version,
    );
    assert.ok(authorGuiDefinition);
    assert.equal(installed.definitionHash, authorGuiDefinition.definition_hash);
    const registration = (await call("cognitive-apps.describe", {
      mode: "registered-management",
      appId: installed.appId,
      version: installed.version,
      expectedDefinitionHash: installed.definitionHash,
    })) as { definitionHash: string; installationState: string };
    assert.equal(registration.definitionHash, installed.definitionHash);
    const grant = parseCognitiveAppGrant(
      await call("cognitive-apps.grant", {
        appId: installed.appId,
        version: installed.version,
        expectedRevision: 0,
        state: "active",
      }),
    );
    assert.equal(grant.revision, 1);
    const connection = parseCognitiveAppConnection(
      await call("cognitive-apps.connect", {
        appId: installed.appId,
        version: installed.version,
        expectedDefinitionHash: installed.definitionHash,
        expectedGrantRevision: grant.revision,
        connectionId,
        expectedRevision: 0,
        serviceId: author.ready.serviceId,
        dataAuthorityId: author.ready.dataAuthorityId,
      }),
    );
    assert.equal(connection.serviceId, author.ready.serviceId);
    assert.equal(connection.dataAuthorityId, author.ready.dataAuthorityId);
    const target = {
      projectId,
      appId: installed.appId,
      version: installed.version,
      connectionId,
      expectedDefinitionHash: installed.definitionHash,
      expectedGrantRevision: grant.revision,
      expectedConnectionRevision: connection.revision,
    };
    const registered = rows(
      join(directory, "platform.sqlite"),
      "cognitive_app_registrations",
    );
    assert.ok(
      registered.some(
        (row) =>
          row.tenant_id === bootstrap.centerId &&
          row.principal_id === principalId &&
          row.definition_hash === installed.definitionHash,
      ),
    );
    const actualConnection = rows(
      join(directory, "platform.sqlite"),
      "cognitive_app_connections",
    ).find((row) => row.connection_id === connectionId);
    assert.ok(actualConnection);
    assert.equal(actualConnection.owner_principal_id, principalId);
    assert.match(
      String(actualConnection.host_binding_id),
      /^cognitive_binding_[a-f0-9]{64}$/,
    );
    await page
      .locator(".sidebar-project-list")
      .getByRole("button", {
        name: "TEST isolated actual embedded notes GUI",
        exact: true,
      })
      .waitFor();
    const app = {
      root,
      directory,
      profile,
      database,
      page,
      electron,
      bootstrap,
      principalId,
      actantId,
      projectId,
      target,
      installed,
      requests,
      responses,
      errors,
      close,
      call,
      async refreshBootstrap() {
        // Only an explicit native reload may ask the real connection for its
        // new generation; never silently upgrade a stale call/owner lease.
        const next = (await call("platform.bootstrap")) as typeof bootstrap;
        assert.equal(next.centerId, bootstrap.centerId);
        assert.equal(next.principalId, bootstrap.principalId);
        assert.equal(next.actantId, bootstrap.actantId);
        assert.match(next.csrfToken, /^[a-f0-9]{64}$/);
        bootstrap.csrfToken = next.csrfToken;
      },
      async diagnostics(label: string) {
        const screenshot = join(
          tmpdir(),
          `morphz-notes-native-embedded-${label}-${bootstrap.centerId}-oct06.png`,
        );
        await page!.screenshot({ path: screenshot });
        console.log(
          JSON.stringify({
            label,
            screenshot,
            centerId: bootstrap.centerId,
            principalId,
            actantId,
            requests,
            responses,
            errors,
            stderr,
            frames: page!.frames().map((frame) => frame.url()),
            text: (await page!.locator("body").innerText()).slice(0, 3500),
          }),
        );
      },
      rows(table: (typeof platformTables)[number]) {
        assert.ok(platformTables.includes(table));
        return rows(join(directory, "platform.sqlite"), table);
      },
      authorRows(table: (typeof authorTables)[number]) {
        assert.ok(authorTables.includes(table));
        return rows(database, table);
      },
      transportRows(table: (typeof transportTables)[number]) {
        assert.ok(transportTables.includes(table));
        return rows(join(directory, "workspace.sqlite"), table);
      },
      async source() {
        const location = parseCognitiveAppViewResponse(
          "locate",
          await call("cognitive-app-views.locate", {
            projectId,
            appId: installed.appId,
            version: installed.version,
            expectedDefinitionHash: installed.definitionHash,
          }),
        );
        assert.ok(location.view?.binding);
        return parseCognitiveAppViewResponse(
          "readUi",
          await call("cognitive-app-views.read-ui", {
            viewId: location.view.viewId,
            expectedViewRevision: location.view.viewRevision,
            expectedBindingRevision: location.view.binding.bindingRevision,
          }),
        );
      },
      async currentGuest() {
        const element = page!.locator("iframe.cognitive-application-frame");
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
        await page!
          .locator(".sidebar-project-list")
          .getByRole("button", {
            name: "TEST isolated actual embedded notes GUI",
            exact: true,
          })
          .click();
        await page!
          .getByRole("button", {
            name: "打开界面：独立笔记 1.1.0",
            exact: true,
          })
          .click();
        await page!
          .getByRole("dialog", { name: "打开应用界面", exact: true })
          .getByRole("button", {
            name: `打开独立笔记 1.1.0，数据连接 ${connectionId}`,
            exact: true,
          })
          .click();
        return this.currentGuest();
      },
      async stored() {
        return page!.evaluate(
          ({ prefix, key, center, principal }) => {
            const owner = sessionStorage.getItem(key);
            if (!owner)
              throw Error(
                "actual Local native persistent window owner is absent",
              );
            return JSON.parse(
              localStorage.getItem(
                `${prefix}${center}:${principal}:draft:${owner}:inputs`,
              ) || "{}",
            );
          },
          {
            prefix: applicationStoragePrefix,
            key: applicationWindowKey,
            center: bootstrap.centerId,
            principal: principalId,
          },
        ) as Promise<Record<string, InputDraft>>;
      },
      async preferences() {
        return page!.evaluate(
          ({ prefix, center, principal }) =>
            JSON.parse(
              localStorage.getItem(
                `${prefix}${center}:${principal}:preferences`,
              ) || "{}",
            ),
          {
            prefix: applicationStoragePrefix,
            center: bootstrap.centerId,
            principal: principalId,
          },
        );
      },
      async recentContent() {
        return page!.evaluate(
          ({ prefix, center, principal }) =>
            JSON.parse(
              localStorage.getItem(
                `${prefix}${center}:${principal}:recent-content`,
              ) || "[]",
            ),
          {
            prefix: applicationStoragePrefix,
            center: bootstrap.centerId,
            principal: principalId,
          },
        ) as Promise<{ artifactId: string; openedAt: number }[]>;
      },
      async streams() {
        return page!.evaluate(
          () => Reflect.get(window, "__notesEmbeddedStreams") ?? [],
        ) as Promise<unknown[]>;
      },
      async watchStreams() {
        await streamWatch();
      },
      async nativeState() {
        return electron!.evaluate(({ app, BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(
            (value) => value.webContents.getURL() === "morphz://app/",
          );
          if (!window) throw Error("actual embedded native owner is absent");
          const readPreferences = Reflect.get(
            window.webContents,
            "getLastWebPreferences",
          );
          if (typeof readPreferences !== "function")
            throw Error("actual native preference reader is absent");
          const preferences = readPreferences.call(window.webContents);
          const handles = Reflect.get(process, "_getActiveHandles");
          if (typeof handles !== "function")
            throw Error("actual native listener reader is absent");
          const listeners = handles
            .call(process)
            .filter(
              (value: { constructor?: { name?: string }; address?: unknown }) =>
                value.constructor?.name === "Server" &&
                typeof value.address === "function",
            )
            .map((value: { address: () => unknown }) => value.address());
          return {
            profile: app.getPath("userData"),
            sandbox: preferences.sandbox,
            nodeIntegration: preferences.nodeIntegration,
            contextIsolation: preferences.contextIsolation,
            listeners,
          };
        });
      },
      noRuntimeFiles() {
        assert.equal(existsSync(join(directory, "runtime.json")), false);
        assert.ok(
          readdirSync(directory).every(
            (name) => !/host-tools|\.sock$/.test(name),
          ),
        );
      },
    };
    return app;
  } catch (error) {
    console.log(
      JSON.stringify({
        stage: "native-embedded-start",
        centerId: bootstrap.centerId,
        errors,
        stderr,
        error: String(error),
      }),
    );
    if (page && !page.isClosed()) {
      const screenshot = join(
        tmpdir(),
        `morphz-notes-native-embedded-start-${bootstrap.centerId || "before-identity"}-oct06.png`,
      );
      await page.screenshot({ path: screenshot }).catch(() => undefined);
      console.log(
        JSON.stringify({
          screenshot,
          requests,
          responses,
          frames: page.frames().map((frame) => frame.url()),
          text: (await page.locator("body").innerText()).slice(0, 3500),
        }),
      );
    }
    await close();
    throw error;
  }
}
export type NotesNativeEmbedded = Awaited<
  ReturnType<typeof openNotesNativeEmbedded>
>;
