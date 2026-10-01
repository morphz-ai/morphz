import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import type { TaskRuntime } from "../../../packages/core/src/task-runtime.js";

type Scope = {
  centerId: string;
  principalId: string;
  actantId: string;
  csrfToken: string;
  workspace: Pick<Workspace, "artifacts">;
};
type Projection = Scope & { taskRuns: Record<string, TaskRuntime> };

function sameIdentity(a: Scope, b: Scope) {
  return (
    a.centerId === b.centerId &&
    a.principalId === b.principalId &&
    a.actantId === b.actantId &&
    a.csrfToken === b.csrfToken
  );
}

function sameTask(a?: Artifact, b?: Artifact) {
  return (
    a?.content.kind === "task" &&
    b?.content.kind === "task" &&
    a.projectId === b.projectId &&
    a.revision === b.revision &&
    a.content.runRequested === b.content.runRequested &&
    a.content.assigneeId === b.content.assigneeId
  );
}

/** Read-only UI observations. They never authorize an execution or write, and
 * must disappear when the identity, task version or execution binding changes. */
export function retainTaskRuntimeProjections(
  previous: Projection | null,
  next: Scope,
): Record<string, TaskRuntime> {
  if (!previous || !sameIdentity(previous, next)) return {};
  const before = new Map(previous.workspace.artifacts.map((a) => [a.id, a]));
  const after = new Map(next.workspace.artifacts.map((a) => [a.id, a]));
  return Object.fromEntries(
    Object.entries(previous.taskRuns).filter(([id]) =>
      sameTask(before.get(id), after.get(id)),
    ),
  );
}

export function taskRuntimeResponseStillCurrent(
  origin: Scope,
  current: Scope | null,
  taskId: string,
) {
  return (
    !!current &&
    sameIdentity(origin, current) &&
    sameTask(
      origin.workspace.artifacts.find((a) => a.id === taskId),
      current.workspace.artifacts.find((a) => a.id === taskId),
    )
  );
}
