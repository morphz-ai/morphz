import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { paperPdf, sitePath, SITE_LINKS } from "@/lib/site";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const paperCopy = {
  zh: {
    eyebrow: "MORPHZ / PREPRINT / 2026",
    title: "结构化上下文上的非确定性认知符号求值",
    byline: "Raymond Ren · 双语预印本",
    lead: "论文给出 Morphz 计算模型的形式定义、实现边界与分层实验：大语言模型在 Agent 自有的结构化上下文上求值认知符号，确定性运行时保留对权限、版本、真实观察与权威状态提交的控制。",
    read: "阅读中文 PDF",
    other: "English PDF",
    record: "检查研究记录",
    questionLabel: "核心问题",
    question: "能否把大语言模型组织为结构化、持久上下文上的非确定性认知符号求值器，同时让现实副作用和权威状态继续由运行时控制？",
    contributionsLabel: "论文建立的三层边界",
    contributions: [
      ["01", "计算身份", "模型不是消息补全器，而是受输入结构、算子说明和输出契约约束的非确定性认知求值器。"],
      ["02", "结果回流", "程序、认知对象和求值结果共享递归表示；结果能够进入当前绑定或成为后续任务引用的持久对象。"],
      ["03", "权威提交", "候选认知与现实状态分离，运行时负责校验、权限、版本、事务、调度和可恢复执行。"],
    ],
    evidenceLabel: "证据范围",
    evidence: "论文依次验证机制可执行性、跨模型适用性、经验迁移和复杂终端任务中的系统级外部效度。每类实验的协议、失败样本与结论边界均保留在研究记录中。",
    related: "先读面向更广泛读者的技术文章",
  },
  en: {
    eyebrow: "MORPHZ / PREPRINT / 2026",
    title: "Nondeterministic Cognitive Symbol Evaluation over Structured Context",
    byline: "Raymond Ren · bilingual preprint",
    lead: "The paper defines the Morphz computational model, its implementation boundary, and layered experiments: an LLM evaluates cognitive symbols over agent-owned Structured Context while a deterministic runtime retains authority over capabilities, versions, real observations, and committed state.",
    read: "Read the English PDF",
    other: "中文 PDF",
    record: "Inspect the research record",
    questionLabel: "Research question",
    question: "Can an LLM be organized as a nondeterministic cognitive-symbol evaluator over durable Structured Context while real-world effects and authoritative state remain under runtime control?",
    contributionsLabel: "Three boundaries established by the paper",
    contributions: [
      ["01", "Computational identity", "The model is not merely a message completer. It is a nondeterministic cognitive evaluator constrained by input structure, operator semantics, and output contracts."],
      ["02", "Result re-entry", "Programs, cognitive objects, and evaluation results share a recursive representation, allowing results to enter bindings or become durable objects referenced by later work."],
      ["03", "Authoritative commit", "Candidate cognition is separated from reality. The runtime owns validation, capabilities, versions, transactions, scheduling, and recoverable execution."],
    ],
    evidenceLabel: "Evidence scope",
    evidence: "The paper evaluates mechanism executability, cross-model applicability, experience transfer, and system-level external validity on complex terminal tasks. Protocols, failures, and claim boundaries remain available in the research record.",
    related: "Read the broader technical essay first",
  },
} as const;

const downloadCopy = {
  zh: {
    eyebrow: "MORPHZ / NATIVE RUNTIME",
    title: "在你的机器上运行 Morphz。",
    lead: "Morphz 是本地优先的原生运行时。macOS、Linux 和 Windows 共享同一套 Context、调度、Provider 与恢复语义；Dashboard 随 Runtime 一同提供。",
    releases: "查看预编译版本",
    source: "从源码构建",
    current: "当前发布方式",
    currentBody: "源码构建是当前权威路径；与版本标签绑定的预编译归档将在 GitHub Releases 中提供。任何安装包都不改变本地数据与权限边界。",
    platformsLabel: "原生平台",
    platforms: [
      ["macOS", "Apple Silicon · Intel", "cargo build --release\n./target/release/morphz setup", "原生沙箱与系统钥匙串"],
      ["Linux", "x86_64", "cargo build --release\n./target/release/morphz setup", "Bubblewrap 原生隔离"],
      ["Windows", "x86_64 · Native", "cargo build --release\n.\\target\\release\\morphz.exe setup", "ConPTY 与 Windows 原生沙箱"],
    ],
    windows: "Windows 版是原生程序，WSL 只是可选运行方式，不是首选入口。发布归档同时包含 Morphz、Edge 与 Windows 沙箱辅助程序。",
    afterLabel: "安装之后",
    after: [
      ["01", "连接模型服务", "Setup 支持 API 密钥以及 Runtime 已实现的订阅 OAuth 登录流程。"],
      ["02", "验证真实响应", "先运行诊断，再完成一次真正到达模型服务的请求。"],
      ["03", "选择使用界面", "在 TUI 中直接工作，或通过 Dashboard 检查 Context、线程、任务与执行目标。"],
    ],
    guide: "打开完整安装指南",
  },
  en: {
    eyebrow: "MORPHZ / NATIVE RUNTIME",
    title: "Run Morphz on your machine.",
    lead: "Morphz is a local-first native runtime. macOS, Linux, and Windows share the same Context, scheduling, provider, and recovery semantics; the Dashboard ships with the Runtime.",
    releases: "View prebuilt releases",
    source: "Build from source",
    current: "Current distribution",
    currentBody: "Building from source is the current authoritative path. Prebuilt archives tied to release tags will be published through GitHub Releases. Distribution does not change the local data or authority boundary.",
    platformsLabel: "Native platforms",
    platforms: [
      ["macOS", "Apple Silicon · Intel", "cargo build --release\n./target/release/morphz setup", "Native sandbox and system keychain"],
      ["Linux", "x86_64", "cargo build --release\n./target/release/morphz setup", "Native Bubblewrap isolation"],
      ["Windows", "x86_64 · Native", "cargo build --release\n.\\target\\release\\morphz.exe setup", "ConPTY and native Windows sandbox"],
    ],
    windows: "The Windows build is native. WSL remains optional rather than the primary route. The release archive includes Morphz, Edge, and the Windows sandbox helpers.",
    afterLabel: "After installation",
    after: [
      ["01", "Connect a model service", "Setup supports API keys and the subscription OAuth flows already implemented by the Runtime."],
      ["02", "Verify a real response", "Run diagnostics, then complete one request that reaches a real model service."],
      ["03", "Choose an interface", "Work in the TUI or use the Dashboard to inspect Context, Threads, jobs, and Execution Targets."],
    ],
    guide: "Open the full installation guide",
  },
} as const;

export function PaperPage({ locale }: { locale: Locale }) {
  const t = paperCopy[locale];
  const otherLocale = locale === "zh" ? "en" : "zh";
  return (
    <main>
      <SiteHeader locale={locale} otherLanguageHref={sitePath(otherLocale, "/paper")} />
      <article className="project-page paper-page">
        <header className="project-page__header">
          <div>
            <p className="eyebrow">{t.eyebrow}</p>
            <h1>{t.title}</h1>
          </div>
          <div className="project-page__intro">
            <p className="project-page__byline">{t.byline}</p>
            <p>{t.lead}</p>
            <div className="project-page__actions">
              <a className="button button--primary" href={paperPdf(locale)}>{t.read} <span aria-hidden="true">↓</span></a>
              <a className="button" href={paperPdf(otherLocale)}>{t.other} <span aria-hidden="true">↓</span></a>
              <a className="button button--text" href={SITE_LINKS.research}>{t.record} <span aria-hidden="true">↗</span></a>
            </div>
          </div>
        </header>

        <section className="project-page__statement">
          <span>{t.questionLabel}</span>
          <blockquote>{t.question}</blockquote>
        </section>

        <section className="project-page__section">
          <p className="project-page__label">{t.contributionsLabel}</p>
          <div className="project-page__rows">
            {t.contributions.map(([index, title, body]) => (
              <article key={index}><span>{index}</span><h2>{title}</h2><p>{body}</p></article>
            ))}
          </div>
        </section>

        <section className="project-page__closing">
          <div><span>{t.evidenceLabel}</span><p>{t.evidence}</p></div>
          <Link href={sitePath(locale, "/blog/from-chat-completion-to-structured-context-evaluation")}>{t.related} <span aria-hidden="true">→</span></Link>
        </section>
      </article>
      <SiteFooter locale={locale} />
    </main>
  );
}

export function DownloadPage({ locale }: { locale: Locale }) {
  const t = downloadCopy[locale];
  const otherLocale = locale === "zh" ? "en" : "zh";
  return (
    <main>
      <SiteHeader locale={locale} otherLanguageHref={sitePath(otherLocale, "/download")} />
      <article className="project-page download-page">
        <header className="project-page__header">
          <div><p className="eyebrow">{t.eyebrow}</p><h1>{t.title}</h1></div>
          <div className="project-page__intro">
            <p>{t.lead}</p>
            <div className="project-page__actions">
              <a className="button button--primary" href={SITE_LINKS.releases}>{t.releases} <span aria-hidden="true">↗</span></a>
              <Link className="button" href={sitePath(locale, "/docs/getting-started")}>{t.source} <span aria-hidden="true">→</span></Link>
            </div>
          </div>
        </header>

        <section className="project-page__statement project-page__statement--compact">
          <span>{t.current}</span><p>{t.currentBody}</p>
        </section>

        <section className="project-page__section">
          <p className="project-page__label">{t.platformsLabel}</p>
          <div className="platform-grid">
            {t.platforms.map(([name, architecture, command, capability]) => (
              <article key={name}>
                <header><h2>{name}</h2><span>{architecture}</span></header>
                <pre><code>{command}</code></pre>
                <p><i aria-hidden="true" />{capability}</p>
              </article>
            ))}
          </div>
          <p className="platform-note">{t.windows}</p>
        </section>

        <section className="project-page__section">
          <p className="project-page__label">{t.afterLabel}</p>
          <div className="project-page__rows project-page__rows--compact">
            {t.after.map(([index, title, body]) => (
              <article key={index}><span>{index}</span><h2>{title}</h2><p>{body}</p></article>
            ))}
          </div>
        </section>

        <section className="project-page__closing project-page__closing--action">
          <Link href={sitePath(locale, "/docs/getting-started")}>{t.guide} <span aria-hidden="true">→</span></Link>
        </section>
      </article>
      <SiteFooter locale={locale} />
    </main>
  );
}
