/** Real Runtime HTTP acceptance for Platform-owned task admission and dependencies.
 * Uses isolated databases, synthetic credentials and a local deterministic
 * provider. No user profile or paid/external model service is loaded.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { PlatformTaskRunDispatcher } from "../packages/application/src/platform-task-run-dispatcher.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { runtimeFixtureFinalReply } from "./runtime-fixture-reply.js";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "先构建 Morphz Runtime，再运行事项联合验收。");
const root = mkdtempSync(join(tmpdir(), "morphz-platform-task-runtime-"));
const runtimeDirectory = join(root, "runtime");
const namespace = `task-${randomUUID()}`;
const token = randomBytes(32).toString("hex");
const tenantId = `tenant-${randomUUID()}`;
const sessionId = `session-${randomUUID()}`;
const contextId = `mw-context-${namespace}`;
const configFile = join(root, "morphz.toml");
let providerCalls = 0;
let releaseSource!: () => void;
let sourceStarted!: () => void;
const sourceGate = new Promise<void>((resolve) => {
  releaseSource = resolve;
});
const sourceReceived = new Promise<void>((resolve) => {
  sourceStarted = resolve;
});
const provider = createHttpServer(async (request, response) => {
  if (request.method !== "POST") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (++providerCalls === 1) {
    sourceStarted();
    await sourceGate;
  }
  const { message, finishReason } = runtimeFixtureFinalReply(input, {
    content: "合成事项执行已结束。",
    title: "完成合成事项执行",
    result: "合成事项执行已结束。",
  });
  if (input.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index })) } : {}) }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: randomUUID(),
        choices: [{ index: 0, message, finish_reason: finishReason }],
      }),
    );
  }
});
const verifier: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    return credential === "synthetic-human"
      ? {
          tenantId,
          principalId: localAccess.principalId,
          actantId: localAccess.actantId,
          kind: "human" as const,
          runtimeInputId: null,
        }
      : null;
  },
  async resolveActant({ tenantId: scope, actantId }) {
    if (scope !== tenantId) return null;
    if (actantId === localAccess.actantId)
      return { principalId: localAccess.principalId, kind: "human" as const };
    if (actantId === "morphz-agent")
      return { principalId: "morphz-service", kind: "agent" as const };
    return null;
  },
  async resolveProjectAgent({ tenantId: scope }) {
    return scope === tenantId
      ? { principalId: "morphz-service", actantId: "morphz-agent" }
      : null;
  },
  async verifyApplicationObject() {
    return false;
  },
};

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let processHandle: ChildProcess | undefined;
let runtimeURL = "";
let runtimeDiagnostics = "";
let passed = false;
async function startRuntime() {
  // A restarted Runtime keeps its configured endpoint; only the process changes.
  const port = runtimeURL ? Number(new URL(runtimeURL).port) : await freePort();
  runtimeURL = `http://127.0.0.1:${port}`;
  const child = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${port}`,
      "--cwd",
      root,
      "--config-file",
      configFile,
      "--log-level",
      "warn",
    ],
    {
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        MORPHZ_HOME: runtimeDirectory,
        MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_TASK_SMOKE_KEY: "synthetic-unused",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const retainDiagnostic = (chunk: Buffer) => {
    runtimeDiagnostics = (runtimeDiagnostics + chunk.toString()).slice(-12000);
  };
  child.stdout?.on("data", retainDiagnostic);
  child.stderr?.on("data", retainDiagnostic);
  processHandle = child;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (
        (
          await fetch(`${runtimeURL}/health`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        return;
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("隔离 Runtime 在就绪前退出。");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("隔离 Runtime 启动超时。");
}

async function stopRuntime() {
  const child = processHandle;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    processHandle = undefined;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("隔离 Runtime 未能停止。")),
      15_000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
  processHandle = undefined;
}

function bridge(workspace: WorkspaceStore) {
  return new RuntimeBridge(
    workspace,
    { url: runtimeURL, token, namespace },
    undefined,
    false,
  );
}

const human = { credential: "synthetic-human" };
let platform: PlatformStore | undefined;
let workspace: WorkspaceStore | undefined;
try {
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const providerPort = (provider.address() as { port: number }).port;
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  writeFileSync(
    configFile,
    `[llm]\nmodel="test-model"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_TASK_SMOKE_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(root)}\n`,
    { mode: 0o600 },
  );
  await startRuntime();
  const accountBinding = await fetch(
    `${runtimeURL}/api/agents/default-agent/provider-accounts/stub`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  assert.ok(accountBinding.ok, "仅为隔离 Agent 绑定本地合成供应商账号");
  const sessionResponse = await fetch(`${runtimeURL}/api/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: sessionId,
      title: "Isolated Platform Task",
      mount: {
        type: "new_blank_context",
        context_id: contextId,
        context_title: "Isolated Platform Task",
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(sessionResponse.status, 201);
  assert.equal((await sessionResponse.json()).context_id, contextId);
  // Establish the fresh Host's center identity before opening authoritative
  // domain stores; existing-domain recovery must never mint a new identity.
  workspace = new WorkspaceStore(join(root, "workspace.sqlite"));
  platform = await PlatformStore.sqlite(
    join(root, "platform.sqlite"),
    verifier,
  );
  await platform.provisionTenant(tenantId);
  await platform.createProject(human, {
    commandId: "project-command",
    projectId: "project-one",
    title: "Isolated project",
  });
  await platform.createTask(human, {
    commandId: "task-command",
    taskId: "task-one",
    projectId: "project-one",
    title: "Future task",
    assigneeId: "morphz-agent",
  });
  const preparedTaskSession =
    await bridge(workspace).preparePlatformTaskSession("project-one");
  assert.equal(
    await bridge(workspace).preparePlatformTaskSession("project-one"),
    preparedTaskSession,
    "Host must reuse one project-scoped task execution Session",
  );
  const preparedSessionResponse = await fetch(
    `${runtimeURL}/api/sessions/${preparedTaskSession}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(preparedSessionResponse.status, 200);
  assert.equal((await preparedSessionResponse.json()).context_id, contextId);
  const admission = await platform.requestTaskRun(human, {
    commandId: "admission-command",
    taskId: "task-one",
    expectedRevision: 1,
    sessionId,
    intent: "Only verify durable scheduling; do not run a model",
    notBefore: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  const first = await bridge(workspace).deliverTaskRun(admission, localAccess);
  assert.equal(first.schedule.id, admission.request.id);
  assert.equal(first.schedule.status, "queued");
  assert.equal(first.thread.lifecycle, "open");
  assert.equal(
    first.thread.root_turn_id,
    `client-schedule-${admission.request.id}`,
  );
  assert.deepEqual(await platform.pendingTaskRuns(tenantId), [admission]);

  // The Runtime committed its Schedule, but the Host did not confirm the
  // Platform link. Restart both processes and retry the exact admission.
  await stopRuntime();
  await platform.close();
  platform = undefined;
  await startRuntime();
  const runtimeRef = {
    sessionId,
    scheduleId: first.schedule.id,
    threadId: first.thread.thread_id,
  };
  const recovered = await bridge(workspace)
    .taskRunStatusReader()
    .inspect(runtimeRef, localAccess);
  assert.equal(
    recovered.schedule.status,
    "queued",
    `Runtime restart changed the persisted Schedule: ${JSON.stringify(recovered)}`,
  );
  assert.equal(recovered.thread.lifecycle, "open");
  platform = await PlatformStore.sqlite(
    join(root, "platform.sqlite"),
    verifier,
  );
  const dispatcher = new PlatformTaskRunDispatcher(
    platform,
    tenantId,
    bridge(workspace),
    async () => localAccess,
    (admission) =>
      platform!.prepareTaskRun(human, admission.eventId, (ref) =>
        bridge(workspace).taskRunStatusReader().inspect(ref, localAccess),
      ),
    (error) => {
      throw error;
    },
  );
  await dispatcher.drain();
  assert.deepEqual(await platform.pendingTaskRuns(tenantId), []);
  const links = await platform.listTaskRunLinks(human, "task-one");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.runtime.scheduleId, first.schedule.id);
  assert.equal(links[0]!.runtime.threadId, first.thread.thread_id);
  const live = await bridge(workspace)
    .taskRunStatusReader()
    .inspect(links[0]!.runtime, localAccess);
  assert.equal(live.source, "runtime");
  assert.equal(live.schedule.status, "queued");
  assert.equal(live.thread.lifecycle, "open");
  await dispatcher.drain();
  assert.equal((await platform.listTaskRunLinks(human, "task-one")).length, 1);
  assert.equal(
    await bridge(workspace).preparePlatformTaskSession("project-one"),
    preparedTaskSession,
    "the Host task Session must survive Runtime restart",
  );
  await platform.createTask(human, {
    commandId: "task-two-command",
    taskId: "task-two",
    projectId: "project-one",
    title: "Host-owned Session task",
    assigneeId: "morphz-agent",
  });
  const second = await platform.requestTaskRun(human, {
    commandId: "admission-two-command",
    taskId: "task-two",
    expectedRevision: 1,
    sessionId: preparedTaskSession,
    intent: "Verify Host-owned Session dispatch without a model request",
    notBefore: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  await dispatcher.drain();
  const secondLinks = await platform.listTaskRunLinks(human, "task-two");
  assert.equal(secondLinks.length, 1);
  assert.equal(secondLinks[0]!.runtime.sessionId, preparedTaskSession);
  assert.equal(secondLinks[0]!.runtime.scheduleId, second.request.id);
  const execution = await bridge(workspace).platformTaskExecutionControls(
    "project-one",
    secondLinks[0]!.runtime,
    localAccess,
  );
  const executionView = await execution.snapshot({
    projectId: "project-one",
    artifactId: "task-two",
    threadId: secondLinks[0]!.runtime.threadId,
    taskRun: true,
  });
  assert.deepEqual(executionView.jobs, []);
  assert.deepEqual(executionView.approvals, []);
  await platform.requestTaskRunControl(
    human,
    "task-two",
    1,
    secondLinks[0]!.bridge.controlRevision,
    "pause",
  );
  await dispatcher.drain();
  let controlled = (await platform.listTaskRunLinks(human, "task-two"))[0]!;
  assert.equal(controlled.bridge.controlPending, null);
  assert.equal(controlled.bridge.paused, true);
  assert.equal(
    (
      await bridge(workspace)
        .taskRunStatusReader()
        .inspect(controlled.runtime, localAccess)
    ).schedule.status,
    "paused",
  );
  await platform.requestTaskRunControl(
    human,
    "task-two",
    1,
    controlled.bridge.controlRevision,
    "resume",
  );
  await dispatcher.drain();
  controlled = (await platform.listTaskRunLinks(human, "task-two"))[0]!;
  assert.equal(controlled.bridge.controlPending, null);
  assert.equal(controlled.bridge.paused, false);
  assert.equal(
    (
      await bridge(workspace)
        .taskRunStatusReader()
        .inspect(controlled.runtime, localAccess)
    ).schedule.status,
    "queued",
  );
  await platform.requestTaskRunStop(
    human,
    "task-two",
    1,
    controlled.bridge.controlRevision,
  );
  assert.equal((await platform.pendingTaskRunStops(tenantId)).length, 1);
  await platform.close();
  platform = undefined;
  await stopRuntime();
  await startRuntime();
  platform = await PlatformStore.sqlite(
    join(root, "platform.sqlite"),
    verifier,
  );
  const stoppingDispatcher = new PlatformTaskRunDispatcher(
    platform,
    tenantId,
    bridge(workspace),
    async () => localAccess,
    (admission) =>
      platform!.prepareTaskRun(human, admission.eventId, (ref) =>
        bridge(workspace).taskRunStatusReader().inspect(ref, localAccess),
      ),
    (error) => {
      throw error;
    },
  );
  await stoppingDispatcher.drain();
  assert.deepEqual(await platform.pendingTaskRunStops(tenantId), []);
  const stopped = (await platform.listTaskRunLinks(human, "task-two"))[0]!;
  assert.equal(stopped.bridge.sourceStopped, true);
  assert.equal(stopped.bridge.stopRequested, false);
  const stoppedRuntime = await bridge(workspace)
    .taskRunStatusReader()
    .inspect(stopped.runtime, localAccess);
  assert.equal(stoppedRuntime.schedule.status, "cancelled");
  assert.equal(stoppedRuntime.thread.lifecycle, "cancelled");
  assert.equal(providerCalls, 0, "未来安排和停止不得调用模型");

  await platform.createTask(human, {
    commandId: "human-source-create",
    taskId: "human-source",
    projectId: "project-one",
    title: "提供人工结果",
    assigneeId: localAccess.actantId,
  });
  await platform.createTask(human, {
    commandId: "human-dependent-create",
    taskId: "human-dependent",
    projectId: "project-one",
    title: "等待人工结果",
    assigneeId: "morphz-agent",
    dependsOnIds: ["human-source"],
  });
  const humanDependent = await platform.requestTaskRun(human, {
    commandId: "human-dependent-start",
    taskId: "human-dependent",
    expectedRevision: 1,
    sessionId: preparedTaskSession,
    intent: "读取固定人工结果",
    notBefore: new Date(Date.now() + 86400000).toISOString(),
  });
  await stoppingDispatcher.drain();
  assert.deepEqual(
    await platform.listTaskRunLinks(human, "human-dependent"),
    [],
  );
  const missingSchedule = await fetch(
    `${runtimeURL}/api/sessions/${preparedTaskSession}/schedules/${humanDependent.request.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(
    missingSchedule.status,
    404,
    "人工结果未提交时不向 Runtime 建安排",
  );
  await platform.respondTask(human, {
    commandId: "human-source-response",
    taskId: "human-source",
    expectedRevision: 1,
    body: "已经提交可引用的人工结果。",
  });
  await stoppingDispatcher.drain();
  assert.equal(
    (await platform.listTaskRunLinks(human, "human-dependent")).length,
    1,
  );
  const compiledHuman = await platform.taskRunAdmissionForRuntime(
    tenantId,
    preparedTaskSession,
    humanDependent.request.id,
  );
  assert.match(compiledHuman.request.intent, /responseId/);
  assert.ok(
    !compiledHuman.request.intent.includes("已经提交可引用的人工结果"),
    "请求只绑定答复版本，不另复制人工正文",
  );

  await platform.createTask(human, {
    commandId: "agent-source-create",
    taskId: "agent-source",
    projectId: "project-one",
    title: "真实前置执行",
    assigneeId: "morphz-agent",
  });
  const agentSource = await platform.requestTaskRun(human, {
    commandId: "agent-source-start",
    taskId: "agent-source",
    expectedRevision: 1,
    sessionId: preparedTaskSession,
    intent: "SYNTHETIC_DEPENDENCY_SOURCE",
    notBefore: new Date().toISOString(),
  });
  await stoppingDispatcher.drain();
  let sourceTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sourceReceived,
      new Promise((_, reject) => {
        sourceTimeout = setTimeout(
          () => reject(new Error("真实前置执行未进入合成模型。")),
          15000,
        );
      }),
    ]);
  } catch (error) {
    const source = (await platform.listTaskRunLinks(human, "agent-source"))[0];
    const state = source
      ? await bridge(workspace)
          .taskRunStatusReader()
          .inspect(source.runtime, localAccess)
      : null;
    throw new Error(
      `${String(error)}; source=${JSON.stringify(state)}; Runtime=${runtimeDiagnostics}`,
    );
  } finally {
    clearTimeout(sourceTimeout);
  }
  const sourceLink = (
    await platform.listTaskRunLinks(human, "agent-source")
  )[0]!;
  assert.equal(
    (
      await bridge(workspace)
        .taskRunStatusReader()
        .inspect(sourceLink.runtime, localAccess)
    ).thread.lifecycle,
    "open",
  );
  await platform.createTask(human, {
    commandId: "agent-dependent-create",
    taskId: "agent-dependent",
    projectId: "project-one",
    title: "真实依赖接续",
    assigneeId: "morphz-agent",
    dependsOnIds: ["agent-source"],
  });
  const agentDependent = await platform.requestTaskRun(human, {
    commandId: "agent-dependent-start",
    taskId: "agent-dependent",
    expectedRevision: 1,
    sessionId: preparedTaskSession,
    intent: "SYNTHETIC_DEPENDENCY_TARGET",
    notBefore: new Date().toISOString(),
  });
  await stoppingDispatcher.drain();
  const dependentLink = (
    await platform.listTaskRunLinks(human, "agent-dependent")
  )[0]!;
  assert.deepEqual(dependentLink.request.dependencyThreadIds, [
    sourceLink.runtime.threadId,
  ]);
  const waiting = await bridge(workspace)
    .taskRunStatusReader()
    .inspect(dependentLink.runtime, localAccess);
  assert.equal(waiting.schedule.status, "queued");
  assert.equal(waiting.thread.lifecycle, "open");
  assert.equal(providerCalls, 1, "前置模型尚未返回时，依赖执行不能调用模型");
  releaseSource();
  const completionDeadline = Date.now() + 15000;
  let complete = false;
  while (Date.now() < completionDeadline) {
    const result = await bridge(workspace)
      .taskRunStatusReader()
      .inspect(dependentLink.runtime, localAccess);
    if (result.thread.lifecycle === "completed") {
      complete = true;
      break;
    }
    if (result.thread.lifecycle !== "open")
      throw new Error(`依赖接续异常：${JSON.stringify(result)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(complete, "前置真实 Thread 完成后，依赖执行应由 Runtime 正常接续");
  assert.equal(providerCalls, 2);
  assert.equal(
    (
      await bridge(workspace)
        .taskRunStatusReader()
        .inspect(sourceLink.runtime, localAccess)
    ).thread.lifecycle,
    "completed",
  );
  assert.equal(agentSource.request.id, sourceLink.runtime.scheduleId);
  assert.equal(agentDependent.request.id, dependentLink.runtime.scheduleId);
  passed = true;
  console.log(
    "PASS: real Runtime restart, exact controls, Human result gate and actual dependency Thread execution; synthetic provider only.",
  );
} finally {
  releaseSource();
  await stopRuntime();
  await platform?.close();
  workspace?.close();
  if (provider.listening)
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`Isolated failure evidence retained: ${root}`);
}
