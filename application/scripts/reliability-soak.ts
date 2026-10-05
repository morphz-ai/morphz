/** A continuously alive, real isolated Rust Runtime and embedded Host. The
 * local scripted model tests scheduling/transport/recovery, not LLM quality.
 * Retains all evidence even on success. Never opens a user's App or databases.
 *
 * node --import tsx scripts/reliability-soak.ts --duration-ms 28800000
 *   --interval-ms 60000 --output-parent /private/tmp --require-git-head HEAD
 */
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import {
  createServer as createNetServer,
  createConnection,
  type Socket,
} from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { localAccess, type Receipt } from "../packages/core/src/model.js";
import { objectToolName } from "../packages/core/src/application-names.js";
import { runtimeBinaryPath, repositoryRoot } from "./runtime-path.mjs";
import {
  assertRunComplete,
  assertTerminalRoot,
  positiveMilliseconds,
  requiredScenarios,
  type Scenario,
  type TerminalEvidence,
  observeVerifiedGap,
  runCleanupStages,
  cleanupOwnedProxyDirectory,
} from "./reliability-soak-model.js";

const exec = promisify(execFile);
const argumentsMap = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!,
    value = process.argv[i + 1];
  assert.ok(
    [
      "--duration-ms",
      "--interval-ms",
      "--output-parent",
      "--require-git-head",
    ].includes(key),
    `Unknown option ${key}`,
  );
  assert.ok(value, `Missing ${key} value`);
  assert.ok(!argumentsMap.has(key), `Duplicate ${key}`);
  argumentsMap.set(key, value);
}
const durationMs = positiveMilliseconds(
    argumentsMap.get("--duration-ms") ?? "28800000",
    "duration",
  ),
  intervalMs = positiveMilliseconds(
    argumentsMap.get("--interval-ms") ?? "60000",
    "interval",
  );
assert.ok(durationMs <= 86_400_000, "Run duration must be at most 24 hours");
const outputParent = resolve(argumentsMap.get("--output-parent") ?? tmpdir());
assert.ok(
  statSync(outputParent).isDirectory(),
  "Output parent must already exist",
);
const directory = mkdtempSync(join(outputParent, "morphz-reliability-soak-"));
const runtimeDirectory = join(directory, "runtime"),
  workDirectory = join(directory, "application"),
  profileDirectory = join(directory, "fixture-profile"),
  samplesDirectory = join(directory, "request-samples");
for (const path of [
  runtimeDirectory,
  workDirectory,
  profileDirectory,
  samplesDirectory,
])
  mkdirSync(path, { mode: 0o700 });
const tracePath = join(directory, "trace.jsonl"),
  resourcePath = join(directory, "resources.jsonl"),
  databasePath = join(runtimeDirectory, "runtime.sqlite"),
  token = randomBytes(32).toString("hex"),
  namespace = randomUUID();
const startedAt = new Date().toISOString(),
  monotonicStart = performance.now();
const coverage: Partial<Record<Scenario, number>> = {};
const trace = (event: string, value: unknown = {}) =>
  appendFileSync(
    tracePath,
    JSON.stringify({
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - monotonicStart),
      event,
      value,
    }) + "\n",
    { mode: 0o600 },
  );
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const redact = (value: string) => value.replaceAll(token, "[fixture-token]");
let runtime: ChildProcess | undefined,
  host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
let identityGeneration = "",
  runtimeURL = "",
  logTail = "",
  cycles = 0,
  providerCalls = 0;
let providerMode:
  "normal" | "gate" | "context" | "infer" | "disconnect" | "document" =
  "normal";
let providerRound = 0,
  responseMarker = "",
  supplementMarker = "",
  gateRequests: Array<{ response: ServerResponse; input: ProviderRequest }> =
    [];
let previousMaintenanceRoot: string | undefined,
  frameCreated = false;
let maintenanceRetired: string[] = [],
  lastProviderRequest: Buffer | undefined;
let closeRequested = false;
type ProviderRequest = {
  stream?: boolean;
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string }; name?: string }>;
};
type Delivery = {
  inputId: string;
  rootId: string | null;
  acceptedEventId?: string;
  state: string;
  request?: unknown;
  supplement?: string;
};
const commands: Array<{ command: unknown; receipt: Receipt; root?: string }> =
  [];
const roots = new Set<string>();
const expectedTerminals = new Map<string, string>();
// Validate the frozen build before creating the external Unix relay folder.
// A refused stale build must not leave an untracked relay endpoint behind.
const sourceBinary = runtimeBinaryPath(),
  frozenBinary = join(directory, "morphz-frozen");
assert.ok(existsSync(sourceBinary), "Build the compatible Runtime first");
copyFileSync(sourceBinary, frozenBinary);
const version = (
  await exec(frozenBinary, ["--version"], { timeout: 10_000 })
).stdout.trim();
const head = (
  await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
).stdout.trim();
const requireHead = argumentsMap.get("--require-git-head");
if (requireHead) {
  const expectedHead = (
    await exec("git", ["rev-parse", requireHead], { cwd: repositoryRoot })
  ).stdout.trim();
  assert.equal(head, expectedHead, "Checkout changed before run start");
  const embeddedHash = version.match(/git ([0-9a-f]+)/)?.[1];
  assert.ok(
    embeddedHash && expectedHead.startsWith(embeddedHash),
    "Runtime binary is not built from the required git head; rebuild before current-version soak",
  );
}
const proxyDirectory = mkdtempSync(
  join(
    process.platform === "darwin" ? "/private/tmp" : tmpdir(),
    "morphz-soak-proxy-",
  ),
);
const proxyPath = join(proxyDirectory, "tools.sock"),
  runtimeToolsManifest = join(directory, "runtime-host-tools.json");
let hostToolEndpoint = "",
  holdToolResponse = false;
let proxyFailure: Error | undefined;
const proxySockets = new Set<Socket>();
let heldToolReply:
  | {
      socket: Socket;
      bytes: Buffer;
      requestSha256: string;
      responseSha256: string;
      jobId: string;
    }
  | undefined;
// A fixture-only Unix relay forwards the exact production IPC envelope and
// response bytes. It can hold delivery after a real committed write; it never
// substitutes a domain call, result, authorization or database transaction.
const toolProxy = createNetServer((downstream) => {
  const upstream = createConnection(hostToolEndpoint);
  proxySockets.add(downstream);
  proxySockets.add(upstream);
  const requests: Buffer[] = [],
    responses: Buffer[] = [];
  let requestSize = 0,
    responseSize = 0;
  downstream.on("data", (chunk: Buffer) => {
    requestSize += chunk.length;
    if (requestSize > 4 * 1024 * 1024 + 4) {
      upstream.destroy();
      downstream.destroy();
      return;
    }
    requests.push(chunk);
    upstream.write(chunk);
  });
  downstream.on("end", () => upstream.end());
  downstream.on("error", () => upstream.destroy());
  downstream.on("close", () => upstream.destroy());
  upstream.on("error", () => downstream.destroy());
  for (const socket of [downstream, upstream])
    socket.on("close", () => proxySockets.delete(socket));
  upstream.on("data", (chunk: Buffer) => {
    responseSize += chunk.length;
    if (responseSize > 2 * 1024 * 1024 + 4) {
      upstream.destroy();
      downstream.destroy();
      return;
    }
    if (holdToolResponse) responses.push(chunk);
    else downstream.write(chunk);
  });
  upstream.on("end", () => {
    try {
      if (!holdToolResponse) {
        downstream.end();
        return;
      }
      const requestBytes = Buffer.concat(requests),
        responseBytes = Buffer.concat(responses);
      assert.ok(!heldToolReply, "One exact committed IPC response may be held");
      assert.ok(requestBytes.length >= 4 && responseBytes.length >= 4);
      assert.equal(requestBytes.readUInt32BE(0), requestBytes.length - 4);
      assert.equal(responseBytes.readUInt32BE(0), responseBytes.length - 4);
      const requestEnvelope = JSON.parse(requestBytes.subarray(4).toString()),
        responseEnvelope = JSON.parse(responseBytes.subarray(4).toString());
      assert.equal(responseEnvelope.protocol, 1);
      assert.equal(responseEnvelope.ok, true);
      assert.equal(
        responseEnvelope.value.ok,
        true,
        "Only a real successful production Host write can satisfy the hold",
      );
      heldToolReply = {
        socket: downstream,
        bytes: responseBytes,
        requestSha256: sha(requestBytes),
        responseSha256: sha(responseBytes),
        jobId: requestEnvelope.request.invocation.job_id,
      };
      trace("actual-committed-host-response-held", {
        requestSha256: heldToolReply.requestSha256,
        responseSha256: heldToolReply.responseSha256,
        jobId: heldToolReply.jobId,
        responseByteLength: responseBytes.length,
      });
    } catch (error) {
      proxyFailure = error instanceof Error ? error : new Error(String(error));
      trace("proxy-fault", { message: proxyFailure.message });
      downstream.destroy();
      upstream.destroy();
    }
  });
});
function releaseHostToolResponse() {
  holdToolResponse = false;
  const held = heldToolReply;
  heldToolReply = undefined;
  if (!held) return;
  trace("original-host-response-released", {
    responseSha256: held.responseSha256,
    jobId: held.jobId,
    socketDestroyed: held.socket.destroyed,
  });
  if (!held.socket.destroyed) held.socket.end(held.bytes);
}
const continuityBudgetMs = Math.max(intervalMs * 3, 180_000);
let lastVerifiedAtMs = Date.now(),
  maximumVerifiedGapMs = 0;

function sql<T = Record<string, unknown>>(
  query: string,
  ...parameters: SQLInputValue[]
): T[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare(query)
      .all(...parameters)
      .map((row) => ({ ...row })) as T[];
  } finally {
    db.close();
  }
}
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(runtimeURL + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  assert.ok(
    response.ok,
    `${path}: ${response.status} ${redact(await response.clone().text())}`,
  );
  return response.json() as Promise<any>;
}
async function wait(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 90_000,
) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (proxyFailure) throw proxyFailure;
    if (closeRequested)
      throw new Error("Run interrupted before requested duration");
    if (await check()) return;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(`Owned Runtime exited during ${label}: ${logTail}`);
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const toolNames = (input: ProviderRequest) =>
  input.tools?.map((tool) => tool.function?.name ?? tool.name) ?? [];
function respond(
  response: ServerResponse,
  input: ProviderRequest,
  selectedTool?: { name: string; arguments: unknown },
  content = "SOAK_REPLY_COMPLETE",
) {
  if (response.destroyed) {
    trace("provider-abandoned-response");
    return;
  }
  if (!selectedTool && toolNames(input).includes("reply"))
    selectedTool = {
      name: "reply",
      arguments: {
        content,
        annotations: {
          execution: {
            title: "合成长期运行验证",
            result: "独立测试工作已结束",
          },
        },
      },
    };
  const call = selectedTool
    ? {
        id: randomUUID(),
        type: "function",
        function: {
          name: selectedTool.name,
          arguments: JSON.stringify(selectedTool.arguments),
        },
      }
    : undefined;
  const message = call
    ? { role: "assistant", content: "", tool_calls: [call] }
    : { role: "assistant", content };
  trace("provider-response", {
    tool: selectedTool?.name ?? null,
    contentSha: sha(content),
  });
  if (input.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: randomUUID(),
        choices: [
          { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  }
}
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "soak-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks),
      input = JSON.parse(bytes.toString()) as ProviderRequest;
    lastProviderRequest = bytes;
    assert.ok(Array.isArray(input.messages));
    const sequence = ++providerCalls,
      text = JSON.stringify(input.messages),
      round = providerRound++;
    trace("provider-request", {
      sequence,
      mode: providerMode,
      round,
      sha256: sha(bytes),
      byteLength: bytes.length,
      offeredTools: toolNames(input),
      currentMarker: responseMarker,
    });
    if (
      sequence <= 32 ||
      (cycles % 60 === 1 &&
        (providerMode === "disconnect" || providerMode === "gate"))
    )
      writeFileSync(join(samplesDirectory, `${sequence}.json`), bytes, {
        mode: 0o600,
        flag: "wx",
      });
    if (providerMode === "gate") {
      gateRequests.push({ response, input });
      return;
    }
    if (providerMode === "disconnect" && round === 0) {
      trace("injected-provider-socket-disconnect", { sequence });
      request.socket.destroy();
      return;
    }
    if (providerMode === "context" && round === 0) {
      assert.ok(
        toolNames(input).includes("context_tx"),
        "Production Context tool must be offered",
      );
      const sessions = sql<{ context_id: string; id: string }>(
        "SELECT id,context_id FROM sessions WHERE title NOT LIKE '%Task%' ORDER BY rowid LIMIT 1",
      );
      assert.ok(sessions.length);
      const context = await api(
        `/api/sessions/${encodeURIComponent(sessions[0]!.id)}/context`,
      );
      const retired: string[] = context.state.retired ?? [];
      // Only already visible, terminal-owned synthetic observations are eligible.
      // The current root and every live activation remain causally protected.
      maintenanceRetired = (context.observations as Array<{ id: string }>)
        .filter((observation) => {
          if (retired.includes(observation.id)) return false;
          const owner = sql<{ status: string }>(
            "SELECT t.status FROM events e JOIN threads t ON t.root_turn_id=e.root_turn_id WHERE e.id=?",
            observation.id,
          );
          return (
            owner.length === 1 &&
            ["completed", "failed", "cancelled"].includes(owner[0]!.status)
          );
        })
        .map((observation) => observation.id)
        .slice(0, 100);
      const retire = maintenanceRetired
        .map((id) => ` (retire ${JSON.stringify(id)})`)
        .join("");
      const operation = frameCreated ? "revise" : "create";
      const transaction = `(context-tx (base-version ${context.state.version}) (reason "controlled soak maintenance, not autonomous cognition") (${operation} soak-baseline (kind "fixture") (understanding "Stable fact SOAK_BASELINE_9090"))${retire})`;
      trace("scripted-context-transaction", {
        transaction,
        retiredObservationIds: maintenanceRetired,
      });
      respond(response, input, {
        name: "context_tx",
        arguments: { transaction },
      });
      return;
    }
    if (providerMode === "infer") {
      if (!toolNames(input).includes("eval")) {
        respond(response, input, undefined, "42");
        return;
      }
      if (round === 0) {
        respond(response, input, {
          name: "eval",
          arguments: { program: "(eval (infer (returns Int) 42))" },
        });
        return;
      }
    }
    if (providerMode === "document" && round === 0) {
      assert.ok(
        toolNames(input).includes(objectToolName),
        "Production Host object tool is offered",
      );
      respond(response, input, {
        name: objectToolName,
        arguments: {
          action: "create-document",
          title: responseMarker,
          markdown: `Exact persisted body ${responseMarker}`,
        },
      });
      return;
    }
    const adopted = !!supplementMarker && text.includes(supplementMarker);
    respond(
      response,
      input,
      undefined,
      adopted
        ? `${responseMarker}: STEERING_ADOPTED`
        : `${responseMarker}: COMPLETE`,
    );
  } catch (error) {
    trace("provider-fixture-error", { message: String(error) });
    response.writeHead(500).end("Controlled provider rejected request");
  }
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}
const gitStatus = (
  await exec("git", ["status", "--short"], { cwd: repositoryRoot })
).stdout;
const diff = (
  await exec("git", ["diff", "--binary", "HEAD"], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  })
).stdout;
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(
    {
      format: "morphz-reliability-soak/v1",
      startedAt,
      durationMs,
      intervalMs,
      head,
      gitStatus,
      dirtyDiffSha256: sha(diff),
      harnessSha256: sha(readFileSync(new URL(import.meta.url))),
      oracleSha256: sha(
        readFileSync(new URL("./reliability-soak-model.ts", import.meta.url)),
      ),
      binary: {
        sourcePath: sourceBinary,
        frozenPath: frozenBinary,
        version,
        sha256: sha(readFileSync(frozenBinary)),
        requiredHead: requireHead ?? null,
      },
      scope:
        "isolated real Runtime + embedded Host + local scripted model; SQLite only",
      exclusions: [
        "paid/live model quality",
        "user App/profile/Runtime",
        "native Electron window/OS quit",
        "PostgreSQL soak",
        "cross-host failover",
        "third-party real accounts",
        "autonomous Context summary quality",
      ],
      requestedScenarios: requiredScenarios,
      cadence: {
        workloadEveryCycle: [
          "parallel-steering",
          "context-transaction",
          "durable-infer",
          "scheduled-task",
          "host-tool-write",
        ],
        providerFaultEveryCycles: 5,
        hostReopenEveryCycles: 15,
        runtimeCrashEveryCycles: 60,
        firstCycleCoversAll: true,
      },
      fixtureUnixRelayDirectory: proxyDirectory,
      fixtureBudgets: {
        maximumProcessRssKiB: 2 * 1024 * 1024,
        maximumOpenNumericDescriptors: 512,
        maximumDatabaseBytes: 1024 * 1024 * 1024,
        maximumVerifiedGapMs: continuityBudgetMs,
      },
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    event: "started",
    directory,
    startedAt,
    durationMs,
    intervalMs,
    binaryVersion: version,
  }),
);
trace("manifest-recorded", { head, binaryVersion: version });
const runtimePort = await freePort();
runtimeURL = `http://127.0.0.1:${runtimePort}`;
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const providerPort = (provider.address() as { port: number }).port;
writeFileSync(
  join(workDirectory, "runtime.json"),
  JSON.stringify({ url: runtimeURL, token, namespace }),
  { mode: 0o600 },
);
const configFile = join(runtimeDirectory, "morphz.toml");
writeFileSync(
  configFile,
  `[llm]\nmodel="soak-model"\n[orchestrator]\nactivation_lease_secs=8\nmodel_attempt_hard_timeout_secs=45\ncontext_hard_token_limit=128000\ncontext_soft_token_limit=96000\n[accounts.soak]\nauth_adapter="credential"\ncredential_ref="soak"\nprovider="soak"\n[services.soak]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["soak"]\n[[models.soak-model.targets]]\nservice="soak"\naccount="soak"\nphysical_model="soak-model"\ncapabilities=["tools"]\n[credentials.soak]\nsource="env"\nname="MORPHZ_RELIABILITY_SOAK_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n`,
  { mode: 0o600 },
);
// Do not inherit the user's env file, service endpoints or model credentials.
for (const name of Object.keys(process.env))
  if (
    /^(MORPHZ_APP_|MORPHZWORK_|DOUBAO_|OPENAI_|ANTHROPIC_|GEMINI_|MORPHZ_COGNITIVE_)/.test(
      name,
    )
  )
    delete process.env[name];
process.env.MORPHZ_APP_ENV_FILE = "";

async function startRuntime() {
  runtime = spawn(
    frozenBinary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${runtimePort}`,
      "--cwd",
      runtimeDirectory,
      "--config-file",
      configFile,
      "--log-level",
      "warn",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: runtimeDirectory,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        MORPHZ_HOME: runtimeDirectory,
        MORPHZ_STORAGE_SQLITE_PATH: databasePath,
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_HOST_TOOLS_FILE: runtimeToolsManifest,
        MORPHZ_RELIABILITY_SOAK_KEY: "synthetic-test-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream?.on("data", (chunk: Buffer) => {
      const text = redact(chunk.toString());
      logTail = (logTail + text).slice(-32_000);
      appendFileSync(join(directory, "runtime.log"), text, { mode: 0o600 });
    });
  trace("runtime-started", { pid: runtime.pid });
  await wait(
    async () => {
      try {
        return (
          await fetch(runtimeURL + "/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    "Runtime health",
    45_000,
  );
}
async function stopRuntime(crash = false) {
  const child = runtime;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(
    child.pid && child.pid !== 68670,
    "Never signal a pre-existing Runtime",
  );
  trace(crash ? "injected-runtime-crash" : "runtime-stop", {
    ownedPid: child.pid,
  });
  const ended = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill(crash ? "SIGKILL" : "SIGTERM");
  await Promise.race([ended, pause(10_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    trace("owned-runtime-cleanup-escalation", { ownedPid: child.pid });
    child.kill("SIGKILL");
    await Promise.race([ended, pause(5000)]);
  }
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "Owned Runtime did not exit",
  );
  runtime = undefined;
}
async function openHost() {
  host = await openEmbeddedApplication(workDirectory, profileDirectory);
  const manifest = JSON.parse(readFileSync(host.manifestPath!, "utf8"));
  hostToolEndpoint = manifest.tools[0].ipc_path;
  for (const tool of manifest.tools) tool.ipc_path = proxyPath;
  writeFileSync(runtimeToolsManifest, JSON.stringify(manifest), {
    mode: 0o600,
  });
  identityGeneration = (
    (await host.connection.call("platform.bootstrap")) as { csrfToken: string }
  ).csrfToken;
  trace("host-opened", {
    center: host.connection.application.store.identity(),
    manifestPath: host.manifestPath,
  });
}
async function call<T>(method: string, parameters: unknown): Promise<T> {
  return host!.connection.call(method as any, parameters, {
    identityGeneration,
  }) as Promise<T>;
}
function deliveries(): Delivery[] {
  return (
    host!.connection.application.store.runtimeState() as {
      deliveries: Delivery[];
    }
  ).deliveries;
}
function mode(value: typeof providerMode, marker: string) {
  assert.equal(
    gateRequests.length,
    0,
    "No previous gated response may leak into next scene",
  );
  providerMode = value;
  providerRound = 0;
  responseMarker = marker;
  supplementMarker = "";
  trace("scene-mode", { value, marker });
}
function releaseGate() {
  providerMode = "normal";
  for (const held of gateRequests.splice(0)) {
    const adopted =
      !!supplementMarker &&
      JSON.stringify(held.input.messages).includes(supplementMarker);
    respond(
      held.response,
      held.input,
      undefined,
      adopted
        ? `${responseMarker}: STEERING_ADOPTED`
        : `${responseMarker}: COMPLETE`,
    );
  }
}
async function input(
  body: string,
  continuation?: unknown,
  conversationId = "soak-project",
  createConversation = false,
) {
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: "soak-project",
      conversationId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body,
      targetActantId: "morphz-agent",
      ...(continuation ? { continuation } : {}),
      ...(createConversation
        ? { newConversation: { title: "TEST second soak Session" } }
        : {}),
    },
  };
  const receipt = await call<Receipt>("platform.message", command);
  commands.push({ command, receipt });
  trace("host-input-accepted", { command, receipt });
  return { command, receipt };
}
async function rootOf(receipt: Receipt) {
  let root = "";
  await wait(() => {
    root =
      deliveries().find((delivery) => delivery.inputId === receipt.entityId)
        ?.rootId ?? "";
    return !!root;
  }, "persisted Host root");
  roots.add(root);
  const recorded = commands.find(
    (entry) => entry.receipt.entityId === receipt.entityId,
  );
  if (recorded) recorded.root = root;
  trace("root-bound", { inputId: receipt.entityId, root });
  return root;
}
function terminalEvidence(root: string): TerminalEvidence {
  const threads = sql<TerminalEvidence["threads"][number]>(
    "SELECT id,root_turn_id,generation,status FROM threads WHERE root_turn_id=?",
    root,
  );
  return {
    threads,
    outcomes: sql(
      "SELECT thread_id,root_turn_id,thread_generation,terminal_kind FROM thread_outcomes WHERE root_turn_id=?",
      root,
    ),
    liveActivations: sql(
      "SELECT id,status,root_turn_id FROM thread_activations WHERE root_turn_id=? AND status IN ('queued','running')",
      root,
    ),
    pendingSignals: threads.length
      ? sql(
          "SELECT id,event_id,status FROM thread_signals WHERE thread_id=? AND status='pending'",
          threads[0]!.id,
        )
      : [],
  };
}
async function terminal(root: string, allowed = ["completed"]) {
  await wait(() => {
    const evidence = terminalEvidence(root);
    return (
      evidence.threads.length === 1 &&
      allowed.includes(evidence.threads[0]!.status) &&
      evidence.outcomes.length === 1 &&
      !evidence.liveActivations.length &&
      !evidence.pendingSignals.length
    );
  }, `terminal root ${root}`);
  const evidence = terminalEvidence(root);
  assertTerminalRoot(root, evidence, allowed);
  const actualStatus = evidence.threads[0]!.status;
  if (expectedTerminals.has(root))
    assert.equal(
      actualStatus,
      expectedTerminals.get(root),
      "A verified terminal root cannot change its outcome",
    );
  expectedTerminals.set(root, actualStatus);
  trace("terminal-root-verified", {
    root,
    evidence,
    signals: sql(
      "SELECT id,event_id,status,thread_generation FROM thread_signals WHERE thread_id=?",
      evidence.threads[0]!.id,
    ),
    activations: sql(
      "SELECT id,root_turn_id,status,generation,trigger_event_id FROM thread_activations WHERE root_turn_id=?",
      root,
    ),
  });
  return evidence.threads[0]!;
}
function covered(scenario: Scenario, evidence: unknown) {
  coverage[scenario] = (coverage[scenario] ?? 0) + 1;
  trace("scenario-verified", {
    scenario,
    occurrence: coverage[scenario],
    evidence,
  });
}
async function history(conversationId = "soak-project") {
  return (
    await host!.connection.application.options.runtime!.platformConversationHistory(
      { projectId: "soak-project", conversationId },
      localAccess,
    )
  ).runtime;
}
async function steeringScene(cycle: number) {
  const marker = `SOAK_PARALLEL_${cycle}`;
  mode("gate", marker);
  const a = await input(`${marker}_A: work A`),
    b = await input(
      `${marker}_B: work B`,
      undefined,
      "soak-second",
      cycle === 1,
    );
  const aRoot = await rootOf(a.receipt),
    bRoot = await rootOf(b.receipt);
  await wait(
    () => gateRequests.filter((held) => !held.response.destroyed).length >= 2,
    "two actual parallel HTTP requests",
  );
  let continuation: unknown;
  await wait(async () => {
    continuation = (await history()).activity?.threads.find(
      (thread) => thread.inputId === a.receipt.entityId,
    )?.continuation;
    return !!continuation;
  }, "exact A steering destination");
  supplementMarker = `${marker}_STEER_A_ONLY`;
  const steer = await input(supplementMarker, continuation);
  await wait(
    () =>
      deliveries().find(
        (delivery) => delivery.inputId === steer.receipt.entityId,
      )?.supplement === "delivered",
    "steering accepted by exact root",
  );
  assert.equal(
    deliveries().find((delivery) => delivery.inputId === steer.receipt.entityId)
      ?.rootId,
    null,
    "Steering must not create an independent response root",
  );
  releaseGate();
  await terminal(aRoot);
  await terminal(bRoot);
  await wait(async () => {
    const value = await history();
    const other = await history("soak-second");
    return (
      value.messages.some(
        (message) =>
          message.inputId === a.receipt.entityId &&
          message.kind === "reply" &&
          message.text.includes("STEERING_ADOPTED"),
      ) &&
      other.messages.some(
        (message) =>
          message.inputId === b.receipt.entityId && message.kind === "reply",
      )
    );
  }, "steered A and independent B Host replies");
  const view = await history(),
    other = await history("soak-second");
  assert.ok(
    other.messages
      .filter((message) => message.inputId === b.receipt.entityId)
      .every((message) => !message.text.includes("STEERING_ADOPTED")),
    "B cannot consume A-only steering",
  );
  assert.ok(
    view.messages.every(
      (message) => message.inputId !== steer.receipt.entityId,
    ),
    "Steering is not a new response root",
  );
  assert.deepEqual(
    await call<Receipt>("platform.message", steer.command),
    steer.receipt,
    "Original steering retry returns same receipt",
  );
  covered("parallel-steering", {
    aRoot,
    bRoot,
    steerInput: steer.receipt.entityId,
  });
  supplementMarker = "";
}
async function contextScene(cycle: number) {
  mode("context", `SOAK_CONTEXT_${cycle}`);
  const accepted = await input(responseMarker),
    root = await rootOf(accepted.receipt);
  await terminal(root);
  const sessions = sql<{ id: string }>(
    "SELECT id FROM sessions WHERE title NOT LIKE '%Task%' ORDER BY rowid LIMIT 1",
  );
  const context = await api(
    `/api/sessions/${encodeURIComponent(sessions[0]!.id)}/context`,
  );
  assert.ok(
    JSON.stringify(context.state).includes("SOAK_BASELINE_9090"),
    "Controlled Context transaction must persist stable fact",
  );
  assert.ok(
    context.state.frames.some(
      (frame: { id: string }) => frame.id === "soak-baseline",
    ),
  );
  if (previousMaintenanceRoot)
    assert.ok(
      context.state.retired.includes(previousMaintenanceRoot),
      "Consumed old observation retirement must be committed",
    );
  frameCreated = true;
  previousMaintenanceRoot = root;
  covered("context-transaction", {
    root,
    contextVersion: context.state.version,
    stableFact: "SOAK_BASELINE_9090",
    retiredPreviousObservation: cycle > 1,
    retiredObservationIds: maintenanceRetired,
  });
}
async function inferScene(cycle: number) {
  mode("infer", `SOAK_INFER_${cycle}`);
  const accepted = await input(responseMarker),
    root = await rootOf(accepted.receipt);
  await terminal(root);
  const children = sql<{ root_turn_id: string; id: string }>(
    "SELECT t.id,t.root_turn_id FROM threads t JOIN events e ON e.id=t.root_turn_id WHERE t.executor_kind='plan_infer' AND json_extract(e.payload,'$.parent_thread_id')=(SELECT id FROM threads WHERE root_turn_id=?)",
    root,
  );
  assert.equal(children.length, 1, "Actual durable infer child must exist");
  await terminal(children[0]!.root_turn_id);
  const plans = sql<{ id: string; status: string; result_json: string }>(
    "SELECT id,status,result_json FROM plan_executions WHERE thread_id=(SELECT id FROM threads WHERE root_turn_id=?)",
    root,
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.status, "succeeded");
  assert.ok(
    String(plans[0]!.result_json).includes("42"),
    "Actual typed infer result must persist",
  );
  roots.add(children[0]!.root_turn_id);
  covered("durable-infer", {
    root,
    childRoot: children[0]!.root_turn_id,
    plans,
  });
}
async function taskScene(cycle: number) {
  mode("normal", `SOAK_TASK_${cycle}`);
  const taskId = `soak-task-${cycle}`;
  const future = new Date(Date.now() + 1500).toISOString();
  await call("tasks.create", {
    commandId: randomUUID(),
    taskId,
    projectId: "soak-project",
    title: responseMarker,
    assigneeId: "morphz-agent",
    notBefore: future,
  });
  const admission = await call<{ eventId: string }>("tasks.run-request", {
    commandId: randomUUID(),
    taskId,
    expectedRevision: 1,
  });
  let root = "";
  await wait(() => {
    const threads = sql<{ root_turn_id: string }>(
      "SELECT root_turn_id FROM threads WHERE root_turn_id LIKE 'client-schedule-%' AND root_turn_id NOT IN (SELECT root_turn_id FROM thread_outcomes) ORDER BY rowid DESC LIMIT 1",
    );
    root = threads[0]?.root_turn_id ?? "";
    return !!root;
  }, "real queued task Thread");
  const before = sql<{ status: string; not_before: string }>(
    "SELECT status,not_before FROM schedules WHERE id=?",
    root.replace("client-schedule-", ""),
  );
  assert.equal(before.length, 1);
  assert.equal(Date.parse(before[0]!.not_before), Date.parse(future));
  assert.ok(["queued", "dispatched", "completed"].includes(before[0]!.status));
  roots.add(root);
  await terminal(root);
  covered("scheduled-task", {
    taskId,
    admission,
    root,
    persistedNotBefore: before[0]!.not_before,
  });
}
async function faultScene(cycle: number) {
  mode("disconnect", `SOAK_NETWORK_${cycle}`);
  const beforeCalls = providerCalls;
  const accepted = await input(responseMarker),
    root = await rootOf(accepted.receipt);
  const result = await terminal(root);
  assert.ok(
    providerCalls - beforeCalls >= 2,
    "The actual transient socket failure must be retried before completion",
  );
  covered("provider-disconnect", {
    root,
    status: result.status,
    attempts: providerCalls - beforeCalls,
    fault: "first owned Provider TCP socket destroyed",
  });
  mode("normal", `SOAK_NETWORK_AFTER_${cycle}`);
  const next = await input(responseMarker);
  await terminal(await rootOf(next.receipt));
}
async function documentScene(cycle: number) {
  mode("document", `SOAK_DOCUMENT_${cycle}`);
  const marker = responseMarker,
    accepted = await input(`Create the controlled test document ${marker}`),
    root = await rootOf(accepted.receipt);
  await terminal(root);
  const jobs = sql<{
    id: string;
    tool_call_id: string;
    status: string;
    result_event_id: string;
  }>(
    "SELECT id,tool_call_id,status,result_event_id FROM execution_jobs WHERE thread_id=(SELECT id FROM threads WHERE root_turn_id=?) AND tool_name=?",
    root,
    objectToolName,
  );
  assert.equal(
    jobs.length,
    1,
    "Exactly one real physical Host Job must own the write",
  );
  assert.equal(jobs[0]!.status, "succeeded");
  const result = sql<{ payload: string }>(
    "SELECT payload FROM events WHERE id=?",
    jobs[0]!.result_event_id,
  );
  assert.equal(result.length, 1);
  const output = JSON.parse(result[0]!.payload);
  assert.equal(output.tool_status, "success");
  assert.equal(output.root_turn_id, root);
  const client = await PlatformClient.connect(host!.connection);
  const content = (
    await client.content({
      projectId: "soak-project",
      query: marker,
      limit: 10,
    })
  ).items.filter((entry) => entry.title === marker);
  assert.equal(
    content.length,
    1,
    "One authorized original exists, not a copied reply",
  );
  const original = (await client.readDocument(content[0]!.id, 1)) as {
    contentId: string;
    projectId: string;
    revision: number;
    title: string;
    markdown: string;
    author: { principalId: string; actantId: string };
  };
  assert.equal(original.contentId, content[0]!.id);
  assert.equal(original.projectId, "soak-project");
  assert.equal(original.revision, 1);
  assert.equal(original.title, marker);
  assert.equal(original.markdown, `Exact persisted body ${marker}`);
  assert.equal(original.author.actantId, "morphz-agent");
  assert.equal(original.author.principalId, localAccess.principalId);
  const provenance = (
    await client.contentDeliveries([accepted.receipt.entityId])
  ).filter((delivery) => delivery.contentId === original.contentId);
  assert.equal(
    provenance.length,
    1,
    "Exactly one persisted Host provenance receipt",
  );
  assert.equal(provenance[0]!.inputId, accepted.receipt.entityId);
  assert.equal(provenance[0]!.projectId, "soak-project");
  assert.equal(provenance[0]!.sourceProjectId, "soak-project");
  assert.equal(provenance[0]!.versionRef, "1");
  const beforeCalls = providerCalls;
  assert.deepEqual(
    await call<Receipt>("platform.message", accepted.command),
    accepted.receipt,
  );
  await pause(1200);
  assert.equal(
    providerCalls,
    beforeCalls,
    "Retrying accepted command cannot call the model again",
  );
  assert.deepEqual(
    sql(
      "SELECT id,tool_call_id,status,result_event_id FROM execution_jobs WHERE thread_id=(SELECT id FROM threads WHERE root_turn_id=?) AND tool_name=?",
      root,
      objectToolName,
    ),
    jobs,
  );
  assert.deepEqual(await client.readDocument(original.contentId, 1), original);
  assert.equal(
    (
      await client.content({
        projectId: "soak-project",
        query: marker,
        limit: 10,
      })
    ).items.filter((entry) => entry.title === marker).length,
    1,
  );
  covered("host-tool-write", {
    root,
    inputId: accepted.receipt.entityId,
    contentId: original.contentId,
    jobs,
    provenance,
    bodySha256: sha(original.markdown),
    retriedOriginalCommand: true,
  });
}
async function hostReopenScene(cycle: number) {
  mode("document", `SOAK_HOST_${cycle}`);
  const marker = responseMarker;
  holdToolResponse = true;
  const accepted = await input(responseMarker),
    root = await rootOf(accepted.receipt);
  await wait(
    () => !!heldToolReply,
    "actual production write committed and original IPC response held",
  );
  const held = heldToolReply!;
  const client = await PlatformClient.connect(host!.connection);
  const content = (
    await client.content({
      projectId: "soak-project",
      query: marker,
      limit: 10,
    })
  ).items.filter((entry) => entry.title === marker);
  assert.equal(content.length, 1, "Commit must be proven before closing Host");
  const original = await client.readDocument(content[0]!.id, 1);
  assert.equal(
    sql<{ status: string }>(
      "SELECT status FROM execution_jobs WHERE id=?",
      held.jobId,
    )[0]!.status,
    "running",
    "Runtime still waits on the held actual IPC response",
  );
  const center = host!.connection.application.store.identity(),
    pid = runtime!.pid;
  await host!.close();
  host = undefined;
  releaseHostToolResponse();
  await terminal(root);
  assert.equal(runtime!.pid, pid, "Host close must not stop Runtime");
  await openHost();
  assert.equal(host!.connection.application.store.identity(), center);
  await wait(
    () => host!.connection.application.options.runtime!.isConnected,
    "reopened Host connection",
  );
  assert.deepEqual(
    await call<Receipt>("platform.message", accepted.command),
    accepted.receipt,
  );
  await wait(
    () =>
      deliveries().find(
        (delivery) => delivery.inputId === accepted.receipt.entityId,
      )?.state === "completed",
    "Host reconciles original root after offline completion",
  );
  const reopened = await PlatformClient.connect(host!.connection);
  assert.deepEqual(await reopened.readDocument(content[0]!.id, 1), original);
  assert.equal(
    (
      await reopened.content({
        projectId: "soak-project",
        query: marker,
        limit: 10,
      })
    ).items.filter((entry) => entry.title === marker).length,
    1,
  );
  const provenance = (
    await reopened.contentDeliveries([accepted.receipt.entityId])
  ).filter((delivery) => delivery.contentId === content[0]!.id);
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0]!.versionRef, "1");
  assert.equal(provenance[0]!.inputId, accepted.receipt.entityId);
  assert.equal(
    sql<{ status: string }>(
      "SELECT status FROM execution_jobs WHERE id=?",
      held.jobId,
    )[0]!.status,
    "succeeded",
  );
  covered("host-reopen", {
    root,
    originalCommandId: accepted.command.commandId,
    unchangedRuntimePid: pid,
    center,
    committedContentId: content[0]!.id,
    physicalJobId: held.jobId,
    heldResponseSha256: held.responseSha256,
    scenario:
      "production write commits, exact Unix response held, Host closes, original response released, Runtime finishes offline, same Host reopens",
  });
}
async function crashScene(cycle: number) {
  mode("gate", `SOAK_CRASH_${cycle}`);
  const accepted = await input(responseMarker),
    root = await rootOf(accepted.receipt);
  await wait(
    () => gateRequests.some((held) => !held.response.destroyed),
    "real request before Runtime crash",
  );
  const oldPid = runtime!.pid;
  await stopRuntime(true);
  releaseGate();
  await startRuntime();
  assert.notEqual(runtime!.pid, oldPid);
  await terminal(root);
  assert.deepEqual(
    await call<Receipt>("platform.message", accepted.command),
    accepted.receipt,
  );
  const session = sql<{ session_id: string }>(
    "SELECT session_id FROM threads WHERE root_turn_id=?",
    root,
  )[0]!;
  const context = await api(
    `/api/sessions/${encodeURIComponent(session.session_id)}/context`,
  );
  assert.ok(
    JSON.stringify(context.state).includes("SOAK_BASELINE_9090"),
    "Context fact must survive real process restart",
  );
  covered("runtime-crash-recovery", {
    root,
    oldPid,
    newPid: runtime!.pid,
    stableFact: "SOAK_BASELINE_9090",
  });
}
async function resourceSample() {
  const nowMs = Date.now();
  maximumVerifiedGapMs = observeVerifiedGap(
    nowMs,
    lastVerifiedAtMs,
    maximumVerifiedGapMs,
    continuityBudgetMs,
  );
  lastVerifiedAtMs = nowMs;
  const runtimePid = runtime?.pid;
  const processStats: Record<string, unknown> = {};
  for (const [name, pid] of [
    ["harness", process.pid],
    ["runtime", runtimePid],
  ] as const) {
    if (!pid) continue;
    const { stdout } = await exec(
      "ps",
      ["-p", String(pid), "-o", "pid=,rss=,%cpu=,etime="],
      { timeout: 5000 },
    );
    const fields = stdout.trim().split(/\s+/);
    assert.equal(Number(fields[0]), pid, `${name} process is alive`);
    const rssKiB = Number(fields[1]);
    assert.ok(
      rssKiB < 2 * 1024 * 1024,
      `${name} exceeded 2 GiB RSS fixture budget`,
    );
    let fdCount: number | null = null;
    try {
      const { stdout: descriptors } = await exec(
        "lsof",
        ["-n", "-P", "-p", String(pid), "-F", "f"],
        { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
      );
      fdCount = descriptors
        .split("\n")
        .filter((line) => /^f\d/.test(line)).length;
      assert.ok(
        fdCount < 512,
        `${name} exceeded 512 open descriptor fixture budget`,
      );
    } catch (error) {
      if (String(error).includes("exceeded")) throw error;
      trace("resource-capability-unavailable", {
        name,
        metric: "fdCount",
        message: String(error),
      });
    }
    processStats[name] = {
      pid,
      rssKiB,
      cpuPercent: Number(fields[2]),
      elapsed: fields.slice(3).join(" "),
      fdCount,
    };
  }
  const files: Array<{ path: string; byteLength: number }> = [];
  function scan(path: string) {
    for (const file of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, file.name);
      if (file.isDirectory()) scan(child);
      else if (file.isFile() && /\.sqlite(?:-(?:wal|shm))?$/.test(file.name))
        files.push({
          path: child.slice(directory.length + 1),
          byteLength: statSync(child).size,
        });
    }
  }
  scan(runtimeDirectory);
  scan(workDirectory);
  const databaseBytes = files.reduce((sum, file) => sum + file.byteLength, 0);
  assert.ok(
    databaseBytes < 1024 * 1024 * 1024,
    "Fixture databases exceeded 1 GiB budget",
  );
  const counts: Record<string, number> = {};
  for (const table of [
    "events",
    "threads",
    "thread_outcomes",
    "thread_signals",
    "thread_activations",
    "execution_jobs",
    "plan_executions",
    "schedules",
  ])
    counts[table] = Number(
      sql<{ total: number }>(`SELECT COUNT(*) total FROM ${table}`)[0]!.total,
    );
  const sample = {
    at: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - monotonicStart),
    cycle: cycles,
    providerCalls,
    processStats,
    harnessMemory: process.memoryUsage(),
    databaseBytes,
    files,
    counts,
  };
  appendFileSync(resourcePath, JSON.stringify(sample) + "\n", { mode: 0o600 });
  trace("resource-sample", { providerCalls, databaseBytes, counts });
}
function globalInvariants() {
  assert.deepEqual(
    sql(
      "SELECT root_turn_id,COUNT(*) n FROM threads GROUP BY root_turn_id HAVING n<>1",
    ),
    [],
  );
  assert.deepEqual(
    sql(
      "SELECT root_turn_id,COUNT(*) n FROM thread_outcomes GROUP BY root_turn_id HAVING n<>1",
    ),
    [],
  );
  assert.deepEqual(
    sql("SELECT id,status FROM threads WHERE status='open'"),
    [],
    "No open fixture work at settled cycle boundary",
  );
  assert.deepEqual(
    sql(
      "SELECT id,status FROM thread_activations WHERE status IN ('queued','running')",
    ),
    [],
  );
  assert.deepEqual(
    sql(
      "SELECT id,status FROM plan_executions WHERE status IN ('queued','running','waiting')",
    ),
    [],
  );
  assert.deepEqual(
    sql(
      "SELECT id,status FROM execution_jobs WHERE status IN ('queued','waiting_approval','running')",
    ),
    [],
  );
  trace("global-invariants-verified", { settledRoots: roots.size });
}
process.once("SIGTERM", () => {
  closeRequested = true;
  trace("harness-signal", { signal: "SIGTERM" });
});
process.once("SIGINT", () => {
  closeRequested = true;
  trace("harness-signal", { signal: "SIGINT" });
});
let outcome: "passed" | "failed" = "failed",
  failure: string | undefined;
try {
  await openHost();
  await new Promise<void>((done) => toolProxy.listen(proxyPath, done));
  await startRuntime();
  await api("/api/agents/default-agent/provider-accounts/soak", {
    method: "PUT",
  });
  await wait(
    () => host!.connection.application.options.runtime!.isConnected,
    "Host connects to real Rust Runtime",
  );
  await call("projects.create", {
    commandId: randomUUID(),
    projectId: "soak-project",
    title: "TEST 隔离长期验证",
  });
  await resourceSample();
  while (performance.now() - monotonicStart < durationMs || cycles === 0) {
    const cycleStart = performance.now();
    cycles++;
    trace("cycle-start", { cycle: cycles });
    await steeringScene(cycles);
    await contextScene(cycles);
    await inferScene(cycles);
    await taskScene(cycles);
    await documentScene(cycles);
    if (cycles === 1 || cycles % 5 === 0) await faultScene(cycles);
    if (cycles === 1 || cycles % 15 === 0) await hostReopenScene(cycles);
    if (cycles === 1 || cycles % 60 === 0) await crashScene(cycles);
    globalInvariants();
    await resourceSample();
    console.log(
      JSON.stringify({
        event: "cycle-verified",
        cycle: cycles,
        elapsedMs: Math.round(performance.now() - monotonicStart),
        providerCalls,
        coverage,
        directory,
      }),
    );
    trace("cycle-verified", { cycle: cycles, providerCalls, coverage });
    while (
      performance.now() - cycleStart < intervalMs &&
      performance.now() - monotonicStart < durationMs
    ) {
      if (closeRequested)
        throw new Error("Interrupted before requested duration");
      await pause(
        Math.min(
          1000,
          intervalMs - (performance.now() - cycleStart),
          durationMs - (performance.now() - monotonicStart),
        ),
      );
    }
  }
  globalInvariants();
  await resourceSample();
  for (const root of roots) {
    const expected = expectedTerminals.get(root);
    assert.ok(
      expected,
      "Every admitted root must have its own verified outcome",
    );
    assertTerminalRoot(root, terminalEvidence(root), [expected]);
  }
  const unsettledRoots = sql(
    "SELECT id FROM threads WHERE status='open'",
  ).length;
  assertRunComplete({
    elapsedMs: performance.now() - monotonicStart,
    requestedDurationMs: durationMs,
    cycles,
    coverage,
    unsettledRoots,
    maximumVerifiedGapMs,
    allowedVerifiedGapMs: continuityBudgetMs,
  });
  for (const filename of [
    databasePath,
    ...readdirSync(workDirectory)
      .filter((file) => file.endsWith(".sqlite"))
      .map((file) => join(workDirectory, file)),
  ]) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare("PRAGMA quick_check")
          .all()
          .map((row) => row.quick_check),
        ["ok"],
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  }
  outcome = "passed";
} catch (error) {
  failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  trace("failure", { failure: redact(failure), runtimeLogTail: logTail });
  if (lastProviderRequest)
    writeFileSync(
      join(directory, "failure-last-provider-request.json"),
      lastProviderRequest,
      { mode: 0o600 },
    );
  console.error(redact(failure));
  process.exitCode = 1;
} finally {
  const cleanupFailures = await runCleanupStages([
    {
      name: "release-gates",
      run: () => {
        releaseGate();
        releaseHostToolResponse();
      },
    },
    {
      name: "host",
      run: async () => {
        await host?.close();
        host = undefined;
      },
    },
    { name: "runtime", run: () => stopRuntime() },
    {
      name: "proxy",
      run: async () => {
        for (const socket of proxySockets) socket.destroy();
        if (toolProxy.listening)
          await new Promise<void>((done, reject) =>
            toolProxy.close((error) => (error ? reject(error) : done())),
          );
        assert.equal(toolProxy.listening, false);
      },
    },
    {
      name: "provider",
      run: async () => {
        provider.closeAllConnections();
        if (provider.listening)
          await new Promise<void>((done, reject) =>
            provider.close((error) => (error ? reject(error) : done())),
          );
        assert.equal(provider.listening, false);
      },
    },
    {
      name: "relay-directory",
      run: () => cleanupOwnedProxyDirectory(proxyDirectory),
    },
  ]);
  if (cleanupFailures.length) {
    outcome = "failed";
    process.exitCode = 1;
    failure = [
      failure,
      "Cleanup unconfirmed: " + JSON.stringify(cleanupFailures),
    ]
      .filter(Boolean)
      .join("\n");
    trace("cleanup-unconfirmed", { failures: cleanupFailures });
  }
  const result = {
    format: "morphz-reliability-soak-result/v1",
    outcome,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - monotonicStart),
    requestedDurationMs: durationMs,
    cycles,
    providerCalls,
    verifiedRoots: roots.size,
    maximumVerifiedGapMs,
    allowedVerifiedGapMs: continuityBudgetMs,
    verifiedTerminalCounts: Object.fromEntries(
      ["completed", "failed", "cancelled"].map((status) => [
        status,
        [...expectedTerminals.values()].filter((value) => value === status)
          .length,
      ]),
    ),
    coverage,
    failure: failure ? redact(failure) : null,
    cleanupFailures,
    evidenceDirectory: directory,
    originalAppTouched: false,
    paidModelCalls: 0,
    limits: [
      "Scripted model cannot prove autonomous cognition quality",
      "Embedded Host cold close/open is not native Electron window acceptance",
      "Only isolated SQLite; no PostgreSQL/cross-host failover",
    ],
  };
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  trace("run-finished", result);
  console.log(JSON.stringify(result));
}
