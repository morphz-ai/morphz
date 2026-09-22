import {
  DomainError,
  checkProject,
  type AccessContext,
  type Workspace,
} from "./model.js";

export type Project = Workspace["projects"][number];
export type ProjectStatus = "active" | "archived" | "deleted";
export function projectStatus(project: Project): ProjectStatus {
  return project.deletedAt
    ? "deleted"
    : project.archivedAt
      ? "archived"
      : "active";
}
export function assertProjectWritable(project: Project) {
  if (projectStatus(project) !== "active")
    throw new DomainError(
      "conflict",
      "项目已归档或删除，请先恢复项目。原数据与草稿仍保留。",
    );
}

/** Management is delegated by a persisted Human input, not the shared Agent identity.
 * Cross-space metadata access is limited to the same membership boundary. */
export function projectManager(
  state: Workspace,
  access: AccessContext,
  inputId?: string,
  targetId?: string,
) {
  const actor = state.actants.find(
    (a) => a.id === access.actantId && a.principalId === access.principalId,
  );
  if (!actor) throw new DomainError("forbidden", "参与者与主体不匹配。");
  const input =
    actor.kind === "agent"
      ? state.inputs.find(
          (i) => i.id === inputId && i.targetActantId === actor.id,
        )
      : undefined;
  const human =
    actor.kind === "human"
      ? actor
      : state.actants.find(
          (a) =>
            a.id === input?.author.actantId &&
            a.principalId === input.author.principalId &&
            a.kind === "human",
        );
  if (!human || (actor.kind === "agent" && !input))
    throw new DomainError("forbidden", "项目管理需要发起用户的实际输入。");
  if (input) {
    checkProject(state, input.projectId, access);
    checkProject(state, input.projectId, input.author);
  }
  if (targetId) {
    const target = checkProject(state, targetId, access);
    if (!target.members.includes(human.principalId))
      throw new DomainError("forbidden", "发起用户没有管理这个项目的权限。");
    if (input) {
      const source = checkProject(state, input.projectId, input.author);
      if (
        [...source.members].sort().join("\0") !==
        [...target.members].sort().join("\0")
      )
        throw new DomainError(
          "forbidden",
          "不能跨不同成员的工作空间管理项目，请在目标项目中提出请求。",
        );
    }
  }
  return human;
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
