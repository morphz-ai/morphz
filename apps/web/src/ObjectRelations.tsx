import { useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";

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
  const related = state.relations.flatMap((relation) => {
    const id =
      relation.fromId === artifact.id
        ? relation.toId
        : relation.toId === artifact.id
          ? relation.fromId
          : null;
    const object = state.artifacts.find((a) => a.id === id);
    return object ? [{ relation, object }] : [];
  });
  const candidates = state.artifacts.filter(
    (a) =>
      a.projectId === artifact.projectId &&
      a.id !== artifact.id &&
      !related.some(({ object }) => object.id === a.id),
  );
  const canAdd = artifact.content.kind !== "task";
  if (!related.length && !canAdd) return null;
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
          {related.map(({ relation, object }) => (
            <button key={relation.id} onClick={() => onOpen(object.id)}>
              {object.title}
            </button>
          ))}
        </div>
      )}
      {editing &&
        (candidates.length ? (
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
                setTarget("");
                setEditing(false);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "关联未保存，请重试。",
                );
              } finally {
                setSaving(false);
              }
            }}
          >
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
          </form>
        ) : (
          <p className="muted">同一工作空间中暂无其他可关联的对象。</p>
        ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
