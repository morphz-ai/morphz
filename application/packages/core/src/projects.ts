import type { Workspace } from "./model.js";

export type Project = Workspace["projects"][number];
export type ProjectStatus = "active" | "archived" | "deleted";
export function projectStatus(project: Project): ProjectStatus {
  return project.deletedAt
    ? "deleted"
    : project.archivedAt
      ? "archived"
      : "active";
}

export function projectActivity(
  state: Workspace,
  project: Project,
  messages: {
    inputId?: string | null;
    projectId: string;
    createdAt: string;
  }[] = [],
) {
  let latest = project.updatedAt ?? project.createdAt;
  const touch = (date: string) => {
    if (date > latest) latest = date;
  };
  state.artifacts
    .filter((a) => a.projectId === project.id)
    .forEach((a) => touch(a.updatedAt));
  state.scriptProductions
    .filter((p) => p.projectId === project.id)
    .forEach((p) => touch(p.updatedAt));
  state.conversations
    .filter((c) => c.projectId === project.id)
    .forEach((c) => touch(c.updatedAt));
  const inputIds = new Set(
    state.inputs
      .filter((i) => i.projectId === project.id)
      .map((i) => {
        touch(i.createdAt);
        return i.id;
      }),
  );
  messages
    .filter((m) =>
      m.inputId ? inputIds.has(m.inputId) : m.projectId === project.id,
    )
    .forEach((m) => touch(m.createdAt));
  return latest;
}

/** The existing workspace-shaped view is a presentation projection, not a
 * storage authority. Build its project card/sidebar metrics in one pass so
 * sorting projects never scans every task, input and reply per comparison. */
export function projectDirectoryMetrics(
  state: Workspace,
  messages: {
    inputId?: string | null;
    projectId: string;
    createdAt: string;
  }[] = [],
): Map<string, { activityAt: string; pendingTasks: number }> {
  const metrics = new Map(
    state.projects.map((project) => [
      project.id,
      {
        activityAt: project.updatedAt ?? project.createdAt,
        pendingTasks: 0,
      },
    ]),
  );
  const touch = (projectId: string, date: string) => {
    const entry = metrics.get(projectId);
    if (entry && date > entry.activityAt) entry.activityAt = date;
  };
  for (const artifact of state.artifacts) {
    touch(artifact.projectId, artifact.updatedAt);
    const entry = metrics.get(artifact.projectId);
    if (
      entry &&
      artifact.content.kind === "task" &&
      artifact.content.execution !== "completed" &&
      artifact.content.execution !== "cancelled"
    )
      entry.pendingTasks += 1;
  }
  for (const script of state.scriptProductions)
    touch(script.projectId, script.updatedAt);
  for (const conversation of state.conversations)
    touch(conversation.projectId, conversation.updatedAt);
  const inputProjects = new Map<string, string>();
  for (const input of state.inputs) {
    inputProjects.set(input.id, input.projectId);
    touch(input.projectId, input.createdAt);
  }
  for (const message of messages) {
    const projectId = message.inputId
      ? inputProjects.get(message.inputId)
      : message.projectId;
    if (projectId) touch(projectId, message.createdAt);
  }
  return metrics;
}
