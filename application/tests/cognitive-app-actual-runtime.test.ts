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
import {
  parseCognitiveAppCatalog,
  parseCognitiveAppDescription,
  parseCognitiveAppCommandResult,
  parseCognitiveAppReadResult,
} from "../packages/core/src/cognitive-app-api.js";
import {
  parseCognitiveAppDefinition,
  parseProtocolValue,
} from "../packages/cognitive-app-sdk/src/protocol.js";
import {
  parseDomainActor,
  parseObjectReadResponse,
} from "../packages/cognitive-app-sdk/src/domain-wire.js";
import { parseBrowserCommandFacts } from "../packages/cognitive-app-sdk/src/browser-wire.js";

const title =
  "actual Rust Runtime + independent packed author: Agent discovery, write, exact read and receipt recovery retain real provenance";
const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** Actual Rust Jobs, model HTTP bytes, Host tool transport, current source
 * verifier and real packed author SQLite. The model response is deterministic,
 * never a paid provider or an acceptance run in the user's original App. */
test(
  title,
  { skip: process.env.MORPHZ_COGNITIVE_RUNTIME_E2E !== "1", timeout: 120_000 },
  async () => {
    const packed = packCognitiveAuthor();
    const projectId = "cognitive_runtime_" + randomUUID().replaceAll("-", "");
    const credential = randomBytes(32).toString("hex");
    const authorDb = join(packed.directory, "author.sqlite");
    const bootstrap = join(packed.directory, "author-bootstrap.json");
    let author: Awaited<ReturnType<typeof startPackedAuthor>> | undefined;
    let f:
      Awaited<ReturnType<typeof profileActualTransportFixture>> | undefined;
    let hostDirectory = "",
      tenantId = "";
    const rows = (filename: string, sql: string, ...parameters: string[]) => {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        return db.prepare(sql).all(...parameters);
      } finally {
        db.close();
      }
    };
    try {
      f = await profileActualTransportFixture({
        cognitiveHost: async (scope) => {
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
                  issuer: "isolated_actual_runtime",
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
              issuer: "isolated_actual_runtime",
              bindings: [
                {
                  tenantId,
                  principalId: localAccess.principalId,
                  appId: definition.id,
                  serviceId: author.ready.serviceId,
                  dataAuthorityId: author.ready.dataAuthorityId,
                  baseUrl: `http://127.0.0.1:${author.ready.port}`,
                  credentialEnv:
                    "MORPHZ_APP_COGNITIVE_CREDENTIAL_RUNTIME_FIXTURE",
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
              name === "MORPHZ_APP_COGNITIVE_CREDENTIAL_RUNTIME_FIXTURE"
                ? credential
                : undefined,
          };
        },
      });
      const host = f;
      await host.client.call(
        "projects.create",
        {
          commandId: randomUUID(),
          projectId,
          title: "TEST 独立认知应用实际 Runtime",
        },
        host.options,
      );
      await host.client.call(
        "cognitive-apps.install",
        { definition },
        host.options,
      );
      await host.client.call(
        "cognitive-apps.grant",
        {
          appId: definition.id,
          version: definition.version,
          expectedRevision: 0,
          state: "active",
        },
        host.options,
      );
      await host.client.call(
        "cognitive-apps.connect",
        {
          appId: definition.id,
          version: definition.version,
          connectionId: "runtime-notes-connection",
          expectedRevision: 0,
          serviceId: author!.ready.serviceId,
          dataAuthorityId: author!.ready.dataAuthorityId,
        },
        host.options,
      );
      const target = {
        appId: definition.id,
        version: definition.version,
        connectionId: "runtime-notes-connection",
      };
      const inputMarker = "ACTUAL_COGNITIVE_ONE_INPUT_TOOL_CHAIN";
      host.hold(inputMarker);
      await host.client.call(
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
        host.options,
      );
      let pending = await host.waitRequest(inputMarker);
      const tool = async (marker: string, cognitive: unknown) => {
        assert.ok(
          Array.isArray(pending.tools),
          "Actual Rust request must offer Host tools",
        );
        const since = host.requests.length;
        // Hold the continuation of the same actual input before releasing its
        // current model request. Receipt reads never borrow a different source.
        host.hold(inputMarker);
        host.releaseWithTool(inputMarker, objectToolName, {
          action: "cognitive",
          cognitive,
        });
        const after = await host.waitRequest(inputMarker, since);
        pending = after;
        const candidates = after.messages
          .filter(
            (message) =>
              message.role === "tool" && typeof message.content === "string",
          )
          .reverse();
        assert.ok(candidates[0], marker + ": actual physical result required");
        // Only the newest physical result may satisfy this step. Falling back
        // to an older success would conceal a real rejection or wrong source.
        const envelope = parseProtocolValue(
          JSON.parse(String(candidates[0].content)),
        );
        assert.ok(
          envelope &&
            typeof envelope === "object" &&
            !Array.isArray(envelope) &&
            "output_state" in envelope &&
            envelope.output_state === "content" &&
            "observation_ref" in envelope &&
            typeof envelope.observation_ref === "string" &&
            "result" in envelope &&
            typeof envelope.result === "string",
          marker + ": actual persisted Rust envelope required",
        );
        assert.match(envelope.observation_ref, /^@e\d+$/);
        const value = parseProtocolValue(JSON.parse(envelope.result));
        assert.ok(
          value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            "ok" in value &&
            value.ok === true &&
            "result" in value,
          marker +
            ": current Host result rejected: " +
            envelope.result.slice(0, 700),
        );
        return value.result;
      };
      const catalog = parseCognitiveAppCatalog(
        await tool("ACTUAL_COGNITIVE_DISCOVERY", { action: "list", limit: 50 }),
      );
      assert.equal(catalog.versions[0]?.appId, definition.id);
      const described = parseCognitiveAppDescription(
        await tool("ACTUAL_COGNITIVE_DESCRIPTION", {
          action: "describe",
          appId: definition.id,
          version: definition.version,
        }),
      );
      assert.deepEqual(described.definition, definition);
      const created = parseCognitiveAppCommandResult(
        await tool("ACTUAL_COGNITIVE_CREATE", {
          action: "invoke",
          ...target,
          mode: "command",
          operationId: "notes.create",
          parameters: {
            title: "Actual Agent original",
            markdown: "SYNTHETIC_PRIVATE_ORIGINAL_仅作者保管",
          },
          resources: [],
        }),
      );
      assert.equal(created.command.state, "committed");
      assert.equal(created.command.projectionState, "projected");
      const original = created.result as {
        objectId: string;
        versionRef: string;
      };
      const object = {
        objectId: original.objectId,
        versionRef: original.versionRef,
      };
      const authorRows = rows(
        authorDb,
        "SELECT command_id,binding_json FROM author_commands",
      );
      assert.equal(authorRows.length, 1);
      assert.equal(authorRows[0]!.command_id, created.commandId);
      const binding = JSON.parse(String(authorRows[0]!.binding_json)) as {
        actor: unknown;
        projectId: string;
      };
      const actor = parseDomainActor(binding.actor);
      assert.equal(actor.kind, "agent");
      assert.equal(actor.tenantId, tenantId);
      assert.equal(actor.principalId, localAccess.principalId);
      assert.equal(actor.actantId, morphzAgentAccess.actantId);
      assert.equal(actor.source.kind, "input");
      assert.equal(binding.projectId, projectId);
      assert.ok(actor.source.kind === "input");
      const ledger = rows(
        join(hostDirectory, "platform.sqlite"),
        "SELECT source_kind,runtime_input_id,actor_kind,actor_actant_id,project_id,state FROM cognitive_app_commands WHERE command_id=?",
        created.commandId,
      );
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.runtime_input_id, actor.source.inputId);
      assert.equal(ledger[0]!.source_kind, "input");
      assert.equal(ledger[0]!.actor_kind, "agent");
      assert.equal(ledger[0]!.actor_actant_id, morphzAgentAccess.actantId);
      assert.equal(ledger[0]!.project_id, projectId);
      assert.equal(ledger[0]!.state, "committed");
      assert.ok(host.sql("SELECT id FROM threads").length > 0);
      const read = parseCognitiveAppReadResult(
        await tool("ACTUAL_COGNITIVE_READ", {
          action: "invoke",
          ...target,
          mode: "read",
          operationId: "notes.list",
          parameters: { limit: 32 },
          resources: [],
        }),
      );
      assert.equal((read.result as { objects: unknown[] }).objects.length, 1);
      const exact = parseObjectReadResponse(
        await tool("ACTUAL_COGNITIVE_EXACT", {
          action: "read-object",
          ...target,
          object,
          maxBytes: 262144,
        }),
      );
      assert.equal(exact.object.versionRef, object.versionRef);
      assert.match(JSON.stringify(exact.content), /SYNTHETIC_PRIVATE_ORIGINAL/);
      const status = parseBrowserCommandFacts(
        await tool("ACTUAL_COGNITIVE_STATUS", {
          action: "status",
          ...target,
          commandId: created.commandId,
        }),
      );
      assert.equal(status.state, "committed");
      const recovered = parseCognitiveAppCommandResult(
        await tool("ACTUAL_COGNITIVE_RECOVERY", {
          action: "recover",
          ...target,
          commandId: created.commandId,
        }),
      );
      assert.equal(recovered.commandId, created.commandId);
      assert.equal(recovered.command.state, "committed");
      assert.equal(rows(authorDb, "SELECT * FROM notes").length, 1);
      assert.equal(rows(authorDb, "SELECT * FROM author_commands").length, 1);
      const human = parseBrowserCommandFacts(
        await host.client.call(
          "cognitive-apps.command-status",
          { projectId, ...target, commandId: created.commandId },
          host.options,
        ),
      );
      assert.deepEqual(human, recovered.command);
      const roots: Array<{
        id: string;
        root_turn_id: string;
        session_id: string;
      }> = host.sql("SELECT id,root_turn_id,session_id FROM threads");
      assert.equal(roots.length, 1, "All seven steps share one actual Thread");
      const root = roots[0]!;
      const inputEvent = await host.runtime
        .inputEvidenceReader()
        .readSessionEvent(root.session_id, root.root_turn_id);
      assert.ok(inputEvent && typeof inputEvent === "object");
      assert.equal(Reflect.get(inputEvent, "id"), root.root_turn_id);
      assert.equal(Reflect.get(inputEvent, "actor"), "Session-Client");
      const payload: unknown = Reflect.get(inputEvent, "payload");
      assert.ok(payload && typeof payload === "object");
      assert.equal(
        Reflect.get(payload, "client_message_id"),
        actor.source.inputId,
      );
      host.release(inputMarker);
      let finished = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        const threads: Array<{ id: string; status: string }> = host.sql(
          "SELECT id,status FROM threads WHERE id=?",
          root.id,
        );
        assert.equal(threads.length, 1);
        if (threads[0]!.status !== "open") {
          assert.equal(threads[0]!.status, "completed");
          finished = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        finished,
        true,
        "Actual Rust Thread must finish before fixture shutdown",
      );
      assert.doesNotMatch(
        JSON.stringify(host.requests),
        new RegExp(credential),
      );
      assert.equal(host.realCalls, 0);
      console.log(
        JSON.stringify({
          evidence: "isolated-cognitive-actual-runtime",
          model_requests: host.requests.length,
          upstream_model_requests: host.realCalls,
          author_commands: rows(authorDb, "SELECT * FROM author_commands")
            .length,
          author_originals: rows(authorDb, "SELECT * FROM notes").length,
          thread_status: "completed",
        }),
      );
    } finally {
      try {
        await f?.close();
      } finally {
        try {
          if (author) await stopPackedAuthor(author.child);
        } finally {
          packed.close();
        }
      }
    }
  },
);
