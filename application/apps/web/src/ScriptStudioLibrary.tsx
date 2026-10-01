import { ArrowUpRight, Clapperboard, Search, X } from "lucide-react";
import { useLayoutEffect } from "react";
import type { ScriptLibraryEntry } from "./platform-client.js";
import { scriptDisplayTime } from "../../../packages/core/src/script-studio-presentation.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import { contentOwnershipTitle } from "../../../packages/core/src/content.js";
import type { WorkspaceClient } from "./client.js";
import { useVisibleScriptOverview } from "./useVisibleScriptOverview.js";
import { useContentDirectory } from "./useContentDirectory.js";
import { scriptLibraryEntryFromContent } from "./platform-workspace-view.js";

/** A view of this workspace's existing scripts, never a second object store. */
export function ScriptStudioLibrary({
  projectId,
  projects,
  client,
  global = false,
  lastOpenedId,
  query,
  onQuery,
  onReady,
  onOpen,
  disabled,
}: {
  projectId: string;
  projects: Workspace["projects"];
  client: WorkspaceClient;
  global?: boolean;
  lastOpenedId: string;
  query: string;
  onQuery: (value: string) => void;
  onReady: () => void;
  onOpen: (id: string) => void;
  disabled: boolean;
}) {
  const directory = useContentDirectory(client, {
    ...(!global ? { projectId } : {}),
    appIds: ["morphz.script-studio"],
    kind: "script",
    availability: "available",
    ...(query.trim() ? { query: query.trim() } : {}),
    sort: "updated",
  });
  const matches = directory.items.map(scriptLibraryEntryFromContent);
  useLayoutEffect(() => {
    if (!directory.busy) onReady();
  }, [directory.items, directory.busy, onReady]);
  const ownerTitles = new Map(
    projects.map((owner) => [owner.id, contentOwnershipTitle(owner)]),
  );
  return (
    <div className="script-library">
      <div className="script-library-filters">
        <div className="script-library-search">
          <Search aria-hidden="true" />
          <input
            aria-label="查找剧本"
            placeholder="查找剧本"
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
        <span role="status">{directory.count ?? matches.length} 部剧本</span>
        {query && (
          <button
            type="button"
            className="text-button"
            onClick={() => onQuery("")}
          >
            <X />
            清除搜索
          </button>
        )}
      </div>
      {directory.error && (
        <p className="script-error" role="alert">
          {directory.error} <button onClick={directory.retry}>重试</button>
        </p>
      )}
      {matches.length ? (
        <ul
          className="script-library-list"
          aria-label={global ? "全部剧本" : "项目剧本"}
        >
          {matches.map((p) => (
            <ScriptLibraryCard
              key={p.id}
              production={p}
              ownerTitle={ownerTitles.get(p.projectId) ?? "所属项目不可用"}
              client={client}
              global={global}
              lastOpenedId={lastOpenedId}
              disabled={disabled}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : !directory.busy && !directory.error ? (
        <div className="script-empty">
          <Clapperboard aria-hidden="true" />
          <p>{query.trim() ? "没有找到符合条件的剧本" : "这里还没有剧本"}</p>
        </div>
      ) : null}
      {directory.nextCursor && (
        <button
          type="button"
          className="outline content-load-more"
          disabled={directory.busy}
          onClick={() => void directory.loadMore()}
        >
          继续加载
        </button>
      )}
    </div>
  );
}

function ScriptLibraryCard({
  production: p,
  ownerTitle,
  client,
  global,
  lastOpenedId,
  disabled,
  onOpen,
}: {
  production: ScriptLibraryEntry;
  ownerTitle: string;
  client: WorkspaceClient;
  global: boolean;
  lastOpenedId: string;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  const { element, overview, error } = useVisibleScriptOverview<HTMLLIElement>(
    client,
    p,
  );
  const {
    episodes,
    scenes,
    pendingCandidates: pending,
  } = overview?.progress ?? {
    episodes: 0,
    scenes: 0,
    pendingCandidates: 0,
  };
  return (
    <li ref={element}>
      <button
        type="button"
        className="script-library-card"
        data-production-id={p.id}
        aria-label={`打开剧本：${p.title}`}
        title={p.title}
        disabled={disabled}
        onClick={() => onOpen(p.id)}
      >
        <span className="script-card-heading">
          <Clapperboard aria-hidden="true" />
          <strong>{p.title}</strong>
          <ArrowUpRight aria-hidden="true" />
        </span>
        <span className="script-card-meta">
          {global && <span>{ownerTitle} · </span>}
          {overview
            ? `${overview.brief.mode === "adaptation" ? "改编" : "原创"}${overview.brief.genre.trim() ? ` · ${overview.brief.genre}` : ""}`
            : error
              ? "详情暂不可用"
              : "读取详情中…"}
        </span>
        <span className="script-card-progress">
          {overview
            ? episodes || scenes
              ? `${episodes} 集 · ${scenes} 场`
              : "尚无分集或分场"
            : "\u00a0"}
          {pending > 0 && <span>{pending} 个候选待决定</span>}
        </span>
        <span className="script-card-footer">
          <time dateTime={p.updatedAt}>{scriptDisplayTime(p.updatedAt)}</time>
          {p.id === lastOpenedId && <span>上次打开</span>}
        </span>
      </button>
    </li>
  );
}
