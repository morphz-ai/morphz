import { useExecutionInspection } from "./features/execution/useExecutionInspection.js";
import { ExecutionControlActions } from "./features/execution/ExecutionControlActions.js";
import { ExecutionJobCard } from "./features/execution/ExecutionJobCard.js";
import { ExecutionDataView } from "./features/execution/ExecutionDataView.js";
import { Tooltip } from "./ui/Tooltip.js";
import {
  executionSnapshotJobPresentation,
  executionJobsInReadingOrder,
  executionResultSummary,
} from "./execution-presentation.js";
import { useRef } from "react";
import { X, RefreshCw, FileText } from "lucide-react";
import { executionThreadGroups } from "./execution-thread-groups.js";
import { executionActivityStatus } from "./execution-activity.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { ApprovalDetails, ApprovalActions } from "./ApprovalCard.js";
import { type ExecutionReadScope } from "../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "./client.js";
import {
  executionModelLabel,
  executionModelDescription,
} from "./execution-model.js";
export function ExecutionDialog({
  client,
  scope,
  onClose,
  onOpen,
  embedded = false,
  hideEmpty = false,
}: {
  client: WorkspaceClient;
  scope: ExecutionReadScope;
  onClose: () => void;
  onOpen: (id: string) => void;
  embedded?: boolean;
  hideEmpty?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const {
    snapshot,
    error,
    busy,
    notice,
    result,
    producedId,
    refresh,
    control,
    readResult,
  } = useExecutionInspection({ client, scope, dialog, embedded });
  const readOnly = "runtime" in scope;
  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);
  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];
  const groups = executionThreadGroups(snapshot);
  const grouped = !!snapshot?.threads && groups.length > 1;
  const content = (
    <>
      {!embedded && (
        <header>
          <div>
            <h2 id="execution-title">执行记录</h2>
            <p className="muted">{scope.threadId ? "本次执行" : "当前对话"}</p>
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
          <span className={embedded ? "execution-steps-label" : "muted"}>
            {snapshot?.approvals.length
              ? "单次授权"
              : embedded
                ? "执行步骤"
                : ""}
          </span>
          <Tooltip label="刷新执行记录">
            <button aria-label="刷新执行记录" onClick={() => void refresh()}>
              <RefreshCw />
            </button>
          </Tooltip>
        </div>
      )}
      {snapshot?.threadsTruncated && (
        <small className="execution-history-bound">
          部分子任务记录尚未载入
        </small>
      )}
      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}
      <div className="execution-list">
        {snapshot?.approvals.map((approval) => (
          <section
            className="execution-approval"
            key={approval.request.approval_id}
          >
            <ApprovalDetails approval={approval} />
            {!readOnly && (
              <div className="execution-actions">
                <ApprovalActions
                  approval={approval}
                  jobs={snapshot.jobs}
                  disabled={
                    !!busy ||
                    !!error ||
                    !client.online ||
                    client.approvalSubmitted(
                      approval.request.approval_id,
                      approval.fingerprint,
                    )
                  }
                  onDecide={(action) =>
                    control(
                      action,
                      grouped ? approval.request.thread_id : undefined,
                    )
                  }
                />
              </div>
            )}
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
                    <small
                      title={executionModelDescription(
                        group.thread.executionModel,
                      )}
                    >
                      {executionModelLabel(group.thread.executionModel)}
                    </small>
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
              {group.thread?.lifecycle === "open" &&
                (!embedded || group.depth > 0) &&
                !(
                  "runtime" in scope &&
                  scope.runtime.delegation &&
                  group.depth > 0
                ) && (
                  <ExecutionControlActions
                    key={`${client.boot!.csrfToken}:${group.thread.id}`}
                    scope={{ ...scope, threadId: group.thread.id }}
                    stopLabel={group.depth > 0 ? "停止此子任务" : "停止"}
                    compact={group.depth === 0}
                    thread={group.thread}
                    disabled={!!busy || !!error || !client.online}
                    onControl={async (action) => {
                      await client.controlExecution({
                        scope: { ...scope, threadId: group.thread!.id },
                        action,
                      });
                      await refresh();
                    }}
                  />
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
                    <ExecutionJobCard
                      key={job.id}
                      job={job}
                      presentation={presentation}
                      branchNumber={
                        !grouped && branchIds.length > 1
                          ? branchIds.indexOf(job.thread_id) + 1
                          : undefined
                      }
                      busy={!!busy}
                      stopDisabled={
                        readOnly ||
                        !!busy ||
                        !!error ||
                        !!job.cancel_requested_at
                      }
                      readOnly={readOnly}
                      resultAvailable={
                        result?.id === job.id && result.available
                      }
                      onReadResult={() => void readResult(job.id)}
                      onStop={() =>
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
                      {result?.id === job.id && (
                        <>
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
                          <ExecutionDataView
                            label="结果"
                            text={result.available ? result.text : ""}
                            truncated={result.truncated}
                            emptyText={
                              result.available
                                ? "执行返回了空内容。"
                                : "尚无最终结果。"
                            }
                          />
                          {result.truncated && (
                            <small>结果较长，当前显示前 64,000 个字符。</small>
                          )}
                        </>
                      )}
                    </ExecutionJobCard>
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
