import { useEffect, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import type {
  PlatformContent,
  PlatformWorkRelation,
} from "./platform-client.js";
import { useContentDirectory } from "./useContentDirectory.js";

/** Existing relationships stay visible; editing one is an explicit secondary action. */
export function ObjectRelations({
  artifact,
  state,
  client,
  onOpen,
}: {
  artifact: Artifact;
  state: Workspace;
  client: WorkspaceClient;
  onOpen(id: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [relations, setRelations] = useState<PlatformWorkRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedScope, setLoadedScope] = useState("");
  const [lookupRetry, setLookupRetry] = useState(0);
  const scope = `${client.boot?.csrfToken ?? ""}:${artifact.id}`;
  const [query, setQuery] = useState("");
  const directory = useContentDirectory(
    client,
    {
      projectId: artifact.projectId,
      availability: "available",
      query,
      sort: "updated",
    },
    editing,
  );
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void client.workRelationsFor(artifact.id, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) {
          setRelations(value);
          setError("");
          setLoadedScope(scope);
          setLoading(false);
        }
      },
      (cause) => {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "关联读取失败。");
          setLoadedScope(scope);
          setLoading(false);
        }
      },
    );
    return () => abort.abort();
  }, [scope]);
  const visibleRelations = loadedScope === scope ? relations : [];
  const visibleError = loadedScope === scope ? error : "";
  const visibleLoading = loadedScope !== scope || loading;
  const relatedIds = new Set(
    visibleRelations.map((relation) =>
      relation.fromId === artifact.id ? relation.toId : relation.fromId,
    ),
  );
  const lookupIds = [...relatedIds].filter(
    (id) =>
      !state.artifacts.some(
        (entry) => entry.id === id && entry.content.kind === "task",
      ),
  );
  const lookupScope = JSON.stringify([
    scope,
    client.contentCatalogVersion,
    lookupIds,
    lookupRetry,
  ]);
  const [resolved, setResolved] = useState<{
    scope: string;
    entries: Map<string, PlatformContent>;
    error: string;
  }>({ scope: "", entries: new Map(), error: "" });
  useEffect(() => {
    let active = true;
    void (async () => {
      const entries = new Map<string, PlatformContent>();
      try {
        for (let index = 0; index < lookupIds.length; index += 8) {
          const batch = await Promise.all(
            lookupIds
              .slice(index, index + 8)
              .map((id) => client.resolveCatalogContent(id)),
          );
          if (!active) return;
          for (const entry of batch) if (entry) entries.set(entry.id, entry);
        }
        if (active) setResolved({ scope: lookupScope, entries, error: "" });
      } catch (cause) {
        if (active)
          setResolved({
            scope: lookupScope,
            entries,
            error:
              cause instanceof Error ? cause.message : "关联标题暂不可用。",
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [lookupScope]);
  const related = visibleRelations.flatMap((relation) => {
    const id =
      relation.fromId === artifact.id
        ? relation.toId
        : relation.toId === artifact.id
          ? relation.fromId
          : null;
    const object =
      state.artifacts.find(
        (entry) => entry.id === id && entry.content.kind === "task",
      ) ??
      (resolved.scope === lookupScope ? resolved.entries.get(id ?? "") : null);
    return id ? [{ relation, id, object }] : [];
  });
  const search = query.trim().toLocaleLowerCase();
  const candidates = [
    ...state.artifacts.filter(
      (entry) =>
        entry.content.kind === "task" &&
        entry.title.toLocaleLowerCase().includes(search),
    ),
    ...directory.items,
  ].filter(
    (a) =>
      a.projectId === artifact.projectId &&
      a.id !== artifact.id &&
      !relatedIds.has(a.id),
  );
  const canAdd = artifact.content.kind !== "task";
  if (!related.length && !canAdd && !visibleLoading && !visibleError)
    return null;
  return (
    <section
      className={`relations object-relations ${canAdd ? "" : "task-relations"}`}
      aria-label="关联对象"
    >
      <div className="relation-heading">
        <span>
          <Link2 />
          关联{related.length ? ` · ${related.length}` : "对象"}
        </span>
        {canAdd && (
          <button
            type="button"
            aria-label={editing ? "收起关联工具" : "关联其他对象"}
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            {editing ? <X /> : <Plus />}
            {editing ? "收起" : "添加"}
          </button>
        )}
      </div>
      {related.length > 0 && (
        <div className="relation-list">
          {related.map(({ relation, id, object }) => (
            <button
              key={relation.id}
              disabled={!object}
              onClick={() => onOpen(id)}
            >
              {object?.title ?? "对象暂不可用"}
            </button>
          ))}
        </div>
      )}
      {editing && (
        <form
          className="relation-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!target || saving) return;
            setSaving(true);
            setError("");
            try {
              await client.execute({
                type: "link-artifacts",
                fromId: artifact.id,
                toId: target,
                relation: "references",
              });
              setRelations(await client.workRelationsFor(artifact.id));
              setTarget("");
              setEditing(false);
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : "关联未保存，请重试。",
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          <input
            type="search"
            aria-label="查找关联对象"
            placeholder="按标题查找同项目对象"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setTarget("");
            }}
          />
          <select
            aria-label="要关联的对象"
            value={target}
            disabled={saving}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">选择同项目的对象…</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
          <button disabled={!target || saving}>
            {saving ? "正在关联…" : "添加关联"}
          </button>
          {directory.nextCursor && (
            <button
              type="button"
              disabled={directory.busy}
              onClick={() => void directory.loadMore()}
            >
              {directory.busy ? "正在加载…" : "继续加载"}
            </button>
          )}
          {!directory.busy && !directory.error && !candidates.length && (
            <small>同项目中暂无匹配对象。</small>
          )}
          {directory.error && (
            <small role="alert">
              {directory.error}{" "}
              <button type="button" onClick={directory.retry}>
                重试
              </button>
            </small>
          )}
        </form>
      )}
      {visibleError && <p role="alert">{visibleError}</p>}
      {resolved.scope === lookupScope && resolved.error && (
        <p role="alert">
          {resolved.error}{" "}
          <button type="button" onClick={() => setLookupRetry((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
    </section>
  );
}
