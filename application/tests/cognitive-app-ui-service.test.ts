import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { UiPackageService } from "../packages/application/src/ui-package-service.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";

const access = { credential: "alice" };
function input(html = "<!doctype html><h1>真实界面 😀</h1>") {
  const manifest = {
    format: applicationManifestFormat,
    id: "example.notes",
    version: "1.0.0",
    title: "便笺",
    description: "独立原件服务",
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
        id: "notes.create",
        title: "创建便笺",
        description: "保存作者原件",
        effect: "write",
        scope: "project",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string", maxLength: 100 } },
          required: ["title"],
          additionalProperties: false,
        },
        outputSchema: { type: "boolean" },
      },
    ],
  };
  return { definition, manifest };
}
type Fixture = {
  platform: PlatformStore;
  service: UiPackageService;
  q: SqlQuery;
  control: { beforeResolve?: () => Promise<void> };
  reopen(): Promise<void>;
};
async function isolated(
  backend: "sqlite" | "postgres",
  run: (f: Fixture) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "morphz-cognitive-ui-service-"));
  const suffix = randomUUID().replaceAll("-", "");
  const platformSchema = `morphz_test_ui_platform_${suffix}`;
  const byteSchema = `morphz_test_ui_bytes_${suffix}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : null;
  const control: Fixture["control"] = {};
  const verifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      await control.beforeResolve?.();
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
  let platform: PlatformStore | undefined;
  let service: UiPackageService | undefined;
  let database: DatabaseSync | undefined;
  let release: (() => void) | undefined;
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
  const openService = () =>
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
        "Formal runner prepares the required actual PostgreSQL backend.",
      );
      await pool.query(`CREATE SCHEMA "${platformSchema}"`);
      await pool.query(`CREATE SCHEMA "${byteSchema}"`);
    }
    platform = await openPlatform();
    await platform.provisionTenant("tenant-a");
    service = await openService();
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
    const f: Fixture = {
      platform,
      service,
      q,
      control,
      async reopen() {
        await service!.close();
        await platform!.close();
        platform = await openPlatform();
        service = await openService();
        f.platform = platform;
        f.service = service;
      },
    };
    await run(f);
  } finally {
    release?.();
    await service?.close();
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
async function noImplicitAuthority(f: Fixture) {
  for (const relation of [
    "cognitive_app_grants",
    "cognitive_app_connections",
    "cognitive_app_view_bindings",
    "app_view_instances",
  ])
    assert.equal((await f.q.all(`SELECT * FROM ${relation}`)).length, 0);
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(`real UI Service installs exact Managed Store bytes then registry definition, survives cold restart on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const submission = input();
      const commandId = randomUUID();
      const version = await f.service.installCognitive(
        access,
        commandId,
        submission,
      );
      assert.equal(
        version.definition.ui!.sha256,
        submission.definition.ui.sha256,
      );
      assert.deepEqual(
        await f.service.read(
          access,
          submission.manifest.id,
          submission.manifest.version,
        ),
        submission.manifest,
      );
      const packageRows = await f.q.all("SELECT * FROM app_ui_packages");
      const definitionRows = await f.q.all(
        "SELECT * FROM cognitive_app_versions",
      );
      assert.equal(packageRows.length, 1);
      assert.equal(definitionRows.length, 1);
      assert.equal(
        JSON.stringify([packageRows, definitionRows]).includes("doctype"),
        false,
      );
      assert.equal(
        JSON.stringify([packageRows, definitionRows]).includes("真实界面"),
        false,
      );
      assert.equal(
        (await f.q.all("SELECT * FROM app_installations")).length,
        1,
      );
      await noImplicitAuthority(f);
      const retry = await f.service.installCognitive(
        access,
        commandId,
        submission,
      );
      assert.deepEqual(retry, version);
      assert.deepEqual(
        await f.q.all("SELECT * FROM app_ui_packages"),
        packageRows,
      );
      await f.reopen();
      assert.deepEqual(
        await f.service.read(
          access,
          submission.manifest.id,
          submission.manifest.version,
        ),
        submission.manifest,
      );
      assert.deepEqual(
        await f.service.installCognitive(access, commandId, submission),
        version,
      );
      assert.deepEqual(
        await f.q.all("SELECT * FROM cognitive_app_versions"),
        definitionRows,
      );
      await assert.rejects(
        f.service.read(
          { credential: "bob" },
          submission.manifest.id,
          submission.manifest.version,
        ),
      );
      await noImplicitAuthority(f);
    }));
  test(`real UI Service rejects invalid declarations before installing executable bytes on ${backend}`, async () =>
    isolated(backend, async (f) => {
      for (const mutate of [
        (s: ReturnType<typeof input>) => {
          s.definition.ui.sha256 = "a".repeat(64);
        },
        (s: ReturnType<typeof input>) => {
          s.manifest.title = "Another declaration";
        },
        (s: ReturnType<typeof input>) => {
          Reflect.set(s.manifest, "permissions", ["artifacts.write"]);
        },
        (s: ReturnType<typeof input>) => {
          Reflect.set(s.manifest, "permissions", ["artifacts.read"]);
        },
        (s: ReturnType<typeof input>) => {
          Reflect.set(s.definition, "ui", null);
        },
        (s: ReturnType<typeof input>) => {
          s.manifest.ui.html = "\ud800";
          s.definition.ui.sha256 = createHash("sha256")
            .update(s.manifest.ui.html)
            .digest("hex");
        },
      ]) {
        const submission = input();
        mutate(submission);
        await assert.rejects(
          f.service.installCognitive(access, randomUUID(), submission),
        );
        assert.equal(
          (await f.q.all("SELECT * FROM app_ui_packages")).length,
          0,
        );
        assert.equal(
          (await f.q.all("SELECT * FROM cognitive_app_versions")).length,
          0,
        );
        assert.equal(await f.service.hasCommittedVersions(), false);
      }
    }));
  test(`real UI Service preserves valid UI-only bytes after definition failure and retries the original command on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const submission = input();
      const commandId = randomUUID();
      const actual = f.platform.installCognitiveApp.bind(f.platform);
      f.platform.installCognitiveApp = async () => {
        throw new Error("TEST registry unavailable after actual UI commit");
      };
      await assert.rejects(
        f.service.installCognitive(access, commandId, submission),
        /TEST registry unavailable/,
      );
      assert.equal((await f.q.all("SELECT * FROM app_ui_packages")).length, 1);
      assert.equal(
        (await f.q.all("SELECT * FROM cognitive_app_versions")).length,
        0,
      );
      assert.equal(await f.service.hasCommittedVersions(), true);
      assert.deepEqual(
        await f.service.read(
          access,
          submission.manifest.id,
          submission.manifest.version,
        ),
        submission.manifest,
      );
      await noImplicitAuthority(f);
      f.platform.installCognitiveApp = actual;
      await f.service.installCognitive(access, commandId, submission);
      assert.equal((await f.q.all("SELECT * FROM app_ui_packages")).length, 1);
      assert.equal(
        (await f.q.all("SELECT * FROM cognitive_app_versions")).length,
        1,
      );
      const changed = input("<!doctype html><p>changed bytes</p>");
      await assert.rejects(
        f.service.installCognitive(access, commandId, changed),
      );
      assert.deepEqual(
        await f.service.read(
          access,
          submission.manifest.id,
          submission.manifest.version,
        ),
        submission.manifest,
      );
    }));
  test(`real UI Service snapshots submitted bytes, metadata and ingress credential before actual asynchronous identity SQL on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const submission = input();
      const original = structuredClone(submission);
      const credential = { credential: "alice" };
      let mutated = false;
      f.control.beforeResolve = async () => {
        if (mutated) return;
        await f.q.all("SELECT * FROM app_installations");
        mutated = true;
        submission.manifest.ui.html = "caller mutated";
        submission.manifest.title = "caller mutated";
        submission.definition.ui.sha256 = "b".repeat(64);
        submission.definition.title = "caller mutated";
        submission.definition.operations[0]!.inputSchema.properties.title.maxLength = 1;
        credential.credential = "bob";
      };
      const version = await f.service.installCognitive(
        credential,
        randomUUID(),
        submission,
      );
      assert.ok(mutated);
      assert.deepEqual(version.definition, original.definition);
      assert.equal(version.installedByPrincipalId, "alice");
      assert.deepEqual(
        await f.service.read(
          access,
          original.manifest.id,
          original.manifest.version,
        ),
        original.manifest,
      );
      await noImplicitAuthority(f);
    }));
}
