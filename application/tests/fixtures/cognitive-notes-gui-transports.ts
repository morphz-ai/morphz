/** Real independently packed author process/SQLite, Platform dual SQL,
 * IdentityCenter/HPA, immutable UI Store and public adapters. Only setup
 * identities, private loopback approval and fault timing are controlled. No
 * fixture connection proof, business reply, receipt or content ID is invented.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { chromium, type Browser } from "@playwright/test";
import { Pool } from "pg";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../../packages/storage/src/sql.js";
import { WorkspaceStore } from "../../packages/application/src/store.js";
import { IdentityCenter } from "../../packages/application/src/identity.js";
import { HumanPlatformAuthority } from "../../packages/application/src/human-platform-authority.js";
import { UiPackageService } from "../../packages/application/src/ui-package-service.js";
import { PlatformWorkService } from "../../packages/application/src/platform-work-service.js";
import { createCognitiveAppHost } from "../../packages/application/src/cognitive-app-host.js";
import { Application } from "../../packages/application/src/application.js";
import { LocalApplicationConnection } from "../../packages/application/src/local-connection.js";
import { HttpApplicationClient } from "../../packages/core/src/http-application-client.js";
import { createAppServer } from "../../apps/service/src/http.js";
import { RemoteApplicationConnection } from "../../apps/desktop/remote-host.js";
import { embeddedResources } from "../../apps/desktop/application-host.js";
import { appContentSecurityPolicy } from "../../packages/core/src/resource-policy.js";
import { parseCognitiveAppRequest } from "../../packages/core/src/cognitive-app-api.js";
import type { ApplicationMethod } from "../../packages/core/src/application-api.js";
import { morphzAgentAccess } from "../../packages/core/src/model.js";
import { parseCognitiveAppViewResponse } from "../../packages/core/src/cognitive-app-view-api.js";
import {
  packCognitiveNotesGui,
  startNotesGuiAuthor,
} from "./cognitive-notes-gui-package.js";

export type NotesGuiAdapter = "Web" | "Local" | "Remote";
export type NotesGuiPack = ReturnType<typeof packCognitiveNotesGui>;
const credential = "isolated_gui_author_credential_abcdefghijklmnopqrstuvwxyz";
const token = "a".repeat(64);
const principalId = "alice",
  actantId = "alice-human",
  projectId = "project-a";
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const csrf = (value: unknown) => {
  assert.ok(value && typeof value === "object" && "csrfToken" in value);
  assert.equal(typeof value.csrfToken, "string");
  return value.csrfToken as string;
};

export async function openNotesGuiTransports(
  backend: "sqlite" | "postgres",
  packed: NotesGuiPack,
) {
  const root = mkdtempSync(join(tmpdir(), "morphz-notes-gui-business-"));
  const workspace = new WorkspaceStore(join(root, "transport.sqlite"), {
    mode: "transport",
  });
  const tenantId = workspace.identity();
  const identity = new IdentityCenter(workspace, {
    version: 1,
    members: [
      { principalId, actantId, enabled: true, loginTokenHash: digest(token) },
    ],
  });
  const human = new HumanPlatformAuthority(tenantId, (access) =>
    identity.allowsShared(access),
  );
  const remaining: PlatformAuthorityVerifier = {
    async resolveActor() {
      return null;
    },
    async resolveActant(input) {
      return input.actantId === actantId
        ? { principalId, kind: "human" }
        : input.actantId === morphzAgentAccess.actantId
          ? { principalId: morphzAgentAccess.principalId, kind: "agent" }
          : null;
    },
    async resolveProjectAgent() {
      return { ...morphzAgentAccess };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  const verifier = human.verifier(remaining);
  const suffix = randomUUID().replaceAll("-", ""),
    platformSchema = "notes_gui_p_" + suffix,
    byteSchema = "notes_gui_b_" + suffix;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : undefined;
  const database = join(root, "author.sqlite"),
    bootstrap = join(root, "author-bootstrap.json"),
    bindingsFile = join(root, "bindings.json");
  writeFileSync(
    bootstrap,
    JSON.stringify({
      format: "cognitive-notes-bootstrap/v1",
      integrations: [
        {
          credentialSha256: digest(credential),
          issuer: "isolated_gui_matrix",
          tenantId,
          principalId,
          humanActantId: actantId,
          agentActantIds: [],
          projects: [{ projectId, read: true, write: true }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  let author: Awaited<ReturnType<typeof startNotesGuiAuthor>> | undefined;
  let proxy: Server | undefined,
    api: ReturnType<typeof createAppServer> | undefined;
  let platform: PlatformStore | undefined, ui: UiPackageService | undefined;
  let host: ReturnType<typeof createCognitiveAppHost> | undefined;
  let local: LocalApplicationConnection | undefined,
    remote: RemoteApplicationConnection | undefined;
  let metadata: DatabaseSync | undefined,
    releaseSql: (() => void) | undefined,
    browser: Browser | undefined;
  const authorCalls: { path: string; body: unknown }[] = [];
  const control: {
    dropInvoke: boolean;
    holdPath?: string;
    reached?: () => void;
    release?: () => void;
  } = { dropInvoke: false };
  const closes = new Set<() => Promise<void>>();
  const close = async () => {
    for (const dispose of closes) await dispose();
    await browser?.close();
    local?.close();
    remote?.close();
    control.release?.();
    if (api) {
      api.closeAllConnections();
      await new Promise<void>((done) => api!.close(() => done()));
    }
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy!.close(() => done()));
    }
    await host?.close();
    await author?.stop();
    metadata?.close();
    releaseSql?.();
    await ui?.close();
    await platform?.close();
    workspace.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${platformSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${byteSchema}" CASCADE`);
      await pool.end();
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    author = await startNotesGuiAuthor(packed.root, database, bootstrap, true);
    proxy = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => {
        const bytes = Buffer.concat(chunks);
        authorCalls.push({
          path: incoming.url!,
          body: JSON.parse(bytes.toString()),
        });
        const upstream = request(
          {
            hostname: "127.0.0.1",
            port: author!.ready.port,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
            agent: false,
          },
          (received) => {
            const result: Buffer[] = [];
            received.on("data", (chunk: Buffer) => result.push(chunk));
            received.once("end", () => {
              const body = Buffer.concat(result);
              // Drop a real committed response, never fabricate an author result.
              if (
                control.dropInvoke &&
                incoming.url === "/invoke" &&
                received.statusCode === 200 &&
                JSON.parse(body.toString()).status === "committed"
              ) {
                control.dropInvoke = false;
                outgoing.destroy();
                return;
              }
              const deliver = () => {
                if (outgoing.destroyed) return;
                const headers = {
                  ...received.headers,
                  "content-length": String(body.length),
                };
                delete headers["transfer-encoding"];
                outgoing.writeHead(received.statusCode!, headers);
                outgoing.end(body);
              };
              if (incoming.url === control.holdPath) {
                control.holdPath = undefined;
                control.release = () => {
                  control.release = undefined;
                  deliver();
                };
                control.reached?.();
              } else deliver();
            });
            received.once("error", () => outgoing.destroy());
          },
        );
        upstream.once("error", () => outgoing.destroy());
        upstream.end(bytes);
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");
    writeFileSync(
      bindingsFile,
      JSON.stringify({
        format: "morphz-host-cognitive-bindings/v1",
        issuer: "isolated_gui_matrix",
        bindings: [
          {
            tenantId,
            principalId,
            appId: author.ready.definition.appId,
            serviceId: author.ready.serviceId,
            dataAuthorityId: author.ready.dataAuthorityId,
            baseUrl: `http://127.0.0.1:${proxyAddress.port}`,
            credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_TEST",
            current: true,
            approvedLoopback: { host: "127.0.0.1", port: proxyAddress.port },
          },
        ],
      }),
      { mode: 0o600 },
    );
    if (pool) {
      assert.ok(
        process.env.MORPHZ_TEST_POSTGRES_URL,
        "Formal npm entry must prepare actual PostgreSQL; no skip.",
      );
      await pool.query(`CREATE SCHEMA "${platformSchema}"`);
      await pool.query(`CREATE SCHEMA "${byteSchema}"`);
    }
    platform = pool
      ? await PlatformStore.postgres(
          {
            connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
            schema: platformSchema,
          },
          verifier,
        )
      : await PlatformStore.sqlite(join(root, "platform.sqlite"), verifier);
    await platform.provisionTenant(tenantId);
    await identity.bindPlatform(platform, tenantId);
    let q: SqlQuery;
    if (pool) {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${platformSchema}",pg_catalog`);
      q = postgresQuery(client);
      releaseSql = () => client.release();
    } else {
      metadata = new DatabaseSync(join(root, "platform.sqlite"));
      metadata.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(metadata);
    }
    ui = await UiPackageService.open({
      tenantId,
      platform,
      verifier,
      root: join(root, "ui"),
      ...(pool
        ? {
            postgres: {
              connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
              schema: byteSchema,
            },
          }
        : {}),
    });
    host = createCognitiveAppHost({
      tenantId,
      platform,
      viewPlatform: platform,
      uiPackages: ui,
      config: {
        bindingsFile,
        secrets: () => credential,
        egress: "public-https",
      },
    });
    host.start();
    await host.whenIdle();
    const options = {
      identity,
      cognitiveApps: {
        authority: human,
        service: host.service,
        views: host.views,
      },
      platformWork: {
        authority: human,
        service: new PlatformWorkService(
          platform,
          backend === "sqlite" ? "single-host" : "cross-host-unverified",
        ),
      },
      uiPackages: { authority: human, service: ui },
    };
    const application = new Application(workspace, options);
    local = new LocalApplicationConnection(application);
    await local.call("login", { token });
    const localCsrf = csrf(await local.call("platform.bootstrap"));
    const call = (method: ApplicationMethod, params?: unknown) =>
      local!.call(method, params, { identityGeneration: localCsrf });
    await call("projects.create", {
      commandId: randomUUID(),
      projectId,
      title: "TEST isolated actual notes GUI",
    });
    const carrier = JSON.parse(
      readFileSync(join(packed.root, "dist/install.gui.json"), "utf8"),
    );
    const installed = (await call(
      "cognitive-apps.install",
      parseCognitiveAppRequest("install", {
        commandId: randomUUID(),
        ...carrier,
      }),
    )) as { appId: string; version: string; definitionHash: string };
    await call("cognitive-apps.grant", {
      appId: installed.appId,
      version: installed.version,
      expectedRevision: 0,
      state: "active",
    });
    const connection = (await call("cognitive-apps.connect", {
      appId: installed.appId,
      version: installed.version,
      connectionId: "actual-author-connection",
      expectedRevision: 0,
      serviceId: author.ready.serviceId,
      dataAuthorityId: author.ready.dataAuthorityId,
    })) as { connectionId: string; revision: number };
    await host.whenIdle();
    assert.ok(
      authorCalls.some((value) => value.path === "/describe"),
      "connection admission crosses the real author endpoint",
    );
    const target = {
      projectId,
      appId: installed.appId,
      version: installed.version,
      connectionId: connection.connectionId,
      expectedDefinitionHash: installed.definitionHash,
      expectedGrantRevision: 1,
      expectedConnectionRevision: connection.revision,
    };
    const launched = await call("cognitive-app-views.launch", {
      ...target,
      commandId: randomUUID(),
      expectedViewRevision: 0,
      expectedBindingRevision: 0,
    });
    const initialView = parseCognitiveAppViewResponse("launch", launched);
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((done) => probe.close(() => done()));
    api = createAppServer(workspace, {
      ...options,
      port,
      webRoot: "/nonexistent",
    });
    api.listen(port, "127.0.0.1");
    await once(api, "listening");
    const origin = `http://127.0.0.1:${port}`;
    let cookie: string | undefined;
    const remoteRequests: string[] = [];
    const fetchWithCookie: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("Cookie", cookie);
      remoteRequests.push(new URL(String(url)).pathname);
      const response = await fetch(url, { ...init, headers });
      const current = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(identity.cookieName + "="));
      if (current) cookie = current.split(";")[0]!;
      return response;
    };
    const http = new HttpApplicationClient(origin, fetchWithCookie);
    await http.call("login", { token });
    csrf(await http.call("platform.bootstrap"));
    remote = new RemoteApplicationConnection(origin, fetchWithCookie);
    await remote.call("platform.bootstrap");
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "Required installed Chromium, no skip/download.",
    );
    browser = await chromium.launch({ headless: true, executablePath });
    const ownerCode = (
      await build({
        entryPoints: ["tests/fixtures/cognitive-notes-gui-owner.tsx"],
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2023",
        jsx: "automatic",
        write: false,
      })
    ).outputFiles[0]!.text;
    const source = async () => {
      const read = parseCognitiveAppViewResponse(
        "read",
        await call("cognitive-app-views.read", {
          viewId: initialView.receipt.viewId,
        }),
      );
      return parseCognitiveAppViewResponse(
        "readUi",
        await call("cognitive-app-views.read-ui", {
          viewId: read.view.id,
          expectedViewRevision: read.view.revision,
          expectedBindingRevision: read.binding.revision,
        }),
      );
    };
    return {
      root,
      database,
      tenantId,
      projectId,
      principalId,
      actantId,
      identity,
      platform,
      ui,
      host,
      local,
      remote,
      http,
      q,
      target,
      authorCalls,
      remoteRequests,
      source,
      call,
      close,
      rows: (table: string) => q.all(`SELECT * FROM ${table}`),
      transportRows(
        table:
          | "runtime_sessions"
          | "runtime_deliveries"
          | "runtime_publications"
          | "runtime_thread_bindings"
          | "runtime_session_events",
      ) {
        assert.ok(
          [
            "runtime_sessions",
            "runtime_deliveries",
            "runtime_publications",
            "runtime_thread_bindings",
            "runtime_session_events",
          ].includes(table),
        );
        const db = new DatabaseSync(join(root, "transport.sqlite"), {
          readOnly: true,
        });
        try {
          return db.prepare(`SELECT * FROM ${table} ORDER BY key`).all();
        } finally {
          db.close();
        }
      },
      authorRows(table: string) {
        assert.ok(
          [
            "notes",
            "note_versions",
            "author_commands",
            "author_definitions",
            "metadata",
            "project_acl",
          ].includes(table),
        );
        const db = new DatabaseSync(database, { readOnly: true });
        try {
          return db.prepare(`SELECT * FROM ${table}`).all();
        } finally {
          db.close();
        }
      },
      dropCommittedResponse() {
        control.dropInvoke = true;
      },
      hold(path: "/objects/read" | "/invoke" | "/receipts/read") {
        assert.equal(control.release, undefined);
        const reached = new Promise<void>((done) => (control.reached = done));
        control.holdPath = path;
        return {
          reached,
          release() {
            assert.ok(
              control.release,
              "actual upstream response must have reached the barrier",
            );
            control.release();
          },
        };
      },
      async mount(adapter: NotesGuiAdapter) {
        const currentSource = await source();
        const context = await browser!.newContext();
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors: string[] = [],
          calls: { method: string; params: unknown; ok?: boolean }[] = [],
          resources: {
            method: string;
            status: number;
            bytes: number;
            adapter: string;
          }[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const dispose = async () => {
          closes.delete(dispose);
          await context.close();
        };
        closes.add(dispose);
        const value = cookie!;
        const at = value.indexOf("=");
        await context.addCookies([
          { name: value.slice(0, at), value: value.slice(at + 1), url: origin },
        ]);
        await page.exposeFunction("notesGuiSettings", () => ({
          adapter,
          target,
          viewId: currentSource.view.id,
        }));
        if (adapter !== "Web") {
          const selected = adapter === "Local" ? local! : remote!;
          await page.exposeFunction("notesGuiInvoke", async (raw: any) => {
            const entry = {
              method: String(raw.method),
              params: structuredClone(raw.params),
              ok: undefined as boolean | undefined,
            };
            calls.push(entry);
            const reply = await selected.invoke(raw);
            entry.ok = reply.ok;
            return reply;
          });
          await page.exposeFunction("notesGuiCancel", (id: string) =>
            selected.cancel(id),
          );
          // Browser route is an automated delivery shell, NOT Electron/custom
          // scheme acceptance. Actual embedded adapter bytes/headers are unchanged;
          // Local does not invoke the HTTP application server for resources.
          await page.route(
            origin + "/api/cognitive-app-document/**",
            async (route) => {
              const url = new URL(route.request().url());
              const before = remoteRequests.length;
              const response = await embeddedResources(
                "/nonexistent",
                selected,
              )(
                new Request("morphz://app" + url.pathname + url.search, {
                  method: route.request().method(),
                }),
              );
              const body = Buffer.from(await response.arrayBuffer());
              resources.push({
                method: route.request().method(),
                status: response.status,
                bytes: body.length,
                adapter,
              });
              if (adapter === "Local")
                assert.equal(
                  remoteRequests.length,
                  before,
                  "Local embedded resource does not make an application HTTP request",
                );
              await route.fulfill({
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body,
              });
            },
          );
        }
        await page.route(origin + "/", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            headers: { "Content-Security-Policy": appContentSecurityPolicy },
            body: '<!doctype html><div id="root"></div><script type="module" src="/notes-gui-owner.js"></script>',
          }),
        );
        await page.route(origin + "/notes-gui-owner.js", (route) =>
          route.fulfill({ contentType: "text/javascript", body: ownerCode }),
        );
        await page.goto(origin + "/");
        await page.waitForFunction(
          () => Reflect.get(window, "notesGuiOwner")?.ready === true,
        );
        const outer = page.mainFrame().childFrames()[0];
        assert.ok(outer);
        const guest = outer.childFrames()[0];
        assert.ok(guest);
        await guest.waitForFunction(
          () =>
            document.getElementById("connection")?.textContent ===
            "工作区已连接",
        );
        return {
          page,
          guest,
          calls,
          resources,
          errors,
          source: currentSource,
          adapter,
          close: dispose,
          snapshot: () =>
            page.evaluate(() =>
              Reflect.get(window, "notesGuiOwner").snapshot(),
            ),
          latest: () =>
            page.evaluate(() => Reflect.get(window, "notesGuiOwner").latest()),
          retire: () =>
            page.evaluate(() => Reflect.get(window, "notesGuiOwner").retire()),
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type NotesGuiTransports = Awaited<
  ReturnType<typeof openNotesGuiTransports>
>;
export type NotesGuiMounted = Awaited<ReturnType<NotesGuiTransports["mount"]>>;
