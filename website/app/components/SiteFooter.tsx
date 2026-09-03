import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { sitePath, SITE_LINKS } from "@/lib/site";

const copy = {
  zh: {
    statement: "让一个智能体在同一认知上下文中维护认知，并发推进多个目标。",
    maintained: "由新变元创造并维护。",
    technical: "产品与研究",
    ecosystem: "项目与团队",
    essay: "技术文章",
    paper: "研究论文",
    docs: "公开文档",
    download: "下载与运行",
    source: "GitHub 源码",
    company: "新变元",
  },
  en: {
    statement: "One Agent maintains cognition and advances concurrent objectives inside one Context.",
    maintained: "Created and maintained by Newvar.",
    technical: "Product and research",
    ecosystem: "Project and company",
    essay: "Technical essay",
    paper: "Research paper",
    docs: "Documentation",
    download: "Download and run",
    source: "GitHub source",
    company: "Newvar",
  },
} as const;

export function SiteFooter({ locale }: { locale: Locale }) {
  const t = copy[locale];
  return (
    <footer className="site-footer">
      <div className="site-footer__identity">
        <span className="brand brand--footer">
          <span className="brand__name">
            <span className="brand__paren" aria-hidden="true">(</span>
            <span>Morphz</span>
            <span className="brand__paren" aria-hidden="true">)</span>
          </span>
        </span>
        <p>{t.statement}</p>
        <small>{t.maintained}</small>
      </div>

      <div className="site-footer__index">
        <section>
          <span>{t.technical}</span>
          <div className="site-footer__links">
            <Link href={sitePath(locale, "/blog/from-chat-completion-to-structured-context-evaluation")}>{t.essay}</Link>
            <Link href={sitePath(locale, "/paper")}>{t.paper}</Link>
            <Link href={sitePath(locale, "/docs")}>{t.docs}</Link>
            <Link href={sitePath(locale, "/download")}>{t.download}</Link>
          </div>
        </section>
        <section>
          <span>{t.ecosystem}</span>
          <div className="site-footer__links">
            <a href={SITE_LINKS.source}>{t.source}<span aria-hidden="true">↗</span></a>
            <a href={SITE_LINKS.company}>{t.company}<span aria-hidden="true">↗</span></a>
          </div>
        </section>
      </div>
    </footer>
  );
}
