import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { sitePath, SITE_LINKS } from "@/lib/site";
import { ThemeToggle } from "./ThemeToggle";

const copy = {
  zh: {
    essay: "文章",
    paper: "论文",
    standards: "规范",
    docs: "文档",
    download: "下载",
    source: "源码",
    language: "切换到英文",
    languageShort: "EN",
    home: "Morphz 首页",
    navigation: "主要导航",
    menu: "导航",
    theme: "切换明暗主题",
  },
  en: {
    essay: "Essay",
    paper: "Paper",
    standards: "Standards",
    docs: "Docs",
    download: "Download",
    source: "Source",
    language: "Switch to Chinese",
    languageShort: "CN",
    home: "Morphz home",
    navigation: "Primary navigation",
    menu: "Menu",
    theme: "Toggle color theme",
  },
} as const;

export function SiteHeader({
  locale,
  otherLanguageHref,
  immersive = false,
}: {
  locale: Locale;
  otherLanguageHref?: string;
  immersive?: boolean;
}) {
  const t = copy[locale];
  const home = sitePath(locale, "/");
  const essay = sitePath(locale, "/blog/from-chat-completion-to-structured-context-evaluation");
  const paper = sitePath(locale, "/paper");
  const standards = sitePath(locale, "/standards");
  const docs = sitePath(locale, "/docs");
  const download = sitePath(locale, "/download");
  const otherLanguage = otherLanguageHref ?? (locale === "zh" ? "/en" : "/");
  const navigation = [
    [essay, t.essay],
    [paper, t.paper],
    [standards, t.standards],
    [docs, t.docs],
    [download, t.download],
  ] as const;

  return (
    <header className={`site-header${immersive ? " site-header--immersive" : ""}`}>
      <div className="site-header__inner">
        <Link className="brand" href={home} aria-label={t.home}>
          <span className="brand__name">
            <span className="brand__paren" aria-hidden="true">(</span>
            <span>Morphz</span>
            <span className="brand__paren" aria-hidden="true">)</span>
          </span>
        </Link>

        <nav className="site-nav" aria-label={t.navigation}>
          {navigation.map(([href, label]) => <Link href={href} key={href}>{label}</Link>)}
          <a href={SITE_LINKS.source}>{t.source}</a>
        </nav>

        <details className="site-menu">
          <summary aria-label={t.menu}>
            <span className="site-menu__label">{t.menu}</span>
            <span className="site-menu__icon" aria-hidden="true"><i /><i /><i /></span>
          </summary>
          <nav className="site-menu__panel" aria-label={t.navigation}>
            {navigation.map(([href, label]) => <Link href={href} key={href}>{label}</Link>)}
            <a href={SITE_LINKS.source}>{t.source}<span aria-hidden="true">↗</span></a>
          </nav>
        </details>

        <div className="site-header__meta">
          <ThemeToggle label={t.theme} />
          <Link className="language-switch" href={otherLanguage} aria-label={t.language}>{t.languageShort}</Link>
        </div>
      </div>
    </header>
  );
}
