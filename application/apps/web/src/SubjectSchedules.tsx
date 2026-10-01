import { useEffect, useState } from "react";
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

export function SubjectSchedules({
  client,
  onOpen,
}: {
  client: WorkspaceClient;
  onOpen(id: string): void;
}) {
  const [rows, setRows] = useState<
    Array<{ task: PlatformTask; runtime: TaskRuntime }>
  >([]);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false),
    [attempt, setAttempt] = useState(0);
  const identity = client.boot!.csrfToken;
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setError("");
    setLoading(true);
    if (!client.online || !client.boot!.runtime.connected) {
      setLoading(false);
      setError("连接中断，事项安排待核对。");
      return () => controller.abort();
    }
    void (async () => {
      const tasks = z
        .array(platformTaskSchema)
        .parse(
          await applicationCall(
            "tasks.list",
            { owner: "agent", limit: 50 },
            { signal: controller.signal, identityGeneration: identity },
          ),
        );
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
          onClick={() => setAttempt((n) => n + 1)}
        >
          <RefreshCw />
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : loading ? (
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
                            ? `每 ${Math.round(run.record!.interval_seconds / 60)} 分钟`
                            : "已排队"}
                </small>
              </span>
            </button>
          );
        })
      ) : (
        <p className="muted">暂无可确认的事项安排</p>
      )}
      {more && (
        <p className="muted">此处为有界事项概览，请到事项查看其余工作。</p>
      )}
    </section>
  );
}
