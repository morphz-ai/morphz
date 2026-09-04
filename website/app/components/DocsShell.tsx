import Link from "next/link";
import type { ReactNode } from "react";
import { docHref, docsFor, otherLocaleHref, sectionLabels, type DocRecord, type DocSection, type Locale } from "@/lib/docs";
import { renderMarkdown } from "@/lib/markdown";
import { SITE_LINKS } from "@/lib/site";
import { DocSearch } from "./DocSearch";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const sections: DocSection[] = ["start", "concepts", "guides", "operations", "reference"];

export function DocsShell({ locale, activeSlug, children, toc }: { locale: Locale; activeSlug?: string; children: ReactNode; toc?: { id: string; text: string; level: number }[] }) {
  const docs = docsFor(locale);
  const compactDocs = docs.map(({ slug, title, description, section }) => ({ slug, title, description, section }));
  return (
    <main className="docs-site">
      <SiteHeader locale={locale} otherLanguageHref={otherLocaleHref(locale, activeSlug)} />
      <div className="docs-toolbar">
        <Link className="docs-toolbar__home" href={docHref(locale)}>{locale === "zh" ? "Morphz 文档" : "Morphz Docs"}</Link>
        <DocSearch locale={locale} docs={compactDocs} />
      </div>
      <div className="docs-layout">
        <aside className="docs-sidebar" aria-label={locale === "zh" ? "文档导航" : "Documentation navigation"}>
          {sections.map((section) => {
            const sectionDocs = docs.filter((doc) => doc.section === section);
            if (!sectionDocs.length) return null;
            return <section key={section}><h2>{sectionLabels[locale][section]}</h2>{sectionDocs.map((doc) => <Link className={doc.slug === activeSlug ? "is-active" : ""} href={docHref(locale, doc.slug)} key={doc.slug}>{doc.title}</Link>)}</section>;
          })}
        </aside>
        <div className="docs-main">{children}</div>
        <aside className="docs-toc" aria-label={locale === "zh" ? "本页目录" : "On this page"}>
          {toc?.length ? <><strong>{locale === "zh" ? "本页内容" : "On this page"}</strong>{toc.map((heading) => <a className={heading.level === 3 ? "is-nested" : ""} href={`#${heading.id}`} key={heading.id}>{heading.text}</a>)}</> : null}
        </aside>
      </div>
      <SiteFooter locale={locale} />
    </main>
  );
}

export function DocsIndex({ locale }: { locale: Locale }) {
  const docs = docsFor(locale);
  const title = locale === "zh" ? "从真实任务开始理解 Morphz" : "Learn Morphz through real tasks";
  const lead = locale === "zh" ? "从第一次模型响应开始，逐步了解共享认知、并发调度、认知应用与真实执行边界。" : "Start with a real model response, then explore shared cognition, concurrent scheduling, Cognitive Applications, and physical execution boundaries.";
  return (
    <DocsShell locale={locale}>
      <div className="docs-index">
        <p className="eyebrow">{locale === "zh" ? "产品文档" : "DOCUMENTATION"}</p><h1>{title}</h1><p className="docs-index__lead">{lead}</p>
        <div className="docs-index__start"><div><span>01</span><h2>{locale === "zh" ? "第一次运行" : "First run"}</h2><p>{locale === "zh" ? "一条命令安装 Morphz，完成设置向导，并验证模型真的可以响应。" : "Install Morphz with one command, complete Setup, and verify that a model can actually respond."}</p></div><Link className="button button--primary" href={docHref(locale, "getting-started")}>{locale === "zh" ? "开始" : "Start"} →</Link></div>
        {sections.map((section) => {
          const sectionDocs = docs.filter((doc) => doc.section === section);
          if (!sectionDocs.length) return null;
          return <section className="docs-index__section" key={section}><h2>{sectionLabels[locale][section]}</h2><div className="docs-index__grid">{sectionDocs.map((doc) => <Link href={docHref(locale, doc.slug)} key={doc.slug}>{doc.status === "preview" ? <span className="doc-status doc-status--preview">{locale === "zh" ? "预览" : "Preview"}</span> : null}<h3>{doc.title}</h3><p>{doc.description}</p></Link>)}</div></section>;
        })}
      </div>
    </DocsShell>
  );
}

export function DocArticle({ locale, doc }: { locale: Locale; doc: DocRecord }) {
  const { html, headings } = renderMarkdown(doc.body);
  return (
    <DocsShell locale={locale} activeSlug={doc.slug} toc={headings}>
      <article className="doc-article">
        <div className="doc-article__meta"><span>{sectionLabels[locale][doc.section]}</span>{doc.status === "preview" ? <span className="status-badge status-badge--preview">{locale === "zh" ? "预览" : "Preview"}</span> : null}</div>
        <h1>{doc.title}</h1><p className="doc-article__description">{doc.description}</p>
        <div className="doc-prose" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="doc-article__footer"><strong>{locale === "zh" ? "发现文档与实际行为不一致？" : "Found a mismatch between docs and behavior?"}</strong><a href={SITE_LINKS.issues}>{locale === "zh" ? "提交问题" : "Open an issue"} →</a></div>
      </article>
    </DocsShell>
  );
}
