import { prepareConnectionCreation } from "./cognitive-connection-creation.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { UiPackageService } from "../../packages/application/src/ui-package-service.js";
import { createCognitiveAppViewService } from "../../packages/application/src/cognitive-app-view-service.js";
import { applicationManifestFormat } from "../../packages/core/src/application-names.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../../packages/storage/src/sql.js";

export const alice = { credential: "alice" },
  bob = { credential: "bob" },
  agent = { credential: "agent" };
export function viewSubmission(
  html = '<!doctype html><meta charset="utf-8"><h1>真实界面 😀</h1>',
) {
  const manifest = {
    format: applicationManifestFormat,
    id: "example.notes",
    version: "1.0.0",
    title: "便笺",
    description: "作者保存原件",
    icon: "document" as const,
    permissions: ["input.compose" as const],
    harness: null,
    ui: { type: "sandbox" as const, html },
  };
  const definition = {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    description: manifest.description,
    icon: manifest.icon,
    harness: null,
    ui: {
      packageVersion: manifest.version,
      sha256: createHash("sha256").update(html).digest("hex"),
    },
    operations: [
      {
        id: "notes.list",
        title: "读取",
        description: "读取已授权原件",
        effect: "read",
        scope: "project",
        inputSchema: { type: "null" },
        outputSchema: { type: "string" },
      },
    ],
  };
  return { manifest, definition };
}
export type ViewFixture = {
  platform: PlatformStore;
  ui: UiPackageService;
  service: ReturnType<typeof createCognitiveAppViewService>;
  q: SqlQuery;
  root: string;
  control: { beforeResolve?: () => Promise<void> };
  reopen(): Promise<void>;
};
/** Actual isolated Platform + Managed Store backends. Identity and describe
 * admission are explicit fixture ports, not live Runtime or network evidence.
 * No original App/profile/credentials or business database is accessed. */
export async function isolatedView(
  backend: "sqlite" | "postgres",
  run: (f: ViewFixture) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "morphz-cognitive-view-facade-"));
  const suffix = randomUUID().replaceAll("-", ""),
    platformSchema = `morphz_view_p_${suffix}`,
    byteSchema = `morphz_view_b_${suffix}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : null;
  const control: ViewFixture["control"] = {};
  const verifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      await control.beforeResolve?.();
      if (credential === "agent")
        return {
          tenantId: "tenant-a",
          principalId: "bob",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-one",
          initiatingHumanActantId: "bob-human",
          scopeProjectId: "project-a",
        };
      return credential === "alice" || credential === "bob"
        ? {
            tenantId: "tenant-a",
            principalId: credential,
            actantId: `${credential}-human`,
            kind: "human",
            runtimeInputId: null,
          }
        : null;
    },
    async resolveActant({ actantId }) {
      if (actantId === "agent-one")
        return { principalId: "agent-service", kind: "agent" };
      return actantId === "alice-human" || actantId === "bob-human"
        ? { principalId: actantId.split("-")[0]!, kind: "human" }
        : null;
    },
    async resolveProjectAgent() {
      return { principalId: "agent-service", actantId: "agent-one" };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  let platform: PlatformStore | undefined,
    ui: UiPackageService | undefined,
    database: DatabaseSync | undefined,
    release: (() => void) | undefined;
  const openPlatform = () =>
    pool
      ? PlatformStore.postgres(
          {
            connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
            schema: platformSchema,
          },
          verifier,
        )
      : PlatformStore.sqlite(join(root, "platform.sqlite"), verifier);
  const openUi = () =>
    UiPackageService.open({
      tenantId: "tenant-a",
      platform: platform!,
      verifier,
      root: join(root, "ui-bytes"),
      ...(pool
        ? {
            postgres: {
              connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
              schema: byteSchema,
            },
          }
        : {}),
    });
  try {
    if (pool) {
      assert.ok(
        process.env.MORPHZ_TEST_POSTGRES_URL,
        "Formal npm runner must prepare required real PostgreSQL.",
      );
      await pool.query(`CREATE SCHEMA "${platformSchema}"`);
      await pool.query(`CREATE SCHEMA "${byteSchema}"`);
    }
    platform = await openPlatform();
    await platform.provisionTenant("tenant-a");
    ui = await openUi();
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
      "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','project-a','project','alice','Test GUI',1,?,?)",
      [now, now],
    );
    for (const principalId of ["alice", "bob"])
      await q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a',?)",
        [principalId],
      );
    const f: ViewFixture = {
      platform,
      ui,
      service: createCognitiveAppViewService({ platform, uiPackages: ui }),
      q,
      root,
      control,
      async reopen() {
        await ui!.close();
        await platform!.close();
        platform = await openPlatform();
        ui = await openUi();
        f.platform = platform;
        f.ui = ui;
        f.service = createCognitiveAppViewService({ platform, uiPackages: ui });
      },
    };
    await run(f);
  } finally {
    release?.();
    await ui?.close();
    await platform?.close();
    database?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${platformSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${byteSchema}" CASCADE`);
      await pool.end();
    }
    rmSync(root, { recursive: true, force: true });
  }
}
export async function prepareView(f: ViewFixture, html?: string) {
  const input = viewSubmission(html);
  const installed = await f.ui.installCognitive(
    alice,
    "install-original",
    input,
  );
  await f.platform.changeCognitiveAppGrant(bob, {
    appId: input.manifest.id,
    version: input.manifest.version,
    expectedRevision: 0,
    state: "active",
  });
  const create = async (connectionId: string, dataAuthorityId: string) =>
    f.platform.createVerifiedCognitiveAppConnection(
      bob,
      await prepareConnectionCreation(f.platform, bob, {
        proof: {
          purpose: "connection-setup",
          appId: input.manifest.id,
          version: input.manifest.version,
          definitionHash: installed.definitionHash,
          serviceId: "service/notes",
          dataAuthorityId,
          hostBindingId: `private_${connectionId}`,
        },
        connectionId,
        expectedRevision: 0,
      }),
    );
  const connection = await create("connection-bob", "database/notes");
  const other = await create("connection-other", "database/other");
  return {
    input,
    installed,
    connection,
    other,
    launch: {
      commandId: "view-bob",
      projectId: "project-a",
      appId: input.manifest.id,
      version: input.manifest.version,
      connectionId: connection.connectionId,
      expectedDefinitionHash: installed.definitionHash,
      expectedGrantRevision: 1,
      expectedConnectionRevision: connection.revision,
      expectedViewRevision: 0,
      expectedBindingRevision: 0,
    },
  };
}
