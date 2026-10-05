import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { UiPackageService } from "../packages/application/src/ui-package-service.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";

const alice = { credential: "alice" },
  bob = { credential: "bob" };
function submission() {
  const html =
    '<!doctype html><meta charset="utf-8"><h1>真正独立的界面 😀</h1>';
  const manifest = {
    format: applicationManifestFormat,
    id: "example.notes",
    version: "1.0.0",
    title: "便笺",
    description: "作者保存原件",
    icon: "document" as const,
    permissions: ["input.compose" as const],
    harness: null,
    ui: { type: "sandbox" as const, html },
  };
  const definition = {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    description: manifest.description,
    icon: manifest.icon,
    harness: null,
    ui: {
      packageVersion: manifest.version,
      sha256: createHash("sha256").update(html).digest("hex"),
    },
    operations: [
      {
        id: "notes.list",
        title: "读取",
        description: "读取已授权原件",
        effect: "read",
        scope: "project",
        inputSchema: { type: "null" },
        outputSchema: { type: "string" },
      },
    ],
  };
  return { manifest, definition };
}
type Fixture = {
  platform: PlatformStore;
  service: UiPackageService;
  q: SqlQuery;
  root: string;
  control: { beforeResolve?: () => Promise<void> };
  reopen(): Promise<void>;
};
async function isolated(
  backend: "sqlite" | "postgres",
  run: (f: Fixture) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "morphz-cognitive-ui-view-service-"));
  const suffix = randomUUID().replaceAll("-", "");
  const platformSchema = `morphz_test_view_platform_${suffix}`,
    byteSchema = `morphz_test_view_bytes_${suffix}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : null;
  const control: Fixture["control"] = {};
  const verifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      await control.beforeResolve?.();
      return credential === "alice" || credential === "bob"
        ? {
            tenantId: "tenant-a",
            principalId: credential,
            actantId: `${credential}-human`,
            kind: "human",
            runtimeInputId: null,
          }
        : null;
    },
    async resolveActant({ actantId }) {
      return actantId === "alice-human" || actantId === "bob-human"
        ? { principalId: actantId.split("-")[0]!, kind: "human" }
        : null;
    },
    async resolveProjectAgent() {
      return null;
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  let platform: PlatformStore | undefined,
    service: UiPackageService | undefined;
  let database: DatabaseSync | undefined, release: (() => void) | undefined;
  const openPlatform = () =>
    pool
      ? PlatformStore.postgres(
          {
            connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
            schema: platformSchema,
          },
          verifier,
        )
      : PlatformStore.sqlite(join(root, "platform.sqlite"), verifier);
  const openService = () =>
    UiPackageService.open({
      tenantId: "tenant-a",
      platform: platform!,
      verifier,
      root: join(root, "ui-bytes"),
      ...(pool
        ? {
            postgres: {
              connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
              schema: byteSchema,
            },
          }
        : {}),
    });
  try {
    if (pool) {
      assert.ok(
        process.env.MORPHZ_TEST_POSTGRES_URL,
        "The formal runner must prepare actual PostgreSQL, never skip it.",
      );
      await pool.query(`CREATE SCHEMA "${platformSchema}"`);
      await pool.query(`CREATE SCHEMA "${byteSchema}"`);
    }
    platform = await openPlatform();
    await platform.provisionTenant("tenant-a");
    service = await openService();
    let q: SqlQuery;
    if (pool) {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${platformSchema}",pg_catalog`);
      q = postgresQuery(client);
      release = () => client.release();
    } else {
      database = new DatabaseSync(join(root, "platform.sqlite"));
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(database);
    }
    // Explicit isolated membership fixture; no Runtime/provider authentication
    // or original user App acceptance is claimed by this byte-service suite.
    await q.change(
      "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','project-a','project','alice','Test UI',1,?,?)",
      [new Date().toISOString(), new Date().toISOString()],
    );
    for (const principalId of ["alice", "bob"])
      await q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a',?)",
        [principalId],
      );
    const f: Fixture = {
      platform,
      service,
      q,
      root,
      control,
      async reopen() {
        await service!.close();
        await platform!.close();
        platform = await openPlatform();
        service = await openService();
        f.platform = platform;
        f.service = service;
      },
    };
    await run(f);
  } finally {
    release?.();
    await service?.close();
    await platform?.close();
    database?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${platformSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${byteSchema}" CASCADE`);
      await pool.end();
    }
    rmSync(root, { recursive: true, force: true });
  }
}
async function prepared(f: Fixture) {
  const input = submission();
  const declaration = await f.service.installCognitive(
    alice,
    "install-original",
    input,
  );
  assert.equal(
    typeof f.service.readCognitive,
    "function",
    "Actual bound-window byte read is missing, not an environment failure.",
  );
  await f.platform.changeCognitiveAppGrant(bob, {
    appId: input.definition.id,
    version: input.definition.version,
    expectedRevision: 0,
    state: "active",
  });
  // Trusted describe proof is an explicit fixture at this Host-only port.
  // Domain Gateway's actual external describe is tested separately.
  await f.platform.createVerifiedCognitiveAppConnection(
    bob,
    await prepareConnectionCreation(f.platform, bob, {
      proof: {
        purpose: "connection-setup",
        appId: input.definition.id,
        version: input.definition.version,
        definitionHash: declaration.definitionHash,
        serviceId: "service/notes",
        dataAuthorityId: "database/notes",
        hostBindingId: "host-private-fixture",
      },
      connectionId: "connection-bob",
      expectedRevision: 0,
    }),
  );
  const launched = await f.platform.launchCognitiveAppView(bob, {
    commandId: "view-bob",
    projectId: "project-a",
    appId: input.definition.id,
    version: input.definition.version,
    connectionId: "connection-bob",
    expectedViewRevision: 0,
    expectedBindingRevision: 0,
  });
  const request = {
    viewId: launched.receipt.viewId,
    expectedViewRevision: launched.receipt.viewRevision,
    expectedBindingRevision: launched.receipt.bindingRevision,
  };
  return { input, request };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(`real bound UI byte Service permits Bob's exact view without relaxing Alice's legacy byte ACL on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const { input, request } = await prepared(f);
      await assert.rejects(
        f.service.read(bob, input.definition.id, input.definition.version),
      );
      const facts = await f.q.all("SELECT * FROM app_ui_packages");
      const result = await f.service.readCognitive(bob, request);
      assert.deepEqual(result.manifest, input.manifest);
      assert.deepEqual(result.definition, input.definition);
      assert.equal(result.view.id, "view-bob");
      assert.equal(result.binding.connectionId, "connection-bob");
      for (const privateName of [
        "actor",
        "uiPackage",
        "installedByPrincipalId",
        "artifactId",
        "storeId",
        "hostBindingId",
        "credential",
      ])
        assert.equal(
          JSON.stringify(result).includes(`\"${privateName}\"`),
          false,
        );
      assert.deepEqual(
        await f.q.all("SELECT * FROM app_ui_packages"),
        facts,
        "Reading never copies or re-installs another byte owner.",
      );
      await f.reopen();
      assert.deepEqual(
        (await f.service.readCognitive(bob, request)).manifest,
        input.manifest,
      );
      await assert.rejects(
        f.service.read(bob, input.definition.id, input.definition.version),
      );
    }));

  test(`real bound UI byte Service rejects foreign/stale/closed/revoked views and rechecks consent before disclosure on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const { request } = await prepared(f);
      for (const invalid of [
        { ...request, expectedViewRevision: request.expectedViewRevision + 1 },
        {
          ...request,
          expectedBindingRevision: request.expectedBindingRevision + 1,
        },
        { ...request, viewId: "missing" },
      ])
        await assert.rejects(f.service.readCognitive(bob, invalid));
      await assert.rejects(f.service.readCognitive(alice, request));
      await assert.rejects(
        f.service.readCognitive({ credential: "agent" }, request),
      );
      const actualGate = f.platform.prepareCognitiveAppUiRead.bind(f.platform);
      let calls = 0;
      f.platform.prepareCognitiveAppUiRead = async (...args) => {
        const value = await actualGate(...args);
        if (++calls === 1)
          await f.platform.changeCognitiveAppGrant(bob, {
            appId: "example.notes",
            version: "1.0.0",
            expectedRevision: 1,
            state: "disabled",
          });
        return value;
      };
      await assert.rejects(f.service.readCognitive(bob, request));
      assert.ok(calls >= 1);
      f.platform.prepareCognitiveAppUiRead = actualGate;
      await f.platform.changeCognitiveAppGrant(bob, {
        appId: "example.notes",
        version: "1.0.0",
        expectedRevision: 2,
        state: "active",
      });
      await f.platform.changeCognitiveAppView(bob, {
        commandId: "close-view",
        ...request,
        close: true,
      });
      await assert.rejects(f.service.readCognitive(bob, request));
    }));

  test(`real bound UI byte Service captures original request and credential before actual async identity work on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const { input, request } = await prepared(f);
      const actor = { credential: "bob" },
        mutable = { ...request };
      let changed = false;
      f.control.beforeResolve = async () => {
        if (changed) return;
        await f.q.all("SELECT * FROM app_ui_packages");
        changed = true;
        actor.credential = "alice";
        mutable.viewId = "wrong-view";
        mutable.expectedBindingRevision = 900;
      };
      assert.deepEqual(
        (await f.service.readCognitive(actor, mutable)).manifest,
        input.manifest,
      );
      assert.ok(changed);
      f.control.beforeResolve = undefined;
      let getters = 0;
      const hostile = Object.defineProperty({ ...request }, "private", {
        enumerable: true,
        get() {
          getters++;
          throw new Error("PRIVATE untrusted getter");
        },
      });
      await assert.rejects(f.service.readCognitive(bob, hostile));
      assert.equal(getters, 0);
    }));

  test(`real bound UI byte Service withholds bytes when consent changes after the actual Store read on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const { input, request } = await prepared(f);
      const actualGate = f.platform.prepareCognitiveAppUiRead.bind(f.platform);
      let calls = 0;
      f.platform.prepareCognitiveAppUiRead = async (...args) => {
        const value = await actualGate(...args);
        // Initial gate=1, Store ingress=2, actual post-byte Store confirmation=3.
        // Inject after the third actual gate, not a fake byte-read response. The
        // final Service disclosure gate must still refuse those retained bytes.
        if (++calls === 3)
          await f.platform.changeCognitiveAppGrant(bob, {
            appId: "example.notes",
            version: "1.0.0",
            expectedRevision: 1,
            state: "disabled",
          });
        return value;
      };
      await assert.rejects(f.service.readCognitive(bob, request));
      assert.equal(
        calls,
        3,
        "The fourth actual gate refuses the now-disabled consent.",
      );
      assert.equal(
        Reflect.get(f.service, "scopes").size,
        0,
        "An unsuccessful read retires its private capability.",
      );
      f.platform.prepareCognitiveAppUiRead = actualGate;
      await f.platform.changeCognitiveAppGrant(bob, {
        appId: "example.notes",
        version: "1.0.0",
        expectedRevision: 2,
        state: "active",
      });
      assert.deepEqual(
        (await f.service.readCognitive(bob, request)).manifest,
        input.manifest,
      );
      assert.equal(Reflect.get(f.service, "scopes").size, 0);
    }));

  test(`real bound UI byte Service refuses corrupted retained blob bytes without modifying the installation on ${backend}`, async () =>
    isolated(backend, async (f) => {
      const { request } = await prepared(f);
      const original = await f.q.all<{ sha256: string }>(
        "SELECT * FROM app_ui_packages",
      );
      const sha = original[0]!.sha256,
        path = join(f.root, "ui-bytes", "blobs", sha.slice(0, 2), sha);
      const bytes = readFileSync(path);
      bytes[0] = bytes[0]! ^ 1;
      writeFileSync(path, bytes);
      await assert.rejects(f.service.readCognitive(bob, request));
      assert.deepEqual(
        await f.q.all("SELECT * FROM app_ui_packages"),
        original,
      );
    }));
}
