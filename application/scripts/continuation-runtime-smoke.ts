/** Real Runtime + embedded IPC host. Synthetic gated model, isolated data, no live user work. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
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
import type { Receipt } from "../packages/core/src/model.js";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary));
const directory = mkdtempSync(join(tmpdir(), "morphz-continuation-")),
  runtimeDirectory = join(directory, "runtime"),
  workDirectory = join(directory, "application");
mkdirSync(runtimeDirectory, { mode: 0o700 });
mkdirSync(workDirectory, { mode: 0o700 });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
let blocked = true,
  providerCalls = 0;
const release: (() => void)[] = [],
  prompts: string[] = [];
const provider = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString()),
    text = JSON.stringify(body.messages);
  prompts.push(text);
  providerCalls++;
  if (blocked) await new Promise<void>((r) => release.push(r));
  if (res.destroyed) return;
  const message = {
    role: "assistant",
    content: text.includes("TEST_SUPPLEMENT_A_ONLY")
      ? "报告 A 已采用补充要求。"
      : "原任务已完成。",
  };
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: message, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: randomUUID(),
        choices: [{ index: 0, message, finish_reason: "stop" }],
      }),
    );
  }
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port,
  probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const runtimePort = (probe.address() as { port: number }).port;
await new Promise<void>((r) => probe.close(() => r()));
const token = randomBytes(32).toString("hex"),
  namespace = randomUUID(),
  configFile = join(runtimeDirectory, "morphz.toml");
writeFileSync(
  join(workDirectory, "runtime.json"),
  JSON.stringify({ url: `http://127.0.0.1:${runtimePort}`, token, namespace }),
  { mode: 0o600 },
);
writeFileSync(
  configFile,
  `[llm]\nprovider="stub"\nmodel="test-model"\nreasoning_effort="low"\n[providers.stub]\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\ncredential="stub"\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
  { mode: 0o600 },
);
process.env.MORPHZ_APP_ENV_FILE = "";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (!response.ok && String(args[0]).endsWith("/io/messages"))
    console.error(
      "Isolated message rejection:",
      response.status,
      await response.clone().text(),
    );
  return response;
};
let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined,
  runtime: ChildProcessWithoutNullStreams | undefined,
  logs = "",
  passed = false;
const wait = async (check: () => boolean | Promise<boolean>, label: string) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await check()) return;
    if (runtime?.exitCode !== null) throw new Error("Runtime exited: " + label);
    await delay(120);
  }
  throw new Error("Timed out: " + label);
};
let socketDirectory: string | undefined;
try {
  host = await openEmbeddedApplication(
    workDirectory,
    join(directory, "profile"),
  );
  const manifest = JSON.parse(readFileSync(host.manifestPath!, "utf8"));
  socketDirectory = dirname(manifest.tools[0].ipc_path);
  assert.ok(manifest.tools[0].ipc_path);
  assert.ok(!manifest.tools[0].endpoint);
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
        MORPHZ_DASHBOARD_TOKEN: token,
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
  const bridge = host.connection.application.options.runtime!,
    store = host.connection.application.store;
  await wait(() => bridge.snapshot().connected, "connection");
  let boot = (await host.connection.call("workspace")) as any;
  const message = async (command: unknown) =>
    host!.connection.call("message", command, {
      identityGeneration: boot.csrfToken,
    }) as Promise<Receipt>;
  const ordinary = (body: string) => ({
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: "first-project",
      conversationId: "local-dialogue",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body,
      targetActantId: "morphz-agent",
    },
  });
  const a = await message(ordinary("TEST_DIRECTED_A：整理报告 A。")),
    b = await message(ordinary("TEST_DIRECTED_B：整理资料 B。"));
  await wait(() => providerCalls >= 2, "two parallel model calls");
  await wait(
    () =>
      !!bridge
        .snapshot()
        .activity?.threads.find((t) => t.inputId === a.entityId)?.continuation,
    "target binding",
  );
  const target = bridge
    .snapshot()
    .activity!.threads.find((t) => t.inputId === a.entityId)!.continuation!;
  const command = {
    ...ordinary("TEST_SUPPLEMENT_A_ONLY：报告 A 使用人民币，资料 B 不变。"),
    operation: {
      ...ordinary("TEST_SUPPLEMENT_A_ONLY：报告 A 使用人民币，资料 B 不变。")
        .operation,
      continuation: target,
    },
  };
  const receipt = await message(command);
  assert.equal(
    bridge.snapshot().deliveries.find((d) => d.inputId === receipt.entityId)!
      .supplement,
    "delivered",
  );
  assert.equal(
    bridge.snapshot().deliveries.find((d) => d.inputId === b.entityId)!.state,
    "running",
  );
  blocked = false;
  for (const r of release.splice(0)) r();
  await wait(
    () =>
      bridge
        .snapshot()
        .messages.some(
          (m) =>
            m.inputId === a.entityId &&
            m.kind === "reply" &&
            m.text.includes("采用补充"),
        ),
    "original root adopts supplement",
  );
  await wait(
    () =>
      bridge
        .snapshot()
        .messages.some((m) => m.inputId === b.entityId && m.kind === "reply"),
    "parallel original reply",
  );
  assert.ok(
    bridge
      .snapshot()
      .messages.filter((m) => m.inputId === b.entityId)
      .every((m) => !m.text.includes("采用补充")),
    "B must not adopt A's directed input",
  );
  assert.ok(
    bridge.snapshot().messages.every((m) => m.inputId !== receipt.entityId),
    "Supplement receipt is not a new response root",
  );
  const ledger = store.runtimeState() as any,
    supplemental = ledger.deliveries.find(
      (d: any) => d.inputId === receipt.entityId,
    );
  assert.equal(supplemental.rootId, null);
  assert.ok(supplemental.acceptedEventId);
  const before = providerCalls,
    center = store.identity();
  await host.close();
  host = await openEmbeddedApplication(
    workDirectory,
    join(directory, "profile"),
  );
  boot = await host.connection.call("workspace");
  assert.equal(host.connection.application.store.identity(), center);
  assert.deepEqual(await message(command), receipt);
  await delay(2200);
  assert.equal(providerCalls, before);
  passed = true;
  console.log(
    "PASS: real Runtime + embedded IPC: two parallel roots, explicit supplement adopted only by A, B unchanged, original reply attribution, no new supplement execution, reopen retry does not replay. Synthetic provider; isolated data.",
  );
} catch (e) {
  console.error(logs.split(token).join("[redacted]"));
  console.error("Retained isolated evidence:", directory);
  throw e;
} finally {
  globalThis.fetch = originalFetch;
  blocked = false;
  for (const r of release.splice(0)) r();
  await host?.close();
  if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
    const end = new Promise<void>((r) => runtime!.once("exit", () => r()));
    runtime.kill("SIGTERM");
    await Promise.race([end, delay(10000)]);
  }
  provider.closeAllConnections();
  await new Promise<void>((r) => provider.close(() => r()));
  if (passed) {
    rmSync(directory, { recursive: true });
    if (socketDirectory)
      rmSync(socketDirectory, { recursive: true, force: true });
  }
}
