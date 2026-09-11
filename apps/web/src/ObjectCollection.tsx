import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { scopedStorage } from "./client.js";
import {
  FilePlus2,
  FileUp,
  Search,
  LayoutGrid,
  List,
  FolderOpen,
  X,
  Globe,
  PencilLine,
} from "lucide-react";
import type { Artifact } from "../../../packages/core/src/model.js";
import { ObjectIcon, kindLabel } from "./ArtifactEditor.js";
import { documentExcerpt } from "./document-presentation.js";

export function ObjectCollection({
  project,
  projects,
  objects,
  onOpen,
  onCreate,
  onWrite,
  onImport,
  importing,
  catalog = false,
  toolbarTarget,
}: {
  project: { id: string; title: string };
  projects: { id: string; title: string }[];
  objects: Artifact[];
  onOpen: (id: string) => void;
  onCreate: (kind: "document" | "task" | "website" | "interactive") => void;
  onWrite: () => void;
  onImport: () => void;
  importing: boolean;
  catalog?: boolean;
  toolbarTarget?: HTMLElement | null;
}) {
  const storage = useState(() => scopedStorage())[0];
  const key = "library-view:" + (catalog ? "all-content" : project.id);
  const saved = useState(() =>
    storage.readLocal<{
      filter?: "all" | Artifact["content"]["kind"];
      query?: string;
      layout?: "grid" | "list";
      scope?: string;
    }>(key, {}),
  )[0];
  const [requestedFilter, setFilter] = useState<
    "all" | Artifact["content"]["kind"]
  >(
    ["all", "document", "pdf", "image", "website", "interactive"].includes(
      saved?.filter ?? "",
    )
      ? saved.filter!
      : "all",
  );
  // Also normalize a task filter retained by a live UI hot update.
  const filter = requestedFilter === "task" ? "all" : requestedFilter;
  const [query, setQuery] = useState(
    typeof saved?.query === "string" ? saved.query : "",
  );
  const [layout, setLayout] = useState<"grid" | "list">(
    saved?.layout === "list" ? "list" : "grid",
  );
  // Only the global catalog spans authorized spaces. Project/desk content
  // is a local projection of the same objects, not a second global catalog.
  const [requestedScope, setScope] = useState(saved?.scope ?? "all");
  const scope = !catalog
    ? project.id
    : projects.some((p) => p.id === requestedScope)
      ? requestedScope
      : "all";
  // Artifacts share storage, but tasks have their own action-oriented entry.
  // Filter before counts, search, scope and empty states are calculated.
  const contentObjects = objects.filter((a) => a.content.kind !== "task");
  const scopedObjects = contentObjects.filter(
    (a) => scope === "all" || a.projectId === scope,
  );
  const ownerTitles = new Map(projects.map((p) => [p.id, p.title]));
  useEffect(() => {
    try {
      storage.writeLocal(key, { filter, query, layout, scope });
    } catch {
      /* Browsing remains available without local persistence. */
    }
  }, [key, filter, query, layout, scope]);
  const visible = [...scopedObjects]
    .filter(
      (a) =>
        (filter === "all" || a.content.kind === filter) &&
        a.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section
      className="collection library-collection"
      aria-label={catalog ? "全部内容" : `${project.title}的内容`}
    >
      {catalog &&
        toolbarTarget &&
        createPortal(
          <div className="content-actions" role="group" aria-label="创建内容">
            <button
              className="secondary-action"
              aria-label="让 Morphz 起草"
              title={`让 Morphz 起草，保存到${project.title}；先填写需求，不自动发送`}
              onClick={() => onCreate("document")}
            >
              <FilePlus2 />
              <span className="toolbar-action-label">起草</span>
            </button>
            <button
              className="secondary-action"
              aria-label="导入资料"
              title={`导入到${project.title}`}
              onClick={onImport}
              disabled={importing}
            >
              <FileUp />
              <span className="toolbar-action-label">导入</span>
            </button>
          </div>,
          toolbarTarget,
        )}
      <div className="library-chrome">
        {!catalog && (
          <div className="creation-actions" role="group" aria-label="创建内容">
            <button
              className="secondary-action"
              aria-label="制作表格或报告"
              title="制作表格或报告，先在输入框中描述需求"
              onClick={() => onCreate("interactive")}
            >
              <span className="creation-icon">
                <List />
              </span>
              <span>
                <strong>表格 / 报告</strong>
              </span>
            </button>
            <button
              className="secondary-action"
              aria-label="打开浏览器"
              title="打开浏览器"
              onClick={() => onCreate("website")}
            >
              <span className="creation-icon">
                <Globe />
              </span>
              <span>
                <strong>浏览器</strong>
              </span>
            </button>
            <button
              className="secondary-action"
              aria-label="让 Morphz 起草"
              title="让 Morphz 起草，先在输入框中描述需求"
              onClick={() => onCreate("document")}
            >
              <span className="creation-icon">
                <FilePlus2 />
              </span>
              <span>
                <strong>起草</strong>
              </span>
            </button>
            <button
              className="secondary-action"
              aria-label="导入资料"
              title="导入资料"
              onClick={onImport}
              disabled={importing}
            >
              <span className="creation-icon">
                <FileUp />
              </span>
              <span>
                <strong>{importing ? "导入中…" : "导入"}</strong>
              </span>
            </button>
            <span className="library-authoring-options">
              <button
                className="secondary-action"
                aria-label="手动写文档"
                title="手动写文档"
                onClick={onWrite}
              >
                <PencilLine aria-hidden="true" />
                写文档
              </button>
            </span>
          </div>
        )}
        <div className="library-toolbar">
          <div className="filter-tabs" role="group" aria-label="内容类型">
            {(
              [
                "all",
                "document",
                "pdf",
                "image",
                "website",
                "interactive",
              ] as const
            ).map((kind) => (
              <button
                key={kind}
                aria-pressed={kind === filter}
                onClick={() => setFilter(kind)}
              >
                {kind === "all" ? "全部" : kindLabel[kind]}
                {kind === "all" && <small>{scopedObjects.length}</small>}
              </button>
            ))}
          </div>
          <div className="library-controls">
            {catalog && (
              <select
                className="library-scope"
                aria-label="内容范围"
                title="筛选内容的所属空间，不切换对话或更改新内容的保存位置"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="all">全部工作空间</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            )}
            <label className="search-field">
              <Search />
              <input
                aria-label="搜索内容标题"
                placeholder="搜索标题"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button aria-label="清除搜索" onClick={() => setQuery("")}>
                  <X />
                </button>
              )}
            </label>
            <div className="layout-switch" role="group" aria-label="内容布局">
              <button
                aria-label="卡片视图"
                title="卡片视图"
                aria-pressed={layout === "grid"}
                onClick={() => setLayout("grid")}
              >
                <LayoutGrid />
              </button>
              <button
                aria-label="列表视图"
                title="列表视图"
                aria-pressed={layout === "list"}
                onClick={() => setLayout("list")}
              >
                <List />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div
        className="library-results"
        tabIndex={0}
        role="region"
        aria-label="内容列表"
      >
        {visible.length ? (
          <>
            <div className="library-caption">
              <span>{visible.length} 项内容</span>
              <span>最近修改优先</span>
            </div>
            <div
              className={layout === "grid" ? "artifact-grid" : "artifact-list"}
            >
              {visible.map((a) => (
                <button
                  className="artifact-card"
                  key={a.id}
                  onClick={() => onOpen(a.id)}
                >
                  <div className="artifact-card-heading">
                    <ObjectIcon kind={a.content.kind} />
                    <h2>{a.title}</h2>
                  </div>
                  <div className="artifact-preview" data-kind={a.content.kind}>
                    {a.content.kind === "image" ? (
                      <img
                        src={"/api/assets/" + a.content.assetId}
                        alt={a.content.alt || a.title}
                      />
                    ) : (
                      <>
                        <p>
                          {a.content.kind === "document"
                            ? documentExcerpt(a.content.markdown, a.title)
                            : a.content.kind === "pdf"
                              ? `${a.content.pages.length} 页 · ${a.content.pages.join(" ").slice(0, 120) || "扫描文档"}`
                              : a.content.kind === "interactive"
                                ? `${a.content.rows.length} 条记录 · ${a.content.columns.length} 个字段${a.content.description ? " · " + a.content.description.slice(0, 100) : ""}`
                                : a.content.kind === "website"
                                  ? a.content.description || a.content.url
                                  : ""}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="artifact-caption">
                    <span>
                      <small>
                        {ownerTitles.get(a.projectId) ?? "所属空间不可用"} ·{" "}
                        {a.content.kind === "interactive"
                          ? { table: "表格", form: "表单", report: "报告" }[
                              a.content.layout
                            ]
                          : kindLabel[a.content.kind]}{" "}
                        · v{a.revision}
                      </small>
                    </span>
                    <time dateTime={a.updatedAt}>
                      {new Date(a.updatedAt).toLocaleDateString("zh-CN", {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">
              {scopedObjects.length ? <Search /> : <FolderOpen />}
            </span>
            <h2>
              {scopedObjects.length
                ? "没有找到匹配的内容"
                : "这个范围内还没有内容"}
            </h2>
            <p>
              {scopedObjects.length
                ? "试试其他关键词，或切换内容类型。"
                : scope === "all"
                  ? "创建、生成或导入的内容都会显示在这里。"
                  : catalog
                    ? "可以切换到全部工作空间，查看其他地方保存的内容。"
                    : "在这里创作或导入；跨空间查找请使用侧栏的“内容”。"}
            </p>
            {(contentObjects.length > 0 ||
              (catalog && scope !== "all") ||
              query ||
              filter !== "all") && (
              <button
                className="outline"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                  if (!scopedObjects.length) setScope("all");
                }}
              >
                显示全部内容
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
