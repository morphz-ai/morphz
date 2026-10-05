import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import {
  profileActualTransportFixture,
  profileFixtureReplyCarrier,
} from "./profile-actual-transport-fixture.js";
import {
  packCognitiveAuthor,
  startPackedAuthor,
  stopPackedAuthor,
} from "./fixtures/cognitive-app-packed-author.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import { objectToolName } from "../packages/core/src/application-names.js";
import { parseCognitiveAppCommandResult } from "../packages/core/src/cognitive-app-api.js";
import {
  parseCognitiveAppDefinition,
  parseProtocolValue,
  type JsonValue,
} from "../packages/cognitive-app-sdk/src/protocol.js";
import { parseDomainActor } from "../packages/cognitive-app-sdk/src/domain-wire.js";
import { taskRunAdmissionSchema } from "../packages/platform/src/task-run-admission.js";
import { stableId } from "../packages/application/src/stable-id.js";

const title =
  "actual Rust scheduled task + infer: cognitive calls retain task-run source and original input provenance";
const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Thread = {
  id: string;
  root_turn_id: string;
  session_id: string;
  executor_kind: string;
  parent_thread_id: string | null;
  status: string;
};
function rows(filename: string, sql: string, ...parameters: string[]) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare(sql).all(...parameters);
  } finally {
    db.close();
  }
}
function object(value: unknown) {
  const parsed = parseProtocolValue(value);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  // Array.isArray does not narrow the SDK's readonly array member in TS.
  // The cast follows the real JSON/object/non-array guards above.
  return parsed as { readonly [key: string]: JsonValue };
}
function latestPhysicalToolText(
  messages: Array<{ role: string; content: unknown }>,
) {
  const latest = messages.filter((message) => message.role === "tool").at(-1);
  assert.ok(latest && typeof latest.content === "string");
  assert.ok(
    latest.content.trimStart().startsWith("{"),
    "Latest physical tool rejected: " + latest.content.slice(0, 2000),
  );
  const envelope = parseProtocolValue(JSON.parse(latest.content));
  assert.ok(
    envelope && typeof envelope === "object" && !Array.isArray(envelope),
  );
  assert.ok("output_state" in envelope && envelope.output_state === "content");
  assert.ok(
    "observation_ref" in envelope &&
      typeof envelope.observation_ref === "string",
  );
  assert.match(envelope.observation_ref, /^@e\d+$/);
  assert.ok("result" in envelope && typeof envelope.result === "string");
  return envelope.result;
}
function latestPhysicalHostResult(
  messages: Array<{ role: string; content: unknown }>,
) {
  const text = latestPhysicalToolText(messages);
  assert.ok(
    text.trimStart().startsWith("{"),
    "Latest physical Host result rejected: " + text.slice(0, 2000),
  );
  const value = parseProtocolValue(JSON.parse(text));
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok(
    "ok" in value && value.ok === true,
    "Only the latest physical Host result may satisfy this round",
  );
  return value;
}

type ModelRequest = {
  messages: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
};
type ModelResponse = { name: string; arguments: unknown } | { content: string };
/** Explicitly local second HTTP hop supplies the typed infer JSON final.
 * Neither hop delegates to a real provider. The first proxy still records
 * actual Rust bytes; its realCalls counter here means local controlled hops. */
async function controlledModel(
  select: (request: ModelRequest) => ModelResponse,
) {
  const key = randomBytes(32).toString("hex");
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer " + key);
      assert.ok(++calls <= 24);
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        assert.ok(length <= 2 * 1024 * 1024);
        chunks.push(chunk);
      }
      const input = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as ModelRequest;
      assert.ok(Array.isArray(input.messages));
      const output = select(input);
      const message =
        "content" in output
          ? { role: "assistant", content: output.content }
          : {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  index: 0,
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: output.name,
                    arguments: JSON.stringify(output.arguments),
                  },
                },
              ],
            };
      const finish = "content" in output ? "stop" : "tool_calls";
      if (input.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: randomUUID(),
            choices: [{ index: 0, message, finish_reason: finish }],
          }),
        );
      }
    } catch {
      response.writeHead(500).end("Isolated model fixture rejected request");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    key,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get calls() {
      return calls;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Canonical Rust, its actual accepted Schedule/Thread/Event lineage, the
 * production Platform admission/dispatcher, shared Service and independently
 * installed author originals. Only model HTTP responses are controlled. No
 * source record, identity, Runtime event or business authorization is mocked. */
test(
  title,
  {
    skip: process.env.MORPHZ_COGNITIVE_SOURCES_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async (t) => {
    const packed = packCognitiveAuthor();
    const projectId = "cognitive_sources_" + randomUUID().replaceAll("-", "");
    const taskId = "task_" + randomUUID().replaceAll("-", "");
    const inputMarker = "ACTUAL_COGNITIVE_SOURCE_INPUT_" + randomUUID();
    const scheduleMarker = "ACTUAL_COGNITIVE_SOURCE_SCHEDULE_" + randomUUID();
    const inferMarker = "ACTUAL_COGNITIVE_SOURCE_INFER_" + randomUUID();
    const credential = randomBytes(32).toString("hex");
    const authorDb = join(packed.directory, "author.sqlite");
    const bootstrap = join(packed.directory, "author-bootstrap.json");
    let author: Awaited<ReturnType<typeof startPackedAuthor>> | undefined;
    let host:
      Awaited<ReturnType<typeof profileActualTransportFixture>> | undefined;
    let hostDirectory = "",
      tenantId = "";
    const rounds = new Map<string, number>();
    const errors: string[] = [];
    const selected: Array<{ threadId: string; name: string }> = [];
    let startedEventId: string | undefined;
    let createdCommandId: string | undefined;
    let inferCommandId: string | undefined;
    let scheduledThreadId: string | undefined;
    let model: Awaited<ReturnType<typeof controlledModel>> | undefined;
    const target = {
      appId: definition.id,
      version: definition.version,
      connectionId: "runtime-source-connection",
    };
    try {
      const fixtureOptions = {
        // Explicit trusted test startup; omission preserves the legacy fixture.
        // The shared fixture's owner adds this lifecycle hook, not this test.
        startTaskDispatcher: true,
        evalCallableTools: [objectToolName],
        cognitiveHost: async (scope: {
          directory: string;
          tenantId: string;
        }) => {
          hostDirectory = scope.directory;
          tenantId = scope.tenantId;
          writeFileSync(
            bootstrap,
            JSON.stringify({
              format: "cognitive-notes-bootstrap/v1",
              integrations: [
                {
                  credentialSha256: createHash("sha256")
                    .update(credential)
                    .digest("hex"),
                  issuer: "isolated_runtime_sources",
                  tenantId,
                  principalId: localAccess.principalId,
                  humanActantId: localAccess.actantId,
                  agentActantIds: [morphzAgentAccess.actantId],
                  projects: [{ projectId, read: true, write: true }],
                },
              ],
            }),
            { mode: 0o600 },
          );
          author = await startPackedAuthor(packed.root, authorDb, bootstrap);
          const bindingsFile = join(scope.directory, "cognitive-bindings.json");
          writeFileSync(
            bindingsFile,
            JSON.stringify({
              format: "morphz-host-cognitive-bindings/v1",
              issuer: "isolated_runtime_sources",
              bindings: [
                {
                  tenantId,
                  principalId: localAccess.principalId,
                  appId: definition.id,
                  serviceId: author.ready.serviceId,
                  dataAuthorityId: author.ready.dataAuthorityId,
                  baseUrl: `http://127.0.0.1:${author.ready.port}`,
                  credentialEnv:
                    "MORPHZ_APP_COGNITIVE_CREDENTIAL_SOURCE_FIXTURE",
                  current: true,
                  approvedLoopback: {
                    host: "127.0.0.1" as const,
                    port: author.ready.port,
                  },
                },
              ],
            }),
            { mode: 0o600 },
          );
          return {
            bindingsFile,
            secrets: (name: string) =>
              name === "MORPHZ_APP_COGNITIVE_CREDENTIAL_SOURCE_FIXTURE"
                ? credential
                : undefined,
          };
        },
        responseFor: (request: {
          messages: Array<{ role: string; content: unknown }>;
          [key: string]: unknown;
        }): ModelResponse => {
          try {
            assert.ok(host, "Actual Host must exist before accepting an input");
            const text = request.messages
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              )
              .join("\n");
            const start = text.indexOf("(current-activation");
            const match =
              start >= 0
                ? /\(root-turn\s+\(id\s+("(?:[^"\\]|\\.)*"|[^\s)]+)\)/.exec(
                    text.slice(start),
                  )
                : null;
            const root = match
              ? match[1]!.startsWith('"')
                ? (JSON.parse(match[1]!) as string)
                : match[1]!
              : undefined;
            const threads = root
              ? host.sql<Thread>(
                  "SELECT id,root_turn_id,session_id,executor_kind,parent_thread_id,status FROM threads WHERE root_turn_id=?",
                  root,
                )
              : host.sql<Thread>(
                  "SELECT id,root_turn_id,session_id,executor_kind,parent_thread_id,status FROM threads WHERE executor_kind='plan_infer' AND status='open'",
                );
            assert.equal(threads.length, 1);
            const thread = threads[0]!;
            const round = rounds.get(thread.id) ?? 0;
            rounds.set(thread.id, round + 1);
            assert.ok(
              round < 4,
              "A controlled model may not retry indefinitely",
            );
            const choose = (name: string, arguments_: unknown) => {
              selected.push({ threadId: thread.id, name });
              return { name, arguments: arguments_ };
            };
            if (thread.executor_kind === "plan_infer") {
              // A non-Objective infer has runtime supervision, not an attached
              // Thread parent. Its immutable infer_request owns this lineage.
              const inferEvents = host.sql<{ payload: string }>(
                "SELECT payload FROM events WHERE id=? AND type='infer_request' AND actor='Runtime-Yao'",
                thread.root_turn_id,
              );
              assert.equal(inferEvents.length, 1);
              const inferPayload = parseProtocolValue(
                JSON.parse(inferEvents[0]!.payload),
              );
              assert.ok(
                inferPayload &&
                  typeof inferPayload === "object" &&
                  !Array.isArray(inferPayload),
              );
              assert.ok("parent_thread_id" in inferPayload);
              assert.equal(inferPayload.parent_thread_id, scheduledThreadId);
              assert.ok(text.includes(inferMarker));
              if (round === 0)
                return choose(objectToolName, {
                  action: "cognitive",
                  cognitive: {
                    action: "invoke",
                    ...target,
                    mode: "command",
                    operationId: "notes.create",
                    resources: [],
                    parameters: {
                      title: "Actual infer original",
                      markdown: "SYNTHETIC_INFER_PRIVATE_ORIGINAL",
                    },
                  },
                });
              assert.equal(round, 1);
              const value = latestPhysicalHostResult(request.messages);
              assert.ok("result" in value);
              const created = parseCognitiveAppCommandResult(value.result);
              assert.equal(created.command.state, "committed");
              inferCommandId = created.commandId;
              return { content: JSON.stringify(inferMarker) };
            } else if (thread.root_turn_id.startsWith("client-schedule-")) {
              scheduledThreadId = thread.id;
              assert.ok(text.includes(scheduleMarker));
              if (round === 0)
                return choose(objectToolName, {
                  action: "cognitive",
                  cognitive: {
                    action: "invoke",
                    ...target,
                    mode: "command",
                    operationId: "notes.create",
                    parameters: {
                      title: "Actual scheduled original",
                      markdown: "SYNTHETIC_TASK_RUN_PRIVATE_ORIGINAL",
                    },
                    resources: [],
                  },
                });
              if (round === 1) {
                const value = latestPhysicalHostResult(request.messages);
                assert.ok("result" in value);
                const created = parseCognitiveAppCommandResult(value.result);
                assert.equal(created.command.state, "committed");
                assert.equal(created.command.projectionState, "projected");
                createdCommandId = created.commandId;
                // The model-owned BODY names the actual child write; Runtime
                // does not pre-execute it. `requires` alone grants no effects.
                const program = `(eval (requires (tools ${objectToolName})) (infer (returns String) (seq (bind observed (call ${objectToolName} (action "cognitive") (cognitive (json-object (action "invoke") (mode "command") (appId ${JSON.stringify(target.appId)}) (version ${JSON.stringify(target.version)}) (connectionId ${JSON.stringify(target.connectionId)}) (operationId "notes.create") (parameters (json-object (title "Actual infer original") (markdown "SYNTHETIC_INFER_PRIVATE_ORIGINAL"))) (resources (list)))))) ${JSON.stringify(inferMarker)})))`;
                return choose("eval", { program });
              }
              assert.equal(round, 2);
              const inferText = latestPhysicalToolText(request.messages);
              assert.ok(
                inferText.trimStart().startsWith('"'),
                "Latest physical infer result rejected: " +
                  inferText.slice(0, 2000),
              );
              assert.equal(
                parseProtocolValue(JSON.parse(inferText)),
                inferMarker,
              );
            } else {
              assert.ok(text.includes(inputMarker));
              if (round === 0)
                return choose(objectToolName, {
                  action: "work-task",
                  workTask: { action: "start", taskId, revision: 1 },
                });
              assert.equal(round, 1);
              const value = latestPhysicalHostResult(request.messages);
              assert.ok(
                "eventId" in value && typeof value.eventId === "string",
              );
              assert.ok("state" in value && value.state === "queued");
              startedEventId = value.eventId;
            }
            const reply = profileFixtureReplyCarrier(request);
            assert.ok(
              reply,
              "Ordinary execution must use its actual reply contract",
            );
            return choose(reply.name, reply.arguments);
          } catch (error) {
            errors.push(
              error instanceof Error
                ? error.message
                : "Controlled response rejected",
            );
            throw error;
          }
        },
      };
      const { responseFor, ...options } = fixtureOptions;
      model = await controlledModel(responseFor);
      host = await profileActualTransportFixture({
        ...options,
        realProvider: {
          model: "cognitive-source-controlled",
          protocol: "openai-chat",
          baseUrl: model.baseUrl,
          key: model.key,
          maximumCalls: 24,
        },
      });
      const f = host;
      await f.client.call(
        "projects.create",
        { commandId: randomUUID(), projectId, title: "TEST 实际事项认知来源" },
        f.options,
      );
      await f.client.call("cognitive-apps.install", { definition }, f.options);
      await f.client.call(
        "cognitive-apps.grant",
        {
          appId: definition.id,
          version: definition.version,
          expectedRevision: 0,
          state: "active",
        },
        f.options,
      );
      await f.client.call(
        "cognitive-apps.connect",
        {
          ...target,
          expectedRevision: 0,
          serviceId: author!.ready.serviceId,
          dataAuthorityId: author!.ready.dataAuthorityId,
        },
        f.options,
      );
      await f.client.call(
        "tasks.create",
        {
          commandId: randomUUID(),
          taskId,
          projectId,
          title: "TEST 实际后台事项",
          description: scheduleMarker,
          assigneeId: morphzAgentAccess.actantId,
          notBefore: new Date(Date.now() + 2_000).toISOString(),
        },
        f.options,
      );
      await f.client.call(
        "platform.message",
        {
          commandId: randomUUID(),
          operation: {
            type: "record-input",
            projectId,
            conversationId: "conversation_" + randomUUID().replaceAll("-", ""),
            newConversation: { title: inputMarker },
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: inputMarker,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.options,
      );
      let finished = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        if (errors.length) assert.fail(errors.join("\n"));
        if (createdCommandId && inferCommandId && startedEventId) {
          const threads = f.sql<Thread>(
            "SELECT id,root_turn_id,session_id,executor_kind,parent_thread_id,status FROM threads",
          );
          if (
            threads.length === 3 &&
            threads.every((thread) => thread.status === "completed")
          ) {
            finished = true;
            break;
          }
        }
        await wait(50);
      }
      const platformPath = join(hostDirectory, "platform.sqlite");
      const requests = rows(
        platformPath,
        "SELECT payload,delivered_at FROM outbox WHERE event_kind='task.run_requested' AND aggregate_id=?",
        taskId,
      );
      assert.equal(
        requests.length,
        1,
        "Real Agent must commit exactly one task admission",
      );
      const admission = taskRunAdmissionSchema.parse(
        JSON.parse(String(requests[0]!.payload)),
      );
      assert.equal(admission.eventId, startedEventId);
      assert.ok(
        admission.sourceInputId,
        "Task admission must retain its actual originating input",
      );
      const inputThreads = f.sql<Thread>(
        "SELECT id,root_turn_id,session_id,executor_kind,parent_thread_id,status FROM threads WHERE executor_kind <> 'plan_infer' AND root_turn_id NOT LIKE 'client-schedule-%'",
      );
      assert.equal(inputThreads.length, 1);
      const inputThread = inputThreads[0]!;
      const originalInput = object(
        await f.runtime
          .inputEvidenceReader()
          .readSessionEvent(inputThread.session_id, inputThread.root_turn_id),
      );
      assert.equal(originalInput.id, inputThread.root_turn_id);
      assert.equal(originalInput.actor, "Session-Client");
      assert.equal(originalInput.type, "session_message");
      assert.equal(originalInput.topic, "chat/user_message");
      const originalPayload = object(originalInput.payload);
      assert.equal(originalPayload.client_message_id, admission.sourceInputId);
      const originalMessage = object(
        object(object(originalPayload.session_io).request).message,
      );
      const originalTypedValue = object(object(originalMessage.content).value);
      assert.equal(originalTypedValue.type, "object");
      const originalInputId = object(object(originalTypedValue.value).input_id);
      assert.equal(originalInputId.type, "string");
      assert.equal(originalInputId.value, admission.sourceInputId);
      assert.equal(
        finished,
        true,
        "Admission must dispatch and input/task/infer Threads must finish; no fixture shutdown substitute",
      );
      assert.ok(
        requests[0]!.delivered_at,
        "Production dispatcher must persist the actual Runtime receipt",
      );
      const authorRows = rows(
        authorDb,
        "SELECT command_id,binding_json FROM author_commands",
      );
      assert.equal(authorRows.length, 2);
      const direct = authorRows.find(
        (row) => row.command_id === createdCommandId,
      );
      const inferred = authorRows.find(
        (row) => row.command_id === inferCommandId,
      );
      assert.ok(direct && inferred);
      const binding = JSON.parse(String(direct.binding_json)) as {
        actor: unknown;
        projectId: string;
      };
      const actor = parseDomainActor(binding.actor);
      assert.equal(actor.kind, "agent");
      assert.equal(actor.tenantId, tenantId);
      assert.equal(actor.principalId, localAccess.principalId);
      assert.equal(actor.actantId, morphzAgentAccess.actantId);
      assert.equal(binding.projectId, projectId);
      assert.deepEqual(actor.source, {
        kind: "task-run",
        sessionId: admission.sessionId,
        scheduleId: admission.request.id,
        eventId: admission.eventId,
        sourceInputId: admission.sourceInputId,
        humanActantId: localAccess.actantId,
      });
      const inferBinding = JSON.parse(String(inferred.binding_json)) as {
        actor: unknown;
        projectId: string;
      };
      assert.deepEqual(parseDomainActor(inferBinding.actor), actor);
      assert.equal(inferBinding.projectId, projectId);
      const ledger = rows(
        platformPath,
        "SELECT source_kind,runtime_input_id,runtime_session_id,runtime_schedule_id,runtime_task_run_event_id,state FROM cognitive_app_commands WHERE command_id=?",
        createdCommandId!,
      );
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.source_kind, "task-run");
      assert.equal(ledger[0]!.runtime_input_id, admission.sourceInputId);
      assert.equal(ledger[0]!.runtime_session_id, admission.sessionId);
      assert.equal(ledger[0]!.runtime_schedule_id, admission.request.id);
      assert.equal(ledger[0]!.runtime_task_run_event_id, admission.eventId);
      assert.equal(ledger[0]!.state, "committed");
      const inferLedger = rows(
        platformPath,
        "SELECT source_kind,runtime_input_id,runtime_session_id,runtime_schedule_id,runtime_task_run_event_id,state FROM cognitive_app_commands WHERE command_id=?",
        inferCommandId!,
      );
      assert.deepEqual(inferLedger, ledger);
      const scheduleThreads = f.sql<Thread>(
        "SELECT id,root_turn_id,session_id,executor_kind,parent_thread_id,status FROM threads WHERE root_turn_id=?",
        `client-schedule-${admission.request.id}`,
      );
      assert.equal(scheduleThreads.length, 1);
      const evidence = f.runtime.inputEvidenceReader();
      assert.ok(
        evidence.readSessionSchedule,
        "Actual Runtime schedule evidence is required",
      );
      const schedule = await evidence.readSessionSchedule(
        admission.sessionId,
        admission.request.id,
      );
      assert.ok(schedule && typeof schedule === "object");
      assert.equal(Reflect.get(schedule, "thread_id"), scheduleThreads[0]!.id);
      assert.equal(
        Reflect.get(schedule, "source_turn_id"),
        scheduleThreads[0]!.root_turn_id,
      );
      const history = (await f.client.call(
        "task.run-history",
        { taskId, limit: 1 },
        f.options,
      )) as Array<{ runtime: { scheduleId: string; threadId: string } }>;
      assert.equal(history.length, 1);
      assert.equal(history[0]!.runtime.scheduleId, admission.request.id);
      assert.equal(history[0]!.runtime.threadId, scheduleThreads[0]!.id);
      const inferThreads = f.sql<Thread>(
        "SELECT id,root_turn_id,session_id,executor_kind,parent_thread_id,status FROM threads WHERE executor_kind='plan_infer'",
      );
      assert.equal(inferThreads.length, 1);
      if (inferThreads[0]!.parent_thread_id !== null)
        assert.equal(inferThreads[0]!.parent_thread_id, scheduleThreads[0]!.id);
      assert.equal(inferThreads[0]!.session_id, admission.sessionId);
      assert.equal(inferThreads[0]!.status, "completed");
      const inferEvent = await f.runtime
        .inputEvidenceReader()
        .readSessionEvent(admission.sessionId, inferThreads[0]!.root_turn_id);
      assert.ok(inferEvent && typeof inferEvent === "object");
      assert.equal(Reflect.get(inferEvent, "type"), "infer_request");
      const inferPayload: unknown = Reflect.get(inferEvent, "payload");
      assert.ok(inferPayload && typeof inferPayload === "object");
      assert.equal(
        Reflect.get(inferPayload, "parent_thread_id"),
        scheduledThreadId,
      );
      const jobs = f.sql<{
        id: string;
        context_id: string;
        thread_id: string;
        tool_call_id: string;
        request_json: string;
        status: string;
      }>(
        "SELECT id,context_id,thread_id,tool_call_id,request_json,status FROM execution_jobs WHERE tool_name=?",
        objectToolName,
      );
      const childWrites = jobs.filter((job) => {
        const request = JSON.parse(job.request_json) as {
          cognitive?: { operationId?: string; mode?: string };
        };
        return (
          job.thread_id === inferThreads[0]!.id &&
          request.cognitive?.operationId === "notes.create" &&
          request.cognitive.mode === "command"
        );
      });
      assert.equal(
        childWrites.length,
        1,
        "The child physical Job must own this command; a marker or parent write is insufficient",
      );
      const childJob = childWrites[0]!;
      assert.equal(childJob.status, "succeeded");
      assert.equal(
        stableId(
          "platform-agent-command",
          childJob.context_id,
          childJob.id,
          childJob.tool_call_id,
        ),
        inferCommandId,
      );
      assert.equal(rows(authorDb, "SELECT object_id FROM notes").length, 2);
      assert.equal(f.realCalls, model.calls);
      assert.equal(f.realCalls, f.requests.length);
      assert.doesNotMatch(JSON.stringify(f.requests), new RegExp(credential));
      t.diagnostic(
        JSON.stringify({
          evidence: "actual-rust-task-run-infer-cognitive-source",
          modelRequests: f.requests.length,
          controlledUpstreamCalls: f.realCalls,
          paidModelRequests: 0,
          actualThreadCount: f.sql("SELECT id FROM threads").length,
          authorCommands: authorRows.length,
          sourceInputPreserved: true,
          sourceKind: actor.source.kind,
          selectedTools: selected.map((entry) => entry.name),
          completedBeforeShutdown: true,
          inferChildPhysicalWrites: childWrites.length,
        }),
      );
    } finally {
      try {
        await host?.close();
      } finally {
        try {
          if (author) await stopPackedAuthor(author.child);
        } finally {
          try {
            await model?.close();
          } finally {
            packed.close();
          }
        }
      }
    }
  },
);
