import {
  cognitiveAppApplicationRoute,
  type ApplicationMethod,
} from "../../../packages/core/src/application-api.js";
import { parseCognitiveAppRequest } from "../../../packages/core/src/cognitive-app-api.js";
import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
} from "../../../packages/core/src/cognitive-app-view-api.js";
import {
  cognitiveAppViewApplicationRoute,
  type CognitiveAppViewApplicationMethod,
  type CognitiveAppViewApplicationRequest,
  type CognitiveAppViewApplicationResponse,
} from "../../../packages/core/src/cognitive-app-view-methods.js";
import {
  HttpApplicationClient,
  ApplicationRequestError,
  type CallOptions,
} from "../../../packages/core/src/http-application-client.js";
import {
  conversationFrameSchema,
  conversationStreamSchema,
  type ConversationStream,
  type LiveMessage,
} from "../../../packages/core/src/live-conversation.js";
import type {} from "./desktop.js";
import {
  workspaceChangeSchema,
  type WorkspaceChange,
} from "../../../packages/core/src/workspace-changes.js";

export { ApplicationRequestError as RequestError };
const http = new HttpApplicationClient();
let identity = "disconnected",
  generation = "",
  connectionEpoch = 0,
  identityTransition = false;
export const applicationIdentity = () => identity;
function observeIdentity(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "csrfToken" in value &&
    "centerId" in value &&
    "principalId" in value
  ) {
    generation = String(value.csrfToken);
    identity = `${String(value.centerId)}:${String(value.principalId)}:${generation}`;
  }
}

/** No URL is sent across the desktop bridge: only allowlisted logical operations. */
export async function applicationCall(
  method: ApplicationMethod,
  params?: unknown,
  options: CallOptions = {},
): Promise<unknown> {
  const cognitive = cognitiveAppApplicationRoute(method);
  const view = cognitiveAppViewApplicationRoute(method);
  const guarded = cognitive || view;
  let commandId: string | undefined;
  if (cognitive) {
    try {
      params = parseCognitiveAppRequest(cognitive.method, params);
    } catch {
      throw new ApplicationRequestError(400, "请求格式无效。", "invalid");
    }
    if (
      params &&
      typeof params === "object" &&
      "commandId" in params &&
      typeof params.commandId === "string"
    )
      commandId = params.commandId;
  }
  if (view) {
    try {
      params = parseCognitiveAppViewRequest(view.method, params);
    } catch {
      throw new ApplicationRequestError(400, "请求格式无效。", "invalid");
    }
    if (
      params &&
      typeof params === "object" &&
      "commandId" in params &&
      typeof params.commandId === "string"
    )
      commandId = params.commandId;
  }
  const cancelled = () =>
    new ApplicationRequestError(
      408,
      "请求已取消；已提交的操作不会回滚。",
      "cancelled",
      commandId,
    );
  const assertNotAborted = () => {
    if (guarded && options.signal?.aborted) throw cancelled();
    options.signal?.throwIfAborted();
  };
  assertNotAborted();
  if (identityTransition)
    throw new ApplicationRequestError(
      409,
      "身份正在切换，请稍后重试。",
      guarded ? "conflict" : undefined,
      commandId,
    );
  const changesIdentity = method === "login" || method === "logout";
  if (changesIdentity) {
    identityTransition = true;
    connectionEpoch++;
  }
  const epoch = connectionEpoch;
  try {
    const bridge =
      typeof window === "undefined"
        ? undefined
        : window.morphzDesktop?.application;
    const requestOptions = {
      ...options,
      identityGeneration: options.identityGeneration ?? generation,
    };
    assertNotAborted();
    let value: unknown;
    if (!bridge) value = await http.call(method, params, requestOptions);
    else {
      const id = crypto.randomUUID();
      const reply = await new Promise<
        import("../../../packages/core/src/application-api.js").ApplicationReply
      >((resolve, reject) => {
        const abort = () => {
          if (guarded) {
            try {
              bridge.cancel(id);
            } catch {
              // A disconnected IPC channel cannot confirm cancellation. Keep
              // the original command for receipt recovery, never a resend.
            }
            reject(cancelled());
            return;
          }
          bridge.cancel(id);
          reject(
            options.signal?.reason ??
              new DOMException("请求已取消", "AbortError"),
          );
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        const pending = bridge.invoke({
          id,
          method,
          params,
          ...(method !== "platform.bootstrap" && method !== "login"
            ? { identityGeneration: requestOptions.identityGeneration }
            : {}),
        });
        pending
          .then(resolve, reject)
          .finally(() => options.signal?.removeEventListener("abort", abort));
      });
      assertNotAborted();
      if (!reply.ok)
        throw new ApplicationRequestError(
          reply.error.status,
          reply.error.message,
          reply.error.code,
          commandId,
        );
      value = reply.value;
    }
    assertNotAborted();
    if (epoch !== connectionEpoch) {
      if (guarded)
        throw new ApplicationRequestError(
          408,
          "身份已切换，旧响应已丢弃。",
          "cancelled",
          commandId,
        );
      throw new DOMException("身份已切换，旧响应已丢弃。", "AbortError");
    }
    if (method === "platform.bootstrap") observeIdentity(value);
    if (method === "login" || method === "logout") {
      identity = "disconnected";
      generation = "";
    }
    if (view) {
      try {
        return parseCognitiveAppViewResponse(view.method, value);
      } catch {
        throw new ApplicationRequestError(
          503,
          "窗口响应不符合固定契约。",
          "contract",
          commandId,
        );
      }
    }
    return value;
  } catch (error) {
    if (!guarded) throw error;
    if (options.signal?.aborted) throw cancelled();
    if (error instanceof ApplicationRequestError)
      throw new ApplicationRequestError(
        error.status,
        error.message,
        error.code,
        commandId,
      );
    throw new ApplicationRequestError(
      503,
      "应用暂时不可用。",
      "unavailable",
      commandId,
    );
  } finally {
    if (changesIdentity) {
      identityTransition = false;
      connectionEpoch++;
    }
  }
}

/** Typed presentation client; the mature general function's contextual type
 * remains unchanged for existing consumers and interaction-owner ports. */
export function cognitiveAppViewCall<
  M extends CognitiveAppViewApplicationMethod,
>(
  method: M,
  params: CognitiveAppViewApplicationRequest<M>,
  options?: CallOptions,
): Promise<CognitiveAppViewApplicationResponse<M>> {
  return applicationCall(method, params, options) as Promise<
    CognitiveAppViewApplicationResponse<M>
  >;
}

/** The formal exchange and execution inspector share the Platform Session stream. */
export function subscribeConversation(
  scope: { projectId: string; conversationId: string },
  update: (value: ConversationStream) => void,
) {
  const bridge = window.morphzDesktop?.application;
  let current: ConversationStream = { connected: false, messages: [] },
    closed = false;
  const disconnectedPrefixes = new Map<string, LiveMessage>();
  const lost = () => {
    current = {
      connected: false,
      messages: current.messages.map((m) =>
        m.streaming === undefined ? m : { ...m, streaming: false },
      ),
    };
    for (const message of current.messages)
      if (
        message.kind !== "tool" &&
        message.streaming !== undefined &&
        message.text
      )
        disconnectedPrefixes.set(message.id, message);
    if (!closed) update(current);
  };
  const receive = (value: ConversationStream, removed: string[] = []) => {
    for (const id of removed) disconnectedPrefixes.delete(id);
    for (const message of value.messages)
      for (const [id, prefix] of disconnectedPrefixes)
        if (
          id === message.id ||
          (prefix.publicationKey &&
            prefix.publicationKey === message.publicationKey)
        )
          disconnectedPrefixes.delete(id);
    current = {
      connected: value.connected,
      messages: [...disconnectedPrefixes.values(), ...value.messages],
    };
    update(current);
  };
  if (bridge) {
    const id = crypto.randomUUID(),
      expected = generation;
    let retry: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const reconnect = () => {
      lost();
      if (closed || retry) return;
      retry = setTimeout(() => {
        retry = undefined;
        if (!closed)
          void bridge
            .subscribe(id, { ...scope, kind: "platform" }, expected)
            .catch(reconnect);
      }, delay);
      delay = Math.min(8000, delay * 2);
    };
    const dispose = bridge.onStream((event) => {
      if (event.id !== id || closed) return;
      if (event.closed) reconnect();
      else if (event.value) {
        try {
          const value = conversationStreamSchema.parse(event.value);
          delay = 1000;
          receive(value);
        } catch {
          reconnect();
        }
      }
    });
    void bridge
      .subscribe(id, { ...scope, kind: "platform" }, expected)
      .catch(reconnect);
    return () => {
      closed = true;
      clearTimeout(retry);
      bridge.unsubscribe(id);
      dispose();
    };
  }
  const stream = new EventSource(
    `/api/platform/projects/${encodeURIComponent(scope.projectId)}/conversations/${encodeURIComponent(scope.conversationId)}/stream`,
  );
  stream.onmessage = (event) => {
    if (closed) return;
    try {
      const value = conversationFrameSchema.parse(JSON.parse(event.data));
      const messages = new Map(
        (value.reset ? [] : current.messages).map((m) => [m.id, m]),
      );
      for (const id of value.removed) messages.delete(id);
      for (const message of value.messages) messages.set(message.id, message);
      receive(
        {
          connected: value.connected,
          messages: [...messages.values()],
        },
        value.removed,
      );
    } catch {
      lost();
    }
  };
  stream.onerror = lost;
  return () => {
    closed = true;
    stream.close();
  };
}

/** Invalidations carry no objects or authority. A new connection's first valid
 * frame requests a fresh authorized snapshot; its sequence is connection-local. */
export function subscribeWorkspaceChanges(
  update: (value: WorkspaceChange) => void,
  lifecycle: { onConnected?: () => void; onClosed?: () => void } = {},
) {
  const bridge = window.morphzDesktop?.application;
  const expected = generation,
    epoch = connectionEpoch;
  let closed = false,
    connected = false,
    sequence = 0;
  const validIdentity = () =>
    !closed &&
    !identityTransition &&
    epoch === connectionEpoch &&
    expected === generation;
  const lost = () => {
    connected = false;
    if (validIdentity()) lifecycle.onClosed?.();
  };
  const receive = (raw: unknown) => {
    if (!validIdentity()) return;
    const value = workspaceChangeSchema.parse(raw);
    if (value.sequence <= sequence) return;
    sequence = value.sequence;
    if (!connected) {
      connected = true;
      lifecycle.onConnected?.();
    }
    update(value);
  };
  if (bridge) {
    let activeId = "",
      retry: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const reconnect = () => {
      lost();
      if (!validIdentity() || retry) return;
      retry = setTimeout(() => {
        retry = undefined;
        if (validIdentity()) subscribe();
      }, delay);
      delay = Math.min(8000, delay * 2);
    };
    const subscribe = () => {
      if (activeId) bridge.unsubscribe(activeId);
      activeId = crypto.randomUUID();
      sequence = 0;
      const id = activeId;
      void bridge.subscribe(id, { kind: "workspace" }, expected).catch(() => {
        if (id === activeId) reconnect();
      });
    };
    const dispose = bridge.onStream((event) => {
      if (event.id !== activeId || !validIdentity()) return;
      if (event.closed) reconnect();
      else if (event.value) {
        try {
          receive(event.value);
          delay = 1000;
        } catch {
          reconnect();
        }
      }
    });
    subscribe();
    return () => {
      closed = true;
      clearTimeout(retry);
      bridge.unsubscribe(activeId);
      dispose();
    };
  }
  const stream = new EventSource("/api/platform/workspace/stream");
  stream.onopen = () => {
    sequence = 0;
    connected = false;
  };
  stream.onmessage = (event) => {
    try {
      receive(JSON.parse(event.data));
    } catch {
      lost();
    }
  };
  stream.onerror = lost;
  return () => {
    closed = true;
    stream.close();
  };
}
