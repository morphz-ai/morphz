import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";
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
  PlatformStorageError,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";

const now = "2026-10-05T00:00:00.000Z";
const human = { credential: "alice" };
const agent = { credential: "agent" };
const definition = {
  format: "morphz-cognitive-app/v1",
  protocol: "morphz-domain/v1",
  id: "example.notes",
  version: "1.0.0",
  title: "Notes",
  description: "Actual independent notes",
  icon: "book",
  harness: null,
  ui: null,
  operations: [
    {
      id: "read-note",
      title: "Read",
      description: "Read exact version",
      effect: "read",
      scope: "objects",
    },
    {
      id: "write-note",
      title: "Write",
      description: "Write exact baseline",
      effect: "write",
      scope: "objects",
    },
    {
      id: "execute-note",
      title: "Execute",
      description: "Execute exact baseline",
      effect: "execute",
      scope: "objects",
    },
    {
      id: "project-write",
      title: "Project",
      description: "Project operation",
      effect: "write",
      scope: "project",
    },
  ].map((operation) => ({
    ...operation,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 100 } },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  })),
};
const denied = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof PlatformStorageError);
  assert.equal(error.code, expected);
  return true;
};
type Identity = NonNullable<
  Awaited<ReturnType<PlatformAuthorityVerifier["resolveActor"]>>
>;
type Harness = {
  store: PlatformStore;
  q: SqlQuery;
  identities: Map<string, Identity>;
  actants: Map<string, { principalId: string; kind: "human" | "agent" }>;
  callbackDepths: number[];
  checkCallbackDepth: boolean;
  reopen(): Promise<void>;
};
async function isolated(
  backend: "sqlite" | "postgres",
  run: (h: Harness) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-platform-"));
  const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : null;
  let database: DatabaseSync | undefined, store: PlatformStore | undefined;
  let releaseAdmin: (() => void) | undefined;
  let depth = 0;
  const identities = new Map<string, Identity>([
    [
      "alice",
      {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "alice-human",
        kind: "human",
        runtimeInputId: null,
      },
    ],
    [
      "bob",
      {
        tenantId: "tenant-a",
        principalId: "bob",
        actantId: "bob-human",
        kind: "human",
        runtimeInputId: null,
      },
    ],
    [
      "agent",
      {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: "input-one",
        initiatingHumanActantId: "alice-human",
        scopeProjectId: "project-a",
      },
    ],
  ]);
  const actants = new Map<
    string,
    { principalId: string; kind: "human" | "agent" }
  >([
    ["alice-human", { principalId: "alice", kind: "human" }],
    ["bob-human", { principalId: "bob", kind: "human" }],
    ["agent-one", { principalId: "agent-service", kind: "agent" }],
  ]);
  const callbackDepths: number[] = [];
  let h!: Harness;
  const callback = () => {
    callbackDepths.push(depth);
    if (h?.checkCallbackDepth)
      assert.equal(
        depth,
        0,
        "Trusted identity I/O must precede the SQL transaction.",
      );
  };
  const capabilities: PlatformAuthorityVerifier = {
    async resolveActor(access) {
      callback();
      return identities.get(access.credential) ?? null;
    },
    async resolveActant({ tenantId, actantId }) {
      callback();
      return tenantId === "tenant-a" ? (actants.get(actantId) ?? null) : null;
    },
    async resolveProjectAgent() {
      callback();
      return { principalId: "agent-service", actantId: "agent-one" };
    },
    async verifyApplicationObject() {
      callback();
      return false;
    },
  };
  try {
    let q: SqlQuery;
    if (pool) {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      store = await PlatformStore.postgres(
        { connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!, schema },
        capabilities,
      );
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}",pg_catalog`);
      q = postgresQuery(client);
      // Keep the isolated administration connection separate from the Store's q.
      releaseAdmin = () => client.release();
    } else {
      const filename = join(directory, "platform.sqlite");
      store = await PlatformStore.sqlite(filename, capabilities);
      database = new DatabaseSync(filename);
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(database);
    }
    const transaction = Reflect.get(store, "transaction").bind(store);
    Reflect.set(
      store,
      "transaction",
      (work: (q: SqlQuery) => Promise<unknown>, mode?: string) =>
        transaction(async (sameQ: SqlQuery) => {
          depth++;
          try {
            return await work(sameQ);
          } finally {
            depth--;
          }
        }, mode),
    );
    h = {
      store,
      q,
      identities,
      actants,
      callbackDepths,
      checkCallbackDepth: false,
      async reopen() {
        await store!.close();
        store = pool
          ? await PlatformStore.postgres(
              {
                connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
                schema,
              },
              capabilities,
            )
          : await PlatformStore.sqlite(
              join(directory, "platform.sqlite"),
              capabilities,
            );
        h.store = store;
      },
    };
    await store.provisionTenant("tenant-a", now);
    for (const [id, kind] of [
      ["project-a", "project"],
      ["project-b", "project"],
      ["personal-desk", "desk"],
    ]) {
      await q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a',?,?, 'alice',?,1,?,?)",
        [id!, kind!, id!, now, now],
      );
      for (const member of ["alice", "agent-service"])
        await q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a',?,?)",
          [id!, member],
        );
    }
    await run(h);
  } finally {
    releaseAdmin?.();
    await store?.close();
    database?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
async function connected(h: Harness) {
  const version = await h.store.installCognitiveApp(human, { definition, now });
  await h.store.changeCognitiveAppGrant(human, {
    appId: definition.id,
    version: definition.version,
    expectedRevision: 0,
    state: "active",
    now,
  });
  const proof = {
    purpose: "connection-setup" as const,
    appId: definition.id,
    version: definition.version,
    definitionHash: version.definitionHash,
    serviceId: "service/notes",
    dataAuthorityId: "database:notes",
    hostBindingId: "host_private_alias",
  };
  const connection = await h.store.createVerifiedCognitiveAppConnection(
    human,
    await prepareConnectionCreation(h.store, human, {
      proof,
      connectionId: "conn-alice",
      expectedRevision: 0,
      now,
    }),
  );
  return { version, connection, proof };
}
function request(
  connectionId = "conn-alice",
  operationId = "write-note",
  resources: unknown = [{ objectId: "note-one", versionRef: "v2" }],
) {
  return {
    projectId: "project-a",
    appId: definition.id,
    version: definition.version,
    connectionId,
    operationId,
    parameters: { text: "Keep exact content" },
    resources,
  };
}
async function content(
  h: Harness,
  instanceId: string,
  objectId = "note-one",
  projectId = "project-a",
  availability = "available",
) {
  await h.q.change(
    "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES('tenant-a',?,'example.notes',?,?,?,'note','Original','v2',?,?,1,?,?)",
    [
      `catalog-${objectId}`,
      instanceId,
      objectId,
      projectId,
      now,
      availability,
      now,
      now,
    ],
  );
}

import type { CognitiveAppCommandSnapshot } from "../packages/platform/src/cognitive-app-commands.js";

function command(
  commandId = "command-one",
  overrides: Partial<ReturnType<typeof request>> = {},
) {
  return {
    ...request("conn-alice", "project-write", []),
    ...overrides,
    commandId,
  };
}
function receipt(c: CognitiveAppCommandSnapshot) {
  return {
    protocol: "morphz-domain/v1",
    status: "committed",
    binding: {
      authority: c.authority,
      actor: c.actor,
      projectId: c.projectId,
      operationId: c.operationId,
      commandId: c.commandId,
      requestHash: c.requestHash,
    },
    receiptId: "receipt-one",
    committedAt: now,
    result: { private: "never persisted even though business schema fails" },
    objects: [
      {
        objectId: "new-note",
        versionRef: "opaque:v3",
        kind: "note",
        title: "Original",
      },
    ],
  };
}
const host = (commandId = "command-one") => ({
  tenantId: "tenant-a",
  commandId,
});
const retiring = {
  commandId: "retire-project",
  projectId: "project-a",
  expectedRevision: 1,
  state: "archived" as const,
  now,
};
async function sending(h: Harness, access = human, id = "command-one") {
  const req = command(id);
  const ready = await h.store.admitCognitiveAppCommand(access, req);
  return (await h.store.dispatchCognitiveAppCommand(access, {
    ...req,
    expectedCommandRevision: ready.command.revision,
  }))!;
}

function exactRead(
  objectId = "note-one",
  versionRef = "historic:v1",
  projectId = "project-a",
) {
  return {
    appId: definition.id,
    version: definition.version,
    connectionId: "conn-alice",
    projectId,
    object: { objectId, versionRef },
    maxBytes: 64 * 1024,
  };
}
async function committed(
  h: Harness,
  id = "command-one",
  objects = [
    {
      objectId: "new-note",
      versionRef: "opaque:v3",
      kind: "note",
      title: "Original",
    },
  ],
) {
  const dispatched = await sending(h, agent, id);
  return h.store.recordCognitiveAppCommandReceipt({
    ...host(id),
    receipt: { ...receipt(dispatched.command), objects },
  });
}
async function nav(h: Harness) {
  return (
    await h.q.all<{
      revision: number | string;
      projects_revision: number | string;
      access_revision: number | string;
    }>("SELECT * FROM navigation_heads WHERE tenant_id='tenant-a'")
  )[0]!;
}
const project = (commandId: string, expectedCommandRevision: number) => ({
  ...host(commandId),
  expectedCommandRevision,
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`Platform object projection atomic catalog, delivery receipt, outbox and navigation on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const original = await committed(h);
      const before = await nav(h);
      h.callbackDepths.length = 0;
      h.checkCallbackDepth = true;
      const result = await h.store.projectCognitiveAppCommand(
        project(original.commandId, original.revision),
      );
      assert.ok(result);
      assert.equal(result.changed, true);
      assert.equal(result.command.projectionState, "projected");
      assert.equal(result.contentIds.length, 1);
      const after = await nav(h);
      assert.equal(Number(after.revision), Number(before.revision) + 1);
      assert.equal(after.projects_revision, before.projects_revision);
      assert.equal(after.access_revision, before.access_revision);
      const catalog = (
        await h.q.all<{
          app_object_id: string;
          observed_version_ref: string;
          project_id: string;
        }>("SELECT * FROM content_entries")
      )[0]!;
      assert.equal(catalog.app_object_id, "new-note");
      assert.equal(catalog.observed_version_ref, "opaque:v3");
      assert.equal(catalog.project_id, "project-a");
      const events = await h.q.all<{
        event_id: string;
        payload: string;
        event_kind: string;
      }>("SELECT * FROM outbox WHERE aggregate_kind='content'");
      const receipts = await h.q.all<{
        command_id: string;
        runtime_input_id: string;
        actor_actant_id: string;
        result_ref: string;
      }>(
        "SELECT * FROM command_receipts WHERE operation IN ('record-content','refresh-content')",
      );
      assert.equal(events.length, 1);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.runtime_input_id, "input-one");
      assert.equal(receipts[0]!.actor_actant_id, "agent-one");
      assert.equal(receipts[0]!.result_ref, result.contentIds[0]);
      const eventId =
        "cognitive_delivery_" +
        createHash("sha256")
          .update(
            JSON.stringify([
              "tenant-a",
              original.commandId,
              original.receiptHash,
              "new-note",
            ]),
          )
          .digest("hex")
          .slice(0, 40);
      assert.equal(events[0]!.event_id, eventId);
      assert.equal(receipts[0]!.command_id, eventId);
      assert.equal(
        JSON.parse(events[0]!.payload).cognitiveCommandId,
        original.commandId,
      );
      assert.deepEqual(JSON.parse(events[0]!.payload).actor, original.actor);
      assert.equal(JSON.stringify(events).includes("never persisted"), false);
      assert.equal(
        await h.store.projectCognitiveAppCommand(
          project(original.commandId, original.revision),
        ),
        null,
      );
      assert.deepEqual(await nav(h), after);
      assert.equal(
        h.callbackDepths.length,
        0,
        "Committed-fact projection does not require a live Runtime/login callback.",
      );
      const deliveries = await h.store.contentDeliveries(human, {
        inputIds: ["input-one"],
      });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]!.version_ref, "opaque:v3");
      assert.equal(deliveries[0]!.content_id, result.contentIds[0]);
      assert.equal(deliveries[0]!.app_object_id, "new-note");
      assert.equal(deliveries[0]!.source_project_id, "project-a");
    }));
  test(`Platform object projection same-head keeps manual metadata but still notifies once on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      const request = command("same-head", {
        operationId: "write-note",
        resources: [{ objectId: "note-one", versionRef: "v2" }],
      });
      const ready = await h.store.admitCognitiveAppCommand(agent, request);
      const sent = await h.store.dispatchCognitiveAppCommand(agent, {
        ...request,
        expectedCommandRevision: ready.command.revision,
      });
      const saved = await h.store.recordCognitiveAppCommandReceipt({
        ...host("same-head"),
        receipt: {
          ...receipt(sent!.command),
          objects: [
            {
              objectId: "note-one",
              versionRef: "v2",
              kind: "note",
              title: "Do not overwrite manual title",
            },
          ],
        },
      });
      const before = await nav(h);
      const beforeCatalog = await h.q.all("SELECT * FROM content_entries");
      const result = await h.store.projectCognitiveAppCommand(
        project(saved.commandId, saved.revision),
      );
      assert.ok(result);
      assert.equal(result.changed, false);
      assert.deepEqual(
        await h.q.all("SELECT * FROM content_entries"),
        beforeCatalog,
      );
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
      assert.equal(
        (await h.q.all("SELECT * FROM outbox WHERE aggregate_kind='content'"))
          .length,
        1,
      );
      assert.equal(
        await h.store.projectCognitiveAppCommand(
          project(saved.commandId, saved.revision),
        ),
        null,
      );
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
    }));
  test(`Platform object projection empty summary and concurrent retry notify exactly once on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const saved = await committed(h, "empty", []);
      const before = await nav(h);
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          h.store.projectCognitiveAppCommand(
            project(saved.commandId, saved.revision),
          ),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
      assert.deepEqual(results.find(Boolean)!.contentIds, []);
      assert.equal(results.find(Boolean)!.changed, false);
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
      assert.equal((await h.q.all("SELECT * FROM content_entries")).length, 0);
      assert.equal(
        (await h.q.all("SELECT * FROM outbox WHERE aggregate_kind='content'"))
          .length,
        0,
      );
      assert.equal(
        await h.store.projectCognitiveAppCommand(
          project(saved.commandId, saved.revision + 1),
        ),
        null,
      );
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
    }));
  test(`Platform object projection navigation failure rolls back every actual write on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const saved = await committed(h);
      const before = await nav(h);
      const advance = Reflect.get(h.store, "advanceNavigation").bind(h.store);
      let actualNavigationWrite = false;
      Reflect.set(h.store, "advanceNavigation", async (...args: unknown[]) => {
        await advance(...args);
        actualNavigationWrite = true;
        throw new Error("TEST fail after actual navigation SQL");
      });
      await assert.rejects(
        () =>
          h.store.projectCognitiveAppCommand(
            project(saved.commandId, saved.revision),
          ),
        /TEST fail after actual navigation SQL/,
      );
      assert.equal(actualNavigationWrite, true);
      assert.deepEqual(await nav(h), before);
      assert.equal((await h.q.all("SELECT * FROM content_entries")).length, 0);
      assert.equal(
        (await h.q.all("SELECT * FROM outbox WHERE aggregate_kind='content'"))
          .length,
        0,
      );
      assert.equal(
        (
          await h.q.all(
            "SELECT * FROM command_receipts WHERE operation IN ('record-content','refresh-content')",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: saved.commandId,
          })
        ).projectionState,
        "pending",
      );
      Reflect.set(h.store, "advanceNavigation", advance);
      assert.ok(
        await h.store.projectCognitiveAppCommand(
          project(saved.commandId, saved.revision),
        ),
      );
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
    }));
  test(`Platform object projection conflict stays committed pending and never moves existing object on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId, "outside", "project-b");
      const saved = await committed(h, "conflict", [
        { objectId: "new-note", versionRef: "v1", kind: "note", title: "New" },
        {
          objectId: "outside",
          versionRef: "v2",
          kind: "note",
          title: "Never move",
        },
      ]);
      const before = await nav(h);
      const catalog = await h.q.all("SELECT * FROM content_entries");
      await assert.rejects(
        () =>
          h.store.projectCognitiveAppCommand(
            project(saved.commandId, saved.revision),
          ),
        denied("conflict"),
      );
      assert.deepEqual(await h.q.all("SELECT * FROM content_entries"), catalog);
      assert.deepEqual(await nav(h), before);
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: saved.commandId,
          })
        ).projectionState,
        "pending",
      );
      assert.equal(
        (await h.q.all("SELECT * FROM outbox WHERE aggregate_kind='content'"))
          .length,
        0,
      );
    }));
  test(`Platform object projection releases retirement only after original catalog completion on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const saved = await committed(h);
      await assert.rejects(
        () => h.store.beginProjectRetirement(human, retiring),
        denied("conflict"),
      );
      await h.store.projectCognitiveAppCommand(
        project(saved.commandId, saved.revision),
      );
      assert.equal(
        await h.store.beginProjectRetirement(human, retiring),
        "fenced",
      );
      assert.equal(
        await h.store.completeProjectRetirement(human, retiring),
        "project-a",
      );
      assert.equal(
        (
          await h.q.all<{ archived_at: string | null }>(
            "SELECT archived_at FROM projects WHERE project_id='project-a'",
          )
        )[0]!.archived_at,
        now,
      );
      assert.equal((await h.q.all("SELECT * FROM content_entries")).length, 1);
      assert.equal(
        (
          await h.store.resolveCognitiveAppObjectRead(
            human,
            exactRead("new-note", "historical:original"),
          )
        ).object.versionRef,
        "historical:original",
      );
    }));
  test(`Platform object projection retains commit with disabled permissions without new read authority on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      const saved = await committed(h);
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await h.store.changeCognitiveAppConnectionState(human, {
        appId: definition.id,
        version: definition.version,
        connectionId: "conn-alice",
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await h.q.change(
        "UPDATE app_instances SET state='disabled' WHERE instance_id=?",
        [connection.instanceId],
      );
      await h.q.change(
        "UPDATE app_installations SET state='disabled' WHERE app_id='example.notes'",
      );
      h.identities.delete("agent");
      h.actants.delete("agent-one");
      h.checkCallbackDepth = true;
      assert.ok(
        await h.store.projectCognitiveAppCommand(
          project(saved.commandId, saved.revision),
        ),
      );
      assert.equal((await h.q.all("SELECT * FROM content_entries")).length, 1);
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppObjectRead(human, exactRead("new-note")),
        denied("forbidden"),
      );
    }));
  test(`Platform exact object read preserves opaque historical ref without invoke fallback on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      const objectId = "  原件\n😀  ";
      await content(h, connection.instanceId, objectId);
      Reflect.set(h.store, "resolveCognitiveAppOperation", () => {
        throw new Error("Must not fake an invoke operation");
      });
      h.callbackDepths.length = 0;
      h.checkCallbackDepth = true;
      const request = exactRead(objectId, "  历史\n\t:v1  ");
      const before = await nav(h);
      const resolved = await h.store.resolveCognitiveAppObjectRead(
        agent,
        request,
      );
      assert.deepEqual(resolved.object, request.object);
      assert.notEqual(resolved.object, request.object);
      assert.equal(resolved.target.instanceId, connection.instanceId);
      assert.equal(resolved.maxBytes, 64 * 1024);
      assert.deepEqual(resolved.actor.source, {
        kind: "input",
        inputId: "input-one",
        humanActantId: "alice-human",
      });
      assert.deepEqual(await nav(h), before);
      assert.ok(h.callbackDepths.every((x) => x === 0));
      const missingHistory = await h.store.resolveCognitiveAppObjectRead(
        human,
        exactRead(objectId, "not-in-catalog-history"),
      );
      assert.equal(
        missingHistory.object.versionRef,
        "not-in-catalog-history",
        "Only the author exact read proves historical existence.",
      );
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppObjectRead(
            human,
            exactRead("missing-object"),
          ),
        denied("not_found"),
      );
    }));
  test(`Platform exact object read actual membership source project and availability on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      await content(h, connection.instanceId, "other", "project-b");
      h.checkCallbackDepth = true;
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppObjectRead(
            agent,
            exactRead("other", "v2", "project-b"),
          ),
        denied("forbidden"),
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppObjectRead(human, exactRead("other")),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppObjectRead(
            { credential: "bob" },
            exactRead(),
          ),
        denied("forbidden"),
      );
      await h.q.change(
        "UPDATE content_entries SET availability='unavailable' WHERE app_object_id='note-one'",
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppObjectRead(agent, exactRead()),
        denied("not_found"),
      );
      await h.q.change(
        "UPDATE content_entries SET availability='available' WHERE app_object_id='note-one'",
      );
      await h.q.change(
        "DELETE FROM project_members WHERE principal_id='agent-service' AND project_id='project-a'",
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppObjectRead(agent, exactRead()),
        denied("forbidden"),
      );
      assert.equal(
        (await h.store.resolveCognitiveAppObjectRead(human, exactRead())).actor
          .kind,
        "human",
      );
    }));
  test(`Platform exact object read detached reference and target survive real SQL I/O on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      const request = exactRead();
      const originalObject = request.object;
      const transaction = Reflect.get(h.store, "transaction").bind(h.store);
      let changed = false;
      Reflect.set(
        h.store,
        "transaction",
        (work: (q: SqlQuery) => Promise<unknown>, mode?: string) =>
          transaction(
            (q: SqlQuery) =>
              work(
                new Proxy(q, {
                  get(target, property) {
                    if (property !== "all")
                      return Reflect.get(target, property);
                    return async (...args: Parameters<SqlQuery["all"]>) => {
                      const rows = await q.all(...args);
                      if (
                        !changed &&
                        args[0].includes("FROM cognitive_app_versions")
                      ) {
                        changed = true;
                        originalObject.objectId = "different-object";
                        originalObject.versionRef = "different-ref";
                        request.projectId = "project-b";
                        request.appId = "other.notes";
                        request.version = "2.0.0";
                        request.connectionId = "other-connection";
                        request.maxBytes = 0;
                      }
                      return rows;
                    };
                  },
                }),
              ),
            mode,
          ),
      );
      h.checkCallbackDepth = true;
      const resolved = await h.store.resolveCognitiveAppObjectRead(
        agent,
        request,
      );
      assert.equal(
        changed,
        true,
        "Mutation happens only after an actual SQL await.",
      );
      assert.deepEqual(resolved.object, {
        objectId: "note-one",
        versionRef: "historic:v1",
      });
      assert.notEqual(resolved.object, originalObject);
      assert.equal(resolved.maxBytes, 64 * 1024);
      assert.equal(resolved.target.appId, definition.id);
      assert.equal(resolved.target.version, definition.version);
      assert.equal(resolved.target.connectionId, "conn-alice");
      assert.equal(resolved.target.instanceId, connection.instanceId);
      assert.equal(
        JSON.stringify(resolved).includes("host_private_alias"),
        false,
      );
    }));
  test(`Platform exact object read scheduled provenance retains actual task-run source on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      for (const withInput of [true, false]) {
        const suffix = withInput ? "input" : "no-input";
        const taskId = `task-${suffix}`;
        h.checkCallbackDepth = false;
        await h.store.createTask(human, {
          commandId: `create-${suffix}`,
          taskId,
          projectId: "project-a",
          title: "Task",
          assigneeId: "agent-one",
          now,
        });
        const admission = await h.store.requestTaskRun(
          withInput ? agent : human,
          {
            commandId: `run-${suffix}`,
            taskId,
            expectedRevision: 1,
            sessionId: `session-${suffix}`,
            intent: "Read exact original",
            notBefore: now,
            now,
          },
        );
        const runtimeTaskRun = {
          sessionId: admission.sessionId,
          scheduleId: admission.request.id,
          eventId: admission.eventId,
        };
        h.identities.set("scheduled", {
          ...h.identities.get("agent")!,
          runtimeInputId: withInput ? "input-one" : null,
          runtimeTaskRun,
        });
        h.callbackDepths.length = 0;
        h.checkCallbackDepth = true;
        const resolved = await h.store.resolveCognitiveAppObjectRead(
          { credential: "scheduled" },
          exactRead(),
        );
        assert.deepEqual(resolved.actor.source, {
          kind: "task-run",
          ...runtimeTaskRun,
          sourceInputId: withInput ? "input-one" : null,
          humanActantId: "alice-human",
        });
        h.identities.set("scheduled", {
          ...h.identities.get("scheduled")!,
          runtimeTaskRun: { ...runtimeTaskRun, eventId: "spoofed-event" },
        });
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppObjectRead(
              { credential: "scheduled" },
              exactRead(),
            ),
          denied("forbidden"),
        );
        h.identities.set("scheduled", {
          ...h.identities.get("agent")!,
          initiatingHumanActantId: "bob-human",
        });
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppObjectRead(
              { credential: "scheduled" },
              exactRead(),
            ),
          denied("forbidden"),
        );
        assert.ok(h.callbackDepths.every((x) => x === 0));
      }
    }));
  test(`Platform object projection retained delivery is stable across Store reopen on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const saved = await committed(h);
      const projected = await h.store.projectCognitiveAppCommand(
        project(saved.commandId, saved.revision),
      );
      const before = await nav(h);
      const catalog = await h.q.all("SELECT * FROM content_entries");
      const receipts = await h.q.all("SELECT * FROM command_receipts");
      const events = await h.q.all("SELECT * FROM outbox");
      await h.reopen();
      assert.equal(
        await h.store.projectCognitiveAppCommand(
          project(saved.commandId, saved.revision),
        ),
        null,
      );
      assert.deepEqual(await nav(h), before);
      assert.deepEqual(await h.q.all("SELECT * FROM content_entries"), catalog);
      assert.deepEqual(
        await h.q.all("SELECT * FROM command_receipts"),
        receipts,
      );
      assert.deepEqual(await h.q.all("SELECT * FROM outbox"), events);
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: saved.commandId,
          })
        ).projectionState,
        "projected",
      );
      assert.equal(
        (
          await h.store.contentDeliveries(human, { inputIds: ["input-one"] })
        )[0]!.content_id,
        projected!.contentIds[0],
      );
    }));
  test(`Platform exact object read current grant/connection fences remain separate from historical versions on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const { instanceId } = (
        await h.store.listCognitiveApps(human, { limit: 10 })
      ).connections[0]!;
      await content(h, instanceId);
      const req = {
        ...exactRead(),
        expectedGrantRevision: 1,
        expectedConnectionRevision: 1,
      };
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await assert.rejects(
        () => h.store.resolveCognitiveAppObjectRead(human, req),
        denied("forbidden"),
      );
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 2,
        state: "active",
        now,
      });
      await assert.rejects(
        () => h.store.resolveCognitiveAppObjectRead(human, req),
        denied("conflict"),
      );
      const current = { ...req, expectedGrantRevision: 3 };
      assert.equal(
        (await h.store.resolveCognitiveAppObjectRead(human, current)).object
          .versionRef,
        "historic:v1",
      );
      await h.store.changeCognitiveAppConnectionState(human, {
        appId: definition.id,
        version: definition.version,
        connectionId: "conn-alice",
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await assert.rejects(
        () => h.store.resolveCognitiveAppObjectRead(human, current),
        denied("forbidden"),
      );
      await h.store.changeCognitiveAppConnectionState(human, {
        appId: definition.id,
        version: definition.version,
        connectionId: "conn-alice",
        expectedRevision: 2,
        state: "active",
        now,
      });
      await assert.rejects(
        () => h.store.resolveCognitiveAppObjectRead(human, current),
        denied("conflict"),
      );
      assert.equal(
        (
          await h.store.resolveCognitiveAppObjectRead(human, {
            ...current,
            expectedConnectionRevision: 3,
          })
        ).target.connectionRevision,
        3,
      );
    }));
  test(`Platform exact object read validates fixed budgets and portable refs before identity on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      h.callbackDepths.length = 0;
      for (const maxBytes of [0, 262145, 1.5, NaN, Infinity])
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppObjectRead(human, {
              ...exactRead(),
              maxBytes,
            }),
          denied("invalid"),
        );
      for (const objectId of [
        "",
        "a".repeat(201),
        "before\u0000after",
        "bad\ud800",
      ])
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppObjectRead(human, exactRead(objectId)),
          denied("invalid"),
        );
      for (const versionRef of ["", "a".repeat(201), "bad\udc00"])
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppObjectRead(
              human,
              exactRead("note-one", versionRef),
            ),
          denied("invalid"),
        );
      assert.equal(h.callbackDepths.length, 0);
      await assert.rejects(
        () => h.store.projectCognitiveAppCommand(project("missing", 0)),
        denied("invalid"),
      );
    }));
}
