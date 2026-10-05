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
  readCognitiveAppUiByteProof,
  verifyCognitiveAppUiBytes,
  type CognitiveAppUiByteProof,
} from "../packages/platform/src/cognitive-app-ui-proof.js";
import { uiPackageHeader } from "../packages/core/src/applications.js";
import { canonicalJsonBytes } from "../packages/cognitive-app-sdk/src/domain-wire.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
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
  reopen(): Promise<void>;
};
async function isolated(
  backend: "sqlite" | "postgres",
  run: (h: Harness) => Promise<void>,
) {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-cognitive-gui-install-"),
  );
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
  const callback = () => {
    callbackDepths.push(depth);
    assert.equal(depth, 0, "Identity verification must happen outside SQL.");
  };
  const verifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      callback();
      h?.onIdentity?.();
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
      return null;
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
      async reopen() {
        await store!.close();
        store = await open();
        observe(store);
        h.store = store;
      },
    };
    await store.provisionTenant("tenant-a", now);
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
async function nav(h: Harness) {
  return (
    await h.q.all("SELECT * FROM navigation_heads WHERE tenant_id='tenant-a'")
  )[0]!;
}
const installRequest = (
  definition: unknown,
  verifiedUi: unknown,
  at = now,
) => ({ definition, verifiedUi, now: at });

for (const backend of ["sqlite", "postgres"] as const) {
  test(`Cognitive GUI install true bytes proof reuses exact UI installation and notifies once on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      assert.equal(readCognitiveAppUiByteProof(fixture.proof), fixture.proof);
      assert.equal(Object.isFrozen(fixture.proof), true);
      const identity = (
        await h.q.all<{ installation_id: string }>(
          "SELECT installation_id FROM app_installations WHERE app_id='example.notes'",
        )
      )[0]!.installation_id;
      const rows = await h.q.all("SELECT * FROM app_ui_packages");
      const before = await nav(h);
      const version = await h.store.installCognitiveApp(
        human,
        installRequest(fixture.definition, fixture.proof),
      );
      assert.equal(version.installationId, identity);
      assert.match(identity, /^install_ui_/);
      assert.deepEqual(
        version.definition,
        parseCognitiveAppDefinition(fixture.definition),
      );
      assert.equal(
        version.definitionHash,
        digest(canonicalJsonBytes(version.definition)),
      );
      assert.deepEqual(await h.q.all("SELECT * FROM app_ui_packages"), rows);
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
      assert.equal(
        Number((await nav(h)).access_revision),
        Number(before.access_revision) + 1,
      );
      assert.equal(
        (await h.q.all("SELECT * FROM cognitive_app_grants")).length,
        0,
      );
      const repeated = await h.store.installCognitiveApp(
        human,
        installRequest(fixture.definition, fixture.proof),
      );
      assert.deepEqual(repeated, version);
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
      assert.equal(
        JSON.stringify(
          await h.q.all("SELECT * FROM cognitive_app_versions"),
        ).includes(fixture.manifest.ui.html),
        false,
      );
      assert.equal(
        (await h.store.listCognitiveApps(human, { limit: 10 })).versions.length,
        1,
      );
      assert.equal(
        (await h.store.listCognitiveApps(human, { limit: 10 })).versions[0]!
          .grant,
        null,
      );
      assert.ok(h.callbackDepths.every((x) => x === 0));
    }));
  test(`Cognitive GUI install missing cloned serialized inherited and proxy proof cannot grant authority on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const before = await nav(h);
      const installation = await h.q.all("SELECT * FROM app_installations");
      for (const verifiedUi of [
        undefined,
        null,
        { ...fixture.proof },
        JSON.parse(JSON.stringify(fixture.proof)),
        Object.create(fixture.proof),
        new Proxy(fixture.proof, {}),
      ]) {
        await assert.rejects(
          () =>
            h.store.installCognitiveApp(
              human,
              installRequest(fixture.definition, verifiedUi),
            ),
          denied("invalid"),
        );
        assert.deepEqual(await nav(h), before);
        assert.deepEqual(
          await h.q.all("SELECT * FROM app_installations"),
          installation,
        );
        assert.equal(
          (await h.q.all("SELECT * FROM cognitive_app_versions")).length,
          0,
        );
      }
    }));
  test(`Cognitive GUI install actual Human and exact tenant principal definition must match proof on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const before = await nav(h);
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            agent,
            installRequest(fixture.definition, fixture.proof),
          ),
        denied("forbidden"),
      );
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            bob,
            installRequest(fixture.definition, fixture.proof),
          ),
        denied("forbidden"),
      );
      const foreign = verifyCognitiveAppUiBytes({
        tenantId: "tenant-b",
        principalId: "alice",
        definition: fixture.definition,
        entry: fixture.entry,
        stored: fixture.stored,
        bytes: fixture.bytes,
      });
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(fixture.definition, foreign),
          ),
        denied("forbidden"),
      );
      const other = {
        ...fixture.definition,
        operations: [{ ...fixture.definition.operations[0]!, effect: "write" }],
      };
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(other, fixture.proof),
          ),
        denied("conflict"),
      );
      assert.equal(
        (await h.q.all("SELECT * FROM cognitive_app_versions")).length,
        0,
      );
      assert.deepEqual(await nav(h), before);
    }));
  test(`Cognitive GUI install proof must match actual immutable UI metadata in same SQL on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const before = await nav(h);
      const cases: Array<[string, unknown, unknown]> = [
        ["installed_by_principal_id", "bob", "alice"],
        ["store_id", "different-store", fixture.entry.storeId],
        ["artifact_id", "different-artifact", fixture.entry.artifactId],
        ["artifact_revision", 2, 1],
        ["sha256", "0".repeat(64), fixture.entry.sha256],
        ["byte_length", fixture.entry.byteLength + 1, fixture.entry.byteLength],
        [
          "manifest_header",
          JSON.stringify({ ...fixture.entry.header, title: "Changed title" }),
          JSON.stringify(fixture.entry.header),
        ],
      ];
      for (const [column, bad, original] of cases) {
        await h.q.change(
          `UPDATE app_ui_packages SET ${column}=? WHERE app_id='example.notes'`,
          [bad as string | number],
        );
        await assert.rejects(
          () =>
            h.store.installCognitiveApp(
              human,
              installRequest(fixture.definition, fixture.proof),
            ),
          denied(
            column === "installed_by_principal_id" ? "forbidden" : "conflict",
          ),
        );
        assert.equal(
          (await h.q.all("SELECT * FROM cognitive_app_versions")).length,
          0,
        );
        assert.deepEqual(await nav(h), before);
        await h.q.change(
          `UPDATE app_ui_packages SET ${column}=? WHERE app_id='example.notes'`,
          [original as string | number],
        );
      }
      assert.ok(
        await h.store.installCognitiveApp(
          human,
          installRequest(fixture.definition, fixture.proof),
        ),
      );
    }));
  test(`Cognitive GUI install missing package cannot create false installation on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h, "1.0.0", human, false);
      const before = await nav(h);
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(fixture.definition, fixture.proof),
          ),
        denied("not_found"),
      );
      assert.equal(
        (
          await h.q.all(
            "SELECT * FROM app_installations WHERE app_id='example.notes'",
          )
        ).length,
        0,
      );
      assert.equal(
        (await h.q.all("SELECT * FROM cognitive_app_versions")).length,
        0,
      );
      assert.deepEqual(await nav(h), before);
    }));
  test(`Cognitive GUI install current row metadata cannot drift after proof issuance on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const before = await nav(h);
      h.onIdentity = () => {
        h.onIdentity = null;
      };
      const transaction = Reflect.get(h.store, "transaction").bind(h.store);
      let changed = false;
      Reflect.set(
        h.store,
        "transaction",
        (work: (q: SqlQuery) => Promise<unknown>, mode?: string) =>
          transaction(async (q: SqlQuery) => {
            if (!changed) {
              changed = true;
              await q.change(
                "UPDATE app_ui_packages SET artifact_revision=2 WHERE app_id='example.notes'",
              );
            }
            return work(q);
          }, mode),
      );
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(fixture.definition, fixture.proof),
          ),
        denied("conflict"),
      );
      assert.equal(changed, true);
      assert.equal(
        Number(
          (
            await h.q.all<{ artifact_revision: number | string }>(
              "SELECT artifact_revision FROM app_ui_packages",
            )
          )[0]!.artifact_revision,
        ),
        1,
      );
      assert.equal(
        (await h.q.all("SELECT * FROM cognitive_app_versions")).length,
        0,
      );
      assert.deepEqual(await nav(h), before);
    }));
  test(`Cognitive GUI install synchronous detached definition survives actual identity yield on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const request = installRequest(fixture.definition, fixture.proof);
      const original = parseCognitiveAppDefinition(fixture.definition);
      h.onIdentity = () => {
        h.onIdentity = null;
        fixture.definition.title = "Caller changed";
        fixture.definition.operations[0]!.effect = "write";
        fixture.definition.ui.sha256 = "0".repeat(64);
        request.now = "2027-01-01T00:00:00.000Z";
        request.verifiedUi = { ...fixture.proof };
      };
      const version = await h.store.installCognitiveApp(human, request);
      assert.deepEqual(version.definition, original);
      assert.equal(version.installedAt, now);
    }));
  test(`Cognitive GUI install concurrent exact proof and disabled installation preserve original identity on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const before = await nav(h);
      const versions = await Promise.all(
        [1, 2, 3].map(() =>
          h.store.installCognitiveApp(
            human,
            installRequest(fixture.definition, fixture.proof),
          ),
        ),
      );
      assert.ok(
        versions.every((v) => v.installationId === versions[0]!.installationId),
      );
      assert.equal(
        (await h.q.all("SELECT * FROM cognitive_app_versions")).length,
        1,
      );
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
      await h.q.change(
        "UPDATE app_installations SET state='disabled' WHERE app_id='example.notes'",
      );
      const disabled = await nav(h);
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(fixture.definition, fixture.proof),
          ),
        denied("forbidden"),
      );
      assert.deepEqual(await nav(h), disabled);
      assert.equal(
        (
          await h.q.all<{ state: string }>(
            "SELECT state FROM app_installations WHERE app_id='example.notes'",
          )
        )[0]!.state,
        "disabled",
      );
    }));
  test(`Cognitive GUI install retains legacy private UI ACL and survives reopen on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const version = await h.store.installCognitiveApp(
        human,
        installRequest(fixture.definition, fixture.proof),
      );
      await h.store.changeCognitiveAppGrant(bob, {
        appId: fixture.definition.id,
        version: fixture.definition.version,
        expectedRevision: 0,
        state: "active",
        now,
      });
      assert.equal(
        (await h.store.listCognitiveApps(bob, { limit: 10 })).versions.length,
        1,
      );
      await assert.rejects(
        () =>
          h.store.uiPackage(
            bob,
            fixture.definition.id,
            fixture.definition.version,
          ),
        denied("not_found"),
      );
      assert.deepEqual(await h.store.listUiPackages(bob), []);
      const before = await nav(h);
      await h.reopen();
      assert.deepEqual(
        await h.store.installCognitiveApp(
          human,
          installRequest(fixture.definition, fixture.proof),
        ),
        version,
      );
      assert.deepEqual(await nav(h), before);
      assert.deepEqual(
        (
          await h.store.uiPackage(
            human,
            fixture.definition.id,
            fixture.definition.version,
          )
        ).header,
        fixture.entry.header,
      );
      await assert.rejects(
        () =>
          h.store.uiPackage(
            bob,
            fixture.definition.id,
            fixture.definition.version,
          ),
        denied("not_found"),
      );
    }));
  test(`Cognitive headless installation stays proof-free and exact version cannot become GUI on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const definition = { ...fixture.definition, ui: null };
      const headless = await h.store.installCognitiveApp(human, {
        definition,
        now,
      });
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(fixture.definition, fixture.proof),
          ),
        denied("conflict"),
      );
      assert.deepEqual(
        (
          await h.q.all<{ definition_hash: string }>(
            "SELECT definition_hash FROM cognitive_app_versions",
          )
        )[0]!.definition_hash,
        headless.definitionHash,
      );
    }));
  test(`Cognitive GUI install genuine proof cannot replace an already fixed definition on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const version = await h.store.installCognitiveApp(
        human,
        installRequest(fixture.definition, fixture.proof),
      );
      const before = await nav(h);
      const changedDefinition = {
        ...fixture.definition,
        operations: [{ ...fixture.definition.operations[0]!, effect: "write" }],
      };
      const changedProof = verifyCognitiveAppUiBytes({
        tenantId: "tenant-a",
        principalId: "alice",
        definition: changedDefinition,
        entry: fixture.entry,
        stored: fixture.stored,
        bytes: fixture.bytes,
      });
      assert.equal(readCognitiveAppUiByteProof(changedProof), changedProof);
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(changedDefinition, changedProof),
          ),
        denied("conflict"),
      );
      assert.equal(
        (
          await h.q.all<{ definition_hash: string }>(
            "SELECT definition_hash FROM cognitive_app_versions",
          )
        )[0]!.definition_hash,
        version.definitionHash,
      );
      assert.deepEqual(await nav(h), before);
    }));
  test(`Cognitive GUI install navigation failure rolls back only new domain fact and preserves original UI on ${backend}`, async () =>
    isolated(backend, async (h) => {
      const fixture = await installed(h);
      const before = await nav(h);
      const originalUI = await h.q.all("SELECT * FROM app_ui_packages");
      const originalInstall = await h.q.all("SELECT * FROM app_installations");
      const advance = Reflect.get(h.store, "advanceNavigation").bind(h.store);
      let actualNav = false;
      Reflect.set(h.store, "advanceNavigation", async (...args: unknown[]) => {
        await advance(...args);
        actualNav = true;
        throw new Error("TEST fail after actual navigation SQL");
      });
      await assert.rejects(
        () =>
          h.store.installCognitiveApp(
            human,
            installRequest(fixture.definition, fixture.proof),
          ),
        /TEST fail after actual navigation SQL/,
      );
      assert.equal(actualNav, true);
      assert.equal(
        (await h.q.all("SELECT * FROM cognitive_app_versions")).length,
        0,
      );
      assert.deepEqual(await nav(h), before);
      assert.deepEqual(
        await h.q.all("SELECT * FROM app_ui_packages"),
        originalUI,
      );
      assert.deepEqual(
        await h.q.all("SELECT * FROM app_installations"),
        originalInstall,
      );
      Reflect.set(h.store, "advanceNavigation", advance);
      assert.ok(
        await h.store.installCognitiveApp(
          human,
          installRequest(fixture.definition, fixture.proof),
        ),
      );
      assert.equal(
        Number((await nav(h)).revision),
        Number(before.revision) + 1,
      );
    }));
  for (const gui of [false, true]) {
    test(`Cognitive ${gui ? "GUI" : "headless"} installation nested Schema snapshot survives real identity I/O on ${backend}`, async () =>
      isolated(backend, async (h) => {
        const fixture = await installed(h);
        const inputSchema = {
          type: "object",
          properties: {
            text: {
              type: "string",
              maxLength: 20,
              enum: ["original-input\u0000\ud800"],
            },
          },
          required: ["text"],
          additionalProperties: false,
        };
        const outputSchema = {
          type: "object",
          properties: {
            text: { type: "string", enum: ["original-output\u0000\udc00"] },
          },
          required: ["text"],
          additionalProperties: false,
        };
        const definition = {
          ...fixture.definition,
          ui: gui ? fixture.definition.ui : null,
          operations: [
            { ...fixture.definition.operations[0]!, inputSchema, outputSchema },
          ],
        };
        const original = JSON.parse(
          Buffer.from(
            canonicalJsonBytes(parseCognitiveAppDefinition(definition)),
          ).toString("utf8"),
        );
        const proof = gui
          ? verifyCognitiveAppUiBytes({
              tenantId: "tenant-a",
              principalId: "alice",
              definition,
              entry: fixture.entry,
              stored: fixture.stored,
              bytes: fixture.bytes,
            })
          : undefined;
        let changed = false;
        h.onIdentity = () => {
          h.onIdentity = null;
          changed = true;
          inputSchema.properties.text.enum[0] = "caller-changed-input";
          inputSchema.properties.text.maxLength = 99;
          inputSchema.required.length = 0;
          outputSchema.properties.text.enum[0] = "caller-changed-output";
          outputSchema.required.length = 0;
        };
        const version = await h.store.installCognitiveApp(
          human,
          installRequest(definition, proof),
        );
        assert.equal(
          changed,
          true,
          "The original is changed only inside the actual async identity verifier.",
        );
        assert.deepEqual(version.definition, original);
        assert.equal(
          version.definitionHash,
          digest(canonicalJsonBytes(original)),
        );
        assert.notEqual(
          version.definition.operations[0]!.inputSchema,
          inputSchema,
        );
        assert.notEqual(
          version.definition.operations[0]!.outputSchema,
          outputSchema,
        );
        const retained = JSON.parse(
          (
            await h.q.all<{ definition_json: string }>(
              "SELECT definition_json FROM cognitive_app_versions",
            )
          )[0]!.definition_json,
        );
        assert.deepEqual(retained, original);
      }));
  }
}
