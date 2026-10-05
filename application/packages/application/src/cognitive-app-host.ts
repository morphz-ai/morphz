import type { PlatformActor } from "../../platform/src/store.js";
import {
  parseCognitiveAppRequest,
  type CognitiveAppRequestMap,
} from "../../core/src/cognitive-app-api.js";
import {
  CognitiveAppBindings,
  CognitiveAppBindingsError,
} from "./cognitive-app-bindings.js";
import { CognitiveAppTransport } from "./cognitive-app-transport.js";
import { createCognitiveAppGateway } from "./cognitive-app-gateway.js";
import {
  createCognitiveAppService,
  CognitiveAppServiceError,
  type CognitiveAppService,
  type CognitiveAppServicePlatform,
} from "./cognitive-app-service.js";
import {
  createCognitiveAppRecovery,
  type CognitiveAppRecoveryWake,
} from "./cognitive-app-recovery.js";
import type { UiPackageService } from "./ui-package-service.js";

/** Trusted Host operator input. Never exposed through a public request/schema. */
export type CognitiveAppHostOptions = {
  bindingsFile: string;
  secrets?: (name: string) => string | undefined;
  /** Only the transport's fixed public-HTTPS policy exists in production v1.
   * An explicit per-entry numeric sample exception remains resolver-owned. */
  egress?: "public-https";
};

/** One shared instance per opened Host. No Runtime is captured here: the real
 * Platform verifier remains responsible for current Human/Agent authority.
 */
export function createCognitiveAppHost(options: {
  tenantId: string;
  platform: CognitiveAppServicePlatform;
  uiPackages?: UiPackageService;
  config?: CognitiveAppHostOptions;
}) {
  const unavailable = () => {
    throw new CognitiveAppBindingsError();
  };
  let bindings: Pick<
    CognitiveAppBindings,
    "prepareConnection" | "resolveConnection" | "resolveReceipt"
  >;
  try {
    if (
      options.config?.egress !== undefined &&
      options.config.egress !== "public-https"
    )
      unavailable();
    bindings = options.config
      ? new CognitiveAppBindings({
          filename: options.config.bindingsFile,
          ...(options.config.secrets
            ? { readSecret: options.config.secrets }
            : {}),
        })
      : {
          prepareConnection: unavailable,
          resolveConnection: unavailable,
          resolveReceipt: unavailable,
        };
  } catch {
    throw new CognitiveAppServiceError("unavailable");
  }
  const abort = new AbortController();
  let closed = false,
    closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const recovering = new Map<
    string,
    ReturnType<ReturnType<typeof createCognitiveAppGateway>["recoverCommand"]>
  >();
  function track<T>(work: () => Promise<T>, commandId?: string): Promise<T> {
    if (closed)
      return Promise.reject(
        new CognitiveAppServiceError("unavailable", commandId),
      );
    // Invoke synchronously: original public ingress snapshots its input before
    // caller mutation, not in a deferred then() introduced by this wrapper.
    let task: Promise<T>;
    try {
      task = work();
    } catch (error) {
      return Promise.reject(error);
    }
    const observed = task.then((value) => {
      if (closed) throw new CognitiveAppServiceError("unavailable", commandId);
      return value;
    });
    pending.add(observed);
    void observed
      .finally(() => pending.delete(observed))
      .catch(() => undefined);
    return observed;
  }
  const signal = (incoming?: AbortSignal) =>
    incoming ? AbortSignal.any([incoming, abort.signal]) : abort.signal;
  function follow<T>(task: Promise<T>, incoming?: AbortSignal): Promise<T> {
    if (!incoming) return task;
    // A short background deadline may join an already-started explicit read.
    // Stop waiting at its own deadline without pretending to cancel that read.
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => {
        incoming.removeEventListener("abort", cancelled);
        reject(new CognitiveAppServiceError("unavailable"));
      };
      incoming.addEventListener("abort", cancelled, { once: true });
      if (incoming.aborted) {
        cancelled();
        return;
      }
      void task.then(
        (value) => {
          incoming.removeEventListener("abort", cancelled);
          resolve(value);
        },
        (error) => {
          incoming.removeEventListener("abort", cancelled);
          reject(error);
        },
      );
    });
  }
  const gateway = createCognitiveAppGateway({
    platform: options.platform,
    bindings,
    transport: new CognitiveAppTransport(),
  });
  const settled = (
    result: Awaited<ReturnType<typeof gateway.recoverCommand>>,
  ) => {
    if (
      result.command.state === "committed" ||
      result.command.state === "rejected"
    )
      recovery.wake("projection");
    return result;
  };
  const managedGateway: typeof gateway = {
    ...gateway,
    connect: (actor, input, incoming) =>
      track(() => gateway.connect(actor, input, signal(incoming))),
    invoke: (actor, input, incoming) =>
      track(async () => {
        const result = await gateway.invoke(actor, input, signal(incoming));
        if (result.kind === "command") settled(result);
        return result;
      }),
    readObject: (actor, input, incoming) =>
      track(() => gateway.readObject(actor, input, signal(incoming))),
    recoverCommand: (input, incoming) => {
      const key = JSON.stringify([input.tenantId, input.commandId]);
      const previous = recovering.get(key);
      if (previous) return follow(previous, incoming);
      const task = track(async () =>
        settled(await gateway.recoverCommand(input, signal(incoming))),
      );
      recovering.set(key, task);
      void task
        .finally(() => {
          if (recovering.get(key) === task) recovering.delete(key);
        })
        .catch(() => undefined);
      return task;
    },
  };
  const recovery = createCognitiveAppRecovery({
    tenantId: options.tenantId,
    platform: options.platform,
    gateway: managedGateway,
    source: options.platform.changeSource(),
  });
  const original = createCognitiveAppService({
    platform: options.platform,
    gateway: managedGateway,
    ...(options.uiPackages ? { uiPackages: options.uiPackages } : {}),
  });
  function call<K extends keyof CognitiveAppService>(
    method: K,
    actor: PlatformActor,
    input: unknown,
  ): ReturnType<CognitiveAppService[K]> {
    let request: CognitiveAppRequestMap[K];
    try {
      request = parseCognitiveAppRequest(method, input);
    } catch {
      return Promise.reject(
        new CognitiveAppServiceError("invalid"),
      ) as ReturnType<CognitiveAppService[K]>;
    }
    // Only the existing strict parser's independent JSON snapshot can supply
    // uncertainty identity, including immediate/late Host-closing rejection.
    const commandId =
      "commandId" in request && typeof request.commandId === "string"
        ? request.commandId
        : undefined;
    return track<unknown>(
      () => original[method](actor, request),
      commandId,
    ) as ReturnType<CognitiveAppService[K]>;
  }
  const service: CognitiveAppService = {
    ...original,
    list: (actor, input) => call("list", actor, input),
    describe: (actor, input) => call("describe", actor, input),
    install: (actor, input) => call("install", actor, input),
    grant: (actor, input) => call("grant", actor, input),
    connect: async (actor, input) => {
      const connection = await call("connect", actor, input);
      recovery.wake("connected");
      return connection;
    },
    connectionState: async (actor, input) => {
      const connection = await call("connectionState", actor, input);
      if (connection.state === "active") recovery.wake("connected");
      return connection;
    },
    invoke: (actor, input) => call("invoke", actor, input),
    readObject: (actor, input) => call("readObject", actor, input),
    commandStatus: (actor, input) => call("commandStatus", actor, input),
    recover: (actor, input) => call("recover", actor, input),
  };
  return {
    service,
    start: () => recovery.start(),
    /** Host-only lifecycle trigger. Public explicit recovery stays scoped to
     * its already-authorized original command through Service.recover. */
    wake: (reason: CognitiveAppRecoveryWake) => {
      if (!closed) recovery.wake(reason);
    },
    whenIdle: () => recovery.whenIdle(),
    close() {
      return (closing ??= (async () => {
        closed = true;
        abort.abort();
        await recovery.close();
        // Await storage/late disclosure gates as well as sockets. A network
        // deadline is not permission to close SQL under a receipt transaction.
        while (pending.size) await Promise.allSettled([...pending]);
      })());
    },
  };
}
