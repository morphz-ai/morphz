import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CalendarClock, RefreshCw } from "lucide-react";
import { applicationCall } from "./application-transport.js";
import { platformTaskSchema, type PlatformTask } from "./platform-client.js";
import {
  taskRuntimeSchema,
  type TaskRuntime,
} from "../../../packages/core/src/task-runtime.js";
import { liveArrangement } from "./subject-sidebar-model.js";
import type { WorkspaceClient } from "./client.js";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import {
  arrangementInterval,
  arrangementTime,
  runtimeArrangements,
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
  const [rows, setRows] = useState<
    Array<{ task: PlatformTask; runtime: TaskRuntime }>
  >([]);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false),
    [attempt, setAttempt] = useState(0);
  const refreshedAttempt = useRef(0);
  const identity = client.boot!.csrfToken;
  const activity = client.boot!.runtime.activity;
  const connected = client.online && client.boot!.runtime.connected;
  const nativeError =
    !connected || !activity?.available || !activity.schedulesAvailable;
  const covered = new Set(
    rows.flatMap(({ task, runtime }) => {
      const run = liveArrangement(runtime, task.headVersion.runRequested);
      return run?.record?.id ? [run.record.id] : [];
    }),
  );
  const nativeRows = runtimeArrangements(activity, connected, covered);
  useEffect(() => {
    const controller = new AbortController();
    const explicitRefresh = attempt !== refreshedAttempt.current;
    refreshedAttempt.current = attempt;
    setRows([]);
    setError("");
    setLoading(true);
    setMore(false);
    if (!client.online || !client.boot!.runtime.connected) {
      setLoading(false);
      setError("连接中断，事项安排待核对。");
      return () => controller.abort();
    }
    void (async () => {
      if (explicitRefresh) {
        await applicationCall(
          "runtime.navigation",
          { refreshActivity: true },
          {
            signal: controller.signal,
            identityGeneration: identity,
          },
        );
        if (controller.signal.aborted) return;
        await client.refresh();
        if (controller.signal.aborted) return;
      }
      const tasks = z
        .array(platformTaskSchema)
        .parse(
          await applicationCall(
            "tasks.list",
            { owner: "agent", limit: 50 },
            { signal: controller.signal, identityGeneration: identity },
          ),
        );
      if (controller.signal.aborted) return;
      const candidates = tasks.filter(
        (task) => task.headVersion.runRequested > 0,
      );
      setMore(tasks.length >= 50 || candidates.length > 16);
      const observations: Array<{ task: PlatformTask; runtime: TaskRuntime }> =
        [];
      // Bounded read-only inspection; do not fan out one request for every task.
      for (
        let offset = 0;
        offset < Math.min(candidates.length, 16);
        offset += 4
      ) {
        observations.push(
          ...(await Promise.all(
            candidates.slice(offset, offset + 4).map(async (task) => ({
              task,
              runtime: taskRuntimeSchema.parse(
                await applicationCall("task.snapshot", task.id, {
                  signal: controller.signal,
                  identityGeneration: identity,
                }),
              ),
            })),
          )),
        );
      }
      for (const { task, runtime } of observations) {
        const readError =
          runtime.error ||
          runtime.runs.find((run) => run.run === task.headVersion.runRequested)
            ?.error;
        if (readError) throw new Error(`事项安排读取失败：${readError}`);
      }
      if (!controller.signal.aborted)
        setRows(
          observations.filter(({ task, runtime }) =>
            liveArrangement(runtime, task.headVersion.runRequested),
          ),
        );
    })()
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "事项安排暂时无法读取。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [identity, attempt, client.online, client.boot!.runtime.connected]);
  return (
    <section className="subject-section" aria-label="事项安排">
      <div className="subject-section-heading">
        <h3>事项安排</h3>
        <button
          className="icon-button"
          aria-label="刷新事项安排"
          disabled={loading || !client.online}
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          <RefreshCw />
        </button>
      </div>
      {(nativeError || error) && (
        <p role="alert" className="muted">
          {[nativeError ? "原生安排暂时无法读取。" : "", error]
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
        <p className="muted">安排概览有界，部分来源尚未核验。</p>
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
        <p className="muted">暂无可确认的事项安排</p>
      ) : null}
      {more && (
        <p className="muted">此处为有界事项概览，请到事项查看其余工作。</p>
      )}
    </section>
  );
}
