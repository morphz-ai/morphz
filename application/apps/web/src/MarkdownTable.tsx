import type { ReactNode } from "react";

/** Keep wide Markdown tables scrollable inside their reading surface. */
export function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div
      className="markdown-table-scroll"
      role="region"
      aria-label="表格"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  );
}
