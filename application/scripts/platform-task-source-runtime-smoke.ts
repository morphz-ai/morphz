/** Real Runtime + actual embedded Host + Unix Agent tools. The local provider
 * emits deterministic responses only: this proves transport, authority and
 * lifecycle behavior, not the quality of a real model's source interpretation.
 * Uses fresh databases/credentials; never opens the user's application profile.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import {
  executionSnapshotSchema,
  jobSchema,
} from "../packages/core/src/execution.js";
import type { TaskRunLink } from "../packages/platform/src/store.js";
import { taskSourceStoredData } from "../packages/platform/src/task-run-source.js";
import { runtimeBinaryPath } from "./runtime-path.mjs";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "Build the compatible Runtime binary first.");
const directory = mkdtempSync(join(tmpdir(), "morphz-task-source-runtime-"));
const runtimeDirectory = join(directory, "runtime");
const applicationDirectory = join(directory, "application");
const profileDirectory = join(directory, "profile");
mkdirSync(runtimeDirectory, { mode: 0o700 });
mkdirSync(applicationDirectory, { mode: 0o700 });
process.env.MORPHZ_APP_ENV_FILE = "";
const token = randomBytes(32).toString("hex");
const namespace = randomUUID();
const nativeFetch = globalThis.fetch;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const firstGate = gate(),
  stopGate = gate(),
  latePostGate = gate(),
  lateModelGate = gate(),
  retryPostGate = gate();
let firstProviderStarted = false,
  stopProviderStarted = false,
  lateProviderStarted = false;
let phase = "initial",
  phaseName = "setup",
  providerCalls = 0;
let runtime: ChildProcessWithoutNullStreams | undefined;
let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
let client!: PlatformClient;
let runtimeDiagnostics = "",
  passed = false;
let forwardedPost: Promise<void> | undefined;
const providerRequests: Array<{ phase: string; body: unknown }> = [];
const issuedTools = new Set<string>();
const completed: string[] = [];

const provider = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(
      body.tools?.some(
        (tool: { function?: { name?: string } }) =>
          tool.function?.name === "host_morphz",
      ),
      "Actual Runtime must load the embedded Host's tool manifest",
    );
    const callNumber = ++providerCalls;
    const requestPhase = phase;
    providerRequests.push({ phase: requestPhase, body });
    if (callNumber === 1) {
      firstProviderStarted = true;
      await firstGate.promise;
    }
    if (requestPhase === "stop" && !stopProviderStarted) {
      stopProviderStarted = true;
      await stopGate.promise;
    }
    if (requestPhase === "late-stop" && !lateProviderStarted) {
      lateProviderStarted = true;
      await lateModelGate.promise;
    }
    // First response ends the original evaluation; queued steering must itself
    // drive the next actual evaluation before an active-source tool is emitted.
    const emitTool =
      callNumber !== 1 &&
      requestPhase !== "initial" &&
      !issuedTools.has(requestPhase);
    if (emitTool) issuedTools.add(requestPhase);
    const call = emitTool
      ? {
          id: `source-${requestPhase}-document`,
          type: "function",
          function: {
            name: "host_morphz",
            arguments: JSON.stringify({
              action: "create-document",
              title: `TEST 来源接续 ${requestPhase}`,
              markdown: `真实 Runtime 来源接续 ${requestPhase} 的实际工具交付。`,
            }),
          },
        }
      : null;
    const message = call
      ? { role: "assistant", content: "", tool_calls: [call] }
      : { role: "assistant", content: `合成 ${requestPhase} 处理结束。` };
    const finish = call ? "tool_calls" : "stop";
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: randomUUID(),
          choices: [{ index: 0, message, finish_reason: finish }],
        }),
      );
    }
  } catch (error) {
    console.error("Synthetic provider rejected a real Runtime request", error);
    response.writeHead(500);
    response.end("Fixture provider rejected request");
  }
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = (provider.address() as { port: number }).port;
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const runtimePort = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const runtimeURL = `http://127.0.0.1:${runtimePort}`;
const configFile = join(runtimeDirectory, "morphz.toml");
writeFileSync(
  join(applicationDirectory, "runtime.json"),
  JSON.stringify({ url: runtimeURL, token, namespace }),
  { mode: 0o600 },
);
writeFileSync(
  configFile,
  `[llm]\nmodel="test-model"\nreasoning_effort="low"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TASK_SOURCE_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
  { mode: 0o600 },
);

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  label: string,
) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    if (await check()) return;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(`Runtime exited during ${label}`);
    await delay(100);
  }
  throw new Error(`${label} timed out`);
}
async function runtimeGet(path: string) {
  const response = await nativeFetch(runtimeURL + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(
    response.status,
    200,
    `${path}: ${await response.clone().text()}`,
  );
  return response.json();
}
async function start() {
  host = await openEmbeddedApplication(applicationDirectory, profileDirectory);
  assert.ok(host.manifestPath);
  runtime = spawn(
    binary,
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
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        MORPHZ_HOME: runtimeDirectory,
        MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_HOST_TOOLS_FILE: host.manifestPath,
        MORPHZ_APP_TASK_SOURCE_TEST_KEY: "synthetic-unused",
      },
      stdio: "pipe",
    },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream.on("data", (chunk) => {
      runtimeDiagnostics = (runtimeDiagnostics + chunk.toString()).slice(
        -24_000,
      );
    });
  await waitUntil(
    () => host!.connection.application.options.runtime!.isConnected,
    "actual Runtime connection",
  );
  const account = await nativeFetch(
    `${runtimeURL}/api/agents/default-agent/provider-accounts/stub`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
  );
  assert.ok(account.ok, "Bind only the isolated synthetic provider account");
  client = await PlatformClient.connect(host.connection);
}
async function close() {
  if (host) {
    await host.close();
    host = undefined;
  }
  const child = runtime;
  runtime = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Isolated Runtime did not stop")),
        15_000,
      );
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
const taskId = randomUUID(),
  sourceObjectId = randomUUID();
let projectId = "",
  sourceContentId = "",
  sourceRevision = 1;
let expectedAdmissionEventId = "";
const documentSchema = z.object({
  contentId: z.string(),
  projectId: z.string(),
  revision: z.number(),
  markdown: z.string(),
  title: z.string(),
  author: z.object({ principalId: z.string(), actantId: z.string() }),
});
async function links(selectedTaskId = taskId): Promise<TaskRunLink[]> {
  return (await host!.connection.call(
    "task.run-history",
    { taskId: selectedTaskId },
    { identityGeneration: client.boot.csrfToken },
  )) as TaskRunLink[];
}
async function link(selectedTaskId = taskId) {
  const result = (await links(selectedTaskId))[0];
  assert.ok(result);
  return result;
}
function platform() {
  return host!.connection.application.options.platformTaskRuns!.store;
}
async function sourceEvents() {
  return platform().taskRunSourceEvents(client.boot.centerId, taskId, 1);
}
async function reviseSource(label: string) {
  const commandId = randomUUID();
  const receipt = z
    .object({
      versionRef: z.string().regex(/^[1-9][0-9]*$/),
      receiptId: z.literal(commandId),
    })
    .parse(
      await host!.connection.call(
        "documents.revise",
        {
          commandId,
          contentId: sourceContentId,
          expectedRevision: sourceRevision,
          title: "TEST 被关注原件",
          markdown: `来源修订 ${label}`,
        },
        { identityGeneration: client.boot.csrfToken },
      ),
    );
  sourceRevision = Number(receipt.versionRef);
  return commandId;
}
async function confirmedSourceCount(count: number) {
  await waitUntil(async () => {
    const rows = await sourceEvents();
    return rows.filter((row) => row.receipt && !row.discarded).length === count;
  }, `actual source receipts ${count}`);
  const rows = (await sourceEvents()).filter(
    (row) => row.receipt && !row.discarded,
  );
  assert.equal(rows.length, count);
  return rows;
}
async function eventForVersion(revision: number) {
  const row = (await sourceEvents()).find((row) =>
    row.event.sources.some(
      (source) =>
        source.sourceId === sourceContentId &&
        source.versionRef === String(revision),
    ),
  );
  assert.ok(
    row?.receipt,
    `Runtime must acknowledge source version ${revision}`,
  );
  return row;
}
const threadSchema = z.object({
  thread_id: z.string(),
  session_id: z.string(),
  root_turn_id: z.string(),
  lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
});
async function thread(sessionId: string, rootId: string) {
  return threadSchema.parse(
    await runtimeGet(`/api/sessions/${sessionId}/turns/${rootId}/thread`),
  );
}
async function waitTerminal(sessionId: string, rootId: string) {
  await waitUntil(
    async () => (await thread(sessionId, rootId)).lifecycle !== "open",
    `actual terminal Thread ${rootId}`,
  );
  assert.equal((await thread(sessionId, rootId)).lifecycle, "completed");
}
async function assertDelivery(name: string) {
  let contentId: string | undefined;
  let objectId: string | undefined;
  await waitUntil(async () => {
    const entries = (
      await client.content({
        projectId,
        query: `TEST 来源接续 ${name}`,
        limit: 50,
      })
    ).items.filter((entry) => entry.title === `TEST 来源接续 ${name}`);
    assert.ok(entries.length <= 1, "Actual Agent callback must be idempotent");
    contentId = entries[0]?.id;
    objectId = entries[0]?.appObjectId;
    return !!contentId;
  }, `actual Agent tool ${name}`);
  const document = documentSchema.parse(
    await client.readDocument(contentId!, 1),
  );
  assert.equal(
    document.projectId,
    projectId,
    "Original task run, not current UI, determines the Agent's project",
  );
  assert.equal(document.author.actantId, "morphz-agent");
  assert.equal(
    document.markdown,
    `真实 Runtime 来源接续 ${name} 的实际工具交付。`,
  );
  const actualObjects = new DatabaseSync(
    join(applicationDirectory, "objects.sqlite"),
    { readOnly: true },
  );
  try {
    const row = actualObjects
      .prepare(
        "SELECT payload_body FROM object_outbox WHERE tenant_id=? AND object_id=? AND object_revision=1 AND event_kind='document.created'",
      )
      .get(client.boot.centerId, objectId!);
    assert.ok(row);
    const provenance = z
      .object({
        projectId: z.literal(projectId),
        principalId: z.literal(client.boot.principalId),
        actantId: z.literal("morphz-agent"),
        runtimeInputId: z.null(),
        runtimeTaskRunEventId: z.literal(expectedAdmissionEventId),
      })
      .parse(JSON.parse(String(row.payload_body)));
    assert.equal(
      provenance.runtimeTaskRunEventId,
      expectedAdmissionEventId,
      "Actual app-owned commit retains the original task admission, not a forged Human work input",
    );
  } finally {
    actualObjects.close();
  }
  return contentId!;
}
async function sourceRuntimeEvent(
  eventId: string,
  sessionId: string,
  selectedTaskId = taskId,
) {
  const root = z
    .object({
      event: z.object({
        id: z.string(),
        actor: z.string(),
        type: z.string(),
        topic: z.string(),
        payload: z.record(z.string(), z.unknown()),
      }),
    })
    .parse(
      await runtimeGet(
        `/api/sessions/${sessionId}/messages/by-client-id/${eventId}`,
      ),
    ).event;
  assert.equal(
    root.actor,
    "Session-Client",
    "Connector observations are not forged Human messages",
  );
  assert.equal(root.type, "session_message");
  const io = z
    .object({
      request: z.object({
        client_message_id: z.literal(eventId),
        message: z.object({
          format: z.object({
            id: z.literal("morphz.data"),
            version: z.literal("1"),
          }),
          content: z.object({ value: z.unknown() }),
        }),
      }),
    })
    .parse(root.payload.session_io);
  const data = z
    .object({
      kind: z.literal("morphz.task-source-change"),
      taskId: z.literal(selectedTaskId),
      runNumber: z.literal(1),
      admissionEventId: z.string(),
      sources: z.array(
        z.object({ sourceId: z.string(), versionRef: z.string() }),
      ),
    })
    .parse(taskSourceStoredData(io.request.message.content.value));
  return { root, data, request: io.request };
}
async function control(
  action: "pause" | "resume" | "stop",
  selectedTaskId = taskId,
) {
  const current = await link(selectedTaskId);
  await host!.connection.call(
    "task.control",
    {
      id: selectedTaskId,
      run: 1,
      revision: current.bridge.controlRevision,
      action,
    },
    { identityGeneration: client.boot.csrfToken },
  );
  await waitUntil(async () => {
    const next = await link(selectedTaskId);
    return (
      next.bridge.controlPending === null &&
      !next.bridge.stopRequested &&
      (action === "stop"
        ? next.bridge.sourceStopped
        : next.bridge.paused === (action === "pause"))
    );
  }, `actual confirmed ${action}`);
  assert.equal((await link(selectedTaskId)).bridge.error, "");
}
function assertNoLegacyWorkspace() {
  const db = new DatabaseSync(join(applicationDirectory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets')",
        )
        .all(),
      [],
    );
  } finally {
    db.close();
  }
}

try {
  await start();
  await client.ensurePersonalSpaces();
  projectId = randomUUID();
  await client.createProject("TEST 来源实际 Runtime", randomUUID(), projectId);
  const initial = z
    .object({ contentId: z.string(), versionRef: z.literal("1") })
    .parse(
      await host!.connection.call(
        "documents.create",
        {
          commandId: randomUUID(),
          objectId: sourceObjectId,
          projectId,
          title: "TEST 被关注原件",
          markdown: "来源修订 v1",
        },
        { identityGeneration: client.boot.csrfToken },
      ),
    );
  sourceContentId = initial.contentId;
  await client.createTask({
    commandId: randomUUID(),
    taskId,
    projectId,
    title: "TEST 真实来源关注",
    description: "关注原件修订并保存新分析。",
    assigneeId: "morphz-agent",
    modelId: "test-model",
    reasoningEffort: "low",
    watchSourceIds: [sourceContentId],
  });
  await client.requestTaskRun({
    commandId: randomUUID(),
    taskId,
    expectedRevision: 1,
  });
  await waitUntil(
    async () => (await links()).length === 1 && firstProviderStarted,
    "actual original scheduled task evaluation",
  );
  const original = await link();
  expectedAdmissionEventId = `task_run_${original.runtime.scheduleId.slice(5)}`;
  const sessionId = original.runtime.sessionId;
  const originalRoot = `client-schedule-${original.runtime.scheduleId}`;
  const session = z
    .object({ context_id: z.string() })
    .parse(await runtimeGet(`/api/sessions/${sessionId}`));
  const detail = z
    .object({
      snapshot: z.object({
        thread: z.object({
          id: z.string(),
          generation: z.number(),
          lifecycle: z.string(),
          initiating_principal_id: z.string(),
        }),
      }),
    })
    .parse(
      await runtimeGet(
        `/api/contexts/${session.context_id}/threads/${original.runtime.threadId}`,
      ),
    );
  assert.equal(detail.snapshot.thread.lifecycle, "open");
  assert.equal(
    (await sourceEvents()).length,
    0,
    "Initial source version must be the admitted baseline, not a change",
  );

  phaseName = "active steering";
  phase = "active";
  const activeCommand = await reviseSource("v2 active");
  await confirmedSourceCount(1);
  const active = await eventForVersion(2);
  assert.deepEqual(active.event.destination, {
    kind: "thread",
    threadId: original.runtime.threadId,
    generation: detail.snapshot.thread.generation,
    principalId: detail.snapshot.thread.initiating_principal_id,
  });
  assert.equal(active.receipt!.rootId, originalRoot);
  assert.deepEqual(
    active.event.sourceCommandIds,
    [activeCommand],
    "Observe the application's actual revision receipt, not a synthetic catalog ID",
  );
  const activeWire = await sourceRuntimeEvent(active.event.eventId, sessionId);
  assert.equal(activeWire.root.topic, "chat/steering");
  assert.equal(activeWire.root.payload.thread_id, original.runtime.threadId);
  assert.equal(
    activeWire.root.payload.thread_generation,
    detail.snapshot.thread.generation,
  );
  firstGate.release();
  await assertDelivery("active");
  await waitTerminal(sessionId, originalRoot);
  assert.ok(
    providerRequests.some(
      (entry) =>
        entry.phase === "active" &&
        JSON.stringify(entry.body).includes("morphz.task-source-change"),
    ),
    "Queued source data must reach an actual subsequent model evaluation",
  );
  completed.push(
    "open Thread: exact current generation steering and actual authorized Agent callback",
  );

  phaseName = "terminal follow-up";
  phase = "terminal";
  const terminalCommand = await reviseSource("v3 terminal");
  await confirmedSourceCount(2);
  const terminal = await eventForVersion(3);
  assert.equal(terminal.event.destination.kind, "follow-up");
  assert.notEqual(terminal.receipt!.rootId, originalRoot);
  assert.deepEqual(terminal.event.sourceCommandIds, [terminalCommand]);
  const terminalWire = await sourceRuntimeEvent(
    terminal.event.eventId,
    sessionId,
  );
  assert.equal(terminalWire.root.topic, "chat/user_message");
  assert.equal(terminalWire.root.id, terminal.receipt!.rootId);
  assert.equal(
    (terminal.event.request.activation as Record<string, unknown>).model_alias,
    original.request.modelAlias,
  );
  assert.equal(
    (terminal.event.request.activation as Record<string, unknown>)
      .reasoning_effort,
    original.request.reasoningEffort,
  );
  await assertDelivery("terminal");
  await waitTerminal(sessionId, terminal.receipt!.rootId);
  assert.equal(
    (await links()).length,
    1,
    "A source follow-up is not a new Platform task run",
  );
  const runtimeDatabase = new DatabaseSync(
    join(runtimeDirectory, "runtime.sqlite"),
    { readOnly: true },
  );
  try {
    assert.deepEqual(
      runtimeDatabase
        .prepare(
          "SELECT s.id FROM schedules s JOIN threads t ON t.id=s.thread_id WHERE t.session_id=? ORDER BY s.id",
        )
        .all(sessionId)
        .map((row) => row.id),
      [original.runtime.scheduleId],
      "Actual persisted follow-up must reuse Session IO, not create another Schedule",
    );
  } finally {
    runtimeDatabase.close();
  }
  completed.push(
    "terminal Thread: same Session new root, no new Schedule/Human request, original run authority",
  );

  phaseName = "pause/coalesce/resume";
  await control("pause");
  const pausedCalls = providerCalls;
  await reviseSource("v4 paused");
  await reviseSource("v5 paused");
  const resumeCommand = await reviseSource("v6 paused");
  await delay(3_300); // More than two real dispatcher polling intervals.
  assert.equal((await sourceEvents()).length, 2);
  assert.equal(
    providerCalls,
    pausedCalls,
    "Paused changes must not call a model",
  );
  phase = "resume";
  await control("resume");
  await confirmedSourceCount(3);
  const resumed = await eventForVersion(6);
  assert.deepEqual(resumed.event.sourceCommandIds, [resumeCommand]);
  assert.ok(
    !(await sourceEvents()).some((row) =>
      row.event.sources.some((source) =>
        ["4", "5"].includes(source.versionRef),
      ),
    ),
    "Paused intermediate versions must coalesce, not replay physical work",
  );
  await assertDelivery("resume");
  await waitTerminal(sessionId, resumed.receipt!.rootId);
  completed.push(
    "pause multiple revisions: no IO/model calls; resume observes latest exact version once",
  );

  phaseName = "lost acknowledgement/cold reopen";
  phase = "lost";
  let lostId: string | undefined;
  let acceptedId: string | undefined;
  let postedRequest: unknown;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (lostId && url.includes(`/messages/by-client-id/${lostId}`))
      throw new TypeError("Synthetic network loss until this Host closes");
    const response = await nativeFetch(input, init);
    if (
      !lostId &&
      url.endsWith(`/api/sessions/${sessionId}/io/messages`) &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body));
      if (body.client_metadata?.kind === "morphz.task-source-change") {
        assert.ok(
          response.ok,
          "Lose only a real accepted HTTP response, never fake acceptance",
        );
        lostId = body.client_message_id;
        postedRequest = body;
        acceptedId = z
          .object({ event_id: z.string() })
          .parse(await response.clone().json()).event_id;
        throw new TypeError("Synthetic loss of actual Runtime 200 receipt");
      }
    }
    return response;
  };
  const lostCommand = await reviseSource("v7 lost acknowledgement");
  await waitUntil(() => !!lostId, "actual lost POST acknowledgement");
  await assertDelivery("lost");
  await waitTerminal(sessionId, acceptedId!);
  const uncertain = (await sourceEvents()).find(
    (row) => row.event.eventId === lostId,
  );
  assert.ok(uncertain);
  assert.equal(
    uncertain.receipt,
    null,
    "The Platform must not invent the lost Runtime acknowledgement",
  );
  assert.deepEqual(
    uncertain.event.request,
    postedRequest,
    "Full wire request was durable before the actual POST",
  );
  const callsBeforeRestart = providerCalls;
  await control("pause");
  assert.equal(
    (await sourceEvents()).find((row) => row.event.eventId === lostId)!.receipt,
    null,
  );
  await close();
  globalThis.fetch = nativeFetch;
  await start();
  assert.equal(
    (await link()).bridge.paused,
    true,
    "Pause survives the real Host/Runtime restart",
  );
  await delay(1_700);
  assert.equal(
    (await sourceEvents()).find((row) => row.event.eventId === lostId)!.receipt,
    null,
    "A paused producer does not deliver or silently confirm a source event",
  );
  await control("resume");
  await confirmedSourceCount(4);
  const recovered = await eventForVersion(7);
  assert.equal(recovered.event.eventId, lostId);
  assert.equal(recovered.receipt!.eventId, acceptedId);
  assert.deepEqual(recovered.event.request, postedRequest);
  assert.ok((await link()).bridge.sourceCommandIds.includes(lostCommand));
  await delay(3_300);
  assert.equal(
    providerCalls,
    callsBeforeRestart,
    "Reconciliation must not start a duplicate evaluation",
  );
  const allEvents = z
    .object({
      events: z.array(
        z.object({
          id: z.string(),
          payload: z.record(z.string(), z.unknown()),
        }),
      ),
    })
    .parse(await runtimeGet(`/api/sessions/${sessionId}/events?limit=1000`));
  assert.equal(
    allEvents.events.filter(
      (event) => event.payload.client_message_id === lostId,
    ).length,
    1,
    "Stable Session IO client message ID survives Runtime/Host cold restart",
  );
  await assertDelivery("lost");
  completed.push(
    "lost actual 200 receipt + pause/resume: cold reopen reconciles same destination/event/request without a duplicate callback",
  );

  phaseName = "stop active follow-up/no resurrection";
  phase = "stop";
  let unreadableRoot: string | undefined;
  let unreadableClientId: string | undefined;
  let failedExactReads = 0;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const response = await nativeFetch(input, init);
    if (
      !unreadableRoot &&
      url.endsWith(`/api/sessions/${sessionId}/io/messages`) &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body));
      if (body.client_metadata?.kind === "morphz.task-source-change") {
        assert.ok(response.ok);
        unreadableClientId = body.client_message_id;
        unreadableRoot = z
          .object({ event_id: z.string() })
          .parse(await response.clone().json()).event_id;
      }
    }
    if (
      unreadableRoot &&
      url.endsWith(`/api/sessions/${sessionId}/turns/${unreadableRoot}/thread`)
    ) {
      failedExactReads++;
      // A real Runtime HTTP response existed, but the Host loses its read.
      // This is a network-unobservable Thread, not an invented Runtime 404.
      throw new TypeError(
        "Synthetic loss of actual accepted follow-up Thread inspection",
      );
    }
    return response;
  };
  await reviseSource("v8 active stop");
  await waitUntil(
    () => stopProviderStarted && !!unreadableRoot && failedExactReads > 0,
    "actual accepted follow-up with unavailable Host inspection",
  );
  assert.equal(
    (await sourceEvents()).find(
      (row) => row.event.eventId === unreadableClientId,
    )!.receipt,
    null,
  );
  assert.equal((await thread(sessionId, unreadableRoot!)).lifecycle, "open");
  const beforeStop = await link();
  await host!.connection.call(
    "task.control",
    {
      id: taskId,
      run: 1,
      revision: beforeStop.bridge.controlRevision,
      action: "stop",
    },
    { identityGeneration: client.boot.csrfToken },
  );
  await delay(1_700);
  const pendingStop = await link();
  assert.equal(
    pendingStop.bridge.stopRequested,
    true,
    "Missing follow-up inspection must retain durable stop intent",
  );
  assert.equal(
    pendingStop.bridge.sourceStopped,
    false,
    "Original terminal Schedule cannot stand in for follow-up stop confirmation",
  );
  const pendingVersion = await client.taskVersion(taskId);
  await assert.rejects(
    client.reviseTask({
      commandId: randomUUID(),
      taskId,
      expectedRevision: pendingVersion.revision,
      assigneeId: client.boot.actantId,
    }),
    (error) =>
      error instanceof ApplicationRequestError &&
      error.status === 409 &&
      error.code === "conflict" &&
      /停止|执行|确认/.test(error.message),
    "An unconfirmed follow-up must reject reassignment with a real domain conflict",
  );
  globalThis.fetch = nativeFetch;
  await control("stop");
  await confirmedSourceCount(5);
  const stopping = await eventForVersion(8);
  assert.equal(stopping.receipt!.eventId, unreadableRoot);
  assert.equal(
    (await thread(sessionId, stopping.receipt!.rootId)).lifecycle,
    "cancelled",
    "Stopping the original watch must cancel an already accepted follow-up",
  );
  stopGate.release();
  const stoppedCalls = providerCalls;
  phase = "stopped";
  await reviseSource("v9 after stop");
  await delay(3_300);
  assert.equal((await sourceEvents()).length, 5);
  assert.equal(providerCalls, stoppedCalls);
  assert.equal(
    (
      await client.content({
        projectId,
        query: "TEST 来源接续 stop",
        limit: 50,
      })
    ).items.filter((entry) => entry.title === "TEST 来源接续 stop").length,
    0,
    "Cancelled model response cannot authorize a tool afterwards",
  );
  await close();
  await start();
  await delay(3_300);
  assert.equal((await sourceEvents()).length, 5);
  assert.equal(providerCalls, stoppedCalls);
  assert.equal((await link()).bridge.sourceStopped, true);
  assertNoLegacyWorkspace();
  completed.push(
    "accepted but unreadable follow-up: stop/reassignment remain fenced until real inspection; then cancellation survives restart",
  );

  phaseName = "queued/actual reschedule/dependency gates";
  phase = "gating";
  const gatingCalls = providerCalls;
  const deferredTaskId = randomUUID(),
    dependentTaskId = randomUUID();
  const originalNotBefore = new Date(Date.now() + 10_000).toISOString();
  await client.createTask({
    commandId: randomUUID(),
    taskId: deferredTaskId,
    projectId,
    title: "TEST 真实未来安排",
    assigneeId: "morphz-agent",
    modelId: "test-model",
    notBefore: originalNotBefore,
    watchSourceIds: [sourceContentId],
  });
  await client.requestTaskRun({
    commandId: randomUUID(),
    taskId: deferredTaskId,
    expectedRevision: 1,
  });
  await waitUntil(
    async () => (await links(deferredTaskId)).length === 1,
    "actual future Schedule link",
  );
  const deferred = await link(deferredTaskId);
  const scheduleSchema = z.object({
    id: z.string(),
    revision: z.number(),
    status: z.string(),
    not_before: z.string().nullable(),
    dependency_thread_ids: z.array(z.string()),
  });
  const scheduled = scheduleSchema.parse(
    await runtimeGet(
      `/api/sessions/${deferred.runtime.sessionId}/schedules/${deferred.runtime.scheduleId}`,
    ),
  );
  assert.equal(scheduled.status, "queued");
  const changedNotBefore = new Date(Date.now() + 120_000).toISOString();
  const reschedule = await nativeFetch(
    `${runtimeURL}/api/sessions/${deferred.runtime.sessionId}/schedules/${deferred.runtime.scheduleId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "reschedule",
        expected_revision: scheduled.revision,
        not_before: changedNotBefore,
        interval_seconds: null,
      }),
    },
  );
  assert.equal(reschedule.status, 200, await reschedule.clone().text());
  await client.createTask({
    commandId: randomUUID(),
    taskId: dependentTaskId,
    projectId,
    title: "TEST 真实依赖等待",
    assigneeId: "morphz-agent",
    modelId: "test-model",
    dependsOnIds: [deferredTaskId],
    watchSourceIds: [sourceContentId],
  });
  await client.requestTaskRun({
    commandId: randomUUID(),
    taskId: dependentTaskId,
    expectedRevision: 1,
  });
  await waitUntil(
    async () => (await links(dependentTaskId)).length === 1,
    "actual dependency Schedule link",
  );
  const dependent = await link(dependentTaskId);
  const waiting = scheduleSchema.parse(
    await runtimeGet(
      `/api/sessions/${dependent.runtime.sessionId}/schedules/${dependent.runtime.scheduleId}`,
    ),
  );
  assert.equal(waiting.status, "queued");
  assert.deepEqual(waiting.dependency_thread_ids, [deferred.runtime.threadId]);
  await waitUntil(
    () => Date.now() > Date.parse(originalNotBefore),
    "original frozen not_before elapsed, actual rescheduled date still future",
  );
  await reviseSource("v10 while actual schedules remain queued");
  await delay(3_300);
  assert.equal(
    providerCalls,
    gatingCalls,
    "Source Signals must not bypass the actual Schedule's date or unfinished prerequisite",
  );
  for (const selectedTaskId of [deferredTaskId, dependentTaskId]) {
    assert.equal(
      (
        await platform().taskRunSourceEvents(
          client.boot.centerId,
          selectedTaskId,
          1,
        )
      ).length,
      0,
      "Queued tasks must not generate source events",
    );
    const selected = await link(selectedTaskId);
    assert.equal(
      (
        await runtimeGet(
          `/api/sessions/${selected.runtime.sessionId}/schedules/${selected.runtime.scheduleId}`,
        )
      ).status,
      "queued",
    );
  }
  await control("stop", dependentTaskId);
  await control("stop", deferredTaskId);
  completed.push(
    "actual queued/rescheduled date and unfinished dependency: revisions cannot start a model early",
  );

  phaseName = "uncertain POST/actual 404/late acceptance after stop";
  phase = "initial";
  const lateTaskId = randomUUID();
  await client.createTask({
    commandId: randomUUID(),
    taskId: lateTaskId,
    projectId,
    title: "TEST 真实不明来源投递",
    assigneeId: "morphz-agent",
    modelId: "test-model",
    watchSourceIds: [sourceContentId],
  });
  await client.requestTaskRun({
    commandId: randomUUID(),
    taskId: lateTaskId,
    expectedRevision: 1,
  });
  await waitUntil(
    async () => (await links(lateTaskId)).length === 1,
    "actual original run before uncertain source POST",
  );
  const lateRun = await link(lateTaskId);
  await waitTerminal(
    lateRun.runtime.sessionId,
    `client-schedule-${lateRun.runtime.scheduleId}`,
  );
  phase = "late-stop";
  let lateClientId: string | undefined;
  let lateAcceptedId: string | undefined;
  let lateFrozenWire: unknown;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      url.endsWith(`/api/sessions/${lateRun.runtime.sessionId}/io/messages`) &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body));
      if (body.message?.content?.value?.taskId === lateTaskId) {
        if (!lateClientId) {
          lateClientId = body.client_message_id;
          lateFrozenWire = body;
          // An outstanding transport request may arrive after the caller saw
          // a failure. Neither the 200 nor its event/Thread is simulated.
          forwardedPost = latePostGate.promise.then(async () => {
            const response = await nativeFetch(input, init);
            assert.equal(response.status, 200, await response.clone().text());
            lateAcceptedId = z
              .object({ event_id: z.string() })
              .parse(await response.json()).event_id;
          });
        }
        throw new TypeError(
          "Synthetic uncertain source POST with outstanding real Runtime wire",
        );
      }
    }
    return nativeFetch(input, init);
  };
  await reviseSource("v11 uncertain outstanding POST");
  await waitUntil(
    () => !!lateClientId,
    "actual committed attempt before uncertain POST",
  );
  const pendingAttempt = (
    await platform().taskRunSourceEvents(client.boot.centerId, lateTaskId, 1)
  ).find((row) => row.event.eventId === lateClientId);
  assert.ok(
    pendingAttempt?.deliveryAttempted,
    "A real delivery attempt must be durable before the transport error",
  );
  assert.equal(pendingAttempt.receipt, null);
  assert.deepEqual(pendingAttempt.event.request, lateFrozenWire);
  const beforeLateStop = await link(lateTaskId);
  await host!.connection.call(
    "task.control",
    {
      id: lateTaskId,
      run: 1,
      revision: beforeLateStop.bridge.controlRevision,
      action: "stop",
    },
    { identityGeneration: client.boot.csrfToken },
  );
  const actualAbsent = await nativeFetch(
    `${runtimeURL}/api/sessions/${lateRun.runtime.sessionId}/messages/by-client-id/${lateClientId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(
    actualAbsent.status,
    404,
    "The real Runtime has not accepted this outstanding request yet",
  );
  const callsWhileUncertain = providerCalls;
  await delay(3_300);
  const uncertainStop = await link(lateTaskId);
  assert.equal(uncertainStop.bridge.stopRequested, true);
  assert.equal(
    uncertainStop.bridge.sourceStopped,
    false,
    "A real momentary 404 cannot prove an outstanding POST will never commit",
  );
  assert.equal(providerCalls, callsWhileUncertain);
  const uncertainTask = await client.taskVersion(lateTaskId);
  await assert.rejects(
    client.reviseTask({
      commandId: randomUUID(),
      taskId: lateTaskId,
      expectedRevision: uncertainTask.revision,
      assigneeId: client.boot.actantId,
    }),
    (error) =>
      error instanceof ApplicationRequestError &&
      error.status === 409 &&
      error.code === "conflict",
    "A 404 with an outstanding attempt does not allow reassignment",
  );
  latePostGate.release();
  await forwardedPost!;
  assert.ok(lateAcceptedId);
  globalThis.fetch = nativeFetch;
  await control("stop", lateTaskId);
  assert.equal(
    (await thread(lateRun.runtime.sessionId, lateAcceptedId)).lifecycle,
    "cancelled",
    "Stop must reconcile and cancel the request which actually arrived late",
  );
  lateModelGate.release();
  await delay(1_700);
  const finalLate = await platform().taskRunSourceEvents(
    client.boot.centerId,
    lateTaskId,
    1,
  );
  assert.equal(finalLate.length, 1);
  assert.equal(finalLate[0]!.receipt!.eventId, lateAcceptedId);
  assert.equal(
    finalLate[0]!.discarded,
    false,
    "The accepted request cannot have been discarded based on its earlier 404",
  );
  assert.equal(
    (
      await client.content({
        projectId,
        query: "TEST 来源接续 late-stop",
        limit: 50,
      })
    ).items.filter((entry) => entry.title === "TEST 来源接续 late-stop").length,
    0,
  );
  completed.push(
    "uncertain POST + actual Runtime 404: stop/reassignment stay fenced; late actual acceptance is reconciled and cancelled",
  );

  phaseName = "active retry after POST fails before reaching actual Runtime";
  phase = "initial";
  const retryTaskId = randomUUID();
  await client.createTask({
    commandId: randomUUID(),
    taskId: retryTaskId,
    projectId,
    title: "TEST 真实来源网络失败后原请求重试",
    assigneeId: "morphz-agent",
    modelId: "test-model",
    reasoningEffort: "low",
    watchSourceIds: [sourceContentId],
  });
  await client.requestTaskRun({
    commandId: randomUUID(),
    taskId: retryTaskId,
    expectedRevision: 1,
  });
  await waitUntil(
    async () => (await links(retryTaskId)).length === 1,
    "actual original run before retryable source POST",
  );
  const retryRun = await link(retryTaskId);
  const retryOriginalRoot = `client-schedule-${retryRun.runtime.scheduleId}`;
  await waitTerminal(retryRun.runtime.sessionId, retryOriginalRoot);
  expectedAdmissionEventId = `task_run_${retryRun.runtime.scheduleId.slice(5)}`;
  phase = "retry";
  let retryClientId: string | undefined;
  let retryAcceptedId: string | undefined;
  let retryWire: string | undefined;
  let retryPostAttempts = 0;
  const callsBeforeActiveRetry = providerCalls;
  const readActualAttempt = () => {
    assert.ok(retryClientId);
    const actualPlatform = new DatabaseSync(
      join(applicationDirectory, "platform.sqlite"),
      { readOnly: true },
    );
    try {
      const row = actualPlatform
        .prepare(
          "SELECT payload FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.source_changed'",
        )
        .get(client.boot.centerId, retryClientId);
      assert.ok(row);
      return z
        .object({
          event: z.object({ request: z.unknown() }),
          receipt: z.unknown().nullable(),
          deliveryAttempts: z.array(z.string().uuid()).length(1),
          deliveryReplayed: z.boolean(),
        })
        .parse(JSON.parse(String(row.payload)));
    } finally {
      actualPlatform.close();
    }
  };
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      url.endsWith(`/api/sessions/${retryRun.runtime.sessionId}/io/messages`) &&
      init?.method === "POST"
    ) {
      const wire = String(init.body);
      const body = JSON.parse(wire);
      if (body.message?.content?.value?.taskId === retryTaskId) {
        retryPostAttempts++;
        if (!retryClientId) {
          retryClientId = body.client_message_id;
          retryWire = wire;
          // This failure occurs before nativeFetch: the actual Runtime has
          // received no request and must genuinely report 404 for this ID.
          throw new TypeError("Synthetic network failure before actual POST");
        }
        assert.equal(body.client_message_id, retryClientId);
        assert.equal(
          wire,
          retryWire,
          "Retry must replay the complete frozen wire",
        );
        // A test transport gate establishes the negative Runtime read before
        // forwarding the next real POST. It never fabricates a receipt/event.
        await retryPostGate.promise;
        const response = await nativeFetch(input, init);
        assert.equal(response.status, 200, await response.clone().text());
        retryAcceptedId = z
          .object({ event_id: z.string() })
          .parse(await response.clone().json()).event_id;
        return response;
      }
    }
    return nativeFetch(input, init);
  };
  const retryCommand = await reviseSource(
    "v12 initial POST never reached Runtime",
  );
  await waitUntil(
    () => !!retryClientId,
    "actual persisted source attempt before pre-send network failure",
  );
  const firstAttempt = readActualAttempt();
  assert.equal(firstAttempt.receipt, null);
  assert.equal(firstAttempt.deliveryReplayed, false);
  assert.deepEqual(firstAttempt.event.request, JSON.parse(retryWire!));
  const actuallyNotReceived = await nativeFetch(
    `${runtimeURL}/api/sessions/${retryRun.runtime.sessionId}/messages/by-client-id/${retryClientId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(actuallyNotReceived.status, 404);
  const stillActive = await link(retryTaskId);
  assert.equal(stillActive.bridge.paused, false);
  assert.equal(stillActive.bridge.stopRequested, false);
  assert.equal(stillActive.bridge.sourceStopped, false);
  await waitUntil(
    () => retryPostAttempts === 2,
    "next active dispatcher pass retries the frozen request",
  );
  const replayedAttempt = readActualAttempt();
  assert.equal(replayedAttempt.receipt, null);
  assert.equal(replayedAttempt.deliveryReplayed, true);
  assert.deepEqual(
    replayedAttempt.deliveryAttempts,
    firstAttempt.deliveryAttempts,
  );
  assert.deepEqual(replayedAttempt.event.request, firstAttempt.event.request);
  retryPostGate.release();
  await waitUntil(async () => {
    const rows = await platform().taskRunSourceEvents(
      client.boot.centerId,
      retryTaskId,
      1,
    );
    return rows.length === 1 && !!rows[0]!.receipt;
  }, "actual accepted retry receipt");
  const retryEvents = await platform().taskRunSourceEvents(
    client.boot.centerId,
    retryTaskId,
    1,
  );
  const retryEvent = retryEvents[0]!;
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvent.event.eventId, retryClientId);
  assert.equal(retryEvent.receipt!.eventId, retryAcceptedId);
  assert.equal(retryEvent.receipt!.rootId, retryAcceptedId);
  assert.notEqual(retryEvent.receipt!.rootId, retryOriginalRoot);
  assert.equal(retryEvent.event.destination.kind, "follow-up");
  assert.deepEqual(retryEvent.event.sourceCommandIds, [retryCommand]);
  assert.deepEqual(retryEvent.event.request, JSON.parse(retryWire!));
  const actualRetry = await sourceRuntimeEvent(
    retryClientId!,
    retryRun.runtime.sessionId,
    retryTaskId,
  );
  assert.equal(actualRetry.root.id, retryAcceptedId);
  assert.equal(actualRetry.data.admissionEventId, expectedAdmissionEventId);
  assert.ok(
    actualRetry.data.sources.some(
      (source) =>
        source.sourceId === sourceContentId &&
        source.versionRef === String(sourceRevision),
    ),
  );
  await assertDelivery("retry");
  await waitTerminal(retryRun.runtime.sessionId, retryEvent.receipt!.rootId);
  const retryThread = await thread(
    retryRun.runtime.sessionId,
    retryEvent.receipt!.rootId,
  );
  const retrySession = z
    .object({ context_id: z.string() })
    .parse(await runtimeGet(`/api/sessions/${retryRun.runtime.sessionId}`));
  const actualSessionJobs = z.object({ jobs: z.array(jobSchema) }).parse(
    await runtimeGet(
      "/api/execution-jobs?" +
        new URLSearchParams({
          session_id: retryRun.runtime.sessionId,
          context_id: retrySession.context_id,
          include_terminal: "true",
          newest_first: "true",
          limit: "100",
        }),
    ),
  ).jobs;
  const actualRetryJobs = actualSessionJobs.filter(
    (job) => job.thread_id === retryThread.thread_id,
  );
  assert.equal(
    actualRetryJobs.length,
    1,
    "The real source tool produced one durable job",
  );
  assert.equal(actualRetryJobs[0]!.tool_name, "host_morphz");
  assert.equal(actualRetryJobs[0]!.status, "succeeded");
  assert.ok(actualRetryJobs[0]!.result_event_id);
  assert.ok(
    actualSessionJobs.some((job) => job.thread_id !== retryThread.thread_id),
    "Shared Session negative control must contain other runs' actual jobs",
  );
  const originalRetryScope = {
    projectId,
    artifactId: retryTaskId,
    threadId: retryRun.runtime.threadId,
    taskRun: true,
  };
  const readRetryExecution = async () =>
    executionSnapshotSchema.parse(
      await host!.connection.call("execution.snapshot", originalRetryScope, {
        identityGeneration: client.boot.csrfToken,
      }),
    );
  const executionBeforeRetryRestart = await readRetryExecution();
  assert.deepEqual(
    executionBeforeRetryRestart.jobs.map((job) => job.id).sort(),
    actualRetryJobs.map((job) => job.id).sort(),
    "Original run inspector must include its actual follow-up job and exclude unrelated roots in the same Session",
  );
  // No approval-requiring tool is issued by this synthetic provider. Empty
  // approvals are not claimed as proof of a real waiting-approval lifecycle.
  assert.deepEqual(executionBeforeRetryRestart.approvals, []);
  const actualResult = z
    .object({
      event: z.object({
        id: z.literal(actualRetryJobs[0]!.result_event_id!),
        payload: z.object({ text: z.string().optional() }),
      }),
    })
    .parse(
      await runtimeGet(`/api/execution-jobs/${actualRetryJobs[0]!.id}/result`),
    );
  const inspectorResult = z
    .object({
      text: z.string(),
      truncated: z.boolean(),
      available: z.literal(true),
    })
    .parse(
      await host!.connection.call(
        "execution.result",
        { scope: originalRetryScope, jobId: actualRetryJobs[0]!.id },
        { identityGeneration: client.boot.csrfToken },
      ),
    );
  assert.equal(
    inspectorResult.text,
    (actualResult.event.payload.text ?? "").slice(0, 64000),
  );
  assert.equal(
    retryPostAttempts,
    2,
    "Only initial failure and one real retry POST",
  );
  assert.equal(
    providerCalls - callsBeforeActiveRetry,
    2,
    "Exactly one actual tool evaluation and its completion evaluation",
  );
  assert.equal((await links(retryTaskId)).length, 1);
  const callsBeforeRetryReopen = providerCalls;
  await close();
  globalThis.fetch = nativeFetch;
  await start();
  await delay(3_300);
  const retryEventsAfterReopen = await platform().taskRunSourceEvents(
    client.boot.centerId,
    retryTaskId,
    1,
  );
  assert.deepEqual(retryEventsAfterReopen, retryEvents);
  assert.equal(providerCalls, callsBeforeRetryReopen);
  assert.deepEqual(
    readActualAttempt().deliveryAttempts,
    firstAttempt.deliveryAttempts,
  );
  const receivedRetryEvents = z
    .object({
      events: z.array(
        z.object({
          id: z.string(),
          payload: z.record(z.string(), z.unknown()),
        }),
      ),
    })
    .parse(
      await runtimeGet(
        `/api/sessions/${retryRun.runtime.sessionId}/events?limit=1000`,
      ),
    );
  assert.deepEqual(
    receivedRetryEvents.events
      .filter((event) => event.payload.client_message_id === retryClientId)
      .map((event) => event.id),
    [retryAcceptedId],
    "The stable source ID created exactly one Runtime root across real cold restart",
  );
  await assertDelivery("retry");
  assert.deepEqual(
    (await readRetryExecution()).jobs.map((job) => job.id).sort(),
    actualRetryJobs.map((job) => job.id).sort(),
    "Actual source job history survives both process restarts under its original run",
  );
  await control("stop", retryTaskId);
  const executionAfterRetryStop = await readRetryExecution();
  assert.deepEqual(
    executionAfterRetryStop.jobs.map((job) => job.id).sort(),
    actualRetryJobs.map((job) => job.id).sort(),
    "Stopping the source watch must not hide the original run's real job history",
  );
  assert.deepEqual(executionAfterRetryStop.approvals, []);
  assert.deepEqual(
    await host!.connection.call(
      "execution.result",
      { scope: originalRetryScope, jobId: actualRetryJobs[0]!.id },
      { identityGeneration: client.boot.csrfToken },
    ),
    inspectorResult,
    "Stopped source work still exposes the same actual historical job result",
  );
  assertNoLegacyWorkspace();
  completed.push(
    "active pre-send failure + actual 404: same ID/wire/attempt retries once, one authorized tool/root; cold reopen keeps the exact receipt and original-run job/result history remains visible after stop",
  );
  passed = true;
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        actualRuntime: binary,
        applicationBackend: "sqlite",
        runtimeBackend: "sqlite",
        syntheticProvider: true,
        realModelQualityVerified: false,
        checks: completed,
        providerCalls,
        sourceEvents: (await sourceEvents()).length,
        additionalUncertainSourceEvents: finalLate.length,
        additionalActiveRetrySourceEvents: retryEventsAfterReopen.length,
        activeRetryPostAttempts: retryPostAttempts,
        actualFollowUpJobsInOriginalExecutionScope: actualRetryJobs.length,
        actualApprovalLifecycleVerified: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `Actual source Runtime acceptance failed at ${phaseName}; completed=${JSON.stringify(completed)}`,
  );
  console.error(runtimeDiagnostics);
  throw error;
} finally {
  globalThis.fetch = nativeFetch;
  firstGate.release();
  stopGate.release();
  latePostGate.release();
  lateModelGate.release();
  retryPostGate.release();
  await forwardedPost?.catch((error) =>
    console.error("Failed outstanding test wire during cleanup", error),
  );
  await close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (passed) rmSync(directory, { recursive: true, force: true });
  else
    console.error(`Isolated failed acceptance evidence retained: ${directory}`);
}
