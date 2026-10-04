import { CalendarClock, RefreshCw } from "lucide-react";
import { applicationCall } from "./application-transport.js";
import { useSubjectSchedules } from "./features/subject/useSubjectSchedules.js";
import { liveArrangement } from "./subject-sidebar-model.js";
import type { WorkspaceClient } from "./client.js";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import {
  arrangementInterval,
  arrangementTime,
  runtimeArrangementLabel,
} from "./subject-schedules-model.js";

export function SubjectSchedules({
  client,
  onOpen,
  onInspect,
}: {
  client: WorkspaceClient;
  onOpen(id: string): void;
  onInspect(scope: ExecutionScope): void;
}) {
  const {
    rows,
    error,
    loading,
    more,
    activity,
    nativeError,
    nativeRows,
    refresh,
  } = useSubjectSchedules({ client, call: applicationCall });
  return (
    <section className="subject-section" aria-label="定时任务">
      <div className="subject-section-heading">
        <h3>定时任务</h3>
        <button
          className="icon-button"
          aria-label="刷新定时任务"
          disabled={loading || !client.online}
          onClick={refresh}
        >
          <RefreshCw />
        </button>
      </div>
      {(nativeError || error) && (
        <p role="alert" className="muted">
          {[nativeError ? "部分定时任务暂时无法读取。" : "", error]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      {nativeRows.map((row) => {
        const exactThread = activity?.threads.find(
          (thread) =>
            thread.id === row.threadId &&
            thread.inputId === row.inputId &&
            thread.projectId === row.projectId &&
            thread.conversationId === row.conversationId,
        );
        const content = (
          <>
            <span className="subject-record-icon">
              <CalendarClock />
            </span>
            <span>
              <strong>{row.intent}</strong>
              <small>{runtimeArrangementLabel(row)}</small>
            </span>
          </>
        );
        return exactThread ? (
          <button
            className="subject-record"
            data-schedule-id={row.scheduleId}
            key={row.scheduleId}
            onClick={() =>
              onInspect({
                projectId: row.projectId,
                conversationId: row.conversationId,
                artifactId: null,
                inputId: row.inputId,
                threadId: row.threadId,
              })
            }
          >
            {content}
          </button>
        ) : (
          <div
            className="subject-record"
            data-schedule-id={row.scheduleId}
            key={row.scheduleId}
          >
            {content}
          </div>
        );
      })}
      {activity?.schedulesTruncated && !nativeError && (
        <p className="muted">部分定时任务来源尚未核验。</p>
      )}
      {error ? null : loading ? (
        <p className="muted">读取中…</p>
      ) : rows.length ? (
        rows.map(({ task, runtime }) => {
          const run = liveArrangement(runtime, task.headVersion.runRequested)!;
          return (
            <button
              className="subject-record"
              key={task.id}
              onClick={() => onOpen(task.id)}
            >
              <span className="subject-record-icon">
                <CalendarClock />
              </span>
              <span>
                <strong>{task.title}</strong>
                <small>
                  {run.stopRequested
                    ? "停止待确认"
                    : run.controlPending
                      ? "控制待确认"
                      : run.paused || run.record!.status === "paused"
                        ? "已暂停"
                        : run.hasSourceWatch
                          ? "持续关注"
                          : run.record!.interval_seconds
                            ? arrangementInterval(run.record!.interval_seconds)
                            : "已排队"}
                  {run.record?.not_before
                    ? ` · ${arrangementTime(run.record.not_before)}`
                    : ""}
                </small>
              </span>
            </button>
          );
        })
      ) : !nativeRows.length &&
        !nativeError &&
        !activity?.schedulesTruncated ? (
        <p className="muted">暂无可确认的定时任务</p>
      ) : null}
      {more && (
        <p className="muted">事项绑定的定时任务未全部读取，请到事项查看。</p>
      )}
    </section>
  );
}
