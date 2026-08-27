import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { ContextEvaluationField } from "./ContextEvaluationField";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const content = {
  zh: {
    edition: "MORPHZ / DEVELOPER PREVIEW / 0.1",
    eyebrow: "让代理拥有可持续认知，而不是更长的聊天记录",
    title: ["上下文，", "不再只是", "消息历史。"],
    lead: "Morphz 让结构化上下文成为模型直接求值的对象。模型负责非确定性的语义处理，运行时负责事实、权限、状态与执行。",
    idea: "理解这个想法",
    start: "开始运行",
    source: "检视源码",
    boundaryIndex: "01 / 计算边界",
    boundaryTitle: "把认知交给模型，\n把确定性留给运行\u2060时。",
    boundaryLead: "长程代理不应把身份、权限、恢复与持久状态寄托在一次完美提示词里。",
    modelLabel: "非确定性语义处理器",
    modelTitle: "模型解释世界",
    modelBody: "理解意图、形成判断、提出行动，并在结构化上下文中修订认知。",
    runtimeLabel: "确定性事务内核",
    runtimeTitle: "运行时守住事实",
    runtimeBody: "验证能力、提交状态、调度执行，并让失败、恢复与因果链保持可审计。",
    sequenceIndex: "02 / 求值序列",
    sequenceTitle: "一条消息进入之后，发生了\u2060什么？",
    sequenceLead: "不是把全部历史再次拼成提示词，而是选择此刻真正参与求值的结构。",
    sequence: [
      ["输入成为事件", "会话接收观察，但会话本身不拥有认知。"],
      ["上下文选择结构", "认知帧、目标、召回与当前状态按语义进入求值。"],
      ["模型进行求值", "大语言模型作为非确定性处理器解释结构并产生结果。"],
      ["运行时提交变化", "合法变化被持久化；下一会话从新的认知状态继续。"],
    ],
    phenomenaIndex: "03 / 可观察现象",
    phenomenaTitle: "不是功能列表，\n而是可以复现的系统\u2060行为。",
    phenomena: [
      ["跨会话连续", "认知上下文持有认知。会话结束不等于机器失忆。", "session_a → context_01 → session_b"],
      ["并行而不串扰", "线程和目标拥有明确生命周期，并发工作不会共享一团隐形聊天状态。", "thread_04 ∥ thread_05"],
      ["失败之后继续", "网络、工具或进程失败留下可检查终态，工作可以恢复而不是重新猜测。", "activation: interrupted → resumed"],
    ],
    evidenceIndex: "04 / 证据路径",
    evidenceTitle: "先读思想，\n再检查证据。",
    evidenceLead: "文章、论文实验、源码与公开文档承担不同职责。它们共同构成 Morphz 的技术主张。",
    evidence: [
      ["IDEA", "从聊天补全到结构化上下文求值", "一篇解释新计算模型的技术文章。", "blog"],
      ["EVIDENCE", "论文实验中心", "冻结协议、失败样本、Pilot 与确认性证据边界。", "research"],
      ["SOURCE", "运行时源码", "真实实现、测试、迁移与可审计状态机。", "source"],
      ["SPEC", "产品文档", "只描述当前能够验证的公开行为。", "docs"],
    ],
    runIndex: "05 / 第一次运行",
    runTitle: "从一台本地机器开始。",
    runLead: "设置向导连接模型服务；Dashboard 展示上下文、会话、线程与执行状态。",
    copyLabel: "构建 / 设置 / 运行",
    preview: "Developer Preview",
    previewBody: "核心机制可以复现，接口与多进程能力仍在演进。公开限制与实验状态不会被包装成生产承诺。",
    docsTitle: "继续阅读",
    docsCards: [
      ["快速开始", "从构建到第一次真实模型响应。", "getting-started"],
      ["核心概念", "认知上下文、会话、认知帧与执行生命周期。", "core-concepts"],
      ["模型服务", "模型服务、账号、物理模型与路由。", "providers-and-models"],
      ["运维排障", "日志、任务、存储与恢复。", "operations"],
    ],
  },
  en: {
    edition: "MORPHZ / DEVELOPER PREVIEW / 0.1",
    eyebrow: "Durable cognition for agents—not a longer transcript",
    title: ["Context is", "no longer", "a transcript."],
    lead: "Morphz makes structured Context the object a model evaluates directly. The model handles nondeterministic semantics; the runtime owns facts, authority, state, and execution.",
    idea: "Read the idea",
    start: "Start running",
    source: "Inspect the source",
    boundaryIndex: "01 / COMPUTATIONAL BOUNDARY",
    boundaryTitle: "Cognition belongs to the model.\nCertainty belongs to the runtime.",
    boundaryLead: "A long-running agent should not entrust identity, authority, recovery, and durable state to one perfect prompt.",
    modelLabel: "NONDETERMINISTIC SEMANTIC PROCESSOR",
    modelTitle: "The model interprets",
    modelBody: "It understands intent, forms judgments, proposes actions, and revises cognition inside structured Context.",
    runtimeLabel: "DETERMINISTIC TRANSACTION KERNEL",
    runtimeTitle: "The runtime preserves facts",
    runtimeBody: "It validates capabilities, commits state, schedules execution, and keeps failure, recovery, and causality auditable.",
    sequenceIndex: "02 / EVALUATION SEQUENCE",
    sequenceTitle: "What happens after a message arrives?",
    sequenceLead: "Morphz does not simply concatenate the entire transcript again. It selects the structures that matter to this evaluation.",
    sequence: [
      ["Input becomes an event", "A Session receives an observation; the Session does not own cognition."],
      ["Context selects structure", "Frames, Objectives, Recall, and current state enter evaluation by meaning."],
      ["The model evaluates", "The language model interprets the structure as a nondeterministic processor."],
      ["The runtime commits", "Valid changes become durable; another Session continues from the new state."],
    ],
    phenomenaIndex: "03 / OBSERVABLE PHENOMENA",
    phenomenaTitle: "Not a feature list.\nSystem behavior you can reproduce.",
    phenomena: [
      ["Continuity across Sessions", "A Context owns cognition. Ending a Session does not reset the machine.", "session_a → context_01 → session_b"],
      ["Parallel without contamination", "Threads and Objectives have explicit lifecycles instead of sharing invisible chat state.", "thread_04 ∥ thread_05"],
      ["Continuation after failure", "Network, tool, and process failures leave inspectable states that can be resumed.", "activation: interrupted → resumed"],
    ],
    evidenceIndex: "04 / EVIDENCE PATH",
    evidenceTitle: "Read the idea.\nThen inspect the evidence.",
    evidenceLead: "The essay, research program, source, and public documentation have different jobs. Together they support the technical claim.",
    evidence: [
      ["IDEA", "From Chat Completion to Structured Context Evaluation", "The technical essay introducing the computational model.", "blog"],
      ["EVIDENCE", "Paper evaluation center", "Frozen protocols, failures, pilots, and confirmatory boundaries.", "research"],
      ["SOURCE", "Runtime source", "The implementation, tests, migrations, and auditable state machines.", "source"],
      ["SPEC", "Product documentation", "Only behavior that can be verified in the current implementation.", "docs"],
    ],
    runIndex: "05 / FIRST RUN",
    runTitle: "Start on one local machine.",
    runLead: "Setup connects a model service. The Dashboard exposes Context, Sessions, Threads, and execution state.",
    copyLabel: "BUILD / SETUP / RUN",
    preview: "Developer Preview",
    previewBody: "The core mechanism is reproducible while interfaces and multi-process operation continue to evolve. Experimental status is not presented as a production promise.",
    docsTitle: "Continue reading",
    docsCards: [
      ["Getting started", "Build Morphz and receive the first real model response.", "getting-started"],
      ["Core concepts", "Contexts, Sessions, cognitive frames, and execution lifecycles.", "core-concepts"],
      ["Model services", "Providers, accounts, physical models, and routes.", "providers-and-models"],
      ["Operations", "Logs, tasks, storage, and recovery.", "operations"],
    ],
  },
} as const;

export function LandingPage({ locale }: { locale: Locale }) {
  const t = content[locale];
  const docs = locale === "zh" ? "/docs" : "/en/docs";
  const blog = locale === "zh" ? "/blog/from-chat-completion-to-structured-context-evaluation" : "/en/blog/from-chat-completion-to-structured-context-evaluation";
  const research = "https://github.com/yaowenai/morphz/tree/main/docs/research/paper_evaluation";
  const source = "https://github.com/yaowenai/morphz";
  const evidenceHref = (kind: string) => kind === "blog" ? blog : kind === "research" ? research : kind === "source" ? source : docs;

  return (
    <main>
      <SiteHeader locale={locale} />
      <section className="hero-spec">
        <div className="hero-spec__edition"><span>{t.edition}</span><span aria-hidden="true">S-EXPR COGNITIVE MACHINE</span></div>
        <div className="hero-spec__copy">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>{t.title.map((line, index) => <span className={index === 2 ? "hero-spec__accent" : ""} key={line}>{line}</span>)}</h1>
          <p className="hero-spec__lead">{t.lead}</p>
          <div className="hero-spec__actions">
            <Link className="text-action text-action--primary" href={blog}>{t.idea}<span aria-hidden="true">↗</span></Link>
            <Link className="text-action" href={`${docs}/getting-started`}>{t.start}<span aria-hidden="true">→</span></Link>
            <a className="text-action" href={source}>{t.source}<span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <ContextEvaluationField locale={locale} />
      </section>

      <section className="site-section boundary-section">
        <header className="chapter-heading">
          <p className="chapter-heading__index">{t.boundaryIndex}</p>
          <h2>{t.boundaryTitle}</h2>
          <p>{t.boundaryLead}</p>
        </header>
        <div className="boundary-equation" aria-label="model and runtime boundary">
          <article><span>{t.modelLabel}</span><h3>{t.modelTitle}</h3><p>{t.modelBody}</p></article>
          <div className="boundary-equation__operator" aria-hidden="true"><span>LLM</span><i>⇄</i><span>RUNTIME</span></div>
          <article><span>{t.runtimeLabel}</span><h3>{t.runtimeTitle}</h3><p>{t.runtimeBody}</p></article>
        </div>
      </section>

      <section className="site-section sequence-section">
        <header className="chapter-heading chapter-heading--compact">
          <p className="chapter-heading__index">{t.sequenceIndex}</p><h2>{t.sequenceTitle}</h2><p>{t.sequenceLead}</p>
        </header>
        <ol className="evaluation-sequence">
          {t.sequence.map(([title, description], index) => (
            <li key={title}><span>0{index + 1}</span><div><h3>{title}</h3><p>{description}</p></div><i aria-hidden="true" /></li>
          ))}
        </ol>
      </section>

      <section className="site-section phenomena-section">
        <header className="chapter-heading">
          <p className="chapter-heading__index">{t.phenomenaIndex}</p><h2>{t.phenomenaTitle}</h2>
        </header>
        <div className="phenomena-list">
          {t.phenomena.map(([title, description, trace], index) => (
            <article key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{description}</p><code>{trace}</code></article>
          ))}
        </div>
      </section>

      <section className="site-section evidence-section">
        <header className="chapter-heading">
          <p className="chapter-heading__index">{t.evidenceIndex}</p><h2>{t.evidenceTitle}</h2><p>{t.evidenceLead}</p>
        </header>
        <div className="evidence-index">
          {t.evidence.map(([label, title, description, kind], index) => (
            <a href={evidenceHref(kind)} key={label}>
              <span className="evidence-index__number">0{index + 1}</span><span className="evidence-index__label">{label}</span>
              <strong>{title}</strong><p>{description}</p><i aria-hidden="true">↗</i>
            </a>
          ))}
        </div>
      </section>

      <section className="site-section run-section">
        <div className="run-section__copy">
          <p className="chapter-heading__index">{t.runIndex}</p><h2>{t.runTitle}</h2><p>{t.runLead}</p>
          <Link className="text-action text-action--primary" href={`${docs}/getting-started`}>{t.start}<span aria-hidden="true">→</span></Link>
        </div>
        <div className="run-sheet" aria-label={t.copyLabel}>
          <div><span>{t.copyLabel}</span><span>macOS · Linux</span></div>
          <pre><code><b>01</b> cargo build --release{"\n"}<b>02</b> ./target/release/morphz setup{"\n"}<b>03</b> ./target/release/morphz</code></pre>
          <footer><span>{t.preview}</span><p>{t.previewBody}</p></footer>
        </div>
      </section>

      <section className="site-section reading-section">
        <h2>{t.docsTitle}</h2>
        <div className="reading-index">
          {t.docsCards.map(([title, description, slug], index) => (
            <Link href={`${docs}/${slug}`} key={slug}><span>0{index + 1}</span><h3>{title}</h3><p>{description}</p><i aria-hidden="true">→</i></Link>
          ))}
        </div>
      </section>
      <SiteFooter locale={locale} />
    </main>
  );
}
