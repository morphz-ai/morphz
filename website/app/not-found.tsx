import Link from "next/link";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";

export default function NotFound() {
  return (
    <div className="not-found-shell">
      <SiteHeader locale="zh" />
      <main className="not-found-page">
        <p className="not-found-page__code">404 / UNRESOLVED REFERENCE</p>
        <h1>这个 Context 中没有该页面。</h1>
        <p>The requested reference is not present in this Context.</p>
        <div className="not-found-page__actions">
          <Link className="button" href="/">返回 Morphz</Link>
          <Link className="button button--secondary" href="/en">English home</Link>
        </div>
      </main>
      <SiteFooter locale="zh" />
    </div>
  );
}
