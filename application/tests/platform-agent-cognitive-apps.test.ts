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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createConnection } from "node:net";
import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { storedData } from "./platform-local-input-fixture.js";
import {
  AgentTools,
  type HostInvocation,
  type ToolScope,
} from "../packages/application/src/agent-tools.js";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { createCognitiveAppService } from "../packages/application/src/cognitive-app-service.js";
import { createCognitiveAppGateway } from "../packages/application/src/cognitive-app-gateway.js";
import { CognitiveAppBindings } from "../packages/application/src/cognitive-app-bindings.js";
import { CognitiveAppTransport } from "../packages/application/src/cognitive-app-transport.js";
import { stableId } from "../packages/application/src/stable-id.js";
import { listenLocalHostTools } from "../packages/application/src/host-tools-ipc.js";
import {
  createScriptProduction,
  createScriptItem,
  updateScriptProduction,
} from "../packages/application/src/script-production-service.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  parseCognitiveAppCommandResult,
  parseCognitiveAppCatalog,
  parseCognitiveAppDescription,
  parseCognitiveAppReadResult,
} from "../packages/core/src/cognitive-app-api.js";
import { parseBrowserCommandFacts } from "../packages/cognitive-app-sdk/src/browser-wire.js";
import {
  canonicalJsonBytes,
  parseObjectReadResponse,
} from "../packages/cognitive-app-sdk/src/domain-wire.js";
import {
  parseCognitiveAppDefinition,
  parseWireJson,
} from "../packages/cognitive-app-sdk/src/protocol.js";

// Actual shared Platform/Service/Gateway, private pinned HTTP and independently
// packed author with its own SQLite. Runtime accepted Thread/Event/Schedule
// evidence is controlled: this is NOT actual Rust/model or original-App proof.
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      join(appRoot, "examples/cognitive-notes/definition.json"),
      "utf8",
    ),
  ),
);
const definitionHash = createHash("sha256")
  .update(canonicalJsonBytes(definition))
  .digest("hex");
const integrationSecret =
  "isolated_agent_cognitive_secret_abcdefghijklmnopqrstuvwxyz";
let packedDirectory: string | undefined;
let packedAuthor: Promise<string> | undefined;
const childEnv = () => {
  const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};
async function prepareAuthor() {
  return (packedAuthor ??= Promise.resolve().then(() => {
    packedDirectory = mkdtempSync(
      join(tmpdir(), "morphz-agent-cognitive-pack-"),
    );
    const sdk = join(packedDirectory, "sdk"),
      author = join(packedDirectory, "author");
    mkdirSync(join(sdk, "src"), { recursive: true });
    mkdirSync(author);
    for (const file of [
      "package.json",
      "tsconfig.build.json",
      "README.md",
      "LICENSE",
    ])
      copyFileSync(
        join(appRoot, "packages/cognitive-app-sdk", file),
        join(sdk, file),
      );
    for (const file of readdirSync(
      join(appRoot, "packages/cognitive-app-sdk/src"),
    ))
      if (file.endsWith(".ts"))
        copyFileSync(
          join(appRoot, "packages/cognitive-app-sdk/src", file),
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
        join(appRoot, "examples/cognitive-notes", file),
        join(author, file),
      );
    const userConfig = join(packedDirectory, "npm-user.cfg"),
      globalConfig = join(packedDirectory, "npm-global.cfg");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const cli = process.env.npm_execpath;
    assert.ok(cli, "formal npm test supplies npm CLI");
    const npm = (cwd: string, args: string[]) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...childEnv(),
          npm_config_cache: join(homedir(), ".npm"),
          npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig,
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
    const packed: unknown = JSON.parse(
      npm(sdk, ["pack", "--offline", "--json", "--silent"]),
    );
    assert.ok(Array.isArray(packed) && packed.length === 1);
    const filename: unknown = Reflect.get(packed[0] as object, "filename");
    assert.equal(filename, "morphz-cognitive-app-sdk-0.2.0.tgz");
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
  if (packedDirectory)
    rmSync(packedDirectory, { recursive: true, force: true });
});
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
async function startAuthor(root: string, db: string, config: string) {
  const child = spawn(
    process.execPath,
    [join(root, "service.mjs"), "--db", db, "--config", config, "--port", "0"],
    { cwd: root, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const ready = await new Promise<{
      port: number;
      serviceId: string;
      dataAuthorityId: string;
    }>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error("isolated author startup timeout")),
        10000,
      );
      child.stderr!.on("data", () => {});
      child.stdout!.on("data", (part: Buffer) => {
        out += part.toString("utf8");
        if (!out.includes("\n")) return;
        try {
          const value = parseWireJson(JSON.parse(out.split("\n")[0]!));
          assert.ok(
            value && typeof value === "object" && !Array.isArray(value),
          );
          const object = value as Record<string, unknown>;
          assert.ok(
            Number.isSafeInteger(object.port) &&
              Number(object.port) > 0 &&
              Number(object.port) <= 65535,
          );
          assert.equal(typeof object.serviceId, "string");
          assert.equal(typeof object.dataAuthorityId, "string");
          assert.deepEqual(object.definition, {
            appId: definition.id,
            version: definition.version,
            definitionHash,
          });
          clearTimeout(timer);
          resolve(
            object as {
              port: number;
              serviceId: string;
              dataAuthorityId: string;
            },
          );
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("isolated author exited before ready"));
      });
    });
    return { child, ready };
  } catch (error) {
    await stopAuthor(child);
    throw error;
  }
}
async function ipcCall(
  endpoint: string,
  request: unknown,
  token = "isolated-agent-token",
) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let bytes = Buffer.alloc(0);
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("isolated IPC timeout")),
    );
    socket.once("error", reject);
    socket.once("connect", () => {
      const payload = Buffer.from(
        JSON.stringify({ protocol: 1, token, request }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on("data", (part: Buffer) => {
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length > 2 * 1024 * 1024 + 4)
        socket.destroy(new Error("isolated IPC response too large"));
    });
    socket.once("end", () => {
      try {
        assert.ok(bytes.length >= 4);
        assert.equal(bytes.length - 4, bytes.readUInt32BE());
        resolve(parseWireJson(JSON.parse(bytes.subarray(4).toString("utf8"))));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function fixture(backend: "sqlite" | "postgres") {
  const authorRoot = await prepareAuthor();
  const schema = `agent_cognitive_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : undefined;
  if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
  const f = await agentDomainFixture({
    ...(admin
      ? {
          storage: {
            platform: {
              kind: "postgres" as const,
              connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
              schema,
            },
          },
        }
      : {}),
  });
  const platform = f.domains.content.platform;
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-agent-cognitive-author-"),
  );
  const authorDb = join(directory, "author.sqlite"),
    config = join(directory, "bootstrap.json");
  const otherProjectId = "agent-other-project";
  await f.withHuman((actor) =>
    f.domains.work.service.createProject(actor, {
      commandId: randomUUID(),
      projectId: otherProjectId,
      title: "Other exact project",
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      format: "cognitive-notes-bootstrap/v1",
      integrations: [
        {
          credentialSha256: createHash("sha256")
            .update(integrationSecret)
            .digest("hex"),
          issuer: "trusted_host",
          tenantId: f.transport.identity(),
          principalId: localAccess.principalId,
          humanActantId: localAccess.actantId,
          agentActantIds: [morphzAgentAccess.actantId],
          projects: [f.projectId, otherProjectId].map((projectId) => ({
            projectId,
            read: true,
            write: true,
          })),
        },
      ],
    }),
    { mode: 0o600 },
  );
  const author = await startAuthor(authorRoot, authorDb, config);
  const control = {
    paths: [] as string[],
    dropNextInvoke: false,
    afterResponse: undefined as undefined | (() => Promise<void>),
  };
  const proxy: Server = createServer((request, response) => {
    control.paths.push(request.url!);
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: author.ready.port,
        path: request.url,
        method: request.method,
        headers: request.headers,
        agent: false,
      },
      (received) => {
        const chunks: Buffer[] = [];
        received.on("data", (part: Buffer) => chunks.push(part));
        received.once("end", () => {
          if (
            request.url === "/invoke" &&
            control.dropNextInvoke &&
            received.statusCode === 200
          ) {
            control.dropNextInvoke = false;
            response.destroy();
            return;
          }
          const deliver = async () => {
            await control.afterResponse?.();
            response.writeHead(received.statusCode!, received.headers);
            response.end(Buffer.concat(chunks));
          };
          void deliver().catch(() => response.destroy());
        });
        received.once("error", () => response.destroy());
      },
    );
    upstream.once("error", () => response.destroy());
    request.once("error", () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const bindingsFile = join(directory, "bindings.json");
  writeFileSync(
    bindingsFile,
    JSON.stringify({
      format: "morphz-host-cognitive-bindings/v1",
      issuer: "trusted_host",
      bindings: [
        {
          tenantId: f.transport.identity(),
          principalId: localAccess.principalId,
          appId: definition.id,
          serviceId: author.ready.serviceId,
          dataAuthorityId: author.ready.dataAuthorityId,
          baseUrl: `http://127.0.0.1:${address.port}`,
          credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_AGENT_FIXTURE",
          current: true,
          approvedLoopback: { host: "127.0.0.1", port: address.port },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const gateway = createCognitiveAppGateway({
    platform,
    transport: new CognitiveAppTransport(),
    bindings: new CognitiveAppBindings({
      filename: bindingsFile,
      readSecret: (name) => {
        assert.equal(name, "MORPHZ_APP_COGNITIVE_CREDENTIAL_AGENT_FIXTURE");
        return integrationSecret;
      },
    }),
  });
  const service = createCognitiveAppService({ platform, gateway });
  await f.withHuman((actor) => service.install(actor, { definition }));
  await f.withHuman((actor) =>
    service.grant(actor, {
      appId: definition.id,
      version: definition.version,
      expectedRevision: 0,
      state: "active",
    }),
  );
  const connection = await f.withHuman((actor) =>
    service.connect(actor, {
      appId: definition.id,
      version: definition.version,
      connectionId: "agent-notes-connection",
      expectedRevision: 0,
      serviceId: author.ready.serviceId,
      dataAuthorityId: author.ready.dataAuthorityId,
    }),
  );
  let resolveScope: ((route: HostInvocation) => Promise<ToolScope>) | undefined;
  type Input = Awaited<ReturnType<typeof f.readAcceptedInput>>;
  const roots = new Map<
    string,
    {
      route: HostInvocation;
      input: Input;
      schedule?: { id: string; root: string };
    }
  >();
  const remember = async (route: HostInvocation) => {
    roots.set(route.thread_id, {
      route,
      input: await f.readAcceptedInput(route),
    });
    return route;
  };
  await remember(f.route);
  const runtime = {
    teamIdentity: false,
    bindPlatformInputAuthority() {},
    bindPlatformReadAuthority() {},
    bindMessageAttachments() {},
    bindPlatformAgentScope(value: typeof resolveScope) {
      resolveScope = value;
    },
    async assertPlatformInputActive() {},
    inputEvidenceReader: () => ({
      async readThread(sessionId: string, threadId: string) {
        const root = roots.get(threadId);
        if (!root || root.route.session_id !== sessionId)
          throw new Error("unknown controlled thread");
        return {
          snapshot: {
            thread: {
              id: threadId,
              session_id: sessionId,
              context_id: root.route.context_id,
              root_turn_id: root.schedule?.root ?? root.input.input_id,
              initiating_principal_id: root.route.principal_id,
              agent_id: root.route.agent_id,
              executor_kind: "agent",
              executor_id: null,
            },
          },
        };
      },
      async readSessionEvent(sessionId: string, eventId: string) {
        const root = [...roots.values()].find(
          (entry) =>
            !entry.schedule &&
            entry.input.input_id === eventId &&
            entry.route.session_id === sessionId,
        );
        if (!root) throw new Error("unknown controlled input");
        return {
          id: eventId,
          actor: "Session-Client",
          type: "session_message",
          topic: "chat/user_message",
          payload: {
            session_id: sessionId,
            context_id: root.route.context_id,
            principal_id: root.route.principal_id,
            client_message_id: eventId,
            session_io: {
              request: {
                io_version: "1",
                client_message_id: eventId,
                message: {
                  format: { id: "morphz.application.input", version: "1" },
                  content: {
                    encoding: "json",
                    value: storedData({
                      ...root.input,
                      author_actant_id: localAccess.actantId,
                    }),
                  },
                },
              },
            },
          },
        };
      },
      async readSessionSchedule(sessionId: string, scheduleId: string) {
        const root = [...roots.values()].find(
          (entry) =>
            entry.schedule?.id === scheduleId &&
            entry.route.session_id === sessionId,
        );
        if (!root?.schedule) throw new Error("unknown controlled schedule");
        return {
          id: root.schedule.id,
          thread_id: root.route.thread_id,
          source_turn_id: root.schedule.root,
        };
      },
    }),
  } as unknown as RuntimeBridge;
  const binding = f.domains.bindRuntime(runtime);
  const domain = {
    authority: binding.authority,
    work: f.domains.work.service,
    content: f.domains.content,
    cognitiveApps: service,
  };
  const makeTools = (includeService = true) =>
    new AgentTools({
      token: "isolated-agent-token",
      resolveScope: (route) => resolveScope!(route),
      platformAgent: new PlatformAgentTools(
        includeService
          ? domain
          : {
              authority: domain.authority,
              work: domain.work,
              content: domain.content,
            },
      ),
    });
  const tools = makeTools();
  const envelope = (
    cognitive: unknown,
    route = f.route,
    callId = randomUUID(),
  ) => ({
    protocol: 1,
    tool: "host_morphz",
    invocation: {
      ...route,
      job_id: `job_${callId}`,
      tool_call_id: `call_${callId}`,
    },
    arguments: { action: "cognitive", cognitive },
  });
  const target = {
    appId: definition.id,
    version: definition.version,
    connectionId: connection.connectionId,
  };
  const commandId = (route: HostInvocation) =>
    stableId(
      "platform-agent-command",
      route.context_id,
      route.job_id,
      route.tool_call_id,
    );
  const call = (request: unknown, route = f.route) =>
    tools.call(envelope(request, route));
  const paths = (path: string) =>
    control.paths.filter((value) => value === path).length;
  return {
    ...f,
    platform,
    service,
    tools,
    makeTools,
    domain,
    envelope,
    target,
    commandId,
    control,
    paths,
    input: async (projectId = f.projectId) => remember(f.input(projectId)),
    resolveScope: (route: HostInvocation) => resolveScope!(route),
    withAgent: <T>(
      work: Parameters<typeof binding.authority.withInvocation<T>>[1],
      route = f.route,
    ) => binding.authority.withInvocation(route, work),
    call,
    authorRows(sql: string) {
      const db = new DatabaseSync(authorDb, { readOnly: true });
      try {
        return db.prepare(sql).all();
      } finally {
        db.close();
      }
    },
    async taskRoute() {
      await f.withHuman((actor) =>
        platform.createTask(actor, {
          commandId: randomUUID(),
          taskId: "agent-cognitive-task",
          projectId: f.projectId,
          title: "Real scheduled admission",
          assigneeId: morphzAgentAccess.actantId,
        }),
      );
      const admission = await binding.authority.withInvocation(
        f.route,
        (actor) =>
          platform.requestTaskRun(actor, {
            commandId: randomUUID(),
            taskId: "agent-cognitive-task",
            expectedRevision: 1,
            sessionId: "agent-scheduled-session",
            intent: "Use authorized notes",
            notBefore: "2026-10-05T00:00:00.000Z",
          }),
      );
      const source = await f.readAcceptedInput(f.route);
      assert.equal(admission.sourceInputId, source.input_id);
      const route = {
        ...f.route,
        session_id: admission.sessionId,
        context_id: "agent-scheduled-context",
        thread_id: "agent-scheduled-thread",
      };
      roots.set(route.thread_id, {
        route,
        input: source,
        schedule: {
          id: admission.request.id,
          root: `client-schedule-${admission.request.id}`,
        },
      });
      return route;
    },
    async prepareFixedGeneration() {
      const studio = f.domains.content.studio!,
        productionId = "cognitive-fixed-production",
        itemId = "cognitive-fixed-item";
      const shared = {
        platform,
        studio,
        instanceId: f.domains.content.instanceIds.scriptStudio!,
        productionId,
      };
      await f.withHuman((actor) =>
        createScriptProduction({
          ...shared,
          actor,
          commandId: randomUUID(),
          projectId: f.projectId,
          title: "Synthetic fixed workflow",
        }),
      );
      let overview = await f.withHuman((actor) =>
        studio.readProductionOverview({
          credential: actor.credential,
          productionId,
        }),
      );
      await f.withHuman((actor) =>
        updateScriptProduction({
          ...shared,
          actor,
          commandId: randomUUID(),
          expectedRevision: overview.metadataRevision,
          title: overview.title,
          brief: {
            ...overview.brief,
            modelProcessingAllowed: true,
            rightsStatement: "Only synthetic fixture material",
          },
          reviewerPrincipalIds: overview.reviewerPrincipalIds,
          template: overview.template,
        }),
      );
      overview = await f.withHuman((actor) =>
        studio.readProductionOverview({
          credential: actor.credential,
          productionId,
        }),
      );
      await f.withHuman((actor) =>
        createScriptItem({
          ...shared,
          actor,
          commandId: randomUUID(),
          itemId,
          expectedActivityRevision: overview.activityRevision,
          kind: "episode",
          draft: { ...emptyScriptDraft("Fixed target"), sources: [] },
        }),
      );
      overview = await f.withHuman((actor) =>
        studio.readProductionOverview({
          credential: actor.credential,
          productionId,
        }),
      );
      const source = await f.readAcceptedInput(f.route);
      await binding.authority.withInvocation(f.route, (actor) =>
        studio.prepareGenerations({
          credential: actor.credential,
          commandId: randomUUID(),
          productionId,
          inputId: source.input_id,
          generations: [
            {
              productionId,
              targetId: itemId,
              baseRevision: 1,
              contextRevision: overview.metadataRevision,
              purpose: "draft",
              references: [],
              maxCandidates: 1,
              maxOutputCharacters: 1000,
              maxReviewPasses: 1,
            },
          ],
        }),
      );
    },
    async close() {
      await f.domains.unbindRuntime(binding.authority);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await stopAuthor(author.child);
      await f.close();
      rmSync(directory, { recursive: true, force: true });
      if (admin) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  };
}
function success(value: unknown) {
  const safe = parseWireJson(value);
  assert.ok(safe && typeof safe === "object" && !Array.isArray(safe));
  const object = safe as Record<string, unknown>;
  assert.equal(object.ok, true, JSON.stringify(safe));
  return object.result;
}
function failure(value: unknown, reason: string, commandId?: string) {
  assert.ok(value && typeof value === "object");
  assert.equal(Reflect.get(value, "ok"), false);
  assert.equal(Reflect.get(value, "code"), reason);
  assert.equal(Reflect.get(value, "commandId"), commandId);
  assert.doesNotMatch(
    JSON.stringify(value),
    /isolated_agent_cognitive_secret|bindings\.json|127\.0\.0\.1|credential|PRIVATE-ORIGINAL/,
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL packed author + ${backend}: bounded Agent adapter, controlled Runtime source, exact durable shared service facts`,
    {
      timeout: 120000,
      skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL,
    },
    async (t) => {
      const f = await fixture(backend);
      try {
        await t.test(
          "only six adapters are discovered, with own consent catalog and exact definition",
          async () => {
            const discovery = (await f.tools.call({
              ...f.envelope({ action: "list" }),
              arguments: {
                action: "operations",
                operations: { action: "list", domain: "cognitive" },
              },
            })) as { operations: Array<{ id: string }> };
            assert.deepEqual(
              discovery.operations.map((value) => value.id),
              [
                "cognitive.list",
                "cognitive.describe",
                "cognitive.invoke",
                "cognitive.read-object",
                "cognitive.status",
                "cognitive.recover",
              ],
            );
            const unavailable = (await f.makeTools(false).call({
              ...f.envelope({ action: "list" }),
              arguments: {
                action: "operations",
                operations: { action: "list", domain: "cognitive" },
              },
            })) as { operations: unknown[] };
            assert.deepEqual(unavailable.operations, []);
            const catalog = parseCognitiveAppCatalog(
              success(await f.call({ action: "list", limit: 50 })),
            );
            const discoveredCatalog = parseCognitiveAppCatalog(
              success(
                await f.tools.call({
                  ...f.envelope({ action: "list" }),
                  arguments: {
                    action: "operations",
                    operations: {
                      action: "invoke",
                      operationId: "cognitive.list",
                      parameters: { limit: 50 },
                    },
                  },
                }),
              ),
            );
            assert.deepEqual(discoveredCatalog, catalog);
            assert.equal(catalog.versions[0]!.appId, definition.id);
            assert.equal(
              Reflect.has(catalog.versions[0]!, "operations"),
              false,
            );
            const description = parseCognitiveAppDescription(
              success(
                await f.call({
                  action: "describe",
                  appId: definition.id,
                  version: definition.version,
                }),
              ),
            );
            assert.deepEqual(description.definition, definition);
            assert.equal(description.definitionHash, definitionHash);
          },
        );
        await t.test(
          "model ingress rejects own/inherited routing and mixed-field accessors without executing or resolving",
          async () => {
            let getters = 0,
              resolutions = 0;
            const getter = () => {
              getters++;
              throw new Error("caller-secret");
            };
            const nested = Object.defineProperty({}, "title", {
              enumerable: true,
              get: getter,
            });
            const tools = new AgentTools({
              token: "isolated-guard",
              resolveScope: (route) => {
                resolutions++;
                return f.resolveScope(route);
              },
              platformAgent: new PlatformAgentTools(f.domain),
            });
            const candidates = [
              {
                ...f.envelope({ action: "list" }),
                arguments: Object.assign(
                  Object.create({
                    get action() {
                      getters++;
                      return "cognitive";
                    },
                  }),
                  { cognitive: { action: "list" } },
                ),
              },
              {
                ...f.envelope({ action: "list" }),
                arguments: {
                  action: "list",
                  cognitive: Object.defineProperty({}, "action", {
                    enumerable: true,
                    get: getter,
                  }),
                },
              },
              f.envelope({
                action: "invoke",
                ...f.target,
                mode: "command",
                operationId: "notes.create",
                parameters: nested,
                resources: [],
              }),
              {
                ...f.envelope({ action: "list" }),
                arguments: {
                  action: "operations",
                  operations: {
                    action: "invoke",
                    operationId: "cognitive.invoke",
                    parameters: {
                      ...f.target,
                      mode: "command",
                      operationId: "notes.create",
                      parameters: nested,
                      resources: [],
                    },
                  },
                },
              },
            ];
            const posts = f.paths("/invoke");
            for (const candidate of candidates) {
              await assert.rejects(async () => tools.call(candidate));
              assert.equal(
                getters,
                0,
                "No routing/value getter may execute before the data guard",
              );
            }
            for (const parameters of [
              "汉".repeat(100000),
              { title: "bad", toJSON: getter },
            ]) {
              await assert.rejects(
                async () =>
                  tools.call(
                    f.envelope({
                      action: "invoke",
                      ...f.target,
                      mode: "command",
                      operationId: "notes.create",
                      parameters,
                      resources: [],
                    }),
                  ),
                (error: unknown) => {
                  assert.ok(
                    error instanceof Error &&
                      "code" in error &&
                      error.code === "invalid",
                  );
                  return true;
                },
              );
            }
            assert.equal(getters, 0);
            assert.equal(resolutions, 0);
            assert.equal(f.paths("/invoke"), posts);
          },
        );
        let created: ReturnType<typeof parseCognitiveAppCommandResult>,
          accepted: ReturnType<typeof f.envelope>;
        await t.test(
          "write identity derives from actual ToolJob, stable retries do not send twice, reads are null/opaque",
          async () => {
            accepted = f.envelope({
              action: "invoke",
              ...f.target,
              mode: "command",
              operationId: "notes.create",
              parameters: {
                title: "Agent original",
                markdown: "PRIVATE-ORIGINAL-仅作者保管",
              },
              resources: [],
            });
            created = parseCognitiveAppCommandResult(
              success(await f.tools.call(accepted)),
            );
            assert.equal(
              created.command.commandId,
              f.commandId(accepted.invocation),
            );
            assert.equal(created.command.state, "committed");
            assert.equal(created.command.projectionState, "projected");
            const count = f.paths("/invoke");
            const replay = parseCognitiveAppCommandResult(
              success(await f.tools.call(accepted)),
            );
            assert.deepEqual(replay.command, created.command);
            assert.equal(f.paths("/invoke"), count);
            const durable = await f.withHuman((actor) =>
              f.platform.inspectCognitiveAppCommandDisclosure(actor, {
                projectId: f.projectId,
                commandId: created.command.commandId,
              }),
            );
            assert.equal(durable.command.actor.kind, "agent");
            assert.equal(
              durable.command.actor.actantId,
              morphzAgentAccess.actantId,
            );
            assert.equal(
              durable.command.actor.principalId,
              localAccess.principalId,
            );
            const originalInput = await f.readAcceptedInput(f.route);
            assert.equal(durable.command.actor.source.kind, "input");
            if (durable.command.actor.source.kind === "input")
              assert.equal(
                durable.command.actor.source.inputId,
                originalInput.input_id,
              );
            const read = parseCognitiveAppReadResult(
              success(
                await f.call({
                  action: "invoke",
                  ...f.target,
                  mode: "read",
                  operationId: "notes.list",
                  parameters: { limit: 32 },
                  resources: [],
                }),
              ),
            );
            assert.equal(Reflect.has(read, "command"), false);
            assert.equal(
              (read.result as { objects: unknown[] }).objects.length,
              1,
            );
            const wrappedRead = parseCognitiveAppReadResult(
              success(
                await f.tools.call({
                  ...f.envelope({ action: "list" }),
                  arguments: {
                    action: "operations",
                    operations: {
                      action: "invoke",
                      operationId: "cognitive.invoke",
                      parameters: {
                        ...f.target,
                        mode: "read",
                        operationId: "notes.list",
                        parameters: { limit: 32 },
                        resources: [],
                      },
                    },
                  },
                }),
              ),
            );
            assert.deepEqual(wrappedRead, read);
            const original = created.result as {
              objectId: string;
              versionRef: string;
            };
            const object = parseObjectReadResponse(
              success(
                await f.call({
                  action: "read-object",
                  ...f.target,
                  object: {
                    objectId: original.objectId,
                    versionRef: original.versionRef,
                  },
                  maxBytes: 262144,
                }),
              ),
            );
            assert.equal(object.object.versionRef, original.versionRef);
            assert.match(JSON.stringify(object.content), /PRIVATE-ORIGINAL/);
            assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
          },
        );
        await t.test(
          "strict authority/management parameters cannot be supplied by model; bad mode/CAS preserve original command ID",
          async () => {
            for (const extra of [
              { projectId: f.projectId },
              { commandId: "model-id" },
              { source: { kind: "human" } },
              { credential: "model-token" },
            ]) {
              await assert.rejects(async () =>
                f.call({
                  action: "invoke",
                  ...f.target,
                  mode: "command",
                  operationId: "notes.create",
                  parameters: { title: "bad", markdown: "bad" },
                  resources: [],
                  ...extra,
                }),
              );
            }
            for (const action of [
              "install",
              "grant",
              "connect",
              "connection-state",
            ])
              await assert.rejects(async () => f.call({ action }));
            const invalid = f.envelope({
              action: "invoke",
              ...f.target,
              mode: "read",
              operationId: "notes.create",
              parameters: { title: "bad", markdown: "bad" },
              resources: [],
            });
            const posts = f.paths("/invoke");
            failure(await f.tools.call(invalid), "invalid");
            const guarded = f.envelope({
              action: "invoke",
              ...f.target,
              mode: "command",
              operationId: "notes.create",
              parameters: { title: "bad", markdown: "bad" },
              resources: [],
              expectedConnectionRevision: 99,
            });
            failure(
              await f.tools.call(guarded),
              "conflict",
              f.commandId(guarded.invocation),
            );
            assert.equal(f.paths("/invoke"), posts);
          },
        );
        await t.test(
          "actual scope await cannot retarget captured parameters, resources, identity or mode",
          async () => {
            let resume: ((scope: ToolScope) => void) | undefined;
            const delayed = new AgentTools({
              token: "isolated-delay",
              resolveScope: () =>
                new Promise<ToolScope>((resolve) => {
                  resume = resolve;
                }),
              platformAgent: new PlatformAgentTools(f.domain),
            });
            const parameters = {
              title: "Snapshot original",
              markdown: "Exact snapshot body",
            };
            const resources: Array<{ objectId: string; versionRef: string }> =
              [];
            const request = {
              action: "invoke",
              ...f.target,
              mode: "command",
              operationId: "notes.create",
              parameters,
              resources,
            };
            const envelope = f.envelope(request),
              originalRoute = { ...envelope.invocation };
            const pending = delayed.call(envelope);
            assert.ok(
              resume,
              "scope resolution is genuinely awaiting after the ingress snapshot",
            );
            parameters.title = "MUTATED";
            parameters.markdown = "MUTATED";
            resources.push({ objectId: "other", versionRef: "other" });
            request.mode = "read";
            envelope.invocation.session_id = "MUTATED";
            envelope.invocation.context_id = "MUTATED";
            resume(await f.resolveScope(originalRoute));
            const result = parseCognitiveAppCommandResult(
              success(await pending),
            );
            assert.equal(result.command.commandId, f.commandId(originalRoute));
            assert.equal(result.command.state, "committed");
            assert.equal(
              (result.result as { title: string }).title,
              "Snapshot original",
            );
            const durable = await f.withHuman((actor) =>
              f.platform.inspectCognitiveAppCommandDisclosure(actor, {
                projectId: f.projectId,
                commandId: result.command.commandId,
              }),
            );
            assert.deepEqual(durable.command.resources, []);
          },
        );
        await t.test(
          "actual Desktop private IPC retains safe failure and original command ID without relaxing authentication",
          async () => {
            const directory = mkdtempSync("/tmp/morphz-agent-cognitive-ipc-");
            const endpoint = join(directory, "agent.sock");
            const listener = await listenLocalHostTools(endpoint, f.tools);
            try {
              const request = f.envelope({
                action: "invoke",
                ...f.target,
                mode: "command",
                operationId: "notes.create",
                parameters: {
                  title: "CAS refused",
                  markdown: "Must not dispatch",
                },
                resources: [],
                expectedConnectionRevision: 99,
              });
              const posts = f.paths("/invoke");
              const response = (await ipcCall(endpoint, request)) as {
                protocol: number;
                ok: boolean;
                value: unknown;
              };
              assert.equal(response.protocol, 1);
              assert.equal(response.ok, true);
              failure(
                response.value,
                "conflict",
                f.commandId(request.invocation),
              );
              assert.deepEqual(
                await ipcCall(endpoint, request, "wrong-token"),
                { protocol: 1, ok: false, code: "forbidden" },
              );
              assert.equal(f.paths("/invoke"), posts);
            } finally {
              await listener.close();
              rmSync(directory, { recursive: true, force: true });
            }
          },
        );
        await t.test(
          "shared Context input roots retain their actual project and reject old Agent fact across sources",
          async () => {
            const route = await f.input("agent-other-project");
            const read = parseCognitiveAppReadResult(
              success(
                await f.call(
                  {
                    action: "invoke",
                    ...f.target,
                    mode: "read",
                    operationId: "notes.list",
                    parameters: { limit: 32 },
                    resources: [],
                  },
                  route,
                ),
              ),
            );
            assert.deepEqual(
              (read.result as { objects: unknown[] }).objects,
              [],
            );
            failure(
              await f.call(
                {
                  action: "status",
                  ...f.target,
                  commandId: created!.command.commandId,
                },
                route,
              ),
              "not_found",
              created!.command.commandId,
            );
            const sameProjectNewInput = await f.input();
            failure(
              await f.call(
                {
                  action: "status",
                  ...f.target,
                  commandId: created!.command.commandId,
                },
                sameProjectNewInput,
              ),
              "forbidden",
              created!.command.commandId,
            );
            await assert.rejects(async () =>
              f.call(
                { action: "list" },
                { ...route, session_id: "forged-session" },
              ),
            );
          },
        );
        await t.test(
          "post-COMMIT loss keeps unknown; status/recover only query existing receipts and never invoke",
          async () => {
            const originals = f.authorRows("SELECT * FROM notes").length;
            f.control.dropNextInvoke = true;
            const envelope = f.envelope({
              action: "invoke",
              ...f.target,
              mode: "command",
              operationId: "notes.create",
              parameters: {
                title: "Lost receipt",
                markdown: "Private author commit",
              },
              resources: [],
            });
            const unknown = parseCognitiveAppCommandResult(
              success(await f.tools.call(envelope)),
            );
            assert.equal(unknown.command.state, "unknown");
            assert.equal(
              f.authorRows("SELECT * FROM notes").length,
              originals + 1,
            );
            const posts = f.paths("/invoke");
            const query = { ...f.target, commandId: unknown.command.commandId };
            const status = parseBrowserCommandFacts(
              success(await f.call({ action: "status", ...query })),
            );
            assert.equal(status.state, "unknown");
            assert.equal(f.paths("/invoke"), posts);
            const recovered = parseCognitiveAppCommandResult(
              success(await f.call({ action: "recover", ...query })),
            );
            assert.equal(recovered.command.state, "committed");
            assert.equal(f.paths("/invoke"), posts);
          },
        );
        await t.test(
          "grant revocation blocks fresh work but exact old write replays without pre-describe",
          async () => {
            await f.withHuman((actor) =>
              f.service.grant(actor, {
                appId: definition.id,
                version: definition.version,
                expectedRevision: 1,
                state: "disabled",
              }),
            );
            const posts = f.paths("/invoke");
            const replay = parseCognitiveAppCommandResult(
              success(await f.tools.call(accepted!)),
            );
            assert.equal(replay.command.state, "committed");
            assert.equal(f.paths("/invoke"), posts);
            const fresh = f.envelope({
              action: "invoke",
              ...f.target,
              mode: "command",
              operationId: "notes.create",
              parameters: { title: "Revoked", markdown: "Must not send" },
              resources: [],
            });
            failure(
              await f.tools.call(fresh),
              "forbidden",
              f.commandId(fresh.invocation),
            );
            failure(
              await f.call({
                action: "invoke",
                ...f.target,
                mode: "read",
                operationId: "notes.list",
                parameters: { limit: 1 },
                resources: [],
              }),
              "forbidden",
            );
            assert.equal(f.paths("/invoke"), posts);
            await f.withHuman((actor) =>
              f.service.grant(actor, {
                appId: definition.id,
                version: definition.version,
                expectedRevision: 2,
                state: "active",
              }),
            );
          },
        );
        await t.test(
          "grant and connection revoked after actual read response do not disclose old author data or resend",
          async () => {
            const read = {
              action: "invoke",
              ...f.target,
              mode: "read",
              operationId: "notes.list",
              parameters: { limit: 32 },
              resources: [],
            };
            f.control.afterResponse = async () => {
              f.control.afterResponse = undefined;
              await f.withHuman((actor) =>
                f.service.grant(actor, {
                  appId: definition.id,
                  version: definition.version,
                  expectedRevision: 3,
                  state: "disabled",
                }),
              );
            };
            let posts = f.paths("/invoke");
            failure(await f.call(read), "forbidden");
            assert.equal(f.paths("/invoke"), posts + 1);
            await f.withHuman((actor) =>
              f.service.grant(actor, {
                appId: definition.id,
                version: definition.version,
                expectedRevision: 4,
                state: "active",
              }),
            );
            f.control.afterResponse = async () => {
              f.control.afterResponse = undefined;
              await f.withHuman((actor) =>
                f.service.connectionState(actor, {
                  appId: definition.id,
                  version: definition.version,
                  connectionId: f.target.connectionId,
                  expectedRevision: 1,
                  state: "disabled",
                }),
              );
            };
            posts = f.paths("/invoke");
            failure(await f.call(read), "forbidden");
            assert.equal(f.paths("/invoke"), posts + 1);
            await f.withHuman((actor) =>
              f.service.connectionState(actor, {
                appId: definition.id,
                version: definition.version,
                connectionId: f.target.connectionId,
                expectedRevision: 2,
                state: "active",
              }),
            );
          },
        );
        await t.test(
          "legacy valid 500000-character Chinese document carrier is not limited by cognitive wire budget",
          async () => {
            const route = await f.input();
            const result = (await f.tools.call({
              ...f.envelope({ action: "list" }, route),
              arguments: {
                action: "create-document",
                title: "Legacy carrier synthetic",
                markdown: "汉".repeat(500000),
              },
            })) as { ok: boolean; contentId: string; versionRef: string };
            assert.equal(result.ok, true);
            const entry = await f.withHuman((actor) =>
              f.platform.content(actor, result.contentId),
            );
            assert.equal(entry.observed_version_ref, result.versionRef);
            const original = await f.withHuman((actor) =>
              f.domains.content.objects.readDocument({
                credential: actor.credential,
                objectId: entry.app_object_id,
              }),
            );
            assert.equal(original.content.markdown, "汉".repeat(500000));
          },
        );
        await t.test(
          "real fixed-generation guard is preserved and explicit source-kind conflicts cannot bypass it",
          async () => {
            await f.prepareFixedGeneration();
            const scope = await f.resolveScope(f.route);
            await assert.rejects(
              async () =>
                new PlatformAgentTools(f.domain).call(
                  f.route,
                  { ...scope, platformSource: "task-run" },
                  { action: "list" },
                ),
              /来源/,
            );
            const { platformSource: _kind, ...legacyScope } = scope;
            await assert.rejects(
              async () =>
                new PlatformAgentTools(f.domain).call(f.route, legacyScope, {
                  action: "list",
                }),
              /固定剧本生成/,
            );
            await assert.rejects(
              async () => f.call({ action: "list" }),
              /固定剧本生成/,
            );
            const route = await f.taskRoute();
            const task = f.envelope(
              {
                action: "invoke",
                ...f.target,
                mode: "command",
                operationId: "notes.create",
                parameters: {
                  title: "Scheduled original",
                  markdown: "Exact task-run",
                },
                resources: [],
              },
              route,
            );
            const result = parseCognitiveAppCommandResult(
              success(await f.tools.call(task)),
            );
            const durable = await f.withHuman((actor) =>
              f.platform.inspectCognitiveAppCommandDisclosure(actor, {
                projectId: f.projectId,
                commandId: result.command.commandId,
              }),
            );
            assert.equal(durable.command.actor.source.kind, "task-run");
            if (durable.command.actor.source.kind === "task-run") {
              assert.ok(durable.command.actor.source.sourceInputId);
              assert.ok(durable.command.actor.source.scheduleId);
            }
          },
        );
        f.assertNoLegacyData();
      } finally {
        await f.close();
      }
    },
  );
}
