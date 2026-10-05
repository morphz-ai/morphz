import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";
import {
  packCognitiveAuthor,
  startPackedAuthor,
  stopPackedAuthor,
} from "./fixtures/cognitive-app-packed-author.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import { objectToolName } from "../packages/core/src/application-names.js";
import { continuationSchema } from "../packages/core/src/continuation.js";
import { parseCognitiveAppApplicationTarget } from "../packages/core/src/cognitive-app-application-target.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import {
  parseCognitiveAppCatalog,
  parseCognitiveAppCommandResult,
  parseCognitiveAppDescription,
} from "../packages/core/src/cognitive-app-api.js";
import {
  parseCognitiveAppDefinition,
  parseProtocolValue,
} from "../packages/cognitive-app-sdk/src/protocol.js";
import {
  parseDomainActor,
  parseObjectReadResponse,
} from "../packages/cognitive-app-sdk/src/domain-wire.js";
import { workInputFormats } from "../packages/application/src/session-io.js";

const enabled = process.env.MORPHZ_COGNITIVE_APPLICATION_RUNTIME_E2E === "1";
const harness = { id: "cognitive-notes-e2e", version: "1.0.0" };
const harnessSource = `
(manifest (id ${harness.id}) (version "${harness.version}")
  (title "TEST explicit headless cognitive application")
  (capabilities (tools host_morphz)))
(contract (identity "ACTUAL_INSTALLED_COGNITIVE_HARNESS_ENTRY")
  (authority "Use the original Host input source; model text is not permission."))
(eval (requires (tools host_morphz))
  (seq
    (call host_morphz (action "read-input"))
    (call host_morphz (action "cognitive")
      (cognitive (json-object (action "invoke") (mode "command")
        (appId "example.notes") (version "1.0.0")
        (connectionId "application-notes-connection")
        (operationId "notes.create")
        (parameters (json-object (title "ACTUAL headless Harness original")
          (markdown "ACTUAL_HNS_ORIGINAL_V1_原件")))
        (resources (list)))))))
`;
const definition = parseCognitiveAppDefinition({
  ...JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
  harness,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function rows<T>(filename: string, sql: string, ...parameters: string[]): T[] {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare(sql).all(...parameters) as T[];
  } finally {
    db.close();
  }
}
function decoded(value: unknown): unknown {
  const node = record(value);
  if (node.type === "null") return null;
  if (["string", "boolean"].includes(String(node.type))) return node.value;
  if (node.type === "number") return Number(node.value);
  if (node.type === "array") {
    assert.ok(Array.isArray(node.value));
    return node.value.map(decoded);
  }
  assert.equal(node.type, "object");
  return Object.fromEntries(
    Object.entries(record(node.value)).map(([key, item]) => [
      key,
      decoded(item),
    ]),
  );
}
function physicalResult(messages: Array<{ role: string; content: unknown }>) {
  const latest = messages.filter((message) => message.role === "tool").at(-1);
  assert.ok(latest && typeof latest.content === "string");
  const envelope = record(parseProtocolValue(JSON.parse(latest.content)));
  assert.equal(envelope.output_state, "content");
  assert.match(String(envelope.observation_ref), /^@e\d+$/);
  assert.equal(typeof envelope.result, "string");
  const result = record(
    parseProtocolValue(JSON.parse(envelope.result as string)),
  );
  assert.equal(
    result.ok,
    true,
    "Latest actual physical Host result rejected: " +
      String(envelope.result).slice(0, 1000),
  );
  return result;
}
type RootThread = {
  id: string;
  session_id: string;
  root_turn_id: string;
  status: string;
};

/** Actual canonical Rust and CLI-installed HNS, real Host and author databases.
 * Only provider replies are controlled. No input/event/thread/actor is mocked. */
async function fixture(oldFormats = false) {
  const packed = packCognitiveAuthor();
  // The author itself loads this independently installed definition. No Host
  // constructor or fixture metadata substitutes its describe response.
  writeFileSync(
    join(packed.root, "definition.json"),
    JSON.stringify(definition),
  );
  const credential = randomBytes(32).toString("hex");
  const projectId = "cognitive_application_" + randomUUID().replaceAll("-", "");
  const authorDb = join(packed.directory, "author.sqlite");
  let author: Awaited<ReturnType<typeof startPackedAuthor>> | undefined;
  let host:
    Awaited<ReturnType<typeof profileActualTransportFixture>> | undefined;
  let hostDirectory = "",
    tenantId = "";
  try {
    host = await profileActualTransportFixture({
      harnessPackages: [
        { filename: "cognitive-application.hns", source: harnessSource },
      ],
      evalCallableTools: [objectToolName],
      ...(oldFormats
        ? {
            inputFormats: workInputFormats.filter(
              (format) => format.version !== "11" && format.version !== "12",
            ),
          }
        : {}),
      cognitiveHost: async (scope) => {
        hostDirectory = scope.directory;
        tenantId = scope.tenantId;
        const bootstrap = join(packed.directory, "bootstrap.json");
        writeFileSync(
          bootstrap,
          JSON.stringify({
            format: "cognitive-notes-bootstrap/v1",
            integrations: [
              {
                credentialSha256: createHash("sha256")
                  .update(credential)
                  .digest("hex"),
                issuer: "isolated_application_activation",
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
        const bindingsFile = join(scope.directory, "bindings.json");
        writeFileSync(
          bindingsFile,
          JSON.stringify({
            format: "morphz-host-cognitive-bindings/v1",
            issuer: "isolated_application_activation",
            bindings: [
              {
                tenantId,
                principalId: localAccess.principalId,
                appId: definition.id,
                serviceId: author.ready.serviceId,
                dataAuthorityId: author.ready.dataAuthorityId,
                baseUrl: `http://127.0.0.1:${author.ready.port}`,
                credentialEnv:
                  "MORPHZ_APP_COGNITIVE_CREDENTIAL_APPLICATION_FIXTURE",
                current: true,
                approvedLoopback: {
                  host: "127.0.0.1",
                  port: author.ready.port,
                },
              },
            ],
          }),
          { mode: 0o600 },
        );
        return {
          bindingsFile,
          secrets: (name) =>
            name === "MORPHZ_APP_COGNITIVE_CREDENTIAL_APPLICATION_FIXTURE"
              ? credential
              : undefined,
        };
      },
    });
    const f = host;
    assert.equal(f.harnessInstallations.length, 1);
    const installedHarness = f.harnessInstallations[0]!;
    assert.equal(installedHarness.id, harness.id);
    assert.equal(installedHarness.version, harness.version);
    assert.match(installedHarness.artifactHash, /^sha256:[a-f0-9]{64}$/);
    await f.client.call(
      "projects.create",
      {
        commandId: randomUUID(),
        projectId,
        title: "TEST headless exact Harness",
      },
      f.options,
    );
    const installed = record(
      await f.client.call("cognitive-apps.install", { definition }, f.options),
    );
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
    const businessTarget = {
      appId: definition.id,
      version: definition.version,
      connectionId: "application-notes-connection",
    };
    await f.client.call(
      "cognitive-apps.connect",
      {
        ...businessTarget,
        expectedRevision: 0,
        serviceId: author!.ready.serviceId,
        dataAuthorityId: author!.ready.dataAuthorityId,
      },
      f.options,
    );
    const catalog = parseCognitiveAppCatalog(
      await f.client.call("cognitive-apps.list", { limit: 50 }, f.options),
    );
    const connection = catalog.connections.find(
      (item) => item.connectionId === businessTarget.connectionId,
    );
    assert.ok(connection);
    const described = parseCognitiveAppDescription(
      await f.client.call(
        "cognitive-apps.describe",
        {
          projectId,
          appId: definition.id,
          version: definition.version,
        },
        f.options,
      ),
    );
    assert.deepEqual(described.definition, definition);
    assert.equal(described.definitionHash, installed.definitionHash);
    const target = parseCognitiveAppApplicationTarget({
      connectionId: connection.connectionId,
      authority: {
        appId: definition.id,
        version: definition.version,
        definitionHash: described.definitionHash,
        instanceId: connection.instanceId,
        serviceId: connection.serviceId,
        dataAuthorityId: connection.dataAuthorityId,
      },
    });
    return {
      host: f,
      projectId,
      businessTarget,
      target,
      installedHarness,
      authorDb,
      hostDirectory,
      tenantId,
      delivery(inputId: string) {
        const found = rows<{ body: string }>(
          join(hostDirectory, "transport.sqlite"),
          "SELECT body FROM runtime_deliveries WHERE key=?",
          inputId,
        );
        assert.equal(found.length, 1);
        return record(JSON.parse(found[0]!.body));
      },
      async close() {
        await f.close();
        if (author) await stopPackedAuthor(author.child);
        packed.close();
      },
    };
  } catch (error) {
    await host?.close();
    if (author) await stopPackedAuthor(author.child);
    packed.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function root(f: Fixture, inputId: string) {
  const found = f.host.sql<RootThread>(
    "SELECT t.id,t.session_id,t.root_turn_id,t.status FROM threads t JOIN events e ON e.id=t.root_turn_id WHERE json_extract(e.payload,'$.client_message_id')=?",
    inputId,
  );
  assert.equal(found.length, 1);
  return found[0]!;
}
async function completed(f: Fixture, thread: RootThread) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const actual = f.host.sql<{ status: string }>(
      "SELECT status FROM threads WHERE id=?",
      thread.id,
    )[0]!;
    if (actual.status !== "open") {
      assert.equal(actual.status, "completed");
      return;
    }
    await pause(50);
  }
  assert.fail("Actual root must complete before fixture cleanup");
}
async function accepted(
  f: Fixture,
  thread: RootThread,
  inputId: string,
  version: string,
  object: unknown,
) {
  const event = record(
    await f.host.runtime
      .inputEvidenceReader()
      .readSessionEvent(thread.session_id, thread.root_turn_id),
  );
  assert.equal(event.actor, "Session-Client");
  assert.equal(event.topic, "chat/user_message");
  const payload = record(event.payload),
    io = record(payload.session_io),
    request = record(io.request);
  assert.equal(payload.client_message_id, inputId);
  assert.equal(request.client_message_id, inputId);
  assert.equal(record(record(request.message).format).version, version);
  const visible = record(
    decoded(record(record(request.message).content).value),
  );
  assert.equal(visible.input_id, inputId);
  assert.deepEqual(visible.cognitiveApplication, f.target);
  assert.deepEqual(visible.cognitiveObject, object);
  const source = record(record(decoded(request.client_metadata)).source);
  assert.deepEqual(source.cognitiveApplication, f.target);
  if (object !== null) assert.deepEqual(source.cognitiveObject, object);
  const application = record(source.application);
  assert.equal(application.id, definition.id);
  assert.equal(application.version, definition.version);
  assert.equal(application.instanceId, f.target.authority.instanceId);
  assert.deepEqual(application.harness, harness);
  assert.deepEqual(record(request.activation).harness, harness);
  assert.equal(payload.requested_harness_id, harness.id);
  assert.equal(payload.requested_harness_version, harness.version);
  assert.equal(
    payload.requested_harness_artifact_hash,
    f.installedHarness.artifactHash,
  );
  const execution = record(record(io.binding).execution);
  assert.equal(execution.harness_id, harness.id);
  assert.equal(execution.harness_version, harness.version);
  assert.equal(execution.harness_hash, f.installedHarness.artifactHash);
  const bindings = f.host
    .sql<{ payload: string }>(
      "SELECT payload FROM events WHERE topic='runtime/evaluation_harness_binding'",
    )
    .map((row) => record(JSON.parse(row.payload)))
    .filter((binding) => binding.evaluation_id === thread.root_turn_id);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.harness_id, harness.id);
  assert.equal(bindings[0]!.harness_version, harness.version);
  assert.equal(bindings[0]!.artifact_hash, f.installedHarness.artifactHash);
  const plans = f.host.sql<{
    tool_call_id: string;
    status: string;
    source_artifact_hash: string;
  }>(
    "SELECT tool_call_id,status,source_artifact_hash FROM plan_executions WHERE thread_id=? AND tool_call_id LIKE 'harness_entry_%'",
    thread.id,
  );
  assert.equal(
    plans.length,
    1,
    "Exactly one real runtime-owned entry Plan per Evaluation",
  );
  assert.equal(plans[0]!.status, "succeeded");
  assert.equal(plans[0]!.source_artifact_hash, f.installedHarness.artifactHash);
  const jobs = f.host.sql<{ status: string; request_json: string }>(
    "SELECT status,request_json FROM execution_jobs WHERE thread_id=? AND tool_name=?",
    thread.id,
    objectToolName,
  );
  assert.ok(
    jobs.some(
      (job) =>
        job.status === "succeeded" && job.request_json.includes("read-input"),
    ),
    "Runtime-owned entry must actually execute Host read-input before model HTTP",
  );
}

test(
  "ACTUAL canonical Runtime explicit headless cognitive application activates installed Harness and preserves supplemented source",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const f = await fixture();
    try {
      assert.equal(definition.ui, null);
      assert.equal(rows(f.authorDb, "SELECT * FROM notes").length, 0);
      assert.equal(
        rows(
          join(f.hostDirectory, "platform.sqlite"),
          "SELECT view_id FROM app_view_instances WHERE app_id=?",
          definition.id,
        ).length,
        0,
      );
      assert.equal(
        rows(
          join(f.hostDirectory, "platform.sqlite"),
          "SELECT content_id FROM content_entries WHERE instance_id=?",
          f.target.authority.instanceId,
        ).length,
        0,
      );
      const conversationId = "conversation_" + randomUUID().replaceAll("-", "");
      const marker = "ACTUAL_APPLICATION_HEADLESS_" + randomUUID();
      const inputId = randomUUID();
      f.host.hold(marker);
      await f.host.client.call(
        "platform.message",
        {
          commandId: inputId,
          operation: {
            type: "record-input",
            projectId: f.projectId,
            conversationId,
            newConversation: { title: marker },
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: marker,
            cognitiveApplication: f.target,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.host.options,
      );
      let pending = await f.host.waitRequest(marker);
      const entry = physicalResult(pending.messages);
      assert.ok(
        JSON.stringify(pending.messages).includes(
          "ACTUAL_INSTALLED_COGNITIVE_HARNESS_ENTRY",
        ),
      );
      const firstRoot = root(f, inputId);
      await accepted(f, firstRoot, inputId, "11", null);
      // Runtime-owned Harness work is complete before this provider request.
      // The controlled model only explains it; it cannot start a second loop.
      const created = parseCognitiveAppCommandResult(entry.result);
      assert.equal(created.command.state, "committed");
      assert.equal(created.command.projectionState, "projected");
      const original = record(created.result);
      assert.equal(typeof original.objectId, "string");
      assert.equal(typeof original.versionRef, "string");
      const object = {
        objectId: original.objectId as string,
        versionRef: original.versionRef as string,
      };
      const physicalCommands = rows<{
        command_id: string;
        binding_json: string;
      }>(f.authorDb, "SELECT command_id,binding_json FROM author_commands");
      assert.equal(physicalCommands.length, 1);
      assert.equal(physicalCommands[0]!.command_id, created.commandId);
      const binding = record(JSON.parse(physicalCommands[0]!.binding_json));
      const actor = parseDomainActor(binding.actor);
      assert.equal(actor.kind, "agent");
      assert.equal(actor.principalId, localAccess.principalId);
      assert.equal(actor.actantId, morphzAgentAccess.actantId);
      assert.equal(actor.tenantId, f.tenantId);
      assert.equal(actor.source.kind, "input");
      assert.ok(actor.source.kind === "input");
      assert.equal(actor.source.inputId, inputId);
      assert.equal(binding.projectId, f.projectId);
      const source = record(f.delivery(inputId).platformSource);
      assert.deepEqual(source.cognitiveApplication, f.target);
      assert.equal(source.cognitiveObject, undefined);
      f.host.release(marker);
      await completed(f, firstRoot);

      // This second independent input explicitly chooses the same application
      // AND the exact author original; no current-head or numeric version cast.
      const content = rows<{ content_id: string }>(
        join(f.hostDirectory, "platform.sqlite"),
        "SELECT content_id FROM content_entries WHERE instance_id=? AND app_object_id=?",
        f.target.authority.instanceId,
        object.objectId,
      );
      assert.equal(content.length, 1);
      const locator = parseCognitiveAppObjectLocator({
        projectId: f.projectId,
        contentId: content[0]!.content_id,
        connectionId: f.target.connectionId,
        authority: f.target.authority,
        object,
      });
      const marker12 = "ACTUAL_APPLICATION_EXACT_IO12_" + randomUUID();
      const input12 = randomUUID();
      const since = f.host.requests.length;
      f.host.hold(marker12);
      await f.host.client.call(
        "platform.message",
        {
          commandId: input12,
          operation: {
            type: "record-input",
            projectId: f.projectId,
            conversationId,
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: marker12,
            cognitiveApplication: f.target,
            cognitiveObject: locator,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.host.options,
      );
      pending = await f.host.waitRequest(marker12, since);
      const secondEntry = physicalResult(pending.messages);
      const secondCreated = parseCognitiveAppCommandResult(secondEntry.result);
      assert.equal(secondCreated.command.state, "committed");
      assert.equal(secondCreated.command.projectionState, "projected");
      assert.notEqual(secondCreated.commandId, created.commandId);
      assert.notEqual(record(secondCreated.result).objectId, object.objectId);
      const secondRoot = root(f, input12);
      await accepted(f, secondRoot, input12, "12", locator);
      const read = parseObjectReadResponse(
        await f.host.client.call(
          "cognitive-apps.read-object",
          {
            projectId: f.projectId,
            ...f.businessTarget,
            object,
            maxBytes: 262144,
          },
          f.host.options,
        ),
      );
      assert.deepEqual(read.object, object);
      assert.deepEqual(read.authority, f.target.authority);
      assert.match(JSON.stringify(read.content), /ACTUAL_HNS_ORIGINAL_V1/);
      const allCommands = rows<{ command_id: string; binding_json: string }>(
        f.authorDb,
        "SELECT command_id,binding_json FROM author_commands",
      );
      assert.equal(allCommands.length, 2);
      const secondCommand = allCommands.find(
        (command) => command.command_id === secondCreated.commandId,
      );
      assert.ok(secondCommand);
      const secondActor = parseDomainActor(
        record(JSON.parse(secondCommand.binding_json)).actor,
      );
      assert.equal(secondActor.kind, "agent");
      assert.equal(secondActor.source.kind, "input");
      assert.ok(secondActor.source.kind === "input");
      assert.equal(secondActor.source.inputId, input12);
      assert.equal(secondActor.actantId, morphzAgentAccess.actantId);
      assert.equal(secondActor.principalId, localAccess.principalId);

      let liveTarget: unknown;
      for (let attempt = 0; attempt < 100; attempt++) {
        await f.host.runtime.tick();
        const history = record(
          await f.host.client.call(
            "conversations.history",
            { projectId: f.projectId, conversationId },
            f.host.options,
          ),
        );
        const activity = record(record(history.runtime).activity);
        assert.ok(Array.isArray(activity.threads));
        liveTarget = activity.threads
          .map(record)
          .find((thread) => thread.id === secondRoot.id)?.continuation;
        if (liveTarget) break;
        await pause(50);
      }
      const continuation = continuationSchema.parse(liveTarget);
      assert.equal(continuation.inputId, input12);
      assert.equal(continuation.threadId, secondRoot.id);
      const supplementId = randomUUID();
      const supplement = {
        commandId: supplementId,
        operation: {
          type: "record-input",
          projectId: f.projectId,
          conversationId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: "ACTUAL_APPLICATION_SUPPLEMENT_EXACT_TARGET",
          continuation,
          targetActantId: morphzAgentAccess.actantId,
        },
      };
      assert.equal("cognitiveApplication" in supplement.operation, false);
      assert.equal("cognitiveObject" in supplement.operation, false);
      const receipt = await f.host.client.call(
        "platform.message",
        supplement,
        f.host.options,
      );
      assert.equal(record(receipt).entityId, supplementId);
      const delivered = f.delivery(supplementId),
        inherited = record(delivered.platformSource);
      assert.deepEqual(inherited.cognitiveApplication, f.target);
      assert.deepEqual(inherited.cognitiveObject, locator);
      assert.deepEqual(
        inherited.application,
        record(f.delivery(input12).platformSource).application,
      );
      assert.equal(delivered.sessionId, secondRoot.session_id);
      assert.equal(delivered.rootId, null);
      assert.equal(delivered.supplement, "delivered");
      assert.equal(typeof delivered.acceptedEventId, "string");
      const request = record(delivered.request),
        activation = record(request.activation);
      assert.equal(record(record(request.message).format).version, "12");
      assert.equal(
        activation.harness,
        undefined,
        "Directed input must never override the root Harness",
      );
      assert.equal(
        record(activation.input_destination).thread_id,
        secondRoot.id,
      );
      const event = record(
        await f.host.runtime
          .inputEvidenceReader()
          .readSessionEvent(
            secondRoot.session_id,
            delivered.acceptedEventId as string,
          ),
      );
      assert.equal(event.actor, "Session-Client");
      assert.equal(event.topic, "chat/steering");
      const acceptedPayload = record(event.payload);
      assert.equal(acceptedPayload.client_message_id, supplementId);
      const acceptedRequest = record(
        record(acceptedPayload.session_io).request,
      );
      assert.equal(acceptedRequest.client_message_id, supplementId);
      const visible = record(
        decoded(record(record(acceptedRequest.message).content).value),
      );
      assert.equal(visible.input_id, supplementId);
      assert.deepEqual(visible.cognitiveApplication, f.target);
      assert.deepEqual(visible.cognitiveObject, locator);
      const retained = record(
        record(decoded(acceptedRequest.client_metadata)).source,
      );
      assert.deepEqual(retained.cognitiveApplication, f.target);
      assert.deepEqual(retained.cognitiveObject, locator);
      const requestBytes = JSON.stringify(request);
      const history = record(
        await f.host.client.call(
          "conversations.history",
          { projectId: f.projectId, conversationId },
          f.host.options,
        ),
      );
      assert.ok(Array.isArray(history.inputs));
      const projected = history.inputs
        .map(record)
        .find((input) => input.id === supplementId);
      assert.ok(projected);
      assert.deepEqual(projected.cognitiveApplication, f.target);
      assert.deepEqual(projected.cognitiveObject, locator);
      assert.equal(f.host.sql("SELECT id FROM threads").length, 2);
      assert.equal(rows(f.authorDb, "SELECT * FROM notes").length, 2);
      assert.equal(rows(f.authorDb, "SELECT * FROM author_commands").length, 2);
      f.host.release(marker12);
      await completed(f, secondRoot);
      const modelRequests = f.host.requests.length;
      assert.deepEqual(
        await f.host.client.call(
          "platform.message",
          supplement,
          f.host.options,
        ),
        receipt,
      );
      assert.equal(
        JSON.stringify(f.delivery(supplementId).request),
        requestBytes,
      );
      assert.equal(f.host.requests.length, modelRequests);
      assert.equal(f.host.realCalls, 0);
      assert.equal(f.host.sql("SELECT id FROM threads").length, 2);
      const finalPlans = f.host.sql<{ status: string }>(
        "SELECT status FROM plan_executions WHERE tool_call_id LIKE 'harness_entry_%'",
      );
      assert.equal(
        finalPlans.length,
        2,
        "Supplement and receipt replay never run the installed entry again",
      );
      assert.ok(finalPlans.every((plan) => plan.status === "succeeded"));
      const finalJobs = f.host.sql<{ status: string }>(
        "SELECT status FROM execution_jobs WHERE tool_name=?",
        objectToolName,
      );
      assert.equal(finalJobs.length, 4);
      assert.ok(finalJobs.every((job) => job.status === "succeeded"));
      assert.equal(rows(f.authorDb, "SELECT * FROM notes").length, 2);
      assert.equal(rows(f.authorDb, "SELECT * FROM author_commands").length, 2);
      console.log(
        JSON.stringify({
          evidence: "actual-installed-headless-HNS",
          formats: ["11", "12"],
          actualHarnessInstallations: 1,
          actualHarnessEntryPlans: 2,
          actualRootThreads: 2,
          acceptedInputs: 3,
          authorOriginals: 2,
          authorCommands: 2,
          supplementInheritedTarget: true,
          completedReceiptReplay: true,
          controlledModelRequests: modelRequests,
          paidProviderRequests: 0,
        }),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "ACTUAL canonical Runtime without IO11/12 registrations rejects explicit application without fallback",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const f = await fixture(true);
    try {
      const inputId = randomUUID();
      await f.host.client.call(
        "platform.message",
        {
          commandId: inputId,
          operation: {
            type: "record-input",
            projectId: f.projectId,
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: "ACTUAL_OLD_FORMAT_REJECT_EXPLICIT_APPLICATION",
            cognitiveApplication: f.target,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.host.options,
      );
      let failed: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        const delivery = f.delivery(inputId);
        if (delivery.state === "failed") {
          failed = delivery;
          break;
        }
        await pause(50);
      }
      assert.ok(
        failed,
        "Actual Runtime must reject the missing registered format",
      );
      assert.equal(failed.rootId, null);
      assert.equal(failed.runtimePostAttempted, true);
      assert.match(String(failed.error), /format|格式|installed|400|422/i);
      assert.equal(
        record(record(record(failed.request).message).format).version,
        "11",
      );
      assert.deepEqual(
        record(failed.platformSource).cognitiveApplication,
        f.target,
      );
      assert.equal(f.host.sql("SELECT id FROM threads").length, 0);
      assert.equal(
        f.host.sql("SELECT id FROM events WHERE topic='chat/user_message'")
          .length,
        0,
      );
      assert.equal(f.host.sql("SELECT id FROM plan_executions").length, 0);
      assert.equal(f.host.requests.length, 0);
      assert.equal(rows(f.authorDb, "SELECT * FROM notes").length, 0);
      assert.equal(rows(f.authorDb, "SELECT * FROM author_commands").length, 0);
      const bytes = JSON.stringify(failed.request);
      // A later tick retains this failed IO11 request; it does not retry it.
      // Installed-HNS readiness never permits an old-format substitution.
      await f.host.runtime.tick();
      assert.equal(JSON.stringify(f.delivery(inputId).request), bytes);
      assert.equal(f.host.sql("SELECT id FROM threads").length, 0);
      // An authentic Human command creates the exact original needed to probe
      // the second strict format. It is not attributed to the rejected Agent.
      const humanCommandId = randomUUID();
      const humanCreated = parseCognitiveAppCommandResult(
        await f.host.client.call(
          "cognitive-apps.invoke",
          {
            commandId: humanCommandId,
            projectId: f.projectId,
            ...f.businessTarget,
            operationId: "notes.create",
            resources: [],
            parameters: {
              title: "TEST IO12 rejection original",
              markdown: "HUMAN_IO12_BASELINE",
            },
          },
          f.host.options,
        ),
      );
      assert.equal(humanCreated.command.state, "committed");
      assert.equal(humanCreated.command.projectionState, "projected");
      const humanObject = record(humanCreated.result);
      assert.equal(typeof humanObject.objectId, "string");
      assert.equal(typeof humanObject.versionRef, "string");
      const originals = rows<{ content_id: string }>(
        join(f.hostDirectory, "platform.sqlite"),
        "SELECT content_id FROM content_entries WHERE instance_id=? AND app_object_id=?",
        f.target.authority.instanceId,
        humanObject.objectId as string,
      );
      assert.equal(originals.length, 1);
      const locator = parseCognitiveAppObjectLocator({
        projectId: f.projectId,
        contentId: originals[0]!.content_id,
        connectionId: f.target.connectionId,
        authority: f.target.authority,
        object: {
          objectId: humanObject.objectId,
          versionRef: humanObject.versionRef,
        },
      });
      const baseline = rows<{ command_id: string; binding_json: string }>(
        f.authorDb,
        "SELECT command_id,binding_json FROM author_commands",
      );
      assert.equal(baseline.length, 1);
      assert.equal(baseline[0]!.command_id, humanCommandId);
      const humanActor = parseDomainActor(
        record(JSON.parse(baseline[0]!.binding_json)).actor,
      );
      assert.equal(humanActor.kind, "human");
      assert.equal(humanActor.source.kind, "human");
      assert.equal(humanActor.actantId, localAccess.actantId);
      const input12 = randomUUID();
      await f.host.client.call(
        "platform.message",
        {
          commandId: input12,
          operation: {
            type: "record-input",
            projectId: f.projectId,
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: "ACTUAL_OLD_FORMAT_REJECT_EXACT_IO12",
            cognitiveApplication: f.target,
            cognitiveObject: locator,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.host.options,
      );
      let failed12: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        const delivery = f.delivery(input12);
        if (delivery.state === "failed") {
          failed12 = delivery;
          break;
        }
        await pause(50);
      }
      assert.ok(failed12, "Actual Runtime must independently reject IO12");
      assert.equal(failed12.rootId, null);
      assert.equal(failed12.runtimePostAttempted, true);
      assert.match(String(failed12.error), /format|格式|installed|400|422/i);
      assert.equal(
        record(record(record(failed12.request).message).format).version,
        "12",
      );
      assert.deepEqual(
        record(failed12.platformSource).cognitiveApplication,
        f.target,
      );
      assert.deepEqual(
        record(failed12.platformSource).cognitiveObject,
        locator,
      );
      const bytes12 = JSON.stringify(failed12.request);
      await f.host.runtime.tick();
      assert.equal(JSON.stringify(f.delivery(input12).request), bytes12);
      assert.equal(f.host.sql("SELECT id FROM threads").length, 0);
      assert.equal(
        f.host.sql("SELECT id FROM events WHERE topic='chat/user_message'")
          .length,
        0,
      );
      assert.equal(f.host.sql("SELECT id FROM plan_executions").length, 0);
      assert.equal(f.host.requests.length, 0);
      assert.equal(rows(f.authorDb, "SELECT * FROM notes").length, 1);
      assert.equal(rows(f.authorDb, "SELECT * FROM author_commands").length, 1);
      const legacyId = randomUUID(),
        marker = "ACTUAL_LEGACY_INPUT_STILL_ACCEPTED";
      f.host.hold(marker);
      await f.host.client.call(
        "platform.message",
        {
          commandId: legacyId,
          operation: {
            type: "record-input",
            projectId: f.projectId,
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: marker,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.host.options,
      );
      await f.host.waitRequest(marker);
      const legacyRoot = root(f, legacyId);
      assert.equal(
        record(record(record(f.delivery(legacyId).request).message).format)
          .version,
        "1",
      );
      assert.equal(
        f.host.sql("SELECT id FROM plan_executions").length,
        0,
        "Installed package and prior rejected target never implicitly activate legacy input",
      );
      f.host.release(marker);
      await completed(f, legacyRoot);
      assert.equal(f.host.realCalls, 0);
      assert.equal(rows(f.authorDb, "SELECT * FROM author_commands").length, 1);
      console.log(
        JSON.stringify({
          evidence: "actual-IO11-12-registration-no-fallback",
          actualHarnessInstallations: 1,
          rejectedFormats: ["11", "12"],
          rejectedRootThreads: 0,
          rejectedModelRequests: 0,
          retainedRequestUnchanged: true,
          legacyFormat: "1",
          legacyThreadStatus: "completed",
          humanBaselineCommands: 1,
          rejectedAgentCommands: 0,
          controlledModelRequests: f.host.requests.length,
          paidProviderRequests: 0,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
