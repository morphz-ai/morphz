import { useEffect, useRef, useState } from "react";
import type {
  ContentCursor,
  ContentSort,
  PlatformContent,
} from "./platform-client.js";
import type { WorkspaceClient } from "./client.js";
import type { SearchHit } from "../../../packages/core/src/retrieval.js";
import {
  readContentSearchPage,
  type ContentSearchPage,
} from "./content-search-page.js";

const PAGE_SIZE = 50;

function cursorFor(entry: PlatformContent, sort: ContentSort): ContentCursor {
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

async function readPage(
  client: WorkspaceClient,
  options: {
    projectId?: string;
    appIds?: string[];
    kind?: string;
    kinds?: string[];
    availability?: string;
    query?: string;
    sort: ContentSort;
  },
  signal: AbortSignal,
  before?: ContentCursor,
) {
  // Look one row ahead. A separate count may have changed between requests;
  // it must never decide whether later pages remain reachable.
  const page = await client.listContentPage(
    { ...options, limit: PAGE_SIZE + 1, before },
    signal,
  );
  const items = page.items.slice(0, PAGE_SIZE);
  return {
    items,
    nextCursor:
      page.items.length > PAGE_SIZE
        ? cursorFor(items[items.length - 1]!, options.sort)
        : null,
  };
}

/** One authorized directory page at a time. A scope change discards the old
 * page immediately, so a late reply cannot show another project's titles. */
export function useContentDirectory(
  client: WorkspaceClient,
  options: {
    projectId?: string;
    appIds?: string[];
    kind?: string;
    kinds?: string[];
    availability?: string;
    query?: string;
    sort: ContentSort;
  },
  enabled = true,
  withBodyMatches = false,
) {
  const searchBody = withBodyMatches && !!options.query?.trim();
  const key = JSON.stringify([
    client.boot?.centerId,
    client.boot?.principalId,
    client.boot?.csrfToken,
    client.contentCatalogVersion,
    enabled,
    searchBody,
    options,
  ]);
  type Result = {
    key: string;
    items: PlatformContent[];
    count: number | null;
    nextCursor: ContentCursor | null;
    busy: boolean;
    error: string;
    searchError: string;
    matches: SearchHit[];
    searchPage?: ContentSearchPage;
  };
  const blank = (): Result => ({
    key,
    items: [],
    count: null,
    nextCursor: null,
    busy: true,
    error: "",
    searchError: "",
    matches: [],
  });
  const [result, setResult] = useState<Result>(blank);
  const [retry, setRetry] = useState(0);
  const activeKey = useRef(key);
  const api = useRef(client);
  const nextRequest = useRef<AbortController | null>(null);
  activeKey.current = key;
  api.current = client;
  const visible = result.key === key ? result : blank();

  useEffect(() => {
    const controller = new AbortController();
    nextRequest.current?.abort();
    nextRequest.current = null;
    setResult({ ...blank(), busy: enabled });
    if (!enabled) return;
    const timer = setTimeout(
      () => {
        const { sort: _sort, ...countFilter } = options;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(12000),
        ]);
        if (searchBody) {
          void readContentSearchPage(api.current, options, signal)
            .then((page) => {
              if (activeKey.current !== key || controller.signal.aborted)
                return;
              setResult({
                ...blank(),
                items: page.items,
                count: page.count,
                nextCursor:
                  page.hasMore && page.items.length
                    ? cursorFor(page.items.at(-1)!, options.sort)
                    : null,
                searchPage: page.state,
                matches: page.matches,
                searchError: page.state.searchError,
                busy: false,
              });
            })
            .catch((error: unknown) => {
              if (activeKey.current !== key || controller.signal.aborted)
                return;
              setResult({
                ...blank(),
                busy: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "内容暂不可用，请重试。",
              });
            });
          return;
        }
        void Promise.all([
          readPage(api.current, options, signal),
          api.current.countContent(countFilter, signal),
        ])
          .then(([page, counts]) => {
            if (activeKey.current !== key || controller.signal.aborted) return;
            const count = counts.reduce((sum, row) => sum + row.count, 0);
            setResult({
              key,
              items: page.items,
              count,
              nextCursor: page.nextCursor,
              busy: false,
              error: "",
              searchError: "",
              matches: [],
            });
          })
          .catch((error: unknown) => {
            if (activeKey.current !== key || controller.signal.aborted) return;
            setResult({
              key,
              items: [],
              count: null,
              nextCursor: null,
              busy: false,
              error:
                error instanceof Error
                  ? error.message
                  : "内容暂不可用，请重试。",
              searchError: "",
              matches: [],
            });
          });
      },
      options.query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, retry]);

  async function loadMore() {
    if (
      visible.busy ||
      visible.error ||
      !visible.nextCursor ||
      nextRequest.current
    )
      return;
    const controller = new AbortController();
    nextRequest.current = controller;
    setResult({ ...visible, busy: true });
    try {
      if (visible.searchPage) {
        const page = await readContentSearchPage(
          api.current,
          options,
          AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
          visible.searchPage,
        );
        if (activeKey.current !== key || controller.signal.aborted) return;
        const seen = new Set(visible.items.map((item) => item.id));
        if (page.items.some((item) => seen.has(item.id)))
          throw new Error("目录在翻页期间发生变化，请刷新后重试。");
        setResult({
          ...visible,
          items: [...visible.items, ...page.items],
          count: page.count,
          matches: [...visible.matches, ...page.matches],
          searchPage: page.state,
          searchError: page.state.searchError,
          nextCursor:
            page.hasMore && page.items.length
              ? cursorFor(page.items.at(-1)!, options.sort)
              : null,
          busy: false,
        });
        return;
      }
      const page = await readPage(
        api.current,
        options,
        AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        visible.nextCursor,
      );
      if (activeKey.current !== key || controller.signal.aborted) return;
      const seen = new Set(visible.items.map((item) => item.id));
      if (page.items.some((item) => seen.has(item.id)))
        throw new Error("目录在翻页期间发生变化，请刷新后重试。");
      const items = [...visible.items, ...page.items];
      setResult({
        ...visible,
        items,
        nextCursor: page.nextCursor,
        busy: false,
      });
    } catch (error) {
      if (activeKey.current !== key || controller.signal.aborted) return;
      setResult({
        ...visible,
        busy: false,
        error:
          error instanceof Error ? error.message : "更多内容暂未加载，请重试。",
      });
    } finally {
      if (nextRequest.current === controller) nextRequest.current = null;
    }
  }

  return {
    ...visible,
    loadMore,
    retry: () => {
      nextRequest.current?.abort();
      nextRequest.current = null;
      setRetry((value) => value + 1);
    },
  };
}
