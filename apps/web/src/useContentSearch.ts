import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "../../../packages/core/src/retrieval.js";
import type { WorkspaceClient } from "./client.js";
type Result = {
  key: string;
  hits: SearchHit[];
  more: boolean;
  offset: number;
  busy: boolean;
  error: string;
};
export function useContentSearch(
  client: WorkspaceClient,
  query: string,
  scope: string,
) {
  const key = JSON.stringify([
    client.boot?.csrfToken,
    query.trim(),
    scope,
    client.boot?.workspace.artifacts
      .map((a) => `${a.id}:${a.revision}:${a.projectId}`)
      .join(","),
  ]);
  const api = useRef(client);
  api.current = client;
  const active = useRef(key);
  active.current = key;
  const abort = useRef<AbortController | null>(null);
  const empty: Result = {
    key,
    hits: [],
    more: false,
    offset: 0,
    busy: !!query.trim(),
    error: "",
  };
  const [result, setResult] = useState<Result>(empty);
  const [retry, setRetry] = useState(0);
  const current = result.key === key ? result : empty;
  async function request(offset: number, previous: SearchHit[] = []) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setResult({
      key,
      hits: previous,
      offset,
      more: offset > 0,
      busy: true,
      error: "",
    });
    try {
      const response = await api.current.search(
        {
          query: query.trim(),
          ...(scope !== "all" ? { projectId: scope } : {}),
          offset,
          limit: 50,
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
      );
      if (active.current !== key || controller.signal.aborted) return;
      setResult({
        key,
        hits: [...previous, ...response.hits],
        offset: offset + response.hits.length,
        more: response.hasMore && offset + response.hits.length <= 10000,
        busy: false,
        error: "",
      });
      if (
        response.hits.some(
          (hit) =>
            !api.current.boot?.workspace.artifacts.some(
              (a) => a.id === hit.artifactId,
            ),
        )
      )
        void api.current.refresh().catch(() => {});
    } catch {
      if (active.current === key && !controller.signal.aborted)
        setResult({
          key,
          hits: previous,
          more: offset > 0,
          offset,
          busy: false,
          error: previous.length
            ? "更多结果暂未加载，请重试。"
            : "正文搜索暂不可用，当前仅显示标题匹配。",
        });
    }
  }
  useEffect(() => {
    if (!query.trim()) {
      setResult({ ...empty, busy: false });
      return;
    }
    const timer = setTimeout(() => void request(0), 180);
    return () => {
      clearTimeout(timer);
      abort.current?.abort();
    };
  }, [key, retry]);
  return {
    ...current,
    loadMore: () => request(current.offset, current.hits),
    retry: () => setRetry((n) => n + 1),
  };
}
