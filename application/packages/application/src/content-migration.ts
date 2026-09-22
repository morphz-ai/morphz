import {
  DomainError,
  isPublicUnderstanding,
  type Workspace,
} from "../../core/src/model.js";

/** One-time ownership correction, not a read-time alias or a second storage model.
 * Exchange records and their immutable execution scopes are historical evidence.
 * They are not destinations for newly created content. */
export function migrateContentOwnership(state: Workspace) {
  let changed = false;
  for (const source of state.projects.filter(
    (p) => p.kind === "dialogue" || p.kind === "inbox",
  )) {
    const target = state.projects.find(
      (p) =>
        p.kind === "desk" && p.ownerPrincipalId === source.ownerPrincipalId,
    );
    if (
      !target ||
      [...target.members].sort().join("\0") !==
        [...source.members].sort().join("\0")
    )
      throw new DomainError(
        "conflict",
        "个人内容归属迁移的权限边界不一致，未改动原数据。",
      );
    for (const artifact of state.artifacts.filter(
      (a) => a.projectId === source.id && !isPublicUnderstanding(a),
    )) {
      artifact.projectId = target.id;
      if (artifact.originProjectId === source.id)
        artifact.originProjectId = target.id;
      for (const version of artifact.versions)
        if (version.projectId === source.id) version.projectId = target.id;
      changed = true;
    }
    for (const production of state.scriptProductions.filter(
      (p) => p.projectId === source.id,
    )) {
      production.projectId = target.id;
      changed = true;
    }
  }
  for (const personal of state.projects.filter((p) => p.kind === "desk")) {
    if (personal.title !== "未归项目") {
      personal.title = "未归项目";
      changed = true;
    }
  }
  if (changed) state.revision++;
}
