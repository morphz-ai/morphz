import type {
  Operation,
  Receipt,
} from "../../../../packages/core/src/model.js";
import type { Boot, executePlatformOperation } from "../client.js";
import type { PlatformClient } from "../platform-client.js";
import type { createLocalInputDelivery } from "./local-input-delivery.js";
import { scopedStorage, draftKey } from "../local-preferences.js";
import { RequestError } from "../application-transport.js";

export type OperationDeliveryPorts = {
  current: { readonly current: Boot | null };
  platform: { readonly current: PlatformClient | null };
  localInputDelivery: Pick<
    ReturnType<typeof createLocalInputDelivery>,
    "recordInput"
  >;
  executePlatformOperation: typeof executePlatformOperation;
  refreshAfterMutation(): Promise<boolean>;
};

export class UnsentOperationError extends Error {}

/** A script or document command may commit its app-owned original before the
 * Platform directory projection fails. HTTP 4xx alone cannot prove that the
 * app transaction did not commit, so the next identical attempt must retain
 * the original command identity.
 */
export function operationMayCommitBeforeError(operation: Operation): boolean {
  return (
    operation.type === "install-application" ||
    operation.type === "launch-application" ||
    operation.type === "set-application-state" ||
    operation.type === "close-application" ||
    (operation.type === "update-project" && operation.state !== undefined) ||
    (operation.type === "organize-content" &&
      operation.changes.title !== undefined) ||
    operation.type === "script-command" ||
    operation.type === "import-document" ||
    (operation.type === "create-artifact" &&
      ["document", "image", "interactive"].includes(operation.content.kind)) ||
    (operation.type === "revise-artifact" &&
      ["document", "image", "interactive"].includes(operation.content.kind))
  );
}

/** Own non-input durable delivery. Borrow the original references and calls
 * without reading them during construction; Client retains refresh/identity
 * authority, domain dispatch and the independent record-input lifetime.
 */
export function createOperationDelivery(options: OperationDeliveryPorts) {
  const {
    current,
    platform,
    localInputDelivery,
    executePlatformOperation,
    refreshAfterMutation,
  } = options;
  async function execute(
    operation: Operation,
    dispatch = false,
    applicationInstanceId?: string,
    externalCommandId?: string,
    onInputStaged?: (inputId: string) => void,
  ): Promise<Receipt> {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const identity = current.current,
      scope = `${identity.centerId}:${identity.principalId}`,
      { readLocal, writeLocal } = scopedStorage(scope);
    if (operation.type === "record-input")
      return localInputDelivery.recordInput(
        identity,
        operation,
        dispatch,
        externalCommandId,
        onInputStaged,
      );
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          operation,
          dispatch,
          applicationInstanceId,
          externalCommandId,
        }),
      ),
    );
    const key = draftKey(
      "pending:" +
        Array.from(new Uint8Array(hash), (v) =>
          v.toString(16).padStart(2, "0"),
        ).join(""),
    );
    if (current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已切换，操作未发送。");
    const command = readLocal<{
      commandId: string;
      operation: Operation;
      applicationInstanceId?: string;
    } | null>(key, null) ?? {
      commandId: externalCommandId ?? crypto.randomUUID(),
      operation,
      ...(applicationInstanceId ? { applicationInstanceId } : {}),
    };
    // Save retry identity before sending. A lost reply must not duplicate a mutation after reload.
    writeLocal(key, command);
    try {
      const source = platform.current;
      if (!source || source.boot.csrfToken !== identity.csrfToken)
        throw new Error("身份已变化，操作未发送。");
      const receipt = await executePlatformOperation(
        source,
        identity,
        command,
        dispatch,
      );
      writeLocal(key, null);
      await refreshAfterMutation();
      return receipt;
    } catch (e) {
      if (e instanceof UnsentOperationError) writeLocal(key, null);
      if (e instanceof RequestError) {
        // A server error can occur after commit. Keep its identity until a
        // successful receipt or a definitive client-side rejection is known.
        if (
          e.status < 500 &&
          e.status !== 408 &&
          !operationMayCommitBeforeError(operation)
        )
          writeLocal(key, null);
        await refreshAfterMutation();
      }
      throw e;
    }
  }
  return { execute };
}
