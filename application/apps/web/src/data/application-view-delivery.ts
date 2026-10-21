import type { Boot } from "../client.js";
import type { createOperationDelivery } from "./operation-delivery.js";

type Delivery = ReturnType<typeof createOperationDelivery>;
type Identity = Pick<
  Boot,
  "centerId" | "principalId" | "actantId" | "csrfToken"
>;
type Confirmed = { base: number; next: number; closed: boolean };
export type ApplicationViewWrite = {
  identity: Identity;
  pending: Promise<Confirmed>;
};
const sameIdentity = (a: Identity, b: Identity) =>
  a.centerId === b.centerId &&
  a.principalId === b.principalId &&
  a.actantId === b.actantId &&
  a.csrfToken === b.csrfToken;

/** Order local save/close intents for one view. Only our own confirmed CAS
 * receipts may advance a queued intent before durable command admission.
 * External revisions and uncertain commits are never retried or rebased.
 * The borrowed map contains pending work only, not a second state authority. */
export function createApplicationViewDelivery(options: {
  current: { readonly current: Boot | null };
  pending: Map<string, ApplicationViewWrite>;
  execute: Delivery["execute"];
}): Delivery {
  const execute: Delivery["execute"] = (...args) => {
    const [operation, , , externalCommandId] = args;
    if (
      (operation.type !== "set-application-state" &&
        operation.type !== "close-application") ||
      externalCommandId !== undefined
    )
      return options.execute(...args);
    const snapshot = options.current.current;
    const identity = snapshot && {
      centerId: snapshot.centerId,
      principalId: snapshot.principalId,
      actantId: snapshot.actantId,
      csrfToken: snapshot.csrfToken,
    };
    const capturedView = snapshot?.workspace.applicationInstances.find(
      (view) => view.id === operation.instanceId,
    );
    const captured = capturedView && { ...capturedView };
    if (!identity || !captured)
      return Promise.reject(new Error("原应用窗口已不可用或无访问权限。"));
    const earlier = options.pending.get(operation.instanceId);
    const previous =
      earlier && sameIdentity(earlier.identity, identity)
        ? earlier.pending
        : undefined;
    let receipt: Awaited<ReturnType<Delivery["execute"]>>;
    const pending = (async (): Promise<Confirmed> => {
      const confirmed = previous ? await previous : undefined;
      const current = options.current.current;
      const view = current?.workspace.applicationInstances.find(
        (value) => value.id === captured.id,
      );
      if (
        !current ||
        !sameIdentity(current, identity) ||
        !view ||
        view.workspaceId !== captured.workspaceId ||
        view.applicationId !== captured.applicationId ||
        view.applicationVersion !== captured.applicationVersion ||
        view.status !== "open"
      )
        throw new Error("原应用窗口已不可用或无访问权限。");
      const base = confirmed?.base ?? operation.expectedRevision;
      const expectedRevision = confirmed?.next ?? operation.expectedRevision;
      if (
        confirmed?.closed ||
        operation.expectedRevision < base ||
        operation.expectedRevision > expectedRevision ||
        view.revision < base ||
        view.revision > expectedRevision
      )
        throw new Error("应用窗口已变化，请刷新后重试。");
      const ordered = [...args] as Parameters<Delivery["execute"]>;
      ordered[0] = { ...operation, expectedRevision };
      receipt = await options.execute(...ordered);
      return {
        base,
        next: expectedRevision + 1,
        closed: operation.type === "close-application",
      };
    })();
    options.pending.set(operation.instanceId, { identity, pending });
    const release = () => {
      if (options.pending.get(operation.instanceId)?.pending === pending)
        options.pending.delete(operation.instanceId);
    };
    return pending.then(
      () => {
        release();
        return receipt;
      },
      (error) => {
        release();
        throw error;
      },
    );
  };
  return { execute };
}
