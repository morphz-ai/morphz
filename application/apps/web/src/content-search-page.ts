import type { SearchHit } from "../../../packages/core/src/retrieval.js";
import type { WorkspaceClient } from "./client.js";
import type {
  ContentCursor,
  ContentSort,
  PlatformContent,
} from "./platform-client.js";

export type DirectoryOptions = {
  projectId?: string;
  appIds?: string[];
  kind?: string;
  kinds?: string[];
  availability?: string;
  query?: string;
  sort: ContentSort;
};
type BodyMatch = { entry: PlatformContent; hit: SearchHit };
export type ContentSearchPage = {
  titleBuffer: PlatformContent[];
  titleCursor?: ContentCursor;
  titlesDone: boolean;
  bodyBuffer: BodyMatch[];
  bodyOffset: number;
  bodiesDone: boolean;
  titleCount: number | null;
  bodyCount: number | null;
  searchError: string;
};
const PAGE_SIZE = 50;

export function emptyContentSearchPage(): ContentSearchPage {
  return {
    titleBuffer: [],
    titlesDone: false,
    bodyBuffer: [],
    bodyOffset: 0,
    bodiesDone: false,
    titleCount: null,
    bodyCount: null,
    searchError: "",
  };
}

// Match SQLite BINARY and PostgreSQL C, including supplementary characters.
// Locale/UTF-16 ordering would break the merge at a page boundary.
function compareText(a: string, b: string) {
  const left = Array.from(a),
    right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const delta = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (delta) return delta;
  }
  return left.length - right.length;
}
export function compareDirectoryContent(
  a: PlatformContent,
  b: PlatformContent,
  sort: ContentSort,
) {
  const field =
    sort === "title" ? "title" : sort === "created" ? "createdAt" : "updatedAt";
  const direction = sort === "title" ? 1 : -1;
  return (
    direction * (compareText(a[field], b[field]) || compareText(a.id, b.id))
  );
}
export function directoryCursor(
  entry: PlatformContent,
  sort: ContentSort,
): ContentCursor {
  return {
    key:
      sort === "title"
        ? entry.title
        : sort === "created"
          ? entry.createdAt
          : entry.updatedAt,
    contentId: entry.id,
  };
}

/** Merge two disjoint, authorized, sorted feeds. Never search only the first
 * directory page, copy original bodies, or hydrate the whole workspace. */
export async function readContentSearchPage(
  client: Pick<WorkspaceClient, "listContentPage" | "countContent" | "search">,
  options: DirectoryOptions,
  signal: AbortSignal,
  previous = emptyContentSearchPage(),
) {
  const state: ContentSearchPage = {
    ...previous,
    titleBuffer: [...previous.titleBuffer],
    bodyBuffer: [...previous.bodyBuffer],
  };
  async function titles() {
    if (state.titleBuffer.length || state.titlesDone) return;
    const page = await client.listContentPage(
      {
        ...options,
        limit: PAGE_SIZE + 1,
        ...(state.titleCursor ? { before: state.titleCursor } : {}),
      },
      signal,
    );
    state.titleBuffer = page.items.slice(0, PAGE_SIZE);
    state.titlesDone = page.items.length <= PAGE_SIZE;
    const last = state.titleBuffer.at(-1);
    if (last) state.titleCursor = directoryCursor(last, options.sort);
    if (state.titleCount === null) {
      const { sort: _sort, ...filter } = options;
      const counts = await client.countContent(filter, signal);
      state.titleCount = counts.reduce((sum, row) => sum + row.count, 0);
    }
  }
  async function bodies() {
    while (!state.bodyBuffer.length && !state.bodiesDone) {
      try {
        const response = await client.search(
          {
            query: options.query!.trim(),
            includeTitles: false,
            ...(options.projectId ? { projectId: options.projectId } : {}),
            ...(options.appIds ? { appIds: options.appIds } : {}),
            ...(options.kind ? { kind: options.kind } : {}),
            ...(options.kinds ? { kinds: options.kinds } : {}),
            sort: options.sort,
            offset: state.bodyOffset,
            limit: PAGE_SIZE,
          },
          signal,
        );
        state.bodyCount = response.total;
        state.bodyOffset += response.hits.length;
        state.bodiesDone = !response.hasMore;
        if (response.hasMore && !response.hits.length)
          throw new Error("搜索分页未前进。");
        if (state.bodyOffset > 10000)
          throw new Error("匹配内容过多，请缩小搜索范围后重试。");
        if (!response.hits.length) return;
        const ids = response.hits.map((hit) => hit.artifactId);
        const { query: _query, ...filter } = options;
        const page = await client.listContentPage(
          { ...filter, contentIds: ids, limit: ids.length },
          signal,
        );
        const entries = new Map(page.items.map((entry) => [entry.id, entry]));
        state.bodyBuffer = response.hits.flatMap((hit) => {
          const entry = entries.get(hit.artifactId);
          // Revoked or moved references may disappear between the two owners.
          if (!entry) return [];
          if (
            entry.projectId !== hit.projectId ||
            entry.title !== hit.title ||
            entry.observedVersionRef !== String(hit.revision)
          )
            throw new Error("搜索期间内容已更新，请重新查找。");
          return [{ entry, hit }];
        });
      } catch (error) {
        if (signal.aborted) throw error;
        state.bodiesDone = true;
        state.bodyCount = null;
        state.searchError = "正文搜索暂不可用，当前仅显示标题匹配。";
      }
    }
  }
  const items: PlatformContent[] = [];
  const matches: SearchHit[] = [];
  while (items.length < PAGE_SIZE) {
    await Promise.all([titles(), bodies()]);
    const title = state.titleBuffer[0],
      body = state.bodyBuffer[0];
    if (!title && !body) break;
    if (
      title &&
      (!body || compareDirectoryContent(title, body.entry, options.sort) <= 0)
    )
      items.push(state.titleBuffer.shift()!);
    else {
      const match = state.bodyBuffer.shift()!;
      items.push(match.entry);
      matches.push(match.hit);
    }
  }
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("目录在查找期间发生变化，请刷新后重试。");
  return {
    items,
    matches,
    state,
    count: (state.titleCount ?? 0) + (state.bodyCount ?? 0),
    hasMore:
      !!state.titleBuffer.length ||
      !state.titlesDone ||
      !!state.bodyBuffer.length ||
      !state.bodiesDone,
  };
}
