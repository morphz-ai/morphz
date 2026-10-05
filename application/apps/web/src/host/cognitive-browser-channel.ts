import {
  cognitiveBrowserLimits,
  browserHostErrorCodes,
  parseBrowserContext,
  parseBrowserMessage,
  parseBrowserRequest,
  parseBrowserResult,
  type BrowserContext,
  type BrowserHostErrorCode,
  type BrowserRequest,
} from "../../../../packages/cognitive-app-sdk/src/browser-wire.js";
import { canonicalJsonBytes } from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import { parseWireJson } from "../../../../packages/cognitive-app-sdk/src/protocol.js";

/** The leaf owns only one document's channel, not business authority, storage,
 * resource loading or navigation. Real adapters must authorize the fixed view
 * against the current Human/session/binding before and after each await and
 * honor abort. Schema validation alone never supplies that authority. */
export interface CognitiveBrowserChannelPorts {
  frame: { postMessage(message: unknown, targetOrigin: string): void };
  current(): boolean;
  authorize(context: BrowserContext, signal: AbortSignal): Promise<void>;
  request(
    request: BrowserRequest,
    context: BrowserContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  onRetire?(): void;
}
export type CognitiveBrowserPresentation = Pick<
  BrowserContext,
  "theme" | "presentation"
> & { active: boolean };
type Ingress = { source: unknown; origin: string; data: unknown };
type Pending = {
  requestId: string;
  commandId?: string;
  controller: AbortController;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
};
const equal = (a: unknown, b: unknown) =>
  new TextDecoder().decode(canonicalJsonBytes(a)) ===
  new TextDecoder().decode(canonicalJsonBytes(b));
function commandId(request: BrowserRequest): string | undefined {
  return "commandId" in request && request.commandId !== null
    ? request.commandId
    : undefined;
}
function safeCode(error: unknown): BrowserHostErrorCode {
  try {
    if (error && typeof error === "object") {
      const value = Object.getOwnPropertyDescriptor(error, "code");
      if (
        value &&
        "value" in value &&
        browserHostErrorCodes.includes(value.value)
      )
        return value.value as BrowserHostErrorCode;
    }
  } catch {
    /* Exotic failures cannot escape the finite public error. */
  }
  return "unavailable";
}

export function createCognitiveBrowserChannel(
  initialContext: BrowserContext,
  ports: CognitiveBrowserChannelPorts,
) {
  let context = parseBrowserContext(initialContext);
  const channel = crypto.randomUUID();
  const pending = new Map<string, Pending>();
  // Save requests retain their original deadlines even after visibility or an
  // own CAS advance cancels their replies. One coalesced projection must never
  // authorize a CAS that an admitted save may already have changed.
  const saves = new Set<Pending>();
  let presentation: Pick<BrowserContext, "theme" | "presentation"> | undefined;
  let initializeRequested = false;
  let uncertainSaveRevision = 0;
  const lifecycle = new AbortController();
  let retired = false;
  let loaded = false;
  let connected = false;
  let initialized = false;
  let visibilityEpoch = 0;
  let initializing: Promise<void> | undefined;
  let initTimer: ReturnType<typeof setTimeout> | undefined;

  function post(message: unknown) {
    try {
      // This is one exact opaque-origin frame, never a Window broadcast.
      ports.frame.postMessage(message, "*");
    } catch {
      retire(false);
    }
  }
  function error(item: Pending, code: BrowserHostErrorCode) {
    post({
      type: "morphz-cognitive-ui/v1:response",
      channel,
      requestId: item.requestId,
      ok: false,
      error: { code, ...(item.commandId ? { commandId: item.commandId } : {}) },
    });
  }
  function cancelPending(code: BrowserHostErrorCode) {
    const previous = [...pending.values()];
    pending.clear();
    for (const item of previous) {
      if (!saves.has(item)) clearTimeout(item.timer);
      item.controller.abort();
      error(item, code);
    }
  }
  function retire(notify = true) {
    if (retired) return;
    retired = true;
    presentation = undefined;
    initializeRequested = false;
    clearTimeout(initTimer);
    initTimer = undefined;
    lifecycle.abort();
    if (notify) cancelPending("unavailable");
    else {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.controller.abort();
      }
      pending.clear();
    }
    for (const item of saves) {
      clearTimeout(item.timer);
      item.controller.abort();
    }
    saves.clear();
    if (notify && initialized)
      post({ type: "morphz-cognitive-ui/v1:retire", channel });
    try {
      ports.onRetire?.();
    } catch {
      /* Trusted owner cleanup cannot disclose a cause or revive the channel. */
    }
  }
  function current() {
    if (retired) return false;
    let active = false;
    try {
      active = ports.current();
    } catch {
      /* Retire without exposing cause. */
    }
    if (!active) {
      retire();
      return false;
    }
    return true;
  }
  async function initialize() {
    if (!loaded || !connected || !current()) return;
    if (initializing) return initializing;
    if (saves.size) {
      initializeRequested = true;
      return;
    }
    initializeRequested = false;
    const deadline = performance.now() + cognitiveBrowserLimits.deadlineMs;
    const timer = setTimeout(() => retire(), cognitiveBrowserLimits.deadlineMs);
    initTimer = timer;
    initializing = (async () => {
      try {
        while (current()) {
          const start = context;
          await ports.authorize(start, lifecycle.signal);
          if (!current()) return;
          if (performance.now() >= deadline) return retire();
          // A concurrent trusted update must cross its own actual gate before
          // being published. Never authorize C1 and send unverified C2.
          if (!equal(start, context)) {
            if (saves.size) {
              initializeRequested = true;
              return;
            }
            continue;
          }
          if (performance.now() >= deadline) return retire();
          initialized = true;
          post({
            type: "morphz-cognitive-ui/v1:init",
            channel,
            context: start,
          });
          return;
        }
      } catch {
        retire();
      } finally {
        clearTimeout(timer);
        if (initTimer === timer) initTimer = undefined;
        initializing = undefined;
      }
    })();
    return initializing;
  }

  async function updateContext(input: BrowserContext) {
    if (!current()) return;
    let next: BrowserContext;
    try {
      next = parseBrowserContext(input);
    } catch {
      return retire();
    }
    if (
      !equal(next.authority, context.authority) ||
      !equal(next.definition, context.definition) ||
      next.view.id !== context.view.id ||
      next.view.bindingRevision !== context.view.bindingRevision ||
      next.view.revision < context.view.revision ||
      (next.view.revision === context.view.revision &&
        !equal(next.view.state, context.view.state))
    )
      return retire();
    if (next.view.revision !== context.view.revision) cancelPending("conflict");
    if (next.view.active !== context.view.active) {
      visibilityEpoch++;
      cancelPending("forbidden");
    }
    context = next;
    await initialize();
  }
  async function releasePresentation() {
    if (saves.size || retired || (!presentation && !initializeRequested))
      return;
    // An unacknowledged mutation is not proof that its old CAS survived. Do
    // not refresh using a guessed latest revision or silently resend the save.
    if (uncertainSaveRevision >= context.view.revision) return retire();
    const latest = presentation;
    presentation = undefined;
    if (latest) {
      const next = parseBrowserContext({ ...context, ...latest });
      if (!equal(next, context)) return updateContext(next);
    }
    if (initializeRequested) await initialize();
  }
  return {
    /** A second document load retires the original channel. This detects a
     * completed navigation; it does not claim to prevent network navigation. */
    async loaded() {
      if (loaded) return retire();
      loaded = true;
      await initialize();
    },
    updateContext,
    /** Trusted presentation only. Merge the latest private acknowledged CAS,
     * never a caller's initial source snapshot or a replacement view state. */
    async updatePresentation(input: CognitiveBrowserPresentation) {
      if (!current()) return;
      let next: BrowserContext;
      try {
        const value = parseWireJson(input);
        if (!value || typeof value !== "object" || Array.isArray(value))
          return retire();
        const fields = Object.getOwnPropertyDescriptors(value);
        if (
          Reflect.ownKeys(fields).length !== 3 ||
          !fields.theme ||
          !fields.presentation ||
          !fields.active
        )
          return retire();
        next = parseBrowserContext({
          ...context,
          theme: fields.theme.value,
          presentation: fields.presentation.value,
          view: { ...context.view, active: fields.active.value },
        });
      } catch {
        return retire();
      }
      if (equal(next, context) && !presentation) return;
      if (saves.size) {
        // Only trusted presentation is coalesced. Visibility is restricted
        // synchronously and cannot keep old requests alive behind this buffer.
        presentation = {
          theme: next.theme,
          presentation: next.presentation,
        };
        if (next.view.active !== context.view.active) {
          visibilityEpoch++;
          cancelPending("forbidden");
          context = parseBrowserContext({
            ...context,
            view: { ...context.view, active: next.view.active },
          });
          initializeRequested = true;
        }
        return;
      }
      await updateContext(next);
    },
    async receive(event: Ingress) {
      // Check the exact source before inspecting untrusted message bytes.
      if (event.source !== ports.frame || event.origin !== "null" || !current())
        return;
      let message: ReturnType<typeof parseBrowserMessage>;
      try {
        message = parseBrowserMessage(event.data);
      } catch {
        return;
      }
      if (message.type === "morphz-cognitive-ui/v1:connect") {
        connected = true;
        await initialize();
        return;
      }
      if (
        !initialized ||
        message.type !== "morphz-cognitive-ui/v1:request" ||
        message.channel !== channel ||
        pending.has(message.requestId)
      )
        return;
      const originalId = commandId(message.request);
      const item: Pending = {
        requestId: message.requestId,
        ...(originalId ? { commandId: originalId } : {}),
        controller: new AbortController(),
        deadline: performance.now() + cognitiveBrowserLimits.deadlineMs,
      };
      let request: BrowserRequest;
      const start = context;
      try {
        request = parseBrowserRequest(message.request, start);
      } catch {
        error(item, "invalid");
        return;
      }
      if (
        !start.view.active ||
        (request.method === "compose" && !start.ui.compose)
      ) {
        error(item, "forbidden");
        return;
      }
      let occupied = pending.size;
      for (const save of saves)
        if (pending.get(save.requestId) !== save) occupied++;
      if (occupied >= cognitiveBrowserLimits.pending) {
        error(item, "busy");
        return;
      }
      // One expired request retires this document. Aborting is not evidence of
      // rollback, and the leaf never dispatches an automatic replacement write.
      item.timer = setTimeout(
        () => retire(),
        Math.max(0, Math.ceil(item.deadline - performance.now())),
      );
      pending.set(item.requestId, item);
      const saveRevision =
        request.method === "saveState" ? request.expectedRevision : null;
      const earlierInitialization = initializing;
      if (saveRevision !== null) saves.add(item);
      let mutationStarted = false;
      let saveAcknowledged = false;
      const startVisibility = visibilityEpoch;
      const stillPending = () => {
        if (!current()) return false;
        if (performance.now() >= item.deadline) {
          retire();
          return false;
        }
        return (
          pending.get(item.requestId) === item &&
          startVisibility === visibilityEpoch &&
          context.view.revision === start.view.revision &&
          context.view.active
        );
      };
      try {
        // A gate already reading the old CAS must complete before this save
        // can mutate it. Later presentation requests wait behind the save,
        // while the existing initialization never waits on itself.
        if (saveRevision !== null && earlierInitialization) {
          await earlierInitialization;
          if (!stillPending()) return;
        }
        await ports.authorize(start, item.controller.signal);
        if (!stillPending()) return;
        mutationStarted = saveRevision !== null;
        const raw = await ports.request(request, start, item.controller.signal);
        if (!stillPending()) return;
        let result: ReturnType<typeof parseBrowserResult>;
        let end = start;
        try {
          result = parseBrowserResult(request, raw, start);
          if (request.method === "saveState") {
            const saved = parseBrowserResult(request, raw, start);
            end = parseBrowserContext({
              ...start,
              view: {
                ...start.view,
                revision: saved.revision,
                state: saved.state,
              },
            });
          }
        } catch {
          throw { code: "contract" };
        }
        // A save authorizes its exact acknowledged CAS, not a later "latest"
        // read. All other results retain the original view premise.
        await ports.authorize(end, item.controller.signal);
        if (!stillPending()) return;
        pending.delete(item.requestId);
        clearTimeout(item.timer);
        if (request.method === "saveState") {
          cancelPending("conflict");
          context = parseBrowserContext({ ...context, view: end.view });
          saveAcknowledged = true;
        }
        post({
          type: "morphz-cognitive-ui/v1:response",
          channel,
          requestId: item.requestId,
          ok: true,
          result,
        });
        if (request.method === "saveState" && current())
          post({ type: "morphz-cognitive-ui/v1:init", channel, context });
      } catch (failure) {
        if (stillPending()) {
          pending.delete(item.requestId);
          error(item, safeCode(failure));
        }
      } finally {
        clearTimeout(item.timer);
        if (pending.get(item.requestId) === item)
          pending.delete(item.requestId);
        if (saveRevision !== null) {
          saves.delete(item);
          if (mutationStarted && !saveAcknowledged)
            uncertainSaveRevision = Math.max(
              uncertainSaveRevision,
              saveRevision,
            );
          await releasePresentation();
        }
      }
    },
    retire() {
      retire();
    },
  };
}
