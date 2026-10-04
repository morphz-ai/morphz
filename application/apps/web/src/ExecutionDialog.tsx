import { useModal } from "./useModal.js";
import {
  executionSnapshotJobPresentation,
  executionJobsInReadingOrder,
  executionResultSummary,
} from "./execution-presentation.js";
import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, Square, Check, FileText } from "lucide-react";
import { executionThreadGroups } from "./execution-thread-groups.js";
import { executionActivityStatus } from "./execution-activity.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { ApprovalDetails } from "./ApprovalCard.js";
import {
  type ExecutionScope,
  type ExecutionSnapshot,
  type ExecutionControl,
} from "../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "./client.js";
import { useObservedRead } from "./useObservedRead.js";
export function ExecutionDialog({
  client,
  scope,
  onClose,
  onOpen,
  embedded = false,
  hideEmpty = false,
}: {
  client: WorkspaceClient;
  scope: ExecutionScope;
  onClose: () => void;
  onOpen: (id: string) => void;
  embedded?: boolean;
  hideEmpty?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    api = useRef(client),
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
  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);
  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];
  const groups = executionThreadGroups(snapshot);
  const grouped = !!snapshot?.threads && groups.length > 1;
  const atReadLimit =
    !!snapshot && snapshot.limit > 0 && jobs.length >= snapshot.limit;
  const content = (
    <>
      {!embedded && (
        <header>
          <div>
            <h2 id="execution-title">执行记录</h2>
            <p className="muted">
              {scope.threadId ? "本次执行" : "当前对话"} · 最近{" "}
              {snapshot?.limit ?? 100} 项执行
            </p>
          </div>
          <button onClick={onClose} aria-label="关闭执行记录">
            <X />
          </button>
        </header>
      )}
      {error && (
        <p role="alert" className="delivery-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="execution-notice">
          {notice}
        </p>
      )}
      {(!embedded ||
        error ||
        !!snapshot?.jobs.length ||
        !!snapshot?.approvals.length ||
        snapshot?.threadsTruncated) && (
        <div className="execution-dialog-toolbar">
          <span className="muted">
            {!!snapshot?.approvals.length && "单次授权"}
          </span>
          {embedded && atReadLimit && (
            <small className="execution-history-bound">
              当前为最近 {snapshot!.limit} 项执行
            </small>
          )}
          {snapshot?.threadsTruncated && (
            <small className="execution-history-bound">
              部分子任务记录尚未载入
            </small>
          )}
          <button aria-label="刷新执行记录" onClick={() => void refresh()}>
            <RefreshCw />
          </button>
        </div>
      )}
      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}
      <div className="execution-list">
        {snapshot?.approvals.map((approval) => (
          <section
            className="execution-approval"
            key={approval.request.approval_id}
          >
            <ApprovalDetails approval={approval} />
            <div className="execution-actions">
              <button
                disabled={
                  !!busy ||
                  !!error ||
                  !client.online ||
                  client.approvalSubmitted(
                    approval.request.approval_id,
                    approval.fingerprint,
                  )
                }
                onClick={() =>
                  void control(
                    {
                      type: "deny",
                      approvalId: approval.request.approval_id,
                      fingerprint: approval.fingerprint,
                    },
                    grouped ? approval.request.thread_id : undefined,
                  )
                }
              >
                拒绝
              </button>
              <button
                className="primary"
                disabled={
                  !!busy ||
                  !!error ||
                  !client.online ||
                  client.approvalSubmitted(
                    approval.request.approval_id,
                    approval.fingerprint,
                  )
                }
                onClick={() =>
                  void control(
                    {
                      type: "allow-once",
                      approvalId: approval.request.approval_id,
                      fingerprint: approval.fingerprint,
                    },
                    grouped ? approval.request.thread_id : undefined,
                  )
                }
              >
                <Check />
                仅允许这一次
              </button>
            </div>
          </section>
        ))}
        {snapshot &&
          !snapshot.jobs.length &&
          !snapshot.approvals.length &&
          !grouped && (
            <p className="muted execution-empty">
              {hideEmpty ? null : "暂无工具执行记录。"}
            </p>
          )}
        {groups.map((group) => {
          const status = group.thread
            ? executionActivityStatus(group.thread, client.online && !error)
            : undefined;
          return (
            <section
              key={group.id}
              className={grouped ? "execution-thread-group" : undefined}
              data-execution-thread={group.thread?.id}
              data-thread-depth={group.depth}
              style={
                grouped
                  ? { paddingInlineStart: Math.min(group.depth, 3) * 8 }
                  : undefined
              }
            >
              {grouped && group.thread && (
                <header className="execution-thread-heading">
                  <span
                    className="execution-thread-state"
                    data-status={status?.kind}
                    title={status?.label}
                  >
                    <ExecutionStatusIcon kind={status?.kind} size={18} />
                  </span>
                  <div>
                    <small>{group.depth > 0 ? "子任务" : "主执行"}</small>
                    <strong title={group.thread.title}>
                      {group.thread.title ||
                        (group.depth > 0 ? "子任务" : "本次执行")}
                    </strong>
                  </div>
                  <span className="execution-thread-status">
                    {status?.label}
                  </span>
                </header>
              )}
              {grouped && group.thread?.summary && (
                <p className="execution-thread-summary">
                  {group.thread.summary}
                </p>
              )}
              {grouped &&
                group.depth > 0 &&
                group.thread?.lifecycle === "open" && (
                  <div className="execution-actions">
                    <button
                      disabled={!!busy || !!error || !client.online}
                      onClick={() =>
                        void control(
                          {
                            type: "cancel-thread",
                            threadId: group.thread!.id,
                            revision: group.thread!.revision,
                          },
                          group.thread!.id,
                        )
                      }
                    >
                      <Square />
                      停止此子任务
                    </button>
                  </div>
                )}
              <div
                className={grouped ? "execution-thread-timeline" : undefined}
              >
                {group.jobs.map((job) => {
                  const presentation = executionSnapshotJobPresentation(
                    job,
                    client.boot!.workspace,
                  );
                  return (
                    <section
                      key={job.id}
                      className="execution-job"
                      data-job-id={job.id}
                    >
                      <header>
                        <strong title={presentation.title}>
                          {presentation.title}
                        </strong>
                        <span className={`job-status ${job.status}`}>
                          {presentation.statusLabel}
                        </span>
                      </header>
                      {presentation.detail && (
                        <p className="execution-object">
                          {presentation.detail}
                        </p>
                      )}
                      <small className="muted">
                        {!grouped && branchIds.length > 1 && (
                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>
                        )}
                        {new Date(job.created_at).toLocaleString("zh-CN")}
                      </small>
                      {job.error && (
                        <p className="delivery-error">{job.error}</p>
                      )}
                      {presentation.result && (
                        <p
                          className="execution-step-result"
                          aria-label="返回结果解读"
                          title={presentation.result}
                        >
                          {presentation.result}
                        </p>
                      )}
                      <details>
                        <summary>技术详情</summary>
                        <pre>{JSON.stringify(job.request, null, 2)}</pre>
                        <small>执行节点：{job.target_id} · </small>
                        <small>执行 ID：{job.id}</small>
                      </details>
                      <div className="execution-actions">
                        {job.result_event_id && (
                          <button
                            disabled={!!busy}
                            onClick={() => void readResult(job.id)}
                          >
                            查看结果
                          </button>
                        )}
                        {["queued", "waiting_approval", "running"].includes(
                          job.status,
                        ) && (
                          <button
                            disabled={
                              !!busy || !!error || !!job.cancel_requested_at
                            }
                            onClick={() =>
                              void control(
                                {
                                  type: "cancel-job",
                                  jobId: job.id,
                                  revision: job.revision,
                                },
                                grouped ? job.thread_id : undefined,
                              )
                            }
                          >
                            <Square />
                            停止此项执行
                          </button>
                        )}
                        {job.exit_code !== null && (
                          <small className="muted">
                            退出码 {job.exit_code}
                          </small>
                        )}
                      </div>
                      {result?.id === job.id && (
                        <div className="execution-result">
                          {executionResultSummary(result.text) && (
                            <p>{executionResultSummary(result.text)}</p>
                          )}
                          {producedId && (
                            <button
                              onClick={() => {
                                onOpen(producedId!);
                                onClose();
                              }}
                            >
                              <FileText />
                              {client.boot?.workspace.artifacts.find(
                                (a) => a.id === producedId,
                              )?.title ??
                                client.contentCatalog.find(
                                  (entry) => entry.id === producedId,
                                )?.title ??
                                "打开成果"}
                            </button>
                          )}
                          <details>
                            <summary>完整返回内容</summary>
                            <pre>
                              {result.available
                                ? result.text || "执行返回了空内容。"
                                : "尚无最终结果。"}
                            </pre>
                          </details>
                          {result.truncated && (
                            <small>结果较长，当前显示前 64,000 个字符。</small>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
  return embedded ? (
    <section className="execution-details" aria-label="工具执行与审批">
      {content}
    </section>
  ) : (
    <dialog
      ref={dialog}
      className="create-dialog library-dialog execution-dialog"
      aria-labelledby="execution-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {content}
    </dialog>
  );
}
