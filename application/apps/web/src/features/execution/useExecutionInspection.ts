import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  ExecutionControl,
  ExecutionReadScope,
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
  | "executionRequest"
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
  scope: ExecutionReadScope;
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
  const pageBusy = useRef(false);
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
    invalidation: "coalesce",
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
        : "threadId" in action
          ? action.threadId
          : action.type === "cancel-delegation"
            ? (scope.threadId ?? "delegation")
            : action.approvalId,
    );
    setNotice("");
    try {
      await api.current.controlExecution({
        scope: threadId ? { ...scope, threadId } : scope,
        action,
      });
      if (current())
        setNotice(
          action.type === "pause-thread"
            ? "已暂停此执行"
            : action.type === "resume-thread"
              ? "已继续此执行"
              : action.type === "supersede-thread"
                ? "已纠正并继续此执行"
                : action.type.startsWith("cancel-")
                  ? "已请求停止"
                  : "已提交决定",
        );
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
  async function loadMore() {
    const approval = !!snapshot?.nextApprovalCursor;
    const cursor = snapshot?.nextApprovalCursor ?? snapshot?.nextJobCursor;
    if (!cursor || pageBusy.current) return;
    const origin = observationScope,
      head = snapshot;
    pageBusy.current = true;
    setBusy("page");
    try {
      const next = await api.current.executionSnapshot({
        ...scope,
        ...(approval
          ? { approvalCursor: cursor, jobCursor: undefined }
          : { jobCursor: cursor, approvalCursor: undefined }),
      });
      if (mounted.current && currentScope.current === origin)
        setObservation((previous) => {
          if (previous?.scope !== origin || previous.snapshot !== head)
            return previous;
          const rows = new Map(next.jobs.map((job) => [job.id, job]));
          for (const job of head.jobs) {
            const old = rows.get(job.id);
            if (!old || job.revision >= old.revision) rows.set(job.id, job);
          }
          const threads = new Map(
            (next.threads ?? []).map((thread) => [thread.id, thread]),
          );
          for (const thread of head.threads ?? []) {
            const old = threads.get(thread.id);
            if (!old || thread.revision >= old.revision)
              threads.set(thread.id, thread);
          }
          return {
            ...previous,
            snapshot: {
              ...head,
              jobs: [...rows.values()],
              threads: [...threads.values()],
              approvals: [
                ...new Map(
                  [...head.approvals, ...next.approvals].map((row) => [
                    row.request.approval_id,
                    row,
                  ]),
                ).values(),
              ],
              nextJobCursor: approval ? head.nextJobCursor : next.nextJobCursor,
              nextApprovalCursor: approval
                ? next.nextApprovalCursor
                : head.nextApprovalCursor,
            },
          };
        });
    } catch (cause) {
      if (mounted.current && currentScope.current === origin)
        setNotice(
          cause instanceof Error ? cause.message : "无法载入更多执行记录。",
        );
    } finally {
      pageBusy.current = false;
      if (mounted.current && currentScope.current === origin) setBusy("");
    }
  }
  async function readRequest(id: string) {
    const origin = observationScope;
    try {
      const job = await api.current.executionRequest(scope, id);
      if (mounted.current && currentScope.current === origin)
        setObservation((previous) =>
          previous?.scope === origin
            ? {
                ...previous,
                snapshot: {
                  ...previous.snapshot,
                  jobs: previous.snapshot.jobs.map((old) =>
                    old.id === id &&
                    old.session_id === job.session_id &&
                    old.thread_id === job.thread_id
                      ? { ...old, request: job.request, request_loaded: true }
                      : old,
                  ),
                },
              }
            : previous,
        );
    } catch (cause) {
      if (mounted.current && currentScope.current === origin)
        setNotice(
          cause instanceof Error ? cause.message : "无法读取工具参数。",
        );
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
    readRequest,
    loadMore,
  };
}
