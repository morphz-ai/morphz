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
  type UiPackageVersion,
} from "../packages/platform/src/store.js";
import {
  verifyCognitiveAppUiBytes,
  type CognitiveAppUiByteProof,
} from "../packages/platform/src/cognitive-app-ui-proof.js";
import { uiPackageHeader } from "../packages/core/src/applications.js";
import { parseBrowserNavigationState } from "../packages/cognitive-app-sdk/src/browser-wire.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";

const now = "2026-10-05T00:00:00.000Z";
const human = { credential: "alice" },
  bob = { credential: "bob" },
  agent = { credential: "agent" };
const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const denied = (code: string) => (error: unknown) => {
  assert.ok(error instanceof PlatformStorageError);
  assert.equal(error.code, code);
  return true;
};
type Harness = {
  store: PlatformStore;
  q: SqlQuery;
  onIdentity: (() => void) | null;
  callbackDepths: number[];
  checkCallbackDepth: boolean;
  setRuntimeSource(
    credential: string,
    identity: NonNullable<
      Awaited<ReturnType<PlatformAuthorityVerifier["resolveActor"]>>
    >,
  ): void;
  reopen(): Promise<void>;
};
async function isolated(
  backend: "sqlite" | "postgres",
  run: (h: Harness) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-gui-views-"));
  const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : null;
  let store: PlatformStore | undefined,
    database: DatabaseSync | undefined,
    releaseAdmin: (() => void) | undefined;
  let depth = 0,
    h!: Harness;
  const callbackDepths: number[] = [];
  // Deliberately isolated Runtime authority fixture, not a live Runtime claim.
  // The actual source record is persisted and read by the verifier outside q;
  // task-run admission below is additionally the real Platform durable chain.
  const sourceDatabase = new DatabaseSync(
    join(directory, "runtime-authority-fixture.sqlite"),
  );
  sourceDatabase.exec(
    "CREATE TABLE sources(credential TEXT PRIMARY KEY,identity_json TEXT NOT NULL)",
  );
  const setRuntimeSource = (
    credential: string,
    identity: NonNullable<
      Awaited<ReturnType<PlatformAuthorityVerifier["resolveActor"]>>
    >,
  ) =>
    sourceDatabase
      .prepare(
        "INSERT INTO sources VALUES(?,?) ON CONFLICT(credential) DO UPDATE SET identity_json=excluded.identity_json",
      )
      .run(credential, JSON.stringify(identity));
  setRuntimeSource("agent", {
    tenantId: "tenant-a",
    principalId: "alice",
    actantId: "agent-one",
    kind: "agent",
    runtimeInputId: "input-one",
    initiatingHumanActantId: "alice-human",
    scopeProjectId: "project-a",
  });
  const callback = () => {
    callbackDepths.push(depth);
    if (h?.checkCallbackDepth !== false)
      assert.equal(depth, 0, "Identity verification must happen outside SQL.");
  };
  const verifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      callback();
      h?.onIdentity?.();
      const source = sourceDatabase
        .prepare("SELECT identity_json FROM sources WHERE credential=?")
        .get(credential);
      if (source) return JSON.parse(source.identity_json as string);
      if (
        credential !== "alice" &&
        credential !== "bob" &&
        credential !== "agent"
      )
        return null;
      return {
        tenantId: "tenant-a",
        principalId: credential === "bob" ? "bob" : "alice",
        actantId: credential === "agent" ? "agent-one" : `${credential}-human`,
        kind: credential === "agent" ? "agent" : "human",
        runtimeInputId: credential === "agent" ? "input-one" : null,
        ...(credential === "agent"
          ? {
              initiatingHumanActantId: "alice-human",
              scopeProjectId: "project-a",
            }
          : {}),
      };
    },
    async resolveActant({ tenantId, actantId }) {
      callback();
      if (tenantId === "tenant-a" && actantId === "agent-one")
        return { principalId: "agent-service", kind: "agent" };
      return tenantId === "tenant-a" &&
        (actantId === "alice-human" || actantId === "bob-human")
        ? {
            principalId: actantId === "alice-human" ? "alice" : "bob",
            kind: "human" as const,
          }
        : null;
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
    const open = () =>
      pool
        ? PlatformStore.postgres(
            { connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!, schema },
            verifier,
          )
        : PlatformStore.sqlite(join(directory, "platform.sqlite"), verifier);
    if (pool) {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      store = await open();
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}",pg_catalog`);
      q = postgresQuery(client);
      releaseAdmin = () => client.release();
    } else {
      store = await open();
      database = new DatabaseSync(join(directory, "platform.sqlite"));
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(database);
    }
    const observe = (target: PlatformStore) => {
      const transaction = Reflect.get(target, "transaction").bind(target);
      Reflect.set(
        target,
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
    };
    observe(store);
    h = {
      store,
      q,
      onIdentity: null,
      callbackDepths,
      checkCallbackDepth: true,
      setRuntimeSource,
      async reopen() {
        await store!.close();
        store = await open();
        observe(store);
        h.store = store;
      },
    };
    await store.provisionTenant("tenant-a", now);
    for (const projectId of ["project-a", "project-b"]) {
      await q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a',?,'project','alice',?,1,?,?)",
        [projectId, projectId, now, now],
      );
      for (const principalId of ["alice", "bob", "agent-service"])
        await q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a',?,?)",
          [projectId, principalId],
        );
    }
    await run(h);
  } finally {
    releaseAdmin?.();
    await store?.close();
    database?.close();
    sourceDatabase.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
function packageManifest(
  version = "1.0.0",
  permissions: Array<"input.compose" | "artifacts.read" | "artifacts.write"> = [
    "input.compose",
  ],
) {
  return {
    format: "morphz-app/v1" as const,
    id: "example.notes",
    version,
    title: "Notes",
    description: "Independent notes",
    icon: "book" as const,
    permissions,
    harness: null,
    ui: {
      type: "sandbox" as const,
      html: "<!doctype html><title>Notes</title><main>Author interface</main>",
    },
  };
}
function guiDefinition(sha256: string, version = "1.0.0") {
  const manifest = packageManifest(version);
  return {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: manifest.id,
    version,
    title: manifest.title,
    description: manifest.description,
    icon: manifest.icon,
    harness: null,
    ui: { packageVersion: version, sha256 },
    operations: [
      {
        id: "notes.read",
        title: "Read",
        description: "Read authorized project",
        effect: "read",
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
  };
}
async function installed(
  h: Harness,
  version = "1.0.0",
  access = human,
  register = true,
) {
  const manifest = packageManifest(version);
  // Isolated fixture evidence: actual HTML bytes and actual Platform UI row.
  // This is not the Managed Store's publish/read-back acceptance owned by Host.
  const bytes = Buffer.from(manifest.ui.html, "utf8");
  const storeVersion = {
    storeId: "store-ui",
    artifactId: `ui-${version.replaceAll(".", "-")}`,
    revision: 1,
    sha256: digest(bytes),
    byteLength: bytes.byteLength,
  };
  const header = uiPackageHeader(manifest);
  if (register)
    await h.store.installUiPackage(access, {
      commandId: `install-${version.replaceAll(".", "-")}`,
      header,
      storeVersion,
      now,
    });
  const entry: UiPackageVersion = register
    ? await h.store.uiPackage(access, manifest.id, version)
    : {
        appId: manifest.id,
        version,
        installedByPrincipalId: access.credential,
        header,
        storeId: storeVersion.storeId,
        artifactId: storeVersion.artifactId,
        artifactRevision: 1,
        sha256: storeVersion.sha256,
        byteLength: storeVersion.byteLength,
        installedAt: now,
      };
  const definition = guiDefinition(storeVersion.sha256, version);
  const stored = { ...storeVersion, mime: "text/html;charset=utf-8" };
  const proof: CognitiveAppUiByteProof = verifyCognitiveAppUiBytes({
    tenantId: "tenant-a",
    principalId: access.credential,
    definition,
    entry,
    stored,
    bytes,
  });
  return { manifest, bytes, storeVersion, entry, definition, stored, proof };
}

async function connected(
  h: Harness,
  access = human,
  version = "1.0.0",
  suffix = "one",
) {
  const fixture = await installed(h, version);
  const declaration = await h.store.installCognitiveApp(human, {
    definition: fixture.definition,
    verifiedUi: fixture.proof,
    now,
  });
  await h.store.changeCognitiveAppGrant(access, {
    appId: "example.notes",
    version,
    expectedRevision: 0,
    state: "active",
    now,
  });
  const connection = await h.store.createVerifiedCognitiveAppConnection(
    access,
    await prepareConnectionCreation(h.store, access, {
      proof: {
        purpose: "connection-setup",
        appId: "example.notes",
        version,
        definitionHash: declaration.definitionHash,
        serviceId: "service/notes",
        dataAuthorityId: "database:notes",
        hostBindingId: "host_private_alias",
      },
      connectionId: "conn-" + access.credential + "-" + suffix,
      expectedRevision: 0,
      now,
    }),
  );
  return { fixture, declaration, connection };
}
async function connectedWithLegacy(
  h: Harness,
  commandId: string,
  state: { view: string },
) {
  // A retained UI-only window predates its exact cognitive declaration. Build
  // that history through the real APIs, not by bypassing the classifier or
  // inserting a synthetic window row.
  await installed(h);
  assert.deepEqual(await h.q.all("SELECT * FROM cognitive_app_versions"), []);
  const legacyRequest = {
    commandId,
    projectId: "project-a",
    appId: "example.notes",
    packageVersion: "1.0.0",
    state,
    now,
  };
  const legacy = await h.store.launchAppView(human, legacyRequest);
  assert.equal(legacy.id, commandId);
  assert.equal(legacy.revision, 1);
  assert.deepEqual(legacy.state, state);
  const original = await h.q.all(
    "SELECT * FROM app_view_instances ORDER BY tenant_id,view_id",
  );
  const connection = await connected(h);
  assert.deepEqual(
    await h.q.all(
      "SELECT * FROM app_view_instances ORDER BY tenant_id,view_id",
    ),
    original,
  );
  assert.deepEqual(
    await h.q.all("SELECT * FROM cognitive_app_view_bindings"),
    [],
  );
  // Once declared, even this still-unbound old window cannot be launched via
  // the UI-only entry. The explicit bind/conversion paths below remain required.
  await assert.rejects(
    h.store.launchAppView(human, {
      ...legacyRequest,
      commandId: `${commandId}-after-declaration`,
    }),
    denied("forbidden"),
  );
  assert.deepEqual(
    await h.q.all(
      "SELECT * FROM app_view_instances ORDER BY tenant_id,view_id",
    ),
    original,
  );
  return { ...connection, legacy };
}
const launch = (commandId = "view-one", connectionId = "conn-alice-one") => ({
  commandId,
  projectId: "project-a",
  appId: "example.notes",
  version: "1.0.0",
  connectionId,
  expectedViewRevision: 0,
  expectedBindingRevision: 0,
  now,
});
async function object(
  h: Harness,
  instanceId: string,
  objectId = "note-one",
  projectId = "project-a",
) {
  await h.q.change(
    "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES('tenant-a',?,'example.notes',?,?,?,'note','Original','head',?,'available',1,?,?)",
    ["content-" + objectId, instanceId, objectId, projectId, now, now, now],
  );
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    "Cognitive window missing ports launch/read/CAS state/frame/close on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const c = await connected(h);
        const opened = await h.store.launchCognitiveAppView(human, launch());
        assert.deepEqual(opened, {
          receipt: { viewId: "view-one", viewRevision: 1, bindingRevision: 1 },
          replayed: false,
        });
        const metadata = await h.store.readCognitiveAppView(human, {
          viewId: "view-one",
        });
        assert.equal(metadata.view.revision, 1);
        assert.equal(metadata.binding?.revision, 1);
        await object(h, c.connection.instanceId);
        const saved = await h.store.changeCognitiveAppView(human, {
          commandId: "save-one",
          viewId: "view-one",
          expectedViewRevision: 1,
          expectedBindingRevision: 1,
          state: {
            object: { objectId: "note-one", versionRef: "older/exact" },
            view: "detail",
          },
          now,
        });
        assert.equal(saved.receipt.viewRevision, 2);
        const frame = await h.store.prepareCognitiveAppUiRead(human, {
          viewId: "view-one",
          expectedViewRevision: 2,
          expectedBindingRevision: 1,
        });
        assert.equal(frame.uiPackage.installedByPrincipalId, "alice");
        assert.equal(
          parseBrowserNavigationState(frame.view.state).object?.versionRef,
          "older/exact",
        );
        const closed = await h.store.changeCognitiveAppView(human, {
          commandId: "close-one",
          viewId: "view-one",
          expectedViewRevision: 2,
          expectedBindingRevision: 1,
          close: true,
          now,
        });
        assert.equal(closed.receipt.viewRevision, 3);
        assert.equal(
          (await h.store.readCognitiveAppView(human, { viewId: "view-one" }))
            .view.status,
          "closed",
        );
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, {
            viewId: "view-one",
            expectedViewRevision: 3,
            expectedBindingRevision: 1,
          }),
          denied("conflict"),
        );
        const reopen = await h.store.launchCognitiveAppView(human, {
          ...launch("reopen"),
          expectedViewRevision: 3,
          expectedBindingRevision: 1,
        });
        assert.equal(reopen.receipt.viewId, "view-one");
        assert.equal(reopen.receipt.viewRevision, 4);
        assert.ok(h.callbackDepths.every((x) => x === 0));
      }),
  );
  test(
    "Cognitive window bind missing port reuses exact legacy view without legacy mutation on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const { legacy } = await connectedWithLegacy(h, "legacy", {
          view: "old",
        });
        const bound = await h.store.bindCognitiveAppView(human, {
          commandId: "bind-one",
          viewId: legacy.id,
          projectId: "project-a",
          appId: "example.notes",
          version: "1.0.0",
          connectionId: "conn-alice-one",
          expectedViewRevision: 1,
          expectedBindingRevision: 0,
          now,
        });
        assert.equal(bound.receipt.viewRevision, 2);
        assert.deepEqual(
          (await h.store.readCognitiveAppView(human, { viewId: legacy.id }))
            .view.state,
          {},
        );
        await assert.rejects(
          h.store.changeAppView(human, {
            commandId: "legacy-change",
            viewId: legacy.id,
            expectedRevision: 2,
            close: true,
            now,
          }),
          denied("forbidden"),
        );
        await assert.rejects(
          h.store.launchAppView(human, {
            commandId: "legacy-open",
            projectId: "project-a",
            appId: "example.notes",
            packageVersion: "1.0.0",
            state: {},
            now,
          }),
          denied("forbidden"),
        );
      }),
  );
  test(
    "Cognitive GUI explicit revoke replay keeps original acknowledgment and close needs no consent on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        const openRequest = launch(),
          opened = await h.store.launchCognitiveAppView(human, openRequest);
        const savedRequest = {
          commandId: "save-one",
          viewId: "view-one",
          expectedViewRevision: 1,
          expectedBindingRevision: 1,
          state: { view: "detail" },
          now,
        };
        const saved = await h.store.changeCognitiveAppView(human, savedRequest);
        await h.store.changeCognitiveAppGrant(human, {
          appId: "example.notes",
          version: "1.0.0",
          expectedRevision: 1,
          state: "disabled",
          now,
        });
        await h.store.changeCognitiveAppConnectionState(human, {
          appId: "example.notes",
          version: "1.0.0",
          connectionId: "conn-alice-one",
          expectedRevision: 1,
          state: "disabled",
          now,
        });
        const before = await h.q.all("SELECT * FROM app_view_instances"),
          receipts = await h.q.all("SELECT * FROM command_receipts");
        assert.deepEqual(
          await h.store.launchCognitiveAppView(human, openRequest),
          { ...opened, replayed: true },
        );
        assert.deepEqual(
          await h.store.changeCognitiveAppView(human, savedRequest),
          { ...saved, replayed: true },
        );
        assert.deepEqual(
          await h.q.all("SELECT * FROM app_view_instances"),
          before,
        );
        assert.deepEqual(
          await h.q.all("SELECT * FROM command_receipts"),
          receipts,
        );
        await assert.rejects(
          h.store.launchCognitiveAppView(human, {
            ...openRequest,
            connectionId: "changed",
          }),
          denied("conflict"),
        );
        await assert.rejects(
          h.store.changeCognitiveAppView(human, {
            ...savedRequest,
            state: { view: "different" },
          }),
          denied("conflict"),
        );
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, {
            viewId: "view-one",
            expectedViewRevision: 2,
            expectedBindingRevision: 1,
          }),
          denied("forbidden"),
        );
        await assert.rejects(
          h.store.changeCognitiveAppView(human, {
            commandId: "save-revoked",
            viewId: "view-one",
            expectedViewRevision: 2,
            expectedBindingRevision: 1,
            state: { view: "detail" },
            now,
          }),
          denied("forbidden"),
        );
        const close = await h.store.changeCognitiveAppView(human, {
          commandId: "close-revoked",
          viewId: "view-one",
          expectedViewRevision: 2,
          expectedBindingRevision: 1,
          close: true,
          now,
        });
        assert.equal(close.receipt.viewRevision, 3);
        assert.equal(
          (await h.store.readCognitiveAppView(human, { viewId: "view-one" }))
            .binding?.revision,
          1,
        );
        await h.q.change(
          "DELETE FROM project_members WHERE principal_id='alice' AND project_id='project-a'",
        );
        await assert.rejects(
          h.store.launchCognitiveAppView(human, openRequest),
          denied("forbidden"),
        );
        await assert.rejects(
          h.store.readCognitiveAppView(human, { viewId: "view-one" }),
          denied("forbidden"),
        );
      }),
  );
  test(
    "Cognitive GUI retarget clears navigation and old binding request never reaches new authority on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const c = await connected(h);
        await object(h, c.connection.instanceId);
        const opened = await h.store.launchCognitiveAppView(human, launch());
        await h.store.changeCognitiveAppView(human, {
          commandId: "save-one",
          viewId: "view-one",
          expectedViewRevision: 1,
          expectedBindingRevision: 1,
          state: {
            object: { objectId: "note-one", versionRef: "historical-opaque" },
            view: "edit",
          },
          now,
        });
        const second = await h.store.createVerifiedCognitiveAppConnection(
          human,
          await prepareConnectionCreation(h.store, human, {
            proof: {
              purpose: "connection-setup",
              appId: "example.notes",
              version: "1.0.0",
              definitionHash: c.declaration.definitionHash,
              serviceId: "other-service",
              dataAuthorityId: "other-data",
              hostBindingId: "other_alias",
            },
            connectionId: "conn-second",
            expectedRevision: 0,
            now,
          }),
        );
        assert.notEqual(second.instanceId, c.connection.instanceId);
        const request = {
          ...launch("retarget", "conn-second"),
          viewId: "view-one",
          expectedViewRevision: 2,
          expectedBindingRevision: 1,
        };
        const bound = await h.store.bindCognitiveAppView(human, request);
        assert.deepEqual(bound.receipt, {
          viewId: "view-one",
          viewRevision: 3,
          bindingRevision: 2,
        });
        const metadata = await h.store.readCognitiveAppView(human, {
          viewId: "view-one",
        });
        assert.deepEqual(metadata.view.state, {});
        assert.equal(metadata.binding?.instanceId, second.instanceId);
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, {
            viewId: "view-one",
            expectedViewRevision: 2,
            expectedBindingRevision: 1,
          }),
          denied("conflict"),
        );
        await assert.rejects(
          h.store.changeCognitiveAppView(human, {
            commandId: "stale-save",
            viewId: "view-one",
            expectedViewRevision: 2,
            expectedBindingRevision: 1,
            state: { view: "stale" },
            now,
          }),
          denied("conflict"),
        );
        assert.deepEqual(
          await h.store.launchCognitiveAppView(human, launch()),
          { ...opened, replayed: true },
        );
        assert.deepEqual(await h.store.bindCognitiveAppView(human, request), {
          ...bound,
          replayed: true,
        });
        assert.deepEqual(
          (await h.store.readCognitiveAppView(human, { viewId: "view-one" }))
            .view.state,
          {},
        );
        const noOp = await h.store.bindCognitiveAppView(human, {
          ...request,
          commandId: "same-target",
          expectedViewRevision: 3,
          expectedBindingRevision: 2,
        });
        assert.deepEqual(noOp.receipt, bound.receipt);
      }),
  );
  test(
    "Cognitive GUI own grant enables shared exact UI but never legacy byte ownership on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h, bob);
        const open = await h.store.launchCognitiveAppView(
          bob,
          launch("bob-view", "conn-bob-one"),
        );
        const frame = await h.store.prepareCognitiveAppUiRead(bob, {
          viewId: "bob-view",
          expectedViewRevision: 1,
          expectedBindingRevision: 1,
        });
        assert.equal(frame.actor.principalId, "bob");
        assert.equal(frame.uiPackage.installedByPrincipalId, "alice");
        assert.equal(frame.binding.connectionId, "conn-bob-one");
        assert.equal(
          JSON.stringify(frame).includes("host_private_alias"),
          false,
        );
        await assert.rejects(
          h.store.uiPackage(bob, "example.notes", "1.0.0"),
          denied("not_found"),
        );
        assert.deepEqual(await h.store.listUiPackages(bob), []);
        for (const access of [human, agent]) {
          await assert.rejects(
            h.store.prepareCognitiveAppUiRead(access, {
              viewId: "bob-view",
              expectedViewRevision: 1,
              expectedBindingRevision: 1,
            }),
            denied(access === agent ? "forbidden" : "not_found"),
          );
          await assert.rejects(
            h.store.readCognitiveAppView(access, { viewId: "bob-view" }),
            denied(access === agent ? "forbidden" : "not_found"),
          );
        }
        assert.equal(open.receipt.viewRevision, 1);
        await h.q.change(
          "DELETE FROM project_members WHERE principal_id='bob' AND project_id='project-a'",
        );
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(bob, {
            viewId: "bob-view",
            expectedViewRevision: 1,
            expectedBindingRevision: 1,
          }),
          denied("forbidden"),
        );
      }),
  );
  test(
    "Cognitive GUI navigation rejects body unsafe JSON cross-project and unavailable objects with atomic rollback on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const c = await connected(h);
        await h.store.launchCognitiveAppView(human, launch());
        await object(h, c.connection.instanceId, "foreign", "project-b");
        await object(h, c.connection.instanceId, "gone");
        await h.q.change(
          "UPDATE content_entries SET availability='unavailable' WHERE app_object_id='gone'",
        );
        const before = await h.q.all("SELECT * FROM app_view_instances"),
          receiptCount = (await h.q.all("SELECT * FROM command_receipts"))
            .length;
        for (const [state, code] of [
          [{ body: "private draft" }, "invalid"],
          [{ view: "x".repeat(101) }, "invalid"],
          [{ object: { objectId: "note", versionRef: 2 } }, "invalid"],
          [{ object: { objectId: "note", versionRef: "\u0000" } }, "invalid"],
          [{ object: { objectId: "note", versionRef: "\ud800" } }, "invalid"],
          [{ object: { objectId: "missing", versionRef: "v1" } }, "not_found"],
          [{ object: { objectId: "foreign", versionRef: "v1" } }, "forbidden"],
          [{ object: { objectId: "gone", versionRef: "v1" } }, "not_found"],
          [{ view: undefined }, "invalid"],
        ] as const)
          await assert.rejects(
            h.store.changeCognitiveAppView(human, {
              commandId: "bad-" + code,
              viewId: "view-one",
              expectedViewRevision: 1,
              expectedBindingRevision: 1,
              state: state as never,
              now,
            }),
            denied(code),
          );
        assert.deepEqual(
          await h.q.all("SELECT * FROM app_view_instances"),
          before,
        );
        assert.equal(
          (await h.q.all("SELECT * FROM command_receipts")).length,
          receiptCount,
        );
        const cyclic: any = {};
        cyclic.view = cyclic;
        await assert.rejects(
          h.store.changeCognitiveAppView(human, {
            commandId: "cycle",
            viewId: "view-one",
            expectedViewRevision: 1,
            expectedBindingRevision: 1,
            state: cyclic,
            now,
          }),
          denied("invalid"),
        );
        await object(h, c.connection.instanceId, "合法/\n note");
        await h.store.changeCognitiveAppView(human, {
          commandId: "exact-history",
          viewId: "view-one",
          expectedViewRevision: 1,
          expectedBindingRevision: 1,
          state: {
            object: {
              objectId: "合法/\n note",
              versionRef: " very old/\n ref ",
            },
            view: "detail",
          },
          now,
        });
        const frame = await h.store.prepareCognitiveAppUiRead(human, {
          viewId: "view-one",
          expectedViewRevision: 2,
          expectedBindingRevision: 1,
        });
        assert.equal(
          parseBrowserNavigationState(frame.view.state).object?.versionRef,
          " very old/\n ref ",
        );
        // No App history existence claim was made by this catalog gate.
      }),
  );
  test(
    "Cognitive GUI concurrent CAS/replay and new version unique identity remain explicit on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        const results = await Promise.all([
          h.store.launchCognitiveAppView(human, launch()),
          h.store.launchCognitiveAppView(human, launch()),
        ]);
        assert.equal(results.filter((r) => r.replayed).length, 1);
        const saves = await Promise.allSettled(
          ["one", "two"].map((id) =>
            h.store.changeCognitiveAppView(human, {
              commandId: "save-" + id,
              viewId: "view-one",
              expectedViewRevision: 1,
              expectedBindingRevision: 1,
              state: { view: id },
              now,
            }),
          ),
        );
        assert.equal(saves.filter((r) => r.status === "fulfilled").length, 1);
        const rejected = saves.find(
          (r) => r.status === "rejected",
        ) as PromiseRejectedResult;
        assert.equal(rejected.reason.code, "conflict");
        const f = await installed(h, "2.0.0");
        await h.store.installCognitiveApp(human, {
          definition: f.definition,
          verifiedUi: f.proof,
          now,
        });
        await h.store.changeCognitiveAppGrant(human, {
          appId: "example.notes",
          version: "2.0.0",
          expectedRevision: 0,
          state: "active",
          now,
        });
        const next = await h.store.launchCognitiveAppView(human, {
          ...launch("view-two"),
          version: "2.0.0",
        });
        assert.equal(next.receipt.viewId, "view-two");
        assert.equal(
          (await h.store.readCognitiveAppView(human, { viewId: "view-one" }))
            .view.applicationVersion,
          "1.0.0",
        );
        await assert.rejects(
          h.store.bindCognitiveAppView(human, {
            ...launch("bad-version"),
            viewId: "view-one",
            version: "2.0.0",
            expectedViewRevision: 2,
            expectedBindingRevision: 1,
          }),
          denied("conflict"),
        );
        await h.reopen();
        assert.equal(
          (await h.store.readCognitiveAppView(human, { viewId: "view-two" }))
            .binding?.revision,
          1,
        );
      }),
  );
  test(
    "Cognitive GUI state/scalar snapshot precedes actual identity await on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const c = await connected(h);
        await object(h, c.connection.instanceId);
        await h.store.launchCognitiveAppView(human, launch());
        const state = {
          object: { objectId: "note-one", versionRef: "original-history" },
          view: "original",
        };
        const request = {
          commandId: "snapshot",
          viewId: "view-one",
          expectedViewRevision: 1,
          expectedBindingRevision: 1,
          state,
          now,
        };
        h.onIdentity = () => {
          request.viewId = "foreign";
          request.expectedBindingRevision = 999;
          state.object.versionRef = "modified";
          state.view = "modified";
          h.onIdentity = null;
        };
        const saved = await h.store.changeCognitiveAppView(human, request);
        assert.equal(saved.receipt.viewId, "view-one");
        assert.deepEqual(
          (await h.store.readCognitiveAppView(human, { viewId: "view-one" }))
            .view.state,
          {
            object: { objectId: "note-one", versionRef: "original-history" },
            view: "original",
          },
        );
      }),
  );
  test(
    "Cognitive description actual Human persisted input/task source needs own consent not UI or connection on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const definition = { ...guiDefinition("a".repeat(64)), ui: null };
        const version = await h.store.installCognitiveApp(human, {
          definition,
          now,
        });
        await h.store.changeCognitiveAppGrant(human, {
          appId: "example.notes",
          version: "1.0.0",
          expectedRevision: 0,
          state: "active",
          now,
        });
        const request = {
          projectId: "project-a",
          appId: "example.notes",
          version: "1.0.0",
          expectedDefinitionHash: version.definitionHash,
          expectedGrantRevision: 1,
        };
        const resolved = await h.store.resolveCognitiveAppDescription(
          human,
          request,
        );
        assert.equal(resolved.definition.ui, null);
        assert.equal(resolved.definitionHash, version.definitionHash);
        assert.deepEqual(
          (await h.store.resolveCognitiveAppDescription(agent, request)).actor
            .source,
          { kind: "input", inputId: "input-one", humanActantId: "alice-human" },
        );
        await assert.rejects(
          h.store.resolveCognitiveAppDescription(agent, {
            ...request,
            projectId: "project-b",
          }),
          denied("forbidden"),
        );
        await assert.rejects(
          h.store.resolveCognitiveAppDescription(bob, request),
          denied("forbidden"),
        );
        await assert.rejects(
          h.store.resolveCognitiveAppDescription(human, {
            ...request,
            expectedDefinitionHash: "b".repeat(64),
          }),
          denied("conflict"),
        );
        const source = {
          tenantId: "tenant-a",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent" as const,
          runtimeInputId: "input-one",
          initiatingHumanActantId: "alice-human",
          scopeProjectId: "project-a",
        };
        h.setRuntimeSource("bad-source", {
          ...source,
          initiatingHumanActantId: "bob-human",
        });
        await assert.rejects(
          h.store.resolveCognitiveAppDescription(
            { credential: "bad-source" },
            request,
          ),
          denied("forbidden"),
        );
        assert.ok(h.callbackDepths.every((x) => x === 0));
        h.checkCallbackDepth = false; // Older task-creation verifier path is outside this stage.
        await h.store.createTask(human, {
          commandId: "create-task",
          taskId: "schema-task",
          projectId: "project-a",
          title: "Schema task",
          assigneeId: "agent-one",
          now,
        });
        const admission = await h.store.requestTaskRun(agent, {
          commandId: "run-task",
          taskId: "schema-task",
          expectedRevision: 1,
          sessionId: "schema-session",
          intent: "Read exact schema",
          notBefore: now,
          now,
        });
        const runtimeTaskRun = {
          sessionId: admission.sessionId,
          scheduleId: admission.request.id,
          eventId: admission.eventId,
        };
        h.setRuntimeSource("scheduled", { ...source, runtimeTaskRun });
        h.checkCallbackDepth = true;
        h.callbackDepths.length = 0;
        assert.deepEqual(
          (
            await h.store.resolveCognitiveAppDescription(
              { credential: "scheduled" },
              request,
            )
          ).actor.source,
          {
            kind: "task-run",
            ...runtimeTaskRun,
            sourceInputId: "input-one",
            humanActantId: "alice-human",
          },
        );
        await assert.rejects(
          h.store.launchCognitiveAppView({ credential: "scheduled" }, launch()),
          denied("forbidden"),
        );
        h.setRuntimeSource("scheduled", {
          ...source,
          runtimeTaskRun: { ...runtimeTaskRun, eventId: "spoofed-event" },
        });
        await assert.rejects(
          h.store.resolveCognitiveAppDescription(
            { credential: "scheduled" },
            request,
          ),
          denied("forbidden"),
        );
        await h.q.change(
          "DELETE FROM project_members WHERE project_id='project-a' AND principal_id='agent-service'",
        );
        await assert.rejects(
          h.store.resolveCognitiveAppDescription(agent, request),
          denied("forbidden"),
        );
        await h.store.changeCognitiveAppGrant(human, {
          appId: "example.notes",
          version: "1.0.0",
          expectedRevision: 1,
          state: "disabled",
          now,
        });
        await assert.rejects(
          h.store.resolveCognitiveAppDescription(human, request),
          denied("forbidden"),
        );
        for (const relation of [
          "app_ui_packages",
          "app_view_instances",
          "cognitive_app_connections",
        ])
          assert.deepEqual(await h.q.all("SELECT * FROM " + relation), []);
        assert.ok(h.callbackDepths.every((x) => x === 0));
      }),
  );
  test(
    "Cognitive GUI immutable bytes row/dead target/navigation gate is checked before and after await on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const c = await connected(h);
        await object(h, c.connection.instanceId);
        await h.store.launchCognitiveAppView(human, launch());
        const request = {
          viewId: "view-one",
          expectedViewRevision: 1,
          expectedBindingRevision: 1,
        };
        await h.store.prepareCognitiveAppUiRead(human, request);
        await h.q.change("UPDATE app_ui_packages SET sha256=?", [
          "b".repeat(64),
        ]);
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, request),
          denied("conflict"),
        );
        await h.q.change("UPDATE app_ui_packages SET sha256=?", [
          c.fixture.storeVersion.sha256,
        ]);
        await h.q.change(
          "UPDATE app_instances SET state='disabled' WHERE instance_id=?",
          [c.connection.instanceId],
        );
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, request),
          denied("forbidden"),
        );
        await h.q.change(
          "UPDATE app_instances SET state='active' WHERE instance_id=?",
          [c.connection.instanceId],
        );
        await h.q.change("UPDATE app_view_instances SET state_json=?", [
          JSON.stringify({ body: "must not leak" }),
        ]);
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, request),
          denied("conflict"),
        );
        await assert.rejects(
          h.store.readCognitiveAppView(human, { viewId: "view-one" }),
          denied("conflict"),
        );
        await h.q.change("UPDATE app_view_instances SET state_json='{}'");
        h.onIdentity = () => {
          request.viewId = "other";
          request.expectedBindingRevision = 99;
          h.onIdentity = null;
        };
        const read = await h.store.prepareCognitiveAppUiRead(human, request);
        assert.equal(read.view.id, "view-one");
        assert.equal(read.binding.revision, 1);
        await h.store.changeCognitiveAppConnectionState(human, {
          appId: "example.notes",
          version: "1.0.0",
          connectionId: "conn-alice-one",
          expectedRevision: 1,
          state: "unavailable",
          now,
        });
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, {
            viewId: "view-one",
            expectedViewRevision: 1,
            expectedBindingRevision: 1,
          }),
          denied("forbidden"),
        );
      }),
  );
  test(
    "Cognitive GUI no implicit binding/version/current revisions and no body in durable receipt on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        const { legacy } = await connectedWithLegacy(h, "legacy", {
          view: "legacy",
        });
        assert.equal(
          (await h.store.readCognitiveAppView(human, { viewId: legacy.id }))
            .binding,
          null,
        );
        await assert.rejects(
          h.store.prepareCognitiveAppUiRead(human, {
            viewId: legacy.id,
            expectedViewRevision: 1,
            expectedBindingRevision: 1,
          }),
          denied("conflict"),
        );
        await assert.rejects(
          h.store.launchCognitiveAppView(human, launch()),
          denied("conflict"),
        );
        const request = {
          ...launch("convert"),
          expectedViewRevision: 1,
          expectedBindingRevision: 0,
        };
        const converted = await h.store.launchCognitiveAppView(human, request);
        assert.equal(converted.receipt.viewId, "legacy");
        assert.equal(converted.receipt.viewRevision, 2);
        assert.deepEqual(
          await h.store.launchCognitiveAppView(human, {
            ...request,
            now: "2026-10-06T00:00:00.000Z",
          }),
          { ...converted, replayed: true },
        );
        const stored = (
          await h.q.all<{ result_ref: string }>(
            "SELECT result_ref FROM command_receipts WHERE command_id='convert'",
          )
        )[0]!;
        assert.deepEqual(JSON.parse(stored.result_ref), converted.receipt);
        assert.deepEqual(Object.keys(JSON.parse(stored.result_ref)).sort(), [
          "bindingRevision",
          "viewId",
          "viewRevision",
        ]);
        await assert.rejects(
          h.store.launchCognitiveAppView(bob, request),
          denied("conflict"),
        );
        for (const [viewRev, bindingRev] of [
          [0, 1],
          [-1, 1],
          [2, 0],
          [2, 99],
          [2, 1.5],
          [Number.MAX_SAFE_INTEGER, 1],
        ]) {
          await assert.rejects(
            h.store.prepareCognitiveAppUiRead(human, {
              viewId: "legacy",
              expectedViewRevision: viewRev!,
              expectedBindingRevision: bindingRev!,
            }),
            denied(
              viewRev! < 1 ||
                bindingRev! < 1 ||
                !Number.isSafeInteger(bindingRev) ||
                viewRev === Number.MAX_SAFE_INTEGER
                ? "invalid"
                : "conflict",
            ),
          );
        }
        await h.q.change(
          "UPDATE projects SET archived_at=? WHERE project_id='project-a'",
          [now],
        );
        await assert.rejects(
          h.store.launchCognitiveAppView(human, {
            ...launch("new-after-archive"),
            expectedViewRevision: 2,
            expectedBindingRevision: 1,
          }),
          denied("forbidden"),
        );
        assert.deepEqual(await h.store.launchCognitiveAppView(human, request), {
          ...converted,
          replayed: true,
        });
        const closed = await h.store.changeCognitiveAppView(human, {
          commandId: "close-archived",
          viewId: "legacy",
          expectedViewRevision: 2,
          expectedBindingRevision: 1,
          close: true,
          now,
        });
        assert.equal(closed.receipt.viewRevision, 3);
        assert.equal(
          (await h.store.readCognitiveAppView(human, { viewId: "legacy" })).view
            .status,
          "closed",
        );
      }),
  );
  test(
    "Cognitive GUI headless definitions cannot create a window on " + backend,
    async () =>
      isolated(backend, async (h) => {
        const version = await h.store.installCognitiveApp(human, {
          definition: { ...guiDefinition("a".repeat(64)), ui: null },
          now,
        });
        await h.store.changeCognitiveAppGrant(human, {
          appId: "example.notes",
          version: "1.0.0",
          expectedRevision: 0,
          state: "active",
          now,
        });
        await h.store.createVerifiedCognitiveAppConnection(
          human,
          await prepareConnectionCreation(h.store, human, {
            proof: {
              purpose: "connection-setup",
              appId: "example.notes",
              version: "1.0.0",
              definitionHash: version.definitionHash,
              serviceId: "service",
              dataAuthorityId: "data",
              hostBindingId: "host_alias",
            },
            connectionId: "headless-conn",
            expectedRevision: 0,
            now,
          }),
        );
        await assert.rejects(
          h.store.launchCognitiveAppView(
            human,
            launch("headless", "headless-conn"),
          ),
          denied("invalid"),
        );
        assert.deepEqual(await h.q.all("SELECT * FROM app_view_instances"), []);
        assert.deepEqual(
          await h.q.all("SELECT * FROM cognitive_app_view_bindings"),
          [],
        );
      }),
  );
  test(
    "Cognitive GUI concurrent distinct launch commands preserve one window and capacity bound on " +
      backend,
    async () =>
      isolated(backend, async (h) => {
        await connected(h);
        const candidates = await Promise.allSettled(
          ["one", "two"].map((id) =>
            h.store.launchCognitiveAppView(human, launch("view-" + id)),
          ),
        );
        assert.equal(
          candidates.filter((r) => r.status === "fulfilled").length,
          1,
        );
        assert.equal(
          (
            candidates.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason.code,
          "conflict",
        );
        assert.equal(
          (await h.q.all("SELECT * FROM app_view_instances")).length,
          1,
        );
        assert.equal(
          (await h.q.all("SELECT * FROM cognitive_app_view_bindings")).length,
          1,
        );
        for (let n = 0; n < 99; n++)
          await h.q.change(
            "INSERT INTO app_view_instances(tenant_id,view_id,owner_principal_id,project_id,app_id,package_version,state_json,revision,status,created_at,updated_at) VALUES('tenant-a',?,'alice','project-a','morphz.browser',?,'{}',1,'open',?,?)",
            ["capacity-" + n, "0.0." + n, now, now],
          );
        const f = await installed(h, "2.0.0");
        await h.store.installCognitiveApp(human, {
          definition: f.definition,
          verifiedUi: f.proof,
          now,
        });
        await h.store.changeCognitiveAppGrant(human, {
          appId: "example.notes",
          version: "2.0.0",
          expectedRevision: 0,
          state: "active",
          now,
        });
        await assert.rejects(
          h.store.launchCognitiveAppView(human, {
            ...launch("over-capacity"),
            version: "2.0.0",
          }),
          denied("conflict"),
        );
        assert.equal(
          (await h.q.all("SELECT * FROM app_view_instances")).length,
          100,
        );
        assert.deepEqual(
          await h.q.all(
            "SELECT * FROM command_receipts WHERE command_id='over-capacity'",
          ),
          [],
        );
      }),
  );
  test(
    "Cognitive GUI exact owned connection and legacy concurrent bind fence on " +
      backend,
    async () => {
      await isolated(backend, async (h) => {
        const c = await connected(h);
        await h.store.changeCognitiveAppGrant(bob, {
          appId: "example.notes",
          version: "1.0.0",
          expectedRevision: 0,
          state: "active",
          now,
        });
        await h.store.createVerifiedCognitiveAppConnection(
          bob,
          await prepareConnectionCreation(h.store, bob, {
            proof: {
              purpose: "connection-setup",
              appId: "example.notes",
              version: "1.0.0",
              definitionHash: c.declaration.definitionHash,
              serviceId: "service/notes",
              dataAuthorityId: "database:notes",
              hostBindingId: "host_private_alias",
            },
            connectionId: "conn-bob",
            expectedRevision: 0,
            now,
          }),
        );
        await assert.rejects(
          h.store.launchCognitiveAppView(human, launch("foreign", "conn-bob")),
          denied("not_found"),
        );
        assert.deepEqual(await h.q.all("SELECT * FROM app_view_instances"), []);
        assert.deepEqual(
          await h.q.all("SELECT * FROM cognitive_app_view_bindings"),
          [],
        );
      });
      await isolated(backend, async (h) => {
        const { legacy } = await connectedWithLegacy(h, "legacy-race", {
          view: "legacy",
        });
        const results = await Promise.allSettled([
          h.store.bindCognitiveAppView(human, {
            ...launch("bind-race"),
            viewId: legacy.id,
            expectedViewRevision: 1,
            expectedBindingRevision: 0,
          }),
          h.store.changeAppView(human, {
            commandId: "legacy-race-close",
            viewId: legacy.id,
            expectedRevision: 1,
            close: true,
            now,
          }),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const metadata = await h.store.readCognitiveAppView(human, {
          viewId: legacy.id,
        });
        assert.equal(metadata.view.revision, 2);
        if (metadata.binding) {
          assert.equal(metadata.view.status, "open");
          assert.deepEqual(metadata.view.state, {});
        } else assert.equal(metadata.view.status, "closed");
      });
    },
  );
}
