import { createHash } from "node:crypto";
import { assertProjectWritable } from "../../core/src/projects.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { workInputRequest } from "./session-io.js";
import {
  continuationTarget,
  ContinuationConflict,
  SupplementUnconfirmed,
} from "./continuation.js";
import type { InputContinuation } from "../../core/src/continuation.js";
import {
  modelOptionSchema,
  reasoningEffortSchema,
  reasoningLevels,
  type ReasoningEffort,
  type ModelCatalog,
} from "../../../packages/core/src/inference.js";
import { publicSummary } from "../../../packages/core/src/understanding.js";
import {
  DomainError,
  discussionId,
  checkConversation,
  inConversation,
  type AccessContext,
} from "../../../packages/core/src/model.js";
import {
  checkProject,
  localAccess,
  getArtifact,
} from "../../../packages/core/src/model.js";
import { ExecutionControls, approvalFingerprint } from "./execution.js";
import { Collaboration } from "./collaboration.js";
import {
  approvalSchema,
  type ExecutionScope,
  type ExecutionAttention,
} from "../../../packages/core/src/execution.js";
import {
  type ConversationRuntime,
  deliverySchema,
  activitySchema,
} from "../../../packages/core/src/conversation.js";
import type { WorkspaceStore } from "./store.js";
import type { HostInvocation, ToolScope } from "./agent-tools.js";
import type { IdentityCenter } from "./identity.js";
import type { BrowserBroker } from "./browser.js";
import { ConversationFeed } from "./conversation-feed.js";
import type { ConversationStream } from "../../../packages/core/src/live-conversation.js";
import { inspectRuntimeConnection } from "./runtime-connection.js";
import { RuntimeModelSettings } from "./model-settings.js";
import { harnessReadinessError } from "../../core/src/applications.js";

const configSchema = z
  .object({
    url: z.url(),
    token: z.string().min(1),
    namespace: z.string().uuid(),
    identityMode: z.literal("trusted_gateway").optional(),
  })
  .strict();
export type RuntimeConfig = z.infer<typeof configSchema>;
export function loadRuntimeConfig(directory: string): RuntimeConfig | null {
  const filename = join(directory, "runtime.json");
  if (!existsSync(filename)) return null;
  const config = configSchema.parse(JSON.parse(readFileSync(filename, "utf8")));
  const url = new URL(config.url);
  // First adapter is explicitly local-only. Never silently send this token to another host.
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("本机 Runtime 地址必须是 loopback HTTP origin。");
  config.url = url.origin;
  return config;
}
const eventSchema = z.object({
  id: z.string(),
  sequence: z.number().int(),
  timestamp: z.string(),
  topic: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
type RuntimeEvent = z.infer<typeof eventSchema>;
/** A combined reply without a unique causal input must not be assigned by array order. */
export function attributedDelivery<
  T extends { sessionId: string; rootId: string | null },
>(
  sessionId: string,
  event: RuntimeEvent,
  deliveries: T[],
  events: RuntimeEvent[],
): T | undefined {
  const scoped = deliveries.filter(
    (d) => d.sessionId === sessionId && d.rootId,
  );
  for (const key of ["root_turn_id", "trigger_event_id", "source_turn_id"]) {
    const root = payloadString(event, key);
    const direct = root ? scoped.filter((d) => d.rootId === root) : [];
    if (direct.length) return direct.length === 1 ? direct[0] : undefined;
  }
  const covered = scoped.filter((d) => settles(event, d.rootId!, events));
  return covered.length === 1 ? covered[0] : undefined;
}
const sessionSchema = z.object({
  id: z.string(),
  context_id: z.string(),
});
const storedSchema = z.object({
  identityMode: z.literal("trusted_gateway").optional(),
  namespace: z.string(),
  endpoint: z.string(),
  connected: z.boolean(),
  directedInput: z.boolean().default(false),
  model: z.string(),
  error: z.string(),
  publications: z
    .record(z.string(), z.object({ id: z.string(), createdAt: z.string() }))
    .default({}),
  activity: activitySchema.optional(),
  threadBindings: z
    .record(z.string(), activitySchema.shape.threads.element)
    .default({}),
  sessions: z.record(
    z.string(),
    z.object({
      id: z.string(),
      projectId: z.string(),
      conversationId: z.string().optional(),
      artifactId: z.string().nullable(),
      cursor: z.number(),
      events: z.array(eventSchema),
      runtimePrincipalId: z.string().nullable().default(null),
      turnControl: z.boolean().default(false),
      schedules: z.boolean().default(false),
      hasWork: z.boolean().default(false),
      scope: z.enum(["object", "workspace"]).default("object"),
      sharedDefault: z.boolean().default(false),
    }),
  ),
  deliveries: z.array(
    deliverySchema.extend({
      sessionId: z.string(),
      rootId: z.string().nullable(),
      acceptedEventId: z.string().optional(),
      request: z.record(z.string(), z.unknown()),
      resourceUploads: z
        .array(
          z.object({
            stageId: z.string(),
            name: z.string(),
            mediaType: z.string(),
            dataBase64: z.string(),
            sha256: z.string(),
            ready: z.boolean(),
          }),
        )
        .optional(),
      cancelRequested: z.boolean().default(false),
    }),
  ),
});
class UpstreamError extends Error {
  constructor(
    public status: number,
    detail?: string,
  ) {
    super(
      status === 401 || status === 403
        ? "Morphz 登录凭据已失效，请重新连接。"
        : (detail ?? `Morphz 请求失败（HTTP ${status}），可重试发送。`),
    );
  }
}
const terminal = new Set([
  "session/io_state",
  "chat/reply",
  "chat/outbound_message",
  "chat/no_reply",
  "chat/cancelled",
  "chat/runtime_error",
  "runtime/response_protocol_fused",
]);
function payloadString(event: RuntimeEvent, key: string): string | undefined {
  const route = event.payload.route as Record<string, unknown> | undefined;
  const value = event.payload[key] ?? route?.[key];
  return typeof value === "string" ? value : undefined;
}
export function settles(
  event: RuntimeEvent,
  root: string,
  events: RuntimeEvent[],
): boolean {
  if (!terminal.has(event.topic)) return false;
  if (
    ["root_turn_id", "trigger_event_id", "source_turn_id"].some(
      (key) => payloadString(event, key) === root,
    )
  )
    return true;
  const covers = [event.payload.covers, event.payload.defer_covers].flatMap(
    (v) => (Array.isArray(v) ? v : []),
  );
  return events.some(
    (e) =>
      e.topic === "runtime/thread_result" &&
      payloadString(e, "root_turn_id") === root &&
      covers.includes(payloadString(e, "thread_id")),
  );
}
export class RuntimeBridge {
  private loadedHarnesses: { id: string; version: string }[] | null = null;
  private feeds = new Set<ConversationFeed>();
  private publish<
    T extends {
      id: string;
      createdAt: string;
      kind: string;
      publicationKey?: string;
    },
  >(message: T): T {
    if (
      !message.publicationKey ||
      message.kind === "tool" ||
      message.kind === "progress"
    )
      return message;
    const key = message.publicationKey;
    let saved = this.state.publications[key];
    if (!saved) {
      // Persist only presentation identity/time, not transient model content.
      saved = { id: `publication:${key}`, createdAt: message.createdAt };
      this.state.publications[key] = saved;
      this.save();
    }
    return { ...message, ...saved };
  }
  observeConversation(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    changed: (value: ConversationStream) => void,
    failed: () => void,
  ) {
    const authorize = () => {
      const workspace = this.store.snapshot();
      checkProject(workspace, scope.projectId, access);
      if (this.identity && !this.identity.allows(access))
        throw new Error("身份已失效");
      checkConversation(
        workspace,
        scope.projectId,
        scope.conversationId,
        access,
      );
    };
    authorize();
    const feed = new ConversationFeed({
      authorize,
      failed,
      changed: (value) => {
        // A synchronous publication batch has one fresh authorization snapshot.
        // Reading/parsing the whole workspace for every message stalls Desktop's
        // main process as history grows. Never retain this across async batches.
        const workspace = this.store.snapshot();
        const inputs = new Map(
          workspace.inputs.map((input) => [input.id, input]),
        );
        const projects = new Set(
          workspace.projects
            .filter((project) => project.members.includes(access.principalId))
            .map((project) => project.id),
        );
        const deliveries = new Map<string, typeof this.state.deliveries>();
        for (const delivery of this.state.deliveries) {
          const session = this.state.sessions[delivery.sessionId];
          if (
            delivery.rootId &&
            session &&
            inConversation(
              workspace,
              scope.conversationId,
              session,
              !this.teamIdentity,
            )
          ) {
            const matches = deliveries.get(delivery.rootId) ?? [];
            matches.push(delivery);
            deliveries.set(delivery.rootId, matches);
          }
        }
        changed({
          ...value,
          messages: value.messages
            .map((raw) => {
              const message = this.publish(raw);
              // The WS may beat the POST receipt. Reconcile by the captured root,
              // never by the currently selected conversation or newest input.
              const matches = message.rootId
                ? (deliveries.get(message.rootId) ?? [])
                : [];
              const input =
                matches.length === 1
                  ? inputs.get(matches[0]!.inputId)
                  : undefined;
              return input
                ? {
                    ...message,
                    inputId: input.id,
                    projectId: input.projectId,
                    conversationId: discussionId(input),
                    artifactId: input.artifactId,
                  }
                : message;
            })
            .filter((m) => projects.has(m.projectId)),
        });
      },
      url: this.config.url,
      sessions: () => {
        const workspace = this.store.snapshot();
        const projects = new Set(
          workspace.projects
            .filter((project) => project.members.includes(access.principalId))
            .map((project) => project.id),
        );
        return Object.values(this.state.sessions)
          .filter(
            (s) =>
              projects.has(s.projectId) &&
              inConversation(
                workspace,
                scope.conversationId,
                s,
                !this.teamIdentity,
              ),
          )
          .map((s) => s.id);
      },
      headers: () => ({
        Authorization: `Bearer ${this.config.token}`,
        ...(this.teamIdentity
          ? { "X-Morphz-Principal": this.principalId(access.principalId) }
          : {}),
      }),
      request: (path) => this.request(path, "GET", undefined, access),
      route: (id, event) => {
        const session = this.state.sessions[id]!;
        const delivery = attributedDelivery(
          id,
          { ...event, sequence: event.sequence ?? 0 },
          this.state.deliveries,
          session.events,
        );
        const input = this.store
          .snapshot()
          .inputs.find((i) => i.id === delivery?.inputId);
        return {
          projectId: input?.projectId ?? session.projectId,
          conversationId: input ? discussionId(input) : discussionId(session),
          artifactId: input?.artifactId ?? session.artifactId,
          inputId: delivery?.inputId ?? null,
          rootId:
            delivery?.rootId ??
            (typeof event.payload.root_turn_id === "string"
              ? event.payload.root_turn_id
              : null),
        };
      },
    });
    this.feeds.add(feed);
    return () => {
      this.feeds.delete(feed);
      feed.close();
    };
  }
  private browser?: BrowserBroker;
  attachBrowser(browser: BrowserBroker) {
    this.browser = browser;
  }
  private caller = new AsyncLocalStorage<AccessContext>();
  get teamIdentity() {
    return this.config.identityMode === "trusted_gateway";
  }
  as<T>(access: AccessContext, action: () => T): T {
    return this.caller.run(access, action);
  }
  private actor() {
    return (
      this.caller.getStore() ??
      (this.teamIdentity
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess)
    );
  }
  principalId(principalId: string) {
    return (
      "mw-" +
      createHash("sha256")
        .update(this.config.namespace + ":" + principalId)
        .digest("hex")
    );
  }
  private contextId(projectId: string) {
    return (
      `mw-context-${this.config.namespace}` +
      (this.teamIdentity
        ? "-" +
          createHash("sha256").update(projectId).digest("hex").slice(0, 24)
        : "")
    );
  }
  readonly executions: ExecutionControls;
  readonly modelSettings = new RuntimeModelSettings(() => this.config);
  readonly collaboration: Collaboration;
  private state: z.infer<typeof storedSchema>;
  // Ephemeral: approvals must be refreshed after restart, never restored as live.
  private attention: ExecutionAttention = { available: false, approvals: [] };
  private busy = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: WorkspaceStore,
    private config: RuntimeConfig,
    private identity?: IdentityCenter,
    persistOnConstruction = true,
  ) {
    if (this.teamIdentity && !identity)
      throw new Error("可信网关适配需要应用身份配置。");
    this.collaboration = new Collaboration(store, {
      session: async (projectId, artifactId) => {
        const workspace = this.store.snapshot();
        const original = workspace.artifacts.find(
          (a) => a.id === artifactId,
        )?.originConversationId;
        const conversation = workspace.conversations.find(
          (c) => c.id === original,
        );
        const owner = workspace.projects.find(
          (p) => p.id === conversation?.projectId,
        );
        const origin =
          conversation?.projectId === projectId || owner?.kind === "dialogue"
            ? original
            : undefined;
        const id = this.objectSession(
          projectId,
          artifactId,
          origin ?? projectId,
        );
        await this.ensureSession(id);
        if (!this.state.sessions[id]!.schedules)
          throw new Error("Runtime 未提供持久安排接口。");
        this.state.sessions[id]!.hasWork = true;
        this.save();
        return id;
      },
      request: (path, method, body) => this.request(path, method, body),
      enqueue: (id) => this.enqueue(id),
      approvalCount: (threadId, access) =>
        this.snapshot(access).attention?.approvals.filter(
          (a) => a.scope.threadId === threadId,
        ).length ?? 0,
      conversation: (id) =>
        this.state.sessions[id]
          ? discussionId(this.state.sessions[id]!)
          : undefined,
    });
    this.executions = new ExecutionControls(
      async (path, method, body) => {
        try {
          return await this.request(path, method, body);
        } catch (error) {
          if (error instanceof UpstreamError)
            throw new DomainError(
              error.status === 409 || error.status === 404
                ? "conflict"
                : "invalid",
              error.status === 409 || error.status === 404
                ? "执行状态已变化，或 Runtime 不支持此操作。请刷新后查看。"
                : "Runtime 未确认操作，请核对最新状态，不要重复批准。",
            );
          throw error;
        }
      },
      (scope) => this.executionBinding(scope),
    );
    const saved = store.runtimeState();
    this.state = saved
      ? storedSchema.parse(saved)
      : {
          namespace: config.namespace,
          endpoint: config.url,
          ...(config.identityMode ? { identityMode: config.identityMode } : {}),
          connected: false,
          directedInput: false,
          model: "",
          error: "",
          publications: {},
          threadBindings: {},
          sessions: {},
          deliveries: [],
        };
    if (
      this.state.namespace !== config.namespace ||
      this.state.endpoint !== config.url ||
      this.state.identityMode !== config.identityMode
    )
      throw new Error(
        "Runtime 连接与已保存的对话不匹配，请勿覆盖已有连接配置。",
      );
    this.state.connected = false;
    for (const delivery of this.state.deliveries)
      if (delivery.state === "sending") delivery.state = "queued";
    if (persistOnConstruction) this.save();
  }
  private save() {
    this.store.saveRuntimeState(this.state);
  }
  get supportsDirectedInput() {
    return this.state.connected && this.state.directedInput;
  }
  private executionBinding(scope: ExecutionScope) {
    const workspace = this.store.snapshot();
    checkProject(workspace, scope.projectId, this.actor());
    if (scope.conversationId)
      checkConversation(
        workspace,
        scope.projectId,
        scope.conversationId,
        this.actor(),
      );
    if (
      scope.artifactId &&
      getArtifact(workspace, scope.artifactId).projectId !== scope.projectId
    )
      throw new DomainError("forbidden", "对象不属于这个项目。");
    if (scope.threadId) {
      const thread = this.state.threadBindings[scope.threadId];
      if (
        !thread ||
        thread.projectId !== scope.projectId ||
        (scope.conversationId && thread.conversationId !== scope.conversationId)
      )
        throw new DomainError("not_found", "执行分支已变化，请刷新后查看。");
      if (scope.inputId && thread.inputId !== scope.inputId)
        throw new DomainError("forbidden", "分支不属于选中的输入。");
      return {
        sessionId: thread.sessionId,
        contextId: this.contextId(thread.projectId),
        rootId: thread.rootId,
        threadId: thread.id,
      };
    }
    if (scope.inputId) {
      const input = workspace.inputs.find(
        (i) =>
          i.id === scope.inputId &&
          i.projectId === scope.projectId &&
          (!scope.conversationId || discussionId(i) === scope.conversationId),
      );
      if (!input) throw new DomainError("forbidden", "执行不属于这条输入。");
      const delivery = this.state.deliveries.find(
        (d) => d.inputId === input.id,
      );
      if (!delivery?.rootId) return null;
      return {
        sessionId: delivery.sessionId,
        contextId: this.contextId(scope.projectId),
        rootId: delivery.rootId,
      };
    }
    const sessions = Object.values(this.state.sessions).filter(
      (s) =>
        workspace.projects.some(
          (p) =>
            p.id === s.projectId &&
            p.members.includes(this.actor().principalId),
        ) &&
        inConversation(workspace, discussionId(scope), s, !this.teamIdentity),
    );
    const session =
      sessions.find((s) => s.scope === "workspace") ??
      sessions.find((s) => s.artifactId === scope.artifactId) ??
      sessions[0];
    return session
      ? {
          sessionId: session.id,
          contextId: this.contextId(scope.projectId),
          legacySessionIds: sessions
            .filter((s) => s.id !== session.id)
            .map((s) => s.id),
          rootsBySession: Object.fromEntries(
            sessions
              .filter((s) => s.sharedDefault)
              .map((s) => [
                s.id,
                this.state.deliveries
                  .filter(
                    (d) =>
                      d.sessionId === s.id &&
                      d.rootId &&
                      workspace.inputs.some(
                        (i) =>
                          i.id === d.inputId &&
                          workspace.projects.some(
                            (p) =>
                              p.id === i.projectId &&
                              p.members.includes(this.actor().principalId),
                          ),
                      ),
                  )
                  .map((d) => d.rootId!),
              ]),
          ),
        }
      : null;
  }
  toolScope(route: HostInvocation): ToolScope | Promise<ToolScope> {
    const session = this.state.sessions[route.session_id];
    if (
      !session ||
      route.context_id !== this.contextId(session.projectId) ||
      !session.runtimePrincipalId ||
      (!this.teamIdentity && route.principal_id !== session.runtimePrincipalId)
    )
      throw new DomainError(
        "forbidden",
        "工具调用未绑定到已授权的 Morphz 会话。",
      );
    if (
      this.teamIdentity &&
      !this.store
        .snapshot()
        .projects.find((p) => p.id === session.projectId)
        ?.members.some((p) => this.principalId(p) === route.principal_id)
    )
      throw new DomainError("forbidden", "调用者已不属于当前项目。");
    if (
      this.teamIdentity &&
      route.principal_id !== this.principalId("morphz-service") &&
      !this.store.snapshot().actants.some(
        (a) =>
          a.kind === "human" &&
          this.principalId(a.principalId) === route.principal_id &&
          this.identity!.allows({
            principalId: a.principalId,
            actantId: a.id,
          }),
      )
    )
      throw new DomainError("forbidden", "调用身份已撤销。");
    if (session.sharedDefault) return this.sharedToolScope(route);
    // Older named/scheduled routes retain their project-scoped authority when
    // no input binding exists. Never guess a delivery association for them.
    return this.sharedToolScope(route).catch(() => ({
      projectId: session.projectId,
      conversationId: discussionId(session),
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    }));
  }
  private async sharedToolScope(route: HostInvocation): Promise<ToolScope> {
    const detail = z
      .object({
        snapshot: z.object({
          thread: z.object({
            id: z.literal(route.thread_id),
            session_id: z.literal(route.session_id),
            context_id: z.literal(route.context_id),
            root_turn_id: z.string(),
            initiating_principal_id: z.literal(route.principal_id),
          }),
        }),
      })
      .parse(
        await this.request(
          `/api/contexts/${encodeURIComponent(route.context_id)}/threads/${encodeURIComponent(route.thread_id)}`,
        ),
      );
    const root = detail.snapshot.thread.root_turn_id;
    let delivery = this.state.deliveries.find(
      (d) => d.sessionId === route.session_id && d.rootId === root,
    );
    // A tool can arrive before the message POST receipt. Only the Runtime-owned
    // input event can join that root to our immutable client_message_id.
    if (!delivery) {
      let cursor = 0;
      for (let page = 0; page < 10 && !delivery; page++) {
        const data = z
          .object({ events: z.array(eventSchema) })
          .parse(
            await this.request(
              `/api/sessions/${encodeURIComponent(route.session_id)}/events?after_sequence=${cursor}&limit=1000`,
            ),
          );
        const event = data.events.find(
          (e) =>
            e.id === root &&
            payloadString(e, "session_id") === route.session_id,
        );
        const clientId = event && payloadString(event, "client_message_id");
        delivery = clientId
          ? this.state.deliveries.find(
              (d) =>
                d.sessionId === route.session_id &&
                d.inputId === clientId &&
                d.request.client_message_id === clientId &&
                (!d.rootId || d.rootId === root),
            )
          : undefined;
        if (delivery) {
          delivery.rootId = root;
          this.save();
        }
        if (data.events.length < 1000) break;
        const next = Math.max(cursor, ...data.events.map((e) => e.sequence));
        if (next === cursor) break;
        cursor = next;
      }
    }
    const input = this.store
      .snapshot()
      .inputs.find((i) => i.id === delivery?.inputId);
    if (!input)
      throw new DomainError(
        "forbidden",
        "执行尚未绑定到原始输入，未操作任何对象。",
      );
    checkConversation(
      this.store.snapshot(),
      input.projectId,
      discussionId(input),
      input.author,
    );
    return {
      projectId: input.projectId,
      conversationId: discussionId(input),
      inputId: input.id,
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    };
  }
  async publicUnderstanding(
    route: HostInvocation,
    scope: ToolScope,
    revision: number,
  ) {
    await this.toolScope(route);
    const frameId = `mw-public-${scope.projectId}`;
    const view = z
      .object({
        context_id: z.literal(route.context_id),
        active_session_id: z.literal(route.session_id),
        state: z.object({
          frames: z.array(
            z.object({
              id: z.string(),
              body: z.string(),
              revision: z.number().int(),
              updated_version: z.number().int(),
            }),
          ),
          retired: z.array(z.string()),
          retiring: z.record(z.string(), z.unknown()).default({}),
        }),
      })
      .parse(
        await this.request(
          `/api/sessions/${route.session_id}/context/projection`,
        ),
      );
    const frame = view.state.frames.find((f) => f.id === frameId);
    if (
      !frame ||
      frame.revision !== revision ||
      view.state.retired.includes(frameId) ||
      view.state.retiring[frameId]
    )
      throw new DomainError(
        "conflict",
        "公开认知帧尚未提交、已变化或已退役。请先完成上下文事务，再发布当前版本。",
      );
    if (frame.body.length > 30000)
      throw new DomainError("invalid", "公开摘要超过长度限制。");
    let body: string;
    try {
      body = publicSummary(frame.body);
    } catch {
      throw new DomainError(
        "invalid",
        '公开认知帧需包含 (public-summary "面向用户的 Markdown 摘要")，不能发布内部结构或推理。',
      );
    }
    return {
      body,
      frameId,
      frameRevision: frame.revision,
      mindVersion: frame.updated_version,
    };
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    access = this.actor(),
    binary?: { bytes: Buffer; offset: number },
  ): Promise<unknown> {
    if (
      this.teamIdentity &&
      access.principalId !== "morphz-service" &&
      !this.identity!.allows(access)
    )
      throw new DomainError("forbidden", "Runtime 调用身份已撤销。");
    const id = /^\/api\/sessions\/([^/?]+)/.exec(path)?.[1],
      session = id ? this.state.sessions[id] : undefined;
    if (session) checkProject(this.store.snapshot(), session.projectId, access);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      "Content-Type": binary ? "application/octet-stream" : "application/json",
      ...(binary ? { "X-Morphz-Upload-Offset": String(binary.offset) } : {}),
      ...(this.teamIdentity
        ? { "X-Morphz-Principal": this.principalId(access.principalId) }
        : {}),
    };
    // Only the center can assert this mapping. A browser never supplies a Runtime identity.
    // Claiming is idempotent and rechecked on every request, including after revocation.
    if (
      this.teamIdentity &&
      session?.runtimePrincipalId &&
      access.principalId !== "morphz-service"
    ) {
      const claim = await fetch(
        `${this.config.url}/api/sessions/${id}/principal`,
        {
          method: "POST",
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!claim.ok) throw new UpstreamError(claim.status);
    }
    const response = await fetch(this.config.url + path, {
      method,
      headers,
      body: binary
        ? new Uint8Array(binary.bytes)
        : body === undefined
          ? undefined
          : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) {
      if (path.endsWith("/io/messages")) {
        const error = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        const code = error?.error?.code;
        if (code === "unsupported_activation_mode")
          throw new UpstreamError(
            response.status,
            "当前 Runtime 不支持这种输入方式；补充未送达，草稿已保留。请更新 Runtime 后重试。",
          );
        if (
          response.status === 404 ||
          code === "unsupported_io_version" ||
          code === "unsupported_format"
        )
          throw new UpstreamError(
            response.status,
            "当前 Morphz Runtime 尚未启用结构化工作消息，或未安装 Work 格式。请更新并启用 session-io；原输入已保留，不会转成提示词重发。",
          );
        if (
          code === "projection_budget_exceeded" ||
          code === "message_limit_exceeded"
        )
          throw new UpstreamError(
            response.status,
            "输入超过当前 Runtime 的结构化消息预算。原输入已保留；请将大段资料保存为对象后引用。",
          );
      }
      throw new UpstreamError(response.status);
    }
    return response.json();
  }
  async models(includeSources = true) {
    const raw = z
      .object({
        model: z.string().optional(),
        models: z.array(z.string()).optional(),
        model_options: z.array(modelOptionSchema).optional(),
        reasoning_effort: reasoningEffortSchema.nullable().optional(),
      })
      .passthrough()
      .parse(await this.request("/api/runtime/inference"));
    const catalog: ModelCatalog = {
      current: raw.model ?? this.state.model,
      options:
        raw.model_options ??
        (raw.models ?? []).map((id) => ({ id, label: id })),
      reasoning: {
        current: raw.reasoning_effort ?? null,
        levels: reasoningEffortSchema.options,
      },
    };
    // Provider configuration is optional metadata. Only names cross this boundary;
    // never forward keys, endpoints, headers or credential references to the UI.
    if (includeSources) {
      try {
        const providers = z
          .object({
            provider_instances: z.record(
              z.string(),
              z.object({ accounts: z.array(z.string()).default([]) }),
            ),
            auth_accounts: z.record(
              z.string(),
              z.object({
                config: z.object({ label: z.string().nullable().optional() }),
                effective_enabled: z.boolean(),
                oauth: z.boolean(),
                authenticated: z.boolean(),
              }),
            ),
            model_routes: z.record(
              z.string(),
              z.object({
                candidates: z.array(
                  z.object({
                    provider: z.string(),
                    account: z.string().nullable().optional(),
                  }),
                ),
              }),
            ),
          })
          .parse(await this.request("/api/runtime/providers"));
        catalog.options = catalog.options.map((option) => {
          const names = new Set<string>();
          for (const candidate of providers.model_routes[option.id]
            ?.candidates ?? []) {
            const accounts = candidate.account
              ? [candidate.account]
              : (providers.provider_instances[candidate.provider]?.accounts ??
                []);
            for (const id of accounts) {
              const account = providers.auth_accounts[id];
              if (
                account?.effective_enabled &&
                (!account.oauth || account.authenticated)
              )
                names.add(account.config.label?.trim() || candidate.provider);
            }
          }
          return names.size ? { ...option, sources: [...names] } : option;
        });
      } catch {
        /* Older or restricted Runtime: keep the authoritative model catalog. */
      }
    }
    return catalog;
  }
  inspectConnection(signal?: AbortSignal) {
    return inspectRuntimeConnection(
      this.config,
      signal,
      this.teamIdentity ? this.principalId("morphz-service") : undefined,
    );
  }
  validateConnection(config: RuntimeConfig) {
    if (
      config.url !== this.config.url ||
      config.namespace !== this.config.namespace ||
      config.identityMode !== this.config.identityMode
    )
      throw new DomainError(
        "conflict",
        "连接与原会话不匹配，原连接没有被替换。",
      );
  }
  updateConnection(config: RuntimeConfig) {
    this.validateConnection(config);
    // Keep the bridge, feeds, Sessions and durable delivery identities intact.
    this.config = config;
  }
  async validateModel(model: string) {
    return this.validateInference(model);
  }
  async validateInference(model?: string, effort?: ReasoningEffort) {
    const catalog = await this.models(false);
    if (model && !catalog.options.some((option) => option.id === model))
      throw new DomainError(
        "invalid",
        "所选模型当前不可用，请重新选择；草稿已保留。",
      );
    if (effort && !reasoningLevels(catalog, model ?? "").includes(effort))
      throw new DomainError(
        "invalid",
        "所选模型不支持此推理强度，请重新选择；草稿已保留。",
      );
  }
  snapshot(access?: AccessContext): ConversationRuntime {
    const workspace = this.store.snapshot();
    const inputs = workspace.inputs;
    const projects = access
      ? new Set(
          workspace.projects
            .filter((p) => p.members.includes(access.principalId))
            .map((p) => p.id),
        )
      : null;
    return {
      attention: {
        available: this.state.connected && this.attention.available,
        approvals: this.attention.approvals.filter(
          (a) => !projects || projects.has(a.scope.projectId),
        ),
      },
      ...(this.state.activity
        ? {
            activity: {
              ...this.state.activity,
              threads: this.state.activity.threads
                .filter((t) => !projects || projects.has(t.projectId))
                .map((t) => {
                  const owner = inputs.find((i) => i.id === t.inputId)?.author;
                  return !access ||
                    (owner?.principalId === access.principalId &&
                      owner.actantId === access.actantId)
                    ? t
                    : { ...t, continuation: undefined };
                }),
            },
          }
        : {}),
      configured: true,
      connected: this.state.connected,
      harnesses: this.state.connected ? this.loadedHarnesses : null,
      model: this.state.model,
      error: this.state.error,
      deliveries: this.state.deliveries
        .filter(
          (d) =>
            !projects ||
            projects.has(
              inputs.find((i) => i.id === d.inputId)?.projectId ??
                this.state.sessions[d.sessionId]?.projectId ??
                "",
            ),
        )
        .map(
          ({
            inputId,
            state,
            error,
            rootId,
            sessionId,
            cancelRequested,
            supplement,
            rejection,
          }) => ({
            inputId,
            state,
            error,
            ...(supplement ? { supplement } : {}),
            ...(rejection ? { rejection } : {}),
            retryable: state === "failed" && !rootId && !rejection,
            cancelRequested,
            cancellable:
              !supplement &&
              !cancelRequested &&
              (state === "queued" ||
                (state === "running" &&
                  !!this.state.sessions[sessionId]?.turnControl)),
          }),
        ),
      messages: Object.values(this.state.sessions)
        .filter((s) => !projects || projects.has(s.projectId))
        .flatMap((session) =>
          session.events.flatMap((event) => {
            const delivery = attributedDelivery(
              session.id,
              event,
              this.state.deliveries,
              session.events,
            );
            const input = inputs.find((i) => i.id === delivery?.inputId);
            const kind = ["chat/reply", "chat/outbound_message"].includes(
              event.topic,
            )
              ? "reply"
              : event.topic === "chat/progress"
                ? "progress"
                : [
                      "chat/runtime_error",
                      "session/io_state",
                      "runtime/response_protocol_fused",
                    ].includes(event.topic)
                  ? "error"
                  : null;
            const text =
              payloadString(event, "text") ??
              payloadString(event, "error") ??
              payloadString(event, "message");
            return kind && text
              ? [
                  this.publish({
                    id: event.id,
                    sequence: event.sequence,
                    projectId: input?.projectId ?? session.projectId,
                    conversationId: input
                      ? discussionId(input)
                      : discussionId(session),
                    artifactId: input?.artifactId ?? session.artifactId,
                    inputId: input?.id ?? null,
                    rootId: delivery?.rootId ?? null,
                    text,
                    createdAt: event.timestamp,
                    kind: kind as "reply" | "progress" | "error",
                    ...(payloadString(event, "attempt_id")
                      ? { publicationKey: payloadString(event, "attempt_id") }
                      : {}),
                  }),
                ]
              : [];
          }),
        )
        .filter((m) => !projects || projects.has(m.projectId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }
  private async refreshActivity() {
    const activity: z.infer<typeof activitySchema> = {
      available: true,
      truncated: false,
      threads: [],
    };
    const sessions = Object.values(this.state.sessions),
      workspace = this.store.snapshot();
    try {
      for (const contextId of new Set(
        sessions.map((s) => this.contextId(s.projectId)),
      )) {
        const view = z
          .object({
            threads: z.array(
              z.object({
                intent: z.string().nullable().optional(),
                phase: z.string(),
                thread: z
                  .object({
                    id: z.string(),
                    kind: z.string().optional(),
                    session_id: z.string(),
                    context_id: z.string(),
                    root_turn_id: z.string(),
                    lifecycle: z.string(),
                    revision: z.number(),
                    updated_at: z.string(),
                  })
                  .passthrough(),
              }),
            ),
          })
          .parse(
            await this.request(
              `/api/contexts/${encodeURIComponent(contextId)}/scheduler?include_terminal=false&limit=200`,
            ),
          );
        activity.truncated ||= view.threads.length >= 200;
        for (const value of view.threads) {
          const t = value.thread,
            session = sessions.find((s) => s.id === t.session_id);
          if (
            !session ||
            t.context_id !== contextId ||
            (t.lifecycle !== "open" && value.phase === "idle")
          )
            continue;
          const delivery = this.state.deliveries.find(
            (d) => d.sessionId === t.session_id && d.rootId === t.root_turn_id,
          );
          const input = workspace.inputs.find(
            (i) => i.id === delivery?.inputId,
          );
          // A shared transport is not authority to guess an unknown work project.
          if (session.sharedDefault && !input) {
            activity.truncated = true;
            continue;
          }
          activity.threads.push({
            id: t.id,
            kind: t.kind,
            projectId: input?.projectId ?? session.projectId,
            conversationId: input ? discussionId(input) : discussionId(session),
            inputId: input?.id ?? null,
            rootId: t.root_turn_id,
            sessionId: t.session_id,
            title:
              (t.kind === "dialogue_turn" ? "主执行" : value.intent?.trim()) ||
              input?.body ||
              "后台执行",
            phase: value.phase,
            lifecycle: t.lifecycle,
            revision: t.revision,
            updatedAt: t.updated_at,
            ...(input && this.state.directedInput
              ? { continuation: continuationTarget(t, input.id, t.id) }
              : {}),
          });
        }
      }
      this.state.activity = activity;
      for (const thread of activity.threads)
        this.state.threadBindings[thread.id] = thread;
    } catch {
      // Keep the last known records but explicitly mark them stale. A scheduler
      // read failure must not cause message redelivery or fictitious completion.
      this.state.activity = {
        ...(this.state.activity ?? activity),
        available: false,
      };
    }
  }
  private async refreshAttention() {
    try {
      const data = z
        .object({ approvals: z.array(approvalSchema) })
        .parse(await this.request("/api/approvals"));
      const workspace = this.store.snapshot();
      const approvals: ExecutionAttention["approvals"] = [];
      for (const approval of data.approvals) {
        const request = approval.request;
        const session = this.state.sessions[request.session_id];
        if (
          !session ||
          request.context_id !== this.contextId(session.projectId)
        )
          continue;
        const thread = request.thread_id
          ? this.state.threadBindings[request.thread_id]
          : undefined;
        if (
          thread &&
          (thread.sessionId !== session.id ||
            (request.root_turn_id && thread.rootId !== request.root_turn_id))
        )
          continue;
        const root = request.root_turn_id ?? thread?.rootId;
        const delivery = root
          ? this.state.deliveries.find(
              (d) => d.sessionId === session.id && d.rootId === root,
            )
          : undefined;
        const input = workspace.inputs.find((i) => i.id === delivery?.inputId);
        // Shared default Sessions span work projects. Never infer ownership from
        // the selected page or transport session when the receipt is missing.
        if (session.sharedDefault && !input) continue;
        const projectId = input?.projectId ?? session.projectId;
        approvals.push({
          scope: {
            projectId,
            conversationId: input ? discussionId(input) : discussionId(session),
            artifactId: input?.artifactId ?? session.artifactId,
            ...(input ? { inputId: input.id } : {}),
            ...(thread ? { threadId: thread.id } : {}),
          },
          approval: { ...approval, fingerprint: approvalFingerprint(approval) },
        });
      }
      this.attention = { available: true, approvals };
    } catch {
      this.attention = { ...this.attention, available: false };
    }
  }
  private objectSession(
    projectId: string,
    _artifactId: string | null,
    conversationId = projectId,
    sharedDefault = false,
  ) {
    // The conversation owns the transport; each delivery retains its work project.
    if (sharedDefault) projectId = conversationId;
    // Reuse the original project-level route when possible. Object routes remain
    // in the ledger and are still polled; no in-flight delivery is rewritten.
    const key = createHash("sha256")
      .update(
        JSON.stringify(
          sharedDefault
            ? ["shared-default", conversationId]
            : conversationId === projectId
              ? [projectId, null]
              : [projectId, null, conversationId],
        ),
      )
      .digest("hex")
      .slice(0, 24);
    const sessionId = `mw-${this.config.namespace.slice(0, 8)}-${key}`;
    this.state.sessions[sessionId] ??= {
      id: sessionId,
      projectId,
      conversationId,
      artifactId: null,
      scope: "workspace",
      sharedDefault,
      cursor: 0,
      events: [],
      runtimePrincipalId: null,
      turnControl: false,
      schedules: false,
      hasWork: false,
    };
    this.state.sessions[sessionId]!.scope = "workspace";
    if (sharedDefault) this.state.sessions[sessionId]!.sharedDefault = true;
    return sessionId;
  }
  async validateContinuation(target: InputContinuation) {
    const workspace = this.store.snapshot(),
      input = workspace.inputs.find((i) => i.id === target.inputId),
      actor = this.actor();
    if (
      !input ||
      input.continuation?.mode === "supplement" ||
      input.author.principalId !== actor.principalId ||
      input.author.actantId !== actor.actantId
    )
      throw new DomainError("forbidden", "不能补充其他身份的执行。");
    assertProjectWritable(checkProject(workspace, input.projectId, actor));
    if (
      checkConversation(workspace, input.projectId, discussionId(input), actor)
        .archivedAt
    )
      throw new DomainError("conflict", "此对话已归档，请先恢复；草稿已保留。");
    const delivery = this.state.deliveries.find(
      (d) => d.inputId === input.id && d.rootId && !d.supplement,
    );
    if (!delivery)
      throw new DomainError(
        "conflict",
        "原工作尚未绑定到实际执行，未发送补充。",
      );
    // A follow-up is an explicit new request. It need not revive a closed generation.
    if (target.mode === "follow-up") return;
    if (!this.supportsDirectedInput)
      throw new DomainError(
        "invalid",
        "当前 Runtime 尚未支持定向补充；草稿已保留，请更新连接后重试。",
      );
    let detail: unknown;
    try {
      detail = await this.request(
        `/api/contexts/${this.contextId(input.projectId)}/threads/${target.threadId}`,
      );
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404)
        throw new ContinuationConflict("closed");
      throw e;
    }
    const thread = z
      .object({
        snapshot: z.object({
          thread: z
            .object({
              id: z.string(),
              session_id: z.string(),
              context_id: z.string(),
              root_turn_id: z.string(),
              initiating_principal_id: z.string().nullable(),
            })
            .passthrough(),
        }),
      })
      .parse(detail).snapshot.thread;
    const expectedPrincipal = this.teamIdentity
      ? this.principalId(actor.principalId)
      : this.state.sessions[delivery.sessionId]?.runtimePrincipalId;
    if (
      thread.id !== target.threadId ||
      thread.session_id !== delivery.sessionId ||
      thread.context_id !== this.contextId(input.projectId) ||
      thread.root_turn_id !== delivery.rootId ||
      !expectedPrincipal ||
      thread.initiating_principal_id !== expectedPrincipal
    )
      throw new DomainError("forbidden", "补充目标不属于原请求，未发送。");
    const current = continuationTarget(thread, input.id, thread.id);
    if (!current) throw new ContinuationConflict("closed");
    if (
      current.generation !== target.generation ||
      current.objective?.id !== target.objective?.id ||
      current.objective?.generation !== target.objective?.generation
    )
      throw new ContinuationConflict("changed");
  }
  async confirmSupplement(inputId: string) {
    const initial = this.state.deliveries.find((d) => d.inputId === inputId);
    if (!initial?.supplement) return;
    const deadline = Date.now() + 12000;
    if (initial.state === "queued") void this.tick();
    while (Date.now() < deadline) {
      const delivery = this.state.deliveries.find((d) => d.inputId === inputId);
      if (!delivery?.supplement) return;
      if (delivery.acceptedEventId) return;
      if (delivery.rejection === "closed" || delivery.rejection === "changed")
        throw new ContinuationConflict(delivery.rejection);
      if (delivery.rejection === "forbidden")
        throw new DomainError("forbidden", "原工作不再允许补充，草稿已保留。");
      if (delivery.rejection === "invalid")
        throw new DomainError(
          "invalid",
          delivery.error || "补充未送达，请检查输入；草稿已保留。",
        );
      if (delivery.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new SupplementUnconfirmed();
  }
  enqueue(inputId: string) {
    const workspace = this.store.snapshot();
    const input = workspace.inputs.find((item) => item.id === inputId);
    if (!input) throw new DomainError("invalid", "输入不存在。");
    assertProjectWritable(
      checkProject(workspace, input.projectId, this.actor()),
    );
    const conversation = checkConversation(
      workspace,
      input.projectId,
      discussionId(input),
      this.actor(),
    );
    if (
      input.continuation &&
      (input.author.principalId !== this.actor().principalId ||
        input.author.actantId !== this.actor().actantId)
    )
      throw new DomainError("forbidden", "不能代替其他人投递补充。");
    const previous = this.state.deliveries.find(
      (item) => item.inputId === inputId,
    );
    if (previous) {
      // Never create a new client_message_id when the acceptance is unknown.
      if (
        previous.state === "failed" &&
        !previous.rootId &&
        !previous.acceptedEventId &&
        !previous.rejection
      ) {
        previous.state = "queued";
        previous.error = null;
        this.save();
      }
      return;
    }
    const originalDelivery =
      input.continuation?.mode === "supplement"
        ? this.state.deliveries.find(
            (d) =>
              d.inputId === input.continuation!.inputId &&
              d.rootId &&
              !d.supplement,
          )
        : undefined;
    if (
      input.continuation &&
      (input.author.principalId !== this.actor().principalId ||
        input.author.actantId !== this.actor().actantId)
    )
      throw new DomainError("forbidden", "不能代替其他人投递补充。");
    if (input.continuation?.mode === "supplement" && !originalDelivery)
      throw new DomainError(
        "conflict",
        "原工作尚未绑定到实际执行，未发送补充。",
      );
    const sessionId =
      originalDelivery?.sessionId ??
      this.objectSession(
        input.projectId,
        input.artifactId,
        discussionId(input),
        !this.teamIdentity &&
          workspace.projects.some(
            (p) =>
              p.id === conversation.projectId &&
              p.kind === "dialogue" &&
              p.id === conversation.id,
          ),
      );
    const artifact = workspace.artifacts.find(
      (item) => item.id === input.artifactId,
    );
    const version = artifact?.versions.find(
      (item) => item.revision === input.artifactRevision,
    );
    if (input.artifactId && !version)
      throw new DomainError("invalid", "关联的对象版本不存在，未发送。");
    const attachments: {
      name: string;
      media_type: string;
      data_base64: string;
    }[] = [];
    if (version) {
      const content = version.content;
      if (content.kind === "image") {
        const asset = this.store.asset(content.assetId);
        if (!asset) throw new DomainError("invalid", "图片已不可用，未发送。");
        attachments.push({
          name: version.title,
          media_type: asset.mime,
          data_base64: Buffer.from(asset.bytes).toString("base64"),
        });
      }
    }
    const typed = workInputRequest(
      // Attachments are immutable uploaded resources, not library artifacts.
      input,
      input.model ||
        (version?.content.kind === "task" ? version.content.model : null),
      input.continuation
        ? workspace.inputs.find((i) => i.id === input.continuation!.inputId)
        : undefined,
    );
    for (const attachment of input.attachments ?? []) {
      const asset = this.store.asset(attachment.assetId);
      if (!asset)
        throw new DomainError("invalid", "附件已不可用，输入已保留。");
      attachments.push({
        name: attachment.name,
        media_type: asset.mime,
        data_base64: Buffer.from(asset.bytes).toString("base64"),
      });
    }
    const resourceUploads = attachments.map((attachment, index) => ({
      stageId: `work-${createHash("sha256").update(`${input.id}:${index}`).digest("hex")}`,
      name: attachment.name,
      mediaType: attachment.media_type,
      dataBase64: attachment.data_base64,
      sha256: createHash("sha256")
        .update(Buffer.from(attachment.data_base64, "base64"))
        .digest("hex"),
      ready: false,
    }));
    const request = resourceUploads.length
      ? {
          ...typed,
          message: {
            ...typed.message,
            content: {
              ...typed.message.content,
              value: {
                ...typed.message.content.value,
                attachments: resourceUploads.map((upload) => ({
                  stage_id: upload.stageId,
                })),
              },
            },
          },
        }
      : typed;
    this.state.deliveries.push({
      inputId,
      sessionId,
      rootId: null,
      state: "queued",
      error: null,
      retryable: false,
      cancelRequested: false,
      ...(input.continuation?.mode === "supplement"
        ? { supplement: "pending" as const }
        : {}),
      // Bytes remain in the private outbox, never in a domain JSON message.
      // Existing saved deliveries are not regenerated during this upgrade.
      request,
      ...(resourceUploads.length ? { resourceUploads } : {}),
    });
    this.save();
  }
  private async ensureSession(id: string) {
    const contextId = this.contextId(this.state.sessions[id]!.projectId);
    let session: z.infer<typeof sessionSchema>;
    try {
      session = sessionSchema.parse(await this.request(`/api/sessions/${id}`));
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 404)
        throw error;
      try {
        try {
          session = sessionSchema.parse(
            await this.request("/api/sessions", "POST", {
              id,
              title: "Morphz",
              mount: { type: "existing_context", context_id: contextId },
            }),
          );
        } catch (missing) {
          if (!(missing instanceof UpstreamError) || missing.status !== 404)
            throw missing;
          session = sessionSchema.parse(
            await this.request("/api/sessions", "POST", {
              id,
              title: "Morphz",
              mount: {
                type: "new_blank_context",
                context_id: contextId,
                context_title: "Morphz",
              },
            }),
          );
        }
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 409)
          session = sessionSchema.parse(
            await this.request(`/api/sessions/${id}`),
          );
        else throw e;
      }
    }
    if (session.context_id !== contextId)
      throw new Error("会话绑定不匹配，已停止发送。");
    const binding = this.state.sessions[id]!;
    try {
      const identity = z
        .object({
          principal_id: z.string().min(1),
          session_id: z.literal(id),
          context_id: z.literal(contextId),
          capabilities: z.array(z.string()).default([]),
        })
        .parse(await this.request(`/api/sessions/${id}/principal`));
      if (
        binding.runtimePrincipalId &&
        binding.runtimePrincipalId !== identity.principal_id
      )
        throw new Error("Runtime 会话身份发生变化，已停止发送。");
      binding.runtimePrincipalId = identity.principal_id;
      if (
        this.teamIdentity &&
        identity.principal_id !== this.principalId("morphz-service")
      )
        throw new Error("Runtime 未提供可信网关身份，停止发送。");
      binding.turnControl = identity.capabilities.includes(
        "session_turn_control",
      );
      binding.schedules = identity.capabilities.includes("session_schedules");
    } catch (error) {
      // An older Runtime may chat normally, but cannot obtain Work tool authority.
      if (
        !(error instanceof UpstreamError) ||
        ![404, 405].includes(error.status)
      )
        throw error;
      binding.runtimePrincipalId = null;
      binding.turnControl = false;
    }
    this.save();
    // Do not inherit the running server's full-access preset into this new client.
    await this.request(`/api/sessions/${id}`, "PATCH", {
      permission_mode: "request_approval",
      sandbox_mode: "workspace-write",
    });
  }
  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 1200);
    this.timer.unref();
  }
  cancelInput(inputId: string) {
    const workspace = this.store.snapshot(),
      input = workspace.inputs.find((i) => i.id === inputId);
    if (!input) throw new DomainError("not_found", "输入不存在。");
    checkProject(workspace, input.projectId, this.actor());
    const delivery = this.state.deliveries.find((d) => d.inputId === inputId);
    if (
      !delivery ||
      ["completed", "failed", "cancelled"].includes(delivery.state)
    )
      throw new DomainError("conflict", "这条输入没有正在进行的处理。");
    if (delivery.state === "queued") {
      delivery.state = "cancelled";
      delivery.error = null;
      this.save();
      return;
    }
    if (delivery.state === "sending" || !delivery.rootId)
      throw new DomainError(
        "conflict",
        "发送回执尚未确认，暂时不能确认停止。请待状态更新后再试。",
      );
    if (!this.state.sessions[delivery.sessionId]?.turnControl)
      throw new DomainError(
        "invalid",
        "当前 Runtime 尚不支持按输入停止，请升级后使用。",
      );
    delivery.cancelRequested = true;
    delivery.error = null;
    this.save();
    void this.tick();
  }
  private async processCancellations() {
    for (const delivery of this.state.deliveries) {
      if (
        !delivery.cancelRequested ||
        delivery.state !== "running" ||
        !delivery.rootId
      )
        continue;
      const viewSchema = z.object({
        thread_id: z.string(),
        session_id: z.literal(delivery.sessionId),
        root_turn_id: z.literal(delivery.rootId),
        revision: z.number().int().positive(),
        lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
      });
      const path = `/api/sessions/${encodeURIComponent(delivery.sessionId)}/turns/${encodeURIComponent(delivery.rootId)}/thread`;
      try {
        let view = viewSchema.parse(await this.request(path));
        if (view.lifecycle === "open")
          view = viewSchema.parse(
            await this.request(path, "POST", {
              expected_revision: view.revision,
            }),
          );
        if (view.lifecycle !== "open") {
          delivery.state = view.lifecycle;
          delivery.cancelRequested = false;
          delivery.error =
            view.lifecycle === "cancelled"
              ? null
              : "停止确认前，这次处理已经结束。已发生的操作不会撤销。";
        }
      } catch {
        delivery.error = "停止尚未被 Runtime 确认，正在核对同一次处理的状态。";
      }
      this.save();
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const feed of this.feeds) feed.close();
    this.feeds.clear();
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  async tick() {
    return this.as(
      this.teamIdentity
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess,
      () => this.tickAsService(),
    );
  }
  private async tickAsService() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const status = this.teamIdentity
        ? (await this.request("/api/sessions"), { model: "Runtime 默认模型" })
        : z
            .object({ model: z.string() })
            .passthrough()
            .parse(await this.request("/api/status"));
      this.state.connected = true;
      this.state.model = status.model;
      this.state.error = "";
      try {
        const io = z
          .object({
            enabled: z.boolean(),
            directed_input: z.boolean().default(false),
            harnesses: z
              .array(z.object({ id: z.string(), version: z.string() }))
              .optional(),
            formats: z
              .array(
                z.object({
                  definition: z.object({ id: z.string(), version: z.string() }),
                }),
              )
              .default([]),
          })
          .parse(await this.request("/api/session-io/capabilities"));
        this.loadedHarnesses = io.enabled ? (io.harnesses ?? null) : null;
        this.state.directedInput =
          io.enabled &&
          io.directed_input &&
          io.formats.some(
            (f) =>
              f.definition.id === "morphz.application.input" &&
              f.definition.version === "4",
          );
      } catch {
        this.state.directedInput = false;
        this.loadedHarnesses = null;
      }
      for (const delivery of this.state.deliveries.filter(
        (item) => item.state === "queued",
      )) {
        if (this.stopped) break;
        if (delivery.state !== "queued") continue;
        delivery.state = "sending";
        this.save();
        try {
          const activation = delivery.request.activation as
            { harness?: { id: string; version: string } } | undefined;
          if (activation?.harness) {
            const issue = harnessReadinessError(
              activation.harness,
              this.loadedHarnesses,
            );
            if (issue) throw new UpstreamError(422, issue);
          }
          await this.ensureSession(delivery.sessionId);
          // Establish observers before the model can emit its first text chunk.
          await Promise.all([...this.feeds].map((feed) => feed.sync()));
          const input = this.store
            .snapshot()
            .inputs.find((i) => i.id === delivery.inputId);
          if (!input) throw new Error("原始输入不可用。");
          if (delivery.resourceUploads?.some((upload) => !upload.ready)) {
            const capabilities = z
              .object({ enabled: z.boolean(), resources: z.boolean() })
              .parse(await this.request("/api/session-io/capabilities"));
            if (!capabilities.enabled || !capabilities.resources)
              throw new UpstreamError(
                422,
                "当前 Runtime 不支持结构化消息的附件。原输入和图片已保留，请更新 Runtime 后重试。",
              );
            for (const upload of delivery.resourceUploads) {
              if (upload.ready) continue;
              const access = this.teamIdentity ? input.author : this.actor();
              const bytes = Buffer.from(upload.dataBase64, "base64");
              const stagePath = `/api/sessions/${delivery.sessionId}/attachment-stages`;
              let stage = z
                .object({
                  offset: z.number().int().nonnegative(),
                  status: z.string(),
                  sha256: z.string().nullable().optional(),
                })
                .parse(
                  await this.request(
                    stagePath,
                    "POST",
                    {
                      stage_id: upload.stageId,
                      client_message_id: delivery.inputId,
                      name: upload.name,
                      media_type: upload.mediaType,
                      size_bytes: bytes.length,
                      expected_sha256: upload.sha256,
                    },
                    access,
                  ),
                );
              while (stage.status === "uploading") {
                if (stage.offset >= bytes.length)
                  throw new Error("附件暂存状态无效，未发送。");
                const offset = stage.offset;
                stage = z
                  .object({
                    offset: z.number().int().nonnegative(),
                    status: z.string(),
                    sha256: z.string().nullable().optional(),
                  })
                  .parse(
                    await this.request(
                      `${stagePath}/${upload.stageId}/content`,
                      "PUT",
                      undefined,
                      access,
                      {
                        bytes: bytes.subarray(offset, offset + 1024 * 1024),
                        offset,
                      },
                    ),
                  );
                if (stage.offset <= offset)
                  throw new Error("附件上传没有推进，未发送。");
              }
              if (
                !["ready", "consumed"].includes(stage.status) ||
                stage.sha256 !== upload.sha256
              )
                throw new Error("附件完整性尚未确认，未发送。");
              upload.ready = true;
              this.save();
            }
          }
          const receipt = z
            .object({ accepted: z.literal(true), event_id: z.string() })
            .parse(
              await this.request(
                `/api/sessions/${delivery.sessionId}/${delivery.request.io_version === "1" ? "io/messages" : "messages"}`,
                "POST",
                delivery.request,
                this.teamIdentity ? input.author : undefined,
              ),
            );
          if (input.continuation?.mode === "supplement") {
            // This receipt identifies the steering event, NOT a new execution root.
            delivery.acceptedEventId = receipt.event_id;
            delivery.supplement = "delivered";
            delivery.state = "completed";
          } else {
            delivery.rootId = receipt.event_id;
            delivery.state = "running";
          }
          delivery.error = null;
        } catch (error) {
          delivery.state = "failed";
          if (delivery.supplement) {
            delivery.supplement =
              error instanceof UpstreamError &&
              [400, 403, 404, 409, 422].includes(error.status)
                ? "rejected"
                : "unknown";
            if (
              error instanceof UpstreamError &&
              [400, 403, 404, 409, 422].includes(error.status)
            ) {
              delivery.rejection =
                error.status === 403 ? "forbidden" : "invalid";
              const target = this.store
                .snapshot()
                .inputs.find((i) => i.id === delivery.inputId)?.continuation;
              if (target) {
                try {
                  await this.as(
                    this.store
                      .snapshot()
                      .inputs.find((i) => i.id === delivery.inputId)!.author,
                    () => this.validateContinuation(target),
                  );
                } catch (e) {
                  if (e instanceof ContinuationConflict)
                    delivery.rejection = e.reason;
                }
              }
            }
          }
          delivery.error =
            delivery.rejection === "closed"
              ? new ContinuationConflict("closed").message
              : delivery.rejection === "changed"
                ? new ContinuationConflict("changed").message
                : error instanceof UpstreamError
                  ? error.message
                  : "发送结果未确认。重试将核对同一个请求，不会重复执行。";
        }
        this.save();
      }
      await this.processCancellations();
      await this.collaboration.reconcile();
      for (const session of Object.values(this.state.sessions)) {
        if (this.stopped) break;
        if (
          !session.hasWork &&
          !this.state.deliveries.some(
            (d) => d.sessionId === session.id && d.rootId,
          )
        )
          continue;
        // Durable cursor resumes after restart; do not filter out causal thread-result joins.
        for (let page = 0; page < 10; page++) {
          const data = z
            .object({ events: z.array(eventSchema) })
            .parse(
              await this.request(
                `/api/sessions/${session.id}/events?after_sequence=${session.cursor}&limit=1000`,
              ),
            );
          for (const event of data.events.sort(
            (a, b) => a.sequence - b.sequence,
          )) {
            if (event.sequence <= session.cursor) continue;
            if (
              payloadString(event, "session_id") &&
              payloadString(event, "session_id") !== session.id
            )
              throw new Error("Runtime 返回了不属于当前会话的事件。");
            if (
              terminal.has(event.topic) ||
              ["runtime/thread_result", "chat/progress"].includes(event.topic)
            )
              session.events.push(event);
            session.cursor = event.sequence;
          }
          if (data.events.length < 1000) break;
        }
        for (const delivery of this.state.deliveries.filter(
          (d) =>
            d.sessionId === session.id && d.rootId && d.state === "running",
        )) {
          const result = session.events.find((e) =>
            settles(e, delivery.rootId!, session.events),
          );
          if (!result) continue;
          delivery.cancelRequested = false;
          delivery.state =
            result.topic === "chat/cancelled"
              ? "cancelled"
              : [
                    "chat/runtime_error",
                    "session/io_state",
                    "runtime/response_protocol_fused",
                  ].includes(result.topic)
                ? "failed"
                : "completed";
          delivery.error =
            delivery.state === "failed"
              ? (payloadString(result, "error") ??
                "Morphz 执行失败，请查看错误信息。")
              : null;
        }
      }
      await this.refreshActivity();
      await this.refreshAttention();
      this.browser?.drain(
        (projectId, sessionId) =>
          !this.state.deliveries.some(
            (d) =>
              ["queued", "sending", "running"].includes(d.state) &&
              (sessionId
                ? d.sessionId === sessionId
                : this.state.sessions[d.sessionId]?.projectId === projectId),
          ),
        (id) => this.enqueue(id),
        (id) =>
          id && this.state.sessions[id]
            ? discussionId(this.state.sessions[id]!)
            : undefined,
      );
    } catch (error) {
      this.state.connected = false;
      this.state.error =
        error instanceof UpstreamError
          ? error.message
          : "暂时无法连接 Morphz，正在重连；消息和执行状态已保留。";
    } finally {
      this.save();
      this.busy = false;
    }
  }
}
