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
  Clapperboard,
} from "lucide-react";
import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import { contentOwnershipTitle } from "../../../packages/core/src/content.js";
import { scopedStorage, type WorkspaceClient } from "./client.js";
import { ObjectIcon, kindLabel } from "./ArtifactEditor.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { ContentMetadata } from "./ContentMetadata.js";
import { ContentPreview } from "./ContentPreview.js";
import {
  contentOrigin,
  contentSorts,
  relatedContentTasks,
  type ContentSort,
} from "./content-catalog.js";
import {
  catalogContentEntries,
  listingKind,
  listingRevision,
  type CatalogContentEntry,
} from "./catalog-content-entries.js";
import { CatalogPreview } from "./CatalogPreview.js";
import { useVisibleScriptOverview } from "./useVisibleScriptOverview.js";
import { useContentDirectory } from "./useContentDirectory.js";
import { searchPreview } from "./document-presentation.js";
import { scriptLibraryEntryFromContent } from "./platform-workspace-view.js";

const listedApps = ["morphz.objects", "morphz.reader", "morphz.script-studio"];

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
    ["all", "document", "pdf", "image", "interactive", "script"].includes(
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
    : projects.some(
          (p) =>
            p.id === catalogScope &&
            !p.deletedAt &&
            (!p.kind || ["project", "desk"].includes(p.kind)),
        )
      ? catalogScope
      : "all";
  const [editing, setEditing] = useState<{
    entry: CatalogContentEntry;
    mode: "rename" | "move";
  } | null>(null);
  const [undo, setUndo] = useState<{
    old: CatalogContentEntry;
    revision: number;
    mode: "rename" | "move";
  } | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const directory = useContentDirectory(
    client,
    {
      ...(scope === "all" ? {} : { projectId: scope }),
      appIds: listedApps,
      ...(filter === "all" ? {} : { kind: filter }),
      ...(query.trim() ? { query: query.trim() } : {}),
      sort,
    },
    true,
    true,
  );
  const hits = new Map(directory.matches.map((hit) => [hit.artifactId, hit]));
  const contentObjects = catalogContentEntries(state, directory.items);
  const byId = new Map(
    contentObjects.map((entry) => [
      entry.kind === "script"
        ? (entry.value.contentId ?? entry.value.id)
        : entry.value.id,
      entry,
    ]),
  );
  const visible = directory.items.flatMap((item) => {
    const entry = byId.get(item.id);
    return entry ? [entry] : [];
  });
  const ownerTitles = new Map(
    projects.map((p) => [p.id, contentOwnershipTitle(p)]),
  );
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
        target: {
          kind:
            undo.old.kind === "catalog"
              ? listingKind(undo.old) === "script"
                ? "script"
                : "artifact"
              : undo.old.kind,
          id:
            undo.old.kind === "catalog" && listingKind(undo.old) === "script"
              ? undo.old.value.appObjectId
              : undo.old.value.id,
        },
        expectedRevision: undo.revision,
        changes:
          undo.mode === "rename"
            ? { title: undo.old.value.title }
            : { projectId: undo.old.value.projectId },
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
            {(
              [
                "all",
                "document",
                "pdf",
                "image",
                "interactive",
                "script",
              ] as const
            ).map((kind) => (
              <button
                key={kind}
                aria-pressed={kind === filter}
                onClick={() => setFilter(kind)}
              >
                {kind === "all"
                  ? "全部"
                  : kind === "script"
                    ? "剧本"
                    : kindLabel[kind]}
              </button>
            ))}
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
                <option value="all">全部内容</option>
                {projects
                  .filter(
                    (p) =>
                      !p.deletedAt &&
                      (!p.kind || ["project", "desk"].includes(p.kind)),
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {contentOwnershipTitle(p)}
                    </option>
                  ))}
              </select>
            )}
            <label className="search-field" title="查找标题或智能体产物正文">
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
            {directory.busy && directory.count === null
              ? "正在查找…"
              : `${directory.count ?? visible.length} 项内容`}
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
              {undo.mode === "rename" ? "已重命名" : "已设置项目"}：
              {undo.old.value.title}
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
        {directory.error && (
          <p className="content-search-note" role="alert">
            {directory.error} <button onClick={directory.retry}>重试</button>
          </p>
        )}
        {directory.searchError && (
          <p className="content-search-note" role="alert">
            {directory.searchError}{" "}
            <button onClick={directory.retry}>重试</button>
          </p>
        )}
        <div className={layout === "grid" ? "artifact-grid" : "artifact-list"}>
          {visible.map((entry) => {
            if (
              entry.kind === "catalog" &&
              entry.value.appId === "morphz.script-studio"
            ) {
              const script = entry.value;
              return (
                <article className="artifact-card" key={script.id}>
                  <button
                    className="artifact-card-open"
                    aria-label={`打开内容：${script.title}`}
                    onClick={() => onOpen(script.id)}
                  >
                    <div className="artifact-card-heading">
                      <Clapperboard />
                      <h2>{script.title}</h2>
                    </div>
                    {layout === "grid" && (
                      <p className="content-match">
                        <ScriptCatalogProgress
                          client={client}
                          entry={scriptLibraryEntryFromContent(script)}
                        />
                      </p>
                    )}
                    <div className="artifact-caption">
                      <span>{ownerTitles.get(script.projectId)} · 剧本</span>
                      <time dateTime={script.updatedAt}>
                        {new Date(script.updatedAt).toLocaleDateString(
                          "zh-CN",
                          { month: "short", day: "numeric" },
                        )}
                      </time>
                    </div>
                  </button>
                  <div className="content-item-actions">
                    <ComposerOptions
                      label={`内容操作：${script.title}`}
                      menuLabel="内容操作"
                      below
                      options={[
                        {
                          label: "重命名",
                          icon: <PencilLine />,
                          disabled: !client.online,
                          onSelect: () => setEditing({ entry, mode: "rename" }),
                        },
                        {
                          label: "设置项目",
                          icon: <FolderOpen />,
                          disabled: !client.online,
                          onSelect: () => setEditing({ entry, mode: "move" }),
                        },
                      ]}
                    />
                  </div>
                </article>
              );
            }
            if (entry.kind === "catalog") {
              const a = entry.value;
              const kind = listingKind(entry);
              const knownKind = kind in kindLabel;
              const hit = hits.get(a.id);
              const snippet =
                hit?.revision === listingRevision(entry)
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
                    title={`${a.title} · v${listingRevision(entry)}`}
                  >
                    <div className="artifact-card-heading">
                      {kind === "script" ? (
                        <Clapperboard />
                      ) : knownKind ? (
                        <ObjectIcon
                          kind={kind as Artifact["content"]["kind"]}
                        />
                      ) : (
                        <FilePlus2 />
                      )}
                      <h2>{a.title}</h2>
                    </div>
                    {snippet ? (
                      <p className="content-match">{snippet}</p>
                    ) : (
                      layout === "grid" &&
                      kind !== "script" && (
                        <CatalogPreview id={a.id} client={client} />
                      )
                    )}
                    <div className="artifact-caption">
                      <span>
                        {ownerTitles.get(a.projectId) ?? "所属空间不可用"} ·{" "}
                        {kind === "script"
                          ? "剧本"
                          : knownKind
                            ? kindLabel[kind as keyof typeof kindLabel]
                            : "内容"}
                      </span>
                      <time dateTime={a.updatedAt}>
                        {new Date(a.updatedAt).toLocaleDateString("zh-CN", {
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                    </div>
                  </button>
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
                          onSelect: () => setEditing({ entry, mode: "rename" }),
                          disabled: !client.online,
                        },
                        {
                          label: "设置项目",
                          icon: <FolderOpen />,
                          onSelect: () => setEditing({ entry, mode: "move" }),
                          disabled: !client.online,
                        },
                      ]}
                    />
                  </div>
                </article>
              );
            }
            if (entry.kind === "script") {
              const p = entry.value;
              return (
                <article className="artifact-card" key={p.id}>
                  <button
                    className="artifact-card-open"
                    aria-label={`打开内容：${p.title}`}
                    onClick={() => onOpen(p.id)}
                  >
                    <div className="artifact-card-heading">
                      <Clapperboard />
                      <h2>{p.title}</h2>
                    </div>
                    {layout === "grid" && (
                      <p className="content-match">
                        {p.items.filter((i) => i.kind === "episode").length} 集
                        · {p.items.filter((i) => i.kind === "scene").length} 场
                      </p>
                    )}
                    <div className="artifact-caption">
                      <span>{ownerTitles.get(p.projectId)} · 剧本</span>
                      <span className="content-origin">
                        {contentOrigin(p, state.actants)}
                      </span>
                      <time dateTime={p.updatedAt}>
                        {new Date(p.updatedAt).toLocaleDateString("zh-CN", {
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                    </div>
                  </button>
                  <div className="content-item-actions">
                    <ComposerOptions
                      label={`内容操作：${p.title}`}
                      menuLabel="内容操作"
                      below
                      options={[
                        {
                          label: "重命名",
                          icon: <PencilLine />,
                          disabled: !client.online,
                          onSelect: () => setEditing({ entry, mode: "rename" }),
                        },
                        {
                          label: "设置项目",
                          icon: <FolderOpen />,
                          disabled: !client.online,
                          onSelect: () => setEditing({ entry, mode: "move" }),
                        },
                      ]}
                    />
                  </div>
                </article>
              );
            }
            const a = entry.value;
            const tasks = relatedContentTasks(a, objects, state.relations);
            const hit = hits.get(a.id);
            const snippet =
              hit?.revision === a.revision
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
                  {snippet ? (
                    <p className="content-match">{snippet}</p>
                  ) : (
                    layout === "grid" && <ContentPreview artifact={a} />
                  )}
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
                        onSelect: () => setEditing({ entry, mode: "rename" }),
                        disabled:
                          !client.online ||
                          (a.content.kind === "document" &&
                            !!a.content.understanding),
                      },
                      {
                        label: "设置项目",
                        icon: <FolderOpen />,
                        onSelect: () => setEditing({ entry, mode: "move" }),
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
        {!visible.length &&
          !directory.busy &&
          !directory.error &&
          !directory.searchError && (
            <div className="empty-state">
              <span className="empty-icon">
                <Search />
              </span>
              <h2>
                {query || filter !== "all"
                  ? "没有找到匹配的内容"
                  : "这个范围内还没有内容"}
              </h2>
              {(scope !== "all" || query || filter !== "all") && (
                <button
                  className="outline"
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                    if (catalog && !directory.count) onScopeChange?.("all");
                  }}
                >
                  显示全部内容
                </button>
              )}
            </div>
          )}
        {directory.nextCursor && (
          <button
            className="outline content-load-more"
            disabled={directory.busy}
            onClick={() => void directory.loadMore()}
          >
            继续加载
          </button>
        )}
      </div>
      {editing && (
        <ContentMetadata
          entry={editing.entry}
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

function ScriptCatalogProgress({
  client,
  entry,
}: {
  client: WorkspaceClient;
  entry: import("./platform-client.js").ScriptLibraryEntry;
}) {
  const { element, overview, error } =
    useVisibleScriptOverview<HTMLSpanElement>(client, entry);
  return (
    <span ref={element}>
      {overview
        ? `${overview.progress.episodes} 集 · ${overview.progress.scenes} 场`
        : error
          ? "进度暂不可用"
          : "读取进度中…"}
    </span>
  );
}
