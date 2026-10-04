import { taskRuntimeSchema } from "../../../../packages/core/src/task-runtime.js";
import { taskRuntimeResponseStillCurrent } from "../task-runtime-projection.js";
import type { applicationCall } from "../application-transport.js";
import type { Boot } from "../client.js";
import type { PlatformClient } from "../platform-client.js";

export type TaskInteractionPorts = {
  current: { current: Boot | null };
  platform: {
    readonly current: Pick<
      PlatformClient,
      "boot" | "taskHead" | "allTaskResponses"
    > | null;
  };
  taskRuntimeReads: { readonly current: Map<string, number> };
  taskRuntimeReadGeneration: { current: number };
  call: typeof applicationCall;
  publishBoot(value: Boot): void;
};

/** The original task-head, snapshot/control and response algorithms. Borrow the
 * Client's refs without reading them during construction. Observation scheduling,
 * authorization, refresh and clearing remain with their original owners.
 */
export function createTaskInteractions({
  current,
  platform,
  taskRuntimeReads,
  taskRuntimeReadGeneration,
  call: applicationCall,
  publishBoot: setBoot,
}: TaskInteractionPorts) {
  async function verifyArtifact(id: string) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，事项未读取。");
    // A notification can point to an authorized task outside the current
    // page. The presentation cache is not an authorization decision.
    await source.taskHead(id, AbortSignal.timeout(8000));
    if (current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，事项未读取。");
  }
  async function taskRuntime(
    taskId: string,
    control?: {
      run: number;
      revision: number;
      action: "pause" | "resume" | "cancel" | "stop";
    },
    observation?: { signal?: AbortSignal; isCurrent?: () => boolean },
  ) {
    const origin = current.current;
    if (!origin) throw new Error("应用尚未就绪，请稍后重试。");
    const generation = ++taskRuntimeReadGeneration.current;
    taskRuntimeReads.current.set(taskId, generation);
    try {
      const view = taskRuntimeSchema.parse(
        await applicationCall(
          control ? "task.control" : "task.snapshot",
          control ? { id: taskId, ...control } : taskId,
          {
            identityGeneration: origin.csrfToken,
            signal: observation?.signal
              ? AbortSignal.any([
                  observation.signal,
                  AbortSignal.timeout(12000),
                ])
              : AbortSignal.timeout(12000),
          },
        ),
      );
      observation?.signal?.throwIfAborted();
      // List and detail reads supply the same board/filter projection. These
      // observations never authorize operations or introduce a storage authority.
      if (
        taskRuntimeReads.current.get(taskId) === generation &&
        (observation?.isCurrent?.() ?? true) &&
        taskRuntimeResponseStillCurrent(origin, current.current, taskId) &&
        JSON.stringify(current.current!.taskRuns[taskId]) !==
          JSON.stringify(view)
      ) {
        const updated = {
          ...current.current!,
          taskRuns: { ...current.current!.taskRuns, [taskId]: view },
        };
        current.current = updated;
        setBoot(updated);
      }
      return view;
    } finally {
      if (taskRuntimeReads.current.get(taskId) === generation)
        taskRuntimeReads.current.delete(taskId);
    }
  }
  async function taskResponses(taskId: string) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，无法读取事项回应。");
    return (
      await source.allTaskResponses(taskId, AbortSignal.timeout(12000))
    ).map((response) => ({
      id: response.id,
      taskId: response.taskId,
      taskRevision: response.taskRevision,
      body: response.body,
      author: {
        principalId: response.authorPrincipalId,
        actantId: response.authorActantId,
      },
      createdAt: response.createdAt,
    }));
  }
  return { verifyArtifact, taskRuntime, taskResponses };
}
