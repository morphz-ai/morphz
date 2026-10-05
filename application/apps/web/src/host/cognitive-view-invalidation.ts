import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
  type CognitiveAppViewLocation,
  type CognitiveAppViewRequestMap,
  type CognitiveAppViewUi,
} from "../../../../packages/core/src/cognitive-app-view-api.js";

const DEADLINE_MS = 30_000;
export type CognitiveViewInvalidation =
  | Readonly<{
      status: "absent" | "closed" | "unbound";
      location: CognitiveAppViewLocation;
    }>
  | Readonly<{ status: "error"; message: string }>;
type Timing = {
  now(): number;
  deadline(callback: () => void, milliseconds: number): () => void;
};
const nativeTiming: Timing = {
  now: () => performance.now(),
  deadline(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}
const changed = "应用窗口或保存方已有变化，请重新打开。";

/** Event-only metadata reconciliation, not permission, a save acknowledgement,
 * or a new source/CAS. One actual read and one latest dirty token are retained;
 * no polling, body/UI read, mutation, queue, or failure retry exists here. */
export function createCognitiveViewInvalidation({
  slot: raw,
  source,
  current,
  locate,
  onRetire,
  timing = nativeTiming,
}: {
  slot: CognitiveAppViewRequestMap["locate"];
  /** Already admitted immutable readUi from this exact captured private owner. */
  source: CognitiveAppViewUi;
  current(): boolean;
  locate(
    slot: CognitiveAppViewRequestMap["locate"],
    signal: AbortSignal,
  ): Promise<unknown>;
  onRetire(value: CognitiveViewInvalidation): void;
  /** Finite UNIT scheduler only; production uses the fixed native 30s budget. */
  timing?: Timing;
}) {
  const slot = freeze(parseCognitiveAppViewRequest("locate", raw));
  // Capture only scalar metadata. Never copy or inspect HTML/state/body here.
  const initial = freeze(
    parseCognitiveAppViewResponse("locate", {
      slot: {
        projectId: source.binding.projectId,
        appId: source.authority.appId,
        version: source.authority.version,
        definitionHash: source.authority.definitionHash,
      },
      view: {
        viewId: source.view.id,
        viewRevision: source.view.revision,
        status: source.view.status,
        binding: {
          bindingRevision: source.binding.revision,
          connectionId: source.binding.connectionId,
          instanceId: source.authority.instanceId,
          serviceId: source.authority.serviceId,
          dataAuthorityId: source.authority.dataAuthorityId,
        },
      },
    }),
  );
  function exactSlot(location: CognitiveAppViewLocation) {
    return (
      location.slot.projectId === slot.projectId &&
      location.slot.appId === slot.appId &&
      location.slot.version === slot.version &&
      location.slot.definitionHash === slot.expectedDefinitionHash
    );
  }
  if (
    !exactSlot(initial) ||
    initial.view?.status !== "open" ||
    !initial.view.binding ||
    source.view.workspaceId !== slot.projectId ||
    source.view.applicationId !== slot.appId ||
    source.view.applicationVersion !== slot.version ||
    source.binding.viewId !== source.view.id ||
    source.binding.appId !== slot.appId ||
    source.binding.version !== slot.version ||
    source.binding.viewRevision !== source.view.revision ||
    source.binding.instanceId !== source.authority.instanceId ||
    source.binding.serviceId !== source.authority.serviceId ||
    source.binding.dataAuthorityId !== source.authority.dataAuthorityId
  )
    throw Error(changed);
  const fixed = initial.view;
  const bound = (() => {
    const binding = fixed.binding;
    if (!binding) throw Error(changed);
    return binding;
  })();
  let live = true,
    latest = -1;
  type Flight = {
    token: number;
    abort: AbortController;
    expiresAt: number;
    clear(): void;
  };
  let flight: Flight | null = null;
  function dispose() {
    if (!live) return;
    live = false;
    const old = flight;
    flight = null;
    old?.clear();
    old?.abort.abort();
  }
  function owned() {
    if (!live) return false;
    try {
      if (current() && live) return true;
    } catch {
      // Loss of the captured private owner is terminal, not a retry premise.
    }
    dispose();
    return false;
  }
  function retire(value: CognitiveViewInvalidation) {
    if (!owned()) return;
    dispose();
    onRetire(freeze(value));
  }
  function start() {
    if (!owned() || flight || latest < 0) return;
    const task: Flight = {
      token: latest,
      abort: new AbortController(),
      expiresAt: timing.now() + DEADLINE_MS,
      clear: () => {},
    };
    flight = task;
    task.clear = timing.deadline(() => {
      if (flight === task && owned())
        retire({ status: "error", message: "应用窗口状态核验超时，请重试。" });
    }, DEADLINE_MS);
    // Capture this task's immutable slot, owner, deadline and cancellation.
    // A transport ignoring abort cannot publish or schedule a successor later.
    void Promise.resolve()
      .then(() => {
        if (!owned() || flight !== task || task.abort.signal.aborted)
          throw Error("Retired metadata read");
        return locate(slot, task.abort.signal);
      })
      .then(
        (raw) => {
          if (!owned() || flight !== task || task.abort.signal.aborted) return;
          if (timing.now() >= task.expiresAt)
            return retire({
              status: "error",
              message: "应用窗口状态核验超时，请重试。",
            });
          task.clear();
          flight = null;
          if (task.token !== latest) {
            // Only a new real invalidation requests this one successor. The
            // superseded reply is never used to publish or retire an owner.
            start();
            return;
          }
          try {
            const location = freeze(
              parseCognitiveAppViewResponse("locate", raw),
            );
            if (!exactSlot(location)) throw Error(changed);
            const view = location.view;
            if (!view) return retire({ status: "absent", location });
            if (
              view.viewId !== fixed.viewId ||
              view.viewRevision < fixed.viewRevision
            )
              throw Error(changed);
            if (view.status === "closed")
              return retire({ status: "closed", location });
            const binding = view.binding;
            if (!binding) return retire({ status: "unbound", location });
            if (
              binding.bindingRevision !== bound.bindingRevision ||
              binding.connectionId !== bound.connectionId ||
              binding.instanceId !== bound.instanceId ||
              binding.serviceId !== bound.serviceId ||
              binding.dataAuthorityId !== bound.dataAuthorityId
            )
              throw Error(changed);
            // A matching higher revision may be this Document's real save.
            // Keep its exact source/lease warm; never manufacture that ACK or
            // push a metadata revision/state into the channel or renderer.
          } catch {
            retire({ status: "error", message: changed });
          }
        },
        () => {
          if (owned() && flight === task && !task.abort.signal.aborted)
            retire({
              status: "error",
              message: "应用窗口状态无法核验，请重新打开。",
            });
        },
      );
  }
  return Object.freeze({
    invalidate(token: number) {
      if (!owned()) return;
      if (!Number.isSafeInteger(token) || token < 0) {
        retire({ status: "error", message: changed });
        return;
      }
      if (token <= latest) return;
      latest = token;
      if (!flight) start();
    },
    dispose,
  });
}
