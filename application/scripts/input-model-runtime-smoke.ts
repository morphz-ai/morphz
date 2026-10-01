/** Prove Host admission and real Runtime Thread model bindings in isolation.
 * The only configured provider is unreachable local port 9; no paid provider
 * is contacted and no user's inputs, profile or Runtime process is touched.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { prepareHostTools } from "../packages/application/src/agent-tools.js";
import { platformRuntimeHostFixture } from "../tests/platform-runtime-host-fixture.js";

const binary = runtimeBinaryPath();
assert.ok(
  existsSync(binary),
  "Build Morphz Runtime before this isolated check.",
);
const directory = mkdtempSync(join(tmpdir(), "morphz-input-model-runtime-"));
const runtimeDirectory = join(directory, "runtime");
const token = randomBytes(32).toString("hex");
const namespace = randomUUID();
const configFile = join(directory, "morphz.toml");
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const url = `http://127.0.0.1:${port}`;
const hostTools = prepareHostTools(directory, port, namespace, true);
let child: ChildProcess | undefined;
let fixture: Awaited<ReturnType<typeof platformRuntimeHostFixture>> | undefined;
let stderr = "";
let phase = "start";

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(url + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const value = await response.json();
  assert.ok(response.ok, `Runtime HTTP ${response.status} during ${phase}`);
  return value;
}
async function setDefault(model: string) {
  await request("/api/runtime/inference", "PUT", { model });
  assert.equal((await request("/api/status")).model, model);
}
type Delivery = {
  inputId: string;
  sessionId: string;
  rootId: string | null;
  state: string;
  error: string | null;
  request: { activation: { model_alias?: string } };
};
function delivery(inputId: string) {
  return (
    fixture!.store.runtimeState() as { deliveries: Delivery[] }
  ).deliveries.find((item) => item.inputId === inputId)!;
}
async function threadModel(inputId: string, expected: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await fixture!.runtime.tick();
    const item = delivery(inputId);
    if (item.rootId) {
      const turn = await request(
        `/api/sessions/${item.sessionId}/turns/${item.rootId}/thread`,
      );
      const detail = await request(
        `/api/contexts/mw-context-${namespace}/threads/${turn.thread_id}`,
      );
      assert.equal(detail.snapshot.thread.model_alias, expected);
      const root = await request(
        `/api/sessions/${item.sessionId}/events/${item.rootId}`,
      );
      assert.equal(
        root.event.payload.session_io.request.activation.model_alias,
        expected,
      );
      return {
        sessionId: item.sessionId,
        rootId: item.rootId,
        threadId: turn.thread_id,
        model: expected,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const item = delivery(inputId);
  throw new Error(
    `Runtime did not bind the isolated input during ${phase}: ${item.state}, ${item.error}`,
  );
}

try {
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  writeFileSync(
    configFile,
    `
[llm]
model="astra"
[accounts.stub]
auth_adapter="credential"
credential_ref="stub"
provider="stub"
[services.stub]
adapter="protocol-compatible"
protocol="openai-chat"
base_url="http://127.0.0.1:9/v1"
accounts=["stub"]
[[models.astra.targets]]
service="stub"
account="stub"
physical_model="synthetic-astra"
capabilities=["tools"]
[[models.sol.targets]]
service="stub"
account="stub"
physical_model="synthetic-sol"
capabilities=["tools"]
[credentials.stub]
source="env"
name="MORPHZ_INPUT_MODEL_SMOKE_KEY"
[permissions]
workspace_root=${JSON.stringify(directory)}
`,
    { mode: 0o600 },
  );
  child = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${port}`,
      "--cwd",
      directory,
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
        MORPHZ_DASHBOARD_TOKEN: token,
        MORPHZ_HOST_TOOLS_FILE: hostTools.path,
        MORPHZ_INPUT_MODEL_SMOKE_KEY: "synthetic-unused",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if (
        (await fetch(url + "/health", { signal: AbortSignal.timeout(1000) })).ok
      )
        break;
    } catch {}
    assert.ok(
      child.exitCode === null,
      "Isolated Runtime exited before readiness.",
    );
    assert.ok(Date.now() < deadline, "Isolated Runtime readiness timed out.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fixture = await platformRuntimeHostFixture({ url, token, namespace });
  const command = (model?: string) => ({
    commandId: randomUUID(),
    operation: {
      type: "record-input" as const,
      projectId: fixture!.projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "隔离模型接线验证",
      targetActantId: "morphz-agent",
      ...(model ? { model } : {}),
    },
  });
  phase = "original Session model";
  const first = command();
  await fixture.session().platformMessage(first);
  await fixture.enableDispatch();
  const original = await threadModel(first.commandId, "astra");
  await request(`/api/sessions/${original.sessionId}`, "PATCH", {
    model_alias: "astra",
  });
  assert.equal(
    (await request(`/api/sessions/${original.sessionId}`)).model_alias,
    "astra",
  );

  phase = "freeze changed default before delayed dispatch";
  await setDefault("sol");
  await fixture.reopen();
  const changed = command();
  await fixture.session().platformMessage(changed);
  const frozen = structuredClone(delivery(changed.commandId).request);
  assert.equal(frozen.activation.model_alias, "sol");
  await setDefault("astra");
  await fixture.session().platformMessage(changed);
  assert.deepEqual(delivery(changed.commandId).request, frozen);
  await fixture.reopen(false);
  const afterChange = await threadModel(changed.commandId, "sol");
  assert.equal(afterChange.sessionId, original.sessionId);

  phase = "next new input reads latest default";
  const latest = command();
  await fixture.session().platformMessage(latest);
  const afterLatest = await threadModel(latest.commandId, "astra");
  assert.equal(afterLatest.sessionId, original.sessionId);
  phase = "explicit override";
  const explicit = command("sol");
  await fixture.session().platformMessage(explicit);
  const overridden = await threadModel(explicit.commandId, "sol");
  assert.equal(overridden.sessionId, original.sessionId);
  phase = "accepted original command retry";
  await fixture.session().platformMessage(changed);
  assert.deepEqual(delivery(changed.commandId).request, frozen);
  assert.equal(delivery(changed.commandId).rootId, afterChange.rootId);
  fixture.assertNoLegacyData();
  console.log(
    JSON.stringify({
      checks: "real Runtime accepted requests and Thread model bindings",
      sameSession: true,
      original: original.model,
      changedDefaultFrozenAcrossRetryAndReopen: afterChange.model,
      latestDefault: afterLatest.model,
      explicitOverride: overridden.model,
      provider: "unreachable local synthetic endpoint",
    }),
  );
} catch (error) {
  console.error(
    `Isolated model check failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (stderr) console.error(stderr);
  throw error;
} finally {
  await fixture?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      child!.once("exit", () => resolve());
      child!.kill("SIGTERM");
    });
  }
  rmSync(directory, { recursive: true, force: true });
}
