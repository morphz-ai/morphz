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
import { continuationSchema } from "../packages/core/src/continuation.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import { objectToolName } from "../packages/core/src/application-names.js";
import { parseCognitiveAppCommandResult } from "../packages/core/src/cognitive-app-api.js";
import {
  parseCognitiveAppDefinition,
  parseProtocolValue,
} from "../packages/cognitive-app-sdk/src/protocol.js";
import { parseObjectReadResponse } from "../packages/cognitive-app-sdk/src/domain-wire.js";
import { workInputFormats } from "../packages/application/src/session-io.js";

const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const enabled = process.env.MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E === "1";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function rows<T>(filename: string, sql: string, ...parameters: string[]): T[] {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare(sql).all(...parameters) as T[];
  } finally {
    db.close();
  }
}
function decoded(input: unknown): unknown {
  assert.ok(input && typeof input === "object" && "type" in input);
  const node = input as { type: string; value?: unknown };
  if (node.type === "null") return null;
  if (node.type === "string" || node.type === "boolean") return node.value;
  if (node.type === "number") return Number(node.value);
  if (node.type === "array") {
    assert.ok(Array.isArray(node.value));
    return node.value.map(decoded);
  }
  assert.equal(node.type, "object");
  assert.ok(node.value && typeof node.value === "object");
  return Object.fromEntries(
    Object.entries(node.value).map(([key, value]) => [key, decoded(value)]),
  );
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Real independent npm-packed author, actual Human facade/admission and
 * canonical Rust Runtime. All model HTTP is controlled, never paid. */
async function fixture(oldFormats = false) {
  const packed = packCognitiveAuthor();
  const credential = randomBytes(32).toString("hex");
  const projectId = "cognitive_input_" + randomUUID().replaceAll("-", "");
  const authorDb = join(packed.directory, "author.sqlite");
  let author: Awaited<ReturnType<typeof startPackedAuthor>> | undefined;
  let host:
    Awaited<ReturnType<typeof profileActualTransportFixture>> | undefined;
  let hostDirectory = "",
    tenantId = "";
  try {
    host = await profileActualTransportFixture({
      ...(oldFormats
        ? {
            inputFormats: workInputFormats.filter(
              (format) => format.version !== "10",
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
                issuer: "isolated_input_reference",
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
            issuer: "isolated_input_reference",
            bindings: [
              {
                tenantId,
                principalId: localAccess.principalId,
                appId: definition.id,
                serviceId: author.ready.serviceId,
                dataAuthorityId: author.ready.dataAuthorityId,
                baseUrl: `http://127.0.0.1:${author.ready.port}`,
                credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_INPUT_FIXTURE",
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
            name === "MORPHZ_APP_COGNITIVE_CREDENTIAL_INPUT_FIXTURE"
              ? credential
              : undefined,
        };
      },
    });
    const f = host;
    await f.client.call(
      "projects.create",
      {
        commandId: randomUUID(),
        projectId,
        title: "TEST exact cognitive original",
      },
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
    const target = {
      appId: definition.id,
      version: definition.version,
      connectionId: "input-notes-connection",
    };
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
    const created = parseCognitiveAppCommandResult(
      await f.client.call(
        "cognitive-apps.invoke",
        {
          commandId: randomUUID(),
          projectId,
          ...target,
          operationId: "notes.create",
          parameters: {
            title: "Old exact original",
            markdown: "PINNED_ORIGINAL_V1_原件",
          },
          resources: [],
        },
        f.options,
      ),
    );
    assert.equal(created.command.projectionState, "projected");
    const original = record(created.result);
    assert.equal(typeof original.objectId, "string");
    assert.equal(typeof original.versionRef, "string");
    const object = {
      objectId: original.objectId as string,
      versionRef: original.versionRef as string,
    };
    const revised = parseCognitiveAppCommandResult(
      await f.client.call(
        "cognitive-apps.invoke",
        {
          commandId: randomUUID(),
          projectId,
          ...target,
          operationId: "notes.revise",
          parameters: {
            objectId: object.objectId,
            baselineVersionRef: object.versionRef,
            title: "New exact original",
            markdown: "CURRENT_HEAD_V2_不可替换",
          },
          resources: [object],
        },
        f.options,
      ),
    );
    assert.notEqual(record(revised.result).versionRef, object.versionRef);
    const exact = parseObjectReadResponse(
      await f.client.call(
        "cognitive-apps.read-object",
        { projectId, ...target, object, maxBytes: 262144 },
        f.options,
      ),
    );
    assert.match(JSON.stringify(exact.content), /PINNED_ORIGINAL_V1/);
    const catalog = rows<{ content_id: string; observed_version_ref: string }>(
      join(hostDirectory, "platform.sqlite"),
      "SELECT content_id,observed_version_ref FROM content_entries WHERE app_object_id=?",
      object.objectId,
    );
    assert.equal(catalog.length, 1);
    assert.equal(
      catalog[0]!.observed_version_ref,
      record(revised.result).versionRef,
    );
    const locator = parseCognitiveAppObjectLocator({
      contentId: catalog[0]!.content_id,
      projectId,
      connectionId: target.connectionId,
      authority: exact.authority,
      object,
    });
    return {
      host: f,
      target,
      locator,
      authorDb,
      hostDirectory,
      credential,
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

test(
  "actual Rust cognitive original locator: IO10 source, read-input and exact historical author version",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const f = await fixture();
    try {
      const marker = "ACTUAL_COGNITIVE_ORIGINAL_V1_CHAIN";
      const inputId = randomUUID(),
        conversationId = "conversation_" + randomUUID().replaceAll("-", "");
      f.host.hold(marker);
      await f.host.client.call(
        "platform.message",
        {
          commandId: inputId,
          operation: {
            type: "record-input",
            projectId: f.locator.projectId,
            conversationId,
            newConversation: { title: marker },
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: marker,
            cognitiveObject: f.locator,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.host.options,
      );
      let pending = await f.host.waitRequest(marker);
      assert.ok(
        JSON.stringify(pending.messages).includes(f.locator.object.versionRef),
        "The actual compiled input must show opaque original reference",
      );
      const step = async (arguments_: unknown) => {
        const since = f.host.requests.length;
        f.host.hold(marker);
        f.host.releaseWithTool(marker, objectToolName, arguments_);
        pending = await f.host.waitRequest(marker, since);
        const latest = pending.messages
          .filter((message) => message.role === "tool")
          .at(-1);
        assert.ok(latest && typeof latest.content === "string");
        const envelope = record(parseProtocolValue(JSON.parse(latest.content)));
        assert.equal(envelope.output_state, "content");
        assert.equal(typeof envelope.result, "string");
        const result = record(
          parseProtocolValue(JSON.parse(envelope.result as string)),
        );
        assert.equal(
          result.ok,
          true,
          "Only latest physical Host success may satisfy this step: " +
            String(envelope.result).slice(0, 900),
        );
        return result;
      };
      const readInput = await step({ action: "read-input" });
      assert.deepEqual(record(readInput.input).cognitiveObject, f.locator);
      assert.equal(record(readInput.input).input_id, inputId);
      const exact = parseObjectReadResponse(
        (
          await step({
            action: "cognitive",
            cognitive: {
              action: "read-object",
              ...f.target,
              object: f.locator.object,
              maxBytes: 262144,
            },
          })
        ).result,
      );
      assert.deepEqual(exact.object, f.locator.object);
      assert.match(JSON.stringify(exact.content), /PINNED_ORIGINAL_V1/);
      assert.doesNotMatch(JSON.stringify(exact.content), /CURRENT_HEAD_V2/);
      const threads = f.host.sql<{
        id: string;
        session_id: string;
        root_turn_id: string;
      }>("SELECT id,session_id,root_turn_id FROM threads");
      assert.equal(threads.length, 1);
      const root = threads[0]!;
      const event = record(
        await f.host.runtime
          .inputEvidenceReader()
          .readSessionEvent(root.session_id, root.root_turn_id),
      );
      assert.equal(event.actor, "Session-Client");
      assert.equal(event.type, "session_message");
      assert.equal(event.topic, "chat/user_message");
      const payload = record(event.payload),
        io = record(payload.session_io),
        request = record(io.request);
      assert.equal(payload.client_message_id, inputId);
      assert.equal(request.client_message_id, inputId);
      const message = record(request.message),
        format = record(message.format),
        content = record(message.content);
      assert.equal(format.version, "10");
      assert.equal(record(decoded(content.value)).input_id, inputId);
      assert.deepEqual(
        record(decoded(content.value)).cognitiveObject,
        f.locator,
      );
      const metadata = record(decoded(request.client_metadata));
      assert.deepEqual(record(metadata.source).cognitiveObject, f.locator);
      const delivery = rows<{ body: string }>(
        join(f.hostDirectory, "transport.sqlite"),
        "SELECT body FROM runtime_deliveries WHERE key=?",
        inputId,
      );
      assert.equal(delivery.length, 1);
      const originalEnvelope = record(JSON.parse(delivery[0]!.body));
      assert.deepEqual(
        record(originalEnvelope.platformSource).cognitiveObject,
        f.locator,
      );
      const history = record(
        await f.host.client.call(
          "conversations.history",
          { projectId: f.locator.projectId, conversationId },
          f.host.options,
        ),
      );
      assert.ok(Array.isArray(history.inputs));
      assert.deepEqual(record(history.inputs[0]).cognitiveObject, f.locator);
      // The target is projected from the actual live Rust Thread by the existing
      // Host activity/continuation gate, never fabricated from a model claim.
      let liveTarget: unknown;
      for (let attempt = 0; attempt < 100; attempt++) {
        await f.host.runtime.tick();
        const current = record(
          await f.host.client.call(
            "conversations.history",
            { projectId: f.locator.projectId, conversationId },
            f.host.options,
          ),
        );
        const activity = record(record(current.runtime).activity);
        assert.ok(Array.isArray(activity.threads));
        liveTarget = activity.threads
          .map(record)
          .find((thread) => thread.id === root.id)?.continuation;
        if (liveTarget) break;
        await pause(50);
      }
      const continuation = continuationSchema.parse(liveTarget);
      assert.equal(continuation.inputId, inputId);
      assert.equal(continuation.threadId, root.id);
      const supplementId = randomUUID();
      const supplement = {
        commandId: supplementId,
        operation: {
          type: "record-input",
          projectId: f.locator.projectId,
          conversationId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: "ACTUAL_SUPPLEMENT_KEEP_ORIGINAL_V1",
          continuation,
          targetActantId: morphzAgentAccess.actantId,
        },
      };
      assert.equal("cognitiveObject" in supplement.operation, false);
      const supplementReceipt = await f.host.client.call(
        "platform.message",
        supplement,
        f.host.options,
      );
      assert.equal(record(supplementReceipt).entityId, supplementId);
      const supplemented = rows<{ body: string }>(
        join(f.hostDirectory, "transport.sqlite"),
        "SELECT body FROM runtime_deliveries WHERE key=?",
        supplementId,
      );
      assert.equal(supplemented.length, 1);
      const retainedSupplement = record(JSON.parse(supplemented[0]!.body));
      const supplementSource = record(retainedSupplement.platformSource);
      assert.deepEqual(supplementSource.cognitiveObject, f.locator);
      assert.deepEqual(supplementSource.continuation, continuation);
      assert.equal(retainedSupplement.sessionId, root.session_id);
      assert.equal(retainedSupplement.rootId, null);
      assert.equal(retainedSupplement.supplement, "delivered");
      assert.equal(typeof retainedSupplement.acceptedEventId, "string");
      const supplementRequest = record(retainedSupplement.request),
        supplementMessage = record(supplementRequest.message);
      assert.equal(supplementRequest.client_message_id, supplementId);
      assert.equal(record(supplementMessage.format).version, "10");
      assert.deepEqual(
        record(record(supplementMessage.content).value).cognitiveObject,
        f.locator,
      );
      const activation = record(supplementRequest.activation),
        destination = record(activation.input_destination);
      assert.equal(destination.thread_id, root.id);
      assert.equal(destination.generation, continuation.generation);
      const acceptedSupplement = record(
        await f.host.runtime
          .inputEvidenceReader()
          .readSessionEvent(
            root.session_id,
            retainedSupplement.acceptedEventId as string,
          ),
      );
      const acceptedPayload = record(acceptedSupplement.payload),
        acceptedIo = record(acceptedPayload.session_io),
        acceptedRequest = record(acceptedIo.request);
      assert.equal(acceptedPayload.client_message_id, supplementId);
      assert.deepEqual(
        record(decoded(record(record(acceptedRequest.message).content).value))
          .cognitiveObject,
        f.locator,
      );
      assert.deepEqual(
        record(record(decoded(acceptedRequest.client_metadata)).source)
          .cognitiveObject,
        f.locator,
      );
      const supplementHistory = record(
        await f.host.client.call(
          "conversations.history",
          { projectId: f.locator.projectId, conversationId },
          f.host.options,
        ),
      );
      assert.ok(Array.isArray(supplementHistory.inputs));
      const inherited = supplementHistory.inputs
        .map(record)
        .find((input) => input.id === supplementId);
      assert.ok(inherited);
      assert.deepEqual(inherited.cognitiveObject, f.locator);
      assert.equal(f.host.sql("SELECT id FROM threads").length, 1);
      const retainedRequestBytes = JSON.stringify(retainedSupplement.request);
      assert.equal(
        rows(
          f.authorDb,
          "SELECT * FROM note_versions WHERE object_id=?",
          f.locator.object.objectId,
        ).length,
        2,
      );
      assert.equal(
        rows(f.authorDb, "SELECT * FROM author_commands").length,
        2,
        "Read/input never creates another author command",
      );
      f.host.release(marker);
      let finished = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        const thread = f.host.sql<{ status: string }>(
          "SELECT status FROM threads WHERE id=?",
          root.id,
        )[0]!;
        if (thread.status !== "open") {
          assert.equal(thread.status, "completed");
          finished = true;
          break;
        }
        await pause(50);
      }
      assert.equal(finished, true);
      assert.equal(f.host.realCalls, 0);
      const modelRequestCount = f.host.requests.length;
      assert.deepEqual(
        await f.host.client.call(
          "platform.message",
          supplement,
          f.host.options,
        ),
        supplementReceipt,
        "A completed actual target must recover this original accepted receipt",
      );
      const retried = rows<{ body: string }>(
        join(f.hostDirectory, "transport.sqlite"),
        "SELECT body FROM runtime_deliveries WHERE key=?",
        supplementId,
      );
      assert.equal(retried.length, 1);
      assert.equal(
        JSON.stringify(record(JSON.parse(retried[0]!.body)).request),
        retainedRequestBytes,
      );
      assert.equal(f.host.sql("SELECT id FROM threads").length, 1);
      assert.equal(f.host.requests.length, modelRequestCount);
      assert.equal(
        JSON.stringify(f.host.requests).includes(f.credential),
        false,
      );
      console.log(
        JSON.stringify({
          evidence: "actual-cognitive-input-original",
          ioVersion: "10",
          authorVersions: 2,
          authorCommands: 2,
          actualRootThreads: 1,
          actualAcceptedInputs: 2,
          supplementInheritedOriginal: true,
          completedReceiptReplay: true,
          threadStatus: "completed",
          controlledModelRequests: f.host.requests.length,
          paidProviderRequests: 0,
        }),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "actual old-format Runtime rejects IO10 without downgrade or model work",
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
            projectId: f.locator.projectId,
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: "OLD_RUNTIME_MUST_REJECT_COGNITIVE_IO10",
            cognitiveObject: f.locator,
            targetActantId: morphzAgentAccess.actantId,
          },
        },
        f.host.options,
      );
      let failed: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        const row = rows<{ body: string }>(
          join(f.hostDirectory, "transport.sqlite"),
          "SELECT body FROM runtime_deliveries WHERE key=?",
          inputId,
        )[0]!;
        const delivery = record(JSON.parse(row.body));
        if (delivery.state === "failed") {
          failed = delivery;
          break;
        }
        await pause(50);
      }
      assert.ok(
        failed,
        "Unknown exact format must be rejected, never silently downgraded",
      );
      assert.equal(failed.rootId, null);
      assert.match(String(failed.error), /format|格式|installed|400|422/i);
      assert.equal(
        record(record(failed.request).message).format &&
          record(record(record(failed.request).message).format).version,
        "10",
      );
      assert.deepEqual(
        record(failed.platformSource).cognitiveObject,
        f.locator,
      );
      assert.equal(f.host.sql("SELECT id FROM threads").length, 0);
      assert.equal(f.host.requests.length, 0);
      assert.equal(f.host.realCalls, 0);
      assert.equal(rows(f.authorDb, "SELECT * FROM author_commands").length, 2);
      console.log(
        JSON.stringify({
          evidence: "actual-old-format-runtime-no-fallback",
          retainedVersion: "10",
          actualRootThreads: 0,
          modelRequests: 0,
          paidProviderRequests: 0,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
