import { useId, useState, type ReactNode } from "react";
import { CircleCheck, Code2, Eye, Square } from "lucide-react";
import type { ExecutionSnapshot } from "../../../../../packages/core/src/execution.js";
import type { executionSnapshotJobPresentation } from "../../execution-presentation.js";
import { RunningActivityIcon } from "../../RunningActivityIcon.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { ExecutionRequestDetails } from "./ExecutionDataView.js";

/** Display only. The inspection controller/caller owns scope, authorization,
 * requests and receipts; opening technical details is local view state. */
export function ExecutionJobCard({
  job,
  presentation,
  branchNumber,
  busy,
  stopDisabled,
  resultAvailable,
  onReadResult,
  onStop,
  children,
}: {
  job: ExecutionSnapshot["jobs"][number];
  presentation: ReturnType<typeof executionSnapshotJobPresentation>;
  branchNumber?: number;
  busy: boolean;
  stopDisabled: boolean;
  resultAvailable: boolean;
  onReadResult: () => void;
  onStop: () => void;
  children?: ReactNode;
}) {
  const [technical, setTechnical] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const technicalId = useId();
  const resultId = useId();
  const resultVisible = resultExpanded && Boolean(children);
  const stoppable = ["queued", "waiting_approval", "running"].includes(
    job.status,
  );
  return (
    <section className="execution-job" data-job-id={job.id}>
      <header>
        <strong title={presentation.title}>{presentation.title}</strong>
        {job.status === "succeeded" ? (
          <Tooltip label={presentation.statusLabel}>
            <span
              className="job-status succeeded"
              role="img"
              aria-label={presentation.statusLabel}
            >
              <CircleCheck size={16} aria-hidden="true" />
            </span>
          </Tooltip>
        ) : (
          <span className={`job-status ${job.status}`}>
            {job.status === "running" && !job.cancel_requested_at && (
              <RunningActivityIcon />
            )}
            {presentation.statusLabel}
          </span>
        )}
      </header>
      {presentation.detail && (
        <p className="execution-object">{presentation.detail}</p>
      )}
      {job.error && <p className="delivery-error">{job.error}</p>}
      {presentation.result && (
        <p
          className="execution-step-result"
          aria-label="返回结果解读"
          title={presentation.result}
        >
          {presentation.result}
        </p>
      )}
      <div className="execution-step-meta">
        <small className="execution-step-time">
          {branchNumber !== undefined && <>分支 {branchNumber} · </>}
          <time dateTime={job.created_at}>
            {new Date(job.created_at).toLocaleString("zh-CN")}
          </time>
        </small>
        <div className="execution-step-actions">
          <Tooltip label="技术详情">
            <button
              type="button"
              aria-label="技术详情"
              aria-expanded={technical}
              aria-controls={technicalId}
              onClick={() => setTechnical(!technical)}
            >
              <Code2 size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          {job.result_event_id && (
            <Tooltip label="查看结果">
              <button
                type="button"
                aria-label="查看结果"
                aria-expanded={resultVisible}
                aria-controls={resultId}
                disabled={busy}
                onClick={() => {
                  if (resultVisible) setResultExpanded(false);
                  else {
                    setResultExpanded(true);
                    // A final receipt already belongs to this exact job/scope.
                    // Collapse is local; an unfinished receipt must be reread.
                    if (!resultAvailable) onReadResult();
                  }
                }}
              >
                <Eye size={16} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          {stoppable && (
            <Tooltip label="停止此项执行">
              <button
                type="button"
                className="execution-step-stop"
                aria-label="停止此项执行"
                disabled={stopDisabled}
                onClick={onStop}
              >
                <Square size={12} fill="currentColor" aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {job.exit_code != null && job.exit_code !== 0 && (
        <small className="execution-exit-code">退出码 {job.exit_code}</small>
      )}
      {technical && (
        <div className="execution-technical" id={technicalId}>
          <ExecutionRequestDetails job={job} />
        </div>
      )}
      {resultVisible && (
        <div
          className="execution-result"
          id={resultId}
          role="region"
          aria-label="返回结果"
        >
          {children}
        </div>
      )}
    </section>
  );
}
