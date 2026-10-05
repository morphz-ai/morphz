import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, localAccess } from "../../core/src/model.js";
import {
  applicationMethods,
  cognitiveAppApplicationRoute,
  ApplicationRequestError,
  type ApplicationMethod,
  type ApplicationCallOptions,
  type ApplicationReply,
} from "../../core/src/application-api.js";
import type { ConversationStream } from "../../core/src/live-conversation.js";
import {
  workspaceChangeScopeSchema,
  type WorkspaceChange,
} from "../../core/src/workspace-changes.js";
import {
  Application,
  applicationFailure,
  invokeApplication,
} from "./application.js";
import { parseCognitiveAppRequest } from "../../core/src/cognitive-app-api.js";
import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
} from "../../core/src/cognitive-app-view-api.js";
import {
  cognitiveAppViewApplicationRoute,
  type CognitiveAppViewApplicationMethod,
  type CognitiveAppViewApplicationRequest,
  type CognitiveAppViewApplicationResponse,
} from "../../core/src/cognitive-app-view-methods.js";
import {
  parseCognitiveAppViewResourceRequest,
  cognitiveAppViewHtmlResource,
  type CognitiveAppViewResource,
} from "../../core/src/cognitive-app-view-resource.js";
import {
  cognitiveAppDocumentResourceMime,
  parseCognitiveAppDocumentResourceRequest,
  parseCognitiveAppDocumentHtmlBytes,
  type CognitiveAppDocumentResource,
} from "../../core/src/cognitive-app-document-resource.js";

const invocationSchema = z
  .object({
    id: z.string().uuid(),
    method: z.enum(applicationMethods),
    params: z.unknown().optional(),
    identityGeneration: z.string().max(128).optional(),
  })
  .strict();
class AuthenticationRequired extends Error {}

/** Trusted host connection, not a server. No listener, URL, SQL or Electron API. */
export class LocalApplicationConnection {
  private generation = randomBytes(32).toString("hex");
  private cookie: string | undefined;
  private closing = false;
  private requests = new Map<string, AbortController>();
  private subscriptions = new Map<string, () => void>();
  constructor(
    readonly application: Application,
    cookie?: string,
  ) {
    this.cookie = cookie;
  }
  private authentication() {
    if (this.closing) throw new DomainError("forbidden", "应用连接已关闭。");
    const identity = this.application.options.identity;
    const authentication = identity?.authenticate(this.cookie);
    if (identity && !authentication)
      throw new AuthenticationRequired("请登录后继续操作。");
    return authentication;
  }
  private session(expected?: string) {
    const authentication = this.authentication();
    const generation = this.generation;
    if (expected !== undefined && expected !== generation)
      throw new DomainError("forbidden", "身份已切换，操作未执行。");
    const cookie = this.cookie;
    const assertActive = () => {
      try {
        this.authentication();
      } catch (error) {
        // An issued session becoming invalid is revoked authority, not a new
        // anonymous login attempt. Initial authentication still reports 401.
        if (error instanceof AuthenticationRequired)
          throw new DomainError("forbidden", "身份已失效，操作未执行。");
        throw error;
      }
      if (cookie !== this.cookie || generation !== this.generation)
        throw new DomainError("forbidden", "身份已切换，操作未执行。");
    };
    return {
      generation,
      session: this.application.session(
        authentication?.access ?? localAccess,
        assertActive,
      ),
    };
  }
  // Only the main-process host may persist/restore this cookie; never return it over the renderer bridge.
  authenticationCookie() {
    return this.cookie;
  }
  call<M extends CognitiveAppViewApplicationMethod>(
    method: M,
    params: CognitiveAppViewApplicationRequest<M>,
    options?: ApplicationCallOptions,
  ): Promise<CognitiveAppViewApplicationResponse<M>>;
  call(
    method: ApplicationMethod,
    params?: unknown,
    options?: ApplicationCallOptions,
  ): Promise<unknown>;
  async call(
    method: ApplicationMethod,
    params?: unknown,
    options: ApplicationCallOptions = {},
  ) {
    const cognitive = cognitiveAppApplicationRoute(method);
    const view = cognitiveAppViewApplicationRoute(method);
    if (cognitive) {
      try {
        params = parseCognitiveAppRequest(cognitive.method, params);
      } catch {
        throw new ApplicationRequestError(400, "请求格式无效。", "invalid");
      }
    }
    if (view) {
      try {
        params = parseCognitiveAppViewRequest(view.method, params);
      } catch {
        throw new ApplicationRequestError(400, "请求格式无效。", "invalid");
      }
    }
    const commandId =
      (cognitive || view) &&
      params &&
      typeof params === "object" &&
      "commandId" in params &&
      typeof params.commandId === "string"
        ? params.commandId
        : undefined;
    const assertNotAborted = () => {
      if ((cognitive || view) && options.signal?.aborted)
        throw new ApplicationRequestError(
          408,
          "请求已取消；已提交的操作不会回滚。",
          "cancelled",
          commandId,
        );
      options.signal?.throwIfAborted();
    };
    assertNotAborted();
    const id = randomUUID(),
      abort = () => this.cancel(id);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const reply = await this.invoke({
        id,
        method,
        params,
        identityGeneration: options.identityGeneration,
      });
      assertNotAborted();
      if (!reply.ok)
        throw new ApplicationRequestError(
          reply.error.status,
          reply.error.message,
          reply.error.code,
          reply.error.commandId,
        );
      if (view) {
        try {
          return parseCognitiveAppViewResponse(view.method, reply.value);
        } catch {
          throw new ApplicationRequestError(
            503,
            "窗口响应不符合固定契约。",
            "contract",
            commandId,
          );
        }
      }
      return reply.value;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  async invoke(raw: unknown): Promise<ApplicationReply> {
    let requestId: string | undefined;
    let commandId: string | undefined;
    try {
      const request = invocationSchema.parse(raw);
      const cognitive = cognitiveAppApplicationRoute(request.method);
      const view = cognitiveAppViewApplicationRoute(request.method);
      if (cognitive) {
        try {
          request.params = parseCognitiveAppRequest(
            cognitive.method,
            request.params,
          );
        } catch {
          throw new DomainError("invalid", "请求格式无效。");
        }
        if (
          request.params &&
          typeof request.params === "object" &&
          "commandId" in request.params &&
          typeof request.params.commandId === "string"
        )
          commandId = request.params.commandId;
      }
      if (view) {
        try {
          request.params = parseCognitiveAppViewRequest(
            view.method,
            request.params,
          );
        } catch {
          throw new DomainError("invalid", "请求格式无效。");
        }
        if (
          request.params &&
          typeof request.params === "object" &&
          "commandId" in request.params &&
          typeof request.params.commandId === "string"
        )
          commandId = request.params.commandId;
      }
      if (this.closing) throw new DomainError("forbidden", "应用连接已关闭。");
      if (this.requests.has(request.id) || this.requests.size >= 64)
        throw new DomainError("invalid", "应用请求过多或标识重复。");
      requestId = request.id;
      const controller = new AbortController();
      this.requests.set(request.id, controller);
      if (request.method === "login") {
        const { token } = z
          .object({ token: z.string().max(128) })
          .strict()
          .parse(request.params);
        const identity = this.application.options.identity;
        if (!identity) throw new DomainError("invalid", "本机工作区无需登录。");
        const secret = await identity.login(token, "desktop");
        this.invalidate();
        this.cookie = `${identity.cookieName}=${secret}`;
        return { ok: true, value: { connected: true } };
      }
      if (
        request.method !== "platform.bootstrap" &&
        !request.identityGeneration
      )
        throw new DomainError("forbidden", "请先读取当前工作区身份。");
      const { generation, session } = this.session(request.identityGeneration);
      if (request.method === "logout") {
        const authentication = this.authentication();
        if (authentication)
          await this.application.options.identity!.logout(
            authentication.sessionHash,
          );
        this.invalidate();
        this.cookie = undefined;
        return { ok: true, value: { disconnected: true } };
      }
      const value = await invokeApplication(
        session,
        request.method,
        request.params,
        generation,
        controller.signal,
      );
      if (controller.signal.aborted)
        return {
          ok: false,
          error: {
            status: 408,
            code: "cancelled",
            message: "请求已取消；已提交的操作不会回滚。",
            ...(commandId === undefined ? {} : { commandId }),
          },
        };
      return { ok: true, value };
    } catch (error) {
      const failure =
        requestId && this.requests.get(requestId)?.signal.aborted
          ? {
              status: 408,
              code: "cancelled",
              message: "请求已取消；已提交的操作不会回滚。",
            }
          : error instanceof AuthenticationRequired
            ? {
                status: 401,
                code: "authentication_required",
                message: error.message,
              }
            : applicationFailure(error);
      return {
        ok: false,
        error: {
          ...failure,
          ...(commandId === undefined ? {} : { commandId }),
        },
      };
    } finally {
      if (requestId) this.requests.delete(requestId);
    }
  }
  cancel(id: unknown) {
    if (typeof id === "string") this.requests.get(id)?.abort();
  }
  /** Native Host-only subscription. It is intentionally absent from the
   * renderer subscribe scope union; page credentials never cross that bridge. */
  async observeBrowser(
    id: string,
    scope: unknown,
    generation: string,
    emit: (hint: import("../../core/src/browser.js").BrowserWake) => void,
    onClose: () => void,
  ) {
    const key = z.uuid().parse(id);
    if (this.subscriptions.has(key) || this.subscriptions.size >= 32)
      throw new DomainError("invalid", "订阅过多或标识重复。");
    const controller = new AbortController();
    let disposed = false,
      dispose: (() => void) | undefined;
    const close = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      this.subscriptions.delete(key);
      dispose?.();
      onClose();
    };
    this.subscriptions.set(key, close);
    try {
      dispose = await this.session(generation).session.observeBrowserDesktop(
        scope,
        emit,
        close,
        controller.signal,
      );
      if (disposed) dispose();
    } catch (error) {
      close();
      throw error;
    }
  }
  async observe(
    id: unknown,
    scope: unknown,
    generation: unknown,
    emit: (value: ConversationStream | WorkspaceChange) => void,
    onClose: () => void,
  ) {
    const key = z.string().uuid().parse(id);
    const expected = z.string().min(1).parse(generation);
    if (this.subscriptions.has(key) || this.subscriptions.size >= 32)
      throw new DomainError("invalid", "订阅过多或标识重复。");
    let disposed = false;
    let dispose: (() => void) | undefined;
    const controller = new AbortController();
    const close = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      this.subscriptions.delete(key);
      onClose();
    };
    this.subscriptions.set(key, () => {
      close();
      dispose?.();
    });
    try {
      const session = this.session(expected).session;
      if (workspaceChangeScopeSchema.safeParse(scope).success) {
        dispose = await session.observeWorkspaceChanges(
          emit,
          close,
          controller.signal,
        );
        if (disposed) dispose();
        return;
      }
      const platform = z
        .object({
          kind: z.literal("platform"),
          projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
          conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
        })
        .strict()
        .parse(scope);
      dispose = await session.observePlatformConversation(
        {
          projectId: platform.projectId,
          conversationId: platform.conversationId,
        },
        emit,
        close,
        controller.signal,
      );
      if (disposed) dispose();
    } catch (error) {
      this.subscriptions.delete(key);
      throw error;
    }
  }
  unobserve(id: unknown) {
    if (typeof id !== "string") return;
    const dispose = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    dispose?.();
  }
  /** Separate bound-window resource. Legacy resource lookup stays unchanged. */
  async cognitiveAppViewResource(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<CognitiveAppViewResource> {
    let request;
    try {
      request = parseCognitiveAppViewResourceRequest(raw);
    } catch {
      throw new ApplicationRequestError(400, "界面资源请求无效。", "invalid");
    }
    if (signal?.aborted)
      throw new ApplicationRequestError(
        408,
        "界面资源读取已取消。",
        "cancelled",
      );
    let id: string | undefined,
      issued = false;
    try {
      const { generation, session } = this.session();
      issued = true;
      if (this.requests.size >= 64)
        throw new ApplicationRequestError(429, "界面资源读取正忙。", "busy");
      const controller = new AbortController();
      id = randomUUID();
      this.requests.set(id, controller);
      const active = () => {
        this.session(generation);
        if (controller.signal.aborted || signal?.aborted)
          throw new ApplicationRequestError(
            408,
            "界面资源读取已取消。",
            "cancelled",
          );
      };
      active();
      const ui = parseCognitiveAppViewResponse(
        "readUi",
        await session.cognitiveAppView("readUi", request),
      );
      active();
      if (ui.manifest.ui.type !== "sandbox")
        throw new ApplicationRequestError(
          502,
          "界面资源不符合固定契约。",
          "contract",
        );
      let resource;
      try {
        resource = cognitiveAppViewHtmlResource(ui.manifest.ui.html);
      } catch {
        throw new ApplicationRequestError(
          502,
          "界面资源不符合固定契约。",
          "contract",
        );
      }
      active();
      return resource;
    } catch (error) {
      if (error instanceof ApplicationRequestError) throw error;
      if (error instanceof AuthenticationRequired)
        throw new ApplicationRequestError(
          issued ? 403 : 401,
          "界面资源已无访问权限。",
          "forbidden",
        );
      const failure = applicationFailure(error);
      throw new ApplicationRequestError(
        [400, 403, 404, 409, 429, 502].includes(failure.status)
          ? failure.status
          : 503,
        "界面资源不可用或已无访问权限。",
        [
          "invalid",
          "forbidden",
          "not_found",
          "conflict",
          "busy",
          "contract",
        ].includes(failure.code)
          ? failure.code
          : "unavailable",
      );
    } finally {
      if (id) this.requests.delete(id);
    }
  }
  /** Internal fixed document carrier uses the same request budget and issued
   * identity as ordinary Local reads, including all asynchronous preparation. */
  async cognitiveAppDocumentResource(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<CognitiveAppDocumentResource> {
    let request;
    try {
      request = parseCognitiveAppDocumentResourceRequest(raw);
    } catch {
      throw new ApplicationRequestError(400, "文档资源请求无效。", "invalid");
    }
    const cancelled = () =>
      new ApplicationRequestError(408, "文档资源读取已取消。", "cancelled");
    if (signal?.aborted) throw cancelled();
    let id: string | undefined,
      issued = false;
    try {
      const { generation, session } = this.session();
      issued = true;
      if (this.requests.size >= 64)
        throw new ApplicationRequestError(429, "文档资源读取正忙。", "busy");
      const controller = new AbortController();
      id = randomUUID();
      this.requests.set(id, controller);
      const incoming = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      const active = () => {
        this.session(generation);
        if (incoming.aborted) throw cancelled();
      };
      active();
      const result = await session.cognitiveAppDocumentResource(
        request,
        incoming,
      );
      active();
      let bytes;
      try {
        if (result.mime !== cognitiveAppDocumentResourceMime) throw new Error();
        bytes = parseCognitiveAppDocumentHtmlBytes(result.bytes);
      } catch {
        throw new ApplicationRequestError(
          502,
          "文档资源不符合固定契约。",
          "contract",
        );
      }
      active();
      return { mime: cognitiveAppDocumentResourceMime, bytes };
    } catch (error) {
      if (error instanceof ApplicationRequestError) throw error;
      if (signal?.aborted) throw cancelled();
      if (error instanceof AuthenticationRequired)
        throw new ApplicationRequestError(
          issued ? 403 : 401,
          "文档资源已无访问权限。",
          "forbidden",
        );
      const failure = applicationFailure(error);
      throw new ApplicationRequestError(
        [400, 403, 404, 409, 429, 502].includes(failure.status)
          ? failure.status
          : 503,
        "文档资源不可用或已无访问权限。",
        [
          "invalid",
          "forbidden",
          "not_found",
          "conflict",
          "busy",
          "contract",
        ].includes(failure.code)
          ? failure.code
          : "unavailable",
      );
    } finally {
      if (id) this.requests.delete(id);
    }
  }
  async resource(
    kind: "assets" | "attachments" | "application-view",
    id: string,
    source?: { projectId: string; conversationId: string; inputId: string },
  ) {
    const { session } = this.session();
    if (kind === "application-view")
      return {
        mime: "text/html; charset=utf-8",
        bytes: Buffer.from(await session.applicationView(id)),
      };
    return session.asset(id, kind === "attachments", source);
  }
  readerOriginalMetadata(artifactId: string, revision: number) {
    return this.session().session.readPlatformReaderOriginalMetadata({
      artifactId,
      revision,
    });
  }
  readerOriginalRange(
    artifactId: string,
    revision: number,
    start: number,
    endExclusive: number,
  ) {
    return this.session().session.readPlatformReaderOriginalRange({
      artifactId,
      revision,
      start,
      endExclusive,
    });
  }
  invalidate() {
    this.generation = randomBytes(32).toString("hex");
    for (const request of this.requests.values()) request.abort();
    for (const dispose of this.subscriptions.values()) dispose();
    this.subscriptions.clear();
  }
  close() {
    this.closing = true;
    this.invalidate();
  }
}
