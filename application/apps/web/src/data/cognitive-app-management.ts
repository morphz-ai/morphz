import { ApplicationRequestError } from "../../../../packages/core/src/application-api.js";
import {
  parseCognitiveAppRequest,
  type CognitiveAppRegisteredDescriptionDto,
  type CognitiveAppRequestMap,
  type CognitiveAppResponseMap,
} from "../../../../packages/core/src/cognitive-app-api.js";
import type { PlatformClient } from "../platform-client.js";

export type CognitiveAppManagementIdentity = {
  centerId: string;
  principalId: string;
  csrfToken: string;
};
type Source = {
  readonly boot: CognitiveAppManagementIdentity;
  readonly cognitiveApps: Pick<PlatformClient["cognitiveApps"], "call">;
};
export type CognitiveAppManagementPorts = {
  current: { readonly current: CognitiveAppManagementIdentity | null };
  platform: { readonly current: Source | null };
  protectedReadGeneration: { readonly current: number };
  isMounted: () => boolean;
  refreshAfterMutation: () => Promise<boolean>;
};
export type CognitiveAppManagementAcknowledgement<T> = {
  value: T;
  refreshed: boolean;
};
type ManagementDescriptionRequest = Extract<
  CognitiveAppRequestMap["describe"],
  { mode: "registered-management" }
>;
type Mutation = "install" | "grant" | "connect" | "connectionState";
type Method = Mutation | "describe";

/** Local presentation budgets, not Host concurrency or transaction guarantees. */
export const cognitiveAppManagementLimits = Object.freeze({
  pending: 4,
  timeoutMs: 30000,
});
type Lease = {
  kind: "read" | "write";
  identity: string;
  identityEpoch: number;
  accessEpoch: number;
  generation: number;
  deadline: number;
  commandId?: string;
  writeKey?: string;
  controller: AbortController;
};
const fingerprint = (value: CognitiveAppManagementIdentity) =>
  JSON.stringify([value.centerId, value.principalId, value.csrfToken]);
const cancelled = (commandId?: string) =>
  new ApplicationRequestError(
    408,
    "请求已取消；已提交的操作不会回滚，请核对原操作。",
    "cancelled",
    commandId,
  );
const unavailable = (commandId?: string) =>
  new ApplicationRequestError(
    503,
    "当前身份尚未就绪，请重新读取应用目录。",
    "unavailable",
    commandId,
  );

/** Borrow the authenticated Client and its refresh owner. Construction reads
 * no refs and performs no IO. Observed identity and leases only fence local
 * disclosure/cancellation; the actual Human service remains policy authority.
 */
export function createCognitiveAppManagement(
  options: CognitiveAppManagementPorts,
) {
  let observed: string | null = null;
  let identityEpoch = 0;
  let accessEpoch = 0;
  const leases = new Set<Lease>();
  const writes = new Set<string>();

  function retireIdentity() {
    identityEpoch++;
    observed = null;
    for (const lease of leases) lease.controller.abort();
  }
  function observeIdentity(value: CognitiveAppManagementIdentity) {
    const next = fingerprint(value);
    if (observed === next) return;
    retireIdentity();
    observed = next;
  }
  function invalidateAccess() {
    accessEpoch++;
    for (const lease of leases)
      if (lease.kind === "read") lease.controller.abort();
  }
  function sameIdentity(lease: Lease) {
    if (
      !options.isMounted() ||
      lease.identityEpoch !== identityEpoch ||
      observed !== lease.identity
    )
      return false;
    // A write may itself clear protected projection. Null refs do not replace
    // its captured caller, but any actual nonnull identity replacement fences it.
    const current = options.current.current;
    const source = options.platform.current;
    return (
      (!current || fingerprint(current) === lease.identity) &&
      (!source || fingerprint(source.boot) === lease.identity)
    );
  }
  function alive(lease: Lease) {
    if (!sameIdentity(lease)) return false;
    return (
      lease.kind === "write" ||
      (lease.accessEpoch === accessEpoch &&
        lease.generation === options.protectedReadGeneration.current &&
        options.current.current !== null &&
        options.platform.current !== null)
    );
  }
  function check(lease: Lease) {
    if (!alive(lease) || performance.now() >= lease.deadline)
      lease.controller.abort();
    if (lease.controller.signal.aborted) throw cancelled(lease.commandId);
  }
  function wait<T>(lease: Lease, action: () => Promise<T>): Promise<T> {
    check(lease);
    // Also bound a transport/refresh that ignores AbortSignal. Detached late
    // completion cannot publish, release a newer lease or initiate any retry.
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (done: () => void) => {
        if (settled) return;
        settled = true;
        lease.controller.signal.removeEventListener("abort", abort);
        done();
      };
      const abort = () => finish(() => reject(cancelled(lease.commandId)));
      lease.controller.signal.addEventListener("abort", abort, { once: true });
      if (lease.controller.signal.aborted) return abort();
      try {
        Promise.resolve(action()).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  function run(
    method: "describe",
    input: ManagementDescriptionRequest,
    signal?: AbortSignal,
  ): Promise<CognitiveAppRegisteredDescriptionDto>;
  function run<M extends Mutation>(
    method: M,
    input: CognitiveAppRequestMap[M],
    signal?: AbortSignal,
  ): Promise<CognitiveAppManagementAcknowledgement<CognitiveAppResponseMap[M]>>;
  async function run(
    method: Method,
    input: CognitiveAppRequestMap[Method],
    signal?: AbortSignal,
  ): Promise<
    | CognitiveAppRegisteredDescriptionDto
    | CognitiveAppManagementAcknowledgement<CognitiveAppResponseMap[Mutation]>
  > {
    // Include synchronous own-data parsing in the single absolute deadline.
    const deadline = performance.now() + cognitiveAppManagementLimits.timeoutMs;
    let request: CognitiveAppRequestMap[Method];
    try {
      request = parseCognitiveAppRequest(method, input);
      if (method === "describe" && !("mode" in request))
        throw new Error("Not a registered-management preview.");
    } catch {
      throw new ApplicationRequestError(400, "请求格式无效。", "invalid");
    }
    const commandId = "commandId" in request ? request.commandId : undefined;
    if (signal?.aborted || performance.now() >= deadline)
      throw cancelled(commandId);
    const current = options.current.current;
    const source = options.platform.current;
    if (
      !options.isMounted() ||
      !current ||
      !source ||
      fingerprint(current) !== observed ||
      fingerprint(source.boot) !== observed
    )
      throw unavailable(commandId);
    const kind = method === "describe" ? "read" : "write";
    const writeKey =
      kind === "read"
        ? undefined
        : JSON.stringify(
            "definition" in request
              ? [request.definition.id, request.definition.version]
              : [request.appId, request.version],
          );
    if (
      leases.size >= cognitiveAppManagementLimits.pending ||
      (writeKey !== undefined && writes.has(writeKey))
    )
      throw new ApplicationRequestError(
        409,
        "应用管理操作尚未完成，请先核对原操作。",
        "conflict",
        commandId,
      );
    const lease: Lease = {
      kind,
      identity: observed!,
      identityEpoch,
      accessEpoch,
      generation: options.protectedReadGeneration.current,
      deadline,
      commandId,
      writeKey,
      controller: new AbortController(),
    };
    leases.add(lease);
    if (writeKey !== undefined) writes.add(writeKey);
    const abort = () => lease.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
    try {
      if (signal?.aborted) abort();
      const value = await wait(lease, () =>
        source.cognitiveApps.call(method, request, lease.controller.signal),
      );
      check(lease);
      if (method === "describe") {
        // The typed facade enforces mode and exact requested definition/hash.
        if (!("mode" in value))
          throw new ApplicationRequestError(
            503,
            "应用响应格式无效。",
            "contract",
          );
        return value;
      }
      if ("definition" in value)
        throw new ApplicationRequestError(
          503,
          "应用响应格式无效。",
          "contract",
          commandId,
        );
      // Only a parsed authentic ACK enters this branch. Refresh is not a
      // second write; failure/cancellation after ACK never makes it "unsent".
      let refreshed = false;
      try {
        refreshed = await wait(lease, options.refreshAfterMutation);
        check(lease);
      } catch {
        refreshed = false;
      }
      if (signal?.aborted || !sameIdentity(lease)) throw cancelled(commandId);
      return { value, refreshed };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      leases.delete(lease);
      if (writeKey !== undefined) writes.delete(writeKey);
    }
  }

  return {
    operations: {
      describeRegistered: (
        input: ManagementDescriptionRequest,
        signal?: AbortSignal,
      ) => run("describe", input, signal),
      install: (
        input: CognitiveAppRequestMap["install"],
        signal?: AbortSignal,
      ) => run("install", input, signal),
      grant: (input: CognitiveAppRequestMap["grant"], signal?: AbortSignal) =>
        run("grant", input, signal),
      connect: (
        input: CognitiveAppRequestMap["connect"],
        signal?: AbortSignal,
      ) => run("connect", input, signal),
      connectionState: (
        input: CognitiveAppRequestMap["connectionState"],
        signal?: AbortSignal,
      ) => run("connectionState", input, signal),
    },
    observeIdentity,
    invalidateAccess,
    retireIdentity,
  };
}
