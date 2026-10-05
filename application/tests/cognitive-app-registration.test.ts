import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";
import { UiPackageService } from "../packages/application/src/ui-package-service.js";
import { createCognitiveAppHost } from "../packages/application/src/cognitive-app-host.js";
import { CognitiveAppServiceError } from "../packages/application/src/cognitive-app-service.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";
import {
  parseCognitiveAppRequest,
  parseCognitiveAppCatalog,
} from "../packages/core/src/cognitive-app-api.js";

const now = "2026-10-05T00:00:00.000Z";
const actor = (credential: string) => ({ credential });
const definition = {
  format: "morphz-cognitive-app/v1",
  protocol: "morphz-domain/v1",
  id: "example.notes",
  version: "1.0.0",
  title: "真实登记",
  description: "登记不等于同意",
  icon: "book",
  harness: null,
  ui: null,
  operations: [
    {
      id: "notes.list",
      title: "读取",
      description: "只读原件",
      effect: "read",
      scope: "project",
      inputSchema: { type: "null" },
      outputSchema: { type: "string" },
    },
  ],
} as const;
type Host = ReturnType<typeof createCognitiveAppHost>;
type Fixture = {
  platform: PlatformStore;
  host: Host;
  ui: UiPackageService;
  q: SqlQuery;
  control: { agentProjectId: string };
  reopen(): Promise<void>;
};
const denied = (code: string) => (error: unknown) => {
  assert.ok(error instanceof CognitiveAppServiceError);
  assert.equal(error.reason, code);
  return true;
};

// Real isolated relational/byte stores and shared service; identities and Agent
// source are controlled verifier fixtures, not actual Rust/provider acceptance.
async function isolated(
  backend: "sqlite" | "postgres",
  run: (f: Fixture) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "morphz-personal-registration-"));
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `morphz_registration_${suffix}`,
    byteSchema = `morphz_registration_bytes_${suffix}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : null;
  const control = { agentProjectId: "project-a" };
  const verifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      if (credential === "agent")
        return {
          tenantId: "tenant-a",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-one",
          initiatingHumanActantId: "alice-human",
          scopeProjectId: control.agentProjectId,
        };
      if (!["alice", "bob", "carol", "foreign"].includes(credential))
        return null;
      return {
        tenantId: credential === "foreign" ? "tenant-b" : "tenant-a",
        principalId: credential === "foreign" ? "alice" : credential,
        actantId:
          credential === "foreign" ? "alice-human" : `${credential}-human`,
        kind: "human",
        runtimeInputId: null,
      };
    },
    async resolveActant({ actantId }) {
      return actantId === "agent-one"
        ? { principalId: "agent-service", kind: "agent" }
        : ["alice-human", "bob-human", "carol-human"].includes(actantId)
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
    host: Host | undefined;
  let db: DatabaseSync | undefined, release: (() => void) | undefined;
  const open = () =>
    pool
      ? PlatformStore.postgres(
          { connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!, schema },
          verifier,
        )
      : PlatformStore.sqlite(join(root, "platform.sqlite"), verifier);
  const bytes = () =>
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
        "Formal runner must provide PostgreSQL; never skip.",
      );
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE SCHEMA "${byteSchema}"`);
    }
    platform = await open();
    await platform.provisionTenant("tenant-a", now);
    await platform.provisionTenant("tenant-b", now);
    ui = await bytes();
    host = createCognitiveAppHost({
      tenantId: "tenant-a",
      platform,
      uiPackages: ui,
    });
    let q: SqlQuery;
    if (pool) {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}",pg_catalog`);
      q = postgresQuery(client);
      release = () => client.release();
    } else {
      db = new DatabaseSync(join(root, "platform.sqlite"));
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(db);
    }
    await q.change(
      "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','project-a','project','alice','真实测试',1,?,?)",
      [now, now],
    );
    for (const member of ["alice", "bob", "agent-service"])
      await q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a',?)",
        [member],
      );
    const f: Fixture = {
      platform,
      ui,
      host,
      q,
      control,
      async reopen() {
        await host!.close();
        await ui!.close();
        await platform!.close();
        platform = await open();
        ui = await bytes();
        host = createCognitiveAppHost({
          tenantId: "tenant-a",
          platform,
          uiPackages: ui,
        });
        f.platform = platform;
        f.ui = ui;
        f.host = host;
      },
    };
    await run(f);
  } finally {
    release?.();
    await host?.close();
    await ui?.close();
    await platform?.close();
    db?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${byteSchema}" CASCADE`);
      await pool.end();
    }
    rmSync(root, { recursive: true, force: true });
  }
}
const install = (f: Fixture, who = "alice", extra = {}) =>
  f.host.service.install(actor(who), {
    definition: { ...definition, ...extra },
  });
const register = (
  f: Fixture,
  who: string,
  commandId: string,
  exact: { appId: string; version: string; definitionHash: string },
) =>
  f.host.service.install(actor(who), {
    mode: "register-installed",
    commandId,
    ...exact,
  });
async function accessRevision(f: Fixture) {
  return Number(
    (
      await f.q.all<{ access_revision: number | string }>(
        "SELECT access_revision FROM navigation_heads WHERE tenant_id='tenant-a'",
      )
    )[0]!.access_revision,
  );
}
async function connections(
  f: Fixture,
  exact: { appId: string; version: string; definitionHash: string },
  count: number,
) {
  await f.host.service.grant(actor("alice"), {
    appId: exact.appId,
    version: exact.version,
    expectedRevision: 0,
    state: "active",
  });
  for (let index = 0; index < count; index++)
    await f.platform.createVerifiedCognitiveAppConnection(actor("alice"), {
      connectionId: `conn-${String(index).padStart(3, "0")}`,
      expectedRevision: 0,
      now,
      // Controlled Host /describe evidence for catalogue-only persistence, not
      // a claim of actual author authentication or Runtime execution.
      proof: {
        purpose: "connection-setup",
        ...exact,
        serviceId: "服".repeat(200),
        dataAuthorityId: "据".repeat(200),
        hostBindingId: "host-fixture-private",
      },
    });
}

test("personal registration strict carriers reject self-reported identity and unsafe accessors", () => {
  const exact = {
    mode: "register-installed",
    commandId: "import-one",
    appId: definition.id,
    version: definition.version,
    definitionHash: "a".repeat(64),
  };
  assert.deepEqual(parseCognitiveAppRequest("install", exact), exact);
  for (const key of [
    "principalId",
    "tenantId",
    "manifest",
    "definition",
    "grant",
    "includeAll",
    "hostBindingId",
  ])
    assert.throws(() =>
      parseCognitiveAppRequest("install", { ...exact, [key]: "untrusted" }),
    );
  let calls = 0;
  assert.throws(() =>
    parseCognitiveAppRequest("install", {
      ...exact,
      get appId() {
        calls++;
        return definition.id;
      },
    }),
  );
  assert.equal(calls, 0);
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`personal registration keeps repeated installers visible after cold reopen on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const first = await install(f);
      const repeat = await install(f, "bob");
      assert.deepEqual(repeat, first);
      for (const who of ["alice", "bob"]) {
        const list = await f.host.service.list(actor(who), { limit: 10 });
        assert.equal(list.versions.length, 1);
        assert.equal(list.versions[0]!.grant, null);
        assert.equal(
          Reflect.get(list.versions[0]!, "installationState"),
          "active",
        );
        assert.ok(Date.parse(Reflect.get(list.versions[0]!, "registeredAt")));
      }
      assert.equal(
        (await f.host.service.list(actor("carol"), { limit: 10 })).versions
          .length,
        0,
      );
      assert.equal(
        (await f.host.service.list(actor("foreign"), { limit: 10 })).versions
          .length,
        0,
      );
      assert.equal(
        (await f.host.service.list(actor("agent"), { limit: 10 })).versions
          .length,
        0,
      );
      await assert.rejects(
        register(f, "agent", "agent-import", first),
        denied("forbidden"),
      );
      await assert.rejects(
        f.host.service.describe(actor("alice"), {
          projectId: "project-a",
          appId: first.appId,
          version: first.version,
        }),
        denied("forbidden"),
      );
      await assert.rejects(
        f.host.service.connect(actor("bob"), {
          appId: first.appId,
          version: first.version,
          connectionId: "conn-bob",
          expectedRevision: 0,
          serviceId: "service",
          dataAuthorityId: "data",
        }),
        denied("forbidden"),
      );
      await f.reopen();
      assert.equal(
        (await f.host.service.list(actor("bob"), { limit: 10 })).versions
          .length,
        1,
      );
      assert.deepEqual(
        (
          await f.q.all(
            "SELECT installed_by_principal_id FROM cognitive_app_versions",
          )
        ).map((r) => r.installed_by_principal_id),
        ["alice"],
      );
      for (const table of [
        "cognitive_app_grants",
        "cognitive_app_connections",
        "cognitive_app_view_bindings",
        "content_entries",
      ])
        assert.equal((await f.q.all(`SELECT * FROM ${table}`)).length, 0);
    }));
  test(`personal registration exact receipts are atomic concurrent and idempotent on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const exact = await install(f);
      const before = await accessRevision(f);
      const results = await Promise.all([
        register(f, "bob", "register-bob", exact),
        register(f, "bob", "register-bob", exact),
      ]);
      assert.deepEqual(results, [exact, exact]);
      assert.equal(await accessRevision(f), before + 1);
      const rows = await f.q.all(
        "SELECT * FROM command_receipts WHERE command_id='register-bob'",
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.actor_principal_id, "bob");
      assert.equal(rows[0]!.actor_actant_id, "bob-human");
      await register(f, "bob", "register-bob", exact);
      await register(f, "bob", "register-bob-again", exact);
      assert.equal(await accessRevision(f), before + 1);
      await assert.rejects(
        register(f, "carol", "register-bob", exact),
        denied("conflict"),
      );
      await assert.rejects(
        register(f, "bob", "register-bob", {
          ...exact,
          definitionHash: "b".repeat(64),
        }),
        denied("conflict"),
      );
      await assert.rejects(
        register(f, "carol", "wrong-hash", {
          ...exact,
          definitionHash: "b".repeat(64),
        }),
        denied("not_found"),
      );
      await assert.rejects(
        register(f, "foreign", "cross-tenant", exact),
        denied("not_found"),
      );
      assert.equal(
        (
          await f.q.all(
            "SELECT * FROM cognitive_app_registrations WHERE principal_id='carol'",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await f.q.all(
            "SELECT * FROM command_receipts WHERE command_id='wrong-hash'",
          )
        ).length,
        0,
      );
      await f.reopen();
      assert.deepEqual(await register(f, "bob", "register-bob", exact), exact);
      assert.equal(await accessRevision(f), before + 1);
    }));
  test(`personal registration rollback keeps relation receipt and access head atomic on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const exact = await install(f);
      const before = await accessRevision(f);
      if (backend === "sqlite")
        await f.q.exec(
          "CREATE TRIGGER fixture_registration_failure BEFORE INSERT ON command_receipts WHEN NEW.command_id='fail-register' BEGIN SELECT RAISE(ABORT,'fixture'); END",
        );
      else {
        await f.q.exec(
          "CREATE FUNCTION fixture_registration_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command_id='fail-register' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$",
        );
        await f.q.exec(
          "CREATE TRIGGER fixture_registration_failure BEFORE INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION fixture_registration_failure()",
        );
      }
      await assert.rejects(
        register(f, "bob", "fail-register", exact),
        denied("unavailable"),
      );
      assert.equal(
        (
          await f.q.all(
            "SELECT * FROM cognitive_app_registrations WHERE principal_id='bob'",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await f.q.all(
            "SELECT * FROM command_receipts WHERE command_id='fail-register'",
          )
        ).length,
        0,
      );
      assert.equal(await accessRevision(f), before);
      await f.q.exec(
        backend === "sqlite"
          ? "DROP TRIGGER fixture_registration_failure"
          : "DROP TRIGGER fixture_registration_failure ON command_receipts",
      );
      await register(f, "bob", "fail-register", exact);
      assert.equal(await accessRevision(f), before + 1);
    }));
  test(`personal registration metadata-only GUI import preserves private byte owner on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const html = "<!doctype html><meta charset=utf-8><h1>不可借用的原件</h1>";
      const manifest = {
        format: applicationManifestFormat,
        id: definition.id,
        version: definition.version,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        permissions: ["input.compose"],
        harness: null,
        ui: { type: "sandbox", html },
      };
      const gui = {
        ...definition,
        ui: {
          packageVersion: definition.version,
          sha256: createHash("sha256").update(html).digest("hex"),
        },
      };
      const exact = await f.host.service.install(actor("alice"), {
        definition: gui,
        manifest,
        commandId: "install-gui",
      });
      const before = await f.q.all("SELECT * FROM app_ui_packages");
      await register(f, "bob", "register-gui-bob", exact);
      assert.deepEqual(await f.q.all("SELECT * FROM app_ui_packages"), before);
      assert.equal(
        (await f.host.service.list(actor("bob"), { limit: 10 })).versions[0]!
          .grant,
        null,
      );
      await assert.rejects(f.ui.read(actor("bob"), exact.appId, exact.version));
      await f.reopen();
      assert.equal(
        (await f.host.service.list(actor("bob"), { limit: 10 })).versions
          .length,
        1,
      );
      await assert.rejects(
        f.host.service.install(actor("bob"), {
          definition: gui,
          manifest,
          commandId: "bob-byte-install",
        }),
        denied("conflict"),
      );
      assert.deepEqual(await f.q.all("SELECT * FROM app_ui_packages"), before);
      assert.equal(
        (await f.q.all("SELECT * FROM cognitive_app_grants")).length,
        0,
      );
    }));
  test(`personal registered-management previews exact definitions without granting authority on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const exact = await install(f);
      const request = {
        mode: "registered-management",
        appId: exact.appId,
        version: exact.version,
        expectedDefinitionHash: exact.definitionHash,
      };
      const preview = await f.host.service.describe(actor("alice"), request);
      assert.equal(Reflect.get(preview, "mode"), "registered-management");
      assert.equal(Reflect.get(preview, "grant"), null);
      assert.deepEqual(preview.definition, definition);
      await assert.rejects(
        f.host.service.describe(actor("agent"), request),
        denied("forbidden"),
      );
      await assert.rejects(
        f.host.service.describe(actor("bob"), request),
        denied("not_found"),
      );
      await assert.rejects(
        f.host.service.describe(actor("foreign"), request),
        denied("not_found"),
      );
      await assert.rejects(
        f.host.service.describe(actor("alice"), {
          ...request,
          expectedDefinitionHash: "b".repeat(64),
        }),
        denied("not_found"),
      );
      await assert.rejects(
        f.host.service.describe(actor("alice"), {
          ...request,
          projectId: "project-a",
        }),
        denied("invalid"),
      );
      await f.q.change(
        "UPDATE app_installations SET state='disabled' WHERE tenant_id='tenant-a' AND app_id=?",
        [definition.id],
      );
      assert.equal(
        Reflect.get(
          await f.host.service.describe(actor("alice"), request),
          "installationState",
        ),
        "disabled",
      );
      await assert.rejects(
        f.host.service.grant(actor("alice"), {
          appId: exact.appId,
          version: exact.version,
          expectedRevision: 0,
          state: "active",
        }),
        denied("forbidden"),
      );
      for (const table of [
        "cognitive_app_grants",
        "cognitive_app_connections",
        "app_view_instances",
        "outbox",
        "content_entries",
      ])
        assert.equal((await f.q.all(`SELECT * FROM ${table}`)).length, 0);
    }));
  test(`personal catalogue bounds maximum author icons and exhausts both keyset streams on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const iconImage = "data:image/png;base64," + "A".repeat(179_976);
      assert.ok(iconImage.length <= 180_000);
      for (let index = 0; index < 100; index++)
        await install(f, "alice", {
          version: `${index}.0.0`,
          iconImage,
          title: "完整😀图标",
        });
      const exact = await f.host.service.install(actor("alice"), {
        definition: {
          ...definition,
          version: "0.0.0",
          iconImage,
          title: "完整😀图标",
        },
      });
      await connections(f, exact, 100);
      const seen = new Set<string>();
      const seenConnections = new Set<string>();
      let versionsAfter: string | undefined;
      let connectionsAfter: string | undefined;
      for (let page = 0; page < 101; page++) {
        const result = await f.host.service.list(actor("alice"), {
          limit: 100,
          ...(versionsAfter ? { versionsAfter } : {}),
          ...(connectionsAfter ? { connectionsAfter } : {}),
        });
        parseCognitiveAppCatalog(result);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 480 * 1024);
        assert.ok(
          Buffer.byteLength(JSON.stringify(result.versions)) <= 384 * 1024,
        );
        assert.ok(
          Buffer.byteLength(JSON.stringify(result.connections)) <= 80 * 1024,
        );
        assert.ok(result.versions.length > 0);
        for (const row of result.versions) {
          assert.equal(Reflect.get(row, "iconImage"), iconImage);
          assert.equal(seen.has(row.version), false);
          seen.add(row.version);
        }
        for (const row of result.connections) {
          assert.equal(seenConnections.has(row.connectionId), false);
          seenConnections.add(row.connectionId);
        }
        if (
          result.nextVersionsAfter === null &&
          result.nextConnectionsAfter === null
        )
          break;
        versionsAfter = result.nextVersionsAfter ?? undefined;
        connectionsAfter = result.nextConnectionsAfter ?? undefined;
        assert.ok(page < 100, "Finite prefix continuation must progress.");
      }
      assert.equal(seen.size, 100);
      assert.equal(seenConnections.size, 100);
      const first = await f.host.service.list(actor("alice"), { limit: 1 });
      assert.ok(first.nextVersionsAfter);
      await assert.rejects(
        f.host.service.list(actor("bob"), {
          limit: 1,
          versionsAfter: first.nextVersionsAfter,
        }),
        denied("invalid"),
      );
      await assert.rejects(
        f.host.service.list(actor("agent"), {
          limit: 1,
          versionsAfter: first.nextVersionsAfter,
        }),
        denied("invalid"),
      );
      await assert.rejects(
        f.host.service.list(actor("alice"), {
          limit: 1,
          appId: definition.id,
          versionsAfter: first.nextVersionsAfter,
        }),
        denied("invalid"),
      );
      await install(f, "alice", { id: "aaa.notes" });
      await assert.rejects(
        f.host.service.list(actor("alice"), {
          limit: 1,
          versionsAfter: first.nextVersionsAfter,
        }),
        denied("invalid"),
      );
    }));
  test(`personal paired checkpoints preserve either EOF and reject mixed kinds scopes and stale heads on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const exact = await install(f);
      await install(f, "alice", { version: "2.0.0" });
      await connections(f, exact, 4);
      const first = await f.host.service.list(actor("alice"), { limit: 1 });
      assert.ok(first.nextVersionsAfter && first.nextConnectionsAfter);
      const second = await f.host.service.list(actor("alice"), {
        limit: 1,
        versionsAfter: first.nextVersionsAfter,
      });
      assert.equal(second.nextVersionsAfter, null);
      assert.ok(second.nextConnectionsAfter);
      const third = await f.host.service.list(actor("alice"), {
        limit: 1,
        connectionsAfter: second.nextConnectionsAfter,
      });
      assert.equal(third.versions.length, 0);
      assert.equal(third.connections[0]!.connectionId, "conn-002");
      await assert.rejects(
        f.host.service.list(actor("alice"), {
          limit: 1,
          versionsAfter: first.nextVersionsAfter,
          connectionsAfter: second.nextConnectionsAfter,
        }),
        denied("invalid"),
      );
      await assert.rejects(
        f.host.service.list(actor("alice"), {
          limit: 1,
          versionsAfter: first.nextConnectionsAfter,
        }),
        denied("invalid"),
      );
      // Content/navigation-only invalidation does not invalidate permission pages.
      await f.q.change(
        "UPDATE navigation_heads SET revision=revision+1 WHERE tenant_id='tenant-a'",
      );
      assert.equal(
        (
          await f.host.service.list(actor("alice"), {
            limit: 1,
            versionsAfter: first.nextVersionsAfter,
          })
        ).versions[0]!.version,
        "2.0.0",
      );
      const agentPage = await f.host.service.list(actor("agent"), { limit: 1 });
      assert.ok(agentPage.nextConnectionsAfter);
      await f.q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','project-b','project','alice','另项目',1,?,?)",
        [now, now],
      );
      for (const member of ["alice", "agent-service"])
        await f.q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-b',?)",
          [member],
        );
      f.control.agentProjectId = "project-b";
      await assert.rejects(
        f.host.service.list(actor("agent"), {
          limit: 1,
          connectionsAfter: agentPage.nextConnectionsAfter,
        }),
        denied("invalid"),
      );
      f.control.agentProjectId = "project-a";
      const legacyCursor = Buffer.from(
        JSON.stringify([
          1,
          "versions",
          "tenant-a",
          "alice",
          null,
          definition.id,
          definition.version,
        ]),
      ).toString("base64url");
      await assert.rejects(
        f.host.service.list(actor("alice"), {
          limit: 1,
          versionsAfter: legacyCursor,
        }),
        denied("invalid"),
      );
      await install(f, "alice", { id: "aaa.notes" });
      for (const continuation of [
        { versionsAfter: first.nextVersionsAfter },
        { connectionsAfter: first.nextConnectionsAfter },
      ])
        await assert.rejects(
          f.host.service.list(actor("alice"), { limit: 1, ...continuation }),
          denied("invalid"),
        );
      const reset = await f.host.service.list(actor("alice"), { limit: 100 });
      assert.equal(reset.versions[0]!.appId, "aaa.notes");
      assert.equal(reset.versions.length, 3);
      assert.equal(reset.connections.length, 4);
    }));
}
