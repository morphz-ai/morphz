import { useEffect, useRef, useState } from "react";
import { Check, CheckCheck, X } from "lucide-react";
import { quoteSource } from "./text-quote-dom.js";
import { type ScriptDraft } from "../../../packages/core/src/script-studio.js";
import {
  scriptDisplayTime,
  scriptFieldLabels,
  scriptFieldValue,
} from "../../../packages/core/src/script-studio-presentation.js";
import type { ScriptLocation } from "../../../packages/core/src/script-delivery.js";
import type { ScriptRun } from "./ScriptStudio.js";
import type { ScriptDirectoryItem } from "../../../packages/core/src/script-editor.js";
import type { ScriptEditorProduction } from "./script-editor-reader.js";
import type { WorkspaceClient } from "./client.js";
import { useScriptEditorRead } from "./useScriptEditorRead.js";

const statusLabels = {
  pending: "待决定",
  accepted: "已采纳",
  rejected: "已拒绝",
};

export function ScriptCandidates({
  client,
  production,
  item,
  canWrite,
  dirty,
  deliveryTarget,
  run,
  onShowBody,
}: {
  client: WorkspaceClient;
  production: ScriptEditorProduction;
  item: ScriptDirectoryItem;
  canWrite: boolean;
  dirty: boolean;
  deliveryTarget?: ScriptLocation & { requestId: string };
  run: ScriptRun;
  onShowBody: () => void;
}) {
  const page = useScriptEditorRead(
    `candidates:${client.boot!.csrfToken}:${production.id}:${item.id}`,
    production.activityRevision,
    () => client.readScriptEditorPage(production, "candidates", item.id),
  );
  const candidates = page.value?.candidates ?? [];
  const [selected, setSelected] = useState(deliveryTarget?.candidateId ?? "");
  const [decision, setDecision] = useState<"accept" | "reject" | null>(null);
  const busy = decision !== null;
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const candidateList = useRef<HTMLElement>(null);
  useEffect(() => {
    if (deliveryTarget?.candidateId) setSelected(deliveryTarget.candidateId);
  }, [deliveryTarget?.requestId]);
  const summary =
    candidates.find((c) => c.id === selected) ??
    candidates.find((c) => c.id === page.value?.defaultCandidateId) ??
    candidates[0];
  const detail = useScriptEditorRead(
    `candidate:${client.boot!.csrfToken}:${production.id}:${summary?.id ?? ""}`,
    production.activityRevision,
    async () => {
      const candidate = await client.readScriptCandidate(
        production,
        summary!.id,
      );
      const before = await client.readScriptVersion(
        production,
        item.id,
        candidate.baseRevision,
      );
      const titles = new Map<string, string>();
      for (const draft of [candidate.draft, before.draft])
        for (const ref of draft.dependencies) {
          const key = `${ref.itemId}:${ref.revision}`;
          if (!titles.has(key))
            titles.set(
              key,
              (
                await client.readScriptVersion(
                  production,
                  ref.itemId,
                  ref.revision,
                )
              ).draft.title,
            );
        }
      return { candidate, before: before.draft, titles };
    },
    !!summary,
  );
  const candidate = detail.value?.candidate;
  useEffect(() => {
    const list = candidateList.current;
    const selected = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !selected) return;
    // Scroll the switcher only; never move the user's reading viewport.
    const bounds = list.getBoundingClientRect(),
      target = selected.getBoundingClientRect();
    if (target.left < bounds.left) list.scrollLeft -= bounds.left - target.left;
    else if (target.right > bounds.right)
      list.scrollLeft += target.right - bounds.right;
  }, [candidate?.id]);
  if (!candidate)
    return (
      <p
        className="script-hint"
        role={page.error || detail.error ? "alert" : undefined}
      >
        {page.error ||
          detail.error ||
          (page.pending || detail.pending
            ? "正在读取候选…"
            : "尚无候选。可以在对话中要求生成，或从正文页选择「生成候选」。")}
      </p>
    );
  const c = candidate;
  const ordinal = c.ordinal;
  const adoptedVersion = c.acceptedRevision
    ? { revision: c.acceptedRevision }
    : null;
  const before = detail.value?.before;
  const obsolete = c.stale;
  const displayStatus = (entry: {
    status: keyof typeof statusLabels;
    stale: boolean;
  }) =>
    entry.status === "pending" && entry.stale
      ? "旧稿"
      : statusLabels[entry.status];
  const blocked =
    !detail.fresh || !page.fresh
      ? "正在核对候选版本…"
      : !canWrite
        ? "你没有修改权限。"
        : item.status === "locked"
          ? "正文已锁稿，请先解锁再采纳。"
          : dirty
            ? "正文有未保存的修改，请先保存或处理草稿。"
            : obsolete
              ? "正文或引用已变化，这份候选不能直接采纳；请根据最新内容重新生成。"
              : "";
  const fields = before
    ? (Object.keys(c.draft) as (keyof ScriptDraft)[]).filter(
        (k) =>
          k !== "text" &&
          JSON.stringify(before[k]) !== JSON.stringify(c.draft[k]),
      )
    : [];
  async function decide(decision: "accept" | "reject") {
    if (submitting.current) return;
    submitting.current = true;
    setSelected(c.id);
    setDecision(decision);
    setError("");
    try {
      await run({
        action: "decide-candidate",
        productionId: production.id,
        candidateId: c.id,
        expectedRevision: c.revision,
        decision,
      });
      heading.current?.focus({ preventScroll: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setDecision(null);
    }
  }
  return (
    <div className="script-candidate-browser">
      {candidates.length > 1 && (
        <nav
          ref={candidateList}
          className="script-candidate-list"
          aria-label="选择候选稿"
        >
          {candidates.map((entry) => {
            const number = entry.ordinal;
            return (
              <button
                key={entry.id}
                type="button"
                disabled={busy}
                aria-current={entry.id === c.id ? "true" : undefined}
                aria-label={`候选 ${number} · ${displayStatus(entry)}`}
                title={`${number === page.value?.total ? "最新生成 · " : ""}${scriptDisplayTime(entry.createdAt)} · ${entry.textCharacters} 字`}
                onClick={() => {
                  setSelected(entry.id);
                  setError("");
                }}
              >
                <strong>候选 {number}</strong>
                <span className="script-candidate-state">
                  {displayStatus(entry)}
                </span>
                {number === page.value?.total && (
                  <small className="script-candidate-latest">最新</small>
                )}
              </button>
            );
          })}
        </nav>
      )}
      <article
        className="script-candidate-detail"
        {...quoteSource({
          kind: "script",
          projectId: production.projectId,
          title: `${production.title} · ${c.draft.title} · 候选 ${ordinal}`,
          productionId: production.id,
          entryId: item.id,
          revision: c.baseRevision,
          candidateId: c.id,
        })}
        key={c.id}
        data-script-result-id={c.id}
        data-delivery-target={deliveryTarget?.candidateId === c.id || undefined}
        aria-busy={busy}
      >
        <header className="script-candidate-heading">
          <div>
            <h3 ref={heading} tabIndex={-1}>
              候选 {ordinal}
              <span className="script-candidate-state">{displayStatus(c)}</span>
            </h3>
            <p className="script-hint">
              {scriptDisplayTime(c.createdAt)} ·{" "}
              {Array.from(c.draft.text).length} 字 · 基于正文 v{c.baseRevision}
            </p>
          </div>
          <div className="script-edit-actions">
            {c.status === "pending" ? (
              <>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={!canWrite || busy || !detail.fresh || !page.fresh}
                  onClick={() => void decide("reject")}
                >
                  <X />
                  {decision === "reject" ? "拒绝中…" : "拒绝候选"}
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={!!blocked || busy}
                  title={blocked || undefined}
                  onClick={() => void decide("accept")}
                >
                  <Check />
                  {decision === "accept" ? "采纳中…" : "采纳为新版本"}
                </button>
              </>
            ) : (
              <button
                className="secondary-action"
                type="button"
                onClick={onShowBody}
              >
                <CheckCheck />
                查看正文
              </button>
            )}
          </div>
        </header>
        {error && <p role="alert">{error}</p>}
        {c.status === "accepted" && adoptedVersion && (
          <p className="script-candidate-notice" role="status">
            {adoptedVersion.revision === item.revision
              ? `已保存为正文 v${adoptedVersion.revision}，可以继续编辑；其他旧稿保留供参考。`
              : `曾采纳为正文 v${adoptedVersion.revision}；当前正文已是 v${item.revision}。`}
          </p>
        )}
        {c.status === "pending" && blocked && (
          <p className="script-candidate-warning">{blocked}</p>
        )}
        <section className="script-candidate-body" aria-label="候选稿">
          {c.draft.title !== item.title && <h4>{c.draft.title}</h4>}
          <pre>{c.draft.text || "（此候选没有正文修改）"}</pre>
        </section>
        <div className="script-candidate-inspection">
          <details>
            <summary>与原版本对比</summary>
            {before ? (
              <ScriptDiff before={before.text} after={c.draft.text} />
            ) : (
              <p>原版本不可用，无法对比。</p>
            )}
          </details>
          {fields.length > 0 && before && (
            <details>
              <summary>其他字段差异 · {fields.length}</summary>
              {fields.map((field) => (
                <section key={field}>
                  <h4>{scriptFieldLabels[field]}</h4>
                  <div className="script-diff">
                    <section>
                      <strong>原版本</strong>
                      <pre>
                        {scriptFieldValue(
                          (id, revision) =>
                            detail.value?.titles.get(`${id}:${revision}`),
                          before,
                          field,
                        )}
                      </pre>
                    </section>
                    <section>
                      <strong>候选稿</strong>
                      <pre>
                        {scriptFieldValue(
                          (id, revision) =>
                            detail.value?.titles.get(`${id}:${revision}`),
                          c.draft,
                          field,
                        )}
                      </pre>
                    </section>
                  </div>
                  {(
                    [
                      "sources",
                      "dependencies",
                      "characters",
                      "parentId",
                    ] as string[]
                  ).includes(field) && (
                    <details>
                      <summary>追溯信息</summary>
                      <pre>{JSON.stringify(before[field], null, 2)}</pre>
                      <pre>{JSON.stringify(c.draft[field], null, 2)}</pre>
                    </details>
                  )}
                </section>
              ))}
            </details>
          )}
          {c.explanation && (
            <details>
              <summary>创作说明与自审记录</summary>
              <p className="script-candidate-explanation">{c.explanation}</p>
            </details>
          )}
        </div>
      </article>
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
        <strong>原版本</strong>
        {before ? (
          show(left, "before")
        ) : (
          <p className="script-hint">原版本暂无正文</p>
        )}
      </section>
      <section aria-label="对比候选稿">
        <strong>候选稿</strong>
        {show(right, "after")}
      </section>
    </div>
  );
}
