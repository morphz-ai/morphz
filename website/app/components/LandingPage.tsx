import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const content = {
  zh: {
    eyebrow: "AGENT RUNTIME · 当前处于活跃开发阶段",
    title: "让 Agent 拥有\n可持续的认知",
    lead: "Morphz 把上下文、调度、权限与执行变成可验证的 Runtime 状态，让模型可以长期工作，而不必把可靠性寄托在一次 Prompt 里。",
    primary: "阅读文档",
    secondary: "查看 GitHub",
    commandLabel: "从第一次配置开始",
    principlesTitle: "不是聊天外壳，而是认知与执行底座",
    principlesLead: "模型可以变化，任务可以跨越多轮，进程也可能重启。Morphz 把必须可靠的部分留在 Runtime。",
    principles: [
      ["Context-owned cognition", "Context 持有跨会话认知、认知帧与可召回账本；Session 是沟通通道，不是记忆容器。"],
      ["Recoverable execution", "Thread、Activation 与 Objective 把执行生命周期显式化，使暂停、恢复、委派和失败处理可审计。"],
      ["Provider-independent access", "Provider、认证账号、物理模型与模型路由彼此分离，不让 Runtime 绑定某一家模型厂商。"],
    ],
    flowTitle: "一条清晰的开始路径",
    flow: [
      ["01", "配置", "用 Dashboard 向导或终端向导接入一个模型服务。"],
      ["02", "对话", "创建 Context 与 Session，完成第一次真实模型响应。"],
      ["03", "执行", "让 Agent 在明确的工作区、权限和执行目标内完成任务。"],
      ["04", "持续", "通过认知帧、Recall、Objective 与调度器推进长期工作。"],
    ],
    docsTitle: "文档是产品契约",
    docsLead: "公开文档只描述当前可以验证的行为。设计提案、研究和历史实现保留在仓库中，但不会伪装成已经交付的功能。",
    docsCards: [
      ["快速开始", "从构建、Setup 到第一次响应。", "getting-started"],
      ["核心概念", "理解 Context、Session、认知帧与执行生命周期。", "core-concepts"],
      ["模型服务", "配置 Provider、账号、模型与路由。", "providers-and-models"],
      ["运维排障", "诊断模型、日志、任务和存储问题。", "operations"],
    ],
  },
  en: {
    eyebrow: "AGENT RUNTIME · ACTIVELY DEVELOPED",
    title: "Durable cognition\nfor agents",
    lead: "Morphz turns context, scheduling, permissions, and execution into verifiable runtime state, so long-running work does not depend on one perfect prompt.",
    primary: "Read the docs",
    secondary: "View on GitHub",
    commandLabel: "Start with guided setup",
    principlesTitle: "A cognition and execution runtime, not a chat wrapper",
    principlesLead: "Models change, work spans many turns, and processes restart. Morphz keeps the parts that must remain reliable inside the runtime.",
    principles: [
      ["Context-owned cognition", "A Context owns cross-session cognition, cognitive frames, and the recallable ledger. A Session is a communication channel, not a memory container."],
      ["Recoverable execution", "Threads, Activations, and Objectives make execution lifecycles explicit, auditable, pausable, and recoverable."],
      ["Provider-independent access", "Providers, auth accounts, physical models, and model routes remain separate so the runtime is not coupled to one vendor."],
    ],
    flowTitle: "A clear path to the first useful result",
    flow: [
      ["01", "Configure", "Connect a model service through the Dashboard or terminal wizard."],
      ["02", "Converse", "Create a Context and Session, then receive a real model response."],
      ["03", "Execute", "Let the agent work inside explicit workspace, permission, and target boundaries."],
      ["04", "Continue", "Use cognitive frames, Recall, Objectives, and scheduling for durable work."],
    ],
    docsTitle: "Documentation is a product contract",
    docsLead: "Public docs describe behavior that can be verified today. Proposals, research, and historical designs remain available in the repository without being presented as shipped features.",
    docsCards: [
      ["Getting started", "Build, run Setup, and receive the first response.", "getting-started"],
      ["Core concepts", "Understand Contexts, Sessions, cognitive frames, and execution lifecycles.", "core-concepts"],
      ["Model services", "Configure providers, accounts, models, and routes.", "providers-and-models"],
      ["Operations", "Diagnose model, logging, task, and storage problems.", "operations"],
    ],
  },
} as const;

export function LandingPage({ locale }: { locale: Locale }) {
  const t = content[locale];
  const docs = locale === "zh" ? "/docs" : "/en/docs";
  return (
    <main>
      <SiteHeader locale={locale} />
      <section className="hero">
        <div className="hero__glow" aria-hidden="true" />
        <div className="hero__content">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <p className="hero__lead">{t.lead}</p>
          <div className="hero__actions">
            <Link className="button button--primary" href={docs}>{t.primary}</Link>
            <a className="button button--quiet" href="https://github.com/yaowenai/morphz">{t.secondary}</a>
          </div>
        </div>
        <div className="runtime-card" aria-label={t.commandLabel}>
          <div className="runtime-card__header">
            <span>{t.commandLabel}</span>
            <span className="runtime-card__status">ready</span>
          </div>
          <pre><code><span>$</span> cargo build --release{"\n"}<span>$</span> ./target/release/morphz setup{"\n"}<span>$</span> ./target/release/morphz</code></pre>
          <div className="runtime-card__footer">
            <span>Context</span><strong>durable</strong><span>Execution</span><strong>recoverable</strong>
          </div>
        </div>
      </section>

      <section className="section section--principles">
        <div className="section-heading">
          <p className="eyebrow">RUNTIME BOUNDARIES</p>
          <h2>{t.principlesTitle}</h2>
          <p>{t.principlesLead}</p>
        </div>
        <div className="principle-grid">
          {t.principles.map(([title, description], index) => (
            <article className="principle-card" key={title}>
              <span>0{index + 1}</span><h3>{title}</h3><p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--flow">
        <div className="section-heading"><p className="eyebrow">FIRST RUN</p><h2>{t.flowTitle}</h2></div>
        <ol className="flow-list">
          {t.flow.map(([number, title, description]) => (
            <li key={number}><span>{number}</span><div><h3>{title}</h3><p>{description}</p></div></li>
          ))}
        </ol>
      </section>

      <section className="section section--docs">
        <div className="section-heading"><p className="eyebrow">DOCUMENTATION</p><h2>{t.docsTitle}</h2><p>{t.docsLead}</p></div>
        <div className="docs-card-grid">
          {t.docsCards.map(([title, description, slug]) => (
            <Link className="docs-card" href={`${docs}/${slug}`} key={slug}><h3>{title}</h3><p>{description}</p><span aria-hidden="true">→</span></Link>
          ))}
        </div>
      </section>
      <SiteFooter locale={locale} />
    </main>
  );
}
