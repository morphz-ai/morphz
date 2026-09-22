import { z } from "zod";
import {
  checkProject,
  DomainError,
  isContentArtifact,
  type AccessContext,
  type Artifact,
  type Workspace,
} from "./model.js";
import { assertProjectWritable, projectManager } from "./projects.js";
import type { ScriptProduction } from "./script-studio.js";

export const contentRefSchema = z
  .object({
    kind: z.enum(["artifact", "script"]),
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();
export type ContentRef = z.infer<typeof contentRefSchema>;
export type ContentEntry =
  | { kind: "artifact"; value: Artifact }
  | { kind: "script"; value: ScriptProduction };

/** One directory of real objects; applications do not own duplicate copies. */
export function contentEntries(state: Workspace): ContentEntry[] {
  const visible = new Set(
    state.projects.filter((p) => !p.deletedAt).map((p) => p.id),
  );
  return [
    ...state.artifacts
      .filter((a) => isContentArtifact(a) && visible.has(a.projectId))
      .map((value) => ({ kind: "artifact" as const, value })),
    ...state.scriptProductions
      .filter((p) => visible.has(p.projectId))
      .map((value) => ({ kind: "script" as const, value })),
  ];
}
export function contentEntry(
  state: Workspace,
  target: ContentRef,
): ContentEntry {
  const entry = contentEntries(state).find(
    (e) => e.kind === target.kind && e.value.id === target.id,
  );
  if (!entry) throw new DomainError("not_found", "内容不存在或已不可用。");
  return entry;
}
export function contentOwnershipTitle(project: Workspace["projects"][number]) {
  return project.kind === "desk" ? "未归项目" : project.title;
}
export function checkContentOwner(
  state: Workspace,
  projectId: string,
  access: AccessContext,
) {
  const project = checkProject(state, projectId, access);
  if (project.kind && !["project", "desk"].includes(project.kind))
    throw new DomainError(
      "invalid",
      "内容须归入项目或未归项目，不能存入对话或事项页面。",
    );
  return project;
}

export type ContentChanges = {
  title?: string;
  projectId?: string;
  newProjectTitle?: string;
};
/** Metadata and ownership are shared by GUI and Agent. Text, candidates and IDs stay intact. */
export function organizeContent(
  state: Workspace,
  targetRef: ContentRef,
  expectedRevision: number,
  changes: ContentChanges,
  access: AccessContext,
  commandId: string,
  now: string,
  originInputId?: string,
) {
  const entry = contentEntry(state, targetRef),
    object = entry.value;
  const human = projectManager(state, access, originInputId, object.projectId);
  const source = checkContentOwner(state, object.projectId, access);
  assertProjectWritable(source);
  if (object.revision !== expectedRevision)
    throw new DomainError("conflict", "内容已变化，请查看当前版本后操作。");
  if (changes.projectId && changes.newProjectTitle)
    throw new DomainError(
      "invalid",
      "请选择已有项目或新建项目，不能同时指定。",
    );
  if (changes.newProjectTitle)
    state.projects.push({
      id: commandId,
      kind: "project",
      title: changes.newProjectTitle,
      ownerPrincipalId: human.principalId,
      members: [...source.members],
      createdAt: now,
    });
  const target = checkContentOwner(
    state,
    changes.newProjectTitle ? commandId : (changes.projectId ?? source.id),
    access,
  );
  assertProjectWritable(target);
  projectManager(state, access, originInputId, target.id);
  if (
    [...source.members].sort().join("\0") !==
    [...target.members].sort().join("\0")
  )
    throw new DomainError(
      "forbidden",
      "两个项目的访问成员不同，不能直接改变内容及其历史的归属。",
    );
  if (source.id !== target.id && entry.kind === "artifact") {
    if (
      state.relations.some(
        (r) => r.fromId === object.id || r.toId === object.id,
      ) ||
      state.artifacts.some((a) =>
        a.content.kind === "task"
          ? [
              ...a.content.dependsOnIds,
              ...a.content.watchSourceIds,
              ...a.content.resultIds,
            ].includes(object.id)
          : a.content.kind === "document" &&
            a.content.understanding?.sources.some(
              (r) => r.artifactId === object.id,
            ),
      )
    )
      throw new DomainError(
        "invalid",
        "此内容有关联事项或对象，不能单独改变归属；原有关联会保留。",
      );
    entry.value.originProjectId ??= source.id;
  }
  object.projectId = target.id;
  object.title = changes.title ?? object.title;
  object.revision++;
  object.updatedAt = now;
  if (entry.kind === "artifact")
    entry.value.versions.push({
      revision: object.revision,
      projectId: object.projectId,
      title: object.title,
      content: structuredClone(entry.value.content),
      author: { ...access },
      createdAt: now,
    });
  else
    entry.value.metadataHistory.push({
      revision: object.revision,
      title: object.title,
      brief: structuredClone(entry.value.brief),
      reviewerPrincipalIds: [...entry.value.reviewerPrincipalIds],
      template: structuredClone(entry.value.template),
      author: { ...access },
      createdAt: now,
    });
  return object.id;
}
