/** Real Runtime/Harness/Unix Host/SQLite integration. Synthetic provider and fresh data only. */
import "./application-configuration.mjs";
import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer } from "node:http";
import { Server } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import {
  scriptFaultPoints,
  ScriptFaultGate,
  scriptFaultProxy,
  type ScriptFaultPoint,
} from "./script-studio-fault-injection.js";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { AgentTools } from "../packages/application/src/agent-tools.js";
import {
  localAccess,
  type Operation,
  type Receipt,
} from "../packages/core/src/model.js";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import {
  currentScriptDraft,
  emptyScriptDraft,
  type ScriptCommand,
  type ScriptGeneration,
} from "../packages/core/src/script-studio.js";
import { buildScriptDocx } from "../packages/core/src/script-studio-docx.js";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "Build the compatible Runtime binary first.");
const harnessFile = fileURLToPath(
  new URL("../harnesses/script-studio.hns", import.meta.url),
);
const harnessRef = scriptStudioApplication.harness!;
const requestedFault = process.argv
  .find((arg) => arg.startsWith("--fault="))
  ?.slice(8);
assert.ok(
  !requestedFault ||
    scriptFaultPoints.includes(requestedFault as ScriptFaultPoint),
  "Unknown fault point",
);
const fault = requestedFault
  ? new ScriptFaultGate(requestedFault as ScriptFaultPoint)
  : undefined;
const hostErrors: string[] = [];
const originalToolCall = AgentTools.prototype.call;
AgentTools.prototype.call = async function (...args) {
  try {
    return await originalToolCall.apply(this, args);
  } catch (error) {
    hostErrors.push(String(error));
    throw error;
  }
};
const directory = mkdtempSync(join(tmpdir(), "morphz-script-runtime-"));
const runtimeDirectory = join(directory, "runtime");
const workDirectory = join(directory, "application");
const homeDirectory = join(directory, "home");
for (const path of [runtimeDirectory, workDirectory, homeDirectory])
  mkdirSync(path, { mode: 0o700 });
const runtimeToken = randomBytes(32).toString("hex");
let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
let runtime: ChildProcessWithoutNullStreams | undefined;
let manifest: { tools: { token: string; ipc_path: string }[] } | undefined;
let proxy: Awaited<ReturnType<typeof scriptFaultProxy>> | undefined;
let logs = "";
let providerCalls = 0;
let providerError: Error | undefined;
let productionId = "",
  targetId = "";
const sourceDraft = {
  ...emptyScriptDraft("第一集 · 合成验证"),
  text: "【场景】空站台。\n林：最后一班车没有来。",
};
const candidateDraft = {
  ...sourceDraft,
  text: "【场景】夜，空站台。\n林收起车票，听见检票口传来三声铃响。\n林：最后一班车没有来，谁在检票？\n【集尾】检票灯亮起，照出一张写着明日日期的车票。",
};
// Children are tool-free. The root only relays the durable Plan outcome.
const stages: string[] = [];
let scenario = fault
  ? fault.point === "model-discussion"
    ? "discussion"
    : "both-revisions"
  : "zero-review";
let reviewCount = 0;
let selectionStep = 0,
  preparationStep = 0;
const logicalModelCalls = new Map<
  string,
  { stage: string; round: number; attempts: number }
>();
const branchEvidence: {
  scenario: string;
  stages: string[];
  candidateCount: number;
}[] = [];
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const provider = createServer(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const tools =
      input.tools?.map(
        (t: { function?: { name?: string } }) => t.function?.name ?? "",
      ) ?? [];
    const context = JSON.stringify(input.messages);
    const evaluation = context.lastIndexOf("(evaluate ");
    const current = evaluation < 0 ? context : context.slice(evaluation);
    const internal = current.includes("(root-kind chat/infer_request)");
    const stage = internal
      ? [
          ...current.matchAll(
            /STAGE script-(discussion|intent|prepare|create|review|revise|delivery)/g,
          ),
        ].at(-1)?.[1]
      : scenario === "chat" && tools.includes("harness_select")
        ? "select"
        : "relay";
    assert.ok(stage, "A provider request must identify its actual Yao stage");
    const requestId =
      stage === "select"
        ? `select-${selectionStep}`
        : /\(origin-turn ([^)]+)\)/.exec(current)?.[1];
    assert.ok(
      requestId,
      "Model request must carry its persisted root identity",
    );
    let logicalCall = logicalModelCalls.get(requestId);
    if (!logicalCall) {
      if (stage === "review") reviewCount++;
      logicalCall = { stage, round: reviewCount, attempts: 0 };
      logicalModelCalls.set(requestId, logicalCall);
    }
    assert.equal(
      logicalCall.stage,
      stage,
      "Recovery cannot change a child stage",
    );
    logicalCall.attempts++;
    providerCalls++;
    writeFileSync(
      join(directory, `provider-${providerCalls}.json`),
      JSON.stringify(input),
      { mode: 0o600 },
    );
    assert.ok(
      providerCalls <= 100,
      "Bounded synthetic workflows, including a malformed model value",
    );
    if (stage !== "select") {
      assert.ok(context.includes("morphz.script-studio"));
      assert.ok(
        context.includes("script-studio/scene-and-screen"),
        "Child inherits the exact Harness craft Mind",
      );
      assert.ok(
        tools.every(
          (name: string) =>
            name === "no_reply" ||
            (stage === "prepare" && name === "host_morphz"),
        ),
        "Only preparation may use Host tools; creative steps cannot bypass the Plan",
      );
    }
    if (internal)
      assert.ok(
        !current.includes("original text has"),
        "Complete inference input, not a truncated preview",
      );
    stages.push(stage ?? "missing");
    if (
      ["review", "revise"].includes(stage) &&
      reviewCount === 2 &&
      [
        "both-revisions",
        "second-revision-blocked",
        "two-review-revise",
      ].includes(scenario)
    )
      assert.ok(
        current.includes("保留第一轮修改"),
        "Second pass must receive the first revision, not the initial draft",
      );
    await fault?.pause(
      `model-${stage}${["review", "revise"].includes(stage) ? "-" + logicalCall.round : ""}`,
      { requestId, stage, round: logicalCall.round },
    );
    if (res.destroyed) return;
    const respond = (message: unknown, finish = "stop") => {
      if (input.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: randomUUID(),
            choices: [{ index: 0, message, finish_reason: finish }],
          }),
        );
      }
    };
    const call = (name: string, args: unknown) =>
      respond(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      );
    if (stage === "select") {
      const step = selectionStep++;
      if (step === 0)
        return call("host_morphz", {
          action: "operations",
          operations: { action: "list", domain: "script" },
        });
      if (step === 1) {
        assert.ok(
          context.includes("script.prepare-workflow"),
          "Real catalog reached the model",
        );
        return call("host_morphz", {
          action: "operations",
          operations: {
            action: "describe",
            operationId: "script.prepare-workflow",
          },
        });
      }
      if (step === 2) return call("harness_list", {});
      assert.equal(step, 3, "Select once, without a second UI input");
      assert.ok(context.includes(harnessRef.version));
      return call("harness_select", {
        ...harnessRef,
        reason: "明确请求剧本候选，使用官方可执行工序",
      });
    }
    if (stage === "prepare") {
      const step = preparationStep++;
      const last = input.messages
        .filter((m: { role: string }) => m.role === "tool")
        .at(-1);
      const observation = last ? JSON.parse(last.content) : undefined;
      const result = observation?.result
        ? typeof observation.result === "string" &&
          observation.result.startsWith("{")
          ? JSON.parse(observation.result)
          : observation.result
        : observation;
      if (step === 0)
        return call("host_morphz", {
          action: "script",
          script: { action: "list", query: "TEST 合成剧本 Runtime 闭环" },
        });
      assert.equal(
        result?.ok,
        true,
        "Use the actual previous Host result: " +
          JSON.stringify({ observation, hostErrors }),
      );
      if (step === 1) {
        assert.equal(result.productions.length, 1);
        return call("host_morphz", {
          action: "script",
          script: {
            action: "read-production",
            productionId: result.productions[0].id,
          },
        });
      }
      if (step === 2) {
        const target = result.items.find(
          (i: { kind: string }) => i.kind === "episode",
        );
        assert.ok(target);
        return call("host_morphz", {
          action: "script",
          script: {
            action: "prepare-workflow",
            productionId: result.productionId,
            targetId: target.id,
            baseRevision: target.revision,
            contextRevision: result.contextRevision,
            purpose: "rewrite",
            maxReviewPasses: 1,
          },
        });
      }
      assert.equal(step, 3);
      assert.equal(result.prepared, true);
      return respond({
        role: "assistant",
        content: JSON.stringify("目标已准备，Yao继续。"),
      });
    }
    const value =
      stage === "intent" || stage === "discussion"
        ? {
            execute: !["defer", "discussion"].includes(scenario),
            reply: "先讨论，不保存候选。",
          }
        : stage === "create" || stage === "revise"
          ? {
              blocked:
                scenario === "malformed"
                  ? "not-a-bool"
                  : (stage === "create" && scenario === "initial-blocked") ||
                    (stage === "revise" &&
                      (scenario === "revision-blocked" ||
                        (scenario === "second-revision-blocked" &&
                          reviewCount === 2))),
              message: "合成材料存在无法在本次范围解决的冲突，停止提交。",
              payload:
                stage === "revise"
                  ? {
                      ...candidateDraft,
                      text:
                        candidateDraft.text +
                        "\n【修订1】保留第一轮修改。" +
                        (reviewCount === 2
                          ? "\n【修订2】补上第二轮修改。"
                          : ""),
                    }
                  : candidateDraft,
              explanation: "合成固定候选，不是真实模型质量验收。",
            }
          : stage === "review"
            ? {
                revise:
                  (["two-review-revise", "revision-blocked"].includes(
                    scenario,
                  ) &&
                    reviewCount === 1) ||
                  ["both-revisions", "second-revision-blocked"].includes(
                    scenario,
                  ),
                blocked:
                  scenario === "blocked" ||
                  (scenario === "second-review-blocked" && reviewCount === 2),
                notes: "合成检查：仅用于验证实际分支与因果数据流。",
              }
            : scenario === "discussion" || scenario === "defer"
              ? "先讨论，不保存候选。"
              : scenario.includes("blocked") || scenario === "malformed"
                ? "工序已停止，没有提交。"
                : "合成测试候选已提交，等待人工决定；未批准或锁稿。";
    const content = internal ? JSON.stringify(value) : String(value);
    const message = { role: "assistant", content };
    respond(message);
  } catch (error) {
    providerError = error instanceof Error ? error : new Error(String(error));
    res.writeHead(500);
    res.end("Synthetic script provider rejected request");
  }
});
const originalListen = Server.prototype.listen;
let passed = false;
const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (providerError) throw providerError;
    if (proxy?.error) throw proxy.error;
    if (await check()) return;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(`Runtime exited during ${label}`);
    await delay(120);
  }
  throw new Error(`${label} timed out`);
};
const redact = (text: string) => {
  let output = text.split(runtimeToken).join("[redacted]");
  for (const tool of manifest?.tools ?? [])
    output = output.split(tool.token).join("[redacted]");
  return output;
};
try {
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const providerPort = (provider.address() as { port: number }).port;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const runtimePort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  writeFileSync(
    join(workDirectory, "runtime.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${runtimePort}`,
      token: runtimeToken,
      namespace: randomUUID(),
    }),
    { mode: 0o600 },
  );
  const configFile = join(runtimeDirectory, "morphz.toml");
  writeFileSync(
    configFile,
    `[llm]\nmodel="test-model"\nreasoning_effort="low"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[models.test-model]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
    { mode: 0o600 },
  );
  // Only the test provider and Runtime API may use TCP. The actual embedded application must use Unix IPC.
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    assert.equal(
      typeof args[0],
      "string",
      "Embedded application must not open a TCP server",
    );
    return originalListen.apply(
      this,
      args as Parameters<typeof originalListen>,
    );
  } as typeof originalListen;
  process.env.MORPHZ_APP_ENV_FILE = "";
  host = await openEmbeddedApplication(
    workDirectory,
    join(directory, "profile"),
  );
  assert.ok(host.manifestPath);
  manifest = JSON.parse(readFileSync(host.manifestPath, "utf8"));
  assert.ok(manifest?.tools[0]?.ipc_path);
  assert.ok(!JSON.stringify(manifest).includes('"endpoint"'));
  let runtimeManifestPath = host.manifestPath;
  if (fault) {
    proxy = await scriptFaultProxy(manifest!.tools[0]!.ipc_path, fault);
    const proxyManifest = JSON.parse(readFileSync(host.manifestPath, "utf8"));
    for (const tool of proxyManifest.tools) tool.ipc_path = proxy.path;
    runtimeManifestPath = join(workDirectory, "fault-proxy-manifest.json");
    writeFileSync(runtimeManifestPath, JSON.stringify(proxyManifest), {
      mode: 0o600,
    });
  }
  const env = {
    PATH: process.env.PATH,
    HOME: homeDirectory,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    MORPHZ_HOME: runtimeDirectory,
    MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
    MORPHZ_DASHBOARD_TOKEN: runtimeToken,
    MORPHZ_HOST_TOOLS_FILE: runtimeManifestPath,
    MORPHZ_EXPERIMENTAL_FEATURES: "session-io",
    MORPHZ_EVAL_CALLABLE_TOOLS: "host_morphz",
    MORPHZ_APP_TEST_KEY: "synthetic-fixture-key",
  };
  const cli = (args: string[]) => {
    const result = spawnSync(
      binary,
      [
        ...args,
        "--cwd",
        runtimeDirectory,
        "--config-file",
        configFile,
        "--format",
        "json",
        "--log-level",
        "error",
      ],
      { env, encoding: "utf8", timeout: 25_000 },
    );
    assert.equal(
      result.status,
      0,
      redact(
        `Harness CLI failed: ${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`,
      ),
    );
    return result.stdout;
  };
  cli([
    "harness",
    "install",
    fileURLToPath(
      new URL("../harnesses/legacy/script-studio-1.0.0.hns", import.meta.url),
    ),
  ]);
  cli(["harness", "install", harnessFile]);
  cli([
    "harness",
    "install",
    fileURLToPath(
      new URL("../harnesses/legacy/script-studio-1.3.0.hns", import.meta.url),
    ),
  ]);
  cli([
    "harness",
    "install",
    fileURLToPath(
      new URL("../harnesses/legacy/script-studio-1.2.1.hns", import.meta.url),
    ),
  ]);
  cli([
    "harness",
    "install",
    fileURLToPath(
      new URL("../harnesses/legacy/script-studio-1.2.0.hns", import.meta.url),
    ),
  ]);
  cli([
    "harness",
    "install",
    fileURLToPath(
      new URL("../harnesses/legacy/script-studio-1.1.1.hns", import.meta.url),
    ),
  ]);
  cli([
    "harness",
    "install",
    fileURLToPath(
      new URL("../harnesses/legacy/script-studio-1.1.0.hns", import.meta.url),
    ),
  ]);
  const registered = cli(["harness", "list"]);
  assert.ok(
    registered.includes(harnessRef.id) &&
      registered.includes(harnessRef.version),
    "Package must be listed by a second process reading the persisted registry",
  );
  assert.ok(
    ["1.0.0", "1.1.0", "1.1.1", "1.2.0", "1.2.1", "1.3.0"].every((version) =>
      registered.includes(version),
    ),
    "Every legacy package remains available for immutable retries",
  );
  assert.equal(providerCalls, 0, "Installing a Harness must not call a model");
  const startRuntime = () => {
    const child = spawn(
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
      { env, stdio: "pipe" },
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-20_000);
      });
    return child;
  };
  runtime = startRuntime();
  await waitUntil(
    () => host!.connection.application.options.runtime!.snapshot().connected,
    "Runtime connection",
  );
  // Bind only this fresh Runtime's synthetic account through the operator API.
  // No production account, credential, or Runtime configuration is consulted.
  const accountUrl = `http://127.0.0.1:${runtimePort}/api/agents/default-agent/provider-accounts`;
  const operatorHeaders = { Authorization: `Bearer ${runtimeToken}` };
  const bound = await fetch(`${accountUrl}/stub`, {
    method: "PUT",
    headers: operatorHeaders,
  });
  assert.ok(
    bound.ok,
    `Synthetic account binding failed (${bound.status}): ${redact(await bound.text())}`,
  );
  const bindings = await fetch(accountUrl, { headers: operatorHeaders });
  assert.ok(bindings.ok, "Synthetic account binding must be readable");
  assert.ok(
    JSON.stringify(await bindings.json()).includes('"stub"'),
    "The fresh Agent must retain the exact synthetic account binding",
  );
  assert.equal(
    providerCalls,
    0,
    "Binding the synthetic account must not invoke a model",
  );
  const boot = (await host.connection.call("workspace")) as {
    csrfToken: string;
    centerId: string;
  };
  const execute = (operation: Operation) =>
    host!.connection.application.store.execute(
      { commandId: randomUUID(), operation },
      localAccess,
    ).entityId;
  const run = (command: ScriptCommand) =>
    execute({ type: "script-command", command });
  productionId = run({
    action: "create-production",
    projectId: "first-project",
    title: "TEST 合成剧本 Runtime 闭环",
  });
  const production = () =>
    host!.connection.application.store
      .snapshot()
      .scriptProductions.find((p) => p.id === productionId)!;
  let p = production();
  run({
    action: "update-production",
    productionId,
    expectedRevision: p.revision,
    title: p.title,
    brief: {
      ...p.brief,
      episodeCount: 1,
      modelProcessingAllowed: true,
      rightsStatement: "自动化合成资料，非客户原作；仅本机固定 Provider。",
    },
    reviewerPrincipalIds: p.reviewerPrincipalIds,
    template: p.template,
  });
  targetId = run({
    action: "create-item",
    productionId,
    kind: "episode",
    draft: sourceDraft,
  });
  const item = () => production().items.find((i) => i.id === targetId)!;
  // Exercise the real first-party manifest. A fixture fallback would conceal a
  // missing production binding, so refuse it even when the package installed.
  assert.deepEqual(scriptStudioApplication.harness, harnessRef);
  const app = scriptStudioApplication;
  const applicationInstanceId = execute({
    type: "launch-application",
    workspaceId: "first-project",
    applicationId: app.id,
    applicationVersion: app.version,
  });
  const generation: ScriptGeneration = {
    productionId,
    targetId,
    baseRevision: 1,
    contextRevision: production().revision,
    purpose: "rewrite",
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 5000,
    maxReviewPasses: fault ? 2 : 0,
  };
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "record-input" as const,
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "TEST 合成编剧工序：只生成第一集固定版本候选。不得当作真实创作质量验收。",
      targetActantId: "morphz-agent",
      applicationInstanceId,
      scriptGeneration:
        fault?.point === "model-discussion" ? undefined : generation,
    },
  };
  const receipt = (await host.connection.call("message", command, {
    identityGeneration: boot.csrfToken,
  })) as Receipt;
  if (fault) {
    await waitUntil(() => Boolean(fault.hit), `Reach ${fault.point}`);
    const checkpointDb = new DatabaseSync(
      join(runtimeDirectory, "runtime.sqlite"),
      { readOnly: true },
    );
    await backup(checkpointDb, join(directory, "before-crash.sqlite"));
    const checkpointJobs = checkpointDb
      .prepare(
        "SELECT id,status,retry_safety,claimed_by,lease_expires_at,side_effect_started_at,error FROM execution_jobs",
      )
      .all();
    checkpointDb.close();
    // Shared-store leases last longer than the ordinary 60-second test wait.
    // Observe beyond the actual persisted lease, without rewriting clocks or DB rows.
    const lastLeaseExpiry = Math.max(
      0,
      ...checkpointJobs
        .filter((job) => job.status === "running" && job.lease_expires_at)
        .map((job) => Date.parse(String(job.lease_expires_at)))
        .filter(Number.isFinite),
    );
    const recoveryTimeoutMs = Math.max(
      60_000,
      lastLeaseExpiry - Date.now() + 30_000,
    );
    const frozenInput = JSON.stringify(
      host.connection.application.store
        .snapshot()
        .inputs.find((i) => i.id === receipt.entityId),
    );
    const beforeKill = {
      point: fault.point,
      hit: fault.hit,
      pid: runtime.pid,
      modelCalls: [...logicalModelCalls.entries()],
      hostCalls: proxy!.calls,
      jobs: checkpointJobs,
      recoveryTimeoutMs,
      candidateCount: production().candidates.length,
    };
    writeFileSync(
      join(directory, "before-crash.json"),
      JSON.stringify(beforeKill, null, 2),
      { mode: 0o600 },
    );
    if (fault.point === "host-submit-after")
      assert.equal(
        production().candidates.length,
        1,
        "Lost receipt cut must follow a real commit",
      );
    const killed = runtime;
    const exited = new Promise<void>((resolve) =>
      killed.once("exit", () => resolve()),
    );
    assert.ok(
      killed.kill("SIGKILL"),
      "Only the isolated child spawned by this fixture may be killed",
    );
    await exited;
    assert.equal(killed.signalCode, "SIGKILL");
    fault.release();
    runtime = startRuntime();
    assert.notEqual(runtime.pid, killed.pid);
    await waitUntil(async () => {
      try {
        const r = await fetch(
          `http://127.0.0.1:${runtimePort}/api/session-io/capabilities`,
          { headers: operatorHeaders, signal: AbortSignal.timeout(800) },
        );
        if (!r.ok) return false;
        const c = (await r.json()) as {
          harnesses: { id: string; version: string }[];
        };
        return c.harnesses.some(
          (h) => h.id === harnessRef.id && h.version === harnessRef.version,
        );
      } catch {
        return false;
      }
    }, "Restart same isolated Runtime");
    await waitUntil(
      () => {
        const d = host!.connection.application.options
          .runtime!.snapshot()
          .deliveries.find((d) => d.inputId === receipt.entityId);
        if (d?.state === "failed")
          throw new Error(d.error ?? "Recovered input failed");
        return d?.state === "completed";
      },
      `Recover ${fault.point}`,
      recoveryTimeoutMs,
    );
    assert.equal(
      JSON.stringify(
        host.connection.application.store
          .snapshot()
          .inputs.find((i) => i.id === receipt.entityId),
      ),
      frozenInput,
    );
    const expected =
      fault.point === "model-discussion"
        ? ["discussion", "relay"]
        : [
            "intent",
            "create",
            "review",
            "revise",
            "review",
            "revise",
            "delivery",
            "relay",
          ];
    assert.deepEqual(
      [...logicalModelCalls.values()].map((c) => c.stage),
      expected,
    );
    const interrupted = (fault.hit!.metadata as { requestId?: string })
      .requestId;
    for (const [id, call] of logicalModelCalls)
      assert.equal(
        call.attempts,
        id === interrupted ? 2 : 1,
        "Only the interrupted, uncommitted model call may repeat",
      );
    assert.deepEqual(
      hostErrors,
      [],
      "Recovery must not transiently bypass/fail Host authority",
    );
    const hostByJob = new Map<string, NonNullable<typeof proxy>["calls"]>();
    for (const call of proxy!.calls) {
      const calls = hostByJob.get(call.jobId) ?? [];
      calls.push(call);
      hostByJob.set(call.jobId, calls);
    }
    assert.equal(hostByJob.size, fault.point === "model-discussion" ? 1 : 6);
    const interruptedHost = (fault.hit!.metadata as { jobId?: string }).jobId;
    for (const [jobId, calls] of hostByJob) {
      assert.equal(
        calls.length,
        jobId === interruptedHost ? 2 : 1,
        "Only the interrupted original Host Job may repeat",
      );
      assert.equal(new Set(calls.map((c) => c.toolCallId)).size, 1);
      assert.equal(calls.at(-1)!.completed, true);
      if (fault.point === "host-submit-after" && jobId === interruptedHost)
        assert.deepEqual(
          calls[1]!.response,
          calls[0]!.response,
          "A committed submission must replay its exact durable receipt",
        );
    }
    const completed = production();
    assert.equal(
      completed.candidates.length,
      fault.point === "model-discussion" ? 0 : 1,
    );
    assert.equal(currentScriptDraft(item()).text, sourceDraft.text);
    assert.equal(item().status, "draft");
    if (completed.candidates[0]) {
      assert.equal(completed.candidates[0].status, "pending");
      assert.equal(
        completed.candidates[0].draft.text,
        candidateDraft.text +
          "\n【修订1】保留第一轮修改。\n【修订2】补上第二轮修改。",
      );
    }
    const db = new DatabaseSync(join(runtimeDirectory, "runtime.sqlite"), {
      readOnly: true,
    });
    const persisted = db
      .prepare(
        "SELECT id,harness_id,harness_version,status,error FROM plan_executions",
      )
      .all();
    assert.equal(
      persisted.length,
      1,
      "Restart resumes the original Plan, not a fresh entry",
    );
    assert.equal(persisted[0]!.status, "succeeded");
    assert.equal(
      db.prepare("SELECT count(*) n FROM threads WHERE status='open'").get()!.n,
      0,
    );
    await backup(db, join(directory, "after-recovery.sqlite"));
    db.close();
    const evidence = {
      status: "assertions-passed",
      point: fault.point,
      evidenceDirectory: directory,
      harness: harnessRef,
      oldPid: killed.pid,
      newPid: runtime.pid,
      inputId: receipt.entityId,
      modelCalls: [...logicalModelCalls.entries()],
      hostCalls: proxy!.calls,
      plans: persisted,
      candidateCount: completed.candidates.length,
      formalDraftUnchanged: true,
    };
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(evidence, null, 2));
    passed = true;
  } else {
    await waitUntil(() => {
      const delivery = host!.connection.application.options
        .runtime!.snapshot()
        .deliveries.find((d) => d.inputId === receipt.entityId);
      if (delivery?.state === "failed")
        throw new Error(delivery.error ?? "Script delivery failed");
      return delivery?.state === "completed";
    }, "Pinned script candidate delivery");
    assert.deepEqual(
      stages.filter((stage) => stage !== "relay"),
      ["intent", "create", "delivery"],
    );
    const persistedInput = host.connection.application.store
      .snapshot()
      .inputs.find((i) => i.id === receipt.entityId)!;
    assert.deepEqual(persistedInput.application?.harness, harnessRef);
    assert.deepEqual(persistedInput.scriptGeneration, generation);
    p = production();
    assert.equal(
      p.candidates.length,
      1,
      "Exactly one candidate must have been physically persisted",
    );
    const candidate = p.candidates[0]!;
    assert.equal(candidate.inputId, receipt.entityId);
    assert.equal(candidate.targetId, targetId);
    assert.equal(candidate.createdBy.actantId, "morphz-agent");
    assert.equal(candidate.baseRevision, 1);
    assert.equal(candidate.status, "pending");
    assert.equal(
      currentScriptDraft(item()).text,
      sourceDraft.text,
      "Agent must not alter the formal draft",
    );
    assert.equal(item().status, "draft");
    branchEvidence.push({ scenario, stages: [...stages], candidateCount: 1 });
    for (const testCase of [
      {
        name: "discussion",
        passes: null,
        expected: ["discussion", "relay"],
        writes: 0,
      },
      {
        name: "chat",
        passes: null,
        expected: [
          "select",
          "select",
          "select",
          "select",
          "discussion",
          "prepare",
          "prepare",
          "prepare",
          "prepare",
          "create",
          "review",
          "delivery",
          "relay",
        ],
        writes: 1,
      },
      { name: "defer", passes: 2, expected: ["intent", "relay"], writes: 0 },
      {
        name: "one-review",
        passes: 1,
        expected: ["intent", "create", "review", "delivery", "relay"],
        writes: 1,
      },
      {
        name: "two-review-revise",
        passes: 2,
        expected: [
          "intent",
          "create",
          "review",
          "revise",
          "review",
          "delivery",
          "relay",
        ],
        writes: 1,
      },
      {
        name: "blocked",
        passes: 2,
        expected: ["intent", "create", "review", "relay"],
        writes: 0,
      },
      {
        name: "malformed",
        passes: 1,
        expected: ["intent", "create", "relay"],
        writes: 0,
      },
      {
        name: "initial-blocked",
        passes: 2,
        expected: ["intent", "create", "relay"],
        writes: 0,
      },
      {
        name: "revision-blocked",
        passes: 2,
        expected: ["intent", "create", "review", "revise", "relay"],
        writes: 0,
      },
      {
        name: "second-review-blocked",
        passes: 2,
        expected: ["intent", "create", "review", "review", "relay"],
        writes: 0,
      },
      {
        name: "second-revision-blocked",
        passes: 2,
        expected: [
          "intent",
          "create",
          "review",
          "revise",
          "review",
          "revise",
          "relay",
        ],
        writes: 0,
      },
      {
        name: "both-revisions",
        passes: 2,
        expected: [
          "intent",
          "create",
          "review",
          "revise",
          "review",
          "revise",
          "delivery",
          "relay",
        ],
        writes: 1,
      },
    ]) {
      scenario = testCase.name;
      reviewCount = 0;
      selectionStep = 0;
      preparationStep = 0;
      const before = production().candidates.length;
      const start = stages.length;
      const branchReceipt = (await host.connection.call(
        "message",
        {
          commandId: randomUUID(),
          operation: {
            ...command.operation,
            applicationInstanceId:
              scenario === "chat" ? undefined : applicationInstanceId,
            body:
              scenario === "discussion" || scenario === "defer"
                ? "只聊聊候车人的动机，先别生成。"
                : `TEST 合成 ${scenario} 分支。`,
            scriptGeneration:
              testCase.passes === null
                ? undefined
                : {
                    ...generation,
                    contextRevision: production().revision,
                    maxReviewPasses: testCase.passes,
                  },
          },
        },
        { identityGeneration: boot.csrfToken },
      )) as Receipt;
      await waitUntil(() => {
        const d = host!.connection.application.options
          .runtime!.snapshot()
          .deliveries.find((d) => d.inputId === branchReceipt.entityId);
        if (d?.state === "failed")
          throw new Error(d.error ?? `${scenario} failed`);
        return d?.state === "completed";
      }, scenario);
      const actual = stages.slice(start);
      assert.deepEqual(actual, testCase.expected, scenario);
      assert.equal(
        production().candidates.length - before,
        testCase.writes,
        scenario,
      );
      assert.equal(currentScriptDraft(item()).text, sourceDraft.text, scenario);
      if (scenario === "chat") {
        const snapshot = host.connection.application.store.snapshot();
        const source = snapshot.inputs.find(
          (i) => i.id === branchReceipt.entityId,
        )!;
        assert.equal(source.application, undefined);
        assert.equal(source.scriptGeneration, undefined);
        assert.equal(
          snapshot.scriptPreparations.filter((p) => p.inputId === source.id)
            .length,
          1,
        );
        assert.equal(
          host.connection.application.store
            .scriptOutputs(localAccess)
            .filter((o) => o.inputId === source.id && o.kind === "candidate")
            .length,
          1,
        );
      }
      if (scenario === "both-revisions")
        assert.equal(
          production().candidates.at(-1)!.draft.text,
          candidateDraft.text +
            "\n【修订1】保留第一轮修改。\n【修订2】补上第二轮修改。",
          "Both revisions must reach the single persisted candidate",
        );
      branchEvidence.push({
        scenario,
        stages: actual,
        candidateCount: production().candidates.length - before,
      });
    }
    const runtimeDb = new DatabaseSync(
      join(runtimeDirectory, "runtime.sqlite"),
      {
        readOnly: true,
      },
    );
    const plans = runtimeDb
      .prepare(
        "SELECT id,harness_id,harness_version,status,error FROM plan_executions ORDER BY created_at",
      )
      .all();
    runtimeDb.close();
    assert.equal(
      plans.length,
      13,
      "One durable root Plan per request, never redispatched on failure",
    );
    assert.ok(
      plans.every(
        (p) =>
          p.harness_id === harnessRef.id &&
          p.harness_version === harnessRef.version,
      ),
    );
    assert.equal(plans.filter((p) => p.status === "succeeded").length, 12);
    assert.equal(
      plans.filter((p) => p.status === "failed").length,
      1,
      "Malformed Bool fails before submit",
    );
    const completedCalls = providerCalls;
    const totalCandidates = production().candidates.length;
    run({
      action: "decide-candidate",
      productionId,
      candidateId: candidate.id,
      expectedRevision: candidate.revision,
      decision: "accept",
    });
    assert.equal(item().revision, 2);
    assert.equal(currentScriptDraft(item()).text, candidateDraft.text);
    const workflow = () => ({
      productionId,
      itemId: targetId,
      expectedRevision: item().revision,
      expectedWorkflowRevision: item().workflowRevision,
    });
    run({ action: "submit-review", ...workflow() });
    run({
      action: "review-decision",
      ...workflow(),
      decision: "approve",
      note: "合成人工审批夹具；不是合作方审批",
    });
    run({ action: "lock-item", ...workflow() });
    assert.equal(item().status, "locked");
    assert.throws(
      () =>
        run({
          action: "revise-item",
          productionId,
          itemId: targetId,
          expectedRevision: item().revision,
          draft: sourceDraft,
        }),
      /锁/,
    );
    p = production();
    const exportId = run({
      action: "record-export",
      productionId,
      expectedRevision: p.revision,
      items: [{ itemId: targetId, revision: 2 }],
      template: p.template,
    });
    const docx = buildScriptDocx(production(), exportId);
    assert.equal(
      new DataView(docx.buffer, docx.byteOffset, docx.byteLength).getUint32(
        0,
        true,
      ),
      0x04034b50,
    );
    assert.ok(
      new TextDecoder().decode(docx).includes("一张写着明日日期的车票"),
    );
    const centerId = host.connection.application.store.identity();
    const stateBeforeReopen = production();
    await host.close();
    host = await openEmbeddedApplication(
      workDirectory,
      join(directory, "profile"),
    );
    assert.equal(host.connection.application.store.identity(), centerId);
    assert.deepEqual(production(), stateBeforeReopen);
    assert.deepEqual(buildScriptDocx(production(), exportId), docx);
    const reopened = (await host.connection.call("workspace")) as {
      csrfToken: string;
    };
    assert.deepEqual(
      await host.connection.call("message", command, {
        identityGeneration: reopened.csrfToken,
      }),
      receipt,
    );
    await delay(2000); // Finite assertion window inside the fixture, not Agent task polling.
    assert.equal(
      providerCalls,
      completedCalls,
      "Reopen/retry must not replay the model or duplicate the candidate",
    );
    assert.equal(production().candidates.length, totalCandidates);
    assert.equal(production().exports.length, 1);
    const evidence = {
      harness: harnessRef,
      applicationId: app.id,
      productionBuiltinBound: true,
      provider: "synthetic-fixed-responses",
      providerCalls,
      branches: branchEvidence,
      plans,
      centerId,
      productionId,
      targetId,
      inputId: receipt.entityId,
      candidateId: candidate.id,
      exportId,
      docxBytes: docx.byteLength,
      docxSha256: createHash("sha256").update(docx).digest("hex"),
      assertions: [
        "ordinary chat discovers operations, selects exact Harness and prepares its own versioned target",
        "persisted Harness install/list/reopen",
        "actual mounted contract and tool allowlist",
        "discussion and deferred intent never write",
        "0/1/2 actual Yao review branches and conditional revision",
        "blocked/malformed outputs stop before submit without redispatch",
        "pinned Session IO input",
        "real Runtime physical Host operations via Unix IPC",
        "candidate provenance/no formal overwrite",
        "Human adoption/review/lock/export",
        "real OOXML bytes",
        "application reopen and no model replay",
      ],
      unverified: [
        "production Runtime installation",
        "current Desktop window",
        "real model writing quality",
        "Microsoft Word rendering",
        "partner acceptance",
      ],
    };
    writeFileSync(join(directory, "synthetic-script.docx"), docx, {
      mode: 0o600,
    });
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    );
    passed = true;
    console.log(
      JSON.stringify(
        {
          status: "assertions-passed",
          evidenceDirectory: directory,
          ...evidence,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  if (fault && existsSync(join(runtimeDirectory, "runtime.sqlite"))) {
    const db = new DatabaseSync(join(runtimeDirectory, "runtime.sqlite"), {
      readOnly: true,
    });
    await backup(db, join(directory, "failure.sqlite"));
    const plans = db
      .prepare(
        "SELECT id,status,pending_kind,pending_id,error FROM plan_executions",
      )
      .all();
    const jobs = db
      .prepare(
        "SELECT id,status,retry_safety,claimed_by,lease_expires_at,side_effect_started_at,result_event_id,error FROM execution_jobs",
      )
      .all();
    const threads = db.prepare("SELECT id,status FROM threads").all();
    db.close();
    const workspace = host?.connection.application.store.snapshot();
    const failedProduction = workspace?.scriptProductions.find(
      (p) => p.id === productionId,
    );
    const failedItem = failedProduction?.items.find((i) => i.id === targetId);
    writeFileSync(
      join(directory, "failure.json"),
      JSON.stringify(
        {
          point: fault.point,
          observedAt: new Date().toISOString(),
          error: String(error),
          plans,
          jobs,
          threads,
          inputCount: workspace?.inputs.length,
          candidateCount: failedProduction?.candidates.length,
          candidateStatuses: failedProduction?.candidates.map((c) => c.status),
          formalDraftUnchanged: failedItem
            ? currentScriptDraft(failedItem).text === sourceDraft.text
            : null,
          modelCalls: [...logicalModelCalls.entries()],
          hostCalls: proxy?.calls,
          hostErrors,
          deliveries:
            host?.connection.application.options.runtime?.snapshot().deliveries,
          hit: fault.hit,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  writeFileSync(join(directory, "runtime.log"), redact(logs), { mode: 0o600 });
  console.error(redact(logs));
  console.error("Isolated failure evidence retained:", directory);
  throw error;
} finally {
  AgentTools.prototype.call = originalToolCall;
  // Attempt every cleanup even if one fails. Success requires process and socket teardown too.
  const failures: unknown[] = [];
  try {
    await proxy?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await host?.close();
  } catch (error) {
    failures.push(error);
  }
  if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      runtime!.once("exit", () => resolve()),
    );
    runtime.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Isolated Runtime did not stop")),
            10_000,
          );
        }),
      ]);
    } catch (error) {
      failures.push(error);
      runtime.kill("SIGKILL"); // Only this script's freshly spawned, isolated child; never a user process.
      await exited;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  provider.closeAllConnections();
  if (provider.listening)
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  Server.prototype.listen = originalListen;
  if (manifest?.tools[0]?.ipc_path)
    rmSync(dirname(manifest.tools[0].ipc_path), {
      recursive: true,
      force: true,
    });
  if (failures.length)
    throw new AggregateError(
      failures,
      "Isolated smoke teardown failed; assertions alone are not success",
    );
  if (passed)
    console.log(
      "PASS: script Harness/Runtime/embedded Host/SQLite workflow and teardown. Synthetic provider only; evidence retained in the named isolated directory.",
    );
}
