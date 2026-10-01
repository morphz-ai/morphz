import { useEffect, useRef, useState } from "react";
import { Search, MessageSquareQuote } from "lucide-react";
import type { SearchResult } from "../../../packages/core/src/retrieval.js";
import type { WorkspaceClient } from "./client.js";
import { ObjectIcon } from "./ArtifactEditor.js";
import { useModal } from "./useModal.js";
import { visibleProfileMenuTrigger } from "./profile-menu-focus.js";
import { searchPreview } from "./document-presentation.js";
import { projectDisplayLabel } from "./project-display-label.js";

export function SearchDocuments({
  client,
  onClose,
  onOpen,
  onQuote,
}: {
  client: WorkspaceClient;
  onClose: () => void;
  onOpen: (id: string, revision: number, page?: number) => void;
  onQuote: (
    id: string,
    projectId: string,
    revision: number,
    quote: string,
    page?: number,
  ) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const backdropPointer = useRef(false);
  const outsidePanel = (x: number, y: number) => {
    const bounds = dialog.current?.getBoundingClientRect();
    return (
      !!bounds &&
      (x < bounds.left ||
        x > bounds.right ||
        y < bounds.top ||
        y > bounds.bottom)
    );
  };
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState(""),
    [projectId, setProjectId] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [recent, setRecent] = useState<
    Array<{
      id: string;
      projectId: string;
      title: string;
      revision: number;
      kind: string;
      updatedAt: string;
    }>
  >([]);
  const [error, setError] = useState(""),
    [recentError, setRecentError] = useState(""),
    [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const revision = client.boot?.workspace.revision;
  const search = useRef(client.search);
  search.current = client.search;
  const listContentPage = useRef(client.listContentPage);
  listContentPage.current = client.listContentPage;
  useModal(dialog, searchInput, true, visibleProfileMenuTrigger);
  useEffect(() => {
    if (query.trim()) return;
    const abort = new AbortController();
    setRecent([]);
    setRecentError("");
    void Promise.all(
      ["morphz.objects", "morphz.reader"].map((appId) =>
        listContentPage.current(
          {
            appId,
            ...(projectId ? { projectId } : {}),
            limit: 6,
          },
          abort.signal,
        ),
      ),
    )
      .then((pages) => {
        if (abort.signal.aborted) return;
        setRecent(
          pages
            .flatMap(({ items }) => items)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 6)
            .map((entry) => ({
              id: entry.id,
              projectId: entry.projectId,
              title: entry.title,
              revision: Number(entry.observedVersionRef) || 1,
              kind: entry.kind,
              updatedAt: entry.updatedAt,
            })),
        );
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setRecentError(
            cause instanceof Error ? cause.message : "最近内容暂不可用。",
          );
      });
    return () => abort.abort();
  }, [
    projectId,
    query.trim(),
    client.boot?.csrfToken,
    client.contentCatalogVersion,
  ]);
  useEffect(() => {
    setSelected(0);
    setResult(null);
    setError("");
    if (!query.trim()) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void search
        .current(
          { query, ...(projectId ? { projectId } : {}), offset },
          abort.signal,
        )
        .then((value) => {
          if (!abort.signal.aborted) setResult(value);
        })
        .catch((e) => {
          if (!abort.signal.aborted)
            setError(e instanceof Error ? e.message : "搜索失败。");
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, projectId, offset, revision]);
  const choices = query.trim() ? (result?.hits ?? []) : recent;
  const openSelected = () => {
    const item = choices[selected];
    if (!item) return;
    onClose();
    if ("artifactId" in item) onOpen(item.artifactId, item.revision, item.page);
    else onOpen(item.id, item.revision);
  };
  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-label="搜索资料"
      onPointerDown={(e) => {
        backdropPointer.current =
          e.button === 0 &&
          e.target === e.currentTarget &&
          outsidePanel(e.clientX, e.clientY);
      }}
      onPointerCancel={() => {
        backdropPointer.current = false;
      }}
      onClick={(e) => {
        const dismiss =
          backdropPointer.current &&
          e.target === e.currentTarget &&
          outsidePanel(e.clientX, e.clientY);
        backdropPointer.current = false;
        if (dismiss) onClose();
      }}
      onKeyDown={(e) => {
        if (
          e.nativeEvent.isComposing ||
          e.keyCode === 229 ||
          e.target !== searchInput.current
        )
          return;
        if (["ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          const next = Math.max(
            0,
            Math.min(
              choices.length - 1,
              selected + (e.key === "ArrowDown" ? 1 : -1),
            ),
          );
          setSelected(next);
          dialog.current
            ?.querySelector(`[data-search-index="${next}"]`)
            ?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
          e.preventDefault();
          openSelected();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="workspace-search-controls">
        <label className="search-field">
          <Search />
          <input
            ref={searchInput}
            aria-label="全文搜索"
            placeholder="搜索内容…"
            maxLength={200}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </label>
      </div>
      <div className="search-scope">
        <select
          aria-label="搜索项目范围"
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部内容</option>
          {client.boot?.workspace.projects
            .filter(
              (p) =>
                !p.deletedAt &&
                ["project", "desk"].includes(p.kind ?? "project"),
            )
            .map((p) => (
              <option key={p.id} value={p.id}>
                {projectDisplayLabel(p)}
              </option>
            ))}
        </select>
        <p className="muted" role="status">
          {loading
            ? "正在搜索…"
            : (query.trim() ? error : recentError) ||
              (!query.trim()
                ? "最近修改"
                : `找到 ${result?.total ?? 0} 项内容`)}
        </p>
      </div>
      <div className="workspace-search-results">
        {!query.trim() &&
          recent.map((item, index) => (
            <article
              key={item.id}
              data-search-index={index}
              data-selected={index === selected}
              onPointerEnter={() => setSelected(index)}
              onFocus={() => setSelected(index)}
            >
              <button
                className="search-result-open"
                onClick={() => {
                  onClose();
                  onOpen(item.id, item.revision);
                }}
              >
                <ObjectIcon
                  kind={item.kind as Parameters<typeof ObjectIcon>[0]["kind"]}
                />
                <span>
                  <SearchResultHeading
                    title={item.title}
                    projectTitle={
                      client.boot?.workspace.projects.find(
                        (p) => p.id === item.projectId,
                      )?.title
                    }
                  />
                </span>
              </button>
            </article>
          ))}
        {result?.hits.map((hit, index) => (
          <article
            key={hit.artifactId}
            data-search-index={index}
            data-selected={index === selected}
            onPointerEnter={() => setSelected(index)}
            onFocus={() => setSelected(index)}
            data-quotable={
              (hit.kind === "document" || hit.kind === "pdf") &&
              !!hit.quote.trim()
            }
          >
            <button
              className="search-result-open"
              onClick={(event) => {
                // Text remains selectable; releasing a drag must not navigate.
                const selection = window.getSelection();
                if (
                  event.detail > 0 &&
                  selection &&
                  !selection.isCollapsed &&
                  (event.currentTarget.contains(selection.anchorNode) ||
                    event.currentTarget.contains(selection.focusNode))
                )
                  return;
                onClose();
                onOpen(hit.artifactId, hit.revision, hit.page);
              }}
            >
              <ObjectIcon kind={hit.kind} />
              <span>
                <SearchResultHeading
                  title={hit.title}
                  projectTitle={hit.projectTitle}
                  page={hit.page}
                  sourcePath={hit.source?.relativePath}
                />
                {hit.excerpt && (
                  <span className="search-excerpt">
                    {searchPreview(hit.excerpt, hit.title, query, {
                      kind: hit.kind,
                      page: hit.page,
                    })}
                  </span>
                )}
              </span>
            </button>
            {(hit.kind === "document" || hit.kind === "pdf") &&
              hit.quote.trim() && (
                <button
                  className="search-result-quote"
                  aria-label={`AI 交互：${hit.title}`}
                  title={`引用《${hit.title}》`}
                  onClick={() => {
                    onClose();
                    onQuote(
                      hit.artifactId,
                      hit.projectId,
                      hit.revision,
                      hit.quote,
                      hit.page,
                    );
                  }}
                >
                  <MessageSquareQuote aria-hidden="true" />
                  <span>AI</span>
                </button>
              )}
          </article>
        ))}
        {!loading && !error && choices.length === 0 && (
          <p className="search-empty">
            {query.trim() ? "没有找到匹配内容" : "暂无内容"}
          </p>
        )}
      </div>
      {result && (offset > 0 || result.hasMore) && (
        <footer>
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页
          </button>
          <span className="muted">第 {Math.floor(offset / 20) + 1} 页</span>
          <button
            disabled={!result.hasMore}
            onClick={() => setOffset(offset + 20)}
          >
            下一页
          </button>
        </footer>
      )}
    </dialog>
  );
}

function SearchResultHeading({
  title,
  projectTitle,
  page,
  sourcePath,
}: {
  title: string;
  projectTitle?: string;
  page?: number;
  sourcePath?: string;
}) {
  const location = [projectTitle, page ? `第 ${page} 页` : undefined]
    .filter(Boolean)
    .join(" · ");
  const source = [location, sourcePath].filter(Boolean).join(" · ");
  // A filename identical to the result title adds no visual distinction.
  // Keep the full provenance in the tooltip and the object's source view.
  const visiblePath =
    sourcePath?.replace(/\.[^/.]+$/, "") === title ? undefined : sourcePath;
  return (
    <span className="search-result-heading">
      <strong title={title}>{title}</strong>
      {source && (
        <small className="search-result-meta" title={source}>
          {location && (
            <span className="search-result-location">{location}</span>
          )}
          {visiblePath && (
            <>
              {location && <span aria-hidden="true">·</span>}
              <span className="search-source">{visiblePath}</span>
            </>
          )}
        </small>
      )}
    </span>
  );
}
