import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, localAccess } from "../../core/src/model.js";
import {
  applicationMethods,
  ApplicationRequestError,
  type ApplicationMethod,
  type ApplicationCallOptions,
  type ApplicationReply,
} from "../../core/src/application-api.js";
import type { ConversationStream } from "../../core/src/live-conversation.js";
import {
  Application,
  applicationFailure,
  invokeApplication,
} from "./application.js";

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
      this.authentication();
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
  async call(
    method: ApplicationMethod,
    params?: unknown,
    options: ApplicationCallOptions = {},
  ) {
    options.signal?.throwIfAborted();
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
      options.signal?.throwIfAborted();
      if (!reply.ok)
        throw new ApplicationRequestError(
          reply.error.status,
          reply.error.message,
          reply.error.code,
        );
      return reply.value;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  async invoke(raw: unknown): Promise<ApplicationReply> {
    let requestId: string | undefined;
    try {
      const request = invocationSchema.parse(raw);
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
        const secret = identity.login(token, "desktop");
        this.invalidate();
        this.cookie = `${identity.cookieName}=${secret}`;
        return { ok: true, value: { connected: true } };
      }
      if (request.method !== "workspace" && !request.identityGeneration)
        throw new DomainError("forbidden", "请先读取当前工作区身份。");
      const { generation, session } = this.session(request.identityGeneration);
      if (request.method === "logout") {
        const authentication = this.authentication();
        if (authentication)
          this.application.options.identity!.logout(authentication.sessionHash);
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
          },
        };
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error:
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
              : applicationFailure(error),
      };
    } finally {
      if (requestId) this.requests.delete(requestId);
    }
  }
  cancel(id: unknown) {
    if (typeof id === "string") this.requests.get(id)?.abort();
  }
  observe(
    id: unknown,
    scope: unknown,
    generation: unknown,
    emit: (value: ConversationStream) => void,
    onClose: () => void,
  ) {
    const key = z.string().uuid().parse(id);
    const expected = z.string().min(1).parse(generation);
    if (this.subscriptions.has(key) || this.subscriptions.size >= 32)
      throw new DomainError("invalid", "订阅过多或标识重复。");
    let disposed = false;
    const close = () => {
      disposed = true;
      this.subscriptions.delete(key);
      onClose();
    };
    const dispose = this.session(expected).session.observeConversation(
      scope,
      emit,
      close,
    );
    if (disposed) dispose();
    else this.subscriptions.set(key, dispose);
  }
  unobserve(id: unknown) {
    if (typeof id !== "string") return;
    const dispose = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    dispose?.();
  }
  resource(kind: "assets" | "attachments" | "application-view", id: string) {
    const { session } = this.session();
    if (kind === "application-view")
      return {
        mime: "text/html; charset=utf-8",
        bytes: Buffer.from(session.applicationView(id)),
      };
    return session.asset(id, kind === "attachments");
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
