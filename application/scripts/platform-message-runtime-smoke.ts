/** Isolated acceptance of Platform inputs and assistant quotes by real Runtime.
 * A loopback fixture provider emits fixed Chinese Markdown; no external model
 * provider is contacted. Fresh Sessions exercise the configured SQL backend.
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
import { createServer as createTcpServer } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { Application } from "../packages/application/src/application.js";
import {
  isoTimeAtMicros,
  isoTimeMicros,
  sameIsoTimeMicros,
} from "../packages/application/src/iso-time.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { prepareHostTools } from "../packages/application/src/agent-tools.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import { MessageAttachmentService } from "../packages/application/src/message-attachment-service.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { localAccess, type RecordedInput } from "../packages/core/src/model.js";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { RuntimeBackupFixture } from "./runtime-backup-fixture.js";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "先构建 Morphz Runtime，再运行消息联合验收。");
const root = mkdtempSync(join(tmpdir(), "morphz-platform-message-runtime-"));
const runtimeDirectory = join(root, "runtime");
const namespace = randomUUID();
const tenantId = randomUUID();
const token = randomBytes(32).toString("hex");
const operatorToken = randomBytes(32).toString("hex");
const projectId = `project-${randomUUID()}`;
const inputId = randomUUID();
const otherAccess = {
  principalId: "isolated-other",
  actantId: "isolated-other-human",
};
const configFile = join(root, "morphz.toml");
const backupFixture =
  process.env.MORPHZ_MESSAGE_SMOKE_BACKUP === "1"
    ? await RuntimeBackupFixture.create(
        root,
        runtimeDirectory,
        configFile,
        process.env.MORPHZ_MESSAGE_SMOKE_POSTGRES_URL,
      )
    : undefined;
const postgresURL =
  backupFixture?.postgresURL ?? process.env.MORPHZ_MESSAGE_SMOKE_POSTGRES_URL;
const assistantText =
  "好，提前一天就是 **10 月 23 日**。当天**上午 9 点（北京时间）**提醒你，可以吗？确认后我再设置定时提醒。";
const selectedText =
  "好，提前一天就是 10 月 23 日。当天上午 9 点（北京时间）提醒你，可以吗？确认后我再设置定时提醒。";
let providerCalls = 0;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (request.method !== "POST") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  providerCalls++;
  const message = { role: "assistant", content: assistantText };
  const choice = { index: 0, finish_reason: "stop" };
  if (body.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ ...choice, delta: message }] })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ id: randomUUID(), choices: [{ ...choice, message }] }),
    );
  }
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerURL = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
const hostTools = prepareHostTools(root, await freePort(), namespace, true);
const human = { credential: "isolated-human" };
const verifier: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    return credential === human.credential
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
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let processHandle: ChildProcess | undefined;
let runtimeURL = "";
let runtimeStderr = "";
let phase = "initialize";
async function startRuntime() {
  phase = "start Runtime";
  runtimeStderr = "";
  // A real restart keeps the configured origin. All Hosts must continue to
  // address the same Runtime endpoint after its process is replaced.
  if (!runtimeURL) runtimeURL = `http://127.0.0.1:${await freePort()}`;
  const child = spawn(
    binary,
    [
      "serve",
      "--bind",
      new URL(runtimeURL).host,
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
        ...(postgresURL
          ? {
              MORPHZ_STORAGE_BACKEND: "postgres",
              MORPHZ_POSTGRES_URL: postgresURL,
            }
          : {}),
        MORPHZ_DASHBOARD_TOKEN: operatorToken,
        MORPHZ_MESSAGE_SMOKE_GATEWAY: token,
        MORPHZ_HOST_TOOLS_FILE: hostTools.path,
        MORPHZ_MESSAGE_SMOKE_KEY: "synthetic-unused",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    runtimeStderr = (runtimeStderr + chunk.toString()).slice(-8_192);
  });
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
      throw new Error(`隔离 Runtime 在就绪前退出：${runtimeStderr}`);
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

let platform: PlatformStore | undefined;
let workspace: WorkspaceStore | undefined;
let bridge: RuntimeBridge | undefined;
let secondWorkspace: WorkspaceStore | undefined;
let secondBridge: RuntimeBridge | undefined;
let messageAttachments: MessageAttachmentService | undefined;
try {
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  writeFileSync(
    configFile,
    `[llm]\nmodel="test-model"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url=${JSON.stringify(providerURL)}\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_MESSAGE_SMOKE_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(root)}\n[server.identity]\nmode="trusted-gateway"\nprovider_id="message-smoke"\nservice_token_env="MORPHZ_MESSAGE_SMOKE_GATEWAY"\n`,
    { mode: 0o600 },
  );
  await startRuntime();
  const accountBinding = await fetch(
    `${runtimeURL}/api/agents/default-agent/provider-accounts/stub`,
    { method: "PUT", headers: { Authorization: `Bearer ${operatorToken}` } },
  );
  assert.ok(
    accountBinding.ok,
    "bind only the isolated fixture provider account",
  );
  phase = "accept first input";
  workspace = new WorkspaceStore(join(root, "workspace.sqlite"), {
    mode: "transport",
    tenantId,
  });
  platform = await PlatformStore.sqlite(
    join(root, "platform.sqlite"),
    verifier,
  );
  const identity = new IdentityCenter(workspace, {
    version: 1,
    members: [localAccess, otherAccess].map((access) => ({
      ...access,
      loginTokenHash: createHash("sha256")
        .update(randomBytes(32))
        .digest("hex"),
      enabled: true,
    })),
  });
  const humanAuthority = new HumanPlatformAuthority(
    tenantId,
    (access) =>
      access.principalId === localAccess.principalId &&
      access.actantId === localAccess.actantId,
  );
  messageAttachments = await MessageAttachmentService.open({
    root: join(root, "message-attachments"),
    tenantId,
    verifier: humanAuthority.verifier(verifier),
    human: humanAuthority,
  });
  await platform.provisionTenant(tenantId);
  await platform.createProject(human, {
    commandId: randomUUID(),
    projectId,
    title: "Platform-only project",
  });
  const config = {
    url: runtimeURL,
    token,
    namespace,
    identityMode: "trusted_gateway" as const,
  };
  const connect = (
    hostWorkspace: WorkspaceStore = workspace!,
    hostIdentity: IdentityCenter = identity,
  ) => {
    const value = new RuntimeBridge(hostWorkspace, config, hostIdentity);
    value.bindMessageAttachments(messageAttachments);
    value.bindPlatformInputAuthority(async (source) => {
      assert.deepEqual(source.author, localAccess);
      return platform!.authorizeMessageRoute(human, source);
    });
    value.bindPlatformReadAuthority((scope, access) => {
      assert.deepEqual(access, localAccess);
      return platform!.authorizeConversationRead(human, scope);
    });
    return value;
  };
  const input: RecordedInput = {
    id: inputId,
    projectId,
    conversationId: projectId,
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "验证 Platform 消息进入真实 Runtime",
    author: localAccess,
    targetActantId: "morphz-agent",
    status: "recorded",
    createdAt: new Date().toISOString(),
  };
  bridge = connect();
  await bridge.as(localAccess, () => bridge!.enqueuePlatformInput(input));
  assert.equal(Reflect.has(workspace, "snapshot"), false);
  assert.equal(Reflect.has(workspace, "execute"), false);
  await bridge.tick();
  phase = "read first accepted input";
  const state = workspace.runtimeState() as {
    deliveries: Array<{
      inputId: string;
      sessionId: string;
      rootId: string | null;
      state: string;
      error: string | null;
    }>;
  };
  const delivery = state.deliveries.find((value) => value.inputId === inputId);
  assert.ok(
    delivery?.rootId,
    `Runtime must accept the original input: ${JSON.stringify(delivery)}`,
  );
  const eventResponse = await fetch(
    `${runtimeURL}/api/sessions/${delivery.sessionId}/events/${delivery.rootId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(localAccess.principalId),
      },
    },
  );
  assert.equal(eventResponse.status, 200);
  const { event } = (await eventResponse.json()) as {
    event: { topic: string; payload: Record<string, unknown> };
  };
  assert.equal(event.topic, "chat/user_message");
  assert.equal(event.payload.client_message_id, inputId);
  const scopedEventsURL = new URL(
    `/api/sessions/${delivery.sessionId}/events`,
    runtimeURL,
  );
  scopedEventsURL.searchParams.set("root_turn_id", delivery.rootId);
  scopedEventsURL.searchParams.set("limit", "100");
  const scopedHeaders = {
    Authorization: `Bearer ${token}`,
    "X-Morphz-Principal": bridge.principalId(localAccess.principalId),
  };
  const scopedEvents = await fetch(scopedEventsURL, {
    headers: scopedHeaders,
  });
  assert.equal(scopedEvents.status, 200);
  assert.ok(
    (
      (await scopedEvents.json()) as {
        events: Array<{ id: string }>;
      }
    ).events.some((item) => item.id === delivery.rootId),
    "the real Runtime returns the accepted input through its root-scoped query",
  );
  scopedEventsURL.searchParams.set("attempt_id", randomUUID());
  const unrelatedAttempt = await fetch(scopedEventsURL, {
    headers: scopedHeaders,
  });
  assert.equal(unrelatedAttempt.status, 200);
  assert.deepEqual(
    ((await unrelatedAttempt.json()) as { events: unknown[] }).events,
    [],
  );
  scopedEventsURL.searchParams.delete("root_turn_id");
  assert.equal(
    (await fetch(scopedEventsURL, { headers: scopedHeaders })).status,
    400,
    "attempt queries cannot scan unrelated roots",
  );
  const byClientId = await fetch(
    `${runtimeURL}/api/sessions/${delivery.sessionId}/messages/by-client-id/${inputId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(localAccess.principalId),
      },
    },
  );
  assert.equal(byClientId.status, 200);
  assert.equal(
    ((await byClientId.json()) as { event: { id: string } }).event.id,
    delivery.rootId,
  );
  const missingByClientId = await fetch(
    `${runtimeURL}/api/sessions/${delivery.sessionId}/messages/by-client-id/${randomUUID()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(localAccess.principalId),
      },
    },
  );
  assert.equal(missingByClientId.status, 404);
  const otherByClientId = await fetch(
    `${runtimeURL}/api/sessions/${delivery.sessionId}/messages/by-client-id/${inputId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(otherAccess.principalId),
      },
    },
  );
  assert.equal(otherByClientId.status, 403);
  const persistedSource = z
    .object({
      request: z.object({
        client_metadata: z.object({
          type: z.literal("object"),
          value: z.object({
            kind: z.object({
              type: z.literal("string"),
              value: z.literal("morphz.platform-input"),
            }),
            source: z.object({
              type: z.literal("object"),
              value: z.object({
                projectId: z.object({
                  type: z.literal("string"),
                  value: z.literal(projectId),
                }),
                conversationId: z.object({
                  type: z.literal("string"),
                  value: z.literal(projectId),
                }),
                body: z.object({
                  type: z.literal("string"),
                  value: z.literal(input.body),
                }),
              }),
            }),
          }),
        }),
      }),
    })
    .parse(event.payload.session_io);
  assert.equal(
    persistedSource.request.client_metadata.value.source.value.body.value,
    input.body,
  );
  assert.deepEqual(
    await bridge.platformMessageSource(
      { projectId, conversationId: projectId },
      localAccess,
      inputId,
      inputId,
    ),
    {
      id: inputId,
      inputId,
      projectId,
      conversationId: projectId,
      createdAt: input.createdAt,
      text: input.body,
    },
  );
  // A new machine has its own Host directory, not a missing identity database
  // beside another machine's existing Platform/application authority files.
  secondWorkspace = new WorkspaceStore(
    join(root, "second-host", "workspace.sqlite"),
    { mode: "transport", tenantId },
  );
  const secondIdentity = new IdentityCenter(secondWorkspace, {
    version: 1,
    members: [localAccess, otherAccess].map((access) => ({
      ...access,
      loginTokenHash: createHash("sha256")
        .update(randomBytes(32))
        .digest("hex"),
      enabled: true,
    })),
  });
  secondBridge = connect(secondWorkspace, secondIdentity);
  phase = "second Host read";
  const secondState = secondWorkspace.runtimeState() as {
    deliveries?: unknown[];
  } | null;
  assert.equal(
    secondState?.deliveries?.length ?? 0,
    0,
    "another Host must not copy the sender's private delivery queue",
  );
  assert.deepEqual(
    await secondBridge.platformMessageSource(
      { projectId, conversationId: projectId },
      localAccess,
      inputId,
      inputId,
    ),
    {
      id: inputId,
      inputId,
      projectId,
      conversationId: projectId,
      createdAt: input.createdAt,
      text: input.body,
    },
    "another Host must reconstruct the source from the authorized Runtime root",
  );
  const secondHostHistory = await secondBridge.platformConversationHistory(
    { projectId, conversationId: projectId },
    localAccess,
  );
  assert.deepEqual(
    secondHostHistory.inputs.map((item) => ({ id: item.id, body: item.body })),
    [{ id: inputId, body: input.body }],
    "a second Host reads accepted conversation history from Runtime without the sender's outbox",
  );
  const secondHostHead = await secondBridge.platformConversationHead(
    { projectId, conversationId: projectId },
    localAccess,
  );
  assert.equal(
    await secondBridge.platformMessageSource(
      { projectId, conversationId: projectId },
      localAccess,
      randomUUID(),
      randomUUID(),
    ),
    null,
  );
  const otherResponse = await fetch(
    `${runtimeURL}/api/sessions/${delivery.sessionId}/events/${delivery.rootId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(otherAccess.principalId),
      },
    },
  );
  assert.equal(
    otherResponse.status,
    403,
    "another Human cannot read this Session",
  );
  const attachmentBytes = Buffer.from("# 阅读摘录\n实际附件字节。\n", "utf8");
  const attachment = await messageAttachments.upload(
    human,
    "摘录.md",
    attachmentBytes,
  );
  const attachmentInputId = randomUUID();
  const attachmentInput: RecordedInput = {
    ...input,
    id: attachmentInputId,
    body: "请阅读附件",
    attachments: [{ ...attachment, name: "摘录.md" }],
  };
  await bridge.as(localAccess, () =>
    bridge!.enqueuePlatformInput(attachmentInput),
  );
  await bridge.tick();
  phase = "read accepted attachment";
  const attachedState = workspace.runtimeState() as typeof state;
  const attachedDelivery = attachedState.deliveries.find(
    (value) => value.inputId === attachmentInputId,
  );
  assert.ok(
    attachedDelivery?.rootId,
    `Runtime must accept the attached input: ${JSON.stringify(attachedDelivery)}`,
  );
  const attachedEventResponse = await fetch(
    `${runtimeURL}/api/sessions/${attachedDelivery.sessionId}/events/${attachedDelivery.rootId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(localAccess.principalId),
      },
    },
  );
  assert.equal(attachedEventResponse.status, 200);
  const attachedEvent = (await attachedEventResponse.json()) as {
    event: {
      topic: string;
      payload: {
        client_message_id: string;
        attachments: Array<{ sha256: string }>;
        session_io: {
          binding: { resources: Array<{ resource_id: string }> };
        };
      };
    };
  };
  assert.equal(attachedEvent.event.topic, "chat/user_message");
  assert.equal(
    attachedEvent.event.payload.client_message_id,
    attachmentInputId,
  );
  assert.equal(
    attachedEvent.event.payload.attachments[0]?.sha256,
    createHash("sha256").update(attachmentBytes).digest("hex"),
  );
  const resourceId =
    attachedEvent.event.payload.session_io.binding.resources[0]?.resource_id;
  assert.ok(resourceId, "Runtime must bind the uploaded resource");
  const resourceResponse = await fetch(
    `${runtimeURL}/api/sessions/${attachedDelivery.sessionId}/io/resources/${resourceId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(localAccess.principalId),
      },
    },
  );
  assert.equal(resourceResponse.status, 200);
  assert.deepEqual(
    Buffer.from(await resourceResponse.arrayBuffer()),
    attachmentBytes,
  );
  assert.deepEqual(
    (
      await secondBridge.platformAcceptedAttachment(
        { projectId, conversationId: projectId },
        localAccess,
        attachmentInputId,
        attachment.assetId,
      )
    )?.bytes,
    attachmentBytes,
    "a second Host reads accepted bytes from the real Runtime, not the sender's private Store",
  );
  assert.equal(
    await secondBridge.platformAcceptedAttachment(
      { projectId, conversationId: projectId },
      localAccess,
      attachmentInputId,
      "0".repeat(64),
    ),
    null,
    "the accepted root must carry the exact requested asset",
  );
  const updatedHead = await secondBridge.platformConversationHead(
    { projectId, conversationId: projectId },
    localAccess,
  );
  assert.equal(updatedHead.sessionId, secondHostHead.sessionId);
  assert.ok(
    updatedHead.latestSequence > secondHostHead.latestSequence,
    "another Host's accepted input must change the selected conversation's Runtime head",
  );
  const updatedSecondHostHistory =
    await secondBridge.platformConversationHistory(
      { projectId, conversationId: projectId },
      localAccess,
    );
  assert.deepEqual(
    updatedSecondHostHistory.inputs.map((item) => item.id),
    [inputId, attachmentInputId],
    "another Host reads the new input without copying the sender's queue",
  );
  const otherResourceResponse = await fetch(
    `${runtimeURL}/api/sessions/${attachedDelivery.sessionId}/io/resources/${resourceId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(otherAccess.principalId),
      },
    },
  );
  assert.equal(otherResourceResponse.status, 403);
  const otherAttachmentResponse = await fetch(
    `${runtimeURL}/api/sessions/${attachedDelivery.sessionId}/events/${attachedDelivery.rootId}/attachments/attachment_${createHash("sha256").update(attachmentBytes).digest("hex")}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": bridge.principalId(otherAccess.principalId),
      },
    },
  );
  assert.equal(otherAttachmentResponse.status, 403);
  phase = "quote actual assistant publication";
  const scope = { projectId, conversationId: projectId };
  let assistantHistory = await secondBridge.platformConversationHistory(
    scope,
    localAccess,
  );
  const assistantDeadline = Date.now() + 20_000;
  while (
    !assistantHistory.runtime.messages.some(
      (message) =>
        message.inputId === inputId && message.text === assistantText,
    ) &&
    Date.now() < assistantDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assistantHistory = await secondBridge.platformConversationHistory(
      scope,
      localAccess,
    );
  }
  const assistant = assistantHistory.runtime.messages.find(
    (message) => message.inputId === inputId && message.text === assistantText,
  );
  assert.ok(
    assistant,
    `real Runtime must persist the fixture assistant's Chinese Markdown reply: ${JSON.stringify({ providerCalls, messages: assistantHistory.runtime.messages })}`,
  );
  const exactSource = await secondBridge.platformMessageSource(
    scope,
    localAccess,
    assistant.id,
    inputId,
  );
  assert.ok(exactSource);
  assert.equal(exactSource.text, assistantText);
  assert.equal(
    sameIsoTimeMicros(exactSource.createdAt, assistant.createdAt),
    true,
  );
  const quote = {
    id: randomUUID(),
    text: selectedText,
    comment: "请解释这句",
    source: {
      kind: "message" as const,
      ...scope,
      messageId: assistant.id,
      inputId,
      title: "Morphz",
      createdAt: assistant.createdAt,
    },
  };
  const quoteInputId = randomUUID();
  const quoteCommand = {
    commandId: quoteInputId,
    operation: {
      type: "record-input" as const,
      projectId,
      conversationId: projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "继续讨论",
      targetActantId: "morphz-agent",
      textQuotes: [quote],
    },
  };
  const app = new Application(secondWorkspace, {
    runtime: secondBridge,
    identity: secondIdentity,
  }).session(localAccess);
  for (const wrongQuote of [
    { ...quote, text: selectedText.replace("上午 9 点", "上午 8 点") },
    {
      ...quote,
      source: { ...quote.source, messageId: "publication:unknown-attempt" },
    },
    { ...quote, source: { ...quote.source, inputId: randomUUID() } },
    {
      ...quote,
      source: {
        ...quote.source,
        createdAt: isoTimeAtMicros(isoTimeMicros(assistant.createdAt)! + 1)!,
      },
    },
  ])
    await assert.rejects(
      app.platformMessage({
        ...quoteCommand,
        operation: { ...quoteCommand.operation, textQuotes: [wrongQuote] },
      }),
      /引用的原消息已不可用/,
    );
  await app.platformMessage(quoteCommand);
  await secondBridge.tick();
  let quotedSource = await bridge.platformMessageSource(
    scope,
    localAccess,
    quoteInputId,
    quoteInputId,
  );
  const quoteDeadline = Date.now() + 10_000;
  while (!quotedSource && Date.now() < quoteDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    quotedSource = await bridge.platformMessageSource(
      scope,
      localAccess,
      quoteInputId,
      quoteInputId,
    );
  }
  assert.ok(
    quotedSource,
    "the sending Host must see the other Host's newly accepted quote through real Runtime",
  );
  assert.equal(quotedSource.text, "继续讨论");
  const quotedHistory = await bridge.platformConversationHistory(
    scope,
    localAccess,
  );
  assert.deepEqual(
    quotedHistory.inputs.find((item) => item.id === quoteInputId)?.textQuotes,
    [quote],
  );
  const latestQuotePage = await secondBridge.platformConversationHistory(
    scope,
    localAccess,
    { limit: 1 },
  );
  assert.ok(latestQuotePage.nextCursor);
  const priorQuotePage = await secondBridge.platformConversationHistory(
    scope,
    localAccess,
    { limit: 1, before: latestQuotePage.nextCursor },
  );
  const priorEntry =
    priorQuotePage.inputs[0] ?? priorQuotePage.runtime.messages[0];
  assert.ok(priorEntry);
  const priorMicros = isoTimeMicros(priorEntry.createdAt)!;
  const latestMicros = isoTimeMicros(latestQuotePage.nextCursor.createdAt)!;
  assert.ok(
    priorMicros < latestMicros ||
      (priorMicros === latestMicros &&
        priorEntry.id < latestQuotePage.nextCursor.id),
    "the microsecond and entry-ID cursor must advance to an earlier timeline item",
  );
  console.log(
    `PASS: ${postgresURL ? "PostgreSQL" : "SQLite"} actual assistant quote accepted with 61-character Markdown / 53-character visible text; altered text, message, root and 1µs timestamp rejected.`,
  );
  const runtimePrincipalId = bridge.principalId(localAccess.principalId);
  const scheduleId = `backup-schedule-${randomUUID()}`;
  let futureSchedule: unknown;
  if (backupFixture) {
    phase = "prepare quiescent native backup sample";
    const quoteDelivery = (
      secondWorkspace.runtimeState() as typeof state
    ).deliveries.find((value) => value.inputId === quoteInputId);
    assert.ok(quoteDelivery?.rootId);
    // Completed fixture turns must not be inferred again during restoration.
    // The future Schedule separately exercises durable, not-yet-fired state.
    for (const value of [delivery, attachedDelivery, quoteDelivery]) {
      const deadline = Date.now() + 30_000;
      let lifecycle: string | undefined;
      do {
        const response = await fetch(
          `${runtimeURL}/api/sessions/${value.sessionId}/turns/${value.rootId}/thread`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Morphz-Principal": runtimePrincipalId,
            },
            signal: AbortSignal.timeout(3_000),
          },
        );
        assert.equal(response.status, 200);
        lifecycle = ((await response.json()) as { lifecycle: string })
          .lifecycle;
        if (lifecycle === "open")
          await new Promise((resolve) => setTimeout(resolve, 50));
      } while (lifecycle === "open" && Date.now() < deadline);
      assert.equal(
        lifecycle,
        "completed",
        "backup sample must contain completed, non-replayed fixture turns",
      );
    }
    const response = await fetch(
      `${runtimeURL}/api/sessions/${delivery.sessionId}/schedules`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Morphz-Principal": runtimePrincipalId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: scheduleId,
          intent: "隔离备份验收的未来任务，不执行物理操作",
          model_alias: "test-model",
          not_before: "2100-01-01T00:00:00Z",
          interval_seconds: null,
          dependency_thread_ids: [],
        }),
      },
    );
    assert.equal(response.status, 200);
    futureSchedule = await response.json();
  }
  await bridge.stop();
  bridge = undefined;
  await stopRuntime();
  const providerCallsAtBackup = providerCalls;
  if (backupFixture) {
    phase = "independent Runtime native backup restore";
    await backupFixture.restoreFromNativeBackup(hostTools.path);
  }
  await startRuntime();
  phase = "read after Runtime restart";
  const persistedResponse = await fetch(
    `${runtimeURL}/api/sessions/${delivery.sessionId}/events/${delivery.rootId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Morphz-Principal": runtimePrincipalId,
      },
    },
  );
  assert.equal(persistedResponse.status, 200);
  const persistedEvent = (await persistedResponse.json()) as {
    event: { payload: Record<string, unknown> };
  };
  assert.deepEqual(
    persistedEvent.event.payload.session_io,
    event.payload.session_io,
  );
  bridge = connect();
  await bridge.as(localAccess, () => bridge!.enqueuePlatformInput(input));
  await bridge.as(localAccess, () =>
    bridge!.enqueuePlatformInput(attachmentInput),
  );
  await bridge.tick();
  const after = workspace.runtimeState() as typeof state;
  assert.equal(
    after.deliveries.filter((value) => value.inputId === inputId).length,
    1,
  );
  assert.equal(
    after.deliveries.find((value) => value.inputId === inputId)?.rootId,
    delivery.rootId,
  );
  assert.equal(
    (
      await bridge.platformMessageSource(
        { projectId, conversationId: projectId },
        localAccess,
        inputId,
        inputId,
      )
    )?.text,
    input.body,
  );
  assert.equal(
    after.deliveries.filter((value) => value.inputId === attachmentInputId)
      .length,
    1,
  );
  assert.equal(
    after.deliveries.find((value) => value.inputId === attachmentInputId)
      ?.rootId,
    attachedDelivery.rootId,
  );
  assert.deepEqual(
    (
      await secondBridge.platformAcceptedAttachment(
        { projectId, conversationId: projectId },
        localAccess,
        attachmentInputId,
        attachment.assetId,
      )
    )?.bytes,
    attachmentBytes,
    "cross-Host attachment retrieval remains valid after Runtime restart",
  );
  assert.deepEqual(
    (
      await secondBridge.platformConversationHistory(scope, localAccess)
    ).inputs.find((item) => item.id === quoteInputId)?.textQuotes,
    [quote],
    "the assistant quote retains exact provenance after Runtime restart",
  );
  console.log(
    "PASS: Platform input is durable; another Host resolves the authorized Runtime root without copying its queue; restart retry is idempotent.",
  );
  if (backupFixture) {
    const scheduleResponse = await fetch(
      `${runtimeURL}/api/sessions/${delivery.sessionId}/schedules/${scheduleId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Morphz-Principal": runtimePrincipalId,
        },
      },
    );
    assert.equal(scheduleResponse.status, 200);
    assert.deepEqual(
      await scheduleResponse.json(),
      futureSchedule,
      "not-yet-fired Schedule identity, intent and state survive independent restore",
    );
    for (const path of [
      `/api/sessions/${delivery.sessionId}/events/${delivery.rootId}`,
      `/api/sessions/${attachedDelivery.sessionId}/io/resources/${resourceId}`,
      `/api/sessions/${delivery.sessionId}/schedules/${scheduleId}`,
    ]) {
      const response: Response = await fetch(`${runtimeURL}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Morphz-Principal": bridge.principalId(otherAccess.principalId),
        },
      });
      assert.equal(
        response.status,
        403,
        "restored Runtime must retain the actual identity authorization boundary",
      );
    }
    assert.equal(
      providerCalls,
      providerCallsAtBackup,
      "restoration and same-ID retries must not replay completed model turns",
    );
    console.log(
      JSON.stringify({
        type: "runtime_restore_http_acceptance",
        backend: postgresURL ? "postgres" : "sqlite",
        futureScheduleId: scheduleId,
        futureScheduleNotBefore: "2100-01-01T00:00:00Z",
        futureScheduleExactStateRetained: true,
        restoredForeignIdentityRefusals: 3,
        completedSourceTurns: 3,
        providerCallsAtBackup,
        providerCallsAfterRestore: providerCalls,
        originalStrictQuoteAttachmentCrossHostIdempotencyAssertionsRetained: true,
      }),
    );
  }
  backupFixture?.assertVerified();
} catch (error) {
  console.error(`Runtime smoke failed during ${phase}. ${runtimeStderr}`);
  throw error;
} finally {
  await secondBridge?.stop();
  await bridge?.stop();
  await stopRuntime();
  await platform?.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await messageAttachments?.close();
  workspace?.close();
  secondWorkspace?.close();
  await backupFixture?.close();
  rmSync(root, { recursive: true, force: true });
}
