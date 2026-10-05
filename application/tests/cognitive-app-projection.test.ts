import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  postgresQuery,
  sqliteQuery,
  withSqliteWriteGate,
  type SqlQuery,
} from "../packages/storage/src/sql.js";
import { platformSchemaSql } from "../packages/platform/src/schema.js";
import { createCognitiveAppRegistry } from "../packages/platform/src/cognitive-app-registry.js";
import {
  createCognitiveAppCommands,
  type CognitiveAppAdmission,
  type CognitiveAppCommandSnapshot,
} from "../packages/platform/src/cognitive-app-commands.js";
import { createCognitiveAppProjection } from "../packages/platform/src/cognitive-app-projection.js";
import type {
  DomainActor,
  DomainObjectSummary,
} from "../packages/cognitive-app-sdk/src/domain-wire.js";

const now = "2026-10-05T00:00:00.000Z";
const later = "2026-10-05T00:01:00.000Z";
const tenantId = "tenant";
const principalId = "alice";
const human: DomainActor = {
  tenantId,
  principalId,
  actantId: "human_alice",
  kind: "human",
  source: { kind: "human" },
};
const definition = {
  format: "morphz-cognitive-app/v1",
  id: "example.notes",
  version: "1.0.0",
  title: "TEST Notes",
  description: "Own originals",
  icon: "document",
  protocol: "morphz-domain/v1",
  harness: null,
  ui: null,
  operations: [
    {
      id: "notes.write",
      title: "Write",
      description: "Write an original",
      effect: "write",
      scope: "project",
      inputSchema: { type: "null" },
      outputSchema: { type: "null" },
    },
  ],
};
const original: DomainObjectSummary = {
  objectId: "  原始/对象\n😀  ",
  versionRef: "opaque:not-a-number",
  kind: "document",
  title: "原件\n😀",
};
class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (
  code: "invalid" | "forbidden" | "not_found" | "conflict",
  message: string,
): never => {
  throw new Failure(code, message);
};
const rejected = (code: string) => (error: unknown) =>
  error instanceof Failure && error.code === code;
type Commands = ReturnType<typeof createCognitiveAppCommands>;
type Registry = ReturnType<typeof createCognitiveAppRegistry>;
type Projection = ReturnType<typeof createCognitiveAppProjection>;
type Harness = {
  run<T>(
    work: (p: Projection, c: Commands, r: Registry, q: SqlQuery) => Promise<T>,
  ): Promise<T>;
  sql(
    sql: string,
    values?: Array<string | number | null>,
  ): Promise<Record<string, unknown>[]>;
  reopen(): Promise<void>;
};

// These use real isolated SQL transactions, not application/Runtime identity
// acceptance. The future Store wrapper supplies authentication and live ACL.
async function isolated(
  backend: "sqlite" | "postgres",
  work: (h: Harness, admission: CognitiveAppAdmission) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-projection-"));
  const filename = join(directory, "platform.sqlite");
  const schema = `morphz_test_projection_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool | undefined;
  const openPool = () =>
    new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL });
  if (backend === "postgres") {
    assert.ok(process.env.MORPHZ_TEST_POSTGRES_URL);
    pool = openPool();
    await pool.query(`CREATE SCHEMA "${schema}"`);
  }
  async function connection<T>(
    transaction: boolean,
    action: (q: SqlQuery) => Promise<T>,
  ) {
    if (backend === "sqlite") {
      const execute = async () => {
        const db = new DatabaseSync(filename);
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        try {
          if (transaction) db.exec("BEGIN IMMEDIATE");
          try {
            const result = await action(sqliteQuery(db));
            if (transaction) db.exec("COMMIT");
            return result;
          } catch (error) {
            if (transaction) db.exec("ROLLBACK");
            throw error;
          }
        } finally {
          db.close();
        }
      };
      return transaction ? withSqliteWriteGate(filename, execute) : execute();
    }
    const client = await pool!.connect();
    try {
      await client.query(`SET search_path TO "${schema}",pg_catalog`);
      if (transaction) await client.query("BEGIN");
      try {
        const result = await action(postgresQuery(client));
        if (transaction) await client.query("COMMIT");
        return result;
      } catch (error) {
        if (transaction) await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }
  const h: Harness = {
    run: (action) =>
      connection(true, (q) =>
        action(
          createCognitiveAppProjection({ q, backend, tenantId, fail }),
          createCognitiveAppCommands({ q, backend, tenantId, fail }),
          createCognitiveAppRegistry({
            q,
            backend,
            tenantId,
            principalId,
            fail,
          }),
          q,
        ),
      ),
    sql: (sql, values = []) => connection(false, (q) => q.all(sql, values)),
    reopen: async () => {
      if (pool) {
        await pool.end();
        pool = openPool();
      }
      // SQLite opens a fresh physical connection for every transaction already.
    },
  };
  try {
    await connection(true, async (q) => {
      await q.exec(platformSchemaSql);
      await q.change("INSERT INTO tenants VALUES(?,?)", [tenantId, now]);
      for (const project of ["project_one", "project_two"])
        await q.change(
          "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,?,'project',?,'TEST',1,?,?)",
          [tenantId, project, principalId, now, now],
        );
    });
    const target = await h.run(async (_p, _c, r) => {
      await r.installVersion(definition, now);
      await r.changeOwnGrant({
        appId: definition.id,
        version: definition.version,
        expectedRevision: 0,
        state: "active",
        now,
      });
      await r.createOwnConnection({
        appId: definition.id,
        version: definition.version,
        serviceId: "service",
        dataAuthorityId: "original_data",
        connectionId: "connection",
        hostBindingId: "private_alias",
        expectedRevision: 0,
        now,
      });
      return r.lockCurrentTarget({
        appId: definition.id,
        version: definition.version,
        connectionId: "connection",
      });
    });
    await work(h, {
      commandId: "command",
      requestHash: "a".repeat(64),
      authority: {
        appId: target.appId,
        version: target.version,
        definitionHash: target.definitionHash,
        instanceId: target.instanceId,
        serviceId: target.serviceId,
        dataAuthorityId: target.dataAuthorityId,
      },
      actor: human,
      projectId: "project_one",
      operationId: "notes.write",
      effect: "write",
      operationScope: "project",
      resources: [],
      connectionId: target.connectionId,
      connectionRevision: target.connectionRevision,
      grantRevision: target.grantRevision,
    });
  } finally {
    if (pool) {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
async function committed(
  h: Harness,
  admission: CognitiveAppAdmission,
  objects: readonly DomainObjectSummary[] = [original],
) {
  const admitted = await h.run((_p, c) => c.admit(admission, now));
  const dispatched = await h.run((_p, c) =>
    c.dispatch(admission.commandId, admitted.revision, now),
  );
  assert.ok(dispatched);
  const command = await h.run((_p, c) =>
    c.recordReceipt(
      admission.commandId,
      {
        protocol: "morphz-domain/v1",
        status: "committed",
        binding: {
          authority: admission.authority,
          actor: admission.actor,
          projectId: admission.projectId,
          operationId: admission.operationId,
          commandId: admission.commandId,
          requestHash: admission.requestHash,
        },
        receiptId: "opaque:author/receipt",
        committedAt: now,
        result: { private_business_body: "NEVER COPY" },
        objects,
      },
      now,
    ),
  );
  assert.ok(command);
  return command;
}
async function seed(
  h: Harness,
  admission: CognitiveAppAdmission,
  object = original,
  changes: {
    projectId?: string;
    versionRef?: string | null;
    kind?: string;
    deletedAt?: string | null;
  } = {},
) {
  await h.run((_p, _c, _r, q) =>
    q.change(
      "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,'available',7,?,?,?)",
      [
        tenantId,
        "legacy_content",
        admission.authority.appId,
        admission.authority.instanceId,
        object.objectId,
        changes.projectId ?? admission.projectId,
        changes.kind ?? object.kind,
        "Manual title",
        changes.versionRef === undefined
          ? object.versionRef
          : changes.versionRef,
        now,
        now,
        now,
        changes.deletedAt ?? null,
      ],
    ),
  );
}
const project = (p: Projection, command: CognitiveAppCommandSnapshot) =>
  p.projectCommitted({
    commandId: command.commandId,
    expectedRevision: command.revision,
    now: later,
  });

test("projection is a q-scoped persisted-fact projector, not a generic disabled write or body adapter", () => {
  const source = readFileSync(
    new URL(
      "../packages/platform/src/cognitive-app-projection.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:fetch|setTimeout|setInterval|DatabaseSync|Pool|UiPackageService|WorkspaceClient|allowDisabled)\b/,
  );
  assert.doesNotMatch(source, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`projection ${backend} authentic committed summaries survive cold reopen with exact opaque IDs and delivery provenance`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission, [
        original,
        { ...original, objectId: "second", title: "Second" },
      ]);
      await h.reopen();
      const result = await h.run((p) => project(p, command));
      assert.ok(result);
      assert.equal(result.changed, true);
      assert.equal(result.command.projectionState, "projected");
      assert.equal(result.contentIds.length, 2);
      const rows = await h.sql(
        "SELECT * FROM content_entries ORDER BY app_object_id",
      );
      assert.equal(rows.length, 2);
      assert.ok(
        rows.some(
          (row) =>
            row.app_object_id === original.objectId &&
            row.observed_version_ref === original.versionRef,
        ),
      );
      const receipts = await h.sql("SELECT * FROM command_receipts");
      const events = await h.sql("SELECT * FROM outbox");
      assert.equal(receipts.length, 2);
      assert.equal(events.length, 2);
      for (const event of events) {
        const payload = JSON.parse(String(event.payload));
        assert.equal(payload.cognitiveCommandId, command.commandId);
        assert.equal(payload.appReceiptId, command.receiptRef);
        assert.deepEqual(payload.authority, command.authority);
        assert.deepEqual(payload.actor, human);
        assert.equal(payload.receiptHash, command.receiptHash);
        assert.equal(payload.requestHash, command.requestHash);
      }
      assert.doesNotMatch(
        JSON.stringify([
          rows,
          receipts,
          events,
          await h.sql("SELECT * FROM cognitive_app_commands"),
        ]),
        /NEVER COPY|private_business_body/,
      );
      await h.reopen();
      assert.equal(await h.run((p) => project(p, command)), null);
      assert.equal((await h.sql("SELECT * FROM outbox")).length, 2);
    });
  });

  test(`projection ${backend} requires actual committed pending revision and rejects caller metadata`, async () => {
    await isolated(backend, async (h, admission) => {
      await h.run((_p, c) => c.admit(admission, now));
      assert.equal(
        await h.run((p) =>
          p.projectCommitted({
            commandId: admission.commandId,
            expectedRevision: 1,
          }),
        ),
        null,
      );
      const command = await committed(h, admission);
      assert.equal(
        await h.run((p) =>
          p.projectCommitted({
            commandId: command.commandId,
            expectedRevision: command.revision + 1,
          }),
        ),
        null,
      );
      await assert.rejects(
        h.run((p) =>
          p.projectCommitted({
            commandId: command.commandId,
            expectedRevision: command.revision,
            receiptId: "fake",
          } as Parameters<Projection["projectCommitted"]>[0]),
        ),
        rejected("invalid"),
      );
      await assert.rejects(
        h.run((p) =>
          p.projectCommitted({ commandId: "missing", expectedRevision: 1 }),
        ),
        rejected("not_found"),
      );
      assert.equal((await h.sql("SELECT * FROM content_entries")).length, 0);
    });
  });

  test(`projection ${backend} updates only an exact original baseline and preserves an already-current manual title`, async () => {
    await isolated(backend, async (h, admission) => {
      await seed(h, admission, original, { versionRef: "opaque:baseline" });
      const command = await committed(h, {
        ...admission,
        resources: [
          { objectId: original.objectId, versionRef: "opaque:baseline" },
        ],
      });
      assert.equal((await h.run((p) => project(p, command)))?.changed, true);
      let row = (await h.sql("SELECT * FROM content_entries"))[0]!;
      assert.equal(row.content_id, "legacy_content");
      assert.equal(Number(row.revision), 8);
      assert.equal(row.title, original.title);
      const next = await committed(h, {
        ...admission,
        commandId: "same_version",
        requestHash: "b".repeat(64),
      });
      await h.run((_p, _c, _r, q) =>
        q.change("UPDATE content_entries SET title='Manual again'", []),
      );
      const result = await h.run((p) => project(p, next));
      assert.equal(result?.changed, false);
      row = (await h.sql("SELECT * FROM content_entries"))[0]!;
      assert.equal(row.title, "Manual again");
      assert.equal(Number(row.revision), 8);
      assert.equal((await h.sql("SELECT * FROM command_receipts")).length, 2);
    });
  });

  for (const premise of [
    "foreign-project",
    "kind-mismatch",
    "deleted",
    "drift",
    "missing-baseline",
  ] as const)
    test(`projection ${backend} ${premise} conflicts roll back earlier objects and keep committed pending`, async () => {
      await isolated(backend, async (h, admission) => {
        const conflictObject = { ...original, objectId: "z_conflict" };
        await seed(h, admission, conflictObject, {
          ...(premise === "foreign-project"
            ? { projectId: "project_two" }
            : {}),
          ...(premise === "kind-mismatch" ? { kind: "another_kind" } : {}),
          ...(premise === "deleted" ? { deletedAt: now } : {}),
          ...(premise === "drift" || premise === "missing-baseline"
            ? { versionRef: "opaque:unrelated" }
            : {}),
        });
        const command = await committed(
          h,
          {
            ...admission,
            resources:
              premise === "drift"
                ? [
                    {
                      objectId: conflictObject.objectId,
                      versionRef: "opaque:baseline",
                    },
                  ]
                : [],
          },
          [{ ...original, objectId: "a_new" }, conflictObject],
        );
        await assert.rejects(
          h.run((p) => project(p, command)),
          rejected("conflict"),
        );
        assert.equal((await h.sql("SELECT * FROM content_entries")).length, 1);
        assert.equal((await h.sql("SELECT * FROM command_receipts")).length, 0);
        assert.equal((await h.sql("SELECT * FROM outbox")).length, 0);
        assert.equal(
          (await h.run((_p, c) => c.read(command.commandId)))?.projectionState,
          "pending",
        );
      });
    });

  test(`projection ${backend} revoked and disabled premises retain original committed facts even in a retired project`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission);
      await h.run(async (_p, _c, _r, q) => {
        await q.change("UPDATE app_installations SET state='disabled'", []);
        await q.change(
          "UPDATE cognitive_app_grants SET state='disabled',revision=revision+1",
          [],
        );
        await q.change(
          "UPDATE cognitive_app_connections SET state='disabled',revision=revision+1",
          [],
        );
        await q.change(
          "UPDATE app_instances SET state='disabled',revision=revision+1",
          [],
        );
        await q.change(
          "UPDATE projects SET archived_at=?,deleted_at=? WHERE project_id=?",
          [now, now, admission.projectId],
        );
        await q.change("DELETE FROM project_members", []);
      });
      assert.ok(await h.run((p) => project(p, command)));
      assert.equal(
        (await h.sql("SELECT * FROM content_entries"))[0]!.project_id,
        admission.projectId,
      );
      await assert.rejects(
        h.run((_p, c) =>
          c.admit({ ...admission, commandId: "new_after_disable" }, now),
        ),
        rejected("forbidden"),
      );
    });
  });

  test(`projection ${backend} exact retained authority route cannot be retargeted`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission);
      await h.run((_p, _c, _r, q) =>
        q.change("UPDATE app_instances SET route_ref='replacement'", []),
      );
      await assert.rejects(
        h.run((p) => project(p, command)),
        rejected("conflict"),
      );
      assert.equal((await h.sql("SELECT * FROM content_entries")).length, 0);
      assert.equal(
        (await h.run((_p, c) => c.read(command.commandId)))?.projectionState,
        "pending",
      );
    });
  });

  test(`projection ${backend} empty summaries mark once and concurrent retry produces only one projection`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission, []);
      const results = await Promise.all([
        h.run((p) => project(p, command)),
        h.run((p) => project(p, command)),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.deepEqual(results.find(Boolean)?.contentIds, []);
      assert.equal(results.find(Boolean)?.changed, false);
      assert.equal((await h.sql("SELECT * FROM content_entries")).length, 0);
      assert.equal((await h.sql("SELECT * FROM outbox")).length, 0);
      assert.equal(
        (await h.run((_p, c) => c.read(command.commandId)))?.revision,
        command.revision + 1,
      );
    });
  });

  test(`projection ${backend} concurrent different opaque revisions never overwrite a drifted baseline`, async () => {
    await isolated(backend, async (h, admission) => {
      await seed(h, admission, original, { versionRef: "base" });
      const a = await committed(
        h,
        {
          ...admission,
          resources: [{ objectId: original.objectId, versionRef: "base" }],
        },
        [{ ...original, versionRef: "opaque:a" }],
      );
      const b = await committed(
        h,
        {
          ...admission,
          commandId: "second",
          requestHash: "b".repeat(64),
          resources: [{ objectId: original.objectId, versionRef: "base" }],
        },
        [{ ...original, versionRef: "opaque:b" }],
      );
      const results = await Promise.allSettled([
        h.run((p) => project(p, a)),
        h.run((p) => project(p, b)),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.filter(
          (r) => r.status === "rejected" && rejected("conflict")(r.reason),
        ).length,
        1,
      );
      assert.equal(
        Number(
          (await h.sql("SELECT revision FROM content_entries"))[0]!.revision,
        ),
        8,
      );
      assert.equal((await h.sql("SELECT * FROM command_receipts")).length, 1);
    });
  });

  test(`projection ${backend} malformed persisted portable identifiers fail before catalog writes`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission);
      for (const bad of ["a\u0000b", "a\ud800b", "a\udc00b"])
        for (const field of [
          "objectId",
          "versionRef",
          "kind",
          "title",
        ] as const) {
          await h.run((_p, _c, _r, q) =>
            q.change(
              "UPDATE cognitive_app_commands SET receipt_summary_json=? WHERE command_id=?",
              [
                JSON.stringify([{ ...original, [field]: bad }]),
                command.commandId,
              ],
            ),
          );
          await assert.rejects(
            h.run((p) => project(p, command)),
            rejected("conflict"),
          );
          assert.equal(
            (await h.sql("SELECT * FROM content_entries")).length,
            0,
          );
        }
    });
  });

  test(`projection ${backend} a deterministic delivery identity collision cannot replace legacy provenance`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission);
      const eventId = `cognitive_delivery_${createHash("sha256")
        .update(
          JSON.stringify([
            tenantId,
            command.commandId,
            command.receiptHash,
            original.objectId,
          ]),
        )
        .digest("hex")
        .slice(0, 40)}`;
      await h.run((_p, _c, _r, q) =>
        q.change(
          "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'content','legacy',1,'content.recorded','{}',?)",
          [tenantId, eventId, now],
        ),
      );
      await assert.rejects(
        h.run((p) => project(p, command)),
        rejected("conflict"),
      );
      assert.equal((await h.sql("SELECT * FROM content_entries")).length, 0);
      assert.equal((await h.sql("SELECT * FROM command_receipts")).length, 0);
      assert.deepEqual(
        { ...(await h.sql("SELECT aggregate_id,payload FROM outbox"))[0] },
        { aggregate_id: "legacy", payload: "{}" },
      );
      assert.equal(
        (await h.run((_p, c) => c.read(command.commandId)))?.projectionState,
        "pending",
      );
    });
  });

  test(`projection ${backend} a failure at final mark rolls back real catalog and delivery SQL together`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission, [
        original,
        { ...original, objectId: "second" },
      ]);
      let sawActualWrites = false;
      await assert.rejects(
        h.run(async (_p, _c, _r, q) => {
          // Only fault injection is the final mark. All catalog/receipt/outbox
          // operations execute against this actual transaction before rollback.
          const fault: SqlQuery = {
            all: q.all,
            exec: q.exec,
            change: async (sql, values) => {
              if (
                sql.startsWith(
                  "UPDATE cognitive_app_commands SET projection_state='projected'",
                )
              ) {
                assert.equal(
                  (await q.all("SELECT * FROM content_entries")).length,
                  2,
                );
                assert.equal(
                  (await q.all("SELECT * FROM command_receipts")).length,
                  2,
                );
                assert.equal((await q.all("SELECT * FROM outbox")).length, 2);
                sawActualWrites = true;
                throw new Failure("conflict", "TEST final mark failure");
              }
              return q.change(sql, values);
            },
          };
          return project(
            createCognitiveAppProjection({ q: fault, backend, tenantId, fail }),
            command,
          );
        }),
        rejected("conflict"),
      );
      assert.equal(sawActualWrites, true);
      await h.reopen();
      for (const table of ["content_entries", "command_receipts", "outbox"])
        assert.equal((await h.sql(`SELECT * FROM ${table}`)).length, 0);
      const retained = await h.run((_p, c) => c.read(command.commandId));
      assert.equal(retained?.state, "committed");
      assert.equal(retained?.projectionState, "pending");
      assert.equal(retained?.revision, command.revision);
      assert.ok(await h.run((p) => project(p, command)));
    });
  });

  test(`projection ${backend} persisted summary bounds are not bypassed by a raw SQL JSON carrier`, async () => {
    await isolated(backend, async (h, admission) => {
      const command = await committed(h, admission);
      const invalid = [
        [original, original],
        Array.from({ length: 33 }, (_v, i) => ({
          ...original,
          objectId: `object_${i}`,
        })),
        [{ ...original, title: "x".repeat(181) }],
        Array.from({ length: 32 }, (_v, i) => ({
          objectId: `${i}${"中".repeat(198)}`,
          versionRef: "中".repeat(200),
          kind: "中".repeat(100),
          title: "中".repeat(180),
        })),
      ];
      for (const objects of invalid) {
        await h.run((_p, _c, _r, q) =>
          q.change(
            "UPDATE cognitive_app_commands SET receipt_summary_json=? WHERE command_id=?",
            [JSON.stringify(objects), command.commandId],
          ),
        );
        await assert.rejects(
          h.run((p) => project(p, command)),
          rejected("conflict"),
        );
      }
      assert.equal((await h.sql("SELECT * FROM content_entries")).length, 0);
      assert.equal((await h.sql("SELECT * FROM command_receipts")).length, 0);
    });
  });

  test(`projection ${backend} receipt-derived input source is retained separately from object metadata`, async () => {
    await isolated(backend, async (h, admission) => {
      const actor: DomainActor = {
        tenantId,
        principalId,
        actantId: "agent",
        kind: "agent",
        source: {
          kind: "input",
          inputId: "actual_input",
          humanActantId: "human_alice",
        },
      };
      const command = await committed(h, { ...admission, actor });
      await h.run((p) => project(p, command));
      const row = (await h.sql("SELECT * FROM command_receipts"))[0]!;
      assert.equal(row.runtime_input_id, "actual_input");
      assert.equal(row.actor_principal_id, principalId);
      assert.deepEqual(
        JSON.parse(
          String((await h.sql("SELECT payload FROM outbox"))[0]!.payload),
        ).actor,
        actor,
      );
    });
  });

  test(`projection ${backend} original scheduled source remains task-run even with a source input`, async () => {
    await isolated(backend, async (h, admission) => {
      const actor: DomainActor = {
        tenantId,
        principalId,
        actantId: "agent",
        kind: "agent",
        source: {
          kind: "task-run",
          sessionId: "session",
          scheduleId: "schedule",
          eventId: "event",
          sourceInputId: "input_one",
          humanActantId: "human_alice",
        },
      };
      const command = await committed(h, { ...admission, actor });
      await h.run((p) => project(p, command));
      const receipt = (await h.sql("SELECT * FROM command_receipts"))[0]!;
      assert.equal(receipt.runtime_input_id, "input_one");
      assert.equal(receipt.actor_actant_id, "agent");
      assert.deepEqual(
        JSON.parse(
          String((await h.sql("SELECT payload FROM outbox"))[0]!.payload),
        ).actor,
        actor,
      );
    });
  });
}
