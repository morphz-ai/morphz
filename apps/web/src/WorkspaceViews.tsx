import { useEffect, useState } from "react";
import { scopedStorage } from "./client.js";
import {
  projectActivity,
  projectStatus,
  type ProjectStatus,
  type Project,
} from "../../../packages/core/src/projects.js";
import { ProjectMenu, type ProjectAction } from "./ProjectManagement.js";
import { ComposerOptions } from "./ComposerOptions.js";
import type { ConversationRuntime } from "../../../packages/core/src/conversation.js";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Folder,
  Plus,
  Search,
  Clock3,
  SlidersHorizontal,
} from "lucide-react";
import {
  spaceKind,
  isContentArtifact,
  type Workspace,
  type Artifact,
} from "../../../packages/core/src/model.js";
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
const pending = (a: Artifact) =>
  a.content.kind === "task" &&
  !["completed", "cancelled"].includes(a.content.execution);

export function ProjectDirectory({
  state,
  onOpen,
  onCreate,
  toolbarTarget,
  onManage,
  messages,
}: {
  state: Workspace;
  onOpen: (id: string) => void;
  onCreate: () => void;
  toolbarTarget: HTMLElement | null;
  onManage: (project: Project, action: ProjectAction) => void;
  messages: ConversationRuntime["messages"];
}) {
  const [storage] = useState(() => scopedStorage());
  const [saved] = useState(() =>
    storage.readLocal<{ query: string; sort: string; status: ProjectStatus }>(
      "project-directory",
      { query: "", sort: "recent", status: "active" },
    ),
  );
  const [query, setQuery] = useState(
    typeof saved?.query === "string" ? saved.query : "",
  );
  const [sort, setSort] = useState(saved?.sort === "name" ? "name" : "recent");
  const [status, setStatus] = useState<ProjectStatus>(
    saved?.status === "archived" || saved?.status === "deleted"
      ? saved.status
      : "active",
  );
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    try {
      storage.writeLocal("project-directory", { query, sort, status });
      setStorageError("");
    } catch {
      setStorageError("筛选暂时无法保存，当前页面仍可使用。");
    }
  }, [query, sort, status, storage]);
  const statusLabel =
    status === "active"
      ? "使用中"
      : status === "archived"
        ? "已归档"
        : "已删除";
  const scopeControl = (label: string) => (
    <select
      aria-label={label}
      value={status}
      onChange={(e) => setStatus(e.target.value as ProjectStatus)}
    >
      <option value="active">使用中</option>
      <option value="archived">已归档</option>
      <option value="deleted">已删除</option>
    </select>
  );
  const sortControl = (label: string) => (
    <select
      aria-label={label}
      value={sort}
      onChange={(e) => setSort(e.target.value)}
    >
      <option value="recent">最近活动</option>
      <option value="name">名称</option>
    </select>
  );
  const updated = (id: string) =>
    projectActivity(
      state,
      state.projects.find((p) => p.id === id)!,
      messages,
    );
  const projects = state.projects
    .filter(
      (p) =>
        spaceKind(p) === "project" &&
        projectStatus(p) === status &&
        p.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title, "zh-CN")
        : updated(b.id).localeCompare(updated(a.id)) ||
          a.title.localeCompare(b.title, "zh-CN"),
    );
  return (
    <section className="collection project-directory" aria-label="项目目录">
      {toolbarTarget &&
        createPortal(
          <div className="project-directory-toolbar">
            <span>{projects.length} 个项目</span>
            <div className="project-directory-wide">
              {scopeControl("项目范围")}
            </div>
            <label className="search-field">
              <Search />
              <input
                aria-label="搜索项目"
                value={query}
                placeholder="搜索项目"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="project-directory-wide">
              {sortControl("项目排序")}
            </div>
            <div className="project-directory-narrow">
              <ComposerOptions
                below
                label={`筛选项目：${statusLabel}`}
                menuLabel="筛选项目"
                triggerIcon={<SlidersHorizontal />}
                options={[]}
                modelControl={
                  <div className="task-filter-panel">
                    <label>范围{scopeControl("筛选项目范围")}</label>
                    <label>排序{sortControl("筛选项目排序")}</label>
                  </div>
                }
              />
            </div>
            <button
              className="secondary-action"
              onClick={onCreate}
              aria-label="创建项目"
              title="创建项目"
            >
              <Plus />
              <span className="toolbar-action-label">新建</span>
            </button>
          </div>,
          toolbarTarget,
        )}
      {storageError && (
        <p className="form-error" role="alert">
          {storageError}
        </p>
      )}
      <div className="project-grid">
        {projects.map((p) => {
          const objects = state.artifacts.filter((a) => a.projectId === p.id);
          const latest = updated(p.id);
          const todo = objects.filter(pending).length;
          return (
            <article key={p.id} className="project-card">
              <ProjectMenu project={p} onAction={onManage} />
              <button
                className="project-card-open"
                aria-label={`打开项目：${p.title}`}
                onClick={() => onOpen(p.id)}
              >
                <span className="project-card-top">
                  <span className="project-folder">
                    <Folder />
                  </span>
                  <ArrowUpRight />
                </span>
                <h2>{p.title}</h2>
                <p>
                  {objects.filter(isContentArtifact).length} 项内容
                  {todo ? " · " + todo + " 项待推进" : ""}
                </p>
                <span className="project-card-bottom">
                  <Clock3 />
                  {"最近活动 " + dateLabel(latest)}
                </span>
              </button>
            </article>
          );
        })}
      </div>
      {!projects.length && (
        <div className="empty-state">
          <Search />
          <h2>
            {query.trim()
              ? "没有找到这个项目"
              : status === "archived"
                ? "没有已归档项目"
                : status === "deleted"
                  ? "没有已删除项目"
                  : "还没有项目"}
          </h2>
        </div>
      )}
    </section>
  );
}
