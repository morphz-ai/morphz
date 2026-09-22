import { useRef, useState } from "react";
import { X } from "lucide-react";
import type { Workspace } from "../../../packages/core/src/model.js";
import {
  contentOwnershipTitle,
  type ContentEntry,
} from "../../../packages/core/src/content.js";
import type { WorkspaceClient } from "./client.js";
import { useModal } from "./useModal.js";

export function ContentMetadata({
  entry,
  projects,
  client,
  mode,
  onClose,
  onSaved,
}: {
  entry: ContentEntry;
  projects: Workspace["projects"];
  client: WorkspaceClient;
  mode: "rename" | "move";
  onClose: () => void;
  onSaved: (old: ContentEntry, revision: number) => void;
}) {
  // Keep the version captured at opening; never adopt a background edit silently.
  const [savedEntry] = useState(entry);
  const original = savedEntry.value;
  const [title, setTitle] = useState(original.title);
  const [projectId, setProjectId] = useState(original.projectId);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useModal(dialog);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "organize-content",
        target: { kind: savedEntry.kind, id: original.id },
        expectedRevision: original.revision,
        changes:
          mode === "rename"
            ? { title: title.trim() }
            : projectId === "new"
              ? { newProjectTitle: newProjectTitle.trim() }
              : { projectId },
      });
      onSaved(savedEntry, original.revision + 1);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  const actions = (
    <footer>
      <button
        type="button"
        className="secondary-action"
        disabled={busy}
        onClick={onClose}
      >
        取消
      </button>
      <button
        className="primary"
        disabled={
          busy ||
          (mode === "rename"
            ? !title.trim() || title.trim() === original.title
            : projectId === original.projectId ||
              (projectId === "new" && !newProjectTitle.trim()))
        }
      >
        {busy ? "正在保存…" : "保存"}
      </button>
    </footer>
  );
  return (
    <dialog
      ref={dialog}
      className="content-metadata-dialog create-dialog"
      aria-label={mode === "rename" ? "重命名内容" : "设置项目"}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header>
          <h2>{mode === "rename" ? "重命名" : "设置项目"}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {mode === "rename" ? (
          <div className="dialog-input-row">
            <input
              aria-label="内容名称"
              placeholder="内容名称"
              value={title}
              maxLength={180}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
            {actions}
          </div>
        ) : (
          <>
            <p className="content-move-title">{original.title}</p>
            <label className="field">
              归属项目
              <select
                aria-label="目标项目"
                value={projectId}
                disabled={busy}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects
                  .filter(
                    (p) =>
                      p.id === original.projectId ||
                      (!p.archivedAt &&
                        !p.deletedAt &&
                        ["project", "desk"].includes(p.kind ?? "project")),
                  )
                  .map((p) => (
                    <option value={p.id} key={p.id}>
                      {contentOwnershipTitle(p)}
                    </option>
                  ))}
                <option value="new">新建项目…</option>
              </select>
            </label>
            {projectId === "new" && (
              <input
                aria-label="新项目名称"
                placeholder="新项目名称"
                value={newProjectTitle}
                maxLength={180}
                disabled={busy}
                onChange={(e) => setNewProjectTitle(e.target.value)}
              />
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {mode === "move" && actions}
      </form>
    </dialog>
  );
}
