/** Real Runtime + real Work center. Defaults to a deterministic local model.
 * --live explicitly uses the test model env values; never loads user databases
 * or project .env. Live calls are excluded from default test suites.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import {
  prepareHostTools,
  runtimeAgentTools,
} from "../apps/service/src/agent-tools.js";
import { createAppServer } from "../apps/service/src/http.js";
import { localAccess, contentSchema } from "../packages/core/src/model.js";

const live = process.argv.includes("--live");
const model = live ? process.env.MORPHZWORK_LIVE_MODEL : "test-model";
const protocol = live ? process.env.MORPHZWORK_LIVE_PROTOCOL : "openai-chat";
const testKey = live ? process.env.MORPHZWORK_TEST_KEY : "isolated-test-key";
if (live) {
  assert.ok(
    model && testKey && process.env.MORPHZWORK_LIVE_BASE_URL,
    "Live test needs an explicitly configured model endpoint and credential.",
  );
  assert.ok(["openai-chat", "openai-responses"].includes(protocol ?? ""));
  const url = new URL(process.env.MORPHZWORK_LIVE_BASE_URL!);
  assert.ok(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  );
}

const binary = resolve(
  process.env.MORPHZWORK_RUNTIME_BINARY ?? "../Morphz/target/debug/morphz",
);
assert.ok(
  existsSync(binary),
  "先构建 Morphz Runtime，或指定 MORPHZWORK_RUNTIME_BINARY。",
);
const directory = mkdtempSync(join(tmpdir(), "morphzwork-runtime-tools-"));
const runtimeDirectory = join(directory, "runtime"),
  workDirectory = join(directory, "work");
mkdirSync(runtimeDirectory, { mode: 0o700 });
mkdirSync(workDirectory, { mode: 0o700 });
const store = new WorkspaceStore(join(workDirectory, "workspace.sqlite"));
const source = store.execute(
  {
    commandId: randomUUID(),
    operation: {
      type: "import-document",
      projectId: "first-project",
      relativePath: "fixtures/source.md",
      text: "# 授权资料\n蝴蝶是这里的测试主题。",
    },
  },
  localAccess,
);
const namespace = randomUUID(),
  runtimeToken = randomBytes(32).toString("hex");
let stage = 0,
  revisionPhase = false,
  understandingRound = 0,
  understandingStage = 0,
  providerCalls = 0;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  providerCalls++;
  assert.ok(
    input.tools?.some(
      (t: { function?: { name: string } }) =>
        t.function?.name === "host_morphz_work",
    ),
    "实际模型请求必须含 Host 工具定义",
  );
  const result = store.snapshot().artifacts.find((a) => a.title === "测试交付");
  let args: unknown;
  let toolName = "host_morphz_work";
  if (understandingRound) {
    const current = store
      .snapshot()
      .artifacts.find(
        (a) => a.content.kind === "document" && a.content.understanding,
      );
    if (understandingStage++ === 0) {
      const saved = store.runtimeState() as {
        sessions: Record<
          string,
          { id: string; projectId: string; scope: string }
        >;
      };
      const session = Object.values(saved.sessions).find(
        (s) => s.projectId === "first-project" && s.scope === "workspace",
      )!;
      const view = (await (
        await fetch(
          `http://127.0.0.1:${runtimePort}/api/sessions/${session.id}/context/projection`,
          { headers: { Authorization: `Bearer ${runtimeToken}` } },
        )
      ).json()) as { state: { version: number } };
      const summary =
        understandingRound === 1
          ? "# 当前理解\n\n目标：根据授权资料撰写说明。\n约束：只使用项目资料。"
          : "# 当前理解\n\n目标：根据授权资料撰写说明。\n约束：仅使用合成项目资料，不引用个人文件。";
      toolName = "context_tx";
      args = {
        transaction: `(context-tx (base-version ${view.state.version}) (reason "publish user-facing understanding") (${understandingRound === 1 ? "create" : "revise"} mw-public-first-project (public-summary ${JSON.stringify(summary)})))`,
      };
    } else if (understandingStage === 2) {
      args = {
        action: "publish-understanding",
        frameRevision: understandingRound,
        sources: [{ artifactId: source.entityId, revision: 1 }],
        ...(understandingRound === 2
          ? { artifactId: current!.id, revision: 1 }
          : {}),
      };
    }
  } else if (!revisionPhase) {
    args = [
      { action: "search", query: "蝴蝶" },
      { action: "read", artifactId: source.entityId },
      {
        action: "create-document",
        title: "测试交付",
        markdown: "基于授权资料，蝴蝶是测试主题。",
      },
      {
        action: "link",
        artifactId: result?.id,
        toId: source.entityId,
        relation: "references",
      },
    ][stage++];
  } else
    args =
      stage++ === 0
        ? { action: "read", artifactId: result?.id }
        : stage === 2
          ? {
              action: "revise-document",
              artifactId: result?.id,
              revision: 1,
              title: "测试交付",
              markdown: "基于授权资料，蝴蝶是测试主题。已按人工批注补充细节。",
            }
          : undefined;
  const call = args
    ? {
        id: `call-${revisionPhase ? "revise" : "create"}-${stage}`,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(args) },
      }
    : null;
  const message = call
    ? { role: "assistant", content: "", tool_calls: [call] }
    : { role: "assistant", content: "已在工作空间保存测试交付。" };
  if (input.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        choices: [
          { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
        ],
      }),
    );
  }
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port;
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const runtimePort = await freePort(),
  workPort = await freePort();
const manifest = prepareHostTools(workDirectory, workPort, namespace);
const configFile = join(runtimeDirectory, "morphz.toml");
writeFileSync(
  configFile,
  `[llm]\nprovider = "stub"\nmodel = ${JSON.stringify(model)}\nreasoning_effort = "low"\n[providers.stub]\nprotocol = ${JSON.stringify(protocol)}\nbase_url = ${JSON.stringify(live ? process.env.MORPHZWORK_LIVE_BASE_URL : `http://127.0.0.1:${providerPort}/v1`)}\ncredential = "stub"\n[credentials.stub]\nsource = "env"\nname = "MORPHZWORK_TEST_KEY"\n[permissions]\nworkspace_root = ${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir = ${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
  { mode: 0o600 },
);
const runtime = spawn(
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
      MORPHZ_DASHBOARD_TOKEN: runtimeToken,
      MORPHZ_HOST_TOOLS_FILE: manifest.path,
      MORPHZWORK_TEST_KEY: testKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
for (const stream of [runtime.stdout, runtime.stderr])
  stream.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-14000);
  });
const bridge = new RuntimeBridge(store, {
  url: `http://127.0.0.1:${runtimePort}`,
  token: runtimeToken,
  namespace,
});
const app = createAppServer(store, {
  port: workPort,
  webRoot: "/nonexistent",
  runtime: bridge,
  agentTools: runtimeAgentTools(store, bridge, manifest.token),
});
await new Promise<void>((r) => app.listen(workPort, "127.0.0.1", r));
const origin = `http://127.0.0.1:${workPort}`;
const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  name: string,
  timeout = live ? 180000 : 45000,
) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (runtime.exitCode !== null)
      throw new Error(`Runtime exited ${runtime.exitCode}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(name + " timed out");
};
try {
  await waitUntil(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${runtimePort}/api/status`, {
          headers: { Authorization: `Bearer ${runtimeToken}` },
        })
      ).ok;
    } catch {
      return false;
    }
  }, "Runtime start");
  bridge.start();
  async function send(body: string, artifactId: string | null = null) {
    const boot = (await (await fetch(origin + "/api/workspace")).json()) as {
      csrfToken: string;
    };
    const response = await fetch(origin + "/api/messages", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-MorphzWork-Token": boot.csrfToken,
      },
      body: JSON.stringify({
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId,
          artifactRevision: artifactId ? 1 : null,
          body,
          selection: "",
          targetActantId: "morphz-agent",
        },
      }),
    });
    assert.equal(response.status, 202);
    const receipt = (await response.json()) as { entityId: string };
    await waitUntil(() => {
      const delivery = bridge
        .snapshot()
        .deliveries.find((d) => d.inputId === receipt.entityId);
      if (delivery?.state === "failed")
        throw new Error(delivery.error ?? "Runtime turn failed");
      return delivery?.state === "completed";
    }, "tool turn");
  }
  await send(
    "请用 host_morphz_work 搜索‘蝴蝶’，阅读授权资料，创建标题严格为‘测试交付’的文档并用 references 关联来源。正文需包含‘蝴蝶是测试主题’。只使用工作空间对象工具，不执行 Shell 或其他外部动作。保存完成后回复。",
  );
  const artifact = store
    .snapshot()
    .artifacts.find((a) => a.title === "测试交付");
  assert.ok(artifact, "实际工具调用应创建对象");
  assert.equal(artifact.createdBy.actantId, "morphz-agent");
  assert.equal(store.snapshot().relations.length, 1);
  store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "annotate",
        artifactId: artifact.id,
        artifactRevision: 1,
        quote: "测试主题",
        body: "补充细节",
      },
    },
    localAccess,
  );
  revisionPhase = true;
  stage = 0;
  await send("请读取当前文档和人工批注，修订同一对象。", artifact.id);
  const updated = store.snapshot().artifacts.find((a) => a.id === artifact.id)!;
  assert.ok(updated.revision >= 2);
  assert.equal(updated.versions[0]!.revision, 1);
  assert.equal(store.snapshot().artifacts.length, 2);
  const execution = await bridge.executions.snapshot({
    projectId: "first-project",
    artifactId: artifact.id,
  });
  assert.ok(execution.jobs.length >= 2);
  assert.ok(
    execution.jobs.every(
      (j) => j.tool_name === "host_morphz_work" && j.status === "succeeded",
    ),
  );
  const resultJob = execution.jobs.find((j) => j.result_event_id)!;
  assert.ok(
    (
      await bridge.executions.result(
        { projectId: "first-project", artifactId: artifact.id },
        resultJob.id,
      )
    ).available,
  );
  if (!live) assert.ok(providerCalls >= 8);
  if (!live) {
    understandingRound = 1;
    understandingStage = 0;
    await send("请整理项目公开的当前理解，通过上下文事务维护后发布。");
    const current = store
      .snapshot()
      .artifacts.find(
        (a) => a.content.kind === "document" && a.content.understanding,
      )!;
    assert.ok(current);
    assert.equal(current.content.kind, "document");
    assert.ok(
      current.content.kind === "document" &&
        current.content.markdown.startsWith("# 当前理解"),
    );
    understandingRound = 2;
    understandingStage = 0;
    await send(
      "补充约束：仅使用合成资料，不引用个人文件。请用上下文事务更新。",
      current.id,
    );
    const revised = store
      .snapshot()
      .artifacts.find((a) => a.id === current.id)!;
    assert.equal(revised.revision, 2);
    assert.ok(
      revised.content.kind === "document" &&
        revised.content.understanding?.frameRevision === 2,
    );
    understandingRound = 0;
    console.log(
      "PASS: model context_tx → verified public understanding → human correction → context_tx revision → same artifact update.",
    );
  }
  // The deterministic fixture also exercises real scheduled admission after
  // a principal-bound human response. Live model object tests remain separate.
  if (!live) {
    const human = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "确认范围",
          content: contentSchema.parse({
            kind: "task",
            description: "确认只使用合成资料",
            assigneeId: "local-human",
            model: null,
            priority: "high",
            dueDate: null,
            assignment: "accepted",
            execution: "waiting",
            delivery: "none",
            resultIds: [],
          }),
        },
      },
      localAccess,
    ).entityId;
    const follow = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "答复后继续",
          content: contentSchema.parse({
            kind: "task",
            description: "基于人工答复继续处理",
            assigneeId: "morphz-agent",
            model: "test-model",
            priority: "normal",
            dueDate: null,
            assignment: "accepted",
            execution: "planned",
            delivery: "none",
            resultIds: [],
            runRequested: 1,
            dependsOnIds: [human],
          }),
        },
      },
      localAccess,
    ).entityId;
    await bridge.collaboration.reconcile();
    assert.equal(bridge.collaboration.snapshot(follow).runs.length, 0);
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "respond-task",
          taskId: human,
          expectedRevision: 1,
          body: "确认，只使用合成资料。",
        },
      },
      localAccess,
    );
    await waitUntil(
      () =>
        bridge.collaboration.snapshot(follow).runs.at(-1)?.threadState ===
        "completed",
      "human-response scheduled work",
      60000,
    );
    const run = bridge.collaboration.snapshot(follow).runs.at(-1)!;
    assert.ok(run.record);
    assert.equal(run.error, "");
    console.log(
      "PASS: principal-bound human response → dependent work → durable Runtime Schedule → real model execution.",
    );
  }
  console.log(
    `PASS: real Runtime → ExecutionJob → authenticated Host tool → Work object create/read/search/link/revise, with human annotation and preserved history. Model transport: ${live ? `live ${model}` : "deterministic fixture"}.`,
  );
} catch (error) {
  console.error(
    output
      .split(runtimeToken)
      .join("[redacted]")
      .split(manifest.token)
      .join("[redacted]")
      .split(testKey!)
      .join("[redacted]"),
  );
  console.error("Test data retained in", directory);
  throw error;
} finally {
  await bridge.stop();
  app.closeIdleConnections();
  await new Promise<void>((r) => app.close(() => r()));
  runtime.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((r) => runtime.once("exit", () => r())),
    new Promise<void>((r) => setTimeout(r, 4000)),
  ]);
  if (runtime.exitCode === null && runtime.signalCode === null)
    runtime.kill("SIGKILL");
  provider.closeAllConnections();
  await new Promise<void>((r) => provider.close(() => r()));
  store.close();
}
