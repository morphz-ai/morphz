import type { ApplicationMethod } from "../../../packages/core/src/application-api.js";
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
  options.signal?.throwIfAborted();
  if (identityTransition)
    throw new ApplicationRequestError(409, "身份正在切换，请稍后重试。");
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
    options.signal?.throwIfAborted();
    let value: unknown;
    if (!bridge) value = await http.call(method, params, requestOptions);
    else {
      const id = crypto.randomUUID();
      const reply = await new Promise<
        import("../../../packages/core/src/application-api.js").ApplicationReply
      >((resolve, reject) => {
        const abort = () => {
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
          ...(method !== "workspace" && method !== "login"
            ? { identityGeneration: requestOptions.identityGeneration }
            : {}),
        });
        pending
          .then(resolve, reject)
          .finally(() => options.signal?.removeEventListener("abort", abort));
      });
      options.signal?.throwIfAborted();
      if (!reply.ok)
        throw new ApplicationRequestError(
          reply.error.status,
          reply.error.message,
          reply.error.code,
        );
      value = reply.value;
    }
    options.signal?.throwIfAborted();
    if (epoch !== connectionEpoch)
      throw new DOMException("身份已切换，旧响应已丢弃。", "AbortError");
    if (method === "workspace") observeIdentity(value);
    if (method === "login" || method === "logout") {
      identity = "disconnected";
      generation = "";
    }
    return value;
  } finally {
    if (changesIdentity) {
      identityTransition = false;
      connectionEpoch++;
    }
  }
}

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
          void bridge.subscribe(id, scope, expected).catch(reconnect);
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
    void bridge.subscribe(id, scope, expected).catch(reconnect);
    return () => {
      closed = true;
      clearTimeout(retry);
      bridge.unsubscribe(id);
      dispose();
    };
  }
  const source = new EventSource(
    `/api/conversation/stream?${new URLSearchParams(scope)}`,
  );
  source.onmessage = (event) => {
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
  source.onerror = lost;
  return () => {
    closed = true;
    source.close();
  };
}
