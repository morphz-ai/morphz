import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { Application } from "../packages/application/src/application.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import { parseCognitiveAppApplicationTarget } from "../packages/core/src/cognitive-app-application-target.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import { platformHistorySchema } from "../apps/web/src/platform-client.js";
import {
  postgresQuery,
  sqliteQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";
import { storedData } from "./platform-local-input-fixture.js";

const baseDefinition = JSON.parse(
  readFileSync(
    new URL("../examples/cognitive-notes/definition.json", import.meta.url),
    "utf8",
  ),
);
type Domains = Awaited<ReturnType<typeof openApplicationDomainsHost>>;
const record = (value: unknown) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const rows = (store: WorkspaceStore) =>
  record(store.runtimeState()).deliveries as Record<string, unknown>[];

/** Actual Human/Platform/SQL policy and durable delivery. Runtime HTTP/model
 * capabilities are controlled here; no actual Rust/Harness installation is claimed. */
async function fixture(
  backend: "sqlite" | "postgres",
  harness: boolean = true,
) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-target-"));
  const schema = "cognitive_target_" + randomUUID().replaceAll("-", "");
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : undefined;
  let admin: PoolClient | undefined, metadata: DatabaseSync | undefined;
  let posts = 0;
  let acceptRuntime = false;
  const sessions = new Map<string, Record<string, unknown>>();
  const threads = new Map<string, Record<string, unknown>>();
  const roots = new Map<
    string,
    { sessionId: string; event: Record<string, unknown> }
  >();
  const attempts: Record<string, unknown>[] = [];
  const definition = parseCognitiveAppDefinition({
    ...baseDefinition,
    ui: null,
    harness: harness ? { id: "example.notes-harness", version: "1.0.0" } : null,
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? record(JSON.parse(Buffer.concat(chunks).toString()))
      : undefined;
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    const sid = path.split("/")[3]!;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (acceptRuntime) {
      if (path === "/api/sessions" && request.method === "POST") {
        const session = {
          id: body!.id,
          context_id: record(body!.mount).context_id,
          permission_mode: null,
        };
        sessions.set(String(body!.id), session);
        return send(201, session);
      }
      if (sessions.has(sid) && request.method === "PATCH") {
        const session = {
          ...sessions.get(sid),
          permission_mode: body!.permission_mode,
        };
        sessions.set(sid, session);
        return send(200, session);
      }
      if (path.endsWith("/principal"))
        return send(200, {
          ...sessions.get(sid),
          session_id: sid,
          principal_id: "controlled-human",
          capabilities: ["session_turn_control"],
        });
      if (path.includes("/threads/")) {
        const thread = threads.get(path.split("/").at(-1)!);
        return send(thread ? 200 : 404, { snapshot: { thread } });
      }
      if (path.endsWith("/scheduler"))
        return send(200, {
          threads: [...threads.values()].map((thread) => ({
            thread,
            phase: "running",
          })),
        });
      if (path.endsWith("/io/messages")) {
        posts++;
        attempts.push(body!);
        const id = String(body!.client_message_id),
          activation = record(body!.activation);
        const eventId =
          (activation.input_destination ? "steering-" : "root-") + id;
        if (!activation.input_destination)
          threads.set("thread-" + id, {
            id: "thread-" + id,
            root_turn_id: eventId,
            session_id: sid,
            context_id: sessions.get(sid)!.context_id,
            initiating_principal_id: "controlled-human",
            generation: 1,
            revision: 1,
            executor_kind: "self",
            control_state: "active",
            lifecycle: "open",
            kind: "dialogue_turn",
            updated_at: new Date().toISOString(),
          });
        roots.set(id, {
          sessionId: sid,
          event: {
            id: eventId,
            sequence: roots.size + 1,
            timestamp: new Date().toISOString(),
            actor: "Session-Client",
            type: "session_message",
            topic: activation.input_destination
              ? "chat/steering"
              : "chat/user_message",
            payload: {
              session_id: sid,
              context_id: sessions.get(sid)!.context_id,
              principal_id: "controlled-human",
              client_message_id: id,
              session_io: {
                request: {
                  ...body,
                  client_metadata: storedData(body!.client_metadata),
                  message: {
                    ...record(body!.message),
                    content: {
                      ...record(record(body!.message).content),
                      value: storedData(
                        record(record(body!.message).content).value,
                      ),
                    },
                  },
                },
              },
            },
          },
        });
        return send(200, { accepted: true, event_id: eventId });
      }
      if (path.endsWith("/timeline"))
        return send(200, {
          entries: [...roots.entries()]
            .filter(([, root]) => root.sessionId === sid)
            .map(([inputId, root]) => ({
              entry_id: inputId,
              visible_at: root.event.timestamp,
              visible_at_micros:
                Date.parse(String(root.event.timestamp)) * 1000,
              root_turn_id: root.event.id,
              attempt_id: null,
              display_kind: "input",
              final_event: true,
              event: root.event,
              root_event: null,
            })),
          next_before: null,
        });
      if (path.endsWith("/events")) return send(200, { events: [] });
      if (path === "/api/approvals") return send(200, { approvals: [] });
      if (sessions.has(sid)) return send(200, sessions.get(sid));
    }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/status")
      response.end(JSON.stringify({ model: "controlled" }));
    else if (request.url === "/api/runtime/inference")
      response.end(
        JSON.stringify({ model: "controlled", models: ["controlled"] }),
      );
    else if (request.url === "/api/session-io/capabilities")
      response.end(
        JSON.stringify({
          enabled: true,
          client_metadata: true,
          directed_input: true,
          formats: ["4", "11", "12"].map((version) => ({
            definition: { id: "morphz.application.input", version },
          })),
          harnesses: harness ? [definition.harness] : [],
        }),
      );
    else if (request.method === "POST") {
      posts++;
      response.writeHead(500);
      response.end("{}");
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let store!: WorkspaceStore,
    domains!: Domains,
    runtime!: RuntimeBridge,
    app!: Application;
  let binding!: ReturnType<Domains["bindRuntime"]>;
  const open = async () => {
    store = new WorkspaceStore(join(directory, "transport.sqlite"), {
      mode: "transport",
    });
    domains = await openApplicationDomainsHost(
      directory,
      store,
      undefined,
      pool
        ? {
            platform: {
              kind: "postgres",
              connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
              schema,
            },
          }
        : {},
    );
    runtime = new RuntimeBridge(
      store,
      {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        token: "controlled-test-only",
        namespace: "application-target",
      },
      undefined,
      false,
    );
    await runtime.stop();
    binding = domains.bindRuntime(runtime);
    app = new Application(store, {
      runtime,
      platformWork: domains.work,
      platformDocuments: domains.content,
      cognitiveApps: domains.cognitiveApps,
    });
  };
  const closeHandles = async () => {
    await runtime?.stop();
    if (binding && domains) await domains.unbindRuntime(binding.authority);
    await domains?.close();
    store?.close();
  };
  const close = async () => {
    await closeHandles();
    metadata?.close();
    admin?.release();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    if (pool) {
      assert.ok(process.env.MORPHZ_TEST_POSTGRES_URL);
      await pool.query(`CREATE SCHEMA "${schema}"`);
    }
    await open();
    let q: SqlQuery;
    if (pool) {
      admin = await pool.connect();
      await admin.query(`SET search_path TO "${schema}",pg_catalog`);
      q = postgresQuery(admin);
    } else {
      metadata = new DatabaseSync(join(directory, "platform.sqlite"));
      metadata.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(metadata);
    }
    await app.session(localAccess).createPlatformProject({
      commandId: randomUUID(),
      projectId: "project_exact",
      title: "TEST explicit application",
    });
    const withActor = <T>(
      call: (
        platform: Domains["content"]["platform"],
        actor: { credential: string },
      ) => Promise<T>,
    ) =>
      domains.content.authority.withSession(
        localAccess,
        () => {},
        (actor) => call(domains.content.platform, actor),
      );
    const installed = await withActor((platform, actor) =>
      platform.installCognitiveApp(actor, { definition }),
    );
    await withActor((platform, actor) =>
      platform.changeCognitiveAppGrant(actor, {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 0,
        state: "active",
      }),
    );
    const connection = await withActor((platform, actor) =>
      platform.createVerifiedCognitiveAppConnection(actor, {
        connectionId: "connection_exact",
        expectedRevision: 0,
        proof: {
          purpose: "connection-setup",
          appId: definition.id,
          version: definition.version,
          definitionHash: installed.definitionHash,
          serviceId: "service/notes",
          dataAuthorityId: "database:notes",
          hostBindingId: "metadata_fixture_only",
        },
      }),
    );
    const target = parseCognitiveAppApplicationTarget({
      connectionId: connection.connectionId,
      authority: {
        appId: definition.id,
        version: definition.version,
        definitionHash: installed.definitionHash,
        instanceId: connection.instanceId,
        serviceId: connection.serviceId,
        dataAuthorityId: connection.dataAuthorityId,
      },
    });
    const command = (id = randomUUID()) => ({
      commandId: id,
      operation: {
        type: "record-input" as const,
        projectId: "project_exact",
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "Explicit headless application context",
        targetActantId: morphzAgentAccess.actantId,
        cognitiveApplication: structuredClone(target),
      },
    });
    const enableRuntime = async () => {
      await runtime.stop();
      await domains.unbindRuntime(binding.authority);
      runtime = new RuntimeBridge(
        store,
        {
          url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          token: "controlled-test-only",
          namespace: "application-target",
        },
        undefined,
        false,
      );
      binding = domains.bindRuntime(runtime);
      app = new Application(store, {
        runtime,
        platformWork: domains.work,
        platformDocuments: domains.content,
        cognitiveApps: domains.cognitiveApps,
      });
      acceptRuntime = true;
      runtime.start();
      await runtime.tick();
    };
    return {
      target,
      definition,
      command,
      q,
      withActor,
      attempts,
      roots,
      get store() {
        return store;
      },
      get runtime() {
        return runtime;
      },
      get posts() {
        return posts;
      },
      session: () => app.session(localAccess),
      enableRuntime,
      reopen: async () => {
        await closeHandles();
        await open();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(`explicit headless context snapshots, preserves pending typed history and cold retry on ${backend}`, async () => {
    const f = await fixture(backend);
    try {
      assert.deepEqual(
        await f.q.all(
          "SELECT content_id FROM content_entries WHERE tenant_id=? AND app_id=?",
          [f.store.identity(), f.definition.id],
        ),
        [],
      );
      const command = f.command();
      const expected = structuredClone(f.target);
      const pending = f.session().platformMessage(command);
      (
        command.operation.cognitiveApplication.authority as {
          serviceId: string;
        }
      ).serviceId = "mutated-after-call";
      await pending;
      const row = rows(f.store)[0]!;
      const request = record(row.request),
        source = record(row.platformSource);
      assert.deepEqual(source.cognitiveApplication, expected);
      assert.deepEqual(source.application, {
        instanceId: expected.authority.instanceId,
        id: expected.authority.appId,
        version: expected.authority.version,
        harness: f.definition.harness,
      });
      assert.equal(record(record(request.message).format).version, "11");
      const value = record(record(record(request.message).content).value);
      assert.deepEqual(value.cognitiveApplication, expected);
      assert.equal(value.cognitiveObject, null);
      assert.deepEqual(
        record(request.activation).harness,
        f.definition.harness,
      );
      const history = await f.runtime.platformConversationHistory(
        { projectId: "project_exact", conversationId: "project_exact" },
        localAccess,
      );
      assert.deepEqual(
        platformHistorySchema.parse(history).inputs[0]!.cognitiveApplication,
        expected,
      );
      const bytes = JSON.stringify(request);
      await f.reopen();
      await f.session().platformMessage(f.command(command.commandId));
      assert.equal(rows(f.store).length, 1);
      assert.equal(JSON.stringify(rows(f.store)[0]!.request), bytes);
      assert.equal(f.posts, 0);
    } finally {
      await f.close();
    }
  });

  test(`nullable declared Harness fixes context without inventing activation on ${backend}`, async () => {
    const f = await fixture(backend, false);
    try {
      await f.session().platformMessage(f.command());
      const row = rows(f.store)[0]!;
      assert.equal(
        record(record(row.platformSource).application).harness,
        null,
      );
      assert.equal(record(record(row.request).activation).harness, undefined);
    } finally {
      await f.close();
    }
  });

  test(`current consent, connection and project gate prevent fresh and first-dispatch effects on ${backend}`, async () => {
    const f = await fixture(backend);
    try {
      const command = f.command();
      await f.session().platformMessage(command);
      await f.withActor((platform, actor) =>
        platform.changeCognitiveAppGrant(actor, {
          appId: f.definition.id,
          version: f.definition.version,
          expectedRevision: 1,
          state: "disabled",
        }),
      );
      await assert.rejects(f.session().platformMessage(f.command()));
      await assert.rejects(
        f.runtime.as(localAccess, () =>
          f.runtime.retryPlatformInput(command.commandId),
        ),
      );
      await f.enableRuntime();
      await f.runtime.tick();
      await f.runtime.stop();
      assert.equal(rows(f.store)[0]!.state, "failed");
      assert.equal(
        f.posts,
        0,
        "Current withdrawal is checked before any controlled Runtime POST",
      );
      await f.withActor((platform, actor) =>
        platform.changeCognitiveAppGrant(actor, {
          appId: f.definition.id,
          version: f.definition.version,
          expectedRevision: 2,
          state: "active",
        }),
      );
      await f.withActor((platform, actor) =>
        platform.changeCognitiveAppConnectionState(actor, {
          appId: f.definition.id,
          version: f.definition.version,
          connectionId: f.target.connectionId,
          expectedRevision: 1,
          state: "disabled",
        }),
      );
      await assert.rejects(
        f.runtime.as(localAccess, () =>
          f.runtime.retryPlatformInput(command.commandId),
        ),
      );
      await f.withActor((platform, actor) =>
        platform.changeCognitiveAppConnectionState(actor, {
          appId: f.definition.id,
          version: f.definition.version,
          connectionId: f.target.connectionId,
          expectedRevision: 2,
          state: "active",
        }),
      );
      await f.q.change(
        "DELETE FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
        [f.store.identity(), "project_exact", localAccess.principalId],
      );
      await assert.rejects(f.session().platformMessage(f.command()));
      assert.equal(rows(f.store).length, 1);
      assert.equal(f.posts, 0);
    } finally {
      await f.close();
    }
  });

  test(`whole explicit authority and matching original are exact, never two selectors on ${backend}`, async () => {
    const f = await fixture(backend);
    try {
      let accessorCalls = 0;
      const unsafe = f.command();
      Object.defineProperty(unsafe.operation, "cognitiveApplication", {
        enumerable: true,
        get() {
          accessorCalls++;
          throw new Error("caller-secret");
        },
      });
      await assert.rejects(f.session().platformMessage(unsafe));
      assert.equal(accessorCalls, 0);
      for (const field of [
        "appId",
        "instanceId",
        "serviceId",
        "dataAuthorityId",
        "definitionHash",
        "version",
      ] as const) {
        const command = f.command();
        (
          command.operation.cognitiveApplication.authority as Record<
            string,
            string
          >
        )[field] =
          field === "definitionHash"
            ? "0".repeat(64)
            : field === "version"
              ? "2.0.0"
              : field === "appId"
                ? "example.other"
                : "other";
        await assert.rejects(f.session().platformMessage(command));
      }
      const locator = parseCognitiveAppObjectLocator({
        contentId: "content_exact",
        projectId: "project_exact",
        ...f.target,
        object: {
          objectId: "original/笔记",
          versionRef: "0009007199254740993\nold😀",
        },
      });
      const now = new Date().toISOString();
      await f.q.change(
        "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'note','Exact original','newer-head',?,'available',1,?,?)",
        [
          f.store.identity(),
          locator.contentId,
          f.definition.id,
          f.target.authority.instanceId,
          locator.object.objectId,
          locator.projectId,
          now,
          now,
          now,
        ],
      );
      const base = f.command();
      await f.session().platformMessage({
        ...base,
        operation: { ...base.operation, cognitiveObject: locator },
      });
      assert.equal(
        record(record(record(rows(f.store)[0]!.request).message).format)
          .version,
        "12",
      );
      for (const additions of [
        { application: { id: f.definition.id, version: f.definition.version } },
        { applicationInstanceId: f.target.authority.instanceId },
        { cognitiveObject: { ...locator, connectionId: "other" } },
        {
          continuation: {
            mode: "supplement",
            inputId: base.commandId,
            threadId: "thread",
            generation: 1,
          },
        },
      ])
        await assert.rejects(
          f.session().platformMessage({
            ...f.command(),
            operation: { ...f.command().operation, ...additions },
          }),
        );
      assert.equal(rows(f.store).length, 1);
    } finally {
      await f.close();
    }
  });

  test(`controlled accepted Runtime source preserves target and supplements inherit exact context on ${backend}`, async () => {
    const f = await fixture(backend);
    try {
      const first = f.command();
      await f.session().platformMessage(first);
      await f.enableRuntime();
      const deadline = Date.now() + 5000;
      while (
        !rows(f.store).some(
          (row) => row.inputId === first.commandId && row.rootId,
        )
      ) {
        assert.ok(
          Date.now() < deadline,
          "Controlled Runtime must acknowledge original: " +
            JSON.stringify(
              rows(f.store).map(({ state, error }) => ({ state, error })),
            ),
        );
        await f.runtime.tick();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const supplement = {
        commandId: randomUUID(),
        operation: {
          ...first.operation,
          cognitiveApplication: undefined,
          body: "Only supplement the original context",
          continuation: {
            mode: "supplement",
            inputId: first.commandId,
            threadId: "thread-" + first.commandId,
            generation: 1,
          },
        },
      };
      await f.session().platformMessage(supplement);
      const row = rows(f.store).find(
        (entry) => entry.inputId === supplement.commandId,
      )!;
      assert.deepEqual(
        record(row.platformSource).cognitiveApplication,
        f.target,
      );
      assert.deepEqual(
        record(row.platformSource).application,
        record(rows(f.store)[0]!.platformSource).application,
      );
      const request = record(row.request);
      assert.equal(record(request.activation).harness, undefined);
      assert.deepEqual(
        record(record(record(request.message).content).value)
          .cognitiveApplication,
        f.target,
      );
      assert.equal(record(record(request.message).format).version, "11");
      const before = f.attempts.length,
        bytes = JSON.stringify(request);
      await f.session().platformMessage(supplement);
      assert.equal(f.attempts.length, before);
      assert.equal(
        JSON.stringify(
          rows(f.store).find((entry) => entry.inputId === supplement.commandId)!
            .request,
        ),
        bytes,
      );
      const history = await f.runtime.platformConversationHistory(
        { projectId: "project_exact", conversationId: "project_exact" },
        localAccess,
      );
      assert.deepEqual(
        platformHistorySchema
          .parse(history)
          .inputs.map((value) => value.cognitiveApplication),
        [f.target, f.target],
      );
      const originalRoot = f.roots.get(first.commandId)!;
      const acceptedRequest = record(
        record(record(originalRoot.event.payload).session_io).request,
      );
      const oldVisible = acceptedRequest.message;
      const message = record(oldVisible),
        content = record(message.content);
      // Controlled accepted metadata is not an actual Rust proof. Its negative
      // projection witness checks complete visible/source agreement only.
      const currentWholeValue = record(
        record(record(record(rows(f.store)[0]!.request).message).content).value,
      );
      acceptedRequest.message = {
        ...message,
        content: {
          ...content,
          value: storedData({
            ...currentWholeValue,
            cognitiveApplication: { ...f.target, connectionId: "different" },
          }),
        },
      };
      const rejected = await f.runtime.platformConversationHistory(
        { projectId: "project_exact", conversationId: "project_exact" },
        localAccess,
      );
      assert.ok(!rejected.inputs.some((value) => value.id === first.commandId));
      acceptedRequest.message = oldVisible;
      const oldFormat = message.format;
      message.format = { id: "morphz.application.input", version: "10" };
      const wrongFormat = await f.runtime.platformConversationHistory(
        { projectId: "project_exact", conversationId: "project_exact" },
        localAccess,
      );
      assert.ok(
        !wrongFormat.inputs.some((value) => value.id === first.commandId),
      );
      message.format = oldFormat;
    } finally {
      await f.close();
    }
  });
}
