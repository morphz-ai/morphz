import { useEffect, useRef, useState } from "react";
import { Check, CheckCheck, X } from "lucide-react";
import {
  scriptCandidateStale,
  type ScriptDraft,
  type ScriptItem,
  type ScriptProduction,
} from "../../../packages/core/src/script-studio.js";
import {
  scriptDisplayTime,
  scriptFieldLabels,
  scriptFieldValue,
} from "../../../packages/core/src/script-studio-presentation.js";
import type { ScriptLocation } from "../../../packages/core/src/script-delivery.js";
import type { ScriptRun } from "./ScriptStudio.js";

const statusLabels = {
  pending: "待决定",
  accepted: "已采纳",
  rejected: "已拒绝",
};

export function ScriptCandidates({
  production,
  item,
  canWrite,
  dirty,
  deliveryTarget,
  run,
  onShowBody,
}: {
  production: ScriptProduction;
  item: ScriptItem;
  canWrite: boolean;
  dirty: boolean;
  deliveryTarget?: ScriptLocation & { requestId: string };
  run: ScriptRun;
  onShowBody: () => void;
}) {
  const candidates = production.candidates.filter(
    (c) => c.targetId === item.id,
  );
  const [selected, setSelected] = useState(
    deliveryTarget?.candidateId ??
      candidates.findLast((c) => c.status === "pending")?.id ??
      candidates.at(-1)?.id ??
      "",
  );
  const [decision, setDecision] = useState<"accept" | "reject" | null>(null);
  const busy = decision !== null;
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (deliveryTarget?.candidateId) setSelected(deliveryTarget.candidateId);
  }, [deliveryTarget?.requestId]);
  const candidate =
    candidates.find((c) => c.id === selected) ??
    candidates.findLast((c) => c.status === "pending") ??
    candidates.at(-1);
  if (!candidate)
    return (
      <p className="script-hint">
        尚无候选。可以在对话中要求生成，或从正文页选择「生成候选」。
      </p>
    );
  const c = candidate;
  const ordinal = candidates.indexOf(c) + 1;
  const before = item.versions.find(
    (v) => v.revision === c.baseRevision,
  )?.draft;
  const obsolete = scriptCandidateStale(production, c);
  const blocked = !canWrite
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
      <nav className="script-candidate-list" aria-label="选择候选稿">
        {[...candidates].reverse().map((entry) => {
          const number = candidates.indexOf(entry) + 1;
          return (
            <button
              key={entry.id}
              type="button"
              disabled={busy}
              aria-current={entry.id === c.id ? "true" : undefined}
              aria-label={`候选 ${number} · ${statusLabels[entry.status]}`}
              onClick={() => {
                setSelected(entry.id);
                setError("");
              }}
            >
              <span>
                <strong>候选 {number}</strong>
                <span className="script-candidate-state">
                  {statusLabels[entry.status]}
                </span>
              </span>
              <small>
                {scriptDisplayTime(entry.createdAt)} ·{" "}
                {Array.from(entry.draft.text).length} 字
              </small>
            </button>
          );
        })}
      </nav>
      <article
        className="script-candidate-detail"
        key={c.id}
        data-script-result-id={c.id}
        data-delivery-target={deliveryTarget?.candidateId === c.id || undefined}
        aria-busy={busy}
      >
        <header className="script-candidate-heading">
          <div>
            <h3 ref={heading} tabIndex={-1}>
              候选 {ordinal}
              <span className="script-candidate-state">
                {statusLabels[c.status]}
              </span>
            </h3>
            <p className="script-hint">
              {c.status === "pending"
                ? `采纳后成为正文的新版本 · 基于 v${c.baseRevision}`
                : `基于正文 v${c.baseRevision}`}
            </p>
          </div>
          <div className="script-edit-actions">
            {c.status === "pending" ? (
              <>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={!canWrite || busy}
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
        {c.status === "pending" && blocked && (
          <p className="script-candidate-warning">{blocked}</p>
        )}
        <section className="script-candidate-body" aria-label="候选稿">
          <h4>{c.draft.title}</h4>
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
                      <pre>{scriptFieldValue(production, before, field)}</pre>
                    </section>
                    <section>
                      <strong>候选稿</strong>
                      <pre>{scriptFieldValue(production, c.draft, field)}</pre>
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
