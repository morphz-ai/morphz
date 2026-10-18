/** Real Runtime + embedded application control. Synthetic provider, isolated
 * storage; never uses the installed Desktop, its key, or any user Objective. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { runtimeFixtureFinalReply } from "./runtime-fixture-reply.js";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { localAccess } from "../packages/core/src/model.js";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary));
process.env.MORPHZ_APP_ENV_FILE = "";
const directory = mkdtempSync(join(tmpdir(), "morphz-objective-controls-"));
const runtimeDir = join(directory, "runtime"),
  appDir = join(directory, "application");
mkdirSync(runtimeDir);
mkdirSync(appDir);
let calls = 0;
const provider = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.method !== "POST") {
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls++;
  if (calls > 2) {
    await new Promise((resolve) => response.once("close", resolve));
    return;
  }
  const first = calls === 1;
  if (first)
    assert.ok(
      body.tools.some(
        (tool: any) => tool.function?.name === "objective_create",
      ),
      "current Runtime offers Objective creation",
    );
  const result = first
    ? {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: randomUUID(),
              type: "function",
              function: {
                name: "objective_create",
                arguments: JSON.stringify({
                  stated_objective:
                    "TEST 隔离目标控制：跨求值保留，用于核验暂停、恢复与删除。不执行外部命令。",
                  reason:
                    "隔离控制验收需要让同一目标在多个求值及等待之间保留。",
                  source_refs: [],
                }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      }
    : runtimeFixtureFinalReply(body, {
        content: "TEST 已创建隔离目标。",
        title: "创建隔离控制验收目标",
        result: "TEST 目标已创建，未执行外部命令。",
      });
  if (body.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { ...result.message, ...(result.message.tool_calls ? { tool_calls: result.message.tool_calls.map((tool: any, index: number) => ({ ...tool, index })) } : {}) }, finish_reason: result.finishReason }] })}\n\ndata: [DONE]\n\n`,
    );
  } else
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: result.message,
            finish_reason: result.finishReason,
          },
        ],
      }),
    );
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = (provider.address() as { port: number }).port;
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const token = randomBytes(32).toString("hex");
writeFileSync(
  join(appDir, "runtime.json"),
  JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    token,
    namespace: randomUUID(),
  }),
  { mode: 0o600 },
);
const config = join(runtimeDir, "morphz.toml");
writeFileSync(
  config,
  `[llm]\nmodel="test-model"\nreasoning_effort="low"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_OBJECTIVE_TEST_KEY"\n`,
  { mode: 0o600 },
);
let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
let runtime: ReturnType<typeof spawn> | undefined;
let logs = "",
  passed = false;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check: () => boolean | Promise<boolean>, label: string) {
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    if (await check()) return;
    if (runtime && runtime.exitCode !== null)
      throw new Error(`Runtime exited: ${label}`);
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  host = await openEmbeddedApplication(appDir, join(directory, "profile"));
  runtime = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${port}`,
      "--cwd",
      runtimeDir,
      "--config-file",
      config,
      "--log-level",
      "warn",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        MORPHZ_HOME: runtimeDir,
        MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDir, "runtime.sqlite"),
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_HOST_TOOLS_FILE: host.manifestPath,
        MORPHZ_OBJECTIVE_TEST_KEY: "synthetic-fixture-key",
      },
      stdio: "pipe",
    },
  );
  for (const stream of [runtime.stdout!, runtime.stderr!])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-10000);
    });
  let bridge = host.connection.application.options.runtime!;
  await wait(() => bridge.platformStatus().connected, "Runtime ready");
  assert.ok(
    (
      await fetch(
        `http://127.0.0.1:${port}/api/agents/default-agent/provider-accounts/stub`,
        { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
      )
    ).ok,
  );
  let boot = (await host.connection.call("platform.bootstrap")) as {
    csrfToken: string;
  };
  const invoke = (method: any, params: unknown) =>
    host!.connection.call(method, params, {
      identityGeneration: boot.csrfToken,
    });
  await invoke("projects.create", {
    commandId: randomUUID(),
    projectId: "first-project",
    title: "TEST 隔离目标控制",
  });
  await invoke("platform.message", {
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: "first-project",
      conversationId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "TEST 创建一个用于跨求值控制验收的长期目标，不执行外部操作。",
      targetActantId: "morphz-agent",
    },
  });
  const read = async () => {
    await bridge.refreshPlatformActivity();
    return bridge.platformNavigationSnapshot(localAccess, ["first-project"])
      .runtime.activity!;
  };
  await wait(
    async () => !!(await read()).objectives?.length,
    "real Agent-created attributed Objective",
  );
  let goal = (await read()).objectives![0]!;
  assert.equal(goal.controlAllowed, true);
  const goalId = goal.id;
  const control = async (
    action: "pause" | "resume" | "delete",
    revision = goal.revision!,
  ) =>
    invoke("objective.control", {
      objectiveId: goal.id,
      projectId: goal.projectId,
      conversationId: goal.conversationId,
      revision,
      action,
    });
  await control("pause");
  goal = (await read()).objectives!.find((value) => value.id === goalId)!;
  assert.equal(goal.status, "paused");
  const pausedRevision = goal.revision!;
  await assert.rejects(control("resume", pausedRevision - 1), /变化/);
  const edited =
    "TEST 修改后的隔离目标：保留暂停、执行历史与完整目标正文。\n\n不执行外部操作。";
  await invoke("objective.control", {
    objectiveId: goal.id,
    projectId: goal.projectId,
    conversationId: goal.conversationId,
    revision: pausedRevision,
    action: "edit",
    statedObjective: edited,
  });
  goal = (await read()).objectives!.find((value) => value.id === goalId)!;
  assert.equal(goal.title, edited);
  assert.equal(goal.status, "paused");
  assert.equal(goal.generation, 1);
  await control("resume");
  goal = (await read()).objectives!.find((value) => value.id === goalId)!;
  assert.equal(goal.status, "active");
  await control("delete");
  goal = (await read()).objectives!.find((value) => value.id === goalId)!;
  assert.equal(goal.status, "cancelled");
  assert.ok(
    (await read()).threads.length,
    "original execution history retained",
  );
  await host.close();
  host = await openEmbeddedApplication(appDir, join(directory, "profile"));
  bridge = host.connection.application.options.runtime!;
  boot = (await host.connection.call("platform.bootstrap")) as {
    csrfToken: string;
  };
  await wait(
    async () =>
      !!(await read()).objectives?.some((value) => value.id === goalId),
    "reopened same Objective",
  );
  assert.equal(
    (await read()).objectives!.find((value) => value.id === goalId)!.status,
    "cancelled",
  );
  assert.equal(
    (await read()).objectives!.find((value) => value.id === goalId)!.title,
    edited,
  );
  assert.equal(runtime.exitCode, null);
  passed = true;
  console.log(
    "PASS: real Runtime + embedded typed control; Agent-created attributed goal paused/resumed/deleted with exact revisions; stale revision rejected; execution history and cancelled goal retained after Host reopen. Synthetic provider, isolated data.",
  );
} catch (error) {
  console.error(logs.split(token).join("[redacted]"));
  console.error("Retained isolated evidence:", directory);
  throw error;
} finally {
  await host?.close();
  if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
    const exit = new Promise((resolve) => runtime!.once("exit", resolve));
    runtime.kill("SIGTERM");
    await Promise.race([exit, delay(10000)]);
  }
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (passed) rmSync(directory, { recursive: true });
}
