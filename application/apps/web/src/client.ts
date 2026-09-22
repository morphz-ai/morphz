import { useEffect, useRef, useState } from "react";
import { migrateContentLocalState } from "./content-local-migration.js";
import { z } from "zod";
import { scriptOutputSchema } from "../../../packages/core/src/script-delivery.js";
import {
  speechStreamStateSchema,
  type SpeechStreamCommand,
} from "../../../packages/core/src/speech-stream.js";
import {
  connectionDetailsSchema,
  type ConfigureConnection,
} from "../../../packages/core/src/connection.js";
import { taskRuntimeSchema } from "../../../packages/core/src/task-runtime.js";
import {
  migrateLegacyLocalState,
  migrateApplicationLocalState,
} from "./legacy-storage.js";
import {
  applicationStoragePrefix,
  legacyApplicationStoragePrefix,
  applicationWindowKey,
  legacyApplicationWindowKey,
} from "../../../packages/core/src/application-names.js";
import { applicationCall, RequestError } from "./application-transport.js";
export { RequestError } from "./application-transport.js";
import { maxPdfBytes } from "../../../packages/core/src/pdf.js";
import {
  executionSnapshotSchema,
  type ExecutionScope,
  type ExecutionControl,
} from "../../../packages/core/src/execution.js";
import type {
  SearchRequest,
  SearchResult,
} from "../../../packages/core/src/retrieval.js";
import {
  conversationRuntimeSchema,
  artifactOutputSchema,
  disconnectedRuntime,
} from "../../../packages/core/src/conversation.js";
import {
  stateSchema,
  type Operation,
  type Receipt,
  type Workspace,
} from "../../../packages/core/src/model.js";
const bootSchema = z.object({
  centerId: z.string().uuid(),
  workspace: stateSchema,
  outputs: z.array(artifactOutputSchema).default([]),
  scriptOutputs: z.array(scriptOutputSchema).default([]),
  csrfToken: z.string(),
  principalId: z.string(),
  actantId: z.string(),
  capabilities: z.object({
    runtime: z.boolean(),
    teamAuthentication: z.boolean(),
    conversationOnFirstInput: z.boolean().default(false),
    directedInput: z.boolean().default(false),
    localFiles: z.boolean().default(false),
    agentDirectories: z.boolean().default(false),
    modelSettings: z.boolean().default(false),
    taskCompletion: z.boolean().default(false),
  }),
  runtime: conversationRuntimeSchema.default(disconnectedRuntime),
  taskRuns: z.record(z.string(), taskRuntimeSchema).default({}),
});
export type Boot = z.infer<typeof bootSchema>;
export type SpeechScope = {
  projectId: string;
  artifactId?: string;
  revision?: number;
};
let localScope = "disconnected";
export function storageScope(centerId: string, principalId: string) {
  localScope = `${centerId}:${principalId}`;
}
export function readLocal<T>(key: string, fallback: T, scope = localScope): T {
  try {
    const suffix = scope + ":" + key;
    const raw =
      localStorage.getItem(applicationStoragePrefix + suffix) ??
      localStorage.getItem(legacyApplicationStoragePrefix + suffix);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown, scope = localScope) {
  localStorage.setItem(
    applicationStoragePrefix + scope + ":" + key,
    JSON.stringify(value),
  );
}
export function scopedStorage(scope = localScope) {
  return {
    readLocal: <T>(key: string, fallback: T) => readLocal(key, fallback, scope),
    writeLocal: (key: string, value: unknown) => writeLocal(key, value, scope),
  };
}
// Window-local identity survives reload. Separate tabs must not erase one another's drafts.
const draftOwner = (() => {
  try {
    const saved =
      sessionStorage.getItem(applicationWindowKey) ??
      sessionStorage.getItem(legacyApplicationWindowKey);
    const id = saved || crypto.randomUUID();
    sessionStorage.setItem(applicationWindowKey, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();
export const draftKey = (key: string) => "draft:" + draftOwner + ":" + key;
export function useWorkspace() {
  const approvalSubmissions = useRef(new Set<string>());
  const [, updateApprovalSubmissions] = useState(0);
  const [boot, setBoot] = useState<Boot | null>(null),
    [online, setOnline] = useState(false),
    [error, setError] = useState(""),
    [authenticationRequired, setAuthenticationRequired] = useState(false);
  const current = useRef<Boot | null>(null),
    epoch = useRef(0),
    snapshotText = useRef(""),
    refreshing = useRef<Promise<void> | null>(null);
  async function refresh() {
    if (refreshing.current) return refreshing.current;
    const version = epoch.current;
    refreshing.current = (async () => {
      try {
        const snapshot = await applicationCall("workspace", undefined, {
          signal: AbortSignal.timeout(6000),
        });
        if (version !== epoch.current) return;
        const serialized = JSON.stringify(snapshot);
        if (serialized !== snapshotText.current) {
          const value = bootSchema.parse(snapshot);
          if (version !== epoch.current) return;
          // A slow snapshot must not replace newer state already rendered.
          if (
            !current.current ||
            value.centerId !== current.current.centerId ||
            value.principalId !== current.current.principalId ||
            value.workspace.revision >= current.current.workspace.revision
          ) {
            current.current = value;
            snapshotText.current = serialized;
            migrateLegacyLocalState(
              localStorage,
              value.centerId,
              value.principalId,
              value.capabilities.teamAuthentication,
              location.origin,
            );
            migrateApplicationLocalState(
              localStorage,
              value.centerId,
              value.principalId,
            );
            migrateContentLocalState(
              localStorage,
              value.centerId,
              value.principalId,
            );
            // Main-process origin migration restores this window's exact draft owner.
            // Draft and pending-command keys are copied intact, never recreated/replayed.
            if (window.morphzDesktop)
              localStorage.setItem(
                `${applicationStoragePrefix}${value.centerId}:${value.principalId}:desktop:last-window`,
                draftOwner,
              );
            setBoot(value);
          }
        }
        setOnline(true);
        setError("");
      } catch (e) {
        if (version !== epoch.current) return;
        if (e instanceof RequestError && e.status === 401) {
          current.current = null;
          snapshotText.current = "";
          setBoot(null);
          storageScope("disconnected", "anonymous");
          setAuthenticationRequired(true);
        }
        setOnline(false);
        setError(
          e instanceof Error ? e.message : "暂时无法读取应用数据，请重试。",
        );
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }
  async function resolveArtifact(id: string) {
    if (!current.current?.workspace.artifacts.some((a) => a.id === id)) {
      await refresh();
      // An in-flight poll may predate the object returned by search.
      if (!current.current?.workspace.artifacts.some((a) => a.id === id))
        await refresh();
    }
    return current.current?.workspace.artifacts.find((a) => a.id === id);
  }
  async function login(token: string) {
    epoch.current++;
    await applicationCall(
      "login",
      { token },
      { signal: AbortSignal.timeout(8000) },
    );
    if (refreshing.current) await refreshing.current;
    current.current = null;
    snapshotText.current = "";
    setBoot(null);
    setAuthenticationRequired(false);
    await refresh();
  }
  async function logout() {
    if (!current.current) return;
    await applicationCall("logout", undefined, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
    // Drop the mounted workspace and all in-memory object state immediately.
    epoch.current++;
    current.current = null;
    snapshotText.current = "";
    setBoot(null);
    setAuthenticationRequired(true);
    storageScope("disconnected", "anonymous");
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 1200);
    const wake = () => void refresh();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  async function execute(
    operation: Operation,
    dispatch = false,
    applicationInstanceId?: string,
    externalCommandId?: string,
  ): Promise<Receipt> {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const identity = current.current,
      scope = `${identity.centerId}:${identity.principalId}`,
      { readLocal, writeLocal } = scopedStorage(scope);
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
      const receipt = (await applicationCall(
        dispatch ? "message" : "command",
        command,
        {
          identityGeneration: identity.csrfToken,
          signal: AbortSignal.timeout(
            operation.type === "record-input" && operation.continuation
              ? 25000
              : 8000,
          ),
        },
      )) as Receipt;
      writeLocal(key, null);
      await refresh();
      await refresh();
      return receipt;
    } catch (e) {
      if (e instanceof RequestError) {
        // A server error can occur after commit. Keep its identity until a
        // successful receipt or a definitive client-side rejection is known.
        if (
          e.status < 500 &&
          e.status !== 408 &&
          !(operation.type === "record-input" && operation.continuation)
        )
          writeLocal(key, null);
        await refresh();
      }
      throw e;
    }
  }
  async function upload(file: File) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    if (file.size > 6 * 1024 * 1024) throw new Error("图片不能超过 6 MB。");
    const identityGeneration = current.current.csrfToken;
    return applicationCall("asset.add", await file.arrayBuffer(), {
      identityGeneration,
      signal: AbortSignal.timeout(15000),
    }) as Promise<{ assetId: string; mime: string }>;
  }
  async function uploadAttachment(file: File) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    if (file.size > 20 * 1024 * 1024) throw new Error("附件不能超过 20 MB。");
    const identityGeneration = current.current.csrfToken;
    return applicationCall(
      "attachment.add",
      { name: file.name.slice(0, 180), data: await file.arrayBuffer() },
      { identityGeneration, signal: AbortSignal.timeout(30000) },
    ) as Promise<{
      assetId: string;
      mime: import("../../../packages/core/src/model.js").InputAttachment["mime"];
    }>;
  }
  async function importPdf(
    file: File,
    projectId: string,
    relativePath: string,
  ): Promise<Receipt> {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    if (file.size > maxPdfBytes) throw new Error("PDF 不能超过 20 MB。");
    const identity = current.current,
      { readLocal, writeLocal } = scopedStorage(
        `${identity.centerId}:${identity.principalId}`,
      );
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
    );
    const key = draftKey(
      "pdf:" +
        projectId +
        ":" +
        relativePath +
        ":" +
        Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join(""),
    );
    const commandId =
      readLocal<string | null>(key, null) ?? crypto.randomUUID();
    if (current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已切换，文件未发送。");
    writeLocal(key, commandId);
    const receipt = (await applicationCall(
      "pdf.import",
      { commandId, projectId, relativePath, data: await file.arrayBuffer() },
      {
        identityGeneration: identity.csrfToken,
        signal: AbortSignal.timeout(30000),
      },
    )) as Receipt;
    writeLocal(key, null);
    await refresh();
    await refresh();
    return receipt;
  }
  async function dispatchInput(inputId: string) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    await applicationCall("input.send", inputId, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
    await refresh();
    await refresh();
  }
  async function verifyArtifact(id: string) {
    const data = bootSchema.parse(
      await applicationCall("workspace", undefined, {
        signal: AbortSignal.timeout(6000),
      }),
    );
    if (!data.workspace.artifacts.some((a) => a.id === id))
      throw new Error("事项不可用或已无访问权限。");
  }
  async function cancelInput(inputId: string) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    await applicationCall("input.cancel", inputId, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
    await refresh();
    await refresh();
  }
  async function search(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    return applicationCall("search", request, {
      signal: signal ?? AbortSignal.timeout(6000),
    }) as Promise<SearchResult>;
  }
  async function executionSnapshot(scope: ExecutionScope) {
    return executionSnapshotSchema.parse(
      await applicationCall("execution.snapshot", scope, {
        signal: AbortSignal.timeout(12000),
      }),
    );
  }
  async function taskRuntime(
    taskId: string,
    control?: {
      run: number;
      revision: number;
      action: "pause" | "resume" | "cancel" | "stop";
    },
  ) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    return applicationCall(
      control ? "task.control" : "task.snapshot",
      control ? { id: taskId, ...control } : taskId,
      {
        identityGeneration: current.current.csrfToken,
        signal: AbortSignal.timeout(12000),
      },
    );
  }
  async function executionResult(scope: ExecutionScope, jobId: string) {
    return z
      .object({
        text: z.string(),
        truncated: z.boolean(),
        available: z.boolean(),
      })
      .parse(
        await applicationCall(
          "execution.result",
          { scope, jobId },
          { signal: AbortSignal.timeout(12000) },
        ),
      );
  }
  async function controlExecution(command: ExecutionControl) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    if (
      command.action.type === "allow-once" ||
      command.action.type === "deny"
    ) {
      const key = JSON.stringify([
        current.current.csrfToken,
        command.action.approvalId,
        command.action.fingerprint,
      ]);
      if (approvalSubmissions.current.has(key))
        throw new Error("本次审批已提交，请核对最新执行状态，不要重复批准。");
      approvalSubmissions.current.add(key);
      updateApprovalSubmissions((version) => version + 1);
    }
    return applicationCall("execution.control", command, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(12000),
    });
  }
  function approvalSubmitted(approvalId: string, fingerprint: string) {
    return approvalSubmissions.current.has(
      JSON.stringify([current.current?.csrfToken, approvalId, fingerprint]),
    );
  }
  async function speechStatus(signal?: AbortSignal) {
    return z
      .object({
        configured: z.boolean(),
        provider: z.string().min(1).nullable(),
        providerLabel: z.string().min(1).nullable().optional(),
        segmentSeconds: z.number().optional(),
        streaming: z.boolean().optional(),
      })
      .parse(await applicationCall("speech.status", undefined, { signal }));
  }
  function createSpeechStream(scope: SpeechScope) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const identityGeneration = current.current.csrfToken,
      id = crypto.randomUUID();
    type Action = SpeechStreamCommand extends infer T
      ? T extends SpeechStreamCommand
        ? Omit<T, "scope" | "id">
        : never
      : never;
    return async (command: Action, signal: AbortSignal) =>
      speechStreamStateSchema.parse(
        await applicationCall(
          "speech.stream",
          { ...command, id, scope },
          { identityGeneration, signal },
        ),
      );
  }
  async function transcribe(
    scope: SpeechScope,
    wav: Blob,
    signal: AbortSignal,
  ) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const identityGeneration = current.current.csrfToken;
    return z
      .object({ text: z.string().max(30000) })
      .parse(
        await applicationCall(
          "speech.transcribe",
          { scope, data: await wav.arrayBuffer() },
          { identityGeneration, signal },
        ),
      ).text;
  }
  async function synthesize(
    scope: SpeechScope,
    text: string,
    signal: AbortSignal,
  ) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const data = await applicationCall(
      "speech.synthesize",
      { scope, text },
      { identityGeneration: current.current.csrfToken, signal },
    );
    if (!(data instanceof Uint8Array)) throw new Error("语音响应格式无效。");
    return new Blob([new Uint8Array(data)], { type: "audio/wav" });
  }
  return {
    notifications: async (
      command?:
        | { action: "settings"; mode: "all" | "off" }
        | { action: "read"; ids: string[] },
    ) => {
      if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
      return applicationCall(
        command ? "notifications.control" : "notifications.read",
        command,
        {
          identityGeneration: current.current.csrfToken,
          signal: AbortSignal.timeout(6000),
        },
      );
    },
    checkConnection: async (signal: AbortSignal) =>
      connectionDetailsSchema.parse(
        await applicationCall("connection.check", undefined, { signal }),
      ),
    configureConnection: async (
      params: ConfigureConnection,
      signal: AbortSignal,
    ) =>
      connectionDetailsSchema.parse(
        await applicationCall("connection.configure", params, { signal }),
      ),
    authenticationRequired,
    login,
    logout,
    speechStatus,
    createSpeechStream,
    transcribe,
    synthesize,
    taskRuntime,
    boot,
    // Read the refreshed identity-bound snapshot after an awaited command.
    // React's captured boot value may still refer to the previous render.
    getSnapshot: () => current.current,
    online,
    error,
    refresh,
    resolveArtifact,
    execute,
    upload,
    uploadAttachment,
    importPdf,
    dispatchInput,
    verifyArtifact,
    cancelInput,
    search,
    executionSnapshot,
    executionResult,
    controlExecution,
    approvalSubmitted,
  };
}
export type WorkspaceClient = ReturnType<typeof useWorkspace>;
export function actorName(state: Workspace, id: string) {
  return state.actants.find((a) => a.id === id)?.name ?? "未知参与者";
}
