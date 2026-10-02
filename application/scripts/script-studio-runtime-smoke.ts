import { scriptDocxManifest } from "../tests/script-docx-fixture.js";
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
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { localAccess, type Receipt } from "../packages/core/src/model.js";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import {
  currentScriptDraft,
  emptyScriptDraft,
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
  contentId = "",
  targetId = "";
let client: PlatformClient;
const production = () => client.readScriptSnapshot(contentId);
const item = async () =>
  (await production()).items.find((i) => i.id === targetId)!;
const persistedDeliveries = () => {
  const state = host!.connection.application.store.runtimeState() as {
    deliveries: Array<{
      inputId: string;
      state: string;
      error: string | null;
      platformSource?: unknown;
    }>;
  };
  return state.deliveries;
};
const pinnedInput = (inputId: string) => {
  const input = persistedDeliveries().find(
    (d) => d.inputId === inputId,
  )?.platformSource;
  assert.ok(input, "The original immutable Platform input must be persisted");
  return input as {
    application?: { harness?: unknown };
    scriptGeneration?: ScriptGeneration;
  };
};
const assertNoLegacyWorkspace = () => {
  const db = new DatabaseSync(join(workDirectory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets','artifact_outputs','script_outputs')",
        )
        .all(),
      [],
      "The real Host must not recreate any legacy business authority",
    );
  } finally {
    db.close();
  }
};
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
let createdChatProjectId = "",
  createdChatProductionId = "",
  createdChatContentId = "",
  createdChatItemId = "",
  createdChatActivityRevision = 0;
const logicalModelCalls = new Map<
  string,
  { stage: string; round: number; attempts: number }
>();
const branchEvidence: {
  scenario: string;
  stages: string[];
  candidateCount: number;
  created?: { productionId: string; contentId: string; itemId: string };
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
      : scenario.startsWith("chat") && tools.includes("harness_select")
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
            (stage === "relay" && name === "reply") ||
            (stage === "prepare" && name === "host_morphz"),
        ),
        `Only preparation may use Host tools; creative steps cannot bypass the Plan (stage=${stage}, tools=${tools.join(",")})`,
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
      if (scenario === "chat-create") {
        if (step === 0)
          return call("host_morphz", {
            action: "script",
            script: { action: "read-workflow" },
          });
        assert.equal(
          result?.ok,
          true,
          JSON.stringify({ observation, hostErrors }),
        );
        if (step === 1) {
          assert.equal(result.generating, false);
          assert.equal(result.projectId, "first-project");
          assert.ok(result.body.includes("新建"));
          createdChatProjectId = result.projectId;
          return call("host_morphz", {
            action: "operations",
            operations: {
              action: "describe",
              operationId: "script.create-production",
            },
          });
        }
        if (step === 2) {
          assert.equal(result.operation.harness, undefined);
          assert.ok(result.operation.parameters);
          return call("host_morphz", {
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "script.create-production",
              parameters: {
                projectId: createdChatProjectId,
                title: "TEST 空书库聊天创建",
              },
            },
          });
        }
        if (step === 3) {
          createdChatProductionId = result.productionId;
          createdChatContentId = result.contentId;
          assert.equal(result.receipt.entityId, createdChatProductionId);
          return call("host_morphz", {
            action: "script",
            script: {
              action: "read-production",
              productionId: createdChatProductionId,
            },
          });
        }
        if (step === 4) {
          assert.equal(result.items.length, 0);
          createdChatActivityRevision = result.activityRevision;
          return call("host_morphz", {
            action: "operations",
            operations: {
              action: "describe",
              operationId: "script.create-item",
            },
          });
        }
        if (step === 5) {
          assert.equal(result.operation.harness, undefined);
          return call("host_morphz", {
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "script.create-item",
              parameters: {
                productionId: createdChatProductionId,
                expectedActivityRevision: createdChatActivityRevision,
                kind: "episode",
                draft: emptyScriptDraft("第一集"),
              },
            },
          });
        }
        if (step === 6) {
          createdChatItemId = result.itemId;
          assert.equal(result.receipt.entityId, createdChatItemId);
          return call("host_morphz", {
            action: "script",
            script: {
              action: "read-production",
              productionId: createdChatProductionId,
            },
          });
        }
        assert.equal(step, 7);
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].id, createdChatItemId);
        return respond({
          role: "assistant",
          content: JSON.stringify("TEST 剧本和空的第一集已保存；不生成正文。"),
        });
      }
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
        assert.equal(result.items.length, 1);
        return call("host_morphz", {
          action: "script",
          script: {
            action: "read-production",
            productionId: result.items[0].id,
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
            task: ["defer", "discussion"].includes(scenario)
              ? ""
              : "TEST 合成当前任务范围，不是真实语义验收。",
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
            : scenario === "chat-create"
              ? "TEST 剧本和空的第一集已创建，不生成正文。"
              : scenario === "discussion" || scenario === "defer"
                ? "先讨论，不保存候选。"
                : scenario.includes("blocked") || scenario === "malformed"
                  ? "工序已停止，没有提交。"
                  : "合成测试候选已提交，等待人工决定；未批准或锁稿。";
    const content = internal ? JSON.stringify(value) : String(value);
    // The Application's outer reply uses the real v2 terminal carrier. Typed
    // creative infers still return their declared value, never a Host call.
    if (stage === "relay" && tools.includes("reply"))
      return call("reply", {
        content,
        annotations: {
          execution: {
            title: "验证剧本 Runtime 工序",
            result: content,
          },
        },
      });
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
    // This local synthetic Provider models fourteen Harness branches, not
    // Context-maintenance. Bound the aggregate fixture Context explicitly;
    // live-provider validation retains its real capacity and request limits.
    `[llm]\nmodel="test-model"\nreasoning_effort="low"\n[orchestrator]\ncontext_soft_token_limit=1500000\ncontext_hard_token_limit=2000000\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[models.test-model]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
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
    () =>
      host!.connection.application.options.runtime!.platformStatus().connected,
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
  client = await PlatformClient.connect(host.connection);
  await client.createProject(
    "TEST 合成剧本工序",
    randomUUID(),
    "first-project",
  );
  productionId = randomUUID();
  const created = (await client.createScript({
    commandId: randomUUID(),
    productionId,
    projectId: "first-project",
    title: "TEST 合成剧本 Runtime 闭环",
  })) as { contentId: string };
  contentId = created.contentId;
  let p = await production();
  await client.updateScript({
    commandId: randomUUID(),
    contentId,
    expectedRevision: (await client.readScript(contentId)).metadataRevision,
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
  targetId = randomUUID();
  await client.createScriptItem({
    commandId: randomUUID(),
    contentId,
    itemId: targetId,
    expectedActivityRevision: (await client.readScript(contentId))
      .activityRevision,
    kind: "episode",
    draft: sourceDraft,
  });
  // Exercise the real first-party manifest. A fixture fallback would conceal a
  // missing production binding, so refuse it even when the package installed.
  assert.deepEqual(scriptStudioApplication.harness, harnessRef);
  const app = scriptStudioApplication;
  const applicationInstanceId = (
    await client.launchAppView({
      commandId: randomUUID(),
      projectId: "first-project",
      appId: app.id,
      packageVersion: app.version,
      state: {},
    })
  ).id;
  const generation: ScriptGeneration = {
    productionId,
    targetId,
    baseRevision: 1,
    contextRevision: (await production()).revision,
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
      application: { id: app.id, version: app.version },
      scriptGeneration:
        fault?.point === "model-discussion" ? undefined : generation,
    },
  };
  const receipt = (await host.connection.call("platform.message", command, {
    identityGeneration: client.boot.csrfToken,
  })) as Receipt;
  assertNoLegacyWorkspace();
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
    const frozenInput = JSON.stringify(pinnedInput(receipt.entityId));
    const beforeKill = {
      point: fault.point,
      hit: fault.hit,
      pid: runtime.pid,
      modelCalls: [...logicalModelCalls.entries()],
      hostCalls: proxy!.calls,
      jobs: checkpointJobs,
      recoveryTimeoutMs,
      candidateCount: (await production()).candidates.length,
    };
    writeFileSync(
      join(directory, "before-crash.json"),
      JSON.stringify(beforeKill, null, 2),
      { mode: 0o600 },
    );
    if (fault.point === "host-submit-after")
      assert.equal(
        (await production()).candidates.length,
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
        const d = persistedDeliveries().find(
          (d) => d.inputId === receipt.entityId,
        );
        if (d?.state === "failed")
          throw new Error(d.error ?? "Recovered input failed");
        return d?.state === "completed";
      },
      `Recover ${fault.point}`,
      recoveryTimeoutMs,
    );
    assert.equal(JSON.stringify(pinnedInput(receipt.entityId)), frozenInput);
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
    const completed = await production();
    assert.equal(
      completed.candidates.length,
      fault.point === "model-discussion" ? 0 : 1,
    );
    assert.equal(currentScriptDraft(await item()).text, sourceDraft.text);
    assert.equal((await item()).status, "draft");
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
      const delivery = persistedDeliveries().find(
        (d) => d.inputId === receipt.entityId,
      );
      if (delivery?.state === "failed")
        throw new Error(delivery.error ?? "Script delivery failed");
      return delivery?.state === "completed";
    }, "Pinned script candidate delivery");
    assert.deepEqual(
      stages.filter((stage) => stage !== "relay"),
      ["intent", "create", "delivery"],
    );
    const persistedInput = pinnedInput(receipt.entityId);
    assert.deepEqual(persistedInput.application?.harness, harnessRef);
    assert.deepEqual(persistedInput.scriptGeneration, generation);
    p = await production();
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
      currentScriptDraft(await item()).text,
      sourceDraft.text,
      "Agent must not alter the formal draft",
    );
    assert.equal((await item()).status, "draft");
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
      {
        name: "chat-create",
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
          "prepare",
          "prepare",
          "prepare",
          "prepare",
          "relay",
        ],
        writes: 0,
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
      const before = (await production()).candidates.length;
      const start = stages.length;
      // Branches are independent tests, not one growing creative conversation.
      // Give each its real Session so earlier fixture replies do not force
      // Context-maintenance requests that this stage Provider does not model.
      const branchConversationId = randomUUID();
      const branchReceipt = (await host.connection.call(
        "platform.message",
        {
          commandId: randomUUID(),
          operation: {
            ...command.operation,
            conversationId: branchConversationId,
            newConversation: { title: `TEST script ${scenario}` },
            applicationInstanceId: scenario.startsWith("chat")
              ? undefined
              : applicationInstanceId,
            application: scenario.startsWith("chat")
              ? undefined
              : { id: app.id, version: app.version },
            body:
              scenario === "chat-create"
                ? "新建 TEST 空书库聊天创建剧本和空的第一集，不生成正文。"
                : scenario === "discussion" || scenario === "defer"
                  ? "只聊聊候车人的动机，先别生成。"
                  : `TEST 合成 ${scenario} 分支。`,
            scriptGeneration:
              testCase.passes === null
                ? undefined
                : {
                    ...generation,
                    contextRevision: (await production()).revision,
                    maxReviewPasses: testCase.passes,
                  },
          },
        },
        { identityGeneration: client.boot.csrfToken },
      )) as Receipt;
      await waitUntil(() => {
        const d = persistedDeliveries().find(
          (d) => d.inputId === branchReceipt.entityId,
        );
        if (d?.state === "failed")
          throw new Error(d.error ?? `${scenario} failed`);
        return d?.state === "completed";
      }, scenario);
      const actual = stages.slice(start);
      assert.deepEqual(actual, testCase.expected, scenario);
      assert.equal(
        (await production()).candidates.length - before,
        testCase.writes,
        scenario,
      );
      assert.equal(
        currentScriptDraft(await item()).text,
        sourceDraft.text,
        scenario,
      );
      if (scenario === "chat") {
        const source = pinnedInput(branchReceipt.entityId);
        assert.equal(source.application, undefined);
        assert.equal(source.scriptGeneration, undefined);
        const domain = host.connection.application.options.platformScripts!;
        const preparation = await domain.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            domain.studio.readPreparation({
              credential: actor.credential,
              productionId,
              inputId: branchReceipt.entityId,
            }),
        );
        assert.equal(preparation?.inputId, branchReceipt.entityId);
        assert.equal(preparation?.generation.targetId, targetId);
        const history = await client.history(
          "first-project",
          branchConversationId,
        );
        assert.equal(
          history.scriptOutputs.filter(
            (o) =>
              o.inputId === branchReceipt.entityId && o.kind === "candidate",
          ).length,
          1,
        );
      }
      if (scenario === "chat-create") {
        const source = pinnedInput(branchReceipt.entityId);
        assert.equal(source.application, undefined);
        assert.equal(source.scriptGeneration, undefined);
        const created = await client.readScriptSnapshot(createdChatContentId);
        assert.equal(created.id, createdChatProductionId);
        assert.equal(created.title, "TEST 空书库聊天创建");
        assert.equal(created.items.length, 1);
        assert.equal(created.items[0]!.id, createdChatItemId);
        assert.equal(currentScriptDraft(created.items[0]!).text, "");
        assert.equal(created.candidates.length, 0);
        assert.equal(created.brief.modelProcessingAllowed, false);
        const domain = host.connection.application.options.platformScripts!;
        const preparation = await domain.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            domain.studio.readPreparation({
              credential: actor.credential,
              productionId: createdChatProductionId,
              inputId: branchReceipt.entityId,
            }),
        );
        assert.equal(preparation, null);
      }
      if (scenario === "both-revisions")
        assert.equal(
          (await production()).candidates.at(-1)!.draft.text,
          candidateDraft.text +
            "\n【修订1】保留第一轮修改。\n【修订2】补上第二轮修改。",
          "Both revisions must reach the single persisted candidate",
        );
      branchEvidence.push({
        scenario,
        stages: actual,
        candidateCount: (await production()).candidates.length - before,
        ...(scenario === "chat-create"
          ? {
              created: {
                productionId: createdChatProductionId,
                contentId: createdChatContentId,
                itemId: createdChatItemId,
              },
            }
          : {}),
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
      14,
      "One durable root Plan per request, never redispatched on failure",
    );
    assert.ok(
      plans.every(
        (p) =>
          p.harness_id === harnessRef.id &&
          p.harness_version === harnessRef.version,
      ),
    );
    assert.equal(plans.filter((p) => p.status === "succeeded").length, 13);
    assert.equal(
      plans.filter((p) => p.status === "failed").length,
      1,
      "Malformed Bool fails before submit",
    );
    const completedCalls = providerCalls;
    const totalCandidates = (await production()).candidates.length;
    await client.decideScriptCandidate({
      commandId: randomUUID(),
      contentId,
      candidateId: candidate.id,
      expectedRevision: candidate.revision,
      decision: "accept",
    });
    assert.equal((await item()).revision, 2);
    assert.equal(currentScriptDraft(await item()).text, candidateDraft.text);
    const workflow = async () => {
      const original = await item();
      return {
        commandId: randomUUID(),
        contentId,
        itemId: targetId,
        expectedRevision: original.revision,
        expectedWorkflowRevision: original.workflowRevision,
      };
    };
    await client.transitionScriptWorkflow({
      action: "submit-review",
      ...(await workflow()),
    });
    await client.transitionScriptWorkflow({
      action: "review-decision",
      ...(await workflow()),
      decision: "approve",
      note: "合成人工审批夹具；不是合作方审批",
    });
    await client.transitionScriptWorkflow({
      action: "lock-item",
      ...(await workflow()),
    });
    assert.equal((await item()).status, "locked");
    await assert.rejects(
      () =>
        client.reviseScriptItem({
          commandId: randomUUID(),
          contentId,
          itemId: targetId,
          expectedRevision: 2,
          draft: sourceDraft,
        }),
      /锁/,
    );
    p = await production();
    const exported = await client.recordScriptExport({
      commandId: randomUUID(),
      contentId,
      expectedRevision: (await client.readScript(contentId)).metadataRevision,
      items: [{ itemId: targetId, revision: 2 }],
      template: p.template,
    });
    const exportId = (exported as { exportId: string }).exportId;
    const docx = buildScriptDocx(
      scriptDocxManifest(await production(), exportId),
    );
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
    const stateBeforeReopen = await production();
    await host.close();
    host = await openEmbeddedApplication(
      workDirectory,
      join(directory, "profile"),
    );
    client = await PlatformClient.connect(host.connection);
    assert.equal(host.connection.application.store.identity(), centerId);
    assertNoLegacyWorkspace();
    assert.deepEqual(await production(), stateBeforeReopen);
    assert.deepEqual(
      buildScriptDocx(scriptDocxManifest(await production(), exportId)),
      docx,
    );
    assert.deepEqual(
      await host.connection.call("platform.message", command, {
        identityGeneration: client.boot.csrfToken,
      }),
      receipt,
    );
    await delay(2000); // Finite assertion window inside the fixture, not Agent task polling.
    assert.equal(
      providerCalls,
      completedCalls,
      "Reopen/retry must not replay the model or duplicate the candidate",
    );
    assert.equal((await production()).candidates.length, totalCandidates);
    assert.equal((await production()).exports.length, 1);
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
      contentId,
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
    const history = client
      ? await client
          .history("first-project", "first-project")
          .catch(() => undefined)
      : undefined;
    const failedProduction =
      contentId && client
        ? await production().catch(() => undefined)
        : undefined;
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
          inputCount: history?.inputs.length,
          candidateCount: failedProduction?.candidates.length,
          candidateStatuses: failedProduction?.candidates.map((c) => c.status),
          formalDraftUnchanged: failedItem
            ? currentScriptDraft(failedItem).text === sourceDraft.text
            : null,
          modelCalls: [...logicalModelCalls.entries()],
          hostCalls: proxy?.calls,
          hostErrors,
          deliveries: host ? persistedDeliveries() : undefined,
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
