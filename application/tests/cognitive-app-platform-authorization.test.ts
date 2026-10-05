import test from "node:test";
import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
for (const backend of ["sqlite", "postgres"] as const) {
  test(`Platform cognitive opposite resource orders resolve concurrently with deterministic catalog locks on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId, "a-note");
      await content(h, connection.instanceId, "z-note");
      const traces = new Map<SqlQuery, string[]>();
      const guard = Reflect.get(h.store, "authorizeApplicationObjectRow").bind(
        h.store,
      );
      Reflect.set(
        h.store,
        "authorizeApplicationObjectRow",
        async (q: SqlQuery, ...args: unknown[]) => {
          const trace = traces.get(q) ?? [];
          trace.push(args[3] as string);
          traces.set(q, trace);
          return guard(q, ...args);
        },
      );
      const forward = [
        { objectId: "a-note", versionRef: "v2" },
        { objectId: "z-note", versionRef: "v2" },
      ];
      const reversed = [...forward].reverse();
      const [one, two] = await Promise.all([
        h.store.resolveCognitiveAppOperation(
          human,
          request("conn-alice", "write-note", forward),
        ),
        h.store.resolveCognitiveAppOperation(
          human,
          request("conn-alice", "write-note", reversed),
        ),
      ]);
      assert.deepEqual(one.resources, forward);
      assert.deepEqual(two.resources, reversed);
      assert.equal(traces.size, 2);
      for (const trace of traces.values())
        assert.deepEqual(trace, ["a-note", "z-note"]);
    }));
  test(`Platform cognitive Host-only preparation and exact private connection on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { version, connection, proof } = await connected(h);
      h.checkCallbackDepth = true;
      const prepared = await h.store.prepareCognitiveAppConnection(human, {
        appId: definition.id,
        version: definition.version,
        expectedDefinitionHash: version.definitionHash,
        expectedGrantRevision: 1,
      });
      assert.equal(prepared.actor.kind, "human");
      assert.equal(prepared.grant.revision, 1);
      await assert.rejects(
        () =>
          h.store.prepareCognitiveAppConnection(agent, {
            appId: definition.id,
            version: definition.version,
          }),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.prepareCognitiveAppConnection(human, {
            appId: definition.id,
            version: definition.version,
            expectedGrantRevision: 9,
          }),
        denied("conflict"),
      );
      const exact = {
        projectId: "project-a",
        appId: connection.appId,
        instanceId: connection.instanceId,
        serviceId: connection.serviceId,
        dataAuthorityId: connection.dataAuthorityId,
        connectionId: connection.connectionId,
      };
      const privateConnection = await h.store.getCognitiveAppHostConnection(
        agent,
        exact,
      );
      assert.equal(privateConnection.hostBindingId, proof.hostBindingId);
      await assert.rejects(
        () =>
          h.store.getCognitiveAppHostConnection({ credential: "bob" }, exact),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.getCognitiveAppHostConnection(agent, {
            ...exact,
            dataAuthorityId: "another-original-database",
          }),
        denied("conflict"),
      );
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      // A retained binding read is not permission to invoke after grant revocation.
      await h.store.getCognitiveAppHostConnection(agent, exact);
      await assert.rejects(
        () =>
          h.store.prepareCognitiveAppConnection(human, {
            appId: definition.id,
            version: definition.version,
          }),
        denied("forbidden"),
      );
      await h.store.changeVerifiedCognitiveAppConnection(human, {
        proof,
        connectionId: connection.connectionId,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await assert.rejects(
        () => h.store.getCognitiveAppHostConnection(agent, exact),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.changeVerifiedCognitiveAppConnection(human, {
            proof,
            connectionId: connection.connectionId,
            expectedRevision: 2,
            state: "active",
            now,
          }),
        denied("forbidden"),
      );
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 2,
        state: "active",
        now,
      });
      await h.store.changeVerifiedCognitiveAppConnection(human, {
        proof,
        connectionId: connection.connectionId,
        expectedRevision: 2,
        state: "active",
        now,
      });
      assert.equal(
        (await h.store.getCognitiveAppHostConnection(agent, exact))
          .hostBindingId,
        proof.hostBindingId,
      );
    }));
  test(`Platform cognitive Agent registry read keeps actual source and executor membership on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      h.checkCallbackDepth = true;
      assert.equal(
        (await h.store.listCognitiveApps(agent, { limit: 20 })).connections
          .length,
        1,
      );
      await h.q.change(
        "DELETE FROM project_members WHERE project_id='project-a' AND principal_id='agent-service'",
      );
      await assert.rejects(
        () => h.store.listCognitiveApps(agent, { limit: 20 }),
        denied("forbidden"),
      );
      await h.q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a','agent-service')",
      );
      h.identities.set("agent", {
        ...h.identities.get("agent")!,
        scopeProjectId: "missing-project",
      });
      await assert.rejects(
        () => h.store.listCognitiveApps(agent, { limit: 20 }),
        denied("forbidden"),
      );
    }));
  test(`Platform cognitive prepared actual task run wins over its retained input source on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      await h.store.createTask(human, {
        commandId: "create-cognitive-task",
        taskId: "cognitive-task",
        projectId: "project-a",
        title: "App task",
        assigneeId: "agent-one",
        now,
      });
      const admission = await h.store.requestTaskRun(agent, {
        commandId: "start-cognitive-task",
        taskId: "cognitive-task",
        expectedRevision: 1,
        sessionId: "session-cognitive",
        intent: "Run declared operation",
        notBefore: now,
        now,
      });
      assert.equal(admission.sourceInputId, "input-one");
      const original = h.identities.get("agent")!;
      const runtimeTaskRun = {
        sessionId: admission.sessionId,
        scheduleId: admission.request.id,
        eventId: admission.eventId,
      };
      h.identities.set("scheduled", { ...original, runtimeTaskRun });
      // A no-dependency request is already prepared by the real Store. Remove
      // only the isolated preparation fact to exercise fail-closed recovery.
      assert.equal(
        await h.q.change(
          "DELETE FROM outbox WHERE aggregate_id='cognitive-task' AND event_kind='task.run_prepared'",
        ),
        1,
      );
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppOperation(
            { credential: "scheduled" },
            request(),
          ),
        denied("conflict"),
      );
      await h.store.prepareTaskRun(human, admission.eventId, async () => {
        throw new Error("No prerequisite Runtime expected.");
      });
      h.checkCallbackDepth = true;
      const resolved = await h.store.resolveCognitiveAppOperation(
        { credential: "scheduled" },
        request(),
      );
      assert.deepEqual(resolved.actor.source, {
        kind: "task-run",
        ...runtimeTaskRun,
        sourceInputId: "input-one",
        humanActantId: "alice-human",
      });
      h.identities.set("scheduled", {
        ...original,
        runtimeTaskRun: { ...runtimeTaskRun, eventId: "spoofed-event" },
      });
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppOperation(
            { credential: "scheduled" },
            request(),
          ),
        denied("forbidden"),
      );
      h.identities.set("scheduled", {
        ...original,
        runtimeTaskRun,
        scopeProjectId: "project-b",
      });
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppOperation(
            { credential: "scheduled" },
            request(),
          ),
        denied("forbidden"),
      );
    }));
  test(`Platform cognitive Human-only registry lifecycle and access invalidation on ${backend}`, async () =>
    isolated(backend, async (h) => {
      h.checkCallbackDepth = true;
      await assert.rejects(
        () => h.store.installCognitiveApp(agent, { definition, now }),
        denied("forbidden"),
      );
      const version = await h.store.installCognitiveApp(human, {
        definition,
        now,
      });
      const nav = async () =>
        Number(
          (
            await h.q.all(
              "SELECT access_revision FROM navigation_heads WHERE tenant_id='tenant-a'",
            )
          )[0]!.access_revision,
        );
      assert.equal(await nav(), 1);
      await h.store.installCognitiveApp(human, { definition, now });
      assert.equal(await nav(), 1);
      const catalog = await h.store.listCognitiveApps(human, { limit: 20 });
      assert.equal(catalog.versions.length, 1);
      assert.equal(catalog.versions[0]!.grant, null);
      assert.equal(
        (await h.q.all("SELECT * FROM cognitive_app_grants")).length,
        0,
      );
      await assert.rejects(
        () =>
          h.store.changeCognitiveAppGrant(agent, {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 0,
            state: "active",
            now,
          }),
        denied("forbidden"),
      );
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 0,
        state: "active",
        now,
      });
      assert.equal(await nav(), 2);
      await assert.rejects(
        () =>
          h.store.changeCognitiveAppGrant(human, {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 0,
            state: "disabled",
            now,
          }),
        denied("conflict"),
      );
      assert.equal(await nav(), 2);
      assert.equal(version.definition.id, definition.id);
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(human, {
            definition: {
              ...definition,
              ui: { path: "ui/index.html", sha256: "a".repeat(64) },
            },
            now,
          }),
        denied("invalid"),
      );
      assert.ok(h.callbackDepths.every((d) => d === 0));
    }));
  test(`Platform cognitive Host proof and connection route privacy on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { version, connection, proof } = await connected(h);
      // Prepare a valid actual Human handshake first. The negative calls below
      // still exercise the real create boundary, not a fixture preflight denial.
      const validCreation = await prepareConnectionCreation(h.store, human, {
        proof,
        connectionId: "agent-conn",
        expectedRevision: 0,
        now,
      });
      await assert.rejects(
        () =>
          h.store.createVerifiedCognitiveAppConnection(agent, validCreation),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.createVerifiedCognitiveAppConnection(human, {
            ...validCreation,
            proof: {
              ...proof,
              purpose: "receipt-recovery" as "connection-setup",
            },
            request: { ...validCreation.request, connectionId: "bad-purpose" },
          }),
        denied("invalid"),
      );
      await assert.rejects(
        () =>
          h.store.createVerifiedCognitiveAppConnection(human, {
            ...validCreation,
            proof: { ...proof, definitionHash: "0".repeat(64) },
            request: {
              ...validCreation.request,
              connectionId: "bad-definition",
            },
          }),
        denied("conflict"),
      );
      await assert.rejects(
        () =>
          h.store.changeVerifiedCognitiveAppConnection(human, {
            proof: { ...proof, hostBindingId: "another_route" },
            connectionId: connection.connectionId,
            expectedRevision: connection.revision,
            state: "active",
            now,
          }),
        denied("conflict"),
      );
      const changed = await h.store.changeVerifiedCognitiveAppConnection(
        human,
        {
          proof,
          connectionId: connection.connectionId,
          expectedRevision: connection.revision,
          state: "disabled",
          now,
        },
      );
      assert.equal(changed.revision, 2);
      const other = await h.store.createVerifiedCognitiveAppConnection(
        human,
        await prepareConnectionCreation(h.store, human, {
          proof,
          connectionId: "conn-second",
          expectedRevision: 0,
          now,
        }),
      );
      assert.equal(other.instanceId, connection.instanceId);
      const publicCatalog = await h.store.listCognitiveApps(human, {
        limit: 20,
      });
      assert.ok(
        !JSON.stringify([
          version,
          connection,
          changed,
          other,
          publicCatalog,
        ]).includes("host_private_alias"),
      );
      assert.equal(
        (await h.store.listCognitiveApps({ credential: "bob" }, { limit: 20 }))
          .connections.length,
        0,
      );
    }));
  test(`Platform cognitive actual source and both memberships resolve outside SQL on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      h.checkCallbackDepth = true;
      const resolved = await h.store.resolveCognitiveAppOperation(
        agent,
        request(),
      );
      assert.deepEqual(resolved.actor, {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        source: {
          kind: "input",
          inputId: "input-one",
          humanActantId: "alice-human",
        },
      });
      assert.equal(resolved.operation.effect, "write");
      assert.equal(resolved.operation.scope, "objects");
      assert.ok(!JSON.stringify(resolved).includes("host_private_alias"));
      h.actants.set("alice-human", { principalId: "bob", kind: "human" });
      await assert.rejects(
        () => h.store.resolveCognitiveAppOperation(agent, request()),
        denied("forbidden"),
      );
      h.actants.set("alice-human", { principalId: "alice", kind: "human" });
      h.actants.delete("agent-one");
      await assert.rejects(
        () => h.store.resolveCognitiveAppOperation(agent, request()),
        denied("forbidden"),
      );
      h.actants.set("agent-one", {
        principalId: "agent-service",
        kind: "agent",
      });
      await h.q.change(
        "DELETE FROM project_members WHERE tenant_id='tenant-a' AND project_id='project-a' AND principal_id='agent-service'",
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppOperation(agent, request()),
        denied("forbidden"),
      );
    }));
  test(`Platform cognitive denies spoofed input, audience and target premises on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      const original = h.identities.get("agent")!;
      for (const patch of [
        { runtimeInputId: null },
        { initiatingHumanActantId: "bob-human" },
        { scopeProjectId: "project-b" },
      ]) {
        h.identities.set("agent", { ...original, ...patch });
        await assert.rejects(
          () => h.store.resolveCognitiveAppOperation(agent, request()),
          denied("forbidden"),
        );
      }
      h.identities.set("agent", {
        ...original,
        scopeProjectId: "personal-desk",
      });
      h.checkCallbackDepth = true;
      await h.store.resolveCognitiveAppOperation(agent, request());
      await h.q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a','bob')",
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppOperation(agent, request()),
        denied("forbidden"),
      );
      h.identities.set("agent", original);
      for (const patch of [
        { expectedDefinitionHash: "0".repeat(64) },
        { expectedGrantRevision: 9 },
        { expectedConnectionRevision: 9 },
        { connectionId: "other-connection" },
      ])
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppOperation(human, {
              ...request(),
              ...patch,
            }),
          denied(patch.connectionId ? "not_found" : "conflict"),
        );
    }));
  test(`Platform cognitive all resources authorize exact actual directory ownership on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      await content(h, connection.instanceId, "foreign-project", "project-b");
      await content(
        h,
        connection.instanceId,
        "unavailable",
        "project-a",
        "unavailable",
      );
      for (const operationId of [
        "write-note",
        "execute-note",
        "project-write",
      ]) {
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppOperation(
              human,
              request("conn-alice", operationId, [
                { objectId: "note-one", versionRef: "v1" },
              ]),
            ),
          denied("conflict"),
        );
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppOperation(
              human,
              request("conn-alice", operationId, [
                { objectId: "foreign-project", versionRef: "v2" },
              ]),
            ),
          denied("forbidden"),
        );
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppOperation(
              human,
              request("conn-alice", operationId, [
                { objectId: "unavailable", versionRef: "v2" },
              ]),
            ),
          denied("not_found"),
        );
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppOperation(
              human,
              request("conn-alice", operationId, [
                { objectId: "missing", versionRef: "v2" },
              ]),
            ),
          denied("not_found"),
        );
      }
      const historical = await h.store.resolveCognitiveAppOperation(
        human,
        request("conn-alice", "read-note", [
          { objectId: "note-one", versionRef: "v1" },
        ]),
      );
      assert.equal(historical.resources[0]!.versionRef, "v1");
      // Catalog permission is not proof that this historical App version exists.
      await h.q.change(
        "UPDATE content_entries SET deleted_at=? WHERE app_object_id='note-one'",
        [now],
      );
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppOperation(
            human,
            request("conn-alice", "read-note"),
          ),
        denied("not_found"),
      );
    }));
  test(`Platform cognitive retired project remains readable and never writable on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      await h.q.change(
        "INSERT INTO project_retirements(tenant_id,project_id,command_id,request_hash,target_state,expected_revision,begun_at) VALUES('tenant-a','project-a','retire',?,'archived',1,?)",
        ["a".repeat(64), now],
      );
      await h.store.resolveCognitiveAppOperation(
        agent,
        request("conn-alice", "read-note"),
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppOperation(agent, request()),
        denied("conflict"),
      );
      await h.q.change("DELETE FROM project_retirements");
      await h.q.change(
        "UPDATE projects SET archived_at=? WHERE project_id='project-a'",
        [now],
      );
      await h.store.resolveCognitiveAppOperation(
        agent,
        request("conn-alice", "read-note"),
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppOperation(agent, request()),
        denied("forbidden"),
      );
    }));
  test(`Platform cognitive fixed declaration validates bounded parameters and resource scopes on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      for (const parameters of [
        { text: "x", extra: true },
        { text: 7 },
        { text: "x".repeat(101) },
        Object.defineProperty({}, "text", {
          enumerable: true,
          get() {
            throw new Error("must not invoke getter");
          },
        }),
      ])
        await assert.rejects(
          () =>
            h.store.resolveCognitiveAppOperation(human, {
              ...request(),
              parameters,
            }),
          denied("invalid"),
        );
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppOperation(
            human,
            request("conn-alice", "write-note", []),
          ),
        denied("invalid"),
      );
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppOperation(human, {
            ...request(),
            operationId: "unpublished",
          }),
        denied("not_found"),
      );
      await assert.rejects(
        () =>
          h.store.resolveCognitiveAppOperation(
            human,
            request("conn-alice", "write-note", [
              { objectId: "note-one", versionRef: "v2" },
              { objectId: "note-one", versionRef: "v2" },
            ]),
          ),
        denied("invalid"),
      );
      await h.store.resolveCognitiveAppOperation(
        human,
        request("conn-alice", "project-write", []),
      );
      await h.q.change(
        "UPDATE cognitive_app_grants SET state='disabled',revision=revision+1",
      );
      await assert.rejects(
        () => h.store.resolveCognitiveAppOperation(human, request()),
        denied("forbidden"),
      );
    }));
}
