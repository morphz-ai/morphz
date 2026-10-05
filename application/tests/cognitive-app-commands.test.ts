import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  sqliteQuery,
  postgresQuery,
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
import {
  canonicalJsonBytes,
  parseDomainReceipt,
  type DomainActor,
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
const input: DomainActor = {
  tenantId,
  principalId,
  actantId: "agent",
  kind: "agent",
  source: { kind: "input", inputId: "input_one", humanActantId: "human_alice" },
};
const scheduled: DomainActor = {
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
const definition = {
  format: "morphz-cognitive-app/v1",
  id: "example.notes",
  version: "1.0.0",
  title: "Notes",
  description: "Own originals",
  icon: "document",
  protocol: "morphz-domain/v1",
  harness: null,
  ui: null,
  operations: [
    {
      id: "notes.create",
      title: "Create",
      description: "Write one original",
      effect: "write",
      scope: "project",
      inputSchema: { type: "null" },
      outputSchema: { type: "integer" },
    },
    {
      id: "notes.execute",
      title: "Execute",
      description: "Execute on exact originals",
      effect: "execute",
      scope: "objects",
      inputSchema: { type: "null" },
      outputSchema: { type: "null" },
    },
    {
      id: "notes.read",
      title: "Read",
      description: "Read",
      effect: "read",
      scope: "project",
      inputSchema: { type: "null" },
      outputSchema: { type: "null" },
    },
  ],
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
const rejected = (code?: string) => (error: unknown) =>
  error instanceof Failure && (!code || error.code === code);
type Commands = ReturnType<typeof createCognitiveAppCommands>;
type Registry = ReturnType<typeof createCognitiveAppRegistry>;
type Harness = {
  run<T>(
    work: (commands: Commands, registry: Registry, q: SqlQuery) => Promise<T>,
  ): Promise<T>;
  sql(
    sql: string,
    values?: Array<string | number | null>,
  ): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
};

// These are isolated low-level ledger transactions, not Runtime identity or
// project/member authorization acceptance. Root supplies that policy with q.
async function isolated(
  backend: "sqlite" | "postgres",
  work: (h: Harness, admission: CognitiveAppAdmission) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-commands-"));
  const filename = join(directory, "platform.sqlite");
  const schema = `morphz_test_commands_${randomUUID().replaceAll("-", "")}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL })
      : undefined;
  if (pool) {
    assert.ok(process.env.MORPHZ_TEST_POSTGRES_URL);
    await pool.query(`CREATE SCHEMA "${schema}"`);
  }
  async function connection<T>(
    transaction: boolean,
    action: (q: SqlQuery) => Promise<T>,
  ): Promise<T> {
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
    close: async () => {},
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
    const target = await h.run(async (_commands, registry) => {
      await registry.installVersion(definition, now);
      await registry.changeOwnGrant({
        appId: definition.id,
        version: definition.version,
        expectedRevision: 0,
        state: "active",
        now,
      });
      await registry.createOwnConnection({
        appId: definition.id,
        version: definition.version,
        serviceId: "service",
        dataAuthorityId: "original_data",
        connectionId: "connection",
        hostBindingId: "private_alias",
        expectedRevision: 0,
        now,
      });
      return registry.lockCurrentTarget({
        appId: definition.id,
        version: definition.version,
        connectionId: "connection",
      });
    });
    const admission: CognitiveAppAdmission = {
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
      operationId: "notes.create",
      effect: "write",
      operationScope: "project",
      resources: [],
      connectionId: target.connectionId,
      connectionRevision: target.connectionRevision,
      grantRevision: target.grantRevision,
    };
    await work(h, admission);
  } finally {
    await h.close();
    if (pool) {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
function receipt(command: CognitiveAppCommandSnapshot) {
  return {
    protocol: "morphz-domain/v1",
    status: "committed",
    binding: {
      authority: command.authority,
      actor: command.actor,
      projectId: command.projectId,
      operationId: command.operationId,
      commandId: command.commandId,
      requestHash: command.requestHash,
    },
    receiptId: "author_receipt",
    committedAt: now,
    // Intentionally violates the operation's outputSchema integer: the already
    // verified committed fact must survive separate business-shape validation.
    result: { private_business_result: "not persisted" },
    objects: [
      {
        objectId: "  original  ",
        versionRef: "opaque:v1",
        kind: "document",
        title: "Original",
      },
    ],
  };
}

test("commands are a q-scoped internal ledger, not a network or author storage adapter", () => {
  const source = readFileSync(
    new URL(
      "../packages/platform/src/cognitive-app-commands.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:fetch|setTimeout|setInterval|DatabaseSync|Pool|UiPackageService|WorkspaceClient)\b/,
  );
  assert.doesNotMatch(source, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`commands ${backend} portable metadata rejects lossy SQL text while preserving legal Unicode and business JSON`, async () => {
    await isolated(backend, async (h, request) => {
      const invalid = [
        "before\u0000after",
        "before\ud800after",
        "before\udc00after",
      ];
      for (const operationId of invalid)
        await assert.rejects(
          h.run((c) => c.admit({ ...request, operationId }, now)),
          rejected("invalid"),
        );
      for (const text of invalid)
        for (const resources of [
          [{ objectId: text, versionRef: "v1" }],
          [{ objectId: "original", versionRef: text }],
        ])
          await assert.rejects(
            h.run((c) => c.admit({ ...request, resources }, now)),
            rejected("invalid"),
          );
      assert.equal(await h.run((c) => c.read(request.commandId)), null);
      const text = "  原始\n\t😀  ";
      const resources = [{ objectId: text, versionRef: text }];
      const objects = [{ ...resources[0]!, kind: text, title: text }];
      const admitted = await h.run((c) =>
        c.admit({ ...request, resources }, now),
      );
      assert.deepEqual(admitted.resources, resources);
      const sending = (await h.run((c) =>
        c.dispatch(request.commandId, 1, now),
      ))!;
      const wire = {
        ...receipt(sending),
        receiptId: text,
        objects,
        result: { originalBusinessStrings: invalid },
      };
      for (const bad of invalid) {
        await assert.rejects(
          h.run((c) =>
            c.recordReceipt(
              request.commandId,
              { ...wire, receiptId: bad },
              later,
            ),
          ),
          rejected("invalid"),
        );
        for (const key of ["objectId", "versionRef", "kind", "title"] as const)
          await assert.rejects(
            h.run((c) =>
              c.recordReceipt(
                request.commandId,
                { ...wire, objects: [{ ...objects[0]!, [key]: bad }] },
                later,
              ),
            ),
            rejected("invalid"),
          );
      }
      assert.deepEqual(await h.run((c) => c.read(request.commandId)), sending);
      const parsed = parseDomainReceipt(wire);
      assert.ok(parsed.status === "committed");
      assert.deepEqual(parsed.result, wire.result);
      const saved = await h.run((c) =>
        c.recordReceipt(request.commandId, wire, later),
      );
      assert.equal(saved.receiptRef, text);
      assert.deepEqual(saved.objects, objects);
      assert.deepEqual(await h.run((c) => c.read(request.commandId)), saved);
      // The original FIRST-RED separately records the actual NUL truncation /
      // PG rejection and lone-surrogate replacement. This positive carrier is
      // real isolated SQL, not a user's database or a catalog projection.
      await h.sql(
        "UPDATE projects SET title=? WHERE tenant_id=? AND project_id=?",
        [text, tenantId, request.projectId],
      );
      assert.equal(
        (
          await h.sql(
            "SELECT title FROM projects WHERE tenant_id=? AND project_id=?",
            [tenantId, request.projectId],
          )
        )[0]!.title,
        text,
      );
      for (const bad of invalid)
        for (const key of [
          "objectId",
          "versionRef",
          "kind",
          "title",
        ] as const) {
          await h.sql(
            "UPDATE cognitive_app_commands SET receipt_summary_json=? WHERE tenant_id=? AND command_id=?",
            [
              JSON.stringify([{ ...objects[0]!, [key]: bad }]),
              tenantId,
              request.commandId,
            ],
          );
          await assert.rejects(
            h.run((c) => c.read(request.commandId)),
            rejected("conflict"),
          );
        }
      await h.sql(
        "UPDATE cognitive_app_commands SET receipt_summary_json=? WHERE tenant_id=? AND command_id=?",
        [JSON.stringify(objects), tenantId, request.commandId],
      );
      assert.deepEqual(await h.run((c) => c.read(request.commandId)), saved);
    });
  });
  test(`commands ${backend} exact admission replay survives revocation and reopening without storing business bytes`, async () => {
    await isolated(backend, async (h, request) => {
      const original = await h.run((c) => c.admit(request, now));
      assert.equal(original.state, "admitted");
      assert.equal(original.revision, 1);
      await h.sql(
        "UPDATE cognitive_app_grants SET state='disabled',revision=2",
      );
      await h.sql(
        "UPDATE cognitive_app_connections SET state='disabled',revision=2",
      );
      assert.deepEqual(await h.run((c) => c.admit(request, later)), original);
      assert.deepEqual(await h.run((c) => c.read(request.commandId)), original);
      const row = (await h.sql("SELECT * FROM cognitive_app_commands"))[0]!;
      assert.equal(row.connection_revision, backend === "postgres" ? "1" : 1);
      for (const field of [
        "parameters",
        "result",
        "body",
        "host_binding_id",
        "endpoint",
        "credential",
      ])
        assert.equal(Object.hasOwn(row, field), false);
      assert.equal(JSON.stringify(original).includes("private_alias"), false);
      await assert.rejects(
        h.run((c) =>
          c.admit({ ...request, commandId: "new_after_revocation" }, now),
        ),
        rejected("forbidden"),
      );
    });
  });
  test(`commands ${backend} same ID compares every immutable field and keeps task-run source input classification`, async () => {
    await isolated(backend, async (h, request) => {
      const actual = { ...request, actor: scheduled };
      const original = await h.run((c) => c.admit(actual, now));
      assert.deepEqual(original.actor, scheduled);
      const variants = [
        { requestHash: "b".repeat(64) },
        { projectId: "project_two" },
        { operationId: "notes.execute" },
        { effect: "execute" as const },
        {
          operationScope: "objects" as const,
          resources: [{ objectId: "original", versionRef: "v1" }],
        },
        { resources: [{ objectId: "original", versionRef: "v1" }] },
        { connectionId: "another" },
        { connectionRevision: 2 },
        { grantRevision: 2 },
        ...[
          "appId",
          "version",
          "definitionHash",
          "instanceId",
          "serviceId",
          "dataAuthorityId",
        ].map((key) => ({
          authority: {
            ...request.authority,
            [key]:
              key === "appId"
                ? "example.other"
                : key === "version"
                  ? "1.0.1"
                  : key === "definitionHash"
                    ? "b".repeat(64)
                    : "another",
          },
        })),
        { actor: human },
        { actor: input },
        ...["tenantId", "principalId", "actantId"].map((key) => ({
          actor: { ...scheduled, [key]: "another" },
        })),
        ...[
          "sessionId",
          "scheduleId",
          "eventId",
          "sourceInputId",
          "humanActantId",
        ].map((key) => ({
          actor: {
            ...scheduled,
            source: { ...scheduled.source, [key]: "another" },
          },
        })),
      ];
      for (const variant of variants)
        await assert.rejects(
          h.run((c) =>
            c.admit({ ...actual, ...variant } as CognitiveAppAdmission, later),
          ),
          rejected("conflict"),
        );
      assert.deepEqual(await h.run((c) => c.read(actual.commandId)), original);
      await assert.rejects(
        h.run((c) =>
          c.admit(
            {
              ...request,
              commandId: "scope_empty",
              operationId: "notes.execute",
              effect: "execute",
              operationScope: "objects",
            },
            now,
          ),
        ),
        rejected(),
      );
      await assert.rejects(
        h.run((c) =>
          c.admit(
            { ...request, commandId: "wrong_effect", effect: "execute" },
            now,
          ),
        ),
        rejected("conflict"),
      );
      await assert.rejects(
        h.run((c) =>
          c.admit(
            {
              ...request,
              commandId: "extra",
              parameters: { private: true },
            } as CognitiveAppAdmission,
            now,
          ),
        ),
        rejected("invalid"),
      );
    });
  });
  test(`commands ${backend} admission and first dispatch CAS have one winner across independent transactions`, async () => {
    await isolated(backend, async (h, request) => {
      const admissions = await Promise.all([
        h.run((c) => c.admit(request, now)),
        h.run((c) => c.admit(request, later)),
      ]);
      assert.deepEqual(admissions[0], admissions[1]);
      const dispatched = await Promise.all([
        h.run((c) => c.dispatch(request.commandId, 1, later)),
        h.run((c) => c.dispatch(request.commandId, 1, later)),
      ]);
      assert.equal(dispatched.filter(Boolean).length, 1);
      const actual = await h.run((c) => c.read(request.commandId));
      assert.equal(actual!.state, "dispatching");
      assert.equal(actual!.revision, 2);
      assert.equal(
        await h.run((c) => c.dispatch(request.commandId, 2, later)),
        null,
      );
      assert.equal(
        await h.run((c) => c.cancelAdmitted(request.commandId, 2, later)),
        null,
      );
      const uncertain = await h.run((c) =>
        c.markUnknown(request.commandId, 2, later),
      );
      assert.equal(uncertain!.state, "unknown");
      assert.equal(
        await h.run((c) =>
          c.dispatch(request.commandId, uncertain!.revision, later),
        ),
        null,
      );
      assert.equal(
        await h.run((c) =>
          c.cancelAdmitted(request.commandId, uncertain!.revision, later),
        ),
        null,
      );
      assert.deepEqual(uncertain!.actor, request.actor);
      assert.equal(await h.run((c) => c.hasOpenCommands("project_one")), true);
    });
  });
  test(`commands ${backend} nullable task-run source input stays task-run through reopening and recovery`, async () => {
    await isolated(backend, async (h, request) => {
      const actor: DomainActor = {
        ...scheduled,
        source: {
          kind: "task-run",
          sessionId: "session",
          scheduleId: "schedule",
          eventId: "event",
          sourceInputId: null,
          humanActantId: "human_alice",
        },
      };
      const item = { ...request, actor };
      const original = await h.run((c) => c.admit(item, now));
      assert.deepEqual(await h.run((c) => c.read(item.commandId)), original);
      assert.deepEqual(await h.run((c) => c.admit(item, later)), original);
      const row = (
        await h.sql(
          "SELECT source_kind,runtime_input_id,runtime_session_id,runtime_schedule_id,runtime_task_run_event_id FROM cognitive_app_commands",
        )
      )[0]!;
      assert.equal(row.source_kind, "task-run");
      assert.equal(row.runtime_input_id, null);
      assert.equal(row.runtime_session_id, "session");
      assert.equal(row.runtime_schedule_id, "schedule");
      assert.equal(row.runtime_task_run_event_id, "event");
      await h.run((c) => c.dispatch(item.commandId, 1, later));
      await h.run((c) => c.markUnknown(item.commandId, 2, later));
      const recovered = await h.run((c) => c.listRecoverable({ limit: 1 }));
      assert.deepEqual(recovered[0]!.actor, actor);
      assert.equal(recovered[0]!.state, "unknown");
    });
  });
  test(`commands ${backend} conflicting terminal receipts and pending projection CAS each have one winner`, async () => {
    await isolated(backend, async (h, request) => {
      await h.run((c) => c.admit(request, now));
      const sending = (await h.run((c) =>
        c.dispatch(request.commandId, 1, now),
      ))!;
      const committed = receipt(sending);
      const denied = {
        protocol: "morphz-domain/v1",
        status: "rejected",
        binding: committed.binding,
        receiptId: "denied_receipt",
        reason: { code: "denied", message: "Authoritative denial" },
      };
      const competing = await Promise.allSettled([
        h.run((c) => c.recordReceipt(request.commandId, committed, later)),
        h.run((c) => c.recordReceipt(request.commandId, denied, later)),
      ]);
      const winners = competing.filter(
        (result) => result.status === "fulfilled",
      );
      assert.equal(winners.length, 1);
      const loser = competing.find((result) => result.status === "rejected");
      assert.ok(
        loser &&
          loser.status === "rejected" &&
          rejected("conflict")(loser.reason),
      );
      const fixed = (await h.run((c) => c.read(request.commandId)))!;
      assert.equal(fixed.revision, 3);
      assert.deepEqual(fixed, winners[0]!.value);
      const winningWire = fixed.state === "committed" ? committed : denied;
      assert.equal(
        fixed.receiptHash,
        createHash("sha256")
          .update(canonicalJsonBytes(parseDomainReceipt(winningWire)))
          .digest("hex"),
      );
      assert.deepEqual(
        await h.run((c) =>
          c.recordReceipt(request.commandId, winningWire, now),
        ),
        fixed,
      );
      const projectionRequest = { ...request, commandId: "projection_race" };
      await h.run((c) => c.admit(projectionRequest, now));
      const projectionSending = (await h.run((c) =>
        c.dispatch(projectionRequest.commandId, 1, now),
      ))!;
      const pending = await h.run((c) =>
        c.recordReceipt(
          projectionRequest.commandId,
          receipt(projectionSending),
          later,
        ),
      );
      const projected = await Promise.all([
        h.run((c) =>
          c.markProjected(projectionRequest.commandId, pending.revision, later),
        ),
        h.run((c) =>
          c.markProjected(projectionRequest.commandId, pending.revision, later),
        ),
      ]);
      assert.equal(projected.filter(Boolean).length, 1);
      const final = (await h.run((c) => c.read(projectionRequest.commandId)))!;
      assert.equal(final.projectionState, "projected");
      assert.equal(final.revision, pending.revision + 1);
      assert.deepEqual(final, projected.find(Boolean));
    });
  });
  test(`commands ${backend} resource UTF-8 budgets and duplicate object identities reject before admission`, async () => {
    await isolated(backend, async (h, request) => {
      const resources = Array.from({ length: 32 }, (_, index) => ({
        objectId: `${String(index).padStart(2, "0")}${"界".repeat(198)}`,
        versionRef: "界".repeat(200),
      }));
      assert.ok(
        Buffer.byteLength(JSON.stringify(resources), "utf8") > 32 * 1024,
      );
      await assert.rejects(
        h.run((c) => c.admit({ ...request, resources }, now)),
        rejected("invalid"),
      );
      await assert.rejects(
        h.run((c) =>
          c.admit(
            {
              ...request,
              resources: [
                { objectId: "original", versionRef: "v1" },
                { objectId: "original", versionRef: "v2" },
              ],
            },
            now,
          ),
        ),
        rejected("invalid"),
      );
      assert.equal(await h.run((c) => c.read(request.commandId)), null);
      assert.equal(
        await h.run((c) => c.hasOpenCommands(request.projectId)),
        false,
      );
    });
  });
  test(`commands ${backend} summaries use their own 64KiB budget and never drop legitimate larger reference sets`, async () => {
    await isolated(backend, async (h, request) => {
      await h.run((c) => c.admit(request, now));
      const sending = (await h.run((c) =>
        c.dispatch(request.commandId, 1, now),
      ))!;
      const objects = Array.from({ length: 32 }, (_, index) => ({
        objectId: `${String(index).padStart(2, "0")}${"界".repeat(198)}`,
        versionRef: "界".repeat(200),
        kind: "document",
        title: "Original",
      }));
      const refs = objects.map(({ objectId, versionRef }) => ({
        objectId,
        versionRef,
      }));
      assert.ok(Buffer.byteLength(JSON.stringify(refs), "utf8") > 32 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(objects), "utf8") < 64 * 1024);
      const tooLarge = objects.map((object) => ({
        ...object,
        kind: "界".repeat(100),
        title: "界".repeat(180),
      }));
      assert.ok(
        Buffer.byteLength(JSON.stringify(tooLarge), "utf8") > 64 * 1024,
      );
      await assert.rejects(
        h.run((c) =>
          c.recordReceipt(
            request.commandId,
            { ...receipt(sending), objects: tooLarge },
            later,
          ),
        ),
        rejected("invalid"),
      );
      assert.deepEqual(await h.run((c) => c.read(request.commandId)), sending);
      const valid = { ...receipt(sending), objects };
      assert.deepEqual(parseDomainReceipt(valid).status, "committed");
      const committed = await h.run((c) =>
        c.recordReceipt(request.commandId, valid, later),
      );
      assert.deepEqual(committed.objects, objects);
      assert.deepEqual(
        await h.run((c) => c.read(request.commandId)),
        committed,
      );
    });
  });
  test(`commands ${backend} competing immutable admissions, receipt replay and caller transaction rollback remain exact`, async () => {
    await isolated(backend, async (h, request) => {
      const competing = await Promise.allSettled([
        h.run((c) => c.admit(request, now)),
        h.run((c) =>
          c.admit({ ...request, requestHash: "b".repeat(64) }, later),
        ),
      ]);
      assert.equal(
        competing.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const conflict = competing.find((result) => result.status === "rejected");
      assert.ok(
        conflict &&
          conflict.status === "rejected" &&
          rejected("conflict")(conflict.reason),
      );
      const original = (await h.run((c) => c.read(request.commandId)))!;
      const sending = (await h.run((c) =>
        c.dispatch(request.commandId, original.revision, now),
      ))!;
      const wire = receipt(sending);
      const receipts = await Promise.all([
        h.run((c) => c.recordReceipt(request.commandId, wire, later)),
        h.run((c) => c.recordReceipt(request.commandId, wire, later)),
      ]);
      assert.deepEqual(receipts[0], receipts[1]);
      assert.equal(receipts[0]!.revision, 3);
      const pending = receipts[0]!;
      // This proves only existing caller transaction composition, not actual
      // content-catalog projection or Runtime authorization.
      await assert.rejects(
        h.run(async (c, _registry, q) => {
          await q.change(
            "UPDATE projects SET title='caller rollback' WHERE tenant_id=? AND project_id=?",
            [tenantId, request.projectId],
          );
          const projected = await c.markProjected(
            request.commandId,
            pending.revision,
            later,
          );
          assert.equal(projected!.projectionState, "projected");
          throw new Error("controlled caller rollback");
        }),
        /controlled caller rollback/,
      );
      assert.deepEqual(await h.run((c) => c.read(request.commandId)), pending);
      assert.equal(
        (
          await h.sql(
            "SELECT title FROM projects WHERE tenant_id=? AND project_id=?",
            [tenantId, request.projectId],
          )
        )[0]!.title,
        "TEST",
      );
    });
  });
  for (const change of [
    "grant_state",
    "grant_revision",
    "connection_state",
    "connection_revision",
    "installation",
    "instance",
    "definition",
    "route",
  ] as const)
    test(`commands ${backend} dispatch fence rejects changed ${change} without losing admission`, async () => {
      await isolated(backend, async (h, request) => {
        const original = await h.run((c) => c.admit(request, now));
        const sql = {
          grant_state:
            "UPDATE cognitive_app_grants SET state='disabled',revision=2",
          grant_revision: "UPDATE cognitive_app_grants SET revision=2",
          connection_state:
            "UPDATE cognitive_app_connections SET state='unavailable',revision=2",
          connection_revision:
            "UPDATE cognitive_app_connections SET revision=2",
          installation: "UPDATE app_installations SET state='disabled'",
          instance: "UPDATE app_instances SET state='unavailable'",
          definition: "UPDATE cognitive_app_versions SET definition_json='{}'",
          route: "UPDATE app_instances SET route_ref='another_authority'",
        }[change];
        await h.sql(sql);
        await assert.rejects(
          h.run((c) => c.dispatch(request.commandId, 1, later)),
          rejected(),
        );
        assert.deepEqual(
          await h.run((c) => c.read(request.commandId)),
          original,
        );
        assert.deepEqual(await h.run((c) => c.admit(request, later)), original);
      });
    });
  test(`commands ${backend} verified committed fact persists no business result, replays exactly and projects only through pending CAS`, async () => {
    await isolated(backend, async (h, request) => {
      await h.run((c) => c.admit(request, now));
      const sending = (await h.run((c) =>
        c.dispatch(request.commandId, 1, now),
      ))!;
      await h.sql(
        "UPDATE cognitive_app_grants SET state='disabled',revision=2",
      );
      await h.sql(
        "UPDATE cognitive_app_connections SET state='disabled',revision=2",
      );
      const wire = receipt(sending);
      const actual = await h.run((c) =>
        c.recordReceipt(request.commandId, wire, later),
      );
      assert.equal(actual.state, "committed");
      assert.equal(actual.projectionState, "pending");
      assert.deepEqual(actual.objects, wire.objects);
      assert.equal(
        actual.receiptHash,
        createHash("sha256")
          .update(canonicalJsonBytes(parseDomainReceipt(wire)))
          .digest("hex"),
      );
      assert.equal(actual.receiptRef, wire.receiptId);
      assert.equal(
        JSON.stringify(
          (await h.sql("SELECT * FROM cognitive_app_commands"))[0],
        ).includes("private_business_result"),
        false,
      );
      assert.equal(
        JSON.stringify(actual).includes("private_business_result"),
        false,
      );
      assert.deepEqual(
        await h.run((c) => c.recordReceipt(request.commandId, wire, now)),
        actual,
      );
      await assert.rejects(
        h.run((c) =>
          c.recordReceipt(
            request.commandId,
            { ...wire, receiptId: "another" },
            now,
          ),
        ),
        rejected("conflict"),
      );
      await assert.rejects(
        h.run((c) =>
          c.recordReceipt(request.commandId, { ...wire, result: null }, now),
        ),
        rejected("conflict"),
      );
      assert.equal(await h.run((c) => c.hasOpenCommands("project_one")), false);
      assert.equal(
        await h.run((c) => c.hasPendingProjection("project_one")),
        true,
      );
      assert.equal(
        await h.run((c) => c.hasPendingProjection("project_two")),
        false,
      );
      assert.deepEqual(
        await h.run((c) => c.lockForAdmission(request.commandId)),
        actual,
      );
      assert.equal(
        await h.run((c) =>
          c.markProjected(request.commandId, actual.revision - 1, later),
        ),
        null,
      );
      const projected = await h.run((c) =>
        c.markProjected(request.commandId, actual.revision, later),
      );
      assert.equal(projected!.projectionState, "projected");
      assert.equal(
        await h.run((c) => c.hasPendingProjection("project_one")),
        false,
      );
      assert.equal(
        await h.run((c) =>
          c.markProjected(request.commandId, projected!.revision, later),
        ),
        null,
      );
      assert.deepEqual(
        await h.run((c) => c.recordReceipt(request.commandId, wire, later)),
        projected,
      );
    });
  });
  test(`commands ${backend} mixed receipt identities, unsent/cancelled and unknown envelopes cannot invent a terminal fact`, async () => {
    await isolated(backend, async (h, request) => {
      const original = await h.run((c) => c.admit(request, now));
      await assert.rejects(
        h.run((c) =>
          c.recordReceipt(request.commandId, receipt(original), now),
        ),
        rejected("conflict"),
      );
      const cancelled = await h.run((c) =>
        c.cancelAdmitted(request.commandId, 1, later),
      );
      assert.equal(cancelled!.state, "cancelled");
      assert.equal(
        await h.run((c) =>
          c.markUnknown(request.commandId, cancelled!.revision, later),
        ),
        null,
      );
      await assert.rejects(
        h.run((c) =>
          c.recordReceipt(request.commandId, receipt(original), now),
        ),
        rejected("conflict"),
      );
      const next = { ...request, commandId: "sent" };
      await h.run((c) => c.admit(next, now));
      const sending = (await h.run((c) => c.dispatch(next.commandId, 1, now)))!;
      const wire = receipt(sending);
      for (const binding of [
        { ...wire.binding, requestHash: "b".repeat(64) },
        { ...wire.binding, commandId: request.commandId },
        { ...wire.binding, projectId: "project_two" },
        { ...wire.binding, actor: input },
        {
          ...wire.binding,
          authority: { ...request.authority, dataAuthorityId: "another" },
        },
      ])
        await assert.rejects(
          h.run((c) =>
            c.recordReceipt(next.commandId, { ...wire, binding }, now),
          ),
          rejected("invalid"),
        );
      const unknown = {
        protocol: "morphz-domain/v1",
        status: "unknown",
        binding: wire.binding,
        reason: { code: "not_seen", message: "May still be in flight" },
      };
      await assert.rejects(
        h.run((c) => c.recordReceipt(next.commandId, unknown, now)),
        rejected("invalid"),
      );
      const uncertain = (await h.run((c) =>
        c.markUnknown(next.commandId, 2, later),
      ))!;
      const denied = {
        protocol: "morphz-domain/v1",
        status: "rejected",
        binding: wire.binding,
        receiptId: "author_denial",
        reason: { code: "domain_denied", message: "Author proved no commit" },
      };
      const actual = await h.run((c) =>
        c.recordReceipt(next.commandId, denied, later),
      );
      assert.equal(actual.state, "rejected");
      assert.equal(actual.committedAt, null);
      assert.equal(actual.objects, null);
      assert.equal(actual.projectionState, "none");
      assert.deepEqual(
        await h.run((c) => c.recordReceipt(next.commandId, denied, now)),
        actual,
      );
      await assert.rejects(
        h.run((c) => c.recordReceipt(next.commandId, wire, now)),
        rejected("conflict"),
      );
      assert.deepEqual(actual.actor, uncertain.actor);
    });
  });
  test(`commands ${backend} bounded recovery paging retains source and excludes aliases and new-send permission`, async () => {
    await isolated(backend, async (h, request) => {
      for (let index = 0; index < 34; index++) {
        const item = {
          ...request,
          commandId: `command_${String(index).padStart(2, "0")}`,
          actor: index % 2 ? scheduled : input,
        };
        await h.run((c) => c.admit(item, now));
        await h.run((c) => c.dispatch(item.commandId, 1, now));
        if (index % 2)
          await h.run((c) => c.markUnknown(item.commandId, 2, later));
      }
      const first = await h.run((c) => c.listRecoverable({ limit: 32 }));
      const last = await h.run((c) =>
        c.listRecoverable({
          afterCommandId: first.at(-1)!.commandId,
          limit: 32,
        }),
      );
      assert.equal(first.length, 32);
      assert.equal(last.length, 2);
      assert.equal(
        new Set([...first, ...last].map((row) => row.commandId)).size,
        34,
      );
      assert.equal(JSON.stringify(first).includes("private_alias"), false);
      assert.deepEqual(first[1]!.actor, scheduled);
      for (const row of [...first, ...last])
        assert.equal(
          await h.run((c) => c.dispatch(row.commandId, row.revision, later)),
          null,
        );
      await assert.rejects(
        h.run((c) => c.listRecoverable({ limit: 33 })),
        rejected("invalid"),
      );
      await assert.rejects(
        h.run((c) => c.listRecoverable({ limit: 0 })),
        rejected("invalid"),
      );
      assert.equal(await h.run((c) => c.hasOpenCommands("project_two")), false);
      const terminal = receipt(first[0]!);
      await h.run((c) => c.recordReceipt(first[0]!.commandId, terminal, later));
      const pending = await h.run((c) =>
        c.listPendingProjection({ limit: 32 }),
      );
      assert.deepEqual(
        pending.map((row) => row.commandId),
        [first[0]!.commandId],
      );
    });
  });
}
