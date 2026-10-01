/** Real Runtime -> Host tool -> Platform acceptance for public understanding.
 * Every dependency is isolated; no user profile, provider or existing database is read.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  prepareHostTools,
  runtimeAgentTools,
} from "../packages/application/src/agent-tools.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type RecordedInput } from "../packages/core/src/model.js";
import { runtimeBinaryPath } from "./runtime-path.mjs";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "先构建 Morphz Runtime。");
const root = mkdtempSync(join(tmpdir(), "morphz-public-understanding-"));
const runtimeDirectory = join(root, "runtime");
const workspace = new WorkspaceStore(join(root, "workspace.sqlite"));
const identity = new IdentityCenter(workspace, {
  version: 1,
  members: [
    {
      ...localAccess,
      loginTokenHash: createHash("sha256")
        .update(randomBytes(32))
        .digest("hex"),
      enabled: true,
    },
  ],
});
const namespace = randomUUID();
const projectId = `project-${randomUUID()}`;
const inputId = randomUUID();
const correctionInputId = randomUUID();
const token = randomBytes(32).toString("hex");
const operatorToken = randomBytes(32).toString("hex");
const hostPort = await freePort();
const runtimePort = await freePort();
const runtimeURL = `http://127.0.0.1:${runtimePort}`;
const hostTools = prepareHostTools(root, hostPort, namespace, true);
const expectedBody =
  "# 当前理解\n\n目标：验证真实 Runtime 已提交的公开认知帧。";
const correctedBody =
  "# 当前理解\n\n目标：验证更正会生成新的公开版本，不覆盖旧版。";
let phase = "initialize";
let modelCalls = 0;
let providerFailure: unknown;
const providerObservations: string[] = [];
let runtimeOutput = "";
let runtimeProcess: ChildProcess | undefined;
let hostServer: ReturnType<typeof createAppServer> | undefined;
let provider: Server | undefined;
let bridge: RuntimeBridge | undefined;
let domains: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (providerFailure) throw providerFailure;
    if (
      runtimeProcess?.exitCode !== null &&
      runtimeProcess?.exitCode !== undefined
    )
      throw new Error(`Runtime 提前退出：${runtimeOutput}`);
    const value = await read();
    if (value !== null) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${label} 超时；Runtime: ${runtimeOutput}`);
}

function answerModel(
  response: import("node:http").ServerResponse,
  streamed: boolean,
  tool: { name: string; args: unknown } | null,
) {
  const call = tool
    ? {
        id: `smoke-tool-${modelCalls}`,
        type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.args) },
      }
    : null;
  const message = call
    ? { role: "assistant", content: "", tool_calls: [call] }
    : { role: "assistant", content: "公开理解已保存。" };
  if (streamed) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "smoke", choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  } else {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "smoke",
        object: "chat.completion",
        choices: [
          { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
        ],
      }),
    );
  }
}

try {
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  phase = "start isolated model";
  provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString()) as {
        stream?: boolean;
        messages?: unknown[];
        tools?: Array<{ function?: { name?: string } }>;
      };
      assert.ok(
        input.tools?.some((item) => item.function?.name === "context_tx"),
      );
      assert.ok(
        input.tools?.some((item) => item.function?.name === "host_morphz"),
      );
      const index = modelCalls++;
      providerObservations.push(
        JSON.stringify(
          input.messages
            ?.filter(
              (message) =>
                !!message &&
                typeof message === "object" &&
                "role" in message &&
                message.role === "tool",
            )
            .slice(-2) ?? [],
        ).slice(-3_000),
      );
      let tool: { name: string; args: unknown } | null = null;
      if (index === 0 || index === 3) {
        const sessionId = await waitFor(async () => {
          const state = workspace.runtimeState() as {
            deliveries: Array<{ inputId: string; sessionId: string }>;
          };
          return (
            state.deliveries.find(
              (item) =>
                item.inputId === (index === 0 ? inputId : correctionInputId),
            )?.sessionId ?? null
          );
        }, "Runtime Session");
        const projection = await fetch(
          `${runtimeURL}/api/sessions/${sessionId}/context/projection`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Morphz-Principal": bridge!.principalId(
                localAccess.principalId,
              ),
            },
          },
        );
        assert.equal(projection.status, 200);
        const view = (await projection.json()) as {
          state: { version: number };
        };
        tool = {
          name: "context_tx",
          args: {
            transaction: `(context-tx (base-version ${view.state.version}) (reason "publish public understanding") (${index === 0 ? "create" : "revise"} mw-public-${projectId} (public-summary ${JSON.stringify(index === 0 ? expectedBody : correctedBody)})))`,
          },
        };
      } else if (index === 1 || index === 4) {
        assert.match(JSON.stringify(input.messages), /mw-public-project-/);
        tool = {
          name: "host_morphz",
          args: {
            action: "publish-understanding",
            frameRevision: index === 1 ? 1 : 2,
            ...(index === 4 ? { revision: 1 } : {}),
            contentSources: [],
          },
        };
      } else if (index === 2 || index === 5) {
        const latest = input.messages
          ?.filter(
            (message) =>
              !!message &&
              typeof message === "object" &&
              "role" in message &&
              message.role === "tool",
          )
          .at(-1) as { content: string } | undefined;
        assert.ok(latest, "模型应收到 Host 保存回执");
        const envelope = JSON.parse(latest.content) as { result: string };
        assert.equal((JSON.parse(envelope.result) as { ok: boolean }).ok, true);
      } else {
        throw new Error(`模型调用次数超出预期：${index + 1}`);
      }
      answerModel(response, !!input.stream, tool);
    } catch (error) {
      providerFailure = error;
      response.writeHead(500);
      response.end("isolated provider assertion failed");
    }
  });
  await new Promise<void>((done) => provider!.listen(0, "127.0.0.1", done));
  const providerPort = (provider.address() as { port: number }).port;
  const configFile = join(root, "morphz.toml");
  writeFileSync(
    configFile,
    `[llm]\nmodel="test-model"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_UNDERSTANDING_SMOKE_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(root)}\n[server.identity]\nmode="trusted-gateway"\nprovider_id="understanding-smoke"\nservice_token_env="MORPHZ_UNDERSTANDING_SMOKE_GATEWAY"\n`,
    { mode: 0o600 },
  );

  phase = "open Platform and Host";
  domains = await openApplicationDomainsHost(root, workspace, identity);
  await domains.work.authority.withSession(
    localAccess,
    () => {},
    (actor) =>
      domains!.content.platform.createProject(actor, {
        commandId: randomUUID(),
        projectId,
        title: "真实公开理解验收",
      }),
  );
  bridge = new RuntimeBridge(
    workspace,
    {
      url: runtimeURL,
      token,
      namespace,
      identityMode: "trusted_gateway",
    },
    identity,
  );
  const binding = domains.bindRuntime(bridge);
  hostServer = createAppServer(workspace, {
    port: hostPort,
    webRoot: resolve("dist/web"),
    runtime: bridge,
    identity,
    platformWork: domains.work,
    platformDocuments: domains.content,
    platformScripts: domains.content,
    platformReader: domains.reader,
    messageAttachments: domains.messageAttachments,
    agentTools: runtimeAgentTools(
      bridge,
      hostTools.token,
      {
        authority: binding.authority,
        work: domains.work.service,
        content: domains.content,
        reader: domains.reader.service,
      },
      {
        bookmarkDomain: binding,
      },
    ),
  });
  await new Promise<void>((done) =>
    hostServer!.listen(hostPort, "127.0.0.1", done),
  );

  phase = "start Runtime";
  runtimeProcess = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${runtimePort}`,
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
        MORPHZ_DASHBOARD_TOKEN: operatorToken,
        MORPHZ_HOST_TOOLS_FILE: hostTools.path,
        MORPHZ_UNDERSTANDING_SMOKE_GATEWAY: token,
        MORPHZ_UNDERSTANDING_SMOKE_KEY: "isolated-test-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const output of [runtimeProcess.stdout, runtimeProcess.stderr])
    output?.on("data", (chunk: Buffer) => {
      runtimeOutput = (runtimeOutput + chunk.toString()).slice(-8_192);
    });
  await waitFor(async () => {
    try {
      return (
        await fetch(`${runtimeURL}/health`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok
        ? true
        : null;
    } catch {
      return null;
    }
  }, "Runtime startup");
  const accountBinding = await fetch(
    `${runtimeURL}/api/agents/default-agent/provider-accounts/stub`,
    { method: "PUT", headers: { Authorization: `Bearer ${operatorToken}` } },
  );
  assert.equal(
    accountBinding.status,
    200,
    "隔离 Agent 应绑定合成 Provider Account",
  );

  phase = "commit Context and publish via Host";
  const input: RecordedInput = {
    id: inputId,
    projectId,
    conversationId: projectId,
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "请形成并发布当前项目的公开理解。",
    author: localAccess,
    targetActantId: "morphz-agent",
    status: "recorded",
    createdAt: new Date().toISOString(),
  };
  await bridge.as(localAccess, () => bridge!.enqueuePlatformInput(input));
  await bridge.tick();
  const saved = await waitFor(
    async () =>
      domains!.work.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          domains!.content.platform.getProjectUnderstanding(actor, projectId),
      ),
    "Platform publication",
  );
  assert.equal(saved.body, expectedBody);
  assert.equal(saved.frameId, `mw-public-${projectId}`);
  assert.equal(saved.frameRevision, 1);
  assert.equal(saved.revision, 1);
  await waitFor(async () => (modelCalls >= 3 ? true : null), "model receipt");
  assert.equal(modelCalls, 3);
  phase = "publish correction without replacing first version";
  await bridge.as(localAccess, () =>
    bridge!.enqueuePlatformInput({
      ...input,
      id: correctionInputId,
      body: "请更正并重新发布当前理解。",
      createdAt: new Date().toISOString(),
    }),
  );
  await bridge.tick();
  const corrected = await waitFor(async () => {
    const current = await domains!.work.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.content.platform.getProjectUnderstanding(actor, projectId),
    );
    return current?.revision === 2 ? current : null;
  }, "corrected Platform publication");
  assert.equal(corrected.body, correctedBody);
  assert.equal(corrected.frameRevision, 2);
  const firstVersion = await domains.work.authority.withSession(
    localAccess,
    () => {},
    (actor) =>
      domains!.content.platform.getProjectUnderstanding(actor, projectId, 1),
  );
  assert.equal(firstVersion?.body, expectedBody);
  await waitFor(
    async () => (modelCalls >= 6 ? true : null),
    "corrected model receipt",
  );
  assert.equal(modelCalls, 6);
  assert.equal(providerFailure, undefined);
  console.log(
    "PASS: real Runtime context_tx committed two frame revisions; Host published immutable Platform versions and returned both receipts.",
  );
} catch (error) {
  console.error(
    `Understanding smoke failed during ${phase}. Model calls: ${modelCalls}. Provider observations: ${JSON.stringify(providerObservations)}. ${runtimeOutput}`,
  );
  throw error;
} finally {
  await bridge?.stop();
  if (runtimeProcess && runtimeProcess.exitCode === null) {
    await new Promise<void>((done) => {
      runtimeProcess!.once("exit", () => done());
      runtimeProcess!.kill("SIGTERM");
    });
  }
  if (hostServer)
    await new Promise<void>((done) => hostServer!.close(() => done()));
  if (provider)
    await new Promise<void>((done) => provider!.close(() => done()));
  await domains?.close();
  workspace.close();
  rmSync(root, { recursive: true, force: true });
}
