import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../packages/application/src/application.js";
import { createAppServer } from "../apps/service/src/http.js";
import { embeddedResources } from "../apps/desktop/application-host.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { LocalFiles } from "../packages/application/src/local-files.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { localAccess } from "../packages/core/src/model.js";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import {
  emptyScriptBrief,
  defaultScriptExportTemplate,
  emptyScriptDraft,
} from "../packages/core/src/script-studio.js";

function storedData(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number")
    return { type: "number", value: String(value) };
  if (Array.isArray(value))
    return { type: "array", value: value.map(storedData) };
  if (typeof value === "object")
    return {
      type: "object",
      value: Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, storedData(item)]),
      ),
    };
  throw new TypeError("Unsupported Runtime fixture Data value");
}
type FixtureEvent = {
  id: string;
  sequence: number;
  timestamp: string;
  topic: string;
  payload: Record<string, unknown>;
};
type FixtureTimelineItem = {
  entry_id: string;
  visible_at: string;
  visible_at_micros: number;
  root_turn_id: string;
  attempt_id: string | null;
  display_kind: string;
  final_event: boolean;
  event: FixtureEvent;
  root_event: FixtureEvent | null;
};

/** Mirror Runtime SQL's integer-microsecond timeline independently of the
 * application's ISO parser. Immutable Event payloads retain their nanoseconds.
 */
function sqlTimelineTime(iso: string) {
  const fraction = /\.(\d+)Z$/.exec(iso)?.[1] ?? "";
  const micros =
    Date.parse(iso.replace(/\.\d+Z$/, "Z")) * 1_000 +
    Number(fraction.padEnd(6, "0").slice(0, 6));
  return {
    visible_at: iso.replace(
      /(?:\.\d+)?Z$/,
      `.${fraction.padEnd(6, "0").slice(0, 6)}Z`,
    ),
    visible_at_micros: micros,
  };
}

test("Platform-only project sends a durable Runtime input without a legacy workspace project", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-input-"));
  const workspaceFile = join(directory, "workspace.sqlite");
  const workspace = new WorkspaceStore(workspaceFile, { mode: "transport" });
  const assertNoLegacyWorkspace = (filename = workspaceFile) => {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workspace', 'assets')",
          )
          .all(),
        [],
      );
    } finally {
      db.close();
    }
  };
  assertNoLegacyWorkspace();
  const sessions = new Map<
    string,
    { id: string; context_id: string; permission_mode: string | null }
  >();
  const events = new Map<string, FixtureEvent[]>();
  const sent: Array<Record<string, unknown>> = [];
  let rootLookupReads = 0;
  const acceptedRoots = new Map<
    string,
    { sessionId: string; event: FixtureEvent }
  >();
  const approvalDecisions: string[] = [];
  let jobListReads = 0;
  let failNextMessageId: string | null = null;
  let clientMetadataAvailable = true;
  let capabilityProbeStatus = 200;
  const sentSessions = new Map<string, string>();
  const stages = new Map<
    string,
    {
      expected: string;
      size: number;
      bytes: Buffer;
      name: string;
      mime: string;
    }
  >();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body =
      chunks.length &&
      request.headers["content-type"] !== "application/octet-stream"
        ? JSON.parse(Buffer.concat(chunks).toString())
        : null;
    const path = new URL(request.url!, "http://localhost").pathname;
    response.setHeader("Content-Type", "application/json");
    const send = (status: number, result: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(result));
    };
    if (path === "/api/status") return send(200, { model: "test-model" });
    if (path === "/api/session-io/capabilities") {
      if (capabilityProbeStatus !== 200)
        return send(capabilityProbeStatus, {
          error: "Temporary capability probe failure",
        });
      return send(200, {
        enabled: true,
        resources: true,
        directed_input: true,
        client_metadata: clientMetadataAvailable,
        harnesses: [scriptStudioApplication.harness],
        formats: [
          { definition: { id: "morphz.application.input", version: "4" } },
        ],
      });
    }
    if (path === "/api/sessions" && request.method === "POST") {
      const session = {
        id: body.id,
        context_id: body.mount.context_id,
        permission_mode: null,
      };
      sessions.set(session.id, session);
      return send(201, session);
    }
    const sessionId = path.split("/")[3]!;
    if (/^\/api\/sessions\/[^/]+$/.test(path) && request.method === "PATCH") {
      const session = sessions.get(sessionId);
      if (!session) return send(404, { error: "Unknown Runtime session" });
      session.permission_mode = body.permission_mode;
      return send(200, session);
    }
    if (path.endsWith("/attachment-stages") && request.method === "POST") {
      const prior = stages.get(body.stage_id);
      if (!prior)
        stages.set(body.stage_id, {
          expected: body.expected_sha256,
          size: body.size_bytes,
          bytes: Buffer.alloc(0),
          name: body.name,
          mime: body.media_type,
        });
      const stage = stages.get(body.stage_id)!;
      return send(200, {
        offset: stage.bytes.length,
        status: stage.bytes.length === stage.size ? "ready" : "uploading",
        sha256: stage.bytes.length === stage.size ? stage.expected : null,
      });
    }
    if (
      path.endsWith("/content") &&
      path.includes("/attachment-stages/") &&
      request.method === "PUT"
    ) {
      const stageId = path.split("/").at(-2)!;
      const stage = stages.get(stageId)!;
      assert.equal(
        Number(request.headers["x-morphz-upload-offset"]),
        stage.bytes.length,
      );
      stage.bytes = Buffer.concat([stage.bytes, raw]);
      assert.ok(stage.bytes.length <= stage.size);
      return send(200, {
        offset: stage.bytes.length,
        status: stage.bytes.length === stage.size ? "ready" : "uploading",
        sha256: stage.bytes.length === stage.size ? stage.expected : null,
      });
    }
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "runtime-local-human",
        session_id: sessionId,
        context_id: sessions.get(sessionId)?.context_id,
        capabilities: [],
      });
    const attachmentPath =
      /^\/api\/sessions\/([^/]+)\/events\/([^/]+)\/attachments\/([^/]+)$/.exec(
        path,
      );
    if (request.method === "GET" && attachmentPath) {
      const root = [...acceptedRoots.values()].find(
        (item) =>
          item.sessionId === sessionId && item.event.id === attachmentPath[2],
      )?.event;
      const metadata = (
        root?.payload.attachments as
          | Array<{
              id: string;
              sha256: string;
              media_type: string;
            }>
          | undefined
      )?.find((item) => item.id === attachmentPath[3]);
      const stage =
        metadata &&
        [...stages.values()].find((item) => item.expected === metadata.sha256);
      if (!metadata || !stage)
        return send(404, { error: "attachment not found" });
      response.writeHead(200, { "Content-Type": metadata.media_type });
      response.end(stage.bytes);
      return;
    }
    if (request.method === "GET" && path.includes("/events/")) {
      const eventId = decodeURIComponent(path.split("/").at(-1)!);
      const event =
        events.get(sessionId)?.find((item) => item.id === eventId) ??
        [...acceptedRoots.values()].find(
          (accepted) =>
            accepted.sessionId === sessionId && accepted.event.id === eventId,
        )?.event;
      return event
        ? send(200, { event })
        : send(404, { error: "event not found" });
    }
    if (request.method === "GET" && path.includes("/messages/by-client-id/")) {
      rootLookupReads++;
      const inputId = decodeURIComponent(path.split("/").at(-1)!);
      const accepted = acceptedRoots.get(inputId);
      return accepted?.sessionId === sessionId
        ? send(200, { event: accepted.event })
        : send(404, { error: "message not found" });
    }
    if (request.method === "GET" && path.endsWith("/timeline")) {
      if (!sessions.has(sessionId))
        return send(404, { error: "session not found" });
      const roots = [...acceptedRoots.entries()]
        .filter(([, accepted]) => accepted.sessionId === sessionId)
        .map(([inputId, accepted]) => ({ inputId, event: accepted.event }));
      const byRoot = new Map(roots.map((root) => [root.event.id, root.event]));
      const scoped = events.get(sessionId) ?? [];
      const firstVisible = new Map(
        scoped.flatMap((event) =>
          event.topic === "runtime/model_public_output" &&
          typeof event.payload.attempt_id === "string" &&
          typeof event.payload.first_visible_at === "string"
            ? [
                [
                  event.payload.attempt_id,
                  event.payload.first_visible_at,
                ] as const,
              ]
            : [],
        ),
      );
      const entries: FixtureTimelineItem[] = roots.map(
        ({ inputId, event }) => ({
          entry_id: inputId,
          ...sqlTimelineTime(event.timestamp),
          root_turn_id: event.id,
          attempt_id: null,
          display_kind: "input",
          final_event: false,
          event,
          root_event: null,
        }),
      );
      for (const event of scoped) {
        const rootId = event.payload.root_turn_id;
        const root = typeof rootId === "string" ? byRoot.get(rootId) : null;
        if (!root) continue;
        const kind = ["chat/reply", "chat/outbound_message"].includes(
          event.topic,
        )
          ? "reply"
          : event.topic === "chat/progress"
            ? "progress"
            : ["chat/runtime_error", "session/io_state"].includes(event.topic)
              ? "error"
              : null;
        if (!kind) continue;
        const text =
          event.payload.text ?? event.payload.error ?? event.payload.message;
        if (typeof text !== "string" || !text) continue;
        const attempt =
          typeof event.payload.attempt_id === "string"
            ? event.payload.attempt_id
            : null;
        const visible =
          (attempt && firstVisible.get(attempt)) || event.timestamp;
        entries.push({
          entry_id: attempt ? "publication:" + attempt : event.id,
          ...sqlTimelineTime(visible),
          root_turn_id: root.id,
          attempt_id: attempt,
          display_kind: kind,
          final_event: true,
          event,
          root_event: root,
        });
      }
      const query = new URL(request.url!, "http://localhost").searchParams;
      const beforeTime = query.get("before_time_micros");
      const beforeId = query.get("before_entry_id");
      const limit = Math.min(100, Number(query.get("limit") ?? 100));
      const sorted = entries
        .filter(
          (entry) =>
            !beforeTime ||
            entry.visible_at_micros < Number(beforeTime) ||
            (entry.visible_at_micros === Number(beforeTime) &&
              entry.entry_id < beforeId!),
        )
        .sort(
          (a, b) =>
            b.visible_at_micros - a.visible_at_micros ||
            b.entry_id.localeCompare(a.entry_id),
        )
        .slice(0, limit);
      const oldest = sorted.at(-1);
      return send(200, {
        entries: sorted.reverse(),
        next_before:
          sorted.length === limit && oldest
            ? {
                visible_at_micros: oldest.visible_at_micros,
                entry_id: oldest.entry_id,
              }
            : null,
      });
    }
    const familyPath =
      /^\/api\/sessions\/([^/]+)\/threads\/([^/]+)\/family$/.exec(path);
    if (request.method === "GET" && familyPath) {
      const threadId = decodeURIComponent(familyPath[2]!);
      const inputId = threadId.startsWith("thread-")
        ? threadId.slice("thread-".length)
        : "";
      const sourceSessionId = sentSessions.get(inputId);
      if (sourceSessionId !== familyPath[1])
        return send(404, { error: "Session Thread not found" });
      return send(200, {
        session_id: sourceSessionId,
        context_id: sessions.get(sourceSessionId)?.context_id,
        selected_thread_id: threadId,
        generated_at: "2026-10-03T00:00:00.000Z",
        limit: Number(
          new URL(request.url!, "http://localhost").searchParams.get("limit") ??
            64,
        ),
        has_more: false,
        threads: [
          {
            id: threadId,
            session_id: sourceSessionId,
            context_id: sessions.get(sourceSessionId)?.context_id,
            root_turn_id: `root-${inputId}`,
            parent_thread_id: null,
            revision: 1,
            generation: 1,
          },
        ],
      });
    }
    if (request.method === "GET" && path.includes("/threads/")) {
      const threadId = decodeURIComponent(path.split("/").at(-1)!);
      const inputId = threadId.startsWith("thread-")
        ? threadId.slice("thread-".length)
        : "";
      const sourceSessionId = sentSessions.get(inputId);
      return sourceSessionId
        ? send(200, {
            snapshot: {
              thread: {
                id: threadId,
                session_id: sourceSessionId,
                context_id: sessions.get(sourceSessionId)?.context_id,
                root_turn_id: `root-${inputId}`,
                revision: 1,
                updated_at: "2026-10-03T00:00:00.000Z",
                initiating_principal_id: "runtime-local-human",
                generation: 1,
                control_state: "active",
                lifecycle: "open",
                kind: "execution",
                executor_kind: "self",
              },
            },
          })
        : send(404, { error: "thread not found" });
    }
    if (path.endsWith("/io/messages")) {
      if (body.client_message_id === failNextMessageId) {
        failNextMessageId = null;
        return send(503, { error: "temporary dispatch failure" });
      }
      sent.push(body);
      sentSessions.set(body.client_message_id, sessionId);
      if (body.client_metadata?.kind === "morphz.platform-input") {
        const source = body.client_metadata.source;
        const references = body.message?.content?.value?.attachments ?? [];
        const attachments = references.map(
          (reference: { stage_id: string }) => {
            const stage = stages.get(reference.stage_id);
            assert.ok(stage && stage.bytes.length === stage.size);
            return {
              id: `attachment_${stage.expected}`,
              name: stage.name,
              media_type: stage.mime,
              size_bytes: stage.size,
              sha256: stage.expected,
            };
          },
        );
        acceptedRoots.set(body.client_message_id, {
          sessionId,
          event: {
            id: `root-${body.client_message_id}`,
            sequence: 0,
            timestamp: new Date().toISOString(),
            topic: "chat/user_message",
            payload: {
              session_id: sessionId,
              // A local Runtime records its own default principal, not the
              // gateway-only Morphz principal mapping.
              principal_id: "principal-default",
              client_message_id: body.client_message_id,
              ...(attachments.length ? { attachments } : {}),
              session_io: {
                request: {
                  client_message_id: body.client_message_id,
                  client_metadata: storedData(body.client_metadata),
                  message: {
                    content: {
                      encoding: "json",
                      value: storedData({
                        input_id: body.client_message_id,
                        workspace_id: source.projectId,
                        author_actant_id: source.author.actantId,
                      }),
                    },
                  },
                },
              },
            },
          },
        });
      }
      if (body.activation?.input_destination)
        return send(200, {
          accepted: true,
          event_id: `steer-${body.client_message_id}`,
        });
      const scoped = events.get(sessionId) ?? [];
      const firstAttempt =
        sent.length === 1 ? `attempt-${body.client_message_id}` : null;
      if (firstAttempt)
        scoped.push({
          id: `model_public_output_${firstAttempt}`,
          sequence: scoped.length + 1,
          timestamp: new Date().toISOString(),
          topic: "runtime/model_public_output",
          payload: {
            root_turn_id: `root-${body.client_message_id}`,
            session_id: sessionId,
            attempt_id: firstAttempt,
            first_visible_at: new Date().toISOString().replace("Z", "123456Z"),
            text: "回复 从新",
            complete: true,
          },
        });
      scoped.push({
        id: `reply-${body.client_message_id}`,
        sequence: scoped.length + 1,
        timestamp: new Date().toISOString(),
        topic: "chat/reply",
        payload: {
          root_turn_id: `root-${body.client_message_id}`,
          session_id: sessionId,
          ...(firstAttempt ? { attempt_id: firstAttempt } : {}),
          text: `回复 ${body.message.content.value.text}`,
        },
      });
      events.set(sessionId, scoped);
      return send(200, {
        accepted: true,
        event_id: `root-${body.client_message_id}`,
      });
    }
    if (path.endsWith("/events")) {
      const query = new URL(request.url!, "http://localhost").searchParams;
      const after = Number(query.get("after_sequence") ?? 0);
      const before = Number(query.get("before_sequence") ?? Infinity);
      const root = query.get("root_turn_id");
      const attempt = query.get("attempt_id");
      const limit = Number(query.get("limit") ?? 1000);
      const matches = (events.get(sessionId) ?? []).filter(
        (event) =>
          event.sequence > after &&
          event.sequence < before &&
          (!root || event.payload.root_turn_id === root) &&
          (!attempt || event.payload.attempt_id === attempt),
      );
      return send(200, {
        events:
          root || Number.isFinite(before) || !query.has("after_sequence")
            ? matches.slice(-limit)
            : matches.slice(0, limit),
        latest_sequence: matches.at(-1)?.sequence ?? null,
      });
    }
    if (path.endsWith("/scheduler"))
      return send(200, {
        threads: [...sentSessions].map(([inputId, scopedSessionId]) => ({
          intent: null,
          phase: "running",
          thread: {
            id: `thread-${inputId}`,
            kind: "execution",
            session_id: scopedSessionId,
            context_id: sessions.get(scopedSessionId)?.context_id,
            root_turn_id: `root-${inputId}`,
            lifecycle: "open",
            revision: 1,
            updated_at: new Date().toISOString(),
          },
        })),
      });
    if (path === "/api/approvals")
      return send(200, {
        approvals: [...sentSessions].map(([inputId, scopedSessionId]) => ({
          requested_at: "2030-01-01T00:00:00.000Z",
          request: {
            approval_id: `approval-${inputId}`,
            session_id: scopedSessionId,
            context_id: sessions.get(scopedSessionId)?.context_id,
            root_turn_id: `root-${inputId}`,
            justification: "测试审批归属",
            action: {},
            requested: {},
          },
        })),
      });
    if (path.startsWith("/api/approvals/") && request.method === "POST") {
      approvalDecisions.push(decodeURIComponent(path.split("/").at(-1)!));
      return send(200, { accepted: true });
    }
    if (path === "/api/execution-jobs" && request.method === "GET") {
      jobListReads++;
      const query = new URL(request.url!, "http://localhost").searchParams;
      return send(200, {
        jobs: [...sentSessions]
          .filter(
            ([, scopedSessionId]) =>
              scopedSessionId === query.get("session_id") &&
              sessions.get(scopedSessionId)?.context_id ===
                query.get("context_id"),
          )
          .map(([inputId, scopedSessionId]) => ({
            id: `job-${inputId}`,
            revision: 1,
            session_id: scopedSessionId,
            context_id: sessions.get(scopedSessionId)?.context_id,
            tool_name: "test-tool",
            target_id: "test-target",
            thread_id: `thread-${inputId}`,
            status: "succeeded",
            created_at: "2030-01-01T00:00:00.000Z",
            updated_at: "2030-01-01T00:00:00.000Z",
            cancel_requested_at: null,
            error: null,
            exit_code: 0,
            request: {},
            result_event_id: `result-${inputId}`,
          })),
      });
    }
    if (path.startsWith("/api/execution-jobs/") && request.method === "GET") {
      const [, , , jobId, suffix] = path.split("/");
      const inputId = jobId?.startsWith("job-") ? jobId.slice(4) : "";
      const scopedSessionId = sentSessions.get(inputId);
      if (!scopedSessionId) return send(404, { error: "job not found" });
      if (suffix === "result")
        return send(200, {
          job_id: jobId,
          event: {
            id: `result-${inputId}`,
            payload: {
              session_id: scopedSessionId,
              context_id: sessions.get(scopedSessionId)?.context_id,
              text: `执行结果 ${inputId}`,
            },
          },
        });
      return send(200, {
        id: jobId,
        revision: 1,
        session_id: scopedSessionId,
        context_id: sessions.get(scopedSessionId)?.context_id,
        tool_name: "test-tool",
        target_id: "test-target",
        thread_id: `thread-${inputId}`,
        status: "succeeded",
        created_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
        cancel_requested_at: null,
        error: null,
        exit_code: 0,
        request: {},
        result_event_id: `result-${inputId}`,
      });
    }
    if (request.method === "GET" && path.startsWith("/api/sessions/"))
      return send(
        sessions.has(sessionId) ? 200 : 404,
        sessions.get(sessionId) ?? { error: "not found" },
      );
    return send(200, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "test-only",
    namespace: randomUUID(),
  };
  let runtime = new RuntimeBridge(workspace, config);
  let secondWorkspace: WorkspaceStore | undefined;
  let secondRuntime: RuntimeBridge | undefined;
  const secondHostDirectory = mkdtempSync(
    join(tmpdir(), "morphz-platform-input-second-host-"),
  );
  const domains = await openApplicationDomainsHost(directory, workspace);
  const localFiles = new LocalFiles(
    join(directory, "local-file-references.json"),
    workspace.identity(),
  );
  let binding = domains.bindRuntime(runtime, localFiles);
  let stopPlatformStream: (() => void) | undefined;
  const session = () =>
    new Application(workspace, {
      runtime,
      platformWork: domains.work,
      platformDocuments: domains.content,
      platformScripts: domains.content,
      platformReader: domains.reader,
      messageAttachments: domains.messageAttachments,
      localFiles,
    }).session(localAccess);
  const input = (commandId: string, projectId: string, body: string) => ({
    commandId,
    operation: {
      type: "record-input" as const,
      projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body,
      targetActantId: "morphz-agent",
    },
  });
  try {
    await session().createPlatformProject({
      commandId: randomUUID(),
      projectId: "new-platform-project",
      title: "新项目",
    });
    await session().createPlatformProject({
      commandId: randomUUID(),
      projectId: "other-platform-project",
      title: "另一个项目",
    });
    await session().createPlatformProject({
      commandId: randomUUID(),
      projectId: "retirement-test-project",
      title: "退役核验项目",
    });
    const archiveCommand = {
      commandId: randomUUID(),
      projectId: "retirement-test-project",
      expectedRevision: 1,
      state: "archived" as const,
    };
    assert.equal(
      await session().changePlatformProjectState(archiveCommand),
      archiveCommand.projectId,
    );
    assert.equal(
      await session().changePlatformProjectState(archiveCommand),
      archiveCommand.projectId,
      "an uncertain Host reply reuses the same retirement command",
    );
    assert.ok(
      (
        await session().getPlatformProject({
          projectId: archiveCommand.projectId,
        })
      ).archivedAt,
    );
    await session().changePlatformProjectState({
      commandId: randomUUID(),
      projectId: archiveCommand.projectId,
      expectedRevision: 2,
      state: "active",
    });
    const command = input(randomUUID(), "new-platform-project", "从新项目发送");
    assert.deepEqual(await session().platformMessage(command), {
      commandId: command.commandId,
      entityId: command.commandId,
    });
    assertNoLegacyWorkspace();
    await assert.rejects(
      session().platformMessage({
        ...command,
        operation: { ...command.operation, body: "另一条消息" },
      }),
      /操作标识已用于另一条输入/,
    );
    const wrongConversation = input(
      randomUUID(),
      "other-platform-project",
      "越界",
    );
    await assert.rejects(
      session().platformMessage({
        ...wrongConversation,
        operation: {
          ...wrongConversation.operation,
          conversationId: "new-platform-project",
        },
      }),
      /对话不属于这个项目/,
    );
    await runtime.tick();
    assert.equal(
      sent.length,
      1,
      "await tick joins the wake-up already in flight and observes its dispatch",
    );
    assert.equal(sent[0]!.client_message_id, command.commandId);
    const firstMetadata = sent[0]!.client_metadata as {
      kind: string;
      version: number;
      source: {
        projectId: string;
        conversationId: string;
        author: { principalId: string; actantId: string };
        body: string;
      };
    };
    assert.equal(firstMetadata.kind, "morphz.platform-input");
    assert.equal(firstMetadata.version, 1);
    assert.equal(firstMetadata.source.projectId, "new-platform-project");
    assert.equal(firstMetadata.source.conversationId, "new-platform-project");
    assert.deepEqual(firstMetadata.source.author, localAccess);
    assert.equal(firstMetadata.source.body, "从新项目发送");
    assert.deepEqual(
      (sent[0]!.message as { content: { value: unknown } }).content.value,
      {
        text: "从新项目发送",
        input_id: command.commandId,
        workspace_id: "new-platform-project",
        author_actant_id: localAccess.actantId,
      },
    );
    assertNoLegacyWorkspace();
    let firstHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    });
    const replyDeadline = Date.now() + 4000;
    while (
      !firstHistory.runtime.messages.length &&
      Date.now() < replyDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      firstHistory = await session().platformConversationHistory({
        projectId: "new-platform-project",
        conversationId: "new-platform-project",
      });
    }
    assert.deepEqual(
      firstHistory.inputs.map((item) => [item.id, item.body]),
      [[command.commandId, "从新项目发送"]],
    );
    assert.deepEqual(
      firstHistory.runtime.messages.map((message) => [
        message.inputId,
        message.text,
      ]),
      [[command.commandId, "回复 从新项目发送"]],
    );
    assert.equal(
      firstHistory.runtime.messages[0]!.id,
      `publication:attempt-${command.commandId}`,
    );
    assert.equal(
      firstHistory.runtime.messages[0]!.createdAt,
      sqlTimelineTime(
        String(
          events.get(sentSessions.get(command.commandId)!)?.[0]?.payload
            .first_visible_at,
        ),
      ).visible_at,
      "history retains the durable first-visible time at SQL microsecond precision",
    );
    assert.deepEqual(
      firstHistory.runtime.deliveries.map((delivery) => delivery.inputId),
      [command.commandId],
    );
    const lookupsBeforeOwnQuote = rootLookupReads;
    assert.deepEqual(
      await runtime.platformMessageSource(
        {
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        },
        localAccess,
        command.commandId,
        command.commandId,
      ),
      {
        id: command.commandId,
        inputId: command.commandId,
        projectId: "new-platform-project",
        conversationId: "new-platform-project",
        createdAt: firstHistory.inputs[0]!.createdAt,
        text: "从新项目发送",
      },
    );
    assert.ok(
      rootLookupReads > lookupsBeforeOwnQuote,
      "the sending Host also resolves an accepted quote through Runtime, not its private Event mirror",
    );
    const historyScope = {
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    };
    const latestPage = await session().platformConversationHistory({
      ...historyScope,
      limit: 1,
    });
    assert.ok(latestPage.nextCursor);
    const previousPage = await session().platformConversationHistory({
      ...historyScope,
      before: latestPage.nextCursor!,
      limit: 1,
    });
    assert.equal(previousPage.nextCursor, null);
    for (const createdAt of [
      latestPage.nextCursor!.createdAt.replace("Z", "456Z"),
      new Date(Date.parse(latestPage.nextCursor!.createdAt) + 8 * 3_600_000)
        .toISOString()
        .slice(0, 19) +
        latestPage.nextCursor!.createdAt.slice(19, -1) +
        "+08:00",
    ]) {
      const equivalentPage = await runtime.platformConversationHistory(
        historyScope,
        localAccess,
        { limit: 1, before: { ...latestPage.nextCursor!, createdAt } },
      );
      assert.deepEqual(equivalentPage.inputs, previousPage.inputs);
      assert.deepEqual(
        equivalentPage.runtime.messages,
        previousPage.runtime.messages,
        "nanosecond and offset cursor expressions use the same integer SQL ordering key",
      );
    }
    assert.deepEqual(
      [latestPage, previousPage]
        .flatMap((page) => [
          ...page.inputs.map((item) => item.id),
          ...page.runtime.messages.map((item) => item.id),
        ])
        .sort(),
      [command.commandId, `publication:attempt-${command.commandId}`].sort(),
      "history pages use Runtime's exact ordering cursor without dropping input or reply",
    );
    const firstSessionId = sentSessions.get(command.commandId)!;
    const firstEvents = events.get(firstSessionId)!;
    for (let ordinal = 0; ordinal < 105; ordinal++)
      firstEvents.push({
        id: `root-noise-${ordinal}`,
        sequence: firstEvents.length + 1,
        timestamp: new Date().toISOString(),
        topic: "runtime/internal_signal",
        payload: {
          session_id: firstSessionId,
          root_turn_id: `root-${command.commandId}`,
          attempt_id: `attempt-${command.commandId}`,
        },
      });
    secondWorkspace = new WorkspaceStore(
      join(secondHostDirectory, "workspace.sqlite"),
      { mode: "transport", tenantId: workspace.identity() },
    );
    assert.equal(secondWorkspace.identity(), workspace.identity());
    assertNoLegacyWorkspace(join(secondHostDirectory, "workspace.sqlite"));
    secondRuntime = new RuntimeBridge(secondWorkspace, config);
    secondRuntime.bindPlatformReadAuthority((scope, access) =>
      domains.content.authority.withSession(
        access,
        () => {},
        (actor) =>
          domains.content.platform.authorizeConversationRead(actor, scope),
      ),
    );
    const sourceScope = {
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    };
    const remoteHistory = await secondRuntime.platformConversationHistory(
      sourceScope,
      localAccess,
    );
    assert.deepEqual(remoteHistory.inputs, firstHistory.inputs);
    assert.deepEqual(
      remoteHistory.runtime.messages,
      firstHistory.runtime.messages,
      "accepted replies have one Runtime-owned history on both Hosts",
    );
    assert.deepEqual(remoteHistory.runtime.deliveries, []);
    const remoteFrames: string[][] = [];
    const stopRemoteStream = await secondRuntime.observePlatformConversation(
      sourceScope,
      localAccess,
      (value) => remoteFrames.push(value.messages.map((item) => item.text)),
      () => {},
    );
    const remoteFrameDeadline = Date.now() + 4000;
    while (
      !remoteFrames.at(-1)?.includes("回复 从新项目发送") &&
      Date.now() < remoteFrameDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(remoteFrames.at(-1)?.includes("回复 从新项目发送"));
    stopRemoteStream();
    assert.deepEqual(
      await secondRuntime.platformMessageSource(
        sourceScope,
        localAccess,
        command.commandId,
        command.commandId,
      ),
      {
        id: command.commandId,
        inputId: command.commandId,
        ...sourceScope,
        createdAt: firstHistory.inputs[0]!.createdAt,
        text: "从新项目发送",
      },
    );
    assert.deepEqual(
      await secondRuntime.platformMessageSource(
        sourceScope,
        localAccess,
        `publication:attempt-${command.commandId}`,
        command.commandId,
      ),
      {
        id: `publication:attempt-${command.commandId}`,
        inputId: command.commandId,
        ...sourceScope,
        createdAt: String(firstEvents[0]!.payload.first_visible_at),
        text: "回复 从新项目发送",
      },
      "another Host may quote the reply only through its exact Runtime root",
    );
    assert.deepEqual(
      await secondRuntime.platformMessageSource(
        sourceScope,
        localAccess,
        `stream:attempt-${command.commandId}`,
        command.commandId,
      ),
      {
        id: `stream:attempt-${command.commandId}`,
        inputId: command.commandId,
        ...sourceScope,
        createdAt: String(firstEvents[0]!.payload.first_visible_at),
        text: "回复 从新",
      },
      "an incomplete stream is citeable only after Runtime stores its public output",
    );
    assert.equal(
      await secondRuntime.platformMessageSource(
        sourceScope,
        localAccess,
        "publication:attempt-not-in-this-root",
        command.commandId,
      ),
      null,
    );
    const executionScope = {
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
      artifactId: null,
      inputId: command.commandId,
    };
    const execution = await session().executionSnapshot(executionScope);
    assert.deepEqual(
      execution.jobs.map((job) => job.id),
      [`job-${command.commandId}`],
    );
    assert.deepEqual(
      execution.approvals.map((approval) => approval.request.approval_id),
      [`approval-${command.commandId}`],
    );
    const branchExecution = await session().executionSnapshot({
      ...executionScope,
      threadId: `thread-${command.commandId}`,
    });
    assert.deepEqual(
      branchExecution.jobs.map((job) => job.id),
      [`job-${command.commandId}`],
    );
    const listReadsBeforeResult = jobListReads;
    assert.deepEqual(
      await session().executionResult({
        scope: executionScope,
        jobId: `job-${command.commandId}`,
      }),
      {
        text: `执行结果 ${command.commandId}`,
        truncated: false,
        available: true,
      },
    );
    assert.equal(
      jobListReads,
      listReadsBeforeResult,
      "reading one result must not enumerate the whole conversation's jobs",
    );
    assert.deepEqual(
      await session().executionSnapshot({
        projectId: "other-platform-project",
        conversationId: "other-platform-project",
        artifactId: null,
      }),
      { jobs: [], approvals: [], limit: 100 },
      "another Platform project cannot see this execution",
    );
    await assert.rejects(
      session().executionSnapshot({
        ...executionScope,
        projectId: "other-platform-project",
        conversationId: "other-platform-project",
      }),
      /执行不属于当前工作对话/,
    );
    await assert.rejects(
      session().executionControl({
        scope: {
          ...executionScope,
          projectId: "other-platform-project",
          conversationId: "other-platform-project",
        },
        action: {
          type: "allow-once",
          approvalId: `approval-${command.commandId}`,
          fingerprint: execution.approvals[0]!.fingerprint,
        },
      }),
      /执行不属于当前工作对话/,
    );
    assert.deepEqual(approvalDecisions, []);
    assert.deepEqual(
      await session().executionControl({
        scope: executionScope,
        action: {
          type: "allow-once",
          approvalId: `approval-${command.commandId}`,
          fingerprint: execution.approvals[0]!.fingerprint,
        },
      }),
      { accepted: true },
    );
    assert.deepEqual(approvalDecisions, [`approval-${command.commandId}`]);
    const navigation = await session().platformRuntimeNavigation();
    assert.match(navigation.historyVersion ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(
      navigation.runtime.messages,
      [],
      "global navigation does not copy reply bodies",
    );
    assert.ok(navigation.activityByProject["new-platform-project"]);
    assert.ok(
      navigation.runtime.deliveries.every(
        (delivery) => delivery.inputId === command.commandId,
      ),
    );
    const hidden = runtime.platformNavigationSnapshot(localAccess, [
      "other-platform-project",
    ]);
    assert.notEqual(
      hidden.historyVersion,
      navigation.historyVersion,
      "authorization scope changes must invalidate cached message history",
    );
    assert.equal(hidden.activityByProject["new-platform-project"], undefined);
    assert.deepEqual(hidden.runtime.deliveries, []);
    const desktopConnection = new LocalApplicationConnection(
      new Application(workspace, { runtime, platformWork: domains.work }),
    );
    const desktopBoot = (await desktopConnection.call(
      "platform.bootstrap",
    )) as {
      csrfToken: string;
    };
    const chrome = (await desktopConnection.call(
      "runtime.snapshot",
      undefined,
      {
        identityGeneration: desktopBoot.csrfToken,
      },
    )) as { messages: unknown[]; deliveries: unknown[]; connected: boolean };
    assert.deepEqual(chrome.messages, []);
    const desktopSelectedNavigation = (await desktopConnection.call(
      "runtime.navigation",
      {
        projectId: "new-platform-project",
        conversationId: "new-platform-project",
      },
      { identityGeneration: desktopBoot.csrfToken },
    )) as { historyVersion: string };
    assert.match(desktopSelectedNavigation.historyVersion, /^[a-f0-9]{64}$/);
    assert.deepEqual(chrome.deliveries, []);
    assert.equal(chrome.connected, true);
    assert.deepEqual(
      await desktopConnection.call("platform.message", command, {
        identityGeneration: desktopBoot.csrfToken,
      }),
      { commandId: command.commandId, entityId: command.commandId },
      "Desktop invoke uses the same Platform input and durable retry identity",
    );
    const desktopFrames: string[][] = [];
    const desktopStreamId = randomUUID();
    await desktopConnection.observe(
      desktopStreamId,
      {
        kind: "platform",
        projectId: "new-platform-project",
        conversationId: "new-platform-project",
      },
      desktopBoot.csrfToken,
      (value) => {
        assert.ok("messages" in value);
        desktopFrames.push(value.messages.map((message) => message.text));
      },
      () => {},
    );
    const desktopDeadline = Date.now() + 4000;
    while (
      !desktopFrames.at(-1)?.includes("回复 从新项目发送") &&
      Date.now() < desktopDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(desktopFrames.at(-1)?.includes("回复 从新项目发送"));
    desktopConnection.unobserve(desktopStreamId);
    desktopConnection.close();
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const appServer = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      runtime,
      platformWork: domains.work,
    });
    await new Promise<void>((resolve) =>
      appServer.listen(port, "127.0.0.1", resolve),
    );
    try {
      const client = new HttpApplicationClient(`http://127.0.0.1:${port}`);
      const boot = (await client.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      const remoteNavigation = (await client.call(
        "runtime.navigation",
        undefined,
        {
          identityGeneration: boot.csrfToken,
        },
      )) as {
        runtime: { messages: unknown[] };
        activityByProject: Record<string, string>;
        historyVersion: string;
      };
      assert.deepEqual(remoteNavigation.runtime.messages, []);
      assert.ok(remoteNavigation.activityByProject["new-platform-project"]);
      const selectedNavigation = (await client.call(
        "runtime.navigation",
        {
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        },
        { identityGeneration: boot.csrfToken },
      )) as { historyVersion: string };
      assert.match(selectedNavigation.historyVersion, /^[a-f0-9]{64}$/);
      assert.notEqual(
        selectedNavigation.historyVersion,
        remoteNavigation.historyVersion,
        "HTTP navigation includes the selected Runtime Session head",
      );
      const remote = (await client.call(
        "conversations.history",
        {
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        },
        { identityGeneration: boot.csrfToken },
      )) as typeof firstHistory;
      assert.deepEqual(remote.inputs, firstHistory.inputs);
      assert.deepEqual(remote.runtime.messages, firstHistory.runtime.messages);
      assert.deepEqual(
        await client.call("platform.message", command, {
          identityGeneration: boot.csrfToken,
        }),
        { commandId: command.commandId, entityId: command.commandId },
        "Web ingress retries the same Platform message without duplicating it",
      );
      await assert.rejects(
        client.call("input.send", randomUUID(), {
          identityGeneration: boot.csrfToken,
        }),
        /这条消息不属于当前用户/,
        "HTTP retry waits for authorization instead of serializing a Promise",
      );
      const streamController = new AbortController();
      const streamTimeout = setTimeout(() => streamController.abort(), 4000);
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/platform/projects/new-platform-project/conversations/new-platform-project/stream`,
          { signal: streamController.signal },
        );
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let frame = "";
        while (!frame.includes("\n\n")) {
          const part = await reader.read();
          assert.equal(part.done, false);
          frame += decoder.decode(part.value, { stream: true });
        }
        const firstFrame = JSON.parse(
          frame
            .split("\n\n", 1)[0]!
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
        ) as { messages: Array<{ text: string }> };
        assert.ok(
          firstFrame.messages.some(
            (message) => message.text === "回复 从新项目发送",
          ),
          "Web SSE publishes the authorized Platform reply",
        );
        await reader.cancel();
      } finally {
        clearTimeout(streamTimeout);
        streamController.abort();
      }
      const denied = await fetch(
        `http://127.0.0.1:${port}/api/platform/projects/other-platform-project/conversations/new-platform-project/stream`,
      );
      assert.equal(denied.status, 403);
    } finally {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }

    const spaces = await session().ensurePlatformSpaces();
    const sharedAInput = input(
      randomUUID(),
      "new-platform-project",
      "项目一共享对话",
    );
    const sharedA = {
      ...sharedAInput,
      operation: {
        ...sharedAInput.operation,
        conversationId: spaces.dialogueId,
      },
    };
    const sharedBInput = input(
      randomUUID(),
      "other-platform-project",
      "项目二共享对话",
    );
    const sharedB = {
      ...sharedBInput,
      operation: {
        ...sharedBInput.operation,
        conversationId: spaces.dialogueId,
      },
    };
    await session().platformMessage(sharedA);
    await session().platformMessage(sharedB);
    await runtime.tick();
    const sharedDispatchDeadline = Date.now() + 4000;
    while (sent.length < 3 && Date.now() < sharedDispatchDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 3);
    assert.equal(
      sentSessions.get(sharedA.commandId),
      sentSessions.get(sharedB.commandId),
      "one personal default conversation uses one Runtime Session",
    );
    const sharedReplyDeadline = Date.now() + 10000;
    while (Date.now() < sharedReplyDeadline) {
      await runtime.tick();
      const observed = await session().platformConversationHistory({
        projectId: "new-platform-project",
        conversationId: spaces.dialogueId,
      });
      if (
        observed.runtime.messages.length === 2 &&
        observed.runtime.activity?.threads.length === 2 &&
        observed.runtime.attention?.approvals.length === 2
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const sharedAHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: spaces.dialogueId,
    });
    const sharedBHistory = await session().platformConversationHistory({
      projectId: "other-platform-project",
      conversationId: spaces.dialogueId,
    });
    assert.deepEqual(
      sharedAHistory.inputs.map((item) => item.body).sort(),
      ["项目一共享对话", "项目二共享对话"].sort(),
    );
    assert.deepEqual(sharedBHistory.inputs, sharedAHistory.inputs);
    assert.deepEqual(
      sharedAHistory.runtime.messages.map((message) => message.text).sort(),
      ["回复 项目一共享对话", "回复 项目二共享对话"].sort(),
    );
    assert.deepEqual(
      sharedBHistory.runtime.messages,
      sharedAHistory.runtime.messages,
    );
    assert.deepEqual(
      sharedAHistory.runtime.activity?.threads
        .map((thread) => thread.inputId)
        .sort(),
      [sharedA.commandId, sharedB.commandId].sort(),
    );
    assert.deepEqual(
      sharedBHistory.runtime.activity?.threads,
      sharedAHistory.runtime.activity?.threads,
    );
    assert.deepEqual(
      sharedAHistory.runtime.attention?.approvals
        .map((approval) => approval.scope.inputId)
        .sort(),
      [sharedA.commandId, sharedB.commandId].sort(),
    );
    assert.deepEqual(
      sharedBHistory.runtime.attention?.approvals,
      sharedAHistory.runtime.attention?.approvals,
    );
    const sharedExecution = await session().executionSnapshot({
      projectId: "new-platform-project",
      conversationId: spaces.dialogueId,
      artifactId: null,
    });
    assert.deepEqual(
      sharedExecution.jobs.map((job) => job.id).sort(),
      [command.commandId, sharedA.commandId, sharedB.commandId]
        .map((id) => `job-${id}`)
        .sort(),
      "the shared conversation shows all authorized roots without filtering by the selected project",
    );
    assert.equal(
      sharedAHistory.runtime.messages.find(
        (message) => message.inputId === sharedB.commandId,
      )?.projectId,
      "other-platform-project",
      "the continuous history retains each message's originating work project",
    );
    const streamed: Array<Array<{ text: string; projectId: string }>> = [];
    stopPlatformStream = await session().observePlatformConversation(
      { projectId: "new-platform-project", conversationId: spaces.dialogueId },
      (value) =>
        streamed.push(
          value.messages.map((message) => ({
            text: message.text,
            projectId: message.projectId,
          })),
        ),
      () => {},
    );
    const deadline = Date.now() + 4000;
    while (
      !streamed.some((messages) =>
        messages.some((message) => message.text === "回复 项目二共享对话"),
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      streamed
        .at(-1)
        ?.some(
          (message) =>
            message.text === "回复 项目二共享对话" &&
            message.projectId === "other-platform-project",
        ),
      "the shared Session streams project-attributed replies",
    );
    const sharedSessionId = sentSessions.get(sharedB.commandId)!;
    const liveEvents = events.get(sharedSessionId)!;
    for (const [kind, text] of [
      ["started", ""],
      ["text_delta", "实时增量"],
    ] as const)
      liveEvents.push({
        id: `stream-${kind}-${sharedB.commandId}`,
        sequence: liveEvents.length + 1,
        timestamp: new Date().toISOString(),
        topic: "runtime/model_stream",
        payload: {
          session_id: sharedSessionId,
          root_turn_id: `root-${sharedB.commandId}`,
          attempt_id: `attempt-${sharedB.commandId}`,
          stream: { kind, text },
        },
      });
    const deltaDeadline = Date.now() + 4000;
    while (
      !streamed.at(-1)?.some((message) => message.text === "实时增量") &&
      Date.now() < deltaDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      streamed
        .at(-1)
        ?.some(
          (message) =>
            message.text === "实时增量" &&
            message.projectId === "other-platform-project",
        ),
      "live model text uses the persisted input root, not the visible project",
    );
    await assert.rejects(
      session().platformConversationHistory({
        projectId: "other-platform-project",
        conversationId: "new-platform-project",
      }),
      /对话不属于这个项目/,
    );

    stopPlatformStream?.();
    stopPlatformStream = undefined;
    await runtime.stop();
    await domains.unbindRuntime(binding.authority);
    runtime = new RuntimeBridge(workspace, config);
    binding = domains.bindRuntime(runtime, localFiles);
    await session().platformMessage(command);
    await runtime.tick();
    assert.equal(sent.length, 3, "reopening never resends an accepted input");
    assert.equal(
      (
        await session().platformConversationHistory({
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        })
      ).runtime.messages[0]?.text,
      "回复 从新项目发送",
      "authorized history remains readable after Host restart",
    );

    const blocked = input(randomUUID(), "other-platform-project", "不能再投递");
    await session().platformMessage(blocked);
    const database = new DatabaseSync(join(directory, "platform.sqlite"));
    try {
      database
        .prepare("UPDATE projects SET archived_at=? WHERE project_id=?")
        .run(new Date().toISOString(), "other-platform-project");
    } finally {
      database.close();
    }
    await runtime.tick();
    assert.equal(sent.length, 3, "archived project is rechecked at dispatch");
    const blockedDeadline = Date.now() + 4000;
    while (
      (
        await session().platformConversationHistory({
          projectId: "other-platform-project",
          conversationId: "other-platform-project",
        })
      ).runtime.deliveries[0]?.state !== "failed" &&
      Date.now() < blockedDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(
      (
        await session().platformConversationHistory({
          projectId: "other-platform-project",
          conversationId: spaces.dialogueId,
        })
      ).inputs
        .map((item) => item.body)
        .sort(),
      ["项目一共享对话", "项目二共享对话"].sort(),
      "archived project history remains readable to its current member",
    );
    assert.deepEqual(
      (
        await session().platformConversationHistory({
          projectId: "other-platform-project",
          conversationId: "other-platform-project",
        })
      ).runtime.deliveries.map((delivery) => delivery.state),
      ["failed"],
      "the blocked delivery is visible in its own archived conversation",
    );
    streamed.length = 0;
    stopPlatformStream = await session().observePlatformConversation(
      { projectId: "new-platform-project", conversationId: spaces.dialogueId },
      (value) =>
        streamed.push(
          value.messages.map((message) => ({
            text: message.text,
            projectId: message.projectId,
          })),
        ),
      () => {},
    );
    const beforeRevokeDeadline = Date.now() + 4000;
    while (
      !streamed
        .at(-1)
        ?.some((message) => message.text === "回复 项目二共享对话") &&
      Date.now() < beforeRevokeDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      streamed
        .at(-1)
        ?.some((message) => message.text === "回复 项目二共享对话"),
    );
    const revoked = new DatabaseSync(join(directory, "platform.sqlite"));
    try {
      revoked
        .prepare(
          "DELETE FROM project_members WHERE project_id=? AND principal_id=?",
        )
        .run("other-platform-project", localAccess.principalId);
    } finally {
      revoked.close();
    }
    const revokedReply = sharedBHistory.runtime.messages.find(
      (message) => message.inputId === sharedB.commandId,
    )!;
    const revokedQuoteInput = input(
      randomUUID(),
      "new-platform-project",
      "引用已撤销的项目",
    );
    await assert.rejects(
      session().platformMessage({
        ...revokedQuoteInput,
        operation: {
          ...revokedQuoteInput.operation,
          textQuotes: [
            {
              id: randomUUID(),
              text: revokedReply.text,
              comment: "",
              source: {
                kind: "message",
                projectId: revokedReply.projectId,
                conversationId: revokedReply.conversationId,
                messageId: revokedReply.id,
                inputId: revokedReply.inputId,
                title: "Morphz",
                createdAt: revokedReply.createdAt,
              },
            },
          ],
        },
      }),
      /无权|权限|项目/,
      "an exact prior quote is rejected after membership revocation",
    );
    const remainingHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: spaces.dialogueId,
    });
    const remoteRemainingHistory =
      await secondRuntime!.platformConversationHistory(
        {
          projectId: "new-platform-project",
          conversationId: spaces.dialogueId,
        },
        localAccess,
      );
    assert.deepEqual(remoteRemainingHistory.inputs, remainingHistory.inputs);
    assert.deepEqual(
      remoteRemainingHistory.runtime.messages,
      remainingHistory.runtime.messages,
      "revoked cross-project roots are hidden on a Host without the sender's outbox",
    );
    assert.deepEqual(
      remainingHistory.inputs.map((item) => item.body).sort(),
      ["项目一共享对话"].sort(),
      "revoking one project hides its messages without splitting the Session",
    );
    assert.deepEqual(
      remainingHistory.runtime.messages.map((message) => message.text).sort(),
      ["回复 项目一共享对话"].sort(),
    );
    const remainingExecution = await session().executionSnapshot({
      projectId: "new-platform-project",
      conversationId: spaces.dialogueId,
      artifactId: null,
    });
    assert.deepEqual(
      remainingExecution.jobs.map((job) => job.id).sort(),
      [command.commandId, sharedA.commandId].map((id) => `job-${id}`).sort(),
      "the execution inspector removes the revoked project's roots from a shared Session",
    );
    await assert.rejects(
      session().executionResult({
        scope: {
          projectId: "new-platform-project",
          conversationId: spaces.dialogueId,
          artifactId: null,
        },
        jobId: `job-${sharedB.commandId}`,
      }),
      /执行不属于/,
    );
    const revokedApproval = sharedExecution.approvals.find(
      (approval) =>
        approval.request.approval_id === `approval-${sharedB.commandId}`,
    )!;
    await assert.rejects(
      session().executionControl({
        scope: {
          projectId: "new-platform-project",
          conversationId: spaces.dialogueId,
          artifactId: null,
        },
        action: {
          type: "allow-once",
          approvalId: revokedApproval.request.approval_id,
          fingerprint: revokedApproval.fingerprint,
        },
      }),
      /审批已结束或内容已变化|执行不属于/,
    );
    assert.deepEqual(approvalDecisions, [`approval-${command.commandId}`]);
    const revokeDeadline = Date.now() + 4000;
    while (
      (!streamed
        .at(-1)
        ?.some((message) => message.text === "回复 项目一共享对话") ||
        streamed
          .at(-1)
          ?.some((message) => message.text === "回复 项目二共享对话")) &&
      Date.now() < revokeDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      streamed
        .at(-1)
        ?.some((message) => message.text === "回复 项目一共享对话") &&
        !streamed
          .at(-1)
          ?.some((message) => message.text === "回复 项目二共享对话"),
      "revocation removes only the revoked project's stream messages",
    );
    await assert.rejects(
      session().platformConversationHistory({
        projectId: "other-platform-project",
        conversationId: spaces.dialogueId,
      }),
      /无权访问这个项目/,
    );

    const firstNamed = input(
      randomUUID(),
      "new-platform-project",
      "命名对话的第一句话",
    );
    const named = {
      ...firstNamed,
      operation: {
        ...firstNamed.operation,
        conversationId: "named-conversation",
        newConversation: { title: "命名对话" },
      },
    };
    assert.deepEqual(await session().platformMessage(named), {
      commandId: named.commandId,
      entityId: named.commandId,
    });
    assert.deepEqual(
      await session().platformMessage(named),
      { commandId: named.commandId, entityId: named.commandId },
      "lost acknowledgements retry the same first input and conversation",
    );
    const namedDeadline = Date.now() + 4000;
    while (sent.length < 4 && Date.now() < namedDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 4);
    let namedHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "named-conversation",
    });
    while (
      !namedHistory.runtime.messages.length &&
      Date.now() < namedDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      namedHistory = await session().platformConversationHistory({
        projectId: "new-platform-project",
        conversationId: "named-conversation",
      });
    }
    assert.deepEqual(
      namedHistory.runtime.messages.map((message) => message.text),
      ["回复 命名对话的第一句话"],
    );
    assert.equal(
      (
        await session().listPlatformConversations({
          projectId: "new-platform-project",
        })
      ).find((item) => item.id === "named-conversation")?.title,
      "命名对话",
    );
    await assert.rejects(
      domains.work.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          domains.work.service.startConversation(actor, {
            commandId: named.commandId,
            projectId: "new-platform-project",
            conversationId: "named-conversation",
            title: "命名对话",
            inputFingerprint: "0".repeat(64),
          }),
      ),
      /操作标识已经用于另一项请求/,
      "the first-input receipt must bind the exact durable Runtime request",
    );
    await assert.rejects(
      session().platformMessage({
        ...named,
        commandId: randomUUID(),
      }),
      /对话标识已经被使用/,
    );
    assertNoLegacyWorkspace();

    const renameConversation = {
      commandId: randomUUID(),
      conversationId: "named-conversation",
      expectedRevision: 1,
      title: "改名后的对话",
    };
    assert.equal(
      await session().updatePlatformConversation(renameConversation),
      "named-conversation",
    );
    assert.equal(
      await session().updatePlatformConversation(renameConversation),
      "named-conversation",
      "同一命令重试不能再次递增修订",
    );
    assert.equal(
      (
        await session().listPlatformConversations({
          projectId: "new-platform-project",
        })
      ).find((item) => item.id === "named-conversation")?.revision,
      2,
    );
    await session().updatePlatformConversation({
      commandId: randomUUID(),
      conversationId: "named-conversation",
      expectedRevision: 2,
      archived: true,
    });
    assert.equal(
      (
        await session().listPlatformConversations({
          projectId: "new-platform-project",
          archived: true,
        })
      ).find((item) => item.id === "named-conversation")?.title,
      "改名后的对话",
    );
    assert.deepEqual(
      (
        await session().platformConversationHistory({
          projectId: "new-platform-project",
          conversationId: "named-conversation",
        })
      ).runtime.messages.map((message) => message.text),
      ["回复 命名对话的第一句话"],
      "归档只修改导航，不删除 Runtime 消息",
    );

    const heldId = randomUUID();
    await runtime.as(localAccess, () =>
      runtime.enqueuePlatformInput(
        {
          id: heldId,
          projectId: "new-platform-project",
          conversationId: "restart-first-conversation",
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: "重启后发送的首条消息",
          author: localAccess,
          targetActantId: "morphz-agent",
          status: "recorded",
          createdAt: new Date().toISOString(),
        },
        { title: "重启恢复对话" },
      ),
    );
    await runtime.tick();
    assert.equal(sent.length, 4, "a held first input cannot dispatch early");
    assert.equal(
      (
        await session().listPlatformConversations({
          projectId: "new-platform-project",
        })
      ).some((item) => item.id === "restart-first-conversation"),
      false,
      "no empty named conversation appears before the first input commits",
    );
    await domains.work.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains.work.service.startConversation(actor, {
          commandId: heldId,
          projectId: "new-platform-project",
          conversationId: "restart-first-conversation",
          title: "重启恢复对话",
          inputFingerprint: runtime.as(localAccess, () =>
            runtime.platformInputFingerprint(heldId),
          ),
        }),
    );
    stopPlatformStream?.();
    stopPlatformStream = undefined;
    await runtime.stop();
    await domains.unbindRuntime(binding.authority);
    runtime = new RuntimeBridge(workspace, config);
    binding = domains.bindRuntime(runtime, localFiles);
    await runtime.tick();
    const recoveredDeadline = Date.now() + 4000;
    while (sent.length < 5 && Date.now() < recoveredDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 5, "restart releases one committed first input");
    assert.deepEqual(
      (
        await session().platformConversationHistory({
          projectId: "new-platform-project",
          conversationId: "restart-first-conversation",
        })
      ).runtime.messages.map((message) => message.text),
      ["回复 重启后发送的首条消息"],
    );
    const originalReply = firstHistory.runtime.messages[0]!;
    const quote = {
      id: randomUUID(),
      source: {
        kind: "message" as const,
        projectId: originalReply.projectId,
        conversationId: originalReply.conversationId,
        messageId: originalReply.id,
        inputId: originalReply.inputId,
        title: "Morphz",
        createdAt: originalReply.createdAt,
      },
      text: originalReply.text,
      comment: "请解释这句",
    };
    const quoteCommand = input(
      randomUUID(),
      "new-platform-project",
      "继续讨论",
    );
    const quotedInput = {
      ...quoteCommand,
      operation: { ...quoteCommand.operation, textQuotes: [quote] },
    };
    const nanosQuote = {
      ...quote,
      id: randomUUID(),
      source: {
        ...quote.source,
        createdAt: quote.source.createdAt.replace("Z", "456Z"),
      },
    };
    const offsetQuote = {
      ...quote,
      id: randomUUID(),
      source: {
        ...quote.source,
        createdAt:
          new Date(Date.parse(quote.source.createdAt) + 8 * 3_600_000)
            .toISOString()
            .slice(0, 19) +
          quote.source.createdAt.slice(19, -1) +
          "+08:00",
      },
    };
    const cjkAttempt = `attempt-cjk-${command.commandId}`;
    const cjkSource =
      "好，提前一天就是 **10 月 23 日**。当天**上午 9 点（北京时间）**提醒你，可以吗？确认后我再设置定时提醒。";
    firstEvents.push(
      {
        id: `model_public_output_${cjkAttempt}`,
        sequence: firstEvents.length + 1,
        timestamp: quote.source.createdAt,
        topic: "runtime/model_public_output",
        payload: {
          root_turn_id: `root-${command.commandId}`,
          session_id: firstSessionId,
          attempt_id: cjkAttempt,
          first_visible_at: nanosQuote.source.createdAt,
          text: cjkSource,
          complete: true,
        },
      },
      {
        id: `reply-${cjkAttempt}`,
        sequence: firstEvents.length + 2,
        timestamp: quote.source.createdAt,
        topic: "chat/reply",
        payload: {
          root_turn_id: `root-${command.commandId}`,
          session_id: firstSessionId,
          attempt_id: cjkAttempt,
          text: cjkSource,
        },
      },
    );
    const cjkQuote = {
      ...quote,
      id: randomUUID(),
      source: { ...quote.source, messageId: `publication:${cjkAttempt}` },
      text: "好，提前一天就是 10 月 23 日。当天上午 9 点（北京时间）提醒你，可以吗？确认后我再设置定时提醒。",
    };
    const quotes = [quote, nanosQuote, offsetQuote, cjkQuote];
    quotedInput.operation.textQuotes = quotes;
    const fullHistory = t.mock.method(
      runtime,
      "platformConversationHistory",
      () => {
        throw new Error("引用校验不能构造整份对话历史");
      },
    );
    await assert.rejects(
      session().platformMessage({
        ...quotedInput,
        operation: {
          ...quotedInput.operation,
          textQuotes: [
            {
              ...quote,
              source: { ...quote.source, messageId: "not-a-real-message" },
            },
          ],
        },
      }),
      /引用的原消息已不可用/,
    );
    for (const alteredQuote of [
      { ...quote, source: { ...quote.source, inputId: randomUUID() } },
      {
        ...quote,
        source: {
          ...quote.source,
          createdAt: quote.source.createdAt.replace(
            /\.(\d{6})Z$/,
            (_, fraction: string) =>
              `.${String(Number(fraction) + 1).padStart(6, "0")}Z`,
          ),
        },
      },
      { ...cjkQuote, text: cjkQuote.text.replace("上午 9 点", "上午 8 点") },
    ])
      await assert.rejects(
        session().platformMessage({
          ...quotedInput,
          operation: { ...quotedInput.operation, textQuotes: [alteredQuote] },
        }),
        /引用的原消息已不可用/,
      );
    await assert.rejects(
      session().platformMessage({
        ...quotedInput,
        operation: {
          ...quotedInput.operation,
          textQuotes: [{ ...quote, text: "原消息没有说过这句话" }],
        },
      }),
      /引用的原消息已不可用/,
    );
    assert.deepEqual(await session().platformMessage(quotedInput), {
      commandId: quotedInput.commandId,
      entityId: quotedInput.commandId,
    });
    assert.equal(fullHistory.mock.callCount(), 0);
    fullHistory.mock.restore();
    await runtime.tick();
    const quoteDeadline = Date.now() + 4000;
    while (sent.length < 6 && Date.now() < quoteDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sent.length, 6);
    const quoteRequest = sent.at(-1)!.message as {
      content: { value: { text: string } };
    };
    const quoteMetadata = sent.at(-1)!.client_metadata as {
      source: { body: string; textQuotes: unknown[] };
    };
    assert.match(quoteRequest.content.value.text, /回复 从新项目发送/);
    assert.match(quoteRequest.content.value.text, /继续讨论/);
    assert.equal(quoteMetadata.source.body, "继续讨论");
    assert.deepEqual(quoteMetadata.source.textQuotes, quotes);
    const quoteHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    });
    assert.equal(
      quoteHistory.inputs.find((item) => item.id === quotedInput.commandId)
        ?.body,
      "继续讨论",
      "history displays the Human's words, not the expanded Runtime prompt",
    );
    assert.deepEqual(
      quoteHistory.inputs.find((item) => item.id === quotedInput.commandId)
        ?.textQuotes,
      quotes,
      "history retains the exact quoted source for later navigation",
    );
    const originalDirectory = join(directory, "original-files");
    mkdirSync(originalDirectory);
    writeFileSync(join(originalDirectory, "note.txt"), "原位文件内容");
    assert.deepEqual(
      await session().directoryScope({
        projectId: "new-platform-project",
        conversationId: "new-platform-project",
      }),
      { authorized: true },
      "directory choice checks the Platform conversation, not a legacy project",
    );
    const directoryGrant = localFiles.authorizeDirectory(
      originalDirectory,
      "new-platform-project",
      "new-platform-project",
      localAccess,
    );
    const localFile = localFiles.select(
      join(originalDirectory, "note.txt"),
      "new-platform-project",
      localAccess,
    );
    assert.deepEqual(
      await session().directories({
        projectId: "new-platform-project",
        conversationId: "new-platform-project",
      }),
      [directoryGrant],
    );
    assert.equal(
      (
        await session().localFiles({
          projectId: "new-platform-project",
          grantId: localFile.reference.grantId,
        })
      )?.reference.version,
      localFile.reference.version,
    );
    const localInput = input(
      randomUUID(),
      "new-platform-project",
      "请读取已授权的原位文件",
    );
    await session().platformMessage({
      ...localInput,
      operation: {
        ...localInput.operation,
        localFile: localFile.reference,
        directories: [directoryGrant],
      },
    });
    await runtime.tick();
    const localMessage = sent.find(
      (message) => message.client_message_id === localInput.commandId,
    )!;
    assert.equal(
      (localMessage.message as { format: { version: string } }).format.version,
      "3",
    );
    const localHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    });
    assert.deepEqual(
      localHistory.inputs.find((item) => item.id === localInput.commandId)
        ?.localFile,
      localFile.reference,
    );
    assert.deepEqual(
      localHistory.inputs.find((item) => item.id === localInput.commandId)
        ?.directories,
      [directoryGrant],
    );
    await assert.rejects(
      session().directoryScope({
        projectId: "new-platform-project",
        conversationId: "other-platform-project",
      }),
      /对话不属于|范围/,
    );
    const foreignLocalInput = input(
      randomUUID(),
      "other-platform-project",
      "请读取文件",
    );
    await assert.rejects(
      session().platformMessage({
        ...foreignLocalInput,
        operation: {
          ...foreignLocalInput.operation,
          localFile: localFile.reference,
        },
      }),
      /无权访问|未获授权/,
    );
    await session().directories(
      {
        projectId: "new-platform-project",
        conversationId: "new-platform-project",
        grantId: directoryGrant.grantId,
      },
      true,
    );
    const revokedDirectoryInput = input(
      randomUUID(),
      "new-platform-project",
      "再读取目录",
    );
    await assert.rejects(
      session().platformMessage({
        ...revokedDirectoryInput,
        operation: {
          ...revokedDirectoryInput.operation,
          directories: [directoryGrant],
        },
      }),
      /撤销|未获授权/,
    );
    assertNoLegacyWorkspace();
    const combinedEvents = events.get(sharedSessionId)!;
    for (const [inputId, threadId] of [
      [sharedA.commandId, "combined-thread-a"],
      [sharedB.commandId, "combined-thread-b"],
    ])
      combinedEvents.push({
        id: `result-${threadId}`,
        sequence: combinedEvents.length + 1,
        timestamp: "2030-01-01T00:00:00.000Z",
        topic: "runtime/thread_result",
        payload: { root_turn_id: `root-${inputId}`, thread_id: threadId },
      });
    await runtime.tick();
    await runtime.stop();
    await domains.unbindRuntime(binding.authority);
    runtime = new RuntimeBridge(workspace, config);
    binding = domains.bindRuntime(runtime, localFiles);
    combinedEvents.push({
      id: "combined-cross-project-reply",
      sequence: combinedEvents.length + 1,
      timestamp: "2030-01-01T00:00:01.000Z",
      topic: "chat/reply",
      payload: {
        text: "共享 Session 的合并回复",
        covers: ["combined-thread-a", "combined-thread-b"],
      },
    });
    await runtime.tick();
    const scopedActivity = runtime.platformNavigationSnapshot(localAccess, [
      "new-platform-project",
    ]);
    assert.equal(
      runtime.platformNavigationSnapshot(localAccess, ["new-platform-project"])
        .historyVersion,
      scopedActivity.historyVersion,
      "unchanged Runtime state keeps the history cache valid",
    );
    assert.ok(
      (scopedActivity.activityByProject["new-platform-project"] ?? "") <
        "2030-01-01T00:00:01.000Z",
      "ambiguous shared-Session replies cannot be attributed using only visible deliveries",
    );
    assert.equal(
      scopedActivity.activityByProject["other-platform-project"],
      undefined,
    );
    assert.deepEqual(
      runtime.platformNavigationSnapshot(localAccess, ["new-platform-project"])
        .activityByProject,
      scopedActivity.activityByProject,
      "unchanged navigation can reuse its event projection",
    );
    combinedEvents.push({
      id: "later-project-a-reply",
      sequence: combinedEvents.length + 1,
      timestamp: "2030-01-01T00:00:02.000Z",
      topic: "chat/reply",
      payload: {
        root_turn_id: `root-${sharedA.commandId}`,
        text: "只属于项目一的追加回复",
      },
    });
    await runtime.tick();
    assert.notEqual(
      runtime.platformNavigationSnapshot(localAccess, ["new-platform-project"])
        .historyVersion,
      scopedActivity.historyVersion,
      "new Runtime events invalidate cached message history",
    );
    assert.equal(
      runtime.platformNavigationSnapshot(localAccess, ["new-platform-project"])
        .activityByProject["new-platform-project"],
      "2030-01-01T00:00:02.000Z",
      "new Runtime events invalidate only the derived activity tail",
    );
    assert.equal(
      runtime.platformNavigationSnapshot(localAccess, [
        "other-platform-project",
      ]).activityByProject["new-platform-project"],
      undefined,
      "cached activity cannot bypass current Platform project grants",
    );
    const attachmentBytes = Buffer.from(
      "真实消息附件：不会写入 workspace BLOB。",
      "utf8",
    );
    const uploaded = await session().addAttachment({
      name: "说明.md",
      data: attachmentBytes,
    });
    assert.equal(uploaded.mime, "text/markdown");
    assert.deepEqual(
      Buffer.from((await session().asset(uploaded.assetId, true)).bytes),
      attachmentBytes,
    );
    const withAttachment = input(
      randomUUID(),
      "new-platform-project",
      "请读附件",
    );
    await session().platformMessage({
      ...withAttachment,
      operation: {
        ...withAttachment.operation,
        attachments: [{ ...uploaded, name: "说明.md" }],
      },
    });
    await runtime.tick();
    const delivered = sent.find(
      (item) => item.client_message_id === withAttachment.commandId,
    );
    assert.ok(
      delivered,
      "the same Platform message is delivered with its attachment",
    );
    const stageRef = (
      delivered.message as {
        content: { value: { attachments: Array<{ stage_id: string }> } };
      }
    ).content.value.attachments[0]!.stage_id;
    assert.deepEqual(stages.get(stageRef)?.bytes, attachmentBytes);
    const attachedHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    });
    assert.deepEqual(
      attachedHistory.inputs.find(
        (item) => item.id === withAttachment.commandId,
      )?.attachments,
      [{ ...uploaded, name: "说明.md" }],
    );
    const remoteAttachmentSource = {
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
      inputId: withAttachment.commandId,
    };
    assert.deepEqual(
      Buffer.from(
        (
          await new Application(secondWorkspace!, {
            runtime: secondRuntime!,
            platformWork: domains.work,
          })
            .session(localAccess)
            .asset(uploaded.assetId, true, remoteAttachmentSource)
        ).bytes,
      ),
      attachmentBytes,
      "a second Host previews an accepted attachment without the sender's Store",
    );
    const remoteApplication = new Application(secondWorkspace!, {
      runtime: secondRuntime!,
      platformWork: domains.work,
    });
    const attachmentQuery = new URLSearchParams(
      remoteAttachmentSource,
    ).toString();
    const remoteDesktop = new LocalApplicationConnection(remoteApplication);
    try {
      const resource = embeddedResources("/nonexistent", remoteDesktop);
      const preview = await resource(
        new Request(
          `morphz://app/api/attachments/${uploaded.assetId}?${attachmentQuery}`,
        ),
      );
      assert.equal(preview.status, 200);
      assert.deepEqual(
        Buffer.from(await preview.arrayBuffer()),
        attachmentBytes,
      );
      assert.equal(
        (
          await resource(
            new Request(
              `morphz://app/api/attachments/${uploaded.assetId}?projectId=new-platform-project`,
            ),
          )
        ).status,
        400,
      );
    } finally {
      remoteDesktop.close();
    }
    const attachmentProbe = createServer();
    await new Promise<void>((resolve) =>
      attachmentProbe.listen(0, "127.0.0.1", resolve),
    );
    const attachmentPort = (attachmentProbe.address() as { port: number }).port;
    await new Promise<void>((resolve) =>
      attachmentProbe.close(() => resolve()),
    );
    const attachmentServer = createAppServer(secondWorkspace!, {
      port: attachmentPort,
      webRoot: "/nonexistent",
      runtime: secondRuntime!,
      platformWork: domains.work,
    });
    await new Promise<void>((resolve) =>
      attachmentServer.listen(attachmentPort, "127.0.0.1", resolve),
    );
    try {
      const origin = `http://127.0.0.1:${attachmentPort}`;
      const preview = await fetch(
        `${origin}/api/attachments/${uploaded.assetId}?${attachmentQuery}`,
      );
      assert.equal(preview.status, 200);
      assert.deepEqual(
        Buffer.from(await preview.arrayBuffer()),
        attachmentBytes,
      );
      const malformed = await fetch(
        `${origin}/api/attachments/${uploaded.assetId}?projectId=new-platform-project`,
      );
      assert.equal(malformed.status, 400);
    } finally {
      await new Promise<void>((resolve) =>
        attachmentServer.close(() => resolve()),
      );
    }
    await assert.rejects(
      secondRuntime!.platformAcceptedAttachment(
        {
          projectId: "other-platform-project",
          conversationId: "other-platform-project",
        },
        localAccess,
        withAttachment.commandId,
        uploaded.assetId,
      ),
      /无权访问这个项目/,
      "a valid hash does not bypass current Platform membership",
    );
    assert.equal(
      await secondRuntime!.platformAcceptedAttachment(
        remoteAttachmentSource,
        localAccess,
        withAttachment.commandId,
        "0".repeat(64),
      ),
      null,
      "the exact accepted message must declare the requested asset",
    );
    const stage = stages.get(stageRef)!;
    const originalBytes = stage.bytes;
    stage.bytes = Buffer.from("altered Runtime attachment");
    try {
      await assert.rejects(
        secondRuntime!.platformAcceptedAttachment(
          remoteAttachmentSource,
          localAccess,
          withAttachment.commandId,
          uploaded.assetId,
        ),
        /摘要不匹配|大小或摘要不匹配/,
      );
    } finally {
      stage.bytes = originalBytes;
    }

    const productionId = "message-script-one";
    const itemId = "message-episode-one";
    const createdScript = await session().createPlatformScript({
      commandId: randomUUID(),
      productionId,
      projectId: "new-platform-project",
      title: "消息剧本",
    });
    const { sources: _legacySources, ...empty } = emptyScriptDraft("第一集");
    await session().createPlatformScriptItem({
      commandId: randomUUID(),
      contentId: createdScript.contentId,
      itemId,
      expectedActivityRevision: 1,
      kind: "episode",
      draft: { ...empty, text: "原稿。", sources: [] },
    });
    const scriptQuote = {
      id: randomUUID(),
      text: "原稿。",
      comment: "请继续这一幕",
      source: {
        kind: "script" as const,
        projectId: "new-platform-project",
        title: "消息剧本 · 第一集",
        productionId,
        entryId: itemId,
        revision: 1,
      },
    };
    const scriptQuoteInput = input(randomUUID(), "new-platform-project", "");
    await session().platformMessage({
      ...scriptQuoteInput,
      operation: {
        ...scriptQuoteInput.operation,
        textQuotes: [scriptQuote],
      },
    });
    await runtime.tick();
    assert.ok(
      sent.some(
        (message) => message.client_message_id === scriptQuoteInput.commandId,
      ),
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...scriptQuoteInput.operation,
          textQuotes: [{ ...scriptQuote, text: "伪造的剧本原文" }],
        },
      }),
      /引用文字不属于选定的剧本版本/,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...scriptQuoteInput.operation,
          textQuotes: [
            {
              ...scriptQuote,
              source: {
                ...scriptQuote.source,
                candidateId: "missing-candidate",
              },
            },
          ],
        },
      }),
      /候选稿不存在/,
    );
    const draftQuote = {
      ...scriptQuote,
      id: randomUUID(),
      draft: true,
      text: "尚未保存的修改",
      anchor: {
        start: 0,
        end: 7,
        prefix: "",
        suffix: "",
        field: "正文",
      },
    };
    await session().platformMessage({
      ...input(randomUUID(), "new-platform-project", ""),
      operation: {
        ...scriptQuoteInput.operation,
        textQuotes: [draftQuote],
      },
    });
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...scriptQuoteInput.operation,
          textQuotes: [
            {
              ...draftQuote,
              id: randomUUID(),
              anchor: { ...draftQuote.anchor, field: undefined },
            },
          ],
        },
      }),
      /引用文字不属于选定的剧本版本|Invalid input/,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...scriptQuoteInput.operation,
          textQuotes: [
            {
              ...scriptQuote,
              source: { ...scriptQuote.source, projectId: "unknown-project" },
            },
          ],
        },
      }),
      /项目|剧本归属/,
    );
    await session().updatePlatformScript({
      commandId: randomUUID(),
      contentId: createdScript.contentId,
      expectedRevision: 1,
      title: "消息剧本",
      brief: { ...emptyScriptBrief, modelProcessingAllowed: true },
      reviewerPrincipalIds: [localAccess.principalId],
      template: defaultScriptExportTemplate,
    });
    const generatedInput = input(
      randomUUID(),
      "new-platform-project",
      "请改写第一集",
    );
    const generation = {
      productionId,
      targetId: itemId,
      baseRevision: 1,
      contextRevision: 2,
      purpose: "rewrite" as const,
      references: [],
      maxCandidates: 1,
      maxOutputCharacters: 2000,
      maxReviewPasses: 1,
    };
    await session().platformMessage({
      ...generatedInput,
      operation: { ...generatedInput.operation, scriptGeneration: generation },
    });
    await domains.content.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        assert.deepEqual(
          (
            await domains.content.studio.readPreparation({
              credential: actor.credential,
              productionId,
              inputId: generatedInput.commandId,
            })
          )?.generation,
          generation,
        );
      },
    );
    await runtime.tick();
    assert.ok(
      sent.some(
        (message) => message.client_message_id === generatedInput.commandId,
      ),
    );
    const original = await session().createPlatformDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: "new-platform-project",
      title: "可引用文档",
      markdown: "这是 **重点段落**，可从消息里引用。",
    });
    const quoted = {
      id: randomUUID(),
      text: "这是 重点段落，可从消息里引用。",
      comment: "请解释",
      source: {
        kind: "artifact" as const,
        projectId: "new-platform-project",
        title: "可引用文档",
        artifactId: original.contentId,
        revision: 1,
      },
    };
    const quoteInput = input(randomUUID(), "new-platform-project", "");
    await session().platformMessage({
      ...quoteInput,
      operation: { ...quoteInput.operation, textQuotes: [quoted] },
    });
    await runtime.tick();
    assert.ok(
      sent.some(
        (message) => message.client_message_id === quoteInput.commandId,
      ),
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...quoteInput.operation,
          textQuotes: [{ ...quoted, text: "原文中不存在的句子" }],
        },
      }),
      /引用文字不属于选定的内容版本/,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...quoteInput.operation,
          textQuotes: [
            {
              ...quoted,
              source: { ...quoted.source, projectId: "unknown-project" },
            },
          ],
        },
      }),
      /项目|引用的内容/,
    );
    const sections = await session().readPlatformReaderContents({
      artifactId: original.contentId,
      revision: 1,
    });
    const section = await session().readPlatformReaderSection({
      artifactId: original.contentId,
      revision: 1,
      sectionId: sections[0]!.id,
    });
    const start = section.text.indexOf("重点段落");
    assert.ok(start >= 0);
    const contentMessage = input(
      randomUUID(),
      "new-platform-project",
      "讨论这份文档",
    );
    await session().platformMessage({
      ...contentMessage,
      operation: {
        ...contentMessage.operation,
        artifactId: original.contentId,
        artifactRevision: 1,
        selection: "重点段落",
      },
    });
    await runtime.tick();
    const contentRequest = sent.find(
      (message) => message.client_message_id === contentMessage.commandId,
    );
    assert.deepEqual(
      (contentRequest?.message as { content: { value: { object: unknown } } })
        .content.value.object,
      { artifact_id: original.contentId, revision: 1 },
    );
    const contentHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    });
    assert.equal(
      contentHistory.inputs.find((item) => item.id === contentMessage.commandId)
        ?.artifactId,
      original.contentId,
    );
    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    await session().createPlatformTask({
      commandId: randomUUID(),
      taskId,
      projectId: "new-platform-project",
      title: "核对原稿",
      description: "检查原稿的关键段落",
      assigneeId: localAccess.actantId,
    });
    const taskMessage = input(
      randomUUID(),
      "new-platform-project",
      "这件事项下一步怎么做？",
    );
    await session().platformMessage({
      ...taskMessage,
      operation: {
        ...taskMessage.operation,
        artifactId: taskId,
        artifactRevision: 1,
      },
    });
    await runtime.tick();
    assert.deepEqual(
      (
        sent.find(
          (message) => message.client_message_id === taskMessage.commandId,
        )?.message as { content: { value: { object: unknown } } }
      ).content.value.object,
      { artifact_id: taskId, revision: 1 },
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "other-platform-project", "跨项目内容"),
        operation: {
          ...contentMessage.operation,
          projectId: "other-platform-project",
        },
      }),
      /内容不属于本次对话|无权访问这个项目/,
    );
    const readingPosition = input(
      randomUUID(),
      "new-platform-project",
      "我在看这一节",
    );
    const currentReading = {
      book: section.book,
      chapter: section.title,
      location: {
        sourceId: section.sourceId,
        sectionId: section.id,
        start,
        end: start,
      },
    };
    await session().platformMessage({
      ...readingPosition,
      operation: {
        ...readingPosition.operation,
        artifactId: original.contentId,
        artifactRevision: 1,
        reading: currentReading,
      },
    });
    await runtime.tick();
    assert.equal(
      (
        sent.find(
          (message) => message.client_message_id === readingPosition.commandId,
        )?.message as { format: { version: string } }
      ).format.version,
      "9",
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", "伪造阅读位置"),
        operation: {
          ...readingPosition.operation,
          artifactId: original.contentId,
          artifactRevision: 1,
          reading: {
            ...currentReading,
            location: {
              ...currentReading.location,
              sourceId: "forged-source",
            },
          },
        },
      }),
      /阅读位置与原件版本不匹配/,
    );
    const selectedReading = input(
      randomUUID(),
      "new-platform-project",
      "这几个字是什么意思？",
    );
    const selectedReference = {
      ...currentReading,
      location: { ...currentReading.location, end: start + 4 },
      quote: section.text.slice(start, start + 4),
      before: section.text.slice(Math.max(0, start - 600), start),
      after: section.text.slice(start + 4, start + 304),
    };
    await session().platformMessage({
      ...selectedReading,
      operation: {
        ...selectedReading.operation,
        artifactId: original.contentId,
        artifactRevision: 1,
        selection: selectedReference.quote,
        reading: selectedReference,
      },
    });
    await runtime.tick();
    assert.equal(
      (
        sent.find(
          (message) => message.client_message_id === selectedReading.commandId,
        )?.message as { format: { version: string } }
      ).format.version,
      "8",
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", "伪造前文"),
        operation: {
          ...selectedReading.operation,
          artifactId: original.contentId,
          artifactRevision: 1,
          selection: selectedReference.quote,
          reading: { ...selectedReference, before: "不存在的前文" },
        },
      }),
      /阅读选文前文已变化/,
    );
    const readingQuote = {
      id: randomUUID(),
      text: "重点段落",
      comment: "联系前文",
      source: {
        kind: "reading" as const,
        artifactId: original.contentId,
        revision: 1,
        projectId: "new-platform-project",
        title: "可引用文档",
        chapter: section.title,
        location: {
          sourceId: section.sourceId,
          sectionId: section.id,
          start,
          end: start + 4,
        },
      },
    };
    const readingInput = input(randomUUID(), "new-platform-project", "");
    await session().platformMessage({
      ...readingInput,
      operation: { ...readingInput.operation, textQuotes: [readingQuote] },
    });
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...readingInput.operation,
          textQuotes: [{ ...readingQuote, text: "另一段不存在的文字" }],
        },
      }),
      /引用文字不属于选定的阅读位置/,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...readingInput.operation,
          textQuotes: [
            {
              ...readingQuote,
              source: {
                ...readingQuote.source,
                location: {
                  ...readingQuote.source.location,
                  sourceId: "forged-source",
                },
              },
            },
          ],
        },
      }),
      /引用文字不属于选定的阅读位置/,
    );
    const webQuote = {
      id: randomUUID(),
      text: "网页上选中的一句话",
      comment: "这里是什么意思？",
      source: {
        kind: "web" as const,
        projectId: "new-platform-project",
        title: "当前网页",
        url: "https://example.com/article",
        pageId: randomUUID(),
        epoch: randomUUID(),
      },
    };
    const webInput = input(randomUUID(), "new-platform-project", "");
    await session().platformMessage({
      ...webInput,
      operation: { ...webInput.operation, textQuotes: [webQuote] },
    });
    await runtime.tick();
    const webMessage = sent.find(
      (message) => message.client_message_id === webInput.commandId,
    )!;
    assert.match(
      (webMessage.message as { content: { value: { text: string } } }).content
        .value.text,
      /网页上选中的一句话/,
    );
    assert.match(
      (webMessage.message as { content: { value: { text: string } } }).content
        .value.text,
      /服务端未核验来源原文/,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...webInput.operation,
          textQuotes: [
            {
              ...webQuote,
              source: { ...webQuote.source, projectId: "unknown-project" },
            },
          ],
        },
      }),
      /项目|引用来源/,
    );
    const surfaceInput = input(randomUUID(), "new-platform-project", "");
    await session().platformMessage({
      ...surfaceInput,
      operation: {
        ...surfaceInput.operation,
        textQuotes: [
          {
            id: randomUUID(),
            text: "界面里的选中文字",
            comment: "请解释",
            source: {
              kind: "surface",
              projectId: "new-platform-project",
              title: "工作台",
            },
          },
        ],
      },
    });
    await runtime.tick();
    assert.ok(
      sent.some(
        (message) => message.client_message_id === surfaceInput.commandId,
      ),
      "Client selections can be discussed without a saved App original",
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", ""),
        operation: {
          ...surfaceInput.operation,
          textQuotes: [
            {
              id: randomUUID(),
              text: "另一个项目的界面文字",
              comment: "",
              source: {
                kind: "surface",
                projectId: "other-platform-project",
                title: "工作台",
              },
            },
          ],
        },
      }),
      /项目|引用来源/,
    );
    assertNoLegacyWorkspace();
    await runtime.stop();
    await domains.unbindRuntime(binding.authority);
    runtime = new RuntimeBridge(workspace, config);
    binding = domains.bindRuntime(runtime, localFiles);
    assert.deepEqual(
      (
        await session().platformConversationHistory({
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        })
      ).inputs.find((item) => item.id === withAttachment.commandId)
        ?.attachments,
      [{ ...uploaded, name: "说明.md" }],
      "attachment references survive Host restart",
    );
    await runtime.tick();
    assert.equal(
      sent.filter((item) => item.client_message_id === withAttachment.commandId)
        .length,
      1,
      "restart does not deliver the same attached input twice",
    );
    const probeInterrupted = input(
      randomUUID(),
      "new-platform-project",
      "能力查询暂时失败的原消息",
    );
    capabilityProbeStatus = 503;
    await session().platformMessage(probeInterrupted);
    await runtime.tick();
    const interruptedHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    });
    const interruptedDelivery = interruptedHistory.runtime.deliveries.find(
      (delivery) => delivery.inputId === probeInterrupted.commandId,
    );
    assert.equal(interruptedDelivery?.state, "queued");
    assert.equal(interruptedDelivery?.error, null);
    assert.match(interruptedHistory.runtime.error, /正在重试.*原消息已保留/);
    assert.equal(
      sent.filter(
        (item) => item.client_message_id === probeInterrupted.commandId,
      ).length,
      0,
      "a transient capabilities failure must not send or fail the original input",
    );
    await runtime.stop();
    await domains.unbindRuntime(binding.authority);
    runtime = new RuntimeBridge(workspace, config);
    binding = domains.bindRuntime(runtime, localFiles);
    capabilityProbeStatus = 200;
    await runtime.tick();
    assert.equal(
      sent.filter(
        (item) => item.client_message_id === probeInterrupted.commandId,
      ).length,
      1,
      "the queued input is sent exactly once when the probe recovers",
    );
    const needsNewRuntime = input(
      randomUUID(),
      "new-platform-project",
      "升级前保留的消息",
    );
    clientMetadataAvailable = false;
    await session().platformMessage(needsNewRuntime);
    await runtime.tick();
    const unsupportedHistory = await session().platformConversationHistory({
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    });
    assert.match(
      unsupportedHistory.runtime.deliveries.find(
        (delivery) => delivery.inputId === needsNewRuntime.commandId,
      )?.error ?? "",
      /服务版本过旧.*更新后可重试.*消息已保留/,
    );
    assert.equal(
      sent.filter(
        (item) => item.client_message_id === needsNewRuntime.commandId,
      ).length,
      0,
      "a Runtime without the metadata contract must not receive a partial request",
    );
    clientMetadataAvailable = true;
    assert.deepEqual(await session().sendInput(needsNewRuntime.commandId), {
      accepted: true,
    });
    await runtime.tick();
    assert.equal(
      sent.filter(
        (item) => item.client_message_id === needsNewRuntime.commandId,
      ).length,
      1,
    );
    const retryable = input(
      randomUUID(),
      "new-platform-project",
      "失败后发送原消息",
    );
    failNextMessageId = retryable.commandId;
    await session().platformMessage(retryable);
    await runtime.tick();
    const failedHistory = await session().platformConversationHistory({
      projectId: retryable.operation.projectId,
      conversationId: retryable.operation.projectId,
    });
    assert.equal(
      failedHistory.runtime.deliveries.find(
        (delivery) => delivery.inputId === retryable.commandId,
      )?.state,
      "failed",
    );
    assert.equal(
      sent.filter((item) => item.client_message_id === retryable.commandId)
        .length,
      0,
    );
    assert.deepEqual(await session().sendInput(retryable.commandId), {
      accepted: true,
    });
    await runtime.tick();
    assert.equal(
      sent.filter((item) => item.client_message_id === retryable.commandId)
        .length,
      1,
      "retry dispatches the same durable Runtime input, not a new message",
    );
    await assert.rejects(
      session().sendInput(retryable.commandId),
      /已发送或送达状态尚未确认/,
    );
    await assert.rejects(session().sendInput(randomUUID()), /不属于当前用户/);
    const scriptInput = input(
      randomUUID(),
      "new-platform-project",
      "继续处理当前剧本",
    );
    await session().platformMessage({
      ...scriptInput,
      operation: {
        ...scriptInput.operation,
        application: { id: "morphz.script-studio", version: "1.0.0" },
      },
    });
    await runtime.tick();
    const scriptRequest = sent.find(
      (item) => item.client_message_id === scriptInput.commandId,
    );
    assert.deepEqual(
      (scriptRequest?.activation as { harness?: unknown }).harness,
      scriptStudioApplication.harness,
      "the Host pins the installed app Harness instead of dropping Client app context",
    );
    assert.equal(
      (
        await session().platformConversationHistory({
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        })
      ).inputs.find((item) => item.id === scriptInput.commandId)?.application
        ?.id,
      "morphz.script-studio",
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", "错误应用版本"),
        operation: {
          ...scriptInput.operation,
          application: { id: "morphz.script-studio", version: "9.0.0" },
        },
      }),
      /应用版本不可用/,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", "旧窗口标识"),
        operation: {
          ...scriptInput.operation,
          application: undefined,
          applicationInstanceId: randomUUID(),
        },
      }),
      /应用类型/,
    );
    const browserInput = input(
      randomUUID(),
      "new-platform-project",
      "看看这一页",
    );
    const browserReference = {
      pageId: randomUUID(),
      epoch: randomUUID(),
      url: "https://example.com/current",
      title: "当前网页",
    };
    await session().platformMessage({
      ...browserInput,
      operation: { ...browserInput.operation, browser: browserReference },
    });
    await runtime.tick();
    assert.deepEqual(
      (
        sent.find((item) => item.client_message_id === browserInput.commandId)
          ?.message as { content: { value: { browser: unknown } } }
      ).content.value.browser,
      browserReference,
      "current-page metadata reaches Runtime as an untrusted reference, not a grant",
    );
    assert.deepEqual(
      (
        await session().platformConversationHistory({
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        })
      ).inputs.find((item) => item.id === browserInput.commandId)?.browser,
      browserReference,
    );
    const supplementTarget = {
      mode: "supplement" as const,
      inputId: scriptInput.commandId,
      threadId: `thread-${scriptInput.commandId}`,
      generation: 1,
    };
    const supplement = input(
      randomUUID(),
      "new-platform-project",
      "补充：保留上一版的结尾",
    );
    const supplementCommand = {
      ...supplement,
      operation: {
        ...supplement.operation,
        continuation: supplementTarget,
      },
    };
    assert.deepEqual(await session().platformMessage(supplementCommand), {
      commandId: supplement.commandId,
      entityId: supplement.commandId,
    });
    const supplementRequest = sent.find(
      (item) => item.client_message_id === supplement.commandId,
    );
    assert.deepEqual(
      (supplementRequest?.activation as { input_destination?: unknown })
        .input_destination,
      {
        kind: "thread",
        thread_id: supplementTarget.threadId,
        generation: 1,
      },
    );
    assert.equal(
      sentSessions.get(supplement.commandId),
      sentSessions.get(scriptInput.commandId),
      "supplement uses the original Runtime Session, not a new chat root",
    );
    assert.deepEqual(
      (
        await session().platformConversationHistory({
          projectId: "new-platform-project",
          conversationId: "new-platform-project",
        })
      ).inputs.find((item) => item.id === supplement.commandId)?.continuation,
      supplementTarget,
    );
    assert.deepEqual(await session().platformMessage(supplementCommand), {
      commandId: supplement.commandId,
      entityId: supplement.commandId,
    });
    assert.equal(
      sent.filter((item) => item.client_message_id === supplement.commandId)
        .length,
      1,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", "越界补充"),
        operation: {
          ...supplementCommand.operation,
          conversationId: spaces.dialogueId,
        },
      }),
      /补充目标不属于当前对话/,
    );
    await assert.rejects(
      session().platformMessage({
        ...input(randomUUID(), "new-platform-project", "过时代次"),
        operation: {
          ...supplementCommand.operation,
          continuation: { ...supplementTarget, generation: 2 },
        },
      }),
      /执行代次已变化/,
    );
    assertNoLegacyWorkspace();
    const selectedScope = {
      projectId: "new-platform-project",
      conversationId: "new-platform-project",
    };
    const beforeRemoteEvent =
      await session().platformRuntimeNavigation(selectedScope);
    const localVersion = runtime.platformNavigationSnapshot(localAccess, [
      "new-platform-project",
      "other-platform-project",
    ]).historyVersion;
    const remoteSessionId = sentSessions.get(command.commandId)!;
    const remoteEvents = events.get(remoteSessionId)!;
    remoteEvents.push({
      id: `remote-host-event-${randomUUID()}`,
      sequence: remoteEvents.at(-1)!.sequence + 1,
      timestamp: new Date().toISOString(),
      topic: "runtime/remote-host-marker",
      payload: { session_id: remoteSessionId },
    });
    assert.equal(
      runtime.platformNavigationSnapshot(localAccess, [
        "new-platform-project",
        "other-platform-project",
      ]).historyVersion,
      localVersion,
      "the receiving Host did not ingest another Host's event",
    );
    assert.notEqual(
      (await session().platformRuntimeNavigation(selectedScope)).historyVersion,
      beforeRemoteEvent.historyVersion,
      "the selected conversation invalidates its cache from Runtime's persistent head",
    );
  } finally {
    stopPlatformStream?.();
    await secondRuntime?.stop();
    await runtime.stop();
    await domains.unbindRuntime(binding.authority);
    await domains.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    workspace.close();
    secondWorkspace?.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(secondHostDirectory, { recursive: true, force: true });
  }
});
