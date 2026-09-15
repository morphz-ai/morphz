import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Artifact } from "../../../packages/core/src/model.js";
import { catalogExcerpt } from "./content-catalog.js";
const PdfPreview = lazy(() => import("./PdfPreview.js"));
export function ContentPreview({ artifact: a }: { artifact: Artifact }) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const c = a.content;
  return (
    <div className="artifact-preview" data-kind={c.kind} ref={root}>
      {c.kind === "image" ? (
        <img
          loading="lazy"
          src={`/api/assets/${c.assetId}`}
          alt={c.alt || a.title}
        />
      ) : c.kind === "pdf" ? (
        <>
          {visible && (
            <Suspense fallback={<span>正在载入预览…</span>}>
              <PdfPreview assetId={c.assetId} />
            </Suspense>
          )}
          <small>{c.pages.length} 页</small>
        </>
      ) : c.kind === "interactive" ? (
        <div className="content-table-preview">
          {c.description && <p>{c.description}</p>}
          <table aria-label={`${a.title}预览`}>
            <thead>
              <tr>
                {c.columns.slice(0, 3).map((col) => (
                  <th key={col.id}>{col.title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.rows.slice(0, 3).map((row) => (
                <tr key={row.id}>
                  {c.columns.slice(0, 3).map((col) => (
                    <td key={col.id}>
                      {typeof row.cells[col.id] === "boolean"
                        ? row.cells[col.id]
                          ? "是"
                          : "否"
                        : String(row.cells[col.id] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <small>
            {c.rows.length} 条记录
            {c.columns.length > 3 ? ` · ${c.columns.length} 个字段` : ""}
          </small>
        </div>
      ) : c.kind === "website" ? (
        <>
          <strong className="content-domain">{new URL(c.url).hostname}</strong>
          <p>{catalogExcerpt(a)}</p>
        </>
      ) : (
        <p>{catalogExcerpt(a) || "空白文档"}</p>
      )}
    </div>
  );
}
