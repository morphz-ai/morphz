import Link from "next/link";
import type { Locale } from "@/lib/docs";

export function SiteFooter({ locale }: { locale: Locale }) {
  const docs = locale === "zh" ? "/docs" : "/en/docs";
  const blog = locale === "zh" ? "/blog" : "/en/blog";
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
        <p>
          {locale === "zh"
            ? "让模型负责认知，让运行时负责事实、权限与执行。"
            : "Let models handle cognition while the runtime owns facts, permissions, and execution."}
        </p>
        <small>{locale === "zh" ? "由新变元创造并维护。" : "Created and maintained by Newvar."}</small>
      </div>
      <div className="site-footer__index">
        <span>INDEX / 2026</span>
        <div className="site-footer__links">
          <Link href={blog}>{locale === "zh" ? "技术文章" : "Technical notes"}</Link>
          <Link href={docs}>{locale === "zh" ? "文档" : "Documentation"}</Link>
          <a href="https://github.com/yaowenai/morphz">GitHub</a>
        </div>
      </div>
    </footer>
  );
}
