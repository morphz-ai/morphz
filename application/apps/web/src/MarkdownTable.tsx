import type { CSSProperties, ReactNode } from "react";
import type { Element } from "hast";

/** Prose wraps to the reading surface; exceptional wide content still scrolls
 * locally and remains reachable with the keyboard. */
export function MarkdownTable({
  children,
  node,
}: {
  children?: ReactNode;
  node?: Element;
}) {
  // GFM's parsed header owns its column count. Do not rescan or spread every
  // body row on each streamed render of a long table.
  const header = node?.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "thead",
  );
  const row = header?.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "tr",
  );
  const columns =
    row?.children.reduce(
      (count, cell) =>
        count + Number(cell.type === "element" && cell.tagName === "th"),
      0,
    ) ?? 0;
  // Ordinary prose tables fit the reading column. Dense data tables retain a
  // modest minimum per column rather than becoming vertical single-glyph text.
  const style =
    columns > 4
      ? ({ "--markdown-table-min-width": `${columns * 7}em` } as CSSProperties)
      : undefined;
  return (
    <div
      className="markdown-table-scroll"
      role="region"
      aria-label="表格"
      tabIndex={0}
    >
      <table style={style}>{children}</table>
    </div>
  );
}
