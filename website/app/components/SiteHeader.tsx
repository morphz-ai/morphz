import Link from "next/link";
import type { Locale } from "@/lib/docs";

const copy = {
  zh: {
    docs: "文档",
    concepts: "核心概念",
    operations: "运维与排障",
    github: "GitHub",
    language: "English",
  },
  en: {
    docs: "Docs",
    concepts: "Concepts",
    operations: "Operations",
    github: "GitHub",
    language: "中文",
  },
};

export function SiteHeader({ locale }: { locale: Locale }) {
  const t = copy[locale];
  const home = locale === "zh" ? "/" : "/en";
  const docs = locale === "zh" ? "/docs" : "/en/docs";
  const otherLanguage = locale === "zh" ? "/en" : "/";

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" href={home} aria-label="Morphz home">
          <span className="brand__mark" aria-hidden="true" />
          <span>Morphz</span>
          <small>Agent Runtime</small>
        </Link>
        <nav className="site-nav" aria-label="Primary navigation">
          <Link href={docs}>{t.docs}</Link>
          <Link href={`${docs}/core-concepts`}>{t.concepts}</Link>
          <Link href={`${docs}/operations`}>{t.operations}</Link>
          <a href="https://github.com/yaowenai/morphz">{t.github}</a>
        </nav>
        <Link className="language-switch" href={otherLanguage}>
          {t.language}
        </Link>
      </div>
    </header>
  );
}
