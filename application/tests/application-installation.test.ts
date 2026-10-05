import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { ensureApplicationInstallation } from "../packages/platform/src/application-installation.js";
import { platformSchemaSql } from "../packages/platform/src/schema.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";
import {
  PlatformStore,
  PlatformStorageError,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { UiPackageService } from "../packages/application/src/ui-package-service.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";

const installedAt = "2026-10-05T00:00:00.000Z";
async function check(q: SqlQuery) {
  await q.change("INSERT INTO tenants(tenant_id,created_at) VALUES(?,?)", [
    "tenant-a",
    installedAt,
  ]);
  for (const order of ["ui-first", "domain-first"]) {
    const appId = `example.${order}`;
    const firstId = `install_${order}_first`;
    const first = await ensureApplicationInstallation(q, {
      tenantId: "tenant-a",
      appId,
      proposedInstallationId: firstId,
      installedAt,
    });
    assert.deepEqual(first, {
      installationId: firstId,
      state: "active",
      installedAt,
    });
    const second = await ensureApplicationInstallation(q, {
      tenantId: "tenant-a",
      appId,
      proposedInstallationId: `install_${order}_second`,
      installedAt: "2026-10-06T00:00:00.000Z",
    });
    assert.deepEqual(second, first);
    const rows = await q.all(
      "SELECT installation_id FROM app_installations WHERE tenant_id=? AND app_id=?",
      ["tenant-a", appId],
    );
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ installation_id: firstId }],
    );
  }
  await q.change(
    "UPDATE app_installations SET state='disabled' WHERE tenant_id=? AND app_id=?",
    ["tenant-a", "example.ui-first"],
  );
  assert.equal(
    (
      await ensureApplicationInstallation(q, {
        tenantId: "tenant-a",
        appId: "example.ui-first",
        proposedInstallationId: "cannot_reactivate",
        installedAt,
      })
    ).state,
    "disabled",
  );
  await q.change("INSERT INTO tenants(tenant_id,created_at) VALUES(?,?)", [
    "tenant-b",
    installedAt,
  ]);
  assert.equal(
    (
      await ensureApplicationInstallation(q, {
        tenantId: "tenant-b",
        appId: "example.ui-first",
        proposedInstallationId: "tenant_b_install",
        installedAt,
      })
    ).installationId,
    "tenant_b_install",
  );
  await assert.rejects(() =>
    ensureApplicationInstallation(q, {
      tenantId: "missing",
      appId: "example.missing",
      proposedInstallationId: "missing_install",
      installedAt,
    }),
  );
  const concurrent = await Promise.all(
    ["first", "second"].map((name) =>
      ensureApplicationInstallation(q, {
        tenantId: "tenant-a",
        appId: "example.concurrent",
        proposedInstallationId: `concurrent_${name}`,
        installedAt,
      }),
    ),
  );
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.ok(
    ["concurrent_first", "concurrent_second"].includes(
      concurrent[0]!.installationId,
    ),
  );
}

test("shared installation acquisition preserves the first ID, time, disabled state and tenant boundary on SQLite", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(platformSchemaSql);
    await check(sqliteQuery(db));
  } finally {
    db.close();
  }
});

test("shared installation acquisition preserves the first ID, time, disabled state and tenant boundary on PostgreSQL", async () => {
  assert.ok(
    process.env.MORPHZ_TEST_POSTGRES_URL,
    "The standard test entry must prepare PostgreSQL.",
  );
  const schema = `morphz_test_install_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString: process.env.MORPHZ_TEST_POSTGRES_URL,
  });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}",pg_catalog`);
      await client.query(platformSchemaSql);
      await check(postgresQuery(client));
    } finally {
      client.release();
    }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

const verifier: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    if (!["alice", "bob", "agent"].includes(credential)) return null;
    return {
      tenantId: "tenant-a",
      principalId: credential === "agent" ? "alice" : credential,
      actantId: credential,
      kind: credential === "agent" ? "agent" : "human",
      runtimeInputId: credential === "agent" ? "real_input" : null,
      ...(credential === "agent"
        ? { initiatingHumanActantId: "alice", scopeProjectId: "project_one" }
        : {}),
    };
  },
  async resolveActant({ actantId }) {
    return {
      principalId: actantId === "agent" ? "alice" : actantId,
      kind: actantId === "agent" ? "agent" : "human",
    };
  },
  async resolveProjectAgent() {
    return null;
  },
  async verifyApplicationObject() {
    return false;
  },
};

async function checkActualInstallPaths(
  platform: PlatformStore,
  service: UiPackageService,
  readInstall: (appId: string) => Promise<{
    installation_id: string;
    installed_at: string;
    state: string;
  }>,
  setState: (appId: string, state: string) => Promise<void>,
) {
  const alice = { credential: "alice" };
  for (const order of ["ui-first", "domain-first"]) {
    const appId = `example.${order}`;
    const registration = {
      appId,
      installationId: `domain_${order}`,
      instanceId: `instance_${order}`,
      routeKind: "service" as const,
      routeRef: "author:isolated-test",
      now: installedAt,
    };
    const manifest = {
      format: applicationManifestFormat,
      id: appId,
      version: "1.0.0",
      title: order,
      description: "Isolated installation ordering regression",
      icon: "document" as const,
      permissions: ["input.compose" as const],
      harness: null,
      ui: {
        type: "sandbox" as const,
        html: "<!doctype html><title>Original author bytes</title>",
      },
    };
    if (order === "domain-first")
      await platform.registerApplication("tenant-a", registration);
    else await service.install(alice, `ui_install_${order}`, manifest);
    const before = await readInstall(appId);
    if (order === "domain-first")
      await service.install(alice, `ui_install_${order}`, manifest);
    else await platform.registerApplication("tenant-a", registration);
    assert.deepEqual(await readInstall(appId), before);
    assert.deepEqual(
      await service.read(alice, appId, manifest.version),
      manifest,
    );
    await assert.rejects(
      service.read({ credential: "bob" }, appId, manifest.version),
    );
    await assert.rejects(
      service.install({ credential: "agent" }, `agent_install_${order}`, {
        ...manifest,
        version: "1.0.1",
      }),
    );
    // The same command remains durable replay, and an existing instance cannot
    // be reinterpreted as a different route after normalizing installation IDs.
    assert.equal(
      await service.install(alice, `ui_install_${order}`, manifest),
      `${appId}@1.0.0`,
    );
    await assert.rejects(
      platform.registerApplication("tenant-a", {
        ...registration,
        routeRef: "author:another-authority",
      }),
    );
  }
  const builtin = {
    appId: "morphz.reader",
    installationId: "builtin_original",
    instanceId: "builtin_instance",
    routeKind: "service" as const,
    routeRef: "builtin:reader",
  };
  await platform.registerApplication("tenant-a", builtin);
  await assert.rejects(
    platform.registerApplication("tenant-a", {
      ...builtin,
      installationId: "builtin_replacement",
    }),
  );
  const appId = "example.concurrent";
  const registration = {
    appId,
    installationId: "concurrent_domain",
    instanceId: "concurrent_instance",
    routeKind: "service" as const,
    routeRef: "author:concurrent-fixture",
    now: installedAt,
  };
  const manifest = {
    format: applicationManifestFormat,
    id: appId,
    version: "1.0.0",
    title: "Concurrent installation",
    description: "The UI and domain keep whichever identity committed first.",
    icon: "document" as const,
    permissions: ["input.compose" as const],
    harness: null,
    ui: {
      type: "sandbox" as const,
      html: "<!doctype html><title>Concurrent</title>",
    },
  };
  await Promise.all([
    platform.registerApplication("tenant-a", registration),
    service.install(alice, "concurrent_ui_install", manifest),
  ]);
  const before = await readInstall(appId);
  await Promise.all([
    platform.registerApplication("tenant-a", registration),
    service.install(alice, "concurrent_ui_install", manifest),
  ]);
  assert.deepEqual(await readInstall(appId), before);
  assert.deepEqual(await service.read(alice, appId, "1.0.0"), manifest);
  for (const state of ["disabled", "unavailable"]) {
    await setState(appId, state);
    const inactive = await readInstall(appId);
    const conflict = (error: unknown) =>
      error instanceof PlatformStorageError && error.code === "conflict";
    await assert.rejects(
      platform.registerApplication("tenant-a", registration),
      conflict,
    );
    await assert.rejects(
      service.install(alice, `blocked_${state}`, {
        ...manifest,
        version: state === "disabled" ? "1.0.1" : "1.0.2",
      }),
      conflict,
    );
    assert.deepEqual(await readInstall(appId), inactive);
    assert.equal(inactive.state, state);
  }
}

test("actual UI Store and service registration share installations in either order on SQLite without sharing HTML ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-install-path-sqlite-"));
  let platform: PlatformStore | undefined,
    service: UiPackageService | undefined;
  const filename = join(root, "platform.sqlite");
  try {
    platform = await PlatformStore.sqlite(filename, verifier);
    await platform.provisionTenant("tenant-a");
    service = await UiPackageService.open({
      root: join(root, "ui"),
      tenantId: "tenant-a",
      platform,
      verifier,
    });
    await checkActualInstallPaths(
      platform,
      service,
      async (appId) => {
        const inspection = new DatabaseSync(filename, { readOnly: true });
        try {
          return {
            ...inspection
              .prepare(
                "SELECT installation_id,installed_at,state FROM app_installations WHERE tenant_id='tenant-a' AND app_id=?",
              )
              .get(appId),
          } as { installation_id: string; installed_at: string; state: string };
        } finally {
          inspection.close();
        }
      },
      async (appId, state) => {
        const fixture = new DatabaseSync(filename);
        try {
          fixture
            .prepare(
              "UPDATE app_installations SET state=? WHERE tenant_id='tenant-a' AND app_id=?",
            )
            .run(state, appId);
        } finally {
          fixture.close();
        }
      },
    );
    await service.close();
    service = undefined;
    await platform.close();
    platform = undefined;
    platform = await PlatformStore.sqlite(filename, verifier);
    service = await UiPackageService.open({
      root: join(root, "ui"),
      tenantId: "tenant-a",
      platform,
      verifier,
    });
    assert.equal(
      (await service.read({ credential: "alice" }, "example.ui-first", "1.0.0"))
        .ui.type,
      "sandbox",
    );
    await assert.rejects(
      service.read({ credential: "bob" }, "example.ui-first", "1.0.0"),
    );
  } finally {
    await service?.close();
    await platform?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual UI Store and service registration share installations in either order on PostgreSQL without sharing HTML ownership", async () => {
  assert.ok(process.env.MORPHZ_TEST_POSTGRES_URL);
  const schema = `morphz_test_paths_${randomUUID().replaceAll("-", "")}`;
  const root = mkdtempSync(join(tmpdir(), "morphz-install-path-postgres-"));
  const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
  const pool = new Pool({ connectionString });
  let platform: PlatformStore | undefined,
    service: UiPackageService | undefined;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    platform = await PlatformStore.postgres(
      { connectionString, schema },
      verifier,
    );
    await platform.provisionTenant("tenant-a");
    service = await UiPackageService.open({
      root: join(root, "ui"),
      tenantId: "tenant-a",
      platform,
      verifier,
    });
    await checkActualInstallPaths(
      platform,
      service,
      async (appId) =>
        (
          await pool.query(
            `SELECT installation_id,installed_at,state FROM "${schema}".app_installations WHERE tenant_id='tenant-a' AND app_id=$1`,
            [appId],
          )
        ).rows[0],
      async (appId, state) => {
        await pool.query(
          `UPDATE "${schema}".app_installations SET state=$1 WHERE tenant_id='tenant-a' AND app_id=$2`,
          [state, appId],
        );
      },
    );
  } finally {
    await service?.close();
    await platform?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  }
});
