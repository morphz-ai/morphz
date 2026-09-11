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
  return plainExcerpt(markdown, title).slice(0, 160);
}

function plainExcerpt(markdown: string, title: string): string {
  const lines = markdown.slice(0, 1000).trim().split(/\r?\n/);
  const plain = (value: string) =>
    value
      .replace(/^#{1,6}\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
  if (/^#\s+/.test(lines[0] ?? "") && plain(lines[0]!) === title.trim())
    lines.shift();
  return lines.map(plain).join(" ").replace(/\s+/g, " ").trim();
}

/** Presentation only: start at the matching sentence, never alter the quote. */
export function searchPreview(
  excerpt: string,
  title: string,
  query: string,
  source: { kind: string; page?: number },
): string {
  let text = plainExcerpt(excerpt, title);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const positions = terms
    .map((term) => text.toLocaleLowerCase().indexOf(term))
    .filter((position) => position >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const boundaries = [...text.slice(0, first).matchAll(/[。！？!?]|\.(?=\s)/g)];
  const boundary = boundaries.at(-1);
  if (boundary) text = "…" + text.slice(boundary.index + 1).trimStart();
  // PDF page furniture is already in the heading. Keep it when the user
  // specifically matched it, or when it is not an exact trailing page marker.
  if (source.kind === "pdf" && source.page) {
    const footer = text.match(
      new RegExp(`\\s+Page\\s+${source.page}\\s*/\\s*\\d+\\s*$`, "i"),
    );
    if (
      footer &&
      !terms.some((term) => footer[0].toLocaleLowerCase().includes(term))
    )
      text = text.slice(0, footer.index).trimEnd();
  }
  if (text.length <= 160) return text;
  let end = 159;
  if (/[A-Za-z0-9]/.test(text[end - 1]!) && /[A-Za-z0-9]/.test(text[end]!)) {
    const word = text.slice(0, end).match(/[A-Za-z0-9]+$/);
    if (word && word.index! > 100) end = word.index!;
  }
  // Do not split a UTF-16 surrogate pair at the display boundary.
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end).trimEnd() + "…";
}
