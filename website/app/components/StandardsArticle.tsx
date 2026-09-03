import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { renderMarkdown } from "@/lib/markdown";
import {
  standardBodyForWeb,
  standardFamilyLabels,
  standardFor,
  standardHref,
  standardsFor,
  standardsIndexHref,
  standardSourceHref,
  type StandardFamily,
  type StandardRecord,
} from "@/lib/standards";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

const families: StandardFamily[] = ["context", "trajectory", "applications", "exchange"];

export function StandardsArticle({ locale, standard }: { locale: Locale; standard: StandardRecord }) {
  const { html, headings } = renderMarkdown(standardBodyForWeb(standard));
  const otherLocale = locale === "zh" ? "en" : "zh";
  const otherStandard = standardFor(otherLocale, standard.slug);
  const otherLanguageHref = otherStandard
    ? standardHref(otherLocale, standard.slug)
    : standardsIndexHref(otherLocale);

  return (
    <main className="content-site standards-site standards-reader-site">
      <SiteHeader locale={locale} otherLanguageHref={otherLanguageHref} />
      <div className="standards-reader">
        <aside className="standards-reader__sidebar" aria-label={locale === "zh" ? "规范导航" : "Standards navigation"}>
          <Link className="standards-reader__home" href={standardsIndexHref(locale)}>
            <span aria-hidden="true">←</span> {locale === "zh" ? "Morphz 开放规范" : "Morphz Open Standards"}
          </Link>
          {families.map((family) => {
            const standards = standardsFor(locale).filter((item) => item.family === family);
            return (
              <section key={family}>
                <h2>{standardFamilyLabels[locale][family]}</h2>
                {standards.map((item) => (
                  <Link
                    className={item.slug === standard.slug ? "is-active" : ""}
                    href={standardHref(locale, item.slug)}
                    key={item.slug}
                  >
                    {item.title}
                  </Link>
                ))}
              </section>
            );
          })}
        </aside>

        <article className="standards-article">
          <header className="standards-article__header">
            <p>{standardFamilyLabels[locale][standard.family]} · Draft</p>
            <h1>{standard.title}</h1>
            <div>
              <span>{locale === "zh" ? "规范正文 · 与源码同步" : "Specification text · synchronized with source"}</span>
              <a href={standardSourceHref(standard)}>{locale === "zh" ? "在 GitHub 查看源码" : "View source on GitHub"} <span aria-hidden="true">↗</span></a>
            </div>
          </header>
          <div className="doc-prose standards-prose" dangerouslySetInnerHTML={{ __html: html }} />
          <footer className="standards-article__footer">
            <strong>{locale === "zh" ? "规范正文与源码保持一致。" : "This text stays aligned with its repository source."}</strong>
            <Link href={standardsIndexHref(locale)}>{locale === "zh" ? "继续浏览规范体系" : "Continue exploring the standards"} <span aria-hidden="true">→</span></Link>
          </footer>
        </article>

        <aside className="standards-reader__toc" aria-label={locale === "zh" ? "本页目录" : "On this page"}>
          <strong>{locale === "zh" ? "本页内容" : "On this page"}</strong>
          {headings.map((heading) => (
            <a className={heading.level === 3 ? "is-nested" : ""} href={`#${heading.id}`} key={heading.id}>{heading.text}</a>
          ))}
        </aside>
      </div>
      <SiteFooter locale={locale} />
    </main>
  );
}
