/** Opt-in, same-machine baseline for the existing explicit Transfer API.
 * Real CLI Runtime + two authenticated Edge workers + physical file bytes;
 * no model request, Managed Store, GUI, original profile or user input.
 * Run: MORPHZ_TEST_POSTGRES_URL=... node --import tsx scripts/node-request-performance.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { runtimeBinaryPath } from "./runtime-path.mjs";

const binary = runtimeBinaryPath();
assert.ok(existsSync(binary), "Build Runtime before this opt-in baseline.");
const postgresURL = process.env.MORPHZ_TEST_POSTGRES_URL;
assert.ok(
  postgresURL,
  "Actual PostgreSQL is required; do not silently skip it.",
);
const warmupCount = 2;
const measuredCount = 20;
const byteLength = 64 * 1024;
const observationIntervalMs = 10;
const payload = Buffer.from(
  Array.from({ length: byteLength }, (_, i) => i % 251),
);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const sourceSha256 = sha256(payload);
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type Job = {
  id: string;
  thread_id: string;
  activation_id: string;
  session_id: string;
  target_id: string;
  initiating_principal_id: string;
  tool_name: string;
  status: string;
  result_event_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  request: {
    _morphz_artifact_transfer_routes: {
      source: { target_id: string; provider_node_id: string };
      destination: { target_id: string; provider_node_id: string };
    };
  };
  error?: string | null;
};
type Transfer = {
  transfer_id: string;
  source: { target_id: string; path: string };
  destination: { target_id: string; path: string };
  overwrite: "deny";
  expected_source_digest: string;
  media_type: string;
};
type Execution = {
  job: Job;
  thread: { id: string };
  activation: { id: string };
  request_event_sequence: number;
};
type Target = { id: string; provider_node_id: string; status: string };
type Sample = {
  admissionMs: number;
  e2eObservedMs: number;
  durableJobMs: number;
  durableRunningMs: number;
};

function instantNanoseconds(value: string) {
  const match = value.match(/^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
  assert.ok(match, "Runtime must supply UTC durable timestamps.");
  return (
    BigInt(Date.parse(match[1] + "Z")) * 1_000_000n +
    BigInt((match[2] ?? "").padEnd(9, "0"))
  );
}
function elapsedDurableMs(start: string, finish: string) {
  const elapsed = instantNanoseconds(finish) - instantNanoseconds(start);
  assert.ok(elapsed >= 0n, "Durable Job timestamps must be ordered.");
  return Number(elapsed) / 1_000_000;
}
function summarize(values: number[]) {
  assert.equal(values.length, measuredCount);
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (fraction: number) =>
    sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    n: values.length,
    minMs: sorted[0],
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    maxMs: sorted.at(-1),
  };
}
async function freePort() {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const deadline = setTimeout(
      () => reject(new Error("Fixture child did not exit.")),
      8_000,
    );
    child.once("exit", () => {
      clearTimeout(force);
      clearTimeout(deadline);
      resolve();
    });
    child.kill("SIGINT");
  });
}

async function exercise(backend: "sqlite" | "postgres") {
  const root = mkdtempSync(join(tmpdir(), `morphz-node-request-${backend}-`));
  const schema = `morphz_node_bench_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  assert.match(schema, /^morphz_node_bench_[a-f0-9]{24}$/);
  const admin =
    backend === "postgres"
      ? new Pool({ connectionString: postgresURL, max: 1 })
      : null;
  let schemaCreated = false;
  let ownedSchemaOID: number | undefined;
  const children: ChildProcess[] = [];
  const errors = new Map<ChildProcess, string>();
  let phase = "initialization";
  const operatorToken = randomBytes(32).toString("hex");
  const gatewayToken = randomBytes(32).toString("hex");
  const principal = "isolated-node-benchmark-human";
  const foreignPrincipal = "isolated-node-benchmark-foreign";
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const sessionId = "isolated-transfer-benchmark";
  const targets = ["target-node-benchmark-a", "target-node-benchmark-b"];
  const workspaces = [
    join(root, "node-a", "workspace"),
    join(root, "node-b", "workspace"),
  ];
  const config = (workspace: string, central = false) => `
[llm]
model="isolated-unused"
[accounts.stub]
auth_adapter="credential"
credential_ref="stub"
provider="stub"
[services.stub]
adapter="protocol-compatible"
protocol="openai-chat"
base_url="http://127.0.0.1:9/v1"
accounts=["stub"]
[[models.isolated-unused.targets]]
service="stub"
account="stub"
physical_model="isolated-unused"
capabilities=["tools"]
[credentials.stub]
source="env"
name="MORPHZ_NODE_BENCH_UNUSED_KEY"
[permissions]
mode="full_access"
workspace_root=${JSON.stringify(workspace)}
[background_task]
artifact_dir=${JSON.stringify(join(workspace, "artifacts"))}
${central ? `[execution_targets]\nlocal_enabled=false\n[server.identity]\nmode="trusted-gateway"\nprovider_id="node-request-benchmark"\nservice_token_env="MORPHZ_NODE_BENCH_GATEWAY"\n` : ""}
`;
  const environment = (home: string, workspace: string) => ({
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    MORPHZ_HOME: home,
    MORPHZ_STORAGE_SQLITE_PATH: join(home, "runtime.sqlite"),
    MORPHZ_WORKSPACE_ROOT: workspace,
    MORPHZ_PERMISSION_MODE: "full_access",
    MORPHZ_NODE_BENCH_UNUSED_KEY: "synthetic-unused",
  });
  function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    errors.set(child, "");
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => {
      errors.set(
        child,
        ((errors.get(child) ?? "") + chunk.toString()).slice(-8_192),
      );
    });
    return child;
  }
  async function response(
    path: string,
    method = "GET",
    body?: unknown,
    who = principal,
  ) {
    return fetch(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${who === "operator" ? operatorToken : gatewayToken}`,
        ...(who === "operator" ? {} : { "x-morphz-principal": who }),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  }
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    who = principal,
  ): Promise<T> {
    const result = await response(path, method, body, who);
    const data = await result.json();
    assert.ok(
      result.ok,
      `${backend} ${phase}: HTTP ${result.status} ${JSON.stringify(data)}`,
    );
    return data as T;
  }
  async function awaitChild(child: ChildProcess) {
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Fixture CLI operation timed out.")),
        30_000,
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(deadline);
        resolve(code);
      });
    });
    assert.equal(code, 0, `${phase}: ${errors.get(child)}`);
  }
  try {
    if (admin) {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const created = await admin.query<{ oid: number }>(
        "SELECT oid FROM pg_namespace WHERE nspname=$1",
        [schema],
      );
      assert.equal(created.rowCount, 1);
      ownedSchemaOID = created.rows[0]!.oid;
      assert.ok(Number.isInteger(ownedSchemaOID) && ownedSchemaOID > 0);
    }
    const centralHome = join(root, "central");
    mkdirSync(centralHome, { mode: 0o700 });
    const centralConfig = join(root, "central.toml");
    writeFileSync(centralConfig, config(root, true), { mode: 0o600 });
    const scopedPostgres = new URL(postgresURL!);
    scopedPostgres.searchParams.set(
      "options",
      `-csearch_path=${schema},pg_catalog`,
    );
    const central = launch(
      [
        "serve",
        "--bind",
        `127.0.0.1:${port}`,
        "--cwd",
        root,
        "--config-file",
        centralConfig,
        "--log-level",
        "warn",
      ],
      root,
      {
        ...environment(centralHome, root),
        MORPHZ_DASHBOARD_TOKEN: operatorToken,
        MORPHZ_NODE_BENCH_GATEWAY: gatewayToken,
        ...(admin
          ? {
              MORPHZ_STORAGE_BACKEND: "postgres",
              MORPHZ_POSTGRES_URL: scopedPostgres.href,
              MORPHZ_POSTGRES_MAX_CONNECTIONS: "8",
            }
          : {}),
      },
    );
    phase = "Runtime readiness";
    const readinessDeadline = Date.now() + 30_000;
    for (;;) {
      try {
        if (
          (
            await fetch(origin + "/health", {
              signal: AbortSignal.timeout(500),
            })
          ).ok
        )
          break;
      } catch {}
      assert.equal(central.exitCode, null, errors.get(central));
      assert.ok(
        Date.now() < readinessDeadline,
        "Isolated Runtime readiness timed out.",
      );
      await sleep(50);
    }
    phase = "real device pairing and outbound workers";
    for (const [index, workspace] of workspaces.entries()) {
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const nodeHome = join(root, `node-${index}`, "home");
      mkdirSync(nodeHome, { recursive: true, mode: 0o700 });
      const nodeConfig = join(nodeHome, "node.toml");
      const credentialFile = join(nodeHome, "edge-credential.json");
      writeFileSync(nodeConfig, config(workspace), { mode: 0o600 });
      const pairing = await request<{ code: string }>(
        "/api/edge/pairing-codes",
        "POST",
        { expires_in_seconds: 60 },
      );
      const env = environment(nodeHome, workspace);
      await awaitChild(
        launch(
          [
            "edge",
            "pair",
            "--server-url",
            origin,
            "--pairing-code",
            pairing.code,
            "--node-name",
            `Isolated benchmark node ${index}`,
            "--credential-file",
            credentialFile,
            "--cwd",
            workspace,
            "--config-file",
            nodeConfig,
            "--log-level",
            "warn",
          ],
          workspace,
          env,
        ),
      );
      launch(
        [
          "edge",
          "run",
          "--target-id",
          targets[index]!,
          "--target-name",
          `Benchmark target ${index}`,
          "--workers",
          "1",
          "--credential-file",
          credentialFile,
          "--cwd",
          workspace,
          "--config-file",
          nodeConfig,
          "--log-level",
          "warn",
        ],
        workspace,
        env,
      );
    }
    const onlineDeadline = Date.now() + 30_000;
    let targetRecords: Target[] = [];
    for (;;) {
      const catalog = await request<{ targets: Target[] }>(
        "/api/execution-targets",
      );
      targetRecords = targets.map((id) =>
        catalog.targets.find((target) => target.id === id)!,
      );
      if (targetRecords.every((target) => target?.status === "online")) break;
      assert.ok(
        Date.now() < onlineDeadline,
        "Actual paired targets did not become online.",
      );
      await sleep(50);
    }
    const createSession = (id: string, who = principal) =>
      request(
        "/api/sessions",
        "POST",
        {
          id,
          title: "Isolated explicit Transfer baseline",
          mount: { type: "new_blank_context", context_id: `context-${id}` },
        },
        who,
      );
    await createSession(sessionId);
    const sourcePath = join(workspaces[0]!, "payload.bin");
    writeFileSync(sourcePath, payload, { mode: 0o600 });
    const transfer = (label: string): Transfer => ({
      transfer_id: `benchmark-${label}`,
      source: { target_id: targets[0]!, path: sourcePath },
      destination: {
        target_id: targets[1]!,
        path: join(workspaces[1]!, `${label}.bin`),
      },
      overwrite: "deny",
      expected_source_digest: `sha256:${sourceSha256}`,
      media_type: "application/octet-stream",
    });
    phase = "real permission refusals before measurement";
    const forbidden = transfer("forbidden");
    const anonymous = await fetch(origin + "/api/artifact-transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, transfer: forbidden }),
    });
    assert.equal(anonymous.status, 401);
    for (const target of targets) {
      const privateTarget = await response(
        `/api/execution-targets/${target}`,
        "GET",
        undefined,
        foreignPrincipal,
      );
      assert.equal(privateTarget.status, 403);
    }
    const foreign = await response(
      "/api/artifact-transfers",
      "POST",
      {
        session_id: sessionId,
        transfer: forbidden,
      },
      foreignPrincipal,
    );
    assert.equal(
      foreign.status,
      403,
      "Foreign identity must not submit a transfer through the owner's Session.",
    );
    assert.equal(existsSync(forbidden.destination.path), false);
    emit({
      kind: "authorization",
      backend,
      unauthenticated: 401,
      foreignPrivateTarget: 403,
      foreignSessionTransfer: 403,
    });

    const samples: Sample[] = [];
    let replayRequest!: Transfer;
    let replayExecution!: Execution;
    for (let i = 0; i < warmupCount + measuredCount; i++) {
      const warmup = i < warmupCount;
      phase = `${warmup ? "warmup" : "measured"} transfer ${i}`;
      const wire = transfer(`${warmup ? "warmup" : "measured"}-${i}`);
      const before = performance.now();
      const acceptedResponse = await response(
        "/api/artifact-transfers",
        "POST",
        { session_id: sessionId, transfer: wire },
      );
      assert.equal(
        acceptedResponse.status,
        202,
        `${phase}: transfer admission must succeed.`,
      );
      const accepted = (await acceptedResponse.json()) as Execution;
      const admitted = performance.now();
      const deadline = Date.now() + 30_000;
      let terminal: Job;
      for (;;) {
        terminal = await request<Job>(
          `/api/artifact-transfers/${accepted.job.id}`,
        );
        if (
          ["succeeded", "failed", "cancelled", "lost"].includes(terminal.status)
        )
          break;
        assert.ok(
          Date.now() < deadline,
          `${phase}: actual transfer did not finish.`,
        );
        await sleep(observationIntervalMs);
      }
      const observed = performance.now();
      assert.equal(terminal.status, "succeeded", `${phase}: ${terminal.error}`);
      assert.ok(
        terminal.result_event_id && terminal.finished_at && terminal.started_at,
      );
      assert.equal(terminal.target_id, targets[1]);
      assert.equal(terminal.initiating_principal_id, principal);
      assert.equal(terminal.session_id, sessionId);
      assert.equal(terminal.id, accepted.job.id);
      const routes = terminal.request._morphz_artifact_transfer_routes;
      assert.equal(routes.source.target_id, targets[0]);
      assert.equal(routes.destination.target_id, targets[1]);
      assert.equal(
        routes.source.provider_node_id,
        targetRecords[0]!.provider_node_id,
      );
      assert.equal(
        routes.destination.provider_node_id,
        targetRecords[1]!.provider_node_id,
      );
      const actualBytes = readFileSync(wire.destination.path);
      assert.equal(actualBytes.length, byteLength);
      assert.deepEqual(actualBytes, payload);
      const actualSha256 = sha256(actualBytes);
      assert.equal(actualSha256, sourceSha256);
      const output = await request<{
        job: Job;
        event: { payload: { tool_status: string; text: string } };
      }>(`/api/artifact-transfers/${terminal.id}/output`);
      assert.equal(output.job.id, terminal.id);
      assert.equal(output.event.payload.tool_status, "success");
      const receipt = JSON.parse(output.event.payload.text);
      assert.equal(receipt.transfer_id, wire.transfer_id);
      assert.equal(receipt.transport, "edge_relay_channel");
      assert.equal(receipt.bytes_transferred, byteLength);
      for (const side of ["source", "destination"] as const) {
        assert.equal(receipt[side].location.target_id, wire[side].target_id);
        assert.equal(receipt[side].location.path, wire[side].path);
        assert.equal(receipt[side].size_bytes, byteLength);
        assert.equal(receipt[side].content_digest, `sha256:${sourceSha256}`);
      }
      const timing: Sample = {
        admissionMs: admitted - before,
        e2eObservedMs: observed - before,
        durableJobMs: elapsedDurableMs(
          terminal.created_at,
          terminal.finished_at,
        ),
        durableRunningMs: elapsedDurableMs(
          terminal.started_at,
          terminal.finished_at,
        ),
      };
      emit({
        kind: "sample",
        backend,
        stage: warmup ? "warmup" : "measured",
        ordinal: warmup ? i + 1 : i - warmupCount + 1,
        jobId: terminal.id,
        terminal: terminal.status,
        transport: receipt.transport,
        sourceTarget: routes.source.target_id,
        destinationTarget: routes.destination.target_id,
        byteLength: actualBytes.length,
        sourceSha256,
        destinationSha256: actualSha256,
        createdAt: terminal.created_at,
        startedAt: terminal.started_at,
        finishedAt: terminal.finished_at,
        observationIntervalMs,
        ...timing,
      });
      if (!warmup) samples.push(timing);
      replayRequest = wire;
      replayExecution = accepted;
    }
    phase = "same-ID retry separate from measured latency";
    const beforeReplay = statSync(replayRequest.destination.path, {
      bigint: true,
    }).mtimeNs;
    const beforeJobs = await request<{ jobs: Job[] }>(
      `/api/execution-jobs?session_id=${sessionId}&include_terminal=true&limit=100`,
    );
    const replay = await request<Execution>("/api/artifact-transfers", "POST", {
      session_id: sessionId,
      transfer: replayRequest,
    });
    assert.equal(replay.job.id, replayExecution.job.id);
    assert.equal(replay.thread.id, replayExecution.thread.id);
    assert.equal(replay.activation.id, replayExecution.activation.id);
    assert.equal(
      replay.request_event_sequence,
      replayExecution.request_event_sequence,
    );
    await sleep(50);
    const afterJobs = await request<{ jobs: Job[] }>(
      `/api/execution-jobs?session_id=${sessionId}&include_terminal=true&limit=100`,
    );
    assert.equal(afterJobs.jobs.length, beforeJobs.jobs.length);
    assert.equal(
      statSync(replayRequest.destination.path, { bigint: true }).mtimeNs,
      beforeReplay,
    );
    assert.equal(
      sha256(readFileSync(replayRequest.destination.path)),
      sourceSha256,
    );
    emit({
      kind: "retry",
      backend,
      excludedFromLatency: true,
      sameJob: true,
      sameThread: true,
      sameActivation: true,
      noNewJob: true,
      destinationNotRewritten: true,
    });
    emit({
      kind: "summary",
      backend,
      api: "POST /api/artifact-transfers",
      warmupCount,
      measuredCount,
      byteLength,
      observationIntervalMs,
      admission: summarize(samples.map((s) => s.admissionMs)),
      e2eObserved: summarize(samples.map((s) => s.e2eObservedMs)),
      durableJob: summarize(samples.map((s) => s.durableJobMs)),
      durableRunning: summarize(samples.map((s) => s.durableRunningMs)),
      slowSamplesDiscarded: 0,
      modelRequestsIssued: 0,
      boundary:
        "same machine; two outbound workers; loopback HTTP; serial transfers; warm caches; observation polling plus HTTP adds error; n20 quantiles are not stable network/SLO estimates; startup and verification reads excluded",
    });
  } catch (error) {
    emit({ kind: "failure", backend, phase, message: String(error) });
    throw error;
  } finally {
    for (const child of children.reverse()) await stopChild(child);
    if (admin) {
      try {
        if (schemaCreated) {
          assert.ok(ownedSchemaOID !== undefined);
          const current = await admin.query<{ oid: number }>(
            "SELECT oid FROM pg_namespace WHERE nspname=$1",
            [schema],
          );
          assert.equal(current.rowCount, 1);
          assert.equal(
            current.rows[0]!.oid,
            ownedSchemaOID,
            "cleanup must never drop a namespace other than the exact schema created by this benchmark",
          );
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          const remains = await admin.query(
            "SELECT 1 FROM pg_namespace WHERE nspname=$1",
            [schema],
          );
          assert.equal(
            remains.rowCount,
            0,
            "Remove only this benchmark's PostgreSQL schema.",
          );
        }
      } finally {
        await admin.end();
      }
    }
    rmSync(root, { recursive: true, force: true });
    emit({
      kind: "cleanup",
      backend,
      fixtureProcessesStopped: true,
      privateTemporaryFilesRemoved: true,
      fixturePostgresSchemaRemoved: schemaCreated,
      ...(schemaCreated
        ? { schema, oidVerifiedBeforeDrop: ownedSchemaOID }
        : {}),
    });
  }
}

emit({
  kind: "baseline",
  api: "explicit Transfer only, not read/list_files or all Node APIs",
  warmupCount,
  measuredCount,
  byteLength,
  observationIntervalMs,
});
await exercise("sqlite");
await exercise("postgres");
emit({
  kind: "complete",
  backends: ["sqlite", "postgres"],
  measuredSuccessfulTransfers: measuredCount * 2,
});
