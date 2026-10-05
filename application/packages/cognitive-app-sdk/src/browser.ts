import {
  cognitiveBrowserLimits,
  cognitiveBrowserProtocol,
  parseBrowserMessage,
  parseBrowserRequest,
  parseBrowserResult,
  type BrowserContext,
  type BrowserHostErrorCode,
  type BrowserMethod,
  type BrowserRequest,
  type BrowserRequestFor,
  type BrowserResultMap,
} from "./browser-wire.js";
import { canonicalJsonBytes } from "./domain-wire.js";

export * from "./browser-wire.js";
export type BrowserErrorCode =
  BrowserHostErrorCode | "timeout" | "disposed" | "unsupported";
const messages: Record<BrowserErrorCode, string> = {
  invalid: "The application message is invalid.",
  forbidden: "The Host did not authorize this request.",
  not_found: "The current application or command is unavailable.",
  conflict:
    "The original request or view premises conflict; nothing is automatically resent.",
  busy: "The application message limit is reached; this request was not sent.",
  unavailable:
    "The application Host is unavailable; existing command facts are unchanged.",
  contract: "The application response does not satisfy the fixed contract.",
  timeout:
    "The application response deadline elapsed; a write may still have been admitted or committed. Reuse its original commandId for status/recovery.",
  disposed:
    "This application channel has retired; existing writes are not implicitly cancelled.",
  unsupported:
    "The browser SDK requires an embedded sandbox with a parent window.",
};
export class CognitiveBrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    readonly commandId?: string,
  ) {
    super(messages[code]);
    this.name = "CognitiveBrowserError";
  }
}
export type CognitiveBrowserClient = Readonly<{
  readonly context: BrowserContext;
  ready(): Promise<BrowserContext>;
  invoke(
    request: Omit<BrowserRequestFor<"invoke">, "method">,
  ): Promise<BrowserResultMap["invoke"]>;
  readObject(
    request: Omit<BrowserRequestFor<"readObject">, "method">,
  ): Promise<BrowserResultMap["readObject"]>;
  openObject(
    request: Omit<BrowserRequestFor<"openObject">, "method">,
  ): Promise<BrowserResultMap["openObject"]>;
  compose(
    request: Omit<BrowserRequestFor<"compose">, "method">,
  ): Promise<BrowserResultMap["compose"]>;
  saveState(
    request: Omit<BrowserRequestFor<"saveState">, "method">,
  ): Promise<BrowserResultMap["saveState"]>;
  commandStatus(commandId: string): Promise<BrowserResultMap["commandStatus"]>;
  recoverReceipt(
    commandId: string,
  ): Promise<BrowserResultMap["recoverReceipt"]>;
  onContextChange(listener: (context: BrowserContext) => void): () => void;
  dispose(): void;
}>;
type Pending = {
  request: BrowserRequest;
  context: BrowserContext;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  accept(value: BrowserResultMap[BrowserMethod]): void;
  reject(error: CognitiveBrowserError): void;
};
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function sameJson(actual: unknown, expected: unknown): boolean {
  const left = canonicalJsonBytes(actual),
    right = canonicalJsonBytes(expected);
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
const commandOf = (request: BrowserRequest): string | undefined =>
  request.method === "invoke"
    ? (request.commandId ?? undefined)
    : request.method === "commandStatus" || request.method === "recoverReceipt"
      ? request.commandId
      : undefined;
let activeConnection: Promise<CognitiveBrowserClient> | undefined;

/** Importing this module does nothing. Only this explicit call attaches a
 * listener to the actual browser window and its fixed parent. No caller URL,
 * identity, transport adapter, deadline override or private binding is accepted. */
export function connectMorphz(): Promise<CognitiveBrowserClient> {
  if (
    typeof window === "undefined" ||
    window.parent === window ||
    window.parent === null
  )
    return Promise.reject(new CognitiveBrowserError("unsupported"));
  if (activeConnection) return activeConnection;
  const guest = window,
    parent = window.parent;
  const started = performance.now(),
    deadline = started + cognitiveBrowserLimits.deadlineMs;
  let channel: string | null = null,
    parentOrigin: string | null = null;
  let context: BrowserContext | null = null,
    disposed = false;
  const pending = new Map<string, Pending>();
  const observers = new Set<(context: BrowserContext) => void>();
  let resolveConnection: (client: CognitiveBrowserClient) => void;
  let rejectConnection: (error: CognitiveBrowserError) => void;
  const connected = new Promise<CognitiveBrowserClient>((accept, reject) => {
    resolveConnection = accept;
    rejectConnection = reject;
  });
  const connectionTimer = setTimeout(
    () => retire("timeout"),
    cognitiveBrowserLimits.deadlineMs,
  );
  function retire(code: "disposed" | "timeout") {
    if (disposed) return;
    disposed = true;
    if (activeConnection === connected) activeConnection = undefined;
    clearTimeout(connectionTimer);
    guest.removeEventListener("message", receive);
    rejectConnection(new CognitiveBrowserError(code));
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new CognitiveBrowserError(code, commandOf(item.request)));
    }
    pending.clear();
    observers.clear();
  }
  function publish(next: BrowserContext) {
    if (context !== null && next.view.revision < context.view.revision) return;
    const changed = context === null || !sameJson(next, context);
    context = freeze(next);
    if (!changed) return;
    // Notification is UI-only: no operation/read/recovery is triggered here.
    // Isolate author callback failures; never log its potentially private data.
    for (const observer of [...observers]) {
      if (disposed) break;
      try {
        observer(context);
      } catch {
        /* An author UI error grants nothing. */
      }
    }
  }
  function sameBinding(next: BrowserContext, original: BrowserContext) {
    return (
      next.view.id === original.view.id &&
      next.view.bindingRevision === original.view.bindingRevision &&
      sameJson(next.authority, original.authority) &&
      sameJson(next.definition, original.definition)
    );
  }
  function receive(event: MessageEvent<unknown>) {
    if (
      disposed ||
      event.source !== parent ||
      (parentOrigin !== null && event.origin !== parentOrigin)
    )
      return;
    let message;
    try {
      message = parseBrowserMessage(event.data);
    } catch {
      return;
    }
    if (message.type === "morphz-cognitive-ui/v1:init") {
      if (channel !== null) {
        if (
          message.channel !== channel ||
          context === null ||
          !sameBinding(message.context, context)
        ) {
          retire("disposed");
          return;
        }
        publish(message.context);
        return;
      }
      if (performance.now() >= deadline) {
        retire("timeout");
        return;
      }
      parentOrigin = event.origin;
      channel = message.channel;
      context = freeze(message.context);
      clearTimeout(connectionTimer);
      resolveConnection(client);
      return;
    }
    if (
      channel === null ||
      message.type === "morphz-cognitive-ui/v1:connect" ||
      message.type === "morphz-cognitive-ui/v1:request" ||
      message.channel !== channel
    )
      return;
    if (message.type === "morphz-cognitive-ui/v1:retire") {
      retire("disposed");
      return;
    }
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId);
    clearTimeout(item.timer);
    if (performance.now() >= item.deadline) {
      item.reject(
        new CognitiveBrowserError("timeout", commandOf(item.request)),
      );
      return;
    }
    if (!message.ok) {
      const original = commandOf(item.request);
      if (
        message.error.commandId !== undefined &&
        message.error.commandId !== original
      ) {
        item.reject(new CognitiveBrowserError("contract", original));
        return;
      }
      item.reject(new CognitiveBrowserError(message.error.code, original));
      return;
    }
    try {
      const result = parseBrowserResult(
        item.request,
        message.result,
        item.context,
      );
      if (performance.now() >= item.deadline) {
        item.reject(
          new CognitiveBrowserError("timeout", commandOf(item.request)),
        );
        return;
      }
      if (item.request.method === "ready") {
        const next = result as BrowserContext;
        if (context === null || !sameBinding(next, context)) {
          retire("disposed");
          item.reject(
            new CognitiveBrowserError("disposed", commandOf(item.request)),
          );
          return;
        }
        publish(next);
      }
      if (disposed) {
        item.reject(
          new CognitiveBrowserError("disposed", commandOf(item.request)),
        );
        return;
      }
      if (performance.now() >= item.deadline) {
        item.reject(
          new CognitiveBrowserError("timeout", commandOf(item.request)),
        );
        return;
      }
      item.accept(freeze(result));
    } catch {
      item.reject(
        new CognitiveBrowserError(
          performance.now() >= item.deadline ? "timeout" : "contract",
          commandOf(item.request),
        ),
      );
    }
  }
  function request<M extends BrowserMethod>(
    method: M,
    payload: unknown,
  ): Promise<BrowserResultMap[M]> {
    const requestDeadline =
      performance.now() + cognitiveBrowserLimits.deadlineMs;
    if (disposed || context === null || channel === null)
      return Promise.reject(new CognitiveBrowserError("disposed"));
    if (pending.size >= cognitiveBrowserLimits.pending)
      return Promise.reject(new CognitiveBrowserError("busy"));
    let parsed: BrowserRequest;
    try {
      // Capture the original author input before spreading it or reading any
      // field. The fixed pure JSON guard rejects accessors/prototypes first;
      // the detached data snapshot cannot change while the request is pending.
      const input: unknown = JSON.parse(
        new TextDecoder().decode(canonicalJsonBytes(payload)),
      );
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.hasOwn(input, "method")
      )
        throw new CognitiveBrowserError("invalid");
      parsed = parseBrowserRequest({ ...input, method }, context);
    } catch {
      return Promise.reject(
        new CognitiveBrowserError(
          performance.now() >= requestDeadline ? "timeout" : "invalid",
        ),
      );
    }
    if (performance.now() >= requestDeadline)
      return Promise.reject(
        new CognitiveBrowserError("timeout", commandOf(parsed)),
      );
    const requestId = crypto.randomUUID(),
      originalContext = context;
    return new Promise<BrowserResultMap[M]>((accept, reject) => {
      const timer = setTimeout(
        () => {
          const item = pending.get(requestId);
          if (!item) return;
          pending.delete(requestId);
          item.reject(new CognitiveBrowserError("timeout", commandOf(parsed)));
        },
        Math.max(0, requestDeadline - performance.now()),
      );
      pending.set(requestId, {
        request: parsed,
        context: originalContext,
        deadline: requestDeadline,
        timer,
        accept: (value) => accept(value as BrowserResultMap[M]),
        reject,
      });
      try {
        // Only the actual parent can receive this; targetOrigin '*' is necessary
        // for an opaque/custom-scheme parent and is not a broadcast/network API.
        if (performance.now() >= requestDeadline)
          throw new CognitiveBrowserError("timeout", commandOf(parsed));
        parent.postMessage(
          {
            type: `${cognitiveBrowserProtocol}:request`,
            channel,
            requestId,
            request: parsed,
          },
          "*",
        );
      } catch {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(
          new CognitiveBrowserError(
            performance.now() >= requestDeadline ? "timeout" : "unavailable",
            commandOf(parsed),
          ),
        );
      }
    });
  }
  const client: CognitiveBrowserClient = Object.freeze({
    get context() {
      if (disposed || context === null)
        throw new CognitiveBrowserError("disposed");
      return context;
    },
    ready: () => request("ready", {}),
    invoke: (input) => request("invoke", input),
    readObject: (input) => request("readObject", input),
    openObject: (input) => request("openObject", input),
    compose: (input) => request("compose", input),
    saveState: (input) => request("saveState", input),
    commandStatus: (commandId) => request("commandStatus", { commandId }),
    recoverReceipt: (commandId) => request("recoverReceipt", { commandId }),
    onContextChange: (listener) => {
      if (disposed) throw new CognitiveBrowserError("disposed");
      if (typeof listener !== "function")
        throw new CognitiveBrowserError("invalid");
      if (observers.size >= cognitiveBrowserLimits.pending)
        throw new CognitiveBrowserError("busy");
      const observer = (value: BrowserContext) => listener(value);
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    dispose: () => retire("disposed"),
  });
  activeConnection = connected;
  guest.addEventListener("message", receive);
  try {
    parent.postMessage({ type: `${cognitiveBrowserProtocol}:connect` }, "*");
  } catch {
    retire("disposed");
  }
  return connected;
}
