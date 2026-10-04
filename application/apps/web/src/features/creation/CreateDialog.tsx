import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { WorkspaceClient } from "../../client.js";
import { scopedStorage, draftKey } from "../../local-preferences.js";
import { useModal } from "../../useModal.js";

export function CreateDialog({
  kind,
  projectId,
  client,
  onClose,
  onCreated,
  prepareCreated,
  toolbarTarget,
}: {
  kind: "document" | "project";
  projectId: string;
  client: Pick<WorkspaceClient, "execute">;
  onClose: () => void;
  onCreated: (id: string, kind: string) => void;
  prepareCreated?: () => (id: string, kind: string) => void;
  toolbarTarget?: HTMLElement | null;
}) {
  const [storage] = useState(() => scopedStorage());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const draftId = draftKey("create-document:" + projectId);
  const cached =
    kind === "document"
      ? storage.readLocal<{ title: string; markdown: string }>(draftId, {
          title: "",
          markdown: "",
        })
      : { title: "", markdown: "" };
  const dialog = useRef<HTMLDialogElement>(null),
    [title, setTitle] = useState(cached.title),
    [markdown, setMarkdown] = useState(cached.markdown),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useModal(dialog);
  useEffect(() => {
    if (kind === "document") {
      try {
        storage.writeLocal(draftId, { title, markdown });
      } catch {
        setError("草稿未能保存，请保留当前页面。\n");
      }
    }
  }, [title, markdown, kind, draftId, storage]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    const created = prepareCreated?.();
    try {
      const result = await client.execute(
        kind === "project"
          ? { type: "create-project", title }
          : {
              type: "create-artifact",
              projectId,
              title,
              content: { kind: "document", markdown },
            },
      );
      if (kind === "document") {
        try {
          storage.writeLocal(draftId, { title: "", markdown: "" });
        } catch {
          /* Creation already succeeded; never repeat it on a local storage failure. */
        }
      }
      created?.(result.entityId, kind);
      if (alive.current) onCreated(result.entityId, kind);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "创建失败。");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const heading = (
    <header className={kind === "document" ? "draft-toolbar" : undefined}>
      <h2 id="create-title">{kind === "project" ? "新建项目" : "新建文档"}</h2>
      <button
        type="button"
        aria-label="关闭新建窗口"
        disabled={busy}
        onClick={onClose}
      >
        <X />
      </button>
    </header>
  );
  const form = (
    <form onSubmit={(e) => void submit(e)}>
      {kind === "document"
        ? toolbarTarget && createPortal(heading, toolbarTarget)
        : heading}
      {kind === "document" ? (
        <div>
          <label className="field">
            标题
            <input
              autoFocus
              aria-label="新对象标题"
              maxLength={180}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
        </div>
      ) : (
        <div className="dialog-input-row">
          <input
            aria-label="项目名称"
            placeholder="项目名称"
            maxLength={180}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "保存中…" : "创建"}
          </button>
        </div>
      )}
      {kind === "document" && (
        <label className="field">
          正文 · Markdown
          <textarea
            aria-label="新文档正文"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={8}
            placeholder="开始写作…"
          />
        </label>
      )}
      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}
      {kind === "document" && (
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "保存中…" : "创建"}
          </button>
        </footer>
      )}
    </form>
  );
  if (kind === "document")
    return (
      <section className="document-draft" aria-label="新建文档编辑区">
        {form}
      </section>
    );
  return (
    <dialog
      ref={dialog}
      className="create-dialog project-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="create-title"
    >
      {form}
    </dialog>
  );
}
