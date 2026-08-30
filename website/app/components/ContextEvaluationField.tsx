import type { Locale } from "@/lib/docs";

const copy = {
  zh: {
    title: "一次上下文求值",
    status: "运行时已提交",
    input: "会话输入",
    inputBody: "继续昨天没有完成的发布准备。",
    structure: "结构选择",
    frame: "认知帧",
    objective: "目标",
    recall: "召回",
    operator: "模型求值",
    commit: "持久状态",
    commitBody: "修订后的认知与下一步行动被事务性提交。",
    continuity: "同一认知上下文 · 新会话可继续",
  },
  en: {
    title: "One context evaluation",
    status: "runtime committed",
    input: "Session input",
    inputBody: "Continue the release work left unfinished yesterday.",
    structure: "Structure selected",
    frame: "Frame",
    objective: "Objective",
    recall: "Recall",
    operator: "Model evaluation",
    commit: "Durable state",
    commitBody: "Revised cognition and the next action are committed transactionally.",
    continuity: "same Context · another Session can continue",
  },
} as const;

export function ContextEvaluationField({ locale }: { locale: Locale }) {
  const t = copy[locale];
  return (
    <figure className="evaluation-field evaluation-field--kinetic" aria-labelledby="evaluation-field-title">
      <figcaption className="evaluation-field__caption">
        <span id="evaluation-field-title">{t.title}</span>
        <span className="evaluation-field__status"><i aria-hidden="true" />{t.status}</span>
      </figcaption>
      <div className="evaluation-field__kinetic-body">
        <div className="evaluation-field__source">
          <span>01 · {t.input}</span>
          <p>{t.inputBody}</p>
        </div>
        <div className="evaluation-field__expression" aria-label={t.operator}>
          <div className="evaluation-field__expression-meta">
            <span>02 · {t.structure}</span>
            <span>03 · {t.operator}</span>
          </div>
          <pre aria-label="S-expression context evaluation"><code>
            <span className="sexpr-row sexpr-row--root"><b>(</b><strong>evaluate</strong></span>
            <span className="sexpr-row sexpr-row--depth-1"><b>(</b><em>context</em></span>
            <span className="sexpr-row sexpr-row--depth-2"><b>(</b><span>frame</span><i>f.12</i><b>)</b></span>
            <span className="sexpr-row sexpr-row--depth-2"><b>(</b><span>objective</span><i>o.03</i><b>)</b></span>
            <span className="sexpr-row sexpr-row--depth-2"><b>(</b><span>recall</span><i>r.27</i><b>))</b></span>
            <span className="sexpr-row sexpr-row--depth-1"><b>(</b><em>observation</em><i>evt.84</i><b>))</b></span>
          </code></pre>
          <div className="evaluation-field__expression-progress" aria-hidden="true"><i /></div>
        </div>
        <div className="evaluation-field__commit">
          <span>04 · {t.commit}</span>
          <p>{t.commitBody}</p>
        </div>
      </div>
      <div className="evaluation-field__continuity">
        <span aria-hidden="true">context[t]</span>
        <i aria-hidden="true" />
        <strong>{t.continuity}</strong>
        <i aria-hidden="true" />
        <span aria-hidden="true">context[t+1]</span>
      </div>
    </figure>
  );
}
