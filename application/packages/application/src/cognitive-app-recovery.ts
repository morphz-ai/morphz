import {
  observeSqlChanges,
  type SqlChangeSource,
  type SqlChangeSubscription,
} from "../../storage/src/commit-notifications.js";

type Page = { tenantId: string; limit: number; afterCommandId?: string };
export type CognitiveAppRecoveryWake =
  "startup" | "connected" | "retry" | "projection";
export type CognitiveAppRecoveryPorts = {
  platform: {
    listRecoverableCognitiveAppCommands(
      page: Page,
    ): Promise<readonly { commandId: string; connectionId: string }[]>;
  };
  gateway: {
    recoverCommand(
      input: { tenantId: string; commandId: string },
      signal?: AbortSignal,
    ): Promise<unknown>;
    projectPending(page: Page): Promise<readonly { commandId: string }[]>;
  };
};

/** Host-owned compensator, not a task scheduler or a public recovery API.
 * A storage hint can only project already verified committed facts. It never
 * reads unknown receipts or retries invoke, including our own unknown writes.
 */
export function createCognitiveAppRecovery(
  options: CognitiveAppRecoveryPorts & {
    tenantId: string;
    source?: SqlChangeSource;
    /** Trusted tests may shorten, never extend, the fixed production budget. */
    deadlineMs?: number;
  },
) {
  const deadlineMs = options.deadlineMs ?? 10_000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10_000)
    throw new Error("应用恢复预算无效。");
  let started = false,
    closed = false,
    projectDirty = false,
    networkDirty = false;
  let networkCursor: string | undefined, projectionCursor: string | undefined;
  let subscription: SqlChangeSubscription | undefined;
  let initialization: Promise<void> | undefined,
    draining: Promise<void> | undefined;
  let round: AbortController | undefined, closing: Promise<void> | undefined;

  async function pass(network: boolean) {
    const controller = new AbortController();
    round = controller;
    const until = performance.now() + deadlineMs;
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const active = () =>
      !closed && !controller.signal.aborted && performance.now() < until;
    try {
      // A bounded cursor survives later wakes. Failed earlier objects cannot
      // starve a later page; references and revisions remain in the real ledger.
      for (let page = 0; page < 4 && active(); page++) {
        let results: readonly { commandId: string }[];
        try {
          results = await options.gateway.projectPending({
            tenantId: options.tenantId,
            limit: 32,
            ...(projectionCursor ? { afterCommandId: projectionCursor } : {}),
          });
        } catch {
          break;
        }
        if (results.length > 32) break;
        if (results.length) projectionCursor = results.at(-1)!.commandId;
        if (results.length < 32) {
          projectionCursor = undefined;
          break;
        }
      }
      if (!network || !active()) return;
      let commands: readonly { commandId: string; connectionId: string }[];
      try {
        commands = await options.platform.listRecoverableCognitiveAppCommands({
          tenantId: options.tenantId,
          limit: 8,
          ...(networkCursor ? { afterCommandId: networkCursor } : {}),
        });
      } catch {
        return;
      }
      if (commands.length > 8) return;
      let next = 0;
      const work = async () => {
        while (next < commands.length && active()) {
          const command = commands[next++]!;
          networkCursor = command.commandId;
          try {
            await options.gateway.recoverCommand(
              { tenantId: options.tenantId, commandId: command.commandId },
              controller.signal,
            );
          } catch {
            /* The persisted command remains the recovery authority. */
          }
        }
      };
      await Promise.all([work(), work()]);
      if (commands.length < 8 && next === commands.length)
        networkCursor = undefined;
    } finally {
      clearTimeout(timer);
      if (round === controller) round = undefined;
    }
  }
  function drain() {
    if (!started || closed || draining || !projectDirty) return;
    const network = networkDirty;
    projectDirty = networkDirty = false;
    draining = pass(network)
      .catch(() => undefined)
      .finally(() => {
        draining = undefined;
        // Only another real wake grants another round. No healthy timer, retry
        // delay or an unresolved command itself schedules additional network work.
        if (projectDirty && !closed) drain();
      });
  }
  function wake(reason: CognitiveAppRecoveryWake) {
    if (closed) return;
    projectDirty = true;
    if (reason !== "projection") networkDirty = true;
    drain();
  }
  return {
    start() {
      if (started || closed) return;
      started = true;
      if (options.source) {
        subscription = observeSqlChanges(options.source, () =>
          wake("projection"),
        );
        // Subscribe before startup reconciliation; failure/readiness does not
        // block opening other Host domains, and close remains cancellable.
        initialization = subscription.ready.then(() => {
          if (!closed) wake("startup");
        });
      } else wake("startup");
    },
    wake,
    /** Host/test lifecycle await, never registered as Client/Agent/iframe API. */
    async whenIdle() {
      await initialization;
      while (draining) await draining;
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        projectDirty = networkDirty = false;
        round?.abort();
        await subscription?.close();
        await initialization;
        await draining;
      })());
    },
  };
}
