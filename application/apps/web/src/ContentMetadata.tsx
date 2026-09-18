import { useRef, useState } from "react";
import { X } from "lucide-react";
import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import { useModal } from "./useModal.js";

export function ContentMetadata({
  artifact,
  projects,
  client,
  mode,
  onClose,
  onSaved,
}: {
  artifact: Artifact;
  projects: Workspace["projects"];
  client: WorkspaceClient;
  mode: "rename" | "move";
  onClose: () => void;
  onSaved: (old: Artifact, revision: number) => void;
}) {
  // Keep the version captured at opening; never adopt a background edit silently.
  const [original] = useState(artifact);
  const [title, setTitle] = useState(original.title);
  const [projectId, setProjectId] = useState(original.projectId);
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
        artifactId: original.id,
        expectedRevision: original.revision,
        changes: mode === "rename" ? { title: title.trim() } : { projectId },
      });
      onSaved(original, original.revision + 1);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="content-metadata-dialog create-dialog"
      aria-label={mode === "rename" ? "重命名内容" : "移动到项目"}
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
          <h2>{mode === "rename" ? "重命名" : "移动到项目"}</h2>
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
          <label className="field">
            名称
            <input
              aria-label="内容名称"
              value={title}
              maxLength={180}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        ) : (
          <>
            <p className="content-move-title">{original.title}</p>
            <label className="field">
              保存位置
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
                      {p.title}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="outline"
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
                : projectId === original.projectId)
            }
          >
            {busy ? "正在保存…" : mode === "rename" ? "保存" : "移动"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
