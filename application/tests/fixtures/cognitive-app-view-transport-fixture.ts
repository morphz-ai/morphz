import { prepareConnectionCreation } from "./cognitive-connection-creation.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
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
import { createCognitiveAppHost } from "../../packages/application/src/cognitive-app-host.js";
import { Application } from "../../packages/application/src/application.js";
import { LocalApplicationConnection } from "../../packages/application/src/local-connection.js";
import { HttpApplicationClient } from "../../packages/core/src/http-application-client.js";
import { createAppServer } from "../../apps/service/src/http.js";
import { RemoteApplicationConnection } from "../../apps/desktop/remote-host.js";
import { viewSubmission } from "./cognitive-app-view-service-fixture.js";

/** ACTUAL IdentityCenter sessions/HPA + Platform + Managed UI Store. Setup's
 * connection proof is an explicit fixture admission, not author/TLS evidence.
 * Both public adapters share one Host and the same real center UUID. */
export async function withViewTransport(
  backend: "sqlite" | "postgres",
  work: (f: Awaited<ReturnType<typeof openViewTransport>>) => Promise<void>,
  options: { html?: string } = {},
) {
  const f = await openViewTransport(backend, options);
  try {
    await work(f);
  } finally {
    await f.close();
  }
}
async function openViewTransport(
  backend: "sqlite" | "postgres",
  settings: { html?: string },
) {
  const root = mkdtempSync(join(tmpdir(), "morphz-view-public-"));
  const workspace = new WorkspaceStore(join(root, "transport.sqlite"), {
    mode: "transport",
  });
  const tenantId = workspace.identity();
  assert.match(tenantId, /^[a-f0-9-]{36}$/);
  const token = "b".repeat(64);
  const identity = new IdentityCenter(workspace, {
    version: 1,
    members: [
      {
        principalId: "bob",
        actantId: "bob-human",
        enabled: true,
        loginTokenHash: createHash("sha256").update(token).digest("hex"),
      },
    ],
  });
  const human = new HumanPlatformAuthority(tenantId, (access) =>
    identity.allowsShared(access),
  );
  const control: { beforeResolve?: () => Promise<void> } = {};
  const setupVerifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      return credential === "setup-alice" || credential === "setup-bob"
        ? {
            tenantId,
            principalId: credential.slice(6),
            actantId: `${credential.slice(6)}-human`,
            kind: "human",
            runtimeInputId: null,
          }
        : null;
    },
    async resolveActant({ actantId }) {
      return actantId === "alice-human" || actantId === "bob-human"
        ? { principalId: actantId.split("-")[0]!, kind: "human" }
        : null;
    },
    async resolveProjectAgent() {
      return null;
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  const composed = human.verifier(setupVerifier);
  const verifier: PlatformAuthorityVerifier = {
    ...composed,
    async resolveActor(actor) {
      await control.beforeResolve?.();
      return composed.resolveActor(actor);
    },
  };
  const suffix = randomUUID().replaceAll("-", ""),
    platformSchema = `morphz_vt_p_${suffix}`,
    byteSchema = `morphz_vt_b_${suffix}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : undefined;
  let database: DatabaseSync | undefined,
    release: (() => void) | undefined,
    platform: PlatformStore | undefined,
    ui: UiPackageService | undefined,
    host: ReturnType<typeof createCognitiveAppHost> | undefined,
    server: ReturnType<typeof createAppServer> | undefined,
    local: LocalApplicationConnection | undefined,
    remote: RemoteApplicationConnection | undefined,
    application: Application | undefined;
  const close = async () => {
    remote?.close();
    local?.close();
    application?.speechStreams.close();
    if (server) {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await host?.close();
    release?.();
    database?.close();
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
    if (pool) {
      assert.ok(
        process.env.MORPHZ_TEST_POSTGRES_URL,
        "Formal npm test must prepare required PostgreSQL.",
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
      release = () => client.release();
    } else {
      database = new DatabaseSync(join(root, "platform.sqlite"));
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(database);
    }
    const now = new Date().toISOString();
    await q.change(
      "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,'project-a','project','alice','Public GUI',1,?,?)",
      [tenantId, now, now],
    );
    for (const principalId of ["alice", "bob"])
      await q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES(?,'project-a',?)",
        [tenantId, principalId],
      );
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
    const input = viewSubmission(settings.html),
      installed = await ui.installCognitive(
        { credential: "setup-alice" },
        "install-exact-ui",
        input,
      );
    await platform.changeCognitiveAppGrant(
      { credential: "setup-bob" },
      {
        appId: input.definition.id,
        version: input.definition.version,
        state: "active",
        expectedRevision: 0,
      },
    );
    const create = async (connectionId: string, dataAuthorityId: string) =>
      platform!.createVerifiedCognitiveAppConnection(
        { credential: "setup-bob" },
        await prepareConnectionCreation(
          platform!,
          { credential: "setup-bob" },
          {
            connectionId,
            expectedRevision: 0,
            proof: {
              purpose: "connection-setup",
              appId: input.definition.id,
              version: input.definition.version,
              definitionHash: installed.definitionHash,
              serviceId: "service/notes",
              dataAuthorityId,
              hostBindingId: `private_${connectionId}`,
            },
          },
        ),
      );
    const connection = await create("connection-bob", "database/notes"),
      other = await create("connection-other", "database/other");
    // C2a will aggregate a separate presentation capability on this SAME Host.
    host = createCognitiveAppHost({
      tenantId,
      platform,
      viewPlatform: platform,
      uiPackages: ui,
    });
    const options = {
      identity,
      cognitiveApps: {
        authority: human,
        service: host.service,
        views: host.views,
      },
    };
    application = new Application(workspace, options);
    local = new LocalApplicationConnection(application);
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = createAppServer(workspace, {
      ...options,
      port,
      webRoot: "/nonexistent",
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${port}`;
    let cookie: string | undefined;
    const requests: Array<{
      path: string;
      method: string;
      origin: string | null;
      csrf: string | null;
      cookie: boolean;
    }> = [];
    const request: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("Cookie", cookie);
      requests.push({
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        origin: headers.get("Origin"),
        csrf: headers.get("X-Morphz-Token"),
        cookie: headers.has("Cookie"),
      });
      const response = await fetch(url, { ...init, headers });
      const current = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(identity.cookieName + "="));
      if (current) cookie = current.split(";")[0]!;
      return response;
    };
    const client = new HttpApplicationClient(origin, request);
    const csrf = (value: unknown) => {
      assert.ok(value && typeof value === "object" && "csrfToken" in value);
      assert.equal(typeof value.csrfToken, "string");
      return value.csrfToken as string;
    };
    await local.call("login", { token });
    const localCsrf = csrf(await local.call("platform.bootstrap"));
    await client.call("login", { token });
    const httpCsrf = csrf(await client.call("platform.bootstrap"));
    remote = new RemoteApplicationConnection(origin, request);
    const remoteCsrf = csrf(await remote.call("platform.bootstrap"));
    assert.equal(remoteCsrf, httpCsrf);
    assert.notEqual(localCsrf, httpCsrf);
    return {
      root,
      tenantId,
      workspace,
      identity,
      human,
      platform,
      ui,
      host,
      application,
      local,
      client,
      remote,
      remoteCsrf,
      q,
      origin,
      control,
      requests,
      cookie: () => cookie,
      localCsrf,
      httpCsrf,
      input,
      installed,
      connection,
      other,
      launch: {
        commandId: "view-bob",
        projectId: "project-a",
        appId: input.definition.id,
        version: input.definition.version,
        connectionId: connection.connectionId,
        expectedDefinitionHash: installed.definitionHash,
        expectedGrantRevision: 1,
        expectedConnectionRevision: connection.revision,
        expectedViewRevision: 0,
        expectedBindingRevision: 0,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
