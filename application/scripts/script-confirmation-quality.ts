/** Explicit live semantic gate. Real Rust Runtime, canonical Harness, embedded
 * Unix Host and fresh SQLite stores. Only synthetic conversations reach the
 * already-configured native model route; credentials remain in the Rust bridge.
 * One invocation has a hard 16-request allowance and never restarts the bridge.
 * This buffered lab adapter does not establish UI/native incremental streaming.
 */
import "./application-configuration.mjs";
import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
// @ts-ignore Runtime binary discovery is a shared JavaScript CLI helper.
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import {
  emptyScriptDraft,
  type ScriptProduction,
} from "../packages/core/src/script-studio.js";
import type { Receipt } from "../packages/core/src/model.js";

const MAX_CALLS = 16;
const LIVE_HARNESS_VERSION = "1.4.4";
const bridgeMessage = z.object({
  role: z.string(),
  content: z.string(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
});
const bridgeResponse = z.object({
  content: z.string(),
  tool_calls: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      func_name: z.string(),
      arguments: z.string(),
    }),
  ),
});
type NativeResponse = z.infer<typeof bridgeResponse>;
type ReceiptRow = {
  operation: string;
  result_object_id: string;
  input_id: string | null;
  result_version_ref: string | null;
};
type PreparationRow = {
  input_id: string;
  target_item_id: string;
  base_item_revision: number;
  task_request: string;
};
export type SemanticCase = "positive" | "defer" | "ambiguous";

/** Called before touching bridge stdin. Request 17 has no Provider side effect. */
export function assertWithinLiveAllowance(completedOrStartedCalls: number) {
  assert.ok(
    Number.isSafeInteger(completedOrStartedCalls) &&
      completedOrStartedCalls >= 0 &&
      completedOrStartedCalls < MAX_CALLS,
    "The 16 live request allowance is exhausted; no bridge restart or repair inference",
  );
}

export function nativeUsageTotals(requests: { native: unknown }[]) {
  const totals: Record<string, number> = {};
  for (const request of requests) {
    const usage = z
      .object({ usage: z.record(z.string(), z.number()) })
      .parse(request.native).usage;
    for (const [field, value] of Object.entries(usage))
      totals[field] = (totals[field] ?? 0) + value;
  }
  return totals;
}

export function extractCanonicalDeliveryPrompt(canonical: string) {
  const prompt = /"""(STAGE script-delivery。\n[\s\S]*?)"""/.exec(
    canonical,
  )?.[1];
  assert.ok(
    prompt,
    "Probe must use the exact canonical package literal, not a rewritten prompt",
  );
  return prompt;
}

export function assertPartialDeliveryText(text: string) {
  assert.match(text, /主角一/);
  assert.match(text, /已保存/);
  assert.match(text, /主角二/);
  assert.match(text, /未保存|保存失败/);
  assert.match(text, /五场戏大纲/);
  assert.match(
    text,
    /未知|无法核对|无法确认|不能确认|不能核对|尚不能确定|尚不确定/,
  );
  assert.match(text, /待.*恢复|恢复.*回执|保留.*命令|保留.*原.*请求/);
  assert.match(text, /未采纳|未.*批准|不.*采纳/);
}

function readSql<T>(path: string, query: string, ...args: (string | number)[]) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(query).all(...args) as T[];
  } finally {
    db.close();
  }
}

/** Offline audit reads owned lab stores only and never reopens the Host/Runtime.
 * Its independent artifact retains the historical failed gate rather than
 * relabeling a run whose transport or checker required repair as a clean pass.
 */
export function verifyExistingPositiveRun(path: string) {
  const directory = resolve(path);
  assert.match(
    basename(directory),
    /^morphz-script-confirmation-live-[A-Za-z0-9]+$/,
  );
  const priorPath = join(directory, "evidence.json");
  const providerPath = join(directory, "provider-evidence.json");
  const sha = (file: string) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const originals = {
    evidenceSha256: sha(priorPath),
    providerSha256: sha(providerPath),
  };
  const original = z
    .object({
      passed: z.boolean(),
      scenario: z.literal("positive"),
      clientCalls: z.number(),
    })
    .passthrough()
    .parse(JSON.parse(readFileSync(priorPath, "utf8")));
  const requests = z
    .array(
      z.object({
        sequence: z.number(),
        messages: z.unknown(),
        native: z.unknown(),
      }),
    )
    .parse(JSON.parse(readFileSync(providerPath, "utf8")));
  assert.equal(requests.length, original.clientCalls);
  assert.ok(requests.length <= MAX_CALLS);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.sequence, index + 1);
    const native = z
      .object({
        client_call_count: z.number(),
        binding: z.object({ physical_model: z.literal("gpt-6.1-sol") }),
        native_events: z.object({ usage: z.number() }),
      })
      .parse(request.native);
    assert.equal(native.client_call_count, index + 1);
    assert.ok(native.native_events.usage > 0);
  }
  const appDb = (name: string) =>
    join(directory, "application", `${name}.sqlite`);
  const runtimeDb = join(directory, "runtime", "runtime.sqlite");
  const deliveries = readSql<{ body: string }>(
    appDb("workspace"),
    "SELECT body FROM runtime_deliveries ORDER BY ordinal",
  ).map((row) =>
    z
      .object({
        inputId: z.string(),
        sessionId: z.string(),
        rootId: z.string(),
        state: z.literal("completed"),
        platformSource: z
          .object({
            body: z.string(),
            scriptGeneration: z.unknown().optional(),
          })
          .passthrough(),
        request: z.object({
          message: z.object({
            content: z.object({
              value: z.object({ text: z.string(), input_id: z.string() }),
            }),
          }),
        }),
      })
      .parse(JSON.parse(row.body)),
  );
  assert.equal(deliveries.length, 2);
  for (const delivery of deliveries) {
    assert.equal(delivery.platformSource.scriptGeneration, undefined);
    assert.equal(
      delivery.request.message.content.value.text,
      delivery.platformSource.body,
    );
    assert.equal(
      delivery.request.message.content.value.input_id,
      delivery.inputId,
    );
  }
  assert.equal(deliveries[1]!.platformSource.body, "好的，你直接做。");
  assert.equal(deliveries[0]!.sessionId, deliveries[1]!.sessionId);
  const events = readSql<{
    id: string;
    type: string;
    context_id: string;
    session_id: string;
    root_turn_id: string | null;
    payload: string;
  }>(
    runtimeDb,
    "SELECT id,type,context_id,session_id,root_turn_id,payload FROM events ORDER BY rowid",
  );
  const inputs = deliveries.map((delivery) => {
    const reply = events
      .filter(
        (event) =>
          event.type === "agent_call" &&
          event.root_turn_id === delivery.rootId &&
          event.session_id === delivery.sessionId &&
          event.id.startsWith("reply_"),
      )
      .at(-1);
    assert.ok(
      reply,
      "A genuine persisted reply must belong to each exact Host input root",
    );
    return {
      inputId: delivery.inputId,
      rootId: delivery.rootId,
      sessionId: reply.session_id,
      contextId: reply.context_id,
      originalBody: delivery.platformSource.body,
      replyEventId: reply.id,
      reply: String(JSON.parse(reply.payload).text),
    };
  });
  assert.equal(inputs[0]!.contextId, inputs[1]!.contextId);
  assert.ok(
    requests.some((request) =>
      contextContainsProposal(request.messages, inputs[0]!.reply),
    ),
  );
  const confirmationId = inputs[1]!.inputId;
  const preparations = readSql<PreparationRow>(
    appDb("script-studio"),
    "SELECT input_id,target_item_id,base_item_revision,task_request FROM script_preparations WHERE input_id=? ORDER BY collection_ordinal",
    confirmationId,
  );
  const receipts = readSql<ReceiptRow & { command_id: string }>(
    appDb("script-studio"),
    "SELECT command_id,operation,result_object_id,input_id,result_version_ref FROM script_command_receipts WHERE input_id=? ORDER BY committed_at,command_id",
    confirmationId,
  );
  const targets = readSql<{
    id: string;
    kind: string;
    revision: number;
    status: string;
  }>(
    appDb("script-studio"),
    "SELECT item_id AS id,kind,head_revision AS revision,status FROM script_items ORDER BY collection_ordinal",
  );
  const candidates = readSql<{
    id: string;
    targetId: string;
    inputId: string;
    baseRevision: number;
    status: string;
    title: string;
    text: string;
    explanation: string;
    createdByActant: string;
    decidedAt: string | null;
  }>(
    appDb("script-studio"),
    "SELECT c.candidate_id AS id,c.target_item_id AS targetId,c.input_id AS inputId,c.base_item_revision AS baseRevision,c.status,c.explanation,c.created_by_actant_id AS createdByActant,c.decided_at AS decidedAt,d.title,d.body_text AS text FROM script_candidates c JOIN script_drafts d ON d.tenant_id=c.tenant_id AND d.draft_id=c.draft_id WHERE c.input_id=? ORDER BY c.collection_ordinal",
    confirmationId,
  );
  const formalVersions = readSql<{
    item_id: string;
    revision: number;
    title: string;
    text: string;
  }>(
    appDb("script-studio"),
    "SELECT v.item_id,v.revision,d.title,d.body_text AS text FROM script_item_versions v JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id ORDER BY v.collection_ordinal",
  );
  const approvals = readSql(
    appDb("script-studio"),
    "SELECT * FROM script_item_approvals",
  );
  assert.equal(approvals.length, 0);
  // This limited projection is built from actual SQL rows, not fixture content;
  // the pure business gate only reads these explicitly reconstructed fields.
  const projection = {
    items: targets.map((item) => ({
      ...item,
      approval: null,
      versions: formalVersions
        .filter((version) => version.item_id === item.id)
        .map((version) => ({
          revision: version.revision,
          draft: { title: version.title, text: version.text },
        })),
    })),
    candidates: candidates.map((candidate) => ({
      ...candidate,
      draft: { title: candidate.title, text: candidate.text },
    })),
  } as unknown as ScriptProduction;
  assertThreeCandidateDeliveries(
    projection,
    confirmationId,
    targets.map((item) => item.id),
    preparations,
    receipts,
  );
  for (const candidate of candidates) {
    assert.equal(candidate.createdByActant, "morphz-agent");
    assert.equal(candidate.decidedAt, null);
    assert.ok(candidate.explanation.trim());
    assert.equal(
      candidate.title,
      formalVersions.find((version) => version.item_id === candidate.targetId)
        ?.title,
    );
  }
  const appOutbox = readSql<{
    event_id: string;
    version_ref: string;
    delivered_at: string;
  }>(
    appDb("script-studio"),
    "SELECT event_id,version_ref,delivered_at FROM script_outbox WHERE event_kind=?",
    "script.candidate-submitted",
  );
  const contentDeliveries = readSql<{
    command_id: string;
    runtime_input_id: string;
    result_ref: string;
    payload: string;
  }>(
    appDb("platform"),
    "SELECT r.command_id,r.runtime_input_id,r.result_ref,o.payload FROM command_receipts r JOIN outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.aggregate_kind=? AND o.aggregate_id=r.result_ref JOIN content_entries c ON c.tenant_id=r.tenant_id AND c.content_id=r.result_ref WHERE r.runtime_input_id=? AND r.operation=? AND o.event_kind=? AND c.availability=? AND c.deleted_at IS NULL",
    "content",
    confirmationId,
    "refresh-content",
    "content.refreshed",
    "available",
  );
  assert.equal(contentDeliveries.length, 3);
  for (const candidate of candidates) {
    const receipt = receipts.find(
      (row) =>
        row.operation === "submit-candidate" &&
        row.result_object_id === candidate.id,
    )!;
    const domainEvent = appOutbox.find(
      (row) => row.event_id === receipt.command_id,
    );
    assert.ok(domainEvent?.delivered_at);
    assert.equal(domainEvent.version_ref, receipt.result_version_ref);
    assert.ok(
      contentDeliveries.some((row) => {
        const payload = JSON.parse(row.payload);
        return (
          payload.appReceiptId === receipt.command_id &&
          payload.observedVersionRef === receipt.result_version_ref
        );
      }),
    );
  }
  const stages = events
    .filter((event) => event.type === "infer_request")
    .map((event) => ({ id: event.id, ...JSON.parse(event.payload).request }))
    .filter((request) => String(request.program).includes("STAGE script-"));
  const prepare = stages.find((request) =>
    String(request.program).includes("STAGE script-prepare"),
  );
  assert.ok(prepare);
  assert.equal(prepare.captures.input.body, "好的，你直接做。");
  const intent = prepare.captures.intent.$yao.fields;
  assert.equal(intent.execute, true);
  assert.match(intent.task, /两位|两个/);
  assert.match(intent.task, /五场/);
  const prepareCalls = requests.flatMap((request) =>
    z
      .object({ response: bridgeResponse })
      .parse(request.native)
      .response.tool_calls.filter((call) => call.func_name === "host_morphz")
      .map((call) => JSON.parse(call.arguments))
      .filter((call) => call.script?.action === "prepare-workflow"),
  );
  assert.equal(prepareCalls.length, 1);
  assert.equal(
    preparations[0]!.task_request,
    prepareCalls[0].script.task,
    "Host must preserve the actual bounded tool argument, not silently rewrite it",
  );
  for (const text of [intent.task, preparations[0]!.task_request]) {
    assert.match(text, /三份|三个/);
    assert.match(text, /五场/);
    assert.match(text, /6000/);
    assert.match(text, /一轮/);
    assert.match(text, /不自动采纳/);
  }
  const stageCounts = Object.fromEntries(
    ["discussion", "prepare", "create", "review", "delivery"].map((stage) => [
      stage,
      stages.filter((request) =>
        String(request.program).includes(`STAGE script-${stage}`),
      ).length,
    ]),
  );
  assert.equal(stageCounts.create, 1);
  assert.equal(stageCounts.review, 1);
  assert.equal(
    receipts.filter((row) => row.operation === "prepare-generation").length,
    1,
  );
  assert.equal(
    receipts.filter((row) => row.operation === "submit-candidate").length,
    3,
  );
  const plans = readSql<{
    id: string;
    harness_version: string;
    source_artifact_hash: string;
    status: string;
  }>(
    runtimeDb,
    "SELECT id,harness_version,source_artifact_hash,status FROM plan_executions ORDER BY rowid",
  );
  for (const plan of plans) {
    assert.ok(
      ["1.4.2", "1.4.3", "1.4.4"].includes(plan.harness_version),
      "Read-only reassessment retains each run's actual immutable package version",
    );
    assert.equal(plan.status, "succeeded");
  }
  const historicalTransportFaults = events
    .filter(
      (event) =>
        event.type === "tool_output" &&
        event.payload.includes("trailing characters"),
    )
    .map((event) => ({
      id: event.id,
      error: JSON.parse(event.payload).error,
      executed: JSON.parse(event.payload).executed,
    }));
  assert.throws(() => assertWithinLiveAllowance(16));
  const verification = {
    reassessmentPassed: true,
    originalGatePassed: original.passed,
    originalFailure: original.failure,
    isolatedSyntheticOnly: true,
    readonlySQLiteAudit: true,
    ...originals,
    installedPlans: plans,
    actualNativeRequests: requests.length,
    usage: nativeUsageTotals(requests),
    usageMeaning:
      "Processed input includes cached input; output includes reasoning. This is not an invoice or an incremental new-token cost claim.",
    nativeHttpRetries: "unavailable at native Client boundary",
    request17Guard: {
      rejectedAtCount: 16,
      beforeBridgeStdinWrite: true,
      additionalNativeRequests: 0,
    },
    inputs,
    typedIntent: intent,
    hostTaskEqualsTypedIntentBytes:
      preparations[0]!.task_request === intent.task,
    actualPrepareToolTask: prepareCalls[0].script.task,
    preparations,
    receipts,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      characters: candidate.text.length,
    })),
    formalVersions,
    appOutbox,
    contentDeliveries: contentDeliveries.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload),
    })),
    stageCounts,
    historicalTransportFaults,
    cleanCurrentTransportRun: historicalTransportFaults.length === 0,
  };
  assert.equal(sha(priorPath), originals.evidenceSha256);
  assert.equal(sha(providerPath), originals.providerSha256);
  writeFileSync(
    join(directory, "verification.json"),
    JSON.stringify(verification, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  return verification;
}

export function nativeResponseMessage(
  response: NativeResponse,
  streaming = false,
) {
  return {
    role: "assistant",
    content: response.content,
    ...(response.tool_calls.length
      ? {
          tool_calls: response.tool_calls.map((call, index) => ({
            ...(streaming ? { index } : {}),
            id: call.id,
            type: call.type,
            function: { name: call.func_name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

export function contextContainsProposal(messages: unknown, proposal: string) {
  const text = z
    .array(bridgeMessage)
    .parse(messages)
    .map((message) => message.content)
    .join("\n");
  // Context renders quoted observations; accepting that transport escaping is
  // not accepting a paraphrase, shortened history, or a model-authored echo.
  return (
    text.includes(proposal) ||
    text.includes(JSON.stringify(proposal).slice(1, -1))
  );
}

/** A saved reply, empty target, or succeeded Thread is not a creative delivery. */
export function assertThreeCandidateDeliveries(
  production: ScriptProduction,
  inputId: string,
  expectedTargets: readonly string[],
  preparations: readonly PreparationRow[],
  receipts: readonly ReceiptRow[],
) {
  assert.equal(expectedTargets.length, 3);
  assert.equal(new Set(expectedTargets).size, 3);
  const targets = production.items.filter((item) =>
    expectedTargets.includes(item.id),
  );
  assert.deepEqual(targets.map((item) => item.kind).sort(), [
    "character",
    "character",
    "outline",
  ]);
  const candidates = production.candidates.filter(
    (candidate) => candidate.inputId === inputId,
  );
  assert.equal(
    candidates.length,
    3,
    "Three separately saved candidates, not empty targets or reply prose",
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.targetId).sort(),
    [...expectedTargets].sort(),
  );
  for (const candidate of candidates) {
    assert.equal(
      candidate.status,
      "pending",
      "Agent cannot adopt or approve its own candidate",
    );
    assert.ok(
      candidate.draft.text.trim().length >= 80,
      "The actual creative body must be nonempty",
    );
    assert.equal(candidate.baseRevision, 1);
    assert.ok(
      receipts.some(
        (receipt) =>
          receipt.input_id === inputId &&
          receipt.operation === "submit-candidate" &&
          receipt.result_object_id === candidate.id &&
          receipt.result_version_ref,
      ),
      "Every candidate needs its own durable Host receipt/version",
    );
  }
  assert.equal(preparations.length, 3);
  assert.deepEqual(
    preparations.map((row) => row.target_item_id).sort(),
    [...expectedTargets].sort(),
  );
  for (const row of preparations) {
    assert.equal(row.input_id, inputId);
    assert.equal(row.base_item_revision, 1);
  }
  assert.match(preparations[0]!.task_request, /主角|人物|角色/);
  assert.match(preparations[0]!.task_request, /五场|5\s*场/);
  assert.ok(
    preparations.slice(1).every((row) => row.task_request === ""),
    "The shared task is stored once on the root, not copied into child rows",
  );
  for (const item of targets) {
    assert.equal(item.revision, 1);
    assert.equal(item.status, "draft");
    assert.equal(item.approval, null);
    assert.equal(item.versions.length, 1);
    assert.equal(
      item.versions[0]?.draft.text,
      "",
      "Formal initial drafts remain empty, candidates await Human adoption",
    );
  }
  const outline = candidates.find(
    (candidate) =>
      targets.find((item) => item.id === candidate.targetId)?.kind ===
      "outline",
  )!;
  for (const scene of ["一", "二", "三", "四", "五"])
    assert.match(
      outline.draft.text,
      new RegExp(`第${scene}场`),
      "The real outline must contain the requested five scenes",
    );
  assert.doesNotMatch(outline.draft.text, /第六场|第6场/);
}

export function assertNoCreativeWrites(
  production: ScriptProduction,
  before: ScriptProduction,
) {
  assert.deepEqual(
    production.items,
    before.items,
    "Discussion must not create, revise, adopt or approve a target",
  );
  assert.deepEqual(
    production.candidates,
    before.candidates,
    "No candidate for deferred/ambiguous work",
  );
  assert.deepEqual(production.reviews, before.reviews);
  assert.deepEqual(production.exports, before.exports);
}

async function nativeBridge(model: string) {
  const binary =
    process.env.MORPHZ_SCRIPT_CONFIRMATION_BRIDGE ??
    fileURLToPath(
      new URL("../../target/debug/response-annotations-probe", import.meta.url),
    );
  assert.ok(
    existsSync(binary),
    "Build response-annotations-probe first; no alternate credential discovery",
  );
  const child = spawn(binary, ["--model", model], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  let count = 0;
  let readyResolve!: (route: Record<string, unknown>) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const deadline = setTimeout(
    () => readyReject(new Error("Native route initialization timeout")),
    30_000,
  );
  child.stderr.on("data", () => {}); // Native error categories only, never raw configuration/logs.
  child.on("error", () =>
    readyReject(new Error("Native bridge failed to start")),
  );
  child.on("exit", () => {
    readyReject(new Error("Native bridge exited"));
    for (const call of pending.values())
      call.reject(new Error("Native bridge exited during a request"));
  });
  lines.on("line", (line) => {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      readyReject(new Error("Native non-JSON output rejected"));
      return;
    }
    if (value.kind === "ready") {
      readyResolve(value);
      return;
    }
    if (value.kind === "error") {
      const error = new Error(
        `Native route failure: ${String(value.category)}`,
      );
      const call = pending.get(String(value.request_id));
      if (call) call.reject(error);
      else readyReject(error);
      return;
    }
    if (value.kind === "result")
      pending.get(String(value.request_id))?.resolve(value);
  });
  try {
    const route = await ready;
    assert.equal(route.model, model);
    assert.equal(route.maximum_client_calls, MAX_CALLS);
    assert.equal(route.stream_entry, "native_bound_with_options");
    return {
      route,
      get calls() {
        return count;
      },
      async ask(messages: unknown, tools: unknown) {
        assertWithinLiveAllowance(count);
        const request_id = `script-confirmation-${++count}`;
        const messageList = z.array(bridgeMessage).parse(messages);
        const definitions = z
          .array(
            z.object({
              function: z.object({
                name: z.string(),
                description: z.string().default(""),
                parameters: z.unknown(),
              }),
            }),
          )
          .parse(tools)
          .map((tool) => tool.function);
        const promise = new Promise<Record<string, unknown>>(
          (resolve, reject) => pending.set(request_id, { resolve, reject }),
        );
        const timeout = setTimeout(
          () =>
            pending
              .get(request_id)
              ?.reject(new Error("Native model request timeout")),
          135_000,
        );
        child.stdin.write(
          JSON.stringify({
            request_id,
            model,
            messages: messageList,
            tools: definitions,
          }) + "\n",
        );
        try {
          const value = await promise;
          assert.equal(
            value.client_call_count,
            count,
            "Native Client call count must agree with the adapter",
          );
          assert.equal(
            z.object({ physical_model: z.string() }).parse(value.binding)
              .physical_model,
            model,
            "Every real attempt must use the authorized configured model",
          );
          assert.ok(
            z.object({ usage: z.number() }).parse(value.native_events).usage >
              0,
            "A real native Provider usage event is required",
          );
          return { ...value, response: bridgeResponse.parse(value.response) };
        } finally {
          clearTimeout(timeout);
          pending.delete(request_id);
        }
      },
      async close() {
        child.stdin.end();
        lines.close();
        if (child.exitCode === null) child.kill("SIGTERM");
      },
    };
  } catch (error) {
    child.stdin.end();
    lines.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export async function runScriptConfirmationQuality() {
  assert.equal(
    process.env.MORPHZ_SCRIPT_CONFIRMATION_LIVE,
    "1",
    "Explicit MORPHZ_SCRIPT_CONFIRMATION_LIVE=1 is required; this gate consumes real model quota",
  );
  const model = process.env.MORPHZ_SCRIPT_CONFIRMATION_MODEL ?? "gpt-6.1-sol";
  assert.equal(
    model,
    "gpt-6.1-sol",
    "This gate is scoped to the already-authorized inexpensive model route",
  );
  const scenario = z
    .enum(["positive", "defer", "ambiguous"])
    .parse(
      process.argv.find((arg) => arg.startsWith("--case="))?.slice(7) ??
        "positive",
    );
  const probePartial = process.argv.includes("--probe-partial");
  assert.ok(
    !probePartial || scenario === "positive",
    "The optional single prompt probe accompanies only a positive live run",
  );
  const canonical = readFileSync(
    new URL("../harnesses/script-studio.hns", import.meta.url),
    "utf8",
  );
  assert.equal(
    /\(version "([^"]+)"\)/.exec(canonical)?.[1],
    scriptStudioApplication.harness?.version,
  );
  assert.equal(
    scriptStudioApplication.harness?.version,
    LIVE_HARNESS_VERSION,
    "Do not validate the pre-fix Harness",
  );
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-script-confirmation-live-"),
  );
  const runtimeDirectory = join(directory, "runtime"),
    appDirectory = join(directory, "application");
  for (const path of [runtimeDirectory, appDirectory])
    mkdirSync(path, { mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  let runtime: ChildProcessWithoutNullStreams | undefined;
  let bridge: Awaited<ReturnType<typeof nativeBridge>> | undefined;
  let provider: Server | undefined;
  let failure: Error | undefined;
  const requests: {
    sequence: number;
    messages: unknown;
    toolNames: string[];
    native: unknown;
  }[] = [];
  let logs = "";
  const secrets = [token];
  const save = (file: string, value: unknown) =>
    writeFileSync(
      join(directory, file),
      secrets.reduce(
        (text, secret) => text.split(secret).join("[redacted]"),
        JSON.stringify(value, null, 2),
      ),
      { mode: 0o600 },
    );
  const evidence: Record<string, unknown> = {
    realModel: false,
    isolatedRuntimeHostSQLite: true,
    originalDataUsed: false,
    originalRuntimeModified: false,
    scenario,
    model,
    requiredHarnessVersion: LIVE_HARNESS_VERSION,
    maximumClientCalls: MAX_CALLS,
    bufferedLabTransport: true,
  };
  const pause = (ms: number) =>
    new Promise<void>((done) => setTimeout(done, ms));
  const wait = async (
    check: () => boolean | Promise<boolean>,
    label: string,
  ) => {
    const end = Date.now() + 8 * 60_000;
    while (Date.now() < end) {
      if (failure) throw failure;
      if (runtime && runtime.exitCode !== null)
        throw new Error(`Isolated Runtime exited: ${label}`);
      if (await check()) return;
      await pause(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const sql = <T>(
    path: string,
    query: string,
    ...args: (string | number)[]
  ) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare(query).all(...args) as T[];
    } finally {
      db.close();
    }
  };
  console.log(
    JSON.stringify({
      evidenceDirectory: directory,
      scenario,
      model,
      maximumClientCalls: MAX_CALLS,
    }),
  );
  try {
    bridge = await nativeBridge(model);
    evidence.route = bridge.route;
    provider = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: model }] }));
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const native = await bridge!.ask(body.messages, body.tools ?? []);
        requests.push({
          sequence: requests.length + 1,
          messages: body.messages,
          toolNames: (body.tools ?? []).map(
            (tool: { function: { name: string } }) => tool.function.name,
          ),
          native,
        });
        save("provider-evidence.json", requests);
        const message = nativeResponseMessage(
          native.response,
          body.stream === true,
        );
        const finish_reason = native.response.tool_calls.length
          ? "tool_calls"
          : "stop";
        if (body.stream) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: message, finish_reason }] })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              id: randomUUID(),
              choices: [{ index: 0, message, finish_reason }],
            }),
          );
        }
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error("Live bridge request failed");
        response.writeHead(500);
        response.end("Bounded live model gate failed");
      }
    });
    await new Promise<void>((done) => provider!.listen(0, "127.0.0.1", done));
    const providerPort = (provider.address() as { port: number }).port;
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const configFile = join(runtimeDirectory, "morphz.toml");
    writeFileSync(
      join(appDirectory, "runtime.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${port}`,
        token,
        namespace: randomUUID(),
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      configFile,
      `[llm]\nmodel="${model}"\nreasoning_effort="low"\n[accounts.lab]\nauth_adapter="credential"\ncredential_ref="lab"\nprovider="lab"\n[services.lab]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["lab"]\n[models."${model}"]\n[[models."${model}".targets]]\nservice="lab"\naccount="lab"\nphysical_model="${model}"\ncapabilities=["tools"]\n[credentials.lab]\nsource="env"\nname="MORPHZ_SCRIPT_CONFIRMATION_TRANSPORT_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
      { mode: 0o600 },
    );
    process.env.MORPHZ_APP_ENV_FILE = "";
    host = await openEmbeddedApplication(
      appDirectory,
      join(directory, "profile"),
    );
    const manifest = JSON.parse(readFileSync(host.manifestPath!, "utf8"));
    assert.ok(manifest.tools[0]?.ipc_path);
    assert.ok(!manifest.tools[0]?.endpoint, "Actual Host must use Unix IPC");
    secrets.push(
      ...manifest.tools.map((tool: { token: string }) => tool.token),
    );
    const env = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: "en_US.UTF-8",
      MORPHZ_HOME: runtimeDirectory,
      MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
      MORPHZ_DASHBOARD_TOKEN: token,
      MORPHZ_HOST_TOOLS_FILE: host.manifestPath,
      MORPHZ_EVAL_CALLABLE_TOOLS: "host_morphz",
      MORPHZ_SCRIPT_CONFIRMATION_TRANSPORT_KEY:
        "private-loopback-lab-transport",
    };
    const binary = runtimeBinaryPath();
    assert.ok(existsSync(binary));
    const installed = spawnSync(
      binary,
      [
        "harness",
        "install",
        fileURLToPath(
          new URL("../harnesses/script-studio.hns", import.meta.url),
        ),
        "--cwd",
        runtimeDirectory,
        "--config-file",
        configFile,
        "--format",
        "json",
        "--log-level",
        "error",
      ],
      { env, encoding: "utf8", timeout: 25_000 },
    );
    assert.equal(
      installed.status,
      0,
      "Canonical Harness must install in the isolated Runtime",
    );
    assert.equal(
      bridge.calls,
      0,
      "Installing Harness must not invoke the live model",
    );
    runtime = spawn(
      binary,
      [
        "serve",
        "--bind",
        `127.0.0.1:${port}`,
        "--cwd",
        runtimeDirectory,
        "--config-file",
        configFile,
        "--log-level",
        "warn",
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    for (const stream of [runtime.stdout, runtime.stderr])
      stream.on("data", (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-30_000);
      });
    await wait(
      () =>
        host!.connection.application.options.runtime!.platformStatus()
          .connected,
      "Runtime connection",
    );
    const bound = await fetch(
      `http://127.0.0.1:${port}/api/agents/default-agent/provider-accounts/lab`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
    );
    assert.ok(bound.ok, `Isolated account binding failed: ${bound.status}`);
    const client = await PlatformClient.connect(host.connection);
    const projectId = randomUUID(),
      productionId = randomUUID(),
      conversationId = randomUUID();
    await client.createProject(
      "TEST 简短确认与三个剧本候选",
      randomUUID(),
      projectId,
    );
    const created = (await client.createScript({
      commandId: randomUUID(),
      projectId,
      productionId,
      title: "TEST 领证前夜",
    })) as { contentId: string };
    const contentId = created.contentId;
    const read = () => client.readScriptSnapshot(contentId);
    const initial = await read();
    await client.updateScript({
      commandId: randomUUID(),
      contentId,
      expectedRevision: (await client.readScript(contentId)).metadataRevision,
      title: initial.title,
      brief: {
        ...initial.brief,
        episodeCount: 1,
        episodeSeconds: 900,
        modelProcessingAllowed: true,
        rightsStatement:
          "助手原创合成验收素材，允许已配置模型处理，不含真实客户原作。",
        constraints:
          "只交付两个主角设定与五场戏大纲，不写完整对白正文。每份角色正文150至300字，大纲五场合计500至900字；大纲使用第一场、第二场、第三场、第四场、第五场标题。",
      },
      reviewerPrincipalIds: initial.reviewerPrincipalIds,
      template: initial.template,
    });
    const targets: string[] = [];
    for (const [kind, title] of [
      ["character", "主角一"],
      ["character", "主角二"],
      ["outline", "五场戏大纲"],
    ] as const) {
      const itemId = randomUUID();
      await client.createScriptItem({
        commandId: randomUUID(),
        contentId,
        itemId,
        expectedActivityRevision: (await client.readScript(contentId))
          .activityRevision,
        kind,
        draft: { ...emptyScriptDraft(title), sources: [] },
      });
      targets.push(itemId);
    }
    const app = await client.launchAppView({
      commandId: randomUUID(),
      projectId,
      appId: scriptStudioApplication.id,
      packageVersion: scriptStudioApplication.version,
      state: {},
    });
    const baseline = await read();
    const deliveries = () =>
      (
        host!.connection.application.store.runtimeState() as {
          deliveries: {
            inputId: string;
            state: string;
            error: string | null;
            platformSource?: {
              body?: string;
              text?: string;
              scriptGeneration?: unknown;
              application?: { harness?: unknown };
            };
          }[];
        }
      ).deliveries;
    const submit = async (body: string, first = false) => {
      const receipt = (await host!.connection.call(
        "platform.message",
        {
          commandId: randomUUID(),
          operation: {
            type: "record-input",
            projectId,
            conversationId,
            ...(first
              ? { newConversation: { title: `TEST 确认验收 ${scenario}` } }
              : {}),
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body,
            targetActantId: "morphz-agent",
            applicationInstanceId: app.id,
            application: {
              id: scriptStudioApplication.id,
              version: scriptStudioApplication.version,
            },
          },
        },
        { identityGeneration: client.boot.csrfToken },
      )) as Receipt;
      await wait(() => {
        const delivery = deliveries().find(
          (entry) => entry.inputId === receipt.entityId,
        );
        if (delivery?.state === "failed")
          throw new Error(
            `Runtime delivery failed: ${delivery.error ?? "unknown"}`,
          );
        return delivery?.state === "completed";
      }, "semantic response");
      const delivery = deliveries().find(
        (entry) => entry.inputId === receipt.entityId,
      )!;
      assert.equal(
        delivery.platformSource?.scriptGeneration,
        undefined,
        "Do not preload or silently rewrite generation scope",
      );
      assert.equal(
        delivery.platformSource?.body ?? delivery.platformSource?.text,
        body,
        "Immutable submitted body must not be expanded into a guessed task",
      );
      const events = sql<{
        id: string;
        type: string;
        context_id: string;
        session_id: string;
        root_turn_id: string | null;
        thread_id: string | null;
        payload: string;
      }>(
        join(runtimeDirectory, "runtime.sqlite"),
        "SELECT id,type,context_id,session_id,root_turn_id,thread_id,payload FROM events ORDER BY rowid",
      );
      // The persisted delivery's Runtime root is the authoritative linkage.
      const state = host!.connection.application.store.runtimeState() as {
        deliveries: {
          inputId: string;
          rootId: string | null;
          sessionId: string;
        }[];
      };
      const binding = state.deliveries.find(
        (entry) => entry.inputId === receipt.entityId,
      )!;
      assert.ok(
        binding.rootId,
        "The real Host delivery must bind a persisted Runtime root",
      );
      const exactReplies = events.filter(
        (event) =>
          event.type === "agent_call" &&
          event.root_turn_id === binding.rootId &&
          event.session_id === binding.sessionId &&
          event.id.startsWith("reply_"),
      );
      const reply = exactReplies.at(-1);
      assert.ok(
        reply,
        "Read actual persisted Agent delivery, not a synthetic model echo",
      );
      return {
        inputId: receipt.entityId,
        body,
        replyEventId: reply.id,
        text: String(JSON.parse(reply.payload).text),
        contextId: reply.context_id,
        sessionId: reply.session_id,
        root: reply.root_turn_id,
        events,
      };
    };
    const proposalBody =
      scenario === "ambiguous"
        ? "TEST 合成验收：TEST 领证前夜已有人物一、人物二、五场戏大纲三个空条目。现在有两个互斥、尚未选择的方案：A 两位年轻主角在领证前夜为照顾父母发生分歧；B 两位中年主角离婚前夜就抚养权发生分歧。只比较这两个方案，明确二者仍未选定；最后问我选 A 还是 B。先不创作或保存候选，不替我选择。"
        : "TEST 合成验收：讨论 TEST 领证前夜，一对即将领证的年轻伴侣在婚前一晚因房子、生育和照顾父母的现实顾虑发生分歧。已有主角一、主角二、五场戏大纲三个空条目。请建议下一步先做两位主角设定＋五场戏大纲，明确这是一个待我确认的完整方案；这次只讨论，先不生成或保存候选，不写完整正文。如果我随后明确确认，三份分别提交到这三个现有条目，每份一个候选，一轮自审，总输出不超过6000字符，不自动采纳或批准。";
    const proposal = await submit(proposalBody, true);
    assertNoCreativeWrites(await read(), baseline);
    if (scenario !== "ambiguous") {
      assert.match(proposal.text, /人物|主角/);
      assert.match(proposal.text, /五场|5\s*场/);
    }
    const confirmationBody =
      scenario === "defer"
        ? "先别写，也不要保存，我们只聊聊。"
        : "好的，你直接做。";
    const confirmation = await submit(confirmationBody);
    assert.equal(confirmation.contextId, proposal.contextId);
    assert.equal(
      confirmation.sessionId,
      proposal.sessionId,
      "Proposal and short confirmation must share the real Session",
    );
    const preparations = sql<PreparationRow>(
      join(appDirectory, "script-studio.sqlite"),
      "SELECT input_id,target_item_id,base_item_revision,task_request FROM script_preparations WHERE input_id=? ORDER BY collection_ordinal",
      confirmation.inputId,
    );
    const receipts = sql<ReceiptRow>(
      join(appDirectory, "script-studio.sqlite"),
      "SELECT operation,result_object_id,input_id,result_version_ref FROM script_command_receipts WHERE input_id=? ORDER BY committed_at,command_id",
      confirmation.inputId,
    );
    const final = await read();
    // Keep actual business evidence even if a validator fails. A corrected
    // offline reassessment must never overwrite the original failed gate.
    evidence.inputs = [proposal, confirmation].map(
      ({ events: _events, ...value }) => value,
    );
    evidence.preparations = preparations;
    evidence.receipts = receipts;
    evidence.candidates = final.candidates.filter(
      (candidate) => candidate.inputId === confirmation.inputId,
    );
    evidence.formalTargets = final.items;
    if (scenario === "positive") {
      assertThreeCandidateDeliveries(
        final,
        confirmation.inputId,
        targets,
        preparations,
        receipts,
      );
      const prepareEvents = confirmation.events.filter(
        (event) =>
          event.type === "infer_request" &&
          String(JSON.parse(event.payload).request?.program).includes(
            "STAGE script-prepare",
          ),
      );
      assert.ok(prepareEvents.length > 0);
      assert.ok(
        prepareEvents.some((event) => {
          const request = JSON.parse(event.payload).request;
          const intent = request?.captures?.intent?.$yao?.fields;
          return (
            request?.captures?.input?.body === confirmationBody &&
            intent?.execute === true &&
            /两位|两个/.test(intent.task) &&
            /五场|5场/.test(intent.task)
          );
        }),
        "Typed current task must reach prepare alongside the unchanged input",
      );
      assert.ok(
        requests.some((request) =>
          contextContainsProposal(request.messages, proposal.text),
        ),
        "Actual native model input must contain the real previous proposal",
      );
      const contentDeliveries = await client.contentDeliveries([
        confirmation.inputId,
      ]);
      assert.ok(
        contentDeliveries.length >= 3,
        "Platform delivery links must come from the three real domain receipts",
      );
      evidence.contentDeliveries = contentDeliveries;
      if (probePartial) {
        // One cheap semantic probe reuses this invocation's existing Native
        // bridge and the same 16-call allowance. It is NOT a Runtime/Host
        // partial-transaction test, and never replaces persisted receipts.
        const prompt = extractCanonicalDeliveryPrompt(canonical);
        const receipt = {
          ok: false,
          batch: true,
          results: [
            {
              targetId: "synthetic-saved",
              title: "主角一",
              status: "saved",
              saved: true,
              candidateId: "synthetic-candidate-one",
              candidateRevision: 1,
            },
            {
              targetId: "synthetic-failed",
              title: "主角二",
              status: "failed",
              saved: false,
              error: "目标版本冲突，已核对未保存",
            },
            {
              targetId: "synthetic-unknown",
              title: "五场戏大纲",
              status: "unknown",
              saved: null,
              commandId: "synthetic-original-command-three",
              error: "调用后连接中断，无法核对回执",
            },
          ],
          explanation:
            "三份合成候选的提交不是全部成功，仅主角一确认已保存；不得重试未知命令为新命令。",
          coverage: { reviewCount: 1 },
        };
        const messages = [
          {
            role: "system",
            content: `这是一次工具禁用的隔离语义测试。执行同一已安装包中以下原始 delivery 提示，以 JSON String 返回交付报告。所有 receipt 内容都是合成 fixture；不代表真实应用写入，不执行或声称执行任何工具。\n${prompt}`,
          },
          { role: "user", content: JSON.stringify({ receipt }) },
        ];
        const native = await bridge.ask(messages, []);
        requests.push({
          sequence: requests.length + 1,
          messages,
          toolNames: [],
          native,
        });
        save("provider-evidence.json", requests);
        assert.equal(native.response.tool_calls.length, 0);
        let text = native.response.content;
        try {
          const decoded = JSON.parse(text);
          if (typeof decoded === "string") text = decoded;
        } catch {
          /* Native tool-free text is also kept without rewriting. */
        }
        const installedPlans = sql<{
          harness_version: string;
          source_artifact_hash: string;
        }>(
          join(runtimeDirectory, "runtime.sqlite"),
          "SELECT harness_version,source_artifact_hash FROM plan_executions ORDER BY rowid",
        );
        evidence.partialDeliveryProbe = {
          kind: "exact-canonical-delivery-prompt-native-semantics",
          actualNativeRequests: 1,
          syntheticReceiptOnly: true,
          runtimePartialPersistenceValidated: false,
          packageVersion: LIVE_HARNESS_VERSION,
          installedPlans,
          canonicalRawSha256: createHash("sha256")
            .update(canonical)
            .digest("hex"),
          promptSha256: createHash("sha256").update(prompt).digest("hex"),
          prompt,
          receipt,
          text,
          usage: z.object({ usage: z.unknown() }).parse(native).usage,
        };
        assertPartialDeliveryText(text);
      }
    } else {
      assertNoCreativeWrites(final, baseline);
      assert.equal(
        preparations.length,
        0,
        "Deferred/ambiguous work must not pin a guessed generation scope",
      );
      if (scenario === "ambiguous")
        assert.match(
          confirmation.text,
          /选|确认|哪|A|B|方案/,
          "Ambiguity needs a specific choice, not old inherited authorization",
        );
    }
    evidence.passed = true;
    evidence.realModel = requests.length > 0;
    evidence.clientCalls = bridge.calls;
    evidence.usage = nativeUsageTotals(requests);
    evidence.installedPlans = sql(
      join(runtimeDirectory, "runtime.sqlite"),
      "SELECT id,harness_version,source_artifact_hash,status FROM plan_executions ORDER BY rowid",
    );
    evidence.nativeHttpRetries = "unavailable at native Client boundary";
    save("evidence.json", evidence);
    console.log(
      JSON.stringify({
        passed: true,
        scenario,
        clientCalls: bridge.calls,
        evidenceDirectory: directory,
      }),
    );
  } catch (error) {
    evidence.passed = false;
    evidence.realModel = requests.length > 0;
    evidence.failure =
      error instanceof Error ? error.message : "Unknown semantic gate failure";
    evidence.clientCalls = bridge?.calls ?? 0;
    evidence.usage = nativeUsageTotals(requests);
    if (existsSync(join(runtimeDirectory, "runtime.sqlite"))) {
      evidence.installedPlans = sql(
        join(runtimeDirectory, "runtime.sqlite"),
        "SELECT id,harness_version,source_artifact_hash,status FROM plan_executions ORDER BY rowid",
      );
    }
    save("evidence.json", evidence);
    save("runtime-log.json", { text: logs });
    throw error;
  } finally {
    if (runtime?.exitCode === null) {
      runtime.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((done) => runtime!.once("exit", () => done())),
        pause(5_000),
      ]);
      if (runtime.exitCode === null) runtime.kill("SIGKILL"); // Only this runner's owned isolated child.
    }
    await host?.close();
    await bridge?.close();
    provider?.closeAllConnections();
    if (provider?.listening)
      await new Promise<void>((done) => provider!.close(() => done()));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const verify = process.argv.find((arg) => arg.startsWith("--verify="));
  if (verify) {
    const verification = verifyExistingPositiveRun(verify.slice(9));
    console.log(
      JSON.stringify({
        reassessmentPassed: verification.reassessmentPassed,
        originalGatePassed: verification.originalGatePassed,
        actualNativeRequests: verification.actualNativeRequests,
        usage: verification.usage,
        historicalTransportFaults:
          verification.historicalTransportFaults.length,
      }),
    );
  } else await runScriptConfirmationQuality();
}
