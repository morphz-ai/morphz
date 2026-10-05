import test from "node:test";
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
  type PlatformActor,
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
  beforeResolveActor?: (access: PlatformActor) => void | Promise<void>;
  resolveCalls: number;
};
async function isolated(
  backend: "sqlite" | "postgres",
  run: (h: Harness) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-command-disclosure-"));
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
      if (h) h.resolveCalls++;
      await h?.beforeResolveActor?.(access);
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
      resolveCalls: 0,
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

// Explicit isolated authority-port fixture. Human/input identity is supplied by
// this verifier, not by caller command args; no claim of live Runtime acceptance.
const command = (commandId = "command-one") => ({
  ...request("conn-alice", "project-write", []),
  commandId,
});
const inspection = { projectId: "project-a", commandId: "command-one" };
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    "Disclosure missing port returns current actual Human separate from old Agent admission on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        const admitted = await h.store.admitCognitiveAppCommand(
          agent,
          command(),
        );
        h.checkCallbackDepth = true;
        h.callbackDepths.length = 0;
        const calls = h.resolveCalls;
        const disclosed = await h.store.inspectCognitiveAppCommandDisclosure(
          human,
          inspection,
        );
        assert.deepEqual(disclosed.command, admitted.command);
        assert.equal(disclosed.command.actor.kind, "agent");
        assert.deepEqual(disclosed.actor, {
          tenantId: "tenant-a",
          principalId: "alice",
          actantId: "alice-human",
          kind: "human",
          source: { kind: "human" },
        });
        assert.equal(h.resolveCalls, calls + 1);
        assert.ok(h.callbackDepths.every((depth) => depth === 0));
        assert.deepEqual(
          await h.store.inspectCognitiveAppCommand(human, inspection),
          admitted.command,
        );
      }),
  );
  test(
    "Disclosure captures original request and credential before identity awaits on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        await h.store.admitCognitiveAppCommand(human, command());
        const access = { credential: "alice" },
          request = { ...inspection };
        h.beforeResolveActor = () => {
          access.credential = "bob";
          request.commandId = "other-command";
          request.projectId = "project-b";
          h.beforeResolveActor = undefined;
        };
        const result = await h.store.inspectCognitiveAppCommandDisclosure(
          access,
          request,
        );
        assert.equal(result.command.commandId, "command-one");
        assert.equal(result.actor.principalId, "alice");
      }),
  );
  test(
    "Disclosure disabled current grant and changed actual Human actant never replace original command on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        const admitted = await h.store.admitCognitiveAppCommand(
          human,
          command(),
        );
        await h.store.changeCognitiveAppGrant(human, {
          appId: definition.id,
          version: definition.version,
          expectedRevision: 1,
          state: "disabled",
          now,
        });
        const before = await h.q.all("SELECT * FROM cognitive_app_commands");
        h.identities.set("other-human", {
          ...h.identities.get("alice")!,
          actantId: "alice-other-human",
        });
        h.actants.set("alice-other-human", {
          principalId: "alice",
          kind: "human",
        });
        const result = await h.store.inspectCognitiveAppCommandDisclosure(
          { credential: "other-human" },
          inspection,
        );
        assert.equal(result.actor.actantId, "alice-other-human");
        assert.equal(result.command.actor.actantId, "alice-human");
        assert.deepEqual(result.command, admitted.command);
        assert.deepEqual(
          await h.q.all("SELECT * FROM cognitive_app_commands"),
          before,
        );
      }),
  );
  test(
    "Disclosure distinguishes same-principal Agent to Human switch and rejects changed Agent source/executor on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        const admitted = await h.store.admitCognitiveAppCommand(
          agent,
          command(),
        );
        h.checkCallbackDepth = true;
        h.callbackDepths.length = 0;
        const original = await h.store.inspectCognitiveAppCommandDisclosure(
          agent,
          inspection,
        );
        assert.deepEqual(original.actor, admitted.command.actor);
        const before = await h.q.all("SELECT * FROM cognitive_app_commands");
        h.identities.set("agent", { ...h.identities.get("alice")! });
        const changed = await h.store.inspectCognitiveAppCommandDisclosure(
          agent,
          inspection,
        );
        assert.equal(changed.actor.kind, "human");
        assert.equal(changed.actor.principalId, original.actor.principalId);
        assert.notDeepEqual(changed.actor, original.actor);
        assert.deepEqual(changed.command, original.command);
        h.identities.set("agent", {
          tenantId: "tenant-a",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-two",
          initiatingHumanActantId: "alice-human",
          scopeProjectId: "project-a",
        });
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(agent, inspection),
          denied("forbidden"),
        );
        h.identities.set("agent", {
          ...h.identities.get("agent")!,
          runtimeInputId: "input-one",
          scopeProjectId: "project-b",
        });
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(agent, inspection),
          denied("forbidden"),
        );
        h.identities.set("agent", {
          ...h.identities.get("agent")!,
          scopeProjectId: "project-a",
        });
        await h.q.change(
          "DELETE FROM project_members WHERE principal_id='agent-service' AND project_id='project-a'",
        );
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(agent, inspection),
          denied("forbidden"),
        );
        assert.deepEqual(
          await h.q.all("SELECT * FROM cognitive_app_commands"),
          before,
        );
        assert.ok(h.callbackDepths.every((depth) => depth === 0));
      }),
  );
  test(
    "Disclosure current membership/actual actant and immutable old command project remain authoritative on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        const admitted = await h.store.admitCognitiveAppCommand(
          human,
          command(),
        );
        await h.q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a','bob')",
        );
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(
            { credential: "bob" },
            inspection,
          ),
          denied("forbidden"),
        );
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(human, {
            ...inspection,
            projectId: "project-b",
          }),
          denied("not_found"),
        );
        h.actants.set("alice-human", { principalId: "bob", kind: "human" });
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(human, inspection),
          denied("forbidden"),
        );
        h.actants.set("alice-human", { principalId: "alice", kind: "human" });
        await h.q.change(
          "UPDATE app_installations SET state='disabled' WHERE app_id='example.notes'",
        );
        await h.q.change(
          "UPDATE app_instances SET state='disabled' WHERE app_id='example.notes'",
        );
        await h.q.change(
          "UPDATE cognitive_app_connections SET state='disabled' WHERE connection_id='conn-alice'",
        );
        await h.q.change(
          "UPDATE projects SET archived_at=? WHERE project_id='project-a'",
          [now],
        );
        assert.deepEqual(
          (
            await h.store.inspectCognitiveAppCommandDisclosure(
              human,
              inspection,
            )
          ).command,
          admitted.command,
        );
        await h.q.change(
          "DELETE FROM project_members WHERE principal_id='alice' AND project_id='project-a'",
        );
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(human, inspection),
          denied("forbidden"),
        );
      }),
  );
  test(
    "Disclosure real persisted Platform prepared task-run retains its original source independently of current grant on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        await h.store.createTask(human, {
          commandId: "create-task",
          taskId: "disclosure-task",
          projectId: "project-a",
          title: "Inspect original fact",
          assigneeId: "agent-one",
          now,
        });
        const admission = await h.store.requestTaskRun(agent, {
          commandId: "run-task",
          taskId: "disclosure-task",
          expectedRevision: 1,
          sessionId: "disclosure-session",
          intent: "Write once",
          notBefore: now,
          now,
        });
        const runtimeTaskRun = {
          sessionId: admission.sessionId,
          scheduleId: admission.request.id,
          eventId: admission.eventId,
        };
        h.identities.set("scheduled", {
          ...h.identities.get("agent")!,
          runtimeTaskRun,
        });
        const admitted = await h.store.admitCognitiveAppCommand(
          { credential: "scheduled" },
          command(),
        );
        await h.store.changeCognitiveAppGrant(human, {
          appId: definition.id,
          version: definition.version,
          expectedRevision: 1,
          state: "disabled",
          now,
        });
        h.checkCallbackDepth = true;
        h.callbackDepths.length = 0;
        const calls = h.resolveCalls;
        const disclosure = await h.store.inspectCognitiveAppCommandDisclosure(
          { credential: "scheduled" },
          inspection,
        );
        assert.deepEqual(disclosure.actor, admitted.command.actor);
        assert.equal(disclosure.actor.source.kind, "task-run");
        assert.equal(h.resolveCalls, calls + 1);
        const humanRead = await h.store.inspectCognitiveAppCommandDisclosure(
          human,
          inspection,
        );
        assert.equal(humanRead.actor.kind, "human");
        assert.equal(humanRead.command.actor.source.kind, "task-run");
        h.identities.set("scheduled", {
          ...h.identities.get("scheduled")!,
          runtimeTaskRun: { ...runtimeTaskRun, eventId: "spoofed-event" },
        });
        await assert.rejects(
          h.store.inspectCognitiveAppCommandDisclosure(
            { credential: "scheduled" },
            inspection,
          ),
          denied("forbidden"),
        );
        assert.ok(h.callbackDepths.every((depth) => depth === 0));
      }),
  );
}
