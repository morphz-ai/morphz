import { z } from "zod";
import { interactiveText } from "./interactive.js";
import {
  checkProject,
  getArtifact,
  DomainError,
  id,
  type Workspace,
  type AccessContext,
  type Artifact,
  type Content,
} from "./model.js";

export const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    projectId: id.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export type SearchRequest = z.input<typeof searchSchema>;
export type SearchHit = {
  artifactId: string;
  projectId: string;
  projectTitle: string;
  title: string;
  kind: Content["kind"];
  revision: number;
  excerpt: string;
  matchedIn: "title" | "content";
  quote: string;
  updatedAt: string;
  source: Artifact["source"];
  page?: number;
};
export type SearchResult = {
  hits: SearchHit[];
  total: number;
  hasMore: boolean;
  workspaceRevision: number;
};

export function contentText(content: Content): string {
  switch (content.kind) {
    case "document":
      return content.markdown;
    case "pdf":
      return content.pages.join("\n\n");
    case "image":
      return content.alt;
    case "task":
      return content.description;
    case "website":
      return content.url + "\n" + content.description;
    case "interactive":
      return interactiveText(content);
  }
}

function assertActor(state: Workspace, access: AccessContext) {
  if (
    !state.actants.some(
      (a) => a.id === access.actantId && a.principalId === access.principalId,
    )
  )
    throw new DomainError("forbidden", "参与者与主体不匹配。");
}

/** One authorized read path for UI references and future Agent tools. */
export function readArtifact(
  state: Workspace,
  artifactId: string,
  access: AccessContext,
  revision?: number,
) {
  assertActor(state, access);
  const artifact = getArtifact(state, artifactId);
  checkProject(state, artifact.projectId, access);
  const version = artifact.versions.find(
    (v) => v.revision === (revision ?? artifact.revision),
  );
  if (!version) throw new DomainError("not_found", "对象版本不存在。");
  return {
    artifactId: artifact.id,
    projectId: artifact.projectId,
    source: artifact.source,
    ...version,
  };
}

/** Returns only authorized results, excerpts and counts, never a global count. */
export function searchArtifacts(
  state: Workspace,
  raw: SearchRequest,
  access: AccessContext,
): SearchResult {
  assertActor(state, access);
  const request = searchSchema.parse(raw);
  if (request.projectId) checkProject(state, request.projectId, access);
  const projects = new Map(
    state.projects
      .filter(
        (p) =>
          p.members.includes(access.principalId) &&
          (!request.projectId || p.id === request.projectId),
      )
      .map((p) => [p.id, p]),
  );
  const needle = request.query.toLocaleLowerCase();
  const found: SearchHit[] = [];
  for (const artifact of state.artifacts) {
    const project = projects.get(artifact.projectId);
    if (!project) continue;
    const pdfPage =
      artifact.content.kind === "pdf"
        ? Math.max(
            0,
            artifact.content.pages.findIndex((page) =>
              page.toLocaleLowerCase().includes(needle),
            ),
          )
        : undefined;
    const text =
      artifact.content.kind === "pdf"
        ? artifact.content.pages[pdfPage!]!
        : contentText(artifact.content);
    const inTitle = artifact.title.toLocaleLowerCase().includes(needle);
    const index = text.toLocaleLowerCase().indexOf(needle);
    if (!inTitle && index < 0) continue;
    // Return exact original text for revision-bound quoting; no lossy normalization.
    const start = Math.max(0, index - 72);
    const quote = text.slice(start, start + 260);
    found.push({
      artifactId: artifact.id,
      projectId: project.id,
      projectTitle: project.title,
      title: artifact.title,
      kind: artifact.content.kind,
      revision: artifact.revision,
      excerpt:
        (start ? "…" : "") + quote + (start + 260 < text.length ? "…" : ""),
      matchedIn: inTitle ? "title" : "content",
      quote,
      updatedAt: artifact.updatedAt,
      source: artifact.source,
      ...(pdfPage !== undefined ? { page: pdfPage + 1 } : {}),
    });
  }
  found.sort(
    (a, b) =>
      Number(b.matchedIn === "title") - Number(a.matchedIn === "title") ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.artifactId.localeCompare(b.artifactId),
  );
  return {
    hits: found.slice(request.offset, request.offset + request.limit),
    total: found.length,
    hasMore: request.offset + request.limit < found.length,
    workspaceRevision: state.revision,
  };
}
