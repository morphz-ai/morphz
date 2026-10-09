import { ArrowUpRight } from "lucide-react";
import type { ActivityStatus } from "./execution-activity.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";

/** Message navigation, not a Thread-success glyph. Authority and exact input
 * identity remain with the caller; this component only presents the link. */
export function MessageActivityLink({
  status,
  live,
  onOpen,
}: Readonly<{
  status: ActivityStatus;
  live: boolean;
  onOpen: () => void;
}>) {
  return (
    <button
      type="button"
      className={live ? "message-activity-access" : "message-activity-record"}
      data-status={status.kind}
      aria-label={`查看执行活动：${status.label}`}
      title={`${status.label} · 查看这条消息的执行记录`}
      onClick={onOpen}
    >
      {live ? (
        "查看执行活动"
      ) : (
        <span className="message-activity-glyph">
          {status.kind === "ended" ? (
            <ArrowUpRight size={14} aria-hidden="true" />
          ) : (
            <ExecutionStatusIcon kind={status.kind} size={18} />
          )}
        </span>
      )}
    </button>
  );
}
