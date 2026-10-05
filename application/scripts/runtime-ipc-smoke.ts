/** Real Runtime + embedded application + Unix callback; synthetic provider and fresh databases only. */
import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
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
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import type { Receipt } from "../packages/core/src/model.js";
import {
  readingReference,
  type ReadingSection,
} from "../packages/core/src/reader.js";
import { readingInputFormat } from "../packages/application/src/session-io.js";
import { runtimeFixtureFinalReply } from "./runtime-fixture-reply.js";
import { retainFixtureFailure } from "./runtime-fixture-evidence.js";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "Build the compatible Runtime binary first.");
const binaryVersion = execFileSync(binary, ["--version"], {
  encoding: "utf8",
  timeout: 10000,
}).trim();
const directory = mkdtempSync(join(tmpdir(), "morphz-runtime-ipc-"));
const runtimeDirectory = join(directory, "runtime"),
  workDirectory = join(directory, "application");
mkdirSync(runtimeDirectory, { mode: 0o700 });
mkdirSync(workDirectory, { mode: 0o700 });
let providerCalls = 0;
const provider = createServer(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(
      input.tools?.some((tool: any) => tool.function?.name === "host_morphz"),
    );
    const call =
      providerCalls++ === 0
        ? {
            id: "ipc-create-document",
            type: "function",
            function: {
              name: "host_morphz",
              arguments: JSON.stringify({
                action: "create-document",
                title: "IPC 联合验收交付",
                markdown: "由真实 Runtime 执行，经本地进程通信写入 SQLite。",
              }),
            },
          }
        : null;
    const final = runtimeFixtureFinalReply(input, {
      content: "已保存联合验收交付。",
      title: "保存 IPC 联合验收交付",
      result: "联合验收交付文档已保存。",
    });
    const message = call
      ? { role: "assistant", content: "", tool_calls: [call] }
      : final.message;
    const finishReason = call ? "tool_calls" : final.finishReason;
    if (input.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index })) } : {}) }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: randomUUID(),
          choices: [{ index: 0, message, finish_reason: finishReason }],
        }),
      );
    }
  } catch (error) {
    res.writeHead(500);
    res.end("Fixture provider rejected request");
    console.error(error);
  }
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port;
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const runtimePort = (probe.address() as { port: number }).port;
await new Promise<void>((r) => probe.close(() => r()));
const runtimeToken = randomBytes(32).toString("hex"),
  namespace = randomUUID();
writeFileSync(
  join(workDirectory, "runtime.json"),
  JSON.stringify({
    url: `http://127.0.0.1:${runtimePort}`,
    token: runtimeToken,
    namespace,
  }),
  { mode: 0o600 },
);
const configFile = join(runtimeDirectory, "morphz.toml");
writeFileSync(
  configFile,
  `[llm]\nmodel="test-model"\nreasoning_effort="low"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
  { mode: 0o600 },
);
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args: any[]) {
  assert.equal(
    typeof args[0],
    "string",
    "The embedded application must not open a TCP server",
  );
  return originalListen.apply(this, args as Parameters<typeof originalListen>);
} as typeof originalListen;
process.env.MORPHZ_APP_ENV_FILE = "";
let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
let runtime: ChildProcessWithoutNullStreams | undefined;
let manifest: { tools: { token: string; ipc_path: string }[] } | undefined;
let logs = "",
  passed = false;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assertNoLegacyWorkspace = () => {
  const database = new DatabaseSync(join(workDirectory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace', 'commands', 'assets')",
        )
        .all(),
      [],
      "The real Host transport database must not create a workspace snapshot or file BLOB table",
    );
  } finally {
    database.close();
  }
};
const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  label: string,
) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await check()) return;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(`Runtime exited during ${label}`);
    await delay(120);
  }
  throw new Error(label + " timed out");
};
try {
  host = await openEmbeddedApplication(
    workDirectory,
    join(directory, "profile"),
  );
  assert.ok(host.manifestPath);
  manifest = JSON.parse(readFileSync(host.manifestPath, "utf8"));
  assert.ok(manifest!.tools[0]!.ipc_path);
  assert.ok(!JSON.stringify(manifest).includes('"endpoint"'));
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
        MORPHZ_DASHBOARD_TOKEN: runtimeToken,
        MORPHZ_HOST_TOOLS_FILE: host.manifestPath,
        MORPHZ_APP_TEST_KEY: "synthetic-fixture-key",
      },
      stdio: "pipe",
    },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream.on("data", (c) => {
      logs = (logs + c.toString()).slice(-12000);
    });
  await waitUntil(
    () => host!.connection.application.options.runtime!.isConnected,
    "Runtime connection",
  );
  const binding = await fetch(
    `http://127.0.0.1:${runtimePort}/api/agents/default-agent/provider-accounts/stub`,
    { method: "PUT", headers: { Authorization: `Bearer ${runtimeToken}` } },
  );
  assert.ok(binding.ok, "Bind only the isolated fixture's synthetic account");
  const capabilities = await fetch(
    `http://127.0.0.1:${runtimePort}/api/session-io/capabilities`,
    { headers: { Authorization: `Bearer ${runtimeToken}` } },
  ).then((response) => response.json());
  assert.equal(
    capabilities.experimental,
    false,
    "Session IO is a stable Runtime capability",
  );
  assert.equal(
    capabilities.enabled,
    true,
    "Default Runtime builds enable Session IO",
  );
  assert.ok(
    capabilities.formats.some(
      (format: any) =>
        format.definition.id === readingInputFormat.id &&
        format.definition.version === readingInputFormat.version,
    ),
    "The running Runtime, not merely the manifest on disk, must load reading v6",
  );
  let client = await PlatformClient.connect(host.connection);
  const { deskId: projectId, dialogueId: conversationId } =
    await client.ensurePersonalSpaces();
  const bookBytes = Buffer.from("# TEST 原文\n\n兼听则明，偏信则暗。\n");
  const imported = z
    .object({
      entityId: z.string(),
      bookId: z.string(),
      revision: z.literal(1),
    })
    .parse(
      await host.connection.call(
        "reader.import",
        {
          commandId: randomUUID(),
          projectId,
          relativePath: "TEST 伴读.md",
          data: bookBytes,
        },
        { identityGeneration: client.boot.csrfToken },
      ),
    );
  const book = z
    .object({
      bookId: z.string(),
      sections: z.array(z.object({ id: z.string() })).length(1),
    })
    .parse(await client.readReaderBook(imported.entityId, 1));
  assert.equal(book.bookId, imported.bookId);
  const readSection = () =>
    host!.connection.call(
      "reader.read",
      {
        artifactId: imported.entityId,
        revision: 1,
        sectionId: book.sections[0]!.id,
      },
      { identityGeneration: client.boot.csrfToken },
    ) as Promise<ReadingSection>;
  const section = await readSection(),
    quoteStart = section.text.indexOf("兼听");
  assert.ok(quoteStart >= 0, "Reader must return the imported original");
  const reading = readingReference(section, {
    sourceId: section.sourceId,
    sectionId: section.id,
    start: quoteStart,
    end: quoteStart + "兼听则明，偏信则暗。".length,
  });
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId,
      conversationId,
      artifactId: imported.entityId,
      artifactRevision: 1,
      selection: reading.quote,
      reading,
      body: "请创建 IPC 联合验收交付文档，仅使用工作区对象工具。",
      targetActantId: "morphz-agent",
    },
  };
  const receipt = (await host.connection.call("platform.message", command, {
    identityGeneration: client.boot.csrfToken,
  })) as Receipt;
  await waitUntil(async () => {
    const history = await client.history(projectId, conversationId);
    const delivery = history.runtime.deliveries.find(
      (d) => d.inputId === receipt.entityId,
    );
    if (delivery?.state === "failed")
      throw new Error(delivery.error ?? "delivery failed");
    return delivery?.state === "completed";
  }, "IPC object delivery");
  const history = await client.history(projectId, conversationId);
  assert.deepEqual(
    history.inputs.find((input) => input.id === receipt.entityId)?.reading,
    reading,
    "Accepted Runtime history must retain the original book/version quote",
  );
  const artifact = (
    await client.content({ projectId, query: "IPC 联合验收交付", limit: 50 })
  ).items.find((a) => a.title === "IPC 联合验收交付");
  assert.ok(
    artifact,
    "The actual Runtime physical tool must persist the object",
  );
  const documentSchema = z.object({
    contentId: z.string(),
    projectId: z.string(),
    revision: z.literal(1),
    title: z.string(),
    markdown: z.string(),
    author: z.object({ principalId: z.string(), actantId: z.string() }),
  });
  const document = documentSchema.parse(
    await client.readDocument(artifact.id, 1),
  );
  assert.equal(document.author.actantId, "morphz-agent");
  assert.equal(document.projectId, projectId);
  assert.equal(
    document.markdown,
    "由真实 Runtime 执行，经本地进程通信写入 SQLite。",
  );
  assert.ok(
    (await client.contentDeliveries([receipt.entityId])).some(
      (output) =>
        output.contentId === artifact.id &&
        output.inputId === receipt.entityId &&
        output.sourceProjectId === projectId &&
        output.projectId === projectId &&
        output.versionRef === "1",
    ),
    "Delivery must carry the actual input provenance",
  );
  assertNoLegacyWorkspace();
  const count = providerCalls,
    centerId = client.boot.centerId;
  await host.close();
  host = await openEmbeddedApplication(
    workDirectory,
    join(directory, "profile"),
  );
  client = await PlatformClient.connect(host.connection);
  assert.equal(client.boot.centerId, centerId);
  await waitUntil(
    () => host!.connection.application.options.runtime!.isConnected,
    "Reopened Runtime connection",
  );
  assert.deepEqual(
    await host.connection.call("platform.message", command, {
      identityGeneration: client.boot.csrfToken,
    }),
    receipt,
  );
  await delay(2500);
  assert.equal(
    providerCalls,
    count,
    "Reopening and retrying the same command must not replay accepted input",
  );
  assert.equal((await client.contentByIds([artifact.id])).length, 1);
  assert.deepEqual(
    documentSchema.parse(await client.readDocument(artifact.id, 1)),
    document,
    "The exact Agent-authored application version must survive Host reopen",
  );
  assert.deepEqual(await readSection(), section);
  assertNoLegacyWorkspace();
  passed = true;
  console.log(
    "PASS: real Runtime reading v6 → Reader original + immutable quote → Platform input → private Unix callback → Objects version + exact Platform delivery receipt; Host reopen preserves originals and retry does not replay the model. No legacy workspace tables or application TCP listener.",
  );
} catch (error) {
  try {
    const cause = retainFixtureFailure({
      databasePath: join(runtimeDirectory, "runtime.sqlite"),
      directory:
        process.env.MORPHZ_TEST_EVIDENCE_DIRECTORY ??
        join(directory, "public-evidence"),
      logs,
      error,
      secrets: [
        runtimeToken,
        ...(manifest?.tools.map((tool) => tool.token) ?? []),
      ],
      metadata: {
        test: "runtime-ipc",
        nodeVersion: process.version,
        providerCalls,
        binaryVersion,
      },
    });
    if (cause) console.error("Runtime protocol failure:", cause);
  } catch (evidenceError) {
    console.error(
      "Could not export public fixture evidence; original failure preserved:",
      evidenceError,
    );
  }
  console.error(
    logs
      .split(runtimeToken)
      .join("[redacted]")
      .split(manifest?.tools[0]?.token ?? "absent-token")
      .join("[redacted]"),
  );
  console.error("Isolated failure evidence retained:", directory);
  throw error;
} finally {
  await host?.close();
  if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      runtime!.once("exit", () => resolve()),
    );
    runtime.kill("SIGTERM");
    await Promise.race([
      exited,
      delay(10000).then(() => {
        if (runtime!.exitCode === null && runtime!.signalCode === null)
          throw new Error(
            "Isolated Runtime did not stop; retained fixture for inspection",
          );
      }),
    ]);
  }
  provider.closeAllConnections();
  await new Promise<void>((r) => provider.close(() => r()));
  Server.prototype.listen = originalListen;
  if (passed) {
    rmSync(directory, { recursive: true });
    if (manifest)
      rmSync(dirname(manifest.tools[0]!.ipc_path), {
        recursive: true,
        force: true,
      });
  }
}
import "./application-configuration.mjs";
