import { useState } from "react";
import { ArrowUpRight, Folder, Plus, Search, Clock3 } from "lucide-react";
import {
  spaceKind,
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
}: {
  state: Workspace;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const updated = (id: string) =>
    state.artifacts
      .filter((a) => a.projectId === id)
      .reduce((latest, a) => (a.updatedAt > latest ? a.updatedAt : latest), "");
  const projects = state.projects
    .filter(
      (p) =>
        spaceKind(p) === "project" &&
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
      <div className="collection-title">
        <h1>项目</h1>
        <button className="outline" onClick={onCreate}>
          <Plus />
          创建项目
        </button>
      </div>
      <p className="intro">按项目组织内容、工作与协作关系。</p>
      <div className="project-directory-toolbar">
        <span>
          {state.projects.filter((p) => spaceKind(p) === "project").length}{" "}
          个项目
        </span>
        <label className="search-field">
          <Search />
          <input
            aria-label="搜索项目"
            value={query}
            placeholder="搜索项目"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="项目排序"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="recent">最近更新</option>
          <option value="name">名称</option>
        </select>
      </div>
      <div className="project-grid">
        {projects.map((p) => {
          const objects = state.artifacts.filter((a) => a.projectId === p.id);
          const latest = [...objects].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          )[0]?.updatedAt;
          const todo = objects.filter(pending).length;
          return (
            <button
              key={p.id}
              className="project-card"
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
                {objects.length} 项内容{todo ? " · " + todo + " 项待推进" : ""}
              </p>
              <span className="project-card-bottom">
                <Clock3 />
                {latest ? "更新于 " + dateLabel(latest) : "尚无内容"}
              </span>
            </button>
          );
        })}
      </div>
      {!projects.length && (
        <div className="empty-state">
          <Search />
          <h2>{query.trim() ? "没有找到这个项目" : "还没有项目"}</h2>
          <p>
            {query.trim()
              ? "试试其他名称。"
              : "可以创建项目，也可以将工作台中的工作保存为项目。"}
          </p>
        </div>
      )}
    </section>
  );
}
