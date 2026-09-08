import { useState } from "react";
import {
  FilePlus2,
  ImagePlus,
  CircleCheck,
  Search,
  LayoutGrid,
  List,
  FolderOpen,
  X,
  Globe,
} from "lucide-react";
import type { Artifact } from "../../../packages/core/src/model.js";
import { ObjectIcon, kindLabel } from "./ArtifactEditor.js";

export function ObjectCollection({
  project,
  objects,
  onOpen,
  onCreate,
  onWrite,
  onImport,
  importing,
}: {
  project: { title: string };
  objects: Artifact[];
  onOpen: (id: string) => void;
  onCreate: (kind: "document" | "task" | "website" | "interactive") => void;
  onWrite: () => void;
  onImport: () => void;
  importing: boolean;
}) {
  const [filter, setFilter] = useState<"all" | Artifact["content"]["kind"]>(
    "all",
  );
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const visible = [...objects]
    .filter(
      (a) =>
        (filter === "all" || a.content.kind === filter) &&
        a.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section
      className="collection library-collection"
      aria-label={`${project.title}的资料`}
    >
      <div className="library-chrome">
        <div className="creation-actions" role="group" aria-label="创建资料">
          <button
            aria-label="新建交互产物"
            onClick={() => onCreate("interactive")}
          >
            <span className="creation-icon">
              <List />
            </span>
            <span>
              <strong>交互产物</strong>
            </span>
          </button>
          <button aria-label="添加网站" onClick={() => onCreate("website")}>
            <span className="creation-icon">
              <Globe />
            </span>
            <span>
              <strong>添加网站</strong>
            </span>
          </button>
          <button aria-label="新建文档" onClick={() => onCreate("document")}>
            <span className="creation-icon">
              <FilePlus2 />
            </span>
            <span>
              <strong>新建文档</strong>
            </span>
          </button>
          <button aria-label="导入图片" onClick={onImport} disabled={importing}>
            <span className="creation-icon">
              <ImagePlus />
            </span>
            <span>
              <strong>{importing ? "导入中…" : "导入图片"}</strong>
            </span>
          </button>
          <button aria-label="新建事项" onClick={() => onCreate("task")}>
            <span className="creation-icon">
              <CircleCheck />
            </span>
            <span>
              <strong>新建事项</strong>
            </span>
          </button>
          <span className="library-authoring-options">
            <button className="text-button" onClick={onWrite}>
              自己写文档
            </button>
          </span>
        </div>
        <div className="library-toolbar">
          <div className="filter-tabs" role="group" aria-label="内容类型">
            {(
              [
                "all",
                "document",
                "pdf",
                "image",
                "task",
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
                {kind === "all" && <small>{objects.length}</small>}
              </button>
            ))}
          </div>
          <div className="library-controls">
            <label className="search-field">
              <Search />
              <input
                aria-label="搜索项目内容"
                placeholder="搜索内容"
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
        aria-label="资料列表"
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
                  <div className="artifact-preview" data-kind={a.content.kind}>
                    {a.content.kind === "image" ? (
                      <img
                        src={"/api/assets/" + a.content.assetId}
                        alt={a.content.alt || a.title}
                      />
                    ) : (
                      <>
                        <span className="eyebrow">
                          <ObjectIcon kind={a.content.kind} />
                          {kindLabel[a.content.kind]}
                        </span>
                        <h2>{a.title}</h2>
                        <p>
                          {a.content.kind === "document"
                            ? a.content.markdown
                                .replace(/^#+\s/gm, "")
                                .slice(0, 160)
                            : a.content.kind === "pdf"
                              ? `${a.content.pages.length} 页 · ${a.content.pages.join(" ").slice(0, 120) || "扫描文档"}`
                              : a.content.description.slice(0, 160)}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="artifact-caption">
                    <ObjectIcon kind={a.content.kind} />
                    <span>
                      {a.title}
                      <small>
                        {kindLabel[a.content.kind]} · v{a.revision}
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
              {objects.length ? <Search /> : <FolderOpen />}
            </span>
            <h2>
              {objects.length ? "没有找到匹配的内容" : "让第一个想法落地"}
            </h2>
            <p>
              {objects.length
                ? "试试其他关键词，或切换内容类型。"
                : "描述你要做的事，或导入已有素材。"}
            </p>
            {objects.length > 0 && (
              <button
                className="outline"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
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
