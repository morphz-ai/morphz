/** Controlled pressure/maintenance protocol proof against a real isolated Runtime.
 * This is not autonomous summarization or model-quality acceptance. No production
 * database edits, live credentials, paid providers, Host UI, or user processes.
 * Run with --binary PATH --require-git-head HASH. All evidence is retained.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runtimeFixtureFinalReply } from "./runtime-fixture-reply.js";
import {
  assertTerminalRoot,
  runCleanupStages,
} from "./reliability-soak-model.js";

export type MaintenanceRequest = {
  root: string;
  pressure: {
    level: string;
    estimatedTokens: number;
    hardLimit: number;
    reserve: number;
    tokenSource: string;
    tokenAccuracy: string;
    tokenScope: string;
  };
  tools: string[];
  protectedInputVisible: boolean;
};
export type MaintenanceEvidence = {
  root: string;
  protectedInput: string;
  fact: string;
  critical: MaintenanceRequest[];
  restored: MaintenanceRequest;
  forbiddenWrite: { status: string; executed: boolean; code: string };
  protectedRetirementRejected: boolean;
  protectedRootRetired: boolean;
  oldObservationsRetired: string[];
  expectedOldObservations: string[];
  frameBody: string;
  frameHasExactSource: boolean;
  originalInputUnchanged: boolean;
  jobCount: number;
  jobStatus: string;
  jobRoot: string;
  fileContent: string;
  expectedFileContent: string;
  terminalCount: number;
  unresolvedSignals: number;
  unresolvedActivations: number;
  repeatedReceiptRoot: string;
  callsBeforeRetry: number;
  callsAfterRetry: number;
};

export function assertMaintenanceEvidence(e: MaintenanceEvidence) {
  assert.ok(
    e.critical.length >= 3,
    "Both rejected negative controls and maintenance must be observed",
  );
  for (const request of e.critical) {
    assert.equal(
      request.root,
      e.root,
      "Maintenance stays on its original root",
    );
    assert.equal(request.pressure.level, "critical");
    assert.equal(request.pressure.tokenScope, "full-work-prompt");
    const maintenanceTools = new Set([
      "context_tx",
      "recall",
      "objective_update",
      "objective_amend",
      "steer",
      "no_reply",
      "reply",
    ]);
    assert.ok(
      request.tools.every((name) => maintenanceTools.has(name)),
      "The critical schema contains only maintenance/control tools",
    );
    assert.ok(
      request.pressure.estimatedTokens >=
        request.pressure.hardLimit - request.pressure.reserve,
    );
    assert.ok(request.tools.includes("context_tx"));
    assert.ok(
      !request.tools.includes("write"),
      "Critical maintenance cannot expose physical work",
    );
    assert.ok(
      request.protectedInputVisible,
      "Protected input remains visible during maintenance",
    );
  }
  assert.equal(e.forbiddenWrite.status, "rejected");
  assert.equal(e.forbiddenWrite.executed, false);
  assert.equal(e.forbiddenWrite.code, "TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE");
  assert.ok(
    e.protectedRetirementRejected,
    "The real Runtime must reject retiring the live root",
  );
  assert.equal(e.protectedRootRetired, false);
  assert.ok(
    e.originalInputUnchanged,
    "Immutable input must not be rewritten by compression",
  );
  assert.ok(e.expectedOldObservations.length > 0);
  for (const id of e.expectedOldObservations)
    assert.ok(e.oldObservationsRetired.includes(id));
  assert.ok(
    e.frameBody.includes(e.fact),
    "Prior observed fixture fact survives in a sourced frame",
  );
  assert.ok(
    e.frameHasExactSource,
    "The retained frame must cite the real accepted source observation",
  );
  assert.equal(
    e.restored.root,
    e.root,
    "Restored work is a continuation, not a new root",
  );
  assert.notEqual(e.restored.pressure.level, "critical");
  assert.ok(
    e.restored.pressure.estimatedTokens <
      e.restored.pressure.hardLimit - e.restored.pressure.reserve,
  );
  assert.ok(
    e.restored.pressure.estimatedTokens <
      e.critical[0]!.pressure.estimatedTokens,
  );
  assert.ok(
    e.restored.tools.includes("write"),
    "Physical work must actually return to the offered schema",
  );
  assert.ok(e.restored.protectedInputVisible);
  assert.equal(e.jobCount, 1, "Only the post-maintenance write may execute");
  assert.equal(e.jobStatus, "succeeded");
  assert.equal(e.jobRoot, e.root);
  assert.equal(e.fileContent, e.expectedFileContent);
  assert.equal(e.terminalCount, 1);
  assert.equal(
    e.unresolvedSignals,
    0,
    "Pending and claimed Signals must both settle",
  );
  assert.equal(e.unresolvedActivations, 0);
  assert.equal(e.repeatedReceiptRoot, e.root);
  assert.equal(e.callsAfterRetry, e.callsBeforeRetry);
}

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const exec = promisify(execFile);
function pressureOf(request: any): MaintenanceRequest["pressure"] {
  const text = request.messages
    .map((message: any) => String(message.content ?? ""))
    .join("\n");
  const match = text.match(
    /\(context-pressure \(level ([a-z-]+)\) \(estimated-tokens (\d+)\)[\s\S]*?\(hard-limit (\d+)\) \(maintenance-reserve (\d+)\)/,
  );
  assert.ok(match, "Real request contains Runtime-measured Context pressure");
  return {
    level: match[1]!,
    estimatedTokens: Number(match[2]),
    hardLimit: Number(match[3]),
    reserve: Number(match[4]),
    tokenSource: match[0].match(/\(token-source ([^)]+)\)/)?.[1] ?? "missing",
    tokenAccuracy:
      match[0].match(/\(token-accuracy ([^)]+)\)/)?.[1] ?? "missing",
    tokenScope: match[0].match(/\(token-scope ([^)]+)\)/)?.[1] ?? "missing",
  };
}

export async function runMaintenanceProof(options: {
  binary: string;
  expectedHead: string;
  outputParent?: string;
}) {
  const binary = resolve(options.binary),
    startedAt = new Date().toISOString();
  assert.ok(existsSync(binary), "Explicit frozen binary is required");
  assert.match(options.expectedHead, /^[0-9a-f]{40}$/);
  const version = (await exec(binary, ["--version"])).stdout.trim();
  assert.ok(
    version.includes(`git ${options.expectedHead.slice(0, 12)}`),
    "Frozen Runtime version must match the requested source",
  );
  const binarySha = sha(readFileSync(binary));
  const sourceSnapshots = [
    import.meta.url,
    new URL("./runtime-fixture-reply.ts", import.meta.url).href,
    new URL("./reliability-soak-model.ts", import.meta.url).href,
  ].map((url) => {
    const path = fileURLToPath(url),
      bytes = readFileSync(path);
    return { path, bytes, sha256: sha(bytes) };
  });
  const directory = mkdtempSync(
    join(options.outputParent ?? tmpdir(), "morphz-context-maintenance-"),
  );
  const home = join(directory, "runtime"),
    database = join(home, "runtime.sqlite"),
    tracePath = join(directory, "trace.jsonl");
  mkdirSync(home, { mode: 0o700 });
  const snapshotDirectory = join(directory, "harness");
  mkdirSync(snapshotDirectory, { mode: 0o700 });
  const snapshotPackage = JSON.stringify({ private: true, type: "module" });
  writeFileSync(join(snapshotDirectory, "package.json"), snapshotPackage, {
    mode: 0o500,
  });
  chmodSync(join(snapshotDirectory, "package.json"), 0o500);
  for (const snapshot of sourceSnapshots) {
    const destination = join(
      snapshotDirectory,
      snapshot.path.split("/").at(-1)!,
    );
    writeFileSync(destination, snapshot.bytes, { mode: 0o500 });
    chmodSync(destination, 0o500);
  }
  const token = randomBytes(32).toString("hex"),
    sessionId = `maintenance-${randomUUID()}`;
  const fact = "PRIOR_OBSERVED_FIXTURE_FACT_7319",
    protectedInput = `PROTECTED_ORIGINAL_WORK_${randomUUID()}`;
  const allowedPath = join(home, "continued-work.txt"),
    forbiddenPath = join(home, "forbidden-critical-write.txt");
  const fileContent = `${fact}\n${protectedInput}\n`;
  let runtime: ChildProcess | undefined,
    providerCalls = 0,
    phase: "warmup" | "seed" | "work" = "warmup",
    workStep = 0;
  let providerFailure: Error | undefined,
    root = "",
    contextId = "",
    seedRoot = "",
    warmupRoot = "",
    initialInputHash = "";
  let runtimeUrl = "",
    normalBaseline = 0,
    seededPressure = 0;
  const seedRoots: string[] = [];
  let forbiddenWrite: MaintenanceEvidence["forbiddenWrite"] | undefined,
    protectedRetirementRejected = false;
  let expectedOldObservations: string[] = [],
    restored: MaintenanceRequest | undefined;
  const critical: MaintenanceRequest[] = [],
    heldResponses = new Set<ServerResponse>();
  const trace = (event: string, value: unknown = {}) =>
    appendFileSync(
      tracePath,
      JSON.stringify({ at: new Date().toISOString(), event, value }) + "\n",
      { mode: 0o600 },
    );
  const sql = (query: string, ...values: SQLInputValue[]): any[] => {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      return db
        .prepare(query)
        .all(...values)
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(runtimeUrl + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${await response.clone().text()}`,
    );
    return response.json() as Promise<any>;
  };
  const wait = async (
    check: () => boolean | Promise<boolean>,
    label: string,
    timeout = 60_000,
  ) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (providerFailure) throw providerFailure;
      if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
        throw new Error(`Owned Runtime exited: ${label}`);
      if (await check()) return;
      await pause(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const output = (callId: string) => {
    const rows = sql(
      "SELECT payload FROM events WHERE topic='chat/tool_output' AND json_extract(payload,'$.tool_call_id')=?",
      callId,
    );
    assert.equal(
      rows.length,
      1,
      `One authoritative tool receipt for ${callId}`,
    );
    return JSON.parse(rows[0]!.payload);
  };
  const requestEvidence = (request: any): MaintenanceRequest => {
    const active = sql(
      "SELECT root_turn_id FROM thread_activations WHERE session_id=? AND status='running'",
      sessionId,
    );
    assert.equal(
      active.length,
      1,
      "Each actual request belongs to one live Activation",
    );
    return {
      root: active[0]!.root_turn_id,
      pressure: pressureOf(request),
      tools: request.tools.map((tool: any) => tool.function?.name ?? tool.name),
      protectedInputVisible: JSON.stringify(request.messages).includes(
        protectedInput,
      ),
    };
  };
  const respond = (
    response: ServerResponse,
    request: any,
    tool?: { id: string; name: string; arguments: unknown },
    content = "Controlled fixture reply",
  ) => {
    const result = tool
      ? {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: tool.id,
                type: "function",
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.arguments),
                },
              },
            ],
          },
          finishReason: "tool_calls",
        }
      : runtimeFixtureFinalReply(request, {
          content,
          title: "受控 Context 压力维护验收",
          result: "原输入及事实保留，原工作完成",
        });
    trace("provider-response", {
      call: providerCalls,
      phase,
      step: workStep,
      tool: tool?.name,
      callId: tool?.id,
    });
    if (request.stream) {
      const message = result.message as any;
      const delta = {
        ...message,
        ...(message.tool_calls
          ? {
              tool_calls: message.tool_calls.map(
                (call: any, index: number) => ({ ...call, index }),
              ),
            }
          : {}),
      };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta, finish_reason: result.finishReason }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: randomUUID(),
          choices: [
            {
              index: 0,
              message: result.message,
              finish_reason: result.finishReason,
            },
          ],
        }),
      );
    }
  };
  const provider = createServer(async (request, response) => {
    heldResponses.add(response);
    response.once("close", () => heldResponses.delete(response));
    try {
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "maintenance-proof" }] }));
        return;
      }
      assert.equal(request.method, "POST");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size < 4 * 1024 * 1024);
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks),
        input = JSON.parse(raw.toString());
      providerCalls++;
      writeFileSync(
        join(directory, `provider-request-${providerCalls}.json`),
        raw,
        { mode: 0o600 },
      );
      const evidence = requestEvidence(input);
      trace("actual-provider-request", {
        call: providerCalls,
        phase,
        step: workStep,
        sha256: sha(raw),
        evidence,
      });
      if (phase === "warmup") {
        normalBaseline = evidence.pressure.estimatedTokens;
        respond(response, input);
        return;
      }
      if (phase === "seed") {
        seededPressure = evidence.pressure.estimatedTokens;
        respond(
          response,
          input,
          undefined,
          `Observed prior synthetic fact ${fact}.`,
        );
        return;
      }
      if (!root) {
        const accepted = sql(
          "SELECT id,payload FROM events WHERE topic='chat/user_message' AND json_extract(payload,'$.client_message_id')='original-protected-work'",
        );
        assert.equal(accepted.length, 1);
        root = accepted[0]!.id;
        initialInputHash = sha(accepted[0]!.payload);
      }
      assert.equal(evidence.root, root);
      if (workStep <= 2) {
        critical.push(evidence);
        assert.equal(
          evidence.pressure.level,
          "critical",
          "Actual Runtime must enter pressure maintenance before work",
        );
        assert.ok(!evidence.tools.includes("write"));
        assert.ok(evidence.tools.includes("context_tx"));
        assert.ok(evidence.protectedInputVisible);
      }
      if (workStep === 0) {
        workStep++;
        respond(response, input, {
          id: "negative-critical-write",
          name: "write",
          arguments: {
            path: forbiddenPath,
            content: "must never execute",
            mode: "create",
          },
        });
      } else if (workStep === 1) {
        const receipt = output("negative-critical-write");
        forbiddenWrite = {
          status: receipt.tool_status,
          executed: receipt.executed,
          code: receipt.rejection_code,
        };
        assert.deepEqual(forbiddenWrite, {
          status: "rejected",
          executed: false,
          code: "TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE",
        });
        assert.equal(existsSync(forbiddenPath), false);
        const context = await api(`/api/sessions/${sessionId}/context`);
        workStep++;
        respond(response, input, {
          id: "negative-protected-retirement",
          name: "context_tx",
          arguments: {
            transaction: `(context-tx (base-version ${context.state.version}) (reason "negative control: forbidden live-root retirement") (retire ${JSON.stringify(root)}))`,
          },
        });
      } else if (workStep === 2) {
        const rejected = output("negative-protected-retirement");
        protectedRetirementRejected =
          JSON.stringify(rejected).includes("causally protected");
        assert.ok(
          protectedRetirementRejected,
          "Live root retirement must fail in the real Runtime",
        );
        const context = await api(`/api/sessions/${sessionId}/context`);
        assert.equal(
          context.state.version,
          0,
          "Rejected transaction cannot commit a new Mind version",
        );
        assert.ok(!context.state.retired.includes(root));
        expectedOldObservations = context.observations
          .filter((observation: any) => {
            const owner = sql(
              "SELECT t.root_turn_id,t.status FROM events e JOIN threads t ON t.root_turn_id=e.root_turn_id WHERE e.id=?",
              observation.id,
            );
            return (
              owner.length === 1 &&
              owner[0]!.status === "completed" &&
              [warmupRoot, ...seedRoots].includes(owner[0]!.root_turn_id)
            );
          })
          .map((observation: any) => observation.id);
        assert.ok(
          expectedOldObservations.includes(seedRoot),
          "The old accepted observation must be actually compressible",
        );
        const transaction = `(context-tx (base-version ${context.state.version}) (reason "compress only completed synthetic history; keep live original work") (derive maintained-fixture-facts (from ${JSON.stringify(seedRoot)}) (kind "controlled-fixture") (understanding "Prior synthetic user input stated ${fact}; retain this observation, not an external-world claim."))${expectedOldObservations.map((id) => ` (retire ${JSON.stringify(id)})`).join("")})`;
        trace("legal-maintenance-transaction", {
          root,
          expectedOldObservations,
          transaction,
        });
        workStep++;
        respond(response, input, {
          id: "legal-pressure-maintenance",
          name: "context_tx",
          arguments: { transaction },
        });
      } else if (workStep === 3) {
        restored = evidence;
        assert.notEqual(
          evidence.pressure.level,
          "critical",
          "Actual full-work pressure must fall after maintenance",
        );
        assert.ok(
          evidence.tools.includes("write"),
          "Runtime must restore the original work tool",
        );
        const context = await api(`/api/sessions/${sessionId}/context`);
        assert.ok(
          context.state.frames.some(
            (frame: any) =>
              frame.id === "maintained-fixture-facts" &&
              JSON.stringify(frame).includes(fact),
          ),
        );
        assert.ok(!context.state.retired.includes(root));
        workStep++;
        respond(response, input, {
          id: "restored-original-write",
          name: "write",
          arguments: {
            path: allowedPath,
            content: fileContent,
            mode: "create",
          },
        });
      } else if (workStep === 4) {
        assert.ok(
          existsSync(allowedPath),
          "The real restored tool must write the original work result",
        );
        assert.equal(readFileSync(allowedPath, "utf8"), fileContent);
        workStep++;
        respond(
          response,
          input,
          undefined,
          `Completed original work ${protectedInput}; retained ${fact}.`,
        );
      } else
        throw new Error(
          "Unexpected extra provider call after the original work reply",
        );
    } catch (error) {
      providerFailure =
        error instanceof Error ? error : new Error(String(error));
      trace("provider-fixture-failure", { message: providerFailure.message });
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Controlled fixture assertion failed",
            type: "fixture_failure",
          },
        }),
      );
    }
  });
  let outcome: "passed" | "failed" = "failed",
    failure: string | undefined,
    finalEvidence: MaintenanceEvidence | undefined;
  const terminal = async (acceptedRoot: string) => {
    await wait(
      () =>
        sql(
          "SELECT id FROM threads WHERE root_turn_id=? AND status='completed'",
          acceptedRoot,
        ).length === 1 &&
        sql(
          "SELECT thread_id FROM thread_outcomes WHERE root_turn_id=?",
          acceptedRoot,
        ).length === 1 &&
        sql(
          "SELECT id FROM thread_activations WHERE root_turn_id=? AND status IN ('queued','running')",
          acceptedRoot,
        ).length === 0 &&
        sql(
          "SELECT s.id FROM thread_signals s JOIN threads t ON t.id=s.thread_id WHERE t.root_turn_id=? AND s.status IN ('pending','claimed')",
          acceptedRoot,
        ).length === 0,
      `Terminal original root ${acceptedRoot}`,
    );
  };
  try {
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    const providerPort = (provider.address() as { port: number }).port;
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const runtimePort = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    runtimeUrl = `http://127.0.0.1:${runtimePort}`;
    const config = join(home, "morphz.toml"),
      envFile = join(home, "empty.env");
    writeFileSync(envFile, "", { mode: 0o600 });
    writeFileSync(
      config,
      `[llm]\nmodel="maintenance-proof"\n[orchestrator]\ncontext_hard_token_limit=256000\ncontext_soft_token_limit=192000\nmodel_attempt_hard_timeout_secs=45\n[accounts.proof]\nauth_adapter="credential"\ncredential_ref="proof"\nprovider="proof"\n[services.proof]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["proof"]\n[[models.maintenance-proof.targets]]\nservice="proof"\naccount="proof"\nphysical_model="maintenance-proof"\ncapabilities=["tools"]\n[credentials.proof]\nsource="env"\nname="MORPHZ_CONTEXT_PROOF_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(home)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify(
        {
          format: "morphz-context-maintenance/v1",
          startedAt,
          head: options.expectedHead,
          binary,
          version,
          binarySha,
          harnessSha: sourceSnapshots[0]!.sha256,
          snapshotPackageSha: sha(snapshotPackage),
          sourceSnapshots: sourceSnapshots.map(({ path, sha256 }) => ({
            path,
            sha256,
          })),
          replay: `node --import tsx ${join(snapshotDirectory, "reliability-context-maintenance.ts")} --binary ${binary} --require-git-head ${options.expectedHead}`,
          runtimeUrl,
          sessionId,
          scope:
            "real Runtime/local heuristic full-Prompt pressure/revision-fenced isolated Context budget/controlled Provider transactions/SQLite",
          exclusions: [
            "autonomous summarization quality",
            "Electron",
            "PostgreSQL",
            "user App or credentials",
            "8-hour duration",
          ],
          paidModelCalls: 0,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    runtime = spawn(
      binary,
      [
        "serve",
        "--bind",
        `127.0.0.1:${runtimePort}`,
        "--cwd",
        home,
        "--config-file",
        config,
        "--log-level",
        "info",
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: process.env.TMPDIR,
          LANG: "en_US.UTF-8",
          MORPHZ_HOME: home,
          MORPHZ_ENV_FILE: envFile,
          MORPHZ_STORAGE_SQLITE_PATH: database,
          MORPHZ_DASHBOARD_TOKEN: token,
          MORPHZ_CONTEXT_PROOF_KEY: "synthetic-only",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    trace("owned-runtime-started", { pid: runtime.pid });
    for (const stream of [runtime.stdout, runtime.stderr])
      stream?.on("data", (data: Buffer) =>
        appendFileSync(
          join(directory, "runtime.log"),
          data.toString().replaceAll(token, "[fixture-token]"),
          { mode: 0o600 },
        ),
      );
    await wait(
      async () => {
        try {
          return (
            await fetch(runtimeUrl + "/health", {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      "Owned Runtime health",
      45_000,
    );
    await api("/api/agents/default-agent/provider-accounts/proof", {
      method: "PUT",
    });
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        title: "TEST controlled Context pressure proof",
      }),
    });
    contextId = session.context_id;
    const send = (text: string, clientId: string) => {
      const body = JSON.stringify({
        text,
        client_message_id: clientId,
        response_annotations: "v2",
      });
      if (!existsSync(join(directory, `input-${clientId}.json`)))
        writeFileSync(join(directory, `input-${clientId}.json`), body, {
          mode: 0o600,
        });
      return api(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        body,
      });
    };
    warmupRoot = (await send("Small completed baseline observation", "warmup"))
      .event_id;
    await terminal(warmupRoot);
    phase = "seed";
    // Runtime deliberately abbreviates an individual large observation. Increase
    // real history breadth instead of pretending unprojected bytes create pressure.
    for (let index = 0; index < 32; index++) {
      seedRoot = (
        await send(
          `Observed synthetic prior fact ${fact}. Completed fixture history ${index}.\n${"Obsolete synthetic process detail; safe to summarize after this root completes.\n".repeat(18)}`,
          `seed-history-${index}`,
        )
      ).event_id;
      seedRoots.push(seedRoot);
      await terminal(seedRoot);
    }
    assert.ok(
      seededPressure > normalBaseline + 10_000,
      "Real historical bytes must materially increase full-work pressure",
    );
    const budget = await api(
      `/api/contexts/${contextId}/token-budget?session_id=${sessionId}`,
    );
    const hardLimit = Math.ceil(
      (normalBaseline + (seededPressure - normalBaseline) * 0.55) / 0.875,
    );
    const updated = await api(`/api/contexts/${contextId}/token-budget`, {
      method: "PATCH",
      body: JSON.stringify({
        requested_hard_token_limit: hardLimit,
        expected_revision: budget.token_budget_revision,
      }),
    });
    assert.equal(updated.outcome, "updated");
    trace("isolated-budget-revision-updated", {
      normalBaseline,
      seededPressure,
      hardLimit,
      budget: updated.budget,
    });
    phase = "work";
    const workText = `Write ${JSON.stringify(allowedPath)} containing the previously observed fact ${fact} and this exact protected work marker ${protectedInput}. First maintain old history if pressure requires it. Do not create another task or rewrite this input.`;
    // Receipt and the request may race; bind the root from the immutable accepted Event before answering.
    const workPromise = send(workText, "original-protected-work");
    await wait(() => {
      const row = sql(
        "SELECT id FROM events WHERE topic='chat/user_message' AND json_extract(payload,'$.client_message_id')='original-protected-work'",
      );
      if (row.length === 1) root = row[0]!.id;
      return root.length > 0;
    }, "Accepted original work Event");
    const receipt = await workPromise;
    assert.equal(receipt.event_id, root);
    initialInputHash = sha(
      sql("SELECT payload FROM events WHERE id=?", root)[0]!.payload,
    );
    await terminal(root);
    assert.equal(workStep, 5);
    const context = await api(`/api/sessions/${sessionId}/context`);
    const jobs = sql(
      "SELECT j.id,j.status,t.root_turn_id FROM execution_jobs j JOIN threads t ON t.id=j.thread_id WHERE t.root_turn_id=?",
      root,
    );
    const evidence = {
      threads: sql(
        "SELECT id,root_turn_id,generation,status FROM threads WHERE root_turn_id=?",
        root,
      ),
      outcomes: sql(
        "SELECT thread_id,root_turn_id,thread_generation,terminal_kind FROM thread_outcomes WHERE root_turn_id=?",
        root,
      ),
      liveActivations: sql(
        "SELECT id FROM thread_activations WHERE root_turn_id=? AND status IN ('queued','running')",
        root,
      ),
      pendingSignals: sql(
        "SELECT s.id FROM thread_signals s JOIN threads t ON t.id=s.thread_id WHERE t.root_turn_id=? AND s.status IN ('pending','claimed')",
        root,
      ),
    };
    assertTerminalRoot(root, evidence);
    assert.equal(
      sql("SELECT id FROM threads").length,
      seedRoots.length + 2,
      "Every admitted input has exactly one logical Thread",
    );
    assert.equal(
      sql("SELECT thread_id FROM thread_outcomes").length,
      seedRoots.length + 2,
    );
    assert.deepEqual(
      sql(
        "SELECT id,status FROM thread_signals WHERE status IN ('pending','claimed')",
      ),
      [],
    );
    assert.deepEqual(
      sql(
        "SELECT id,status FROM plan_executions WHERE status IN ('queued','running','waiting')",
      ),
      [],
    );
    assert.deepEqual(
      sql(
        "SELECT id,status FROM execution_jobs WHERE status IN ('queued','running','waiting_approval')",
      ),
      [],
    );
    const callsBeforeRetry = providerCalls;
    const retried = await send(workText, "original-protected-work");
    assert.equal(retried.duplicate, true);
    await pause(1000);
    assert.equal(
      sql(
        "SELECT j.id FROM execution_jobs j JOIN threads t ON t.id=j.thread_id WHERE t.root_turn_id=?",
        root,
      ).length,
      jobs.length,
    );
    finalEvidence = {
      root,
      protectedInput,
      fact,
      critical,
      restored: restored!,
      forbiddenWrite: forbiddenWrite!,
      protectedRetirementRejected,
      protectedRootRetired: context.state.retired.includes(root),
      oldObservationsRetired: context.state.retired,
      expectedOldObservations,
      frameBody: JSON.stringify(
        context.state.frames.find(
          (frame: any) => frame.id === "maintained-fixture-facts",
        ),
      ),
      frameHasExactSource:
        context.state.frames
          .find((frame: any) => frame.id === "maintained-fixture-facts")
          ?.sources?.includes(seedRoot) === true,
      originalInputUnchanged:
        initialInputHash ===
        sha(sql("SELECT payload FROM events WHERE id=?", root)[0]!.payload),
      jobCount: jobs.length,
      jobStatus: jobs[0]?.status,
      jobRoot: jobs[0]?.root_turn_id,
      fileContent: readFileSync(allowedPath, "utf8"),
      expectedFileContent: fileContent,
      terminalCount: evidence.outcomes.length,
      unresolvedSignals: evidence.pendingSignals.length,
      unresolvedActivations: evidence.liveActivations.length,
      repeatedReceiptRoot: retried.event_id,
      callsBeforeRetry,
      callsAfterRetry: providerCalls,
    };
    assertMaintenanceEvidence(finalEvidence);
    assert.equal(existsSync(forbiddenPath), false);
    writeFileSync(
      join(directory, "verified-evidence.json"),
      JSON.stringify(
        {
          finalEvidence,
          terminalEvidence: evidence,
          context,
          jobs,
          currentInputSha: initialInputHash,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    outcome = "passed";
  } catch (error) {
    failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    trace("proof-failed", { failure });
  }
  const cleanupFailures = await runCleanupStages([
    {
      name: "owned-runtime",
      run: async () => {
        if (
          !runtime ||
          runtime.exitCode !== null ||
          runtime.signalCode !== null
        )
          return;
        assert.ok(
          runtime.pid && runtime.pid !== 68670,
          "Never signal an existing Runtime",
        );
        const exited = new Promise<void>((done) =>
          runtime!.once("exit", () => done()),
        );
        runtime.kill("SIGTERM");
        await Promise.race([exited, pause(8000)]);
        if (runtime.exitCode === null && runtime.signalCode === null) {
          runtime.kill("SIGKILL");
          await Promise.race([exited, pause(3000)]);
          throw new Error("Owned Runtime cleanup required forced kill");
        }
      },
      timeoutMs: 15_000,
    },
    {
      name: "owned-provider",
      run: async () => {
        for (const response of heldResponses) response.destroy();
        provider.closeAllConnections();
        await new Promise<void>((done, reject) =>
          provider.close((error) => (error ? reject(error) : done())),
        );
      },
    },
  ]);
  if (cleanupFailures.length) {
    outcome = "failed";
    failure ??= JSON.stringify(cleanupFailures);
  }
  const afterSha = sha(readFileSync(binary));
  if (afterSha !== binarySha) {
    outcome = "failed";
    failure ??= "Frozen binary changed during the proof";
  }
  const sourcesUnchanged =
    sha(readFileSync(join(snapshotDirectory, "package.json"))) ===
      sha(snapshotPackage) &&
    sourceSnapshots.every(
      (snapshot) =>
        sha(readFileSync(snapshot.path)) === snapshot.sha256 &&
        sha(
          readFileSync(
            join(snapshotDirectory, snapshot.path.split("/").at(-1)!),
          ),
        ) === snapshot.sha256,
    );
  if (!sourcesUnchanged) {
    outcome = "failed";
    failure ??= "Harness or a frozen source snapshot changed during the proof";
  }
  const result = {
    format: "morphz-context-maintenance/v1",
    outcome,
    directory,
    startedAt,
    endedAt: new Date().toISOString(),
    head: options.expectedHead,
    version,
    binarySha,
    afterSha,
    sourcesUnchanged,
    providerCalls,
    verifiedRoots: outcome === "passed" ? seedRoots.length + 2 : undefined,
    physicalJobCount: finalEvidence?.jobCount,
    realProtocolNegativeControls:
      Number(!!forbiddenWrite) + Number(protectedRetirementRejected),
    phases: {
      normalBaseline,
      seededPressure,
      criticalRequests: critical.length,
      workStep,
    },
    cleanupFailures,
    failure,
    paidModelCalls: 0,
    userAppTouched: false,
    autonomousSummaryQualityTested: false,
  };
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  return result;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!,
      value = process.argv[i + 1];
    assert.ok(
      ["--binary", "--require-git-head", "--output-parent"].includes(key) &&
        value &&
        !args.has(key),
    );
    args.set(key, value);
  }
  assert.ok(args.get("--binary") && args.get("--require-git-head"));
  const result = await runMaintenanceProof({
    binary: args.get("--binary")!,
    expectedHead: args.get("--require-git-head")!,
    outputParent: args.get("--output-parent"),
  });
  console.log(JSON.stringify(result));
  if (result.outcome !== "passed") process.exitCode = 1;
}
