import { useRef, useState } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2, X } from "lucide-react";
import type { Workspace } from "../../../packages/core/src/model.js";
import {
  projectStatus,
  type Project,
} from "../../../packages/core/src/projects.js";
import type { WorkspaceClient } from "./client.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { useModal } from "./useModal.js";

export type ProjectAction = "rename" | "archive" | "restore" | "delete";
export const projectActionLabel = {
  rename: "重命名项目",
  archive: "归档项目",
  restore: "恢复项目",
  delete: "删除项目",
};
const projectMenuActionLabel: Record<ProjectAction, string> = {
  rename: "重命名",
  archive: "归档",
  restore: "恢复",
  delete: "删除",
};
export function ProjectMenu({
  project,
  onAction,
}: {
  project: Project;
  onAction: (project: Project, action: ProjectAction) => void;
}) {
  const status = projectStatus(project);
  const actions: ProjectAction[] =
    status === "deleted"
      ? ["restore"]
      : status === "archived"
        ? ["rename", "restore", "delete"]
        : ["rename", "archive", "delete"];
  return (
    <ComposerOptions
      label={`项目操作：${project.title}`}
      menuLabel="项目操作"
      below
      options={actions.map((action) => ({
        label: `${projectActionLabel[action]}：${project.title}`,
        text: projectMenuActionLabel[action],
        icon:
          action === "rename" ? (
            <Pencil />
          ) : action === "archive" ? (
            <Archive />
          ) : action === "delete" ? (
            <Trash2 />
          ) : (
            <ArchiveRestore />
          ),
        onSelect: () => onAction(project, action),
      }))}
    />
  );
}
export function ProjectActionDialog({
  project,
  action,
  client,
  onClose,
  onSaved,
}: {
  project: Project;
  action: ProjectAction;
  client: WorkspaceClient;
  onClose: () => void;
  onSaved: (id: string, action: ProjectAction) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef(false);
  const [name, setName] = useState(project.title),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useModal(dialog);
  const state: Workspace = client.boot!.workspace;
  const count = state.artifacts.filter(
    (a) => a.projectId === project.id,
  ).length;
  const conversations = state.conversations.filter(
    (c) =>
      c.projectId === project.id &&
      c.id !== project.id &&
      state.inputs.some((i) => (i.conversationId ?? i.projectId) === c.id),
  ).length;
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "update-project",
        projectId: project.id,
        expectedRevision: project.revision ?? 1,
        ...(action === "rename"
          ? { title: name }
          : {
              state:
                action === "archive"
                  ? "archived"
                  : action === "delete"
                    ? "deleted"
                    : "active",
            }),
      });
      onSaved(project.id, action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog project-dialog"
      aria-labelledby="project-action-title"
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
          <h2 id="project-action-title">{projectActionLabel[action]}</h2>
          <button
            type="button"
            aria-label="关闭项目操作"
            disabled={busy}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {action === "rename" ? (
          <div className="project-name-row">
            <input
              aria-label="项目名称"
              value={name}
              maxLength={180}
              required
              onChange={(e) => setName(e.target.value)}
            />
            <button className="primary" disabled={busy || !name.trim()}>
              保存
            </button>
          </div>
        ) : (
          <>
            <p className="project-action-subject">{project.title}</p>
            <p className="project-action-description">
              {action === "delete"
                ? `${conversations} 个会话、${count} 项内容与事项随项目移到“已删除”，可恢复。不会删除外部原文件。`
                : action === "archive"
                  ? "从日常列表收起，历史与内容保留；恢复后继续工作。"
                  : "恢复到项目列表，保留原会话、内容与草稿。"}
            </p>
            <footer>
              <button type="button" disabled={busy} onClick={onClose}>
                取消
              </button>
              <button
                className={action === "delete" ? "danger" : "primary"}
                disabled={busy}
              >
                {busy ? "保存中…" : projectActionLabel[action]}
              </button>
            </footer>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </dialog>
  );
}
