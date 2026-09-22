import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ScriptLocation } from "../../../packages/core/src/script-delivery.js";
import {
  scriptAuthorName,
  scriptDisplayTime,
  scriptEventLabels,
  scriptEventNote,
} from "../../../packages/core/src/script-studio-presentation.js";
import {
  currentScriptDraft,
  prepareScriptGeneration,
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
import { scriptFocusReturn } from "./script-studio-focus.js";
import { ScriptCandidates } from "./ScriptCandidates.js";
import {
  StudioDialog,
  scriptStatusLabels,
  type ScriptRun,
  type ScriptComposeResult,
} from "./ScriptStudio.js";

type DraftState = { baseRevision: number; draft: ScriptDraft };
type GenerationDraft = {
  selected: string[];
  characters: number;
  count: number;
  instruction: string;
};
type Props = {
  client: WorkspaceClient;
  production: ScriptProduction;
  item: ScriptItem;
  deliveryTarget?: ScriptLocation & { requestId: string };
  canWrite: boolean;
  run: ScriptRun;
  onCompose: (
    text: string,
    generation?: ScriptGeneration,
  ) => ScriptComposeResult;
};
export function ScriptItemEditor({
  client,
  production,
  item,
  deliveryTarget,
  canWrite,
  run,
  onCompose,
}: Props) {
  const boot = client.boot!;
  const storage = scopedStorage(`${boot.centerId}:${boot.principalId}`);
  const localKey = draftKey(`script:${production.id}:${item.id}`);
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
  const [noteAction, setNoteAction] = useState<{
    action: "approve" | "request-changes" | "unlock";
    revision: number;
    workflowRevision: number;
  } | null>(null);
  const [generation, setGeneration] = useState<
    ScriptGeneration["purpose"] | null
  >(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [generationDrafts, setGenerationDrafts] = useState<
    Partial<Record<ScriptGeneration["purpose"], GenerationDraft>>
  >({});
  const tabId = useId();
  const metadata = useRef<HTMLDetailsElement>(null);
  const dependencies = useRef<HTMLFieldSetElement>(null);
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
  useEffect(() => {
    if (!deliveryTarget) return;
    if (deliveryTarget.candidateId) setPane("candidates");
    else if (deliveryTarget.reviewId) setPane("reviews");
    else if (
      deliveryTarget.revision &&
      (deliveryTarget.revision !== item.revision || dirty)
    ) {
      setHistoryRevision(deliveryTarget.revision);
      setPane("history");
    } else setPane("edit");
  }, [deliveryTarget?.requestId]);
  useEffect(() => {
    const id = deliveryTarget?.candidateId ?? deliveryTarget?.reviewId;
    if (!id) return;
    const element = Array.from(
      document.querySelectorAll<HTMLElement>("[data-script-result-id]"),
    ).find((el) => el.dataset.scriptResultId === id);
    element?.scrollIntoView({ block: "nearest" });
  }, [deliveryTarget?.requestId, pane]);
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
        <strong tabIndex={-1} data-script-focus-anchor>
          {scriptKindLabels[item.kind]} · {current.title}
        </strong>
        <small role="status" className="script-edit-status">
          {pane === "candidates" ? "正文 · " : ""}
          {scriptStatusLabels[item.status]} · v{item.revision}
          {dirty ? " · 本机未保存" : notice ? ` · ${notice}` : ""}
        </small>
        {pane === "edit" && (
          <button
            type="button"
            disabled={!editable || !dirty}
            onClick={() => void action(save)}
          >
            保存文稿
          </button>
        )}
      </header>
      {error && (
        <div className="script-error script-editor-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={(event) => {
              event.currentTarget
                .closest(".script-editor")
                ?.querySelector<HTMLElement>("[data-script-focus-anchor]")
                ?.focus({ preventScroll: true });
              setError("");
            }}
          >
            关闭
          </button>
        </div>
      )}
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
            id={`${tabId}-${key}`}
            aria-controls={`${tabId}-${key}-panel`}
            tabIndex={pane === key ? 0 : -1}
            aria-selected={pane === key}
            onClick={() => {
              setError("");
              setPane(key);
            }}
            onKeyDown={(event) => {
              const tabs = Array.from(
                event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              );
              const index = tabs.indexOf(event.currentTarget);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              tabs[next]!.click();
              tabs[next]!.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {pane === "edit" && (
        <div
          id={`${tabId}-edit-panel`}
          aria-labelledby={`${tabId}-edit`}
          className="script-edit-fields"
          role="tabpanel"
        >
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
          <details ref={metadata} className="script-metadata">
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
                    aria-label="所属分集"
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
            <fieldset ref={dependencies} tabIndex={-1}>
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
                          data-dependency-id={i.id}
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
        <div
          id={`${tabId}-candidates-panel`}
          aria-labelledby={`${tabId}-candidates`}
          role="tabpanel"
          className="script-candidates"
        >
          <ScriptCandidates
            production={production}
            item={item}
            canWrite={canWrite}
            dirty={dirty}
            deliveryTarget={deliveryTarget}
            run={run}
            onShowBody={() => setPane("edit")}
          />
        </div>
      )}
      {pane === "reviews" && (
        <div
          id={`${tabId}-reviews-panel`}
          aria-labelledby={`${tabId}-reviews`}
          role="tabpanel"
        >
          <ReviewForm
            item={item}
            production={production}
            run={run}
            disabled={!canWrite || dirty || stale}
            quote={quote}
          />
          {reviews.map((r) => (
            <div
              key={r.id}
              data-script-result-id={r.id}
              data-delivery-target={
                deliveryTarget?.reviewId === r.id || undefined
              }
            >
              <ReviewRow
                key={r.id}
                review={r}
                productionId={production.id}
                run={run}
                disabled={!canWrite}
                authorName={scriptAuthorName(r.author, boot.workspace.actants)}
              />
            </div>
          ))}
        </div>
      )}
      {pane === "history" && (
        <div
          id={`${tabId}-history-panel`}
          aria-labelledby={`${tabId}-history`}
          role="tabpanel"
          className="script-history"
        >
          <label>
            查看版本
            <select
              value={historyRevision}
              onChange={(e) => setHistoryRevision(Number(e.target.value))}
            >
              {[...item.versions].reverse().map((v) => (
                <option key={v.revision} value={v.revision}>
                  v{v.revision} · {scriptDisplayTime(v.createdAt)} ·{" "}
                  {scriptAuthorName(v.author, boot.workspace.actants)}
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
              <div key={n}>
                <p>
                  v{event.revision} · {scriptEventLabels[event.action]} ·{" "}
                  {scriptAuthorName(event.author, boot.workspace.actants)} ·{" "}
                  {scriptDisplayTime(event.createdAt)}
                  <br />
                  {scriptEventNote(production, event)}
                </p>
                <details>
                  <summary>追溯信息</summary>
                  <small>
                    {event.author.actantId} · {event.author.principalId}
                  </small>
                  <p>{event.note}</p>
                </details>
              </div>
            ))}
          </details>
        </div>
      )}
      {pane === "checks" && (
        <div
          id={`${tabId}-checks-panel`}
          aria-labelledby={`${tabId}-checks`}
          role="tabpanel"
        >
          <p className="script-hint">
            以下是确定性结构检查；语义连续性仍需生成检查和人工审阅。
          </p>
          {scriptIssues(production)
            .filter((i) => i.itemId === item.id)
            .map((issue, n) => (
              <div key={n} className="script-issue">
                <p>{issue.message}</p>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => {
                    if (issue.code === "unresolved-review") {
                      flushSync(() => setPane("reviews"));
                      document.getElementById(`${tabId}-reviews`)?.focus();
                    } else {
                      flushSync(() => setPane("edit"));
                      if (metadata.current) metadata.current.open = true;
                      const control =
                        issue.code === "missing-parent"
                          ? metadata.current?.querySelector<HTMLSelectElement>(
                              'select[aria-label="所属分集"]',
                            )
                          : Array.from(
                              dependencies.current?.querySelectorAll<HTMLSelectElement>(
                                "select[data-dependency-id]",
                              ) ?? [],
                            ).find(
                              (select) =>
                                select.dataset.dependencyId ===
                                  issue.relatedId && !select.disabled,
                            );
                      (control ?? dependencies.current)?.focus();
                      (control ?? dependencies.current)?.scrollIntoView({
                        block: "center",
                      });
                    }
                  }}
                >
                  {issue.code === "unresolved-review"
                    ? "处理意见"
                    : editable
                      ? "查看并更新引用"
                      : "查看引用"}
                </button>
              </div>
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
      {pane !== "candidates" && (
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
                onClick={() =>
                  setNoteAction({
                    action: "approve",
                    revision: item.revision,
                    workflowRevision: item.workflowRevision,
                  })
                }
              >
                批准此版本
              </button>
              <button
                type="button"
                disabled={!canWrite || dirty || item.status !== "in-review"}
                onClick={() =>
                  setNoteAction({
                    action: "request-changes",
                    revision: item.revision,
                    workflowRevision: item.workflowRevision,
                  })
                }
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
                  onClick={() =>
                    setNoteAction({
                      action: "unlock",
                      revision: item.revision,
                      workflowRevision: item.workflowRevision,
                    })
                  }
                >
                  说明原因并解锁
                </button>
              )}
            </>
          )}
        </footer>
      )}
      {noteAction && (
        <NoteDialog
          title={
            noteAction.action === "approve"
              ? "批准此版本"
              : noteAction.action === "unlock"
                ? "说明原因并解锁"
                : "退回修改"
          }
          required={noteAction.action !== "approve"}
          context={`本次决定：v${noteAction.revision}`}
          blocked={
            noteAction.revision !== item.revision ||
            noteAction.workflowRevision !== item.workflowRevision
              ? "正文或审阅状态已变化，请关闭后重新核对；本次决定不会应用到新版本。"
              : undefined
          }
          onClose={() => setNoteAction(null)}
          onSubmit={async (note) => {
            const pinnedWorkflow = {
              ...workflow,
              expectedRevision: noteAction.revision,
              expectedWorkflowRevision: noteAction.workflowRevision,
            };
            if (noteAction.action === "unlock")
              await run({
                action: "unlock-item",
                ...pinnedWorkflow,
                reason: note,
              });
            else
              await run({
                action: "review-decision",
                ...pinnedWorkflow,
                decision: noteAction.action,
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
          value={
            generationDrafts[generation] ?? {
              selected: [],
              characters: 8000,
              count: 1,
              instruction: "",
            }
          }
          onChange={(value) =>
            setGenerationDrafts((previous) => ({
              ...previous,
              [generation]: value,
            }))
          }
          quote={quote}
          onClose={() => setGeneration(null)}
          onCompose={(text, request) => {
            const result = onCompose(text, request);
            if (result.ok) {
              setGenerationDrafts((previous) => ({
                ...previous,
                [generation]: undefined,
              }));
              setGeneration(null);
            }
            return result;
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
function NoteDialog({
  title,
  required,
  onClose,
  onSubmit,
  context,
  blocked,
}: {
  title: string;
  required: boolean;
  onClose: () => void;
  onSubmit: (note: string) => Promise<void>;
  context?: string;
  blocked?: string;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <StudioDialog title={title} onClose={onClose} compact>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || blocked) return;
          const form = e.currentTarget;
          const restoreFocus = scriptFocusReturn(
            form,
            ((e.nativeEvent as SubmitEvent).submitter as HTMLElement | null) ??
              (document.activeElement as HTMLElement | null),
          );
          setBusy(true);
          setError("");
          try {
            await onSubmit(note);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            // The modal owns this busy state, not the parent command. Wait for
            // its control to be enabled before returning focus after failure.
            if (form.isConnected) flushSync(() => setBusy(false));
            restoreFocus();
          }
        }}
      >
        {context && <p className="script-hint">{context}</p>}
        {blocked && <p role="alert">{blocked}</p>}
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
            disabled={busy || !!blocked || (required && !note.trim())}
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
  authorName,
}: {
  review: ScriptReview;
  productionId: string;
  run: ScriptRun;
  disabled: boolean;
  authorName: string;
}) {
  const [resolving, setResolving] = useState(false);
  return (
    <article className="script-review">
      <small>
        v{review.itemRevision}
        {review.contextRevision
          ? ` · 制作规范 v${review.contextRevision}`
          : ""}{" "}
        · {authorName} ·{" "}
        {{ note: "建议", warning: "警告", blocking: "阻断" }[review.severity]} ·{" "}
        {review.resolvedAt
          ? "已解决"
          : review.historicalOnly
            ? "历史留档"
            : "待处理"}
      </small>
      <details>
        <summary>追溯信息</summary>
        <small>
          {review.author.actantId} · {review.author.principalId}
        </small>
      </details>
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
  value,
  onChange,
}: {
  production: ScriptProduction;
  item: ScriptItem;
  purpose: ScriptGeneration["purpose"];
  quote: string;
  onClose: () => void;
  onCompose: (text: string, request: ScriptGeneration) => ScriptComposeResult;
  value: GenerationDraft;
  onChange: (value: GenerationDraft) => void;
}) {
  // Freeze the whole request context at open. A later refresh must not retarget it.
  const [frozen] = useState(() => structuredClone({ production, item }));
  const { selected, characters, count, instruction } = value;
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
                "请先由人工在剧本设置中确认资料可以交给当前模型服务处理。",
              );
            const generation = prepareScriptGeneration(p, {
              productionId: p.id,
              targetId: target.id,
              baseRevision: target.revision,
              contextRevision: p.revision,
              purpose,
              references: selected.map((itemId) => ({
                itemId,
                revision: p.items.find((i) => i.id === itemId)!.revision,
              })),
              maxCandidates: count,
              maxOutputCharacters: characters,
              maxReviewPasses: 1,
            });
            const materials = [
              currentScriptDraft(target),
              ...generation.references.map((r) =>
                currentScriptDraft(p.items.find((i) => i.id === r.itemId)!),
              ),
            ];
            if (JSON.stringify({ brief: p.brief, materials }).length > 120000)
              throw new Error("材料超过 120000 字符，请缩小范围。");
            const result = onCompose(
              `请对《${p.title}》的「${currentScriptDraft(target).title}」v${target.revision}进行${names[purpose]}。${instruction ? "\n要求：" + instruction : ""}${quote ? "\n限定选区：\n" + quote : ""}\n使用已固定的剧本请求及资料版本，结果提交为候选或带引用的审阅意见，不覆盖正式稿，不代替人工批准。`,
              generation,
            );
            if (!result.ok) setError(result.error);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <p>
          固定「{currentScriptDraft(target).title}」v{target.revision} ·
          剧本规范 v{p.revision}；全部上游依赖自动纳入并核对版本。
        </p>
        <label>
          本次要求
          <textarea
            aria-label="本次要求"
            rows={3}
            maxLength={5000}
            value={instruction}
            onChange={(e) =>
              onChange({ ...value, instruction: e.target.value })
            }
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
                    onChange({
                      ...value,
                      selected: e.target.checked
                        ? [...selected, i.id]
                        : selected.filter((id) => id !== i.id),
                    })
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
              onChange={(e) =>
                onChange({ ...value, count: Number(e.target.value) })
              }
            />
          </label>
          <label>
            可提交字符上限
            <input
              type="number"
              min={100}
              max={50000}
              value={characters}
              onChange={(e) =>
                onChange({ ...value, characters: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <p className="script-hint">
          材料上限 200 项 / 120000
          字符；候选与提交字数受校验，最多执行一轮语义自审。不自动批准，暂不支持单次费用硬限额。
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
