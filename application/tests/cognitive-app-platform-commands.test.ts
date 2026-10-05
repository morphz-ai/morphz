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
  const connection = await h.store.createVerifiedCognitiveAppConnection(human, {
    proof,
    connectionId: "conn-alice",
    expectedRevision: 0,
    now,
  });
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

import { canonicalInvokeIdentityBytes } from "../packages/cognitive-app-sdk/src/domain-wire.js";
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
for (const backend of ["sqlite", "postgres"] as const) {
  test(`Platform commands detached parameter/resource/tuple snapshot survives real SQL I/O on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      const resources = [{ objectId: "note-one", versionRef: "v2" }];
      const parameters = { text: "Original\u0000\ud800 body" };
      const req = command("snapshot", {
        operationId: "write-note",
        resources,
        parameters,
      });
      const originalText = parameters.text;
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
                        parameters.text = "x".repeat(101);
                        resources[0]!.objectId = "outside-original";
                        resources.push({
                          objectId: "another",
                          versionRef: "v5",
                        });
                        req.projectId = "project-b";
                        req.connectionId = "other-connection";
                        req.operationId = "read-note";
                        req.version = "2.0.0";
                        req.commandId = "other-command";
                      }
                      return rows;
                    };
                  },
                }),
              ),
            mode,
          ),
      );
      const prepared = await h.store.admitCognitiveAppCommand(human, req);
      assert.equal(
        changed,
        true,
        "The test mutates the original only after an actual SQL await.",
      );
      assert.equal(
        (prepared.parameters as { text: string }).text,
        originalText,
      );
      assert.notEqual(prepared.parameters, parameters);
      assert.deepEqual(prepared.command.resources, [
        { objectId: "note-one", versionRef: "v2" },
      ]);
      assert.notEqual(prepared.command.resources, resources);
      assert.equal(prepared.command.projectId, "project-a");
      assert.equal(prepared.command.commandId, "snapshot");
      assert.equal(prepared.command.operationId, "write-note");
      assert.equal(prepared.command.connectionId, "conn-alice");
      const bytes = canonicalInvokeIdentityBytes(
        {
          protocol: "morphz-domain/v1",
          delegation: {
            purpose: "invoke",
            issuer: "actual-test-host",
            expiresAt: "2026-10-05T00:05:00.000Z",
            authority: prepared.command.authority,
            actor: prepared.command.actor,
            projectId: "project-a",
            operationId: "write-note",
            resources: prepared.command.resources,
            command: {
              commandId: "snapshot",
              requestHash: prepared.command.requestHash,
            },
          },
          parameters: { text: originalText },
        },
        "write",
        "objects",
      );
      assert.equal(
        prepared.command.requestHash,
        createHash("sha256").update(bytes).digest("hex"),
      );
    }));
  test(`Platform commands scheduled source is actual task-run even with retained input on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      for (const withInput of [true, false]) {
        const suffix = withInput ? "input" : "no-input";
        const taskId = `task-${suffix}`;
        await h.store.createTask(human, {
          commandId: `create-${suffix}`,
          taskId,
          projectId: "project-a",
          title: "Task",
          assigneeId: "agent-one",
          now,
        });
        const admitted = await h.store.requestTaskRun(
          withInput ? agent : human,
          {
            commandId: `run-${suffix}`,
            taskId,
            expectedRevision: 1,
            sessionId: `session-${suffix}`,
            intent: "Exact operation",
            notBefore: now,
            now,
          },
        );
        const runtimeTaskRun = {
          sessionId: admitted.sessionId,
          scheduleId: admitted.request.id,
          eventId: admitted.eventId,
        };
        h.identities.set("scheduled", {
          ...h.identities.get("agent")!,
          runtimeInputId: withInput ? "input-one" : null,
          runtimeTaskRun,
        });
        h.callbackDepths.length = 0;
        h.checkCallbackDepth = true;
        const result = await h.store.admitCognitiveAppCommand(
          { credential: "scheduled" },
          command(`scheduled-${suffix}`),
        );
        assert.deepEqual(result.command.actor.source, {
          kind: "task-run",
          ...runtimeTaskRun,
          sourceInputId: withInput ? "input-one" : null,
          humanActantId: "alice-human",
        });
        const sent = await h.store.dispatchCognitiveAppCommand(
          { credential: "scheduled" },
          { ...command(`scheduled-${suffix}`), expectedCommandRevision: 1 },
        );
        assert.equal(sent!.command.state, "dispatching");
        h.identities.set("scheduled", {
          ...h.identities.get("scheduled")!,
          runtimeTaskRun: { ...runtimeTaskRun, eventId: "spoofed-event" },
        });
        await assert.rejects(
          () =>
            h.store.admitCognitiveAppCommand(
              { credential: "scheduled" },
              command(`spoofed-${suffix}`),
            ),
          denied("forbidden"),
        );
        assert.ok(h.callbackDepths.every((x) => x === 0));
        h.checkCallbackDepth = false;
      }
    }));
  test(`Platform commands current consent and connection revisions cannot replace old admitted snapshots on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection, proof } = await connected(h);
      const req = command();
      const original = await h.store.admitCognitiveAppCommand(human, req);
      await h.store.changeCognitiveAppConnectionState(human, {
        appId: definition.id,
        version: definition.version,
        connectionId: connection.connectionId,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await h.store.changeCognitiveAppConnectionState(human, {
        appId: definition.id,
        version: definition.version,
        connectionId: connection.connectionId,
        expectedRevision: 2,
        state: "active",
        now,
      });
      assert.deepEqual(
        (await h.store.admitCognitiveAppCommand(human, req)).command,
        original.command,
      );
      await assert.rejects(
        () =>
          h.store.dispatchCognitiveAppCommand(human, {
            ...req,
            expectedCommandRevision: 1,
          }),
        denied("conflict"),
      );
      await assert.rejects(
        () =>
          h.store.admitCognitiveAppCommand(human, {
            ...req,
            expectedConnectionRevision: 3,
          }),
        denied("conflict"),
      );
      assert.equal(
        (
          await h.q.all<{ host_binding_id: string }>(
            "SELECT host_binding_id FROM cognitive_app_connections",
          )
        )[0]!.host_binding_id,
        proof.hostBindingId,
      );
      const fresh = await h.store.admitCognitiveAppCommand(
        human,
        command("fresh"),
      );
      assert.equal(fresh.command.connectionRevision, 3);
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 2,
        state: "active",
        now,
      });
      await assert.rejects(
        () =>
          h.store.dispatchCognitiveAppCommand(human, {
            ...command("fresh"),
            expectedCommandRevision: 1,
          }),
        denied("conflict"),
      );
      assert.deepEqual(
        (await h.store.admitCognitiveAppCommand(human, command("fresh")))
          .command,
        fresh.command,
      );
    }));
  test(`Platform commands host recovery retains original alias across new route and store reopening on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection, proof } = await connected(h);
      const sent = await sending(h, agent);
      await h.store.markCognitiveAppCommandUnknown({
        ...host(),
        expectedCommandRevision: 2,
      });
      const migrated = await h.store.createVerifiedCognitiveAppConnection(
        human,
        {
          proof: { ...proof, hostBindingId: "another_private_route" },
          connectionId: "new-route",
          expectedRevision: 0,
          now,
        },
      );
      assert.equal(migrated.instanceId, connection.instanceId);
      await h.reopen();
      const recovery = await h.store.prepareCognitiveAppReceiptRecovery(host());
      assert.equal(recovery.connection.connectionId, "conn-alice");
      assert.equal(recovery.connection.hostBindingId, proof.hostBindingId);
      assert.deepEqual(recovery.command.actor, sent.command.actor);
      assert.equal(recovery.command.state, "unknown");
      await assert.rejects(
        () =>
          h.store.prepareCognitiveAppReceiptRecovery({
            tenantId: "tenant-b",
            commandId: "command-one",
          }),
        denied("not_found"),
      );
      await h.store.recordCognitiveAppCommandReceipt({
        ...host(),
        receipt: receipt(sent.command),
      });
      await h.reopen();
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: "command-one",
          })
        ).state,
        "committed",
      );
    }));
  test(`Platform commands opposite resource orders preserve identity while concurrent writes use stable locks on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId, "a-note");
      await content(h, connection.instanceId, "z-note");
      const resources = [
        { objectId: "a-note", versionRef: "v2" },
        { objectId: "z-note", versionRef: "v2" },
      ];
      const requests = [
        command("forward", { operationId: "write-note", resources }),
        command("reverse", {
          operationId: "write-note",
          resources: [...resources].reverse(),
        }),
      ];
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
      const ready = await Promise.all(
        requests.map((req) => h.store.admitCognitiveAppCommand(human, req)),
      );
      assert.notEqual(
        ready[0]!.command.requestHash,
        ready[1]!.command.requestHash,
      );
      assert.deepEqual(ready[0]!.command.resources, resources);
      assert.deepEqual(ready[1]!.command.resources, [...resources].reverse());
      const sent = await Promise.all(
        requests.map((req) =>
          h.store.dispatchCognitiveAppCommand(human, {
            ...req,
            expectedCommandRevision: 1,
          }),
        ),
      );
      assert.ok(sent.every(Boolean));
      assert.equal(traces.size, 4);
      for (const trace of traces.values())
        assert.deepEqual(trace, ["a-note", "z-note"]);
    }));
  test(`Platform commands unknown blocks actual old retirement finalization and authoritative rejection releases it on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      await h.store.beginProjectRetirement(human, retiring);
      const oldFence = (
        await h.q.all<{ request_hash: string }>(
          "SELECT request_hash FROM project_retirements",
        )
      )[0]!;
      await h.store.abortProjectRetirement(human, retiring);
      const sent = await sending(h);
      await h.store.markCognitiveAppCommandUnknown({
        ...host(),
        expectedCommandRevision: 2,
      });
      await assert.rejects(
        () => h.store.beginProjectRetirement(human, retiring),
        denied("conflict"),
      );
      await h.q.change(
        "INSERT INTO project_retirements VALUES('tenant-a','project-a','retire-project',?,'archived',1,?)",
        [oldFence.request_hash, now],
      );
      await assert.rejects(
        () => h.store.completeProjectRetirement(human, retiring),
        (error) => {
          denied("conflict")(error);
          assert.match((error as Error).message, /尚未确定结果/);
          return true;
        },
      );
      const valid = receipt(sent.command);
      const rejected = {
        protocol: valid.protocol,
        status: "rejected",
        binding: valid.binding,
        receiptId: "authoritative-denial",
        reason: { code: "not_committed", message: "No commit" },
      };
      assert.equal(
        (
          await h.store.recordCognitiveAppCommandReceipt({
            ...host(),
            receipt: rejected,
          })
        ).state,
        "rejected",
      );
      assert.equal(
        await h.store.completeProjectRetirement(human, retiring),
        "project-a",
      );
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: "command-one",
          })
        ).state,
        "rejected",
      );
    }));
  test(`Platform commands Human connection state management derives private route without credentials on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection, proof } = await connected(h);
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      const req = {
        appId: definition.id,
        version: definition.version,
        connectionId: connection.connectionId,
        expectedRevision: 1,
        state: "disabled" as const,
        now,
      };
      h.checkCallbackDepth = true;
      const disabled = await h.store.changeCognitiveAppConnectionState(
        human,
        req,
      );
      assert.equal(disabled.state, "disabled");
      assert.equal("hostBindingId" in disabled, false);
      assert.equal(
        (
          await h.q.all<{ host_binding_id: string }>(
            "SELECT host_binding_id FROM cognitive_app_connections",
          )
        )[0]!.host_binding_id,
        proof.hostBindingId,
      );
      await assert.rejects(
        () =>
          h.store.changeCognitiveAppConnectionState(agent, {
            ...req,
            expectedRevision: 2,
          }),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.changeCognitiveAppConnectionState(
            { credential: "bob" },
            { ...req, expectedRevision: 2 },
          ),
        denied("not_found"),
      );
      await assert.rejects(
        () =>
          h.store.changeCognitiveAppConnectionState(human, {
            ...req,
            expectedRevision: 2,
            state: "active",
          }),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.changeCognitiveAppConnectionState(human, {
            ...req,
            expectedRevision: 1,
            state: "unavailable",
          }),
        denied("conflict"),
      );
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 2,
        state: "active",
        now,
      });
      assert.equal(
        (
          await h.store.changeCognitiveAppConnectionState(human, {
            ...req,
            expectedRevision: 2,
            state: "active",
          })
        ).state,
        "active",
      );
      assert.ok(h.callbackDepths.every((x) => x === 0));
    }));
  test(`Platform commands actual source admission and exact SDK semantic SHA on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      h.checkCallbackDepth = true;
      const request = command();
      const ready = await h.store.admitCognitiveAppCommand(agent, request);
      assert.equal(ready.command.actor.kind, "agent");
      assert.deepEqual(ready.command.actor.source, {
        kind: "input",
        inputId: "input-one",
        humanActantId: "alice-human",
      });
      const bytes = canonicalInvokeIdentityBytes(
        {
          protocol: "morphz-domain/v1",
          delegation: {
            purpose: "invoke",
            issuer: "actual-test-host",
            expiresAt: "2026-10-05T00:05:00.000Z",
            authority: ready.command.authority,
            actor: ready.command.actor,
            projectId: request.projectId,
            operationId: request.operationId,
            resources: request.resources,
            command: {
              commandId: request.commandId,
              requestHash: ready.command.requestHash,
            },
          },
          parameters: request.parameters,
        },
        "write",
        "project",
      );
      assert.equal(
        ready.command.requestHash,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.equal(ready.command.revision, 1);
      const stored = await h.q.all<{ resources_json: string }>(
        "SELECT * FROM cognitive_app_commands WHERE command_id='command-one'",
      );
      assert.equal(
        JSON.stringify(stored).includes(request.parameters.text),
        false,
      );
      assert.ok(h.callbackDepths.every((x) => x === 0));
      await assert.rejects(
        () =>
          h.store.admitCognitiveAppCommand(human, {
            ...request,
            commandId: "read-admission",
            operationId: "read-note",
            resources: [{ objectId: "note-one", versionRef: "v2" }],
          }),
        denied("invalid"),
      );
    }));
  test(`Platform commands exact replay after revocation and no rebind on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const req = command();
      const original = await h.store.admitCognitiveAppCommand(agent, req);
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      assert.deepEqual(
        (await h.store.admitCognitiveAppCommand(agent, req)).command,
        original.command,
      );
      await assert.rejects(
        () =>
          h.store.dispatchCognitiveAppCommand(agent, {
            ...req,
            expectedCommandRevision: 1,
          }),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.admitCognitiveAppCommand(agent, {
            ...req,
            parameters: { text: "different" },
          }),
        denied("conflict"),
      );
      await assert.rejects(
        () => h.store.admitCognitiveAppCommand(human, req),
        denied("forbidden"),
      );
      h.identities.set("agent", {
        ...h.identities.get("agent")!,
        runtimeInputId: "other-input",
      });
      await assert.rejects(
        () => h.store.admitCognitiveAppCommand(agent, req),
        denied("forbidden"),
      );
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: req.commandId,
          })
        ).actor.kind,
        "agent",
      );
      await assert.rejects(
        () =>
          h.store.inspectCognitiveAppCommand(
            { credential: "bob" },
            { projectId: "project-a", commandId: req.commandId },
          ),
        denied("forbidden"),
      );
    }));
  test(`Platform commands first dispatch one winner, unknown never retries and explicit unsent cancel on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const req = command();
      await h.store.admitCognitiveAppCommand(human, req);
      const races = await Promise.all(
        [1, 2, 3].map(() =>
          h.store.dispatchCognitiveAppCommand(human, {
            ...req,
            expectedCommandRevision: 1,
          }),
        ),
      );
      assert.equal(races.filter(Boolean).length, 1);
      assert.equal(races.find(Boolean)!.command.state, "dispatching");
      const changed = await h.store.markCognitiveAppCommandUnknown({
        ...host(),
        expectedCommandRevision: 2,
      });
      assert.equal(changed!.state, "unknown");
      assert.equal(
        await h.store.dispatchCognitiveAppCommand(human, {
          ...req,
          expectedCommandRevision: 3,
        }),
        null,
      );
      assert.equal(
        await h.store.cancelAdmittedCognitiveAppCommand({
          ...host(),
          expectedCommandRevision: 3,
        }),
        null,
      );
      assert.equal(
        (
          await h.store.listRecoverableCognitiveAppCommands({
            tenantId: "tenant-a",
            limit: 10,
          })
        ).length,
        1,
      );
      const neverSent = await h.store.admitCognitiveAppCommand(
        human,
        command("unsent"),
      );
      assert.equal(
        (await h.store.cancelAdmittedCognitiveAppCommand({
          ...host("unsent"),
          expectedCommandRevision: neverSent.command.revision,
        }))!.state,
        "cancelled",
      );
      assert.equal(
        await h.store.dispatchCognitiveAppCommand(human, {
          ...command("unsent"),
          expectedCommandRevision: 2,
        }),
        null,
      );
    }));
  test(`Platform commands recheck changed baseline and actual membership before dispatch on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection } = await connected(h);
      await content(h, connection.instanceId);
      const req = command("baseline", {
        operationId: "write-note",
        resources: [{ objectId: "note-one", versionRef: "v2" }],
      });
      await h.store.admitCognitiveAppCommand(agent, req);
      await h.q.change(
        "UPDATE content_entries SET observed_version_ref='v3' WHERE app_object_id='note-one'",
      );
      await assert.rejects(
        () =>
          h.store.dispatchCognitiveAppCommand(agent, {
            ...req,
            expectedCommandRevision: 1,
          }),
        denied("conflict"),
      );
      await h.q.change(
        "UPDATE content_entries SET observed_version_ref='v2' WHERE app_object_id='note-one'",
      );
      await h.q.change(
        "DELETE FROM project_members WHERE principal_id='agent-service' AND project_id='project-a'",
      );
      await assert.rejects(
        () =>
          h.store.dispatchCognitiveAppCommand(agent, {
            ...req,
            expectedCommandRevision: 1,
          }),
        denied("forbidden"),
      );
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: req.commandId,
          })
        ).state,
        "admitted",
      );
    }));
  test(`Platform commands original recovery survives dead credential and disabled grant/instance but not connection on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const { connection, proof } = await connected(h);
      const started = await sending(h, agent);
      await h.store.markCognitiveAppCommandUnknown({
        ...host(),
        expectedCommandRevision: started.command.revision,
      });
      h.identities.delete("agent");
      h.actants.delete("agent-one");
      await h.store.changeCognitiveAppGrant(human, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await h.q.change(
        "UPDATE app_instances SET state='disabled' WHERE tenant_id='tenant-a' AND instance_id=?",
        [connection.instanceId],
      );
      const original = await h.store.prepareCognitiveAppReceiptRecovery(host());
      assert.deepEqual(original.command.actor, started.command.actor);
      assert.equal(original.connection.hostBindingId, proof.hostBindingId);
      await h.store.changeVerifiedCognitiveAppConnection(human, {
        proof,
        connectionId: connection.connectionId,
        expectedRevision: 1,
        state: "disabled",
        now,
      });
      await assert.rejects(
        () => h.store.prepareCognitiveAppReceiptRecovery(host()),
        denied("forbidden"),
      );
      const committed = await h.store.recordCognitiveAppCommandReceipt({
        ...host(),
        receipt: receipt(started.command),
      });
      assert.equal(committed.state, "committed");
      assert.equal(committed.projectionState, "pending");
      assert.equal(
        (
          await h.store.listPendingCognitiveAppCommandProjections({
            tenantId: "tenant-a",
            limit: 10,
          })
        ).length,
        1,
      );
      const rows = await h.q.all(
        "SELECT * FROM cognitive_app_commands WHERE command_id='command-one'",
      );
      assert.equal(JSON.stringify(rows).includes("private_business"), false);
      assert.equal(JSON.stringify(rows).includes("never persisted"), false);
    }));
  test(`Platform commands receipt strict binding and HTTP failure cannot forge rejection on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const started = await sending(h);
      const valid = receipt(started.command);
      await assert.rejects(
        () =>
          h.store.recordCognitiveAppCommandReceipt({
            ...host(),
            receipt: {
              ...valid,
              binding: { ...valid.binding, projectId: "project-b" },
            },
          }),
        denied("invalid"),
      );
      await assert.rejects(
        () =>
          h.store.recordCognitiveAppCommandReceipt({
            ...host(),
            receipt: { status: "rejected", httpStatus: 403 },
          }),
        denied("invalid"),
      );
      await assert.rejects(
        () =>
          h.store.recordCognitiveAppCommandReceipt({
            ...host(),
            receipt: {
              protocol: "morphz-domain/v1",
              status: "unknown",
              binding: valid.binding,
              reason: { code: "not_seen", message: "Still uncertain" },
            },
          }),
        denied("invalid"),
      );
      assert.equal(
        (
          await h.store.inspectCognitiveAppCommand(human, {
            projectId: "project-a",
            commandId: "command-one",
          })
        ).state,
        "dispatching",
      );
      const committed = await h.store.recordCognitiveAppCommandReceipt({
        ...host(),
        receipt: valid,
      });
      assert.deepEqual(
        await h.store.recordCognitiveAppCommandReceipt({
          ...host(),
          receipt: valid,
        }),
        committed,
      );
      await assert.rejects(
        () =>
          h.store.recordCognitiveAppCommandReceipt({
            ...host(),
            receipt: { ...valid, receiptId: "another" },
          }),
        denied("conflict"),
      );
      await assert.rejects(
        () =>
          h.store.listRecoverableCognitiveAppCommands({
            tenantId: "tenant-a",
            limit: 33,
          }),
        denied("invalid"),
      );
    }));
  test(`Platform commands admission/current retirement fence and begin/final pending protection on ${backend}`, async () =>
    isolated(backend, async (h) => {
      await connected(h);
      const initial = await h.store.admitCognitiveAppCommand(human, command());
      await assert.rejects(
        () => h.store.beginProjectRetirement(human, retiring),
        denied("conflict"),
      );
      assert.equal(
        (await h.q.all("SELECT * FROM project_retirements")).length,
        0,
      );
      await h.store.cancelAdmittedCognitiveAppCommand({
        ...host(),
        expectedCommandRevision: initial.command.revision,
      });
      assert.equal(
        await h.store.beginProjectRetirement(human, retiring),
        "fenced",
      );
      const originalFence = (
        await h.q.all<{ request_hash: string }>(
          "SELECT request_hash FROM project_retirements",
        )
      )[0]!;
      await assert.rejects(
        () => h.store.admitCognitiveAppCommand(human, command("fenced")),
        denied("conflict"),
      );
      await h.store.abortProjectRetirement(human, retiring);
      const started = await sending(h, human, "pending-projection");
      await h.store.recordCognitiveAppCommandReceipt({
        ...host("pending-projection"),
        receipt: receipt(started.command),
      });
      await assert.rejects(
        () => h.store.beginProjectRetirement(human, retiring),
        denied("conflict"),
      );
      // Simulate a previously admitted retirement whose old Host did not know v11.
      await h.q.change(
        "INSERT INTO project_retirements(tenant_id,project_id,command_id,request_hash,target_state,expected_revision,begun_at) VALUES('tenant-a','project-a','retire-project',?,'archived',1,?)",
        [originalFence.request_hash, now],
      );
      // Use the actual private fingerprint helper through the first begin, not a fake completion.
      const fence = await h.q.all<{ request_hash: string }>(
        "SELECT request_hash FROM project_retirements",
      );
      assert.equal(fence.length, 1);
      await assert.rejects(
        () => h.store.completeProjectRetirement(human, retiring),
        (error) => {
          denied("conflict")(error);
          assert.match((error as Error).message, /目录尚未补齐/);
          return true;
        },
      );
      assert.equal(
        (
          await h.q.all<{ archived_at: string | null }>(
            "SELECT archived_at FROM projects WHERE project_id='project-a'",
          )
        )[0]!.archived_at,
        null,
      );
    }));
}
