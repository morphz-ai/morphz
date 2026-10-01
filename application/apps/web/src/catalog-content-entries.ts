import {
  contentEntries,
  type ContentEntry,
} from "../../../packages/core/src/content.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import type { PlatformContent } from "./platform-client.js";

export type CatalogContentEntry =
  ContentEntry | { kind: "catalog"; value: PlatformContent };

/** The Platform directory locates objects; only the owning app supplies bodies. */
export function catalogContentEntries(
  state: Workspace,
  catalog: readonly PlatformContent[] = [],
): CatalogContentEntry[] {
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const loaded = contentEntries(state).filter((entry) => {
    const id =
      entry.kind === "script"
        ? (entry.value.contentId ?? entry.value.id)
        : entry.value.id;
    const current = catalogById.get(id);
    return (
      !!current &&
      current.revision === entry.value.catalogRevision &&
      current.title === entry.value.title &&
      current.projectId === entry.value.projectId
    );
  });
  const seen = new Set(
    loaded.map((entry) =>
      entry.kind === "script"
        ? (entry.value.contentId ?? entry.value.id)
        : entry.value.id,
    ),
  );
  const visible = new Set(
    state.projects.filter((project) => !project.deletedAt).map(({ id }) => id),
  );
  return [
    ...loaded,
    ...catalog
      .filter(
        (entry) =>
          !seen.has(entry.id) &&
          visible.has(entry.projectId) &&
          ["morphz.objects", "morphz.reader", "morphz.script-studio"].includes(
            entry.appId,
          ),
      )
      .map((value) => ({ kind: "catalog" as const, value })),
  ];
}

export function listingKind(entry: CatalogContentEntry) {
  return entry.kind === "catalog"
    ? entry.value.kind
    : entry.kind === "script"
      ? "script"
      : entry.value.content.kind;
}

export function listingRevision(entry: CatalogContentEntry) {
  return entry.kind === "catalog"
    ? Number(entry.value.observedVersionRef) || 0
    : entry.value.revision;
}
