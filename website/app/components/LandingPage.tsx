import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { sitePath, SITE_LINKS } from "@/lib/site";
import { ContextEvaluationField } from "./ContextEvaluationField";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const content = {
  zh: {
    eyebrow: "为长期并发工作而生",
    title: ["一个智能体。", "多个目标。", "并发推进。"],
    lead: "Morphz 让一个智能体在同一认知上下文中维护多个会话、目标与线程。对话不必等待任务结束，认知变化经过事务提交，执行可以安全抵达不同目标节点。",
    idea: "查看功能",
    start: "运行 Morphz",
    source: "查看源码",
    capabilitiesLabel: "核心功能",
    capabilitiesTitle: "让智能体维护认知、并发推进工作，并安全触达真实环境。",
    capabilitiesLead: "结构化认知上下文、显式事务、持久调度与执行节点，共同构成 Morphz 的长期工作能力。",
    features: [
      {
        kind: "maintenance",
        signature: "上下文 · 认知帧 · 会话",
        index: "01 / 认知上下文自我维护",
        title: "认知上下文自我维护。\n认知持续演化。",
        lead: "Morphz 把认知上下文作为可持久、可版本化、可求值的一等状态。运行时报告物理事实与容量压力，智能体通过显式事务决定如何整理认知。",
        items: [
          ["结构化认知上下文", "会话是认知上下文的组成部分", "一次上下文编码将收件箱、认知帧、会话目录、内核状态与唯一求值入口组织在同一结构中。"],
          ["不自动压缩", "认知上下文不被自动有损压缩", "达到容量压力时，运行时只报告边界；智能体显式决定保留、修订或退役什么，不将完整上下文静默改写成摘要。"],
          ["上下文事务", "认知帧通过证据持续修订", "derive、revise、retire、restore 与 protect 形成带版本、来源和生命周期的认知变化。"],
          ["会话工作集", "当前与近期会话进入上下文", "当前会话优先；运行时默认选择最近 24 小时内至多 50 个近期会话进入上下文。其他会话仍持久保存，并可在再次活跃时重新进入。"],
        ],
      },
      {
        kind: "concurrency",
        signature: "目标 · 线程 · 激活",
        index: "02 / 并发工作",
        title: "一个智能体。\n多条工作线同时推进。",
        lead: "Morphz 分别用会话、目标、线程与激活表达交互、目标、因果路径和执行机会。工具与长任务不会占住整个智能体。",
        items: [
          ["非阻塞", "智能体工作时，仍能继续对话", "工具执行、长期任务与新消息可以并发；结果沿原有因果路线返回，不会阻塞其他会话。"],
          ["目标", "多个长期目标独立收敛", "每个目标持有状态、依赖与完成条件，可以跨求值、等待和进程重启持续推进。"],
          ["线程 · 激活", "工作线与执行机会彼此分离", "线程保留因果路径，激活表示一次具体执行；等待结束后可从确定边界恢复。"],
          ["多版本并发控制", "并发更新经过版本校验", "独立的认知变化可以提交；过期或冲突的修改必须重新求值，避免覆盖较新的状态。"],
        ],
      },
      {
        kind: "execution",
        signature: "目标 · 租约 · 沙箱",
        index: "03 / 可信执行",
        title: "任务运行在目标节点。\n权限留在运行时。",
        lead: "执行节点把认知求值与物理执行分开。任务可进入本机、托管 SSH 主机或边缘节点，并在节点环境的沙箱与最小权限内运行。",
        items: [
          ["执行节点", "本机、托管 SSH 主机与边缘节点", "同一个智能体可以把不同任务路由到资源所在的位置，并保留明确的节点归属。"],
          ["原生沙箱", "macOS、Linux 与 Windows 原生隔离", "工作区写入由操作系统沙箱执行；缺少所需隔离后端时，受限模式拒绝降级运行。"],
          ["能力租约", "最小权限、明确作用域、可以撤销", "能力租约绑定主体、智能体、认知上下文、线程、执行节点与操作集合，审批不会隐式扩大权限。"],
          ["凭证与审计", "凭证不进入认知上下文，执行保留记录", "密钥保存在独立凭证库；审批、工具调用和状态迁移进入可追溯事件。"],
        ],
      },
    ],
    mechanismIndex: "04 / 认知应用",
    mechanismTitle: "把智能体的工作方式，\n封装成认知应用。",
    mechanismLead: "认知应用组织领域能力；领域程序包定义一次求值如何运行；Yao 为模型与运行时提供共享的认知求值语言。应用可以替换工作方式，但不能绕过事务、权限与执行边界。",
    mechanismAction: "查看领域程序包与 Yao 规范",
    mechanisms: [
      ["应用", "认知应用", "将界面、领域资源、工具和集成组织成面向具体工作的认知应用。"],
      ["领域程序包", "Harness", "以版本化包定义求值循环、领域合同、默认认知和策略。"],
      ["语言", "Yao", "类型化认知求值程序支持推理、求值与并行算子，并在执行前经过运行时准入。"],
    ],
    systemIndex: "05 / 定义",
    systemParts: ["会话多路输入输出", "认知帧 · 会话换入 / 换出", "线程与目标调度", "能力约束的执行接口"],
    systemBridge: "超越单一对话循环",
    systemTitle: "智能体运行的\n新范式。",
    systemLead: "Morphz 是一款面向长期并发工作的开源智能体。它在同一运行时内统一管理多路会话输入输出、认知帧与会话在当前认知工作集中的换入和换出、线程与目标调度，以及受能力约束的执行。这些机制共同构成它的认知操作系统内核。",
    evidenceIndex: "07 / 进一步了解",
    evidenceTitle: "从产品功能，\n进入技术实现。",
    evidenceLead: "阅读产品文档、技术文章与研究论文，或直接查看源码并在本地运行 Morphz。",
    evidence: [
      ["文章", "结构化上下文求值", "介绍 Morphz 的核心计算模型。", "blog"],
      ["论文", "研究论文", "形式定义、系统边界与实验结果。", "paper"],
      ["源码", "源码与测试", "Apache-2.0 开源实现。", "source"],
      ["文档", "产品文档", "安装、配置、核心概念与运行说明。", "docs"],
    ],
    runIndex: "06 / 第一次运行",
    runTitle: "在自己的机器上，\n启动 Morphz。",
    runLead: "一条命令安装预编译版本；随后通过设置向导连接模型服务并启动 Morphz。",
    copyLabel: "一条命令安装",
    runPlatforms: "macOS · Linux",
    preview: "GitHub Release",
    previewBody: "安装脚本识别当前平台、校验下载内容并安装到用户目录；Windows 原生版本在下载页提供。",
    docsTitle: "产品文档",
    docsCards: [
      ["快速开始", "从安装到第一次真实模型响应。", "getting-started"],
      ["核心概念", "认知上下文、会话、认知与执行生命周期。", "core-concepts"],
      ["并发与目标", "目标、线程与持久调度。", "execution-lifecycle"],
      ["执行与安全", "沙箱、权限与执行节点。", "execution-targets"],
    ],
  },
  en: {
    eyebrow: "Built for durable work and concurrent execution",
    title: ["One Agent.", "Many Objectives.", "Advancing in parallel."],
    lead: "Morphz lets one Agent maintain multiple Sessions, Objectives, and Threads inside one Context. Conversation does not wait for long-running work, cognitive changes commit through transactions, and execution can safely reach different target nodes.",
    idea: "Explore",
    start: "Run Morphz",
    source: "Inspect the source",
    capabilitiesLabel: "Core capabilities",
    capabilitiesTitle: "Let an Agent maintain its Context, advance concurrent work, and safely reach real environments.",
    capabilitiesLead: "Context Encoding, explicit transactions, durable scheduling, and Execution Targets work together as the foundation for long-running Agent work.",
    features: [
      {
        kind: "maintenance",
        signature: "context · session · mind",
        index: "01 / CONTEXT SELF-MAINTENANCE",
        title: "A self-maintaining Context.\nCognition that keeps evolving.",
        lead: "Morphz makes Context a persistent, versioned, evaluable first-class state. The Runtime reports physical facts and capacity pressure; the Agent decides how cognition changes through explicit transactions.",
        items: [
          ["STRUCTURED CONTEXT", "Session is part of Context", "One Context Encoding organizes Inbox, Mind, Session Directory, Kernel state, and the sole evaluation entry in one recursive structure."],
          ["NO AUTOMATIC COMPACTION", "No automatic lossy Context compaction", "Under capacity pressure, the Runtime reports the boundary. The Agent explicitly decides what to preserve, revise, or retire instead of letting the system silently rewrite the entire Context as a summary."],
          ["SESSION WORKING SET", "Current and recent Sessions enter Context", "The current Session comes first. By default, Morphz projects up to 50 Sessions active within the last 24 hours; the rest remain durable and can return when active again."],
          ["CONTEXT TRANSACTION", "Cognition evolves through evidence", "derive, revise, retire, restore, and protect produce cognitive changes with explicit versions, provenance, and lifecycles."],
        ],
      },
      {
        kind: "concurrency",
        signature: "objective · thread · activation",
        index: "02 / CONCURRENT WORK",
        title: "One Agent.\nMany workstreams in progress.",
        lead: "Morphz uses Sessions, Objectives, Threads, and Activations for distinct interaction, goal, causal, and execution semantics. Tools and long-running work do not occupy the whole Agent.",
        items: [
          ["NON-BLOCKING", "Keep talking while the Agent works", "Tool execution, long-running work, and new messages can proceed concurrently. Results return along their original causal routes without blocking other Sessions."],
          ["OBJECTIVE", "Durable goals converge independently", "Each Objective owns state, dependencies, and completion conditions across Evaluations, waits, and process restarts."],
          ["THREAD · ACTIVATION", "Causal work and execution are separate", "A Thread preserves the causal path; an Activation represents one execution opportunity and can resume from a defined boundary after a wait."],
          ["MVCC", "Concurrent updates pass version checks", "Independent cognitive changes can commit. Stale or conflicting changes must be evaluated again instead of overwriting newer state."],
        ],
      },
      {
        kind: "execution",
        signature: "target · lease · sandbox",
        index: "03 / TRUSTED EXECUTION",
        title: "Run tasks on target nodes.\nKeep authority in the Runtime.",
        lead: "Execution Targets separate cognitive evaluation from physical execution. Tasks can run locally, on a managed SSH host, or on an Edge Node within the target environment's sandbox and minimum authority.",
        items: [
          ["EXECUTION TARGET", "Local, Managed SSH, and Edge Node", "One Agent can route different tasks to where resources live while retaining explicit target ownership."],
          ["NATIVE SANDBOX", "Native isolation on macOS, Linux, and Windows", "Workspace writes are enforced by the operating-system sandbox. Restricted mode fails closed when its required isolation backend is unavailable."],
          ["CAPABILITY LEASE", "Minimum authority, exact scope, revocable access", "Capability leases bind Principal, Agent, Context, Thread, Target, and operation set. Approval does not implicitly widen authority."],
          ["SECRETS & AUDIT", "Credentials stay out of Context; execution remains traceable", "Secrets stay in a separate Secret Store. Approvals, tool calls, and state transitions enter the event record."],
        ],
      },
    ],
    mechanismIndex: "04 / COGNITIVE APPLICATIONS",
    mechanismTitle: "Package how an Agent works\nas a cognitive application.",
    mechanismLead: "A Cognitive Application organizes domain capabilities. A Harness defines how an Evaluation runs. Yao gives the model and Runtime a shared cognitive evaluation language. Applications can replace the working method without bypassing Runtime transactions, authority, or execution boundaries.",
    mechanismAction: "View the Harness and Yao specifications",
    mechanisms: [
      ["APPLICATION", "Cognitive Application", "Organizes interfaces, domain resources, tools, and integrations for a specific field of work."],
      ["HARNESS", "Harness", "A versioned package defines the Evaluation Loop, domain contract, default Mind, and policy."],
      ["YAO", "Yao", "Typed cognitive evaluation programs support infer, eval, and par, with Runtime admission before execution."],
    ],
    systemIndex: "05 / DEFINITION",
    systemParts: ["Multiplexed Session I/O", "Frame · Session swap in / swap out", "Thread · Objective scheduling", "Capability-governed execution"],
    systemBridge: "beyond the single conversation loop",
    systemTitle: "A new operating\nmodel for agents.",
    systemLead: "Morphz is an open-source agent for long-running, concurrent work. In one continuously running Runtime, it unifies multiplexed Session I/O, Frame and Session working-set swapping, Thread and Objective scheduling, and capability-governed execution. Together, these mechanisms form its cognitive operating-system core.",
    evidenceIndex: "07 / LEARN MORE",
    evidenceTitle: "From product capabilities\nto implementation.",
    evidenceLead: "Read the product docs, technical article, and research paper, or inspect the source and run Morphz locally.",
    evidence: [
      ["ARTICLE", "Structured Context Evaluation", "An introduction to the Morphz computational model.", "blog"],
      ["PAPER", "Research paper", "Formal definitions, system boundaries, and results.", "paper"],
      ["SOURCE", "Source and tests", "The Apache-2.0 open-source implementation.", "source"],
      ["DOCS", "Product documentation", "Installation, configuration, concepts, and operation.", "docs"],
    ],
    runIndex: "06 / FIRST RUN",
    runTitle: "Run Morphz\non your own machine.",
    runLead: "Install a prebuilt release with one command, then connect a model service through Setup and start Morphz.",
    copyLabel: "ONE-COMMAND INSTALL",
    runPlatforms: "macOS · Linux",
    preview: "GITHUB RELEASE",
    previewBody: "The installer detects the platform, verifies the download, and installs to the user path. Native Windows installation is on the download page.",
    docsTitle: "Product documentation",
    docsCards: [
      ["Getting started", "Install Morphz and receive the first real model response.", "getting-started"],
      ["Core concepts", "Context, Sessions, Mind, and execution lifecycles.", "core-concepts"],
      ["Concurrency and goals", "Objectives, Threads, and durable scheduling.", "execution-lifecycle"],
      ["Execution and safety", "Sandboxing, authority, and Execution Targets.", "execution-targets"],
    ],
  },
} as const;

export function LandingPage({ locale }: { locale: Locale }) {
  const t = content[locale];
  const docs = sitePath(locale, "/docs");
  const blog = sitePath(locale, "/blog/from-chat-completion-to-structured-context-evaluation");
  const download = sitePath(locale, "/download");
  const evidenceHref = (kind: string) => {
    if (kind === "blog") return blog;
    if (kind === "paper") return sitePath(locale, "/paper");
    if (kind === "source") return SITE_LINKS.source;
    return docs;
  };

  return (
    <main className={`landing-shell landing-clean landing-clean--${locale}`}>
      <SiteHeader locale={locale} />

      <section className="home-hero">
        <div className="home-hero__copy">
          <p className="home-eyebrow">{t.eyebrow}</p>
          <h1 aria-label={t.title.join(" ")}>
            {t.title.map((line, index) => (
              <span className={index === 2 ? "home-hero__accent" : ""} key={line}>
                {line}{index < t.title.length - 1 ? " " : null}
              </span>
            ))}
          </h1>
          <p className="home-hero__lead">{t.lead}</p>
          <div className="home-actions">
            <a className="home-button home-button--primary" href="#capabilities">{t.idea}<span aria-hidden="true">↓</span></a>
            <Link className="home-button" href={download}>{t.start}<span aria-hidden="true">→</span></Link>
            <a className="home-link" href={SITE_LINKS.source}>{t.source}<span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <div className="home-hero__preview">
          <ContextEvaluationField locale={locale} />
        </div>
      </section>

      <section className="home-capabilities" id="capabilities">
        <header className="home-section-heading">
          <p>{t.capabilitiesLabel}</p>
          <h2>{t.capabilitiesTitle}</h2>
          <span>{t.capabilitiesLead}</span>
        </header>
        <div className="home-capability-domains">
          {t.features.map((feature, index) => (
            <article className={`home-capability-domain home-capability-domain--${feature.kind}`} key={feature.kind}>
              <header><span>0{index + 1}</span><small>{feature.index.split(" / ")[1]}</small></header>
              <div className="home-capability-domain__intro">
                <h3>{feature.title.replace("\n", " ")}</h3>
                <p>{feature.lead}</p>
              </div>
              <div className="home-capability-domain__signature" aria-hidden="true">
                {feature.kind === "maintenance" ? (
                  <svg viewBox="0 0 1000 120" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="capability-bracket-maintenance" x1="0" y1="0" x2="0" y2="120" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" />
                        <stop offset="0.3" stopColor="var(--accent)" stopOpacity="0.7" />
                        <stop offset="0.7" stopColor="var(--accent)" stopOpacity="0.7" />
                        <stop offset="1" stopColor="var(--accent)" stopOpacity="0.16" />
                      </linearGradient>
                    </defs>
                    <g className="home-capability-signature__echo">
                      <path d="M 342 14 C 304 36, 304 84, 342 106" />
                      <path d="M 658 14 C 696 36, 696 84, 658 106" />
                    </g>
                    <g className="home-capability-signature__main" fill="url(#capability-bracket-maintenance)">
                      <path d="M 328 10 C 292 34, 292 86, 328 110 C 332 112, 336 107, 332 102 C 310 80, 310 40, 332 18 C 336 13, 332 8, 328 10 Z" />
                      <path d="M 672 10 C 708 34, 708 86, 672 110 C 668 112, 664 107, 668 102 C 690 80, 690 40, 668 18 C 664 13, 668 8, 672 10 Z" />
                    </g>
                  </svg>
                ) : feature.kind === "concurrency" ? (
                  <svg className="signature-concurrency" viewBox="0 0 1000 120" preserveAspectRatio="none">
                    <g className="signature-concurrency__rays signature-concurrency__rays--left">
                      <path pathLength="1" d="M 500 60 C 454 60 444 28 384 28 H 132" />
                      <path pathLength="1" d="M 500 60 H 132" />
                      <path pathLength="1" d="M 500 60 C 454 60 444 92 384 92 H 132" />
                    </g>
                    <g className="signature-concurrency__rays signature-concurrency__rays--right">
                      <path pathLength="1" d="M 500 60 C 546 60 556 28 616 28 H 868" />
                      <path pathLength="1" d="M 500 60 H 868" />
                      <path pathLength="1" d="M 500 60 C 546 60 556 92 616 92 H 868" />
                    </g>
                    <circle className="signature-concurrency__halo" cx="500" cy="60" r="13" />
                    <circle className="signature-concurrency__center" cx="500" cy="60" r="5" />
                  </svg>
                ) : (
                  <div className="signature-execution-commands">
                    <span><small>$</small><b>pwd</b></span>
                    <span><small>$</small><b>ls -la</b></span>
                    <span><small>$</small><b>git status --short</b></span>
                    <span><small>$</small><b>rg --files</b></span>
                    <span><small>$</small><b>cargo test --workspace</b></span>
                    <span><small>$</small><b>git diff --stat</b></span>
                    <span><small>$</small><b>uname -a</b></span>
                    <span><small>$</small><b>whoami</b></span>
                    <span><small>$</small><b>df -h</b></span>
                    <span><small>$</small><b>ps aux</b></span>
                    <span><small>$</small><b>cargo fmt --all -- --check</b></span>
                    <span><small>$</small><b>cargo clippy --workspace</b></span>
                  </div>
                )}
                {feature.kind === "maintenance" ? <code>{feature.signature}</code> : null}
              </div>
              <div className="home-capability-domain__points">
                {feature.items.map(([label, title, description]) => (
                  <section key={label}><small>{label}</small><h4>{title}</h4><p>{description}</p></section>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="home-mechanism">
        <header className="home-mechanism__copy">
          <p>{t.mechanismIndex}</p>
          <h2>{t.mechanismTitle}</h2>
          <span>{t.mechanismLead}</span>
          <a className="home-link" href={SITE_LINKS.standards}>{t.mechanismAction}<b aria-hidden="true">↗</b></a>
        </header>
        <div className="home-mechanism__steps">
          {t.mechanisms.map(([label, title, description], index) => (
            <article key={label}>
              <span>0{index + 1}</span><small>{label}</small><h3>{title}</h3><p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-cognitive-os" aria-labelledby="cognitive-os-title">
        <p className="home-cognitive-os__index">{t.systemIndex}</p>
        <div className="home-cognitive-os__proof" aria-label={t.systemParts.join(", ")}>
          <div>
            {t.systemParts.map((part) => <strong key={part}>{part}</strong>)}
          </div>
        </div>
        <div className="home-cognitive-os__conclusion">
          <p>{t.systemBridge}</p>
          <h2 id="cognitive-os-title">{t.systemTitle}</h2>
          <span>{t.systemLead}</span>
        </div>
      </section>

      <section className="home-run">
        <div className="home-run__copy">
          <p>{t.runIndex}</p><h2>{t.runTitle}</h2><span>{t.runLead}</span>
          <Link className="home-button home-button--primary" href={download}>{t.start}<b aria-hidden="true">→</b></Link>
        </div>
        <div className="home-run__command" aria-label={t.copyLabel}>
          <header><span>{t.copyLabel}</span><small>{t.runPlatforms}</small></header>
          <pre><code>curl -fsSL https://github.com/morphz-ai/morphz/releases/latest/download/install.sh | sh</code></pre>
          <footer><strong>{t.preview}</strong><span>{t.previewBody}</span></footer>
        </div>
      </section>

      <section className="home-evidence">
        <header className="home-section-heading home-section-heading--compact">
          <p>{t.evidenceIndex}</p><h2>{t.evidenceTitle}</h2><span>{t.evidenceLead}</span>
        </header>
        <div className="home-evidence__links">
          {t.evidence.map(([label, title, description, kind]) => (
            <a href={evidenceHref(kind)} key={label}>
              <small>{label}</small><strong>{title}</strong><span>{description}</span><b aria-hidden="true">↗</b>
            </a>
          ))}
        </div>
      </section>

      <section className="home-docs">
        <h2>{t.docsTitle}</h2>
        <div>
          {t.docsCards.map(([title, description, slug]) => (
            <Link href={`${docs}/${slug}`} key={slug}>
              <h3>{title}</h3><p>{description}</p><span aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section>
      <SiteFooter locale={locale} />
    </main>
  );
}
