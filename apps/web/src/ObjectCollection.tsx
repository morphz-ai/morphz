import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  FilePlus2,
  Search,
  LayoutGrid,
  List,
  FolderOpen,
  X,
  PencilLine,
  MessageSquareText,
  ArrowRight,
} from "lucide-react";
import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import { isContentArtifact } from "../../../packages/core/src/model.js";
import { searchTerms } from "../../../packages/core/src/retrieval.js";
import { scopedStorage, type WorkspaceClient } from "./client.js";
import { ObjectIcon, kindLabel } from "./ArtifactEditor.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { ContentMetadata } from "./ContentMetadata.js";
import { ContentPreview } from "./ContentPreview.js";
import {
  compareContent,
  contentOrigin,
  contentSorts,
  relatedContentTasks,
  type ContentSort,
} from "./content-catalog.js";
import { useContentSearch } from "./useContentSearch.js";
import { searchPreview } from "./document-presentation.js";

export function ObjectCollection({
  project,
  projects,
  objects,
  state,
  client,
  onOpen,
  onCompose,
  onCreate,
  onWrite,
  catalog = false,
  catalogScope = "all",
  onScopeChange,
  toolbarTarget,
}: {
  project: { id: string; title: string };
  projects: Workspace["projects"];
  objects: Artifact[];
  state: Workspace;
  client: WorkspaceClient;
  onOpen: (id: string) => void;
  onCompose: (id: string) => void;
  onCreate: (kind: "document" | "task" | "website" | "interactive") => void;
  onWrite: () => void;
  catalog?: boolean;
  catalogScope?: string;
  onScopeChange?: (scope: string) => void;
  toolbarTarget?: HTMLElement | null;
}) {
  const storage = useState(() => scopedStorage())[0];
  const key = "library-view:" + (catalog ? "all-content" : project.id);
  const [saved] = useState(() =>
    storage.readLocal<{
      filter?: string;
      query?: string;
      layout?: string;
      scope?: string;
      sort?: string;
    }>(key, {}),
  );
  const [filter, setFilter] = useState(
    ["all", "document", "pdf", "image", "interactive"].includes(
      saved.filter ?? "",
    )
      ? saved.filter!
      : "all",
  );
  const [query, setQuery] = useState(
    typeof saved.query === "string" ? saved.query.slice(0, 200) : "",
  );
  const [layout, setLayout] = useState(
    saved.layout === "list" ? "list" : "grid",
  );
  const [sort, setSort] = useState<ContentSort>(
    saved.sort && Object.hasOwn(contentSorts, saved.sort)
      ? (saved.sort as ContentSort)
      : "updated",
  );
  const scope = !catalog
    ? project.id
    : projects.some((p) => p.id === catalogScope)
      ? catalogScope
      : "all";
  const [editing, setEditing] = useState<{
    artifact: Artifact;
    mode: "rename" | "move";
  } | null>(null);
  const [undo, setUndo] = useState<{
    old: Artifact;
    revision: number;
    mode: "rename" | "move";
  } | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const contentObjects = objects.filter(isContentArtifact);
  const scopedObjects = contentObjects.filter(
    (a) => scope === "all" || a.projectId === scope,
  );
  const ownerTitles = new Map(projects.map((p) => [p.id, p.title]));
  const search = useContentSearch(client, query, scope);
  const hits = new Map(
    search.hits
      .filter((hit) => hit.kind !== "task")
      .map((hit) => [hit.artifactId, hit]),
  );
  const terms = searchTerms(query);
  const visible = scopedObjects
    .filter(
      (a) =>
        (filter === "all" || a.content.kind === filter) &&
        (!terms.length ||
          terms.every((term) => a.title.toLocaleLowerCase().includes(term)) ||
          hits.has(a.id)),
    )
    .sort((a, b) => compareContent(sort, a, b));
  useEffect(() => {
    try {
      storage.writeLocal(key, { filter, query, layout, scope, sort });
    } catch {
      /* Browsing still works. */
    }
  }, [key, filter, query, layout, scope, sort]);
  async function undoChange() {
    if (!undo) return;
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "organize-content",
        artifactId: undo.old.id,
        expectedRevision: undo.revision,
        changes:
          undo.mode === "rename"
            ? { title: undo.old.title }
            : { projectId: undo.old.projectId },
      });
      setUndo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销失败。");
    } finally {
      setBusy(false);
    }
  }
  const creation = (
    <div className="content-actions" role="group" aria-label="创建内容">
      <button
        className="secondary-action"
        aria-label="让 Morphz 起草"
        title={`让智能体起草文档 · ${project.title}`}
        onClick={() => onCreate("document")}
      >
        <FilePlus2 />
        <span>起草文档</span>
      </button>
      <ComposerOptions
        label="其他内容创作"
        menuLabel="内容创作"
        below
        options={[
          {
            label: "手动写文档",
            text: "手动写文档",
            icon: <PencilLine />,
            onSelect: onWrite,
          },
        ]}
      />
    </div>
  );
  return (
    <section
      className="collection library-collection"
      aria-label={catalog ? "全部内容" : `${project.title}的内容`}
    >
      {catalog && toolbarTarget
        ? createPortal(creation, toolbarTarget)
        : creation}
      <div className="library-chrome">
        <div className="library-toolbar">
          <div className="filter-tabs" role="group" aria-label="内容类型">
            {(["all", "document", "pdf", "image", "interactive"] as const).map(
              (kind) => (
                <button
                  key={kind}
                  aria-pressed={kind === filter}
                  onClick={() => setFilter(kind)}
                >
                  {kind === "all" ? "全部" : kindLabel[kind]}
                </button>
              ),
            )}
          </div>
          <div className="library-controls">
            {catalog && (
              <select
                className="library-scope"
                aria-label="内容范围"
                title="查看内容与起草位置"
                value={scope}
                onChange={(e) => onScopeChange?.(e.target.value)}
              >
                <option value="all">全部工作空间</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            )}
            <label
              className="search-field"
              title="搜索标题及智能体产物正文；导入文件仅匹配标题"
            >
              <Search />
              <input
                aria-label="搜索内容"
                placeholder="搜索内容"
                value={query}
                maxLength={200}
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
        <div className="library-caption">
          <span>
            {search.busy
              ? "正在查找…"
              : `${visible.length} 项内容${terms.length && search.more ? " · 还有匹配结果" : ""}`}
          </span>
          <select
            aria-label="内容排序"
            value={sort}
            onChange={(e) => setSort(e.target.value as ContentSort)}
          >
            {Object.entries(contentSorts).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {undo && (
          <div className="content-feedback" role="status">
            <span>
              {undo.mode === "rename" ? "已重命名" : "已移动"}：{undo.old.title}
            </span>
            <button disabled={busy} onClick={() => void undoChange()}>
              撤销
            </button>
            <button
              className="icon-button"
              aria-label="关闭操作提示"
              onClick={() => setUndo(null)}
            >
              <X />
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {search.error && (
          <p className="content-search-note" role="alert">
            {search.error} <button onClick={search.retry}>重试</button>
          </p>
        )}
        <div className={layout === "grid" ? "artifact-grid" : "artifact-list"}>
          {visible.map((a) => {
            const tasks = relatedContentTasks(a, objects, state.relations);
            const hit = hits.get(a.id);
            const snippet =
              terms.length &&
              hit?.revision === a.revision &&
              hit.matchedIn === "content"
                ? searchPreview(hit.excerpt, a.title, query, {
                    kind: hit.kind,
                    page: hit.page,
                  })
                : null;
            return (
              <article className="artifact-card" key={a.id}>
                <button
                  className="artifact-card-open"
                  onClick={() => onOpen(a.id)}
                  aria-label={`打开内容：${a.title}`}
                  title={`${a.title} · v${a.revision}`}
                >
                  <div className="artifact-card-heading">
                    <ObjectIcon kind={a.content.kind} />
                    <h2>{a.title}</h2>
                  </div>
                  {layout === "grid" && !snippet && (
                    <ContentPreview artifact={a} />
                  )}
                  {snippet && <p className="content-match">{snippet}</p>}
                  <div className="artifact-caption">
                    <span>
                      {ownerTitles.get(a.projectId) ?? "所属空间不可用"} ·{" "}
                      {kindLabel[a.content.kind]}
                    </span>
                    <span className="content-origin">
                      {contentOrigin(a, state.actants)}
                    </span>
                    <time
                      dateTime={a.updatedAt}
                      title={`修改于 ${new Date(a.updatedAt).toLocaleString("zh-CN")}`}
                    >
                      {new Date(a.updatedAt).toLocaleDateString("zh-CN", {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </div>
                </button>
                {tasks.length > 0 && (
                  <div className="content-related">
                    <span>来自事项</span>
                    {tasks.slice(0, 1).map((task) => (
                      <button
                        key={task.id}
                        onClick={() => onOpen(task.id)}
                        title={task.title}
                      >
                        <span>{task.title}</span>
                        <ArrowRight />
                      </button>
                    ))}
                    {tasks.length > 1 && <span>等 {tasks.length} 项</span>}
                  </div>
                )}
                <div className="content-item-actions">
                  <button
                    className="icon-button"
                    aria-label={`让智能体处理：${a.title}`}
                    title="让智能体处理"
                    onClick={() => onCompose(a.id)}
                  >
                    <MessageSquareText />
                  </button>
                  <ComposerOptions
                    label={`内容操作：${a.title}`}
                    menuLabel="内容操作"
                    below
                    options={[
                      {
                        label: "重命名",
                        icon: <PencilLine />,
                        onSelect: () =>
                          setEditing({ artifact: a, mode: "rename" }),
                        disabled:
                          !client.online ||
                          (a.content.kind === "document" &&
                            !!a.content.understanding),
                      },
                      {
                        label: "移动到项目",
                        icon: <FolderOpen />,
                        onSelect: () =>
                          setEditing({ artifact: a, mode: "move" }),
                        disabled:
                          !client.online ||
                          (a.content.kind === "document" &&
                            !!a.content.understanding),
                      },
                    ]}
                  />
                </div>
              </article>
            );
          })}
        </div>
        {!visible.length && !search.busy && (
          <div className="empty-state">
            <span className="empty-icon">
              <Search />
            </span>
            <h2>
              {scopedObjects.length
                ? "没有找到匹配的内容"
                : "这个范围内还没有内容"}
            </h2>
            {terms.length > 0 && (
              <p>可搜索标题及智能体产物正文；导入文件仅按标题查找。</p>
            )}
            {(scope !== "all" || query || filter !== "all") && (
              <button
                className="outline"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                  if (catalog && !scopedObjects.length) onScopeChange?.("all");
                }}
              >
                显示全部内容
              </button>
            )}
          </div>
        )}
        {terms.length > 0 && search.more && (
          <button
            className="outline content-load-more"
            disabled={search.busy}
            onClick={() => void search.loadMore()}
          >
            继续查找
          </button>
        )}
      </div>
      {editing && (
        <ContentMetadata
          artifact={editing.artifact}
          mode={editing.mode}
          projects={projects}
          client={client}
          onClose={() => setEditing(null)}
          onSaved={(old, revision) => {
            setError("");
            setUndo({ old, revision, mode: editing.mode });
          }}
        />
      )}
    </section>
  );
}
