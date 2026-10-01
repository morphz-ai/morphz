/** Presentation only: never rename persisted spaces or infer kind from a title. */
export function projectDisplayLabel(
  project:
    | {
        readonly kind?: "project" | "desk" | "inbox" | "dialogue";
        readonly title: string;
      }
    | undefined,
): string | undefined {
  if (!project) return undefined;
  return project.kind === "desk" ? "无项目" : project.title;
}
