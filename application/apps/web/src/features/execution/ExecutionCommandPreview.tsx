import { useId, useMemo, useState } from "react";
import type { ExecutionSnapshot } from "../../../../../packages/core/src/execution.js";
import { executionCommand } from "./execution-command.js";

/** Local disclosure only; never executes, rereads, or rewrites the command. */
export function ExecutionCommandPreview({
  job,
}: {
  job: ExecutionSnapshot["jobs"][number];
}) {
  const command = useMemo(
    () => executionCommand(job),
    [job.tool_name, job.request],
  );
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!command) return null;
  return (
    <div className="execution-command" data-expanded={expanded || undefined}>
      <pre id={id} aria-label="执行的命令">
        <code>
          {expanded ? command.value : command.preview}
          {!expanded && command.preview.length < command.value.length
            ? "…"
            : ""}
        </code>
      </pre>
      {command.expandable && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起命令" : "展开命令"}
        </button>
      )}
      {expanded && command.truncated && (
        <small>命令较长，当前显示前 12,000 个字符；完整参数见技术详情。</small>
      )}
    </div>
  );
}
