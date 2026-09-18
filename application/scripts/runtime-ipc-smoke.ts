/** Real Runtime + embedded application + Unix callback; synthetic provider and fresh databases only. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { localAccess, type Receipt } from "../packages/core/src/model.js";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "Build the compatible Runtime binary first.");
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
    const message = call
      ? { role: "assistant", content: "", tool_calls: [call] }
      : { role: "assistant", content: "已保存联合验收交付。" };
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
  `[llm]\nprovider="stub"\nmodel="test-model"\nreasoning_effort="low"\n[providers.stub]\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\ncredential="stub"\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
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
        MORPHZ_EXPERIMENTAL_FEATURES: "session-io",
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
    () => host!.connection.application.options.runtime!.snapshot().connected,
    "Runtime connection",
  );
  const boot = (await host.connection.call("workspace")) as any;
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "请创建 IPC 联合验收交付文档，仅使用工作区对象工具。",
      targetActantId: "morphz-agent",
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
      throw new Error(delivery.error ?? "delivery failed");
    return delivery?.state === "completed";
  }, "IPC object delivery");
  const store = host.connection.application.store;
  const artifact = store
    .snapshot()
    .artifacts.find((a) => a.title === "IPC 联合验收交付");
  assert.ok(
    artifact,
    "The actual Runtime physical tool must persist the object",
  );
  assert.equal(artifact.createdBy.actantId, "morphz-agent");
  assert.equal(artifact.projectId, "first-project");
  assert.ok(
    store
      .artifactOutputs(localAccess)
      .some(
        (output) =>
          output.artifactId === artifact.id &&
          output.inputId === receipt.entityId,
      ),
    "Delivery must carry the actual input provenance",
  );
  const count = providerCalls,
    centerId = store.identity();
  await host.close();
  host = await openEmbeddedApplication(
    workDirectory,
    join(directory, "profile"),
  );
  const reopened = (await host.connection.call("workspace")) as any;
  assert.equal(reopened.centerId, centerId);
  assert.deepEqual(
    await host.connection.call("message", command, {
      identityGeneration: reopened.csrfToken,
    }),
    receipt,
  );
  await delay(2500);
  assert.equal(
    providerCalls,
    count,
    "Reopening and retrying the same command must not replay accepted input",
  );
  assert.equal(
    host.connection.application.store
      .snapshot()
      .artifacts.filter((a) => a.id === artifact.id).length,
    1,
  );
  passed = true;
  console.log(
    "PASS: real Runtime physical tool → private Unix callback → Agent-authored SQLite object + exact input receipt; embedded-host reopen and command retry preserve data without model replay. No application TCP listener.",
  );
} catch (error) {
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
