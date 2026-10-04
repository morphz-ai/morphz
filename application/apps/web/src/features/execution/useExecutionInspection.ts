import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  ExecutionControl,
  ExecutionScope,
  ExecutionSnapshot,
} from "../../../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "../../client.js";
import { useModal } from "../../useModal.js";
import { useObservedRead } from "../../useObservedRead.js";

type InspectionClient = Pick<
  WorkspaceClient,
  | "boot"
  | "online"
  | "workspaceChangeRevision"
  | "executionSnapshot"
  | "executionResult"
  | "controlExecution"
  | "contentCatalog"
>;

export function useExecutionInspection({
  client,
  scope,
  dialog,
  embedded,
}: {
  client: InspectionClient;
  scope: ExecutionScope;
  dialog: RefObject<HTMLDialogElement | null>;
  embedded: boolean;
}) {
  const api = useRef(client),
    mounted = useRef(true);
  api.current = client;
  const [observation, setObservation] = useState<{
      scope: string;
      snapshot: ExecutionSnapshot;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const [result, setResult] = useState<{
    id: string;
    text: string;
    truncated: boolean;
    available: boolean;
  } | null>(null);
  const observationScope = JSON.stringify([
    client.boot?.centerId,
    client.boot?.principalId,
    client.boot?.csrfToken,
    scope,
  ]);
  const currentScope = useRef(observationScope);
  currentScope.current = observationScope;
  const snapshot =
    observation?.scope === observationScope ? observation.snapshot : null;
  const refresh = useObservedRead({
    scope: observationScope,
    enabled: client.online,
    revision: client.workspaceChangeRevision,
    read: (signal) => api.current.executionSnapshot(scope, signal),
    publish: (next) => {
      setObservation({ scope: observationScope, snapshot: next });
      setError("");
    },
    failed: (cause) =>
      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),
  });
  useModal(dialog, undefined, !embedded);
  useEffect(() => {
    mounted.current = true;

    setObservation(null);
    setResult(null);
    setError("");
    setBusy("");
    setNotice("");
    return () => {
      mounted.current = false;
    };
  }, [observationScope]);
  async function control(
    action: ExecutionControl["action"],
    threadId?: string,
  ) {
    const origin = observationScope;
    const current = () => mounted.current && currentScope.current === origin;
    setBusy(
      action.type === "cancel-job"
        ? action.jobId
        : action.type === "cancel-thread"
          ? action.threadId
          : action.approvalId,
    );
    setNotice("");
    try {
      await api.current.controlExecution({
        scope: threadId ? { ...scope, threadId } : scope,
        action,
      });
      if (current())
        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");
    } catch (error) {
      if (current())
        setNotice(
          error instanceof Error
            ? error.message
            : "结果未确认，请核对最新状态。",
        );
    } finally {
      if (current()) {
        setBusy("");
        void refresh();
      }
    }
  }
  async function readResult(id: string) {
    const origin = observationScope;
    const current = () => mounted.current && currentScope.current === origin;
    setBusy(id);
    try {
      const value = await api.current.executionResult(scope, id);
      if (current()) setResult({ id, ...value });
    } catch (error) {
      if (current())
        setNotice(error instanceof Error ? error.message : "无法读取结果。");
    } finally {
      if (current()) setBusy("");
    }
  }
  let producedId: string | undefined;
  if (result) {
    try {
      const data = JSON.parse(result.text);
      if (
        data.ok === true &&
        typeof data.artifactId === "string" &&
        (client.boot?.workspace.artifacts.some(
          (a) => a.id === data.artifactId && a.projectId === scope.projectId,
        ) ||
          client.contentCatalog.some(
            (entry) =>
              entry.id === data.artifactId &&
              entry.projectId === scope.projectId,
          ))
      )
        producedId = data.artifactId;
    } catch {
      /* Ordinary tool output need not be JSON. */
    }
  }
  return {
    snapshot,
    error,
    busy,
    notice,
    result,
    producedId,
    refresh,
    control,
    readResult,
  };
}
