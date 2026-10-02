import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bookmark as BookmarkIcon,
  Library,
  Pencil,
  Trash2,
  X,
  ArrowLeft,
} from "lucide-react";
import type {
  Bookmark,
  BookmarkOperation,
} from "../../../packages/core/src/bookmarks.js";
import { websiteURL } from "../../../packages/core/src/browser.js";
import type { WorkspaceClient } from "./client.js";
import { useModal } from "./useModal.js";

export function BrowserBookmarks({
  client,
  url,
  title,
  readCurrentTitle,
  onOpen,
}: {
  client: WorkspaceClient;
  url: string;
  title: string;
  readCurrentTitle?: () => Promise<string>;
  onOpen: (url: string) => Promise<void>;
}) {
  const bookmarks = client.boot?.workspace.bookmarks ?? [];
  const managed = !!client.boot?.capabilities.browserBookmarks;
  const identityGeneration = client.boot?.csrfToken;
  const parsed = websiteURL.safeParse(url);
  const legacySaved = parsed.success
    ? bookmarks.find((b) => !b.deletedAt && b.url === parsed.data)
    : undefined;
  const [remoteSaved, setRemoteSaved] = useState<{
    identityGeneration: string;
    url: string;
    revision: number;
    bookmark?: Bookmark;
    error?: string;
  } | null>(null);
  const [savedRevision, setSavedRevision] = useState(0);
  const currentURL = parsed.success ? parsed.data : null;
  useEffect(() => {
    if (!managed || !identityGeneration || !currentURL) return;
    let active = true;
    void client
      .bookmarkList({ url: currentURL, limit: 1 })
      .then((rows) => {
        if (active)
          setRemoteSaved({
            identityGeneration,
            url: currentURL,
            revision: savedRevision,
            bookmark: rows.find((row) => row.url === currentURL),
          });
      })
      .catch(() => {
        if (active)
          setRemoteSaved({
            identityGeneration,
            url: currentURL,
            revision: savedRevision,
            error: "收藏状态读取失败，点击重试。",
          });
      });
    return () => {
      active = false;
    };
  }, [managed, identityGeneration, currentURL, savedRevision, client.workspaceChangeRevision]);
  const currentSaved =
    remoteSaved?.identityGeneration === identityGeneration &&
    remoteSaved?.url === currentURL &&
    remoteSaved?.revision === savedRevision
      ? remoteSaved
      : null;
  const saved = managed ? currentSaved?.bookmark : legacySaved;
  const checkingSaved = managed && !!currentURL && !currentSaved;
  const [panel, setPanel] = useState<{ selected?: Bookmark } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  async function add() {
    if (saved) {
      setPanel({ selected: saved });
      return;
    }
    if (!parsed.success || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const currentTitle = readCurrentTitle ? await readCurrentTitle() : title;
      await client.bookmarkCommand({
        type: "bookmark-add",
        url: parsed.data,
        title: (currentTitle.trim() || new URL(parsed.data).hostname).slice(
          0,
          180,
        ),
      });
      setSavedRevision((value) => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "收藏失败，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        aria-label={
          currentSaved?.error
            ? "重试读取收藏状态"
            : saved
              ? "编辑当前收藏"
              : "收藏此页"
        }
        title={
          currentSaved?.error
            ? currentSaved.error
            : checkingSaved
              ? "读取收藏状态…"
              : saved
                ? "已收藏 · 编辑"
                : "收藏此页"
        }
        aria-pressed={!!saved}
        aria-busy={checkingSaved}
        disabled={!parsed.success || busy || checkingSaved}
        onClick={() =>
          currentSaved?.error
            ? setSavedRevision((value) => value + 1)
            : void add()
        }
      >
        <BookmarkIcon fill={saved ? "currentColor" : "none"} />
      </button>
      <button
        aria-label="浏览器收藏"
        title="收藏"
        onClick={() => {
          setError("");
          setPanel({});
        }}
      >
        <Library />
      </button>
      {(error || currentSaved?.error) && (
        <span className="bookmark-inline-error" role="alert">
          {error || currentSaved?.error}
        </span>
      )}
      {panel && (
        <BookmarkDialog
          client={client}
          selected={panel.selected}
          onChanged={() => setSavedRevision((value) => value + 1)}
          onClose={() => setPanel(null)}
          onOpen={onOpen}
        />
      )}
    </>
  );
}

function BookmarkDialog({
  client,
  selected,
  onChanged,
  onClose,
  onOpen,
}: {
  client: WorkspaceClient;
  selected?: Bookmark;
  onChanged: () => void;
  onClose: () => void;
  onOpen: (url: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(selected);
  const [name, setName] = useState(selected?.title ?? "");
  const [url, setURL] = useState(selected?.url ?? "");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  const pending = useRef(false);
  const listKey = useRef("");
  useModal(dialog);
  const identityGeneration = client.boot?.csrfToken;
  listKey.current = `${identityGeneration ?? ""}:${query}:${listRevision}:${client.workspaceChangeRevision}`;
  useEffect(() => {
    if (!identityGeneration) return;
    let active = true;
    setRows([]);
    setHasMore(false);
    setLoading(true);
    const timer = setTimeout(() => {
      void client
        .bookmarkList({ query, limit: 50 })
        .then((result) => {
          if (!active) return;
          setRows(result);
          setHasMore(result.length === 50);
          setLoading(false);
        })
        .catch((cause) => {
          if (!active) return;
          setRows([]);
          setHasMore(false);
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "读取收藏失败。");
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [identityGeneration, query, listRevision, client.workspaceChangeRevision]);
  async function loadMore() {
    if (loading || busy || !hasMore) return;
    const key = listKey.current;
    setLoading(true);
    try {
      const next = await client.bookmarkList({
        query,
        offset: rows.length,
        limit: 50,
      });
      if (key === listKey.current) {
        setRows((current) => [...current, ...next]);
        setHasMore(next.length === 50);
      }
    } catch (cause) {
      if (key === listKey.current)
        setError(cause instanceof Error ? cause.message : "读取收藏失败。");
    } finally {
      if (key === listKey.current) setLoading(false);
    }
  }
  function edit(b: Bookmark) {
    setEditing(b);
    setName(b.title);
    setURL(b.url);
    setError("");
  }
  async function run(operation: BookmarkOperation, done: () => void) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.bookmarkCommand(operation);
      setListRevision((value) => value + 1);
      onChanged();
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function remove(b: Bookmark) {
    void run(
      {
        type: "bookmark-remove",
        bookmarkId: b.id,
        expectedRevision: b.revision,
      },
      () => {
        setRemoved({ id: b.id, revision: b.revision + 1 });
        setEditing(undefined);
      },
    );
  }
  async function open(b: Bookmark) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onOpen(b.url);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "打开失败，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="browser-bookmarks-dialog create-dialog"
      aria-label="浏览器收藏"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-heading">
        {editing && (
          <button
            aria-label="返回收藏列表"
            disabled={busy}
            onClick={() => {
              setEditing(undefined);
              setError("");
              setListRevision((value) => value + 1);
            }}
          >
            <ArrowLeft />
          </button>
        )}
        <h2>{editing ? "编辑收藏" : "收藏"}</h2>
        <button aria-label="关闭收藏" disabled={busy} onClick={onClose}>
          <X />
        </button>
      </header>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              {
                type: "bookmark-update",
                bookmarkId: editing.id,
                expectedRevision: editing.revision,
                title: name.trim(),
                url,
              },
              () => setEditing(undefined),
            );
          }}
        >
          <label>
            名称
            <input
              aria-label="收藏名称"
              required
              maxLength={180}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            网址
            <input
              aria-label="收藏网址"
              required
              value={url}
              onChange={(e) => setURL(e.target.value)}
            />
          </label>
          <div className="bookmark-edit-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => remove(editing)}
            >
              移除收藏
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy || !name.trim() || !url.trim()}
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <input
            type="search"
            aria-label="搜索收藏"
            placeholder="搜索收藏"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="bookmark-list">
            {rows.length ? (
              rows.map((b) => (
                <div className="bookmark-row" key={b.id}>
                  <button
                    className="bookmark-open"
                    aria-label={`打开收藏：${b.title}`}
                    disabled={busy}
                    onClick={() => void open(b)}
                  >
                    <strong>{b.title}</strong>
                    <small>{b.url}</small>
                  </button>
                  <button
                    aria-label={`编辑收藏：${b.title}`}
                    disabled={busy}
                    onClick={() => edit(b)}
                  >
                    <Pencil />
                  </button>
                  <button
                    aria-label={`移除收藏：${b.title}`}
                    disabled={busy}
                    onClick={() => remove(b)}
                  >
                    <Trash2 />
                  </button>
                </div>
              ))
            ) : loading ? (
              <p className="muted">正在读取收藏…</p>
            ) : (
              <p className="muted">{query ? "没有匹配的收藏" : "暂无收藏"}</p>
            )}
            {hasMore && (
              <button
                disabled={loading || busy}
                onClick={() => void loadMore()}
              >
                {loading ? "读取中…" : "加载更多"}
              </button>
            )}
          </div>
          {removed && (
            <div className="bookmark-undo" role="status">
              已移除收藏
              <button
                disabled={busy}
                onClick={() =>
                  void run(
                    {
                      type: "bookmark-restore",
                      bookmarkId: removed.id,
                      expectedRevision: removed.revision,
                    },
                    () => setRemoved(null),
                  )
                }
              >
                撤销
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </dialog>,
    document.querySelector(".workspace") ?? document.body,
  );
}
