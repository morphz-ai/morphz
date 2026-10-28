import Link from "next/link";
import { notFound } from "next/navigation";
import type { Locale } from "@/lib/docs";
import { onlineExperiencePublished } from "@/lib/public-experience";
import { productSurfaces } from "@/lib/product-surfaces";
import { sitePath } from "@/lib/site";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const copy = {
  zh: {
    eyebrow: "MORPHZ / 产品",
    title: "与 Morphz 对话。\n让自己的 Agent 工作。",
    lead: "Morphz 是已经可以运行的产品。官方人格与用户 Agent 是两种不同的使用方式：它们使用同一技术，身份、认知和数据边界却彼此独立。在线入口按实际开放状态提供。",
    publicNumber: "01 / 官方人格",
    publicTitle: "与 Morphz 对话",
    publicBody: "这是一个面向所有访客的官方人格。不同人的会话连接到同一个 Morphz，它可以在共同经历中形成共享认识。因此，这里的对话不应被当作私人空间。",
    publicAction: "前往官方 Morphz",
    publicUnavailable: "官方人格站尚未对外开放",
    publicBoundary: "一个官方人格 · 共享 Mind",
    privateNumber: "02 / 用户 Agent",
    privateTitle: "我的 Agent",
    privateBody: "在独立的工作空间里与自己的 Agent 协作。你的身份、会话和工作数据不会并入官方 Morphz 的共享 Mind。完整 Web 工作台正在接入云端 Agent Cell。",
    privateAction: "进入我的 Agent",
    privatePreviewAction: "打开受限预览",
    privatePreviewNote: "仅限已授权账号；这里不是完整的 Web 工作台。",
    privateUnavailable: "完整 Web 工作台尚未开放",
    privateBoundary: "独立 Agent · 独立数据边界",
    boundaryLabel: "清晰的边界",
    boundaryTitle: "同一个 Morphz，\n不等于同一个 Agent。",
    boundaryBody: "Morphz 是产品、开源 Runtime 和技术体系的名字。官方人格也是 Morphz；“我的 Agent”则是用户自己的独立实例。我们不会用一个登录态或一条链接，暗示两者共享身份或私有数据。",
    buildLabel: "03 / 自己运行",
    buildTitle: "从源码启动 Morphz",
    buildBody: "如果你想先了解技术，可以在自己的机器上安装并运行开源 Runtime。官网的论文、文档和开放规范也在这里。",
    buildAction: "下载与运行",
    note: "Morphz 产品可以通过开源 Runtime 运行；在线服务各自按部署和开放状态提供入口。",
  },
  en: {
    eyebrow: "MORPHZ / PRODUCT",
    title: "Talk to Morphz.\nPut your own Agent to work.",
    lead: "Morphz is a working product. The official persona and your own Agent are two ways to use it: they share the technology, but keep separate identities, cognition, and data. Online links reflect what is actually open.",
    publicNumber: "01 / OFFICIAL PERSONA",
    publicTitle: "Talk to Morphz",
    publicBody: "The official persona meets every visitor. Its sessions connect to one Morphz, which can form shared understanding from common experience. Do not treat this as a private space.",
    publicAction: "Meet the official Morphz",
    publicUnavailable: "The official persona site is not publicly open yet",
    publicBoundary: "One official persona · shared Mind",
    privateNumber: "02 / YOUR AGENT",
    privateTitle: "My Agent",
    privateBody: "Work with your own Agent in an independent workspace. Your identity, sessions, and work data do not become part of the official Morphz's shared Mind. The full Web workspace is being connected to cloud Agent Cells.",
    privateAction: "Open My Agent",
    privatePreviewAction: "Open restricted preview",
    privatePreviewNote: "Authorized accounts only; this is not the full Web workspace.",
    privateUnavailable: "The full Web workspace is not open yet",
    privateBoundary: "Independent Agent · separate data boundary",
    boundaryLabel: "THE BOUNDARY",
    boundaryTitle: "The same Morphz technology\nis not the same Agent.",
    boundaryBody: "Morphz names the product, open-source Runtime, and technology. The official persona is also Morphz; My Agent is your own independent instance. A shared login or a link must not imply shared identity or private data.",
    buildLabel: "03 / RUN IT YOURSELF",
    buildTitle: "Run Morphz from source",
    buildBody: "To explore the technology first, install the open-source Runtime on your own machine. The paper, documentation, and open standards are here too.",
    buildAction: "Download and run",
    note: "You can run Morphz through the open-source Runtime; online services link only to available deployments.",
  },
} as const;

export function ExperiencePage({ locale }: { locale: Locale }) {
  if (!onlineExperiencePublished()) notFound();
  const t = copy[locale];
  const surfaces = productSurfaces();
  return (
    <main className="experience-site">
      <SiteHeader locale={locale} />
      <div className="experience-page">
        <header className="experience-hero">
          <p>{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <span>{t.lead}</span>
        </header>
        <div className="experience-cards">
          <article className="experience-card experience-card--public">
            <span className="experience-card__number">{t.publicNumber}</span>
            <div className="experience-card__glyph" aria-hidden="true"><i /><i /><i /></div>
            <h2>{t.publicTitle}</h2>
            <p>{t.publicBody}</p>
            <small>{t.publicBoundary}</small>
            {surfaces.officialPersona ? <a className="experience-card__action" href={surfaces.officialPersona}>{t.publicAction}<b aria-hidden="true">↗</b></a> : <span className="experience-card__status">{t.publicUnavailable}</span>}
          </article>
          <article className="experience-card experience-card--private">
            <span className="experience-card__number">{t.privateNumber}</span>
            <div className="experience-card__glyph experience-card__glyph--private" aria-hidden="true"><i /><i /><i /></div>
            <h2>{t.privateTitle}</h2>
            <p>{t.privateBody}</p>
            <small>{t.privateBoundary}</small>
            {surfaces.userWeb ? <a className="experience-card__action" href={surfaces.userWeb}>{t.privateAction}<b aria-hidden="true">↗</b></a> : surfaces.userPreview ? <><a className="experience-card__action" href={surfaces.userPreview}>{t.privatePreviewAction}<b aria-hidden="true">↗</b></a><span className="experience-card__preview-note">{t.privatePreviewNote}</span></> : <span className="experience-card__status">{t.privateUnavailable}</span>}
          </article>
        </div>
        <section className="experience-boundary">
          <p>{t.boundaryLabel}</p>
          <h2>{t.boundaryTitle}</h2>
          <span>{t.boundaryBody}</span>
        </section>
        <section className="experience-open">
          <div><p>{t.buildLabel}</p><h2>{t.buildTitle}</h2><span>{t.buildBody}</span></div>
          <Link href={sitePath(locale, "/download")}>{t.buildAction}<b aria-hidden="true">→</b></Link>
        </section>
        <p className="experience-note">{t.note}</p>
      </div>
      <SiteFooter locale={locale} />
    </main>
  );
}
