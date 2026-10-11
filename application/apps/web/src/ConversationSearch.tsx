import { useEffect, useRef, useState } from "react";
import { Search, X, MessageSquare, CornerDownRight } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import type {
  ConversationSearchPage,
  ConversationSearchHit,
} from "../../../packages/core/src/conversation-search.js";
import { useModal } from "./useModal.js";
import { Tooltip } from "./ui/Tooltip.js";
import { searchPreview } from "./document-presentation.js";

/** Disposable, identity-bound read task. Does not write a draft, select a
 * Session, subscribe to output, or treat a bounded page as all history. */
export function ConversationSearch({
  client,
  projectId,
  conversationId,
  onClose,
  onReveal,
}: {
  client: WorkspaceClient;
  projectId: string;
  conversationId: string;
  onClose(): void;
  onReveal(messageId: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  useModal(dialog, input);
  const [query, setQuery] = useState(""),
    [result, setResult] = useState<ConversationSearchPage | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [selected, setSelected] = useState(0);
  const [page, setPage] = useState(0);
  const read = useRef(client.searchConversation);
  read.current = client.searchConversation;
  const cursor = useRef<ConversationSearchPage["nextCursor"]>(null);
  const term = query.trim();
  useEffect(() => {
    setResult(null);
    cursor.current = null;
    setPage(0);
    setSelected(0);
  }, [
    projectId,
    conversationId,
    client.boot?.csrfToken,
    client.conversationSearchGeneration,
  ]);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    if (!term || term.length > 200) {
      setLoading(false);
      if (term.length > 200) setError("查找词请控制在 200 字符以内。");
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      () => {
        void read
          .current(
            {
              projectId,
              conversationId,
              query: term,
              ...(page && cursor.current ? { before: cursor.current } : {}),
            },
            abort.signal,
          )
          .then((value) => {
            if (abort.signal.aborted) return;
            cursor.current = value.nextCursor;
            setResult((old) =>
              page && old
                ? {
                    ...value,
                    scanned: old.scanned + value.scanned,
                    hits: [
                      ...new Map(
                        [...old.hits, ...value.hits].map((hit) => [
                          hit.messageId,
                          hit,
                        ]),
                      ).values(),
                    ],
                  }
                : value,
            );
          })
          .catch((cause) => {
            if (!abort.signal.aborted)
              setError(
                cause instanceof Error
                  ? cause.message
                  : "对话暂时无法查找，请重试。",
              );
          })
          .finally(() => {
            if (!abort.signal.aborted) setLoading(false);
          });
      },
      page ? 0 : 180,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    term,
    page,
    projectId,
    conversationId,
    client.boot?.csrfToken,
    client.conversationSearchGeneration,
  ]);
  const open = (hit?: ConversationSearchHit) => {
    if (!hit) return;
    onClose();
    onReveal(hit.messageId);
  };
  return (
    <dialog
      ref={dialog}
      className="create-dialog conversation-search-dialog"
      aria-label="查找当前对话"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (
          e.target !== input.current ||
          e.nativeEvent.isComposing ||
          e.keyCode === 229
        )
          return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = Math.max(
            0,
            Math.min(
              (result?.hits.length ?? 0) - 1,
              selected + (e.key === "ArrowDown" ? 1 : -1),
            ),
          );
          setSelected(next);
          dialog.current
            ?.querySelector(`[data-search-index="${next}"]`)
            ?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
          e.preventDefault();
          open(result?.hits[selected]);
        }
      }}
    >
      <div className="conversation-search-heading">
        <label className="search-field">
          <Search aria-hidden="true" />
          <input
            ref={input}
            aria-label="查找当前对话"
            placeholder="查找当前对话…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setResult(null);
              cursor.current = null;
              setPage(0);
              setSelected(0);
            }}
          />
        </label>
        <Tooltip label="关闭">
          <button
            type="button"
            className="icon-button"
            aria-label="关闭查找"
            onClick={onClose}
          >
            <X />
          </button>
        </Tooltip>
      </div>
      <div className="conversation-search-results">
        {!term && (
          <p className="conversation-search-empty">
            查找已保存的消息、批注评论和回复。
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {!!result?.hits.length && (
          <ul aria-label="对话查找结果">
            {result.hits.map((hit, index) => (
              <li key={hit.messageId}>
                <button
                  type="button"
                  data-search-index={index}
                  data-selected={index === selected}
                  onClick={() => open(hit)}
                >
                  {hit.kind === "input" ? (
                    <MessageSquare size={16} aria-hidden="true" />
                  ) : (
                    <CornerDownRight size={16} aria-hidden="true" />
                  )}
                  <span>
                    <span className="conversation-search-preview">
                      {hit.kind === "input" || /[*_`#]/u.test(term)
                        ? hit.preview
                        : searchPreview(hit.preview, "", term, {
                            kind: "message",
                          })}
                    </span>
                    <small>
                      {hit.kind === "input"
                        ? "消息"
                        : hit.kind === "error"
                          ? "错误"
                          : "回复"}{" "}
                      ·{" "}
                      <time dateTime={hit.createdAt}>
                        {new Date(hit.createdAt).toLocaleString("zh-CN")}
                      </time>
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {loading && <p role="status">正在查找已保存的消息…</p>}
        {result && !loading && !error && !result.hits.length && (
          <p className="conversation-search-empty">
            {result.nextCursor
              ? "已查范围暂无匹配，更早消息尚未查找。"
              : "当前对话没有匹配的消息。"}
          </p>
        )}
        {result?.nextCursor && (
          <button
            type="button"
            className="conversation-search-more"
            disabled={loading}
            onClick={() => setPage((value) => value + 1)}
          >
            继续查找更早消息
          </button>
        )}
        {error && (
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={() => setPage((value) => value + 1)}
          >
            重试查找
          </button>
        )}
      </div>
    </dialog>
  );
}
