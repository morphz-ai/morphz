import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { createCognitiveAppHost } from "../packages/application/src/cognitive-app-host.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import { parseDomainReceipt } from "../packages/cognitive-app-sdk/src/domain-wire.js";
import { CognitiveAppServiceError } from "../packages/application/src/cognitive-app-service.js";

const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const actor = { credential: "alice" };
const integrationCredential =
  "isolated_lifecycle_author_credential_abcdefghijklmnopqrstuvwxyz";
const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
let packedRoot: string | undefined, packed: Promise<string> | undefined;
function packedAuthor() {
  return (packed ??= Promise.resolve().then(() => {
    packedRoot = mkdtempSync(join(tmpdir(), "morphz-host-packed-"));
    const sdk = join(packedRoot, "sdk"),
      author = join(packedRoot, "author");
    mkdirSync(join(sdk, "src"), { recursive: true });
    mkdirSync(author);
    for (const file of [
      "package.json",
      "tsconfig.build.json",
      "README.md",
      "LICENSE",
    ])
      copyFileSync(
        join(applicationRoot, "packages/cognitive-app-sdk", file),
        join(sdk, file),
      );
    for (const file of readdirSync(
      join(applicationRoot, "packages/cognitive-app-sdk/src"),
    ))
      if (file.endsWith(".ts"))
        copyFileSync(
          join(applicationRoot, "packages/cognitive-app-sdk/src", file),
          join(sdk, "src", file),
        );
    for (const file of [
      "package.json",
      "service.mjs",
      "definition.json",
      "README.md",
      "MODEL.md",
    ])
      copyFileSync(
        join(applicationRoot, "examples/cognitive-notes", file),
        join(author, file),
      );
    const user = join(packedRoot, "npm-user.cfg"),
      global = join(packedRoot, "npm-global.cfg");
    writeFileSync(user, "");
    writeFileSync(global, "");
    const cli = process.env.npm_execpath;
    assert.ok(cli, "formal npm test supplies npm");
    const npm = (cwd: string, args: string[]) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...childEnvironment(),
          npm_config_cache: join(homedir(), ".npm"),
          npm_config_userconfig: user,
          npm_config_globalconfig: global,
          npm_config_offline: "true",
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
        },
      });
    npm(sdk, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    const result: unknown = JSON.parse(
      npm(sdk, ["pack", "--offline", "--json", "--silent"]),
    );
    assert.ok(Array.isArray(result) && result.length === 1);
    const filename: unknown = Reflect.get(result[0] as object, "filename");
    assert.equal(filename, "morphz-cognitive-app-sdk-0.3.0.tgz");
    npm(author, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(sdk, String(filename)),
    ]);
    assert.doesNotMatch(
      readFileSync(join(author, "service.mjs"), "utf8"),
      /packages\/(application|platform)|\.\.\//,
    );
    return author;
  }));
}
after(() => {
  if (packedRoot) rmSync(packedRoot, { recursive: true, force: true });
});
type Ready = { port: number; serviceId: string; dataAuthorityId: string };
async function authorProcess(root: string, db: string, config: string) {
  const child = spawn(
    process.execPath,
    [join(root, "service.mjs"), "--db", db, "--config", config, "--port", "0"],
    { cwd: root, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const ready = await new Promise<Ready>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(
        () => reject(new Error("isolated author readiness timeout")),
        10000,
      );
      child.stdout!.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
        if (!stdout.includes("\n")) return;
        try {
          const value = JSON.parse(stdout.split("\n")[0]!) as Ready;
          assert.ok(Number.isSafeInteger(value.port) && value.port > 0);
          assert.equal(typeof value.serviceId, "string");
          assert.equal(typeof value.dataAuthorityId, "string");
          clearTimeout(timer);
          resolve(value);
        } catch {
          clearTimeout(timer);
          reject(new Error("isolated author readiness invalid"));
        }
      });
      child.stderr!.on("data", () => {});
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("isolated author failed"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("isolated author exited"));
      });
    });
    return { child, ready };
  } catch (error) {
    await stopAuthor(child);
    throw error;
  }
}
async function stopAuthor(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
const verifier: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    return credential === "alice"
      ? {
          tenantId: "tenant-a",
          principalId: "alice",
          actantId: "alice-human",
          kind: "human",
          runtimeInputId: null,
        }
      : null;
  },
  async resolveActant({ actantId }) {
    return actantId === "alice-human"
      ? { principalId: "alice", kind: "human" }
      : null;
  },
  async resolveProjectAgent() {
    return null;
  },
  async verifyApplicationObject() {
    return false;
  },
};
type Fixture = {
  platform: PlatformStore;
  q: SqlQuery;
  host: ReturnType<typeof createCognitiveAppHost>;
  paths: string[];
  connectionId: string;
  configFile: string;
  root: string;
  control: {
    drop: boolean;
    hold: boolean;
    release?: () => void;
    receipt?: ReturnType<typeof parseDomainReceipt>;
  };
  write(
    commandId: string,
  ): ReturnType<ReturnType<typeof createCognitiveAppHost>["service"]["invoke"]>;
  reopen(configured?: boolean, restartAuthor?: boolean): Promise<void>;
  authorFacts(): { notes: number; commands: number; body: string };
};
/** Real Platform/SQL/bytes and independent tarball-consuming author process.
 * Authentication is an explicit isolated fixture, not real Runtime evidence.
 */
async function isolated(
  backend: "sqlite" | "postgres",
  run: (f: Fixture) => Promise<void>,
) {
  const authorRoot = await packedAuthor(),
    root = mkdtempSync(join(tmpdir(), "morphz-cognitive-host-"));
  const authorDb = join(root, "author.sqlite"),
    bootstrap = join(root, "author-bootstrap.json"),
    configFile = join(root, "bindings.json"),
    filename = join(root, "platform.sqlite");
  writeFileSync(
    bootstrap,
    JSON.stringify({
      format: "cognitive-notes-bootstrap/v1",
      integrations: [
        {
          credentialSha256: createHash("sha256")
            .update(integrationCredential)
            .digest("hex"),
          issuer: "isolated_host",
          tenantId: "tenant-a",
          principalId: "alice",
          humanActantId: "alice-human",
          agentActantIds: [],
          projects: [{ projectId: "project-a", read: true, write: true }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const schema = `morphz_test_host_${randomUUID().replaceAll("-", "")}`,
    pool =
      backend === "postgres"
        ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
        : null;
  let author: Awaited<ReturnType<typeof authorProcess>> | undefined,
    proxy: Server | undefined,
    platform: PlatformStore | undefined,
    host: ReturnType<typeof createCognitiveAppHost> | undefined,
    database: DatabaseSync | undefined,
    admin: PoolClient | undefined;
  const paths: string[] = [],
    control: Fixture["control"] = { drop: false, hold: false };
  try {
    author = await authorProcess(authorRoot, authorDb, bootstrap);
    proxy = createServer((incoming, outgoing) => {
      paths.push(incoming.url!);
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port: author!.ready.port,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
          agent: false,
        },
        (received) => {
          const chunks: Buffer[] = [];
          received.on("data", (chunk: Buffer) => chunks.push(chunk));
          received.once("end", () => {
            const body = Buffer.concat(chunks);
            if (incoming.url === "/invoke" && received.statusCode === 200) {
              const value: unknown = JSON.parse(body.toString());
              if (
                typeof value === "object" &&
                value !== null &&
                Reflect.get(value, "status") === "committed"
              )
                control.receipt = parseDomainReceipt(value);
              if (control.drop) {
                control.drop = false;
                outgoing.destroy();
                return;
              }
            }
            const deliver = () => {
              const headers = {
                ...received.headers,
                "content-length": String(body.length),
              };
              delete headers["transfer-encoding"];
              outgoing.writeHead(received.statusCode!, headers);
              outgoing.end(body);
            };
            if (control.hold && incoming.url === "/invoke") {
              control.hold = false;
              control.release = () => {
                control.release = undefined;
                deliver();
              };
            } else deliver();
          });
          received.once("error", () => outgoing.destroy());
        },
      );
      upstream.once("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(
      configFile,
      JSON.stringify({
        format: "morphz-host-cognitive-bindings/v1",
        issuer: "isolated_host",
        bindings: [
          {
            tenantId: "tenant-a",
            principalId: "alice",
            appId: definition.id,
            serviceId: author.ready.serviceId,
            dataAuthorityId: author.ready.dataAuthorityId,
            baseUrl: `http://127.0.0.1:${address.port}`,
            credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_TEST",
            current: true,
            approvedLoopback: { host: "127.0.0.1", port: address.port },
          },
        ],
      }),
      { mode: 0o600 },
    );
    if (pool) await pool.query(`CREATE SCHEMA "${schema}"`);
    const open = () =>
      pool
        ? PlatformStore.postgres(
            { connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!, schema },
            verifier,
          )
        : PlatformStore.sqlite(filename, verifier);
    platform = await open();
    await platform.provisionTenant("tenant-a");
    let q: SqlQuery;
    if (pool) {
      admin = await pool.connect();
      await admin.query(`SET search_path TO "${schema}",pg_catalog`);
      q = postgresQuery(admin);
    } else {
      database = new DatabaseSync(filename);
      database.exec("PRAGMA foreign_keys=ON");
      q = sqliteQuery(database);
    }
    const at = new Date().toISOString();
    await q.change(
      "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','project-a','project','alice','Project',1,?,?)",
      [at, at],
    );
    await q.change(
      "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a','alice')",
    );
    const makeHost = (configured = true) =>
      createCognitiveAppHost({
        tenantId: "tenant-a",
        platform: platform!,
        ...(configured
          ? {
              config: {
                bindingsFile: configFile,
                secrets: () => integrationCredential,
                egress: "public-https" as const,
              },
            }
          : {}),
      });
    host = makeHost();
    host.start();
    await host.whenIdle();
    await host.service.install(actor, { definition });
    await host.service.grant(actor, {
      appId: definition.id,
      version: definition.version,
      state: "active",
      expectedRevision: 0,
    });
    const connection = await host.service.connect(actor, {
      appId: definition.id,
      version: definition.version,
      connectionId: "connection-a",
      expectedRevision: 0,
      serviceId: author.ready.serviceId,
      dataAuthorityId: author.ready.dataAuthorityId,
    });
    await host.whenIdle();
    const f: Fixture = {
      platform,
      q,
      host,
      paths,
      connectionId: connection.connectionId,
      configFile,
      root,
      control,
      write(commandId) {
        return f.host.service.invoke(actor, {
          projectId: "project-a",
          appId: definition.id,
          version: definition.version,
          connectionId: f.connectionId,
          operationId: "notes.create",
          parameters: { title: commandId, markdown: "AUTHOR PRIVATE BODY" },
          resources: [],
          commandId,
        });
      },
      async reopen(configured = true, restart = false) {
        await host!.close();
        await platform!.close();
        if (restart) {
          await stopAuthor(author!.child);
          author = await authorProcess(authorRoot, authorDb, bootstrap);
        }
        platform = await open();
        host = makeHost(configured);
        f.platform = platform;
        f.host = host;
        host.start();
        await host.whenIdle();
      },
      authorFacts() {
        const db = new DatabaseSync(authorDb, { readOnly: true });
        try {
          return {
            notes: Number(
              db.prepare("SELECT count(*) AS n FROM notes").get()!.n,
            ),
            commands: Number(
              db.prepare("SELECT count(*) AS n FROM author_commands").get()!.n,
            ),
            body: String(
              db
                .prepare("SELECT content_json FROM note_versions LIMIT 1")
                .get()!.content_json,
            ),
          };
        } finally {
          db.close();
        }
      },
    };
    await run(f);
  } finally {
    control.release?.();
    await host?.close();
    await platform?.close();
    database?.close();
    admin?.release();
    proxy?.closeAllConnections();
    if (proxy)
      await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    if (author) await stopAuthor(author.child);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    rmSync(root, { recursive: true, force: true });
  }
}
const ledger = (f: Fixture, id: string) =>
  f.platform.inspectCognitiveAppCommand(actor, {
    projectId: "project-a",
    commandId: id,
  });
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL ${backend}: lost committed response stays unknown on ordinary SQL, cold Host/author restart recovers without Runtime or reinvoke`,
    { timeout: 120000 },
    () =>
      isolated(backend, async (f) => {
        f.control.drop = true;
        const result = await f.write("lost-commit");
        assert.ok("kind" in result && result.kind === "command");
        assert.equal(result.command.state, "unknown");
        await f.host.whenIdle();
        assert.equal(f.paths.filter((path) => path === "/invoke").length, 1);
        assert.equal(
          f.paths.filter((path) => path === "/receipts/read").length,
          0,
        );
        await f.host.service.grant(actor, {
          appId: definition.id,
          version: definition.version,
          state: "disabled",
          expectedRevision: 1,
        });
        await f.host.whenIdle();
        assert.equal(
          f.paths.filter((path) => path === "/receipts/read").length,
          0,
        );
        await f.reopen(true, true);
        assert.equal((await ledger(f, "lost-commit")).state, "committed");
        assert.equal(
          (await ledger(f, "lost-commit")).projectionState,
          "projected",
        );
        assert.equal(f.paths.filter((path) => path === "/invoke").length, 1);
        assert.equal(
          f.paths.filter((path) => path === "/receipts/read").length,
          1,
        );
        const entries = await f.q.all(
          "SELECT title FROM content_entries WHERE tenant_id='tenant-a'",
        );
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.title, "lost-commit");
        assert.equal(f.authorFacts().notes, 1);
        assert.equal(f.authorFacts().commands, 1);
        assert.ok(f.authorFacts().body.includes("AUTHOR PRIVATE BODY"));
        assert.equal(
          JSON.stringify(
            await f.q.all(
              "SELECT * FROM cognitive_app_commands WHERE tenant_id='tenant-a'",
            ),
          ).includes("AUTHOR PRIVATE BODY"),
          false,
        );
        const before = f.paths.length;
        await new Promise((resolve) => setTimeout(resolve, 35));
        assert.equal(f.paths.length, before);
      }),
  );
  test(
    `ACTUAL ${backend}: no bindings still projects exact persisted committed facts and keeps management`,
    { timeout: 120000 },
    () =>
      isolated(backend, async (f) => {
        f.control.drop = true;
        await f.write("pending-catalog");
        await f.host.close();
        assert.ok(f.control.receipt);
        await f.platform.recordCognitiveAppCommandReceipt({
          tenantId: "tenant-a",
          commandId: "pending-catalog",
          receipt: f.control.receipt,
        });
        assert.equal(
          (await ledger(f, "pending-catalog")).projectionState,
          "pending",
        );
        const before = f.paths.length;
        await f.reopen(false);
        assert.equal(
          (await ledger(f, "pending-catalog")).projectionState,
          "projected",
        );
        assert.equal(f.paths.length, before);
        assert.equal(
          (await f.host.service.list(actor, { limit: 10 })).versions.length,
          1,
        );
        await assert.rejects(
          f.host.service.connect(actor, {
            appId: definition.id,
            version: definition.version,
            connectionId: "new-connection",
            expectedRevision: 0,
            serviceId: "same-service",
            dataAuthorityId: "same-data",
          }),
          CognitiveAppServiceError,
        );
        assert.equal(f.paths.length, before);
      }),
  );
  test(
    `ACTUAL ${backend}: shutdown aborts a held actual committed response, waits ledger, and never cancels/reinvokes author work`,
    { timeout: 120000 },
    () =>
      isolated(backend, async (f) => {
        f.control.hold = true;
        const pending = f.write("shutdown-commit");
        const denied = assert.rejects(pending, (error) => {
          assert.ok(error instanceof CognitiveAppServiceError);
          assert.equal(error.commandId, "shutdown-commit");
          return true;
        });
        const deadline = Date.now() + 5000;
        while (!f.control.release) {
          assert.ok(Date.now() < deadline);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(f.control.receipt);
        await Promise.all([f.host.close(), f.host.close()]);
        await denied;
        assert.equal((await ledger(f, "shutdown-commit")).state, "unknown");
        assert.equal(f.paths.filter((path) => path === "/invoke").length, 1);
        await assert.rejects(
          f.host.service.list(actor, { limit: 1 }),
          CognitiveAppServiceError,
        );
        f.control.release();
        await f.reopen();
        assert.equal((await ledger(f, "shutdown-commit")).state, "committed");
        assert.equal(f.paths.filter((path) => path === "/invoke").length, 1);
      }),
  );
}

test("ACTUAL shared SQLite domains: absent private config creates no private file and retains management before any Runtime binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-host-unconfigured-")),
    workspace = new WorkspaceStore(join(root, "workspace.sqlite"), {
      mode: "transport",
    });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(root, workspace);
    const service = domains.cognitiveApps.service;
    await domains.cognitiveApps.authority.withSession(
      localAccess,
      () => {},
      async (access) => {
        await service.install(access, { definition });
        await service.grant(access, {
          appId: definition.id,
          version: definition.version,
          state: "active",
          expectedRevision: 0,
        });
        assert.equal(
          (await service.list(access, { limit: 1 })).versions.length,
          1,
        );
      },
    );
    assert.equal(domains.cognitiveApps.service, service);
    assert.equal(
      readdirSync(root).some((name) => /binding|credential/.test(name)),
      false,
    );
    // Real Bridge construction/binding only, not a real Runtime or Agent call.
    // Neither candidate starts its network/tick loop or persists a new connection.
    const candidate = new RuntimeBridge(
      workspace,
      {
        url: "http://127.0.0.1:1",
        token: "isolated_never_sent",
        namespace: randomUUID(),
      },
      undefined,
      false,
    );
    const prepared = domains.bindRuntime(candidate);
    assert.equal(domains.cognitiveApps.service, service);
    await domains.unbindRuntime(prepared.authority);
    await candidate.stop();
    assert.equal(domains.cognitiveApps.service, service);
    const accepted = new RuntimeBridge(
      workspace,
      {
        url: "http://127.0.0.1:1",
        token: "isolated_never_sent",
        namespace: randomUUID(),
      },
      undefined,
      false,
    );
    const bound = domains.bindRuntime(accepted);
    assert.equal(domains.cognitiveApps.service, service);
    await domains.cognitiveApps.authority.withSession(
      localAccess,
      () => {},
      async (access) =>
        assert.equal(
          (await service.list(access, { limit: 1 })).versions.length,
          1,
        ),
    );
    await domains.unbindRuntime(bound.authority);
    await accepted.stop();
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACTUAL SQLite: closed Host preserves validated invoke/recovery/UI-install identity without executing a malformed getter", async () => {
  const platform = await PlatformStore.sqlite(":memory:", verifier),
    host = createCognitiveAppHost({ tenantId: "tenant-a", platform });
  try {
    await host.close();
    const target = {
      projectId: "project-a",
      appId: definition.id,
      version: definition.version,
      connectionId: "connection-a",
    };
    const expectId = (commandId: string) => (error: unknown) => {
      assert.ok(error instanceof CognitiveAppServiceError);
      assert.equal(error.reason, "unavailable");
      assert.equal(error.commandId, commandId);
      return true;
    };
    await assert.rejects(
      host.service.invoke(actor, {
        ...target,
        commandId: "late-invoke",
        operationId: "notes.create",
        parameters: { title: "T", markdown: "M" },
        resources: [],
      }),
      expectId("late-invoke"),
    );
    await assert.rejects(
      host.service.recover(actor, { ...target, commandId: "late-recover" }),
      expectId("late-recover"),
    );
    const html = "<!doctype html><p>作者界面</p>",
      uiDefinition = {
        ...definition,
        ui: {
          packageVersion: definition.version,
          sha256: createHash("sha256").update(html).digest("hex"),
        },
      };
    await assert.rejects(
      host.service.install(actor, {
        definition: uiDefinition,
        commandId: "late-install",
        manifest: {
          format: "morphz-app/v1",
          id: definition.id,
          version: definition.version,
          title: definition.title,
          description: definition.description,
          icon: definition.icon,
          harness: null,
          permissions: [],
          ui: { type: "sandbox", html },
        },
      }),
      expectId("late-install"),
    );
    let getters = 0;
    const malformed = {
      ...target,
      operationId: "notes.create",
      parameters: { title: "T", markdown: "M" },
      resources: [],
    };
    Object.defineProperty(malformed, "commandId", {
      enumerable: true,
      get() {
        getters++;
        return "unsafe";
      },
    });
    await assert.rejects(
      host.service.invoke(actor, malformed),
      (error) =>
        error instanceof CognitiveAppServiceError &&
        error.commandId === undefined,
    );
    assert.equal(getters, 0);
  } finally {
    await host.close();
    await platform.close();
  }
});

test("ACTUAL SQLite private configuration: an explicit invalid path/policy is sanitized, never creates or exports configuration", async () => {
  const platform = await PlatformStore.sqlite(":memory:", verifier);
  try {
    assert.throws(
      () =>
        createCognitiveAppHost({
          tenantId: "tenant-a",
          platform,
          config: { bindingsFile: "private/path/secret.json" },
        }),
      (error) =>
        error instanceof CognitiveAppServiceError &&
        !error.message.includes("private") &&
        !Reflect.has(error, "cause"),
    );
    const host = createCognitiveAppHost({
      tenantId: "tenant-a",
      platform,
      config: {
        bindingsFile: join(tmpdir(), `absent-${randomUUID()}`),
        secrets: () => {
          throw new Error("must not read");
        },
      },
    });
    host.start();
    await host.whenIdle();
    await host.close();
  } finally {
    await platform.close();
  }
});
