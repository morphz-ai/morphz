import type { Locale } from "@/lib/docs";

const copy = {
  zh: {
    eyebrow: "认知上下文编码",
    title: "一个认知上下文，承载对话、目标与执行。",
    mode: "求值",
    rows: [
      ["认知帧", "保留、修订、退役与恢复都经过显式事务", "版本化"],
      ["目标 · 线程", "长期目标与因果工作线分别推进", "可持续"],
      ["执行节点", "任务路由到具备相应能力的节点", "有边界"],
    ],
    transaction: "上下文事务",
    transactionBody: "智能体提出认知变换，运行时校验版本、权限、因果与提交边界。",
    operations: "derive · revise · retire · restore",
  },
  en: {
    eyebrow: "CONTEXT ENCODING",
    title: "One Context carries dialogue, goals, and execution.",
    mode: "EVALUATE",
    rows: [
      ["SESSION WORKING SET", "Sessions swap in or out for this Evaluation", "FULL / META"],
      ["OBJECTIVE · THREAD", "Durable goals and causal work advance separately", "DURABLE"],
      ["EXECUTION TARGET", "Work routes to a node with the required capabilities", "SCOPED"],
    ],
    transaction: "Context Transaction",
    transactionBody: "The Agent proposes cognitive change; the Runtime validates version, authority, causality, and commit boundaries.",
    operations: "derive · revise · retire · restore",
  },
} as const;

export function ContextEvaluationField({ locale }: { locale: Locale }) {
  const t = copy[locale];

  return (
    <figure className="context-preview" aria-labelledby="context-preview-title">
      <figcaption>
        <span>{t.eyebrow}</span>
        <small>{t.mode}</small>
      </figcaption>
      <h2 id="context-preview-title" className="context-preview__title">{t.title}</h2>
      <div className="context-preview__expression">
        <svg
          className="context-preview__brackets"
          viewBox="0 0 1000 600"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`context-bracket-${locale}`} x1="0" y1="0" x2="0" y2="600" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" />
              <stop offset="0.28" stopColor="var(--accent)" stopOpacity="0.76" />
              <stop offset="0.72" stopColor="var(--accent)" stopOpacity="0.76" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0.18" />
            </linearGradient>
          </defs>
          <g className="context-preview__bracket-echo">
            <path d="M 78 62 C 35 158, 35 442, 78 538" />
            <path d="M 922 62 C 965 158, 965 442, 922 538" />
          </g>
          <g className="context-preview__bracket-main" fill={`url(#context-bracket-${locale})`}>
            <path d="M 58 42 C 8 144, 8 456, 58 558 C 63 560, 67 554, 62 546 C 30 448, 30 152, 62 54 C 67 46, 63 40, 58 42 Z" />
            <path d="M 942 42 C 992 144, 992 456, 942 558 C 937 560, 933 554, 938 546 C 970 448, 970 152, 938 54 C 933 46, 937 40, 942 42 Z" />
          </g>
        </svg>
        <div className="context-preview__body">
          <div className="context-preview__rows">
            {t.rows.map(([label, description, projection], index) => (
              <article key={label}>
                <span>0{index + 1}</span>
                <div><small>{label}</small><strong>{description}</strong></div>
                <i>{projection}</i>
              </article>
            ))}
          </div>
        </div>
      </div>
      <div className="context-preview__result">
        <div><span aria-hidden="true">tx</span><strong>{t.transaction}</strong></div>
        <p>{t.transactionBody}</p>
        <small>{t.operations}</small>
      </div>
    </figure>
  );
}
