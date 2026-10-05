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
    "The browser SDK requires the original Document's fixed local facade.",
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
let activeDocument: (() => boolean) | undefined;
let claimedDocument = false;
type DocumentTransport = Readonly<{
  check(): void;
  send(text: string): void;
  subscribe(onText: (text: string) => void, onRetire?: () => void): () => void;
  dispose(): void;
}>;
const documentFacadeName = "__morphzCognitiveDocument";
function clearLocalTimer(timer: ReturnType<typeof setTimeout>) {
  try {
    clearTimeout(timer);
  } catch {
    /* Author cleanup errors must not strand a local request or escape as cause. */
  }
}
function transportFailure(error: unknown): "busy" | "unavailable" {
  try {
    if (
      error === null ||
      (typeof error !== "object" && typeof error !== "function")
    )
      return "unavailable";
    const code = Object.getOwnPropertyDescriptor(error, "code");
    return code && "value" in code && code.value === "busy"
      ? "busy"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Importing this module does nothing. Only this explicit call claims the
 * original Document's fixed local facade. No Window message fallback, caller URL,
 * identity, transport adapter, deadline override or private binding is accepted. */
export function connectMorphz(): Promise<CognitiveBrowserClient> {
  if (typeof window === "undefined")
    return Promise.reject(new CognitiveBrowserError("unsupported"));
  if (activeConnection) {
    return activeDocument?.()
      ? activeConnection!
      : Promise.reject(new CognitiveBrowserError("disposed"));
  }
  if (claimedDocument)
    return Promise.reject(new CognitiveBrowserError("disposed"));
  let transport: DocumentTransport;
  try {
    const factory = Object.getOwnPropertyDescriptor(window, documentFacadeName);
    if (
      !factory ||
      !("value" in factory) ||
      typeof factory.value !== "function"
    )
      return Promise.reject(new CognitiveBrowserError("unsupported"));
    claimedDocument = true;
    transport = factory.value() as DocumentTransport;
    transport.check();
  } catch {
    return Promise.reject(new CognitiveBrowserError("disposed"));
  }
  const started = performance.now(),
    deadline = started + cognitiveBrowserLimits.deadlineMs;
  let channel: string | null = null;
  let context: BrowserContext | null = null,
    disposed = false;
  let unsubscribe: (() => void) | undefined;
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
    clearLocalTimer(connectionTimer);
    rejectConnection(new CognitiveBrowserError(code));
    for (const item of pending.values()) {
      clearLocalTimer(item.timer);
      item.reject(new CognitiveBrowserError(code, commandOf(item.request)));
    }
    pending.clear();
    observers.clear();
    try {
      unsubscribe?.();
    } catch {
      /* Cleanup discloses nothing. */
    }
    try {
      transport.dispose();
    } catch {
      /* A retired document stays retired. */
    }
  }
  function active() {
    if (disposed) return false;
    try {
      transport.check();
      return !disposed;
    } catch {
      retire("disposed");
      return false;
    }
  }
  function settlePending(requestId: string, item: Pending): boolean {
    // Keep this item covered by retire() while cleanup can re-enter author code.
    clearLocalTimer(item.timer);
    const expired = performance.now() >= item.deadline;
    const beforeRemoval = active();
    pending.delete(requestId);
    if (!beforeRemoval || !active()) {
      item.reject(
        new CognitiveBrowserError("disposed", commandOf(item.request)),
      );
      return false;
    }
    if (expired) {
      item.reject(
        new CognitiveBrowserError("timeout", commandOf(item.request)),
      );
      return false;
    }
    return true;
  }
  function publish(next: BrowserContext) {
    if (!active()) return;
    if (context !== null && next.view.revision < context.view.revision) return;
    const changed = context === null || !sameJson(next, context);
    if (!active()) return;
    const frozen = freeze(next);
    if (!active()) return;
    context = frozen;
    if (!changed) return;
    // Notification is UI-only: no operation/read/recovery is triggered here.
    // Isolate author callback failures; never log its potentially private data.
    for (const observer of [...observers]) {
      if (!active()) break;
      try {
        observer(context);
      } catch {
        /* An author UI error grants nothing. */
      }
      if (!active()) break;
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
  function receive(text: string) {
    if (!active()) return;
    let message;
    try {
      message = parseBrowserMessage(JSON.parse(text));
    } catch {
      active();
      return;
    }
    if (!active()) return;
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
      channel = message.channel;
      const frozen = freeze(message.context);
      if (!active()) return;
      context = frozen;
      clearLocalTimer(connectionTimer);
      if (!active()) return;
      resolveConnection(client);
      active();
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
    // Keep even the currently parsing request covered by retire() until settle.
    const rejectItem = (error: CognitiveBrowserError) => {
      if (settlePending(message.requestId, item)) item.reject(error);
    };
    if (performance.now() >= item.deadline) {
      rejectItem(new CognitiveBrowserError("timeout", commandOf(item.request)));
      return;
    }
    if (!message.ok) {
      const original = commandOf(item.request);
      if (
        message.error.commandId !== undefined &&
        message.error.commandId !== original
      ) {
        rejectItem(new CognitiveBrowserError("contract", original));
        return;
      }
      if (!active()) return;
      rejectItem(new CognitiveBrowserError(message.error.code, original));
      return;
    }
    try {
      if (!active()) return;
      const result = parseBrowserResult(
        item.request,
        message.result,
        item.context,
      );
      if (!active()) return;
      if (performance.now() >= item.deadline) {
        rejectItem(
          new CognitiveBrowserError("timeout", commandOf(item.request)),
        );
        return;
      }
      if (item.request.method === "ready") {
        const next = result as BrowserContext;
        if (context === null || !sameBinding(next, context)) {
          retire("disposed");
          return;
        }
        publish(next);
      }
      if (!active()) return;
      if (performance.now() >= item.deadline) {
        rejectItem(
          new CognitiveBrowserError("timeout", commandOf(item.request)),
        );
        return;
      }
      const frozen = freeze(result);
      if (!active()) return;
      if (!settlePending(message.requestId, item)) return;
      item.accept(frozen);
      active();
    } catch {
      if (!active()) return;
      rejectItem(
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
    if (!active() || context === null || channel === null)
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
      if (!active())
        return Promise.reject(new CognitiveBrowserError("disposed"));
      return Promise.reject(
        new CognitiveBrowserError(
          performance.now() >= requestDeadline ? "timeout" : "invalid",
        ),
      );
    }
    if (!active()) return Promise.reject(new CognitiveBrowserError("disposed"));
    if (performance.now() >= requestDeadline)
      return Promise.reject(
        new CognitiveBrowserError("timeout", commandOf(parsed)),
      );
    const requestId = crypto.randomUUID();
    if (!active())
      return Promise.reject(
        new CognitiveBrowserError("disposed", commandOf(parsed)),
      );
    const originalContext = context;
    return new Promise<BrowserResultMap[M]>((accept, reject) => {
      const timer = setTimeout(
        () => {
          const item = pending.get(requestId);
          if (!item) return;
          if (settlePending(requestId, item))
            item.reject(
              new CognitiveBrowserError("timeout", commandOf(parsed)),
            );
        },
        Math.max(0, requestDeadline - performance.now()),
      );
      if (!active()) {
        clearLocalTimer(timer);
        reject(new CognitiveBrowserError("disposed", commandOf(parsed)));
        return;
      }
      if (pending.size >= cognitiveBrowserLimits.pending) {
        clearLocalTimer(timer);
        reject(
          new CognitiveBrowserError(
            active() ? "busy" : "disposed",
            commandOf(parsed),
          ),
        );
        return;
      }
      const item: Pending = {
        request: parsed,
        context: originalContext,
        deadline: requestDeadline,
        timer,
        accept: (value) => accept(value as BrowserResultMap[M]),
        reject,
      };
      pending.set(requestId, item);
      const continuing = () => {
        if (active()) return true;
        // Earlier retirement may predate this item; do not rely on retire twice.
        clearLocalTimer(timer);
        pending.delete(requestId);
        reject(new CognitiveBrowserError("disposed", commandOf(parsed)));
        return false;
      };
      try {
        if (!continuing()) return;
        if (performance.now() >= requestDeadline)
          throw new CognitiveBrowserError("timeout", commandOf(parsed));
        const text = new TextDecoder().decode(
          canonicalJsonBytes({
            type: `${cognitiveBrowserProtocol}:request`,
            channel,
            requestId,
            request: parsed,
          }),
        );
        if (!continuing()) return;
        if (performance.now() >= requestDeadline)
          throw new CognitiveBrowserError("timeout", commandOf(parsed));
        transport.send(text);
        continuing();
      } catch (error) {
        const failure = transportFailure(error);
        if (!continuing() || !settlePending(requestId, item)) return;
        reject(new CognitiveBrowserError(failure, commandOf(parsed)));
      }
    });
  }
  const client: CognitiveBrowserClient = Object.freeze({
    get context() {
      if (!active() || context === null)
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
      if (!active()) throw new CognitiveBrowserError("disposed");
      if (typeof listener !== "function")
        throw new CognitiveBrowserError("invalid");
      if (observers.size >= cognitiveBrowserLimits.pending)
        throw new CognitiveBrowserError("busy");
      const observer = (value: BrowserContext) => listener(value);
      observers.add(observer);
      if (!active()) throw new CognitiveBrowserError("disposed");
      return () => {
        observers.delete(observer);
      };
    },
    dispose: () => retire("disposed"),
  });
  activeConnection = connected;
  activeDocument = active;
  try {
    if (!active()) return connected;
    unsubscribe = transport.subscribe(receive, () => retire("disposed"));
    if (!active()) return connected;
    transport.send(
      JSON.stringify({ type: `${cognitiveBrowserProtocol}:connect` }),
    );
    active();
  } catch {
    retire("disposed");
  }
  return connected;
}
