import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { migrateLegacyLocalState } from "./legacy-storage.js";
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
  csrfToken: z.string(),
  principalId: z.string(),
  actantId: z.string(),
  capabilities: z.object({
    runtime: z.boolean(),
    teamAuthentication: z.boolean(),
  }),
  runtime: conversationRuntimeSchema.default(disconnectedRuntime),
});
export type Boot = z.infer<typeof bootSchema>;
export type SpeechScope = {
  projectId: string;
  artifactId?: string;
  revision?: number;
};
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function checked(response: Response) {
  const value: unknown = await response.json();
  if (!response.ok)
    throw new RequestError(
      response.status,
      typeof value === "object" && value && "message" in value
        ? String(value.message)
        : "请求失败。",
    );
  return value;
}
let localScope = "disconnected";
export function storageScope(centerId: string, principalId: string) {
  localScope = `${centerId}:${principalId}`;
}
export function readLocal<T>(key: string, fallback: T, scope = localScope): T {
  try {
    const raw = localStorage.getItem("morphzwork:" + scope + ":" + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown, scope = localScope) {
  localStorage.setItem(
    "morphzwork:" + scope + ":" + key,
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
    const saved = sessionStorage.getItem("morphzwork:window");
    if (saved) return saved;
    const id = crypto.randomUUID();
    sessionStorage.setItem("morphzwork:window", id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();
export const draftKey = (key: string) => "draft:" + draftOwner + ":" + key;
export function useWorkspace() {
  const [boot, setBoot] = useState<Boot | null>(null),
    [online, setOnline] = useState(false),
    [error, setError] = useState(""),
    [authenticationRequired, setAuthenticationRequired] = useState(false);
  const current = useRef<Boot | null>(null),
    epoch = useRef(0),
    etag = useRef(""),
    refreshing = useRef<Promise<void> | null>(null);
  async function refresh() {
    if (refreshing.current) return refreshing.current;
    const version = epoch.current;
    refreshing.current = (async () => {
      try {
        const response = await fetch("/api/workspace", {
          headers: etag.current ? { "If-None-Match": etag.current } : {},
          signal: AbortSignal.timeout(6000),
        });
        if (response.status !== 304) {
          const value = bootSchema.parse(await checked(response));
          if (version !== epoch.current) return;
          // A slow snapshot must not replace newer state already rendered.
          if (
            !current.current ||
            value.workspace.revision >= current.current.workspace.revision
          ) {
            current.current = value;
            migrateLegacyLocalState(
              localStorage,
              value.centerId,
              value.principalId,
              value.capabilities.teamAuthentication,
              location.origin,
            );
            setBoot(value);
            etag.current = response.headers.get("etag") ?? "";
          }
        }
        setOnline(true);
        setError("");
      } catch (e) {
        if (version !== epoch.current) return;
        if (e instanceof RequestError && e.status === 401) {
          current.current = null;
          etag.current = "";
          setBoot(null);
          storageScope("disconnected", "anonymous");
          setAuthenticationRequired(true);
        }
        setOnline(false);
        setError(e instanceof Error ? e.message : "无法连接中心。");
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
    await checked(
      await fetch("/api/identity/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(8000),
      }),
    );
    if (refreshing.current) await refreshing.current;
    current.current = null;
    etag.current = "";
    setBoot(null);
    setAuthenticationRequired(false);
    await refresh();
  }
  async function logout() {
    if (!current.current) return;
    await checked(
      await fetch("/api/identity/logout", {
        method: "POST",
        headers: { "X-MorphzWork-Token": current.current.csrfToken },
        signal: AbortSignal.timeout(8000),
      }),
    );
    // Drop the mounted workspace and all in-memory object state immediately.
    epoch.current++;
    current.current = null;
    etag.current = "";
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
    if (!current.current) throw new Error("请先连接本机中心。");
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
      const receipt = (await checked(
        await fetch(dispatch ? "/api/messages" : "/api/commands", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-MorphzWork-Token": current.current.csrfToken,
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(8000),
        }),
      )) as Receipt;
      writeLocal(key, null);
      await refresh();
      await refresh();
      return receipt;
    } catch (e) {
      if (e instanceof RequestError) {
        // A server error can occur after commit. Keep its identity until a
        // successful receipt or a definitive client-side rejection is known.
        if (e.status < 500 && e.status !== 408) writeLocal(key, null);
        await refresh();
      }
      throw e;
    }
  }
  async function upload(file: File) {
    if (!current.current) throw new Error("尚未连接中心。");
    if (file.size > 6 * 1024 * 1024) throw new Error("图片不能超过 6 MB。");
    return checked(
      await fetch("/api/assets", {
        method: "POST",
        headers: { "X-MorphzWork-Token": current.current.csrfToken },
        body: file,
        signal: AbortSignal.timeout(15000),
      }),
    ) as Promise<{ assetId: string; mime: string }>;
  }
  async function uploadAttachment(file: File) {
    if (!current.current) throw new Error("尚未连接中心。");
    if (file.size > 20 * 1024 * 1024) throw new Error("附件不能超过 20 MB。");
    return checked(
      await fetch("/api/attachments", {
        method: "POST",
        headers: {
          "X-MorphzWork-Token": current.current.csrfToken,
          "X-File-Name": encodeURIComponent(file.name.slice(0, 180)),
        },
        body: file,
        signal: AbortSignal.timeout(30000),
      }),
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
    if (!current.current) throw new Error("尚未连接中心。");
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
    const receipt = (await checked(
      await fetch("/api/import/pdf", {
        method: "POST",
        headers: {
          "X-MorphzWork-Token": current.current.csrfToken,
          "X-Command-Id": commandId,
          "X-Project-Id": projectId,
          "X-Source-Path": encodeURIComponent(relativePath),
        },
        body: file,
        signal: AbortSignal.timeout(30_000),
      }),
    )) as Receipt;
    writeLocal(key, null);
    await refresh();
    await refresh();
    return receipt;
  }
  async function dispatchInput(inputId: string) {
    if (!current.current) throw new Error("请先连接本机中心。");
    await checked(
      await fetch(`/api/inputs/${encodeURIComponent(inputId)}/send`, {
        method: "POST",
        headers: { "X-MorphzWork-Token": current.current.csrfToken },
        signal: AbortSignal.timeout(8000),
      }),
    );
    await refresh();
    await refresh();
  }
  async function verifyArtifact(id: string) {
    const data = bootSchema.parse(
      await checked(
        await fetch("/api/workspace", {
          cache: "no-store",
          signal: AbortSignal.timeout(6000),
        }),
      ),
    );
    if (!data.workspace.artifacts.some((a) => a.id === id))
      throw new Error("事项不可用或已无访问权限。");
  }
  async function cancelInput(inputId: string) {
    if (!current.current) throw new Error("请先连接中心。");
    await checked(
      await fetch(`/api/inputs/${encodeURIComponent(inputId)}/cancel`, {
        method: "POST",
        headers: { "X-MorphzWork-Token": current.current.csrfToken },
        signal: AbortSignal.timeout(8000),
      }),
    );
    await refresh();
    await refresh();
  }
  async function search(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const params = new URLSearchParams({ q: request.query });
    if (request.projectId) params.set("projectId", request.projectId);
    if (request.limit !== undefined) params.set("limit", String(request.limit));
    if (request.offset !== undefined)
      params.set("offset", String(request.offset));
    return (await checked(
      await fetch("/api/search?" + params, {
        signal: signal ?? AbortSignal.timeout(6000),
      }),
    )) as SearchResult;
  }
  async function executionSnapshot(scope: ExecutionScope) {
    const params = new URLSearchParams({
      projectId: scope.projectId,
      artifactId: scope.artifactId ?? "",
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(scope.inputId ? { inputId: scope.inputId } : {}),
      ...(scope.threadId ? { threadId: scope.threadId } : {}),
    });
    return executionSnapshotSchema.parse(
      await checked(
        await fetch("/api/executions?" + params, {
          signal: AbortSignal.timeout(12000),
        }),
      ),
    );
  }
  async function taskRuntime(
    taskId: string,
    control?: {
      run: number;
      revision: number;
      action: "pause" | "resume" | "cancel";
    },
  ) {
    if (!current.current) throw new Error("尚未连接中心。");
    return checked(
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}/runtime`, {
        method: control ? "POST" : "GET",
        headers: control
          ? {
              "Content-Type": "application/json",
              "X-MorphzWork-Token": current.current.csrfToken,
            }
          : {},
        body: control ? JSON.stringify(control) : undefined,
        signal: AbortSignal.timeout(12000),
      }),
    );
  }
  async function executionResult(scope: ExecutionScope, jobId: string) {
    const params = new URLSearchParams({
      projectId: scope.projectId,
      artifactId: scope.artifactId ?? "",
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(scope.inputId ? { inputId: scope.inputId } : {}),
      jobId,
      ...(scope.threadId ? { threadId: scope.threadId } : {}),
    });
    return z
      .object({
        text: z.string(),
        truncated: z.boolean(),
        available: z.boolean(),
      })
      .parse(
        await checked(
          await fetch("/api/executions/result?" + params, {
            signal: AbortSignal.timeout(12000),
          }),
        ),
      );
  }
  async function controlExecution(command: ExecutionControl) {
    if (!current.current) throw new Error("请先连接中心。");
    return checked(
      await fetch("/api/executions/control", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MorphzWork-Token": current.current.csrfToken,
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(12000),
      }),
    );
  }
  async function speechStatus(signal?: AbortSignal) {
    return z
      .object({
        configured: z.boolean(),
        provider: z.string().min(1).nullable(),
        providerLabel: z.string().min(1).nullable().optional(),
        segmentSeconds: z.number().optional(),
      })
      .parse(await checked(await fetch("/api/speech/status", { signal })));
  }
  async function speechRequest(
    scope: SpeechScope,
    action: "transcribe" | "synthesize",
    body: Blob | string,
    signal: AbortSignal,
  ) {
    if (!current.current) throw new Error("尚未连接中心。");
    const response = await fetch("/api/speech/" + action, {
      method: "POST",
      headers: {
        "Content-Type":
          action === "transcribe" ? "audio/wav" : "application/json",
        "X-MorphzWork-Token": current.current.csrfToken,
        "X-Project-Id": scope.projectId,
        ...(scope.artifactId
          ? {
              "X-Artifact-Id": scope.artifactId,
              "X-Artifact-Revision": String(scope.revision),
            }
          : {}),
      },
      body,
      signal,
    });
    if (!response.ok) await checked(response);
    return response;
  }
  async function transcribe(
    scope: SpeechScope,
    wav: Blob,
    signal: AbortSignal,
  ) {
    return z
      .object({ text: z.string().max(30000) })
      .parse(
        await (await speechRequest(scope, "transcribe", wav, signal)).json(),
      ).text;
  }
  async function synthesize(
    scope: SpeechScope,
    text: string,
    signal: AbortSignal,
  ) {
    return (
      await speechRequest(scope, "synthesize", JSON.stringify({ text }), signal)
    ).blob();
  }
  return {
    notifications: async (
      command?:
        | { action: "settings"; mode: "all" | "high" | "off" }
        | { action: "read"; ids: string[] },
    ) => {
      if (!current.current) throw new Error("尚未连接中心。");
      return checked(
        await fetch("/api/notifications", {
          method: command ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            "X-MorphzWork-Token": current.current.csrfToken,
          },
          body: command ? JSON.stringify(command) : undefined,
          signal: AbortSignal.timeout(6000),
        }),
      );
    },
    authenticationRequired,
    login,
    logout,
    speechStatus,
    transcribe,
    synthesize,
    taskRuntime,
    boot,
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
  };
}
export type WorkspaceClient = ReturnType<typeof useWorkspace>;
export function actorName(state: Workspace, id: string) {
  return state.actants.find((a) => a.id === id)?.name ?? "未知参与者";
}
