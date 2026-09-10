type MarkdownNode = {
  type: string;
  depth?: number;
  value?: string;
  children?: MarkdownNode[];
};

function text(node: MarkdownNode): string {
  return node.value ?? node.children?.map(text).join("") ?? "";
}

/** Display-only deduplication. Never changes the stored Markdown or version. */
export function omitRepeatedDocumentTitle({ title }: { title?: string }) {
  return (tree: MarkdownNode) => {
    const first = tree.children?.[0];
    if (
      title &&
      first?.type === "heading" &&
      first.depth === 1 &&
      text(first).trim() === title.trim()
    )
      tree.children!.shift();
  };
}

/** Small catalog excerpt, never parse an entire book just to draw its card. */
export function documentExcerpt(markdown: string, title: string): string {
  const lines = markdown.slice(0, 1000).trim().split(/\r?\n/);
  const plain = (value: string) =>
    value
      .replace(/^#{1,6}\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
  if (/^#\s+/.test(lines[0] ?? "") && plain(lines[0]!) === title.trim())
    lines.shift();
  return lines.map(plain).join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
}
