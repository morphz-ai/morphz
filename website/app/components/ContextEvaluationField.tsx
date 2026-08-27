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
    <figure className="evaluation-field" aria-labelledby="evaluation-field-title">
      <figcaption className="evaluation-field__caption">
        <span id="evaluation-field-title">{t.title}</span>
        <span className="evaluation-field__status"><i aria-hidden="true" />{t.status}</span>
      </figcaption>
      <div className="evaluation-field__body">
        <div className="evaluation-stage evaluation-stage--input">
          <span className="evaluation-stage__index">01</span>
          <div>
            <p>{t.input}</p>
            <blockquote>{t.inputBody}</blockquote>
          </div>
        </div>
        <div className="evaluation-structure" aria-label={t.structure}>
          <span className="evaluation-structure__label">02 / {t.structure}</span>
          <span className="evaluation-node evaluation-node--frame">{t.frame}<small>f.12</small></span>
          <span className="evaluation-node evaluation-node--objective">{t.objective}<small>o.03</small></span>
          <span className="evaluation-node evaluation-node--recall">{t.recall}<small>r.27</small></span>
          <svg className="evaluation-structure__paths" viewBox="0 0 500 170" aria-hidden="true" preserveAspectRatio="none">
            <path d="M8 86 H108 C146 86 144 28 188 28 H270" />
            <path d="M108 86 H270" />
            <path d="M108 86 C146 86 144 144 188 144 H270" />
            <path className="evaluation-structure__pulse" d="M8 86 H108 C146 86 144 28 188 28 H270" />
          </svg>
        </div>
        <div className="evaluation-operator">
          <span>03 / {t.operator}</span>
          <code>
            <b>(</b>evaluate
            <br />
            &nbsp;&nbsp;<em>context</em>
            <br />
            &nbsp;&nbsp;<em>observation</em><b>)</b>
          </code>
        </div>
        <div className="evaluation-stage evaluation-stage--commit">
          <span className="evaluation-stage__index">04</span>
          <div>
            <p>{t.commit}</p>
            <strong>{t.commitBody}</strong>
          </div>
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
