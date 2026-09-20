import { ArrowUpRight, Clapperboard, Search, X } from "lucide-react";
import type { ScriptProduction } from "../../../packages/core/src/script-studio.js";
import { scriptDisplayTime } from "../../../packages/core/src/script-studio-presentation.js";

/** A view of this workspace's existing scripts, never a second object store. */
export function ScriptStudioLibrary({
  productions,
  lastOpenedId,
  query,
  onQuery,
  onOpen,
  disabled,
}: {
  productions: ScriptProduction[];
  lastOpenedId: string;
  query: string;
  onQuery: (value: string) => void;
  onOpen: (id: string) => void;
  disabled: boolean;
}) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = [...productions]
    .filter((p) =>
      words.every((word) => p.title.toLocaleLowerCase().includes(word)),
    )
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
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
        <span role="status">
          {words.length
            ? `${matches.length} / ${productions.length}`
            : productions.length}{" "}
          部剧本
        </span>
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
      {matches.length ? (
        <ul className="script-library-list" aria-label="本空间剧本">
          {matches.map((p) => {
            const episodes = p.items.filter((i) => i.kind === "episode").length;
            const scenes = p.items.filter((i) => i.kind === "scene").length;
            const pending = p.candidates.filter(
              (c) => c.status === "pending",
            ).length;
            return (
              <li key={p.id}>
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
                    {p.brief.mode === "adaptation" ? "改编" : "原创"}
                    {p.brief.genre.trim() && ` · ${p.brief.genre}`}
                  </span>
                  <span className="script-card-progress">
                    {episodes || scenes
                      ? `${episodes} 集 · ${scenes} 场`
                      : "尚无分集或分场"}
                    {pending > 0 && <span>{pending} 个候选待决定</span>}
                  </span>
                  <span className="script-card-footer">
                    <time dateTime={p.updatedAt}>
                      {scriptDisplayTime(p.updatedAt)}
                    </time>
                    {p.id === lastOpenedId && <span>上次打开</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="script-empty">
          <Clapperboard aria-hidden="true" />
          <p>{words.length ? "没有找到符合条件的剧本" : "这里还没有剧本"}</p>
        </div>
      )}
    </div>
  );
}
