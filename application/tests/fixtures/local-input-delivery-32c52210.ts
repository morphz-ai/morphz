import type {
  Boot,
  executePlatformOperation,
} from "../../apps/web/src/client.js";
import type { PlatformClient } from "../../apps/web/src/platform-client.js";
import { RequestError } from "../../apps/web/src/application-transport.js";
import {
  draftKey,
  type scopedStorage,
} from "../../apps/web/src/local-preferences.js";
import {
  operationSchema,
  type Operation,
  type Receipt,
  type Workspace,
} from "../../packages/core/src/model.js";
import {
  readSavedInputs,
  removeSavedInput,
  saveInputLocally,
  withSavedInputs,
  withoutSavedInputs,
  newInputOperation,
  matchSavedInputOperation,
  savedInputOperation,
  type LocalSavedInput,
} from "../../apps/web/src/local-saved-inputs.js";

/** Fixed Git 32c52210 algorithms, independent of the candidate data owner.
 * Ports provide controlled refs/transport/storage, not a real authority fixture.
 * execute includes the original untouched non-record branch to preserve its
 * surrounding initialization and Promise boundary; tests target local delivery.
 */
export const legacyClientSha =
  "5ef656793c9f70eada0bfc4eb0dcfc54ae4efab2d25eca6fd8d7dbdcdb2c3128";
export const legacySourceHashes = {
  sendingInputIds:
    "8a397cb625982b39ec6976b5834e4d8c859410782b1d819d97ee0c96d332ef02",
  publishSavedInputs:
    "04ffdacfd5799e64f0ed21ee4c4f4b76215ef78ce209d1afd31bd44c70f87e4e",
  submitSavedInput:
    "3db6ed7338ca04d5b6183a0a0b70331c3d388b00104438abf4896646dc478fda",
  execute: "632e1d95d6b8c60505a2658e1c812702cdd45f6a705e64f389ec2381b8f11fca",
  dispatchInput:
    "8ca70fe6f7559c75d4d0c792d6ba96e30d49c4839d68f8343f1765d4233cbc28",
  confirm: "bc765397ff1333e9c0dc5a8110c1d5dcea6b83238f7d081316b37578399e29bb",
  record: "89309f544d8ccf1eadc04028325ff44c2596903f2c41c9af4fe1f33aa7e55557",
};
export const legacyRecordBlock =
  'if (\n      operation.type === "record-input" &&\n      operation.conversationId &&\n      !operation.newConversation &&\n      readSavedInputs(localStorage, savedInputScope(identity)).some(\n        (input) =>\n          input.operation.conversationId === operation.conversationId &&\n          input.operation.newConversation,\n      )\n    )\n      throw new Error("请先发送这段对话中已保存的第一条消息。");\n    if (operation.type === "record-input") {\n      const commandId = externalCommandId ?? crypto.randomUUID();\n      const existing = readSavedInputs(\n        localStorage,\n        savedInputScope(identity),\n      ).find((input) => input.commandId === commandId);\n      const parsed = existing\n        ? matchSavedInputOperation(operation, existing.operation)\n        : operationSchema.parse(newInputOperation(operation));\n      const entry: LocalSavedInput = existing ?? {\n        commandId,\n        createdAt: new Date().toISOString(),\n        operation: parsed as LocalSavedInput["operation"],\n      };\n      if (dispatch) return submitSavedInput(identity, entry, onInputStaged);\n      saveInputLocally(localStorage, savedInputScope(identity), entry);\n      publishSavedInputs(identity);\n      onInputStaged?.(commandId);\n      return {\n        commandId,\n        entityId: commandId,\n        workspaceRevision: identity.workspace.revision,\n      };\n    }';
export const legacyConfirmationBlock =
  "const latestSaved = readSavedInputs(\n          localStorage,\n          savedInputScope(source.boot),\n        );\n        const knownInputs = new Map(\n          workspace.inputs.map((input) => [input.id, input]),\n        );\n        const unconfirmed = latestSaved.filter((entry) => {\n          const input = knownInputs.get(entry.commandId);\n          if (\n            !input ||\n            input.author.principalId !== source.boot.principalId ||\n            input.author.actantId !== source.boot.actantId\n          )\n            return true;\n          removeSavedInput(\n            localStorage,\n            savedInputScope(source.boot),\n            entry.commandId,\n          );\n          return false;\n        });\n        const savedProjection = withSavedInputs(\n          workspace,\n          unconfirmed,\n          source.boot,\n          sendingInputIds(source.boot),\n        );";
type Identity = Pick<Boot, "centerId" | "principalId" | "actantId">;
export type LegacyLocalInputBindings = {
  current: { current: Boot | null };
  inputSends: { current: Map<string, Promise<Receipt>> };
  platform: { current: PlatformClient | null };
  snapshotText: { current: string };
  localStorage: Storage;
  savedInputScope(identity: Identity): string;
  setBoot(value: Boot): void;
  refreshAfterMutation(): Promise<boolean>;
  executePlatformOperation: typeof executePlatformOperation;
  applicationCall(
    method: "input.send",
    params: string,
    options: { identityGeneration: string },
  ): Promise<unknown>;
  scopedStorage: typeof scopedStorage;
};
class UnsentOperationError extends Error {}
function operationMayCommitBeforeError(operation: Operation): boolean {
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
export function createLegacyLocalInputDelivery({
  current,
  inputSends,
  platform,
  snapshotText,
  localStorage,
  savedInputScope,
  setBoot,
  refreshAfterMutation,
  executePlatformOperation,
  applicationCall,
  scopedStorage,
}: LegacyLocalInputBindings) {
  function sendingInputIds(
    identity: Pick<Boot, "centerId" | "principalId" | "actantId">,
  ) {
    const scope = savedInputScope(identity) + ":";
    return new Set(
      [...inputSends.current.keys()]
        .filter((key) => key.startsWith(scope))
        .map((key) => key.slice(scope.length)),
    );
  }
  function publishSavedInputs(identity: Boot) {
    const latest = current.current;
    if (!latest || latest.csrfToken !== identity.csrfToken) return;
    const projection = withSavedInputs(
      withoutSavedInputs(latest.workspace, latest.localSavedInputIds),
      readSavedInputs(localStorage, savedInputScope(identity)),
      identity,
      sendingInputIds(identity),
    );
    const value = {
      ...latest,
      workspace: projection.workspace,
      localSavedInputIds: projection.localInputIds,
      localInputSubmissions: projection.submissions,
    };
    current.current = value;
    // A background read must not consider its pre-submit snapshot current.
    snapshotText.current = "";
    setBoot(value);
  }
  async function submitSavedInput(
    identity: Boot,
    entry: LocalSavedInput,
    onStaged?: (inputId: string) => void,
  ): Promise<Receipt> {
    const scope = savedInputScope(identity);
    const key = scope + ":" + entry.commandId;
    const pending = inputSends.current.get(key);
    if (pending) return pending;
    const source = platform.current;
    if (!source || current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，消息未发送。");
    const staged = { ...entry, submission: { state: "sending" as const } };
    // Persist the frozen payload before transport; retries never use the editor.
    saveInputLocally(localStorage, scope, staged);
    const request = Promise.resolve().then(() =>
      executePlatformOperation(
        source,
        identity,
        {
          commandId: entry.commandId,
          operation: savedInputOperation(entry.operation),
        },
        true,
      ),
    );
    inputSends.current.set(key, request);
    publishSavedInputs(identity);
    onStaged?.(entry.commandId);
    try {
      const receipt = await request;
      // A concurrent history refresh may already have confirmed this input.
      if (
        readSavedInputs(localStorage, scope).some(
          (input) => input.commandId === entry.commandId,
        )
      )
        saveInputLocally(localStorage, scope, {
          ...entry,
          submission: { state: "accepted" },
        });
      return receipt;
    } catch (error) {
      if (
        readSavedInputs(localStorage, scope).some(
          (input) => input.commandId === entry.commandId,
        )
      )
        saveInputLocally(localStorage, scope, {
          ...entry,
          submission: {
            state: "failed",
            error:
              error instanceof Error ? error.message : "发送失败，点击重试。",
          },
        });
      throw error;
    } finally {
      inputSends.current.delete(key);
      publishSavedInputs(identity);
      // Submission success does not depend on an expensive catalog refresh.
      // Keep the same bubble until history supplies its authoritative same-ID row.
      if (current.current?.csrfToken === identity.csrfToken)
        void refreshAfterMutation();
    }
  }
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
    if (
      operation.type === "record-input" &&
      operation.conversationId &&
      !operation.newConversation &&
      readSavedInputs(localStorage, savedInputScope(identity)).some(
        (input) =>
          input.operation.conversationId === operation.conversationId &&
          input.operation.newConversation,
      )
    )
      throw new Error("请先发送这段对话中已保存的第一条消息。");
    if (operation.type === "record-input") {
      const commandId = externalCommandId ?? crypto.randomUUID();
      const existing = readSavedInputs(
        localStorage,
        savedInputScope(identity),
      ).find((input) => input.commandId === commandId);
      const parsed = existing
        ? matchSavedInputOperation(operation, existing.operation)
        : operationSchema.parse(newInputOperation(operation));
      const entry: LocalSavedInput = existing ?? {
        commandId,
        createdAt: new Date().toISOString(),
        operation: parsed as LocalSavedInput["operation"],
      };
      if (dispatch) return submitSavedInput(identity, entry, onInputStaged);
      saveInputLocally(localStorage, savedInputScope(identity), entry);
      publishSavedInputs(identity);
      onInputStaged?.(commandId);
      return {
        commandId,
        entityId: commandId,
        workspaceRevision: identity.workspace.revision,
      };
    }
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
  async function dispatchInput(inputId: string) {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const scope = savedInputScope(identity);
    const saved = readSavedInputs(localStorage, scope);
    const local = saved.find((item) => item.commandId === inputId);
    if (local) {
      if (!identity.runtime.configured)
        throw new Error("连接 Agent 后才能发送这条本机保存的消息。");
      if (
        local.operation.conversationId &&
        saved.some(
          (item) =>
            item.commandId !== inputId &&
            item.operation.conversationId === local.operation.conversationId &&
            item.operation.newConversation,
        )
      )
        throw new Error("请先发送这段对话中已保存的第一条消息。");
      await submitSavedInput(identity, local);
    } else
      await applicationCall("input.send", inputId, {
        identityGeneration: identity.csrfToken,
      });
    if (!local) await refreshAfterMutation();
  }
  function readSaved(identity: Identity) {
    return readSavedInputs(localStorage, savedInputScope(identity));
  }
  function confirmAndProject(
    workspace: Workspace,
    source: Pick<PlatformClient, "boot">,
  ) {
    const latestSaved = readSavedInputs(
      localStorage,
      savedInputScope(source.boot),
    );
    const knownInputs = new Map(
      workspace.inputs.map((input) => [input.id, input]),
    );
    const unconfirmed = latestSaved.filter((entry) => {
      const input = knownInputs.get(entry.commandId);
      if (
        !input ||
        input.author.principalId !== source.boot.principalId ||
        input.author.actantId !== source.boot.actantId
      )
        return true;
      removeSavedInput(
        localStorage,
        savedInputScope(source.boot),
        entry.commandId,
      );
      return false;
    });
    const savedProjection = withSavedInputs(
      workspace,
      unconfirmed,
      source.boot,
      sendingInputIds(source.boot),
    );
    return savedProjection;
  }
  return {
    readSaved,
    sendingInputIds,
    publishSavedInputs,
    submitSavedInput,
    execute,
    dispatchInput,
    confirmAndProject,
  };
}
