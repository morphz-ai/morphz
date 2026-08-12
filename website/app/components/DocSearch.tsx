"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { DocRecord, Locale } from "@/lib/docs";
import { docHref } from "@/lib/docs";

export function DocSearch({ locale, docs }: { locale: Locale; docs: Pick<DocRecord, "slug" | "title" | "description" | "section">[] }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return docs.filter((doc) => `${doc.title} ${doc.description} ${doc.section}`.toLocaleLowerCase().includes(normalized)).slice(0, 8);
  }, [docs, query]);
  const placeholder = locale === "zh" ? "搜索文档…" : "Search documentation…";

  return (
    <div className="doc-search">
      <span className="doc-search__icon" aria-hidden="true">⌕</span>
      <input aria-label={placeholder} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} />
      {query && (
        <div className="doc-search__results" role="listbox">
          {matches.length ? matches.map((doc) => (
            <Link href={docHref(locale, doc.slug)} key={doc.slug} onClick={() => setQuery("")}>
              <strong>{doc.title}</strong><span>{doc.description}</span>
            </Link>
          )) : <p>{locale === "zh" ? "没有匹配的文档" : "No matching documentation"}</p>}
        </div>
      )}
    </div>
  );
}
