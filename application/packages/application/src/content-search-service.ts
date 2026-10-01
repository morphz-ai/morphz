import { DomainError } from "../../core/src/model.js";
import {
  searchExcerpt,
  searchSchema,
  searchTerms,
  contentText,
  type SearchHit,
  type SearchResult,
} from "../../core/src/retrieval.js";
import type { ObjectsStore } from "../../objects/src/store.js";
import type {
  ApplicationProviderRoute,
  PlatformActor,
  PlatformStore,
} from "../../platform/src/store.js";
import type { PlatformWorkService } from "./platform-work-service.js";

type SearchDomain = {
  platform: PlatformStore;
  objects: ObjectsStore;
  work: PlatformWorkService;
  objectsInstanceId: string;
  provider: () => ApplicationProviderRoute;
};

// PostgreSQL COLLATE C and SQLite BINARY order valid text by Unicode scalar
// value, not locale or UTF-16 surrogate pairs. IDs use the same tie-breaker.
function compareText(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  while (true) {
    const x = left.next(),
      y = right.next();
    if (x.done || y.done) return Number(y.done) - Number(x.done);
    const comparison = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (comparison) return comparison;
  }
}

type BodyMatch = {
  objectId: string;
  revision: number;
  titleMatch: 0 | 1;
  catalogRevision: number;
  contentId: string;
  projectId: string;
  title: string;
  kind: SearchHit["kind"];
  createdAt: string;
  updatedAt: string;
};

/** Federate two owners without putting app body text in Platform. Objects
 * supplies indexed candidates; Platform alone decides current visibility,
 * project association and whether the exact version has been projected.
 */
export async function searchContent(
  domain: SearchDomain,
  actor: PlatformActor,
  raw: unknown,
): Promise<SearchResult> {
  const request = searchSchema.parse(raw);
  const owner = await domain.platform.authorizePersonalApplicationAtRoute(
    actor,
    domain.objectsInstanceId,
    "morphz.objects",
    domain.provider(),
  );
  // This also validates an explicitly requested project, even when the app
  // or type filter means there can be no Objects body result.
  const titles = await domain.work.searchContentTitles(actor, {
    ...request,
    ...(request.includeTitles ? {} : { offset: 0, limit: 1 }),
  });
  const terms = searchTerms(request.query);
  const wantedTitleIds = new Set(
    request.includeTitles ? titles.hits.map((hit) => hit.artifactId) : [],
  );
  const titleQuotes = new Map<string, string>();
  const selectedBodies: BodyMatch[] = [];
  const bodyOffset = request.includeTitles
    ? Math.max(0, request.offset - titles.total)
    : request.offset;
  const bodyLimit =
    request.limit - (request.includeTitles ? titles.hits.length : 0);
  const objectKinds = [
    "document",
    "image",
    "interactive",
    "pdf",
    "publication",
    "website",
  ];
  const searchBodies =
    (!request.appIds || request.appIds.includes("morphz.objects")) &&
    (!request.kind || objectKinds.includes(request.kind)) &&
    (!request.kinds ||
      request.kinds.some((kind) => objectKinds.includes(kind)));
  let bodyTotal = 0;
  let scanned = 0;
  let after: Parameters<ObjectsStore["searchCandidates"]>[0]["after"];
  while (searchBodies) {
    const candidates = await domain.objects.searchCandidates({
      tenantId: owner.tenantId,
      query: request.query,
      limit: 50,
      includeBody: request.includeTitles,
      ...(after ? { after } : {}),
    });
    if (!candidates.length) break;
    scanned += candidates.length;
    if (scanned > 10_000)
      throw new DomainError("invalid", "匹配内容过多，请缩小搜索范围后重试。");
    const visible = await domain.platform.listContent(actor, {
      appId: "morphz.objects",
      appObjectIds: candidates.map((candidate) => candidate.objectId),
      availability: "available",
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.kind ? { kind: request.kind } : {}),
      ...(request.kinds ? { kinds: request.kinds } : {}),
      limit: 50,
    });
    const byObject = new Map(
      visible
        .filter((entry) => entry.instance_id === domain.objectsInstanceId)
        .map((entry) => [entry.app_object_id, entry]),
    );
    for (const candidate of candidates) {
      const entry = byObject.get(candidate.objectId);
      if (
        !entry ||
        entry.observed_version_ref !== String(candidate.revision) ||
        entry.title !== candidate.title
      )
        continue;
      const titleMatch = terms.every((term) =>
        entry.title.toLocaleLowerCase().includes(term),
      );
      if (titleMatch) {
        if (wantedTitleIds.has(entry.content_id))
          titleQuotes.set(entry.content_id, candidate.body);
        continue;
      }
      // Sorting is performed over bounded metadata only. Retaining every
      // candidate body until the final page would multiply large originals.
      if (
        request.sort ||
        (bodyTotal >= bodyOffset && selectedBodies.length < bodyLimit)
      )
        selectedBodies.push({
          objectId: candidate.objectId,
          revision: candidate.revision,
          titleMatch: candidate.titleMatch,
          catalogRevision: entry.revision,
          contentId: entry.content_id,
          projectId: entry.project_id,
          title: entry.title,
          kind: entry.kind as SearchHit["kind"],
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
        });
      bodyTotal++;
    }
    const last = candidates.at(-1)!;
    after = {
      objectId: last.objectId,
      updatedAt: last.updatedAt,
      titleMatch: last.titleMatch,
    };
    if (candidates.length < 50) break;
  }
  // The route may have moved while the two independent stores were queried.
  // An exact open rechecks the app version again before attaching a quote.
  await domain.platform.authorizePersonalApplicationAtRoute(
    actor,
    domain.objectsInstanceId,
    "morphz.objects",
    domain.provider(),
  );
  if (request.sort)
    selectedBodies.sort((a, b) => {
      const sort = request.sort!;
      if (sort === "title")
        return (
          compareText(a.title, b.title) || compareText(a.contentId, b.contentId)
        );
      const key = sort === "created" ? "createdAt" : "updatedAt";
      return (
        compareText(b[key], a[key]) || compareText(b.contentId, a.contentId)
      );
    });
  const bodyPage = request.sort
    ? selectedBodies.slice(bodyOffset, bodyOffset + bodyLimit)
    : selectedBodies;
  const projectTitles = new Map<string, string>();
  const bodyHits: SearchHit[] = [];
  for (const row of bodyPage) {
    // Candidates are an app-owned disposable index, never an access grant.
    // Hydrate only this page from the exact immutable original and recheck the
    // live catalog after reading it; a changed page must be searched again.
    const original = await domain.objects.readObject({
      credential: actor.credential,
      objectId: row.objectId,
      revision: row.revision,
    });
    const current = await domain.platform.content(actor, row.contentId);
    if (
      original.headRevision !== row.revision ||
      original.revision !== row.revision ||
      original.title !== row.title ||
      original.projectId !== row.projectId ||
      original.observedVersionRef !== String(row.revision) ||
      current.revision !== row.catalogRevision ||
      current.app_object_id !== row.objectId ||
      current.instance_id !== domain.objectsInstanceId ||
      current.observed_version_ref !== String(row.revision) ||
      current.title !== row.title ||
      current.project_id !== row.projectId ||
      current.kind !== row.kind ||
      current.availability !== "available"
    )
      throw new DomainError("conflict", "内容已变化，请重新搜索。");
    let projectTitle = projectTitles.get(row.projectId);
    if (!projectTitle) {
      projectTitle = (await domain.platform.getProject(actor, row.projectId))
        .title;
      projectTitles.set(row.projectId, projectTitle);
    }
    const bodyTerms = terms.filter(
      (term) => !row.title.toLocaleLowerCase().includes(term),
    );
    bodyHits.push({
      artifactId: row.contentId,
      projectId: row.projectId,
      projectTitle,
      title: row.title,
      kind: row.kind,
      revision: row.revision,
      ...searchExcerpt(
        contentText(original.content),
        bodyTerms.length ? bodyTerms : terms,
      ),
      matchedIn: request.includeTitles && row.titleMatch ? "title" : "content",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      source: null,
    });
  }
  const titleHits = (request.includeTitles ? titles.hits : []).map((hit) => {
    const body = titleQuotes.get(hit.artifactId);
    return body ? { ...hit, ...searchExcerpt(body, terms) } : hit;
  });
  const total = (request.includeTitles ? titles.total : 0) + bodyTotal;
  const hits = [...titleHits, ...bodyHits];
  return {
    hits,
    total,
    hasMore: request.offset + hits.length < total,
    workspaceRevision: titles.workspaceRevision,
  };
}
