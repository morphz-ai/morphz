import {
  isContentArtifact,
  type Artifact,
} from "../../../packages/core/src/model.js";

export type ContentVisit = { artifactId: string; openedAt: number };
const historyLimit = 100;

/** Personal navigation history, not creation order or Agent read activity. */
export function contentVisits(value: unknown): ContentVisit[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter((entry): entry is ContentVisit => {
      if (
        !entry ||
        typeof entry.artifactId !== "string" ||
        !entry.artifactId ||
        !Number.isFinite(entry.openedAt) ||
        entry.openedAt <= 0 ||
        !Number.isFinite(new Date(entry.openedAt).getTime()) ||
        seen.has(entry.artifactId)
      )
        return false;
      seen.add(entry.artifactId);
      return true;
    })
    .slice(0, historyLimit)
    .map(({ artifactId, openedAt }) => ({ artifactId, openedAt }));
}

export function visitContent(
  history: ContentVisit[],
  artifactId: string,
  openedAt = Date.now(),
): ContentVisit[] {
  // Event order stays correct even when the device clock moves backwards.
  return contentVisits([{ artifactId, openedAt }, ...history]);
}

export function recentContent(
  history: ContentVisit[],
  artifacts: Artifact[],
  workspaceId: string,
  limit = 4,
) {
  const available = new Map(
    artifacts
      .filter((a) => a.projectId === workspaceId && isContentArtifact(a))
      .map((a) => [a.id, a]),
  );
  return contentVisits(history)
    .flatMap((visit) => {
      const artifact = available.get(visit.artifactId);
      return artifact ? [{ artifact, openedAt: visit.openedAt }] : [];
    })
    .slice(0, limit);
}

export function contentVisitTime(openedAt: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year:
      new Date(openedAt).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(openedAt);
}
