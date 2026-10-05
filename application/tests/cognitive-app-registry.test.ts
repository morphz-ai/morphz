import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  createCognitiveAppRegistry,
  type CognitiveAppRegistryContext,
} from "../packages/platform/src/cognitive-app-registry.js";
import { platformSchemaSql } from "../packages/platform/src/schema.js";
import {
  sqliteQuery,
  postgresQuery,
  withSqliteWriteGate,
  type SqlQuery,
} from "../packages/storage/src/sql.js";
import { canonicalJsonBytes } from "../packages/cognitive-app-sdk/src/domain-wire.js";

const now = "2026-10-05T00:00:00.000Z";
const later = "2026-10-05T01:00:00.000Z";
const definition = {
  format: "morphz-cognitive-app/v1",
  protocol: "morphz-domain/v1",
  id: "example.notes",
  version: "1.0.0",
  title: "Notes",
  description: "Independent notes service",
  icon: "book",
  harness: null,
  ui: null,
  operations: [
    {
      id: "create-note",
      title: "Create note",
      description: "Create one note",
      effect: "write",
      scope: "project",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
} as const;
type Registry = ReturnType<typeof createCognitiveAppRegistry>;
class RegistryFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail: CognitiveAppRegistryContext["fail"] = (code, message) => {
  throw new RegistryFailure(code, message);
};
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof RegistryFailure);
  assert.equal(error.code, expected);
  return true;
};
type Harness = {
  tx<T>(
    principalId: string,
    work: (registry: Registry, q: SqlQuery) => Promise<T>,
    tenantId?: string,
  ): Promise<T>;
};

async function isolated(
  backend: "sqlite" | "postgres",
  work: (h: Harness) => Promise<void>,
) {
  if (backend === "sqlite") {
    const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-registry-"));
    const filename = join(directory, "platform.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    initial.exec(platformSchemaSql);
    initial.close();
    try {
      await run({
        async tx(principalId, action, tenantId = "tenant-a") {
          return withSqliteWriteGate(filename, async () => {
            const db = new DatabaseSync(filename);
            try {
              db.exec(
                "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE",
              );
              const q = sqliteQuery(db);
              const value = await action(
                createCognitiveAppRegistry({
                  q,
                  backend,
                  tenantId,
                  principalId,
                  fail,
                }),
                q,
              );
              db.exec("COMMIT");
              return value;
            } catch (error) {
              if (db.isTransaction) db.exec("ROLLBACK");
              throw error;
            } finally {
              db.close();
            }
          });
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } else {
    assert.ok(
      process.env.MORPHZ_TEST_POSTGRES_URL,
      "Standard runner must prepare PostgreSQL.",
    );
    const schema = `morphz_test_registry_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL,
    });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}",pg_catalog`);
        await client.query(platformSchemaSql);
      } finally {
        client.release();
      }
      await run({
        async tx(principalId, action, tenantId = "tenant-a") {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              `SET LOCAL search_path TO "${schema}",pg_catalog`,
            );
            const q = postgresQuery(client);
            const value = await action(
              createCognitiveAppRegistry({
                q,
                backend,
                tenantId,
                principalId,
                fail,
              }),
              q,
            );
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        },
      });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }
  async function run(h: Harness) {
    await h.tx("alice", async (_, q) => {
      for (const tenant of ["tenant-a", "tenant-b"])
        await q.change("INSERT INTO tenants VALUES(?,?)", [tenant, now]);
      await q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','project-a','project','alice','Project',1,?,?)",
        [now, now],
      );
    });
    await work(h);
  }
}
async function installed(h: Harness, principalId = "alice") {
  return h.tx(principalId, async (r) => {
    const version = await r.installVersion(definition, now);
    await r.changeOwnGrant({
      appId: definition.id,
      version: definition.version,
      expectedRevision: 0,
      state: "active",
      now,
    });
    return version;
  });
}
const connection = (
  connectionId: string,
  hostBindingId = "private_alias_alice",
) => ({
  appId: definition.id,
  version: definition.version,
  connectionId,
  serviceId: "author/service",
  dataAuthorityId: "author/database:original",
  hostBindingId,
  expectedRevision: 0 as const,
  now,
});
async function connected(
  h: Harness,
  principalId = "alice",
  connectionId = "conn-alice",
) {
  await installed(h, principalId);
  return h.tx(principalId, (r) =>
    r.createOwnConnection(connection(connectionId)),
  );
}
async function view(h: Harness, owner = "alice", viewId = "view-a") {
  await h.tx(owner, async (_, q) => {
    await q.change(
      "INSERT INTO app_view_instances VALUES('tenant-a',?,?,'project-a','example.notes','1.0.0',?,7,'open',?,?)",
      [
        viewId,
        owner,
        JSON.stringify({ objectId: "old_object", versionRef: "old_version" }),
        now,
        now,
      ],
    );
  });
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(`registry exact own connection management remains available after disabling on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      const created = await h.tx("alice", (r) =>
        r.createOwnConnection(connection("manage-one")),
      );
      await h.tx("alice", async (r, q) => {
        await r.changeOwnGrant({
          appId: definition.id,
          version: definition.version,
          expectedRevision: 1,
          state: "disabled",
          now: later,
        });
        await r.changeOwnConnection({
          ...connection("manage-one"),
          expectedRevision: 1,
          state: "disabled",
          now: later,
        });
        await q.change(
          "UPDATE app_instances SET state='disabled' WHERE tenant_id='tenant-a' AND instance_id=?",
          [created.instanceId],
        );
      });
      const request = {
        appId: definition.id,
        connectionId: created.connectionId,
      };
      const current = await h.tx("alice", (r) =>
        r.readOwnConnectionForManagement(request),
      );
      assert.equal(current.state, "disabled");
      assert.equal(current.hostBindingId, "private_alias_alice");
      assert.equal(current.instanceId, created.instanceId);
      await assert.rejects(
        () => h.tx("bob", (r) => r.readOwnConnectionForManagement(request)),
        code("not_found"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.readOwnConnectionForManagement({
              ...request,
              appId: "example.foreign",
            }),
          ),
        code("not_found"),
      );
      await assert.rejects(
        () => h.tx("alice", (r) => r.readHostConnection(created)),
        code("forbidden"),
      );
    }));
  test(`registry Host describe locks exact own active consent before connections on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const version = await installed(h);
      const consent = await h.tx("alice", (r) =>
        r.lockOwnConsent({
          appId: definition.id,
          version: definition.version,
          expectedDefinitionHash: version.definitionHash,
          expectedGrantRevision: 1,
        }),
      );
      assert.equal(consent.grant.revision, 1);
      assert.equal(consent.version.definitionHash, version.definitionHash);
      const exact = await h.tx("alice", (r) =>
        r.readExactVersion(definition.id, definition.version),
      );
      assert.equal(exact.definitionHash, version.definitionHash);
      await assert.rejects(
        () =>
          h.tx("bob", (r) =>
            r.lockOwnConsent({
              appId: definition.id,
              version: definition.version,
            }),
          ),
        code("forbidden"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockOwnConsent({
              appId: definition.id,
              version: definition.version,
              expectedDefinitionHash: "0".repeat(64),
            }),
          ),
        code("conflict"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockOwnConsent({
              appId: definition.id,
              version: definition.version,
              expectedGrantRevision: 9,
            }),
          ),
        code("conflict"),
      );
      await h.tx("alice", (r) =>
        r.changeOwnGrant({
          appId: definition.id,
          version: definition.version,
          expectedRevision: 1,
          state: "disabled",
          now,
        }),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockOwnConsent({
              appId: definition.id,
              version: definition.version,
            }),
          ),
        code("forbidden"),
      );
      const retained = await h.tx("alice", (r) =>
        r.lockRetainedVersion({
          appId: definition.id,
          version: definition.version,
          expectedDefinitionHash: version.definitionHash,
        }),
      );
      assert.equal(retained.definitionHash, version.definitionHash);
    }));
  test(`registry preserves portable opaque authority bytes on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      for (const [index, value] of [
        " ",
        "authority\noriginal",
        "数据😀\t",
      ].entries()) {
        const created = await h.tx("alice", (r) =>
          r.createOwnConnection({
            ...connection(`portable-${index}`),
            serviceId: value,
            dataAuthorityId: value,
          }),
        );
        assert.equal(created.serviceId, value);
        assert.equal(created.dataAuthorityId, value);
        const target = await h.tx("alice", (r) =>
          r.lockCurrentTarget({
            appId: definition.id,
            version: definition.version,
            connectionId: created.connectionId,
          }),
        );
        assert.equal(target.serviceId, value);
        assert.equal(target.dataAuthorityId, value);
      }
      for (const [index, value] of [
        "",
        "nul\u0000tail",
        "high\ud800",
        "low\udc00",
      ].entries()) {
        await assert.rejects(
          () =>
            h.tx("alice", (r) =>
              r.createOwnConnection({
                ...connection(`unsafe-${index}`),
                serviceId: value,
              }),
            ),
          code("invalid"),
        );
        await assert.rejects(
          () =>
            h.tx("alice", (r) =>
              r.createOwnConnection({
                ...connection(`unsafe-data-${index}`),
                dataAuthorityId: value,
              }),
            ),
          code("invalid"),
        );
      }
    }));
  test(`registry immutable canonical headless versions and retained installation on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await h.tx("alice", async (_, q) => {
        await q.change(
          "INSERT INTO app_installations VALUES('tenant-a','example.notes','original-ui-install','active',?)",
          [now],
        );
        await q.change(
          "INSERT INTO app_ui_packages VALUES('tenant-a','example.notes','1.0.0','alice','{}','original-store','original-artifact',1,?,42,?)",
          ["a".repeat(64), now],
        );
      });
      const first = await h.tx("alice", (r) =>
        r.installVersion(definition, now),
      );
      assert.equal(first.installationId, "original-ui-install");
      assert.equal(
        first.definitionHash,
        createHash("sha256")
          .update(canonicalJsonBytes(definition))
          .digest("hex"),
      );
      const reordered = Object.fromEntries(
        Object.entries(definition).reverse(),
      );
      const repeated = await h.tx("bob", (r) =>
        r.installVersion(reordered, later),
      );
      assert.deepEqual(repeated, first);
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.installVersion({ ...definition, title: "Changed" }, later),
          ),
        code("conflict"),
      );
      await h.tx("alice", async (_, q) => {
        const ui = (
          await q.all("SELECT store_id,artifact_id,sha256 FROM app_ui_packages")
        )[0];
        assert.deepEqual(
          { ...ui },
          {
            store_id: "original-store",
            artifact_id: "original-artifact",
            sha256: "a".repeat(64),
          },
        );
        assert.equal(
          (await q.all("SELECT * FROM cognitive_app_grants")).length,
          0,
        );
      });
    }));
  test(`registry connection preserves the admitted route while a new alias reuses its authority on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const first = await connected(h);
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.changeOwnConnection({
              expectedAppId: "another.notes",
              connectionId: first.connectionId,
              expectedRevision: first.revision,
              serviceId: first.serviceId,
              dataAuthorityId: first.dataAuthorityId,
              hostBindingId: "private_alias_alice",
              state: "disabled",
              now: later,
            }),
          ),
        code("conflict"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.changeOwnConnection({
              connectionId: first.connectionId,
              expectedRevision: first.revision,
              serviceId: first.serviceId,
              dataAuthorityId: first.dataAuthorityId,
              hostBindingId: "new_endpoint_alias",
              state: "active",
              now: later,
            }),
          ),
        code("conflict"),
      );
      await h.tx("alice", async (_, q) => {
        const retained = (
          await q.all(
            "SELECT host_binding_id,revision FROM cognitive_app_connections WHERE connection_id=?",
            [first.connectionId],
          )
        )[0]!;
        assert.equal(retained.host_binding_id, "private_alias_alice");
        assert.equal(Number(retained.revision), first.revision);
      });
      const replacement = await h.tx("alice", (r) =>
        r.createOwnConnection(
          connection("new-route-connection", "new_endpoint_alias"),
        ),
      );
      assert.equal(replacement.instanceId, first.instanceId);
      await h.tx("alice", async (_, q) => {
        const routes = await q.all(
          "SELECT connection_id,host_binding_id FROM cognitive_app_connections ORDER BY connection_id",
        );
        assert.deepEqual(
          routes.map((row) => [row.connection_id, row.host_binding_id]),
          [
            [first.connectionId, "private_alias_alice"],
            [replacement.connectionId, "new_endpoint_alias"],
          ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
        );
      });
    }));
  test(`registry rejects unverified GUI, claimed hashes, reserved IDs and unsafe definitions on ${backend}`, async () =>
    isolated(backend, async (h) => {
      for (const candidate of [
        {
          ...definition,
          ui: { packageVersion: "1.0.0", sha256: "a".repeat(64) },
        },
        { ...definition, definitionHash: "a".repeat(64) },
        { ...definition, id: "morphz.imposter" },
        { ...definition, title: "x".repeat(10000) },
        {
          ...definition,
          operations: [
            {
              ...definition.operations[0],
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: true,
              },
            },
          ],
        },
      ])
        await assert.rejects(
          () => h.tx("alice", (r) => r.installVersion(candidate, now)),
          code("invalid"),
        );
      await h.tx("alice", async (_, q) =>
        assert.equal(
          (await q.all("SELECT * FROM app_installations")).length,
          0,
        ),
      );
    }));
  test(`registry exact-version own grants use CAS and never activate a new version implicitly on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      await h.tx("alice", (r) =>
        r.installVersion({ ...definition, version: "2.0.0" }, later),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.changeOwnGrant({
              appId: definition.id,
              version: "1.0.0",
              expectedRevision: 0,
              state: "active",
              now: later,
            }),
          ),
        code("conflict"),
      );
      const off = await h.tx("alice", (r) =>
        r.changeOwnGrant({
          appId: definition.id,
          version: "1.0.0",
          expectedRevision: 1,
          state: "disabled",
          now: later,
        }),
      );
      assert.equal(off.revision, 2);
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.changeOwnGrant({
              appId: definition.id,
              version: "1.0.0",
              expectedRevision: 1,
              state: "active",
              now: later,
            }),
          ),
        code("conflict"),
      );
      const own = await h.tx("alice", (r) => r.readOwnRegistry({ limit: 20 }));
      assert.equal(own.versions.length, 1);
      assert.equal(own.versions[0]!.grant.state, "disabled");
      assert.equal(
        (await h.tx("bob", (r) => r.readOwnRegistry({ limit: 20 }))).versions
          .length,
        0,
      );
    }));
  test(`registry concurrent own grant CAS permits only one writer on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      const outcomes = await Promise.allSettled(
        ["active", "disabled"].map((state) =>
          h.tx("alice", (r) =>
            r.changeOwnGrant({
              appId: definition.id,
              version: definition.version,
              expectedRevision: 1,
              state: state as "active" | "disabled",
              now: later,
            }),
          ),
        ),
      );
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
    }));
  test(`registry concurrent authority and personal connections share one immutable service instance on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      await installed(h, "bob");
      const [alice, bob] = await Promise.all([
        h.tx("alice", (r) => r.createOwnConnection(connection("conn-alice"))),
        h.tx("bob", (r) =>
          r.createOwnConnection(connection("conn-bob", "private_alias_bob")),
        ),
      ]);
      assert.equal(alice.instanceId, bob.instanceId);
      assert.notEqual(alice.connectionId, bob.connectionId);
      await h.tx("alice", async (_, q) => {
        const instances = await q.all(
          "SELECT route_kind,route_ref,node_id FROM app_instances",
        );
        assert.equal(instances.length, 1);
        assert.equal(instances[0]!.route_kind, "service");
        assert.equal(instances[0]!.node_id, null);
        assert.match(
          String(instances[0]!.route_ref),
          /^cognitive_authority_[a-f0-9]{64}$/,
        );
        assert.ok(!JSON.stringify(instances).includes("private_alias"));
      });
    }));
  test(`registry authority JSON identities cannot collide by delimiter concatenation on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      const [one, two] = await h.tx("alice", async (r) => [
        await r.ensureAuthority({
          appId: definition.id,
          serviceId: "a:b",
          dataAuthorityId: "c",
          now,
        }),
        await r.ensureAuthority({
          appId: definition.id,
          serviceId: "a",
          dataAuthorityId: "b:c",
          now,
        }),
      ]);
      assert.notEqual(one!.instanceId, two!.instanceId);
      await h.tx("alice", async (_, q) =>
        assert.equal(
          (await q.all("SELECT * FROM cognitive_app_authorities")).length,
          2,
        ),
      );
    }));
  test(`registry own connection CAS hides aliases and rejects foreign owners, stale revisions and authority replacement on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const first = await connected(h);
      const changed = await h.tx("alice", (r) =>
        r.changeOwnConnection({
          connectionId: first.connectionId,
          expectedRevision: 1,
          serviceId: first.serviceId,
          dataAuthorityId: first.dataAuthorityId,
          hostBindingId: "private_alias_alice",
          state: "active",
          now: later,
        }),
      );
      assert.equal(changed.revision, 2);
      for (const patch of [
        { expectedRevision: 1, dataAuthorityId: first.dataAuthorityId },
        { expectedRevision: 2, dataAuthorityId: "new-empty-database" },
      ])
        await assert.rejects(
          () =>
            h.tx("alice", (r) =>
              r.changeOwnConnection({
                connectionId: first.connectionId,
                serviceId: first.serviceId,
                hostBindingId: "private_alias_alice",
                state: "active",
                now: later,
                ...patch,
              }),
            ),
          code("conflict"),
        );
      await assert.rejects(
        () =>
          h.tx("bob", (r) =>
            r.changeOwnConnection({
              connectionId: first.connectionId,
              expectedRevision: 2,
              serviceId: first.serviceId,
              dataAuthorityId: first.dataAuthorityId,
              hostBindingId: "private_bob",
              state: "active",
              now: later,
            }),
          ),
        code("not_found"),
      );
      const publicView = await h.tx("alice", (r) =>
        r.readOwnRegistry({ limit: 20 }),
      );
      assert.ok(
        !JSON.stringify([first, changed, publicView]).includes("private_"),
      );
      const privateView = await h.tx("alice", (r) =>
        r.readHostConnection({
          connectionId: first.connectionId,
          appId: first.appId,
          instanceId: first.instanceId,
          serviceId: first.serviceId,
          dataAuthorityId: first.dataAuthorityId,
        }),
      );
      assert.equal(privateView.hostBindingId, "private_alias_alice");
      await assert.rejects(
        () =>
          h.tx("bob", (r) =>
            r.readHostConnection({
              connectionId: first.connectionId,
              appId: first.appId,
              instanceId: first.instanceId,
              serviceId: first.serviceId,
              dataAuthorityId: first.dataAuthorityId,
            }),
          ),
        code("not_found"),
      );
    }));
  test(`registry connection initialization never overwrites an existing connection or accepts URL aliases on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.createOwnConnection(
              connection("conn-alice", "different_private_alias"),
            ),
          ),
        code("conflict"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.createOwnConnection(
              connection("conn-url", "https://private.example/token"),
            ),
          ),
        code("invalid"),
      );
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          h.tx("alice", (r) =>
            r.changeOwnConnection({
              connectionId: "conn-alice",
              expectedRevision: 1,
              serviceId: "author/service",
              dataAuthorityId: "author/database:original",
              hostBindingId: "private_alias_alice",
              state: "active",
              now: later,
            }),
          ),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    }));
  test(`registry current-target snapshots lock exact immutable version and mutable active premises on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const c = await connected(h);
      const target = await h.tx("alice", (r) =>
        r.lockCurrentTarget({
          appId: definition.id,
          version: definition.version,
          connectionId: c.connectionId,
          expectedGrantRevision: 1,
          expectedConnectionRevision: 1,
        }),
      );
      assert.equal(
        target.definitionHash,
        createHash("sha256")
          .update(canonicalJsonBytes(definition))
          .digest("hex"),
      );
      assert.equal(target.connectionRevision, 1);
      assert.equal(target.grantRevision, 1);
      assert.equal(target.instanceId, c.instanceId);
      assert.ok(!JSON.stringify(target).includes("private_"));
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockCurrentTarget({
              appId: definition.id,
              version: definition.version,
              connectionId: c.connectionId,
              expectedConnectionRevision: 99,
            }),
          ),
        code("conflict"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockCurrentTarget({
              appId: definition.id,
              version: "2.0.0",
              connectionId: c.connectionId,
            }),
          ),
        code("not_found"),
      );
      await assert.rejects(
        () =>
          h.tx("bob", (r) =>
            r.lockCurrentTarget({
              appId: definition.id,
              version: definition.version,
              connectionId: c.connectionId,
            }),
          ),
        code("forbidden"),
      );
      await h.tx("alice", (r) =>
        r.changeOwnGrant({
          appId: definition.id,
          version: definition.version,
          expectedRevision: 1,
          state: "disabled",
          now: later,
        }),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockCurrentTarget({
              appId: definition.id,
              version: definition.version,
              connectionId: c.connectionId,
            }),
          ),
        code("forbidden"),
      );
      // Retained exact connection reads do not grant new work after grant revocation.
      assert.equal(
        (
          await h.tx("alice", (r) =>
            r.readHostConnection({
              connectionId: c.connectionId,
              appId: c.appId,
              instanceId: c.instanceId,
              serviceId: c.serviceId,
              dataAuthorityId: c.dataAuthorityId,
            }),
          )
        ).hostBindingId,
        "private_alias_alice",
      );
    }));
  test(`registry inactive installation, instance and connection never admit new work on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const c = await connected(h);
      const request = {
        appId: c.appId,
        version: definition.version,
        connectionId: c.connectionId,
      };
      for (const [table, column, key] of [
        ["app_installations", "app_id", c.appId],
        ["app_instances", "instance_id", c.instanceId],
        ["cognitive_app_connections", "connection_id", c.connectionId],
      ]) {
        await h.tx("alice", async (_, q) => {
          await q.change(
            `UPDATE ${table} SET state='disabled' WHERE tenant_id='tenant-a' AND ${column}=?`,
            [key!],
          );
        });
        await assert.rejects(
          () => h.tx("alice", (r) => r.lockCurrentTarget(request)),
          code("forbidden"),
        );
        await h.tx("alice", async (_, q) => {
          await q.change(
            `UPDATE ${table} SET state='active' WHERE tenant_id='tenant-a' AND ${column}=?`,
            [key!],
          );
        });
      }
    }));
  test(`registry rejects node routes and mutated authority references rather than relaying on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const c = await connected(h);
      await h.tx("alice", async (_, q) => {
        await q.change(
          "UPDATE app_instances SET route_kind='node',node_id='node-one' WHERE instance_id=?",
          [c.instanceId],
        );
      });
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.ensureAuthority({
              appId: c.appId,
              serviceId: c.serviceId,
              dataAuthorityId: c.dataAuthorityId,
              now,
            }),
          ),
        code("conflict"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockCurrentTarget({
              appId: c.appId,
              version: definition.version,
              connectionId: c.connectionId,
            }),
          ),
        code("conflict"),
      );
      await h.tx("alice", async (_, q) => {
        await q.change(
          "UPDATE app_instances SET route_kind='service',node_id=NULL,route_ref='physical-host-url' WHERE instance_id=?",
          [c.instanceId],
        );
      });
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockCurrentTarget({
              appId: c.appId,
              version: definition.version,
              connectionId: c.connectionId,
            }),
          ),
        code("conflict"),
      );
    }));
  test(`registry headless definitions cannot fabricate cognitive GUI from existing UI rows on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      await view(h);
      const request = {
        viewId: "view-a",
        projectId: "project-a",
        appId: definition.id,
        version: definition.version,
        connectionId: "conn-alice",
        expectedViewRevision: 7,
        expectedBindingRevision: 0,
        now,
      };
      await assert.rejects(
        () => h.tx("alice", (r) => r.bindOwnView(request)),
        code("invalid"),
      );
      await h.tx("alice", async (_, q) =>
        assert.deepEqual(
          {
            ...(
              await q.all(
                "SELECT state_json,revision,owner_principal_id FROM app_view_instances WHERE view_id='view-a'",
              )
            )[0],
          },
          {
            state_json: JSON.stringify({
              objectId: "old_object",
              versionRef: "old_version",
            }),
            revision: backend === "postgres" ? "7" : 7,
            owner_principal_id: "alice",
          },
        ),
      );
      await h.tx("alice", async (_, q) =>
        assert.equal(
          (await q.all("SELECT * FROM cognitive_app_view_bindings")).length,
          0,
        ),
      );
    }));
  test(`registry unsupported GUI binding rolls back preceding mutations and never shares old windows on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      await connected(h, "bob", "conn-bob");
      await view(h);
      const request = {
        viewId: "view-a",
        projectId: "project-a",
        appId: definition.id,
        version: definition.version,
        connectionId: "conn-alice",
        expectedViewRevision: 7,
        expectedBindingRevision: 0,
        now,
      };
      await assert.rejects(
        () =>
          h.tx("bob", (r) =>
            r.bindOwnView({ ...request, connectionId: "conn-bob" }),
          ),
        code("invalid"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", (r) => r.bindOwnView({ ...request, version: "2.0.0" })),
        code("not_found"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", async (r) => {
            await r.createOwnConnection({
              ...connection("never-committed-connection"),
              dataAuthorityId: "never-committed-authority",
            });
            return r.bindOwnView({
              ...request,
              connectionId: "never-committed-connection",
            });
          }),
        code("invalid"),
      );
      await h.tx("alice", async (_, q) => {
        assert.equal(
          (await q.all("SELECT * FROM cognitive_app_view_bindings")).length,
          0,
        );
        assert.equal(
          (
            await q.all(
              "SELECT * FROM cognitive_app_connections WHERE connection_id='never-committed-connection'",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await q.all(
              "SELECT * FROM cognitive_app_authorities WHERE data_authority_id='never-committed-authority'",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await q.all(
              "SELECT owner_principal_id FROM app_view_instances WHERE view_id='view-a'",
            )
          )[0]!.owner_principal_id,
          "alice",
        );
      });
    }));
  test(`registry scopes all identities to tenant and preserves rollback/reopened facts on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const c = await connected(h);
      await assert.rejects(
        () =>
          h.tx(
            "alice",
            (r) =>
              r.lockCurrentTarget({
                appId: definition.id,
                version: definition.version,
                connectionId: c.connectionId,
              }),
            "tenant-b",
          ),
        code("not_found"),
      );
      await assert.rejects(
        () =>
          h.tx("alice", async (r) => {
            await r.changeOwnGrant({
              appId: definition.id,
              version: definition.version,
              expectedRevision: 1,
              state: "disabled",
              now: later,
            });
            await r.createOwnConnection({
              ...connection("rollback-connection"),
              dataAuthorityId: "rollback-authority",
            });
          }),
        code("forbidden"),
      );
      const target = await h.tx("alice", (r) =>
        r.lockCurrentTarget({
          appId: definition.id,
          version: definition.version,
          connectionId: c.connectionId,
        }),
      );
      assert.equal(target.grantRevision, 1);
      await h.tx("alice", async (_, q) =>
        assert.equal(
          (await q.all("SELECT * FROM cognitive_app_authorities")).length,
          1,
        ),
      );
    }));
  test(`registry catalog limit and malformed revisions are bounded on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      for (const limit of [0, 101, 1.5, NaN])
        await assert.rejects(
          () => h.tx("alice", (r) => r.readOwnRegistry({ limit })),
          code("invalid"),
        );
      for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER])
        await assert.rejects(
          () =>
            h.tx("alice", (r) =>
              r.changeOwnGrant({
                appId: definition.id,
                version: definition.version,
                expectedRevision,
                state: "disabled",
                now,
              }),
            ),
          code("invalid"),
        );
    }));
  test(`registry held target snapshot serializes concurrent revocation until commit on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const c = await connected(h);
      for (const premise of ["grant", "connection"] as const) {
        let release!: () => void;
        let acquired!: () => void;
        let started!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          acquired = resolve;
        });
        const writerStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        const reader = h.tx("alice", async (r) => {
          const snap = await r.lockCurrentTarget({
            appId: c.appId,
            version: definition.version,
            connectionId: c.connectionId,
          });
          acquired();
          await hold;
          return snap;
        });
        await ready;
        let completed = false;
        const writer = h
          .tx("alice", async (r) => {
            started();
            return premise === "grant"
              ? r.changeOwnGrant({
                  appId: c.appId,
                  version: definition.version,
                  expectedRevision: 1,
                  state: "disabled",
                  now: later,
                })
              : r.changeOwnConnection({
                  connectionId: c.connectionId,
                  expectedRevision: 1,
                  serviceId: c.serviceId,
                  dataAuthorityId: c.dataAuthorityId,
                  hostBindingId: "private_alias_alice",
                  state: "disabled",
                  now: later,
                });
          })
          .then((value) => {
            completed = true;
            return value;
          });
        try {
          if (backend === "postgres") await writerStarted;
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          assert.equal(
            completed,
            false,
            "Mutable premises must not change while target locks are held.",
          );
        } finally {
          release();
        }
        const [snap] = await Promise.all([reader, writer]);
        assert.equal(snap.connectionRevision, 1);
        if (premise === "grant") {
          assert.equal(snap.grantRevision, 1);
          await h.tx("alice", (r) =>
            r.changeOwnGrant({
              appId: c.appId,
              version: definition.version,
              expectedRevision: 2,
              state: "active",
              now: later,
            }),
          );
        }
      }
    }));
  test(`registry detects definition/hash corruption and expected hash mismatch on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const c = await connected(h);
      const request = {
        appId: c.appId,
        version: definition.version,
        connectionId: c.connectionId,
      };
      await assert.rejects(
        () =>
          h.tx("alice", (r) =>
            r.lockCurrentTarget({
              ...request,
              expectedDefinitionHash: "f".repeat(64),
            }),
          ),
        code("conflict"),
      );
      await h.tx("alice", async (_, q) => {
        await q.change(
          "UPDATE cognitive_app_versions SET definition_json=? WHERE tenant_id='tenant-a' AND app_id=?",
          [
            new TextDecoder().decode(
              canonicalJsonBytes({ ...definition, title: "Corrupted" }),
            ),
            c.appId,
          ],
        );
      });
      await assert.rejects(
        () => h.tx("alice", (r) => r.lockCurrentTarget(request)),
        code("conflict"),
      );
    }));
  test(`registry retains preexisting authority instance IDs and does not reactivate installations on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      const route = `cognitive_authority_${createHash("sha256")
        .update(
          JSON.stringify([
            "tenant-a",
            definition.id,
            "service-stable",
            "database-stable",
          ]),
        )
        .digest("hex")}`;
      await h.tx("alice", async (_, q) => {
        await q.change(
          "INSERT INTO app_instances VALUES('tenant-a',?,'retained-original-instance','service',NULL,?,9,'active',?)",
          [definition.id, route, now],
        );
        await q.change(
          "INSERT INTO cognitive_app_authorities VALUES('tenant-a',?,'retained-original-instance','service-stable','database-stable')",
          [definition.id],
        );
      });
      const retained = await h.tx("alice", (r) =>
        r.ensureAuthority({
          appId: definition.id,
          serviceId: "service-stable",
          dataAuthorityId: "database-stable",
          now: later,
        }),
      );
      assert.equal(retained.instanceId, "retained-original-instance");
      await h.tx("alice", async (_, q) => {
        assert.equal(
          (
            await q.all(
              "SELECT revision FROM app_instances WHERE instance_id='retained-original-instance'",
            )
          )[0]!.revision?.toString(),
          "9",
        );
        await q.change(
          "UPDATE app_installations SET state='disabled' WHERE tenant_id='tenant-a' AND app_id=?",
          [definition.id],
        );
      });
      await assert.rejects(
        () => h.tx("alice", (r) => r.installVersion(definition, later)),
        code("forbidden"),
      );
      await h.tx("alice", async (_, q) =>
        assert.equal(
          (
            await q.all(
              "SELECT state FROM app_installations WHERE tenant_id='tenant-a' AND app_id=?",
              [definition.id],
            )
          )[0]!.state,
          "disabled",
        ),
      );
    }));
  test(`registry independent scoped continuations cover more than 100 versions and connections on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await installed(h);
      await h.tx("alice", async (r) => {
        for (let index = 1; index <= 103; index++) {
          const version = `1.0.${index}`;
          await r.installVersion({ ...definition, version }, now);
          await r.changeOwnGrant({
            appId: definition.id,
            version,
            expectedRevision: 0,
            state: "active",
            now,
          });
        }
        for (let index = 0; index < 104; index++)
          await r.createOwnConnection(
            connection(`conn-${String(index).padStart(3, "0")}`),
          );
      });
      const first = await h.tx("alice", (r) =>
        r.readOwnRegistry({ limit: 100 }),
      );
      assert.equal(first.versions.length, 100);
      assert.equal(first.connections.length, 100);
      assert.ok(first.nextVersionsAfter);
      assert.ok(first.nextConnectionsAfter);
      const second = await h.tx("alice", (r) =>
        r.readOwnRegistry({
          limit: 100,
          versionsAfter: first.nextVersionsAfter!,
          connectionsAfter: first.nextConnectionsAfter!,
        }),
      );
      assert.equal(second.versions.length, 4);
      assert.equal(second.connections.length, 4);
      assert.equal(second.nextVersionsAfter, null);
      assert.equal(second.nextConnectionsAfter, null);
      assert.equal(
        new Set([...first.versions, ...second.versions].map((v) => v.version))
          .size,
        104,
      );
      assert.equal(
        new Set(
          [...first.connections, ...second.connections].map(
            (c) => c.connectionId,
          ),
        ).size,
        104,
      );
      const independent = await h.tx("alice", (r) =>
        r.readOwnRegistry({
          limit: 100,
          versionsAfter: first.nextVersionsAfter!,
        }),
      );
      assert.equal(independent.versions.length, 4);
      assert.equal(independent.connections.length, 100);
      assert.ok(
        !JSON.stringify([first, second, independent]).includes("private_alias"),
      );
      for (const request of [
        { limit: 100, connectionsAfter: first.nextVersionsAfter! },
        {
          limit: 100,
          versionsAfter: first.nextVersionsAfter!,
          appId: definition.id,
        },
        { limit: 100, versionsAfter: "not-a-cursor" },
        { limit: 100, connectionsAfter: "a".repeat(1025) },
      ])
        await assert.rejects(
          () => h.tx("alice", (r) => r.readOwnRegistry(request)),
          code("invalid"),
        );
      await assert.rejects(
        () =>
          h.tx("bob", (r) =>
            r.readOwnRegistry({
              limit: 100,
              versionsAfter: first.nextVersionsAfter!,
            }),
          ),
        code("invalid"),
      );
      await assert.rejects(
        () =>
          h.tx(
            "alice",
            (r) =>
              r.readOwnRegistry({
                limit: 100,
                connectionsAfter: first.nextConnectionsAfter!,
              }),
            "tenant-b",
          ),
        code("invalid"),
      );
    }));
}
