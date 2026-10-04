import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { applicationCall } from "../../application-transport.js";
import {
  platformTaskSchema,
  type PlatformTask,
} from "../../platform-client.js";
import {
  taskRuntimeSchema,
  type TaskRuntime,
} from "../../../../../packages/core/src/task-runtime.js";
import { liveArrangement } from "../../subject-sidebar-model.js";
import { runtimeArrangements } from "../../subject-schedules-model.js";
import type { WorkspaceClient } from "../../client.js";

export type SubjectSchedulesClient = Pick<
  WorkspaceClient,
  "boot" | "online" | "refresh"
>;
export type SubjectScheduleGateway = (
  method: "runtime.navigation" | "tasks.list" | "task.snapshot",
  params: unknown,
  options: NonNullable<Parameters<typeof applicationCall>[2]>,
) => ReturnType<typeof applicationCall>;

/** Own the original bounded, read-only schedule observation lifecycle.
 * The render client and logical gateway are borrowed, not mirrored or rebound.
 * Explicit navigation and execution controls remain with the renderer.
 */
export function useSubjectSchedules({
  client,
  call: applicationCall,
}: {
  client: SubjectSchedulesClient;
  call: SubjectScheduleGateway;
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
      setError("连接中断，定时任务待核对。");
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
        if (readError) throw new Error(`定时任务读取失败：${readError}`);
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
          setError(e instanceof Error ? e.message : "定时任务暂时无法读取。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [identity, attempt, client.online, client.boot!.runtime.connected]);
  const refresh = () => {
    setAttempt((n) => n + 1);
  };
  return {
    rows,
    error,
    loading,
    more,
    activity,
    nativeError,
    nativeRows,
    refresh,
  } as const;
}
