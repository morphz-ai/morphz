import Link from "next/link";
import type { Locale } from "@/lib/docs";
import { sitePath, SITE_LINKS } from "@/lib/site";

const copy = {
  zh: {
    essay: "文章",
    paper: "论文",
    docs: "文档",
    download: "下载",
    source: "源码",
    live: "实时人格",
    language: "English",
    runtime: "S 表达式认知机",
    home: "Morphz 首页",
    navigation: "主要导航",
    menu: "导航",
  },
  en: {
    essay: "Essay",
    paper: "Paper",
    docs: "Docs",
    download: "Download",
    source: "Source",
    live: "Live agent",
    language: "中文",
    runtime: "S-Expression Cognitive Machine",
    home: "Morphz home",
    navigation: "Primary navigation",
    menu: "Menu",
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
  const docs = sitePath(locale, "/docs");
  const download = sitePath(locale, "/download");
  const otherLanguage = otherLanguageHref ?? (locale === "zh" ? "/en" : "/");
  const navigation = [
    [essay, t.essay],
    [paper, t.paper],
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
          <small>{t.runtime}</small>
        </Link>

        <nav className="site-nav" aria-label={t.navigation}>
          {navigation.map(([href, label]) => <Link href={href} key={href}>{label}</Link>)}
          <a href={SITE_LINKS.source}>{t.source}</a>
        </nav>

        <div className="site-header__meta">
          <a className="site-header__live" href={SITE_LINKS.liveAgent}>{t.live}<span aria-hidden="true">↗</span></a>
          <Link className="language-switch" href={otherLanguage}>{t.language}</Link>
          <details className="site-menu">
            <summary>{t.menu}<span aria-hidden="true">+</span></summary>
            <nav className="site-menu__panel" aria-label={t.navigation}>
              {navigation.map(([href, label]) => <Link href={href} key={href}>{label}</Link>)}
              <a href={SITE_LINKS.source}>{t.source}<span aria-hidden="true">↗</span></a>
              <a href={SITE_LINKS.liveAgent}>{t.live}<span aria-hidden="true">↗</span></a>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
