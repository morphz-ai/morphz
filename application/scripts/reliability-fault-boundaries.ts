/** Independent real IPC failure boundaries. No cached success reply is replayed.
 * Uses an explicitly pinned binary and only owned temporary data/processes.
 * node --import tsx scripts/reliability-fault-boundaries.ts --binary PATH
 *   --require-git-head SHA --outage-ms 20000
 */
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import {
  createServer as netServer,
  createConnection,
  type Socket,
} from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { objectToolName } from "../packages/core/src/application-names.js";
import type { Receipt } from "../packages/core/src/model.js";
import { runtimeFixtureFinalReply } from "./runtime-fixture-reply.js";
import {
  assertTerminalRoot,
  positiveMilliseconds,
  runCleanupStages,
  cleanupOwnedProxyDirectory,
} from "./reliability-soak-model.js";

const exec = promisify(execFile),
  options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!,
    value = process.argv[i + 1];
  assert.ok(["--binary", "--require-git-head", "--outage-ms"].includes(key));
  assert.ok(value && !options.has(key), `Missing/duplicate ${key}`);
  options.set(key, value);
}
assert.ok(
  options.get("--binary") && options.get("--require-git-head"),
  "Explicit frozen binary and head are required",
);
const expectedHead = options.get("--require-git-head")!;
assert.match(expectedHead, /^[0-9a-f]{40}$/);
const outageMs = positiveMilliseconds(
  options.get("--outage-ms") ?? "20000",
  "outage",
);
assert.ok(
  outageMs >= 10000 && outageMs <= 60000,
  "Sustained outage must be 10–60 seconds",
);
const directory = mkdtempSync(
    "/private/tmp/morphz-reliability-fault-boundaries-",
  ),
  work = join(directory, "application"),
  root = join(directory, "runtime"),
  profile = join(directory, "profile"),
  database = join(root, "runtime.sqlite"),
  binary = join(directory, "morphz-frozen"),
  manifest = join(directory, "host-tools.json");
for (const path of [work, root, profile]) mkdirSync(path, { mode: 0o700 });
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
let version: string;
try {
  copyFileSync(resolve(options.get("--binary")!), binary);
  version = (
    await exec(binary, ["--version"], { timeout: 10000 })
  ).stdout.trim();
  assert.ok(
    expectedHead.startsWith(version.match(/git ([0-9a-f]+)/)?.[1] ?? "INVALID"),
    "Binary must match pinned head",
  );
} catch (error) {
  const result = {
    outcome: "failed",
    phase: "preflight",
    failure: String(error),
    directory,
    processesStarted: 0,
  };
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.error(JSON.stringify(result));
  throw error;
}
const relayDirectory = mkdtempSync("/private/tmp/morphz-soak-proxy-"),
  relayPath = join(relayDirectory, "tools.sock");
const token = randomBytes(32).toString("hex"),
  namespace = randomUUID(),
  startedAt = new Date().toISOString(),
  startedMono = performance.now(),
  deadline = startedMono + 240000;
const trace = (event: string, value: unknown = {}) =>
  appendFileSync(
    join(directory, "trace.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      elapsedMs: performance.now() - startedMono,
      event,
      value,
    }) + "\n",
    { mode: 0o600 },
  );
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const redact = (text: string) => text.replaceAll(token, "[fixture-token]");
let runtime: ChildProcess | undefined,
  host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined,
  identityGeneration = "",
  endpoint = "",
  runtimeURL = "",
  runtimeLog = "",
  fixtureError: Error | undefined,
  holdCommit = false,
  committed:
    { jobId: string; requestSha: string; responseSha: string } | undefined,
  mode: "write" | "outage" | "reply" = "write",
  writeIssued = false,
  reconciliationStep = 0,
  committedContentId = "",
  outageUntil = 0,
  partialIssued = false,
  providerCalls = 0,
  refusedCalls = 0,
  bridgeOffline = false,
  interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    interrupted = true;
    trace("fixture-interrupted", { signal });
  });
const sockets = new Set<Socket>(),
  physicalCalls: string[] = [],
  roots = new Set<string>(),
  accepted: Array<{ command: any; receipt: Receipt; root: string }> = [];
type Request = { stream?: boolean; messages: unknown[]; tools?: unknown[] };
function sql(query: string, ...parameters: SQLInputValue[]): any[] {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    return db
      .prepare(query)
      .all(...parameters)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
async function wait(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 90000,
) {
  const until = Math.min(deadline, performance.now() + timeoutMs);
  while (performance.now() < until) {
    if (interrupted)
      throw new Error("Fixture interrupted; cleanup is required");
    if (fixtureError) throw fixtureError;
    if (await check()) return;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(`Owned Runtime exited: ${runtimeLog}`);
    await delay(75);
  }
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const value = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return value;
}
const relay = netServer((downstream) => {
  const upstream = createConnection(endpoint),
    request: Buffer[] = [],
    response: Buffer[] = [];
  sockets.add(downstream);
  sockets.add(upstream);
  let requestBytes = 0,
    responseBytes = 0;
  for (const socket of [upstream, downstream])
    socket.on("close", () => sockets.delete(socket));
  downstream.on("data", (bytes: Buffer) => {
    requestBytes += bytes.length;
    if (requestBytes > 4 * 1024 * 1024 + 4) {
      downstream.destroy();
      upstream.destroy();
      return;
    }
    request.push(bytes);
    upstream.write(bytes);
  });
  downstream.on("end", () => upstream.end());
  downstream.on("close", () => upstream.destroy());
  downstream.on("error", () => upstream.destroy());
  upstream.on("error", () => downstream.destroy());
  upstream.on("data", (bytes: Buffer) => {
    responseBytes += bytes.length;
    if (responseBytes > 2 * 1024 * 1024 + 4) {
      downstream.destroy();
      upstream.destroy();
      return;
    }
    response.push(bytes);
    if (!holdCommit) downstream.write(bytes);
  });
  upstream.on("end", () => {
    try {
      const req = Buffer.concat(request),
        res = Buffer.concat(response);
      assert.equal(req.readUInt32BE(0), req.length - 4);
      assert.equal(res.readUInt32BE(0), res.length - 4);
      const input = JSON.parse(req.subarray(4).toString()),
        output = JSON.parse(res.subarray(4).toString());
      const jobId = input.request.invocation.job_id;
      physicalCalls.push(jobId);
      trace("real-physical-ipc", {
        jobId,
        ok: output.ok,
        domainOk: output.value?.ok,
        held: holdCommit,
        responseSha: sha(res),
      });
      if (holdCommit) {
        assert.equal(output.ok, true);
        assert.equal(output.value.ok, true);
        assert.ok(!committed);
        committed = { jobId, requestSha: sha(req), responseSha: sha(res) };
        // Keep only hashes. These success bytes are never released or replayed.
        trace("commit-before-ack-held", committed);
      } else downstream.end();
    } catch (error) {
      fixtureError = error as Error;
      downstream.destroy();
      upstream.destroy();
    }
  });
});
function respond(
  response: ServerResponse,
  input: Request,
  tool?: { name: string; arguments: unknown },
) {
  const text = JSON.stringify(input.messages),
    marker = text.includes("FAULT_NET_B")
      ? "FAULT_NET_B"
      : text.includes("FAULT_NET_A")
        ? "FAULT_NET_A"
        : "FAULT_COMMIT";
  const final = runtimeFixtureFinalReply(input, {
    content:
      marker === "FAULT_COMMIT"
        ? "FAULT_COMMIT: original document verified by real list/read; original write receipt remains lost/uncertain, no write was repeated"
        : `${marker}: COMPLETE`,
    title: "隔离故障边界",
    result: "受控真实链完成",
  });
  const message = tool
    ? {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: reconciliationStep
              ? `fixture-reconcile-${reconciliationStep}`
              : "fixture-physical-write",
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          },
        ],
      }
    : final.message;
  const finish = tool ? "tool_calls" : final.finishReason;
  if (input.stream) {
    const calls = "tool_calls" in message ? message.tool_calls : undefined;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: calls ? { role: "assistant", tool_calls: calls?.map((call, index) => ({ ...call, index })) } : message, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: randomUUID(),
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  }
}
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      response.end(JSON.stringify({ data: [{ id: "fault-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const bytes of request) chunks.push(bytes);
    const bytes = Buffer.concat(chunks),
      input = JSON.parse(bytes.toString()) as Request;
    assert.ok(Array.isArray(input.messages));
    providerCalls++;
    writeFileSync(join(directory, `provider-${providerCalls}.json`), bytes, {
      mode: 0o600,
    });
    trace("provider-request", {
      sequence: providerCalls,
      mode,
      sha: sha(bytes),
      tools: (input.tools ?? []).map(
        (tool: any) => tool.function?.name ?? tool.name,
      ),
    });
    if (mode === "outage" && performance.now() < outageUntil) {
      refusedCalls++;
      if (!partialIssued && input.stream) {
        partialIssued = true;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: { role: "assistant", content: "PARTIAL_NOT_FINAL" }, finish_reason: null }] })}\n\n`,
          () => request.socket.destroy(),
        );
        trace("partial-stream-disconnected");
      } else {
        request.socket.destroy();
        trace("sustained-provider-refusal", { sequence: providerCalls });
      }
      return;
    }
    if (mode === "write" && !writeIssued) {
      writeIssued = true;
      assert.ok(
        (input.tools ?? []).some(
          (tool: any) => (tool.function?.name ?? tool.name) === objectToolName,
        ),
      );
      respond(response, input, {
        name: objectToolName,
        arguments: {
          action: "create-document",
          title: "FAULT_COMMIT_ORIGINAL",
          markdown: "Exact original FAULT_COMMIT bytes",
        },
      });
    } else if (mode === "write" && reconciliationStep === 0) {
      assert.equal(
        sql(
          "SELECT status FROM execution_jobs WHERE tool_call_id=?",
          "fixture-physical-write",
        )[0]?.status,
        "lost",
        "Uncertain at-most-once write must remain honestly lost",
      );
      reconciliationStep = 1;
      respond(response, input, {
        name: objectToolName,
        arguments: {
          action: "list",
          query: "FAULT_COMMIT_ORIGINAL",
          limit: 10,
        },
      });
    } else if (mode === "write" && reconciliationStep === 1) {
      assert.ok(
        committedContentId &&
          JSON.stringify(input.messages).includes(committedContentId),
        "Exact original reference must have appeared in real discovery output",
      );
      reconciliationStep = 2;
      respond(response, input, {
        name: objectToolName,
        arguments: {
          action: "read",
          artifactId: committedContentId,
          revision: 1,
        },
      });
    } else {
      if (mode === "write")
        assert.ok(
          JSON.stringify(input.messages).includes(
            "Exact original FAULT_COMMIT bytes",
          ),
          "Final statement requires an actual read observation",
        );
      respond(response, input);
    }
  } catch (error) {
    fixtureError = error as Error;
    trace("provider-fixture-error", { error: String(error) });
    response.writeHead(500).end();
  }
});
const runtimePort = await port();
runtimeURL = `http://127.0.0.1:${runtimePort}`;
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const providerPort = (provider.address() as { port: number }).port,
  config = join(root, "morphz.toml");
writeFileSync(
  join(work, "runtime.json"),
  JSON.stringify({ url: runtimeURL, token, namespace }),
  { mode: 0o600 },
);
writeFileSync(
  config,
  `[llm]\nmodel="fault-model"\n[orchestrator]\nactivation_lease_secs=8\nmodel_attempt_hard_timeout_secs=90\n[accounts.fault]\nauth_adapter="credential"\ncredential_ref="fault"\nprovider="fault"\n[services.fault]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["fault"]\n[[models.fault-model.targets]]\nservice="fault"\naccount="fault"\nphysical_model="fault-model"\ncapabilities=["tools"]\n[credentials.fault]\nsource="env"\nname="MORPHZ_FAULT_FIXTURE_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(root)}\n`,
  { mode: 0o600 },
);
for (const name of Object.keys(process.env))
  if (
    /^(MORPHZ_APP_|MORPHZWORK_|DOUBAO_|OPENAI_|ANTHROPIC_|GEMINI_|MORPHZ_COGNITIVE_)/.test(
      name,
    )
  )
    delete process.env[name];
process.env.MORPHZ_APP_ENV_FILE = "";
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(runtimeURL + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(
    response.ok,
    `${path}: ${response.status} ${redact(await response.clone().text())}`,
  );
  return response.json();
}
async function startRuntime() {
  runtime = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${runtimePort}`,
      "--cwd",
      root,
      "--config-file",
      config,
      "--log-level",
      "warn",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: "/private/tmp",
        LANG: "en_US.UTF-8",
        MORPHZ_HOME: root,
        MORPHZ_STORAGE_SQLITE_PATH: database,
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_HOST_TOOLS_FILE: manifest,
        MORPHZ_FAULT_FIXTURE_KEY: "synthetic-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream?.on("data", (bytes: Buffer) => {
      const text = redact(bytes.toString());
      runtimeLog = (runtimeLog + text).slice(-32000);
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
    30000,
  );
}
async function stopRuntime(kill = false) {
  const child = runtime;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(child.pid && child.pid !== 68670);
  const ended = new Promise<void>((done) => child.once("exit", () => done()));
  trace(kill ? "owned-runtime-sigkill" : "owned-runtime-stop", {
    pid: child.pid,
  });
  child.kill(kill ? "SIGKILL" : "SIGTERM");
  await Promise.race([ended, delay(10000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([ended, delay(5000)]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  runtime = undefined;
}
async function openHost() {
  host = await openEmbeddedApplication(work, profile);
  const tools = JSON.parse(readFileSync(host.manifestPath!, "utf8"));
  endpoint = tools.tools[0].ipc_path;
  for (const tool of tools.tools) tool.ipc_path = relayPath;
  writeFileSync(manifest, JSON.stringify(tools), { mode: 0o600 });
  identityGeneration = (
    (await host.connection.call("platform.bootstrap")) as { csrfToken: string }
  ).csrfToken;
}
async function call<T>(method: string, parameters: unknown): Promise<T> {
  return host!.connection.call(method as any, parameters, {
    identityGeneration,
  }) as Promise<T>;
}
function deliveries(): any[] {
  return (host!.connection.application.store.runtimeState() as any).deliveries;
}
async function input(
  body: string,
  conversationId = "fault-project",
  newConversation = false,
) {
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: "fault-project",
      conversationId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body,
      targetActantId: "morphz-agent",
      ...(newConversation
        ? { newConversation: { title: "TEST second fault Session" } }
        : {}),
    },
  };
  const receipt = await call<Receipt>("platform.message", command);
  let rootId = "";
  await wait(() => {
    rootId =
      deliveries().find((entry) => entry.inputId === receipt.entityId)
        ?.rootId ?? "";
    return !!rootId;
  }, "Host binds root");
  roots.add(rootId);
  const result = { command, receipt, root: rootId };
  accepted.push(result);
  trace("accepted-input", result);
  return result;
}
async function terminal(rootId: string) {
  await wait(
    () =>
      sql("SELECT status FROM threads WHERE root_turn_id=?", rootId)[0]
        ?.status === "completed" &&
      sql("SELECT thread_id FROM thread_outcomes WHERE root_turn_id=?", rootId)
        .length === 1,
    "unique completed root",
  );
  const threads = sql(
    "SELECT id,root_turn_id,generation,status FROM threads WHERE root_turn_id=?",
    rootId,
  );
  assertTerminalRoot(rootId, {
    threads,
    outcomes: sql(
      "SELECT thread_id,root_turn_id,thread_generation,terminal_kind FROM thread_outcomes WHERE root_turn_id=?",
      rootId,
    ),
    liveActivations: sql(
      "SELECT id FROM thread_activations WHERE root_turn_id=? AND status IN ('queued','running')",
      rootId,
    ),
    pendingSignals: sql(
      "SELECT id FROM thread_signals WHERE thread_id=? AND status IN ('pending','claimed')",
      threads[0].id,
    ),
  });
}
writeFileSync(
  join(directory, "manifest.json"),
  JSON.stringify(
    {
      format: "morphz-reliability-fault-boundaries/v1",
      startedAt,
      expectedHead,
      binary: { version, path: binary, sha256: sha(readFileSync(binary)) },
      harnessSha256: sha(readFileSync(new URL(import.meta.url))),
      outageMs,
      scope:
        "owned isolated SQLite Runtime/Embedded Host + scripted loopback Provider",
      exclusions: [
        "user app/profile",
        "paid models",
        "Electron native quit",
        "model quality",
        "PostgreSQL soak",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
let failure: string | null = null,
  evidence: unknown;
try {
  await openHost();
  await new Promise<void>((done) => relay.listen(relayPath, done));
  await startRuntime();
  await api("/api/agents/default-agent/provider-accounts/fault", {
    method: "PUT",
  });
  await wait(
    () => host!.connection.application.options.runtime!.isConnected,
    "Host connected",
  );
  await call("projects.create", {
    commandId: randomUUID(),
    projectId: "fault-project",
    title: "TEST isolated failure boundaries",
  });
  holdCommit = true;
  const written = await input("Create document FAULT_COMMIT_ORIGINAL");
  await wait(() => !!committed, "real physical commit before success ack");
  const held = committed!,
    client = await PlatformClient.connect(host!.connection);
  const content = (
    await client.content({
      projectId: "fault-project",
      query: "FAULT_COMMIT_ORIGINAL",
      limit: 10,
    })
  ).items.filter((entry) => entry.title === "FAULT_COMMIT_ORIGINAL");
  assert.equal(content.length, 1);
  const original = await client.readDocument(content[0]!.id, 1);
  assert.ok(
    original &&
      typeof original === "object" &&
      "markdown" in original &&
      "revision" in original,
    "Physical read must return the persisted document body and revision",
  );
  committedContentId = content[0]!.id;
  assert.equal(original.markdown, "Exact original FAULT_COMMIT bytes");
  assert.equal(original.revision, 1);
  assert.equal(
    sql("SELECT status FROM execution_jobs WHERE id=?", held.jobId)[0].status,
    "running",
  );
  const oldPid = runtime!.pid;
  await stopRuntime(true);
  for (const socket of sockets) socket.destroy();
  trace("success-ack-discarded-not-replayed", held);
  committed = undefined;
  holdCommit = false;
  await startRuntime();
  assert.notEqual(runtime!.pid, oldPid);
  await terminal(written.root);
  const jobs = sql(
    "SELECT id,tool_call_id,status,result_event_id FROM execution_jobs WHERE thread_id=(SELECT id FROM threads WHERE root_turn_id=?)",
    written.root,
  );
  assert.equal(
    jobs.length,
    3,
    "One original uncertain write plus two real reconciliation reads",
  );
  const writeJobs = jobs.filter(
    (job) => job.tool_call_id === "fixture-physical-write",
  );
  assert.equal(writeJobs.length, 1);
  assert.equal(writeJobs[0].id, held.jobId);
  assert.equal(
    writeJobs[0].status,
    "lost",
    "At-most-once uncertainty is never rewritten as success",
  );
  assert.ok(
    jobs
      .filter((job) => job.id !== held.jobId)
      .every((job) => job.status === "succeeded"),
  );
  assert.equal(
    physicalCalls.filter((jobId) => jobId === held.jobId).length,
    1,
    "Unknown physical write must never be automatically repeated",
  );
  assert.equal(
    reconciliationStep,
    2,
    "Real Agent discovery and exact-version read are required",
  );
  assert.deepEqual(await client.readDocument(content[0]!.id, 1), original);
  assert.equal(
    (
      await client.content({
        projectId: "fault-project",
        query: "FAULT_COMMIT_ORIGINAL",
        limit: 10,
      })
    ).items.filter((entry) => entry.title === "FAULT_COMMIT_ORIGINAL").length,
    1,
  );
  const provenance = (
    await client.contentDeliveries([written.receipt.entityId])
  ).filter((delivery) => delivery.contentId === content[0]!.id);
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0]!.versionRef, "1");
  assert.deepEqual(
    await call<Receipt>("platform.message", written.command),
    written.receipt,
  );
  trace("commit-before-ack-recovery-verified", {
    root: written.root,
    originalWriteJob: writeJobs[0],
    reconciliationJobs: jobs.filter((job) => job.id !== held.jobId),
    original,
    provenance,
    actualHostInvocations: physicalCalls.filter((id) => id === held.jobId)
      .length,
    oldPid,
    newPid: runtime!.pid,
  });

  mode = "outage";
  outageUntil = performance.now() + outageMs;
  const outageStarted = performance.now();
  const first = await input(
    "FAULT_NET_A remains original during sustained outage",
  );
  await wait(() => refusedCalls >= 1, "actual provider outage starts");
  await host!.close();
  host = undefined;
  bridgeOffline = true;
  const offlineRemaining = Math.max(
    0,
    Math.min(3000, outageUntil - performance.now()),
  );
  await delay(offlineRemaining);
  await openHost();
  bridgeOffline = false;
  await wait(
    () => host!.connection.application.options.runtime!.isConnected,
    "Host reconnects during sustained outage",
  );
  const second = await input(
    "FAULT_NET_B independent admitted root during sustained outage",
    "fault-second",
    true,
  );
  assert.ok(
    performance.now() < outageUntil,
    "Second input must be admitted before recovery",
  );
  await delay(Math.max(0, outageUntil - performance.now()));
  trace("outage-ended", {
    actualDurationMs: performance.now() - outageStarted,
    refusedCalls,
    partialIssued,
    first: first.root,
    second: second.root,
  });
  await terminal(first.root);
  await terminal(second.root);
  assert.notEqual(first.root, second.root);
  assert.ok(
    refusedCalls >= 3,
    "Sustained failure must encompass multiple actual provider attempts",
  );
  assert.equal(
    partialIssued,
    true,
    "Real partial stream interruption must occur",
  );
  for (const entry of accepted)
    assert.deepEqual(
      await call<Receipt>("platform.message", entry.command),
      entry.receipt,
    );
  for (const query of [
    "SELECT id FROM thread_signals WHERE status IN ('pending','claimed')",
    "SELECT id FROM thread_activations WHERE status IN ('queued','running')",
    "SELECT id FROM execution_jobs WHERE status IN ('queued','waiting_approval','running')",
    "SELECT id FROM runtime_timers WHERE status IN ('pending','claimed')",
  ])
    assert.deepEqual(sql(query), []);
  assert.equal(sql("SELECT COUNT(*) n FROM threads")[0].n, roots.size);
  assert.equal(sql("SELECT COUNT(*) n FROM thread_outcomes")[0].n, roots.size);
  evidence = {
    rootIds: [...roots],
    acceptedInputIds: accepted.map((entry) => entry.receipt.entityId),
    physicalCalls,
    jobs,
    provenance,
    actualOutageMs: performance.now() - outageStarted,
    refusedCalls,
    partialIssued,
    providerCalls,
  };
  trace("all-boundaries-verified", evidence);
} catch (error) {
  failure = redact(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  trace("failure", { failure, runtimeLog });
}
const cleanupFailures = await runCleanupStages([
  {
    name: "host",
    run: async () => {
      await host?.close();
      host = undefined;
    },
  },
  { name: "owned-runtime", run: () => stopRuntime() },
  {
    name: "relay",
    run: async () => {
      for (const socket of sockets) socket.destroy();
      if (relay.listening)
        await new Promise<void>((done) => relay.close(() => done()));
    },
  },
  {
    name: "provider",
    run: async () => {
      provider.closeAllConnections();
      if (provider.listening)
        await new Promise<void>((done) => provider.close(() => done()));
    },
  },
  {
    name: "owned-relay-directory",
    run: () => cleanupOwnedProxyDirectory(relayDirectory),
  },
]);
const result = {
  outcome: failure || cleanupFailures.length ? "failed" : "passed",
  startedAt,
  finishedAt: new Date().toISOString(),
  elapsedMs: performance.now() - startedMono,
  failure,
  cleanupFailures,
  bridgeOfflineAtCleanup: bridgeOffline,
  evidence,
  directory,
};
writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(result));
if (result.outcome !== "passed") process.exitCode = 1;
