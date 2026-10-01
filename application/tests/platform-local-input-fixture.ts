import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import type { LocalFiles } from "../packages/application/src/local-files.js";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import type { WorkspaceStore } from "../packages/application/src/store.js";
import {
  localAccess,
  type RecordedInput,
  type Receipt,
} from "../packages/core/src/model.js";
import type {
  AgentToolArguments,
  HostInvocation,
} from "../packages/application/src/agent-tools.js";

export function assertNoLocalBusinessData(directory: string) {
  const db = new DatabaseSync(join(directory, "transport.sqlite"), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets','artifact_outputs','script_outputs','publication_sections')",
        )
        .all(),
      [],
      "Local file access must not recreate legacy business or file BLOB tables",
    );
  } finally {
    db.close();
  }
}

export function storedData(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return { type: "array", value: value.map(storedData) };
  if (typeof value === "number")
    return { type: "number", value: String(value) };
  if (typeof value === "object")
    return {
      type: "object",
      value: Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [key, storedData(entry)]),
      ),
    };
  return { type: typeof value, value };
}

/** Real Platform/Host/outbox/authority with controlled Runtime evidence.
 * The HTTP fixture does not claim actual model/job execution.
 */
export async function localInputFixture(
  directory: string,
  store: WorkspaceStore,
  files: LocalFiles,
) {
  assert.equal(Reflect.has(store, "snapshot"), false);
  assert.equal(Reflect.has(store, "execute"), false);
  const sessions = new Map<
    string,
    {
      id: string;
      context_id: string;
      permission_mode?: string;
      sandbox_mode?: string | null;
    }
  >();
  const accepted = new Map<
    string,
    { sessionId: string; body: Record<string, any> }
  >();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = new URL(request.url!, "http://localhost").pathname;
    const sessionId = path.split("/")[3]!;
    response.setHeader("Content-Type", "application/json");
    const send = (value: unknown) => response.end(JSON.stringify(value));
    if (path === "/api/status") return send({ model: "fixture" });
    if (path === "/api/session-io/capabilities")
      return send({ enabled: true, client_metadata: true, formats: [] });
    if (path === "/api/sessions" && request.method === "POST") {
      sessions.set(body.id, { id: body.id, context_id: body.mount.context_id });
      return send(sessions.get(body.id));
    }
    if (path.endsWith("/principal"))
      return send({
        ...sessions.get(sessionId),
        session_id: sessionId,
        principal_id: "fixture-human",
        capabilities: [],
      });
    if (path.endsWith("/io/messages")) {
      accepted.set(body.client_message_id, { sessionId, body });
      return send({
        accepted: true,
        event_id: `root-${body.client_message_id}`,
      });
    }
    if (path.includes("/threads/")) {
      const inputId = path.split("/").at(-1)!.slice("thread-".length);
      const input = accepted.get(inputId);
      if (input?.sessionId !== sessionId) {
        response.statusCode = 404;
        return send({});
      }
      return send({
        snapshot: {
          thread: {
            id: `thread-${inputId}`,
            session_id: sessionId,
            context_id: sessions.get(sessionId)!.context_id,
            root_turn_id: `root-${inputId}`,
            initiating_principal_id: "fixture-human",
            agent_id: "fixture-agent",
            executor_kind: "agent",
            executor_id: null,
          },
        },
      });
    }
    if (path.includes("/events/")) {
      const inputId = path.split("/").at(-1)!.slice("root-".length);
      const input = accepted.get(inputId);
      if (input?.sessionId !== sessionId) {
        response.statusCode = 404;
        return send({});
      }
      return send({
        event: {
          id: `root-${inputId}`,
          sequence: 1,
          timestamp: new Date().toISOString(),
          actor: "Session-Client",
          type: "session_message",
          topic: "chat/user_message",
          payload: {
            session_id: sessionId,
            context_id: sessions.get(sessionId)!.context_id,
            principal_id: "fixture-human",
            client_message_id: inputId,
            session_io: {
              request: {
                ...input.body,
                message: {
                  ...input.body.message,
                  content: {
                    ...input.body.message.content,
                    value: storedData(input.body.message.content.value),
                  },
                },
              },
            },
          },
        },
      });
    }
    if (path.endsWith("/events")) return send({ events: [] });
    if (path === "/api/approvals") return send({ approvals: [] });
    if (request.method === "PATCH") {
      assert.deepEqual(body, { permission_mode: "request_approval" });
      Object.assign(sessions.get(sessionId)!, {
        permission_mode: body.permission_mode,
        sandbox_mode: null,
      });
    }
    response.statusCode = sessions.has(sessionId) ? 200 : 404;
    return send(sessions.get(sessionId) ?? {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const domains = await openApplicationDomainsHost(directory, store);
  const runtime = new RuntimeBridge(store, {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "unit-fixture",
    namespace: randomUUID(),
  });
  const binding = domains.bindRuntime(runtime, files);
  const app = new Application(store, {
    runtime,
    localFiles: files,
    platformWork: domains.work,
    platformDocuments: domains.content,
  }).session(localAccess);
  await app.createPlatformProject({
    commandId: randomUUID(),
    projectId: "first-project",
    title: "原位文件权限测试",
  });
  type Delivery = {
    inputId: string;
    sessionId: string;
    rootId: string | null;
    platformSource: Omit<RecordedInput, "id" | "status">;
    request: { message: { content: { value: Record<string, unknown> } } };
  };
  const delivery = (id: string) => {
    const state = store.runtimeState() as { deliveries: Delivery[] };
    const value = state.deliveries.find((item) => item.inputId === id);
    assert.ok(value, "The input must be in the actual Host outbox");
    return value;
  };
  return {
    app,
    input(id: string): RecordedInput {
      const source = delivery(id).platformSource;
      return {
        ...source,
        id,
        status: "recorded",
        artifactId: source.artifactId ?? null,
        artifactRevision: source.artifactRevision ?? null,
        selection: source.selection ?? "",
      };
    },
    async send(command: unknown) {
      const receipt = (await app.platformMessage(command)) as Receipt;
      const deadline = Date.now() + 5000;
      while (!delivery(receipt.entityId).rootId && Date.now() < deadline) {
        await runtime.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        delivery(receipt.entityId).rootId,
        `Controlled Runtime must accept the exact queued input: ${JSON.stringify(store.runtimeState())}`,
      );
      return receipt;
    },
    tools(inputId: () => string) {
      const tools = new PlatformAgentTools({
        authority: binding.authority,
        work: domains.work.service,
        content: domains.content,
        inputForInvocation: (route) => runtime.platformToolInput(route),
        localFiles: files,
      });
      return {
        async call(envelope: {
          invocation: HostInvocation;
          arguments: AgentToolArguments;
        }) {
          const sessionId = delivery(inputId()).sessionId;
          const route: HostInvocation = {
            ...envelope.invocation,
            session_id: sessionId,
            context_id: sessions.get(sessionId)!.context_id,
            principal_id: "fixture-human",
            agent_id: "fixture-agent",
            thread_id: `thread-${inputId()}`,
          };
          return tools.call(
            route,
            await runtime.toolScope(route),
            envelope.arguments,
          );
        },
      };
    },
    async close() {
      await runtime.stop();
      await domains.unbindRuntime(binding.authority);
      await domains.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
