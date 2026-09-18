import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bookmark as BookmarkIcon,
  Library,
  Pencil,
  Trash2,
  X,
  ArrowLeft,
} from "lucide-react";
import {
  findBookmarks,
  type Bookmark,
} from "../../../packages/core/src/bookmarks.js";
import { websiteURL } from "../../../packages/core/src/browser.js";
import type { Operation } from "../../../packages/core/src/model.js";
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
  const parsed = websiteURL.safeParse(url);
  const saved = parsed.success
    ? bookmarks.find((b) => !b.deletedAt && b.url === parsed.data)
    : undefined;
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
      await client.execute({
        type: "bookmark-add",
        url: parsed.data,
        title: (currentTitle.trim() || new URL(parsed.data).hostname).slice(
          0,
          180,
        ),
      });
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
        aria-label={saved ? "编辑当前收藏" : "收藏此页"}
        title={saved ? "已收藏 · 编辑" : "收藏此页"}
        aria-pressed={!!saved}
        disabled={!parsed.success || busy}
        onClick={() => void add()}
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
      {error && (
        <span className="bookmark-inline-error" role="alert">
          {error}
        </span>
      )}
      {panel && (
        <BookmarkDialog
          client={client}
          bookmarks={bookmarks}
          selected={panel.selected}
          onClose={() => setPanel(null)}
          onOpen={onOpen}
        />
      )}
    </>
  );
}

function BookmarkDialog({
  client,
  bookmarks,
  selected,
  onClose,
  onOpen,
}: {
  client: WorkspaceClient;
  bookmarks: Bookmark[];
  selected?: Bookmark;
  onClose: () => void;
  onOpen: (url: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(selected);
  const [name, setName] = useState(selected?.title ?? "");
  const [url, setURL] = useState(selected?.url ?? "");
  const [query, setQuery] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  const pending = useRef(false);
  useModal(dialog);
  const rows = findBookmarks(bookmarks, query);
  function edit(b: Bookmark) {
    setEditing(b);
    setName(b.title);
    setURL(b.url);
    setError("");
  }
  async function run(operation: Operation, done: () => void) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.execute(operation);
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
      <div className="dialog-heading">
        {editing && (
          <button
            aria-label="返回收藏列表"
            disabled={busy}
            onClick={() => {
              setEditing(undefined);
              setError("");
            }}
          >
            <ArrowLeft />
          </button>
        )}
        <h2>{editing ? "编辑收藏" : "收藏"}</h2>
        <button aria-label="关闭收藏" disabled={busy} onClick={onClose}>
          <X />
        </button>
      </div>
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
            ) : (
              <p className="muted">{query ? "没有匹配的收藏" : "暂无收藏"}</p>
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
