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
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
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
const harnessRef = { id: "morphz.script-studio", version: "1.0.0" };
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
let logs = "";
let providerCalls = 0;
let providerError: Error | undefined;
let lastToolCallId: string | undefined;
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
// Runtime appends its terminal/wait control after restricting ordinary model-owned
// evaluations to the Harness scope (orchestrator.rs: restrict_tools_to_scope).
// This is not an additional physical capability. Keep every other tool excluded.
const permittedTools = new Set([
  "host_morphz",
  "context_tx",
  "recall",
  "no_reply",
]);
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
    const input = JSON.parse(Buffer.concat(chunks).toString()) as {
      stream?: boolean;
      tools?: { function?: { name?: string } }[];
      messages?: { role: string; content?: unknown; tool_call_id?: string }[];
    };
    const tools = input.tools?.map((tool) => tool.function?.name ?? "") ?? [];
    assert.ok(
      tools.includes("host_morphz"),
      "Installed Harness must expose the real Host tool",
    );
    assert.ok(
      tools.every((name) => permittedTools.has(name)),
      `Unexpected tool outside Harness plus Runtime terminal-control boundary: ${tools.join(",")}`,
    );
    const messages = input.messages ?? [];
    const mountedContext = messages
      .filter((message) => message.role !== "tool")
      .map((message) => JSON.stringify(message.content))
      .join("\n");
    assert.ok(
      mountedContext.includes("morphz.script-studio"),
      "Actual request must mount exact Harness identity",
    );
    assert.ok(
      mountedContext.includes("bounded-process"),
      "Actual request must mount the writing contract",
    );
    if (lastToolCallId) {
      const result = messages.findLast(
        (message) =>
          message.role === "tool" && message.tool_call_id === lastToolCallId,
      );
      assert.ok(
        result,
        "Previous physical Host result must reach the provider",
      );
      const text =
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);
      assert.ok(
        !/Tool execution failed|\"ok\"\s*:\s*false|\"status\"\s*:\s*\"error\"/.test(
          text,
        ),
        `Host operation failed: ${text.slice(0, 1200)}`,
      );
      if (providerCalls === 2) {
        assert.ok(
          text.includes(targetId) && text.includes("baseRevision"),
          "Read-generation must return pinned target",
        );
      }
      if (providerCalls === 3)
        assert.ok(
          text.includes("draftJson"),
          "Exact version must be returned as draft JSON",
        );
      if (providerCalls === 4)
        assert.ok(
          text.includes("receipt"),
          "Candidate submission must return a persisted receipt",
        );
    }
    const requests: object[] = [
      { action: "read-input" },
      { action: "script", script: { action: "read-generation" } },
      {
        action: "script",
        script: {
          action: "read-item",
          productionId,
          itemId: targetId,
          revision: 1,
        },
      },
      {
        action: "script",
        script: {
          action: "command",
          command: {
            action: "submit-candidate",
            productionId,
            draft: candidateDraft,
            explanation:
              "合成 Provider 的固定测试候选，不是真实模型创作或质量评价。",
          },
        },
      },
    ];
    const argument = requests[providerCalls++];
    assert.ok(
      providerCalls <= 5,
      "Unexpected additional provider call; refuse unbounded retry",
    );
    const call = argument
      ? {
          id: `script-smoke-${providerCalls}`,
          type: "function",
          function: {
            name: "host_morphz",
            arguments: JSON.stringify(argument),
          },
        }
      : null;
    lastToolCallId = call?.id;
    const message = call
      ? { role: "assistant", content: "", tool_calls: [call] }
      : {
          role: "assistant",
          content: "合成测试候选已提交，等待人工决定；未批准或锁稿。",
        };
    if (input.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: randomUUID(),
          choices: [
            { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
          ],
        }),
      );
    }
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
) => {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (providerError) throw providerError;
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
  const env = {
    PATH: process.env.PATH,
    HOME: homeDirectory,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    MORPHZ_HOME: runtimeDirectory,
    MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
    MORPHZ_DASHBOARD_TOKEN: runtimeToken,
    MORPHZ_HOST_TOOLS_FILE: host.manifestPath,
    MORPHZ_EXPERIMENTAL_FEATURES: "session-io",
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
  cli(["harness", "install", harnessFile]);
  const registered = cli(["harness", "list"]);
  assert.ok(
    registered.includes(harnessRef.id) &&
      registered.includes(harnessRef.version),
    "Package must be listed by a second process reading the persisted registry",
  );
  assert.equal(providerCalls, 0, "Installing a Harness must not call a model");
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
    { env, stdio: "pipe" },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream.on("data", (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-20_000);
    });
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
    maxReviewPasses: 0,
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
      scriptGeneration: generation,
    },
  };
  const receipt = (await host.connection.call("message", command, {
    identityGeneration: boot.csrfToken,
  })) as Receipt;
  await waitUntil(() => {
    const delivery = host!.connection.application.options
      .runtime!.snapshot()
      .deliveries.find((d) => d.inputId === receipt.entityId);
    if (delivery?.state === "failed")
      throw new Error(delivery.error ?? "Script delivery failed");
    return delivery?.state === "completed";
  }, "Pinned script candidate delivery");
  assert.equal(providerCalls, 5);
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
  assert.ok(new TextDecoder().decode(docx).includes("一张写着明日日期的车票"));
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
    5,
    "Reopen/retry must not replay the model or duplicate the candidate",
  );
  assert.equal(production().candidates.length, 1);
  assert.equal(production().exports.length, 1);
  const evidence = {
    harness: harnessRef,
    applicationId: app.id,
    productionBuiltinBound: true,
    provider: "synthetic-fixed-responses",
    providerCalls,
    centerId,
    productionId,
    targetId,
    inputId: receipt.entityId,
    candidateId: candidate.id,
    exportId,
    docxBytes: docx.byteLength,
    docxSha256: createHash("sha256").update(docx).digest("hex"),
    assertions: [
      "persisted Harness install/list/reopen",
      "actual mounted contract and tool allowlist",
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
} catch (error) {
  console.error(redact(logs));
  console.error("Isolated failure evidence retained:", directory);
  throw error;
} finally {
  // Attempt every cleanup even if one fails. Success requires process and socket teardown too.
  const failures: unknown[] = [];
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
