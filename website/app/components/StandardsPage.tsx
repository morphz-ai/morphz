import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { sitePath, SITE_LINKS } from "@/lib/site";
import { standardHref } from "@/lib/standards";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const copy = {
  zh: {
    eyebrow: "开放技术基础 · 规范草案",
    title: ["为智能体运行，", "建立共同语言。"],
    lead: "Morphz 开放规范为持久认知、因果经验、可编程认知实践与认知交换定义实现无关的公共语义。Morphz Runtime 是这些规范的官方参考实现。",
    explore: "探索规范体系",
    source: "查看规范源码",
    status: [["状态", "Draft"], ["规范语言", "English"], ["维护", "Newvar"]],
    stack: [
      ["01", "STRUCTURED CONTEXT", "持久认知与事务"],
      ["02", "AGENT TRAJECTORY", "因果经验与证据"],
      ["03", "COGNITIVE PROGRAMS", "认知实践与求值"],
      ["04", "MIND FRAME EXCHANGE", "认知交换与采用"],
    ],
    thesisLabel: "共同边界",
    thesis: "模型可以更换，运行时可以不同，智能体仍应带着可验证的认知、因果与权责继续工作。",
    thesisBody: "规范把实现细节之上的身份、状态、事务、证据与能力边界固定下来，让不同系统能够讨论同一种智能体运行语义。",
    familiesLabel: "规范体系",
    familiesTitle: "从认知状态，到可移植的智能体经验。",
    families: [
      {
        index: "SC / 01",
        title: "Structured Context",
        description: "定义智能体如何拥有带身份和版本的认知上下文，以及观察、认知、会话、事务与运行时事实之间的权责边界。",
        links: [
          ["结构化上下文宪章", "structured_context_constitution_v1.md"],
          ["结构化上下文规范", "morphz_structured_context_specification_v1.md"],
          ["一致性测试套件", "morphz_conformance_suite_v1.md"],
        ],
      },
      {
        index: "AT / 02",
        title: "Agent Trajectory",
        description: "把智能体经验表达为带因果、权威、结果和验证证据的状态转换记录，使审计、评测、训练与跨实现交换拥有共同对象。",
        links: [
          ["Agent Trajectory 规范", "morphz_agent_trajectory_specification_v0_1.md"],
          ["参考实现验证", "morphz_agent_trajectory_reference_implementation_verification_v0_1.md"],
        ],
      },
      {
        index: "CA / 03",
        title: "Cognitive Applications",
        description: "以 Harness、HNS 与 Yao 封装可复用的认知实践。求值循环、类型、能力契约与持久执行可以成为可审查、可分发的程序。",
        links: [
          ["Harness 规范", "morphz_harness_specification_v0_1.md"],
          ["HNS 包格式", "hns_package_format_specification_v0_1.md"],
          ["Yao 核心语言", "yao_core_language_specification_v0_1.md"],
          ["Yao 求值语义", "yao_evaluation_semantics_v0_1.md"],
        ],
      },
      {
        index: "MFX / 04",
        title: "Mind Frame Exchange",
        description: "定义不同智能体如何交换选定认知及其来源、血缘与权利信息，并由接收方在自己的权威边界内完成验证和采用。",
        links: [["MFX 协议", "morphz_mind_frame_exchange_protocol_v0_1.md"]],
      },
    ],
    directionsLabel: "规范面向的未来",
    directionsTitle: "智能体系统开始拥有可组合的边界。",
    directions: [
      ["01", "跨实现延续认知", "模型、进程或运行时发生变化时，稳定身份、版本与事务语义使认知连续性可以被验证。"],
      ["02", "把经验带出日志", "轨迹保留目标、行动、证据、权限与结果之间的因果结构，服务于审计、评测和训练。"],
      ["03", "分发认知实践", "领域方法可以被打包为带类型和能力边界的认知应用，运行在已有智能体之上。"],
      ["04", "交换认知而不合并身份", "智能体选择性分享认知，接收方保留自己的判断、权限与最终采用权。"],
    ],
    maturityLabel: "当前状态",
    maturityTitle: "Draft 是公开协作的起点。",
    maturityBody: "当前规范以草案形式发布，英文文本是规范性基准。参考实现、契约测试和验证记录持续提供工程证据；兼容性声明将在治理流程与一致性要求成熟后开放。",
    workspace: "进入规范工作区",
    governance: "阅读治理规则",
  },
  en: {
    eyebrow: "OPEN TECHNICAL FOUNDATION · DRAFT",
    title: ["A common language", "for agent runtime."],
    lead: "Morphz Standards define implementation-independent semantics for durable cognition, causal experience, programmable cognitive practice, and cognitive exchange. Morphz Runtime is the official reference implementation.",
    explore: "Explore the standards",
    source: "View standards source",
    status: [["Status", "Draft"], ["Canonical", "English"], ["Steward", "Newvar"]],
    stack: [
      ["01", "STRUCTURED CONTEXT", "Durable cognition and transactions"],
      ["02", "AGENT TRAJECTORY", "Causal experience and evidence"],
      ["03", "COGNITIVE PROGRAMS", "Practice and evaluation"],
      ["04", "MIND FRAME EXCHANGE", "Cognitive exchange and adoption"],
    ],
    thesisLabel: "Shared boundary",
    thesis: "Models may change and runtimes may differ. An agent should still carry verifiable cognition, causality, and authority forward.",
    thesisBody: "The standards hold identity, state, transactions, evidence, and capability boundaries above implementation details, giving different systems a common agent-runtime semantics.",
    familiesLabel: "Standards families",
    familiesTitle: "From cognitive state to portable agent experience.",
    families: [
      {
        index: "SC / 01",
        title: "Structured Context",
        description: "Defines how an agent owns identity-bearing, versioned cognitive Context and separates authority across observations, cognition, Sessions, transactions, and Runtime facts.",
        links: [
          ["Structured Context Constitution", "structured_context_constitution_v1.md"],
          ["Structured Context Specification", "morphz_structured_context_specification_v1.md"],
          ["Conformance Suite", "morphz_conformance_suite_v1.md"],
        ],
      },
      {
        index: "AT / 02",
        title: "Agent Trajectory",
        description: "Represents agent experience as causal state transitions with authority, outcomes, and verification evidence—a shared object for audit, evaluation, training, and exchange.",
        links: [
          ["Agent Trajectory Specification", "morphz_agent_trajectory_specification_v0_1.md"],
          ["Reference Implementation Verification", "morphz_agent_trajectory_reference_implementation_verification_v0_1.md"],
        ],
      },
      {
        index: "CA / 03",
        title: "Cognitive Applications",
        description: "Packages reusable cognitive practice through Harness, HNS, and Yao. Evaluation loops, types, capability contracts, and durable execution become reviewable programs.",
        links: [
          ["Harness Specification", "morphz_harness_specification_v0_1.md"],
          ["HNS Package Format", "hns_package_format_specification_v0_1.md"],
          ["Yao Core Language", "yao_core_language_specification_v0_1.md"],
          ["Yao Evaluation Semantics", "yao_evaluation_semantics_v0_1.md"],
        ],
      },
      {
        index: "MFX / 04",
        title: "Mind Frame Exchange",
        description: "Defines how independent agents exchange selected cognition with provenance, lineage, and rights information while the receiver retains authority over verification and adoption.",
        links: [["MFX Protocol", "morphz_mind_frame_exchange_protocol_v0_1.md"]],
      },
    ],
    directionsLabel: "The future these standards address",
    directionsTitle: "Agent systems gain composable boundaries.",
    directions: [
      ["01", "Carry cognition across implementations", "Stable identity, versions, and transactions make continuity verifiable when models, processes, or runtimes change."],
      ["02", "Move experience beyond logs", "Trajectories preserve causal structure across objectives, actions, evidence, authority, and outcomes for audit, evaluation, and training."],
      ["03", "Distribute cognitive practice", "Domain methods can ship as typed, capability-bounded Cognitive Applications that run on an existing Agent."],
      ["04", "Exchange cognition without merging identity", "Agents share cognition selectively while receivers retain their own judgment, capabilities, and final authority to adopt."],
    ],
    maturityLabel: "Current status",
    maturityTitle: "Draft begins the public collaboration.",
    maturityBody: "The specifications are published as Drafts, with English as the canonical normative text. Reference implementations, contract tests, and verification records provide continuing engineering evidence. Compatibility claims will open through the governance process as conformance requirements mature.",
    workspace: "Enter the standards workspace",
    governance: "Read the governance model",
  },
} as const;

export function StandardsPage({ locale }: { locale: Locale }) {
  const t = copy[locale];
  const otherLocale = locale === "zh" ? "en" : "zh";
  const governanceHref = locale === "zh"
    ? "https://github.com/morphz-ai/morphz/blob/main/GOVERNANCE.zh-CN.md"
    : "https://github.com/morphz-ai/morphz/blob/main/GOVERNANCE.md";

  return (
    <main className="content-site standards-site">
      <SiteHeader locale={locale} otherLanguageHref={sitePath(otherLocale, "/standards")} />
      <article className={`standards-page standards-page--${locale}`}>
        <header className="standards-hero">
          <div className="standards-hero__copy">
            <p className="eyebrow">{t.eyebrow}</p>
            <h1>{t.title.map((line) => <span key={line}>{line}</span>)}</h1>
            <p className="standards-hero__lead">{t.lead}</p>
            <div className="standards-hero__actions">
              <a className="button button--primary" href="#families">{t.explore} <span aria-hidden="true">↓</span></a>
              <a className="button" href={SITE_LINKS.standards}>{t.source} <span aria-hidden="true">↗</span></a>
            </div>
            <dl className="standards-status">
              {t.status.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          </div>
          <div className="standards-stack" aria-label={t.familiesLabel}>
            {t.stack.map(([index, name, description]) => (
              <article key={index}>
                <span>{index}</span>
                <div><strong>{name}</strong><small>{description}</small></div>
              </article>
            ))}
          </div>
        </header>

        <section className="standards-thesis">
          <p>{t.thesisLabel}</p>
          <div><blockquote>{t.thesis}</blockquote><span>{t.thesisBody}</span></div>
        </section>

        <section className="standards-families" id="families">
          <header><p>{t.familiesLabel}</p><h2>{t.familiesTitle}</h2></header>
          <div className="standards-family-grid">
            {t.families.map((family) => (
              <article key={family.index}>
                <span className="standards-family__index">{family.index}</span>
                <h3>{family.title}</h3>
                <p>{family.description}</p>
                <div className="standards-family__links">
                  {family.links.map(([label, filename]) => (
                    <Link href={standardHref(locale, filename.replace(/\.md$/, ""))} key={filename}>{label}<span aria-hidden="true">→</span></Link>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="standards-directions">
          <header><p>{t.directionsLabel}</p><h2>{t.directionsTitle}</h2></header>
          <div className="standards-direction-grid">
            {t.directions.map(([index, title, description]) => (
              <article key={index}><span>{index}</span><h3>{title}</h3><p>{description}</p></article>
            ))}
          </div>
        </section>

        <section className="standards-maturity">
          <div><span>{t.maturityLabel}</span><h2>{t.maturityTitle}</h2></div>
          <div><p>{t.maturityBody}</p><nav><a href={SITE_LINKS.standards}>{t.workspace} <span aria-hidden="true">↗</span></a><a href={governanceHref}>{t.governance} <span aria-hidden="true">↗</span></a></nav></div>
        </section>
      </article>
      <SiteFooter locale={locale} />
    </main>
  );
}
