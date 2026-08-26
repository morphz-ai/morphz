import Link from "next/link";
import type { BlogRecord } from "@/lib/blog";
import { blogHref, blogsFor, otherBlogLocaleHref } from "@/lib/blog";
import type { Locale } from "@/lib/docs";
import { renderMarkdown } from "@/lib/markdown";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const copy = {
  zh: {
    eyebrow: "MORPHZ · 技术文章",
    title: "代理认知与运行时的技术说明",
    lead: "记录 Morphz 的设计原理、实现边界、实验方法与开放问题。",
    first: "首篇技术文章",
    read: "阅读全文",
    back: "返回全部文章",
    contents: "本文内容",
    minute: "分钟阅读",
    author: "作者",
  },
  en: {
    eyebrow: "MORPHZ · TECHNICAL NOTES",
    title: "Technical notes on agent cognition and runtimes",
    lead: "Design principles, implementation boundaries, experimental methods, and open questions from the Morphz project.",
    first: "FIRST TECHNICAL NOTE",
    read: "Read the essay",
    back: "Back to all essays",
    contents: "IN THIS ESSAY",
    minute: "min read",
    author: "By",
  },
} as const;

function formatDate(locale: Locale, published: string): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${published}T00:00:00Z`));
}

function readingMinutes(post: BlogRecord): number {
  if (post.locale === "zh") {
    return Math.max(1, Math.ceil(post.body.replace(/\s+/g, "").length / 500));
  }
  return Math.max(1, Math.ceil(post.body.trim().split(/\s+/).length / 220));
}

export function BlogIndex({ locale }: { locale: Locale }) {
  const t = copy[locale];
  const posts = blogsFor(locale);
  return (
    <main>
      <SiteHeader locale={locale} otherLanguageHref={otherBlogLocaleHref(locale)} />
      <section className="blog-index">
        <header className="blog-index__header">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>{t.title}</h1>
          <p>{t.lead}</p>
        </header>
        <div className="blog-index__list">
          {posts.map((post, index) => (
            <Link className="blog-card" href={blogHref(locale, post.slug)} key={post.slug}>
              <div className="blog-card__meta">
                <span>{index === posts.length - 1 ? t.first : post.category}</span>
                <time dateTime={post.published}>{formatDate(locale, post.published)}</time>
              </div>
              <h2>{post.title}</h2>
              <p>{post.description}</p>
              <span className="blog-card__action">{t.read} <span aria-hidden="true">→</span></span>
            </Link>
          ))}
        </div>
      </section>
      <SiteFooter locale={locale} />
    </main>
  );
}

export function BlogArticle({ locale, post }: { locale: Locale; post: BlogRecord }) {
  const t = copy[locale];
  const { html, headings } = renderMarkdown(post.body);
  return (
    <main>
      <SiteHeader locale={locale} otherLanguageHref={otherBlogLocaleHref(locale, post.slug)} />
      <article className="blog-article">
        <header className="blog-article__header">
          <Link className="blog-article__back" href={blogHref(locale)}>← {t.back}</Link>
          <p className="eyebrow">{post.category}</p>
          <h1>{post.title}</h1>
          <p className="blog-article__description">{post.description}</p>
          <div className="blog-article__meta">
            <span>{t.author} {post.author}</span>
            <time dateTime={post.published}>{formatDate(locale, post.published)}</time>
            <span>{readingMinutes(post)} {t.minute}</span>
          </div>
        </header>
        <div className="blog-article__layout">
          <nav className="blog-article__toc" aria-label={t.contents}>
            <strong>{t.contents}</strong>
            {headings.filter(({ level }) => level === 2).map((heading) => (
              <a href={`#${heading.id}`} key={heading.id}>{heading.text}</a>
            ))}
          </nav>
          <div className="doc-prose blog-prose" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </article>
      <SiteFooter locale={locale} />
    </main>
  );
}
