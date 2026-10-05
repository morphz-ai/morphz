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
import {
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../packages/core/src/cognitive-app-object-locator.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import {
  postgresQuery,
  sqliteQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";

const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const original = {
  objectId: "original/笔记:001",
  versionRef: "0009007199254740993:old😀",
};
type Domains = Awaited<ReturnType<typeof openApplicationDomainsHost>>;

/** Real Human ingress, shared current authority, SQLite/PG catalog and durable
 * Host outbox. Only model/capability HTTP is controlled; no author original
 * or actual Runtime acceptance is claimed by this metadata-policy layer. */
async function fixture(backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-input-"));
  const schema = "cognitive_input_" + randomUUID().replaceAll("-", "");
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : undefined;
  let admin: PoolClient | undefined, metadata: DatabaseSync | undefined;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/status")
      response.end(JSON.stringify({ model: "controlled" }));
    else if (request.url === "/api/runtime/inference")
      response.end(
        JSON.stringify({ model: "controlled", models: ["controlled"] }),
      );
    else {
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
    store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
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
        token: "test-only",
        namespace: "input-provenance",
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
      title: "TEST exact input",
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
          hostBindingId: "isolated_metadata_only",
        },
      }),
    );
    const locator = parseCognitiveAppObjectLocator({
      contentId: "content_exact",
      projectId: "project_exact",
      connectionId: connection.connectionId,
      authority: {
        appId: definition.id,
        version: definition.version,
        definitionHash: installed.definitionHash,
        instanceId: connection.instanceId,
        serviceId: connection.serviceId,
        dataAuthorityId: connection.dataAuthorityId,
      },
      object: original,
    });
    const now = new Date().toISOString();
    await q.change(
      "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'note','Actual metadata','newer-head',?,'available',1,?,?)",
      [
        store.identity(),
        locator.contentId,
        definition.id,
        connection.instanceId,
        original.objectId,
        locator.projectId,
        now,
        now,
        now,
      ],
    );
    const command = (
      cognitiveObject: CognitiveAppObjectLocator = locator,
      commandId = randomUUID(),
    ) => ({
      commandId,
      operation: {
        type: "record-input" as const,
        projectId: locator.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "Discuss the exact old original",
        targetActantId: morphzAgentAccess.actantId,
        cognitiveObject,
      },
    });
    return {
      locator,
      command,
      q,
      withActor,
      get store() {
        return store;
      },
      get domains() {
        return domains;
      },
      get runtime() {
        return runtime;
      },
      session() {
        return app.session(localAccess);
      },
      async reopen() {
        await closeHandles();
        await open();
      },
      async close() {
        await closeHandles();
        metadata?.close();
        admin?.release();
        if (pool) {
          await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
          await pool.end();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await closeHandles();
    metadata?.close();
    admin?.release();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
type Ledger = {
  deliveries: Array<{
    inputId: string;
    state: string;
    platformSource: {
      cognitiveObject?: CognitiveAppObjectLocator;
      application?: unknown;
    };
    request: {
      message: {
        format: { version: string };
        content: { value: { cognitiveObject?: CognitiveAppObjectLocator } };
      };
      client_metadata: {
        source: { cognitiveObject?: CognitiveAppObjectLocator };
      };
      activation: { harness?: unknown };
    };
  }>;
};

for (const backend of ["sqlite", "postgres"] as const) {
  test(`actual Human ingress persists opaque original, pending history and cold retry without head substitution on ${backend}`, async () => {
    const f = await fixture(backend);
    try {
      const command = f.command();
      await f.session().platformMessage(command);
      const state = f.store.runtimeState() as Ledger;
      const row = state.deliveries[0]!;
      assert.deepEqual(row.platformSource.cognitiveObject, f.locator);
      assert.deepEqual(
        row.request.message.content.value.cognitiveObject,
        f.locator,
      );
      assert.deepEqual(
        row.request.client_metadata.source.cognitiveObject,
        f.locator,
      );
      assert.equal(row.request.message.format.version, "10");
      assert.equal(row.platformSource.application, undefined);
      assert.equal(
        row.request.activation.harness,
        undefined,
        "A reference alone never activates author Harness",
      );
      const originalBytes = JSON.stringify(row.request);
      assert.deepEqual(
        (
          await f.runtime.platformConversationHistory(
            {
              projectId: f.locator.projectId,
              conversationId: f.locator.projectId,
            },
            localAccess,
          )
        ).inputs[0]!.cognitiveObject,
        f.locator,
      );
      await f.reopen();
      await f.session().platformMessage(command);
      const after = f.store.runtimeState() as Ledger;
      assert.equal(after.deliveries.length, 1);
      assert.equal(JSON.stringify(after.deliveries[0]!.request), originalBytes);
      for (const candidate of [
        { ...f.locator, contentId: "other" },
        { ...f.locator, connectionId: "other" },
        {
          ...f.locator,
          authority: { ...f.locator.authority, instanceId: "other" },
        },
        {
          ...f.locator,
          authority: { ...f.locator.authority, serviceId: "other" },
        },
        {
          ...f.locator,
          authority: { ...f.locator.authority, dataAuthorityId: "other" },
        },
        {
          ...f.locator,
          authority: { ...f.locator.authority, definitionHash: "0".repeat(64) },
        },
        { ...f.locator, object: { ...f.locator.object, objectId: "other" } },
        {
          ...f.locator,
          object: { ...f.locator.object, versionRef: "another-original" },
        },
      ])
        await assert.rejects(
          f.session().platformMessage(f.command(candidate, command.commandId)),
        );
      assert.equal(
        JSON.stringify(
          (f.store.runtimeState() as Ledger).deliveries[0]!.request,
        ),
        originalBytes,
      );
    } finally {
      await f.close();
    }
  });
  test(`actual current consent, exact catalog and application tuple gate rejects fresh and queued input on ${backend}`, async () => {
    const f = await fixture(backend);
    try {
      const command = f.command();
      await f.session().platformMessage(command);
      for (const application of [
        { id: "morphz.objects", version: "1.0.0" },
        { id: definition.id, version: "2.0.0" },
      ])
        await assert.rejects(
          f.session().platformMessage({
            ...f.command(),
            operation: { ...f.command().operation, application },
          }),
        );
      await f.withActor((platform, actor) =>
        platform.changeCognitiveAppGrant(actor, {
          appId: definition.id,
          version: definition.version,
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
      await f.withActor((platform, actor) =>
        platform.changeCognitiveAppGrant(actor, {
          appId: definition.id,
          version: definition.version,
          expectedRevision: 2,
          state: "active",
        }),
      );
      await f.withActor((platform, actor) =>
        platform.changeCognitiveAppConnectionState(actor, {
          appId: definition.id,
          version: definition.version,
          connectionId: f.locator.connectionId,
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
          appId: definition.id,
          version: definition.version,
          connectionId: f.locator.connectionId,
          expectedRevision: 2,
          state: "active",
        }),
      );
      await f.q.change(
        "UPDATE content_entries SET availability='deleted' WHERE content_id=?",
        [f.locator.contentId],
      );
      await assert.rejects(f.session().platformMessage(f.command()));
      assert.equal((f.store.runtimeState() as Ledger).deliveries.length, 1);
    } finally {
      await f.close();
    }
  });
  test(`actual admission snapshots before await, strict supplement and foreign catalog/owner do not retarget on ${backend}`, async () => {
    const f = await fixture(backend);
    try {
      const raw = f.command(structuredClone(f.locator));
      const pending = f.session().platformMessage(raw);
      (
        raw.operation.cognitiveObject.object as { versionRef: string }
      ).versionRef = "mutated-after-call";
      await pending;
      assert.deepEqual(
        (f.store.runtimeState() as Ledger).deliveries[0]!.platformSource
          .cognitiveObject,
        f.locator,
      );
      await assert.rejects(
        f.session().platformMessage({
          ...f.command(),
          operation: {
            ...f.command().operation,
            continuation: {
              mode: "supplement",
              inputId: raw.commandId,
              threadId: "thread",
              generation: 1,
            },
          },
        }),
      );
      await f.q.change(
        "DELETE FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
        [f.store.identity(), f.locator.projectId, localAccess.principalId],
      );
      await assert.rejects(f.session().platformMessage(f.command()));
      await assert.rejects(
        f.runtime.as(localAccess, () =>
          f.runtime.retryPlatformInput(raw.commandId),
        ),
      );
      assert.equal((f.store.runtimeState() as Ledger).deliveries.length, 1);
    } finally {
      await f.close();
    }
  });
}
