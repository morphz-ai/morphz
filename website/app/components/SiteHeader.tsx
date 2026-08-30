import Link from "next/link";
import type { Locale } from "@/lib/docs";

const copy = {
  zh: {
    docs: "文档",
    blog: "文章",
    concepts: "核心概念",
    operations: "运维与排障",
    github: "GitHub",
    language: "English",
    runtime: "S 表达式认知机",
    preview: "开发者预览",
    home: "Morphz 首页",
    navigation: "主要导航",
  },
  en: {
    docs: "Docs",
    blog: "Notes",
    concepts: "Concepts",
    operations: "Operations",
    github: "GitHub",
    language: "中文",
    runtime: "S-Expression Cognitive Machine",
    preview: "Developer Preview",
    home: "Morphz home",
    navigation: "Primary navigation",
  },
};

export function SiteHeader({ locale, otherLanguageHref, immersive = false }: { locale: Locale; otherLanguageHref?: string; immersive?: boolean }) {
  const t = copy[locale];
  const home = locale === "zh" ? "/" : "/en";
  const docs = locale === "zh" ? "/docs" : "/en/docs";
  const blog = locale === "zh" ? "/blog" : "/en/blog";
  const otherLanguage = otherLanguageHref ?? (locale === "zh" ? "/en" : "/");

  return (
    <header className={`site-header${immersive ? " site-header--immersive" : ""}`}>
      <div className="site-header__inner">
        <Link className="brand" href={home} aria-label={t.home}>
          <span className="brand__name">
            <span className="brand__paren" aria-hidden="true">(</span>
            <span>Morphz</span>
            <span className="brand__paren" aria-hidden="true">)</span>
          </span>
          <small>{t.runtime}</small>
        </Link>
        <nav className="site-nav" aria-label={t.navigation}>
          <Link href={blog}>{t.blog}</Link>
          <Link href={docs}>{t.docs}</Link>
          <Link href={`${docs}/core-concepts`}>{t.concepts}</Link>
          <Link href={`${docs}/operations`}>{t.operations}</Link>
          <a href="https://github.com/yaowenai/morphz">{t.github}</a>
        </nav>
        <div className="site-header__meta">
          <span>{t.preview}</span>
          <Link className="language-switch" href={otherLanguage}>{t.language}</Link>
        </div>
      </div>
    </header>
  );
}
