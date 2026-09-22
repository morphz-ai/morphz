import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import { documentExcerpt } from "./document-presentation.js";

export const contentSorts = {
  updated: "最近修改",
  created: "最近创建",
  title: "名称",
} as const;
export type ContentSort = keyof typeof contentSorts;
export function compareContent(
  sort: ContentSort,
  a: Pick<Artifact, "id" | "title" | "createdAt" | "updatedAt">,
  b: Pick<Artifact, "id" | "title" | "createdAt" | "updatedAt">,
) {
  return (
    (sort === "title"
      ? a.title.localeCompare(b.title, "zh-CN")
      : sort === "created"
        ? b.createdAt.localeCompare(a.createdAt)
        : b.updatedAt.localeCompare(a.updatedAt)) || a.id.localeCompare(b.id)
  );
}
export function contentOrigin(
  a: Pick<Artifact, "createdBy"> & Partial<Pick<Artifact, "source">>,
  actors: Workspace["actants"],
) {
  if (a.source) return "导入副本";
  const author = actors.find(
    (actor) =>
      actor.id === a.createdBy.actantId &&
      actor.principalId === a.createdBy.principalId,
  );
  return author
    ? `${author.name}${author.kind === "agent" ? "生成" : "创建"}`
    : "作者未知";
}
export function relatedContentTasks(
  a: Artifact,
  objects: Artifact[],
  relations: Workspace["relations"],
) {
  return objects.filter(
    (task) =>
      task.content.kind === "task" &&
      (task.content.resultIds.includes(a.id) ||
        relations.some(
          (r) =>
            r.type === "produces" && r.fromId === task.id && r.toId === a.id,
        )),
  );
}
/** A bounded excerpt of actual text, not an invented AI summary. */
export function catalogExcerpt(a: Artifact) {
  if (a.content.kind === "document") {
    const markdown = a.content.markdown
      .slice(0, 1600)
      .replace(/^(?:#{1,6}\s*)?(?:使用说明|说明|目录)\s*$/gmu, "");
    return documentExcerpt(markdown, a.title);
  }
  if (a.content.kind === "website") return a.content.description;
  if (a.content.kind === "image") return a.content.alt;
  return "";
}
