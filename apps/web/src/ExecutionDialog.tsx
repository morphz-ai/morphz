import { useModal } from "./useModal.js";
import { isObjectToolName } from "../../../packages/core/src/application-names.js";
import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, Square, Check, Shield, FileText } from "lucide-react";
import {
  jobStatusLabel,
  type ExecutionScope,
  type ExecutionSnapshot,
  type ExecutionControl,
} from "../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "./client.js";
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
    mounted = useRef(true),
    loading = useRef(false);
  api.current = client;
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const [result, setResult] = useState<{
    id: string;
    text: string;
    truncated: boolean;
    available: boolean;
  } | null>(null);
  async function refresh() {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await api.current.executionSnapshot(scope);
      if (mounted.current) {
        setSnapshot(next);
        setError("");
      }
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : "无法读取执行状态。");
    } finally {
      loading.current = false;
    }
  }
  useModal(dialog, undefined, !embedded);
  useEffect(() => {
    mounted.current = true;

    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  async function control(action: ExecutionControl["action"]) {
    setBusy(
      action.type === "cancel-job"
        ? action.jobId
        : action.type === "cancel-thread"
          ? action.threadId
          : action.approvalId,
    );
    setNotice("");
    try {
      await api.current.controlExecution({ scope, action });
      if (mounted.current)
        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof Error
            ? error.message
            : "结果未确认，请核对最新状态。",
        );
    } finally {
      if (mounted.current) {
        setBusy("");
        void refresh();
      }
    }
  }
  async function readResult(id: string) {
    setBusy(id);
    try {
      const value = await api.current.executionResult(scope, id);
      if (mounted.current) setResult({ id, ...value });
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : "无法读取结果。");
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  let producedId: string | undefined;
  if (result) {
    try {
      const data = JSON.parse(result.text);
      if (
        data.ok === true &&
        typeof data.artifactId === "string" &&
        client.boot?.workspace.artifacts.some(
          (a) => a.id === data.artifactId && a.projectId === scope.projectId,
        )
      )
        producedId = data.artifactId;
    } catch {
      /* Ordinary tool output need not be JSON. */
    }
  }
  const content = (
    <>
      {!embedded && (
        <header>
          <div>
            <h2 id="execution-title">执行记录</h2>
            <p className="muted">
              当前对话 · 最近 {snapshot?.limit ?? 100} 项执行
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
        !!snapshot?.approvals.length) && (
        <div className="execution-dialog-toolbar">
          <span className="muted">
            {!!snapshot?.approvals.length && "单次授权"}
          </span>
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
            <h3>
              <Shield />
              需要你的批准
            </h3>
            <p>{approval.request.justification}</p>
            <details>
              <summary>查看操作及权限范围</summary>
              <pre>
                {JSON.stringify(
                  {
                    action: approval.request.action,
                    requested: approval.request.requested,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <div className="execution-actions">
              <button
                disabled={!!busy || !!error}
                onClick={() =>
                  void control({
                    type: "deny",
                    approvalId: approval.request.approval_id,
                    fingerprint: approval.fingerprint,
                  })
                }
              >
                拒绝
              </button>
              <button
                className="primary"
                disabled={!!busy || !!error}
                onClick={() =>
                  void control({
                    type: "allow-once",
                    approvalId: approval.request.approval_id,
                    fingerprint: approval.fingerprint,
                  })
                }
              >
                <Check />
                仅允许这一次
              </button>
            </div>
          </section>
        ))}
        {snapshot && !snapshot.jobs.length && !snapshot.approvals.length && (
          <p className="muted execution-empty">
            {hideEmpty ? null : "暂无工具执行记录。"}
          </p>
        )}
        {snapshot?.jobs.map((job) => (
          <section key={job.id} className="execution-job">
            <header>
              <strong>
                {isObjectToolName(job.tool_name)
                  ? "操作工作对象"
                  : job.tool_name}
              </strong>
              <span className={`job-status ${job.status}`}>
                {job.cancel_requested_at &&
                ["queued", "waiting_approval", "running"].includes(job.status)
                  ? "正在停止"
                  : jobStatusLabel[job.status]}
              </span>
            </header>
            <small className="muted">
              {new Set(snapshot.jobs.map((j) => j.thread_id)).size > 1 && (
                <>
                  分支{" "}
                  {[...new Set(snapshot.jobs.map((j) => j.thread_id))].indexOf(
                    job.thread_id,
                  ) + 1}{" "}
                  ·{" "}
                </>
              )}
              {new Date(job.created_at).toLocaleString("zh-CN")}
            </small>
            {job.error && <p className="delivery-error">{job.error}</p>}
            <details>
              <summary>操作详情</summary>
              <pre>{JSON.stringify(job.request, null, 2)}</pre>
              <small>执行目标：{job.target_id} · </small>
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
                  disabled={!!busy || !!error || !!job.cancel_requested_at}
                  onClick={() =>
                    void control({
                      type: "cancel-job",
                      jobId: job.id,
                      revision: job.revision,
                    })
                  }
                >
                  <Square />
                  停止此项执行
                </button>
              )}
              {job.exit_code !== null && (
                <small className="muted">退出码 {job.exit_code}</small>
              )}
            </div>
            {result?.id === job.id && (
              <div className="execution-result">
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
                    )?.title ?? "打开成果"}
                  </button>
                )}
                <details>
                  <summary>技术详情</summary>
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
        ))}
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
