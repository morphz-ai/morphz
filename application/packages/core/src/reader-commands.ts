import {
  bookmarkOwner,
  checkProject,
  DomainError,
  getArtifact,
  type Workspace,
  type AccessContext,
} from "./model.js";
import { readable, readingSourceId, type ReaderCommand } from "./reader.js";
import { assertProjectWritable } from "./projects.js";

/** Recheck even before a cached receipt: changed membership never restores private access. */
export function assertReaderAccess(
  state: Workspace,
  command: ReaderCommand,
  access: AccessContext,
  inputId?: string,
) {
  const owner = bookmarkOwner(state, access, inputId);
  const mark =
    "markId" in command
      ? state.readingMarks.find(
          (m) => m.id === command.markId && m.ownerPrincipalId === owner,
        )
      : undefined;
  if ("markId" in command && !mark)
    throw new DomainError("not_found", "标注不存在或不属于当前身份。");
  const artifact = getArtifact(
    state,
    "artifactId" in command ? command.artifactId : mark!.artifactId,
  );
  const project = checkProject(state, artifact.projectId, access);
  if (!project.members.includes(owner))
    throw new DomainError("forbidden", "发起用户已无权访问这份读物。");
  if (
    state.actants.find((a) => a.id === access.actantId)?.kind === "agent" &&
    state.inputs.find((i) => i.id === inputId)?.projectId !== project.id
  )
    throw new DomainError("forbidden", "阅读操作不能越出实际输入的内容范围。");
  const revision =
    "artifactRevision" in command
      ? command.artifactRevision
      : mark!.artifactRevision;
  const version = artifact.versions.find((v) => v.revision === revision);
  if (!version || !readable(version.content))
    throw new DomainError("invalid", "读物版本不存在。");
  if (
    "location" in command &&
    command.location.sourceId !==
      readingSourceId(artifact.id, revision, version.content)
  )
    throw new DomainError(
      "conflict",
      "读物来源版本已变化，原标注与草稿仍保留。",
    );
  return { owner, mark, artifact, project, version };
}

export function applyReaderCommand(
  state: Workspace,
  command: ReaderCommand,
  access: AccessContext,
  id: string,
  now: string,
  inputId?: string,
) {
  const { owner, mark, artifact, project } = assertReaderAccess(
    state,
    command,
    access,
    inputId,
  );
  assertProjectWritable(project);
  if (command.action === "mark-add") {
    if (
      command.kind !== "bookmark" &&
      (!command.quote.trim() || command.location.start === command.location.end)
    )
      throw new DomainError("invalid", "请先选择需要高亮或批注的原文。");
    if (command.kind === "note" && !command.note.trim())
      throw new DomainError("invalid", "批注内容不能为空。");
    const existing = state.readingMarks.find(
      (m) =>
        m.ownerPrincipalId === owner &&
        m.artifactId === artifact.id &&
        m.artifactRevision === command.artifactRevision &&
        !m.deletedAt &&
        m.kind === command.kind &&
        JSON.stringify(m.location) === JSON.stringify(command.location) &&
        m.note === command.note &&
        m.color === command.color,
    );
    if (existing) return existing.id;
    state.readingMarks.push({
      id,
      ownerPrincipalId: owner,
      artifactId: artifact.id,
      artifactRevision: command.artifactRevision,
      location: structuredClone(command.location),
      quote: command.quote,
      kind: command.kind,
      color: command.color,
      note: command.note,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  } else if (command.action === "save-position") {
    const previous = state.readingStates.find(
      (p) => p.ownerPrincipalId === owner && p.artifactId === artifact.id,
    );
    if ((previous?.revision ?? 0) !== command.expectedRevision)
      throw new DomainError(
        "conflict",
        "阅读进度已在另一个窗口更新，请刷新后继续。",
      );
    const next = {
      ownerPrincipalId: owner,
      artifactId: artifact.id,
      artifactRevision: command.artifactRevision,
      location: structuredClone(command.location),
      preferences: structuredClone(command.preferences),
      revision: command.expectedRevision + 1,
      updatedAt: now,
    };
    if (previous) Object.assign(previous, next);
    else state.readingStates.push(next);
    return artifact.id;
  } else {
    if (mark!.revision !== command.expectedRevision)
      throw new DomainError("conflict", "标注已更新，请查看当前内容后重试。");
    if (command.action === "mark-update") {
      if (mark!.deletedAt)
        throw new DomainError("conflict", "请先恢复此标注。");
      if (mark!.kind === "note" && !command.note.trim())
        throw new DomainError("invalid", "批注内容不能为空。");
      mark!.note = command.note;
      mark!.color = command.color;
    } else mark!.deletedAt = command.action === "mark-remove" ? now : null;
    mark!.updatedAt = now;
    mark!.revision++;
    return mark!.id;
  }
  return id;
}
