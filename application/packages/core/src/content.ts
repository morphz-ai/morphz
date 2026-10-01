import { z } from "zod";
import {
  DomainError,
  isContentArtifact,
  type Artifact,
  type Workspace,
} from "./model.js";
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
