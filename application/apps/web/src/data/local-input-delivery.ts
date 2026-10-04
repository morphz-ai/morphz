import type { Boot, executePlatformOperation } from "../client.js";
import type { PlatformClient } from "../platform-client.js";
import {
  operationSchema,
  type Operation,
  type Receipt,
  type Workspace,
} from "../../../../packages/core/src/model.js";
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
} from "../local-saved-inputs.js";

type Identity = Pick<Boot, "centerId" | "principalId" | "actantId">;
type RecordInput = Extract<Operation, { type: "record-input" }>;
export type LocalInputDeliveryPorts = {
  inputSends: { readonly current: Map<string, Promise<Receipt>> };
  current: { current: Boot | null };
  platform: { readonly current: PlatformClient | null };
  snapshotText: { current: string };
  storage(): Storage;
  savedInputScope(identity: Identity): string;
  executePlatformOperation: typeof executePlatformOperation;
  setBoot(value: Boot): void;
  refreshAfterMutation(): Promise<boolean>;
  call(
    method: "input.send",
    params: string,
    options: { identityGeneration: string },
  ): Promise<unknown>;
};

/** Own frozen device inputs, their delivery/retry and authoritative confirmation.
 * Borrow Client refs and lazy storage without accessing them during construction.
 * Identity authority, refresh scheduling and non-input commands stay in Client.
 */
export function createLocalInputDelivery({
  inputSends,
  current,
  platform,
  snapshotText,
  storage,
  savedInputScope,
  executePlatformOperation,
  setBoot,
  refreshAfterMutation,
  call: applicationCall,
}: LocalInputDeliveryPorts) {
  function readSaved(identity: Identity) {
    return readSavedInputs(storage(), savedInputScope(identity));
  }
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
      readSavedInputs(storage(), savedInputScope(identity)),
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
    saveInputLocally(storage(), scope, staged);
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
        readSavedInputs(storage(), scope).some(
          (input) => input.commandId === entry.commandId,
        )
      )
        saveInputLocally(storage(), scope, {
          ...entry,
          submission: { state: "accepted" },
        });
      return receipt;
    } catch (error) {
      if (
        readSavedInputs(storage(), scope).some(
          (input) => input.commandId === entry.commandId,
        )
      )
        saveInputLocally(storage(), scope, {
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
  function recordInput(
    identity: Boot,
    operation: RecordInput,
    dispatch: boolean,
    externalCommandId?: string,
    onInputStaged?: (inputId: string) => void,
  ): Receipt | Promise<Receipt> {
    if (
      operation.type === "record-input" &&
      operation.conversationId &&
      !operation.newConversation &&
      readSavedInputs(storage(), savedInputScope(identity)).some(
        (input) =>
          input.operation.conversationId === operation.conversationId &&
          input.operation.newConversation,
      )
    )
      throw new Error("请先发送这段对话中已保存的第一条消息。");
    const commandId = externalCommandId ?? crypto.randomUUID();
    const existing = readSavedInputs(storage(), savedInputScope(identity)).find(
      (input) => input.commandId === commandId,
    );
    const parsed = existing
      ? matchSavedInputOperation(operation, existing.operation)
      : operationSchema.parse(newInputOperation(operation));
    const entry: LocalSavedInput = existing ?? {
      commandId,
      createdAt: new Date().toISOString(),
      operation: parsed as LocalSavedInput["operation"],
    };
    if (dispatch) return submitSavedInput(identity, entry, onInputStaged);
    saveInputLocally(storage(), savedInputScope(identity), entry);
    publishSavedInputs(identity);
    onInputStaged?.(commandId);
    return {
      commandId,
      entityId: commandId,
      workspaceRevision: identity.workspace.revision,
    };
  }
  async function dispatchInput(inputId: string) {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const scope = savedInputScope(identity);
    const saved = readSavedInputs(storage(), scope);
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
  function confirmAndProject(
    workspace: Workspace,
    source: Pick<PlatformClient, "boot">,
  ) {
    const latestSaved = readSavedInputs(
      storage(),
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
        storage(),
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
    recordInput,
    dispatchInput,
    confirmAndProject,
  };
}
