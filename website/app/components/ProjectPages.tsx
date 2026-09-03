import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { paperPdf, sitePath, SITE_LINKS } from "@/lib/site";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { CopyCommand } from "./CopyCommand";

const paperCopy = {
  zh: {
    eyebrow: "预印本 · 2026",
    title: ["结构化上下文上的", "非确定性认知符号求值"],
    byline: "Raymond Ren · 双语预印本",
    lead: "论文给出 Morphz 计算模型的形式定义、实现边界与分层实验：大语言模型在智能体自有的结构化上下文上求值认知符号，确定性运行时保留对权限、版本、真实观察与权威状态提交的控制。",
    read: "阅读中文 PDF",
    other: "英文 PDF",
    record: "查看实验材料",
    questionLabel: "计算模型",
    question: "能否把大语言模型组织为结构化、持久上下文上的非确定性认知符号求值器，同时让现实副作用和权威状态继续由运行时控制？",
    contributionsLabel: "主要内容",
    contributions: [
      ["01", "计算身份", "模型不是消息补全器，而是受输入结构、算子说明和输出契约约束的非确定性认知求值器。"],
      ["02", "结果回流", "程序、认知对象和求值结果共享递归表示；结果能够进入当前绑定或成为后续任务引用的持久对象。"],
      ["03", "权威提交", "候选认知与现实状态分离，运行时负责校验、权限、版本、事务、调度和可恢复执行。"],
    ],
    evidenceLabel: "实验与结果",
    evidence: "分层实验覆盖机制可执行性、跨模型适用性、经验迁移和复杂终端任务中的系统级外部效度。实验协议、运行数据与失败样本随研究材料公开。",
    related: "阅读计算模型的技术介绍",
  },
  en: {
    eyebrow: "MORPHZ / PREPRINT / 2026",
    title: ["Nondeterministic Cognitive", "Symbol Evaluation over", "Structured Context"],
    byline: "Raymond Ren · bilingual preprint",
    lead: "The paper defines the Morphz computational model, its implementation boundary, and layered experiments: an LLM evaluates cognitive symbols over agent-owned Structured Context while a deterministic runtime retains authority over capabilities, versions, real observations, and committed state.",
    read: "Read the English PDF",
    other: "中文 PDF",
    record: "View experiment materials",
    questionLabel: "Computational model",
    question: "Can an LLM be organized as a nondeterministic cognitive-symbol evaluator over durable Structured Context while real-world effects and authoritative state remain under runtime control?",
    contributionsLabel: "Main contributions",
    contributions: [
      ["01", "Computational identity", "The model is not merely a message completer. It is a nondeterministic cognitive evaluator constrained by input structure, operator semantics, and output contracts."],
      ["02", "Result re-entry", "Programs, cognitive objects, and evaluation results share a recursive representation, allowing results to enter bindings or become durable objects referenced by later work."],
      ["03", "Authoritative commit", "Candidate cognition is separated from reality. The runtime owns validation, capabilities, versions, transactions, scheduling, and recoverable execution."],
    ],
    evidenceLabel: "Experiments and results",
    evidence: "Layered experiments cover mechanism executability, cross-model applicability, experience transfer, and system-level external validity on complex terminal tasks. Protocols, run data, and failure samples are published with the research materials.",
    related: "Read the technical introduction to the computational model",
  },
} as const;

const downloadCopy = {
  zh: {
    eyebrow: "原生运行",
    title: ["在你的机器上", "运行 Morphz。"],
    lead: "Morphz 是本地优先的原生运行时。macOS、Linux 和 Windows 共享同一套认知上下文、调度、模型服务与恢复语义；控制台随 Morphz 一同提供。",
    releases: "GitHub Releases",
    source: "从源码构建",
    current: "安装方式",
    currentBody: "日常使用可直接安装 GitHub Releases 提供的预编译版本；每个下载文件均附带 SHA-256 校验值。参与开发或需要独立复现时，也可以从源码构建。",
    platformsLabel: "原生平台",
    platforms: [
      ["macOS", "Apple Silicon · Intel", "curl -fsSL https://github.com/morphz-ai/morphz/releases/latest/download/install.sh | sh\nmorphz setup", "原生沙箱与系统钥匙串"],
      ["Linux", "x86_64", "curl -fsSL https://github.com/morphz-ai/morphz/releases/latest/download/install.sh | sh\nmorphz setup", "Bubblewrap 原生隔离"],
      ["Windows", "x86_64 · Native", "irm https://github.com/morphz-ai/morphz/releases/latest/download/install.ps1 | iex\nmorphz setup", "ConPTY 与 Windows 原生沙箱"],
    ],
    afterLabel: "安装之后",
    after: [
      ["01", "连接模型服务", "设置向导支持 API 密钥以及 Morphz 已实现的订阅 OAuth 登录流程。"],
      ["02", "验证真实响应", "先运行诊断，再完成一次真正到达模型服务的请求。"],
      ["03", "选择使用界面", "在终端界面中直接工作，或通过控制台检查认知上下文、线程、任务与执行节点。"],
    ],
    guide: "打开完整安装指南",
  },
  en: {
    eyebrow: "MORPHZ / NATIVE RUNTIME",
    title: ["Run Morphz", "on your machine."],
    lead: "Morphz is a local-first native runtime. macOS, Linux, and Windows share the same Context, scheduling, provider, and recovery semantics; the Dashboard ships with the Runtime.",
    releases: "GitHub Releases",
    source: "Build from source",
    current: "Installation options",
    currentBody: "For regular use, install a prebuilt binary from GitHub Releases; each download includes a SHA-256 checksum. Build from source when contributing to development or reproducing the project independently.",
    platformsLabel: "Native platforms",
    platforms: [
      ["macOS", "Apple Silicon · Intel", "curl -fsSL https://github.com/morphz-ai/morphz/releases/latest/download/install.sh | sh\nmorphz setup", "Native sandbox and system keychain"],
      ["Linux", "x86_64", "curl -fsSL https://github.com/morphz-ai/morphz/releases/latest/download/install.sh | sh\nmorphz setup", "Native Bubblewrap isolation"],
      ["Windows", "x86_64 · Native", "irm https://github.com/morphz-ai/morphz/releases/latest/download/install.ps1 | iex\nmorphz setup", "ConPTY and native Windows sandbox"],
    ],
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
    <main className="content-site">
      <SiteHeader locale={locale} otherLanguageHref={sitePath(otherLocale, "/paper")} />
      <article className={`project-page paper-page paper-page--${locale}`}>
        <header className="project-page__header">
          <div>
            <p className="eyebrow">{t.eyebrow}</p>
            <h1>{t.title.map((line) => <span key={line}>{line}</span>)}</h1>
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
    <main className="content-site">
      <SiteHeader locale={locale} otherLanguageHref={sitePath(otherLocale, "/download")} />
      <article className="project-page download-page">
        <header className="project-page__header">
          <div><p className="eyebrow">{t.eyebrow}</p><h1>{t.title.map((line) => <span key={line}>{line}</span>)}</h1></div>
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
                <div className="platform-command">
                  <pre><code>{command}</code></pre>
                  <CopyCommand command={command} locale={locale} platform={name} />
                </div>
                <p><i aria-hidden="true" />{capability}</p>
              </article>
            ))}
          </div>
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
