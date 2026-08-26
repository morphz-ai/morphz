import Link from "next/link";
import type { Locale } from "@/lib/docs";

export function SiteFooter({ locale }: { locale: Locale }) {
  const docs = locale === "zh" ? "/docs" : "/en/docs";
  const blog = locale === "zh" ? "/blog" : "/en/blog";
  return (
    <footer className="site-footer">
      <div>
        <span className="brand brand--footer">
          <span className="brand__mark" aria-hidden="true" /> Morphz
        </span>
        <p>
          {locale === "zh"
            ? "让模型负责认知，让运行时负责事实、权限与执行。"
            : "Let models handle cognition while the runtime owns facts, permissions, and execution."}
        </p>
      </div>
      <div className="site-footer__links">
        <Link href={blog}>{locale === "zh" ? "技术文章" : "Technical notes"}</Link>
        <Link href={docs}>{locale === "zh" ? "文档" : "Documentation"}</Link>
        <a href="https://github.com/yaowenai/morphz">GitHub</a>
      </div>
    </footer>
  );
}
