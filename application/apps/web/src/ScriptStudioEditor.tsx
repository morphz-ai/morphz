import { useEffect, useRef, useState } from "react";
import {
  currentScriptDraft,
  scriptCandidateStale,
  scriptDraftSchema,
  scriptIssues,
  scriptImpact,
  scriptKindLabels,
  type ScriptDraft,
  type ScriptGeneration,
  type ScriptItem,
  type ScriptProduction,
  type ScriptReview,
} from "../../../packages/core/src/script-studio.js";
import { quotedText } from "../../../packages/core/src/model.js";
import { draftKey, scopedStorage, type WorkspaceClient } from "./client.js";
import {
  StudioDialog,
  scriptStatusLabels,
  type ScriptRun,
} from "./ScriptStudio.js";

type DraftState = { baseRevision: number; draft: ScriptDraft };
type Props = {
  client: WorkspaceClient;
  production: ScriptProduction;
  item: ScriptItem;
  canWrite: boolean;
  run: ScriptRun;
  onCompose: (text: string, generation?: ScriptGeneration) => void;
};
export function ScriptItemEditor({
  client,
  production,
  item,
  canWrite,
  run,
  onCompose,
}: Props) {
  const boot = client.boot!;
  const storage = scopedStorage(`${boot.centerId}:${boot.principalId}`);
  const localKey = draftKey(
    `script:${production.projectId}:${production.id}:${item.id}`,
  );
  const current = currentScriptDraft(item);
  const [local, setLocal] = useState<DraftState>(() => {
    const base = storage.readLocal<number>(localKey + ":base", item.revision);
    const saved = scriptDraftSchema.safeParse(
      storage.readLocal<unknown>(`${localKey}:v${base}`, null),
    );
    return saved.success && item.versions.some((v) => v.revision === base)
      ? { baseRevision: base, draft: saved.data }
      : { baseRevision: item.revision, draft: structuredClone(current) };
  });
  const [pane, setPane] = useState<
    "edit" | "candidates" | "reviews" | "history" | "checks"
  >("edit");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [noteAction, setNoteAction] = useState<
    "approve" | "request-changes" | "unlock" | null
  >(null);
  const [generation, setGeneration] = useState<
    ScriptGeneration["purpose"] | null
  >(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(item.revision);
  const [quote, setQuote] = useState("");
  const saving = useRef(false);
  const base = item.versions.find(
    (v) => v.revision === local.baseRevision,
  )!.draft;
  const dirty = JSON.stringify(base) !== JSON.stringify(local.draft);
  const stale = item.revision !== local.baseRevision;
  const editable = canWrite && item.status !== "locked";
  const reviewer = production.reviewerPrincipalIds.includes(boot.principalId);
  const workflow = {
    productionId: production.id,
    itemId: item.id,
    expectedRevision: item.revision,
    expectedWorkflowRevision: item.workflowRevision,
  };
  const candidates = production.candidates.filter(
    (c) => c.targetId === item.id,
  );
  const reviews = production.reviews.filter((r) => r.itemId === item.id);
  // Background refresh only advances a clean reader. It never rebases a dirty draft.
  useEffect(() => {
    if (stale && !dirty && !saving.current) {
      setLocal({
        baseRevision: item.revision,
        draft: structuredClone(current),
      });
      setNotice("");
    }
  }, [item.revision, stale, dirty]);
  function persist(next: DraftState) {
    setNotice("");
    setLocal(next);
    try {
      storage.writeLocal(`${localKey}:v${next.baseRevision}`, next.draft);
      storage.writeLocal(localKey + ":base", next.baseRevision);
    } catch {
      setError("本机草稿未能保存，请保留此窗口并复制正文；不要刷新。");
    }
  }
  function update(patch: Partial<ScriptDraft>) {
    persist({ ...local, draft: { ...local.draft, ...patch } });
  }
  async function action(work: () => Promise<unknown>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    if (!editable || saving.current) return;
    saving.current = true;
    try {
      await run({
        action: "revise-item",
        productionId: production.id,
        itemId: item.id,
        expectedRevision: local.baseRevision,
        draft: local.draft,
      });
      const snapshot = client.getSnapshot();
      const saved = snapshot?.workspace.scriptProductions
        .find((p) => p.id === production.id)
        ?.items.find((i) => i.id === item.id);
      if (
        snapshot?.centerId !== boot.centerId ||
        snapshot?.principalId !== boot.principalId ||
        !saved
      )
        throw new Error(
          "保存回执已返回，但未取得同身份的新文稿；原草稿保留，请刷新核对。",
        );
      persist({
        baseRevision: saved.revision,
        draft: structuredClone(currentScriptDraft(saved)),
      });
      setNotice(`已保存 v${saved.revision}`);
    } finally {
      saving.current = false;
    }
  }
  const pinned = (ids: string[]) => {
    const references = [...local.draft.dependencies];
    for (const id of ids)
      if (!references.some((r) => r.itemId === id)) {
        const dependency = production.items.find((i) => i.id === id)!;
        references.push({ itemId: id, revision: dependency.revision });
      }
    return references;
  };
  const draft = local.draft;
  return (
    <div className="script-editor">
      <header className="script-editor-header">
        <strong>
          {scriptKindLabels[item.kind]} · {current.title}
        </strong>
        <small role="status" className="script-edit-status">
          {scriptStatusLabels[item.status]} · v{item.revision}
          {dirty ? " · 本机未保存" : notice ? ` · ${notice}` : ""}
        </small>
        <button
          type="button"
          disabled={!editable || !dirty}
          onClick={() => void action(save)}
        >
          保存文稿
        </button>
      </header>
      {stale && dirty && (
        <p role="alert" className="script-warning">
          中心已有 v{item.revision}；此草稿仍基于 v{local.baseRevision}
          。保存将进行版本核对，不会覆盖新稿。请在历史中对照，复制需要的改动后再载入最新稿。
          <button
            type="button"
            onClick={() => {
              persist({
                baseRevision: item.revision,
                draft: structuredClone(current),
              });
              setNotice(
                `已载入最新稿；旧 v${local.baseRevision} 的本机草稿仍可恢复。`,
              );
            }}
          >
            保留旧草稿并载入最新稿
          </button>
        </p>
      )}
      {item.status === "locked" && (
        <p className="script-hint">
          锁稿正文只读。修改必须先由指定审阅人说明原因解锁。
        </p>
      )}
      {error && (
        <p className="script-error" role="alert">
          {error}
        </p>
      )}
      <div className="script-tabs" role="tablist" aria-label="剧本文稿视图">
        {(
          [
            ["edit", "正文"],
            [
              "candidates",
              `候选 ${candidates.filter((c) => c.status === "pending").length}`,
            ],
            [
              "reviews",
              `审阅 ${reviews.filter((r) => !r.resolvedAt && !r.historicalOnly).length}`,
            ],
            ["history", "历史"],
            ["checks", "检查与影响"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={pane === key}
            onClick={() => setPane(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {pane === "edit" && (
        <div className="script-edit-fields" role="tabpanel" aria-label="正文">
          <div className="script-edit-actions">
            {(
              [
                ["draft", "生成候选"],
                ["rewrite", "局部改写"],
                ["continuity", "连续性检查"],
                ["impact", "影响分析"],
              ] as const
            ).map(([purpose, label]) => (
              <button
                type="button"
                key={purpose}
                disabled={
                  !canWrite ||
                  dirty ||
                  stale ||
                  (item.status === "locked" &&
                    (purpose === "draft" || purpose === "rewrite"))
                }
                onClick={() => setGeneration(purpose)}
              >
                {label}
              </button>
            ))}
            <small>先保存；生成操作只准备输入，不会自动发送。</small>
          </div>
          <input
            aria-label="文稿标题"
            value={draft.title}
            disabled={!editable}
            maxLength={180}
            onChange={(e) => update({ title: e.target.value })}
          />
          <textarea
            className="script-text"
            aria-label="剧本正文"
            value={draft.text}
            readOnly={!editable}
            maxLength={100000}
            onChange={(e) => update({ text: e.target.value })}
            onSelect={(e) => {
              const t = e.currentTarget;
              setQuote(
                t.value.slice(t.selectionStart, t.selectionEnd).slice(0, 10000),
              );
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                void action(save);
              }
            }}
          />
          <details className="script-metadata">
            <summary>结构、来源与连续性信息</summary>
            <div className="script-form-grid">
              <label>
                目录次序
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={draft.order}
                  disabled={!editable}
                  onChange={(e) => update({ order: Number(e.target.value) })}
                />
              </label>
              <label>
                依据
                <select
                  value={draft.basis}
                  disabled={!editable}
                  onChange={(e) =>
                    update({ basis: e.target.value as ScriptDraft["basis"] })
                  }
                >
                  <option value="original">原创</option>
                  <option value="source">原作事实</option>
                  <option value="adaptation">改编设定</option>
                </select>
              </label>
              {item.kind === "scene" && (
                <label>
                  所属分集
                  <select
                    value={draft.parentId ?? ""}
                    disabled={!editable}
                    onChange={(e) => {
                      if (e.target.value)
                        update({
                          parentId: e.target.value,
                          dependencies: pinned([e.target.value]),
                        });
                    }}
                  >
                    <option value="" disabled>
                      请选择
                    </option>
                    {production.items
                      .filter((i) => i.kind === "episode")
                      .map((i) => (
                        <option key={i.id} value={i.id}>
                          {currentScriptDraft(i).title}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            {(
              [
                ["location", "地点", 500],
                ["storyTime", "故事时间", 1000],
                ["audienceKnowledge", "观众已知", 5000],
                ["characterKnowledge", "人物认知", 5000],
                ["setupPayoff", "伏笔与兑现", 5000],
                ["productionNotes", "制作说明", 5000],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key}>
                {label}
                <textarea
                  rows={2}
                  value={draft[key]}
                  disabled={!editable}
                  maxLength={max}
                  onChange={(e) => update({ [key]: e.target.value })}
                />
              </label>
            ))}
            <fieldset>
              <legend>出场角色（同步固定依赖版本）</legend>
              {production.items
                .filter((i) => i.kind === "character")
                .map((i) => (
                  <label key={i.id} className="script-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.characters.includes(i.id)}
                      disabled={!editable}
                      onChange={(e) =>
                        update({
                          characters: e.target.checked
                            ? [...draft.characters, i.id]
                            : draft.characters.filter((id) => id !== i.id),
                          dependencies: e.target.checked
                            ? pinned([i.id])
                            : draft.dependencies,
                        })
                      }
                    />
                    {currentScriptDraft(i).title}
                  </label>
                ))}
            </fieldset>
            <fieldset>
              <legend>版本依赖</legend>
              <small>更换版本是显式编辑，不会被后台更新自动替换。</small>
              {production.items
                .filter((i) => i.id !== item.id)
                .map((i) => {
                  const ref = draft.dependencies.find((d) => d.itemId === i.id);
                  const required =
                    draft.parentId === i.id || draft.characters.includes(i.id);
                  return (
                    <div key={i.id} className="script-dependency">
                      <label className="script-checkbox">
                        <input
                          type="checkbox"
                          checked={!!ref}
                          disabled={!editable || required}
                          onChange={(e) =>
                            update({
                              dependencies: e.target.checked
                                ? pinned([i.id])
                                : draft.dependencies.filter(
                                    (d) => d.itemId !== i.id,
                                  ),
                            })
                          }
                        />
                        {currentScriptDraft(i).title}
                      </label>
                      {ref && (
                        <select
                          aria-label={`${currentScriptDraft(i).title}依赖版本`}
                          disabled={!editable}
                          value={ref.revision}
                          onChange={(e) =>
                            update({
                              dependencies: draft.dependencies.map((d) =>
                                d.itemId === i.id
                                  ? { ...d, revision: Number(e.target.value) }
                                  : d,
                              ),
                            })
                          }
                        >
                          {i.versions.map((v) => (
                            <option key={v.revision} value={v.revision}>
                              v{v.revision}
                              {v.revision === i.revision ? " 当前" : " 历史"}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
            </fieldset>
            <fieldset>
              <legend>精确原作引用</legend>
              {draft.sources.map((s, n) => (
                <div key={n} className="script-source">
                  <small>
                    {boot.workspace.artifacts.find((a) => a.id === s.artifactId)
                      ?.title ?? s.artifactId}{" "}
                    · v{s.revision}
                  </small>
                  <blockquote>{s.quote || "整份版本引用"}</blockquote>
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() =>
                      update({
                        sources: draft.sources.filter((_, i) => i !== n),
                      })
                    }
                  >
                    移除此引用
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={!editable || draft.sources.length >= 100}
                onClick={() => setSourceOpen(true)}
              >
                引用项目原文
              </button>
              <small>
                外部原作请通过宿主附件或已授权目录处理；这里仅选择本项目已持久化的确切内容版本。
              </small>
            </fieldset>
          </details>
        </div>
      )}
      {pane === "candidates" && (
        <div role="tabpanel" aria-label="候选" className="script-candidates">
          {!candidates.length && (
            <p className="script-hint">
              尚无候选。先准备生成请求，再由你发送；模型结果不会自动改写正式稿。
            </p>
          )}
          {[...candidates].reverse().map((c) => {
            const before = item.versions.find(
              (v) => v.revision === c.baseRevision,
            )?.draft;
            const obsolete = scriptCandidateStale(production, c);
            return (
              <article key={c.id}>
                <header>
                  <strong>{c.draft.title}</strong>
                  <small>
                    基于 v{c.baseRevision} ·{" "}
                    {c.status === "pending"
                      ? "待决定"
                      : c.status === "accepted"
                        ? "已采纳"
                        : "已拒绝"}
                    {obsolete ? " · 引用已变化" : ""}
                  </small>
                </header>
                <p>{c.explanation}</p>
                <ScriptDiff before={before?.text ?? ""} after={c.draft.text} />
                {before && (
                  <details>
                    <summary>其他字段差异</summary>
                    {(Object.keys(c.draft) as (keyof ScriptDraft)[])
                      .filter(
                        (k) =>
                          k !== "text" &&
                          JSON.stringify(before[k]) !==
                            JSON.stringify(c.draft[k]),
                      )
                      .map((k) => (
                        <div key={k}>
                          <strong>{k}</strong>
                          <pre>{JSON.stringify(before[k], null, 2)}</pre>
                          <pre>{JSON.stringify(c.draft[k], null, 2)}</pre>
                        </div>
                      ))}
                  </details>
                )}
                {c.status === "pending" && (
                  <div className="script-edit-actions">
                    <button
                      type="button"
                      disabled={!editable || dirty || obsolete}
                      onClick={() =>
                        void action(() =>
                          run({
                            action: "decide-candidate",
                            productionId: production.id,
                            candidateId: c.id,
                            expectedRevision: c.revision,
                            decision: "accept",
                          }),
                        )
                      }
                    >
                      采纳为新版本
                    </button>
                    <button
                      type="button"
                      disabled={!canWrite}
                      onClick={() =>
                        void action(() =>
                          run({
                            action: "decide-candidate",
                            productionId: production.id,
                            candidateId: c.id,
                            expectedRevision: c.revision,
                            decision: "reject",
                          }),
                        )
                      }
                    >
                      拒绝候选
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {pane === "reviews" && (
        <div role="tabpanel" aria-label="审阅">
          <ReviewForm
            item={item}
            production={production}
            run={run}
            disabled={!canWrite || dirty || stale}
            quote={quote}
          />
          {reviews.map((r) => (
            <ReviewRow
              key={r.id}
              review={r}
              productionId={production.id}
              run={run}
              disabled={!canWrite}
            />
          ))}
        </div>
      )}
      {pane === "history" && (
        <div role="tabpanel" aria-label="历史" className="script-history">
          <label>
            查看版本
            <select
              value={historyRevision}
              onChange={(e) => setHistoryRevision(Number(e.target.value))}
            >
              {[...item.versions].reverse().map((v) => (
                <option key={v.revision} value={v.revision}>
                  v{v.revision} · {new Date(v.createdAt).toLocaleString()} ·{" "}
                  {v.author.actantId}
                </option>
              ))}
            </select>
          </label>
          <pre>
            {
              item.versions.find((v) => v.revision === historyRevision)?.draft
                .text
            }
          </pre>
          <button
            type="button"
            disabled={!editable || dirty || historyRevision === item.revision}
            onClick={() =>
              void action(() =>
                run({
                  action: "restore-item",
                  productionId: production.id,
                  itemId: item.id,
                  expectedRevision: item.revision,
                  restoreRevision: historyRevision,
                }),
              )
            }
          >
            将此历史稿恢复为新版本
          </button>
          <details>
            <summary>本窗口的未提交草稿</summary>
            {item.versions
              .filter(
                (v) =>
                  storage.readLocal(`${localKey}:v${v.revision}`, null) !==
                  null,
              )
              .map((v) => (
                <p key={v.revision}>
                  <button
                    type="button"
                    disabled={dirty}
                    onClick={() => {
                      const result = scriptDraftSchema.safeParse(
                        storage.readLocal(`${localKey}:v${v.revision}`, null),
                      );
                      if (result.success) {
                        persist({
                          baseRevision: v.revision,
                          draft: result.data,
                        });
                        setPane("edit");
                      }
                    }}
                  >
                    恢复基于 v{v.revision} 的本机草稿
                  </button>
                </p>
              ))}
          </details>
          <details>
            <summary>审阅与锁稿记录</summary>
            {[...item.events].reverse().map((event, n) => (
              <p key={n}>
                v{event.revision} · {event.action} · {event.author.actantId} ·{" "}
                {new Date(event.createdAt).toLocaleString()}
                <br />
                {event.note}
              </p>
            ))}
          </details>
        </div>
      )}
      {pane === "checks" && (
        <div role="tabpanel" aria-label="检查与影响">
          <p className="script-hint">
            以下是确定性结构检查；语义连续性仍需生成检查和人工审阅。
          </p>
          {scriptIssues(production)
            .filter((i) => i.itemId === item.id)
            .map((issue, n) => (
              <p key={n}>{issue.message}</p>
            ))}
          {!scriptIssues(production).some((i) => i.itemId === item.id) && (
            <p>当前未发现结构性问题。</p>
          )}
          <p>
            修改本条目将影响：
            {scriptImpact(production, [item.id])
              .map(
                (id) =>
                  currentScriptDraft(production.items.find((i) => i.id === id)!)
                    .title,
              )
              .join("、") || "尚无已登记下游"}
          </p>
        </div>
      )}
      <footer className="script-workflow">
        <button
          type="button"
          disabled={!editable || dirty || stale || item.status !== "draft"}
          onClick={() =>
            void action(() => run({ action: "submit-review", ...workflow }))
          }
        >
          提交审阅
        </button>
        {reviewer && (
          <>
            <button
              type="button"
              disabled={!canWrite || dirty || item.status !== "in-review"}
              onClick={() => setNoteAction("approve")}
            >
              批准此版本
            </button>
            <button
              type="button"
              disabled={!canWrite || dirty || item.status !== "in-review"}
              onClick={() => setNoteAction("request-changes")}
            >
              退回修改
            </button>
            <button
              type="button"
              disabled={!canWrite || dirty || item.status !== "approved"}
              onClick={() =>
                void action(() => run({ action: "lock-item", ...workflow }))
              }
            >
              锁稿
            </button>
            {item.status === "locked" && (
              <button
                type="button"
                disabled={!canWrite}
                onClick={() => setNoteAction("unlock")}
              >
                说明原因并解锁
              </button>
            )}
          </>
        )}
      </footer>
      {noteAction && (
        <NoteDialog
          title={
            noteAction === "approve"
              ? "批准此版本"
              : noteAction === "unlock"
                ? "说明原因并解锁"
                : "退回修改"
          }
          required={noteAction !== "approve"}
          onClose={() => setNoteAction(null)}
          onSubmit={async (note) => {
            if (noteAction === "unlock")
              await run({ action: "unlock-item", ...workflow, reason: note });
            else
              await run({
                action: "review-decision",
                ...workflow,
                decision: noteAction,
                note,
              });
            setNoteAction(null);
          }}
        />
      )}
      {generation && (
        <GenerationDialog
          production={production}
          item={item}
          purpose={generation}
          quote={quote}
          onClose={() => setGeneration(null)}
          onCompose={(text, request) => {
            onCompose(text, request);
            setGeneration(null);
          }}
        />
      )}
      {sourceOpen && (
        <SourceDialog
          client={client}
          projectId={production.projectId}
          onClose={() => setSourceOpen(false)}
          onSubmit={(source) => {
            update({ sources: [...draft.sources, source] });
            setSourceOpen(false);
          }}
        />
      )}
    </div>
  );
}
function ScriptDiff({ before, after }: { before: string; after: string }) {
  const left = before.split("\n"),
    right = after.split("\n");
  let prefix = 0,
    suffix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const show = (lines: string[], side: "before" | "after") => (
    <pre>
      {lines.map((line, n) => (
        <span
          key={n}
          className={
            n >= prefix && n < lines.length - suffix
              ? `script-diff-${side}`
              : ""
          }
        >
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
  return (
    <div className="script-diff">
      <section aria-label="修改前">
        <strong>修改前</strong>
        {show(left, "before")}
      </section>
      <section aria-label="候选稿">
        <strong>候选稿</strong>
        {show(right, "after")}
      </section>
    </div>
  );
}
function NoteDialog({
  title,
  required,
  onClose,
  onSubmit,
}: {
  title: string;
  required: boolean;
  onClose: () => void;
  onSubmit: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <StudioDialog title={title} onClose={onClose} compact>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(note);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          说明
          <textarea
            aria-label="决定说明"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={5000}
            required={required}
            rows={3}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="primary"
            type="submit"
            disabled={busy || (required && !note.trim())}
          >
            确认
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
function ReviewForm({
  item,
  production,
  run,
  disabled,
  quote: selected,
}: {
  item: ScriptItem;
  production: ScriptProduction;
  run: ScriptRun;
  disabled: boolean;
  quote: string;
}) {
  const [quote, setQuote] = useState(selected);
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<ScriptReview["severity"]>("note");
  const [error, setError] = useState("");
  return (
    <form
      className="script-review-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await run({
            action: "add-review",
            productionId: production.id,
            itemId: item.id,
            itemRevision: item.revision,
            quote,
            body,
            severity,
          });
          setBody("");
          setError("");
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <label>
        引用原文（v{item.revision}）
        <textarea
          aria-label="审阅引用"
          rows={2}
          value={quote}
          onChange={(e) => setQuote(e.target.value)}
          maxLength={10000}
          disabled={disabled}
        />
      </label>
      <label>
        审阅意见
        <textarea
          aria-label="审阅意见"
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          maxLength={10000}
          disabled={disabled}
        />
      </label>
      <div className="script-edit-actions">
        <select
          aria-label="意见级别"
          value={severity}
          disabled={disabled}
          onChange={(e) =>
            setSeverity(e.target.value as ScriptReview["severity"])
          }
        >
          <option value="note">建议</option>
          <option value="warning">警告</option>
          <option value="blocking">阻断</option>
        </select>
        <button type="submit" disabled={disabled || !body.trim()}>
          添加意见
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function ReviewRow({
  review,
  productionId,
  run,
  disabled,
}: {
  review: ScriptReview;
  productionId: string;
  run: ScriptRun;
  disabled: boolean;
}) {
  const [resolving, setResolving] = useState(false);
  return (
    <article className="script-review">
      <small>
        v{review.itemRevision}
        {review.contextRevision
          ? ` · 制作规范 v${review.contextRevision}`
          : ""}{" "}
        · {review.author.actantId} ·{" "}
        {{ note: "建议", warning: "警告", blocking: "阻断" }[review.severity]} ·{" "}
        {review.resolvedAt
          ? "已解决"
          : review.historicalOnly
            ? "历史留档"
            : "待处理"}
      </small>
      {review.historicalOnly ? (
        <p className="script-hint">历史意见，不阻断当前稿</p>
      ) : !review.resolvedAt && review.severity === "blocking" ? (
        <p className="script-warning">
          当前阻断意见，须记录解决方式后才能批准锁稿。
        </p>
      ) : null}
      <blockquote>{review.quote}</blockquote>
      <p>{review.body}</p>
      {review.resolvedAt ? (
        <p>处理：{review.resolution}</p>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setResolving(true)}
        >
          记录解决方式
        </button>
      )}
      {resolving && (
        <NoteDialog
          title="解决审阅意见"
          required
          onClose={() => setResolving(false)}
          onSubmit={async (resolution) => {
            await run({
              action: "resolve-review",
              productionId,
              reviewId: review.id,
              expectedRevision: review.revision,
              resolution,
            });
            setResolving(false);
          }}
        />
      )}
    </article>
  );
}
function GenerationDialog({
  production,
  item,
  purpose,
  quote,
  onClose,
  onCompose,
}: {
  production: ScriptProduction;
  item: ScriptItem;
  purpose: ScriptGeneration["purpose"];
  quote: string;
  onClose: () => void;
  onCompose: (text: string, request: ScriptGeneration) => void;
}) {
  // Freeze the whole request context at open. A later refresh must not retarget it.
  const [frozen] = useState(() => structuredClone({ production, item }));
  const [selected, setSelected] = useState<string[]>([]);
  const [characters, setCharacters] = useState(8000);
  const [count, setCount] = useState(1);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const p = frozen.production,
    target = frozen.item;
  const names = {
    draft: "生成候选",
    rewrite: "局部改写",
    continuity: "连续性检查",
    impact: "影响分析",
  };
  return (
    <StudioDialog title={`准备${names[purpose]}请求`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            if (!p.brief.modelProcessingAllowed)
              throw new Error(
                "请先由人工在项目规范中确认资料可以交给当前模型服务处理。",
              );
            const refs = new Map<string, number>();
            const visited = new Set<string>();
            const visit = (current: ScriptItem) => {
              if (visited.has(current.id)) return;
              visited.add(current.id);
              for (const ref of currentScriptDraft(current).dependencies) {
                const dependency = p.items.find((i) => i.id === ref.itemId);
                if (!dependency || dependency.revision !== ref.revision)
                  throw new Error("有上游引用已过期，请先明确更新依赖版本。");
                if (
                  refs.has(ref.itemId) &&
                  refs.get(ref.itemId) !== ref.revision
                )
                  throw new Error("依赖版本不一致。");
                refs.set(ref.itemId, ref.revision);
                visit(dependency);
              }
            };
            visit(target);
            for (const id of selected) {
              const ref = p.items.find((i) => i.id === id)!;
              refs.set(id, ref.revision);
              visit(ref);
            }
            refs.delete(target.id);
            if (refs.size > 200)
              throw new Error("本次资料超过 200 项，请缩小生成范围。");
            const references = [...refs].map(([itemId, revision]) => ({
              itemId,
              revision,
            }));
            const materials = [
              currentScriptDraft(target),
              ...references.map((r) =>
                currentScriptDraft(p.items.find((i) => i.id === r.itemId)!),
              ),
            ];
            if (JSON.stringify({ brief: p.brief, materials }).length > 120000)
              throw new Error("材料超过 120000 字符，请缩小范围。");
            onCompose(
              `请对《${p.title}》的「${currentScriptDraft(target).title}」v${target.revision}进行${names[purpose]}。${instruction ? "\n要求：" + instruction : ""}${quote ? "\n限定选区：\n" + quote : ""}\n使用已固定的剧本请求及资料版本，结果提交为候选或带引用的审阅意见，不覆盖正式稿，不代替人工批准。`,
              {
                productionId: p.id,
                targetId: target.id,
                baseRevision: target.revision,
                contextRevision: p.revision,
                purpose,
                references,
                maxCandidates: count,
                maxOutputCharacters: characters,
                maxReviewPasses: 1,
              },
            );
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <p>
          固定「{currentScriptDraft(target).title}」v{target.revision} ·
          项目规范 v{p.revision}；全部上游依赖自动纳入并核对版本。
        </p>
        <label>
          本次要求
          <textarea
            rows={3}
            maxLength={5000}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>
        {quote && <blockquote>{quote}</blockquote>}
        <details>
          <summary>补充材料（可选）</summary>
          {p.items
            .filter((i) => i.id !== target.id)
            .map((i) => (
              <label key={i.id} className="script-checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(i.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, i.id]
                        : selected.filter((id) => id !== i.id),
                    )
                  }
                />
                {currentScriptDraft(i).title} · v{i.revision}
              </label>
            ))}
        </details>
        <div className="script-form-grid">
          <label>
            最多候选数
            <input
              type="number"
              min={1}
              max={3}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </label>
          <label>
            可提交字符上限
            <input
              type="number"
              min={100}
              max={50000}
              value={characters}
              onChange={(e) => setCharacters(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="script-hint">
          材料上限 200 项 / 120000
          字符。候选与提交字数由领域校验；最多一次自审是流程指导，不是模型费用硬上限。尚不支持单次
          token / 金额硬限额。
        </p>
        {!p.brief.modelProcessingAllowed && (
          <p className="script-warning">尚未确认模型处理许可。</p>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="primary"
            type="submit"
            disabled={!p.brief.modelProcessingAllowed}
          >
            准备到输入框
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
function SourceDialog({
  client,
  projectId,
  onClose,
  onSubmit,
}: {
  client: WorkspaceClient;
  projectId: string;
  onClose: () => void;
  onSubmit: (reference: ScriptDraft["sources"][number]) => void;
}) {
  const artifacts = client.boot!.workspace.artifacts.filter(
    (a) =>
      a.projectId === projectId &&
      ["document", "pdf", "interactive"].includes(a.content.kind),
  );
  const [artifactId, setArtifactId] = useState("");
  const [revision, setRevision] = useState(1);
  const [quote, setQuote] = useState("");
  const [error, setError] = useState("");
  const artifact = artifacts.find((a) => a.id === artifactId);
  const version = artifact?.versions.find((v) => v.revision === revision);
  return (
    <StudioDialog title="引用项目原文" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !version ||
            (quote && !quotedText(version.content).includes(quote))
          ) {
            setError("引用必须来自这个确切版本的原文，请核对。");
            return;
          }
          onSubmit({ artifactId, revision, quote });
        }}
      >
        <label>
          原作对象
          <select
            value={artifactId}
            required
            onChange={(e) => {
              setArtifactId(e.target.value);
              setRevision(
                artifacts.find((a) => a.id === e.target.value)?.revision ?? 1,
              );
              setQuote("");
            }}
          >
            <option value="">请选择本项目内容</option>
            {artifacts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        {artifact && (
          <label>
            原作版本
            <select
              value={revision}
              onChange={(e) => {
                setRevision(Number(e.target.value));
                setQuote("");
              }}
            >
              {artifact.versions.map((v) => (
                <option key={v.revision} value={v.revision}>
                  v{v.revision}
                </option>
              ))}
            </select>
          </label>
        )}
        {version && (
          <pre className="script-source-preview">
            {quotedText(version.content)}
          </pre>
        )}
        <label>
          准确引文（留空引用整份版本）
          <textarea
            rows={3}
            maxLength={10000}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button className="primary" type="submit" disabled={!version}>
            添加引用
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
